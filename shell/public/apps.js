// The app stage: tabs of sandboxed mini apps. Each app runs in
// <iframe sandbox="allow-scripts" srcdoc=…> (opaque origin) and talks to us only
// through a MessagePort we transfer after load.
const TOOL_TIMEOUT = 5000;
const MAX_RESULT = 64 * 1024;
const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
  "img-src data: blob: https:; media-src data: blob: https:; connect-src https:";

const open = new Map(); // slug -> { frame, tab, port, tools: Map, version, ready, waiting }
let sdkSource = "";
let current = null;
let seq = 0;

const $ = (s) => document.querySelector(s);

async function sdk() {
  if (!sdkSource) sdkSource = await (await fetch("/sdk.js")).text();
  return sdkSource;
}

function inject(html, sdkCode) {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${sdkCode.replace(/<\/script/gi, "<\\/script")}<\/script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<!doctype html>/i.test(html)) return html.replace(/<!doctype html>/i, (m) => m + head);
  return `<!doctype html>${head}${html}`;
}

function show(slug) {
  current = slug;
  for (const [s, a] of open) {
    a.frame.hidden = s !== slug;
    a.tab.setAttribute("aria-selected", String(s === slug));
  }
  document.body.classList.toggle("stage-open", open.size > 0);
  $("#stage").hidden = open.size === 0;
}

export function openApps() {
  return [...open.keys()];
}

export async function openApp(slug, { version, focus = true } = {}) {
  const existing = open.get(slug);
  if (existing && (version == null || existing.version === version)) {
    if (focus) show(slug);
    return existing;
  }
  const res = await fetch(`/api/apps/${slug}`);
  if (!res.ok) throw new Error(`no app "${slug}"`);
  const app = await res.json();
  const srcdoc = inject(app.html, await sdk());

  let entry = existing;
  if (!entry) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("allow", "");
    frame.title = app.title;
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.innerHTML = `<span></span><span class="close" aria-label="Close app">×</span>`;
    tab.addEventListener("click", (e) => (e.target.classList.contains("close") ? closeApp(slug) : show(slug)));
    $("#tabs").append(tab);
    $("#frames").append(frame);
    entry = { frame, tab, slug };
    open.set(slug, entry);
    frame.addEventListener("load", () => connect(entry));
  }
  entry.tab.firstChild.textContent = app.title;
  entry.version = app.version;
  entry.tools = new Map();
  entry.ready = false;
  entry.waiting = new Map();
  entry.readyPromise = new Promise((r) => (entry.markReady = r));
  entry.frame.srcdoc = srcdoc;
  if (focus) show(slug);
  return entry;
}

function connect(entry) {
  const channel = new MessageChannel();
  entry.port = channel.port1;
  entry.port.onmessage = (e) => onAppMessage(entry, e.data);
  entry.frame.contentWindow.postMessage({ type: "llmos_handshake" }, "*", [channel.port2]);
  // apps that never call ready() still count as ready shortly after load
  setTimeout(() => entry.markReady(), 1500);
}

async function onAppMessage(entry, msg) {
  if (!msg || typeof msg !== "object") return;
  const reply = (callId, payload) => entry.port.postMessage({ type: "reply", callId, ...payload });
  switch (msg.type) {
    case "register_tool":
      if (entry.tools.size < 16 && msg.tool?.name) entry.tools.set(msg.tool.name, msg.tool);
      break;
    case "ready":
      entry.ready = true;
      entry.markReady();
      break;
    case "result": {
      const w = entry.waiting.get(msg.callId);
      if (w) { entry.waiting.delete(msg.callId); w(msg); }
      break;
    }
    case "os_call": {
      try {
        const r = await post(`/api/apps/${entry.slug}/call`, { tool: msg.tool, args: msg.args });
        let result = r.content;
        try { result = JSON.parse(r.content); } catch {}
        reply(msg.callId, r.ok ? { result } : { error: String(r.content) });
      } catch (err) {
        reply(msg.callId, { error: err.message });
      }
      break;
    }
    case "storage": {
      try {
        const r = await post(`/api/apps/${entry.slug}/storage`, { op: msg.op, key: String(msg.key), value: msg.value });
        reply(msg.callId, { result: msg.op === "get" ? r.value : true });
      } catch (err) {
        reply(msg.callId, { error: err.message });
      }
      break;
    }
    case "app_error":
      console.warn(`[app ${entry.slug}]`, msg.message);
      break;
  }
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function closeApp(slug) {
  const a = open.get(slug);
  if (!a) return;
  a.frame.remove();
  a.tab.remove();
  open.delete(slug);
  if (current === slug) current = open.keys().next().value ?? null;
  show(current);
}

export async function listTools(slug) {
  const entry = open.get(slug) || (await openApp(slug, { focus: false }));
  await entry.readyPromise;
  return [...entry.tools.values()];
}

export async function callTool(slug, name, args) {
  const entry = open.get(slug) || (await openApp(slug));
  await entry.readyPromise;
  if (!entry.tools.has(name)) throw new Error(`app "${slug}" has no tool "${name}" (has: ${[...entry.tools.keys()].join(", ") || "none"})`);
  const callId = `h${++seq}`;
  const msg = await new Promise((resolve) => {
    const timer = setTimeout(() => { entry.waiting.delete(callId); resolve({ error: `tool timed out after ${TOOL_TIMEOUT}ms` }); }, TOOL_TIMEOUT);
    entry.waiting.set(callId, (m) => { clearTimeout(timer); resolve(m); });
    entry.port.postMessage({ type: "call_tool", callId, name, args });
  });
  if (msg.error) throw new Error(msg.error);
  const size = JSON.stringify(msg.result ?? null).length;
  if (size > MAX_RESULT) throw new Error("tool result over 64 KiB");
  return msg.result;
}

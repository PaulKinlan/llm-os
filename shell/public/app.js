import * as stage from "./apps.js";

const $ = (s) => document.querySelector(s);
const state = { projectId: null, projects: [], apps: [], running: false, live: null };

// ---------- helpers ----------

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Small Markdown subset: code fences, inline code, bold, italics, links, lists, paragraphs.
function md(src) {
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return src.split(/\n{2,}/).map((para) => {
    if (/^\u0000\d+\u0000$/.test(para.trim())) return blocks[Number(para.trim().slice(1, -1))];
    const lines = para.split("\n");
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
      const tag = /^\s*\d+\./.test(lines[0]) ? "ol" : "ul";
      return `<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</${tag}>`;
    }
    return `<p>${inline(para).replace(/\n/g, "<br>")}</p>`.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }).join("");
}

const TOOL_LABELS = {
  create_app: (i) => `Built app “${i.title || i.name}”`,
  edit_app: (i) => `Edited ${i.slug}`,
  open_app: (i) => `Opened ${i.slug}`,
  call_app_tool: (i) => `${i.slug} › ${i.tool}`,
  run_command: (i) => `$ ${i.command}`,
  open_url: (i) => `Opened ${i.url}`,
};
const toolLabel = (name, input = {}) => (TOOL_LABELS[name]?.(input) ?? name.replace(/_/g, " "));

// ---------- rendering ----------

function scrollDown() {
  const m = $("#messages");
  m.scrollTop = m.scrollHeight;
}

function renderSidebar() {
  $("#projects").innerHTML = state.projects.map((p) =>
    `<li><button data-project="${p.id}" aria-current="${p.id === state.projectId}">${esc(p.title)}</button></li>`).join("") ||
    `<li class="muted">No projects yet</li>`;
  $("#apps").innerHTML = state.apps.map((a) =>
    `<li><button data-app="${a.slug}" title="${esc(a.description || "")}">${esc(a.title)}</button></li>`).join("") ||
    `<li class="muted">Apps you ask for appear here</li>`;
}

function assistantEl(content) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  for (const b of content) {
    if (b.type === "text" && b.text) el.insertAdjacentHTML("beforeend", md(b.text));
    if (b.type === "tool_use") el.insertAdjacentHTML("beforeend", `<span class="tool running" data-tool-id="${b.id}">${esc(toolLabel(b.name, b.input))}</span>`);
  }
  return el;
}

function renderMessages(messages) {
  const box = $("#messages");
  box.innerHTML = "";
  if (!messages.length) {
    box.append($("#empty-template").content.cloneNode(true));
    return;
  }
  const results = new Map();
  for (const m of messages) {
    if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, !b.is_error);
  }
  for (const m of messages) {
    if (m.role === "user") {
      const text = (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) box.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(text)}</div>`);
    } else if (m.role === "assistant") {
      box.append(assistantEl(m.content));
    }
  }
  for (const [id, ok] of results) markTool(id, ok);
  scrollDown();
}

function markTool(id, ok) {
  const chip = document.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
  if (chip) chip.className = `tool ${ok ? "ok" : "bad"}`;
}

function setRunning(on) {
  state.running = on;
  $("#send").hidden = on;
  $("#stop").hidden = !on;
}

// ---------- state ----------

async function refresh() {
  const s = await api("GET", "/api/state");
  state.projects = s.projects;
  state.apps = s.apps;
  $("#model").textContent = s.model + (s.dryRun ? " · dry run" : "");
  $("#status").textContent = s.compositor === "none" ? "" : s.compositor;
  renderSidebar();
  if (!s.hasKey) openSettings();
  return s;
}

async function selectProject(id) {
  state.projectId = id;
  try { localStorage.setItem("llmos.project", id); } catch {}
  state.live = null;
  const p = await api("GET", `/api/projects/${id}`);
  $("#conv-title").textContent = p.title;
  renderMessages(p.messages);
  setRunning(p.running);
  renderSidebar();
}

async function send(text) {
  if (!text.trim() || state.running) return;
  if (!state.projectId) {
    const p = await api("POST", "/api/projects", {});
    state.projectId = p.id;
    await refresh();
    await selectProject(p.id);
  }
  $("#messages .empty")?.remove();
  $("#messages").insertAdjacentHTML("beforeend", `<div class="msg user">${esc(text)}</div>`);
  scrollDown();
  setRunning(true);
  try {
    await api("POST", `/api/projects/${state.projectId}/messages`, { text });
  } catch (err) {
    setRunning(false);
    notice(err.message, true);
  }
}

function notice(text, bad) {
  $("#messages").insertAdjacentHTML("beforeend", `<div class="notice ${bad ? "bad" : ""}">${esc(text)}</div>`);
  scrollDown();
}

// ---------- events from the daemon ----------

const handlers = {
  turn_start(e) { if (e.projectId === state.projectId) { $("#conv-title").textContent = e.title; setRunning(true); } refresh(); },
  assistant_start(e) {
    if (e.projectId !== state.projectId) return;
    const el = document.createElement("div");
    el.className = "msg assistant";
    $("#messages").append(el);
    state.live = { el, text: "" };
  },
  text(e) {
    if (e.projectId !== state.projectId || !state.live) return;
    state.live.text += e.delta;
    state.live.el.innerHTML = md(state.live.text);
    scrollDown();
  },
  assistant_message(e) {
    if (e.projectId !== state.projectId) return;
    const el = assistantEl(e.content);
    if (state.live) state.live.el.replaceWith(el); else $("#messages").append(el);
    state.live = null;
    scrollDown();
  },
  tool_end(e) { markTool(e.id, e.ok); },
  notice(e) { if (e.projectId === state.projectId) notice(e.text); },
  turn_end(e) { if (e.projectId === state.projectId) { setRunning(false); if (e.stopped) notice("Stopped."); } },
  turn_error(e) { if (e.projectId === state.projectId) { setRunning(false); state.live?.el.remove(); state.live = null; notice(e.error, true); } },
  apps_changed() { refresh(); },
  app_open(e) { stage.openApp(e.slug, { version: e.version }).catch((err) => notice(err.message, true)); },
  app_close(e) { stage.closeApp(e.slug); },

  // RPCs: answer with POST /api/rpc
  async confirm(e) { rpcReply(e.rpcId, () => askConfirm(e)); },
  async ui_query(e) { rpcReply(e.rpcId, async () => (e.what === "open_apps" ? stage.openApps() : null)); },
  async app_list_tools(e) { rpcReply(e.rpcId, () => stage.listTools(e.slug)); },
  async app_call_tool(e) { rpcReply(e.rpcId, () => stage.callTool(e.slug, e.tool, e.args)); },
};

async function rpcReply(id, fn) {
  let payload;
  try {
    payload = { id, result: await fn() };
  } catch (err) {
    payload = { id, error: err.message || String(err) };
  }
  await api("POST", "/api/rpc", payload).catch(() => {});
}

const confirmQueue = [];
function askConfirm(e) {
  return new Promise((resolve) => {
    confirmQueue.push({ e, resolve });
    if (confirmQueue.length === 1) showNextConfirm();
  });
}
function showNextConfirm() {
  const next = confirmQueue[0];
  if (!next) return;
  const d = $("#confirm");
  $("#confirm-caller").textContent = next.e.caller === "model" ? "The assistant wants to:" : `The app “${next.e.caller.replace(/^app:/, "")}” wants to:`;
  $("#confirm-summary").textContent = next.e.summary;
  $("#confirm-input").textContent = JSON.stringify(next.e.input, null, 2);
  d.returnValue = "deny";
  d.showModal();
}
$("#confirm").addEventListener("close", () => {
  const next = confirmQueue.shift();
  next?.resolve($("#confirm").returnValue === "allow");
  showNextConfirm();
});

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    handlers[e.type]?.(e);
  };
  es.onopen = () => refresh().then(() => {
    if (!state.projectId) {
      try { state.projectId = localStorage.getItem("llmos.project"); } catch {}
    }
    if (state.projectId && state.projects.some((p) => p.id === state.projectId)) return selectProject(state.projectId);
    state.projectId = null;
  });
}

// ---------- settings ----------

function openSettings() {
  const d = $("#settings");
  if (!d.open) d.showModal();
  $("#key").focus();
}
$("#settings-button").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", () => $("#settings").close());
$("#key-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#key-error");
  err.hidden = true;
  try {
    await api("PUT", "/api/key", { key: $("#key").value });
    $("#key").value = "";
    $("#settings").close();
    refresh();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

// ---------- input ----------

$("#composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("#input").value;
  $("#input").value = "";
  send(text);
});
$("#input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#stop").addEventListener("click", () => state.projectId && api("POST", `/api/projects/${state.projectId}/stop`));
$("#new-project").addEventListener("click", async () => {
  const p = await api("POST", "/api/projects", {});
  await refresh();
  await selectProject(p.id);
  $("#input").focus();
});
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.dataset.project) selectProject(b.dataset.project);
  if (b.dataset.app) stage.openApp(b.dataset.app).catch((err) => notice(err.message, true));
  if (b.dataset.suggest) send(b.dataset.suggest);
});

// keep the empty state as a template so new projects can show it again
const tpl = document.createElement("template");
tpl.id = "empty-template";
tpl.content.append($("#messages .empty").cloneNode(true));
document.body.append(tpl);

connectEvents();
$("#input").focus();

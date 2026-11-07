// A scripted stand-in for the model. It recognises a few phrases and makes the
// same tool calls a real model would, so the whole loop (tools, confirmations,
// mini apps) can be exercised without an API key.
let n = 0;
const id = () => `toolu_fake_${++n}`;

export const DEMO_APP = `<!doctype html>
<html><head><meta charset="utf-8"><title>Clock</title>
<style>
  :root { color-scheme: light dark; --accent: #d97757; }
  html,body { height:100%; margin:0; font-family: system-ui, sans-serif; }
  body { display:grid; place-items:center; background: Canvas; color: CanvasText; }
  #t { font-size: 18vmin; font-variant-numeric: tabular-nums; color: var(--accent); }
  #d { opacity: .7; text-align:center; }
</style></head>
<body><div><div id="t"></div><div id="d"></div></div>
<script>
  const tick = () => { const now = new Date(); t.textContent = now.toLocaleTimeString(); d.textContent = now.toDateString(); };
  tick(); setInterval(tick, 1000);
  window.webMcp.registerTool({
    name: "set_color",
    description: "Change the clock colour",
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
    execute: async ({ color }) => { document.documentElement.style.setProperty("--accent", color); return { ok: true, color }; },
  });
  window.webMcp.ready();
</script></body></html>`;

function lastUser(messages) {
  return messages[messages.length - 1];
}

function textOf(msg) {
  if (typeof msg.content === "string") return msg.content;
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
}

async function say(text, onText, signal) {
  for (const chunk of text.match(/.{1,12}/gs) || []) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    onText(chunk);
    await new Promise((r) => setTimeout(r, 15));
  }
  return { type: "text", text };
}

function toolUse(name, input) {
  return { type: "tool_use", id: id(), name, input };
}

export async function fakeTurn({ messages, onText, signal }) {
  const last = lastUser(messages);
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];

  if (results.length) {
    // find what we called, to decide whether to chain another call
    const prev = messages[messages.length - 2];
    const call = prev.content.find((b) => b.type === "tool_use");
    if (call?.name === "create_app" && !results[0].is_error) {
      const t = await say("I built a clock app. Let me make it green to show I can drive it. ", onText, signal);
      return { role: "assistant", content: [t, toolUse("call_app_tool", { slug: "clock", tool: "set_color", args: { color: "#2e9e5b" } })], stop_reason: "tool_use" };
    }
    const r = results[0];
    const body = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    const t = await say(r.is_error ? `That didn't work: ${body.slice(0, 300)}` : `Done. Result:\n\n\`\`\`\n${body.slice(0, 600)}\n\`\`\``, onText, signal);
    return { role: "assistant", content: [t], stop_reason: "end_turn" };
  }

  const text = textOf(last).toLowerCase();
  if (/\b(app|clock)\b/.test(text)) {
    const t = await say("Sure, building it now. ", onText, signal);
    return { role: "assistant", content: [t, toolUse("create_app", { name: "clock", title: "Clock", description: "A big clock", permissions: [], html: DEMO_APP })], stop_reason: "tool_use" };
  }
  if (/wi-?fi/.test(text)) {
    const t = await say("Scanning for networks. ", onText, signal);
    return { role: "assistant", content: [t, toolUse("wifi_scan", {})], stop_reason: "tool_use" };
  }
  if (/\b(run|command|uname)\b/.test(text)) {
    const t = await say("I'll check the kernel version. ", onText, signal);
    return { role: "assistant", content: [t, toolUse("run_command", { command: "uname -a", reason: "Show the kernel version" })], stop_reason: "tool_use" };
  }
  if (/\b(system|info|machine)\b/.test(text)) {
    const t = await say("Looking at the machine. ", onText, signal);
    return { role: "assistant", content: [t, toolUse("system_info", {})], stop_reason: "tool_use" };
  }
  const t = await say(`(offline demo model) You said: "${textOf(last)}". Try "make a clock app", "scan wifi", "run uname" or "system info".`, onText, signal);
  return { role: "assistant", content: [t], stop_reason: "end_turn" };
}

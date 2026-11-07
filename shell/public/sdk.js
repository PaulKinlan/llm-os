// Injected into every mini app before its own code. Talks to the shell over a
// MessagePort handed over by the parent frame; nothing else is trusted.
(() => {
  let port = null;
  const outbox = [];
  const tools = new Map();
  const waiting = new Map();
  let seq = 0;

  function post(msg) {
    if (port) port.postMessage(msg);
    else outbox.push(msg);
  }

  function rpc(type, payload) {
    const callId = `c${++seq}`;
    return new Promise((resolve, reject) => {
      waiting.set(callId, { resolve, reject });
      post({ type, callId, ...payload });
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type !== "llmos_handshake" || !event.ports?.[0]) return;
    port = event.ports[0];
    port.onmessage = onPortMessage;
    for (const m of outbox.splice(0)) port.postMessage(m);
  });

  async function onPortMessage({ data }) {
    if (data.type === "call_tool") {
      const tool = tools.get(data.name);
      try {
        if (!tool) throw new Error(`no tool "${data.name}"`);
        const result = await tool.execute(data.args || {});
        port.postMessage({ type: "result", callId: data.callId, result: result ?? null });
      } catch (err) {
        port.postMessage({ type: "result", callId: data.callId, error: String(err?.message || err) });
      }
    } else if (data.type === "reply") {
      const w = waiting.get(data.callId);
      if (!w) return;
      waiting.delete(data.callId);
      data.error ? w.reject(new Error(data.error)) : w.resolve(data.result);
    }
  }

  window.webMcp = {
    registerTool({ name, description = "", parameters = { type: "object", properties: {} }, execute }) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("invalid tool name");
      if (typeof execute !== "function") throw new Error("execute must be a function");
      tools.set(name, { execute });
      post({ type: "register_tool", tool: { name, description: String(description).slice(0, 1024), parameters } });
    },
    ready() {
      post({ type: "ready" });
    },
  };

  window.os = {
    call: (tool, args = {}) => rpc("os_call", { tool, args }),
    storage: {
      get: (key) => rpc("storage", { op: "get", key }),
      set: (key, value) => rpc("storage", { op: "set", key, value }),
    },
  };

  // Apps cannot use the real localStorage (opaque origin); give them an in-memory one so they don't crash.
  try { void window.localStorage; } catch {
    const mem = new Map();
    Object.defineProperty(window, "localStorage", { value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k), clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    } });
  }

  window.addEventListener("error", (e) => post({ type: "app_error", message: String(e.message) }));
})();

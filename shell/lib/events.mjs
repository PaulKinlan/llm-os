// The channel between the daemon and the shell UI: server-sent events out,
// JSON POSTs back. Requests that need the UI (a confirmation click, a call into a
// mini app running in an iframe) are RPCs: we broadcast a request with an id and
// wait for the UI to POST /api/rpc with the answer.
import { randomUUID } from "node:crypto";

const clients = new Set();
const pending = new Map();

export function addClient(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": hello\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    // nobody is left to answer: fail pending requests closed (a reload re-asks nothing)
    if (clients.size === 0) {
      for (const [id, p] of pending) {
        pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error("the shell UI disconnected"));
      }
    }
  });
}

export function clientCount() {
  return clients.size;
}

export function emit(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) res.write(payload);
}

export function request(type, data, { timeoutMs = 10000, signal } = {}) {
  if (clients.size === 0) return Promise.reject(new Error("the shell UI is not connected"));
  if (signal?.aborted) return Promise.reject(new Error("cancelled"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const done = () => {
      pending.delete(id);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      done();
      emit("rpc_cancel", { rpcId: id });
      reject(new Error("cancelled"));
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      done();
      emit("rpc_cancel", { rpcId: id });
      reject(new Error(`${type} timed out after ${timeoutMs}ms`));
    }, timeoutMs) : null;
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, { resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); }, timer });
    emit(type, { rpcId: id, ...data });
  });
}

export function answer(id, { result, error }) {
  const p = pending.get(id);
  if (!p) return false;
  if (error) p.reject(new Error(String(error)));
  else p.resolve(result);
  return true;
}

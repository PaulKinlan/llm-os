#!/usr/bin/env node
// llmos shell daemon: serves the shell UI and runs the agent loop.
// Binds to 127.0.0.1 only. Requests must carry a matching Host header (blocks DNS
// rebinding) and, for writes, a same-origin Origin header when one is present.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.mjs";
import * as store from "./lib/store.mjs";
import * as events from "./lib/events.mjs";
import * as agent from "./lib/agent.mjs";
import { callTool, getTool } from "./lib/tools/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function allowed(req) {
  const okHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  if (!okHosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && !okHosts.map((h) => `http://${h}`).includes(origin)) return false;
  return true;
}

async function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 404, "not found");
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    send(res, 404, "not found");
  }
}

const appStorage = new Map(); // slug -> object, persisted under apps/<slug>/storage.json
async function storageFile(slug) {
  return path.join(config.dataDir, "apps", slug, "storage.json");
}

const routes = [
  ["GET", /^\/api\/state$/, async () => ({
    hasKey: Boolean(await store.getApiKey()) || config.fakeLlm,
    model: config.fakeLlm ? "offline demo model" : config.model,
    dryRun: config.dryRun,
    compositor: process.env.HYPRLAND_INSTANCE_SIGNATURE ? "hyprland" : process.env.LLMOS_COMPOSITOR || "none",
    projects: await store.listProjects(),
    apps: (await store.listApps()).map(({ slug, title, description, version }) => ({ slug, title, description, version })),
  })],
  ["PUT", /^\/api\/key$/, async (req) => {
    const { key } = await readBody(req);
    if (typeof key !== "string" || !/^sk-ant-[\w-]{20,}$/.test(key.trim())) throw Object.assign(new Error("that does not look like an Anthropic API key"), { status: 400 });
    await store.setApiKey(key.trim());
    return { ok: true };
  }],
  ["GET", /^\/api\/events$/, (req, res) => {
    events.addClient(res);
    return undefined; // keep open
  }],
  ["POST", /^\/api\/rpc$/, async (req) => {
    const { id, result, error } = await readBody(req);
    return { ok: events.answer(id, { result, error }) };
  }],
  ["POST", /^\/api\/projects$/, async (req) => {
    const { title } = await readBody(req);
    return store.createProject(title || "New project");
  }],
  ["GET", /^\/api\/projects\/([a-z0-9-]+)$/, async (req, res, [id]) => {
    const p = await store.getProject(id);
    if (!p) throw Object.assign(new Error("no such project"), { status: 404 });
    return { ...p, running: agent.isRunning(id) };
  }],
  ["DELETE", /^\/api\/projects\/([a-z0-9-]+)$/, async (req, res, [id]) => {
    agent.stop(id);
    return { ok: await store.deleteProject(id) };
  }],
  ["POST", /^\/api\/projects\/([a-z0-9-]+)\/messages$/, async (req, res, [id]) => {
    const { text } = await readBody(req);
    if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    if (agent.isRunning(id)) throw Object.assign(new Error("busy"), { status: 409 });
    agent.runTurn(id, text.trim()).catch((err) => console.error(err));
    return { ok: true };
  }],
  ["POST", /^\/api\/projects\/([a-z0-9-]+)\/stop$/, async (req, res, [id]) => {
    agent.stop(id);
    return { ok: true };
  }],
  ["GET", /^\/api\/apps\/([a-z0-9-]+)$/, async (req, res, [slug]) => {
    const app = await store.getApp(slug);
    if (!app) throw Object.assign(new Error("no such app"), { status: 404 });
    return app;
  }],
  // a mini app calling a system tool through os.call()
  ["POST", /^\/api\/apps\/([a-z0-9-]+)\/call$/, async (req, res, [slug]) => {
    const app = await store.getApp(slug);
    if (!app) throw Object.assign(new Error("no such app"), { status: 404 });
    const { tool, args } = await readBody(req);
    const t = getTool(tool);
    // apps may only call system/window tools they were granted, never app-management tools
    const grantable = (app.permissions || []).filter((n) => getTool(n) && !/_app/.test(n));
    if (!t) return { ok: false, content: `unknown tool "${tool}"` };
    return callTool(tool, args || {}, { caller: `app:${slug}`, allowed: grantable });
  }],
  ["POST", /^\/api\/apps\/([a-z0-9-]+)\/storage$/, async (req, res, [slug]) => {
    const { op, key, value } = await readBody(req, 256 * 1024);
    const file = await storageFile(slug);
    let data = appStorage.get(slug);
    if (!data) {
      try { data = JSON.parse(await fs.readFile(file, "utf8")); } catch { data = {}; }
      appStorage.set(slug, data);
    }
    if (op === "get") return { value: data[key] ?? null };
    if (op === "set") {
      data[key] = value;
      if (JSON.stringify(data).length > 1024 * 1024) throw Object.assign(new Error("app storage is limited to 1 MiB"), { status: 413 });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data));
      return { ok: true };
    }
    throw Object.assign(new Error("op must be get or set"), { status: 400 });
  }],
];

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, "forbidden");
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) {
        const out = await handler(req, res, m.slice(1));
        if (out !== undefined) send(res, 200, out);
        return;
      }
    }
    if (req.method !== "GET") return send(res, 404, { error: "not found" });
    return serveStatic(res, url.pathname === "/" ? "index.html" : url.pathname);
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`llmos shell listening on http://${config.host}:${config.port} (data: ${config.dataDir}${config.fakeLlm ? ", fake model" : ""}${config.dryRun ? ", dry run" : ""})`);
});

export { server };

// On-disk state: projects (conversations), apps, credentials.
// Layout under config.dataDir:
//   projects/<id>.json           { id, title, createdAt, updatedAt, messages }
//   apps/<slug>/index.html       the app document
//   apps/<slug>/meta.json        { slug, title, description, permissions, ... }
//   credentials.json (0600)      { anthropicApiKey }
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { config } from "./config.mjs";

const dir = (...p) => path.join(config.dataDir, ...p);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  await fs.rename(tmp, file);
}

// Serialise read-modify-write sequences per key (an app slug, a project id).
const locks = new Map();
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

// ---------- credentials ----------

export async function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const creds = await readJson(dir("credentials.json"), {});
  return creds.anthropicApiKey || null;
}

export function setApiKey(key) {
  return withLock("credentials", async () => {
    const creds = await readJson(dir("credentials.json"), {});
    creds.anthropicApiKey = key;
    await writeJson(dir("credentials.json"), creds, 0o600);
  });
}

// ---------- projects ----------

const ID_RE = /^[a-z0-9-]{1,64}$/;

export async function listProjects() {
  let files = [];
  try {
    files = await fs.readdir(dir("projects"));
  } catch {}
  const out = [];
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const p = await readJson(dir("projects", f), null);
    if (p) out.push({ id: p.id, title: p.title, updatedAt: p.updatedAt });
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function getProject(id) {
  if (!ID_RE.test(id)) return null;
  return readJson(dir("projects", `${id}.json`), null);
}

export async function createProject(title = "New project") {
  const now = new Date().toISOString();
  const p = { id: randomUUID().slice(0, 8), title, createdAt: now, updatedAt: now, messages: [] };
  await saveProject(p);
  return p;
}

// Ids of projects deleted while a turn may still be running; their saves are dropped.
const deletedProjects = new Set();

export async function saveProject(p) {
  if (deletedProjects.has(p.id)) return;
  p.updatedAt = new Date().toISOString();
  await writeJson(dir("projects", `${p.id}.json`), p);
}

export async function deleteProject(id) {
  if (!ID_RE.test(id)) return false;
  deletedProjects.add(id);
  await fs.rm(dir("projects", `${id}.json`), { force: true });
  return true;
}

// ---------- apps ----------

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app";
}

const SLUG_RE = /^[a-z0-9-]{1,48}$/;

export async function listApps() {
  let names = [];
  try {
    names = await fs.readdir(dir("apps"));
  } catch {}
  const out = [];
  for (const n of names) {
    const meta = await readJson(dir("apps", n, "meta.json"), null);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function getApp(slug) {
  if (!SLUG_RE.test(slug)) return null;
  const meta = await readJson(dir("apps", slug, "meta.json"), null);
  if (!meta) return null;
  let html = "";
  try {
    html = await fs.readFile(dir("apps", slug, "index.html"), "utf8");
  } catch {}
  return { ...meta, html };
}

// Callers that read then write an app (edit_app) must hold withLock(`app:${slug}`) across both.
export function saveApp(fields) {
  return withLock(`app:${fields.slug}`, () => saveAppUnlocked(fields));
}

export async function saveAppUnlocked({ slug, title, description, permissions, html, projectId }) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid app slug "${slug}"`);
  const existing = await readJson(dir("apps", slug, "meta.json"), null);
  const now = new Date().toISOString();
  const meta = {
    slug,
    title: title || existing?.title || slug,
    description: description || existing?.description || "",
    permissions: permissions ?? existing?.permissions ?? [],
    projectId: existing?.projectId || projectId || null,
    version: (existing?.version || 0) + 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await fs.mkdir(dir("apps", slug), { recursive: true });
  // keep the previous version next to the new one, so a bad edit can be rolled back
  if (existing) {
    try {
      await fs.copyFile(dir("apps", slug, "index.html"), dir("apps", slug, `v${existing.version}.html`));
    } catch {}
  }
  await fs.writeFile(dir("apps", slug, "index.html"), html);
  await writeJson(dir("apps", slug, "meta.json"), meta);
  return meta;
}

export async function deleteApp(slug) {
  if (!SLUG_RE.test(slug)) return false;
  await withLock(`app:${slug}`, () => fs.rm(dir("apps", slug), { recursive: true, force: true }));
  return true;
}

// ---------- per-app key/value storage (os.storage in mini apps) ----------

const APP_STORAGE_LIMIT = 1024 * 1024;

export async function appStorageGet(slug, key) {
  if (!SLUG_RE.test(slug)) throw new Error("invalid app");
  const data = await readJson(dir("apps", slug, "storage.json"), {});
  return Object.hasOwn(data, key) ? data[key] : null;
}

export function appStorageSet(slug, key, value) {
  if (!SLUG_RE.test(slug)) throw new Error("invalid app");
  return withLock(`app:${slug}`, async () => {
    if (!(await readJson(dir("apps", slug, "meta.json"), null))) throw new Error("no such app");
    const data = await readJson(dir("apps", slug, "storage.json"), {});
    const next = { ...data, [key]: value };
    if (JSON.stringify(next).length > APP_STORAGE_LIMIT) {
      throw Object.assign(new Error("app storage is limited to 1 MiB"), { status: 413 });
    }
    await writeJson(dir("apps", slug, "storage.json"), next);
  });
}

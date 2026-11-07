import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.LLMOS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "llmos-test-"));
process.env.LLMOS_FAKE_LLM = "1";
process.env.LLMOS_DRY_RUN = "1";

const { validateInput } = await import("../lib/validate.mjs");
const store = await import("../lib/store.mjs");
const { callTool, apiTools, tools } = await import("../lib/tools/index.mjs");
const agent = await import("../lib/agent.mjs");

test("tool definitions are well formed and uniquely named", () => {
  const names = new Set();
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]{1,64}$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(["read", "change", "confirm"].includes(t.tier), `${t.name} tier`);
    assert.equal(t.input_schema.type, "object");
  }
  assert.equal(apiTools().length, tools.length);
});

test("validateInput catches missing and mistyped fields", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, n: { type: "number", enum: [1, 2] } }, required: ["a"], additionalProperties: false };
  assert.equal(validateInput(schema, { a: "x" }), null);
  assert.match(validateInput(schema, {}), /missing/);
  assert.match(validateInput(schema, { a: 1 }), /must be string/);
  assert.match(validateInput(schema, { a: "x", n: 3 }), /one of/);
  assert.match(validateInput(schema, { a: "x", z: 1 }), /unknown/);
});

test("apps save versions and keep the previous copy", async () => {
  await store.saveApp({ slug: "demo", title: "Demo", html: "<p>1</p>" });
  const meta = await store.saveApp({ slug: "demo", html: "<p>2</p>" });
  assert.equal(meta.version, 2);
  assert.equal(meta.title, "Demo");
  const app = await store.getApp("demo");
  assert.equal(app.html, "<p>2</p>");
  const old = await fs.readFile(path.join(process.env.LLMOS_DATA_DIR, "apps/demo/v1.html"), "utf8");
  assert.equal(old, "<p>1</p>");
  assert.equal(await store.getApp("../etc"), null);
});

test("edit_app replaces exactly one occurrence", async () => {
  await store.saveApp({ slug: "ed", title: "Ed", html: "<b>hi</b><b>hi</b>" });
  const dup = await callTool("edit_app", { slug: "ed", old_str: "hi", new_str: "yo" }, { caller: "model" });
  assert.equal(dup.ok, false);
  const ok = await callTool("edit_app", { slug: "ed", old_str: "<b>hi</b><b>", new_str: "<i>$&</i><b>" }, { caller: "model" });
  assert.equal(ok.ok, true);
  assert.equal((await store.getApp("ed")).html, "<i>$&</i><b>hi</b>");
});

test("confirm-tier tools fail closed when no UI can approve them", async () => {
  const r = await callTool("run_command", { command: "echo hi", reason: "test" }, { caller: "model" });
  assert.equal(r.ok, false);
  assert.match(r.content, /approval/);
});

test("apps can only call tools they were granted", async () => {
  const r = await callTool("set_volume", { percent: 10 }, { caller: "app:x", allowed: ["wifi_scan"] });
  assert.equal(r.ok, false);
  assert.match(r.content, /not permitted/);
  const ok = await callTool("set_volume", { percent: 10 }, { caller: "app:x", allowed: ["set_volume"] });
  assert.equal(ok.ok, true);
  assert.match(ok.content, /wpctl set-volume/);
});

test("a turn with the fake model runs a tool and stores append-only history", async () => {
  const p = await store.createProject();
  await agent.runTurn(p.id, "show me system info");
  const saved = await store.getProject(p.id);
  assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(saved.messages[1].content.find((b) => b.type === "tool_use").name, "system_info");
  assert.equal(saved.messages[2].content[0].type, "tool_result");
  assert.equal(saved.title, "show me system info");
});

test("validateInput enforces numeric bounds", () => {
  const schema = { type: "object", properties: { percent: { type: "number", minimum: 1, maximum: 100 } }, required: ["percent"] };
  assert.match(validateInput(schema, { percent: 0 }), /at least 1/);
  assert.match(validateInput(schema, { percent: 101 }), /at most 100/);
  assert.equal(validateInput(schema, { percent: 50 }), null);
});

test("open_url quotes the URL as one literal shell word", async () => {
  const { shellQuote } = await import("../lib/tools/windows.mjs");
  const { execFileSync } = await import("node:child_process");
  const nasty = "https://x.test/a'$(touch /tmp/pwned)`id`";
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote(nasty)}`]).toString(), nasty);
});

test("two concurrent turns on one project: the second is refused", async () => {
  const p = await store.createProject();
  const a = agent.runTurn(p.id, "hello");
  await assert.rejects(agent.runTurn(p.id, "again"), /already running/);
  await a;
  const saved = await store.getProject(p.id);
  assert.equal(saved.messages.filter((m) => m.role === "user").length, 1);
});

test("a deleted project is not recreated by a turn still in flight", async () => {
  const p = await store.createProject();
  const turn = agent.runTurn(p.id, "show me system info");
  await store.deleteProject(p.id);
  await turn;
  assert.equal(await store.getProject(p.id), null);
});

test("app storage: concurrent sets keep both keys, size limit leaves data unchanged", async () => {
  await store.saveApp({ slug: "kv", title: "KV", html: "" });
  await Promise.all([store.appStorageSet("kv", "a", 1), store.appStorageSet("kv", "b", 2)]);
  assert.equal(await store.appStorageGet("kv", "a"), 1);
  assert.equal(await store.appStorageGet("kv", "b"), 2);
  await assert.rejects(store.appStorageSet("kv", "big", "x".repeat(1024 * 1024 + 1)), /1 MiB/);
  assert.equal(await store.appStorageGet("kv", "big"), null);
  await store.deleteApp("kv");
  await store.saveApp({ slug: "kv", title: "KV again", html: "" });
  assert.equal(await store.appStorageGet("kv", "a"), null);
});

test("concurrent edit_app calls on one app both apply", async () => {
  await store.saveApp({ slug: "race", title: "Race", html: "<a>1</a><b>2</b>" });
  const [r1, r2] = await Promise.all([
    callTool("edit_app", { slug: "race", old_str: "<a>1</a>", new_str: "<a>one</a>" }, { caller: "model" }),
    callTool("edit_app", { slug: "race", old_str: "<b>2</b>", new_str: "<b>two</b>" }, { caller: "model" }),
  ]);
  assert.ok(r1.ok && r2.ok);
  const app = await store.getApp("race");
  assert.equal(app.html, "<a>one</a><b>two</b>");
  assert.equal(app.version, 3);
});

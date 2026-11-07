// Tool registry and the single place where tool calls are authorised, confirmed,
// executed and audited – for calls from the model and from mini apps alike.
import { systemTools } from "./system.mjs";
import { windowTools } from "./windows.mjs";
import { appTools } from "./apps.mjs";
import { validateInput } from "../validate.mjs";
import { request, emit } from "../events.mjs";
import { audit } from "../audit.mjs";

export const tools = [...systemTools, ...windowTools, ...appTools];
const byName = new Map(tools.map((t) => [t.name, t]));

export function getTool(name) {
  return byName.get(name);
}

// Tool definitions for the Messages API. Order is fixed so the prompt cache holds.
export function apiTools() {
  return tools.map((t) => ({
    name: t.name,
    description: `${t.description}${t.tier === "confirm" ? " (The user is asked to approve this call.)" : ""}`,
    input_schema: t.input_schema,
    ...(t.eager ? { eager_input_streaming: true } : {}),
  }));
}

const MAX_RESULT = 64 * 1024;

function serialize(result) {
  const s = typeof result === "string" ? result : JSON.stringify(result, null, 1);
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + "\n…[truncated]" : s;
}

/**
 * Execute a tool call.
 * @param {string} name
 * @param {object} input
 * @param {{caller: string, projectId?: string, allowed?: string[], signal?: AbortSignal}} ctx
 * @returns {Promise<{ok: boolean, content: string}>}
 */
export async function callTool(name, input, ctx) {
  const tool = byName.get(name);
  if (!tool) return { ok: false, content: `unknown tool "${name}"` };
  if (ctx.allowed && !ctx.allowed.includes(name)) {
    await audit({ caller: ctx.caller, tool: name, input: redact(name, input), outcome: "not-permitted" });
    return { ok: false, content: `this app is not permitted to call "${name}"` };
  }
  const problem = validateInput(tool.input_schema, input);
  if (problem) return { ok: false, content: `invalid input: ${problem}` };

  if (tool.tier === "confirm") {
    let approved = false;
    try {
      approved = await request(
        "confirm",
        { tool: name, caller: ctx.caller, summary: tool.summarize ? tool.summarize(input) : name, input: redact(name, input), projectId: ctx.projectId },
        { timeoutMs: 0, signal: ctx.signal },
      );
    } catch (err) {
      if (ctx.signal?.aborted) return { ok: false, content: "Cancelled: the user stopped this turn." };
      return { ok: false, content: `could not ask the user for approval: ${err.message}` };
    }
    if (!approved) {
      await audit({ caller: ctx.caller, tool: name, input: redact(name, input), outcome: "denied" });
      return { ok: false, content: "The user declined this action." };
    }
  }

  if (ctx.signal?.aborted) return { ok: false, content: "Cancelled: the user stopped this turn." };
  const started = Date.now();
  try {
    const result = await tool.run(input, ctx);
    const content = serialize(result ?? "ok");
    const ok = !(result && typeof result === "object" && !Array.isArray(result) && "error" in result);
    await audit({ caller: ctx.caller, tool: name, input: redact(name, input), outcome: ok ? "ok" : "error", ms: Date.now() - started });
    return { ok, content };
  } catch (err) {
    await audit({ caller: ctx.caller, tool: name, input: redact(name, input), outcome: "error", error: err.message });
    return { ok: false, content: `error: ${err.message}` };
  }
}

function redact(name, input) {
  if (name === "wifi_connect" && input.password) return { ...input, password: "••••" };
  if ((name === "create_app") && input.html) return { ...input, html: `[${input.html.length} chars]` };
  return input;
}

export { emit };

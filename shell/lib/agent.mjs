// The agent loop: one user message in, any number of model requests and tool
// calls, streamed to the UI as events. History is append-only (thinking blocks
// and fallback blocks are kept exactly as the API returned them).
import { streamTurn, isApiError } from "./llm.mjs";
import { apiTools, callTool } from "./tools/index.mjs";
import { APP_GUIDE } from "./tools/apps.mjs";
import { emit } from "./events.mjs";
import * as store from "./store.mjs";
import { config } from "./config.mjs";

export const SYSTEM_PROMPT = `You are the operating system's interface. This computer boots straight into you:
there is no desktop, launcher or app store. The person talks to you, and you act on the machine for them.

How to work:
- Act, then report briefly. Use tools rather than describing what the person could do themselves.
- Settings and hardware (Wi-Fi, audio, brightness, power, services) are tools. Use them directly.
- When the person wants something to look at or use repeatedly (a timer, a dashboard, a settings panel,
  a game, a notes pad), build a mini app with create_app. Give hardware panels the system tool names
  they need in "permissions". Edit existing apps with edit_app instead of rewriting them.
- Before building an app, check list_apps; reuse or improve an existing one when it fits.
- open_url opens real Chrome windows for websites.
- Tools marked as needing approval show the person an Allow/Deny prompt. If they deny, accept it and offer an alternative.
- The machine is Arch Linux (pacman). The user "os" has passwordless sudo; use it only when needed.
- Replies are shown in a chat pane: short paragraphs, Markdown allowed, no headings for short answers.

Mini app guide:
${APP_GUIDE}`;

const running = new Map(); // projectId -> AbortController

export function isRunning(projectId) {
  return running.has(projectId);
}

export function stop(projectId) {
  running.get(projectId)?.abort();
}

export async function runTurn(projectId, userText) {
  if (running.has(projectId)) throw new Error("a turn is already running in this project");
  // reserve the slot before any await so concurrent requests cannot both start a turn
  const ac = new AbortController();
  running.set(projectId, ac);

  try {
    const project = await store.getProject(projectId);
    if (!project) throw new Error("no such project");
    project.messages.push({ role: "user", content: [{ type: "text", text: userText }] });
    if (project.title === "New project") project.title = userText.slice(0, 48);
    await store.saveProject(project);
    emit("turn_start", { projectId, title: project.title });

    for (let i = 0; i < config.maxToolLoops; i++) {
      let message;
      emit("assistant_start", { projectId });
      try {
        message = await streamTurn({
          system: SYSTEM_PROMPT,
          messages: project.messages,
          tools: apiTools(),
          onText: (delta) => emit("text", { projectId, delta }),
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted || err.name === "AbortError" || err.name === "APIUserAbortError") {
          emit("turn_end", { projectId, stopped: true });
          return;
        }
        // eager input streaming can produce an unparseable tool input; re-issue the turn once or twice
        if (!isApiError(err) && /JSON/i.test(err.message) && i < 2) continue;
        throw err;
      }

      project.messages.push({ role: "assistant", content: message.content });
      await store.saveProject(project);
      emit("assistant_message", { projectId, content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason === "refusal") {
        emit("notice", { projectId, text: "The model declined this request." });
        break;
      }
      const calls = message.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) break;
      if (message.stop_reason === "max_tokens") {
        // a tool input cut off at max_tokens may look valid; do not run it
        project.messages.push({
          role: "user",
          content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, is_error: true, content: "Output was cut off at max_tokens; the call was not run. Split the work into smaller steps." })),
        });
        await store.saveProject(project);
        continue;
      }

      // run calls concurrently, return every result in one user message
      const results = await Promise.all(
        calls.map(async (c) => {
          emit("tool_start", { projectId, id: c.id, name: c.name, input: c.input });
          const r = await callTool(c.name, c.input, { caller: "model", projectId, signal: ac.signal });
          emit("tool_end", { projectId, id: c.id, name: c.name, ok: r.ok, preview: r.content.slice(0, 2000) });
          return { type: "tool_result", tool_use_id: c.id, content: r.content, ...(r.ok ? {} : { is_error: true }) };
        }),
      );
      project.messages.push({ role: "user", content: results });
      await store.saveProject(project);
      if (ac.signal.aborted) {
        emit("turn_end", { projectId, stopped: true });
        return;
      }
    }
    emit("turn_end", { projectId });
  } catch (err) {
    console.error("turn failed:", err);
    emit("turn_error", { projectId, error: err.message || String(err) });
  } finally {
    running.delete(projectId);
  }
}

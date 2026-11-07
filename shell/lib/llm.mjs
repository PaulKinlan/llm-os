// Model adapter. One function, streamTurn(), so the agent loop does not care
// whether it talks to Claude or to the scripted fake used in tests and demos.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.mjs";
import { getApiKey } from "./store.mjs";
import { fakeTurn } from "./llm-fake.mjs";

let cached = { key: null, client: null };

async function client() {
  const key = await getApiKey();
  if (!key) throw new Error("No Anthropic API key yet. Add one in Settings.");
  if (cached.key !== key) cached = { key, client: new Anthropic({ apiKey: key }) };
  return cached.client;
}

/**
 * Run one model request, streaming text deltas to onText.
 * Returns the complete assistant message ({ content, stop_reason, ... }).
 */
export async function streamTurn({ system, messages, tools, onText, signal }) {
  if (config.fakeLlm) return fakeTurn({ messages, onText, signal });
  const c = await client();
  const stream = c.beta.messages.stream(
    {
      model: config.model,
      max_tokens: 64000,
      // auto-cache the stable prefix (tools + system + earlier turns)
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: system }],
      tools,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: config.effort },
      // if a safety classifier declines, let the API retry on a suitable model
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal },
  );
  stream.on("text", (delta) => onText(delta));
  return stream.finalMessage();
}

export function isApiError(err) {
  return err instanceof Anthropic.APIError;
}

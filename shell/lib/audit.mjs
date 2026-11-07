// Append-only audit log of every tool call the model (or a mini app) makes.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";

export async function audit(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.appendFile(path.join(config.dataDir, "audit.jsonl"), line);
  } catch (err) {
    console.error("audit write failed", err.message);
  }
}

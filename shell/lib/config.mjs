// Runtime configuration. Everything can be overridden with environment variables
// so the same code runs on the image, on a dev laptop, and in tests.
import os from "node:os";
import path from "node:path";

const home = os.homedir();

export const config = {
  port: Number(process.env.PORT || 8800),
  host: "127.0.0.1",
  dataDir: process.env.LLMOS_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "llmos"),
  model: process.env.LLMOS_MODEL || "claude-opus-5-5",
  effort: process.env.LLMOS_EFFORT || "medium",
  // LLMOS_FAKE_LLM=1 swaps the model for a scripted fake (tests, offline demos).
  fakeLlm: process.env.LLMOS_FAKE_LLM === "1",
  // LLMOS_DRY_RUN=1 makes system tools report the command they would run instead of running it.
  dryRun: process.env.LLMOS_DRY_RUN === "1",
  maxToolLoops: 40,
};

// Run a system command with a timeout and an output cap. In dry-run mode the
// command is described, not executed, so the shell can be developed on any machine.
import { execFile } from "node:child_process";
import { config } from "./config.mjs";

const MAX_OUTPUT = 32 * 1024;

function clip(s) {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} bytes]`;
}

export function run(cmd, args = [], { timeoutMs = 15000, input, dryRun = config.dryRun, env = process.env } = {}) {
  if (dryRun) {
    return Promise.resolve({ ok: true, dryRun: true, command: [cmd, ...args].join(" "), stdout: "", stderr: "", code: 0 });
  }
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({
        ok: !err,
        code,
        stdout: clip(String(stdout || "")),
        stderr: clip(String(stderr || (err && err.code === "ENOENT" ? `${cmd}: not installed` : err?.killed ? "timed out" : ""))),
      });
    });
    if (input != null) child.stdin.end(input);
  });
}

export function sh(script, opts) {
  return run("bash", ["-lc", script], opts);
}

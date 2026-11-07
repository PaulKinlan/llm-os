// Window tools: the compositor is a hidden substrate the model drives through
// hyprctl. Workspace 1 is always the shell; other windows go to workspace 2.
import { run } from "../exec.mjs";

const hasHyprland = () => Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);

function out(r) {
  if (r.dryRun) return { dryRun: true, wouldRun: r.command };
  return r.ok ? (r.stdout.trim() || "ok") : { error: (r.stderr || r.stdout).trim() };
}

const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const windowTools = [
  {
    name: "open_url",
    tier: "change",
    description:
      "Open a web page in a real Chrome window, beside the shell (the user returns with Super+Escape). " +
      "Use this for websites the user wants to browse; build a mini app instead when they want a tool.",
    input_schema: obj({ url: { type: "string", description: "http(s) URL" } }, ["url"]),
    async run({ url }) {
      if (!/^https?:\/\//i.test(url)) return { error: "only http(s) URLs" };
      if (!hasHyprland()) {
        return { error: "no window manager is running (kiosk fallback mode), so real windows cannot open; tell the user" };
      }
      return out(await run("hyprctl", ["dispatch", "exec", `[workspace 2] chromium --new-window ${JSON.stringify(url)}`]));
    },
  },
  {
    name: "list_windows",
    tier: "read",
    description: "List open windows (other than the shell) with their address, class, title and workspace.",
    input_schema: obj(),
    async run() {
      if (!hasHyprland()) return [];
      const r = await run("hyprctl", ["clients", "-j"]);
      if (!r.ok || r.dryRun) return out(r);
      return JSON.parse(r.stdout)
        .filter((c) => c.workspace?.id !== 1)
        .map((c) => ({ address: c.address, class: c.class, title: c.title, workspace: c.workspace?.id }));
    },
  },
  {
    name: "focus_window",
    tier: "change",
    description: "Bring a window to the front by address (from list_windows), or pass \"shell\" to return to the shell.",
    input_schema: obj({ address: { type: "string" } }, ["address"]),
    async run({ address }) {
      if (!hasHyprland()) return { error: "no window manager is running" };
      if (address === "shell") return out(await run("hyprctl", ["dispatch", "workspace", "1"]));
      return out(await run("hyprctl", ["dispatch", "focuswindow", `address:${address}`]));
    },
  },
  {
    name: "close_window",
    tier: "change",
    description: "Close a window by address (from list_windows).",
    input_schema: obj({ address: { type: "string" } }, ["address"]),
    async run({ address }) {
      if (!hasHyprland()) return { error: "no window manager is running" };
      return out(await run("hyprctl", ["dispatch", "closewindow", `address:${address}`]));
    },
  },
];

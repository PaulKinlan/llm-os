// System tools. v0 wraps standard CLIs; each group maps to a future per-subsystem
// MCP server over D-Bus (NetworkManager, PipeWire, UPower, logind, systemd).
import { run, sh } from "../exec.mjs";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

function out(r) {
  if (r.dryRun) return { dryRun: true, wouldRun: r.command };
  return r.ok ? (r.stdout.trim() || "ok") : { error: (r.stderr || r.stdout || `exit ${r.code}`).trim(), code: r.code };
}

export const systemTools = [
  {
    name: "system_info",
    tier: "read",
    description: "Overview of this machine: hostname, OS, kernel, uptime, CPU, memory, disks, battery, and current time/timezone.",
    input_schema: obj(),
    async run() {
      return out(await sh(
        "echo \"host: $(hostname)\"; . /etc/os-release 2>/dev/null && echo \"os: $PRETTY_NAME\"; echo \"kernel: $(uname -r)\"; " +
        "echo \"uptime: $(uptime -p 2>/dev/null)\"; echo \"cpu: $(nproc) x $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)\"; " +
        "echo; free -h; echo; df -h -x tmpfs -x devtmpfs 2>/dev/null; echo; " +
        "(upower -i $(upower -e 2>/dev/null | grep -m1 BAT) 2>/dev/null | grep -E 'state|percentage|time to') || echo 'battery: none'; " +
        "echo; timedatectl 2>/dev/null | grep -E 'Local time|Time zone' || date"
      ));
    },
  },
  {
    name: "network_status",
    tier: "read",
    description: "Current network connections, devices and IP addresses (NetworkManager).",
    input_schema: obj(),
    async run() {
      return out(await sh("nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status; echo; ip -brief address"));
    },
  },
  {
    name: "wifi_scan",
    tier: "read",
    description: "Scan for nearby Wi-Fi networks. Returns SSID, signal strength (0-100), security and whether it is the active network.",
    input_schema: obj(),
    async run() {
      const r = await run("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"], { timeoutMs: 20000 });
      if (!r.ok || r.dryRun) return out(r);
      return r.stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [inUse, ssid, signal, security] = line.split(/(?<!\\):/);
        return { ssid: ssid.replace(/\\:/g, ":"), signal: Number(signal), security: security || "open", active: inUse === "*" };
      });
    },
  },
  {
    name: "wifi_connect",
    tier: "confirm",
    description: "Connect to a Wi-Fi network by SSID, with an optional password.",
    input_schema: obj({ ssid: str("Network name"), password: str("Password, if the network is secured") }, ["ssid"]),
    summarize: (i) => `Join Wi-Fi network "${i.ssid}"`,
    async run({ ssid, password }) {
      const args = ["device", "wifi", "connect", ssid];
      if (password) args.push("password", password);
      return out(await run("nmcli", args, { timeoutMs: 45000 }));
    },
  },
  {
    name: "audio_status",
    tier: "read",
    description: "Audio outputs/inputs and the current default volume and mute state (PipeWire/WirePlumber).",
    input_schema: obj(),
    async run() {
      return out(await sh("wpctl status 2>&1 | sed -n '/Audio/,/Video/p'; echo; echo \"default sink: $(wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>&1)\""));
    },
  },
  {
    name: "set_volume",
    tier: "change",
    description: "Set the default output volume as a percentage (0-150), and optionally mute or unmute.",
    input_schema: obj({ percent: num("Volume percent", { minimum: 0, maximum: 150 }), mute: { type: "boolean", description: "true to mute, false to unmute" } }),
    async run({ percent, mute }) {
      const results = [];
      if (typeof percent === "number") results.push(out(await run("wpctl", ["set-volume", "-l", "1.5", "@DEFAULT_AUDIO_SINK@", `${Math.round(percent)}%`])));
      if (typeof mute === "boolean") results.push(out(await run("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", mute ? "1" : "0"])));
      if (!results.length) return { error: "nothing to change: pass percent and/or mute" };
      const failed = results.find((r) => r && typeof r === "object" && "error" in r);
      return failed || results;
    },
  },
  {
    name: "set_brightness",
    tier: "change",
    description: "Set the display backlight brightness as a percentage (1-100).",
    input_schema: obj({ percent: num("Brightness percent", { minimum: 1, maximum: 100 }) }, ["percent"]),
    async run({ percent }) {
      return out(await run("brightnessctl", ["set", `${Math.round(percent)}%`]));
    },
  },
  {
    name: "power",
    tier: "confirm",
    description: "Suspend, reboot or power off the machine.",
    input_schema: obj({ action: str("What to do", { enum: ["suspend", "reboot", "poweroff"] }) }, ["action"]),
    summarize: (i) => `${i.action[0].toUpperCase()}${i.action.slice(1)} the machine`,
    async run({ action }) {
      return out(await run("systemctl", [action]));
    },
  },
  {
    name: "service_status",
    tier: "read",
    description: "Status of a systemd service, or a list of failed units when no name is given.",
    input_schema: obj({ name: str("Unit name, e.g. bluetooth.service") }),
    async run({ name }) {
      if (!name) return out(await run("systemctl", ["--failed", "--no-pager"]));
      return out(await run("systemctl", ["status", "--no-pager", "-n", "20", name]));
    },
  },
  {
    name: "service_action",
    tier: "confirm",
    description: "Start, stop, restart, enable or disable a systemd service (uses sudo).",
    input_schema: obj({ name: str("Unit name"), action: str("Action", { enum: ["start", "stop", "restart", "enable", "disable"] }) }, ["name", "action"]),
    summarize: (i) => `${i.action} ${i.name}`,
    async run({ name, action }) {
      return out(await run("sudo", ["-n", "systemctl", action, name], { timeoutMs: 30000 }));
    },
  },
  {
    name: "run_command",
    tier: "confirm",
    description:
      "Run a shell command (bash) as the user and return its output. The user must approve each command. " +
      "Use sudo -n for root. Prefer the dedicated tools when one fits. Output is capped at 32 KiB; timeout is 120 s.",
    input_schema: obj({ command: str("The bash command"), reason: str("One line on why, shown to the user") }, ["command", "reason"]),
    summarize: (i) => i.command,
    async run({ command }) {
      const r = await sh(command, { timeoutMs: 120000 });
      if (r.dryRun) return out(r);
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  },
];

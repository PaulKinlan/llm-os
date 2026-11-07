# llm-os

An experiment in an operating system whose interface is an LLM chat harness.
The machine boots straight into a conversation. There is no desktop or app
launcher: you ask for things, the assistant acts on the machine through tools,
and when you need UI it writes a small app for you on the spot.

Status: **v0 prototype**, boots in a VM. See [docs/architecture.md](docs/architecture.md).

## What's here

| Path | What |
|---|---|
| `shell/` | The shell: a Node daemon (agent loop on the Claude API, system tools, app store) and the web UI it serves |
| `image/` | archiso overlay that turns stock Arch `releng` into the llmos live image |
| `scripts/run-vm.sh` | Boot the ISO in QEMU |
| `scripts/boot-test.sh` | Headless boot test used by CI (serial health check + screenshots) |
| `.github/workflows/image.yml` | Runs shell tests, builds the ISO, boots it, uploads screenshots |

## Try the shell on any machine

```bash
cd shell
npm install
npm run dev          # offline demo model + dry-run system tools, http://127.0.0.1:8800
# or for real:
ANTHROPIC_API_KEY=sk-ant-... npm start
```

In dev mode try "make a clock app", "scan wifi", "run uname" or "system info".
With a real key, ask for anything: "build me a Wi-Fi settings app", "set the volume to 30%".

## Get the image

Every push builds `llmos-*.iso` in GitHub Actions (artifact `llmos-iso`), boots it
under QEMU and uploads screenshots (artifact `boot-test`). To build locally on Arch:

```bash
sudo pacman -S archiso nodejs npm
sudo ./image/build.sh            # -> out/llmos-*.iso
```

## Run it

```bash
ANTHROPIC_API_KEY=sk-ant-... scripts/run-vm.sh out/llmos-*.iso
LLMOS_GL=1 scripts/run-vm.sh ...   # virgl 3D so Hyprland runs; otherwise it falls back to cage
```

Without `ANTHROPIC_API_KEY` the shell asks for a key on first start. The live
image keeps everything in RAM, so state is lost on reboot (for now).

Keys inside the VM: `Super+Esc` back to the shell, `Super+Tab` to real windows,
`Ctrl+Alt+F2` for a plain text console (user `os`, no password, passwordless sudo).

## How the pieces fit

- **Session**: tty1 autologin as `os` → `llmos-session` → Hyprland (locked down, no bar) or
  `cage` → `llmos-launch` → shell daemon + Chromium `--kiosk`.
- **Agent**: `shell/lib/agent.mjs` streams from `claude-opus-5-5` with tool use; history is
  append-only per project in `~/.local/share/llmos/projects/`.
- **Tools**: `shell/lib/tools/` – system (`nmcli`, `wpctl`, `brightnessctl`, `systemctl`),
  windows (`hyprctl`), apps. Tiers: `read`, `change`, `confirm` (needs a click). Everything is
  logged to `~/.local/share/llmos/audit.jsonl`.
- **Mini apps**: HTML the model writes, run in `<iframe sandbox="allow-scripts">`. They expose
  tools back to the model with `webMcp.registerTool()` and call granted system tools with
  `os.call()`. Pattern borrowed from [voicebox](https://github.com/PaulKinlan/voicebox).

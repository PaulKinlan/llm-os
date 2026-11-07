#!/bin/bash
# Boot the llmos ISO in QEMU.
#
#   scripts/run-vm.sh [path/to/llmos.iso]
#
# Environment:
#   ANTHROPIC_API_KEY   passed into the VM (fw_cfg) so the shell works without typing it
#   LLMOS_GL=1          use virtio-gpu with OpenGL (virgl). Needed for Hyprland; without it
#                       the image falls back to the cage kiosk compositor.
#   LLMOS_HEADLESS=1    no window; QMP socket at $STATE/qmp.sock, serial log at $STATE/serial.log
#   LLMOS_UEFI=1        boot with OVMF instead of BIOS
#   MEM / CPUS          defaults 4G / 4
set -euo pipefail
cd "$(dirname "$0")/.."

ISO="${1:-$(ls -t out/*.iso 2>/dev/null | head -1)}"
[[ -f "$ISO" ]] || { echo "no ISO found; build one or download it from the CI run" >&2; exit 1; }
STATE="${STATE:-$(mktemp -d)}"

args=(
  -name llmos -machine q35 -m "${MEM:-4G}" -smp "${CPUS:-4}"
  -cdrom "$ISO" -boot d
  -nic user,model=virtio-net-pci
  -device virtio-tablet-pci -device virtio-keyboard-pci
  -device intel-hda -device hda-duplex
)
[[ -w /dev/kvm ]] && args+=(-enable-kvm -cpu host)

if [[ "${LLMOS_UEFI:-0}" == 1 ]]; then
  for f in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/edk2/x64/OVMF_CODE.4m.fd /usr/share/edk2-ovmf/x64/OVMF_CODE.fd; do
    [[ -f $f ]] && { args+=(-drive "if=pflash,format=raw,readonly=on,file=$f"); break; }
  done
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  umask 077
  printf '%s' "$ANTHROPIC_API_KEY" > "$STATE/key"
  args+=(-fw_cfg "name=opt/llmos/anthropic_key,file=$STATE/key")
fi

if [[ "${LLMOS_HEADLESS:-0}" == 1 ]]; then
  args+=(-device virtio-vga -display none -serial "file:$STATE/serial.log" -qmp "unix:$STATE/qmp.sock,server,nowait")
elif [[ "${LLMOS_GL:-0}" == 1 ]]; then
  args+=(-device virtio-vga-gl -display "gtk,gl=on" -serial mon:stdio)
else
  args+=(-device virtio-vga -display gtk -serial mon:stdio)
fi

echo "state: $STATE"
exec qemu-system-x86_64 "${args[@]}"

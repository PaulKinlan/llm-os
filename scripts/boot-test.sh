#!/bin/bash
# Headless boot test: boot the ISO, wait for the shell to report it is up on the
# serial console, then take screenshots over QMP.
#
#   scripts/boot-test.sh path/to/llmos.iso [outdir]
set -euo pipefail
ISO="$1"
OUTDIR="${2:-boot-test}"
TIMEOUT="${BOOT_TIMEOUT:-600}"
mkdir -p "$OUTDIR"
export STATE="$(cd "$OUTDIR" && pwd)" LLMOS_HEADLESS=1

"$(dirname "$0")/run-vm.sh" "$ISO" &
QEMU_PID=$!
trap 'kill $QEMU_PID 2>/dev/null || true' EXIT

qmp() {
  python3 - "$STATE/qmp.sock" "$1" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); f = s.makefile("rw")
f.readline()
for cmd in ({"execute": "qmp_capabilities"}, json.loads(sys.argv[2])):
    f.write(json.dumps(cmd) + "\n"); f.flush()
    while True:
        r = json.loads(f.readline())
        if "return" in r or "error" in r:
            break
print(json.dumps(r))
PY
}
shot() { qmp "{\"execute\":\"screendump\",\"arguments\":{\"filename\":\"$STATE/$1.png\",\"format\":\"png\"}}" >/dev/null || true; }

status=1
for ((t = 0; t < TIMEOUT; t += 5)); do
  sleep 5
  if ! kill -0 $QEMU_PID 2>/dev/null; then echo "QEMU exited early"; break; fi
  (( t % 60 == 0 )) && shot "progress-${t}s"
  if grep -q "LLMOS_SHELL_UP" "$STATE/serial.log" 2>/dev/null; then status=0; break; fi
  if grep -q "LLMOS_SHELL_DOWN" "$STATE/serial.log" 2>/dev/null; then break; fi
done

# give Chromium time to paint, then capture the result
sleep "${SETTLE:-45}"
shot shell
grep -E "LLMOS_SHELL_(UP|DOWN)" "$STATE/serial.log" || echo "no health report within ${TIMEOUT}s"
if (( status != 0 )); then
  echo "::group::serial console (last 200 lines)"
  tail -n 200 "$STATE/serial.log" | tr -d '\r'
  echo "::endgroup::"
fi
exit $status

#!/bin/bash
# Build the llmos live ISO. Runs on Arch Linux as root with archiso installed
# (CI does this in an archlinux container; see .github/workflows/image.yml).
#
#   sudo ./image/build.sh            -> out/llmos-YYYY.MM.DD-x86_64.iso
#
# Starts from archiso's stock "releng" profile and layers our packages and files
# on top, so upstream boot-loader and profile changes come for free.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/llmos-build}"
OUT="${OUT:-$ROOT/out}"
RELENG=/usr/share/archiso/configs/releng
P="$WORK/profile"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
command -v mkarchiso >/dev/null || { echo "install archiso first: pacman -S archiso" >&2; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"
cp -r "$RELENG" "$P"

# --- identity and compression -------------------------------------------------
sed -i \
  -e 's/^iso_name=.*/iso_name="llmos"/' \
  -e 's/^iso_label=.*/iso_label="LLMOS_$(date --date="@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y%m)"/' \
  -e 's|^iso_publisher=.*|iso_publisher="llm-os <https://github.com/PaulKinlan/llm-os>"|' \
  -e 's/^iso_application=.*/iso_application="llm-os live image"/' \
  -e "s/^airootfs_image_tool_options=.*/airootfs_image_tool_options=('-comp' 'zstd' '-Xcompression-level' '15' '-b' '1M')/" \
  "$P/profiledef.sh"
cat >> "$P/profiledef.sh" <<'PERMS'
file_permissions+=(
  ["/usr/local/bin/llmos-session"]="0:0:755"
  ["/usr/local/bin/llmos-launch"]="0:0:755"
  ["/usr/local/bin/llmos-firstboot"]="0:0:755"
  ["/usr/local/bin/llmos-healthcheck"]="0:0:755"
  ["/etc/sudoers.d/llmos"]="0:0:440"
)
PERMS

# --- packages -----------------------------------------------------------------
grep -vE '^\s*(#|$)' "$ROOT/image/packages.x86_64" >> "$P/packages.x86_64"
sort -u -o "$P/packages.x86_64" "$P/packages.x86_64"

# --- networking: NetworkManager instead of releng's networkd + iwd -------------
find "$P/airootfs/etc/systemd/system" -name '*networkd*' -prune -exec rm -rf {} +
find "$P/airootfs/etc/systemd/system" -name 'iwd.service' -exec rm -rf {} +
rm -rf "$P/airootfs/etc/systemd/network"

# --- our files ----------------------------------------------------------------
cp -a "$ROOT/image/airootfs/." "$P/airootfs/"

# the shell itself, with production dependencies only
install -d "$P/airootfs/usr/lib/llmos"
rm -rf "$WORK/shell"
cp -a "$ROOT/shell" "$WORK/shell"
(cd "$WORK/shell" && rm -rf node_modules test && npm ci --omit=dev --no-audit --no-fund)
cp -a "$WORK/shell" "$P/airootfs/usr/lib/llmos/shell"
git -C "$ROOT" rev-parse --short HEAD > "$P/airootfs/usr/lib/llmos/VERSION" 2>/dev/null || echo dev > "$P/airootfs/usr/lib/llmos/VERSION"

# --- boot: serial console too, so headless boots can be watched ---------------
for f in "$P"/efiboot/loader/entries/*.conf "$P"/syslinux/*.cfg "$P"/grub/*.cfg; do
  [[ -f $f ]] || continue
  sed -i -E '/archisobasedir=/ s/$/ console=tty0 console=ttyS0,115200/' "$f"
done
# boot without waiting at the menu
sed -i -E 's/^timeout .*/timeout 3/' "$P/efiboot/loader/loader.conf" 2>/dev/null || true
sed -i -E 's/^TIMEOUT .*/TIMEOUT 30/' "$P/syslinux/archiso_sys.cfg" 2>/dev/null || true
sed -i -E 's/^set timeout=.*/set timeout=3/' "$P/grub/grub.cfg" 2>/dev/null || true

mkarchiso -v -r -w "$WORK/work" -o "$OUT" "$P"
ls -lh "$OUT"

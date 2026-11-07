[[ -f ~/.bashrc ]] && . ~/.bashrc
# tty1 is the llmos session; other ttys stay plain shells (Ctrl+Alt+F2).
if [[ "$(tty)" == /dev/tty1 && -z "${WAYLAND_DISPLAY:-}" ]]; then
  exec /usr/local/bin/llmos-session
fi

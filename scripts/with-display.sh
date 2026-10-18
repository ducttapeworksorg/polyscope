#!/bin/sh
# Runs a command with a display of its own, as CI's Linux jobs run the smoke and extension tests
# (.github/workflows/ci.yml): an Xvfb server, with Fluxbox on it, since Xvfb alone has no window manager to maximize a
# window. For a machine with no display, such as a Claude Code cloud session:
#
#   scripts/with-display.sh npm run test:smoke
set -eu

[ "$#" -gt 0 ] || { echo "usage: $0 command [argument...]" >&2; exit 2; }
# shellcheck disable=SC2016 # expanded by the shell xvfb-run starts.
exec xvfb-run --auto-servernum sh -c '
  fluxbox > /dev/null 2>&1 &
  for _ in $(seq 1 30); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2> /dev/null | grep -q "window id" && break
    sleep 1
  done
  exec "$@"' with-display "$@"

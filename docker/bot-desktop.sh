#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Starts an isolated Xvfb + Openbox virtual desktop inside project/assistant containers (uid 10001, read-only rootfs).
# Usage:
#   bot-desktop run [--size WxHxD] [--display :N] -- <command...>
#   bot-desktop start [--size WxHxD] [--display :N]
set -eu

mode="${1:-}"
if [ -z "$mode" ]; then
  echo "Usage: bot-desktop <run|start> [--size 1440x900x24] [--display :99] [-- <command...>]" >&2
  exit 2
fi
shift

size="${BOT_DESKTOP_SIZE:-1440x900x24}"
display="${BOT_DESKTOP_DISPLAY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --size)
      size="$2"
      shift 2
      ;;
    --display)
      display="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

pick_display() {
  if [ -n "$display" ]; then
    echo "$display"
    return
  fi
  n=99
  while [ "$n" -lt 199 ]; do
    if [ ! -e "/tmp/.X${n}-lock" ] && [ ! -S "/tmp/.X11-unix/X${n}" ]; then
      echo ":$n"
      return
    fi
    n=$((n + 1))
  done
  echo "No free X11 display found" >&2
  exit 1
}

disp="$(pick_display)"
desktop_tmp="/tmp/bot-desktop-${disp#:}-$$"
mkdir -p "$desktop_tmp/config" "$desktop_tmp/cache" "$desktop_tmp/runtime"
chmod 700 "$desktop_tmp/runtime"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$desktop_tmp/config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$desktop_tmp/cache}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$desktop_tmp/runtime}"
export DISPLAY="$disp"

xvfb_pid=""
wm_pid=""

cleanup() {
  if [ -n "$wm_pid" ]; then kill "$wm_pid" 2>/dev/null || true; fi
  if [ -n "$xvfb_pid" ]; then kill "$xvfb_pid" 2>/dev/null || true; fi
  rm -rf "$desktop_tmp" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

Xvfb "$disp" -screen 0 "$size" -nolisten tcp -ac >/dev/null 2>&1 &
xvfb_pid=$!

ready=0
i=0
while [ "$i" -lt 50 ]; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Xvfb exited early on $disp" >&2
    exit 1
  fi
  if xdpyinfo -display "$disp" >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 0.1
done

if [ "$ready" -ne 1 ]; then
  echo "Timed out waiting for Xvfb on $disp" >&2
  exit 1
fi

openbox >/dev/null 2>&1 &
wm_pid=$!

case "$mode" in
  start)
    echo "DISPLAY=$disp"
    wait "$xvfb_pid"
    ;;
  run)
    if [ $# -eq 0 ]; then
      echo "bot-desktop run requires a command" >&2
      exit 2
    fi
    set +e
    "$@"
    rc=$?
    set -e
    exit "$rc"
    ;;
  *)
    echo "Unknown mode: $mode (expected run or start)" >&2
    exit 2
    ;;
esac

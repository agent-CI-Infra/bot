#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Chromium's setuid sandbox is not usable in these containers (uid 10001, no extra capabilities).
# This wrapper is the stable path exported as BOT_BROWSER_EXECUTABLE.
# Containers run with a read-only root and may have a read-only HOME; crashpad and profile state need writable dirs.
set -e
HOME="${BOT_BROWSER_HOME:-/tmp/bot-chromium-home}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export HOME XDG_CONFIG_HOME XDG_CACHE_HOME
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --disable-gpu "$@"

#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Chromium's setuid sandbox is not usable in these containers (uid 10001, no extra capabilities).
# This wrapper is the stable path exported as BOT_BROWSER_EXECUTABLE.
# Control-plane deployments have a read-only root and no home directory; crashpad needs a writable HOME.
set -e
HOME="${BOT_BROWSER_HOME:-/tmp/bot-chromium-home}"
export HOME
mkdir -p "$HOME"
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --disable-gpu "$@"

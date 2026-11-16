#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Chromium's setuid sandbox is not usable in these containers (uid 10001, no extra capabilities).
# This wrapper is the stable path exported as BOT_BROWSER_EXECUTABLE.
set -e
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --disable-gpu "$@"

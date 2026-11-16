#!/bin/bash
set -euo pipefail
MCP="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -L "$MCP/node_modules" || -L "$MCP/.cache" ]]; then echo 'Unexpected symlink' >&2; exit 22; fi
mkdir -p "$MCP/.cache/tmp" "$MCP/.cache/browsers" "$MCP/artifacts/shared" "$MCP/.s"
export PWTEST_SOCKETS_DIR="$MCP/.s"
export PLAYWRIGHT_BROWSERS_PATH="$MCP/.cache/browsers"
cd "$MCP"
# Apply/verify the pinned Playwright compatibility patch after every install.
node "$MCP/patch-playwright.mjs"
exec node "$MCP/../launchers/browser.mjs" "$@"

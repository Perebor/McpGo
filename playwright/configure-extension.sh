#!/bin/bash
# One-time local setup. The token is never passed in a command-line argument.
set -euo pipefail
umask 077
SETTINGS="${HOME}/Library/Application Support/McpGo/playwright"
if [[ $# -gt 0 && "$1" != "--extension" ]]; then
  echo 'Only --extension is supported. CDP mode has been removed.' >&2
  exit 2
fi
if [[ ! -t 0 ]]; then echo 'Run this command in an interactive terminal so the token is not echoed.' >&2; exit 2; fi
echo 'Open Chrome Playwright Extension -> Manage clients -> copy PLAYWRIGHT_MCP_EXTENSION_TOKEN.'
read -r -s -p 'Paste extension token (not displayed): ' TOKEN
echo
TOKEN="${TOKEN#PLAYWRIGHT_MCP_EXTENSION_TOKEN=}"
if [[ ! "$TOKEN" =~ ^[^[:space:]]{16,2048}$ ]]; then
  echo 'Invalid token; no settings were changed.' >&2
  exit 2
fi
TOKEN_FILE="$SETTINGS/extension-token"
if [[ -L "$TOKEN_FILE" ]]; then echo 'Unsafe token file symlink' >&2; exit 2; fi
TMP="$(mktemp "$SETTINGS/.extension-token.XXXXXXXX")"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$TOKEN" > "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$TOKEN_FILE"
printf 'extension\n' > "$MODE_FILE"
chmod 600 "$MODE_FILE"
unset TOKEN
echo 'Playwright extension mode enabled. Restart the McpGo browser backend to apply.'
echo 'Chrome profile: the last-used profile with Playwright Extension installed (or MCPGO_CHROME_PROFILE_DIR).'

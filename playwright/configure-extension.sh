#!/bin/bash
# Optional CLI alternative to the first-run wizard; never log the secret token.
set -euo pipefail
umask 077
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--extension" ) ]]; then
  echo 'Only --extension is supported. CDP mode has been removed.' >&2
  exit 2
fi
if [[ ! -t 0 ]]; then
  echo 'Run in an interactive terminal so the token remains hidden.' >&2
  exit 2
fi
SETTINGS="$HOME/Library/Application Support/McpGo/playwright"
if [[ -L "$SETTINGS" ]]; then
  echo 'Unsafe Playwright settings directory symlink.' >&2
  exit 2
fi
mkdir -p "$SETTINGS"
chmod 700 "$SETTINGS"
TOKEN_FILE="$SETTINGS/extension-token"
MODE_FILE="$SETTINGS/browser-mode"
if [[ -L "$TOKEN_FILE" || -L "$MODE_FILE" ]]; then
  echo 'Unsafe Playwright settings symlink; no settings changed.' >&2
  exit 2
fi
echo 'First install the official Playwright Extension in Chrome:'
echo 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm'
echo 'Then click the extension icon -> Manage clients -> copy PLAYWRIGHT_MCP_EXTENSION_TOKEN.'
# Disable TTY echo BEFORE printing the prompt: automated input can arrive
# between the prompt and Bash read -s switching the terminal to silent mode.
TTY_STATE="$(stty -g <&0)" || { echo 'Cannot secure terminal input.' >&2; exit 2; }
stty -echo <&0 || { echo 'Cannot disable terminal echo.' >&2; exit 2; }
restore_tty() { stty "$TTY_STATE" <&0 || :; }
trap restore_tty EXIT
printf 'Paste PLAYWRIGHT_MCP_EXTENSION_TOKEN (hidden): '
IFS= read -r TOKEN || { printf '\n' >&2; echo 'No token entered.' >&2; exit 2; }
restore_tty
trap - EXIT
printf '\n'
# Accept the assignment copied from docs as well as the bare secret.
TOKEN="${TOKEN#PLAYWRIGHT_MCP_EXTENSION_TOKEN=}"
if [[ ${#TOKEN} -lt 16 || ${#TOKEN} -gt 2048 || ! "$TOKEN" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo 'Invalid extension token; no settings changed.' >&2
  unset TOKEN
  exit 2
fi
TOKEN_TMP="$(mktemp "$SETTINGS/.extension-token.XXXXXXXX")"
MODE_TMP=""
cleanup() { rm -f "$TOKEN_TMP" "$MODE_TMP"; }
trap cleanup EXIT
printf '%s\n' "$TOKEN" > "$TOKEN_TMP"
chmod 600 "$TOKEN_TMP"
MODE_TMP="$(mktemp "$SETTINGS/.browser-mode.XXXXXXXX")"
printf 'extension\n' > "$MODE_TMP"
chmod 600 "$MODE_TMP"
# Both destination paths were checked before writing; use atomic renames.
mv -f "$TOKEN_TMP" "$TOKEN_FILE"
mv -f "$MODE_TMP" "$MODE_FILE"
unset TOKEN
echo 'Extension token saved securely. Restart Browser MCP in McpGo to apply.'

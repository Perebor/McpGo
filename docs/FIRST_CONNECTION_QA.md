# First connection release gate (macOS + Windows)

Automated tests are necessary, not sufficient. Run on clean supported OS snapshots
using the exact signed installer proposed for release. Use a dedicated test OpenAI
organization/project and a fresh browser profile, never a real customer's credentials.

## Required evidence for each platform

- Fresh OS, no developer dependencies, no McpGo configuration.
- Install and launch; preflight detects missing browser/extension, no endless retries.
- Provision two tunnels and least-privilege runtime credentials.
- Interrupt setup before/after each persisted checkpoint (including API response before
  local credential save); restart and resume, no duplicate project/tunnel/role/account.
- Test invalid admin/runtime/extension keys, denied permissions, slow network, offline,
  throttling, transient API failure, and occupied ports; verify safe recovery.
- Confirm local MCP discovery and tool list, both tunnel readiness endpoints, and actual
  Chrome/Edge tab enumeration. No green indicator based only on PID or port.
- In ChatGPT connect each tunnel, perform a harmless Terminal command and list browser
  tabs. Local diagnostics alone do not prove ChatGPT end-to-end connectivity.
- Stop Browser, update in place, verify stopped services stay stopped and settings remain.
- Reinstall without deleting user data and confirm prior connection can be restored.
- Export diagnostics; check for no secrets or private routes.

Record OS/version, installer hash, outcome, logs with secrets redacted, and explicit
PASS/FAIL per scenario. A skipped or untested scenario is NOT a pass.
Do not publish the release until both platforms pass this gate.

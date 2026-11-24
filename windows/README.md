# McpGo for Windows 11 x64 — integrated test build

This is a Windows-native McpGo shell around the **same MCP runtime** used
by the macOS version. It is deliberately independent of WSL. macOS SwiftUI,
launchd, Keychain and DMG logic remain untouched.

## Included in the installer

- Electron application with a secure renderer, system tray, startup settings
  and service supervision with bounded reconnect delays.
- Bundled Windows x64 Node.js 24, Python 3.12 and the full OpenAI Secure MCP
  Tunnel client. No separate Node, Python, WSL or tunnel-client installation.
- Interactive PowerShell over ConPTY, plus recoverable OneShot command jobs,
  stable IDs, lock coordination, output pagination and timeouts.
- File list/read/edit/write/search tools in the **same private terminal tunnel**.
  Files default to the user's home directory. Edits require expected SHA256.
- Existing Playwright MCP safe proxy with Chrome/Edge extension integration.
  The Playwright browser extension itself must be installed in the browser.
- Existing AutoSend scheduling and reconciliation (no blind retry after an
  uncertain send), and SQLite agent messaging.
- Local first-run OpenAI Platform tunnel and runtime key provisioning. Admin
  credentials are passed via stdin to a short-lived Python process, never
  written to settings; the runtime key is encrypted through Windows DPAPI.

All backend HTTP listeners bind exclusively to 127.0.0.1. Two independent
outbound Secure MCP Tunnels forward the terminal and browser MCP endpoints.

## Desktop interface parity

The Windows Electron shell follows the macOS SwiftUI desktop layout:
dark palette, fixed sidebar, navigation, local status summary, and separate
Terminal/Playwright service cards. Pages: Overview, First connection, Agent
messaging, Tunnel settings, Skills, Scheduled messages, and Windows updates.
The sidebar also opens the local runtime, onboarding logs, and documentation.

Four bundled SKILL.md files are available under Skills. The renderer can only
read, copy, or reveal these four allowlisted files; arbitrary paths and shell
commands are not accepted. Copying a skill into a chat does not install a
ChatGPT plugin or grant permissions.

Windows still has a **global** service restart control, rather than macOS's
per-service Start/Stop/Restart controls. The status indicator shows *local*
process state and is not a remote ChatGPT tunnel verification.

UI source: \`windows/app/index.html\`, \`style.css\`, \`renderer.js\`; secure
IPC: \`main.cjs\`, \`preload.cjs\`, \`skills.cjs\`. Regression tests:
\`windows/tests/ui-parity.test.cjs\` and \`skills.test.cjs\`. Real Windows
interactive validation and packaging are separate release gates.

## First-run workflow

1. Run **McpGo Setup** under the Windows user account that owns the files and
   browser profile. The installer is per-user and needs no administrator rights.
2. Open Chrome or Edge, install and approve the official Playwright MCP Browser
   Extension. Reuse the logged-in browser session; no isolated Chromium.
   Install the [official Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) with the button in the McpGo setup screen, then copy `PLAYWRIGHT_MCP_EXTENSION_TOKEN` from the official extension's
   **Manage clients** dialog and paste it into McpGo Settings → **Playwright
   Extension · token**. This token is encrypted through Windows safeStorage;
   only the fact that it is configured is shown in the UI. Without it both
   browser services stay unconfigured and do **not** fall back to CDP.
   AutoSend runs as an additional extension client/group named `MCPGO AutoSend`
   on loopback port `8932`, separate from the main Browser MCP (`8931/8940`).
   Select the intended existing conversation tab in that group once. AutoSend
   never opens duplicate tabs or reloads conversations automatically.
3. In McpGo, optionally enter an OpenAI **Admin API Key** and click
   **Create two tunnels**. A second explicit action creates an isolated
   McpGo project and restricted Runtime Key. These API operations require the
   appropriate organization's permissions; uncertain remote writes are
   journaled and are NOT automatically repeated.
4. Alternatively, manually create the two Secure MCP Tunnels and paste their
   IDs and runtime keys into the connection form. Keys are encrypted at rest
   with OS-backed storage.
5. Add the two tunnels as custom MCP connections in ChatGPT (subject to account
   and workspace permissions). Verify tool discovery and a test invocation.
6. Create a scheduled task (initially **disabled**) from the AutoSend form.
   Verify its URL and explicitly enable it only when ready.

Secrets remain in the owner's per-user data directory under the app's
\`userData\`. The signed-in browser profile stays in Chrome/Edge, not McpGo.

## Source and release engineering

The principal entrypoints are:
- \`windows/app/main.cjs\` / \`runtime.cjs\`: UI, service startup and shutdown
- \`terminal/platform.js\`: Windows/macOS shell/path/process abstraction
- \`terminal/pty_worker_win.js\`: Windows ConPTY worker
- \`terminal/interactive_runtime.cjs\`: Interactive PTY sessions hosted inside the unified Terminal MCP process
- \`terminal/files_tools.cjs\`: bounded filesystem tools
- \`windows/onboarding_cli.py\`: Windows bridge to the existing Python installer
- \`windows/prepare-runtime.py\`: verified official binary downloading
- \`windows/verify-build.py\`: PE architecture + resource completeness audit

\`\`\`powershell
npm ci --prefix playwright --ignore-scripts
node playwright/patch-playwright.mjs
npm ci --prefix windows
python windows/prepare-runtime.py
npm test --prefix windows
node --test terminal/tests
npm run dist:win --prefix windows
python windows/verify-build.py
\`\`\`

A GitHub Actions \`windows-latest\` workflow also runs native OneShot,
ConPTY, file and embedded Python/SQLite smoke tests before archiving the
**unsigned** NSIS installer. Builds use pinned source and cryptographically
verified release assets.

## Release gates

The test-build installer is assembled on macOS as a Windows PE x64 file; a
successful cross-build and static test are not proof that the app functions
correctly on Windows. The **native Windows CI run and real-browser interactive
test** must both be green before calling this a stable release.

**No code-signing certificate is configured.** Windows SmartScreen may warn
about the unsigned binary. Do not bypass organization security controls to
install it. Signed production releases and securely verified auto-updates
require an actual publisher certificate and additional release validation.

## Unsigned distribution and updates

The application checks GitHub Releases for newer Windows **prereleases** only when
you click "Check for updates". It does not download, execute, install or
replace binaries in the background. The "Open new version" action opens a
strictly validated official github.com release page for a manual install.

An SHA-256 checksum makes accidental or in-transit corruption detectable when
compared to a trustworthy independently obtained reference; it is **not**
an Authenticode signature or proof of publisher identity. Do not disable
SmartScreen, Smart App Control, browser protections or antivirus software.
If organization policy blocks unsigned executables, use the source build or
wait for a permitted distribution method.

Windows ARM64 is not included in this x64 release. WSL is not required.


## Releasing a free unsigned Windows Preview

From a clean, pushed `main` commit, the **Windows-native workflow** must
succeed, including ConPTY, one-shot PowerShell output and embedded Python/SQLite.
A Mac cross-compiled installer must never be published as a substitute.

- `./tools/publish-windows-preview.sh --prepare` downloads the actual
  Windows CI artifact from the successful job for this exact commit, checks
  the Windows PE header, normalizes the public filename to GitHub’s dot-delimited
  asset name and produces a matching adjacent `.sha256` manifest.
- Update `app/windows-release.ts` in the separate website repository to
  **exactly** the staged hash and deploy the website.
- `./tools/publish-windows-preview.sh --publish` re-downloads the same CI
  artifact and compares its digest to the staged file before creating a
  **prerelease** with the installer and checksum.

No paid code-signing certificate, unattended updater or SmartScreen bypass.
The release process refuses to overwrite an existing GitHub release.

### Проверка Chrome и Edge при настройке

В настройках McpGo для Windows есть read-only проверка версии выбранного браузера. Для бесшовного фонового подключения Playwright Extension ориентир — **Chrome 158.0.8127.2+** и Extension 0.5.0+. Если версия устарела или не обнаружена, UI предупреждает об этом и предлагает **по нажатию** открыть официальный сайт обновления (Chrome / Edge). Установка McpGo, PowerShell и туннелей не блокируется, браузеры не меняются автоматически. Для Edge конкретный номер сборки фонового подключения нужно дополнительно проверять на практике.

## Browser-agent parity with macOS

Windows packaging includes the same shared `agent-scope.mjs`,
`portable-tab-identity.mjs`, `portable-agent-tabs.mjs`,
`tab-lease-manager.mjs` and `browser-session-manager.mjs` modules used on
macOS. The general Browser MCP uses the official Extension on `8931` with the
safe proxy on `8940`; AutoSend has its own backend on `8932` with separate
session name and tab group. Their scheduler/URL identity and one-click
receipt implementation is shared across macOS and Windows. No CDP fallback
or second Windows-only browser implementation exists.

The Windows installer is **not** built by this change. Portable unit tests and package verification run on macOS; real browser/extension, OAuth sessions, window focus, and crash recovery must be accepted on a Windows machine before releasing.

### Workspace IDs (same logic as macOS)

Both platforms package `browser-workspace.mjs` and `workspace-response.mjs`.
Every browser MCP tool result repeats the high-entropy `workspace_id` as
structured content and a compact text note. All browser tools support an
optional `workspace_id` that is removed by McpGo before the Playwright backend
sees the request. `mcpgo_workspace` restores tabs after a transport session
change, subject to the same stable identity and collision guards on Windows.
No duplicate Windows-specific algorithm is needed. Browser execution and
installer signing still require a separate native Windows E2E acceptance.

### MCP 2026-07-28 transport parity

Browser and Terminal use the same `playwright/mcp-modern-protocol.mjs` across
macOS and Windows. Modern clients use `server/discover`, strict modern routing
headers, and independent requests. Because the actual already-installed
ChatGPT McpGo plugin still sends MCP 2025, transitional legacy compatibility
is enabled on both platforms until a verified client upgrade. To enforce
modern-only after acceptance, set `MCPGO_DISABLE_LEGACY=1`. Playwright keeps
its private 2025 backend protocol and shared extension connection. Windows
installer/native Chrome/Edge E2E still requires a Windows machine.

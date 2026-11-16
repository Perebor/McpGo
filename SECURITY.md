# Security policy — McpGo

**Project status:** pre-publication reference implementation. McpGo has not yet announced a formal public security-response program, response SLA, supported-release list, or security-contact address. Do not interpret this document as a claim of independent security certification.

## Security architecture

- [Threat model](docs/THREAT_MODEL.md): capabilities, trust boundaries, STRIDE scenarios, residual risks.
- [Detailed security architecture](docs/SECURITY.md): loopback APIs, Chrome CDP, terminal authority and scheduler guarantees.
- [Independent audit guide](docs/AUDIT_GUIDE.md): verifiable source paths and tests.
- [Dependencies and supply chain](docs/DEPENDENCIES.md): direct/transitive versions and audit gaps.
- [Public release gates](docs/PUBLIC_RELEASE.md): mandatory work before recommending public distribution.

## Reporting vulnerabilities

A dedicated confidential reporting channel is **not configured yet**. Before public release, maintainers must configure GitHub private vulnerability reporting (or another explicitly published secure contact), describe supported versions and expected response times, and test the workflow. Do not place sensitive exploit details or private user data in public issues.

## Supported versions

No public release/version-support promise exists yet. A locally running McpGo.app is not an independently verified distribution artifact.

## Cautions

Terminal tools can run commands with the macOS user's permissions. Playwright uses the user's **existing Chrome session** via the official Playwright Extension only. Extension auto-approval requires a user-provided, private, browser-profile token that must never be committed or logged. Treat both as powerful capabilities; review workspace/client permissions before enabling them.

### Playwright Extension token (macOS)

In the first-run wizard the Playwright Extension token is submitted to the local onboarding engine over stdin (never process arguments), validated using an isolated read-only MCP trial, and stored owner-only (0600) under `~/Library/Application Support/McpGo/playwright/extension-token`. The live browser is switched only after trial success; failed live verification restores the previous mode and token. Do not paste this token into ChatGPT conversations, issue trackers, or logs.

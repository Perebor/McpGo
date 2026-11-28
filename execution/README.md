# McpGo MCP-10 · owner-local execution roles

This is a **real, bounded local executor**, not a registration-only agent directory and **not** four independent LLM instances. No ChatGPT / Codex / OpenCode model calls are performed by this module. The owner must supply and approve an exact local code-change plan and explicitly register a repository. Hub messages and browser content cannot supply executable code.

## Roles

- `mcpgo_lead` / **coordinator**: owns the local registry, atomic task claim, project/resource locks, branch creation, role dispatch, comparison of Git SHA and verification receipts
- `td_coder` / `museum_coder`: separate OS process, writes explicitly pinned bounded Python files into its own Git worktree and commits a branch
- `td_tester` / `museum_tester`: separate OS process and detached Git worktree at the exact coder commit, runs fixed `python -m unittest discover -s tests -t . -v`
- `td_auditor` / `museum_auditor`: third OS process and separate detached worktree; independently checks the parent commit, changed-path allowlist, source fingerprints and runs the fixed tests again

Roles use a trusted local `RoleEngine(state_root, worktree_root)`. Call `register(project, repo_path)` locally once, then `run(plan)`. The registry rejects one repository used by two projects. A plan must contain **exactly** `project`, `task_id`, `base_commit` and `changes`. Each change has exact `path`, `expected_sha256` (or null for new file), `content`. Only `src/<module>.py` and `tests/test_<module>.py` are currently allowed, with a pinned base commit, 1–8 files, bounded UTF-8 content and at least one test. Line-ending fingerprints normalize CRLF to LF for Git checkout portability. No shell command field is permitted.

A successful fixture result contains project, task, coordinator actor, role PIDs, 3 distinct worktrees, actual commit SHA, parent SHA, tester/auditor proof digests and `status=VERIFIED` **for local Git evidence**. This is separate from the Hub `VERIFIED` state or ChatGPT delivery verification. All worktrees and evidence remain for review; the executor never pushes, merges, edits production, resumes AutoSend or performs automatic retry.

## Signed Hub queue bridge (owner invoked)

`DelegatedQueueClient(actor, project, secret)` accepts only the project’s exact coder identity and the 32-byte scoped credential issued through the native owner-only Hub grant. `execute_once(engine, trusted_owner_plan, client)` sends one signed `POST /api/work/claim`, requires the returned queue **fingerprint to equal the SHA256 of the entire pinned local plan**, and only accepts the typed `{"intent":"build","context":"McpGo"}` envelope. After the local four-role process actually verifies its commit and tests, it signs one `POST /api/work/ack`. Hub moves to **ACKED**, not VERIFIED; only independent owner-side evidence can make Hub VERIFIED. An uncertain claim/ack stays UNKNOWN and must not be replayed automatically. No arbitrary Hub instruction is executed.

The adapter uses loopback only; do not copy credentials into source code, task files, logs, or chat messages. The test suite creates isolated temporary Hub databases and separate fixture Git repositories. It does not enqueue tasks into the user's running Hub or touch TD/Museum repositories.

## Safety and residual limits

This is **logical project/role isolation and Git worktree isolation**, not an OS container, hypervisor or operating-system account boundary. Python unit tests are executable code; only run them from an explicitly owner-trusted registered repository. Existing `agent-team/team.mjs` read-only Codex/OpenCode profiles are unchanged and are not silently upgraded to code writers.

A lock file left after a crash is not automatically reclaimed. `UNKNOWN` and `FAILED` task IDs must be inspected by the owner; never rerun them as if completion were definitely absent. The executor keeps original branches and worktrees. It cannot yet prove multi-LLM collaboration, live ChatGPT sends, or production-ready autonomous coding. CI and installed fixture E2E are required before closing MCP-10.

Tests: `python -m unittest discover -s execution/tests -v`.


## MCP-12: owner-local ledger, local-first routing and verified results

Files: `usage_ledger.py`, `usage_adapter.py`, `usage_cli.py`. The ledger is a private SQLite WAL database supplied explicitly by the owner; it stores only bounded event metadata, not prompts, cookies, secrets or transcripts. `UsageLedger.record_event` uses global event IDs and strict per-project/agent/run scope, with exact-payload idempotency. `MODEL_CLAIMED` is **a dispatch intent**, not proof that ChatGPT/Codex actually ran. Token counts and price are `UNKNOWN` unless a future independent provider receipt integration is implemented. No fake token estimate is used.

`choose_route(local, ordinary, limited, owner_paid)` is a **pure advisory function**. It prefers verified/local work, then ordinary chat when confirmed available. If ordinary quota is UNKNOWN, it returns WAIT_UNKNOWN, never silently escalating. A limited model is only suggested when ordinary is explicitly UNAVAILABLE, the limited tier is confirmed available, and the owner explicitly approved it. No models are called by this policy or by the CLI. This is not a quota bypass.

`run_owner_local_once(engine,ledger,pinned_plan,run_id,agent)` integrates one **owner-registered** Git fixture/repository and the pre-existing limited McpGo RoleEngine. The coder's actual Git commit and independent tester/auditor receipts are rechecked directly in owner-local RoleEngine SQLite and Git before `GIT_VERIFIED` is entered. Replay of a verified run returns ALREADY_RECORDED. Failing/UNKNOWN or conflicting work yields NEED_OWNER, never triggers an alternate model or reruns an ambiguous operation. The ledger is **not** an external CI attestation.

Commands (paths are examples, no actual project DB is inspected by this documentation):

```powershell
python execution/usage_cli.py summary --db C:\Temp\mcpgo12-usage.sqlite3 --project TD --agent td_coder
python execution/usage_cli.py route --local EXHAUSTED --ordinary UNKNOWN --limited AVAILABLE --owner-paid
python execution/usage_cli.py compare --fixtures execution/mcp12-scenarios.json
```

The six **identical synthetic cases** in the fixture compare a hypothetical naive request-per-task baseline (6 claimed requests) against **policy choices** (2 suggested model claims, 2 local-no-model, 2 wait/blocked). They do not measure actual model invocations, saved tokens, money or independently verified Git results. The owner-local Git E2E separately proves a real commit/test/audit with **0 model calls**. Reporting both numbers without conflating them is intentional.

Remaining MCP-12 acceptance work: a provider-confirmed usage-receipt adapter (not inferred from ChatGPT DOM or model text), run identifiers linked to real approved ChatGPT AutoSend sends, and owner acceptance of before/after result quality on live but safe isolated conversations. Until then MCP-12 cannot be marked VERIFIED and all provider usage/quotas remain UNKNOWN.


## MCP-12: scoped local Codex telemetry (preview.34 candidate, 28.11.2026)

`execution/codex_usage.py` reads only allowlisted metadata from a local Codex JSONL session: `session_meta.id/cwd/model_provider` and `event_msg: token_count.info.total_token_usage`. The user must supply the **exact session file** under an approved `.codex/sessions` or `.codex/archived_sessions` root and an **existing registered owner RoleEngine project repository**. The session `cwd` must resolve exactly to that repository and the requesting actor must be its registered coder; an arbitrary caller cannot tag a TD session as Museum or McpGo. Symlinked files, malformed/receding token totals, missing metadata, cross-project and unverifiable records fail closed. No payload messages, transcripts, credentials, API keys, chat IDs, or full local paths are persisted.

`UsageLedger.record_codex_observation` stores *one cumulative row per Codex session UUID globally*, with monotonic update and idempotent restart/replay; an identical log in another project/agent is rejected. Aggregates expose `codex_observed_input_tokens`, `codex_observed_cached_input_tokens`, `codex_observed_output_tokens`, `codex_observed_reasoning_output_tokens`, and `codex_observed_token_updates` separately. These are **local client-recorded counters**, `LOCAL_CODEX_SESSION_NOT_PROVIDER_SIGNED`, not provider-signed API usage/billing receipts or measured account cost. Model claim/call confirmation stays separate, and price, subscription allowance and saved money remain `UNKNOWN`.

Explicit owner-only example, with registered fixture paths substituted:

```powershell
python execution/usage_cli.py capture-codex --db C:\Temp\mcpgo12-usage.sqlite3 --session C:\Users\User\.codex\sessions\2026\11\28\rollout-UUID.jsonl --codex-root C:\Users\User\.codex --engine-state C:\Temp\mcpgo-fixture-state --engine-worktrees C:\Temp\mcpgo-fixture-worktrees --project TD --agent td_coder --run-id fixture-run
```

This command is **never run automatically by AutoSend** and must not be used to attribute unrelated work. Existing local Codex logs found on 28.11.2026 (23 sessions, 3308 `token_count` events) are primarily TD sessions: 13 sessions/3203 events had TD directory metadata, 10 sessions/105 were other or unknown. None established source project McpGo. They were **read-only inspected and never imported into this ledger**. Real ChatGPT UI exposes aggregate remaining limits, not per-turn token receipts; the observed 5-hour/weekly quota percentage does not establish model call, tokens or cost. Completing MCP-12 requires authorized, attributable live model calls and provider-side/account receipts where available, plus matched real-work-cycle before/after evidence without ambiguous sends. Until then SOURCE_VERIFIED, not VERIFIED.


## Preview.36 · Автоматический учёт локальных ChatGPT-ответов

AutoSend теперь записывает **новые** подтверждённые или неизвестные результаты доставки в `AutoSend/usage.sqlite3` автоматически, по одному событию на неизменяемый ID квитанции. Это тот же SQLite-файл, с которым работает `UsageLedger`; импорт Python больше не требуется для учёта DOM-квитанций. Actor `chatgpt_autosend` отделён от coder/tester/auditor. TD и Museum читаются `UsageLedger.summary(project,'chatgpt_autosend')`; остальные проекты получают отдельную область `task:<UUID>` в Node `modelUsage.rows`.

Пример только чтения:
```powershell
python execution/usage_cli.py summary --db "$env:APPDATA\mcpgo-windows\AutoSend\usage.sqlite3" --project Museum --agent chatgpt_autosend
```
`observed_chat_responses` — это локально проверенные новые ответы, `owner_attested_responses` и `delivery_unknown` — самостоятельные категории. `confirmed_model_calls=0` по отношению к независимым provider receipts, точные токены/стоимость `UNKNOWN`. Этот учёт **не** является провайдерской платёжной квитанцией, не оценивает стоимость и не запускает ChatGPT. `choose_route` остаётся локальной рекомендательной функцией, не перехватывает live AutoSend dispatcher. Для реальной экономии нужны источник provider-side usage и сопоставимые проверенные циклы.


## MCP-12: read-only per-chat AutoSend receipt inspection (2026-11-28)

An owner-approved standalone ChatGPT test task is recorded automatically in the shared
`AutoSend/usage.sqlite3` as `project=task:<canonical UUID>`, `agent=chatgpt_autosend`.
`UsageLedger.summary` and `usage_cli.py summary` now accept that exact task scope
**only for that observer actor**, keeping TD/Museum authorizations unchanged and
forbidding attempts to create a claimed model event under a task scope. The CLI
opens an **existing database in SQLite `mode=ro`**, never initializes tables or
uses `BEGIN IMMEDIATE`. An unavailable file is an error, not a newly created
empty source.

Example (substitute the actual owner-approved task UUID):

```powershell
python execution/usage_cli.py summary --db "$env:APPDATA\mcpgo-windows\AutoSend\usage.sqlite3" --project "task:00000000-0000-4000-8000-000000000001" --agent chatgpt_autosend
```

An observed DOM reply means only `CHAT_RESPONSE_OBSERVED`, not provider-signed
model-call, usage, verified Git change or saved money. Such quantities stay
`UNKNOWN` or zero as appropriate. The source branch adds read-only inspection;
it does not alter model selection/AutoSend send scheduling and requires the next
versioned installer to include the new CLI behavior.

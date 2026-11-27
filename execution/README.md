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

# McpGo — Messaging: реестр агентов и локальная очередь

## 1. Принципиальное отличие от AutoSend

**Messaging** — это явно опубликованные записи, которые агент получает через `inbox` в своём разговоре. **AutoSend** — это браузерная отправка текста непосредственно в конкретный чат по таймеру. Они не являются одной общей очередью, не имеют одинаковых гарантий и не заменяют друг друга.

Messaging **не** имеет доступа к закрытой истории произвольных ChatGPT-разговоров. Он хранит только сообщения, которые намеренно отправили в локальную систему.

## 2. Runtime и таблицы

`messaging/hub.py` — Python 3, `ThreadingHTTPServer`, порт `127.0.0.1:8971`. `messaging/start.mjs` — Node launcher для launchd.

База — SQLite в `messaging/data/messages.sqlite3`, при открытии включаются `PRAGMA journal_mode=WAL`, `foreign_keys=ON` и `busy_timeout=5000`. Схема автоматически создаётся при инициализации подключения.

| Таблица | Назначение | Основные поля |
|---|---|---|
| `agents` | Реестр и роли | `id`, `label`, `role`, `chat_url`, `last_report`, `last_seen`, `archived_at`, `replaced_by` |
| `messages` | Опубликованные записи | `id`, `sender`, `recipient`, `kind`, `body`, `created_at` |
| `reads` | Подтверждение просмотра | `message_id`, `reader`, `read_at` |

Реализация допускает одного активного оркестратора (partial unique index). `hub` — зарезервированная техническая запись для локальных системных сообщений, а не произвольный пользовательский agent ID.

## 3. Роли

- `agent` — обычный участник, видит свои исходящие, адресованные и broadcast сообщения.
- `orchestrator` — единственный активный оркестратор с обзором опубликованной истории.
- `hub` — внутренний сервисный отправитель/обзор в локальной системе.

Это **логические роли для фильтрации очереди**, не отдельные системные аккаунты macOS. Локальный пользователь, владеющий данными и процессом, имеет более широкие полномочия; нельзя считать таблицу `agents` полноценным средством многоарендной изоляции.

## 4. Правила идентификаторов и сообщений

Agent ID: латинская буква в начале, далее буквы/цифры/`_`/`-`, общая длина до **32** символов. Имя для UI — 1–90 символов. Опциональный URL — до 500 символов, начинается с `https://chatgpt.com/`; он служит привязкой/справочной меткой, но не создаёт автоматический API-доступ к беседе.

Максимальный текст сообщения — **16000** символов. Допустимые `kind`: `message` и `report`. `report` маршрутизируется текущему оркестратору; если тот не назначен, публикация не производится. Пользователь не может отправлять самому себе через обычную функцию `send`.

## 5. CLI через ChatTerminalHub

```bash
# Вызовы выполняются локально на Mac через terminal_exec
python3 messaging/hub.py agents
python3 messaging/hub.py archived
python3 messaging/hub.py inbox --as AGENT_ID
python3 messaging/hub.py history --as ORCHESTRATOR_ID
python3 messaging/hub.py send --as AGENT_ID --to PEER_ID --text 'Текст'
python3 messaging/hub.py report --as AGENT_ID --text 'Отчёт и статус'
python3 messaging/hub.py ack --as AGENT_ID 123 124
```

Для длинного текста доступен `--stdin` (см. CLI help). Не используйте выдуманные ID: получайте их из UI/реестра. `ack` следует вызывать после обработки поручения, а не при одном лишь получении списка.

## 6. HTTP API

| Метод | Маршрут | Операция |
|---|---|---|
| GET | `/api/status` | Статистика |
| GET | `/api/agents` | Активные участники |
| GET | `/api/agents/archived` | Архив |
| GET | `/api/history` | Опубликованная история |
| GET | `/api/inbox` | Непрочитанное конкретного агента |
| POST | `/api/agents` | Регистрация |
| POST | `/api/orchestrator` | Назначение оркестратора |
| POST | `/api/agents/role` | Изменение роли |
| POST | `/api/agents/archive` | Архивирование |
| POST | `/api/agents/restore` | Восстановление |
| POST | `/api/agents/replace` | Замена чата/ID |
| POST | `/api/agents/delete` | Безвозвратное удаление архивного |
| POST | `/api/messages` | Публикация |
| POST | `/api/ack` | Отметить обработанным |

Сервер проверяет `Host`, требует `X-MCPHub-Client: native` и отклоняет браузерные `Origin`. Для POST необходим `application/json`, максимум **26000** байт тела. Это локальный клиентский барьер, а не доказанная криптографическая защита от другого процесса того же пользователя.

## 7. Архивация и замена исчерпанного разговора

`archive_agent` запрещает дальнейшее использование архивного ID, сохраняя историю. `restore_agent` снимает флаг архива. `replace_agent` атомарно регистрирует новый ID, архивирует старый и сохраняет привязку `replaced_by`.

При замене:
1. Новый агент получает новую запись.
2. Старый агент архивируется и становится `agent`.
3. Если старый был orchestrator, роль переходит новому ID.
4. Непрочитанные **прямые** сообщения старого ID копируются как новые сервисные сообщения новому.
5. При наличии `last_report` его текст также вставляется как handoff.
6. Старые записи **остаются** в истории старого ID.

Таким образом переносится только **явно опубликованный** контекст, а не вся исходная история ChatGPT, вложения или hidden state другого разговора.

## 8. Удаление и сохранность

`delete_agent` требует сначала архивировать запись, затем передать строку подтверждения, точно равную ID. Удаляются сообщения с данным sender/recipient, записи `reads` для этого reader и сама запись агента. Broadcast и общие записи могут оставаться; это не «стереть все следы пользователя из всей системы» без отдельного аудита.

Перед удалением сделайте SQLite backup, если данные нужны для восстановления. В WAL режиме консистентный backup важнее простого копирования `.sqlite3` во время активных записей.

## 9. Инварианты и тесты

- В один момент не более одного активного orchestrator.
- ID уникальны, архивный ID нельзя занять заново до явного lifecycle действия.
- Агент без права получателя не должен подтверждать чужое сообщение.
- Отчёт без orchestrator отвергается.
- Замена ID сохраняет ledger и переносит unread direct messages.
- Удаление требует архивации и точного подтверждения.
- Нельзя использовать `inbox` для внутреннего `hub` как обычного агента.

Запуск: `python3 -m unittest discover -s messaging/tests -v`. Тесты покрывают логику очереди, HTTP и lifecycle, но не доказывают перенос приватной истории ChatGPT (она технически недоступна).

См. [DATA.md](DATA.md), [INTERFACES.md](INTERFACES.md), [SECURITY.md](SECURITY.md).


## MCP-08/09 — delegated HTTP and read-only AutoSend preparation (27.11.2026)

This is a **local loopback** protocol. The existing native-owner API remains protected by `X-MCPHub-Client: native` and the private `X-MCPHub-Token`. Project-scoped agents MUST NOT receive that owner token.

Owner-only routes on `127.0.0.1:8971`:

- `POST /api/work/grant`: exact JSON `{"agent":"workerA","project":"TD"}`, only for an active regular agent. Returns a randomly generated, single-use-display 256-bit `secret` (hex); it must be stored privately by the owner/client. Regrant rotates the key. It is not a ChatGPT authorization.
- `POST /api/work/revoke`: exact `agent` and `project`, disables project lease and HMAC requests.
- `POST /api/work/enqueue`: exact `project`, 64-hex `fingerprint` and allowlisted `payload` (intent `run_tests|inspect_code|audit|build`, context `McpGo`, optional bounded branch). Conflicting payload with reused fingerprint is rejected; no arbitrary commands or ChatGPT messages.
- `GET /api/work/summary`: owner-visible queue state counts.
- `GET /api/work/preview?id=<queue-uuid>`: reads the typed queue item and **only performs an authenticated GET to AutoSend `/api/status`**, never POST. Returns a fail-closed `preview.decision`, `preview.can_send=false`, `preview.mode=READ_ONLY`.

Delegated agent routes:

- `GET /api/work/pending?project=TD`: only the authorized project's queued count.
- `POST /api/work/claim`: exact JSON `{"agent":"workerA","project":"TD"}`, atomic 60-second lease of an allowlisted queue item, or `task:null`.
- `POST /api/work/ack`: exact JSON `agent,project,id,lease_token,result_fingerprint`; the state becomes **ACKED**, never VERIFIED. Independent owner-side evidence verification is intentionally NOT available through HTTP.

For each delegated request use headers `X-MCPHub-Client: delegate`, `X-MCPHub-Actor`, `X-MCPHub-Project`, `X-MCPHub-Time` (Unix seconds), `X-MCPHub-Nonce` (fresh 8–128-character token), and `X-MCPHub-Signature` (hex HMAC-SHA256 using the project's 32-byte delegated key). Sign the UTF-8 fields separated by newline: `actor, project, uppercase HTTP method, exact request path including query string, timestamp, nonce`; for POST append SHA256 hex of the **exact raw JSON request bytes** as a seventh line. GET has six lines. The server persists used nonces in SQLite and rejects duplicate, expired (outside 60 seconds), invalid, revoked, cross-project and path/body-tampered requests. Never retry a request after an unknown outcome using a new nonce without first checking durable queue state.

**Isolation:** old `/api/inbox` and `/api/history` have no per-project message labels and remain **native owner-only**. The actor token never unlocks legacy messages or role management. The authenticated queue can be inspected and leased, but it does not instantiate a ChatGPT agent, trigger AutoSend, resume paused schedules, send messages, promote ACK to VERIFIED, or perform a release. Actual delivery requires later explicit browser/owner E2E and safe receipt reconciliation. Backups and rollback are required before installing new runtime files.


## MCP-10 local role executor (27.11.2026)

The project-bound queue now includes the immutable `fingerprint` in a successful delegated `/api/work/claim` response, so a coordinator can verify the exact owner-approved local plan **before** permitting any code execution. The sender cannot add code or arbitrary shell commands to a Hub payload. Details and constraints: [execution/README.md](../execution/README.md).

The new `execution/role_engine.py` starts actual independent coder/tester/auditor OS processes in three Git worktrees, under a coordinator using atomic task and repo-metadata locks. The coder writes only bounded owner-pinned Python files and commits a branch; tester and auditor separately verify the SHA, test outcomes and Git provenance. `execution/hub_role_adapter.py` does one scoped HMAC claim and, **only after independently passing local Git/test evidence**, one scoped HMAC ACK. Hub ACKED remains distinct from owner-side VERIFIED. No AutoSend Send, ChatGPT, model CLI, remote Git push or production changes occur.

Unregistered or mismatched repositories and revoked delegated grants report `NEED_OWNER` without attempting to bypass permissions. A missing reply/ambiguous claim or ACK is `UNKNOWN` and is not automatically repeated. This is a local owner-trusted executable workflow, **not an OS security sandbox or an LLM-autonomous agent**. No live TD or Museum repository has been granted by the MCP-10 fixture tests.

# AutoSend v2 — протокол, эксплуатация и диагностика

Архитектурное решение: [ADR-001](adr/001-autosend-extension-only.md). Источник истины: `autosend/server.mjs`, `autosend/delivery.mjs`, `autosend/browser-client.mjs`, `autosend/core.mjs`.

## Транспорт и владение вкладкой

AutoSend использует **выделенный MCP backend Playwright Extension**: `localhost:8932/mcp`, имя клиента `MCPGO AutoSend`; в Windows та же схема. Общий Browser MCP на `8931/8940` — другой клиент расширения. Ни CDP endpoint, ни самописное Native Messaging расширение не поддерживаются.

Группа AutoSend создаётся/одобряется официальным Playwright Extension при первом подключении. Пользователь должен выбрать уже открытую вкладку разговора. Если в группе она отсутствует, AutoSend ждёт: никакого `browser_tabs(new)`. Две подходящие вкладки запрещают отправку. Нельзя выбирать «первую попавшуюся» по заголовку или переиспользовать индекс после обновления списка.

URL сверяется по каноническому ключу разговора: `project:<project-id>:<conversation-uuid>` либо `direct:<conversation-uuid>`. Читаемый суффикс проекта не влияет на совпадение, но иной project ID, chat UUID, host или query/hash не принимаются. Внутри страницы последний guard повторно проверяет ключ, черновик, кнопку, число user-bubbles и поток.

Пассивный health проверяет только локальный TCP порт backend, **не вызывает** browser_tabs и не создаёт Chrome connection. «Проверить без отправки» — отдельный ручной read-only вызов, который проверяет группу и DOM; он никогда не записывает/отправляет сообщение.

## Диагностика подключения в `GET /api/status`

Начиная с `preview.14` API дополнительно возвращает `browserBackendReachable` (`boolean`). Это **пассивная** проверка доступности локального Playwright MCP backend на `127.0.0.1:8932`; `true` не подтверждает, что Chrome, расширение или конкретная вкладка доступны.

В каждой записи `tasks[]` поле `browserConfirmed` (`boolean`) означает, что **именно для данного задания** в текущей сессии AutoSend получено подтверждение выбранной вкладки. Значение `false` означает отсутствие свежего подтверждения, а не доказанный разрыв соединения с Chrome. Подтверждение занятости/завершённости генерации ChatGPT проводится отдельно перед Send.

Существующий `extensionConnected` оставлен без изменения для старых клиентов: он равен `browserBackendReachable && есть_хотя_бы_одна_подтверждённая_вкладка`. Это агрегатный флаг; его нельзя использовать для вывода о конкретном разговоре. Интерфейс различает «backend недоступен», «backend доступен, вкладка не подтверждена» и «вкладка подтверждена». Если новый флаг отсутствует после частичного обновления, интерфейс показывает неопределённое состояние, не рисует ложный зелёный статус и не инициирует Send.

## Состояния и гарантии

1. Запуск слота `scheduled → checking`, затем один из `deferred/busy` (без клика), `verifying` (клик мог быть выполнен), `verified` (новая пользовательская реплика доказана) или `unknown` (результат недоказуем).
2. До Send: два устойчивых снимка, проверка stream/Stop/редактора, отсутствие пользовательского черновика и совпадение разговора. Сервер `IS_STREAMING` означает busy; неизвестный статус означает unknown. Не отправлять при разногласии сигналов.
3. Атомарная запись `click-committed` с `slot-id` и `action-id` происходит **перед** единственным browser_evaluate, содержащим guard+Send. Если транспорт оборвался, клик **не** повторяется.
4. Подтверждение доставки — новая пользовательская реплика с точным текстом и независимыми признаками вставки; простой текст в `main`, цитата ассистента или очищенный редактор не являются достаточным доказательством.
5. После неопределённого клика выполняется **только чтение** для reconciler. Если доказательство не появилось за ограниченное окно, `unknown` требует ручной проверки.
6. Повторяющиеся расписания используют durable ledger слотов; один неопределённый слот нельзя исполнить повторно. Другие разговоры продолжают работать независимо, одна вкладка разговора не может одновременно обслуживать два задания.
7. Обычный интервал соблюдается буквально. Монитор умного продолжения наблюдает только расписания `after_response` и не вызывает Send до нового подтверждения ready. Автоматической перезагрузки страницы/ChatGPT нет.

Важно: ChatGPT не документирует публичный статус завершённости генерации для этой задачи. `stream_status` — неофициальный best-effort сигнал. Если его нет, действуем консервативно: `UNKNOWN`, а не предполагаемый idle. Возможны пропуски, но не автоматический повтор отправки.

## Упрощённое создание задания · MCP-02 (preview.15)

Обычная форма Windows: **название проекта (только метка карточки) → ссылка на существующий чат → создать выключенным**. Текст сообщения и старые интервалы/смещения доступны в «Дополнительно». Имя проекта не даёт прав доступа к Git, GitHub, TD или Museum и само по себе не включает специальный Smart V2.

Для новой формы `POST /api/tasks` с `action:create` передаёт `project_label`, `guided_first_run:true`, `schedule_mode:after_response` (или `interval` в дополнительных настройках). Сервер валидирует URL, название и режим, сохраняет задачу с `enabled:false,status:paused` и не выполняет Send. Для новых guided задач повторное создание того же канонического чата отклоняется. Ранее сохранённые задания и режимы не преобразуются.

**Первый запуск** — явное нажатие «Запустить» у новой карточки. `action:start_first` сначала делает read-only проверку **точной выбранной вкладки** через официальный Playwright Extension, отказывает при занятом/неподтверждённом чате или конкурирующем задании и лишь затем атомарно сохраняет `first_cycle_started_at`, `manual_once:true` и due slot. Ответ `queued:true` **не доказывает доставку**; фактический Send и квитанция остаются в старом проверенном планировщике. Повторный клик возвращает `alreadyStarted:true` без новой очереди. При перезапуске `markUnknownOnBoot` не переотправляет незавершённый manual-first-run автоматически и не теряет сохранённый `first_cycle_started_at`. Событийный режим обычного чата отслеживает готовность ответа, но не гарантирует проверку изменения файлов — для этого требуется отдельный адаптер доказательств (MCP-05).

**Граница приёмки:** isolated real HTTP и UI VM tests позволяют доказать сохранность и отсутствие Send без вкладки; подтверждение первой реальной доставки допускается только на специально выделенном тестовом чате с явным разрешением пользователя. TD и Museum в процессе разработки MCP-02 не включать.

## Хранилище и миграция

Сохранение существующих данных: `~/Library/Application Support/McpGo/AutoSend/tasks.json` (Windows: в каталоге данных McpGo). AES-256-GCM для сообщений, owner-only `message-key`, `control-token`, атомарная запись + fsync. Новый AutoSend читает действующие задачи без смены версии JSON. При запуске восстанавливает незавершённые click receipts в `verifying/unknown`, сбрасывает устаревшие поля watchdog, **не** отправляет пропущенное вручную сообщение из прошлого слота.

Переход **не** удаляет историю, slot ledger, сохранённые тексты, расписания или ключи. Перезапуск сервиса безопасен для сохранённого состояния, но расписание нужно проверять только после привязки его вкладки к группе AutoSend.

## Эксплуатация

- Проверить локальные службы Mac: `launchctl list | grep mcphub.autosend`; backend — `com.mcphub.autosend.browser` (8932), планировщик — `com.mcphub.autosend` (8972).
- На Windows приложение запускает отдельную `autosendBrowser` службу и `autosend`, использует те же порты.
- Нет выбранной вкладки: `CHAT_TAB_MISSING`; откройте разговор и выберите в Playwright Extension.
- Несколько одинаковых вкладок в группе: `AMBIGUOUS_CHAT_TABS`; оставьте одну.
- Истёк таймаут расширения: `BROWSER_OBSERVATION_TIMEOUT`; нет отправки, следующая плановая проверка.
- Ненадёжное состояние ChatGPT: `STREAM_STATUS_UNKNOWN`/другая причина в журнале; не навязывать повтор Send.
- Неизвестен исход клика: `verifying`/ `unknown`; проверить чат вручную, а не увеличивать частоту.

Для локального тестирования:

```sh
node --test autosend/tests/*.test.mjs playwright/tests/*.test.mjs
```

Unit/integration тесты не выполняют real Send в рабочем разговоре. Для live-E2E требуется специально выделенный тестовый чат и явное разрешение.


## MCP-11 · Смена чата через owner-approved handoff (27.11.2026)

AutoSend now supports the **owner-token-only** `POST /api/tasks`, action `handoff_chat`. This is a safe paused state transfer, **never a ChatGPT Send or verified browser delivery**. Do not call it against real projects until the owner has approved the exact new chat URL and all pending receipts are reconciled.

Example request schema (replace ALL values with owner-supplied real ones):
```json
{
  "action": "handoff_chat",
  "source_id": "existing-task-id",
  "target_url": "https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002",
  "owner_confirmed_target": "https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002",
  "idempotency_key": "e99f2c39-2222-4222-8222-222222222222",
  "checkpoint": {
    "task_id": "MCP-11",
    "branch": "work/mcp11-branch",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "evidence_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "receipt_id": "receipt-123",
    "last_ack_id": "ack-456",
    "summary": "Owner-approved brief checkpoint and evidence locations"
  }
}
```
The owner must explicitly approve the canonical new conversation URL, including its **same ChatGPT project scope**. The source must already be paused and contain no in-flight/unknown click, active slot, pending Smart V2 work or unknown ledger entry; browser worker must be idle. If any gate is uncertain, handoff is denied.

The existing encrypted `tasks.json` is atomically rewritten once: source kept in archived state with ALL original delivery receipts and history, successor created with distinct ID and paused/disabled state, bound idempotency key and checkpoint fingerprint. Original messages and checkpoint notes are only present in the **AES-256-GCM encrypted message field** (not copied into a plaintext journal). The new task's instruction explicitly marks owner-provided Git/evidence/ACK references as **not independently verified**. It inherits only validated schedule configuration, **not** Smart V2 pending work, browser tab approval, active slot, send count, or any previous dispatch authorization.

An identical POST after lost HTTP response/restart returns `ALREADY_STAGED`, not another task. A reused key with different context/URL or target already scheduled fails. Archived chat is excluded from active task cards and `dueTasks`; even a corrupted enabled archived record is ineligible for Send, and `start`/mutations reject it. Neither source nor successor is auto-started.

**Durable cross-service coordinator:** `autosend/handoff-coordinator.mjs` exports `coordinateChatHandoff(journalDir,intent,{autoPort,hubPort,autoToken,hubToken})` and `reconcileChatHandoff(journalDir,key,clients)` for a **separately owner-invoked** two-service handoff. This calls the existing AutoSend owner-only HTTP `handoff_chat` and then Messaging Hub owner-only `/api/agents/replace` exactly once per intent, with a pre-claimed durable journal (private file, no URL/message/secret), strong request fingerprint, and no autonomous Send. Hub's replacement transaction copies unread messages to the new agent and archives the old. If a response is lost, coordinator returns `UNKNOWN` and **does not retry POST**. Read-only recovery GETs independently inspect the exact new chat URL, archived predecessor, successor registration, and paused AutoSend replacement; inconsistent state returns `NEED_OWNER`.

**Residual gate:** the two state stores (SQLite Hub and encrypted JSON AutoSend) cannot commit in one distributed transaction, so the first state change can succeed while the second is `NEED_OWNER`/ `UNKNOWN`. Both chat schedules stay paused, no Send happens, and the journal preserves evidence for manual reconciliation. Tests exercise a fixture HTTP Hub with unread-message forwarding and independent real Hub lifecycle tests; a real owner-approved two-chat browser E2E and native owner UI are still pending. This is **SOURCE_VERIFIED**, not an accepted full production chat migration.


### Explicitly unlocking the successor after real owner verification

The successor is initially `handoff_requires_owner_reconfigure=true`. `arm`, `send_once` and `dueTasks` all reject this pending state (including an incorrectly re-enabled disk record); `start` cannot bypass the restriction. After the coordinator confirms **COMPLETE** and the owner has independently inspected the **specific new ChatGPT tab** through the read-only `preview` action, the native owner can call `POST /api/tasks` with `action="unlock_handoff"`, exact `id`, `owner_confirmed_target`, `checkpoint_sha256`, `owner_confirmed_hub=true`, and `owner_confirmed_browser=true`. The backend also requires a live approved tab lease for the successor; owner assertions alone cannot bypass this check. Unlock merely clears the gate **and leaves the new schedule paused**. A separate explicit Start is still required. Without connected Chrome, unlocking cannot pass, by design.

The full fixture E2E now uses **real Python Messaging Hub HTTP + real Node AutoSend HTTP** in isolated temporary databases, verifying that one previously read message is *not* copied while two unread messages reach the new agent exactly once, old agent gets archived, and the new schedule remains paused. In contrast, the independent coordinator fault-injection fixtures use a simulated Hub to test ambiguous replies, lost receipts, cross-service recovery, and owner/URL mismatch refusal. **Real production/browser migration still NOT_RUN**; MCP-11 cannot be fully closed without an owner-approved test pair and working Chrome extension.

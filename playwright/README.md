# McpGo PlaywrightHub

## Рабочая архитектура

PlaywrightHub работает с **обычным Chrome пользователя**. По умолчанию остаётся CDP-режим (обратная совместимость). Опционально можно переключиться на **официальное Playwright Extension с заранее выданным токеном**: тогда подтверждать каждое новое подключение не нужно, вкладки ИИ группируются в «MCPGO», а Playwright работает с флагом фонового режима. Это **не Browse** и не отдельный профиль.

```text
ChatGPT → browser Secure MCP Tunnel → Safe Proxy :8940/mcp
                                         → Playwright backend :8931/mcp
                                         → Chrome CDP (по умолчанию) / Playwright Extension
McpGo AutoSend :8972 ───────────────────┘
```

## Исполняемые файлы

- `start.sh` и `launchers/browser.mjs`: единая конфигурация Playwright backend на localhost 8931; CDP или Playwright Extension по выбранному режиму.
- `restricted-proxy.mjs`: localhost 8940, единая upstream MCP session, фильтрация `browser_run_code_unsafe`, синхронизация индексов вкладок.
- `start-tunnel.sh`: проверка proxy, запуск tunnel-client на `http://127.0.0.1:8940/mcp`.
- `configure-tunnel.sh`: интерактивная настройка выделенного Browser Tunnel ID.
- `configure-extension.sh`: однократная локальная запись токена в приватный файл (не в Git, URL или аргументы процесса); переключение между Extension и CDP. Скрипты вычисляют расположение текущего модуля по своему пути и не зависят от Git checkout другого проекта.
- `probe.mjs`, `smoke.mjs`, `test-access.mjs`: проверочные сценарии.
- `package.json`, `package-lock.json`: Node пакет и закреплённая версия @playwright/mcp.

## Как убрать повторные запросы разрешения

1. Установить официальное **Playwright Extension** (Chrome/Edge) версии **0.5.0+** в собственный Chrome-профиль; отдельный Browse не нужен.
2. Открыть расширение → **Manage clients** и скопировать `PLAYWRIGHT_MCP_EXTENSION_TOKEN`.
3. В интерактивном терминале выполнить из корня McpGo: `bash playwright/configure-extension.sh` и вставить токен на скрытый запрос. Токен сохраняется с правами 0600 по пути `~/Library/Application Support/McpGo/playwright/extension-token`; режим — в `browser-mode`.
4. Обновить **сам установленный McpGo Dev Runtime** вместе с `launchers/browser.mjs` и версией `@playwright/mcp 0.0.85`. Только `npm ci` в исходном Git checkout недостаточно: запущенный LaunchAgent использует `~/Library/Application Support/McpGo/Runtime`. После обновления Runtime **перезапустить только backend Playwright и, при необходимости, его safe proxy**. До обновления оставьте старый backend работающим.
5. Для **локальной пробы без затрагивания текущего браузерного backend :8931** запустить `bash playwright/try-extension.sh` из корня проекта. Он поднимет временный Playwright на :8999, проверит MCP initialize, tools/list и browser_tabs list, затем остановится.
6. После обновления установленного Runtime через ChatGPT вызвать `browser_tabs({action:"list"})` несколько раз, включая новое MCP подключение. Запрос выбора вкладок не должен повторяться. Все действия проходят через safe proxy :8940, не raw backend :8931.

Extension mode запускается с `--extension --background`, создаёт группу вкладок **MCPGO** (фиолетовую), не использует `--no-tab-group`. С токеном первая сессия получает пустую управляемую вкладку: доступ к старым вкладкам пользователя **не выдаётся автоматически**, их можно вручную переместить в группу при необходимости. Chrome 158+ нужен, чтобы и **служебная вкладка подключения** не вытесняла активное окно; на Chrome 157 фоновые действия возможны, но служебная вкладка ещё может переключить фокус.

Официальное расширение поддерживает `--profile-dir-name`: по умолчанию берётся последний активный профиль с расширением. Для фиксированного профиля установите `MCPGO_CHROME_PROFILE_DIR=Default` (или имя папки из `chrome://version`). При ошибке подключения вернитесь к CDP: `bash playwright/configure-extension.sh --cdp`, затем перезапустите backend. Этот переключатель не удаляет токен; для отзыва доступа токен следует сменить в расширении и удалить приватный файл.

**CDP-режим (резервный):** в обычном Chrome открыть `chrome://inspect/#remote-debugging` и вручную разрешить отладку. Запрос Chrome разрешить CDP нельзя отключить штатным флагом; токен относится только к официальному Playwright Extension.

## Проверки

- Действующие LaunchAgents browser/proxy/tunnel должны ссылаться на текущий McpGo Runtime.
- В ChatGPT использовать только **PlaywrightHub** через безопасный proxy; `AutoSend` тоже использует :8940, поэтому общий агентный набор вкладок может влиять на него. Проверьте AutoSend отдельно.
- `node --test playwright/tests/*.test.mjs` и `npm ci` проверяют настройки/зависимости, но **не заменяют** E2E с реальным Chrome.

## Семантика сессий и вкладок

В CDP-режиме backend работает в shared browser context. В Extension режиме backend использует группу вкладок, принадлежащих MCP-сессии; Safe Proxy по-прежнему разделяется клиентами. Safe proxy объединяет короткие внешние MCP-сеансы на одной backend-сессии, чтобы Chrome не просил разрешение отладки при каждом вызове. Таблица индексов вкладок может быть переинициализирована между запросами, поэтому proxy прогревает `browser_tabs list` перед select/close. Индекс — временная позиция, а не долговременный ID разговора.

## Неполадки

- Невозможно подключиться: проверьте running Chrome, разрешение CDP, порт 8931, затем 8940 и browser tunnel.
- Частые запросы разрешения: для CDP проверьте shared-session proxy; для Extension проверьте токен, выбранный профиль и версию расширения 0.5.0+.
- Пустой список вкладок: убедитесь, что подключены к правильному личному Chrome, а не другому профилю/приложению.
- Если работает 8931, но ChatGPT не видит инструмент: проверьте proxy и туннель, затем workspace association.

Дополнительно: [архитектура](../docs/ARCHITECTURE.md), [API](../docs/INTERFACES.md), [операции](../docs/OPERATIONS.md), [AutoSend](../docs/AUTOSEND.md).

### Stable Chrome group

In Extension mode, McpGo uses a shared, persistent browser connection across transient MCP clients. Background Dashboard and AutoSend status checks never call browser tools, so they cannot repeatedly create connect.html pages. One new connection may still be required after an explicit backend or Chrome restart; no user tabs are deleted or regrouped by this change.

### Browser Session Manager (safe proxy)

`browser-session-manager.mjs` owns a redacted, passive connection state and a bounded cooldown (only after a proven extension disconnect). `restricted-proxy.mjs` always sends the upstream client name `MCPGO`; its persistent shared MCP session survives downstream client DELETE. Session telemetry is available at `GET /healthz` on the loopback proxy and via the read-only MCP tool `mcpgo_browser_status`. A health check never opens a Chrome page.

`chrome-profile.mjs` selects the only Chrome profile with the official extension installed, unless the user pinned `chrome-profile` explicitly; ambiguous profiles remain unselected. `tab-lease-manager.mjs` provides optional 10-minute agent leases over MCP tab indices, which expire/reset on session change. Lease protection is cooperative and enabled by `x-mcpgo-agent-id`, not an authentication boundary. Concurrent browser operations remain serialized, with URL checks and durable action receipts retained.

The fork-like monkey-patches for Playwright group title and shared browser lifetime are gone. We retain only the explicit upstream compatibility workaround for stalled per-tab metadata (`patch-playwright.mjs`), until that bug is fixed upstream.

### Automatic agent isolation across macOS and Windows

Portable modules `agent-scope.mjs`, `portable-tab-identity.mjs`, and `portable-agent-tabs.mjs` implement automatic per-transport MCP agent scopes, optional stable per-conversation scopes (`x-mcpgo-conversation-id`), cooperative tab leases and guarded `mcpgo_tab_handle`/`mcpgo_tab_action` tools. AutoSend sends a stable digest of the conversation URL, never the raw URL. The shared Chrome extension connection and visual MCPGO group do not multiply. Each scoped agent returns to its own tab before acting.

Tab handles are opaque URL-fingerprint mappings, **not Chrome native tab IDs**: duplicate URLs or unverified navigation fail closed, and a chat whose MCP transport is replaced without a stable conversation identifier cannot automatically retain its previous agent identity. New blank tabs use an inert, CSP-restricted local proxy page with a unique UUID instead of ambiguous about:blank pages. The same code ships for Windows; Windows Chrome/Edge E2E remains a separate verification step.

### Workspace ID handoff to ChatGPT (macOS and Windows)

Each browser MCP `tools/call` success result carries the same high-entropy
`workspace_id` twice: in MCP `result.structuredContent.workspace_id` and a
short final text item (`### McpGo browser workspace`). The latter makes the
handle visible even to clients that ignore structured content. Tools/list
adds an **optional** `workspace_id` parameter to browser tools; the proxy
removes it before forwarding to Playwright. The model should send that ID
back on subsequent browser calls, especially after a new MCP `initialize`.
It is repeated on every successful tool result to make accidental loss from
chat context less likely, though a model is not guaranteed to pass it back.

`mcpgo_workspace` is a read-only, Chrome-independent status/resume tool:
`{ "workspace_id": "ws_<prior ID>" }` explicitly recovers the existing
agent's tab leases and active tab after a transport reconnect. While an MCP
transport session is alive, McpGo associates tools with the same workspace
*without* requiring the model to repeat the ID. Stable AutoSend conversation
headers remain authoritative and cannot be switched using model arguments.
New, occupied sessions cannot switch to another workspace; unrecognized or
expired IDs fail closed. An unrelated new session without the ID starts an
isolated workspace and never guesses its owner's identity.

Security: a `workspace_id` is an **unguessable recovery reference within this
single trusted McpGo installation**, not proof of who the ChatGPT user is or
an OAuth credential. The pre-existing authorized MCP/tunnel connection and
local-only proxy remain the security boundary. Explicit ID possession can
re-bind an *unoccupied new transport session* from that same installation.
Do not share IDs with third parties or paste them into web pages. No handles
are persisted in logs, page content, browser history, or to disk. Handles
are held in proxy memory, expire after 24 hours idle and cannot survive
restarting the local proxy; the tabs themselves are never deleted when a
workspace expires. Native, non-ambiguous Chrome tab IDs are not available
from the public Playwright MCP tab-list API.

### MCP 2026-07-28 and verified ChatGPT compatibility

The external browser proxy supports MCP 2026-07-28 (`server/discover`,
`tools/list`, `tools/call`), validates `Mcp-Protocol-Version`, `Mcp-Method`,
`Mcp-Name` and per-request client capabilities, and returns `resultType:complete`
with server metadata. A real call from the existing McpGo ChatGPT Browser
plugin **still sent the older wire protocol** and failed when the endpoint
was strictly 2026-only. Therefore the same proxy temporarily negotiates
legacy ChatGPT requests as well. Use `MCPGO_DISABLE_LEGACY=1` ONLY when a
real ChatGPT plugin has been verified on 2026-07-28. Existing clients keep
their external MCP sessions while new clients need no session IDs. The private
Playwright backend keeps one shared 2025 MCP session and one Chrome connection.
The modern proxy strips `_meta` and `workspace_id` before forwarding to that
backend. With trusted anonymized `openai/session` metadata, each chat gets a
stable browser scope; otherwise the model must call `mcpgo_workspace` first
and reuse its `workspace_id` on subsequent calls. Modern clients can coexist
with the older plugin during migration.

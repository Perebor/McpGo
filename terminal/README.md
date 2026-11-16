# ChatTerminalHub — терминальный модуль McpGo

## Назначение

Поддерживает macOS и Windows. **Один локальный HTTP/MCP-процесс**
`terminal/stateless_server.js` на `127.0.0.1:12848` предоставляет OneShot,
длительные Jobs, интерактивные PTY-сессии и локальную панель управления.
`terminal/interactive_runtime.cjs` — модуль внутри того же процесса, не сервер.
Внешнее подключение — один Terminal Secure MCP Tunnel к приватному `/exec/<secret>`.

## OneShot

`terminal_exec({command,cwd?,timeout_ms?,request_id?,resource_key?})` запускает команду как долговечный фоновый Job. Если команда завершилась за 12 секунд, возвращается результат; иначе процесс не останавливается, а возвращаются `promoted_to_job:true`, `job_id` и `result_ready:false`. Дальше используйте `job_status` / `job_result` / `job_logs`. После обрыва проверяйте `mcpgo_recover`, не повторяйте операцию вслепую. `timeout_ms` ограничивает время самой команды (по умолчанию 20 минут, максимум 4 часа), а не ожидание MCP. Ожидание MCP — до 12 секунд; для тестов значение настраивается через `MCPGO_TERMINAL_SYNC_WAIT_MS` (100–15000 мс). Одинаково работает на macOS и Windows.

## Длительные jobs

`job_start({command,cwd?,timeout_ms?})`: detached runner, максимальная длительность 4 часа (14 400 000 мс), значение по умолчанию 20 минут, абсолютный cwd; возвращает случайный job_id и начальную очередь, а не итог.

`job_status({job_id})`: окончательное состояние процесса, включая `state`, `exit_code`, `timed_out`, `spawn_error` и диагностические поля. `unknown` возможен после потери runner/process receipt.

`job_logs({job_id,tail_lines?,max_chars?})`: ограниченный хвост stdout/stderr. По умолчанию 40 строк и 4000 символов на поток; допустимы 1–200 строк и 100–12000 символов. Это инструмент диагностики, не гарантия полного лог-архива.

Проверка PASS требует `state=exited`, `exit_code=0`, `timed_out=false` и отсутствия spawn_error.

## Интерактивный терминал

Инструменты `terminal_create`, `terminal_send`, `terminal_read`,
`terminal_interrupt`, `terminal_close` доступны в том же MCP-подключении,
что и `terminal_exec`. Они используют независимые session_id/session_key
и PTY (macOS zsh / Windows ConPTY) без отдельных HTTP-мостов.
Локальная панель доступна на `http://127.0.0.1:12848/` и защищена ключом администратора.

## LaunchAgents и tunnel

| Служба | Задача |
|---|---|
| `com.chatterminalhub.oneshot` | Единый Terminal MCP, Jobs, PTY, локальная панель 12848 |
| `com.chatterminalhub.tunnel` | Secure MCP tunnel |

Активный wrapper туннеля находится в `~/Library/Application Support/ChatTerminalHub/run-tunnel.sh` (owner-only), а шаблон в `launchagents/com.chatterminalhub.tunnel.plist`. Dashboard McpGo умеет исправлять существующие plist, ранее указывавшие на Desktop. При изменении активного plist может потребоваться `bootout` и `bootstrap`.

## Операционный сценарий

1. Прочитать `GET /health` единого Terminal MCP на 12848.
2. Проверить `launchctl list` и `launchctl print` для tunnel.
3. В подключённом MCP-клиенте выполнить безопасную команду `terminal_exec`.
4. Для длительных операций использовать `job_start → job_status → job_logs`; не повторять потенциально неидемпотентную операцию при неизвестном исходе.

## Ограничения

Команды выполняются с правами владельца процесса. Отдельной песочницы всего Mac этот модуль не создаёт. Для опасных операций нужен контроль полномочий MCP-клиента, разрешение владельца и осмысленная проверка окружения. Продукт не должен вмешиваться в процессы других приложений без прямого запроса.

Дополнительно: [архитектура](../docs/ARCHITECTURE.md), [контракты](../docs/INTERFACES.md), [эксплуатация](../docs/OPERATIONS.md), [безопасность](../docs/SECURITY.md).

### MCP 2026-07-28 external Terminal endpoint

`stateless_server.js` on its existing private random MCP path implements
MCP 2026-07-28 via `server/discover`, `tools/list`, `tools/call`, per-request
capabilities and routing headers, and `resultType:complete` server metadata.
Existing ChatGPT Terminal connections may still send 2025 `initialize`;
that is temporarily accepted while migrating the real plugin. Set
`MCPGO_DISABLE_LEGACY=1` after an actual verified 2026 plugin handshake.
The durable job engine, idempotency, resource locks, interactive terminal
operations, and recovery IDs remain unchanged. `interactive_runtime.cjs` handles interactive sessions and the local UI
inside the same Terminal MCP process; no extra HTTP listener is needed.

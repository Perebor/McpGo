# McpGo PlaywrightHub

## Текущая архитектура (только Playwright Extension)

McpGo использует **официальное Playwright Extension** для Chrome/Edge. Старый CDP/Remote Debugging **удалён**: конфигурация и скрипты запуска не поддерживают `--cdp-endpoint` и `chrome://inspect`.

```text
ChatGPT → Browser Secure MCP Tunnel → Safe Proxy :8940/mcp → Browser MCP :8931/mcp
                                                                ↕
                                              Playwright Extension → Chrome
McpGo AutoSend :8972 → отдельный Browser MCP :8932/mcp ↔ Playwright Extension
```

Два Browser MCP используют отдельные управляемые группы вкладок `MCPGO` и `MCPGO AutoSend`. AutoSend не открывает отсутствующие вкладки, не выбирает произвольную совпадающую и не повторяет Send при неопределённом результате. Подробности: [BROWSER](../docs/BROWSER.md), [AUTOSEND](../docs/AUTOSEND.md), [ADR-001](../docs/adr/001-autosend-extension-only.md).

## Первый запуск

1. Открой мастер McpGo → «Личный Chrome» и нажми **«Установить Playwright Extension»**. Это открывает [официальное расширение в Chrome Web Store](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm). Установи его в профиль Chrome и подтверди разрешения; установка происходит **только с согласия пользователя**, не скрытно через McpGo.
2. Открой значок расширения → **Manage clients** → скопируй `PLAYWRIGHT_MCP_EXTENSION_TOKEN`.
3. Вставь токен в **защищённое поле мастера** и нажми «Проверить и включить фоновый режим». Проверка выполняется на отдельном порту `8999` до переключения рабочего backend. Если проверка не удалась, прежние настройки восстанавливаются. Токен хранится только на компьютере пользователя, с правами `0600`, никогда не попадает в аргументы команд или логи.
4. Запусти Browser MCP и туннель через McpGo. В ChatGPT проверь `browser_tabs({action:"list"})` и разреши доступ к нужной вкладке. Для AutoSend выдели вкладку в отдельной группе и используй «Проверить без отправки».

**Резервный CLI:** из корня проекта запусти `bash playwright/configure-extension.sh` в интерактивном терминале. Он безопасно создаст `~/Library/Application Support/McpGo/playwright/extension-token` и `browser-mode`, но сам **не проверяет** подключение и **не перезапускает** Browser MCP. Лучше использовать GUI-мастер, который делает проверки и переключение с откатом.

Официальный backend запускается с `--extension --background`; токен читается из приватного файла/Windows encrypted storage. Chrome 158+ рекомендуется для минимизации переключения фокуса при фоновом подключении. При нескольких профилях можно выбрать `MCPGO_CHROME_PROFILE_DIR` или файл `chrome-profile` в защищённых настройках.

## Исходники и диагностика

- `start.sh` и `launchers/browser.mjs` — общий запуск Browser MCP `8931` или AutoSend `8932` в режиме Extension-only.
- `restricted-proxy.mjs` — безопасный MCP-прокси `8940`, сериализация изменяющих действий, восстановление сессий и защита от повторов.
- `configure-extension.sh` — ручная запись токена, проверка формата и символических ссылок, атомарная запись обоих приватных файлов.
- `try-extension.sh` — диагностический временный экземпляр на `8999` без вмешательства в основной `8931`.
- `patch-playwright.mjs` — закреплённые патчи совместимости версии `@playwright/mcp` после установки зависимостей.

Если `EADDRINUSE` на `8931`, сначала выясни владельца PID с `lsof -nP -iTCP:8931 -sTCP:LISTEN`. Старый CDP/LaunchAgent может удерживать порт: **не убивай произвольные процессы**, используй штатную проверку владения в McpGo и перезапуск только своего Browser MCP. Если backend слушает, но вкладки недоступны — проверь версию/профиль Chrome, расширение, токен, разрешения вкладок, `8932` для AutoSend, `8940` для proxy и туннель. Запущенный порт ещё не гарантирует успешный вызов инструментов из ChatGPT.

Тесты: `node --test playwright/tests/*.test.mjs`, `python3 -m unittest tests.test_browser_extension_setup tests.test_configure_extension_script`, плюс реальная проверка инструментов с разрешения пользователя.

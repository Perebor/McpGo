# Быстрый старт и первая настройка McpGo

## Новый мастер первого запуска

Откройте McpGo.app или дважды нажмите «Запустить McpGo.command».
Вкладка «Первое подключение» проведёт через проверки, управление
OpenAI Secure MCP Tunnel, Chrome и подключение ChatGPT.
Все устанавливающие действия требуют явного подтверждения.
Restricted runtime key сохраняется в Keychain, административный — нет.
При другой установленной копии автоматическая перезапись заблокирована.

Полный runbook: [ONBOARDING.md](ONBOARDING.md).

## Поддерживаемая среда

- **macOS 14+ на Apple Silicon:** готовый подписанный DMG доступен в [GitHub Releases](https://github.com/mcpgo1/McpGo/releases). Для установки не нужны Xcode, Git, Node.js или Python: runtime уже включён в дистрибутив.
- **Windows 11 x64:** отдельный [неподписанный preview](https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2). Устанавливайте из официального GitHub Release, учитывайте предупреждения SmartScreen; не обходите политики безопасности.
- **Браузер (необязательно):** Chrome/Edge с официальным **Playwright Extension 0.5.0+**. CDP/remote debugging и отдельный браузерный профиль не требуются.
- Для удалённого управления нужны доступный пользователю ChatGPT с поддержкой custom MCP и **два Secure MCP Tunnels** OpenAI.
- При сборке *из исходников* потребуются macOS SDK/Swift, Node.js, Python и другие инструменты, перечисленные в [документации разработчика](DEVELOPMENT.md).

## Установка и обновление без потери доступа

1. На Mac откройте DMG и перетащите **McpGo.app** в «Программы». Для обновления замените уже установленное приложение. На Windows запустите новый preview-установщик из той же учётной записи.
2. При обновлении не удаляйте **Application Support/McpGo**, Keychain, пользовательские настройки или данные браузера. Tunnel ID, ключи и существующие подключения ChatGPT сохраняются при обычной замене приложения.
3. На macOS подписанный runtime устанавливается/обновляется в `~/Library/Application Support/McpGo/Runtime`; при обновлении используется staging и сохранение предыдущей версии для отката. В Windows настройки и зашифрованные ключи живут в Electron `userData`, отдельно от исполняемых файлов.
4. Полная очистка данных, новый пользователь ОС и перенос на другой компьютер — отдельные сценарии: секреты могут потребовать явного переноса или перевыпуска. Мастер первого подключения не должен автоматически пересоздавать существующие туннели.

## Запуск приложения

Откройте `McpGo.app` или `Открыть McpGo.command`. В разделе «Обзор» проверьте службы Terminal MCP, Browser MCP и Secure MCP Tunnels. Служба Dashboard автоматически обслуживает `http://127.0.0.1:8969`; статусы обновляются из локального API.

Терминальные LaunchAgents:
- `com.chatterminalhub.oneshot` — единый Terminal MCP, Jobs и PTY;
- `com.chatterminalhub.tunnel` — внешний Secure MCP Tunnel.

Браузерные LaunchAgents:
- `com.mcphub.playwright.browser` — backend 8931;
- `com.mcphub.playwright.proxy` — safe proxy 8940;
- `com.mcphub.playwright.tunnel` — внешний Secure MCP Tunnel.

Дополнительные службы: `com.mcphub.dashboard` (8969), `com.mcphub.messaging` (8971), `com.mcphub.autosend` (8972).

## Playwright Extension (вместо CDP)

1. Откройте **обычный Chrome** и установите [официальное Playwright Extension из Chrome Web Store](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) версии 0.5.0 или новее.
2. В панели Chrome откройте значок расширения и скопируйте `PLAYWRIGHT_MCP_EXTENSION_TOKEN` из его интерфейса. Не публикуйте токен в переписках или логах.
3. В McpGo → «Первое подключение» → «Личный Chrome» (или в блоке «Подключение MCP» для Windows) нажмите «Установить Playwright Extension», если расширения нет, затем вставьте токен в защищённое поле, нажмите «Проверить и включить фоновый режим». Мастер сначала подтвердит доступ, затем сохранит настройку локально.
4. Запустите Browser MCP и соответствующий Secure MCP Tunnel. Подключите PlaywrightHub в ChatGPT и выполните безопасный `browser_tabs({action:"list"})`.
5. Для AutoSend используется отдельная группа вкладок `MCPGO AutoSend`. Перед отправкой по расписанию выполните «Проверить без отправки» и убедитесь, что выбрана ровно одна нужная вкладка.

Remote debugging, `chrome://inspect` и CDP не требуются. Пользовательские разрешения Chrome и Playwright Extension обходить нельзя. Подробнее см. [BROWSER.md](BROWSER.md).

## Настройка Secure MCP tunnels

Для каждого из двух контуров:
1. Создайте или выберите отдельный Secure MCP Tunnel в соответствующей организации OpenAI и свяжите его с нужным workspace.
2. Задайте Tunnel ID и runtime key через вкладку «Настройки туннелей».
3. Проверьте профиль tunnel-client и локальный адрес endpoint: браузерный tunnel направляется на **`http://127.0.0.1:8940/mcp`**, не на 8931.
4. Проверьте подключение вызовом реального MCP-инструмента из ChatGPT, а не только зелёным статусом процесса.

Существующая установка использует macOS Keychain/локальные настройки и сохраняет идентификаторы совместимости. Подробные текущие пути — [CONFIGURATION.md](CONFIGURATION.md).

## Проверка готовности

```bash
launchctl list | grep -E 'com.chatterminalhub|com.mcphub'
curl -fsS http://127.0.0.1:8969/api/status
```

Для Messaging/AutoSend локальный native API принимает специальный заголовок и ограничивает обращения по Host/Origin. Не рассматривайте отказ `curl` без подходящего контекста как отказ самого сервиса.

**Функциональное подтверждение:** `terminal_exec` из ChatGPT возвращает exit 0 для безопасной команды; `browser_tabs(action=list)` из PlaywrightHub показывает реальные вкладки. Для планировщика отдельно проверяйте статус Playwright Extension и только с явным разрешением выполняйте тестовую отправку в специально выделенный чат.

## Что не делает первый запуск

Он не мигрирует автоматически чужие браузерные профили, не импортирует содержимое ChatGPT, не регистрирует новые workspace и не включает ранее выключенные расписания AutoSend. Все эти действия требуют отдельной настройки.

# McpGo 2.1.0 — macOS Apple Silicon / Windows preview

**macOS:** McpGo 2.1.0, macOS 14+, Apple Silicon. Developer ID signed and
Apple-notarized DMG; download the asset `McpGo-2.1.0-macos-arm64.dmg` from
https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0.

**Windows 11 x64:** 2.1.0-preview.2, experimental *unsigned* NSIS installer
`McpGo.Setup.2.1.0-preview.2.exe` and matching SHA-256 at
https://github.com/mcpgo1/McpGo/releases/tag/v2.1.0-preview.2.
SmartScreen or enterprise policy may block unsigned applications.
Do not bypass security protections.

## Что нового

- Безопасное обновление установленного McpGo без повторного создания
  OpenAI Tunnels и повторной выдачи ключей. Состояние Keychain и каталог
  пользовательских данных не удаляются; прежняя версия runtime остаётся для отката.
- Устранено использование старого runtime после установки нового DMG.
- Усовершенствованы Browser MCP, отдельные вкладки агентов и AutoSend через
  Playwright Extension; улучшена диагностика состояния чата и дубликатов отправки.
- Обновлены Terminal MCP и длительные Jobs для восстановления после обрывов.
- Исправлена проверка обновлений Windows при нормализации имён GitHub Assets.

## Как обновляться

**Mac:** завершите выполняющиеся долгие задания, закройте приложение,
откройте DMG и замените McpGo.app в «Программы», затем запустите его.
Не удаляйте `~/Library/Application Support/McpGo` и записи Keychain.
Существующие плагины ChatGPT и Tunnel ID продолжают использоваться.
Если новый runtime не запустится, предыдущая версия остаётся в
`.runtime-rollback-*` и старые данные не перезаписываются.

**Windows:** установите новый preview от имени того же пользователя
поверх предыдущего. Данные и зашифрованные ключи находятся отдельно
от исполняемых файлов. При изменении учётной записи Windows или очистке
пользовательского профиля это сохранение не гарантируется.

**Проверки:** Python, Node и Swift на macOS; native Windows CI для Windows.
Окончательный результат подписания/notarization и CI указан в Assets
конкретных релизов.

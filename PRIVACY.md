# Privacy Policy — zeithub.otto

*Last updated: October 5, 2026*

zeithub.otto ("Otto") is a desktop coding app that runs on your computer. This policy explains what
data Otto handles and where it goes.

## What Otto does not do

- Otto has **no account** and no sign-up.
- Otto collects **no telemetry, analytics or crash reports**.
- The developer of Otto **does not receive** your code, chats, files, keys or any personal data.

## Data stored on your computer

Projects, chats, settings, API keys and SSH connections are stored locally in
`%APPDATA%\zeithub.otto`. They never leave your computer unless you use one of the features below.
Uninstalling Otto keeps this folder; delete it to remove the data.

## Data sent over the network — only when you use a feature

| Feature | What is sent | Where |
|---|---|---|
| Cloud AI models (OpenRouter, Anthropic, Google Gemini, Mistral, Groq, Cerebras, xAI, NVIDIA, Cohere, Z.ai, Cloudflare, OpenCode Zen or any OpenAI-compatible server) | Your messages and the parts of your project the model works with | The provider you chose, under that provider's own privacy policy |
| Claude Code / Codex subscriptions | The same, through the CLI tools you installed and signed in to | Anthropic / OpenAI |
| Local models (Ollama) | Nothing leaves your computer | — |
| Web search and page reading by the model | Search queries and page addresses | DuckDuckGo, Bing or the site being read |
| Update check (GitHub version) | A request for the latest release, no personal data | api.github.com |
| Git, SSH, databases, Docker, package managers | What you ask these tools to do | The servers you connect to |

Which cloud providers are used is entirely your choice; with only local models Otto works offline.

## Children

Otto is a developer tool and is not directed at children.

## Changes

Changes to this policy are published in this file in the
[zeithub-team/otto](https://github.com/zeithub-team/otto) repository.

## Contact

Questions: [open an issue](https://github.com/zeithub-team/otto/issues).

---

# Политика конфиденциальности — zeithub.otto

*Обновлено: 5 октября 2026*

zeithub.otto («Otto») — программа для разработки, которая работает на вашем компьютере.

## Чего Otto не делает

- В Otto **нет аккаунта** и регистрации.
- Otto **не собирает** телеметрию, аналитику и отчёты о сбоях.
- Разработчик Otto **не получает** ваш код, чаты, файлы, ключи или персональные данные.

## Данные на вашем компьютере

Проекты, чаты, настройки, API-ключи и SSH-подключения хранятся локально в `%APPDATA%\zeithub.otto`
и не покидают компьютер, если вы не пользуетесь функциями ниже. При удалении Otto эта папка
остаётся — удалите её, чтобы стереть данные.

## Что уходит в сеть — только когда вы пользуетесь функцией

- **Облачные модели** (OpenRouter, Anthropic, Google Gemini, Mistral, Groq, Cerebras, xAI, NVIDIA, Cohere, Z.ai, Cloudflare, OpenCode Zen или любой OpenAI-совместимый сервер):
  ваши сообщения и нужные модели части проекта — выбранному вами провайдеру, по его политике.
- **Подписки Claude Code / Codex:** то же самое, через установленные вами CLI.
- **Локальные модели (Ollama):** ничего не уходит с компьютера.
- **Поиск в интернете моделью:** поисковые запросы и адреса страниц — DuckDuckGo, Bing или самому сайту.
- **Проверка обновлений (версия с GitHub):** запрос последнего релиза к api.github.com, без персональных данных.
- **Git, SSH, базы данных, Docker, менеджеры пакетов:** то, что вы поручили этим инструментам, — серверам, к которым вы подключаетесь.

## Связь

Вопросы: [создайте issue](https://github.com/zeithub-team/otto/issues).

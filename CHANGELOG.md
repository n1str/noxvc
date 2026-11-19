# История изменений

## [0.1.0] (по-русски)

Первый публичный релиз.

- Голос (LiveKit, Opus): шумоподавление, порог голоса, рация, громкость участников; камеры; демонстрация экрана со
  звуком (нативный захват в приложении); звонки в ЛС; каналы-сцены; встроенный TURN.
- Текст: каналы, категории, ответы, ветки, форумы, опросы, реакции, свои эмодзи, упоминания, markdown, вложения,
  превью ссылок, закрепы, поиск.
- Роли и переопределения прав как в Discord; профили с (анимированными) аватарами и баннерами, игровая активность;
  светлая и тёмная тема; интерфейс на русском и английском.
- Открытая регистрация по умолчанию; необязательный режим по приглашениям.
- Установка на сервер одной командой (`install.sh`): HTTPS, секреты и аккаунт администратора.
- Приложение для Windows (Tauri 2): горячие клавиши, трей, автозапуск; при первом запуске спрашивает адрес сервера.
- Docker Compose; по желанию Caddy (HTTPS) и мониторинг (Prometheus, Grafana).

Ограничения: приложение только для Windows, нет сквозного шифрования, 2FA и почты, установщик не подписан, CSP по
умолчанию нет — см. SECURITY.md.

---

# English: Changelog

## [0.1.0]

First public release.

- Voice channels (LiveKit, Opus): noise suppression, voice activity gate, push-to-talk, per-user volume; cameras;
  screen sharing with audio (native capture in the Windows app); DM calls; stage channels; built-in TURN.
- Text: channels, categories, replies, threads, forums, polls, reactions, custom emoji, mentions, markdown, attachments,
  link previews, pins, full-text search.
- Discord-style roles and permission overwrites; profiles with (animated) avatars and banners, game activity;
  light and dark theme; Russian and English UI.
- Open registration by default; optional invite-only mode with single-use codes, member requests and admin approval.
- One-command server install (`install.sh`): HTTPS, secrets and the admin account.
- Windows app (Tauri 2): global hotkeys, tray, autostart; asks for the server address on first start.
- Docker Compose deployment with optional Caddy (HTTPS) and monitoring (Prometheus, Grafana).

Known limitations: Windows-only desktop app, no end-to-end encryption, no 2FA/email, unsigned installer,
no CSP by default — see SECURITY.md.

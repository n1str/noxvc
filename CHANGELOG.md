# Changelog

## [0.1.0]

First public release.

- Voice channels (LiveKit, Opus): noise suppression, voice activity gate, push-to-talk, per-user volume; cameras;
  screen sharing with audio (native capture in the Windows app); DM calls; stage channels; built-in TURN.
- Text: channels, categories, replies, threads, forums, polls, reactions, custom emoji, mentions, markdown, attachments,
  link previews, pins, full-text search.
- Discord-style roles and permission overwrites; profiles with (animated) avatars and banners, game activity;
  light and dark theme; Russian and English UI.
- Invite-only registration: single-use codes, member invite requests approved by the admin, admin panel and CLI.
- Windows app (Tauri 2): global hotkeys, tray, autostart; asks for the server address on first start.
- Docker Compose deployment with optional Caddy (HTTPS) and monitoring (Prometheus, Grafana).

Known limitations: Windows-only desktop app, no end-to-end encryption, no 2FA/email, unsigned installer,
no CSP by default — see SECURITY.md.

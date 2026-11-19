# Безопасность

## Как сообщить об уязвимости

Сообщайте **приватно** через GitHub: **Security → Report a vulnerability** в этом репозитории. Не создавайте публичный
issue. Опишите шаги воспроизведения и версию. Ответ придёт в том же отчёте; исправление выходит новой версией.
Поддерживается последняя версия.

## Как устроена защита (кратко)

- Пароли — Argon2id; сеансы хранятся на сервере, их можно завершать; смена пароля завершает другие сеансы.
- Права считаются в одном месте (`src/perms.rs`, табличные тесты); чужой сервер — 404; эндпоинты администратора — 403
  всем остальным; администраторы задаются только переменной `RELAY_INSTANCE_ADMINS`.
- Загрузки: лимит 25 МБ, тип ответа — по белому списку расширений (HTML и SVG отдаются как `application/octet-stream`),
  `nosniff`; из JPEG удаляются EXIF (в том числе GPS), XMP, IPTC и комментарии; аватары и баннеры перекодируются ffmpeg.
- Превью ссылок — только публичные адреса, без редиректов, с привязкой к проверенному IP (без DNS rebinding).
- Ограничения частоты на регистрацию, вход, коды приглашений и обращения.
- Приложение: локальные порты только на `127.0.0.1`; обновления — только с подписью Ed25519.

## Известные ограничения

- Нет Content-Security-Policy по умолчанию; нет сквозного шифрования; нет 2FA и почты.
- Ограничения частоты — в памяти процесса (сбрасываются при перезапуске).
- Из PNG/WebP метаданные не удаляются; установщик для Windows не подписан.

Подробно — в английской части ниже.

---

# English: Security

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: **Security → Report a vulnerability** on this repository
(private vulnerability reporting). Do not open a public issue. Include steps to reproduce and the affected version.
You will get a reply on the advisory; fixes are released as new versions and credited in the advisory unless you
prefer otherwise.

Supported versions: the latest release.

## Security design

- **Registration** is invite-only: single-use codes (~119 bits) stored as SHA-256, consumed in the same transaction
  as the account is created; one error message for every invalid case; rate limits per IP and global.
- **Passwords** are hashed with Argon2id (default parameters of the `argon2` crate). Sessions are bearer tokens
  stored server-side; users can revoke other sessions, and a password change signs out other devices.
- **Permissions** are computed in one function (`src/perms.rs`) with table tests; every handler takes permissions
  from it. Non-members get 404 for a server (its existence is not revealed). Instance-admin endpoints return 403 to
  everyone else; admins are set only through `RELAY_INSTANCE_ADMINS`.
- **Uploads**: 25 MB limit; files are served with a content type from an allowlist of extensions (no HTML/SVG — those
  are served as `application/octet-stream`) and `X-Content-Type-Options: nosniff`. JPEG metadata (EXIF incl. GPS,
  XMP, IPTC, comments) is removed on upload; avatars, banners and icons are re-encoded by ffmpeg with an explicit
  demuxer (no playlists or URLs).
- **Link previews** fetch only public addresses: private, loopback, link-local and other reserved ranges are refused,
  the connection is pinned to the checked address (no DNS rebinding), redirects are not followed.
- **Rendering**: React escapes text; markdown links allow only `http(s)`; code highlighting escapes its input;
  YouTube embeds accept only validated 11-character video ids.
- **Desktop app**: local listeners bind to `127.0.0.1` only (Dota 2 GSI receiver with a random token and no
  `Origin`; LiveKit signalling proxy). Updates are accepted only with a valid Ed25519 signature for the key compiled
  into the app; certificate pinning is available for servers with self-signed certificates.
- **Dependencies**: `cargo audit`, `cargo deny` (licenses, advisories, sources) and `npm audit` run in CI.

## Known limitations

- **No Content-Security-Policy by default.** The XSS surface is small (see above), but there is no CSP as a second
  line of defence. A policy for the web client could look like
  `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' wss: https:;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
  frame-src https://www.youtube-nocookie.com; frame-ancestors 'self'; object-src 'none'` — the inline theme script in
  `web/index.html` and the desktop app's IPC (`http://ipc.localhost`) need to be accounted for before enabling it.
- **No end-to-end encryption.** Messages and media are encrypted in transit (TLS, DTLS-SRTP); the server and the SFU
  can read them.
- **No two-factor authentication or email**; account recovery is manual (an admin can create a new invite).
- **Rate limits are in memory**: they reset on restart and are per process.
- **Non-JPEG images keep their metadata** (PNG/WebP text chunks are not stripped).
- **The Windows installer is not code-signed** (SmartScreen warning); verify the SHA-256 from the release.
- Dependency advisories ignored in `.cargo/audit.toml` concern crates that are listed in `Cargo.lock` by sqlx but never
  compiled (MySQL/SQLite drivers).

# Архитектура

English: [en/architecture.md](en/architecture.md)

```
 Веб-клиент (React)           Приложение для Windows (Tauri 2)
   браузер                      WebView2 с тем же веб-клиентом
        │                       + Rust: горячие клавиши, захват экрана, обновления
        │                                   │
        ├─── HTTPS: /, /api, /gateway (WS) ─┤
        ▼                                   ▼
   Caddy (TLS, по желанию) ─────────► сервер NoxVC (Rust: axum + tokio)
                                         │  │  │
                     PostgreSQL ◄────────┘  │  └──► Garage / любой S3 (файлы)
                                            │ токены, API комнат    ▲ вебхуки
                                            ▼                       │
   клиенты ══ медиа WebRTC (UDP 7882, TCP 7881, TURN 3478) ══► LiveKit SFU
```

## Сервер (`src/`)

| Модуль | За что отвечает |
|---|---|
| `main.rs` | Запуск, маршруты, раздача веб-клиента и обновлений приложения, CLI (`relay admin …`) |
| `api.rs` | REST: вход, серверы, каналы, сообщения, роли, приглашения на серверы, загрузки, токены голоса |
| `perms.rs` | Расчёт прав (битовая маска, переопределения, иерархия) — единственный источник прав |
| `gateway.rs`, `ws.rs` | WebSocket gateway: HELLO/IDENTIFY/RESUME, heartbeat, рассылка событий, присутствие |
| `db.rs` | Пул, миграции, общие запросы и JSON |
| `threads.rs` | Ветки, форумы, опросы |
| `search.rs` | Полнотекстовый поиск (PostgreSQL `tsvector`) |
| `social.rs` | Профили, друзья, личные сообщения, присутствие, настройки аккаунта |
| `media.rs`, `mediaq.rs` | Разбор медиа, фоновая обработка аватаров/баннеров/иконок (ffmpeg), очистка EXIF |
| `storage.rs` | Локальное хранилище или S3, отдача файлов |
| `embeds.rs` | Превью ссылок с защитой от SSRF (без редиректов, внутренние адреса закрыты, проверенный адрес) |
| `emojis.rs` | Свои эмодзи |
| `mentions.rs` | Упоминания и адресаты уведомлений |
| `activity.rs` | Игровая активность («Играет в …») из приложения |
| `livekit.rs` | Токены LiveKit, API комнат, проверка вебхуков |
| `invites.rs` | Режим регистрации, коды приглашений и запросы (режим `invite`), ограничения частоты, CLI |
| `feedback.rs` | Обращения (баги и предложения) для администраторов |
| `sessions.rs` | Сеансы, журнал безопасности, данные клиента и GeoIP |
| `metrics.rs` | Метрики Prometheus (`relay_*`) |
| `regions.rs` | Необязательные дополнительные точки входа (на одном сервере выключено) |
| `site.rs` | Публичная страница приглашения с превью OpenGraph, `/download/windows` |

Схема базы — [`migrations/`](../migrations) (применяются при запуске).

## Веб-клиент (`web/`)

React 19 + TypeScript + Vite, состояние — `zustand` (`src/store.ts`), клиент gateway — `src/lib/gateway.ts`, голос —
`src/features/voice.tsx` (livekit-client), дизайн-токены — `src/styles/tokens.css`, переводы — `src/i18n*.ts`.
Собранный бандл раздаёт сервер; приложение для Windows загружает его с сервера.

## Приложение для Windows (`desktop/`)

`desktop/setup/` — локальный экран подключения (подключение к серверу, ввод адреса, ошибки связи). Нативный код —
`desktop/src-tauri/src/`: `hook.rs`/`hotkeys.rs` (горячие клавиши Raw Input, рация), `share.rs`/`gpu.rs`/`mfenc.rs`
(Windows Graphics Capture → H.264 → LiveKit Rust SDK), `games.rs` (определение игр, Dota 2 GSI на 127.0.0.1),
`update.rs` (подписанные обновления), `endpoint.rs`/`pin.rs` (точки входа, закрепление сертификата), `snap.rs`
(прилипание окна).

## Тесты

- `tests/*.mjs` — тесты API и gateway на стенде `tests/stack` (Docker).
- `web/e2e/*.mjs` — браузерные тесты (Playwright + Chrome).
- `cargo test` — модульные тесты сервера и приложения.
- `tests/demo` — демо-стенд с выдуманными данными для скриншотов.

Почему так устроено: [decisions/](decisions/).

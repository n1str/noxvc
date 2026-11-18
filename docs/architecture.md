# Architecture

```
 Web client (React)            Windows app (Tauri 2)
   browser                      WebView2 with the same web client
        │                       + Rust: hotkeys, native capture, updates
        │                                   │
        ├─── HTTPS: /, /api, /gateway (WS) ─┤
        ▼                                   ▼
   Caddy (TLS, optional) ───────────► NoxVC server (Rust: axum + tokio)
                                         │  │  │
                     PostgreSQL ◄────────┘  │  └──► Garage / any S3 (files)
                                            │ tokens, room API      ▲ webhooks
                                            ▼                       │
   clients ══ WebRTC media (UDP 7882, TCP 7881, TURN 3478) ══► LiveKit SFU
```

## Server (`src/`)

| Module | Responsibility |
|---|---|
| `main.rs` | Startup, routes, static files (web client, desktop updates), CLI (`relay admin …`) |
| `api.rs` | REST: auth, servers, channels, messages, roles, invites, uploads, voice tokens |
| `perms.rs` | Permission computation (bitmask, overwrites, hierarchy) — the single source of truth |
| `gateway.rs`, `ws.rs` | WebSocket gateway: HELLO/IDENTIFY/RESUME, heartbeats, dispatch, presence hub |
| `db.rs` | Pool, migrations, shared queries and JSON shapes |
| `threads.rs` | Threads, forums, polls |
| `search.rs` | Full-text search (PostgreSQL `tsvector`) |
| `social.rs` | Profiles, friends, DMs, presence, account settings |
| `media.rs`, `mediaq.rs` | Media probing, background processing of avatars/banners/icons (ffmpeg) |
| `storage.rs` | Local or S3 storage, serving uploads |
| `embeds.rs` | Link previews with SSRF protection (no redirects, private ranges blocked, pinned resolution) |
| `emojis.rs` | Custom emoji |
| `mentions.rs` | Mentions and notification targets |
| `activity.rs` | Game activity ("Playing …") from the desktop app |
| `livekit.rs` | LiveKit tokens, room API, webhook verification |
| `invites.rs` | Invite-only registration: codes, member requests, admin API, rate limits, CLI |
| `feedback.rs` | Bug reports / ideas backlog for instance admins |
| `sessions.rs` | Sessions, security log, client and GeoIP info |
| `metrics.rs` | Prometheus metrics (`relay_*`) |
| `regions.rs` | Optional multi-node entry points (off on a single server) |
| `site.rs` | Public invite page with OpenGraph preview, `/download/windows` |

Database schema: [`migrations/`](../migrations) (applied on start).

## Web client (`web/`)

React 19 + TypeScript + Vite, state in `zustand` (`src/store.ts`), gateway client in `src/lib/gateway.ts`, voice in
`src/features/voice.tsx` (livekit-client), design tokens in `src/styles/tokens.css`, translations in `src/i18n*.ts`.
The server serves the built bundle; the desktop app loads it from the server.

## Desktop app (`desktop/`)

`desktop/setup/` is the local start screen (connects to the server, shows connection errors). Native code in
`desktop/src-tauri/src/`: `hook.rs`/`hotkeys.rs` (Raw Input hotkeys, push-to-talk), `share.rs`/`gpu.rs`/`mfenc.rs`
(Windows Graphics Capture → H.264 → LiveKit Rust SDK), `games.rs` (game detection, Dota 2 GSI on 127.0.0.1),
`update.rs` (signed updates), `endpoint.rs`/`pin.rs` (entry points, certificate pinning), `snap.rs` (window
snapping).

## Tests

- `tests/*.mjs` — API and gateway tests against `tests/stack` (Docker).
- `web/e2e/*.mjs` — browser tests (Playwright + Chrome).
- `cargo test` — unit tests (server and desktop).
- `tests/demo` — demo instance with made-up data for screenshots.

Decisions behind this design: [decisions/](decisions/).

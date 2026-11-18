# Architecture decisions

Short records of the main technical decisions: what was chosen, what else was considered, and why.

## 1. One Rust process (axum + tokio)
A single binary serves the REST API, the WebSocket gateway, the web client and desktop updates. Separate services
exist only where an off-the-shelf component is clearly better (LiveKit, PostgreSQL, S3).
*Considered:* microservices, actix-web. *Why:* small deployments and a small team; extra services add only
operational cost.

## 2. Media: WebRTC through the LiveKit SFU
Voice, cameras and screen sharing go through LiveKit (separate container with built-in TURN). The server checks
permissions (connect, speak, stream) and issues short-lived LiveKit tokens; voice presence comes from signed LiveKit
webhooks. Opus with DTX/FEC/RED, adaptive stream and dynacast, simulcast for video.
*Considered:* raw PCM over WebSocket (TCP head-of-line blocking causes stutter), mesh WebRTC (does not scale past
4–5 people), an SFU inside the Rust process (months of work: simulcast, bandwidth estimation, TURN), mediasoup
(a library, signalling stays on us). *Why LiveKit:* a complete SFU (Apache-2.0) in one container, single-port UDP,
built-in TURN, mature client SDKs including Rust (used by the desktop app for native screen capture).

## 3. Web client: React + TypeScript + Vite, shared with the desktop app
The same bundle runs in the browser and inside the Tauri window: `motion` (animations), `@tanstack/react-virtual`,
`lucide-react`, `i18next` (ru/en), `livekit-client`, `zustand`.
*Considered:* SolidJS, Svelte, vanilla JS. *Why:* mature animation and virtualization libraries, LiveKit components.

## 4. PostgreSQL with sqlx migrations
Connection pool, versioned migrations, full-text search on `tsvector` (with Russian stemming).
*Considered:* SQLite + FTS5 (single writer, no morphology out of the box). *Why:* concurrent writes, real
migrations and indexes, search quality.

## 5. No Redis on a single node
Presence, the gateway resume buffer, permission cache and rate limits live in process memory behind small
interfaces. A shared store becomes necessary only with several server processes.

## 6. Files in S3 (Garage by default)
Attachments, avatars, banners, emoji and server icons are stored in any S3-compatible storage; the compose file ships
a single-node Garage. Local disk storage is still supported (`RELAY_STORAGE=local`). Avatars and banners are
re-encoded by a background queue (ffmpeg), so originals are never served as profile media.

## 7. Desktop app: Tauri 2 (Windows)
A WebView2 window loads the web client from the server; native parts are written in Rust: global hotkeys via Raw
Input (nothing is intercepted), native screen capture (Windows Graphics Capture + Media Foundation H.264 into the
LiveKit Rust SDK), game detection, signed auto-updates (Ed25519).
*Considered:* Electron (heavier, a second browser engine to ship). *Why:* small installer, Rust for native code.

## 8. Permissions: one function, a u64 bitmask, Discord order
`perms.rs` computes permissions in one place: base roles (`@everyone` + roles), administrator short-circuit,
channel overwrites in Discord order (`@everyone` → roles → member), implicit dependencies (no VIEW_CHANNEL → nothing
else in the channel). Role hierarchy is checked separately (`can_manage`). Both are covered by table tests; every
handler takes permissions only from here.

## 9. Gateway: Discord-style protocol with RESUME
`/gateway` is server → client: HELLO → IDENTIFY/RESUME → READY/RESUMED → DISPATCH `{op, t, s, d}` with heartbeats.
A session keeps the last 1000 events for 120 s after a disconnect, so a short network drop is resumed without
missing events. Client actions go through REST.

## 10. Invite-only registration
Accounts are created only with single-use invite codes: 24 characters without look-alikes (~119 bits), only a
SHA-256 hash is stored. The code is consumed in the same transaction as the user is created
(`UPDATE … WHERE unused AND not revoked AND not expired RETURNING`), so concurrent attempts with one code yield
exactly one account and any failure rolls back. Codes for approved member requests are an HMAC of a server key,
which lets the requester see the link until it is used without storing the code itself. Instance administrators are
set only through an environment variable.

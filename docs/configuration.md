# Configuration

NoxVC is configured with environment variables. With Docker Compose you set them in `deploy/.env`
(template: [`deploy/.env.example`](../deploy/.env.example)); `deploy/compose.yaml` maps them to the server
variables below.

## Compose (`deploy/.env`)

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | — (required) | Password of the `noxvc` database user. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | — (required) | LiveKit credentials; the server signs voice tokens with them. Secret: 32+ characters. |
| `GARAGE_RPC_SECRET` | — (required) | Garage RPC secret, 64 hex characters. |
| `GARAGE_ADMIN_TOKEN` | — (required) | Garage admin API token. |
| `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY` | — (required) | S3 credentials created in Garage on first start (`GK` + 32 hex, 64 hex). |
| `INVITE_KEY` | — (required) | HMAC key for invite codes of approved requests (32+ characters). |
| `INSTANCE_ADMINS` | empty | Instance administrators: usernames, comma-separated. The only way to grant admin rights. |
| `APP_URL` | `http://localhost:8080` | Public URL of the app (used in invite links and link previews). |
| `SITE_URL` | `APP_URL` | Optional separate site for public invite pages (`/invite/<code>`). |
| `LIVEKIT_PUBLIC_URL` | `ws://localhost:7880` | LiveKit URL the clients connect to (`wss://voice.example.com` behind Caddy). |
| `PUBLIC_IP` | `127.0.0.1` | Server IP that LiveKit announces to clients for media. |
| `APP_DOMAIN`, `VOICE_DOMAIN` | — | Domains for the `https` profile (Caddy + Let's Encrypt). `VOICE_DOMAIN` is also the TURN host name. |
| `HTTP_BIND` | `127.0.0.1:8080` | Host address of the app HTTP port. |
| `LIVEKIT_SIGNAL_BIND` | `127.0.0.1:7880` | Host address of the LiveKit signalling port (local use; Caddy serves it with a domain). |
| `GEOIP_DB` | empty | Path (inside the container) to a DB-IP Lite / MaxMind city `.mmdb` for the session log. Empty — no geolocation. |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana admin password (`monitoring` profile). |
| `GRAFANA_BIND` | `127.0.0.1:3000` | Host address of Grafana. |

Generate production secrets with `deploy/gen-env.sh > deploy/.env`.

## Server (`relay` binary)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://relay:relay@127.0.0.1:55432/relay` | PostgreSQL connection string. Migrations run on start. |
| `RELAY_ADDR` | `0.0.0.0:8080` | HTTP listen address (web client, `/api`, `/gateway`, files, updates). |
| `RELAY_DATA` | `data` | Data directory (`updates/` for desktop releases, local uploads). |
| `RELAY_WEB` | `web/dist` | Built web client. |
| `RELAY_APP_URL` | `http://localhost:8080` | Public app URL. |
| `RELAY_SITE_URL` | `RELAY_APP_URL` | Public site URL for invite pages. |
| `RELAY_METRICS_ADDR` | `127.0.0.1:9464` | Prometheus metrics listener (keep it private). |
| `LIVEKIT_URL` | `http://livekit:7880` | LiveKit server API URL. |
| `LIVEKIT_PUBLIC_URL` | empty | LiveKit URL for clients. Empty — clients use `/rtc` on the app origin. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | — | LiveKit credentials (tokens and webhook verification). Without them (or with a secret shorter than 32 characters) voice is disabled. |
| `RELAY_STORAGE` | `local` | `local` (files in `RELAY_DATA/uploads`) or `s3`. |
| `RELAY_S3_ENDPOINT`, `RELAY_S3_BUCKET` | — | S3 endpoint and bucket (`s3` storage). |
| `RELAY_S3_REGION` | `garage` | S3 region. |
| `RELAY_S3_ACCESS_KEY`, `RELAY_S3_SECRET_KEY` | — | S3 credentials. |
| `RELAY_STORAGE_FALLBACK_DIR` | empty | Read-only local directory checked for files missing in S3 (after migrating from local storage). |
| `RELAY_INSTANCE_ADMINS` | empty | Instance admins (usernames, comma-separated). When set, `users.is_admin` is synced to exactly this list on start; when unset, nothing changes. |
| `RELAY_INVITE_KEY` | derived | HMAC key for invite codes of approved requests. If unset, derived from `LIVEKIT_API_SECRET`; if both are unset, random per process (approved links do not survive a restart). |
| `RELAY_REGISTER_PER_IP` | `10` | Registration attempts per IP per 10 minutes. |
| `RELAY_REGISTER_GLOBAL` | `100` | Registration attempts in total per 10 minutes. |
| `RELAY_BAD_CODES_PER_IP` | `5` | Invalid invite codes per IP per 10 minutes before a pause. |
| `RELAY_LOGIN_FAILS_PER_IP` | `20` | Failed logins per IP per 10 minutes before a pause. |
| `RELAY_INVITE_REQUESTS_PER_HOUR` | `10` | Invite requests a member can create per hour. |
| `RELAY_PRESENCE_GRACE_MS` | `15000` | Delay before a disconnected user is shown offline. |
| `RELAY_ANIMATED_PROFILES` | `true` | Animated avatars and banners (`0`/`false` — keep the first frame). |
| `RELAY_PREVIEW_ALLOW` | empty | Comma-separated host names allowed for link previews even if they resolve to private addresses. |
| `RELAY_GEOIP_DB` | empty | City `.mmdb` database for the session log. |
| `RELAY_REGIONS_FILE` | empty | Optional multi-node configuration (JSON). Single-node setups do not need it. |

The client IP is taken from the first `X-Forwarded-For` value (set by the reverse proxy), so run the server behind a
proxy that overwrites this header (Caddy and the nginx example in [deployment.md](deployment.md) do).

## Desktop client (build time)

Set when building `desktop/` (see [desktop-client.md](desktop-client.md)); the values are compiled into the app.

| Variable | Default | Description |
|---|---|---|
| `RELAY_SERVER` | empty | Server the app connects to. Empty — the app asks for the address on first start. |
| `RELAY_ENDPOINTS` | empty | Several entry points: `id=https://host[#pin][#fallback],…`. Empty — one entry point `RELAY_SERVER`. |
| `RELAY_PINS` | empty | SHA-256 SPKI pins (base64) for entry points marked `#pin` (servers with self-signed certificates). |
| `RELAY_UPDATE_KEY` | empty | Ed25519 public key (base64) for verifying updates. Empty — auto-update is disabled. |
| `RELAY_UPDATE_CHANNEL` | empty | Update channel (`test` — `/updates/test/`). |

Runtime switches for development and tests: `RELAY_DESKTOP_PROFILE` (separate profile and settings),
`RELAY_DESKTOP_DEBUG`, `RELAY_DESKTOP_CDP` (remote debugging port), `RELAY_DESKTOP_TEST_*` (test hooks).

# Installation

NoxVC runs as a Docker Compose project: the NoxVC server, PostgreSQL, Garage (S3 file storage) and LiveKit (voice,
video, screen sharing, TURN). Optional profiles add Caddy (HTTPS) and monitoring.

## Local (one machine)

```sh
git clone https://github.com/n1str/noxvc.git
cd noxvc/deploy
cp .env.example .env
docker compose up -d --build        # the first build compiles Rust and the web client: several minutes, ~4 GB RAM
```

Create the first invite code and register the administrator:

```sh
docker compose exec relay /app/relay admin invite create --note "first admin"
```

Open the printed link (or <http://localhost:8080> → **Register with a code**) and register with the username from
`INSTANCE_ADMINS` (default `admin`). That account is the instance administrator: it sees
**Settings → Invites (admin)** and **Reports (admin)**.

Voice and screen sharing work in browsers on the same machine (`localhost` is a secure context for WebRTC). Other
devices need HTTPS — see the next section.

## Server with a domain

1. DNS: two A records to the server's public IP, e.g. `app.example.com` and `voice.example.com`.
2. Ports open to the internet: TCP 80, 443, 7881; UDP 7882, 3478 (port forwarding on a home router:
   [deployment.md](deployment.md#home-server-behind-a-router)).
3. Configure:
   ```sh
   cd noxvc/deploy
   ./gen-env.sh > .env       # random secrets
   ```
   In `.env` set:
   ```
   INSTANCE_ADMINS=yourname
   APP_URL=https://app.example.com
   LIVEKIT_PUBLIC_URL=wss://voice.example.com
   APP_DOMAIN=app.example.com
   VOICE_DOMAIN=voice.example.com
   PUBLIC_IP=203.0.113.10        # the server's public IPv4
   ```
4. Start with HTTPS:
   ```sh
   docker compose --profile https up -d --build
   ```
   Caddy obtains Let's Encrypt certificates on first request (ports 80/443 must be reachable).
5. Create the first invite code and register as in the local setup:
   `./noxvc-admin invite create --note "first admin"`.

## Updating

```sh
cd noxvc && git pull
cd deploy && docker compose --profile https up -d --build
```

Database migrations run automatically on start. Back up first ([backup.md](backup.md)).

## Monitoring (optional)

```sh
docker compose --profile monitoring up -d
```

Grafana: <http://localhost:3000> (user `admin`, password `GRAFANA_ADMIN_PASSWORD`). See [monitoring.md](monitoring.md).

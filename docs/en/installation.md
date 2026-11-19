# Installation

NoxVC runs as a Docker Compose project: the NoxVC server, PostgreSQL, Garage (S3 file storage) and LiveKit (voice,
video, screen sharing, TURN). Optional profiles add Caddy (HTTPS) and monitoring.

## Server in one command (recommended)

```sh
git clone https://github.com/n1str/noxvc.git && cd noxvc && sudo ./install.sh
```

[`install.sh`](../../install.sh) installs Docker if needed, asks for the app domain, the voice domain and the admin
username, writes `deploy/.env` with random secrets, starts NoxVC with HTTPS and creates the admin account (prints the
password). Before running it: open the ports below; a domain is optional — without one the script uses the free
`<ip>.sslip.io` name (e.g. `203-0-113-10.sslip.io`), which resolves to the server and gets a normal HTTPS certificate.

## Local (one machine)

```sh
git clone https://github.com/n1str/noxvc.git
cd noxvc/deploy
cp .env.example .env
docker compose up -d --build        # the first build compiles Rust and the web client: several minutes, ~4 GB RAM
```

Open <http://localhost:8080> and register with the username from `INSTANCE_ADMINS` (default `admin`). That account is the
instance administrator (it sees **Settings → Reports (admin)**).

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
5. Open `https://app.example.com` and register with the username from `INSTANCE_ADMINS` right away.

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

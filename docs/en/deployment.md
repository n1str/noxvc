# Deployment

## What has to be reachable

| Port | Protocol | Used by |
|---|---|---|
| 80 | TCP | HTTP → HTTPS redirect, Let's Encrypt HTTP-01 challenge |
| 443 | TCP | Web client, `/api`, `/gateway` (WebSocket), files; LiveKit signalling on the voice domain |
| 7882 | UDP | WebRTC media (single-port mux) — the main media path |
| 7881 | TCP | WebRTC media over TCP — fallback when UDP is blocked |
| 3478 | UDP | TURN (clients behind strict NAT) |

Everything else (PostgreSQL, Garage, LiveKit API 7880, metrics 9464/6789, Grafana 3000) stays inside the Docker
network or on `127.0.0.1`.

`PUBLIC_IP` must be the address clients reach the server at: LiveKit puts it into ICE candidates. If it is wrong,
voice connects (signalling works) but no audio flows.

## Reverse proxy

### Caddy (included)

`docker compose --profile https up -d` starts Caddy with [`deploy/Caddyfile`](../../deploy/Caddyfile): automatic
certificates, HTTP → HTTPS, HSTS, compression, WebSocket proxying. Two sites:

- `APP_DOMAIN` → `relay:8080`
- `VOICE_DOMAIN` → `livekit:7880`

### nginx (your own)

Run without the `https` profile, keep `HTTP_BIND=127.0.0.1:8080` and `LIVEKIT_SIGNAL_BIND=127.0.0.1:7880`, and proxy
both names. Certificates — e.g. certbot.

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name app.example.com;
    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
    client_max_body_size 30m;                       # attachments up to 25 MB

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;  # overwrite, do not append: the server trusts the first value
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Relay-Region "";            # internal header, never from clients
        proxy_set_header Upgrade $http_upgrade;        # /gateway WebSocket
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}

server {
    listen 443 ssl http2;
    server_name voice.example.com;
    ssl_certificate     /etc/letsencrypt/live/voice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/voice.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}
```

Set `X-Forwarded-For` to the client address (not appended): the session log and rate limits use its first value.

## TURN

LiveKit's built-in TURN listens on UDP 3478 under `VOICE_DOMAIN`. Clients use it automatically when direct UDP does
not work. TURN over TLS (for networks that allow only HTTPS) is not enabled in the default configuration; see the
LiveKit documentation (`turn.tls_port`, a certificate for the TURN domain) if you need it.

## Home server behind a router

Forward the ports from the table above from the router's WAN interface to the server. Two things matter:

- **Restrict the forwarding rules to the WAN interface** (or the public address). A rule without it also catches
  traffic from your LAN to those ports on *any* internet host.
- **Hairpin NAT**, if you open the domain from inside the same LAN: LAN clients resolve the domain to the public IP,
  so the router must forward that traffic back to the server (and masquerade it so replies return through the router).
  Alternatively serve the domain names to LAN clients with the server's LAN address via local DNS.

Also check that no masquerade rule rewrites the source address of *incoming* forwarded traffic — otherwise the
server sees every client as the router and the session log, geolocation and per-IP rate limits stop working.

## Several servers

The server has an optional multi-node mode (`RELAY_REGIONS_FILE`: extra HTTPS entry points and TURN relays in other
regions that forward to one primary server). It is not needed for a single server and is not covered by the compose
setup.

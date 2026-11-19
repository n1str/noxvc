# Desktop client (Windows)

The desktop app is a Tauri 2 window (WebView2) that loads the web client from **your** server, plus native features:
global hotkeys and push-to-talk over games, tray, autostart, native screen capture, game activity, signed updates.
**Release installer** (GitHub Releases): on first start it asks for the server address (`https://app.example.com`)
and remembers it; "Change server address" appears on the connection screen if the server is unreachable. Release
builds have no update key, so they do not auto-update — install new releases manually, or build your own client.

**Your own build** compiles your server address (`RELAY_SERVER`, then the address cannot be changed in the app) and
your update signing key in, so your users get signed auto-updates from your server.

## Requirements

- Windows 10/11 x64, [Rust](https://rustup.rs) (stable, MSVC), Node.js 20+, Visual Studio Build Tools (C++).
- WebView2 runtime (preinstalled on Windows 11).

## Build

```powershell
cd desktop
npm install
$env:RELAY_SERVER = "https://app.example.com"     # your server (omit to ask on first start)
$env:RELAY_UPDATE_KEY = "<public key, see below>" # optional: enables signed auto-updates
npm run build
```

The installer is written to `desktop/src-tauri/target/release/bundle/nsis/`.

Optional build variables (see [configuration.md](configuration.md#desktop-client-build-time)):
- `RELAY_ENDPOINTS` — several entry points with automatic failover, e.g.
  `main=https://app.example.com,main-ip=https://203.0.113.10:8443#pin#fallback`;
- `RELAY_PINS` — SPKI pins for entry points with self-signed certificates (`#pin`).

## Update signing keys

Updates are verified with Ed25519: the app has the public key compiled in and installs only installers whose
manifest is signed with the matching private key. Generate your own pair once:

```sh
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('update-signing-key.pem',k.privateKey.export({type:'pkcs8',format:'pem'}));console.log(k.publicKey.export({type:'spki',format:'der'}).subarray(12).toString('base64'))"
```

- The printed line is the **public key** → `RELAY_UPDATE_KEY`.
- `update-signing-key.pem` is the **private key**: keep it off the server and out of git
  (default location: `%USERPROFILE%\.relay\update-signing-key.pem`, or set `RELAY_UPDATE_SIGNING_KEY=path`).

Without `RELAY_UPDATE_KEY` the app never checks for updates.

## Publishing an update

`desktop/release.mjs` bumps the version, builds, signs and uploads the installer and `latest.json` to the server's
data volume (`/data/updates`), where running apps pick it up:

```powershell
$env:RELAY_SERVER = "https://app.example.com"
$env:RELAY_UPDATE_KEY = "<public key>"
$env:RELAY_DEPLOY_HOST = "user@your-server"     # ssh access; docker on that host
node release.mjs --notes "What's new"
```

Options: `node release.mjs 1.2.0` (explicit version), `--channel test` (only builds with `RELAY_UPDATE_CHANNEL=test`
see it), `--no-build` (sign and upload the already built installer), `RELAY_CONTAINER` (default `noxvc-relay-1`).

Users can also download the current installer from the web client: **Settings → Download the app**
(`/download/windows`).

## Unsigned installer

The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" on first run:
**More info → Run anyway**. Compare the SHA-256 (`Get-FileHash .\Relay_x.y.z_x64-setup.exe`) with the one published
next to the release.

## Links inside the app

Message links and invites copied in the app look like `noxvc://invite/<code>` and `noxvc://msg/<server>/<channel>/<id>`
(older `relay://…` links keep working). They are opened inside the app; the scheme is not registered system-wide.

## Known limitations

- Windows only. The installer's own window, the process name in Task Manager and the autostart entry are named
  `Relay` (the internal product name; changing it would break updates of existing installs).
- Global hotkeys do not reach games running as administrator unless the app also runs as administrator.

# Contributing

Thanks for helping! Bug reports and feature requests: GitHub Issues. Security issues: see [SECURITY.md](SECURITY.md).

## Development setup

- Server: Rust stable, Docker. `docker compose -f tests/stack/compose.yaml up -d --build` starts the server with
  PostgreSQL and Garage on <http://127.0.0.1:18099> (no voice). For voice use `deploy/` (see docs/installation.md).
- Web client: Node.js 22, `cd web && npm ci && npm run dev` (proxy settings in `vite.config.ts`).
- Desktop: Windows, see [docs/desktop-client.md](docs/desktop-client.md).

## Before a pull request

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
(cd web && npm run build)
RELAY_URL=http://127.0.0.1:18099 node --import=./tests/register-codes.mjs tests/invites.mjs
```

Keep pull requests focused, add tests for behaviour changes, and describe how you tested. By contributing you agree
that your contribution is licensed under AGPL-3.0.

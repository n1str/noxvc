#!/usr/bin/env sh
# Prints a .env with fresh random secrets: ./gen-env.sh > .env
# Then set addresses and domains (APP_URL, LIVEKIT_PUBLIC_URL, APP_DOMAIN, VOICE_DOMAIN, PUBLIC_IP, INSTANCE_ADMINS).
set -eu
cd "$(dirname "$0")"
hex() { openssl rand -hex "$1"; }
sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
    -e "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=API$(hex 6)|" \
    -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$(hex 32)|" \
    -e "s|^GARAGE_RPC_SECRET=.*|GARAGE_RPC_SECRET=$(hex 32)|" \
    -e "s|^GARAGE_ADMIN_TOKEN=.*|GARAGE_ADMIN_TOKEN=$(hex 32)|" \
    -e "s|^GARAGE_ACCESS_KEY=.*|GARAGE_ACCESS_KEY=GK$(hex 16)|" \
    -e "s|^GARAGE_SECRET_KEY=.*|GARAGE_SECRET_KEY=$(hex 32)|" \
    -e "s|^INVITE_KEY=.*|INVITE_KEY=$(hex 32)|" \
    -e "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$(hex 12)|" \
    .env.example

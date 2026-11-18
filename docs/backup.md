# Backup and restore

NoxVC keeps state in three places (Docker volumes of the `noxvc` compose project):

| Volume | Content |
|---|---|
| `noxvc_pg-data` | PostgreSQL: accounts, servers, messages, roles, sessions, invites |
| `noxvc_garage-meta`, `noxvc_garage-data` | Files: attachments, avatars, banners, emoji, server icons |
| `noxvc_noxvc-data` | Desktop update files (`updates/`) and local uploads if `RELAY_STORAGE=local` |

Keep `deploy/.env` too: without `POSTGRES_PASSWORD`, `GARAGE_*` and `INVITE_KEY` a restore is incomplete.

## Back up

```sh
cd deploy
ts=$(date +%Y%m%d-%H%M%S); mkdir -p ~/noxvc-backups
# database: consistent dump while running
docker compose exec -T postgres pg_dump -U noxvc -d noxvc -Fc > ~/noxvc-backups/db-$ts.dump
# files: stop Garage briefly for a consistent copy
docker compose stop garage
for v in garage-meta garage-data noxvc-data; do
  docker run --rm -v noxvc_$v:/v:ro -v ~/noxvc-backups:/b alpine tar czf /b/$v-$ts.tgz -C /v .
done
docker compose start garage
cp .env ~/noxvc-backups/env-$ts
```

Copy the backup directory off the server. Test a restore regularly.

## Restore

```sh
cd deploy
docker compose down                       # keep volumes
for v in garage-meta garage-data noxvc-data; do
  docker run --rm -v noxvc_$v:/v -v ~/noxvc-backups:/b alpine sh -c "rm -rf /v/* && tar xzf /b/$v-<ts>.tgz -C /v"
done
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U noxvc -d noxvc --clean --if-exists < ~/noxvc-backups/db-<ts>.dump
docker compose up -d
```

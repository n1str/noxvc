# Резервные копии

English: [en/backup.md](en/backup.md)

Данные NoxVC лежат в томах Docker проекта `noxvc`:

| Том | Что внутри |
|---|---|
| `noxvc_pg-data` | PostgreSQL: аккаунты, серверы, сообщения, роли, сеансы, приглашения |
| `noxvc_garage-meta`, `noxvc_garage-data` | Файлы: вложения, аватары, баннеры, эмодзи, иконки серверов |
| `noxvc_noxvc-data` | Обновления приложения (`updates/`) и локальные файлы при `RELAY_STORAGE=local` |

Сохраняйте и `deploy/.env`: без `POSTGRES_PASSWORD`, `GARAGE_*` и `INVITE_KEY` восстановление неполное.

## Сделать копию

```sh
cd deploy
ts=$(date +%Y%m%d-%H%M%S); mkdir -p ~/noxvc-backups
# база: согласованный дамп на ходу
docker compose exec -T postgres pg_dump -U noxvc -d noxvc -Fc > ~/noxvc-backups/db-$ts.dump
# файлы: Garage ненадолго останавливаем, чтобы копия была согласованной
docker compose stop garage
for v in garage-meta garage-data noxvc-data; do
  docker run --rm -v noxvc_$v:/v:ro -v ~/noxvc-backups:/b alpine tar czf /b/$v-$ts.tgz -C /v .
done
docker compose start garage
cp .env ~/noxvc-backups/env-$ts
```

Унесите каталог копий с сервера и регулярно проверяйте восстановление.

## Восстановить

```sh
cd deploy
docker compose down                       # тома сохраняются
for v in garage-meta garage-data noxvc-data; do
  docker run --rm -v noxvc_$v:/v -v ~/noxvc-backups:/b alpine sh -c "rm -rf /v/* && tar xzf /b/$v-<ts>.tgz -C /v"
done
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U noxvc -d noxvc --clean --if-exists < ~/noxvc-backups/db-<ts>.dump
docker compose up -d
```

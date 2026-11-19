# Мониторинг

English: [en/monitoring.md](en/monitoring.md)

## Через профиль compose

```sh
cd deploy && docker compose --profile monitoring up -d
```

Запускает Prometheus, Grafana, `postgres-exporter` и `node-exporter`. Grafana — на `GRAFANA_BIND` (по умолчанию
`127.0.0.1:3000`), пользователь `admin`, пароль — `GRAFANA_ADMIN_PASSWORD`. Дашборды — в папке **NoxVC**:

- **NoxVC — Live Overview** — кто онлайн, голос, сообщения, HTTP (частота, задержки), пул БД, хранилище, LiveKit,
  приглашения, CPU/память/диск/сеть сервера;
- **NoxVC — PostgreSQL** — подключения, транзакции, блокировки, таблицы, медленные запросы (`pg_stat_statements`);
- **Node Exporter Full**, **PostgreSQL (detail)** — адаптированные дашборды сообщества.

Правила алертов — [`deploy/monitoring/prometheus/relay-alerts.yml`](../deploy/monitoring/prometheus/relay-alerts.yml)
(сервер не отвечает, доля 5xx, диск и память, здоровье PostgreSQL, сбои подключения к голосу и потери медиа).
Prometheus их вычисляет; для уведомлений подключите Alertmanager.

## Свой Prometheus

| Цель | Адрес (в сети compose) | Метрики |
|---|---|---|
| Сервер NoxVC | `relay:9464` (`RELAY_METRICS_ADDR`) | `relay_*`: пользователи, голос, gateway, HTTP, пул БД, хранилище, очередь медиа, приглашения |
| LiveKit | `livekit:6789` | `livekit_*` |
| Garage | `garage:3903/metrics` | `garage_*` |
| PostgreSQL | через `postgres-exporter` | `pg_*` (+ запросы из `deploy/monitoring/postgres-exporter/queries.yaml`) |

Порты метрик на хост не публикуются; если собираете снаружи — публикуйте их только на закрытый адрес. Дашборды —
JSON в `deploy/monitoring/grafana/dashboards/` (UID источника — `relay-prometheus`, или выберите свой при импорте);
их генерирует `node deploy/monitoring/grafana/gen-dashboards.mjs`.

Имена метрик сохраняют внутренний префикс `relay_`.

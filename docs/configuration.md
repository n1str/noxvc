# Настройки

NoxVC настраивается переменными окружения. При запуске через Docker Compose они задаются в `deploy/.env`
(шаблон — [`deploy/.env.example`](../deploy/.env.example)); `deploy/compose.yaml` передаёт их серверу.

English: [en/configuration.md](en/configuration.md)

## Compose (`deploy/.env`)

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `POSTGRES_PASSWORD` | — (обязательно) | Пароль пользователя базы `noxvc`. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | — (обязательно) | Ключи LiveKit: ими сервер подписывает токены входа в голос. Секрет — от 32 символов. |
| `GARAGE_RPC_SECRET` | — (обязательно) | Секрет RPC Garage, 64 hex-символа. |
| `GARAGE_ADMIN_TOKEN` | — (обязательно) | Токен API администрирования Garage. |
| `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY` | — (обязательно) | Ключи S3, создаются в Garage при первом запуске (`GK` + 32 hex, 64 hex). |
| `INVITE_KEY` | — (обязательно) | Ключ HMAC для кодов приглашений по одобренным запросам (от 32 символов). |
| `REGISTRATION` | `open` | `open` — регистрация для всех; `invite` — только по коду приглашения ([администрирование](administration.md)). |
| `INSTANCE_ADMINS` | пусто | Администраторы инстанса — логины через запятую. Единственный способ назначить администратора. |
| `APP_URL` | `http://localhost:8080` | Публичный адрес приложения (ссылки-приглашения, превью). |
| `SITE_URL` | `APP_URL` | Отдельный сайт для публичных страниц приглашений (`/invite/<код>`), если нужен. |
| `LIVEKIT_PUBLIC_URL` | `ws://localhost:7880` | Адрес LiveKit для клиентов (с доменом — `wss://voice.example.com`). |
| `PUBLIC_IP` | `127.0.0.1` | IP сервера, который LiveKit сообщает клиентам для медиа. |
| `APP_DOMAIN`, `VOICE_DOMAIN` | — | Домены для профиля `https` (Caddy + Let's Encrypt). `VOICE_DOMAIN` — ещё и имя TURN. |
| `HTTP_BIND` | `127.0.0.1:8080` | Адрес HTTP-порта приложения на хосте. |
| `LIVEKIT_SIGNAL_BIND` | `127.0.0.1:7880` | Адрес порта сигнализации LiveKit на хосте (локально; с доменом его отдаёт Caddy). |
| `GEOIP_DB` | пусто | Путь (внутри контейнера) к базе городов `.mmdb` (DB-IP Lite / MaxMind) для журнала сеансов. Пусто — без геолокации. |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Пароль администратора Grafana (профиль `monitoring`). |
| `GRAFANA_BIND` | `127.0.0.1:3000` | Адрес Grafana на хосте. |

Секреты для сервера: `deploy/gen-env.sh > deploy/.env` (это делает и `install.sh`).

## Сервер (бинарник `relay`)

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `DATABASE_URL` | `postgres://relay:relay@127.0.0.1:55432/relay` | Подключение к PostgreSQL; миграции применяются при запуске. |
| `RELAY_ADDR` | `0.0.0.0:8080` | Адрес HTTP (веб-клиент, `/api`, `/gateway`, файлы, обновления). |
| `RELAY_DATA` | `data` | Каталог данных (`updates/` — обновления приложения, локальные файлы). |
| `RELAY_WEB` | `web/dist` | Собранный веб-клиент. |
| `RELAY_APP_URL` | `http://localhost:8080` | Публичный адрес приложения. |
| `RELAY_SITE_URL` | `RELAY_APP_URL` | Публичный адрес страниц приглашений. |
| `RELAY_METRICS_ADDR` | `127.0.0.1:9464` | Метрики Prometheus (держите закрытыми). |
| `LIVEKIT_URL` | `http://livekit:7880` | API сервера LiveKit. |
| `LIVEKIT_PUBLIC_URL` | пусто | Адрес LiveKit для клиентов; пусто — `/rtc` на адресе приложения. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | — | Ключи LiveKit (токены и проверка вебхуков). Без них (или с секретом короче 32 символов) голос выключен. |
| `RELAY_STORAGE` | `local` | `local` (файлы в `RELAY_DATA/uploads`) или `s3`. |
| `RELAY_S3_ENDPOINT`, `RELAY_S3_BUCKET` | — | Адрес S3 и бакет (хранилище `s3`). |
| `RELAY_S3_REGION` | `garage` | Регион S3. |
| `RELAY_S3_ACCESS_KEY`, `RELAY_S3_SECRET_KEY` | — | Ключи S3. |
| `RELAY_STORAGE_FALLBACK_DIR` | пусто | Локальный каталог только для чтения: файлы, которых ещё нет в S3 (после переезда с локального хранения). |
| `RELAY_REGISTRATION` | `open` | `open` или `invite` (регистрация только по приглашениям). |
| `RELAY_INSTANCE_ADMINS` | пусто | Администраторы инстанса (логины через запятую). Если задана — при запуске флаг администратора выставляется ровно по списку; не задана — ничего не меняется. |
| `RELAY_INVITE_KEY` | производный | Ключ HMAC для кодов по одобренным запросам. Не задан — выводится из `LIVEKIT_API_SECRET`; нет и его — случайный на время работы процесса. |
| `RELAY_REGISTER_PER_IP` | `10` | Попыток регистрации с одного IP за 10 минут. |
| `RELAY_REGISTER_GLOBAL` | `100` | Попыток регистрации всего за 10 минут. |
| `RELAY_BAD_CODES_PER_IP` | `5` | Неверных кодов приглашения с одного IP за 10 минут до паузы. |
| `RELAY_LOGIN_FAILS_PER_IP` | `20` | Неудачных входов с одного IP за 10 минут до паузы. |
| `RELAY_INVITE_REQUESTS_PER_HOUR` | `10` | Запросов на приглашение от участника в час. |
| `RELAY_PRESENCE_GRACE_MS` | `15000` | Через сколько отключившийся пользователь показывается «не в сети». |
| `RELAY_ANIMATED_PROFILES` | `true` | Анимированные аватары и баннеры (`0`/`false` — только первый кадр). |
| `RELAY_PREVIEW_ALLOW` | пусто | Имена хостов через запятую, для которых превью ссылок разрешено, даже если они указывают на внутренние адреса. |
| `RELAY_GEOIP_DB` | пусто | База городов `.mmdb` для журнала сеансов. |
| `RELAY_REGIONS_FILE` | пусто | Необязательная конфигурация нескольких узлов (JSON); одному серверу не нужна. |

IP клиента берётся из первого значения `X-Forwarded-For` (его ставит обратный прокси), поэтому сервер должен работать
за прокси, который перезаписывает этот заголовок (Caddy и пример nginx в [deployment.md](deployment.md) так и делают).

## Приложение для Windows (при сборке)

Задаются при сборке `desktop/` ([desktop-client.md](desktop-client.md)) и вшиваются в приложение.

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `RELAY_SERVER` | пусто | Сервер, к которому подключается приложение. Пусто — приложение спросит адрес при первом запуске. |
| `RELAY_ENDPOINTS` | пусто | Несколько точек входа: `id=https://host[#pin][#fallback],…`. Пусто — одна точка `RELAY_SERVER`. |
| `RELAY_PINS` | пусто | SPKI-пины (SHA-256, base64) для точек входа с `#pin` (серверы с самоподписанным сертификатом). |
| `RELAY_UPDATE_KEY` | пусто | Открытый ключ Ed25519 (base64) для проверки обновлений. Пусто — автообновление выключено. |
| `RELAY_UPDATE_CHANNEL` | пусто | Канал обновлений (`test` — `/updates/test/`). |

Для разработки и тестов: `RELAY_DESKTOP_PROFILE` (отдельный профиль и настройки), `RELAY_DESKTOP_DEBUG`,
`RELAY_DESKTOP_CDP` (порт удалённой отладки), `RELAY_DESKTOP_TEST_*` (тестовые хуки).

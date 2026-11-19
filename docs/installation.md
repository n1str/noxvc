# Установка

NoxVC работает в Docker: сервер NoxVC, PostgreSQL (база), Garage (хранилище файлов) и LiveKit (голос, видео,
демонстрация экрана, TURN). Для HTTPS добавляется Caddy, для графиков — мониторинг.

English: [en/installation.md](en/installation.md)

## Вариант 1. Сервер (VDS) — одной командой

### Что нужно заранее

1. **Сервер** с Linux (Ubuntu 22.04/24.04 или Debian 12), x86_64, от 1 ядра и 1 ГБ памяти для работы. Сборка образа
   при первом запуске требует около 4 ГБ памяти — на маленьком сервере включите swap на 4 ГБ или соберите образ на
   другой машине.
2. **Домен** и две DNS-записи типа **A** на IP сервера, например:
   - `app.example.com` — сам NoxVC;
   - `voice.example.com` — голос.
3. **Открытые порты** на сервере (в панели хостинга / файрволе): TCP **80**, **443**, **7881**; UDP **7882**, **3478**.

### Установка

Подключитесь к серверу по SSH и выполните:

```sh
git clone https://github.com/n1str/noxvc.git
cd noxvc
sudo ./install.sh
```

Скрипт:
1. поставит Docker, если его нет (спросит разрешения);
2. спросит адрес приложения (`app.example.com`), адрес для голоса (по умолчанию `voice.<ваш домен>`), публичный IP
   (определит сам) и логин администратора;
3. создаст `deploy/.env` со случайными паролями и ключами;
4. соберёт и запустит всё (первый раз — 5–15 минут);
5. создаст аккаунт администратора и покажет логин и пароль.

Откройте `https://app.example.com`, войдите как администратор и смените пароль в **Настройки → Моя учётная запись**.
Сертификат HTTPS появляется автоматически в течение минуты после того, как DNS-записи указывают на сервер.

### Проверка

- Сайт открывается по HTTPS без предупреждений браузера.
- Создайте сервер, зайдите в голосовой канал с двух устройств — должен быть слышен звук.
- Не работает голос, хотя всё открывается: проверьте порты UDP 7882 / TCP 7881 и `PUBLIC_IP` в `deploy/.env`
  ([развёртывание](deployment.md)).

## Вариант 2. На своём компьютере

Нужен Docker с Compose v2 (Docker Desktop на Windows/macOS).

```sh
git clone https://github.com/n1str/noxvc.git
cd noxvc/deploy
cp .env.example .env
docker compose up -d --build
```

Откройте <http://localhost:8080> и зарегистрируйтесь с логином `admin` — он указан в `INSTANCE_ADMINS` в `.env` и
станет администратором. Голос и демонстрация экрана работают в браузере на этом же компьютере; для других устройств
нужен вариант 1 (HTTPS).

## Вариант 3. Вручную на сервере

Если хотите настроить всё сами:

```sh
cd noxvc/deploy
./gen-env.sh > .env      # случайные секреты
```

В `.env` укажите:

```
INSTANCE_ADMINS=ваш_логин
APP_URL=https://app.example.com
LIVEKIT_PUBLIC_URL=wss://voice.example.com
APP_DOMAIN=app.example.com
VOICE_DOMAIN=voice.example.com
PUBLIC_IP=203.0.113.10        # публичный IPv4 сервера
```

Запуск с HTTPS:

```sh
docker compose --profile https up -d --build
```

Сразу после запуска откройте `https://app.example.com` и зарегистрируйтесь с логином из `INSTANCE_ADMINS` (пока имя
свободно — при открытой регистрации его может занять кто-то другой).

## Обновление

```sh
cd noxvc && git pull
cd deploy && docker compose --profile https up -d --build
```

Миграции базы применяются сами при запуске. Перед обновлением сделайте резервную копию ([backup.md](backup.md)).

## Мониторинг (по желанию)

```sh
cd noxvc/deploy && docker compose --profile monitoring up -d
```

Grafana: <http://localhost:3000> (на сервере — через SSH-туннель), пользователь `admin`, пароль —
`GRAFANA_ADMIN_PASSWORD` из `.env`. Подробнее: [monitoring.md](monitoring.md).

## Полезные команды

```sh
cd noxvc/deploy
docker compose ps                      # что запущено
docker compose logs -f relay           # логи сервера
docker compose --profile https down    # остановить (данные сохраняются)
```

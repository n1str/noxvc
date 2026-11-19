#!/usr/bin/env bash
# NoxVC — установка на сервер (VDS) одной командой / one-command server install.
#   git clone https://github.com/n1str/noxvc.git && cd noxvc && sudo ./install.sh
# Спрашивает домен и имя администратора, создаёт deploy/.env со случайными секретами, запускает всё в Docker
# (HTTPS через Caddy + Let's Encrypt) и сразу создаёт аккаунт администратора.
set -euo pipefail
cd "$(dirname "$0")/deploy"

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
ask() { local q=$1 def=${2:-} a; read -r -p "$q${def:+ [$def]}: " a; echo "${a:-$def}"; }

# ---------- Docker ----------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Docker не найден / Docker not found"
  if [[ $(ask "Установить Docker официальным скриптом get.docker.com? / Install Docker? (y/n)" y) == y ]]; then
    curl -fsSL https://get.docker.com | sh
  else
    echo "Установите Docker с Compose v2 и запустите скрипт снова."; exit 1
  fi
fi

# ---------- вопросы ----------
if [[ -f .env ]]; then
  say "deploy/.env уже есть — используем его (удалите файл, чтобы настроить заново)"
else
  say "Настройка / Setup"
  echo "Нужны две DNS-записи типа A на IP этого сервера, например app.example.com и voice.example.com."
  echo "You need two DNS A records pointing to this server, e.g. app.example.com and voice.example.com."
  APP=$(ask "Адрес приложения / App domain" "")
  [[ -n $APP ]] || { echo "Нужен домен / Domain is required"; exit 1; }
  VOICE=$(ask "Адрес для голоса / Voice domain" "voice.${APP#*.}")
  IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)
  IP=$(ask "Публичный IP сервера / Public IP" "$IP")
  ADMIN=$(ask "Логин администратора / Admin username" "admin")
  ./gen-env.sh > .env
  sed -i -e "s|^INSTANCE_ADMINS=.*|INSTANCE_ADMINS=$ADMIN|" \
         -e "s|^APP_URL=.*|APP_URL=https://$APP|" \
         -e "s|^LIVEKIT_PUBLIC_URL=.*|LIVEKIT_PUBLIC_URL=wss://$VOICE|" \
         -e "s|^APP_DOMAIN=.*|APP_DOMAIN=$APP|" \
         -e "s|^VOICE_DOMAIN=.*|VOICE_DOMAIN=$VOICE|" \
         -e "s|^PUBLIC_IP=.*|PUBLIC_IP=$IP|" .env
  chmod 600 .env
  NEW_ADMIN=$ADMIN
fi

# ---------- запуск ----------
say "Сборка и запуск (первый раз — 5–15 минут) / Building and starting (first time: 5–15 minutes)"
docker compose --profile https up -d --build
printf 'Ожидание сервера / Waiting for the server'
for _ in $(seq 1 120); do
  curl -fs -o /dev/null -w '' http://127.0.0.1:8080/api/instance 2>/dev/null && break
  printf '.'; sleep 2
done
echo

# ---------- администратор ----------
if [[ -n ${NEW_ADMIN:-} ]]; then
  PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  if curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' \
      -d "{\"username\":\"$NEW_ADMIN\",\"password\":\"$PASS\"}" http://127.0.0.1:8080/api/register; then
    ADMIN_LINE="Администратор / Admin: $NEW_ADMIN   Пароль / Password: $PASS   (смените в настройках / change it in settings)"
  else
    ADMIN_LINE="Аккаунт $NEW_ADMIN не создан (имя занято?) / Admin account was not created"
  fi
fi

APP_URL=$(grep '^APP_URL=' .env | cut -d= -f2-)
say "Готово / Done"
echo "  $APP_URL"
[[ -n ${ADMIN_LINE:-} ]] && echo "  $ADMIN_LINE"
cat <<'EOF'

  Откройте порты / Open ports: TCP 80, 443, 7881; UDP 7882, 3478.
  Сертификат HTTPS появится через минуту после того, как DNS укажет на сервер.
  Обновление / Update:  git pull && cd deploy && docker compose --profile https up -d --build
  Логи / Logs:          cd deploy && docker compose logs -f relay
EOF

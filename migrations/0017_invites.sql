-- Закрытая регистрация: аккаунты — только по одноразовым кодам (src/invites.rs). Только новые таблицы.

-- Запросы участников «пригласить человека» — решает администратор инстанса.
CREATE TABLE invite_requests (
  id           BIGSERIAL PRIMARY KEY,
  requester_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id     BIGINT REFERENCES guilds(id) ON DELETE SET NULL,
  invitee      TEXT NOT NULL,
  comment      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled | expired
  reason       TEXT NOT NULL DEFAULT '',
  created_at   BIGINT NOT NULL,
  decided_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at   BIGINT
);
CREATE INDEX invite_requests_status ON invite_requests(status, created_at);
CREATE INDEX invite_requests_requester ON invite_requests(requester_id, status);

-- Коды регистрации: в БД только SHA-256 кода. nonce — у кодов по запросу: код = HMAC(ключ сервера, nonce),
-- автору его можно показать снова (по одной БД без ключа код не восстановить); у созданных вручную nonce нет —
-- код показан один раз.
CREATE TABLE registration_invites (
  id              BIGSERIAL PRIMARY KEY,
  code_hash       TEXT NOT NULL UNIQUE,
  nonce           TEXT,
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  request_id      BIGINT REFERENCES invite_requests(id) ON DELETE SET NULL,
  target_guild_id BIGINT REFERENCES guilds(id) ON DELETE SET NULL,
  created_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  revoked_at      BIGINT,
  used_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  used_at         BIGINT,
  note            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX registration_invites_request ON registration_invites(request_id);

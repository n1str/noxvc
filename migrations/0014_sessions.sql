-- Сеансы: что за клиент, откуда, когда последняя активность (список «Активные сеансы», завершение сеанса).
-- id — публичный номер сеанса (сам токен наружу не отдаётся). Старые сеансы — «неизвестный клиент» до следующего входа.
ALTER TABLE sessions
  ADD COLUMN id         BIGSERIAL,
  ADD COLUMN client     TEXT NOT NULL DEFAULT '',   -- web | desktop
  ADD COLUMN version    TEXT NOT NULL DEFAULT '',   -- версия приложения
  ADD COLUMN os         TEXT NOT NULL DEFAULT '',
  ADD COLUMN browser    TEXT NOT NULL DEFAULT '',
  ADD COLUMN ip         TEXT NOT NULL DEFAULT '',
  ADD COLUMN country    TEXT NOT NULL DEFAULT '',
  ADD COLUMN city       TEXT NOT NULL DEFAULT '',
  ADD COLUMN last_seen  BIGINT;
CREATE UNIQUE INDEX sessions_id ON sessions (id);

-- Журнал безопасности аккаунта: входы, выходы, завершение сеансов, смена пароля.
CREATE TABLE security_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         BIGINT NOT NULL,
  event      TEXT NOT NULL,          -- login | register | logout | session_revoked | sessions_revoked | password_changed
  session_id BIGINT,                 -- сеанс, о котором событие (завершённый, вошедший)
  by_session BIGINT,                 -- с какого сеанса действие
  ip         TEXT NOT NULL DEFAULT '', -- уже замаскированный
  details    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX security_log_user ON security_log (user_id, at DESC);

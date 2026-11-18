-- Обратная связь: баг-репорты и предложения пользователей, статусы, комментарии разработчика.
-- Администратор инстанса (не роль сервера): видит и ведёт все обращения. Назначается через RELAY_INSTANCE_ADMINS.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
-- администраторы инстанса назначаются только через RELAY_INSTANCE_ADMINS (src/invites.rs)

CREATE TABLE feedback (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                 -- bug | idea | other
  category     TEXT NOT NULL,                 -- voice | stream | ui | account | messages | other
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new',   -- new | review | planned | progress | done | rejected | duplicate
  priority     TEXT NOT NULL DEFAULT 'none',  -- none | low | medium | high | critical
  duplicate_of BIGINT REFERENCES feedback(id) ON DELETE SET NULL,
  attachments  JSONB NOT NULL DEFAULT '[]',   -- [{url, name, size, content_type}] — файлы из /api/upload
  diagnostics  JSONB,                          -- версия клиента, ОС, лог клиента, снимок getStats (без токенов)
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  -- непрочитанное автором изменение (статус, комментарий разработчика)
  unread       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX feedback_user ON feedback (user_id, created_at DESC);
CREATE INDEX feedback_status ON feedback (status, created_at DESC);

CREATE TABLE feedback_comments (
  id          BIGSERIAL PRIMARY KEY,
  feedback_id BIGINT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  is_admin    BOOLEAN NOT NULL DEFAULT false,  -- ответ разработчика
  created_at  BIGINT NOT NULL
);
CREATE INDEX feedback_comments_fb ON feedback_comments (feedback_id, created_at);

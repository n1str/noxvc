-- Фаза 3a: несколько вложений, упоминания (кто упомянут — считает сервер).

CREATE TABLE attachments (
  id           BIGSERIAL PRIMARY KEY,
  message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  name         TEXT NOT NULL,
  size         BIGINT NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  position     SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX attachments_message ON attachments (message_id, position);

-- Перенос старых одиночных вложений.
INSERT INTO attachments (message_id, url, name, position)
SELECT id, attachment_url, COALESCE(attachment_name, ''), 0 FROM messages WHERE attachment_url IS NOT NULL;

ALTER TABLE messages
  ADD COLUMN mentions         BIGINT[] NOT NULL DEFAULT '{}', -- упомянутые пользователи (<@id>)
  ADD COLUMN mention_roles    BIGINT[] NOT NULL DEFAULT '{}', -- упомянутые роли (<@&id>)
  ADD COLUMN mention_everyone BOOLEAN NOT NULL DEFAULT FALSE; -- @everyone/@here с правом MENTION_EVERYONE

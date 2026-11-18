-- Фаза 3b: состояние прочтения и настройки уведомлений.

CREATE TABLE read_states (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id  BIGINT NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- Настройки: на сервер (channel_id IS NULL) или на канал (guild_id IS NULL). level: 0 все, 1 только упоминания, 2 ничего.
CREATE TABLE notification_settings (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id          BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id        BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  level             SMALLINT NOT NULL DEFAULT 0 CHECK (level IN (0, 1, 2)),
  muted_until       BIGINT,              -- мс; NULL — не заглушено; -1 — навсегда
  suppress_everyone BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK ((guild_id IS NULL) <> (channel_id IS NULL))
);
CREATE UNIQUE INDEX notification_settings_guild ON notification_settings (user_id, guild_id) WHERE guild_id IS NOT NULL;
CREATE UNIQUE INDEX notification_settings_channel ON notification_settings (user_id, channel_id) WHERE channel_id IS NOT NULL;

-- Для «Входящих»: поиск упоминаний пользователя.
CREATE INDEX messages_mentions ON messages USING GIN (mentions);
CREATE INDEX messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL;

-- Существующие пользователи считаются прочитавшими всё, что уже есть (иначе всё старое станет «непрочитанным»).
INSERT INTO read_states (user_id, channel_id, last_read_id)
SELECT m.user_id, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = c.id), 0)
FROM members m JOIN channels c ON c.guild_id = m.guild_id
UNION ALL
SELECT d.user_id, d.channel_id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = d.channel_id), 0)
FROM dm_members d
ON CONFLICT DO NOTHING;

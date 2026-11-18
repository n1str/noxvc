-- Relay: начальная схема PostgreSQL (перенос модели SQLite один-в-один; время — мс с эпохи, BIGINT).

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  color         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT '',
  created_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE guilds (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   BIGINT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);

CREATE TABLE members (
  guild_id  BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE channels (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   BIGINT REFERENCES guilds(id) ON DELETE CASCADE, -- NULL у личных сообщений
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,                                   -- text | voice | dm
  topic      TEXT NOT NULL DEFAULT '',
  position   BIGINT NOT NULL DEFAULT 0,
  bitrate    BIGINT NOT NULL DEFAULT 64000,
  user_limit BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX channels_guild ON channels (guild_id, position);

CREATE TABLE dm_members (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_members_user ON dm_members (user_id);

CREATE TABLE messages (
  id              BIGSERIAL PRIMARY KEY,
  channel_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id       BIGINT NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  edited_at       BIGINT,
  reply_to        BIGINT,            -- без FK: оригинал может быть удалён, ответ остаётся
  attachment_url  TEXT,
  attachment_name TEXT,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX messages_channel ON messages (channel_id, id DESC);
CREATE INDEX messages_pinned ON messages (channel_id, id DESC) WHERE pinned;

CREATE TABLE reactions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  seq        BIGSERIAL,              -- порядок появления (чипы реакций в порядке добавления)
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  creator_id BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

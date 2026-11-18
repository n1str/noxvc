-- Фаза 3e: ветки, форумы, опросы.

-- Ветка — канал kind='thread' (parent_id — родительский текстовый канал или форум); права — от родителя.
CREATE TABLE threads (
  channel_id           BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  parent_id            BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starter_message_id   BIGINT,                 -- сообщение родительского канала, из которого создана ветка
  archived             BOOLEAN NOT NULL DEFAULT FALSE,
  locked               BOOLEAN NOT NULL DEFAULT FALSE,
  auto_archive_minutes INTEGER NOT NULL DEFAULT 4320,
  applied_tags         BIGINT[] NOT NULL DEFAULT '{}',
  created_at           BIGINT NOT NULL,
  last_message_at      BIGINT NOT NULL,
  message_count        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX threads_starter ON threads (starter_message_id) WHERE starter_message_id IS NOT NULL;
CREATE INDEX threads_parent ON threads (parent_id, archived, last_message_at DESC);

CREATE TABLE thread_members (
  thread_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

-- Теги форума.
CREATE TABLE forum_tags (
  id         BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '',
  position   SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX forum_tags_channel ON forum_tags (channel_id, position);

-- Опросы.
CREATE TABLE polls (
  message_id  BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  multiselect BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at  BIGINT NOT NULL
);
CREATE TABLE poll_answers (
  message_id BIGINT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  id         SMALLINT NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (message_id, id)
);
CREATE TABLE poll_votes (
  message_id BIGINT NOT NULL,
  answer_id  SMALLINT NOT NULL,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voted_at   BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, answer_id),
  FOREIGN KEY (message_id, answer_id) REFERENCES poll_answers(message_id, id) ON DELETE CASCADE
);

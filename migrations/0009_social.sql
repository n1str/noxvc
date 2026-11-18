-- Фаза 4: статусы, профили, приватность, друзья, групповые ЛС.
ALTER TABLE users
  ADD COLUMN presence     TEXT NOT NULL DEFAULT 'online' CHECK (presence IN ('online', 'idle', 'dnd', 'invisible')),
  ADD COLUMN avatar       TEXT,
  ADD COLUMN banner_color TEXT,
  ADD COLUMN bio          TEXT NOT NULL DEFAULT '',
  ADD COLUMN pronouns     TEXT NOT NULL DEFAULT '',
  -- {"friend_requests": "everyone"|"mutual"|"none", "dm_from": "everyone"|"friends"}
  ADD COLUMN privacy      JSONB NOT NULL DEFAULT '{}';

-- Отношения — по строке на каждую сторону (как в Discord): 1 друг, 2 заблокирован мной, 3 входящая заявка, 4 исходящая.
CREATE TABLE relationships (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     SMALLINT NOT NULL CHECK (kind IN (1, 2, 3, 4)),
  since    BIGINT NOT NULL,
  PRIMARY KEY (user_id, other_id)
);
CREATE INDEX relationships_other ON relationships (other_id);

-- Владелец групповой ЛС (kind = 'group_dm').
ALTER TABLE channels ADD COLUMN owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

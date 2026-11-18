-- Роли и права (ADR-009), категории, инвайты со сроком и лимитом.

CREATE TABLE roles (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       INTEGER NOT NULL DEFAULT 0,      -- 0xRRGGBB, 0 = без цвета
  position    BIGINT NOT NULL DEFAULT 0,       -- @everyone = 0, выше = больше
  permissions BIGINT NOT NULL DEFAULT 0,
  hoist       BOOLEAN NOT NULL DEFAULT FALSE,  -- показывать отдельной группой в списке участников
  mentionable BOOLEAN NOT NULL DEFAULT FALSE,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,  -- @everyone
  created_at  BIGINT NOT NULL
);
CREATE UNIQUE INDEX roles_one_default ON roles (guild_id) WHERE is_default;
CREATE INDEX roles_guild ON roles (guild_id, position);

CREATE TABLE member_roles (
  guild_id BIGINT NOT NULL,
  user_id  BIGINT NOT NULL,
  role_id  BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role ON member_roles (role_id);

ALTER TABLE members ADD COLUMN nick TEXT;

ALTER TABLE channels ADD COLUMN parent_id BIGINT REFERENCES channels(id) ON DELETE SET NULL; -- категория

CREATE TABLE permission_overwrites (
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_kind SMALLINT NOT NULL CHECK (target_kind IN (0, 1)), -- 0 = роль, 1 = участник
  target_id   BIGINT NOT NULL,
  allow       BIGINT NOT NULL DEFAULT 0,
  deny        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_kind, target_id)
);

ALTER TABLE invites
  ADD COLUMN max_uses   INTEGER NOT NULL DEFAULT 0, -- 0 = без лимита
  ADD COLUMN uses       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN expires_at BIGINT;                     -- NULL = бессрочно

-- @everyone для существующих серверов: perms::DEFAULT_EVERYONE (сверяется unit-тестом).
INSERT INTO roles (guild_id, name, permissions, is_default, created_at)
SELECT id, '@everyone', 309341834817, TRUE, created_at FROM guilds;

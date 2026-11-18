-- Фаза 3f: эмодзи сервера. В тексте — токен <:имя:id> (анимированные — <a:имя:id>), как в Discord.
CREATE TABLE emojis (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  animated   BOOLEAN NOT NULL DEFAULT FALSE,
  creator_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX emojis_guild_name ON emojis (guild_id, lower(name));

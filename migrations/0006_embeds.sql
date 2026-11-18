-- Фаза 3d: превью ссылок.
ALTER TABLE messages
  ADD COLUMN embeds JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN suppress_embeds BOOLEAN NOT NULL DEFAULT FALSE;
-- Кэш превью по URL (data NULL — у ссылки нечего показать).
CREATE TABLE link_previews (
  url        TEXT PRIMARY KEY,
  data       JSONB,
  fetched_at BIGINT NOT NULL
);

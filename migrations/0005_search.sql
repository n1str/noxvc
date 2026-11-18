-- Фаза 3c: полнотекстовый поиск. Токены упоминаний (<@1>, <#2>, <@&3>) в индекс не попадают.
-- Конфигурация russian: кириллица — русский стемминг, латиница — английский (asciiword → english_stem).
ALTER TABLE messages ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, regexp_replace(content, '<(@&|@|#)\d+>', ' ', 'g'))) STORED;
CREATE INDEX messages_search ON messages USING GIN (search);
CREATE INDEX messages_author ON messages (author_id, id DESC);

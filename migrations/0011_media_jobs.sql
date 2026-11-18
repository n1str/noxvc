-- Аватар через обработку медиа: анимированный ли (есть a{size}.anim.webp) и метки актуальных заданий обработки.
ALTER TABLE users
  ADD COLUMN avatar_anim BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN avatar_job TEXT,
  ADD COLUMN banner_job TEXT;

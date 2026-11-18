-- Баннер профиля (картинка / GIF / видео): {url, poster, kind, crop{x,y,w,h}, accent}. NULL — цвет/градиент.
ALTER TABLE users ADD COLUMN banner JSONB;

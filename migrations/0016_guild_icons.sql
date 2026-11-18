-- Иконка сервера: тот же пайплайн, что у аватара (кадр 1:1, размеры 32–256, анимация под флагом RELAY_ANIMATED_PROFILES).
-- icon — URL a256.webp результата (остальные размеры — рядом: a32/a48/a96/a160, .anim.webp — анимация);
-- icon_job — идущая обработка (метка актуальности: сменили/убрали иконку, пока шла обработка, — результат не применяется).
ALTER TABLE guilds
  ADD COLUMN icon      TEXT,
  ADD COLUMN icon_anim BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN icon_job  TEXT;

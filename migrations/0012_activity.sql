-- Активность «Играет в …». Сама активность — только в памяти сервера (как присутствие), в БД — справочники.

-- Кэш данных Steam по appid: название и обложка (картинка — в хранилище файлов Relay, ключ games/steam-<appid>.jpg).
CREATE TABLE steam_apps (
    appid      BIGINT PRIMARY KEY,
    name       TEXT,
    icon       TEXT,          -- /uploads/games/steam-<appid>.jpg или NULL
    ok         BOOLEAN NOT NULL DEFAULT false,
    fetched_at BIGINT NOT NULL
);

-- Игры, которые клиент узнаёт по имени процесса (и при неоднозначности — по части пути).
-- steam_appid — чтобы взять обложку из Steam и не путать с той же игрой, найденной через Steam.
CREATE TABLE detectable_games (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    exes        TEXT[] NOT NULL,      -- имена exe в нижнем регистре
    path_hint   TEXT,                 -- подстрока полного пути (нижний регистр) или NULL
    steam_appid BIGINT
);

INSERT INTO detectable_games (name, exes, path_hint, steam_appid) VALUES
  ('Dota 2', '{dota2.exe}', NULL, 570),
  ('Counter-Strike 2', '{cs2.exe}', NULL, 730),
  ('PUBG: BATTLEGROUNDS', '{tslgame.exe}', NULL, 578080),
  ('Apex Legends', '{r5apex.exe,r5apex_dx12.exe}', NULL, 1172470),
  ('Rust', '{rustclient.exe}', NULL, 252490),
  ('Grand Theft Auto V', '{gta5.exe,gta5_enhanced.exe}', NULL, 271590),
  ('Team Fortress 2', '{tf_win64.exe,tf.exe}', NULL, 440),
  ('Overwatch 2', '{overwatch.exe}', NULL, 2357570),
  ('Path of Exile', '{pathofexile_x64.exe,pathofexilesteam.exe,pathofexile_x64steam.exe}', NULL, 238960),
  ('ELDEN RING', '{eldenring.exe}', NULL, 1245620),
  ('Cyberpunk 2077', '{cyberpunk2077.exe}', NULL, 1091500),
  ('Baldur''s Gate 3', '{bg3.exe,bg3_dx11.exe}', NULL, 1086940),
  ('Terraria', '{terraria.exe}', NULL, 105600),
  ('Stardew Valley', '{stardew valley.exe}', NULL, 413150),
  ('Rocket League', '{rocketleague.exe}', NULL, 252950),
  ('Warframe', '{warframe.x64.exe}', NULL, 230410),
  ('Destiny 2', '{destiny2.exe}', NULL, 1085660),
  ('Marvel Rivals', '{marvel-win64-shipping.exe}', NULL, 2767030),
  ('HELLDIVERS 2', '{helldivers2.exe}', NULL, 553850),
  ('VALORANT', '{valorant-win64-shipping.exe}', NULL, NULL),
  ('League of Legends', '{league of legends.exe}', NULL, NULL),
  ('Fortnite', '{fortniteclient-win64-shipping.exe}', NULL, NULL),
  ('Minecraft', '{minecraft.windows.exe}', NULL, NULL),
  ('Genshin Impact', '{genshinimpact.exe,yuanshen.exe}', NULL, NULL),
  ('Honkai: Star Rail', '{starrail.exe}', NULL, NULL),
  ('World of Warcraft', '{wow.exe}', NULL, NULL),
  ('osu!', '{osu!.exe}', NULL, NULL),
  ('Roblox', '{robloxplayerbeta.exe}', NULL, NULL),
  ('World of Tanks', '{worldoftanks.exe}', NULL, NULL),
  ('Escape from Tarkov', '{escapefromtarkov.exe}', NULL, NULL),
  ('Hearthstone', '{hearthstone.exe}', NULL, NULL);

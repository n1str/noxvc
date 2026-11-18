// Регрессия импорта старой SQLite в ПУСТОЙ PostgreSQL: у перенесённых серверов должен быть @everyone,
// иначе обычные участники теряют доступ к каналам.
//   node tests/import.mjs prepare <каталог данных>   — создать старый relay.db (до запуска сервера)
//   RELAY_URL=... node tests/import.mjs check         — проверить после запуска сервера на пустой БД
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const TOKEN = 'import-test-token-member-000000000000000000000000';
const [cmd, dir] = process.argv.slice(2);

if (cmd === 'prepare') {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'relay.db'));
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT, color TEXT, status TEXT DEFAULT '', created_at INTEGER);
    CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER);
    CREATE TABLE guilds(id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, created_at INTEGER);
    CREATE TABLE members(guild_id INTEGER, user_id INTEGER, joined_at INTEGER);
    CREATE TABLE channels(id INTEGER PRIMARY KEY, guild_id INTEGER, name TEXT, kind TEXT, topic TEXT DEFAULT '', position INTEGER DEFAULT 0);
    CREATE TABLE dm_members(channel_id INTEGER, user_id INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, channel_id INTEGER, author_id INTEGER, content TEXT, created_at INTEGER, edited_at INTEGER,
      reply_to INTEGER, attachment_url TEXT, attachment_name TEXT, pinned INTEGER DEFAULT 0);
    CREATE TABLE reactions(message_id INTEGER, user_id INTEGER, emoji TEXT);
    CREATE TABLE invites(code TEXT PRIMARY KEY, guild_id INTEGER, creator_id INTEGER, created_at INTEGER);
    INSERT INTO users VALUES (1, 'owner', 'Владелец', 'x', '#7c5cff', '', 1), (2, 'member', 'Участник', 'x', '#ff5c8a', '', 1);
    INSERT INTO sessions VALUES ('${TOKEN}', 2, 1);
    INSERT INTO guilds VALUES (7, 'Старый сервер', 1, 1);
    INSERT INTO members VALUES (7, 1, 1), (7, 2, 2);
    INSERT INTO channels VALUES (30, 7, 'общий', 'text', '', 0);
    INSERT INTO messages VALUES (100, 30, 1, 'старое сообщение', 1, NULL, NULL, NULL, NULL, 0);
  `);
  db.close();
  console.log('старый relay.db создан в', dir);
} else if (cmd === 'check') {
  const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
  const get = (p) => fetch(B + '/api' + p, { headers: { Authorization: 'Bearer ' + TOKEN } }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const g = await get('/guilds/7');
  const msgs = await get('/channels/30/messages');
  const checks = [
    [g.status === 200 && g.data.roles?.some((r) => r.is_default && r.permissions > 0), 'у перенесённого сервера есть @everyone с правами'],
    [g.data?.channels?.some((c) => c.id === 30), 'участник видит перенесённый канал'],
    [msgs.status === 200 && msgs.data.length === 1, 'участник читает перенесённую историю'],
  ];
  let fails = 0;
  for (const [c, m] of checks) { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) fails++; }
  console.log(fails ? `\n${fails} FAIL` : '\nИМПОРТ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
  process.exit(fails ? 1 : 0);
} else {
  console.log('usage: node tests/import.mjs prepare <dir> | check');
  process.exit(2);
}

// Наполнение демо-стенда (tests/demo/compose.yaml) выдуманными данными для скриншотов лендинга.
//   DEMO_URL=http://127.0.0.1:18299 node tests/demo/seed.mjs   → tests/demo/.seed.json (токены, id; в Git не попадает)
// Люди, серверы и переписка — выдуманные; аватары, баннеры и иконка — абстрактные градиенты (рисует Chrome).
import { createRequire } from 'node:module';
// закрытая регистрация: коды — через CLI демо-стенда (tests/register-codes.mjs)
process.env.RELAY_TEST_CONTAINER ??= 'noxvc-demo-relay-1';
await import('../register-codes.mjs');
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.DEMO_URL || 'http://127.0.0.1:18299';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function api(tok, method, path, body) {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function upload(tok, name, png) {
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), name);
  const r = await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
  if (!r.ok) throw new Error('upload ' + r.status);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- картинки: абстракция, без людей и персонажей ----------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
async function art(w, h, body) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${body}</body></html>`);
  return page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
}
const avatarArt = (a, b, c, shape) => art(256, 256, `<svg width="256" height="256" viewBox="0 0 256 256"><defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
  <radialGradient id="r" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
  <rect width="256" height="256" fill="url(#g)"/>${shape(c)}<rect width="256" height="256" fill="url(#r)"/></svg>`);
const SHAPES = [
  (c) => `<circle cx="168" cy="160" r="70" fill="${c}" opacity=".75"/><circle cx="92" cy="96" r="38" fill="#fff" opacity=".25"/>`,
  (c) => `<path d="M0 180 C60 120 120 220 256 140 V256 H0Z" fill="${c}" opacity=".8"/><path d="M0 210 C80 170 150 250 256 190 V256 H0Z" fill="#fff" opacity=".18"/>`,
  (c) => `<rect x="70" y="70" width="120" height="120" rx="28" transform="rotate(18 128 128)" fill="${c}" opacity=".7"/>`,
  (c) => `<path d="M128 40 L216 200 H40Z" fill="${c}" opacity=".7"/><circle cx="128" cy="150" r="26" fill="#fff" opacity=".3"/>`,
  (c) => `<g fill="${c}" opacity=".75"><circle cx="70" cy="80" r="22"/><circle cx="150" cy="70" r="16"/><circle cx="190" cy="150" r="30"/><circle cx="100" cy="180" r="26"/></g>`,
  (c) => `<path d="M40 128 Q128 20 216 128 Q128 236 40 128Z" fill="${c}" opacity=".7"/><circle cx="128" cy="128" r="20" fill="#fff" opacity=".35"/>`,
];
const bannerArt = (a, b, c) => art(1200, 480, `<svg width="1200" height="480" viewBox="0 0 1200 480"><defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="1200" height="480" fill="url(#g)"/>
  <path d="M0 320 C200 220 400 400 640 300 S1000 200 1200 280 V480 H0Z" fill="${c}" opacity=".55"/>
  <path d="M0 380 C260 300 520 460 760 370 S1060 320 1200 360 V480 H0Z" fill="#fff" opacity=".12"/>
  <circle cx="930" cy="140" r="90" fill="#fff" opacity=".14"/><circle cx="980" cy="120" r="40" fill="#fff" opacity=".12"/></svg>`);
const sunset = () => art(1280, 720, `<svg width="1280" height="720" viewBox="0 0 1280 720"><defs>
  <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b1d5c"/><stop offset=".5" stop-color="#c2537a"/><stop offset=".75" stop-color="#f3a35b"/><stop offset="1" stop-color="#ffd9a0"/></linearGradient></defs>
  <rect width="1280" height="720" fill="url(#s)"/><circle cx="640" cy="520" r="120" fill="#ffe7b8" opacity=".9"/>
  <path d="M0 560 L180 470 L330 540 L520 430 L700 530 L880 450 L1060 520 L1280 440 V720 H0Z" fill="#1b1430"/>
  <path d="M0 620 L240 560 L420 610 L640 540 L860 620 L1080 570 L1280 610 V720 H0Z" fill="#120d22"/></svg>`);
const guildIcon = () => art(256, 256, `<svg width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#4c1d95"/></linearGradient></defs>
  <rect width="256" height="256" fill="url(#g)"/><circle cx="160" cy="96" r="44" fill="#e9d5ff"/><circle cx="182" cy="80" r="40" fill="url(#g)"/>
  <g fill="#fff"><circle cx="70" cy="60" r="3"/><circle cx="96" cy="150" r="2.5"/><circle cx="200" cy="190" r="3"/><circle cx="60" cy="200" r="2"/></g></svg>`);

// ---------- пользователи ----------
const PEOPLE = [
  ['alex', 'Alex', ['#6d5dfc', '#2b1d77', '#a78bfa'], 'Собираю всех по вечерам', 'Люблю кооперативы и хорошие колонки.'],
  ['mira', 'Mira', ['#f472b6', '#7c3aed', '#fde68a'], 'Рисую обложки', 'Иллюстратор. Отвечаю медленно, но с картинками.'],
  ['kirill', 'Kirill', ['#22d3ee', '#1e3a8a', '#a5f3fc'], 'Доделываю отчёт', 'Бэкенд, кофе и настолки.'],
  ['dasha', 'Dasha', ['#34d399', '#065f46', '#d9f99d'], 'В голосовом после девяти', 'Стратегии, пазлы и пицца по пятницам.'],
  ['ghost', 'Ghost', ['#94a3b8', '#1e293b', '#e2e8f0'], '', 'Появляюсь, когда начинается рейд.'],
  ['nightowl', 'Nightowl', ['#fb923c', '#7c2d12', '#fde047'], 'Не сплю', 'Онлайн после полуночи.'],
];
const PASS = 'demo-' + Math.random().toString(36).slice(2, 12);
const U = {};
for (const [i, [login, name, [a, b, c], status, bio]] of PEOPLE.entries()) {
  const r = await api(null, 'POST', '/register', { username: login, password: PASS });
  const tok = r.token;
  const me = await api(tok, 'GET', '/me');
  const av = await upload(tok, `${login}.png`, await avatarArt(a, b, c, SHAPES[i]));
  const bn = await upload(tok, `${login}-banner.png`, await bannerArt(b, a, c));
  await api(tok, 'PATCH', '/me', { display_name: name, bio, ...(status && { status }), avatar: av.url, banner: { url: bn.url }, banner_color: a });
  U[login] = { token: tok, id: me.id ?? me.user?.id, name };
}
console.log('пользователи:', Object.keys(U).join(', '));

// ---------- сервер ----------
const A = U.alex.token;
// акцент сервера в приложении — по id (web/src/design/tokens.ts: палитра[id % 8]); 1 — фиолетовый, как у бренда
let g = await api(A, 'POST', '/guilds', { name: 'Ночная смена' });
while (g.id % 8 !== 1) { await api(A, 'DELETE', `/guilds/${g.id}`); g = await api(A, 'POST', '/guilds', { name: 'Ночная смена' }); }
const ic = await upload(A, 'guild.png', await guildIcon());
await api(A, 'PUT', `/guilds/${g.id}/icon`, { url: ic.url });
const { code } = await api(A, 'POST', `/guilds/${g.id}/invites`, {});
for (const l of ['mira', 'kirill', 'dasha', 'ghost', 'nightowl']) await api(U[l].token, 'POST', `/invites/${code}`);
// каналы: убрать созданные по умолчанию, сделать свои
{ const d = await api(A, 'GET', `/guilds/${g.id}`); for (const ch of [...(d.channels ?? []), ...(d.categories ?? [])]) await api(A, 'DELETE', `/channels/${ch.id}`).catch(() => {}); }
// без своих категорий: интерфейс сам группирует «Текстовые каналы» / «Голосовые каналы»
const general = await api(A, 'POST', `/guilds/${g.id}/channels`, { name: 'общий', kind: 'text', topic: 'Планы на вечер и всё остальное' });
const ideas = await api(A, 'POST', `/guilds/${g.id}/channels`, { name: 'идеи', kind: 'text' });
const pics = await api(A, 'POST', `/guilds/${g.id}/channels`, { name: 'скриншоты', kind: 'text' });
const lounge = await api(A, 'POST', `/guilds/${g.id}/channels`, { name: 'Гостиная', kind: 'voice' });
const games = await api(A, 'POST', `/guilds/${g.id}/channels`, { name: 'Игровая', kind: 'voice' });
// роли
const mods = await api(A, 'POST', `/guilds/${g.id}/roles`, { name: 'Модераторы', color: 0x9776fb, hoist: true });
const friends = await api(A, 'POST', `/guilds/${g.id}/roles`, { name: 'Друзья', color: 0x2dd4bf, hoist: true });
for (const l of ['mira']) await api(A, 'PUT', `/guilds/${g.id}/members/${U[l].id}/roles/${mods.id}`);
for (const l of ['kirill', 'dasha', 'ghost', 'nightowl']) await api(A, 'PUT', `/guilds/${g.id}/members/${U[l].id}/roles/${friends.id}`);

// ---------- переписка ----------
const say = async (l, content, extra = {}, ch = general.id) => { const m = await api(U[l].token, 'POST', `/channels/${ch}/messages`, { content, ...extra }); await sleep(250); return m; };
const react = (l, m, e) => api(U[l].token, 'PUT', `/messages/${m.id}/reactions/${encodeURIComponent(e)}`);
const m1 = await say('mira', 'Всем привет! Кто сегодня вечером в голосовом?');
await say('kirill', 'Я буду после девяти, доделываю отчёт');
const m3 = await say('dasha', 'Я тоже. Давайте наконец пройдём ту кооперативку до конца 🎮');
await react('alex', m3, '🔥'); await react('mira', m3, '🔥'); await react('ghost', m3, '👍');
await say('nightowl', 'Буду ближе к полуночи, как обычно 🦉', { reply_to: m1.id });
await react('mira', m1, '❤️');
const poll = await say('alex', '', { poll: { question: 'Во что играем вечером?', answers: ['Кооператив', 'Стратегия', 'Просто поболтать'], duration_hours: 24 } });
const sun = await upload(U.mira.token, 'zakat.png', await sunset());
const mPic = await say('mira', 'Вчерашний закат с балкона — почти как обложка', { attachments: [sun] });
await react('dasha', mPic, '😍'); await react('kirill', mPic, '😍'); await react('alex', mPic, '❤️');
const mNotes = await say('alex', 'Собрал заметки по субботней встрече — давайте обсудим в ветке');
await say('ghost', 'Обновил клиент, теперь трансляция идёт без подтормаживаний 👌');
await react('alex', (await say('kirill', 'Кто-нибудь, напомните мне в девять 😅')), '😂');
// голоса в опросе (id ответов — из сообщения)
const answers = poll.poll?.answers ?? [];
const vote = (l, idx) => answers[idx] && api(U[l].token, 'PUT', `/messages/${poll.id}/poll/votes`, { answers: [answers[idx].id ?? idx + 1] }).catch((e) => console.log('голос:', e.message));
await vote('alex', 0); await vote('mira', 0); await vote('kirill', 0); await vote('dasha', 0); await vote('ghost', 1); await vote('nightowl', 2);
// ветка
const th = await api(A, 'POST', `/channels/${general.id}/threads`, { name: 'Встреча в субботу', message_id: mNotes.id });
const thId = th.id ?? th.thread?.id ?? th.channel?.id;
await say('mira', 'Предлагаю начать в шесть вечера', {}, thId);
await say('kirill', 'Возьму колонку и пару настолок', {}, thId);
await say('dasha', 'Я за пиццу 🍕', {}, thId);
// другие каналы — чтобы не пустовали
await say('mira', 'Идея: устроить вечер настолок раз в месяц', {}, ideas.id);
await say('kirill', 'Поддерживаю, могу собрать список игр', {}, ideas.id);
await say('ghost', 'Новый рекорд в забеге 🏁', {}, pics.id);

await browser.close();
const out = fileURLToPath(new URL('./.seed.json', import.meta.url));
writeFileSync(out, JSON.stringify({ url: B, guild: g.id, channels: { general: general.id, ideas: ideas.id, pics: pics.id, lounge: lounge.id, games: games.id, thread: thId }, users: U }, null, 2));
console.log('готово:', out);

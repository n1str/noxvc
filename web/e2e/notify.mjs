// E2E фазы 3b: непрочитанное с сервера, маркер, синхронизация прочтения между вкладками, «Входящие»,
// настройки уведомлений (заглушение), «отметить прочитанным», счётчик в заголовке, звук.
//   RELAY_URL=http://127.0.0.1:8099 node e2e/notify.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-3b/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'nina' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'oleg' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Уведомления ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const general = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'text');
const news = await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'новости' });
const flood = await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'флуд' });
const post = (ch, content) => api(a.token, 'POST', `/channels/${ch}/messages`, { content });
const readState = async (ch) => (await api(b.token, 'GET', '/me')).read_states.find((r) => r.channel_id === ch);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(([t, gid]) => {
  localStorage.setItem('relay_token', JSON.stringify(t));
  localStorage.setItem('relay_view', JSON.stringify(gid));
  // Считаем сигналы: подменяем AudioContext (в headless звука всё равно нет).
  window.__pings = 0;
  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createOscillator() { window.__pings += 0.5; return { frequency: {}, connect: (x) => x, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }; }
  };
}, [b.token, g.id]);
async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
const row = (p, name) => p.locator('.channel', { hasText: name });
const pings = (p) => p.evaluate(() => window.__pings);

const p1 = await open();
try {
  await row(p1, general.name).click();
  await p1.waitForTimeout(300);

  // непрочитанное в другом канале: жирный канал, без бейджа; упоминание — бейдж и счётчик в заголовке
  await post(news.id, 'обычная новость');
  await p1.locator('.channel.unread', { hasText: 'новости' }).waitFor({ timeout: 4000 });
  ok(await row(p1, 'новости').locator('.badge').count() === 0, 'обычное сообщение: канал жирный, бейджа нет');
  ok((await p1.title()) === '• Relay', 'заголовок: • при непрочитанном');
  const before = await pings(p1);
  await post(news.id, `<@${b.user.id}> глянь`);
  await row(p1, 'новости').locator('.badge', { hasText: '1' }).waitFor({ timeout: 4000 });
  ok(true, 'упоминание: бейдж 1 у канала');
  await p1.waitForFunction(() => document.title === '(1) Relay', null, { timeout: 3000 });
  ok(true, 'заголовок вкладки: (1) Relay');
  ok((await pings(p1)) > before, 'упоминание: звуковой сигнал');
  const p2 = await open(); // вторая вкладка того же пользователя — состояние с сервера
  await row(p2, 'новости').locator('.badge', { hasText: '1' }).waitFor({ timeout: 4000 });
  ok(true, 'вторая вкладка: непрочитанное и упоминание пришли с сервера');
  await p1.screenshot({ path: shot('unread-badges.png') });

  // открыли канал: маркер «новые», прочитано на сервере, вторая вкладка погасила бейдж
  await p1.bringToFront();
  await row(p1, 'новости').click();
  await p1.locator('.new-marker').waitFor({ timeout: 4000 });
  ok((await p1.evaluate(() => document.querySelector('.new-marker')?.nextElementSibling?.textContent || '')).includes('обычная новость'), 'маркер перед первым непрочитанным');
  await p1.waitForFunction(() => !document.querySelector('.channel.unread'), null, { timeout: 4000 });
  const rs = await readState(news.id);
  ok(rs.last_read_id === rs.last_message_id && rs.mention_count === 0, 'ack: прочитано на сервере');
  await p2.waitForFunction(() => !document.querySelector('.channel .badge') && !document.querySelector('.channel.unread'), null, { timeout: 4000 });
  ok(true, 'вторая вкладка: прочтение синхронизировано (MESSAGE_ACK)');
  await p2.close();

  // «Входящие»: упоминание → клик → переход к сообщению
  await row(p1, general.name).click();
  await p1.getByRole('button', { name: 'Входящие' }).click();
  await p1.locator('.inbox-item', { hasText: 'глянь' }).waitFor({ timeout: 4000 });
  await p1.screenshot({ path: shot('inbox.png') });
  await p1.locator('.inbox-item', { hasText: 'глянь' }).click();
  await p1.locator('.chat-header h1', { hasText: 'новости' }).waitFor({ timeout: 4000 });
  await p1.locator('.msg.flash', { hasText: 'глянь' }).waitFor({ timeout: 4000 });
  ok(true, '«Входящие»: переход к сообщению с подсветкой');

  // настройки уведомлений канала: заглушить → не светится, без звука
  await row(p1, general.name).click();
  await row(p1, 'флуд').click({ button: 'right' });
  await p1.getByRole('menuitem', { name: 'Уведомления' }).click();
  await p1.locator('.modal select').selectOption('muteForever');
  await p1.screenshot({ path: shot('notify-settings.png') });
  await p1.locator('.modal button[type="submit"]').click();
  await p1.locator('.channel.muted-ch', { hasText: 'флуд' }).waitFor({ timeout: 4000 });
  ok(true, 'заглушённый канал приглушён в списке');
  const settings = (await api(b.token, 'GET', '/me')).notification_settings;
  ok(settings.some((x) => x.channel_id === flood.id && x.muted_until === -1), 'настройка сохранена на сервере');
  const p0 = await pings(p1);
  await post(flood.id, `<@${b.user.id}> в заглушённом`);
  await post(flood.id, 'шум');
  await row(p1, 'флуд').locator('.badge').waitFor({ timeout: 4000 });
  ok(!(await row(p1, 'флуд').evaluate((el) => el.classList.contains('unread'))), 'заглушённый: не жирный, но упоминание считается');
  ok((await pings(p1)) === p0, 'заглушённый: без звука');

  // по умолчанию на сервере — только упоминания: обычное сообщение без звука
  const p3 = await pings(p1);
  await post(news.id, 'тихая новость');
  await p1.locator('.channel.unread', { hasText: 'новости' }).waitFor({ timeout: 4000 });
  ok((await pings(p1)) === p3, 'уровень «только упоминания» (по умолчанию): обычное — без звука');

  // «Отметить как прочитанное» для всего сервера (меню в рейке)
  await p1.locator('.rail-btn[aria-label="Уведомления ' + sfx + '"]').click({ button: 'right' });
  await p1.getByRole('menuitem', { name: 'Отметить как прочитанное' }).click();
  await p1.waitForFunction(() => !document.querySelector('.channel.unread') && !document.querySelector('.channel .badge'), null, { timeout: 4000 });
  ok((await p1.title()) === 'Relay', 'сервер отмечен прочитанным, заголовок чистый');

  // перезагрузка: состояние живёт на сервере
  await post(news.id, 'пока вас не было');
  await p1.reload();
  await p1.waitForSelector('.shell');
  await p1.locator('.channel.unread', { hasText: 'новости' }).waitFor({ timeout: 4000 });
  ok(true, 'после перезагрузки непрочитанное на месте');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await p1.screenshot({ path: shot('failure.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nУВЕДОМЛЕНИЯ UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

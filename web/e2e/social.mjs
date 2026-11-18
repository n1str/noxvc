// E2E фазы 4: друзья (заявка → принять), статусы, групповые ЛС, профиль (настройки → предпросмотр → полный профиль),
// смена пароля, блокировка (свёрнутые сообщения).
//   RELAY_URL=http://127.0.0.1:8099 node e2e/social.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-4/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
function png(w, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < w; y++) { const row = [0]; for (let x = 0; x < w; x++) { const k = (x + y) % 32 < 16; row.push(k ? r : 255, k ? g : 255, k ? b : 255); } rows.push(Buffer.from(row)); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const dir = join(tmpdir(), 'relay-social-' + Date.now());
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'me.png'), png(96, [120, 80, 220]));

const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'alisa' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'boris' + sfx, password: 'secret12' });
const c = await api(null, 'POST', '/register', { username: 'vika' + sfx, password: 'secret12' });
// alisa и vika — уже друзья (через API)
await api(a.token, 'POST', '/relationships', { user_id: c.user.id });
await api(c.token, 'POST', '/relationships', { user_id: a.user.id });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(token) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify('home')); }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
const pa = await open(a.token), pb = await open(b.token);
const box = (p) => p.locator('.composer textarea');
try {
  // «Домой» — страница друзей; заявка по имени
  await pa.locator('.friends-header').waitFor({ timeout: 5000 });
  ok(true, '«Домой» открывает страницу друзей');
  await pa.locator('.friend-tab.add').click();
  await pa.locator('.add-friend input').fill('boris' + sfx);
  await pa.locator('.add-friend').getByRole('button', { name: 'Отправить заявку' }).click();
  await pa.locator('.add-friend .success').waitFor({ timeout: 4000 });
  ok(true, 'заявка отправлена по имени');
  await pa.locator('.friend-tab.add').screenshot({ path: shot('add-friend-tab.png') }).catch(() => {});

  // у второго — бейдж и принятие
  await pb.locator('.sidebar .channel', { hasText: 'Друзья' }).locator('.badge', { hasText: '1' }).waitFor({ timeout: 4000 });
  ok(true, 'у получателя — бейдж заявок у «Друзья»');
  await pb.locator('.friend-tab', { hasText: 'Ожидание' }).click();
  await pb.locator('.friend-row', { hasText: 'alisa' + sfx }).getByRole('button', { name: 'Принять' }).click();
  await pb.locator('.friend-tab', { hasText: 'В сети' }).click();
  await pb.locator('.friend-row', { hasText: 'alisa' + sfx }).waitFor({ timeout: 4000 });
  ok(true, 'заявка принята, друг в сети');

  // статус «Не беспокоить» виден другу
  await pb.locator('.me-avatar').click();
  await pb.locator('.status-item', { hasText: 'Не беспокоить' }).click();
  await pa.locator('.friend-tab', { hasText: 'Все' }).click();
  await pa.locator('.friend-row', { hasText: 'boris' + sfx }).locator('.status-dot.dnd').waitFor({ timeout: 4000 });
  ok(true, 'статус «Не беспокоить» виден другу');
  await pa.screenshot({ path: shot('friends.png') });
  await pb.locator('.me-avatar').click();
  await pb.screenshot({ path: shot('status-picker.png') });
  await pb.waitForTimeout(600);
  // прошлый поповер доигрывает анимацию закрытия
  await pb.locator('.status-item', { hasText: 'Невидимка' }).click();
  await pa.locator('.friend-row', { hasText: 'boris' + sfx }).locator('.status-dot.offline').waitFor({ timeout: 4000 });
  ok(true, 'невидимка для друга — не в сети');
  await pb.locator('.me-avatar').click();
  await pb.locator('.status-item', { hasText: 'В сети' }).first().click();

  // групповая ЛС
  await pa.locator('.channel-group-title', { hasText: 'Личные сообщения' }).getByRole('button', { name: 'Создать группу' }).click();
  await pa.locator('.modal input[name="name"]').fill('Команда');
  await pa.locator('.friend-pick', { hasText: 'boris' + sfx }).click();
  await pa.locator('.friend-pick', { hasText: 'vika' + sfx }).click();
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.chat-header h1', { hasText: 'Команда' }).waitFor({ timeout: 5000 });
  ok(await pa.locator('.group-members .member').count() === 3, 'группа создана, справа — 3 участника');
  await pb.locator('.channel.dm', { hasText: 'Команда' }).click();
  await box(pb).fill('Всем привет в группе!');
  await pb.keyboard.press('Enter');
  await pa.locator('.msg', { hasText: 'Всем привет в группе!' }).waitFor({ timeout: 4000 });
  ok(true, 'сообщение в группе видно всем');
  await pa.screenshot({ path: shot('group-dm.png') });

  // профиль в настройках: аватар, баннер, о себе → предпросмотр → сохранить
  await pa.locator('.user-panel').getByRole('button', { name: 'Настройки' }).click();
  await pa.locator('.settings-tab', { hasText: 'Профиль' }).click();
  await pa.locator('.us-profile input[type="file"]').setInputFiles(join(dir, 'me.png'));
  await pa.locator('.us-preview .avatar img').waitFor({ timeout: 5000 });
  await pa.locator('.banner-swatch').nth(4).click();
  await pa.getByLabel('Местоимения').fill('она/её');
  await pa.locator('.us-profile textarea').fill('Люблю походы и Rust');
  ok((await pa.locator('.us-preview').textContent()).includes('Люблю походы'), 'предпросмотр профиля обновляется сразу');
  await pa.screenshot({ path: shot('settings-profile.png') });
  await pa.locator('.unsaved-bar').getByRole('button', { name: 'Сохранить изменения' }).click();
  await pa.locator('.unsaved-bar').waitFor({ state: 'detached', timeout: 4000 });
  ok(true, 'профиль сохранён');

  // смена пароля
  await pa.locator('.settings-tab', { hasText: 'Моя учётная запись' }).click();
  await pa.getByRole('button', { name: 'Изменить пароль' }).click();
  await pa.locator('.modal input[name="current"]').fill('secret12');
  await pa.locator('.modal input[name="new"]').fill('newpass12');
  await pa.locator('.modal input[name="repeat"]').fill('newpass12');
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.toast', { hasText: 'Пароль изменён' }).waitFor({ timeout: 4000 });
  ok((await api(null, 'POST', '/login', { username: 'alisa' + sfx, password: 'newpass12' }))?.token, 'пароль сменён — вход с новым');
  await pa.keyboard.press('Escape');

  // у второго — аватар и полный профиль
  await pb.locator('.msg', { hasText: 'Всем привет' }).waitFor();
  await box(pa).fill('Как вам мой новый аватар?');
  await pa.keyboard.press('Enter');
  const msgA = pb.locator('.msg', { hasText: 'новый аватар' });
  await msgA.locator('.avatar img').waitFor({ timeout: 5000 });
  ok(true, 'новый аватар виден в сообщениях');
  await msgA.locator('.avatar-btn').click();
  await pb.locator('.profile-card .profile-bio', { hasText: 'Люблю походы' }).waitFor({ timeout: 4000 });
  ok((await pb.locator('.profile-card').textContent()).includes('она/её'), 'мини-профиль: о себе и местоимения');
  await pb.locator('.profile-card .link-btn', { hasText: 'Открыть профиль' }).click();
  await pb.locator('.profile-modal').waitFor({ timeout: 4000 });
  await pb.locator('.profile-modal .th-tab', { hasText: 'Общие друзья' }).click();
  await pb.waitForTimeout(300);
  await pb.screenshot({ path: shot('profile-modal.png') });
  ok(true, 'полный профиль открыт');
  await pb.keyboard.press('Escape');

  // блокировка: сообщения заблокированного свёрнуты
  await api(c.token, 'POST', `/channels/${(await api(c.token, 'GET', '/me')).dms.find((d) => d.kind === 'group_dm').id}/messages`, { content: 'сообщение от вики' });
  await pa.locator('.msg', { hasText: 'сообщение от вики' }).waitFor({ timeout: 4000 });
  await api(a.token, 'PUT', `/relationships/${c.user.id}/block`);
  await pa.locator('.blocked-msg').waitFor({ timeout: 4000 });
  ok(await pa.locator('.msg', { hasText: 'сообщение от вики' }).count() === 0, 'сообщение заблокированного свёрнуто');
  await pa.locator('.blocked-msg').getByRole('button', { name: 'Показать' }).click();
  await pa.locator('.msg', { hasText: 'сообщение от вики' }).waitFor({ timeout: 3000 });
  ok(true, '«Показать» раскрывает сообщение');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pa.screenshot({ path: shot('failure-a.png') }).catch(() => {});
  await pb.screenshot({ path: shot('failure-b.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(fails ? `\n${fails} FAIL` : '\nСОЦИАЛЬНОЕ UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

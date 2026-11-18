// E2E фазы 3f: эмодзи сервера — загрузка во вкладке настроек, автодополнение :имя:, пикер, реакция,
// крупный показ, правка (в поле — :имя:), переименование и удаление.
//   RELAY_URL=http://127.0.0.1:8099 node e2e/emojis.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-3f/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
/** Круглая «рожица» w×w (PNG без зависимостей). */
function face(w, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < w; y++) {
    const row = [0];
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - w / 2, d = Math.hypot(dx, dy);
      const eye = Math.hypot(Math.abs(dx) - w / 6, dy + w / 8) < w / 14;
      const mouth = d < w / 3.2 && d > w / 4.2 && dy > w / 10;
      if (d > w / 2 - 1) row.push(0, 0, 0, 0); else if (eye || mouth) row.push(30, 30, 30, 255); else row.push(r, g, b, 255);
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const dir = join(tmpdir(), 'relay-emoji-' + Date.now());
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'happy_cat.png'), face(64, [250, 200, 60]));
writeFileSync(join(dir, 'blue blob.png'), face(64, [80, 140, 250]));

const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'olga' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'petr' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Смайлы ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const text = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'text');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(token) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([t, gid]) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(gid)); }, [token, g.id]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
const pa = await open(a.token), pb = await open(b.token);
const box = (p) => p.locator('.composer textarea');
try {
  await pa.locator('.channel', { hasText: text.name }).first().click();
  await pb.locator('.channel', { hasText: text.name }).first().click();

  // загрузка двух эмодзи во вкладке настроек
  await pa.locator('.sidebar-header').click();
  await pa.getByRole('menuitem', { name: 'Настройки сервера' }).click();
  await pa.locator('.settings-tab', { hasText: 'Эмодзи' }).click();
  await pa.locator('.emoji-tab input[type="file"]').setInputFiles([join(dir, 'happy_cat.png'), join(dir, 'blue blob.png')]);
  await pa.locator('.emoji-table-row').nth(1).waitFor({ timeout: 6000 });
  const names = await pa.locator('.emoji-name').evaluateAll((els) => els.map((e) => e.value));
  ok(names.includes('happy_cat') && names.includes('blue_blob'), 'загружены два эмодзи, имена из файлов (пробел → _)');
  await pa.waitForTimeout(500);
  await pa.screenshot({ path: shot('settings-emoji.png') });
  await pa.keyboard.press('Escape');

  // автодополнение :имя: у второго (эмодзи пришли по gateway)
  await box(pb).click();
  await pb.keyboard.type('смотри :happ');
  await pb.locator('.autocomplete .ac-item', { hasText: ':happy_cat:' }).waitFor({ timeout: 4000 });
  ok(await pb.locator('.autocomplete .ac-item').first().locator('.ac-emoji-img').count() === 1, 'автодополнение: эмодзи сервера первыми, с картинкой');
  await pb.keyboard.press('Enter');
  ok((await box(pb).inputValue()).includes(':happy_cat: '), 'в поле — читаемое :имя:');
  await pb.keyboard.press('Enter');
  const sent = pb.locator('.msg', { hasText: 'смотри' }).last();
  await sent.locator('img.emoji-custom').waitFor({ timeout: 4000 });
  const last = (await api(a.token, 'GET', `/channels/${text.id}/messages?limit=1`))[0];
  ok(/<:happy_cat:\d+>/.test(last.content), 'на сервер ушёл токен <:happy_cat:id>');
  await pa.locator('.msg', { hasText: 'смотри' }).locator('img.emoji-custom').waitFor({ timeout: 4000 });
  ok(true, 'у первого — картинка эмодзи в сообщении');

  // пикер: раздел сервера, вставка
  await pb.locator('.composer-row').getByRole('button', { name: 'Эмодзи' }).click();
  await pb.locator('.emoji-head', { hasText: 'Смайлы ' + sfx }).waitFor({ timeout: 4000 });
  await pb.locator('.emoji-custom-btn[title=":blue_blob:"]').click();
  ok((await box(pb).inputValue()).includes(':blue_blob:'), 'пикер: раздел «эмодзи сервера», вставка :имя:');
  await box(pb).fill('');

  // только эмодзи — крупно
  await box(pb).click();
  await pb.keyboard.type(':blue_b');
  await pb.locator('.autocomplete .ac-item', { hasText: ':blue_blob:' }).waitFor({ timeout: 4000 });
  await pb.keyboard.press('Enter');
  await pb.keyboard.press('Enter');
  await pa.locator('.msg-content.emoji-only img.emoji-custom.big').waitFor({ timeout: 4000 });
  ok(true, 'сообщение только из эмодзи — крупно');

  // реакция эмодзи сервера из пикера
  const target = pa.locator('.msg', { hasText: 'смотри' });
  await target.hover();
  await target.getByRole('button', { name: 'Реакция' }).click();
  await pa.locator('.emoji-custom-btn[title=":happy_cat:"]').click();
  await pb.locator('.msg', { hasText: 'смотри' }).locator('.reaction img.emoji-custom').waitFor({ timeout: 4000 });
  ok(true, 'реакция эмодзи сервера видна у второго');
  await pb.locator('.msg', { hasText: 'смотри' }).locator('.reaction').click();
  await pa.locator('.msg', { hasText: 'смотри' }).locator('.reaction', { hasText: '2' }).waitFor({ timeout: 4000 });
  ok(true, 'второй присоединился к реакции (одна группа)');
  await pa.screenshot({ path: shot('chat-emoji.png') });

  // правка: токен показан как :имя: и сохраняется обратно токеном
  const mine = pb.locator('.msg', { hasText: 'смотри' });
  await mine.hover();
  await mine.getByRole('button', { name: 'Изменить' }).click();
  const edit = pb.locator('.msg-edit textarea');
  ok((await edit.inputValue()).includes(':happy_cat:'), 'правка: в поле :имя:, не токен');
  await edit.fill((await edit.inputValue()) + ' ещё');
  await pb.keyboard.press('Enter');
  await pa.locator('.msg', { hasText: 'ещё' }).locator('.msg-content img.emoji-custom').waitFor({ timeout: 4000 });
  ok(true, 'после правки картинка на месте');

  // переименование и удаление
  await pa.locator('.sidebar-header').click();
  await pa.getByRole('menuitem', { name: 'Настройки сервера' }).click();
  await pa.locator('.settings-tab', { hasText: 'Эмодзи' }).click();
  const nameInput = pa.locator('.emoji-name').first();
  await nameInput.fill('sky_blob');
  await nameInput.press('Enter');
  await pb.waitForTimeout(500);
  ok((await api(b.token, 'GET', `/guilds/${g.id}`)).emojis.some((e) => e.name === 'sky_blob'), 'переименование сохранено');
  await pa.locator('.emoji-table-row', { has: pa.locator('input[value="happy_cat"]') }).getByRole('button', { name: 'Удалить' }).click();
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.emoji-table-row').nth(1).waitFor({ state: 'detached', timeout: 4000 });
  await pa.keyboard.press('Escape');
  await pb.reload();
  await pb.waitForSelector('.shell');
  await pb.locator('.channel', { hasText: text.name }).first().click();
  await pb.locator('.msg', { hasText: 'смотри' }).locator('.emoji-missing', { hasText: ':happy_cat:' }).first().waitFor({ timeout: 5000 });
  ok(true, 'удалённое эмодзи показывается как :имя:');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pa.screenshot({ path: shot('failure-a.png') }).catch(() => {});
  await pb.screenshot({ path: shot('failure-b.png') }).catch(() => {});
}
// 404 удалённой картинки — ожидаемая сетевая ошибка, не JS-исключение
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nЭМОДЗИ UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

// E2E фазы 3a: автодополнение упоминаний/каналов/эмодзи, пикер, несколько вложений, оптимистичная отправка
// с ошибкой и повтором, контекстное меню, ссылка на сообщение и переход, массовое удаление, маркер «новые».
//   RELAY_URL=http://127.0.0.1:8099 node e2e/messages.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-3a/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json();
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'vera' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'gleb' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Сообщения ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const text = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'text');
const news = await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'новости' });
// длинная история для перехода по ссылке
const early = await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: 'самое первое сообщение' });
for (let i = 0; i < 70; i++) await api(b.token, 'POST', `/channels/${text.id}/messages`, { content: `заполнитель ${i}` });

// файлы для загрузки (PNG 1×1)
const dir = join(tmpdir(), 'relay-e2e-' + sfx);
mkdirSync(dir, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(dir, 'one.png'), png);
writeFileSync(join(dir, 'two.png'), png);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(token) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
  await pa.locator('.channel', { hasText: text.name }).click();
  await pa.waitForSelector('.msg');

  // @-автодополнение → токен на сервере, имя в сообщении, подсветка у упомянутого
  await box(pa).click();
  await pa.keyboard.type('привет @gle');
  await pa.locator('.autocomplete .ac-item', { hasText: 'gleb' + sfx }).waitFor({ timeout: 3000 });
  ok(true, 'автодополнение @ показывает участника');
  await pa.screenshot({ path: shot('autocomplete-members.png') });
  await pa.keyboard.press('Enter');
  ok((await box(pa).inputValue()).includes('@gleb' + sfx + ' '), 'в поле — читаемое имя');
  await pa.keyboard.type('загляни в #нов');
  await pa.locator('.autocomplete .ac-item', { hasText: 'новости' }).waitFor({ timeout: 3000 });
  await pa.keyboard.press('Tab');
  await pa.keyboard.type(':smil');
  // ждём именно эмодзи-подсказку: список каналов ещё может доигрывать анимацию закрытия
  await pa.locator('.autocomplete .ac-item', { hasText: ':smil' }).first().waitFor({ timeout: 5000 });
  ok(true, 'автодополнение :эмодзи:');
  await pa.keyboard.press('Enter');
  await pa.keyboard.press('Enter');
  const sent = pa.locator('.msg', { hasText: 'загляни в' }).last();
  await sent.locator('.md-mention', { hasText: 'gleb' + sfx }).waitFor({ timeout: 4000 });
  const last = (await api(a.token, 'GET', `/channels/${text.id}/messages?limit=1`))[0];
  ok(last.mentions.includes(b.user.id) && last.content.includes(`<#${news.id}>`), 'на сервер ушли токены <@id> и <#id>');
  ok(/\p{Extended_Pictographic}/u.test(last.content), 'эмодзи вставлен символом: ' + JSON.stringify(last.content));
  await pb.locator('.channel', { hasText: text.name }).click();
  await pb.locator('.msg.mention', { hasText: 'загляни в' }).waitFor({ timeout: 4000 });
  ok(true, 'у упомянутого сообщение подсвечено');
  await pb.locator('.msg', { hasText: 'загляни в' }).last().locator('.md-mention', { hasText: 'новости' }).click();
  await pb.locator('.chat-header h1', { hasText: 'новости' }).waitFor({ timeout: 3000 });
  ok(true, 'клик по #каналу открывает канал');
  await pb.locator('.channel', { hasText: text.name }).click();

  // пикер эмодзи: поиск по-русски
  await pa.locator('.composer-row').getByRole('button', { name: 'Эмодзи' }).click();
  await pa.locator('.emoji-picker .search-box input').fill('сердце');
  await pa.locator('.emoji-row button').first().waitFor({ timeout: 4000 });
  await pa.screenshot({ path: shot('emoji-picker-search.png') });
  await pa.locator('.emoji-row button').first().click();
  ok((await box(pa).inputValue()).length > 0, 'пикер: поиск «сердце» и вставка');
  await box(pa).fill('');

  // несколько вложений
  await pa.locator('.composer-row input[type="file"]').setInputFiles([join(dir, 'one.png'), join(dir, 'two.png')]);
  await pa.locator('.upload-item').nth(1).waitFor();
  await pa.waitForFunction(() => document.querySelectorAll('.upload-item .upload-progress').length === 0, null, { timeout: 8000 });
  await box(pa).fill('две картинки');
  await pa.keyboard.press('Enter');
  await pb.locator('.msg', { hasText: 'две картинки' }).locator('.att-gallery.n2 img').nth(1).waitFor({ timeout: 5000 });
  ok(true, 'два вложения — галерея у второго пользователя');

  // оптимистичная отправка: ошибка → «Не отправлено» → повтор
  await pa.route('**/api/channels/*/messages', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
  await box(pa).fill('сеть упала');
  await pa.keyboard.press('Enter');
  await pa.locator('.msg.failed', { hasText: 'сеть упала' }).waitFor({ timeout: 5000 });
  ok(true, 'ошибка отправки → «Не отправлено»');
  await pa.screenshot({ path: shot('message-failed.png') });
  await pa.unroute('**/api/channels/*/messages');
  await pa.locator('.msg.failed').getByRole('button', { name: 'Повторить' }).click();
  await pb.locator('.msg', { hasText: 'сеть упала' }).waitFor({ timeout: 5000 });
  ok(await pa.locator('.msg.failed').count() === 0 && await pa.locator('.msg', { hasText: 'сеть упала' }).count() === 1, 'повтор: отправлено, без дублей');

  // ссылка на старое сообщение → переход с подсветкой, «к последним»
  await pb.goto(`${B}/#msg/${g.id}/${text.id}/${early.id}`);
  await pb.locator('.msg.flash', { hasText: 'самое первое сообщение' }).waitFor({ timeout: 8000 });
  ok(true, 'переход по ссылке: старое сообщение загружено и подсвечено');
  ok(await pb.locator('.jump-note').isVisible(), 'режим «старые сообщения»');
  await pb.screenshot({ path: shot('jump-to-message.png') });
  await pb.locator('.jump').getByRole('button', { name: 'К последним' }).click();
  await pb.locator('.msg', { hasText: 'сеть упала' }).waitFor({ timeout: 5000 });
  await pb.waitForTimeout(400);
  ok(!(await pb.locator('.jump-note').isVisible()), '«К последним» возвращает к свежим');

  // контекстное меню и копирование ссылки
  const target = pa.locator('.msg', { hasText: 'две картинки' });
  await target.click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Копировать ссылку на сообщение' }).click();
  const clip = await pa.evaluate(() => navigator.clipboard.readText());
  ok(/#msg\/\d+\/\d+\/\d+$/.test(clip), 'контекстное меню: ссылка на сообщение скопирована');

  // массовое удаление
  await pa.waitForTimeout(250); // предыдущее меню доигрывает анимацию закрытия
  await pa.locator('.msg', { hasText: 'заполнитель 69' }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Выбрать сообщения' }).click();
  await pa.locator('.msg', { hasText: 'заполнитель 68' }).click();
  await pa.locator('.select-bar').getByRole('button', { name: 'Удалить выбранные' }).click();
  await pa.locator('.modal button[type="submit"]').click();
  await pb.locator('.msg', { hasText: 'заполнитель 69' }).waitFor({ state: 'detached', timeout: 5000 });
  ok(await pb.locator('.msg', { hasText: 'заполнитель 68' }).count() === 0, 'массовое удаление: исчезло у второго');

  // маркер «Новые сообщения»
  await pb.locator('.channel', { hasText: 'новости' }).click();
  for (let i = 0; i < 3; i++) await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: `свежее ${i}` });
  await pb.waitForTimeout(400);
  await pb.locator('.channel', { hasText: text.name }).click();
  await pb.locator('.new-marker').waitFor({ timeout: 4000 });
  const markerNext = await pb.evaluate(() => document.querySelector('.new-marker')?.nextElementSibling?.textContent || '');
  ok(markerNext.includes('свежее 0'), 'маркер «Новые сообщения» перед первым непрочитанным');
  await pb.screenshot({ path: shot('new-marker.png') });
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pa.screenshot({ path: shot('failure-a.png') }).catch(() => {});
  await pb.screenshot({ path: shot('failure-b.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nСООБЩЕНИЯ UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

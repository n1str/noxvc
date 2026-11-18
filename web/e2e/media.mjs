// E2E фазы 3d: карточки ссылок, картинка по ссылке, YouTube (клик → плеер), лайтбокс (стрелки, Esc),
// подсветка кода, «убрать превью». Сервер Relay — с RELAY_PREVIEW_ALLOW=127.0.0.1:7998.
//   RELAY_URL=http://127.0.0.1:8099 node e2e/media.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-3d/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };

/** Однотонный PNG w×h (без зависимостей). */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const SITE = 'http://127.0.0.1:7998';
const site = createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/article') {
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<html><head><meta property="og:title" content="Как устроен Relay"><meta property="og:description" content="Сервер на Rust, голос через LiveKit, клиент на React — разбор архитектуры по слоям.">' +
      '<meta property="og:image" content="/cover.png"><meta property="og:site_name" content="Блог разработчика"><meta name="theme-color" content="#7c5cff"></head></html>');
  }
  if (u === '/cover.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(160, 160, [124, 92, 255]));
  if (u === '/photo.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(480, 270, [40, 160, 120]));
  res.writeHead(404).end();
}).listen(7998, '127.0.0.1');

const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
async function upload(tok, name, buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/png' }), name);
  return (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd })).json();
}
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'sasha' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'toma' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Медиа ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const text = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'text');
const post = (tok, body) => api(tok, 'POST', `/channels/${text.id}/messages`, typeof body === 'string' ? { content: body } : body);

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
try {
  await pb.locator('.channel', { hasText: text.name }).click();
  await pa.locator('.channel', { hasText: text.name }).click();

  // карточка ссылки появляется у второго пользователя «вживую» (message_update)
  await post(a.token, `Почитай ${SITE}/article`);
  const card = pb.locator('.embed', { hasText: 'Как устроен Relay' });
  await card.waitFor({ timeout: 6000 });
  ok(await card.locator('.embed-site', { hasText: 'Блог разработчика' }).count() === 1, 'карточка: сайт, заголовок, описание');
  ok((await card.evaluate((el) => getComputedStyle(el).borderLeftColor)).length > 0 && await card.locator('.embed-thumb img').count() === 1, 'карточка: миниатюра и цветная полоса');

  // ссылка на картинку и YouTube
  await post(a.token, `${SITE}/photo.png`);
  await pb.locator('.embed-image-only img').waitFor({ timeout: 6000 });
  ok(true, 'прямая ссылка на картинку → картинка');
  await post(a.token, 'Клип: https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const yt = pb.locator('.embed-video .embed-play');
  await yt.waitFor({ timeout: 10000 });
  ok(true, 'YouTube: превью с кнопкой воспроизведения');

  // подсветка кода
  await post(a.token, 'Пример:\n```js\nconst answer = 42; // ответ\nfunction hi() { return "привет"; }\n```');
  await pb.locator('.md-pre .hljs-keyword').first().waitFor({ timeout: 6000 });
  ok(await pb.locator('.md-pre .hljs-string').count() > 0 && await pb.locator('.md-pre .hljs-comment').count() > 0, 'подсветка кода (js): ключевые слова, строки, комментарии');
  await pb.screenshot({ path: shot('embeds.png') });

  await yt.click();
  const src = await pb.locator('.embed-video iframe').getAttribute('src');
  ok(src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'YouTube: клик → встроенный плеер (nocookie)');

  // лайтбокс: два вложения, стрелки, Esc
  const i1 = await upload(a.token, 'красный.png', png(300, 200, [220, 60, 60]));
  const i2 = await upload(a.token, 'синий.png', png(200, 300, [60, 90, 220]));
  await post(a.token, { content: 'две картинки', attachments: [i1, i2] });
  await pb.locator('.msg', { hasText: 'две картинки' }).locator('.att-img').nth(1).click();
  await pb.locator('.lightbox .lightbox-name', { hasText: 'синий.png' }).waitFor({ timeout: 3000 });
  ok((await pb.locator('.lightbox-name').textContent()).includes('2/2'), 'лайтбокс открыт на выбранной картинке (2/2)');
  await pb.waitForTimeout(400);
  await pb.screenshot({ path: shot('lightbox.png') });
  await pb.keyboard.press('ArrowLeft');
  await pb.locator('.lightbox .lightbox-name', { hasText: 'красный.png' }).waitFor({ timeout: 3000 });
  ok(true, 'лайтбокс: стрелка — к предыдущей');
  await pb.keyboard.press('Escape');
  await pb.locator('.lightbox').waitFor({ state: 'detached', timeout: 3000 });
  ok(true, 'лайтбокс: Esc закрывает');
  await pb.locator('.embed-thumb').first().click();
  await pb.locator('.lightbox img').waitFor({ timeout: 3000 });
  ok((await pb.locator('.lightbox img').getAttribute('src')) === `${SITE}/cover.png`, 'миниатюра карточки открывается в лайтбоксе');
  await pb.locator('.lightbox').click({ position: { x: 20, y: 300 } });
  await pb.locator('.lightbox').waitFor({ state: 'detached', timeout: 3000 });
  ok(true, 'лайтбокс: клик по фону закрывает');

  // «убрать превью»: у автора есть кнопка, у второго — нет; превью исчезает у всех
  ok(await pb.locator('.msg', { hasText: 'Почитай' }).locator('.embeds-remove').count() === 0, 'чужое сообщение: кнопки «убрать превью» нет');
  const mine = pa.locator('.msg', { hasText: 'Почитай' });
  await mine.hover();
  await mine.locator('.embeds-remove').click();
  await pb.locator('.embed', { hasText: 'Как устроен Relay' }).waitFor({ state: 'detached', timeout: 4000 });
  ok(true, 'автор убрал превью — исчезло и у второго');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pb.screenshot({ path: shot('failure-b.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
site.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nМЕДИА UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

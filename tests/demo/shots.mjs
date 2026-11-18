// Скриншоты интерфейса для лендинга — с демо-стенда (tests/demo), после seed.mjs.
//   node tests/demo/shots.mjs [сцена…]   → site/shots-raw/<сцена>.png (2x, 1440×900), дальше: cd site && npm run shots
// Сцены: chat, profile, voice, stream, light. Все участники онлайн (вкладка на каждого); голос — искусственный
// микрофон Chrome (тон → индикатор речи); трансляция — вкладка «NoxDemo» с абстрактной картинкой.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const seed = JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8'));
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../site/shots-raw/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const want = process.argv.slice(2);
const scene = (n) => !want.length || want.includes(n);
const shotPath = (n) => fileURLToPath(new URL(n + '.png', OUT));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (login, method, path, body) => fetch(seed.url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + seed.users[login].token }, body: body && JSON.stringify(body) }).then((r) => r.json().catch(() => null));

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-tab-capture-source-by-title=NoxDemo', '--autoplay-policy=no-user-gesture-required', '--enable-usermedia-screen-capturing'],
});
const errors = [];
async function open(login, { ch = 'general', light = false, dpr = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(([t, gid, cid, light]) => {
    localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(gid));
    localStorage.setItem('relay_last_ch', JSON.stringify({ [gid]: cid }));
    localStorage.setItem('relay_acc_theme', JSON.stringify(light ? 'light' : 'dark'));
  }, [seed.users[login].token, seed.guild, seed.channels[ch], light]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(seed.url + '/');
  await page.waitForSelector('.shell');
  return page;
}
async function toBottom(p) {
  await p.waitForTimeout(1200);
  await p.evaluate(async () => {
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    const m = document.querySelector('.messages'); if (m) m.scrollTop = m.scrollHeight;
  });
  await p.waitForTimeout(600);
}
async function shot(p, name) { await p.mouse.move(1439, 899); await p.waitForTimeout(400); await p.screenshot({ path: shotPath(name) }); console.log('снимок:', name); }

// все участники онлайн
const pages = {};
for (const l of ['mira', 'kirill', 'dasha', 'ghost', 'nightowl']) pages[l] = await open(l);
await api('mira', 'PUT', '/me/game', { activity: { source: 'custom', name: 'Небесная гавань', started_at: Date.now() - 47 * 60000 } });
for (const ch of ['general', 'ideas', 'pics']) {
  const list = await api('alex', 'GET', `/channels/${seed.channels[ch]}/messages`);
  const last = (Array.isArray(list) ? list : list?.messages ?? []).map((m) => m.id).sort((a, b) => b - a)[0];
  if (last) await api('alex', 'POST', `/channels/${seed.channels[ch]}/ack`, { message_id: last });
}
const alex = await open('alex', { dpr: 2 });

try {
  if (scene('chat')) { await toBottom(alex); await shot(alex, 'chat'); }

  if (scene('profile')) {
    await alex.locator('.member', { hasText: 'Mira' }).first().click();
    await alex.waitForTimeout(700);
    const full = alex.getByRole('button', { name: /Открыть профиль/ });
    if (await full.count()) { await full.first().click(); await alex.waitForTimeout(1200); }
    await shot(alex, 'profile');
    await alex.keyboard.press('Escape'); await alex.keyboard.press('Escape');
    await alex.waitForTimeout(500);
  }

  if (scene('voice') || scene('stream')) {
    const join = async (p) => { await p.locator('.channel', { hasText: 'Гостиная' }).first().click(); await p.waitForTimeout(2500); };
    for (const l of ['mira', 'kirill', 'dasha']) await join(pages[l]);
    await join(alex);
    await alex.waitForTimeout(3000);
    await alex.locator('.member:not(.offline)', { hasText: 'Alex' }).waitFor({ timeout: 15000 }).catch(() => console.log('Alex не в сети в списке'));
    if (scene('voice')) await shot(alex, 'voice');

    if (scene('stream')) {
      // что Mira показывает: картинка stream-art.html на холсте вместо выбора экрана (getDisplayMedia подменён)
      const art = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await art.setContent(readFileSync(new URL('./stream-art.html', import.meta.url), 'utf8'));
      const png = (await art.screenshot()).toString('base64');
      await art.close();
      await pages.mira.evaluate(async (png) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
        const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
        const g = c.getContext('2d');
        const t0 = performance.now();
        (function draw() { const t = (performance.now() - t0) / 1000; g.drawImage(img, 0, 0); g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(760 + Math.sin(t) * 40, 420 + Math.cos(t * 0.8) * 20, 7, 0, 7); g.fill(); requestAnimationFrame(draw); })();
        navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(30);
      }, png);
      const share = pages.mira.getByRole('button', { name: /Демонстрация экрана|Показать экран|Транслировать/ }).first();
      await share.click();
      await pages.mira.waitForTimeout(800);
      const tab = pages.mira.getByText('Вкладка', { exact: true });
      if (await tab.count()) await tab.first().click();
      await pages.mira.getByRole('button', { name: /Начать демонстрацию|Начать трансляцию/ }).first().click();
      await pages.mira.waitForTimeout(5000);
      // у Alex трансляция разворачивается сама (крупно, участники — лентой)
      await alex.locator('.spot-main .tile.screen video').waitFor({ timeout: 15000 }).catch(() => console.log('трансляция не развернулась'));
      await alex.waitForTimeout(5000);
      await shot(alex, 'stream');
    }
  }

  if (scene('light')) {
    const l = await open('alex', { light: true, dpr: 2 });
    await toBottom(l);
    await shot(l, 'light');
  }
} finally {
  console.log(errors.length ? 'ошибки страниц:\n' + errors.join('\n') : 'ошибок на страницах нет');
  await browser.close();
}

// E2E фазы 3c: строка поиска, подсказки фильтров, результаты с подсветкой, переход, сортировка, страницы, мобильный вид.
//   RELAY_URL=http://127.0.0.1:8099 node e2e/search.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-3c/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'pavel' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'rita' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Поиск ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const general = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'text');
const news = await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'новости' });
const post = (tok, ch, content) => api(tok, 'POST', `/channels/${ch}/messages`, { content });
const first = await post(a.token, general.id, 'Встречаемся у **фонтана** в семь');
for (let i = 0; i < 60; i++) await post(b.token, general.id, `болтовня ${i}`);
await post(b.token, news.id, 'Фонтаны в парке отключат завтра');
for (let i = 0; i < 28; i++) await post(a.token, news.id, `объявление номер ${i}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([t, gid]) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(gid)); }, [b.token, g.id]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
const p = await open();
const input = p.locator('.header-search input');
try {
  await p.locator('.channel', { hasText: general.name }).click();
  await p.waitForSelector('.msg');

  // Ctrl+F → фокус; пустая строка — список фильтров
  await p.keyboard.press('Control+f');
  ok(await input.evaluate((el) => el === document.activeElement), 'Ctrl+F фокусирует поиск');
  await p.locator('.search-suggest .ac-item', { hasText: 'from:' }).waitFor({ timeout: 3000 });
  ok(await p.locator('.search-suggest .ac-item').count() >= 8, 'подсказки: все фильтры');
  await p.screenshot({ path: shot('filters.png') });

  // from: → участники; выбор подставляет логин
  await input.fill('from:pav');
  await p.locator('.search-suggest .ac-item', { hasText: 'pavel' + sfx }).click();
  ok((await input.inputValue()) === `from:pavel${sfx} `, 'from: подставляет логин участника');
  await input.pressSequentially('фонт');
  await p.keyboard.press('Enter');
  await p.locator('.search-panel .search-hit').first().waitFor({ timeout: 5000 });
  ok(await p.locator('.search-panel .search-hit').count() === 1, 'from:+слово — один результат');
  ok((await p.locator('.search-panel .md-hl').first().textContent()) === 'фонтана', 'подсветка найденного слова');
  ok(await p.locator('.members').count() === 0, 'панель результатов заменила участников');
  await p.screenshot({ path: shot('results.png') });

  // слово без фильтров: оба канала, группировка по каналам
  await input.fill('фонтан');
  await p.keyboard.press('Enter');
  await p.locator('.search-count', { hasText: '2 результата' }).waitFor({ timeout: 5000 });
  ok(await p.locator('.search-channel').count() === 2, 'результаты сгруппированы по каналам');

  // переход к старому сообщению (его нет в загруженной истории)
  await p.locator('.search-hit', { hasText: 'Встречаемся' }).click();
  await p.locator('.msg.flash', { hasText: 'Встречаемся' }).waitFor({ timeout: 6000 });
  ok(true, 'клик по результату: переход к сообщению с подсветкой');
  ok(await p.locator('.search-panel').isVisible(), 'панель остаётся открытой после перехода');

  // in: + сортировка + страницы
  await input.fill('in:новости объявление');
  await p.keyboard.press('Enter');
  await p.locator('.search-count', { hasText: '28' }).waitFor({ timeout: 5000 });
  ok((await p.locator('.search-hit').first().textContent()).includes('номер 27'), 'сначала новые');
  await p.locator('.search-sort').selectOption('old');
  await p.locator('.search-hit').first().filter({ hasText: 'номер 0' }).waitFor({ timeout: 5000 });
  ok(true, 'сортировка «сначала старые»');
  ok(await p.locator('.search-hit').count() === 25, 'страница — 25 результатов');
  await p.getByRole('button', { name: 'Дальше' }).click();
  await p.locator('.search-pages', { hasText: 'Стр. 2 из 2' }).waitFor({ timeout: 5000 });
  await p.waitForFunction(() => document.querySelectorAll('.search-hit').length === 3, null, { timeout: 5000 });
  ok(true, 'вторая страница — остальные 3');

  // ошибки и пустой результат
  await input.fill('has:банан');
  await p.keyboard.press('Enter');
  await p.locator('.search-panel .error').waitFor({ timeout: 4000 });
  ok(true, 'ошибка фильтра показана в панели');
  await input.fill('несуществующееслово');
  await p.keyboard.press('Enter');
  await p.locator('.search-empty', { hasText: 'Ничего не нашлось' }).waitFor({ timeout: 4000 });
  ok(true, 'пустой результат');

  // Escape: очистить, затем закрыть — участники вернулись
  await input.focus();
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await p.locator('.search-panel').waitFor({ state: 'detached', timeout: 3000 });
  ok(await p.locator('.members').count() === 1, 'Escape закрывает поиск, участники вернулись');

  // мобильный вид: панель на весь экран
  const m = await open({ width: 390, height: 844 });
  await m.locator('.header-search input').fill('фонтан');
  await m.keyboard.press('Enter');
  await m.locator('.search-hit').first().waitFor({ timeout: 5000 });
  const box = await m.locator('.search-panel').boundingBox();
  ok(box && box.width >= 380, 'мобильный: панель результатов на весь экран');
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'мобильный: нет горизонтальной прокрутки');
  await m.screenshot({ path: shot('mobile-results.png') });
  await m.locator('.search-hit', { hasText: 'Фонтаны' }).click();
  await m.locator('.msg.flash', { hasText: 'Фонтаны' }).waitFor({ timeout: 6000 });
  await m.locator('.search-panel').waitFor({ state: 'detached', timeout: 3000 });
  ok(true, 'мобильный: переход закрывает панель');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await p.screenshot({ path: shot('failure.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nПОИСК UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

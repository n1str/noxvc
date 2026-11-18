// E2E нового фронтенда в установленном Chrome (playwright-core, без скачивания браузеров).
//   RELAY_URL=http://127.0.0.1:8099 node e2e/ui.mjs
// Скриншоты: ../screenshots/phase-2e/
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-2e/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (name) => fileURLToPath(new URL(name, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json();
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'anna' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'boris' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Студия ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const detail = await api(a.token, 'GET', `/guilds/${g.id}`);
const text = detail.channels.find((c) => c.kind === 'text');
await api(a.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Модераторы', color: 0x5b8cff, hoist: true });
for (const [tok, content] of [[a.token, 'Привет! Это **новый** клиент на React.'], [b.token, 'Выглядит отлично. Вот код:\n```rust\nfn main() { println!("relay"); }\n```'], [a.token, '> цитата\n- пункт один\n- пункт два\n||спойлер|| и ссылка https://example.com']]) {
  await api(tok, 'POST', `/channels/${text.id}/messages`, { content });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(token, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
  await ctx.addInitScript(([t, gid]) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(gid)); }, [token, g.id]);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/')) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(B + '/');
  await page.waitForSelector('.shell', { timeout: 10000 });
  return page;
}

const pa = await open(a.token, { width: 1920, height: 1080 });
const pb = await open(b.token);
await pa.waitForSelector('.msg');
ok(await pa.locator('.msg').count() === 3, 'история канала загружена (3 сообщения)');
ok(await pa.locator('.md-pre pre').count() === 1 && await pa.locator('blockquote').count() === 1, 'markdown: код-блок и цитата');
await pa.waitForTimeout(600);
await pa.screenshot({ path: shot('desktop-chat.png') });

// сообщение в реальном времени и «печатает»
await pb.locator('.composer textarea').click();
await pb.keyboard.type('Пишу', { delay: 20 });
ok(await pa.locator('.typing').getByText('печатает').isVisible({ timeout: 3000 }).catch(() => false), '«печатает» у второго пользователя');
await pb.keyboard.type(' — сообщение в реальном времени');
await pb.keyboard.press('Enter');
await pa.locator('.msg-content', { hasText: 'в реальном времени' }).waitFor({ timeout: 3000 });
ok(true, 'сообщение пришло второму пользователю через gateway');

// реакция
const last = pa.locator('.msg').last();
await last.hover();
await last.getByRole('button', { name: 'Реакция' }).click();
await pa.locator('.emoji-row button').first().click();
await pb.locator('.msg').last().locator('.reaction').waitFor({ timeout: 3000 });
ok(true, 'реакция видна второму пользователю');

// ответ
await last.hover();
await last.getByRole('button', { name: 'Ответить' }).click();
await pa.locator('.composer textarea').fill('Отвечаю на сообщение');
await pa.keyboard.press('Enter');
await pb.locator('.msg-reply').last().waitFor({ timeout: 3000 });
ok(true, 'ответ с цитатой');

// редактирование последнего своего по ↑
await pa.locator('.composer textarea').click();
await pa.keyboard.press('ArrowUp');
await pa.locator('.msg-edit textarea').fill('Отредактировано через стрелку вверх');
await pa.keyboard.press('Enter');
await pb.locator('.msg-content', { hasText: 'Отредактировано' }).waitFor({ timeout: 3000 });
ok(true, 'редактирование ↑ и Enter, видно второму');

// профиль по клику на автора
await pa.locator('.msg-author').first().click();
ok(await pa.locator('.profile-card').isVisible(), 'карточка профиля');
await pa.waitForTimeout(250);
await pa.screenshot({ path: shot('desktop-profile.png') });
await pa.keyboard.press('Escape');

// меню сервера и модалка приглашения
await pa.locator('.sidebar-header').click();
await pa.getByRole('menuitem', { name: 'Пригласить людей' }).click();
await pa.waitForFunction(() => document.querySelector('.modal .invite-row input')?.value.includes('#invite/'), null, { timeout: 3000 }).catch(() => {});
ok((await pa.locator('.modal .invite-row input').inputValue()).includes('#invite/'), 'модалка приглашения со ссылкой');
await pa.waitForTimeout(300);
await pa.screenshot({ path: shot('desktop-invite.png') });
await pa.keyboard.press('Escape');

// Регрессия X18: канал, созданный через UI, сразу доступен для записи и управления (без перезагрузки).
await pa.locator('.sidebar-header').click();
await pa.getByRole('menuitem', { name: 'Создать канал' }).click();
await pa.locator('.modal input[name="name"]').fill('новый-канал');
await pa.locator('.modal button[type="submit"]').click();
await pa.locator('.chat-header h1', { hasText: 'новый-канал' }).waitFor({ timeout: 3000 });
await pa.waitForFunction(() => !document.querySelector('.composer textarea')?.disabled, null, { timeout: 3000 }).catch(() => {});
ok(!(await pa.locator('.composer textarea').isDisabled()), 'новый канал: можно писать сразу');
await pa.locator('.composer textarea').fill('первое сообщение в новом канале');
await pa.keyboard.press('Enter');
await pa.locator('.msg-content', { hasText: 'первое сообщение в новом канале' }).waitFor({ timeout: 3000 });
await pa.locator('.channel', { hasText: 'новый-канал' }).click({ button: 'right' });
ok(await pa.getByRole('menuitem', { name: 'Удалить канал' }).isVisible({ timeout: 2000 }).catch(() => false), 'новый канал: ПКМ-меню доступно');
await pa.keyboard.press('Escape');

// мобильная ширина
const pm = await open(b.token, { width: 390, height: 844 });
await pm.waitForSelector('.msg');
const overflow = await pm.evaluate(() => document.documentElement.scrollWidth > innerWidth);
ok(!overflow, 'мобильная ширина 390: без горизонтальной прокрутки');
await pm.screenshot({ path: shot('mobile-chat.png') });
const inView = (sel) => pm.evaluate((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return !!r && r.right > 0 && r.left < innerWidth; }, sel);
await pm.getByRole('button', { name: 'Каналы' }).click();
await pm.waitForTimeout(400);
ok(await inView('.sidebar') && await inView('.rail'), 'мобильная: кнопка открывает панель каналов');
await pm.screenshot({ path: shot('mobile-drawer-channels.png') });
await pm.locator('.sidebar .channel', { hasText: 'общий' }).click();
await pm.waitForTimeout(400);
ok(!(await inView('.sidebar')), 'мобильная: выбор канала закрывает панель');
await pm.getByRole('button', { name: 'Участники' }).click();
await pm.waitForTimeout(400);
ok(await inView('.members'), 'мобильная: панель участников');
await pm.screenshot({ path: shot('mobile-drawer-members.png') });
await pm.locator('.drawer-scrim').click({ position: { x: 20, y: 400 } });
await pm.waitForTimeout(400);
ok(!(await inView('.members')), 'мобильная: тап по затемнению закрывает панель');
const pt = await open(b.token, { width: 1100, height: 800 });
await pt.waitForSelector('.msg');
ok(!(await pt.locator('.members').isVisible()), '1100px: участники скрыты по умолчанию');
await pt.getByRole('button', { name: 'Участники' }).click();
ok(await pt.locator('.members').isVisible(), '1100px: участники по кнопке');

// экран входа
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pl = await ctx.newPage();
await pl.goto(B + '/');
await pl.waitForSelector('.auth-card');
await pl.waitForTimeout(400);
await pl.screenshot({ path: shot('desktop-auth.png') });

ok(errors.length === 0, `консоль без ошибок${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nUI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

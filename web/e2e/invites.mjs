// E2E закрытой регистрации (интерфейс): /register?code=…, ссылка на сервер без аккаунта, админка и вкладка участника.
//   RELAY_URL=http://127.0.0.1:18099 node --import=../tests/register-codes.mjs e2e/invites.mjs   (из web/)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nextCode } from '../../tests/register-codes.mjs';

const B = process.env.RELAY_URL || 'http://127.0.0.1:18099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/invites/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => (await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) })).json().catch(() => null);
const sfx = Date.now() % 100000;
const SETTINGS = /^Настройки$/; // кнопка настроек пользователя (modal.settings)
let admin = (await api(null, 'POST', '/login', { username: 'tadmin', password: 'secret12' }))?.token;
if (!admin) admin = (await api(null, 'POST', '/register', { username: 'tadmin', password: 'secret12', code: nextCode() })).token;
const owner = await api(null, 'POST', '/register', { username: 'host' + sfx, password: 'secret12' });
const g = await api(owner.token, 'POST', '/guilds', { name: 'Клуб ' + sfx });
const { code: serverInvite } = await api(owner.token, 'POST', `/guilds/${g.id}/invites`, {});

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
const page = async (token) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  if (token) await ctx.addInitScript((t) => localStorage.setItem('relay_token', JSON.stringify(t)), token);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};
try {
  // 1. ссылка с кодом → форма регистрации с подставленным кодом → аккаунт
  const c = await api(admin, 'POST', '/admin/invites/codes', { note: 'e2e', guild_id: g.id });
  const p1 = await page();
  await p1.goto(c.link.replace(/^https?:\/\/[^/]+/, B));
  const codeInput = p1.locator('input[name="code"]');
  await codeInput.waitFor();
  ok(await codeInput.inputValue() === c.code, '/register?code=… — код подставлен');
  ok(!(await p1.evaluate(() => location.search)), 'код убран из адресной строки');
  await p1.screenshot({ path: shot('register.png') });
  await p1.fill('input[name="username"]', 'guest' + sfx);
  await p1.fill('input[name="password"]', 'secret12');
  await p1.click('button[type="submit"]');
  await p1.waitForSelector('.shell', { timeout: 10000 });
  ok(await p1.locator('.rail, .guild-rail, nav').first().count() > 0, 'регистрация по ссылке → в приложении');

  // 2. без кода — форма не пускает (поле обязательно), неверный код — единая ошибка
  const p2 = await page();
  await p2.goto(B + '/register');
  await p2.fill('input[name="code"]', 'WRONGWRONGWRONGWRONGWRON');
  await p2.fill('input[name="username"]', 'bad' + sfx);
  await p2.fill('input[name="password"]', 'secret12');
  await p2.click('button[type="submit"]');
  await p2.locator('.error').waitFor();
  ok((await p2.locator('.error').textContent())?.includes('Код приглашения недействителен'), 'неверный код — «Код приглашения недействителен»');

  // 3. ссылка на сервер без аккаунта — «закрытый сервис», без формы регистрации
  const p3 = await page();
  await p3.goto(`${B}/#invite/${serverInvite}`);
  await p3.locator('.auth-closed').waitFor();
  ok(await p3.locator('input[name="code"]').count() === 0 && await p3.getByText('Зарегистрироваться').count() === 0, 'гость по ссылке на сервер: «закрытый сервис», регистрации нет');
  await p3.screenshot({ path: shot('guest-invite.png') });
  // зарегистрированный по той же ссылке — вступает
  await p3.fill('input[name="username"]', 'guest' + sfx);
  await p3.fill('input[name="password"]', 'secret12');
  await p3.click('button[type="submit"]');
  await p3.waitForSelector('.shell', { timeout: 10000 });

  // 4. участник: запрос → админ одобряет в интерфейсе → у автора ссылка
  const po = await page(owner.token);
  await po.goto(B + '/');
  await po.waitForSelector('.shell');
  const openSettings = async (p) => { await p.getByRole('button', { name: SETTINGS }).last().click(); await p.locator('.settings-nav').waitFor(); };
  await openSettings(po);
  await po.locator('.settings-tab', { hasText: /^Приглашения$/ }).click();
  await po.fill('input[placeholder="Имя или ник"]', 'Соседка Лена');
  await po.fill('input[placeholder^="Кто это"]', 'вместе играем по пятницам');
  await po.getByRole('button', { name: /Запросить приглашение/ }).click();
  await po.locator('.inv-card', { hasText: 'Соседка Лена' }).waitFor();
  ok(await po.locator('.inv-card', { hasText: 'Соседка Лена' }).getByText('Ожидает').count() === 1, 'участник создал запрос — «Ожидает»');

  const pa = await page(admin);
  await pa.goto(B + '/');
  await pa.waitForSelector('.shell');
  await openSettings(pa);
  const tab = pa.locator('.settings-tab', { hasText: 'Приглашения (админ)' });
  ok(await tab.locator('.tab-count').count() === 1, 'у админа бейдж со счётчиком ожидающих');
  await tab.click();
  await pa.locator('.inv-card', { hasText: 'Соседка Лена' }).waitFor();
  await pa.screenshot({ path: shot('admin-requests.png') });
  await pa.locator('.inv-card', { hasText: 'Соседка Лена' }).getByRole('button', { name: /Одобрить/ }).click();
  await po.locator('.inv-card', { hasText: 'Соседка Лена' }).locator('.inv-link code').waitFor({ timeout: 8000 });
  ok(/register\?code=/.test(await po.locator('.inv-card', { hasText: 'Соседка Лена' }).locator('.inv-link code').textContent() ?? ''), 'после одобрения у автора появилась ссылка (без перезагрузки)');
  await po.screenshot({ path: shot('member-approved.png') });

  // 5. админ: создать код вручную — показан один раз
  await pa.locator('.feedback-admin').getByText('Коды', { exact: true }).click();
  await pa.fill('input[placeholder^="Для кого код"]', 'для Миши');
  await pa.getByRole('button', { name: /Создать код/ }).click();
  await pa.locator('.inv-made code').first().waitFor();
  ok(/register\?code=[2-9A-HJ-NP-Z]{24}/.test(await pa.locator('.inv-made .inv-link code').textContent() ?? ''), 'админ создал код: ссылка показана');
  await pa.screenshot({ path: shot('admin-codes.png') });
  await pa.locator('.feedback-admin').getByText('История', { exact: true }).click();
  await pa.locator('.inv-card', { hasText: 'guest' + sfx }).waitFor();
  ok(true, 'история: регистрация по коду видна');

  // 6. не-админ не видит админку
  ok(await po.locator('.settings-tab', { hasText: 'Приглашения (админ)' }).count() === 0, 'у не-админа нет вкладки «Приглашения (админ)»');
} catch (e) { ok(false, 'исключение: ' + e.message); }
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);

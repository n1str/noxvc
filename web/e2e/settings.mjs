// E2E настроек сервера: роли (создание, отображение, права, участники), права канала, «посмотреть как роль»,
// роли участника из ПКМ, приглашения. Результаты сверяются через API и во втором окне.
//   RELAY_URL=http://127.0.0.1:8099 node e2e/settings.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-2e/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));
const KICK = 2 ** 1, VIEW = 2 ** 10;

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json();
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'olga' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'pavel' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Настройки ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const detail = () => api(a.token, 'GET', `/guilds/${g.id}`);
const text = (await detail()).channels.find((c) => c.kind === 'text');

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
  // Настройки → Роли → создать
  await pa.locator('.sidebar-header').click();
  await pa.getByRole('menuitem', { name: 'Настройки сервера' }).click();
  await pa.locator('.settings-tab', { hasText: 'Роли' }).click();
  await pa.getByRole('button', { name: 'Создать роль' }).click();
  await pa.locator('.role-item-btn', { hasText: 'новая роль' }).waitFor({ timeout: 4000 });
  ok(true, 'роль создана из интерфейса');
  // Отображение: имя, цвет, hoist → полоса несохранённых изменений → сохранить
  await pa.locator('.role-editor input[maxlength="64"]').fill('Модераторы');
  await pa.locator('.swatch').nth(2).click();
  await pa.locator('.role-editor .switch', { hasText: 'Показывать участников отдельно' }).click();
  ok(await pa.locator('.save-bar').isVisible(), 'полоса «Есть несохранённые изменения»');
  await pa.locator('.save-bar').getByRole('button', { name: 'Сохранить' }).click();
  await pa.locator('.save-bar').waitFor({ state: 'detached', timeout: 4000 });
  let role = (await detail()).roles.find((r) => r.name === 'Модераторы');
  ok(role && role.hoist && role.color !== 0, 'отображение роли сохранено (имя, цвет, hoist)');
  // Права: поиск и KICK_MEMBERS
  await pa.locator('.tab', { hasText: 'Права' }).click();
  await pa.locator('.search-box input').fill('выгонять');
  ok(await pa.locator('.perm-row').count() === 1, 'поиск по правам');
  await pa.locator('.perm-row .switch').click();
  await pa.locator('.save-bar').getByRole('button', { name: 'Сохранить' }).click();
  await pa.waitForTimeout(500);
  role = (await detail()).roles.find((r) => r.id === role.id);
  ok(Math.floor(role.permissions / KICK) % 2 === 1, 'право «Выгонять участников» сохранено');
  await pa.locator('.search-box input').fill('');
  ok(await pa.locator('.perm-row.danger').count() > 3, 'опасные права помечены');
  await pa.screenshot({ path: shot('settings-roles-perms.png') });
  // Участники роли
  await pa.locator('.tab', { hasText: 'Участники' }).click();
  await pa.locator('.role-editor select').selectOption(String(b.user.id));
  await pa.locator('.member-row', { hasText: 'pavel' + sfx }).waitFor({ timeout: 4000 });
  ok((await detail()).members.find((m) => m.id === b.user.id).roles.includes(role.id), 'участник добавлен в роль');
  // B видит себя в группе роли (hoist) через guild_refresh
  await pb.locator('.member-group-title', { hasText: 'Модераторы' }).waitFor({ timeout: 4000 });
  ok(true, 'у второго пользователя появилась группа роли (guild_refresh)');
  // Посмотреть как роль (@everyone)
  await pa.locator('.role-item.everyone').click();
  await pa.getByRole('button', { name: 'Посмотреть сервер как роль' }).click();
  await pa.locator('.view-as-banner').waitFor({ timeout: 4000 });
  ok(true, 'режим «посмотреть как @everyone»');
  await pa.locator('.view-as-banner').getByRole('button').click();
  await pa.locator('.view-as-banner').waitFor({ state: 'detached', timeout: 4000 });
  // Приглашения
  await pa.locator('.sidebar-header').click();
  await pa.getByRole('menuitem', { name: 'Настройки сервера' }).click();
  await pa.locator('.settings-tab', { hasText: 'Приглашения' }).click();
  await pa.locator('table.invites td.mono', { hasText: code }).waitFor({ timeout: 4000 });
  ok(true, 'список приглашений');
  await pa.locator('table.invites tr', { hasText: code }).getByRole('button', { name: 'Отозвать' }).click();
  await pa.locator('table.invites td.mono', { hasText: code }).waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
  ok(!(await pa.locator('table.invites td.mono', { hasText: code }).count()), 'приглашение отозвано');
  await pa.keyboard.press('Escape');

  // Права канала: запретить @everyone видеть канал → у B канал пропадает
  const secret = await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'секрет' });
  await pb.locator('.channel', { hasText: 'секрет' }).waitFor({ timeout: 4000 });
  await pa.locator('.channel', { hasText: 'секрет' }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Права' }).click();
  await pa.locator('.perm-row', { hasText: 'Видеть каналы' }).getByRole('radio', { name: 'Запретить' }).click();
  await pa.screenshot({ path: shot('settings-channel-perms.png') });
  await pa.locator('.save-bar').getByRole('button', { name: 'Сохранить' }).click();
  await pb.locator('.channel', { hasText: 'секрет' }).waitFor({ state: 'detached', timeout: 5000 });
  ok(true, 'запрет VIEW для @everyone: канал пропал у второго пользователя');
  // Разрешить роли «Модераторы» → у B снова виден
  await pa.locator('.settings-nav select').selectOption(`role:${role.id}`);
  await pa.locator('.perm-row', { hasText: 'Видеть каналы' }).getByRole('radio', { name: 'Разрешить' }).click();
  await pa.locator('.save-bar').getByRole('button', { name: 'Сохранить' }).click();
  await pb.locator('.channel', { hasText: 'секрет' }).waitFor({ timeout: 5000 });
  ok(true, 'разрешение роли: канал снова виден участнику с ролью');
  const ows = await api(a.token, 'GET', `/channels/${secret.id}/permissions`);
  ok(ows.length === 2 && ows.some((o) => o.kind === 'role' && o.id === role.id && Math.floor(o.allow / VIEW) % 2 === 1), 'overwrites сохранены на сервере');
  await pa.keyboard.press('Escape');

  // Роли в мини-профиле: снять «×» и выдать «+» (вторичный путь). Сейчас у участника роль уже есть.
  await pa.locator('.member', { hasText: 'pavel' + sfx }).click();
  await pa.locator('.profile-card .role-chip', { hasText: 'Модераторы' }).locator('.role-chip-x').click();
  await pa.locator('.profile-card .role-chip', { hasText: 'Модераторы' }).waitFor({ state: 'detached', timeout: 4000 });
  ok(!(await detail()).members.find((m) => m.id === b.user.id).roles.includes(role.id), 'мини-профиль: роль снята');
  await pa.locator('.profile-card .role-chip.add').click();
  await pa.locator('.profile-card .role-picker .menu-item', { hasText: 'Модераторы' }).click();
  await pa.locator('.profile-card .role-chip', { hasText: 'Модераторы' }).waitFor({ timeout: 4000 });
  ok((await detail()).members.find((m) => m.id === b.user.id).roles.includes(role.id), 'мини-профиль: роль выдана');
  await pa.screenshot({ path: shot('profile-roles.png') });
  await pa.keyboard.press('Escape');
  await pa.waitForTimeout(300);

  // ПКМ по участнику → Роли → снять
  await pa.locator('.member', { hasText: 'pavel' + sfx }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Роли' }).click();
  await pa.locator('.modal .switch', { hasText: 'Модераторы' }).click();
  await pa.waitForTimeout(500);
  ok(!(await detail()).members.find((m) => m.id === b.user.id).roles.includes(role.id), 'роль снята через ПКМ → Роли');
  await pa.keyboard.press('Escape');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split('\n')[0]);
  await pa.screenshot({ path: shot('settings-failure.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nНАСТРОЙКИ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

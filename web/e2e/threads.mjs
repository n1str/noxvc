// E2E фазы 3e: ветка из сообщения (меню → модалка → открыта), плашка у сообщения, ветка в боковой панели,
// архив/закрытие, список веток, форум (теги, новый пост, фильтр), опрос (создание, голос, результаты, завершение).
//   RELAY_URL=http://127.0.0.1:8099 node e2e/threads.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-3e/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'lena' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'mark' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Обсуждения ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const text = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'text');
await api(b.token, 'POST', `/channels/${text.id}/messages`, { content: 'Предлагаю перейти на новый дизайн сайдбара' });

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

  // ветка из сообщения через контекстное меню
  await pa.locator('.msg', { hasText: 'новый дизайн' }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Создать ветку' }).click();
  const nameInput = pa.locator('.modal input');
  ok((await nameInput.inputValue()).startsWith('Предлагаю перейти'), 'модалка: имя по тексту сообщения');
  await nameInput.fill('Дизайн сайдбара');
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.chat-header h1', { hasText: 'Дизайн сайдбара' }).waitFor({ timeout: 5000 });
  ok(await pa.locator('.chat-header .crumb', { hasText: text.name }).count() === 1, 'ветка открыта, в шапке — родительский канал');
  await box(pa).fill('Мне нравится вариант с карточками');
  await pa.keyboard.press('Enter');
  await pa.locator('.msg', { hasText: 'вариант с карточками' }).waitFor({ timeout: 4000 });
  ok(await pa.locator('.thread-row', { hasText: 'Дизайн сайдбара' }).count() === 1, 'ветка в боковой панели под каналом');

  // у второго — плашка у сообщения со счётчиком, переход в ветку
  const chip = pb.locator('.thread-chip', { hasText: 'Дизайн сайдбара' });
  await chip.waitFor({ timeout: 5000 });
  await chip.locator('.thread-chip-count', { hasText: '1 сообщение' }).waitFor({ timeout: 5000 });
  ok(true, 'плашка ветки у сообщения: имя и счётчик (вживую)');
  await pb.screenshot({ path: shot('thread-chip.png') });
  await chip.click();
  await pb.locator('.msg', { hasText: 'вариант с карточками' }).waitFor({ timeout: 4000 });
  ok(true, 'клик по плашке открывает ветку');
  await box(pb).fill('Согласен');
  await pb.keyboard.press('Enter');
  await pb.locator('.thread-row', { hasText: 'Дизайн сайдбара' }).waitFor({ timeout: 4000 });
  ok(true, 'написавший в ветку видит её в боковой панели');
  await pa.locator('.msg', { hasText: 'Согласен' }).waitFor({ timeout: 4000 });
  await pa.screenshot({ path: shot('thread-view.png') });

  // архив и закрытие (модератор — владелец сервера)
  await pa.locator('[role=menu]').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {}); // прошлое меню доигрывает закрытие
  await pa.getByRole('button', { name: 'Действия с веткой' }).click();
  await pa.getByRole('menuitem', { name: 'Закрыть ветку' }).click();
  await pb.locator('.composer textarea[placeholder="Ветка закрыта модератором"]').waitFor({ timeout: 4000 });
  ok(await box(pb).isDisabled(), 'закрытая ветка: у участника поле ввода заблокировано');
  await pa.locator('[role=menu]').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {}); // прошлое меню доигрывает закрытие
  await pa.getByRole('button', { name: 'Действия с веткой' }).click();
  await pa.getByRole('menuitem', { name: 'Открыть ветку для всех' }).click();
  await pa.locator('[role=menu]').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {}); // прошлое меню доигрывает закрытие
  await pa.getByRole('button', { name: 'Действия с веткой' }).click();
  await pa.getByRole('menuitem', { name: 'Отправить в архив' }).click();
  await pa.locator('.chat-header .badge-soft', { hasText: 'в архиве' }).waitFor({ timeout: 4000 });
  ok(true, 'ветка в архиве — отметка в шапке');

  // список веток канала (архив) и возврат
  await pb.locator('.chat-header .crumb').click();
  await pb.getByRole('button', { name: 'Ветки' }).click();
  await pb.locator('.threads-panel .th-tab', { hasText: 'Архив' }).click();
  await pb.locator('.thread-item', { hasText: 'Дизайн сайдбара' }).waitFor({ timeout: 4000 });
  ok(true, 'список веток: архивная ветка во вкладке «Архив»');
  await pb.screenshot({ path: shot('threads-panel.png') });
  await pb.locator('.thread-item', { hasText: 'Дизайн сайдбара' }).click();
  await box(pb).fill('Возвращаю из архива');
  await pb.keyboard.press('Enter');
  await pa.locator('.chat-header .badge-soft', { hasText: 'в архиве' }).waitFor({ state: 'detached', timeout: 4000 });
  ok(true, 'новое сообщение вернуло ветку из архива');

  // форум: создание, теги, пост, фильтр
  await pa.locator('.channel-group-title', { hasText: 'Текстовые каналы' }).getByRole('button').click();
  await pa.locator('.modal .radio-row', { hasText: 'Форум' }).click();
  await pa.locator('.modal input[name="name"]').fill('Идеи');
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.forum').waitFor({ timeout: 5000 });
  ok(true, 'форум создан и открыт');
  await pa.locator('.channel', { hasText: 'идеи' }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Теги форума' }).click();
  for (const [emoji, name] of [['🐞', 'Баг'], ['💡', 'Идея']]) {
    await pa.locator('.modal').getByRole('button', { name: 'Добавить тег' }).click();
    await pa.locator('.tag-edit-row').last().locator('.tag-emoji').fill(emoji);
    await pa.locator('.tag-edit-row').last().locator('input').nth(1).fill(name);
  }
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.forum-toolbar .tag-chip', { hasText: 'Идея' }).waitFor({ timeout: 4000 });
  ok(true, 'теги форума сохранены');
  for (const [title, body, tag] of [['Тёмная тема для кода', 'Хочется контрастнее', 'Идея'], ['Падает загрузка', 'Файлы больше 10 МБ не грузятся', 'Баг']]) {
    await pa.getByRole('button', { name: 'Новый пост' }).click();
    await pa.locator('.modal input[name="title"]').fill(title);
    await pa.locator('.modal textarea[name="content"]').fill(body);
    await pa.locator('.modal .tag-chip', { hasText: tag }).click();
    await pa.locator('.modal button[type="submit"]').click();
    await pa.locator('.chat-header h1', { hasText: title }).waitFor({ timeout: 5000 });
    await pa.locator('.chat-header .crumb').click();
    await pa.locator('.forum-post', { hasText: title }).waitFor({ timeout: 5000 });
  }
  ok(await pa.locator('.forum-post').count() === 2, 'два поста в форуме');
  ok((await pa.locator('.forum-post').first().textContent()).includes('Падает загрузка'), 'посты — по последней активности');
  await pa.screenshot({ path: shot('forum.png') });
  await pa.locator('.forum-toolbar .tag-chip', { hasText: 'Баг' }).click();
  ok(await pa.locator('.forum-post').count() === 1 && (await pa.locator('.forum-post').textContent()).includes('Падает загрузка'), 'фильтр по тегу');
  await pa.locator('.forum-post').click();
  await pa.locator('.msg', { hasText: 'Файлы больше 10 МБ' }).waitFor({ timeout: 4000 });
  ok(true, 'пост открывается как ветка с первым сообщением');

  // опрос
  await pa.locator('.channel', { hasText: text.name }).first().click();
  await pa.getByRole('button', { name: 'Опрос' }).click();
  await pa.locator('.modal input[name="question"]').fill('Когда релиз?');
  await pa.locator('.poll-edit-row input').nth(0).fill('В пятницу');
  await pa.locator('.poll-edit-row input').nth(1).fill('На следующей неделе');
  await pa.locator('.modal').getByRole('button', { name: 'Добавить вариант' }).click();
  await pa.locator('.poll-edit-row input').nth(2).fill('Не торопимся');
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.poll', { hasText: 'Когда релиз?' }).waitFor({ timeout: 5000 });
  ok((await pa.locator('.poll-foot').textContent()).includes('осталось 1 д'), 'опрос на 24 часа: «осталось 1 д»');
  const pollB = pb.locator('.poll', { hasText: 'Когда релиз?' });
  await pb.locator('.channel', { hasText: text.name }).first().click();
  await pollB.waitFor({ timeout: 5000 });
  await pollB.locator('.poll-answer', { hasText: 'На следующей неделе' }).click();
  await pollB.getByRole('button', { name: 'Голосовать' }).click();
  await pollB.locator('.poll-answer.result.mine', { hasText: 'На следующей неделе' }).waitFor({ timeout: 4000 });
  ok((await pollB.locator('.poll-answer.mine .poll-pct').textContent()).startsWith('100%'), 'голос: результаты, мой вариант 100%');
  const pollA = pa.locator('.poll', { hasText: 'Когда релиз?' });
  await pollA.locator('.poll-foot', { hasText: '1 голос' }).waitFor({ timeout: 4000 });
  ok(true, 'автор видит голос вживую');
  await pollA.locator('.poll-answer', { hasText: 'В пятницу' }).click();
  await pollA.getByRole('button', { name: 'Голосовать' }).click();
  await pollB.locator('.poll-foot', { hasText: '2 голоса' }).waitFor({ timeout: 4000 });
  await pb.screenshot({ path: shot('poll.png') });
  await pollA.getByRole('button', { name: 'Завершить' }).click();
  await pollB.locator('.poll-foot', { hasText: 'Опрос завершён' }).waitFor({ timeout: 4000 });
  ok(await pollB.getByRole('button', { name: 'Отменить голос' }).count() === 0, 'опрос завершён: голосовать больше нельзя');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pa.screenshot({ path: shot('failure-a.png') }).catch(() => {});
  await pb.screenshot({ path: shot('failure-b.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nВЕТКИ UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

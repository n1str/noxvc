// E2E фазы 5 (локально, без настоящего SFU): присутствие в комнатах задаётся подписанными вебхуками LiveKit.
// Проверяется интерфейс: создание сцены, экран сцены (выступающие, слушатели, рука, приглашение),
// индикаторы камеры/экрана в боковой панели, входящий звонок в ЛС и полоса звонка.
//   LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… RELAY_URL=http://127.0.0.1:8099 node e2e/calls-ui.mjs
import { chromium } from 'playwright-core';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-5/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};
const b64u = (buf) => Buffer.from(buf).toString('base64url');
let sidN = 0;
async function webhook(event, ch, uid) {
  const body = JSON.stringify({ event, room: { name: `ch-${ch}` }, participant: { identity: String(uid), sid: `PA_${uid}_${event === 'participant_joined' ? ++sidN : sidN}` } });
  const now = Math.floor(Date.now() / 1000);
  const c = { iss: process.env.LIVEKIT_API_KEY, nbf: now, exp: now + 300, sha256: createHash('sha256').update(body).digest('base64') };
  const unsigned = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(c))}`;
  const sig = createHmac('sha256', process.env.LIVEKIT_API_SECRET).update(unsigned).digest('base64url');
  await fetch(B + '/api/livekit/webhook', { method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: `${unsigned}.${sig}` }, body });
}

const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'host' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'guest' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'Эфир ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
const voice = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'voice');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
async function open(token, view) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([t, v]) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(v)); }, [token, view]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
const pa = await open(a.token, g.id), pb = await open(b.token, g.id);
try {
  // создание сцены
  await pa.locator('.channel-group-title', { hasText: 'Голосовые каналы' }).getByRole('button').click();
  await pa.locator('.modal .radio-row', { hasText: 'Сцена' }).click();
  await pa.locator('.modal input[name="name"]').fill('Доклад');
  await pa.locator('.modal button[type="submit"]').click();
  await pa.locator('.channel', { hasText: 'Доклад' }).waitFor({ timeout: 5000 });
  const stage = (await api(a.token, 'GET', `/guilds/${g.id}`)).channels.find((c) => c.kind === 'stage');
  ok(stage?.name === 'Доклад', 'сцена создана через модалку');

  // экран сцены у второго (без подключения — просто открыть)
  await webhook('participant_joined', stage.id, a.user.id);
  await webhook('participant_joined', stage.id, b.user.id);
  await pb.locator('.channel', { hasText: 'Доклад' }).click();
  await pb.locator('.call-view .stage-label', { hasText: 'Выступают — 1' }).waitFor({ timeout: 5000 });
  ok(await pb.locator('.audience-member').count() === 1, 'сцена: 1 выступающий, 1 слушатель');
  ok(await pb.locator('.call-view .tile[data-uid="' + a.user.id + '"]').count() === 1, 'плитка выступающего');
  // рука и приглашение
  await api(b.token, 'POST', '/voice/hand', { raised: true });
  await pa.locator('.channel', { hasText: 'Доклад' }).click();
  const inviteBtn = pa.locator('.audience-member.hand').getByRole('button', { name: 'Пригласить выступить' });
  await inviteBtn.waitFor({ timeout: 5000 });
  await pb.locator('.voice-user .voice-flags .flag-hand').waitFor({ timeout: 4000 });
  ok(true, 'поднятая рука видна в боковой панели');
  await pa.screenshot({ path: shot('stage.png') });
  await inviteBtn.click();
  await pb.locator('.call-view .stage-label', { hasText: 'Выступают — 2' }).waitFor({ timeout: 5000 });
  ok(await pb.locator('.audience-member').count() === 0, 'модератор пригласил — слушатель стал выступающим');
  await webhook('participant_left', stage.id, a.user.id);
  await webhook('participant_left', stage.id, b.user.id);

  // камера и демонстрация — значки в боковой панели
  await webhook('participant_joined', voice.id, a.user.id);
  await api(a.token, 'PATCH', '/voice/state', { video: true, screen: true });
  await pb.locator('.voice-user', { hasText: 'host' + sfx }).locator('.small-live').waitFor({ timeout: 5000 });
  ok(await pb.locator('.voice-user', { hasText: 'host' + sfx }).locator('.voice-flags svg').count() >= 1, 'боковая панель: камера и «LIVE» у участника');
  await pb.locator('.channel', { hasText: voice.name }).click();
  await pb.locator('.call-view .tile[data-uid="' + a.user.id + '"]').waitFor({ timeout: 5000 });
  ok(await pb.locator('.call-controls').getByRole('button', { name: /Присоединиться|С камерой/ }).count() >= 1, 'экран голосового канала: плитки и кнопки входа');
  await pb.screenshot({ path: shot('voice-view.png') });
  await webhook('participant_left', voice.id, a.user.id);

  // звонок в ЛС: входящий звонок и полоса звонка
  const dm = await api(a.token, 'POST', '/dms', { user_id: b.user.id });
  await pb.goto(B + '/');
  await pb.waitForSelector('.shell');
  await webhook('participant_joined', dm.id, a.user.id);
  await pb.locator('.incoming-call', { hasText: 'host' + sfx }).waitFor({ timeout: 5000 });
  ok(true, 'входящий звонок: карточка с именем звонящего');
  await pb.screenshot({ path: shot('incoming-call.png') });
  await pb.locator('.incoming-call').getByRole('button', { name: 'Отклонить' }).click();
  await pb.locator('.incoming-call').waitFor({ state: 'detached', timeout: 3000 });
  ok(true, '«Отклонить» убирает карточку');
  await pb.locator('.rail-btn[aria-label="Личные сообщения"]').click();
  await pb.locator('.channel.dm .dm-call-dot').waitFor({ timeout: 4000 });
  ok(true, 'в списке ЛС — значок идущего звонка');
  await pb.locator('.channel.dm', { hasText: 'host' + sfx }).click();
  await pb.locator('.dm-call .tile[data-uid="' + a.user.id + '"]').waitFor({ timeout: 4000 });
  ok(await pb.locator('.dm-call').getByRole('button', { name: 'Присоединиться к звонку' }).count() === 1, 'полоса звонка в ЛС: участник и «Присоединиться»');
  await pb.waitForTimeout(500);
  await pb.screenshot({ path: shot('dm-call.png') });
  await webhook('participant_left', dm.id, a.user.id);
  await pb.locator('.dm-call').waitFor({ state: 'detached', timeout: 4000 });
  ok(true, 'звонок закончился — полоса исчезла');
  ok(await pb.locator('.chat-header').getByRole('button', { name: 'Позвонить' }).count() === 1, 'в шапке ЛС — кнопки звонка');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pa.screenshot({ path: shot('failure-a.png') }).catch(() => {});
  await pb.screenshot({ path: shot('failure-b.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nЗВОНКИ UI: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

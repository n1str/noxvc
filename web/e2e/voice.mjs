// E2E голоса в новом клиенте против развёрнутого сервера (реальный LiveKit), фейковый микрофон Chrome.
//   RELAY_URL=http://127.0.0.1:8080 node e2e/voice.mjs
// Создаёт двух тестовых пользователей (e2e_voice_*) и временный сервер, сервер в конце удаляется.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-2e/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // самоподписанный сертификат сервера

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json();
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'e2e_voice_a' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'e2e_voice_b' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'e2e голос ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);
await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Второй', kind: 'voice' });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
async function open(token) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, permissions: ['microphone'] });
  // Обработка звука выключена: шумоподавление вырезает стационарный тон фейкового микрофона, и SFU видит тишину.
  await ctx.addInitScript(([t, gid]) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(gid)); localStorage.setItem('relay_voice', JSON.stringify({ sounds: false, noise: false, echo: false, agc: false })); }, [token, g.id]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.logs = [];
  page.on('console', (m) => page.logs.push(`[${m.type()}] ${m.text().slice(0, 180)}`));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
const pa = await open(a.token), pb = await open(b.token);
const join = async (p) => { await p.locator('.channel', { hasText: 'Голосовой' }).click(); await p.locator('.voice-status b.ok').waitFor({ timeout: 15000 }); };
try {
  await join(pa);
  ok(true, 'A подключился к голосу (панель «Голос подключён»)');
  await join(pb);
  ok(true, 'B подключился к голосу');
  await pb.waitForFunction(() => document.querySelectorAll('.voice-users .voice-user').length === 2, null, { timeout: 8000 });
  ok(true, 'у B в канале видны оба участника (через вебхуки LiveKit)');
  // Фейковый микрофон Chrome издаёт тон — LiveKit должен определить говорящего.
  const speaking = await pb.waitForFunction((name) => [...document.querySelectorAll('.voice-user')].some((el) => el.textContent.includes(name) && el.querySelector('.avatar.speaking')),
    'e2e_voice_a', { timeout: 15000 }).then(() => true, () => false);
  ok(speaking, 'B видит, что A говорит (activeSpeakers через SFU)');
  await pb.screenshot({ path: shot('voice-connected.png') });

  // Качество связи: кодек Opus по WebRTC
  await pb.locator('.voice-status').click();
  await pb.waitForFunction(() => /opus/i.test(document.querySelector('.stats-grid')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const stats = await pb.locator('.modal').innerText();
  ok(/opus/i.test(stats), 'статистика: кодек Opus');
  await pb.screenshot({ path: shot('voice-quality.png') });
  await pb.keyboard.press('Escape');

  // Клик по участнику в голосовой комнате → мини-профиль с громкостью
  await pb.locator('.voice-user-inner', { hasText: 'e2e_voice_a' }).click();
  ok(await pb.locator('.profile-card .volume-row input[type="range"]').isVisible({ timeout: 3000 }).catch(() => false), 'клик по участнику в голосе: мини-профиль с громкостью');
  await pb.screenshot({ path: shot('voice-user-profile.png') });
  await pb.keyboard.press('Escape');

  // Перенос B владельцем: ПКМ → «Переместить в «Второй»»
  await pa.locator('.voice-user-inner', { hasText: 'e2e_voice_b' }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Переместить в «Второй»' }).click();
  await pb.locator('.voice-status', { hasText: 'Второй' }).waitFor({ timeout: 10000 });
  ok(true, 'ПКМ → Переместить: B сам переподключился во «Второй»');
  await pa.waitForFunction(() => [...document.querySelectorAll('.channel')].some((el) => el.textContent.includes('Второй')
    && el.nextElementSibling?.textContent?.includes('e2e_voice_b')), null, { timeout: 8000 });
  ok(true, 'у A участник B отображается во «Втором»');
  // Перетаскивание B обратно в «Голосовой»
  await pa.locator('.voice-user-inner', { hasText: 'e2e_voice_b' }).dragTo(pa.locator('.channel', { hasText: 'Голосовой' }));
  await pb.locator('.voice-status', { hasText: 'Голосовой' }).waitFor({ timeout: 10000 });
  ok(true, 'перетаскивание: B перенесён обратно в «Голосовой»');

  // Громкость A в карточке профиля у B
  await pb.locator('.member', { hasText: 'e2e_voice_a' }).click();
  ok(await pb.locator('.profile-card .volume-row input[type="range"]').isVisible({ timeout: 3000 }).catch(() => false), 'карточка профиля: ползунок громкости 0–200%');
  await pb.keyboard.press('Escape');

  // mute у A → у B значок muted
  await pa.locator('.user-panel').getByRole('button', { name: 'Выключить микрофон' }).click();
  const muted = await pb.waitForFunction((name) => [...document.querySelectorAll('.voice-user')].some((el) => el.textContent.includes(name) && el.classList.contains('muted')),
    'e2e_voice_a', { timeout: 8000 }).then(() => true, () => false);
  ok(muted, 'mute A виден B');

  // настройки голоса открываются
  await pa.getByRole('button', { name: 'Голос и звук' }).click();
  ok(await pa.locator('.modal h2', { hasText: 'Голос и звук' }).isVisible(), 'модалка настроек голоса');
  await pa.screenshot({ path: shot('voice-settings.png') });
  await pa.keyboard.press('Escape');

  // Отключение B владельцем
  await pa.locator('.voice-user-inner', { hasText: 'e2e_voice_b' }).click({ button: 'right' });
  await pa.getByRole('menuitem', { name: 'Отключить от голоса' }).click();
  await pb.locator('.voice-panel').waitFor({ state: 'detached', timeout: 8000 });
  ok(true, 'ПКМ → Отключить от голоса: у B панель голоса исчезла');
  await join(pb);

  // выход A → у B остаётся один
  await pa.locator('.voice-panel').getByRole('button', { name: 'Отключиться' }).click();
  await pb.waitForFunction(() => document.querySelectorAll('.voice-users .voice-user').length === 1, null, { timeout: 8000 });
  ok(true, 'выход A: у B в канале остался один участник');
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  console.log('--- консоль B (последние):', pb.logs.slice(-15));
  console.log('--- тосты B:', await pb.locator('.toast').allInnerTexts().catch(() => []));
  await pb.screenshot({ path: shot('voice-failure-b.png') }).catch(() => {});
  await pa.screenshot({ path: shot('voice-failure-a.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nГОЛОС: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

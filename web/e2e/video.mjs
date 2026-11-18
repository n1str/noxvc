// E2E фазы 5 против развёрнутого сервера (настоящий LiveKit): камера и демонстрация экрана в голосовом канале,
// звонок в ЛС с входящим вызовом и видео. Фейковые камера/микрофон Chrome.
//   RELAY_URL=http://127.0.0.1:8080 node e2e/video.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = new URL('../../screenshots/phase-5/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const shot = (n) => fileURLToPath(new URL(n, OUT));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return r.json();
};
const sfx = Date.now() % 100000;
const a = await api(null, 'POST', '/register', { username: 'e2e_voice_va' + sfx, password: 'secret12' });
const b = await api(null, 'POST', '/register', { username: 'e2e_voice_vb' + sfx, password: 'secret12' });
const g = await api(a.token, 'POST', '/guilds', { name: 'e2e видео ' + sfx });
const { code } = await api(a.token, 'POST', `/guilds/${g.id}/invites`);
await api(b.token, 'POST', `/invites/${code}`);

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen', '--auto-accept-this-tab-capture', '--enable-usermedia-screen-capturing'],
});
const errors = [];
async function open(token, view) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(([t, v]) => { localStorage.setItem('relay_token', JSON.stringify(t)); localStorage.setItem('relay_view', JSON.stringify(v)); localStorage.setItem('relay_voice', JSON.stringify({ sounds: false, noise: false, echo: false, agc: false })); }, [token, view]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForSelector('.shell');
  return page;
}
/** Видео в плитке действительно идёт: есть кадры (videoWidth) и время растёт. */
const playing = (p, sel) => p.waitForFunction(async (s) => {
  const v = document.querySelector(s);
  if (!v || !v.videoWidth) return false;
  const t0 = v.currentTime;
  await new Promise((r) => setTimeout(r, 300));
  return v.currentTime > t0;
}, sel, { timeout: 20000 }).then(() => true, () => false);

const pa = await open(a.token, g.id), pb = await open(b.token, g.id);
try {
  for (const p of [pa, pb]) {
    await p.locator('.channel', { hasText: 'Голосовой' }).click();
    await p.locator('.voice-status b.ok').waitFor({ timeout: 15000 });
  }
  ok(true, 'оба в голосовом канале, открыт экран звонка');
  ok(await pb.locator('.members .member-group-title', { hasText: 'В сети — 2' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'в списке участников оба в сети (в т.ч. сам себя)');
  await pb.locator(`.call-view .tile[data-uid="${a.user.id}"]`).waitFor({ timeout: 8000 });
  // камера
  await pa.locator('.call-controls').getByRole('button', { name: 'Включить камеру' }).click();
  ok(await playing(pb, `.call-view .tile[data-uid="${a.user.id}"][data-source="camera"] video`), 'B видит живое видео с камеры A');
  ok(await playing(pa, `.call-view .tile[data-uid="${a.user.id}"][data-source="camera"] video`), 'A видит своё превью (зеркально)');
  await pb.locator('.voice-user', { hasText: 'e2e_voice_va' }).locator('.voice-flags svg').first().waitFor({ timeout: 5000 });
  ok(true, 'боковая панель: значок камеры у A');
  await pb.screenshot({ path: shot('video-call.png') });
  // демонстрация экрана
  // окно качества перед запуском: 1080p, 60 FPS, плавность, H.264, 12 Мбит/с
  await pa.locator('.call-controls').getByRole('button', { name: 'Демонстрация экрана' }).click();
  const sm = pa.locator('.stream-modal');
  await sm.waitFor({ timeout: 4000 });
  await sm.locator('.seg-item', { hasText: '1080p' }).click();
  await sm.getByRole('radiogroup', { name: 'Частота кадров' }).locator('.seg-item', { hasText: '60' }).click();
  await sm.locator('.seg-item', { hasText: 'Плавность' }).click();
  await sm.getByRole('button', { name: 'Дополнительно: кодек и битрейт' }).click();
  await sm.locator('.seg-item', { hasText: 'H.264' }).click();
  await sm.locator('.range').fill('12000');
  await pa.screenshot({ path: shot('stream-settings.png') });
  await sm.getByRole('button', { name: 'Начать демонстрацию' }).click();
  const screenOk = await playing(pb, `.call-view .tile[data-uid="${a.user.id}"][data-source="screen"] video`);
  ok(screenOk, 'B видит демонстрацию экрана A (плитка «В ЭФИРЕ» в фокусе)');
  const sender = () => pa.evaluate(() => {
    const room = window.__relayVoice.room();
    const pub = [...room.localParticipant.trackPublications.values()].find((p) => p.source === 'screen_share' && p.kind === 'video');
    const snd = pub?.videoTrack?.sender;
    if (!snd) return null;
    const p = snd.getParameters();
    return { enc: p.encodings.map((e) => ({ max: e.maxBitrate, fps: e.maxFramerate })), codec: p.codecs?.[0]?.mimeType, deg: p.degradationPreference, hint: pub.videoTrack.mediaStreamTrack.contentHint };
  });
  let p1 = null;
  for (let i = 0; i < 25 && !(p1 && p1.codec); i++) { p1 = await sender(); if (!(p1 && p1.codec)) await pa.waitForTimeout(200); }
  ok(p1 && p1.enc.some((e) => e.max === 12_000_000 && e.fps === 60), `отправка: верхний слой 12 Мбит/с, 60 FPS (${JSON.stringify(p1?.enc)})`);
  ok(p1 && /h264/i.test(p1.codec || '') && p1.hint === 'motion', `кодек H.264, режим «плавность» (${p1?.codec}, ${p1?.hint}, ${p1?.deg})`);
  if (screenOk) {
    // приём: кодек и статистика на плитке
    const tile = pb.locator(`.call-view .tile[data-uid="${a.user.id}"][data-source="screen"]`);
    await tile.hover();
    await tile.locator('.tile-info').click();
    await tile.locator('.tile-stats', { hasText: 'FPS' }).waitFor({ timeout: 6000 });
    await pb.waitForTimeout(2200);
    const statsText = await tile.locator('.tile-stats').textContent();
    ok(/H264/i.test(statsText), `приём: оверлей статистики (${statsText})`);
    await pb.screenshot({ path: shot('stream-stats.png') });
    // смена качества на лету: 720p 30 FPS, без повторного выбора окна
    await pa.locator('.call-controls').getByRole('button', { name: 'Качество трансляции' }).click();
    await pa.locator('.stream-modal .seg-item', { hasText: '720p' }).click();
    await pa.locator('.stream-modal').getByRole('radiogroup', { name: 'Частота кадров' }).locator('.seg-item', { hasText: '30' }).click();
    await pa.locator('.stream-modal').getByRole('button', { name: 'Применить' }).click();
    await pa.waitForTimeout(500);
    const p2 = await sender();
    ok(p2 && p2.enc.some((e) => e.fps === 30), `на лету: 30 FPS применено без перезапуска (${JSON.stringify(p2?.enc)})`);
    ok(await pb.locator(`.call-view .tile[data-uid="${a.user.id}"][data-source="screen"]`).count() === 1, 'трансляция не прервалась');
    ok(await pb.locator('.call-grid.spotlight .spot-main .tile.screen').waitFor({ timeout: 3000 }).then(() => true, () => false), 'демонстрация автоматически в фокусе');
    await pb.screenshot({ path: shot('screen-share.png') });
    await pa.locator('.call-controls').getByRole('button', { name: 'Остановить демонстрацию' }).click();
    await pb.locator(`.call-view .tile[data-uid="${a.user.id}"][data-source="screen"]`).waitFor({ state: 'detached', timeout: 8000 });
    ok(true, 'демонстрация остановлена — плитка исчезла');
  }
  await pa.locator('.call-controls').getByRole('button', { name: 'Выключить камеру' }).click();
  await pb.locator(`.call-view .tile[data-uid="${a.user.id}"] video`).waitFor({ state: 'detached', timeout: 8000 });
  ok(true, 'камера выключена — вместо видео аватар');
  for (const p of [pa, pb]) await p.locator('.call-controls').getByRole('button', { name: 'Отключиться' }).click();
  await pa.waitForTimeout(800);

  // звонок в ЛС
  const dm = await api(a.token, 'POST', '/dms', { user_id: b.user.id });
  await pa.goto(B + '/#'); await pa.reload(); await pa.waitForSelector('.shell');
  await pa.locator('.rail-btn[aria-label="Личные сообщения"]').click();
  await pa.locator('.channel.dm', { hasText: 'e2e_voice_vb' }).click();
  await pa.locator('.chat-header').getByRole('button', { name: 'Видеозвонок' }).click();
  await pb.locator('.incoming-call').waitFor({ timeout: 15000 });
  ok(true, 'B получил входящий звонок');
  await pb.screenshot({ path: shot('incoming-real.png') });
  await pb.locator('.incoming-call').getByRole('button', { name: 'Ответить', exact: true }).click();
  await pb.locator('.voice-status b.ok').waitFor({ timeout: 15000 });
  await pb.waitForFunction(() => document.querySelectorAll('.dm-call .tile').length >= 2, null, { timeout: 10000 });
  ok(true, 'B ответил: в полосе звонка оба участника');
  ok(await playing(pb, `.dm-call .tile[data-uid="${a.user.id}"][data-source="camera"] video`), 'в звонке ЛС B видит видео A');
  await pb.screenshot({ path: shot('dm-video-call.png') });
  for (const p of [pa, pb]) await p.locator('.dm-call .call-controls').getByRole('button', { name: 'Отключиться' }).click();
} catch (e) {
  ok(false, 'исключение: ' + e.message.split(String.fromCharCode(10))[0]);
  await pa.screenshot({ path: shot('real-failure-a.png') }).catch(() => {});
  await pb.screenshot({ path: shot('real-failure-b.png') }).catch(() => {});
}
ok(errors.length === 0, `без JS-исключений${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
await api(a.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nВИДЕО: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

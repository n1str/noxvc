import { gatewayConnect } from './lib.mjs';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';

// Поддельный LiveKit RoomService: запоминаем вызовы (сервер запускать с LIVEKIT_URL=http://127.0.0.1:7999).
const lkCalls = [];
const lkMock = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    lkCalls.push({ method: req.url.split('/').pop(), body: JSON.parse(body || '{}') });
    // Случайная задержка ответа: моделируем сеть, в которой запросы могли бы обогнать друг друга.
    setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'), Math.random() * 40);
  });
}).listen(+(process.env.LK_MOCK_PORT || 7999), '127.0.0.1');
// Сквозной тест Relay (запуск: RELAY_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node tests/smoke.mjs): два пользователя, сервер, инвайт, сообщения, WS-события, права.
const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
async function api(tok, method, path, body) {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const wsConnect = (tok) => gatewayConnect(tok);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (ws, type) => ws.events.find((e) => e.type === type);

const sfx = Date.now() % 100000;
const a = (await api(null, 'POST', '/register', { username: 'alice' + sfx, password: 'secret12' })).data;
const b = (await api(null, 'POST', '/register', { username: 'bob' + sfx, password: 'secret12' })).data;
ok(a.token && b.token, 'регистрация');
ok((await api(null, 'POST', '/register', { username: 'alice' + sfx, password: 'secret12' })).status === 409, 'дубль имени → 409');
ok((await api(null, 'POST', '/login', { username: 'alice' + sfx, password: 'wrong123' })).status === 401, 'неверный пароль → 401');
ok((await api(null, 'POST', '/login', { username: 'ALICE' + sfx, password: 'secret12' })).data.token, 'вход (без учёта регистра)');
ok((await api(null, 'GET', '/me')).status === 401, 'без токена → 401');

const g = (await api(a.token, 'POST', '/guilds', { name: 'Тест' })).data;
const det = (await api(a.token, 'GET', `/guilds/${g.id}`)).data;
const text = det.channels.find((c) => c.kind === 'text'), voice = det.channels.find((c) => c.kind === 'voice');
ok(text && voice, 'сервер создан с текстовым и голосовым каналом');
ok((await api(b.token, 'GET', `/guilds/${g.id}`)).status === 404, 'чужой сервер недоступен');
ok((await api(b.token, 'GET', `/channels/${text.id}/messages`)).status === 404, 'чужой канал недоступен');

const wa = await wsConnect(a.token), wb = await wsConnect(b.token);
const { code } = (await api(a.token, 'POST', `/guilds/${g.id}/invites`)).data;
ok((await api(b.token, 'GET', `/invites/${code}`)).data.name === 'Тест', 'просмотр инвайта');
ok((await api(b.token, 'POST', `/invites/${code}`)).data.id === g.id, 'вход по инвайту');
await wait(150);
ok(has(wa, 'member_add'), 'WS: member_add у владельца');

const m = (await api(b.token, 'POST', `/channels/${text.id}/messages`, { content: `привет @alice${sfx} **жирный**` })).data;
await wait(150);
ok(wa.events.find((e) => e.type === 'message_create' && e.message.id === m.id), 'WS: message_create доставлен');
ok((await api(a.token, 'POST', `/channels/${voice.id}/messages`, { content: 'x' })).status === 400, 'в голосовой писать нельзя');
ok((await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: 'x'.repeat(4001) })).status === 400, 'лимит длины');
ok((await api(a.token, 'PATCH', `/messages/${m.id}`, { content: 'взлом' })).status === 403, 'чужое сообщение не редактируется');
ok((await api(b.token, 'PATCH', `/messages/${m.id}`, { content: 'исправлено' })).data.edited_at, 'автор редактирует');
const r1 = (await api(a.token, 'PUT', `/messages/${m.id}/reactions/${encodeURIComponent('🔥')}`)).data;
ok(r1[0]?.emoji === '🔥' && r1[0].users.length === 1, 'реакция поставлена');
ok((await api(a.token, 'PUT', `/messages/${m.id}/reactions/${encodeURIComponent('🔥')}`)).data.length === 0, 'реакция снята');
const reply = (await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: 'ответ', reply_to: m.id })).data;
ok(reply.reply_to?.id === m.id, 'ответ на сообщение');
ok((await api(b.token, 'PUT', `/messages/${m.id}/pin`)).status === 403, 'не-владелец не закрепляет');
ok((await api(a.token, 'PUT', `/messages/${m.id}/pin`)).data.pinned, 'владелец закрепляет');
ok((await api(a.token, 'GET', `/channels/${text.id}/messages?pinned=true`)).data.length === 1, 'список закреплённых');
ok((await api(a.token, 'GET', `/channels/${text.id}/messages?q=${encodeURIComponent('исправ')}`)).data.length === 1, 'поиск');
ok((await api(a.token, 'GET', `/channels/${text.id}/messages?q=${encodeURIComponent('%')}`)).data.length === 0, 'поиск экранирует %');

await api(a.token, 'POST', `/channels/${text.id}/typing`);
await wait(150);
ok(has(wb, 'typing_start'), 'gateway: TYPING_START');

// --- голос: токены LiveKit и вебхуки (сервер — источник правды о голосовых состояниях) ---
const LK_KEY = process.env.LIVEKIT_API_KEY, LK_SECRET = process.env.LIVEKIT_API_SECRET;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const jwtClaims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url'));
async function webhook(event, channelId, userId, { secret = LK_SECRET, tamper = false, sid } = {}) {
  const body = JSON.stringify({ event, room: { name: `ch-${channelId}` }, participant: userId == null ? undefined : { identity: String(userId), ...(sid && { sid }) } });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: LK_KEY, nbf: now, exp: now + 300, sha256: createHash('sha256').update(body).digest('base64') };
  const unsigned = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(claims))}`;
  const sig = createHmac('sha256', secret).update(unsigned).digest('base64url');
  const r = await fetch(B + '/api/livekit/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: `${unsigned}.${sig}` },
    body: tamper ? body.replace(event, 'participant_left') : body,
  });
  return r.status;
}
const states = (ws, uid) => ws.events.filter((e) => e.type === 'voice_state' && e.state.user_id === uid);

const tok = await api(a.token, 'POST', '/voice/token', { channel_id: voice.id });
ok(tok.status === 200 && jwtClaims(tok.data.token).video.room === `ch-${voice.id}` && jwtClaims(tok.data.token).sub === String(a.user.id), 'токен голоса: комната и identity');
ok(tok.data.bitrate === 64000, 'битрейт канала по умолчанию 64 кбит/с');
ok((await api(a.token, 'POST', '/voice/token', { channel_id: text.id })).status === 400, 'токен на текстовый канал — 400');
const stranger = (await api(null, 'POST', '/register', { username: 'eve' + sfx, password: 'secret12' })).data;
ok((await api(stranger.token, 'POST', '/voice/token', { channel_id: voice.id })).status === 404, 'токен чужого сервера — 404');

ok((await webhook('participant_joined', voice.id, a.user.id, { secret: 'x'.repeat(32) })) === 401, 'вебхук с чужой подписью — 401');
ok((await webhook('participant_joined', voice.id, a.user.id, { tamper: true })) === 401, 'вебхук с подменённым телом — 401');
ok(states(wb, a.user.id).length === 0, 'невалидные вебхуки не меняют состояние');
ok((await webhook('participant_joined', voice.id, a.user.id)) === 200, 'валидный вебхук принят');
await wait(100);
ok(states(wb, a.user.id).at(-1)?.state.channel_id === voice.id, 'participant_joined → voice_state у участников');
ok((await api(b.token, 'GET', `/guilds/${g.id}`)).data.voice.length === 1, 'голосовые состояния в детали сервера');
await webhook('participant_joined', voice.id, stranger.user.id);
await wait(100);
ok((await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.length === 1, 'вебхук о постороннем не создаёт состояние');

await api(a.token, 'PATCH', '/voice/state', { muted: true });
await wait(100);
ok(states(wb, a.user.id).at(-1)?.state.muted === true, 'voice_update: mute виден остальным');

// лимит участников
ok((await api(b.token, 'PATCH', `/channels/${voice.id}`, { user_limit: 1 })).status === 403, 'лимит меняет только владелец');
ok((await api(a.token, 'PATCH', `/channels/${voice.id}`, { bitrate: 50000 })).status === 400, 'битрейт только из списка');
ok((await api(a.token, 'PATCH', `/channels/${voice.id}`, { user_limit: 1, bitrate: 96000 })).data.user_limit === 1, 'лимит и битрейт сохранены');
ok((await api(b.token, 'POST', '/voice/token', { channel_id: voice.id })).status === 400, 'полный канал — 400');
ok((await api(a.token, 'POST', '/voice/token', { channel_id: voice.id })).data.bitrate === 96000, 'тот, кто уже внутри, переподключается; битрейт 96');
await api(a.token, 'PATCH', `/channels/${voice.id}`, { user_limit: 0 });

// переход между каналами: left старой комнаты после joined новой не выкидывает
const voice2 = (await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Второй', kind: 'voice' })).data;
await webhook('participant_joined', voice2.id, a.user.id);
await webhook('participant_left', voice.id, a.user.id);
await wait(100);
ok(states(wb, a.user.id).at(-1)?.state.channel_id === voice2.id, 'запоздалый left прошлой комнаты игнорируется');
await webhook('participant_left', voice2.id, a.user.id);
await wait(100);
const leftEv = states(wa, a.user.id).at(-1)?.state;
ok(leftEv?.channel_id === null && leftEv.prev_channel_id === voice2.id, 'left → «вышел» с prev_channel_id');

// кик во время разговора: сервер сам снимает состояние и шлёт «вышел» выгнанному
await webhook('participant_joined', voice.id, b.user.id);
await wait(100);
await api(a.token, 'DELETE', `/guilds/${g.id}/members/${b.user.id}`);
await wait(100);
const kicked = states(wb, b.user.id).at(-1)?.state;
ok(kicked?.channel_id === null && kicked.prev_channel_id === voice.id, 'кик: выгнанный получает «вышел»');
ok((await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.length === 0, 'кик: голосовое состояние снято');
await webhook('participant_joined', voice.id, b.user.id);
await wait(100);
ok((await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.length === 0, 'кик: вход со старым токеном не восстанавливает состояние');
ok(lkCalls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === String(b.user.id)), 'кик: RemoveParticipant в LiveKit');
await api(b.token, 'POST', `/invites/${code}`); // вернуть b для дальнейших проверок

// Регрессия X13#2/#3: изменение прав роли меняет уже действующий голос.
const SPEAK = 2 ** 21, CONNECT = 2 ** 20;
const evRole = (await api(a.token, 'GET', `/guilds/${g.id}`)).data.roles.find((r) => r.is_default);
await webhook('participant_joined', voice.id, b.user.id);
await wait(100);
lkCalls.length = 0;
await api(a.token, 'PATCH', `/roles/${evRole.id}`, { permissions: evRole.permissions - SPEAK });
await wait(200);
// Фаза 5: SPEAK отвечает только за микрофон (камера/экран — по STREAM).
const noMic = (c) => !(c.body.permission?.canPublishSources ?? []).includes('MICROPHONE');
ok(lkCalls.some((c) => c.method === 'UpdateParticipant' && c.body.identity === String(b.user.id) && noMic(c)),
  'отзыв SPEAK у роли → UpdateParticipant без микрофона');
// Регрессия X14: быстрые переключения SPEAK — последним в LiveKit применяется актуальное состояние.
await api(a.token, 'PATCH', `/roles/${evRole.id}`, { permissions: evRole.permissions });
await api(a.token, 'PATCH', `/roles/${evRole.id}`, { permissions: evRole.permissions - SPEAK });
await wait(300);
const lastUpd = lkCalls.filter((c) => c.method === 'UpdateParticipant' && c.body.identity === String(b.user.id)).at(-1);
ok(lastUpd && noMic(lastUpd), 'быстрые переключения SPEAK: последним применён запрет микрофона');
await api(a.token, 'PATCH', `/roles/${evRole.id}`, { permissions: evRole.permissions - SPEAK - CONNECT });
await wait(200);
ok(lkCalls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === String(b.user.id)), 'отзыв CONNECT у роли → RemoveParticipant');
ok((await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.every((v) => v.user_id !== b.user.id), 'отзыв CONNECT → голосовое состояние снято');
await api(a.token, 'PATCH', `/roles/${evRole.id}`, { permissions: evRole.permissions });

// Регрессия: быстрый перезаход в ту же комнату — запоздалый left старой сессии не снимает новую.
await webhook('participant_joined', voice.id, b.user.id, { sid: 'PA_old' });
await webhook('participant_joined', voice.id, b.user.id, { sid: 'PA_new' });
await webhook('participant_left', voice.id, b.user.id, { sid: 'PA_old' });
await wait(100);
ok((await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.some((v) => v.user_id === b.user.id), 'left старой сессии не снимает новую (sid)');
await webhook('participant_left', voice.id, b.user.id, { sid: 'PA_new' });
await wait(100);
ok((await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.every((v) => v.user_id !== b.user.id), 'left текущей сессии снимает состояние');

// Перенос и отключение участников в голосе (MOVE_MEMBERS).
const moveTo = (tok, channel_id) => api(tok, 'POST', `/guilds/${g.id}/voice/move`, { user_id: b.user.id, channel_id });
await webhook('participant_joined', voice.id, b.user.id);
await wait(100);
lkCalls.length = 0;
ok((await moveTo(b.token, voice2.id)).status === 403, 'перенос без MOVE_MEMBERS — 403');
ok((await moveTo(a.token, text.id)).status === 400, 'перенос в текстовый канал — 400');
const mark3 = wb.events.length, markA = wa.events.length;
ok((await moveTo(a.token, voice2.id)).status === 200, 'владелец переносит участника');
await wait(150);
const mv = wb.events.slice(mark3).find((e) => e.type === 'voice_move');
ok(mv && mv.channel.id === voice2.id && jwtClaims(mv.token).video.room === `ch-${voice2.id}` && jwtClaims(mv.token).sub === String(b.user.id),
  'переносимому: VOICE_MOVE с токеном новой комнаты');
ok(!wa.events.slice(markA).some((e) => e.type === 'voice_move'), 'токен переноса не уходит другим');
await webhook('participant_joined', voice2.id, b.user.id); // клиент перешёл
await wait(3300);
ok(!lkCalls.some((c) => c.method === 'RemoveParticipant' && c.body.room === `ch-${voice.id}`), 'перешедшего не выкидывают');
// Регрессия: перенесли туда и сразу обратно (новая сессия в исходной комнате) — таймер первого переноса не выкидывает.
await webhook('participant_joined', voice.id, b.user.id, { sid: 'PA_s1' });
await wait(100);
lkCalls.length = 0;
await moveTo(a.token, voice2.id);
await webhook('participant_joined', voice2.id, b.user.id, { sid: 'PA_s2' });
await moveTo(a.token, voice.id);
await webhook('participant_joined', voice.id, b.user.id, { sid: 'PA_s3' });
await wait(3400);
ok(!lkCalls.some((c) => c.method === 'RemoveParticipant'), 'туда-обратно за 3 с: таймер первого переноса не выкидывает новую сессию');
await webhook('participant_joined', voice.id, b.user.id);
await wait(100);
lkCalls.length = 0;
await moveTo(a.token, voice2.id); // клиент «не послушался» — joined в новой комнате не приходит
await wait(3400);
ok(lkCalls.some((c) => c.method === 'RemoveParticipant' && c.body.room === `ch-${voice.id}` && c.body.identity === String(b.user.id)),
  'проигнорировавшего перенос сервер выкидывает из старой комнаты');
await webhook('participant_joined', voice.id, b.user.id);
await wait(100);
lkCalls.length = 0;
ok((await moveTo(a.token, null)).status === 200, 'отключение от голоса');
await wait(150);
ok(lkCalls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === String(b.user.id))
  && (await api(a.token, 'GET', `/guilds/${g.id}`)).data.voice.every((v) => v.user_id !== b.user.id), 'отключённый выкинут из LiveKit, состояние снято');

// Регрессия X13#5: лимит 20 разных реакций держится при параллельных запросах.
const rm = (await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: 'реакции' })).data;
for (let i = 1; i <= 19; i++) await api(a.token, 'PUT', `/messages/${rm.id}/reactions/e${i}`);
await Promise.all([20, 21, 22, 23, 24, 25].map((i) => api(b.token, 'PUT', `/messages/${rm.id}/reactions/e${i}`)));
const finalR = (await api(a.token, 'GET', `/channels/${text.id}/messages?limit=1`)).data.at(-1).reactions;
ok(finalR.length === 20, `параллельные реакции: ровно 20 разных (получилось ${finalR.length})`);

ok((await api(b.token, 'POST', `/guilds/${g.id}/channels`, { name: 'x' })).status === 403, 'не-владелец не создаёт каналы');
const nc = (await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Новости Проекта' })).data;
ok(nc.name === 'новости-проекта', 'нормализация имени канала');

const dm = (await api(a.token, 'POST', '/dms', { username: 'bob' + sfx })).data;
await wait(100);
ok(dm.id && has(wb, 'dm_create'), 'ЛС создано, собеседник уведомлён');
ok((await api(b.token, 'POST', '/dms', { user_id: a.user.id })).data.id === dm.id, 'ЛС не дублируется');
await api(a.token, 'POST', `/channels/${dm.id}/messages`, { content: 'лично' });
ok((await api(b.token, 'GET', `/channels/${dm.id}/messages`)).data.length === 1, 'сообщение в ЛС');

const fd = new FormData();
fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
const up = await (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fd })).json();
ok(up.url?.endsWith('.bin'), 'html-файл сохраняется как .bin');
const fr = await fetch(B + up.url);
ok(!fr.headers.get('content-type')?.includes('html') && fr.headers.get('x-content-type-options') === 'nosniff', 'загруженный файл не отдаётся как html');
ok((await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: '', attachment: { url: '/uploads/../relay.db', name: 'x' } })).status === 400, 'вложение с ../ отклонено');

ok((await api(b.token, 'DELETE', `/guilds/${g.id}/members/${b.user.id}`)).data.ok, 'выход с сервера');
ok((await api(b.token, 'GET', `/guilds/${g.id}`)).status === 404, 'после выхода доступа нет');
ok((await api(a.token, 'DELETE', `/guilds/${g.id}`)).data.ok, 'удаление сервера');
wa.close(); wb.close();
console.log(fails ? `\n${fails} FAIL` : '\nВСЕ ТЕСТЫ ПРОШЛИ');
lkMock.close();
process.exit(fails ? 1 : 0);

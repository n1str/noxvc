// Фаза 5: права на камеру/экран в токене, звонки в ЛС (звонок-«ring», аудитория), флаги камеры/экрана, сцена.
//   LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… RELAY_URL=http://127.0.0.1:8099 node tests/calls.mjs
//   (сервер с LIVEKIT_URL=http://127.0.0.1:7999 — здесь поднимается заглушка LiveKit)
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { B, api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const lkCalls = [];
const lkMock = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => { lkCalls.push({ method: req.url.split('/').pop(), body: JSON.parse(body || '{}') }); res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); });
}).listen(7999, '127.0.0.1');
const LK_KEY = process.env.LIVEKIT_API_KEY, LK_SECRET = process.env.LIVEKIT_API_SECRET;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).video;
let sidN = 0;
async function webhook(event, channelId, userId) {
  const body = JSON.stringify({ event, room: { name: `ch-${channelId}` }, participant: { identity: String(userId), sid: `PA_${userId}_${event === 'participant_joined' ? ++sidN : sidN}` } });
  const now = Math.floor(Date.now() / 1000);
  const c = { iss: LK_KEY, nbf: now, exp: now + 300, sha256: createHash('sha256').update(body).digest('base64') };
  const unsigned = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(c))}`;
  const sig = createHmac('sha256', LK_SECRET).update(unsigned).digest('base64url');
  return (await fetch(B + '/api/livekit/webhook', { method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: `${unsigned}.${sig}` }, body })).status;
}

const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const [owner, user, third] = await Promise.all(['co', 'cu', 'ct'].map(reg));
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Звонки' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const gd = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data;
const voice = gd.channels.find((c) => c.kind === 'voice');
const everyone = gd.roles.find((r) => r.is_default);

// ---------- права публикации в токене ----------
let t = await api(user.token, 'POST', '/voice/token', { channel_id: voice.id });
ok(JSON.stringify(claims(t.data.token).canPublishSources) === JSON.stringify(['microphone', 'camera', 'screen_share', 'screen_share_audio']), 'токен: микрофон, камера, экран (SPEAK + STREAM)');
await api(owner.token, 'PUT', `/channels/${voice.id}/permissions/role/${everyone.id}`, { allow: 0, deny: 1 << 9 });
t = await api(user.token, 'POST', '/voice/token', { channel_id: voice.id });
ok(JSON.stringify(claims(t.data.token).canPublishSources) === JSON.stringify(['microphone']), 'без STREAM — только микрофон');
// права меняются, пока в голосе — LiveKit получает новый набор источников
await webhook('participant_joined', voice.id, user.user.id);
lkCalls.length = 0;
await api(owner.token, 'DELETE', `/channels/${voice.id}/permissions/role/${everyone.id}`);
await wait(300);
const upd = lkCalls.filter((c) => c.method === 'UpdateParticipant' && c.body.identity === String(user.user.id)).at(-1);
ok(upd && upd.body.permission.canPublishSources.includes('CAMERA') && upd.body.permission.canPublishSources.includes('SCREEN_SHARE'), 'вернули STREAM — LiveKit разрешает камеру и экран');

// флаги камеры/экрана видны всем
const gwO = await gatewayConnect(owner.token);
await api(user.token, 'PATCH', '/voice/state', { video: true, screen: true });
await wait(150);
const vs = gwO.events.filter((e) => e.type === 'voice_state' && e.state.user_id === user.user.id).at(-1);
ok(vs?.state.video === true && vs.state.screen === true, 'флаги камеры и экрана — в VOICE_STATE');
await webhook('participant_left', voice.id, user.user.id);

// ---------- звонки в ЛС ----------
const dm = (await api(owner.token, 'POST', '/dms', { user_id: user.user.id })).data;
t = await api(owner.token, 'POST', '/voice/token', { channel_id: dm.id });
ok(t.status === 200 && claims(t.data.token).room === `ch-${dm.id}` && claims(t.data.token).canPublishSources.includes('camera'), 'токен звонка в ЛС (всё разрешено)');
ok((await api(third.token, 'POST', '/voice/token', { channel_id: dm.id })).status === 404, 'чужая ЛС — 404');
const gwU = await gatewayConnect(user.token);
const gwT = await gatewayConnect(third.token);
await webhook('participant_joined', dm.id, owner.user.id);
await wait(200);
ok(gwU.events.some((e) => e.type === 'call_ring' && e.channel_id === dm.id && e.user_id === owner.user.id), 'собеседнику — входящий звонок (call_ring)');
ok(!gwO.events.some((e) => e.type === 'call_ring'), 'звонящему call_ring не приходит');
ok(gwU.events.some((e) => e.type === 'voice_state' && e.state.channel_id === dm.id && e.state.guild_id === null), 'VOICE_STATE звонка — участникам ЛС (guild_id = null)');
ok(!gwT.events.some((e) => e.type === 'voice_state'), 'посторонним состояние звонка не уходит');
gwU.events.length = 0;
await webhook('participant_joined', dm.id, user.user.id);
await wait(150);
ok(!gwO.events.some((e) => e.type === 'call_ring'), 'ответивший — повторного звонка нет');
ok((await api(owner.token, 'GET', '/me')).data.voice.filter((v) => v.channel_id === dm.id).length === 2, 'снимок /me: кто в звонке ЛС');
await webhook('participant_left', dm.id, user.user.id);
await wait(150);
ok(gwO.events.some((e) => e.type === 'voice_state' && e.state.user_id === user.user.id && e.state.channel_id === null && e.state.prev_channel_id === dm.id), 'выход из звонка виден собеседнику');
await webhook('participant_left', dm.id, owner.user.id);
// блокировка — нельзя позвонить
await api(user.token, 'PUT', `/relationships/${owner.user.id}/block`);
ok((await api(owner.token, 'POST', '/voice/token', { channel_id: dm.id })).status === 403, 'заблокировавшему позвонить нельзя');
await api(user.token, 'DELETE', `/relationships/${owner.user.id}`);

// ---------- сцена ----------
const stage = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Доклад', kind: 'stage' })).data;
ok(stage.kind === 'stage', 'сцена создана');
t = await api(user.token, 'POST', '/voice/token', { channel_id: stage.id });
ok(t.status === 200 && claims(t.data.token).canPublish === false, 'слушатель входит без права говорить');
t = await api(owner.token, 'POST', '/voice/token', { channel_id: stage.id });
ok(claims(t.data.token).canPublishSources.includes('microphone'), 'модератор сцены — выступающий');
gwO.events.length = 0;
await webhook('participant_joined', stage.id, user.user.id);
await webhook('participant_joined', stage.id, owner.user.id);
await wait(150);
let st = (uid) => gwO.events.filter((e) => e.type === 'voice_state' && e.state.user_id === uid).at(-1)?.state;
ok(st(user.user.id)?.suppress === true && st(owner.user.id)?.suppress === false, 'состояния сцены: слушатель и выступающий');
ok((await api(user.token, 'POST', '/voice/hand', { raised: true })).status === 200, 'поднять руку');
await wait(100);
ok(typeof st(user.user.id)?.hand === 'number', 'рука поднята — видно всем');
ok((await api(user.token, 'POST', `/voice/stage/${user.user.id}`, { speaker: true })).status === 403, 'слушатель сам не выходит на сцену');
lkCalls.length = 0;
ok((await api(owner.token, 'POST', `/voice/stage/${user.user.id}`, { speaker: true })).status === 200, 'модератор пригласил выступить');
await wait(150);
ok(st(user.user.id)?.suppress === false && st(user.user.id)?.hand === null, 'выступающий, рука опущена');
ok(lkCalls.some((c) => c.method === 'UpdateParticipant' && c.body.identity === String(user.user.id) && c.body.permission.canPublish === true), 'LiveKit: разрешено говорить');
t = await api(user.token, 'POST', '/voice/token', { channel_id: stage.id });
ok(claims(t.data.token).canPublish === true, 'переподключение сохраняет роль выступающего');
ok((await api(user.token, 'POST', `/voice/stage/${user.user.id}`, { speaker: false })).status === 200, 'сам ушёл в слушатели');
await wait(100);
ok(st(user.user.id)?.suppress === true, 'снова слушатель');
ok((await api(user.token, 'POST', '/voice/hand', { raised: true })).status === 200 && (await api(owner.token, 'POST', '/voice/hand', { raised: true })).status === 400, 'выступающему руку поднимать незачем');
ok((await api(user.token, 'POST', `/channels/${stage.id}/messages`, { content: 'x' })).status === 400, 'в сцену не пишут сообщения');

gwO.close(); gwU.close(); gwT.close();
lkMock.close();
await api(owner.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nЗВОНКИ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

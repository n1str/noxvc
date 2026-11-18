// Тесты протокола gateway. Сервер запускать с RELAY_HEARTBEAT_MS=1000 RELAY_PRESENCE_GRACE_MS=400.
import { B, api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const a = await reg('gwa'), b = await reg('gwb');

/** «Сырой» сокет: собирает все кадры, ничего не шлёт сам. */
function raw() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${B.replace(/^http/, 'ws')}/gateway`);
    const r = { ws, frames: [], closed: false, send: (op, d) => ws.send(JSON.stringify({ op, d })) };
    ws.onmessage = (e) => { r.frames.push(JSON.parse(e.data)); if (r.frames.length === 1) resolve(r); };
    ws.onclose = () => { r.closed = true; };
  });
}

// HELLO и IDENTIFY
const r1 = await raw();
ok(r1.frames[0].op === 10 && r1.frames[0].d.heartbeat_interval > 0, 'HELLO с heartbeat_interval');
r1.send(2, { token: 'неверный' });
await wait(200);
ok(r1.frames.some((f) => f.op === 9) && r1.closed, 'IDENTIFY с неверным токеном → INVALID_SESSION и закрытие');

const ga = await gatewayConnect(a.token);
ok(ga.raw.find((f) => f.t === 'READY')?.s === 1 && ga.session && ga.ready.user.id === a.user.id, 'READY: s=1, session_id, пользователь');
ok(Array.isArray(ga.ready.guilds) && Array.isArray(ga.ready.dms), 'READY: снимок серверов и ЛС');
await wait(1200);
ok(ga.acks > 0, 'HEARTBEAT → HEARTBEAT_ACK');

// Монотонный s
const g = (await api(a.token, 'POST', '/guilds', { name: 'Шлюз' })).data;
const text = (await api(a.token, 'GET', `/guilds/${g.id}`)).data.channels.find((c) => c.kind === 'text');
for (let i = 0; i < 3; i++) await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: `m${i}` });
await wait(150);
const seqs = ga.raw.filter((f) => f.op === 0).map((f) => f.s);
ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `s растёт без пропусков (${seqs.join(',')})`);

// RESUME: пропущенное за время обрыва досылается по порядку
const { session } = ga;
const lastSeq = ga.seq;
ga.close();
await wait(100);
for (let i = 0; i < 3; i++) await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: `пропущено ${i}` });
const r2 = await raw();
r2.send(6, { token: a.token, session_id: session, seq: lastSeq });
await wait(300);
const replay = r2.frames.filter((f) => f.op === 0);
ok(replay.length === 4 && replay.slice(0, 3).every((f, i) => f.t === 'MESSAGE_CREATE' && f.d.message.content === `пропущено ${i}` && f.s === lastSeq + 1 + i),
  'RESUME: три пропущенных MESSAGE_CREATE по порядку, s продолжается');
ok(replay.at(-1)?.t === 'RESUMED', 'RESUME завершается RESUMED');
r2.ws.close();

// RESUME, который выполнить нельзя
const r3 = await raw();
r3.send(6, { token: b.token, session_id: session, seq: lastSeq });
await wait(200);
ok(r3.frames.some((f) => f.op === 9), 'RESUME чужой сессии → INVALID_SESSION');
const r4 = await raw();
r4.send(6, { token: a.token, session_id: session, seq: 99999 });
await wait(200);
ok(r4.frames.some((f) => f.op === 9), 'RESUME с seq из будущего → INVALID_SESSION');
const r5 = await raw();
r5.send(6, { token: a.token, session_id: 'нет-такой', seq: 1 });
await wait(200);
ok(r5.frames.some((f) => f.op === 9), 'RESUME несуществующей сессии → INVALID_SESSION');

// «Зомби»: без heartbeat сервер закрывает соединение через ~1,5 интервала
const z = await gatewayConnect(a.token, { heartbeat: false });
await wait(z.interval * 2 + 300);
ok(z.closed, 'без heartbeat соединение закрывается сервером');

// Присутствие: короткий обрыв с RESUME не даёт «не в сети», долгий — даёт
const watcher = await gatewayConnect(a.token);
const { code } = (await api(a.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(b.token, 'POST', `/invites/${code}`);
const gb = await gatewayConnect(b.token);
await wait(150);
const presence = () => watcher.events.filter((e) => e.type === 'presence' && e.user_id === b.user.id);
ok(presence().at(-1)?.online === true, 'вход → presence online');
const bs = gb.session, bseq = gb.seq;
gb.close();
await wait(100);
const r6 = await raw();
r6.send(6, { token: b.token, session_id: bs, seq: bseq });
await wait(700); // дольше паузы присутствия: если бы RESUME не сработал, ушло бы «не в сети»
ok(!presence().some((e) => e.online === false), 'короткий обрыв с RESUME: «не в сети» не рассылается');
r6.ws.close();
await wait(800);
ok(presence().at(-1)?.online === false, 'долгий обрыв: «не в сети» после паузы');

// typing — через REST
const gb2 = await gatewayConnect(b.token);
await api(a.token, 'POST', `/channels/${text.id}/typing`);
await wait(150);
ok(gb2.events.some((e) => e.type === 'typing_start' && e.user_id === a.user.id), 'POST /typing → TYPING_START остальным');
ok(!watcher.events.some((e) => e.type === 'typing_start' && e.user_id === a.user.id), 'себе TYPING_START не приходит');

await api(a.token, 'DELETE', `/guilds/${g.id}`);
watcher.close(); gb2.close();
console.log(fails ? `\n${fails} FAIL` : '\nGATEWAY: ВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(fails ? 1 : 0);

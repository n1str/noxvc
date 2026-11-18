// Активность «Играет в …» (сервер): RELAY_URL=… node tests/activity.mjs
// Кто видит (общий сервер — да, посторонний — нет), проверка входа, справочник, Steam (название и обложка в хранилище),
// частота, невидимка, выход из сети, null.
import { api, gatewayConnect, wait, B } from './lib.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) fails++; };
const sfx = Date.now() % 1e6;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const [ann, bob, cat] = await Promise.all(['act_a', 'act_b', 'act_c'].map(reg));
const g = (await api(ann.token, 'POST', '/guilds', { name: 'activity ' + sfx })).data;
const inv = (await api(ann.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(bob.token, 'POST', `/invites/${inv.code}`);
const [ga, gb, gc] = await Promise.all([ann, bob, cat].map((u) => gatewayConnect(u.token)));
const presenceOf = (gw, uid) => gw.events.filter((e) => e.type === 'presence' && e.user_id === uid);
const put = (tok, activity) => api(tok, 'PUT', '/me/game', { activity });
const clear = () => { for (const gw of [ga, gb, gc]) gw.events.length = 0; };
const t0 = Date.now();

// ---------- своя игра ----------
clear();
let r = await put(ann.token, { source: 'custom', name: '  Моя\u0000 игра \n', started_at: t0 - 60_000, details: 'x'.repeat(300) });
ok(r.status === 200 && r.data.activity?.name === 'Моя игра' && r.data.activity.game_id === 'custom' && r.data.activity.type === 'playing', `своя игра: «${r.data.activity?.name}»`);
ok(r.data.activity?.details?.length === 128, 'детали обрезаны до 128');
ok(r.data.activity?.started_at === t0 - 60_000, 'время начала — с клиента');
await wait(300);
const pb = presenceOf(gb, ann.user.id).pop();
ok(pb?.activity?.name === 'Моя игра', 'участник общего сервера получил активность (PRESENCE_UPDATE)');
ok(presenceOf(gc, ann.user.id).length === 0, 'посторонний — не получил ничего');
const members = (await api(bob.token, 'GET', `/guilds/${g.id}`)).data.members;
ok(members.find((m) => (m.user?.id ?? m.id) === ann.user.id)?.user?.activity?.name === 'Моя игра' || members.find((m) => m.id === ann.user.id)?.activity?.name === 'Моя игра', 'в списке участников — активность');
const prof = (await api(bob.token, 'GET', `/users/${ann.user.id}/profile?guild_id=${g.id}`)).data;
ok(prof.user?.activity?.name === 'Моя игра', 'в профиле — активность');

// ---------- проверка входа ----------
await wait(2100);
ok((await put(ann.token, { source: 'nope' })).status === 400, 'неизвестный source — 400');
await wait(2100);
ok((await put(ann.token, { source: 'custom', name: '   ' })).status === 400, 'своя игра без названия — 400');
await wait(2100);
ok((await put(ann.token, { source: 'steam', steam_appid: -5 })).status === 400, 'steam_appid вне диапазона — 400');
await wait(2100);
r = await put(ann.token, { source: 'custom', name: 'Будущее', started_at: Date.now() + 86_400_000 });
ok(r.status === 200 && r.data.activity.started_at <= Date.now(), 'время из будущего — не принимается');
ok((await put(ann.token, { source: 'custom', name: 'Спам' })).status === 429, 'чаще раза в 2 с — 429');

// ---------- справочник ----------
const list = (await api(ann.token, 'GET', '/games/detectable')).data.games;
const dota = list.find((x) => x.name === 'Dota 2');
ok(list.length >= 30 && dota?.exes.includes('dota2.exe') && dota.steam_appid === 570, `справочник: ${list.length} игр, Dota 2 → dota2.exe`);
ok((await api(null, 'GET', '/games/detectable')).status === 401, 'справочник — только с входом');
await wait(2100);
r = await put(ann.token, { source: 'detected', game_id: dota.id, name: 'подделка' });
ok(r.data.activity?.name === 'Dota 2' && r.data.activity.game_id === `game:${dota.id}`, 'игра из справочника — название с сервера, не от клиента');
await wait(2100);
ok((await put(ann.token, { source: 'detected', game_id: 999999 })).status === 400, 'неизвестная игра справочника — 400');

// ---------- Steam: название и обложка из магазина, обложка — в хранилище Relay ----------
await wait(2100);
clear();
r = await put(ann.token, { source: 'steam', steam_appid: 570, name: 'dota' });
ok(r.status === 200 && r.data.activity.game_id === 'steam:570', 'Steam: steam:570');
let icon = r.data.activity.icon_url;
for (let i = 0; i < 40 && !icon; i++) { await wait(500); icon = presenceOf(gb, ann.user.id).pop()?.activity?.icon_url; }
const last = presenceOf(gb, ann.user.id).pop()?.activity ?? r.data.activity;
ok(/^\/uploads\/games\/steam-570\.jpg$/.test(icon || '') && last.name === 'Dota 2', `Steam: название из магазина «${last.name}», обложка ${icon}`);
if (icon) {
  const img = await fetch(B + icon);
  const buf = Buffer.from(await img.arrayBuffer());
  ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8, `обложка отдаётся Relay (${buf.length} байт), клиенты в Steam не ходят`);
}

// ---------- невидимка ----------
await wait(2100);
clear();
await api(ann.token, 'PATCH', '/me', { presence: 'invisible' });
await wait(300);
ok(presenceOf(gb, ann.user.id).pop()?.activity == null, 'невидимка — активность пропала у других');
await wait(2100);
r = await put(ann.token, { source: 'custom', name: 'Тайная игра' });
ok(r.status === 200 && r.data.activity === null, 'невидимка — активность не принимается');
await wait(300);
ok(!presenceOf(gb, ann.user.id).some((e) => e.activity), 'невидимка — ничего не разослано');
await api(ann.token, 'PATCH', '/me', { presence: 'online' });

// ---------- null и выход из сети ----------
await wait(2100);
await put(ann.token, { source: 'custom', name: 'Ещё игра' });
await wait(2100);
clear();
r = await put(ann.token, null);
await wait(300);
ok(r.data.activity === null && presenceOf(gb, ann.user.id).pop()?.activity === null, 'null — активность снята у всех');
await wait(2100);
await put(ann.token, { source: 'custom', name: 'Перед выходом' });
clear();
ga.close();
await wait(2500);
ok(presenceOf(gb, ann.user.id).some((e) => e.presence === 'offline' && e.activity === null), 'вышел из сети — активность снята');
const ga2 = await gatewayConnect(ann.token);
ok(ga2.ready.user.activity === null, 'после переподключения — пусто, пока клиент не пришлёт снова');

for (const gw of [ga2, gb, gc]) gw.close();
console.log(fails ? `\nАКТИВНОСТЬ: ОШИБОК ${fails}` : '\nАКТИВНОСТЬ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

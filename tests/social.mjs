// Фаза 4: статусы присутствия, друзья и блокировки, приватность, групповые ЛС, профиль, учётная запись.
//   RELAY_URL=http://127.0.0.1:8099 node tests/social.mjs   (сервер с RELAY_PRESENCE_GRACE_MS=400)
import { B, api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const [ann, bob, cat, dan, eve] = await Promise.all(['ann', 'bob', 'cat', 'dan', 'eve'].map(reg));
const ev = (c, type, pred = () => true) => c.events.filter((e) => e.type === type && pred(e));

// ---------- друзья ----------
const gwB = await gatewayConnect(bob.token);
const gwA = await gatewayConnect(ann.token);
let r = await api(ann.token, 'POST', '/relationships', { username: bob.user.username });
ok(r.status === 200 && r.data.kind === 4, 'заявка в друзья по имени');
await wait(150);
ok(ev(gwB, 'relationship_add', (e) => e.relationship.id === ann.user.id && e.relationship.kind === 3).length === 1, 'у получателя — входящая заявка (gateway)');
ok((await api(ann.token, 'POST', '/relationships', { username: 'нет_такого_' + sfx })).status === 404, 'неизвестное имя — 404');
ok((await api(ann.token, 'POST', '/relationships', { user_id: ann.user.id })).status === 400, 'себя — нельзя');
r = await api(bob.token, 'POST', '/relationships', { user_id: ann.user.id });
ok(r.data.kind === 1, 'встречная заявка = принять');
let list = (await api(ann.token, 'GET', '/relationships')).data;
ok(list.some((x) => x.id === bob.user.id && x.kind === 1 && x.user.presence === 'online'), 'в списке друзей — с присутствием');
ok((await api(ann.token, 'GET', '/me')).data.relationships.some((x) => x.id === bob.user.id), 'отношения — в снимке /me (READY)');

// присутствие друзей без общих серверов
gwA.events.length = 0;
await api(bob.token, 'PATCH', '/me', { presence: 'dnd' });
await wait(150);
ok(ev(gwA, 'presence', (e) => e.user_id === bob.user.id && e.presence === 'dnd').length > 0, 'друг видит смену статуса (не беспокоить)');
await api(bob.token, 'PATCH', '/me', { presence: 'invisible' });
await wait(150);
ok(ev(gwA, 'presence', (e) => e.user_id === bob.user.id && e.presence === 'offline' && e.online === false).length > 0, 'невидимка для других — не в сети');
ok(ev(gwB, 'presence', (e) => e.user_id === bob.user.id && e.presence === 'invisible').length > 0, 'себе — «невидимка»');
ok((await api(ann.token, 'GET', '/relationships')).data.find((x) => x.id === bob.user.id).user.presence === 'offline', 'в списке друзей невидимка — offline');
await api(bob.token, 'PATCH', '/me', { presence: 'online' });
gwA.events.length = 0;
await api(bob.token, 'POST', '/me/activity', { afk: true });
await wait(150);
ok(ev(gwA, 'presence', (e) => e.user_id === bob.user.id && e.presence === 'idle').length > 0, 'бездействие → «отошёл»');
await api(bob.token, 'POST', '/me/activity', { afk: false });
ok((await api(bob.token, 'PATCH', '/me', { presence: 'busy' })).status === 400, 'неизвестный статус — 400');
gwA.events.length = 0;
gwB.close();
await wait(1200);
ok(ev(gwA, 'presence', (e) => e.user_id === bob.user.id && e.presence === 'offline').length > 0, 'отключился — не в сети');

// удаление из друзей
await api(ann.token, 'POST', '/relationships', { user_id: cat.user.id });
ok((await api(ann.token, 'DELETE', `/relationships/${cat.user.id}`)).status === 200, 'отменить заявку');
ok(!(await api(cat.token, 'GET', '/relationships')).data.some((x) => x.id === ann.user.id), 'у получателя заявка исчезла');

// ---------- блокировка ----------
await api(ann.token, 'POST', '/relationships', { user_id: dan.user.id });
await api(dan.token, 'POST', '/relationships', { user_id: ann.user.id });
const dm = (await api(ann.token, 'POST', '/dms', { user_id: dan.user.id })).data;
ok(dm.kind === 'dm' && dm.user.id === dan.user.id, 'ЛС с другом');
ok((await api(dan.token, 'PUT', `/relationships/${ann.user.id}/block`)).data.kind === 2, 'заблокировать');
ok(!(await api(ann.token, 'GET', '/relationships')).data.some((x) => x.id === dan.user.id), 'дружба снята у заблокированной');
ok((await api(ann.token, 'POST', `/channels/${dm.id}/messages`, { content: 'привет' })).status === 403, 'заблокированная не может писать в ЛС');
ok((await api(dan.token, 'POST', `/channels/${dm.id}/messages`, { content: 'и я' })).status === 403, 'и заблокировавший тоже');
const req = await api(ann.token, 'POST', '/relationships', { user_id: dan.user.id });
ok(req.status === 400 && !/заблок/i.test(req.data.error), 'заявка заблокировавшему — расплывчатый отказ');
ok((await api(ann.token, 'DELETE', `/relationships/${dan.user.id}`)).status === 404, 'чужую блокировку снять нельзя');
ok((await api(dan.token, 'DELETE', `/relationships/${ann.user.id}`)).status === 200, 'разблокировать');
ok((await api(ann.token, 'POST', `/channels/${dm.id}/messages`, { content: 'снова привет' })).status === 200, 'после разблокировки писать можно');

// ---------- приватность ----------
await api(eve.token, 'PATCH', '/me', { privacy: { friend_requests: 'none', dm_from: 'friends' } });
ok((await api(cat.token, 'POST', '/relationships', { user_id: eve.user.id })).status === 400, 'заявки выключены — отказ');
ok((await api(cat.token, 'POST', '/dms', { user_id: eve.user.id })).status === 403, 'ЛС только от друзей — отказ');
await api(eve.token, 'PATCH', '/me', { privacy: { friend_requests: 'mutual', dm_from: 'everyone' } });
ok((await api(cat.token, 'POST', '/relationships', { user_id: eve.user.id })).status === 400, '«только с общих серверов» — без общего сервера отказ');
const g = (await api(eve.token, 'POST', '/guilds', { name: 'Общий' })).data;
const { code } = (await api(eve.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(cat.token, 'POST', `/invites/${code}`);
ok((await api(cat.token, 'POST', '/relationships', { user_id: eve.user.id })).status === 200, 'с общим сервером — можно');
ok((await api(eve.token, 'PATCH', '/me', { privacy: { friend_requests: 'всем' } })).status === 400, 'неверная приватность — 400');

// ---------- групповые ЛС ----------
await api(bob.token, 'POST', '/relationships', { user_id: cat.user.id });
await api(cat.token, 'POST', '/relationships', { user_id: bob.user.id });
await api(ann.token, 'POST', '/relationships', { user_id: cat.user.id });
await api(cat.token, 'POST', '/relationships', { user_id: ann.user.id });
ok((await api(ann.token, 'POST', '/groups', { user_ids: [bob.user.id, eve.user.id] })).status === 400, 'в группу — только друзей');
const gwC = await gatewayConnect(cat.token);
const grp = await api(ann.token, 'POST', '/groups', { user_ids: [bob.user.id, cat.user.id], name: 'Поход' });
ok(grp.status === 200 && grp.data.kind === 'group_dm' && grp.data.recipients.length === 2 && grp.data.owner_id === ann.user.id, 'группа создана');
await wait(150);
ok(ev(gwC, 'dm_create', (e) => e.dm.id === grp.data.id && e.dm.name === 'Поход').length === 1, 'участник получил dm_create');
const m1 = await api(bob.token, 'POST', `/channels/${grp.data.id}/messages`, { content: 'когда идём?' });
ok(m1.status === 200, 'писать в группу');
ok((await api(cat.token, 'GET', `/channels/${grp.data.id}/messages`)).data.length === 1, 'все участники читают');
ok((await api(eve.token, 'GET', `/channels/${grp.data.id}/messages`)).status === 404, 'посторонний — 404');
ok((await api(cat.token, 'PATCH', `/groups/${grp.data.id}`, { name: 'Поход в горы' })).data.name === 'Поход в горы', 'переименовать может любой участник');
ok((await api(cat.token, 'DELETE', `/groups/${grp.data.id}/recipients/${bob.user.id}`)).status === 403, 'исключать — только владелец');
await api(ann.token, 'POST', '/relationships', { user_id: dan.user.id });
await api(dan.token, 'POST', '/relationships', { user_id: ann.user.id });
r = await api(ann.token, 'PUT', `/groups/${grp.data.id}/recipients/${dan.user.id}`);
ok(r.status === 200 && r.data.recipients.length === 3, 'добавить друга в группу');
ok((await api(dan.token, 'GET', '/me')).data.dms.some((d) => d.id === grp.data.id && d.kind === 'group_dm'), 'группа в ЛС нового участника');
ok((await api(ann.token, 'DELETE', `/groups/${grp.data.id}/recipients/${dan.user.id}`)).status === 200, 'владелец исключил');
ok((await api(dan.token, 'GET', `/channels/${grp.data.id}/messages`)).status === 404, 'исключённый больше не читает');
ok((await api(ann.token, 'DELETE', `/groups/${grp.data.id}/recipients/${ann.user.id}`)).status === 200, 'владелец вышел');
const after = (await api(bob.token, 'GET', '/me')).data.dms.find((d) => d.id === grp.data.id);
ok(after && after.owner_id === Math.min(bob.user.id, cat.user.id), 'владение перешло следующему');
const one = (await api(bob.token, 'POST', '/dms', { user_id: cat.user.id })).data;
ok(one.kind === 'dm' && one.id !== grp.data.id, '1:1 ЛС не путается с группой');

// ---------- профиль ----------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const fd = new FormData();
fd.append('file', new Blob([PNG]), 'me.png');
const up = await (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + cat.token }, body: fd })).json();
r = await api(cat.token, 'PATCH', '/me', { avatar: up.url, bio: 'Люблю горы', pronouns: 'она', banner_color: '#3355ff' });
// аватар обрабатывается на сервере (кадр, размеры) — результат приходит не сразу
let catMe = r.data;
for (let i = 0; i < 60 && catMe.avatar_pending; i++) { await wait(500); catMe = (await api(cat.token, 'GET', '/me')).data.user; }
ok(r.status === 200 && /^\/uploads\/m\/[a-z0-9]+\/a256\.webp$/.test(catMe.avatar || '') && r.data.bio === 'Люблю горы', 'профиль: аватар (обработан), о себе, местоимения, баннер');
ok((await api(cat.token, 'PATCH', '/me', { banner_color: 'red' })).status === 400, 'цвет баннера — только #rrggbb');
ok((await api(cat.token, 'PATCH', '/me', { bio: 'x'.repeat(191) })).status === 400, '«о себе» до 190');
ok((await api(cat.token, 'PATCH', '/me', { avatar: '/uploads/../x.png' })).status === 400, 'аватар — только наши загрузки');
const prof = (await api(eve.token, 'GET', `/users/${cat.user.id}/profile?guild_id=${g.id}`)).data;
ok(prof.bio === 'Люблю горы' && prof.pronouns === 'она' && prof.banner_color === '#3355ff' && prof.user.avatar === catMe.avatar, 'полный профиль');
ok(prof.mutual_guilds.length === 1 && prof.mutual_guilds[0].id === g.id, 'общие серверы');
ok(prof.member && Array.isArray(prof.member.roles), 'участник сервера (роли, дата входа)');
const pa = (await api(ann.token, 'GET', `/users/${cat.user.id}/profile`)).data;
ok(pa.mutual_friends.some((f) => f.id === bob.user.id) && pa.relationship === 1, 'общие друзья и отношение');
ok((await api(cat.token, 'PATCH', '/me', { avatar: null })).data.avatar === null, 'убрать аватар');

// ---------- учётная запись ----------
ok((await api(cat.token, 'PATCH', '/me', { username: 'новое_имя' + sfx, password: 'wrong' })).status === 400, 'смена логина: неверный пароль — отказ');
ok((await api(cat.token, 'PATCH', '/me', { username: bob.user.username, password: 'secret12' })).status === 400, 'занятый логин — отказ');
r = await api(cat.token, 'PATCH', '/me', { username: 'kat' + sfx, password: 'secret12' });
ok(r.status === 200 && r.data.username === 'kat' + sfx, 'логин сменён');
const other = await api(null, 'POST', '/login', { username: 'kat' + sfx, password: 'secret12' });
ok(other.status === 200, 'вход по новому логину');
ok((await api(cat.token, 'POST', '/me/password', { current: 'nope', new: 'newpass1' })).status === 400, 'смена пароля: неверный текущий');
r = await api(cat.token, 'POST', '/me/password', { current: 'secret12', new: 'newpass1' });
ok(r.status === 200 && r.data.signed_out >= 1, 'пароль сменён, другие сессии завершены');
ok((await api(other.data.token, 'GET', '/me')).status === 401, 'старая сессия больше не работает');
ok((await api(cat.token, 'GET', '/me')).status === 200, 'текущая — работает');
ok((await api(null, 'POST', '/login', { username: 'kat' + sfx, password: 'newpass1' })).status === 200, 'вход с новым паролем');

gwA.close();
gwC.close();
await api(eve.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nСОЦИАЛЬНОЕ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

import { gatewayConnect } from './lib.mjs';
// Интеграционные тесты прав: каждое действие — «можно» и «нельзя».
// Запуск: RELAY_URL=http://127.0.0.1:8099 node tests/perms.mjs
const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
async function api(tok, method, path, body) {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const wsConnect = (tok) => gatewayConnect(tok);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const P = {
  CREATE_INVITE: 1 << 0, KICK_MEMBERS: 1 << 1, ADMINISTRATOR: 1 << 3, MANAGE_CHANNELS: 1 << 4, MANAGE_GUILD: 1 << 5,
  VIEW_CHANNEL: 1 << 10, SEND_MESSAGES: 1 << 11, MANAGE_MESSAGES: 1 << 13, ATTACH_FILES: 1 << 15, MANAGE_NICKNAMES: 1 << 27, MANAGE_ROLES: 1 << 28,
};
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('own'), mod = await reg('mod'), user = await reg('usr'), other = await reg('oth');

const g = (await api(owner.token, 'POST', '/guilds', { name: 'Права' })).data;
const join = async (u) => {
  const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
  return api(u.token, 'POST', `/invites/${code}`);
};
await join(mod); await join(user);
let detail = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data;
const everyone = detail.roles.find((r) => r.is_default);
const text = detail.channels.find((c) => c.kind === 'text');
ok(everyone && everyone.position === 0, '@everyone создан у нового сервера');
ok(detail.permissions > 0 && (detail.permissions & P.ADMINISTRATOR), 'владелец: все права (включая ADMINISTRATOR)');
const userDetail = (await api(user.token, 'GET', `/guilds/${g.id}`)).data;
ok(!(userDetail.permissions & P.MANAGE_CHANNELS) && (userDetail.permissions & P.SEND_MESSAGES), 'участник: базовые права @everyone');

// --- роли ---
ok((await api(user.token, 'POST', `/guilds/${g.id}/roles`, { name: 'x' })).status === 403, 'роль без MANAGE_ROLES — 403');
ok((await api(other.token, 'POST', `/guilds/${g.id}/roles`, { name: 'x' })).status === 404, 'роль не участником — 404');
const modRole = (await api(owner.token, 'POST', `/guilds/${g.id}/roles`, {
  name: 'Модератор', color: 0x3a86ff, hoist: true, permissions: P.KICK_MEMBERS | P.MANAGE_MESSAGES | P.MANAGE_ROLES | P.MANAGE_NICKNAMES,
})).data;
ok(modRole.position === 1 && modRole.hoist, 'роль создана на позиции 1');
const helper = (await api(owner.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Помощник' })).data;
detail = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data;
ok(detail.roles.find((r) => r.id === modRole.id).position === 2 && helper.position === 1, 'новая роль ниже, старые сдвигаются вверх');
ok((await api(owner.token, 'PUT', `/guilds/${g.id}/members/${mod.user.id}/roles/${modRole.id}`)).status === 200, 'владелец выдаёт роль');
ok((await api(user.token, 'PUT', `/guilds/${g.id}/members/${user.user.id}/roles/${modRole.id}`)).status === 403, 'участник не выдаёт себе роль');
ok((await api(mod.token, 'PUT', `/guilds/${g.id}/members/${user.user.id}/roles/${modRole.id}`)).status === 403, 'модератор не выдаёт роль, равную своей');
ok((await api(mod.token, 'PUT', `/guilds/${g.id}/members/${user.user.id}/roles/${helper.id}`)).status === 200, 'модератор выдаёт роль ниже своей');
ok((await api(mod.token, 'PATCH', `/roles/${modRole.id}`, { name: 'Админ' })).status === 403, 'модератор не меняет свою роль');
ok((await api(mod.token, 'PATCH', `/roles/${helper.id}`, { permissions: P.ADMINISTRATOR })).status === 403, 'нельзя выдать право, которого нет у себя');
ok((await api(mod.token, 'PATCH', `/roles/${helper.id}`, { permissions: P.MANAGE_MESSAGES })).status === 200, 'можно выдать своё право роли ниже');
ok((await api(mod.token, 'PATCH', `/roles/${helper.id}`, { permissions: 0 })).status === 200, 'и забрать его обратно');
ok((await api(mod.token, 'PATCH', `/guilds/${g.id}/roles/order`, { ids: [modRole.id, helper.id] })).status === 403, 'модератор не поднимает роль до своей');
ok((await api(owner.token, 'PATCH', `/guilds/${g.id}/roles/order`, { ids: [helper.id] })).status === 400, 'порядок ролей — только полный список');
ok((await api(owner.token, 'DELETE', `/roles/${everyone.id}`)).status === 400, '@everyone удалить нельзя');

// --- модерация и иерархия ---
const m1 = (await api(user.token, 'POST', `/channels/${text.id}/messages`, { content: 'от участника' })).data;
ok((await api(mod.token, 'DELETE', `/messages/${m1.id}`)).status === 200, 'MANAGE_MESSAGES: модератор удаляет чужое');
const m2 = (await api(mod.token, 'POST', `/channels/${text.id}/messages`, { content: 'от модератора' })).data;
ok((await api(user.token, 'DELETE', `/messages/${m2.id}`)).status === 403, 'без MANAGE_MESSAGES чужое не удалить');
ok((await api(user.token, 'PATCH', `/guilds/${g.id}/members/${user.user.id}`, { nick: 'Ник' })).data?.nick === 'Ник', 'CHANGE_NICKNAME: свой ник');
ok((await api(user.token, 'PATCH', `/guilds/${g.id}/members/${mod.user.id}`, { nick: 'x' })).status === 403, 'чужой ник без прав — 403');
ok((await api(mod.token, 'PATCH', `/guilds/${g.id}/members/${user.user.id}`, { nick: 'Модератор назвал' })).status === 200, 'MANAGE_NICKNAMES: ник участника ниже');
ok((await api(mod.token, 'PATCH', `/guilds/${g.id}/members/${owner.user.id}`, { nick: 'x' })).status === 403, 'ник владельца менять нельзя');
ok((await api(user.token, 'DELETE', `/guilds/${g.id}/members/${mod.user.id}`)).status === 403, 'без KICK_MEMBERS кикнуть нельзя');
ok((await api(mod.token, 'DELETE', `/guilds/${g.id}/members/${owner.user.id}`)).status === 400, 'владельца кикнуть нельзя');
ok((await api(mod.token, 'PATCH', `/guilds/${g.id}`, { name: 'x' })).status === 403, 'без MANAGE_GUILD переименовать сервер нельзя');
ok((await api(mod.token, 'DELETE', `/guilds/${g.id}`)).status === 403, 'удалить сервер может только владелец');

// --- приватный канал и запрет писать ---
const wsU = await wsConnect(user.token);
const secret = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'секрет' })).data;
ok((await api(mod.token, 'PUT', `/channels/${secret.id}/permissions/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL })).status === 200, 'модератор с MANAGE_ROLES закрывает канал');
ok((await api(owner.token, 'PUT', `/channels/${secret.id}/permissions/role/${modRole.id}`, { allow: P.VIEW_CHANNEL, deny: 0 })).status === 200, 'владелец открывает канал роли');
await wait(100);
ok(wsU.events.some((e) => e.type === 'guild_refresh'), 'смена прав → guild_refresh участникам');
ok(!(await api(user.token, 'GET', `/guilds/${g.id}`)).data.channels.some((c) => c.id === secret.id), 'закрытый канал не виден в списке');
ok((await api(user.token, 'GET', `/channels/${secret.id}/messages`)).status === 404, 'закрытый канал: история — 404');
ok((await api(user.token, 'POST', `/channels/${secret.id}/messages`, { content: 'x' })).status === 404, 'закрытый канал: писать — 404');
await api(mod.token, 'POST', `/channels/${secret.id}/messages`, { content: 'тайна' });
await wait(100);
ok(!wsU.events.some((e) => e.type === 'message_create' && e.message.channel_id === secret.id), 'сообщения закрытого канала не приходят по WS');
ok((await api(mod.token, 'GET', `/channels/${secret.id}/messages`)).data.length === 1, 'роль с доступом видит историю');
ok((await api(user.token, 'PUT', `/channels/${text.id}/permissions/role/${everyone.id}`, { allow: 0, deny: P.SEND_MESSAGES })).status === 403, 'без MANAGE_ROLES права канала не менять');
ok((await api(owner.token, 'PUT', `/channels/${text.id}/permissions/member/${user.user.id}`, { allow: 0, deny: P.SEND_MESSAGES })).status === 200, 'личный запрет писать');
ok((await api(user.token, 'POST', `/channels/${text.id}/messages`, { content: 'x' })).status === 403, 'без SEND_MESSAGES — 403');
ok((await api(user.token, 'GET', `/channels/${text.id}/messages`)).status === 200, 'читать по-прежнему можно');
// Регрессия X13#1: менеджер ролей без SEND_MESSAGES в канале не снимает свой запрет ни PUT, ни DELETE.
const keeper = (await api(owner.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Хранитель', permissions: P.MANAGE_ROLES })).data;
await api(owner.token, 'PUT', `/guilds/${g.id}/members/${user.user.id}/roles/${keeper.id}`);
ok((await api(user.token, 'PUT', `/channels/${text.id}/permissions/member/${user.user.id}`, { allow: 0, deny: 0 })).status === 403, 'PUT: нельзя снять запрет права, которого нет у себя');
ok((await api(user.token, 'DELETE', `/channels/${text.id}/permissions/member/${user.user.id}`)).status === 403, 'DELETE: то же самое (нет обхода через удаление)');
ok((await api(user.token, 'POST', `/channels/${text.id}/messages`, { content: 'x' })).status === 403, 'запрет остался');
await api(owner.token, 'DELETE', `/guilds/${g.id}/members/${user.user.id}/roles/${keeper.id}`);
ok((await api(owner.token, 'PUT', `/channels/${text.id}/permissions/member/${user.user.id}`, { allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES })).status === 400, 'allow и deny одного права — 400');
await api(owner.token, 'DELETE', `/channels/${text.id}/permissions/member/${user.user.id}`);
ok((await api(user.token, 'POST', `/channels/${text.id}/messages`, { content: 'снова можно' })).status === 200, 'снятие overwrite возвращает право');

// --- посмотреть как роль ---
ok((await api(user.token, 'GET', `/guilds/${g.id}/view-as?roles=${modRole.id}`)).status === 403, 'view-as без MANAGE_ROLES — 403');
const asEveryone = (await api(owner.token, 'GET', `/guilds/${g.id}/view-as?roles=`)).data;
ok(asEveryone.channels.find((c) => c.id === secret.id).permissions === 0, 'view-as @everyone: закрытый канал невидим');
const asMod = (await api(owner.token, 'GET', `/guilds/${g.id}/view-as?roles=${modRole.id}`)).data;
ok((asMod.channels.find((c) => c.id === secret.id).permissions & P.VIEW_CHANNEL) !== 0 && (asMod.permissions & P.KICK_MEMBERS) !== 0, 'view-as Модератор: видит закрытый канал и может кикать');

// --- категории ---
ok((await api(user.token, 'POST', `/guilds/${g.id}/channels`, { name: 'x', kind: 'category' })).status === 403, 'без MANAGE_CHANNELS категорию не создать');
const cat = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Приватное', kind: 'category' })).data;
await api(owner.token, 'PUT', `/channels/${cat.id}/permissions/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
const inCat = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'внутри', parent_id: cat.id })).data;
ok(inCat.parent_id === cat.id, 'канал создан в категории');
ok((await api(user.token, 'GET', `/channels/${inCat.id}/messages`)).status === 404, 'канал в категории наследует её запрет');
ok((await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'y', parent_id: text.id })).status === 400, 'родителем может быть только категория');

// --- инвайты ---
ok((await api(owner.token, 'POST', `/guilds/${g.id}/invites`, { max_age: 123 })).status === 400, 'произвольный срок инвайта — 400');
const once = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`, { max_uses: 1, max_age: 3600 })).data;
ok(once.expires_at > Date.now(), 'инвайт со сроком');
ok((await api(other.token, 'POST', `/invites/${once.code}`)).status === 200, 'одноразовый инвайт: первый вход');
const late = await reg('late');
ok((await api(late.token, 'POST', `/invites/${once.code}`)).status === 404, 'одноразовый инвайт: второй — 404');
ok((await api(user.token, 'GET', `/guilds/${g.id}/invites`)).status === 403, 'список инвайтов без MANAGE_GUILD — 403');
ok(Array.isArray((await api(owner.token, 'GET', `/guilds/${g.id}/invites`)).data), 'список инвайтов владельцу');
const mine = (await api(user.token, 'POST', `/guilds/${g.id}/invites`)).data;
ok((await api(mod.token, 'DELETE', `/invites/${mine.code}`)).status === 403, 'чужой инвайт без MANAGE_GUILD не отозвать');
ok((await api(user.token, 'DELETE', `/invites/${mine.code}`)).status === 200, 'свой инвайт отозвать можно');

// --- кик по иерархии ---
ok((await api(mod.token, 'DELETE', `/guilds/${g.id}/members/${user.user.id}`)).status === 200, 'модератор кикает участника ниже');
ok((await api(user.token, 'GET', `/guilds/${g.id}`)).status === 404, 'кикнутый теряет доступ');

await api(owner.token, 'DELETE', `/guilds/${g.id}`);
wsU.close();
console.log(fails ? `\n${fails} FAIL` : '\nВСЕ ТЕСТЫ ПРАВ ПРОШЛИ');
process.exit(fails ? 1 : 0);

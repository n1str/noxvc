// Фаза 3b: состояния прочтения, счётчик упоминаний, ack между вкладками, «Входящие», настройки уведомлений.
//   RELAY_URL=http://127.0.0.1:8099 node tests/unread.mjs
import { api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('ro'), user = await reg('ru'), late = await reg('rl');
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Непрочитанное' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const text = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.channels.find((c) => c.kind === 'text');
const post = (tok, body, ch = text.id) => api(tok, 'POST', `/channels/${ch}/messages`, body);
const rs = async (tok, ch = text.id) => (await api(tok, 'GET', '/me')).data.read_states.find((r) => r.channel_id === ch);

// обычное сообщение: непрочитано, но без упоминания; у автора — прочитано
const m1 = (await post(owner.token, { content: 'привет всем' })).data;
let s = await rs(user.token);
ok(s && s.last_message_id === m1.id && s.last_read_id < m1.id && s.mention_count === 0, 'обычное сообщение: непрочитано, упоминаний 0');
s = await rs(owner.token);
ok(s.last_read_id === m1.id, 'своё сообщение сразу прочитано');

// упоминание лично, ролью, @everyone, ответ — растят счётчик
const role = (await api(owner.token, 'POST', `/guilds/${g.id}/roles`, { name: 'дежурные', mentionable: true })).data;
await api(owner.token, 'PUT', `/guilds/${g.id}/members/${user.user.id}/roles/${role.id}`);
const mine = (await post(user.token, { content: 'моё сообщение' })).data;
await post(owner.token, { content: `эй <@${user.user.id}>` });
await post(owner.token, { content: `роль <@&${role.id}>` });
await post(owner.token, { content: '@everyone сбор' });
const last = (await post(owner.token, { content: 'ответ', reply_to: mine.id })).data;
s = await rs(user.token);
ok(s.mention_count === 4, `упоминания: лично+роль+everyone+ответ = 4 (получено ${s.mention_count})`);

// ack: сброс счётчика, событие во вторую вкладку
const tab = await gatewayConnect(user.token);
const a = await api(user.token, 'POST', `/channels/${text.id}/ack`, { message_id: last.id });
await wait(150);
s = await rs(user.token);
ok(a.status === 200 && s.last_read_id === last.id && s.mention_count === 0, 'ack: прочитано, счётчик сброшен');
ok(tab.events.some((e) => e.type === 'message_ack' && e.channel_id === text.id && e.last_read_id === last.id), 'MESSAGE_ACK во второй вкладке');
await api(user.token, 'POST', `/channels/${text.id}/ack`, { message_id: m1.id });
ok((await rs(user.token)).last_read_id === last.id, 'ack не откатывает назад');
ok(tab.ready.read_states?.some((r) => r.channel_id === text.id), 'read_states есть в READY');

// «Входящие»
const inbox = (await api(user.token, 'GET', '/inbox')).data;
ok(Array.isArray(inbox) && inbox.length === 4 && inbox[0].message.id === last.id && inbox[0].channel_name === text.name, '«Входящие»: 4 записи, новые сверху, с именем канала');
const page2 = (await api(user.token, 'GET', `/inbox?before=${inbox[1].message.id}&limit=1`)).data;
ok(page2.length === 1 && page2[0].message.id === inbox[2].message.id, '«Входящие»: пагинация before');
ok((await api(owner.token, 'GET', '/inbox')).data.length === 0, 'у автора свои сообщения во «Входящих» не появляются');

// скрытый канал: упоминания не считаются и не попадают во «Входящие»
const secret = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'секрет' })).data;
const everyoneRole = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.roles.find((r) => r.name === '@everyone');
await api(owner.token, 'PUT', `/channels/${secret.id}/permissions/role/${everyoneRole.id}`, { allow: 0, deny: 1024 });
await post(owner.token, { content: `тайно <@${user.user.id}>` }, secret.id);
ok(!(await rs(user.token, secret.id)), 'скрытого канала нет в read_states');
ok(!(await api(user.token, 'GET', '/inbox')).data.some((x) => x.message.channel_id === secret.id), 'скрытый канал не попадает во «Входящие»');
ok((await api(user.token, 'POST', `/channels/${secret.id}/ack`, { message_id: 1 })).status === 404, 'ack в недоступный канал — 404');

// suppress @everyone
const ns = await api(user.token, 'PUT', '/notification-settings', { guild_id: g.id, level: 1, suppress_everyone: true });
ok(ns.status === 200 && ns.data.some((x) => x.guild_id === g.id && x.level === 1 && x.suppress_everyone), 'настройки сервера сохранены');
const before = (await rs(user.token)).mention_count;
await post(owner.token, { content: '@everyone опять' });
ok((await rs(user.token)).mention_count === before, 'suppress_everyone: @everyone не растит счётчик');
await api(user.token, 'PUT', '/notification-settings', { guild_id: g.id, level: 2, suppress_everyone: true });
const one = (await api(user.token, 'GET', '/me')).data.notification_settings.filter((x) => x.guild_id === g.id);
ok(one.length === 1 && one[0].level === 2, 'повторное сохранение — обновление, а не дубль');
const until = Date.now() + 3600e3;
const nc = await api(user.token, 'PUT', '/notification-settings', { channel_id: text.id, level: 0, muted_until: until });
ok(nc.status === 200 && nc.data.some((x) => x.channel_id === text.id && x.muted_until === until), 'настройки канала: mute до времени');
ok(tab.events.some((e) => e.type === 'notification_settings'), 'настройки синхронизируются по gateway');
ok((await api(user.token, 'PUT', '/notification-settings', { level: 5, guild_id: g.id })).status === 400, 'неверный уровень — 400');
ok((await api(user.token, 'PUT', '/notification-settings', { level: 0 })).status === 400, 'без guild_id/channel_id — 400');
ok((await api(late.token, 'PUT', '/notification-settings', { guild_id: g.id, level: 0 })).status !== 200, 'чужой сервер — отказ');

// сброс настройки канала (-1) и «прочитать весь сервер»
await api(user.token, 'PUT', '/notification-settings', { channel_id: text.id, level: -1 });
ok(!(await api(user.token, 'GET', '/me')).data.notification_settings.some((x) => x.channel_id === text.id), 'level -1 удаляет настройку канала');
await post(owner.token, { content: `ещё <@${user.user.id}>` });
const other = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'второй' })).data;
await post(owner.token, { content: 'и тут' }, other.id);
const ag = await api(user.token, 'POST', `/guilds/${g.id}/ack`);
const all = (await api(user.token, 'GET', '/me')).data.read_states.filter((r) => r.guild_id === g.id);
ok(ag.status === 200 && all.length >= 2 && all.every((r) => r.last_read_id === r.last_message_id && r.mention_count === 0), 'ack сервера: все каналы прочитаны');

// новичок: старая история уже прочитана
await api(late.token, 'POST', `/invites/${code}`);
s = await rs(late.token);
ok(s && s.last_read_id === s.last_message_id && s.last_message_id > 0, 'вошедший по инвайту не видит старое как непрочитанное');

// ЛС: любое сообщение — упоминание
const dm = (await api(owner.token, 'POST', '/dms', { user_id: user.user.id })).data;
if (dm?.id) {
  await post(owner.token, { content: 'лично' }, dm.id);
  ok((await rs(user.token, dm.id))?.mention_count === 1, 'ЛС: каждое сообщение считается упоминанием');
} else ok(false, 'не удалось создать ЛС: ' + JSON.stringify(dm));

tab.close();
await api(owner.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nНЕПРОЧИТАННОЕ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

// Фаза 3a: nonce, несколько вложений, упоминания (решает сервер), around, массовое удаление.
//   RELAY_URL=http://127.0.0.1:8099 node tests/messages.mjs
import { B, api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('mo'), user = await reg('mu'), outsider = await reg('mx');
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Сообщения' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const text = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.channels.find((c) => c.kind === 'text');
const post = (tok, body) => api(tok, 'POST', `/channels/${text.id}/messages`, body);

// nonce
const gw = await gatewayConnect(user.token);
const r1 = await post(owner.token, { content: 'с nonce', nonce: 'n-123' });
await wait(150);
ok(r1.data.nonce === 'n-123', 'nonce возвращается в ответе');
ok(gw.events.some((e) => e.type === 'message_create' && e.message.nonce === 'n-123'), 'nonce приходит в событии');
ok((await post(owner.token, { content: 'x', nonce: 'x'.repeat(65) })).data.nonce === undefined, 'слишком длинный nonce отбрасывается');

// вложения
async function upload(name, body) {
  const fd = new FormData();
  fd.append('file', new Blob([body]), name);
  return (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token }, body: fd })).json();
}
const f1 = await upload('a.png', 'PNGDATA'), f2 = await upload('b.txt', 'hello world');
ok(f1.size === 7 && f1.content_type === 'image/png', 'upload возвращает размер и тип');
const r2 = await post(owner.token, { content: '', attachments: [f1, f2] });
ok(r2.data.attachments?.length === 2 && r2.data.attachments[1].size === 11 && r2.data.attachments[1].content_type === 'text/plain', 'сообщение с двумя вложениями');
ok(r2.data.attachment?.url === f1.url, 'совместимость: attachment = первое вложение');
ok((await post(owner.token, { content: '', attachments: Array(11).fill(f1) })).status === 400, 'больше 10 вложений — 400');
ok((await post(owner.token, { content: '', attachments: [{ url: '/uploads/nope.png', name: 'x' }] })).status === 400, 'несуществующий файл — 400');
ok((await post(owner.token, { content: '', attachments: [{ url: '/etc/passwd', name: 'x' }] })).status === 400, 'чужой путь — 400');

// упоминания
const m1 = (await post(user.token, { content: `привет <@${owner.user.id}> и <@${outsider.user.id}>` })).data;
ok(JSON.stringify(m1.mentions) === JSON.stringify([owner.user.id]), 'упомянут участник; посторонний отброшен');
ok((await post(user.token, { content: '@everyone срочно' })).data.mention_everyone === false, '@everyone без права — просто текст');
ok((await post(owner.token, { content: '@here срочно' })).data.mention_everyone === true, '@here с правом — упоминание всех');
const quiet = (await api(owner.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Тихая' })).data;
const loud = (await api(owner.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Громкая', mentionable: true })).data;
const m2 = (await post(user.token, { content: `<@&${quiet.id}> <@&${loud.id}>` })).data;
ok(JSON.stringify(m2.mention_roles) === JSON.stringify([loud.id]), 'роль: только упоминаемая (без MENTION_EVERYONE)');
ok((await post(owner.token, { content: `<@&${quiet.id}>` })).data.mention_roles.includes(quiet.id), 'с MENTION_EVERYONE — любая роль');
ok((await post(owner.token, { content: `\`<@${user.user.id}>\`` })).data.mentions.length === 0, 'упоминание в коде не считается');
const e1 = (await api(user.token, 'PATCH', `/messages/${m1.id}`, { content: 'без упоминаний' })).data;
ok(e1.mentions.length === 0, 'редактирование пересчитывает упоминания');

// around
const ids = [];
for (let i = 0; i < 30; i++) ids.push((await post(owner.token, { content: `история ${i}` })).data.id);
const mid = ids[15];
const win = (await api(owner.token, 'GET', `/channels/${text.id}/messages?around=${mid}&limit=20`)).data;
ok(win.some((m) => m.id === mid) && win.length === 20 && win[0].id < mid && win.at(-1).id > mid, 'around: окно вокруг сообщения, по возрастанию');

const aft = (await api(owner.token, 'GET', `/channels/${text.id}/messages?after=${mid}&limit=5`)).data;
ok(aft.length === 5 && aft[0].id > mid && aft.every((m, i) => i === 0 || m.id > aft[i - 1].id), 'after: следующие сообщения по возрастанию');

// массовое удаление
ok((await api(user.token, 'POST', `/channels/${text.id}/messages/bulk-delete`, { ids: ids.slice(0, 3) })).status === 403, 'массовое удаление без MANAGE_MESSAGES — 403');
const mark = gw.events.length;
const del = await api(owner.token, 'POST', `/channels/${text.id}/messages/bulk-delete`, { ids: [...ids.slice(0, 3), 999999999] });
await wait(150);
ok(del.data.deleted === 3, 'удалено 3 (чужие id игнорируются)');
ok(gw.events.slice(mark).some((e) => e.type === 'message_delete_bulk' && e.ids.length === 3), 'событие MESSAGE_DELETE_BULK');
ok((await api(owner.token, 'POST', `/channels/${text.id}/messages/bulk-delete`, { ids: Array(101).fill(1) })).status === 400, 'больше 100 — 400');

gw.close();
await api(owner.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nСООБЩЕНИЯ: ВСЕ ТЕСТЫ ПРОШЛИ');
process.exit(fails ? 1 : 0);

// Фаза 3f: эмодзи сервера — загрузка, права, лимиты, картинка по id, реакции (канонический токен, чужой сервер), переименование.
//   RELAY_URL=http://127.0.0.1:8099 node tests/emojis.mjs
import { B, api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('jo'), user = await reg('ju');
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Эмодзи' })).data;
const g2 = (await api(owner.token, 'POST', '/guilds', { name: 'Другой' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const text = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.channels.find((c) => c.kind === 'text');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function upload(tok, name, buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  return (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd })).json();
}
const gw = await gatewayConnect(user.token);
const f = await upload(owner.token, 'cat.png', PNG);

// создание и права
ok((await api(user.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'party_cat', url: f.url })).status === 403, 'без MANAGE_EMOJIS — 403');
const e1 = await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'party_cat', url: f.url });
ok(e1.status === 200 && e1.data.name === 'party_cat' && e1.data.animated === false, 'эмодзи добавлено');
ok((await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'PARTY_cat', url: f.url })).status === 400, 'имя уникально без учёта регистра');
ok((await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'плохое имя', url: f.url })).status === 400, 'имя: только латиница/цифры/_');
const txt = await upload(owner.token, 'a.txt', Buffer.from('hello'));
ok((await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'text_file', url: txt.url })).status === 400, 'не картинка — 400');
const big = await upload(owner.token, 'big.png', Buffer.alloc(600 * 1024));
ok((await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'too_big', url: big.url })).status === 400, 'больше 512 КБ — 400');
ok((await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'evil', url: '/uploads/../../etc/passwd' })).status === 400, 'чужой путь — 400');
const gif = await upload(owner.token, 'dance.gif', Buffer.from('GIF89a'));
const e2 = await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'dance', url: gif.url });
ok(e2.data.animated === true, 'GIF — анимированное');
await wait(150);
ok(gw.events.some((e) => e.type === 'guild_emojis_update' && e.guild_id === g.id && e.emojis.length === 2), 'guild_emojis_update по gateway');
ok((await api(user.token, 'GET', `/guilds/${g.id}`)).data.emojis.length === 2, 'эмодзи — в данных сервера');

// картинка по id без входа
const img = await fetch(`${B}/api/emojis/${e1.data.id}/image`, { redirect: 'manual' });
ok(img.status === 307 && img.headers.get('location') === f.url, 'картинка по id → файл (без входа)');
ok((await fetch(`${B}/api/emojis/999999999/image`, { redirect: 'manual' })).status === 404, 'нет эмодзи — 404');

// реакции
const msg = (await api(owner.token, 'POST', `/channels/${text.id}/messages`, { content: `привет <:party_cat:${e1.data.id}>` })).data;
ok(msg.content.includes(`<:party_cat:${e1.data.id}>`), 'токен эмодзи хранится в тексте');
let r = await api(user.token, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent(`<:WRONGNAME:${e1.data.id}>`)}`);
ok(r.status === 200 && r.data.reactions?.[0]?.emoji === `<:party_cat:${e1.data.id}>` || (await api(owner.token, 'GET', `/channels/${text.id}/messages?limit=1`)).data[0].reactions[0]?.emoji === `<:party_cat:${e1.data.id}>`, 'реакция приводится к каноническому токену');
ok((await api(user.token, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('<:nope:999999999>')}`)).status === 400, 'несуществующее эмодзи — 400');
const f2 = await upload(owner.token, 'x.png', PNG);
const foreign = (await api(owner.token, 'POST', `/guilds/${g2.id}/emojis`, { name: 'foreign', url: f2.url })).data;
ok((await api(user.token, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent(`<:foreign:${foreign.id}>`)}`)).status === 400, 'эмодзи сервера, где я не состою, — нельзя');
ok((await api(owner.token, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent(`<:foreign:${foreign.id}>`)}`)).status === 200, 'своё эмодзи с другого сервера (USE_EXTERNAL_EMOJI) — можно');

// переименование переписывает реакции; удаление
ok((await api(user.token, 'PATCH', `/emojis/${e1.data.id}`, { name: 'x_x' })).status === 403, 'переименовать без права — 403');
await api(owner.token, 'PATCH', `/emojis/${e1.data.id}`, { name: 'happy_cat' });
const after = (await api(owner.token, 'GET', `/channels/${text.id}/messages?limit=1`)).data[0];
ok(after.reactions.some((x) => x.emoji === `<:happy_cat:${e1.data.id}>`), 'переименование обновило реакции');
ok((await api(owner.token, 'PATCH', `/emojis/${e1.data.id}`, { name: 'dance' })).status === 400, 'переименовать в занятое имя — 400');
ok((await api(owner.token, 'DELETE', `/emojis/${e2.data.id}`)).status === 200, 'удалить эмодзи');
ok((await fetch(`${B}/api/emojis/${e2.data.id}/image`, { redirect: 'manual' })).status === 404, 'удалённое — 404');

// лимит 50
for (let i = 0; i < 49; i++) await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: `e${i}`, url: f.url });
ok((await api(owner.token, 'POST', `/guilds/${g.id}/emojis`, { name: 'one_more', url: f.url })).status === 400, 'не больше 50 эмодзи');

gw.close();
await api(owner.token, 'DELETE', `/guilds/${g.id}`);
await api(owner.token, 'DELETE', `/guilds/${g2.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nЭМОДЗИ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

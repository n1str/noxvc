// Фаза 3c: полнотекстовый поиск (русский стемминг, префиксы), фильтры, видимость, сортировка, страницы.
//   RELAY_URL=http://127.0.0.1:8099 node tests/search.mjs
import { B, api } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('so'), user = await reg('su'), outsider = await reg('sx');
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Поиск' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const text = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.channels.find((c) => c.kind === 'text');
const news = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'новости' })).data;
const secret = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'секрет' })).data;
const everyone = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.roles.find((r) => r.is_default);
await api(owner.token, 'PUT', `/channels/${secret.id}/permissions/role/${everyone.id}`, { allow: 0, deny: 1024 });
const post = (tok, ch, body) => api(tok, 'POST', `/channels/${ch}/messages`, typeof body === 'string' ? { content: body } : body);
const S = (tok, q, extra = '') => api(tok, 'GET', `/search?guild_id=${g.id}&q=${encodeURIComponent(q)}${extra}`);

const m1 = (await post(owner.token, text.id, 'Встречаемся завтра у фонтана')).data;
const m2 = (await post(user.token, text.id, 'Фонтаны в парке красивые https://example.com/park')).data;
const m3 = (await post(owner.token, news.id, `Новости для <@${user.user.id}>: релиз версии 2`)).data;
await post(owner.token, secret.id, 'секретный фонтан');
const fd = new FormData();
fd.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'pic.png');
const up = await (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token }, body: fd })).json();
const m4 = (await post(owner.token, news.id, { content: 'картинка дня', attachments: [up] })).data;
await api(owner.token, 'PUT', `/messages/${m3.id}/pin`);

const ids = (r) => r.data.results.map((x) => x.message.id);
let r = await S(user.token, 'фонтан');
ok(r.status === 200 && ids(r).includes(m1.id) && ids(r).includes(m2.id), 'стемминг: «фонтан» находит «фонтана» и «Фонтаны»');
ok(!r.data.results.some((x) => x.message.content.includes('секретный')), 'скрытый канал не ищется');
ok(r.data.total === 2 && r.data.results[0].message.id === m2.id, 'total и сортировка «новые сверху»');
ok(r.data.results[0].channel_name === text.name, 'в результате — имя канала');
r = await S(owner.token, 'фонтан');
ok(r.data.total === 3, 'владелец видит и скрытый канал');
r = await S(user.token, 'встреч');
ok(ids(r).includes(m1.id), 'префиксный поиск: «встреч» → «Встречаемся»');
r = await S(user.token, 'фонтан', '&sort=old');
ok(ids(r)[0] === m1.id, 'сортировка «старые сверху»');
ok((await S(user.token, 'фонтан', '&sort=relevance')).status === 200, 'сортировка по релевантности');

r = await S(user.token, `from:${user.user.username}`);
ok(ids(r).length === 1 && ids(r)[0] === m2.id, 'from: по логину');
r = await S(user.token, `фонтан from:${owner.user.username}`);
ok(ids(r).length === 1 && ids(r)[0] === m1.id, 'слово + from:');
ok((await S(user.token, 'from:никтоникто')).data.total === 0, 'from: неизвестный — пусто');
r = await S(user.token, `mentions:${user.user.username}`);
ok(ids(r).length === 1 && ids(r)[0] === m3.id, 'mentions:');
r = await S(user.token, 'in:новости релиз');
ok(ids(r).length === 1 && ids(r)[0] === m3.id, 'in:канал');
ok((await S(user.token, 'in:секрет фонтан')).data.total === 0, 'in: скрытый канал — пусто');
ok(ids(await S(user.token, 'has:link'))[0] === m2.id, 'has:link');
r = await S(user.token, 'has:image');
ok(ids(r).length === 1 && ids(r)[0] === m4.id, 'has:image');
ok(ids(await S(user.token, 'has:file')).includes(m4.id), 'has:file');
r = await S(user.token, 'pinned:true');
ok(ids(r).length === 1 && ids(r)[0] === m3.id, 'pinned:true');
const today = new Date(), iso = (d) => d.toISOString().slice(0, 10);
const tz = -today.getTimezoneOffset();
const tomorrow = new Date(Date.now() + 86400e3), yesterday = new Date(Date.now() - 86400e3);
ok((await S(user.token, `фонтан before:${iso(tomorrow)}`, `&tz=${tz}`)).data.total === 2, 'before: завтра — всё');
ok((await S(user.token, `фонтан after:${iso(today)}`, `&tz=${tz}`)).data.total === 0, 'after: сегодня — пусто (после этого дня)');
ok((await S(user.token, `фонтан after:${iso(yesterday)}`, `&tz=${tz}`)).data.total === 2, 'after: вчера — всё');
ok((await S(user.token, `фонтан during:${iso(today)}`, `&tz=${tz}`)).data.total === 2, 'during: сегодня');

ok((await S(user.token, 'has:банан')).status === 400, 'неизвестный has — 400');
ok((await S(user.token, '   ')).status === 400, 'пустой запрос — 400');
ok((await S(user.token, `'); DROP TABLE messages; --`)).status === 200, 'спецсимволы не ломают запрос');
ok((await S(outsider.token, 'фонтан')).data.total === 0, 'чужой сервер — пусто');
ok((await api(null, 'GET', `/search?q=x&guild_id=${g.id}`)).status === 401, 'без входа — 401');

// страницы
for (let i = 0; i < 30; i++) await post(owner.token, text.id, `страница номер ${i}`);
const p1 = await S(user.token, 'страница'), p2 = await S(user.token, 'страница', '&offset=25');
ok(p1.data.total === 30 && p1.data.results.length === 25 && p2.data.results.length === 5, 'страницы по 25');
ok(!ids(p2).some((id) => ids(p1).includes(id)), 'страницы не пересекаются');

// ЛС
const dm = (await api(owner.token, 'POST', '/dms', { user_id: user.user.id })).data;
await post(owner.token, dm.id, 'личный фонтан');
r = await api(user.token, 'GET', `/search?channel_id=${dm.id}&q=${encodeURIComponent('фонтан')}`);
ok(r.data.total === 1 && r.data.results[0].guild_id === null, 'поиск в ЛС');
ok((await api(outsider.token, 'GET', `/search?channel_id=${dm.id}&q=x`)).data.total === 0, 'чужая ЛС — пусто');
ok((await S(user.token, 'фонтан')).data.terms.includes('фонтан'), 'terms для подсветки');

await api(owner.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nПОИСК: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

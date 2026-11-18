// Фаза 3d: превью ссылок и защита от SSRF.
// Сервер Relay запускать с RELAY_PREVIEW_ALLOW=127.0.0.1:7998 (тестовый «внешний» сайт);
// 127.0.0.1:7997 — «внутренний» сервис: Relay не должен обращаться к нему никогда (в т.ч. через редирект).
//   RELAY_URL=http://127.0.0.1:8099 node tests/embeds.mjs
import { createServer } from 'node:http';
import { api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const SITE = 'http://127.0.0.1:7998', INTERNAL = 'http://127.0.0.1:7997';

// <title>Привет</title> в windows-1251
const cp1251 = Buffer.concat([Buffer.from('<title>'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from('</title>')]);
const site = createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/page')) {
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      `<html><head><title>запасной</title><meta property="og:title" content="Статья ${u}"><meta property="og:description" content="Очень интересно">` +
      `<meta property="og:image" content="/cover.png"><meta property="og:site_name" content="Тестовый сайт"><meta name="theme-color" content="#22aa66"></head><body>…</body></html>`);
  }
  if (u === '/img.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(10));
  if (u === '/1251') return res.writeHead(200, { 'Content-Type': 'text/html; charset=windows-1251' }).end(cp1251);
  if (u === '/to-internal') return res.writeHead(302, { Location: `${INTERNAL}/secret` }).end();
  if (u === '/to-page') return res.writeHead(301, { Location: '/page-after-redirect' }).end();
  if (u === '/plain') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('просто текст');
  res.writeHead(404).end();
}).listen(7998, '127.0.0.1');
let internalHits = 0;
const internal = createServer((req, res) => { internalHits++; res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>СЕКРЕТ</title>'); }).listen(7997, '127.0.0.1');

const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('eo'), user = await reg('eu');
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Превью' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const text = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.channels.find((c) => c.kind === 'text');
const gw = await gatewayConnect(user.token);
const post = (tok, content, ch = text.id) => api(tok, 'POST', `/channels/${ch}/messages`, { content }).then((r) => r.data);
const getMsg = async (id, ch = text.id) => (await api(owner.token, 'GET', `/channels/${ch}/messages?around=${id}&limit=3`)).data.find((m) => m.id === id);
/** Дождаться, пока у сообщения станет n превью (или истечёт время). */
async function embedsOf(id, n = 1, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const m = await getMsg(id);
    if ((m?.embeds?.length ?? 0) >= n || Date.now() - t0 > ms) return m?.embeds ?? [];
    await wait(100);
  }
}

// карточка OpenGraph + событие message_update
const m1 = await post(owner.token, `смотри ${SITE}/page1 и ${SITE}/img.png`);
ok(Array.isArray(m1.embeds) && m1.embeds.length === 0, 'ответ на отправку — сразу, без ожидания превью');
let e = await embedsOf(m1.id, 2);
const card = e.find((x) => x.type === 'link');
ok(card?.title === 'Статья /page1' && card.description === 'Очень интересно' && card.site_name === 'Тестовый сайт', 'карточка: заголовок, описание, сайт');
ok(card?.image?.url === `${SITE}/cover.png` && card.color === '#22aa66', 'карточка: абсолютная ссылка на картинку и цвет');
ok(e.some((x) => x.type === 'image' && x.image.url === `${SITE}/img.png`), 'прямая ссылка на картинку → превью-картинка');
await wait(200);
ok(gw.events.some((x) => x.type === 'message_update' && x.message.id === m1.id && x.message.embeds.length === 2), 'message_update с превью по gateway');

// кодировка, редирект на свой же сайт, не-HTML
const m2 = await post(owner.token, `${SITE}/1251 ${SITE}/to-page ${SITE}/plain`);
e = await embedsOf(m2.id, 2);
await wait(500);
e = (await getMsg(m2.id)).embeds;
ok(e.some((x) => x.title === 'Привет'), 'windows-1251 декодируется');
ok(e.some((x) => x.title === 'Статья /page-after-redirect'), 'редирект внутри сайта — проверен и пройден');
ok(e.length === 2, 'text/plain — без превью');

// SSRF
const m3 = await post(owner.token, `${INTERNAL}/direct ${SITE}/to-internal http://169.254.169.254/latest/meta-data http://[::1]:7997/ http://localhost:7997/ http://0x7f000001:7997/`);
await wait(2500);
ok((await getMsg(m3.id)).embeds.length === 0, 'SSRF: внутренние адреса — без превью');
ok(internalHits === 0, `SSRF: внутренний сервис не получил ни одного запроса (получил ${internalHits})`);

// без превью: <ссылка>, код
const m4 = await post(owner.token, `<${SITE}/page2> \`${SITE}/page3\``);
await wait(1200);
ok((await getMsg(m4.id)).embeds.length === 0, '<ссылка> и `код` — без превью');

// YouTube (без сети карточка всё равно есть)
const m5 = await post(owner.token, 'https://youtu.be/dQw4w9WgXcQ');
e = await embedsOf(m5.id, 1, 10000);
ok(e[0]?.type === 'video' && e[0].provider === 'youtube' && e[0].video_id === 'dQw4w9WgXcQ' && e[0].image.url.includes('i.ytimg.com'), 'YouTube: видео-превью');

// правка: ссылку убрали — превью исчезло
await api(owner.token, 'PATCH', `/messages/${m1.id}`, { content: 'без ссылок' });
await wait(800);
ok((await getMsg(m1.id)).embeds.length === 0, 'правка без ссылок убирает превью');
await api(owner.token, 'PATCH', `/messages/${m1.id}`, { content: `теперь ${SITE}/page4` });
ok((await embedsOf(m1.id))[0]?.title === 'Статья /page4', 'правка с новой ссылкой — новое превью');

// скрыть превью: автор — да, чужой — нет
ok((await api(user.token, 'POST', `/messages/${m1.id}/suppress-embeds`, { suppress: true })).status === 403, 'чужое сообщение: скрыть превью нельзя');
const sup = await api(owner.token, 'POST', `/messages/${m1.id}/suppress-embeds`, { suppress: true });
ok(sup.status === 200 && sup.data.embeds.length === 0 && sup.data.suppress_embeds === true, 'автор скрыл превью');
const back = await api(owner.token, 'POST', `/messages/${m1.id}/suppress-embeds`, { suppress: false });
ok(back.data.embeds.length === 1, 'и вернул');

// нет права EMBED_LINKS — нет превью
const everyone = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data.roles.find((r) => r.is_default);
await api(owner.token, 'PUT', `/channels/${text.id}/permissions/role/${everyone.id}`, { allow: 0, deny: 1 << 14 });
const m6 = await post(user.token, `${SITE}/page5`);
await wait(1200);
ok((await getMsg(m6.id)).embeds.length === 0, 'без EMBED_LINKS превью не строится');

gw.close();
site.close();
internal.close();
await api(owner.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nПРЕВЬЮ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

// Хранилище файлов в S3 (Garage) — на стенде tests/stack (или на сервере):
//   RELAY_URL=http://127.0.0.1:18099 RELAY_METRICS_URL=http://127.0.0.1:19464/metrics RELAY_TEST_CONTAINER=relay-test-relay-1 node tests/storage.mjs
// Загрузка → S3, отдача /uploads (Range, HEAD, ETag/304, тип по расширению, кэш), защита ключей, старые файлы из
// запасного каталога и их перенос (relay storage-migrate), обработка аватара (ffmpeg из S3 → S3), метрики хранилища.
import { execFileSync } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';

const B = process.env.RELAY_URL || 'http://127.0.0.1:18099';
const MURL = process.env.RELAY_METRICS_URL || 'http://127.0.0.1:19464/metrics';
const CONTAINER = process.env.RELAY_TEST_CONTAINER || 'relay-test-relay-1';
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const upload = async (tok, name, buf, type) => {
  const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name);
  return (await (await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd })).json()).url;
};
const metric = async (key) => {
  const t = await (await fetch(MURL)).text();
  const line = t.split('\n').find((l) => l.startsWith(key + ' '));
  return line ? Number(line.split(' ').pop()) : 0;
};
const dockerExec = (...args) => execFileSync('docker', ['exec', CONTAINER, ...args], { encoding: 'utf8' });

/** Настоящий PNG w×h (градиент) — чтобы ffmpeg было что обрабатывать. */
function png(w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 255 / w; raw[o + 1] = y * 255 / h; raw[o + 2] = 128; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sfx = Date.now() % 1e6;
const { data: reg } = await api(null, 'POST', '/register', { username: 's_' + sfx, password: 'secret12' });
const tok = reg.token;

// ---------- загрузка и отдача ----------
const putsBefore = await metric('relay_storage_operations_total{op="put",result="success"}');
const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const url = await upload(tok, 'data.txt', body, 'text/plain');
ok(/^\/uploads\/[a-z0-9]+\.txt$/.test(url), `загрузка: ${url}`);
ok(await metric('relay_storage_operations_total{op="put",result="success"}') > putsBefore, 'загрузка прошла через хранилище (метрика put)');
let r = await fetch(B + url);
const got = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && got.equals(body), `GET: 200, ${got.length} байт совпадают`);
ok(/^text\/plain/.test(r.headers.get('content-type')) && r.headers.get('x-content-type-options') === 'nosniff', `тип по расширению (${r.headers.get('content-type')}) + nosniff`);
ok(/immutable/.test(r.headers.get('cache-control') || ''), 'кэш надолго (имена файлов случайные)');
const etag = r.headers.get('etag');
r = await fetch(B + url, { headers: { Range: 'bytes=100-199' } });
const part = Buffer.from(await r.arrayBuffer());
ok(r.status === 206 && part.equals(body.subarray(100, 200)) && /^bytes 100-199\/5000$/.test(r.headers.get('content-range') || ''), `Range: 206, ${r.headers.get('content-range')} (перемотка видео)`);
r = await fetch(B + url, { method: 'HEAD' });
ok(r.status === 200 && r.headers.get('content-length') === '5000', 'HEAD: размер без тела');
r = await fetch(B + url, { headers: { 'If-None-Match': etag } });
ok(etag && r.status === 304, `If-None-Match → 304 (ETag ${etag})`);
r = await fetch(B + '/uploads/nope123.png');
ok(r.status === 404, 'нет такого файла → 404');
for (const bad of ['/uploads/..%2f..%2fetc%2fpasswd', '/uploads/a%20b.png', '/uploads/m//x.png']) {
  r = await fetch(B + bad);
  ok(r.status === 404, `недопустимый ключ ${bad} → 404`);
}
// вложение проверяется через хранилище (HEAD)
const g = await api(tok, 'POST', '/guilds', { name: 'st ' + sfx });
const ch = (await api(tok, 'GET', `/guilds/${g.data.id}`)).data.channels.find((c) => c.kind === 'text');
r = await api(tok, 'POST', `/channels/${ch.id}/messages`, { content: 'файл', attachments: [{ url, name: 'data.txt' }] });
ok(r.status === 200 && r.data.attachments?.[0]?.size === 5000, `вложение: размер из хранилища (${r.data.attachments?.[0]?.size})`);
r = await api(tok, 'POST', `/channels/${ch.id}/messages`, { content: 'нет', attachments: [{ url: '/uploads/nope123.txt', name: 'x' }] });
ok(r.status === 400, 'несуществующее вложение → 400');

// ---------- старые файлы: запасной каталог и перенос ----------
const legacy = `legacy${sfx}.txt`;
dockerExec('sh', '-c', `printf 'old file %s' ${sfx} > /data/uploads/${legacy}`);
r = await fetch(B + '/uploads/' + legacy);
ok(r.status === 200 && (await r.text()) === `old file ${sfx}`, 'старый файл (ещё не в S3) отдаётся из /data/uploads');
const out = dockerExec('/app/relay', 'storage-migrate');
ok(/скопировано [1-9]\d*/.test(out) && /ошибок 0/.test(out), `перенос: ${out.trim().split('\n').pop()}`);
const again = dockerExec('/app/relay', 'storage-migrate');
ok(/скопировано 0,/.test(again), `повторный перенос ничего не копирует: ${again.trim().split('\n').pop()}`);
dockerExec('rm', `/data/uploads/${legacy}`);
r = await fetch(B + '/uploads/' + legacy);
ok(r.status === 200 && (await r.text()) === `old file ${sfx}`, 'после переноса и удаления с диска — отдаётся из S3');

// ---------- аватар: исходник из S3 → ffmpeg → результаты в S3 ----------
const src = await upload(tok, 'a.png', png(320, 240), 'image/png');
r = await api(tok, 'PATCH', '/me', { avatar: { url: src, crop: { x: 0.125, y: 0, w: 0.75, h: 1 } } });
let me = null;
for (let i = 0; i < 60; i++) { me = (await api(tok, 'GET', '/me')).data.user; if (!me.avatar_pending) break; await sleep(500); }
ok(me && /^\/uploads\/m\/[a-z0-9]+\/a256\.webp$/.test(me.avatar), `аватар обработан: ${me?.avatar}`);
for (const s of [32, 48, 96, 160, 256]) {
  r = await fetch(B + me.avatar.replace('a256', `a${s}`));
  const b = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && r.headers.get('content-type') === 'image/webp' && b.subarray(0, 4).toString() === 'RIFF', `a${s}.webp из S3 (${b.length} байт)`);
}
// устаревший результат удаляется из S3 (список по префиксу + удаление)
const delBefore = await metric('relay_storage_operations_total{op="delete",result="success"}');
const src2 = await upload(tok, 'b.png', png(200, 200), 'image/png');
await api(tok, 'PATCH', '/me', { avatar: { url: src2 } });
await api(tok, 'PATCH', '/me', { avatar: null });
for (let i = 0; i < 40 && (await metric('relay_storage_operations_total{op="delete",result="success"}')) <= delBefore; i++) await sleep(500);
ok(await metric('relay_storage_operations_total{op="delete",result="success"}') > delBefore, 'устаревший результат обработки удалён из S3');

// ---------- метрики хранилища ----------
const t = await (await fetch(MURL)).text();
ok(/^# TYPE relay_storage_operation_duration_seconds histogram/m.test(t) && /relay_storage_operations_total\{op="serve",result="success"\}/.test(t), 'метрики операций хранилища (время, число, результат)');
ok(/^# TYPE relay_storage_bytes gauge/m.test(t) && /^# TYPE relay_storage_objects gauge/m.test(t), 'метрики объёма хранилища');

console.log(fails ? `\nХРАНИЛИЩЕ: ОШИБОК ${fails}` : '\nХРАНИЛИЩЕ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

// Метрики Prometheus (запуск: RELAY_URL=… RELAY_METRICS_URL=… node tests/metrics.mjs):
// /metrics отдаётся на отдельном порту и содержит ключевые метрики; на основном порту его нет;
// счётчики растут от действий; метки ограничены (шаблоны маршрутов, без id).
import { gatewayConnect } from './lib.mjs';

const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
const MURL = process.env.RELAY_METRICS_URL || 'http://127.0.0.1:9464/metrics';
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const api = async (tok, method, path, body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
/** Текст /metrics → Map «имя{метки}» → число. */
async function scrape() {
  const r = await fetch(MURL);
  const text = await r.text();
  const m = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    m.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return { status: r.status, type: r.headers.get('content-type'), text, m };
}
const val = (s, key) => s.m.get(key) ?? 0;

const s0 = await scrape();
ok(s0.status === 200 && /text\/plain/.test(s0.type), '/metrics отдаётся на отдельном порту (text/plain)');
for (const name of ['relay_users_registered', 'relay_users_online', 'relay_voice_participants', 'relay_voice_channels_active', 'relay_streams_active',
  'relay_gateway_connections', 'relay_guilds_total', 'relay_messages_stored', 'relay_media_queue_length', 'relay_db_pool_max', 'relay_db_pool_connections',
  'relay_messages_created_total', 'relay_uploads_total', 'relay_upload_bytes_total', 'relay_logins_total', 'relay_registrations_total', 'relay_voice_joins_total',
  'relay_gateway_reconnects_total', 'relay_media_jobs_total', 'relay_db_errors_total',
  'relay_db_query_duration_seconds', 'relay_db_pool_acquire_duration_seconds',
  // метрики процесса — только на Linux (сервер); локально на Windows: RELAY_TEST_PROCESS=0
  ...(process.env.RELAY_TEST_PROCESS === '0' ? [] : ['process_cpu_seconds_total', 'process_resident_memory_bytes', 'process_open_fds', 'process_start_time_seconds'])]) {
  ok(new RegExp(`^# TYPE ${name} `, 'm').test(s0.text), `есть ${name}`);
}
const main = await fetch(B + '/metrics');
ok(!(await main.text()).includes('# TYPE relay_'), 'на основном порту /metrics нет');

// действия → счётчики
const sfx = Date.now() % 1e6;
const reg = await api(null, 'POST', '/register', { username: 'm_' + sfx, password: 'secret12' });
await api(null, 'POST', '/login', { username: 'm_' + sfx, password: 'wrong-password' });
await api(null, 'POST', '/login', { username: 'm_' + sfx, password: 'secret12' });
const tok = reg.data.token;
const g = await api(tok, 'POST', '/guilds', { name: 'metrics ' + sfx });
const ch = (await api(tok, 'GET', `/guilds/${g.data.id}`)).data.channels.find((c) => c.kind === 'text');
await api(tok, 'POST', `/channels/${ch.id}/messages`, { content: 'hello metrics' });
await api(tok, 'GET', `/channels/${ch.id}/messages`);
const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(1234)], { type: 'image/png' }), 'x.png');
await fetch(B + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
const gw = await gatewayConnect(tok, { base: B });

const s1 = await scrape();
// HTTP-метрики появляются с первым запросом (до него рядов нет)
for (const name of ['relay_http_requests_total', 'relay_http_request_duration_seconds']) ok(new RegExp(`^# TYPE ${name} `, 'm').test(s1.text), `есть ${name}`);
ok(val(s1, 'relay_registrations_total') >= val(s0, 'relay_registrations_total') + 1, 'регистрация → relay_registrations_total');
ok(val(s1, 'relay_logins_total{result="failure"}') >= val(s0, 'relay_logins_total{result="failure"}') + 1, 'неверный пароль → logins{result="failure"}');
ok(val(s1, 'relay_logins_total{result="success"}') >= val(s0, 'relay_logins_total{result="success"}') + 1, 'вход → logins{result="success"}');
ok(val(s1, 'relay_messages_created_total{kind="channel"}') >= val(s0, 'relay_messages_created_total{kind="channel"}') + 1, 'сообщение → messages_created_total{kind="channel"}');
ok(val(s1, 'relay_uploads_total{type="image"}') >= val(s0, 'relay_uploads_total{type="image"}') + 1, 'загрузка → uploads_total{type="image"}');
ok(val(s1, 'relay_upload_bytes_total') >= val(s0, 'relay_upload_bytes_total') + 1234, 'загрузка → upload_bytes_total');
ok(val(s1, 'relay_gateway_connections') >= 1 && val(s1, 'relay_users_online') >= 1, `gateway: соединений ${val(s1, 'relay_gateway_connections')}, онлайн ${val(s1, 'relay_users_online')}`);
ok([...s1.m.keys()].some((k) => k.startsWith('relay_db_query_duration_seconds_count{query="messages.list_by_channel"}')), 'операция БД под именем из кода (messages.list_by_channel)');
ok([...s1.m.keys()].some((k) => k.startsWith('relay_http_requests_total{') && k.includes('route="/api/channels/{id}/messages"')), 'HTTP: маршрут — шаблоном /api/channels/{id}/messages');

// кардинальность: ни в одной метке нет id/путей с числами
const labels = [...s1.m.keys()].filter((k) => k.startsWith('relay_')).flatMap((k) => [...k.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
const bad = labels.filter(([k, v]) => /\d{3,}/.test(v) && !(k === 'le') && !(k === 'status'));
ok(bad.length === 0, `метки без id и чисел из путей${bad.length ? ': ' + JSON.stringify(bad.slice(0, 5)) : ''}`);
const routes = new Set(labels.filter(([k]) => k === 'route').map(([, v]) => v));
ok([...routes].every((r) => !/\/\d/.test(r)), `маршрутов в метках: ${routes.size}, все — шаблоны`);
gw.close();

console.log(fails ? `\nМЕТРИКИ: ОШИБОК ${fails}` : '\nМЕТРИКИ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);

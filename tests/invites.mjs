// Закрытая регистрация (src/invites.rs): коды, запросы участников, админка, обходные пути.
//   RELAY_URL=http://127.0.0.1:18099 node --import=./tests/register-codes.mjs tests/invites.mjs
// Стенд — tests/stack (RELAY_INSTANCE_ADMINS=tadmin). Сроки «истёк» подкручиваются прямо в БД стенда (psql в контейнере).
import { execSync } from 'node:child_process';
import { nextCode } from './register-codes.mjs';

const B = process.env.RELAY_URL || 'http://127.0.0.1:18099';
const PG = process.env.RELAY_TEST_PG || 'relay-test-postgres-1';
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
async function call(tok, method, path, body) {
  const r = await fetch(B + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const sql = (q) => execSync(`docker exec ${PG} psql -U relay -d relay -Atc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sfx = Date.now() % 1_000_000;
const PASS = 'secret12';
const reg = (username, code) => call(null, 'POST', '/register', { username, password: PASS, code });
const INVALID = 'Код приглашения недействителен';

// администратор инстанса — из RELAY_INSTANCE_ADMINS стенда
let admin = (await call(null, 'POST', '/login', { username: 'tadmin', password: PASS })).j?.token;
if (!admin) admin = (await reg('tadmin', nextCode())).j?.token;
const me = await call(admin, 'GET', '/me');
ok(me.j?.user?.is_admin ?? me.j?.is_admin, 'tadmin — администратор (из RELAY_INSTANCE_ADMINS)');

// ---------- регистрация: отказы ----------
for (const [what, code] of [['без кода', null], ['пустой код', ''], ['неверный код', 'ABCDEFGHJKMNPQRSTUVWXYZ2']]) {
  const r = await reg('nocode' + sfx, code);
  ok(r.status === 400 && r.j?.error === INVALID, `регистрация ${what} → «${INVALID}»`);
}
const mk = async (body = {}) => (await call(admin, 'POST', '/admin/invites/codes', { note: 'тест', ...body })).j;
const c1 = await mk();
ok(/^[2-9A-HJ-NP-Z]{24}$/.test(c1?.code ?? '') && c1.link?.endsWith('/register?code=' + c1.code), 'админ создаёт код: 24 символа без 0/O/1/I/L, ссылка /register?code=');
const ok1 = await reg('first' + sfx, c1.code.toLowerCase().replace(/(.{6})/g, '$1-'));
ok(ok1.status === 200 && ok1.j?.token, 'регистрация по коду (регистр и дефисы не важны)');
const again = await reg('second' + sfx, c1.code);
ok(again.status === 400 && again.j?.error === INVALID, 'использованный код → отказ (та же ошибка)');
const c2 = await mk();
ok((await call(admin, 'POST', `/admin/invites/codes/${c2.id}/revoke`)).status === 200, 'админ отзывает код');
ok((await reg('rev' + sfx, c2.code)).j?.error === INVALID, 'отозванный код → отказ');
const c3 = await mk();
sql(`UPDATE registration_invites SET expires_at = 1 WHERE id = ${c3.id}`);
ok((await reg('exp' + sfx, c3.code)).j?.error === INVALID, 'истёкший код → отказ');

// ошибка при создании пользователя (имя занято) → код не израсходован
const c4 = await mk();
const taken = await reg('first' + sfx, c4.code);
ok(taken.status === 409, 'имя занято → 409');
ok(sql(`SELECT used_at IS NULL AND used_by IS NULL FROM registration_invites WHERE id = ${c4.id}`) === 't', 'после отката код не помечен использованным');
ok((await reg('afterfail' + sfx, c4.code)).status === 200, 'тот же код потом работает');

// конкуренция: 10 параллельных регистраций с одним кодом — ровно одна
const c5 = await mk();
const race = await Promise.all(Array.from({ length: 10 }, (_, i) => reg(`race${sfx}_${i}`, c5.code)));
ok(race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.j?.error === INVALID).length === 9, '10 параллельных регистраций с одним кодом → успешна ровно одна');
ok(sql(`SELECT count(*) FROM users WHERE username LIKE 'race${sfx}_%'`) === '1', 'в БД — один пользователь из гонки');

// код с сервером — новичок сразу на нём
const owner = ok1.j.token;
const g = (await call(owner, 'POST', '/guilds', { name: 'Инвайты ' + sfx })).j;
const c6 = await mk({ guild_id: g.id });
const newbie = await reg('newbie' + sfx, c6.code);
const nb = await call(newbie.j.token, 'GET', '/me');
ok((nb.j?.guilds ?? []).some((x) => x.id === g.id), 'код с target_guild_id → пользователь на сервере');

// ---------- запросы участников ----------
const ownerMe = (await call(owner, 'GET', '/me')).j;
const req = async (tok, body) => call(tok, 'POST', '/invite-requests', { guild_id: g.id, invitee: 'Друг', comment: 'с работы', ...body });
const r1 = await req(owner, { invitee: 'Аня' });
ok(r1.status === 200 && r1.j?.id, 'участник с правом «Приглашать» создаёт запрос');
const r2 = await req(owner, { invitee: 'Боря' }), r3 = await req(owner, { invitee: 'Вика' });
const r4 = await req(owner, { invitee: 'Гоша' });
ok(r2.status === 200 && r3.status === 200 && r4.status === 400, 'не больше 3 ожидающих запросов');
const pend = await call(admin, 'GET', '/admin/invites/requests');
ok((pend.j?.items ?? []).filter((x) => x.status === 'pending' && x.requester?.id === (ownerMe.user?.id ?? ownerMe.id)).length >= 3 && pend.j.counts?.pending >= 3, 'админ видит ожидающие запросы и счётчик');
ok((await call(admin, 'POST', `/admin/invites/requests/${r1.j.id}/approve`, { days: 3 })).status === 200, 'админ одобряет запрос');
const mine = (await call(owner, 'GET', '/invite-requests/mine')).j?.items ?? [];
const approved = mine.find((x) => x.id === r1.j.id);
ok(approved?.status === 'approved' && /\/register\?code=[2-9A-HJ-NP-Z]{24}$/.test(approved?.link ?? ''), 'автор видит ссылку одобренного запроса');
const other = (await call(newbie.j.token, 'GET', '/invite-requests/mine')).j?.items ?? [];
ok(!other.some((x) => x.id === r1.j.id), 'другой участник чужой ссылки не видит');
const viaReq = await reg('viareq' + sfx, approved.link.split('code=')[1]);
ok(viaReq.status === 200 && ((await call(viaReq.j.token, 'GET', '/me')).j?.guilds ?? []).some((x) => x.id === g.id), 'регистрация по ссылке запроса → на сервере');
const afterUse = (await call(owner, 'GET', '/invite-requests/mine')).j.items.find((x) => x.id === r1.j.id);
ok(afterUse.code_state === 'used' && !afterUse.link, 'после использования ссылка автору больше не показывается');
ok((await call(admin, 'POST', `/admin/invites/requests/${r2.j.id}/reject`, { reason: 'не знаю его' })).status === 200, 'админ отклоняет с причиной');
const rej = (await call(owner, 'GET', '/invite-requests/mine')).j.items.find((x) => x.id === r2.j.id);
ok(rej.status === 'rejected' && rej.reason === 'не знаю его' && !rej.link, 'автор видит отказ и причину');
ok((await call(owner, 'POST', `/invite-requests/${r3.j.id}/cancel`)).status === 200, 'автор отменяет ожидающий запрос');
ok((await call(owner, 'POST', `/invite-requests/${r2.j.id}/cancel`)).status === 400, 'решённый запрос не отменить');
ok((await call(admin, 'POST', `/admin/invites/requests/${r3.j.id}/approve`, {})).status === 400, 'отменённый запрос не одобрить');
const r5 = await req(owner, { invitee: 'Дима' });
sql(`UPDATE invite_requests SET created_at = 1 WHERE id = ${r5.j.id}`);
ok((await call(owner, 'GET', '/invite-requests/mine')).j.items.find((x) => x.id === r5.j.id)?.status === 'expired', 'запрос старше 14 дней → «истёк»');

// без права «Приглашать» на сервере — нельзя
const detail = (await call(owner, 'GET', `/guilds/${g.id}`)).j;
const every = (detail.roles ?? []).find((r) => r.is_default);
ok(!!every, 'роль @everyone найдена');
ok((await call(owner, 'PATCH', `/roles/${every.id}`, { permissions: Number(BigInt(every.permissions) & ~1n) })).status === 200, '@everyone: право «Приглашать» снято');
ok((await req(newbie.j.token, {})).status === 403, 'участник без CREATE_INVITE на сервере → 403');
const stranger = (await call(admin, 'POST', '/guilds', { name: 'Чужой ' + sfx })).j;
ok((await call(owner, 'POST', '/invite-requests', { guild_id: stranger.id, invitee: 'X' })).status === 404, 'на чужой сервер — нельзя (сервер не раскрывается)');

// ---------- админка: 403 остальным ----------
const ADMIN = [['GET', '/admin/invites/requests'], ['GET', '/admin/invites/codes'], ['POST', '/admin/invites/codes'], ['GET', '/admin/invites/history'], ['GET', '/admin/invites/guilds'],
  ['POST', `/admin/invites/codes/${c6.id}/revoke`], ['POST', `/admin/invites/requests/${r4.j?.id ?? 1}/approve`], ['POST', `/admin/invites/requests/${r4.j?.id ?? 1}/reject`]];
const denied = [];
for (const [m, p] of ADMIN) { const r = await call(owner, m, p, m === 'POST' ? {} : undefined); if (r.status !== 403) denied.push(`${m} ${p} → ${r.status}`); }
ok(!denied.length, `не-админ получает 403 на всех admin-эндпоинтах${denied.length ? ': ' + denied.join(', ') : ''}`);
ok((await call(null, 'GET', '/admin/invites/codes')).status === 401, 'без входа — 401');
ok(!(await call(owner, 'GET', '/me')).j?.invite_pending, 'не-админу счётчик запросов не отдаётся');
const hist = (await call(admin, 'GET', '/admin/invites/history')).j?.items ?? [];
const h = hist.find((x) => x.user?.username === 'viareq' + sfx);
ok(h && h.invited_by?.username === 'first' + sfx && h.approved_by?.username === 'tadmin', 'история: кто пригласил, кто одобрил, кто зарегистрировался');
const codes = (await call(admin, 'GET', '/admin/invites/codes')).j?.items ?? [];
ok(['used', 'revoked', 'expired', 'active'].every((s) => codes.some((c) => c.state === s)) && !JSON.stringify(codes).includes(c6.code), 'список кодов: состояния, сами коды не отдаются');

// ---------- прочее ----------
ok((await call(null, 'POST', '/login', { username: 'first' + sfx, password: PASS })).status === 200, 'существующий пользователь входит как раньше');
// единственный сетевой путь создания аккаунта — /register; гостевого входа и dev-эндпоинтов нет
for (const p of ['/guest', '/dev/user', '/users', '/auth/guest']) {
  const r = await call(null, 'POST', p, { username: 'g' + sfx, password: PASS });
  ok(r.status === 404 || r.status === 405 || r.status === 401, `POST ${p} — не создаёт пользователя (${r.status})`);
}
ok(sql(`SELECT count(*) FROM users WHERE username = 'g${sfx}'`) === '0', 'обходные пути не создали аккаунт');
const m = await (await fetch(B.replace(/:\d+$/, ':19464') + '/metrics')).text().catch(() => '');
ok(/relay_registration_invites\{state="used"\}/.test(m) || !m, 'метрики relay_registration_invites (если метрики стенда доступны)');

console.log(fails ? `\nПРОВАЛЕНО: ${fails}` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);

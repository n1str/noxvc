// Тестовые стенды и закрытая регистрация: регистрация — только по коду приглашения (src/invites.rs).
// Подгружается к любому тесту:  NODE_OPTIONS="--import=./tests/register-codes.mjs" node tests/smoke.mjs
// POST /api/register без поля code → код подставляется; коды выпускаются пачкой через CLI стенда
// (RELAY_CODES_CMD, по умолчанию docker exec relay-test-relay-1 /app/relay admin invite create --count 50 --quiet).
// Тесты, которые проверяют сам код (tests/invites.mjs), передают code явно — их запросы не трогаются.
import { execSync } from 'node:child_process';

const CONTAINER = process.env.RELAY_TEST_CONTAINER || 'relay-test-relay-1';
const CMD = process.env.RELAY_CODES_CMD || `docker exec -e RELAY_QUIET_CODES=1 ${CONTAINER} /app/relay admin invite create --count 50 --quiet --note tests`;
const pool = [];
export function nextCode() {
  if (!pool.length) pool.push(...execSync(CMD, { encoding: 'utf8' }).split(/\s+/).filter(Boolean));
  return pool.shift();
}
const orig = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (/\/api\/register$/.test(url) && String(init.method || 'GET').toUpperCase() === 'POST' && typeof init.body === 'string') {
    try {
      const b = JSON.parse(init.body);
      if (!('code' in b)) init = { ...init, body: JSON.stringify({ ...b, code: nextCode() }) };
    } catch { /* не JSON — как есть */ }
  }
  return orig(input, init);
};

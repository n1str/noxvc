// Общий тестовый клиент gateway (протокол — src/gateway.rs).
export const B = process.env.RELAY_URL || 'http://127.0.0.1:8099';
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Подключиться, сделать IDENTIFY и дождаться READY. Сам шлёт heartbeat. events — {type, ...d}. */
export function gatewayConnect(token, { base = B, heartbeat = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/gateway`);
    const c = {
      ws, events: [], raw: [], seq: 0, session: null, acks: 0, closed: false, ready: null,
      close() { clearInterval(c.hb); ws.close(); },
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      c.raw.push(m);
      if (m.op === 10) {
        c.interval = m.d.heartbeat_interval;
        if (heartbeat) c.hb = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: 1, d: c.seq })), m.d.heartbeat_interval / 2);
        ws.send(JSON.stringify({ op: 2, d: { token } }));
      } else if (m.op === 11) c.acks++;
      else if (m.op === 9) reject(new Error('INVALID_SESSION'));
      else if (m.op === 0) {
        c.seq = m.s;
        if (m.t === 'READY') { c.session = m.d.session_id; c.ready = m.d; resolve(c); }
        else c.events.push({ ...m.d, type: m.t.toLowerCase() });
      }
    };
    ws.onclose = () => { c.closed = true; clearInterval(c.hb); };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

export async function api(tok, method, path, body) {
  const r = await fetch(B + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: body && JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

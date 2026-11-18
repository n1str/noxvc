// Клиент gateway (протокол — src/gateway.rs, ADR-010).
// HELLO → IDENTIFY | RESUME → READY | RESUMED → DISPATCH {t, s, d}; heartbeat с проверкой ACK;
// пропуск s или обрыв → переподключение с RESUME; INVALID_SESSION → IDENTIFY и полный READY.
export type GatewayEvent = { type: string; [k: string]: unknown };

interface Handlers {
  onReady(data: Record<string, unknown>, isReconnect: boolean): void;
  onEvent(ev: GatewayEvent): void;
  onStatus?(status: 'connecting' | 'online' | 'reconnecting'): void;
  /** Сеанс завершён (с другого устройства, смена пароля) или токен недействителен — на экран входа. */
  onAuthFailed?(): void;
}

export class Gateway {
  private ws: WebSocket | null = null;
  private session: string | null = null;
  private seq = 0;
  private hb: ReturnType<typeof setInterval> | undefined;
  private acked = true;
  private retry = 0;
  private readyCount = 0;
  private stopped = false;

  constructor(private token: string, private h: Handlers) {}

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    clearInterval(this.hb);
    this.ws?.close();
    this.ws = null;
  }

  private send(op: number, d: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gateway`);
    this.ws = ws;
    this.h.onStatus?.(this.readyCount ? 'reconnecting' : 'connecting');
    ws.onmessage = (e) => {
      let m: { op: number; t?: string; s?: number; d: any };
      try { m = JSON.parse(e.data); } catch { return; }
      switch (m.op) {
        case 10: // HELLO
          clearInterval(this.hb);
          this.acked = true;
          this.hb = setInterval(() => {
            if (!this.acked) { ws.close(4000, 'heartbeat'); return; }
            this.acked = false;
            this.send(1, this.seq);
          }, m.d.heartbeat_interval);
          if (this.session) this.send(6, { token: this.token, session_id: this.session, seq: this.seq });
          else this.send(2, { token: this.token });
          return;
        case 11: this.acked = true; return;
        case 9: this.session = null; this.seq = 0; ws.close(4001, 'invalid session'); return;
        case 0: {
          if (m.t === 'READY') {
            this.session = m.d.session_id; this.seq = m.s!; this.retry = 0;
            this.h.onReady(m.d, this.readyCount++ > 0);
            this.h.onStatus?.('online');
            return;
          }
          if (m.s !== this.seq + 1) { ws.close(4002, 'gap'); return; }
          this.seq = m.s!;
          if (m.t === 'RESUMED') { this.retry = 0; this.h.onStatus?.('online'); return; }
          this.h.onEvent({ ...m.d, type: m.t!.toLowerCase() });
        }
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.hb);
      if (this.stopped || this.ws !== ws) return;
      if (e.code === 4004) { this.stopped = true; this.h.onAuthFailed?.(); return; } // сеанс завершён — не переподключаемся
      this.h.onStatus?.('reconnecting');
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => !this.stopped && this.connect(), Math.min(800 * this.retry, 5000));
    };
  }
}

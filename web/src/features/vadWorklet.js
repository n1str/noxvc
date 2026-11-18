// Голосовая активация (шумовой гейт) на треке микрофона — в аудиопотоке (AudioWorklet): работает и когда вкладка
// в фоне или окно приложения свёрнуто за игрой (таймеры и requestAnimationFrame там замедляются, аудиопоток — нет).
//
// Уровень — RMS блоками по 5 мс, в дБFS. Решение «говорит» — по неотложенному сигналу, а наружу идёт сигнал,
// задержанный на LOOKAHEAD: гейт открывается раньше, чем до выхода доходит начало слова (не обрезаем первый слог).
// Закрытие — после `hangover` мс тишины (не обрезаем концы слов). Открытие/закрытие — плавное (без щелчков).
// Порог: ручной (дБFS) или автоматический — фон шума + запас. Фон — минимум уровня за последние ~3 с (отрезки по 0,5 с):
// в речи есть паузы между слогами, поэтому фон по речи не растёт; цифровая тишина (выключенный микрофон) не учитывается.
// Параметры — сообщения { threshold, auto, hangover, enabled }; наружу ~20 раз в секунду: { level, gated, open, floor, thr }.

// Упреждение ≥ окна решения: начало слова обнаруживается не позже чем через окно (5 мс) и успевает открыть гейт.
const LOOKAHEAD_S = 0.01;
const AUTO_MARGIN_DB = 14; // авто: насколько речь должна быть громче фонового шума
const AUTO_MIN_DB = -62, AUTO_MAX_DB = -34;

class RelayVad extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -50; this.auto = true; this.hangover = 300; this.enabled = true;
    this.delay = new Float32Array(Math.ceil(sampleRate * LOOKAHEAD_S) * 2 + 256); // кольцевой буфер (моно)
    this.w = 0; this.lag = Math.ceil(sampleRate * LOOKAHEAD_S);
    this.blockN = Math.round(sampleRate / 200); this.acc = 0; this.accN = 0; // окно RMS 5 мс
    this.levelDb = -100; this.peakDb = -100; this.floorDb = -60; this.segMin = 0; this.segN = 0; this.segs = []; this.open = false; this.lastLoud = -1e9; this.t = 0;
    this.gain = 0; this.outAcc = 0; this.outN = 0; this.outDb = -100; this.lastPost = 0;
    this.port.onmessage = (e) => { Object.assign(this, e.data); };
  }
  thr() { return this.auto ? Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, this.floorDb + AUTO_MARGIN_DB)) : this.threshold; }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0] ? out[0].length : 128;
    const ch0 = inp && inp[0];
    const step = 1 / (sampleRate * 0.003); // плавность гейта ~3 мс
    for (let i = 0; i < n; i++) {
      const x = ch0 ? ch0[i] : 0;
      this.acc += x * x; this.accN++;
      if (this.accN >= this.blockN) {
        const db = 10 * Math.log10(this.acc / this.accN + 1e-12);
        this.levelDb = db; this.peakDb = Math.max(this.peakDb, db); this.acc = 0; this.accN = 0;
        if (db > -100) { // фон шума: минимум за ~3 с
          this.segMin = this.segN ? Math.min(this.segMin, db) : db; this.segN++;
          if (this.segN >= 100) { this.segs.push(this.segMin); if (this.segs.length > 6) this.segs.shift(); this.segN = 0; }
          this.floorDb = Math.min(...this.segs, this.segN ? this.segMin : Infinity);
        }
        if (db >= this.thr()) this.lastLoud = this.t;
        this.open = !this.enabled || this.t - this.lastLoud <= (this.hangover / 1000 + LOOKAHEAD_S) * sampleRate;
      }
      this.t++;
      // задержанный сигнал на выход, гейт — плавно
      this.delay[this.w] = x;
      const r = (this.w - this.lag + this.delay.length) % this.delay.length;
      this.w = (this.w + 1) % this.delay.length;
      const target = this.open ? 1 : 0;
      this.gain += Math.max(-step, Math.min(step, target - this.gain));
      const y = this.delay[r] * this.gain;
      for (let c = 0; c < out.length; c++) out[c][i] = y;
      this.outAcc += y * y; this.outN++;
    }
    if (this.t - this.lastPost >= sampleRate / 20) {
      this.outDb = 10 * Math.log10(this.outAcc / Math.max(1, this.outN) + 1e-12); this.outAcc = 0; this.outN = 0;
      this.port.postMessage({ level: this.peakDb, gated: this.outDb, open: this.open, floor: this.floorDb, thr: this.thr() });
      this.lastPost = this.t; this.peakDb = -100;
    }
    return true;
  }
}
registerProcessor('relay-vad', RelayVad);

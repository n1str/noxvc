// Голосовая активация и уровни громкости.
// - Гейт на треке микрофона — процессор трека LiveKit с AudioWorklet (vadWorklet.js): ручной или автоматический порог,
//   задержка отпускания; работает в аудиопотоке (не зависит от фоновых вкладок/свёрнутого окна).
// - Уровни: свой — из worklet (до гейта — для индикатора и порога, после гейта — «что слышат другие»), участников —
//   анализатором на принятых треках микрофона. Интерфейс подписывается на уровни напрямую (без перерисовок React):
//   индикаторы и кольца говорящего обновляют стили через requestAnimationFrame.
// Код worklet — в бандле, модуль грузится из Blob: без отдельного запроса (кэш/прокси/рассинхрон версий при выкладке).
import workletSrc from './vadWorklet.js?raw';
let workletUrl = '';

export interface VadParams { threshold: number; auto: boolean; hangover: number; enabled: boolean }
/** Свой микрофон (дБFS): уровень до гейта, после гейта, открыт ли гейт, фон шума, действующий порог. */
export interface SelfMeter { level: number; gated: number; open: boolean; floor: number; thr: number }

export const DB_MIN = -80, DB_MAX = 0;
/** дБFS → 0..1 для шкалы индикатора. */
export const dbToUnit = (db: number) => Math.min(1, Math.max(0, (db - DB_MIN) / (DB_MAX - DB_MIN)));
/** дБFS → «громкость» 0..1 для кольца говорящего (речь ~ -45…-15 дБFS). */
const ringLevel = (db: number) => Math.min(1, Math.max(0, (db + 55) / 40));

// ---------- подписки ----------
type Fn<T> = (v: T) => void;
const levels = new Map<number, number>();
const levelSubs = new Map<number, Set<Fn<number>>>();
const selfSubs = new Set<Fn<SelfMeter>>();
let self: SelfMeter = { level: -100, gated: -100, open: false, floor: -60, thr: -50 };
let selfUid = 0;

function setLevel(uid: number, v: number) {
  if (levels.get(uid) === v) return;
  levels.set(uid, v);
  levelSubs.get(uid)?.forEach((f) => f(v));
}
/** Уровень участника 0..1 (кольцо говорящего). Возвращает отписку. */
export function onLevel(uid: number, f: Fn<number>) {
  let s = levelSubs.get(uid); if (!s) levelSubs.set(uid, (s = new Set()));
  s.add(f); f(levels.get(uid) ?? 0);
  return () => { s!.delete(f); };
}
/** Свой микрофон (индикатор в панели голоса и в настройках). */
export function onSelfMeter(f: Fn<SelfMeter>) { selfSubs.add(f); f(self); return () => { selfSubs.delete(f); }; }
// для e2e: состояние своего гейта (как __relayVoice)
(window as unknown as { __relayVad?: () => SelfMeter }).__relayVad = () => self;
function pushSelf(m: SelfMeter) {
  self = m; selfSubs.forEach((f) => f(m));
  if (selfUid) setLevel(selfUid, m.open ? ringLevel(m.gated) : 0);
}

// ---------- гейт ----------
const loaded = new WeakSet<BaseAudioContext>();
async function vadNode(ctx: AudioContext, params: VadParams) {
  if (!loaded.has(ctx)) {
    workletUrl ||= URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl); loaded.add(ctx);
  }
  const node = new AudioWorkletNode(ctx, 'relay-vad', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.postMessage(params);
  return node;
}

let liveNode: AudioWorkletNode | null = null;
let params: VadParams = { threshold: -50, auto: true, hangover: 300, enabled: true };
export function setVadParams(p: VadParams) { params = p; liveNode?.port.postMessage(p); testNode?.port.postMessage(p); }

/** Процессор трека микрофона для LiveKit (track.setProcessor). */
export function vadProcessor(uid: number) {
  selfUid = uid;
  let src: MediaStreamAudioSourceNode | null = null, node: AudioWorkletNode | null = null, dest: MediaStreamAudioDestinationNode | null = null;
  const p = {
    name: 'relay-vad',
    processedTrack: undefined as MediaStreamTrack | undefined,
    async init(o: { track: MediaStreamTrack; audioContext: AudioContext }) {
      const ctx = o.audioContext;
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      node = await vadNode(ctx, params);
      node.port.onmessage = (e) => pushSelf(e.data as SelfMeter);
      src = ctx.createMediaStreamSource(new MediaStream([o.track]));
      dest = ctx.createMediaStreamDestination();
      src.connect(node).connect(dest);
      p.processedTrack = dest.stream.getAudioTracks()[0];
      liveNode = node;
    },
    async restart(o: { track: MediaStreamTrack; audioContext: AudioContext }) { await p.destroy(); await p.init(o); },
    async destroy() {
      src?.disconnect(); node?.disconnect(); node?.port.close();
      p.processedTrack?.stop();
      if (liveNode === node) liveNode = null;
      src = node = dest = null; p.processedTrack = undefined;
      pushSelf({ ...self, level: -100, gated: -100, open: false });
    },
  };
  return p;
}

// ---------- проверка микрофона в настройках (вне голоса): тот же гейт ----------
let testNode: AudioWorkletNode | null = null;
/** Запустить проверку: индикатор и порог — как в голосовом канале. Возвращает остановку. */
export async function startMicTest(stream: MediaStream) {
  const ctx = new AudioContext();
  const node = await vadNode(ctx, params);
  node.port.onmessage = (e) => { const m = e.data as SelfMeter; self = m; selfSubs.forEach((f) => f(m)); };
  ctx.createMediaStreamSource(stream).connect(node); // выход не нужен — только уровни
  testNode = node;
  return () => { node.disconnect(); node.port.close(); if (testNode === node) testNode = null; ctx.close().catch(() => {}); };
}

// ---------- уровни участников ----------
interface Remote { an: AnalyserNode; src: MediaStreamAudioSourceNode; buf: Float32Array<ArrayBuffer> }
const remotes = new Map<number, Remote>();
let actx: AudioContext | null = null, raf = 0;
export function trackRemote(uid: number, mst: MediaStreamTrack) {
  untrackRemote(uid);
  actx ??= new AudioContext();
  if (actx.state !== 'running') actx.resume().catch(() => {});
  const src = actx.createMediaStreamSource(new MediaStream([mst]));
  const an = actx.createAnalyser(); an.fftSize = 512;
  src.connect(an); // только анализ: звук играет LiveKit
  remotes.set(uid, { an, src, buf: new Float32Array(an.fftSize) });
  if (!raf) loop();
}
export function untrackRemote(uid: number) {
  const r = remotes.get(uid); if (!r) return;
  r.src.disconnect(); remotes.delete(uid); setLevel(uid, 0);
}
export function untrackAll() { for (const uid of [...remotes.keys()]) untrackRemote(uid); if (selfUid) setLevel(selfUid, 0); }
function loop() {
  raf = 0;
  if (!remotes.size) return;
  for (const [uid, r] of remotes) {
    r.an.getFloatTimeDomainData(r.buf);
    let s = 0; for (const v of r.buf) s += v * v;
    const db = 10 * Math.log10(s / r.buf.length + 1e-12);
    // плавно вниз (кольцо не мигает между слогами), сразу вверх
    const prev = levels.get(uid) ?? 0, cur = ringLevel(db);
    setLevel(uid, cur >= prev ? cur : prev * 0.85 + cur * 0.15);
  }
  raf = requestAnimationFrame(loop);
}

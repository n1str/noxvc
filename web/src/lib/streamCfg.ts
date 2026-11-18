// Настройки качества трансляций (демонстрация экрана и камера) и просмотра. Без ограничений «Нитро»:
// до исходного разрешения и 60 FPS, битрейт до 30 Мбит/с. Хранятся на устройстве.

export type StreamRes = '720' | '1080' | '1440' | 'source';
export type StreamMode = 'auto' | 'motion' | 'detail';
export type Codec = 'auto' | 'h264' | 'vp8' | 'vp9' | 'av1';
/** Кодирование трансляции в приложении: видеокарта (при сбое — процессор), только видеокарта, только процессор. */
export type Encoder = 'auto' | 'gpu' | 'cpu';
export interface StreamCfg {
  res: StreamRes; fps: 15 | 30 | 60; mode: StreamMode; audio: boolean; surface: 'any' | 'monitor' | 'window' | 'browser';
  codec: Codec; /** кбит/с; 0 — авто */ bitrate: number;
  encoder: Encoder;
  camRes: '480' | '720' | '1080'; camFps: 30 | 60;
  /** Всегда принимать максимальное качество (иначе — по размеру плитки, экономит трафик). */
  viewMax: boolean;
}
const KEY = 'relay_stream';
const DEF: StreamCfg = { res: '1080', fps: 60, mode: 'auto', audio: true, surface: 'any', codec: 'auto', bitrate: 0, encoder: 'auto', camRes: '720', camFps: 30, viewMax: true };

export const streamCfg: StreamCfg = (() => {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEF }; }
})();
export function saveStreamCfg(patch: Partial<StreamCfg>) {
  Object.assign(streamCfg, patch);
  try { localStorage.setItem(KEY, JSON.stringify(streamCfg)); } catch { /* приватный режим */ }
}

const DIMS: Record<StreamRes, [number, number]> = { '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440], source: [3840, 2160] };
export const streamDims = (r: StreamRes) => DIMS[r];
export const camDims = (r: StreamCfg['camRes']) => ({ '480': [854, 480], '720': [1280, 720], '1080': [1920, 1080] } as const)[r];

/** Авто-битрейт (кбит/с): с запасом относительно Discord Nitro — экран требовательнее камеры. */
const AUTO: Record<StreamRes, Record<number, number>> = {
  '720': { 15: 1500, 30: 3000, 60: 5000 },
  '1080': { 15: 3000, 30: 6000, 60: 10000 },
  '1440': { 15: 5000, 30: 9000, 60: 15000 },
  source: { 15: 7000, 30: 12000, 60: 20000 },
};
export const streamBitrate = (c: StreamCfg) => (c.bitrate > 0 ? c.bitrate : AUTO[c.res][c.fps]);
export const camBitrate = (c: StreamCfg) => ({ '480': 1000, '720': 2500, '1080': 4500 }[c.camRes] * (c.camFps === 60 ? 1.5 : 1));

/** Кодирует ли браузер H.264 видеокартой (MediaCapabilities, powerEfficient). Без неё Chrome кодирует H.264
 *  программным OpenH264: на окне с текстом (браузер, IDE) 20–37 мс на кадр 1080p — в сеть уходит 10–17 FPS из 57
 *  захваченных и задержка 140–170 мс. VP8 (libvpx) тот же кадр кодирует за ~4 мс: 26–57 FPS, 86–120 мс (замеры блока 2,
 *  docs/DIAGNOSIS-block2.md). Пока проверка не ответила — считаем, что не умеет. */
let hwH264 = false;
if (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.encodingInfo) {
  navigator.mediaCapabilities
    .encodingInfo({ type: 'webrtc', video: { contentType: 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', width: 1920, height: 1080, bitrate: 6_000_000, framerate: 30 } } as MediaEncodingConfiguration)
    .then((i) => { hwH264 = i.supported && i.powerEfficient; })
    .catch(() => {});
}

/** Кодек трансляции из браузера: H.264 — только если кодирует видеокарта; иначе VP8 (быстрое программное кодирование);
 *  VP9 — режим «чёткость» и разрешения выше 1080p (лучше текст на том же битрейте). */
export function streamCodec(c: StreamCfg): Exclude<Codec, 'auto'> {
  if (c.codec !== 'auto') return c.codec;
  if (c.mode === 'detail' || c.res === '1440' || c.res === 'source') return 'vp9';
  return hwH264 ? 'h264' : 'vp8';
}
/** Что жертвовать при нехватке канала: плавность — держим FPS, чёткость — держим разрешение. */
export const degradation = (m: StreamMode): RTCDegradationPreference => (m === 'motion' ? 'maintain-framerate' : m === 'detail' ? 'maintain-resolution' : 'balanced');
/** Подсказка содержимого. «Авто» — тоже 'motion': без подсказки Chrome считает захват экрана «скринкастом» и при
 *  перерасходе битрейта выкидывает кадры — на окне с меняющимся текстом 9–13 FPS из 57 и фризы; с 'motion' тот же
 *  поток — 52 FPS, 92 мс, без фризов (замеры блока 2). Чёткий текст ценой FPS — режим «чёткость» ('detail'). */
export const contentHint = (m: StreamMode) => (m === 'detail' ? 'detail' : 'motion');

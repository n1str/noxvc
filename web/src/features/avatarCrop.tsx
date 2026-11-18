// Кадрирование картинки/GIF/видео: рамка заданных пропорций поверх исходника.
// Рамка двигается перетаскиванием, меняет размер за углы, колесом мыши, ползунком и клавишами; вне рамки — затемнение.
//   Аватарка — квадрат со вписанным кружком (как в Discord), результат — квадрат до 512×512.
//   Баннер — 3:1; у GIF и видео сохраняется исходник + область кадра (обрезает CSS), а первый кадр уходит статичной картинкой.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';

// MIN_PX — минимальная ширина рамки на экране; вокруг картинки отступ 10px, чтобы угловые ручки не обрезались
const STAGE_W = 452, STAGE_H = 320, MIN_PX = 24;
type Box = { x: number; y: number; s: number }; // в пикселях исходника; s — ширина рамки, высота = s / aspect
type Corner = 'nw' | 'ne' | 'sw' | 'se';
export interface Crop { x: number; y: number; w: number; h: number } // доли исходника
export interface CropResult {
  /** Кадрированный первый кадр (WebP/PNG). */
  still: File;
  crop: Crop;
  /** Исходник анимированный (GIF или видео) — его надо сохранить целиком вместе с crop. */
  animated: boolean;
  source: File;
}
export interface MediaLimits { maxBytes: number; maxSide: number; maxVideoSec: number }

const isVideo = (f: File) => /^video\/(mp4|webm)$/.test(f.type) || /\.(mp4|webm)$/i.test(f.name);

async function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  let blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.9));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('canvas');
  return blob;
}

export function MediaCrop({ file, close, onDone, aspect, round, outW, title, hint, limits, asIs, previews }: {
  file: File; close(): void; onDone(r: CropResult): Promise<void>;
  aspect: number; round?: boolean; outW: number; title: string; hint: string; limits: MediaLimits;
  /** «Без обрезки» (аватарка): загрузить файл как есть. */
  asIs?: () => Promise<void>;
  /** Превью в реальных размерах (px и подпись): как будет выглядеть в чате, списке, поповере, профиле. */
  previews?: [number, string][];
}) {
  const { t } = useTranslation();
  const video = isVideo(file);
  const [src, setSrc] = useState<{ url: string; w: number; h: number } | null>(null);
  const [err, setErr] = useState('');
  const [box, setBox] = useState<Box>({ x: 0, y: 0, s: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ mode: 'move' | Corner; px: number; py: number; b: Box } | null>(null);
  const vref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (file.size > limits.maxBytes) { setErr(t('crop.tooBigMb', { n: Math.round(limits.maxBytes / 1048576) })); return; }
    const url = URL.createObjectURL(file);
    const ready = (w: number, h: number) => {
      if (!w || !h) { setErr(t('crop.bad')); return; }
      if (w > limits.maxSide || h > limits.maxSide) { setErr(t('crop.tooLarge', { n: limits.maxSide })); return; }
      const s = Math.min(w, h * aspect);
      setBox({ x: (w - s) / 2, y: (h - s / aspect) / 2, s });
      setSrc({ url, w, h });
    };
    if (video) {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'metadata';
      v.onloadedmetadata = () => {
        if (v.duration > limits.maxVideoSec + 0.5) { setErr(t('crop.tooLong', { n: limits.maxVideoSec })); return; }
        ready(v.videoWidth, v.videoHeight);
      };
      v.onerror = () => setErr(t('crop.bad'));
      v.src = url;
    } else {
      const i = new Image();
      i.onload = () => ready(i.naturalWidth, i.naturalHeight);
      i.onerror = () => setErr(t('crop.bad'));
      i.src = url;
    }
    return () => URL.revokeObjectURL(url);
  }, [file, t, video, aspect, limits]);

  const W = src?.w ?? 1, H = src?.h ?? 1;
  const k = Math.min(STAGE_W / W, STAGE_H / H); // экранных пикселей на пиксель исходника
  const maxS = Math.min(W, H * aspect), minS = Math.min(maxS, Math.max(MIN_PX / k, 16));
  const clamp = (b: Box): Box => {
    const s = Math.min(maxS, Math.max(minS, b.s));
    return { s, x: Math.min(W - s, Math.max(0, b.x)), y: Math.min(H - s / aspect, Math.max(0, b.y)) };
  };
  /** Новый размер с сохранением центра (колесо, ползунок, клавиши). */
  const resize = (s: number) => setBox((b) => clamp({ s, x: b.x + (b.s - s) / 2, y: b.y + (b.s - s) / aspect / 2 }));

  const down = (mode: 'move' | Corner) => (e: RPointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, b: box };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / k, dy = (e.clientY - d.py) / k, b = d.b;
    if (d.mode === 'move') { setBox(clamp({ ...b, x: b.x + dx, y: b.y + dy })); return; }
    // Угол: противоположный угол стоит на месте, пропорции сохраняются, рамка не выходит за исходник.
    const right = d.mode === 'ne' || d.mode === 'se', bottom = d.mode === 'sw' || d.mode === 'se';
    const bh = b.s / aspect;
    const ax = right ? b.x : b.x + b.s, ay = bottom ? b.y : b.y + bh; // опорный угол
    // Ведёт ось, по которой мышь сдвинулась сильнее (иначе при движении почти по горизонтали рамка «не слушается»).
    const gx = right ? dx : -dx, gy = (bottom ? dy : -dy) * aspect;
    const want = (Math.abs(gx) >= Math.abs(gy) ? gx : gy) + b.s;
    const room = Math.min(right ? W - ax : ax, (bottom ? H - ay : ay) * aspect);
    const s = Math.min(room, maxS, Math.max(minS, want));
    setBox({ s, x: right ? ax : ax - s, y: bottom ? ay : ay - s / aspect });
  };
  const up = () => { drag.current = null; };

  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 / k : 2 / k;
    const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (m[e.key]) { e.preventDefault(); setBox((b) => clamp({ ...b, x: b.x + m[e.key][0], y: b.y + m[e.key][1] })); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); resize(box.s * 0.92); }
    else if (e.key === '-') { e.preventDefault(); resize(box.s / 0.92); }
  };

  // Колесо: вверх — приблизить (рамка меньше). Нативный слушатель — чтобы preventDefault не прокручивал окно.
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); setBox((b) => { const s = b.s * (e.deltaY < 0 ? 0.92 : 1 / 0.92); return clamp({ s, x: b.x + (b.s - s) / 2, y: b.y + (b.s - s) / aspect / 2 }); }); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  /** Первый кадр исходника (у GIF drawImage берёт первый кадр, у видео — кадр на 0 с). */
  const firstFrame = async (): Promise<CanvasImageSource> => {
    if (!video) {
      const i = new Image();
      i.src = src!.url;
      await i.decode();
      return i;
    }
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = src!.url;
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error(t('crop.bad'))); });
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = 0.001; });
    return v;
  };

  const apply = async () => {
    if (!src) return;
    setBusy(true);
    try {
      const w = Math.min(outW, Math.max(Math.round(outW / 4), Math.round(box.s)));
      const h = Math.round(w / aspect);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(await firstFrame(), box.x, box.y, box.s, box.s / aspect, 0, 0, w, h);
      const blob = await toBlob(c);
      const animated = video || file.type === 'image/gif';
      await onDone({
        still: new File([blob], `still.${blob.type === 'image/webp' ? 'webp' : 'png'}`, { type: blob.type }),
        crop: { x: box.x / W, y: box.y / H, w: box.s / W, h: box.s / aspect / H },
        animated, source: file,
      });
      close();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const skip = async () => {
    if (!asIs) return;
    setBusy(true);
    try { await asIs(); close(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  const zoom = maxS ? Math.round((maxS / (box.s || maxS)) * 100) / 100 : 1;
  const sw = W * k, sh = H * k;
  const bx = box.x * k, by = box.y * k, bw = box.s * k, bh = (box.s / aspect) * k;
  // Затемнение вне кружка — маской с прозрачным кругом; вне прямоугольника — многоугольником с «дыркой».
  const R = bw / 2;
  const dimStyle = round
    ? { maskImage: `radial-gradient(circle ${R}px at ${bx + R}px ${by + R}px, transparent ${Math.max(0, R - 0.5)}px, #000 ${R + 0.5}px)` }
    : { clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${bx}px ${by}px, ${bx + bw}px ${by}px, ${bx + bw}px ${by + bh}px, ${bx}px ${by + bh}px, ${bx}px ${by}px)` };
  return (
    <div className="modal-body crop-modal">
      <h2>{title}</h2>
      <div className="crop-stage" ref={stage} style={{ height: STAGE_H + 20 }}>
        {src ? (
          <div className="crop-img" style={{ width: sw, height: sh }} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            {video ? <video ref={vref} src={src.url} autoPlay muted loop playsInline /> : <img src={src.url} alt="" draggable={false} />}
            <div className="crop-dim" style={{ ...dimStyle, WebkitMaskImage: dimStyle.maskImage }} />
            <div className={`crop-box ${round ? '' : 'rect'}`} role="slider" tabIndex={0} aria-label={t('crop.area')} aria-valuenow={zoom} aria-valuetext={`×${zoom}`}
              style={{ left: bx, top: by, width: bw, height: bh }}
              onPointerDown={down('move')} onKeyDown={key}>
              {round && <div className="crop-circle" />}
              {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => <span key={c} className={`crop-handle ${c}`} onPointerDown={down(c)} />)}
            </div>
          </div>
        ) : !err && <span className="muted">…</span>}
      </div>
      {src && previews && (() => {
        const c = { x: box.x / W, y: box.y / H, w: box.s / W, h: box.s / aspect / H };
        const st = { width: `${100 / c.w}%`, height: `${100 / c.h}%`, left: `${(-c.x / c.w) * 100}%`, top: `${(-c.y / c.h) * 100}%` };
        return (
          <div className="crop-previews" aria-label={t('crop.previews')}>
            {previews.map(([px, label]) => (
              <figure key={px} className="crop-prev">
                <div className={`crop-prev-media ${round ? 'round' : ''}`} style={{ width: px, height: Math.round(px / aspect) }}>
                  {video ? <video src={src.url} style={st} autoPlay muted loop playsInline /> : <img src={src.url} style={st} alt="" draggable={false} />}
                </div>
                <figcaption className="muted small">{label} · {px}</figcaption>
              </figure>
            ))}
          </div>
        );
      })()}
      {src && (
        <label className="crop-zoom">
          <span className="muted small">{t('crop.zoom')}</span>
          <input type="range" min={0} max={1000} value={maxS > minS ? Math.round(((maxS - box.s) / (maxS - minS)) * 1000) : 0}
            onChange={(e) => resize(maxS - (+e.target.value / 1000) * (maxS - minS))} aria-label={t('crop.zoom')} />
        </label>
      )}
      <p className="muted small">{hint}</p>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="modal-actions">
        <Button type="button" variant="ghost" onClick={close}>{t('modal.cancel')}</Button>
        {asIs && <Button type="button" variant="ghost" disabled={busy || !!err} onClick={skip}>{t('crop.asIs')}</Button>}
        <Button type="button" variant="primary" disabled={busy || !src} onClick={apply}>{t('crop.apply')}</Button>
      </div>
    </div>
  );
}

const AVATAR_LIMITS: MediaLimits = { maxBytes: 20 * 1048576, maxSide: 4096, maxVideoSec: 60 };

/** Аватар: квадрат со вписанным кружком, превью в реальных размерах; GIF/видео остаются анимированными (кадрирует сервер). */
export function AvatarCrop({ file, close, onDone }: { file: File; close(): void; onDone(r: CropResult): Promise<void> }) {
  const { t } = useTranslation();
  return (
    <MediaCrop file={file} close={close} aspect={1} round outW={512} title={t('crop.title')} limits={AVATAR_LIMITS}
      hint={t('crop.hintAvatar')} onDone={onDone}
      previews={[[40, t('crop.pChat')], [32, t('crop.pMembers')], [96, t('crop.pPopover')], [136, t('crop.pProfile')]]} />
  );
}

// Баннер профиля: картинка / GIF / видео с кадрированием 3:1, без него — градиент из цвета профиля.
// Анимация (GIF/видео) играет только там, где профиль открыт (поповер, полный профиль, живое превью), и не при
// «Уменьшить анимации» / prefers-reduced-motion — иначе статичный первый кадр.
// Акцент карточки — доминирующий цвет баннера (его считает клиент при загрузке), текст на акценте — по контрасту.
import type { CSSProperties } from 'react';
import { useAnimationAllowed } from '../lib/motion';

export interface Banner {
  url: string;
  /** Статичный первый кадр, уже кадрированный (у GIF/видео). */
  poster: string | null;
  kind: 'image' | 'gif' | 'video';
  /** Область кадра — доли исходника (у статичной картинки — целиком: она уже обрезана). */
  crop: { x: number; y: number; w: number; h: number };
  accent: string | null;
  width?: number; height?: number;
}

export const BANNER_ASPECT = 3;

export { useReducedMotion } from '../lib/motion';

/** Градиент из цвета профиля (без баннера). */
export const bannerGradient = (color: string) =>
  `linear-gradient(135deg, ${color} 0%, color-mix(in oklch, ${color} 70%, white) 45%, color-mix(in oklch, ${color} 55%, black) 100%)`;

export function ProfileBanner({ banner, color, animate, className = '' }: { banner?: Banner | null; color: string; animate?: boolean; className?: string }) {
  const allowed = useAnimationAllowed();
  const play = !!banner && banner.kind !== 'image' && !!animate && allowed;
  if (!banner) return <div className={`pbanner ${className}`} style={{ background: bannerGradient(color) }} />;
  // Анимация — исходник с кадрированием через CSS; статика — первый кадр (уже обрезанный), иначе сама картинка с кадрированием.
  const c = play || !banner.poster ? banner.crop : { x: 0, y: 0, w: 1, h: 1 };
  const style: CSSProperties = { width: `${100 / c.w}%`, height: `${100 / c.h}%`, left: `${(-c.x / c.w) * 100}%`, top: `${(-c.y / c.h) * 100}%` };
  return (
    <div className={`pbanner has-media ${className}`} style={{ background: banner.accent ?? color }} data-kind={banner.kind} data-playing={play || undefined}>
      {play && banner.kind === 'video'
        ? <video src={banner.url} style={style} autoPlay muted loop playsInline disablePictureInPicture aria-hidden />
        : <img src={play ? banner.url : banner.poster ?? banner.url} style={style} alt="" draggable={false} />}
    </div>
  );
}

// ---------- цвет ----------
const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const parse = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const lum = ([r, g, b]: [number, number, number]) => {
  const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Цвет текста на акценте: белый или почти чёрный — что контрастнее (WCAG). */
export function textOn(color: string): string {
  const c = parse(color);
  if (!c) return 'white';
  const l = lum(c);
  return contrast(l, 1) >= contrast(l, lum([17, 18, 20])) ? 'white' : '#111214';
}

/**
 * Акцент для элементов на тёмной карточке: слишком тёмный цвет осветляем, пока у него нет хотя бы 3:1
 * к фону карточки (иначе бордер и кнопка сливаются с фоном).
 */
export function readableAccent(color: string, bg: [number, number, number] = [30, 31, 34]): string {
  let c = parse(color);
  if (!c) return color;
  for (let i = 0; i < 12 && contrast(lum(c), lum(bg)) < 3; i++) c = c.map((x) => x + (255 - x) * 0.15) as [number, number, number];
  return `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
}

/** CSS-переменные акцента карточки профиля (или пусто — обычная карточка). */
export function accentVars(accent: string | null | undefined): CSSProperties {
  if (!accent || !parse(accent)) return {};
  const a = readableAccent(accent);
  return { '--card-accent': a, '--card-accent-text': textOn(a) } as CSSProperties;
}

/** Акцент карточки: доминирующий цвет баннера-картинки, иначе выбранный цвет баннера. */
/** Цвет достаточно насыщенный, чтобы быть акцентом (серый/белый/чёрный баннер даёт серую «рамку» и блёклую кнопку). */
export function vivid(color: string | null | undefined): boolean {
  const c = color ? parse(color) : null;
  if (!c) return false;
  const max = Math.max(...c), min = Math.min(...c);
  return max - min >= 48 && (max - min) / max >= 0.28;
}

/** Акцент карточки: доминирующий цвет баннера-картинки, иначе выбранный цвет баннера; блёклый — без акцента. */
export const cardAccent = (banner: Banner | null | undefined, bannerColor: string | null | undefined) => {
  const c = banner ? banner.accent : bannerColor;
  return vivid(c) ? c! : null;
};

/**
 * Доминирующий цвет картинки: уменьшаем до 48×16, группируем пиксели по цвету (по 4 бита на канал)
 * и берём самую «весомую» группу; насыщенные цвета весят больше серых, почти чёрные/белые — меньше.
 */
export function dominantColor(src: CanvasImageSource): string {
  const c = document.createElement('canvas');
  c.width = 48; c.height = 16;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, 48, 16);
  const d = g.getImageData(0, 0, 48, 16).data;
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
    const sat = max ? (max - min) / max : 0;
    const light = (max + min) / 510;
    const w = 0.15 + sat * (1 - Math.abs(light - 0.5) * 1.4);
    const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    e.w += w; e.r += r * w; e.g += gg * w; e.b += b * w;
    buckets.set(key, e);
  }
  let best: { w: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
  if (!best) return '#5865f2';
  return `#${hex(best.r / best.w)}${hex(best.g / best.w)}${hex(best.b / best.w)}`;
}

/** Доминирующий цвет файла-картинки (кадрированный первый кадр). */
export async function dominantOfFile(f: File): Promise<string> {
  const url = URL.createObjectURL(f);
  try {
    const i = new Image();
    i.src = url;
    await i.decode();
    return dominantColor(i);
  } finally { URL.revokeObjectURL(url); }
}

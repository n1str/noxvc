// Базовые компоненты дизайн-системы. Стили — styles/base.css (только токены).
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { useAnimationAllowed, useInView } from '../lib/motion';
import { motion } from 'motion/react';
import { spring } from '../design/tokens';
import type { User } from '../store';
import { onLevel } from '../features/vad';

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' }>(
  ({ variant = 'secondary', size = 'md', className = '', ...p }, ref) => <button ref={ref} className={`btn btn-${variant} btn-${size} ${className}`} {...p} />,
);

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; tone?: 'danger' }>(
  ({ label, active, tone, className = '', children, ...p }, ref) => (
    <button ref={ref} aria-label={label} title={label} aria-pressed={active} className={`icon-btn ${active ? 'is-active' : ''} ${tone ? `tone-${tone}` : ''} ${className}`} {...p}>
      {children}
    </button>
  ),
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string }>(
  ({ label, hint, className = '', ...p }, ref) => {
    const input = <input ref={ref} className={`input ${className}`} {...p} />;
    if (!label) return input;
    return (
      <label className="field">
        <span className="field-label">{label}</span>
        {input}
        {hint && <span className="field-hint">{hint}</span>}
      </label>
    );
  },
);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-label">{label}</span>
      {/* CSS-transform, не layout-анимация: иначе точка «летит» при любом сдвиге строки (поиск, перерисовка списка). */}
      <span className="switch-track"><span className="switch-thumb" /></span>
    </button>
  );
}

export type Tri = 'allow' | 'inherit' | 'deny';
/** Трёхпозиционный переключатель прав: запретить / наследовать / разрешить. */
export function TriSwitch({ value, onChange, labels }: { value: Tri; onChange: (v: Tri) => void; labels: Record<Tri, string> }) {
  return (
    <div className="tri" role="radiogroup">
      {(['deny', 'inherit', 'allow'] as Tri[]).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} aria-label={labels[v]} title={labels[v]} className={`tri-opt tri-${v} ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>
          {value === v && <motion.span className="tri-bg" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} />}
          <span className="tri-mark">{v === 'deny' ? '✕' : v === 'allow' ? '✓' : '/'}</span>
        </button>
      ))}
    </div>
  );
}

const initial = (name?: string) => [...(name ?? '?')][0]?.toUpperCase() ?? '?';

/** Размеры обработанного аватара на сервере (`/uploads/m/<key>/a{size}.webp`, у анимированных ещё `.anim.webp`). */
const AVATAR_SIZES = [32, 48, 96, 160, 256];
const PROCESSED = /^(\/uploads\/m\/[a-z0-9]+\/)a256\.webp$/;

/** URL аватара под размер на экране (с учётом плотности пикселей); старые аватары (до обработки) — как есть. */
export function avatarSrc(avatar: string, px: number, anim = false): string {
  const m = PROCESSED.exec(avatar);
  if (!m) return avatar;
  const need = px * Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const s = AVATAR_SIZES.find((x) => x >= need) ?? 256;
  return `${m[1]}a${s}${anim ? '.anim' : ''}.webp`;
}

/** Иконка сервера: картинка (размер под экран, анимация — если можно играть) или инициалы на градиенте, оттенок —
 *  постоянный для сервера (от id). */
export function GuildIcon({ guild, size = 48, play }: { guild: { id: number; name: string; icon?: string | null; icon_anim?: boolean }; size?: number; play?: boolean }) {
  const allowed = useAnimationAllowed();
  if (guild.icon) {
    const anim = !!(play && guild.icon_anim && allowed);
    return <span className="guild-icon has-img" style={{ width: size, height: size }} aria-hidden><img src={avatarSrc(guild.icon, size)} alt="" draggable={false} />{anim && <img className="avatar-anim" src={avatarSrc(guild.icon, size, true)} alt="" draggable={false} />}</span>;
  }
  const h = (guild.id * 137.508) % 360;
  const words = guild.name.trim().split(/\s+/).filter(Boolean);
  const ini = (words.length > 1 ? words.slice(0, 2).map((w) => [...w][0]).join('') : [...guild.name.trim()].slice(0, 2).join('')).toUpperCase() || '?';
  return (
    <span className="guild-icon" aria-hidden style={{ width: size, height: size, fontSize: Math.max(11, size * (ini.length > 1 ? 0.34 : 0.42)),
      background: `linear-gradient(135deg, oklch(0.62 0.15 ${h}), oklch(0.48 0.16 ${(h + 40) % 360}))` }}>{ini}</span>
  );
}

/** Инициалы — на градиенте из цвета профиля. */
const initialsBg = (c?: string) => (c ? `linear-gradient(135deg, color-mix(in oklch, ${c} 82%, white), ${c} 45%, color-mix(in oklch, ${c} 62%, black))` : 'var(--bg-elevated)');

/**
 * Аватар. play — можно проигрывать анимацию (открытый профиль, наведение на строку, человек говорит);
 * проигрывается, только если аватар анимированный, в видимой области, анимации включены (флаг, «уменьшить анимации»).
 * Статичный первый кадр лежит снизу, анимация поверх — без мигания при переключении.
 */
/** levelUid — кольцо говорящего по громкости этого участника голосового канала (иначе — только флаг speaking). */
export function Avatar({ user, size = 40, status, speaking, play, levelUid }: { user?: Partial<User> | null; size?: number; status?: boolean; speaking?: boolean; play?: boolean; levelUid?: number }) {
  const p = user?.presence ?? (user?.online ? 'online' : 'offline');
  const ref = useRef<HTMLSpanElement>(null);
  // громкость — стилем напрямую (до 60 раз в секунду), без перерисовок React
  useEffect(() => levelUid ? onLevel(levelUid, (v) => { const el = ref.current; if (!el) return; el.style.setProperty('--lvl', v.toFixed(2)); el.classList.toggle('lvl', v > 0.03); }) : undefined, [levelUid]);
  const allowed = useAnimationAllowed();
  const want = !!(play && user?.avatar_anim && user.avatar && allowed);
  const visible = useInView(ref, want);
  const anim = want && visible;
  // Индикатор статуса ~23% диаметра, обводка цветом фона вокруг (--ring), сидит на окружности под 45°.
  const dot = Math.max(10, Math.round(size * 0.23));
  const ring = Math.max(2, Math.round(size * 0.055));
  const off = Math.round(size * 0.146 - (dot + ring * 2) / 2);
  return (
    <span ref={ref} className={`avatar ${speaking ? 'speaking' : ''} ${user?.avatar ? 'has-img' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.42, background: user?.avatar ? 'transparent' : initialsBg(user?.color) }} aria-hidden>
      {user?.avatar ? <img src={avatarSrc(user.avatar, size)} alt="" draggable={false} /> : initial(user?.display_name)}
      {anim && <img className="avatar-anim" src={avatarSrc(user!.avatar!, size, true)} alt="" draggable={false} />}
      {status && <span className={`status-dot ${p === 'invisible' ? 'offline' : p}`} style={{ width: dot, height: dot, borderWidth: ring, right: off, bottom: off }} />}
    </span>
  );
}

export function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <motion.span className="badge" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}>
      {count > 99 ? '99+' : count}
    </motion.span>
  );
}

export function Skeleton({ w = '100%', h = 14, r = 6 }: { w?: number | string; h?: number; r?: number }) {
  return <span className="skeleton" style={{ width: w, height: h, borderRadius: r }} />;
}

export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

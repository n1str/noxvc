// TS-зеркало токенов движения (CSS-переменные — в styles/tokens.css).
import type { Transition } from 'motion/react';

export const duration = { fast: 0.12, base: 0.18, slow: 0.25 } as const;
export const ease = { out: [0.2, 0.8, 0.2, 1], inOut: [0.65, 0, 0.35, 1] } as const;

/** Пружина для перемещений (индикаторы, layout). */
export const spring: Transition = { type: 'spring', stiffness: 520, damping: 40, mass: 0.8 };
/** Появление: короткий tween с ease-out. */
export const appear: Transition = { duration: duration.base, ease: ease.out };

/** Оттенок акцента сервера: стабильный по id (пока у сервера нет своего цвета). */
export function accentHue(seed: number | null | undefined): number {
  if (seed == null) return 262;
  // Без красных и янтарных оттенков: они заняты смыслами danger/warning.
  const palette = [262, 285, 230, 200, 175, 150, 305, 245];
  return palette[Math.abs(seed) % palette.length];
}

// Когда можно проигрывать анимированные аватары/баннеры: флаг сервера, «уменьшить анимации», видимость, наведение.
import { useEffect, useState, type RefObject } from 'react';
import { useStore } from '../store';

const reducedNow = () =>
  document.documentElement.dataset.reducedMotion === 'true' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

/** «Уменьшить анимации» в настройках или системная настройка. */
export function useReducedMotion() {
  const [r, setR] = useState(reducedNow);
  useEffect(() => {
    const upd = () => setR(reducedNow());
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    mq?.addEventListener('change', upd);
    const mo = new MutationObserver(upd);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });
    return () => { mq?.removeEventListener('change', upd); mo.disconnect(); };
  }, []);
  return r;
}

/** Анимированные аватары и баннеры включены на сервере (RELAY_ANIMATED_PROFILES) и не выключены «уменьшить анимации». */
export function useAnimationAllowed() {
  const flag = useStore((s) => s.me?.features?.animated_profiles !== false);
  return flag && !useReducedMotion();
}

/** Элемент в видимой области (только пока enabled — без наблюдателя для статичных аватаров). */
export function useInView(ref: RefObject<Element | null>, enabled: boolean) {
  const [v, setV] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver !== 'function') { setV(false); return; }
    const io = new IntersectionObserver(([e]) => setV(e.isIntersecting), { threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled]);
  return v;
}

/** Наведение на строку (сообщение, участник): [наведено, обработчики для строки]. */
export function useHover() {
  const [h, setH] = useState(false);
  return [h, { onMouseEnter: () => setH(true), onMouseLeave: () => setH(false) }] as const;
}

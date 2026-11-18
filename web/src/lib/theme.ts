// Тема: тёмная (по умолчанию) / светлая / как в системе. Значения цветов — в styles/tokens.css
// (:root — тёмная, :root[data-theme='light'] — светлая); здесь только выбор и применение.
// - До первой отрисовки тему ставит скрипт в index.html (из localStorage) — без вспышки неправильной темы;
//   в приложении ещё раньше — скрипт инициализации окна и цвет фона окна (desktop: set_theme).
// - «Как в системе» следует за системой на лету (prefers-color-scheme), без перезапуска.
// - Выбор хранится в аккаунте (users.settings.theme — общий для устройств) и локально.
import { localSetting, saveSetting, watchSetting } from './accountSettings';
import { dinvoke, isDesktop } from './desktop';

export type ThemePref = 'dark' | 'light' | 'system';
const valid = (v: unknown): v is ThemePref => v === 'dark' || v === 'light' || v === 'system';
const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: light)') : null;

let pref: ThemePref = (() => { const v = localSetting<ThemePref>('theme'); return valid(v) ? v : 'dark'; })();
const listeners = new Set<(p: ThemePref) => void>();

export const themePref = () => pref;
export const resolved = (p: ThemePref = pref): 'dark' | 'light' => (p === 'system' ? (mq?.matches ? 'light' : 'dark') : p);

function apply() {
  const t = resolved();
  const root = document.documentElement;
  if (root.dataset.theme !== t) root.dataset.theme = t;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', t);
  // приложение: цвет фона окна и тема при следующем запуске (до загрузки страницы)
  if (isDesktop) dinvoke('set_theme', { dark: t === 'dark' });
}

export function setTheme(p: ThemePref) {
  pref = p;
  apply();
  saveSetting('theme', p);
  listeners.forEach((f) => f(p));
}
export function onTheme(f: (p: ThemePref) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

let started = false;
/** Запуск: применить, следить за системой и за выбором в аккаунте. */
export function startTheme() {
  if (started) return;
  started = true;
  apply();
  mq?.addEventListener('change', () => { if (pref === 'system') { apply(); listeners.forEach((f) => f(pref)); } });
  watchSetting<ThemePref>('theme', (v) => { if (valid(v) && v !== pref) { pref = v; apply(); listeners.forEach((f) => f(v)); } }, () => pref);
}

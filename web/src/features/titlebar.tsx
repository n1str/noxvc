// Свой заголовок окна Relay Desktop (окно без системной рамки), как в Discord.
// Показывается только в приложении, где окно действительно без рамки; в браузере и в старых версиях
// приложения (с системным заголовком) — не показывается.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dinvoke, dlisten, isDesktop } from '../lib/desktop';
import { dmName, useStore } from '../store';
import { Mark } from '../ui/Logo';

interface TauriWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isDecorated(): Promise<boolean>;
  onResized(cb: () => void): Promise<() => void>;
}
const win = (): TauriWindow | null => {
  const w = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } }).__TAURI__?.window;
  return isDesktop && w?.getCurrentWindow ? w.getCurrentWindow() : null;
};

/** Окно без системной рамки → рисуем свой заголовок. Ошибка (нет прав в старом приложении) — считаем, что рамка есть. */
export function useCustomTitlebar() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const w = win();
    if (!w) return;
    w.isDecorated().then((d) => setOn(!d)).catch(() => {});
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('has-titlebar', on);
  }, [on]);
  return on;
}

/** Название текущего сервера или личной переписки — по центру заголовка. */
function useWindowTitle() {
  return useStore((s) => {
    if (!s.me) return '';
    if (s.view === 'home') { const d = s.dms.find((x) => x.id === s.channelId); return d ? dmName(d) : ''; }
    return s.guild?.name ?? s.guilds.find((g) => g.id === s.view)?.name ?? '';
  });
}

/** Значки кнопок — тонкие линии 10×10, как у системных кнопок Windows. */
const Glyph = ({ d }: { d: string }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges" /></svg>
);
const MIN = 'M0 5.5h10';
const MAX = 'M0.5 0.5h9v9h-9z';
const RESTORE = 'M2.5 2.5h7v7h-7zM2.5 2.5v-2h7.5v7.5h-2';
const CLOSE = 'M0.5 0.5l9 9M9.5 0.5l-9 9';

/** Задержка перед меню Snap Layouts — как у системной кнопки. */
const SNAP_DELAY = 500;

export function TitleBar() {
  const { t } = useTranslation();
  const title = useWindowTitle();
  const [max, setMax] = useState(false);
  const [focused, setFocused] = useState(true);
  const snap = useRef<number | undefined>(undefined);

  useEffect(() => {
    const w = win();
    if (!w) return;
    // Событие размера приходит раньше, чем окно меняет состояние «развёрнуто», — перепроверяем и чуть позже.
    let later: number | undefined;
    const check = () => { w.isMaximized().then(setMax).catch(() => {}); };
    const sync = () => { check(); window.clearTimeout(later); later = window.setTimeout(check, 150); };
    sync();
    const offs = [w.onResized(sync)];
    return () => { window.clearTimeout(later); offs.forEach((p) => p.then((f) => f()).catch(() => {})); };
  }, []);
  // Активность окна — от приложения (активное окно Windows): фокус Tauri после клика внутрь окна уходит в WebView
  // и для этого не годится, а WebView2 не всегда сообщает странице, что окно стало неактивным.
  useEffect(() => {
    let dead = false;
    const off = dlisten<boolean>('window-active', (a) => setFocused(a));
    void dinvoke<boolean>('window_active').then((a) => { if (!dead && a != null) setFocused(a); });
    return () => { dead = true; off(); };
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('win-maximized', max); }, [max]);
  useEffect(() => () => window.clearTimeout(snap.current), []);

  const snapOn = () => { window.clearTimeout(snap.current); snap.current = window.setTimeout(() => { void dinvoke('snap_layout'); }, SNAP_DELAY); };
  const snapOff = () => window.clearTimeout(snap.current);

  return (
    <header className={`titlebar ${focused ? '' : 'blurred'}`} data-tauri-drag-region="deep" onContextMenu={(e) => e.preventDefault()}>
      <div className="tb-brand">
        <Mark className="tb-logo" size={16} />
        <span>NoxVC</span>
      </div>
      <div className="tb-title" title={title}>{title}</div>
      <div className="tb-buttons" data-tauri-drag-region="false">
        <button type="button" className="tb-btn" aria-label={t('app.minimize')} title={t('app.minimize')} tabIndex={-1} onClick={() => void win()?.minimize()}><Glyph d={MIN} /></button>
        <button type="button" className="tb-btn" aria-label={max ? t('app.restore') : t('app.maximize')} tabIndex={-1}
          onClick={() => { snapOff(); void win()?.toggleMaximize(); }} onMouseEnter={snapOn} onMouseLeave={snapOff} onMouseDown={snapOff}>
          <Glyph d={max ? RESTORE : MAX} />
        </button>
        <button type="button" className="tb-btn tb-close" aria-label={t('app.close')} title={t('app.close')} tabIndex={-1} onClick={() => void win()?.close()}><Glyph d={CLOSE} /></button>
      </div>
    </header>
  );
}

// Горячие клавиши голоса и трансляции: микрофон, звук, рация, трансляция, звук трансляции, отключиться.
// - Веб: только пока вкладка Relay активна (браузер не даёт слушать клавиши вне страницы).
// - Приложение: глобальные — работают поверх игр и полноэкранных окон (Raw Input в приложении, клавиши не перехватываются;
//   приложение присылает только «действие нажато/отпущено»). Когда окно Relay в фокусе — обрабатывает страница.
// Сочетание — строка «Ctrl+Shift+KeyM» (код — KeyboardEvent.code), кнопки мыши — «Mouse4»/«Mouse5».
// Хранятся в аккаунте (общие для устройств) и локально.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { RotateCcw, X } from 'lucide-react';
import { Button, IconButton } from '../ui';
import { dcall, dinvoke, dlisten, isDesktop } from '../lib/desktop';
import { localSetting, saveSetting, watchSetting } from '../lib/accountSettings';
import i18n from '../i18n';

export type Action = 'mute' | 'deafen' | 'ptt' | 'stream' | 'streamAudio' | 'disconnect' | 'feedback';
export const ACTIONS: Action[] = ['mute', 'deafen', 'ptt', 'stream', 'streamAudio', 'disconnect', 'feedback'];
/** Только в окне Relay (не глобально). */
const PAGE_ONLY: Action[] = ['feedback'];
export type Binds = Record<Action, string>;
export const DEFAULT_BINDS: Binds = { mute: 'Ctrl+Shift+KeyM', deafen: 'Ctrl+Shift+KeyD', ptt: 'KeyV', stream: '', streamAudio: '', disconnect: '', feedback: 'Ctrl+Shift+KeyH' };

// Сочетания, занятые браузером или самим Relay: назначить можно, но предупреждаем.
const RESERVED = new Set(['Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyX', 'Ctrl+KeyA', 'Ctrl+KeyZ', 'Ctrl+KeyY', 'Ctrl+KeyF', 'Ctrl+KeyR', 'Ctrl+KeyW', 'Ctrl+KeyT',
  'Ctrl+KeyN', 'Ctrl+KeyP', 'Ctrl+KeyS', 'Ctrl+KeyL', 'Ctrl+Shift+KeyI', 'Ctrl+Shift+KeyJ', 'Ctrl+Shift+KeyT', 'Ctrl+Shift+KeyN', 'Ctrl+Tab', 'Alt+F4', 'F5', 'F11', 'F12', 'Escape', 'Enter', 'Tab']);

/** Что делать по действию (задаёт voice.tsx — без циклического импорта). */
export interface Handlers { run(a: Exclude<Action, 'ptt'>): void; ptt(down: boolean): void; pttActive(): boolean }
let handlers: Handlers | null = null;
export function setHotkeyHandlers(h: Handlers) { handlers = h; }

// ---------- состояние ----------
const migrate = (): Binds => {
  // прежняя клавиша рации (настройки голоса до горячих клавиш)
  try { const v = JSON.parse(localStorage.getItem('relay_voice') || '{}'); if (typeof v.pttKey === 'string') return { ...DEFAULT_BINDS, ptt: v.pttKey }; } catch { /* нет */ }
  return DEFAULT_BINDS;
};
const clean = (b: Partial<Binds> | undefined): Binds => {
  const out = { ...DEFAULT_BINDS };
  for (const a of ACTIONS) if (typeof b?.[a] === 'string' && b[a]!.length <= 40) out[a] = b[a]!;
  return out;
};
export const useHotkeys = create<{ binds: Binds; globalOk: boolean | null }>(() => ({ binds: clean(localSetting<Binds>('hotkeys') ?? migrate()), globalOk: null }));

export function setBind(a: Action, combo: string) {
  const binds = { ...useHotkeys.getState().binds, [a]: combo };
  useHotkeys.setState({ binds }); saveSetting('hotkeys', binds); syncGlobal();
}
export function resetBinds() { useHotkeys.setState({ binds: { ...DEFAULT_BINDS } }); saveSetting('hotkeys', DEFAULT_BINDS); syncGlobal(); }

// ---------- сочетания ----------
const MODS = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
export function comboOf(e: KeyboardEvent): string {
  const isMod = MODS.includes(e.code);
  const m = [!isMod && e.ctrlKey && 'Ctrl', !isMod && e.shiftKey && 'Shift', !isMod && e.altKey && 'Alt', !isMod && e.metaKey && 'Meta'].filter(Boolean);
  return [...m, e.code].join('+');
}
const mouseCode = (b: number) => (b === 3 ? 'Mouse4' : b === 4 ? 'Mouse5' : null);
const KEY_NAMES: Record<string, string> = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
  ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Win', MetaRight: 'Right Win',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
/** Для людей: «Ctrl+Shift+M», «Мышь 4». */
export function comboLabel(c: string): string {
  if (!c) return '';
  return c.split('+').map((p) => p === 'Mouse4' || p === 'Mouse5' ? i18n.t('hk.mouse', { n: p.slice(5) }) : KEY_NAMES[p] ?? p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')).join('+');
}

// ---------- глобальные (приложение) ----------
/** Передать приложению привязки. Рация — только в режиме «Рация». Старое приложение — только рация. */
export function syncGlobal() {
  if (!isDesktop || !handlers) return;
  const { binds } = useHotkeys.getState();
  const list = ACTIONS.filter((a) => binds[a] && !PAGE_ONLY.includes(a) && (a !== 'ptt' || handlers!.pttActive())).map((a) => ({ action: a, combo: binds[a] }));
  dcall('hotkeys_set', { binds: list }).then(() => useHotkeys.setState({ globalOk: true }))
    .catch(() => { useHotkeys.setState({ globalOk: false }); dinvoke('ptt_set_key', { code: handlers!.pttActive() ? binds.ptt : '' }); });
}

// ---------- срабатывание ----------
function fire(a: Action, down: boolean) {
  if (!handlers) return;
  if (a === 'ptt') { if (handlers.pttActive()) handlers.ptt(down); return; }
  if (!down) return;
  if (a === 'feedback') { window.dispatchEvent(new Event('relay:feedback')); return; }
  handlers.run(a);
}

/** Слушатели: в странице — клавиатура и кнопки мыши; от приложения — глобальные (когда окно не в фокусе). */
export function useHotkeysWiring() {
  useEffect(() => {
    const typing = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
    const find = (combo: string) => ACTIONS.find((a) => useHotkeys.getState().binds[a] === combo);
    const held = new Set<Action>();
    const keydown = (e: KeyboardEvent) => {
      if (capturing || e.repeat) { if (e.repeat && find(comboOf(e))) e.preventDefault(); return; }
      const combo = comboOf(e), a = find(combo);
      if (!a) return;
      // без Ctrl/Alt/Win — это набор текста в поле ввода, не сочетание
      if (typing(e) && !/^(Ctrl|Alt|Meta)\+/.test(combo)) return;
      if (a === 'ptt' && !handlers?.pttActive()) return;
      e.preventDefault();
      held.add(a); fire(a, true);
    };
    const keyup = (e: KeyboardEvent) => {
      // отпускание — по коду клавиши (модификаторы к этому моменту могли отпустить раньше)
      for (const a of [...held]) {
        const c = useHotkeys.getState().binds[a];
        if (c.split('+').pop() === e.code) { held.delete(a); fire(a, false); }
      }
    };
    const mdown = (e: MouseEvent) => {
      const code = mouseCode(e.button); if (!code || capturing) return;
      const a = find(code); if (!a || (a === 'ptt' && !handlers?.pttActive())) return;
      e.preventDefault(); held.add(a); fire(a, true);
    };
    const mup = (e: MouseEvent) => {
      const code = mouseCode(e.button); if (!code) return;
      // кнопки «назад/вперёд» мыши не должны листать историю страницы, если назначены
      if (ACTIONS.some((a) => useHotkeys.getState().binds[a] === code)) e.preventDefault();
      for (const a of [...held]) if (useHotkeys.getState().binds[a] === code) { held.delete(a); fire(a, false); }
    };
    // ушли со страницы с зажатой рацией (веб) — отпускаем, иначе микрофон «залипнет»
    const blur = () => { if (!isDesktop) for (const a of [...held]) { held.delete(a); fire(a, false); } };
    // глобальные: окно Relay в фокусе — нажатие уже обработала страница; отпускание того, что нажали вне фокуса, — всегда
    const gHeld = new Set<Action>();
    const offGlobal = dlisten<{ action: Action; down: boolean; focused?: boolean }>('hotkey', (e) => {
      // focused — от приложения (в WebView2 document.hasFocus() врёт, когда окно в фоне); старое приложение его не шлёт
      const focused = e.focused ?? document.hasFocus();
      if (e.down) { if (focused) return; gHeld.add(e.action); fire(e.action, true); }
      else if (gHeld.delete(e.action)) fire(e.action, false);
      // нажали в окне Relay, отпустили, когда фокус ушёл (в игру), — keyup странице не придёт, хук приложения его видит
      else if (held.delete(e.action)) fire(e.action, false);
    });
    document.addEventListener('keydown', keydown);
    document.addEventListener('keyup', keyup);
    document.addEventListener('mousedown', mdown);
    document.addEventListener('mouseup', mup);
    window.addEventListener('blur', blur);
    // привязки из аккаунта (вход, изменение на другом устройстве)
    const offAcc = watchSetting<Partial<Binds>>('hotkeys', (v) => { useHotkeys.setState({ binds: clean(v) }); syncGlobal(); }, () => useHotkeys.getState().binds);
    syncGlobal();
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('keyup', keyup);
      document.removeEventListener('mousedown', mdown);
      document.removeEventListener('mouseup', mup);
      window.removeEventListener('blur', blur);
      offGlobal(); offAcc();
    };
  }, []);
}

// ---------- интерфейс привязки ----------
let capturing = false;
/** Кнопка «нажмите сочетание»: клавиатура (с модификаторами), один модификатор, кнопки мыши 4/5. Esc — отмена. */
export function KeybindButton({ action, onConflict }: { action: Action; onConflict?(other: Action, combo: string): void }) {
  const { t } = useTranslation();
  const combo = useHotkeys((s) => s.binds[action]);
  const [grab, setGrab] = useState(false);
  const pendingMod = useRef<string | null>(null);
  useEffect(() => {
    if (!grab) return;
    capturing = true;
    const done = (c: string | null) => {
      setGrab(false);
      if (!c) return;
      const other = ACTIONS.find((a) => a !== action && useHotkeys.getState().binds[a] === c);
      if (other) { onConflict?.(other, c); return; }
      setBind(action, c);
    };
    const kd = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') return done(null);
      if (MODS.includes(e.code)) { pendingMod.current = e.code; return; } // ждём клавишу или отпускание модификатора
      pendingMod.current = null;
      done(comboOf(e));
    };
    const ku = (e: KeyboardEvent) => { if (pendingMod.current === e.code) { e.preventDefault(); done(e.code); } }; // сочетание из одного модификатора
    const md = (e: MouseEvent) => { const c = mouseCode(e.button); if (c) { e.preventDefault(); e.stopPropagation(); done(c); } };
    const mu = (e: MouseEvent) => { if (mouseCode(e.button)) e.preventDefault(); };
    window.addEventListener('keydown', kd, true); window.addEventListener('keyup', ku, true);
    window.addEventListener('mousedown', md, true); window.addEventListener('mouseup', mu, true);
    return () => {
      capturing = false; pendingMod.current = null;
      window.removeEventListener('keydown', kd, true); window.removeEventListener('keyup', ku, true);
      window.removeEventListener('mousedown', md, true); window.removeEventListener('mouseup', mu, true);
    };
  }, [grab]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="keybind">
      <button type="button" className={`keybind-btn ${grab ? 'grab' : ''} ${combo ? '' : 'empty'}`} onClick={() => setGrab(!grab)} aria-label={`${t('hk.' + action)}: ${combo ? comboLabel(combo) : t('hk.none')}`}>
        {grab ? t('hk.press') : combo ? <kbd>{comboLabel(combo)}</kbd> : t('hk.none')}
      </button>
      {combo && !grab && <IconButton label={t('hk.clear')} onClick={() => setBind(action, '')}><X size={14} /></IconButton>}
    </span>
  );
}

/** Вкладка настроек «Горячие клавиши». */
export function HotkeysTab() {
  const { t } = useTranslation();
  const binds = useHotkeys((s) => s.binds);
  const globalOk = useHotkeys((s) => s.globalOk);
  const [conflict, setConflict] = useState<{ action: Action; other: Action; combo: string } | null>(null);
  return (
    <div className="us-section hotkeys">
      <p className="muted small">{isDesktop ? t('hk.desktopHint') : t('hk.webHint')}</p>
      {isDesktop && globalOk === false && <p className="small warn-text">{t('hk.oldApp')}</p>}
      <div className="hotkey-list">
        {ACTIONS.map((a) => (
          <div key={a} className="hotkey-row">
            <span className="hotkey-name">{t('hk.' + a)}{a === 'ptt' && <span className="muted small"> — {t('hk.pttHint')}</span>}</span>
            <KeybindButton action={a} onConflict={(other, combo) => setConflict({ action: a, other, combo })} />
            {binds[a] && RESERVED.has(binds[a]) && <span className="small warn-text hotkey-warn">{t('hk.reserved')}</span>}
          </div>
        ))}
      </div>
      {conflict && (
        <div className="hotkey-conflict" role="alert">
          <span>{t('hk.conflict', { combo: comboLabel(conflict.combo), other: t('hk.' + conflict.other) })}</span>
          <Button variant="primary" onClick={() => { setBind(conflict.other, ''); setBind(conflict.action, conflict.combo); setConflict(null); }}>{t('hk.replace')}</Button>
          <Button variant="ghost" onClick={() => setConflict(null)}>{t('modal.cancel')}</Button>
        </div>
      )}
      <Button variant="ghost" onClick={() => { resetBinds(); setConflict(null); }}><RotateCcw size={14} /> {t('hk.reset')}</Button>
    </div>
  );
}

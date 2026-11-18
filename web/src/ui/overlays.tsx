// Модалки, поповеры/контекстные меню, тосты. Всё раскрывается от точки клика (scale + fade).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { appear } from '../design/tokens';
import { useStore } from '../store';

// ---------- модалки ----------
type ModalRender = (close: () => void) => ReactNode;
type ModalOpts = { wide?: boolean };
const ModalCtx = createContext<{ open(r: ModalRender, o?: ModalOpts): void; close(): void }>({ open() {}, close() {} });
export const useModal = () => useContext(ModalCtx);

export function ModalHost({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<{ id: number; render: ModalRender; wide?: boolean }[]>([]);
  const close = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const open = useCallback((render: ModalRender, o?: ModalOpts) => setStack((s) => [...s, { id: Date.now() + Math.random(), render, wide: o?.wide }]), []);
  // Закрыть все модалки (например, при входе в «посмотреть как роль»).
  useEffect(() => {
    const all = () => setStack([]);
    window.addEventListener('relay:close-modals', all);
    return () => window.removeEventListener('relay:close-modals', all);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack.length) { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stack.length, close]);
  return (
    <ModalCtx.Provider value={{ open, close }}>
      {children}
      {createPortal(
        <AnimatePresence>
          {stack.map((m) => (
            <motion.div key={m.id} className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={appear}
              onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
              <motion.div role="dialog" aria-modal className={`modal ${m.wide ? 'wide' : ''}`} initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }} transition={appear}>
                {m.render(close)}
              </motion.div>
            </motion.div>
          ))}
        </AnimatePresence>,
        document.body,
      )}
    </ModalCtx.Provider>
  );
}

// ---------- поповер / контекстное меню ----------
export interface MenuItem { label: string; onSelect(): void; danger?: boolean; icon?: ReactNode }
type Anchor = { x: number; y: number } | DOMRect;
const PopCtx = createContext<{ show(a: Anchor, content: ReactNode): void; hide(): void }>({ show() {}, hide() {} });
export const usePopover = () => useContext(PopCtx);

export function PopoverHost({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ anchor: Anchor; content: ReactNode; key: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, origin: 'top left' });
  const hide = useCallback(() => setState(null), []);
  const show = useCallback((anchor: Anchor, content: ReactNode) => setState({ anchor, content, key: Date.now() }), []);
  useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const a = state.anchor;
    const r = 'width' in a ? a : { left: a.x, right: a.x, top: a.y, bottom: a.y };
    const w = ref.current.offsetWidth, h = ref.current.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const flipUp = r.bottom + 4 + h > innerHeight - 8;
    const top = flipUp ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    setPos({ left, top, origin: `${flipUp ? 'bottom' : 'top'} ${left < r.left - 20 ? 'right' : 'left'}` });
  }, [state]);
  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) hide(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [state, hide]);
  return (
    <PopCtx.Provider value={{ show, hide }}>
      {children}
      {createPortal(
        <AnimatePresence>
          {state && (
            <motion.div key={state.key} ref={ref} className="popover" style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97, pointerEvents: 'none' }} transition={{ duration: 0.12 }}>
              {state.content}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </PopCtx.Provider>
  );
}

export function Menu({ items, onDone }: { items: MenuItem[]; onDone(): void }) {
  return (
    <div role="menu" className="menu">
      {items.map((it, i) => (
        <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} onClick={() => { onDone(); it.onSelect(); }}>
          {it.icon}<span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- тосты ----------
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return createPortal(
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} layout className={`toast ${t.error ? 'error' : ''}`} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24 }} transition={appear}>
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

// Мост к Relay Desktop (Tauri). В браузере — пустышки: isDesktop = false, вызовы ничего не делают.
interface TauriGlobal {
  core: { invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(ev: string, cb: (e: { payload: T }) => void): Promise<() => void> };
}
const T = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

export const isDesktop = !!T?.core;

/** Вызов команды приложения; ошибки (нет прав, старое приложение) — null, не исключение. */
export function dinvoke<R = unknown>(cmd: string, args?: Record<string, unknown>): Promise<R | null> {
  if (!T) return Promise.resolve(null);
  return T.core.invoke<R>(cmd, args).catch(() => null);
}

export function dlisten<P>(ev: string, cb: (p: P) => void): () => void {
  if (!T) return () => {};
  let off: (() => void) | null = null, dead = false;
  T.event.listen<P>(ev, (e) => cb(e.payload)).then((f) => { if (dead) f(); else off = f; }).catch(() => {});
  return () => { dead = true; off?.(); };
}

export interface AppInfo { version: string; fingerprint: string; pinned: boolean; desktop: boolean }

/** Вызов команды с ошибкой (для действий, где пользователю нужно увидеть причину). */
export function dcall<R = unknown>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  if (!T) return Promise.reject(new Error('Только в приложении NoxVC'));
  return T.core.invoke<R>(cmd, args).catch((e) => { throw new Error(String(e)); });
}

/** Источник нативной демонстрации экрана (окно или экран) с миниатюрой. */
export interface ScreenSource { id: string; kind: 'window' | 'screen'; title: string; app: string; thumb: string | null; width: number; height: number }

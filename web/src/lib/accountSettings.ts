// Настройки аккаунта (users.settings на сервере): общие для всех устройств пользователя и хранятся локально —
// интерфейс применяет их до ответа сервера и без сети. Ключи — whitelist сервера: hotkeys, voice, theme.
// Источник правды — сервер: пришли настройки аккаунта (вход, settings_update с другого устройства) — применяем;
// у аккаунта ключа ещё нет — переносим туда локальные (первый запуск после обновления).
import { api } from './api';
import { useStore } from '../store';

type Key = 'hotkeys' | 'voice' | 'theme';
const LS = (k: Key) => `relay_acc_${k}`;

export function localSetting<T>(key: Key): T | undefined {
  try { const v = localStorage.getItem(LS(key)); return v == null ? undefined : (JSON.parse(v) as T); } catch { return undefined; }
}

const timers: Partial<Record<Key, ReturnType<typeof setTimeout>>> = {};
const lastSent: Partial<Record<Key, string>> = {};
/** Сохранить: сразу локально, на сервер — с задержкой 400 мс (ползунки, набор сочетаний). */
export function saveSetting<T>(key: Key, v: T) {
  const s = JSON.stringify(v);
  try { localStorage.setItem(LS(key), s); } catch { /* приватный режим */ }
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    if (!useStore.getState().me || lastSent[key] === s) return;
    lastSent[key] = s;
    api('PATCH', '/me/settings', { [key]: v }).catch(() => { lastSent[key] = undefined; });
  }, 400);
}

/** Следить за настройкой аккаунта: apply — при входе и при изменении на другом устройстве. Возвращает отписку. */
export function watchSetting<T>(key: Key, apply: (v: T) => void, current: () => T) {
  let seen: unknown = undefined;
  const check = () => {
    const me = useStore.getState().me;
    if (!me) return;
    const v = me.settings?.[key];
    if (v === seen) return;
    seen = v;
    if (v === undefined) { saveSetting(key, current()); return; } // у аккаунта ещё нет — переносим локальные
    const s = JSON.stringify(v);
    lastSent[key] = s;
    try { localStorage.setItem(LS(key), s); } catch { /* приватный режим */ }
    apply(v as T);
  };
  check();
  return useStore.subscribe(check);
}

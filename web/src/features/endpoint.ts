// Точка входа в Relay Desktop (несколько регионов: Россия, Нидерланды, …).
// Приложение само выбирает доступную точку входа и при её отказе переходит на другую. У каждой точки входа свой
// origin — свой localStorage, поэтому вход (токен) хранит приложение и отдаёт странице новой точки входа;
// при переходе во время разговора страница возвращается в тот же голосовой канал.
import { dinvoke, isDesktop } from '../lib/desktop';
import { useStore } from '../store';
import { joinVoice, useVoice } from './voice';

interface Resume { view?: number | 'home' | null; voice?: number | null }
interface Session { token: string | null; resume?: Resume | null }

let resume: Resume | null = null;

/** До первой отрисовки: вход, сохранённый приложением (если на этой точке входа его ещё нет). */
export async function restoreSession() {
  if (!isDesktop) return;
  const s = await dinvoke<Session>('session_get');
  if (!s) return;
  resume = s.resume ?? null;
  if (s.token && !useStore.getState().token) {
    try {
      localStorage.setItem('relay_token', JSON.stringify(s.token));
      if (resume?.view != null) localStorage.setItem('relay_view', JSON.stringify(resume.view));
    } catch { /* приватный режим */ }
    useStore.setState({ token: s.token });
  }
}

/** Связь с сервером потеряна надолго — попросить приложение проверить точки входа и при необходимости перейти. */
const FAILOVER_AFTER = 25_000;
export function watchFailover() {
  if (!isDesktop) return;
  let since: number | null = null;
  setInterval(() => {
    const s = useStore.getState();
    if (!s.token || (s.me && s.connection === 'online')) { since = null; return; }
    since ??= Date.now();
    if (Date.now() - since < FAILOVER_AFTER) return;
    since = Date.now(); // следующая попытка — не раньше чем через тот же интервал
    const v = useVoice.getState();
    dinvoke('endpoint_failover', { resume: { view: s.view, voice: v.channelId != null && v.guildId != null ? v.channelId : null } });
  }, 5_000);
  // Вернуться в голосовой канал после перехода на другую точку входа.
  if (resume?.voice != null) {
    const want = resume.voice;
    resume = null;
    const off = useStore.subscribe((s) => {
      const ch = s.guild?.channels.find((c) => c.id === want);
      if (!ch) return;
      off();
      joinVoice(ch);
    });
    setTimeout(off, 30_000);
  }
}

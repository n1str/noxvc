// Игровая активность: десктоп находит игру (Rust: реестр Steam, процессы, Dota GSI) и присылает событие
// `game-activity` — только найденную игру. Отсюда она уходит на сервер (PUT /api/me/game).
// В браузере ничего не делает: определять игры может только приложение.
import { api } from './api';
import { dinvoke, dlisten, isDesktop } from './desktop';
import { useStore } from '../store';

export interface GameActivity {
  type: 'playing'; game_id: string; name: string; icon_url: string | null; started_at: number; details?: string | null; state?: string | null;
}
/** Что нашёл десктоп (key — для «скрыть игру»). */
export interface DetectedGame {
  key: string; source: 'steam' | 'detected' | 'custom'; steam_appid: number | null; game_id: number | null;
  name: string; started_at: number; details: string | null; state: string | null;
}
export interface CustomGame { exe: string; path: string | null; name: string }
export interface GamesView { show_activity: boolean; hidden: string[]; custom: CustomGame[]; dota_gsi: boolean; gsi_running: boolean; current: DetectedGame | null }
export interface RunningApp { exe: string; path: string; title: string }

let detected: DetectedGame | null = null;
let lastSent: string | null = null;
let lastAt = 0;
let timer: number | undefined;
let started = false;
/** Сервер принимает не чаще раза в 2 с; десктоп и так шлёт смену игры сразу, детали — раз в 20 с. */
const MIN_GAP = 2100;

const body = (d: DetectedGame | null) => d && {
  source: d.source, steam_appid: d.steam_appid, game_id: d.game_id, name: d.name, started_at: d.started_at,
  details: d.details, state: d.state,
};

async function flush() {
  window.clearTimeout(timer);
  const s = useStore.getState();
  if (!s.me || s.connection !== 'online') return;
  // «Невидимка» — не отправляем вовсе (сервер тоже не принял бы).
  const a = s.me.presence === 'invisible' ? null : body(detected);
  const key = JSON.stringify(a);
  if (key === lastSent) return;
  const wait = MIN_GAP - (Date.now() - lastAt);
  if (wait > 0) { timer = window.setTimeout(flush, wait); return; }
  lastAt = Date.now();
  try {
    await api('PUT', '/me/game', { activity: a });
    lastSent = key;
  } catch {
    timer = window.setTimeout(flush, 5000);
  }
}

/** Запуск (после входа): справочник игр в десктоп, подписка на найденную игру, переотправка после переподключения. */
export function startGames() {
  if (!isDesktop || started) return;
  started = true;
  api<{ games: unknown[] }>('GET', '/games/detectable').then((r) => dinvoke('games_set_catalog', { games: r.games })).catch(() => {});
  dinvoke<GamesView>('games_get').then((v) => { if (v) { detected = v.current; void flush(); } });
  dlisten<DetectedGame | null>('game-activity', (d) => { detected = d; void flush(); });
  // Сервер снимает активность при выходе из сети и при «невидимке» — после переподключения и смены статуса шлём заново.
  let prev = { conn: useStore.getState().connection, presence: useStore.getState().me?.presence };
  useStore.subscribe((s) => {
    const now = { conn: s.connection, presence: s.me?.presence };
    if (now.conn !== prev.conn || now.presence !== prev.presence) {
      if (now.conn === 'online' && (prev.conn !== 'online' || prev.presence === 'invisible')) lastSent = null;
      prev = now;
      void flush();
    }
  });
}

export const gamesGet = () => dinvoke<GamesView>('games_get');

// Игровая активность в интерфейсе: строка «Играет в …» (участники), карточка (поповер, профиль), значок (голос),
// вкладка настроек «Игровая активность» (только в приложении).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Gamepad2, EyeOff, Eye, Plus, Trash2, RefreshCw } from 'lucide-react';
import { isDesktop, dinvoke } from '../lib/desktop';
import { gamesGet, type GameActivity, type GamesView, type RunningApp } from '../lib/games';
import { Button, Input, Switch } from '../ui';
import { useStore } from '../store';
const toast = (m: string, err?: boolean) => useStore.getState().toast(m, err);

/** Минуты/часы с начала — тикает раз в 30 с (считается на клиенте от started_at). */
function useElapsed(since?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!since) return; const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, [since]);
  if (!since) return '';
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Значок игры: обложка (из хранилища Relay) или геймпад. */
export function GameIcon({ a, size = 16 }: { a: GameActivity; size?: number }) {
  const [broken, setBroken] = useState(false);
  return a.icon_url && !broken
    ? <img className="game-icon" src={a.icon_url} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} draggable={false} />
    : <span className="game-icon game-icon-fallback" style={{ width: size, height: size }}><Gamepad2 size={Math.round(size * 0.75)} /></span>;
}

/** «Играет в Dota 2» под ником (список участников). Появление — один раз на игру, без дёрганий при обновлении деталей. */
export function ActivityLine({ a }: { a?: GameActivity | null }) {
  const { t } = useTranslation();
  return (
    <AnimatePresence initial={false} mode="wait">
      {a && (
        <motion.span key={a.game_id + a.started_at} className="activity-line" title={[a.name, a.details, a.state].filter(Boolean).join(' · ')}
          initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }}>
          <GameIcon a={a} size={14} />
          <span className="activity-line-text">{t('games.playing')} <b>{a.name}</b></span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Карточка активности (поповер и полный профиль): обложка, название, детали, время в игре. */
export function ActivityCard({ a }: { a?: GameActivity | null }) {
  const { t } = useTranslation();
  const elapsed = useElapsed(a?.started_at);
  return (
    <AnimatePresence initial={false}>
      {a && (
        <motion.div key={a.game_id + a.started_at} className="activity-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
          <div className="activity-card-title">{t('games.playingTitle')}</div>
          <div className="activity-card-body">
            {a.icon_url ? <img className="activity-cover" src={a.icon_url} alt="" draggable={false} /> : <span className="activity-cover activity-cover-fallback"><Gamepad2 size={26} /></span>}
            <div className="activity-card-text">
              <b className="activity-name">{a.name}</b>
              {a.details && <span className="small">{a.details}</span>}
              {a.state && <span className="small">{a.state}</span>}
              <span className="small muted">{t('games.elapsed', { time: elapsed })}</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- настройки ----------

export function GamesTab() {
  const { t } = useTranslation();
  const [v, setV] = useState<GamesView | null>(null);
  const [apps, setApps] = useState<RunningApp[] | null>(null);
  const [pick, setPick] = useState<RunningApp | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => gamesGet().then((x) => x && setV(x));
  useEffect(() => { if (isDesktop) { void refresh(); const id = window.setInterval(refresh, 5000); return () => window.clearInterval(id); } }, []);

  if (!isDesktop) return <div className="us-section"><p className="muted">{t('games.desktopOnly')}</p></div>;
  if (!v) return <div className="us-section"><p className="muted">{t('games.oldApp')}</p></div>;

  const call = async (cmd: string, args: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await dinvoke<GamesView>(cmd, args); if (r) setV(r); else toast(t('games.failed'), true); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const hide = (key: string, on: boolean) => call('games_set', { hidden: on ? [...new Set([...v.hidden, key])] : v.hidden.filter((k) => k !== key) });
  const cur = v.current;

  return (
    <div className="us-section games-tab">
      <Switch label={t('games.show')} checked={v.show_activity} onChange={(x) => call('games_set', { showActivity: x })} />
      <p className="muted small">{t('games.privacyHint')}</p>

      <div className="us-card-rows">
        <div className="games-current">
          <div className="field-label">{t('games.now')}</div>
          {cur ? (
            <div className="games-row">
              <span className="game-icon game-icon-fallback" style={{ width: 20, height: 20 }}><Gamepad2 size={15} /></span>
              <span className="games-row-name"><b>{cur.name}</b>{cur.details && <span className="muted small"> · {cur.details}</span>}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => hide(cur.key, true)}><EyeOff size={14} />{t('games.hide')}</Button>
            </div>
          ) : <div className="muted small">{v.show_activity ? t('games.none') : t('games.off')}</div>}
        </div>
      </div>

      {v.hidden.length > 0 && (
        <div className="us-card-rows">
          <div className="field-label">{t('games.hidden')}</div>
          {v.hidden.map((k) => (
            <div key={k} className="games-row">
              <span className="games-row-name muted">{v.custom.find((c) => `custom:${c.exe}` === k)?.name ?? (cur?.key === k ? cur.name : k)}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => hide(k, false)}><Eye size={14} />{t('games.unhide')}</Button>
            </div>
          ))}
        </div>
      )}

      <div className="us-card-rows">
        <div className="field-label">{t('games.custom')}</div>
        {v.custom.map((c) => (
          <div key={c.exe} className="games-row">
            <span className="games-row-name"><b>{c.name}</b> <span className="muted small">{c.exe}</span></span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => call('games_remove_custom', { exe: c.exe })}><Trash2 size={14} />{t('games.remove')}</Button>
          </div>
        ))}
        {apps === null ? (
          <Button size="sm" variant="secondary" onClick={async () => setApps((await dinvoke<RunningApp[]>('games_running')) ?? [])}><Plus size={14} />{t('games.add')}</Button>
        ) : (
          <div className="games-add">
            <div className="row"><span className="muted small">{t('games.pickHint')}</span>
              <Button size="sm" variant="ghost" onClick={async () => setApps((await dinvoke<RunningApp[]>('games_running')) ?? [])}><RefreshCw size={13} /></Button></div>
            <div className="games-pick" role="listbox">
              {apps.length === 0 && <div className="muted small">{t('games.noApps')}</div>}
              {apps.map((a) => (
                <button key={a.exe} role="option" aria-selected={pick?.exe === a.exe} className={`games-pick-item ${pick?.exe === a.exe ? 'on' : ''}`}
                  onClick={() => { setPick(a); setName(a.title.slice(0, 100)); }}>
                  <span className="games-pick-title">{a.title}</span><span className="muted small">{a.exe}</span>
                </button>
              ))}
            </div>
            {pick && (
              <div className="row">
                <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={t('games.namePh')} />
                <Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={async () => { await call('games_add_custom', { exe: pick.exe, path: pick.path, name }); setPick(null); setApps(null); }}>{t('games.addConfirm')}</Button>
              </div>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setApps(null); setPick(null); }}>{t('games.cancel')}</Button>
          </div>
        )}
      </div>

      <div className="us-card-rows">
        <Switch label={t('games.dota')} checked={v.dota_gsi} onChange={(x) => call('games_dota_gsi', { enabled: x })} />
        <p className="muted small">{t('games.dotaHint')}</p>
        {v.dota_gsi && !v.gsi_running && <p className="small danger-text">{t('games.dotaPort')}</p>}
      </div>
    </div>
  );
}

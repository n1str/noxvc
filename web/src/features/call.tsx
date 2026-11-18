// Фаза 5: экран звонка (сетка плиток, фокус, полный экран), камера и демонстрация экрана, звонки в ЛС
// (входящий звонок со звонком-мелодией), сцена (выступающие, слушатели, поднятые руки).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, Hand, Headphones, HeadphoneOff, Maximize2, Menu as MenuIcon, Mic, MicOff, Minimize2, MonitorUp, Phone, PhoneOff, Radio, Settings2, Users, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { api } from '../lib/api';
import { appear, spring } from '../design/tokens';
import { Avatar, Button, IconButton } from '../ui';
import { Menu, useModal, usePopover } from '../ui/overlays';
import { useLayout } from '../ui/layout';
import { canChannel, displayName, dmName, P, useStore, type Channel, type Dm } from '../store';
import { leaveVoice, ScreenAudioButton, toggleCamera, toggleDeafen, toggleMute, toggleScreen, useVoice, videoStats, videoTracks, type VideoStats, type VideoTrackRef } from './voice';
import { StreamModal } from './stream';
import { ScreenPicker } from './screenPicker';
import { isDesktop } from '../lib/desktop';
import { SearchBox } from './search';
import { InboxButton } from './notify';

const errToast = (e: unknown) => useStore.getState().toast((e as Error).message, true);
const join = (c: Channel, video = false) => window.dispatchEvent(new CustomEvent('relay:join_voice', { detail: { ...c, video } }));

/** Видео в <video>: трек LiveKit прикрепляется, при смене/уходе — открепляется. */
function VideoEl({ t, mirror, contain }: { t: VideoTrackRef; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    t.track.attach(el);
    return () => { t.track.detach(el); };
  }, [t.track]);
  return <video ref={ref} className={`tile-video ${mirror ? 'mirror' : ''} ${contain ? 'contain' : ''}`} autoPlay playsInline muted />;
}

interface TileModel { key: string; uid: number; source: 'camera' | 'screen'; track?: VideoTrackRef }

function Tile({ m, focused, onFocus, compact }: { m: TileModel; focused: boolean; onFocus(): void; compact?: boolean }) {
  const { t } = useTranslation();
  const s = useStore();
  const speaking = useVoice((v) => v.speaking.has(m.uid));
  const vs = s.voice[m.uid];
  const me = m.uid === s.me?.id;
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const h = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const user = s.users[m.uid];
  const [stats, setStats] = useState<VideoStats | null>(null);
  const [showStats, setShowStats] = useState(false);
  useEffect(() => {
    if (!showStats || !m.track) { setStats(null); return; }
    let alive = true;
    const tick = async () => { const x = await videoStats(m.track!.track); if (alive) setStats(x); };
    tick();
    const iv = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [showStats, m.track]);
  return (
    <motion.div ref={box} layout transition={spring} className={`tile ${m.source} ${speaking && m.source === 'camera' ? 'speaking' : ''} ${focused ? 'focused' : ''} ${compact ? 'compact' : ''}`}
      onClick={onFocus} data-uid={m.uid} data-source={m.source}>
      {m.track ? <VideoEl t={m.track} mirror={me && m.source === 'camera'} contain={m.source === 'screen'} /> : (
        <div className="tile-avatar" style={{ background: `color-mix(in oklch, ${user?.color ?? 'var(--accent)'} 35%, var(--bg-sidebar))` }}>
          <Avatar user={user} size={compact ? 48 : 80} levelUid={m.uid} speaking={speaking} play={speaking} />
        </div>
      )}
      <div className="tile-label">
        {m.source === 'screen' && <span className="live-badge">{t('call.live')}</span>}
        {m.source === 'screen' && vs?.screen && !vs.screen_audio && <VolumeX size={14} className="tile-muted" aria-label={t('stream.audioMutedState')}><title>{t('stream.audioMutedState')}</title></VolumeX>}
        <span>{displayName(s, m.uid, user?.display_name)}</span>
        {(vs?.muted || vs?.deafened) && m.source === 'camera' && <MicOff size={14} className="tile-muted" aria-label={t('voice.mutedState')} />}
        {vs?.deafened && m.source === 'camera' && <HeadphoneOff size={14} className="tile-muted" aria-label={t('voice.deafenedState')} />}
      </div>
      {m.track && showStats && (
        <div className="tile-stats" aria-live="polite">
          {stats ? <>{stats.width}×{stats.height} · {stats.fps} FPS<br />{(stats.kbps / 1000).toFixed(1)} {t('stream.mbps')} · {stats.codec.toUpperCase()}</> : '…'}
        </div>
      )}
      {m.track && (
        <button className="tile-info" aria-label={t('stream.stats')} aria-pressed={showStats} onClick={(e) => { e.stopPropagation(); setShowStats(!showStats); }}><Activity size={16} /></button>
      )}
      {m.track && (
        <button className="tile-full" aria-label={full ? t('call.exitFullscreen') : t('call.fullscreen')}
          onClick={(e) => { e.stopPropagation(); if (full) document.exitFullscreen().catch(() => {}); else box.current?.requestFullscreen().catch(() => {}); }}>
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
    </motion.div>
  );
}

/** Плитки комнаты: камера (или аватар) каждого участника + отдельные плитки демонстраций. */
function useTiles(uids: number[]) {
  const tick = useVoice((v) => v.videoTick);
  const connected = useVoice((v) => v.channelId);
  return useMemo(() => {
    const tracks = videoTracks();
    const out: TileModel[] = [];
    for (const uid of uids) {
      const screen = tracks.find((x) => x.uid === uid && x.source === 'screen');
      if (screen) out.push({ key: `s${uid}`, uid, source: 'screen', track: screen });
    }
    for (const uid of uids) out.push({ key: `c${uid}`, uid, source: 'camera', track: tracks.find((x) => x.uid === uid && x.source === 'camera') });
    return out;
  }, [uids.join(','), tick, connected]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Grid({ uids, compact }: { uids: number[]; compact?: boolean }) {
  const tiles = useTiles(uids);
  const [focus, setFocus] = useState<string | null>(null);
  const focused = tiles.find((x) => x.key === focus) ?? null;
  // Новая демонстрация экрана — сразу в фокус (как в Discord).
  const screens = tiles.filter((x) => x.source === 'screen').map((x) => x.key).join(',');
  useEffect(() => { const s = tiles.find((x) => x.source === 'screen'); if (s && !focus) setFocus(s.key); }, [screens]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (focus && !tiles.some((x) => x.key === focus)) setFocus(null); }, [tiles, focus]);
  if (focused) {
    return (
      <div className={`call-grid spotlight ${compact ? 'compact' : ''}`}>
        <div className="spot-main"><Tile m={focused} focused onFocus={() => setFocus(null)} /></div>
        <div className="spot-strip">{tiles.filter((x) => x.key !== focused.key).map((m) => <Tile key={m.key} m={m} focused={false} compact onFocus={() => setFocus(m.key)} />)}</div>
      </div>
    );
  }
  const n = tiles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return (
    <div className={`call-grid ${compact ? 'compact' : ''} ${cols === 1 ? 'single' : ''}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {tiles.map((m) => <Tile key={m.key} m={m} focused={false} compact={compact} onFocus={() => setFocus(m.key)} />)}
    </div>
  );
}

/** Панель управления звонком. */
function Controls({ c, stage }: { c: Channel; stage?: { suppressed: boolean; hand: boolean } }) {
  const { t } = useTranslation();
  const v = useVoice();
  const s = useStore();
  const modal = useModal();
  const here = v.channelId === c.id;
  const guildVideo = c.kind === 'dm' || canChannel(c, P.STREAM);
  if (!here) {
    return (
      <div className="call-controls">
        <Button variant="primary" onClick={() => join(c)}><Phone size={16} />{t(c.kind === 'dm' ? 'call.joinCall' : c.kind === 'stage' ? 'call.joinStage' : 'call.join')}</Button>
        {guildVideo && c.kind !== 'stage' && <Button onClick={() => join(c, true)}><Video size={16} />{t('call.joinVideo')}</Button>}
      </div>
    );
  }
  const me = s.me!.id;
  return (
    <div className="call-controls">
      {(!stage || !stage.suppressed) && (
        <IconButton label={v.muted ? t('voice.unmute') : t('voice.mute')} className="ctl" tone={v.muted ? 'danger' : undefined} active={v.muted} onClick={toggleMute}>
          {v.muted ? <MicOff size={20} /> : <Mic size={20} />}
        </IconButton>
      )}
      <IconButton label={v.deafened ? t('voice.undeafen') : t('voice.deafen')} className="ctl" tone={v.deafened ? 'danger' : undefined} active={v.deafened} onClick={toggleDeafen}>
        {v.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
      </IconButton>
      {guildVideo && (!stage || !stage.suppressed) && <>
        <IconButton label={v.camera ? t('call.cameraOff') : t('call.cameraOn')} className="ctl" active={v.camera} onClick={toggleCamera}>{v.camera ? <Video size={20} /> : <VideoOff size={20} />}</IconButton>
        <IconButton label={v.screen ? t('call.screenOff') : t('call.screenOn')} className={`ctl ${v.screen ? 'sharing' : ''}`} active={v.screen}
          onClick={() => (v.screen ? toggleScreen() : modal.open((close) => (isDesktop ? <ScreenPicker close={close} /> : <StreamModal close={close} />), isDesktop ? { wide: true } : undefined))}><MonitorUp size={20} /></IconButton>
        {v.screen && <ScreenAudioButton size={20} className="ctl" />}
        {v.screen && <IconButton label={t('stream.titleLive')} className="ctl" onClick={() => modal.open((close) => <StreamModal close={close} />)}><Settings2 size={20} /></IconButton>}
      </>}
      {stage?.suppressed && (
        <Button variant={stage.hand ? 'primary' : 'ghost'} onClick={() => api('POST', '/voice/hand', { raised: !stage.hand }).catch(errToast)}>
          <Hand size={16} />{stage.hand ? t('call.lowerHand') : t('call.raiseHand')}
        </Button>
      )}
      {stage && !stage.suppressed && (
        <Button variant="ghost" onClick={() => api('POST', `/voice/stage/${me}`, { speaker: false }).catch(errToast)}>{t('call.toAudience')}</Button>
      )}
      <IconButton label={t('voice.leave')} className="ctl leave" tone="danger" onClick={() => leaveVoice()}><PhoneOff size={20} /></IconButton>
    </div>
  );
}

/** Главная область для голосового канала и сцены. */
export function CallView({ c }: { c: Channel }) {
  const { t } = useTranslation();
  const s = useStore();
  const pop = usePopover();
  const inRoom = Object.values(s.voice).filter((v) => v.channel_id === c.id);
  const me = s.me!.id;
  const myState = s.voice[me]?.channel_id === c.id ? s.voice[me] : undefined;
  const isStage = c.kind === 'stage';
  const speakers = isStage ? inRoom.filter((v) => !v.suppress) : inRoom;
  const audience = isStage ? inRoom.filter((v) => v.suppress).sort((a, b) => (b.hand ? 1 : 0) - (a.hand ? 1 : 0) || (a.hand ?? 0) - (b.hand ?? 0)) : [];
  const moderator = canChannel(c, P.MUTE_MEMBERS) || canChannel(c, P.MOVE_MEMBERS) || canChannel(c, P.MANAGE_CHANNELS);
  const audienceMenu = (e: React.MouseEvent, uid: number, speaker: boolean) => {
    if (!moderator) return;
    e.preventDefault();
    pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={[
      speaker ? { label: t('call.moveToAudience'), onSelect: () => api('POST', `/voice/stage/${uid}`, { speaker: false }).catch(errToast) }
        : { label: t('call.inviteSpeak'), onSelect: () => api('POST', `/voice/stage/${uid}`, { speaker: true }).catch(errToast) },
    ]} />);
  };
  return (
    <main className="chat call-view">
      <header className="chat-header">
        <IconButton label={t('chat.channels')} className="only-narrow" onClick={() => useLayout.getState().open('channels')}><MenuIcon size={20} /></IconButton>
        {isStage ? <Radio size={20} className="muted" /> : <Volume2 size={20} className="muted" />}
        <h1>{c.name}</h1>
        {c.topic && <span className="chat-topic">{c.topic}</span>}
        <span className="grow" />
        <SearchBox />
        <InboxButton />
        <IconButton label={t('chat.members')} className="only-medium" onClick={() => useLayout.getState().toggleMembers()}><Users size={20} /></IconButton>
      </header>
      <div className="call-body">
        {inRoom.length === 0 ? (
          <motion.div className="call-empty" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={appear}>
            <div className="empty-icon">{isStage ? <Radio size={28} /> : <Volume2 size={28} />}</div>
            <h2>{c.name}</h2>
            <p className="muted">{t(isStage ? 'call.stageEmpty' : 'call.empty')}</p>
          </motion.div>
        ) : (
          <>
            {isStage && <div className="stage-label">{t('call.speakers', { n: speakers.length })}</div>}
            <div onContextMenu={(e) => { const el = (e.target as HTMLElement).closest('[data-uid]'); if (el && isStage) audienceMenu(e, +el.getAttribute('data-uid')!, true); }}>
              {speakers.length > 0 ? <Grid uids={speakers.map((v) => v.user_id)} /> : <p className="muted call-nospeakers">{t('call.noSpeakers')}</p>}
            </div>
            {isStage && audience.length > 0 && (
              <section className="stage-audience">
                <div className="stage-label">{t('call.audience', { n: audience.length })}</div>
                <div className="audience-grid">
                  {audience.map((v) => (
                    <div key={v.user_id} className={`audience-member ${v.hand ? 'hand' : ''}`} data-uid={v.user_id} onContextMenu={(e) => audienceMenu(e, v.user_id, false)}>
                      <Avatar user={s.users[v.user_id]} size={56} />
                      {v.hand && <span className="hand-badge" title={t('call.handRaised')}><Hand size={14} /></span>}
                      <span className="small">{displayName(s, v.user_id)}</span>
                      {moderator && v.hand && <Button size="sm" variant="primary" onClick={() => api('POST', `/voice/stage/${v.user_id}`, { speaker: true }).catch(errToast)}>{t('call.inviteSpeak')}</Button>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      <Controls c={c} stage={isStage && myState ? { suppressed: !!myState.suppress, hand: !!myState.hand } : undefined} />
    </main>
  );
}

/** Звонок в ЛС: полоса над перепиской (видно, кто в звонке; войти, камера, экран). */
export function DmCall({ c }: { c: Channel }) {
  const s = useStore();
  const here = useVoice((v) => v.channelId) === c.id;
  const inRoom = Object.values(s.voice).filter((v) => v.channel_id === c.id).map((v) => v.user_id);
  if (!here && inRoom.length === 0) return null;
  return (
    <motion.div className="dm-call" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={appear}>
      <Grid uids={inRoom} compact />
      <Controls c={c} />
    </motion.div>
  );
}

/** Кнопки звонка в шапке ЛС. */
export function DmCallButtons({ c }: { c: Channel }) {
  const { t } = useTranslation();
  const here = useVoice((v) => v.channelId) === c.id;
  if (here) return null;
  return (
    <>
      <IconButton label={t('call.start')} onClick={() => join(c)}><Phone size={20} /></IconButton>
      <IconButton label={t('call.startVideo')} onClick={() => join(c, true)}><Video size={20} /></IconButton>
    </>
  );
}

// ---------- входящий звонок ----------
let ringCtx: AudioContext | null = null;
function ringOnce() {
  try {
    ringCtx ??= new AudioContext();
    const t0 = ringCtx.currentTime;
    for (const [i, f] of [659, 784, 659, 784].entries()) {
      const o = ringCtx.createOscillator(), g = ringCtx.createGain(), t = t0 + i * 0.16;
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.1, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g).connect(ringCtx.destination); o.start(t); o.stop(t + 0.16);
    }
  } catch { /* без звука */ }
}

export function IncomingCall() {
  const { t } = useTranslation();
  const s = useStore();
  const [ring, setRing] = useState<{ channel_id: number; user_id: number; at: number } | null>(null);
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ channel_id: number; user_id: number }>).detail;
      if (useStore.getState().me?.presence === 'dnd') return; // «Не беспокоить» — без звонка
      setRing({ ...d, at: Date.now() });
    };
    window.addEventListener('relay:call_ring', h);
    return () => window.removeEventListener('relay:call_ring', h);
  }, []);
  const myChannel = useVoice((v) => v.channelId);
  const active = ring && Object.values(s.voice).some((v) => v.channel_id === ring.channel_id);
  // Звонок закончился, я ответил или прошло 30 с — убираем.
  useEffect(() => {
    if (!ring) return;
    if (!active || myChannel === ring.channel_id) { setRing(null); return; }
    ringOnce();
    const iv = setInterval(ringOnce, 2000);
    const to = setTimeout(() => setRing(null), Math.max(0, 30_000 - (Date.now() - ring.at)));
    return () => { clearInterval(iv); clearTimeout(to); };
  }, [ring, active, myChannel]);
  const dm: Dm | undefined = ring ? s.dms.find((d) => d.id === ring.channel_id) : undefined;
  const caller = ring ? s.users[ring.user_id] : undefined;
  const accept = (video: boolean) => {
    if (!ring) return;
    s.selectHome(ring.channel_id);
    join({ id: ring.channel_id, guild_id: null, parent_id: null, name: dm ? dmName(dm) : '', kind: 'dm', topic: '', position: 0, bitrate: 0, user_limit: 0 }, video);
    setRing(null);
  };
  return (
    <AnimatePresence>
      {ring && active && (
        <motion.div className="incoming-call" role="alertdialog" aria-label={t('call.incoming')} initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24 }} transition={spring}>
          <div className="incoming-pulse"><Avatar user={caller} size={72} /></div>
          <b>{caller?.display_name}</b>
          <span className="muted small">{dm?.kind === 'group_dm' ? t('call.incomingGroup', { name: dmName(dm) }) : t('call.incoming')}</span>
          <div className="incoming-actions">
            <IconButton label={t('call.decline')} className="ctl leave" tone="danger" onClick={() => setRing(null)}><PhoneOff size={20} /></IconButton>
            <IconButton label={t('call.acceptVideo')} className="ctl" onClick={() => accept(true)}><Video size={20} /></IconButton>
            <IconButton label={t('call.accept')} className="ctl accept" onClick={() => accept(false)}><Phone size={20} /></IconButton>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

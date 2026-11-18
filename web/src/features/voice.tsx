// Голос: WebRTC через LiveKit. Сервер выдаёт токен после проверки прав (/api/voice/token),
// кто в каком канале — сервер узнаёт из вебхуков LiveKit и рассылает VOICE_STATE.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { create } from 'zustand';
import type { RemoteParticipant, Room } from 'livekit-client';

// LiveKit (~300 КБ) грузится лениво — при первом входе в голосовой канал.
type LK = typeof import('livekit-client');
let lk: LK | null = null;
const loadLK = async () => (lk ??= await import('livekit-client'));
import { Headphones, HeadphoneOff, Mic, MicOff, MonitorSpeaker, PhoneOff, Settings2, ShieldCheck, VolumeX } from 'lucide-react';
import { api } from '../lib/api';
import { appear } from '../design/tokens';
import { Button, Field, IconButton, Switch } from '../ui';
import { useModal } from '../ui/overlays';
import { useStore, type Channel, type VoiceState } from '../store';
import { dcall, dinvoke, dlisten, isDesktop, type AppInfo } from '../lib/desktop';
import i18n from '../i18n';
import { comboLabel, KeybindButton, setHotkeyHandlers, syncGlobal, useHotkeys, useHotkeysWiring, type Action } from './hotkeys';
import { saveSetting, watchSetting } from '../lib/accountSettings';
import { DB_MAX, DB_MIN, onSelfMeter, setVadParams, startMicTest, trackRemote, untrackAll, untrackRemote, vadProcessor, dbToUnit, type SelfMeter } from './vad';
import { camBitrate, camDims, contentHint, degradation, streamBitrate, streamCfg, streamCodec, streamDims } from '../lib/streamCfg';

// ---------- настройки (локальные) ----------
export interface VoiceCfg {
  mode: 'vad' | 'ptt'; pttDelay: number; echo: boolean; noise: boolean; agc: boolean; input: string; output: string; sounds: boolean;
  /** Голосовая активация: порог автоматически (по фону шума) или вручную (дБFS); задержка отпускания, мс. */
  vadAuto: boolean; vadThreshold: number; vadHangover: number;
}
const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v == null ? d : { ...d, ...JSON.parse(v) }; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const cfg: VoiceCfg = { mode: 'vad', pttDelay: 200, echo: true, noise: true, agc: true, input: '', output: '', sounds: true, vadAuto: true, vadThreshold: -50, vadHangover: 300, ...LS.get<Partial<VoiceCfg>>('relay_voice', {}) };
const syncVad = () => setVadParams({ threshold: cfg.vadThreshold, auto: cfg.vadAuto, hangover: cfg.vadHangover, enabled: cfg.mode === 'vad' });
syncVad();
const saveCfg = () => LS.set('relay_voice', cfg);
const volumes: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem('relay_vol') || '{}'); } catch { return {}; } })();

type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
interface VoiceStore {
  channelId: number | null; guildId: number | null; name: string;
  muted: boolean; deafened: boolean; quality: Quality; speaking: Set<number>; reconnecting: boolean;
  /** Маршрут медиа (регион входа, где комната, через релей ли) — для диагностики. */
  route?: { region?: string; mediaRegion?: string; relay: boolean; pair?: string; proto?: string } | null;
  /** Камера и демонстрация экрана включены у меня. */
  camera: boolean; screen: boolean;
  /** Звук моей трансляции: включён / выключен; null — звука у трансляции нет (не захвачен или недоступен на этой Windows). */
  screenAudio: boolean | null;
  /** Растёт при любом изменении видеотреков — плитки перечитывают треки из комнаты. */
  videoTick: number;
}
export const useVoice = create<VoiceStore>(() => ({
  channelId: null, guildId: null, name: '', muted: false, deafened: false, quality: 'unknown', speaking: new Set(), reconnecting: false,
  camera: false, screen: false, screenAudio: null, videoTick: 0,
}));
const bumpVideo = () => useVoice.setState((s) => ({ videoTick: s.videoTick + 1 }));

/** Видеотреки комнаты: камера и экран каждого участника (у себя — локальные). */
export interface VideoTrackRef { uid: number; source: 'camera' | 'screen'; track: { attach(el: HTMLMediaElement): HTMLMediaElement; detach(el?: HTMLMediaElement): unknown } }
export function videoTracks(): VideoTrackRef[] {
  if (!room || !lk) return [];
  const { Track } = lk;
  const out: VideoTrackRef[] = [];
  const parts = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of parts) {
    for (const [src, name] of [[Track.Source.Camera, 'camera'], [Track.Source.ScreenShare, 'screen']] as const) {
      const pub = p.getTrackPublication(src);
      if (pub?.track && !pub.isMuted) out.push({ uid: parseInt(p.identity, 10), source: name, track: pub.track });
    }
  }
  return out;
}

let room: Room | null = null;
let joining = false;
let pttHeld = false;
let pttTimer: ReturnType<typeof setTimeout> | undefined;

// ---------- звуки (без файлов) ----------
let sfxCtx: AudioContext | null = null;
function sfx(kind: 'join' | 'leave' | 'mute' | 'unmute') {
  if (!cfg.sounds) return;
  try {
    sfxCtx ??= new AudioContext();
    const notes = { join: [523, 784], leave: [784, 523], mute: [440], unmute: [660] }[kind];
    notes.forEach((f, i) => {
      const o = sfxCtx!.createOscillator(), g = sfxCtx!.createGain(), t = sfxCtx!.currentTime + i * 0.09;
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(g).connect(sfxCtx!.destination); o.start(t); o.stop(t + 0.18);
    });
  } catch { /* звук не критичен */ }
}

const micOn = () => { const v = useVoice.getState(); return !v.muted && !v.deafened && (cfg.mode !== 'ptt' || pttHeld); };
async function syncMic() {
  if (!room) return;
  if (suppressed) { if (room.localParticipant.isMicrophoneEnabled) await room.localParticipant.setMicrophoneEnabled(false).catch(() => {}); return; }
  try { await room.localParticipant.setMicrophoneEnabled(micOn()); }
  catch (e) { useStore.getState().toast('Микрофон: ' + ((e as Error).message || e), true); }
}
function applyVolumes() {
  if (!room) return;
  const deaf = useVoice.getState().deafened;
  for (const p of room.remoteParticipants.values()) { try { p.setVolume(deaf ? 0 : volumes[p.identity] ?? 1); } catch { /* участник ушёл */ } }
}
const sendFlags = () => { const v = useVoice.getState(); api('PATCH', '/voice/state', { muted: v.muted, deafened: v.deafened, video: v.camera, screen: v.screen, screen_audio: v.screen && v.screenAudio === true }).catch(() => {}); };

/** Слушатель сцены: микрофон не включаем (LiveKit всё равно не даст). */
let suppressed = false;

/** Маршрут медиа от сервера (POST /voice/token → ice). */
export interface VoiceIce { region?: string; media_region?: string; servers?: RTCIceServer[]; policy?: 'relay' | 'all' }

// ---------- маршрут медиа: диагностика и отчёты ----------
let routeTimer: ReturnType<typeof setInterval> | undefined;
const report = (b: Record<string, unknown>) => { api('POST', '/voice/report', { kind: 'voice', ...b }).catch(() => {}); };

/** Выбранная пара ICE: тип своего кандидата (relay — через TURN) и транспорт. Адреса никуда не уходят. */
export function pairOf(rep: RTCStatsReport | undefined): { pair: string; proto: string; rtt: number | null } | null {
  if (!rep) return null;
  const by = new Map<string, any>();
  rep.forEach((s: any) => by.set(s.id, s));
  let pair: any;
  rep.forEach((s: any) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = by.get(s.selectedCandidatePairId); });
  if (!pair) rep.forEach((s: any) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  const lc = pair && by.get(pair.localCandidateId);
  if (!lc) return null;
  const proto = String(lc.candidateType === 'relay' ? lc.relayProtocol || lc.protocol : lc.protocol || '').toLowerCase();
  return { pair: lc.candidateType, proto, rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null };
}

async function selectedPair() {
  if (!room || !lk) return null;
  const tracks = [room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track,
    ...[...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].map((x) => x.track))];
  for (const t of tracks) {
    const p = pairOf(await t?.getRTCStatsReport().catch(() => undefined));
    if (p) return p;
  }
  return null;
}

async function reportRoute(event?: 'connected' | 'reconnecting' | 'reconnected' | 'disconnected') {
  if (!room) return;
  const p = event === 'reconnecting' || event === 'disconnected' ? null : await selectedPair();
  if (p) useVoice.setState((s) => ({ route: s.route ? { ...s.route, pair: p.pair, proto: p.proto } : { relay: false, pair: p.pair, proto: p.proto } }));
  const st = event ? null : await collectStats();
  report({ event, pair: p?.pair, proto: p?.proto, rtt_ms: st?.rtt ?? p?.rtt ?? undefined, jitter_ms: st?.jitter ?? undefined, loss: st?.lost != null ? st.lost / 100 : undefined });
}

export async function joinVoice(ch: Channel, pre?: { url?: string; token?: string; bitrate?: number; video?: boolean }) {
  const store = useStore.getState();
  if (joining || useVoice.getState().channelId === ch.id) return;
  if (!window.isSecureContext) return store.toast('Голос работает только по HTTPS (или на localhost)', true);
  joining = true;
  try {
    type Tok = { url: string; token: string; bitrate: number; ice?: VoiceIce };
    const { url, token, bitrate, ice } = pre?.token ? (pre as Tok) : await api<Tok>('POST', '/voice/token', { channel_id: ch.id });
    if (room) await leaveVoice(false);
    const { Room, RoomEvent, Track } = await loadLK();
    const r = new Room({
      // «Максимальное качество просмотра» — без адаптации под размер плитки (берём верхний слой);
      // иначе — адаптация с учётом плотности пикселей экрана (на HiDPI плитка получает больше пикселей).
      adaptiveStream: streamCfg.viewMax ? false : { pixelDensity: 'screen' }, dynacast: true, webAudioMix: true,
      audioCaptureDefaults: { echoCancellation: cfg.echo, noiseSuppression: cfg.noise, autoGainControl: cfg.agc, deviceId: cfg.input || undefined },
      audioOutput: cfg.output ? { deviceId: cfg.output } : undefined,
      // DTX в приложении выключен: в паузах речи битрейт не проваливается до 3–4 кбит/с, звук ровный.
      publishDefaults: { audioPreset: { maxBitrate: bitrate || 64000 }, dtx: !isDesktop, red: true },
    });
    r.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      // Свой нативный поток экрана: звук не слушаем (эхо игры/видео), картинку — как превью в низком качестве.
      const ownScreen = participant.identity === `${useStore.getState().me?.id}~screen`;
      if (ownScreen && track.kind === Track.Kind.Audio) { (pub as { setSubscribed?(v: boolean): void }).setSubscribed?.(false); return; }
      if (ownScreen && track.kind === Track.Kind.Video) { (pub as { setVideoQuality?(q: number): void }).setVideoQuality?.(lk!.VideoQuality.LOW); bumpVideo(); return; }
      if (track.kind === Track.Kind.Video) {
        if (streamCfg.viewMax) (pub as { setVideoQuality?(q: number): void }).setVideoQuality?.(lk!.VideoQuality.HIGH);
        bumpVideo();
        return;
      }
      if (track.kind !== Track.Kind.Audio) return;
      document.getElementById('audio-sink')?.append(track.attach());
      if (pub.source === Track.Source.Microphone) trackRemote(+participant.identity, track.mediaStreamTrack); // кольцо говорящего по громкости
      applyVolumes();
    })
      .on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
        if (track.kind === Track.Kind.Video) { bumpVideo(); return; }
        track.detach().forEach((el) => el.remove());
        if (pub.source === Track.Source.Microphone) untrackRemote(+participant.identity);
      })
      .on(RoomEvent.TrackMuted, bumpVideo)
      .on(RoomEvent.TrackUnmuted, bumpVideo)
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        // голосовая активация: гейт на треке микрофона (порог, задержка отпускания)
        if (pub.source === Track.Source.Microphone && pub.audioTrack) {
          (pub.audioTrack as unknown as { setProcessor(p: unknown): Promise<void> }).setProcessor(vadProcessor(useStore.getState().me?.id ?? 0))
            .catch((e: Error) => store.toast('Голосовая активация: ' + (e.message || e), true));
        }
        bumpVideo();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        // Демонстрацию остановили кнопкой браузера — обновляем своё состояние.
        if (pub.source === Track.Source.ScreenShare) { useVoice.setState({ screen: false, screenAudio: null }); sendFlags(); }
        if (pub.source === Track.Source.ScreenShareAudio && !isDesktop) { useVoice.setState({ screenAudio: null }); sendFlags(); }
        if (pub.source === Track.Source.Camera) { useVoice.setState({ camera: false }); sendFlags(); }
        bumpVideo();
      })
      .on(RoomEvent.ParticipantDisconnected, bumpVideo)
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => { if (p === r.localParticipant) syncMic(); })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => useVoice.setState({ speaking: new Set(speakers.map((p) => +p.identity)) }))
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (p === r.localParticipant) useVoice.setState({ quality: q as Quality }); })
      .on(RoomEvent.Reconnecting, () => { useVoice.setState({ reconnecting: true, quality: 'lost' }); reportRoute('reconnecting'); })
      .on(RoomEvent.Reconnected, () => { useVoice.setState({ reconnecting: false }); setTimeout(() => reportRoute('reconnected'), 2000); })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!r.canPlaybackAudio) store.toast('Браузер заблокировал звук — кликните по странице'); })
      .on(RoomEvent.Disconnected, () => { if (room === r) { reportRoute('disconnected'); leaveVoice(false); } });
    // Маршрут медиа: через edge-регион — TURN узла (краткоживущие учётные данные) и, если задано, только релей:
    // клиенту не нужен прямой доступ к SFU основного региона.
    const rtcConfig = ice?.servers?.length ? { iceServers: ice.servers, iceTransportPolicy: (ice.policy ?? 'all') as RTCIceTransportPolicy } : undefined;
    useVoice.setState({ route: ice ? { region: ice.region, mediaRegion: ice.media_region, relay: ice.policy === 'relay' } : null });
    await r.connect(url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, token, rtcConfig ? { rtcConfig } : undefined);
    room = r;
    useVoice.setState({ channelId: ch.id, guildId: ch.guild_id, name: ch.name, quality: 'good', camera: false, screen: false });
    if (pre?.video) await toggleCamera();
    await r.startAudio().catch(() => {});
    await syncMic();
    applyVolumes();
    sendFlags();
    sfx('join');
    // Маршрут медиа (тип пары ICE) — в диагностику и, без адресов, в метрики по регионам.
    setTimeout(() => reportRoute('connected'), 3000);
    clearInterval(routeTimer);
    routeTimer = setInterval(() => reportRoute(), 60_000);
  } catch (e) {
    report({ event: 'failed' });
    store.toast('Не удалось подключиться к голосу: ' + ((e as Error).message || e), true);
  } finally {
    joining = false;
  }
}

export async function leaveVoice(sound = true) {
  clearInterval(routeTimer);
  if (isDesktop && useVoice.getState().screen) dinvoke('screen_stop');
  const r = room;
  room = null;
  if (r) { try { await r.disconnect(); } catch { /* уже отключён */ } }
  const audio = document.getElementById('audio-sink');
  if (audio) audio.innerHTML = '';
  untrackAll();
  if (useVoice.getState().channelId == null) return;
  suppressed = false;
  useVoice.setState({ channelId: null, guildId: null, name: '', speaking: new Set(), quality: 'unknown', reconnecting: false, camera: false, screen: false });
  bumpVideo();
  if (sound) sfx('leave');
}

/** Камера: включить/выключить (нужно право «Видео» на сервере; в ЛС — всегда). */
export async function toggleCamera() {
  if (!room) return;
  const on = !useVoice.getState().camera;
  try {
    const [w, h] = camDims(streamCfg.camRes);
    await room.localParticipant.setCameraEnabled(on, { resolution: { width: w, height: h, frameRate: streamCfg.camFps } }, {
      videoEncoding: { maxBitrate: camBitrate(streamCfg) * 1000, maxFramerate: streamCfg.camFps }, simulcast: true,
    });
    useVoice.setState({ camera: on });
    sendFlags();
  } catch (e) { useStore.getState().toast('Камера: ' + ((e as Error).message || e), true); }
  bumpVideo();
}

/** Демонстрация экрана (со звуком вкладки/системы, если браузер даёт). */
export async function toggleScreen() {
  if (!room) return;
  const on = !useVoice.getState().screen;
  // В приложении демонстрацию ведёт само приложение (выбор источника — ScreenPicker); здесь только остановка.
  if (isDesktop) { if (!on) { await dinvoke('screen_stop'); nativeShareStarted(false); } return; }
  try {
    if (!on) { await room.localParticipant.setScreenShareEnabled(false); useVoice.setState({ screenAudio: null }); }
    else {
      const c = streamCfg, L = lk!;
      const [w, h] = streamDims(c.res);
      const codec = streamCodec(c);
      const kbps = streamBitrate(c);
      const svc = codec === 'vp9' || codec === 'av1';
      await room.localParticipant.setScreenShareEnabled(true, {
        // Звук демонстрации — без обработки «под голос» (музыка, игры), стерео.
        audio: c.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false,
        resolution: { width: w, height: h, frameRate: c.fps },
        contentHint: contentHint(c.mode),
        video: c.surface === 'any' ? true : { displaySurface: c.surface },
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
      }, {
        videoCodec: codec,
        // VP9/AV1 — масштабируемый поток (SVC) + запасной VP8 для клиентов без декодера; H.264/VP8 — симулкаст с лёгким слоем 720p.
        ...(svc ? { scalabilityMode: 'L3T3_KEY' as const, backupCodec: true } : { simulcast: true, screenShareSimulcastLayers: c.res === '720' ? [new L.VideoPreset(640, 360, 800_000, 15)] : [new L.VideoPreset(1280, 720, Math.min(2_500_000, kbps * 400), 30)] }),
        screenShareEncoding: { maxBitrate: kbps * 1000, maxFramerate: c.fps, priority: 'high' },
        degradationPreference: degradation(c.mode),
        audioPreset: L.AudioPresets.musicHighQualityStereo, dtx: false, red: false, forceStereo: true,
      });
    }
    // звук демонстрации есть, только если браузер его дал (вкладка / система) и он не отключён в настройках
    if (on) useVoice.setState({ screenAudio: room.localParticipant.getTrackPublication(lk!.Track.Source.ScreenShareAudio) ? true : null });
    useVoice.setState({ screen: on });
    sendFlags();
  } catch (e) {
    // Отмена выбора окна — не ошибка.
    if (!/denied|cancel|abort/i.test(String((e as Error).message || e))) useStore.getState().toast('Демонстрация экрана: ' + ((e as Error).message || e), true);
  }
  bumpVideo();
}

// Как в Discord: выключенный звук выключает и микрофон; включили звук — микрофон возвращается, каким был до этого;
// включили микрофон при выключенном звуке — включается и звук.
let mutedBeforeDeafen = false;
function setFlags(muted: boolean, deafened: boolean) {
  useVoice.setState({ muted, deafened });
  syncMic(); applyVolumes();
  if (room) sendFlags();
}
export function toggleMute() {
  const v = useVoice.getState();
  if (v.muted && v.deafened) { setFlags(false, false); sfx('unmute'); return; }
  setFlags(!v.muted, v.deafened); sfx(v.muted ? 'unmute' : 'mute');
}
export function toggleDeafen() {
  const v = useVoice.getState();
  if (!v.deafened) { mutedBeforeDeafen = v.muted; setFlags(true, true); sfx('mute'); }
  else { setFlags(mutedBeforeDeafen, false); sfx('unmute'); }
}

// ---------- события ----------
function onVoiceState(v: VoiceState) {
  const me = useStore.getState().me?.id;
  const mine = useVoice.getState();
  if (v.user_id === me) {
    // Сцена: стали слушателем/выступающим — микрофон подстраивается.
    if (v.channel_id === mine.channelId && !!v.suppress !== suppressed) { suppressed = !!v.suppress; syncMic(); }
    // Сервер вывел нас из текущего канала (кик, удаление). Запоздалое «вышел» о прошлом канале игнорируем.
    if (v.channel_id == null && mine.channelId && v.prev_channel_id === mine.channelId) { leaveVoice(); useStore.getState().toast('Вы отключены от голосового канала'); }
    // Сервер узнаёт о входе из вебхука — флаги, отправленные до него, повторяем.
    if (v.channel_id === mine.channelId && (v.muted !== mine.muted || v.deafened !== mine.deafened)) sendFlags();
  } else if (mine.channelId) {
    if (v.prev_channel_id === mine.channelId && v.channel_id !== mine.channelId) sfx('leave');
    if (v.channel_id === mine.channelId) sfx('join');
  }
}

export function useVoiceWiring() {
  useEffect(() => {
    const join = (e: Event) => { const d = (e as CustomEvent<Channel & { video?: boolean }>).detail; joinVoice(d, d.video ? { video: true } : undefined); };
    const moved = (e: Event) => {
      const d = (e as CustomEvent<{ channel: Channel; token: string; url: string; bitrate: number; by: number }>).detail;
      const st = useStore.getState();
      st.toast(`${st.users[d.by]?.display_name ?? 'Модератор'} переместил вас в «${d.channel.name}»`);
      joinVoice(d.channel, { url: d.url, token: d.token, bitrate: d.bitrate });
    };
    const state = (e: Event) => onVoiceState((e as CustomEvent<VoiceState>).detail);
    const offEnded = dlisten<null>('screen_ended', () => nativeShareStarted(false));
    // настройки голоса из аккаунта (кроме устройств — они у каждого компьютера свои)
    const offAcc = watchSetting<Partial<VoiceCfg>>('voice', (v) => {
      for (const k of SYNCED) if (v[k] !== undefined) (cfg as unknown as Record<string, unknown>)[k] = v[k];
      LS.set('relay_voice', cfg); syncVad(); syncMic(); syncGlobal();
    }, accountVoice);
    window.addEventListener('relay:join_voice', join);
    window.addEventListener('relay:voice_move', moved);
    window.addEventListener('relay:voice_state', state);
    // выход из аккаунта (в том числе сеанс завершён с другого устройства) — выйти из голоса и трансляции
    const out = () => { if (room) void leaveVoice(false); };
    window.addEventListener('relay:logout', out);
    return () => {
      window.removeEventListener('relay:logout', out);
      window.removeEventListener('relay:join_voice', join);
      window.removeEventListener('relay:voice_move', moved);
      window.removeEventListener('relay:voice_state', state);
      offEnded(); offAcc();
    };
  }, []);
  useHotkeysWiring();
}

// ---------- горячие клавиши: действия и отклик ----------
/** Настройки голоса, общие для устройств (аккаунт); устройства ввода/вывода — локальные. */
const SYNCED = ['mode', 'pttDelay', 'echo', 'noise', 'agc', 'sounds', 'vadAuto', 'vadThreshold', 'vadHangover'] as const;
const accountVoice = () => Object.fromEntries(SYNCED.map((k) => [k, cfg[k]])) as Partial<VoiceCfg>;

function pttPress(down: boolean) {
  if (!room) return;
  clearTimeout(pttTimer);
  if (down) { if (!pttHeld) { pttHeld = true; syncMic(); } }
  else pttTimer = setTimeout(() => { pttHeld = false; syncMic(); }, cfg.pttDelay);
}
/** Отклик горячей клавиши: короткий тост с сочетанием (звук — у самого действия). */
function hk(text: string, a: Action) {
  const c = useHotkeys.getState().binds[a];
  useStore.getState().toast(c ? `${text} · ${comboLabel(c)}` : text);
}
async function hotkeyStream() {
  if (!room) { hk(i18n.t('hk.notInVoice'), 'stream'); return; }
  if (useVoice.getState().screen) { await toggleScreen(); sfx('leave'); hk(i18n.t('hk.streamStopped'), 'stream'); return; }
  if (!isDesktop) { await toggleScreen(); if (useVoice.getState().screen) { sfx('join'); hk(i18n.t('hk.streamStarted'), 'stream'); } return; }
  // приложение: тот же источник, что в прошлый раз; не выбирали — просим выбрать (окно выбора — в окне Relay)
  const sp = await import('./screenPicker');
  if (!sp.lastSource) { dinvoke('attention'); hk(i18n.t('hk.pickSource'), 'stream'); return; }
  try { await sp.startNativeShare(sp.lastSource); sfx('join'); hk(i18n.t('hk.streamStarted'), 'stream'); }
  catch (e) { useStore.getState().toast((e as Error).message || String(e), true); }
}
setHotkeyHandlers({
  pttActive: () => cfg.mode === 'ptt',
  ptt: pttPress,
  run(a) {
    const v = useVoice.getState();
    if (a === 'mute') { toggleMute(); hk(i18n.t(useVoice.getState().muted ? 'hk.micOff' : 'hk.micOn'), a); }
    else if (a === 'deafen') { toggleDeafen(); hk(i18n.t(useVoice.getState().deafened ? 'hk.soundOff' : 'hk.soundOn'), a); }
    else if (a === 'stream') void hotkeyStream();
    else if (a === 'streamAudio') { if (!v.screen) hk(i18n.t('hk.notStreaming'), a); else void toggleScreenAudio().then(() => { const x = useVoice.getState().screenAudio; if (x != null) hk(i18n.t(x ? 'hk.streamAudioOn' : 'hk.streamAudioOff'), a); }); }
    else if (a === 'disconnect') { if (room) { void leaveVoice(); hk(i18n.t('hk.disconnected'), a); } else hk(i18n.t('hk.notInVoice'), a); }
  },
});

// ---------- статистика ----------
interface Stats { rtt: number | null; jitter: number | null; lost: number | null; codec: string; bytesSent?: number; recv: { name: string; lost: number; jitter: number | null; buffer: number | null; concealed: number }[] }
/** Для баг-репорта: в голосе ли, маршрут, качество и снимок getStats (без адресов). */
export async function voiceDiagnostics() {
  const v = useVoice.getState();
  if (!room || v.channelId == null) return null;
  return { channel: v.channelId, quality: v.quality, reconnecting: v.reconnecting, route: v.route ?? null, muted: v.muted, deafened: v.deafened, screen: v.screen, stats: await collectStats() };
}

async function collectStats(): Promise<Stats> {
  const out: Stats = { rtt: null, jitter: null, lost: null, codec: '—', recv: [] };
  if (!room || !lk) return out;
  const { Track } = lk;
  const local = await room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.getRTCStatsReport().catch(() => undefined);
  local?.forEach((s: any) => {
    if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') {
      if (s.roundTripTime != null) out.rtt = Math.round(s.roundTripTime * 1000);
      if (s.jitter != null) out.jitter = Math.round(s.jitter * 1000);
      if (s.fractionLost != null) out.lost = +(s.fractionLost * 100).toFixed(1);
    }
    if (s.type === 'outbound-rtp' && s.kind === 'audio') out.bytesSent = s.bytesSent;
    if (s.type === 'codec' && /audio/.test(s.mimeType || '')) out.codec = `${s.mimeType.split('/')[1]} ${Math.round((s.clockRate || 0) / 1000)} кГц`;
    if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null && out.rtt == null) out.rtt = Math.round(s.currentRoundTripTime * 1000);
  });
  for (const p of room.remoteParticipants.values() as Iterable<RemoteParticipant>) {
    const r = await p.getTrackPublication(Track.Source.Microphone)?.track?.getRTCStatsReport().catch(() => undefined);
    r?.forEach((s: any) => {
      if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
      const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
      out.recv.push({
        name: p.name || p.identity, lost: total ? +((s.packetsLost / total) * 100).toFixed(1) : 0,
        jitter: s.jitter != null ? Math.round(s.jitter * 1000) : null,
        buffer: s.jitterBufferEmittedCount ? Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000) : null,
        concealed: s.totalSamplesReceived ? +((s.concealedSamples / s.totalSamplesReceived) * 100).toFixed(1) : 0,
      });
    });
  }
  return out;
}

/** Маршрут: через какую точку входа (регион) подключён клиент, где медиасервер комнаты и как идёт медиа. */
function RouteInfo() {
  const { t } = useTranslation();
  const r = useVoice((s) => s.route);
  const [entry, setEntry] = useState<string | null>(null);
  useEffect(() => { if (!r?.region) api<{ current: string }>('GET', '/regions').then((x) => setEntry(x.current)).catch(() => {}); }, [r?.region]);
  const name = (id?: string | null) => (id ? `${t('regions.' + id, { defaultValue: id })} (${id})` : '—');
  const proto = r?.proto?.toUpperCase();
  const path = !r?.pair ? t('voice.routeUnknown') : r.pair === 'relay' ? t('voice.routeRelay', { proto }) : t('voice.routeDirect', { proto });
  return (
    <>
      <h3>{t('voice.route')}</h3>
      <div className="stats-grid">
        <span>{t('voice.routeEntry')}</span><b>{name(r?.region ?? entry)}</b>
        <span>{t('voice.routeMedia')}</span><b>{name(r?.mediaRegion)}</b>
        <span>{t('voice.routePath')}</span><b>{path}</b>
      </div>
    </>
  );
}

function QualityModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const [st, setSt] = useState<(Stats & { kbps: number | null }) | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const a = await collectStats();
      await new Promise((r) => setTimeout(r, 1000));
      const b = await collectStats();
      if (alive) setSt({ ...b, kbps: a.bytesSent != null && b.bytesSent != null ? Math.round(((b.bytesSent - a.bytesSent) * 8) / 1000) : null });
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const f = (v: number | null | undefined, u: string) => (v == null ? '—' : `${v} ${u}`);
  return (
    <div className="modal-body">
      <h2>{t('voice.quality')}</h2>
      <RouteInfo />
      {!st ? <p className="muted">…</p> : (
        <>
          <div className="stats-grid">
            <span>{t('voice.ping')}</span><b>{f(st.rtt, 'мс')}</b>
            <span>{t('voice.jitter')}</span><b>{f(st.jitter, 'мс')}</b>
            <span>{t('voice.loss')}</span><b>{f(st.lost, '%')}</b>
            <span>{t('voice.codec')}</span><b>{st.codec}</b>
            <span>{t('voice.bitrate')}</span><b>{f(st.kbps, 'кбит/с')}</b>
          </div>
          {st.recv.length > 0 && (
            <>
              <h3>{t('voice.incoming')}</h3>
              <div className="stats-grid">
                {st.recv.map((r) => [<span key={r.name}>{r.name}</span>,
                  <b key={r.name + 'v'}>{t('voice.recvLine', { lost: r.lost, jitter: f(r.jitter, 'мс'), buffer: f(r.buffer, 'мс'), concealed: r.concealed })}</b>])}
              </div>
            </>
          )}
        </>
      )}
      <SecurityInfo />
      <div className="modal-actions"><Button onClick={close}>{t('modal.close')}</Button></div>
    </div>
  );
}

/** Безопасность соединения: TLS; в приложении — ключ сервера закреплён (отпечаток без адреса). */
export function SecurityInfo() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { if (isDesktop) dinvoke<AppInfo>('app_info').then(setInfo); }, []);
  return (
    <div className="security-info">
      <h3><ShieldCheck size={16} /> {t('voice.security')}</h3>
      <p className="small">{isDesktop && info?.pinned ? t('voice.securityPinned') : t('voice.securityTls')}</p>
      <p className="muted small">{t('voice.securityMedia')}</p>
      {isDesktop && info?.fingerprint && (
        <details className="small">
          <summary className="muted">{t('voice.fingerprint')}</summary>
          <div className="fingerprint">{info.fingerprint}</div>
        </details>
      )}
    </div>
  );
}

export function VoiceSettingsModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const [, bump] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const inVoice = useVoice((v) => v.channelId) != null;
  useEffect(() => { navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {}); }, []);
  const set = <K extends keyof VoiceCfg>(k: K, v: VoiceCfg[K]) => {
    cfg[k] = v; saveCfg(); bump((x) => x + 1);
    if (k === 'output' && room) room.switchActiveDevice('audiooutput', String(v) || 'default').catch(() => {});
    if (k === 'input' && room) room.switchActiveDevice('audioinput', String(v) || 'default').catch(() => {});
    if (k === 'mode') syncMic();
    if (k === 'mode') syncGlobal();
    if ((SYNCED as readonly string[]).includes(k)) saveSetting('voice', accountVoice());
    if (k === 'mode' || k === 'vadAuto' || k === 'vadThreshold' || k === 'vadHangover') syncVad();
  };
  // Проверка микрофона вне голоса: тот же гейт и те же настройки обработки, что в канале (в канале — живой уровень).
  useEffect(() => {
    if (!testing || inVoice) return;
    let stream: MediaStream | null = null, stop: (() => void) | null = null, alive = true;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: cfg.input || undefined, echoCancellation: cfg.echo, noiseSuppression: cfg.noise, autoGainControl: cfg.agc } })
      .then(async (s) => {
        if (!alive) { s.getTracks().forEach((x) => x.stop()); return; }
        stream = s; stop = await startMicTest(s);
        if (!alive) stop();
      })
      .catch(() => { useStore.getState().toast('Нет доступа к микрофону', true); setTesting(false); });
    return () => { alive = false; stop?.(); stream?.getTracks().forEach((x) => x.stop()); };
  }, [testing, inVoice]);
  const devs = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
  return (
    <div className="modal-body">
      <h2>{t('voice.settings')}</h2>
      <div className="grid-2">
        <Field label={t('voice.input')}>
          <select className="input" value={cfg.input} onChange={(e) => set('input', e.target.value)}>
            <option value="">{t('voice.default')}</option>
            {devs('audioinput').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Микрофон ${i + 1}`}</option>)}
          </select>
        </Field>
        <Field label={t('voice.output')}>
          <select className="input" value={cfg.output} onChange={(e) => set('output', e.target.value)}>
            <option value="">{t('voice.default')}</option>
            {devs('audiooutput').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Выход ${i + 1}`}</option>)}
          </select>
        </Field>
      </div>
      <Field label={t('voice.mode')}>
        <select className="input" value={cfg.mode} onChange={(e) => set('mode', e.target.value as VoiceCfg['mode'])}>
          <option value="vad">{t('voice.vad')}</option><option value="ptt">{t('voice.ptt')}</option>
        </select>
      </Field>
      <Field label={cfg.mode === 'vad' ? t('voice.sensitivity') : t('voice.micTest')}>
        <SensitivityMeter vad={cfg.mode === 'vad'} auto={cfg.vadAuto} threshold={cfg.vadThreshold} onThreshold={(v) => set('vadThreshold', v)} />
        <p className="muted small">{inVoice || testing ? (cfg.mode === 'vad' ? t(cfg.vadAuto ? 'voice.sensAutoHint' : 'voice.sensManualHint') : t('voice.levelHint')) : t('voice.testHint')}</p>
      </Field>
      {!inVoice && <Button type="button" onClick={() => setTesting(!testing)}>{testing ? t('voice.stopTest') : t('voice.startTest')}</Button>}
      {cfg.mode === 'vad' && <>
        <Switch label={t('voice.sensAuto')} checked={cfg.vadAuto} onChange={(v) => set('vadAuto', v)} />
        <Field label={`${t('voice.hangover')}: ${cfg.vadHangover} ${t('voice.ms')}`}>
          <input type="range" className="range" min={0} max={1500} step={50} value={cfg.vadHangover} aria-label={t('voice.hangover')} onChange={(e) => set('vadHangover', +e.target.value)} />
          <p className="muted small">{t('voice.hangoverHint')}</p>
        </Field>
      </>}
      {cfg.mode === 'ptt' && (
        <div className="grid-2">
          <Field label={t('voice.pttKey')}><KeybindButton action="ptt" /></Field>
          <Field label={t('voice.pttDelay')}>
            <input className="input" type="number" min={0} max={2000} step={50} value={cfg.pttDelay} onChange={(e) => set('pttDelay', Math.max(0, Math.min(2000, +e.target.value || 0)))} />
          </Field>
        </div>
      )}
      <Switch label={t('voice.echo')} checked={cfg.echo} onChange={(v) => set('echo', v)} />
      <Switch label={t('voice.noise')} checked={cfg.noise} onChange={(v) => set('noise', v)} />
      <Switch label={t('voice.agc')} checked={cfg.agc} onChange={(v) => set('agc', v)} />
      <Switch label={t('voice.sounds')} checked={cfg.sounds} onChange={(v) => set('sounds', v)} />
      <p className="muted small">{t('voice.applyHint')}</p>
      <div className="modal-actions"><Button variant="primary" onClick={close}>{t('modal.done')}</Button></div>
    </div>
  );
}

/** Индикатор своего микрофона со шкалой в дБFS: уровень до гейта; зелёный — гейт открыт (вас слышно).
 *  Голосовая активация: порог — бегунок поверх индикатора (вручную) или метка (автоматически). Обновляется без React. */
function SensitivityMeter({ vad, auto, threshold, onThreshold }: { vad: boolean; auto: boolean; threshold: number; onThreshold(v: number): void }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null), fill = useRef<HTMLDivElement>(null), mark = useRef<HTMLDivElement>(null);
  useEffect(() => onSelfMeter((m: SelfMeter) => {
    if (fill.current) { fill.current.style.width = `${dbToUnit(m.level) * 100}%`; fill.current.classList.toggle('open', !vad || m.open); }
    if (box.current && vad && auto) box.current.style.setProperty('--thr', `${dbToUnit(m.thr) * 100}%`);
  }), [vad, auto]);
  useEffect(() => { if (box.current && vad && !auto) box.current.style.setProperty('--thr', `${dbToUnit(threshold) * 100}%`); }, [vad, auto, threshold]);
  return (
    <div ref={box} className={`vad-meter ${vad ? 'vad' : ''} ${auto ? 'auto' : ''}`}>
      <div className="vad-fill" ref={fill} />
      {vad && <div className="vad-mark" ref={mark} />}
      {vad && !auto && <input type="range" className="vad-range" min={DB_MIN} max={DB_MAX} step={1} value={threshold} aria-label={t('voice.threshold')}
        aria-valuetext={`${threshold} дБ`} onChange={(e) => onThreshold(+e.target.value)} />}
    </div>
  );
}

/** Свой уровень микрофона в панели голоса (зелёный — вас слышно). */
export function MicLevel() {
  const fill = useRef<HTMLDivElement>(null);
  useEffect(() => onSelfMeter((m) => {
    if (!fill.current) return;
    fill.current.style.width = `${dbToUnit(m.level) * 100}%`;
    fill.current.classList.toggle('open', m.open);
  }), []);
  return <div className="mic-level" aria-hidden><div ref={fill} className="mic-level-fill" /></div>;
}

/** Громкость участника 0–200% (показывается, если он в моей комнате). */
export function VolumeControl({ uid }: { uid: number }) {
  const { t } = useTranslation();
  const inRoom = useVoice((s) => s.channelId) != null && !!room?.remoteParticipants.has(String(uid));
  const [v, setV] = useState(Math.round((volumes[uid] ?? 1) * 100));
  if (!inRoom) return null;
  return (
    <label className="volume-row">
      <span>{t('voice.volume')}</span><b>{v}%</b>
      <input type="range" min={0} max={200} step={5} value={v} onChange={(e) => {
        const n = +e.target.value; setV(n); volumes[uid] = n / 100;
        try { localStorage.setItem('relay_vol', JSON.stringify(volumes)); } catch { /* приватный режим */ }
        applyVolumes();
      }} />
    </label>
  );
}

function Signal({ q }: { q: Quality }) {
  const lit = { excellent: 3, good: 2, poor: 1, lost: 0, unknown: 0 }[q];
  return <span className={`signal q-${q}`} aria-hidden>{[0, 1, 2].map((i) => <i key={i} className={i < lit ? 'on' : ''} />)}</span>;
}

/** Панель подключения внизу сайдбара. */
export function VoicePanel() {
  const { t } = useTranslation();
  const modal = useModal();
  const v = useVoice();
  const guild = useStore((s) => s.guilds.find((g) => g.id === v.guildId));
  return (
    <AnimatePresence>
      {v.channelId != null && (
        <motion.div className="voice-panel" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={appear}>
          <button className="voice-status" onClick={() => modal.open((close) => <QualityModal close={close} />)} title={t('voice.qualityHint')}>
            <Signal q={v.quality} />
            <span>
              <b className={v.reconnecting ? 'warn' : 'ok'}>{v.reconnecting ? t('voice.reconnecting') : t('voice.connected')}</b>
              <span className="muted small">{v.name}{guild ? ` / ${guild.name}` : ''}</span>
              <MicLevel />
            </span>
          </button>
          <ScreenAudioButton />
          <IconButton label={t('voice.leave')} tone="danger" onClick={() => leaveVoice()}><PhoneOff size={18} /></IconButton>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Кнопки микрофона/звука/настроек голоса в панели пользователя. */
export function VoiceControls() {
  const { t } = useTranslation();
  const modal = useModal();
  const { muted, deafened } = useVoice();
  return (
    <>
      <IconButton label={muted ? t('voice.unmute') : t('voice.mute')} tone={muted ? 'danger' : undefined} active={muted} onClick={toggleMute}>{muted ? <MicOff size={18} /> : <Mic size={18} />}</IconButton>
      <IconButton label={deafened ? t('voice.undeafen') : t('voice.deafen')} tone={deafened ? 'danger' : undefined} active={deafened} onClick={toggleDeafen}>{deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}</IconButton>
      <IconButton label={t('voice.settings')} onClick={() => modal.open((close) => <VoiceSettingsModal close={close} />)}><Settings2 size={18} /></IconButton>
    </>
  );
}

/** Применить настройки качества к идущей демонстрации без перезапуска (разрешение, FPS, битрейт, режим).
 *  Кодек меняется только при новом запуске демонстрации. */
export async function applyStreamLive() {
  if (!room || !lk) return false;
  const pub = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare);
  const track = pub?.videoTrack as unknown as { mediaStreamTrack: MediaStreamTrack; sender?: RTCRtpSender } | undefined;
  if (!track) return false;
  const c = streamCfg;
  const [w, h] = streamDims(c.res);
  const mst = track.mediaStreamTrack;
  mst.contentHint = contentHint(c.mode) ?? '';
  await mst.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: c.fps, ideal: c.fps } }).catch(() => {});
  const sender = track.sender;
  if (sender) {
    const p = sender.getParameters();
    const top = p.encodings.length - 1;
    p.encodings.forEach((e, i) => { if (i === top || p.encodings.length === 1) { e.maxBitrate = streamBitrate(c) * 1000; e.maxFramerate = c.fps; } });
    (p as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = degradation(c.mode);
    await sender.setParameters(p).catch(() => {});
  }
  return true;
}

/** Статистика видеотрека (для оверлея на плитке): разрешение, FPS, битрейт, кодек. */
export interface VideoStats { width: number; height: number; fps: number; kbps: number; codec: string }
const lastBytes = new Map<unknown, { b: number; t: number }>();
export async function videoStats(track: unknown): Promise<VideoStats | null> {
  const t = track as { getRTCStatsReport?(): Promise<RTCStatsReport | undefined> };
  const rep = await t.getRTCStatsReport?.().catch(() => undefined);
  if (!rep) return null;
  let best: any = null;
  const codecs = new Map<string, string>();
  rep.forEach((s: any) => {
    if (s.type === 'codec') codecs.set(s.id, String(s.mimeType || '').split('/')[1] || '');
    if ((s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && s.kind === 'video' && (!best || (s.frameWidth ?? 0) > (best.frameWidth ?? 0))) best = s;
  });
  if (!best) return null;
  const bytes = best.bytesReceived ?? best.bytesSent ?? 0;
  const now = performance.now();
  const prev = lastBytes.get(track);
  lastBytes.set(track, { b: bytes, t: now });
  const kbps = prev && now > prev.t ? Math.round(((bytes - prev.b) * 8) / (now - prev.t)) : 0;
  return { width: best.frameWidth ?? 0, height: best.frameHeight ?? 0, fps: Math.round(best.framesPerSecond ?? 0), kbps, codec: codecs.get(best.codecId) ?? '' };
}

// Отладка в e2e: доступ к комнате.
(window as unknown as { __relayVoice?: unknown }).__relayVoice = { room: () => room };



/** Нативная трансляция приложения началась/закончилась — флаг «в эфире» для всех. */
export function nativeShareStarted(on: boolean) {
  useVoice.setState({ screen: on, screenAudio: null });
  sendFlags();
  bumpVideo();
  // состояние звука трансляции — у приложения (null — недоступен на этой Windows)
  if (on) dcall<boolean | null>('screen_audio', { on: null })
    .then((a) => { oldApp = false; useVoice.setState({ screenAudio: a ?? null }); sendFlags(); })
    // приложение до 0.12 этой команды не знает: звук там — по настройке трансляции, переключать нельзя
    .catch(() => { oldApp = true; useVoice.setState({ screenAudio: streamCfg.audio ? true : null }); sendFlags(); });
}
let oldApp = false;

/** Звук трансляции — отдельно от микрофона: mute трека звука демонстрации (видео идёт дальше). Зрители видят «без звука». */
export async function toggleScreenAudio() {
  const v = useVoice.getState();
  if (!v.screen) return;
  const want = v.screenAudio !== true;
  try {
    if (isDesktop) {
      if (oldApp) { useStore.getState().toast(i18n.t('stream.audioUpdateApp'), true); return; }
      const a = await dcall<boolean | null>('screen_audio', { on: want });
      if (a == null) { useStore.getState().toast(i18n.t('stream.audioUnavailable'), true); return; }
      useVoice.setState({ screenAudio: a });
    } else {
      const pub = room && lk ? room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShareAudio) : undefined;
      if (!pub) { useStore.getState().toast(i18n.t('stream.audioNotCaptured'), true); return; }
      await (want ? pub.unmute() : pub.mute());
      useVoice.setState({ screenAudio: want });
    }
    sfx(want ? 'unmute' : 'mute');
    sendFlags();
  } catch (e) { useStore.getState().toast((e as Error).message || String(e), true); }
}

/** Кнопка звука трансляции (панель голоса, панель звонка). Только пока идёт трансляция. */
export function ScreenAudioButton({ size = 18, className }: { size?: number; className?: string }) {
  const { t } = useTranslation();
  const { screen, screenAudio } = useVoice();
  if (!screen) return null;
  const on = screenAudio === true;
  return (
    <IconButton label={screenAudio == null ? t('stream.audioNone') : on ? t('stream.audioOff') : t('stream.audioOn')} className={className} tone={on ? undefined : 'danger'} active={!on}
      disabled={screenAudio == null && !isDesktop} onClick={toggleScreenAudio}>
      {on ? <MonitorSpeaker size={size} /> : <VolumeX size={size} />}
    </IconButton>
  );
}

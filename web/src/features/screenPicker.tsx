// Нативная демонстрация экрана в Relay Desktop: свой выбор окна/экрана (как в Discord) вместо системного
// окна браузера. Захват и кодирование делает приложение; здесь — выбор источника и качества.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { AppWindow, Monitor, MonitorUp, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { dcall, type ScreenSource } from '../lib/desktop';
import { streamBitrate, streamCfg, streamCodec, streamDims } from '../lib/streamCfg';
import { appear } from '../design/tokens';
import { Button, IconButton, Skeleton } from '../ui';
import { useStore } from '../store';
import { StreamSettings } from './stream';
import { nativeShareStarted, useVoice, type VoiceIce } from './voice';

/** Параметры публикации из настроек качества (и размеров источника для «Исходного»). */
export async function nativeShareArgs(src: { width: number; height: number } | null) {
  const ch = useVoice.getState().channelId;
  if (ch == null) throw new Error('Сначала подключитесь к голосовому каналу');
  // ice — маршрут медиа точки входа (через edge-регион: TURN узла, только релей) — и для трансляции из приложения.
  const { token, ice, url } = await api<{ token: string; ice?: VoiceIce; url?: string }>('POST', '/voice/screen-token', { channel_id: ch });
  const c = streamCfg;
  const [w, h] = c.res === 'source' && src ? [Math.min(src.width, 3840), Math.min(src.height, 2160)] : streamDims(c.res);
  // url — адрес LiveKit (wss://voice.example.com): приложение ведёт сигнализацию трансляции туда
  return { token, url: url || null, ice: ice?.servers?.length ? ice : null, width: w, height: h, fps: c.fps, codec: streamCodec(c), kbps: streamBitrate(c), mode: c.mode, audio: c.audio, encoder: c.encoder };
}

/** Последний выбранный источник (для «Исходного» разрешения при смене качества на лету). */
export let lastSource: ScreenSource | null = null;
/** Чем сейчас кодируется трансляция (ответ приложения: «Видеокарта · NVIDIA …» или «Процессор · …»). */
export let nativeEncoder: string | null = null;
export const setNativeEncoder = (v: string | null) => { nativeEncoder = v; };

/** Запустить нативную трансляцию источника (окно выбора, горячая клавиша — тот же источник, что в прошлый раз). */
export async function startNativeShare(src: ScreenSource) {
  const args = await nativeShareArgs(src);
  nativeEncoder = await dcall<string>('screen_start', { args: { source: src.id, ...args } });
  lastSource = src;
  nativeShareStarted(true);
}

export function ScreenPicker({ close }: { close(): void }) {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<'window' | 'screen'>('window');
  const [list, setList] = useState<ScreenSource[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setList(null);
    dcall<ScreenSource[]>('screen_sources').then((l) => {
      setList(l);
      if (!l.some((x) => x.kind === 'window')) setTab('screen');
    }).catch((e) => { toast(e.message, true); setList([]); });
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (list ?? []).filter((x) => x.kind === tab);
  const chosen = list?.find((x) => x.id === sel) ?? null;
  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await startNativeShare(chosen);
      // Видеокарта недоступна или звук трансляции нельзя захватить без эха (Windows 10) — говорим об этом.
      const enc = nativeEncoder ?? '';
      if ((enc.startsWith('Процессор') && streamCfg.encoder !== 'cpu') || enc.includes('без звука')) toast(t('stream.encNow', { name: enc }));
      close();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <div className="screen-picker">
      <header className="picker-head">
        <h2><MonitorUp size={20} /> {t('stream.title')}</h2>
        <IconButton label={t('picker.refresh')} onClick={load}><RefreshCw size={16} /></IconButton>
      </header>
      <nav className="th-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'window'} className={`th-tab ${tab === 'window' ? 'on' : ''}`} onClick={() => setTab('window')}><AppWindow size={14} /> {t('picker.apps')}</button>
        <button role="tab" aria-selected={tab === 'screen'} className={`th-tab ${tab === 'screen' ? 'on' : ''}`} onClick={() => setTab('screen')}><Monitor size={14} /> {t('picker.screens')}</button>
      </nav>
      <div className="picker-grid">
        {list == null && [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="picker-card"><Skeleton h={120} r={8} /><Skeleton w="70%" /></div>)}
        {list && shown.length === 0 && <p className="muted picker-empty">{t('picker.empty')}</p>}
        {shown.map((s) => (
          <motion.button key={s.id} className={`picker-card ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)} onDoubleClick={() => { setSel(s.id); }}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={appear} title={s.title}>
            <span className="picker-thumb">{s.thumb ? <img src={s.thumb} alt="" /> : (s.kind === 'screen' ? <Monitor size={32} /> : <AppWindow size={32} />)}</span>
            <span className="picker-title">{s.title}</span>
            <span className="muted small picker-app">{s.app}</span>
          </motion.button>
        ))}
      </div>
      <details className="picker-quality">
        <summary>{t('picker.quality', { res: streamCfg.res === 'source' ? t('stream.source') : streamCfg.res + 'p', fps: streamCfg.fps })}</summary>
        <StreamSettings compact hideSurface />
      </details>
      <div className="modal-actions">
        <Button variant="ghost" onClick={close}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={!chosen || busy} onClick={start}>{t('picker.goLive')}</Button>
      </div>
    </div>
  );
}

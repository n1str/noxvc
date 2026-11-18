// Настройки трансляций: качество демонстрации экрана (перед запуском и на лету), камера, качество просмотра.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonitorUp } from 'lucide-react';
import { Button, Field, Switch } from '../ui';
import { useStore } from '../store';
import { saveStreamCfg, streamBitrate, streamCfg, streamCodec, type StreamCfg } from '../lib/streamCfg';
import { applyStreamLive, nativeShareStarted, toggleScreen, toggleScreenAudio, useVoice } from './voice';
import { dcall, isDesktop } from '../lib/desktop';
import { lastSource, nativeEncoder, nativeShareArgs, setNativeEncoder } from './screenPicker';

export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange(v: T): void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={`seg-item ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

/** Форма качества демонстрации экрана. `compact` — без камеры и просмотра (для окна перед запуском). */
export function StreamSettings({ compact, onChange, hideSurface }: { compact?: boolean; onChange?(c: StreamCfg): void; hideSurface?: boolean }) {
  const { t } = useTranslation();
  const [c, setC] = useState<StreamCfg>({ ...streamCfg });
  const [adv, setAdv] = useState(c.codec !== 'auto' || c.bitrate > 0);
  const set = (patch: Partial<StreamCfg>) => { const n = { ...c, ...patch }; setC(n); saveStreamCfg(patch); onChange?.(n); };
  return (
    <div className="stream-settings">
      <Field label={t('stream.resolution')}>
        <Seg label={t('stream.resolution')} value={c.res} onChange={(res) => set({ res })} options={[['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['source', t('stream.source')]]} />
      </Field>
      <Field label={t('stream.fps')}>
        <Seg label={t('stream.fps')} value={c.fps} onChange={(fps) => set({ fps })} options={[[15, '15'], [30, '30'], [60, '60']]} />
      </Field>
      <Field label={t('stream.mode')}>
        <Seg label={t('stream.mode')} value={c.mode} onChange={(mode) => set({ mode })} options={[['auto', t('stream.modeAuto')], ['motion', t('stream.modeMotion')], ['detail', t('stream.modeDetail')]]} />
      </Field>
      <p className="muted small">{t(`stream.modeHint_${c.mode}`)}</p>
      {isDesktop && (
        <>
          <Field label={t('stream.encoder')}>
            <Seg label={t('stream.encoder')} value={c.encoder} onChange={(encoder) => set({ encoder })} options={[['auto', t('stream.encAuto')], ['gpu', t('stream.encGpu')], ['cpu', t('stream.encCpu')]]} />
          </Field>
          <p className="muted small">{t('stream.encHint')}{nativeEncoder && <><br /><b className="enc-now">{t('stream.encNow', { name: nativeEncoder })}</b></>}</p>
        </>
      )}
      {!hideSurface && <Field label={t('stream.surface')}>
        <Seg label={t('stream.surface')} value={c.surface} onChange={(surface) => set({ surface })} options={[['any', t('stream.surfAny')], ['monitor', t('stream.surfScreen')], ['window', t('stream.surfWindow')], ['browser', t('stream.surfTab')]]} />
      </Field>}
      <Switch label={t('stream.audio')} checked={c.audio} onChange={(audio) => set({ audio })} />
      <button type="button" className="link-btn small" onClick={() => setAdv(!adv)}>{adv ? t('stream.hideAdvanced') : t('stream.advanced')}</button>
      {adv && (
        <div className="stream-adv">
          {/* В приложении трансляция всегда в H.264 — выбора кодека нет. */}
          {!isDesktop && <Field label={t('stream.codec')}>
            <Seg label={t('stream.codec')} value={c.codec} onChange={(codec) => set({ codec })} options={[['auto', t('stream.auto')], ['h264', 'H.264'], ['vp8', 'VP8'], ['vp9', 'VP9'], ['av1', 'AV1']]} />
          </Field>}
          <Field label={`${t('stream.bitrate')}: ${c.bitrate > 0 ? `${(c.bitrate / 1000).toFixed(1)} ${t('stream.mbps')}` : `${t('stream.auto')} (${(streamBitrate(c) / 1000).toFixed(1)} ${t('stream.mbps')})`}`}>
            <input type="range" className="range" min={0} max={30000} step={500} value={c.bitrate} aria-label={t('stream.bitrate')} onChange={(e) => set({ bitrate: +e.target.value })} />
          </Field>
          {!isDesktop && <p className="muted small">{t('stream.codecHint', { codec: streamCodec(c).toUpperCase() })}</p>}
        </div>
      )}
      {!compact && (
        <>
          <h4 className="section-label">{t('stream.camera')}</h4>
          <Field label={t('stream.resolution')}>
            <Seg label={t('stream.camera')} value={c.camRes} onChange={(camRes) => set({ camRes })} options={[['480', '480p'], ['720', '720p'], ['1080', '1080p']]} />
          </Field>
          <Field label={t('stream.fps')}>
            <Seg label={t('stream.camera') + ' FPS'} value={c.camFps} onChange={(camFps) => set({ camFps })} options={[[30, '30'], [60, '60']]} />
          </Field>
          <h4 className="section-label">{t('stream.viewing')}</h4>
          <Switch label={t('stream.viewMax')} checked={c.viewMax} onChange={(viewMax) => set({ viewMax })} />
          <p className="muted small">{t('stream.viewHint')}</p>
        </>
      )}
    </div>
  );
}

/** Окно перед запуском демонстрации (или изменение качества идущей — без повторного выбора окна). */
/** Звук идущей трансляции — сразу, без «Применить» (видео не перезапускается). */
function LiveAudioSwitch() {
  const { t } = useTranslation();
  const a = useVoice((v) => v.screenAudio);
  if (a == null && !isDesktop) return <p className="muted small">{t('stream.audioNone')}</p>;
  return <Switch label={t('stream.audioLive')} checked={a === true} onChange={() => toggleScreenAudio()} />;
}

export function StreamModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const live = useVoice((v) => v.screen);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-body stream-modal">
      <h2><MonitorUp size={20} /> {t(live ? 'stream.titleLive' : 'stream.title')}</h2>
      <StreamSettings compact hideSurface={isDesktop} />
      {live && <LiveAudioSwitch />}
      {live && <p className="muted small">{t('stream.liveHint')}</p>}
      <div className="modal-actions">
        <Button variant="ghost" onClick={close}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          if (live && isDesktop) {
            // Нативная трансляция: тот же источник, новая публикация с новым качеством.
            // звук — как сейчас в эфире (его переключают отдельно), а не из настроек следующего запуска
            const audioNow = useVoice.getState().screenAudio;
            try {
              const args = { ...(await nativeShareArgs(lastSource)), ...(audioNow != null && { audio: audioNow }) };
              setNativeEncoder(await dcall<string>('screen_update', { args }));
              nativeShareStarted(true); // перечитать состояние звука новой публикации
              toast(t('stream.applied'));
            } catch (e) { toast((e as Error).message, true); }
          } else if (live) { if (await applyStreamLive()) toast(t('stream.applied')); }
          else await toggleScreen();
          close();
        }}>{t(live ? 'stream.apply' : 'stream.start')}</Button>
      </div>
    </div>
  );
}

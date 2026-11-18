// Настройки пользователя: учётная запись, профиль (с предпросмотром), конфиденциальность, уведомления, голос, внешний вид.
import { useRef, useState, type ReactNode } from 'react';
import { GamesTab } from './activity';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { ImagePlus, LogOut, Palette, Trash2, Upload, X } from 'lucide-react';
import { api, uploadFile } from '../lib/api';
import { devicePrefs, requestDesktop } from '../lib/notify';
import { setLanguage } from '../i18n';
import { spring } from '../design/tokens';
import { Avatar, Button, Field, IconButton, Input, Switch } from '../ui';
import { useModal } from '../ui/overlays';
import { useStore, type Me } from '../store';
import { FormModal } from './modals';
import { SessionsSection } from './sessions';
import { SecurityInfo, VoiceSettingsModal } from './voice';
import { HotkeysTab } from './hotkeys';
import { Seg } from './stream';
import { onTheme, setTheme, themePref, type ThemePref } from '../lib/theme';
import { FeedbackAdminTab, FeedbackTab } from './feedback';
import { InvitesAdminTab, MyInvitesTab } from './invites';
import { UpdateRow } from './updates';
import { AvatarCrop, MediaCrop, type Crop, type MediaLimits } from './avatarCrop';
import { accentVars, cardAccent, dominantOfFile, ProfileBanner, type Banner } from './banner';
import { StreamSettings } from './stream';
import { dcall, dinvoke, isDesktop, type AppInfo } from '../lib/desktop';
import { useVoice } from './voice';
import { useEffect } from 'react';

type Tab = 'account' | 'profile' | 'privacy' | 'notifications' | 'voice' | 'keys' | 'video' | 'appearance' | 'games' | 'app' | 'download' | 'invites' | 'feedback' | 'admin' | 'invadmin';
const TABS: Tab[] = ['account', 'profile', 'privacy', 'notifications', 'voice', 'keys', 'video', 'appearance', 'games', ...(isDesktop ? ['app' as const] : ['download' as const])];
const BANNERS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#2c2f33'];

function Radio<T extends string>({ value, options, onChange, name }: { value: T; options: [T, string][]; onChange(v: T): void; name: string }) {
  return (
    <div className="radio-list" role="radiogroup">
      {options.map(([v, label]) => (
        <label key={v} className={`radio-row ${value === v ? 'on' : ''}`}>
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function UsernameModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me)!;
  return (
    <FormModal title={t('us.changeUsername')} submit={t('modal.save')} close={close}
      onSubmit={(fd) => api('PATCH', '/me', { username: fd.get('username'), password: fd.get('password') })}>
      <Input name="username" label={t('us.username')} defaultValue={me.username} maxLength={32} autoFocus />
      <Input name="password" type="password" label={t('us.currentPassword')} autoComplete="current-password" />
    </FormModal>
  );
}

function PasswordModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  return (
    <FormModal title={t('us.changePassword')} submit={t('modal.save')} close={close} onSubmit={async (fd) => {
      if (fd.get('new') !== fd.get('repeat')) throw new Error(t('us.mismatch'));
      const r = await api<{ signed_out: number }>('POST', '/me/password', { current: fd.get('current'), new: fd.get('new'), sign_out_others: fd.get('others') === 'on' });
      toast(r.signed_out ? t('us.passwordChanged', { n: r.signed_out }) : t('us.passwordChangedOnly'));
    }}>
      <Input name="current" type="password" label={t('us.currentPassword')} autoComplete="current-password" autoFocus />
      <Input name="new" type="password" label={t('us.newPassword')} autoComplete="new-password" minLength={6} />
      <Input name="repeat" type="password" label={t('us.repeatPassword')} autoComplete="new-password" minLength={6} />
      {/* при смене пароля — предложить завершить остальные сеансы (по умолчанию — да) */}
      <label className="check-row"><input type="checkbox" name="others" defaultChecked /> <span>{t('us.signOutOthers')}</span></label>
    </FormModal>
  );
}

function AccountTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const modal = useModal();
  return (
    <div className="us-account">
      <div className="us-card">
        <ProfileBanner className="us-card-banner" banner={me.banner} color={me.banner_color ?? me.color} />
        <div className="us-card-head"><Avatar user={{ ...me, presence: me.presence === 'invisible' ? 'offline' : me.presence }} size={72} status /><h3>{me.display_name}</h3></div>
        <div className="us-card-rows">
          <div className="us-row"><div><span className="muted small">{t('us.displayName')}</span><div>{me.display_name}</div></div></div>
          <div className="us-row"><div><span className="muted small">{t('us.username')}</span><div>@{me.username}</div></div><Button size="sm" variant="ghost" onClick={() => modal.open((close) => <UsernameModal close={close} />)}>{t('us.edit')}</Button></div>
          <div className="us-row"><div><span className="muted small">{t('us.password')}</span><div>••••••••</div></div><Button size="sm" variant="ghost" onClick={() => modal.open((close) => <PasswordModal close={close} />)}>{t('us.changePassword')}</Button></div>
        </div>
      </div>
      <SessionsSection />
    </div>
  );
}

const BANNER_LIMITS: MediaLimits = { maxBytes: 20 * 1048576, maxSide: 4096, maxVideoSec: 60 };
const BANNER_TYPES = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/;
const bannerFileOk = (f: File) => BANNER_TYPES.test(f.type) || /\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(f.name);

/** Мини-копия полного профиля для живого превью (та же разметка, что у ProfileModal, в масштабе 1:2). */
function FullProfilePreview({ me, d }: { me: Me; d: { display_name: string; pronouns: string; status: string; bio: string; banner: Banner | null; banner_color: string | null; avatar: string | null } }) {
  const accent = cardAccent(d.banner, d.banner_color);
  return (
    <div className="us-full-preview" aria-hidden>
      <div className={`profile-modal ${accent ? 'accented' : ''}`} style={accentVars(accent)}>
        <ProfileBanner className="profile-modal-banner" banner={d.banner} color={d.banner_color ?? me.color} animate />
        <div className="profile-modal-head"><Avatar user={{ ...me, avatar: d.avatar, presence: me.presence === 'invisible' ? 'offline' : me.presence }} size={132} status play /></div>
        <div className="profile-modal-name">
          <h2>{d.display_name}</h2>
          <div className="muted">@{me.username}{d.pronouns && <> · {d.pronouns}</>}</div>
          {d.status && <div className="small">{d.status}</div>}
        </div>
        <div className="profile-modal-body">{d.bio && <p className="profile-bio">{d.bio}</p>}</div>
      </div>
    </div>
  );
}

/** Новый аватар до сохранения: исходник на сервере + область кадра; still — кадрированный первый кадр (локально, для превью). */
interface AvatarNew { url: string; crop: Crop; still: string; anim: boolean }
const profileDraft = (m: Me) => ({
  display_name: m.display_name, status: m.status ?? '', bio: m.bio ?? '', pronouns: m.pronouns ?? '',
  banner_color: m.banner_color ?? null, avatar: m.avatar ?? null, avatarNew: null as AvatarNew | null, banner: m.banner ?? null,
});
const isVideoFile = (f: File) => /^video\//.test(f.type) || /\.(mp4|webm)$/i.test(f.name);

function ProfileTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const init = profileDraft(me);
  const [d, setD] = useState(init);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(init);
  const set = (patch: Partial<typeof d>) => setD((x) => ({ ...x, ...patch }));
  const modal = useModal();
  // Пока сервер обрабатывает сохранённое — показываем то, что выбрали (локальный кадр), а не старое.
  const [local, setLocal] = useState<{ avatar?: string; avatarAnim?: boolean; banner?: Banner | null }>({});
  // Обработка закончилась (или аватар/баннер сменились с другого устройства) — черновик подхватывает новое,
  // если человек эти поля с тех пор не трогал; иначе осталась бы плашка «несохранённые изменения».
  const base = useRef({ avatar: init.avatar, banner: init.banner });
  useEffect(() => {
    const was = base.current;
    base.current = { avatar: me.avatar ?? null, banner: me.banner ?? null };
    setD((x) => ({
      ...x,
      avatar: !x.avatarNew && x.avatar === was.avatar ? me.avatar ?? null : x.avatar,
      banner: JSON.stringify(x.banner) === JSON.stringify(was.banner) ? me.banner ?? null : x.banner,
    }));
  }, [me.avatar, me.banner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!me.avatar_pending) setLocal((l) => (l.avatar ? { ...l, avatar: undefined, avatarAnim: undefined } : l)); }, [me.avatar_pending, me.avatar]);
  useEffect(() => { if (!me.banner_pending) setLocal((l) => (l.banner !== undefined ? { ...l, banner: undefined } : l)); }, [me.banner_pending, me.banner]);
  // Выбранный файл → кадрирование (1:1, превью в реальных размерах) → исходник на сервер; кадрирует и режет на размеры сервер.
  const pick = (f?: File | null) => {
    if (input.current) input.current.value = ''; // тот же файл можно выбрать повторно
    if (!f) return;
    if (!bannerFileOk(f)) { toast(t('banner.formats'), true); return; }
    modal.open((close) => <AvatarCrop file={f} close={close} onDone={async (r) => {
      setBusy(true);
      try {
        const url = (await uploadFile(r.source, () => {}).promise).url;
        set({ avatarNew: { url, crop: r.crop, still: URL.createObjectURL(r.still), anim: r.animated } });
      } finally { setBusy(false); }
    }} />);
  };

  // ---------- баннер: файл (кнопка, перетаскивание, вставка) → кадрирование 3:1 → загрузка ----------
  const pickBanner = (f?: File | null) => {
    if (bannerInput.current) bannerInput.current.value = '';
    if (!f) return;
    if (!bannerFileOk(f)) { toast(t('banner.formats'), true); return; }
    modal.open((close) => (
      <MediaCrop file={f} close={close} aspect={3} outW={1500} title={t('banner.cropTitle')} hint={t('banner.cropHint')} limits={BANNER_LIMITS}
        onDone={async (r) => {
          setBusy(true); setPct(0);
          try {
            // Исходник — на сервер (он кадрирует, уменьшает, убирает метаданные и звук); кадр — локально, для превью и акцента.
            const accent = await dominantOfFile(r.still);
            const url = (await uploadFile(r.source, (p) => setPct(Math.round(p * 100))).promise).url;
            const banner: Banner = { url, poster: URL.createObjectURL(r.still), kind: r.animated ? (isVideoFile(r.source) ? 'video' : 'gif') : 'image', crop: r.crop, accent };
            set({ banner });
          } finally { setBusy(false); setPct(null); }
        }} />
    ), { wide: false });
  };
  // Вставка из буфера (Ctrl+V) — пока открыта вкладка «Профиль»; текст в полях вставляется как обычно.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find(bannerFileOk);
      if (!f) return;
      e.preventDefault();
      pickBanner(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setOver(false); pickBanner(e.dataTransfer.files[0]); },
  };

  const save = async () => {
    setBusy(true);
    // Аватар и баннер отправляем, только если они изменились (сервер проверяет и обрабатывает файлы заново).
    const { banner, avatar, avatarNew, ...rest } = d;
    const body: Record<string, unknown> = { ...rest };
    if (avatarNew) body.avatar = { url: avatarNew.url, crop: avatarNew.crop };
    else if (avatar !== init.avatar) body.avatar = avatar;
    const bannerChanged = JSON.stringify(banner) !== JSON.stringify(init.banner);
    if (bannerChanged) body.banner = banner ? { url: banner.url, crop: banner.crop, accent: banner.accent } : null;
    try {
      const saved = await api<Me>('PATCH', '/me', body);
      // Ответ и событие «обработано» (gateway) приходят разными путями: быстрая обработка может обогнать ответ.
      // Черновик — из самого свежего состояния, иначе устаревший ответ (avatar: null, «обрабатывается») затрёт готовый аватар.
      const fresh = useStore.getState().me;
      const latest = fresh && !fresh.avatar_pending && saved.avatar_pending ? { ...saved, ...fresh } : saved;
      base.current = { avatar: latest.avatar ?? null, banner: latest.banner ?? null };
      setLocal({ avatar: avatarNew?.still, avatarAnim: avatarNew?.anim, banner: bannerChanged && banner ? banner : undefined });
      setD(profileDraft(latest));
      toast(t('us.saved'));
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  // Превью: несохранённый выбор → сохранённый, но ещё обрабатываемый → текущий.
  const shownAvatar = d.avatarNew?.still ?? (me.avatar_pending && local.avatar) ?? d.avatar;
  const shownBanner = JSON.stringify(d.banner) !== JSON.stringify(init.banner) ? d.banner : me.banner_pending && local.banner !== undefined ? local.banner : d.banner;
  const preview = { ...me, ...d, avatar: shownAvatar || null, avatar_anim: d.avatarNew || local.avatar ? false : me.avatar_anim, presence: me.presence === 'invisible' ? 'offline' as const : me.presence };
  const accent = cardAccent(shownBanner, d.banner_color);
  const pv = { ...d, banner: shownBanner, avatar: preview.avatar };
  return (
    <div className="us-profile">
      <div className="us-profile-form">
        <Field label={t('us.avatar')}>
          <div className="row">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => input.current?.click()}><Upload size={14} />{t('us.changeAvatar')}</Button>
            {(d.avatar || d.avatarNew) && <Button size="sm" variant="ghost" onClick={() => set({ avatar: null, avatarNew: null })}>{t('us.removeAvatar')}</Button>}
            {me.avatar_pending && <span className="media-pending small">{t('crop.processing')}</span>}
            <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" onChange={(e) => pick(e.target.files?.[0])} />
          </div>
        </Field>
        <Field label={t('us.banner')}>
          <div className={`banner-drop ${over ? 'over' : ''}`} {...dropProps} role="button" tabIndex={0} aria-label={t('banner.upload')}
            onClick={() => !busy && bannerInput.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && bannerInput.current?.click()}>
            <ProfileBanner banner={shownBanner} color={d.banner_color ?? me.color} />
            <span className={`banner-drop-hint ${d.banner && pct == null && !over ? 'on-hover' : ''}`}>
              {pct != null ? t('banner.uploading', { n: pct }) : <><ImagePlus size={18} />{t('banner.dropHint')}</>}
            </span>
          </div>
          <input ref={bannerInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" onChange={(e) => pickBanner(e.target.files?.[0])} />
          <div className="row banner-actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => bannerInput.current?.click()}><ImagePlus size={14} />{d.banner ? t('banner.change') : t('banner.upload')}</Button>
            {d.banner && <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ banner: null, banner_color: d.banner?.accent ?? d.banner_color })}><Palette size={14} />{t('banner.useColor')}</Button>}
            {(d.banner || d.banner_color) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ banner: null, banner_color: null })}><Trash2 size={14} />{t('banner.remove')}</Button>}
            {me.banner_pending && <span className="media-pending small">{t('crop.processing')}</span>}
          </div>
          {!d.banner && (
            <div className="banner-swatches">
              {BANNERS.map((c) => <button key={c} type="button" className={`banner-swatch ${d.banner_color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => set({ banner_color: c })} />)}
              <input type="color" className="banner-custom" value={d.banner_color ?? '#5865f2'} onChange={(e) => set({ banner_color: e.target.value })} aria-label={t('us.banner')} />
            </div>
          )}
          <p className="muted small">{t('banner.formats')}</p>
        </Field>
        <Input label={t('us.displayName')} value={d.display_name} maxLength={32} onChange={(e) => set({ display_name: e.target.value })} />
        <Input label={t('us.pronouns')} value={d.pronouns} maxLength={40} onChange={(e) => set({ pronouns: e.target.value })} />
        <Input label={t('us.status')} value={d.status} maxLength={128} placeholder={t('presence.customPlaceholder')} onChange={(e) => set({ status: e.target.value })} />
        <Field label={`${t('us.bio')} · ${190 - d.bio.length}`}>
          <textarea className="input textarea" rows={4} maxLength={190} value={d.bio} onChange={(e) => set({ bio: e.target.value })} aria-label={t('us.bio')} />
        </Field>
      </div>
      <div className="us-preview">
        <span className="muted small">{t('us.preview')}</span>
        <div className={`profile-card us-preview-card ${accent ? 'accented' : ''}`} style={accentVars(accent)}>
          <ProfileBanner className="profile-banner" banner={shownBanner} color={d.banner_color ?? me.color} animate />
          <Avatar user={preview} size={92} status play />
          <div><b>{d.display_name}</b><div className="muted small">@{me.username}{d.pronouns && ` · ${d.pronouns}`}</div></div>
          {d.status && <div className="small">{d.status}</div>}
          {d.bio && <div className="profile-bio small">{d.bio}</div>}
          <button type="button" className="btn btn-primary btn-md" tabIndex={-1}>{t('profile.message')}</button>
        </div>
        <span className="muted small">{t('banner.fullPreview')}</span>
        <FullProfilePreview me={me} d={pv} />
      </div>
      <AnimatePresence>
        {dirty && (
          <motion.div className="unsaved-bar" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={spring}>
            <span>{t('us.unsaved')}</span>
            <Button size="sm" variant="ghost" onClick={() => setD(init)}>{t('us.reset')}</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={save}>{t('us.save')}</Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PrivacyTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const p = me.privacy ?? { friend_requests: 'everyone', dm_from: 'everyone' };
  const save = (patch: Partial<typeof p>) => api('PATCH', '/me', { privacy: { ...p, ...patch } }).catch((e) => toast(e.message, true));
  const blocked = Object.values(useStore((s) => s.relationships)).filter((r) => r.kind === 2);
  return (
    <div className="us-section">
      <Field label={t('us.friendRequests')}>
        <Radio name="fr" value={p.friend_requests} onChange={(v) => save({ friend_requests: v })} options={[['everyone', t('us.frEveryone')], ['mutual', t('us.frMutual')], ['none', t('us.frNone')]]} />
      </Field>
      <Field label={t('us.dmFrom')}>
        <Radio name="dm" value={p.dm_from} onChange={(v) => save({ dm_from: v })} options={[['everyone', t('us.dmEveryone')], ['friends', t('us.dmFriends')]]} />
      </Field>
      <Field label={`${t('us.blockedUsers')} — ${blocked.length}`}>
        <div className="blocked-list">
          {blocked.map((r) => (
            <div key={r.id} className="mutual-row"><Avatar user={r.user} size={28} /><span className="grow">{r.user.display_name} <span className="muted small">@{r.user.username}</span></span>
              <Button size="sm" variant="ghost" onClick={() => api('DELETE', `/relationships/${r.id}`).catch((e) => toast(e.message, true))}>{t('friends.unblock')}</Button></div>
          ))}
        </div>
      </Field>
    </div>
  );
}

function NotificationsTab() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [sound, setSound] = useState(devicePrefs.sound);
  const [desktop, setDesktop] = useState(devicePrefs.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted');
  return (
    <div className="us-section">
      <Switch label={t('notify.sound')} checked={sound} onChange={(v) => { devicePrefs.sound = v; setSound(v); }} />
      <Switch label={t('notify.desktop')} checked={desktop} onChange={async (v) => {
        if (v && !(await requestDesktop())) { toast(t('notify.desktopDenied'), true); return; }
        devicePrefs.desktop = v; setDesktop(v);
      }} />
      <p className="muted small">{t('notify.muteHint')}</p>
    </div>
  );
}

interface Endpoints { list: { id: string; state: 'ok' | 'offline' | 'untrusted'; ms: number | null }[]; current: string; preferred: string | null }

/** Точка входа (регион) в приложении: автоматически или выбранная; состояние и задержка каждой. */
function EndpointPicker() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [d, setD] = useState<Endpoints | null>(null);
  const load = () => dinvoke<Endpoints>('endpoints').then((x) => x && setD(x));
  useEffect(() => { load(); }, []);
  if (!d || d.list.length < 2) return null; // старое приложение или одна точка входа
  const name = (id: string) => `${t('regions.' + id, { defaultValue: id })} (${id})`;
  const state = (x: Endpoints['list'][number]) => (x.state === 'ok' ? `${x.ms} мс` : x.state === 'untrusted' ? t('app.endpointUntrusted') : t('app.endpointDown'));
  const choose = async (id: string | null) => {
    const v = useVoice.getState();
    try {
      await dcall('endpoint_prefer', { id, resume: { view: useStore.getState().view, voice: v.guildId != null ? v.channelId : null } });
      load();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Field label={t('app.endpoint')}>
      <select className="input" value={d.preferred ?? ''} onChange={(e) => choose(e.target.value || null)} aria-label={t('app.endpoint')}>
        <option value="">{t('app.endpointAuto')}</option>
        {d.list.map((x) => <option key={x.id} value={x.id} disabled={x.state !== 'ok'}>{name(x.id)} — {state(x)}</option>)}
      </select>
      <p className="muted small">{t('app.endpointNow', { name: name(d.current) })}. {t('app.endpointHint')}</p>
    </Field>
  );
}

/** Веб: «Скачать приложение» — установщик доступен только участникам (публичной витрины нет). */
function DownloadTab() {
  const { t } = useTranslation();
  const [m, setM] = useState<{ version: string; size: number } | null>(null);
  useEffect(() => { fetch('/updates/latest.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then(setM).catch(() => {}); }, []);
  return (
    <div className="us-section">
      <p>{t('dl.about')}</p>
      {m && <p className="muted small">{t('dl.version', { v: m.version, mb: (m.size / 1048576).toFixed(1) })}</p>}
      <div><a className="btn btn-primary btn-md" href="/download/windows">{t('dl.button')}</a></div>
      <p className="muted small">{t('dl.smartscreen')}</p>
    </div>
  );
}

function AppTab() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [auto, setAuto] = useState(false);
  const [tray, setTray] = useState(true);
  useEffect(() => {
    dinvoke<AppInfo>('app_info').then(setInfo);
    dinvoke<boolean>('autostart_get').then((v) => setAuto(!!v));
    dinvoke<boolean>('tray_get').then((v) => setTray(v !== false));
  }, []);
  return (
    <div className="us-section">
      <Switch label={t('app.autostart')} checked={auto} onChange={async (v) => setAuto(!!(await dinvoke<boolean>('autostart_set', { enabled: v })))} />
      <Switch label={t('app.tray')} checked={tray} onChange={async (v) => { const r = await dinvoke<boolean>('tray_set', { enabled: v }); if (r != null) setTray(r); }} />
      <p className="muted small">{t('app.pttHint')}</p>
      <EndpointPicker />
      {info && (
        <div className="us-card-rows app-info">
          <UpdateRow version={info.version} />
        </div>
      )}
      <SecurityInfo />
    </div>
  );
}

function AppearanceTab() {
  const { t, i18n } = useTranslation();
  const [reduce, setReduce] = useState(document.documentElement.dataset.reducedMotion === 'true');
  const [theme, setThemeState] = useState<ThemePref>(themePref());
  useEffect(() => onTheme(setThemeState), []);
  return (
    <div className="us-section">
      <Field label={t('theme.title')}>
        <Seg<ThemePref> label={t('theme.title')} value={theme} onChange={(v) => { setTheme(v); setThemeState(v); }}
          options={[['dark', t('theme.dark')], ['light', t('theme.light')], ['system', t('theme.system')]]} />
        <p className="muted small">{t('theme.hint')}</p>
      </Field>
      <Field label={t('us.language')}>
        <select className="input" value={i18n.language} onChange={(e) => setLanguage(e.target.value as 'ru' | 'en')} aria-label={t('us.language')}>
          <option value="ru">Русский</option><option value="en">English</option>
        </select>
      </Field>
      <Switch label={t('us.reduceMotion')} checked={reduce} onChange={(v) => {
        setReduce(v);
        document.documentElement.dataset.reducedMotion = String(v);
        try { localStorage.setItem('relay_reduced_motion', String(v)); } catch { /* приватный режим */ }
      }} />
    </div>
  );
}

export function UserSettingsModal({ close, tab: initial = 'account' }: { close(): void; tab?: Tab }) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<Tab>(initial);
  if (!me) return null;
  const body: Record<Tab, ReactNode> = {
    account: <AccountTab me={me} />, profile: <ProfileTab me={me} />, privacy: <PrivacyTab me={me} />,
    notifications: <NotificationsTab />, app: <AppTab />, voice: <VoiceSettingsModal close={() => setTab('account')} />, keys: <HotkeysTab />, feedback: <FeedbackTab />, admin: <FeedbackAdminTab />, invites: <MyInvitesTab />, invadmin: <InvitesAdminTab />, download: <DownloadTab />, video: <div className="us-section"><StreamSettings /></div>, appearance: <AppearanceTab />, games: <GamesTab />,
  };
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">{t('us.title')}</div>
        {[...TABS, 'invites' as const, 'feedback' as const, ...(me.is_admin ? ['admin' as const, 'invadmin' as const] : [])].map((k) => (
          <button key={k} className={`settings-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {tab === k && <motion.span layoutId="user-settings-tab" className="settings-tab-bg" transition={spring} />}
            <span>{t(`us.${k}`)}</span>{k === 'feedback' && !!me.feedback_unread && <span className="tab-dot" aria-label={t('fb.unread')} />}{k === 'invadmin' && !!me.invite_pending && <span className="tab-count" aria-label={t('inv.pendingBadge', { n: me.invite_pending })}>{me.invite_pending}</span>}
          </button>
        ))}
        <div className="settings-sep" />
        <button className="settings-tab danger" onClick={() => { close(); useStore.getState().logout(); }}><LogOut size={14} /><span>{t('us.logout')}</span></button>
      </nav>
      <section className="settings-body">
        <header className="settings-head"><h2>{t(`us.${tab}`)}</h2><IconButton label={t('settings.close')} onClick={close}><X size={20} /></IconButton></header>
        <AnimatePresence mode="wait">
          <motion.div key={tab} className="settings-content" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            {body[tab]}
          </motion.div>
        </AnimatePresence>
      </section>
    </div>
  );
}

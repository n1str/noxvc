// «Входящие» (упоминания и ответы), настройки уведомлений сервера/канала, «отметить прочитанным».
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import { api } from '../lib/api';
import { devicePrefs, requestDesktop } from '../lib/notify';
import { Avatar, Button, Field, IconButton, Skeleton, Switch } from '../ui';
import { usePopover, type MenuItem } from '../ui/overlays';
import { notifyFor, unreadOf, useStore, type Channel, type Message } from '../store';
import { Markdown, TokenCtx, type TokenResolver } from './markdown';
import { FormModal } from './modals';

interface InboxItem { message: Message; channel_name: string; guild_id: number | null; guild_name: string | null }

function InboxPanel({ onDone }: { onDone(): void }) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [done, setDone] = useState(false);
  const load = async (before?: number) => {
    const page = await api<InboxItem[]>('GET', `/inbox?limit=25${before ? `&before=${before}` : ''}`).catch(() => []);
    setItems((x) => [...(before ? x ?? [] : []), ...page]);
    setDone(page.length < 25);
  };
  useEffect(() => { load(); }, []);
  const users = useStore((s) => s.users);
  const guild = useStore((s) => s.guild);
  const resolver = useMemo<TokenResolver>(() => ({
    user: (id) => users[id]?.display_name,
    role: (id) => guild?.roles.find((r) => r.id === id),
    channel: (id) => guild?.channels.find((c) => c.id === id)?.name,
  }), [users, guild]);
  const open = (x: InboxItem) => { onDone(); location.hash = `#msg/${x.guild_id ?? 'dm'}/${x.message.channel_id}/${x.message.id}`; };
  return (
    <div className="inbox" role="dialog" aria-label={t('inbox.title')}>
      <header className="inbox-head"><Inbox size={18} /><h3>{t('inbox.title')}</h3></header>
      <div className="inbox-list">
        {items == null ? [0, 1, 2].map((i) => <div key={i} className="inbox-item"><Skeleton h={48} /></div>) : null}
        {items?.length === 0 && <p className="muted inbox-empty">{t('inbox.empty')}</p>}
        <TokenCtx.Provider value={resolver}>
          {items?.map((x) => (
            <button key={x.message.id} className="inbox-item" onClick={() => open(x)}>
              <div className="inbox-where">{x.guild_id == null ? t('inbox.dm') : <>#{x.channel_name} · {x.guild_name}</>}</div>
              <div className="inbox-msg">
                <Avatar user={x.message.author} size={32} />
                <div className="inbox-body">
                  <div><b>{x.message.author.display_name}</b> <span className="muted small">{new Date(x.message.created_at).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
                  <div className="inbox-text"><Markdown text={x.message.content.slice(0, 300)} /></div>
                </div>
              </div>
            </button>
          ))}
        </TokenCtx.Provider>
        {items && items.length > 0 && !done && <Button variant="ghost" size="sm" onClick={() => load(items.at(-1)!.message.id)}>{t('inbox.more')}</Button>}
      </div>
    </div>
  );
}

/** Кнопка «Входящие» в шапке чата; точка — есть непрочитанные упоминания где угодно. */
export function InboxButton() {
  const { t } = useTranslation();
  const pop = usePopover();
  const mentions = useStore((s) => Object.values(s.reads).reduce((n, r) => n + r.mention_count, 0));
  return (
    <span className="inbox-btn">
      <IconButton label={t('inbox.open')} onClick={(e) => pop.show(e.currentTarget.getBoundingClientRect(), <InboxPanel onDone={pop.hide} />)}><Inbox size={20} /></IconButton>
      {mentions > 0 && <span className="inbox-dot" aria-hidden />}
    </span>
  );
}

const MUTES: [string, number | null][] = [['muteNone', null], ['mute15', 15], ['mute1h', 60], ['mute8h', 480], ['mute24h', 1440], ['muteForever', -1]];

export function NotificationSettingsModal({ guildId, guildName, channel, close }: { guildId: number | null; guildName: string; channel?: Channel; close(): void }) {
  const { t, i18n } = useTranslation();
  const s = useStore();
  const own = s.notify.find((x) => (channel ? x.channel_id === channel.id : x.guild_id === guildId));
  const serverLevel = notifyFor(s, -1, guildId).level;
  const levels = [t('notify.all'), t('notify.mentions'), t('notify.nothing')];
  const [level, setLevel] = useState<number>(own?.level ?? (channel ? -1 : serverLevel));
  const mutedNow = own?.muted_until != null && (own.muted_until === -1 || own.muted_until > Date.now());
  const [mute, setMute] = useState<string>(mutedNow ? (own!.muted_until === -1 ? 'muteForever' : 'keep') : 'muteNone');
  const [suppress, setSuppress] = useState(!!own?.suppress_everyone);
  const [sound, setSound] = useState(devicePrefs.sound);
  const [desktop, setDesktop] = useState(devicePrefs.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const submit = async () => {
    devicePrefs.sound = sound;
    devicePrefs.desktop = desktop;
    const minutes = MUTES.find(([k]) => k === mute)?.[1];
    const muted_until = mute === 'keep' ? own!.muted_until : minutes == null ? null : minutes === -1 ? -1 : Date.now() + minutes * 60_000;
    const target = channel ? { channel_id: channel.id } : { guild_id: guildId };
    // Канал «как на сервере» и без заглушения — настройку удаляем совсем.
    const lvl = channel && level === -1 ? (muted_until == null ? -1 : serverLevel) : level;
    if (guildId == null && !channel) return;
    await api('PUT', '/notification-settings', { ...target, level: lvl, muted_until, suppress_everyone: suppress });
  };
  return (
    <FormModal title={t('notify.titleFor', { name: channel ? '#' + channel.name : guildName })} submit={t('notify.save')} close={close} onSubmit={submit}>
      <Field label={t('notify.level')}>
        <div className="radio-list" role="radiogroup">
          {(channel ? [-1, 0, 1, 2] : [0, 1, 2]).map((v) => (
            <label key={v} className={`radio-row ${level === v ? 'on' : ''}`}>
              <input type="radio" name="level" checked={level === v} onChange={() => setLevel(v)} />
              <span>{v === -1 ? t('notify.inherit', { level: levels[serverLevel] }) : levels[v]}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={t('notify.mute')} hint={t('notify.muteHint')}>
        <select className="input" value={mute} onChange={(e) => setMute(e.target.value)} aria-label={t('notify.mute')}>
          {mute === 'keep' && <option value="keep">{t('notify.mutedUntil', { time: new Date(own!.muted_until!).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}</option>}
          {MUTES.map(([k]) => <option key={k} value={k}>{t(`notify.${k}`)}</option>)}
        </select>
      </Field>
      {!channel && <Switch label={t('notify.suppressEveryone')} checked={suppress} onChange={setSuppress} />}
      <h4 className="section-label">{t('notify.device')}</h4>
      <Switch label={t('notify.sound')} checked={sound} onChange={setSound} />
      <Switch label={t('notify.desktop')} checked={desktop} onChange={async (v) => {
        if (v && !(await requestDesktop())) { s.toast(t('notify.desktopDenied'), true); return; }
        setDesktop(v);
      }} />
    </FormModal>
  );
}

/** Пункты меню сервера/канала: «Отметить прочитанным» и «Уведомления». */
export function notifyMenuItems(t: (k: string) => string, open: (node: (close: () => void) => React.ReactNode) => void, guildId: number, guildName: string, channel?: Channel): MenuItem[] {
  const s = useStore.getState();
  const items: MenuItem[] = [];
  const hasUnread = channel ? !!unreadOf(s, channel.id) : Object.values(s.reads).some((r) => r.guild_id === guildId && unreadOf(s, r.channel_id));
  if (hasUnread) {
    items.push({
      label: t('notify.markRead'),
      onSelect: () => {
        if (channel) {
          const r = s.reads[channel.id];
          if (r) api('POST', `/channels/${channel.id}/ack`, { message_id: r.last_message_id }).catch(() => {});
        } else api('POST', `/guilds/${guildId}/ack`).catch(() => {});
      },
    });
  }
  items.push({ label: t('notify.menu'), onSelect: () => open((close) => <NotificationSettingsModal guildId={guildId} guildName={guildName} channel={channel} close={close} />) });
  return items;
}

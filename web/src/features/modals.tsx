import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { setLanguage } from '../i18n';
import { inviteLink } from '../lib/links';
import { Button, Field, Input, Switch } from '../ui';
import { useStore, type Channel, type Dm, type GuildSummary } from '../store';

/** Форма в модалке: submit возвращает промис; ошибка показывается под полями. */
export function FormModal({ title, text, children, submit, danger, onSubmit, close }: {
  title: string; text?: string; children?: ReactNode; submit: string; danger?: boolean; onSubmit(fd: FormData): Promise<unknown>; close(): void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await onSubmit(new FormData(e.currentTarget)); close(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form className="modal-body" onSubmit={go}>
      <h2>{title}</h2>
      {text && <p className="muted">{text}</p>}
      {children}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <Button type="button" variant="ghost" onClick={close}>{t('modal.cancel')}</Button>
        <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy}>{submit}</Button>
      </div>
    </form>
  );
}

export const confirmModal = (title: string, text: string, submit: string, action: () => Promise<unknown>) => (close: () => void) =>
  <FormModal title={title} text={text} submit={submit} danger onSubmit={action} close={close} />;

function PromptModal({ title, label, value, action, hint, close }: { title: string; label: string; value: string; action(v: string): Promise<unknown>; hint?: string; close(): void }) {
  const { t } = useTranslation();
  return (
    <FormModal title={title} submit={t('modal.save')} onSubmit={(fd) => action(String(fd.get('v') ?? ''))} close={close}>
      <Input name="v" label={label} defaultValue={value} autoFocus maxLength={64} hint={hint} />
    </FormModal>
  );
}
export const promptModal = (title: string, label: string, value: string, action: (v: string) => Promise<unknown>, hint?: string) => (close: () => void) =>
  <PromptModal title={title} label={label} value={value} action={action} hint={hint} close={close} />;

export function AddServerModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me);
  const [error, setError] = useState('');
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') || '').trim() || `${me?.display_name}`;
    try {
      const g = await api<GuildSummary>('POST', '/guilds', { name });
      useStore.setState((s) => ({ guilds: [...s.guilds, g] }));
      close();
      await useStore.getState().selectGuild(g.id);
    } catch (err) { setError((err as Error).message); }
  };
  const join = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get('code') || '').trim();
    const code = raw.split('/').pop()!.replace(/^#?invite\/?/, '');
    if (!code) return;
    try { await joinInvite(code); close(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="modal-body">
      <h2>{t('modal.addServer')}</h2>
      <form onSubmit={create} className="stack">
        <Input name="name" label={t('modal.createOwn')} placeholder={t('modal.serverName')} maxLength={64} autoFocus />
        <Button variant="primary" type="submit">{t('modal.create')}</Button>
      </form>
      <div className="divider" />
      <form onSubmit={join} className="stack">
        <Input name="code" label={t('modal.joinByInvite')} placeholder={t('modal.inviteLinkOrCode')} />
        <Button type="submit">{t('modal.join')}</Button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export async function joinInvite(code: string) {
  const g = await api<GuildSummary>('POST', `/invites/${encodeURIComponent(code)}`);
  useStore.setState((s) => ({ guilds: s.guilds.some((x) => x.id === g.id) ? s.guilds : [...s.guilds, g] }));
  await useStore.getState().selectGuild(g.id);
}

export function InvitePreviewModal({ code, close }: { code: string; close(): void }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<{ guild_id: number; name: string; members: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<typeof info>('GET', `/invites/${encodeURIComponent(code)}`).then(setInfo, (e) => setError(e.message)); }, [code]);
  if (error) return <div className="modal-body"><h2>{error}</h2><div className="modal-actions"><Button onClick={close}>{t('modal.close')}</Button></div></div>;
  if (!info) return <div className="modal-body"><p className="muted">…</p></div>;
  return (
    <FormModal title={t('modal.invitedTo', { name: info.name })} text={t('modal.membersCount', { n: info.members })} submit={t('modal.join')} onSubmit={() => joinInvite(code)} close={close} />
  );
}

const AGES = [[1800, 'time.m30'], [3600, 'time.h1'], [21600, 'time.h6'], [43200, 'time.h12'], [86400, 'time.d1'], [604800, 'time.d7'], [0, 'modal.never']] as const;
const USES = [0, 1, 5, 10, 25, 50, 100];

export function InviteModal({ guild, close }: { guild: GuildSummary; close(): void }) {
  const { t } = useTranslation();
  const [maxAge, setMaxAge] = useState(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ code: string }>('POST', `/guilds/${guild.id}/invites`, { max_age: maxAge, max_uses: maxUses })
      .then((r) => alive && setLink(inviteLink(r.code)), (e) => useStore.getState().toast(e.message, true));
    return () => { alive = false; };
  }, [guild.id, maxAge, maxUses]);
  return (
    <div className="modal-body">
      <h2>{t('modal.inviteTo', { name: guild.name })}</h2>
      <p className="muted">{t('modal.inviteHint')}</p>
      <div className="invite-row">
        <input className="input mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <Button variant="primary" onClick={() => navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
          {copied ? t('modal.copied') : t('modal.copy')}
        </Button>
      </div>
      <div className="grid-2">
        <Field label={t('modal.inviteExpires')}>
          <select className="input" value={maxAge} onChange={(e) => setMaxAge(+e.target.value)}>
            {AGES.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
          </select>
        </Field>
        <Field label={t('modal.inviteUses')}>
          <select className="input" value={maxUses} onChange={(e) => setMaxUses(+e.target.value)}>
            {USES.map((v) => <option key={v} value={v}>{v === 0 ? t('modal.unlimited') : v}</option>)}
          </select>
        </Field>
      </div>
      <div className="modal-actions"><Button onClick={close}>{t('modal.done')}</Button></div>
    </div>
  );
}

export function CreateChannelModal({ guildId, kind, parent, close }: { guildId: number; kind: 'text' | 'voice' | 'category'; parent?: number | null; close(): void }) {
  const { t } = useTranslation();
  const [sub, setSub] = useState<'text' | 'forum'>('text');
  const [vsub, setVsub] = useState<'voice' | 'stage'>('voice');
  const title = kind === 'voice' ? t('modal.newVoice') : kind === 'category' ? t('modal.newCategory') : t('modal.newText');
  return (
    <FormModal title={title} submit={t('modal.create')} close={close} onSubmit={async (fd) => {
      const real = kind === 'text' ? sub : kind === 'voice' ? vsub : kind;
      const c = await api<Channel>('POST', `/guilds/${guildId}/channels`, { name: fd.get('name'), kind: real, parent_id: parent ?? null });
      if (kind === 'text') setTimeout(() => useStore.getState().selectChannel(c.id), 50);
    }}>
      {kind === 'text' && (
        <Field label={t('forum.kind')}>
          <div className="radio-list" role="radiogroup">
            {(['text', 'forum'] as const).map((k) => (
              <label key={k} className={`radio-row ${sub === k ? 'on' : ''}`}>
                <input type="radio" name="kind" checked={sub === k} onChange={() => setSub(k)} />
                <span>{t(k === 'text' ? 'forum.kindText' : 'forum.kindForum')}</span>
              </label>
            ))}
          </div>
        </Field>
      )}
      {kind === 'voice' && (
        <Field label={t('forum.kind')}>
          <div className="radio-list" role="radiogroup">
            {(['voice', 'stage'] as const).map((k) => (
              <label key={k} className={`radio-row ${vsub === k ? 'on' : ''}`}>
                <input type="radio" name="vkind" checked={vsub === k} onChange={() => setVsub(k)} />
                <span>{t(k === 'voice' ? 'call.kindVoice' : 'call.kindStage')}</span>
              </label>
            ))}
          </div>
        </Field>
      )}
      <Input name="name" label={t('modal.name')} autoFocus maxLength={48} />
    </FormModal>
  );
}

export function EditChannelModal({ channel, close }: { channel: Channel; close(): void }) {
  const { t } = useTranslation();
  return (
    <FormModal title={t('modal.channelSettings')} submit={t('modal.save')} close={close} onSubmit={(fd) => {
      const body: Record<string, unknown> = { name: fd.get('name') };
      if (channel.kind === 'text' || channel.kind === 'forum' || channel.kind === 'stage') body.topic = fd.get('topic');
      if (channel.kind === 'voice') { body.bitrate = +String(fd.get('bitrate')); body.user_limit = +String(fd.get('user_limit') || 0); }
      return api('PATCH', `/channels/${channel.id}`, body);
    }}>
      <Input name="name" label={t('modal.name')} defaultValue={channel.name} maxLength={48} autoFocus />
      {(channel.kind === 'text' || channel.kind === 'forum' || channel.kind === 'stage') && <Input name="topic" label={channel.kind === 'forum' ? t('forum.guidelines') : t('modal.topic')} defaultValue={channel.topic} maxLength={256} />}
      {channel.kind === 'voice' && (
        <div className="grid-2">
          <Field label={t('modal.bitrate')}>
            <select name="bitrate" className="input" defaultValue={channel.bitrate}>
              {[32000, 64000, 96000, 128000].map((b) => <option key={b} value={b}>{b / 1000} кбит/с</option>)}
            </select>
          </Field>
          <Input name="user_limit" type="number" min={0} max={99} label={t('modal.userLimit')} defaultValue={channel.user_limit} />
        </div>
      )}
    </FormModal>
  );
}

export function NewDmModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  return (
    <FormModal title={t('modal.newDm')} submit={t('modal.write')} close={close} onSubmit={(fd) => openDm({ username: String(fd.get('username') ?? '') })}>
      <Input name="username" label={t('auth.username')} hint={t('modal.newDmHint')} autoFocus />
    </FormModal>
  );
}

export async function openDm(body: { username?: string; user_id?: number }) {
  const dm = await api<Dm>('POST', '/dms', body);
  useStore.setState((s) => ({ dms: s.dms.some((d) => d.id === dm.id) ? s.dms : [dm, ...s.dms] }));
  useStore.getState().selectHome(dm.id);
}

export function SettingsModal({ close }: { close(): void }) {
  const { t, i18n } = useTranslation();
  const me = useStore((s) => s.me)!;
  const [reduce, setReduce] = useState(document.documentElement.dataset.reducedMotion === 'true');
  return (
    <FormModal title={t('modal.settings')} text={`@${me.username}`} submit={t('modal.save')} close={close}
      onSubmit={(fd) => api('PATCH', '/me', { display_name: fd.get('display_name'), status: fd.get('status') })}>
      <Input name="display_name" label={t('modal.displayName')} defaultValue={me.display_name} maxLength={32} />
      <Input name="status" label={t('modal.status')} placeholder={t('modal.statusHint')} defaultValue={me.status} maxLength={128} />
      <Field label={t('modal.language')}>
        <select className="input" value={i18n.language} onChange={(e) => setLanguage(e.target.value as 'ru' | 'en')}>
          <option value="ru">Русский</option><option value="en">English</option>
        </select>
      </Field>
      <Switch label={t('modal.reduceMotion')} checked={reduce} onChange={(v) => {
        setReduce(v);
        document.documentElement.dataset.reducedMotion = String(v);
        try { localStorage.setItem('relay_reduced_motion', String(v)); } catch { /* приватный режим */ }
      }} />
      <Button type="button" variant="danger" onClick={() => { close(); useStore.getState().logout(); }}>{t('modal.logout')}</Button>
    </FormModal>
  );
}

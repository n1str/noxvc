// Закрытая регистрация (src/invites.rs). Участник: запрос «пригласить человека на мой сервер», статусы, ссылка после
// одобрения. Администратор инстанса: запросы (одобрить/отклонить), коды (создать — показ один раз, отозвать), история.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plus, X } from 'lucide-react';
import { api } from '../lib/api';
import { Avatar, Button, Field, Input, Skeleton } from '../ui';
import { useStore, type User } from '../store';
import { Seg } from './stream';

type Guild = { id: number; name: string } | null;
interface MyReq { id: number; guild: Guild; invitee: string; comment: string; status: string; reason: string; created_at: number; code_state: string | null; expires_at: number | null; link: string | null }
interface AdmReq { id: number; invitee: string; comment: string; status: string; reason: string; created_at: number; decided_at: number | null; guild: Guild; requester: Partial<User>; decided_by: Partial<User> | null }
interface Code { id: number; note: string; state: string; created_at: number; expires_at: number; used_at: number | null; request_id: number | null; guild: Guild; created_by: Partial<User> | null; used_by: Partial<User> | null }
interface Hist { code_id: number; used_at: number; note: string; invitee: string | null; user: Partial<User>; invited_by: Partial<User> | null; approved_by: Partial<User> | null; guild: Guild }

const DAYS = [1, 3, 7, 14, 30] as const;
const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const useReload = (load: () => void) => useEffect(() => { load(); const h = () => load(); window.addEventListener('relay:invites_update', h); return () => window.removeEventListener('relay:invites_update', h); }, []); // eslint-disable-line react-hooks/exhaustive-deps
const Chip = ({ s }: { s: string }) => { const { t } = useTranslation(); return <span className={`fb-status s-${s}`}>{t(`inv.st.${s}`)}</span>; };
const Who = ({ u }: { u: Partial<User> | null | undefined }) => (u ? <span className="inv-who"><Avatar user={u} size={20} /> {u.display_name || u.username}</span> : <span className="muted">—</span>);

function CopyLink({ link }: { link: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div className="inv-link">
      <code>{link}</code>
      <Button size="sm" variant="primary" onClick={() => navigator.clipboard.writeText(link).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
        {done ? <Check size={14} /> : <Copy size={14} />} {done ? t('inv.copied') : t('inv.copy')}
      </Button>
    </div>
  );
}

/** Настройки → «Приглашения»: позвать человека и мои запросы. */
export function MyInvitesTab() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const guilds = useStore((s) => s.guilds);
  const [items, setItems] = useState<MyReq[] | null>(null);
  const [f, setF] = useState({ guild_id: guilds[0]?.id ?? 0, invitee: '', comment: '' });
  const [busy, setBusy] = useState(false);
  const load = () => api<{ items: MyReq[] }>('GET', '/invite-requests/mine').then((d) => setItems(d.items)).catch((e) => toast((e as Error).message, true));
  useReload(load);
  const pending = items?.filter((x) => x.status === 'pending').length ?? 0;
  const send = async () => {
    setBusy(true);
    try { await api('POST', '/invite-requests', f); setF({ ...f, invitee: '', comment: '' }); toast(t('inv.sent')); load(); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };
  return (
    <div className="us-section">
      <p className="muted small">{t('inv.about')}</p>
      {guilds.length === 0 ? <p className="muted small">{t('inv.noGuilds')}</p> : (
        <div className="inv-form">
          <Field label={t('inv.guild')}>
            <select className="input" value={f.guild_id} onChange={(e) => setF({ ...f, guild_id: Number(e.target.value) })} aria-label={t('inv.guild')}>
              {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Input label={t('inv.invitee')} placeholder={t('inv.inviteePh')} value={f.invitee} maxLength={64} onChange={(e) => setF({ ...f, invitee: e.target.value })} />
          <Input label={t('inv.comment')} placeholder={t('inv.commentPh')} value={f.comment} maxLength={500} onChange={(e) => setF({ ...f, comment: e.target.value })} />
          <div className="fb-actions">
            <Button variant="primary" disabled={busy || !f.invitee.trim() || pending >= 3} onClick={send}><Plus size={14} /> {t('inv.request')}</Button>
            <span className="muted small">{t('inv.pendingOf', { n: pending })}</span>
          </div>
        </div>
      )}
      <h3 className="inv-h">{t('inv.mine')}</h3>
      <div className="fb-list">
        {items == null ? <Skeleton h={48} r={8} /> : items.length === 0 ? <p className="muted small">{t('inv.mineEmpty')}</p> : items.map((r) => (
          <div key={r.id} className="inv-card">
            <div className="inv-row"><b>{r.invitee}</b><span className="muted small">{r.guild?.name ?? '—'} · {date(r.created_at)}</span><Chip s={r.status === 'approved' && r.code_state && r.code_state !== 'active' ? r.code_state : r.status} /></div>
            {r.comment && <p className="muted small">{r.comment}</p>}
            {r.status === 'approved' && r.link && <><p className="small">{t('inv.approvedHint', { date: date(r.expires_at) })}</p><CopyLink link={r.link} /></>}
            {r.status === 'rejected' && r.reason && <p className="small">{t('inv.reason')}: {r.reason}</p>}
            {r.status === 'pending' && <div><Button size="sm" variant="ghost" onClick={() => api('POST', `/invite-requests/${r.id}/cancel`).then(load).catch((e) => toast((e as Error).message, true))}><X size={14} /> {t('inv.cancel')}</Button></div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Requests() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [all, setAll] = useState(false);
  const [d, setD] = useState<{ items: AdmReq[]; counts: Record<string, number> } | null>(null);
  const [days, setDays] = useState<Record<number, number>>({});
  const [rej, setRej] = useState<{ id: number; reason: string } | null>(null);
  const load = () => api<{ items: AdmReq[]; counts: Record<string, number> }>('GET', `/admin/invites/requests${all ? '?status=all' : ''}`).then(setD).catch((e) => toast((e as Error).message, true));
  useReload(load);
  useEffect(() => { load(); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast(msg); setRej(null); load(); }).catch((e) => toast((e as Error).message, true));
  return (
    <>
      <div className="fb-actions">
        <Seg<'pending' | 'all'> label={t('inv.filter')} value={all ? 'all' : 'pending'} onChange={(v) => setAll(v === 'all')} options={[['pending', `${t('inv.st.pending')} (${d?.counts.pending ?? 0})`], ['all', t('inv.all')]]} />
      </div>
      <div className="fb-list">
        {d == null ? <Skeleton h={48} r={8} /> : d.items.length === 0 ? <p className="muted small">{t('inv.noRequests')}</p> : d.items.map((r) => (
          <div key={r.id} className="inv-card">
            <div className="inv-row"><Who u={r.requester} /><span>→ <b>{r.invitee}</b></span><span className="muted small">{r.guild?.name ?? '—'} · {date(r.created_at)}</span><Chip s={r.status} /></div>
            {r.comment && <p className="muted small">{r.comment}</p>}
            {r.status === 'rejected' && r.reason && <p className="small">{t('inv.reason')}: {r.reason}</p>}
            {r.decided_by && <p className="muted small">{t('inv.decidedBy')}: {r.decided_by.display_name || r.decided_by.username} · {date(r.decided_at)}</p>}
            {r.status === 'pending' && (rej?.id === r.id ? (
              <div className="inv-actions">
                <Input placeholder={t('inv.reasonPh')} value={rej.reason} maxLength={300} onChange={(e) => setRej({ id: r.id, reason: e.target.value })} aria-label={t('inv.reason')} />
                <Button size="sm" variant="danger" onClick={() => act(api('POST', `/admin/invites/requests/${r.id}/reject`, { reason: rej.reason }), t('inv.rejected'))}>{t('inv.reject')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setRej(null)}>{t('modal.cancel')}</Button>
              </div>
            ) : (
              <div className="inv-actions">
                <select className="input" value={days[r.id] ?? 7} onChange={(e) => setDays({ ...days, [r.id]: Number(e.target.value) })} aria-label={t('inv.days')}>
                  {DAYS.map((n) => <option key={n} value={n}>{t('inv.daysN', { count: n })}</option>)}
                </select>
                <Button size="sm" variant="primary" onClick={() => act(api('POST', `/admin/invites/requests/${r.id}/approve`, { days: days[r.id] ?? 7 }), t('inv.approved'))}><Check size={14} /> {t('inv.approve')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setRej({ id: r.id, reason: '' })}><X size={14} /> {t('inv.reject')}</Button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function Codes() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [items, setItems] = useState<Code[] | null>(null);
  const [guilds, setGuilds] = useState<{ id: number; name: string }[]>([]);
  const [f, setF] = useState({ note: '', days: 7, guild_id: 0 });
  const [made, setMade] = useState<{ code: string; link: string; expires_at: number } | null>(null);
  const load = () => api<{ items: Code[] }>('GET', '/admin/invites/codes').then((d) => setItems(d.items)).catch((e) => toast((e as Error).message, true));
  useReload(load);
  useEffect(() => { api<{ items: { id: number; name: string }[] }>('GET', '/admin/invites/guilds').then((d) => setGuilds(d.items)).catch(() => {}); }, []);
  const create = () => api<{ code: string; link: string; expires_at: number }>('POST', '/admin/invites/codes', { note: f.note, days: f.days, guild_id: f.guild_id || null })
    .then((r) => { setMade(r); setF({ ...f, note: '' }); load(); }).catch((e) => toast((e as Error).message, true));
  return (
    <>
      <div className="inv-form">
        <Input label={t('inv.note')} placeholder={t('inv.notePh')} value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <div className="inv-actions">
          <select className="input" value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} aria-label={t('inv.days')}>
            {DAYS.map((n) => <option key={n} value={n}>{t('inv.daysN', { count: n })}</option>)}
          </select>
          <select className="input" value={f.guild_id} onChange={(e) => setF({ ...f, guild_id: Number(e.target.value) })} aria-label={t('inv.autoGuild')}>
            <option value={0}>{t('inv.noAutoGuild')}</option>
            {guilds.map((g) => <option key={g.id} value={g.id}>{t('inv.autoGuildN', { name: g.name })}</option>)}
          </select>
          <Button variant="primary" onClick={create}><Plus size={14} /> {t('inv.create')}</Button>
        </div>
      </div>
      {made && (
        <div className="inv-card inv-made" role="status">
          <b>{t('inv.madeTitle')}</b>
          <p className="small">{t('inv.madeHint', { date: date(made.expires_at) })}</p>
          <CopyLink link={made.link} />
          <p className="muted small">{t('inv.codeOnly')}: <code>{made.code}</code></p>
          <div><Button size="sm" variant="ghost" onClick={() => setMade(null)}>{t('inv.hide')}</Button></div>
        </div>
      )}
      <div className="fb-list">
        {items == null ? <Skeleton h={48} r={8} /> : items.length === 0 ? <p className="muted small">{t('inv.noCodes')}</p> : items.map((c) => (
          <div key={c.id} className="inv-card">
            <div className="inv-row"><b>№{c.id}</b><span>{c.note || <span className="muted">{t('inv.noNote')}</span>}</span><span className="muted small">{c.guild ? `→ ${c.guild.name}` : ''}</span><Chip s={c.state} /></div>
            <p className="muted small">
              {t('inv.createdBy')}: {c.created_by ? (c.created_by.display_name || c.created_by.username) : 'CLI'} · {date(c.created_at)} · {t('inv.until')} {date(c.expires_at)}
              {c.used_by && <> · {t('inv.usedBy')}: {c.used_by.display_name || c.used_by.username}, {date(c.used_at)}</>}
            </p>
            {c.state === 'active' && <div><Button size="sm" variant="ghost" onClick={() => api('POST', `/admin/invites/codes/${c.id}/revoke`).then(() => { toast(t('inv.revoked')); load(); }).catch((e) => toast((e as Error).message, true))}><X size={14} /> {t('inv.revoke')}</Button></div>}
          </div>
        ))}
      </div>
    </>
  );
}

function History() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [items, setItems] = useState<Hist[] | null>(null);
  const load = () => api<{ items: Hist[] }>('GET', '/admin/invites/history').then((d) => setItems(d.items)).catch((e) => toast((e as Error).message, true));
  useReload(load);
  return (
    <div className="fb-list">
      {items == null ? <Skeleton h={48} r={8} /> : items.length === 0 ? <p className="muted small">{t('inv.noHistory')}</p> : items.map((h) => (
        <div key={h.code_id} className="inv-card">
          <div className="inv-row"><Who u={h.user} /><span className="muted small">{date(h.used_at)}</span>{h.guild && <span className="muted small">→ {h.guild.name}</span>}</div>
          <p className="muted small">
            {t('inv.invitedBy')}: {h.invited_by ? (h.invited_by.display_name || h.invited_by.username) : 'CLI'}
            {h.approved_by && <> · {t('inv.approvedBy')}: {h.approved_by.display_name || h.approved_by.username}</>}
            {' · '}{t('inv.code')} №{h.code_id}{h.note ? ` — ${h.note}` : ''}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Настройки → «Приглашения (админ)» — только администратор инстанса (сервер всё равно проверяет: 403). */
export function InvitesAdminTab() {
  const { t } = useTranslation();
  const pending = useStore((s) => s.me?.invite_pending ?? 0);
  const [tab, setTab] = useState<'requests' | 'codes' | 'history'>('requests');
  return (
    <div className="us-section feedback-admin">
      <Seg<'requests' | 'codes' | 'history'> label={t('inv.sections')} value={tab} onChange={setTab}
        options={[['requests', pending ? `${t('inv.requests')} (${pending})` : t('inv.requests')], ['codes', t('inv.codes')], ['history', t('inv.history')]]} />
      {tab === 'requests' ? <Requests /> : tab === 'codes' ? <Codes /> : <History />}
    </div>
  );
}

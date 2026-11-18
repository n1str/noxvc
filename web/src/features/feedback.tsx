// Обратная связь: «Сообщить о проблеме / предложить идею», мои обращения, backlog администратора инстанса.
// Открыть форму — кнопка в панели серверов, «Настройки → Обратная связь» или горячая клавиша (Ctrl+Shift+H по умолчанию).
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bug, Download, ImagePlus, Lightbulb, MessageCircleQuestion, Send, X } from 'lucide-react';
import { api, uploadFile } from '../lib/api';
import { clientLog } from '../lib/clientLog';
import { dinvoke, isDesktop, type AppInfo } from '../lib/desktop';
import { Avatar, Button, Field, IconButton, Input, Skeleton } from '../ui';
import { useModal } from '../ui/overlays';
import { useStore, type User } from '../store';
import { Seg } from './stream';
import { voiceDiagnostics } from './voice';

export type Kind = 'bug' | 'idea' | 'other';
const KINDS: Kind[] = ['bug', 'idea', 'other'];
const CATEGORIES = ['voice', 'stream', 'ui', 'account', 'messages', 'other'] as const;
const STATUSES = ['new', 'review', 'planned', 'progress', 'done', 'rejected', 'duplicate'] as const;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'critical'] as const;
interface Attachment { url: string; name: string; size: number; content_type: string }
export interface Item {
  id: number; user_id: number; kind: Kind; category: string; title: string; body: string; status: string; priority: string; duplicate_of: number | null;
  attachments: Attachment[]; diagnostics: Record<string, unknown> | null; has_diagnostics: boolean; created_at: number; updated_at: number; unread: boolean; comments: number; author: Partial<User>;
}
interface Comment { id: number; body: string; is_admin: boolean; created_at: number; author: Partial<User> }

const KIND_ICON = { bug: Bug, idea: Lightbulb, other: MessageCircleQuestion };
const when = (ms: number, lang: string) => new Date(ms).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const MAX_SHOTS = 5, MAX_SHOT_BYTES = 10 * 1024 * 1024;

/** Диагностика для баг-репорта: версия и ОС клиента, последние строки журнала клиента, снимок связи, если в голосе. */
export async function collectDiagnostics() {
  const app = isDesktop ? await dinvoke<AppInfo>('app_info').catch(() => null) : null;
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return {
    client: isDesktop ? `NoxVC Desktop ${app?.version ?? ''}`.trim() : 'web', user_agent: navigator.userAgent, platform: uad?.platform ?? navigator.platform,
    language: navigator.language, screen: `${screen.width}×${screen.height}@${devicePixelRatio}`, page: location.pathname + location.hash.replace(/#.*/, ''),
    at: new Date().toISOString(), voice: await voiceDiagnostics().catch(() => null), log: clientLog(100),
  };
}

export function StatusChip({ s }: { s: string }) { const { t } = useTranslation(); return <span className={`fb-status s-${s}`}>{t(`fb.st.${s}`)}</span>; }

// ---------- форма ----------
export function FeedbackModal({ close, initialKind = 'bug' }: { close(): void; initialKind?: Kind }) {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [category, setCategory] = useState('other');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [shots, setShots] = useState<(Attachment & { preview: string })[]>([]);
  const [uploading, setUploading] = useState(0);
  const [diag, setDiag] = useState(true);
  const [diagPreview, setDiagPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const add = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) { setError(t('fb.onlyImages')); continue; }
      if (f.size > MAX_SHOT_BYTES) { setError(t('fb.tooBig')); continue; }
      if (shots.length + uploading >= MAX_SHOTS) { setError(t('fb.maxShots', { n: MAX_SHOTS })); break; }
      setUploading((n) => n + 1);
      const preview = URL.createObjectURL(f);
      uploadFile(f, () => {}).promise
        .then((a) => setShots((s) => (s.length < MAX_SHOTS ? [...s, { ...a, content_type: a.content_type || f.type, preview }] : s)))
        .catch((e) => setError((e as Error).message))
        .finally(() => setUploading((n) => n - 1));
    }
  };
  const onPaste = (e: ClipboardEvent) => { const f = [...e.clipboardData.files].filter((x) => x.type.startsWith('image/')); if (f.length) { e.preventDefault(); add(f); } };
  const onDrop = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer.files.length) add(e.dataTransfer.files); };
  const showDiag = async () => setDiagPreview(diagPreview ? null : JSON.stringify(await collectDiagnostics(), null, 2));
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const diagnostics = kind === 'bug' && diag ? await collectDiagnostics() : null;
      const r = await api<{ id: number }>('POST', '/feedback', { kind, category, title, body, attachments: shots.map(({ preview: _p, ...a }) => a), diagnostics });
      toast(t('fb.sent', { id: r.id }));
      close();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="modal-body feedback-form" onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <h2>{t('fb.title')}</h2>
      <Field label={t('fb.kind')}><Seg<Kind> label={t('fb.kind')} value={kind} onChange={setKind} options={KINDS.map((k) => [k, t(`fb.k.${k}`)] as [Kind, string])} /></Field>
      <Field label={t('fb.category')}>
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('fb.category')}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{t(`fb.c.${c}`)}</option>)}
        </select>
      </Field>
      <Input label={t('fb.titleField')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={t(kind === 'bug' ? 'fb.titleBug' : 'fb.titleIdea')} />
      <Field label={t('fb.body')}>
        <textarea className="input fb-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={6} placeholder={t(kind === 'bug' ? 'fb.bodyBug' : 'fb.bodyIdea')} aria-label={t('fb.body')} />
      </Field>
      <Field label={t('fb.shots', { n: shots.length, max: MAX_SHOTS })}>
        <div className="fb-shots">
          {shots.map((s, i) => (
            <span key={s.url} className="fb-shot"><img src={s.preview} alt={s.name} />
              <IconButton label={t('fb.removeShot')} onClick={() => setShots(shots.filter((_, j) => j !== i))}><X size={14} /></IconButton></span>
          ))}
          {uploading > 0 && <Skeleton w={96} h={64} r={8} />}
          {shots.length + uploading < MAX_SHOTS && (
            <button type="button" className="fb-add-shot" onClick={() => fileRef.current?.click()}><ImagePlus size={18} /><span className="small">{t('fb.addShot')}</span></button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="muted small">{t('fb.shotsHint')}</p>
      </Field>
      {kind === 'bug' && (
        <div className="fb-diag">
          <label className="check-row"><input type="checkbox" checked={diag} onChange={(e) => setDiag(e.target.checked)} /> <span>{t('fb.diag')}</span></label>
          <p className="muted small">{t('fb.diagHint')} <button type="button" className="link-btn small" onClick={showDiag}>{diagPreview ? t('fb.diagHide') : t('fb.diagShow')}</button></p>
          {diagPreview && <pre className="fb-diag-preview">{diagPreview}</pre>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <Button variant="ghost" onClick={close}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={busy || uploading > 0 || title.trim().length < 3 || !body.trim()} onClick={submit}><Send size={14} /> {t('fb.send')}</Button>
      </div>
    </div>
  );
}

/** Открыть форму из любого места (горячая клавиша, меню): событие relay:feedback. */
export function FeedbackLauncher() {
  const modal = useModal();
  useEffect(() => {
    const open = () => modal.open((close) => <FeedbackModal close={close} />, { wide: true });
    window.addEventListener('relay:feedback', open);
    return () => window.removeEventListener('relay:feedback', open);
  }, [modal]);
  return null;
}
export const openFeedback = () => window.dispatchEvent(new Event('relay:feedback'));

// ---------- обращение и переписка ----------
function Thread({ id, back, onChanged }: { id: number; back(): void; onChanged?(): void }) {
  const { t, i18n } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [d, setD] = useState<{ item: Item; comments: Comment[]; admin: boolean } | null>(null);
  const [reply, setReply] = useState('');
  const [dup, setDup] = useState('');
  const load = () => api<{ item: Item; comments: Comment[]; admin: boolean }>('GET', `/feedback/${id}`).then(setD).catch((e) => toast((e as Error).message, true));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const f = (e: Event) => { if ((e as CustomEvent<{ id: number }>).detail?.id === id) load(); }; window.addEventListener('relay:feedback_update', f); return () => window.removeEventListener('relay:feedback_update', f); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Skeleton h={160} r={10} />;
  const it = d.item;
  const patch = async (b: Record<string, unknown>) => { try { await api('PATCH', `/admin/feedback/${id}`, b); await load(); onChanged?.(); } catch (e) { toast((e as Error).message, true); } };
  const send = async () => {
    if (!reply.trim()) return;
    try { await api('POST', `/feedback/${id}/comments`, { body: reply }); setReply(''); await load(); onChanged?.(); } catch (e) { toast((e as Error).message, true); }
  };
  const Icon = KIND_ICON[it.kind];
  return (
    <div className="fb-thread">
      <button type="button" className="link-btn" onClick={back}><ArrowLeft size={14} /> {t('fb.back')}</button>
      <div className="fb-head">
        <Icon size={18} aria-hidden /><h3>#{it.id} {it.title}</h3><StatusChip s={it.status} />
        {it.duplicate_of && <span className="muted small">{t('fb.dupOf', { id: it.duplicate_of })}</span>}
      </div>
      <div className="muted small">{t(`fb.k.${it.kind}`)} · {t(`fb.c.${it.category}`)} · {when(it.created_at, i18n.language)}{d.admin && <> · @{it.author.username} · {t('fb.prio')}: {t(`fb.p.${it.priority}`)}</>}</div>
      {d.admin && (
        <div className="fb-admin-controls">
          <Field label={t('fb.status')}><select className="input" value={it.status} onChange={(e) => patch({ status: e.target.value })} aria-label={t('fb.status')}>{STATUSES.map((s) => <option key={s} value={s}>{t(`fb.st.${s}`)}</option>)}</select></Field>
          <Field label={t('fb.prio')}><select className="input" value={it.priority} onChange={(e) => patch({ priority: e.target.value })} aria-label={t('fb.prio')}>{PRIORITIES.map((p) => <option key={p} value={p}>{t(`fb.p.${p}`)}</option>)}</select></Field>
          <Field label={t('fb.markDup')}>
            <div className="fb-dup"><input className="input" inputMode="numeric" placeholder="№" value={dup} onChange={(e) => setDup(e.target.value.replace(/\D/g, ''))} aria-label={t('fb.markDup')} />
              <Button size="sm" disabled={!dup} onClick={() => { void patch({ duplicate_of: +dup }); setDup(''); }}>{t('fb.merge')}</Button></div>
          </Field>
        </div>
      )}
      <p className="fb-text">{it.body}</p>
      {it.attachments.length > 0 && <div className="fb-shots">{it.attachments.map((a) => <a key={a.url} className="fb-shot" href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} /></a>)}</div>}
      {d.admin && it.diagnostics && <details className="fb-diag"><summary>{t('fb.diagTitle')}</summary><pre className="fb-diag-preview">{JSON.stringify(it.diagnostics, null, 2)}</pre></details>}
      <div className="fb-comments">
        {d.comments.map((c) => (
          <div key={c.id} className={`fb-comment ${c.is_admin ? 'dev' : ''}`}>
            <Avatar user={c.author} size={28} />
            <div><div className="small"><b>{c.author.display_name}</b>{c.is_admin && <span className="fb-dev">{t('fb.dev')}</span>} <span className="muted">{when(c.created_at, i18n.language)}</span></div><p>{c.body}</p></div>
          </div>
        ))}
      </div>
      <div className="fb-reply">
        <textarea className="input" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('fb.replyPh')} aria-label={t('fb.reply')} maxLength={3000} />
        <Button variant="primary" disabled={!reply.trim()} onClick={send}><Send size={14} /> {t('fb.reply')}</Button>
      </div>
    </div>
  );
}

function Row({ it, open, admin }: { it: Item; open(): void; admin?: boolean }) {
  const { t, i18n } = useTranslation();
  const Icon = KIND_ICON[it.kind];
  return (
    <button type="button" className={`fb-row ${it.unread && !admin ? 'unread' : ''}`} onClick={open} data-id={it.id}>
      <Icon size={16} aria-hidden />
      <span className="fb-row-title">#{it.id} {it.title}</span>
      {admin && <span className="muted small">@{it.author.username} · {t(`fb.c.${it.category}`)} · {t(`fb.p.${it.priority}`)}</span>}
      <span className="muted small">{when(it.created_at, i18n.language)}{it.comments ? ` · 💬 ${it.comments}` : ''}</span>
      <StatusChip s={it.status} />
    </button>
  );
}

/** Настройки → «Обратная связь»: новое обращение и мои обращения. */
export function FeedbackTab() {
  const { t } = useTranslation();
  const modal = useModal();
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = () => api<{ items: Item[] }>('GET', '/feedback/mine').then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { load(); const f = () => load(); window.addEventListener('relay:feedback_update', f); return () => window.removeEventListener('relay:feedback_update', f); }, []);
  if (open != null) return <div className="us-section"><Thread id={open} back={() => { setOpen(null); load(); }} /></div>;
  return (
    <div className="us-section feedback-tab">
      <p className="muted small">{t('fb.tabHint')}</p>
      <div className="fb-actions">
        <Button variant="primary" onClick={() => modal.open((close) => <FeedbackModal close={() => { close(); load(); }} />, { wide: true })}><Bug size={14} /> {t('fb.reportBug')}</Button>
        <Button onClick={() => modal.open((close) => <FeedbackModal initialKind="idea" close={() => { close(); load(); }} />, { wide: true })}><Lightbulb size={14} /> {t('fb.suggest')}</Button>
      </div>
      <h3 className="us-h">{t('fb.mine')}</h3>
      <div className="fb-list">{items == null ? <Skeleton h={48} r={8} /> : items.length === 0 ? <p className="muted small">{t('fb.mineEmpty')}</p> : items.map((it) => <Row key={it.id} it={it} open={() => setOpen(it.id)} />)}</div>
    </div>
  );
}

/** Настройки → «Обращения (админ)»: backlog администратора инстанса. */
export function FeedbackAdminTab() {
  const { t } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [f, setF] = useState({ kind: 'all', category: 'all', status: 'all', priority: 'all', q: '', sort: 'newest' });
  const [d, setD] = useState<{ items: Item[]; counts: Record<string, number> } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v && v !== 'all')).toString();
  const load = () => api<{ items: Item[]; counts: Record<string, number> }>('GET', `/admin/feedback?${qs()}`).then(setD).catch((e) => toast((e as Error).message, true));
  useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const r = () => load(); window.addEventListener('relay:feedback_update', r); return () => window.removeEventListener('relay:feedback_update', r); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportAs = async (format: 'csv' | 'md') => {
    const tok = useStore.getState().token;
    const r = await fetch(`/api/admin/feedback/export?format=${format}&${qs()}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) { toast(t('fb.exportFail'), true); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `relay-feedback.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  if (open != null) return <div className="us-section"><Thread id={open} back={() => { setOpen(null); load(); }} onChanged={load} /></div>;
  const sel = (k: keyof typeof f, values: readonly string[], label: string, prefix: string) => (
    <select className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={label}>
      <option value="all">{label}: {t('fb.all')}</option>
      {values.map((v) => <option key={v} value={v}>{t(`${prefix}.${v}`)}{k === 'status' && d?.counts[v] ? ` (${d.counts[v]})` : ''}</option>)}
    </select>
  );
  return (
    <div className="us-section feedback-admin">
      <div className="fb-filters">
        {sel('kind', KINDS, t('fb.kind'), 'fb.k')}{sel('category', CATEGORIES, t('fb.category'), 'fb.c')}{sel('status', STATUSES, t('fb.status'), 'fb.st')}{sel('priority', PRIORITIES, t('fb.prio'), 'fb.p')}
        <select className="input" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} aria-label={t('fb.sort')}>
          {['newest', 'oldest', 'updated', 'priority'].map((s) => <option key={s} value={s}>{t(`fb.sortBy.${s}`)}</option>)}
        </select>
        <input className="input" type="search" placeholder={t('fb.search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label={t('fb.search')} />
      </div>
      <div className="fb-actions">
        <Button size="sm" variant="ghost" onClick={() => exportAs('csv')}><Download size={14} /> CSV</Button>
        <Button size="sm" variant="ghost" onClick={() => exportAs('md')}><Download size={14} /> Markdown</Button>
        <span className="muted small">{d ? t('fb.found', { n: d.items.length }) : ''}</span>
      </div>
      <div className="fb-list">{d == null ? <Skeleton h={48} r={8} /> : d.items.length === 0 ? <p className="muted small">{t('fb.none')}</p> : d.items.map((it) => <Row key={it.id} it={it} admin open={() => setOpen(it.id)} />)}</div>
    </div>
  );
}

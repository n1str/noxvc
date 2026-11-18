// Активные сеансы и журнал безопасности (Настройки → Моя учётная запись).
// Завершение — мгновенное (сервер: токен отозван, соединение закрыто, голос — кик); подтверждение — паролем.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, LogOut, Monitor, ShieldCheck, Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Input, Skeleton } from '../ui';
import { useModal } from '../ui/overlays';
import { FormModal } from './modals';
import { useStore } from '../store';

interface Session { id: number; current: boolean; client: string; version: string; os: string; browser: string; ip: string; country: string; city: string; created_at: number; last_seen: number }
interface LogEvent { id: number; at: number; event: string; session_id: number | null; by_current: boolean; ip: string; details: { client?: string; os?: string; browser?: string; country?: string; city?: string; count?: number; signed_out?: number } }

const when = (ms: number, lang: string) => new Date(ms).toLocaleString(lang, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** «5 минут назад» для последней активности; давно — дата. */
function ago(ms: number, lang: string, t: (k: string, o?: Record<string, unknown>) => string) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 120) return t('ses.now');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
  return when(ms, lang);
}
const mobile = (os: string) => os === 'Android' || os === 'iOS';
const place = (city: string, country: string) => [city, country].filter(Boolean).join(', ');

function ConfirmPassword({ close, title, text, submit, run }: { close(): void; title: string; text: string; submit: string; run(password: string): Promise<void> }) {
  const { t } = useTranslation();
  return (
    <FormModal title={title} submit={submit} close={close} onSubmit={async (fd) => { await run(String(fd.get('password') || '')); }}>
      <p className="muted">{text}</p>
      <Input name="password" type="password" label={t('ses.password')} autoComplete="current-password" required autoFocus />
    </FormModal>
  );
}

export function SessionsSection() {
  const { t, i18n } = useTranslation();
  const modal = useModal();
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Session[] | null>(null);
  const [log, setLog] = useState<LogEvent[] | null>(null);
  const load = () => {
    api<{ sessions: Session[] }>('GET', '/sessions').then((r) => setList(r.sessions)).catch((e) => { toast((e as Error).message, true); setList([]); });
    api<{ events: LogEvent[] }>('GET', '/security-log').then((r) => setLog(r.events)).catch(() => setLog([]));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const others = (list ?? []).filter((s) => !s.current);
  const name = (s: Session) => (s.client === 'desktop' ? `NoxVC Desktop${s.version ? ' ' + s.version : ''}` : s.browser || t('ses.unknown'));
  const revoke = (s: Session) => modal.open((close) => (
    <ConfirmPassword close={close} title={t('ses.revokeTitle')} submit={t('ses.revoke')}
      text={t('ses.revokeText', { name: [name(s), s.os].filter(Boolean).join(' · ') })}
      run={async (password) => { await api('DELETE', `/sessions/${s.id}`, { password }); toast(t('ses.revoked')); load(); }} />
  ));
  const revokeOthers = () => modal.open((close) => (
    <ConfirmPassword close={close} title={t('ses.revokeAllTitle')} submit={t('ses.revokeAll')} text={t('ses.revokeAllText', { n: others.length })}
      run={async (password) => { const r = await api<{ revoked: number[] }>('POST', '/sessions/revoke-others', { password }); toast(t('ses.revokedN', { n: r.revoked.length })); load(); }} />
  ));
  const row = (s: Session) => (
    <div key={s.id} className={`session-row ${s.current ? 'current' : ''}`} data-session={s.id}>
      <span className="session-icon" aria-hidden>{s.client === 'desktop' ? <Monitor size={20} /> : mobile(s.os) ? <Smartphone size={20} /> : <Globe size={20} />}</span>
      <div className="session-info">
        <div className="session-name">{name(s)}{s.os && <span className="muted"> · {s.os}</span>}{s.current && <span className="session-badge">{t('ses.current')}</span>}</div>
        <div className="muted small">{[place(s.city, s.country), s.ip].filter(Boolean).join(' · ') || t('ses.noPlace')}</div>
        <div className="muted small">{t('ses.since', { at: when(s.created_at, i18n.language) })} · {t('ses.seen', { at: s.current ? t('ses.now') : ago(s.last_seen, i18n.language, t) })}</div>
      </div>
      {!s.current && <Button size="sm" variant="ghost" onClick={() => revoke(s)}><LogOut size={14} /> {t('ses.revoke')}</Button>}
    </div>
  );
  const evText = (e: LogEvent) => {
    const d = e.details;
    const who = [d.client === 'desktop' ? 'NoxVC Desktop' : d.browser, d.os, place(d.city ?? '', d.country ?? '')].filter(Boolean).join(' · ');
    return t(`ses.ev.${e.event}`, { defaultValue: e.event, who, n: d.count ?? d.signed_out ?? 0 });
  };
  return (
    <div className="us-section sessions">
      <h3 className="us-h"><ShieldCheck size={18} /> {t('ses.title')}</h3>
      <p className="muted small">{t('ses.hint')}</p>
      <div className="session-list">
        {list == null ? [0, 1].map((i) => <Skeleton key={i} h={64} r={10} />) : [...list.filter((s) => s.current), ...others].map(row)}
      </div>
      {others.length > 0 && <Button variant="danger" onClick={revokeOthers}><LogOut size={14} /> {t('ses.revokeAll')}</Button>}
      <h3 className="us-h">{t('ses.log')}</h3>
      <div className="security-log">
        {log == null ? <Skeleton h={40} r={8} /> : log.length === 0 ? <p className="muted small">{t('ses.logEmpty')}</p> : log.slice(0, 30).map((e) => (
          <div key={e.id} className="log-row" data-event={e.event}>
            <span className="muted small log-at">{when(e.at, i18n.language)}</span>
            <span>{evText(e)}{e.by_current && e.event !== 'login' && e.event !== 'register' && <span className="muted small"> — {t('ses.byThis')}</span>}</span>
            <span className="muted small">{e.ip}</span>
          </div>
        ))}
      </div>
      <p className="muted small">{t('ses.geoCredit')} <a href="https://db-ip.com" target="_blank" rel="noreferrer">DB-IP</a></p>
    </div>
  );
}

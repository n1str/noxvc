// Поиск сообщений: строка в шапке чата с подсказками фильтров и панель результатов на месте списка участников.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Hash, Search as SearchIcon, X } from 'lucide-react';
import { create } from 'zustand';
import { api } from '../lib/api';
import { Avatar, IconButton, Skeleton } from '../ui';
import { useStore, type Message } from '../store';
import { Markdown, TokenCtx, type TokenResolver } from './markdown';

interface Hit { message: Message; channel_name: string; guild_id: number | null }
type Sort = 'new' | 'old' | 'relevance';
const PAGE = 25;

interface SearchState {
  open: boolean; query: string; sort: Sort; offset: number; total: number; results: Hit[]; terms: string[]; loading: boolean; error: string;
  scope: { guild_id?: number; channel_id?: number };
  run(query: string, opts?: { sort?: Sort; offset?: number }): Promise<void>;
  close(): void;
}
let seq = 0;
export const useSearch = create<SearchState>((set, get) => ({
  open: false, query: '', sort: 'new', offset: 0, total: 0, results: [], terms: [], loading: false, error: '', scope: {},
  async run(query, opts = {}) {
    const q = query.trim();
    if (!q) return;
    const s = useStore.getState();
    // Область: текущий сервер или открытая переписка.
    const scope = s.view === 'home' ? (s.channelId != null ? { channel_id: s.channelId } : {}) : { guild_id: s.view as number };
    const sort = opts.sort ?? get().sort, offset = opts.offset ?? 0;
    const my = ++seq;
    set({ open: true, query: q, sort, offset, loading: true, error: '', scope });
    const params = new URLSearchParams({ q, sort, offset: String(offset), tz: String(-new Date().getTimezoneOffset()) });
    for (const [k, v] of Object.entries(scope)) params.set(k, String(v));
    try {
      const r = await api<{ total: number; results: Hit[]; terms: string[] }>('GET', `/search?${params}`);
      if (my !== seq) return; // пришёл ответ на устаревший запрос
      r.results.forEach((h) => useStore.setState((st) => ({ users: { ...st.users, [h.message.author.id]: { ...st.users[h.message.author.id], ...h.message.author } } })));
      set({ total: r.total, results: r.results, terms: r.terms, loading: false });
    } catch (e) {
      if (my === seq) set({ loading: false, error: (e as Error).message, results: [], total: 0 });
    }
  },
  // Результаты не чистим: панель доигрывает анимацию закрытия с прежним содержимым.
  close: () => { seq++; set({ open: false, loading: false }); },
}));

const FILTERS = ['from', 'mentions', 'in', 'has', 'before', 'after', 'during', 'pinned'] as const;
const HAS = ['link', 'file', 'image', 'video', 'audio'] as const;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

interface Suggestion { key: string; label: string; hint?: string; value: string; group: string; avatar?: Parameters<typeof Avatar>[0]['user'] }

/** Подсказки для последнего слова строки поиска. value — строка целиком после выбора. */
function useSuggestions(text: string): Suggestion[] {
  const { t } = useTranslation();
  const guild = useStore((s) => s.guild);
  const view = useStore((s) => s.view);
  const dms = useStore((s) => s.dms);
  return useMemo(() => {
    const last = text.match(/(\S*)$/)![1];
    const base = text.slice(0, text.length - last.length);
    const kv = last.match(/^([a-z]+):(.*)$/i);
    if (!kv) {
      const p = last.toLowerCase();
      return FILTERS.filter((f) => f.startsWith(p) && (f !== 'in' || view !== 'home')).map((f) => ({ key: f, label: `${f}:`, hint: t(`search.f.${f}`), value: `${base}${f}:`, group: t('search.filters') }));
    }
    const [, key, raw] = kv;
    const v = raw.toLowerCase();
    const pick = (val: string) => `${base}${key}:${val} `;
    switch (key.toLowerCase()) {
      case 'from':
      case 'mentions': {
        const people = view === 'home' ? dms.map((d) => ({ ...d.user, nick: null as string | null })) : guild?.members ?? [];
        return people
          .filter((m) => [m.username, m.display_name, m.nick ?? ''].some((x) => x.toLowerCase().includes(v)))
          .slice(0, 8)
          .map((m) => ({ key: `u${m.id}`, label: m.nick || m.display_name, hint: '@' + m.username, value: pick(m.username), group: t('search.members'), avatar: m }));
      }
      case 'in':
        return (guild?.channels ?? []).filter((c) => c.kind === 'text' && c.name.toLowerCase().includes(v)).slice(0, 8)
          .map((c) => ({ key: `c${c.id}`, label: '#' + c.name, value: pick(c.name.includes(' ') ? `"${c.name}"` : c.name), group: t('search.channels') }));
      case 'has':
        return HAS.filter((h) => h.startsWith(v)).map((h) => ({ key: h, label: h, hint: t(`search.has.${h}`), value: pick(h), group: t('search.values') }));
      case 'pinned':
        return ['true', 'false'].filter((x) => x.startsWith(v)).map((x) => ({ key: x, label: x, value: pick(x), group: t('search.values') }));
      case 'before': case 'after': case 'during': {
        const today = new Date(), yest = new Date(Date.now() - 86400e3);
        return [[iso(today), t('search.today')], [iso(yest), t('search.yesterday')]].filter(([d]) => d.startsWith(v))
          .map(([d, h]) => ({ key: d, label: d, hint: h, value: pick(d), group: t('search.dates') }));
      }
      default: return [];
    }
  }, [text, guild, view, dms, t]);
}

/** Строка поиска в шапке чата. Ctrl+F — фокус. */
export function SearchBox() {
  const { t } = useTranslation();
  const isDm = useStore((s) => s.view === 'home');
  const { query, open } = useSearch();
  const [text, setText] = useState(query);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);
  const suggestions = useSuggestions(text);
  useEffect(() => { if (!open) setText(''); }, [open]);
  useEffect(() => setSel(-1), [text]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); ref.current?.focus(); ref.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const apply = (sg: Suggestion) => { setText(sg.value); ref.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = suggestions.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); setSel((x) => (x + 1) % n); return; }
    if (e.key === 'ArrowUp' && n) { e.preventDefault(); setSel((x) => (x <= 0 ? n - 1 : x - 1)); return; }
    if (e.key === 'Tab' && n && focused) { e.preventDefault(); apply(suggestions[Math.max(sel, 0)]); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0 && suggestions[sel]) { apply(suggestions[sel]); return; }
      if (text.trim()) { useSearch.getState().run(text); ref.current?.blur(); }
      return;
    }
    if (e.key === 'Escape') { if (text) setText(''); else { useSearch.getState().close(); ref.current?.blur(); } }
  };
  const showList = focused && suggestions.length > 0;
  let lastGroup = '';
  return (
    <div className={`header-search ${focused || text ? 'wide' : ''}`}>
      <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={t(isDm ? 'search.placeholderDm' : 'search.placeholder')}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} aria-label={t('search.placeholder')} role="combobox" aria-expanded={showList} />
      {text ? (
        <button className="header-search-icon" aria-label={t('search.close')} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(''); useSearch.getState().close(); }}><X size={16} /></button>
      ) : <span className="header-search-icon" aria-hidden><SearchIcon size={16} /></span>}
      <AnimatePresence>
        {showList && (
          <motion.div className="search-suggest" role="listbox" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, pointerEvents: 'none' }} transition={{ duration: 0.12 }}>
            {suggestions.map((sg, i) => {
              const head = sg.group !== lastGroup ? <div key={`g-${sg.group}`} className="ac-title">{(lastGroup = sg.group)}</div> : null;
              return [head,
                <button key={sg.key} role="option" aria-selected={i === sel} className={`ac-item ${i === sel ? 'on' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); apply(sg); }} onMouseEnter={() => setSel(i)}>
                  {sg.avatar && <Avatar user={sg.avatar} size={20} />}
                  <span className="ac-label">{sg.label}</span>{sg.hint && <span className="muted small">{sg.hint}</span>}
                </button>];
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Панель результатов (вместо участников). */
export function SearchPanel() {
  const { t, i18n } = useTranslation();
  const st = useSearch();
  const users = useStore((s) => s.users);
  const guild = useStore((s) => s.guild);
  const resolver = useMemo<TokenResolver>(() => ({
    user: (id) => guild?.members.find((m) => m.id === id)?.nick || users[id]?.display_name,
    role: (id) => guild?.roles.find((r) => r.id === id),
    channel: (id) => guild?.channels.find((c) => c.id === id)?.name,
  }), [users, guild]);
  const pages = Math.max(1, Math.ceil(st.total / PAGE));
  const page = Math.floor(st.offset / PAGE) + 1;
  const go = (h: Hit) => {
    location.hash = `#msg/${h.guild_id ?? 'dm'}/${h.message.channel_id}/${h.message.id}`;
    if (window.innerWidth < 900) st.close();
  };
  let lastCh = -1;
  return (
    <motion.aside className="search-panel" aria-label={t('search.placeholder')} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.16 }}>
      <header className="search-head">
        <span className="search-count">{st.loading && !st.results.length ? '…' : t('search.results', { count: st.total })}</span>
        <select className="input search-sort" value={st.sort} onChange={(e) => st.run(st.query, { sort: e.target.value as Sort })} aria-label="sort">
          <option value="new">{t('search.sortNew')}</option>
          <option value="old">{t('search.sortOld')}</option>
          <option value="relevance">{t('search.sortRelevance')}</option>
        </select>
        <IconButton label={t('search.close')} onClick={st.close}><X size={18} /></IconButton>
      </header>
      <div className={`search-results ${st.loading ? 'loading' : ''}`}>
        {st.error && <p className="error search-empty" role="alert">{st.error}</p>}
        {!st.error && st.loading && !st.results.length && [0, 1, 2, 3].map((i) => <div key={i} className="search-skel"><Skeleton h={54} /></div>)}
        {!st.error && !st.loading && !st.results.length && <p className="muted search-empty">{t('search.empty')}</p>}
        <TokenCtx.Provider value={resolver}>
          {st.results.map((h) => {
            const head = h.message.channel_id !== lastCh ? <div key={`c${h.message.id}`} className="search-channel"><Hash size={14} />{h.channel_name}</div> : null;
            lastCh = h.message.channel_id;
            return [head,
              <button key={h.message.id} className="search-hit" onClick={() => go(h)}>
                <Avatar user={users[h.message.author.id] ?? h.message.author} size={32} />
                <div className="search-hit-body">
                  <div className="search-hit-meta"><b>{h.message.author.display_name}</b>
                    <span className="muted small">{new Date(h.message.created_at).toLocaleString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                  <div className="search-hit-text"><Markdown text={h.message.content} highlight={st.terms} /></div>
                  {!!h.message.attachments?.length && <div className="muted small">📎 {h.message.attachments.map((a) => a.name).join(', ')}</div>}
                </div>
              </button>];
          })}
        </TokenCtx.Provider>
      </div>
      {pages > 1 && (
        <footer className="search-pages">
          <IconButton label={t('search.prev')} disabled={page <= 1 || st.loading} onClick={() => st.run(st.query, { sort: st.sort, offset: st.offset - PAGE })}><ChevronLeft size={18} /></IconButton>
          <span className="muted small">{t('search.page', { n: page, total: pages })}</span>
          <IconButton label={t('search.next')} disabled={page >= pages || st.loading} onClick={() => st.run(st.query, { sort: st.sort, offset: st.offset + PAGE })}><ChevronRight size={18} /></IconButton>
        </footer>
      )}
    </motion.aside>
  );
}

// Markdown сообщений → React-узлы (без innerHTML: XSS невозможен по построению).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Hljs = typeof import('highlight.js/lib/common').default;
let hljsPromise: Promise<Hljs> | null = null;
const loadHljs = () => (hljsPromise ??= import('highlight.js/lib/common').then((m) => m.default));
import { Check, Copy } from 'lucide-react';
import { CustomEmojiImg, CUSTOM_RE } from './customEmoji';
import { INTERNAL, internalPath, ownLink } from '../lib/links';

/** Как показать токены упоминаний: имя пользователя/роли/канала и действия по клику. */
export interface TokenResolver {
  user(id: number): string | undefined;
  role(id: number): { name: string; color: number } | undefined;
  channel(id: number): string | undefined;
  onUser?(id: number, el: HTMLElement): void;
  onChannel?(id: number): void;
}
export const TokenCtx = createContext<TokenResolver | null>(null);

function MentionToken({ kind, id }: { kind: '@' | '@&' | '#'; id: number }) {
  const r = useContext(TokenCtx);
  if (kind === '@') {
    const name = r?.user(id);
    return <span className="md-mention clickable" role="button" tabIndex={0} onClick={(e) => r?.onUser?.(id, e.currentTarget)}>@{name ?? 'неизвестный'}</span>;
  }
  if (kind === '@&') {
    const role = r?.role(id);
    const color = role?.color ? `#${role.color.toString(16).padStart(6, '0')}` : undefined;
    return <span className="md-mention role" style={color ? { color, background: `color-mix(in oklch, ${color} 18%, transparent)` } : undefined}>@{role?.name ?? 'удалённая роль'}</span>;
  }
  const ch = r?.channel(id);
  return <span className="md-mention clickable" role="button" tabIndex={0} onClick={() => ch && r?.onChannel?.(id)}>#{ch ?? 'недоступный-канал'}</span>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  // HTML от highlight.js: исходный код в нём экранирован библиотекой, разметка — только <span class="hljs-…">.
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!lang || code.length > 20000) return;
    let alive = true;
    loadHljs().then((h) => {
      if (alive && h.getLanguage(lang)) setHtml(h.highlight(code, { language: lang, ignoreIllegals: true }).value);
    }).catch(() => {});
    return () => { alive = false; };
  }, [lang, code]);
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        <span>{lang || 'code'}</span>
        <button className="md-copy" aria-label="copy" onClick={() => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>{html != null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
    </div>
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <span className={`md-spoiler ${open ? 'open' : ''}`} onClick={() => setOpen(true)} role="button" tabIndex={0}>{children}</span>;
}

const SAFE_URL = /^https?:\/\/[^\s<]+[^\s<.,:;!?)\]'"]/;

/** Подсветка найденного (поиск): задаётся на время построения узлов в Markdown. */
let HL: RegExp | null = null;
/** Крупные эмодзи (сообщение только из эмодзи). */
let BIG = false;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Слова запроса → regexp по началу слова; длинные слова укорачиваем на окончание (поиск со стеммингом). */
function highlightRe(terms: string[]): RegExp | null {
  const stems = terms.filter(Boolean).map((w) => escapeRe(w.length > 4 ? w.slice(0, Math.max(3, w.length - 2)) : w));
  return stems.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${stems.join('|')})[\\p{L}\\p{N}]*`, 'giu') : null;
}
function marked(text: string, key: string): ReactNode[] {
  if (!HL) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(HL)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<mark key={`${key}.m${m.index}`} className="md-hl">{m[0]}</mark>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Инлайн-разметка: `код`, **жирный**, *курсив*, __подчёркнутый__, ~~зачёркнутый~~, ||спойлер||, ссылки, @упоминания. */
function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push(...marked(buf, `${key}.${i}`)); buf = ''; } };
  const wrap = (open: string, close: string, render: (inner: ReactNode[], k: string) => ReactNode) => {
    if (!text.startsWith(open, i)) return false;
    const end = text.indexOf(close, i + open.length);
    if (end <= i + open.length || text.slice(i + open.length, end).includes('\n')) return false;
    flush();
    out.push(render(inline(text.slice(i + open.length, end), `${key}.${i}`), `${key}.${i}`));
    i = end + close.length;
    return true;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push(<code key={`${key}.${i}`} className="md-code">{text.slice(i + 1, end)}</code>); i = end + 1; continue; }
    }
    if ((c === 'n' && text.startsWith('noxvc://', i)) || (c === 'r' && text.startsWith('relay://', i))) {
      const m = text.slice(i).match(INTERNAL);
      const path = m && internalPath(m[0]);
      if (m && path) {
        flush();
        out.push(<a key={`${key}.${i}`} href={`#${path}`} className="internal-link" onClick={(e) => { e.preventDefault(); location.hash = path; }}>{m[0]}</a>);
        i += m[0].length;
        continue;
      }
    }
    if (c === 'h' && (text.startsWith('http://', i) || text.startsWith('https://', i))) {
      // свои ссылки (приглашение, сообщение) — переход внутри Relay, без новой вкладки
      const own = ownLink(text.slice(i));
      if (own) {
        flush();
        out.push(<a key={`${key}.${i}`} href={`#${own.path}`} className="internal-link" onClick={(e) => { e.preventDefault(); location.hash = own.path; }}>{own.text}</a>);
        i += own.text.length;
        continue;
      }
      const m = text.slice(i).match(SAFE_URL);
      if (m) { flush(); out.push(<a key={`${key}.${i}`} href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>); i += m[0].length; continue; }
    }
    if (c === '<') {
      const ce = text.slice(i).match(CUSTOM_RE);
      if (ce) { flush(); out.push(<CustomEmojiImg key={`${key}.${i}`} id={ce[3]} name={ce[2]} big={BIG} />); i += ce[0].length; continue; }
      const m = text.slice(i).match(/^<(@&|@|#)(\d{1,19})>/);
      if (m) { flush(); out.push(<MentionToken key={`${key}.${i}`} kind={m[1] as '@' | '@&' | '#'} id={+m[2]} />); i += m[0].length; continue; }
    }
    if (c === '@' && (i === 0 || !/[\p{L}\p{N}_]/u.test(text[i - 1]))) {
      const m = text.slice(i + 1).match(/^[\p{L}\p{N}_.]+/u);
      if (m) { flush(); out.push(<span key={`${key}.${i}`} className="md-mention">@{m[0]}</span>); i += 1 + m[0].length; continue; }
    }
    if (wrap('**', '**', (n, k) => <strong key={k}>{n}</strong>)) continue;
    if (wrap('__', '__', (n, k) => <u key={k}>{n}</u>)) continue;
    if (wrap('~~', '~~', (n, k) => <s key={k}>{n}</s>)) continue;
    if (wrap('||', '||', (n, k) => <Spoiler key={k}>{n}</Spoiler>)) continue;
    if (wrap('*', '*', (n, k) => <em key={k}>{n}</em>)) continue;
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Блочная разметка: ```код```, > цитаты, # заголовки, - списки; остальное — абзацы с переносами. */
export function Markdown({ text, highlight, big }: { text: string; highlight?: string[]; big?: boolean }) {
  HL = highlight?.length ? highlightRe(highlight) : null;
  BIG = !!big;
  try { return <>{blocks(text)}</>; } finally { HL = null; BIG = false; }
}

function blocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);
  parts.forEach((part, pi) => {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const body = part.slice(3, -3);
      const nl = body.indexOf('\n');
      const lang = nl > 0 && /^[\w+-]{1,20}$/.test(body.slice(0, nl)) ? body.slice(0, nl) : '';
      nodes.push(<CodeBlock key={pi} lang={lang} code={(lang ? body.slice(nl + 1) : body).replace(/^\n|\n$/g, '')} />);
      return;
    }
    const lines = part.split('\n');
    let list: ReactNode[] = [];
    const flushList = (k: string) => { if (list.length) { nodes.push(<ul key={k}>{list}</ul>); list = []; } };
    lines.forEach((line, li) => {
      const k = `${pi}.${li}`;
      if (/^[-*] /.test(line)) { list.push(<li key={k}>{inline(line.slice(2), k)}</li>); return; }
      flushList(`${k}.ul`);
      const h = line.match(/^(#{1,3}) (.+)/);
      if (h) { const L = `h${h[1].length + 2}` as 'h3' | 'h4' | 'h5'; nodes.push(<L key={k} className="md-h">{inline(h[2], k)}</L>); return; }
      if (line.startsWith('> ')) { nodes.push(<blockquote key={k}>{inline(line.slice(2), k)}</blockquote>); return; }
      nodes.push(<span key={k} className="md-line">{inline(line, k)}{li < lines.length - 1 ? '\n' : ''}</span>);
    });
    flushList(`${pi}.end`);
  });
  return nodes;
}

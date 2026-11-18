// Пикер эмодзи: поиск (ru/en, шорткоды, теги), категории, недавние, виртуализация строк.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Apple, Car, Clock, Flag, Hash as HashIcon, Lightbulb, PawPrint, Search, Server, Smile, Trophy, Users } from 'lucide-react';
import { useStore, type CustomEmoji } from '../store';
import { customToken } from './customEmoji';
import { GROUPS, loadEmoji, pushRecent, recentEmoji, searchEmoji, type Emoji } from '../lib/emoji';
import { Skeleton } from '../ui';

const COLS = 9;
const ICONS: Record<number, typeof Smile> = { 0: Smile, 1: Users, 3: PawPrint, 4: Apple, 5: Car, 6: Trophy, 7: Lightbulb, 8: HashIcon, 9: Flag };
type Row = { kind: 'head'; title: string; key: string } | { kind: 'emoji'; items: Emoji[]; key: string } | { kind: 'custom'; items: CustomEmoji[]; key: string };

export function EmojiPicker({ onPick }: { onPick(char: string): void }) {
  const { t } = useTranslation();
  const [all, setAll] = useState<Emoji[] | null>(null);
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<Emoji | null>(null);
  const [hoverCustom, setHoverCustom] = useState<CustomEmoji | null>(null);
  const guild = useStore((s) => (s.view !== 'home' ? s.guild : null));
  const customAll = guild?.emojis ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { loadEmoji().then(setAll); }, []);

  const rows = useMemo<Row[]>(() => {
    if (!all) return [];
    const chunk = (list: Emoji[], key: string) => {
      const out: Row[] = [];
      for (let i = 0; i < list.length; i += COLS) out.push({ kind: 'emoji', items: list.slice(i, i + COLS), key: `${key}-${i}` });
      return out;
    };
    const customRows = (list: CustomEmoji[], key: string) => {
      const out: Row[] = [];
      for (let i = 0; i < list.length; i += COLS) out.push({ kind: 'custom', items: list.slice(i, i + COLS), key: `${key}-${i}` });
      return out;
    };
    if (q.trim()) {
      const cq = q.trim().toLowerCase().replace(/:/g, '');
      return [...customRows(customAll.filter((e) => e.name.toLowerCase().includes(cq)), 'csearch'), ...chunk(searchEmoji(all, q, 180), 'search')];
    }
    const out: Row[] = [];
    if (customAll.length) out.push({ kind: 'head', title: guild!.name, key: 'h-server' }, ...customRows(customAll, 'server'));
    const byChar = new Map(all.map((e) => [e.char, e]));
    const recent = recentEmoji().map((c) => byChar.get(c)).filter(Boolean) as Emoji[];
    if (recent.length) out.push({ kind: 'head', title: t('emoji.recent'), key: 'h-recent' }, ...chunk(recent, 'recent'));
    for (const gr of GROUPS) {
      out.push({ kind: 'head', title: t(`emoji.group${gr}`), key: `h-${gr}` }, ...chunk(all.filter((e) => e.group === gr), `g${gr}`));
    }
    return out;
  }, [all, q, t, customAll, guild]);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: (i) => (rows[i].kind === 'head' ? 28 : 36), overscan: 6 });
  const jump = (gr: number | 'recent' | 'server') => {
    const i = rows.findIndex((r) => r.key === (gr === 'recent' ? 'h-recent' : gr === 'server' ? 'h-server' : `h-${gr}`));
    if (i >= 0) v.scrollToIndex(i, { align: 'start' });
  };
  const pick = (e: Emoji) => { pushRecent(e.char); onPick(e.char); };

  return (
    <div className="emoji-picker">
      <label className="search-box"><Search size={16} /><input autoFocus placeholder={t('emoji.search')} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {!q && (
        <nav className="emoji-cats">
          {customAll.length > 0 && <button aria-label={guild!.name} title={guild!.name} onClick={() => jump('server')}><Server size={16} /></button>}
          <button aria-label={t('emoji.recent')} title={t('emoji.recent')} onClick={() => jump('recent')}><Clock size={16} /></button>
          {GROUPS.map((gr) => { const I = ICONS[gr]; return <button key={gr} aria-label={t(`emoji.group${gr}`)} title={t(`emoji.group${gr}`)} onClick={() => jump(gr)}><I size={16} /></button>; })}
        </nav>
      )}
      <div className="emoji-scroll" ref={scroller}>
        {!all ? <div className="emoji-loading">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={28} />)}</div> : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const r = rows[vi.index];
              return (
                <div key={r.key} className={r.kind === 'head' ? 'emoji-head' : 'emoji-row'} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, height: vi.size }}>
                  {r.kind === 'head' ? r.title : r.kind === 'custom' ? r.items.map((e) => (
                    <button key={e.id} className="emoji-custom-btn" title={`:${e.name}:`} onMouseEnter={() => { setHover(null); setHoverCustom(e); }} onClick={() => onPick(customToken(e))}>
                      <img src={e.url} alt={`:${e.name}:`} loading="lazy" />
                    </button>
                  )) : r.items.map((e) => (
                    <button key={e.char} title={`:${e.codes[0] ?? e.en.replace(/\s+/g, '_')}:`} onMouseEnter={() => { setHoverCustom(null); setHover(e); }} onClick={() => pick(e)}>{e.char}</button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {all && q && rows.length === 0 && <p className="muted small emoji-empty">{t('emoji.nothing')}</p>}
      </div>
      <footer className="emoji-preview">
        {hoverCustom ? <><img className="emoji-big-img" src={hoverCustom.url} alt="" /><span><b>:{hoverCustom.name}:</b><span className="muted small">{guild?.name}</span></span></> : hover ? <><span className="emoji-big">{hover.char}</span><span><b>{hover.ru}</b><span className="muted small">{hover.codes[0] ? `:${hover.codes[0]}:` : hover.en}</span></span></> : <span className="muted small">{t('emoji.hint')}</span>}
      </footer>
    </div>
  );
}

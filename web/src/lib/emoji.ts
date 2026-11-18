// Эмодзи: ленивая загрузка набора (src/data/emoji.json, ~250 КБ), поиск, группы, недавние.
export interface Emoji { char: string; group: number; ru: string; en: string; codes: string[]; tags: string }
type Row = [string, number, string, string, string, string];

let cache: Emoji[] | null = null;
let loading: Promise<Emoji[]> | null = null;

export function loadEmoji(): Promise<Emoji[]> {
  if (cache) return Promise.resolve(cache);
  loading ??= import('../data/emoji.json').then((m) => {
    cache = (m.default as unknown as Row[]).map(([char, group, ru, en, codes, tags]) => ({ char, group, ru, en, codes: codes ? codes.split(' ') : [], tags }));
    return cache;
  });
  return loading;
}
export const emojiReady = () => cache;

/** Группы emojibase (2 — компоненты — исключены при сборке). */
export const GROUPS = [0, 1, 3, 4, 5, 6, 7, 8, 9] as const;

/** Поиск: шорткод с начала > название с начала > вхождение в название > теги. */
export function searchEmoji(list: Emoji[], q: string, limit = 60): Emoji[] {
  const s = q.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!s) return list.slice(0, limit);
  const scored: [number, Emoji][] = [];
  for (const e of list) {
    let score = 0;
    if (e.codes.some((c) => c === s)) score = 100;
    else if (e.codes.some((c) => c.startsWith(s))) score = 80;
    else if (e.ru.startsWith(s) || e.en.toLowerCase().startsWith(s)) score = 60;
    else if (e.ru.includes(s) || e.en.toLowerCase().includes(s)) score = 40;
    else if (e.tags.includes(s)) score = 20;
    if (score) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, e]) => e);
}

const RECENT_KEY = 'relay_recent_emoji';
export function recentEmoji(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
export function pushRecent(char: string) {
  const list = [char, ...recentEmoji().filter((c) => c !== char)].slice(0, 24);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* приватный режим */ }
}

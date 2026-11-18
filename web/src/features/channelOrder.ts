// Порядок каналов и категорий при перетаскивании в боковой панели.
// Каналы без категории идут первыми (в панели — «Текстовые каналы» и «Голосовые каналы»), затем категории,
// каждая со своими каналами. После перестановки позиции пересчитываются подряд и уходят на сервер одним запросом.
import type { Channel } from '../store';

export interface ChannelPos { id: number; position: number; parent_id: number }

const byPos = (a: Channel, b: Channel) => a.position - b.position || a.id - b.id;

function split(chs: Channel[]) {
  const sorted = chs.filter((c) => c.kind !== 'thread' && c.kind !== 'dm').sort(byPos);
  const cats = sorted.filter((c) => c.kind === 'category');
  const catIds = new Set(cats.map((c) => c.id));
  const parentOf = (c: Channel) => (c.parent_id != null && catIds.has(c.parent_id) ? c.parent_id : null);
  const loose = sorted.filter((c) => c.kind !== 'category' && parentOf(c) == null);
  const children = new Map(cats.map((k) => [k.id, sorted.filter((c) => c.kind !== 'category' && parentOf(c) === k.id)]));
  return { cats, loose, children, parentOf };
}

function flatten(loose: Channel[], cats: Channel[], children: Map<number, Channel[]>, chs: Channel[]): ChannelPos[] | null {
  const out: ChannelPos[] = [];
  loose.forEach((c) => out.push({ id: c.id, position: out.length + 1, parent_id: 0 }));
  for (const k of cats) {
    out.push({ id: k.id, position: out.length + 1, parent_id: 0 });
    (children.get(k.id) ?? []).forEach((c) => out.push({ id: c.id, position: out.length + 1, parent_id: k.id }));
  }
  // Ничего не поменялось (тот же порядок и те же категории) — запрос не нужен.
  const { cats: c0, loose: l0, children: ch0 } = split(chs);
  const before = [...l0.map((c) => `${c.id}:0`), ...c0.flatMap((k) => [`${k.id}:0`, ...(ch0.get(k.id) ?? []).map((c) => `${c.id}:${k.id}`)])].join();
  return before === out.map((x) => `${x.id}:${x.parent_id}`).join() ? null : out;
}

/** Канал `id` — в категорию `parent` (null — без категории) перед каналом `before` (null — в конец). */
export function moveChannel(chs: Channel[], id: number, parent: number | null, before: number | null): ChannelPos[] | null {
  const { cats, loose, children } = split(chs);
  const ch = chs.find((c) => c.id === id);
  if (!ch || ch.kind === 'category' || before === id) return null;
  const lists = [loose, ...children.values()];
  for (const l of lists) { const i = l.findIndex((c) => c.id === id); if (i >= 0) l.splice(i, 1); }
  const target = parent == null ? loose : children.get(parent);
  if (!target) return null;
  const i = before == null ? -1 : target.findIndex((c) => c.id === before);
  target.splice(i < 0 ? target.length : i, 0, ch);
  return flatten(loose, cats, children, chs);
}

/** Категорию `id` — перед категорией `before` (null — в конец). */
export function moveCategory(chs: Channel[], id: number, before: number | null): ChannelPos[] | null {
  const { cats, loose, children } = split(chs);
  const i = cats.findIndex((c) => c.id === id);
  if (i < 0 || before === id) return null;
  const [k] = cats.splice(i, 1);
  const j = before == null ? -1 : cats.findIndex((c) => c.id === before);
  cats.splice(j < 0 ? cats.length : j, 0, k);
  return flatten(loose, cats, children, chs);
}

/** Следующий элемент после `id` в списке (для «положить после»). */
export function nextId(chs: Channel[], id: number, parent: number | null | 'categories'): number | null {
  const { cats, loose, children } = split(chs);
  const l = parent === 'categories' ? cats : parent == null ? loose : children.get(parent) ?? [];
  const i = l.findIndex((c) => c.id === id);
  return i >= 0 && i + 1 < l.length ? l[i + 1].id : null;
}

/** Применить новые позиции к каналам (для мгновенного отображения до ответа сервера). */
export function applyOrder(chs: Channel[], list: ChannelPos[]): Channel[] {
  const m = new Map(list.map((x) => [x.id, x]));
  return chs.map((c) => { const x = m.get(c.id); return x ? { ...c, position: x.position, parent_id: x.parent_id || null } : c; });
}

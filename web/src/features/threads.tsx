// Ветки, форумы и опросы: плашка ветки у сообщения, действия в шапке, список веток канала,
// представление форума (посты, теги), создание поста, редактор тегов, опросы (создание и голосование).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { BarChart3, Bell, BellOff, Check, Menu as MenuIcon, MessageCircle, MessagesSquare, MoreHorizontal, Plus, Users, X } from 'lucide-react';
import { api } from '../lib/api';
import { humanize } from '../lib/mentionText';
import { appear } from '../design/tokens';
import { Avatar, Button, Field, IconButton, Input, Skeleton, Switch } from '../ui';
import { Menu, useModal, usePopover, type MenuItem } from '../ui/overlays';
import { useLayout } from '../ui/layout';
import { canChannel, displayName, P, useStore, type Channel, type ForumTag, type Message } from '../store';
import { confirmModal, FormModal, promptModal } from './modals';
import { SearchBox } from './search';
import { InboxButton } from './notify';
import i18n from '../i18n';

/** Перевод вне компонента (для модалок, создаваемых из обработчиков). */
const tr = (k: string) => i18n.t(k);

/** «5 мин назад» и т.п. */
export function ago(ts: number, lang: string) {
  const s = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  for (const [unit, sec] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  }
  return rtf.format(0, 'minute');
}

// ---------- плашка ветки у стартового сообщения ----------
export function ThreadChip({ m }: { m: Message }) {
  const { t, i18n } = useTranslation();
  const live = useStore((s) => s.guild?.threads.find((x) => x.id === m.thread?.id));
  if (!m.thread) return null;
  const name = live?.name ?? m.thread.name;
  const count = live?.thread?.message_count ?? m.thread.message_count;
  const last = live?.thread?.last_message_at ?? m.thread.last_message_at;
  return (
    <button className="thread-chip" onClick={(e) => { e.stopPropagation(); useStore.getState().openThread(m.thread!.id); }}>
      <MessagesSquare size={16} />
      <b>{name}</b>
      <span className="thread-chip-count">{t('threads.count', { count })}</span>
      <span className="muted small">{ago(last, i18n.language)}</span>
    </button>
  );
}

// ---------- создание ветки ----------
export function createThreadModal(parent: Channel, message?: Message) {
  return promptModal(
    message ? tr('threads.fromMessage') : tr('threads.createTitle'),
    tr('threads.name'),
    message ? humanizePlain(message.content).slice(0, 40) : '',
    async (name) => {
      const th = await api<Channel>('POST', `/channels/${parent.id}/threads`, { name, message_id: message?.id });
      await useStore.getState().openThread(th.id, th);
    },
  );
}
function humanizePlain(content: string) {
  const s = useStore.getState();
  return humanize(content, {
    user: (id) => s.users[id]?.display_name,
    role: (id) => s.guild?.roles.find((r) => r.id === id),
    channel: (id) => s.guild?.channels.find((c) => c.id === id)?.name,
  }).text;
}

// ---------- список веток канала (кнопка в шапке) ----------
function ThreadsPanel({ parent, onDone }: { parent: Channel; onDone(): void }) {
  const { t, i18n } = useTranslation();
  const modal = useModal();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [list, setList] = useState<Channel[] | null>(null);
  useEffect(() => {
    setList(null);
    api<{ threads: Channel[] }>('GET', `/channels/${parent.id}/threads${tab === 'archived' ? '?archived=true' : ''}`).then((r) => setList(r.threads)).catch(() => setList([]));
  }, [parent.id, tab]);
  return (
    <div className="threads-panel" role="dialog" aria-label={t('threads.title')}>
      <header className="threads-head">
        <MessagesSquare size={18} /><h3>{t('threads.title')}</h3>
        <span className="grow" />
        {canChannel(parent, P.CREATE_THREADS) && (
          <Button size="sm" variant="primary" onClick={() => { onDone(); modal.open(createThreadModal(parent)); }}><Plus size={14} />{t('threads.create')}</Button>
        )}
      </header>
      <div className="th-tabs">
        {(['active', 'archived'] as const).map((k) => <button key={k} className={`th-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{t(`threads.${k}`)}</button>)}
      </div>
      <div className="threads-list">
        {list == null && [0, 1].map((i) => <div key={i} className="thread-item"><Skeleton h={36} /></div>)}
        {list?.length === 0 && <p className="muted threads-empty">{t(tab === 'active' ? 'threads.none' : 'threads.noneArchived')}</p>}
        {list?.map((th) => (
          <button key={th.id} className="thread-item" onClick={() => { onDone(); useStore.getState().openThread(th.id, th); }}>
            <MessagesSquare size={16} className="muted" />
            <span className="thread-item-name">{th.name}</span>
            <span className="muted small">{t('threads.count', { count: th.thread?.message_count ?? 0 })} · {ago(th.thread?.last_message_at ?? 0, i18n.language)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ThreadsButton({ parent }: { parent: Channel }) {
  const { t } = useTranslation();
  const pop = usePopover();
  return <IconButton label={t('threads.title')} onClick={(e) => pop.show(e.currentTarget.getBoundingClientRect(), <ThreadsPanel parent={parent} onDone={pop.hide} />)}><MessagesSquare size={20} /></IconButton>;
}

// ---------- действия в шапке ветки ----------
export function ThreadActions({ c }: { c: Channel }) {
  const { t } = useTranslation();
  const s = useStore();
  const pop = usePopover();
  const modal = useModal();
  const joined = s.guild?.joined_threads.includes(c.id);
  const meta = c.thread!;
  const mod = canChannel(c, P.MANAGE_THREADS);
  const own = meta.owner_id === s.me?.id;
  const patch = (body: object) => api('PATCH', `/threads/${c.id}`, body).catch((e) => s.toast(e.message, true));
  const menu = (el: HTMLElement) => {
    const items: MenuItem[] = [];
    if ((own && !meta.locked) || mod) {
      items.push({ label: t('threads.rename'), onSelect: () => modal.open(promptModal(t('threads.rename'), t('threads.name'), c.name, (v) => api('PATCH', `/threads/${c.id}`, { name: v }))) });
      items.push({ label: meta.archived ? t('threads.unarchive') : t('threads.archive'), onSelect: () => patch({ archived: !meta.archived }) });
    }
    if (mod) items.push({ label: meta.locked ? t('threads.unlock') : t('threads.lock'), onSelect: () => patch({ locked: !meta.locked }) });
    if (own || mod) items.push({ label: t('threads.delete'), danger: true, onSelect: () => modal.open(confirmModal(t('threads.delete'), t('threads.deleteSub'), t('chat.delete'), () => api('DELETE', `/threads/${c.id}`))) });
    if (!items.length) return;
    pop.show(el.getBoundingClientRect(), <Menu onDone={pop.hide} items={items} />);
  };
  return (
    <>
      {meta.archived && <span className="badge-soft">{t('threads.archivedBadge')}</span>}
      {meta.locked && <span className="badge-soft warn">{t('threads.lockedBadge')}</span>}
      <IconButton label={joined ? t('threads.unfollow') : t('threads.follow')} active={joined}
        onClick={() => api(joined ? 'DELETE' : 'PUT', `/threads/${c.id}/members/me`).catch((e) => s.toast(e.message, true))}>
        {joined ? <Bell size={18} /> : <BellOff size={18} />}
      </IconButton>
      {(own || mod) && <IconButton label={t('threads.actions')} onClick={(e) => menu(e.currentTarget)}><MoreHorizontal size={18} /></IconButton>}
    </>
  );
}

// ---------- форум ----------
interface Post extends Channel { first_message?: Message | null }

function TagChip({ tag, on, onClick }: { tag: ForumTag; on?: boolean; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'span';
  return <Comp className={`tag-chip ${on ? 'on' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>{tag.emoji && <span>{tag.emoji}</span>}{tag.name}</Comp>;
}

function NewPostModal({ forum, close }: { forum: Channel; close(): void }) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<number[]>([]);
  return (
    <FormModal title={t('forum.newPost')} text={'#' + forum.name} submit={t('forum.post')} close={close} onSubmit={async (fd) => {
      const th = await api<Channel>('POST', `/channels/${forum.id}/threads`, { name: fd.get('title'), content: fd.get('content'), applied_tags: tags });
      setTimeout(() => useStore.getState().openThread(th.id, th), 50);
    }}>
      <Input name="title" label={t('forum.title')} maxLength={100} autoFocus required />
      <Field label={t('forum.content')}><textarea name="content" className="input textarea" rows={5} maxLength={4000} required /></Field>
      {!!forum.tags?.length && (
        <Field label={t('forum.tags')}>
          <div className="tag-row">
            {forum.tags.map((tg) => <TagChip key={tg.id} tag={tg} on={tags.includes(tg.id)} onClick={() => setTags((x) => (x.includes(tg.id) ? x.filter((y) => y !== tg.id) : x.length < 5 ? [...x, tg.id] : x))} />)}
          </div>
        </Field>
      )}
    </FormModal>
  );
}

export function ForumTagsModal({ forum, close }: { forum: Channel; close(): void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<{ id?: number; name: string; emoji: string; key: number }[]>(() => (forum.tags ?? []).map((x, i) => ({ ...x, key: i })));
  const set = (key: number, patch: object) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  return (
    <FormModal title={t('forum.editTags')} text={'#' + forum.name} submit={t('modal.save')} close={close}
      onSubmit={() => api('PUT', `/channels/${forum.id}/tags`, rows.filter((r) => r.name.trim()).map(({ id, name, emoji }) => ({ id, name, emoji })))}>
      <div className="tag-editor">
        {rows.map((r) => (
          <div key={r.key} className="tag-edit-row">
            <input className="input tag-emoji" value={r.emoji} maxLength={8} placeholder="🙂" aria-label={t('forum.tagEmoji')} onChange={(e) => set(r.key, { emoji: e.target.value })} />
            <input className="input" value={r.name} maxLength={20} placeholder={t('forum.tagName')} aria-label={t('forum.tagName')} onChange={(e) => set(r.key, { name: e.target.value })} />
            <IconButton label={t('chat.delete')} tone="danger" type="button" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}><X size={16} /></IconButton>
          </div>
        ))}
        {rows.length < 20 && <Button type="button" variant="ghost" size="sm" onClick={() => setRows((x) => [...x, { name: '', emoji: '', key: Date.now() }])}><Plus size={14} />{t('forum.addTag')}</Button>}
      </div>
    </FormModal>
  );
}

function PostCard({ p, tags }: { p: Post; tags: ForumTag[] }) {
  const { t, i18n } = useTranslation();
  const s = useStore();
  const first = p.first_message;
  const unread = s.reads[p.id] && s.reads[p.id].last_message_id > s.reads[p.id].last_read_id;
  return (
    <motion.button layout className={`forum-post ${unread ? 'unread' : ''}`} onClick={() => s.openThread(p.id, p)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={appear}>
      <div className="forum-post-title">{p.name}{p.thread?.locked && <span className="badge-soft warn">{t('threads.lockedBadge')}</span>}</div>
      {!!p.thread?.applied_tags.length && (
        <div className="tag-row">{p.thread.applied_tags.map((id) => tags.find((x) => x.id === id)).filter(Boolean).map((tg) => <TagChip key={tg!.id} tag={tg!} />)}</div>
      )}
      {first && <div className="forum-post-excerpt">{humanizePlain(first.content)}</div>}
      <div className="forum-post-meta">
        {first && <><Avatar user={first.author} size={20} /><span>{displayName(s, first.author.id, first.author.display_name)}</span></>}
        <span className="grow" />
        <MessageCircle size={14} /><span>{p.thread?.message_count ?? 0}</span>
        <span>· {ago(p.thread?.last_message_at ?? 0, i18n.language)}</span>
      </div>
    </motion.button>
  );
}

export function Forum({ c }: { c: Channel }) {
  const { t } = useTranslation();
  const modal = useModal();
  const tick = useStore((s) => s.threadsTick);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [sort, setSort] = useState<'activity' | 'created'>('activity');
  const [tag, setTag] = useState<number | null>(null);
  const tags = c.tags ?? [];
  const load = async (more = false) => {
    const last = more ? posts?.at(-1) : undefined;
    const key = sort === 'created' ? last?.thread?.created_at : last?.thread?.last_message_at;
    const r = await api<{ threads: Post[]; has_more: boolean }>('GET', `/channels/${c.id}/threads?limit=30${sort === 'created' ? '&sort=created' : ''}${key ? `&before=${key}` : ''}`).catch(() => null);
    if (!r) return;
    setPosts((x) => (more ? [...(x ?? []), ...r.threads] : r.threads));
    setHasMore(r.has_more);
  };
  useEffect(() => { setPosts(null); }, [c.id, sort]);
  useEffect(() => { const h = setTimeout(() => load(), posts ? 250 : 0); return () => clearTimeout(h); }, [c.id, sort, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (posts ?? []).filter((p) => tag == null || p.thread?.applied_tags.includes(tag)), [posts, tag]);
  return (
    <main className="chat">
      <header className="chat-header">
        <IconButton label={t('chat.channels')} className="only-narrow" onClick={() => useLayout.getState().open('channels')}><MenuIcon size={20} /></IconButton>
        <MessagesSquare size={20} className="muted" />
        <h1>{c.name}</h1>
        <span className="grow" />
        <SearchBox />
        <InboxButton />
        <IconButton label={t('chat.members')} className="only-medium" onClick={() => useLayout.getState().toggleMembers()}><Users size={20} /></IconButton>
      </header>
      <div className="forum">
        {c.topic && <div className="forum-guidelines"><b>{t('forum.guidelines')}</b><p>{c.topic}</p></div>}
        <div className="forum-toolbar">
          {canChannel(c, P.SEND_MESSAGES) && <Button variant="primary" onClick={() => modal.open((close) => <NewPostModal forum={c} close={close} />)}><Plus size={16} />{t('forum.newPost')}</Button>}
          <select className="input forum-sort" value={sort} onChange={(e) => setSort(e.target.value as 'activity' | 'created')} aria-label="sort">
            <option value="activity">{t('forum.sortActivity')}</option>
            <option value="created">{t('forum.sortCreated')}</option>
          </select>
          {tags.length > 0 && (
            <div className="tag-row">
              <TagChip tag={{ id: 0, name: t('forum.allTags'), emoji: '' }} on={tag == null} onClick={() => setTag(null)} />
              {tags.map((tg) => <TagChip key={tg.id} tag={tg} on={tag === tg.id} onClick={() => setTag(tag === tg.id ? null : tg.id)} />)}
            </div>
          )}
        </div>
        <div className="forum-list">
          {posts == null && [0, 1, 2].map((i) => <div key={i} className="forum-post"><Skeleton h={64} /></div>)}
          {posts && shown.length === 0 && <div className="forum-empty"><MessagesSquare size={28} /><p className="muted">{t(tag == null ? 'forum.empty' : 'forum.emptyFilter')}</p></div>}
          {shown.map((p) => <PostCard key={p.id} p={p} tags={tags} />)}
          {hasMore && <Button variant="ghost" onClick={() => load(true)}>{t('forum.more')}</Button>}
        </div>
      </div>
    </main>
  );
}

// ---------- опросы ----------
const DURATIONS: [string, number][] = [['h1', 1], ['h4', 4], ['h8', 8], ['h24', 24], ['d3', 72], ['w1', 168]];

export function PollModal({ channel, close }: { channel: Channel; close(): void }) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  return (
    <FormModal title={t('poll.title')} submit={t('poll.send')} close={close} onSubmit={(fd) => api('POST', `/channels/${channel.id}/messages`, {
      content: '', poll: { question: fd.get('question'), answers: answers.map((a) => a.trim()).filter(Boolean), multiselect: multi, duration_hours: +String(fd.get('duration')) },
    })}>
      <Input name="question" label={t('poll.question')} maxLength={300} autoFocus required />
      <div className="poll-edit">
        {answers.map((a, i) => (
          <div key={i} className="poll-edit-row">
            <input className="input" value={a} maxLength={55} placeholder={t('poll.answer', { n: i + 1 })} aria-label={t('poll.answer', { n: i + 1 })}
              onChange={(e) => setAnswers((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
            {answers.length > 2 && <IconButton type="button" label={t('chat.delete')} tone="danger" onClick={() => setAnswers((x) => x.filter((_, j) => j !== i))}><X size={16} /></IconButton>}
          </div>
        ))}
        {answers.length < 10 && <Button type="button" size="sm" variant="ghost" onClick={() => setAnswers((x) => [...x, ''])}><Plus size={14} />{t('poll.addAnswer')}</Button>}
      </div>
      <Field label={t('poll.duration')}>
        <select name="duration" className="input" defaultValue="24">{DURATIONS.map(([k, h]) => <option key={k} value={h}>{t(`poll.${k}`)}</option>)}</select>
      </Field>
      <Switch label={t('poll.multiselect')} checked={multi} onChange={setMulti} />
    </FormModal>
  );
}

export function PollButton({ channel, disabled }: { channel: Channel; disabled?: boolean }) {
  const { t } = useTranslation();
  const modal = useModal();
  return <IconButton label={t('poll.create')} disabled={disabled} onClick={() => modal.open((close) => <PollModal channel={channel} close={close} />)}><BarChart3 size={20} /></IconButton>;
}

function useNow(ms = 30000) {
  const [, setTick] = useState(0);
  useEffect(() => { const h = setInterval(() => setTick((x) => x + 1), ms); return () => clearInterval(h); }, [ms]);
}

export function PollView({ m, canEnd }: { m: Message; canEnd: boolean }) {
  const { t } = useTranslation();
  const s = useStore();
  useNow(); // перерисовка раз в 30 с, чтобы шёл обратный отсчёт
  const now = Date.now(); // сравниваем с текущим временем: «Завершить» ставит expires_at = сейчас
  const [sel, setSel] = useState<number[]>([]);
  const p = m.poll!;
  const me = s.me!.id;
  const closed = p.expires_at <= now;
  const mine = p.answers.filter((a) => a.voters.includes(me)).map((a) => a.id);
  const voters = new Set(p.answers.flatMap((a) => a.voters)).size;
  const results = closed || mine.length > 0;
  const top = Math.max(0, ...p.answers.map((a) => a.voters.length));
  const vote = (answers: number[]) => api('PUT', `/messages/${m.id}/poll/votes`, { answers }).then(() => setSel([])).catch((e) => s.toast(e.message, true));
  const left = (() => {
    const min = Math.max(1, Math.round((p.expires_at - now) / 60000));
    return min >= 1440 ? t('poll.d', { n: Math.round(min / 1440) }) : min >= 60 ? t('poll.h', { n: Math.round(min / 60) }) : t('poll.m', { n: min });
  })();
  return (
    <div className="poll" onClick={(e) => e.stopPropagation()}>
      <div className="poll-q">{p.question}</div>
      <div className="muted small">{p.multiselect ? t('poll.multi') : t('poll.single')}</div>
      <div className="poll-answers">
        {p.answers.map((a) => {
          const pct = voters ? Math.round((a.voters.length / voters) * 100) : 0;
          const picked = mine.includes(a.id);
          if (results) {
            return (
              <div key={a.id} className={`poll-answer result ${picked ? 'mine' : ''} ${closed && a.voters.length === top && top > 0 ? 'winner' : ''}`} title={a.voters.map((u) => displayName(s, u)).join(', ')}>
                <motion.div className="poll-bar" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: 'easeOut' }} />
                <span className="poll-text">{a.text}</span>
                {picked && <Check size={16} className="poll-check" />}
                <span className="poll-pct">{pct}% · {a.voters.length}</span>
              </div>
            );
          }
          const on = sel.includes(a.id);
          return (
            <button key={a.id} className={`poll-answer ${on ? 'on' : ''}`} aria-pressed={on}
              onClick={() => setSel((x) => (p.multiselect ? (on ? x.filter((y) => y !== a.id) : [...x, a.id]) : [a.id]))}>
              <span className={`poll-mark ${p.multiselect ? 'box' : 'radio'}`}>{on && <Check size={12} />}</span>
              <span className="poll-text">{a.text}</span>
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <span className="muted small">{t('poll.votes', { count: voters })} · {closed ? t('poll.ended') : t('poll.left', { time: left })}</span>
        <span className="grow" />
        {!closed && !results && <Button size="sm" variant="primary" disabled={!sel.length} onClick={() => vote(sel)}>{t('poll.vote')}</Button>}
        {!closed && mine.length > 0 && <Button size="sm" variant="ghost" onClick={() => vote([])}>{t('poll.unvote')}</Button>}
        {!closed && canEnd && <Button size="sm" variant="ghost" onClick={() => api('POST', `/messages/${m.id}/poll/end`).catch((e) => s.toast(e.message, true))}>{t('poll.end')}</Button>}
      </div>
    </div>
  );
}


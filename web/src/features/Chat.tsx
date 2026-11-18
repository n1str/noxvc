import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, ArrowDown, AtSign, Check, ChevronRight, Hash, Menu as MenuIcon, MessagesSquare, Paperclip, Pencil, Pin, Reply, RotateCcw, SmilePlus, Trash2, Users, X } from 'lucide-react';
import { useLayout } from '../ui/layout';
import { api } from '../lib/api';
import { humanize, tokenize, type MentionMap } from '../lib/mentionText';
import { appear, spring } from '../design/tokens';
import { Avatar, Button, IconButton, Skeleton } from '../ui';
import { useHover } from '../lib/motion';
import { Menu, useModal, usePopover, type MenuItem } from '../ui/overlays';
import { canChannel, currentChannel, displayName, isMentioned, P, roleColor, useStore, type Attachment, type Message } from '../store';
import { Markdown, TokenCtx, type TokenResolver } from './markdown';
import { confirmModal } from './modals';
import { ProfileCard } from './Shell';
import { Composer } from './Composer';
import { EmojiPicker } from './EmojiPicker';
import { InboxButton } from './notify';
import { SearchBox } from './search';
import { Embeds, useLightbox } from './media';
import { EmojiGlyph, isEmojiOnly } from './customEmoji';
import { FriendsPage } from './social';
import { appLink } from '../lib/links';
import { CallView, DmCall, DmCallButtons } from './call';
import { createThreadModal, Forum, PollView, ThreadActions, ThreadChip, ThreadsButton } from './threads';

const GROUP_MS = 7 * 60_000;
const pad = (n: number) => String(n).padStart(2, '0');

function useTime() {
  const { t, i18n } = useTranslation();
  return useCallback((ts: number, full = false) => {
    const d = new Date(ts), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (!full) return hm;
    if (d.toDateString() === now.toDateString()) return t('chat.today', { time: hm });
    if (d.toDateString() === new Date(+now - 864e5).toDateString()) return t('chat.yesterday', { time: hm });
    return d.toLocaleString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }, [t, i18n.language]);
}

const isImage = (a: Attachment) => /\.(png|jpe?g|gif|webp)$/i.test(a.url) || a.content_type?.startsWith('image/');
const fmtSize = (n?: number) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

function Attachments({ list }: { list: Attachment[] }) {
  const images = list.filter(isImage), rest = list.filter((a) => !isImage(a));
  const open = useLightbox((l) => l.open);
  return (
    <>
      {images.length > 0 && (
        <div className={`att-gallery n${Math.min(images.length, 4)}`}>
          {images.map((a, i) => (
            <button key={a.url} className="att-img" aria-label={a.name} onClick={() => open(images.map((x) => ({ url: x.url, name: x.name })), i)}>
              <img src={a.url} alt={a.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {rest.map((a) => {
        if (/\.(mp4|webm|mov)$/i.test(a.url)) return <video key={a.url} className="att-video" src={a.url} controls preload="metadata" />;
        if (/\.(mp3|ogg|wav)$/i.test(a.url)) return <audio key={a.url} src={a.url} controls preload="none" />;
        return <a key={a.url} className="att-file" href={a.url} download={a.name}><Paperclip size={16} /><span>{a.name}</span><span className="muted small">{fmtSize(a.size)}</span></a>;
      })}
    </>
  );
}

/** Ссылка на сообщение: /#msg/<сервер|dm>/<канал>/<сообщение>. */
const messageLink = (guildId: number | null, channelId: number, id: number) => appLink(`msg/${guildId ?? 'dm'}/${channelId}/${id}`);

interface ItemProps {
  m: Message; grouped: boolean; fresh: boolean; editing: boolean; highlighted: boolean;
  selectMode: boolean; selected: boolean; onSelect(id: number): void;
  onReply(m: Message): void; onEdit(id: number | null): void; onStartSelect(id: number): void;
}

const MessageItem = memo(function MessageItem({ m, grouped, fresh, editing, highlighted, selectMode, selected, onSelect, onReply, onEdit, onStartSelect }: ItemProps) {
  const { t } = useTranslation();
  const s = useStore();
  const pop = usePopover();
  const modal = useModal();
  const time = useTime();
  const c = currentChannel(s)!;
  const meId = s.me!.id;
  const mine = m.author.id === meId;
  const pending = m.id < 0;
  const mention = isMentioned(s, m);
  const resolver = useTokenResolver();
  const react = (e: string) => api('PUT', `/messages/${m.id}/reactions/${encodeURIComponent(e)}`).catch((err) => s.toast(err.message, true));
  const profile = (el: HTMLElement) => pop.show(el.getBoundingClientRect(), <ProfileCard uid={m.author.id} onDone={pop.hide} />);
  const canManage = canChannel(c, P.MANAGE_MESSAGES);
  const canPin = canChannel(c, P.PIN_MESSAGES) || canManage;
  const del = (shift: boolean) => (shift ? api('DELETE', `/messages/${m.id}`) : modal.open(confirmModal(t('chat.deleteTitle'), t('chat.deleteHint'), t('chat.delete'), () => api('DELETE', `/messages/${m.id}`))));

  // Редактирование: токены показываем именами, при сохранении — обратно в токены.
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const editMap = useRef<MentionMap>([]);
  useEffect(() => {
    if (!editing) return;
    const h = humanize(m.content, resolver);
    editMap.current = h.map;
    setDraft(h.text);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveEdit = async () => {
    onEdit(null);
    const text = tokenize(draft.trim(), editMap.current);
    if (text && text !== m.content) await api('PATCH', `/messages/${m.id}`, { content: text }).catch((err) => s.toast(err.message, true));
  };

  const contextMenu = (e: RMouseEvent) => {
    if (pending || selectMode) return;
    e.preventDefault();
    const items: MenuItem[] = [];
    if (canChannel(c, P.ADD_REACTIONS)) items.push({ label: t('chat.react'), onSelect: () => pop.show({ x: e.clientX, y: e.clientY }, <EmojiPicker onPick={(x) => { pop.hide(); react(x); }} />) });
    if (canChannel(c, P.SEND_MESSAGES)) items.push({ label: t('chat.reply'), onSelect: () => onReply(m) });
    if (m.thread) items.push({ label: t('threads.open'), onSelect: () => s.openThread(m.thread!.id) });
    else if (c.kind === 'text' && canChannel(c, P.CREATE_THREADS)) items.push({ label: t('threads.create'), onSelect: () => modal.open(createThreadModal(c, m)) });
    if (mine) items.push({ label: t('chat.edit'), onSelect: () => onEdit(m.id) });
    if (canPin) items.push({ label: m.pinned ? t('chat.unpin') : t('chat.pin'), onSelect: () => api('PUT', `/messages/${m.id}/pin`) });
    items.push({ label: t('chat.copyText'), onSelect: () => navigator.clipboard?.writeText(humanize(m.content, resolver).text) });
    items.push({ label: t('chat.copyLink'), onSelect: () => navigator.clipboard?.writeText(messageLink(c.guild_id, c.id, m.id)).then(() => s.toast(t('chat.linkCopied'))) });
    if (canManage && c.kind !== 'dm') items.push({ label: t('chat.selectMany'), onSelect: () => onStartSelect(m.id) });
    items.push({ label: t('settings.copyId'), onSelect: () => navigator.clipboard?.writeText(String(m.id)) });
    if (mine || canManage) items.push({ label: t('chat.delete'), danger: true, onSelect: () => del(false) });
    pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={items} />);
  };

  const atts = m.attachments ?? (m.attachment ? [m.attachment] : []);
  // Анимированный аватар автора играет, пока курсор на сообщении (обработчики — только если он анимированный).
  const author = s.users[m.author.id] ?? m.author;
  const [hover, hoverProps] = useHover();
  // Сообщения заблокированных — свёрнуты (можно раскрыть).
  const blocked = s.relationships[m.author.id]?.kind === 2;
  if (blocked && !revealed) {
    return (
      <div className="msg blocked-msg" data-id={m.id}>
        <span className="muted small">{t('blocked.message')}</span>
        <button className="link-btn small" onClick={() => setRevealed(true)}>{t('blocked.show')}</button>
      </div>
    );
  }
  return (
    <motion.article data-id={m.id} onContextMenu={contextMenu} {...(author.avatar_anim && !grouped ? hoverProps : {})} onClick={() => selectMode && !pending && onSelect(m.id)}
      className={`msg ${grouped ? 'grouped' : ''} ${mention ? 'mention' : ''} ${editing ? 'editing' : ''} ${m.pending ?? ''} ${highlighted ? 'flash' : ''} ${selectMode ? 'selectable' : ''} ${selected ? 'selected' : ''}`}
      initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={appear}>
      {selectMode && !pending && <span className="msg-check" aria-hidden>{selected && <Check size={14} />}</span>}
      {m.reply_to && (
        <button className="msg-reply" onClick={(e) => { e.stopPropagation(); s.jumpTo(c.id, m.reply_to!.id); }}>
          <Reply size={12} /><b>{displayName(s, m.reply_to.author.id, m.reply_to.author.display_name)}</b> {humanize(m.reply_to.content, resolver).text}
        </button>
      )}
      <div className="msg-gutter">
        {grouped ? <time className="msg-hover-time">{time(m.created_at)}</time> : <button className="avatar-btn" onClick={(e) => { e.stopPropagation(); profile(e.currentTarget); }}><Avatar user={author} size={40} play={hover} /></button>}
      </div>
      <div className="msg-body">
        {!grouped && (
          <header className="msg-head">
            <button className="msg-author" style={{ color: roleColor(s, m.author.id) }} onClick={(e) => { e.stopPropagation(); profile(e.currentTarget); }}>{displayName(s, m.author.id, m.author.display_name)}</button>
            <time className="msg-time" dateTime={new Date(m.created_at).toISOString()}>{time(m.created_at, true)}</time>
          </header>
        )}
        {editing ? (
          <div className="msg-edit">
            <textarea className="input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onEdit(null); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } }} />
            <span className="muted small">{t('chat.editHint')}</span>
          </div>
        ) : m.content && (
          <div className={`msg-content ${isEmojiOnly(m.content) ? 'emoji-only' : ''}`}><Markdown text={m.content} big={isEmojiOnly(m.content)} />{m.edited_at && <span className="msg-edited"> ({t('chat.edited')})</span>}</div>
        )}
        {atts.length > 0 && <Attachments list={atts} />}
        {!editing && <Embeds m={m} canSuppress={!pending && (mine || canManage)} />}
        {m.poll && <PollView m={m} canEnd={mine || canManage} />}
        {m.thread && <ThreadChip m={m} />}
        {m.pending === 'failed' && (
          <div className="msg-failed">
            <AlertCircle size={14} /> {t('chat.notSent')}
            <Button size="sm" variant="ghost" onClick={() => s.retry(c.id, m.id)}><RotateCcw size={14} />{t('chat.retry')}</Button>
            <Button size="sm" variant="ghost" onClick={() => s.discard(c.id, m.id)}><X size={14} />{t('chat.discard')}</Button>
          </div>
        )}
        {m.reactions.length > 0 && (
          <div className="reactions">
            <AnimatePresence initial={false}>
              {m.reactions.map((r) => (
                <motion.button layout key={r.emoji} className={`reaction ${r.users.includes(meId) ? 'mine' : ''}`} title={r.users.map((u) => displayName(s, u)).join(', ')}
                  initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={spring} onClick={(e) => { e.stopPropagation(); react(r.emoji); }}>
                  <EmojiGlyph e={r.emoji} /><motion.span key={r.users.length} initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>{r.users.length}</motion.span>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
      {!pending && !selectMode && (
        <div className="msg-actions" role="toolbar">
          {canChannel(c, P.ADD_REACTIONS) && <IconButton label={t('chat.react')} onClick={(e) => pop.show(e.currentTarget.getBoundingClientRect(), <EmojiPicker onPick={(x) => { pop.hide(); react(x); }} />)}><SmilePlus size={16} /></IconButton>}
          {canChannel(c, P.SEND_MESSAGES) && <IconButton label={t('chat.reply')} onClick={() => onReply(m)}><Reply size={16} /></IconButton>}
          {c.kind === 'text' && (m.thread || canChannel(c, P.CREATE_THREADS)) && (
            <IconButton label={m.thread ? t('threads.open') : t('threads.create')} onClick={() => (m.thread ? s.openThread(m.thread.id) : modal.open(createThreadModal(c, m)))}><MessagesSquare size={16} /></IconButton>
          )}
          {mine && <IconButton label={t('chat.edit')} onClick={() => onEdit(m.id)}><Pencil size={16} /></IconButton>}
          {canPin && <IconButton label={m.pinned ? t('chat.unpin') : t('chat.pin')} active={m.pinned} onClick={() => api('PUT', `/messages/${m.id}/pin`)}><Pin size={16} /></IconButton>}
          {(mine || canManage) && <IconButton label={t('chat.delete')} tone="danger" onClick={(e) => del(e.shiftKey)}><Trash2 size={16} /></IconButton>}
        </div>
      )}
    </motion.article>
  );
});

/** Имена для токенов упоминаний и переходы по клику. */
function useTokenResolver(): TokenResolver {
  const s = useStore();
  const pop = usePopover();
  return useMemo(() => ({
    user: (id: number) => (s.users[id] || s.guild?.members.some((m) => m.id === id) ? displayName(s, id) : undefined),
    role: (id: number) => s.guild?.roles.find((r) => r.id === id),
    channel: (id: number) => (s.guild?.channels.find((c) => c.id === id) ?? s.guild?.threads.find((c) => c.id === id))?.name,
    onUser: (id: number, el: HTMLElement) => pop.show(el.getBoundingClientRect(), <ProfileCard uid={id} onDone={pop.hide} />),
    onChannel: (id: number) => (s.guild?.threads.some((x) => x.id === id) ? s.openThread(id) : s.selectChannel(id)),
  }), [s, pop]);
}

function Typing({ channelId }: { channelId: number }) {
  const { t } = useTranslation();
  const typing = useStore((s) => s.typing[channelId]);
  const s = useStore();
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1500); return () => clearInterval(id); }, []);
  const names = Object.entries(typing ?? {}).filter(([, exp]) => exp > Date.now()).map(([u]) => displayName(s, +u));
  const text = names.length === 0 ? '' : names.length === 1 ? t('chat.typing1', { a: names[0] }) : names.length === 2 ? t('chat.typing2', { a: names[0], b: names[1] }) : t('chat.typingMany');
  return <div className="typing" aria-live="polite">{text && <><span className="typing-dots"><i /><i /><i /></span>{text}</>}</div>;
}

export function Chat() {
  const { t, i18n } = useTranslation();
  const s = useStore();
  const modal = useModal();
  const resolver = useTokenResolver();
  const c = currentChannel(s);
  const hist = c ? s.history[c.id] : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [flashId, setFlashId] = useState<number | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const prevHeight = useRef<number | null>(null);

  useEffect(() => { setReplyTo(null); setEditing(null); setAtBottom(true); setSelectMode(false); setSelected(new Set()); seen.current = new Set(); }, [c?.id]);

  // Новые сообщения анимируются; первая порция — нет.
  const list = hist?.list ?? [];
  const firstLoad = seen.current.size === 0;
  const fresh = useMemo(() => {
    const set = new Set<number>();
    if (!firstLoad) for (const m of list) if (!seen.current.has(m.id)) set.add(m.id);
    return set;
  }, [list, firstLoad]);
  useEffect(() => { for (const m of list) seen.current.add(m.id); }, [list]);

  // Переход к сообщению: прокрутить к нему и подсветить.
  const hl = s.highlight;
  useEffect(() => {
    if (!hl || hl.channelId !== c?.id) return;
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector(`.msg[data-id="${hl.messageId}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      setFlashId(hl.messageId);
      setTimeout(() => setFlashId(null), 1600);
    });
  }, [hl?.at, c?.id, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Прокрутка: держимся низа; при подгрузке сверху сохраняем позицию (без прыжков).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevHeight.current != null) { el.scrollTop = el.scrollHeight - prevHeight.current; prevHeight.current = null; return; }
    if (atBottom && !hist?.detached && (!hl || hl.channelId !== c?.id || Date.now() - hl.at > 2000)) el.scrollTop = el.scrollHeight;
  }, [list, atBottom]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current!;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(nearBottom);
    if (el.scrollTop < 200 && hist && !hist.done && !hist.loading) {
      prevHeight.current = el.scrollHeight - el.scrollTop;
      s.loadOlder();
    }
    // Догрузка вниз в «окне» — только от прокрутки человеком, не от программного перехода к сообщению.
    if (nearBottom && hist?.detached && !(hl && Date.now() - hl.at < 2000)) s.loadNewer();
  };
  const onWheel = (e: React.WheelEvent) => {
    const el = scroller.current!;
    if (e.deltaY > 0 && hist?.detached && el.scrollHeight - el.scrollTop - el.clientHeight < 80) s.loadNewer();
  };

  if (!c && s.view === 'home') return <FriendsPage />;
  if (!c) {
    const home = s.view === 'home';
    return (
      <main className="chat empty">
        <IconButton label={t('chat.channels')} className="only-narrow empty-menu" onClick={() => useLayout.getState().open('channels')}><MenuIcon size={20} /></IconButton>
        <motion.div className="empty-state" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={appear}>
          <div className="empty-icon">{home ? <AtSign size={28} /> : <Hash size={28} />}</div>
          <h2>{home ? t('chat.emptyHome') : t('sidebar.noTextChannels')}</h2>
          <p className="muted">{home ? (s.guilds.length ? t('chat.emptyHomeSub') : t('chat.emptyNoGuild')) : t('chat.emptyGuild')}</p>
        </motion.div>
      </main>
    );
  }

  const toggleSel = (id: number) => setSelected((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const startSelect = (id: number) => { setSelectMode(true); setSelected(new Set([id])); };
  const bulkDelete = () => modal.open(confirmModal(t('chat.bulkTitle', { n: selected.size }), t('modal.irreversible'), t('chat.delete'), async () => {
    await api('POST', `/channels/${c.id}/messages/bulk-delete`, { ids: [...selected] });
    setSelectMode(false); setSelected(new Set());
  }));

  // «Новые сообщения»: красная линия перед первым непрочитанным (если открыли канал с непрочитанным).
  const afterId = s.marker?.channelId === c.id ? s.marker.afterId : null;
  const firstNew = afterId != null ? list.find((m) => m.id > afterId && m.author.id !== s.me?.id)?.id ?? null : null;

  const rows: React.ReactNode[] = [];
  let prev: Message | null = null;
  for (const m of list) {
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
    if (newDay) rows.push(<div key={`d${m.id}`} className="day-divider"><span>{new Date(m.created_at).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>);
    if (m.id === firstNew) rows.push(<div key="new-marker" className="new-marker"><span>{t('chat.newMessages')}</span></div>);
    const grouped = !newDay && m.id !== firstNew && !!prev && prev.author.id === m.author.id && !m.reply_to && m.created_at - prev.created_at < GROUP_MS;
    rows.push(<MessageItem key={m.id < 0 ? `p${m.nonce}` : m.id} m={m} grouped={grouped} fresh={fresh.has(m.id)} editing={editing === m.id} highlighted={flashId === m.id}
      selectMode={selectMode} selected={selected.has(m.id)} onSelect={toggleSel} onReply={setReplyTo} onEdit={setEditing} onStartSelect={startSelect} />);
    prev = m;
  }
  if (c.kind === 'forum') return <Forum c={c} />;
  if (c.kind === 'voice' || c.kind === 'stage') return <CallView c={c} />;
  const parent = c.kind === 'thread' ? s.guild?.channels.find((x) => x.id === c.parent_id) : undefined;
  const editLast = () => { const mine = [...list].reverse().find((m) => m.author.id === s.me?.id && m.id > 0); if (mine) setEditing(mine.id); };

  return (
    <main className="chat">
      <header className="chat-header">
        <IconButton label={t('chat.channels')} className="only-narrow" onClick={() => useLayout.getState().open('channels')}><MenuIcon size={20} /></IconButton>
        {c.group ? <Users size={20} className="muted" /> : c.kind === 'dm' ? <AtSign size={20} className="muted" /> : c.kind === 'thread' ? <MessagesSquare size={20} className="muted" /> : <Hash size={20} className="muted" />}
        {parent && <><button className="crumb" onClick={() => s.selectChannel(parent.id)}>{parent.name}</button><ChevronRight size={16} className="muted" /></>}
        <h1>{c.name}</h1>
        {c.topic && <span className="chat-topic">{c.topic}</span>}
        <span className="grow" />
        {c.kind === 'thread' && <ThreadActions c={c} />}
        {c.kind === 'dm' && <DmCallButtons c={c} />}
        {c.kind === 'text' && <ThreadsButton parent={c} />}
        <SearchBox />
        <InboxButton />
        {c.kind !== 'dm' && <IconButton label={t('chat.members')} className="only-medium" onClick={() => useLayout.getState().toggleMembers()}><Users size={20} /></IconButton>}
      </header>
      {c.kind === 'dm' && <AnimatePresence><DmCall key={c.id} c={c} /></AnimatePresence>}
      <TokenCtx.Provider value={resolver}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={c.id} className="messages" ref={scroller} onScroll={onScroll} onWheel={onWheel} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
            {hist?.done ? (
              <div className="channel-welcome">
                <div className="empty-icon">{c.group ? <Users size={28} /> : c.kind === 'dm' ? <AtSign size={28} /> : c.kind === 'thread' ? <MessagesSquare size={28} /> : <Hash size={28} />}</div>
                <h2>{c.kind === 'dm' ? c.name : c.kind === 'thread' ? t('threads.welcome', { name: c.name }) : t('chat.welcome', { name: c.name })}</h2>
                <p className="muted">{c.group ? t('group.welcome') : c.kind === 'dm' ? t('chat.dmStart', { name: c.topic.slice(1) }) : c.kind === 'thread' ? t('threads.welcomeSub') : t('chat.welcomeSub')}</p>
                {c.kind === 'thread' && c.thread?.starter_message_id && parent && (
                  <Button size="sm" variant="ghost" onClick={() => { location.hash = `#msg/${c.guild_id}/${parent.id}/${c.thread!.starter_message_id}`; }}>{t('threads.toStarter')}</Button>
                )}
              </div>
            ) : (
              <div className="history-skeleton" aria-label={t('chat.loading')}>
                {[0, 1, 2].map((i) => <div key={i} className="sk-msg"><Skeleton w={40} h={40} r={20} /><div><Skeleton w={120} /><Skeleton w={`${60 - i * 12}%`} /></div></div>)}
              </div>
            )}
            {rows}
            {hist?.loadingNewer && <div className="history-skeleton"><Skeleton w="40%" /></div>}
          </motion.div>
        </AnimatePresence>
      </TokenCtx.Provider>
      <AnimatePresence>
        {(hist?.detached || !atBottom) && (
          <motion.div className="jump" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={appear}>
            {hist?.detached && <span className="jump-note">{t('chat.viewingOld')}</span>}
            <Button size="sm" variant="primary" onClick={() => {
              if (hist?.detached) { s.backToPresent(); setAtBottom(true); return; }
              const el = scroller.current!; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }}>
              <ArrowDown size={14} /> {t('chat.jumpToPresent')}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {selectMode && (
          <motion.div className="select-bar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={appear}>
            <span>{t('chat.selected', { n: selected.size })}</span>
            <div className="row">
              <Button size="sm" variant="ghost" onClick={() => { setSelectMode(false); setSelected(new Set()); }}>{t('modal.cancel')}</Button>
              <Button size="sm" variant="danger" disabled={!selected.size} onClick={bulkDelete}><Trash2 size={14} />{t('chat.deleteSelected')}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Composer replyTo={replyTo} setReplyTo={setReplyTo} onEditLast={editLast} />
      <Typing channelId={c.id} />
    </main>
  );
}

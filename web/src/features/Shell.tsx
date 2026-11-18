// Каркас: рейка серверов → каналы → чат → участники.
import { useEffect, useMemo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { ChevronDown, Hand, Hash, HeadphoneOff, MicOff, MessageCirclePlus, MessageSquareWarning, MessagesSquare, Phone, Plus, Radio, Settings, Sparkles, Users, Video, Volume2, VolumeX, X } from 'lucide-react';
import { IncomingCall } from './call';
import { dinvoke } from '../lib/desktop';
import { api } from '../lib/api';
import { accentHue, spring } from '../design/tokens';
import { Avatar, Badge, GuildIcon, IconButton } from '../ui';
import { Menu, useModal, usePopover, type MenuItem } from '../ui/overlays';
import { canGuild, displayName, dmName, isOwner, notifyFor, P, roleColor, unreadOf, useStore, type Channel, type Member } from '../store';
import { CreateGroupModal, FriendButton, GroupIcon, GroupMembers, PresenceLabel, ProfileModal, StatusPicker, useProfile } from './social';
import { UserSettingsModal } from './userSettings';
import { notifyMenuItems } from './notify';
import { SearchPanel, useSearch } from './search';
import { Lightbox } from './media';
import { ForumTagsModal } from './threads';
import { has } from '../lib/perms';
import {
  AddServerModal, confirmModal, CreateChannelModal, EditChannelModal, InviteModal, InvitePreviewModal, NewDmModal, openDm, promptModal,
} from './modals';
import { Chat } from './Chat';
import { useLayout } from '../ui/layout';
import { ChannelPermissionsModal, MemberRolesModal, myTop, ServerSettingsModal, useViewAs, ViewAsBanner } from './settings';
import { useState } from 'react';
import { UpdateButton } from './updates';
import { accentVars, cardAccent, ProfileBanner } from './banner';
import { applyOrder, moveCategory, moveChannel, nextId, type ChannelPos } from './channelOrder';
import { useVoice, useVoiceWiring, VoiceControls, VoicePanel, VolumeControl } from './voice';
import { FeedbackLauncher, openFeedback } from './feedback';
import { ActivityCard, ActivityLine, GameIcon } from './activity';
import { startGames } from '../lib/games';


function Rail() {
  const { t } = useTranslation();
  const { guilds, view, reads, notify } = useStore();
  const modal = useModal();
  const pop = usePopover();
  // Сервер «светится», если есть непрочитанное в незаглушённых каналах; заглушённый сервер — только упоминания.
  const byGuild = useMemo(() => {
    const m = new Map<number | 'home', { unread: boolean; mention: number }>();
    for (const r of Object.values(reads)) {
      const u = unreadOf({ reads, notify }, r.channel_id);
      if (!u) continue;
      const k = r.guild_id ?? 'home';
      const cur = m.get(k) ?? { unread: false, mention: 0 };
      const guildMuted = r.guild_id != null && notifyFor({ notify }, r.channel_id, r.guild_id).guildMuted;
      m.set(k, { unread: cur.unread || (u.unread && !guildMuted), mention: cur.mention + u.mention });
    }
    for (const [k, v] of m) if (!v.unread && !v.mention) m.delete(k);
    return m;
  }, [reads, notify]);
  const guildMenu = (e: MouseEvent, id: number, name: string) => {
    e.preventDefault();
    pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={notifyMenuItems(t, modal.open, id, name)} />);
  };
  const [hoverGuild, setHoverGuild] = useState<number | null>(null);
  const item = (key: number | 'home', label: string, content: React.ReactNode, onClick: () => void) => {
    const active = view === key;
    const u = byGuild.get(key);
    return (
      <div className="rail-item" key={key} onMouseEnter={() => typeof key === 'number' && setHoverGuild(key)} onMouseLeave={() => setHoverGuild(null)}>
        {(active || u?.unread) && <motion.span layoutId={active ? 'rail-pill' : undefined} transition={spring} className={`rail-pill ${active ? 'active' : 'unread'}`} />}
        <button className={`rail-btn ${active ? 'active' : ''}`} aria-label={label} title={label} onClick={onClick}
          onContextMenu={key === 'home' ? undefined : (e) => guildMenu(e, key, label)}>{content}</button>
        {u?.mention ? <span className="rail-badge"><Badge count={u.mention} /></span> : null}
      </div>
    );
  };
  return (
    <nav className="rail" aria-label="Серверы">
      <LayoutGroup id="rail">
        {item('home', t('rail.home'), <Sparkles size={20} />, () => useStore.getState().selectHome())}
        <div className="rail-sep" />
        {guilds.map((g) => item(g.id, g.name, <GuildIcon guild={g} size={48} play={hoverGuild === g.id} />, () => useStore.getState().selectGuild(g.id)))}
      </LayoutGroup>
      <button className="rail-btn rail-add" aria-label={t('rail.add')} title={t('rail.add')} onClick={() => modal.open((close) => <AddServerModal close={close} />)}>
        <Plus size={20} />
      </button>
      <button className="rail-btn rail-feedback" aria-label={t('fb.title')} title={t('fb.title')} onClick={openFeedback}>
        <MessageSquareWarning size={20} />
      </button>
      <UpdateButton />
    </nav>
  );
}

const DRAG_TYPE = 'application/x-relay-voice-user';
const CH_TYPE = 'application/x-relay-channel';
/** Что сейчас перетаскивают в панели каналов (в dragover данные dataTransfer не читаются — только типы). */
let dragging: { kind: 'channel' | 'category'; id: number; chKind: Channel['kind'] } | null = null;
type Hint = 'before' | 'after' | 'inside';
/** Обработчики перетаскивания строки канала (свои — у Sidebar) и подсказка, куда упадёт. */
interface RowDnd { draggable: boolean; onDragStart(e: React.DragEvent): void; onDragEnd(): void; onDragOver(e: React.DragEvent): void; onDrop(e: React.DragEvent): void; hint: Hint | null }

function ChannelRow({ c, active, onContext, dnd }: { c: Channel; active: boolean; onContext(e: MouseEvent, c: Channel): void; dnd?: RowDnd }) {
  const { t } = useTranslation();
  const s = useStore();
  const pop = usePopover();
  const speaking = useVoice((v) => v.speaking);
  const [hoverUid, setHoverUid] = useState<number | null>(null);
  const inVoice = useVoice((v) => v.channelId) === c.id;
  const [dropping, setDropping] = useState(false);
  const unread = c.kind === 'text' || c.kind === 'thread' ? unreadOf(s, c.id) : null;
  // Ветки под каналом: те, за которыми слежу, и открытая сейчас.
  const threads = c.kind === 'text' || c.kind === 'forum'
    ? (s.guild?.threads ?? []).filter((x) => x.parent_id === c.id && (x.id === s.channelId || (!x.thread?.archived && s.guild!.joined_threads.includes(x.id))))
    : [];
  const muted = c.kind === 'text' && notifyFor(s, c.id, c.guild_id).channelMuted;
  const voiceUsers = c.kind === 'voice' || c.kind === 'stage' ? Object.values(s.voice).filter((v) => v.channel_id === c.id) : [];
  const canMove = has(c.permissions ?? 0, P.MOVE_MEMBERS);
  const move = (uid: number, to: number | null) => api('POST', `/guilds/${c.guild_id}/voice/move`, { user_id: uid, channel_id: to }).catch((e) => s.toast(e.message, true));
  const profile = (el: HTMLElement, uid: number) => pop.show(el.getBoundingClientRect(), <ProfileCard uid={uid} onDone={pop.hide} />);
  const voiceUserMenu = (e: MouseEvent, uid: number) => {
    e.preventDefault();
    const items: MenuItem[] = [{ label: t('voiceMove.profile'), onSelect: () => profile(e.target as HTMLElement, uid) }];
    if (canMove) {
      for (const other of s.guild?.channels.filter((x) => x.kind === 'voice' && x.id !== c.id && has(x.permissions ?? 0, P.MOVE_MEMBERS)) ?? []) {
        items.push({ label: t('voiceMove.moveTo', { name: other.name }), onSelect: () => move(uid, other.id) });
      }
      items.push({ label: t('voiceMove.disconnect'), danger: true, onSelect: () => move(uid, null) });
    }
    pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={items} />);
  };
  // Перетаскивание участника на другой голосовой канал (нужно MOVE_MEMBERS в обоих — проверит сервер).
  // Участника — на голосовой канал; канал — в другое место списка (dnd от Sidebar). Типы перетаскивания разные.
  const userDrop = c.kind === 'voice' && canMove;
  const dropProps = {
    draggable: dnd?.draggable,
    onDragStart: dnd?.onDragStart,
    onDragEnd: dnd?.onDragEnd,
    onDragOver: (e: React.DragEvent) => {
      if (userDrop && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropping(true); return; }
      dnd?.onDragOver(e);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (e: React.DragEvent) => {
      setDropping(false);
      if (userDrop && e.dataTransfer.types.includes(DRAG_TYPE)) {
        const uid = Number(e.dataTransfer.getData(DRAG_TYPE));
        if (uid && s.voice[uid]?.channel_id !== c.id) { e.preventDefault(); move(uid, c.id); }
        return;
      }
      dnd?.onDrop(e);
    },
  };
  return (
    <>
      <button className={`channel ${active || inVoice ? 'active' : ''} ${unread?.unread ? 'unread' : ''} ${muted ? 'muted-ch' : ''} ${dropping ? 'drop-target' : ''} ${dnd?.hint ? 'drop-' + dnd.hint : ''}`} onContextMenu={(e) => onContext(e, c)} {...dropProps}
        onClick={() => {
          // Голосовой канал/сцена: войти (если ещё не там) и открыть экран звонка.
          if ((c.kind === 'voice' || c.kind === 'stage') && useVoiceChannel() !== c.id) window.dispatchEvent(new CustomEvent('relay:join_voice', { detail: c }));
          s.selectChannel(c.id); useLayout.getState().open('none');
        }}>
        {(active || inVoice) && <motion.span layoutId={c.kind === 'voice' ? 'voice-active' : 'channel-active'} transition={spring} className="channel-active" />}
        <span className="channel-icon">{c.kind === 'voice' ? <Volume2 size={18} /> : c.kind === 'stage' ? <Radio size={18} /> : c.kind === 'forum' ? <MessagesSquare size={18} /> : <Hash size={18} />}</span>
        <span className="channel-name">{c.name}</span>
        {unread?.mention ? <Badge count={unread.mention} /> : null}
      </button>
      {threads.length > 0 && (
        <div className="thread-rows">
          {threads.map((x) => {
            const u = unreadOf(s, x.id);
            return (
              <button key={x.id} className={`channel thread-row ${x.id === s.channelId ? 'active' : ''} ${u?.unread ? 'unread' : ''}`}
                onClick={() => { s.selectChannel(x.id); useLayout.getState().open('none'); }}>
                {x.id === s.channelId && <motion.span layoutId="channel-active" transition={spring} className="channel-active" />}
                <span className="channel-name">{x.name}</span>
                {u?.mention ? <Badge count={u.mention} /> : null}
              </button>
            );
          })}
        </div>
      )}
      {voiceUsers.length > 0 && (
        <div className="voice-users">
          <AnimatePresence initial={false}>
            {voiceUsers.map((v) => (
              <motion.div key={v.user_id} layout className={`voice-user ${v.muted || v.deafened ? 'muted' : ''}`} data-uid={v.user_id}
                initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={spring}>
                {/* обычный div: у motion свои onDragStart (жесты), нам нужен HTML5 drag-n-drop */}
                <div role="button" tabIndex={0} className="voice-user-inner" draggable={canMove}
                  onMouseEnter={() => s.users[v.user_id]?.avatar_anim && setHoverUid(v.user_id)} onMouseLeave={() => setHoverUid(null)}
                  onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, String(v.user_id)); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={(e) => profile(e.currentTarget, v.user_id)} onKeyDown={(e) => e.key === 'Enter' && profile(e.currentTarget, v.user_id)}
                  onContextMenu={(e) => voiceUserMenu(e, v.user_id)}>
                  <Avatar user={s.users[v.user_id]} size={22} levelUid={v.user_id} speaking={speaking.has(v.user_id)} play={speaking.has(v.user_id) || hoverUid === v.user_id} />
                  <span>{displayName(s, v.user_id)}</span>
                  <span className="voice-flags">
                    {s.users[v.user_id]?.activity && <span className="voice-game" title={s.users[v.user_id]!.activity!.name}><GameIcon a={s.users[v.user_id]!.activity!} size={14} /></span>}
                    {v.hand && <Hand size={13} className="flag-hand" />}
                    {v.video && <Video size={13} />}
                    {v.screen && <span className="live-badge small-live">LIVE</span>}
                    {v.screen && !v.screen_audio && <VolumeX size={13} className="flag-off" aria-label={t('stream.audioMutedState')}><title>{t('stream.audioMutedState')}</title></VolumeX>}
                    {(v.muted || v.deafened) && <MicOff size={14} className="flag-off" aria-label={t('voice.mutedState')} />}
                    {v.deafened && <HeadphoneOff size={14} className="flag-off" aria-label={t('voice.deafenedState')} />}
                  </span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </>
  );
}

function Sidebar() {
  const { t } = useTranslation();
  const s = useStore();
  const modal = useModal();
  const pop = usePopover();
  const g = s.guild;
  const [hoverDm, setHoverDm] = useState<number | null>(null);

  const channelMenu = (e: MouseEvent, c: Channel) => {
    const items: MenuItem[] = c.kind === 'text' && g ? notifyMenuItems(t, modal.open, g.id, g.name, c) : [];
    if (c.kind === 'forum' && has(c.permissions ?? 0, P.MANAGE_CHANNELS)) items.push({ label: t('forum.editTags'), onSelect: () => modal.open((close) => <ForumTagsModal forum={c} close={close} />) });
    if (has(c.permissions ?? 0, P.MANAGE_CHANNELS)) items.push({ label: t('channelMenu.edit'), onSelect: () => modal.open((close) => <EditChannelModal channel={c} close={close} />) });
    if (has(c.permissions ?? 0, P.MANAGE_ROLES)) items.push({ label: t('settings.permissions'), onSelect: () => modal.open((close) => <ChannelPermissionsModal channel={c} close={close} />, { wide: true }) });
    if (has(c.permissions ?? 0, P.MANAGE_CHANNELS)) items.push({ label: t('channelMenu.delete'), danger: true, onSelect: () => modal.open(confirmModal(t('modal.deleteChannel', { name: c.name }), t('modal.deleteChannelSub'), t('chat.delete'), () => api('DELETE', `/channels/${c.id}`))) });
    if (!items.length) return;
    e.preventDefault();
    pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={items} />);
  };

  const guildMenu = (e: MouseEvent<HTMLButtonElement>) => {
    if (!g) return;
    const items: MenuItem[] = notifyMenuItems(t, modal.open, g.id, g.name);
    if (canGuild(s, P.MANAGE_GUILD) || canGuild(s, P.MANAGE_ROLES) || canGuild(s, P.MANAGE_EMOJIS)) items.push({ label: t('settings.server'), onSelect: () => modal.open((close) => <ServerSettingsModal close={close} />, { wide: true }) });
    if (canGuild(s, P.CREATE_INVITE)) items.push({ label: t('guildMenu.invite'), onSelect: () => modal.open((close) => <InviteModal guild={g} close={close} />) });
    if (canGuild(s, P.MANAGE_CHANNELS)) {
      items.push({ label: t('guildMenu.createChannel'), onSelect: () => modal.open((close) => <CreateChannelModal guildId={g.id} kind="text" close={close} />) });
      items.push({ label: t('guildMenu.createCategory'), onSelect: () => modal.open((close) => <CreateChannelModal guildId={g.id} kind="category" close={close} />) });
    }
    if (canGuild(s, P.MANAGE_GUILD)) items.push({ label: t('guildMenu.rename'), onSelect: () => modal.open(promptModal(t('modal.renameGuild'), t('modal.name'), g.name, (v) => api('PATCH', `/guilds/${g.id}`, { name: v }))) });
    items.push({ label: t('guildMenu.nick'), onSelect: () => modal.open(promptModal(t('modal.nick'), t('modal.nick'), g.members.find((m) => m.id === s.me?.id)?.nick ?? '', (v) => api('PATCH', `/guilds/${g.id}/members/${s.me?.id}`, { nick: v }), t('modal.nickHint'))) });
    if (isOwner(s)) items.push({ label: t('guildMenu.delete'), danger: true, onSelect: () => modal.open(confirmModal(t('modal.deleteGuild', { name: g.name }), t('modal.irreversible'), t('guildMenu.delete'), () => api('DELETE', `/guilds/${g.id}`))) });
    else items.push({ label: t('guildMenu.leave'), danger: true, onSelect: () => modal.open(confirmModal(t('modal.leaveGuild', { name: g.name }), t('modal.leaveSub'), t('guildMenu.leave'), () => api('DELETE', `/guilds/${g.id}/members/${s.me?.id}`))) });
    pop.show(e.currentTarget.getBoundingClientRect(), <Menu onDone={pop.hide} items={items} />);
  };

  const sections = useMemo(() => {
    if (!g) return [];
    const sorted = [...g.channels].sort((a, b) => a.position - b.position || a.id - b.id);
    const cats = sorted.filter((c) => c.kind === 'category');
    const inCat = (c: Channel) => cats.some((k) => k.id === c.parent_id);
    const loose = sorted.filter((c) => c.kind !== 'category' && !inCat(c));
    return [
      { key: 'text', title: t('sidebar.text'), kind: 'text' as const, parent: null, items: loose.filter((c) => c.kind === 'text' || c.kind === 'forum') },
      { key: 'voice', title: t('sidebar.voice'), kind: 'voice' as const, parent: null, items: loose.filter((c) => c.kind === 'voice' || c.kind === 'stage') },
      ...cats.map((k) => ({ key: `cat-${k.id}`, title: k.name, kind: 'text' as const, parent: k.id, items: sorted.filter((c) => c.parent_id === k.id) })),
    ];
  }, [g, t]);
  const manage = canGuild(s, P.MANAGE_CHANNELS);

  // ---------- перетаскивание каналов и категорий (MANAGE_CHANNELS; сервер проверит) ----------
  const [hint, setHint] = useState<{ key: string; pos: Hint } | null>(null);
  const showHint = (key: string, pos: Hint) => setHint((h) => (h?.key === key && h.pos === pos ? h : { key, pos }));
  const endDrag = () => { dragging = null; setHint(null); };
  const commit = (list: ChannelPos[] | null) => {
    endDrag();
    if (!list || !g) return;
    const gid = g.id, prev = g.channels;
    const put = (chs: Channel[]) => useStore.setState((st) => ({ guild: st.guild?.id === gid ? { ...st.guild, channels: chs } : st.guild }));
    put(applyOrder(prev, list)); // сразу, не дожидаясь сервера
    api('PATCH', `/guilds/${gid}/channels/order`, list).catch((e) => { put(prev); s.toast(e.message, true); });
  };
  /** Секция принимает канал: «Текстовые»/«Голосовые» без категории — только своего типа; категория — любой. */
  const accepts = (sec: { kind: 'text' | 'voice'; parent: number | null }) => {
    if (dragging?.kind !== 'channel') return false;
    if (sec.parent != null) return true;
    const voice = dragging.chKind === 'voice' || dragging.chKind === 'stage';
    return sec.kind === 'voice' ? voice : !voice;
  };
  const half = (e: React.DragEvent): 'before' | 'after' => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; };
  const rowDnd = (c: Channel, sec: { kind: 'text' | 'voice'; parent: number | null }): RowDnd | undefined => !manage || !g ? undefined : {
    draggable: true,
    hint: hint?.key === `ch-${c.id}` ? hint.pos : null,
    onDragStart: (e) => { dragging = { kind: 'channel', id: c.id, chKind: c.kind }; e.dataTransfer.setData(CH_TYPE, String(c.id)); e.dataTransfer.effectAllowed = 'move'; },
    onDragEnd: endDrag,
    onDragOver: (e) => { if (!accepts(sec)) return; e.preventDefault(); e.stopPropagation(); showHint(`ch-${c.id}`, half(e)); },
    onDrop: (e) => {
      if (!accepts(sec) || !dragging) return;
      e.preventDefault(); e.stopPropagation();
      const before = half(e) === 'before' ? c.id : nextId(g.channels, c.id, sec.parent);
      commit(moveChannel(g.channels, dragging.id, sec.parent, before));
    },
  };
  /** Секция: канал — в конец; категория — перед/после другой категории. */
  const sectionDnd = (sec: { key: string; kind: 'text' | 'voice'; parent: number | null }) => !manage || !g ? {} : {
    onDragOver: (e: React.DragEvent) => {
      if (dragging?.kind === 'category' && sec.parent != null) { e.preventDefault(); showHint(`sec-${sec.key}`, half(e)); }
      else if (accepts(sec)) { e.preventDefault(); showHint(`sec-${sec.key}`, 'inside'); }
    },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHint((h) => (h?.key === `sec-${sec.key}` ? null : h)); },
    onDrop: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      if (dragging.kind === 'category' && sec.parent != null) {
        const before = half(e) === 'before' ? sec.parent : nextId(g.channels, sec.parent, 'categories');
        commit(moveCategory(g.channels, dragging.id, before));
      } else if (accepts(sec)) commit(moveChannel(g.channels, dragging.id, sec.parent, null));
      else endDrag();
    },
  };
  const categoryMenu = (e: MouseEvent, id: number) => {
    const k = g?.channels.find((c) => c.id === id);
    if (!g || !k || !has(k.permissions ?? 0, P.MANAGE_CHANNELS)) return;
    e.preventDefault();
    const items: MenuItem[] = [
      { label: t('channelMenu.editCategory'), onSelect: () => modal.open((close) => <EditChannelModal channel={k} close={close} />) },
      ...(has(k.permissions ?? 0, P.MANAGE_ROLES) ? [{ label: t('settings.permissions'), onSelect: () => modal.open((close) => <ChannelPermissionsModal channel={k} close={close} />, { wide: true }) }] : []),
      { label: t('channelMenu.deleteCategory'), danger: true, onSelect: () => modal.open(confirmModal(t('modal.deleteCategory', { name: k.name }), t('modal.deleteCategorySub'), t('chat.delete'), () => api('DELETE', `/channels/${k.id}`))) },
    ];
    pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={items} />);
  };

  return (
    <aside className="sidebar">
      {g ? (
        <button className="sidebar-header" onClick={guildMenu}><span>{g.name}</span><ChevronDown size={18} /></button>
      ) : (
        <div className="sidebar-header static"><span>{t('sidebar.dms')}</span></div>
      )}
      <div className="channel-list">
        <LayoutGroup id="channels">
          {g ? sections.map((sec) => (sec.items.length || manage) && (
            <section key={sec.key} className={`channel-group ${sec.parent ? 'category' : ''} ${hint?.key === `sec-${sec.key}` ? 'drop-' + hint.pos : ''}`} {...sectionDnd(sec)}>
              <div className="channel-group-title" draggable={manage && sec.parent != null}
                onDragStart={sec.parent != null ? (e) => { dragging = { kind: 'category', id: sec.parent!, chKind: 'category' }; e.dataTransfer.setData(CH_TYPE, String(sec.parent)); e.dataTransfer.effectAllowed = 'move'; } : undefined}
                onDragEnd={endDrag}
                onContextMenu={sec.parent != null ? (e) => categoryMenu(e, sec.parent!) : undefined}>
                <span>{sec.title}</span>
                {manage && <IconButton label={t('sidebar.createChannel')} className="add-btn" onClick={() => modal.open((close) => <CreateChannelModal guildId={g.id} kind={sec.kind} parent={sec.parent} close={close} />)}><Plus size={14} /></IconButton>}
              </div>
              {sec.items.map((c) => <ChannelRow key={c.id} c={c} active={c.id === s.channelId} onContext={channelMenu} dnd={rowDnd(c, sec)} />)}
            </section>
          )) : (
            <>
              <button className={`channel ${s.channelId == null ? 'active' : ''}`} onClick={() => { s.selectHome(null); useLayout.getState().open('none'); }}>
                {s.channelId == null && <motion.span layoutId="channel-active" transition={spring} className="channel-active" />}
                <span className="channel-icon"><Users size={18} /></span><span className="channel-name">{t('friends.title')}</span>
                <Badge count={Object.values(s.relationships).filter((r) => r.kind === 3).length} />
              </button>
              <button className="channel" onClick={() => modal.open((close) => <NewDmModal close={close} />)}>
                <span className="channel-icon"><MessageCirclePlus size={18} /></span><span className="channel-name">{t('sidebar.newDm')}</span>
              </button>
              <div className="channel-group-title">
                <span>{t('sidebar.dms')}</span>
                <IconButton label={t('group.create')} className="add-btn" onClick={() => modal.open((close) => <CreateGroupModal close={close} />)}><Plus size={14} /></IconButton>
              </div>
              {s.dms.map((d) => (
                <button key={d.id} className={`channel dm ${d.id === s.channelId ? 'active' : ''} ${unreadOf(s, d.id)?.unread ? 'unread' : ''}`} onClick={() => { s.selectChannel(d.id); useLayout.getState().open('none'); }}
                  onMouseEnter={() => d.user?.avatar_anim && setHoverDm(d.id)} onMouseLeave={() => setHoverDm(null)}>
                  {d.id === s.channelId && <motion.span layoutId="channel-active" transition={spring} className="channel-active" />}
                  {d.kind === 'group_dm' ? <GroupIcon dm={d} size={28} /> : <Avatar user={d.user && (s.users[d.user.id] ?? d.user)} size={28} status play={hoverDm === d.id} />}
                  {Object.values(s.voice).some((v) => v.channel_id === d.id) && <Phone size={14} className="dm-call-dot" aria-label={t('call.inCall')} />}
                  <span className="channel-name dm-name">
                    <span>{dmName(d)}</span>
                    {d.kind === 'group_dm' && <span className="muted small">{t('group.membersCount', { n: (d.recipients?.length ?? 0) + 1 })}</span>}
                  </span>
                  <Badge count={unreadOf(s, d.id)?.mention ?? 0} />
                </button>
              ))}
            </>
          )}
        </LayoutGroup>
      </div>
      <VoicePanel />
      <footer className="user-panel">
        <button className="me-avatar" aria-label={t('presence.online')} onClick={(e) => pop.show(e.currentTarget.getBoundingClientRect(), <StatusPicker onDone={pop.hide} />)}>
          <Avatar user={{ ...s.me, presence: s.me?.presence === 'invisible' ? 'offline' : s.me?.presence }} size={34} status />
        </button>
        <div className="user-meta"><div className="name">{s.me?.display_name}</div><div className="muted small">{s.me?.status || '@' + s.me?.username}</div></div>
        <VoiceControls />
        <IconButton label={t('modal.settings')} onClick={() => modal.open((close) => <UserSettingsModal close={close} />, { wide: true })}><Settings size={18} /></IconButton>
      </footer>
    </aside>
  );
}

/** Роли в мини-профиле: просмотр всем; выдача/снятие — вторичный путь для тех, у кого MANAGE_ROLES (роли ниже своей). */
function RoleChips({ uid }: { uid: number }) {
  const { t } = useTranslation();
  const s = useStore();
  const [adding, setAdding] = useState(false);
  const g = s.guild;
  const member = g?.members.find((m) => m.id === uid);
  if (!g || !member || !s.me) return null;
  const top = myTop(g, s.me.id);
  const manage = canGuild(s, P.MANAGE_ROLES);
  const canTouch = (pos: number) => manage && (g.owner_id === s.me!.id || pos < top);
  const hex = (c: number) => (c ? `#${c.toString(16).padStart(6, '0')}` : 'var(--text-muted)');
  const roles = g.roles.filter((r) => !r.is_default && member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
  const addable = g.roles.filter((r) => !r.is_default && !member.roles.includes(r.id) && canTouch(r.position)).sort((a, b) => b.position - a.position);
  const toggle = (rid: number, on: boolean) => api(on ? 'PUT' : 'DELETE', `/guilds/${g.id}/members/${uid}/roles/${rid}`).catch((e) => s.toast(e.message, true));
  if (!roles.length && !addable.length) return null;
  return (
    <div className="role-chips">
      <AnimatePresence initial={false}>
        {roles.map((r) => (
          <motion.span key={r.id} layout className="role-chip" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={spring}>
            {canTouch(r.position)
              ? <button className="role-chip-x" aria-label={t('profile.removeRole', { name: r.name })} title={t('profile.removeRole', { name: r.name })} onClick={() => toggle(r.id, false)} style={{ background: hex(r.color) }}><X size={10} /></button>
              : <i style={{ background: hex(r.color) }} />}
            {r.name}
          </motion.span>
        ))}
      </AnimatePresence>
      {addable.length > 0 && (
        <button className="role-chip add" aria-label={t('profile.addRole')} title={t('profile.addRole')} onClick={() => setAdding(!adding)}><Plus size={12} /></button>
      )}
      {adding && (
        <div className="role-picker">
          {addable.map((r) => <button key={r.id} className="menu-item" onClick={() => { setAdding(false); toggle(r.id, true); }}><i className="role-dot" style={{ background: hex(r.color) }} />{r.name}</button>)}
        </div>
      )}
    </div>
  );
}

export function ProfileCard({ uid, onDone }: { uid: number; onDone(): void }) {
  const { t } = useTranslation();
  const s = useStore();
  const modal = useModal();
  const p = useProfile(uid);
  const u = s.users[uid] ?? p?.user;
  if (!u) return null;
  const member = s.guild?.members.find((m) => m.id === uid);
  const self = uid === s.me?.id;
  const banner = self ? s.me?.banner : p?.banner;
  const bannerColor = self ? s.me?.banner_color : p?.banner_color;
  const accent = cardAccent(banner, bannerColor);
  return (
    <div className={`profile-card ${accent ? 'accented' : ''}`} style={accentVars(accent)}>
      <ProfileBanner className="profile-banner" banner={banner} color={bannerColor ?? u.color} animate />
      <button className="profile-avatar-btn" aria-label={t('profile2.full')} onClick={() => { onDone(); modal.open((close) => <ProfileModal uid={uid} close={close} />); }}>
        <Avatar user={self ? { ...u, presence: s.me?.presence === 'invisible' ? 'offline' : s.me?.presence } : u} size={92} status play />
      </button>
      <div><b>{displayName(s, uid)}</b><div className="muted small">@{u.username}{p?.pronouns && ` · ${p.pronouns}`}</div></div>
      {!self && <PresenceLabel u={u} />}
      {self && u.status && <div className="small">{u.status}</div>}
      {p?.bio && <div className="profile-bio small">{p.bio}</div>}
      <ActivityCard a={u.activity} />
      {!self && <FriendButton uid={uid} compact />}
      <button className="link-btn small" onClick={() => { onDone(); modal.open((close) => <ProfileModal uid={uid} close={close} />); }}>{t('profile2.full')}</button>
      {uid !== s.me?.id && <VolumeControl uid={uid} />}
      {member && <RoleChips uid={uid} />}
      {uid !== s.me?.id && <button className="btn btn-primary btn-md" onClick={() => { onDone(); openDm({ user_id: uid }); }}>{t('profile.message')}</button>}
      {uid !== s.me?.id && member && canGuild(s, P.KICK_MEMBERS) && (
        <button className="btn btn-danger btn-md" onClick={() => { onDone(); modal.open(confirmModal(t('profile.kickTitle', { name: displayName(s, uid) }), t('profile.kickSub'), t('profile.kick'), () => api('DELETE', `/guilds/${s.guild!.id}/members/${uid}`))); }}>
          {t('profile.kick')}
        </button>
      )}
    </div>
  );
}

function Members() {
  const { t } = useTranslation();
  const s = useStore();
  const pop = usePopover();
  const g = s.guild;
  const [hoverMember, setHoverMember] = useState<number | null>(null);
  const groups = useMemo(() => {
    if (!g) return [];
    const hoisted = g.roles.filter((r) => r.hoist && !r.is_default).sort((a, b) => b.position - a.position);
    const byName = (a: Member, b: Member) => (a.nick || a.display_name).localeCompare(b.nick || b.display_name);
    const online = g.members.filter((m) => m.online).sort(byName);
    const out: { key: string; title: string; members: Member[] }[] = [];
    const taken = new Set<number>();
    for (const r of hoisted) {
      const ms = online.filter((m) => m.roles.includes(r.id) && !taken.has(m.id));
      ms.forEach((m) => taken.add(m.id));
      if (ms.length) out.push({ key: `r${r.id}`, title: `${r.name} — ${ms.length}`, members: ms });
    }
    const rest = online.filter((m) => !taken.has(m.id));
    if (rest.length) out.push({ key: 'online', title: t('members.online', { n: rest.length }), members: rest });
    const off = g.members.filter((m) => !m.online).sort(byName);
    if (off.length) out.push({ key: 'offline', title: t('members.offline', { n: off.length }), members: off });
    return out;
  }, [g, t]);
  const modal = useModal();
  if (!g) return null;
  const memberMenu = (m: Member): MenuItem[] => {
    const items: MenuItem[] = [];
    if (m.id !== s.me?.id) items.push({ label: t('profile.message'), onSelect: () => openDm({ user_id: m.id }) });
    if (canGuild(s, P.MANAGE_ROLES)) items.push({ label: t('settings.roles'), onSelect: () => modal.open((close) => <MemberRolesModal member={m} close={close} />) });
    if (canGuild(s, P.MANAGE_NICKNAMES) || m.id === s.me?.id) items.push({ label: t('guildMenu.nick'), onSelect: () => modal.open(promptModal(t('modal.nick'), t('modal.nick'), m.nick ?? '', (v) => api('PATCH', `/guilds/${g.id}/members/${m.id}`, { nick: v }), t('modal.nickHint'))) });
    if (m.id !== s.me?.id && m.id !== g.owner_id && canGuild(s, P.KICK_MEMBERS)) items.push({ label: t('profile.kick'), danger: true, onSelect: () => modal.open(confirmModal(t('profile.kickTitle', { name: m.nick || m.display_name }), t('profile.kickSub'), t('profile.kick'), () => api('DELETE', `/guilds/${g.id}/members/${m.id}`))) });
    items.push({ label: t('settings.copyId'), onSelect: () => navigator.clipboard?.writeText(String(m.id)).then(() => s.toast(t('settings.idCopied'))) });
    return items;
  };
  return (
    <aside className="members" aria-label={t('chat.members')}>
      {groups.map((grp) => (
        <section key={grp.key}>
          <div className="member-group-title">{grp.title}</div>
          {grp.members.map((m) => (
            <motion.button layout key={m.id} className={`member ${m.online ? '' : 'offline'}`} transition={spring}
              onMouseEnter={() => m.avatar_anim && setHoverMember(m.id)} onMouseLeave={() => setHoverMember(null)}
              onClick={(e) => pop.show(e.currentTarget.getBoundingClientRect(), <ProfileCard uid={m.id} onDone={pop.hide} />)}
              onContextMenu={(e) => { e.preventDefault(); pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={memberMenu(m)} />); }}>
              <Avatar user={m} size={32} status play={hoverMember === m.id} />
              <span className="member-text">
                <span className="member-name" style={{ color: roleColor(s, m.id) }}>{m.nick || m.display_name}{m.id === g.owner_id && <span className="owner-badge" title={t('members.owner')}> ♛</span>}</span>
                {m.activity ? <ActivityLine a={m.activity} /> : m.status && <span className="member-status">{m.status}</span>}
              </span>
            </motion.button>
          ))}
        </section>
      ))}
    </aside>
  );
}

export function Shell() {
  const s = useStore();
  const modal = useModal();
  useVoiceWiring();
  // Игровая активность (только приложение): найденная игра → сервер.
  useEffect(() => { startGames(); }, []);
  // Заголовок вкладки: (N) — упоминания, • — просто непрочитанное.
  useEffect(() => {
    const base = 'NoxVC';
    const all = Object.values(s.reads).map((r) => unreadOf(s, r.channel_id)).filter(Boolean);
    const mentions = all.reduce((n, u) => n + u!.mention, 0);
    const unread = all.some((u) => u!.unread && !u!.muted);
    document.title = mentions ? `(${mentions}) ${base}` : unread ? `• ${base}` : base;
    dinvoke('set_unread', { mentions, unread });
  }, [s.reads, s.notify]);
  // Атмосфера сервера: акцент плавно перетекает при переключении (через @property --accent-h).
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-h', String(accentHue(s.view === 'home' ? null : s.view)));
  }, [s.view]);
  // Ссылка-приглашение #invite/CODE.
  useEffect(() => {
    const check = async () => {
      const m = location.hash.match(/^#invite\/([A-Za-z0-9]+)/);
      if (m) { history.replaceState(null, '', location.pathname); modal.open((close) => <InvitePreviewModal code={m[1]} close={close} />); return; }
      const ml = location.hash.match(/^#msg\/(dm|\d+)\/(\d+)\/(\d+)$/);
      if (ml) {
        history.replaceState(null, '', location.pathname);
        const st = useStore.getState();
        const [ch, id] = [+ml[2], +ml[3]];
        if (ml[1] === 'dm') st.selectHome(ch); else await st.selectGuild(+ml[1], ch);
        if (useStore.getState().channelId === ch) await useStore.getState().jumpTo(ch, id);
        else st.toast('Сообщение недоступно', true);
      }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [modal]);
  const { drawer, membersOpen, open } = useLayout();
  const searching = useSearch((x) => x.open);
  // Поиск привязан к серверу/переписке: смена сервера закрывает результаты.
  useEffect(() => { useSearch.getState().close(); }, [s.view]);
  const viewing = useViewAs((v) => v.name);
  useEffect(() => { if (useViewAs.getState().name) useViewAs.setState({ name: null }); }, [s.view]);
  // Выбор канала/сервера закрывает выдвижную панель.
  useEffect(() => { open('none'); }, [s.channelId, s.view, open]);
  // Свайпы на узком экране: вправо от левого края — каналы, влево — участники.
  useEffect(() => {
    let x0 = 0, y0 = 0;
    const start = (e: TouchEvent) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; };
    const end = (e: TouchEvent) => {
      if (window.innerWidth >= 900) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
      const d = useLayout.getState().drawer;
      if (dx > 0) open(d === 'members' ? 'none' : 'channels');
      else open(d === 'channels' ? 'none' : useStore.getState().view !== 'home' ? 'members' : 'none');
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchend', end); };
  }, [open]);
  return (
    <div className={`shell drawer-${drawer} ${membersOpen ? 'members-open' : ''} ${searching ? 'searching' : ''} ${viewing ? 'viewing-as' : ''}`}>
      <div className="ambient" aria-hidden />
      <FeedbackLauncher />
      <ViewAsBanner />
      <Rail />
      <Sidebar />
      <Chat />
      <AnimatePresence mode="wait">{searching && <SearchPanel key="search" />}</AnimatePresence>
      <Lightbox />
      <IncomingCall />
      {!searching && s.view !== 'home' && s.channelId != null && <Members />}
      {!searching && s.view === 'home' && (() => { const dm = s.dms.find((d) => d.id === s.channelId && d.kind === 'group_dm'); return dm ? <GroupMembers dm={dm} /> : null; })()}
      <AnimatePresence>
        {drawer !== 'none' && (
          <motion.div className="drawer-scrim" onClick={() => open('none')} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
        )}
      </AnimatePresence>
    </div>
  );
}

/** Текущий голосовой канал (вне React — для обработчиков). */
function useVoiceChannel() { return useVoice.getState().channelId; }

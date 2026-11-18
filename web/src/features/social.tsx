// Фаза 4: страница друзей, групповые ЛС, выбор статуса, кнопка дружбы, полный профиль.
import { useEffect, useMemo, useState } from 'react';
import { ActivityCard } from './activity';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Crown, Menu as MenuIcon, MessageCircle, MoreVertical, Moon, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { api } from '../lib/api';
import { appear } from '../design/tokens';
import { Avatar, Button, IconButton, Input, Skeleton } from '../ui';
import { Menu, useModal, usePopover } from '../ui/overlays';
import { useLayout } from '../ui/layout';
import { dmName, presenceOf, useStore, type Dm, type Presence, type Relationship, type User } from '../store';
import { confirmModal, FormModal, openDm, promptModal } from './modals';
import { accentVars, cardAccent, ProfileBanner, type Banner } from './banner';

const errToast = (e: unknown) => useStore.getState().toast((e as Error).message, true);

/** Подпись присутствия (с учётом своего статуса-текста). */
export function PresenceLabel({ u }: { u: Partial<User> }) {
  const { t } = useTranslation();
  const p = presenceOf(u);
  return <span className="muted small">{u.status && p !== 'offline' ? u.status : t(`presence.${p}`)}</span>;
}

// ---------- кнопка дружбы (профиль, карточка) ----------
export function FriendButton({ uid, compact }: { uid: number; compact?: boolean }) {
  const { t } = useTranslation();
  const rel = useStore((s) => s.relationships[uid]);
  const add = () => api('POST', '/relationships', { user_id: uid }).catch(errToast);
  if (rel?.kind === 1) return <Button size={compact ? 'sm' : 'md'} variant="ghost" disabled><Check size={14} />{t('friends.friends')}</Button>;
  if (rel?.kind === 4) return <Button size={compact ? 'sm' : 'md'} variant="ghost" onClick={() => api('DELETE', `/relationships/${uid}`).catch(errToast)}>{t('friends.requestSent')}</Button>;
  if (rel?.kind === 3) return <Button size={compact ? 'sm' : 'md'} variant="primary" onClick={add}><Check size={14} />{t('friends.accept')}</Button>;
  if (rel?.kind === 2) return <Button size={compact ? 'sm' : 'md'} variant="ghost" onClick={() => api('DELETE', `/relationships/${uid}`).catch(errToast)}>{t('friends.unblock')}</Button>;
  return <Button size={compact ? 'sm' : 'md'} variant="ghost" onClick={add}><UserPlus size={14} />{t('friends.addFriend')}</Button>;
}

// ---------- страница друзей ----------
type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

function FriendRow({ r }: { r: Relationship }) {
  const { t } = useTranslation();
  const pop = usePopover();
  const modal = useModal();
  const u = useStore((s) => s.users[r.id] ?? r.user);
  const del = () => api('DELETE', `/relationships/${r.id}`).catch(errToast);
  const more = (el: HTMLElement) => pop.show(el.getBoundingClientRect(), <Menu onDone={pop.hide} items={[
    { label: t('friends.remove'), danger: true, onSelect: () => modal.open(confirmModal(t('friends.removeConfirm', { name: u.display_name }), '', t('friends.remove'), () => api('DELETE', `/relationships/${r.id}`))) },
    { label: t('friends.block'), danger: true, onSelect: () => modal.open(confirmModal(t('friends.blockConfirm', { name: u.display_name }), t('friends.blockSub'), t('friends.block'), () => api('PUT', `/relationships/${r.id}/block`))) },
  ]} />);
  return (
    <motion.div layout className="friend-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
      <Avatar user={u} size={36} status={r.kind === 1} />
      <div className="friend-meta">
        <div><b>{u.display_name}</b> <span className="muted small friend-username">@{u.username}</span></div>
        {r.kind === 1 ? <PresenceLabel u={u} /> : <span className="muted small">{t(r.kind === 3 ? 'friends.incoming' : r.kind === 4 ? 'friends.outgoing' : 'friends.blocked')}</span>}
      </div>
      <div className="friend-actions">
        {r.kind === 1 && <>
          <IconButton label={t('friends.message')} onClick={() => openDm({ user_id: r.id }).catch(errToast)}><MessageCircle size={18} /></IconButton>
          <IconButton label={t('friends.more')} onClick={(e) => more(e.currentTarget)}><MoreVertical size={18} /></IconButton>
        </>}
        {r.kind === 3 && <>
          <IconButton label={t('friends.accept')} className="accept" onClick={() => api('POST', '/relationships', { user_id: r.id }).catch(errToast)}><Check size={18} /></IconButton>
          <IconButton label={t('friends.decline')} tone="danger" onClick={del}><X size={18} /></IconButton>
        </>}
        {r.kind === 4 && <IconButton label={t('friends.cancel')} tone="danger" onClick={del}><X size={18} /></IconButton>}
        {r.kind === 2 && <IconButton label={t('friends.unblock')} onClick={del}><UserMinus size={18} /></IconButton>}
      </div>
    </motion.div>
  );
}

function AddFriend() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim().replace(/^@/, '');
    if (!n) return;
    try {
      await api('POST', '/relationships', { username: n });
      setMsg({ ok: true, text: t('friends.sent', { name: n }) });
      setName('');
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  };
  return (
    <form className="add-friend" onSubmit={submit}>
      <h2>{t('friends.addTitle')}</h2>
      <p className="muted">{t('friends.addHint')}</p>
      <div className={`add-friend-box ${msg ? (msg.ok ? 'ok' : 'err') : ''}`}>
        <input value={name} onChange={(e) => { setName(e.target.value); setMsg(null); }} placeholder={t('friends.addPlaceholder')} aria-label={t('friends.addPlaceholder')} autoFocus />
        <Button type="submit" variant="primary" disabled={!name.trim()}>{t('friends.send')}</Button>
      </div>
      {msg && <p className={msg.ok ? 'success small' : 'error small'} role="status">{msg.text}</p>}
    </form>
  );
}

export function FriendsPage() {
  const { t } = useTranslation();
  const rels = useStore((s) => s.relationships);
  const users = useStore((s) => s.users);
  const [tab, setTab] = useState<Tab>('online');
  const list = useMemo(() => {
    const all = Object.values(rels).map((r) => ({ ...r, user: users[r.id] ?? r.user }));
    const byName = (a: Relationship, b: Relationship) => a.user.display_name.localeCompare(b.user.display_name);
    if (tab === 'online') return all.filter((r) => r.kind === 1 && presenceOf(r.user) !== 'offline').sort(byName);
    if (tab === 'all') return all.filter((r) => r.kind === 1).sort(byName);
    if (tab === 'pending') return all.filter((r) => r.kind === 3 || r.kind === 4).sort((a, b) => a.kind - b.kind || b.since - a.since);
    if (tab === 'blocked') return all.filter((r) => r.kind === 2).sort(byName);
    return [];
  }, [rels, users, tab]);
  const incoming = Object.values(rels).filter((r) => r.kind === 3).length;
  const label = { online: t('friends.online'), all: t('friends.all'), pending: t('friends.pending'), blocked: t('friends.blocked') } as Record<string, string>;
  return (
    <main className="chat">
      <header className="chat-header friends-header">
        <IconButton label={t('chat.channels')} className="only-narrow" onClick={() => useLayout.getState().open('channels')}><MenuIcon size={20} /></IconButton>
        <Users size={20} className="muted" />
        <h1>{t('friends.title')}</h1>
        <span className="header-sep" />
        <nav className="friend-tabs" role="tablist">
          {(['online', 'all', 'pending', 'blocked'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`friend-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {label[k]}{k === 'pending' && incoming > 0 && <span className="friend-badge">{incoming}</span>}
            </button>
          ))}
          <button role="tab" aria-selected={tab === 'add'} className={`friend-tab add ${tab === 'add' ? 'on' : ''}`} onClick={() => setTab('add')}>{t('friends.add')}</button>
        </nav>
      </header>
      <div className="friends-body">
        {tab === 'add' ? <AddFriend /> : (
          <>
            <div className="friends-count">{t('friends.count', { label: label[tab], n: list.length })}</div>
            <AnimatePresence initial={false}>{list.map((r) => <FriendRow key={r.id} r={r} />)}</AnimatePresence>
            {list.length === 0 && (
              <motion.div className="friends-empty" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={appear}>
                <Users size={40} />
                <p className="muted">{t(`friends.empty${tab[0].toUpperCase()}${tab.slice(1)}`)}</p>
              </motion.div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// ---------- групповые ЛС ----------
function FriendPicker({ selected, onChange, exclude = [] }: { selected: number[]; onChange(v: number[]): void; exclude?: number[] }) {
  const { t } = useTranslation();
  const rels = useStore((s) => s.relationships);
  const [q, setQ] = useState('');
  const friends = Object.values(rels).filter((r) => r.kind === 1 && !exclude.includes(r.id))
    .filter((r) => !q || r.user.display_name.toLowerCase().includes(q.toLowerCase()) || r.user.username.toLowerCase().includes(q.toLowerCase()));
  if (!Object.values(rels).some((r) => r.kind === 1)) return <p className="muted">{t('group.noFriends')}</p>;
  return (
    <div className="friend-picker">
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('friends.addPlaceholder')} aria-label={t('friends.addPlaceholder')} />
      <div className="friend-picker-list">
        {friends.map((r) => {
          const on = selected.includes(r.id);
          return (
            <label key={r.id} className={`friend-pick ${on ? 'on' : ''}`}>
              <Avatar user={r.user} size={28} />
              <span className="grow">{r.user.display_name} <span className="muted small">@{r.user.username}</span></span>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? selected.filter((x) => x !== r.id) : selected.length < 9 ? [...selected, r.id] : selected)} />
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function CreateGroupModal({ close }: { close(): void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<number[]>([]);
  return (
    <FormModal title={t('group.createTitle')} text={t('group.pick')} submit={t('group.create')} close={close} onSubmit={async (fd) => {
      if (!sel.length) throw new Error(t('group.pick'));
      const dm = await api<Dm>('POST', '/groups', { user_ids: sel, name: fd.get('name') });
      useStore.setState((s) => ({ dms: s.dms.some((d) => d.id === dm.id) ? s.dms : [dm, ...s.dms] }));
      useStore.getState().selectHome(dm.id);
    }}>
      <Input name="name" label={t('group.name')} maxLength={100} />
      <FriendPicker selected={sel} onChange={setSel} />
    </FormModal>
  );
}

function AddToGroupModal({ dm, close }: { dm: Dm; close(): void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<number[]>([]);
  return (
    <FormModal title={t('group.addFriends')} submit={t('group.addFriends')} close={close} onSubmit={async () => {
      for (const id of sel) await api('PUT', `/groups/${dm.id}/recipients/${id}`);
    }}>
      <FriendPicker selected={sel} onChange={setSel} exclude={(dm.recipients ?? []).map((u) => u.id)} />
    </FormModal>
  );
}

/** Значок группы: два аватара внахлёст. */
export function GroupIcon({ dm, size = 32 }: { dm: Dm; size?: number }) {
  const [a, b] = dm.recipients ?? [];
  return (
    <span className="group-icon" style={{ width: size, height: size }}>
      <Avatar user={a} size={Math.round(size * 0.68)} />
      {b && <Avatar user={b} size={Math.round(size * 0.68)} />}
    </span>
  );
}

/** Правая панель групповой ЛС: участники, добавить, выйти. */
export function GroupMembers({ dm }: { dm: Dm }) {
  const { t } = useTranslation();
  const s = useStore();
  const modal = useModal();
  const pop = usePopover();
  const me = s.me!;
  const all: User[] = [{ ...me, presence: (me.presence === 'invisible' ? 'offline' : me.presence) as Presence, online: true }, ...(dm.recipients ?? [])];
  const isOwner = dm.owner_id === me.id;
  return (
    <aside className="members group-members">
      <div className="member-group-title">{t('group.members', { n: all.length })}</div>
      {all.map((u) => (
        <button key={u.id} className="member" onClick={() => modal.open((close) => <ProfileModal uid={u.id} close={close} />)}
          onContextMenu={(e) => {
            if (!isOwner || u.id === me.id) return;
            e.preventDefault();
            pop.show({ x: e.clientX, y: e.clientY }, <Menu onDone={pop.hide} items={[{ label: t('group.kick'), danger: true, onSelect: () => api('DELETE', `/groups/${dm.id}/recipients/${u.id}`).catch(errToast) }]} />);
          }}>
          <Avatar user={u} size={32} status />
          <span className="member-name">{u.display_name}</span>
          {dm.owner_id === u.id && <Crown size={14} className="owner-crown" aria-label={t('group.owner')} />}
        </button>
      ))}
      <div className="group-actions">
        <Button size="sm" variant="ghost" onClick={() => modal.open((close) => <AddToGroupModal dm={dm} close={close} />)}><UserPlus size={14} />{t('group.addFriends')}</Button>
        <Button size="sm" variant="ghost" onClick={() => modal.open(promptModal(t('group.rename'), t('group.name'), dm.name ?? '', (v) => api('PATCH', `/groups/${dm.id}`, { name: v })))}>{t('group.rename')}</Button>
        <Button size="sm" variant="danger" onClick={() => modal.open(confirmModal(t('group.leaveConfirm', { name: dmName(dm) }), t('group.leaveSub'), t('group.leave'), () => api('DELETE', `/groups/${dm.id}/recipients/${me.id}`)))}>{t('group.leave')}</Button>
      </div>
    </aside>
  );
}

// ---------- статус ----------
export function StatusPicker({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const modal = useModal();
  const me = useStore((s) => s.me)!;
  const set = (presence: string) => { onDone(); api('PATCH', '/me', { presence }).catch(errToast); };
  const items: [Presence, string?][] = [['online'], ['idle'], ['dnd', t('presence.dndHint')], ['invisible', t('presence.invisibleHint')]];
  return (
    <div className="status-picker" role="menu">
      {items.map(([p, hint]) => (
        <button key={p} role="menuitemradio" aria-checked={me.presence === p} className={`status-item ${me.presence === p ? 'on' : ''}`} onClick={() => set(p)}>
          <span className={`status-swatch ${p}`}>{p === 'idle' && <Moon size={10} />}</span>
          <span className="grow"><b>{t(`presence.${p}`)}</b>{hint && <span className="muted small">{hint}</span>}</span>
          {me.presence === p && <Check size={14} />}
        </button>
      ))}
      <div className="menu-sep" />
      <button className="status-item" onClick={() => { onDone(); modal.open(promptModal(t('presence.customStatus'), t('presence.customPlaceholder'), me.status ?? '', (v) => api('PATCH', '/me', { status: v }))); }}>
        <span className="grow">{t('presence.customStatus')}</span>
      </button>
    </div>
  );
}

// ---------- полный профиль ----------
interface FullProfile {
  user: User; bio: string; pronouns: string; banner_color: string | null; banner: Banner | null; created_at: number;
  mutual_guilds: { id: number; name: string; nick: string | null }[]; mutual_friends: User[]; relationship: number | null;
  member: { nick: string | null; joined_at: number; roles: number[] } | null;
}

export function useProfile(uid: number) {
  const guildId = useStore((s) => (s.view !== 'home' ? s.guild?.id : undefined));
  const [p, setP] = useState<FullProfile | null>(null);
  useEffect(() => {
    let alive = true;
    api<FullProfile>('GET', `/users/${uid}/profile${guildId ? `?guild_id=${guildId}` : ''}`).then((x) => alive && setP(x)).catch(() => {});
    return () => { alive = false; };
  }, [uid, guildId]);
  return p;
}

export function ProfileModal({ uid, close }: { uid: number; close(): void }) {
  const { t, i18n } = useTranslation();
  const s = useStore();
  const p = useProfile(uid);
  const [tab, setTab] = useState<'about' | 'guilds' | 'friends'>('about');
  const u = s.users[uid] ?? p?.user;
  const date = (ms: number) => new Date(ms).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className={`profile-modal ${cardAccent(p?.banner, p?.banner_color) ? 'accented' : ''}`} style={accentVars(cardAccent(p?.banner, p?.banner_color))}>
      <ProfileBanner className="profile-modal-banner" banner={p?.banner} color={p?.banner_color ?? u?.color ?? '#5865f2'} animate />
      <IconButton label={t('settings.close')} className="profile-modal-close" onClick={close}><X size={20} /></IconButton>
      <div className="profile-modal-head">
        <Avatar user={u} size={132} status play />
        <div className="profile-modal-actions">
          {uid !== s.me?.id ? <>
            <Button variant="primary" onClick={() => { close(); openDm({ user_id: uid }).catch(errToast); }}><MessageCircle size={16} />{t('friends.message')}</Button>
            <FriendButton uid={uid} />
          </> : <span className="muted small">{t('profile2.note')}</span>}
        </div>
      </div>
      <div className="profile-modal-name">
        <h2>{u?.display_name}</h2>
        <div className="muted">@{u?.username}{p?.pronouns && <> · {p.pronouns}</>}</div>
        {u?.status && <div className="small">{u.status}</div>}
        <ActivityCard a={u?.activity} />
      </div>
      <nav className="th-tabs" role="tablist">
        <button className={`th-tab ${tab === 'about' ? 'on' : ''}`} onClick={() => setTab('about')}>{t('profile2.about')}</button>
        {uid !== s.me?.id && <button className={`th-tab ${tab === 'guilds' ? 'on' : ''}`} onClick={() => setTab('guilds')}>{t('profile2.mutualGuilds', { n: p?.mutual_guilds.length ?? 0 })}</button>}
        {uid !== s.me?.id && <button className={`th-tab ${tab === 'friends' ? 'on' : ''}`} onClick={() => setTab('friends')}>{t('profile2.mutualFriends', { n: p?.mutual_friends.length ?? 0 })}</button>}
      </nav>
      <div className="profile-modal-body">
        {!p ? <Skeleton h={60} /> : tab === 'about' ? (
          <>
            {p.bio && <p className="profile-bio">{p.bio}</p>}
            <div className="profile-dates">
              <div><span className="muted small">{t('profile2.memberSince')}</span><div>{date(p.created_at)}</div></div>
              {p.member && <div><span className="muted small">{t('profile2.joinedGuild')}</span><div>{date(p.member.joined_at)}</div></div>}
            </div>
          </>
        ) : tab === 'guilds' ? (
          p.mutual_guilds.length ? p.mutual_guilds.map((g) => (
            <button key={g.id} className="mutual-row" onClick={() => { close(); s.selectGuild(g.id); }}>
              <span className="rail-initials mutual-icon">{g.name.slice(0, 2).toUpperCase()}</span><span>{g.name}</span>{g.nick && <span className="muted small">{g.nick}</span>}
            </button>
          )) : <p className="muted">{t('profile2.noMutual')}</p>
        ) : (
          p.mutual_friends.length ? p.mutual_friends.map((f) => (
            <div key={f.id} className="mutual-row"><Avatar user={f} size={28} status /><span>{f.display_name}</span><span className="muted small">@{f.username}</span></div>
          )) : <p className="muted">{t('profile2.noMutual')}</p>
        )}
      </div>
    </div>
  );
}


// Настройки сервера: обзор, роли (порядок, отображение, права, участники), приглашения;
// права канала (overwrites) и «посмотреть сервер как роль». Все проверки — на сервере; здесь только UI.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, Reorder } from 'motion/react';
import { AlertTriangle, Eye, GripVertical, Plus, Search, Trash2, X } from 'lucide-react';
import { create } from 'zustand';
import { api, uploadFile } from '../lib/api';
import { has, P, withFlag, type PermName } from '../lib/perms';
import { channelPerms, DANGEROUS, PERM_GROUPS } from '../lib/permMeta';
import { appear, spring } from '../design/tokens';
import { Avatar, Button, GuildIcon, IconButton, Input, Switch, TriSwitch, type Tri } from '../ui';
import { AvatarCrop } from './avatarCrop';
import { useModal } from '../ui/overlays';
import { canGuild, isOwner, useStore, type Channel, type GuildDetail, type Member, type Role } from '../store';
import { confirmModal } from './modals';
import { EmojiTab } from './customEmoji';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const SWATCHES = [0x7c5cff, 0x5b8cff, 0x2ec4b6, 0x43b581, 0xf1c40f, 0xff9f1c, 0xe63946, 0xff5c8a, 0xc77dff, 0x99aab5];

/** Высшая позиция ролей пользователя (владелец — выше всех). */
export function myTop(g: GuildDetail, meId: number) {
  if (g.owner_id === meId) return Infinity;
  const me = g.members.find((m) => m.id === meId);
  return Math.max(0, ...g.roles.filter((r) => me?.roles.includes(r.id)).map((r) => r.position));
}
const canGrant = (g: GuildDetail, meId: number, flag: number) => g.owner_id === meId || has(g.permissions, P.ADMINISTRATOR) || has(g.permissions, flag);

// ---------- «посмотреть как роль» ----------
export const useViewAs = create<{ name: string | null }>(() => ({ name: null }));
export async function startViewAs(g: GuildDetail, role: Role) {
  const ids = role.is_default ? '' : String(role.id);
  const r = await api<{ permissions: number; channels: { id: number; permissions: number }[] }>('GET', `/guilds/${g.id}/view-as?roles=${ids}`);
  const map = new Map(r.channels.map((c) => [c.id, c.permissions]));
  useStore.setState((s) => (s.guild?.id !== g.id ? {} : {
    guild: { ...s.guild, permissions: r.permissions, channels: s.guild.channels.map((c) => ({ ...c, permissions: map.get(c.id) ?? 0 })).filter((c) => has(c.permissions, P.VIEW_CHANNEL)) },
  }));
  useViewAs.setState({ name: role.name });
  window.dispatchEvent(new Event('relay:close-modals')); // смотреть на сервер, а не на настройки
  const st = useStore.getState();
  if (!st.guild?.channels.some((c) => c.id === st.channelId)) st.selectChannel(st.guild?.channels.find((c) => c.kind === 'text')?.id ?? null);
}
export function exitViewAs() {
  useViewAs.setState({ name: null });
  const s = useStore.getState();
  if (s.guild) s.selectGuild(s.guild.id, s.channelId);
}
export function ViewAsBanner() {
  const { t } = useTranslation();
  const name = useViewAs((s) => s.name);
  return (
    <AnimatePresence>
      {name && (
        <motion.div className="view-as-banner" initial={{ y: -40 }} animate={{ y: 0 }} exit={{ y: -40 }} transition={spring}>
          <Eye size={16} /> {t('settings.viewingAs', { name })}
          <Button size="sm" onClick={exitViewAs}>{t('settings.exitView')}</Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- редактор роли ----------
type Draft = { name: string; color: number; hoist: boolean; mentionable: boolean; permissions: number };
const draftOf = (r: Role): Draft => ({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions });

function PermissionList({ value, onToggle, disabled, isGrantable }: { value: number; onToggle(flag: number, on: boolean): void; disabled: boolean; isGrantable(flag: number): boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const match = (p: PermName) => !q || `${t(`perm.${p}.name`)} ${t(`perm.${p}.desc`)}`.toLowerCase().includes(q.toLowerCase());
  return (
    <div className="perm-list">
      <label className="search-box"><Search size={16} /><input placeholder={t('settings.searchPerms')} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {PERM_GROUPS.map((grp) => {
        const items = grp.perms.filter(match);
        if (!items.length) return null;
        return (
          <section key={grp.key}>
            <h4 className="perm-group">{t(`permGroup.${grp.key}`)}</h4>
            {items.map((p) => {
              const flag = P[p];
              const grantable = isGrantable(flag);
              return (
                <div key={p} className={`perm-row ${DANGEROUS.has(p) ? 'danger' : ''}`}>
                  <div className="perm-text">
                    <b>{t(`perm.${p}.name`)}{DANGEROUS.has(p) && <span className="danger-tag" title={t('settings.dangerous')}><AlertTriangle size={12} /></span>}</b>
                    <span className="muted small">{t(`perm.${p}.desc`)}</span>
                  </div>
                  <span title={!grantable ? t('settings.noGrant') : undefined}>
                    <Switch label="" checked={has(value, flag)} onChange={(on) => !disabled && grantable && onToggle(flag, on)} />
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function RoleEditor({ g, role, editable }: { g: GuildDetail; role: Role; editable: boolean }) {
  const { t } = useTranslation();
  const modal = useModal();
  const me = useStore((s) => s.me)!;
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<'display' | 'perms' | 'members'>(role.is_default ? 'perms' : 'display');
  const [draft, setDraft] = useState<Draft>(draftOf(role));
  const [saving, setSaving] = useState(false);
  const base = draftOf(role);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // Роль обновилась с сервера (guild_refresh) — подтягиваем, если нет своих правок.
  useEffect(() => { if (!dirty) setDraft(draftOf(role)); }, [role.id, role.name, role.color, role.hoist, role.mentionable, role.permissions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(draftOf(role)); setTab(role.is_default ? 'perms' : 'display'); }, [role.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    const body: Record<string, unknown> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => { if (draft[k] !== base[k]) body[k] = draft[k]; });
    if (role.is_default) delete body.name;
    try { await api('PATCH', `/roles/${role.id}`, body); } catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  };
  const holders = g.members.filter((m) => m.roles.includes(role.id));
  const others = g.members.filter((m) => !m.roles.includes(role.id));
  return (
    <div className="role-editor">
      <header className="role-editor-head">
        <h3><i className="role-dot" style={{ background: draft.color ? hex(draft.color) : 'var(--text-muted)' }} />{role.is_default ? '@everyone' : draft.name}</h3>
        <div className="row">
          <Button size="sm" onClick={() => startViewAs(g, role).catch((e) => toast(e.message, true))}><Eye size={14} />{t('settings.viewAs')}</Button>
          {!role.is_default && editable && (
            <IconButton label={t('settings.deleteRole')} tone="danger" onClick={() => modal.open(confirmModal(t('settings.deleteRoleTitle', { name: role.name }), t('settings.deleteRoleSub'), t('settings.deleteRole'), () => api('DELETE', `/roles/${role.id}`)))}>
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      </header>
      {!editable && <p className="notice">{t('settings.cantEdit')}</p>}
      {role.is_default && <p className="muted small">{t('settings.everyoneHint')}</p>}
      <nav className="tabs" role="tablist">
        {(role.is_default ? (['perms'] as const) : (['display', 'perms', 'members'] as const)).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {tab === k && <motion.span layoutId="role-tab" className="tab-ind" transition={spring} />}
            {t(k === 'display' ? 'settings.display' : k === 'perms' ? 'settings.permissions' : 'settings.members')}{k === 'members' ? ` (${holders.length})` : ''}
          </button>
        ))}
      </nav>
      <div className="role-editor-body">
        {tab === 'display' && (
          <div className="stack">
            <Input label={t('settings.roleName')} value={draft.name} maxLength={64} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <div className="field">
              <span className="field-label">{t('settings.color')}</span>
              <div className="swatches">
                <button className={`swatch none ${draft.color === 0 ? 'on' : ''}`} disabled={!editable} onClick={() => setDraft({ ...draft, color: 0 })} aria-label="без цвета" />
                {SWATCHES.map((c) => <button key={c} className={`swatch ${draft.color === c ? 'on' : ''}`} style={{ background: hex(c) }} disabled={!editable} onClick={() => setDraft({ ...draft, color: c })} aria-label={hex(c)} />)}
                <input type="color" className="swatch-custom" disabled={!editable} value={hex(draft.color || 0x99aab5)} onChange={(e) => setDraft({ ...draft, color: parseInt(e.target.value.slice(1), 16) })} />
              </div>
            </div>
            <Switch label={t('settings.hoist')} checked={draft.hoist} onChange={(v) => editable && setDraft({ ...draft, hoist: v })} />
            <Switch label={t('settings.mentionable')} checked={draft.mentionable} onChange={(v) => editable && setDraft({ ...draft, mentionable: v })} />
          </div>
        )}
        {tab === 'perms' && (
          <PermissionList value={draft.permissions} disabled={!editable} isGrantable={(f) => canGrant(g, me.id, f)}
            onToggle={(flag, on) => setDraft({ ...draft, permissions: withFlag(draft.permissions, flag, on) })} />
        )}
        {tab === 'members' && (
          <div className="stack">
            {editable && others.length > 0 && (
              <select className="input" value="" onChange={(e) => e.target.value && api('PUT', `/guilds/${g.id}/members/${e.target.value}/roles/${role.id}`).catch((er) => toast(er.message, true))}>
                <option value="">{t('settings.addMember')}…</option>
                {others.map((m) => <option key={m.id} value={m.id}>{m.nick || m.display_name}</option>)}
              </select>
            )}
            {holders.length === 0 ? <p className="muted">{t('settings.noMembers')}</p> : holders.map((m) => (
              <div key={m.id} className="member-row">
                <Avatar user={m} size={28} /><span className="grow">{m.nick || m.display_name}</span>
                {editable && <IconButton label={t('settings.remove')} onClick={() => api('DELETE', `/guilds/${g.id}/members/${m.id}/roles/${role.id}`).catch((er) => toast(er.message, true))}><X size={16} /></IconButton>}
              </div>
            ))}
          </div>
        )}
      </div>
      <AnimatePresence>
        {dirty && editable && (
          <motion.div className="save-bar" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }} transition={spring}>
            <span>{t('settings.unsaved')}</span>
            <div className="row">
              <Button variant="ghost" size="sm" onClick={() => setDraft(base)}>{t('settings.reset')}</Button>
              <Button variant="primary" size="sm" disabled={saving} onClick={save}>{t('settings.save')}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RolesTab({ g }: { g: GuildDetail }) {
  const { t } = useTranslation();
  const me = useStore((s) => s.me)!;
  const toast = useStore((s) => s.toast);
  const top = myTop(g, me.id);
  const sorted = useMemo(() => [...g.roles].filter((r) => !r.is_default).sort((a, b) => b.position - a.position), [g.roles]);
  const everyone = g.roles.find((r) => r.is_default)!;
  const [order, setOrder] = useState(sorted.map((r) => r.id));
  const [sel, setSel] = useState<number>(sorted[0]?.id ?? everyone.id);
  useEffect(() => setOrder(sorted.map((r) => r.id)), [sorted]);
  const byId = new Map(g.roles.map((r) => [r.id, r]));
  const role = byId.get(sel) ?? everyone;
  const editable = (r: Role) => g.owner_id === me.id || (has(g.permissions, P.MANAGE_ROLES) && (r.is_default || r.position < top));
  const commitOrder = () => {
    if (order.join() === sorted.map((r) => r.id).join()) return;
    api('PATCH', `/guilds/${g.id}/roles/order`, { ids: [...order].reverse() }).catch((e) => { toast(e.message, true); setOrder(sorted.map((r) => r.id)); });
  };
  const create = async () => {
    try { const r = await api<Role>('POST', `/guilds/${g.id}/roles`, { name: t('settings.newRole') }); setSel(r.id); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="roles-tab">
      <aside className="roles-list">
        <Button size="sm" variant="primary" onClick={create} disabled={!has(g.permissions, P.MANAGE_ROLES)}><Plus size={14} />{t('settings.createRole')}</Button>
        <p className="muted small">{t('settings.dragHint')}</p>
        <Reorder.Group axis="y" values={order} onReorder={setOrder} className="role-items">
          {order.map((id) => {
            const r = byId.get(id);
            if (!r) return null;
            const canDrag = editable(r);
            return (
              <Reorder.Item key={id} value={id} dragListener={canDrag} onDragEnd={commitOrder} className={`role-item ${sel === id ? 'on' : ''} ${canDrag ? '' : 'locked'}`} transition={spring}
                whileDrag={{ scale: 1.02, boxShadow: 'var(--shadow-2)' }}>
                <span className="grip"><GripVertical size={14} /></span>
                <button className="role-item-btn" onClick={() => setSel(id)}><i className="role-dot" style={{ background: r.color ? hex(r.color) : 'var(--text-muted)' }} />{r.name}</button>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        <button className={`role-item everyone ${sel === everyone.id ? 'on' : ''}`} onClick={() => setSel(everyone.id)}>@everyone</button>
      </aside>
      <RoleEditor key={role.id} g={g} role={role} editable={editable(role)} />
    </div>
  );
}

interface Invite { code: string; uses: number; max_uses: number; expires_at: number | null; created_at: number; creator: { display_name: string } }
function InvitesTab({ g }: { g: GuildDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Invite[] | null>(null);
  const load = () => api<Invite[]>('GET', `/guilds/${g.id}/invites`).then(setList, (e) => toast(e.message, true));
  useEffect(() => { load(); }, [g.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <p className="muted">…</p>;
  if (!list.length) return <p className="muted">{t('settings.invitesEmpty')}</p>;
  return (
    <table className="invites">
      <thead><tr><th>Код</th><th>{t('settings.creator')}</th><th>{t('settings.uses')}</th><th>{t('settings.expires')}</th><th /></tr></thead>
      <tbody>
        <AnimatePresence initial={false}>
          {list.map((inv) => (
            <motion.tr key={inv.code} layout exit={{ opacity: 0 }} transition={appear}>
              <td className="mono">{inv.code}</td><td>{inv.creator.display_name}</td>
              <td>{inv.uses}{inv.max_uses ? ` / ${inv.max_uses}` : ''}</td>
              <td>{inv.expires_at ? new Date(inv.expires_at).toLocaleString(i18n.language) : t('settings.never')}</td>
              <td><Button size="sm" variant="danger" onClick={() => api('DELETE', `/invites/${inv.code}`).then(load, (e) => toast(e.message, true))}>{t('settings.revoke')}</Button></td>
            </motion.tr>
          ))}
        </AnimatePresence>
      </tbody>
    </table>
  );
}

const ICON_TYPES = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/;
/** Иконка сервера: выбрать файл → кадр 1:1 (тот же редактор, что у аватара) → загрузить; убрать — будут инициалы.
 *  Обработка — на сервере в фоне; готово — guild_update у всех участников. */
function GuildIconEditor({ g }: { g: GuildDetail }) {
  const { t } = useTranslation();
  const modal = useModal();
  const toast = useStore((s) => s.toast);
  const live = useStore((s) => s.guilds.find((x) => x.id === g.id)) ?? g;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = (f?: File | null) => {
    if (input.current) input.current.value = '';
    if (!f) return;
    if (!ICON_TYPES.test(f.type) && !/\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(f.name)) { toast(t('gicon.formats'), true); return; }
    modal.open((close) => <AvatarCrop file={f} close={close} onDone={async (r) => {
      setBusy(true);
      try {
        const url = (await uploadFile(r.source, () => {}).promise).url;
        await api('PUT', `/guilds/${g.id}/icon`, { url, crop: r.crop });
      } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
    }} />);
  };
  const remove = () => api('DELETE', `/guilds/${g.id}/icon`).catch((e) => toast((e as Error).message, true));
  return (
    <div className="guild-icon-editor">
      <GuildIcon guild={live} size={80} play />
      <div className="stack">
        <div className="row">
          <Button disabled={busy || live.icon_pending} onClick={() => input.current?.click()}>{live.icon ? t('gicon.change') : t('gicon.upload')}</Button>
          {live.icon && <Button variant="ghost" disabled={busy || live.icon_pending} onClick={remove}>{t('gicon.remove')}</Button>}
        </div>
        <p className="muted small">{busy || live.icon_pending ? t('gicon.processing') : t('gicon.hint')}</p>
      </div>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}

function OverviewTab({ g, close }: { g: GuildDetail; close(): void }) {
  const { t } = useTranslation();
  const modal = useModal();
  const owner = useStore(isOwner);
  const [name, setName] = useState(g.name);
  const toast = useStore((s) => s.toast);
  return (
    <div className="stack">
      <GuildIconEditor g={g} />
      <Input label={t('settings.overview_name')} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
      <div className="row"><Button variant="primary" disabled={name.trim() === g.name || !name.trim()} onClick={() => api('PATCH', `/guilds/${g.id}`, { name }).catch((e) => toast(e.message, true))}>{t('settings.save')}</Button></div>
      {owner && (
        <>
          <div className="divider" />
          <Button variant="danger" onClick={() => { close(); modal.open(confirmModal(t('modal.deleteGuild', { name: g.name }), t('modal.irreversible'), t('settings.overview_delete'), () => api('DELETE', `/guilds/${g.id}`))); }}>
            {t('settings.overview_delete')}
          </Button>
        </>
      )}
    </div>
  );
}

type SettingsTab = 'overview' | 'roles' | 'invites' | 'emoji';
export function ServerSettingsModal({ close, tab: initial }: { close(): void; tab?: SettingsTab }) {
  const { t } = useTranslation();
  const g = useStore((s) => s.guild);
  const s = useStore();
  const tabs = ([
    canGuild(s, P.MANAGE_GUILD) && 'overview', canGuild(s, P.MANAGE_ROLES) && 'roles', canGuild(s, P.MANAGE_EMOJIS) && 'emoji', canGuild(s, P.MANAGE_GUILD) && 'invites',
  ].filter(Boolean) as SettingsTab[]);
  const [tab, setTab] = useState(initial && tabs.includes(initial) ? initial : tabs[0]);
  if (!g || !tab) return null;
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">{g.name}</div>
        {tabs.map((k) => (
          <button key={k} className={`settings-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {tab === k && <motion.span layoutId="settings-tab" className="settings-tab-bg" transition={spring} />}
            <span>{t(`settings.${k}`)}</span>
          </button>
        ))}
      </nav>
      <section className="settings-body">
        <header className="settings-head"><h2>{t(`settings.${tab}`)}</h2><IconButton label={t('settings.close')} onClick={close}><X size={20} /></IconButton></header>
        <AnimatePresence mode="wait">
          <motion.div key={tab} className="settings-content" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            {tab === 'overview' && <OverviewTab g={g} close={close} />}
            {tab === 'roles' && <RolesTab g={g} />}
            {tab === 'invites' && <InvitesTab g={g} />}
            {tab === 'emoji' && <EmojiTab g={g} />}
          </motion.div>
        </AnimatePresence>
      </section>
    </div>
  );
}

// ---------- права канала ----------
interface Ow { kind: 'role' | 'member'; id: number; allow: number; deny: number }
export function ChannelPermissionsModal({ channel, close }: { channel: Channel; close(): void }) {
  const { t } = useTranslation();
  const g = useStore((s) => s.guild)!;
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Ow[] | null>(null);
  const everyone = g.roles.find((r) => r.is_default)!;
  const [sel, setSel] = useState<{ kind: 'role' | 'member'; id: number }>({ kind: 'role', id: everyone.id });
  const [draft, setDraft] = useState<{ allow: number; deny: number }>({ allow: 0, deny: 0 });
  const load = () => api<Ow[]>('GET', `/channels/${channel.id}/permissions`).then(setList, (e) => toast(e.message, true));
  useEffect(() => { load(); }, [channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = list?.find((o) => o.kind === sel.kind && o.id === sel.id) ?? { allow: 0, deny: 0 };
  useEffect(() => { setDraft({ allow: current.allow, deny: current.deny }); }, [sel.kind, sel.id, list]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <div className="modal-body"><p className="muted">…</p></div>;
  const targets = [
    { kind: 'role' as const, id: everyone.id },
    ...list.filter((o) => !(o.kind === 'role' && o.id === everyone.id)).map((o) => ({ kind: o.kind, id: o.id })),
  ];
  if (!targets.some((x) => x.kind === sel.kind && x.id === sel.id)) targets.push(sel);
  const label = (x: { kind: 'role' | 'member'; id: number }) => {
    if (x.kind === 'role') { const r = g.roles.find((r) => r.id === x.id); return r?.is_default ? '@everyone' : r?.name ?? '?'; }
    const m = g.members.find((m) => m.id === x.id); return m?.nick || m?.display_name || '?';
  };
  const triOf = (flag: number): Tri => (has(draft.allow, flag) ? 'allow' : has(draft.deny, flag) ? 'deny' : 'inherit');
  const setTri = (flag: number, v: Tri) => setDraft({
    allow: withFlag(draft.allow, flag, v === 'allow'),
    deny: withFlag(draft.deny, flag, v === 'deny'),
  });
  const dirty = draft.allow !== current.allow || draft.deny !== current.deny;
  const save = () => api('PUT', `/channels/${channel.id}/permissions/${sel.kind}/${sel.id}`, draft).then(load, (e) => toast(e.message, true));
  const remove = () => api('DELETE', `/channels/${channel.id}/permissions/${sel.kind}/${sel.id}`).then(() => { setSel({ kind: 'role', id: everyone.id }); load(); }, (e) => toast(e.message, true));
  const addable = [
    ...g.roles.filter((r) => !r.is_default && !targets.some((x) => x.kind === 'role' && x.id === r.id)).map((r) => ({ kind: 'role' as const, id: r.id, name: r.name })),
    ...g.members.filter((m) => !targets.some((x) => x.kind === 'member' && x.id === m.id)).map((m) => ({ kind: 'member' as const, id: m.id, name: '@' + (m.nick || m.display_name) })),
  ];
  const labels = { allow: t('settings.allow'), inherit: t('settings.inherit'), deny: t('settings.deny') };
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">{t('settings.rolesAndMembers')}</div>
        {targets.map((x) => (
          <button key={`${x.kind}${x.id}`} className={`settings-tab ${sel.kind === x.kind && sel.id === x.id ? 'on' : ''}`} onClick={() => setSel(x)}>
            {sel.kind === x.kind && sel.id === x.id && <motion.span layoutId="ow-tab" className="settings-tab-bg" transition={spring} />}
            <span>{label(x)}</span>
          </button>
        ))}
        {addable.length > 0 && (
          <select className="input" value="" onChange={(e) => { const [k, id] = e.target.value.split(':'); if (k) setSel({ kind: k as 'role' | 'member', id: +id }); }}>
            <option value="">{t('settings.addTarget')}…</option>
            {addable.map((a) => <option key={`${a.kind}:${a.id}`} value={`${a.kind}:${a.id}`}>{a.name}</option>)}
          </select>
        )}
      </nav>
      <section className="settings-body">
        <header className="settings-head">
          <h2>{t('settings.channelPerms', { name: channel.name })} — {label(sel)}</h2>
          <IconButton label={t('settings.close')} onClick={close}><X size={20} /></IconButton>
        </header>
        <div className="settings-content">
          {channelPerms(channel.kind).map((p) => (
            <div key={p} className={`perm-row ${DANGEROUS.has(p) ? 'danger' : ''}`}>
              <div className="perm-text"><b>{t(`perm.${p}.name`)}</b><span className="muted small">{t(`perm.${p}.desc`)}</span></div>
              <TriSwitch value={triOf(P[p])} onChange={(v) => setTri(P[p], v)} labels={labels} />
            </div>
          ))}
          {list.some((o) => o.kind === sel.kind && o.id === sel.id) && (
            <Button variant="ghost" onClick={remove}><Trash2 size={14} />{t('settings.removeTarget')}</Button>
          )}
        </div>
        <AnimatePresence>
          {dirty && (
            <motion.div className="save-bar" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }} transition={spring}>
              <span>{t('settings.unsaved')}</span>
              <div className="row">
                <Button variant="ghost" size="sm" onClick={() => setDraft({ allow: current.allow, deny: current.deny })}>{t('settings.reset')}</Button>
                <Button variant="primary" size="sm" onClick={save}>{t('settings.save')}</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

// ---------- роли участника ----------
export function MemberRolesModal({ member, close }: { member: Member; close(): void }) {
  const { t } = useTranslation();
  const g = useStore((s) => s.guild)!;
  const me = useStore((s) => s.me)!;
  const toast = useStore((s) => s.toast);
  const live = g.members.find((m) => m.id === member.id) ?? member;
  const top = myTop(g, me.id);
  const roles = [...g.roles].filter((r) => !r.is_default).sort((a, b) => b.position - a.position);
  return (
    <div className="modal-body">
      <h2>{t('settings.memberRoles', { name: live.nick || live.display_name })}</h2>
      {roles.map((r) => {
        const on = live.roles.includes(r.id);
        const allowed = g.owner_id === me.id || r.position < top;
        return (
          <Switch key={r.id} label={r.name} checked={on} onChange={(v) => allowed && api(v ? 'PUT' : 'DELETE', `/guilds/${g.id}/members/${live.id}/roles/${r.id}`).catch((e) => toast(e.message, true))} />
        );
      })}
      <div className="modal-actions"><Button onClick={close}>{t('modal.done')}</Button></div>
    </div>
  );
}

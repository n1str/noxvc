//! Права: битмаска u64 и ЕДИНСТВЕННАЯ функция их вычисления (ADR-009).
//!
//! Порядок, как в Discord:
//! 1. База: права @everyone | права всех ролей участника. Владелец — все права.
//! 2. ADMINISTRATOR в базе — все права, overwrites не применяются.
//! 3. Overwrite @everyone канала: сначала deny, потом allow.
//! 4. Overwrites ролей участника: объединённые deny, потом объединённые allow.
//! 5. Overwrite самого участника: deny, потом allow.
//! 6. Неявные правила: без VIEW_CHANNEL прав в канале нет; без SEND_MESSAGES нет
//!    прав, которые без отправки бессмысленны; без CONNECT нет голосовых прав.
#![allow(dead_code)]

pub type Perms = u64;

pub const CREATE_INVITE: Perms = 1 << 0;
pub const KICK_MEMBERS: Perms = 1 << 1;
pub const BAN_MEMBERS: Perms = 1 << 2;
pub const ADMINISTRATOR: Perms = 1 << 3;
pub const MANAGE_CHANNELS: Perms = 1 << 4;
pub const MANAGE_GUILD: Perms = 1 << 5;
pub const ADD_REACTIONS: Perms = 1 << 6;
pub const VIEW_AUDIT_LOG: Perms = 1 << 7;
pub const PRIORITY_SPEAKER: Perms = 1 << 8;
pub const STREAM: Perms = 1 << 9;
pub const VIEW_CHANNEL: Perms = 1 << 10;
pub const SEND_MESSAGES: Perms = 1 << 11;
pub const MANAGE_MESSAGES: Perms = 1 << 13;
pub const EMBED_LINKS: Perms = 1 << 14;
pub const ATTACH_FILES: Perms = 1 << 15;
pub const READ_MESSAGE_HISTORY: Perms = 1 << 16;
pub const MENTION_EVERYONE: Perms = 1 << 17;
pub const USE_EXTERNAL_EMOJI: Perms = 1 << 18;
pub const CONNECT: Perms = 1 << 20;
pub const SPEAK: Perms = 1 << 21;
pub const MUTE_MEMBERS: Perms = 1 << 22;
pub const DEAFEN_MEMBERS: Perms = 1 << 23;
pub const MOVE_MEMBERS: Perms = 1 << 24;
pub const USE_VAD: Perms = 1 << 25;
pub const CHANGE_NICKNAME: Perms = 1 << 26;
pub const MANAGE_NICKNAMES: Perms = 1 << 27;
pub const MANAGE_ROLES: Perms = 1 << 28;
pub const MANAGE_WEBHOOKS: Perms = 1 << 29;
pub const MANAGE_EMOJIS: Perms = 1 << 30;
pub const MANAGE_THREADS: Perms = 1 << 34;
pub const CREATE_THREADS: Perms = 1 << 35;
pub const SEND_MESSAGES_IN_THREADS: Perms = 1 << 38;
pub const MODERATE_MEMBERS: Perms = 1 << 40;
pub const PIN_MESSAGES: Perms = 1 << 51;

pub const ALL: Perms = CREATE_INVITE
    | KICK_MEMBERS
    | BAN_MEMBERS
    | ADMINISTRATOR
    | MANAGE_CHANNELS
    | MANAGE_GUILD
    | ADD_REACTIONS
    | VIEW_AUDIT_LOG
    | PRIORITY_SPEAKER
    | STREAM
    | VIEW_CHANNEL
    | SEND_MESSAGES
    | MANAGE_MESSAGES
    | EMBED_LINKS
    | ATTACH_FILES
    | READ_MESSAGE_HISTORY
    | MENTION_EVERYONE
    | USE_EXTERNAL_EMOJI
    | CONNECT
    | SPEAK
    | MUTE_MEMBERS
    | DEAFEN_MEMBERS
    | MOVE_MEMBERS
    | USE_VAD
    | CHANGE_NICKNAME
    | MANAGE_NICKNAMES
    | MANAGE_ROLES
    | MANAGE_WEBHOOKS
    | MANAGE_EMOJIS
    | MANAGE_THREADS
    | CREATE_THREADS
    | SEND_MESSAGES_IN_THREADS
    | MODERATE_MEMBERS
    | PIN_MESSAGES;

/// Права @everyone у нового сервера: обычный участник может читать, писать, говорить.
pub const DEFAULT_EVERYONE: Perms = CREATE_INVITE
    | ADD_REACTIONS
    | STREAM
    | VIEW_CHANNEL
    | SEND_MESSAGES
    | EMBED_LINKS
    | ATTACH_FILES
    | READ_MESSAGE_HISTORY
    | USE_EXTERNAL_EMOJI
    | CONNECT
    | SPEAK
    | USE_VAD
    | CHANGE_NICKNAME
    | CREATE_THREADS
    | SEND_MESSAGES_IN_THREADS;

/// Права, которые имеют смысл только на уровне сервера (в overwrites канала игнорируются).
const GUILD_ONLY: Perms =
    KICK_MEMBERS | BAN_MEMBERS | ADMINISTRATOR | MANAGE_GUILD | VIEW_AUDIT_LOG | CHANGE_NICKNAME | MANAGE_NICKNAMES | MANAGE_EMOJIS | MODERATE_MEMBERS;
const TEXT_NEEDS_SEND: Perms = ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE;
const VOICE: Perms = SPEAK | STREAM | MUTE_MEMBERS | DEAFEN_MEMBERS | MOVE_MEMBERS | USE_VAD | PRIORITY_SPEAKER;

pub fn has(p: Perms, flag: Perms) -> bool {
    p & flag == flag
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Role(i64),
    Member(i64),
}

#[derive(Clone, Copy, Debug)]
pub struct Overwrite {
    pub target: Target,
    pub allow: Perms,
    pub deny: Perms,
}

/// Роль с позицией (для иерархии) и правами.
#[derive(Clone, Copy, Debug)]
pub struct Role {
    pub id: i64,
    pub position: i64,
    pub permissions: Perms,
}

/// Всё, что нужно знать об участнике для вычисления прав.
pub struct Member<'a> {
    pub user_id: i64,
    pub is_owner: bool,
    /// Роль @everyone сервера.
    pub everyone: Role,
    /// Остальные роли участника (без @everyone).
    pub roles: &'a [Role],
}

/// Права на уровне сервера.
pub fn base(m: &Member) -> Perms {
    if m.is_owner {
        return ALL;
    }
    let p = m.roles.iter().fold(m.everyone.permissions, |acc, r| acc | r.permissions);
    if has(p, ADMINISTRATOR) {
        ALL
    } else {
        p
    }
}

/// Права в канале. `kind` — тип канала: голосовые неявные правила применяются только к voice.
pub fn channel(m: &Member, overwrites: &[Overwrite], kind: &str) -> Perms {
    let base = base(m);
    if has(base, ADMINISTRATOR) {
        return ALL;
    }
    let mut p = base;
    let find = |t: Target| overwrites.iter().find(|o| o.target == t);
    if let Some(o) = find(Target::Role(m.everyone.id)) {
        p = (p & !(o.deny & !GUILD_ONLY)) | (o.allow & !GUILD_ONLY);
    }
    let (mut allow, mut deny) = (0, 0);
    for r in m.roles {
        if let Some(o) = find(Target::Role(r.id)) {
            allow |= o.allow;
            deny |= o.deny;
        }
    }
    p = (p & !(deny & !GUILD_ONLY)) | (allow & !GUILD_ONLY);
    if let Some(o) = find(Target::Member(m.user_id)) {
        p = (p & !(o.deny & !GUILD_ONLY)) | (o.allow & !GUILD_ONLY);
    }
    if !has(p, VIEW_CHANNEL) {
        return 0;
    }
    // В ветке (overwrites — родителя) писать позволяет SEND_MESSAGES_IN_THREADS, а не SEND_MESSAGES.
    if kind == "thread" {
        p = if has(p, SEND_MESSAGES_IN_THREADS) { p | SEND_MESSAGES } else { p & !SEND_MESSAGES };
    }
    let voice = kind == "voice" || kind == "stage";
    if !voice && !has(p, SEND_MESSAGES) {
        p &= !TEXT_NEEDS_SEND;
    }
    if voice && !has(p, CONNECT) {
        p &= !VOICE;
    }
    p
}

/// Высшая позиция ролей участника (владелец — выше всех).
pub fn top_position(m: &Member) -> i64 {
    if m.is_owner {
        return i64::MAX;
    }
    m.roles.iter().map(|r| r.position).max().unwrap_or(0)
}

/// Может ли `actor` управлять ролью на позиции `role_position` (назначать, менять, удалять).
/// Нужно MANAGE_ROLES и роль строго ниже своей высшей.
pub fn can_manage_role(actor: &Member, role_position: i64) -> bool {
    actor.is_owner || (has(base(actor), MANAGE_ROLES) && role_position < top_position(actor))
}

/// Может ли `actor` применять модерацию (кик, бан, роли, ник) к `target`.
/// Владельца трогать нельзя; остальных — только если высшая роль actor строго выше.
pub fn can_act_on(actor: &Member, target: &Member) -> bool {
    if target.is_owner || actor.user_id == target.user_id {
        return false;
    }
    actor.is_owner || top_position(actor) > top_position(target)
}

/// Права, которые роль может выдать: нельзя дать то, чего нет у самого actor.
pub fn grantable(actor: &Member) -> Perms {
    base(actor)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERYONE: i64 = 100;
    fn ev(p: Perms) -> Role {
        Role { id: EVERYONE, position: 0, permissions: p }
    }
    fn role(id: i64, pos: i64, p: Perms) -> Role {
        Role { id, position: pos, permissions: p }
    }
    fn member<'a>(uid: i64, owner: bool, everyone: Perms, roles: &'a [Role]) -> Member<'a> {
        Member { user_id: uid, is_owner: owner, everyone: ev(everyone), roles }
    }
    fn ow(t: Target, allow: Perms, deny: Perms) -> Overwrite {
        Overwrite { target: t, allow, deny }
    }

    #[test]
    fn base_is_union_of_everyone_and_roles() {
        let roles = [role(1, 1, KICK_MEMBERS), role(2, 2, MANAGE_MESSAGES)];
        let m = member(5, false, VIEW_CHANNEL, &roles);
        assert_eq!(base(&m), VIEW_CHANNEL | KICK_MEMBERS | MANAGE_MESSAGES);
    }

    #[test]
    fn owner_and_admin_get_everything() {
        assert_eq!(base(&member(5, true, 0, &[])), ALL);
        let roles = [role(1, 1, ADMINISTRATOR)];
        let m = member(5, false, 0, &roles);
        assert_eq!(base(&m), ALL);
        // ADMINISTRATOR обходит любые overwrites, даже deny на самого участника.
        let ows = [ow(Target::Member(5), 0, ALL), ow(Target::Role(EVERYONE), 0, VIEW_CHANNEL)];
        assert_eq!(channel(&m, &ows, "text"), ALL);
        assert_eq!(channel(&member(5, true, 0, &[]), &ows, "text"), ALL);
    }

    #[test]
    fn overwrite_order_everyone_roles_member() {
        let roles = [role(1, 1, 0), role(2, 2, 0)];
        let m = member(5, false, DEFAULT_EVERYONE, &roles);
        // @everyone запрещает писать → нельзя.
        let ows = [ow(Target::Role(EVERYONE), 0, SEND_MESSAGES)];
        assert!(!has(channel(&m, &ows, "text"), SEND_MESSAGES));
        // Роль разрешает → можно (роли сильнее @everyone).
        let ows = [ow(Target::Role(EVERYONE), 0, SEND_MESSAGES), ow(Target::Role(1), SEND_MESSAGES, 0)];
        assert!(has(channel(&m, &ows, "text"), SEND_MESSAGES));
        // Одна роль разрешает, другая запрещает → allow ролей побеждает deny ролей (объединение, allow после deny).
        let ows = [ow(Target::Role(1), SEND_MESSAGES, 0), ow(Target::Role(2), 0, SEND_MESSAGES)];
        assert!(has(channel(&m, &ows, "text"), SEND_MESSAGES));
        // Участник запрещён лично → нельзя, даже если роль разрешает.
        let ows = [ow(Target::Role(1), SEND_MESSAGES, 0), ow(Target::Member(5), 0, SEND_MESSAGES)];
        assert!(!has(channel(&m, &ows, "text"), SEND_MESSAGES));
        // Личный allow перекрывает deny @everyone и ролей.
        let ows = [ow(Target::Role(EVERYONE), 0, SEND_MESSAGES), ow(Target::Role(2), 0, SEND_MESSAGES), ow(Target::Member(5), SEND_MESSAGES, 0)];
        assert!(has(channel(&m, &ows, "text"), SEND_MESSAGES));
    }

    #[test]
    fn threads_use_send_in_threads() {
        let m = member(5, false, DEFAULT_EVERYONE, &[]);
        // В ветке писать позволяет SEND_MESSAGES_IN_THREADS, даже если в канале писать нельзя.
        let ows = [ow(Target::Role(EVERYONE), 0, SEND_MESSAGES)];
        assert!(has(channel(&m, &ows, "thread"), SEND_MESSAGES));
        assert!(!has(channel(&m, &ows, "text"), SEND_MESSAGES));
        // И наоборот: без SEND_MESSAGES_IN_THREADS в ветке нельзя (и вложения тоже).
        let ows = [ow(Target::Role(EVERYONE), 0, SEND_MESSAGES_IN_THREADS)];
        let p = channel(&m, &ows, "thread");
        assert!(!has(p, SEND_MESSAGES) && !has(p, ATTACH_FILES) && has(p, VIEW_CHANNEL));
    }

    #[test]
    fn overwrites_of_other_roles_and_members_do_not_apply() {
        let roles = [role(1, 1, 0)];
        let m = member(5, false, DEFAULT_EVERYONE, &roles);
        let ows = [ow(Target::Role(9), 0, VIEW_CHANNEL), ow(Target::Member(6), 0, VIEW_CHANNEL)];
        assert_eq!(channel(&m, &ows, "text"), channel(&m, &[], "text"));
    }

    #[test]
    fn no_view_means_nothing() {
        let m = member(5, false, DEFAULT_EVERYONE | MANAGE_MESSAGES, &[]);
        let ows = [ow(Target::Role(EVERYONE), 0, VIEW_CHANNEL)];
        assert_eq!(channel(&m, &ows, "text"), 0);
        // Приватный канал: @everyone не видит, роль видит.
        let roles = [role(1, 1, 0)];
        let m = member(5, false, DEFAULT_EVERYONE, &roles);
        let ows = [ow(Target::Role(EVERYONE), 0, VIEW_CHANNEL), ow(Target::Role(1), VIEW_CHANNEL, 0)];
        assert!(has(channel(&m, &ows, "text"), VIEW_CHANNEL | SEND_MESSAGES));
    }

    #[test]
    fn implicit_text_and_voice_rules() {
        let m = member(5, false, DEFAULT_EVERYONE | MENTION_EVERYONE, &[]);
        let ows = [ow(Target::Role(EVERYONE), 0, SEND_MESSAGES)];
        let p = channel(&m, &ows, "text");
        assert!(!has(p, ATTACH_FILES) && !has(p, EMBED_LINKS) && !has(p, MENTION_EVERYONE));
        assert!(has(p, READ_MESSAGE_HISTORY) && has(p, ADD_REACTIONS));
        let ows = [ow(Target::Role(EVERYONE), 0, CONNECT)];
        let p = channel(&m, &ows, "voice");
        assert!(!has(p, SPEAK) && !has(p, STREAM));
        assert!(has(p, VIEW_CHANNEL));
        // Голосовое правило не трогает текстовые каналы.
        assert!(has(channel(&m, &ows, "text"), STREAM));
    }

    #[test]
    fn guild_only_permissions_ignore_overwrites() {
        let m = member(5, false, DEFAULT_EVERYONE, &[]);
        let ows = [ow(Target::Member(5), ADMINISTRATOR | KICK_MEMBERS | MANAGE_GUILD, 0)];
        let p = channel(&m, &ows, "text");
        assert!(!has(p, ADMINISTRATOR) && !has(p, KICK_MEMBERS) && !has(p, MANAGE_GUILD));
        let m = member(5, false, DEFAULT_EVERYONE | KICK_MEMBERS, &[]);
        let ows = [ow(Target::Member(5), 0, KICK_MEMBERS)];
        assert!(has(channel(&m, &ows, "text"), KICK_MEMBERS), "deny серверного права в канале не действует");
    }

    #[test]
    fn hierarchy() {
        let mod_roles = [role(1, 5, MANAGE_ROLES | KICK_MEMBERS)];
        let low_roles = [role(2, 3, 0)];
        let peer_roles = [role(3, 5, 0)];
        let moderator = member(10, false, DEFAULT_EVERYONE, &mod_roles);
        let low = member(11, false, DEFAULT_EVERYONE, &low_roles);
        let peer = member(12, false, DEFAULT_EVERYONE, &peer_roles);
        let owner = member(1, true, DEFAULT_EVERYONE, &[]);
        assert!(can_act_on(&moderator, &low));
        assert!(!can_act_on(&moderator, &peer), "равную роль трогать нельзя");
        assert!(!can_act_on(&low, &moderator));
        assert!(!can_act_on(&moderator, &owner), "владельца — никогда");
        assert!(!can_act_on(&moderator, &moderator), "себя — нельзя");
        assert!(can_act_on(&owner, &moderator));
        assert!(can_manage_role(&moderator, 4));
        assert!(!can_manage_role(&moderator, 5), "свою и выше — нельзя");
        assert!(!can_manage_role(&low, 1), "без MANAGE_ROLES — нельзя");
        assert!(can_manage_role(&owner, 1000));
    }

    #[test]
    fn default_everyone_matches_migration() {
        // migrations/0002_roles.sql вставляет это число для существующих серверов.
        assert_eq!(DEFAULT_EVERYONE, 309_341_834_817);
    }

    #[test]
    fn default_everyone_is_safe() {
        for p in [ADMINISTRATOR, MANAGE_GUILD, MANAGE_ROLES, MANAGE_CHANNELS, KICK_MEMBERS, BAN_MEMBERS, MANAGE_MESSAGES, MENTION_EVERYONE] {
            assert!(!has(DEFAULT_EVERYONE, p));
        }
        assert_eq!(DEFAULT_EVERYONE & !ALL, 0);
    }
}

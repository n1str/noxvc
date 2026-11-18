//! Доступ к PostgreSQL (sqlx). JSON для клиента собирается в SQL одним запросом — без N+1.
use crate::perms::{self, Overwrite, Perms, Role, Target};
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::HashMap;

pub type Db = PgPool;
pub type Result<T> = std::result::Result<T, sqlx::Error>;

pub async fn connect(url: &str) -> Db {
    let pool = PgPoolOptions::new().max_connections(16).connect(url).await.expect("не удалось подключиться к PostgreSQL");
    sqlx::migrate!("./migrations").run(&pool).await.expect("не удалось применить миграции");
    pool
}

pub struct Channel {
    pub id: i64,
    pub guild_id: Option<i64>,
    pub kind: String,
    /// Для ветки — родительский канал (источник прав); для прочих — категория.
    pub parent_id: Option<i64>,
    /// Права запросившего пользователя в этом канале (заполняет accessible_channel).
    pub perms: Perms,
}

/// Права собеседника в личных сообщениях.
pub const DM_PERMS: Perms = perms::VIEW_CHANNEL
    | perms::SEND_MESSAGES
    | perms::READ_MESSAGE_HISTORY
    | perms::ADD_REACTIONS
    | perms::ATTACH_FILES
    | perms::EMBED_LINKS
    | perms::PIN_MESSAGES;

pub async fn channel(db: &Db, id: i64) -> Result<Option<Channel>> {
    let row = sqlx::query("SELECT id, guild_id, kind, parent_id FROM channels WHERE id=$1").bind(id).fetch_optional(db).await?;
    Ok(row.map(|r| Channel { id: r.get(0), guild_id: r.get(1), kind: r.get(2), parent_id: r.get(3), perms: 0 }))
}

impl Channel {
    /// Чьи overwrites определяют права: у ветки — родителя.
    pub fn perm_source(&self) -> i64 {
        if self.kind == "thread" {
            self.parent_id.unwrap_or(self.id)
        } else {
            self.id
        }
    }
}

// ---------- права ----------
/// Контекст участника сервера для вычисления прав (perms::Member).
pub struct GuildCtx {
    pub user: i64,
    pub owner_id: i64,
    pub everyone: Role,
    pub roles: Vec<Role>,
}

impl GuildCtx {
    pub fn member(&self) -> perms::Member<'_> {
        perms::Member { user_id: self.user, is_owner: self.user == self.owner_id, everyone: self.everyone, roles: &self.roles }
    }
    pub fn base(&self) -> Perms {
        perms::base(&self.member())
    }
    pub fn can(&self, flag: Perms) -> bool {
        perms::has(self.base(), flag)
    }
    pub fn is_owner(&self) -> bool {
        self.user == self.owner_id
    }
}

fn role_from(r: &sqlx::postgres::PgRow) -> Role {
    Role { id: r.get("id"), position: r.get("position"), permissions: r.get::<i64, _>("permissions") as Perms }
}

/// None — пользователь не участник сервера (или сервера нет).
pub async fn guild_ctx(db: &Db, guild: i64, user: i64) -> Result<Option<GuildCtx>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT g.owner_id FROM guilds g JOIN members m ON m.guild_id=g.id AND m.user_id=$2 WHERE g.id=$1")
        .bind(guild)
        .bind(user)
        .fetch_optional(db)
        .await?;
    let Some(owner_id) = owner else { return Ok(None) };
    let rows = sqlx::query(
        "SELECT id, position, permissions, is_default FROM roles WHERE guild_id=$1
           AND (is_default OR id IN (SELECT role_id FROM member_roles WHERE guild_id=$1 AND user_id=$2))",
    )
    .bind(guild)
    .bind(user)
    .fetch_all(db)
    .await?;
    let mut everyone = Role { id: 0, position: 0, permissions: 0 };
    let mut roles = vec![];
    for r in &rows {
        if r.get::<bool, _>("is_default") {
            everyone = role_from(r)
        } else {
            roles.push(role_from(r))
        }
    }
    Ok(Some(GuildCtx { user, owner_id, everyone, roles }))
}

fn overwrite_from(r: &sqlx::postgres::PgRow) -> Overwrite {
    let id: i64 = r.get("target_id");
    Overwrite {
        target: if r.get::<i16, _>("target_kind") == 0 { Target::Role(id) } else { Target::Member(id) },
        allow: r.get::<i64, _>("allow") as Perms,
        deny: r.get::<i64, _>("deny") as Perms,
    }
}

pub async fn overwrites(db: &Db, channel: i64) -> Result<Vec<Overwrite>> {
    let rows = sqlx::query("SELECT target_kind, target_id, allow, deny FROM permission_overwrites WHERE channel_id=$1").bind(channel).fetch_all(db).await?;
    Ok(rows.iter().map(overwrite_from).collect())
}

/// Все overwrites каналов сервера: channel_id -> список.
pub async fn guild_overwrites(db: &Db, guild: i64) -> Result<HashMap<i64, Vec<Overwrite>>> {
    let rows = sqlx::query(
        "SELECT po.channel_id, po.target_kind, po.target_id, po.allow, po.deny FROM permission_overwrites po
         JOIN channels c ON c.id=po.channel_id WHERE c.guild_id=$1",
    )
    .bind(guild)
    .fetch_all(db)
    .await?;
    let mut map: HashMap<i64, Vec<Overwrite>> = HashMap::new();
    for r in &rows {
        map.entry(r.get("channel_id")).or_default().push(overwrite_from(r));
    }
    Ok(map)
}

pub async fn guild_owner(db: &Db, guild: i64) -> Result<Option<i64>> {
    sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id=$1").bind(guild).fetch_optional(db).await
}

/// Канал, если пользователь его видит (VIEW_CHANNEL с учётом overwrites); в `perms` — его права там.
pub async fn accessible_channel(db: &Db, ch: i64, user: i64) -> Result<Option<Channel>> {
    crate::metrics::timed("channels.access_check", accessible_channel_inner(db, ch, user)).await
}

async fn accessible_channel_inner(db: &Db, ch: i64, user: i64) -> Result<Option<Channel>> {
    let Some(mut c) = channel(db, ch).await? else { return Ok(None) };
    c.perms = match c.guild_id {
        Some(g) => match guild_ctx(db, g, user).await? {
            Some(ctx) => perms::channel(&ctx.member(), &overwrites(db, c.perm_source()).await?, &c.kind),
            None => 0,
        },
        None => {
            let member = sqlx::query("SELECT 1 FROM dm_members WHERE channel_id=$1 AND user_id=$2").bind(ch).bind(user).fetch_optional(db).await?.is_some();
            if member {
                DM_PERMS
            } else {
                0
            }
        }
    };
    Ok(perms::has(c.perms, perms::VIEW_CHANNEL).then_some(c))
}

/// Роли сервера (@everyone, id -> роль) и участники с их ролями — для массового вычисления прав.
pub async fn guild_roles_and_members(db: &Db, guild: i64) -> Result<(Role, HashMap<i64, Role>, Vec<(i64, Vec<i64>)>)> {
    let rows = sqlx::query("SELECT id, position, permissions, is_default FROM roles WHERE guild_id=$1").bind(guild).fetch_all(db).await?;
    let mut everyone = Role { id: 0, position: 0, permissions: 0 };
    let mut roles = HashMap::new();
    for r in &rows {
        if r.get::<bool, _>("is_default") {
            everyone = role_from(r)
        } else {
            roles.insert(r.get::<i64, _>("id"), role_from(r));
        }
    }
    let members: Vec<(i64, Vec<i64>)> = sqlx::query_as(
        "SELECT m.user_id, COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
         FROM members m LEFT JOIN member_roles mr ON mr.guild_id=m.guild_id AND mr.user_id=m.user_id
         WHERE m.guild_id=$1 GROUP BY m.user_id",
    )
    .bind(guild)
    .fetch_all(db)
    .await?;
    Ok((everyone, roles, members))
}

pub async fn guild_member_ids(db: &Db, guild: i64) -> Result<Vec<i64>> {
    sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id=$1").bind(guild).fetch_all(db).await
}

/// Кто должен получать события канала: только те, у кого есть VIEW_CHANNEL.
pub async fn channel_audience(db: &Db, c: &Channel) -> Result<Vec<i64>> {
    let Some(g) = c.guild_id else {
        return sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id=$1").bind(c.id).fetch_all(db).await;
    };
    let owner = guild_owner(db, g).await?.unwrap_or(0);
    let (everyone, roles, members) = guild_roles_and_members(db, g).await?;
    let ows = overwrites(db, c.perm_source()).await?;
    Ok(members
        .into_iter()
        .filter(|(uid, role_ids)| {
            let rs: Vec<Role> = role_ids.iter().filter_map(|id| roles.get(id).copied()).collect();
            let m = perms::Member { user_id: *uid, is_owner: *uid == owner, everyone, roles: &rs };
            perms::has(perms::channel(&m, &ows, &c.kind), perms::VIEW_CHANNEL)
        })
        .map(|(uid, _)| uid)
        .collect())
}

/// Все, кто «видит» пользователя: участники общих серверов и собеседники в ЛС.
pub async fn related_user_ids(db: &Db, user: i64) -> Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT m2.user_id FROM members m1 JOIN members m2 ON m1.guild_id=m2.guild_id WHERE m1.user_id=$1
         UNION SELECT d2.user_id FROM dm_members d1 JOIN dm_members d2 ON d1.channel_id=d2.channel_id WHERE d1.user_id=$1
         UNION SELECT other_id FROM relationships WHERE user_id=$1 AND kind <> 2",
    )
    .bind(user)
    .fetch_all(db)
    .await
}

/// Сервер для клиента (список серверов, события): имя, владелец, иконка (URL a256.webp; размеры — рядом), идёт ли обработка.
pub const GUILD_JSON: &str =
    "json_build_object('id',g.id,'name',g.name,'owner_id',g.owner_id,'icon',g.icon,'icon_anim',g.icon_anim,'icon_pending',g.icon_job IS NOT NULL)";
pub async fn guild_json(db: &Db, id: i64) -> std::result::Result<serde_json::Value, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT {GUILD_JSON} FROM guilds g WHERE g.id=$1")).bind(id).fetch_one(db).await
}
pub const USER_JSON: &str = "json_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'color',u.color,'status',u.status,'avatar',u.avatar,'avatar_anim',u.avatar_anim)";

pub async fn user_json(db: &Db, id: i64) -> Result<Value> {
    sqlx::query_scalar(&format!("SELECT {USER_JSON} FROM users u WHERE u.id=$1")).bind(id).fetch_one(db).await
}

pub async fn user_json_opt(db: &Db, id: i64) -> Result<Option<Value>> {
    sqlx::query_scalar(&format!("SELECT {USER_JSON} FROM users u WHERE u.id=$1")).bind(id).fetch_optional(db).await
}

const CHANNEL_JSON: &str = "json_build_object('id',c.id,'guild_id',c.guild_id,'parent_id',c.parent_id,'name',c.name,'kind',c.kind,
    'topic',c.topic,'position',c.position,'bitrate',c.bitrate,'user_limit',c.user_limit,
    'tags', CASE WHEN c.kind = 'forum' THEN COALESCE((SELECT json_agg(json_build_object('id', ft.id, 'name', ft.name, 'emoji', ft.emoji) ORDER BY ft.position, ft.id)
        FROM forum_tags ft WHERE ft.channel_id = c.id), '[]'::json) END)";

/// Ветка: канал + метаданные (FROM channels c JOIN threads t).
pub const THREAD_JSON: &str = "json_build_object('id',c.id,'guild_id',c.guild_id,'parent_id',c.parent_id,'name',c.name,'kind','thread',
    'topic','','position',0,'bitrate',0,'user_limit',0,
    'thread', json_build_object('owner_id',t.owner_id,'starter_message_id',t.starter_message_id,'archived',t.archived,'locked',t.locked,
        'auto_archive_minutes',t.auto_archive_minutes,'applied_tags',t.applied_tags,'created_at',t.created_at,
        'last_message_at',t.last_message_at,'message_count',t.message_count))";
pub const THREAD_FROM: &str = "FROM channels c JOIN threads t ON t.channel_id = c.id";

pub async fn thread_json(db: &Db, id: i64) -> Result<Value> {
    sqlx::query_scalar(&format!("SELECT {THREAD_JSON} {THREAD_FROM} WHERE c.id=$1")).bind(id).fetch_one(db).await
}

pub async fn channel_json(db: &Db, id: i64) -> Result<Value> {
    sqlx::query_scalar(&format!("SELECT {CHANNEL_JSON} FROM channels c WHERE c.id=$1")).bind(id).fetch_one(db).await
}

pub async fn guild_channels_json(db: &Db, guild: i64) -> Result<Vec<Value>> {
    // Ветки — отдельным списком (их может быть много, и права у них — от родителя).
    sqlx::query_scalar(&format!("SELECT {CHANNEL_JSON} FROM channels c WHERE c.guild_id=$1 AND c.kind <> 'thread' ORDER BY c.position, c.id"))
        .bind(guild)
        .fetch_all(db)
        .await
}

const REACTIONS_JSON: &str = "COALESCE((SELECT json_agg(json_build_object('emoji', x.emoji, 'users', x.users) ORDER BY x.first)
    FROM (SELECT emoji, array_agg(user_id ORDER BY seq) AS users, min(seq) AS first FROM reactions WHERE message_id = m.id GROUP BY emoji) x), '[]'::json)";

/// Сообщение целиком (автор, цитата ответа, вложение, реакции) — один запрос.
fn message_select() -> String {
    format!(
        "SELECT json_build_object(
           'id', m.id, 'channel_id', m.channel_id, 'content', m.content, 'created_at', m.created_at,
           'edited_at', m.edited_at, 'pinned', m.pinned, 'author', {USER_JSON},
           'reply_to', CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('id', r.id, 'content', left(r.content, 120),
               'author', json_build_object('id',ru.id,'username',ru.username,'display_name',ru.display_name,'color',ru.color,'status',ru.status)) END,
           'attachments', COALESCE((SELECT json_agg(json_build_object('url', a.url, 'name', a.name, 'size', a.size, 'content_type', a.content_type) ORDER BY a.position)
               FROM attachments a WHERE a.message_id = m.id), '[]'::json),
           'attachment', (SELECT json_build_object('url', a.url, 'name', a.name) FROM attachments a WHERE a.message_id = m.id ORDER BY a.position LIMIT 1),
           'mentions', m.mentions, 'mention_roles', m.mention_roles, 'mention_everyone', m.mention_everyone,
           'reactions', {REACTIONS_JSON},
           'embeds', CASE WHEN m.suppress_embeds THEN '[]'::jsonb ELSE m.embeds END, 'suppress_embeds', m.suppress_embeds,
           'thread', (SELECT json_build_object('id', t.channel_id, 'name', tc.name, 'message_count', t.message_count, 'last_message_at', t.last_message_at,
               'archived', t.archived) FROM threads t JOIN channels tc ON tc.id = t.channel_id WHERE t.starter_message_id = m.id),
           'poll', (SELECT json_build_object('question', p.question, 'multiselect', p.multiselect, 'expires_at', p.expires_at,
               'answers', (SELECT json_agg(json_build_object('id', a.id, 'text', a.text,
                   'voters', COALESCE((SELECT json_agg(v.user_id ORDER BY v.voted_at) FROM poll_votes v WHERE v.message_id = a.message_id AND v.answer_id = a.id), '[]'::json))
                 ORDER BY a.id) FROM poll_answers a WHERE a.message_id = p.message_id))
             FROM polls p WHERE p.message_id = m.id)
         )
         FROM messages m JOIN users u ON u.id = m.author_id
         LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.author_id"
    )
}

pub async fn reactions_json(db: &Db, msg: i64) -> Result<Value> {
    sqlx::query_scalar(&format!("SELECT {REACTIONS_JSON} FROM messages m WHERE m.id=$1")).bind(msg).fetch_one(db).await
}

pub async fn message_json(db: &Db, id: i64) -> Result<Value> {
    sqlx::query_scalar(&format!("{} WHERE m.id=$1", message_select())).bind(id).fetch_one(db).await
}

pub async fn message_json_opt(db: &Db, id: i64) -> Result<Option<Value>> {
    sqlx::query_scalar(&format!("{} WHERE m.id=$1", message_select())).bind(id).fetch_optional(db).await
}

/// Сообщения после `after` (догрузка вниз после перехода к старому сообщению), по возрастанию.
pub async fn messages_after(db: &Db, ch: i64, after: i64, limit: i64) -> Result<Vec<Value>> {
    sqlx::query_scalar(&format!("{} WHERE m.channel_id=$1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3", message_select()))
        .bind(ch)
        .bind(after)
        .bind(limit)
        .fetch_all(db)
        .await
}

/// Окно истории вокруг сообщения (переход по ссылке/к ответу): половина до, половина после.
pub async fn messages_around(db: &Db, ch: i64, around: i64, limit: i64) -> Result<Vec<Value>> {
    let half = (limit / 2).max(1);
    let mut list: Vec<Value> = sqlx::query_scalar(&format!("{} WHERE m.channel_id=$1 AND m.id <= $2 ORDER BY m.id DESC LIMIT $3", message_select()))
        .bind(ch)
        .bind(around)
        .bind(half)
        .fetch_all(db)
        .await?;
    list.reverse();
    let after: Vec<Value> = sqlx::query_scalar(&format!("{} WHERE m.channel_id=$1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3", message_select()))
        .bind(ch)
        .bind(around)
        .bind(half)
        .fetch_all(db)
        .await?;
    list.extend(after);
    Ok(list)
}

pub async fn messages_page(db: &Db, ch: i64, before: Option<i64>, limit: i64, q: Option<&str>, pinned: bool) -> Result<Vec<Value>> {
    let like = q.map(|s| format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    let mut list: Vec<Value> = sqlx::query_scalar(&format!(
        "{} WHERE m.channel_id=$1 AND m.id < $2 AND ($3::text IS NULL OR m.content ILIKE $3 ESCAPE '\\')
           AND (NOT $4 OR m.pinned) ORDER BY m.id DESC LIMIT $5",
        message_select()
    ))
    .bind(ch)
    .bind(before.unwrap_or(i64::MAX))
    .bind(like)
    .bind(pinned)
    .bind(limit)
    .fetch_all(db)
    .await?;
    list.reverse();
    Ok(list)
}

pub const ROLE_JSON: &str = "json_build_object('id',r.id,'name',r.name,'color',r.color,'position',r.position,
    'permissions',r.permissions,'hoist',r.hoist,'mentionable',r.mentionable,'is_default',r.is_default)";

pub async fn role_json(db: &Db, id: i64) -> Result<Value> {
    sqlx::query_scalar(&format!("SELECT {ROLE_JSON} FROM roles r WHERE r.id=$1")).bind(id).fetch_one(db).await
}

pub async fn guild_roles_json(db: &Db, guild: i64) -> Result<Vec<Value>> {
    sqlx::query_scalar(&format!("SELECT {ROLE_JSON} FROM roles r WHERE r.guild_id=$1 ORDER BY r.position DESC, r.id")).bind(guild).fetch_all(db).await
}

/// Все каналы, которые пользователь видит (VIEW_CHANNEL с учётом overwrites), и ЛС: (канал, сервер).
pub async fn visible_channels(db: &Db, user: i64) -> Result<Vec<(i64, Option<i64>)>> {
    let mut out = vec![];
    let guilds: Vec<i64> = sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id=$1").bind(user).fetch_all(db).await?;
    for g in guilds {
        let Some(ctx) = guild_ctx(db, g, user).await? else { continue };
        let ows = guild_overwrites(db, g).await?;
        let chans: Vec<(i64, String, Option<i64>)> = sqlx::query_as("SELECT id, kind, parent_id FROM channels WHERE guild_id=$1").bind(g).fetch_all(db).await?;
        for (id, kind, parent) in chans {
            if kind == "category" || kind == "voice" || kind == "forum" {
                continue;
            }
            let src = if kind == "thread" { parent.unwrap_or(id) } else { id };
            if perms::has(perms::channel(&ctx.member(), ows.get(&src).map(Vec::as_slice).unwrap_or(&[]), &kind), perms::VIEW_CHANNEL) {
                out.push((id, Some(g)));
            }
        }
    }
    let dms: Vec<i64> = sqlx::query_scalar("SELECT channel_id FROM dm_members WHERE user_id=$1").bind(user).fetch_all(db).await?;
    out.extend(dms.into_iter().map(|c| (c, None)));
    Ok(out)
}

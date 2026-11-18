//! Ветки, форумы и опросы (фаза 3e).
//!
//! Ветка — канал kind='thread' с parent_id = родительский текстовый канал или форум. Права ветки считаются
//! по overwrites родителя (db::Channel::perm_source); писать — по SEND_MESSAGES_IN_THREADS.
//! Пост форума — ветка, первое сообщение которой и есть пост.

use crate::api::{bad, create_message, is_unique_violation, load_message, need, not_found, ApiError, Attachment, Auth, NewMessage, R};
use crate::{db, now, perms, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

const AUTO_ARCHIVE: [i32; 4] = [60, 1440, 4320, 10080];

fn thread_name(n: &str) -> Result<String, ApiError> {
    let n = n.split_whitespace().collect::<Vec<_>>().join(" ");
    let len = n.chars().count();
    if !(1..=100).contains(&len) {
        return Err(bad("Название ветки: от 1 до 100 символов"));
    }
    Ok(n)
}

/// Разослать thread_create/thread_update всем, кто видит родительский канал.
pub(crate) async fn broadcast(st: &AppState, id: i64, kind: &str) -> Result<(), ApiError> {
    let Some(c) = db::channel(&st.db, id).await? else { return Ok(()) };
    let t = db::thread_json(&st.db, id).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": kind, "thread": t }));
    Ok(())
}

/// Сообщение в ветке: счётчик, время, разархивация, автор — участник ветки. true — только что вступил.
pub(crate) async fn on_message(tx: &mut sqlx::PgConnection, thread: i64, uid: i64) -> Result<bool, sqlx::Error> {
    let t = now();
    sqlx::query("UPDATE threads SET last_message_at=$2, message_count = message_count + 1, archived = FALSE WHERE channel_id=$1")
        .bind(thread)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    let r = sqlx::query("INSERT INTO thread_members(thread_id, user_id, joined_at) VALUES($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(thread)
        .bind(uid)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    Ok(r.rows_affected() > 0)
}

// ---------- создание ----------
#[derive(Deserialize)]
pub struct CreateThread {
    name: Option<String>,
    /// Ветка из сообщения родительского канала.
    message_id: Option<i64>,
    /// Пост форума: текст, вложения, теги.
    content: Option<String>,
    #[serde(default)]
    attachments: Vec<Attachment>,
    #[serde(default)]
    applied_tags: Vec<i64>,
    poll: Option<PollIn>,
}

async fn check_tags(st: &AppState, forum: i64, tags: &[i64]) -> Result<Vec<i64>, ApiError> {
    if tags.len() > 5 {
        return Err(bad("Не больше 5 тегов"));
    }
    if tags.is_empty() {
        return Ok(vec![]);
    }
    let ok: Vec<i64> = sqlx::query_scalar("SELECT id FROM forum_tags WHERE channel_id=$1 AND id = ANY($2)").bind(forum).bind(tags).fetch_all(&st.db).await?;
    if ok.len() != tags.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(bad("Неизвестный тег"));
    }
    Ok(ok)
}

pub async fn create(State(st): State<AppState>, Auth(uid): Auth, Path(parent): Path<i64>, Json(b): Json<CreateThread>) -> R {
    let p = db::accessible_channel(&st.db, parent, uid).await?.ok_or_else(not_found)?;
    let (name, starter, tags, post) = match p.kind.as_str() {
        "text" => {
            need(perms::has(p.perms, perms::CREATE_THREADS))?;
            let starter = match b.message_id {
                Some(mid) => Some(
                    sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id=$1 AND channel_id=$2")
                        .bind(mid)
                        .bind(parent)
                        .fetch_optional(&st.db)
                        .await?
                        .map(|c| (mid, c))
                        .ok_or_else(|| bad("Сообщение не из этого канала"))?,
                ),
                None => None,
            };
            let fallback =
                starter.as_ref().map(|(_, c)| c.chars().take(40).collect::<String>()).filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "Ветка".into());
            (thread_name(b.name.as_deref().unwrap_or(&fallback))?, starter.map(|(id, _)| id), vec![], None)
        }
        "forum" => {
            need(perms::has(p.perms, perms::SEND_MESSAGES))?;
            let content = b.content.unwrap_or_default();
            if content.trim().is_empty() && b.attachments.is_empty() {
                return Err(bad("Пост не может быть пустым"));
            }
            let tags = check_tags(&st, parent, &b.applied_tags).await?;
            let post = NewMessage { content, reply_to: None, attachment: None, attachments: b.attachments, nonce: None, poll: b.poll };
            (thread_name(b.name.as_deref().unwrap_or(""))?, None, tags, Some(post))
        }
        _ => return Err(bad("Ветки создаются в текстовых каналах и форумах")),
    };
    let t = now();
    let mut tx = st.db.begin().await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO channels(guild_id, name, kind, parent_id, position) VALUES($1, $2, 'thread', $3, 0) RETURNING id")
        .bind(p.guild_id)
        .bind(&name)
        .bind(parent)
        .fetch_one(&mut *tx)
        .await?;
    let ins = sqlx::query(
        "INSERT INTO threads(channel_id, parent_id, owner_id, starter_message_id, applied_tags, created_at, last_message_at) VALUES($1, $2, $3, $4, $5, $6, $6)",
    )
    .bind(id).bind(parent).bind(uid).bind(starter).bind(&tags).bind(t).execute(&mut *tx).await;
    if let Err(e) = ins {
        return Err(if is_unique_violation(&e) { bad("У этого сообщения уже есть ветка") } else { e.into() });
    }
    sqlx::query("INSERT INTO thread_members(thread_id, user_id, joined_at) VALUES($1, $2, $3)").bind(id).bind(uid).bind(t).execute(&mut *tx).await?;
    tx.commit().await?;
    broadcast(&st, id, "thread_create").await?;
    st.hub.send(&[uid], &json!({ "type": "thread_member", "thread_id": id, "joined": true }));
    if let Some(post) = post {
        let tc = db::accessible_channel(&st.db, id, uid).await?.ok_or_else(not_found)?;
        if let Err(e) = create_message(&st, uid, &tc, post).await {
            // Пост не создался — не оставляем пустую ветку.
            sqlx::query("DELETE FROM channels WHERE id=$1").bind(id).execute(&st.db).await?;
            st.hub.send(&db::channel_audience(&st.db, &p).await?, &json!({ "type": "thread_delete", "id": id, "parent_id": parent, "guild_id": p.guild_id }));
            return Err(e);
        }
    }
    if let Some(mid) = starter {
        let msg = db::message_json(&st.db, mid).await?;
        st.hub.send(&db::channel_audience(&st.db, &p).await?, &json!({ "type": "message_update", "message": msg }));
    }
    Ok(Json(db::thread_json(&st.db, id).await?))
}

// ---------- список ----------
#[derive(Deserialize)]
pub struct ListQuery {
    archived: Option<bool>,
    before: Option<i64>,
    limit: Option<i64>,
    sort: Option<String>,
}

/// Ветки канала (активные или архивные). Для форума — все посты с первым сообщением.
pub async fn list(State(st): State<AppState>, Auth(uid): Auth, Path(parent): Path<i64>, Query(q): Query<ListQuery>) -> R {
    let p = db::accessible_channel(&st.db, parent, uid).await?.ok_or_else(not_found)?;
    if p.kind != "text" && p.kind != "forum" {
        return Err(bad("Здесь нет веток"));
    }
    let forum = p.kind == "forum";
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let by = if q.sort.as_deref() == Some("created") { "t.created_at" } else { "t.last_message_at" };
    let archived_filter = if forum { String::new() } else { format!(" AND t.archived = {}", q.archived.unwrap_or(false)) };
    let sql = format!("SELECT {} {} WHERE t.parent_id=$1{archived_filter} AND {by} < $2 ORDER BY {by} DESC LIMIT $3", db::THREAD_JSON, db::THREAD_FROM);
    let mut threads: Vec<Value> = sqlx::query_scalar(&sql).bind(parent).bind(q.before.unwrap_or(i64::MAX)).bind(limit + 1).fetch_all(&st.db).await?;
    let has_more = threads.len() as i64 > limit;
    threads.truncate(limit as usize);
    let tp = if perms::has(p.perms, perms::SEND_MESSAGES_IN_THREADS) { p.perms | perms::SEND_MESSAGES } else { p.perms & !perms::SEND_MESSAGES };
    for t in &mut threads {
        t["permissions"] = json!(tp);
        if forum {
            let id = t["id"].as_i64().unwrap_or(0);
            let first: Option<i64> = sqlx::query_scalar("SELECT MIN(id) FROM messages WHERE channel_id=$1").bind(id).fetch_one(&st.db).await?;
            t["first_message"] = match first {
                Some(m) => db::message_json(&st.db, m).await?,
                None => Value::Null,
            };
        }
    }
    let joined: Vec<i64> =
        sqlx::query_scalar("SELECT thread_id FROM thread_members tm JOIN threads t ON t.channel_id = tm.thread_id WHERE tm.user_id=$1 AND t.parent_id=$2")
            .bind(uid)
            .bind(parent)
            .fetch_all(&st.db)
            .await?;
    Ok(Json(json!({ "threads": threads, "has_more": has_more, "joined": joined })))
}

// ---------- изменение и удаление ----------
#[derive(Deserialize)]
pub struct UpdateThread {
    name: Option<String>,
    archived: Option<bool>,
    locked: Option<bool>,
    applied_tags: Option<Vec<i64>>,
    auto_archive_minutes: Option<i32>,
}

async fn load_thread(st: &AppState, id: i64, uid: i64) -> Result<(db::Channel, i64, bool), ApiError> {
    let c = db::accessible_channel(&st.db, id, uid).await?.ok_or_else(not_found)?;
    if c.kind != "thread" {
        return Err(not_found());
    }
    let (owner, locked): (i64, bool) = sqlx::query_as("SELECT owner_id, locked FROM threads WHERE channel_id=$1").bind(id).fetch_one(&st.db).await?;
    Ok((c, owner, locked))
}

/// Автор ветки: название, теги, архив (если не закрыта), автоархив. Модератор веток (MANAGE_THREADS): всё и закрытие.
pub async fn update(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<UpdateThread>) -> R {
    let (c, owner, locked) = load_thread(&st, id, uid).await?;
    let moderator = perms::has(c.perms, perms::MANAGE_THREADS);
    need(moderator || owner == uid)?;
    if b.locked.is_some() {
        need(moderator)?;
    }
    if locked && !moderator {
        return Err(ApiError(StatusCode::FORBIDDEN, "Ветка закрыта модератором".into()));
    }
    let mut tx = st.db.begin().await?;
    if let Some(n) = &b.name {
        sqlx::query("UPDATE channels SET name=$1 WHERE id=$2").bind(thread_name(n)?).bind(id).execute(&mut *tx).await?;
    }
    if let Some(a) = b.archived {
        sqlx::query("UPDATE threads SET archived=$1 WHERE channel_id=$2").bind(a).bind(id).execute(&mut *tx).await?;
    }
    if let Some(l) = b.locked {
        sqlx::query("UPDATE threads SET locked=$1 WHERE channel_id=$2").bind(l).bind(id).execute(&mut *tx).await?;
    }
    if let Some(m) = b.auto_archive_minutes {
        if !AUTO_ARCHIVE.contains(&m) {
            return Err(bad("Автоархив: 60, 1440, 4320 или 10080 минут"));
        }
        sqlx::query("UPDATE threads SET auto_archive_minutes=$1 WHERE channel_id=$2").bind(m).bind(id).execute(&mut *tx).await?;
    }
    if let Some(tags) = &b.applied_tags {
        let tags = check_tags(&st, c.parent_id.unwrap_or(0), tags).await?;
        sqlx::query("UPDATE threads SET applied_tags=$1 WHERE channel_id=$2").bind(&tags).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    broadcast(&st, id, "thread_update").await?;
    Ok(Json(db::thread_json(&st.db, id).await?))
}

/// Одна ветка (в т.ч. архивная) с моими правами в ней.
pub async fn get(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let (c, _, _) = load_thread(&st, id, uid).await?;
    let mut t = db::thread_json(&st.db, id).await?;
    t["permissions"] = json!(c.perms);
    Ok(Json(t))
}

pub async fn delete(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let (c, owner, _) = load_thread(&st, id, uid).await?;
    need(owner == uid || perms::has(c.perms, perms::MANAGE_THREADS))?;
    let audience = db::channel_audience(&st.db, &c).await?;
    let starter: Option<i64> = sqlx::query_scalar("SELECT starter_message_id FROM threads WHERE channel_id=$1").bind(id).fetch_one(&st.db).await?;
    sqlx::query("DELETE FROM channels WHERE id=$1").bind(id).execute(&st.db).await?;
    st.hub.send(&audience, &json!({ "type": "thread_delete", "id": id, "parent_id": c.parent_id, "guild_id": c.guild_id }));
    if let Some(mid) = starter {
        if let Some(msg) = db::message_json_opt(&st.db, mid).await? {
            st.hub.send(&audience, &json!({ "type": "message_update", "message": msg }));
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn join(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    load_thread(&st, id, uid).await?;
    sqlx::query("INSERT INTO thread_members(thread_id, user_id, joined_at) VALUES($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(uid)
        .bind(now())
        .execute(&st.db)
        .await?;
    st.hub.send(&[uid], &json!({ "type": "thread_member", "thread_id": id, "joined": true }));
    Ok(Json(json!({ "joined": true })))
}

pub async fn leave(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    load_thread(&st, id, uid).await?;
    sqlx::query("DELETE FROM thread_members WHERE thread_id=$1 AND user_id=$2").bind(id).bind(uid).execute(&st.db).await?;
    st.hub.send(&[uid], &json!({ "type": "thread_member", "thread_id": id, "joined": false }));
    Ok(Json(json!({ "joined": false })))
}

// ---------- теги форума ----------
#[derive(Deserialize)]
pub struct TagIn {
    id: Option<i64>,
    name: String,
    #[serde(default)]
    emoji: String,
}

/// Полная замена списка тегов форума (MANAGE_CHANNELS). Удалённые теги снимаются с постов.
pub async fn put_tags(State(st): State<AppState>, Auth(uid): Auth, Path(forum): Path<i64>, Json(list): Json<Vec<TagIn>>) -> R {
    let c = db::accessible_channel(&st.db, forum, uid).await?.ok_or_else(not_found)?;
    if c.kind != "forum" {
        return Err(bad("Теги есть только у форумов"));
    }
    need(perms::has(c.perms, perms::MANAGE_CHANNELS))?;
    if list.len() > 20 {
        return Err(bad("Не больше 20 тегов"));
    }
    let mut tx = st.db.begin().await?;
    let mut keep = vec![];
    for (i, t) in list.iter().enumerate() {
        let name = t.name.trim();
        if !(1..=20).contains(&name.chars().count()) {
            return Err(bad("Название тега: от 1 до 20 символов"));
        }
        let emoji: String = t.emoji.chars().take(8).collect();
        let id: Option<i64> = match t.id {
            Some(id) => {
                sqlx::query_scalar("UPDATE forum_tags SET name=$1, emoji=$2, position=$3 WHERE id=$4 AND channel_id=$5 RETURNING id")
                    .bind(name)
                    .bind(&emoji)
                    .bind(i as i16)
                    .bind(id)
                    .bind(forum)
                    .fetch_optional(&mut *tx)
                    .await?
            }
            None => None,
        };
        let id = match id {
            Some(id) => id,
            None => {
                sqlx::query_scalar("INSERT INTO forum_tags(channel_id, name, emoji, position) VALUES($1, $2, $3, $4) RETURNING id")
                    .bind(forum)
                    .bind(name)
                    .bind(&emoji)
                    .bind(i as i16)
                    .fetch_one(&mut *tx)
                    .await?
            }
        };
        keep.push(id);
    }
    sqlx::query("DELETE FROM forum_tags WHERE channel_id=$1 AND NOT (id = ANY($2))").bind(forum).bind(&keep).execute(&mut *tx).await?;
    sqlx::query("UPDATE threads SET applied_tags = ARRAY(SELECT x FROM unnest(applied_tags) x WHERE x = ANY($2)) WHERE parent_id=$1")
        .bind(forum)
        .bind(&keep)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let ch = db::channel_json(&st.db, forum).await?;
    if let Some(g) = c.guild_id {
        st.hub.send(&db::guild_member_ids(&st.db, g).await?, &json!({ "type": "channel_update", "channel": ch }));
    }
    Ok(Json(ch))
}

// ---------- опросы ----------
#[derive(Deserialize)]
pub struct PollIn {
    question: String,
    answers: Vec<String>,
    #[serde(default)]
    multiselect: bool,
    duration_hours: Option<i64>,
}

pub struct Poll {
    question: String,
    answers: Vec<String>,
    multiselect: bool,
    expires_at: i64,
}

impl PollIn {
    pub fn validate(self) -> Result<Poll, String> {
        let question = self.question.trim().to_string();
        if !(1..=300).contains(&question.chars().count()) {
            return Err("Вопрос опроса: от 1 до 300 символов".into());
        }
        let answers: Vec<String> = self.answers.iter().map(|a| a.trim().to_string()).collect();
        if !(2..=10).contains(&answers.len()) {
            return Err("В опросе от 2 до 10 вариантов".into());
        }
        if answers.iter().any(|a| !(1..=55).contains(&a.chars().count())) {
            return Err("Вариант ответа: от 1 до 55 символов".into());
        }
        let hours = self.duration_hours.unwrap_or(24);
        if !(1..=336).contains(&hours) {
            return Err("Длительность опроса: от 1 часа до 2 недель".into());
        }
        Ok(Poll { question, answers, multiselect: self.multiselect, expires_at: now() + hours * 3_600_000 })
    }
}

impl Poll {
    pub async fn insert(&self, tx: &mut sqlx::PgConnection, msg: i64) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO polls(message_id, question, multiselect, expires_at) VALUES($1, $2, $3, $4)")
            .bind(msg)
            .bind(&self.question)
            .bind(self.multiselect)
            .bind(self.expires_at)
            .execute(&mut *tx)
            .await?;
        for (i, a) in self.answers.iter().enumerate() {
            sqlx::query("INSERT INTO poll_answers(message_id, id, text) VALUES($1, $2, $3)").bind(msg).bind(i as i16 + 1).bind(a).execute(&mut *tx).await?;
        }
        Ok(())
    }
}

async fn poll_changed(st: &AppState, msg: i64, c: &db::Channel) -> R {
    let m = db::message_json(&st.db, msg).await?;
    st.hub.send(&db::channel_audience(&st.db, c).await?, &json!({ "type": "message_update", "message": m }));
    Ok(Json(m))
}

#[derive(Deserialize)]
pub struct Vote {
    answers: Vec<i16>,
}

/// Мой голос (заменяет прежний; пустой список — отозвать).
pub async fn vote(State(st): State<AppState>, Auth(uid): Auth, Path(msg): Path<i64>, Json(v): Json<Vote>) -> R {
    let (_, c) = load_message(&st.db, msg, uid).await?;
    need(perms::has(c.perms, perms::READ_MESSAGE_HISTORY))?;
    let (multi, expires): (bool, i64) =
        sqlx::query_as("SELECT multiselect, expires_at FROM polls WHERE message_id=$1").bind(msg).fetch_optional(&st.db).await?.ok_or_else(not_found)?;
    if expires <= now() {
        return Err(bad("Опрос завершён"));
    }
    let mut answers = v.answers;
    answers.sort_unstable();
    answers.dedup();
    if answers.len() > 1 && !multi {
        return Err(bad("В этом опросе можно выбрать один вариант"));
    }
    if !answers.is_empty() {
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM poll_answers WHERE message_id=$1 AND id = ANY($2)").bind(msg).bind(&answers).fetch_one(&st.db).await?;
        if n as usize != answers.len() {
            return Err(bad("Нет такого варианта"));
        }
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM poll_votes WHERE message_id=$1 AND user_id=$2").bind(msg).bind(uid).execute(&mut *tx).await?;
    for a in &answers {
        sqlx::query("INSERT INTO poll_votes(message_id, answer_id, user_id, voted_at) VALUES($1, $2, $3, $4)")
            .bind(msg)
            .bind(a)
            .bind(uid)
            .bind(now())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    poll_changed(&st, msg, &c).await
}

/// Завершить опрос досрочно: автор или MANAGE_MESSAGES.
pub async fn end_poll(State(st): State<AppState>, Auth(uid): Auth, Path(msg): Path<i64>) -> R {
    let (author, c) = load_message(&st.db, msg, uid).await?;
    need(author == uid || perms::has(c.perms, perms::MANAGE_MESSAGES))?;
    let r = sqlx::query("UPDATE polls SET expires_at=$2 WHERE message_id=$1 AND expires_at > $2").bind(msg).bind(now()).execute(&st.db).await?;
    if r.rows_affected() == 0 {
        return Err(bad("Опрос уже завершён"));
    }
    poll_changed(&st, msg, &c).await
}

// ---------- автоархивация ----------
pub async fn auto_archive(st: &AppState) {
    let ids: Vec<i64> = match sqlx::query_scalar(
        "UPDATE threads SET archived = TRUE WHERE NOT archived AND last_message_at + auto_archive_minutes::bigint * 60000 < $1 RETURNING channel_id",
    )
    .bind(now())
    .fetch_all(&st.db)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("автоархив веток: {e}");
            return;
        }
    };
    for id in ids {
        if let Err(e) = broadcast(st, id, "thread_update").await {
            eprintln!("автоархив {id}: {}", e.1);
        }
    }
}

use crate::{db, mentions, now, perms, AppState};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, Multipart, Path, Query, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

// ---------- ошибки ----------
pub struct ApiError(pub StatusCode, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        eprintln!("db error: {e}");
        crate::metrics::db_error(&e);
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "внутренняя ошибка".into())
    }
}
pub(crate) fn bad(m: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, m.into())
}
pub(crate) fn forbidden() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "нет доступа".into())
}
pub(crate) fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "не найдено".into())
}
pub(crate) type R = Result<Json<Value>, ApiError>;

/// Контекст участника сервера; не участник — 404 (не раскрываем существование сервера).
pub(crate) async fn ctx(db: &db::Db, g: i64, uid: i64) -> Result<db::GuildCtx, ApiError> {
    db::guild_ctx(db, g, uid).await?.ok_or_else(not_found)
}
pub(crate) fn need(ok: bool) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(forbidden())
    }
}
/// Все участники сервера получают это событие и перечитывают сервер (роли, права, видимость каналов).
async fn guild_refresh(st: &AppState, g: i64) -> Result<(), ApiError> {
    st.hub.send(&db::guild_member_ids(&st.db, g).await?, &json!({ "type": "guild_refresh", "guild_id": g }));
    Ok(())
}

pub(crate) fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.is_unique_violation())
}

// ---------- авторизация ----------
pub struct Auth(pub i64);

pub async fn user_by_token(db: &db::Db, token: &str) -> Option<i64> {
    session_by_token(db, token).await.map(|(u, _)| u)
}

/// Пользователь и номер сеанса по токену. Последняя активность сеанса — не чаще раза в минуту (без лишних записей в БД).
pub async fn session_by_token(db: &db::Db, token: &str) -> Option<(i64, i64)> {
    let (uid, sid, seen): (i64, i64, Option<i64>) = crate::metrics::timed(
        "auth.session_lookup",
        sqlx::query_as("SELECT user_id, id, last_seen FROM sessions WHERE token=$1").bind(token).fetch_optional(db),
    )
    .await
    .ok()
    .flatten()?;
    let t = now();
    if seen.is_none_or(|s| t - s > 60_000) {
        let db = db.clone();
        tokio::spawn(async move {
            let _ = sqlx::query("UPDATE sessions SET last_seen=$1 WHERE id=$2").bind(t).bind(sid).execute(&db).await;
        });
    }
    Some((uid, sid))
}

/// Пользователь и его текущий сеанс (список сеансов, завершение, голосовые токены).
pub struct AuthSession {
    pub uid: i64,
    pub session: i64,
}
impl FromRequestParts<AppState> for AuthSession {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, ApiError> {
        let unauth = || ApiError(StatusCode::UNAUTHORIZED, "нужна авторизация".into());
        let token = bearer(&parts.headers).ok_or_else(unauth)?;
        session_by_token(&st.db, token).await.map(|(uid, session)| AuthSession { uid, session }).ok_or_else(unauth)
    }
}

fn bearer(h: &HeaderMap) -> Option<&str> {
    h.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, ApiError> {
        let unauth = || ApiError(StatusCode::UNAUTHORIZED, "нужна авторизация".into());
        let token = bearer(&parts.headers).ok_or_else(unauth)?;
        user_by_token(&st.db, token).await.map(Auth).ok_or_else(unauth)
    }
}

pub(crate) fn random_string(len: usize, alphabet: &[u8]) -> String {
    (0..len).map(|_| alphabet[rand::random::<usize>() % alphabet.len()] as char).collect()
}

/// Новый сеанс: что за клиент и откуда (список сеансов), запись в журнал безопасности.
async fn new_session(db: &db::Db, user: i64, headers: &HeaderMap, event: &str) -> Result<String, ApiError> {
    let token = random_string(48, b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    let c = crate::sessions::client_info(headers);
    let t = now();
    let id: i64 = sqlx::query_scalar("INSERT INTO sessions(token, user_id, created_at, last_seen, client, version, os, browser, ip, country, city) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id")
        .bind(&token).bind(user).bind(t).bind(&c.client).bind(&c.version).bind(&c.os).bind(&c.browser).bind(&c.ip).bind(&c.country).bind(&c.city).fetch_one(db).await?;
    crate::sessions::log(
        db,
        user,
        event,
        Some(id),
        Some(id),
        &c.ip,
        json!({ "client": c.client, "os": c.os, "browser": c.browser, "country": c.country, "city": c.city }),
    )
    .await;
    Ok(token)
}

const COLORS: [&str; 8] = ["#7c5cff", "#ff5c8a", "#2ec4b6", "#ff9f1c", "#3a86ff", "#8ac926", "#e63946", "#c77dff"];

#[derive(Deserialize)]
pub struct Creds {
    username: String,
    password: String,
    #[serde(default)]
    code: Option<String>,
}

/// Регистрация — только по коду приглашения (src/invites.rs): код расходуется в одной транзакции с созданием
/// пользователя (и добавлением на сервер кода); любая ошибка — откат, код остаётся неиспользованным.
pub async fn register(State(st): State<AppState>, headers: HeaderMap, Json(c): Json<Creds>) -> R {
    let ip = crate::invites::ip_key(&headers);
    crate::invites::register_attempt(&ip)?;
    let code = crate::invites::normalize(c.code.as_deref().unwrap_or(""));
    if code.is_empty() {
        return Err(crate::invites::invalid_code(&ip));
    }
    let name = c.username.trim().to_string();
    let len = name.chars().count();
    if !(2..=32).contains(&len) || !name.chars().all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '.') {
        return Err(bad("Имя: 2–32 символа, буквы, цифры, _ и ."));
    }
    if c.password.chars().count() < 6 {
        return Err(bad("Пароль — минимум 6 символов"));
    }
    let pw = c.password.clone();
    let hash = tokio::task::spawn_blocking(move || Argon2::default().hash_password(pw.as_bytes(), &SaltString::generate(&mut OsRng)).map(|h| h.to_string()))
        .await
        .unwrap()
        .map_err(|_| bad("не удалось захешировать пароль"))?;

    let color = COLORS[rand::random::<usize>() % COLORS.len()];
    let mut tx = st.db.begin().await?;
    let Some((invite, guild)) = crate::invites::consume(&mut tx, &code).await? else {
        return Err(crate::invites::invalid_code(&ip));
    };
    let id: i64 =
        match sqlx::query_scalar("INSERT INTO users(username, display_name, password_hash, color, created_at) VALUES($1, $1, $2, $3, $4) RETURNING id")
            .bind(&name)
            .bind(&hash)
            .bind(color)
            .bind(now())
            .fetch_one(&mut *tx)
            .await
        {
            Err(e) if is_unique_violation(&e) => return Err(ApiError(StatusCode::CONFLICT, "Это имя уже занято".into())),
            r => r?,
        };
    crate::invites::mark_used(&mut tx, invite, id).await?;
    if crate::invites::is_listed_admin(&name) {
        sqlx::query("UPDATE users SET is_admin=true WHERE id=$1").bind(id).execute(&mut *tx).await?;
    }
    // код с сервером — новичок сразу на нём (как по приглашению на сервер; старая история — прочитана)
    let joined = match guild {
        Some(g) if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM guilds WHERE id=$1)").bind(g).fetch_one(&mut *tx).await? => {
            sqlx::query("INSERT INTO members(guild_id, user_id, joined_at) VALUES($1, $2, $3) ON CONFLICT DO NOTHING")
                .bind(g)
                .bind(id)
                .bind(now())
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO read_states(user_id, channel_id, last_read_id)
                         SELECT $1, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id=c.id), 0) FROM channels c WHERE c.guild_id=$2
                         ON CONFLICT (user_id, channel_id) DO NOTHING",
            )
            .bind(id)
            .bind(g)
            .execute(&mut *tx)
            .await?;
            Some(g)
        }
        _ => None,
    };
    tx.commit().await?;
    eprintln!("регистрация: @{name} по коду №{invite}{}", joined.map(|g| format!(", сервер {g}")).unwrap_or_default());
    if let Some(g) = joined {
        let mut u = db::user_json(&st.db, id).await?;
        crate::social::present(&st, &mut u);
        st.hub.send(&db::guild_member_ids(&st.db, g).await?, &json!({ "type": "member_add", "guild_id": g, "user": u }));
    }
    crate::metrics::M.registrations.inc();
    let token = new_session(&st.db, id, &headers, "register").await?;
    Ok(Json(json!({ "token": token, "user": db::user_json(&st.db, id).await? })))
}

pub async fn login(State(st): State<AppState>, headers: HeaderMap, Json(c): Json<Creds>) -> R {
    let ip = crate::invites::ip_key(&headers);
    crate::invites::login_allowed(&ip)?;
    let row: Option<(i64, String)> = crate::metrics::timed(
        "users.login_lookup",
        sqlx::query_as("SELECT id, password_hash FROM users WHERE lower(username)=lower($1)").bind(c.username.trim()).fetch_optional(&st.db),
    )
    .await?;
    let wrong = || {
        crate::invites::login_failed(&ip);
        crate::metrics::M.logins.with_label_values(&["failure"]).inc();
        ApiError(StatusCode::UNAUTHORIZED, "Неверное имя или пароль".into())
    };
    let (id, hash) = row.ok_or_else(wrong)?;
    let ok = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).map(|h| Argon2::default().verify_password(c.password.as_bytes(), &h).is_ok()).unwrap_or(false)
    })
    .await
    .unwrap();
    if !ok {
        return Err(wrong());
    }
    crate::metrics::M.logins.with_label_values(&["success"]).inc();
    let token = new_session(&st.db, id, &headers, "login").await?;
    Ok(Json(json!({ "token": token, "user": db::user_json(&st.db, id).await? })))
}

pub async fn logout(State(st): State<AppState>, headers: HeaderMap) -> R {
    if let Some(t) = bearer(&headers) {
        let gone: Option<(i64, i64)> = sqlx::query_as("DELETE FROM sessions WHERE token=$1 RETURNING user_id, id").bind(t).fetch_optional(&st.db).await?;
        if let Some((uid, sid)) = gone {
            st.hub.gw.kick_auth(sid); // другие вкладки этого же сеанса тоже выходят
            crate::sessions::log(&st.db, uid, "logout", Some(sid), Some(sid), &crate::sessions::client_info(&headers).ip, json!({})).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- профиль ----------
pub async fn me(State(st): State<AppState>, Auth(uid): Auth) -> R {
    Ok(Json(me_payload(&st, uid).await?))
}

/// Снимок для клиента (GET /api/me и READY в gateway): пользователь, серверы, ЛС.
pub async fn me_payload(st: &AppState, uid: i64) -> Result<Value, ApiError> {
    let guilds: Vec<Value> =
        sqlx::query_scalar(&format!("SELECT {} FROM guilds g JOIN members m ON m.guild_id=g.id WHERE m.user_id=$1 ORDER BY m.joined_at", db::GUILD_JSON))
            .bind(uid)
            .fetch_all(&st.db)
            .await?;
    let dms = crate::social::dms_of(st, uid).await?;
    let dm_ids: Vec<i64> = dms.iter().filter_map(|d| d["id"].as_i64()).collect();
    let voice = st.hub.voice_in_channels(&dm_ids);
    let relationships = crate::social::rels_of(st, uid).await?;
    Ok(json!({ "user": crate::social::self_json(st, uid).await?, "guilds": guilds, "dms": dms, "relationships": relationships, "voice": voice,
               "read_states": read_states(st, uid).await?,
               "notification_settings": notification_settings_json(st, uid).await? }))
}

/// «Печатает…» (как в Discord — по REST). Только тем, кто видит канал; только с правом писать.
pub async fn typing(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>) -> R {
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    need(perms::has(c.perms, perms::SEND_MESSAGES))?;
    let aud: Vec<i64> = db::channel_audience(&st.db, &c).await?.into_iter().filter(|&u| u != uid).collect();
    st.hub.send(&aud, &json!({ "type": "typing_start", "channel_id": ch, "user_id": uid }));
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct VoiceFlags {
    muted: Option<bool>,
    deafened: Option<bool>,
    video: Option<bool>,
    screen: Option<bool>,
    screen_audio: Option<bool>,
}

/// Отображаемые mute/deafen/камера/экран. Звук режет клиент; что можно публиковать, сервер синхронизирует с LiveKit отдельно.
pub async fn voice_state(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<VoiceFlags>) -> R {
    let in_voice = st.hub.voice_set_flags(&st.db, uid, b.muted, b.deafened, b.video, b.screen, b.screen_audio).await;
    Ok(Json(json!({ "in_voice": in_voice })))
}

// ---------- сцена ----------
#[derive(Deserialize)]
pub struct Hand {
    raised: bool,
}

/// Слушатель поднимает/опускает руку.
pub async fn stage_hand(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<Hand>) -> R {
    let (_, ch) = st.hub.voice_of(uid).ok_or_else(|| bad("Вы не на сцене"))?;
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    if c.kind != "stage" {
        return Err(bad("Вы не на сцене"));
    }
    if !st.hub.voice_suppressed(uid) {
        return Err(bad("Вы уже выступаете"));
    }
    st.hub.voice_set_stage(&st.db, uid, None, Some(b.raised.then(now))).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Speaker {
    speaker: bool,
}

/// Сделать участника сцены выступающим или слушателем. Себя — слушателем всегда, выступающим — модератор;
/// других — только модератор сцены.
pub async fn stage_speaker(State(st): State<AppState>, Auth(uid): Auth, Path(target): Path<i64>, Json(b): Json<Speaker>) -> R {
    let (_, ch) = st.hub.voice_of(target).ok_or_else(|| bad("Участник не на сцене"))?;
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    if c.kind != "stage" {
        return Err(bad("Это не сцена"));
    }
    if target != uid || b.speaker {
        need(stage_mod(c.perms))?;
    }
    let _order = st.voice_sync.lock().await;
    st.hub.voice_set_stage(&st.db, target, Some(!b.speaker), None).await;
    if let (Some(lk), Some(t)) = (st.lk.clone(), db::accessible_channel(&st.db, ch, target).await?) {
        lk.set_can_publish(ch, target, &publish_sources(t.perms, &t.kind, !b.speaker)).await;
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- серверы ----------
#[derive(Deserialize)]
pub struct NameBody {
    name: String,
}

fn clean_name(n: &str, max: usize) -> Result<String, ApiError> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > max {
        return Err(bad(&format!("Название: 1–{max} символов")));
    }
    Ok(n.to_string())
}

pub async fn create_guild(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<NameBody>) -> R {
    let name = clean_name(&b.name, 64)?;
    let t = now();
    let mut tx = st.db.begin().await?;
    let g: i64 = sqlx::query_scalar("INSERT INTO guilds(name, owner_id, created_at) VALUES($1, $2, $3) RETURNING id")
        .bind(&name)
        .bind(uid)
        .bind(t)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO members(guild_id, user_id, joined_at) VALUES($1, $2, $3)").bind(g).bind(uid).bind(t).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO roles(guild_id, name, permissions, is_default, created_at) VALUES($1, '@everyone', $2, TRUE, $3)")
        .bind(g)
        .bind(perms::DEFAULT_EVERYONE as i64)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO channels(guild_id, name, kind, position) VALUES($1, 'общий', 'text', 0), ($1, 'Голосовой', 'voice', 1)")
        .bind(g)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let _ = name;
    Ok(Json(db::guild_json(&st.db, g).await?))
}

pub async fn guild_detail(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>) -> R {
    let me = ctx(&st.db, g, uid).await?;
    let (name, owner): (String, i64) = sqlx::query_as("SELECT name, owner_id FROM guilds WHERE id=$1").bind(g).fetch_one(&st.db).await?;
    // Каналы — только видимые, у каждого — мои права в нём (клиент по ним прячет недоступное).
    let ows = db::guild_overwrites(&st.db, g).await?;
    let channels: Vec<Value> = db::guild_channels_json(&st.db, g)
        .await?
        .into_iter()
        .filter_map(|mut c| {
            let id = c["id"].as_i64()?;
            let kind = c["kind"].as_str().unwrap_or("text").to_string();
            let p = perms::channel(&me.member(), ows.get(&id).map(Vec::as_slice).unwrap_or(&[]), &kind);
            // Категорию видно, если видна она сама (как в Discord; пустые скроет клиент).
            if !perms::has(p, perms::VIEW_CHANNEL) {
                return None;
            }
            c["permissions"] = json!(p);
            Some(c)
        })
        .collect();
    let threads: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {} {} WHERE c.guild_id=$1 AND NOT t.archived ORDER BY t.last_message_at DESC LIMIT 300",
        db::THREAD_JSON,
        db::THREAD_FROM
    ))
    .bind(g)
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .filter_map(|mut t: Value| {
        let parent = t["parent_id"].as_i64()?;
        let p = perms::channel(&me.member(), ows.get(&parent).map(Vec::as_slice).unwrap_or(&[]), "thread");
        if !perms::has(p, perms::VIEW_CHANNEL) {
            return None;
        }
        t["permissions"] = json!(p);
        Some(t)
    })
    .collect();
    let joined_threads: Vec<i64> =
        sqlx::query_scalar("SELECT tm.thread_id FROM thread_members tm JOIN channels c ON c.id = tm.thread_id WHERE tm.user_id=$1 AND c.guild_id=$2")
            .bind(uid)
            .bind(g)
            .fetch_all(&st.db)
            .await?;
    let roles = db::guild_roles_json(&st.db, g).await?;
    let mut members: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT ({})::jsonb || jsonb_build_object('nick', m.nick, 'roles',
            COALESCE((SELECT jsonb_agg(role_id) FROM member_roles mr WHERE mr.guild_id=m.guild_id AND mr.user_id=m.user_id), '[]'::jsonb))
         FROM members m JOIN users u ON u.id=m.user_id WHERE m.guild_id=$1 ORDER BY m.joined_at",
        db::USER_JSON
    ))
    .bind(g)
    .fetch_all(&st.db)
    .await?;
    for m in &mut members {
        let id = m["id"].as_i64().unwrap_or(0);
        let _ = id;
        crate::social::present(&st, m);
    }
    let voice: Vec<Value> = st.hub.voice_in_guild(g);
    let summary = db::guild_json(&st.db, g).await?;
    Ok(Json(json!({
        "id": g, "name": name, "owner_id": owner, "icon": summary["icon"], "icon_anim": summary["icon_anim"], "icon_pending": summary["icon_pending"], "channels": channels, "members": members, "voice": voice,
        "roles": roles, "permissions": me.base(), "threads": threads, "joined_threads": joined_threads,
        "emojis": crate::emojis::guild_emojis(&st.db, g).await?,
    })))
}

pub async fn update_guild(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<NameBody>) -> R {
    let name = clean_name(&b.name, 64)?;
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_GUILD))?;
    sqlx::query("UPDATE guilds SET name=$1 WHERE id=$2").bind(&name).bind(g).execute(&st.db).await?;
    guild_updated(&st, g).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Разослать участникам сервера его новые данные (имя, иконка) — у всех обновится без перезагрузки.
pub(crate) async fn guild_updated(st: &AppState, g: i64) -> Result<(), ApiError> {
    let guild = db::guild_json(&st.db, g).await?;
    st.hub.send(&db::guild_member_ids(&st.db, g).await?, &json!({ "type": "guild_update", "guild": guild }));
    Ok(())
}

#[derive(Deserialize)]
pub struct IconBody {
    url: String,
    crop: Option<crate::social::Crop>,
}

/// PUT /api/guilds/{id}/icon — новая иконка (файл из /upload + область 1:1), право «Управлять сервером».
/// Обработка — в фоне (тот же пайплайн, что у аватара); готово — guild_update всем участникам.
pub async fn set_guild_icon(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<IconBody>) -> R {
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_GUILD))?;
    crate::social::enqueue_guild_icon(&st, uid, g, &b.url, b.crop).await?;
    guild_updated(&st, g).await?; // «обрабатывается»
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/guilds/{id}/icon — убрать иконку (будут инициалы), право «Управлять сервером».
pub async fn delete_guild_icon(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>) -> R {
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_GUILD))?;
    sqlx::query("UPDATE guilds SET icon=NULL, icon_anim=false, icon_job=NULL WHERE id=$1").bind(g).execute(&st.db).await?;
    guild_updated(&st, g).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_guild(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>) -> R {
    need(ctx(&st.db, g, uid).await?.is_owner())?; // удалить сервер может только владелец
    let aud = db::guild_member_ids(&st.db, g).await?;
    sqlx::query("DELETE FROM guilds WHERE id=$1").bind(g).execute(&st.db).await?;
    kick_from_livekit(&st, st.hub.evict_voice(&st.db, |_, vg, _| vg == g).await);
    st.hub.send(&aud, &json!({ "type": "guild_delete", "guild_id": g }));
    Ok(Json(json!({ "ok": true })))
}

/// Выход из сервера (uid == себе) или кик (KICK_MEMBERS и роль выше цели).
pub async fn remove_member(State(st): State<AppState>, Auth(uid): Auth, Path((g, target)): Path<(i64, i64)>) -> R {
    let me = ctx(&st.db, g, uid).await?;
    if target == me.owner_id {
        return Err(bad("Владелец не может выйти — удалите сервер"));
    }
    if target != uid {
        let t = ctx(&st.db, g, target).await?;
        need(me.can(perms::KICK_MEMBERS) && perms::can_act_on(&me.member(), &t.member()))?;
    }
    let aud = db::guild_member_ids(&st.db, g).await?;
    sqlx::query("DELETE FROM members WHERE guild_id=$1 AND user_id=$2").bind(g).bind(target).execute(&st.db).await?;
    // Порядок важен: сначала членство удалено в БД, потом снимаем голос (см. livekit_webhook).
    kick_from_livekit(&st, st.hub.evict_voice(&st.db, |u, vg, _| u == target && vg == g).await);
    st.hub.send(&aud, &json!({ "type": "member_remove", "guild_id": g, "user_id": target }));
    Ok(Json(json!({ "ok": true })))
}

// ---------- каналы ----------
#[derive(Deserialize)]
pub struct ChannelBody {
    name: Option<String>,
    kind: Option<String>,
    topic: Option<String>,
    bitrate: Option<i64>,
    user_limit: Option<i64>,
    /// Категория; 0 — убрать из категории.
    parent_id: Option<i64>,
}

/// Категория того же сервера (или ошибка).
async fn check_parent(db: &db::Db, g: i64, parent: i64) -> Result<(), ApiError> {
    let ok: Option<String> = sqlx::query_scalar("SELECT kind FROM channels WHERE id=$1 AND guild_id=$2").bind(parent).bind(g).fetch_optional(db).await?;
    if ok.as_deref() == Some("category") {
        Ok(())
    } else {
        Err(bad("Категория не найдена"))
    }
}

fn channel_name(n: &str, kind: &str) -> Result<String, ApiError> {
    let n = clean_name(n, 48)?;
    Ok(if kind == "text" || kind == "forum" { n.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-") } else { n })
}

pub async fn create_channel(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<ChannelBody>) -> R {
    let kind = b.kind.as_deref().unwrap_or("text");
    if !["text", "voice", "category", "forum", "stage"].contains(&kind) {
        return Err(bad("Тип канала: text, voice, stage, category или forum"));
    }
    let name = channel_name(b.name.as_deref().unwrap_or(""), kind)?;
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_CHANNELS))?;
    let parent = b.parent_id.filter(|p| *p > 0 && kind != "category");
    if let Some(p) = parent {
        check_parent(&st.db, g, p).await?;
    }
    let mut tx = st.db.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO channels(guild_id, name, kind, topic, parent_id, position)
         VALUES($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE guild_id=$1)) RETURNING id",
    )
    .bind(g)
    .bind(&name)
    .bind(kind)
    .bind(b.topic.unwrap_or_default())
    .bind(parent)
    .fetch_one(&mut *tx)
    .await?;
    // Новый канал в категории наследует её права (синхронизация, как в Discord).
    if let Some(p) = parent {
        sqlx::query(
            "INSERT INTO permission_overwrites(channel_id, target_kind, target_id, allow, deny)
                     SELECT $1, target_kind, target_id, allow, deny FROM permission_overwrites WHERE channel_id=$2",
        )
        .bind(id)
        .bind(p)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let ch = db::channel_json(&st.db, id).await?;
    let c = db::channel(&st.db, id).await?.ok_or_else(not_found)?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "channel_create", "channel": ch }));
    Ok(Json(ch))
}

/// Канал сервера, которым пользователь может управлять (MANAGE_CHANNELS в самом канале).
async fn managed_channel(db: &db::Db, ch: i64, uid: i64) -> Result<db::Channel, ApiError> {
    let c = db::accessible_channel(db, ch, uid).await?.ok_or_else(not_found)?;
    if c.guild_id.is_none() {
        return Err(forbidden());
    }
    need(perms::has(c.perms, perms::MANAGE_CHANNELS))?;
    Ok(c)
}

pub async fn update_channel(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>, Json(b): Json<ChannelBody>) -> R {
    let c = managed_channel(&st.db, ch, uid).await?;
    let name = b.name.as_deref().map(|n| channel_name(n, &c.kind)).transpose()?;
    if let Some(p) = b.parent_id {
        if c.kind == "category" {
            return Err(bad("Категорию нельзя вложить в категорию"));
        }
        if p > 0 {
            check_parent(&st.db, c.guild_id.unwrap_or(0), p).await?;
        }
        sqlx::query("UPDATE channels SET parent_id=$1 WHERE id=$2").bind((p > 0).then_some(p)).bind(ch).execute(&st.db).await?;
    }
    let topic: Option<String> = b.topic.map(|t| t.trim().chars().take(256).collect());
    let (bitrate, limit) = if c.kind == "voice" || c.kind == "stage" { (b.bitrate, b.user_limit) } else { (None, None) };
    if let Some(br) = bitrate {
        if ![32_000, 64_000, 96_000, 128_000].contains(&br) {
            return Err(bad("Битрейт: 32, 64, 96 или 128 кбит/с"));
        }
    }
    if let Some(l) = limit {
        if !(0..=99).contains(&l) {
            return Err(bad("Лимит участников: 0–99 (0 — без лимита)"));
        }
    }
    sqlx::query(
        "UPDATE channels SET name=COALESCE($1, name), topic=COALESCE($2, topic), bitrate=COALESCE($3, bitrate), user_limit=COALESCE($4, user_limit) WHERE id=$5",
    )
    .bind(name).bind(topic).bind(bitrate).bind(limit).bind(ch)
    .execute(&st.db)
    .await?;
    let json = db::channel_json(&st.db, ch).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "channel_update", "channel": json }));
    Ok(Json(json))
}

pub async fn delete_channel(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>) -> R {
    let c = managed_channel(&st.db, ch, uid).await?;
    let aud = db::channel_audience(&st.db, &c).await?;
    sqlx::query("DELETE FROM channels WHERE id=$1").bind(ch).execute(&st.db).await?;
    kick_from_livekit(&st, st.hub.evict_voice(&st.db, |_, _, vc| vc == ch).await);
    st.hub.send(&aud, &json!({ "type": "channel_delete", "channel_id": ch, "guild_id": c.guild_id }));
    Ok(Json(json!({ "ok": true })))
}

// ---------- инвайты ----------
#[derive(Deserialize, Default)]
pub struct InviteBody {
    /// 0 — без лимита, иначе 1–100.
    #[serde(default)]
    max_uses: i32,
    /// Срок жизни в секундах; 0 — бессрочно.
    #[serde(default)]
    max_age: i64,
}

const INVITE_AGES: [i64; 7] = [0, 1800, 3600, 21_600, 43_200, 86_400, 604_800];

pub async fn create_invite(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, body: axum::body::Bytes) -> R {
    // Тело необязательно: пустое — бессрочный инвайт без лимита.
    let b: InviteBody = if body.iter().all(u8::is_ascii_whitespace) {
        InviteBody::default()
    } else {
        serde_json::from_slice(&body).map_err(|_| bad("Некорректные параметры приглашения"))?
    };
    if !(0..=100).contains(&b.max_uses) {
        return Err(bad("Лимит использований: 0–100"));
    }
    if !INVITE_AGES.contains(&b.max_age) {
        return Err(bad("Срок: 30 мин, 1 ч, 6 ч, 12 ч, 1 день, 7 дней или бессрочно"));
    }
    need(ctx(&st.db, g, uid).await?.can(perms::CREATE_INVITE))?;
    let code = random_string(8, b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789");
    let expires = (b.max_age > 0).then(|| now() + b.max_age * 1000);
    sqlx::query("INSERT INTO invites(code, guild_id, creator_id, created_at, max_uses, expires_at) VALUES($1, $2, $3, $4, $5, $6)")
        .bind(&code)
        .bind(g)
        .bind(uid)
        .bind(now())
        .bind(b.max_uses)
        .bind(expires)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({ "code": code, "max_uses": b.max_uses, "expires_at": expires })))
}

pub async fn list_invites(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>) -> R {
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_GUILD))?;
    let list: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT json_build_object('code', i.code, 'uses', i.uses, 'max_uses', i.max_uses, 'expires_at', i.expires_at,
            'created_at', i.created_at, 'creator', {})
         FROM invites i JOIN users u ON u.id=i.creator_id
         WHERE i.guild_id=$1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND (i.max_uses = 0 OR i.uses < i.max_uses)
         ORDER BY i.created_at DESC",
        db::USER_JSON
    ))
    .bind(g)
    .bind(now())
    .fetch_all(&st.db)
    .await?;
    Ok(Json(Value::Array(list)))
}

/// Отозвать инвайт: создатель или MANAGE_GUILD.
pub async fn delete_invite(State(st): State<AppState>, Auth(uid): Auth, Path(code): Path<String>) -> R {
    let (g, creator): (i64, i64) =
        sqlx::query_as("SELECT guild_id, creator_id FROM invites WHERE code=$1").bind(&code).fetch_optional(&st.db).await?.ok_or_else(bad_invite)?;
    let me = ctx(&st.db, g, uid).await?;
    need(creator == uid || me.can(perms::MANAGE_GUILD))?;
    sqlx::query("DELETE FROM invites WHERE code=$1").bind(&code).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

fn bad_invite() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Приглашение недействительно".into())
}
const INVITE_VALID: &str = "(i.expires_at IS NULL OR i.expires_at > $2) AND (i.max_uses = 0 OR i.uses < i.max_uses)";

pub async fn invite_info(State(st): State<AppState>, Auth(_): Auth, Path(code): Path<String>) -> R {
    let info: Value = sqlx::query_scalar(
        "SELECT json_build_object('guild_id', g.id, 'name', g.name, 'members', (SELECT COUNT(*) FROM members WHERE guild_id=g.id))
         FROM invites i JOIN guilds g ON g.id=i.guild_id WHERE i.code=$1 AND (i.expires_at IS NULL OR i.expires_at > $2)
           AND (i.max_uses = 0 OR i.uses < i.max_uses)",
    )
    .bind(&code)
    .bind(now())
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(bad_invite)?;
    Ok(Json(info))
}

pub async fn join_invite(State(st): State<AppState>, Auth(uid): Auth, Path(code): Path<String>) -> R {
    let mut tx = st.db.begin().await?;
    // Блокируем строку инвайта: проверка срока/лимита и учёт использования — атомарно.
    let g: i64 = sqlx::query_scalar(&format!("SELECT i.guild_id FROM invites i WHERE i.code=$1 AND {INVITE_VALID} FOR UPDATE"))
        .bind(&code)
        .bind(now())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(bad_invite)?;
    let added = sqlx::query("INSERT INTO members(guild_id, user_id, joined_at) VALUES($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(g)
        .bind(uid)
        .bind(now())
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if added > 0 {
        sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code=$1").bind(&code).execute(&mut *tx).await?;
        // Новичок не тонет в старой истории: всё, что было до входа, считается прочитанным.
        sqlx::query(
            "INSERT INTO read_states(user_id, channel_id, last_read_id)
                     SELECT $1, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id=c.id), 0) FROM channels c WHERE c.guild_id=$2
                     ON CONFLICT (user_id, channel_id) DO NOTHING",
        )
        .bind(uid)
        .bind(g)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    if added > 0 {
        let mut u = db::user_json(&st.db, uid).await?;
        crate::social::present(&st, &mut u);
        st.hub.send(&db::guild_member_ids(&st.db, g).await?, &json!({ "type": "member_add", "guild_id": g, "user": u }));
    }
    Ok(Json(db::guild_json(&st.db, g).await?))
}

// ---------- личные сообщения ----------
#[derive(Deserialize)]
pub struct DmBody {
    username: Option<String>,
    user_id: Option<i64>,
}

pub async fn open_dm(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<DmBody>) -> R {
    let other: i64 = match (b.user_id, b.username) {
        (Some(id), _) => id,
        (None, Some(n)) => sqlx::query_scalar("SELECT id FROM users WHERE lower(username)=lower($1)")
            .bind(n.trim())
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Пользователь не найден".into()))?,
        _ => return Err(bad("Укажите пользователя")),
    };
    if other == uid {
        return Err(bad("Нельзя написать самому себе"));
    }
    let mut u = db::user_json_opt(&st.db, other).await?.ok_or_else(not_found)?;
    // Транзакция с advisory-блокировкой на пару: два одновременных запроса не создадут два канала.
    let (lo, hi) = (uid.min(other), uid.max(other));
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)").bind(lo as i32).bind(hi as i32).execute(&mut *tx).await?;
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT a.channel_id FROM dm_members a JOIN dm_members b ON a.channel_id=b.channel_id JOIN channels c ON c.id=a.channel_id
         WHERE a.user_id=$1 AND b.user_id=$2 AND c.kind='dm'",
    )
    .bind(uid)
    .bind(other)
    .fetch_optional(&mut *tx)
    .await?;
    let (ch, created) = match existing {
        Some(c) => (c, false),
        None => {
            crate::social::can_dm(&st.db, uid, other).await?;
            let c: i64 = sqlx::query_scalar("INSERT INTO channels(guild_id, name, kind) VALUES(NULL, 'dm', 'dm') RETURNING id").fetch_one(&mut *tx).await?;
            sqlx::query("INSERT INTO dm_members(channel_id, user_id) VALUES($1, $2), ($1, $3)").bind(c).bind(uid).bind(other).execute(&mut *tx).await?;
            (c, true)
        }
    };
    tx.commit().await?;
    if created {
        let dm = crate::social::dm_json(&st, ch, other).await?;
        st.hub.send(&[other], &json!({ "type": "dm_create", "dm": dm }));
    }
    let _ = &mut u;
    Ok(Json(crate::social::dm_json(&st, ch, uid).await?))
}

// ---------- сообщения ----------
#[derive(Deserialize)]
pub struct PageQuery {
    before: Option<i64>,
    around: Option<i64>,
    after: Option<i64>,
    limit: Option<i64>,
    q: Option<String>,
    pinned: Option<bool>,
}

pub async fn list_messages(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>, Query(p): Query<PageQuery>) -> R {
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    if !perms::has(c.perms, perms::READ_MESSAGE_HISTORY) {
        return Ok(Json(json!([])));
    }
    if let Some(after) = p.after {
        return Ok(Json(Value::Array(
            crate::metrics::timed("messages.list_after", db::messages_after(&st.db, ch, after, p.limit.unwrap_or(50).clamp(1, 100))).await?,
        )));
    }
    if let Some(around) = p.around {
        return Ok(Json(Value::Array(
            crate::metrics::timed("messages.list_around", db::messages_around(&st.db, ch, around, p.limit.unwrap_or(50).clamp(2, 100))).await?,
        )));
    }
    let q = p.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let list = crate::metrics::timed(
        "messages.list_by_channel",
        db::messages_page(&st.db, ch, p.before, p.limit.unwrap_or(50).clamp(1, 100), q, p.pinned.unwrap_or(false)),
    )
    .await?;
    Ok(Json(Value::Array(list)))
}

#[derive(Deserialize)]
pub struct Attachment {
    pub(crate) url: String,
    pub(crate) name: String,
}
#[derive(Deserialize)]
pub struct NewMessage {
    #[serde(default)]
    pub(crate) content: String,
    pub(crate) reply_to: Option<i64>,
    /// Старый формат (одно вложение) — для клиента /legacy.
    pub(crate) attachment: Option<Attachment>,
    #[serde(default)]
    pub(crate) attachments: Vec<Attachment>,
    /// Метка оптимистичной отправки: возвращается в ответе и событии, чтобы клиент заменил «отправляется…».
    pub(crate) nonce: Option<String>,
    /// Опрос (фаза 3e).
    pub(crate) poll: Option<crate::threads::PollIn>,
}

const MAX_LEN: usize = 4000;
const MAX_ATTACHMENTS: usize = 10;

fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e).unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        _ => "application/octet-stream",
    }
}

/// Вложения сообщения: только наши загрузки (файл должен существовать), с размером и типом.
async fn checked_attachments(st: &AppState, list: Vec<Attachment>) -> Result<Vec<(String, String, i64, &'static str)>, ApiError> {
    if list.len() > MAX_ATTACHMENTS {
        return Err(bad("Не больше 10 вложений"));
    }
    let mut out = vec![];
    for a in list {
        let file = a.url.strip_prefix("/uploads/").unwrap_or("");
        if file.is_empty() || !file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') {
            return Err(bad("Некорректное вложение"));
        }
        let size = st.store.size(file).await.ok().flatten().ok_or_else(|| bad("Вложение не найдено"))?;
        out.push((a.url.clone(), a.name.chars().take(200).collect(), size as i64, content_type(file)));
    }
    Ok(out)
}

/// Кого действительно упоминает сообщение: только участники канала; роли — упоминаемые или
/// при праве MENTION_EVERYONE; @everyone/@here — только с MENTION_EVERYONE (иначе это просто текст).
async fn resolve_mentions(db: &db::Db, c: &db::Channel, content: &str) -> Result<(Vec<i64>, Vec<i64>, bool), ApiError> {
    let p = mentions::parse(content);
    let can_all = perms::has(c.perms, perms::MENTION_EVERYONE);
    let users = if p.users.is_empty() {
        vec![]
    } else {
        let audience = db::channel_audience(db, c).await?;
        p.users.into_iter().filter(|u| audience.contains(u)).collect()
    };
    let roles: Vec<i64> = match c.guild_id {
        Some(g) if !p.roles.is_empty() => {
            sqlx::query_scalar("SELECT id FROM roles WHERE guild_id=$1 AND id = ANY($2) AND NOT is_default AND (mentionable OR $3)")
                .bind(g)
                .bind(&p.roles)
                .bind(can_all)
                .fetch_all(db)
                .await?
        }
        _ => vec![],
    };
    Ok((users, roles, p.everyone && can_all))
}

pub async fn post_message(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>, Json(m): Json<NewMessage>) -> R {
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    Ok(Json(create_message(&st, uid, &c, m).await?))
}

/// Создать сообщение в доступном канале (обычная отправка и первый пост форума).
pub(crate) async fn create_message(st: &AppState, uid: i64, c: &db::Channel, m: NewMessage) -> Result<Value, ApiError> {
    let ch = c.id;
    let content = m.content.trim().to_string();
    if content.chars().count() > MAX_LEN {
        return Err(bad("Сообщение слишком длинное (макс. 4000)"));
    }
    let mut list = m.attachments;
    if let Some(a) = m.attachment {
        list.insert(0, a);
    }
    let poll = m.poll.map(|p| p.validate()).transpose().map_err(|e| bad(&e))?;
    if content.is_empty() && list.is_empty() && poll.is_none() {
        return Err(bad("Пустое сообщение"));
    }
    let nonce = m.nonce.filter(|n| n.len() <= 64);
    if c.kind == "voice" || c.kind == "stage" || c.kind == "category" {
        return Err(bad("В этот канал нельзя писать"));
    }
    if c.kind == "forum" {
        return Err(bad("В форуме пишут в постах: создайте пост"));
    }
    if c.kind == "dm" {
        let other: Option<i64> =
            sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id=$1 AND user_id<>$2").bind(ch).bind(uid).fetch_optional(&st.db).await?;
        if let Some(o) = other {
            if crate::social::blocked_either(&st.db, uid, o).await? {
                return Err(ApiError(StatusCode::FORBIDDEN, "Нельзя отправить сообщение: один из вас заблокировал другого".into()));
            }
        }
    }
    need(perms::has(c.perms, perms::SEND_MESSAGES))?;
    // Закрытая ветка — только для модераторов веток; архивная открывается новым сообщением.
    if c.kind == "thread" {
        let locked: bool = sqlx::query_scalar("SELECT locked FROM threads WHERE channel_id=$1").bind(ch).fetch_one(&st.db).await?;
        if locked && !perms::has(c.perms, perms::MANAGE_THREADS) {
            return Err(ApiError(StatusCode::FORBIDDEN, "Ветка закрыта".into()));
        }
    }
    if !list.is_empty() {
        need(perms::has(c.perms, perms::ATTACH_FILES))?;
    }
    let atts = checked_attachments(st, list).await?;
    let (users, roles, everyone) = resolve_mentions(&st.db, c, &content).await?;
    let mut tx = st.db.begin().await?;
    // Ответ — только на сообщение из этого же канала (иначе reply_to = NULL).
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO messages(channel_id, author_id, content, created_at, reply_to, mentions, mention_roles, mention_everyone)
         VALUES($1, $2, $3, $4, (SELECT id FROM messages WHERE id=$5 AND channel_id=$1), $6, $7, $8) RETURNING id",
    )
    .bind(ch)
    .bind(uid)
    .bind(&content)
    .bind(now())
    .bind(m.reply_to)
    .bind(&users)
    .bind(&roles)
    .bind(everyone);
    let id: i64 = crate::metrics::timed("messages.insert", id.fetch_one(&mut *tx)).await?;
    for (i, (url, name, size, ct)) in atts.iter().enumerate() {
        sqlx::query("INSERT INTO attachments(message_id, url, name, size, content_type, position) VALUES($1, $2, $3, $4, $5, $6)")
            .bind(id)
            .bind(url)
            .bind(name)
            .bind(size)
            .bind(ct)
            .bind(i as i16)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(p) = &poll {
        p.insert(&mut tx, id).await?;
    }
    let joined = if c.kind == "thread" { crate::threads::on_message(&mut tx, ch, uid).await? } else { false };
    tx.commit().await?;
    crate::metrics::message_created(&c.kind);
    let mut msg = crate::metrics::timed("messages.load_one", db::message_json(&st.db, id)).await?;
    if let Some(n) = nonce {
        msg["nonce"] = json!(n);
    }
    let audience = db::channel_audience(&st.db, c).await?;
    count_mentions(st, c, id, uid, &audience, &users, &roles, everyone, m.reply_to).await?;
    if perms::has(c.perms, perms::EMBED_LINKS) {
        crate::embeds::spawn(st.clone(), id, content.to_string());
    }
    st.hub.send(&audience, &json!({ "type": "message_create", "message": msg, "guild_id": c.guild_id }));
    if c.kind == "thread" {
        crate::threads::broadcast(st, ch, "thread_update").await?;
        if joined {
            st.hub.send(&[uid], &json!({ "type": "thread_member", "thread_id": ch, "joined": true }));
        }
    }
    Ok(msg)
}

/// Сообщение + канал, с проверкой доступа.
pub(crate) async fn load_message(db: &db::Db, id: i64, uid: i64) -> Result<(i64, db::Channel), ApiError> {
    let (author, ch): (i64, i64) =
        sqlx::query_as("SELECT author_id, channel_id FROM messages WHERE id=$1").bind(id).fetch_optional(db).await?.ok_or_else(not_found)?;
    let c = db::accessible_channel(db, ch, uid).await?.ok_or_else(not_found)?;
    Ok((author, c))
}

#[derive(Deserialize)]
pub struct EditMessage {
    content: String,
}

pub async fn edit_message(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(e): Json<EditMessage>) -> R {
    let content = e.content.trim();
    if content.is_empty() || content.chars().count() > MAX_LEN {
        return Err(bad("Некорректный текст"));
    }
    let (author, c) = load_message(&st.db, id, uid).await?;
    if author != uid {
        return Err(forbidden());
    }
    let (users, roles, everyone) = resolve_mentions(&st.db, &c, content).await?;
    sqlx::query("UPDATE messages SET content=$1, edited_at=$2, mentions=$3, mention_roles=$4, mention_everyone=$5 WHERE id=$6")
        .bind(content)
        .bind(now())
        .bind(&users)
        .bind(&roles)
        .bind(everyone)
        .bind(id)
        .execute(&st.db)
        .await?;
    // Новые ссылки — новые превью (без права EMBED_LINKS превью просто исчезнут).
    if perms::has(c.perms, perms::EMBED_LINKS) {
        crate::embeds::spawn(st.clone(), id, content.to_string());
    } else {
        sqlx::query("UPDATE messages SET embeds='[]' WHERE id=$1").bind(id).execute(&st.db).await?;
    }
    let msg = db::message_json(&st.db, id).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "message_update", "message": msg }));
    Ok(Json(msg))
}

pub async fn delete_message(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let (author, c) = load_message(&st.db, id, uid).await?;
    need(author == uid || perms::has(c.perms, perms::MANAGE_MESSAGES))?;
    sqlx::query("DELETE FROM messages WHERE id=$1").bind(id).execute(&st.db).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "message_delete", "id": id, "channel_id": c.id }));
    Ok(Json(json!({ "ok": true })))
}

pub async fn toggle_pin(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let (_, c) = load_message(&st.db, id, uid).await?;
    need(perms::has(c.perms, perms::PIN_MESSAGES) || perms::has(c.perms, perms::MANAGE_MESSAGES))?;
    sqlx::query("UPDATE messages SET pinned = NOT pinned WHERE id=$1").bind(id).execute(&st.db).await?;
    let msg = db::message_json(&st.db, id).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "message_update", "message": msg }));
    Ok(Json(msg))
}

pub async fn toggle_reaction(State(st): State<AppState>, Auth(uid): Auth, Path((id, emoji)): Path<(i64, String)>) -> R {
    let (_, c) = load_message(&st.db, id, uid).await?;
    // Эмодзи сервера — токен <:имя:id> (проверяется и приводится к каноническому виду); обычные — до 8 символов.
    let emoji = emoji.trim();
    let custom;
    let emoji = if emoji.starts_with('<') {
        custom = crate::emojis::reaction_token(&st, uid, &c, emoji).await?;
        custom.as_str()
    } else {
        if emoji.is_empty() || emoji.chars().count() > 8 {
            return Err(bad("Некорректная реакция"));
        }
        emoji
    };
    need(perms::has(c.perms, perms::READ_MESSAGE_HISTORY))?;
    let removed = sqlx::query("DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3")
        .bind(id)
        .bind(uid)
        .bind(emoji)
        .execute(&st.db)
        .await?
        .rows_affected();
    if removed == 0 {
        need(perms::has(c.perms, perms::ADD_REACTIONS))?;
        // Лимит разных эмодзи: под блокировкой строки сообщения, иначе параллельные INSERT в Read Committed
        // видят старый COUNT и вместе превышают лимит.
        let mut tx = st.db.begin().await?;
        sqlx::query("SELECT 1 FROM messages WHERE id=$1 FOR UPDATE").bind(id).execute(&mut *tx).await?;
        let added = sqlx::query(
            "INSERT INTO reactions(message_id, user_id, emoji)
             SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM reactions WHERE message_id=$1 AND emoji=$3)
                OR (SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id=$1) < 20
             ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(uid)
        .bind(emoji)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        if added == 0 {
            return Err(bad("Слишком много разных реакций"));
        }
    }
    let reactions = db::reactions_json(&st.db, id).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "reaction_update", "message_id": id, "channel_id": c.id, "reactions": reactions }));
    Ok(Json(reactions))
}

// ---------- загрузка файлов ----------
const ALLOWED_EXT: [&str; 16] = ["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "mp3", "ogg", "wav", "pdf", "txt", "zip", "7z", "json"];

pub async fn upload(State(st): State<AppState>, Auth(_): Auth, mut mp: Multipart) -> R {
    while let Some(field) = mp.next_field().await.map_err(|_| bad("Ошибка загрузки"))? {
        if field.name() != Some("file") {
            continue;
        }
        let orig = field.file_name().unwrap_or("file").to_string();
        let ext = orig.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        // Неизвестные типы сохраняем как .bin — так они скачиваются, а не исполняются в браузере.
        let ext = if ALLOWED_EXT.contains(&ext.as_str()) { ext } else { "bin".into() };
        let data = field.bytes().await.map_err(|_| bad("Файл слишком большой (макс. 25 МБ)"))?;
        let name = format!("{}.{ext}", random_string(24, b"abcdefghijklmnopqrstuvwxyz0123456789"));
        // фото: без EXIF/GPS, XMP и прочих метаданных (ориентация сохраняется)
        let data = if ext == "jpg" || ext == "jpeg" { crate::media::strip_jpeg_metadata(&data) } else { data.to_vec() };
        st.store.put(&name, data.clone()).await.map_err(|e| {
            eprintln!("хранилище: {name}: {e}");
            bad("Не удалось сохранить файл")
        })?;
        crate::metrics::uploaded(&ext, data.len());
        return Ok(Json(json!({ "url": format!("/uploads/{name}"), "name": orig, "size": data.len(), "content_type": content_type(&name) })));
    }
    Err(bad("Нет файла"))
}

// ---------- голос (LiveKit) ----------
/// Выкинуть из комнат LiveKit тех, кого сервер вывел из голоса (кик, удаление).
pub(crate) fn kick_from_livekit(st: &AppState, evicted: Vec<(i64, i64)>) {
    let Some(lk) = st.lk.clone() else { return };
    for (user, channel) in evicted {
        let lk = lk.clone();
        tokio::spawn(async move { lk.remove_participant(channel, user).await });
    }
}

#[derive(Deserialize)]
pub struct VoiceTokenBody {
    channel_id: i64,
}

/// Токен нативной демонстрации экрана (Relay Desktop): только тому, кто сейчас в этом голосовом канале
/// и может транслировать экран (право «Видео»; в ЛС — всегда; слушатель сцены — нет).
pub async fn voice_screen_token(State(st): State<AppState>, AuthSession { uid, session }: AuthSession, headers: HeaderMap, Json(b): Json<VoiceTokenBody>) -> R {
    let lk = st.lk.clone().ok_or_else(|| ApiError(StatusCode::SERVICE_UNAVAILABLE, "Голос не настроен на сервере".into()))?;
    if st.hub.voice_of(uid).map(|(_, c)| c) != Some(b.channel_id) {
        return Err(bad("Сначала подключитесь к этому голосовому каналу"));
    }
    let c = db::accessible_channel(&st.db, b.channel_id, uid).await?.ok_or_else(not_found)?;
    need(publish_sources(c.perms, &c.kind, st.hub.voice_suppressed(uid)).contains(&"screen_share"))?;
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1").bind(uid).fetch_one(&st.db).await?;
    crate::regions::note_voice_token(&headers, uid, "screen");
    Ok(Json(
        json!({ "url": lk.public_url, "token": lk.screen_token(uid, &name, c.id, session), "identity": crate::livekit::screen_identity(uid), "ice": crate::regions::ice_for(&headers, uid) }),
    ))
}

/// Токен на вход в голосовой канал: только участникам сервера, только в голосовой канал,
/// с учётом лимита. Сам факт входа сервер узнаёт из вебхука LiveKit, а не от клиента.
pub async fn voice_token(State(st): State<AppState>, AuthSession { uid, session }: AuthSession, headers: HeaderMap, Json(b): Json<VoiceTokenBody>) -> R {
    let lk = st.lk.clone().ok_or_else(|| ApiError(StatusCode::SERVICE_UNAVAILABLE, "Голос не настроен на сервере".into()))?;
    let c = db::accessible_channel(&st.db, b.channel_id, uid).await?.ok_or_else(not_found)?;
    match c.kind.as_str() {
        "voice" | "stage" => need(perms::has(c.perms, perms::CONNECT))?,
        "dm" => {
            let other: Option<i64> =
                sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id=$1 AND user_id<>$2").bind(c.id).bind(uid).fetch_optional(&st.db).await?;
            if let Some(o) = other {
                if crate::social::blocked_either(&st.db, uid, o).await? {
                    return Err(ApiError(StatusCode::FORBIDDEN, "Нельзя позвонить этому пользователю".into()));
                }
            }
        }
        "group_dm" => {}
        _ => return Err(bad("Это не голосовой канал")),
    }
    let (bitrate, limit): (i64, i64) = sqlx::query_as("SELECT bitrate, user_limit FROM channels WHERE id=$1").bind(c.id).fetch_one(&st.db).await?;
    if c.kind == "voice" && limit > 0 && st.hub.voice_count(c.id, uid) as i64 >= limit {
        return Err(bad("Канал заполнен"));
    }
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1").bind(uid).fetch_one(&st.db).await?;
    // На сцене входят слушателями (кроме модераторов сцены); переподключение сохраняет роль.
    let suppressed = c.kind == "stage"
        && match st.hub.voice_of(uid) {
            Some((_, ch)) if ch == c.id => st.hub.voice_suppressed(uid),
            _ => !stage_mod(c.perms),
        };
    let token = lk.join_token(uid, &name, c.id, &publish_sources(c.perms, &c.kind, suppressed), session);
    crate::regions::note_voice_token(&headers, uid, "voice");
    // ice — маршрут медиа: через edge-регион клиент получает TURN узла (и, если задано, только релей).
    Ok(Json(json!({ "url": lk.public_url, "token": token, "bitrate": bitrate, "ice": crate::regions::ice_for(&headers, uid) })))
}

/// Что можно публиковать: микрофон — SPEAK, камера и экран — STREAM («Видео»); в ЛС — всё; слушатель сцены — ничего.
pub(crate) fn publish_sources(p: perms::Perms, kind: &str, suppressed: bool) -> Vec<&'static str> {
    if suppressed {
        return vec![];
    }
    if kind == "dm" || kind == "group_dm" {
        return vec!["microphone", "camera", "screen_share", "screen_share_audio"];
    }
    let mut s = vec![];
    if perms::has(p, perms::SPEAK) {
        s.push("microphone");
    }
    if perms::has(p, perms::STREAM) {
        s.extend(["camera", "screen_share", "screen_share_audio"]);
    }
    s
}

/// Модератор сцены: может выступать сам и приглашать/снимать выступающих.
pub(crate) fn stage_mod(p: perms::Perms) -> bool {
    perms::has(p, perms::MUTE_MEMBERS) || perms::has(p, perms::MOVE_MEMBERS) || perms::has(p, perms::MANAGE_CHANNELS)
}

/// Доступ к комнате: (сервер или 0 для ЛС, канал с правами).
async fn voice_allowed(st: &AppState, user: i64, ch: i64) -> Option<(i64, db::Channel)> {
    db::accessible_channel(&st.db, ch, user)
        .await
        .ok()
        .flatten()
        .filter(|c| match c.kind.as_str() {
            "voice" | "stage" => perms::has(c.perms, perms::CONNECT),
            "dm" | "group_dm" => true,
            _ => false,
        })
        .map(|c| (c.guild_id.unwrap_or(0), c))
}

/// Вебхуки LiveKit: единственный источник правды о том, кто в каком голосовом канале.
pub async fn livekit_webhook(State(st): State<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> StatusCode {
    let Some(lk) = st.lk.clone() else { return StatusCode::NOT_FOUND };
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !lk.verify_webhook(auth, &body) {
        return StatusCode::UNAUTHORIZED;
    }
    let Ok(ev) = serde_json::from_slice::<Value>(&body) else { return StatusCode::BAD_REQUEST };
    let Some(ch) = ev["room"]["name"].as_str().and_then(crate::livekit::parse_room) else { return StatusCode::OK };
    let user = ev["participant"]["identity"].as_str().and_then(|s| s.parse::<i64>().ok());
    let sid = ev["participant"]["sid"].as_str().unwrap_or("");
    // Сеанс Relay, выдавший токен LiveKit (метаданные участника). Сеанс завершён — в комнату не пускаем,
    // даже с ещё не истёкшим токеном (и голос, и поток экрана «<id>~screen»).
    let auth = crate::livekit::token_session(ev["participant"]["metadata"].as_str().unwrap_or(""));
    if ev["event"].as_str() == Some("participant_joined") && auth > 0 {
        let alive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1)").bind(auth).fetch_one(&st.db).await.unwrap_or(true);
        if !alive {
            let identity = ev["participant"]["identity"].as_str().unwrap_or("").to_string();
            println!("webhook: вход с завершённого сеанса {auth} ({identity}) — выкидываем");
            if let Some(lk) = st.lk.clone() {
                tokio::spawn(async move { lk.remove_identity(ch, &identity).await });
            }
            return StatusCode::OK;
        }
    }
    match (ev["event"].as_str().unwrap_or(""), user) {
        ("participant_joined", Some(u)) => match voice_allowed(&st, u, ch).await {
            Some((guild, c)) => {
                let suppress = c.kind == "stage" && !stage_mod(c.perms);
                st.hub.voice_joined(&st.db, u, guild, ch, sid, suppress, auth).await;
                crate::metrics::M.voice_joins.inc();
                // Звонок в ЛС начат (в комнате только он) — звоним остальным участникам переписки.
                if (c.kind == "dm" || c.kind == "group_dm") && st.hub.voice_members(ch) == vec![u] {
                    let others: Vec<i64> = sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id=$1 AND user_id<>$2")
                        .bind(ch)
                        .bind(u)
                        .fetch_all(&st.db)
                        .await
                        .unwrap_or_default();
                    st.hub.send(&others, &json!({ "type": "call_ring", "channel_id": ch, "user_id": u }));
                }
                // Кик мог пройти между проверкой и записью состояния: он удаляет членство в БД
                // раньше, чем снимает голос. Повторная проверка после записи закрывает это окно.
                if voice_allowed(&st, u, ch).await.is_none() {
                    println!("webhook: доступ пропал после записи user={u} ch={ch}");
                    kick_from_livekit(&st, st.hub.evict_voice(&st.db, |vu, _, vc| vu == u && vc == ch).await);
                }
            }
            None => {
                println!("webhook: joined без доступа user={u} ch={ch}");
                kick_from_livekit(&st, vec![(u, ch)])
            }
        },
        ("participant_left", Some(u)) => {
            st.hub.voice_left(&st.db, u, ch, sid).await;
            // Вышел из голоса — его поток экрана (Relay Desktop) тоже снимаем.
            if st.hub.voice_of(u).map(|(_, c)| c) != Some(ch) {
                if let Some(lk) = st.lk.clone() {
                    tokio::spawn(async move { lk.remove_identity(ch, &crate::livekit::screen_identity(u)).await });
                }
            }
        }
        ("room_finished", _) => {
            st.hub.evict_voice(&st.db, |_, _, vc| vc == ch).await;
        }
        _ => {}
    }
    StatusCode::OK
}

// ---------- роли ----------
#[derive(Deserialize)]
pub struct RoleBody {
    name: Option<String>,
    color: Option<i64>,
    permissions: Option<u64>,
    hoist: Option<bool>,
    mentionable: Option<bool>,
}

struct RoleRow {
    guild: i64,
    position: i64,
    permissions: perms::Perms,
    is_default: bool,
}

async fn load_role(db: &db::Db, id: i64) -> Result<RoleRow, ApiError> {
    let r: (i64, i64, i64, bool) =
        sqlx::query_as("SELECT guild_id, position, permissions, is_default FROM roles WHERE id=$1").bind(id).fetch_optional(db).await?.ok_or_else(not_found)?;
    Ok(RoleRow { guild: r.0, position: r.1, permissions: r.2 as perms::Perms, is_default: r.3 })
}

fn check_color(c: i64) -> Result<i32, ApiError> {
    if (0..=0xFF_FFFF).contains(&c) {
        Ok(c as i32)
    } else {
        Err(bad("Цвет: 0x000000–0xFFFFFF"))
    }
}

/// Нельзя выдать или забрать право, которого нет у себя (кроме владельца/администратора).
fn check_grant(me: &db::GuildCtx, old: perms::Perms, new: perms::Perms) -> Result<(), ApiError> {
    if new & !perms::ALL != 0 {
        return Err(bad("Неизвестные права"));
    }
    let changed = old ^ new;
    if changed & !me.base() != 0 {
        return Err(ApiError(StatusCode::FORBIDDEN, "Нельзя менять права, которых нет у вас".into()));
    }
    Ok(())
}

pub async fn create_role(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<RoleBody>) -> R {
    let me = ctx(&st.db, g, uid).await?;
    need(me.can(perms::MANAGE_ROLES))?;
    let name = clean_name(b.name.as_deref().unwrap_or("новая роль"), 64)?;
    let p = b.permissions.unwrap_or(0);
    check_grant(&me, 0, p)?;
    let color = check_color(b.color.unwrap_or(0))?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles WHERE guild_id=$1").bind(g).fetch_one(&st.db).await?;
    if count >= 250 {
        return Err(bad("Слишком много ролей (макс. 250)"));
    }
    let mut tx = st.db.begin().await?;
    // Новая роль — сразу над @everyone (позиция 1), остальные сдвигаются вверх.
    sqlx::query("UPDATE roles SET position = position + 1 WHERE guild_id=$1 AND NOT is_default").bind(g).execute(&mut *tx).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO roles(guild_id, name, color, position, permissions, hoist, mentionable, created_at)
         VALUES($1, $2, $3, 1, $4, $5, $6, $7) RETURNING id",
    )
    .bind(g)
    .bind(&name)
    .bind(color)
    .bind(p as i64)
    .bind(b.hoist.unwrap_or(false))
    .bind(b.mentionable.unwrap_or(false))
    .bind(now())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    guild_refresh(&st, g).await?;
    Ok(Json(db::role_json(&st.db, id).await?))
}

pub async fn update_role(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<RoleBody>) -> R {
    let r = load_role(&st.db, id).await?;
    let me = ctx(&st.db, r.guild, uid).await?;
    need(perms::can_manage_role(&me.member(), r.position) && (r.is_default || r.position < perms::top_position(&me.member())))?;
    if r.is_default && b.name.is_some() {
        return Err(bad("@everyone нельзя переименовать"));
    }
    let name = b.name.as_deref().map(|n| clean_name(n, 64)).transpose()?;
    if let Some(p) = b.permissions {
        check_grant(&me, r.permissions, p)?;
    }
    let color = b.color.map(check_color).transpose()?;
    sqlx::query(
        "UPDATE roles SET name=COALESCE($1, name), color=COALESCE($2, color), permissions=COALESCE($3, permissions),
           hoist=COALESCE($4, hoist), mentionable=COALESCE($5, mentionable) WHERE id=$6",
    )
    .bind(name)
    .bind(color)
    .bind(b.permissions.map(|p| p as i64))
    .bind(b.hoist)
    .bind(b.mentionable)
    .bind(id)
    .execute(&st.db)
    .await?;
    guild_refresh(&st, r.guild).await?;
    if b.permissions.is_some() {
        revalidate_voice_guild(&st, r.guild).await;
    }
    Ok(Json(db::role_json(&st.db, id).await?))
}

pub async fn delete_role(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let r = load_role(&st.db, id).await?;
    if r.is_default {
        return Err(bad("@everyone удалить нельзя"));
    }
    let me = ctx(&st.db, r.guild, uid).await?;
    need(perms::can_manage_role(&me.member(), r.position))?;
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM roles WHERE id=$1").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM permission_overwrites WHERE target_kind=0 AND target_id=$1").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE roles SET position = position - 1 WHERE guild_id=$1 AND position > $2 AND NOT is_default")
        .bind(r.guild)
        .bind(r.position)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    guild_refresh(&st, r.guild).await?;
    revalidate_voice_guild(&st, r.guild).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RoleOrder {
    ids: Vec<i64>,
}

/// Новый порядок ролей (без @everyone) снизу вверх. Роли не ниже своей высшей двигать нельзя.
pub async fn order_roles(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<RoleOrder>) -> R {
    let me = ctx(&st.db, g, uid).await?;
    need(me.can(perms::MANAGE_ROLES))?;
    let current: Vec<(i64, i64)> = sqlx::query_as("SELECT id, position FROM roles WHERE guild_id=$1 AND NOT is_default").bind(g).fetch_all(&st.db).await?;
    let mut a: Vec<i64> = current.iter().map(|r| r.0).collect();
    let mut bb = b.ids.clone();
    a.sort_unstable();
    bb.sort_unstable();
    if a != bb {
        return Err(bad("Нужен полный список ролей сервера"));
    }
    let top = perms::top_position(&me.member());
    for (i, id) in b.ids.iter().enumerate() {
        let new_pos = i as i64 + 1;
        let old_pos = current.iter().find(|r| r.0 == *id).map(|r| r.1).unwrap_or(0);
        // Чужие (не ниже своей) роли остаются на месте; свои нельзя поднять до своей высшей.
        if !me.is_owner() && (old_pos >= top || new_pos >= top) && old_pos != new_pos {
            return Err(forbidden());
        }
    }
    let mut tx = st.db.begin().await?;
    for (i, id) in b.ids.iter().enumerate() {
        sqlx::query("UPDATE roles SET position=$1 WHERE id=$2").bind(i as i64 + 1).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    guild_refresh(&st, g).await?;
    Ok(Json(Value::Array(db::guild_roles_json(&st.db, g).await?)))
}

async fn member_role_change(st: &AppState, uid: i64, g: i64, target: i64, role: i64, add: bool) -> R {
    let r = load_role(&st.db, role).await?;
    if r.guild != g || r.is_default {
        return Err(not_found());
    }
    let me = ctx(&st.db, g, uid).await?;
    need(perms::can_manage_role(&me.member(), r.position))?;
    ctx(&st.db, g, target).await?; // цель — участник сервера
    if add {
        sqlx::query("INSERT INTO member_roles(guild_id, user_id, role_id) VALUES($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(g)
            .bind(target)
            .bind(role)
            .execute(&st.db)
            .await?;
    } else {
        sqlx::query("DELETE FROM member_roles WHERE guild_id=$1 AND user_id=$2 AND role_id=$3").bind(g).bind(target).bind(role).execute(&st.db).await?;
    }
    guild_refresh(st, g).await?;
    // Права участника изменились — голос мог стать недоступен.
    revalidate_voice(st, target).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn add_member_role(State(st): State<AppState>, Auth(uid): Auth, Path((g, target, role)): Path<(i64, i64, i64)>) -> R {
    member_role_change(&st, uid, g, target, role, true).await
}
pub async fn remove_member_role(State(st): State<AppState>, Auth(uid): Auth, Path((g, target, role)): Path<(i64, i64, i64)>) -> R {
    member_role_change(&st, uid, g, target, role, false).await
}

#[derive(Deserialize)]
pub struct MemberPatch {
    nick: Option<String>,
}

pub async fn update_member(State(st): State<AppState>, Auth(uid): Auth, Path((g, target)): Path<(i64, i64)>, Json(b): Json<MemberPatch>) -> R {
    let me = ctx(&st.db, g, uid).await?;
    if target == uid {
        need(me.can(perms::CHANGE_NICKNAME) || me.can(perms::MANAGE_NICKNAMES))?;
    } else {
        let t = ctx(&st.db, g, target).await?;
        need(me.can(perms::MANAGE_NICKNAMES) && perms::can_act_on(&me.member(), &t.member()))?;
    }
    let nick = b.nick.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if nick.as_ref().is_some_and(|n| n.chars().count() > 32) {
        return Err(bad("Ник: до 32 символов"));
    }
    sqlx::query("UPDATE members SET nick=$1 WHERE guild_id=$2 AND user_id=$3").bind(&nick).bind(g).bind(target).execute(&st.db).await?;
    guild_refresh(&st, g).await?;
    Ok(Json(json!({ "nick": nick })))
}

// ---------- права каналов (overwrites) ----------
#[derive(Deserialize)]
pub struct OverwriteBody {
    allow: u64,
    deny: u64,
}

fn target_kind(kind: &str) -> Result<i16, ApiError> {
    match kind {
        "role" => Ok(0),
        "member" => Ok(1),
        _ => Err(bad("Цель: role или member")),
    }
}

async fn current_overwrite(db: &db::Db, ch: i64, k: i16, target: i64) -> Result<(u64, u64), ApiError> {
    let old: Option<(i64, i64)> = sqlx::query_as("SELECT allow, deny FROM permission_overwrites WHERE channel_id=$1 AND target_kind=$2 AND target_id=$3")
        .bind(ch)
        .bind(k)
        .bind(target)
        .fetch_optional(db)
        .await?;
    Ok(old.map(|(a, d)| (a as u64, d as u64)).unwrap_or((0, 0)))
}

/// Менять (в т.ч. удалять) можно только те права, которые есть у себя в этом канале.
fn check_overwrite_delta(me: &db::GuildCtx, c: &db::Channel, changed: perms::Perms) -> Result<(), ApiError> {
    if me.is_owner() || perms::has(me.base(), perms::ADMINISTRATOR) || changed & !c.perms == 0 {
        return Ok(());
    }
    Err(ApiError(StatusCode::FORBIDDEN, "Нельзя менять права, которых нет у вас в этом канале".into()))
}

/// Управлять правами канала: MANAGE_ROLES (в канале). Менять можно только права, которые есть у себя в этом канале.
async fn overwrite_guard(st: &AppState, ch: i64, uid: i64, kind: i16, target: i64) -> Result<(db::Channel, db::GuildCtx), ApiError> {
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    let g = c.guild_id.ok_or_else(forbidden)?;
    let me = ctx(&st.db, g, uid).await?;
    need(perms::has(c.perms, perms::MANAGE_ROLES))?;
    if kind == 0 {
        let r = load_role(&st.db, target).await?;
        if r.guild != g {
            return Err(not_found());
        }
        need(r.is_default || perms::can_manage_role(&me.member(), r.position))?;
    } else {
        ctx(&st.db, g, target).await?;
    }
    Ok((c, me))
}

pub async fn put_overwrite(State(st): State<AppState>, Auth(uid): Auth, Path((ch, kind, target)): Path<(i64, String, i64)>, Json(b): Json<OverwriteBody>) -> R {
    let k = target_kind(&kind)?;
    let (c, me) = overwrite_guard(&st, ch, uid, k, target).await?;
    if b.allow & b.deny != 0 {
        return Err(bad("Одно право не может быть одновременно разрешено и запрещено"));
    }
    if (b.allow | b.deny) & !perms::ALL != 0 {
        return Err(bad("Неизвестные права"));
    }
    let (oa, od) = current_overwrite(&st.db, ch, k, target).await?;
    check_overwrite_delta(&me, &c, (oa ^ b.allow) | (od ^ b.deny))?;
    sqlx::query(
        "INSERT INTO permission_overwrites(channel_id, target_kind, target_id, allow, deny) VALUES($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, target_kind, target_id) DO UPDATE SET allow=EXCLUDED.allow, deny=EXCLUDED.deny",
    )
    .bind(ch)
    .bind(k)
    .bind(target)
    .bind(b.allow as i64)
    .bind(b.deny as i64)
    .execute(&st.db)
    .await?;
    let g = c.guild_id.unwrap_or(0);
    guild_refresh(&st, g).await?;
    revalidate_voice_channel(&st, ch).await;
    Ok(Json(json!({ "allow": b.allow, "deny": b.deny })))
}

pub async fn delete_overwrite(State(st): State<AppState>, Auth(uid): Auth, Path((ch, kind, target)): Path<(i64, String, i64)>) -> R {
    let k = target_kind(&kind)?;
    let (c, me) = overwrite_guard(&st, ch, uid, k, target).await?;
    // Удаление — это тоже изменение allow/deny (до нуля): те же правила, что у PUT.
    let (oa, od) = current_overwrite(&st.db, ch, k, target).await?;
    check_overwrite_delta(&me, &c, oa | od)?;
    sqlx::query("DELETE FROM permission_overwrites WHERE channel_id=$1 AND target_kind=$2 AND target_id=$3")
        .bind(ch)
        .bind(k)
        .bind(target)
        .execute(&st.db)
        .await?;
    guild_refresh(&st, c.guild_id.unwrap_or(0)).await?;
    revalidate_voice_channel(&st, ch).await;
    Ok(Json(json!({ "ok": true })))
}

/// Права канала для редактора: список overwrites (видно тем, кто может ими управлять).
pub async fn list_overwrites(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>) -> R {
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    need(c.guild_id.is_some() && perms::has(c.perms, perms::MANAGE_ROLES))?;
    let list: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('kind', CASE target_kind WHEN 0 THEN 'role' ELSE 'member' END, 'id', target_id, 'allow', allow, 'deny', deny)
         FROM permission_overwrites WHERE channel_id=$1",
    )
    .bind(ch)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(Value::Array(list)))
}

#[derive(Deserialize)]
pub struct ChannelPos {
    id: i64,
    position: i64,
    parent_id: Option<i64>,
}

/// Порядок и категории каналов: MANAGE_CHANNELS.
pub async fn order_channels(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(list): Json<Vec<ChannelPos>>) -> R {
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_CHANNELS))?;
    let kinds: std::collections::HashMap<i64, String> =
        sqlx::query_as::<_, (i64, String)>("SELECT id, kind FROM channels WHERE guild_id=$1").bind(g).fetch_all(&st.db).await?.into_iter().collect();
    for c in &list {
        let kind = kinds.get(&c.id).ok_or_else(|| bad("Канал не из этого сервера"))?;
        if let Some(p) = c.parent_id.filter(|p| *p > 0) {
            if kind == "category" || kinds.get(&p).map(String::as_str) != Some("category") {
                return Err(bad("Некорректная категория"));
            }
        }
    }
    let mut tx = st.db.begin().await?;
    for c in &list {
        sqlx::query("UPDATE channels SET position=$1, parent_id=$2 WHERE id=$3")
            .bind(c.position)
            .bind(c.parent_id.filter(|p| *p > 0))
            .bind(c.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    guild_refresh(&st, g).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- голос после смены прав ----------
/// Привести голос пользователя к его текущим правам: без VIEW/CONNECT — выкинуть из комнаты,
/// иначе синхронизировать право публикации микрофона (SPEAK) в LiveKit.
///
/// Все синхронизации идут последовательно под `voice_sync`, а права читаются из БД уже под блокировкой:
/// поэтому последний вызов всегда применяет актуальное состояние, и устаревший canPublish=true
/// не может прийти в LiveKit после нового canPublish=false.
async fn revalidate_voice(st: &AppState, user: i64) {
    let _order = st.voice_sync.lock().await;
    let Some((_, ch)) = st.hub.voice_of(user) else { return };
    match db::accessible_channel(&st.db, ch, user).await.ok().flatten().filter(|c| perms::has(c.perms, perms::CONNECT)) {
        None => {
            let evicted = st.hub.evict_voice(&st.db, |u, _, vc| u == user && vc == ch).await;
            if let Some(lk) = st.lk.clone() {
                for (u, c) in evicted {
                    lk.remove_participant(c, u).await;
                }
            }
        }
        Some(c) => {
            if let Some(lk) = st.lk.clone() {
                let sources = publish_sources(c.perms, &c.kind, st.hub.voice_suppressed(user));
                lk.set_can_publish(ch, user, &sources).await;
                // Пропало право на экран — нативный поток экрана снимаем с эфира.
                if !sources.contains(&"screen_share") {
                    lk.remove_identity(ch, &crate::livekit::screen_identity(user)).await;
                }
            }
        }
    }
}

/// После изменения роли (в т.ч. @everyone) — все, кто в голосе на этом сервере.
async fn revalidate_voice_guild(st: &AppState, guild: i64) {
    for user in st.hub.voice_users_in_guild(guild) {
        revalidate_voice(st, user).await;
    }
}

async fn revalidate_voice_channel(st: &AppState, ch: i64) {
    for user in st.hub.voice_members(ch) {
        revalidate_voice(st, user).await;
    }
}

// ---------- «посмотреть сервер как роль» ----------
#[derive(Deserialize)]
pub struct ViewAs {
    roles: String,
}

/// Права и видимые каналы для набора ролей (как у участника с этими ролями). Нужно MANAGE_ROLES.
pub async fn view_as(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Query(q): Query<ViewAs>) -> R {
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_ROLES))?;
    let wanted: Vec<i64> = q.roles.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    let (everyone, roles, _) = db::guild_roles_and_members(&st.db, g).await?;
    let picked: Vec<perms::Role> = wanted.iter().filter_map(|id| roles.get(id).copied()).collect();
    // user_id = 0: личные overwrites не применяются — видим ровно то, что дают роли.
    let m = perms::Member { user_id: 0, is_owner: false, everyone, roles: &picked };
    let ows = db::guild_overwrites(&st.db, g).await?;
    let kinds: Vec<(i64, String)> = sqlx::query_as("SELECT id, kind FROM channels WHERE guild_id=$1").bind(g).fetch_all(&st.db).await?;
    let channels: Vec<Value> = kinds
        .into_iter()
        .map(|(id, kind)| json!({ "id": id, "permissions": perms::channel(&m, ows.get(&id).map(Vec::as_slice).unwrap_or(&[]), &kind) }))
        .collect();
    Ok(Json(json!({ "permissions": perms::base(&m), "channels": channels })))
}

// ---------- перенос и отключение участников в голосе (MOVE_MEMBERS) ----------
#[derive(Deserialize)]
pub struct VoiceMove {
    user_id: i64,
    channel_id: Option<i64>,
}

/// Перенести участника в другой голосовой канал сервера (channel_id) или отключить от голоса (null).
/// Нужно MOVE_MEMBERS в исходном и целевом канале; переносимый должен иметь CONNECT в целевом.
/// Переносимому уходит VOICE_MOVE с готовым токеном (лимит участников при переносе не действует, как в Discord);
/// если клиент не перешёл за 3 с — сервер сам выкидывает его из старой комнаты.
pub async fn voice_move(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<VoiceMove>) -> R {
    let lk = st.lk.clone().ok_or_else(|| ApiError(StatusCode::SERVICE_UNAVAILABLE, "Голос не настроен на сервере".into()))?;
    let (vg, from) = st.hub.voice_of(b.user_id).ok_or_else(|| bad("Участник не в голосовом канале"))?;
    if vg != g {
        return Err(not_found());
    }
    let src = db::accessible_channel(&st.db, from, uid).await?.ok_or_else(not_found)?;
    need(perms::has(src.perms, perms::MOVE_MEMBERS))?;
    println!("voice_move: by={uid} user={} from={from} to={:?}", b.user_id, b.channel_id);
    let Some(to) = b.channel_id else {
        kick_from_livekit(&st, st.hub.evict_voice(&st.db, |u, _, vc| u == b.user_id && vc == from).await);
        return Ok(Json(json!({ "ok": true })));
    };
    if to == from {
        return Ok(Json(json!({ "ok": true })));
    }
    let dst = db::accessible_channel(&st.db, to, uid).await?.ok_or_else(not_found)?;
    if (dst.kind != "voice" && dst.kind != "stage") || dst.guild_id != Some(g) {
        return Err(bad("Перенести можно только в голосовой канал этого сервера"));
    }
    need(perms::has(dst.perms, perms::MOVE_MEMBERS))?;
    let target = db::accessible_channel(&st.db, to, b.user_id)
        .await?
        .filter(|c| perms::has(c.perms, perms::CONNECT))
        .ok_or_else(|| ApiError(StatusCode::FORBIDDEN, "У участника нет доступа к этому каналу".into()))?;
    let bitrate: i64 = sqlx::query_scalar("SELECT bitrate FROM channels WHERE id=$1").bind(to).fetch_one(&st.db).await?;
    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1").bind(b.user_id).fetch_one(&st.db).await?;
    // перенос — тот же сеанс, с которого он сейчас в голосе
    let token = lk.join_token(
        b.user_id,
        &name,
        to,
        &publish_sources(target.perms, &target.kind, target.kind == "stage" && !stage_mod(target.perms)),
        st.hub.voice_auth(b.user_id).unwrap_or(0),
    );
    st.hub.send(
        &[b.user_id],
        &json!({
            "type": "voice_move", "channel": db::channel_json(&st.db, to).await?, "token": token, "url": lk.public_url, "bitrate": bitrate, "by": uid,
        }),
    );
    let st2 = st.clone();
    let user = b.user_id;
    // Выкидываем только ту же сессию, которая так и не вышла: если пользователь успел уйти и вернуться
    // (новый sid — например, его перенесли обратно), старый таймер его не трогает.
    let session = st.hub.voice_session(user);
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if session.is_some() && st2.hub.voice_session(user) == session {
            println!("voice_move: user={user} не перешёл из {from} за 3 с — выкидываем");
            kick_from_livekit(&st2, st2.hub.evict_voice(&st2.db, |u, _, vc| u == user && vc == from).await);
        }
    });
    Ok(Json(json!({ "ok": true })))
}

// ---------- массовое удаление ----------
#[derive(Deserialize)]
pub struct BulkDelete {
    ids: Vec<i64>,
}

/// Удалить до 100 сообщений канала разом: MANAGE_MESSAGES.
pub async fn bulk_delete(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>, Json(b): Json<BulkDelete>) -> R {
    if b.ids.is_empty() || b.ids.len() > 100 {
        return Err(bad("От 1 до 100 сообщений"));
    }
    let c = db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    need(perms::has(c.perms, perms::MANAGE_MESSAGES))?;
    let deleted: Vec<i64> =
        sqlx::query_scalar("DELETE FROM messages WHERE channel_id=$1 AND id = ANY($2) RETURNING id").bind(ch).bind(&b.ids).fetch_all(&st.db).await?;
    if !deleted.is_empty() {
        st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "message_delete_bulk", "channel_id": ch, "ids": deleted }));
    }
    Ok(Json(json!({ "deleted": deleted.len() })))
}

// ---------- непрочитанное, «Входящие», настройки уведомлений (фаза 3b) ----------
/// Кому из получателей это сообщение — «упоминание» (растит счётчик): прямое упоминание, роль, @everyone
/// (кроме отключивших его на сервере), ответ на их сообщение; в ЛС — любое сообщение. Автор сразу «прочитал».
#[allow(clippy::too_many_arguments)]
async fn count_mentions(
    st: &AppState,
    c: &db::Channel,
    msg: i64,
    author: i64,
    audience: &[i64],
    users: &[i64],
    roles: &[i64],
    everyone: bool,
    reply_to: Option<i64>,
) -> Result<(), ApiError> {
    let mut targets: Vec<i64> = vec![];
    if c.guild_id.is_none() {
        targets.extend(audience.iter().copied());
    } else {
        targets.extend(users.iter().copied());
        if !roles.is_empty() {
            let holders: Vec<i64> =
                sqlx::query_scalar("SELECT DISTINCT user_id FROM member_roles WHERE role_id = ANY($1)").bind(roles).fetch_all(&st.db).await?;
            targets.extend(holders);
        }
        if everyone {
            let suppressed: Vec<i64> = sqlx::query_scalar("SELECT user_id FROM notification_settings WHERE guild_id=$1 AND suppress_everyone")
                .bind(c.guild_id)
                .fetch_all(&st.db)
                .await?;
            targets.extend(audience.iter().copied().filter(|u| !suppressed.contains(u)));
        }
        if let Some(r) = reply_to {
            if let Some(a) =
                sqlx::query_scalar::<_, i64>("SELECT author_id FROM messages WHERE id=$1 AND channel_id=$2").bind(r).bind(c.id).fetch_optional(&st.db).await?
            {
                targets.push(a);
            }
        }
    }
    targets.retain(|u| *u != author && audience.contains(u));
    targets.sort_unstable();
    targets.dedup();
    if !targets.is_empty() {
        sqlx::query(
            "INSERT INTO read_states(user_id, channel_id, mention_count) SELECT unnest($1::bigint[]), $2, 1
                     ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1",
        )
        .bind(&targets)
        .bind(c.id)
        .execute(&st.db)
        .await?;
    }
    sqlx::query(
        "INSERT INTO read_states(user_id, channel_id, last_read_id) VALUES($1, $2, $3)
                 ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id), mention_count = 0",
    )
    .bind(author)
    .bind(c.id)
    .bind(msg)
    .execute(&st.db)
    .await?;
    Ok(())
}

/// Состояния прочтения по всем видимым каналам: последнее прочитанное, упоминания, последнее сообщение.
async fn read_states(st: &AppState, uid: i64) -> Result<Vec<Value>, ApiError> {
    let vis = db::visible_channels(&st.db, uid).await?;
    let ids: Vec<i64> = vis.iter().map(|(c, _)| *c).collect();
    let rows: Vec<(i64, i64, i32, Option<i64>)> = sqlx::query_as(
        "SELECT c.id, COALESCE(rs.last_read_id, 0), COALESCE(rs.mention_count, 0), (SELECT MAX(id) FROM messages WHERE channel_id = c.id)
         FROM unnest($2::bigint[]) AS c(id) LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1",
    )
    .bind(uid)
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(ch, last_read, mentions, last_msg)| {
            let guild = vis.iter().find(|(c, _)| *c == ch).and_then(|(_, g)| *g);
            json!({ "channel_id": ch, "guild_id": guild, "last_read_id": last_read, "mention_count": mentions, "last_message_id": last_msg.unwrap_or(0) })
        })
        .collect())
}

#[derive(Deserialize)]
pub struct Ack {
    message_id: i64,
}

/// Прочитано до message_id включительно: счётчик упоминаний сбрасывается; другие вкладки узнают через MESSAGE_ACK.
pub async fn ack(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>, Json(b): Json<Ack>) -> R {
    db::accessible_channel(&st.db, ch, uid).await?.ok_or_else(not_found)?;
    let last: i64 = sqlx::query_scalar(
        "INSERT INTO read_states(user_id, channel_id, last_read_id) VALUES($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id), mention_count = 0
         RETURNING last_read_id",
    )
    .bind(uid)
    .bind(ch)
    .bind(b.message_id)
    .fetch_one(&st.db)
    .await?;
    st.hub.send(&[uid], &json!({ "type": "message_ack", "channel_id": ch, "last_read_id": last }));
    Ok(Json(json!({ "last_read_id": last })))
}

#[derive(Deserialize)]
pub struct InboxQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

/// «Входящие»: упоминания меня (лично, ролью, @everyone) и ответы на мои сообщения — только в видимых каналах.
pub async fn inbox(State(st): State<AppState>, Auth(uid): Auth, Query(q): Query<InboxQuery>) -> R {
    let vis = db::visible_channels(&st.db, uid).await?;
    let chans: Vec<i64> = vis.iter().map(|(c, _)| *c).collect();
    let roles: Vec<i64> = sqlx::query_scalar("SELECT role_id FROM member_roles WHERE user_id=$1").bind(uid).fetch_all(&st.db).await?;
    let limit = q.limit.unwrap_or(25).clamp(1, 50);
    let ids: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT m.id, m.channel_id FROM messages m
         WHERE m.channel_id = ANY($2) AND m.author_id <> $1 AND m.id < $4 AND (
           $1 = ANY(m.mentions) OR m.mention_roles && $3 OR m.mention_everyone
           OR EXISTS (SELECT 1 FROM messages p WHERE p.id = m.reply_to AND p.author_id = $1)
         ) ORDER BY m.id DESC LIMIT $5",
    )
    .bind(uid)
    .bind(&chans)
    .bind(&roles)
    .bind(q.before.unwrap_or(i64::MAX))
    .bind(limit)
    .fetch_all(&st.db)
    .await?;
    let mut out = vec![];
    for (id, ch) in ids {
        let info: (String, Option<i64>, Option<String>) =
            sqlx::query_as("SELECT c.name, c.guild_id, g.name FROM channels c LEFT JOIN guilds g ON g.id=c.guild_id WHERE c.id=$1")
                .bind(ch)
                .fetch_one(&st.db)
                .await?;
        out.push(json!({ "message": db::message_json(&st.db, id).await?, "channel_name": info.0, "guild_id": info.1, "guild_name": info.2 }));
    }
    Ok(Json(Value::Array(out)))
}

async fn notification_settings_json(st: &AppState, uid: i64) -> Result<Vec<Value>, ApiError> {
    Ok(sqlx::query_scalar(
        "SELECT json_build_object('guild_id', guild_id, 'channel_id', channel_id, 'level', level, 'muted_until', muted_until, 'suppress_everyone', suppress_everyone)
         FROM notification_settings WHERE user_id=$1",
    )
    .bind(uid).fetch_all(&st.db).await?)
}

#[derive(Deserialize)]
pub struct NotifyBody {
    guild_id: Option<i64>,
    channel_id: Option<i64>,
    level: i16,
    muted_until: Option<i64>,
    #[serde(default)]
    suppress_everyone: bool,
}

/// Настройки уведомлений для сервера или канала (одно из двух).
pub async fn put_notification_settings(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<NotifyBody>) -> R {
    if !(-1..=2).contains(&b.level) {
        return Err(bad("Уровень: 0 — все, 1 — упоминания, 2 — ничего, -1 — сбросить"));
    }
    match (b.guild_id, b.channel_id) {
        // -1: убрать настройку (канал снова следует настройкам сервера, сервер — значениям по умолчанию)
        (Some(g), None) if b.level == -1 => {
            sqlx::query("DELETE FROM notification_settings WHERE user_id=$1 AND guild_id=$2").bind(uid).bind(g).execute(&st.db).await?;
        }
        (None, Some(c)) if b.level == -1 => {
            sqlx::query("DELETE FROM notification_settings WHERE user_id=$1 AND channel_id=$2").bind(uid).bind(c).execute(&st.db).await?;
        }
        (Some(g), None) => {
            ctx(&st.db, g, uid).await?;
            sqlx::query("INSERT INTO notification_settings(user_id, guild_id, level, muted_until, suppress_everyone) VALUES($1, $2, $3, $4, $5)
                         ON CONFLICT (user_id, guild_id) WHERE guild_id IS NOT NULL DO UPDATE SET level=EXCLUDED.level, muted_until=EXCLUDED.muted_until, suppress_everyone=EXCLUDED.suppress_everyone")
                .bind(uid).bind(g).bind(b.level).bind(b.muted_until).bind(b.suppress_everyone).execute(&st.db).await?;
        }
        (None, Some(c)) => {
            db::accessible_channel(&st.db, c, uid).await?.ok_or_else(not_found)?;
            sqlx::query(
                "INSERT INTO notification_settings(user_id, channel_id, level, muted_until) VALUES($1, $2, $3, $4)
                         ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET level=EXCLUDED.level, muted_until=EXCLUDED.muted_until",
            )
            .bind(uid)
            .bind(c)
            .bind(b.level)
            .bind(b.muted_until)
            .execute(&st.db)
            .await?;
        }
        _ => return Err(bad("Укажите guild_id или channel_id")),
    }
    let list = notification_settings_json(&st, uid).await?;
    st.hub.send(&[uid], &json!({ "type": "notification_settings", "settings": list }));
    Ok(Json(Value::Array(list)))
}

/// «Отметить сервер прочитанным»: все видимые каналы сервера — до последнего сообщения.
pub async fn ack_guild(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>) -> R {
    ctx(&st.db, g, uid).await?;
    let chans: Vec<i64> = db::visible_channels(&st.db, uid).await?.into_iter().filter(|(_, x)| *x == Some(g)).map(|(c, _)| c).collect();
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "INSERT INTO read_states(user_id, channel_id, last_read_id)
         SELECT $1, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = c.id), 0) FROM unnest($2::bigint[]) AS c(id)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id), mention_count = 0
         RETURNING channel_id, last_read_id",
    )
    .bind(uid)
    .bind(&chans)
    .fetch_all(&st.db)
    .await?;
    for (ch, last) in &rows {
        st.hub.send(&[uid], &json!({ "type": "message_ack", "channel_id": ch, "last_read_id": last }));
    }
    Ok(Json(json!({ "channels": rows.len() })))
}

// ---------- поиск (фаза 3c) ----------
#[derive(Deserialize)]
pub struct SearchParams {
    q: String,
    guild_id: Option<i64>,
    channel_id: Option<i64>,
    sort: Option<String>,
    offset: Option<i64>,
    tz: Option<i64>,
}

const SEARCH_PAGE: i64 = 25;

/// Поиск сообщений в видимых каналах сервера (guild_id), в одной переписке (channel_id) или во всех ЛС.
pub async fn search(State(st): State<AppState>, Auth(uid): Auth, Query(p): Query<SearchParams>) -> R {
    use crate::search::{day_start_ms, parse, Has};
    let q = parse(&p.q).map_err(|e| bad(&e))?;
    if q.is_empty() {
        return Err(bad("Пустой запрос"));
    }
    let empty = || Ok(Json(json!({ "total": 0, "results": [], "terms": q.words })));
    let vis = db::visible_channels(&st.db, uid).await?;
    let mut scope: Vec<i64> = vis
        .iter()
        .filter(|(c, g)| match (p.guild_id, p.channel_id) {
            (Some(gid), _) => *g == Some(gid),
            (None, Some(ch)) => *c == ch,
            (None, None) => g.is_none(),
        })
        .map(|(c, _)| *c)
        .collect();
    if !q.channels.is_empty() {
        let names: Vec<String> = q.channels.iter().map(|x| x.to_lowercase()).collect();
        scope = sqlx::query_scalar("SELECT id FROM channels WHERE id = ANY($1) AND lower(name) = ANY($2)").bind(&scope).bind(&names).fetch_all(&st.db).await?;
    }
    if scope.is_empty() {
        return empty();
    }
    // Имена → id: логин, отображаемое имя или ник на этом сервере.
    let resolve = |names: &[String]| {
        let names: Vec<String> = names.iter().map(|x| x.to_lowercase()).collect();
        let db = st.db.clone();
        let g = p.guild_id;
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT DISTINCT u.id FROM users u LEFT JOIN members mb ON mb.user_id = u.id AND mb.guild_id = $2
                 WHERE lower(u.username) = ANY($1) OR lower(u.display_name) = ANY($1) OR lower(mb.nick) = ANY($1)",
            )
            .bind(names)
            .bind(g)
            .fetch_all(&db)
            .await
        }
    };
    let from = if q.from.is_empty() { vec![] } else { resolve(&q.from).await? };
    if !q.from.is_empty() && from.is_empty() {
        return empty();
    }
    let mentioned = if q.mentions.is_empty() { vec![] } else { resolve(&q.mentions).await? };
    if !q.mentions.is_empty() && mentioned.is_empty() {
        return empty();
    }
    let tz = p.tz.unwrap_or(0).clamp(-840, 840);
    let ts = q.tsquery();

    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new("SELECT m.id, COUNT(*) OVER() FROM messages m WHERE m.channel_id = ANY(");
    qb.push_bind(scope).push(")");
    if let Some(ts) = &ts {
        qb.push(" AND m.search @@ to_tsquery('russian', ").push_bind(ts.clone()).push(")");
    }
    if !from.is_empty() {
        qb.push(" AND m.author_id = ANY(").push_bind(from).push(")");
    }
    if !mentioned.is_empty() {
        qb.push(" AND m.mentions && ").push_bind(mentioned);
    }
    if let Some(pin) = q.pinned {
        qb.push(" AND m.pinned = ").push_bind(pin);
    }
    for h in &q.has {
        qb.push(match h {
            Has::Link => " AND m.content ~* 'https?://'",
            Has::File => " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)",
            Has::Image => " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%')",
            Has::Video => " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'video/%')",
            Has::Audio => " AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'audio/%')",
        });
    }
    const DAY: i64 = 86_400_000;
    if let Some(d) = q.before {
        qb.push(" AND m.created_at < ").push_bind(day_start_ms(d, tz));
    }
    if let Some(d) = q.after {
        qb.push(" AND m.created_at >= ").push_bind(day_start_ms(d, tz) + DAY);
    }
    if let Some(d) = q.during {
        let s = day_start_ms(d, tz);
        qb.push(" AND m.created_at >= ").push_bind(s).push(" AND m.created_at < ").push_bind(s + DAY);
    }
    match (p.sort.as_deref(), &ts) {
        (Some("old"), _) => {
            qb.push(" ORDER BY m.id ASC");
        }
        (Some("relevance"), Some(ts)) => {
            qb.push(" ORDER BY ts_rank(m.search, to_tsquery('russian', ").push_bind(ts.clone()).push(")) DESC, m.id DESC");
        }
        _ => {
            qb.push(" ORDER BY m.id DESC");
        }
    }
    qb.push(" LIMIT ").push_bind(SEARCH_PAGE).push(" OFFSET ").push_bind(p.offset.unwrap_or(0).clamp(0, 5000));
    let rows: Vec<(i64, i64)> = crate::metrics::timed("search.messages", qb.build_query_as().fetch_all(&st.db)).await?;
    let total = rows.first().map(|r| r.1).unwrap_or(0);
    let mut results = vec![];
    for (id, _) in rows {
        let msg = db::message_json(&st.db, id).await?;
        let ch = msg["channel_id"].as_i64().unwrap_or(0);
        let (name, guild): (String, Option<i64>) = sqlx::query_as("SELECT name, guild_id FROM channels WHERE id=$1").bind(ch).fetch_one(&st.db).await?;
        results.push(json!({ "message": msg, "channel_name": name, "guild_id": guild }));
    }
    Ok(Json(json!({ "total": total, "results": results, "terms": q.words })))
}

#[derive(Deserialize)]
pub struct SuppressBody {
    suppress: bool,
}

/// Убрать (или вернуть) превью ссылок: автор или MANAGE_MESSAGES.
pub async fn suppress_embeds(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<SuppressBody>) -> R {
    let (author, c) = load_message(&st.db, id, uid).await?;
    need(author == uid || perms::has(c.perms, perms::MANAGE_MESSAGES))?;
    sqlx::query("UPDATE messages SET suppress_embeds=$1 WHERE id=$2").bind(b.suppress).bind(id).execute(&st.db).await?;
    let msg = db::message_json(&st.db, id).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "message_update", "message": msg }));
    Ok(Json(msg))
}

/// Отчёт клиента о подключении голоса (тип пары ICE, транспорт, RTT/jitter/потери) — только в метрики по регионам.
pub async fn voice_report(Auth(uid): Auth, headers: HeaderMap, Json(b): Json<crate::regions::VoiceReport>) -> StatusCode {
    crate::regions::record_report(&headers, uid, &b, crate::now());
    StatusCode::NO_CONTENT
}

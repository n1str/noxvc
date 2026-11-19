//! Фаза 4: статусы присутствия, профили, учётная запись, приватность, друзья, групповые ЛС.

use crate::api::{bad, need, not_found, ApiError, Auth, R};
use crate::{db, media, mediaq, now, AppState};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub const FRIEND: i16 = 1;
pub const BLOCKED: i16 = 2;
pub const INCOMING: i16 = 3;
pub const OUTGOING: i16 = 4;
const GROUP_MAX: i64 = 10;

/// Дописать в JSON пользователя видимое присутствие: online (для старых клиентов) и presence.
pub fn present(st: &AppState, v: &mut Value) {
    let id = v["id"].as_i64().unwrap_or(0);
    let p = st.hub.presence(id);
    v["online"] = json!(p != "offline");
    v["presence"] = json!(p);
    v["activity"] = json!(st.hub.visible_activity(id));
}

/// Разослать текущее видимое присутствие тем, кто связан с пользователем.
pub async fn broadcast_presence(st: &AppState, uid: i64) {
    let p = st.hub.presence(uid);
    let mut aud = db::related_user_ids(&st.db, uid).await.unwrap_or_default();
    aud.retain(|u| *u != uid);
    st.hub.send(&aud, &json!({ "type": "presence", "user_id": uid, "online": p != "offline", "presence": p, "activity": st.hub.visible_activity(uid) }));
    // Себе — выбранный статус (невидимка видит себя «невидимкой», а не «не в сети»).
    st.hub.send(
        &[uid],
        &json!({ "type": "presence", "user_id": uid, "online": true, "presence": st.hub.chosen_presence(uid), "activity": st.hub.own_activity(uid) }),
    );
}

/// Полные данные о себе: публичное + выбранный статус и приватность.
pub async fn self_json(st: &AppState, uid: i64) -> Result<Value, ApiError> {
    let mut u = db::user_json(&st.db, uid).await?;
    let (presence, bio, pronouns, banner, privacy, banner_media, avatar_pending, banner_pending, settings, is_admin): (String, String, String, Option<String>, Value, Option<Value>, bool, bool, Value, bool) =
        sqlx::query_as("SELECT presence, bio, pronouns, banner_color, privacy, banner, avatar_job IS NOT NULL, banner_job IS NOT NULL, settings, is_admin FROM users WHERE id=$1")
            .bind(uid).fetch_one(&st.db).await?;
    u["presence"] = json!(presence);
    u["online"] = json!(true);
    u["activity"] = json!(st.hub.own_activity(uid));
    u["bio"] = json!(bio);
    u["pronouns"] = json!(pronouns);
    u["banner_color"] = json!(banner);
    u["banner"] = json!(banner_media);
    // Идёт фоновая обработка нового аватара/баннера (результат придёт user_update).
    u["avatar_pending"] = json!(avatar_pending);
    u["banner_pending"] = json!(banner_pending);
    u["features"] = json!({ "animated_profiles": mediaq::animated_enabled() });
    // Настройки аккаунта (горячие клавиши, голос, тема) — общие для всех устройств пользователя.
    u["settings"] = settings;
    // администратор инстанса (backlog обратной связи) — не роль сервера
    u["is_admin"] = json!(is_admin);
    // администратору — число ожидающих запросов на приглашение (бейдж в настройках)
    u["invite_only"] = json!(crate::invites::invite_only());
    if is_admin && crate::invites::invite_only() {
        u["invite_pending"] = json!(crate::invites::pending_count(&st.db).await);
    }
    u["feedback_unread"] =
        json!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM feedback WHERE user_id=$1 AND unread").bind(uid).fetch_one(&st.db).await.unwrap_or(0));
    u["privacy"] = json!({
        "friend_requests": privacy["friend_requests"].as_str().unwrap_or("everyone"),
        "dm_from": privacy["dm_from"].as_str().unwrap_or("everyone"),
    });
    Ok(u)
}

pub async fn rel(db: &db::Db, a: i64, b: i64) -> Result<Option<i16>, sqlx::Error> {
    sqlx::query_scalar("SELECT kind FROM relationships WHERE user_id=$1 AND other_id=$2").bind(a).bind(b).fetch_optional(db).await
}

/// Блокировка в любую сторону.
pub async fn blocked_either(db: &db::Db, a: i64, b: i64) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM relationships WHERE kind=2 AND ((user_id=$1 AND other_id=$2) OR (user_id=$2 AND other_id=$1)))")
        .bind(a)
        .bind(b)
        .fetch_one(db)
        .await
}

async fn share_guild(db: &db::Db, a: i64, b: i64) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM members m1 JOIN members m2 ON m1.guild_id=m2.guild_id WHERE m1.user_id=$1 AND m2.user_id=$2)")
        .bind(a)
        .bind(b)
        .fetch_one(db)
        .await
}

async fn privacy_of(db: &db::Db, uid: i64, key: &str) -> Result<String, sqlx::Error> {
    let p: Value = sqlx::query_scalar("SELECT privacy FROM users WHERE id=$1").bind(uid).fetch_one(db).await?;
    Ok(p[key].as_str().unwrap_or("everyone").to_string())
}

/// Может ли `from` начать новую переписку с `to` (приватность получателя и блокировки).
pub async fn can_dm(db: &db::Db, from: i64, to: i64) -> Result<(), ApiError> {
    if blocked_either(db, from, to).await? {
        return Err(ApiError(StatusCode::FORBIDDEN, "Нельзя написать этому пользователю".into()));
    }
    if privacy_of(db, to, "dm_from").await? == "friends" && rel(db, to, from).await? != Some(FRIEND) {
        return Err(ApiError(StatusCode::FORBIDDEN, "Пользователь принимает сообщения только от друзей".into()));
    }
    Ok(())
}

// ---------- статус ----------
#[derive(Deserialize)]
pub struct Activity {
    afk: bool,
}

/// Клиент сообщает о бездействии (авто «Отошёл»), не меняя выбранный статус.
pub async fn activity(State(st): State<AppState>, Auth(uid): Auth, Json(a): Json<Activity>) -> R {
    if st.hub.set_afk(uid, a.afk) {
        broadcast_presence(&st, uid).await;
    }
    Ok(Json(json!({ "presence": st.hub.presence(uid) })))
}

// ---------- профиль и учётная запись ----------
#[derive(Deserialize)]
pub struct MePatch {
    display_name: Option<String>,
    status: Option<String>,
    presence: Option<String>,
    /// Аватар: {url (POST /upload), crop} (или просто URL) — в обработку; null — убрать.
    #[serde(default, with = "double_option")]
    avatar: Option<Option<AvatarIn>>,
    #[serde(default, with = "double_option")]
    banner_color: Option<Option<String>>,
    /// Баннер-картинка/GIF/видео (файлы — через POST /upload) или null — убрать.
    #[serde(default, with = "double_option")]
    banner: Option<Option<BannerIn>>,
    bio: Option<String>,
    pronouns: Option<String>,
    privacy: Option<Value>,
    /// Смена логина — только с паролем.
    username: Option<String>,
    password: Option<String>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
        Ok(Some(Option::deserialize(d)?))
    }
}

pub(crate) async fn verify_password(st: &AppState, uid: i64, pw: &str) -> Result<(), ApiError> {
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1").bind(uid).fetch_one(&st.db).await?;
    let pw = pw.to_string();
    let ok =
        tokio::task::spawn_blocking(move || PasswordHash::new(&hash).map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok()).unwrap_or(false))
            .await
            .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(bad("Неверный пароль"))
    }
}

fn valid_username(n: &str) -> bool {
    (2..=32).contains(&n.chars().count()) && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.')
}

/// Ключи настроек аккаунта и предел размера значения (JSON). Остальное отклоняется — это не хранилище «чего угодно».
const SETTINGS_KEYS: [(&str, usize); 3] = [("hotkeys", 4096), ("voice", 2048), ("theme", 256)];

/// Проверить изменение настроек: объект, только известные ключи, значения в пределах размера; null — удалить ключ.
pub(crate) fn settings_patch(b: &Value) -> Result<(Value, Vec<String>), ApiError> {
    let obj = b.as_object().ok_or_else(|| bad("нужен объект"))?;
    if obj.is_empty() {
        return Err(bad("нечего менять"));
    }
    let (mut set, mut del) = (serde_json::Map::new(), Vec::new());
    for (k, v) in obj {
        let Some((_, max)) = SETTINGS_KEYS.iter().find(|(n, _)| n == k) else { return Err(bad(&format!("неизвестная настройка: {k}"))) };
        if v.is_null() {
            del.push(k.clone());
            continue;
        }
        if v.to_string().len() > *max {
            return Err(bad(&format!("настройка {k} слишком большая")));
        }
        set.insert(k.clone(), v.clone());
    }
    Ok((Value::Object(set), del))
}

/// PATCH /api/me/settings — слить изменения в настройки аккаунта; остальным устройствам — settings_update.
pub async fn update_settings(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<Value>) -> R {
    let (set, del) = settings_patch(&b)?;
    let settings: Value = sqlx::query_scalar("UPDATE users SET settings = (settings || $1::jsonb) - $2::text[] WHERE id=$3 RETURNING settings")
        .bind(&set)
        .bind(&del)
        .bind(uid)
        .fetch_one(&st.db)
        .await?;
    st.hub.send(&[uid], &json!({ "type": "settings_update", "settings": settings }));
    Ok(Json(json!({ "settings": settings })))
}

pub async fn update_me(State(st): State<AppState>, Auth(uid): Auth, Json(p): Json<MePatch>) -> R {
    let mut public_changed = false;
    if let Some(n) = p.display_name {
        let n = n.trim();
        if n.is_empty() || n.chars().count() > 32 {
            return Err(bad("Отображаемое имя: 1–32 символа"));
        }
        sqlx::query("UPDATE users SET display_name=$1 WHERE id=$2").bind(n).bind(uid).execute(&st.db).await?;
        public_changed = true;
    }
    if let Some(s) = p.status {
        let s: String = s.trim().chars().take(128).collect();
        sqlx::query("UPDATE users SET status=$1 WHERE id=$2").bind(s).bind(uid).execute(&st.db).await?;
        public_changed = true;
    }
    if let Some(a) = p.avatar {
        match a {
            Some(a) => {
                let (url, crop) = match a {
                    AvatarIn::Url(u) => (u, None),
                    AvatarIn::Media { url, crop } => (url, crop),
                };
                let src = checked_upload(&st, &url, MEDIA_MAX_BYTES, "Аватар").await?;
                let crop = valid_crop(crop, "Аватар")?;
                enqueue(&st, uid, mediaq::Target::Avatar, src, crop, None).await?;
            }
            None => {
                sqlx::query("UPDATE users SET avatar=NULL, avatar_anim=false, avatar_job=NULL WHERE id=$1").bind(uid).execute(&st.db).await?;
                public_changed = true;
            }
        }
    }
    if let Some(c) = p.banner_color {
        if let Some(c) = &c {
            if !(c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())) {
                return Err(bad("Цвет баннера: #rrggbb"));
            }
        }
        sqlx::query("UPDATE users SET banner_color=$1 WHERE id=$2").bind(&c).bind(uid).execute(&st.db).await?;
    }
    if let Some(b) = p.banner {
        match b {
            Some(b) => {
                if let Some(a) = &b.accent {
                    if !(a.len() == 7 && a.starts_with('#') && a[1..].chars().all(|x| x.is_ascii_hexdigit())) {
                        return Err(bad("Акцент баннера: #rrggbb"));
                    }
                }
                let src = checked_upload(&st, &b.url, MEDIA_MAX_BYTES, "Баннер").await?;
                let crop = valid_crop(b.crop, "Баннер")?;
                enqueue(&st, uid, mediaq::Target::Banner, src, crop, b.accent.map(|a| a.to_ascii_lowercase())).await?;
            }
            None => {
                sqlx::query("UPDATE users SET banner=NULL, banner_job=NULL WHERE id=$1").bind(uid).execute(&st.db).await?;
            }
        }
    }
    if let Some(b) = p.bio {
        if b.chars().count() > 190 {
            return Err(bad("«Обо мне» — до 190 символов"));
        }
        sqlx::query("UPDATE users SET bio=$1 WHERE id=$2").bind(b.trim()).bind(uid).execute(&st.db).await?;
    }
    if let Some(pr) = p.pronouns {
        if pr.chars().count() > 40 {
            return Err(bad("Местоимения — до 40 символов"));
        }
        sqlx::query("UPDATE users SET pronouns=$1 WHERE id=$2").bind(pr.trim()).bind(uid).execute(&st.db).await?;
    }
    if let Some(v) = p.privacy {
        let fr = v["friend_requests"].as_str().unwrap_or("everyone");
        let dm = v["dm_from"].as_str().unwrap_or("everyone");
        if !["everyone", "mutual", "none"].contains(&fr) || !["everyone", "friends"].contains(&dm) {
            return Err(bad("Некорректные настройки приватности"));
        }
        sqlx::query("UPDATE users SET privacy=$1 WHERE id=$2").bind(json!({ "friend_requests": fr, "dm_from": dm })).bind(uid).execute(&st.db).await?;
    }
    if let Some(name) = p.username {
        let name = name.trim().to_string();
        if !valid_username(&name) {
            return Err(bad("Имя: 2–32 символа, буквы, цифры, _ и ."));
        }
        verify_password(&st, uid, p.password.as_deref().unwrap_or("")).await?;
        let r = sqlx::query("UPDATE users SET username=$1 WHERE id=$2").bind(&name).bind(uid).execute(&st.db).await;
        if let Err(e) = r {
            return Err(if crate::api::is_unique_violation(&e) { bad("Это имя уже занято") } else { e.into() });
        }
        public_changed = true;
    }
    if let Some(pr) = p.presence {
        if !["online", "idle", "dnd", "invisible"].contains(&pr.as_str()) {
            return Err(bad("Статус: online, idle, dnd или invisible"));
        }
        sqlx::query("UPDATE users SET presence=$1 WHERE id=$2").bind(&pr).bind(uid).execute(&st.db).await?;
        st.hub.set_chosen_presence(uid, &pr);
        // «Невидимка» — активность не хранится и не рассылается.
        if pr == "invisible" {
            st.hub.set_activity(uid, None);
        }
        broadcast_presence(&st, uid).await;
    }
    if public_changed {
        let mut user = db::user_json(&st.db, uid).await?;
        present(&st, &mut user);
        let mut aud = db::related_user_ids(&st.db, uid).await?;
        aud.retain(|u| *u != uid);
        st.hub.send(&aud, &json!({ "type": "user_update", "user": user }));
    }
    let me = self_json(&st, uid).await?;
    st.hub.send(&[uid], &json!({ "type": "user_update", "user": me }));
    Ok(Json(me))
}

#[derive(Deserialize)]
pub struct PasswordChange {
    current: String,
    new: String,
    /** завершить остальные сеансы (по умолчанию — да) */
    #[serde(default)]
    sign_out_others: Option<bool>,
}

/// Смена пароля. Остальные сеансы — завершаются (мгновенно: токены, gateway, голос), если не сказано иначе.
pub async fn change_password(
    State(st): State<AppState>,
    crate::api::AuthSession { uid, session }: crate::api::AuthSession,
    headers: axum::http::HeaderMap,
    Json(b): Json<PasswordChange>,
) -> R {
    if b.new.chars().count() < 6 {
        return Err(bad("Пароль — минимум 6 символов"));
    }
    verify_password(&st, uid, &b.current).await?;
    let pw = b.new.clone();
    let hash = tokio::task::spawn_blocking(move || Argon2::default().hash_password(pw.as_bytes(), &SaltString::generate(&mut OsRng)).map(|h| h.to_string()))
        .await
        .unwrap()
        .map_err(|_| bad("не удалось захешировать пароль"))?;
    sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2").bind(hash).bind(uid).execute(&st.db).await?;
    let ip = crate::sessions::client_info(&headers).ip;
    let mut signed_out = 0;
    if b.sign_out_others.unwrap_or(true) {
        let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM sessions WHERE user_id=$1 AND id<>$2").bind(uid).bind(session).fetch_all(&st.db).await?;
        signed_out = crate::sessions::revoke(&st, uid, &ids).await?.len();
    }
    crate::sessions::log(&st.db, uid, "password_changed", None, Some(session), &ip, json!({ "signed_out": signed_out })).await;
    Ok(Json(json!({ "ok": true, "signed_out": signed_out })))
}

#[derive(Deserialize)]
pub struct ProfileQuery {
    guild_id: Option<i64>,
}

/// Полный профиль: о себе, общие серверы и друзья, отношение, участник сервера (роли, дата входа).
pub async fn profile(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Query(q): Query<ProfileQuery>) -> R {
    let mut u = db::user_json_opt(&st.db, id).await?.ok_or_else(not_found)?;
    present(&st, &mut u);
    let (bio, pronouns, banner, created, banner_media): (String, String, Option<String>, i64, Option<Value>) =
        sqlx::query_as("SELECT bio, pronouns, banner_color, created_at, banner FROM users WHERE id=$1").bind(id).fetch_one(&st.db).await?;
    let mutual_guilds: Vec<Value> = sqlx::query_scalar(
        "SELECT json_build_object('id', g.id, 'name', g.name, 'nick', m2.nick) FROM members m1 JOIN members m2 ON m1.guild_id=m2.guild_id
         JOIN guilds g ON g.id=m1.guild_id WHERE m1.user_id=$1 AND m2.user_id=$2 ORDER BY g.name",
    )
    .bind(uid)
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    let mut mutual_friends: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {} FROM relationships a JOIN relationships b ON a.other_id=b.other_id JOIN users u ON u.id=a.other_id
         WHERE a.user_id=$1 AND b.user_id=$2 AND a.kind=1 AND b.kind=1 ORDER BY u.display_name",
        db::USER_JSON
    ))
    .bind(uid)
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    for f in &mut mutual_friends {
        present(&st, f);
    }
    let member = match q.guild_id {
        Some(g) if id != 0 => sqlx::query_scalar::<_, Value>(
            "SELECT json_build_object('nick', m.nick, 'joined_at', m.joined_at, 'roles', COALESCE((SELECT json_agg(role_id) FROM member_roles r WHERE r.guild_id=m.guild_id AND r.user_id=m.user_id), '[]'::json))
             FROM members m WHERE m.guild_id=$1 AND m.user_id=$2 AND EXISTS(SELECT 1 FROM members x WHERE x.guild_id=$1 AND x.user_id=$3)",
        )
        .bind(g).bind(id).bind(uid).fetch_optional(&st.db).await?,
        _ => None,
    };
    Ok(Json(json!({
        "user": u, "bio": bio, "pronouns": pronouns, "banner_color": banner, "banner": banner_media, "created_at": created,
        "mutual_guilds": if id == uid { json!([]) } else { json!(mutual_guilds) },
        "mutual_friends": if id == uid { json!([]) } else { json!(mutual_friends) },
        "relationship": rel(&st.db, uid, id).await?, "member": member,
    })))
}

// ---------- друзья ----------
async fn rel_json(st: &AppState, of: i64, other: i64) -> Result<Option<Value>, ApiError> {
    let row: Option<(i16, i64)> =
        sqlx::query_as("SELECT kind, since FROM relationships WHERE user_id=$1 AND other_id=$2").bind(of).bind(other).fetch_optional(&st.db).await?;
    let Some((kind, since)) = row else { return Ok(None) };
    let mut u = db::user_json(&st.db, other).await?;
    present(st, &mut u);
    Ok(Some(json!({ "id": other, "kind": kind, "since": since, "user": u })))
}

/// Разослать обеим сторонам их текущее отношение друг к другу (или удаление).
async fn sync_pair(st: &AppState, a: i64, b: i64) -> Result<(), ApiError> {
    for (x, y) in [(a, b), (b, a)] {
        match rel_json(st, x, y).await? {
            Some(r) => st.hub.send(&[x], &json!({ "type": "relationship_add", "relationship": r })),
            None => st.hub.send(&[x], &json!({ "type": "relationship_remove", "id": y })),
        }
    }
    // Друзья видят присутствие друг друга без общих серверов.
    for (x, y) in [(a, b), (b, a)] {
        let p = st.hub.presence(y);
        st.hub.send(&[x], &json!({ "type": "presence", "user_id": y, "online": p != "offline", "presence": p, "activity": st.hub.visible_activity(y) }));
    }
    Ok(())
}

pub async fn rels_of(st: &AppState, uid: i64) -> Result<Vec<Value>, ApiError> {
    let others: Vec<i64> = sqlx::query_scalar("SELECT other_id FROM relationships WHERE user_id=$1 ORDER BY since DESC").bind(uid).fetch_all(&st.db).await?;
    let mut out = vec![];
    for o in others {
        if let Some(r) = rel_json(st, uid, o).await? {
            out.push(r);
        }
    }
    Ok(out)
}

pub async fn list(State(st): State<AppState>, Auth(uid): Auth) -> R {
    Ok(Json(Value::Array(rels_of(&st, uid).await?)))
}

#[derive(Deserialize)]
pub struct FriendBody {
    username: Option<String>,
    user_id: Option<i64>,
}

async fn target_id(st: &AppState, b: &FriendBody) -> Result<i64, ApiError> {
    match (b.user_id, &b.username) {
        (Some(id), _) => Ok(id),
        (None, Some(n)) => sqlx::query_scalar("SELECT id FROM users WHERE lower(username)=lower($1)")
            .bind(n.trim())
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Пользователь с таким именем не найден".into())),
        _ => Err(bad("Укажите пользователя")),
    }
}

/// Заявка в друзья (или принятие встречной).
pub async fn request(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<FriendBody>) -> R {
    let other = target_id(&st, &b).await?;
    if other == uid {
        return Err(bad("Нельзя добавить в друзья самого себя"));
    }
    db::user_json_opt(&st.db, other).await?.ok_or_else(not_found)?;
    match rel(&st.db, uid, other).await? {
        Some(FRIEND) => return Err(bad("Вы уже друзья")),
        Some(BLOCKED) => return Err(bad("Сначала разблокируйте пользователя")),
        Some(OUTGOING) => return Ok(Json(json!({ "kind": OUTGOING }))),
        _ => {}
    }
    let t = now();
    if rel(&st.db, uid, other).await? == Some(INCOMING) {
        // Встречная заявка — принимаем.
        sqlx::query("UPDATE relationships SET kind=1, since=$3 WHERE (user_id=$1 AND other_id=$2) OR (user_id=$2 AND other_id=$1)")
            .bind(uid)
            .bind(other)
            .bind(t)
            .execute(&st.db)
            .await?;
        sync_pair(&st, uid, other).await?;
        return Ok(Json(json!({ "kind": FRIEND })));
    }
    // Расплывчатая ошибка: не раскрываем, что нас заблокировали.
    let refused = || bad("Не удалось отправить заявку: пользователь не принимает заявки");
    if rel(&st.db, other, uid).await? == Some(BLOCKED) {
        return Err(refused());
    }
    match privacy_of(&st.db, other, "friend_requests").await?.as_str() {
        "none" => return Err(refused()),
        "mutual" if !share_guild(&st.db, uid, other).await? => return Err(refused()),
        _ => {}
    }
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO relationships(user_id, other_id, kind, since) VALUES($1, $2, 4, $3) ON CONFLICT (user_id, other_id) DO UPDATE SET kind=4, since=$3",
    )
    .bind(uid)
    .bind(other)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO relationships(user_id, other_id, kind, since) VALUES($2, $1, 3, $3) ON CONFLICT (user_id, other_id) DO UPDATE SET kind=3, since=$3",
    )
    .bind(uid)
    .bind(other)
    .bind(t)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    sync_pair(&st, uid, other).await?;
    Ok(Json(json!({ "kind": OUTGOING })))
}

/// Удалить из друзей / отменить или отклонить заявку / разблокировать.
pub async fn remove(State(st): State<AppState>, Auth(uid): Auth, Path(other): Path<i64>) -> R {
    let mine = rel(&st.db, uid, other).await?.ok_or_else(not_found)?;
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM relationships WHERE user_id=$1 AND other_id=$2").bind(uid).bind(other).execute(&mut *tx).await?;
    if mine != BLOCKED {
        // Чужую блокировку не трогаем.
        sqlx::query("DELETE FROM relationships WHERE user_id=$2 AND other_id=$1 AND kind <> 2").bind(uid).bind(other).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    sync_pair(&st, uid, other).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Заблокировать: дружба и заявки снимаются, писать друг другу в ЛС нельзя.
pub async fn block(State(st): State<AppState>, Auth(uid): Auth, Path(other): Path<i64>) -> R {
    if other == uid {
        return Err(bad("Нельзя заблокировать себя"));
    }
    db::user_json_opt(&st.db, other).await?.ok_or_else(not_found)?;
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM relationships WHERE user_id=$2 AND other_id=$1 AND kind <> 2").bind(uid).bind(other).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO relationships(user_id, other_id, kind, since) VALUES($1, $2, 2, $3) ON CONFLICT (user_id, other_id) DO UPDATE SET kind=2, since=$3",
    )
    .bind(uid)
    .bind(other)
    .bind(now())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    sync_pair(&st, uid, other).await?;
    Ok(Json(json!({ "kind": BLOCKED })))
}

// ---------- ЛС и групповые ЛС ----------
/// ЛС глазами `viewer`: собеседники (без него), для группы — имя и владелец.
pub async fn dm_json(st: &AppState, ch: i64, viewer: i64) -> Result<Value, ApiError> {
    let (kind, name, owner): (String, String, Option<i64>) =
        sqlx::query_as("SELECT kind, name, owner_id FROM channels WHERE id=$1").bind(ch).fetch_one(&st.db).await?;
    let mut recipients: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {} FROM dm_members d JOIN users u ON u.id=d.user_id WHERE d.channel_id=$1 AND d.user_id<>$2 ORDER BY u.display_name",
        db::USER_JSON
    ))
    .bind(ch)
    .bind(viewer)
    .fetch_all(&st.db)
    .await?;
    for r in &mut recipients {
        present(st, r);
    }
    let user = recipients.first().cloned().unwrap_or(Value::Null);
    Ok(if kind == "group_dm" {
        json!({ "id": ch, "kind": "group_dm", "name": name, "owner_id": owner, "recipients": recipients, "user": user })
    } else {
        json!({ "id": ch, "kind": "dm", "user": user, "recipients": recipients })
    })
}

pub async fn dms_of(st: &AppState, uid: i64) -> Result<Vec<Value>, ApiError> {
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT d.channel_id FROM dm_members d WHERE d.user_id=$1
         ORDER BY (SELECT MAX(id) FROM messages WHERE channel_id=d.channel_id) DESC NULLS LAST, d.channel_id DESC",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    let mut out = vec![];
    for ch in ids {
        out.push(dm_json(st, ch, uid).await?);
    }
    Ok(out)
}

async fn group_members(st: &AppState, ch: i64) -> Result<Vec<i64>, ApiError> {
    Ok(sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id=$1").bind(ch).fetch_all(&st.db).await?)
}

async fn notify_group(st: &AppState, ch: i64, kind: &str) -> Result<(), ApiError> {
    for m in group_members(st, ch).await? {
        let dm = dm_json(st, ch, m).await?;
        st.hub.send(&[m], &json!({ "type": kind, "dm": dm }));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct NewGroup {
    user_ids: Vec<i64>,
    name: Option<String>,
}

/// Групповая ЛС: создатель + друзья (до 10 человек всего).
pub async fn create_group(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<NewGroup>) -> R {
    let mut ids = b.user_ids;
    ids.sort_unstable();
    ids.dedup();
    ids.retain(|x| *x != uid);
    if ids.is_empty() {
        return Err(bad("Добавьте хотя бы одного друга"));
    }
    if ids.len() as i64 + 1 > GROUP_MAX {
        return Err(bad("В группе не больше 10 человек"));
    }
    for &o in &ids {
        if rel(&st.db, uid, o).await? != Some(FRIEND) {
            return Err(bad("В группу можно добавить только друзей"));
        }
    }
    let name: String = b.name.unwrap_or_default().trim().chars().take(100).collect();
    let mut tx = st.db.begin().await?;
    let ch: i64 = sqlx::query_scalar("INSERT INTO channels(guild_id, name, kind, owner_id) VALUES(NULL, $1, 'group_dm', $2) RETURNING id")
        .bind(&name)
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO dm_members(channel_id, user_id) SELECT $1, unnest($2::bigint[])")
        .bind(ch)
        .bind([vec![uid], ids].concat())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    notify_group(&st, ch, "dm_create").await?;
    Ok(Json(dm_json(&st, ch, uid).await?))
}

async fn load_group(st: &AppState, ch: i64, uid: i64) -> Result<Option<i64>, ApiError> {
    let row: Option<(String, Option<i64>)> = sqlx::query_as("SELECT kind, owner_id FROM channels WHERE id=$1").bind(ch).fetch_optional(&st.db).await?;
    let (kind, owner) = row.ok_or_else(not_found)?;
    if kind != "group_dm" || !group_members(st, ch).await?.contains(&uid) {
        return Err(not_found());
    }
    Ok(owner)
}

#[derive(Deserialize)]
pub struct GroupPatch {
    name: String,
}

pub async fn rename_group(State(st): State<AppState>, Auth(uid): Auth, Path(ch): Path<i64>, Json(b): Json<GroupPatch>) -> R {
    load_group(&st, ch, uid).await?;
    let name: String = b.name.trim().chars().take(100).collect();
    sqlx::query("UPDATE channels SET name=$1 WHERE id=$2").bind(&name).bind(ch).execute(&st.db).await?;
    notify_group(&st, ch, "dm_update").await?;
    Ok(Json(dm_json(&st, ch, uid).await?))
}

/// Добавить друга в группу (любой участник).
pub async fn add_recipient(State(st): State<AppState>, Auth(uid): Auth, Path((ch, other)): Path<(i64, i64)>) -> R {
    load_group(&st, ch, uid).await?;
    if rel(&st.db, uid, other).await? != Some(FRIEND) {
        return Err(bad("Добавлять можно только друзей"));
    }
    let members = group_members(&st, ch).await?;
    if members.contains(&other) {
        return Ok(Json(dm_json(&st, ch, uid).await?));
    }
    if members.len() as i64 >= GROUP_MAX {
        return Err(bad("В группе не больше 10 человек"));
    }
    sqlx::query("INSERT INTO dm_members(channel_id, user_id) VALUES($1, $2)").bind(ch).bind(other).execute(&st.db).await?;
    // Новичку — как новая ЛС, остальным — обновление.
    let dm = dm_json(&st, ch, other).await?;
    st.hub.send(&[other], &json!({ "type": "dm_create", "dm": dm }));
    for m in members {
        let dm = dm_json(&st, ch, m).await?;
        st.hub.send(&[m], &json!({ "type": "dm_update", "dm": dm }));
    }
    Ok(Json(dm_json(&st, ch, uid).await?))
}

/// Выйти из группы (себя) или исключить (владелец). Владелец ушёл — владельцем становится следующий; пусто — группа удаляется.
pub async fn remove_recipient(State(st): State<AppState>, Auth(uid): Auth, Path((ch, other)): Path<(i64, i64)>) -> R {
    let owner = load_group(&st, ch, uid).await?;
    need(other == uid || owner == Some(uid))?;
    sqlx::query("DELETE FROM dm_members WHERE channel_id=$1 AND user_id=$2").bind(ch).bind(other).execute(&st.db).await?;
    st.hub.send(&[other], &json!({ "type": "dm_remove", "id": ch }));
    let left = group_members(&st, ch).await?;
    if left.is_empty() {
        sqlx::query("DELETE FROM channels WHERE id=$1").bind(ch).execute(&st.db).await?;
        return Ok(Json(json!({ "ok": true })));
    }
    if owner == Some(other) {
        sqlx::query("UPDATE channels SET owner_id=$1 WHERE id=$2").bind(left.iter().min()).bind(ch).execute(&st.db).await?;
    }
    notify_group(&st, ch, "dm_update").await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- аватар и баннер профиля: проверка входа по содержимому → очередь обработки (mediaq) ----------
#[derive(Deserialize)]
#[serde(untagged)]
pub enum AvatarIn {
    Url(String),
    Media { url: String, crop: Option<Crop> },
}
/// Баннер: исходник + область 3:1 + акцент (доминирующий цвет считает клиент). Прочие поля (poster и т.п.) игнорируются.
#[derive(Deserialize)]
pub struct BannerIn {
    url: String,
    crop: Option<Crop>,
    accent: Option<String>,
}
#[derive(Deserialize, Clone, Copy)]
pub struct Crop {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Иконка сервера: те же проверки файла и кадрирование, что у аватара; результат — guild_update участникам.
pub(crate) async fn enqueue_guild_icon(st: &AppState, actor: i64, guild: i64, url: &str, crop: Option<Crop>) -> Result<(), ApiError> {
    let src = checked_upload(st, url, MEDIA_MAX_BYTES, "Иконка").await?;
    let crop = valid_crop(crop, "Иконка")?;
    let job = crate::api::random_string(20, b"abcdefghijklmnopqrstuvwxyz0123456789");
    sqlx::query("UPDATE guilds SET icon_job=$1 WHERE id=$2").bind(&job).bind(guild).execute(&st.db).await?;
    let animated = src.info.animated(src.kind) && mediaq::animated_enabled();
    let pushed = st.media.push(mediaq::Job {
        uid: actor,
        guild,
        target: mediaq::Target::GuildIcon,
        job: job.clone(),
        src: src.key,
        kind: src.kind,
        info: src.info,
        orientation: src.orientation,
        crop,
        animated,
        accent: None,
    });
    if let Err(e) = pushed {
        sqlx::query("UPDATE guilds SET icon_job=NULL WHERE id=$1 AND icon_job=$2").bind(guild).bind(&job).execute(&st.db).await?;
        return Err(ApiError(axum::http::StatusCode::SERVICE_UNAVAILABLE, e.into()));
    }
    Ok(())
}

const MEDIA_MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SIDE: u32 = 4096;
const MAX_PIXELS: u64 = 4096 * 4096;
const MAX_FRAMES: u32 = 1000;
/// Все кадры анимации вместе (ширина × высота × кадры) — защита от GIF-«бомбы» из тысяч крупных кадров.
const MAX_TOTAL_PIXELS: u64 = 600_000_000;
const MAX_VIDEO_MS: u64 = 60_000;

pub struct Checked {
    key: String,
    kind: media::Kind,
    info: media::Info,
    orientation: u8,
}

/// Файл из /uploads: имя без путей, тип по содержимому совпадает с расширением, размеры/кадры/длительность в пределах.
async fn checked_upload(st: &AppState, url: &str, max_bytes: u64, what: &str) -> Result<Checked, ApiError> {
    let file = url.strip_prefix("/uploads/").unwrap_or("");
    if file.is_empty() || !file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') || file.starts_with('.') {
        return Err(bad(&format!("{what}: файл не найден")));
    }
    let size = st.store.size(file).await.map_err(|_| bad(&format!("{what}: файл не найден")))?.ok_or_else(|| bad(&format!("{what}: файл не найден")))?;
    if size > max_bytes {
        return Err(bad(&format!("{what} — не больше {} МБ", max_bytes / 1024 / 1024)));
    }
    let data = st.store.get(file, max_bytes).await.ok().flatten().ok_or_else(|| bad(&format!("{what}: файл не найден")))?;
    let kind = media::sniff(&data).ok_or_else(|| bad(&format!("{what}: нужен PNG, JPEG, WebP, GIF, MP4 или WebM")))?;
    let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if !kind.ext().contains(&ext.as_str()) {
        return Err(bad(&format!("{what}: содержимое не совпадает с типом файла")));
    }
    let info = media::inspect(kind, &data).map_err(|e| bad(&format!("{what}: {e}")))?;
    if info.width == 0 || info.height == 0 || info.width > MAX_SIDE || info.height > MAX_SIDE || info.width as u64 * info.height as u64 > MAX_PIXELS {
        return Err(bad(&format!("{what}: разрешение до {MAX_SIDE}×{MAX_SIDE}")));
    }
    if info.frames > MAX_FRAMES || info.width as u64 * info.height as u64 * info.frames as u64 > MAX_TOTAL_PIXELS {
        return Err(bad(&format!("{what}: слишком много кадров для такого разрешения")));
    }
    if kind.is_video() && info.duration_ms > MAX_VIDEO_MS {
        return Err(bad(&format!("{what}: видео до {} секунд", MAX_VIDEO_MS / 1000)));
    }
    // ffmpeg не декодирует анимированный WebP — лучше честно сказать, чем молча взять первый кадр.
    if kind == media::Kind::Webp && info.frames > 1 {
        return Err(bad(&format!("{what}: анимированный WebP не поддерживается — используйте GIF, MP4 или WebM")));
    }
    let orientation = if kind == media::Kind::Jpeg { media::jpeg_orientation(&data) } else { 1 };
    Ok(Checked { key: file.to_string(), kind, info, orientation })
}

/// Область кадра — доли исходника; без неё — кадр целиком.
fn valid_crop(c: Option<Crop>, what: &str) -> Result<mediaq::Crop, ApiError> {
    let Some(c) = c else { return Ok(mediaq::Crop { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }) };
    let ok = [c.x, c.y, c.w, c.h].iter().all(|v| v.is_finite())
        && c.x >= 0.0
        && c.y >= 0.0
        && c.w > 0.001
        && c.h > 0.001
        && c.x + c.w <= 1.001
        && c.y + c.h <= 1.001;
    if !ok {
        return Err(bad(&format!("{what}: некорректная область кадрирования")));
    }
    Ok(mediaq::Crop { x: c.x, y: c.y, w: c.w.min(1.0 - c.x), h: c.h.min(1.0 - c.y) })
}

/// Поставить обработку в очередь; результат придёт пользователю (и его окружению — для аватара) событием user_update.
async fn enqueue(st: &AppState, uid: i64, target: mediaq::Target, src: Checked, crop: mediaq::Crop, accent: Option<String>) -> Result<(), ApiError> {
    let job = crate::api::random_string(20, b"abcdefghijklmnopqrstuvwxyz0123456789");
    let col = if target == mediaq::Target::Avatar { "avatar_job" } else { "banner_job" };
    sqlx::query(&format!("UPDATE users SET {col}=$1 WHERE id=$2")).bind(&job).bind(uid).execute(&st.db).await?;
    let animated = src.info.animated(src.kind) && mediaq::animated_enabled();
    let pushed = st.media.push(mediaq::Job {
        uid,
        guild: 0,
        target,
        job: job.clone(),
        src: src.key,
        kind: src.kind,
        info: src.info,
        orientation: src.orientation,
        crop,
        animated,
        accent,
    });
    if let Err(e) = pushed {
        sqlx::query(&format!("UPDATE users SET {col}=NULL WHERE id=$1 AND {col}=$2")).bind(uid).bind(&job).execute(&st.db).await?;
        return Err(ApiError(axum::http::StatusCode::SERVICE_UNAVAILABLE, e.into()));
    }
    Ok(())
}

#[cfg(test)]
mod settings_tests {
    use super::settings_patch;
    use serde_json::json;
    #[test]
    fn settings_patch_whitelist_size_and_delete() {
        let Ok((set, del)) = settings_patch(&json!({ "hotkeys": { "mute": "Ctrl+Shift+KeyM" }, "theme": null })) else { panic!("должно пройти") };
        assert_eq!(set, json!({ "hotkeys": { "mute": "Ctrl+Shift+KeyM" } }));
        assert_eq!(del, vec!["theme".to_string()]);
        assert!(settings_patch(&json!({ "password_hash": "x" })).is_err(), "чужие ключи — нет");
        assert!(settings_patch(&json!({})).is_err());
        assert!(settings_patch(&json!([1])).is_err());
        assert!(settings_patch(&json!({ "theme": "x".repeat(300) })).is_err(), "предел размера");
    }
}

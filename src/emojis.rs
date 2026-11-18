//! Эмодзи сервера (фаза 3f). Токен в тексте и реакциях — `<:имя:id>` / `<a:имя:id>` (анимированный GIF).
//! Картинка отдаётся по id (`/api/emojis/{id}/image`) — так токен рисуется у всех, даже без списка эмодзи.

use crate::api::{bad, ctx, is_unique_violation, need, not_found, ApiError, Auth, R};
use crate::{db, now, perms, AppState};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_PER_GUILD: i64 = 50;
const MAX_BYTES: u64 = 512 * 1024;

pub fn valid_name(n: &str) -> bool {
    (2..=32).contains(&n.len()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Разобрать токен `<:имя:id>` / `<a:имя:id>` → id.
pub fn token_id(s: &str) -> Option<i64> {
    let inner = s.strip_prefix('<')?.strip_suffix('>')?;
    let inner = inner.strip_prefix('a').unwrap_or(inner);
    let mut parts = inner.strip_prefix(':')?.split(':');
    let (name, id) = (parts.next()?, parts.next()?);
    (parts.next().is_none() && valid_name(name)).then(|| id.parse().ok()).flatten()
}

pub async fn guild_emojis(db: &db::Db, g: i64) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar("SELECT json_build_object('id', id, 'name', name, 'url', url, 'animated', animated) FROM emojis WHERE guild_id=$1 ORDER BY name")
        .bind(g)
        .fetch_all(db)
        .await
}

async fn changed(st: &AppState, g: i64) -> Result<Vec<Value>, ApiError> {
    let list = guild_emojis(&st.db, g).await?;
    st.hub.send(&db::guild_member_ids(&st.db, g).await?, &json!({ "type": "guild_emojis_update", "guild_id": g, "emojis": list }));
    Ok(list)
}

#[derive(Deserialize)]
pub struct NewEmoji {
    name: String,
    url: String,
}

/// Добавить эмодзи из загруженного файла (POST /upload): PNG/JPEG/WebP/GIF до 512 КБ, MANAGE_EMOJIS.
pub async fn create(State(st): State<AppState>, Auth(uid): Auth, Path(g): Path<i64>, Json(b): Json<NewEmoji>) -> R {
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_EMOJIS))?;
    if !valid_name(&b.name) {
        return Err(bad("Имя эмодзи: 2–32 латинских буквы, цифры или _"));
    }
    let file = b.url.strip_prefix("/uploads/").unwrap_or("");
    let ext = file.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if file.is_empty() || !file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') || !["png", "jpg", "jpeg", "webp", "gif"].contains(&ext) {
        return Err(bad("Нужна картинка PNG, JPEG, WebP или GIF"));
    }
    let size = st.store.size(file).await.ok().flatten().ok_or_else(|| bad("Файл не найден"))?;
    if size > MAX_BYTES {
        return Err(bad("Эмодзи — не больше 512 КБ"));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM emojis WHERE guild_id=$1").bind(g).fetch_one(&st.db).await?;
    if count >= MAX_PER_GUILD {
        return Err(bad("На сервере уже 50 эмодзи"));
    }
    let r =
        sqlx::query_scalar::<_, i64>("INSERT INTO emojis(guild_id, name, url, animated, creator_id, created_at) VALUES($1, $2, $3, $4, $5, $6) RETURNING id")
            .bind(g)
            .bind(&b.name)
            .bind(&b.url)
            .bind(ext == "gif")
            .bind(uid)
            .bind(now())
            .fetch_one(&st.db)
            .await;
    let id = match r {
        Ok(id) => id,
        Err(e) if is_unique_violation(&e) => return Err(bad("Эмодзи с таким именем уже есть")),
        Err(e) => return Err(e.into()),
    };
    changed(&st, g).await?;
    Ok(Json(json!({ "id": id, "name": b.name, "url": b.url, "animated": ext == "gif" })))
}

async fn load(st: &AppState, id: i64, uid: i64) -> Result<(i64, String), ApiError> {
    let (g, name): (i64, String) =
        sqlx::query_as("SELECT guild_id, name FROM emojis WHERE id=$1").bind(id).fetch_optional(&st.db).await?.ok_or_else(not_found)?;
    need(ctx(&st.db, g, uid).await?.can(perms::MANAGE_EMOJIS))?;
    Ok((g, name))
}

#[derive(Deserialize)]
pub struct Rename {
    name: String,
}

/// Переименовать; реакции этим эмодзи переписываются на новое имя (группировка не рассыпается).
pub async fn rename(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<Rename>) -> R {
    let (g, _) = load(&st, id, uid).await?;
    if !valid_name(&b.name) {
        return Err(bad("Имя эмодзи: 2–32 латинских буквы, цифры или _"));
    }
    let mut tx = st.db.begin().await?;
    let r = sqlx::query_scalar::<_, bool>("UPDATE emojis SET name=$1 WHERE id=$2 RETURNING animated").bind(&b.name).bind(id).fetch_one(&mut *tx).await;
    let animated = match r {
        Ok(a) => a,
        Err(e) if is_unique_violation(&e) => return Err(bad("Эмодзи с таким именем уже есть")),
        Err(e) => return Err(e.into()),
    };
    let token = format!("<{}:{}:{id}>", if animated { "a" } else { "" }, b.name);
    sqlx::query("UPDATE reactions SET emoji=$1 WHERE emoji LIKE $2").bind(&token).bind(format!("<%:{id}>")).execute(&mut *tx).await?;
    tx.commit().await?;
    changed(&st, g).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let (g, _) = load(&st, id, uid).await?;
    sqlx::query("DELETE FROM emojis WHERE id=$1").bind(id).execute(&st.db).await?;
    changed(&st, g).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Картинка эмодзи по id (без входа — <img> не умеет слать токен). Удалённый — 404, клиент покажет :имя:.
/// Редирект не кэшируется (иначе удалённое эмодзи ещё долго видно), сам файл кэшируется как обычно.
pub async fn image(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let id: i64 = match id.parse() {
        Ok(v) => v,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match sqlx::query_scalar::<_, String>("SELECT url FROM emojis WHERE id=$1").bind(id).fetch_optional(&st.db).await {
        Ok(Some(url)) => ([(header::CACHE_CONTROL, "no-cache")], Redirect::temporary(&url)).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Реакция эмодзи сервера: эмодзи существует, и пользователь может им пользоваться — он с того же сервера,
/// что и канал, либо состоит на сервере эмодзи и имеет USE_EXTERNAL_EMOJI. Возвращает канонический токен.
pub async fn reaction_token(st: &AppState, uid: i64, c: &db::Channel, raw: &str) -> Result<String, ApiError> {
    let id = token_id(raw).ok_or_else(|| bad("Некорректная реакция"))?;
    let (g, name, animated): (i64, String, bool) = sqlx::query_as("SELECT guild_id, name, animated FROM emojis WHERE id=$1")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| bad("Такого эмодзи нет"))?;
    if c.guild_id != Some(g) {
        let member = db::guild_ctx(&st.db, g, uid).await?.is_some();
        if !member || !perms::has(c.perms, perms::USE_EXTERNAL_EMOJI) {
            return Err(bad("Это эмодзи другого сервера"));
        }
    }
    Ok(format!("<{}:{name}:{id}>", if animated { "a" } else { "" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens() {
        assert_eq!(token_id("<:party_cat:42>"), Some(42));
        assert_eq!(token_id("<a:dance:7>"), Some(7));
        assert_eq!(token_id("<:x:1>"), None); // имя короче 2
        assert_eq!(token_id("<:bad name:1>"), None);
        assert_eq!(token_id("<:ok:1:2>"), None);
        assert_eq!(token_id("😀"), None);
    }
}

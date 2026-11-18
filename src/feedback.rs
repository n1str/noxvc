//! Обратная связь: «Сообщить о проблеме / предложить идею».
//!
//! Пользователь создаёт обращение (тип, категория, заголовок, описание, скриншоты из /api/upload, по желанию — диагностика
//! клиента), видит свои обращения, их статус и комментарии разработчика, получает уведомление при изменении.
//! Администратор инстанса (users.is_admin — не роль сервера) ведёт backlog: фильтры, сортировка, статус и приоритет,
//! комментарии, объединение дубликатов, экспорт в CSV/Markdown.
//! Защита от спама: не больше 5 обращений в час и 20 в сутки, 30 комментариев в час; до 5 скриншотов, каждый — картинка
//! до 10 МБ из нашего хранилища; размеры полей ограничены; из диагностики вычищается всё похожее на токены.
use crate::api::{bad, forbidden, not_found, ApiError, Auth, R};
use crate::{db, now, AppState};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub const KINDS: [&str; 3] = ["bug", "idea", "other"];
pub const CATEGORIES: [&str; 6] = ["voice", "stream", "ui", "account", "messages", "other"];
pub const STATUSES: [&str; 7] = ["new", "review", "planned", "progress", "done", "rejected", "duplicate"];
pub const PRIORITIES: [&str; 5] = ["none", "low", "medium", "high", "critical"];
const MAX_ATTACH: usize = 5;
const MAX_ATTACH_BYTES: i64 = 10 * 1024 * 1024;
const MAX_DIAG_BYTES: usize = 64 * 1024;

pub async fn is_admin(db: &db::Db, uid: i64) -> bool {
    sqlx::query_scalar("SELECT is_admin FROM users WHERE id=$1").bind(uid).fetch_optional(db).await.ok().flatten().unwrap_or(false)
}
async fn admin(st: &AppState, uid: i64) -> Result<(), ApiError> {
    if is_admin(&st.db, uid).await {
        Ok(())
    } else {
        Err(forbidden())
    }
}
async fn admins(db: &db::Db) -> Vec<i64> {
    sqlx::query_scalar("SELECT id FROM users WHERE is_admin").fetch_all(db).await.unwrap_or_default()
}

/// Вычистить из диагностики то, что похоже на секреты: «Bearer …», длинные непрерывные буквенно-цифровые строки
/// (токены сеансов — 48 символов, JWT LiveKit), значения после token=/password=/secret=.
pub fn scrub(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut word = String::new();
    let flush = |w: &mut String, out: &mut String| {
        let lower = w.to_ascii_lowercase();
        let secret_kv = ["token=", "password=", "secret=", "key="].iter().find_map(|k| lower.find(k).map(|i| i + k.len()));
        if w.chars().filter(|c| c.is_ascii_alphanumeric()).count() >= 32 && w.chars().all(|c| c.is_ascii_alphanumeric() || "-_.=+/".contains(c)) {
            // «t=<токен>» — имя оставляем
            if let Some(i) = w.find('=').filter(|i| *i < 20) {
                out.push_str(&w[..=i]);
            }
            out.push_str("[скрыто]");
        } else if let Some(i) = secret_kv {
            out.push_str(&w[..i]);
            out.push_str("[скрыто]");
        } else {
            out.push_str(w);
        }
        w.clear();
    };
    let mut prev_bearer = false;
    for ch in s.chars() {
        if ch.is_whitespace() || "\"',;()[]{}<>".contains(ch) {
            if prev_bearer && !word.is_empty() {
                out.push_str("[скрыто]");
                word.clear();
                prev_bearer = false;
            } else {
                prev_bearer = word.eq_ignore_ascii_case("bearer");
                flush(&mut word, &mut out);
            }
            out.push(ch);
        } else {
            word.push(ch);
        }
    }
    if prev_bearer && !word.is_empty() {
        out.push_str("[скрыто]");
    } else {
        flush(&mut word, &mut out);
    }
    out
}
fn scrub_json(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(scrub(s)),
        Value::Array(a) => Value::Array(a.iter().map(scrub_json).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| !["token", "password", "authorization", "credential"].contains(&k.to_ascii_lowercase().as_str()))
                .map(|(k, v)| (k.clone(), scrub_json(v)))
                .collect(),
        ),
        v => v.clone(),
    }
}

fn pick<'a>(v: &str, allowed: &[&'a str], what: &str) -> Result<&'a str, ApiError> {
    allowed.iter().find(|a| **a == v).copied().ok_or_else(|| bad(&format!("неизвестное значение {what}: {v}")))
}
fn text(s: &str, min: usize, max: usize, what: &str) -> Result<String, ApiError> {
    let t = s.trim();
    let n = t.chars().count();
    if n < min || n > max {
        return Err(bad(&format!("{what}: от {min} до {max} символов")));
    }
    Ok(t.to_string())
}

#[derive(Deserialize)]
pub struct Attachment {
    url: String,
    name: String,
    size: i64,
    content_type: String,
}
#[derive(Deserialize)]
pub struct NewFeedback {
    kind: String,
    category: String,
    title: String,
    body: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
    diagnostics: Option<Value>,
}

/// Проверка вложений: только картинки из нашего хранилища, не больше 5 и не больше 10 МБ каждая.
pub fn check_attachments(a: &[Attachment]) -> Result<Value, ApiError> {
    if a.len() > MAX_ATTACH {
        return Err(bad(&format!("не больше {MAX_ATTACH} скриншотов")));
    }
    let mut out = vec![];
    for x in a {
        let name = x.url.strip_prefix("/uploads/").unwrap_or("");
        let ok_name = !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') && name.matches('.').count() == 1;
        let ext = name.rsplit('.').next().unwrap_or("");
        if !ok_name || !["png", "jpg", "jpeg", "gif", "webp"].contains(&ext) || !x.content_type.starts_with("image/") {
            return Err(bad("скриншоты — только картинки (PNG, JPEG, GIF, WebP)"));
        }
        if x.size <= 0 || x.size > MAX_ATTACH_BYTES {
            return Err(bad("скриншот больше 10 МБ"));
        }
        out.push(json!({ "url": x.url, "name": x.name.chars().take(120).collect::<String>(), "size": x.size, "content_type": x.content_type }));
    }
    Ok(Value::Array(out))
}

/// POST /api/feedback — новое обращение.
pub async fn create(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<NewFeedback>) -> R {
    let kind = pick(&b.kind, &KINDS, "типа")?;
    let category = pick(&b.category, &CATEGORIES, "категории")?;
    let title = text(&b.title, 3, 120, "Заголовок")?;
    let body = text(&b.body, 1, 5000, "Описание")?;
    let attachments = check_attachments(&b.attachments)?;
    let diagnostics = match &b.diagnostics {
        Some(d) if !d.is_null() => {
            let d = scrub_json(d);
            if d.to_string().len() > MAX_DIAG_BYTES {
                return Err(bad("диагностика слишком большая"));
            }
            Some(d)
        }
        _ => None,
    };
    let t = now();
    let (hour, day): (i64, i64) = sqlx::query_as("SELECT count(*) FILTER (WHERE created_at > $2), count(*) FROM feedback WHERE user_id=$1 AND created_at > $3")
        .bind(uid)
        .bind(t - 3_600_000)
        .bind(t - 86_400_000)
        .fetch_one(&st.db)
        .await?;
    if hour >= 5 || day >= 20 {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Слишком много обращений — попробуйте позже".into()));
    }
    let id: i64 = sqlx::query_scalar("INSERT INTO feedback(user_id, kind, category, title, body, attachments, diagnostics, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id")
        .bind(uid).bind(kind).bind(category).bind(&title).bind(&body).bind(&attachments).bind(&diagnostics).bind(t).fetch_one(&st.db).await?;
    crate::metrics::M.feedback.with_label_values(&[kind]).inc();
    st.hub.send(&admins(&st.db).await, &json!({ "type": "feedback_new", "id": id, "kind": kind, "title": title }));
    Ok(Json(json!({ "id": id })))
}

const ITEM: &str = "SELECT f.id, f.user_id, f.kind, f.category, f.title, f.body, f.status, f.priority, f.duplicate_of, f.attachments, f.diagnostics, f.created_at, f.updated_at, f.unread,
    (SELECT count(*) FROM feedback_comments c WHERE c.feedback_id=f.id) AS comments, json_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'color',u.color,'avatar',u.avatar) AS author
    FROM feedback f JOIN users u ON u.id=f.user_id";
type Row = (i64, i64, String, String, String, String, String, String, Option<i64>, Value, Option<Value>, i64, i64, bool, i64, Value);
fn item(r: Row, with_diag: bool) -> Value {
    let (id, user_id, kind, category, title, body, status, priority, dup, attachments, diag, created, updated, unread, comments, author) = r;
    let has_diag = diag.is_some();
    json!({ "id": id, "user_id": user_id, "kind": kind, "category": category, "title": title, "body": body, "status": status, "priority": priority,
        "duplicate_of": dup, "attachments": attachments, "diagnostics": if with_diag { diag.unwrap_or(Value::Null) } else { Value::Null },
        "has_diagnostics": has_diag, "created_at": created, "updated_at": updated, "unread": unread, "comments": comments, "author": author })
}

/// GET /api/feedback/mine — свои обращения.
pub async fn mine(State(st): State<AppState>, Auth(uid): Auth) -> R {
    let rows: Vec<Row> = sqlx::query_as(&format!("{ITEM} WHERE f.user_id=$1 ORDER BY f.updated_at DESC LIMIT 200")).bind(uid).fetch_all(&st.db).await?;
    Ok(Json(json!({ "items": rows.into_iter().map(|r| item(r, false)).collect::<Vec<_>>() })))
}

/// GET /api/feedback/{id} — обращение и комментарии (автору и администратору). Автор открыл — изменения прочитаны.
pub async fn get_one(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let r: Row = sqlx::query_as(&format!("{ITEM} WHERE f.id=$1")).bind(id).fetch_optional(&st.db).await?.ok_or_else(not_found)?;
    let adm = is_admin(&st.db, uid).await;
    if r.1 != uid && !adm {
        return Err(not_found());
    }
    if r.1 == uid && r.13 {
        sqlx::query("UPDATE feedback SET unread=false WHERE id=$1").bind(id).execute(&st.db).await?;
    }
    let comments: Vec<(i64, String, bool, i64, Value)> = sqlx::query_as(
        "SELECT c.id, c.body, c.is_admin, c.created_at, json_build_object('id',u.id,'username',u.username,'display_name',u.display_name,'color',u.color,'avatar',u.avatar)
         FROM feedback_comments c JOIN users u ON u.id=c.user_id WHERE c.feedback_id=$1 ORDER BY c.created_at, c.id").bind(id).fetch_all(&st.db).await?;
    let comments: Vec<Value> = comments
        .into_iter()
        .map(|(id, body, is_admin, at, author)| json!({ "id": id, "body": body, "is_admin": is_admin, "created_at": at, "author": author }))
        .collect();
    let mut it = item(r, adm); // диагностику видит администратор
    if !adm {
        it["unread"] = json!(false);
    }
    Ok(Json(json!({ "item": it, "comments": comments, "admin": adm })))
}

#[derive(Deserialize)]
pub struct NewComment {
    body: String,
}

/// POST /api/feedback/{id}/comments — комментарий автора или администратора; другой стороне — уведомление.
pub async fn comment(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<NewComment>) -> R {
    let body = text(&b.body, 1, 3000, "Комментарий")?;
    let (owner, title): (i64, String) =
        sqlx::query_as("SELECT user_id, title FROM feedback WHERE id=$1").bind(id).fetch_optional(&st.db).await?.ok_or_else(not_found)?;
    let adm = is_admin(&st.db, uid).await;
    if owner != uid && !adm {
        return Err(not_found());
    }
    let t = now();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM feedback_comments WHERE user_id=$1 AND created_at > $2")
        .bind(uid)
        .bind(t - 3_600_000)
        .fetch_one(&st.db)
        .await?;
    if n >= 30 {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Слишком много комментариев — попробуйте позже".into()));
    }
    let cid: i64 = sqlx::query_scalar("INSERT INTO feedback_comments(feedback_id, user_id, body, is_admin, created_at) VALUES($1,$2,$3,$4,$5) RETURNING id")
        .bind(id)
        .bind(uid)
        .bind(&body)
        .bind(adm && owner != uid)
        .bind(t)
        .fetch_one(&st.db)
        .await?;
    let from_dev = adm && owner != uid;
    sqlx::query("UPDATE feedback SET updated_at=$1, unread = unread OR $2 WHERE id=$3").bind(t).bind(from_dev).bind(id).execute(&st.db).await?;
    let ev = json!({ "type": "feedback_update", "id": id, "title": title, "what": "comment", "from_dev": from_dev });
    if from_dev {
        st.hub.send(&[owner], &ev);
    } else {
        st.hub.send(&admins(&st.db).await, &ev);
    }
    Ok(Json(json!({ "id": cid })))
}

// ---------- администрирование ----------
#[derive(Deserialize, Default)]
pub struct ListQuery {
    kind: Option<String>,
    category: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    q: Option<String>,
    sort: Option<String>,
}

fn order(sort: Option<&str>) -> &'static str {
    match sort {
        Some("oldest") => "f.created_at ASC",
        Some("updated") => "f.updated_at DESC",
        Some("priority") => "array_position(ARRAY['critical','high','medium','low','none'], f.priority), f.created_at DESC",
        _ => "f.created_at DESC",
    }
}
async fn admin_rows(st: &AppState, q: &ListQuery) -> Result<Vec<Row>, ApiError> {
    let opt = |v: &Option<String>, allowed: &[&str]| -> Result<Option<String>, ApiError> {
        match v.as_deref().filter(|s| !s.is_empty() && *s != "all") {
            Some(s) => Ok(Some(allowed.iter().find(|a| **a == s).ok_or_else(|| bad("неизвестный фильтр"))?.to_string())),
            None => Ok(None),
        }
    };
    let (kind, cat, status, prio) = (opt(&q.kind, &KINDS)?, opt(&q.category, &CATEGORIES)?, opt(&q.status, &STATUSES)?, opt(&q.priority, &PRIORITIES)?);
    let search =
        q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    let sql = format!(
        "{ITEM} WHERE ($1::text IS NULL OR f.kind=$1) AND ($2::text IS NULL OR f.category=$2) AND ($3::text IS NULL OR f.status=$3)
        AND ($4::text IS NULL OR f.priority=$4) AND ($5::text IS NULL OR f.title ILIKE $5 OR f.body ILIKE $5) ORDER BY {} LIMIT 1000",
        order(q.sort.as_deref())
    );
    Ok(sqlx::query_as(&sql).bind(kind).bind(cat).bind(status).bind(prio).bind(search).fetch_all(&st.db).await?)
}

/// GET /api/admin/feedback — все обращения с фильтрами и сортировкой (только администратор).
pub async fn admin_list(State(st): State<AppState>, Auth(uid): Auth, Query(q): Query<ListQuery>) -> R {
    admin(&st, uid).await?;
    let rows = admin_rows(&st, &q).await?;
    let counts: Vec<(String, i64)> = sqlx::query_as("SELECT status, count(*) FROM feedback GROUP BY status").fetch_all(&st.db).await?;
    Ok(Json(
        json!({ "items": rows.into_iter().map(|r| item(r, false)).collect::<Vec<_>>(), "counts": counts.into_iter().collect::<std::collections::HashMap<_, _>>() }),
    ))
}

#[derive(Deserialize)]
pub struct AdminPatch {
    status: Option<String>,
    priority: Option<String>,
    duplicate_of: Option<i64>,
}

/// PATCH /api/admin/feedback/{id} — статус, приоритет, «дубликат обращения N» (статус duplicate). Автору — уведомление.
pub async fn admin_patch(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<AdminPatch>) -> R {
    admin(&st, uid).await?;
    let (owner, title, old_status): (i64, String, String) =
        sqlx::query_as("SELECT user_id, title, status FROM feedback WHERE id=$1").bind(id).fetch_optional(&st.db).await?.ok_or_else(not_found)?;
    let mut status = b.status.as_deref().map(|s| pick(s, &STATUSES, "статуса")).transpose()?.map(str::to_string);
    let priority = b.priority.as_deref().map(|s| pick(s, &PRIORITIES, "приоритета")).transpose()?;
    if let Some(d) = b.duplicate_of {
        if d == id {
            return Err(bad("обращение не может быть дубликатом самого себя"));
        }
        // цепочки дубликатов — к исходному
        let target: Option<(i64, Option<i64>)> = sqlx::query_as("SELECT id, duplicate_of FROM feedback WHERE id=$1").bind(d).fetch_optional(&st.db).await?;
        let (tid, tdup) = target.ok_or_else(|| bad("нет обращения с таким номером"))?;
        if tdup == Some(id) {
            return Err(bad("то обращение уже отмечено дубликатом этого"));
        }
        let _ = tid;
        status = Some("duplicate".into());
    }
    let t = now();
    sqlx::query("UPDATE feedback SET status=COALESCE($1, status), priority=COALESCE($2, priority), duplicate_of = CASE WHEN $3::bigint IS NOT NULL THEN $3 WHEN COALESCE($1, status) <> 'duplicate' THEN NULL ELSE duplicate_of END,
        updated_at=$4, unread = unread OR (COALESCE($1, status) <> $5) WHERE id=$6")
        .bind(&status).bind(priority).bind(b.duplicate_of).bind(t).bind(&old_status).bind(id).execute(&st.db).await?;
    if let Some(s) = status.as_deref().filter(|s| *s != old_status) {
        st.hub.send(&[owner], &json!({ "type": "feedback_update", "id": id, "title": title, "what": "status", "status": s, "from_dev": true }));
    }
    let r: Row = sqlx::query_as(&format!("{ITEM} WHERE f.id=$1")).bind(id).fetch_one(&st.db).await?;
    Ok(Json(json!({ "item": item(r, true) })))
}

#[derive(Deserialize)]
pub struct ExportQuery {
    format: Option<String>,
    #[serde(flatten)]
    q: ListQueryOwned,
}
#[derive(Deserialize, Default)]
pub struct ListQueryOwned {
    kind: Option<String>,
    category: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    q: Option<String>,
    sort: Option<String>,
}

fn csv_cell(s: &str) -> String {
    // Excel: формулы не исполнять (= + - @ в начале), кавычки — удваивать
    let s = if s.starts_with(['=', '+', '-', '@']) { format!("'{s}") } else { s.to_string() };
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace(['\r', '\n'], " ")
}

/// GET /api/admin/feedback/export?format=csv|md (+ те же фильтры) — выгрузка backlog.
pub async fn admin_export(State(st): State<AppState>, Auth(uid): Auth, Query(e): Query<ExportQuery>) -> Result<Response, ApiError> {
    admin(&st, uid).await?;
    let q = ListQuery { kind: e.q.kind, category: e.q.category, status: e.q.status, priority: e.q.priority, q: e.q.q, sort: e.q.sort };
    let rows = admin_rows(&st, &q).await?;
    let date = |ms: i64| chrono_like(ms);
    let md = e.format.as_deref() == Some("md");
    let mut out = String::new();
    if md {
        out.push_str("| № | Тип | Категория | Статус | Приоритет | Заголовок | Автор | Создано | Комментариев |\n|---|---|---|---|---|---|---|---|---|\n");
        for (id, _, kind, cat, title, _, status, prio, dup, _, _, created, _, _, comments, author) in rows {
            let st = dup.map(|d| format!("{status} (#{d})")).unwrap_or(status);
            out.push_str(&format!(
                "| {id} | {kind} | {cat} | {} | {prio} | {} | @{} | {} | {comments} |\n",
                md_cell(&st),
                md_cell(&title),
                md_cell(author["username"].as_str().unwrap_or("")),
                date(created)
            ));
        }
    } else {
        out.push('\u{feff}'); // Excel: UTF-8
        out.push_str("id,kind,category,status,priority,duplicate_of,title,body,author,created_at,updated_at,comments\r\n");
        for (id, _, kind, cat, title, body, status, prio, dup, _, _, created, updated, _, comments, author) in rows {
            let cells = [
                id.to_string(),
                kind,
                cat,
                status,
                prio,
                dup.map(|d| d.to_string()).unwrap_or_default(),
                title,
                body,
                author["username"].as_str().unwrap_or("").to_string(),
                date(created),
                date(updated),
                comments.to_string(),
            ];
            out.push_str(&cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
            out.push_str("\r\n");
        }
    }
    let (ct, ext) = if md { ("text/markdown; charset=utf-8", "md") } else { ("text/csv; charset=utf-8", "csv") };
    Ok(([(header::CONTENT_TYPE, ct.to_string()), (header::CONTENT_DISPOSITION, format!("attachment; filename=\"relay-feedback.{ext}\""))], out).into_response())
}

/// Дата UTC «2026-11-16 21:33» без внешних зависимостей.
fn chrono_like(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // гражданская дата из числа дней (алгоритм Хиннанта)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, rem % 3600 / 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scrubs_secrets() {
        let tok = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV"; // 48 — как токен сеанса
        let s =
            scrub(&format!("auth Bearer {tok} ok; url=/api?token=xyz123&a=1 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJlLXZlcnktbG9uZy12YWx1ZQ ok"));
        assert!(!s.contains(tok) && !s.contains("xyz123") && !s.contains("eyJzdWIiOiI0MiJ9"), "{s}");
        assert!(s.contains("ok") && s.contains("url=/api?token=[скрыто]"), "{s}");
        assert_eq!(scrub("обычный лог: ICE connected, 42 кадра"), "обычный лог: ICE connected, 42 кадра");
        let j = scrub_json(&json!({ "token": "x", "log": [format!("t={tok}")], "n": 1 }));
        assert_eq!(j, json!({ "log": ["t=[скрыто]"], "n": 1 }));
    }
    #[test]
    fn attachments_only_our_images() {
        let a = |url: &str, ct: &str, size: i64| Attachment { url: url.into(), name: "x.png".into(), size, content_type: ct.into() };
        assert!(check_attachments(&[a("/uploads/abc123.png", "image/png", 1000)]).is_ok());
        assert!(check_attachments(&[a("https://evil.example/x.png", "image/png", 1000)]).is_err(), "чужие ссылки — нет");
        assert!(check_attachments(&[a("/uploads/../etc/passwd.png", "image/png", 1000)]).is_err());
        assert!(check_attachments(&[a("/uploads/abc.zip", "application/zip", 1000)]).is_err(), "только картинки");
        assert!(check_attachments(&[a("/uploads/abc.png", "image/png", 11 * 1024 * 1024)]).is_err(), "≤ 10 МБ");
        assert!(check_attachments(&(0..6).map(|_| a("/uploads/abc.png", "image/png", 10)).collect::<Vec<_>>()).is_err(), "≤ 5");
    }
    #[test]
    fn csv_and_dates() {
        assert_eq!(csv_cell("a \"b\""), "\"a \"\"b\"\"\"");
        assert_eq!(csv_cell("=HYPERLINK(1)"), "\"'=HYPERLINK(1)\"");
        assert_eq!(md_cell("a|b\nc"), "a\\|b c");
        assert_eq!(chrono_like(0), "1970-01-01 00:00");
        assert_eq!(chrono_like(1_794_871_980_000), "2026-11-16 23:33"); // UTC
        assert!(order(Some("priority")).starts_with("array_position"));
    }
}

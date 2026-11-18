//! Закрытая регистрация: аккаунты — только по одноразовым кодам.
//!
//! - Коды: 24 символа из алфавита без похожих (0/O, 1/I/L) — 31^24 ≈ 2^118.9. В БД только SHA-256 кода.
//!   Созданные администратором вручную — CSPRNG (OsRng), показываются один раз. По запросу участника — HMAC-SHA256
//!   (ключ сервера RELAY_INVITE_KEY, nonce строки): автор видит ссылку, пока код не использован; по одной БД без
//!   ключа код не восстановить.
//! - Регистрация (api::register) расходует код в одной транзакции с созданием пользователя: `UPDATE … WHERE не
//!   использован, не отозван, не истёк RETURNING` — из параллельных попыток с одним кодом проходит ровно одна;
//!   любая ошибка — откат, код остаётся неиспользованным. Ошибка одна на все случаи: «Код приглашения недействителен».
//! - Запросы участников («позвать человека на мой сервер») решает администратор инстанса: одобрил — код,
//!   привязанный к запросу и серверу (новичок сразу оказывается на нём).
//! - Администраторы инстанса — только из env RELAY_INSTANCE_ADMINS (логины через запятую), сверяются при запуске.
//! - Ограничения частоты (в памяти процесса): регистрация — по IP и всего, неверные коды и неверные пароли — по IP.
use crate::api::{bad, ctx, forbidden, ApiError, Auth, R};
use crate::{db, now, perms, AppState};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

pub const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
pub const CODE_LEN: usize = 24;
const DAY: i64 = 86_400_000;
/// Срок ожидающего запроса: не решён за 14 дней — «истёк».
pub const REQUEST_TTL: i64 = 14 * DAY;
pub const MAX_PENDING: i64 = 3;
const INVALID: &str = "Код приглашения недействителен";

// ---------- коды ----------

/// Байты → символы алфавита (отбраковка: байт < 248 = 31·8, без смещения распределения).
fn encode(bytes: impl Iterator<Item = u8>) -> String {
    bytes.filter(|b| *b < 248).take(CODE_LEN).map(|b| ALPHABET[(b % 31) as usize] as char).collect()
}

/// Случайный код (CSPRNG ОС).
pub fn random_code() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 64];
    loop {
        rand::rngs::OsRng.fill_bytes(&mut buf);
        let c = encode(buf.iter().copied());
        if c.len() == CODE_LEN {
            return c;
        }
    }
}

/// Ключ для кодов по запросам: RELAY_INVITE_KEY (deploy/gen-env.sh), иначе — производный от секрета LiveKit (он тоже
/// только в .env сервера). Без обоих — случайный на время процесса (ссылки по запросам переживут только его).
fn key() -> &'static [u8] {
    static K: LazyLock<Vec<u8>> = LazyLock::new(|| {
        if let Ok(k) = std::env::var("RELAY_INVITE_KEY") {
            if k.len() >= 32 {
                return k.into_bytes();
            }
        }
        if let Ok(s) = std::env::var("LIVEKIT_API_SECRET") {
            if !s.is_empty() {
                return Sha256::digest(format!("relay-invite:{s}")).to_vec();
            }
        }
        eprintln!("ВНИМАНИЕ: нет RELAY_INVITE_KEY — ссылки по одобренным запросам не переживут перезапуск");
        use rand::RngCore;
        let mut k = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        k
    });
    &K
}

/// Код по запросу: HMAC-SHA256(ключ, nonce‖счётчик) — поток байтов, пока не наберётся CODE_LEN символов.
pub fn derived_code(nonce: &str) -> String {
    let mut out = String::new();
    for i in 0u8.. {
        let mut m = <Hmac<Sha256>>::new_from_slice(key()).expect("ключ HMAC");
        m.update(nonce.as_bytes());
        m.update(&[i]);
        let part = encode(m.finalize().into_bytes().into_iter());
        out.push_str(&part);
        if out.len() >= CODE_LEN {
            out.truncate(CODE_LEN);
            return out;
        }
    }
    unreachable!()
}

/// Ввод пользователя → код: регистр не важен, пробелы и дефисы игнорируются.
pub fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).take(64).collect()
}
pub fn hash(code: &str) -> String {
    hex(&Sha256::digest(normalize(code).as_bytes()))
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn link(code: &str) -> String {
    format!("{}/register?code={code}", crate::site::app_url())
}
fn nonce() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex(&b)
}

// ---------- ограничения частоты ----------

struct Limiter {
    m: Mutex<HashMap<String, VecDeque<i64>>>,
}
static LIM: LazyLock<Limiter> = LazyLock::new(|| Limiter { m: Mutex::new(HashMap::new()) });
impl Limiter {
    /// Сколько событий по ключу за окно (старые — отбрасываются).
    fn count(&self, key: &str, window: i64) -> usize {
        let mut m = self.m.lock().unwrap();
        let t = now();
        let q = m.entry(key.to_string()).or_default();
        while q.front().is_some_and(|x| *x <= t - window) {
            q.pop_front();
        }
        q.len()
    }
    fn add(&self, key: &str) {
        let mut m = self.m.lock().unwrap();
        m.entry(key.to_string()).or_default().push_back(now());
        if m.len() > 50_000 {
            m.retain(|_, q| q.back().is_some_and(|x| *x > now() - 3_600_000));
        }
    }
}
fn limit(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
const TEN_MIN: i64 = 600_000;
fn too_many() -> ApiError {
    ApiError(StatusCode::TOO_MANY_REQUESTS, "Слишком много попыток — попробуйте позже".into())
}

/// Ключ ограничений — IP клиента (X-Forwarded-For от Caddy).
pub fn ip_key(h: &axum::http::HeaderMap) -> String {
    let ip = crate::sessions::client_info(h).ip;
    if ip.is_empty() {
        "unknown".into()
    } else {
        ip
    }
}

/// Попытка регистрации: по IP (RELAY_REGISTER_PER_IP, 10 за 10 мин), всего (RELAY_REGISTER_GLOBAL, 100 за 10 мин),
/// и после 5 неверных кодов с IP за 10 мин — пауза.
pub fn register_attempt(ip: &str) -> Result<(), ApiError> {
    let (per_ip, global, bad_codes) = (limit("RELAY_REGISTER_PER_IP", 10), limit("RELAY_REGISTER_GLOBAL", 100), limit("RELAY_BAD_CODES_PER_IP", 5));
    if LIM.count(&format!("reg:{ip}"), TEN_MIN) >= per_ip || LIM.count("reg:*", TEN_MIN) >= global || LIM.count(&format!("badcode:{ip}"), TEN_MIN) >= bad_codes
    {
        crate::metrics::M.registration_attempts.with_label_values(&["limited"]).inc();
        return Err(too_many());
    }
    LIM.add(&format!("reg:{ip}"));
    LIM.add("reg:*");
    Ok(())
}
/// Неверный код: учесть (без самого кода в логе) и вернуть единую ошибку.
pub fn invalid_code(ip: &str) -> ApiError {
    LIM.add(&format!("badcode:{ip}"));
    crate::metrics::M.registration_attempts.with_label_values(&["invalid_code"]).inc();
    eprintln!("регистрация: недействительный код (ip {ip})");
    bad(INVALID)
}
/// Вход: после RELAY_LOGIN_FAILS_PER_IP (20) неверных паролей с IP за 10 мин — пауза.
pub fn login_allowed(ip: &str) -> Result<(), ApiError> {
    if LIM.count(&format!("login:{ip}"), TEN_MIN) >= limit("RELAY_LOGIN_FAILS_PER_IP", 20) {
        return Err(too_many());
    }
    Ok(())
}
pub fn login_failed(ip: &str) {
    LIM.add(&format!("login:{ip}"));
}

// ---------- расход кода (в транзакции регистрации) ----------

/// Пометить код использованным, если он действителен: Some((id кода, сервер для автодобавления)).
pub async fn consume(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, code: &str) -> Result<Option<(i64, Option<i64>)>, sqlx::Error> {
    sqlx::query_as("UPDATE registration_invites SET used_at=$2 WHERE code_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2 RETURNING id, target_guild_id")
        .bind(hash(code)).bind(now()).fetch_optional(&mut **tx).await
}
pub async fn mark_used(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: i64, uid: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE registration_invites SET used_by=$2 WHERE id=$1").bind(id).bind(uid).execute(&mut **tx).await.map(|_| ())
}

// ---------- администраторы инстанса ----------

fn admin_list() -> Option<Vec<String>> {
    let v = std::env::var("RELAY_INSTANCE_ADMINS").ok()?;
    Some(v.split(',').map(|s| s.trim().trim_start_matches('@').to_lowercase()).filter(|s| !s.is_empty()).collect())
}
pub fn is_listed_admin(username: &str) -> bool {
    admin_list().is_some_and(|l| l.contains(&username.to_lowercase()))
}
/// При запуске: users.is_admin — ровно по RELAY_INSTANCE_ADMINS. Не задана — не трогаем (иначе пропали бы все).
pub async fn sync_admins(db: &db::Db) {
    let Some(list) = admin_list() else { return };
    match sqlx::query_scalar::<_, String>(
        "UPDATE users SET is_admin = (lower(username) = ANY($1)) WHERE is_admin <> (lower(username) = ANY($1)) RETURNING username",
    )
    .bind(&list)
    .fetch_all(db)
    .await
    {
        Ok(changed) if !changed.is_empty() => println!("администраторы инстанса: {} (изменены: {})", list.join(", "), changed.join(", ")),
        Ok(_) => println!("администраторы инстанса: {}", list.join(", ")),
        Err(e) => eprintln!("администраторы инстанса: ошибка {e}"),
    }
}
async fn admin(st: &AppState, uid: i64) -> Result<(), ApiError> {
    if crate::feedback::is_admin(&st.db, uid).await {
        Ok(())
    } else {
        Err(forbidden())
    }
}
async fn admin_ids(db: &db::Db) -> Vec<i64> {
    sqlx::query_scalar("SELECT id FROM users WHERE is_admin").fetch_all(db).await.unwrap_or_default()
}

/// Ожидающие запросы старше REQUEST_TTL — «истёк».
pub async fn expire_stale(db: &db::Db) {
    let _ = sqlx::query("UPDATE invite_requests SET status='expired', decided_at=$1 WHERE status='pending' AND created_at < $2")
        .bind(now())
        .bind(now() - REQUEST_TTL)
        .execute(db)
        .await;
}
pub async fn pending_count(db: &db::Db) -> i64 {
    expire_stale(db).await;
    sqlx::query_scalar("SELECT count(*) FROM invite_requests WHERE status='pending'").fetch_one(db).await.unwrap_or(0)
}
/// Администраторам — новое число ожидающих (бейдж) и сигнал перечитать список.
async fn notify_admins(st: &AppState, what: &str, id: i64) {
    let n = pending_count(&st.db).await;
    st.hub.send(&admin_ids(&st.db).await, &json!({ "type": "invite_admin_update", "what": what, "id": id, "pending": n }));
}

const CODE_STATE: &str =
    "CASE WHEN ri.used_at IS NOT NULL THEN 'used' WHEN ri.revoked_at IS NOT NULL THEN 'revoked' WHEN ri.expires_at <= $1 THEN 'expired' ELSE 'active' END";
fn user_obj(alias: &str) -> String {
    format!("CASE WHEN {alias}.id IS NULL THEN NULL ELSE json_build_object('id',{alias}.id,'username',{alias}.username,'display_name',{alias}.display_name,'color',{alias}.color,'avatar',{alias}.avatar) END")
}
fn days(d: Option<i64>) -> Result<i64, ApiError> {
    let d = d.unwrap_or(7);
    if !(1..=90).contains(&d) {
        return Err(bad("Срок: от 1 до 90 дней"));
    }
    Ok(d * DAY)
}
fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').collect::<String>().trim().chars().take(max).collect()
}

// ---------- участник: запросы ----------

#[derive(Deserialize)]
pub struct NewRequest {
    guild_id: i64,
    invitee: String,
    #[serde(default)]
    comment: String,
}

/// POST /api/invite-requests — позвать человека на свой сервер (нужно право «Приглашать» на нём).
pub async fn create_request(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<NewRequest>) -> R {
    if !ctx(&st.db, b.guild_id, uid).await?.can(perms::CREATE_INVITE) {
        return Err(forbidden());
    }
    let invitee = clean(&b.invitee, 64);
    if invitee.is_empty() {
        return Err(bad("Укажите, кого приглашаете"));
    }
    let comment = clean(&b.comment, 500);
    if LIM.count(&format!("ireq:{uid}"), 3_600_000) >= limit("RELAY_INVITE_REQUESTS_PER_HOUR", 10) {
        return Err(too_many());
    }
    expire_stale(&st.db).await;
    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM invite_requests WHERE requester_id=$1 AND status='pending'").bind(uid).fetch_one(&st.db).await?;
    if pending >= MAX_PENDING {
        return Err(bad("Не больше трёх ожидающих запросов — дождитесь решения или отмените один"));
    }
    LIM.add(&format!("ireq:{uid}"));
    let id: i64 = sqlx::query_scalar("INSERT INTO invite_requests(requester_id, guild_id, invitee, comment, created_at) VALUES($1,$2,$3,$4,$5) RETURNING id")
        .bind(uid)
        .bind(b.guild_id)
        .bind(&invitee)
        .bind(&comment)
        .bind(now())
        .fetch_one(&st.db)
        .await?;
    notify_admins(&st, "request_new", id).await;
    Ok(Json(json!({ "id": id })))
}

/// GET /api/invite-requests/mine — мои запросы; у одобренных — ссылка, пока код действителен.
pub async fn my_requests(State(st): State<AppState>, Auth(uid): Auth) -> R {
    expire_stale(&st.db).await;
    let rows: Vec<(i64, Option<i64>, Option<String>, String, String, String, String, i64, Option<i64>, Option<String>, Option<i64>, Option<String>)> =
        sqlx::query_as(&format!(
            "SELECT r.id, r.guild_id, g.name, r.invitee, r.comment, r.status, r.reason, r.created_at, r.decided_at, ri.nonce, ri.expires_at, {CODE_STATE}
         FROM invite_requests r LEFT JOIN guilds g ON g.id=r.guild_id LEFT JOIN registration_invites ri ON ri.request_id=r.id
         WHERE r.requester_id=$2 ORDER BY r.id DESC LIMIT 100"
        ))
        .bind(now())
        .bind(uid)
        .fetch_all(&st.db)
        .await?;
    let items: Vec<Value> = rows.into_iter().map(|(id, gid, gname, invitee, comment, status, reason, created, decided, nonce, exp, code_state)| {
        let link = (code_state.as_deref() == Some("active")).then(|| nonce.as_deref().map(|n| link(&derived_code(n)))).flatten();
        json!({ "id": id, "guild": gid.map(|g| json!({ "id": g, "name": gname })), "invitee": invitee, "comment": comment, "status": status, "reason": reason,
                "created_at": created, "decided_at": decided, "code_state": code_state, "expires_at": exp, "link": link })
    }).collect();
    Ok(Json(json!({ "items": items, "max_pending": MAX_PENDING })))
}

/// POST /api/invite-requests/{id}/cancel — отменить свой запрос, пока он не решён.
pub async fn cancel_request(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    let n = sqlx::query("UPDATE invite_requests SET status='cancelled', decided_at=$3 WHERE id=$1 AND requester_id=$2 AND status='pending'")
        .bind(id)
        .bind(uid)
        .bind(now())
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(bad("Запрос уже решён или не найден"));
    }
    notify_admins(&st, "request_cancelled", id).await;
    Ok(Json(json!({ "ok": true })))
}

// ---------- администратор ----------

#[derive(Deserialize)]
pub struct ReqQuery {
    status: Option<String>,
}

/// GET /api/admin/invites/requests?status=pending|all — ожидающие сверху.
pub async fn admin_requests(State(st): State<AppState>, Auth(uid): Auth, Query(q): Query<ReqQuery>) -> R {
    admin(&st, uid).await?;
    expire_stale(&st.db).await;
    let only_pending = q.status.as_deref() != Some("all");
    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT json_build_object('id',r.id,'invitee',r.invitee,'comment',r.comment,'status',r.status,'reason',r.reason,'created_at',r.created_at,'decided_at',r.decided_at,
           'guild', CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object('id',g.id,'name',g.name) END,
           'requester', {}, 'decided_by', {})
         FROM invite_requests r JOIN users u ON u.id=r.requester_id LEFT JOIN users d ON d.id=r.decided_by LEFT JOIN guilds g ON g.id=r.guild_id
         WHERE ($1 = false OR r.status='pending')
         ORDER BY (r.status='pending') DESC, r.id DESC LIMIT 500", user_obj("u"), user_obj("d")))
        .bind(only_pending).fetch_all(&st.db).await?;
    let counts: Vec<(String, i64)> = sqlx::query_as("SELECT status, count(*) FROM invite_requests GROUP BY status").fetch_all(&st.db).await?;
    Ok(Json(json!({ "items": items, "counts": counts.into_iter().collect::<HashMap<_, _>>() })))
}

#[derive(Deserialize)]
pub struct Approve {
    days: Option<i64>,
}
/// POST /api/admin/invites/requests/{id}/approve — код, привязанный к запросу и серверу; ссылку видит автор.
pub async fn approve(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<Approve>) -> R {
    admin(&st, uid).await?;
    let ttl = days(b.days)?;
    expire_stale(&st.db).await;
    let mut tx = st.db.begin().await?;
    let (requester, guild, invitee): (i64, Option<i64>, String) = sqlx::query_as(
        "UPDATE invite_requests SET status='approved', decided_by=$2, decided_at=$3 WHERE id=$1 AND status='pending' RETURNING requester_id, guild_id, invitee",
    )
    .bind(id)
    .bind(uid)
    .bind(now())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| bad("Запрос уже решён или не найден"))?;
    let n = nonce();
    sqlx::query("INSERT INTO registration_invites(code_hash, nonce, created_by, request_id, target_guild_id, created_at, expires_at, note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(hash(&derived_code(&n))).bind(&n).bind(uid).bind(id).bind(guild).bind(now()).bind(now() + ttl).bind(format!("Запрос №{id}: {invitee}"))
        .execute(&mut *tx).await?;
    tx.commit().await?;
    eprintln!("приглашения: запрос №{id} одобрен (код выдан, срок {} дн.)", ttl / DAY);
    st.hub.send(&[requester], &json!({ "type": "invite_request_update", "id": id, "status": "approved", "invitee": invitee }));
    notify_admins(&st, "request_approved", id).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Reject {
    #[serde(default)]
    reason: String,
}
/// POST /api/admin/invites/requests/{id}/reject
pub async fn reject(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>, Json(b): Json<Reject>) -> R {
    admin(&st, uid).await?;
    let reason = clean(&b.reason, 300);
    let (requester, invitee): (i64, String) = sqlx::query_as(
        "UPDATE invite_requests SET status='rejected', reason=$4, decided_by=$2, decided_at=$3 WHERE id=$1 AND status='pending' RETURNING requester_id, invitee")
        .bind(id).bind(uid).bind(now()).bind(&reason).fetch_optional(&st.db).await?.ok_or_else(|| bad("Запрос уже решён или не найден"))?;
    st.hub.send(&[requester], &json!({ "type": "invite_request_update", "id": id, "status": "rejected", "invitee": invitee, "reason": reason }));
    notify_admins(&st, "request_rejected", id).await;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/admin/invites/codes — все коды с состоянием (сами коды не хранятся).
pub async fn admin_codes(State(st): State<AppState>, Auth(uid): Auth) -> R {
    admin(&st, uid).await?;
    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT json_build_object('id',ri.id,'note',ri.note,'state',{CODE_STATE},'created_at',ri.created_at,'expires_at',ri.expires_at,'revoked_at',ri.revoked_at,
           'used_at',ri.used_at,'request_id',ri.request_id,'from_request',ri.nonce IS NOT NULL,
           'guild', CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object('id',g.id,'name',g.name) END,
           'created_by', {}, 'used_by', {})
         FROM registration_invites ri LEFT JOIN users c ON c.id=ri.created_by LEFT JOIN users u ON u.id=ri.used_by LEFT JOIN guilds g ON g.id=ri.target_guild_id
         ORDER BY ({CODE_STATE}='active') DESC, ri.id DESC LIMIT 500", user_obj("c"), user_obj("u")))
        .bind(now()).fetch_all(&st.db).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct NewCode {
    #[serde(default)]
    note: String,
    days: Option<i64>,
    guild_id: Option<i64>,
}
/// Создать код вручную (API и CLI): (id, код, срок).
pub async fn create_code(db: &db::Db, by: Option<i64>, note: &str, ttl: i64, guild: Option<i64>) -> Result<(i64, String, i64), ApiError> {
    if let Some(g) = guild {
        let ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM guilds WHERE id=$1)").bind(g).fetch_one(db).await?;
        if !ok {
            return Err(bad("Нет такого сервера"));
        }
    }
    let code = random_code();
    let exp = now() + ttl;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO registration_invites(code_hash, created_by, target_guild_id, created_at, expires_at, note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    )
    .bind(hash(&code))
    .bind(by)
    .bind(guild)
    .bind(now())
    .bind(exp)
    .bind(clean(note, 200))
    .fetch_one(db)
    .await?;
    if std::env::var_os("RELAY_QUIET_CODES").is_none() {
        eprintln!("приглашения: создан код №{id} (срок {} дн.)", ttl / DAY);
    }
    Ok((id, code, exp))
}
/// POST /api/admin/invites/codes — код показывается один раз (в ответе).
pub async fn admin_create_code(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<NewCode>) -> R {
    admin(&st, uid).await?;
    let (id, code, exp) = create_code(&st.db, Some(uid), &b.note, days(b.days)?, b.guild_id).await?;
    Ok(Json(json!({ "id": id, "code": code, "link": link(&code), "expires_at": exp })))
}
pub async fn revoke_code(db: &db::Db, id: i64) -> Result<bool, ApiError> {
    Ok(sqlx::query("UPDATE registration_invites SET revoked_at=$2 WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL")
        .bind(id)
        .bind(now())
        .execute(db)
        .await?
        .rows_affected()
        > 0)
}
/// POST /api/admin/invites/codes/{id}/revoke
pub async fn admin_revoke(State(st): State<AppState>, Auth(uid): Auth, Path(id): Path<i64>) -> R {
    admin(&st, uid).await?;
    if !revoke_code(&st.db, id).await? {
        return Err(bad("Код уже использован, отозван или не найден"));
    }
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/admin/invites/history — кто кого пригласил, кто одобрил, когда зарегистрировался.
pub async fn admin_history(State(st): State<AppState>, Auth(uid): Auth) -> R {
    admin(&st, uid).await?;
    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT json_build_object('code_id',ri.id,'used_at',ri.used_at,'note',ri.note,'request_id',ri.request_id,'invitee',r.invitee,
           'user', {}, 'invited_by', {}, 'approved_by', {},
           'guild', CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object('id',g.id,'name',g.name) END)
         FROM registration_invites ri JOIN users nu ON nu.id=ri.used_by
         LEFT JOIN invite_requests r ON r.id=ri.request_id
         LEFT JOIN users inv ON inv.id=COALESCE(r.requester_id, ri.created_by)
         LEFT JOIN users ap ON ap.id=CASE WHEN r.id IS NULL THEN NULL ELSE r.decided_by END
         LEFT JOIN guilds g ON g.id=ri.target_guild_id
         WHERE ri.used_at IS NOT NULL ORDER BY ri.used_at DESC LIMIT 500",
        user_obj("nu"),
        user_obj("inv"),
        user_obj("ap")
    ))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({ "items": items })))
}

/// GET /api/admin/invites/guilds — все серверы (выбор сервера для автодобавления).
pub async fn admin_guilds(State(st): State<AppState>, Auth(uid): Auth) -> R {
    admin(&st, uid).await?;
    let items: Vec<Value> = sqlx::query_scalar("SELECT json_build_object('id',id,'name',name) FROM guilds ORDER BY name").fetch_all(&st.db).await?;
    Ok(Json(json!({ "items": items })))
}

// ---------- метрики ----------

pub async fn collect(db: &db::Db) {
    use crate::metrics::M;
    expire_stale(db).await;
    if let Ok(rows) = sqlx::query_as::<_, (String, i64)>("SELECT status, count(*) FROM invite_requests GROUP BY status").fetch_all(db).await {
        for s in ["pending", "approved", "rejected", "cancelled", "expired"] {
            M.invite_requests.with_label_values(&[s]).set(rows.iter().find(|r| r.0 == s).map_or(0, |r| r.1));
        }
    }
    if let Ok(rows) =
        sqlx::query_as::<_, (String, i64)>(&format!("SELECT {CODE_STATE}, count(*) FROM registration_invites ri GROUP BY 1")).bind(now()).fetch_all(db).await
    {
        for s in ["active", "used", "expired", "revoked"] {
            M.registration_invites.with_label_values(&[s]).set(rows.iter().find(|r| r.0 == s).map_or(0, |r| r.1));
        }
    }
}

// ---------- CLI на сервере: deploy/noxvc-admin → relay admin … ----------

fn ts(ms: i64) -> String {
    let s = ms / 1000;
    let (d, rem) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    // гражданская дата из дней с 1970-01-01 (алгоритм Х. Хиннанта)
    let z = d + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", rem / 3600, rem % 3600 / 60)
}

pub async fn cli(db: &db::Db, args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let opt = |name: &str| a.iter().position(|x| *x == name).and_then(|i| a.get(i + 1)).map(|s| s.to_string());
    let usage = "noxvc-admin invite create [--days N] [--note ТЕКСТ] [--guild ID] [--count N] [--quiet]\nnoxvc-admin invite list [--all]\nnoxvc-admin invite revoke ID\nnoxvc-admin requests list [--all]";
    match a.as_slice() {
        ["invite", "create", ..] => {
            let d = match opt("--days").map(|v| v.parse::<i64>()) {
                None => Ok(7),
                Some(Ok(v)) => Ok(v),
                Some(Err(_)) => Err(()),
            };
            let Ok(Ok(ttl)) = d.map(|v| days(Some(v))) else {
                eprintln!("--days: от 1 до 90");
                return 2;
            };
            let guild = opt("--guild").and_then(|v| v.parse().ok());
            // --count N — несколько кодов; --quiet — только коды, по одному в строке (для скриптов и тестовых стендов)
            let count = opt("--count").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).clamp(1, 500);
            let quiet = a.contains(&"--quiet");
            for _ in 0..count {
                match create_code(db, None, &opt("--note").unwrap_or_default(), ttl, guild).await {
                    Ok((_, code, _)) if quiet => println!("{code}"),
                    Ok((id, code, exp)) => println!("код №{id} (действует до {}):\n{code}\n{}", ts(exp), link(&code)),
                    Err(e) => {
                        eprintln!("ошибка: {}", e.1);
                        return 1;
                    }
                }
            }
            0
        }
        ["invite", "list", rest @ ..] => {
            let all = rest.contains(&"--all");
            let rows: Vec<(i64, String, String, i64, Option<String>, Option<String>)> = match sqlx::query_as(&format!(
                "SELECT ri.id, {CODE_STATE}, ri.note, ri.expires_at, u.username, g.name FROM registration_invites ri LEFT JOIN users u ON u.id=ri.used_by
                 LEFT JOIN guilds g ON g.id=ri.target_guild_id WHERE $2 OR {CODE_STATE}='active' ORDER BY ri.id DESC LIMIT 200"
            ))
            .bind(now())
            .bind(all)
            .fetch_all(db)
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("ошибка: {e}");
                    return 1;
                }
            };
            for (id, state, note, exp, used, guild) in &rows {
                println!(
                    "№{id:<5} {state:<8} до {}  {}{}{}",
                    ts(*exp),
                    note,
                    guild.as_deref().map(|g| format!("  → сервер «{g}»")).unwrap_or_default(),
                    used.as_deref().map(|u| format!("  использовал @{u}")).unwrap_or_default()
                );
            }
            if rows.is_empty() {
                println!("{}", if all { "кодов нет" } else { "активных кодов нет (все: --all)" });
            }
            0
        }
        ["invite", "revoke", id] => match id.parse::<i64>() {
            Ok(id) => match revoke_code(db, id).await {
                Ok(true) => {
                    println!("код №{id} отозван");
                    0
                }
                Ok(false) => {
                    eprintln!("код №{id} уже использован, отозван или не найден");
                    1
                }
                Err(e) => {
                    eprintln!("ошибка: {}", e.1);
                    1
                }
            },
            Err(_) => {
                eprintln!("{usage}");
                2
            }
        },
        ["requests", "list", rest @ ..] => {
            expire_stale(db).await;
            let all = rest.contains(&"--all");
            let rows: Vec<(i64, String, String, String, String, Option<String>, i64)> = match sqlx::query_as(
                "SELECT r.id, r.status, u.username, r.invitee, r.comment, g.name, r.created_at FROM invite_requests r JOIN users u ON u.id=r.requester_id
                 LEFT JOIN guilds g ON g.id=r.guild_id WHERE $1 OR r.status='pending' ORDER BY r.id DESC LIMIT 200",
            )
            .bind(all)
            .fetch_all(db)
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("ошибка: {e}");
                    return 1;
                }
            };
            for (id, status, by, invitee, comment, guild, at) in &rows {
                println!(
                    "№{id:<5} {status:<9} {}  @{by} зовёт «{invitee}» на «{}»{}",
                    ts(*at),
                    guild.as_deref().unwrap_or("—"),
                    if comment.is_empty() { String::new() } else { format!(" — {comment}") }
                );
            }
            if rows.is_empty() {
                println!("{}", if all { "запросов нет" } else { "ожидающих запросов нет (все: --all)" });
            }
            0
        }
        _ => {
            eprintln!("{usage}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limiter_window() {
        let l = Limiter { m: Mutex::new(HashMap::new()) };
        for _ in 0..3 {
            l.add("ip:a");
        }
        assert_eq!(l.count("ip:a", 60_000), 3);
        assert_eq!(l.count("ip:b", 60_000), 0, "ключи независимы");
        assert_eq!(l.count("ip:a", 0), 0, "за окном — не считаются");
    }
    #[test]
    fn codes() {
        let c = random_code();
        assert_eq!(c.len(), CODE_LEN);
        assert!(c.bytes().all(|b| ALPHABET.contains(&b)) && !c.contains(['0', 'O', '1', 'I', 'L']));
        assert_ne!(random_code(), c);
        assert!((CODE_LEN as f64) * 31f64.log2() >= 100.0, "энтропия ≥ 100 бит");
        // по запросу — детерминирован от nonce, разный для разных nonce
        assert_eq!(derived_code("abc"), derived_code("abc"));
        assert_ne!(derived_code("abc"), derived_code("abd"));
        assert_eq!(derived_code("abc").len(), CODE_LEN);
        // ввод: регистр, пробелы и дефисы не важны
        assert_eq!(hash(&c), hash(&format!(" {}-{} ", c[..12].to_lowercase(), &c[12..])));
        assert_eq!(hash(&c).len(), 64);
        assert_eq!(ts(0), "1970-01-01 00:00 UTC");
        assert_eq!(ts(1_794_960_000_000), "2026-11-18 00:00 UTC");
    }
}

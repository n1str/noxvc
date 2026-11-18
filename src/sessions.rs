//! Сеансы и журнал безопасности аккаунта.
//!
//! Сеанс — строка `sessions` (токен — только в БД и у клиента; наружу — публичный `id`). При входе записывается,
//! что за клиент (веб / приложение и версия — заголовок X-Relay-Client; ОС и браузер — из User-Agent), откуда
//! (IP, страна и город по базе DB-IP Lite), последняя активность — не чаще раза в минуту.
//!
//! Завершение сеанса — мгновенное: строка удаляется (любой запрос с токеном — 401), gateway-соединения этого сеанса
//! закрываются кодом 4004 (клиент выходит на экран входа), голос/трансляция с этого сеанса — кик из комнаты LiveKit;
//! повторный вход в комнату со старым токеном LiveKit отклоняется по вебхуку (в токене — номер сеанса).
//! Завершение и «все остальные» подтверждаются паролем. Всё — в журнал безопасности.
use crate::api::{bad, ApiError, AuthSession, R};
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::LazyLock;

/// Что известно о клиенте при входе.
#[derive(Default, Debug, PartialEq)]
pub struct ClientInfo {
    pub client: String,
    pub version: String,
    pub os: String,
    pub browser: String,
    pub ip: String,
    pub country: String,
    pub city: String,
}

/// Клиент из заголовков: X-Relay-Client «desktop/0.13.0» | «web»; User-Agent; IP — первый X-Forwarded-For (его ставит
/// Caddy, входящий от клиента он не принимает) или X-Real-IP.
pub fn client_info(h: &HeaderMap) -> ClientInfo {
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").trim();
    let ua = get("user-agent");
    let (client, version) = match get("x-relay-client").split_once('/') {
        Some(("desktop", v)) => ("desktop", clip(v, 20)),
        _ if get("x-relay-client") == "desktop" => ("desktop", String::new()),
        _ => ("web", String::new()),
    };
    let ip = get("x-forwarded-for").split(',').next().unwrap_or("").trim().parse::<IpAddr>().ok().or_else(|| get("x-real-ip").parse::<IpAddr>().ok());
    let (country, city) = ip.map(geo).unwrap_or_default();
    ClientInfo {
        client: client.into(),
        version,
        os: os_of(ua).into(),
        browser: if client == "desktop" { "NoxVC Desktop".into() } else { browser_of(ua) },
        ip: ip.map(|i| i.to_string()).unwrap_or_default(),
        country,
        city,
    }
}
fn clip(s: &str, n: usize) -> String {
    s.chars().filter(|c| c.is_ascii_graphic()).take(n).collect()
}

pub fn os_of(ua: &str) -> &'static str {
    if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iPod") {
        "iOS"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "macOS"
    } else if ua.contains("CrOS") {
        "ChromeOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    }
}
/// Браузер и основная версия: «Chrome 142», «Яндекс Браузер 25», «Firefox 145».
pub fn browser_of(ua: &str) -> String {
    let ver = |key: &str| ua.split(key).nth(1).map(|r| r.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("").to_string()).filter(|v| !v.is_empty());
    for (key, name) in [("YaBrowser/", "Яндекс Браузер"), ("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome")] {
        if let Some(v) = ver(key) {
            return format!("{name} {v}");
        }
    }
    if ua.contains("Safari/") {
        return ver("Version/").map(|v| format!("Safari {v}")).unwrap_or_else(|| "Safari".into());
    }
    String::new()
}

/// IP для показа: часть скрыта — 198.51.*.*, 2a00:1370:*.
pub fn mask_ip(ip: &str) -> String {
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v)) => {
            let o = v.octets();
            format!("{}.{}.*.*", o[0], o[1])
        }
        Ok(IpAddr::V6(v)) => {
            let s = v.segments();
            format!("{:x}:{:x}:*", s[0], s[1])
        }
        Err(_) => String::new(),
    }
}

// ---------- местоположение (DB-IP Lite, mmdb) ----------
static GEO: LazyLock<Option<maxminddb::Reader<Vec<u8>>>> = LazyLock::new(|| {
    let path = std::env::var("RELAY_GEOIP_DB").ok()?;
    match maxminddb::Reader::open_readfile(&path) {
        Ok(r) => {
            println!("GeoIP: {path}");
            Some(r)
        }
        Err(e) => {
            eprintln!("GeoIP ({path}): {e} — местоположение сеансов не определяется");
            None
        }
    }
});
/// Страна и город по-русски (если в базе нет — по-английски). Частные адреса — пусто.
fn geo(ip: IpAddr) -> (String, String) {
    let private = match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00,
    };
    if private {
        return (String::new(), String::new());
    }
    let Some(r) = GEO.as_ref() else { return Default::default() };
    let Ok(Some(c)) = r.lookup(ip).and_then(|l| l.decode::<maxminddb::geoip2::City>()) else { return Default::default() };
    let name = |n: &maxminddb::geoip2::Names| n.russian.or(n.english).unwrap_or("").to_string();
    // в бесплатной базе город — по-английски и иногда с округом в скобках: «Moscow (Tsentralnyy administrativnyy okrug)»
    let city = name(&c.city.names);
    (name(&c.country.names), city.split(" (").next().unwrap_or("").trim().to_string())
}

// ---------- журнал безопасности ----------
pub async fn log(db: &crate::db::Db, uid: i64, event: &str, session: Option<i64>, by: Option<i64>, ip: &str, details: Value) {
    let r = sqlx::query("INSERT INTO security_log(user_id, at, event, session_id, by_session, ip, details) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(uid)
        .bind(crate::now())
        .bind(event)
        .bind(session)
        .bind(by)
        .bind(mask_ip(ip))
        .bind(details)
        .execute(db)
        .await;
    if let Err(e) = r {
        eprintln!("журнал безопасности: {e}");
    }
}

// ---------- завершение ----------
/// Завершить сеансы пользователя (по номерам): строки удаляются, gateway закрывается, голос с них — кик.
/// Возвращает, какие действительно были.
pub async fn revoke(st: &AppState, uid: i64, ids: &[i64]) -> Result<Vec<i64>, ApiError> {
    let gone: Vec<i64> =
        sqlx::query_scalar("DELETE FROM sessions WHERE user_id=$1 AND id = ANY($2) RETURNING id").bind(uid).bind(ids).fetch_all(&st.db).await?;
    for id in &gone {
        st.hub.gw.kick_auth(*id);
        if st.hub.voice_auth(uid) == Some(*id) {
            let evicted = st.hub.evict_voice(&st.db, |u, _, _| u == uid).await;
            crate::api::kick_from_livekit(st, evicted);
        }
    }
    Ok(gone)
}

async fn confirm_password(st: &AppState, uid: i64, pw: &str) -> Result<(), ApiError> {
    crate::social::verify_password(st, uid, pw).await.map_err(|_| ApiError(axum::http::StatusCode::FORBIDDEN, "Неверный пароль".into()))
}

// ---------- API ----------
/// GET /api/sessions — свои сеансы (текущий помечен); IP — частично скрыт.
pub async fn list(State(st): State<AppState>, a: AuthSession) -> R {
    type Row = (i64, String, String, String, String, String, String, String, i64, Option<i64>);
    let rows: Vec<Row> = sqlx::query_as("SELECT id, client, version, os, browser, ip, country, city, created_at, last_seen FROM sessions WHERE user_id=$1 ORDER BY COALESCE(last_seen, created_at) DESC")
        .bind(a.uid).fetch_all(&st.db).await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, client, version, os, browser, ip, country, city, created, seen)| {
            json!({
                "id": id, "current": id == a.session, "client": client, "version": version, "os": os, "browser": browser,
                "ip": mask_ip(&ip), "country": country, "city": city, "created_at": created, "last_seen": seen.unwrap_or(created),
            })
        })
        .collect();
    Ok(Json(json!({ "sessions": list })))
}

#[derive(Deserialize)]
pub struct Confirm {
    password: String,
}

/// DELETE /api/sessions/{id} — завершить один сеанс (не текущий: для него — «Выйти»), с паролем.
pub async fn revoke_one(State(st): State<AppState>, a: AuthSession, headers: HeaderMap, Path(id): Path<i64>, Json(b): Json<Confirm>) -> R {
    if id == a.session {
        return Err(bad("Это текущий сеанс — используйте «Выйти»"));
    }
    confirm_password(&st, a.uid, &b.password).await?;
    let gone = revoke(&st, a.uid, &[id]).await?;
    if gone.is_empty() {
        return Err(crate::api::not_found());
    }
    log(&st.db, a.uid, "session_revoked", Some(id), Some(a.session), &client_info(&headers).ip, json!({})).await;
    Ok(Json(json!({ "revoked": gone })))
}

/// POST /api/sessions/revoke-others — завершить все сеансы, кроме текущего, с паролем.
pub async fn revoke_others(State(st): State<AppState>, a: AuthSession, headers: HeaderMap, Json(b): Json<Confirm>) -> R {
    confirm_password(&st, a.uid, &b.password).await?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM sessions WHERE user_id=$1 AND id<>$2").bind(a.uid).bind(a.session).fetch_all(&st.db).await?;
    let gone = revoke(&st, a.uid, &ids).await?;
    log(&st.db, a.uid, "sessions_revoked", None, Some(a.session), &client_info(&headers).ip, json!({ "count": gone.len() })).await;
    Ok(Json(json!({ "revoked": gone })))
}

/// GET /api/security-log — последние 100 событий своего аккаунта.
pub async fn security_log(State(st): State<AppState>, a: AuthSession) -> R {
    let rows: Vec<(i64, i64, String, Option<i64>, Option<i64>, String, Value)> =
        sqlx::query_as("SELECT id, at, event, session_id, by_session, ip, details FROM security_log WHERE user_id=$1 ORDER BY at DESC, id DESC LIMIT 100")
            .bind(a.uid)
            .fetch_all(&st.db)
            .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, at, event, s, by, ip, details)| {
            json!({
                "id": id, "at": at, "event": event, "session_id": s, "by_session": by, "by_current": by == Some(a.session), "ip": ip, "details": details,
            })
        })
        .collect();
    Ok(Json(json!({ "events": list })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_agents() {
        let chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
        assert_eq!((os_of(chrome), browser_of(chrome).as_str()), ("Windows", "Chrome 142"));
        let ya = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 YaBrowser/25.8.0.0 Safari/537.36";
        assert_eq!(browser_of(ya), "Яндекс Браузер 25");
        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
        assert_eq!(browser_of(edge), "Edge 142");
        let ff = "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0";
        assert_eq!((os_of(ff), browser_of(ff).as_str()), ("Linux", "Firefox 145"));
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
        assert_eq!((os_of(iphone), browser_of(iphone).as_str()), ("iOS", "Safari 18"));
        let android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
        assert_eq!(os_of(android), "Android");
        assert_eq!((os_of(""), browser_of("").as_str()), ("", ""));
    }
    #[test]
    fn ip_masking_and_headers() {
        assert_eq!(mask_ip("198.51.100.23"), "198.51.*.*");
        assert_eq!(mask_ip("2a00:1370:8180::1"), "2a00:1370:*");
        assert_eq!(mask_ip("мусор"), "");
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "192.168.1.10, 10.0.0.1".parse().unwrap());
        h.insert("x-relay-client", "desktop/0.13.0".parse().unwrap());
        h.insert("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Edg/142.0.0.0".parse().unwrap());
        let c = client_info(&h);
        assert_eq!(
            (c.client.as_str(), c.version.as_str(), c.browser.as_str(), c.os.as_str(), c.ip.as_str()),
            ("desktop", "0.13.0", "NoxVC Desktop", "Windows", "192.168.1.10")
        );
        assert_eq!((c.country.as_str(), c.city.as_str()), ("", ""), "частный адрес — без местоположения");
        h.insert("x-relay-client", "web".parse().unwrap());
        assert_eq!(client_info(&h).browser, "Edge 142");
    }
}

#[cfg(test)]
mod geo_tests {
    /// Настоящая база (RELAY_GEOIP_DB): известные адреса → страна/город по-русски. Без базы — пропуск.
    #[test]
    fn geo_lookup_real_db() {
        if std::env::var("RELAY_GEOIP_DB").is_err() {
            eprintln!("RELAY_GEOIP_DB не задана — пропуск");
            return;
        }
        let (country, city) = super::geo("77.88.8.8".parse().unwrap()); // Яндекс DNS
        assert_eq!(country, "Россия", "город: {city}");
        assert!(!city.contains('('), "без округа в скобках: {city}");
        let (country, _) = super::geo("8.8.8.8".parse().unwrap());
        assert!(!country.is_empty() && country != "Россия", "{country}");
        assert_eq!(super::geo("192.168.1.1".parse().unwrap()), (String::new(), String::new()));
        eprintln!("77.88.8.8 → {:?}; 1.1.1.1 → {:?}", super::geo("77.88.8.8".parse().unwrap()), super::geo("1.1.1.1".parse().unwrap()));
    }
}

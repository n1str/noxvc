//! Публичные страницы домена: приглашение со превью (OpenGraph) и ссылка на актуальный установщик.
//!
//! - GET /invite/{code} — открывается по ссылке https://example.com/invite/КОД (Caddy проводит её сюда): мессенджеры
//!   показывают превью «Приглашение на сервер …», человек сразу попадает в приложение (app.example.com/#invite/КОД).
//!   Наружу — только название сервера и число участников (как и при открытии приглашения в приложении).
//! - GET /download/windows — переход на текущий установщик NoxVC Desktop (из updates/latest.json).
//!
//! Адреса — RELAY_APP_URL (по умолчанию http://localhost:8080) и RELAY_SITE_URL (по умолчанию — RELAY_APP_URL).
use crate::{now, AppState};
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use serde_json::Value;

pub fn app_url() -> String {
    std::env::var("RELAY_APP_URL").unwrap_or_else(|_| "http://localhost:8080".into()).trim_end_matches('/').to_string()
}
pub fn site_url() -> String {
    std::env::var("RELAY_SITE_URL").map(|s| s.trim_end_matches('/').to_string()).unwrap_or_else(|_| app_url())
}

pub fn esc(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&#39;".into(),
            c => c.to_string(),
        })
        .collect()
}
fn valid_code(c: &str) -> bool {
    !c.is_empty() && c.len() <= 32 && c.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Страница приглашения: превью для мессенджеров и переход в приложение.
pub fn invite_html(code: &str, guild: Option<(&str, i64)>) -> String {
    let (app, site) = (app_url(), site_url());
    let target = format!("{app}/#invite/{code}");
    let (title, desc) = match guild {
        Some((name, n)) => (format!("Приглашение на сервер «{name}»"), format!("{n} {} · NoxVC", plural(n))),
        None => ("Приглашение недействительно".to_string(), "Срок действия истёк или приглашение отозвано.".to_string()),
    };
    let (t, d, u) = (esc(&title), esc(&desc), esc(&format!("{site}/invite/{code}")));
    let go = if guild.is_some() {
        format!(
            r#"<meta http-equiv="refresh" content="0; url={0}"><script>location.replace({1})</script>"#,
            esc(&target),
            serde_json::to_string(&target).unwrap_or_default().replace('<', "\\u003c")
        )
    } else {
        String::new()
    };
    format!(
        r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title><meta name="description" content="{d}"><meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="website"><meta property="og:site_name" content="NoxVC"><meta property="og:title" content="{t}">
<meta property="og:description" content="{d}"><meta property="og:url" content="{u}"><meta property="og:image" content="{site}/og.png"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
{go}<style>body{{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#16161a;color:#eee}}a{{color:#8ab4ff}}@media (prefers-color-scheme:light){{body{{background:#f4f4f7;color:#222}}a{{color:#0a58ca}}}}</style></head>
<body><main><h1>{t}</h1><p>{d}</p><p><a href="{href}">Открыть NoxVC</a></p></main></body></html>"#,
        href = esc(if guild.is_some() { &target } else { &app })
    )
}
fn plural(n: i64) -> &'static str {
    let (a, b) = (n % 10, n % 100);
    if a == 1 && b != 11 {
        "участник"
    } else if (2..=4).contains(&a) && !(12..=14).contains(&b) {
        "участника"
    } else {
        "участников"
    }
}

/// GET /invite/{code}
pub async fn invite_page(State(st): State<AppState>, Path(code): Path<String>) -> Response {
    let guild: Option<(String, i64)> = if valid_code(&code) {
        sqlx::query_as(
            "SELECT g.name, (SELECT COUNT(*) FROM members WHERE guild_id=g.id) FROM invites i JOIN guilds g ON g.id=i.guild_id
            WHERE i.code=$1 AND (i.expires_at IS NULL OR i.expires_at > $2) AND (i.max_uses = 0 OR i.uses < i.max_uses)",
        )
        .bind(&code)
        .bind(now())
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    let code = if valid_code(&code) { code } else { String::new() };
    let status = if guild.is_some() { StatusCode::OK } else { StatusCode::NOT_FOUND };
    (status, [(header::CACHE_CONTROL, "no-cache")], Html(invite_html(&code, guild.as_ref().map(|(n, c)| (n.as_str(), *c))))).into_response()
}

/// GET /download/windows — текущий установщик (updates/latest.json → file).
pub async fn download_windows() -> Response {
    let dir = std::path::PathBuf::from(std::env::var("RELAY_DATA").unwrap_or_else(|_| "data".into())).join("updates");
    let file = std::fs::read(dir.join("latest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["file"].as_str().map(str::to_string))
        .filter(|f| f.ends_with(".exe") && !f.contains(['/', '\\']) && !f.starts_with('.'));
    match file {
        Some(f) => ([(header::CACHE_CONTROL, "no-cache")], Redirect::temporary(&format!("/updates/{f}"))).into_response(),
        None => (StatusCode::NOT_FOUND, "Установщик ещё не опубликован").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invite_page_escapes_and_links() {
        std::env::set_var("RELAY_APP_URL", "https://app.example.com");
        std::env::set_var("RELAY_SITE_URL", "https://example.com");
        let h = invite_html("abc123", Some(("<b>Ночной \"дозор\"</b>", 21)));
        assert!(h.contains("Приглашение на сервер «&lt;b&gt;Ночной &quot;дозор&quot;&lt;/b&gt;»"), "{h}");
        assert!(!h.contains("<b>Ночной"));
        assert!(h.contains("21 участник ·"));
        assert!(
            h.contains(r#"content="0; url=https://app.example.com/#invite/abc123""#) && h.contains("og:url\" content=\"https://example.com/invite/abc123\"")
        );
        let bad = invite_html("", None);
        assert!(bad.contains("недействительно") && !bad.contains("http-equiv"), "недействительное — без перехода");
        assert_eq!((plural(1), plural(3), plural(5), plural(11), plural(22)), ("участник", "участника", "участников", "участников", "участника"));
        assert!(valid_code("aZ09") && !valid_code("../x") && !valid_code("") && !valid_code(&"a".repeat(33)));
    }
}

//! Превью ссылок (фаза 3d): ссылки из сообщения → карточки (OpenGraph), картинки, YouTube.
//!
//! Защита от SSRF — сервер ходит только в публичный интернет:
//! - схемы http/https, порты 80/443;
//! - все адреса, в которые резолвится имя, должны быть публичными (не loopback/частные/link-local/CGNAT/ULA/…);
//! - соединение идёт на проверенный адрес (resolve-override) — DNS rebinding не сработает;
//! - редиректы обрабатываются вручную, каждый шаг проверяется заново (не больше 4);
//! - таймауты, лимит тела, только text/html и image/*; без прокси из окружения.
//!
//! Для тестов адреса вида host:port можно разрешить через RELAY_PREVIEW_ALLOW (через запятую).

use crate::{db, AppState};
use reqwest::{header, redirect::Policy, Url};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Semaphore;

const MAX_LINKS: usize = 5;
const MAX_BODY: usize = 768 * 1024;
const CACHE_MS: i64 = 6 * 3600 * 1000;
const UA: &str = "Mozilla/5.0 (compatible; RelayBot/1.0; link preview)";

fn sem() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(8))
}

fn allow() -> &'static [String] {
    static A: OnceLock<Vec<String>> = OnceLock::new();
    A.get_or_init(|| std::env::var("RELAY_PREVIEW_ALLOW").unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// Ссылки вне блоков кода; `<https://…>` — без превью (как в Discord).
pub fn extract_urls(content: &str) -> Vec<String> {
    let mut text = String::new();
    for (i, block) in content.split("```").enumerate() {
        if i % 2 == 1 {
            continue;
        }
        for (j, part) in block.split('`').enumerate() {
            if j % 2 == 0 {
                text.push_str(part);
                text.push(' ');
            }
        }
    }
    let mut out: Vec<String> = vec![];
    let mut rest = text.as_str();
    while let Some(pos) = rest.find("http") {
        let tail = &rest[pos..];
        let suppressed = rest[..pos].ends_with('<');
        if !(tail.starts_with("http://") || tail.starts_with("https://")) {
            rest = &tail[4..];
            continue;
        }
        let end = tail.find(|c: char| c.is_whitespace() || c == '<' || c == '>').unwrap_or(tail.len());
        let mut url = &tail[..end];
        loop {
            let trimmed = url.trim_end_matches(['.', ',', ':', ';', '!', '?', '\'', '"', ']']);
            let trimmed =
                if trimmed.ends_with(')') && trimmed.matches('(').count() < trimmed.matches(')').count() { &trimmed[..trimmed.len() - 1] } else { trimmed };
            if trimmed == url {
                break;
            }
            url = trimmed;
        }
        if !suppressed && Url::parse(url).is_ok() && !out.iter().any(|u| u == url) && out.len() < MAX_LINKS {
            out.push(url.to_string());
        }
        rest = &tail[end..];
    }
    out
}

/// Можно ли серверу ходить на этот адрес.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            !(a.is_private() || a.is_loopback() || a.is_link_local() || a.is_broadcast() || a.is_multicast() || a.is_unspecified()
                || a.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0/24
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18/15
                || o[0] >= 240)
        }
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = a.segments();
            let embedded = |hi: u16, lo: u16| IpAddr::V4(Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8));
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                return is_public(embedded(s[6], s[7]));
            } // NAT64
            if s[0] == 0x2002 {
                return is_public(embedded(s[1], s[2]));
            } // 6to4
            !(a.is_loopback() || a.is_unspecified() || a.is_multicast()
                || s[0..6] == [0, 0, 0, 0, 0, 0] // ::a.b.c.d и прочее «нулевое»
                || (s[0] & 0xfe00) == 0xfc00 // ULA
                || (s[0] & 0xffc0) == 0xfe80 // link-local
                || (s[0] == 0x2001 && s[1] == 0x0db8)) // документация
        }
    }
}

/// GET с проверкой каждого шага (см. заголовок модуля).
async fn safe_get(mut url: Url, accept: &str) -> Option<(Url, reqwest::Response)> {
    for _ in 0..5 {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        let host = url.host_str()?.trim_start_matches('[').trim_end_matches(']').to_string();
        let port = url.port_or_known_default()?;
        let allowed = allow().iter().any(|a| *a == format!("{host}:{port}"));
        if !allowed && port != 80 && port != 443 {
            return None;
        }
        let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host.as_str(), port))).await.ok()?.ok()?.collect(),
        };
        if addrs.is_empty() || (!allowed && !addrs.iter().all(|a| is_public(a.ip()))) {
            return None;
        }
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(6))
            .resolve(&host, addrs[0])
            .user_agent(UA)
            .build()
            .ok()?;
        let resp = client.get(url.clone()).header(header::ACCEPT, accept).header(header::ACCEPT_LANGUAGE, "ru,en;q=0.8").send().await.ok()?;
        if resp.status().is_redirection() {
            let loc = resp.headers().get(header::LOCATION)?.to_str().ok()?;
            url = url.join(loc).ok()?;
            continue;
        }
        return resp.status().is_success().then_some((url, resp));
    }
    None
}

/// Тело с лимитом; для HTML достаточно <head>.
async fn read_body(mut resp: reqwest::Response, html: bool) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(6), resp.chunk()).await.ok()?.ok()? {
        buf.extend_from_slice(&chunk);
        if buf.len() >= MAX_BODY {
            buf.truncate(MAX_BODY);
            break;
        }
        if html && buf.windows(7).any(|w| w.eq_ignore_ascii_case(b"</head>")) {
            break;
        }
    }
    Some(buf)
}

const CP1251_HI: &str = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—?™љ›њќћџ\u{a0}ЎўЈ¤Ґ¦§Ё©Є«¬\u{ad}®Ї°±Ііґµ¶·ё№є»јЅѕї";

/// UTF-8 или windows-1251 (частая кодировка русских сайтов).
pub fn decode(bytes: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    let ct = content_type.to_ascii_lowercase();
    let is_1251 =
        ["windows-1251", "cp1251"].iter().any(|c| ct.contains(c) || head.contains(&format!("charset={c}")) || head.contains(&format!("charset=\"{c}")));
    if !is_1251 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let hi: Vec<char> = CP1251_HI.chars().collect();
    bytes
        .iter()
        .map(|&b| match b {
            0..=0x7f => b as char,
            0x80..=0xbf => hi[(b - 0x80) as usize],
            _ => char::from_u32(0x410 + (b as u32 - 0xc0)).unwrap_or('?'),
        })
        .collect()
}

fn entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.char_indices().take(12).find(|(_, c)| *c == ';').map(|(i, _)| i) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..end];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "laquo" => Some('«'),
            "raquo" => Some('»'),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn attrs(tag: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let b = tag.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let s = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        let name = tag[s..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let vs = i + 1;
                i = vs;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = tag[vs..i.min(b.len())].to_string();
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = tag[vs..i].to_string();
            }
        }
        if !name.is_empty() {
            out.entry(name).or_insert_with(|| entities(&value));
        }
        if i == s {
            i += 1;
        }
    }
    out
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

/// OpenGraph/Twitter/обычные мета-теги → карточка. None — нечего показать.
pub fn parse_html(html: &str, url: &Url) -> Option<Value> {
    let lower = html.to_ascii_lowercase(); // та же длина в байтах — индексы совпадают
    let end = lower.find("</head>").or_else(|| lower.find("<body")).unwrap_or(lower.len());
    let (html, lower) = (&html[..end], &lower[..end]);
    let mut meta: HashMap<String, String> = HashMap::new();
    let mut from = 0;
    while let Some(p) = lower[from..].find("<meta") {
        let s = from + p + 5;
        let Some(e) = lower[s..].find('>') else { break };
        let a = attrs(&html[s..s + e]);
        if let (Some(k), Some(v)) = (a.get("property").or_else(|| a.get("name")).or_else(|| a.get("itemprop")), a.get("content")) {
            if !v.is_empty() {
                meta.entry(k.to_ascii_lowercase()).or_insert_with(|| v.clone());
            }
        }
        from = s + e;
    }
    let title_tag = lower.find("<title").and_then(|p| {
        let s = p + lower[p..].find('>')? + 1;
        let e = s + lower[s..].find("</title")?;
        Some(entities(&html[s..e]))
    });
    let get = |keys: &[&str]| keys.iter().find_map(|k| meta.get(*k).cloned());
    let title = get(&["og:title", "twitter:title"]).or(title_tag).filter(|t| !t.is_empty());
    let description = get(&["og:description", "twitter:description", "description"]);
    let image = get(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"])
        .and_then(|i| url.join(&i).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"));
    if title.is_none() && description.is_none() && image.is_none() {
        return None;
    }
    let site = get(&["og:site_name"]).unwrap_or_else(|| url.host_str().unwrap_or("").trim_start_matches("www.").to_string());
    let color = get(&["theme-color"]).filter(|c| c.len() <= 9 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()));
    let large = get(&["twitter:card"]).is_some_and(|c| c == "summary_large_image");
    Some(json!({
        "type": "link", "url": url.as_str(), "title": title.map(|t| trunc(&t, 256)), "description": description.map(|d| trunc(&d, 350)),
        "site_name": trunc(&site, 64), "image": image.map(|u| json!({ "url": u.as_str() })), "color": color, "large_image": large,
    }))
}

/// Идентификатор видео YouTube из ссылки.
pub fn youtube_id(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("music.");
    let mut seg = url.path_segments()?;
    let id = match host {
        "youtu.be" => seg.next()?.to_string(),
        "youtube.com" | "youtube-nocookie.com" => match seg.next()? {
            "watch" => url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned(),
            "shorts" | "embed" | "live" | "v" => seg.next()?.to_string(),
            _ => return None,
        },
        _ => return None,
    };
    (id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(id)
}

async fn fetch_preview(raw: &str) -> Option<Value> {
    let url = Url::parse(raw).ok()?;
    if let Some(id) = youtube_id(&url) {
        // Название — через oEmbed (тот же безопасный путь); без него карточка всё равно будет.
        let oembed = Url::parse_with_params("https://www.youtube.com/oembed", &[("format", "json"), ("url", raw)]).ok()?;
        let info: Option<Value> = match safe_get(oembed, "application/json").await {
            Some((_, r)) => read_body(r, false).await.and_then(|b| serde_json::from_slice(&b).ok()),
            None => None,
        };
        let s = |k: &str| info.as_ref().and_then(|i| i[k].as_str()).map(|x| trunc(x, 256));
        return Some(json!({
            "type": "video", "provider": "youtube", "video_id": id, "url": raw, "site_name": "YouTube", "color": "#ff0033",
            "title": s("title"), "author": s("author_name"),
            "image": { "url": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg") },
        }));
    }
    let (final_url, resp) = safe_get(url, "text/html,application/xhtml+xml,image/*;q=0.8").await?;
    let ct = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if ct.starts_with("image/") {
        return Some(json!({ "type": "image", "url": raw, "image": { "url": final_url.as_str() } }));
    }
    if !(ct.starts_with("text/html") || ct.starts_with("application/xhtml")) {
        return None;
    }
    let body = read_body(resp, true).await?;
    let mut card = parse_html(&decode(&body, &ct), &final_url)?;
    card["url"] = json!(raw);
    Some(card)
}

/// Превью с кэшем (в т.ч. «отрицательным»: у ссылки нечего показать).
async fn preview(db: &db::Db, url: &str) -> Option<Value> {
    let now = crate::now();
    if let Ok(Some((data, at))) =
        sqlx::query_as::<_, (Option<Value>, i64)>("SELECT data, fetched_at FROM link_previews WHERE url=$1").bind(url).fetch_optional(db).await
    {
        if now - at < CACHE_MS {
            return data;
        }
    }
    let data = {
        let _permit = sem().acquire().await.ok()?;
        fetch_preview(url).await
    };
    let _ = sqlx::query("INSERT INTO link_previews(url, data, fetched_at) VALUES($1, $2, $3) ON CONFLICT (url) DO UPDATE SET data=EXCLUDED.data, fetched_at=EXCLUDED.fetched_at")
        .bind(url).bind(&data).bind(now).execute(db).await;
    data
}

/// Собрать превью для сообщения в фоне и разослать обновление.
pub fn spawn(st: AppState, msg: i64, content: String) {
    tokio::spawn(async move {
        if let Err(e) = process(&st, msg, &content).await {
            eprintln!("превью ссылок для {msg}: {e}");
        }
    });
}

async fn process(st: &AppState, msg: i64, content: &str) -> anyhow_lite::Result<()> {
    let mut embeds = vec![];
    for url in extract_urls(content) {
        if let Some(e) = preview(&st.db, &url).await {
            embeds.push(e);
        }
    }
    let embeds = Value::Array(embeds);
    // Обновляем, только если текст не поменялся за время загрузки и превью действительно изменились.
    let row: Option<(Value, i64)> = sqlx::query_as("UPDATE messages SET embeds=$1 WHERE id=$2 AND content=$3 AND embeds <> $1 RETURNING embeds, channel_id")
        .bind(&embeds)
        .bind(msg)
        .bind(content)
        .fetch_optional(&st.db)
        .await?;
    let Some((_, ch)) = row else { return Ok(()) };
    let Some(c) = db::channel(&st.db, ch).await? else { return Ok(()) };
    let m = db::message_json(&st.db, msg).await?;
    st.hub.send(&db::channel_audience(&st.db, &c).await?, &json!({ "type": "message_update", "message": m }));
    Ok(())
}

/// Минимальный «anyhow»: любые ошибки как Box<dyn Error>.
mod anyhow_lite {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let u = extract_urls("см. https://a.ru/x, и (https://b.ru/y) и <https://c.ru> `https://d.ru` ```\nhttps://e.ru\n``` https://a.ru/x https://f.ru/w_(z)");
        assert_eq!(u, ["https://a.ru/x", "https://b.ru/y", "https://f.ru/w_(z)"]);
        assert!(extract_urls("httpx и http:/bad").is_empty());
    }

    #[test]
    fn ssrf_ranges() {
        for bad in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.20",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::",
            "::127.0.0.1",
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad} должен быть закрыт");
        }
        for good in ["8.8.8.8", "1.1.1.1", "2a00:1450:4010:c05::8b", "::ffff:8.8.8.8"] {
            assert!(is_public(good.parse().unwrap()), "{good} должен быть открыт");
        }
    }

    #[test]
    fn html() {
        let page = r##"<html><head><meta charset="utf-8"><title>Запас</title>
            <meta property="og:title" content="Новость &laquo;дня&raquo;"><meta name=description content='Описание &amp; детали'>
            <meta property="og:image" content="/img/a.png"><meta name="theme-color" content="#3366ff"></head><body><meta property="og:title" content="нет"></body>"##;
        let base = Url::parse("https://news.example.ru/a/b").unwrap();
        let c = parse_html(page, &base).unwrap();
        assert_eq!(c["title"], "Новость «дня»");
        assert_eq!(c["description"], "Описание & детали");
        assert_eq!(c["image"]["url"], "https://news.example.ru/img/a.png");
        assert_eq!(c["site_name"], "news.example.ru");
        assert_eq!(c["color"], "#3366ff");
        assert!(parse_html("<html><head></head><body>пусто</body></html>", &base).is_none());
        assert!(parse_html(r#"<head><meta property="og:image" content="javascript:alert(1)"><title>t</title></head>"#, &base).unwrap()["image"].is_null());
    }

    #[test]
    fn cp1251() {
        let bytes = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xa8, 0xb8];
        assert_eq!(decode(&bytes, "text/html; charset=windows-1251"), "Привет Ёё");
        assert_eq!(CP1251_HI.chars().count(), 64);
    }

    #[test]
    fn youtube() {
        let id = |s: &str| youtube_id(&Url::parse(s).unwrap());
        assert_eq!(id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(id("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(id("https://m.youtube.com/shorts/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(id("https://youtube.com/watch?v=short"), None);
        assert_eq!(id("https://evil.com/watch?v=dQw4w9WgXcQ"), None);
    }
}

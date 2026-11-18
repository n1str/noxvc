//! Точки входа Relay (регионы): основной узел (Россия) и edge-узлы (Нидерланды, …) — один и тот же Relay
//! (аккаунты, серверы, голосовые комнаты общие), разный сетевой путь.
//!
//! Выбор (раздел «Автоматический выбор региона»):
//! - при запуске проверяются все точки входа параллельно: TLS (закреплённый ключ или публичный CA с проверкой имени),
//!   и что за ней отвечает сам Relay (через edge — значит, и межузловой канал к основному узлу жив); время ответа;
//! - выбирается самая быстрая, но прежняя остаётся, пока она работает и не заметно медленнее (без лишних переключений);
//! - предпочтение пользователя («Россия»/«Нидерланды») соблюдается, пока эта точка входа доступна;
//! - отказ во время работы: страница сообщает о долгой потере связи — если текущая точка входа не отвечает,
//!   приложение переходит на доступную (вход и голосовой канал переносятся).
//!
//! У каждой точки входа свой origin (и свой localStorage страницы), поэтому вход хранит приложение
//! (session.json, зашифрован DPAPI текущего пользователя Windows).
use crate::pin::{self, Trust};
use serde::Serialize;
use std::sync::Mutex;

/// Точки входа: «id=https://адрес[#pin][#fallback]» через запятую; #pin — сертификат проверяется по закреплённым
/// ключам (сервер по IP), иначе — публичным CA; #fallback — запасная: выбирается, только если основные не работают
/// (или её выбрал пользователь). Задаётся при сборке: RELAY_ENDPOINTS=…
/// Пример: «main=https://app.example.com,main-ip=https://203.0.113.10:8443#pin#fallback» — основная по домену
/// (публичный сертификат) и запасная по IP с закреплённым ключом (тот же сервер), если домен не открылся (DNS, сеть).
/// Запасная быстрее на время DNS-запроса, поэтому помечается #fallback: иначе выбор «самой быстрой» уводил бы на неё.
/// Вход общий (session_get), переход между точками — без повторного входа. Без RELAY_ENDPOINTS — одна точка RELAY_SERVER.
/// Сохранённые прежние выбор/последняя точка, которых нет в списке, просто игнорируются.
const ENDPOINTS: &str = match option_env!("RELAY_ENDPOINTS") {
    Some(s) => s,
    None => match option_env!("RELAY_SERVER") {
        // прежняя сборка с одним сервером
        Some(_) => "",
        // без RELAY_ENDPOINTS — одна точка входа RELAY_SERVER
        None => "",
    },
};

#[derive(Clone, Debug, Serialize)]
pub struct Endpoint {
    pub id: String,
    pub url: String,
    #[serde(skip)]
    pub pinned: bool,
    #[serde(skip)]
    pub fallback: bool,
}

impl Endpoint {
    pub fn trust(&self) -> Trust {
        if self.pinned {
            Trust::Pins(crate::pins())
        } else {
            Trust::WebPki
        }
    }
    pub fn hostport(&self) -> String {
        let hp = self.url.trim_start_matches("https://").trim_end_matches('/');
        if hp.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) {
            hp.to_string()
        } else {
            format!("{hp}:443")
        }
    }
    pub fn host(&self) -> String {
        self.hostport().rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_default()
    }
}

pub fn parse(s: &str) -> Vec<Endpoint> {
    s.split(',')
        .filter_map(|e| {
            let (id, rest) = e.trim().split_once('=')?;
            let mut parts = rest.trim().split('#');
            let url = parts.next()?;
            let (mut pinned, mut fallback) = (false, false);
            for f in parts {
                match f {
                    "pin" => pinned = true,
                    "fallback" => fallback = true,
                    _ => return None,
                }
            }
            (url.starts_with("https://") && !id.is_empty()).then(|| Endpoint { id: id.trim().into(), url: url.trim_end_matches('/').into(), pinned, fallback })
        })
        .collect()
}

/// Все точки входа. RELAY_DESKTOP_TEST_ENDPOINTS — подмена только для автотестов (отказ точки входа).
pub fn all() -> Vec<Endpoint> {
    if let Ok(t) = std::env::var("RELAY_DESKTOP_TEST_ENDPOINTS") {
        let v = parse(&t);
        if !v.is_empty() {
            return v;
        }
    }
    let v = parse(ENDPOINTS);
    if !v.is_empty() {
        return v;
    }
    // одна точка входа: RELAY_SERVER из сборки, иначе — адрес, введённый на экране подключения (нет — пусто)
    let server = if crate::SERVER.is_empty() { RUNTIME.lock().unwrap().clone().unwrap_or_default() } else { crate::SERVER.to_string() };
    if server.is_empty() {
        return vec![];
    }
    // по IP — закреплённый ключ, по имени — публичный сертификат
    let host = server.trim_start_matches("https://").split([':', '/']).next().unwrap_or("").to_string();
    vec![Endpoint { id: "main".into(), url: server, pinned: host.parse::<std::net::IpAddr>().is_ok(), fallback: false }]
}

static CURRENT: Mutex<Option<Endpoint>> = Mutex::new(None);
/// Адрес сервера, введённый пользователем (сборка без RELAY_SERVER).
static RUNTIME: Mutex<Option<String>> = Mutex::new(None);
pub fn set_runtime_server(url: Option<String>) {
    *RUNTIME.lock().unwrap() = url;
    *CURRENT.lock().unwrap() = None;
}

/// Ввод пользователя → https://имя[:порт] (без пути и параметров; имя — буквы, цифры, точки, дефисы). Иначе None.
pub fn normalize_server(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let rest = s.strip_prefix("https://").unwrap_or(s);
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ']) {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') || host.starts_with(['.', '-']) {
        return None;
    }
    if let Some(p) = port {
        if p.parse::<u16>().map_or(true, |p| p == 0) {
            return None;
        }
    }
    Some(format!("https://{}", rest.to_ascii_lowercase()))
}
pub fn current() -> Endpoint {
    CURRENT.lock().unwrap().clone().unwrap_or_else(|| all().remove(0))
}
pub fn set_current(e: &Endpoint) {
    *CURRENT.lock().unwrap() = Some(e.clone());
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub id: String,
    /// ok — работает; untrusted — сертификат не прошёл проверку; offline — не отвечает (или за ней не отвечает Relay).
    pub state: &'static str,
    pub ms: Option<u32>,
    #[serde(skip)]
    pub spki: String,
    /// запасная точка входа (#fallback)
    #[serde(skip)]
    pub fallback: bool,
}

/// Проверить все точки входа параллельно.
pub async fn probe_all() -> Vec<Status> {
    let list = all();
    let tasks: Vec<_> =
        list.iter().cloned().map(|e| tauri::async_runtime::spawn_blocking(move || (e.id.clone(), e.fallback, pin::probe(&e.url, &e.trust())))).collect();
    let mut out = Vec::new();
    for t in tasks {
        let Ok((id, fallback, r)) = t.await else { continue };
        out.push(match r {
            Ok(p) if !p.trusted => Status { id, state: "untrusted", ms: None, spki: p.spki, fallback },
            Ok(p) if p.relay => Status { id, state: "ok", ms: Some(p.ms), spki: p.spki, fallback },
            _ => Status { id, state: "offline", ms: None, spki: String::new(), fallback },
        });
    }
    out
}

/// Выбор точки входа: предпочтение пользователя (если работает), иначе прежняя (если работает и не заметно
/// медленнее лучшей), иначе самая быстрая. Запасные (#fallback) — только если ни одна основная не работает.
/// None — ни одна не работает.
pub fn choose<'a>(st: &'a [Status], preferred: Option<&str>, last: Option<&str>) -> Option<&'a Status> {
    let ok: Vec<&Status> = st.iter().filter(|s| s.state == "ok").collect();
    if let Some(p) = preferred.and_then(|p| ok.iter().find(|s| s.id == p)) {
        return Some(p);
    }
    let main: Vec<&Status> = ok.iter().copied().filter(|s| !s.fallback).collect();
    let ok = if main.is_empty() { ok } else { main };
    let best = ok.iter().min_by_key(|s| s.ms.unwrap_or(u32::MAX))?;
    if let Some(l) = last.and_then(|l| ok.iter().find(|s| s.id == l)) {
        // Задержка проверки включает установку TCP/TLS и путь до основного узла — шумная; переключаем,
        // только если прежняя заметно хуже.
        if l.ms.unwrap_or(u32::MAX) <= best.ms.unwrap_or(0).saturating_mul(3) / 2 + 40 {
            return Some(l);
        }
    }
    Some(best)
}

// ---------- вход, общий для точек входа ----------
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct Session {
    pub token: Option<String>,
}

/// Что вернуть странице после перехода на другую точку входа: открытый сервер и голосовой канал.
pub static RESUME: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn session_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app.path().app_local_data_dir().expect("local data dir");
    match crate::test_profile() {
        Some(p) => base.join("profiles").join(format!("{p}.session")),
        None => base.join("session.bin"),
    }
}

pub fn load_session(app: &tauri::AppHandle) -> Session {
    std::fs::read(session_path(app)).ok().and_then(|b| unprotect(&b)).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn store_session(app: &tauri::AppHandle, s: &Session) {
    let p = session_path(app);
    if s.token.is_none() {
        let _ = std::fs::remove_file(&p);
        return;
    }
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    if let Some(b) = protect(&serde_json::to_vec(s).unwrap_or_default()) {
        let _ = std::fs::write(p, b);
    }
}

/// DPAPI (CryptProtectData, область текущего пользователя): файл бесполезен под другой учётной записью и на другом ПК.
#[cfg(windows)]
fn dpapi(data: &[u8], encrypt: bool) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let r = if encrypt {
            CryptProtectData(&input, windows::core::w!("Relay session"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        r.ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
        Some(v)
    }
}
#[cfg(windows)]
fn protect(d: &[u8]) -> Option<Vec<u8>> {
    dpapi(d, true)
}
#[cfg(windows)]
fn unprotect(d: &[u8]) -> Option<Vec<u8>> {
    dpapi(d, false)
}
#[cfg(not(windows))]
fn protect(d: &[u8]) -> Option<Vec<u8>> {
    Some(d.to_vec())
}
#[cfg(not(windows))]
fn unprotect(d: &[u8]) -> Option<Vec<u8>> {
    Some(d.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(id: &str, ms: Option<u32>) -> Status {
        Status { id: id.into(), state: if ms.is_some() { "ok" } else { "offline" }, ms, spki: String::new(), fallback: false }
    }
    fn fb(id: &str, ms: Option<u32>) -> Status {
        Status { fallback: true, ..s(id, ms) }
    }

    #[test]
    fn normalizes_server_input() {
        assert_eq!(normalize_server(" app.example.com/ ").as_deref(), Some("https://app.example.com"));
        assert_eq!(normalize_server("https://Voice.Example.com:8443").as_deref(), Some("https://voice.example.com:8443"));
        for bad in ["", "http://x.com", "https://x.com/path", "x.com?a=1", "user@x.com", "x .com", "x.com:0", "x.com:99999", "-x.com"] {
            assert!(normalize_server(bad).is_none(), "{bad}");
        }
    }
    #[test]
    fn parses_endpoints() {
        let v = parse("ru-1=https://203.0.113.10:8443#pin, eu-nl-1=https://eu.example.com/,bad=http://x");
        assert_eq!(v.len(), 2);
        assert!(v[0].pinned && !v[1].pinned);
        assert_eq!(v[1].url, "https://eu.example.com");
        assert_eq!(v[1].hostport(), "eu.example.com:443");
        assert_eq!(v[0].hostport(), "203.0.113.10:8443");
        assert_eq!(v[0].host(), "203.0.113.10");
        // основная по домену и запасная по IP с закреплённым ключом
        let def = parse("ru-1=https://app.example.com,ru-1-ip=https://203.0.113.10:8443#pin#fallback");
        assert_eq!(def.len(), 2);
        assert!(def[0].id == "ru-1" && !def[0].pinned && def[0].hostport() == "app.example.com:443", "домен — публичный сертификат");
        assert!(
            def[1].id == "ru-1-ip" && def[1].pinned && def[1].fallback && def[1].hostport() == "203.0.113.10:8443",
            "прежний адрес — закреплённый ключ, запасной"
        );
        assert!(!def[0].fallback);
        assert!(parse("x=https://a.ru#bogus").is_empty(), "неизвестная пометка — точка входа не принимается");
    }

    #[test]
    fn choice_is_sticky_and_falls_back() {
        let st = [s("ru-1", Some(30)), s("eu-nl-1", Some(70))];
        assert_eq!(choose(&st, None, None).unwrap().id, "ru-1", "самая быстрая");
        assert_eq!(choose(&st, None, Some("eu-nl-1")).unwrap().id, "eu-nl-1", "прежняя не заметно хуже — остаёмся");
        let st2 = [s("ru-1", Some(30)), s("eu-nl-1", Some(400))];
        assert_eq!(choose(&st2, None, Some("eu-nl-1")).unwrap().id, "ru-1", "прежняя заметно хуже — переходим");
        let down = [s("ru-1", None), s("eu-nl-1", Some(70))];
        assert_eq!(choose(&down, None, Some("ru-1")).unwrap().id, "eu-nl-1", "прежняя не работает — fallback");
        assert_eq!(choose(&down, Some("ru-1"), None).unwrap().id, "eu-nl-1", "предпочтение недоступно — fallback");
        assert_eq!(choose(&st, Some("eu-nl-1"), Some("ru-1")).unwrap().id, "eu-nl-1", "предпочтение пользователя");
        // клиент, обновлённый с версии, где был eu-nl-1: сохранённые выбор и последняя точка не в списке
        let one = [s("ru-1", Some(30))];
        assert_eq!(choose(&one, Some("eu-nl-1"), Some("eu-nl-1")).unwrap().id, "ru-1", "выведенная точка входа игнорируется");
        assert!(choose(&[s("ru-1", None)], None, None).is_none());
        // запасная (прежний адрес по IP) быстрее домена на время DNS — всё равно домен
        let mig = [s("ru-1", Some(54)), fb("ru-1-ip", Some(45))];
        assert_eq!(choose(&mig, None, None).unwrap().id, "ru-1", "запасная не выбирается, пока основная работает");
        assert_eq!(choose(&mig, None, Some("ru-1-ip")).unwrap().id, "ru-1", "с запасной возвращаемся на основную");
        assert_eq!(choose(&mig, Some("ru-1-ip"), None).unwrap().id, "ru-1-ip", "выбор пользователя соблюдается");
        let dns_down = [s("ru-1", None), fb("ru-1-ip", Some(45))];
        assert_eq!(choose(&dns_down, None, Some("ru-1")).unwrap().id, "ru-1-ip", "основная не работает — запасная");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let enc = protect(b"secret-token").unwrap();
        assert!(!enc.windows(12).any(|w| w == b"secret-token"));
        assert_eq!(unprotect(&enc).unwrap(), b"secret-token");
    }
}

#[cfg(test)]
mod live {
    /// Сеть: cargo test --lib live_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_probe() {
        for e in super::all() {
            for _ in 0..3 {
                let r = crate::pin::probe(&e.url, &e.trust());
                println!("{} {:?}", e.id, r.map(|p| (p.trusted, p.relay, p.ms)));
            }
        }
    }
}

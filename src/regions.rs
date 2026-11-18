//! Регионы и маршрут медиа.
//!
//! Один логический Relay: аккаунты, БД и хранилище — в основном регионе (ru-1). Региональные edge-узлы
//! (например eu-nl-1) — только точки входа: HTTPS/WSS проксируется на основной узел по mTLS, медиа — через
//! TURN-релей узла к SFU, где размещена комната. Комната одна, где бы ни были участники.
//!
//! Как Relay узнаёт регион запроса: edge-узел приходит на основной узел по mTLS (сертификат, выпущенный CA
//! межузлового канала, CN = id региона); вход edge-узлов ставит X-Relay-Region из CN, публичный вход его вырезает.
//!
//! Конфиг — JSON-файл (RELAY_REGIONS_FILE, без секретов); секрет TURN каждого региона — в окружении
//! RELAY_TURN_SECRET_<ID> (например RELAY_TURN_SECRET_EU_NL_1). Учётные данные TURN — краткоживущие
//! (TURN REST API: username = "<expiry>:<uid>", password = base64(HMAC-SHA1(secret, username))), как ждёт coturn.
use axum::http::HeaderMap;
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use prometheus::{HistogramOpts, HistogramVec, IntCounterVec, IntGaugeVec, Opts};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[derive(Deserialize, Clone, Debug)]
pub struct Turn {
    pub urls: Vec<String>,
    /// Срок действия учётных данных, с.
    #[serde(default = "default_ttl")]
    pub ttl: i64,
}
fn default_ttl() -> i64 {
    6 * 3600
}

#[derive(Deserialize, Clone, Debug)]
pub struct Region {
    pub id: String,
    #[serde(default)]
    pub primary: bool,
    /// Публичное имя edge-узла (для диагностики и выбора точки входа клиентом).
    #[serde(default)]
    pub edge_host: Option<String>,
    #[serde(default)]
    pub turn: Option<Turn>,
    /// Клиенты этого региона — только через TURN-релей узла (не напрямую к SFU).
    #[serde(default)]
    pub relay_only: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Config {
    #[serde(default)]
    pub regions: Vec<Region>,
    /// Где размещаются комнаты (MVP: все — в основном регионе).
    #[serde(default)]
    pub media_region: Option<String>,
}

pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    let Ok(path) = std::env::var("RELAY_REGIONS_FILE") else { return Config::default() };
    match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Config>(&b).map_err(|e| e.to_string())) {
        Ok(c) => {
            println!("Регионы: {}", c.regions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", "));
            c
        }
        Err(e) => {
            eprintln!("регионы ({path}): {e} — работаю в одном регионе");
            Config::default()
        }
    }
});

/// Основной регион (где БД, хранилище и, на этапе MVP, все комнаты).
pub fn primary() -> &'static str {
    CONFIG.regions.iter().find(|r| r.primary).map(|r| r.id.as_str()).unwrap_or("ru-1")
}

/// Регион запроса: только известный регион-edge из заголовка X-Relay-Region; иначе — основной.
pub fn of_request(h: &HeaderMap) -> &'static Region {
    static PRIMARY: LazyLock<Region> = LazyLock::new(|| Region { id: primary().to_string(), primary: true, edge_host: None, turn: None, relay_only: false });
    // Ставит вход edge-узлов основного узла из проверенного клиентского сертификата: "CN=eu-nl-1".
    let raw = h.get("x-relay-region").and_then(|v| v.to_str().ok()).unwrap_or("");
    let want = raw.strip_prefix("CN=").unwrap_or(raw);
    CONFIG.regions.iter().find(|r| !r.primary && r.id == want).unwrap_or(&PRIMARY)
}

fn secret_env(id: &str) -> String {
    format!("RELAY_TURN_SECRET_{}", id.to_ascii_uppercase().replace('-', "_"))
}

/// Краткоживущие учётные данные TURN (формат TURN REST API / coturn use-auth-secret).
pub fn turn_credentials(secret: &str, uid: i64, ttl: i64, now_s: i64) -> (String, String) {
    let username = format!("{}:{uid}", now_s + ttl);
    let mut m = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes()).expect("hmac");
    m.update(username.as_bytes());
    (username, STANDARD.encode(m.finalize().into_bytes()))
}

/// ICE для клиента: регион-edge с TURN — серверы TURN узла и, если задано, только релей. Основной регион — null
/// (клиент берёт ICE-серверы, которые даёт LiveKit). Плюс где размещена комната — для диагностики.
pub fn ice_for(h: &HeaderMap, uid: i64) -> Value {
    let r = of_request(h);
    let media = CONFIG.media_region.clone().unwrap_or_else(|| primary().to_string());
    let Some(t) = r.turn.as_ref().filter(|_| !r.primary) else { return json!({ "region": r.id, "media_region": media }) };
    let Ok(secret) = std::env::var(secret_env(&r.id)) else {
        eprintln!("регион {}: нет {} — TURN не выдаётся", r.id, secret_env(&r.id));
        return json!({ "region": r.id, "media_region": media });
    };
    let (username, credential) = turn_credentials(&secret, uid, t.ttl, crate::now() / 1000);
    json!({
        "region": r.id, "media_region": media,
        "servers": [{ "urls": t.urls, "username": username, "credential": credential }],
        "policy": if r.relay_only { "relay" } else { "all" },
    })
}

/// GET /api/regions — точки входа (для выбора региона клиентом и диагностики). Публично: без секретов.
pub async fn list(h: HeaderMap) -> axum::Json<Value> {
    let regions: Vec<Value> = CONFIG.regions.iter().map(|r| json!({ "id": r.id, "primary": r.primary, "host": r.edge_host })).collect();
    axum::Json(
        json!({ "regions": regions, "current": of_request(&h).id, "media_region": CONFIG.media_region.clone().unwrap_or_else(|| primary().to_string()) }),
    )
}

// ---------- метрики по регионам ----------
// Метки — только id регионов из конфига и значения из конечных наборов. Ни IP, ни id пользователей, ни адресов
// кандидатов ICE: клиент сообщает только тип пары (host/srflx/prflx/relay) и транспорт.

pub struct Geo {
    pub requests: IntCounterVec,
    pub request_duration: HistogramVec,
    pub gateway: IntGaugeVec,
    pub voice: IntGaugeVec,
    pub voice_tokens: IntCounterVec,
    pub client_events: IntCounterVec,
    pub ice_pairs: IntCounterVec,
    pub rtt: HistogramVec,
    pub jitter: HistogramVec,
    pub loss: HistogramVec,
    pub up: IntGaugeVec,
    pub probe_seconds: prometheus::GaugeVec,
    pub probe_failures: IntCounterVec,
}

pub static G: LazyLock<Geo> = LazyLock::new(|| {
    let r = &crate::metrics::M.registry;
    fn reg<T: prometheus::core::Collector + Clone + 'static>(r: &prometheus::Registry, c: T) -> T {
        r.register(Box::new(c.clone())).unwrap();
        c
    }
    let cv = |n: &str, h: &str, l: &[&str]| reg(r, IntCounterVec::new(Opts::new(n, h), l).unwrap());
    let gv = |n: &str, h: &str, l: &[&str]| reg(r, IntGaugeVec::new(Opts::new(n, h), l).unwrap());
    let hv = |n: &str, h: &str, b: Vec<f64>| reg(r, HistogramVec::new(HistogramOpts::new(n, h).buckets(b), &["region"]).unwrap());
    let ms = vec![0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0, 2.0];
    let g = Geo {
        requests: cv("relay_region_http_requests_total", "HTTP-запросы по региону точки входа", &["region"]),
        request_duration: hv(
            "relay_region_http_request_duration_seconds",
            "Время обработки HTTP-запроса на основном узле по региону точки входа",
            prometheus::exponential_buckets(0.001, 2.0, 15).unwrap(),
        ),
        gateway: gv("relay_region_gateway_connections", "Открытые WebSocket-соединения gateway по региону точки входа", &["region"]),
        voice: gv("relay_region_voice_participants", "Участники голоса по региону, через который они вошли", &["region"]),
        voice_tokens: cv("relay_region_voice_tokens_total", "Выданные токены голоса по региону (kind: voice/screen)", &["region", "kind"]),
        client_events: cv(
            "relay_region_voice_client_events_total",
            "События подключения голоса от клиентов (connected/failed/reconnecting/reconnected/disconnected)",
            &["region", "kind", "event"],
        ),
        ice_pairs: cv(
            "relay_region_voice_ice_pairs_total",
            "Выбранные пары ICE при подключении голоса: тип локального кандидата (relay = через TURN) и транспорт",
            &["region", "pair", "proto"],
        ),
        rtt: hv("relay_region_voice_rtt_seconds", "RTT медиа (выбранная пара ICE) по отчётам клиентов", ms.clone()),
        jitter: hv("relay_region_voice_jitter_seconds", "Jitter входящего звука по отчётам клиентов", vec![0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2]),
        loss: hv(
            "relay_region_voice_loss_ratio",
            "Доля потерянных входящих аудиопакетов (за интервал отчёта)",
            vec![0.0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0],
        ),
        up: gv("relay_region_up", "Точка входа региона работает целиком: HTTPS edge → межузловой канал → Relay (проба с основного узла)", &["region"]),
        probe_seconds: reg(
            r,
            prometheus::GaugeVec::new(Opts::new("relay_region_probe_duration_seconds", "Время последней пробы точки входа региона"), &["region"]).unwrap(),
        ),
        probe_failures: cv(
            "relay_region_probe_failures_total",
            "Неудачные пробы точки входа региона (reason: timeout/connect/status/region)",
            &["region", "reason"],
        ),
    };
    // ряды с нуля для всех известных регионов (rate/increase не теряют первое событие, алерты видят 0)
    for reg in ids() {
        g.requests.with_label_values(&[reg]);
        g.gateway.with_label_values(&[reg]);
        g.voice.with_label_values(&[reg]);
        for k in ["voice", "screen"] {
            g.voice_tokens.with_label_values(&[reg, k]);
            for e in EVENTS {
                g.client_events.with_label_values(&[reg, k, e]);
            }
        }
    }
    g
});

fn ids() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = CONFIG.regions.iter().map(|r| r.id.as_str()).collect();
    if v.is_empty() {
        v.push(primary());
    }
    v
}

const EVENTS: [&str; 5] = ["connected", "failed", "reconnecting", "reconnected", "disconnected"];

/// Регион, через который пользователь вошёл в голос (id из конфига — ссылки на статические строки).
static VOICE_REGION: LazyLock<Mutex<HashMap<i64, &'static str>>> = LazyLock::new(Default::default);

pub fn note_voice_token(h: &HeaderMap, uid: i64, kind: &'static str) {
    let r = of_request(h).id.as_str();
    G.voice_tokens.with_label_values(&[r, kind]).inc();
    if kind == "voice" {
        VOICE_REGION.lock().unwrap().insert(uid, r);
    }
}

/// Участники голоса по регионам — при каждом опросе метрик.
pub fn refresh_voice(users: &[i64]) {
    let mut m = VOICE_REGION.lock().unwrap();
    m.retain(|u, _| users.contains(u));
    let mut by: HashMap<&'static str, i64> = ids().into_iter().map(|r| (r, 0)).collect();
    for u in users {
        *by.entry(m.get(u).copied().unwrap_or_else(primary)).or_default() += 1;
    }
    for (r, n) in by {
        G.voice.with_label_values(&[r]).set(n);
    }
}

/// HTTP: счётчик и время по региону точки входа (вызывается из metrics::track_http).
pub fn observe_http(r: &'static str, secs: f64) {
    G.requests.with_label_values(&[r]).inc();
    G.request_duration.with_label_values(&[r]).observe(secs);
}

/// Открытое соединение gateway по региону (держится, пока живо соединение).
pub struct GatewayConn(&'static str);
impl GatewayConn {
    pub fn new(h: &HeaderMap) -> Self {
        let r = of_request(h).id.as_str();
        G.gateway.with_label_values(&[r]).inc();
        Self(r)
    }
}
impl Drop for GatewayConn {
    fn drop(&mut self) {
        G.gateway.with_label_values(&[self.0]).dec();
    }
}

/// Отчёт клиента о подключении голоса: только тип пары и транспорт, без адресов.
#[derive(Deserialize)]
pub struct VoiceReport {
    event: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    pair: Option<String>,
    proto: Option<String>,
    rtt_ms: Option<f64>,
    jitter_ms: Option<f64>,
    loss: Option<f64>,
}

fn pick<'a>(v: Option<&str>, allowed: &[&'a str], other: &'a str) -> &'a str {
    v.and_then(|v| allowed.iter().find(|a| **a == v).copied()).unwrap_or(other)
}

/// Не чаще раза в 2 с от пользователя: метрики не должны раскачиваться одним клиентом.
static LAST_REPORT: LazyLock<Mutex<HashMap<i64, i64>>> = LazyLock::new(Default::default);

pub fn record_report(h: &HeaderMap, uid: i64, rep: &VoiceReport, now_ms: i64) -> bool {
    {
        let mut m = LAST_REPORT.lock().unwrap();
        if m.get(&uid).is_some_and(|t| now_ms - t < 2000) {
            return false;
        }
        if m.len() > 50_000 {
            m.clear();
        }
        m.insert(uid, now_ms);
    }
    let r = of_request(h).id.as_str();
    let kind = pick(rep.kind.as_deref(), &["voice", "screen"], "voice");
    if let Some(e) = rep.event.as_deref() {
        let e = pick(Some(e), &EVENTS, "");
        if !e.is_empty() {
            G.client_events.with_label_values(&[r, kind, e]).inc();
        }
        if e == "connected" || e == "reconnected" {
            let pair = pick(rep.pair.as_deref(), &["host", "srflx", "prflx", "relay"], "unknown");
            let proto = pick(rep.proto.as_deref(), &["udp", "tcp", "tls"], "unknown");
            G.ice_pairs.with_label_values(&[r, pair, proto]).inc();
        }
    }
    let ok = |v: Option<f64>, max: f64| v.filter(|x| x.is_finite() && *x >= 0.0 && *x <= max);
    if let Some(x) = ok(rep.rtt_ms, 60_000.0) {
        G.rtt.with_label_values(&[r]).observe(x / 1000.0);
    }
    if let Some(x) = ok(rep.jitter_ms, 60_000.0) {
        G.jitter.with_label_values(&[r]).observe(x / 1000.0);
    }
    if let Some(x) = ok(rep.loss, 1.0) {
        G.loss.with_label_values(&[r]).observe(x);
    }
    true
}

/// Проба точек входа регионов с основного узла: https://<edge_host>/api/regions должен ответить через
/// межузловой канал и назвать свой регион. Это проверка всего пути: TLS edge → mTLS → Relay.
pub fn spawn_probes() {
    let edges: Vec<(&'static str, String)> =
        CONFIG.regions.iter().filter(|r| !r.primary).filter_map(|r| r.edge_host.clone().map(|h| (r.id.as_str(), h))).collect();
    G.up.with_label_values(&[primary()]).set(1);
    if edges.is_empty() {
        return;
    }
    let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).user_agent("relay-region-probe").build() else { return };
    tokio::spawn(async move {
        let mut t = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            t.tick().await;
            for (id, host) in &edges {
                let s = std::time::Instant::now();
                let res = client.get(format!("https://{host}/api/regions")).send().await;
                let reason = match res {
                    Err(e) if e.is_timeout() => Some("timeout"),
                    Err(_) => Some("connect"),
                    Ok(r) if !r.status().is_success() => Some("status"),
                    Ok(r) => match r.json::<Value>().await {
                        Ok(v) if v["current"] == *id => None,
                        _ => Some("region"),
                    },
                };
                G.probe_seconds.with_label_values(&[id]).set(s.elapsed().as_secs_f64());
                G.up.with_label_values(&[id]).set(reason.is_none() as i64);
                if let Some(why) = reason {
                    G.probe_failures.with_label_values(&[id, why]).inc();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_labels_are_bounded() {
        let h = HeaderMap::new();
        let rep = VoiceReport {
            event: Some("connected".into()),
            kind: Some("x".into()),
            pair: Some("10.0.0.1".into()),
            proto: Some("quic".into()),
            rtt_ms: Some(-1.0),
            jitter_ms: Some(f64::NAN),
            loss: Some(2.0),
        };
        assert!(record_report(&h, 7, &rep, 1_000_000));
        assert!(!record_report(&h, 7, &rep, 1_000_500), "не чаще раза в 2 с");
        assert_eq!(G.ice_pairs.with_label_values(&[primary(), "unknown", "unknown"]).get(), 1);
        assert_eq!(G.client_events.with_label_values(&[primary(), "voice", "connected"]).get(), 1);
        assert_eq!(G.rtt.with_label_values(&[primary()]).get_sample_count(), 0);
    }
    #[test]
    fn coturn_rest_credentials() {
        // Сверено независимой реализацией (Node crypto.createHmac("sha1")): тот же алгоритм ждёт coturn (use-auth-secret).
        let mut m = Hmac::<sha1::Sha1>::new_from_slice(b"north").unwrap();
        m.update(b"1433895918:mbzrxpgjys");
        assert_eq!(STANDARD.encode(m.finalize().into_bytes()), "d2Q1V6JRLjCTMOhoc8cTgEoi7u0=");
        let (u, p) = turn_credentials("s3cret", 42, 3600, 1_000_000);
        assert_eq!(u, "1003600:42");
        assert_eq!(p.len(), 28);
    }
    #[test]
    fn region_from_certificate_subject() {
        // без файла регионов любой заголовок — основной регион (неизвестный id не принимается)
        let mut h = HeaderMap::new();
        h.insert("x-relay-region", "CN=eu-nl-1".parse().unwrap());
        assert!(of_request(&h).primary);
    }
    #[test]
    fn regions_file_example_is_valid() {
        // пример конфига (docs/configuration.md): разбирается, основной узел ровно один, у edge-регионов — вход и TURN
        let example = r#"{ "media_region": "main", "regions": [ { "id": "main", "primary": true, "edge_host": "app.example.com" } ] }"#;
        let c: Config = serde_json::from_str(example).unwrap();
        assert_eq!(c.regions.iter().filter(|r| r.primary).count(), 1);
        for r in c.regions.iter().filter(|r| !r.primary) {
            assert!(r.edge_host.is_some() && r.turn.as_ref().is_some_and(|t| !t.urls.is_empty()), "edge-регион {} без входа или TURN", r.id);
        }
    }
    #[test]
    fn unknown_region_is_primary() {
        let mut h = HeaderMap::new();
        h.insert("x-relay-region", "mars-1".parse().unwrap());
        assert!(of_request(&h).primary);
    }
}

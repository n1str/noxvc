//! Метрики Prometheus: `/metrics` на отдельном порту (RELAY_METRICS_ADDR), наружу не публикуется.
//!
//! Крейт `prometheus` (а не `metrics` + exporter): один крейт, явный реестр и встроенный стандартный
//! сборщик метрик процесса (process_cpu_seconds_total, process_resident_memory_bytes, process_open_fds, …).
//!
//! Метки — только из конечных наборов (вид сообщения, тип файла, результат, шаблон маршрута, имя операции
//! из кода). Никаких id пользователей/каналов/серверов, IP, путей с параметрами и текста SQL.
use crate::AppState;
use axum::{
    extract::{MatchedPath, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use prometheus::{
    exponential_buckets, Encoder, Histogram, HistogramOpts, HistogramVec, IntCounter, IntCounterVec, IntGauge, IntGaugeVec, Opts, Registry, TextEncoder,
};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

pub struct Metrics {
    pub registry: Registry,
    // ---- состояние (обновляется при опросе или в фоне) ----
    pub users_registered: IntGauge,
    pub users_online: IntGauge,
    pub voice_participants: IntGauge,
    pub voice_channels_active: IntGauge,
    pub streams_active: IntGauge,
    pub gateway_connections: IntGauge,
    pub gateway_sessions: IntGauge,
    pub guilds_total: IntGauge,
    pub messages_stored: IntGauge,
    pub media_queue_length: IntGauge,
    pub storage_objects: IntGauge,
    pub storage_bytes: IntGauge,
    pub db_pool_connections: IntGaugeVec,
    pub db_pool_max: IntGauge,
    pub start_time: IntGauge,
    // ---- счётчики ----
    pub messages_created: IntCounterVec,
    pub uploads: IntCounterVec,
    pub upload_bytes: IntCounter,
    pub logins: IntCounterVec,
    pub registrations: IntCounter,
    /// Отказы регистрации: invalid_code — неверный/недействительный код, limited — ограничение частоты.
    pub registration_attempts: IntCounterVec,
    /// Запросы на приглашение по статусу и коды регистрации по состоянию (из БД, раз в 60 с).
    pub invite_requests: IntGaugeVec,
    pub registration_invites: IntGaugeVec,
    pub feedback: IntCounterVec,
    pub voice_joins: IntCounter,
    pub gateway_reconnects: IntCounter,
    pub media_jobs: IntCounterVec,
    pub db_errors: IntCounterVec,
    pub storage_ops: IntCounterVec,
    // ---- гистограммы ----
    pub http_requests: IntCounterVec,
    pub http_duration: HistogramVec,
    pub db_query_duration: HistogramVec,
    pub db_pool_acquire: Histogram,
    pub storage_duration: HistogramVec,
}

fn gauge(r: &Registry, name: &str, help: &str) -> IntGauge {
    let g = IntGauge::new(name, help).unwrap();
    r.register(Box::new(g.clone())).unwrap();
    g
}
fn gauge_vec(r: &Registry, name: &str, help: &str, labels: &[&str]) -> IntGaugeVec {
    let g = IntGaugeVec::new(Opts::new(name, help), labels).unwrap();
    r.register(Box::new(g.clone())).unwrap();
    g
}
fn counter(r: &Registry, name: &str, help: &str) -> IntCounter {
    let c = IntCounter::new(name, help).unwrap();
    r.register(Box::new(c.clone())).unwrap();
    c
}
fn counter_vec(r: &Registry, name: &str, help: &str, labels: &[&str]) -> IntCounterVec {
    let c = IntCounterVec::new(Opts::new(name, help), labels).unwrap();
    r.register(Box::new(c.clone())).unwrap();
    c
}
fn histogram_vec(r: &Registry, name: &str, help: &str, labels: &[&str], buckets: Vec<f64>) -> HistogramVec {
    let h = HistogramVec::new(HistogramOpts::new(name, help).buckets(buckets), labels).unwrap();
    r.register(Box::new(h.clone())).unwrap();
    h
}

/// Границы времени: 1 мс … ~16 с.
fn latency_buckets() -> Vec<f64> {
    exponential_buckets(0.001, 2.0, 15).unwrap()
}

pub static M: LazyLock<Metrics> = LazyLock::new(|| {
    let r = Registry::new();
    #[cfg(target_os = "linux")]
    r.register(Box::new(prometheus::process_collector::ProcessCollector::for_self())).unwrap();
    let m = Metrics {
        users_registered: gauge(&r, "relay_users_registered", "Зарегистрированные аккаунты (из БД, раз в 60 с)"),
        users_online: gauge(&r, "relay_users_online", "Пользователи хотя бы с одним живым соединением gateway"),
        voice_participants: gauge(&r, "relay_voice_participants", "Участники в голосовых каналах и звонках"),
        voice_channels_active: gauge(&r, "relay_voice_channels_active", "Голосовые каналы и звонки, где кто-то есть"),
        streams_active: gauge(&r, "relay_streams_active", "Идущие демонстрации экрана"),
        gateway_connections: gauge(&r, "relay_gateway_connections", "Открытые WebSocket-соединения gateway"),
        gateway_sessions: gauge(&r, "relay_gateway_sessions", "Сессии gateway (вместе с оборванными, ждущими RESUME)"),
        guilds_total: gauge(&r, "relay_guilds_total", "Серверы (из БД, раз в 5 мин)"),
        messages_stored: gauge(&r, "relay_messages_stored", "Сообщения в БД (раз в 5 мин)"),
        media_queue_length: gauge(&r, "relay_media_queue_length", "Задачи обработки медиа профиля в очереди"),
        storage_objects: gauge(&r, "relay_storage_objects", "Файлы в хранилище (раз в 10 мин)"),
        storage_bytes: gauge(&r, "relay_storage_bytes", "Объём хранилища файлов, байт (раз в 10 мин)"),
        db_pool_connections: gauge_vec(&r, "relay_db_pool_connections", "Соединения пула БД по состоянию", &["state"]),
        db_pool_max: gauge(&r, "relay_db_pool_max", "Максимум соединений пула БД"),
        start_time: gauge(&r, "relay_start_time_seconds", "Время запуска Relay (unix)"),
        messages_created: counter_vec(&r, "relay_messages_created_total", "Созданные сообщения", &["kind"]),
        uploads: counter_vec(&r, "relay_uploads_total", "Загруженные файлы", &["type"]),
        upload_bytes: counter(&r, "relay_upload_bytes_total", "Объём загруженных файлов, байт"),
        logins: counter_vec(&r, "relay_logins_total", "Входы", &["result"]),
        registrations: counter(&r, "relay_registrations_total", "Регистрации"),
        registration_attempts: counter_vec(&r, "relay_registration_rejected_total", "Отказы в регистрации", &["reason"]),
        invite_requests: gauge_vec(&r, "relay_invite_requests", "Запросы на приглашение по статусу", &["status"]),
        registration_invites: gauge_vec(&r, "relay_registration_invites", "Коды регистрации по состоянию", &["state"]),
        feedback: counter_vec(&r, "relay_feedback_total", "Обращения обратной связи", &["kind"]),
        voice_joins: counter(&r, "relay_voice_joins_total", "Входы в голос (вебхук LiveKit)"),
        gateway_reconnects: counter(&r, "relay_gateway_reconnects_total", "Успешные RESUME gateway"),
        media_jobs: counter_vec(&r, "relay_media_jobs_total", "Задачи обработки медиа профиля", &["target", "result"]),
        db_errors: counter_vec(&r, "relay_db_errors_total", "Ошибки БД", &["kind"]),
        storage_ops: counter_vec(&r, "relay_storage_operations_total", "Операции с хранилищем файлов", &["op", "result"]),
        http_requests: counter_vec(&r, "relay_http_requests_total", "HTTP-запросы", &["method", "route", "status"]),
        http_duration: histogram_vec(&r, "relay_http_request_duration_seconds", "Время обработки HTTP-запроса", &["method", "route"], latency_buckets()),
        db_query_duration: histogram_vec(&r, "relay_db_query_duration_seconds", "Время операций с БД (имя операции из кода)", &["query"], latency_buckets()),
        db_pool_acquire: {
            let h = Histogram::with_opts(
                HistogramOpts::new("relay_db_pool_acquire_duration_seconds", "Ожидание соединения из пула (проба раз в 5 с)")
                    .buckets(exponential_buckets(0.0001, 2.0, 16).unwrap()),
            )
            .unwrap();
            r.register(Box::new(h.clone())).unwrap();
            h
        },
        storage_duration: histogram_vec(&r, "relay_storage_operation_duration_seconds", "Время операций с хранилищем файлов", &["op"], latency_buckets()),
        registry: r,
    };
    // Нулевые значения сразу: ряды есть с первого опроса (rate/increase не теряют первое событие).
    for k in ["channel", "dm", "thread"] {
        m.messages_created.with_label_values(&[k]);
    }
    for k in ["image", "video", "file"] {
        m.uploads.with_label_values(&[k]);
    }
    for k in ["success", "failure"] {
        m.logins.with_label_values(&[k]);
    }
    for t in ["avatar", "banner", "guild_icon"] {
        for r in ["success", "failure"] {
            m.media_jobs.with_label_values(&[t, r]);
        }
    }
    for k in ERROR_KINDS {
        m.db_errors.with_label_values(&[k]);
    }
    m.start_time.set(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0));
    m
});

// ---------- помощники для кода ----------

/// Вид сообщения по виду канала.
pub fn message_created(channel_kind: &str) {
    let k = match channel_kind {
        "dm" | "group_dm" => "dm",
        "thread" => "thread",
        _ => "channel",
    };
    M.messages_created.with_label_values(&[k]).inc();
}

/// Тип загруженного файла по расширению.
pub fn uploaded(ext: &str, bytes: usize) {
    let t = match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => "image",
        "mp4" | "webm" | "mov" => "video",
        _ => "file",
    };
    M.uploads.with_label_values(&[t]).inc();
    M.upload_bytes.inc_by(bytes as u64);
}

const ERROR_KINDS: [&str; 5] = ["timeout", "deadlock", "unique_violation", "connection", "other"];

/// Вид ошибки БД для relay_db_errors_total.
pub fn db_error_kind(e: &sqlx::Error) -> &'static str {
    match e {
        sqlx::Error::PoolTimedOut => "timeout",
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed => "connection",
        sqlx::Error::Database(d) => match d.code().as_deref() {
            Some("40P01") => "deadlock",
            Some("23505") => "unique_violation",
            Some("57014") => "timeout", // query_canceled (statement_timeout)
            Some(c) if c.starts_with("08") => "connection",
            _ => "other",
        },
        _ => "other",
    }
}

pub fn db_error(e: &sqlx::Error) {
    M.db_errors.with_label_values(&[db_error_kind(e)]).inc();
}

/// Измерить операцию с БД под фиксированным именем (например "messages.list_by_channel").
pub async fn timed<T, E, F: std::future::Future<Output = Result<T, E>>>(query: &'static str, f: F) -> Result<T, E> {
    let t = Instant::now();
    let r = f.await;
    M.db_query_duration.with_label_values(&[query]).observe(t.elapsed().as_secs_f64());
    r
}

// ---------- HTTP ----------

/// Шаблон маршрута для меток: зарегистрированный маршрут axum (`/api/channels/{id}/messages`) или одна из
/// фиксированных групп — реальный путь в метку не попадает никогда.
fn route_label(req: &Request) -> String {
    if let Some(m) = req.extensions().get::<MatchedPath>() {
        let p = m.as_str();
        // nest_service: «/uploads/{*__private__axum_nest_tail_param}» → «/uploads/*»
        return match p.find("/{*") {
            Some(i) => format!("{}/*", &p[..i]),
            None => p.to_string(),
        };
    }
    let path = req.uri().path();
    for pre in ["/uploads/", "/assets/", "/updates/", "/legacy/"] {
        if path.starts_with(pre) {
            return format!("{pre}*");
        }
    }
    if path.starts_with("/api/") {
        "/api/unknown".into()
    } else {
        "spa".into()
    }
}

fn method_label(m: &axum::http::Method) -> &'static str {
    match m.as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "other",
    }
}

pub async fn track_http(req: Request, next: Next) -> Response {
    let method = method_label(req.method());
    let route = route_label(&req);
    let region = crate::regions::of_request(req.headers()).id.as_str();
    let t = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16().to_string();
    M.http_requests.with_label_values(&[method, &route, &status]).inc();
    M.http_duration.with_label_values(&[method, &route]).observe(t.elapsed().as_secs_f64());
    crate::regions::observe_http(region, t.elapsed().as_secs_f64());
    res
}

// ---------- сбор и отдача ----------

/// Значения из памяти — при каждом опросе (дёшево).
fn refresh_live(st: &AppState) {
    let (conns, sessions, online) = st.hub.gw.stats();
    M.gateway_connections.set(conns as i64);
    M.gateway_sessions.set(sessions as i64);
    M.users_online.set(online as i64);
    let v = st.hub.voice_stats();
    M.voice_participants.set(v.participants as i64);
    M.voice_channels_active.set(v.channels as i64);
    M.streams_active.set(v.streams as i64);
    crate::regions::refresh_voice(&st.hub.voice_users());
    M.media_queue_length.set(st.media.len() as i64);
    let size = st.db.size() as i64;
    let idle = st.db.num_idle() as i64;
    M.db_pool_connections.with_label_values(&["idle"]).set(idle);
    M.db_pool_connections.with_label_values(&["active"]).set((size - idle).max(0));
    M.db_pool_max.set(st.db.options().get_max_connections() as i64);
}

pub fn render(st: &AppState) -> String {
    refresh_live(st);
    let mut buf = Vec::new();
    TextEncoder::new().encode(&M.registry.gather(), &mut buf).unwrap();
    String::from_utf8(buf).unwrap_or_default()
}

async fn handler(State(st): State<AppState>) -> Response {
    ([(header::CONTENT_TYPE, prometheus::TEXT_FORMAT)], render(&st)).into_response()
}

pub fn router(st: AppState) -> Router {
    Router::new().route("/metrics", get(handler)).fallback(|| async { StatusCode::NOT_FOUND }).with_state(st)
}

/// Фоновые счётчики из БД и проба пула (не на каждый опрос: опрос не должен грузить БД).
pub fn spawn_collectors(st: AppState) {
    crate::regions::spawn_probes();
    let db = st.db.clone();
    tokio::spawn(async move {
        let mut tick = 0u64;
        let mut t = tokio::time::interval(Duration::from_secs(60));
        loop {
            t.tick().await;
            if let Ok(n) = timed("metrics.users_count", sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users").fetch_one(&db)).await {
                M.users_registered.set(n);
            }
            crate::invites::collect(&db).await;
            if tick.is_multiple_of(5) {
                if let Ok(n) = timed("metrics.guilds_count", sqlx::query_scalar::<_, i64>("SELECT count(*) FROM guilds").fetch_one(&db)).await {
                    M.guilds_total.set(n);
                }
                if let Ok(n) = timed("metrics.messages_count", sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages").fetch_one(&db)).await {
                    M.messages_stored.set(n);
                }
            }
            tick += 1;
        }
    });
    // Объём хранилища файлов (диск или S3) — раз в 10 минут.
    let store = st.store.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(600));
        loop {
            t.tick().await;
            match store.usage().await {
                Ok((n, b)) => {
                    M.storage_objects.set(n as i64);
                    M.storage_bytes.set(b as i64);
                }
                Err(e) => eprintln!("хранилище: подсчёт объёма: {e}"),
            }
        }
    });
    // Ожидание соединения из пула: в sqlx нет хука на ожидание, поэтому — проба раз в 5 с
    // (берём соединение так же, как запросы приложения, и сразу возвращаем).
    let db = st.db.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(5));
        loop {
            t.tick().await;
            let s = Instant::now();
            match db.acquire().await {
                Ok(c) => {
                    M.db_pool_acquire.observe(s.elapsed().as_secs_f64());
                    drop(c);
                }
                Err(e) => db_error(&e),
            }
        }
    });
}

/// Отдельный порт метрик. Пусто или "off" — выключено.
pub async fn serve(st: AppState) {
    let addr = std::env::var("RELAY_METRICS_ADDR").unwrap_or_else(|_| "127.0.0.1:9464".into());
    if addr.is_empty() || addr == "off" {
        return;
    }
    spawn_collectors(st.clone());
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => {
            println!("Метрики Prometheus: http://{addr}/metrics");
            let _ = axum::serve(l, router(st)).await;
        }
        Err(e) => eprintln!("метрики недоступны ({addr}): {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_bounded() {
        let req = |p: &str| Request::builder().uri(p).body(axum::body::Body::empty()).unwrap();
        assert_eq!(route_label(&req("/uploads/abc123.png")), "/uploads/*");
        assert_eq!(route_label(&req("/assets/index-1234.js")), "/assets/*");
        assert_eq!(route_label(&req("/channels/123")), "spa");
        assert_eq!(route_label(&req("/api/nope/42")), "/api/unknown");
        assert_eq!(method_label(&axum::http::Method::from_bytes(b"BREW").unwrap()), "other");
    }

    #[test]
    fn message_kinds() {
        let before = M.messages_created.with_label_values(&["dm"]).get();
        message_created("group_dm");
        assert_eq!(M.messages_created.with_label_values(&["dm"]).get(), before + 1);
    }
}

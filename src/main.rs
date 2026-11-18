#![allow(clippy::type_complexity, clippy::too_many_arguments)] // кортежи строк sqlx и обработчики с многими параметрами — осознанно
mod activity;
mod api;
mod db;
mod embeds;
mod emojis;
mod feedback;
mod gateway;
mod invites;
mod livekit;
mod media;
mod mediaq;
mod mentions;
mod metrics;
mod perms;
mod regions;
mod search;
mod sessions;
mod site;
mod social;
mod storage;
mod threads;
mod ws;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue},
    routing::{delete, get, patch, post, put},
    Router,
};
use std::{path::PathBuf, sync::Arc};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::{SetResponseHeader, SetResponseHeaderLayer},
};

#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub hub: Arc<ws::Hub>,
    pub lk: Option<Arc<livekit::LiveKit>>,
    /// Порядок синхронизации прав голоса с LiveKit (см. api::revalidate_voice).
    pub voice_sync: Arc<tokio::sync::Mutex<()>>,
    /// Файлы (аватары, баннеры после обработки).
    pub store: Arc<storage::Store>,
    /// Очередь обработки медиа профиля (один воркер ffmpeg).
    pub media: mediaq::Queue,
}

async fn serve_upload(
    axum::extract::State(st): axum::extract::State<AppState>,
    axum::extract::Path(key): axum::extract::Path<String>,
    req: axum::extract::Request,
) -> axum::response::Response {
    st.store.serve(&key, req).await
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let addr = env("RELAY_ADDR", "0.0.0.0:8080");
    let data = PathBuf::from(env("RELAY_DATA", "data"));
    // Веб-клиент (React, web/dist) — корень.
    let web = PathBuf::from(env("RELAY_WEB", "web/dist"));
    let uploads = data.join("uploads");
    std::fs::create_dir_all(&uploads).expect("не удалось создать каталог данных");

    // Разовый перенос старых файлов в хранилище: relay storage-migrate [каталог]
    if std::env::args().nth(1).as_deref() == Some("storage-migrate") {
        let store = storage::Store::from_env(uploads.clone());
        let dir = std::env::args().nth(2).map(PathBuf::from).unwrap_or(uploads.clone());
        println!("перенос {} → {}", dir.display(), store.describe());
        match storage::migrate_dir(&store, &dir).await {
            Ok((c, s, f)) => {
                println!("скопировано {c}, уже было {s}, ошибок {f}");
                std::process::exit(if f > 0 { 1 } else { 0 })
            }
            Err(e) => {
                eprintln!("ошибка: {e}");
                std::process::exit(1)
            }
        }
    }

    let database_url = env("DATABASE_URL", "postgres://relay:relay@127.0.0.1:55432/relay");
    let pg = db::connect(&database_url).await;
    // Управление приглашениями на сервере: relay admin invite create|list|revoke, relay admin requests list
    if std::env::args().nth(1).as_deref() == Some("admin") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(invites::cli(&pg, &args).await);
    }
    invites::sync_admins(&pg).await;

    let (media, media_rx) = mediaq::channel();
    let st = AppState {
        db: pg.clone(),
        hub: Arc::new(ws::Hub::default()),
        lk: livekit::LiveKit::from_env().map(Arc::new),
        voice_sync: Arc::new(tokio::sync::Mutex::new(())),
        store: Arc::new(storage::Store::from_env(uploads.clone())),
        media,
    };
    tokio::spawn(mediaq::run(st.clone(), media_rx));
    // Метрики — отдельный порт (RELAY_METRICS_ADDR, по умолчанию 127.0.0.1:9464), не через основной.
    tokio::spawn(metrics::serve(st.clone()));
    println!("Файлы: {}", st.store.describe());
    println!("Голос (LiveKit): {}", if st.lk.is_some() { "включён" } else { "выключен — нет LIVEKIT_API_KEY/LIVEKIT_API_SECRET" });

    // Уборка оборванных сессий gateway (RESUME больше невозможен).
    let hub = st.hub.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            t.tick().await;
            hub.gw.sweep();
        }
    });
    // Автоархивация неактивных веток.
    let st2 = st.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            t.tick().await;
            threads::auto_archive(&st2).await;
        }
    });

    let api = Router::new()
        .route("/register", post(api::register))
        .route("/login", post(api::login))
        .route("/logout", post(api::logout))
        .route("/me", get(api::me).patch(social::update_me))
        .route("/me/password", post(social::change_password))
        .route("/me/settings", patch(social::update_settings))
        .route("/sessions", get(sessions::list))
        .route("/sessions/{id}", delete(sessions::revoke_one))
        .route("/sessions/revoke-others", post(sessions::revoke_others))
        .route("/security-log", get(sessions::security_log))
        .route("/invite-requests", post(invites::create_request))
        .route("/invite-requests/mine", get(invites::my_requests))
        .route("/invite-requests/{id}/cancel", post(invites::cancel_request))
        .route("/admin/invites/requests", get(invites::admin_requests))
        .route("/admin/invites/requests/{id}/approve", post(invites::approve))
        .route("/admin/invites/requests/{id}/reject", post(invites::reject))
        .route("/admin/invites/codes", get(invites::admin_codes).post(invites::admin_create_code))
        .route("/admin/invites/codes/{id}/revoke", post(invites::admin_revoke))
        .route("/admin/invites/history", get(invites::admin_history))
        .route("/admin/invites/guilds", get(invites::admin_guilds))
        .route("/feedback", post(feedback::create))
        .route("/feedback/mine", get(feedback::mine))
        .route("/feedback/{id}", get(feedback::get_one))
        .route("/feedback/{id}/comments", post(feedback::comment))
        .route("/admin/feedback", get(feedback::admin_list))
        .route("/admin/feedback/export", get(feedback::admin_export))
        .route("/admin/feedback/{id}", patch(feedback::admin_patch))
        .route("/me/activity", post(social::activity))
        .route("/me/game", put(activity::put))
        .route("/games/detectable", get(activity::detectable))
        .route("/regions", get(regions::list))
        .route("/users/{id}/profile", get(social::profile))
        .route("/relationships", get(social::list).post(social::request))
        .route("/relationships/{id}", delete(social::remove))
        .route("/relationships/{id}/block", put(social::block))
        .route("/groups", post(social::create_group))
        .route("/groups/{id}", patch(social::rename_group))
        .route("/groups/{id}/recipients/{uid}", put(social::add_recipient).delete(social::remove_recipient))
        .route("/guilds", post(api::create_guild))
        .route("/guilds/{id}", get(api::guild_detail).patch(api::update_guild).delete(api::delete_guild))
        .route("/guilds/{id}/channels", post(api::create_channel))
        .route("/guilds/{id}/invites", post(api::create_invite).get(api::list_invites))
        .route("/guilds/{id}/members/{uid}", delete(api::remove_member).patch(api::update_member))
        .route("/guilds/{id}/members/{uid}/roles/{rid}", put(api::add_member_role).delete(api::remove_member_role))
        .route("/guilds/{id}/roles", post(api::create_role))
        .route("/guilds/{id}/roles/order", patch(api::order_roles))
        .route("/guilds/{id}/view-as", get(api::view_as))
        .route("/guilds/{id}/voice/move", post(api::voice_move))
        .route("/guilds/{id}/icon", put(api::set_guild_icon).delete(api::delete_guild_icon))
        .route("/guilds/{id}/channels/order", patch(api::order_channels))
        .route("/roles/{id}", patch(api::update_role).delete(api::delete_role))
        .route("/channels/{id}/permissions", get(api::list_overwrites))
        .route("/channels/{id}/permissions/{kind}/{target}", put(api::put_overwrite).delete(api::delete_overwrite))
        .route("/channels/{id}", patch(api::update_channel).delete(api::delete_channel))
        .route("/channels/{id}/messages", get(api::list_messages).post(api::post_message))
        .route("/messages/{id}", patch(api::edit_message).delete(api::delete_message))
        .route("/channels/{id}/messages/bulk-delete", post(api::bulk_delete))
        .route("/messages/{id}/pin", put(api::toggle_pin))
        .route("/messages/{id}/suppress-embeds", post(api::suppress_embeds))
        .route("/messages/{id}/reactions/{emoji}", put(api::toggle_reaction))
        .route("/invites/{code}", get(api::invite_info).post(api::join_invite).delete(api::delete_invite))
        .route("/dms", post(api::open_dm))
        .route("/voice/token", post(api::voice_token))
        .route("/voice/screen-token", post(api::voice_screen_token))
        .route("/voice/report", post(api::voice_report))
        .route("/voice/state", patch(api::voice_state))
        .route("/channels/{id}/typing", post(api::typing))
        .route("/channels/{id}/ack", post(api::ack))
        .route("/inbox", get(api::inbox))
        .route("/voice/hand", post(api::stage_hand))
        .route("/voice/stage/{uid}", post(api::stage_speaker))
        .route("/guilds/{id}/emojis", post(emojis::create))
        .route("/emojis/{id}", patch(emojis::rename).delete(emojis::delete))
        .route("/emojis/{id}/image", get(emojis::image))
        .route("/channels/{id}/threads", get(threads::list).post(threads::create))
        .route("/channels/{id}/tags", put(threads::put_tags))
        .route("/threads/{id}", get(threads::get).patch(threads::update).delete(threads::delete))
        .route("/threads/{id}/members/me", put(threads::join).delete(threads::leave))
        .route("/messages/{id}/poll/votes", put(threads::vote))
        .route("/messages/{id}/poll/end", post(threads::end_poll))
        .route("/search", get(api::search))
        .route("/guilds/{id}/ack", post(api::ack_guild))
        .route("/notification-settings", put(api::put_notification_settings))
        .route("/livekit/webhook", post(api::livekit_webhook))
        .route("/upload", post(api::upload).layer(DefaultBodyLimit::max(25 * 1024 * 1024)));

    let app = Router::new()
        .nest("/api", api)
        .route("/gateway", get(gateway::handler))
        // публичные страницы домена: приглашение с превью, ссылка на установщик
        .route("/invite/{code}", get(site::invite_page))
        .route("/download/windows", get(site::download_windows))
        // Файлы — из хранилища (диск или S3); Range и условные запросы поддерживаются.
        .route("/uploads/{*key}", get(serve_upload).head(serve_upload))
        // Обновления Relay Desktop: latest.json + подписанные установщики (кладёт desktop/release.mjs). Всегда перепроверяются.
        .nest_service(
            "/updates",
            SetResponseHeader::overriding(ServeDir::new(data.join("updates")), header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        )
        .route("/next/{*rest}", get(|| async { axum::response::Redirect::permanent("/") }))
        // Сборка клиента: файлы с хешем в имени — кэш навсегда; отсутствующий файл — 404 (а не index.html вместо JS).
        .nest_service(
            "/assets",
            SetResponseHeader::overriding(
                ServeDir::new(web.join("assets")),
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        )
        // Новый клиент (React) — корень; неизвестные пути отдают index.html (SPA). Всегда перепроверяется:
        // иначе после обновления браузер/приложение берёт старую страницу со ссылками на удалённые скрипты (пустой экран).
        .fallback_service(SetResponseHeader::overriding(
            ServeDir::new(&web).fallback(ServeFile::new(web.join("index.html"))),
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        // Метрики HTTP: маршрут — шаблоном (MatchedPath), не реальный путь.
        .layer(axum::middleware::from_fn(metrics::track_http))
        .with_state(st);

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("не удалось занять порт");
    println!("Relay запущен: http://{addr}  (данные: {})", data.display());
    axum::serve(listener, app).await.unwrap();
}

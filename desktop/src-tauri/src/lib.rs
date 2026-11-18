//! Relay Desktop: оболочка Tauri вокруг веб-клиента сервера.
//! - точки входа (регионы) и ключи зашиты в сборку; приложение само выбирает доступную (endpoint.rs), адрес не показывает;
//! - окно сначала показывает локальный экран подключения: точки входа проверяются (закреплённый ключ или публичный
//!   сертификат с проверкой имени), затем окно переходит на клиент выбранной (всегда свежая версия);
//! - трей, сворачивание в трей, автозапуск, один экземпляр, уведомления ОС, мигание в панели задач,
//!   глобальные горячие клавиши (рация, микрофон, звук, трансляция — работают поверх игр и не мешают другим программам).

mod endpoint;
mod games;
#[cfg(windows)]
mod gpu;
#[cfg(windows)]
mod hook;
mod hotkeys;
#[cfg(windows)]
mod legacy;
#[cfg(windows)]
mod mfenc;
mod pin;
#[cfg(windows)]
mod share;
#[cfg(windows)]
mod snap;
#[cfg(windows)]
mod update;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

/// Сервер Relay. Задаётся при сборке: RELAY_SERVER=https://… (по умолчанию — текущая инфраструктура).
pub(crate) const SERVER: &str = match option_env!("RELAY_SERVER") {
    Some(s) => s,
    None => "",
};
/// Закреплённые ключи сервера: base64(SHA-256(SubjectPublicKeyInfo)) через запятую — действующий и запасной
/// (для смены сертификата без обновления приложения). Задаётся при сборке: RELAY_PINS=…
const PINS: &str = match option_env!("RELAY_PINS") {
    Some(s) => s,
    None => "",
};

/// Аргументы WebView2 по умолчанию в Tauri — сохраняем их, добавляя свои.
const BASE_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Действующие пины. RELAY_DESKTOP_TEST_PINS — подмена только для автотестов (проверка «чужого ключа»).
pub(crate) fn pins() -> Vec<String> {
    std::env::var("RELAY_DESKTOP_TEST_PINS").unwrap_or_else(|_| PINS.into()).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// Аргументы WebView2: исключение из проверки сертификатов — только для закреплённых ключей.
/// Одинаковы для всех окон (среда WebView2 создаётся один раз). RELAY_DESKTOP_CDP=<порт> — отладка для автотестов.
fn browser_args() -> String {
    let cdp = std::env::var("RELAY_DESKTOP_CDP").ok().filter(|p| p.parse::<u16>().is_ok()).map(|p| format!(" --remote-debugging-port={p}")).unwrap_or_default();
    // RELAY_DESKTOP_TEST_MEDIA — поддельные микрофон/камера без запроса разрешения (только автотесты).
    let media = if std::env::var("RELAY_DESKTOP_TEST_MEDIA").is_ok() { " --use-fake-ui-for-media-stream --use-fake-device-for-media-stream" } else { "" };
    format!("{BASE_ARGS} --ignore-certificate-errors-spki-list={}{cdp}{media}", pins().join(","))
}

/// Отпечаток для показа (hex с двоеточиями) из пина base64.
fn fingerprint(pin: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(pin).map(|b| b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(":")).unwrap_or_default()
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    #[serde(default = "yes")]
    close_to_tray: bool,
    /// Игровая активность: показывать ли, скрытые игры, свои игры, Dota GSI.
    #[serde(default)]
    games: games::GamesSettings,
    /// Точка входа: выбранная пользователем (None — автоматически) и последняя, через которую работали.
    #[serde(default)]
    endpoint_pref: Option<String>,
    /// Светлая тема (выбор страницы): окно создаётся сразу с её фоном и темой — без вспышки тёмной при запуске.
    #[serde(default)]
    light: bool,
    #[serde(default)]
    endpoint_last: Option<String>,
    /// Адрес сервера, если он не задан при сборке (RELAY_SERVER): вводится на экране подключения.
    #[serde(default)]
    server_url: Option<String>,
}
fn yes() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self { close_to_tray: true, games: games::GamesSettings::default(), endpoint_pref: None, endpoint_last: None, light: false, server_url: None }
    }
}

/// Настройки приложения. Тестовый профиль (RELAY_DESKTOP_PROFILE) — свой файл: автотесты не должны менять настройки
/// настоящего Relay пользователя (тему, свои игры, точку входа).
fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    match test_profile() {
        Some(p) => app.path().app_local_data_dir().expect("local data dir").join("profiles").join(format!("{p}.settings.json")),
        None => app.path().app_config_dir().expect("config dir").join("settings.json"),
    }
}
fn load_settings(app: &AppHandle) -> Settings {
    std::fs::read(settings_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn store_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())
}

static QUITTING: AtomicBool = AtomicBool::new(false);
/// Ключ, с которым подключились (для показа в «Статусе связи»).
static CONNECTED_PIN: Mutex<String> = Mutex::new(String::new());

fn create_main(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    let light = load_settings(app).light;
    // IPC для страницы сервера — только этот origin и только нужные ей команды.
    // Все точки входа — один и тот же Relay; страница любой из них получает одинаковый набор команд.
    let urls = endpoint::all().iter().map(|e| format!("\"{}/*\"", e.url)).collect::<Vec<_>>().join(",");
    app.add_capability(format!(
        r#"{{"identifier":"server","windows":["main"],"remote":{{"urls":[{urls}]}},"permissions":["core:event:default",
            "allow-notify","allow-attention","allow-set-unread","allow-ptt-set-key","allow-hotkeys-set","allow-set-theme","allow-app-info","allow-autostart-get",
            "allow-autostart-set","allow-tray-get","allow-tray-set","allow-screen-sources","allow-screen-start","allow-screen-stop",
            "allow-screen-update","allow-screen-audio","allow-update-status","allow-update-check","allow-update-install","allow-session-get","allow-session-put","allow-endpoint-failover","allow-endpoints","allow-endpoint-prefer",{WINDOW_PERMS}]}}"#
    ))?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(BRAND)
        .inner_size(1280.0, 820.0)
        .min_inner_size(940.0, 600.0)
        .center()
        // Свой заголовок окна в стиле приложения (рисует страница); тень, ресайз по краям и скругления Windows 11 — системные.
        .decorations(false)
        .shadow(true)
        .visible(!hidden)
        // Без этого Tauri забирает перетаскивание себе (для файлов из проводника), и в странице не работает HTML5 drag-and-drop:
        // перенос участников между голосовыми, порядок каналов и категорий, файлы в чат.
        .disable_drag_drop_handler()
        // тема с первого кадра: фон окна (до отрисовки страницы) и data-theme до скриптов любой страницы (загрузка, сервер)
        .background_color(theme_bg(light))
        .initialization_script(if light { "document.documentElement.dataset.theme='light';" } else { "document.documentElement.dataset.theme='dark';" })
        .additional_browser_args(&browser_args())
        .data_directory(webview_data_dir(app))
        .build()?;
    Ok(())
}

pub(crate) fn test_profile() -> Option<String> {
    std::env::var("RELAY_DESKTOP_PROFILE").ok().filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// Профиль WebView2 (вход, настройки клиента). RELAY_DESKTOP_PROFILE=<имя> — отдельный профиль для автотестов,
/// чтобы тесты никогда не трогали вход настоящего пользователя.
fn webview_data_dir(app: &AppHandle) -> std::path::PathBuf {
    let base = app.path().app_local_data_dir().expect("local data dir");
    match test_profile() {
        Some(p) => base.join("profiles").join(p),
        None => base.join("EBWebView"),
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---------- команды ----------
#[derive(Serialize)]
#[serde(tag = "status")]
enum Connect {
    /// Сервер проверен — окно переходит на клиент.
    #[serde(rename = "ok")]
    Ok,
    /// Сервер не отвечает (нет сети, сервер выключен).
    #[serde(rename = "offline")]
    Offline,
    /// Ключ не совпал ни с одним закреплённым — возможна подмена; адрес не открываем.
    #[serde(rename = "untrusted")]
    Untrusted,
    /// Адрес сервера не задан (сборка без RELAY_SERVER, первый запуск) — экран подключения спрашивает его.
    #[serde(rename = "no_server")]
    NoServer,
}

/// Перейти на клиент точки входа (запомнив её как последнюю рабочую).
fn open_endpoint(app: &AppHandle, e: &endpoint::Endpoint, st: &endpoint::Status) {
    endpoint::set_current(e);
    *CONNECTED_PIN.lock().unwrap() = if e.pinned { st.spki.clone() } else { String::new() };
    let mut s = load_settings(app);
    if s.endpoint_last.as_deref() != Some(&e.id) {
        s.endpoint_last = Some(e.id.clone());
        let _ = store_settings(app, &s);
    }
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(url) = e.url.parse() {
            let _ = w.navigate(url);
        }
    }
}

/// Проверить точки входа и выбрать (None — ни одна не работает; в ответе — почему).
async fn pick(app: &AppHandle, exclude: Option<&str>) -> (Option<(endpoint::Endpoint, endpoint::Status)>, Vec<endpoint::Status>) {
    let all = endpoint::all();
    let st = endpoint::probe_all().await;
    let s = load_settings(app);
    let usable: Vec<endpoint::Status> = st.iter().filter(|x| Some(x.id.as_str()) != exclude).cloned().collect();
    let chosen = endpoint::choose(&usable, s.endpoint_pref.as_deref(), s.endpoint_last.as_deref())
        .and_then(|c| all.iter().find(|e| e.id == c.id).map(|e| (e.clone(), c.clone())));
    (chosen, st)
}

/// Экран подключения: проверить точки входа и перейти на клиент выбранной.
/// Адрес сервера для экрана подключения: задан ли при сборке (тогда менять нельзя) и текущий.
#[derive(Serialize)]
struct ServerInfo {
    built_in: bool,
    url: Option<String>,
}

#[tauri::command]
fn server_get(app: AppHandle) -> ServerInfo {
    if !SERVER.is_empty() {
        return ServerInfo { built_in: true, url: Some(SERVER.into()) };
    }
    ServerInfo { built_in: false, url: load_settings(&app).server_url }
}

/// Сохранить адрес сервера (только сборки без RELAY_SERVER): https://имя[:порт], без пути.
#[tauri::command]
fn server_set(app: AppHandle, url: String) -> Result<String, String> {
    if !SERVER.is_empty() {
        return Err("адрес сервера задан при сборке".into());
    }
    let url = endpoint::normalize_server(&url).ok_or("Укажите адрес вида https://app.example.com")?;
    let mut s = load_settings(&app);
    s.server_url = Some(url.clone());
    s.endpoint_last = None;
    store_settings(&app, &s)?;
    endpoint::set_runtime_server(Some(url.clone()));
    Ok(url)
}

#[tauri::command]
async fn connect(app: AppHandle) -> Connect {
    if endpoint::all().is_empty() {
        return Connect::NoServer;
    }
    let (chosen, st) = pick(&app, None).await;
    if let Some((e, s)) = chosen {
        open_endpoint(&app, &e, &s);
        return Connect::Ok;
    }
    // Ни одна не работает: если хоть одна предъявила чужой ключ — сообщаем именно это (возможна подмена).
    if st.iter().any(|s| s.state == "untrusted") {
        Connect::Untrusted
    } else {
        Connect::Offline
    }
}

/// Страница долго без связи с сервером: если текущая точка входа не работает, перейти на доступную.
/// stay — текущая работает (дело не в ней); switched — перешли; offline — не работает ни одна.
#[tauri::command]
async fn endpoint_failover(app: AppHandle, resume: Option<serde_json::Value>) -> &'static str {
    let cur = endpoint::current();
    let (_, st) = pick(&app, None).await;
    if st.iter().any(|s| s.id == cur.id && s.state == "ok") {
        return "stay";
    }
    let (chosen, _) = pick(&app, Some(&cur.id)).await;
    let Some((e, s)) = chosen else { return "offline" };
    *endpoint::RESUME.lock().unwrap() = resume;
    open_endpoint(&app, &e, &s);
    "switched"
}

/// Для настроек: точки входа, их состояние и задержка, текущая и выбранная пользователем.
#[derive(Serialize)]
struct Endpoints {
    list: Vec<endpoint::Status>,
    current: String,
    preferred: Option<String>,
}

#[tauri::command]
async fn endpoints(app: AppHandle) -> Endpoints {
    Endpoints { list: endpoint::probe_all().await, current: endpoint::current().id, preferred: load_settings(&app).endpoint_pref }
}

/// Выбрать точку входа (None — автоматически). Если выбранная работает и она не текущая — переход на неё.
#[tauri::command]
async fn endpoint_prefer(app: AppHandle, id: Option<String>, resume: Option<serde_json::Value>) -> Result<bool, String> {
    if id.as_ref().is_some_and(|i| !endpoint::all().iter().any(|e| &e.id == i)) {
        return Err("нет такой точки входа".into());
    }
    let mut s = load_settings(&app);
    s.endpoint_pref = id.clone();
    store_settings(&app, &s)?;
    let Some(id) = id else { return Ok(false) };
    if endpoint::current().id == id {
        return Ok(false);
    }
    let (chosen, _) = pick(&app, None).await;
    match chosen {
        Some((e, st)) if e.id == id => {
            *endpoint::RESUME.lock().unwrap() = resume;
            open_endpoint(&app, &e, &st);
            Ok(true)
        }
        _ => Err("эта точка входа сейчас недоступна".into()),
    }
}

/// Вход, сохранённый приложением (для страницы другой точки входа), и что вернуть после перехода.
#[tauri::command]
fn session_get(app: AppHandle) -> serde_json::Value {
    serde_json::json!({ "token": endpoint::load_session(&app).token, "resume": endpoint::RESUME.lock().unwrap().take() })
}

#[tauri::command]
fn session_put(app: AppHandle, token: Option<String>) {
    let token = token.filter(|t| !t.is_empty() && t.len() <= 512);
    if endpoint::load_session(&app).token != token {
        endpoint::store_session(&app, &endpoint::Session { token });
    }
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// Привлечь внимание (мигание в панели задач), если окно не в фокусе.
#[tauri::command]
fn attention(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(true) {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
}

/// Название продукта, которое видит пользователь (окно, трей). Внутренние имена (crate, идентификатор приложения,
/// каталоги данных) остаются relay — от них зависят автообновление и сохранённый вход.
pub(crate) const BRAND: &str = "NoxVC";

/// Значок трея: монохромный знак NV — белый на тёмной панели задач, тёмный на светлой (brand/gen.mjs).
fn tray_icon() -> tauri::image::Image<'static> {
    let png: &[u8] = if taskbar_light() { include_bytes!("../icons/tray-on-light.png") } else { include_bytes!("../icons/tray-on-dark.png") };
    tauri::image::Image::from_bytes(png).expect("значок трея")
}

/// Светлая ли панель задач Windows (Параметры → Персонализация → Цвета → «Режим Windows»).
#[cfg(windows)]
fn taskbar_light() -> bool {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut v: u32 = 0;
    let mut n = std::mem::size_of::<u32>() as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            windows::core::w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            windows::core::w!("SystemUsesLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut v as *mut u32 as *mut _),
            Some(&mut n),
        )
    };
    r.is_ok() && v == 1
}
#[cfg(not(windows))]
fn taskbar_light() -> bool {
    false
}

#[tauri::command]
fn set_unread(app: AppHandle, mentions: u32, unread: bool) {
    if let Some(t) = app.tray_by_id("relay") {
        let tip = if mentions > 0 {
            format!("{BRAND} — упоминаний: {mentions}")
        } else if unread {
            format!("{BRAND} — есть непрочитанное")
        } else {
            BRAND.into()
        };
        let _ = t.set_tooltip(Some(tip));
        // заодно — значок под текущую тему панели задач (её могли переключить)
        let _ = t.set_icon(Some(tray_icon()));
    }
}

/// Для «Статуса связи»: версия и отпечаток закреплённого ключа (без адреса сервера).
#[derive(Serialize)]
struct AppInfo {
    version: String,
    fingerprint: String,
    pinned: bool,
    desktop: bool,
    endpoint: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let pin = CONNECTED_PIN.lock().unwrap().clone();
    AppInfo {
        version: app.package_info().version.to_string(),
        pinned: !pin.is_empty(),
        fingerprint: fingerprint(&pin),
        desktop: true,
        endpoint: endpoint::current().id,
    }
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let a = app.autolaunch();
    if enabled { a.enable() } else { a.disable() }.map_err(|e| e.to_string())?;
    Ok(a.is_enabled().unwrap_or(false))
}

#[tauri::command]
fn tray_get(app: AppHandle) -> bool {
    load_settings(&app).close_to_tray
}

/// Цвет фона окна под тему (как --bg-app в tokens.css).
fn theme_bg(light: bool) -> tauri::window::Color {
    if light {
        tauri::window::Color(238, 239, 243, 255)
    } else {
        tauri::window::Color(22, 22, 26, 255)
    }
}

/// Тема выбрана на странице: фон окна сейчас и тема при следующем запуске.
#[tauri::command]
fn set_theme(app: AppHandle, dark: bool) -> Result<(), String> {
    let mut s = load_settings(&app);
    if s.light == !dark {
        return Ok(());
    }
    s.light = !dark;
    store_settings(&app, &s)?;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_background_color(Some(theme_bg(!dark)));
    }
    Ok(())
}

#[tauri::command]
fn tray_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    // Остальные настройки (игры) — как были.
    let mut s = load_settings(&app);
    s.close_to_tray = enabled;
    store_settings(&app, &s)?;
    Ok(enabled)
}

// ---------- игровая активность ----------
#[derive(Serialize)]
struct GamesView {
    show_activity: bool,
    hidden: Vec<String>,
    custom: Vec<games::CustomGame>,
    dota_gsi: bool,
    gsi_running: bool,
    current: Option<games::Detected>,
}

fn games_view() -> GamesView {
    let s = games::settings();
    GamesView {
        show_activity: s.show_activity,
        hidden: s.hidden,
        custom: s.custom,
        dota_gsi: s.dota_gsi,
        gsi_running: games::gsi_running(),
        current: games::current(),
    }
}

/// Сохранить настройки игр и сразу применить.
fn games_update(app: &AppHandle, f: impl FnOnce(&mut games::GamesSettings) -> Result<(), String>) -> Result<GamesView, String> {
    let mut s = load_settings(app);
    f(&mut s.games)?;
    store_settings(app, &s)?;
    games::apply_settings(s.games);
    Ok(games_view())
}

/// Справочник распознаваемых игр (страница берёт его с сервера при запуске).
#[tauri::command]
fn games_set_catalog(games: Vec<games::CatalogGame>) {
    games::set_catalog(games);
}

#[tauri::command]
fn games_get() -> GamesView {
    games_view()
}

#[tauri::command]
fn games_set(app: AppHandle, show_activity: Option<bool>, hidden: Option<Vec<String>>) -> Result<GamesView, String> {
    games_update(&app, |g| {
        if let Some(v) = show_activity {
            g.show_activity = v;
        }
        if let Some(h) = hidden {
            g.hidden = h.into_iter().filter(|k| k.len() <= 300).take(500).collect();
        }
        Ok(())
    })
}

/// «Добавить игру»: процессы с окнами — только в локальный интерфейс, на сервер не уходят.
#[tauri::command]
fn games_running() -> Vec<games::RunningApp> {
    games::running_apps()
}

#[tauri::command]
fn games_add_custom(app: AppHandle, exe: String, path: Option<String>, name: String) -> Result<GamesView, String> {
    let exe = exe.trim().to_lowercase();
    let name: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(100).collect();
    if exe.is_empty() || !exe.ends_with(".exe") || exe.contains(['\\', '/']) {
        return Err("Нужно имя exe".into());
    }
    if games::is_not_game(&exe) {
        return Err("Это лаунчер или служебная программа, а не игра".into());
    }
    if name.is_empty() {
        return Err("Название игры".into());
    }
    games_update(&app, |g| {
        g.custom.retain(|c| c.exe != exe);
        g.custom.push(games::CustomGame { exe, path: path.map(|p| p.to_lowercase()), name });
        Ok(())
    })
}

#[tauri::command]
fn games_remove_custom(app: AppHandle, exe: String) -> Result<GamesView, String> {
    games_update(&app, |g| {
        g.custom.retain(|c| c.exe != exe);
        g.hidden.retain(|k| *k != format!("custom:{exe}"));
        Ok(())
    })
}

/// Dota 2 GSI: включить — cfg в папку Dota (с токеном) и локальный приёмник на 127.0.0.1; выключить — убрать cfg.
#[tauri::command]
fn games_dota_gsi(app: AppHandle, enabled: bool) -> Result<GamesView, String> {
    if enabled {
        let mut s = load_settings(&app);
        if s.games.gsi_token.len() < 32 {
            s.games.gsi_token = games::new_token();
            store_settings(&app, &s)?;
        }
        games::gsi_install(&s.games.gsi_token)?;
    } else {
        games::gsi_uninstall();
    }
    games_update(&app, |g| {
        g.dota_gsi = enabled;
        Ok(())
    })
}

/// Кнопки и перетаскивание своего заголовка окна (и меню Snap Layouts) — для страницы сервера и экрана подключения.
const WINDOW_PERMS: &str = r#""core:window:allow-minimize","core:window:allow-toggle-maximize","core:window:allow-close",
    "core:window:allow-start-dragging","core:window:allow-internal-toggle-maximize","core:window:allow-is-maximized",
    "core:window:allow-is-decorated","allow-snap-layout","allow-window-active",
    "allow-games-set-catalog","allow-games-get","allow-games-set","allow-games-running","allow-games-add-custom","allow-games-remove-custom","allow-games-dota-gsi""#;

/// Активно ли окно (для приглушённого заголовка); дальше — событие `window-active`.
#[tauri::command]
fn window_active() -> bool {
    #[cfg(windows)]
    return snap::main_active();
    #[cfg(not(windows))]
    true
}

/// Меню Snap Layouts Windows 11 при наведении на «развернуть» в своём заголовке.
#[tauri::command]
fn snap_layout(app: AppHandle) -> bool {
    #[cfg(windows)]
    if snap::supported() {
        if let Some(w) = app.get_webview_window("main") {
            if snap::main_active() && !w.is_minimized().unwrap_or(true) {
                snap::show();
                return true;
            }
        }
    }
    let _ = app;
    false
}

// ---------- нативная демонстрация экрана ----------
#[cfg(windows)]
#[tauri::command]
async fn screen_sources() -> Vec<share::Source> {
    tauri::async_runtime::spawn_blocking(share::sources).await.unwrap_or_default()
}

#[cfg(windows)]
#[tauri::command]
async fn screen_start(app: AppHandle, args: share::StartArgs) -> Result<String, String> {
    share::start(app, &endpoint::current(), args).await
}

#[cfg(windows)]
#[tauri::command]
async fn screen_stop() {
    share::stop().await;
}

#[cfg(windows)]
#[tauri::command]
async fn screen_update(app: AppHandle, args: share::UpdateArgs) -> Result<String, String> {
    share::update(app, &endpoint::current(), args).await
}

/// Звук трансляции отдельно от микрофона: on = null — узнать. Ответ: включён ли, null — недоступен на этой Windows.
#[cfg(windows)]
#[tauri::command]
async fn screen_audio(on: Option<bool>) -> Result<Option<bool>, String> {
    share::set_audio(on).await
}

// ---------- автообновление ----------
#[cfg(windows)]
#[tauri::command]
fn update_status() -> Option<update::Ready> {
    update::status()
}

#[cfg(windows)]
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<update::Ready>, String> {
    update::check(&app).await
}

/// «Перезапустить и обновить»: установщик в режиме обновления сам перезапустит Relay.
#[cfg(windows)]
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    share::stop().await;
    update::install(true)?;
    if std::env::var_os("RELAY_UPDATE_DRYRUN").is_none() {
        QUITTING.store(true, Ordering::SeqCst);
        app.exit(0);
    }
    Ok(())
}

// ---------- глобальные горячие клавиши (рация, микрофон, звук, трансляция…) ----------
/// Привязки «действие → сочетание» от страницы. Пустой список — глобальных клавиш нет.
#[tauri::command]
fn hotkeys_set(binds: Vec<hotkeys::BindIn>) {
    hotkeys::set(&binds);
}

/// Совместимость со страницей, которая знает только клавишу рации (до горячих клавиш): пусто — выключено.
#[tauri::command]
fn ptt_set_key(code: String) {
    hotkeys::set(&if code.is_empty() { vec![] } else { vec![hotkeys::BindIn { action: "ptt".into(), combo: code }] });
}

fn start_hotkeys(app: AppHandle) {
    // Колбэк хука должен возвращаться мгновенно: Windows молча снимает низкоуровневый хук, если тот задерживает ввод.
    // В хуке — только отправка в канал, сопоставление с привязками — в другом потоке.
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel::<(String, bool)>();
        std::thread::spawn(move || {
            let res = hook::run(Box::new(move |code, down| {
                let _ = tx.send((code, down));
            }));
            if let Err(e) = res {
                eprintln!("глобальные горячие клавиши недоступны: {e}");
            }
        });
        std::thread::spawn(move || {
            let debug = std::env::var("RELAY_DESKTOP_DEBUG").is_ok();
            for (code, down) in rx {
                let evs = hotkeys::ENGINE.lock().unwrap().get_or_insert_with(Default::default).input(&code, down);
                // В фокусе ли окно Relay: тогда нажатие уже обработала страница. Сама страница этого не знает:
                // в WebView2 document.hasFocus() остаётся true и когда окно приложения в фоне.
                let focused = !evs.is_empty() && snap::main_active();
                for e in evs {
                    if debug {
                        eprintln!("hotkey: {} down={} focused={focused}", e.action, e.down);
                    }
                    // прежнее событие рации — для страницы, которая ещё не знает горячих клавиш
                    if e.action == "ptt" && !focused {
                        let _ = app.emit("ptt", e.down);
                    }
                    let _ = app.emit("hotkey", serde_json::json!({ "action": e.action, "down": e.down, "focused": focused }));
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

// ---------- запуск ----------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Тестовый профиль (автотесты) — отдельный экземпляр рядом с настоящим Relay пользователя, не трогая его.
    if test_profile().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
    }
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            connect,
            server_get,
            server_set,
            notify,
            attention,
            set_unread,
            ptt_set_key,
            hotkeys_set,
            set_theme,
            app_info,
            autostart_get,
            autostart_set,
            tray_get,
            tray_set,
            screen_sources,
            screen_start,
            screen_stop,
            screen_update,
            screen_audio,
            update_status,
            update_check,
            update_install,
            snap_layout,
            window_active,
            games_set_catalog,
            games_get,
            games_set,
            games_running,
            games_add_custom,
            games_remove_custom,
            games_dota_gsi,
            session_get,
            session_put,
            endpoint_failover,
            endpoints,
            endpoint_prefer
        ])
        .setup(|app| {
            if SERVER.is_empty() {
                endpoint::set_runtime_server(load_settings(app.handle()).server_url);
            }
            let h = app.handle().clone();
            create_main(&h, std::env::args().any(|a| a == "--minimized"))?;
            #[cfg(windows)]
            if let Some(hwnd) = app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
                snap::watch_active(h.clone(), hwnd.0 as isize);
            }
            let open = MenuItem::with_id(app, "open", format!("Открыть {BRAND}"), true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("relay")
                .icon(tray_icon())
                .tooltip(BRAND)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        // Скачанное обновление ставится тихо при выходе (как в Discord).
                        #[cfg(windows)]
                        if update::status().is_some() {
                            let _ = update::install(false);
                        }
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            #[cfg(windows)]
            update::spawn(h.clone());
            // Игровая активность: опрос раз в 15 с; справочник — из кэша, затем со страницы.
            games::start(h.clone(), load_settings(&h).games, app.path().app_local_data_dir().unwrap_or_default());
            start_hotkeys(h);
            Ok(())
        })
        .on_window_event(|w, e| {
            // Закрытие главного окна — в трей (если включено), как в Discord.
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "main" && !QUITTING.load(Ordering::SeqCst) && load_settings(w.app_handle()).close_to_tray {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("ошибка запуска NoxVC");
}

#[cfg(test)]
mod tests {
    #[test]
    fn fingerprint_hex() {
        assert_eq!(super::fingerprint("AAEC"), "00:01:02");
        assert!(super::PINS.split(',').filter(|p| !p.is_empty()).all(|p| super::fingerprint(p).len() == 95), "пин — SHA-256 в base64");
    }
}

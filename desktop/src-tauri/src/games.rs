//! Игровая активность «Играет в …» — определение на этой машине.
//!
//! Источники (и ничего больше — ни инжекта в процессы, ни оверлеев, ни чтения памяти игр):
//!   - реестр Steam: HKCU\Software\Valve\Steam\RunningAppID (0 — ничего не запущено) и Apps\<id>\Name;
//!   - список процессов (имена exe; время запуска и путь — только у совпавших), раз в 15 с;
//!   - Dota 2 Game State Integration (по желанию): Dota сама шлёт состояние на 127.0.0.1 с токеном.
//!
//! На страницу (а с неё — на сервер) уходит только найденная игра. Список процессов покидает это ядро
//! только по явному запросу окна «Добавить игру» — и только в локальный интерфейс.
//!
//! Игра засчитывается, если процесс живёт ≥ 10 с. Лаунчеры — не игры.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const POLL: Duration = Duration::from_secs(15);
const MIN_ALIVE_MS: i64 = 10_000;
/// Детали (Dota GSI) — не чаще раза в 20 с; смена игры — сразу.
const DETAILS_EVERY: Duration = Duration::from_secs(20);
/// Порт Dota GSI (Dota шлёт на uri из cfg). Только 127.0.0.1.
pub const GSI_PORT: u16 = 47650;
const GSI_FRESH: Duration = Duration::from_secs(90);
const DOTA_APPID: u32 = 570;

/// Лаунчеры и служебное: не игры (их нельзя добавить вручную, и в «Добавить игру» их нет).
const NOT_GAMES: &[&str] = &[
    "steam.exe",
    "steamwebhelper.exe",
    "steamservice.exe",
    "gameoverlayui.exe",
    "epicgameslauncher.exe",
    "epicwebhelper.exe",
    "battle.net.exe",
    "blizzard battle.net app.exe",
    "agent.exe",
    "riotclientservices.exe",
    "riotclientux.exe",
    "riotclientuxrender.exe",
    "eadesktop.exe",
    "eabackgroundservice.exe",
    "origin.exe",
    "ubisoftconnect.exe",
    "upc.exe",
    "uplaywebcore.exe",
    "galaxyclient.exe",
    "goggalaxy.exe",
    "playnite.desktopapp.exe",
    "itch.exe",
    "lghub.exe",
    "discord.exe",
    "relay-desktop.exe",
    "msedgewebview2.exe",
    "explorer.exe",
    "taskmgr.exe",
    "code.exe",
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "telegram.exe",
    "obs64.exe",
];

// ---------- настройки и справочник ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CustomGame {
    /// Имя exe в нижнем регистре.
    pub exe: String,
    /// Полный путь (нижний регистр) — если есть, совпадение только по нему.
    #[serde(default)]
    pub path: Option<String>,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GamesSettings {
    #[serde(default = "yes")]
    pub show_activity: bool,
    /// Скрытые игры: ключи steam:<appid> | game:<id> | custom:<exe>.
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub custom: Vec<CustomGame>,
    #[serde(default)]
    pub dota_gsi: bool,
    /// Токен Dota GSI (пишется в cfg; без него запросы отклоняются).
    #[serde(default)]
    pub gsi_token: String,
}
fn yes() -> bool {
    true
}
impl Default for GamesSettings {
    fn default() -> Self {
        Self { show_activity: true, hidden: vec![], custom: vec![], dota_gsi: false, gsi_token: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CatalogGame {
    pub id: i32,
    pub name: String,
    pub exes: Vec<String>,
    #[serde(default)]
    pub path_hint: Option<String>,
    #[serde(default)]
    pub steam_appid: Option<u32>,
}

/// Найденная игра — то, что уходит на страницу (и с неё на сервер).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Detected {
    /// Ключ для «скрыть игру»: steam:<appid> | game:<id> | custom:<exe>.
    pub key: String,
    pub source: &'static str, // steam | detected | custom
    pub steam_appid: Option<u32>,
    pub game_id: Option<i32>,
    pub name: String,
    pub started_at: i64,
    pub details: Option<String>,
    pub state: Option<String>,
}

struct State {
    settings: GamesSettings,
    catalog: Vec<CatalogGame>,
    current: Option<Detected>,
    last_details_emit: Option<Instant>,
    /// Steam: когда впервые увидели запущенный appid (если процесс игры не нашли в справочнике).
    steam_seen: HashMap<u32, i64>,
    gsi: Option<(Instant, Gsi)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State { settings: GamesSettings::default(), catalog: vec![], current: None, last_details_emit: None, steam_seen: HashMap::new(), gsi: None })
});
static WAKE: OnceLock<Sender<()>> = OnceLock::new();
static CATALOG_FILE: OnceLock<PathBuf> = OnceLock::new();

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn wake() {
    if let Some(w) = WAKE.get() {
        let _ = w.send(());
    }
}

/// Запуск: настройки, кэш справочника, опрос, Dota GSI (если включён).
pub fn start(app: AppHandle, settings: GamesSettings, cache_dir: PathBuf) {
    let file = cache_dir.join("games-catalog.json");
    let catalog: Vec<CatalogGame> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let _ = CATALOG_FILE.set(file);
    {
        let mut s = STATE.lock().unwrap();
        s.settings = settings.clone();
        s.catalog = catalog;
    }
    if settings.dota_gsi {
        gsi_server_start();
    }
    let (tx, rx) = channel();
    let _ = WAKE.set(tx);
    std::thread::Builder::new().name("relay-games".into()).spawn(move || poll_loop(app, rx)).ok();
}

/// Справочник с сервера (страница присылает при каждом запуске) — в память и на диск.
pub fn set_catalog(games: Vec<CatalogGame>) {
    let games: Vec<CatalogGame> = games
        .into_iter()
        .take(5000)
        .map(|mut g| {
            g.exes = g.exes.into_iter().map(|e| e.to_lowercase()).collect();
            g.path_hint = g.path_hint.map(|p| p.to_lowercase());
            g
        })
        .collect();
    if let Some(f) = CATALOG_FILE.get() {
        let _ = std::fs::write(f, serde_json::to_vec(&games).unwrap_or_default());
    }
    STATE.lock().unwrap().catalog = games;
    wake();
}

pub fn settings() -> GamesSettings {
    STATE.lock().unwrap().settings.clone()
}

/// Новые настройки (уже сохранённые вызывающим): применить сразу.
pub fn apply_settings(new: GamesSettings) {
    let gsi_was = {
        let mut s = STATE.lock().unwrap();
        let was = s.settings.dota_gsi;
        s.settings = new.clone();
        was
    };
    if new.dota_gsi && !gsi_was {
        gsi_server_start();
    }
    // Выключено — приёмник остаётся (порт не отдаём на полпути), но отвечает 403 и данные забываются.
    if !new.dota_gsi {
        STATE.lock().unwrap().gsi = None;
    }
    wake();
}

pub fn current() -> Option<Detected> {
    STATE.lock().unwrap().current.clone()
}

// ---------- опрос ----------

fn poll_loop(app: AppHandle, rx: Receiver<()>) {
    let mut wait = Duration::from_secs(3); // первый опрос — вскоре после запуска
    loop {
        match rx.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let (found, retry) = detect();
        wait = retry.unwrap_or(POLL).min(POLL);
        emit_if_changed(&app, found);
    }
}

/// Отправить на страницу, если изменилось. Смена игры — сразу; только детали — не чаще DETAILS_EVERY.
fn emit_if_changed(app: &AppHandle, found: Option<Detected>) {
    let mut s = STATE.lock().unwrap();
    if s.current == found {
        return;
    }
    let same_game = matches!((&s.current, &found), (Some(a), Some(b)) if a.key == b.key && a.started_at == b.started_at);
    if same_game && s.last_details_emit.is_some_and(|t| t.elapsed() < DETAILS_EVERY) {
        return;
    }
    s.current = found.clone();
    s.last_details_emit = Some(Instant::now());
    drop(s);
    let _ = app.emit("game-activity", found);
}

/// Найти текущую игру. Второе значение — через сколько перепроверить (кандидат ещё не прожил 10 с).
fn detect() -> (Option<Detected>, Option<Duration>) {
    let (settings, catalog) = {
        let s = STATE.lock().unwrap();
        (s.settings.clone(), s.catalog.clone())
    };
    if !settings.show_activity {
        return (None, None);
    }
    let now = now_ms();
    let procs = sys::processes();
    let mut found: Vec<Detected> = vec![];

    // Справочник и свои игры — по имени exe (путь и время запуска — только у совпавших).
    let mut by_exe: HashMap<&str, Vec<&CatalogGame>> = HashMap::new();
    for g in &catalog {
        for e in &g.exes {
            by_exe.entry(e.as_str()).or_default().push(g);
        }
    }
    let custom: HashMap<&str, Vec<&CustomGame>> = settings.custom.iter().fold(HashMap::new(), |mut m, c| {
        m.entry(c.exe.as_str()).or_insert_with(Vec::new).push(c);
        m
    });
    let mut seen_keys: HashSet<String> = HashSet::new();
    for p in &procs {
        let exe = p.exe.as_str();
        if NOT_GAMES.contains(&exe) {
            continue;
        }
        if let Some(gs) = by_exe.get(exe) {
            let info = sys::process_info(p.pid);
            for g in gs {
                if let Some(h) = &g.path_hint {
                    if !info.as_ref().is_some_and(|i| i.path.contains(h.as_str())) {
                        continue;
                    }
                }
                let started = info.as_ref().map(|i| i.started_ms).unwrap_or(now);
                let (key, source) = match g.steam_appid {
                    Some(a) => (format!("steam:{a}"), "steam"),
                    None => (format!("game:{}", g.id), "detected"),
                };
                if !seen_keys.insert(key.clone()) {
                    continue;
                }
                found.push(Detected {
                    key,
                    source,
                    steam_appid: g.steam_appid,
                    game_id: Some(g.id),
                    name: g.name.clone(),
                    started_at: started,
                    details: None,
                    state: None,
                });
            }
        }
        if let Some(cs) = custom.get(exe) {
            let info = sys::process_info(p.pid);
            for c in cs {
                if let Some(path) = &c.path {
                    if !info.as_ref().is_some_and(|i| &i.path == path) {
                        continue;
                    }
                }
                let key = format!("custom:{}", c.exe);
                if !seen_keys.insert(key.clone()) {
                    continue;
                }
                found.push(Detected {
                    key,
                    source: "custom",
                    steam_appid: None,
                    game_id: None,
                    name: c.name.clone(),
                    started_at: info.as_ref().map(|i| i.started_ms).unwrap_or(now),
                    details: None,
                    state: None,
                });
            }
        }
    }

    // Steam: RunningAppID. Если процесс этой игры уже нашли по справочнику — берём его время запуска.
    let running = sys::steam_running_appid().filter(|a| *a != 0);
    {
        let mut s = STATE.lock().unwrap();
        s.steam_seen.retain(|a, _| Some(*a) == running);
        if let Some(appid) = running {
            let key = format!("steam:{appid}");
            let name = sys::steam_app_name(appid);
            if let Some(d) = found.iter_mut().find(|d| d.key == key) {
                d.source = "steam";
                if let Some(n) = name {
                    d.name = n;
                }
            } else {
                let first = *s.steam_seen.entry(appid).or_insert(now);
                found.push(Detected {
                    key,
                    source: "steam",
                    steam_appid: Some(appid),
                    game_id: None,
                    name: name.unwrap_or_else(|| "Игра Steam".into()),
                    started_at: first,
                    details: None,
                    state: None,
                });
            }
        }
    }
    // Найденное по справочнику со steam_appid, но не через Steam (игра запущена в обход) — как «из справочника».
    for d in found.iter_mut() {
        if d.source == "steam" && d.steam_appid.is_some() && running != d.steam_appid && d.game_id.is_some() {
            d.source = "detected";
            d.key = format!("game:{}", d.game_id.unwrap_or_default());
        }
    }

    // Скрытые, и те, что живут меньше 10 с (перепроверить, когда исполнится).
    let mut retry: Option<Duration> = None;
    found.retain(|d| {
        if settings.hidden.contains(&d.key) {
            return false;
        }
        let age = now - d.started_at;
        if age < MIN_ALIVE_MS {
            let left = Duration::from_millis((MIN_ALIVE_MS - age).max(500) as u64 + 300);
            retry = Some(retry.map_or(left, |r: Duration| r.min(left)));
            return false;
        }
        true
    });
    // Несколько игр — самая недавно запущенная.
    let mut best = found.into_iter().max_by_key(|d| d.started_at);
    if let Some(d) = best.as_mut() {
        if d.steam_appid == Some(DOTA_APPID) && settings.dota_gsi {
            dota_details(d);
        }
    }
    (best, retry)
}

// ---------- Dota 2 Game State Integration ----------

#[derive(Default, Clone, Debug)]
struct Gsi {
    game_state: Option<String>,
    clock: Option<i64>,
    hero: Option<String>,
    kills: i64,
    deaths: i64,
    assists: i64,
}

fn dota_details(d: &mut Detected) {
    let g = {
        let s = STATE.lock().unwrap();
        s.gsi.clone()
    };
    let Some((at, g)) = g.filter(|(at, _)| at.elapsed() < GSI_FRESH) else { return };
    let _ = at;
    match g.game_state.as_deref() {
        None => {
            d.details = Some("В меню".into());
        }
        Some(
            "DOTA_GAMERULES_STATE_HERO_SELECTION"
            | "DOTA_GAMERULES_STATE_STRATEGY_TIME"
            | "DOTA_GAMERULES_STATE_TEAM_SHOWCASE"
            | "DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD"
            | "DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD"
            | "DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP",
        ) => {
            d.details = Some("Выбор героя".into());
        }
        Some("DOTA_GAMERULES_STATE_PRE_GAME" | "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS") => {
            let mins = g.clock.map(|c| c.max(0) / 60).unwrap_or(0);
            d.details = Some(match &g.hero {
                Some(h) => format!("{} · {} мин", hero_name(h), mins),
                None => format!("В матче · {mins} мин"),
            });
            d.state = Some(format!("{} / {} / {}", g.kills, g.deaths, g.assists));
        }
        Some("DOTA_GAMERULES_STATE_POST_GAME") => {
            d.details = Some("Матч завершён".into());
            d.state = Some(format!("{} / {} / {}", g.kills, g.deaths, g.assists));
        }
        Some(_) => {
            d.details = Some("В меню".into());
        }
    }
}

/// npc_dota_hero_antimage → Anti-Mage (внутренние имена, которые не выводятся из себя, — таблицей).
pub fn hero_name(internal: &str) -> String {
    let n = internal.strip_prefix("npc_dota_hero_").unwrap_or(internal);
    let special = [
        ("antimage", "Anti-Mage"),
        ("nevermore", "Shadow Fiend"),
        ("zuus", "Zeus"),
        ("furion", "Nature's Prophet"),
        ("obsidian_destroyer", "Outworld Destroyer"),
        ("magnataur", "Magnus"),
        ("necrolyte", "Necrophos"),
        ("skeleton_king", "Wraith King"),
        ("rattletrap", "Clockwerk"),
        ("windrunner", "Windranger"),
        ("life_stealer", "Lifestealer"),
        ("queenofpain", "Queen of Pain"),
        ("treant", "Treant Protector"),
        ("wisp", "Io"),
        ("shredder", "Timbersaw"),
        ("doom_bringer", "Doom"),
        ("centaur", "Centaur Warrunner"),
        ("abyssal_underlord", "Underlord"),
        ("vengefulspirit", "Vengeful Spirit"),
        ("keeper_of_the_light", "Keeper of the Light"),
        ("sand_king", "Sand King"),
        ("drow_ranger", "Drow Ranger"),
        ("lone_druid", "Lone Druid"),
        ("legion_commander", "Legion Commander"),
        ("monkey_king", "Monkey King"),
        ("primal_beast", "Primal Beast"),
        ("void_spirit", "Void Spirit"),
        ("dark_willow", "Dark Willow"),
    ];
    if let Some((_, v)) = special.iter().find(|(k, _)| *k == n) {
        return v.to_string();
    }
    n.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Поток приёмника запущен (один раз за работу приложения) и порт занят.
static GSI_STARTED: AtomicBool = AtomicBool::new(false);
static GSI_BOUND: AtomicBool = AtomicBool::new(false);

/// Локальный приёмник Dota GSI: только 127.0.0.1, только POST с правильным токеном, без Origin (не из браузера).
fn gsi_server_start() {
    if GSI_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("relay-dota-gsi".into())
        .spawn(|| {
            let listener = match TcpListener::bind(("127.0.0.1", GSI_PORT)) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Dota GSI: порт {GSI_PORT} занят: {e}");
                    GSI_STARTED.store(false, Ordering::SeqCst);
                    return;
                }
            };
            GSI_BOUND.store(true, Ordering::SeqCst);
            for c in listener.incoming().flatten() {
                // Соединения — по очереди и с таймаутами: Dota шлёт редко, чужие клиенты не задержат надолго.
                let _ = handle_gsi(c);
            }
        })
        .ok();
}

/// Приёмник слушает и интеграция включена.
pub fn gsi_running() -> bool {
    GSI_BOUND.load(Ordering::SeqCst) && STATE.lock().unwrap().settings.dota_gsi
}

const GSI_MAX_BODY: usize = 256 * 1024;

fn handle_gsi(mut c: TcpStream) -> std::io::Result<()> {
    if !c.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false) {
        return Ok(());
    }
    c.set_read_timeout(Some(Duration::from_secs(5)))?;
    c.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut r = BufReader::new(c.try_clone()?);
    // Общий предел на соединение: медленная отправка по байту не займёт приёмник надолго (таймаут — на каждое чтение).
    let deadline = Instant::now() + Duration::from_secs(10);
    for _ in 0..64 {
        if Instant::now() > deadline {
            return Ok(());
        }
        // запрос: строка + заголовки (не больше 16 КБ)
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let post = line.starts_with("POST ");
        let (mut len, mut origin, mut close, mut total) = (0usize, false, false, line.len());
        loop {
            let mut h = String::new();
            let n = r.read_line(&mut h)?;
            total += n;
            if n == 0 || total > 16 * 1024 || Instant::now() > deadline {
                return Ok(());
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            let (k, v) = h.split_once(':').unwrap_or((h, ""));
            let k = k.trim().to_ascii_lowercase();
            if k == "content-length" {
                len = v.trim().parse().unwrap_or(usize::MAX);
            }
            if k == "origin" {
                origin = true;
            }
            if k == "connection" && v.trim().eq_ignore_ascii_case("close") {
                close = true;
            }
        }
        // Браузер (страница с чужого сайта) всегда присылает Origin в кросс-доменном POST — такие не принимаем.
        if !post || origin || len > GSI_MAX_BODY {
            let _ = c.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return Ok(());
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body)?;
        let (token, enabled) = {
            let s = STATE.lock().unwrap();
            (s.settings.gsi_token.clone(), s.settings.dota_gsi)
        };
        // Интеграция выключена — ничего не принимаем.
        let token = if enabled { token } else { String::new() };
        let accepted = parse_gsi(&body, &token)
            .map(|g| {
                STATE.lock().unwrap().gsi = Some((Instant::now(), g));
            })
            .is_some();
        if accepted {
            wake_soon();
        }
        let resp: &[u8] = if accepted { b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n" } else { b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n" };
        c.write_all(resp)?;
        if close || !accepted {
            return Ok(());
        }
    }
    Ok(())
}

/// Обновление из Dota: не чаще опроса (детали и так уходят не чаще раза в 20 с).
fn wake_soon() {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut l = LAST.lock().unwrap();
    if l.is_none_or(|t| t.elapsed() > POLL) {
        *l = Some(Instant::now());
        wake();
    }
}

/// Тело Dota GSI → нужные поля; None — неверный токен или не JSON.
fn parse_gsi(body: &[u8], token: &str) -> Option<Gsi> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let got = v["auth"]["token"].as_str()?;
    if token.len() < 16 || !ct_eq(got.as_bytes(), token.as_bytes()) {
        return None;
    }
    let map = &v["map"];
    let player = &v["player"];
    let hero = v["hero"]["name"].as_str().filter(|h| h.starts_with("npc_dota_hero_") && h.len() < 64).map(String::from);
    Some(Gsi {
        game_state: map["game_state"].as_str().filter(|s| s.len() < 64).map(String::from),
        clock: map["clock_time"].as_i64(),
        hero,
        kills: player["kills"].as_i64().unwrap_or(0).clamp(0, 999),
        deaths: player["deaths"].as_i64().unwrap_or(0).clamp(0, 999),
        assists: player["assists"].as_i64().unwrap_or(0).clamp(0, 999),
    })
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Файл cfg для Dota (в каждую найденную установку «dota 2 beta»). Ok(путь) или Err(причина).
pub fn gsi_install(token: &str) -> Result<String, String> {
    let dirs = sys::dota_cfg_dirs();
    if dirs.is_empty() {
        return Err("Dota 2 не найдена в библиотеках Steam".into());
    }
    let cfg = format!(
        "\"Relay\"\n{{\n  \"uri\"        \"http://127.0.0.1:{GSI_PORT}/\"\n  \"timeout\"    \"5.0\"\n  \"buffer\"     \"1\"\n  \"throttle\"   \"5\"\n  \"heartbeat\"  \"30\"\n  \"data\"\n  {{\n    \"provider\"  \"1\"\n    \"map\"       \"1\"\n    \"player\"    \"1\"\n    \"hero\"      \"1\"\n  }}\n  \"auth\"\n  {{\n    \"token\"     \"{token}\"\n  }}\n}}\n"
    );
    let mut written = vec![];
    for d in dirs {
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let f = d.join("gamestate_integration_relay.cfg");
        std::fs::write(&f, &cfg).map_err(|e| e.to_string())?;
        written.push(f.display().to_string());
    }
    Ok(written.join("\n"))
}

pub fn gsi_uninstall() {
    for d in sys::dota_cfg_dirs() {
        let _ = std::fs::remove_file(d.join("gamestate_integration_relay.cfg"));
    }
}

/// Для окна «Добавить игру»: процессы с видимыми окнами (без системных, лаунчеров и уже добавленных). Только локально.
#[derive(Serialize)]
pub struct RunningApp {
    pub exe: String,
    pub path: String,
    pub title: String,
}

pub fn running_apps() -> Vec<RunningApp> {
    let custom: HashSet<String> = STATE.lock().unwrap().settings.custom.iter().map(|c| c.exe.clone()).collect();
    let mut out: Vec<RunningApp> = vec![];
    let mut seen = HashSet::new();
    for (pid, title) in sys::windows_with_titles() {
        let Some(info) = sys::process_info(pid) else { continue };
        let exe = info.path.rsplit(['\\', '/']).next().unwrap_or("").to_string();
        if exe.is_empty() || NOT_GAMES.contains(&exe.as_str()) || custom.contains(&exe) || info.path.starts_with("c:\\windows\\") {
            continue;
        }
        if !seen.insert(exe.clone()) {
            continue;
        }
        out.push(RunningApp { exe, path: info.path, title });
    }
    out.sort_by_key(|a| a.title.to_lowercase());
    out
}

pub fn is_not_game(exe: &str) -> bool {
    NOT_GAMES.contains(&exe)
}

pub fn new_token() -> String {
    let mut b = [0u8; 24];
    let _ = getrandom_fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn getrandom_fill(b: &mut [u8]) -> Result<(), ()> {
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new().fill(b).map_err(|_| ())
}

// ---------- Windows ----------
#[cfg(windows)]
mod sys {
    use std::path::PathBuf;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};

    pub struct Proc {
        pub pid: u32,
        pub exe: String,
    }
    pub struct Info {
        pub path: String,
        pub started_ms: i64,
    }

    fn wstr(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn from_w(b: &[u16]) -> String {
        String::from_utf16_lossy(&b[..b.iter().position(|c| *c == 0).unwrap_or(b.len())])
    }

    /// Имена exe всех процессов (нижний регистр). Без открытия процессов.
    pub fn processes() -> Vec<Proc> {
        let mut out = vec![];
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut e).is_ok();
            while ok {
                out.push(Proc { pid: e.th32ProcessID, exe: from_w(&e.szExeFile).to_lowercase() });
                ok = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    /// Путь и время запуска процесса (минимальные права: PROCESS_QUERY_LIMITED_INFORMATION).
    pub fn process_info(pid: u32) -> Option<Info> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let path = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .ok()
                .map(|_| String::from_utf16_lossy(&buf[..len as usize]).to_lowercase());
            let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            let times = GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).is_ok();
            let _ = CloseHandle(h);
            let ft = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
            // FILETIME: 100-нс интервалы с 1601-01-01
            let started_ms = if times && ft > 0 { (ft / 10_000) as i64 - 11_644_473_600_000 } else { super::now_ms() };
            Some(Info { path: path?, started_ms })
        }
    }

    fn steam_key() -> String {
        std::env::var("RELAY_DESKTOP_TEST_STEAM_KEY").unwrap_or_else(|_| r"Software\Valve\Steam".into())
    }

    fn reg_dword(sub: &str, name: &str) -> Option<u32> {
        let (sub, name) = (wstr(sub), wstr(name));
        let mut v: u32 = 0;
        let mut sz = 4u32;
        let r = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(sub.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut v as *mut u32 as *mut _),
                Some(&mut sz),
            )
        };
        r.is_ok().then_some(v)
    }
    fn reg_str(sub: &str, name: &str) -> Option<String> {
        let (sub, name) = (wstr(sub), wstr(name));
        let mut buf = vec![0u16; 512];
        let mut sz = (buf.len() * 2) as u32;
        let r = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), PCWSTR(name.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut sz))
        };
        r.is_ok().then(|| from_w(&buf)).filter(|s| !s.is_empty())
    }

    pub fn steam_running_appid() -> Option<u32> {
        reg_dword(&steam_key(), "RunningAppID")
    }

    pub fn steam_app_name(appid: u32) -> Option<String> {
        reg_str(&format!(r"{}\Apps\{appid}", steam_key()), "Name").map(|n| n.chars().filter(|c| !c.is_control()).take(100).collect())
    }

    /// Каталоги cfg/gamestate_integration во всех библиотеках Steam, где установлена Dota 2.
    pub fn dota_cfg_dirs() -> Vec<PathBuf> {
        let Some(steam) = reg_str(&steam_key(), "SteamPath") else { return vec![] };
        let steam = PathBuf::from(steam.replace('/', "\\"));
        let mut libs = vec![steam.clone()];
        if let Ok(vdf) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
            for line in vdf.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("\"path\"") {
                    let p = rest.trim().trim_matches('"').replace("\\\\", "\\");
                    if !p.is_empty() {
                        libs.push(PathBuf::from(p));
                    }
                }
            }
        }
        let mut out: Vec<PathBuf> = libs
            .into_iter()
            .map(|l| l.join("steamapps").join("common").join("dota 2 beta"))
            .filter(|d| d.join("game").join("dota").is_dir())
            .map(|d| d.join("game").join("dota").join("cfg").join("gamestate_integration"))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Видимые окна верхнего уровня с заголовком: (pid, заголовок).
    pub fn windows_with_titles() -> Vec<(u32, String)> {
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> windows::core::BOOL {
            let out = &mut *(l.0 as *mut Vec<(u32, String)>);
            if IsWindowVisible(h).as_bool() {
                let n = GetWindowTextLengthW(h);
                if n > 0 {
                    let mut buf = vec![0u16; n as usize + 1];
                    let got = GetWindowTextW(h, &mut buf);
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(h, Some(&mut pid));
                    if got > 0 && pid != 0 {
                        out.push((pid, String::from_utf16_lossy(&buf[..got as usize])));
                    }
                }
            }
            true.into()
        }
        let mut out: Vec<(u32, String)> = vec![];
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }
}

#[cfg(not(windows))]
mod sys {
    use std::path::PathBuf;
    pub struct Proc {
        pub pid: u32,
        pub exe: String,
    }
    pub struct Info {
        pub path: String,
        pub started_ms: i64,
    }
    pub fn processes() -> Vec<Proc> {
        vec![]
    }
    pub fn process_info(_: u32) -> Option<Info> {
        None
    }
    pub fn steam_running_appid() -> Option<u32> {
        None
    }
    pub fn steam_app_name(_: u32) -> Option<String> {
        None
    }
    pub fn dota_cfg_dirs() -> Vec<PathBuf> {
        vec![]
    }
    pub fn windows_with_titles() -> Vec<(u32, String)> {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hero_names() {
        assert_eq!(hero_name("npc_dota_hero_antimage"), "Anti-Mage");
        assert_eq!(hero_name("npc_dota_hero_crystal_maiden"), "Crystal Maiden");
        assert_eq!(hero_name("npc_dota_hero_axe"), "Axe");
    }

    #[test]
    fn gsi_token_checked() {
        let t = "0123456789abcdef0123";
        let body = br#"{"auth":{"token":"0123456789abcdef0123"},"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","clock_time":754},"hero":{"name":"npc_dota_hero_axe"},"player":{"kills":3,"deaths":1,"assists":7}}"#;
        let g = parse_gsi(body, t).expect("принят");
        assert_eq!((g.hero.as_deref(), g.clock, g.kills, g.deaths, g.assists), (Some("npc_dota_hero_axe"), Some(754), 3, 1, 7));
        assert!(parse_gsi(&body[..], "другой-токен-0123456").is_none());
        assert!(parse_gsi(br#"{"map":{}}"#, t).is_none());
        assert!(parse_gsi(b"not json", t).is_none());
        assert!(parse_gsi(body, "short").is_none(), "слабый токен — не принимаем ничего");
    }

    #[test]
    fn dota_states() {
        let mut d = Detected {
            key: "steam:570".into(),
            source: "steam",
            steam_appid: Some(570),
            game_id: None,
            name: "Dota 2".into(),
            started_at: 0,
            details: None,
            state: None,
        };
        STATE.lock().unwrap().gsi = Some((
            Instant::now(),
            Gsi {
                game_state: Some("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS".into()),
                clock: Some(754),
                hero: Some("npc_dota_hero_axe".into()),
                kills: 3,
                deaths: 1,
                assists: 7,
            },
        ));
        dota_details(&mut d);
        assert_eq!((d.details.as_deref(), d.state.as_deref()), (Some("Axe · 12 мин"), Some("3 / 1 / 7")));
        STATE.lock().unwrap().gsi = Some((Instant::now(), Gsi::default()));
        let mut m = Detected { details: None, state: None, ..d.clone() };
        dota_details(&mut m);
        assert_eq!(m.details.as_deref(), Some("В меню"));
    }
}

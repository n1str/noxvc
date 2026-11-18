//! Активность «Играет в …». Определяет игру только десктоп-клиент (реестр Steam и список процессов на своей машине);
//! на сервер приходит одна найденная игра — никогда не список процессов.
//!
//! Активность живёт в памяти (как присутствие): видна тем, кто видит присутствие пользователя (общие серверы, ЛС,
//! друзья), только пока он «в сети» и не «невидимка». Названия и обложки — с сервера: справочник распознаваемых игр
//! (detectable_games) и кэш Steam (steam_apps; обложка скачивается в хранилище Relay — клиенты не ходят в Steam).
use crate::api::{bad, ApiError, Auth, R};
use crate::{now, social, AppState};
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Активность пользователя (в памяти).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Activity {
    #[serde(rename = "type")]
    pub kind: &'static str, // "playing"
    pub game_id: String, // steam:<appid> | game:<id> | custom
    pub name: String,
    pub icon_url: Option<String>,
    pub started_at: i64, // мс
    pub details: Option<String>,
    pub state: Option<String>,
    #[serde(skip)]
    pub steam_appid: Option<i64>,
}

#[derive(Deserialize)]
pub struct ActivityIn {
    /// steam — запущена через Steam (RunningAppID); detected — из справочника; custom — добавлена пользователем.
    source: String,
    steam_appid: Option<i64>,
    game_id: Option<i32>,
    name: Option<String>,
    started_at: Option<i64>,
    details: Option<String>,
    state: Option<String>,
}

#[derive(Deserialize)]
pub struct Body {
    activity: Option<ActivityIn>,
}

/// Строка для показа: без управляющих символов, обрезана, не пустая.
fn clean(s: Option<String>, max: usize) -> Option<String> {
    let s: String = s?.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(max).collect();
    (!s.is_empty()).then_some(s)
}

/// Не чаще раза в 2 с от одного пользователя (клиент и так шлёт не чаще раза в 15 с).
static LAST_SET: LazyLock<Mutex<HashMap<i64, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const MIN_INTERVAL: Duration = Duration::from_secs(2);

/// PUT /api/me/game — текущая игра (или null — не играет / скрыто).
pub async fn put(State(st): State<AppState>, Auth(uid): Auth, Json(b): Json<Body>) -> R {
    {
        let mut m = LAST_SET.lock().unwrap();
        if m.get(&uid).is_some_and(|t| t.elapsed() < MIN_INTERVAL) {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Слишком часто".into()));
        }
        m.insert(uid, Instant::now());
    }
    let act = match b.activity {
        Some(a) => Some(normalize(&st, a).await?),
        None => None,
    };
    // «Невидимка» — активность не хранится и не рассылается вообще.
    let act = if st.hub.chosen_presence(uid) == "invisible" { None } else { act };
    if st.hub.set_activity(uid, act.clone()) {
        social::broadcast_presence(&st, uid).await;
    }
    Ok(Json(json!({ "activity": act })))
}

async fn normalize(st: &AppState, a: ActivityIn) -> Result<Activity, ApiError> {
    let t = now();
    // Время начала — с клиента (время запуска процесса), но не из будущего и не раньше чем неделю назад.
    let started_at = a.started_at.filter(|s| *s <= t + 60_000 && *s >= t - 7 * 86_400_000).unwrap_or(t).min(t);
    let details = clean(a.details, 128);
    let state = clean(a.state, 128);
    let (game_id, name, steam_appid) = match a.source.as_str() {
        "steam" => {
            let id = a.steam_appid.filter(|x| (1..=u32::MAX as i64).contains(x)).ok_or_else(|| bad("steam_appid"))?;
            (format!("steam:{id}"), clean(a.name, 100).unwrap_or_else(|| "Игра Steam".into()), Some(id))
        }
        "detected" => {
            let id = a.game_id.ok_or_else(|| bad("game_id"))?;
            let row: Option<(String, Option<i64>)> =
                sqlx::query_as("SELECT name, steam_appid FROM detectable_games WHERE id=$1").bind(id).fetch_optional(&st.db).await?;
            let (name, appid) = row.ok_or_else(|| bad("Неизвестная игра"))?;
            (format!("game:{id}"), name, appid)
        }
        "custom" => ("custom".to_string(), clean(a.name, 100).ok_or_else(|| bad("Название игры"))?, None),
        _ => return Err(bad("source: steam, detected или custom")),
    };
    let mut act = Activity { kind: "playing", game_id, name, icon_url: None, started_at, details, state, steam_appid };
    if let Some(appid) = steam_appid {
        match steam_cached(st, appid).await {
            Some((n, icon)) => {
                // Для Steam — каноническое название из магазина; справочник может называть игру по-своему.
                if act.game_id.starts_with("steam:") {
                    if let Some(n) = n {
                        act.name = n;
                    }
                }
                act.icon_url = icon;
            }
            None => spawn_steam_fetch(st.clone(), appid),
        }
    }
    Ok(act)
}

// ---------- Steam: название и обложка, кэш в БД, картинка — в хранилище Relay ----------

/// Из кэша: Some((название, обложка)) — если уже спрашивали (удачно — 30 дней, неудачно — сутки).
async fn steam_cached(st: &AppState, appid: i64) -> Option<(Option<String>, Option<String>)> {
    let row: Option<(Option<String>, Option<String>, bool, i64)> =
        sqlx::query_as("SELECT name, icon, ok, fetched_at FROM steam_apps WHERE appid=$1").bind(appid).fetch_optional(&st.db).await.ok()?;
    let (name, icon, ok, at) = row?;
    let ttl = if ok { 30 * 86_400_000 } else { 86_400_000 };
    (now() - at < ttl).then_some((name, icon))
}

static IN_FLIGHT: LazyLock<Mutex<HashSet<i64>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static STEAM_HTTP: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent("Relay").build().expect("http"));
/// Не больше одного запроса к Steam одновременно.
static STEAM_GATE: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(1));

fn spawn_steam_fetch(st: AppState, appid: i64) {
    if !IN_FLIGHT.lock().unwrap().insert(appid) {
        return;
    }
    tokio::spawn(async move {
        let _g = STEAM_GATE.acquire().await;
        let res = fetch_steam(&st, appid).await;
        let (name, icon, ok) = match &res {
            Ok((n, i)) => (Some(n.clone()), i.clone(), true),
            Err(e) => {
                eprintln!("steam {appid}: {e}");
                (None, None, false)
            }
        };
        let _ = sqlx::query("INSERT INTO steam_apps(appid, name, icon, ok, fetched_at) VALUES($1,$2,$3,$4,$5)
                             ON CONFLICT (appid) DO UPDATE SET name=COALESCE(EXCLUDED.name, steam_apps.name), icon=COALESCE(EXCLUDED.icon, steam_apps.icon), ok=EXCLUDED.ok, fetched_at=EXCLUDED.fetched_at")
            .bind(appid).bind(&name).bind(&icon).bind(ok).bind(now()).execute(&st.db).await;
        IN_FLIGHT.lock().unwrap().remove(&appid);
        // Тем, кто уже играет в эту игру, — обложка (и название из магазина для запущенных через Steam).
        if ok {
            for uid in st.hub.refresh_steam_activity(appid, name.as_deref(), icon.as_deref()) {
                social::broadcast_presence(&st, uid).await;
            }
        }
    });
}

async fn fetch_steam(st: &AppState, appid: i64) -> Result<(String, Option<String>), String> {
    let url = format!("https://store.steampowered.com/api/appdetails?appids={appid}&filters=basic&l=russian");
    let v: Value = STEAM_HTTP.get(url).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let d = &v[appid.to_string()];
    if d["success"] != json!(true) {
        return Err("нет в магазине".into());
    }
    let name = clean(d["data"]["name"].as_str().map(String::from), 100).ok_or("без названия")?;
    // Обложку — только с CDN Steam, не больше 2 МБ, JPEG; храним у себя (клиенты в Steam не ходят).
    let icon = match d["data"]["header_image"].as_str() {
        Some(u) if u.starts_with("https://") && (u.contains(".steamstatic.com/") || u.contains(".akamai.steamstatic.com/")) => {
            let r = STEAM_HTTP.get(u).send().await.map_err(|e| e.to_string())?;
            let ok = r.status().is_success() && r.headers().get("content-type").and_then(|h| h.to_str().ok()).is_some_and(|t| t.starts_with("image/jpeg"));
            let bytes = if ok { r.bytes().await.map_err(|e| e.to_string())? } else { Default::default() };
            if ok && !bytes.is_empty() && bytes.len() <= 2 * 1024 * 1024 && bytes.starts_with(&[0xFF, 0xD8]) {
                let key = format!("games/steam-{appid}.jpg");
                st.store.put(&key, bytes.to_vec()).await.map_err(|e| e.to_string())?;
                Some(st.store.url(&key))
            } else {
                None
            }
        }
        _ => None,
    };
    Ok((name, icon))
}

/// GET /api/games/detectable — справочник для десктоп-клиента (имена exe → игра). Не секрет, но только для своих.
pub async fn detectable(State(st): State<AppState>, Auth(_): Auth) -> R {
    let rows: Vec<(i32, String, Vec<String>, Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT id, name, exes, path_hint, steam_appid FROM detectable_games ORDER BY id").fetch_all(&st.db).await?;
    let games: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, exes, path_hint, steam_appid)| json!({ "id": id, "name": name, "exes": exes, "path_hint": path_hint, "steam_appid": steam_appid }))
        .collect();
    Ok(Json(json!({ "games": games })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleans_strings() {
        assert_eq!(clean(Some("  Dota\u{0} 2\n ".into()), 100).as_deref(), Some("Dota 2"));
        assert_eq!(clean(Some("   ".into()), 100), None);
        assert_eq!(clean(Some("x".repeat(300)), 128).unwrap().chars().count(), 128);
    }
}

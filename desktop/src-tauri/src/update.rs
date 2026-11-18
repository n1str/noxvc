//! Автообновление Relay Desktop. Сервер раздаёт `/updates/latest.json` и установщик; приложение:
//! 1) через 15 с после запуска и затем раз в 6 ч читает манифест (TLS только к закреплённому ключу сервера);
//! 2) если версия новее — скачивает установщик и проверяет SHA-256 и подпись Ed25519 (ключ зашит в сборку,
//!    закрытая часть есть только у того, кто выпускает версии: подменить обновление нельзя даже через сервер);
//! 3) сообщает клиенту «обновление готово»: «Перезапустить» ставит сразу, иначе — при выходе из приложения.
//!
//! Установка — штатный установщик NSIS в режиме обновления (`/P /UPDATE /R` — с прогрессом и перезапуском).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Открытый ключ подписи обновлений (Ed25519). Закрытый: %USERPROFILE%\.relay\update-signing-key.pem у выпускающего.
const UPDATE_KEY: &str = match option_env!("RELAY_UPDATE_KEY") {
    Some(k) => k,
    None => "",
};

#[derive(Deserialize, Clone)]
struct Manifest {
    version: String,
    file: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    notes: String,
    sig: String,
}

#[derive(Serialize, Clone)]
pub struct Ready {
    pub version: String,
    pub notes: String,
}

struct Pending {
    ready: Ready,
    path: PathBuf,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// «1.2.10» > «1.2.9».
pub fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    p(a) > p(b)
}

/// Что подписывается: версия, имя файла и хеш — нельзя подсунуть старый подписанный установщик под новой версией.
pub fn signed_message(version: &str, file: &str, sha256: &str) -> String {
    format!("relay-update\n{version}\n{file}\n{sha256}")
}

fn verify(m: &Manifest, key_b64: &str) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (Ok(key), Ok(sig)) = (STANDARD.decode(key_b64), STANDARD.decode(&m.sig)) else { return false };
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key).verify(signed_message(&m.version, &m.file, &m.sha256).as_bytes(), &sig).is_ok()
}

/// Канал (подпапка) обновлений: для проверок — RELAY_UPDATE_CHANNEL=test → /updates/test/.
fn base_path() -> String {
    match std::env::var("RELAY_UPDATE_CHANNEL") {
        Ok(c) if c.chars().all(|x| x.is_ascii_alphanumeric()) && !c.is_empty() => format!("/updates/{c}/"),
        _ => "/updates/".into(),
    }
}

/// GET по HTTPS к точке входа (закреплённый ключ или публичный сертификат). Возвращает тело (200) или ошибку.
async fn get(e: &crate::endpoint::Endpoint, path: &str) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Через любую точку входа: установщик всё равно проверяется по подписи (Ed25519) и хешу.
    let (hostport, host) = (e.hostport(), e.host());
    let cfg = crate::pin::client_config(&e.trust())?;
    let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?.to_owned();
    let tcp = tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect(&hostport))
        .await
        .map_err(|_| "нет связи с сервером".to_string())?
        .map_err(|_| "нет связи с сервером".to_string())?;
    let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp).await.map_err(|_| "ключ сервера не совпадает".to_string())?;
    let req =
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: RelayDesktop/{}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n", current());
    tls.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(600), tls.read_to_end(&mut raw)).await.map_err(|_| "сервер не ответил вовремя".to_string())?.or_else(|e| {
        if raw.is_empty() {
            Err(e.to_string())
        } else {
            Ok(0)
        }
    })?;
    parse_http(&raw)
}

/// Разбор ответа HTTP/1.1: статус, Content-Length или chunked.
pub fn parse_http(raw: &[u8]) -> Result<Vec<u8>, String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("неполный ответ сервера")?;
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let body = &raw[end + 4..];
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        return Err(format!("сервер ответил {status}"));
    }
    let header = |n: &str| head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(n)).map(|(_, v)| v.trim().to_string()));
    if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        let (mut out, mut i) = (Vec::new(), 0usize);
        loop {
            let le = body[i..].windows(2).position(|w| w == b"\r\n").ok_or("битый ответ сервера")? + i;
            let n =
                usize::from_str_radix(String::from_utf8_lossy(&body[i..le]).split(';').next().unwrap_or("").trim(), 16).map_err(|_| "битый ответ сервера")?;
            if n == 0 {
                break;
            }
            out.extend_from_slice(body.get(le + 2..le + 2 + n).ok_or("обрыв загрузки")?);
            i = le + 2 + n + 2;
        }
        return Ok(out);
    }
    if let Some(len) = header("content-length").and_then(|v| v.parse::<usize>().ok()) {
        if body.len() < len {
            return Err("обрыв загрузки".into());
        }
        return Ok(body[..len].to_vec());
    }
    Ok(body.to_vec())
}

fn dir() -> PathBuf {
    std::env::temp_dir().join("relay-update")
}

/// Проверить и (если есть новее) скачать обновление. Возвращает итог для интерфейса.
pub async fn check(app: &AppHandle) -> Result<Option<Ready>, String> {
    let ep = crate::endpoint::current();
    let _g = CHECKING.lock().await;
    if let Some(p) = PENDING.lock().unwrap().as_ref() {
        return Ok(Some(p.ready.clone()));
    }
    let base = base_path();
    let m: Manifest = serde_json::from_slice(&get(&ep, &format!("{base}latest.json")).await?).map_err(|_| "манифест обновления повреждён".to_string())?;
    if !newer(&m.version, current()) {
        return Ok(None);
    }
    if !verify(&m, UPDATE_KEY) {
        crate::share::slog(format!("обновление {}: подпись не сходится — отклонено", m.version));
        return Err("подпись обновления не сходится — обновление отклонено".into());
    }
    if m.file.contains(['/', '\\']) || !m.file.ends_with(".exe") {
        return Err("манифест обновления повреждён".into());
    }
    let path = dir().join(&m.file);
    let ok_on_disk = std::fs::read(&path).ok().is_some_and(|b| hex(&Sha256::digest(&b)) == m.sha256);
    if !ok_on_disk {
        let body = get(&ep, &format!("{base}{}", m.file)).await?;
        if body.len() as u64 != m.size || hex(&Sha256::digest(&body)) != m.sha256 {
            return Err("установщик обновления повреждён (хеш не совпал)".into());
        }
        let _ = std::fs::create_dir_all(dir());
        std::fs::write(&path, &body).map_err(|e| format!("не удалось сохранить обновление: {e}"))?;
    }
    let ready = Ready { version: m.version.clone(), notes: m.notes.clone() };
    *PENDING.lock().unwrap() = Some(Pending { ready: ready.clone(), path });
    crate::share::slog(format!("обновление {} скачано и проверено", m.version));
    let _ = app.emit("update_ready", ready.clone());
    Ok(Some(ready))
}

pub fn status() -> Option<Ready> {
    PENDING.lock().unwrap().as_ref().map(|p| p.ready.clone())
}

/// Поставить скачанное обновление: `restart` — с окном прогресса и перезапуском; иначе — тихо (при выходе).
pub fn install(restart: bool) -> Result<(), String> {
    let p = PENDING.lock().unwrap().take().ok_or("обновление не скачано")?;
    // Для проверок без настоящей установки.
    if std::env::var_os("RELAY_UPDATE_DRYRUN").is_some() {
        let _ = std::fs::write(dir().join("dryrun.txt"), format!("{} {}", p.ready.version, if restart { "restart" } else { "quiet" }));
        return Ok(());
    }
    let args: &[&str] = if restart { &["/P", "/UPDATE", "/R"] } else { &["/S", "/UPDATE"] };
    std::process::Command::new(&p.path).args(args).spawn().map_err(|e| format!("не удалось запустить установщик: {e}"))?;
    Ok(())
}

/// Фоновая проверка: через 15 с после запуска, затем раз в 6 часов (и уборка старых установщиков).
pub fn spawn(app: AppHandle) {
    // сборка без RELAY_UPDATE_KEY — автообновление выключено (нечем проверить подпись)
    if UPDATE_KEY.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(rd) = std::fs::read_dir(dir()) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if let Err(e) = check(&app).await {
                crate::share::slog(format!("проверка обновлений: {e}"));
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(newer("0.7.1", "0.7.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.7.0", "0.7.0"));
        assert!(!newer("0.6.9", "0.7.0"));
    }
    #[test]
    fn http() {
        assert_eq!(parse_http(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef").unwrap(), b"abc");
        assert_eq!(parse_http(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap(), b"abcde");
        assert!(parse_http(b"HTTP/1.1 404 Not Found\r\n\r\n").is_err());
    }
    #[test]
    fn signature() {
        // Подпись, сделанная ключом выпуска (node crypto), должна проходить; подмена версии — нет.
        let key = "v9G/3trQTmzKYAFR63fX4lNPkqqebUo+uP8CjZCI6ac=";
        let sig = "YpKyKS5B8U+E/Os9heCFpvLKZf+Or3KYSocAVRoicZINJXgabI2zP2DRvsKqbNmm3ZhEvLxmqJL4GAcnHxdCAw==";
        let mut m = Manifest { version: "1.0.0".into(), file: "a.exe".into(), sha256: "00".into(), size: 1, notes: String::new(), sig: sig.into() };
        assert!(verify(&m, key));
        assert!(!verify(&m, UPDATE_KEY), "чужой ключ не должен принимать подпись");
        m.version = "2.0.0".into();
        assert!(!verify(&m, key), "подмена версии ломает подпись");
    }
}

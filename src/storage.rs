//! Хранилище файлов (вложения, эмодзи, исходники и результаты обработки медиа профиля): ключ → байты.
//! Публичный URL всегда `/uploads/<ключ>` — раздаёт сам Relay, так что смена хранилища не меняет ссылок.
//!
//! - `local` — каталог на диске (по умолчанию, разработка и тесты);
//! - `s3` — S3-совместимое хранилище (у нас Garage). Подпись запросов AWS SigV4 — своя (hmac/sha2 уже есть),
//!   без тяжёлого SDK. Можно указать «запасной» каталог (RELAY_STORAGE_FALLBACK_DIR): ключи, которых ещё нет
//!   в S3 (до переноса старых файлов), читаются оттуда — переход на S3 без простоя.
//!
//! Настройка (env): RELAY_STORAGE=local|s3, RELAY_S3_ENDPOINT (http://garage:3900), RELAY_S3_BUCKET,
//! RELAY_S3_REGION (garage), RELAY_S3_ACCESS_KEY, RELAY_S3_SECRET_KEY.
use crate::metrics::M;
use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
    time::Instant,
};
use tower::ServiceExt;
use tower_http::services::ServeDir;

/// Ключи — только из безопасного набора символов, без «..» и пустых частей.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('/')
        && !key.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "недопустимый ключ")
}
fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

/// Тип содержимого по расширению. Неизвестное — octet-stream (скачивается, не исполняется в браузере).
pub fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        _ => "application/octet-stream",
    }
}

pub enum Store {
    Local(LocalStorage),
    S3(S3Storage),
}

/// Метрика операции: число (с результатом) и время.
async fn measured<T>(op: &'static str, f: impl std::future::Future<Output = io::Result<T>>) -> io::Result<T> {
    let t = Instant::now();
    let r = f.await;
    M.storage_duration.with_label_values(&[op]).observe(t.elapsed().as_secs_f64());
    M.storage_ops.with_label_values(&[op, if r.is_ok() { "success" } else { "failure" }]).inc();
    r
}

impl Store {
    /// Из окружения; `data_uploads` — каталог локального хранилища (и запасной для S3 по умолчанию не включён).
    pub fn from_env(data_uploads: PathBuf) -> Store {
        match std::env::var("RELAY_STORAGE").unwrap_or_default().as_str() {
            "s3" => {
                let v = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("RELAY_STORAGE=s3: нет {k}"));
                let fallback = std::env::var("RELAY_STORAGE_FALLBACK_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
                Store::S3(S3Storage::new(
                    &v("RELAY_S3_ENDPOINT"),
                    &v("RELAY_S3_BUCKET"),
                    &std::env::var("RELAY_S3_REGION").unwrap_or_else(|_| "garage".into()),
                    &v("RELAY_S3_ACCESS_KEY"),
                    &v("RELAY_S3_SECRET_KEY"),
                    fallback,
                ))
            }
            _ => Store::Local(LocalStorage::new(data_uploads)),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Store::Local(l) => format!("локальный каталог {}", l.root.display()),
            Store::S3(s) => {
                format!("S3 {} / {}{}", s.endpoint, s.bucket, s.fallback.as_ref().map(|f| format!(" (старые файлы — из {})", f.display())).unwrap_or_default())
            }
        }
    }

    /// Записать файл (атомарно: читатели не увидят половину).
    pub async fn put(&self, key: &str, data: Vec<u8>) -> io::Result<()> {
        if !valid_key(key) {
            return Err(invalid());
        }
        measured("put", async {
            match self {
                Store::Local(l) => l.put(key, data).await,
                Store::S3(s) => s.put(key, data).await,
            }
        })
        .await
    }

    /// Размер файла; None — нет такого.
    pub async fn size(&self, key: &str) -> io::Result<Option<u64>> {
        if !valid_key(key) {
            return Err(invalid());
        }
        measured("head", async {
            match self {
                Store::Local(l) => l.size(key).await,
                Store::S3(s) => match s.head(key).await? {
                    Some(n) => Ok(Some(n)),
                    None => match &s.fallback {
                        Some(f) => local_size(&f.join(key)).await,
                        None => Ok(None),
                    },
                },
            }
        })
        .await
    }

    /// Прочитать файл целиком (не больше `max` байт; больше — ошибка). None — нет такого.
    pub async fn get(&self, key: &str, max: u64) -> io::Result<Option<Vec<u8>>> {
        if !valid_key(key) {
            return Err(invalid());
        }
        measured("get", async {
            let r = match self {
                Store::Local(l) => local_read(&l.root.join(key)).await?,
                Store::S3(s) => match s.get(key).await? {
                    Some(b) => Some(b),
                    None => match &s.fallback {
                        Some(f) => local_read(&f.join(key)).await?,
                        None => None,
                    },
                },
            };
            match r {
                Some(b) if b.len() as u64 > max => Err(other("файл слишком большой")),
                r => Ok(r),
            }
        })
        .await
    }

    /// Локальный путь к файлу для внешних программ (ffmpeg): у диска — сам файл, у S3 — скачанная копия в `tmp`.
    pub async fn local_copy(&self, key: &str, tmp: &Path) -> io::Result<PathBuf> {
        match self {
            Store::Local(l) => {
                if !valid_key(key) {
                    return Err(invalid());
                }
                Ok(l.root.join(key))
            }
            Store::S3(_) => {
                let data = self.get(key, 64 * 1024 * 1024).await?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "нет файла"))?;
                let p = tmp.join("src");
                tokio::fs::write(&p, data).await?;
                Ok(p)
            }
        }
    }

    /// Удалить все файлы с префиксом-каталогом (`m/<job>/`).
    pub async fn delete_dir(&self, prefix: &str) -> io::Result<()> {
        let prefix = prefix.trim_end_matches('/');
        if !valid_key(prefix) {
            return Err(invalid());
        }
        measured("delete", async {
            match self {
                Store::Local(l) => l.delete_dir(prefix).await,
                Store::S3(s) => {
                    for (k, _) in s.list(&format!("{prefix}/")).await? {
                        s.delete(&k).await?;
                    }
                    Ok(())
                }
            }
        })
        .await
    }

    /// Публичный URL ключа.
    pub fn url(&self, key: &str) -> String {
        format!("/uploads/{key}")
    }

    /// Для метрик: (число файлов, байт) во всём хранилище.
    pub async fn usage(&self) -> io::Result<(u64, u64)> {
        measured("list", async {
            match self {
                Store::Local(l) => {
                    let (mut n, mut bytes, mut stack) = (0u64, 0u64, vec![l.root.clone()]);
                    while let Some(dir) = stack.pop() {
                        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
                        while let Some(e) = rd.next_entry().await? {
                            let m = e.metadata().await?;
                            if m.is_dir() {
                                stack.push(e.path());
                            } else {
                                n += 1;
                                bytes += m.len();
                            }
                        }
                    }
                    Ok((n, bytes))
                }
                Store::S3(s) => {
                    let l = s.list("").await?;
                    Ok((l.len() as u64, l.iter().map(|(_, b)| b).sum()))
                }
            }
        })
        .await
    }

    /// Отдать файл по запросу `/uploads/<ключ>` (Range, If-None-Match — для перемотки видео и кэша браузера).
    pub async fn serve(&self, key: &str, req: Request) -> Response {
        if !valid_key(key) {
            return StatusCode::NOT_FOUND.into_response();
        }
        match self {
            Store::Local(l) => serve_dir(&l.root, key, req).await,
            Store::S3(s) => {
                let t = Instant::now();
                let (method, headers) = (req.method().clone(), req.headers().clone());
                let r = s.serve(key, &method, &headers).await;
                M.storage_duration.with_label_values(&["serve"]).observe(t.elapsed().as_secs_f64());
                M.storage_ops.with_label_values(&["serve", if r.is_ok() { "success" } else { "failure" }]).inc();
                match r {
                    Ok(Some(resp)) => resp,
                    Ok(None) => match &s.fallback {
                        Some(f) => serve_dir(f, key, req).await,
                        None => StatusCode::NOT_FOUND.into_response(),
                    },
                    Err(e) => {
                        eprintln!("хранилище: {key}: {e}");
                        StatusCode::BAD_GATEWAY.into_response()
                    }
                }
            }
        }
    }
}

/// Перенос файлов из каталога в хранилище (разово, при переходе на S3). Повторный запуск безопасен:
/// файлы, которые уже есть с тем же размером, пропускаются; каталог не трогается.
pub async fn migrate_dir(store: &Store, dir: &Path) -> io::Result<(u64, u64, u64)> {
    let (mut copied, mut skipped, mut failed) = (0u64, 0u64, 0u64);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&d).await?;
        while let Some(e) = rd.next_entry().await? {
            let p = e.path();
            let m = e.metadata().await?;
            if m.is_dir() {
                stack.push(p);
                continue;
            }
            let key = p.strip_prefix(dir).map_err(other)?.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
            if !valid_key(&key) || key.ends_with(".part") {
                eprintln!("пропущен (недопустимое имя): {key}");
                skipped += 1;
                continue;
            }
            // У S3 смотрим именно S3 (size() с запасным каталогом нашёл бы и сам локальный файл).
            let have = match store {
                Store::S3(s) => s.head(&key).await.ok().flatten(),
                Store::Local(l) => l.size(&key).await.ok().flatten(),
            };
            if have == Some(m.len()) {
                skipped += 1;
                continue;
            }
            match store.put(&key, tokio::fs::read(&p).await?).await {
                Ok(()) => copied += 1,
                Err(err) => {
                    eprintln!("ошибка {key}: {err}");
                    failed += 1;
                }
            }
        }
    }
    Ok((copied, skipped, failed))
}

/// Отдача с диска — как раньше (ServeDir: Range, ETag/Last-Modified), тип — по нашему расширению.
async fn serve_dir(root: &Path, key: &str, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    parts.uri = format!("/{key}").parse().unwrap_or_default();
    let mut resp = match ServeDir::new(root).oneshot(Request::from_parts(parts, body)).await {
        Ok(r) => r.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if resp.status().is_success() {
        resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(key)));
    }
    resp
}

async fn local_size(p: &Path) -> io::Result<Option<u64>> {
    match tokio::fs::metadata(p).await {
        Ok(m) if m.is_file() => Ok(Some(m.len())),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
async fn local_read(p: &Path) -> io::Result<Option<Vec<u8>>> {
    match tokio::fs::read(p).await {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

// ---------- локальный диск ----------
pub struct LocalStorage {
    pub root: PathBuf,
}

impl LocalStorage {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    async fn put(&self, key: &str, data: Vec<u8>) -> io::Result<()> {
        let p = self.root.join(key);
        if let Some(dir) = p.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let tmp = p.with_extension("part");
        tokio::fs::write(&tmp, data).await?;
        tokio::fs::rename(&tmp, &p).await
    }
    async fn size(&self, key: &str) -> io::Result<Option<u64>> {
        local_size(&self.root.join(key)).await
    }
    async fn delete_dir(&self, prefix: &str) -> io::Result<()> {
        match tokio::fs::remove_dir_all(self.root.join(prefix)).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            r => r,
        }
    }
}

// ---------- S3 (SigV4) ----------
pub struct S3Storage {
    endpoint: String,
    host: String,
    bucket: String,
    region: String,
    access: String,
    secret: String,
    fallback: Option<PathBuf>,
    http: reqwest::Client,
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// Заголовки запроса браузера, которые передаём в S3 при отдаче (частичная загрузка и кэш).
const FORWARD: [header::HeaderName; 4] = [header::RANGE, header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE, header::IF_RANGE];
/// Заголовки ответа S3, которые отдаём браузеру (тип ставим свой — по расширению).
const PASS_BACK: [header::HeaderName; 5] = [header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ETAG, header::LAST_MODIFIED, header::ACCEPT_RANGES];

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}
fn hmac(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("hmac");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}
/// RFC 3986, как требует SigV4 (в пути «/» не кодируется).
fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            b'/' if keep_slash => o.push('/'),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// Время запроса в форматах SigV4: (20130524T000000Z, 20130524).
fn amz_now() -> (String, String) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // дни с 1970-01-01 → дата (алгоритм Хиннанта)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let date = format!("{y:04}{m:02}{d:02}");
    (format!("{date}T{:02}{:02}{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60), date)
}

/// Подпись SigV4: заголовок Authorization. `headers` — подписываемые заголовки (имена в нижнем регистре).
#[allow(clippy::too_many_arguments)]
fn sign(
    method: &str,
    path: &str,
    query: &str,
    headers: &[(String, String)],
    payload_hash: &str,
    amz_date: &str,
    date: &str,
    region: &str,
    access: &str,
    secret: &str,
) -> String {
    let mut hs: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string())).collect();
    hs.sort();
    let canonical_headers: String = hs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed: String = hs.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let creq = format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed}\n{payload_hash}");
    let scope = format!("{date}/{region}/s3/aws4_request");
    let sts = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(creq.as_bytes()));
    let k = hmac(&hmac(&hmac(&hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes()), region.as_bytes()), b"s3"), b"aws4_request");
    format!("AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={}", hex(&hmac(&k, sts.as_bytes())))
}

impl S3Storage {
    pub fn new(endpoint: &str, bucket: &str, region: &str, access: &str, secret: &str, fallback: Option<PathBuf>) -> Self {
        let endpoint = endpoint.trim_end_matches('/').to_string();
        let host = endpoint.split("://").nth(1).unwrap_or(&endpoint).split('/').next().unwrap_or("").to_string();
        let http = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(5)).build().expect("http-клиент");
        Self { endpoint, host, bucket: bucket.into(), region: region.into(), access: access.into(), secret: secret.into(), fallback, http }
    }

    /// Подписанный запрос (path-style: /<bucket>/<ключ>). `query` — уже канонический (отсортированный, закодированный).
    fn request(&self, method: Method, key: &str, query: &str, payload: Option<&[u8]>, extra: &[(header::HeaderName, HeaderValue)]) -> reqwest::RequestBuilder {
        let path = format!("/{}/{}", self.bucket, uri_encode(key, true));
        let (amz_date, date) = amz_now();
        let ph = payload.map(sha256_hex).unwrap_or_else(|| EMPTY_SHA256.into());
        let mut signed = vec![("host".to_string(), self.host.clone()), ("x-amz-content-sha256".into(), ph.clone()), ("x-amz-date".into(), amz_date.clone())];
        for (k, v) in extra {
            if let Ok(v) = v.to_str() {
                signed.push((k.as_str().to_string(), v.to_string()));
            }
        }
        let auth = sign(method.as_str(), &path, query, &signed, &ph, &amz_date, &date, &self.region, &self.access, &self.secret);
        let url = if query.is_empty() { format!("{}{path}", self.endpoint) } else { format!("{}{path}?{query}", self.endpoint) };
        let mut rb = self.http.request(method, url).header("x-amz-content-sha256", ph).header("x-amz-date", amz_date).header(header::AUTHORIZATION, auth);
        for (k, v) in extra {
            rb = rb.header(k, v);
        }
        if let Some(p) = payload {
            rb = rb.body(p.to_vec());
        }
        rb
    }

    async fn put(&self, key: &str, data: Vec<u8>) -> io::Result<()> {
        let ct = [(header::CONTENT_TYPE, HeaderValue::from_static(content_type(key)))];
        let r = self.request(Method::PUT, key, "", Some(&data), &ct).send().await.map_err(other)?;
        if r.status().is_success() {
            Ok(())
        } else {
            Err(other(format!("S3 PUT {key}: {}", r.status())))
        }
    }

    async fn head(&self, key: &str) -> io::Result<Option<u64>> {
        let r = self.request(Method::HEAD, key, "", None, &[]).send().await.map_err(other)?;
        match r.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => Ok(r.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok())),
            s => Err(other(format!("S3 HEAD {key}: {s}"))),
        }
    }

    async fn get(&self, key: &str) -> io::Result<Option<Vec<u8>>> {
        let r = self.request(Method::GET, key, "", None, &[]).send().await.map_err(other)?;
        match r.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => Ok(Some(r.bytes().await.map_err(other)?.to_vec())),
            s => Err(other(format!("S3 GET {key}: {s}"))),
        }
    }

    async fn delete(&self, key: &str) -> io::Result<()> {
        let r = self.request(Method::DELETE, key, "", None, &[]).send().await.map_err(other)?;
        if r.status().is_success() || r.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(other(format!("S3 DELETE {key}: {}", r.status())))
        }
    }

    /// Ключи с префиксом и размерами (ListObjectsV2, с продолжением).
    pub async fn list(&self, prefix: &str) -> io::Result<Vec<(String, u64)>> {
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            // канонический query: параметры по алфавиту
            let mut q = vec![];
            if let Some(t) = &token {
                q.push(format!("continuation-token={}", uri_encode(t, false)));
            }
            q.push("list-type=2".into());
            q.push(format!("prefix={}", uri_encode(prefix, false)));
            let q = q.join("&");
            let path = format!("/{}", self.bucket);
            let (amz_date, date) = amz_now();
            let signed =
                vec![("host".to_string(), self.host.clone()), ("x-amz-content-sha256".into(), EMPTY_SHA256.into()), ("x-amz-date".into(), amz_date.clone())];
            let auth = sign("GET", &path, &q, &signed, EMPTY_SHA256, &amz_date, &date, &self.region, &self.access, &self.secret);
            let r = self
                .http
                .get(format!("{}{path}?{q}", self.endpoint))
                .header("x-amz-content-sha256", EMPTY_SHA256)
                .header("x-amz-date", amz_date)
                .header(header::AUTHORIZATION, auth)
                .send()
                .await
                .map_err(other)?;
            if !r.status().is_success() {
                return Err(other(format!("S3 LIST {prefix}: {}", r.status())));
            }
            let xml = r.text().await.map_err(other)?;
            for c in xml_all(&xml, "Contents") {
                let k = xml_all(&c, "Key").into_iter().next().unwrap_or_default();
                let n = xml_all(&c, "Size").into_iter().next().and_then(|v| v.parse().ok()).unwrap_or(0);
                if !k.is_empty() {
                    keys.push((k, n));
                }
            }
            token = if xml_all(&xml, "IsTruncated").first().map(String::as_str) == Some("true") {
                xml_all(&xml, "NextContinuationToken").into_iter().next()
            } else {
                None
            };
            if token.is_none() {
                return Ok(keys);
            }
        }
    }

    /// Отдача браузеру: проксируем GET/HEAD с Range и условными заголовками, тело — потоком.
    /// Ok(None) — ключа нет в S3.
    async fn serve(&self, key: &str, method: &Method, headers: &HeaderMap) -> io::Result<Option<Response>> {
        let method = if method == Method::HEAD { Method::HEAD } else { Method::GET };
        let fwd: Vec<(header::HeaderName, HeaderValue)> = FORWARD.iter().filter_map(|h| headers.get(h).map(|v| (h.clone(), v.clone()))).collect();
        let r = self.request(method, key, "", None, &fwd).send().await.map_err(other)?;
        let status = r.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !(status.is_success() || status == StatusCode::NOT_MODIFIED || status == StatusCode::RANGE_NOT_SATISFIABLE) {
            return Err(other(format!("S3 {status}")));
        }
        let mut h = HeaderMap::new();
        for name in PASS_BACK {
            if let Some(v) = r.headers().get(&name) {
                h.insert(name, v.clone());
            }
        }
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(key)));
        // Имена файлов случайные и не перезаписываются — можно кэшировать надолго.
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
        let body = Body::from_stream(r.bytes_stream());
        Ok(Some((status, h, body).into_response()))
    }
}

/// Значения тегов <tag>…</tag> из ответа S3 (ключи у нас без спецсимволов XML, но разэкранируем на всякий случай).
fn xml_all(xml: &str, tag: &str) -> Vec<String> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = vec![];
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(after[..j].replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&"));
        rest = &after[j + close.len()..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_confined() {
        assert!(valid_key("m/abc/a32.webp") && valid_key("abc123.png"));
        for bad in ["../etc/passwd", "/etc/passwd", "m/../../x", "m//x", "m/./x", "", "m/a b", "m\\x"] {
            assert!(!valid_key(bad), "{bad}");
        }
    }

    /// Пример из документации AWS (GET Object с Range): та же подпись.
    #[test]
    fn sigv4_matches_aws_example() {
        let headers = vec![
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("range".into(), "bytes=0-9".into()),
            ("x-amz-content-sha256".into(), EMPTY_SHA256.into()),
            ("x-amz-date".into(), "20130524T000000Z".into()),
        ];
        let auth = sign(
            "GET",
            "/test.txt",
            "",
            &headers,
            EMPTY_SHA256,
            "20130524T000000Z",
            "20130524",
            "us-east-1",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        );
        assert_eq!(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn date_format() {
        let (full, d) = amz_now();
        assert_eq!(full.len(), 16);
        assert!(full.starts_with(&d) && full.ends_with('Z'));
    }

    #[test]
    fn list_xml() {
        let x = "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>m/a/a32.webp</Key><Size>12</Size></Contents><Contents><Key>m/a/a&amp;b</Key><Size>3</Size></Contents><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>";
        assert_eq!(xml_all(x, "Key"), vec!["m/a/a32.webp", "m/a/a&b"]);
        assert_eq!(xml_all(x, "Contents").iter().map(|c| xml_all(c, "Size")[0].clone()).collect::<Vec<_>>(), vec!["12", "3"]);
        assert_eq!(xml_all(x, "NextContinuationToken"), vec!["t1"]);
    }

    #[test]
    fn types_by_extension() {
        assert_eq!(content_type("m/x/a32.webp"), "image/webp");
        assert_eq!(content_type("x.bin"), "application/octet-stream");
        assert_eq!(content_type("x.HTML"), "application/octet-stream");
    }
}

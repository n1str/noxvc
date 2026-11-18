//! Закрепление сертификата сервера (TOFU): у сервера по IP самоподписанный сертификат.
//! Подключаемся по TLS, берём сертификат, считаем SHA-256 от SubjectPublicKeyInfo — это пин.
//! WebView2 запускается с `--ignore-certificate-errors-spki-list=<пин>`: доверяется ТОЛЬКО этот ключ,
//! любые другие ошибки сертификатов остаются ошибками.

use base64::{engine::general_purpose::STANDARD, Engine};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Как проверять сертификат точки входа: закреплённые ключи (сервер по IP с самоподписанным сертификатом)
/// или публичные корневые сертификаты (имя с сертификатом Let's Encrypt) — с проверкой имени, без исключений.
#[derive(Clone, Debug)]
pub enum Trust {
    Pins(Vec<String>),
    WebPki,
}

fn webpki() -> Arc<rustls::client::WebPkiServerVerifier> {
    static V: std::sync::LazyLock<Arc<rustls::client::WebPkiServerVerifier>> = std::sync::LazyLock::new(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::new(rustls::crypto::ring::default_provider()))
            .build()
            .expect("корневые сертификаты")
    });
    V.clone()
}

/// Настройки TLS для соединений самого приложения (трансляция, обновления) с точкой входа.
pub fn client_config(t: &Trust) -> Result<ClientConfig, String> {
    let b = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    Ok(match t {
        Trust::Pins(p) => b.dangerous().with_custom_certificate_verifier(Arc::new(Pinned(p.clone()))).with_no_client_auth(),
        Trust::WebPki => b.with_webpki_verifier(webpki()).with_no_client_auth(),
    })
}

/// Запоминает сертификат сервера; для публичных точек входа — ещё и проверяет его обычным образом.
#[derive(Debug)]
struct Capture {
    cert: Mutex<Option<Vec<u8>>>,
    inner: Option<Arc<rustls::client::WebPkiServerVerifier>>,
    rejected: std::sync::atomic::AtomicBool,
}

impl ServerCertVerifier for Capture {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        inter: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.cert.lock().unwrap() = Some(end.as_ref().to_vec());
        match &self.inner {
            Some(v) => v.verify_server_cert(end, inter, name, ocsp, now).inspect_err(|_| self.rejected.store(true, std::sync::atomic::Ordering::SeqCst)),
            None => Ok(ServerCertVerified::assertion()),
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

/// DER: (тег, начало содержимого, длина содержимого) элемента по смещению `at`.
fn tlv(d: &[u8], at: usize) -> Option<(u8, usize, usize)> {
    let tag = *d.get(at)?;
    let first = *d.get(at + 1)? as usize;
    let (len, hdr) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut l = 0usize;
        for i in 0..n {
            l = (l << 8) | *d.get(at + 2 + i)? as usize;
        }
        (l, 2 + n)
    };
    let start = at + hdr;
    (start + len <= d.len()).then_some((tag, start, len))
}

/// SubjectPublicKeyInfo из сертификата X.509 (DER целиком, с заголовком).
pub fn spki_der(cert: &[u8]) -> Option<&[u8]> {
    let (_, c, _) = tlv(cert, 0)?; // Certificate SEQUENCE
    let (_, tbs, tbs_len) = tlv(cert, c)?; // TBSCertificate SEQUENCE
    let end = tbs + tbs_len;
    let mut at = tbs;
    // [0] version (необязателен), serial, signature, issuer, validity, subject, затем SPKI
    if cert.get(at) == Some(&0xa0) {
        let (_, s, l) = tlv(cert, at)?;
        at = s + l;
    }
    for _ in 0..5 {
        let (_, s, l) = tlv(cert, at)?;
        at = s + l;
    }
    let (tag, s, l) = tlv(cert, at)?;
    (tag == 0x30 && s + l <= end).then(|| &cert[at..s + l])
}

/// Итог проверки точки входа: ключ, доверие, это ли Relay (через edge — значит, и основной узел за ним жив), время.
pub struct Probe {
    pub spki: String,
    pub trusted: bool,
    pub relay: bool,
    pub ms: u32,
}

/// Подключиться к https://host:port, снять сертификат и проверить, что это Relay (/api/me → JSON с error).
pub fn probe(origin: &str, trust: &Trust) -> Result<Probe, String> {
    let t0 = std::time::Instant::now();
    let rest = origin.strip_prefix("https://").ok_or("Адрес должен начинаться с https://")?;
    let hostport = rest.split('/').next().unwrap_or(rest);
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => {
            (h.trim_start_matches('[').trim_end_matches(']').to_string(), p.parse::<u16>().map_err(|_| "Неверный порт")?)
        }
        _ => (hostport.to_string(), 443),
    };
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| format!("Адрес не найден: {e}"))?.next().ok_or("Адрес не найден")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("Сервер недоступен: {e}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let capture = Arc::new(Capture { cert: Mutex::new(None), inner: matches!(trust, Trust::WebPki).then(webpki), rejected: Default::default() });
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(capture.clone())
        .with_no_client_auth();
    let name = ServerName::try_from(host.clone()).map_err(|_| "Неверное имя сервера")?;
    let conn = ClientConnection::new(Arc::new(cfg), name).map_err(|e| e.to_string())?;
    let mut tls = StreamOwned::new(conn, tcp);
    let req = format!("GET /api/me HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\nUser-Agent: RelayDesktop\r\n\r\n");
    let sent = tls.write_all(req.as_bytes());
    let mut buf = Vec::new();
    if sent.is_ok() {
        let _ = tls.take(64 * 1024).read_to_end(&mut buf);
    }
    let cert = capture.cert.lock().unwrap().clone().ok_or("Сервер не прислал сертификат")?;
    let rejected = capture.rejected.load(std::sync::atomic::Ordering::SeqCst);
    if !rejected {
        sent.map_err(|e| format!("TLS: {e}"))?;
    }
    let spki = spki_der(&cert).ok_or("Не удалось разобрать сертификат")?;
    let hash = Sha256::digest(spki);
    let text = String::from_utf8_lossy(&buf);
    let spki = STANDARD.encode(hash);
    let trusted = match trust {
        Trust::Pins(p) => p.contains(&spki),
        Trust::WebPki => !rejected,
    };
    Ok(Probe {
        trusted,
        // /api/me без входа: Relay отвечает 401 с JSON {error}. Через edge при недоступном основном узле — 502.
        relay: trusted && text.starts_with("HTTP/1.1 401") && text.contains("\"error\""),
        spki,
        ms: t0.elapsed().as_millis().min(u32::MAX as u128) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn der_lengths() {
        assert_eq!(tlv(&[0x30, 0x03, 1, 2, 3], 0), Some((0x30, 2, 3)));
        assert_eq!(tlv(&[0x30, 0x81, 0x02, 1, 2], 0), Some((0x30, 3, 2)));
        assert_eq!(tlv(&[0x30, 0x05, 1], 0), None);
    }
}

/// Проверка сертификата по закреплённым ключам (для соединений самого приложения, например трансляции).
#[derive(Debug)]
pub struct Pinned(pub Vec<String>);

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let pin = spki_der(end.as_ref()).map(|s| STANDARD.encode(Sha256::digest(s)));
        match pin {
            Some(p) if self.0.contains(&p) => Ok(ServerCertVerified::assertion()),
            _ => Err(rustls::Error::General("ключ сервера не совпал с закреплённым".into())),
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

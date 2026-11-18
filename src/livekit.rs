//! Интеграция с LiveKit (SFU): токены комнат, проверка вебхуков, отключение участников.
//! Комната = голосовой канал (`ch-<id>`), identity участника = id пользователя.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Токен живёт недолго: LiveKit сам продлевает его подключённым участникам,
/// а утёкший или выданный до кика токен быстро становится бесполезным.
const TOKEN_TTL_SECS: u64 = 10 * 60;

pub struct LiveKit {
    /// Внутренний адрес для серверных вызовов (http://livekit:7880).
    pub internal_url: String,
    /// Адрес для клиентов; пусто — клиент подключается к тому же origin (через edge).
    pub public_url: String,
    key: String,
    secret: String,
    http: reqwest::Client,
}

pub fn room_name(channel: i64) -> String {
    format!("ch-{channel}")
}

/// Участник «поток экрана» пользователя: нативная демонстрация из Relay Desktop публикуется отдельным
/// подключением с этой identity (только экран и его звук, без подписок).
pub fn screen_identity(user: i64) -> String {
    format!("{user}~screen")
}

pub fn parse_room(name: &str) -> Option<i64> {
    name.strip_prefix("ch-")?.parse().ok()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

impl LiveKit {
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("LIVEKIT_API_KEY").ok().filter(|s| !s.is_empty())?;
        let secret = std::env::var("LIVEKIT_API_SECRET").ok().filter(|s| s.len() >= 32)?;
        Some(Self {
            internal_url: std::env::var("LIVEKIT_URL").unwrap_or_else(|_| "http://livekit:7880".into()),
            public_url: std::env::var("LIVEKIT_PUBLIC_URL").unwrap_or_default(),
            key,
            secret,
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().expect("http client"),
        })
    }

    fn sign(&self, claims: &Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes()).expect("hmac key");
        mac.update(format!("{header}.{payload}").as_bytes());
        let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{header}.{payload}.{sig}")
    }

    /// Токен на вход в комнату. `sources` — что можно публиковать: microphone, camera, screen_share, screen_share_audio.
    /// `session` — сеанс Relay, получивший токен (метаданные участника; завершённый сеанс не пускается, см. вебхук).
    pub fn join_token(&self, user: i64, name: &str, channel: i64, sources: &[&str], session: i64) -> String {
        let now = now_secs();
        self.sign(&json!({
            "iss": self.key, "sub": user.to_string(), "name": name, "metadata": token_meta(session), "nbf": now - 10, "exp": now + TOKEN_TTL_SECS,
            "video": {
                "room": room_name(channel), "roomJoin": true, "canSubscribe": true, "canPublish": !sources.is_empty(),
                "canPublishData": false, "canPublishSources": sources,
            },
        }))
    }

    /// Токен потока экрана: публикует только экран и его звук, ни на кого не подписывается.
    pub fn screen_token(&self, user: i64, name: &str, channel: i64, session: i64) -> String {
        let now = now_secs();
        self.sign(&json!({
            "iss": self.key, "sub": screen_identity(user), "name": format!("{name} — экран"), "metadata": token_meta(session), "nbf": now - 10, "exp": now + TOKEN_TTL_SECS,
            "video": {
                "room": room_name(channel), "roomJoin": true, "canSubscribe": false, "canPublish": true,
                "canPublishData": false, "canPublishSources": ["screen_share", "screen_share_audio"], "hidden": false,
            },
        }))
    }

    fn admin_token(&self, room: &str) -> String {
        let now = now_secs();
        self.sign(&json!({ "iss": self.key, "nbf": now - 10, "exp": now + 60, "video": { "room": room, "roomAdmin": true } }))
    }

    /// Выкинуть участника из комнаты (кик, потеря доступа). Ошибки только логируем:
    /// если участника уже нет — это нормально.
    /// Выкинуть пользователя из комнаты — вместе с его потоком экрана.
    pub async fn remove_participant(&self, channel: i64, user: i64) {
        self.remove_identity(channel, &user.to_string()).await;
        self.remove_identity(channel, &screen_identity(user)).await;
    }

    pub async fn remove_identity(&self, channel: i64, user: &str) {
        let room = room_name(channel);
        println!("livekit: RemoveParticipant {room} user={user}");
        let res = self
            .http
            .post(format!("{}/twirp/livekit.RoomService/RemoveParticipant", self.internal_url))
            .bearer_auth(self.admin_token(&room))
            .json(&json!({ "room": room, "identity": user }))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND => {}
            Ok(r) => eprintln!("livekit remove_participant {room}/{user}: HTTP {}", r.status()),
            Err(e) => eprintln!("livekit remove_participant {room}/{user}: {e}"),
        }
    }

    /// Что участнику можно публиковать (UpdateParticipant). Запрещённые уже опубликованные треки LiveKit снимает.
    pub async fn set_can_publish(&self, channel: i64, user: i64, sources: &[&str]) {
        let room = room_name(channel);
        let can_speak = !sources.is_empty();
        let sources: Vec<String> = sources.iter().map(|s| s.to_uppercase()).collect();
        let res = self
            .http
            .post(format!("{}/twirp/livekit.RoomService/UpdateParticipant", self.internal_url))
            .bearer_auth(self.admin_token(&room))
            .json(&json!({
                "room": room, "identity": user.to_string(),
                "permission": { "canSubscribe": true, "canPublish": can_speak, "canPublishData": false, "canPublishSources": sources },
            }))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND => {}
            Ok(r) => eprintln!("livekit update_participant {room}/{user}: HTTP {}", r.status()),
            Err(e) => eprintln!("livekit update_participant {room}/{user}: {e}"),
        }
    }

    /// Проверка вебхука: заголовок Authorization — JWT, подписанный нашим секретом,
    /// с claim `sha256` = base64(sha256(тело)).
    pub fn verify_webhook(&self, auth: &str, body: &[u8]) -> bool {
        let token = auth.strip_prefix("Bearer ").unwrap_or(auth).trim();
        let mut parts = token.split('.');
        let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return false };
        let Ok(sig) = URL_SAFE_NO_PAD.decode(s) else { return false };
        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes()).expect("hmac key");
        mac.update(format!("{h}.{p}").as_bytes());
        if mac.verify_slice(&sig).is_err() {
            return false;
        }
        let Some(header) = URL_SAFE_NO_PAD.decode(h).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return false };
        if header["alg"] != "HS256" {
            return false;
        }
        let Some(claims) = URL_SAFE_NO_PAD.decode(p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return false };
        let now = now_secs();
        let exp_ok = claims["exp"].as_u64().is_none_or(|e| e + 30 >= now);
        let nbf_ok = claims["nbf"].as_u64().is_none_or(|n| n <= now + 30);
        let body_hash = STANDARD.encode(Sha256::digest(body));
        claims["iss"] == self.key.as_str() && exp_ok && nbf_ok && claims["sha256"] == body_hash.as_str()
    }

    /// Для тестов: подписать тело вебхука так же, как это делает LiveKit.
    #[cfg(test)]
    pub fn sign_webhook(&self, body: &[u8]) -> String {
        let now = now_secs();
        self.sign(&json!({ "iss": self.key, "nbf": now, "exp": now + 300, "sha256": STANDARD.encode(Sha256::digest(body)) }))
    }
}

/// Метаданные участника LiveKit: номер сеанса Relay, выдавшего токен.
fn token_meta(session: i64) -> String {
    json!({ "s": session }).to_string()
}
/// Номер сеанса из метаданных участника (0 — нет: токен выдан до учёта сеансов).
pub fn token_session(meta: &str) -> i64 {
    serde_json::from_str::<Value>(meta).ok().and_then(|v| v["s"].as_i64()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lk() -> LiveKit {
        LiveKit {
            internal_url: String::new(),
            public_url: String::new(),
            key: "APIkey".into(),
            secret: "0123456789abcdef0123456789abcdef".into(),
            http: reqwest::Client::new(),
        }
    }

    #[test]
    fn webhook_signature() {
        let l = lk();
        let body = br#"{"event":"participant_joined"}"#;
        let auth = l.sign_webhook(body);
        assert!(l.verify_webhook(&auth, body));
        assert!(!l.verify_webhook(&auth, br#"{"event":"participant_left"}"#), "подмена тела");
        let mut other = lk();
        other.secret = "ffffffffffffffffffffffffffffffff".into();
        assert!(!other.verify_webhook(&auth, body), "чужой секрет");
        other = lk();
        other.key = "Other".into();
        assert!(!other.verify_webhook(&auth, body), "чужой ключ");
        assert!(!l.verify_webhook("garbage", body));
        assert!(!l.verify_webhook("a.b.c.d", body));
    }

    #[test]
    fn join_token_claims() {
        let t = lk().join_token(42, "Иван", 7, &[], 5);
        let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(t.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["sub"], "42");
        assert_eq!(claims["video"]["room"], "ch-7");
        assert_eq!(claims["video"]["canPublish"], false);
        // номер сеанса Relay — в метаданных участника (вебхук не пускает завершённый сеанс)
        assert_eq!(token_session(claims["metadata"].as_str().unwrap()), 5);
        assert_eq!(token_session(""), 0, "токен до учёта сеансов");
        assert_eq!(token_session("мусор"), 0);
        assert_eq!(claims["video"]["canPublishSources"], json!([]));
        assert!(claims["exp"].as_u64().unwrap() - claims["nbf"].as_u64().unwrap() <= TOKEN_TTL_SECS + 10);
    }

    #[test]
    fn rooms() {
        assert_eq!(parse_room(&room_name(15)), Some(15));
        assert_eq!(parse_room("other"), None);
        assert_eq!(parse_room("ch-x"), None);
    }
}

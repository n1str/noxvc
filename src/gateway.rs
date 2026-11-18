//! Gateway: realtime-канал сервер → клиент (протокол по образцу Discord).
//!
//! 1. Сервер: HELLO {op:10, d:{heartbeat_interval}}.
//! 2. Клиент: IDENTIFY {op:2, d:{token}}  → сервер: DISPATCH READY (снимок состояния + session_id)
//!    или RESUME {op:6, d:{token, session_id, seq}} → сервер дошлёт пропущенные события и RESUMED;
//!    если сессия истекла или события уже вытеснены из буфера — INVALID_SESSION {op:9} и закрытие.
//! 3. События: DISPATCH {op:0, t:"MESSAGE_CREATE", s:<номер>, d:{…}}; s растёт на 1 в пределах сессии,
//!    поэтому клиент видит пропуск и может переподключиться с RESUME.
//! 4. Клиент шлёт HEARTBEAT {op:1, d:<последний s>} каждые heartbeat_interval, сервер отвечает
//!    HEARTBEAT_ACK {op:11}. Нет heartbeat дольше 1,5 интервала — соединение считается мёртвым.
//!
//! Сессия живёт RESUME_TTL после обрыва; статус «не в сети» рассылается с задержкой PRESENCE_GRACE,
//! чтобы короткий обрыв с RESUME не мигал присутствием.
use crate::{api, AppState};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{channel, Sender};

/// Закрытие соединения: сеанс завершён или токен недействителен — клиент выходит на экран входа.
const CLOSE_AUTH: u16 = 4004;
/// Внутренний сигнал писателю соединения: закрыть с CLOSE_AUTH.
const CLOSE_REVOKED: &str = "\u{1}close-revoked";
const OP_DISPATCH: u64 = 0;
const OP_HEARTBEAT: u64 = 1;
const OP_IDENTIFY: u64 = 2;
const OP_RESUME: u64 = 6;
const OP_INVALID_SESSION: u64 = 9;
const OP_HELLO: u64 = 10;
const OP_HEARTBEAT_ACK: u64 = 11;

/// Событий на сессию, которые можно дослать при RESUME.
const BUFFER: usize = 1000;
/// Очередь отправки на соединение; переполнение = пропуск seq у клиента → он сделает RESUME.
const QUEUE: usize = 1024;
const RESUME_TTL: Duration = Duration::from_secs(120);

fn env_ms(key: &str, default: u64) -> Duration {
    Duration::from_millis(std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default))
}
fn heartbeat() -> Duration {
    env_ms("RELAY_HEARTBEAT_MS", 30_000)
}
fn presence_grace() -> Duration {
    env_ms("RELAY_PRESENCE_GRACE_MS", 15_000)
}

struct Session {
    user: i64,
    /// Сеанс Relay (sessions.id), по токену которого соединение: завершение сеанса закрывает соединение.
    auth: i64,
    seq: u64,
    buf: VecDeque<(u64, String)>,
    conn: Option<(u64, Sender<String>)>,
    detached_at: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    by_user: HashMap<i64, Vec<String>>,
    /// Кому уже разослано «в сети» (чтобы не дублировать и вовремя разослать «не в сети»).
    announced: HashSet<i64>,
    next_conn: u64,
}

#[derive(Default)]
pub struct Gateway {
    inner: Mutex<Inner>,
}

fn frame(seq: u64, t: &str, d: &str) -> String {
    format!(r#"{{"op":{OP_DISPATCH},"t":"{t}","s":{seq},"d":{d}}}"#)
}

impl Gateway {
    /// Разослать событие пользователям (во все их сессии; отключённые копят его для RESUME).
    /// `ev` — объект с полем "type" (имя события в snake_case) и данными.
    pub fn dispatch(&self, users: &[i64], ev: &Value) {
        let t: String = ev["type"].as_str().unwrap_or("UNKNOWN").to_ascii_uppercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        let mut d = ev.clone();
        if let Some(o) = d.as_object_mut() {
            o.remove("type");
        }
        let d = d.to_string();
        let mut g = self.inner.lock().unwrap();
        let Inner { sessions, by_user, .. } = &mut *g;
        for u in users {
            for sid in by_user.get(u).into_iter().flatten() {
                let Some(s) = sessions.get_mut(sid) else { continue };
                s.seq += 1;
                let f = frame(s.seq, &t, &d);
                if let Some((_, tx)) = &s.conn {
                    let _ = tx.try_send(f.clone());
                }
                s.buf.push_back((s.seq, f));
                if s.buf.len() > BUFFER {
                    s.buf.pop_front();
                }
            }
        }
    }

    pub fn online(&self, user: i64) -> bool {
        let g = self.inner.lock().unwrap();
        g.by_user.get(&user).into_iter().flatten().any(|sid| g.sessions.get(sid).is_some_and(|s| s.conn.is_some()))
    }

    /// Для метрик: (открытые соединения, сессии, пользователи с живым соединением).
    pub fn stats(&self) -> (usize, usize, usize) {
        let g = self.inner.lock().unwrap();
        let conns = g.sessions.values().filter(|s| s.conn.is_some()).count();
        let online = g.by_user.values().filter(|l| l.iter().any(|sid| g.sessions.get(sid).is_some_and(|s| s.conn.is_some()))).count();
        (conns, g.sessions.len(), online)
    }

    /// Сеанс Relay завершён: его соединения закрываются кодом 4004 (клиент выходит на экран входа),
    /// сессии gateway удаляются — RESUME невозможен.
    pub fn kick_auth(&self, auth: i64) {
        let mut g = self.inner.lock().unwrap();
        let gone: Vec<String> = g.sessions.iter().filter(|(_, s)| s.auth == auth).map(|(k, _)| k.clone()).collect();
        for sid in gone {
            if let Some(s) = g.sessions.remove(&sid) {
                if let Some((_, tx)) = &s.conn {
                    let _ = tx.try_send(CLOSE_REVOKED.to_string());
                }
                if let Some(l) = g.by_user.get_mut(&s.user) {
                    l.retain(|x| x != &sid);
                }
            }
        }
    }

    fn next_conn(g: &mut Inner) -> u64 {
        g.next_conn += 1;
        g.next_conn
    }

    /// Новая сессия; возвращает (session_id, conn_id, seq для READY, нужно ли разослать «в сети»).
    fn create(&self, user: i64, auth: i64, tx: Sender<String>) -> (String, u64, u64, bool) {
        let sid = random_id();
        let mut g = self.inner.lock().unwrap();
        let conn = Self::next_conn(&mut g);
        g.sessions.insert(sid.clone(), Session { user, auth, seq: 1, buf: VecDeque::new(), conn: Some((conn, tx)), detached_at: None });
        g.by_user.entry(user).or_default().push(sid.clone());
        let announce = g.announced.insert(user);
        (sid, conn, 1, announce)
    }

    /// RESUME: подключить соединение к существующей сессии и вернуть пропущенные кадры.
    fn resume(&self, user: i64, auth: i64, sid: &str, seq: u64, tx: Sender<String>) -> Option<(u64, Vec<String>, bool)> {
        let mut g = self.inner.lock().unwrap();
        let conn = Self::next_conn(&mut g);
        let s = g.sessions.get_mut(sid).filter(|s| s.user == user)?;
        s.auth = auth;
        if seq > s.seq {
            return None;
        }
        // Пропущенное уже вытеснено из буфера — дослать нельзя, нужен новый READY.
        if seq < s.seq && s.buf.front().is_none_or(|(first, _)| *first > seq + 1) {
            return None;
        }
        let replay: Vec<String> = s.buf.iter().filter(|(n, _)| *n > seq).map(|(_, f)| f.clone()).collect();
        s.conn = Some((conn, tx));
        s.detached_at = None;
        let announce = g.announced.insert(user);
        crate::metrics::M.gateway_reconnects.inc();
        Some((conn, replay, announce))
    }

    fn next_seq(&self, sid: &str) -> u64 {
        let mut g = self.inner.lock().unwrap();
        g.sessions
            .get_mut(sid)
            .map(|s| {
                s.seq += 1;
                s.seq
            })
            .unwrap_or(0)
    }

    /// Отключить соединение (если оно всё ещё привязано к сессии — RESUME мог уже подставить новое).
    fn detach(&self, sid: &str, conn: u64) {
        let mut g = self.inner.lock().unwrap();
        if let Some(s) = g.sessions.get_mut(sid) {
            if s.conn.as_ref().is_some_and(|(c, _)| *c == conn) {
                s.conn = None;
                s.detached_at = Some(Instant::now());
            }
        }
    }

    /// После паузы: если ни одного живого соединения не осталось — пора рассылать «не в сети».
    fn take_offline(&self, user: i64) -> bool {
        let mut g = self.inner.lock().unwrap();
        let alive = g.by_user.get(&user).into_iter().flatten().any(|sid| g.sessions.get(sid).is_some_and(|s| s.conn.is_some()));
        !alive && g.announced.remove(&user)
    }

    /// Удалить сессии, оборванные дольше RESUME_TTL.
    pub fn sweep(&self) {
        let mut g = self.inner.lock().unwrap();
        let dead: Vec<String> = g.sessions.iter().filter(|(_, s)| s.detached_at.is_some_and(|t| t.elapsed() > RESUME_TTL)).map(|(k, _)| k.clone()).collect();
        for sid in dead {
            if let Some(s) = g.sessions.remove(&sid) {
                if let Some(list) = g.by_user.get_mut(&s.user) {
                    list.retain(|x| *x != sid);
                    if list.is_empty() {
                        g.by_user.remove(&s.user);
                    }
                }
            }
        }
    }
}

fn random_id() -> String {
    const A: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    (0..32).map(|_| A[rand::random::<usize>() % A.len()] as char).collect()
}

async fn broadcast_presence(st: &AppState, uid: i64, _online: bool) {
    crate::social::broadcast_presence(st, uid).await;
}

pub async fn handler(ws: WebSocketUpgrade, headers: axum::http::HeaderMap, State(st): State<AppState>) -> Response {
    // соединение по региону точки входа — для метрик (снимается вместе с соединением)
    let conn = crate::regions::GatewayConn::new(&headers);
    ws.on_upgrade(move |s| async move {
        let _conn = conn;
        run(s, st).await
    })
}

fn text(v: Value) -> Message {
    Message::Text(v.to_string().into())
}

async fn run(socket: WebSocket, st: AppState) {
    let (mut sink, mut stream) = socket.split();
    let hb = heartbeat();
    if sink.send(text(json!({ "op": OP_HELLO, "d": { "heartbeat_interval": hb.as_millis() as u64 } }))).await.is_err() {
        return;
    }
    // Первое сообщение — IDENTIFY или RESUME, не позже чем через интервал heartbeat.
    let first = match tokio::time::timeout(hb, stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(t.as_str()).unwrap_or(Value::Null),
        _ => return,
    };
    let token = first["d"]["token"].as_str().unwrap_or("");
    let Some((uid, auth)) = api::session_by_token(&st.db, token).await else {
        // токен недействителен (сеанс завершён, выход) — клиент выходит на экран входа, а не переподключается
        let _ = sink.send(Message::Close(Some(CloseFrame { code: CLOSE_AUTH, reason: "session revoked".into() }))).await;
        return;
    };
    // Выбранный статус — в память хаба до объявления присутствия; «бездействие» сбрасывается при подключении.
    if let Ok(p) = sqlx::query_scalar::<_, String>("SELECT presence FROM users WHERE id=$1").bind(uid).fetch_one(&st.db).await {
        st.hub.set_chosen_presence(uid, &p);
        st.hub.set_afk(uid, false);
    }
    let (tx, mut rx) = channel::<String>(QUEUE);
    let gw = &st.hub.gw;
    let (sid, conn) = match first["op"].as_u64() {
        Some(OP_IDENTIFY) => {
            let (sid, conn, seq, announce) = gw.create(uid, auth, tx.clone());
            let mut ready = match crate::metrics::timed("gateway.ready_payload", api::me_payload(&st, uid)).await {
                Ok(v) => v,
                Err(_) => return,
            };
            ready["session_id"] = json!(sid);
            ready["heartbeat_interval"] = json!(hb.as_millis() as u64);
            if sink.send(Message::Text(frame(seq, "READY", &ready.to_string()).into())).await.is_err() {
                gw.detach(&sid, conn);
                return;
            }
            if announce {
                broadcast_presence(&st, uid, true).await;
            }
            (sid, conn)
        }
        Some(OP_RESUME) => {
            let sid = first["d"]["session_id"].as_str().unwrap_or("").to_string();
            let seq = first["d"]["seq"].as_u64().unwrap_or(0);
            match gw.resume(uid, auth, &sid, seq, tx.clone()) {
                Some((conn, replay, announce)) => {
                    for f in replay {
                        if sink.send(Message::Text(f.into())).await.is_err() {
                            gw.detach(&sid, conn);
                            return;
                        }
                    }
                    let s = gw.next_seq(&sid);
                    let _ = sink.send(Message::Text(frame(s, "RESUMED", "{}").into())).await;
                    if announce {
                        broadcast_presence(&st, uid, true).await;
                    }
                    (sid, conn)
                }
                None => {
                    let _ = sink.send(text(json!({ "op": OP_INVALID_SESSION, "d": false }))).await;
                    return;
                }
            }
        }
        _ => return,
    };

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if m == CLOSE_REVOKED {
                let _ = sink.send(Message::Close(Some(CloseFrame { code: CLOSE_AUTH, reason: "session revoked".into() }))).await;
                break;
            }
            if sink.send(Message::Text(m.into())).await.is_err() {
                break;
            }
        }
    });

    let grace = hb + hb / 2;
    let mut deadline = tokio::time::Instant::now() + grace;
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                    if v["op"].as_u64() == Some(OP_HEARTBEAT) {
                        deadline = tokio::time::Instant::now() + grace;
                        let _ = tx.try_send(json!({ "op": OP_HEARTBEAT_ACK }).to_string());
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = tokio::time::sleep_until(deadline) => break, // клиент перестал слать heartbeat
        }
    }
    writer.abort();
    gw.detach(&sid, conn);
    // «Не в сети» — только если за время паузы пользователь не переподключился (RESUME/новая вкладка).
    let st2 = st.clone();
    tokio::spawn(async move {
        tokio::time::sleep(presence_grace()).await;
        if st2.hub.gw.take_offline(uid) {
            // Не в сети — активность снимается (вернётся с клиента при подключении).
            st2.hub.set_activity(uid, None);
            broadcast_presence(&st2, uid, false).await;
        }
    });
}

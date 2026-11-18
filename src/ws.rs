//! Голосовые состояния (источник — вебхуки LiveKit) и рассылка событий через gateway.
use crate::{db, gateway::Gateway};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// Голосовое состояние. Кто в каком канале — только из вебхуков LiveKit (participant_joined/left);
/// клиент меняет лишь muted/deafened (отображение; звук режет сам клиент и LiveKit).
#[derive(Clone)]
struct Voice {
    guild: i64,
    channel: i64,
    muted: bool,
    deafened: bool,
    /// Сессия LiveKit (participant.sid): participant_left старой сессии не должен снимать новую.
    sid: String,
    /// Камера и демонстрация экрана (отображение; публикацию ограничивает LiveKit по правам).
    video: bool,
    screen: bool,
    /// Звук трансляции включён (отдельный трек; выключается независимо от микрофона). Показывается зрителям.
    screen_audio: bool,
    /// Сеанс Relay, с которого вошёл в голос (0 — неизвестен): завершение сеанса выкидывает из голоса.
    auth: i64,
    /// Сцена: слушатель (не может говорить) и поднятая рука (время).
    suppress: bool,
    hand: Option<i64>,
}

/// Кто получает голосовые события: участники сервера, а для звонка в ЛС — участники переписки.
async fn audience(db: &db::Db, guild: i64, channel: i64) -> Vec<i64> {
    if guild != 0 {
        return db::guild_member_ids(db, guild).await.unwrap_or_default();
    }
    sqlx::query_scalar("SELECT user_id FROM dm_members WHERE channel_id=$1").bind(channel).fetch_all(db).await.unwrap_or_default()
}

pub struct VoiceStats {
    pub participants: usize,
    pub channels: usize,
    pub streams: usize,
}

#[derive(Default)]
pub struct Hub {
    pub gw: Gateway,
    voice: Mutex<HashMap<i64, Voice>>,
    /// Выбранный статус (online/idle/dnd/invisible) и «бездействует» — по пользователю.
    presence: Mutex<HashMap<i64, (String, bool)>>,
    /// Активность «Играет в …» (только в памяти; видна, пока пользователь в сети и не невидимка).
    activity: Mutex<HashMap<i64, crate::activity::Activity>>,
}

fn voice_json(user: i64, v: &Voice) -> Value {
    json!({ "user_id": user, "guild_id": if v.guild == 0 { Value::Null } else { json!(v.guild) }, "channel_id": v.channel, "muted": v.muted, "deafened": v.deafened,
            "video": v.video, "screen": v.screen, "screen_audio": v.screen && v.screen_audio, "suppress": v.suppress, "hand": v.hand })
}

/// «Вышел»: prev_channel_id нужен клиенту, чтобы отличить выход из текущего канала
/// от запоздалого события о прошлом канале при переходе.
fn left_json(user: i64, old: &Voice) -> Value {
    json!({ "user_id": user, "guild_id": if old.guild == 0 { Value::Null } else { json!(old.guild) }, "channel_id": null, "prev_channel_id": old.channel })
}

fn voice_event(state: Value) -> Value {
    json!({ "type": "voice_state", "state": state })
}

impl Hub {
    /// Разослать событие пользователям через gateway (с номером и буфером для RESUME).
    pub fn send(&self, users: &[i64], ev: &Value) {
        self.gw.dispatch(users, ev);
    }

    /// Для метрик: участники голоса, активные каналы, демонстрации экрана.
    pub fn voice_stats(&self) -> VoiceStats {
        let v = self.voice.lock().unwrap();
        let channels: std::collections::HashSet<i64> = v.values().map(|x| x.channel).collect();
        VoiceStats { participants: v.len(), channels: channels.len(), streams: v.values().filter(|x| x.screen).count() }
    }

    /// Для метрик по регионам: кто сейчас в голосе.
    pub fn voice_users(&self) -> Vec<i64> {
        self.voice.lock().unwrap().keys().copied().collect()
    }

    pub fn online(&self, user: i64) -> bool {
        self.gw.online(user)
    }

    /// Поставить/снять активность; true — изменилась (надо разослать).
    pub fn set_activity(&self, user: i64, a: Option<crate::activity::Activity>) -> bool {
        let mut m = self.activity.lock().unwrap();
        match a {
            Some(a) => m.insert(user, a.clone()).as_ref() != Some(&a),
            None => m.remove(&user).is_some(),
        }
    }

    /// Активность, которую видят другие: только если пользователь виден «в сети».
    pub fn visible_activity(&self, user: i64) -> Option<crate::activity::Activity> {
        if self.presence(user) == "offline" {
            return None;
        }
        self.activity.lock().unwrap().get(&user).cloned()
    }

    /// Своя активность (себе показываем и при «невидимке» — но её там не бывает: сервер её не хранит).
    pub fn own_activity(&self, user: i64) -> Option<crate::activity::Activity> {
        self.activity.lock().unwrap().get(&user).cloned()
    }

    /// Пришли данные Steam по appid: обновить активности с этой игрой; вернуть, кому разослать.
    pub fn refresh_steam_activity(&self, appid: i64, name: Option<&str>, icon: Option<&str>) -> Vec<i64> {
        let mut m = self.activity.lock().unwrap();
        let mut changed = vec![];
        for (u, a) in m.iter_mut() {
            if a.steam_appid != Some(appid) {
                continue;
            }
            let before = a.clone();
            if a.game_id.starts_with("steam:") {
                if let Some(n) = name {
                    a.name = n.to_string();
                }
            }
            if let Some(i) = icon {
                a.icon_url = Some(i.to_string());
            }
            if *a != before {
                changed.push(*u);
            }
        }
        changed
    }

    /// Видимое другим присутствие: offline (нет сессий или «невидимка»), dnd, idle (выбран или бездействует), online.
    pub fn presence(&self, user: i64) -> &'static str {
        if !self.online(user) {
            return "offline";
        }
        match self.presence.lock().unwrap().get(&user) {
            Some((c, afk)) => match c.as_str() {
                "invisible" => "offline",
                "dnd" => "dnd",
                "idle" => "idle",
                _ if *afk => "idle",
                _ => "online",
            },
            None => "online",
        }
    }

    pub fn chosen_presence(&self, user: i64) -> String {
        self.presence.lock().unwrap().get(&user).map(|x| x.0.clone()).unwrap_or_else(|| "online".into())
    }

    pub fn set_chosen_presence(&self, user: i64, p: &str) {
        let mut m = self.presence.lock().unwrap();
        let e = m.entry(user).or_insert_with(|| ("online".into(), false));
        e.0 = p.to_string();
    }

    /// true — видимое присутствие изменилось.
    pub fn set_afk(&self, user: i64, afk: bool) -> bool {
        let before = self.presence(user);
        self.presence.lock().unwrap().entry(user).or_insert_with(|| ("online".into(), false)).1 = afk;
        before != self.presence(user)
    }

    pub fn voice_in_guild(&self, guild: i64) -> Vec<Value> {
        self.voice.lock().unwrap().iter().filter(|(_, v)| v.guild == guild).map(|(u, v)| voice_json(*u, v)).collect()
    }

    /// Голосовые состояния в указанных каналах (звонки в ЛС для снимка /me).
    pub fn voice_in_channels(&self, channels: &[i64]) -> Vec<Value> {
        self.voice.lock().unwrap().iter().filter(|(_, v)| channels.contains(&v.channel)).map(|(u, v)| voice_json(*u, v)).collect()
    }

    /// Слушатель ли пользователь на сцене (для прав публикации).
    pub fn voice_suppressed(&self, user: i64) -> bool {
        self.voice.lock().unwrap().get(&user).is_some_and(|v| v.suppress)
    }

    /// Сцена: сделать слушателем/выступающим и/или поднять/опустить руку. None — пользователь не в голосе.
    pub async fn voice_set_stage(&self, db: &db::Db, uid: i64, suppress: Option<bool>, hand: Option<Option<i64>>) -> Option<i64> {
        let state = {
            let mut voice = self.voice.lock().unwrap();
            voice.get_mut(&uid).map(|vs| {
                if let Some(s) = suppress {
                    vs.suppress = s;
                    if !s {
                        vs.hand = None;
                    }
                }
                if let Some(h) = hand {
                    vs.hand = h;
                }
                vs.clone()
            })
        }?;
        self.send(&audience(db, state.guild, state.channel).await, &voice_event(voice_json(uid, &state)));
        Some(state.channel)
    }

    /// Сессия LiveKit, в которой пользователь сейчас в голосе.
    pub fn voice_session(&self, user: i64) -> Option<(i64, String)> {
        self.voice.lock().unwrap().get(&user).map(|v| (v.channel, v.sid.clone()))
    }

    /// (сервер, канал), где сейчас в голосе пользователь.
    pub fn voice_of(&self, user: i64) -> Option<(i64, i64)> {
        self.voice.lock().unwrap().get(&user).map(|v| (v.guild, v.channel))
    }

    pub fn voice_users_in_guild(&self, guild: i64) -> Vec<i64> {
        self.voice.lock().unwrap().iter().filter(|(_, v)| v.guild == guild).map(|(u, _)| *u).collect()
    }

    pub fn voice_members(&self, channel: i64) -> Vec<i64> {
        self.voice.lock().unwrap().iter().filter(|(_, v)| v.channel == channel).map(|(u, _)| *u).collect()
    }

    /// Сколько человек в канале, не считая `except` (для лимита участников).
    pub fn voice_count(&self, channel: i64, except: i64) -> usize {
        self.voice.lock().unwrap().iter().filter(|(u, v)| v.channel == channel && **u != except).count()
    }

    /// mute/deafen/камера/экран от клиента (отображение): только если пользователь в голосе.
    /// Сеанс, с которого пользователь в голосе.
    pub fn voice_auth(&self, uid: i64) -> Option<i64> {
        self.voice.lock().unwrap().get(&uid).map(|v| v.auth).filter(|a| *a > 0)
    }

    pub async fn voice_set_flags(
        &self,
        db: &db::Db,
        uid: i64,
        muted: Option<bool>,
        deafened: Option<bool>,
        video: Option<bool>,
        screen: Option<bool>,
        screen_audio: Option<bool>,
    ) -> bool {
        let state = {
            let mut voice = self.voice.lock().unwrap();
            voice.get_mut(&uid).map(|vs| {
                vs.muted = muted.unwrap_or(vs.muted);
                vs.deafened = deafened.unwrap_or(vs.deafened);
                vs.video = video.unwrap_or(vs.video);
                vs.screen = screen.unwrap_or(vs.screen);
                vs.screen_audio = screen_audio.unwrap_or(vs.screen_audio);
                vs.clone()
            })
        };
        let Some(s) = state else { return false };
        self.send(&audience(db, s.guild, s.channel).await, &voice_event(voice_json(uid, &s)));
        true
    }

    /// Вебхук participant_joined. Права проверяет вызывающий (и перепроверяет после записи).
    pub async fn voice_joined(&self, db: &db::Db, uid: i64, guild: i64, channel: i64, sid: &str, suppress: bool, auth: i64) {
        let (state, moved_from) = {
            let mut voice = self.voice.lock().unwrap();
            let prev = voice.get(&uid).cloned();
            // Переподключение к тому же каналу сохраняет mute/deafen.
            let state = match &prev {
                Some(p) if p.channel == channel => Voice { sid: sid.to_string(), auth: if auth > 0 { auth } else { p.auth }, ..p.clone() },
                _ => Voice {
                    guild,
                    channel,
                    muted: false,
                    deafened: false,
                    sid: sid.to_string(),
                    video: false,
                    screen: false,
                    screen_audio: false,
                    auth,
                    suppress,
                    hand: None,
                },
            };
            voice.insert(uid, state.clone());
            (state, prev.filter(|p| p.channel != channel))
        };
        // Перешёл из голоса другого сервера — тому серверу «вышел» (своему серверу хватит нового состояния).
        if let Some(o) = moved_from.filter(|o| o.guild != guild || guild == 0) {
            self.send(&audience(db, o.guild, o.channel).await, &voice_event(left_json(uid, &o)));
        }
        self.send(&audience(db, guild, channel).await, &voice_event(voice_json(uid, &state)));
    }

    /// Вебхук participant_left. Игнорируем, если пользователь уже в другом канале
    /// (при переходе left старой комнаты может прийти после joined новой).
    /// Быстрый перезаход в ту же комнату: left старой сессии может прийти после joined новой — сверяем sid.
    pub async fn voice_left(&self, db: &db::Db, uid: i64, channel: i64, sid: &str) {
        let old = {
            let mut voice = self.voice.lock().unwrap();
            let current = voice.get(&uid).is_some_and(|v| v.channel == channel && (sid.is_empty() || v.sid.is_empty() || v.sid == sid));
            if current {
                voice.remove(&uid)
            } else {
                None
            }
        };
        if let Some(o) = old {
            let mut aud = audience(db, o.guild, o.channel).await;
            if !aud.contains(&uid) {
                aud.push(uid);
            }
            self.send(&aud, &voice_event(left_json(uid, &o)));
        }
    }

    /// Принудительно выводит из голоса всех, кто подходит под условие (кик, выход с сервера,
    /// удаление канала или сервера), и рассылает «вышел». Возвращает (пользователь, канал) —
    /// вызывающий должен выкинуть их из комнаты LiveKit.
    pub async fn evict_voice(&self, db: &db::Db, pred: impl Fn(i64, i64, i64) -> bool) -> Vec<(i64, i64)> {
        let evicted: Vec<(i64, Voice)> = {
            let mut voice = self.voice.lock().unwrap();
            let ids: Vec<i64> = voice.iter().filter(|(u, v)| pred(**u, v.guild, v.channel)).map(|(u, _)| *u).collect();
            ids.into_iter().filter_map(|u| voice.remove(&u).map(|v| (u, v))).collect()
        };
        for (uid, o) in &evicted {
            let mut aud = audience(db, o.guild, o.channel).await;
            if !aud.contains(uid) {
                aud.push(*uid);
            }
            self.send(&aud, &voice_event(left_json(*uid, o)));
        }
        evicted.into_iter().map(|(u, v)| (u, v.channel)).collect()
    }
}

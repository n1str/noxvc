//! Фоновая обработка медиа профиля (аватар, баннер): очередь + один воркер ffmpeg.
//! Вход уже проверен по содержимому (media::sniff/inspect). Здесь: поворот по EXIF, кадрирование, размеры,
//! удаление метаданных и звука (перекодирование), статичный первый кадр для анимаций. Результат — в Storage,
//! в БД — только если задание всё ещё актуально (пользователь не сменил/не убрал картинку, пока шла обработка).
use crate::{db, media, social, storage::Store, AppState};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{process::Command, sync::mpsc};

/// Размеры аватара на выходе (px): 32 — список, 48 — чат, 96 — поповер, 160/256 — профиль и HiDPI.
pub const AVATAR_SIZES: [u32; 5] = [32, 48, 96, 160, 256];
const BANNER_MAX_W: u32 = 1500;
/// Сколько секунд анимации берём: аватар — короткая петля, баннер — до лимита видео.
const AVATAR_ANIM_SEC: u32 = 10;
const BANNER_ANIM_SEC: u32 = 60;
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, Debug)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
/// Аватар и иконка сервера обрабатываются одинаково (кадр 1:1, размеры AVATAR_SIZES).
pub enum Target {
    Avatar,
    Banner,
    GuildIcon,
}

impl Target {
    pub fn label(self) -> &'static str {
        match self {
            Target::Avatar => "avatar",
            Target::Banner => "banner",
            Target::GuildIcon => "guild_icon",
        }
    }
}

pub struct Job {
    /// Пользователь: чей аватар/баннер; для иконки — кто её загрузил (ему — ошибка обработки).
    pub uid: i64,
    /// Сервер (иконка); 0 — не сервер.
    pub guild: i64,
    pub target: Target,
    /// Ключ задания: каталог результата `m/<job>/` и метка актуальности в users.avatar_job/banner_job.
    pub job: String,
    /// Ключ исходника в хранилище (ffmpeg получает локальную копию).
    pub src: String,
    pub kind: media::Kind,
    pub info: media::Info,
    pub orientation: u8,
    pub crop: Crop,
    pub animated: bool,
    pub accent: Option<String>,
}

#[derive(Clone)]
pub struct Queue {
    tx: mpsc::Sender<Job>,
}

pub fn channel() -> (Queue, mpsc::Receiver<Job>) {
    let (tx, rx) = mpsc::channel(64);
    (Queue { tx }, rx)
}

impl Queue {
    /// В очередь; полная очередь — ошибка (пусть клиент попробует позже), а не бесконечное ожидание.
    pub fn push(&self, j: Job) -> Result<(), &'static str> {
        self.tx.try_send(j).map_err(|_| "Обработка медиа перегружена — попробуйте через минуту")
    }
    /// Заданий в очереди (для метрик).
    pub fn len(&self) -> usize {
        self.tx.max_capacity() - self.tx.capacity()
    }
}

/// Анимированные аватары/баннеры включены (RELAY_ANIMATED_PROFILES=0 — выключить: берётся первый кадр).
pub fn animated_enabled() -> bool {
    std::env::var("RELAY_ANIMATED_PROFILES").map(|v| v != "0" && v != "false").unwrap_or(true)
}

/// Один воркер: задания обрабатываются по очереди, ffmpeg не съедает сервер параллельными кодированиями.
pub async fn run(st: AppState, mut rx: mpsc::Receiver<Job>) {
    while let Some(j) = rx.recv().await {
        let (uid, target, key) = (j.uid, j.target, j.job.clone());
        let res = process(&st.store, &j).await;
        let res = match res {
            Ok(v) => commit(&st, &j, v).await.map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        let t = target.label();
        crate::metrics::M.media_jobs.with_label_values(&[t, if res.is_ok() { "success" } else { "failure" }]).inc();
        if let Err(e) = res {
            eprintln!("медиа {key} ({target:?}, пользователь {uid}): {e}");
            let _ = st.store.delete_dir(&format!("m/{key}")).await;
            st.hub.send(&[uid], &json!({ "type": "media_error", "target": t, "guild_id": if j.guild > 0 { json!(j.guild) } else { Value::Null }, "error": "Не удалось обработать файл" }));
            if target == Target::GuildIcon {
                let r = sqlx::query("UPDATE guilds SET icon_job=NULL WHERE id=$1 AND icon_job=$2").bind(j.guild).bind(&key).execute(&st.db).await;
                if r.is_ok_and(|r| r.rows_affected() > 0) {
                    let _ = crate::api::guild_updated(&st, j.guild).await;
                }
            } else {
                let col = if target == Target::Avatar { "avatar_job" } else { "banner_job" };
                let _ = sqlx::query(&format!("UPDATE users SET {col}=NULL WHERE id=$1 AND {col}=$2")).bind(uid).bind(&key).execute(&st.db).await;
                if let Ok(me) = social::self_json(&st, uid).await {
                    st.hub.send(&[uid], &json!({ "type": "user_update", "user": me }));
                }
            }
        }
    }
}

/// Фильтр поворота по EXIF (JPEG); у видео ffmpeg поворачивает сам (как и браузер).
fn orient(o: u8) -> &'static str {
    match o {
        2 => "hflip,",
        3 => "hflip,vflip,",
        4 => "vflip,",
        5 => "transpose=0,",
        6 => "transpose=1,",
        7 => "transpose=3,",
        8 => "transpose=2,",
        _ => "",
    }
}

/// Кадрирование долями кадра (после поворота) — совпадает с тем, что человек видел в редакторе.
fn crop_filter(c: Crop) -> String {
    format!("crop=w='trunc(iw*{:.6})':h='trunc(ih*{:.6})':x='trunc(iw*{:.6})':y='trunc(ih*{:.6})'", c.w, c.h, c.x, c.y)
}

/// Аргументы ffmpeg для задания; результат пишется в `out`. (Отдельно от запуска — для тестов.)
pub fn ffmpeg_args(j: &Job, src: &std::path::Path, out: &std::path::Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-y",
        "-threads",
        "2",
        "-protocol_whitelist",
        "file",
        "-max_pixels",
        "16777216",
        "-f",
        j.kind.demuxer(j.info.frames),
    ]
    .into_iter()
    .map(String::from)
    .collect();
    // JPEG: ffmpeg 5.1 сам поворачивает по EXIF, но зеркальные ориентации — не всегда; отключаем и поворачиваем сами (все 8).
    // Видео — автоповорот ffmpeg (как и браузер в редакторе).
    if j.kind == media::Kind::Jpeg {
        a.push("-noautorotate".into());
    }
    a.extend(["-i".into(), src.to_string_lossy().into_owned()]);
    let pre = format!("[0:v]{}{}", orient(j.orientation), crop_filter(j.crop));
    let o = |name: &str| out.join(name).to_string_lossy().into_owned();
    let still = |a: &mut Vec<String>, label: &str, file: &str| {
        a.extend([
            "-map".into(),
            format!("[{label}]"),
            "-frames:v".into(),
            "1".into(),
            "-c:v".into(),
            "libwebp".into(),
            "-quality".into(),
            "86".into(),
            "-map_metadata".into(),
            "-1".into(),
            o(file),
        ]);
    };
    match j.target {
        Target::Avatar | Target::GuildIcon => {
            let n = AVATAR_SIZES.len() * if j.animated { 2 } else { 1 };
            let mut fc = format!("{pre},setsar=1,split={n}");
            for i in 0..n {
                fc.push_str(&format!("[s{i}]"));
            }
            for (i, s) in AVATAR_SIZES.iter().enumerate() {
                fc.push_str(&format!(";[s{i}]scale={s}:{s}:flags=lanczos[p{i}]"));
                if j.animated {
                    fc.push_str(&format!(";[s{}]scale={s}:{s}:flags=lanczos[m{i}]", i + AVATAR_SIZES.len()));
                }
            }
            a.extend(["-filter_complex".into(), fc]);
            for (i, s) in AVATAR_SIZES.iter().enumerate() {
                still(&mut a, &format!("p{i}"), &format!("a{s}.webp"));
                if j.animated {
                    a.extend([
                        "-map".into(),
                        format!("[m{i}]"),
                        "-t".into(),
                        AVATAR_ANIM_SEC.to_string(),
                        "-fpsmax".into(),
                        "25".into(),
                        "-c:v".into(),
                        "libwebp_anim".into(),
                        "-quality".into(),
                        "72".into(),
                        "-loop".into(),
                        "0".into(),
                        "-an".into(),
                        "-map_metadata".into(),
                        "-1".into(),
                        o(&format!("a{s}.anim.webp")),
                    ]);
                }
            }
        }
        Target::Banner => {
            let scale = format!("scale=w='trunc(min({BANNER_MAX_W},iw)/2)*2':h=-2:flags=lanczos");
            if j.animated {
                a.extend(["-filter_complex".into(), format!("{pre},{scale},setsar=1,split=2[p][v]")]);
                still(&mut a, "p", "b.webp");
                a.extend([
                    "-map".into(),
                    "[v]".into(),
                    "-t".into(),
                    BANNER_ANIM_SEC.to_string(),
                    "-fpsmax".into(),
                    "30".into(),
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "veryfast".into(),
                    "-crf".into(),
                    "26".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    "-an".into(),
                    "-sn".into(),
                    "-dn".into(),
                    "-map_metadata".into(),
                    "-1".into(),
                    o("b.mp4"),
                ]);
            } else {
                a.extend(["-filter_complex".into(), format!("{pre},{scale},setsar=1[p]")]);
                still(&mut a, "p", "b.webp");
            }
        }
    }
    a
}

async fn process(store: &Arc<Store>, j: &Job) -> Result<Vec<(String, Vec<u8>)>, String> {
    let tmp = std::env::temp_dir().join("relay-media").join(&j.job);
    let out_dir = tmp.join("out");
    tokio::fs::create_dir_all(&out_dir).await.map_err(|e| e.to_string())?;
    let run = async {
        let src = store.local_copy(&j.src, &tmp).await.map_err(|e| format!("исходник {}: {e}", j.src))?;
        let mut cmd = Command::new("ffmpeg");
        cmd.args(ffmpeg_args(j, &src, &out_dir)).kill_on_drop(true).stdin(std::process::Stdio::null());
        let out = tokio::time::timeout(FFMPEG_TIMEOUT, cmd.output())
            .await
            .map_err(|_| "ffmpeg: превышено время".to_string())?
            .map_err(|e| format!("ffmpeg не запустился: {e}"))?;
        if !out.status.success() {
            return Err(format!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr).lines().take(4).collect::<Vec<_>>().join(" | ")));
        }
        let mut files = Vec::new();
        let mut rd = tokio::fs::read_dir(&out_dir).await.map_err(|e| e.to_string())?;
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            let data = tokio::fs::read(e.path()).await.map_err(|e| e.to_string())?;
            if data.is_empty() {
                return Err(format!("пустой результат {name}"));
            }
            files.push((name, data));
        }
        Ok(files)
    };
    let files = run.await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    let files = files?;
    for (name, data) in &files {
        store.put(&format!("m/{}/{name}", j.job), data.clone()).await.map_err(|e| e.to_string())?;
    }
    Ok(files)
}

/// Записать результат, если задание всё ещё актуально, и разослать обновление.
async fn commit(st: &AppState, j: &Job, files: Vec<(String, Vec<u8>)>) -> Result<(), sqlx::Error> {
    let has = |n: &str| files.iter().any(|(f, _)| f == n);
    let url = |n: &str| st.store.url(&format!("m/{}/{n}", j.job));
    match j.target {
        Target::GuildIcon => {
            let anim = j.animated && AVATAR_SIZES.iter().all(|s| has(&format!("a{s}.anim.webp")));
            if !AVATAR_SIZES.iter().all(|s| has(&format!("a{s}.webp"))) {
                return Err(sqlx::Error::Protocol("нет всех размеров иконки".into()));
            }
            let r = sqlx::query("UPDATE guilds SET icon=$1, icon_anim=$2, icon_job=NULL WHERE id=$3 AND icon_job=$4")
                .bind(url("a256.webp"))
                .bind(anim)
                .bind(j.guild)
                .bind(&j.job)
                .execute(&st.db)
                .await?;
            if r.rows_affected() == 0 {
                let _ = st.store.delete_dir(&format!("m/{}", j.job)).await;
                return Ok(());
            }
            let _ = crate::api::guild_updated(st, j.guild).await;
            return Ok(());
        }
        Target::Avatar => {
            let anim = j.animated && AVATAR_SIZES.iter().all(|s| has(&format!("a{s}.anim.webp")));
            if !AVATAR_SIZES.iter().all(|s| has(&format!("a{s}.webp"))) {
                return Err(sqlx::Error::Protocol("нет всех размеров аватара".into()));
            }
            let r = sqlx::query("UPDATE users SET avatar=$1, avatar_anim=$2, avatar_job=NULL WHERE id=$3 AND avatar_job=$4")
                .bind(url("a256.webp"))
                .bind(anim)
                .bind(j.uid)
                .bind(&j.job)
                .execute(&st.db)
                .await?;
            if r.rows_affected() == 0 {
                let _ = st.store.delete_dir(&format!("m/{}", j.job)).await;
                return Ok(());
            }
            let mut user = db::user_json(&st.db, j.uid).await?;
            social::present(st, &mut user);
            let mut aud = db::related_user_ids(&st.db, j.uid).await?;
            aud.retain(|u| *u != j.uid);
            st.hub.send(&aud, &json!({ "type": "user_update", "user": user }));
        }
        Target::Banner => {
            if !has("b.webp") {
                return Err(sqlx::Error::Protocol("нет кадра баннера".into()));
            }
            let video = j.animated && has("b.mp4");
            let (w, h) = banner_dims(j);
            let banner: Value = json!({
                "url": url(if video { "b.mp4" } else { "b.webp" }), "poster": if video { Some(url("b.webp")) } else { None },
                "kind": if video { "video" } else { "image" }, "accent": j.accent,
                "crop": { "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0 }, "width": w, "height": h,
            });
            let r = sqlx::query("UPDATE users SET banner=$1, banner_job=NULL WHERE id=$2 AND banner_job=$3")
                .bind(&banner)
                .bind(j.uid)
                .bind(&j.job)
                .execute(&st.db)
                .await?;
            if r.rows_affected() == 0 {
                let _ = st.store.delete_dir(&format!("m/{}", j.job)).await;
                return Ok(());
            }
        }
    }
    if let Ok(me) = social::self_json(st, j.uid).await {
        st.hub.send(&[j.uid], &json!({ "type": "user_update", "user": me }));
    }
    Ok(())
}

/// Размер баннера на выходе (для клиента — справочно): ширина кадра ≤ 1500, чётная, высота — по пропорции.
fn banner_dims(j: &Job) -> (u32, u32) {
    let (mut w, mut h) = (j.info.width as f64, j.info.height as f64);
    if (5..=8).contains(&j.orientation) {
        std::mem::swap(&mut w, &mut h);
    }
    let (cw, ch) = (w * j.crop.w, h * j.crop.h);
    let ow = ((cw.min(BANNER_MAX_W as f64) / 2.0).floor() * 2.0).max(2.0);
    (ow as u32, ((ow * ch / cw.max(1.0)) / 2.0).round() as u32 * 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(target: Target, kind: media::Kind, frames: u32, animated: bool, orientation: u8) -> Job {
        Job {
            uid: 1,
            guild: 0,
            target,
            job: "abc".into(),
            src: "x.bin".into(),
            kind,
            info: media::Info { width: 1200, height: 800, frames, ..Default::default() },
            orientation,
            crop: Crop { x: 0.1, y: 0.2, w: 0.5, h: 0.75 },
            animated,
            accent: None,
        }
    }
    #[test]
    fn avatar_static_args() {
        let a = ffmpeg_args(&job(Target::Avatar, media::Kind::Jpeg, 1, false, 6), std::path::Path::new("/tmp/s"), std::path::Path::new("/tmp/o")).join(" ");
        assert!(a.contains("-protocol_whitelist file") && a.contains("-f jpeg_pipe -noautorotate -i") && a.contains("-max_pixels"));
        assert!(a.contains("[0:v]transpose=1,crop=w='trunc(iw*0.500000)'"), "{a}");
        for s in AVATAR_SIZES {
            assert!(a.contains(&format!("a{s}.webp")) && !a.contains(&format!("a{s}.anim.webp")));
        }
        assert!(a.contains("split=5") && a.matches("-map_metadata -1").count() == 5);
    }
    #[test]
    fn avatar_animated_args() {
        let a = ffmpeg_args(&job(Target::Avatar, media::Kind::Gif, 30, true, 1), std::path::Path::new("/tmp/s"), std::path::Path::new("/tmp/o")).join(" ");
        assert!(a.contains("-f gif") && a.contains("split=10") && a.contains("libwebp_anim"));
        for s in AVATAR_SIZES {
            assert!(a.contains(&format!("a{s}.anim.webp")));
        }
    }
    #[test]
    fn banner_video_args_strip_audio() {
        let a = ffmpeg_args(&job(Target::Banner, media::Kind::Mp4, 1, true, 1), std::path::Path::new("/tmp/s"), std::path::Path::new("/tmp/o")).join(" ");
        assert!(a.contains("-f mov") && a.contains("libx264") && a.contains(" -an ") && a.contains("b.mp4") && a.contains("b.webp"));
        assert_eq!(banner_dims(&job(Target::Banner, media::Kind::Mp4, 1, true, 1)), (600, 600));
        let s = ffmpeg_args(&job(Target::Banner, media::Kind::Png, 1, false, 1), std::path::Path::new("/tmp/s"), std::path::Path::new("/tmp/o")).join(" ");
        assert!(s.contains("-f png_pipe") && !s.contains("b.mp4"));
    }
}

//! Нативная демонстрация экрана (как в Discord): свой выбор окна или экрана с миниатюрами, захват через
//! Windows Graphics Capture, кодирование (по возможности аппаратное) и публикация в LiveKit прямо из приложения
//! отдельным участником «<id>~screen». Звук: окно — только звук его приложения; экран — всё, кроме самого Relay
//! (иначе в трансляцию попадёт голосовой чат).
//!
//! Сигнальное соединение LiveKit идёт через локальный прокси: 127.0.0.1 → TLS к серверу с проверкой
//! закреплённого ключа (своё доверие корням в SDK не подставить). Медиа — напрямую по UDP (DTLS-SRTP).

use base64::{engine::general_purpose::STANDARD, Engine};
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::{native::NativeAudioSource, AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::rtp_parameters::DegradationPreference;
use livekit::webrtc::rtp_sender::VideoEncoderBackend;
use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame, I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

// ---------- источники и миниатюры ----------
#[derive(Serialize, Clone)]
pub struct Source {
    id: String,
    kind: &'static str,
    title: String,
    app: String,
    thumb: Option<String>,
    width: u32,
    height: u32,
}

/// BGRA → уменьшенный PNG (усреднение блоков, без внешних зависимостей).
fn thumb_png(src: &[u8], w: u32, h: u32, pitch: u32, max_w: u32, max_h: u32) -> Option<Vec<u8>> {
    if w == 0 || h == 0 {
        return None;
    }
    let k = (w as f32 / max_w as f32).max(h as f32 / max_h as f32).max(1.0);
    let (tw, th) = (((w as f32 / k) as u32).max(1), ((h as f32 / k) as u32).max(1));
    let mut rgb = Vec::with_capacity((tw * th * 3) as usize);
    for ty in 0..th {
        for tx in 0..tw {
            let (x0, y0) = ((tx as f32 * k) as u32, (ty as f32 * k) as u32);
            let (x1, y1) = ((((tx + 1) as f32 * k) as u32).min(w).max(x0 + 1), (((ty + 1) as f32 * k) as u32).min(h).max(y0 + 1));
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            let step = ((x1 - x0) / 4).max(1);
            for y in (y0..y1).step_by(step as usize) {
                for x in (x0..x1).step_by(step as usize) {
                    let i = (y * pitch + x * 4) as usize;
                    if i + 2 < src.len() {
                        b += src[i] as u32;
                        g += src[i + 1] as u32;
                        r += src[i + 2] as u32;
                        n += 1;
                    }
                }
            }
            let n = n.max(1);
            rgb.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8]);
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, tw, th);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.write_header().ok()?.write_image_data(&rgb).ok()?;
    }
    Some(out)
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // монитор — только для различения вида источника
enum CaptureItem {
    Window(Window),
    Monitor(Monitor),
}
unsafe impl Send for CaptureItem {}

fn parse_source(id: &str) -> Option<CaptureItem> {
    let (k, v) = id.split_once(':')?;
    let raw = v.parse::<usize>().ok()? as *mut std::ffi::c_void;
    match k {
        "w" => Some(CaptureItem::Window(Window::from_raw_hwnd(raw))),
        "m" => Some(CaptureItem::Monitor(Monitor::from_raw_hmonitor(raw))),
        _ => None,
    }
}

/// Окна (кроме самого Relay) и экраны с миниатюрами.
pub fn sources() -> Vec<Source> {
    let own = std::process::id();
    let mut items: Vec<(Source, CaptureItem)> = vec![];
    for (i, m) in Monitor::enumerate().unwrap_or_default().into_iter().enumerate() {
        let primary = Monitor::primary().map(|p| p.as_raw_hmonitor() == m.as_raw_hmonitor()).unwrap_or(false);
        let (w, h) = (m.width().unwrap_or(0), m.height().unwrap_or(0));
        let title = format!("Экран {}{}", i + 1, if primary { " (основной)" } else { "" });
        items.push((
            Source { id: format!("m:{}", m.as_raw_hmonitor() as usize), kind: "screen", title, app: format!("{w}×{h}"), thumb: None, width: w, height: h },
            CaptureItem::Monitor(m),
        ));
    }
    for w in Window::enumerate().unwrap_or_default() {
        let Ok(title) = w.title() else { continue };
        if title.trim().is_empty() || !w.is_valid() {
            continue;
        }
        let pid = w.process_id().unwrap_or(0);
        let app = w.process_name().unwrap_or_default();
        if pid == own || app.eq_ignore_ascii_case("msedgewebview2.exe") || app.eq_ignore_ascii_case("relay-desktop.exe") {
            continue;
        }
        let (ww, hh) = (w.width().unwrap_or(0).max(0) as u32, w.height().unwrap_or(0).max(0) as u32);
        if ww < 120 || hh < 80 {
            continue;
        }
        let app = app.trim_end_matches(".exe").to_string();
        items.push((
            Source { id: format!("w:{}", w.as_raw_hwnd() as usize), kind: "window", title, app, thumb: None, width: ww, height: hh },
            CaptureItem::Window(w),
        ));
    }
    // Миниатюры — параллельно, через GDI (без сеансов захвата: на Windows 10 каждый давал бы жёлтую рамку).
    let handles: Vec<_> = items
        .into_iter()
        .map(|(mut s, _)| {
            std::thread::spawn(move || {
                s.thumb = crate::legacy::thumbnail(&s.id, 400, 225)
                    .and_then(|(v, w, h)| thumb_png(&v, w, h, w * 4, 400, 225))
                    .map(|p| format!("data:image/png;base64,{}", STANDARD.encode(p)));
                s
            })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

// ---------- захват и публикация ----------
/// Кодировщик трансляции: «auto» — видеокарта, при сбое процессор; «gpu» — видеокарта (если нельзя — процессор
/// с пояснением); «cpu» — только процессор.
#[derive(Deserialize, Clone)]
pub struct StartArgs {
    pub source: String,
    pub token: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub kbps: u32,
    pub mode: String,
    pub audio: bool,
    #[serde(default)]
    pub encoder: String,
    /// Маршрут медиа от сервера (ответ /voice/screen-token): TURN точки входа и политика.
    #[serde(default)]
    pub ice: Option<Ice>,
    /// Адрес LiveKit из ответа сервера (wss://voice.example.com). Другой хост — сигнализация идёт туда (публичный
    /// сертификат с проверкой имени); нет — через точку входа (/rtc), как раньше.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Ice {
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub servers: Vec<IceSrv>,
    #[serde(default)]
    pub policy: Option<String>,
}
#[derive(Deserialize, Clone, Debug)]
pub struct IceSrv {
    pub urls: Urls,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}
#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum Urls {
    One(String),
    Many(Vec<String>),
}
impl Urls {
    fn into_vec(self) -> Vec<String> {
        match self {
            Urls::One(u) => vec![u],
            Urls::Many(v) => v,
        }
    }
}

/// Смена качества на лету: тот же источник, новые параметры.
#[derive(Deserialize)]
pub struct UpdateArgs {
    pub token: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub kbps: u32,
    pub mode: String,
    #[serde(default)]
    pub encoder: String,
    #[serde(default)]
    pub audio: Option<bool>,
    #[serde(default)]
    pub ice: Option<Ice>,
}

struct Share {
    room: Arc<Room>,
    stop: Arc<AtomicBool>,
    pump: Option<std::thread::JoinHandle<()>>,
    stop_audio: Arc<AtomicBool>,
    /// Опубликованный звук трансляции (выключается отдельно от микрофона — mute трека, видео не трогаем).
    audio: Option<LocalTrackPublication>,
    /// Чей звук захватывать: процесс окна (include) или всё, кроме Relay.
    audio_target: (u32, bool),
    args: StartArgs,
}
static SHARE: Mutex<Option<Share>> = Mutex::new(None);

/// Что выбрал насос: аппаратный кодировщик (имя) или процессор (и почему), размер кадра трансляции.
struct PumpInfo {
    hw: Option<String>,
    note: Option<String>,
    w: u32,
    h: u32,
    fps: u32,
}

fn debug() -> bool {
    std::env::var("RELAY_DESKTOP_DEBUG").is_ok()
}

/// Журнал трансляции: %LOCALAPPDATA%\app.relay.desktop\logs\share.log (≤ 1 МБ, новый при переполнении).
/// Нужен, чтобы разбирать проблемы у пользователей по фактам: система, захват, кодировщик, ключевые кадры, битрейт.
static LOG: Mutex<Option<std::fs::File>> = Mutex::new(None);
pub fn init_log(app: &AppHandle) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("share.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("share.old.log"));
    }
    *LOG.lock().unwrap() = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
}
pub fn slog(msg: impl AsRef<str>) {
    use std::io::Write;
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (t.as_secs() % 86400, t.subsec_millis());
    let line = format!("{:02}:{:02}:{:02}.{:03} UTC  {}", secs / 3600, secs / 60 % 60, secs % 60, ms, msg.as_ref());
    if debug() {
        eprintln!("[share] {line}");
    }
    if let Some(f) = LOG.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{line}");
    }
}

fn ended_once(app: &AppHandle, ended: &AtomicBool) {
    if !ended.swap(true, Ordering::SeqCst) {
        let _ = app.emit("screen_ended", ());
    }
}

/// Поток трансляции: своё D3D11-устройство, захват, ровный темп кадров, кодирование.
/// Статичная картинка повторяется ~5 раз в секунду: новому зрителю есть что показать, ключевой кадр — по запросу.
fn pump(
    a: StartArgs,
    mut fps: u32,
    info: std::sync::mpsc::Sender<Result<PumpInfo, String>>,
    src_rx: std::sync::mpsc::Receiver<NativeVideoSource>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
) {
    use crate::gpu::*;
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
    use crate::legacy;
    enum Kind {
        Wgc(windows::Graphics::Capture::GraphicsCaptureItem),
        Dup(windows::Win32::Graphics::Dxgi::IDXGIOutput1, windows::Win32::Foundation::RECT),
        Win(windows::Win32::Foundation::HWND),
    }
    let setup = (|| -> Result<_, String> {
        let (k, raw) = a.source.split_once(':').and_then(|(k, v)| Some((k, v.parse::<usize>().ok()? as *mut std::ffi::c_void))).ok_or("Источник не найден")?;
        // Windows 11 (и 10 начиная с 20348): WGC без рамки. Раньше рамку не отключить — захват другими способами.
        if legacy::wgc_borderless() {
            let gpu = Gpu::new().map_err(|e| format!("видеокарта: {e}"))?;
            let item = capture_item(&a.source).map_err(|_| "Источник не найден (окно закрыто?)".to_string())?;
            let (iw, ih) = item_size(&item);
            Ok((gpu, Kind::Wgc(item), iw, ih, "Windows Graphics Capture"))
        } else if k == "m" {
            let (gpu, out, rect) = legacy::gpu_for_monitor(windows::Win32::Graphics::Gdi::HMONITOR(raw)).map_err(|e| format!("экран: {e}"))?;
            let (iw, ih) = (((rect.right - rect.left) as u32) & !1, ((rect.bottom - rect.top) as u32) & !1);
            Ok((gpu, Kind::Dup(out, rect), iw, ih, "Desktop Duplication"))
        } else {
            let hwnd = windows::Win32::Foundation::HWND(raw);
            let gpu = Gpu::new().map_err(|e| format!("видеокарта: {e}"))?;
            let (iw, ih) = legacy::client_size(hwnd);
            Ok((gpu, Kind::Win(hwnd), iw, ih, "PrintWindow"))
        }
    })();
    let (gpu, kind, iw, ih, method) = match setup {
        Ok(v) => v,
        Err(e) => {
            slog(format!("ошибка запуска: {e}"));
            let _ = info.send(Err(e));
            return;
        }
    };
    let (mut w, mut h) = fit(iw, ih, a.width, a.height);
    let mut hw = None;
    let mut note = None;
    if a.encoder != "cpu" {
        match crate::mfenc::Encoder::new(&gpu, w, h, fps, a.kbps)
            .and_then(|e| Converter::new(&gpu, w, h).map(|c| (e, c)).map_err(|e| format!("преобразование кадра: {e}")))
        {
            Ok(x) => hw = Some(x),
            Err(e) => note = Some(e),
        }
    }
    if hw.is_none() {
        // Процессор (OpenH264) на 1080p60 с живой картинкой сам выкидывает кадры (до 3–4 FPS у зрителя):
        // ограничиваем 720p30 — так программное кодирование остаётся плавным.
        (w, h) = fit(iw, ih, a.width.min(1280), a.height.min(720));
        fps = fps.min(30);
    }
    slog(format!(
        "захват: {method}, источник {}×{} → поток {w}×{h}@{fps}, до {} кбит/с, кодировщик: {}",
        iw,
        ih,
        a.kbps,
        hw.as_ref().map(|(e, _)| e.name.clone()).unwrap_or_else(|| format!("процессор ({})", note.clone().unwrap_or_else(|| "выбран".into())))
    ));
    let _ = info.send(Ok(PumpInfo { hw: hw.as_ref().map(|(e, _)| e.name.clone()), note, w, h, fps }));
    let Ok(src) = src_rx.recv() else { return };

    let latest: Shared = Arc::new((Mutex::new(Latest::default()), std::sync::Condvar::new()));
    let ended = Arc::new(AtomicBool::new(false));
    let on_closed = {
        let (app, ended, stop) = (app.clone(), ended.clone(), stop.clone());
        move || {
            stop.store(true, Ordering::SeqCst);
            ended_once(&app, &ended);
        }
    };
    #[allow(dead_code)] // держим ради Drop: остановка захвата
    enum Cap {
        _Wgc(Capture),
        _Legacy(legacy::Legacy),
    }
    let cap = match kind {
        Kind::Wgc(item) => Capture::start(&gpu, &item, latest.clone(), on_closed).map(Cap::_Wgc),
        Kind::Dup(out, rect) => Ok(Cap::_Legacy(legacy::start_duplication(gpu.clone(), out, rect, fps, latest.clone(), slog))),
        Kind::Win(hwnd) => Ok(Cap::_Legacy(legacy::start_window(gpu.clone(), hwnd, fps, latest.clone(), on_closed, slog))),
    };
    let cap = match cap {
        Ok(c) => c,
        Err(e) => {
            slog(format!("захват не запустился: {e}"));
            ended_once(&app, &ended);
            return;
        }
    };

    let max_bps = a.kbps * 1000;
    // Следуем оценке канала WebRTC почти до нуля: «пол» выше реальной пропускной способности
    // переполняет очередь отправки — потери, блоки и зависание у зрителя.
    let min_bps = 300_000.min(max_bps);
    // Не чаще заданного FPS (с допуском на дрожание), статичная картинка — повтор раз в 200 мс.
    let min_gap = Duration::from_secs_f64(0.9 / fps as f64);
    let idle = Duration::from_millis(200);
    let t0 = Instant::now();
    let (mut last_seq, mut last_sent) = (0u64, t0);
    let mut readback = Readback::new(&gpu);
    let mut errors = 0u32;
    let (mut n_sent, mut n_enc, mut busy, mut since) = (0u32, 0u32, Duration::ZERO, t0);
    // Сводка в журнал раз в 10 с.
    let (mut sum_at, mut sum_frames, mut sum_keyreq, mut sum_keys, mut sum_err) = (t0, 0u32, 0u32, 0u32, 0u32);
    while !stop.load(Ordering::SeqCst) {
        // Ждём новый кадр (или повод: запрос ключевого кадра, простой), просыпаясь не реже 20 мс.
        let mut l = latest.0.lock().unwrap();
        let mut key_req = false;
        while l.seq == last_seq && last_sent.elapsed() < idle && !stop.load(Ordering::SeqCst) {
            if hw.is_some() && src.take_keyframe_request() {
                key_req = true;
                break;
            }
            l = latest.1.wait_timeout(l, Duration::from_millis(20)).unwrap().0;
        }
        let gap = last_sent.elapsed();
        if gap < min_gap {
            drop(l);
            std::thread::sleep(min_gap - gap);
            l = latest.0.lock().unwrap();
        }
        if hw.is_some() && !key_req {
            key_req = src.take_keyframe_request();
        }
        let Some(tex) = l.tex.clone() else {
            drop(l);
            std::thread::sleep(Duration::from_millis(10));
            continue;
        };
        let (fw, fh, seq) = (l.w, l.h, l.seq);
        let t = Instant::now();
        // Своя монотонная шкала (мкс, > 0): по ней WebRTC выдерживает темп у зрителя.
        let ts = t0.elapsed().as_micros() as i64 + 1_000_000;
        let r: Result<(), String> = match &mut hw {
            Some((enc, conv)) => (|| {
                if key_req {
                    enc.force_key();
                    sum_keyreq += 1;
                }
                if enc.key_stuck() {
                    slog("кодировщик не выдал запрошенный ключевой кадр за 0,5 с — перезапуск кодировщика");
                    match crate::mfenc::Encoder::new(&gpu, w, h, fps, (enc.bitrate() / 1000).max(300)) {
                        Ok(n) => *enc = n,
                        Err(e) => slog(format!("перезапуск кодировщика не удался: {e}")),
                    }
                }
                if let Some(rc) = src.take_rate_control_request() {
                    enc.set_bitrate((rc.target_bitrate_bps as u32).clamp(min_bps, max_bps));
                }
                let nv12 = conv.convert(&tex, fw, fh).map_err(|e| e.to_string())?;
                drop(l);
                let (outs, _taken) = enc.encode(&nv12, ts).map_err(|e| e.to_string())?;
                for o in outs {
                    n_enc += 1;
                    if o.key {
                        sum_keys += 1;
                    }
                    src.capture_encoded_frame(&EncodedVideoFrame {
                        codec: EncodedVideoCodec::H264,
                        payload: &o.data,
                        timestamp_us: o.ts_us,
                        frame_type: if o.key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                        resolution: VideoResolution { width: w, height: h },
                        frame_metadata: None,
                    });
                }
                Ok(())
            })(),
            None => {
                let r = readback.read(&tex, fw, fh, |data, pitch| {
                    let mut i420 = I420Buffer::new(fw, fh);
                    let (sy, su, sv) = i420.strides();
                    let (dy, du, dv) = i420.data_mut();
                    yuv_helper::argb_to_i420(data, pitch, dy, sy, du, su, dv, sv, fw as i32, fh as i32);
                    let (tw, th) = fit(fw, fh, w, h);
                    let buffer = if (tw, th) != (fw, fh) { i420.scale(tw as i32, th as i32) } else { i420 };
                    src.capture_frame(&VideoFrame { rotation: VideoRotation::VideoRotation0, timestamp_us: ts, frame_metadata: None, buffer });
                });
                drop(l);
                n_enc += 1;
                r.map_err(|e| e.to_string())
            }
        };
        last_seq = seq;
        last_sent = Instant::now();
        n_sent += 1;
        busy += t.elapsed();
        match r {
            Ok(()) => errors = 0,
            Err(e) => {
                errors += 1;
                sum_err += 1;
                if errors == 1 || errors.is_multiple_of(30) {
                    slog(format!("ошибка кадра ({errors} подряд): {e}"));
                }
                if errors > 60 {
                    ended_once(&app, &ended);
                    break;
                }
            }
        }
        sum_frames += 1;
        if sum_at.elapsed() >= Duration::from_secs(10) {
            let br = hw.as_ref().map(|(e, _)| format!("{} кбит/с", e.bitrate() / 1000)).unwrap_or_else(|| "—".into());
            let lat =
                hw.as_mut().and_then(|(e, _)| e.key_latency.take()).map(|d| format!(", последний ключевой через {} мс", d.as_millis())).unwrap_or_default();
            slog(format!("10 с: кадров {sum_frames}, запросов ключевого {sum_keyreq}, ключевых {sum_keys}{lat}, битрейт {br}, ошибок {sum_err}"));
            (sum_at, sum_frames, sum_keyreq, sum_keys, sum_err) = (Instant::now(), 0, 0, 0, 0);
        }
        if debug() && since.elapsed() >= Duration::from_secs(2) {
            let s = since.elapsed().as_secs_f64();
            let br = hw.as_ref().map(|(e, _)| e.bitrate() / 1000).unwrap_or(0);
            eprintln!(
                "[share] кадров {:.1}/с, закодировано {:.1}/с, обработка {:.2} мс, битрейт кодировщика {} кбит/с",
                n_sent as f64 / s,
                n_enc as f64 / s,
                busy.as_secs_f64() * 1000.0 / n_sent.max(1) as f64,
                br
            );
            (n_sent, n_enc, busy, since) = (0, 0, Duration::ZERO, Instant::now());
        }
    }
    slog(if ended.load(Ordering::SeqCst) {
        "трансляция закончилась (источник закрыт или ошибки)"
    } else {
        "трансляция остановлена"
    });
    drop(cap); // сеанс захвата закрывается здесь — рамка/ресурсы не остаются до выхода из приложения
    drop(hw);
}

/// Локальный прокси сигнального соединения: 127.0.0.1:<порт> → TLS к текущей точке входа (закреплённый ключ или
/// публичный сертификат с проверкой имени).
async fn signal_proxy(e: &crate::endpoint::Endpoint) -> Result<u16, BoxErr> {
    let (hostport, host) = (e.hostport(), e.host());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let cfg = crate::pin::client_config(&e.trust())?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let name = rustls::pki_types::ServerName::try_from(host)?.to_owned();
    // Host запроса — имя точки входа: LiveKit-клиент ставит «127.0.0.1:<порт>», а edge-узел выбирает сайт по Host.
    let host_header = e.url.trim_start_matches("https://").to_string();
    tauri::async_runtime::spawn(async move {
        while let Ok((mut local, _)) = listener.accept().await {
            let (connector, name, hostport, host_header) = (connector.clone(), name.clone(), hostport.clone(), host_header.clone());
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let Ok(tcp) = tokio::net::TcpStream::connect(&hostport).await else { return };
                let Ok(mut tls) = connector.connect(name, tcp).await else { return };
                // заголовки первого запроса (WebSocket upgrade) — до пустой строки
                let (mut head, mut buf) = (Vec::with_capacity(2048), [0u8; 4096]);
                while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 32 * 1024 {
                    match local.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                if tls.write_all(&with_host(&head, &host_header)).await.is_err() {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut local, &mut tls).await;
            });
        }
    });
    Ok(port)
}

/// LiveKit на отдельном имени (wss://voice.example.com): точка входа для сигнализации с проверкой публичного сертификата.
/// Только wss:// и доменное имя (не IP: закреплённого ключа для него нет). Иначе — None (сигнализация через точку входа).
pub fn livekit_endpoint(url: Option<&str>) -> Option<crate::endpoint::Endpoint> {
    let host = url?.strip_prefix("wss://")?.split(['/', '?']).next()?;
    let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let ok = !name.is_empty()
        && name.contains('.')
        && name.parse::<std::net::IpAddr>().is_err()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    ok.then(|| crate::endpoint::Endpoint { id: "livekit".into(), url: format!("https://{host}"), pinned: false, fallback: false })
}

/// Заменить заголовок Host в начале HTTP-запроса (остальное — как есть, включая уже прочитанное тело).
pub fn with_host(raw: &[u8], host: &str) -> Vec<u8> {
    let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { return raw.to_vec() };
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut out = String::with_capacity(end + 64);
    for (i, line) in head.split("\r\n").enumerate() {
        if i > 0 {
            out.push_str("\r\n");
        }
        if i > 0 && line.split_once(':').is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case("host")) {
            out.push_str("Host: ");
            out.push_str(host);
        } else {
            out.push_str(line);
        }
    }
    let mut v = out.into_bytes();
    v.extend_from_slice(&raw[end..]);
    v
}

/// Начать трансляцию. Возвращает, чем кодируется поток (для интерфейса).
pub async fn start(app: AppHandle, ep: &crate::endpoint::Endpoint, a: StartArgs) -> Result<String, String> {
    stop().await;
    init_log(&app);
    let item = parse_source(&a.source).ok_or("Источник не найден")?;
    let target = livekit_endpoint(a.url.as_deref()).unwrap_or_else(|| ep.clone());
    let port = signal_proxy(&target).await.map_err(|e| format!("Соединение: {e}"))?;
    let mut ropts = RoomOptions::default();
    // Маршрут медиа точки входа: через edge-регион — TURN узла и только релей (как у голоса на странице).
    if let Some(ice) = a.ice.as_ref().filter(|i| !i.servers.is_empty()) {
        use livekit::webrtc::peer_connection_factory::{IceServer, IceTransportsType};
        ropts.rtc_config.ice_servers = ice
            .servers
            .iter()
            .map(|s| IceServer {
                urls: s.urls.clone().into_vec(),
                username: s.username.clone().unwrap_or_default(),
                password: s.credential.clone().unwrap_or_default(),
            })
            .collect();
        if ice.policy.as_deref() == Some("relay") {
            ropts.rtc_config.ice_transport_type = IceTransportsType::Relay;
        }
        slog(format!(
            "маршрут: регион {}, TURN-серверов {}, политика {}",
            ice.region.as_deref().unwrap_or("?"),
            ice.servers.len(),
            ice.policy.as_deref().unwrap_or("all")
        ));
    }
    ropts.auto_subscribe = false; // поток экрана ни на кого не подписывается
    let (room, _events) =
        Room::connect(&format!("ws://127.0.0.1:{port}"), &a.token, ropts).await.map_err(|e| format!("Не удалось подключить трансляцию: {e}"))?;
    let room = Arc::new(room);
    let fps = a.fps.clamp(5, 60);

    // Насос трансляции сам выбирает кодировщик (видеокарта/процессор) — от этого зависит, как публиковать.
    let stop = Arc::new(AtomicBool::new(false));
    let (info_tx, info_rx) = std::sync::mpsc::channel();
    let (src_tx, src_rx) = std::sync::mpsc::channel();
    let pump_handle = {
        let (a, stop, app) = (a.clone(), stop.clone(), app.clone());
        std::thread::spawn(move || pump(a, fps, info_tx, src_rx, stop, app))
    };
    let info =
        tauri::async_runtime::spawn_blocking(move || info_rx.recv()).await.map_err(|e| e.to_string())?.map_err(|_| "Трансляция не запустилась".to_string())?;
    let info = match info {
        Ok(i) => i,
        Err(e) => {
            let _ = room.close().await;
            return Err(e);
        }
    };
    let res = VideoResolution { width: info.w, height: info.h };
    let fps = info.fps;
    let (vsrc, opts, label) = if let Some(name) = &info.hw {
        // Видеокарта: готовый H.264 уходит в WebRTC как есть (один слой, битрейт подстраивается под канал).
        let opts = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            video_encoding: Some(VideoEncoding { max_bitrate: a.kbps as u64 * 1000, max_framerate: fps as f64 }),
            simulcast: false,
            degradation_preference: Some(DegradationPreference::MaintainResolution),
            video_encoder: VideoEncoderBackend::PreEncoded,
            ..Default::default()
        };
        (NativeVideoSource::new_encoded(res), opts, format!("Видеокарта · {name}"))
    } else {
        // Процессор (OpenH264): один слой до 720p30 (второй слой удвоил бы нагрузку).
        let opts = TrackPublishOptions {
            source: TrackSource::Screenshare,
            video_codec: VideoCodec::H264,
            video_encoding: Some(VideoEncoding { max_bitrate: a.kbps as u64 * 1000, max_framerate: fps as f64 }),
            simulcast: false,
            degradation_preference: Some(match a.mode.as_str() {
                "motion" => DegradationPreference::MaintainFramerate, // «плавность»: держим FPS, при нехватке снижаем разрешение
                "detail" => DegradationPreference::MaintainResolution, // «чёткость»: держим разрешение, снижаем FPS
                _ => DegradationPreference::Balanced,
            }),
            video_encoder: VideoEncoderBackend::Software,
            ..Default::default()
        };
        let label = match &info.note {
            Some(n) => format!("Процессор · видеокарта недоступна: {n}"),
            None => "Процессор · OpenH264 (до 720p30)".to_string(),
        };
        (NativeVideoSource::new(res, true), opts, label)
    };
    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(vsrc.clone()));
    if let Err(e) = room.local_participant().publish_track(LocalTrack::Video(track.clone()), opts).await {
        stop.store(true, Ordering::SeqCst);
        drop(src_tx);
        let _ = room.close().await;
        return Err(format!("Публикация видео: {e}"));
    }
    let _ = src_tx.send(vsrc);
    if debug() {
        eprintln!("[share] кодировщик: {label}");
        // Диагностика: что реально уходит по каждому слою.
        let alive = Arc::downgrade(&room);
        tokio::spawn(async move {
            while alive.upgrade().is_some() {
                tokio::time::sleep(Duration::from_secs(2)).await;
                for st in track.get_stats().await.unwrap_or_default() {
                    if let livekit::webrtc::stats::RtcStats::OutboundRtp(o) = st {
                        let x = &o.outbound;
                        eprintln!(
                            "[share] слой {:?} {}x{} {:.0}fps кадров {} байт {} цель {:.0} кбит/с энкодер {:?} огр={:?}",
                            x.rid,
                            x.frame_width,
                            x.frame_height,
                            x.frames_per_second,
                            x.frames_encoded,
                            o.sent.bytes_sent,
                            x.target_bitrate / 1000.0,
                            x.encoder_implementation,
                            x.quality_limitation_reason
                        );
                    }
                }
            }
        });
    }

    // Звук трансляции: окно — звук его процесса; экран — всё, кроме Relay (и его WebView2).
    // До Windows 10 20348 исключение процессов из захвата звука ненадёжно: в трансляцию попадали голоса
    // из Relay и собеседники слышали себя. Там звук трансляции не захватываем — лучше без звука, чем с эхом.
    let stop_audio = Arc::new(AtomicBool::new(false));
    let audio_ok = crate::legacy::process_loopback_ok();
    let label = if a.audio && !audio_ok { format!("{label} · без звука трансляции (нужна Windows 11)") } else { label };
    slog(format!(
        "старт: Windows сборка {}, {label}, звук: {}",
        crate::legacy::os_build(),
        if !a.audio {
            "выключен"
        } else if audio_ok {
            "включён"
        } else {
            "недоступен на этой Windows"
        }
    ));
    let audio_target = match item {
        CaptureItem::Window(w) => (w.process_id().unwrap_or(0), true),
        CaptureItem::Monitor(_) => (std::process::id(), false),
    };
    let audio = if a.audio && audio_ok { publish_audio(&room, audio_target, stop_audio.clone()).await } else { None };
    *SHARE.lock().unwrap() = Some(Share { room, stop, pump: Some(pump_handle), stop_audio, audio, audio_target, args: a });
    Ok(label)
}

/// Опубликовать звук трансляции и запустить его захват (WASAPI process loopback).
async fn publish_audio(room: &Arc<Room>, (pid, include): (u32, bool), stop: Arc<AtomicBool>) -> Option<LocalTrackPublication> {
    let asrc = NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, 48_000, 2, 100);
    let atrack = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(asrc.clone()));
    let aopts = TrackPublishOptions { source: TrackSource::ScreenshareAudio, dtx: false, red: false, ..Default::default() };
    match room.local_participant().publish_track(LocalTrack::Audio(atrack), aopts).await {
        Ok(p) => {
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || {
                if let Err(e) = audio_loop(asrc, pid, include, stop, rt) {
                    slog(format!("звук трансляции: {e}"));
                }
            });
            Some(p)
        }
        Err(e) => {
            slog(format!("звук трансляции не опубликован: {e}"));
            None
        }
    }
}

/// Звук трансляции: `on` = None — только узнать. Ответ: Some(включён) или None — недоступен (Windows до 20348:
/// исключить голоса Relay из захвата нельзя, звук трансляции не захватываем). Зрители видят mute трека.
pub async fn set_audio(on: Option<bool>) -> Result<Option<bool>, String> {
    if !crate::legacy::process_loopback_ok() {
        return Ok(None);
    }
    let (room, publication, target, stop) = {
        let g = SHARE.lock().unwrap();
        let s = g.as_ref().ok_or("Трансляция не идёт")?;
        (s.room.clone(), s.audio.clone(), s.audio_target, s.stop_audio.clone())
    };
    let state = match (on, publication) {
        (None, p) => p.is_some_and(|p| !p.is_muted()),
        (Some(true), Some(p)) => {
            p.unmute();
            true
        }
        (Some(false), Some(p)) => {
            p.mute();
            false
        }
        (Some(false), None) => false,
        (Some(true), None) => {
            let p = publish_audio(&room, target, stop).await.ok_or("Не удалось включить звук трансляции")?;
            if let Some(s) = SHARE.lock().unwrap().as_mut() {
                s.audio = Some(p);
            }
            true
        }
    };
    if let Some(s) = SHARE.lock().unwrap().as_mut() {
        s.args.audio = state;
    } // смена качества сохраняет выбор
    slog(format!("звук трансляции: {}", if state { "включён" } else { "выключен" }));
    Ok(Some(state))
}

pub async fn stop() {
    let s = SHARE.lock().unwrap().take();
    if let Some(mut s) = s {
        s.stop_audio.store(true, Ordering::SeqCst);
        s.stop.store(true, Ordering::SeqCst);
        if let Some(h) = s.pump.take() {
            let _ = tauri::async_runtime::spawn_blocking(move || h.join()).await;
        }
        let _ = s.room.close().await;
        slog("комната трансляции закрыта");
    }
}

/// Сменить качество: тот же источник, новая публикация (без повторного выбора окна).
pub async fn update(app: AppHandle, ep: &crate::endpoint::Endpoint, u: UpdateArgs) -> Result<String, String> {
    let prev = SHARE.lock().unwrap().as_ref().map(|s| s.args.clone()).ok_or("Трансляция не идёт")?;
    let encoder = if u.encoder.is_empty() { prev.encoder.clone() } else { u.encoder };
    let audio = u.audio.unwrap_or(prev.audio);
    let ice = u.ice.or(prev.ice.clone());
    start(app, ep, StartArgs { width: u.width, height: u.height, fps: u.fps, kbps: u.kbps, mode: u.mode, token: u.token, encoder, audio, ice, ..prev }).await
}

fn audio_loop(src: NativeAudioSource, pid: u32, include: bool, stop: Arc<AtomicBool>, rt: tokio::runtime::Handle) -> Result<(), BoxErr> {
    use wasapi::*;
    let _ = initialize_mta();
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
    let mut client = AudioClient::new_application_loopback_client(pid, include)?;
    client.initialize_client(&fmt, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;
    const FRAME: usize = 480; // 10 мс при 48 кГц
    let bytes = FRAME * 2 * 4;
    let mut q: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::SeqCst) {
        if capture.get_next_packet_size()?.unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut q)?;
        }
        while q.len() >= bytes {
            let chunk: Vec<u8> = q.drain(..bytes).collect();
            let data: Vec<i16> =
                chunk.as_chunks::<4>().0.iter().map(|b| (f32::from_le_bytes([b[0], b[1], b[2], b[3]]).clamp(-1.0, 1.0) * 32767.0) as i16).collect();
            let frame = AudioFrame { data: data.into(), sample_rate: 48_000, num_channels: 2, samples_per_channel: FRAME as u32 };
            let _ = rt.block_on(src.capture_frame(&frame));
        }
        let _ = event.wait_for_event(200); // тишина — событий нет, просто ждём дальше
    }
    let _ = client.stop_stream();
    Ok(())
}

#[cfg(test)]
mod host_tests {
    #[test]
    fn host_is_replaced() {
        let r = super::with_host(b"GET /rtc?x=1 HTTP/1.1\r\nhost: 127.0.0.1:5555\r\nUpgrade: websocket\r\n\r\nrest", "eu.example.com");
        assert_eq!(String::from_utf8(r).unwrap(), "GET /rtc?x=1 HTTP/1.1\r\nHost: eu.example.com\r\nUpgrade: websocket\r\n\r\nrest");
        assert_eq!(super::with_host(b"partial", "h"), b"partial");
        // адрес LiveKit: домен — своя точка входа (публичный сертификат), IP/пусто/ws — через точку входа приложения
        let e = super::livekit_endpoint(Some("wss://voice.example.com")).unwrap();
        assert_eq!((e.url.as_str(), e.pinned, e.hostport().as_str()), ("https://voice.example.com", false, "voice.example.com:443"));
        assert_eq!(super::livekit_endpoint(Some("wss://voice.example.com:7443/x")).unwrap().hostport(), "voice.example.com:7443");
        for bad in [None, Some(""), Some("wss://203.0.113.10:8443"), Some("ws://voice.example.com"), Some("wss://localhost"), Some("wss://a b.ru")] {
            assert!(super::livekit_endpoint(bad).is_none(), "{bad:?}");
        }
    }
}

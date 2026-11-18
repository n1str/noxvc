//! Захват без жёлтой рамки там, где Windows Graphics Capture её не отключает (Windows 10 до сборки 20348):
//! - экран — DXGI Desktop Duplication: кадры остаются на видеокарте, путь кодирования тот же;
//! - окно — PrintWindow (GDI, PW_RENDERFULLCONTENT): работает и для окон с аппаратным ускорением,
//!   окно может быть перекрыто другими — в трансляцию попадает только оно.
//!
//! Миниатюры для выбора источника — тоже GDI: без сеансов захвата (и без рамки) на любой Windows.

use crate::gpu::{Gpu, Latest, Shared, WinResult};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS, PW_CLIENTONLY};
use windows::Win32::UI::WindowsAndMessaging::*;

const PW_RENDERFULLCONTENT: u32 = 2;

/// Сборка Windows (RtlGetVersion — без «совместимых» подмен версии).
pub fn os_build() -> u32 {
    let mut v = windows::Win32::System::SystemInformation::OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<windows::Win32::System::SystemInformation::OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    unsafe {
        let _ = windows::Wdk::System::SystemServices::RtlGetVersion(&mut v);
    }
    v.dwBuildNumber
}

/// Тестовый режим «как на Windows 10» на любой системе.
fn forced() -> bool {
    std::env::var_os("RELAY_SHARE_LEGACY").is_some()
}

/// Умеет ли WGC захватывать без рамки (свойство IsBorderRequired, Windows 10 20348+ / Windows 11).
pub fn wgc_borderless() -> bool {
    !forced()
        && windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IsBorderRequired"),
        )
        .unwrap_or(false)
}

/// Захват звука «всё, кроме Relay» / «только это приложение» (process loopback) — официально с 20348.
/// На более старых сборках Windows может молча отдать весь звук — вместе с голосами из Relay (эхо).
pub fn process_loopback_ok() -> bool {
    !forced() && os_build() >= 20348
}

/// Устройство на той видеокарте, к которой подключён монитор (так требует Desktop Duplication).
pub fn gpu_for_monitor(hmon: HMONITOR) -> WinResult<(Gpu, IDXGIOutput1, RECT)> {
    unsafe {
        let f: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut i = 0;
        while let Ok(a) = f.EnumAdapters1(i) {
            let mut j = 0;
            while let Ok(o) = a.EnumOutputs(j) {
                let d = o.GetDesc()?;
                if d.Monitor == hmon {
                    return Ok((Gpu::on_adapter(&a)?, o.cast()?, d.DesktopCoordinates));
                }
                j += 1;
            }
            i += 1;
        }
    }
    Err(windows::core::Error::empty())
}

pub fn client_size(hwnd: HWND) -> (u32, u32) {
    let mut r = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut r);
    }
    (((r.right - r.left).max(2) as u32) & !1, ((r.bottom - r.top).max(2) as u32) & !1)
}

/// Курсор поверх кадра (Desktop Duplication и PrintWindow его не рисуют). `origin` — экранные координаты левого верхнего угла кадра.
unsafe fn draw_cursor(dc: HDC, origin: POINT, w: u32, h: u32) {
    let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if GetCursorInfo(&mut ci).is_err() || ci.flags.0 & CURSOR_SHOWING.0 == 0 {
        return;
    }
    let mut ii = ICONINFO::default();
    if GetIconInfo(ci.hCursor.into(), &mut ii).is_err() {
        return;
    }
    if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(ii.hbmMask.into());
    }
    if !ii.hbmColor.is_invalid() {
        let _ = DeleteObject(ii.hbmColor.into());
    }
    let (x, y) = (ci.ptScreenPos.x - origin.x - ii.xHotspot as i32, ci.ptScreenPos.y - origin.y - ii.yHotspot as i32);
    if x < -64 || y < -64 || x > w as i32 || y > h as i32 {
        return;
    }
    let _ = DrawIconEx(dc, x, y, ci.hCursor.into(), 0, 0, 0, None, DI_NORMAL);
}

fn gdi_texture(gpu: &Gpu, w: u32, h: u32) -> WinResult<ID3D11Texture2D> {
    texture(gpu, w, h, true)
}

fn texture(gpu: &Gpu, w: u32, h: u32, gdi: bool) -> WinResult<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: if gdi { D3D11_RESOURCE_MISC_GDI_COMPATIBLE.0 as u32 } else { 0 },
    };
    let mut t = None;
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut t))? };
    t.ok_or_else(windows::core::Error::empty)
}

/// Поток захвата; останавливается при Drop.
pub struct Legacy {
    stop: Arc<AtomicBool>,
    th: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Legacy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.th.take() {
            let _ = t.join();
        }
    }
}

fn publish(latest: &Shared, gpu: &Gpu, w: u32, h: u32, gdi: bool, fill: impl FnOnce(&ID3D11Texture2D) -> WinResult<()>) -> WinResult<()> {
    let mut l = latest.0.lock().unwrap();
    if l.tex.is_none() || l.w != w || l.h != h {
        *l = Latest { tex: Some(texture(gpu, w, h, gdi)?), w, h, seq: l.seq };
    }
    fill(l.tex.as_ref().unwrap())?;
    l.seq += 1;
    latest.1.notify_one();
    Ok(())
}

/// Экран через Desktop Duplication. Windows присылает «кадр» и на каждое движение мыши (до сотен в секунду),
/// поэтому картинка копируется в промежуточную текстуру, а насосу отдаётся не чаще `fps`.
pub fn start_duplication(gpu: Gpu, output: IDXGIOutput1, origin: RECT, fps: u32, latest: Shared, log: impl Fn(String) + Send + 'static) -> Legacy {
    let stop = Arc::new(AtomicBool::new(false));
    let st = stop.clone();
    let th = std::thread::spawn(move || {
        let origin = POINT { x: origin.left, y: origin.top };
        // Ровно до fps (с запасом 1 мс на дрожание таймера).
        let min_gap = Duration::from_secs_f64(1.0 / fps.max(1) as f64 - 0.001);
        const C: u32 = 64;
        let patch = gdi_texture(&gpu, C, C).ok();
        let mut desk: Option<(ID3D11Texture2D, u32, u32)> = None;
        let mut last_err = Instant::now() - Duration::from_secs(10);
        let mut last_pub = Instant::now() - Duration::from_secs(1);
        let mut pending = false;
        while !st.load(Ordering::SeqCst) {
            // DuplicateOutput1 с BGRA — HDR/10 бит рабочий стол Windows сама переводит в 8 бит.
            let dup = unsafe {
                match output.cast::<IDXGIOutput5>() {
                    Ok(o5) => o5.DuplicateOutput1(&gpu.device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]),
                    Err(_) => output.DuplicateOutput(&gpu.device),
                }
            };
            let dup = match dup {
                Ok(d) => d,
                Err(e) => {
                    // Экран блокировки, UAC, смена режима — ждём и пробуем снова.
                    if last_err.elapsed() > Duration::from_secs(5) {
                        log(format!("дублирование экрана недоступно: {e}"));
                        last_err = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(300));
                    continue;
                }
            };
            while !st.load(Ordering::SeqCst) {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut res = None;
                // Без ожидания внутри: AcquireNextFrame с таймаутом держит блокировку устройства,
                // и насос (преобразование + кодировщик на том же устройстве) простаивает. Ждём сами — 1 мс.
                match unsafe { dup.AcquireNextFrame(0, &mut info, &mut res) } {
                    Ok(()) => {
                        let r = (|| -> WinResult<()> {
                            // Новое изображение (не только движение мыши) — в промежуточную текстуру.
                            if info.LastPresentTime != 0 {
                                let tex: ID3D11Texture2D = res.take().ok_or_else(windows::core::Error::empty)?.cast()?;
                                let mut d = D3D11_TEXTURE2D_DESC::default();
                                unsafe { tex.GetDesc(&mut d) };
                                let (w, h) = (d.Width & !1, d.Height & !1);
                                if !matches!(&desk, Some((_, dw, dh)) if *dw == w && *dh == h) {
                                    desk = Some((texture(&gpu, w, h, false)?, w, h));
                                }
                                let bx = D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 };
                                unsafe { gpu.ctx.CopySubresourceRegion(&desk.as_ref().unwrap().0, 0, 0, 0, 0, &tex, 0, Some(&bx)) };
                            }
                            Ok(())
                        })();
                        unsafe {
                            let _ = dup.ReleaseFrame();
                        }
                        if let Err(e) = r {
                            log(format!("кадр экрана: {e}"));
                        }
                        pending = true;
                    }
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                        // Ничего нового: отдаём накопленное, если пора, иначе спим без блокировки.
                        if !(pending && last_pub.elapsed() >= min_gap) {
                            std::thread::sleep(Duration::from_millis(1));
                            continue;
                        }
                    }
                    Err(e) => {
                        log(format!("дублирование экрана: {e} — переподключение"));
                        break;
                    }
                }
                if !pending || last_pub.elapsed() < min_gap {
                    continue;
                }
                let Some((src, w, h)) = desk.clone() else { continue };
                let r = publish(&latest, &gpu, w, h, false, |dst| unsafe {
                    gpu.ctx.CopyResource(dst, &src);
                    // Курсор: копируем участок под ним, рисуем через GDI, кладём обратно.
                    let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
                    if let (Some(p), true) = (&patch, GetCursorInfo(&mut ci).is_ok() && ci.flags.0 & CURSOR_SHOWING.0 != 0) {
                        let (cx, cy) = (ci.ptScreenPos.x - origin.x - 8, ci.ptScreenPos.y - origin.y - 8);
                        if cx > -(C as i32) && cy > -(C as i32) && cx < w as i32 && cy < h as i32 {
                            let (px, py) = (cx.clamp(0, (w - C) as i32) as u32, cy.clamp(0, (h - C) as i32) as u32);
                            let pb = D3D11_BOX { left: px, top: py, front: 0, right: px + C, bottom: py + C, back: 1 };
                            gpu.ctx.CopySubresourceRegion(p, 0, 0, 0, 0, dst, 0, Some(&pb));
                            let surf: IDXGISurface1 = p.cast()?;
                            let dc = surf.GetDC(false)?;
                            draw_cursor(dc, POINT { x: origin.x + px as i32, y: origin.y + py as i32 }, C, C);
                            surf.ReleaseDC(None)?;
                            gpu.ctx.CopySubresourceRegion(dst, 0, px, py, 0, p, 0, None);
                        }
                    }
                    Ok(())
                });
                if let Err(e) = r {
                    log(format!("кадр экрана: {e}"));
                }
                last_pub = Instant::now();
                pending = false;
            }
        }
    });
    Legacy { stop, th: Some(th) }
}

/// Окно через PrintWindow с заданной частотой. Окно закрыли — `on_closed`.
pub fn start_window(gpu: Gpu, hwnd: HWND, fps: u32, latest: Shared, on_closed: impl Fn() + Send + 'static, log: impl Fn(String) + Send + 'static) -> Legacy {
    let stop = Arc::new(AtomicBool::new(false));
    let st = stop.clone();
    let hwnd_raw = hwnd.0 as usize;
    let th = std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut _);
        let period = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
        let mut gdi: Option<(HDC, HBITMAP, *mut u8, u32, u32)> = None;
        let mut slow_logged = false;
        let mut next = Instant::now();
        while !st.load(Ordering::SeqCst) {
            next += period;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            } else {
                next = now;
            }
            if unsafe { !IsWindow(Some(hwnd)).as_bool() } {
                on_closed();
                break;
            }
            if unsafe { IsIconic(hwnd).as_bool() } {
                continue;
            } // свёрнуто — показываем последний кадр
            let (w, h) = client_size(hwnd);
            unsafe {
                if !matches!(gdi, Some((_, _, _, gw, gh)) if gw == w && gh == h) {
                    if let Some((dc, bmp, ..)) = gdi.take() {
                        let _ = DeleteDC(dc);
                        let _ = DeleteObject(bmp.into());
                    }
                    let screen = GetDC(None);
                    let dc = CreateCompatibleDC(Some(screen));
                    ReleaseDC(None, screen);
                    let bi = BITMAPINFO {
                        bmiHeader: BITMAPINFOHEADER {
                            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                            biWidth: w as i32,
                            biHeight: -(h as i32),
                            biPlanes: 1,
                            biBitCount: 32,
                            biCompression: BI_RGB.0,
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    let mut bits = std::ptr::null_mut();
                    let Ok(bmp) = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0) else {
                        let _ = DeleteDC(dc);
                        continue;
                    };
                    SelectObject(dc, bmp.into());
                    gdi = Some((dc, bmp, bits as *mut u8, w, h));
                }
                let (dc, _, bits, _, _) = gdi.unwrap();
                let t = Instant::now();
                if !PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_CLIENTONLY.0 | PW_RENDERFULLCONTENT)).as_bool() {
                    continue;
                }
                let mut o = POINT::default();
                let _ = ClientToScreen(hwnd, &mut o);
                draw_cursor(dc, o, w, h);
                let _ = GdiFlush();
                if !slow_logged && t.elapsed() > period {
                    log(format!("окно рисуется медленно: {:.1} мс на кадр", t.elapsed().as_secs_f64() * 1000.0));
                    slow_logged = true;
                }
                let r = publish(&latest, &gpu, w, h, false, |dst| {
                    gpu.ctx.UpdateSubresource(dst, 0, None, bits as *const _, w * 4, 0);
                    Ok(())
                });
                if let Err(e) = r {
                    log(format!("кадр окна: {e}"));
                }
            }
        }
        if let Some((dc, bmp, ..)) = gdi.take() {
            unsafe {
                let _ = DeleteDC(dc);
                let _ = DeleteObject(bmp.into());
            }
        }
    });
    Legacy { stop, th: Some(th) }
}

/// Миниатюра (BGRA, шаг строки) через GDI: экран — с экранного контекста, окно — PrintWindow.
pub fn thumbnail(source: &str, max_w: u32, max_h: u32) -> Option<(Vec<u8>, u32, u32)> {
    let (k, v) = source.split_once(':')?;
    let raw = v.parse::<usize>().ok()? as *mut std::ffi::c_void;
    unsafe {
        let screen = GetDC(None);
        let (src_dc, sx, sy, sw, sh, own): (HDC, i32, i32, i32, i32, Option<(HDC, HBITMAP)>) = if k == "m" {
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(HMONITOR(raw), &mut mi).as_bool() {
                ReleaseDC(None, screen);
                return None;
            }
            let r = mi.rcMonitor;
            (screen, r.left, r.top, r.right - r.left, r.bottom - r.top, None)
        } else {
            let hwnd = HWND(raw);
            if IsIconic(hwnd).as_bool() {
                ReleaseDC(None, screen);
                return None;
            }
            let (w, h) = client_size(hwnd);
            let dc = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w as i32, h as i32);
            SelectObject(dc, bmp.into());
            let _ = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_CLIENTONLY.0 | PW_RENDERFULLCONTENT));
            (dc, 0, 0, w as i32, h as i32, Some((dc, bmp)))
        };
        let k2 = (sw as f32 / max_w as f32).max(sh as f32 / max_h as f32).max(1.0);
        let (tw, th) = (((sw as f32 / k2) as u32).max(1), ((sh as f32 / k2) as u32).max(1));
        let dst = CreateCompatibleDC(Some(screen));
        let bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: tw as i32,
                biHeight: -(th as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let out = CreateDIBSection(Some(dst), &bi, DIB_RGB_COLORS, &mut bits, None, 0).ok().map(|bmp| {
            SelectObject(dst, bmp.into());
            SetStretchBltMode(dst, HALFTONE);
            let _ = StretchBlt(dst, 0, 0, tw as i32, th as i32, Some(src_dc), sx, sy, sw, sh, SRCCOPY | CAPTUREBLT);
            let _ = GdiFlush();
            let v = std::slice::from_raw_parts(bits as *const u8, (tw * th * 4) as usize).to_vec();
            let _ = DeleteObject(bmp.into());
            v
        });
        let _ = DeleteDC(dst);
        if let Some((dc, bmp)) = own {
            let _ = DeleteDC(dc);
            let _ = DeleteObject(bmp.into());
        }
        ReleaseDC(None, screen);
        out.map(|v| (v, tw, th))
    }
}

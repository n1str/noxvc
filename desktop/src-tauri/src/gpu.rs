//! Захват для трансляции на своём D3D11-устройстве (с поддержкой видео — её требует Media Foundation).
//!
//! Windows Graphics Capture присылает кадры, когда картинка меняется; мы копируем каждый в «последний кадр»
//! (копия внутри видеокарты), а насос трансляции забирает его в своём ровном темпе. Дальше два пути:
//! - видеокарта: BGRA → NV12 видеопроцессором D3D11 (масштаб, рамки по бокам) → аппаратный H.264;
//! - процессор: BGRA → постоянная staging-текстура → I420 → программный кодировщик libwebrtc.

use std::sync::{Arc, Condvar, Mutex};
use windows::core::{factory, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

pub type WinResult<T> = windows::core::Result<T>;

/// D3D11-устройство трансляции. Защищено от многопоточного доступа (его трогают WGC, насос и кодировщик).
#[derive(Clone)]
pub struct Gpu {
    pub device: ID3D11Device,
    pub ctx: ID3D11DeviceContext,
}
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    pub fn new() -> WinResult<Self> {
        let (mut device, mut ctx) = (None, None);
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut ctx),
            )?;
        }
        let device = device.ok_or_else(windows::core::Error::empty)?;
        let mt: ID3D11Multithread = device.cast()?;
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        Ok(Self { device, ctx: ctx.ok_or_else(windows::core::Error::empty)? })
    }

    /// Устройство на конкретной видеокарте (Desktop Duplication требует видеокарту монитора).
    pub fn on_adapter(adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1) -> WinResult<Self> {
        let (mut device, mut ctx) = (None, None);
        unsafe {
            D3D11CreateDevice(
                adapter,
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut ctx),
            )?;
        }
        let device = device.ok_or_else(windows::core::Error::empty)?;
        let mt: ID3D11Multithread = device.cast()?;
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        Ok(Self { device, ctx: ctx.ok_or_else(windows::core::Error::empty)? })
    }

    pub fn texture(
        &self,
        w: u32,
        h: u32,
        format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
        bind: D3D11_BIND_FLAG,
        usage: D3D11_USAGE,
        cpu: D3D11_CPU_ACCESS_FLAG,
    ) -> WinResult<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: usage,
            BindFlags: bind.0 as u32,
            CPUAccessFlags: cpu.0 as u32,
            MiscFlags: 0,
        };
        let mut t = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut t))? };
        t.ok_or_else(windows::core::Error::empty)
    }
}

/// Последний кадр + сигнал «пришёл новый» (насос просыпается сразу, без биений двух таймеров по 60 Гц).
pub type Shared = Arc<(Mutex<Latest>, Condvar)>;

/// Последний захваченный кадр (BGRA, размер содержимого) и его номер.
#[derive(Default)]
pub struct Latest {
    pub tex: Option<ID3D11Texture2D>,
    pub w: u32,
    pub h: u32,
    pub seq: u64,
}
unsafe impl Send for Latest {}

pub fn capture_item(source: &str) -> WinResult<GraphicsCaptureItem> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let (k, v) = source.split_once(':').ok_or_else(windows::core::Error::empty)?;
    let raw = v.parse::<usize>().map_err(|_| windows::core::Error::empty())? as *mut std::ffi::c_void;
    unsafe {
        match k {
            "w" => interop.CreateForWindow(HWND(raw)),
            _ => interop.CreateForMonitor(HMONITOR(raw)),
        }
    }
}

/// Сессия захвата: кадры копируются в `latest`; `on_closed` — источник закрыли (окно закрыто).
pub struct Capture {
    session: GraphicsCaptureSession,
    pool: Direct3D11CaptureFramePool,
}
unsafe impl Send for Capture {}

impl Capture {
    pub fn start(gpu: &Gpu, item: &GraphicsCaptureItem, latest: Shared, on_closed: impl Fn() + Send + 'static) -> WinResult<Self> {
        let dxgi: IDXGIDevice = gpu.device.cast()?;
        let d3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
        let fmt = DirectXPixelFormat::B8G8R8A8UIntNormalized;
        let size = item.Size()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, fmt, 2, size)?;
        let session = pool.CreateCaptureSession(item)?;
        let _ = session.SetIsCursorCaptureEnabled(true);
        let _ = session.SetIsBorderRequired(false); // без жёлтой рамки (Windows 11)
        item.Closed(&TypedEventHandler::new(move |_, _| {
            on_closed();
            Ok(())
        }))?;
        let g = gpu.clone();
        let dev = SendDevice(d3d.clone());
        let last = Arc::new(Mutex::new(size));
        pool.FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |p, _| {
            let Some(p) = p.as_ref() else { return Ok(()) };
            let frame = p.TryGetNextFrame()?;
            let cs = frame.ContentSize()?;
            {
                // Размер окна изменился — пересоздаём пул под новый размер, этот кадр пропускаем.
                let mut l = last.lock().unwrap();
                if cs.Width != l.Width || cs.Height != l.Height {
                    *l = cs;
                    drop(frame);
                    p.Recreate(dev.get(), fmt, 2, cs)?;
                    return Ok(());
                }
            }
            let (w, h) = (cs.Width.max(2) as u32 & !1, cs.Height.max(2) as u32 & !1);
            let src: ID3D11Texture2D = unsafe { frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
            let mut l = latest.0.lock().unwrap();
            if l.tex.is_none() || l.w != w || l.h != h {
                l.tex = Some(g.texture(
                    w,
                    h,
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET,
                    D3D11_USAGE_DEFAULT,
                    D3D11_CPU_ACCESS_FLAG(0),
                )?);
                l.w = w;
                l.h = h;
            }
            let bx = D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 };
            unsafe { g.ctx.CopySubresourceRegion(l.tex.as_ref().unwrap(), 0, 0, 0, 0, &src, 0, Some(&bx)) };
            l.seq += 1;
            latest.1.notify_one();
            Ok(())
        }))?;
        session.StartCapture()?;
        Ok(Self { session, pool })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// IDirect3DDevice для обработчика кадров (устройство защищено от многопоточности).
struct SendDevice(IDirect3DDevice);
unsafe impl Send for SendDevice {}
impl SendDevice {
    fn get(&self) -> &IDirect3DDevice {
        &self.0
    }
}

pub fn item_size(item: &GraphicsCaptureItem) -> (u32, u32) {
    let s: SizeInt32 = item.Size().unwrap_or_default();
    (s.Width.max(2) as u32, s.Height.max(2) as u32)
}

/// Вписать в рамку с сохранением пропорций; чётные размеры.
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h {
        return (w & !1, h & !1);
    }
    let k = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    (((w as f64 * k) as u32).max(2) & !1, ((h as f64 * k) as u32).max(2) & !1)
}

// ---------- путь видеокарты: BGRA → NV12 нужного размера ----------
pub struct Converter {
    gpu: Gpu,
    vdev: ID3D11VideoDevice,
    vctx: ID3D11VideoContext,
    pub out_w: u32,
    pub out_h: u32,
    ring: Vec<ID3D11Texture2D>,
    next: usize,
    /// Под текущий размер входа: перечислитель, процессор, выходные виды, входной вид (по текстуре).
    state: Option<(u32, u32, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessor, Vec<ID3D11VideoProcessorOutputView>)>,
    input: Option<(usize, ID3D11VideoProcessorInputView)>,
}
unsafe impl Send for Converter {}

impl Converter {
    pub fn new(gpu: &Gpu, out_w: u32, out_h: u32) -> WinResult<Self> {
        let vdev: ID3D11VideoDevice = gpu.device.cast()?;
        let vctx: ID3D11VideoContext = gpu.ctx.cast()?;
        // Кольцо выходных кадров: кодировщик работает асинхронно и держит несколько кадров.
        let ring = (0..6)
            .map(|_| gpu.texture(out_w, out_h, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, D3D11_USAGE_DEFAULT, D3D11_CPU_ACCESS_FLAG(0)))
            .collect::<WinResult<Vec<_>>>()?;
        Ok(Self { gpu: gpu.clone(), vdev, vctx, out_w, out_h, ring, next: 0, state: None, input: None })
    }

    fn prepare(&mut self, w: u32, h: u32) -> WinResult<()> {
        if matches!(&self.state, Some((sw, sh, ..)) if *sw == w && *sh == h) {
            return Ok(());
        }
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL_60,
            InputWidth: w,
            InputHeight: h,
            OutputFrameRate: DXGI_RATIONAL_60,
            OutputWidth: self.out_w,
            OutputHeight: self.out_h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
        };
        let en = unsafe { self.vdev.CreateVideoProcessorEnumerator(&desc)? };
        let vp = unsafe { self.vdev.CreateVideoProcessor(&en, 0)? };
        let mut views = vec![];
        for t in &self.ring {
            let od = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut v = None;
            unsafe { self.vdev.CreateVideoProcessorOutputView(t, &en, &od, Some(&mut v))? };
            views.push(v.ok_or_else(windows::core::Error::empty)?);
        }
        // Вписываем с сохранением пропорций, по бокам — чёрные поля (окно могли растянуть).
        let (dw, dh) = fit(w, h, self.out_w, self.out_h);
        let (dw, dh) = if w < self.out_w && h < self.out_h {
            let k = (self.out_w as f64 / w as f64).min(self.out_h as f64 / h as f64);
            (((w as f64 * k) as u32) & !1, ((h as f64 * k) as u32) & !1)
        } else {
            (dw, dh)
        };
        let (x, y) = ((self.out_w - dw) / 2, (self.out_h - dh) / 2);
        unsafe {
            self.vctx.VideoProcessorSetStreamFrameFormat(&vp, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            self.vctx.VideoProcessorSetStreamAutoProcessingMode(&vp, 0, false);
            // Вход: RGB 0–255; выход: YCbCr BT.601 16–235 (как у программного пути, зрители так и показывают).
            self.vctx.VideoProcessorSetStreamColorSpace(&vp, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 });
            self.vctx.VideoProcessorSetOutputColorSpace(&vp, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 1 << 4 });
            self.vctx.VideoProcessorSetStreamSourceRect(&vp, 0, true, Some(&RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 }));
            self.vctx.VideoProcessorSetStreamDestRect(
                &vp,
                0,
                true,
                Some(&RECT { left: x as i32, top: y as i32, right: (x + dw) as i32, bottom: (y + dh) as i32 }),
            );
            let black = D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 16.0 / 255.0, Cb: 0.5, Cr: 0.5, A: 1.0 } } };
            self.vctx.VideoProcessorSetOutputBackgroundColor(&vp, true, &black);
        }
        self.state = Some((w, h, en, vp, views));
        self.input = None;
        Ok(())
    }

    /// Преобразовать кадр; возвращает NV12-текстуру из кольца.
    pub fn convert(&mut self, src: &ID3D11Texture2D, w: u32, h: u32) -> WinResult<ID3D11Texture2D> {
        self.prepare(w, h)?;
        let (_, _, en, vp, views) = self.state.as_ref().unwrap();
        let key = src.as_raw() as usize;
        if !matches!(&self.input, Some((k, _)) if *k == key) {
            let id = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut v = None;
            unsafe { self.vdev.CreateVideoProcessorInputView(src, en, &id, Some(&mut v))? };
            self.input = Some((key, v.ok_or_else(windows::core::Error::empty)?));
        }
        let i = self.next;
        self.next = (self.next + 1) % self.ring.len();
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(self.input.as_ref().unwrap().1.clone())),
            ..Default::default()
        };
        let mut streams = [stream];
        let r = unsafe { self.vctx.VideoProcessorBlt(vp, &views[i], 0, &streams) };
        unsafe { std::mem::ManuallyDrop::drop(&mut streams[0].pInputSurface) };
        r?;
        let _ = &self.gpu;
        Ok(self.ring[i].clone())
    }
}

const DXGI_RATIONAL_60: windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL =
    windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL { Numerator: 60, Denominator: 1 };

// ---------- путь процессора: BGRA → память ----------
pub struct Readback {
    gpu: Gpu,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
}
unsafe impl Send for Readback {}

impl Readback {
    pub fn new(gpu: &Gpu) -> Self {
        Self { gpu: gpu.clone(), staging: None }
    }
    /// Скопировать кадр в постоянную staging-текстуру и отдать байты BGRA (с шагом строки).
    pub fn read<R>(&mut self, src: &ID3D11Texture2D, w: u32, h: u32, f: impl FnOnce(&[u8], u32) -> R) -> WinResult<R> {
        if !matches!(&self.staging, Some((_, sw, sh)) if *sw == w && *sh == h) {
            let t = self.gpu.texture(w, h, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_FLAG(0), D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ)?;
            self.staging = Some((t, w, h));
        }
        let st = &self.staging.as_ref().unwrap().0;
        unsafe {
            self.gpu.ctx.CopyResource(st, src);
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            self.gpu.ctx.Map(st, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
            let data = std::slice::from_raw_parts(m.pData as *const u8, (m.RowPitch * h) as usize);
            let r = f(data, m.RowPitch);
            self.gpu.ctx.Unmap(st, 0);
            Ok(r)
        }
    }
}

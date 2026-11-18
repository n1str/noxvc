//! Тестовая «игра» для замеров демонстрации экрана: окно с D3D11 flip-model swapchain (как у современных игр),
//! каждый кадр — новый цвет, движущиеся блоки и «штрихкод» времени по середине кадра (32 блока: чёрный, белый,
//! затем 30 бит Date.now() mod 2^30 — тот же формат, что у e2e-baseline.mjs). Рисуется только ClearView (без шейдеров).
//!   cargo run --release --example fakegame -- [ширина высота x y]
//! Заголовок окна: «RELAY FAKE GAME». Закрывается обычным закрытием окна.
#![cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{w, Interface};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

extern "system" fn wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if m == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(h, m, w, l) }
}

fn main() -> windows::core::Result<()> {
    let a: Vec<i32> = std::env::args().skip(1).filter_map(|x| x.parse().ok()).collect();
    let (cw, ch, x, y) = (*a.first().unwrap_or(&1600), *a.get(1).unwrap_or(&900), *a.get(2).unwrap_or(&40), *a.get(3).unwrap_or(&40));
    unsafe {
        let class = w!("RelayFakeGame");
        RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: class, hCursor: LoadCursorW(None, IDC_ARROW)?, ..Default::default() });
        let mut r = RECT { left: 0, top: 0, right: cw, bottom: ch };
        AdjustWindowRect(&mut r, WS_OVERLAPPEDWINDOW, false)?;
        let hwnd = CreateWindowExW(
            Default::default(),
            class,
            w!("RELAY FAKE GAME"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x,
            y,
            r.right - r.left,
            r.bottom - r.top,
            None,
            None,
            None,
            None,
        )?;

        let mut dev = None;
        let mut ctx = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            Default::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut dev),
            None,
            Some(&mut ctx),
        )?;
        let (dev, ctx): (ID3D11Device, ID3D11DeviceContext) = (dev.unwrap(), ctx.unwrap());
        let ctx1: ID3D11DeviceContext1 = ctx.cast()?;
        let factory: IDXGIFactory2 = CreateDXGIFactory1()?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: cw as u32,
            Height: ch as u32,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            ..Default::default()
        };
        let sc = factory.CreateSwapChainForHwnd(&dev, hwnd, &desc, None, None)?;

        let mut t: u32 = 0;
        let mut msg = MSG::default();
        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    return Ok(());
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            t = t.wrapping_add(1);
            let bb: ID3D11Texture2D = sc.GetBuffer(0)?;
            let mut rtv = None;
            dev.CreateRenderTargetView(&bb, None, Some(&mut rtv))?;
            let rtv = rtv.unwrap();
            let hue = (t % 360) as f32 / 360.0;
            ctx.ClearRenderTargetView(&rtv, &[0.2 + 0.3 * hue, 0.25, 0.5 - 0.3 * hue, 1.0]);
            // движущиеся блоки (как объекты сцены)
            let blocks: Vec<RECT> = (0..24)
                .map(|i| {
                    let bx = ((t as i32 * (3 + i % 5) + i * 97) % cw).abs();
                    let by = (i * ch / 24) % ch;
                    RECT { left: bx, top: by, right: bx + 60, bottom: by + ch / 30 }
                })
                .collect();
            ctx1.ClearView(&rtv, &[0.9, 0.9, 0.2, 1.0], Some(&blocks));
            // штрихкод времени
            let v = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() % 1_073_741_824) as u32;
            let (bw, y0, y1) = (cw as f32 / 32.0, (ch as f32 * 0.4) as i32, (ch as f32 * 0.6) as i32);
            let (mut black, mut white) = (vec![], vec![]);
            for i in 0..32u32 {
                let bit = if i == 0 {
                    0
                } else if i == 1 {
                    1
                } else {
                    (v >> (31 - i)) & 1
                };
                let rc = RECT { left: (i as f32 * bw) as i32, top: y0, right: ((i + 1) as f32 * bw).ceil() as i32, bottom: y1 };
                if bit == 1 {
                    white.push(rc)
                } else {
                    black.push(rc)
                }
            }
            if !black.is_empty() {
                ctx1.ClearView(&rtv, &[0.0, 0.0, 0.0, 1.0], Some(&black));
            }
            if !white.is_empty() {
                ctx1.ClearView(&rtv, &[1.0, 1.0, 1.0, 1.0], Some(&white));
            }
            sc.Present(1, DXGI_PRESENT(0)).ok()?;
        }
    }
}

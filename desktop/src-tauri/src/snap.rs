//! Snap Layouts Windows 11 для своего заголовка окна. Системная кнопка «развернуть» отсутствует
//! (окно без рамки, кнопки рисует страница), поэтому меню раскладок открываем так же, как его открывает
//! сочетание Win+Z. Только Windows 11 (на Windows 10 Win+Z ничего не делает) и только если окно Relay
//! сейчас активно — иначе нажатие ушло бы в чужую программу.

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN};
use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

const VK_Z: u16 = 0x5A;

pub fn supported() -> bool {
    crate::legacy::os_build() >= 22000
}

/// Окно сейчас на переднем плане (флаг фокуса Tauri этого не знает: фокус живёт в WebView).
pub fn is_foreground(hwnd: isize) -> bool {
    unsafe { GetForegroundWindow() as isize == hwnd }
}

pub fn show() {
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } },
    };
    let seq = [key(VK_LWIN, false), key(VK_Z, false), key(VK_Z, true), key(VK_LWIN, true)];
    unsafe { SendInput(seq.len() as u32, seq.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
}

// ---------- активность окна для заголовка ----------
// Фокус Tauri/tao — это клавиатурный фокус самого окна верхнего уровня; после клика внутрь он уходит в WebView,
// и окно числится «не в фокусе», хотя оно активно. Поэтому активность берём у Windows: системное событие смены
// активного окна (EVENT_SYSTEM_FOREGROUND, без внедрения в другие процессы) → событие `window-active` для страницы.

use std::sync::atomic::{AtomicI8, AtomicIsize, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT};

static APP: OnceLock<AppHandle> = OnceLock::new();
static MAIN: AtomicIsize = AtomicIsize::new(0);
static LAST: AtomicI8 = AtomicI8::new(-1);

/// Главное окно сейчас активно (на переднем плане).
pub fn main_active() -> bool {
    let h = MAIN.load(Ordering::Relaxed);
    h != 0 && is_foreground(h)
}

fn notify() {
    let now = main_active() as i8;
    if LAST.swap(now, Ordering::Relaxed) != now {
        if let Some(app) = APP.get() {
            let _ = app.emit("window-active", now == 1);
        }
    }
}

unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    notify();
}

/// Вызывать в потоке с циклом сообщений (главный поток приложения).
pub fn watch_active(app: AppHandle, main: isize) {
    MAIN.store(main, Ordering::Relaxed);
    let _ = APP.set(app);
    unsafe { SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, std::ptr::null_mut(), Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT) };
    notify();
}

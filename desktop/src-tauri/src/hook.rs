//! Глобальная клавиша рации на Windows через Raw Input (RIDEV_INPUTSINK): события клавиатуры и мыши
//! приходят в скрытое окно, даже когда Relay не в фокусе. В отличие от низкоуровневых хуков:
//! - ввод не задерживается и не перехватывается (мы только наблюдаем);
//! - нет таймаута LowLevelHooksTimeout, после которого Windows молча снимает хук (события стоят в очереди).
//!
//! Коды — как KeyboardEvent.code в браузере (KeyV, F9, ControlLeft, Backquote…), мышь — Mouse4/Mouse5.

use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

/// Должен быть быстрым (только передать дальше).
type Sink = Box<dyn Fn(String, bool) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();

/// Виртуальный код Windows → KeyboardEvent.code.
pub fn vk_code(vk: u32) -> String {
    match vk {
        0x41..=0x5A => format!("Key{}", (vk as u8) as char),
        0x30..=0x39 => format!("Digit{}", vk - 0x30),
        0x70..=0x87 => format!("F{}", vk - 0x6F),
        0x60..=0x69 => format!("Numpad{}", vk - 0x60),
        0x20 => "Space".into(),
        0x09 => "Tab".into(),
        0x14 => "CapsLock".into(),
        0x0D => "Enter".into(),
        0x1B => "Escape".into(),
        0x08 => "Backspace".into(),
        0xA0 => "ShiftLeft".into(),
        0xA1 => "ShiftRight".into(),
        0xA2 => "ControlLeft".into(),
        0xA3 => "ControlRight".into(),
        0xA4 => "AltLeft".into(),
        0xA5 => "AltRight".into(),
        0x5B => "MetaLeft".into(),
        0x5C => "MetaRight".into(),
        0xC0 => "Backquote".into(),
        0xBD => "Minus".into(),
        0xBB => "Equal".into(),
        0xDB => "BracketLeft".into(),
        0xDD => "BracketRight".into(),
        0xDC => "Backslash".into(),
        0xBA => "Semicolon".into(),
        0xDE => "Quote".into(),
        0xBC => "Comma".into(),
        0xBE => "Period".into(),
        0xBF => "Slash".into(),
        0x2D => "Insert".into(),
        0x2E => "Delete".into(),
        0x24 => "Home".into(),
        0x23 => "End".into(),
        0x21 => "PageUp".into(),
        0x22 => "PageDown".into(),
        0x25 => "ArrowLeft".into(),
        0x26 => "ArrowUp".into(),
        0x27 => "ArrowRight".into(),
        0x28 => "ArrowDown".into(),
        0x13 => "Pause".into(),
        0x91 => "ScrollLock".into(),
        0x2C => "PrintScreen".into(),
        0x6A => "NumpadMultiply".into(),
        0x6B => "NumpadAdd".into(),
        0x6D => "NumpadSubtract".into(),
        0x6E => "NumpadDecimal".into(),
        0x6F => "NumpadDivide".into(),
        other => format!("VK{other:02X}"),
    }
}

/// Raw Input даёт общие VK_SHIFT/VK_CONTROL/VK_MENU — уточняем левую/правую по скан-коду и флагу E0.
fn side_vk(vk: u16, make: u16, e0: bool) -> u32 {
    match vk {
        0x10 => {
            if make == 0x36 {
                0xA1
            } else {
                0xA0
            }
        }
        0x11 => {
            if e0 {
                0xA3
            } else {
                0xA2
            }
        }
        0x12 => {
            if e0 {
                0xA5
            } else {
                0xA4
            }
        }
        v => v as u32,
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        let mut raw: RAWINPUT = std::mem::zeroed();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let got = GetRawInputData(l as HRAWINPUT, RID_INPUT, &mut raw as *mut _ as *mut _, &mut size, std::mem::size_of::<RAWINPUTHEADER>() as u32);
        if got != u32::MAX {
            if let Some(f) = SINK.get() {
                if raw.header.dwType == RIM_TYPEKEYBOARD {
                    let k = raw.data.keyboard;
                    if k.VKey != 0xFF {
                        let up = k.Flags as u32 & RI_KEY_BREAK != 0;
                        let e0 = k.Flags as u32 & RI_KEY_E0 != 0;
                        f(vk_code(side_vk(k.VKey, k.MakeCode, e0)), !up);
                    }
                } else if raw.header.dwType == RIM_TYPEMOUSE {
                    let b = raw.data.mouse.Anonymous.Anonymous.usButtonFlags as u32;
                    if b & RI_MOUSE_BUTTON_4_DOWN != 0 {
                        f("Mouse4".into(), true);
                    }
                    if b & RI_MOUSE_BUTTON_4_UP != 0 {
                        f("Mouse4".into(), false);
                    }
                    if b & RI_MOUSE_BUTTON_5_DOWN != 0 {
                        f("Mouse5".into(), true);
                    }
                    if b & RI_MOUSE_BUTTON_5_UP != 0 {
                        f("Mouse5".into(), false);
                    }
                }
            }
        }
    }
    DefWindowProcW(hwnd, msg, w, l)
}

/// Скрытое окно + регистрация Raw Input + цикл сообщений (вызывать в отдельном потоке; не возвращается).
pub fn run(sink: Sink) -> Result<(), String> {
    SINK.set(sink).map_err(|_| "уже запущено".to_string())?;
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let class: Vec<u16> = "RelayPttSink\0".encode_utf16().collect();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: module, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
        if RegisterClassW(&wc) == 0 {
            return Err("RegisterClassW не удался".into());
        }
        let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), module, std::ptr::null());
        if hwnd.is_null() {
            return Err("CreateWindowExW не удался".into());
        }
        let devices = [
            RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x06, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd }, // клавиатура
            RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x02, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd }, // мышь
        ];
        if RegisterRawInputDevices(devices.as_ptr(), devices.len() as u32, std::mem::size_of::<RAWINPUTDEVICE>() as u32) == 0 {
            return Err("RegisterRawInputDevices не удался".into());
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes() {
        assert_eq!(vk_code(0x56), "KeyV");
        assert_eq!(vk_code(0x78), "F9");
        assert_eq!(vk_code(0x7C), "F13");
        assert_eq!(vk_code(0x33), "Digit3");
        assert_eq!(vk_code(0xC0), "Backquote");
        assert_eq!(vk_code(side_vk(0x11, 0x1D, false)), "ControlLeft");
        assert_eq!(vk_code(side_vk(0x11, 0x1D, true)), "ControlRight");
        assert_eq!(vk_code(side_vk(0x10, 0x36, false)), "ShiftRight");
    }
}

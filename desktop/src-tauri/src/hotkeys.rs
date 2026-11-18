//! Глобальные горячие клавиши: работают, когда Relay не в фокусе (поверх игр и полноэкранных окон).
//! Ввод наблюдается через Raw Input (hook.rs) — не перехватывается и не задерживается. Страница задаёт привязки
//! «действие → сочетание» (hotkeys_set), а получает только события «действие нажато/отпущено» (`hotkey`):
//! сами нажатия клавиш из приложения не выходят.
//!
//! Сочетание — строка «Ctrl+Shift+KeyM», «Alt+F9», «Mouse4», «ControlLeft» (код — как KeyboardEvent.code).
//! Модификаторы должны совпасть точно, кроме рации без модификаторов: её можно держать вместе с Shift/Ctrl
//! (в играх бегут с зажатым Shift).
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Deserialize, Clone, Debug)]
pub struct BindIn {
    pub action: String,
    pub combo: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Combo {
    pub code: String,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub action: String,
    pub down: bool,
}

pub fn parse(s: &str) -> Option<Combo> {
    let mut c = Combo { code: String::new(), ctrl: false, shift: false, alt: false, meta: false };
    let parts: Vec<&str> = s.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let (code, mods) = parts.split_last()?;
    for m in mods {
        match *m {
            "Ctrl" => c.ctrl = true,
            "Shift" => c.shift = true,
            "Alt" => c.alt = true,
            "Meta" => c.meta = true,
            _ => return None,
        }
    }
    if code.len() > 32 || !code.chars().all(|ch| ch.is_ascii_alphanumeric()) || ["Ctrl", "Shift", "Alt", "Meta"].contains(code) {
        return None;
    }
    c.code = code.to_string();
    Some(c)
}

fn modifier(code: &str) -> Option<usize> {
    match code {
        "ControlLeft" | "ControlRight" => Some(0),
        "ShiftLeft" | "ShiftRight" => Some(1),
        "AltLeft" | "AltRight" => Some(2),
        "MetaLeft" | "MetaRight" => Some(3),
        _ => None,
    }
}

/// Состояние: привязки, нажатые модификаторы (левый/правый — отдельно), удерживаемые действия.
#[derive(Default)]
pub struct Engine {
    binds: Vec<(String, Combo)>,
    mods: std::collections::HashSet<String>,
    held: std::collections::HashSet<String>,
}

impl Engine {
    pub fn set(&mut self, b: &[BindIn]) {
        self.binds = b.iter().filter_map(|x| parse(&x.combo).map(|c| (x.action.clone(), c))).collect();
        self.held.clear();
    }
    fn mod_down(&self, i: usize) -> bool {
        let names: [[&str; 2]; 4] = [["ControlLeft", "ControlRight"], ["ShiftLeft", "ShiftRight"], ["AltLeft", "AltRight"], ["MetaLeft", "MetaRight"]];
        names[i].iter().any(|n| self.mods.contains(*n))
    }
    /// Событие клавиши/кнопки → события действий.
    pub fn input(&mut self, code: &str, down: bool) -> Vec<Event> {
        let mut out = vec![];
        if modifier(code).is_some() {
            if down {
                self.mods.insert(code.to_string());
            } else {
                self.mods.remove(code);
            }
        }
        for (action, c) in &self.binds {
            if c.code != code {
                continue;
            }
            if down {
                if self.held.contains(action) {
                    continue;
                } // автоповтор
                let need = [c.ctrl, c.shift, c.alt, c.meta];
                // модификатор, который сам является клавишей сочетания, в сравнении не участвует
                let own = modifier(code);
                let plain_ptt = action == "ptt" && !need.iter().any(|x| *x);
                let ok = plain_ptt || (0..4).all(|i| Some(i) == own || self.mod_down(i) == need[i]);
                if ok {
                    self.held.insert(action.clone());
                    out.push(Event { action: action.clone(), down: true });
                }
            } else if self.held.remove(action) {
                out.push(Event { action: action.clone(), down: false });
            }
        }
        out
    }
}

pub static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

pub fn set(b: &[BindIn]) {
    ENGINE.lock().unwrap().get_or_insert_with(Engine::default).set(b);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn b(a: &str, c: &str) -> BindIn {
        BindIn { action: a.into(), combo: c.into() }
    }
    fn ev(a: &str, d: bool) -> Event {
        Event { action: a.into(), down: d }
    }
    #[test]
    fn parses() {
        assert_eq!(parse("Ctrl+Shift+KeyM"), Some(Combo { code: "KeyM".into(), ctrl: true, shift: true, alt: false, meta: false }));
        assert_eq!(parse("Mouse4").map(|c| c.code), Some("Mouse4".into()));
        assert!(parse("Hyper+KeyM").is_none() && parse("").is_none() && parse("Ctrl+").is_none() && parse("Key M").is_none());
    }
    #[test]
    fn combos_ptt_and_repeat() {
        let mut e = Engine::default();
        e.set(&[b("mute", "Ctrl+Shift+KeyM"), b("ptt", "Mouse4"), b("deafen", "Alt+F9"), b("stream", "ControlRight")]);
        // точное совпадение модификаторов
        assert!(e.input("KeyM", true).is_empty(), "без модификаторов — нет");
        e.input("ControlLeft", true);
        e.input("ShiftLeft", true);
        assert_eq!(e.input("KeyM", true), vec![ev("mute", true)]);
        assert!(e.input("KeyM", true).is_empty(), "автоповтор не дублирует");
        assert_eq!(e.input("KeyM", false), vec![ev("mute", false)]);
        e.input("ShiftLeft", false);
        e.input("ControlLeft", false);
        // лишний модификатор — не то сочетание
        e.input("ControlLeft", true);
        assert!(e.input("F9", true).is_empty());
        e.input("ControlLeft", false);
        e.input("AltRight", true);
        assert_eq!(e.input("F9", true), vec![ev("deafen", true)]);
        e.input("F9", false);
        e.input("AltRight", false);
        // рация без модификаторов работает и с зажатым Shift (бег в игре); нажата/отпущена
        e.input("ShiftLeft", true);
        assert_eq!(e.input("Mouse4", true), vec![ev("ptt", true)]);
        assert_eq!(e.input("Mouse4", false), vec![ev("ptt", false)]);
        e.input("ShiftLeft", false);
        // сочетание из одного модификатора
        assert_eq!(e.input("ControlRight", true), vec![ev("stream", true)]);
        assert_eq!(e.input("ControlRight", false), vec![ev("stream", false)]);
        // неизвестные привязки отбрасываются, смена привязок сбрасывает удержание
        e.set(&[b("x", "Bad+Key")]);
        assert!(e.input("Mouse4", true).is_empty());
    }
}

//! Разбор поискового запроса: слова + фильтры в стиле Discord.
//!   from:имя  mentions:имя  in:канал  has:link|file|image|video|audio  pinned:true|false
//!   before:2026-01-31  after:2026-01-01  during:2026-01-15  (также ДД.ММ.ГГГГ)
//! Значения с пробелами — в кавычках: from:"Иван Петров".

#[derive(Debug, Default, PartialEq)]
pub struct Query {
    pub words: Vec<String>,
    pub from: Vec<String>,
    pub mentions: Vec<String>,
    pub channels: Vec<String>,
    pub has: Vec<Has>,
    pub pinned: Option<bool>,
    /// Дни (y, m, d) — границы считаются в часовом поясе клиента.
    pub before: Option<(i32, u32, u32)>,
    pub after: Option<(i32, u32, u32)>,
    pub during: Option<(i32, u32, u32)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Has {
    Link,
    File,
    Image,
    Video,
    Audio,
}

/// Разбить с учётом кавычек: `from:"a b" c` → [`from:a b`, `c`].
fn split(q: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    for ch in q.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn date(s: &str) -> Option<(i32, u32, u32)> {
    let parts: Vec<&str> = s.split(['-', '.', '/']).collect();
    if parts.len() != 3 {
        return None;
    }
    let n: Vec<i64> = parts.iter().map(|p| p.parse().ok()).collect::<Option<_>>()?;
    // ГГГГ-ММ-ДД или ДД.ММ.ГГГГ
    let (y, m, d) = if parts[0].len() == 4 { (n[0], n[1], n[2]) } else { (n[2], n[1], n[0]) };
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y as i32, m as u32, d as u32))
}

pub fn parse(q: &str) -> Result<Query, String> {
    let mut out = Query::default();
    for tok in split(q) {
        let Some((key, val)) = tok.split_once(':').filter(|(k, v)| !v.is_empty() && k.chars().all(|c| c.is_ascii_alphabetic())) else {
            words(&tok, &mut out.words);
            continue;
        };
        match key.to_ascii_lowercase().as_str() {
            "from" => out.from.push(val.trim_start_matches('@').to_string()),
            "mentions" => out.mentions.push(val.trim_start_matches('@').to_string()),
            "in" => out.channels.push(val.trim_start_matches('#').to_string()),
            "has" => out.has.push(match val.to_lowercase().as_str() {
                "link" | "ссылка" => Has::Link,
                "file" | "файл" => Has::File,
                "image" | "картинка" | "изображение" => Has::Image,
                "video" | "видео" => Has::Video,
                "audio" | "sound" | "звук" => Has::Audio,
                _ => return Err(format!("Неизвестное значение has:{val} (link, file, image, video, audio)")),
            }),
            "pinned" => {
                out.pinned = Some(match val.to_lowercase().as_str() {
                    "true" | "yes" | "да" => true,
                    "false" | "no" | "нет" => false,
                    _ => return Err("pinned: true или false".into()),
                })
            }
            "before" => out.before = Some(date(val).ok_or_else(|| format!("Не понял дату: {val}"))?),
            "after" => out.after = Some(date(val).ok_or_else(|| format!("Не понял дату: {val}"))?),
            "during" | "on" => out.during = Some(date(val).ok_or_else(|| format!("Не понял дату: {val}"))?),
            // неизвестный «ключ:» — обычный текст (например, время 12:30 или ссылка)
            _ => words(&tok, &mut out.words),
        }
    }
    Ok(out)
}

/// Слова для tsquery: только буквы и цифры (всё прочее — разделители), не больше 16 слов.
fn words(tok: &str, out: &mut Vec<String>) {
    for w in tok.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        if out.len() < 16 {
            out.push(w.to_lowercase());
        }
    }
}

impl Query {
    /// tsquery с префиксным поиском: «прив мир» → `прив:* & мир:*` (безопасно: только буквы/цифры).
    pub fn tsquery(&self) -> Option<String> {
        (!self.words.is_empty()).then(|| self.words.iter().map(|w| format!("{w}:*")).collect::<Vec<_>>().join(" & "))
    }
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
            && self.from.is_empty()
            && self.mentions.is_empty()
            && self.channels.is_empty()
            && self.has.is_empty()
            && self.pinned.is_none()
            && self.before.is_none()
            && self.after.is_none()
            && self.during.is_none()
    }
}

/// Полночь дня (y, m, d) в мс UTC с учётом смещения клиента (минуты к востоку от UTC).
pub fn day_start_ms((y, m, d): (i32, u32, u32), tz_minutes: i64) -> i64 {
    // days_from_civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86_400_000 - tz_minutes * 60_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_and_words() {
        let q = parse(r#"привет, мир! from:@vera in:#новости has:image pinned:true before:2026-02-01 after:15.01.2026"#).unwrap();
        assert_eq!(q.words, ["привет", "мир"]);
        assert_eq!(q.from, ["vera"]);
        assert_eq!(q.channels, ["новости"]);
        assert_eq!(q.has, [Has::Image]);
        assert_eq!(q.pinned, Some(true));
        assert_eq!(q.before, Some((2026, 2, 1)));
        assert_eq!(q.after, Some((2026, 1, 15)));
        assert_eq!(q.tsquery().unwrap(), "привет:* & мир:*");
    }

    #[test]
    fn quotes_and_unknown_keys() {
        let q = parse(r#"from:"Иван Петров" время 12:30 x:'); DROP"#).unwrap();
        assert_eq!(q.from, ["Иван Петров"]);
        assert_eq!(q.words, ["время", "12", "30", "x", "drop"]);
    }

    #[test]
    fn errors() {
        assert!(parse("has:банан").is_err());
        assert!(parse("before:вчера").is_err());
        assert!(parse("before:2026-13-01").is_err());
        assert!(parse("").unwrap().is_empty());
    }

    #[test]
    fn day_start() {
        assert_eq!(day_start_ms((1970, 1, 1), 0), 0);
        assert_eq!(day_start_ms((2026, 1, 1), 0), 1_767_225_600_000);
        assert_eq!(day_start_ms((2026, 1, 1), 180), 1_767_225_600_000 - 180 * 60_000);
        // Москва
    }
}

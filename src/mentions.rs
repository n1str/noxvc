//! Разбор упоминаний в тексте сообщения: <@id> — пользователь, <@&id> — роль, <#id> — канал,
//! @everyone / @here — все (действует только с правом MENTION_EVERYONE, проверяет вызывающий).
//! Внутри `кода` и ```блоков``` упоминания не считаются.

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub users: Vec<i64>,
    pub roles: Vec<i64>,
    pub channels: Vec<i64>,
    pub everyone: bool,
}

/// Текст без код-блоков и инлайн-кода (упоминания в коде — просто текст).
fn strip_code(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix("```") {
            match r.find("```") {
                Some(end) => {
                    rest = &r[end + 3..];
                    continue;
                }
                None => break,
            }
        }
        if let Some(r) = rest.strip_prefix('`') {
            if let Some(end) = r.find('`') {
                if !r[..end].contains('\n') {
                    rest = &r[end + 1..];
                    continue;
                }
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn push_unique(v: &mut Vec<i64>, id: i64) {
    if !v.contains(&id) && v.len() < 100 {
        v.push(id);
    }
}

pub fn parse(content: &str) -> Parsed {
    let text = strip_code(content);
    let mut p = Parsed::default();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            let (kind, start) = match (b.get(i + 1), b.get(i + 2)) {
                (Some(b'@'), Some(b'&')) => ('r', i + 3),
                (Some(b'@'), _) => ('u', i + 2),
                (Some(b'#'), _) => ('c', i + 2),
                _ => (' ', i),
            };
            if kind != ' ' {
                let mut j = start;
                while j < b.len() && b[j].is_ascii_digit() && j - start < 19 {
                    j += 1;
                }
                if j > start && b.get(j) == Some(&b'>') {
                    if let Ok(id) = text[start..j].parse::<i64>() {
                        match kind {
                            'u' => push_unique(&mut p.users, id),
                            'r' => push_unique(&mut p.roles, id),
                            _ => push_unique(&mut p.channels, id),
                        }
                    }
                    i = j + 1;
                    continue;
                }
            }
        }
        if b[i] == b'@' && (text[i..].starts_with("@everyone") || text[i..].starts_with("@here")) {
            let prev_ok = i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
            if prev_ok {
                p.everyone = true;
            }
        }
        i += 1;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        let p = parse("привет <@12> и <@&5>, загляни в <#7>; ещё раз <@12>");
        assert_eq!(p.users, vec![12]);
        assert_eq!(p.roles, vec![5]);
        assert_eq!(p.channels, vec![7]);
        assert!(!p.everyone);
    }

    #[test]
    fn everyone_and_here() {
        assert!(parse("@everyone внимание").everyone);
        assert!(parse("всем @here").everyone);
        assert!(!parse("mail@everyone.com").everyone, "часть слова — не упоминание");
    }

    #[test]
    fn code_is_ignored() {
        let p = parse("`<@1>` и ```\n@everyone <@&2>\n``` но <@3>");
        assert_eq!(p.users, vec![3]);
        assert!(p.roles.is_empty());
        assert!(!p.everyone);
    }

    #[test]
    fn malformed() {
        let p = parse("<@> <@abc> <@12 <#> <@&> <@99999999999999999999999>");
        assert_eq!(p, Parsed::default());
    }
}

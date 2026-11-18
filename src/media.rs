//! Проверка медиафайлов по содержимому (не по расширению и не по MIME из запроса):
//! тип — по сигнатуре, размеры/кадры/длительность — из заголовков, без декодирования.
//! Так файл-«бомба» (огромное разрешение, тысячи кадров) отклоняется до того, как его кто-то начнёт декодировать.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Mp4,
    Webm,
}

impl Kind {
    pub fn ext(self) -> &'static [&'static str] {
        match self {
            Kind::Png => &["png"],
            Kind::Jpeg => &["jpg", "jpeg"],
            Kind::Gif => &["gif"],
            Kind::Webp => &["webp"],
            Kind::Mp4 => &["mp4"],
            Kind::Webm => &["webm"],
        }
    }
    pub fn is_video(self) -> bool {
        matches!(self, Kind::Mp4 | Kind::Webm)
    }
    /** Демуксер ffmpeg — явно, по типу из содержимого (ffmpeg не угадывает формат сам: никаких плейлистов/URL). */
    pub fn demuxer(self, frames: u32) -> &'static str {
        match self {
            Kind::Png if frames > 1 => "apng",
            Kind::Png => "png_pipe",
            Kind::Jpeg => "jpeg_pipe",
            Kind::Webp => "webp_pipe",
            Kind::Gif => "gif",
            Kind::Mp4 => "mov",
            Kind::Webm => "matroska",
        }
    }
}

/// Ориентация из EXIF у JPEG (1 — как есть; 2–8 — отражения/повороты). Браузер её применяет при показе,
/// ffmpeg — нет, поэтому перед кадрированием поворачиваем сами.
pub fn jpeg_orientation(b: &[u8]) -> u8 {
    let mut i = 2;
    while i + 4 <= b.len() && b[i] == 0xFF {
        let m = b[i + 1];
        let Some(len) = be16(b, i + 2).map(|l| l as usize) else { break };
        if m == 0xDA || m == 0xD9 {
            break;
        }
        if m == 0xE1 && b.get(i + 4..i + 10) == Some(b"Exif\0\0") {
            let t = i + 10;
            let le = b.get(t..t + 2) == Some(b"II");
            let u16_ = |o: usize| b.get(t + o..t + o + 2).map(|x| if le { u16::from_le_bytes([x[0], x[1]]) } else { u16::from_be_bytes([x[0], x[1]]) });
            let u32_ = |o: usize| {
                b.get(t + o..t + o + 4).map(|x| if le { u32::from_le_bytes([x[0], x[1], x[2], x[3]]) } else { u32::from_be_bytes([x[0], x[1], x[2], x[3]]) })
            };
            let Some(ifd) = u32_(4).map(|x| x as usize) else { return 1 };
            let n = u16_(ifd).unwrap_or(0) as usize;
            for k in 0..n.min(64) {
                let e = ifd + 2 + k * 12;
                if u16_(e) == Some(0x0112) {
                    return u16_(e + 8).filter(|o| (1..=8).contains(o)).unwrap_or(1) as u8;
                }
            }
            return 1;
        }
        i += 2 + len;
    }
    1
}

/// JPEG без метаданных (вложения отдаются как загружены — без этого в них остались бы EXIF с GPS, модель камеры,
/// XMP, IPTC, комментарии): убираются сегменты APP1–APP15 и COM до начала скана; ориентация сохраняется
/// минимальным EXIF (одно поле), чтобы фото не повернулось. Не JPEG или битый файл — как есть.
pub fn strip_jpeg_metadata(b: &[u8]) -> Vec<u8> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return b.to_vec();
    }
    let orientation = jpeg_orientation(b);
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(&b[..2]);
    if orientation > 1 {
        // APP1 "Exif\0\0" + TIFF (big-endian) + IFD0 с одной записью Orientation (SHORT)
        let mut tiff: Vec<u8> = b"MM\0\x2A\0\0\0\x08".to_vec();
        tiff.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
        let len = (2 + 6 + tiff.len()) as u16;
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(&tiff);
    }
    let mut i = 2;
    while i + 4 <= b.len() && b[i] == 0xFF {
        let m = b[i + 1];
        if m == 0xDA {
            out.extend_from_slice(&b[i..]);
            return out;
        } // начало скана — дальше данные изображения
        let Some(len) = be16(b, i + 2).map(|l| l as usize) else { return b.to_vec() };
        if len < 2 || i + 2 + len > b.len() {
            return b.to_vec();
        }
        let metadata = (0xE1..=0xEF).contains(&m) || m == 0xFE;
        if !metadata {
            out.extend_from_slice(&b[i..i + 2 + len]);
        }
        i += 2 + len;
    }
    b.to_vec()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Info {
    pub width: u32,
    pub height: u32,
    /// Кадров (картинки); 1 — статичная.
    pub frames: u32,
    /// Длительность видео, мс (0 — неизвестна или не видео).
    pub duration_ms: u64,
    pub has_audio: bool,
}

impl Info {
    pub fn animated(&self, kind: Kind) -> bool {
        kind.is_video() || self.frames > 1
    }
}

/// Тип по сигнатуре.
pub fn sniff(b: &[u8]) -> Option<Kind> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(Kind::Png);
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(Kind::Jpeg);
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(Kind::Gif);
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(Kind::Webp);
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        // ISO BMFF: mp4/m4v/isom и т.п.; HEIC/AVIF (картинки) и QuickTime не принимаем
        let brand = &b[8..12];
        if !matches!(brand, b"heic" | b"heix" | b"mif1" | b"msf1" | b"avif" | b"avis" | b"qt  ") {
            return Some(Kind::Mp4);
        }
    }
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) && ebml_doctype(b).as_deref() == Some("webm") {
        return Some(Kind::Webm);
    }
    None
}

/// Разобрать заголовки. Ошибка — файл повреждён или не того формата.
pub fn inspect(kind: Kind, b: &[u8]) -> Result<Info, &'static str> {
    match kind {
        Kind::Png => png(b),
        Kind::Jpeg => jpeg(b),
        Kind::Gif => gif(b),
        Kind::Webp => webp(b),
        Kind::Mp4 => mp4(b),
        Kind::Webm => webm(b),
    }
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32)
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], i: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(i..i + 8)?.try_into().ok()?))
}
fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32)
}
fn le24(b: &[u8], i: usize) -> Option<u32> {
    let s = b.get(i..i + 3)?;
    Some(s[0] as u32 | (s[1] as u32) << 8 | (s[2] as u32) << 16)
}
fn le32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

const BAD: &str = "повреждённый файл";

// ---------- PNG (+APNG: число кадров из acTL) ----------
fn png(b: &[u8]) -> Result<Info, &'static str> {
    if b.get(12..16) != Some(b"IHDR") {
        return Err(BAD);
    }
    let mut info = Info { width: be32(b, 16).ok_or(BAD)?, height: be32(b, 20).ok_or(BAD)?, frames: 1, ..Default::default() };
    let mut i = 8;
    while let (Some(len), Some(t)) = (be32(b, i), b.get(i + 4..i + 8)) {
        if t == b"acTL" {
            info.frames = be32(b, i + 8).ok_or(BAD)?.max(1);
        }
        if t == b"IDAT" || t == b"IEND" {
            break;
        } // acTL обязан стоять до IDAT
        i = i.checked_add(12 + len as usize).ok_or(BAD)?;
    }
    Ok(info)
}

// ---------- JPEG: размеры из SOFn ----------
fn jpeg(b: &[u8]) -> Result<Info, &'static str> {
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return Err(BAD);
        }
        let m = b[i + 1];
        if m == 0xFF {
            i += 1;
            continue;
        } // заполнитель
        if m == 0xD8 || (0xD0..=0xD7).contains(&m) || m == 0x01 {
            i += 2;
            continue;
        }
        let len = be16(b, i + 2).ok_or(BAD)? as usize;
        if (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
            return Ok(Info { height: be16(b, i + 5).ok_or(BAD)?, width: be16(b, i + 7).ok_or(BAD)?, frames: 1, ..Default::default() });
        }
        if m == 0xDA || m == 0xD9 {
            break;
        } // данные пошли, а SOF не было
        i += 2 + len;
    }
    Err(BAD)
}

// ---------- GIF: экран + каждый кадр (размер кадра тоже ограничиваем) ----------
fn gif(b: &[u8]) -> Result<Info, &'static str> {
    let mut info = Info { width: le16(b, 6).ok_or(BAD)?, height: le16(b, 8).ok_or(BAD)?, ..Default::default() };
    let flags = *b.get(10).ok_or(BAD)?;
    let mut i = 13;
    if flags & 0x80 != 0 {
        i += 3 << ((flags & 7) + 1);
    }
    let skip_sub = |mut i: usize| -> Result<usize, &'static str> {
        loop {
            let n = *b.get(i).ok_or(BAD)? as usize;
            i += 1 + n;
            if n == 0 {
                return Ok(i);
            }
        }
    };
    loop {
        match b.get(i) {
            Some(0x3B) | None => break, // конец (обрезанный файл тоже считаем по уже найденным кадрам)
            Some(0x21) => i = skip_sub(i + 2)?,
            Some(0x2C) => {
                let (w, h) = (le16(b, i + 5).ok_or(BAD)?, le16(b, i + 7).ok_or(BAD)?);
                info.width = info.width.max(w);
                info.height = info.height.max(h);
                let f = *b.get(i + 9).ok_or(BAD)?;
                i += 10;
                if f & 0x80 != 0 {
                    i += 3 << ((f & 7) + 1);
                }
                i = skip_sub(i + 1)?; // минимальный размер кода LZW + данные
                info.frames += 1;
            }
            _ => return Err(BAD),
        }
    }
    if info.frames == 0 {
        return Err(BAD);
    }
    Ok(info)
}

// ---------- WebP: VP8 / VP8L / VP8X (+ANMF — кадры анимации) ----------
fn webp(b: &[u8]) -> Result<Info, &'static str> {
    let t = b.get(12..16).ok_or(BAD)?;
    match t {
        b"VP8 " => Ok(Info { width: le16(b, 26).ok_or(BAD)? & 0x3FFF, height: le16(b, 28).ok_or(BAD)? & 0x3FFF, frames: 1, ..Default::default() }),
        b"VP8L" => {
            let v = le32(b, 21).ok_or(BAD)?;
            Ok(Info { width: (v & 0x3FFF) + 1, height: ((v >> 14) & 0x3FFF) + 1, frames: 1, ..Default::default() })
        }
        b"VP8X" => {
            let mut info = Info { width: le24(b, 24).ok_or(BAD)? + 1, height: le24(b, 27).ok_or(BAD)? + 1, frames: 0, ..Default::default() };
            let mut i = 12;
            while let (Some(c), Some(len)) = (b.get(i..i + 4), le32(b, i + 4)) {
                if c == b"ANMF" {
                    info.frames += 1;
                    info.width = info.width.max(le24(b, i + 14).ok_or(BAD)? + 1);
                    info.height = info.height.max(le24(b, i + 17).ok_or(BAD)? + 1);
                }
                i = i.checked_add(8 + len as usize + (len as usize & 1)).ok_or(BAD)?;
            }
            info.frames = info.frames.max(1);
            Ok(info)
        }
        _ => Err(BAD),
    }
}

// ---------- MP4 (ISO BMFF): moov/mvhd — длительность, trak/tkhd — размеры, hdlr — есть ли звук ----------
fn boxes(b: &[u8], mut f: impl FnMut(&[u8; 4], &[u8]) -> Result<(), &'static str>) -> Result<(), &'static str> {
    let mut i = 0;
    while i + 8 <= b.len() {
        let size = be32(b, i).ok_or(BAD)? as u64;
        let t: [u8; 4] = b[i + 4..i + 8].try_into().map_err(|_| BAD)?;
        let (hdr, size) = match size {
            1 => (16, be64(b, i + 8).ok_or(BAD)?),
            0 => (8, (b.len() - i) as u64),
            s => (8, s),
        };
        if size < hdr as u64 {
            return Err(BAD);
        }
        let end = i.checked_add(size as usize).ok_or(BAD)?.min(b.len()); // обрезанный «mdat» в конце — не ошибка
        f(&t, &b[i + hdr..end])?;
        i = end;
    }
    Ok(())
}

fn mp4(b: &[u8]) -> Result<Info, &'static str> {
    let mut info = Info { frames: 1, ..Default::default() };
    let mut found_moov = false;
    boxes(b, |t, moov| {
        if t != b"moov" {
            return Ok(());
        }
        found_moov = true;
        boxes(moov, |t, body| {
            if t == b"mvhd" {
                let (scale, dur) = if body.first() == Some(&1) { (be32(body, 20), be64(body, 24)) } else { (be32(body, 12), be32(body, 16).map(u64::from)) };
                if let (Some(s), Some(d)) = (scale, dur) {
                    if s > 0 {
                        info.duration_ms = d.saturating_mul(1000) / s as u64;
                    }
                }
            }
            if t == b"trak" {
                let (mut w, mut h, mut handler) = (0, 0, [0u8; 4]);
                boxes(body, |t, x| {
                    if t == b"tkhd" {
                        let off = if x.first() == Some(&1) { 88 } else { 76 };
                        w = be32(x, off).unwrap_or(0) >> 16;
                        h = be32(x, off + 4).unwrap_or(0) >> 16;
                    }
                    if t == b"mdia" {
                        boxes(x, |t, y| {
                            if t == b"hdlr" {
                                if let Some(s) = y.get(8..12) {
                                    handler.copy_from_slice(s);
                                }
                            }
                            Ok(())
                        })?;
                    }
                    Ok(())
                })?;
                match &handler {
                    b"vide" => {
                        info.width = info.width.max(w);
                        info.height = info.height.max(h);
                    }
                    b"soun" => info.has_audio = true,
                    _ => {}
                }
            }
            Ok(())
        })
    })?;
    if !found_moov || info.width == 0 || info.height == 0 {
        return Err("видео без дорожки изображения (или moov в конце обрезанного файла)");
    }
    Ok(info)
}

// ---------- WebM (EBML/Matroska): Info/Duration, Tracks/TrackEntry/Video/PixelWidth,PixelHeight ----------
/// (id, длина заголовка, размер данных; None — «неизвестный размер»)
fn ebml_el(b: &[u8], i: usize) -> Option<(u32, usize, Option<u64>)> {
    let vint = |i: usize, keep_marker: bool| -> Option<(u64, usize, bool)> {
        let first = *b.get(i)?;
        let len = first.leading_zeros() as usize + 1;
        if len > 8 {
            return None;
        }
        let mut v = if keep_marker { first as u64 } else { (first as u64) & (0xFF >> len) };
        let mut all_ones = v == (0xFF >> len) as u64;
        for k in 1..len {
            let x = *b.get(i + k)?;
            all_ones &= x == 0xFF;
            v = (v << 8) | x as u64;
        }
        Some((v, len, all_ones))
    };
    let (id, il, _) = vint(i, true)?;
    let (size, sl, unknown) = vint(i + il, false)?;
    Some((id as u32, il + sl, if unknown { None } else { Some(size) }))
}

fn ebml_uint(d: &[u8]) -> u64 {
    d.iter().take(8).fold(0, |a, &x| (a << 8) | x as u64)
}

fn ebml_doctype(b: &[u8]) -> Option<String> {
    let (id, hl, size) = ebml_el(b, 0)?;
    if id != 0x1A45DFA3 {
        return None;
    }
    let end = (hl + size? as usize).min(b.len());
    let mut i = hl;
    while i < end {
        let (id, hl, size) = ebml_el(b, i)?;
        let size = size? as usize;
        if id == 0x4282 {
            return Some(String::from_utf8_lossy(b.get(i + hl..i + hl + size)?).trim_end_matches('\0').to_string());
        }
        i += hl + size;
    }
    None
}

fn webm(b: &[u8]) -> Result<Info, &'static str> {
    let mut info = Info { frames: 1, ..Default::default() };
    let (mut scale, mut duration) = (1_000_000u64, 0f64);
    // Идём по элементам; в контейнеры (Segment, Info, Tracks, TrackEntry, Video) заходим, прочее пропускаем.
    // Кластеры (сами кадры) не читаем: дорожки и Info стоят до них.
    fn walk(
        b: &[u8],
        mut i: usize,
        end: usize,
        depth: u32,
        info: &mut Info,
        scale: &mut u64,
        duration: &mut f64,
        track: &mut (u64, u32, u32),
    ) -> Result<(), &'static str> {
        if depth > 8 {
            return Err(BAD);
        }
        while i < end {
            let Some((id, hl, size)) = ebml_el(b, i) else { break };
            let data_end = match size {
                Some(s) => i.checked_add(hl).and_then(|x| x.checked_add(s as usize)).ok_or(BAD)?.min(end),
                None => end,
            };
            let d = b.get(i + hl..data_end).ok_or(BAD)?;
            match id {
                0x1F43B675 => break, // Cluster
                0x18538067 | 0x1549A966 | 0x1654AE6B | 0xE0 => walk(b, i + hl, data_end, depth + 1, info, scale, duration, track)?,
                0xAE => {
                    let mut tr = (0, 0, 0);
                    walk(b, i + hl, data_end, depth + 1, info, scale, duration, &mut tr)?;
                    match tr.0 {
                        1 => {
                            info.width = info.width.max(tr.1);
                            info.height = info.height.max(tr.2);
                        }
                        2 => info.has_audio = true,
                        _ => {}
                    }
                }
                0x83 => track.0 = ebml_uint(d),
                0xB0 => track.1 = ebml_uint(d).min(u32::MAX as u64) as u32,
                0xBA => track.2 = ebml_uint(d).min(u32::MAX as u64) as u32,
                0x2AD7B1 => *scale = ebml_uint(d).max(1),
                0x4489 => {
                    *duration = match d.len() {
                        4 => f32::from_be_bytes(d.try_into().unwrap_or_default()) as f64,
                        8 => f64::from_be_bytes(d.try_into().unwrap_or_default()),
                        _ => 0.0,
                    }
                }
                _ => {}
            }
            if size.is_none() {
                break;
            }
            i = data_end;
        }
        Ok(())
    }
    let mut tr = (0, 0, 0);
    walk(b, 0, b.len(), 0, &mut info, &mut scale, &mut duration, &mut tr)?;
    if info.width == 0 || info.height == 0 {
        return Err("видео без дорожки изображения");
    }
    if duration.is_finite() && duration > 0.0 {
        info.duration_ms = (duration * scale as f64 / 1_000_000.0) as u64;
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(w: u32, h: u32, actl: Option<u32>) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        let chunk = |b: &mut Vec<u8>, t: &[u8], d: &[u8]| {
            b.extend((d.len() as u32).to_be_bytes());
            b.extend(t);
            b.extend(d);
            b.extend([0; 4]);
        };
        let mut ihdr = w.to_be_bytes().to_vec();
        ihdr.extend(h.to_be_bytes());
        ihdr.extend([8, 6, 0, 0, 0]);
        chunk(&mut b, b"IHDR", &ihdr);
        if let Some(n) = actl {
            let mut a = n.to_be_bytes().to_vec();
            a.extend(0u32.to_be_bytes());
            chunk(&mut b, b"acTL", &a);
        }
        chunk(&mut b, b"IDAT", &[0; 4]);
        chunk(&mut b, b"IEND", &[]);
        b
    }

    fn gif_bytes(w: u16, h: u16, frames: usize) -> Vec<u8> {
        let mut b = b"GIF89a".to_vec();
        b.extend(w.to_le_bytes());
        b.extend(h.to_le_bytes());
        b.extend([0x80, 0, 0]);
        b.extend([0; 6]); // глобальная палитра 2 цвета
        b.extend([0x21, 0xFF, 11]);
        b.extend(b"NETSCAPE2.0");
        b.extend([3, 1, 0, 0, 0]);
        for _ in 0..frames {
            b.extend([0x21, 0xF9, 4, 0, 10, 0, 0, 0]);
            b.push(0x2C);
            b.extend([0; 4]);
            b.extend(w.to_le_bytes());
            b.extend(h.to_le_bytes());
            b.push(0);
            b.extend([2, 2, 0x4C, 0x01, 0]);
        }
        b.push(0x3B);
        b
    }

    #[test]
    fn sniff_types() {
        assert_eq!(sniff(&png_bytes(1, 1, None)), Some(Kind::Png));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(Kind::Jpeg));
        assert_eq!(sniff(&gif_bytes(1, 1, 1)), Some(Kind::Gif));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(Kind::Webp));
        assert_eq!(sniff(b"\0\0\0\x18ftypisom\0\0\0\0"), Some(Kind::Mp4));
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0\0\0"), None);
        assert_eq!(sniff(b"<html><script>"), None);
        assert_eq!(sniff(b"MZ\x90\0"), None);
    }

    #[test]
    fn png_dims_and_apng() {
        assert_eq!(inspect(Kind::Png, &png_bytes(1500, 500, None)).unwrap(), Info { width: 1500, height: 500, frames: 1, ..Default::default() });
        assert_eq!(inspect(Kind::Png, &png_bytes(10, 10, Some(42))).unwrap().frames, 42);
        assert_eq!(inspect(Kind::Png, &png_bytes(100_000, 100_000, None)).unwrap().width, 100_000);
        // «бомба» видна по заголовку
    }

    #[test]
    fn gif_frames() {
        let i = inspect(Kind::Gif, &gif_bytes(300, 100, 7)).unwrap();
        assert_eq!((i.width, i.height, i.frames), (300, 100, 7));
        assert!(i.animated(Kind::Gif));
        assert!(!inspect(Kind::Gif, &gif_bytes(3, 3, 1)).unwrap().animated(Kind::Gif));
        assert!(inspect(Kind::Gif, b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x3B").is_err());
        // без кадров
    }

    #[test]
    fn jpeg_sof() {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8];
        b.extend(480u16.to_be_bytes());
        b.extend(1440u16.to_be_bytes());
        b.extend([1, 1, 0x11, 0]);
        assert_eq!(inspect(Kind::Jpeg, &b).unwrap(), Info { width: 1440, height: 480, frames: 1, ..Default::default() });
    }

    #[test]
    fn webp_variants() {
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        vp8x.extend(10u32.to_le_bytes());
        vp8x.extend([0x02, 0, 0, 0]);
        vp8x.extend([0xDB, 0x05, 0]);
        vp8x.extend([0xF3, 0x01, 0]); // 1500×500
        for _ in 0..3 {
            vp8x.extend(b"ANMF");
            vp8x.extend(16u32.to_le_bytes());
            vp8x.extend([0; 6]);
            vp8x.extend([0xDB, 0x05, 0, 0xF3, 0x01, 0]);
            vp8x.extend([0; 4]);
        }
        let i = inspect(Kind::Webp, &vp8x).unwrap();
        assert_eq!((i.width, i.height, i.frames), (1500, 500, 3));
    }

    fn ebml(id: &[u8], data: &[u8]) -> Vec<u8> {
        let mut v = id.to_vec();
        v.push(0x80 | data.len() as u8);
        v.extend(data);
        v
    }
    fn ebml8(id: &[u8], data: &[u8]) -> Vec<u8> {
        let mut v = id.to_vec();
        v.push(0x01);
        v.extend((data.len() as u64).to_be_bytes()[1..].iter());
        v.extend(data);
        v
    }

    #[test]
    fn webm_tracks() {
        let header = ebml(&[0x1A, 0x45, 0xDF, 0xA3], &ebml(&[0x42, 0x82], b"webm"));
        let info = ebml(&[0x15, 0x49, 0xA9, 0x66], &[ebml(&[0x2A, 0xD7, 0xB1], &[0x0F, 0x42, 0x40]), ebml(&[0x44, 0x89], &5000f32.to_be_bytes())].concat());
        let video = ebml(&[0xAE], &[ebml(&[0x83], &[1]), ebml(&[0xE0], &[ebml(&[0xB0], &[0x07, 0x80]), ebml(&[0xBA], &[0x02, 0x80])].concat())].concat());
        let audio = ebml(&[0xAE], &ebml(&[0x83], &[2]));
        let tracks = ebml(&[0x16, 0x54, 0xAE, 0x6B], &[video, audio].concat());
        let mut seg = vec![0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; // неизвестный размер
        seg.extend(info);
        seg.extend(tracks);
        seg.extend(ebml8(&[0x1F, 0x43, 0xB6, 0x75], &[0; 4]));
        let b = [header, seg].concat();
        assert_eq!(sniff(&b), Some(Kind::Webm));
        let i = inspect(Kind::Webm, &b).unwrap();
        assert_eq!((i.width, i.height, i.duration_ms, i.has_audio), (1920, 640, 5000, true));
    }

    #[test]
    fn mp4_boxes() {
        let bx = |t: &[u8], d: &[u8]| {
            let mut v = ((d.len() + 8) as u32).to_be_bytes().to_vec();
            v.extend(t);
            v.extend(d);
            v
        };
        let mut mvhd = vec![0; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&8000u32.to_be_bytes());
        let mut tkhd = vec![0; 84];
        tkhd[76..80].copy_from_slice(&(1280u32 << 16).to_be_bytes());
        tkhd[80..84].copy_from_slice(&(720u32 << 16).to_be_bytes());
        let mut hdlr = vec![0; 24];
        hdlr[8..12].copy_from_slice(b"vide");
        let trak = bx(b"trak", &[bx(b"tkhd", &tkhd), bx(b"mdia", &bx(b"hdlr", &hdlr))].concat());
        let b = [bx(b"ftyp", b"isom\0\0\0\0"), bx(b"moov", &[bx(b"mvhd", &mvhd), trak].concat()), bx(b"mdat", &[0; 16])].concat();
        assert_eq!(sniff(&b), Some(Kind::Mp4));
        let i = inspect(Kind::Mp4, &b).unwrap();
        assert_eq!((i.width, i.height, i.duration_ms, i.has_audio), (1280, 720, 8000, false));
    }

    #[test]
    fn strips_jpeg_metadata_keeps_orientation() {
        // SOI, APP1 Exif (ориентация 6 + «GPS»-мусор), COM, DQT, SOS + данные
        let mut exif: Vec<u8> = b"Exif  MM *   ".to_vec();
        exif.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
        exif.extend_from_slice(b"GPS 55.75N 37.61E secret");
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE1];
        j.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        j.extend_from_slice(&exif);
        j.extend_from_slice(&[0xFF, 0xFE, 0, 6, b'c', b'a', b'm', b'!']);
        j.extend_from_slice(&[0xFF, 0xDB, 0, 4, 1, 2, 0xFF, 0xDA, 0, 2, 9, 9, 9, 0xFF, 0xD9]);
        assert_eq!(jpeg_orientation(&j), 6);
        let out = strip_jpeg_metadata(&j);
        assert!(!out.windows(3).any(|w| w == b"GPS") && !out.windows(4).any(|w| w == b"cam!"), "метаданные убраны");
        assert_eq!(jpeg_orientation(&out), 6, "ориентация сохранена");
        assert!(out.ends_with(&[0xFF, 0xDB, 0, 4, 1, 2, 0xFF, 0xDA, 0, 2, 9, 9, 9, 0xFF, 0xD9]), "таблицы и скан не тронуты");
        assert_eq!(strip_jpeg_metadata(b"not a jpeg"), b"not a jpeg");
    }
    #[test]
    fn exif_orientation() {
        // JPEG: SOI, APP1 Exif (big-endian, IFD0 с одной записью Orientation=6)
        let mut tiff = b"MM\0*\0\0\0\x08".to_vec();
        tiff.extend([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(&tiff);
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE1];
        b.extend(((app1.len() + 2) as u16).to_be_bytes());
        b.extend(app1);
        b.extend([0xFF, 0xD9]);
        assert_eq!(jpeg_orientation(&b), 6);
        assert_eq!(jpeg_orientation(&[0xFF, 0xD8, 0xFF, 0xD9]), 1);
        assert_eq!(jpeg_orientation(b"garbage"), 1);
    }

    #[test]
    fn garbage_is_rejected_not_panicking() {
        for k in [Kind::Png, Kind::Jpeg, Kind::Gif, Kind::Webp, Kind::Mp4, Kind::Webm] {
            for junk in [&b""[..], b"\xFF", b"GIF89a", b"RIFF\0\0\0\0WEBPVP8X", b"\0\0\0\x01ftyp", &[0x1A, 0x45, 0xDF, 0xA3, 0x01, 0xFF]] {
                let _ = inspect(k, junk);
            }
        }
    }
}

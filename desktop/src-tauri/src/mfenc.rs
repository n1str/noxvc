//! Аппаратный H.264 через Media Foundation: NVIDIA NVENC, AMD AMF, Intel Quick Sync — драйвер видеокарты
//! регистрирует свой кодировщик (MFT), Windows отдаёт его по запросу. Кадры (NV12) не покидают видеокарту.
//!
//! Под WebRTC: без B-кадров, режим низкой задержки, постоянный битрейт (его меняет оценка канала),
//! ключевой кадр по запросу (новый зритель, потери). Аппаратные MFT асинхронные: вход и выход — по событиям.

use crate::gpu::{Gpu, WinResult};
use std::mem::ManuallyDrop;
use windows::core::{Interface, GUID, PWSTR};
use windows::Win32::Foundation::VARIANT_BOOL;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4};

pub struct Encoded {
    pub data: Vec<u8>,
    pub key: bool,
    pub ts_us: i64,
}

pub struct Encoder {
    activate: IMFActivate,
    mft: IMFTransform,
    events: IMFMediaEventGenerator,
    codec: Option<ICodecAPI>,
    _mgr: IMFDXGIDeviceManager,
    need_input: u32,
    provides_samples: bool,
    out_size: u32,
    fps: u32,
    bitrate: u32,
    seq_header: Vec<u8>,
    /// Запрошен ключевой кадр и ещё не получен (с какого момента).
    key_pending: Option<std::time::Instant>,
    /// Сколько ждали последний запрошенный ключевой кадр (для журнала).
    pub key_latency: Option<std::time::Duration>,
    pub name: String,
}
unsafe impl Send for Encoder {}

fn var_u32(v: u32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt: VT_UI4, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: VARIANT_0_0_0 { ulVal: v } }),
        },
    }
}
fn var_bool(v: bool) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_BOOL,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { boolVal: VARIANT_BOOL(if v { -1 } else { 0 }) },
            }),
        },
    }
}
const fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

/// Аппаратные кодировщики H.264 на видеокарте устройства `gpu` (по LUID адаптера).
fn enumerate(gpu: &Gpu) -> WinResult<Vec<IMFActivate>> {
    unsafe {
        let dxgi: IDXGIDevice = gpu.device.cast()?;
        let luid = dxgi.GetAdapter()?.GetDesc()?.AdapterLuid;
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.unwrap();
        let bytes = std::slice::from_raw_parts(&luid as *const _ as *const u8, std::mem::size_of_val(&luid));
        attrs.SetBlob(&MFT_ENUM_ADAPTER_LUID, bytes)?;
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut pp: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut n = 0u32;
        MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &attrs, &mut pp, &mut n)?;
        let mut out = vec![];
        for i in 0..n as usize {
            if let Some(a) = (*pp.add(i)).take() {
                out.push(a);
            }
        }
        if !pp.is_null() {
            CoTaskMemFree(Some(pp as _));
        }
        Ok(out)
    }
}

fn friendly_name(a: &IMFActivate) -> String {
    unsafe {
        let mut p = PWSTR::null();
        let mut len = 0;
        if a.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut p, &mut len).is_ok() && !p.is_null() {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as _));
            return s;
        }
    }
    "H.264 (видеокарта)".into()
}

impl Encoder {
    /// Первый кодировщик видеокарты, который согласился на наши параметры.
    pub fn new(gpu: &Gpu, w: u32, h: u32, fps: u32, kbps: u32) -> Result<Self, String> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| format!("Media Foundation: {e}"))? };
        let list = enumerate(gpu).map_err(|e| format!("поиск кодировщика: {e}"))?;
        if list.is_empty() {
            return Err("на видеокарте нет аппаратного кодировщика H.264".into());
        }
        let mut last = String::new();
        for a in list {
            match Self::open(gpu, a, w, h, fps, kbps) {
                Ok(e) => return Ok(e),
                Err(e) => last = e.to_string(),
            }
        }
        Err(format!("кодировщик видеокарты не запустился: {last}"))
    }

    fn open(gpu: &Gpu, activate: IMFActivate, w: u32, h: u32, fps: u32, kbps: u32) -> WinResult<Self> {
        unsafe {
            let name = friendly_name(&activate);
            let mft: IMFTransform = activate.ActivateObject()?;
            let attrs = mft.GetAttributes()?;
            if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1 {
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            }
            let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);

            let mut token = 0u32;
            let mut mgr = None;
            MFCreateDXGIDeviceManager(&mut token, &mut mgr)?;
            let mgr = mgr.unwrap();
            mgr.ResetDevice(&gpu.device, token)?;
            mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize)?;

            let bitrate = kbps * 1000;
            let codec: Option<ICodecAPI> = mft.cast().ok();
            if let Some(c) = &codec {
                // До выбора форматов: часть драйверов (NVIDIA) иначе игнорирует GOP и режим битрейта.
                // Всё — по возможности: не каждый драйвер поддерживает каждую настройку.
                let _ = c.SetValue(&CODECAPI_AVEncCommonRateControlMode, &var_u32(eAVEncCommonRateControlMode_CBR.0 as u32));
                let _ = c.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(bitrate));
                let _ = c.SetValue(&CODECAPI_AVLowLatencyMode, &var_bool(true));
                let _ = c.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &var_u32(0));
                // Ключевой кадр раз в 3 с — страховка: даже если запрос ключевого кадра потеряется,
                // картинка у зрителя восстановится сама (раньше было 10 с — «зависание» после потерь).
                let _ = c.SetValue(&CODECAPI_AVEncMPVGOPSize, &var_u32(fps * 3));
                let _ = c.SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &var_u32(70));
            }
            let out = MFCreateMediaType()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
            out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            let _ = out.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps * 3);
            mft.SetOutputType(0, &out, 0)?;

            let inp = MFCreateMediaType()?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            inp.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601.0 as u32)?;
            inp.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            mft.SetInputType(0, &inp, 0)?;

            let info = mft.GetOutputStreamInfo(0)?;
            let provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            let events: IMFMediaEventGenerator = mft.cast()?;
            let seq_header = mft.GetOutputCurrentType(0).ok().and_then(|t| blob(&t, &MF_MT_MPEG_SEQUENCE_HEADER)).unwrap_or_default();
            Ok(Self {
                activate,
                mft,
                events,
                codec,
                _mgr: mgr,
                need_input: 0,
                provides_samples,
                out_size: info.cbSize.max(1 << 20),
                fps,
                bitrate,
                seq_header,
                key_pending: None,
                key_latency: None,
                name,
            })
        }
    }

    /// Следующий кадр — ключевой (новый зритель, потери, смена слоя).
    pub fn force_key(&mut self) {
        // RELAY_SHARE_IGNORE_KEYREQ — проверка запасного пути: драйвер, который молча игнорирует запрос.
        if std::env::var_os("RELAY_SHARE_IGNORE_KEYREQ").is_none() {
            if let Some(c) = &self.codec {
                unsafe {
                    let _ = c.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &var_u32(1));
                }
            }
        }
        if self.key_pending.is_none() {
            self.key_pending = Some(std::time::Instant::now());
        }
    }

    /// Кодировщик не выдал запрошенный ключевой кадр за 0,5 с — его надо перезапустить
    /// (некоторые драйверы молча игнорируют запрос; без ключевого кадра зритель видит «замёрзший» кадр и блоки).
    pub fn key_stuck(&self) -> bool {
        self.key_pending.is_some_and(|t| t.elapsed() > std::time::Duration::from_millis(500))
    }

    /// Новый битрейт от оценки канала WebRTC (меняем только при заметной разнице).
    pub fn set_bitrate(&mut self, bps: u32) {
        if (bps as f64 - self.bitrate as f64).abs() < self.bitrate as f64 * 0.05 {
            return;
        }
        if let Some(c) = &self.codec {
            unsafe {
                if c.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(bps)).is_ok() {
                    self.bitrate = bps;
                }
            }
        }
    }
    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    /// Отдать кадр (если кодировщик готов принять) и забрать всё, что уже закодировано.
    /// Возвращает `false` во втором значении, если кадр пропущен (кодировщик занят).
    pub fn encode(&mut self, nv12: &ID3D11Texture2D, ts_us: i64) -> WinResult<(Vec<Encoded>, bool)> {
        let mut out = vec![];
        self.drain(&mut out)?;
        let mut taken = false;
        if self.need_input > 0 {
            unsafe {
                let buf = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buf)?;
                sample.SetSampleTime(ts_us * 10)?;
                sample.SetSampleDuration(10_000_000 / self.fps.max(1) as i64)?;
                self.mft.ProcessInput(0, &sample, 0)?;
            }
            self.need_input -= 1;
            taken = true;
            self.drain(&mut out)?;
        }
        Ok((out, taken))
    }

    fn drain(&mut self, out: &mut Vec<Encoded>) -> WinResult<()> {
        loop {
            let ev = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(ev) => ev,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(e),
            };
            let t = unsafe { ev.GetType()? };
            if t == METransformNeedInput.0 as u32 {
                self.need_input += 1;
            } else if t == METransformHaveOutput.0 as u32 {
                if let Some(e) = self.output()? {
                    out.push(e);
                }
            }
        }
    }

    fn output(&mut self) -> WinResult<Option<Encoded>> {
        unsafe {
            let own = if self.provides_samples {
                None
            } else {
                let s = MFCreateSample()?;
                s.AddBuffer(&MFCreateMemoryBuffer(self.out_size)?)?;
                Some(s)
            };
            let mut buf = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(own), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let r = self.mft.ProcessOutput(0, &mut buf, &mut status);
            let sample = ManuallyDrop::take(&mut buf[0].pSample);
            drop(ManuallyDrop::take(&mut buf[0].pEvents));
            if let Err(e) = r {
                if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                    // Кодировщик уточнил формат выхода — принимаем его.
                    let t = self.mft.GetOutputAvailableType(0, 0)?;
                    self.mft.SetOutputType(0, &t, 0)?;
                    if let Some(h) = blob(&t, &MF_MT_MPEG_SEQUENCE_HEADER) {
                        self.seq_header = h;
                    }
                    return Ok(None);
                }
                if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                    return Ok(None);
                }
                return Err(e);
            }
            let Some(sample) = sample else { return Ok(None) };
            let ts_us = sample.GetSampleTime().unwrap_or(0) / 10;
            let mb = sample.ConvertToContiguousBuffer()?;
            let mut p = std::ptr::null_mut();
            let mut len = 0u32;
            mb.Lock(&mut p, None, Some(&mut len))?;
            let mut data = std::slice::from_raw_parts(p, len as usize).to_vec();
            mb.Unlock()?;
            // Ключевой — по самому потоку (IDR, NAL 5): флаг CleanPoint у части драйверов стоит не только на IDR.
            let key = has_nal(&data, 5) || (sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1 && !has_nal(&data, 1));
            if key {
                if let Some(t) = self.key_pending.take() {
                    self.key_latency = Some(t.elapsed());
                }
            }
            // Ключевой кадр должен нести SPS/PPS — иначе новый зритель не начнёт показ.
            if key && !has_nal(&data, 7) && !self.seq_header.is_empty() {
                let mut v = self.seq_header.clone();
                v.extend_from_slice(&data);
                data = v;
            }
            Ok(Some(Encoded { data, key, ts_us }))
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self.activate.ShutdownObject();
        }
    }
}

fn blob(t: &IMFMediaType, key: &GUID) -> Option<Vec<u8>> {
    unsafe {
        let n = t.GetBlobSize(key).ok()?;
        let mut v = vec![0u8; n as usize];
        t.GetBlob(key, &mut v, None).ok()?;
        Some(v)
    }
}

/// Есть ли в потоке Annex-B NAL-блок данного типа (7 — SPS).
pub fn has_nal(d: &[u8], kind: u8) -> bool {
    let mut i = 0;
    while i + 3 < d.len() {
        if d[i] == 0 && d[i + 1] == 0 && (d[i + 2] == 1 || (d[i + 2] == 0 && d[i + 3] == 1)) {
            let s = if d[i + 2] == 1 { i + 3 } else { i + 4 };
            if s < d.len() && d[s] & 0x1F == kind {
                return true;
            }
            i = s;
        } else {
            i += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn nal() {
        assert!(super::has_nal(&[0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68], 7));
        assert!(super::has_nal(&[0, 0, 1, 0x65, 9], 5));
        assert!(!super::has_nal(&[0, 0, 0, 1, 0x41, 7, 7], 7));
    }
}

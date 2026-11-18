// Превью ссылок (карточки, картинки, YouTube) и лайтбокс для изображений.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Play, X } from 'lucide-react';
import { create } from 'zustand';
import { api } from '../lib/api';
import { useStore, type Embed, type Message } from '../store';

// ---------- лайтбокс ----------
export interface LightboxItem { url: string; name?: string }
export const useLightbox = create<{ items: LightboxItem[]; index: number; open(items: LightboxItem[], index?: number): void; close(): void; go(d: number): void }>((set) => ({
  items: [], index: 0,
  open: (items, index = 0) => set({ items, index }),
  close: () => set({ items: [] }),
  go: (d) => set((s) => ({ index: (s.index + d + s.items.length) % s.items.length })),
}));

export function Lightbox() {
  const { t } = useTranslation();
  const { items, index, close, go } = useLightbox();
  const [zoom, setZoom] = useState(false);
  const item = items[index];
  useEffect(() => setZoom(false), [index, items]);
  useEffect(() => {
    if (!items.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'ArrowRight' && items.length > 1) go(1);
      if (e.key === 'ArrowLeft' && items.length > 1) go(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, close, go]);
  return (
    <AnimatePresence>
      {item && (
        <motion.div className="lightbox" role="dialog" aria-label={item.name || t('media.image')} onClick={close}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span className="lightbox-name">{item.name}{items.length > 1 && <span className="muted"> · {index + 1}/{items.length}</span>}</span>
            <a className="icon-btn" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={t('media.original')} title={t('media.original')}><ExternalLink size={18} /></a>
            <a className="icon-btn" href={item.url} download={item.name || ''} aria-label={t('media.download')} title={t('media.download')}><Download size={18} /></a>
            <button className="icon-btn" onClick={close} aria-label={t('media.close')} title={t('media.close')}><X size={20} /></button>
          </div>
          {items.length > 1 && (
            <>
              <button className="lightbox-nav prev" aria-label={t('media.prev')} onClick={(e) => { e.stopPropagation(); go(-1); }}><ChevronLeft size={28} /></button>
              <button className="lightbox-nav next" aria-label={t('media.next')} onClick={(e) => { e.stopPropagation(); go(1); }}><ChevronRight size={28} /></button>
            </>
          )}
          <div className={`lightbox-stage ${zoom ? 'zoom' : ''}`} onClick={(e) => e.stopPropagation()}>
            <motion.img key={item.url} src={item.url} alt={item.name || ''} referrerPolicy="no-referrer" onClick={() => setZoom((z) => !z)}
              initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18 }} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- превью ссылок ----------
function SafeImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img className={className} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function YouTube({ e }: { e: Embed }) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  return (
    <div className="embed-video">
      {playing ? (
        <iframe src={`https://www.youtube-nocookie.com/embed/${e.video_id}?autoplay=1`} title={e.title || 'YouTube'}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      ) : (
        <button className="embed-play" onClick={() => setPlaying(true)} aria-label={t('media.play')}>
          <SafeImg src={e.image!.url} alt={e.title || ''} />
          <span className="embed-play-icon"><Play size={26} fill="currentColor" /></span>
        </button>
      )}
    </div>
  );
}

function EmbedCard({ e }: { e: Embed }) {
  const open = useLightbox((l) => l.open);
  if (e.type === 'image' && e.image) {
    return <button className="embed-image-only" onClick={() => open([{ url: e.image!.url, name: e.url.split('/').pop() }])}><SafeImg src={e.image.url} alt="" /></button>;
  }
  const big = e.type === 'video' || e.large_image;
  return (
    <div className={`embed ${big ? 'big' : ''}`} style={e.color ? ({ '--embed-color': e.color } as React.CSSProperties) : undefined}>
      <div className="embed-body">
        {e.site_name && <div className="embed-site">{e.site_name}</div>}
        {e.author && <div className="embed-author">{e.author}</div>}
        <a className="embed-title" href={e.url} target="_blank" rel="noopener noreferrer">{e.title || e.url}</a>
        {e.description && <div className="embed-desc">{e.description}</div>}
        {e.type === 'video' && e.provider === 'youtube' && e.video_id && e.image && <YouTube e={e} />}
        {e.type === 'link' && big && e.image && (
          <button className="embed-big-img" onClick={() => open([{ url: e.image!.url, name: e.title ?? undefined }])}><SafeImg src={e.image.url} alt={e.title || ''} /></button>
        )}
      </div>
      {e.type === 'link' && !big && e.image && (
        <button className="embed-thumb" onClick={() => open([{ url: e.image!.url, name: e.title ?? undefined }])}><SafeImg src={e.image.url} alt="" /></button>
      )}
    </div>
  );
}

/** Превью ссылок сообщения; автор (или модератор) может их скрыть. */
export function Embeds({ m, canSuppress }: { m: Message; canSuppress: boolean }) {
  const { t } = useTranslation();
  const list = m.embeds ?? [];
  if (!list.length) return null;
  return (
    <div className="embeds">
      {list.map((e, i) => <EmbedCard key={`${e.url}-${i}`} e={e} />)}
      {canSuppress && (
        <button className="embeds-remove" aria-label={t('media.removeEmbeds')} title={t('media.removeEmbeds')}
          onClick={() => api('POST', `/messages/${m.id}/suppress-embeds`, { suppress: true }).catch((err) => useStore.getState().toast(err.message, true))}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

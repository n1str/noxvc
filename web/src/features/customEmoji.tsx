// Эмодзи сервера: картинка по токену <:имя:id>, глиф для реакций, вкладка управления в настройках сервера.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Trash2, Upload } from 'lucide-react';
import { api, uploadFile } from '../lib/api';
import { Button, IconButton } from '../ui';
import { useModal } from '../ui/overlays';
import { useStore, type CustomEmoji, type GuildDetail } from '../store';
import { confirmModal } from './modals';

/** Токен эмодзи сервера: <:имя:id> или <a:имя:id>. */
export const CUSTOM_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,19})>/;
export const customToken = (e: CustomEmoji) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
export const emojiImage = (id: number | string) => `/api/emojis/${id}/image`;

/** Картинка эмодзи; если эмодзи удалено — текст :имя:. */
export function CustomEmojiImg({ id, name, big }: { id: string | number; name: string; big?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="emoji-missing">:{name}:</span>;
  return <img className={`emoji-custom ${big ? 'big' : ''}`} src={emojiImage(id)} alt={`:${name}:`} title={`:${name}:`} draggable={false} loading="lazy" onError={() => setBroken(true)} />;
}

/** Эмодзи реакции: юникод — как есть, эмодзи сервера — картинкой. */
export function EmojiGlyph({ e }: { e: string }) {
  const m = e.match(CUSTOM_RE);
  return m ? <CustomEmojiImg id={m[3]} name={m[2]} /> : <span>{e}</span>;
}

/** Сообщение только из эмодзи (до 27) — показываем крупно. */
const ONLY = /^(?:\s*(?:<a?:[A-Za-z0-9_]{2,32}:\d{1,19}>|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*))+\s*$/u;
export function isEmojiOnly(text: string) {
  if (!ONLY.test(text)) return false;
  const n = (text.match(/<a?:[A-Za-z0-9_]{2,32}:\d+>/g)?.length ?? 0) + (text.replace(/<a?:[A-Za-z0-9_]{2,32}:\d+>/g, '').match(/\p{Extended_Pictographic}/gu)?.length ?? 0);
  return n <= 27;
}

const toName = (file: string) => (file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'emoji').slice(0, 32).padEnd(2, '_');

/** Вкладка «Эмодзи» в настройках сервера. */
export function EmojiTab({ g }: { g: GuildDetail }) {
  const { t } = useTranslation();
  const modal = useModal();
  const toast = useStore((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const list = g.emojis ?? [];
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of [...files]) {
      try {
        if (f.size > 512 * 1024) throw new Error(t('emojis.tooBig', { name: f.name }));
        const up = await uploadFile(f, () => {}).promise;
        await api('POST', `/guilds/${g.id}/emojis`, { name: toName(f.name), url: up.url });
      } catch (e) { toast((e as Error).message, true); }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  };
  const rename = (e: CustomEmoji, name: string) => {
    if (name === e.name) return;
    api('PATCH', `/emojis/${e.id}`, { name }).catch((err) => toast(err.message, true));
  };
  return (
    <div className="emoji-tab">
      <p className="muted">{t('emojis.hint')}</p>
      <div className="row">
        <Button variant="primary" disabled={busy || list.length >= 50} onClick={() => input.current?.click()}><Upload size={16} />{t('emojis.upload')}</Button>
        <span className="muted small">{t('emojis.count', { n: list.length })}</span>
        <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => add(e.target.files)} />
      </div>
      <div className="emoji-table">
        <AnimatePresence initial={false}>
          {list.map((e) => (
            <motion.div key={e.id} layout className="emoji-table-row" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <img src={e.url} alt="" className="emoji-table-img" />
              <span className="muted">:</span>
              <input className="input emoji-name" defaultValue={e.name} key={e.name} maxLength={32} aria-label={t('emojis.name')}
                onBlur={(ev) => rename(e, ev.target.value.trim())} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
              <span className="muted">:</span>
              {e.animated && <span className="badge-soft">GIF</span>}
              <span className="grow" />
              <IconButton label={t('chat.delete')} tone="danger" onClick={() => modal.open(confirmModal(t('emojis.deleteTitle', { name: e.name }), t('emojis.deleteSub'), t('chat.delete'), () => api('DELETE', `/emojis/${e.id}`)))}>
                <Trash2 size={16} />
              </IconButton>
            </motion.div>
          ))}
        </AnimatePresence>
        {!list.length && <p className="muted emoji-table-empty">{t('emojis.empty')}</p>}
      </div>
    </div>
  );
}

// Поле ввода: автодополнение @/#/:, вложения с прогрессом, эмодзи, оптимистичная отправка.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { AtSign, FileText, Hash, Paperclip, SmilePlus, X } from 'lucide-react';
import { api, uploadFile } from '../lib/api';
import { emojiReady, loadEmoji, pushRecent, searchEmoji } from '../lib/emoji';
import { tokenize, type MentionMap } from '../lib/mentionText';
import { appear } from '../design/tokens';
import { Avatar, IconButton } from '../ui';
import { usePopover } from '../ui/overlays';
import { canChannel, currentChannel, displayName, P, useStore, type Attachment, type Message, roleText } from '../store';
import { EmojiPicker } from './EmojiPicker';
import { PollButton } from './threads';
import { CUSTOM_RE, customToken } from './customEmoji';

const MAX_FILES = 10;
const MAX_SIZE = 25 * 1024 * 1024;

interface Pending { key: number; name: string; size: number; progress: number; done?: Attachment; error?: string; abort(): void; preview?: string }
interface Suggestion { key: string; label: string; hint?: string; insert: string; token?: string; icon: React.ReactNode }

/** Токен перед кареткой: @имя, #канал, :эмодзи. */
function trigger(text: string, caret: number): { kind: '@' | '#' | ':'; query: string; start: number } | null {
  const m = text.slice(0, caret).match(/(^|[\s(])([@#:])([\p{L}\p{N}_.-]*)$/u);
  if (!m) return null;
  const kind = m[2] as '@' | '#' | ':';
  if (kind === ':' && m[3].length < 2) return null;
  return { kind, query: m[3].toLowerCase(), start: caret - m[3].length - 1 };
}

export function Composer({ replyTo, setReplyTo, onEditLast }: { replyTo: Message | null; setReplyTo(m: Message | null): void; onEditLast(): void }) {
  const { t } = useTranslation();
  const s = useStore();
  const pop = usePopover();
  const c = currentChannel(s)!;
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [emojiTick, setEmojiTick] = useState(0);
  const map = useRef<MentionMap>([]);
  /** Куда поставить курсор после ближайшего рендера (синхронно — следующая клавиша не обгонит). */
  const pendingCaret = useRef<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const fileKey = useRef(0);
  // Закрытая ветка — только модераторам веток (сервер проверяет так же).
  const lockedThread = c.kind === 'thread' && !!c.thread?.locked && !canChannel(c, P.MANAGE_THREADS);
  // 1:1 ЛС с заблокированным (в любую сторону знаем только свою блокировку; чужую вернёт сервер).
  const dmPeer = c.kind === 'dm' ? s.dms.find((d) => d.id === c.id && d.kind !== 'group_dm')?.user?.id : undefined;
  const blockedDm = dmPeer != null && s.relationships[dmPeer]?.kind === 2;
  const canSend = canChannel(c, P.SEND_MESSAGES) && !lockedThread && !blockedDm;
  const canAttach = canChannel(c, P.ATTACH_FILES);

  useEffect(() => { ref.current?.focus(); setText(''); map.current = []; files.forEach((f) => f.abort()); setFiles([]); }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px'; }
    if (el && pendingCaret.current != null) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    }
  }, [text]);

  // ---------- автодополнение ----------
  const tr = trigger(text, caret);
  const active = tr && closedAt !== tr.start ? tr : null;
  // Набор эмодзи грузится лениво: по готовности пересчитываем подсказки (emojiTick в зависимостях ниже).
  const wantEmoji = active?.kind === ':';
  useEffect(() => { if (wantEmoji && !emojiReady()) loadEmoji().then(() => setEmojiTick((x) => x + 1)); }, [wantEmoji]);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!active) return [];
    const q = active.query;
    if (active.kind === '@') {
      const out: Suggestion[] = [];
      const people = c.kind === 'dm'
        ? s.dms.filter((d) => d.id === c.id).map((d) => ({ id: d.user.id, name: d.user.display_name, user: d.user, username: d.user.username }))
        : (s.guild?.members ?? []).map((m) => ({ id: m.id, name: m.nick || m.display_name, user: m, username: m.username }));
      for (const p of people) {
        if (p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)) {
          out.push({ key: `u${p.id}`, label: p.name, hint: '@' + p.username, insert: `@${p.name}`, token: `<@${p.id}>`, icon: <Avatar user={p.user} size={22} /> });
        }
      }
      if (c.kind !== 'dm') {
        const all = canChannel(c, P.MENTION_EVERYONE);
        for (const r of s.guild?.roles ?? []) {
          if (!r.is_default && (r.mentionable || all) && r.name.toLowerCase().includes(q)) {
            out.push({ key: `r${r.id}`, label: '@' + r.name, hint: t('composer.role'), insert: `@${r.name}`, token: `<@&${r.id}>`,
              icon: <AtSign size={18} style={{ color: r.color ? roleText(r.color) : undefined }} /> });
          }
        }
        if (all) for (const w of ['everyone', 'here']) if (w.startsWith(q)) out.push({ key: w, label: '@' + w, hint: t(`composer.${w}`), insert: '@' + w, icon: <AtSign size={18} /> });
      }
      return out.slice(0, 10);
    }
    if (active.kind === '#') {
      return (s.guild?.channels ?? []).filter((x) => x.kind === 'text' && x.name.toLowerCase().includes(q)).slice(0, 10)
        .map((x) => ({ key: `c${x.id}`, label: x.name, insert: `#${x.name}`, token: `<#${x.id}>`, icon: <Hash size={18} /> }));
    }
    const list = emojiReady();
    // Сначала эмодзи сервера (по имени), потом обычные.
    const custom = (c.kind !== 'dm' ? s.guild?.emojis ?? [] : []).filter((e) => e.name.toLowerCase().includes(q)).slice(0, 5)
      .map((e) => ({ key: `ce${e.id}`, label: `:${e.name}:`, hint: s.guild?.name, insert: `:${e.name}:`, token: customToken(e), icon: <img className="ac-emoji-img" src={e.url} alt="" /> }));
    return list ? [...custom, ...searchEmoji(list, q, 8 - Math.min(custom.length, 3)).map((e) => ({ key: e.char, label: `:${e.codes[0] ?? e.en.replace(/\s+/g, '_')}:`, hint: e.ru, insert: e.char, icon: <span className="ac-emoji">{e.char}</span> }))] : custom;
  }, [active?.kind, active?.query, s.guild, s.dms, c, t, emojiTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSel(0), [active?.kind, active?.query]);

  const accept = (sug: Suggestion) => {
    if (!active) return;
    const before = text.slice(0, active.start), after = text.slice(caret);
    const ins = sug.insert + ' ';
    const next = before + ins + after;
    if (sug.token && !map.current.some(([d]) => d === sug.insert)) map.current.push([sug.insert, sug.token]);
    if (active.kind === ':') pushRecent(sug.insert);
    pendingCaret.current = before.length + ins.length;
    setText(next);
  };

  // ---------- вложения ----------
  const addFiles = (list: FileList | File[]) => {
    const arr = [...list];
    if (!canAttach) return;
    if (files.length + arr.length > MAX_FILES) s.toast(t('composer.tooManyFiles', { n: MAX_FILES }), true);
    for (const f of arr.slice(0, MAX_FILES - files.length)) {
      if (f.size > MAX_SIZE) { s.toast(t('chat.fileTooBig'), true); continue; }
      const key = ++fileKey.current;
      const up = uploadFile(f, (p) => setFiles((x) => x.map((e) => (e.key === key ? { ...e, progress: p } : e))));
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
      setFiles((x) => [...x, { key, name: f.name || 'image.png', size: f.size, progress: 0, abort: up.abort, preview }]);
      up.promise.then(
        (done) => setFiles((x) => x.map((e) => (e.key === key ? { ...e, done, progress: 1 } : e))),
        (err) => setFiles((x) => x.map((e) => (e.key === key ? { ...e, error: err.message } : e))),
      );
    }
  };
  const removeFile = (key: number) => setFiles((x) => { x.find((e) => e.key === key)?.abort(); return x.filter((e) => e.key !== key); });
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      // Открыто окно (настройки и т.п.) — файл не для сообщения; просто не даём браузеру открыть его.
      if (document.querySelector('.modal-scrim')) return;
      addFiles(e.dataTransfer.files);
    };
    const onOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onOver);
    return () => { window.removeEventListener('drop', onDrop); window.removeEventListener('dragover', onOver); };
  });

  // ---------- отправка ----------
  const uploading = files.some((f) => !f.done && !f.error);
  const send = () => {
    const content = tokenize(text.trim(), map.current);
    const attachments = files.filter((f) => f.done).map((f) => f.done!);
    if ((!content && !attachments.length) || !canSend) return;
    if (uploading) return s.toast(t('composer.waitUpload'), true);
    if (content.length > 4000) return s.toast(t('chat.tooLong'), true);
    s.send(c.id, c.guild_id, { content, reply_to: replyTo?.id ?? null, attachments }, replyTo);
    setText(''); setFiles([]); setReplyTo(null); map.current = [];
    lastTyping.current = 0;
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => (x + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => (x - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(suggestions[sel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setClosedAt(active!.start); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') setReplyTo(null);
    if (e.key === 'ArrowUp' && !text) { e.preventDefault(); onEditLast(); }
  };
  const insertAtCaret = (str: string) => {
    const el = ref.current;
    const p = el?.selectionStart ?? text.length;
    pendingCaret.current = p + str.length;
    setText((v) => v.slice(0, p) + str + v.slice(p));
  };

  const placeholder = blockedDm ? t('blocked.dmNote') : lockedThread ? t('threads.lockedNote') : !canSend ? t('chat.noSend') : c.thread?.archived ? t('threads.archivedPlaceholder') : c.group ? t('group.placeholder', { name: c.name }) : c.kind === 'dm' ? t('chat.placeholderDm', { name: c.name }) : t('chat.placeholder', { name: c.name });
  const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
  return (
    <div className="composer">
      <AnimatePresence>
        {suggestions.length > 0 && (
          <motion.div className="autocomplete" role="listbox" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.12 }}>
            <div className="ac-title">{t(`composer.ac${active!.kind === '@' ? 'Members' : active!.kind === '#' ? 'Channels' : 'Emoji'}`)}</div>
            {suggestions.map((sg, i) => (
              <button key={sg.key} role="option" aria-selected={i === sel} className={`ac-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); accept(sg); }}>
                {sg.icon}<span className="ac-label">{sg.label}</span>{sg.hint && <span className="muted small">{sg.hint}</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(replyTo || files.length > 0) && (
          <motion.div className="composer-bar" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={appear}>
            {replyTo && <span>{t('chat.replyTo')} <b>{displayName(s, replyTo.author.id)}</b><IconButton label={t('modal.cancel')} onClick={() => setReplyTo(null)}><X size={14} /></IconButton></span>}
            {files.length > 0 && (
              <div className="upload-list">
                {files.map((f) => (
                  <div key={f.key} className={`upload-item ${f.error ? 'failed' : ''}`} title={f.error || f.name}>
                    {f.preview ? <img src={f.preview} alt="" /> : <FileText size={28} />}
                    <span className="upload-name">{f.name}</span>
                    <span className="muted small">{f.error ? f.error : f.done ? fmtSize(f.size) : `${Math.round(f.progress * 100)}%`}</span>
                    {!f.done && !f.error && <span className="upload-progress"><i style={{ width: `${f.progress * 100}%` }} /></span>}
                    <button className="upload-x" aria-label={t('composer.removeFile')} onClick={() => removeFile(f.key)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="composer-row">
        {canAttach && (
          <label className="icon-btn" title={t('chat.attach')} aria-label={t('chat.attach')}>
            <Paperclip size={18} /><input type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          </label>
        )}
        <textarea ref={ref} rows={1} value={text} disabled={!canSend} placeholder={placeholder} onKeyDown={onKey}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setClosedAt(null);
            if (e.target.value && Date.now() - lastTyping.current > 3000) { lastTyping.current = Date.now(); api('POST', `/channels/${c.id}/typing`).catch(() => {}); }
          }} />
        <PollButton channel={c} disabled={!canSend} />
        <IconButton label={t('chat.emoji')} disabled={!canSend} onClick={(e) => pop.show(e.currentTarget.getBoundingClientRect(), <EmojiPicker onPick={(x) => {
          pop.hide();
          // Эмодзи сервера: в поле — :имя:, при отправке — токен.
          const ce = x.match(CUSTOM_RE);
          if (ce) { if (!map.current.some(([d]) => d === `:${ce[2]}:`)) map.current.push([`:${ce[2]}:`, x]); insertAtCaret(`:${ce[2]}:`); } else insertAtCaret(x);
        }} />)}>
          <SmilePlus size={18} />
        </IconButton>
      </div>
    </div>
  );
}

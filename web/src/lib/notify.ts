// Уведомления о новых сообщениях: решение «уведомлять ли» (настройки сервера/канала), звук и уведомление ОС.
import { isMentioned, notifyFor, type Message } from '../store';
import { dinvoke, isDesktop } from './desktop';

type StoreLike = Parameters<typeof isMentioned>[0] & Parameters<typeof notifyFor>[0] & { channelId: number | null };

/** Настройки этого устройства (не синхронизируются: на телефоне и на работе хочется по-разному). */
export const devicePrefs = {
  get sound() { return read('relay_notify_sound', true); },
  set sound(v: boolean) { write('relay_notify_sound', v); },
  get desktop() { return read('relay_notify_desktop', true); },
  set desktop(v: boolean) { write('relay_notify_desktop', v); },
};
function read(k: string, d: boolean) { try { const v = localStorage.getItem(k); return v == null ? d : v === 'true'; } catch { return d; } }
function write(k: string, v: boolean) { try { localStorage.setItem(k, String(v)); } catch { /* приватный режим */ } }

/** Нужно ли уведомлять об этом сообщении (без учёта того, смотрит ли пользователь на канал). */
export function wants(s: StoreLike, m: Message, guildId: number | null): boolean {
  if (m.author.id === s.me?.id) return false;
  const n = notifyFor(s, m.channel_id, guildId);
  if (n.channelMuted || n.guildMuted || n.level === 2) return false;
  if (guildId == null || n.level === 0) return true;
  if (m.mention_everyone && !n.suppressEveryone) return true;
  return isMentioned(s, { ...m, mention_everyone: false });
}

let audio: AudioContext | null = null;
/** Короткий двухтоновый сигнал (синтез — без файлов). */
export function ping() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.2);
    }
  } catch { /* нет звука — не страшно */ }
}

const plain = (s: StoreLike & { users: Record<number, { display_name: string }> }, text: string) =>
  text.replace(/<a?:([A-Za-z0-9_]{2,32}):\d+>/g, ':$1:').replace(/<@(\d+)>/g, (_, id) => '@' + (s.users[+id]?.display_name ?? '…')).replace(/<@&\d+>/g, '@роль').replace(/<#\d+>/g, '#канал');

let lastPing = 0;
export function notifyMessage(s: StoreLike & { users: Record<number, { display_name: string }>; guild: { id: number; name: string; channels: { id: number; name: string }[] } | null }, m: Message, guildId: number | null) {
  if ((s as { me?: { presence?: string } | null }).me?.presence === 'dnd') return;
  const looking = m.channel_id === s.channelId && !document.hidden && document.hasFocus();
  if (looking || !wants(s, m, guildId)) return;
  const now = Date.now();
  if (devicePrefs.sound && now - lastPing > 1500) { lastPing = now; ping(); }
  if (isDesktop) {
    dinvoke('attention');
    if (devicePrefs.desktop && !document.hasFocus()) {
      const ch2 = s.guild?.id === guildId ? s.guild?.channels.find((c) => c.id === m.channel_id) : undefined;
      dinvoke('notify', { title: guildId == null ? m.author.display_name : `${m.author.display_name}${ch2 ? ' · #' + ch2.name : ''}`, body: plain(s, m.content).slice(0, 160) || '📎' });
    }
    return;
  }
  if (!devicePrefs.desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  const ch = s.guild?.id === guildId ? s.guild?.channels.find((c) => c.id === m.channel_id) : undefined;
  const title = guildId == null ? m.author.display_name : `${m.author.display_name}${ch ? ' · #' + ch.name : ''}${s.guild?.id === guildId ? ' · ' + s.guild!.name : ''}`;
  const body = plain(s, m.content).slice(0, 160) || (m.attachments?.length ? '📎' : '');
  try {
    const n = new Notification(title, { body, tag: `relay-${m.channel_id}`, silent: true });
    n.onclick = () => { window.focus(); location.hash = `#msg/${guildId ?? 'dm'}/${m.channel_id}/${m.id}`; n.close(); };
  } catch { /* некоторые браузеры требуют service worker */ }
}

/** Попросить разрешение на уведомления ОС (только по действию пользователя). */
export async function requestDesktop(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

import type { Banner } from './features/banner';
import type { GameActivity } from './lib/games';
// Состояние приложения (zustand): данные, навигация и применение событий gateway.
import { create } from 'zustand';
import { api, ApiError, setToken, setUnauthorizedHandler } from './lib/api';
import { dinvoke } from './lib/desktop';
import { Gateway, type GatewayEvent } from './lib/gateway';
import { DM_PERMS, has, P } from './lib/perms';
import { notifyMessage } from './lib/notify';
import { scrubHost } from './lib/links';
import i18n from './i18n';

export type Presence = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';
export interface User { id: number; username: string; display_name: string; color: string; status: string; online?: boolean; avatar?: string | null; avatar_anim?: boolean; presence?: Presence; activity?: GameActivity | null }
/** Я сам: плюс профиль и приватность. presence — выбранный статус (в т.ч. invisible). */
export interface Me extends User { bio?: string; pronouns?: string; banner_color?: string | null; banner?: Banner | null; avatar_pending?: boolean; banner_pending?: boolean; features?: { animated_profiles?: boolean };
  /** Настройки аккаунта, общие для устройств (горячие клавиши, голос, тема). */
  settings?: Record<string, unknown>;
  /** Администратор инстанса (backlog обратной связи); непрочитанные изменения в моих обращениях. */
  is_admin?: boolean; feedback_unread?: number; invite_pending?: number; privacy?: { friend_requests: 'everyone' | 'mutual' | 'none'; dm_from: 'everyone' | 'friends' } }
/** Отношение: 1 друг, 2 заблокирован мной, 3 входящая заявка, 4 исходящая. */
export interface Relationship { id: number; kind: 1 | 2 | 3 | 4; since: number; user: User }
export interface Member extends User { nick: string | null; roles: number[] }
export interface Role { id: number; name: string; color: number; position: number; permissions: number; hoist: boolean; mentionable: boolean; is_default: boolean }
export interface Channel {
  id: number; guild_id: number | null; parent_id: number | null; name: string; kind: 'text' | 'voice' | 'category' | 'dm' | 'thread' | 'forum' | 'stage';
  topic: string; position: number; bitrate: number; user_limit: number; permissions?: number;
  /** Ветка: метаданные; форум: теги. */
  thread?: ThreadMeta; tags?: ForumTag[] | null;
  /** Групповая ЛС (kind остаётся 'dm'). */
  group?: boolean;
}
export interface ThreadMeta {
  owner_id: number; starter_message_id: number | null; archived: boolean; locked: boolean; auto_archive_minutes: number;
  applied_tags: number[]; created_at: number; last_message_at: number; message_count: number;
}
export interface ForumTag { id: number; name: string; emoji: string }
export interface CustomEmoji { id: number; name: string; url: string; animated: boolean }
export interface PollAnswer { id: number; text: string; voters: number[] }
export interface Poll { question: string; multiselect: boolean; expires_at: number; answers: PollAnswer[] }
export interface VoiceState {
  user_id: number; guild_id: number | null; channel_id: number | null; muted?: boolean; deafened?: boolean; prev_channel_id?: number;
  /** Камера, экран; сцена: слушатель и поднятая рука. */
  video?: boolean; screen?: boolean; suppress?: boolean; hand?: number | null;
  /** Звук трансляции включён (иначе зрители видят «без звука»). */
  screen_audio?: boolean;
}
/** icon — URL a256.webp (размеры рядом, см. avatarSrc); icon_pending — идёт обработка новой иконки. */
export interface GuildSummary { id: number; name: string; owner_id: number; icon?: string | null; icon_anim?: boolean; icon_pending?: boolean }
export interface GuildDetail extends GuildSummary { channels: Channel[]; members: Member[]; roles: Role[]; voice: VoiceState[]; permissions: number; threads: Channel[]; joined_threads: number[]; emojis: CustomEmoji[] }
export interface Reaction { emoji: string; users: number[] }
export interface Attachment { url: string; name: string; size?: number; content_type?: string }
export interface Message {
  id: number; channel_id: number; author: User; content: string; created_at: number; edited_at: number | null; pinned: boolean;
  reply_to: { id: number; content: string; author: User } | null; attachment: { url: string; name: string } | null; reactions: Reaction[];
  attachments?: Attachment[]; mentions?: number[]; mention_roles?: number[]; mention_everyone?: boolean;
  embeds?: Embed[]; suppress_embeds?: boolean;
  thread?: { id: number; name: string; message_count: number; last_message_at: number; archived: boolean } | null; poll?: Poll | null;
  /** Оптимистичная отправка: метка, состояние и что повторить при ошибке. */
  nonce?: string; pending?: 'sending' | 'failed'; draft?: { content: string; reply_to: number | null; attachments: Attachment[] };
}
/** Превью ссылки (строит сервер): карточка, картинка или видео. */
export interface Embed {
  type: 'link' | 'image' | 'video'; url: string; title?: string | null; description?: string | null; site_name?: string; author?: string | null;
  image?: { url: string } | null; color?: string | null; large_image?: boolean; provider?: string; video_id?: string;
}
export interface Dm { id: number; user: User; kind?: 'dm' | 'group_dm'; name?: string; owner_id?: number | null; recipients?: User[] }
/** detached — показано окно вокруг сообщения (переход по ссылке), а не последние сообщения. */
interface History { list: Message[]; done: boolean; loading: boolean; detached?: boolean; loadingNewer?: boolean }
/** Состояние прочтения канала (источник истины — сервер, READY/`/me` и MESSAGE_ACK). */
export interface ReadState { channel_id: number; guild_id: number | null; last_read_id: number; mention_count: number; last_message_id: number }
/** Настройка уведомлений: на сервер или на канал. level: 0 все, 1 упоминания, 2 ничего. muted_until: мс, -1 навсегда. */
export interface NotifySetting { guild_id: number | null; channel_id: number | null; level: 0 | 1 | 2; muted_until: number | null; suppress_everyone: boolean }
interface MePayload { user: Me; relationships?: Relationship[]; voice?: VoiceState[]; guilds: GuildSummary[]; dms: Dm[]; read_states?: ReadState[]; notification_settings?: NotifySetting[] }

type View = 'home' | number;

interface State {
  token: string | null;
  me: Me | null;
  relationships: Record<number, Relationship>;
  guilds: GuildSummary[];
  dms: Dm[];
  view: View;
  guild: GuildDetail | null;
  channelId: number | null;
  history: Record<number, History>;
  reads: Record<number, ReadState>;
  notify: NotifySetting[];
  typing: Record<number, Record<number, number>>;
  users: Record<number, User>;
  voice: Record<number, VoiceState>;
  connection: 'connecting' | 'online' | 'reconnecting';
  toasts: { id: number; text: string; error?: boolean }[];
  /** «Новые сообщения»: линия после последнего прочитанного на момент открытия канала. */
  marker: { channelId: number; afterId: number } | null;
  /** Подсветить сообщение после перехода. */
  highlight: { channelId: number; messageId: number; at: number } | null;
  /** Растёт на любом событии веток — форум перечитывает список постов. */
  threadsTick: number;

  boot(): Promise<void>;
  login(username: string, password: string, register: boolean, code?: string): Promise<void>;
  logout(): void;
  selectHome(channel?: number | null): void;
  selectGuild(id: number, channel?: number | null): Promise<void>;
  selectChannel(id: number | null): Promise<void>;
  /** Открыть ветку (в т.ч. архивную — догрузит её). */
  openThread(id: number, known?: Channel): Promise<void>;
  loadOlder(): Promise<void>;
  loadNewer(): Promise<void>;
  jumpTo(channelId: number, messageId: number): Promise<void>;
  backToPresent(): Promise<void>;
  send(channelId: number, guildId: number | null, draft: { content: string; reply_to: number | null; attachments: Attachment[] }, replyTo?: Message | null): Promise<void>;
  retry(channelId: number, tempId: number): void;
  discard(channelId: number, tempId: number): void;
  toast(text: string, error?: boolean): void;
  apply(ev: GatewayEvent): void;
  /** Отметить текущий канал прочитанным (с задержкой; только если окно в фокусе). */
  ackSoon(): void;
}

const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

let gateway: Gateway | null = null;
let toastId = 0;

/** Изменить текущий сервер, только если это сервер `id`. */
const withGuild = (g: GuildDetail | null, id: unknown, fn: (g: GuildDetail) => GuildDetail): GuildDetail | null => (g && g.id === id ? fn(g) : g);

// Временные (отправляемые) сообщения имеют отрицательный id и всегда стоят в конце, в порядке создания.
const orderKey = (m: Message) => (m.id < 0 ? 1e15 - m.id : m.id);
const mergeMessages = (a: Message[], b: Message[]) => {
  const map = new Map<number, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => orderKey(x) - orderKey(y));
};
let tempSeq = -1;
let ackTimer: ReturnType<typeof setTimeout> | undefined;
let bootWired = false;
const AFK_MS = 10 * 60_000;
/** Звонки в ЛС из снимка /me: заменяют прежние ЛС-состояния, серверные не трогают. */
const withDmVoice = (cur: Record<number, VoiceState>, list: VoiceState[] | undefined) => {
  const out = Object.fromEntries(Object.entries(cur).filter(([, v]) => v.guild_id != null));
  for (const v of list ?? []) out[v.user_id] = v;
  return out;
};
const byUser = (list: Relationship[] | undefined) => Object.fromEntries((list ?? []).map((r) => [r.id, r]));
const byChannel = (list: ReadState[] | undefined) => Object.fromEntries((list ?? []).map((r) => [r.channel_id, r]));

export const useStore = create<State>((set, get) => {
  const cache = (u: User | undefined | null) => {
    if (!u) return;
    set((s) => ({ users: { ...s.users, [u.id]: { ...s.users[u.id], ...u } } }));
  };
  const patchHistory = (ch: number, fn: (h: History) => History) =>
    set((s) => (s.history[ch] ? { history: { ...s.history, [ch]: fn(s.history[ch]) } } : {}));

  const resync = async () => {
    const d = await api<MePayload>('GET', '/me').catch(() => null);
    if (!d) return;
    set((st) => ({ me: d.user, guilds: d.guilds, dms: d.dms, history: {}, reads: byChannel(d.read_states), notify: d.notification_settings ?? [], relationships: byUser(d.relationships), voice: withDmVoice(st.voice, d.voice) }));
    d.dms.forEach((x) => cache(x.user));
    const { view, channelId } = get();
    if (view === 'home') get().selectHome(channelId);
    else if (d.guilds.some((g) => g.id === view)) await get().selectGuild(view, channelId);
    else get().selectHome();
  };

  /** Растёт ли счётчик упоминаний — то же правило, что на сервере (точное значение придёт при пересинхронизации). */
  const countsAsMention = (m: Message, guildId: number | null) => {
    const s = get();
    if (guildId == null) return true;
    if (m.mention_everyone && !notifyFor(s, m.channel_id, guildId).suppressEveryone) return true;
    return isMentioned(s, { ...m, mention_everyone: false });
  };

  return {
    token: LS.get<string | null>('relay_token', null),
    me: null, relationships: {}, guilds: [], dms: [], view: 'home', guild: null, channelId: null,
    history: {}, reads: {}, notify: [], typing: {}, users: {}, voice: {}, connection: 'connecting', toasts: [], marker: null, highlight: null, threadsTick: 0,

    async boot() {
      const token = get().token;
      if (!token) return;
      setToken(token);
      setUnauthorizedHandler(() => get().logout());
      let d: MePayload;
      try { d = await api('GET', '/me'); } catch (e) {
        // Неверный токен — выход; сервер недоступен — не выходим, повторяем (вход сохраняется).
        if (e instanceof ApiError && e.status === 401) { get().logout(); return; }
        setTimeout(() => { if (get().token === token && !get().me) get().boot(); }, 5000);
        return;
      }
      dinvoke('session_put', { token }); // приложение помнит вход для других точек входа
      set((st) => ({ me: d.user, guilds: d.guilds, dms: d.dms, reads: byChannel(d.read_states), notify: d.notification_settings ?? [], relationships: byUser(d.relationships), voice: withDmVoice(st.voice, d.voice) }));
      d.relationships?.forEach((r) => cache(r.user));
      if (!bootWired) {
        bootWired = true;
        // Вернулись к окну — дочитали открытый канал.
        window.addEventListener('focus', () => get().ackSoon());
        document.addEventListener('visibilitychange', () => get().ackSoon());
        // Авто «Отошёл»: 10 минут без действий — сообщаем серверу, при первом действии — возвращаемся.
        let lastAct = Date.now(), afk = false;
        const act = () => { lastAct = Date.now(); if (afk) { afk = false; api('POST', '/me/activity', { afk: false }).catch(() => {}); } };
        for (const ev of ['mousemove', 'keydown', 'pointerdown', 'focus']) window.addEventListener(ev, act, { passive: true });
        setInterval(() => {
          if (!afk && get().token && Date.now() - lastAct > AFK_MS) { afk = true; api('POST', '/me/activity', { afk: true }).catch(() => {}); }
        }, 30_000);
      }
      cache(d.user);
      d.dms.forEach((x) => cache(x.user));
      gateway?.stop();
      gateway = new Gateway(token, {
        onReady: (_d, isReconnect) => { if (isReconnect) resync(); },
        onEvent: (ev) => get().apply(ev),
        onStatus: (connection) => set({ connection }),
        onAuthFailed: () => { get().logout(); get().toast(i18n.t('us.sessionEnded'), true); },
      });
      gateway.start();
      const last = LS.get<View>('relay_view', 'home');
      if (last !== 'home' && d.guilds.some((g) => g.id === last)) await get().selectGuild(last);
      else get().selectHome();
    },

    async login(username, password, register, code) {
      const d = await api<{ token: string }>('POST', register ? '/register' : '/login', register ? { username, password, code: code ?? '' } : { username, password });
      LS.set('relay_token', d.token);
      dinvoke('session_put', { token: d.token });
      set({ token: d.token });
      await get().boot();
    },

    logout() {
      const t = get().token;
      if (t) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
      gateway?.stop();
      gateway = null;
      window.dispatchEvent(new Event('relay:logout')); // голос и трансляция — выйти
      LS.set('relay_token', null);
      dinvoke('session_put', { token: null });
      setToken(null);
      set({ token: null, me: null, guilds: [], dms: [], guild: null, channelId: null, history: {}, reads: {}, notify: [], relationships: {}, marker: null, view: 'home' });
    },

    selectHome(channel = null) {
      set({ view: 'home', guild: null });
      LS.set('relay_view', 'home');
      const want = channel;
      get().selectChannel(get().dms.some((d) => d.id === want) ? want : null);
    },

    async selectGuild(id, channel = null) {
      let d: GuildDetail;
      try { d = await api('GET', `/guilds/${id}`); } catch (e) { get().toast((e as Error).message, true); return; }
      d.members.forEach(cache);
      d.threads ??= [];
      d.joined_threads ??= [];
      d.emojis ??= [];
      // Ссылка на архивную ветку: её нет среди активных — догружаем.
      if (channel != null && !d.channels.some((c) => c.id === channel) && !d.threads.some((c) => c.id === channel)) {
        const th = await api<Channel>('GET', `/threads/${channel}`).catch(() => null);
        if (th && th.guild_id === id) d.threads.push(th);
      }
      const voice = Object.fromEntries(Object.entries(get().voice).filter(([, v]) => v.guild_id !== id));
      for (const v of d.voice) voice[v.user_id] = v;
      set({ view: id, guild: d, voice });
      LS.set('relay_view', id);
      const want = channel ?? LS.get<Record<string, number>>('relay_last_ch', {})[id];
      const text = d.channels.filter((c) => c.kind === 'text');
      const openable = [...d.channels.filter((c) => c.kind === 'text' || c.kind === 'forum'), ...d.threads];
      await get().selectChannel(openable.find((c) => c.id === want)?.id ?? text[0]?.id ?? null);
    },

    async selectChannel(id) {
      const { view } = get();
      set((s) => {
        const r = id != null ? s.reads[id] : undefined;
        return { channelId: id, marker: id != null && r && r.last_message_id > r.last_read_id ? { channelId: id, afterId: r.last_read_id } : null };
      });
      get().ackSoon();
      const last = LS.get<Record<string, number | null>>('relay_last_ch', {});
      const kind = get().guild?.channels.find((c) => c.id === id)?.kind;
      if (kind === 'voice' || kind === 'stage') return; // экран звонка, без истории и без «последнего канала»
      LS.set('relay_last_ch', { ...last, [String(view)]: id });
      if (id == null || get().history[id]) return;
      set((s) => ({ history: { ...s.history, [id]: { list: [], done: false, loading: true } } }));
      try {
        const list = await api<Message[]>('GET', `/channels/${id}/messages?limit=50`);
        list.forEach((m) => cache(m.author));
        patchHistory(id, (h) => ({ list: mergeMessages(list, h.list), done: list.length < 50, loading: false }));
      } catch (e) {
        get().toast((e as Error).message, true);
        set((s) => { const h = { ...s.history }; delete h[id]; return { history: h }; });
      }
    },

    async openThread(id, known) {
      const g = get().guild;
      if (!g) return;
      if (!g.threads.some((t) => t.id === id)) {
        const th = known?.thread && known.permissions != null ? known : await api<Channel>('GET', `/threads/${id}`).catch((e) => { get().toast(e.message, true); return null; });
        if (!th) return;
        set((st) => ({ guild: withGuild(st.guild, g.id, (x) => ({ ...x, threads: x.threads.some((t) => t.id === id) ? x.threads : [...x.threads, th] })) }));
      }
      await get().selectChannel(id);
      import('./ui/layout').then((m) => m.useLayout.getState().open('none'));
    },

    async loadOlder() {
      const ch = get().channelId;
      const h = ch != null ? get().history[ch] : null;
      if (ch == null || !h || h.done || h.loading || !h.list.length) return;
      patchHistory(ch, (x) => ({ ...x, loading: true }));
      try {
        const list = await api<Message[]>('GET', `/channels/${ch}/messages?limit=50&before=${h.list[0].id}`);
        list.forEach((m) => cache(m.author));
        patchHistory(ch, (x) => ({ ...x, list: mergeMessages(list, x.list), done: list.length < 50, loading: false })); // ...x: не терять detached
      } catch { patchHistory(ch, (x) => ({ ...x, loading: false })); }
    },

    async loadNewer() {
      const ch = get().channelId;
      const h = ch != null ? get().history[ch] : null;
      const last = h?.list.filter((m) => m.id > 0).at(-1);
      if (ch == null || !h?.detached || h.loadingNewer || !last) return;
      patchHistory(ch, (x) => ({ ...x, loadingNewer: true }));
      try {
        const list = await api<Message[]>('GET', `/channels/${ch}/messages?limit=50&after=${last.id}`);
        list.forEach((m) => cache(m.author));
        // Догнали последние — окно снова «живое» (новые сообщения из gateway добавляются в конец).
        // Пока грузили, могли вернуться к последним (история уже не «окно») — тогда результат не нужен.
        patchHistory(ch, (x) => (x.detached ? { ...x, list: mergeMessages(x.list, list), detached: list.length >= 50, loadingNewer: false } : x));
      } catch { patchHistory(ch, (x) => ({ ...x, loadingNewer: false })); }
    },

    async jumpTo(channelId, messageId) {
      const h = get().history[channelId];
      if (!h?.list.some((m) => m.id === messageId)) {
        try {
          const list = await api<Message[]>('GET', `/channels/${channelId}/messages?around=${messageId}&limit=50`);
          list.forEach((m) => cache(m.author));
          set((s) => ({ history: { ...s.history, [channelId]: { list, done: false, loading: false, detached: true } } }));
        } catch (e) { get().toast((e as Error).message, true); return; }
      }
      set({ highlight: { channelId, messageId, at: Date.now() } });
    },

    async backToPresent() {
      const ch = get().channelId;
      if (ch == null) return;
      set((s) => { const h = { ...s.history }; delete h[ch]; return { history: h }; });
      await get().selectChannel(ch);
    },

    async send(channelId, guildId, draft, replyTo) {
      const me = get().me!;
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const temp: Message = {
        id: tempSeq--, channel_id: channelId, author: me, content: draft.content, created_at: Date.now(), edited_at: null, pinned: false,
        reply_to: replyTo ? { id: replyTo.id, content: replyTo.content.slice(0, 120), author: replyTo.author } : null,
        attachment: draft.attachments[0] ?? null, attachments: draft.attachments, reactions: [], nonce, pending: 'sending', draft,
      };
      patchHistory(channelId, (h) => ({ ...h, list: [...h.list, temp] }));
      set({ marker: null });
      try {
        const m = await api<Message>('POST', `/channels/${channelId}/messages`, { ...draft, nonce });
        get().apply({ type: 'message_create', message: m, guild_id: guildId });
      } catch (e) {
        patchHistory(channelId, (h) => ({ ...h, list: h.list.map((x) => (x.id === temp.id ? { ...x, pending: 'failed' } : x)) }));
        get().toast((e as Error).message, true);
      }
    },

    retry(channelId, tempId) {
      const m = get().history[channelId]?.list.find((x) => x.id === tempId);
      if (!m?.draft) return;
      get().discard(channelId, tempId);
      const ch = currentChannel(get());
      get().send(channelId, ch?.guild_id ?? null, m.draft);
    },

    discard(channelId, tempId) {
      patchHistory(channelId, (h) => ({ ...h, list: h.list.filter((x) => x.id !== tempId) }));
    },

    toast(text, error = false) {
      const id = ++toastId;
      text = scrubHost(text);
      set((s) => ({ toasts: [...s.toasts, { id, text, error }] }));
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
    },

    apply(ev) {
      const s = get();
      const e = ev as any;
      switch (ev.type) {
        case 'message_create': {
          const m = e.message as Message;
          cache(m.author);
          patchHistory(m.channel_id, (h) => {
            const rest = m.nonce ? h.list.filter((x) => !(x.id < 0 && x.nonce === m.nonce)) : h.list;
            if (rest.some((x) => x.id === m.id)) return { ...h, list: rest };
            if (h.detached) return { ...h, list: rest }; // показываем старое окно — новое увидим, «вернувшись к последним»
            return { ...h, list: mergeMessages(rest, [m]) };
          });
          set((st) => {
            const typing = { ...st.typing };
            if (typing[m.channel_id]) { typing[m.channel_id] = { ...typing[m.channel_id] }; delete typing[m.channel_id][m.author.id]; }
            let dms = st.dms;
            if (e.guild_id == null) {
              const i = dms.findIndex((d) => d.id === m.channel_id);
              if (i > 0) dms = [dms[i], ...dms.slice(0, i), ...dms.slice(i + 1)];
            }
            const mine = m.author.id === st.me?.id;
            const r = st.reads[m.channel_id] ?? { channel_id: m.channel_id, guild_id: e.guild_id ?? null, last_read_id: 0, mention_count: 0, last_message_id: 0 };
            const next: ReadState = mine
              ? { ...r, last_message_id: Math.max(r.last_message_id, m.id), last_read_id: Math.max(r.last_read_id, m.id), mention_count: 0 }
              : { ...r, last_message_id: Math.max(r.last_message_id, m.id), mention_count: r.mention_count + (countsAsMention(m, e.guild_id ?? null) ? 1 : 0) };
            return { typing, dms, reads: { ...st.reads, [m.channel_id]: next } };
          });
          if (m.author.id !== s.me?.id) {
            if (m.channel_id === get().channelId) get().ackSoon();
            notifyMessage(get(), m, e.guild_id ?? null);
          }
          return;
        }
        case 'message_ack': {
          set((st) => {
            const r = st.reads[e.channel_id];
            if (!r) return {};
            return { reads: { ...st.reads, [e.channel_id]: { ...r, last_read_id: Math.max(r.last_read_id, e.last_read_id), mention_count: 0 } } };
          });
          return;
        }
        case 'notification_settings':
          set({ notify: e.settings });
          return;
        case 'feedback_update': { // статус или ответ по обращению (мне — от разработчика; админу — от автора)
          const fromDev = !!e.from_dev;
          if (fromDev) set((st) => (st.me ? { me: { ...st.me, feedback_unread: (st.me.feedback_unread ?? 0) + 1 } } : {}));
          get().toast(e.what === 'status' ? i18n.t('fb.notifyStatus', { id: e.id, title: e.title, status: i18n.t(`fb.st.${e.status}`) }) : i18n.t(fromDev ? 'fb.notifyReply' : 'fb.notifyUserReply', { id: e.id, title: e.title }));
          window.dispatchEvent(new CustomEvent('relay:feedback_update', { detail: { id: e.id } }));
          return;
        }
        case 'invite_request_update': { // мой запрос на приглашение одобрен/отклонён
          get().toast(e.status === 'approved' ? i18n.t('inv.notifyApproved', { name: e.invitee }) : i18n.t('inv.notifyRejected', { name: e.invitee, reason: e.reason ? ' — ' + e.reason : '' }), e.status !== 'approved');
          if (document.hidden || !document.hasFocus()) void dinvoke('notify', { title: 'NoxVC', body: e.status === 'approved' ? i18n.t('inv.notifyApproved', { name: e.invitee }) : i18n.t('inv.notifyRejected', { name: e.invitee, reason: '' }) });
          window.dispatchEvent(new CustomEvent('relay:invites_update'));
          return;
        }
        case 'invite_admin_update': // администратору: новый/решённый запрос — счётчик и список
          set((st) => (st.me ? { me: { ...st.me, invite_pending: e.pending } } : {}));
          if (e.what === 'request_new') get().toast(i18n.t('inv.notifyNew'));
          window.dispatchEvent(new CustomEvent('relay:invites_update'));
          return;
        case 'feedback_new': // администратору — новое обращение
          get().toast(i18n.t('fb.notifyNew', { id: e.id, title: e.title }));
          window.dispatchEvent(new CustomEvent('relay:feedback_update', { detail: { id: e.id } }));
          return;
        case 'settings_update': // настройки аккаунта изменены на другом устройстве
          set((st) => (st.me ? { me: { ...st.me, settings: e.settings } } : {}));
          return;
        case 'message_update': {
          const m = e.message as Message;
          patchHistory(m.channel_id, (h) => ({ ...h, list: h.list.map((x) => (x.id === m.id ? m : x)) }));
          return;
        }
        case 'message_delete':
          patchHistory(e.channel_id, (h) => ({ ...h, list: h.list.filter((x) => x.id !== e.id) }));
          return;
        case 'message_delete_bulk': {
          const ids = new Set<number>(e.ids);
          patchHistory(e.channel_id, (h) => ({ ...h, list: h.list.filter((x) => !ids.has(x.id)) }));
          return;
        }
        case 'reaction_update':
          patchHistory(e.channel_id, (h) => ({ ...h, list: h.list.map((x) => (x.id === e.message_id ? { ...x, reactions: e.reactions } : x)) }));
          return;
        case 'typing_start':
          set((st) => ({ typing: { ...st.typing, [e.channel_id]: { ...st.typing[e.channel_id], [e.user_id]: Date.now() + 6000 } } }));
          return;
        case 'presence': {
          const p = { online: e.online as boolean, presence: (e.presence ?? (e.online ? 'online' : 'offline')) as Presence, activity: (e.activity ?? null) as GameActivity | null };
          // Себе приходит выбранный статус (в т.ч. invisible); в списках сам себя вижу так же, как меня видят другие.
          if (e.user_id === s.me?.id) {
            set((st) => ({ me: st.me && { ...st.me, presence: p.presence, activity: p.activity } }));
            if (p.presence === 'invisible') { p.presence = 'offline'; p.online = false; }
          }
          cache({ ...s.users[e.user_id], id: e.user_id, ...p } as User);
          const upd = <T extends User>(u: T): T => (u.id === e.user_id ? { ...u, ...p } : u);
          set((st) => {
            const rel = st.relationships[e.user_id];
            return {
              guild: st.guild && { ...st.guild, members: st.guild.members.map(upd) },
              dms: st.dms.map((d) => ({ ...d, user: d.user && upd(d.user), recipients: d.recipients?.map(upd) })),
              relationships: rel ? { ...st.relationships, [e.user_id]: { ...rel, user: upd(rel.user) } } : st.relationships,
            };
          });
          return;
        }
        case 'relationship_add': {
          const r = e.relationship as Relationship;
          cache(r.user);
          set((st) => ({ relationships: { ...st.relationships, [r.id]: r } }));
          return;
        }
        case 'relationship_remove':
          set((st) => { const x = { ...st.relationships }; delete x[e.id]; return { relationships: x }; });
          return;
        case 'dm_update':
          set((st) => ({ dms: st.dms.map((d) => (d.id === e.dm.id ? e.dm : d)) }));
          return;
        case 'dm_remove':
          set((st) => ({ dms: st.dms.filter((d) => d.id !== e.id) }));
          if (s.view === 'home' && s.channelId === e.id) s.selectHome(null);
          return;
        case 'user_update': {
          const u = e.user as User;
          cache(u);
          set((st) => ({
            me: st.me?.id === u.id ? { ...st.me, ...u, presence: (u as Me).privacy ? u.presence : st.me.presence } : st.me,
            guild: st.guild && { ...st.guild, members: st.guild.members.map((m) => (m.id === u.id ? { ...m, ...u } : m)) },
            dms: st.dms.map((d) => (d.user.id === u.id ? { ...d, user: { ...d.user, ...u } } : d)),
          }));
          return;
        }
        case 'guild_update':
          set((st) => ({
            // имя, иконка — у всех участников без перезагрузки
            guilds: st.guilds.map((g) => (g.id === e.guild.id ? { ...g, ...e.guild } : g)),
            guild: withGuild(st.guild, e.guild.id, (g) => ({ ...g, ...e.guild })),
          }));
          return;
        case 'media_error':
          // Фоновая обработка аватара/баннера не удалась (файл повреждён, ffmpeg не справился).
          s.toast(e.error || 'Не удалось обработать файл', true);
          return;
        case 'guild_refresh':
          if (s.guild?.id === e.guild_id) s.selectGuild(e.guild_id, s.channelId);
          return;
        case 'guild_delete':
        case 'member_remove': {
          if (ev.type === 'member_remove' && e.user_id !== s.me?.id) {
            set((st) => ({ guild: withGuild(st.guild, e.guild_id, (g) => ({ ...g, members: g.members.filter((m) => m.id !== e.user_id) })) }));
            return;
          }
          if (!s.guilds.some((g) => g.id === e.guild_id)) return;
          set((st) => ({ guilds: st.guilds.filter((g) => g.id !== e.guild_id) }));
          s.toast(ev.type === 'guild_delete' ? 'Сервер удалён' : 'Вы больше не участник сервера');
          if (s.view === e.guild_id) s.selectHome();
          return;
        }
        case 'member_add':
          if (e.user.id === s.me?.id && !s.guilds.some((g) => g.id === e.guild_id)) { resync(); return; }
          cache(e.user);
          set((st) => ({
            guild: withGuild(st.guild, e.guild_id, (g) => (g.members.some((m) => m.id === e.user.id) ? g : { ...g, members: [...g.members, { nick: null, roles: [], ...e.user }] })),
          }));
          return;
        case 'channel_create':
          // В событии нет прав получателя в новом канале — перечитываем сервер (там права по каждому каналу).
          if (s.guild?.id === e.channel.guild_id) s.selectGuild(e.channel.guild_id, s.channelId);
          return;
        case 'channel_update':
          // Права не меняются этим событием (для них есть guild_refresh) — сохраняем известные.
          set((st) => ({
            guild: withGuild(st.guild, e.channel.guild_id, (g) => ({
              ...g, channels: g.channels.map((c) => (c.id === e.channel.id ? { ...c, ...e.channel, permissions: c.permissions } : c)),
            })),
          }));
          return;
        case 'channel_delete':
          set((st) => {
            const history = { ...st.history }; delete history[e.channel_id];
            const reads = { ...st.reads }; delete reads[e.channel_id];
            return { history, reads, guild: withGuild(st.guild, e.guild_id, (g) => ({ ...g, channels: g.channels.filter((c) => c.id !== e.channel_id) })) };
          });
          if (s.channelId === e.channel_id) s.selectChannel(get().guild?.channels.find((c) => c.kind === 'text')?.id ?? null);
          return;
        case 'dm_create':
          if (e.dm.user) cache(e.dm.user);
          (e.dm.recipients ?? []).forEach(cache);
          set((st) => (st.dms.some((d) => d.id === e.dm.id) ? {} : { dms: [e.dm, ...st.dms] }));
          return;
        case 'thread_create':
        case 'thread_update': {
          const th = e.thread as Channel;
          set((st) => ({
            threadsTick: st.threadsTick + 1,
            guild: withGuild(st.guild, th.guild_id, (g) => {
              const old = g.threads.find((x) => x.id === th.id);
              const merged = { ...th, permissions: old?.permissions ?? g.channels.find((c) => c.id === th.parent_id)?.permissions };
              return { ...g, threads: old ? g.threads.map((x) => (x.id === th.id ? merged : x)) : [...g.threads, merged] };
            }),
          }));
          return;
        }
        case 'thread_delete':
          set((st) => ({
            threadsTick: st.threadsTick + 1,
            guild: withGuild(st.guild, e.guild_id, (g) => ({ ...g, threads: g.threads.filter((x) => x.id !== e.id), joined_threads: g.joined_threads.filter((x) => x !== e.id) })),
          }));
          if (s.channelId === e.id) s.selectChannel(e.parent_id ?? null);
          return;
        case 'guild_emojis_update':
          set((st) => ({ guild: withGuild(st.guild, e.guild_id, (g) => ({ ...g, emojis: e.emojis })) }));
          return;
        case 'thread_member':
          set((st) => ({
            guild: st.guild && {
              ...st.guild,
              joined_threads: e.joined ? [...new Set([...st.guild.joined_threads, e.thread_id])] : st.guild.joined_threads.filter((x) => x !== e.thread_id),
            },
          }));
          return;
        case 'call_ring':
          window.dispatchEvent(new CustomEvent('relay:call_ring', { detail: e }));
          return;
        case 'voice_move':
          // Нас перенесли в другой голосовой канал: голосовой модуль подключится по присланному токену.
          window.dispatchEvent(new CustomEvent('relay:voice_move', { detail: e }));
          return;
        case 'voice_state': {
          const v = e.state as VoiceState;
          set((st) => {
            const voice = { ...st.voice };
            if (v.channel_id == null) delete voice[v.user_id]; else voice[v.user_id] = v;
            return { voice };
          });
          window.dispatchEvent(new CustomEvent('relay:voice_state', { detail: v }));
          return;
        }
      }
    },

    ackSoon() {
      clearTimeout(ackTimer);
      ackTimer = setTimeout(() => {
        const s = get();
        const ch = s.channelId;
        const r = ch != null ? s.reads[ch] : undefined;
        if (ch == null || !r || document.hidden || !document.hasFocus() || s.history[ch]?.detached) return;
        if (r.last_read_id >= r.last_message_id && !r.mention_count) return;
        const upTo = r.last_message_id;
        set((st) => ({ reads: { ...st.reads, [ch]: { ...st.reads[ch], last_read_id: Math.max(st.reads[ch].last_read_id, upTo), mention_count: 0 } } }));
        api('POST', `/channels/${ch}/ack`, { message_id: upTo }).catch(() => {});
      }, 300);
    },
  };
});

// ---------- селекторы ----------
/** Название ЛС: группа — её имя или имена участников. */
export function dmName(dm: Dm) {
  if (dm.kind !== 'group_dm') return dm.user?.display_name ?? '…';
  return dm.name || (dm.recipients ?? []).map((u) => u.display_name).join(', ') || 'Группа';
}
/** Видимое присутствие пользователя. */
export const presenceOf = (u?: Partial<User> | null): Presence => (u?.presence ?? (u?.online ? 'online' : 'offline')) as Presence;

/** Действующая настройка уведомлений канала: канал перекрывает сервер; заглушение истекает по времени. */
export function notifyFor(s: Pick<State, 'notify'>, channelId: number, guildId: number | null) {
  const now = Date.now();
  const live = (x?: NotifySetting) => !!x && x.muted_until != null && (x.muted_until === -1 || x.muted_until > now);
  const ch = s.notify.find((x) => x.channel_id === channelId);
  const g = guildId != null ? s.notify.find((x) => x.guild_id === guildId) : undefined;
  return {
    // по умолчанию: ЛС — все сообщения, серверы — только упоминания (как в больших сообществах)
    level: (ch?.level ?? g?.level ?? (guildId == null ? 0 : 1)) as 0 | 1 | 2,
    channelMuted: live(ch),
    guildMuted: live(g),
    suppressEveryone: !!g?.suppress_everyone,
  };
}

/** Непрочитанное по каналу для боковой панели (заглушённые каналы не «светятся», но упоминания видны). */
export function unreadOf(s: Pick<State, 'reads' | 'notify'>, channelId: number) {
  const r = s.reads[channelId];
  if (!r) return null;
  const n = notifyFor(s, channelId, r.guild_id);
  const unread = r.last_message_id > r.last_read_id && !n.channelMuted;
  if (!unread && !r.mention_count) return null;
  return { unread, mention: r.mention_count, guild: r.guild_id, muted: n.channelMuted || n.guildMuted };
}

export function currentChannel(s: State): Channel | null {
  if (s.channelId == null) return null;
  if (s.view === 'home') {
    const dm = s.dms.find((d) => d.id === s.channelId);
    if (!dm) return null;
    const name = dmName(dm);
    return { id: dm.id, guild_id: null, parent_id: null, name, kind: 'dm', topic: dm.kind === 'group_dm' ? '' : '@' + dm.user.username, position: 0, bitrate: 0, user_limit: 0, permissions: DM_PERMS, group: dm.kind === 'group_dm' };
  }
  return s.guild?.channels.find((c) => c.id === s.channelId) ?? s.guild?.threads.find((c) => c.id === s.channelId) ?? null;
}

export const canGuild = (s: State, flag: number) => s.view !== 'home' && has(s.guild?.permissions, flag);
export const canChannel = (c: Channel | null, flag: number) => !!c && has(c.permissions ?? 0, flag);

/** Имя на сервере: ник или отображаемое имя. */
export function displayName(s: State, uid: number, fallback?: string) {
  const m = s.view !== 'home' ? s.guild?.members.find((x) => x.id === uid) : undefined;
  return m?.nick || m?.display_name || s.users[uid]?.display_name || fallback || '…';
}

/** Цвет ника: самая высокая роль с цветом. */
export function roleColor(s: State, uid: number): string | undefined {
  const g = s.guild;
  const m = g?.members.find((x) => x.id === uid);
  if (!g || !m) return undefined;
  const top = g.roles.filter((r) => m.roles.includes(r.id) && r.color).sort((a, b) => b.position - a.position)[0];
  return top ? roleText(top.color) : undefined;
}

/** Цвет роли как цвет текста: светлота ограничена под фон темы (--role-l-min/max в tokens.css — контраст AA),
 *  оттенок и насыщенность — как у роли. Заливки (точки, чипы) — исходным цветом. */
export const roleText = (color: number) => `oklch(from #${color.toString(16).padStart(6, '0')} clamp(var(--role-l-min), l, var(--role-l-max)) c h)`;

export const isOwner = (s: State) => !!s.guild && s.guild.owner_id === s.me?.id;
export { P };

/** Упомянут ли я: сервер решает, кого упомянули (mentions/mention_roles/mention_everyone); плюс ответ на моё сообщение. */
export function isMentioned(s: State, m: Message) {
  const me = s.me;
  if (!me || m.author.id === me.id) return false;
  if (m.mention_everyone || m.mentions?.includes(me.id) || m.reply_to?.author.id === me.id) return true;
  const myRoles = s.guild?.members.find((x) => x.id === me.id)?.roles ?? [];
  return !!m.mention_roles?.some((r) => myRoles.includes(r));
}

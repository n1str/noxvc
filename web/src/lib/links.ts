// Ссылки внутри NoxVC. В приложении адрес сервера не показываем: ссылки вида noxvc://invite/КОД, noxvc://msg/…
// (внутри приложения открываются как внутренние; прежние relay://… — тоже). В браузере — обычные ссылки на адрес сайта.
import { isDesktop } from './desktop';
import { APP_URL, SITE_URL } from './site';

/** path — без «#»: invite/КОД, msg/<сервер|dm>/<канал>/<сообщение>. */
export const appLink = (path: string) => (isDesktop ? `noxvc://${path}` : `${location.origin}${location.pathname}#${path}`);

/** Ссылка-приглашение — публичная (открывается у любого: превью в мессенджерах, переход в приложение). */
export const inviteLink = (code: string) => `${SITE_URL}/invite/${code}`;

/** Ссылки на свой сервер, которые открываем внутри приложения: <сайт>/invite/КОД, <приложение>/#invite/КОД, <приложение>/#msg/… */
const OWN = new RegExp(`^(?:${SITE_URL.replace(/[.]/g, '[.]')}/(invite/\\w+)|${APP_URL.replace(/[.]/g, '[.]')}/?#((?:invite|msg)/[\\w/]+))`);
export function ownLink(href: string): { text: string; path: string } | null {
  const m = href.match(OWN);
  return m ? { text: m[0], path: m[1] ?? m[2] } : null;
}

/** noxvc://… или прежний relay://… → путь для внутреннего перехода (location.hash). null — не наша ссылка. */
export const INTERNAL = /^(?:noxvc|relay):\/\/(?:invite|msg)\/[\w/]+/;
export function internalPath(href: string): string | null {
  const m = href.match(/^(?:noxvc|relay):\/\/((?:invite|msg)\/[\w/]+)$/);
  return m ? m[1] : null;
}

/** Убрать адрес сервера из текста ошибок (браузерные и сетевые сообщения могут его содержать). */
export function scrubHost(text: string) {
  if (!isDesktop) return text;
  const host = location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = location.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?:wss?|https?)://${host}[^\\s'"]*`, 'g'), 'сервер').replace(new RegExp(bare, 'g'), 'сервер');
}

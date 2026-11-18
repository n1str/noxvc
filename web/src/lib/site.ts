// Адреса приложения. По умолчанию — тот же origin, где открыт клиент (веб и десктоп грузят клиент с сервера).
// Отдельный сайт для публичных ссылок-приглашений (если есть) — VITE_SITE_URL при сборке.
export const APP_URL = location.origin;
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined)?.replace(/\/$/, '') || location.origin;
/** Путь при открытии (до замены адреса на корень): /register — сразу форма регистрации. */
export const START_PATH = location.pathname;
/** Параметры адреса при открытии (?code=… — код приглашения для регистрации). */
export const START_SEARCH = location.search;

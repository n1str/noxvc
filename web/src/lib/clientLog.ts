// Журнал клиента для баг-репортов: последние 300 строк консоли (warn/error/info/log) и необработанные ошибки.
// Хранится только в памяти вкладки; в отчёт уходят последние N строк и только с согласия (галочка «Приложить
// диагностику»). Токены и похожие на секреты строки вычищаются здесь и ещё раз на сервере.
const MAX = 300;
const lines: string[] = [];

/** Убрать секреты: Bearer …, длинные непрерывные строки (токены сеансов, JWT), значения token=/password=. */
export function scrubLine(s: string): string {
  return s
    .replace(/(bearer\s+)\S+/gi, '$1[скрыто]')
    .replace(/((?:token|password|secret|key|credential)["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1[скрыто]')
    .replace(/[A-Za-z0-9_\-+/=.]{32,}/g, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) ? '[скрыто]' : m));
}

function push(level: string, args: unknown[]) {
  const text = args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  lines.push(`${new Date().toISOString().slice(11, 23)} ${level} ${scrubLine(text).slice(0, 500)}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

let installed = false;
export function installClientLog() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => { push(level, args); orig(...args); };
  }
  window.addEventListener('error', (e) => push('uncaught', [e.message, `${e.filename}:${e.lineno}`]));
  window.addEventListener('unhandledrejection', (e) => push('unhandled', [e.reason]));
}

/** Последние n строк журнала (уже без секретов). */
export function clientLog(n = 100): string[] { return lines.slice(-n); }

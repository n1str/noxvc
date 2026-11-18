// Упоминания в поле ввода: человек видит «@Имя» / «#канал», на сервер уходят токены <@id> / <#id> / <@&id>.
export interface MentionCtx {
  user(id: number): string | undefined;
  role(id: number): { name: string; color: number } | undefined;
  channel(id: number): string | undefined;
}
export type MentionMap = [display: string, token: string][];

/** Токены → читаемый текст (для редактирования) + карта обратной замены. */
export function humanize(content: string, ctx: MentionCtx): { text: string; map: MentionMap } {
  const map: MentionMap = [];
  const text = content.replace(/<a?:([A-Za-z0-9_]{2,32}):\d+>/g, (tok, name: string) => {
    const disp = `:${name}:`;
    if (!map.some(([d]) => d === disp)) map.push([disp, tok]);
    return disp;
  }).replace(/<(@&|@|#)(\d+)>/g, (tok, kind: string, id: string) => {
    const n = +id;
    const disp = kind === '@' ? (ctx.user(n) && `@${ctx.user(n)}`) : kind === '@&' ? (ctx.role(n) && `@${ctx.role(n)!.name}`) : (ctx.channel(n) && `#${ctx.channel(n)}`);
    if (!disp) return tok;
    if (!map.some(([d]) => d === disp)) map.push([disp, tok]);
    return disp;
  });
  return { text, map };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Читаемый текст → токены. Длинные имена первыми; «@Иван» не заденет «@Иванов». */
export function tokenize(text: string, map: MentionMap): string {
  let out = text;
  for (const [disp, tok] of [...map].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${esc(disp)}(?![\\p{L}\\p{N}_.-])`, 'gu'), tok);
  }
  return out;
}

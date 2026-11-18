// Сборка компактного набора эмодзи из emojibase-data: node scripts/build-emoji.mjs
// Формат строки: [символ, группа, название ru, название en, "шорткоды через пробел", "теги ru+en через пробел"].
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const load = (p) => JSON.parse(readFileSync(new URL(`../node_modules/emojibase-data/${p}`, import.meta.url), 'utf8'));
const ru = load('ru/compact.json'), en = load('en/compact.json'), gh = load('en/shortcodes/github.json');
const enBy = new Map(en.map((e) => [e.hexcode, e]));

const rows = ru
  .filter((e) => e.group != null && e.group !== 2) // без «компонентов» (тона кожи и т.п.)
  .sort((a, b) => a.order - b.order)
  .map((e) => {
    const x = enBy.get(e.hexcode) ?? {};
    const sc = [gh[e.hexcode]].flat().filter(Boolean);
    const tags = [...new Set([...(e.tags ?? []), ...(x.tags ?? [])])].join(' ');
    return [e.unicode, e.group, e.label, x.label ?? '', sc.join(' '), tags];
  });

mkdirSync(new URL('../src/data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../src/data/emoji.json', import.meta.url), JSON.stringify(rows));
console.log(`эмодзи: ${rows.length}, ${(JSON.stringify(rows).length / 1024).toFixed(0)} КБ`);

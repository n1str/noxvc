// Генератор бренда NoxVC: из src/*.svg — логотипы, фавиконы, OG-картинка, иконки трея и Tauri.
//   cd brand && npm install && node gen.mjs
// Растеризация — Chrome (playwright-core из web/node_modules); слово «NoxVC» в SVG — кривые из Inter ExtraBold
// (шрифт скачивается в fonts/, в Git не хранится). Результат — brand/out/ и копии туда, где они используются:
// web/public (фавиконы, OG приложения), desktop/src-tauri/icons (иконки приложения и трея).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import opentype from 'opentype.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here('../');
const OUT = here('./out/');
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(ROOT, 'web/package.json'));
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// ---------- цвета бренда (OKLCH: светлота/насыщенность акцента приложения, оттенок 292) ----------
const C = { accent: '#9776fb', strong: '#6539c2', glow: '#bfafff', bg: '#0c0b11', ink: '#17141f', paper: '#f6f5fa', text: '#edecf3' };

// ---------- шрифт и слово «NoxVC» в кривых ----------
const FONT = here('./fonts/Inter-ExtraBold.ttf');
if (!existsSync(FONT)) {
  const css = await (await fetch('https://fonts.googleapis.com/css2?family=Inter:wght@800', { headers: { 'User-Agent': 'Mozilla/4.0' } })).text();
  const url = css.match(/https:\/\/[^)]+\.ttf/)?.[0];
  if (!url) throw new Error('не нашёл TTF Inter');
  mkdirSync(here('./fonts/'), { recursive: true });
  writeFileSync(FONT, Buffer.from(await (await fetch(url)).arrayBuffer()));
}
const font = opentype.parse(readFileSync(FONT).buffer);
/** Контуры строки: [{d, x2}] — по одному на кусок (свой цвет), трекинг в долях кегля. */
function word(parts, size, x, y, tracking = -0.03) {
  const out = [];
  for (const [text, fill] of parts) {
    let d = '';
    const glyphs = font.stringToGlyphs(text);
    glyphs.forEach((g, i) => {
      d += g.getPath(x, y, size).toPathData(2);
      x += (g.advanceWidth / font.unitsPerEm) * size + tracking * size;
      if (i < glyphs.length - 1) x += (font.getKerningValue(g, glyphs[i + 1]) / font.unitsPerEm) * size;
    });
    out.push(`<path fill="${fill}" d="${d}"/>`);
  }
  return { svg: out.join(''), width: x };
}

// ---------- SVG ----------
const mark = readFileSync(here('./src/mark.svg'), 'utf8').trim();
const glyph = readFileSync(here('./src/glyph.svg'), 'utf8').trim();
const inner = (svg) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const save = (name, data) => { writeFileSync(join(OUT, name), data); console.log('  ', name); };

save('noxvc-mark.svg', mark + '\n');
save('favicon.svg', mark + '\n');
// логотип: знак 64 + слово; на тёмном и на светлом
function logo(onLight) {
  const w = word([['Nox', onLight ? C.ink : C.text], ['VC', onLight ? C.strong : C.accent]], 46, 82, 49);
  const W = Math.ceil(w.width);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 64" width="${W * 2}" height="128"><g>${inner(mark)}</g>${w.svg}</svg>\n`;
}
save('noxvc-logo-on-dark.svg', logo(false));
save('noxvc-logo-on-light.svg', logo(true));
const glyphOf = (color) => glyph.replace('currentColor', color);
save('tray-on-dark.svg', glyphOf('#ffffff') + '\n');
save('tray-on-light.svg', glyphOf(C.ink) + '\n');

// ---------- растеризация ----------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size, name, { bg = 'transparent', pad = 0 } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const s = size - pad * 2;
  await page.setContent(`<html><body style="margin:0;background:${bg};width:${size}px;height:${size}px;display:grid;place-items:center">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: bg === 'transparent', clip: { x: 0, y: 0, width: size, height: size } });
  if (name) save(name, buf);
  return buf;
}
// квадрат без скругления (Apple и Android скругляют сами)
const square = mark.replace('rx="15"', 'rx="0"');
await png(mark, 1024, 'icon-1024.png');
await png(mark, 512, 'icon-512.png');
await png(mark, 192, 'icon-192.png');
await png(square, 180, 'apple-touch-icon.png');
// фавикон .ico: 16, 32, 48 (PNG внутри ICO — поддерживается Windows Vista+ и всеми браузерами)
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...images.map(([, b]) => b)]);
}
const fav = [];
for (const s of [16, 32, 48]) fav.push([s, await png(mark, s)]);
save('favicon.ico', ico(fav));
// трей: монохромный знак, 32 px (Windows уменьшает до 16/20/24 по масштабу), для тёмной и светлой панели задач
await png(glyphOf('#ffffff'), 32, 'tray-on-dark.png');
await png(glyphOf(C.ink), 32, 'tray-on-light.png');

// ---------- OG 1200×630 ----------
const ogWord = word([['Nox', C.text], ['VC', C.accent]], 132, 0, 132);
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<html><body style="margin:0;width:1200px;height:630px;overflow:hidden;background:${C.bg};font-family:sans-serif">
<div style="position:absolute;inset:0;background:radial-gradient(60% 80% at 78% 30%, #3a2470 0%, transparent 60%), radial-gradient(50% 60% at 10% 100%, #2a1a55 0%, transparent 65%)"></div>
<div style="position:absolute;left:96px;top:150px;display:flex;align-items:center;gap:40px">
  ${mark.replace('<svg ', '<svg width="200" height="200" style="filter:drop-shadow(0 24px 60px rgba(151,118,251,.45))" ')}
  <svg width="${Math.ceil(ogWord.width)}" height="170" viewBox="0 0 ${Math.ceil(ogWord.width)} 170">${ogWord.svg}</svg>
</div>
<div style="position:absolute;left:100px;top:420px;color:#c9c5d6;font:500 40px/1.3 'Segoe UI',system-ui,sans-serif">Голос, чат и трансляции — для своих</div>
</body></html>`);
save('og.png', await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } }));
await browser.close();

// ---------- копии туда, где используются ----------
const copy = (name, dst) => { mkdirSync(join(dst, '..'), { recursive: true }); copyFileSync(join(OUT, name), dst); };
const WEB = join(ROOT, 'web/public');
mkdirSync(WEB, { recursive: true });
for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og.png']) copy(f, join(WEB, f));
const ICONS = join(ROOT, 'desktop/src-tauri/icons');
copy('tray-on-dark.png', join(ICONS, 'tray-on-dark.png'));
copy('tray-on-light.png', join(ICONS, 'tray-on-light.png'));
// иконки приложения — генератором Tauri во временный каталог, берём только те, что уже есть в icons/
const tmp = mkdtempSync(join(tmpdir(), 'noxvc-icons-'));
execSync(`npx tauri icon "${join(OUT, "icon-1024.png")}" -o "${tmp}"`, { cwd: join(ROOT, "desktop"), stdio: "ignore" });
for (const f of readdirSync(ICONS)) if (existsSync(join(tmp, f)) && !f.startsWith('tray-')) copyFileSync(join(tmp, f), join(ICONS, f));
console.log('иконки приложения обновлены:', readdirSync(ICONS).filter((f) => existsSync(join(tmp, f))).length);

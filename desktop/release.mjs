// Выпуск новой версии NoxVC Desktop с автообновлением у всех пользователей (docs/desktop-client.md).
//   RELAY_SERVER=https://app.example.com RELAY_DEPLOY_HOST=user@server RELAY_UPDATE_KEY=<публичный ключ> node release.mjs
//
//   node release.mjs                       — следующая версия (0.7.0 → 0.7.1), сборка, подпись, загрузка на сервер
//   node release.mjs 0.8.0 --notes "Что нового"
//   node release.mjs --channel test        — в тестовый канал /updates/test/ (видят только сборки с RELAY_UPDATE_CHANNEL=test)
//   node release.mjs --no-build            — не собирать заново (взять уже собранный установщик текущей версии)
//
// Подпись: закрытый ключ Ed25519 в %USERPROFILE%\.relay\update-signing-key.pem (или RELAY_UPDATE_SIGNING_KEY=путь).
// Его нет в репозитории и на сервере: без него выпустить обновление нельзя, а приложение примет только подписанное им.
// Загрузка: scp на сервер (RELAY_DEPLOY_HOST — ssh-адрес сервера) → том данных NoxVC (/data/updates) через docker cp
// в контейнер RELAY_CONTAINER (по умолчанию noxvc-relay-1). Ключ SSH — RELAY_SSH_KEY (по умолчанию ~/.ssh/id_ed25519).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? (argv.splice(i, 2)[1] ?? '') : null; };
const notes = flag('--notes') ?? '';
const channel = flag('--channel') ?? '';
const noBuild = argv.includes('--no-build') ? (argv.splice(argv.indexOf('--no-build'), 1), true) : false;
const HOST = process.env.RELAY_DEPLOY_HOST || '';
const SSH_KEY = process.env.RELAY_SSH_KEY || join(homedir(), '.ssh', 'id_ed25519');
const SERVER = (process.env.RELAY_SERVER || '').replace(//$/, '');
const CONTAINER = process.env.RELAY_CONTAINER || 'noxvc-relay-1';
const die = (m) => { console.error('Ошибка: ' + m); process.exit(1); };
if (!HOST || !/^https:///.test(SERVER)) die('задайте RELAY_DEPLOY_HOST (ssh-адрес сервера) и RELAY_SERVER (https://… адрес приложения)');
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts }); if (r.status !== 0) die(`${cmd} ${args.join(' ')} — код ${r.status}`); };
if (channel && !/^[a-z0-9]+$/i.test(channel)) die('канал — только латиница и цифры');

// 1. Версия
const confPath = here('./src-tauri/tauri.conf.json');
const cargoPath = here('./src-tauri/Cargo.toml');
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const cur = conf.version;
const bump = (v) => { const p = v.split('.').map(Number); p[2]++; return p.join('.'); };
const version = noBuild ? cur : (argv[0] || bump(cur));
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`версия «${version}» — нужна вида 1.2.3`);
if (!noBuild) {
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  const cargo = readFileSync(cargoPath, 'utf8').replace(/^version = "[^"]+"/m, `version = "${version}"`);
  writeFileSync(cargoPath, cargo);
  console.log(`Версия: ${cur} → ${version}`);
  // 2. Сборка
  run('npm', ['run', 'build'], { cwd: here('./') });
}

// 3. Установщик, хеш, подпись
const file = `Relay_${version}_x64-setup.exe`;
const exe = here(`./src-tauri/target/release/bundle/nsis/${file}`);
if (!existsSync(exe)) die(`нет установщика ${exe}`);
const bin = readFileSync(exe);
const sha256 = createHash('sha256').update(bin).digest('hex');
const keyPath = process.env.RELAY_UPDATE_SIGNING_KEY || join(homedir(), '.relay', 'update-signing-key.pem');
if (!existsSync(keyPath)) die(`нет ключа подписи ${keyPath}`);
const priv = createPrivateKey(readFileSync(keyPath));
const msg = Buffer.from(`relay-update\n${version}\n${file}\n${sha256}`);
const sig = sign(null, msg, priv).toString('base64');
// Ключ должен совпадать с зашитым в приложение — иначе пользователи отклонят обновление.
// открытый ключ, с которым собирается клиент (RELAY_UPDATE_KEY — option_env! в update.rs), должен быть парой ключу подписи
const embedded = process.env.RELAY_UPDATE_KEY;
const pub = createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
if (embedded !== pub) die('RELAY_UPDATE_KEY не задан или не совпадает с ключом подписи (docs/desktop-client.md)');
if (!verify(null, msg, createPublicKey(priv), Buffer.from(sig, 'base64'))) die('подпись не проверилась');
const manifest = { version, file, sha256, size: bin.length, notes, sig, published: new Date().toISOString() };
const tmpManifest = join(tmpdir(), 'relay-latest.json');
writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
console.log(`Установщик: ${file} (${(bin.length / 1048576).toFixed(2)} МБ), SHA-256 ${sha256.slice(0, 16)}…, подписан`);

// 4. Загрузка: сначала установщик, затем манифест (атомарно) — пользователи не увидят манифест без файла.
const dir = `/data/updates${channel ? '/' + channel : ''}`;
const ssh = (cmd) => run('ssh', ['-i', SSH_KEY, HOST, `"${cmd.replace(/"/g, '\\"')}"`]);
run('scp', ['-q', '-i', SSH_KEY, exe, tmpManifest, `${HOST}:/tmp/`]);
ssh([
  `docker exec ${CONTAINER} mkdir -p ${dir}`,
  `docker cp /tmp/${file} ${CONTAINER}:${dir}/${file}`,
  `docker cp /tmp/relay-latest.json ${CONTAINER}:${dir}/latest.json.tmp`,
  `docker exec ${CONTAINER} mv ${dir}/latest.json.tmp ${dir}/latest.json`,
  `docker exec ${CONTAINER} sh -c 'cd ${dir} && ls -t Relay_*_x64-setup.exe | tail -n +4 | xargs -r rm -f'`,
  `rm -f /tmp/${file} /tmp/relay-latest.json`,
].join(' && '));

// 5. Проверка: сервер отдаёт именно этот манифест
const got = await (await fetch(`${SERVER}/updates/${channel ? channel + '/' : ''}latest.json`)).json();
if (got.version !== version || got.sha256 !== sha256) die('сервер отдаёт другой манифест');
const head = await fetch(`${SERVER}/updates/${channel ? channel + '/' : ''}${file}`, { method: 'HEAD' });
if (!head.ok || +head.headers.get('content-length') !== bin.length) die('сервер не отдаёт установщик');
console.log(`\nГотово: Relay ${version} опубликован${channel ? ` в канал «${channel}»` : ''}.`);
console.log('Приложения пользователей найдут обновление в течение 6 часов (или сразу после запуска / по кнопке «Проверить обновления»).');
if (!noBuild && !channel) console.log('Не забудьте закоммитить смену версии (tauri.conf.json, Cargo.toml).');


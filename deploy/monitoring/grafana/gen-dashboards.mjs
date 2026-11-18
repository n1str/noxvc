// Генератор дашбордов Grafana для Relay → dashboards/*.json (коммитятся; apply.sh только копирует).
//   node deploy/monitoring/grafana/gen-dashboards.mjs
// Источник данных — переменная $datasource (по умолчанию «Prometheus (Relay)», uid relay-prometheus), UID не зашит в панели.
// Готовые дашборды grafana.com (upstream/: Node Exporter Full 1860 rev 45, PostgreSQL Database 9628 rev 8) — подгоняются
// под наш источник и метки (без Kubernetes).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = here('./dashboards/');
mkdirSync(OUT, { recursive: true });
const DS = { type: 'prometheus', uid: '${datasource}' };
const RI = '$__rate_interval';

// ---------- конструктор панелей ----------
let nextId = 1;
let y = 0;
let x = 0;
let rowH = 0;
const panels = [];
function place(w, h) {
  if (x + w > 24) { x = 0; y += rowH; rowH = 0; }
  const pos = { x, y, w, h };
  x += w; rowH = Math.max(rowH, h);
  return pos;
}
function row(title) {
  if (x > 0) { x = 0; y += rowH; rowH = 0; }
  panels.push({ type: 'row', id: nextId++, title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] });
  y += 1;
}
const t = (expr, legend = '', extra = {}) => ({ datasource: DS, expr, legendFormat: legend, refId: String.fromCharCode(65 + (extra._i ?? 0)), ...extra, _i: undefined });
const targets = (list) => list.map((q, i) => ({ ...(typeof q === 'string' ? t(q) : q), refId: String.fromCharCode(65 + i) }));
const thresholdsOf = (steps) => ({ mode: 'absolute', steps: steps.map(([value, color]) => ({ value, color })) });
const GREEN = [[null, 'green']];

function stat(title, exprs, { unit = 'short', w = 4, h = 4, thresholds = GREEN, mappings = [], decimals, desc, colorMode = 'value', graph = 'area', reduce = 'lastNotNull', links, textMode = 'auto' } = {}) {
  panels.push({
    type: 'stat', id: nextId++, title, description: desc, datasource: DS, gridPos: place(w, h), targets: targets([].concat(exprs)), links,
    fieldConfig: { defaults: { unit, decimals, mappings, thresholds: thresholdsOf(thresholds), color: { mode: 'thresholds' } }, overrides: [] },
    options: { reduceOptions: { calcs: [reduce], fields: '', values: false }, colorMode, graphMode: graph, textMode, justifyMode: 'center', orientation: 'auto' },
  });
}
function ts(title, exprs, { unit = 'short', w = 12, h = 8, stack = false, desc, min, max, thresholds, timeFrom, bars = false, overrides = [], legendCalcs = ['mean', 'max', 'lastNotNull'], fill = 10 } = {}) {
  panels.push({
    type: 'timeseries', id: nextId++, title, description: desc, datasource: DS, gridPos: place(w, h), targets: targets(exprs), timeFrom,
    fieldConfig: {
      defaults: {
        unit, min, max, color: { mode: 'palette-classic' },
        thresholds: thresholds ? thresholdsOf(thresholds) : thresholdsOf(GREEN),
        custom: { drawStyle: bars ? 'bars' : 'line', lineWidth: 2, fillOpacity: bars ? 80 : fill, gradientMode: 'opacity', showPoints: 'never', spanNulls: true,
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' }, thresholdsStyle: { mode: thresholds ? 'line+area' : 'off' } },
      },
      overrides,
    },
    options: { legend: { displayMode: 'table', placement: 'bottom', calcs: legendCalcs }, tooltip: { mode: 'multi', sort: 'desc' } },
  });
}
function gauge(title, expr, { unit = 'percentunit', w = 4, h = 6, thresholds, min = 0, max = 1, desc } = {}) {
  panels.push({
    type: 'gauge', id: nextId++, title, description: desc, datasource: DS, gridPos: place(w, h), targets: targets([expr]),
    fieldConfig: { defaults: { unit, min, max, thresholds: thresholdsOf(thresholds), color: { mode: 'thresholds' } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdMarkers: true, showThresholdLabels: false },
  });
}
function bargauge(title, expr, legend, { unit = 's', w = 12, h = 8, thresholds = GREEN, desc, max } = {}) {
  panels.push({
    type: 'bargauge', id: nextId++, title, description: desc, datasource: DS, gridPos: place(w, h), targets: targets([t(expr, legend, { instant: true })]),
    fieldConfig: { defaults: { unit, min: 0, max, thresholds: thresholdsOf(thresholds), color: { mode: 'thresholds' } }, overrides: [] },
    options: { orientation: 'horizontal', displayMode: 'gradient', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showUnfilled: true, valueMode: 'color', namePlacement: 'left', sizing: 'auto' },
  });
}
function table(title, list, { w = 24, h = 8, desc, overrides = [], organize = {} } = {}) {
  panels.push({
    type: 'table', id: nextId++, title, description: desc, datasource: DS, gridPos: place(w, h),
    targets: targets(list.map((q) => (typeof q === 'string' ? t(q, '', { instant: true, format: 'table' }) : { ...q, instant: true, format: 'table' }))),
    transformations: [{ id: 'merge', options: {} }, { id: 'organize', options: organize }],
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  });
}
const UPDOWN = [{ type: 'value', options: { 0: { text: 'DOWN', color: 'red', index: 0 }, 1: { text: 'UP', color: 'green', index: 1 } } }];
const PCT_DISK = [[null, 'green'], [0.8, 'yellow'], [0.9, 'red']];

function dashboard(uid, title, description, tags, extraVars = [], links = []) {
  const d = {
    uid, title, description, tags, editable: false, graphTooltip: 1, schemaVersion: 39, version: 1, timezone: 'browser', refresh: '30s', style: 'dark',
    time: { from: 'now-6h', to: 'now' }, fiscalYearStartMonth: 0, liveNow: false, links,
    templating: { list: [{ type: 'datasource', name: 'datasource', label: 'Источник', query: 'prometheus', current: { text: 'Prometheus (Relay)', value: 'relay-prometheus' }, hide: 0, refresh: 1, regex: '', options: [] }, ...extraVars] },
    annotations: { list: [{ builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' }] },
    panels: panels.splice(0).map((p) => JSON.parse(JSON.stringify(p))),
  };
  nextId = 1; x = 0; y = 0; rowH = 0;
  return d;
}
const save = (name, d) => { writeFileSync(OUT + name, JSON.stringify(d, null, 2) + '\n'); console.log('записан', name, `(${d.panels.length} панелей)`); };
const DASH_LINKS = [
  { title: 'Node Exporter Full', type: 'link', url: '/d/relay-node-full', icon: 'dashboard', targetBlank: false },
  { title: 'NoxVC — PostgreSQL', type: 'link', url: '/d/relay-postgres', icon: 'dashboard', targetBlank: false },
  { title: 'PostgreSQL (подробно)', type: 'link', url: '/d/relay-pg-detail', icon: 'dashboard', targetBlank: false },
];

// =====================================================================
// Relay — Live Overview
// =====================================================================
const NODE = 'job="node"';
const FS = `${NODE},fstype=~"ext4|xfs|btrfs"`;
const NET = `${NODE},device!~"lo|veth.*|docker.*|br-.*"`;

row('Сейчас');
stat('Зарегистрировано', 'relay_users_registered', { desc: 'Аккаунты в БД (обновляется раз в минуту)' });
stat('Онлайн', 'relay_users_online', { desc: 'Пользователи хотя бы с одним живым соединением' });
stat('В голосе', 'relay_voice_participants', { desc: 'Участники голосовых каналов и звонков' });
stat('Демонстрации экрана', 'relay_streams_active');
stat('Соединения gateway', 'relay_gateway_connections', { desc: 'Открытые WebSocket-соединения' });
stat('Backend', 'up{job="relay-backend"}', { mappings: UPDOWN, thresholds: [[null, 'red'], [1, 'green']], graph: 'none', colorMode: 'background' });

row('Приглашения');
stat('Ожидают решения', 'relay_invite_requests{status="pending"}', { w: 4, thresholds: [[null, 'green'], [1, 'yellow']], desc: 'Запросы участников на приглашение (Настройки → Приглашения (админ))' });
stat('Активные коды', 'relay_registration_invites{state="active"}', { w: 4 });
stat('Регистраций по кодам', 'relay_registration_invites{state="used"}', { w: 4 });
stat('Неверные коды (сутки)', 'sum(increase(relay_registration_rejected_total{reason="invalid_code"}[1d])) or vector(0)', { w: 4, thresholds: [[null, 'green'], [10, 'yellow'], [50, 'red']] });
ts('Запросы по статусу', [t('relay_invite_requests', '{{status}}')], { w: 4, h: 4 });
ts('Коды по состоянию', [t('relay_registration_invites', '{{state}}')], { w: 4, h: 4 });

row('Активность');
ts('Онлайн и голос — 24 часа', [t('relay_users_online', 'онлайн'), t('relay_voice_participants', 'в голосе'), t('relay_voice_channels_active', 'активных голосовых каналов')], { timeFrom: '24h', w: 24 });
ts('Сообщения в минуту', [t(`sum by (kind) (rate(relay_messages_created_total[${RI}])) * 60`, '{{kind}}')], { stack: true, unit: 'short' });
ts('Загрузки в минуту', [t(`sum by (type) (rate(relay_uploads_total[${RI}])) * 60`, '{{type}}'), t(`sum(rate(relay_upload_bytes_total[${RI}]))`, 'объём')], {
  overrides: [{ matcher: { id: 'byName', options: 'объём' }, properties: [{ id: 'unit', value: 'Bps' }, { id: 'custom.axisPlacement', value: 'right' }] }],
});
ts('Входы в минуту', [t(`sum by (result) (rate(relay_logins_total[${RI}])) * 60`, '{{result}}')], {
  overrides: [{ matcher: { id: 'byName', options: 'failure' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }] },
    { matcher: { id: 'byName', options: 'success' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'green' } }] }],
});
ts('Регистрации и входы в голос (за час)', [t('sum(increase(relay_registrations_total[1h]))', 'регистрации'), t('sum(increase(relay_voice_joins_total[1h]))', 'входы в голос'), t('sum(increase(relay_gateway_reconnects_total[1h]))', 'переподключения gateway (RESUME)')], { bars: false });

row('HTTP');
stat('Запросов в секунду', `sum(rate(relay_http_requests_total[${RI}]))`, { unit: 'reqps', decimals: 2, w: 6 });
stat('Доля 5xx', `(sum(rate(relay_http_requests_total{status=~"5.."}[${RI}])) or vector(0)) / sum(rate(relay_http_requests_total[${RI}]))`, { unit: 'percentunit', decimals: 2, w: 6, thresholds: [[null, 'green'], [0.01, 'yellow'], [0.05, 'red']] });
stat('p95 латентность (без gateway)', `histogram_quantile(0.95, sum by (le) (rate(relay_http_request_duration_seconds_bucket{route!="/gateway"}[${RI}])))`, { unit: 's', w: 6, thresholds: [[null, 'green'], [0.3, 'yellow'], [1, 'red']] });
stat('Доля 4xx', `(sum(rate(relay_http_requests_total{status=~"4.."}[${RI}])) or vector(0)) / sum(rate(relay_http_requests_total[${RI}]))`, { unit: 'percentunit', decimals: 2, w: 6, thresholds: [[null, 'green'], [0.2, 'yellow']] });
ts('Запросы по классам ответа', [t(`sum by (class) (label_replace(rate(relay_http_requests_total[${RI}]), "class", "\${1}xx", "status", "(\\\\d).."))`, '{{class}}')], { unit: 'reqps', stack: true });
ts('Латентность HTTP (без gateway)', ['0.5', '0.95', '0.99'].map((q) => t(`histogram_quantile(${q}, sum by (le) (rate(relay_http_request_duration_seconds_bucket{route!="/gateway"}[${RI}])))`, `p${Number(q) * 100}`)), { unit: 's' });
bargauge('Топ-10 маршрутов по p95 (5 мин)', `topk(10, histogram_quantile(0.95, sum by (le, method, route) (rate(relay_http_request_duration_seconds_bucket{route!="/gateway"}[5m]))) > 0)`, '{{method}} {{route}}',
  { thresholds: [[null, 'green'], [0.3, 'yellow'], [1, 'red']], h: 10 });
bargauge('Топ-10 маршрутов по запросам/с (5 мин)', `topk(10, sum by (method, route) (rate(relay_http_requests_total[5m])))`, '{{method}} {{route}}', { unit: 'reqps', h: 10 });

row('Процесс Relay и БД со стороны приложения');
ts('CPU процесса', [t(`rate(process_cpu_seconds_total{job="relay-backend"}[${RI}])`, 'ядер')], { unit: 'short', w: 6 });
ts('Память (RSS)', [t('process_resident_memory_bytes{job="relay-backend"}', 'RSS')], { unit: 'bytes', w: 6 });
ts('Файловые дескрипторы', [t('process_open_fds{job="relay-backend"}', 'открыто'), t('process_max_fds{job="relay-backend"}', 'лимит')], { w: 6 });
stat('Время работы', 'time() - process_start_time_seconds{job="relay-backend"}', { unit: 's', w: 6, h: 8, graph: 'none' });
ts('Пул БД', [t('relay_db_pool_connections', '{{state}}'), t('relay_db_pool_max', 'максимум')], { stack: false, w: 8 });
ts('Ожидание соединения из пула', ['0.5', '0.95', '0.99'].map((q) => t(`histogram_quantile(${q}, sum by (le) (rate(relay_db_pool_acquire_duration_seconds_bucket[5m])))`, `p${Number(q) * 100}`)), { unit: 's', w: 8, thresholds: [[null, 'green'], [0.1, 'red']] });
ts('Ошибки БД', [t(`sum by (kind) (rate(relay_db_errors_total[${RI}])) * 60`, '{{kind}}')], { unit: 'short', w: 8, desc: 'В минуту' });
ts('Операции БД: p95 по имени', [t(`histogram_quantile(0.95, sum by (le, query) (rate(relay_db_query_duration_seconds_bucket[5m])))`, '{{query}}')], { unit: 's', w: 12 });
ts('Очередь обработки медиа', [t('relay_media_queue_length', 'в очереди'), t(`sum by (target, result) (increase(relay_media_jobs_total[5m]))`, '{{target}} {{result}} / 5 мин')], { w: 12 });

row('Хранилище файлов (Garage S3)');
stat('Объём', 'relay_storage_bytes', { unit: 'bytes', w: 4 });
stat('Файлов', 'relay_storage_objects', { w: 4 });
stat('Garage', 'up{job="garage"}', { mappings: UPDOWN, thresholds: [[null, 'red'], [1, 'green']], graph: 'none', colorMode: 'background', w: 4 });
stat('Свободно на диске Garage', 'min(garage_local_disk_avail{job="garage", volume="data"})', { unit: 'bytes', w: 4, graph: 'none' });
stat('Ошибки хранилища (час)', 'sum(increase(relay_storage_operations_total{result="failure"}[1h])) or vector(0)', { w: 4, thresholds: [[null, 'green'], [1, 'red']] });
stat('Отдача файлов p95', `histogram_quantile(0.95, sum by (le) (rate(relay_storage_operation_duration_seconds_bucket{op="serve"}[5m])))`, { unit: 's', w: 4, thresholds: [[null, 'green'], [0.5, 'yellow'], [2, 'red']] });
ts('Операции хранилища', [t(`sum by (op, result) (rate(relay_storage_operations_total[${RI}]))`, '{{op}} {{result}}')], { unit: 'ops' });
ts('Время операций хранилища p95', [t(`histogram_quantile(0.95, sum by (le, op) (rate(relay_storage_operation_duration_seconds_bucket[5m])))`, '{{op}}')], { unit: 's' });

row('Голос (LiveKit SFU)');
stat('Комнаты', 'sum(livekit_room_total)', { w: 4 });
stat('Участники', 'sum(livekit_participant_total)', { w: 4 });
stat('Опубликованные треки', 'sum(livekit_track_published_total)', { w: 4 });
stat('LiveKit', 'up{job="livekit"}', { mappings: UPDOWN, thresholds: [[null, 'red'], [1, 'green']], graph: 'none', colorMode: 'background', w: 4 });
stat('Потери пакетов', `sum(rate(livekit_packet_loss_total[5m])) / clamp_min(sum(rate(livekit_packet_total[5m])), 1)`, { unit: 'percentunit', decimals: 2, w: 4, thresholds: [[null, 'green'], [0.02, 'yellow'], [0.05, 'red']] });
stat('RTT p95', `histogram_quantile(0.95, sum by (le) (rate(livekit_rtt_ms_bucket[5m])))`, { unit: 'ms', w: 4, thresholds: [[null, 'green'], [150, 'yellow'], [300, 'red']] });
ts('Битрейт SFU', [t(`sum by (direction) (rate(livekit_packet_bytes[${RI}])) * 8`, '{{direction}}')], { unit: 'bps' });
ts('Потери и порядок пакетов', [t(`sum(rate(livekit_packet_loss_total[${RI}]))`, 'потеряно/с'), t(`sum(rate(livekit_nack_total[${RI}]))`, 'NACK/с'), t(`sum(rate(livekit_pli_total[${RI}]))`, 'PLI/с')], { unit: 'short' });

row('Сервер (кратко)');
gauge('CPU', `1 - avg(rate(node_cpu_seconds_total{${NODE},mode="idle"}[${RI}]))`, { thresholds: [[null, 'green'], [0.7, 'yellow'], [0.9, 'red']] });
gauge('Память', `1 - node_memory_MemAvailable_bytes{${NODE}} / node_memory_MemTotal_bytes{${NODE}}`, { thresholds: [[null, 'green'], [0.8, 'yellow'], [0.9, 'red']] });
gauge('Диск / (система, Docker)', `1 - node_filesystem_avail_bytes{${FS},mountpoint="/"} / node_filesystem_size_bytes{${FS},mountpoint="/"}`, { thresholds: PCT_DISK });
ts('Сеть сервера', [t(`sum(rate(node_network_receive_bytes_total{${NET}}[${RI}])) * 8`, 'вход'), t(`-sum(rate(node_network_transmit_bytes_total{${NET}}[${RI}])) * 8`, 'выход')], { unit: 'bps', w: 12, h: 7 });
ts('Нагрузка (load average)', [t(`node_load1{${NODE}}`, '1 мин'), t(`node_load5{${NODE}}`, '5 мин'), t(`count(node_cpu_seconds_total{${NODE},mode="idle"})`, 'ядер')], { w: 12, h: 7 });

save('relay-overview.json', dashboard('relay-overview', 'NoxVC — Live Overview', 'Пользователи, голос, HTTP, процесс, БД со стороны приложения, хранилище, SFU, сервер', ['relay'], [], DASH_LINKS));

// =====================================================================
// Relay — PostgreSQL
// =====================================================================
const PG = 'job="postgres"';
const DB = `${PG},datname="relay"`;
row('Состояние');
stat('PostgreSQL', `pg_up{${PG}}`, { mappings: UPDOWN, thresholds: [[null, 'red'], [1, 'green']], graph: 'none', colorMode: 'background', w: 3 });
stat('Версия', [t(`pg_static{${PG}}`, '{{short_version}}')], { w: 3, graph: 'none', textMode: 'name' });
stat('Аптайм', `time() - pg_postmaster_start_time_seconds{${PG}}`, { unit: 's', w: 3, graph: 'none' });
stat('Размер БД relay', `relay_pg_db_size_bytes{${DB}}`, { unit: 'bytes', w: 3 });
stat('Подключения / max', `sum(pg_stat_activity_count{${PG}}) / max(pg_settings_max_connections{${PG}})`, { unit: 'percentunit', w: 4, thresholds: [[null, 'green'], [0.6, 'yellow'], [0.8, 'red']] });
stat('TPS', `sum(rate(pg_stat_database_xact_commit{${DB}}[${RI}]) + rate(pg_stat_database_xact_rollback{${DB}}[${RI}]))`, { unit: 'short', decimals: 1, w: 4 });
stat('Cache hit ratio', `sum(rate(pg_stat_database_blks_hit{${DB}}[5m])) / clamp_min(sum(rate(pg_stat_database_blks_hit{${DB}}[5m])) + sum(rate(pg_stat_database_blks_read{${DB}}[5m])), 1e-9)`,
  { unit: 'percentunit', decimals: 2, w: 4, thresholds: [[null, 'red'], [0.95, 'yellow'], [0.99, 'green']] });

row('Подключения и транзакции');
ts('Подключения по состоянию', [t(`sum by (state) (pg_stat_activity_count{${PG},datname="relay"})`, '{{state}}'), t(`max(pg_settings_max_connections{${PG}})`, 'max_connections')], { w: 8 });
ts('Транзакции', [t(`sum(rate(pg_stat_database_xact_commit{${DB}}[${RI}]))`, 'commit'), t(`sum(rate(pg_stat_database_xact_rollback{${DB}}[${RI}]))`, 'rollback')], { unit: 'ops', w: 8 });
ts('Дедлоки и конфликты', [t(`sum(increase(pg_stat_database_deadlocks{${DB}}[5m]))`, 'дедлоки / 5 мин'), t(`sum(increase(pg_stat_database_conflicts{${DB}}[5m]))`, 'конфликты / 5 мин')], { w: 8, bars: true });
ts('Блокировки по типам', [t(`sum by (mode) (pg_locks_count{${PG},datname="relay"})`, '{{mode}}')], { w: 12, stack: true });
ts('Долгие транзакции', [t(`relay_pg_oldest_xact_seconds{${PG}}`, 'самая старая транзакция'), t(`relay_pg_idle_in_xact_max_seconds{${PG}}`, 'самый долгий idle in transaction')],
  { unit: 's', w: 12, thresholds: [[null, 'green'], [60, 'yellow'], [600, 'red']] });

row('Чтение и запись');
ts('Строки (tuples) в секунду', ['fetched', 'returned', 'inserted', 'updated', 'deleted'].map((k) => t(`sum(rate(pg_stat_database_tup_${k}{${DB}}[${RI}]))`, k)), { unit: 'short', w: 12 });
ts('Временные файлы', [t(`sum(rate(pg_stat_database_temp_files{${DB}}[${RI}]))`, 'файлов/с'), t(`sum(rate(pg_stat_database_temp_bytes{${DB}}[${RI}]))`, 'байт/с')], {
  w: 12, overrides: [{ matcher: { id: 'byName', options: 'байт/с' }, properties: [{ id: 'unit', value: 'Bps' }, { id: 'custom.axisPlacement', value: 'right' }] }],
});

row('Чекпоинты, bgwriter, WAL');
ts('Чекпоинты', [t(`rate(pg_stat_bgwriter_checkpoints_timed_total{${PG}}[${RI}]) * 3600`, 'по времени / ч'), t(`rate(pg_stat_bgwriter_checkpoints_req_total{${PG}}[${RI}]) * 3600`, 'по запросу / ч')], { w: 8 });
ts('Время записи чекпоинтов', [t(`rate(pg_stat_bgwriter_checkpoint_write_time_total{${PG}}[${RI}]) / 1000`, 'запись'), t(`rate(pg_stat_bgwriter_checkpoint_sync_time_total{${PG}}[${RI}]) / 1000`, 'sync')], { unit: 'percentunit', w: 8, desc: 'Доля времени' });
ts('Буферы', [t(`rate(pg_stat_bgwriter_buffers_checkpoint_total{${PG}}[${RI}])`, 'checkpoint'), t(`rate(pg_stat_bgwriter_buffers_clean_total{${PG}}[${RI}])`, 'bgwriter'), t(`rate(pg_stat_bgwriter_buffers_backend_total{${PG}}[${RI}])`, 'backend')], { unit: 'short', w: 8 });
ts('WAL: генерация', [t(`rate(relay_pg_wal_bytes_total{${PG}}[${RI}])`, 'запись в WAL'), t(`pg_wal_size_bytes{${PG}}`, 'размер каталога WAL')], {
  w: 12, unit: 'Bps', overrides: [{ matcher: { id: 'byName', options: 'размер каталога WAL' }, properties: [{ id: 'unit', value: 'bytes' }, { id: 'custom.axisPlacement', value: 'right' }] }],
});
ts('XID age', [t(`relay_pg_xid_age{${PG}}`, '{{datname}}')], { w: 12, thresholds: [[null, 'green'], [5e8, 'yellow'], [1e9, 'red']] });

row('Таблицы');
bargauge('Топ-15 таблиц и индексов по размеру', `relay_pg_relation_total_bytes{${PG}}`, '{{relname}} ({{kind}})', { unit: 'bytes', h: 10 });
ts('Рост топ-таблиц', [t(`relay_pg_relation_total_bytes{${PG},kind="table"}`, '{{relname}}')], { unit: 'bytes', h: 10, legendCalcs: ['lastNotNull'] });
bargauge('Мёртвые строки', `relay_pg_table_dead_tuples{${PG}}`, '{{relname}}', { unit: 'short', h: 8, thresholds: [[null, 'green'], [10000, 'yellow'], [100000, 'red']] });
bargauge('С последнего (auto)vacuum', `relay_pg_table_seconds_since_vacuum{${PG}} >= 0`, '{{relname}}', { unit: 's', h: 8, thresholds: [[null, 'green'], [86400 * 3, 'yellow'], [86400 * 14, 'red']] });

row('Медленные запросы (pg_stat_statements)');
table('Топ-10 по суммарному времени', [t(`relay_pg_stmt_total_seconds{${PG}}`, '', { instant: true, format: 'table' }), t(`relay_pg_stmt_total_calls{${PG}}`, '', { instant: true, format: 'table' }), t(`relay_pg_stmt_total_mean_seconds{${PG}}`, '', { instant: true, format: 'table' })], {
  organize: { excludeByName: { Time: true, __name__: true, instance: true, job: true }, renameByName: { query: 'Запрос', queryid: 'queryid', 'Value #A': 'Всего, с', 'Value #B': 'Вызовов', 'Value #C': 'Среднее, с' }, indexByName: { query: 0, 'Value #A': 1, 'Value #B': 2, 'Value #C': 3, queryid: 4 } },
  overrides: [{ matcher: { id: 'byName', options: 'Среднее, с' }, properties: [{ id: 'unit', value: 's' }] }, { matcher: { id: 'byName', options: 'Всего, с' }, properties: [{ id: 'unit', value: 's' }] }],
});
table('Топ-10 по среднему времени (от 5 вызовов)', [t(`relay_pg_stmt_mean_mean_seconds{${PG}}`, '', { instant: true, format: 'table' }), t(`relay_pg_stmt_mean_calls{${PG}}`, '', { instant: true, format: 'table' })], {
  organize: { excludeByName: { Time: true, __name__: true, instance: true, job: true }, renameByName: { query: 'Запрос', 'Value #A': 'Среднее, с', 'Value #B': 'Вызовов' }, indexByName: { query: 0, 'Value #A': 1, 'Value #B': 2, queryid: 3 } },
  overrides: [{ matcher: { id: 'byName', options: 'Среднее, с' }, properties: [{ id: 'unit', value: 's' }] }],
});

row('Со стороны приложения');
ts('Операции БД: p95 по имени', [t(`histogram_quantile(0.95, sum by (le, query) (rate(relay_db_query_duration_seconds_bucket[5m])))`, '{{query}}')], { unit: 's', w: 8 });
ts('Ожидание соединения из пула', ['0.5', '0.95', '0.99'].map((q) => t(`histogram_quantile(${q}, sum by (le) (rate(relay_db_pool_acquire_duration_seconds_bucket[5m])))`, `p${Number(q) * 100}`)), { unit: 's', w: 8, thresholds: [[null, 'green'], [0.1, 'red']] });
ts('Ошибки БД в приложении', [t(`sum by (kind) (increase(relay_db_errors_total[5m]))`, '{{kind}}')], { w: 8, bars: true });

save('relay-postgres.json', dashboard('relay-postgres', 'NoxVC — PostgreSQL', 'PostgreSQL Relay: подключения, транзакции, блокировки, таблицы, медленные запросы, приложение', ['relay', 'postgres'], [], DASH_LINKS));


// =====================================================================
// Готовые дашборды grafana.com — подгонка
// =====================================================================
const dsVar = (name) => ({ type: 'datasource', name, label: 'Источник', query: 'prometheus', current: { text: 'Prometheus (Relay)', value: 'relay-prometheus' }, hide: 0, refresh: 1, regex: '', options: [] });

const node = JSON.parse(readFileSync(here('./upstream/1860.json'), 'utf8'));
delete node.__inputs; delete node.__requires; delete node.id;
node.uid = 'relay-node-full';
node.tags = [...new Set([...(node.tags || []), 'relay'])];
node.templating.list = node.templating.list.map((v) => (v.type === 'datasource' ? { ...dsVar(v.name) } : v));
node.links = [...(node.links || []), ...DASH_LINKS.filter((l) => l.url !== '/d/relay-node-full'), { title: 'NoxVC — Live Overview', type: 'link', url: '/d/relay-overview', icon: 'dashboard' }];
save('node-exporter-full.json', node);

const pg = JSON.parse(readFileSync(here('./upstream/9628.json'), 'utf8'));
delete pg.__inputs; delete pg.__requires; delete pg.id;
pg.uid = 'relay-pg-detail';
pg.title = 'PostgreSQL (подробно)';
pg.tags = [...new Set([...(pg.tags || []), 'relay'])];
const hiddenEmpty = (name) => ({ type: 'custom', name, query: '', current: { text: '', value: '' }, options: [{ text: '', value: '', selected: true }], hide: 2 });
pg.templating.list = pg.templating.list.map((v) => {
  if (v.type === 'datasource') return dsVar(v.name);
  // метки Kubernetes (namespace, release) у нас отсутствуют: пустое значение в PromQL совпадает с «меток нет»
  if (v.name === 'namespace' || v.name === 'release') return hiddenEmpty(v.name);
  if (v.name === 'instance') return { ...v, query: { query: 'label_values(pg_up{job="postgres"}, instance)', refId: 'instance' }, definition: 'label_values(pg_up{job="postgres"}, instance)', datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' } };
  if (v.name === 'datname') return { ...v, query: { query: 'label_values(pg_stat_database_tup_fetched{job="postgres"}, datname)', refId: 'datname' }, definition: 'label_values(pg_stat_database_tup_fetched{job="postgres"}, datname)' };
  return v;
});
pg.links = [...(pg.links || []), ...DASH_LINKS.filter((l) => l.url !== '/d/relay-pg-detail')];
save('postgresql-detail.json', pg);

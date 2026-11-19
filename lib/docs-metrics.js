/**
 * dsh-context-relay — relay 文档埋点（relay-docs-v2 §2.4/§4，失败降级）。
 *
 * 只记录事件，不存正文 / query 原文 / 用户消息 / relay 根外路径：
 *   .scratch/context-relay/metrics/<sessionId>.ndjson，每会话 ≤200 行滚动覆盖最旧。
 *   inject：site/level/bytes/groups[{g,n,b}]/digest/policy（inIndex 归因用内存路径集）
 *   read：path/origin/mode/bytes/inIndex/truncated
 *   search：queryHash/qlen/matches/scanned/truncated
 * 写失败只返回 false，调用方降级——索引/读取/检索结果不受埋点影响。
 *
 * @module dsh-context-relay/docs-metrics
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { relayRootOf } from './docs.js';

export const METRICS_VERSION = 1;
export const METRICS_MAX_LINES = 200;
export const METRICS_POLICY = 'docs-v2';

const RELAY_PREFIX = '.scratch/context-relay/';
/** 本进程内的 inIndex 归因（重启后未知记 null）。 */
const injectedPaths = new Map();
const searchedPaths = new Map();
const sessionSeqs = new Map();
/** 进程内归因表只留最近 256 个会话，避免长宿主会话数无界增长。 */
const capMap = (map, max = 256) => { while (map.size > max) map.delete(map.keys().next().value); };

const num = (value) => (Number.isFinite(value) ? value : 0);
const sessionKeyOf = (sessionId) => String(sessionId ?? 'unknown');
export const safeSessionId = (sessionId) => {
  const text = sessionKeyOf(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return text === '' ? 'unknown' : text;
};

/** 事件路径统一成 relay 相对路径（保留 relay 根内路径，不越界）。 */
export function metricsPathOf(path) {
  let value = String(path ?? '').trim();
  value = value.replace(/^\.\//, '');
  if (value.startsWith(RELAY_PREFIX)) value = value.slice(RELAY_PREFIX.length);
  return value;
}

export function metricsDirOf(cwd) {
  return join(relayRootOf(cwd), 'metrics');
}

export function metricsFileOf(cwd, sessionId) {
  return join(metricsDirOf(cwd), safeSessionId(sessionId) + '.ndjson');
}

function metricsRelativePathOf(cwd, sessionId) {
  return RELAY_PREFIX + 'metrics/' + safeSessionId(sessionId) + '.ndjson';
}

function nextSeq(sessionId) {
  const key = sessionKeyOf(sessionId);
  const next = (sessionSeqs.get(key) ?? 0) + 1;
  sessionSeqs.set(key, next);
  capMap(sessionSeqs);
  return next;
}

/** 原子滚动写：全量 ≤200 行（最旧覆盖）；失败返回 false，不抛。 */
function appendEvent(cwd, sessionId, event) {
  try {
    const file = metricsFileOf(cwd, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    let lines = [];
    if (existsSync(file)) {
      try { lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== ''); } catch { lines = []; }
    }
    lines.push(JSON.stringify(event));
    if (lines.length > METRICS_MAX_LINES) lines = lines.slice(-METRICS_MAX_LINES);
    const tmp = file + '.tmp-' + process.pid;
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function groupsOfRendered(rendered) {
  return (Array.isArray(rendered?.groups) ? rendered.groups : []).map((group) => ({
    g: String(group?.dir ?? '') === '' ? '.' : String(group.dir),
    n: num(group?.count),
    b: num(group?.bytes),
  }));
}

/** 记录一次文档索引注入（site: handoff / organize-brief / index）。 */
export function noteInjection({ cwd, sessionId, site, rendered, policy = METRICS_POLICY } = {}) {
  try {
    const paths = (Array.isArray(rendered?.paths) ? rendered.paths : []).map(metricsPathOf).filter((path) => path !== '');
    injectedPaths.set(sessionKeyOf(sessionId), new Map(paths.map((path) => [path, Date.now()])));
    capMap(injectedPaths);
    const event = {
      v: METRICS_VERSION,
      ts: Date.now(),
      sessionId: sessionKeyOf(sessionId),
      seq: nextSeq(sessionId),
      type: 'inject',
      site: String(site ?? 'unknown'),
      level: String(rendered?.level ?? 'A'),
      bytes: num(rendered?.bytes),
      groups: groupsOfRendered(rendered),
      digest: String(rendered?.digest ?? ''),
      policy,
    };
    return appendEvent(cwd, sessionId, event) ? event : undefined;
  } catch { return undefined; }
}

/** 记录一次读取（origin: index|search|list|pointer|unknown；inIndex 由注入路径集归因）。 */
export function recordRead({ cwd, sessionId, path, origin, mode = 'whole', bytes = 0, truncated = false } = {}) {
  try {
    const rel = metricsPathOf(path);
    const known = injectedPaths.get(sessionKeyOf(sessionId));
    const inIndex = known === undefined ? null : known.has(rel);
    const searched = searchedPaths.get(sessionKeyOf(sessionId));
    const resolvedOrigin = inIndex === true ? 'index' : (searched?.has(rel) === true ? 'search' : String(origin ?? 'unknown'));
    const event = {
      v: METRICS_VERSION,
      ts: Date.now(),
      sessionId: sessionKeyOf(sessionId),
      seq: nextSeq(sessionId),
      type: 'read',
      path: rel,
      origin: resolvedOrigin,
      mode: ['whole', 'section', 'range'].includes(mode) ? mode : 'whole',
      bytes: num(bytes),
      inIndex,
      truncated: truncated === true,
    };
    return appendEvent(cwd, sessionId, event) ? event : undefined;
  } catch { return undefined; }
}

/** 记录一次检索：只存 queryHash + 长度，绝不落 query 原文。 */
export function recordSearch({ cwd, sessionId, query, matches = [], scanned = 0, truncated = false } = {}) {
  try {
    const text = String(query ?? '');
    const paths = (Array.isArray(matches) ? matches : []).map(metricsPathOf).filter((path) => path !== '');
    searchedPaths.set(sessionKeyOf(sessionId), new Set(paths));
    capMap(searchedPaths);
    const event = {
      v: METRICS_VERSION,
      ts: Date.now(),
      sessionId: sessionKeyOf(sessionId),
      seq: nextSeq(sessionId),
      type: 'search',
      queryHash: createHash('sha1').update(text).digest('hex').slice(0, 12),
      qlen: Array.from(text).length,
      matches: paths.length,
      scanned: num(scanned),
      truncated: truncated === true,
    };
    return appendEvent(cwd, sessionId, event) ? event : undefined;
  } catch { return undefined; }
}

/** 读一个会话的埋点事件（坏行跳过并计数）。 */
export function readMetricsEvents(cwd, sessionId) {
  const file = metricsFileOf(cwd, sessionId);
  const events = [];
  let skipped = 0;
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return { events, skipped: 0, file, exists: false }; }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try { event = JSON.parse(line); } catch { skipped += 1; continue; }
    if (event === null || typeof event !== 'object' || event.v !== METRICS_VERSION) { skipped += 1; continue; }
    events.push(event);
  }
  return { events, skipped, file, exists: true };
}

/** 读一个 metrics 目录下的全部事件（周报用；坏行跳过）。 */
export function readMetricsDir(dir) {
  const events = [];
  let skipped = 0;
  let files = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { return { events, skipped, files }; }
  for (const name of names.filter((item) => item.endsWith('.ndjson'))) {
    files += 1;
    let raw = '';
    try { raw = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let event;
      try { event = JSON.parse(line); } catch { skipped += 1; continue; }
      if (event === null || typeof event !== 'object' || event.v !== METRICS_VERSION) { skipped += 1; continue; }
      events.push(event);
    }
  }
  return { events, skipped, files };
}

/** 会话内摘要（relay_status.docs）：只报计数/比率/最近一次注入，不带正文。 */
export function docsMetricsSnapshot({ cwd, sessionId } = {}) {
  const { events, skipped } = readMetricsEvents(cwd, sessionId);
  const injects = events.filter((event) => event.type === 'inject');
  const reads = events.filter((event) => event.type === 'read');
  const searches = events.filter((event) => event.type === 'search');
  const hits = reads.filter((event) => event.inIndex === true).length;
  const wholeReads = reads.filter((event) => event.mode === 'whole').length;
  const last = injects[injects.length - 1];
  const memory = injectedPaths.get(sessionKeyOf(sessionId));
  return {
    available: events.length > 0,
    file: metricsRelativePathOf(cwd, sessionId),
    events: events.length,
    injects: injects.length,
    reads: reads.length,
    searches: searches.length,
    hits,
    hitRate: reads.length === 0 ? null : hits / reads.length,
    wholeReads,
    wholeReadRate: reads.length === 0 ? null : wholeReads / reads.length,
    discover: reads.filter((event) => event.origin !== 'index').length,
    inIndex: memory === undefined ? null : memory.size,
    lastInject: last === undefined ? null : { at: last.ts, site: last.site, level: last.level, bytes: last.bytes, digest: last.digest },
    skipped: skipped > 0 ? skipped : undefined,
  };
}

const groupOfPath = (path) => {
  const rel = metricsPathOf(path);
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? '.' : rel.slice(0, cut);
};

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 按组聚合（relay-docs-v2 §2.4）：inject 次数/bytes、hits、hit%、wholeRead%、discover、
 * neverOpened（组级近似：注入组份数 − 组内被读过的不同路径数，只到组级避免单篇噪声）。
 */
export function aggregateDocsMetrics(events, { sinceMs = 0 } = {}) {
  const rows = new Map();
  const rowOf = (group) => {
    const key = group === '' ? '.' : group;
    if (!rows.has(key)) rows.set(key, { group: key, injects: 0, injectBytes: 0, docs: 0, reads: 0, hits: 0, wholeReads: 0, discover: 0, readPaths: new Set() });
    return rows.get(key);
  };
  const sessions = new Set();
  const lastInjectAt = new Map();
  const steps = [];
  let injects = 0, reads = 0, searches = 0, hits = 0, wholeReads = 0, discover = 0;
  (Array.isArray(events) ? events : []).forEach((event, index) => {
    if (event === null || typeof event !== 'object' || event.v !== METRICS_VERSION) return;
    if (Number.isFinite(sinceMs) && sinceMs > 0 && num(event.ts) < sinceMs) return;
    sessions.add(sessionKeyOf(event.sessionId));
    if (event.type === 'inject') {
      injects += 1;
      lastInjectAt.set(sessionKeyOf(event.sessionId), index);
      for (const group of Array.isArray(event.groups) ? event.groups : []) {
        const row = rowOf(String(group?.g ?? '.'));
        row.injects += 1;
        row.injectBytes += num(group?.b);
        row.docs = Math.max(row.docs, num(group?.n));
      }
    } else if (event.type === 'read') {
      reads += 1;
      const row = rowOf(groupOfPath(event.path));
      row.reads += 1;
      row.readPaths.add(metricsPathOf(event.path));
      if (event.inIndex === true) {
        hits += 1;
        row.hits += 1;
        const injected = lastInjectAt.get(sessionKeyOf(event.sessionId));
        if (Number.isFinite(injected)) steps.push(index - injected);
      }
      if (event.mode === 'whole') { wholeReads += 1; row.wholeReads += 1; }
      if (event.origin !== 'index') { discover += 1; row.discover += 1; }
    } else if (event.type === 'search') {
      searches += 1;
    }
  });
  const groups = [...rows.values()]
    .map((row) => ({
      group: row.group,
      injects: row.injects,
      injectBytes: row.injectBytes,
      docs: row.docs,
      reads: row.reads,
      hits: row.hits,
      hitRate: row.reads === 0 ? null : row.hits / row.reads,
      wholeReads: row.wholeReads,
      wholeReadRate: row.reads === 0 ? null : row.wholeReads / row.reads,
      discover: row.discover,
      neverOpened: Math.max(0, row.docs - row.readPaths.size),
    }))
    .sort((a, b) => b.injects - a.injects || a.group.localeCompare(b.group));
  return {
    sessions: sessions.size,
    injects,
    reads,
    searches,
    hits,
    hitRate: reads === 0 ? null : hits / reads,
    wholeReads,
    wholeReadRate: reads === 0 ? null : wholeReads / reads,
    discover,
    stepsMedian: medianOf(steps),
    groups,
    needSessions: 5,
    needInjects: 20,
    sufficient: sessions.size >= 5 && injects >= 20,
  };
}

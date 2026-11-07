/**
 * dsh-context-relay — 队友保鲜核心（P0）：工作记录 / 代际 / 体检 / 换代 prompt。
 *
 * 纯逻辑 + workspace 文件 IO，不依赖 host context（便于单测）。记录位置（可选 leadSessionId 分区）：
 *   .scratch/context-relay/team/<leadSessionId>/roster.json            # 分区：当前 Lead 会话的 lineage / 代际权威
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/profile.md    # 长期职责（Lead 初始化）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/checkpoint.md # 最近一次结构化交接（队友写）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/ledger.ndjson # 代际/事件索引（有界）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/handoffs/gen-<n>.md # 换代时固化
 *   .scratch/context-relay/team/{roster.json,<lineage>/...}             # legacy（不传 leadSessionId 时的旧路径；跨分区只读回退）
 *
 * 约束：DSH 队友名字永久、不可复用；代际命名为 <lineage>-g<N>（lower-kebab）。
 *
 * @module dsh-context-relay/agent/team
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** team 记录根（workspace 相对目录）；与 handoff/progress 同属 .scratch/context-relay。 */
export const TEAM_DIR = Object.freeze(['.scratch', 'context-relay', 'team']);

/** 记录/交接的硬上限（字节/条数）：防止队友把记录当垃圾场。 */
export const TEAM_LIMITS = Object.freeze({
  checkpointBytes: 4096,
  checkpointItems: 8,
  checkpointItemChars: 200,
  ledgerEntries: 200,
  ledgerBytes: 8192,
  promptBytes: 6000,
  profileBytes: 1024,
});

/** checkpoint 的列表字段（顺序即渲染顺序）。 */
export const CHECKPOINT_LISTS = Object.freeze(['done', 'decisions', 'evidence', 'constraints', 'next_actions', 'open_questions', 'failed_attempts', 'pointers']);

const CHECKPOINT_LABELS = Object.freeze({
  done: '完成',
  decisions: '决策',
  evidence: '证据',
  constraints: '约束',
  next_actions: '下一步',
  open_questions: '未决',
  failed_attempts: '失败尝试',
  pointers: '指针',
});

/** 换代默认使用的 subagent provider（官方 in-process spawn；见 dsh-subagent-spawn-in-process）。 */
export const TEAM_PROVIDER = 'spawn';

/** 分区 id 的合法字符集（leadSessionId / legacy 哨兵）：同时防路径穿越。 */
const PARTITION_ID = /^[A-Za-z0-9_-]+$/;

/** legacy 记录（v0.3.1 及以前的 <base>/ 根）在 listPartitions / planRehydrate 里的合成 id。 */
export const LEGACY_PARTITION_ID = 'legacy';

function partitionIdOf(leadSessionId) {
  if (leadSessionId === undefined || leadSessionId === null) return undefined;
  const id = String(leadSessionId).trim();
  if (id === '' || id === LEGACY_PARTITION_ID) return undefined; // legacy 哨兵 id = base 根
  if (!PARTITION_ID.test(id)) throw new Error('invalid partition id: ' + id);
  return id;
}

/** 记录根（base，workspace 相对）：与 handoff/progress 同属 .scratch/context-relay。 */
export function teamBaseOf(cwd) {
  return join(cwd, ...TEAM_DIR);
}

/** 记录根：带 leadSessionId → <base>/<sid>（分区）；不带（或 legacy 哨兵）→ base（legacy 旧行为）。 */
export function teamRootOf(cwd, leadSessionId) {
  const base = teamBaseOf(cwd);
  const id = partitionIdOf(leadSessionId);
  return id === undefined ? base : join(base, id);
}

export function teamRelativePath(...parts) {
  return TEAM_DIR.concat(parts).join('/');
}

/** teamRelativePath 的分区版：带 sid → .scratch/context-relay/team/<sid>/...；不带/legacy = 旧路径。 */
export function partitionRelativePath(leadSessionId, ...parts) {
  const id = partitionIdOf(leadSessionId);
  return id === undefined ? teamRelativePath(...parts) : teamRelativePath(id, ...parts);
}

/** 从队友名派生 lineage：w1-g2 → w1；无代际后缀则名字本身即 lineage。 */
export function lineageOf(name) {
  const text = String(name ?? '').trim();
  const match = text.match(/^(.*)-g(\d+)$/);
  return match === null ? text : match[1];
}

/** 从队友名取代际号；无后缀返回 1（首代默认）。 */
export function genOf(name) {
  const text = String(name ?? '').trim();
  const match = text.match(/^(.*)-g(\d+)$/);
  return match === null ? 1 : Math.max(1, Number(match[2]));
}

/** 下一个代际名：<lineage>-g<N>；跳过已被占用的名字。 */
export function nextGenName(lineage, usedNames = [], startGen = 0) {
  const base = String(lineage ?? '').trim();
  const used = new Set(Array.isArray(usedNames) ? usedNames.map((name) => String(name)) : []);
  let gen = Math.max(0, Math.trunc(startGen)) + 1;
  while (used.has(base + '-g' + gen)) gen += 1;
  return { name: base + '-g' + gen, gen };
}

/** 队友名合法性（与 DSH agent-team 同口径，防 spawn 时才报错）。 */
export function isValidTeammateName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && name !== 'lead' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function clipText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function atomicWrite(path, text) {
  const tmp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

// ── roster ─────────────────────────────────────────────────────────────

export function rosterPathOf(cwd, leadSessionId) {
  return join(teamRootOf(cwd, leadSessionId), 'roster.json');
}

export function emptyRoster() {
  return { version: 1, lineages: {} };
}

/** 防御式归一：旧/损坏文件不炸调用方；未知字段丢弃。 */
export function normalizeRoster(raw) {
  const roster = emptyRoster();
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return roster;
  const lineages = raw.lineages;
  if (lineages === undefined || lineages === null || typeof lineages !== 'object' || Array.isArray(lineages)) return roster;
  for (const [lineage, entry] of Object.entries(lineages)) {
    if (typeof lineage !== 'string' || lineage === '' || entry === null || typeof entry !== 'object') continue;
    const profile = entry.profile !== null && typeof entry.profile === 'object' ? entry.profile : {};
    const generations = Array.isArray(entry.generations) ? entry.generations : [];
    const cleanGenerations = [];
    for (const item of generations) {
      if (item === null || typeof item !== 'object') continue;
      const gen = Number.isInteger(item.gen) && item.gen > 0 ? item.gen : undefined;
      const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined;
      if (gen === undefined || name === undefined) continue;
      cleanGenerations.push({
        gen,
        name,
        sessionId: typeof item.sessionId === 'string' && item.sessionId !== '' ? item.sessionId : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        retiredAt: typeof item.retiredAt === 'string' ? item.retiredAt : undefined,
        reason: typeof item.reason === 'string' ? item.reason : undefined,
      });
    }
    roster.lineages[lineage] = {
      profile: {
        role: typeof profile.role === 'string' ? profile.role : '',
        description: typeof profile.description === 'string' ? profile.description : '',
        writeScopes: Array.isArray(profile.writeScopes) ? profile.writeScopes.filter((scope) => typeof scope === 'string') : [],
        createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : undefined,
      },
      generations: cleanGenerations,
      activeGen: Number.isInteger(entry.activeGen) && entry.activeGen > 0 ? entry.activeGen : (cleanGenerations.length > 0 ? cleanGenerations[cleanGenerations.length - 1].gen : 0),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
    };
  }
  return roster;
}

function parseRosterFile(path) {
  const text = readText(path);
  if (text === undefined) return emptyRoster();
  try {
    return normalizeRoster(JSON.parse(text));
  } catch {
    return emptyRoster();
  }
}

/** 精确读某个记录根（无回退）：rehydrate / 分区扫描用。 */
export function readRosterFromRoot(root) {
  return parseRosterFile(join(root, 'roster.json'));
}

/** 读 roster：先 <base>/<sid>/，文件不存在回退 legacy；都没有 = 空 roster。 */
export function readRoster(cwd, leadSessionId) {
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const path = rosterPathOf(cwd, id);
    if (existsSync(path)) return parseRosterFile(path);
  }
  return parseRosterFile(rosterPathOf(cwd));
}

export function writeRoster(cwd, roster, leadSessionId) {
  const root = teamRootOf(cwd, leadSessionId);
  const path = join(root, 'roster.json');
  mkdirSync(root, { recursive: true });
  atomicWrite(path, JSON.stringify(roster));
  return path;
}

/**
 * 确保 roster 里有该 lineage，并登记（或更新）一个代际。返回 lineage entry。
 * seed: { name?, sessionId?, gen?, role?, description?, writeScopes? }
 */
export function ensureLineage(roster, lineage, seed = {}) {
  const key = String(lineage ?? '').trim();
  if (key === '') throw new Error('lineage required');
  if (roster.lineages[key] === undefined) {
    roster.lineages[key] = {
      profile: {
        role: typeof seed.role === 'string' ? seed.role : '',
        description: typeof seed.description === 'string' ? seed.description : '',
        writeScopes: Array.isArray(seed.writeScopes) ? seed.writeScopes.filter((scope) => typeof scope === 'string').slice(0, 16) : [],
        createdAt: new Date().toISOString(),
      },
      generations: [],
      activeGen: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  const entry = roster.lineages[key];
  if (typeof seed.role === 'string' && seed.role !== '' && entry.profile.role === '') entry.profile.role = seed.role;
  if (typeof seed.description === 'string' && seed.description !== '' && entry.profile.description === '') entry.profile.description = seed.description;
  const name = typeof seed.name === 'string' && seed.name !== '' ? seed.name : undefined;
  if (name !== undefined) {
    const gen = Number.isInteger(seed.gen) && seed.gen > 0 ? seed.gen : genOf(name);
    let generation = entry.generations.find((item) => item.name === name);
    if (generation === undefined) {
      generation = { gen, name, sessionId: undefined, createdAt: new Date().toISOString(), retiredAt: undefined, reason: undefined };
      entry.generations.push(generation);
    }
    if (typeof seed.sessionId === 'string' && seed.sessionId !== '') generation.sessionId = seed.sessionId;
    if (generation.retiredAt === undefined) entry.activeGen = Math.max(entry.activeGen, generation.gen);
  }
  entry.updatedAt = new Date().toISOString();
  return entry;
}

/** 该 lineage 已用过的代际名（换代查重）。 */
export function usedNamesOf(entry) {
  return Array.isArray(entry?.generations) ? entry.generations.map((item) => item.name) : [];
}

/** 最新（未退休优先）代际。 */
export function activeGenerationOf(entry) {
  const generations = Array.isArray(entry?.generations) ? entry.generations : [];
  if (generations.length === 0) return undefined;
  const active = generations.filter((item) => item.retiredAt === undefined);
  const pool = active.length > 0 ? active : generations;
  return pool.reduce((best, item) => (item.gen > best.gen ? item : best), pool[0]);
}

export function retireGeneration(entry, name, reason) {
  if (entry === undefined || !Array.isArray(entry.generations)) return false;
  const generation = entry.generations.find((item) => item.name === name);
  if (generation === undefined) return false;
  generation.retiredAt = new Date().toISOString();
  generation.reason = clipText(reason, 200);
  entry.updatedAt = new Date().toISOString();
  return true;
}

// ── 文件路径 ───────────────────────────────────────────────────────────

export function lineageDirOf(cwd, lineage, leadSessionId) {
  return join(teamRootOf(cwd, leadSessionId), lineage);
}

export function profilePathOf(cwd, lineage, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'profile.md');
}

export function checkpointPathOf(cwd, lineage, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'checkpoint.md');
}

export function ledgerPathOf(cwd, lineage, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'ledger.ndjson');
}

export function handoffPathOf(cwd, lineage, gen, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'handoffs', 'gen-' + gen + '.md');
}

// ── checkpoint ─────────────────────────────────────────────────────────

function readCheckpointIn(root, lineage) {
  const path = join(root, lineage, 'checkpoint.md');
  if (!existsSync(path)) return undefined;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  const text = readText(path);
  if (text === undefined || text.trim() === '') return undefined;
  return { path, text, bytes: byteLength(text), updatedAt: new Date(stats.mtimeMs).toISOString() };
}

/** 精确读某个记录根的 checkpoint（无回退）。 */
export function readCheckpointFromRoot(root, lineage) {
  return readCheckpointIn(root, lineage);
}

/** 读 checkpoint：先 <base>/<sid>/<lineage>/，文件缺失回退 legacy。 */
export function readCheckpoint(cwd, lineage, leadSessionId) {
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const found = readCheckpointIn(teamRootOf(cwd, id), lineage);
    if (found !== undefined) return found;
  }
  return readCheckpointIn(teamBaseOf(cwd), lineage);
}

/**
 * 归一 checkpoint 输入并按 caps 渲染 markdown。
 * 返回 { ok:true, markdown, caps:{bytes,items,truncated} } 或 { ok:false, code, error }。
 */
export function buildCheckpointMarkdown({ lineage, name, gen, input = {}, now = new Date() } = {}) {
  const oneLine = clipText(input.one_line, 300);
  if (oneLine === '') return { ok: false, code: 'checkpoint-empty', error: 'one_line required' };
  const kind = clipText(input.kind ?? 'task', 24) || 'task';
  const taskId = clipText(input.task_id, 80);
  const lists = {};
  let items = 0;
  let truncated = false;
  for (const field of CHECKPOINT_LISTS) {
    const raw = Array.isArray(input[field]) ? input[field] : [];
    const clean = [];
    for (const item of raw) {
      const text = clipText(item, TEAM_LIMITS.checkpointItemChars);
      if (text === '') continue;
      if (clean.length >= TEAM_LIMITS.checkpointItems) { truncated = true; break; }
      clean.push(text);
    }
    if (raw.length > clean.length) truncated = true;
    lists[field] = clean;
    items += clean.length;
  }
  const lines = [
    '# 队友交接 · ' + String(name ?? '?') + '（' + String(lineage ?? '?') + ' 第 ' + String(gen ?? '?') + ' 代）',
    '> updated: ' + now.toISOString(),
    '> kind: ' + kind + (taskId === '' ? '' : ' · task: ' + taskId),
    '',
    '## 一行结论',
    oneLine,
  ];
  for (const field of CHECKPOINT_LISTS) {
    if (lists[field].length === 0) continue;
    lines.push('', '## ' + CHECKPOINT_LABELS[field]);
    for (const item of lists[field]) lines.push('- ' + item);
  }
  let markdown = lines.join('\n') + '\n';
  let capped = false;
  if (byteLength(markdown) > TEAM_LIMITS.checkpointBytes) {
    const suffix = '\n[checkpoint truncated: ' + TEAM_LIMITS.checkpointBytes + ' bytes cap]\n';
    const budget = Math.max(0, TEAM_LIMITS.checkpointBytes - byteLength(suffix));
    let body = markdown;
    while (byteLength(body) > budget) body = body.slice(0, -1);
    markdown = body + suffix;
    capped = true;
  }
  return { ok: true, markdown, caps: { bytes: byteLength(markdown), items, truncated: truncated || capped } };
}

export function writeCheckpoint(cwd, lineage, markdown, leadSessionId) {
  const path = checkpointPathOf(cwd, lineage, leadSessionId);
  mkdirSync(lineageDirOf(cwd, lineage, leadSessionId), { recursive: true });
  atomicWrite(path, markdown);
  return { path, bytes: byteLength(markdown) };
}

/**
 * 换代时把当前 checkpoint 固化为 handoffs/gen-<n>.md，并清掉 latest checkpoint。
 * 只读自己（legacy 或不带 sid 时的 base）的记录根：legacy 只读回退，绝不搬移/删除旧分区文件。
 */
export function archiveCheckpoint(cwd, lineage, gen, leadSessionId) {
  const root = teamRootOf(cwd, leadSessionId);
  // 读：分区优先、缺失回退 legacy（升级前记录也能换代固化）；写：一律写当前分区 handoffs/。
  let current = readCheckpointIn(root, lineage);
  if (current === undefined && leadSessionId !== undefined) current = readCheckpointIn(teamBaseOf(cwd), lineage);
  if (current === undefined) return undefined;
  const path = join(root, lineage, 'handoffs', 'gen-' + gen + '.md');
  mkdirSync(join(root, lineage, 'handoffs'), { recursive: true });
  atomicWrite(path, current.text);
  // 只清当前分区的 latest；legacy 记录只读，绝不搬移/删除旧分区文件。
  if (current.path === checkpointPathOf(cwd, lineage, leadSessionId)) {
    try { rmSync(current.path); } catch { /* 清 latest 失败不阻断换代 */ }
  }
  return { path, bytes: current.bytes };
}

function readProfileIn(root, lineage) {
  const text = readText(join(root, lineage, 'profile.md'));
  return text === undefined || text.trim() === '' ? undefined : text;
}

/** 精确读某个记录根的 profile（无回退）。 */
export function readProfileFromRoot(root, lineage) {
  return readProfileIn(root, lineage);
}

/** 读 profile：先 <base>/<sid>/<lineage>/，文件缺失/空文件回退 legacy。 */
export function readProfile(cwd, lineage, leadSessionId) {
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const text = readProfileIn(teamRootOf(cwd, id), lineage);
    if (text !== undefined) return text;
  }
  return readProfileIn(teamBaseOf(cwd), lineage);
}

// ── ledger ─────────────────────────────────────────────────────────────

function parseLedgerFile(path) {
  const text = readText(path);
  if (text === undefined) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); } catch { /* 损坏行跳过（记录不阻断） */ }
  }
  return entries;
}

function readLedgerIn(root, lineage, limit = 20) {
  return parseLedgerFile(join(root, lineage, 'ledger.ndjson')).slice(-Math.max(1, limit));
}

/** 精确读某个记录根的 ledger（无回退）。 */
export function readLedgerFromRoot(root, lineage, limit = 20) {
  return readLedgerIn(root, lineage, limit);
}

/**
 * 读 ledger：先 <base>/<sid>/<lineage>/，无记录回退 legacy。
 * 第三参可为 limit（数字，旧签名）或 leadSessionId（字符串，便捷写法）。
 */
export function readLedger(cwd, lineage, limit = 20, leadSessionId) {
  if (typeof limit === 'string') {
    leadSessionId = limit;
    limit = 20;
  }
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const entries = readLedgerIn(teamRootOf(cwd, id), lineage, limit);
    if (entries.length > 0) return entries;
  }
  return readLedgerIn(teamBaseOf(cwd), lineage, limit);
}

/** 追加一条 ledger（有界：条数 + 字节数，超限删最旧）；返回 {path, entries, bytes}。 */
export function appendLedger(cwd, lineage, entry, leadSessionId) {
  const root = teamRootOf(cwd, leadSessionId);
  const path = join(root, lineage, 'ledger.ndjson');
  mkdirSync(join(root, lineage), { recursive: true });
  const entries = readLedgerIn(root, lineage, TEAM_LIMITS.ledgerEntries);
  entries.push(entry);
  while (entries.length > TEAM_LIMITS.ledgerEntries) entries.shift();
  let text = entries.map((item) => JSON.stringify(item)).join('\n') + '\n';
  while (entries.length > 1 && byteLength(text) > TEAM_LIMITS.ledgerBytes) {
    entries.shift();
    text = entries.map((item) => JSON.stringify(item)).join('\n') + '\n';
  }
  atomicWrite(path, text);
  return { path, entries: entries.length, bytes: byteLength(text) };
}

export function formatLedgerPointers(entries, limit = 5) {
  const list = Array.isArray(entries) ? entries.slice(-Math.max(1, limit)) : [];
  return list.map((entry) => {
    const parts = ['gen=' + String(entry.gen ?? '?'), 'name=' + String(entry.name ?? '?')];
    if (typeof entry.sessionId === 'string' && entry.sessionId !== '') parts.push('session=' + entry.sessionId);
    if (typeof entry.handoff === 'string' && entry.handoff !== '') parts.push('handoff=' + entry.handoff);
    if (typeof entry.note === 'string' && entry.note !== '') parts.push(entry.note);
    return clipText(parts.join(' · '), 220);
  });
}

// ── 分区扫描 / rehydrate 计划 ──────────────────────────────────────────

/** 记录根内文件的最大 mtime（roster.json + 各 lineage 目录内文件，递归）。 */
function maxMtimeOf(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let max = 0;
  for (const item of entries) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (existsSync(join(path, 'roster.json'))) continue; // 分区目录不属于本根（legacy base 下混排）
      max = Math.max(max, maxMtimeOf(path));
      continue;
    }
    try {
      const stats = statSync(path);
      if (stats.mtimeMs > max) max = stats.mtimeMs;
    } catch { /* 不可读文件跳过 */ }
  }
  return max;
}

/** 记录根下的 lineage 摘要：roster 声明的 + 实际存在的目录（损坏 roster 退化为目录扫描）。 */
function lineagesOfRoot(root) {
  const roster = readRosterFromRoot(root);
  const names = new Set(Object.keys(roster.lineages));
  try {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const dir = join(root, item.name);
      if (existsSync(join(dir, 'roster.json'))) continue; // 分区目录，不是 lineage
      const isLineageDir = ['profile.md', 'checkpoint.md', 'ledger.ndjson', 'handoffs'].some((fileName) => existsSync(join(dir, fileName)));
      if (isLineageDir) names.add(item.name);
    }
  } catch { /* 根不可读：只用 roster */ }
  return [...names].sort().map((lineage) => {
    const checkpoint = readCheckpointIn(root, lineage);
    const entry = roster.lineages[lineage];
    return {
      lineage,
      hasCheckpoint: checkpoint !== undefined,
      hasProfile: readProfileIn(root, lineage) !== undefined,
      checkpointBytes: checkpoint === undefined ? 0 : checkpoint.bytes,
      activeGen: Number.isInteger(entry?.activeGen) ? entry.activeGen : 0,
      generations: Array.isArray(entry?.generations) ? entry.generations.map((item) => item.name) : [],
    };
  });
}

function partitionOf(id, root, kind) {
  return { id, root, kind, updatedAt: new Date(maxMtimeOf(root)).toISOString(), lineages: lineagesOfRoot(root) };
}

/**
 * 扫描记录根：<base> 下含 roster.json 的子目录（分区，id=目录名）+ legacy（<base> 自己有 roster.json，id='legacy'）。
 * updatedAt 降序（同刻按 id 字典序）；损坏文件容错（roster 损坏 = 空 roster，mtime 不可读 = 跳过）。
 */
export function listPartitions(cwd) {
  const base = teamBaseOf(cwd);
  const partitions = [];
  let entries = [];
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { entries = []; }
  for (const item of entries) {
    if (!item.isDirectory() || item.name === LEGACY_PARTITION_ID) continue; // legacy 是保留 id（映射 base 根）
    const root = join(base, item.name);
    if (!existsSync(join(root, 'roster.json'))) continue;
    partitions.push(partitionOf(item.name, root, 'partition'));
  }
  if (existsSync(join(base, 'roster.json'))) partitions.push(partitionOf(LEGACY_PARTITION_ID, base, 'legacy'));
  return partitions.sort((left, right) => (left.updatedAt === right.updatedAt ? left.id.localeCompare(right.id) : (left.updatedAt < right.updatedAt ? 1 : -1)));
}

/**
 * rehydrate 计划（只读）：from 缺省取「最新更新且非当前会话」的分区（含 legacy）；
 * 返回每条 lineage 的 spawn/skip 建议。显式 from 必须是合法且存在的分区 id。
 */
export function planRehydrate(cwd, { from, currentSessionId } = {}) {
  const partitions = listPartitions(cwd);
  let source;
  let usedDefault = false;
  if (from === undefined || from === null || String(from).trim() === '') {
    usedDefault = true;
    const current = currentSessionId === undefined || currentSessionId === null ? '' : String(currentSessionId).trim();
    const candidates = partitions.filter((item) => item.id !== current);
    if (candidates.length === 0) return { ok: false, code: 'partition-not-found', reason: '没有可用的记录分区（需先有 roster.json）' };
    source = candidates[0];
  } else {
    const wanted = String(from).trim();
    if (!PARTITION_ID.test(wanted)) return { ok: false, code: 'partition-not-found', reason: '非法分区 id：' + clipText(wanted, 80) + '（只允许 [A-Za-z0-9_-]）' };
    source = partitions.find((item) => item.id === wanted);
    if (source === undefined) return { ok: false, code: 'partition-not-found', reason: '分区不存在：' + wanted };
  }
  const roster = readRosterFromRoot(source.root);
  const warnings = [];
  const lineages = source.lineages.map((summary) => {
    const entry = roster.lineages[summary.lineage];
    const generation = activeGenerationOf(entry);
    const proposedName = typeof generation?.name === 'string' && generation.name !== '' ? generation.name : summary.lineage;
    const gen = Number.isInteger(generation?.gen) && generation.gen > 0 ? generation.gen : Math.max(1, genOf(proposedName));
    const record = {
      lineage: summary.lineage,
      proposedName,
      gen,
      hasCheckpoint: summary.hasCheckpoint,
      hasProfile: summary.hasProfile,
      profileRole: typeof entry?.profile?.role === 'string' ? entry.profile.role : '',
    };
    if (!summary.hasCheckpoint && !summary.hasProfile) return { ...record, action: 'skip', reason: 'no-record' };
    if (!summary.hasCheckpoint) warnings.push(summary.lineage + '：只有 profile 没有 checkpoint（记录不完整，spawn 后先核验再接手）');
    return { ...record, action: 'spawn' };
  });
  return {
    ok: true,
    from: source.id,
    defaultFrom: usedDefault,
    updatedAt: source.updatedAt,
    lineages,
    spawnCount: lineages.filter((item) => item.action === 'spawn').length,
    warnings,
  };
}

/** 换代注入 prompt：profile + 上一代交接 + ledger 召回指针 + 先核验再等活。有界 ≤ promptBytes。 */
export function buildRenewPrompt({ lineage, newName, gen, prevName, profile, checkpoint, ledger = [], leadSessionId, recordDir, maxBytes = TEAM_LIMITS.promptBytes } = {}) {
  const lines = [
    '# 你是队友 ' + String(newName ?? '?') + '（' + String(lineage ?? '?') + ' 第 ' + String(gen ?? '?') + ' 代）',
    '',
    '上一代队友 ' + String(prevName ?? '?') + ' 已归档；你不是从零开始，但也没有它的对话记忆。下面是它的工作记录，先读、先核验，再等 Lead 派活。',
    '',
    '## 长期职责（profile）',
    clipText(profile, 1200) || '（未提供；按 Lead 的任务卡执行）',
    '',
    '## 上一代交接（checkpoint）',
    String(checkpoint ?? '').trim() || '（没有 checkpoint：向 Lead 报告记录缺失，不要臆测）',
    '',
    '## 召回入口（链式，按需）',
    '- 记录目录：' + (recordDir ?? partitionRelativePath(leadSessionId, String(lineage ?? '?'))) + '/（profile / checkpoint / ledger / handoffs）',
    formatLedgerPointers(ledger).length === 0 ? '- 历史代际：暂无' : '- 历史代际：\n' + formatLedgerPointers(ledger).map((line) => '  ' + line).join('\n'),
    '- 旧会话可按需 session_event_read({session_id, seq})：同 workspace 有权限；快照权威 > 指针 > 旧会话，每轮 ≤3 跳、命中即停。',
    '',
    '## 开工前（先做这一步，再等任务）',
    '1. 用 1-2 个只读工具核验一个可判定事实（文件存在 / 测试命令 / git status），不要凭记录复述就自信；',
    '2. 回一句 ≤100 字：已接手 + 核验结果；',
    '3. 不要自行扩大任务范围；等 Lead 用消息派活。',
    '',
    '## 边界',
    '- 记录写自己 lineage 的 team 目录（checkpoint 用 relay_checkpoint 工具）；不压缩/不交接/不建队友（都是 Lead 的事）；',
    '- 上下文到线（band warn/organize）会通知你向 Lead 请示；不向人类提问、不自行换人。',
    '',
  ];
  let text = lines.join('\n');
  if (byteLength(text) > maxBytes) {
    const suffix = '\n[renew prompt truncated: ' + maxBytes + ' bytes cap]\n';
    const budget = Math.max(0, maxBytes - byteLength(suffix));
    while (byteLength(text) > budget) text = text.slice(0, -1);
    text += suffix;
  }
  return text;
}

/** 记录目录（相对 workspace）：from 是分区 → 带分区；legacy/未知 → legacy 路径。 */
function recordRelativeDir(lineage, fromSessionId) {
  const from = typeof fromSessionId === 'string' ? fromSessionId.trim() : '';
  const parts = from === '' || from === LEGACY_PARTITION_ID || !PARTITION_ID.test(from)
    ? [String(lineage ?? '?')]
    : [from, String(lineage ?? '?')];
  return teamRelativePath(...parts);
}

/**
 * 跨会话 rehydrate 注入 prompt：身份 + 记录继承说明 + profile + checkpoint +
 * 记录目录/旧会话/快照优先级召回指针 + 先核验再等活 + 边界。有界 ≤ maxBytes（默认 promptBytes）。
 */
export function buildRehydratePrompt({ lineage, name, gen, profile, checkpoint, ledger = [], fromSessionId, maxBytes = TEAM_LIMITS.promptBytes } = {}) {
  const from = typeof fromSessionId === 'string' && fromSessionId.trim() !== '' ? fromSessionId.trim() : '（未知旧会话）';
  const pointers = formatLedgerPointers(ledger);
  const lines = [
    '# 你是队友 ' + String(name ?? '?') + '（' + String(lineage ?? '?') + ' 第 ' + String(gen ?? '?') + ' 代）',
    '',
    '你继承的是工作记录，不是上一个 Lead 会话的对话或身份：没有它的上下文记忆，只按下面的 profile / checkpoint / ledger 指针接手。',
    '',
    '## 长期职责（profile）',
    clipText(profile, 1200) || '（未提供；按 Lead 的任务卡执行）',
    '',
    '## 交接记录（checkpoint）',
    String(checkpoint ?? '').trim() || '（没有 checkpoint：向 Lead 报告记录缺失，不要臆测）',
    '',
    '## 召回入口（链式，按需）',
    '- 记录目录：' + recordRelativeDir(lineage, fromSessionId) + '/（profile / checkpoint / ledger / handoffs；来自分区 ' + from + '）',
    '- 旧会话：session_event_read({ session_id: ' + from + ', seq }) 按需召回（同 workspace 有权限）；每轮 ≤3 跳、命中即停。',
    '- 优先级：快照（记录/仓库现状）权威 > 指针 > 旧会话；冲突时以现状为准，不要照抄旧结论。',
    pointers.length === 0 ? '- 历史代际：暂无' : '- 历史代际：\n' + pointers.map((line) => '  ' + line).join('\n'),
    '',
    '## 开工前（先做这一步，再等任务）',
    '1. 用 1-2 个只读工具核验 1 个可判定事实（文件存在 / 测试命令 / git status），不要凭记录复述就自信；',
    '2. 回一句 ≤100 字：已接手 + 核验结果；',
    '3. 等 Lead 用消息派活，不要自行扩大范围。',
    '',
    '## 边界',
    '- 只写自己 lineage 的记录（checkpoint 用 relay_checkpoint）；不压缩（freshen）、不交接（handoff）、不自行换代（renew），那些都是 Lead 的事；',
    '- 上下文到线（band warn/organize）会通知你向 Lead 请示；不向人类提问、不自行换人。',
    '',
  ];
  let text = lines.join('\n');
  if (byteLength(text) > maxBytes) {
    const suffix = '\n[rehydrate prompt truncated: ' + maxBytes + ' bytes cap]\n';
    const budget = Math.max(0, maxBytes - byteLength(suffix));
    while (byteLength(text) > budget) text = text.slice(0, -1);
    text += suffix;
  }
  return text;
}

// ── 体检 ───────────────────────────────────────────────────────────────

/**
 * 队友健康档：fresh=可派；watch=可做完当前、边界先 checkpoint；stale=该换代；
 * spent=到线且没有 checkpoint（先补记录再换代）；unknown=读不到压力。
 */
export function classifyHealth(state, hasCheckpoint = false) {
  const band = state?.band ?? 'unknown';
  if (band === 'unknown') return { health: 'unknown', band, ratio: state?.ratio, action: '读不到该队友上下文；先 relay_team_status 重试或让 Lead 人工判断' };
  if (band === 'organize' || band === 'relay') {
    const health = hasCheckpoint ? 'stale' : 'spent';
    return {
      health,
      band,
      ratio: state?.ratio,
      action: hasCheckpoint
        ? '边界让队友 relay_freshen({reset:true, brief}) 真清空复用（同成员、0 额度）；仅换身份/角色才 relay_renew'
        : '先让队友 relay_checkpoint 补记录，再 reset 复用（同成员、0 额度）；仅换身份/角色才 relay_renew',
    };
  }
  if (band === 'warn') return { health: 'watch', band, ratio: state?.ratio, action: '可以做完当前任务；任务/phase 边界要求 relay_checkpoint，下一轮考虑换代' };
  return { health: 'fresh', band, ratio: state?.ratio, action: '可继续派活' };
}

/**
 * dsh-context-relay — 工作台账核心模块（v0.5.0，WORK-LEDGER-CONTRACT §2）。
 *
 * 单一真源：`<cwd>/.scratch/context-relay/work-items.json`（config `workItemsPath` 可覆盖）。
 * 只依赖 node:fs / node:path / `../policy.js`（PHASES）；读盘永不抛，写盘走 workspaceStore 异步写锁
 * （显式 pathOverride 退化为同步原子写）+ 原子替换。
 * 空台账（文件不存在 / items=[]）对上层完全等价于旧行为。
 *
 * @module dsh-context-relay/agent/work-items
 */
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { PHASES } from '../policy.js';
import { confirmKeyOf, isDocItem } from '../risk.js';
import { assertNoCredentials, atomicFileReplace, workspaceStore } from '../storage.js';

/** 旧 workspace 级路径（v0.5.1 起仅作一次性迁移来源 / 显式 workItemsPath 兼容）。 */
export const WORK_ITEMS_RELATIVE = '.scratch/context-relay/work-items.json';
/** v0.5.1：台账跟会话走——每个根会话一份（队友共用 Lead 的台账；交接复制到新会话）。 */
export const WORK_ITEMS_SESSION_DIR = '.scratch/context-relay/work-items';
/** v0.9.0 #39：超限/替换删除的 done 项归档到台账同目录 `<台账名去 .json>-archive.ndjson`（append，不自动删）。 */
export const WORK_ITEMS_ARCHIVE_SUFFIX = '-archive.ndjson';
/** 合法作用域 id（用作文件名）：与 session id 字符集一致，拒绝路径穿越。 */
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export const WORK_ITEM_STATUSES = Object.freeze(['open', 'doing', 'blocked', 'done']);
export const WORK_ITEMS_DEFAULT_MAX = 30;
export const WORK_ITEM_LIMITS = Object.freeze({
  idMin: 2,
  idMax: 32,
  title: 120,
  owner: 40,
  next: 160,
  blocked: 200,
  evidenceMax: 3,
  evidenceChars: 200,
  acceptance: 160,
  dependsMax: 8,
  /** v0.9.0 #35：官方任务板 task id 引用（可选；1-64 字符，宽松字符集，不校验存在性）。 */
  officialTaskId: 64,
});
/** 完成确认门（v0.10.x）：条目从非 done 变 done 前，Lead 必须确认三项均 true（先复核 diff/需求/测试）。 */
export const LEAD_CONFIRM_FIELDS = Object.freeze(['no_drift', 'no_missing', 'no_regression']);
/** v0.6.0：一个 phase 附带的元数据与分点上限。 */
export const PHASE_LIMITS = Object.freeze({
  goal: 160,
  exitCriteria: 200,
  points: 8,
  carry: 10,
});

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** 官方 task id：宽松字符集（task-xxx / UUID 等形态），只校验形态不校验存在性（#35；离线、不联网）。 */
const OFFICIAL_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONFIG_MAX = 100;
const PENDING_RANK = Object.freeze({ blocked: 0, doing: 1, open: 2 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asString = (value) => (typeof value === 'string' ? value : null);
const nowIso = () => new Date().toISOString();
const timeOf = (item) => {
  const parsed = Date.parse(item?.updatedAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
};
const clampMax = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(CONFIG_MAX, Math.max(1, Math.trunc(numeric))) : WORK_ITEMS_DEFAULT_MAX;
};
const clampCap = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
};

/** lead_confirm 归一：三项布尔（非对象 → null）；T0/T1 自动确认保留 auto/confirmKey 供审计。 */
function normalizeLeadConfirm(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  for (const field of LEAD_CONFIRM_FIELDS) out[field] = raw[field] === true;
  if (raw.auto === 'T0' || raw.auto === 'T1') out.auto = raw.auto;
  if (typeof raw.confirmKey === 'string' && /^[0-9a-f]{8,64}$/.test(raw.confirmKey)) out.confirmKey = raw.confirmKey;
  return out;
}

/** 完成确认是否完整：三项均严格 true（缺失/非 true → 不完整）；写入层与工具层共用。 */
export function isLeadConfirmComplete(raw) {
  return isObject(raw) && LEAD_CONFIRM_FIELDS.every((field) => raw[field] === true);
}

/** 接受 work-items 数组或 readWorkItems 返回值。 */
function itemsOf(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.items)) return value.items;
  return [];
}

/**
 * 台账作用域：根会话 id。子代理/队友取 parentSession（Team 队友是 Lead 的直接子会话），
 * 根会话取自身 id；session 缺失返回 undefined（调用方回落旧 workspace 级路径）。
 */
export function workItemsScopeOf(session) {
  const id = typeof session?.id === 'string' && session.id !== '' ? session.id : undefined;
  if (id === undefined) return undefined;
  const header = session?.header;
  if (header === null || header === undefined || typeof header !== 'object') return id;
  // 只认 subagent 事实；parentSession 是 fork 血缘，普通 fork 根会话仍用自己的台账。
  const subagent = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
  if (!subagent) return id;
  return typeof header.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : id;
}

/** 台账相对路径：显式 workItemsPath > 会话级 > 旧 workspace 级（兼容旧调用/测试）。 */
export function workItemsRelativePath(pathOverride, scopeId) {
  if (typeof pathOverride === 'string' && pathOverride.trim() !== '') return pathOverride;
  if (typeof scopeId === 'string' && SCOPE_ID_PATTERN.test(scopeId)) return WORK_ITEMS_SESSION_DIR + '/' + scopeId + '.json';
  return WORK_ITEMS_RELATIVE;
}

function relativePathOf(cwd, absolutePath, pathOverride, scopeId) {
  if (!pathOverride) return workItemsRelativePath(undefined, scopeId);
  if (!isAbsolute(pathOverride)) return normalize(pathOverride);
  return relative(typeof cwd === 'string' && cwd !== '' ? cwd : '.', absolutePath) || absolutePath;
}

/** config 归一化（agent.js 与 index.js 共用；缺省/非法值回落到契约默认）。 */
export function normalizeWorkItemsConfig(config = {}) {
  const input = isObject(config) ? config : {};
  const gate = input.workItemsGate === 'warn' || input.workItemsGate === 'off' ? input.workItemsGate : 'strict';
  // v0.6.0：phase 边界收口闸门（与 ship gate 独立的档位）。
  const phaseGate = ['strict', 'warn', 'off'].includes(input.workItemsPhaseGate) ? input.workItemsPhaseGate : 'warn';
  const pathOverride = typeof input.workItemsPath === 'string' && input.workItemsPath.trim() !== '' ? input.workItemsPath : undefined;
  return {
    enabled: input.workItems !== false,
    gate,
    phaseGate,
    pathOverride,
    max: clampMax(input.workItemsMax),
  };
}

/** 台账绝对路径；pathOverride 为相对路径时按 cwd 解析；scopeId 决定会话级默认路径。 */
export function workItemsPathOf(cwd, pathOverride, scopeId) {
  return resolve(typeof cwd === 'string' && cwd !== '' ? cwd : '.', workItemsRelativePath(pathOverride, scopeId));
}

/** 台账同目录归档文件名（v0.9.0 #39）：`<台账名去 .json>-archive.ndjson`。 */
function archiveNameOf(ledgerPath) {
  return ledgerPath.endsWith('.json') ? ledgerPath.slice(0, -5) + WORK_ITEMS_ARCHIVE_SUFFIX : ledgerPath + WORK_ITEMS_ARCHIVE_SUFFIX;
}

/** 归档文件绝对路径（与台账同目录；pathOverride 时同理）。 */
export function archivePathOf(cwd, { pathOverride, scopeId } = {}) {
  return archiveNameOf(workItemsPathOf(cwd, pathOverride, scopeId));
}

/** 归档文件相对工作区路径（供工具返回体/文档引用）。 */
export function archiveRelativePathOf(cwd, { pathOverride, scopeId } = {}) {
  if (pathOverride === undefined || pathOverride === null || typeof pathOverride !== 'string' || pathOverride.trim() === '') {
    return archiveNameOf(workItemsRelativePath(undefined, scopeId));
  }
  if (!isAbsolute(pathOverride)) return archiveNameOf(normalize(pathOverride));
  return relative(typeof cwd === 'string' && cwd !== '' ? cwd : '.', archivePathOf(cwd, { pathOverride, scopeId })) || archivePathOf(cwd, { pathOverride, scopeId });
}

/** 显式共享台账路径（可能在记录目录外）：无跨进程锁，保持旧的同步原子写语义。 */
const isExplicitOverride = (pathOverride) => typeof pathOverride === 'string' && pathOverride.trim() !== '';

/** 读文本（缺失 → ''；其它错误抛出）。 */
function readTextOf(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
}

/** 持锁原子替换：记录目录内走 workspaceStore.replace（路径守卫已过），override 路径走 host 原子写。 */
function replaceLedgerFile(target, content, store) {
  return store === undefined ? atomicFileReplace(target, content) : store.replace(target, content);
}

/**
 * workspace 记录目录内的台账写走 workspaceStore 异步写锁（跨进程互斥、等待不阻塞事件循环）；
 * 显式 pathOverride 可能在记录目录外，退化为同步原子写（与旧行为一致）。
 */
async function withLedgerLock(cwd, target, pathOverride, action) {
  if (isExplicitOverride(pathOverride)) return action(target, undefined);
  const store = workspaceStore(cwd);
  const validated = store.path(target);
  return store.withFileLock(validated, () => action(validated, store));
}

/**
 * 追加归档记录（v0.9.0 #39；append 语义，不重写/不删除台账）：每行
 * `{archivedAt, rev, sessionId, reason, item}`。写失败返回 ok:false（调用方据此拒绝整次台账写入）。
 * entries = [{item, reason:'over-cap'|'removed-done'|'dropped'}]。
 */
export async function appendArchive(cwd, { entries, rev, sessionId, pathOverride, scopeId } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => isObject(entry) && isObject(entry.item));
  const absolutePath = archivePathOf(cwd, { pathOverride, scopeId });
  const relativePath = archiveRelativePathOf(cwd, { pathOverride, scopeId });
  if (list.length === 0) return { ok: true, count: 0, path: absolutePath, relativePath };
  const archivedAt = nowIso();
  const revValue = Number.isInteger(rev) && rev >= 0 ? rev : 0;
  const sessionValue = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  const text = list
    .map((entry) => JSON.stringify({ archivedAt, rev: revValue, sessionId: sessionValue, reason: String(entry.reason ?? 'over-cap'), item: entry.item }) + '\n')
    .join('');
  try {
    assertNoCredentials(text);
    await withLedgerLock(cwd, absolutePath, pathOverride, (target, store) => replaceLedgerFile(target, readTextOf(target) + text, store));
  } catch (error) {
    return { ok: false, code: 'archive-failed', error: String(error?.code ?? error?.message ?? error) };
  }
  return { ok: true, count: list.length, path: absolutePath, relativePath };
}

/** 读归档文件概要（count=可解析的行数；不存在=0；坏行跳过不阻断；读失败给 error 不抛）。 */
export function readArchive(cwd, { pathOverride, scopeId } = {}) {
  const absolutePath = archivePathOf(cwd, { pathOverride, scopeId });
  const relativePath = archiveRelativePathOf(cwd, { pathOverride, scopeId });
  let text;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, count: 0, path: absolutePath, relativePath };
    return { ok: false, count: 0, path: absolutePath, relativePath, error: 'read-failed: ' + String(error?.code ?? error?.message ?? error) };
  }
  let count = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      JSON.parse(trimmed);
      count += 1;
    } catch { /* 历史坏行跳过（fail-open），不阻断台账 */ }
  }
  return { ok: true, count, path: absolutePath, relativePath };
}

/**
 * 旧 workspace 级台账 → 会话级迁移/同步（v0.5.1 过渡期，best-effort，失败静默）：
 * 仅当旧文件最后写者就是本作用域会话、且旧文件比会话级文件新时复制——这样旧代码会话（agent 平面
 * 仍是旧代）继续写旧文件时，新宿主侧读取能跟上；会话级一旦更新（新代码写入）就不再被旧文件覆盖。
 */
function syncLegacyLedger(cwd, absolutePath, scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE_ID_PATTERN.test(scopeId)) return;
  const legacyPath = resolve(typeof cwd === 'string' && cwd !== '' ? cwd : '.', WORK_ITEMS_RELATIVE);
  if (legacyPath === absolutePath) return;
  let text;
  let legacyMtime;
  try {
    legacyMtime = statSync(legacyPath).mtimeMs;
    text = readFileSync(legacyPath, 'utf8');
  } catch { return; }
  try {
    if (existsSync(absolutePath) && statSync(absolutePath).mtimeMs >= legacyMtime) return; // 会话级不旧于旧文件 → 不覆盖
  } catch { return; }
  let raw;
  try { raw = JSON.parse(text); } catch { return; }
  if (!isObject(raw) || raw.updatedBy !== scopeId) return;
  try {
    atomicFileReplace(absolutePath, text);
  } catch { /* 迁移失败按空台账读（fail-open） */ }
}

function normalizeStoredItem(raw) {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    title: asString(raw.title) ?? '',
    status: WORK_ITEM_STATUSES.includes(raw.status) ? raw.status : 'open',
    owner: asString(raw.owner),
    next: asString(raw.next),
    blocked: asString(raw.blocked),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((entry) => typeof entry === 'string') : [],
    acceptance: asString(raw.acceptance),
    depends: Array.isArray(raw.depends) ? raw.depends.filter((entry) => typeof entry === 'string') : [],
    phase: PHASES.includes(raw.phase) ? raw.phase : null,
    carriedFrom: PHASES.includes(raw.carriedFrom) ? raw.carriedFrom : null,
    // v0.9.0 #35：官方任务板 id 引用（只存引用；读盘原样保留，写盘由 validateWorkItems 校验）。
    officialTaskId: asString(raw.officialTaskId),
    // v0.10.x 完成确认门：done 条目的 Lead 确认（三项均 true 才完整；读盘原样保留）。
    lead_confirm: normalizeLeadConfirm(raw.lead_confirm),
    updatedAt: asString(raw.updatedAt),
  };
}

const clampText = (value, max) => {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
};

/** 台账顶层 currentPhase（v0.6.0）：phase 合法才保留；since/openedAtRev 非数字则 null；risk 可选（relay-audit §2.5.2）。 */
function normalizeStoredPhase(raw) {
  if (!isObject(raw) || !PHASES.includes(raw.phase)) return null;
  const risk = isObject(raw.risk) && (raw.risk.tier === 'T0' || raw.risk.tier === 'T1' || raw.risk.tier === 'T2')
    ? {
      tier: raw.risk.tier,
      source: raw.risk.source === 'declared' ? 'declared' : 'derived',
      reasons: Array.isArray(raw.risk.reasons) ? raw.risk.reasons.filter((item) => typeof item === 'string').slice(0, 4) : [],
    }
    : null;
  // relay-docs-v2 Q2：pin 随 currentPhase 持久化（design_gate.path 自动并入；additive，空数组不落字段）。
  const pins = Array.isArray(raw.pins)
    ? [...new Set(raw.pins.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))].slice(0, 8)
    : [];
  return {
    phase: raw.phase,
    goal: clampText(raw.goal, PHASE_LIMITS.goal),
    exitCriteria: clampText(raw.exitCriteria, PHASE_LIMITS.exitCriteria),
    since: Number.isFinite(raw.since) ? raw.since : null,
    openedAtRev: Number.isFinite(raw.openedAtRev) ? raw.openedAtRev : null,
    ...(risk === null ? {} : { risk }),
    ...(pins.length === 0 ? {} : { pins }),
  };
}

function quarantineLedger(absolutePath, base) {
  const backup = absolutePath + '.corrupt-' + Date.now();
  let corruptBackup;
  try {
    renameSync(absolutePath, backup);
    corruptBackup = backup;
  } catch {
    // 隔离失败（平台限制等）也不阻断读取：按空台账 fail-open。
  }
  return { ...base, corruptBackup };
}

/** 低层读盘：不存在/损坏/IO 失败都降级为空台账（损坏文件先隔离为 .corrupt-<ts>）。 */
function loadLedger(absolutePath) {
  const base = { exists: false, rev: 0, updatedAt: null, updatedBy: null, currentPhase: null, items: [], corruptBackup: undefined, error: undefined };
  let text;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return base;
    return { ...base, error: 'read-failed: ' + String(error?.code ?? error?.message ?? error) };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return quarantineLedger(absolutePath, base);
  }
  if (!isObject(raw) || (raw.items !== undefined && !Array.isArray(raw.items))) return quarantineLedger(absolutePath, base);
  return {
    exists: true,
    rev: Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
    updatedAt: asString(raw.updatedAt),
    updatedBy: asString(raw.updatedBy),
    currentPhase: normalizeStoredPhase(raw.currentPhase),
    items: (Array.isArray(raw.items) ? raw.items : []).map(normalizeStoredItem).filter((item) => item !== null),
    corruptBackup: undefined,
    error: undefined,
  };
}

/**
 * 读台账：IO/损坏都降级为 ok:true 的空台账（永不抛）。
 * migrateLegacy=false = 纯只读路径（HTTP GET / pre-step 高频读）：不做旧 workspace 台账→会话级的惰性迁移写盘
 * （C14：只读路由/只读热路径不得有写副作用）；写/工具读路径仍默认迁移。
 */
export function readWorkItems(cwd, { pathOverride, scopeId, migrateLegacy = true } = {}) {
  const absolutePath = workItemsPathOf(cwd, pathOverride, scopeId);
  // 迁移/同步在读取时惰性发生：旧 workspace 台账仍由本会话写（旧代码会话过渡期）→ 跟随最新。
  if (migrateLegacy && typeof pathOverride !== 'string') syncLegacyLedger(cwd, absolutePath, scopeId);
  const loaded = loadLedger(absolutePath);
  const result = {
    ok: true,
    exists: loaded.exists,
    path: absolutePath,
    relativePath: relativePathOf(cwd, absolutePath, pathOverride, scopeId),
    rev: loaded.rev,
    updatedAt: loaded.updatedAt,
    updatedBy: loaded.updatedBy,
    currentPhase: loaded.currentPhase,
    items: loaded.items,
    counts: countsOf(loaded.items),
  };
  if (loaded.corruptBackup !== undefined) result.corruptBackup = loaded.corruptBackup;
  if (loaded.error !== undefined) result.error = loaded.error;
  // counts 上附带不可枚举 rev：ledgerLine(counts) 也能渲染真实 rev，counts 的序列化/比较形状不变。
  Object.defineProperty(result.counts, 'rev', { value: loaded.rev, enumerable: false, configurable: true });
  return result;
}

/** 计数：pending = 未 done 的条目（未闭合口径，含 blocked）。 */
export function countsOf(items) {
  const rows = itemsOf(items);
  const counts = { total: rows.length, open: 0, doing: 0, blocked: 0, done: 0, pending: 0 };
  for (const row of rows) {
    const status = typeof row?.status === 'string' ? row.status : '';
    if (Object.prototype.hasOwnProperty.call(counts, status) && status !== 'total' && status !== 'pending') counts[status] += 1;
    else counts.open += 1;
  }
  counts.pending = counts.total - counts.done;
  return counts;
}

/**
 * 校验并归一化整表（纯函数）。失败逐条报错：
 * 外层 code 只有 invalid-item / duplicate-id / ledger-full，errors[].code 说明具体原因。
 */
export function validateWorkItems(items, { max = WORK_ITEMS_DEFAULT_MAX } = {}) {
  const limit = clampMax(max);
  const errors = [];
  if (!Array.isArray(items)) {
    errors.push({ index: -1, code: 'invalid-item', message: 'items must be an array' });
    return { ok: false, code: 'invalid-item', message: 'invalid work items: items must be an array', errors };
  }
  if (items.length > limit) {
    // v0.9.0 #39：超限先归档 done 再写入（writeWorkItems 在 validate 前做）；直接校验时给出同一口径。
    errors.push({ index: limit, code: 'ledger-full', message: 'at most ' + limit + ' work items are allowed (got ' + items.length + '); done items can be archived, unfinished items are never auto-deleted' });
    return { ok: false, code: 'ledger-full', message: 'work ledger is full: at most ' + limit + ' items allowed (got ' + items.length + '); archive/close done items or keep it within the cap — unfinished items are never auto-deleted', errors };
  }

  const normalized = [];
  for (let index = 0; index < items.length; index += 1) {
    const raw = items[index];
    if (!isObject(raw)) {
      errors.push({ index, code: 'invalid-item', message: 'item ' + index + ' must be an object' });
      normalized.push({ id: null, title: '', status: null, owner: null, next: null, blocked: null, evidence: [], acceptance: null, depends: [], phase: null, carriedFrom: null, officialTaskId: null, lead_confirm: null, updatedAt: null });
      continue;
    }
    const item = { id: null, title: '', status: null, owner: null, next: null, blocked: null, evidence: [], acceptance: null, depends: [], phase: null, carriedFrom: PHASES.includes(raw.carriedFrom) ? raw.carriedFrom : null, officialTaskId: null, lead_confirm: null, updatedAt: asString(raw.updatedAt) };
    const push = (code, message) => errors.push({ index, id: item.id ?? undefined, code, message });

    if (typeof raw.id !== 'string' || raw.id.length < WORK_ITEM_LIMITS.idMin || raw.id.length > WORK_ITEM_LIMITS.idMax || !ID_PATTERN.test(raw.id)) {
      push('invalid-id', 'id must be ' + WORK_ITEM_LIMITS.idMin + '-' + WORK_ITEM_LIMITS.idMax + ' chars matching ' + ID_PATTERN + ' (got ' + JSON.stringify(raw.id) + ')');
    } else {
      item.id = raw.id;
    }

    if (typeof raw.title !== 'string') {
      push('invalid-title', 'title is required');
    } else {
      const title = raw.title.trim();
      if (title.length < 1 || title.length > WORK_ITEM_LIMITS.title) push('invalid-title', 'title must be 1-' + WORK_ITEM_LIMITS.title + ' chars');
      else item.title = title;
    }

    if (!WORK_ITEM_STATUSES.includes(raw.status)) push('invalid-status', 'status must be one of ' + WORK_ITEM_STATUSES.join('|'));
    else item.status = raw.status;
    // 完成确认门（v0.10.x）：lead_confirm 只对 done 条目有意义（非 done 一律清空；写入层校验新变 done）。
    item.lead_confirm = item.status === 'done' ? normalizeLeadConfirm(raw.lead_confirm) : null;

    if (raw.owner !== undefined && raw.owner !== null) {
      if (typeof raw.owner !== 'string') {
        push('invalid-owner', 'owner must be a string');
      } else {
        const owner = raw.owner.trim();
        if (owner.length > WORK_ITEM_LIMITS.owner) push('invalid-owner', 'owner must be <= ' + WORK_ITEM_LIMITS.owner + ' chars');
        else item.owner = owner === '' ? null : owner;
      }
    }

    if (raw.next !== undefined && raw.next !== null && raw.next !== '') {
      if (typeof raw.next !== 'string') {
        push('invalid-next', 'next must be a string');
      } else {
        const next = raw.next.trim();
        if (next.length < 1 || next.length > WORK_ITEM_LIMITS.next) push('invalid-next', 'next must be 1-' + WORK_ITEM_LIMITS.next + ' chars');
        else item.next = next;
      }
    }
    // v0.6.0：open = 未领取（允许 next 为空，领取时再写）；doing 必须写 next。
    if (raw.status === 'doing' && item.next === null) push('missing-next', 'status "doing" requires next');

    if (raw.status === 'blocked') {
      if (typeof raw.blocked !== 'string') {
        push('missing-blocked', 'status "blocked" requires a blocked reason');
      } else {
        const blocked = raw.blocked.trim();
        if (blocked.length < 1 || blocked.length > WORK_ITEM_LIMITS.blocked) push('invalid-blocked', 'blocked must be 1-' + WORK_ITEM_LIMITS.blocked + ' chars');
        else item.blocked = blocked;
      }
    }
    // 非 blocked 状态的 blocked 字段：契约要求忽略/清空（item.blocked 保持 null）。

    if (raw.evidence !== undefined && raw.evidence !== null) {
      if (!Array.isArray(raw.evidence)) {
        push('invalid-evidence', 'evidence must be an array');
      } else if (raw.evidence.length > WORK_ITEM_LIMITS.evidenceMax) {
        push('invalid-evidence', 'evidence accepts at most ' + WORK_ITEM_LIMITS.evidenceMax + ' entries');
      } else {
        const evidence = [];
        let evidenceOk = true;
        for (const entry of raw.evidence) {
          if (typeof entry !== 'string') {
            push('invalid-evidence', 'evidence entries must be strings');
            evidenceOk = false;
            break;
          }
          const value = entry.trim();
          if (value.length < 1 || value.length > WORK_ITEM_LIMITS.evidenceChars) {
            push('invalid-evidence', 'evidence entries must be 1-' + WORK_ITEM_LIMITS.evidenceChars + ' chars');
            evidenceOk = false;
            break;
          }
          evidence.push(value);
        }
        if (evidenceOk) item.evidence = evidence;
      }
    }

    if (raw.acceptance !== undefined && raw.acceptance !== null && raw.acceptance !== '') {
      if (typeof raw.acceptance !== 'string') {
        push('invalid-acceptance', 'acceptance must be a string');
      } else {
        const acceptance = raw.acceptance.trim();
        if (acceptance.length > WORK_ITEM_LIMITS.acceptance) push('invalid-acceptance', 'acceptance must be <= ' + WORK_ITEM_LIMITS.acceptance + ' chars');
        else item.acceptance = acceptance === '' ? null : acceptance;
      }
    }

    if (raw.phase !== undefined && raw.phase !== null && raw.phase !== '') {
      if (!PHASES.includes(raw.phase)) push('invalid-phase', 'phase must be one of ' + PHASES.join('|'));
      else item.phase = raw.phase;
    }

    // v0.9.0 #35：officialTaskId 可选、只存引用（不校验官方任务板是否存在；不联网）。
    if (raw.officialTaskId !== undefined && raw.officialTaskId !== null && raw.officialTaskId !== '') {
      if (typeof raw.officialTaskId !== 'string') {
        push('invalid-official-task-id', 'officialTaskId must be a string');
      } else {
        const officialTaskId = raw.officialTaskId.trim();
        if (officialTaskId.length < 1 || officialTaskId.length > WORK_ITEM_LIMITS.officialTaskId || !OFFICIAL_TASK_ID_PATTERN.test(officialTaskId)) {
          push('invalid-official-task-id', 'officialTaskId must be 1-' + WORK_ITEM_LIMITS.officialTaskId + ' chars matching ' + OFFICIAL_TASK_ID_PATTERN);
        } else item.officialTaskId = officialTaskId;
      }
    }

    normalized.push(item);
  }

  // 重复 id（只对合法 id 判定）。
  const seenIds = new Set();
  normalized.forEach((item, index) => {
    if (!item.id) return;
    if (seenIds.has(item.id)) errors.push({ index, id: item.id, code: 'duplicate-id', message: 'duplicate work item id "' + item.id + '"' });
    else seenIds.add(item.id);
  });

  // depends：≤8 条、引用已存在 id、不能自引用。
  const knownIds = new Set();
  normalized.forEach((item) => {
    if (item.id) knownIds.add(item.id);
  });
  normalized.forEach((item, index) => {
    const raw = items[index];
    if (!isObject(raw) || raw.depends === undefined || raw.depends === null) return;
    const push = (code, message) => errors.push({ index, id: item.id ?? undefined, code, message });
    if (!Array.isArray(raw.depends)) {
      push('invalid-depends', 'depends must be an array');
      return;
    }
    if (raw.depends.length > WORK_ITEM_LIMITS.dependsMax) {
      push('invalid-depends', 'depends accepts at most ' + WORK_ITEM_LIMITS.dependsMax + ' ids');
      return;
    }
    const depends = [];
    let dependsOk = true;
    for (const entry of raw.depends) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        push('invalid-depends', 'depends entries must be non-empty strings');
        dependsOk = false;
        continue;
      }
      const depId = entry.trim();
      if (item.id !== null && depId === item.id) {
        push('depends-self', 'work item "' + depId + '" cannot depend on itself');
        dependsOk = false;
        continue;
      }
      if (!knownIds.has(depId)) {
        push('depends-missing', 'depends references unknown work item id "' + depId + '"');
        dependsOk = false;
        continue;
      }
      if (!depends.includes(depId)) depends.push(depId);
    }
    if (dependsOk) item.depends = depends;
  });

  // depends 环（DFS 回溯着色）；合法依赖图无声返回。
  const byId = new Map();
  normalized.forEach((item, index) => {
    if (item.id && !byId.has(item.id)) byId.set(item.id, { item, index });
  });
  const colors = new Map();
  const reported = new Set();
  const visit = (id) => {
    colors.set(id, 1);
    const node = byId.get(id);
    for (const depId of node?.item.depends ?? []) {
      const state = colors.get(depId) ?? 0;
      if (state === 1) {
        if (!reported.has(depId)) {
          reported.add(depId);
          errors.push({ index: byId.get(depId)?.index, id: depId, code: 'depends-cycle', message: 'depends cycle detected at "' + depId + '"' });
        }
      } else if (state === 0) {
        visit(depId);
      }
    }
    colors.set(id, 2);
  };
  for (const item of normalized) {
    if (item.id && (colors.get(item.id) ?? 0) === 0) visit(item.id);
  }

  if (errors.length > 0) {
    const code = errors.some((entry) => entry.code === 'duplicate-id') ? 'duplicate-id' : 'invalid-item';
    return { ok: false, code, message: 'invalid work items: ' + errors.length + ' problem(s) — first: ' + errors[0].message, errors };
  }
  return { ok: true, items: normalized };
}

function contentKey(item) {
  return JSON.stringify([item.id, item.title, item.status, item.owner, item.next, item.blocked, item.evidence, item.acceptance, item.depends, item.phase, item.carriedFrom, item.officialTaskId, item.lead_confirm]);
}

/**
 * 超限预归档（v0.9.0 #39）：按「最旧 done」优先归档到 ≤limit；未完成项不归档、不删除。
 * 可归档 done 不足 → ledger-full（拒绝整次写入）；归档失败由调用方在写台账前拒绝（不半写）。
 */
function planOverCapArchive(items, limit) {
  const doneIndices = [];
  items.forEach((item, index) => {
    if (isObject(item) && item.status === 'done') doneIndices.push(index);
  });
  doneIndices.sort((left, right) => timeOf(items[left]) - timeOf(items[right]));
  const need = items.length - limit;
  if (doneIndices.length < need) {
    return {
      ok: false,
      code: 'ledger-full',
      message: 'work ledger is full: at most ' + limit + ' items allowed (got ' + items.length + '); close done items or keep the ledger within the cap — done items are archived automatically to ' + WORK_ITEMS_ARCHIVE_SUFFIX + ', but there are only ' + doneIndices.length + ' done item(s) while ' + need + ' must be archived, so the write was refused (unfinished items are never auto-deleted).',
      errors: [{ index: limit, code: 'ledger-full', message: 'at most ' + limit + ' work items are allowed (got ' + items.length + '); only done items can be auto-archived' }],
    };
  }
  const archivedIndices = new Set(doneIndices.slice(0, need));
  return {
    ok: true,
    items: items.filter((_item, index) => !archivedIndices.has(index)),
    entries: doneIndices.slice(0, need).map((index) => ({ item: items[index], reason: 'over-cap' })),
  };
}

/**
 * 整表替换写盘：异步写锁内做 rev 乐观锁 + 原子替换（并发不丢更新）+ 未变内容保留 updatedAt。
 * archiveEntries（v0.9.0 P3-4）：调用方显式归档条目（如整表替换删除的 done 项），与超限归档合并，
 * 且只在 stale-rev/validate 等可失败前置全部通过后才 append——失败路径不留孤儿归档。
 */
export async function writeWorkItems(cwd, { items, rev, updatedBy, max, pathOverride, scopeId, currentPhase, archiveEntries } = {}) {
  const absolutePath = workItemsPathOf(cwd, pathOverride, scopeId);
  const relativePath = relativePathOf(cwd, absolutePath, pathOverride, scopeId);
  try {
    return await withLedgerLock(cwd, absolutePath, pathOverride, (target, store) => writeWorkItemsLocked(cwd, {
      items, rev, updatedBy, max, pathOverride, scopeId, currentPhase, archiveEntries,
    }, target, relativePath, store));
  } catch (error) {
    // 路径守卫/锁失败也按契约返回结构化失败（调用方不处理异常）。
    return { ok: false, code: 'write-failed', message: 'failed to write work ledger: ' + String(error?.code ?? error?.message ?? error) };
  }
}

/** 调用方持有台账文件锁：rev 校验 → 上限规划 → 校验 → 归档 → 原子替换（D-02：rev 并发不丢更新）。 */
async function writeWorkItemsLocked(cwd, { items, rev, updatedBy, max, pathOverride, scopeId, currentPhase, archiveEntries } = {}, target, relativePath, store) {
  const limit = clampMax(max);
  const explicitRev = Number.isFinite(Number(rev)) && rev !== null && rev !== '' ? Number(rev) : undefined;
  const current = loadLedger(target);
  if (current.exists && explicitRev !== undefined && explicitRev !== current.rev) {
    return {
      ok: false,
      code: 'stale-revision',
      message: 'work ledger revision mismatch: expected ' + explicitRev + ', current ' + current.rev,
      currentRev: current.rev,
      counts: countsOf(current.items),
    };
  }
  // v0.9.0 #39：上限流程在 validate 之前——超限先按「最旧 done」规划归档（纯计算，无 IO）；
  // P3-4：先跑完所有可失败前置（validate、done 门），再 append 归档、最后写台账——任一前置失败不留孤儿归档。
  // 归档失败 → 拒绝整次写入（台账不变、不半写）；done 不足才 ledger-full；未完成项永不自动删除。
  const incoming = items;
  // v0.10.x 完成确认门必须在「超限预归档」之前检查（放宽上限先整体校验/归一化，纯计算）：
  // 否则新变 done 条目若被选作最旧 done 预归档，会以归档方式绕过门（归档里出现无确认的 done）。
  const fullValidated = validateWorkItems(incoming, {
    max: Math.max(limit, Array.isArray(incoming) ? incoming.length : 0),
  });
  if (!fullValidated.ok) return fullValidated;
  const previous = new Map(current.items.map((item) => [item.id, item]));
  // 风险档（relay-audit §2.5.3 done-gate）：T0/T1 文档条目 evidence 即可 → 自动确认；T2 仍 3×true。
  const riskTier = (isObject(currentPhase) && isObject(currentPhase.risk) ? currentPhase.risk.tier : undefined)
    ?? (isObject(current.currentPhase?.risk) ? current.currentPhase.risk.tier : undefined);
  const autoConfirms = new Map();
  const reusedConfirms = new Map();
  const gateViolations = [];
  fullValidated.items.forEach((item, index) => {
    if (item.status !== 'done') return;
    const raw = Array.isArray(incoming) ? incoming[index] : undefined;
    // 显式 = 提供了非 null 的 lead_confirm（readWorkItems 回写时 null 表示「没有确认」，不算覆盖）。
    const explicit = isObject(raw) && raw.lead_confirm !== undefined && raw.lead_confirm !== null;
    const old = previous.get(item.id);
    if (old?.status === 'done') {
      // 已 done 条目不受门约束；但显式确认不得降级/覆盖既有确认（不完整/含 false → 拒绝）。
      if (explicit && !isLeadConfirmComplete(raw.lead_confirm)) {
        // confirmKey 消费：同一 auto 确认的重复请求（只回传 auto+confirmKey）直接复用盘上三项 true；
        // key 不匹配则拦截，不能借重复请求把确认降级/伪造。
        const incomingKey = isObject(raw.lead_confirm) && typeof raw.lead_confirm.confirmKey === 'string' ? raw.lead_confirm.confirmKey : undefined;
        const stored = isObject(old.lead_confirm) ? old.lead_confirm : undefined;
        const storedKey = typeof stored?.confirmKey === 'string' ? stored.confirmKey : undefined;
        const auto = isObject(raw.lead_confirm) ? raw.lead_confirm.auto : undefined;
        const reusable = incomingKey !== undefined && storedKey !== undefined && incomingKey === storedKey
          && (auto === undefined || auto === stored.auto) && isLeadConfirmComplete(stored);
        if (reusable) reusedConfirms.set(item.id, stored);
        else gateViolations.push(item.id);
      }
      return;
    }
    // 非 done→done（含将被超限预归档的条目）：必须带完整三项确认；T0/T1 文档条目自动确认。
    if (!isLeadConfirmComplete(raw?.lead_confirm)) {
      const evidence = Array.isArray(item.evidence) ? item.evidence : [];
      const itemId = item.id ?? raw?.id ?? 'item-' + index;
      const auto = explicit !== true && evidence.length > 0
        && (riskTier === 'T0' || (riskTier === 'T1' && isDocItem(item)));
      if (auto) {
        autoConfirms.set(itemId, {
          no_drift: true, no_missing: true, no_regression: true,
          auto: riskTier,
          confirmKey: confirmKeyOf({ itemId, rev: current.rev }),
        });
      } else {
        gateViolations.push(item.id);
      }
    }
  });
  if (gateViolations.length > 0) {
    return {
      ok: false,
      code: 'done-gate',
      ids: gateViolations,
      message: 'done gate: 条目 ' + gateViolations.join(', ') + ' 的 lead_confirm 不完整/未通过（no_drift/no_missing/no_regression 三项均 true）——新变 done 必须由 Lead 先复核 diff / 需求 / 测试后确认（含将被超限归档的条目）；已 done 条目不得用不完整/含 false 的显式确认覆盖既有确认。本次整表拒绝（台账未变）。',
    };
  }
  let pendingItems = incoming;
  let overCapEntries = [];
  if (Array.isArray(incoming) && incoming.length > limit) {
    const plan = planOverCapArchive(incoming, limit);
    if (!plan.ok) return plan;
    pendingItems = plan.items;
    overCapEntries = plan.entries;
  }
  const validated = validateWorkItems(pendingItems, { max: limit });
  if (!validated.ok) return validated;
  // 已 done 条目未重复提供确认时保留盘上既有确认（整表替换不丢审计信息）。
  const effectiveItems = validated.items.map((item) => {
    const reused = reusedConfirms.get(item.id);
    if (reused !== undefined) return { ...item, lead_confirm: reused };
    if (item.status !== 'done' || item.lead_confirm !== null) return item;
    const auto = autoConfirms.get(item.id);
    if (auto !== undefined) return { ...item, lead_confirm: auto };
    const old = previous.get(item.id);
    return old?.status === 'done' && old.lead_confirm !== null ? { ...item, lead_confirm: old.lead_confirm } : item;
  });
  // 调用方显式归档条目 + 超限归档合并为一次 append（同目录同一文件；显式条目在前保持原有归档顺序）。
  const extraEntries = (Array.isArray(archiveEntries) ? archiveEntries : []).filter((entry) => isObject(entry) && isObject(entry.item));
  const entries = [...extraEntries, ...overCapEntries];
  let archiveReport;
  if (entries.length > 0) {
    const archived = await appendArchive(cwd, { entries, rev: current.rev, sessionId: updatedBy, pathOverride, scopeId });
    if (archived.ok !== true) {
      return { ok: false, code: 'archive-failed', message: 'failed to archive work-ledger items before the write: ' + String(archived.error ?? 'unknown') };
    }
    archiveReport = { count: archived.count, path: archived.relativePath };
  }

  const stamp = nowIso();
  const nextItems = effectiveItems.map((item) => {
    const old = previous.get(item.id);
    const updatedAt = old && old.updatedAt && contentKey(old) === contentKey(item) ? old.updatedAt : stamp;
    return { ...item, updatedAt };
  });
  const nextRev = current.rev + 1;
  const updatedByValue = typeof updatedBy === 'string' && updatedBy.trim() !== '' ? updatedBy : null;
  // v0.6.0：currentPhase 不传 = 保留原值；null = 显式清空。
  const nextPhase = currentPhase === undefined ? current.currentPhase : normalizeStoredPhase(currentPhase);
  const ledger = { version: 1, rev: nextRev, updatedAt: stamp, updatedBy: updatedByValue, ...(nextPhase === null ? {} : { currentPhase: nextPhase }), items: nextItems };
  try {
    replaceLedgerFile(target, JSON.stringify(ledger, null, 2) + '\n', store);
  } catch (error) {
    return { ok: false, code: 'write-failed', message: 'failed to write work ledger: ' + String(error?.code ?? error?.message ?? error) };
  }
  return {
    ok: true,
    ledger: { rev: nextRev, updatedAt: stamp, updatedBy: updatedByValue, currentPhase: nextPhase, items: nextItems },
    counts: countsOf(nextItems),
    relativePath,
    ...(archiveReport === undefined ? {} : { archived: archiveReport }),
  };
}

/**
 * 交接继承（v0.5.1）：把源会话的会话级台账原样复制到子会话作用域（rev 保留）。
 * 返回目标相对路径；显式 workItemsPath（共享覆盖）/无源台账/目标已存在/失败 → undefined（fail-open，交接不阻断）。
 */
export async function copyWorkItemsToScope(cwd, { fromScopeId, toScopeId, pathOverride } = {}) {
  if (isExplicitOverride(pathOverride)) return undefined;
  if (typeof toScopeId !== 'string' || !SCOPE_ID_PATTERN.test(toScopeId)) return undefined;
  const fromPath = workItemsPathOf(cwd, undefined, fromScopeId);
  const toPath = workItemsPathOf(cwd, undefined, toScopeId);
  if (fromPath === toPath) return undefined;
  const store = workspaceStore(cwd);
  try {
    const target = store.path(toPath);
    return await store.withFileLock(target, () => {
      if (existsSync(target)) return undefined;
      let text;
      try { text = readFileSync(fromPath, 'utf8'); } catch { return undefined; }
      try {
        const raw = JSON.parse(text);
        if (!isObject(raw) || !Array.isArray(raw.items) || raw.items.length === 0) return undefined;
      } catch { return undefined; }
      try {
        store.replace(target, text);
      } catch { return undefined; }
      return workItemsRelativePath(undefined, toScopeId);
    });
  } catch { return undefined; }
}

/** 某个 phase 的分点（条目 phase 匹配）。 */
export function phaseItemsOf(ledger, phase) {
  return itemsOf(ledger).filter((item) => item?.phase === phase);
}

/** 当前 phase 摘要：{phase, goal, exitCriteria, since, planned, done, pending, doing, open, blocked}。 */
export function phaseSummary(ledger) {
  const meta = isObject(ledger) && isObject(ledger.currentPhase) ? ledger.currentPhase : null;
  const rows = meta === null ? [] : phaseItemsOf(ledger, meta.phase);
  const counts = countsOf(rows);
  return {
    phase: meta === null ? null : meta.phase,
    goal: meta === null ? null : meta.goal,
    exitCriteria: meta === null ? null : meta.exitCriteria,
    since: meta === null ? null : meta.since,
    planned: rows.length,
    done: counts.done,
    pending: counts.pending,
    doing: counts.doing,
    open: counts.open,
    blocked: counts.blocked,
  };
}

/** 队列常驻行（sentinel 每步注入，≤110 字）：当前分点/下一步/全闭环提示。 */
export function phaseFocusLine(ledger) {
  const summary = phaseSummary(ledger);
  if (summary.phase === null || summary.planned === 0) return '';
  const rows = phaseItemsOf(ledger, summary.phase);
  const head = '[台账·' + summary.phase + ' ' + summary.done + '/' + summary.planned + ']';
  // ship 是主链终点：全闭环后没有「关 phase」下一步，不再催 relay_phase（用户 2026-11-16 反馈）。
  if (summary.pending === 0) return summary.phase === 'ship' ? '' : head + ' 分点全闭环 → 可以关 phase（relay_phase）';
  const doing = rows.find((item) => item.status === 'doing');
  if (doing) return head + ' doing「' + doing.title + '」' + (doing.next ? 'next「' + doing.next + '」' : 'next 未写：先补 next');
  const blocked = rows.find((item) => item.status === 'blocked');
  if (blocked && summary.open === 0) return head + ' 阻塞中：「' + blocked.title + '」' + (blocked.blocked ? '（' + blocked.blocked + '）' : '（原因未写）');
  const open = rows.find((item) => item.status === 'open');
  if (open) return head + ' 未领取：open「' + open.title + '」→ 领一条并写 next';
  return head;
}

/** phase 行（brief/交接/status 共用）：'phase build · 分点 3/5'；无 currentPhase 返回 ''。 */
export function phaseLine(ledger) {
  const summary = phaseSummary(ledger);
  if (summary.phase === null) return '';
  return 'phase ' + summary.phase + ' · 分点 ' + summary.done + '/' + summary.planned + (summary.pending > 0 ? '（未闭合 ' + summary.pending + '）' : '');
}

/**
 * 关 phase 闸门（v0.6.0，G2）：本 phase 未 done 的分点必须收口或用 carry 显式带走。
 * C7/A-03：phase=null 的未收口条目同样纳入关闸（条目没有 phase 不能成为 strict 绕过口——
 * 手工/旧版/迁移来的无 phase 条目视同属于当前 phase）。
 * strict 拒绝（返回 ok:false）；warn 放行 + warnings；off 不查。空台账/无 currentPhase 恒放行。
 */
export function checkPhaseGate(ledger, { phase, carry = [], gate = 'strict' } = {}) {
  const empty = { ok: true, carried: [], leftover: [], warnings: [] };
  if (gate === 'off') return empty;
  if (!isObject(ledger) || ledger.exists !== true) return empty;
  const items = itemsOf(ledger);
  if (items.length === 0) return empty;
  const previous = phase ?? (isObject(ledger.currentPhase) ? ledger.currentPhase.phase : undefined);
  if (previous === undefined || previous === null) return empty;
  const carryIds = (Array.isArray(carry) ? carry : []).filter((id) => typeof id === 'string' && id !== '');
  const unclosed = items.filter((item) => item?.status !== 'done' && (item?.phase === previous || item?.phase === null || item?.phase === undefined));
  const carried = unclosed.filter((item) => carryIds.includes(item.id)).map((item) => item.id);
  const leftover = unclosed.filter((item) => !carryIds.includes(item.id)).map((item) => item.id);
  // carry 里不指向「上一 phase 未完成条目」的 id（不存在/已 done/别的 phase）→ 显式报告，不静默。
  const carriedSet = new Set(carried);
  const ignored = carryIds.filter((id) => !carriedSet.has(id));
  const warnings = leftover.map((id) => 'phase "' + previous + '" item not closed: ' + id);
  if (leftover.length === 0) return { ok: true, carried, leftover, ignored, warnings };
  if (gate !== 'strict') return { ok: true, carried, leftover, ignored, warnings };
  const detail = items.filter((item) => leftover.includes(item.id))
    .map((item) => '[' + item.id + '] ' + item.title + (item.phase === null || item.phase === undefined ? '（未标 phase，视同本 phase）' : ''))
    .join('; ');
  return {
    ok: false,
    code: 'phase-not-closed',
    phase: previous,
    ids: leftover,
    leftover,
    carried,
    ignored,
    warnings,
    message: 'phase "' + previous + '" 还有 ' + leftover.length + ' 条分点未收口：' + detail
      + '——先 relay_work_items 把它们改成 done（需 evidence）或 blocked，或 relay_phase({phase:"<下一 phase>", carry:[' + leftover.map((id) => JSON.stringify(id)).join(',') + ']}) 显式带到下一 phase；单线程小任务用 items: [] 声明。',
  };
}

/** carry：把 from phase 的指定条目改到 to phase，并记 carriedFrom（C7：无 phase 条目也可被 carry，避免「闸门算了它、carry 却没带走」）。 */
export function applyPhaseCarry(items, { carry = [], from, to, stamp = nowIso() } = {}) {
  const ids = new Set((Array.isArray(carry) ? carry : []).filter((id) => typeof id === 'string' && id !== ''));
  return itemsOf(items).map((item) => {
    const unphased = item.phase === null || item.phase === undefined;
    if (!ids.has(item.id) || (item.phase !== from && !unphased)) return item;
    return { ...item, phase: to, carriedFrom: item.carriedFrom ?? from, updatedAt: stamp };
  });
}

/** 标题 → 合法 id（中文标题回退 'point'；冲突加 -2/-3…）。 */
function slugOfTitle(title) {
  const ascii = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.length >= 2 ? ascii.slice(0, 30).replace(/-+$/, '') : 'point';
}

/** 开 phase 分点：字符串标题 → open 条目（phase=新 phase，next 留空待领取）。 */
export function createPhaseItems(titles, { phase, existing = [], stamp = nowIso() } = {}) {
  const ids = new Set(itemsOf(existing).map((item) => item?.id).filter((id) => typeof id === 'string' && id !== ''));
  const created = [];
  for (const raw of Array.isArray(titles) ? titles : []) {
    const title = typeof raw === 'string' ? raw.trim().slice(0, WORK_ITEM_LIMITS.title) : '';
    if (title === '') continue;
    const base = slugOfTitle(title);
    let candidate = base;
    let index = 2;
    while (ids.has(candidate)) {
      candidate = (base.slice(0, 26) + '-' + index).slice(0, 32);
      index += 1;
    }
    ids.add(candidate);
    created.push({ id: candidate, title, status: 'open', owner: null, next: null, blocked: null, evidence: [], acceptance: null, depends: [], phase, carriedFrom: null, updatedAt: stamp });
  }
  return created;
}

/** 未闭合排序：blocked → doing → open，组内 updatedAt 倒序（缺失当 0）；done 不出现。 */
export function pendingFirst(items) {
  return itemsOf(items)
    .filter((item) => item?.status !== 'done')
    .slice()
    .sort((left, right) => {
      const rankLeft = PENDING_RANK[left?.status] ?? 3;
      const rankRight = PENDING_RANK[right?.status] ?? 3;
      if (rankLeft !== rankRight) return rankLeft - rankRight;
      return timeOf(right) - timeOf(left);
    });
}

/** 台账更新距今分钟数（updatedAt 缺失/非法 → null）。v0.5.1：状态行/到线提醒显示新鲜度。 */
export function ledgerAgeMinutes(ledger, now = Date.now()) {
  const parsed = Date.parse(typeof ledger?.updatedAt === 'string' ? ledger.updatedAt : '');
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 60000));
}

/**
 * 台账新鲜度后缀（接在 ledgerLine 之后）：' · 刚更新' / ' · N 分钟前更新'；
 * 超过 staleMinutes 时附「已停滞」提醒——台账不会自动更新，停滞是模型没写，不是插件故障。
 */
export function ledgerAgeSuffix(ledger, { now = Date.now(), staleMinutes = 30 } = {}) {
  const age = ledgerAgeMinutes(ledger, now);
  if (age === null) return '';
  const base = age < 1 ? ' · 刚更新' : ' · 更新于 ' + age + ' 分钟前';
  return age >= staleMinutes ? base + '（台账已停滞：phase 边界/交接前先更新）' : base;
}

/** 单行台账计数：'work-items: 未闭合 N / 共 M (...) · rev R'。 */
export function ledgerLine(counts) {
  const source = isObject(counts) && Number.isFinite(counts.total) ? counts : countsOf(counts);
  const rev = isObject(counts) && Number.isFinite(counts.rev) ? counts.rev : (isObject(counts) && isObject(counts.counts) && Number.isFinite(counts.counts.rev) ? counts.counts.rev : 0);
  return 'work-items: 未闭合 ' + source.pending + ' / 共 ' + source.total + ' (doing ' + source.doing + ' · blocked ' + source.blocked + ' · open ' + source.open + ' · done ' + source.done + ') · rev ' + rev;
}

/** 条目行：'- [id] title · owner=x · → next · evidence n · status'（无该字段则省略该段）。 */
export function formatWorkItemLines(items, { limit = 10, includeDone = false } = {}) {
  const rows = includeDone ? [...pendingFirst(items), ...itemsOf(items).filter((item) => item?.status === 'done')] : pendingFirst(items);
  const cap = clampCap(limit, 10);
  return rows.slice(0, cap).map((item) => {
    const parts = ['- [' + (item.id ?? '') + '] ' + (item.title ?? '')];
    if (item.owner) parts.push('· owner=' + item.owner);
    if (item.next) parts.push('· → ' + item.next);
    const evidenceCount = Array.isArray(item.evidence) ? item.evidence.length : 0;
    if (evidenceCount > 0) parts.push('· evidence ' + evidenceCount);
    parts.push('· ' + item.status);
    if (item.officialTaskId) parts.push('· official=' + item.officialTaskId);
    return parts.join(' ');
  });
}

/** handoff next_actions 素材：pendingFirst 前 max 条；omitted 为超出的 id（有界内容的另一半）。 */
export function ledgerNextActions(items, { max = 8 } = {}) {
  const rows = pendingFirst(items);
  const cap = clampCap(max, 8);
  const shown = rows.slice(0, cap);
  const actions = shown.map((item) => {
    const head = '[' + (item.id ?? '') + '] ' + (item.title ?? '');
    if (item.status === 'blocked') return head + '（阻塞：' + (item.blocked || '未写明原因') + '）';
    return item.next ? head + ' → ' + item.next : head;
  });
  const omitted = rows.slice(cap).map((item) => item.id).filter((id) => typeof id === 'string' && id !== '');
  return { actions, omitted };
}

/** organize brief 段：exists && 未闭合 > 0 才有内容（空台账 = 旧行为不变）。 */
export function ledgerBriefSection(ledger, { limit = 10 } = {}) {
  const items = itemsOf(ledger);
  const counts = countsOf(items);
  if (!isObject(ledger) || ledger.exists !== true || counts.total === 0 || counts.pending === 0) return '';
  const lines = ['## 未闭合工作项', ...(phaseLine(ledger) === '' ? [] : ['- 当前 ' + phaseLine(ledger)]), ...formatWorkItemLines(items, { limit })];
  lines.push('- 台账：' + ledger.relativePath + ' · rev ' + (ledger.rev ?? 0) + ' · 未闭合 ' + counts.pending + ' / 共 ' + counts.total);
  return lines.join('\n');
}

/** handoff 正文段：'## 工作台账' + 计数/路径/rev 行 + 条目行 + omitted 非空时的未带走项行。 */
export function ledgerHandoffSection(ledger, { limit = 10, omitted = [] } = {}) {
  const items = itemsOf(ledger);
  const counts = countsOf(items);
  if (!isObject(ledger) || ledger.exists !== true || counts.total === 0) return '';
  const lines = [
    '## 工作台账',
    '- 台账：' + ledger.relativePath + ' · rev ' + (ledger.rev ?? 0) + ' · 未闭合 ' + counts.pending + ' / 共 ' + counts.total,
    ...(phaseLine(ledger) === '' ? [] : ['- ' + phaseLine(ledger)]),
    ...formatWorkItemLines(items, { limit }),
  ];
  const left = (Array.isArray(omitted) ? omitted : []).filter((id) => typeof id === 'string' && id !== '');
  if (left.length > 0) lines.push('- 未带走项（超过 next_actions 上限）：' + left.join(', '));
  return lines.join('\n');
}

/** 新会话首条消息入口行：路径 + 计数 + 前 limit 条 pending；空台账返回 ''。 */
export function ledgerEntryLine(ledger, { limit = 5 } = {}) {
  const items = itemsOf(ledger);
  const counts = countsOf(items);
  if (!isObject(ledger) || ledger.exists !== true || counts.total === 0) return '';
  const cap = clampCap(limit, 5);
  const rows = pendingFirst(items);
  const shown = rows.slice(0, cap).map((item) => {
    const head = '[' + (item.id ?? '') + '] ' + (item.title ?? '');
    return item.next ? head + ' → ' + item.next : head;
  });
  if (rows.length > cap && cap > 0) shown.push('…');
  const head = '工作台账：' + ledger.relativePath + '（未闭合 ' + counts.pending + ' / 共 ' + counts.total;
  if (shown.length === 0) return head + '；用 relay_work_items 读）';
  return head + '；前 ' + Math.min(rows.length, cap) + ' 条：' + shown.join('；') + '；用 relay_work_items 读）';
}

/**
 * ship 闸门：off 直接放行；strict 拒绝「未 done/blocked 的条目」与「done 无 evidence」；
 * warn 时返回 ok:true + warnings；空台账恒放行。
 */
export function checkShipGate(ledger, { gate = 'strict' } = {}) {
  if (gate === 'off') return { ok: true };
  const items = itemsOf(ledger);
  if (items.length === 0) return { ok: true };
  const unclosed = items.filter((item) => item?.status !== 'done' && item?.status !== 'blocked');
  const missingEvidence = items.filter((item) => item?.status === 'done' && !(Array.isArray(item.evidence) && item.evidence.length > 0));
  const warnings = [];
  if (unclosed.length > 0) warnings.push('work items not done/blocked: ' + unclosed.map((item) => item.id).join(', '));
  if (missingEvidence.length > 0) warnings.push('done work items missing evidence: ' + missingEvidence.map((item) => item.id).join(', '));
  if (warnings.length === 0) return { ok: true };
  if (gate === 'warn') return { ok: true, warnings };
  if (unclosed.length > 0) {
    return {
      ok: false,
      code: 'work-items-incomplete',
      message: 'work ledger is not closed: items must be done or blocked: ' + unclosed.map((item) => item.id).join(', '),
      ids: unclosed.map((item) => item.id),
    };
  }
  return {
    ok: false,
    code: 'work-items-evidence-missing',
    message: 'done work items require evidence: ' + missingEvidence.map((item) => item.id).join(', '),
    ids: missingEvidence.map((item) => item.id),
  };
}

/**
 * dsh-context-relay — 工作台账核心模块（v0.5.0，WORK-LEDGER-CONTRACT §2）。
 *
 * 单一真源：`<cwd>/.scratch/context-relay/work-items.json`（config `workItemsPath` 可覆盖）。
 * 只依赖 node:fs / node:path / `../policy.js`（PHASES）；读盘永不抛，写盘原子（tmp + rename）。
 * 空台账（文件不存在 / items=[]）对上层完全等价于旧行为。
 *
 * @module dsh-context-relay/agent/work-items
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { PHASES } from '../policy.js';

/** 旧 workspace 级路径（v0.5.1 起仅作一次性迁移来源 / 显式 workItemsPath 兼容）。 */
export const WORK_ITEMS_RELATIVE = '.scratch/context-relay/work-items.json';
/** v0.5.1：台账跟会话走——每个根会话一份（队友共用 Lead 的台账；交接复制到新会话）。 */
export const WORK_ITEMS_SESSION_DIR = '.scratch/context-relay/work-items';
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
});

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
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
  const subagent = header.origin === 'subagent' || header.parentSession !== undefined || (header.delegationDepth ?? 0) > 0;
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
  const pathOverride = typeof input.workItemsPath === 'string' && input.workItemsPath.trim() !== '' ? input.workItemsPath : undefined;
  return {
    enabled: input.workItems !== false,
    gate,
    pathOverride,
    max: clampMax(input.workItemsMax),
  };
}

/** 台账绝对路径；pathOverride 为相对路径时按 cwd 解析；scopeId 决定会话级默认路径。 */
export function workItemsPathOf(cwd, pathOverride, scopeId) {
  return resolve(typeof cwd === 'string' && cwd !== '' ? cwd : '.', workItemsRelativePath(pathOverride, scopeId));
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
    mkdirSync(dirname(absolutePath), { recursive: true });
    const tmp = absolutePath + '.' + process.pid + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, absolutePath);
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
    updatedAt: asString(raw.updatedAt),
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
  const base = { exists: false, rev: 0, updatedAt: null, updatedBy: null, items: [], corruptBackup: undefined, error: undefined };
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
    items: (Array.isArray(raw.items) ? raw.items : []).map(normalizeStoredItem).filter((item) => item !== null),
    corruptBackup: undefined,
    error: undefined,
  };
}

/** 读台账：IO/损坏都降级为 ok:true 的空台账（永不抛）。 */
export function readWorkItems(cwd, { pathOverride, scopeId } = {}) {
  const absolutePath = workItemsPathOf(cwd, pathOverride, scopeId);
  // 迁移/同步在读取时惰性发生：旧 workspace 台账仍由本会话写（旧代码会话过渡期）→ 跟随最新。
  if (typeof pathOverride !== 'string') syncLegacyLedger(cwd, absolutePath, scopeId);
  const loaded = loadLedger(absolutePath);
  const result = {
    ok: true,
    exists: loaded.exists,
    path: absolutePath,
    relativePath: relativePathOf(cwd, absolutePath, pathOverride, scopeId),
    rev: loaded.rev,
    updatedAt: loaded.updatedAt,
    updatedBy: loaded.updatedBy,
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
    errors.push({ index: limit, code: 'ledger-full', message: 'at most ' + limit + ' work items are allowed (got ' + items.length + '); close or archive done items before adding more — items are never auto-deleted' });
    return { ok: false, code: 'ledger-full', message: 'work ledger is full: at most ' + limit + ' items allowed (got ' + items.length + '); close or archive done items before adding more — items are never auto-deleted', errors };
  }

  const normalized = [];
  for (let index = 0; index < items.length; index += 1) {
    const raw = items[index];
    if (!isObject(raw)) {
      errors.push({ index, code: 'invalid-item', message: 'item ' + index + ' must be an object' });
      normalized.push({ id: null, title: '', status: null, owner: null, next: null, blocked: null, evidence: [], acceptance: null, depends: [], phase: null, updatedAt: null });
      continue;
    }
    const item = { id: null, title: '', status: null, owner: null, next: null, blocked: null, evidence: [], acceptance: null, depends: [], phase: null, updatedAt: asString(raw.updatedAt) };
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
    if ((raw.status === 'open' || raw.status === 'doing') && item.next === null) push('missing-next', 'status "' + raw.status + '" requires next');

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
  return JSON.stringify([item.id, item.title, item.status, item.owner, item.next, item.blocked, item.evidence, item.acceptance, item.depends, item.phase]);
}

/** 整表替换写盘：rev 乐观锁 + 原子写（tmp + rename）+ 未变内容保留 updatedAt。 */
export function writeWorkItems(cwd, { items, rev, updatedBy, max, pathOverride, scopeId } = {}) {
  const absolutePath = workItemsPathOf(cwd, pathOverride, scopeId);
  const relativePath = relativePathOf(cwd, absolutePath, pathOverride, scopeId);
  const limit = clampMax(max);
  const explicitRev = Number.isFinite(Number(rev)) && rev !== null && rev !== '' ? Number(rev) : undefined;
  const current = loadLedger(absolutePath);
  if (current.exists && explicitRev !== undefined && explicitRev !== current.rev) {
    return {
      ok: false,
      code: 'stale-revision',
      message: 'work ledger revision mismatch: expected ' + explicitRev + ', current ' + current.rev,
      currentRev: current.rev,
      counts: countsOf(current.items),
    };
  }
  const validated = validateWorkItems(items, { max: limit });
  if (!validated.ok) return validated;

  const previous = new Map(current.items.map((item) => [item.id, item]));
  const stamp = nowIso();
  const nextItems = validated.items.map((item) => {
    const old = previous.get(item.id);
    const updatedAt = old && old.updatedAt && contentKey(old) === contentKey(item) ? old.updatedAt : stamp;
    return { ...item, updatedAt };
  });
  const nextRev = current.rev + 1;
  const updatedByValue = typeof updatedBy === 'string' && updatedBy.trim() !== '' ? updatedBy : null;
  const ledger = { version: 1, rev: nextRev, updatedAt: stamp, updatedBy: updatedByValue, items: nextItems };
  const tmpPath = absolutePath + '.' + process.pid + '.tmp';
  try {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 临时文件可能未创建：忽略。
    }
    return { ok: false, code: 'write-failed', message: 'failed to write work ledger: ' + String(error?.code ?? error?.message ?? error) };
  }
  return {
    ok: true,
    ledger: { rev: nextRev, updatedAt: stamp, updatedBy: updatedByValue, items: nextItems },
    counts: countsOf(nextItems),
    relativePath,
  };
}

/**
 * 交接继承（v0.5.1）：把源会话的会话级台账原样复制到子会话作用域（rev 保留）。
 * 返回目标相对路径；显式 workItemsPath（共享覆盖）/无源台账/目标已存在/失败 → undefined（fail-open，交接不阻断）。
 */
export function copyWorkItemsToScope(cwd, { fromScopeId, toScopeId, pathOverride } = {}) {
  if (typeof pathOverride === 'string' && pathOverride.trim() !== '') return undefined;
  if (typeof toScopeId !== 'string' || !SCOPE_ID_PATTERN.test(toScopeId)) return undefined;
  const fromPath = workItemsPathOf(cwd, undefined, fromScopeId);
  const toPath = workItemsPathOf(cwd, undefined, toScopeId);
  if (fromPath === toPath || existsSync(toPath)) return undefined;
  let text;
  try { text = readFileSync(fromPath, 'utf8'); } catch { return undefined; }
  try {
    const raw = JSON.parse(text);
    if (!isObject(raw) || !Array.isArray(raw.items) || raw.items.length === 0) return undefined;
  } catch { return undefined; }
  try {
    mkdirSync(dirname(toPath), { recursive: true });
    const tmp = toPath + '.' + process.pid + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, toPath);
  } catch { return undefined; }
  return workItemsRelativePath(undefined, toScopeId);
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
  const lines = ['## 未闭合工作项', ...formatWorkItemLines(items, { limit })];
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

/**
 * 队友受限编辑（读-改-写，落盘由调用方用 writeWorkItems 完成）：
 * 只 patch 已存在且 owner=owner 的条目（不允许增删/改 owner），合并后仍然整表校验。
 */
export function applyItemUpdates(ledger, { owner, updates, max = WORK_ITEMS_DEFAULT_MAX } = {}) {
  const rows = itemsOf(ledger);
  if (!Array.isArray(updates) || updates.length === 0) {
    return {
      ok: false,
      code: 'invalid-item',
      message: 'updates must be a non-empty array',
      errors: [{ index: -1, code: 'invalid-item', message: 'updates must be a non-empty array' }],
    };
  }
  const byId = new Map();
  rows.forEach((item, index) => {
    if (item && typeof item.id === 'string' && !byId.has(item.id)) byId.set(item.id, { item, index });
  });

  const unknown = [];
  updates.forEach((update, index) => {
    const id = isObject(update) && typeof update.id === 'string' ? update.id : null;
    if (id === null || !byId.has(id)) unknown.push({ index, id: id ?? undefined, code: 'invalid-item', message: 'unknown work item id ' + JSON.stringify(update?.id) });
  });
  if (unknown.length > 0) return { ok: false, code: 'invalid-item', message: 'invalid work item updates: unknown id(s)', errors: unknown };

  const scopeIds = [];
  updates.forEach((update) => {
    if ((byId.get(update.id).item.owner ?? 'lead') !== owner && !scopeIds.includes(update.id)) scopeIds.push(update.id);
  });
  if (scopeIds.length > 0) {
    return { ok: false, code: 'teammate-scope', message: 'cannot update work items owned by other members: ' + scopeIds.join(', '), ids: scopeIds };
  }

  const merged = rows.map((item) => ({ ...item, evidence: Array.isArray(item.evidence) ? [...item.evidence] : [], depends: Array.isArray(item.depends) ? [...item.depends] : [] }));
  const mergedById = new Map(merged.map((item) => [item.id, item]));
  updates.forEach((update) => {
    const item = mergedById.get(update.id);
    if (update.status !== undefined) item.status = update.status;
    if (update.next !== undefined) item.next = update.next;
    if (update.blocked !== undefined) item.blocked = update.blocked;
    if (update.evidence !== undefined) item.evidence = update.evidence;
  });
  const validated = validateWorkItems(merged, { max });
  if (!validated.ok) return validated;
  return { ok: true, items: validated.items, counts: countsOf(validated.items) };
}

/** renew 换代：把 from 名下条目 owner 改为 to；只读-改-写一次，无变化不落盘。 */
export function migrateOwner(cwd, { from, to, pathOverride, scopeId } = {}) {
  if (typeof from !== 'string' || from.trim() === '' || typeof to !== 'string' || to.trim() === '') {
    return { ok: false, code: 'invalid-item', message: 'migrateOwner requires non-empty from/to' };
  }
  const source = from.trim();
  const target = to.trim();
  const read = readWorkItems(cwd, { pathOverride, scopeId });
  if (!read.exists || read.items.length === 0 || source === target) return { ok: true, changed: 0, counts: read.counts };
  let changed = 0;
  const items = read.items.map((item) => {
    if ((item.owner ?? 'lead') !== source) return item;
    changed += 1;
    return { ...item, owner: target };
  });
  if (changed === 0) return { ok: true, changed, counts: read.counts };
  const written = writeWorkItems(cwd, { items, rev: read.rev, pathOverride, scopeId });
  if (!written.ok) return { ok: false, code: written.code, message: written.message };
  return { ok: true, changed, counts: written.counts };
}

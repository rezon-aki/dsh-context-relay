/**
 * dsh-context-relay — delegation 纯逻辑层（v0.9.0 批次3 M1；无 IO，可直接单测）。
 *
 * 职责（设计真源 `.scratch/context-relay/architecture/v090-batch3.md` §1.6/§2.2–2.4/§3.1/§4.2–4.3）：
 *   - 口径常量 + config 归一（v0.10.0 C14b 起 strict 原样生效：默认 warn / off / strict 三档）
 *   - 台账 owner / lead-exec 判定（不改台账 schema，只作字符串约定）
 *   - build→verify 委派闸门纯函数（off / warn / strict 三档，默认 warn）
 *   - delegation 度量 advice 与 relay_status/ship 快照
 *   - dispatch 参数校验、标准 5 字段 brief 组装、回执头解析/digest、reportPath/dispatchId 派生
 *
 * 只依赖 node:path（写范围路径安全校验），不依赖任何运行时服务。
 *
 * @module dsh-context-relay/agent/delegation
 */
import { isAbsolute } from 'node:path';
// D-14：Lead 执行占比阈值（warn 档）常量单一真源在 policy（agent→policy 单向依赖）；
// 本文件再导出供既有调用方/测试，避免第二份定义漂移。
import { DELEGATION_EXEC_RATIO_MAX } from '../policy.js';
export { DELEGATION_EXEC_RATIO_MAX };

/** 样本下限：工具调用总数不足时指标仅参考（会话累计口径，D2=A）。 */
export const DELEGATION_MIN_CALLS = 10;
/** 委派闸门默认档（用户裁决：默认 warn，只提醒不阻断）。 */
export const DELEGATION_GATE_DEFAULT = 'warn';
export const DELEGATION_GATE_MODES = Object.freeze(['warn', 'off', 'strict']);
/** 自动选人可复用的 health（v0.11 §3.1：unavailable 与 unknown 同归 unknown，均不可自动复用）。 */
export const DISPATCH_HEALTHS = Object.freeze(['fresh', 'watch']);
/** 自动选人并发读 band 的候选上限（超出部分不读、结果标 truncated）。 */
export const DISPATCH_CANDIDATE_LIMIT = 12;
/** 回执目录（工作区相对；itemId 已受台账 schema 约束，无路径穿越）。 */
export const DELEGATION_REPORT_DIR = '.scratch/context-relay/reports';
/** collect 只读回执前 64KB（完整报告 ≤4KB advisory；超限只读前部并标 truncated）。 */
export const DELEGATION_REPORT_READ_BYTES = 65536;
/** digest 上限（Unicode 码点；完整报告永远留在 reportPath 文件）。 */
export const DELEGATION_DIGEST_CHARS = 600;
/**
 * dispatch 记录落盘目录（C8/M-06）：`<scopeId>/<itemId>.json`，workspaceStore 原子写；
 * 进程重启/插件 reload 后仍是 relay_collect 的**新鲜度权威**（旧回执不得假收口）。
 */
export const DELEGATION_DISPATCH_DIR = '.scratch/context-relay/dispatch';
/** dispatch 记录的作用域目录名合法字符集（同台账 scopeId）；不合法 → `_workspace`。 */
const RECORD_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** 与 work-items.js WORK_ITEM_LIMITS 的 id 长度一致（2–32）。 */
const ITEM_ID_MIN = 2;
const ITEM_ID_MAX = 32;
const BRIEF_MAX = 800;
const DOC_MAX = 200;
const DOCS_MAX = 3;
const SCOPE_MAX = 8;
const SCOPE_ITEM_MAX = 200;
const ACCEPTANCE_MAX = 300;
const NEXT_MAX = 160;
const WORKER_MAX = 32;
/** 委派闸门只看 build/verify 分点（§1.6）。 */
const GATE_POINTS = Object.freeze(['build', 'verify']);
/** 回执头 3 行机读键（顺序固定，乱序视为无效头）。 */
const HEAD_KEYS = Object.freeze(['task', 'revision', 'verdict']);
const VERDICTS = Object.freeze(['done', 'needs-human', 'blocked']);
/** Lead 自做证据前缀（原因必填；大小写不敏感，宽松解析）。 */
const LEAD_EXEC_PATTERN = /^lead-exec:\s*\S/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * 归一度量输入：兼容 relay_status.execution `{calls:number,total,ratio}` 与投影
 * `{executionCalls,toolCalls}` / 纯函数 `{calls:{exec,total}}` 三种形态。
 * ratio 按 §1.6 口径由计数重算（3 位小数），不新增第二套计数。
 */
function executionStats(execution) {
  const source = isObject(execution) ? execution : {};
  const calls = isObject(source.calls) ? source.calls : null;
  const total = countOf(calls !== null ? calls.total : source.total !== undefined ? source.total : source.toolCalls);
  const exec = countOf(calls !== null ? calls.exec : source.calls !== undefined ? source.calls : source.executionCalls);
  return { calls: { exec, total }, ratio: total > 0 ? Math.round((exec / total) * 1000) / 1000 : 0 };
}

/** 归一 config（v0.10.0 C14b）：warn（默认）/ off / strict 三档原样保留——strict 命中即拒；非法值按缺省 warn。 */
export function normalizeDelegationConfig(input = {}) {
  const source = isObject(input) ? input : {};
  const raw = source.delegationGate !== undefined ? source.delegationGate : source.gate;
  if (raw === 'off') return { gate: 'off' };
  if (raw === 'strict') return { gate: 'strict' };
  return { gate: 'warn' };
}

/**
 * 自动选人评分（v0.11 §3.1）：fresh/watch 且 idle 才可复用；score = healthRank(fresh 0/watch 1)*10
 * + bandRank(ok 0/warn 1)。不可复用（health 非 fresh/watch、band 非 ok/warn、status=running）→ null。
 * tie-break（rosterKnown 优先、再 name 字典序）在 rankDispatchCandidates 里做，保持本函数纯分数。
 */
export function dispatchScoreOf({ health, band, status } = {}) {
  if (status === 'running') return null;
  if (!DISPATCH_HEALTHS.includes(health)) return null;
  const bandRank = band === 'ok' ? 0 : band === 'warn' ? 1 : null;
  if (bandRank === null) return null;
  const healthRank = health === 'fresh' ? 0 : 1;
  return healthRank * 10 + bandRank;
}

/** 按 dispatchScoreOf + tie-break（rosterKnown 优先、再 name 字典序）排序；不可复用候选不返回。 */
export function rankDispatchCandidates(candidates) {
  const ranked = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const score = dispatchScoreOf(candidate);
    if (score === null) continue;
    ranked.push({ ...candidate, score });
  }
  ranked.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    const leftKnown = left.rosterKnown === true;
    const rightKnown = right.rosterKnown === true;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    const leftName = String(left.name ?? '');
    const rightName = String(right.name ?? '');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  return ranked;
}

/** Lead 所有：空/nil、'lead'、'self'、或等于 Lead 根会话 id（§1.6）。 */
export function isLeadOwner(owner, sessionId) {
  if (owner === null || owner === undefined) return true;
  if (typeof owner !== 'string') return false;
  const trimmed = owner.trim();
  if (trimmed === '') return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'lead' || lower === 'self') return true;
  return typeof sessionId === 'string' && trimmed === sessionId;
}

/** evidence 中至少一条匹配 `^lead-exec:\s*\S`（原因非空；大小写不敏感）。 */
export function hasLeadExecEvidence(evidence) {
  if (!Array.isArray(evidence)) return false;
  return evidence.some((entry) => typeof entry === 'string' && LEAD_EXEC_PATTERN.test(entry.trim()));
}

/** 条目归属 phase：item.phase 优先，缺失时回退台账 currentPhase.phase（§1.6）。 */
function pointPhaseOf(item, ledger) {
  if (typeof item.phase === 'string' && item.phase !== '') return item.phase;
  return isObject(ledger) && isObject(ledger.currentPhase) ? ledger.currentPhase.phase : null;
}

/**
 * build/verify 分点中由 Lead 所有（且非 blocked）的条目。
 * @returns {{leadOwnedIds: string[], points: Array<{id: string, status: string|null}>}}
 */
export function leadOwnedPoints(ledger, sessionId) {
  const points = [];
  if (!isObject(ledger) || ledger.exists !== true || !Array.isArray(ledger.items)) return { leadOwnedIds: [], points };
  for (const item of ledger.items) {
    if (!isObject(item) || typeof item.id !== 'string' || item.id === '') continue;
    if (item.status === 'blocked') continue;
    const phase = pointPhaseOf(item, ledger);
    if (!GATE_POINTS.includes(phase)) continue;
    if (!isLeadOwner(item.owner, sessionId)) continue;
    points.push({ id: item.id, status: typeof item.status === 'string' ? item.status : null });
  }
  return { leadOwnedIds: points.map((point) => point.id), points };
}

/** 台账 id → evidence 数组（gate 判定用；重复 id 后者覆盖）。 */
function evidenceByIdOf(ledger) {
  const map = new Map();
  const items = isObject(ledger) && Array.isArray(ledger.items) ? ledger.items : [];
  for (const item of items) {
    if (isObject(item) && typeof item.id === 'string') map.set(item.id, item.evidence);
  }
  return map;
}

function emptyGateResult() {
  return { ok: true, warnings: [], stats: { execRatio: 0, calls: { exec: 0, total: 0 }, leadOwned: [] } };
}

/**
 * build→verify 委派闸门（纯函数，三档）：
 *   - off：不查，直接空结果；
 *   - warn：命中只产出 warnings，ok 恒 true（默认档）；
 *   - strict：命中 ok:false + code（v0.10.0 C14b 起 config 层原样生效：relay_phase build→verify 零副作用拒绝）。
 * 仅 from==='build' && to==='verify' 触发；其余切换零开销。
 */
export function delegationGateCheck({ from, to, execution, ledger, sessionId, mode } = {}) {
  const gate = DELEGATION_GATE_MODES.includes(mode) ? mode : DELEGATION_GATE_DEFAULT;
  if (from !== 'build' || to !== 'verify' || gate === 'off') return emptyGateResult();
  const stats = executionStats(execution);
  const warnings = [];
  if (stats.calls.total >= DELEGATION_MIN_CALLS && stats.ratio > DELEGATION_EXEC_RATIO_MAX) {
    warnings.push({
      code: 'lead-exec-ratio',
      message: 'build 阶段 Lead 执行占比 ' + Math.round(stats.ratio * 100) + '%（' + stats.calls.exec + '/' + stats.calls.total + '，阈值 20%）：分点应派 worker（relay_dispatch），你只做决策/验收抽样',
    });
  }
  const own = leadOwnedPoints(ledger, sessionId);
  const evidence = evidenceByIdOf(ledger);
  const missing = own.points.filter((point) => !hasLeadExecEvidence(evidence.get(point.id)));
  if (missing.length > 0) {
    const ids = missing.map((point) => point.id);
    const shown = ids.length > 8 ? ids.slice(0, 8).join(', ') + ' 等 ' + ids.length + ' 条' : ids.join(', ');
    warnings.push({
      code: 'lead-owned-points',
      message: 'build/verify 分点由 Lead 自做但无 lead-exec 证据：' + shown + ' —— 应在 evidence 记 lead-exec:<原因>，或改派 worker',
    });
  }
  const result = {
    ok: gate !== 'strict' || warnings.length === 0,
    warnings,
    // P2-4：leadOwned = Lead 所有 build/verify 分点 id 全集（缺 lead-exec 的子集只用于本闸门 warning）。
    stats: { execRatio: stats.ratio, calls: stats.calls, leadOwned: own.leadOwnedIds },
  };
  if (!result.ok) {
    result.code = 'delegation-gate';
    result.message = warnings.map((warning) => warning.message).join('；');
  }
  return result;
}

/**
 * 一行 delegation 建议（§2.2.3 规则按序，只提示不阻断）：
 * 样本不足 → 执行占比超阈值 → 有空闲队友且 0 次派活 → 空串。
 */
export function delegationAdvice({ execution, dispatchCount, idleWorkers } = {}) {
  const stats = executionStats(execution);
  const dispatches = countOf(dispatchCount);
  const idle = Number.isInteger(idleWorkers) && idleWorkers >= 0 ? idleWorkers : null;
  if (stats.calls.total < DELEGATION_MIN_CALLS) return '样本不足（<10 次工具调用）：指标仅参考；执行工作一律先 relay_dispatch 派活。';
  if (stats.ratio > DELEGATION_EXEC_RATIO_MAX) {
    return 'Lead 执行占比 ' + Math.round(stats.ratio * 100) + '%（' + stats.calls.exec + '/' + stats.calls.total + '，阈值 20%，warn 档）：把剩余执行工作用 relay_dispatch 派给 worker；你只做交互/决策/派活/验收抽样。';
  }
  if (idle !== null && idle > 0 && dispatches === 0) return '有 ' + idle + ' 个空闲队友且本会话 0 次 relay_dispatch：先派活，不要自己写。';
  return '';
}

/**
 * 进程内 dispatch 记忆探针（C8/C9）：delegation-tools 注册，relay_status 据此在插件 reload
 * 清空内存后显示 `delegation.dispatchMemory`（落盘 dispatch 记录仍是新鲜度权威）。
 * 无探针/未发生清空时不加字段（旧输出不变）。
 */
let dispatchMemoryProbe = null;
export function registerDispatchMemoryProbe(probe) {
  dispatchMemoryProbe = typeof probe === 'function' ? probe : null;
}
/** 当前 dispatch 记忆状态：{ inMemory, cleared, clearedAt, persisted? }；无探针 → null。 */
export function dispatchMemoryState() {
  if (dispatchMemoryProbe === null) return null;
  try {
    const state = dispatchMemoryProbe();
    return state !== null && typeof state === 'object' ? state : null;
  } catch { return null; }
}
function dispatchMemoryField() {
  const state = dispatchMemoryState();
  if (state === null || state.cleared !== true) return undefined;
  return {
    ...state,
    note: 'in-memory dispatch memory was cleared (plugin reload/unload); persisted dispatch records under ' + DELEGATION_DISPATCH_DIR + '/ remain the freshness authority for relay_collect',
  };
}

/**
 * relay_status/ship 的 delegation 块（§2.2.2）。投影不可用 → basis:'unavailable' 且计数按 0
 * （不静默当正常），advice 明确「无法判断执行占比」而不是样本不足；idleWorkers 未知/非 Lead/
 * 团队不可用 → null（不猜 0）。
 */
export function delegationSnapshot({ execution, dispatchCount, collectCount, idleWorkers, projectedAvailable } = {}) {
  const available = projectedAvailable !== false;
  const stats = available ? executionStats(execution) : { calls: { exec: 0, total: 0 }, ratio: 0 };
  const dispatches = available ? countOf(dispatchCount) : 0;
  const collections = available ? countOf(collectCount) : 0;
  const idle = Number.isInteger(idleWorkers) && idleWorkers >= 0 ? idleWorkers : null;
  const memory = dispatchMemoryField();
  return {
    execRatio: stats.ratio,
    calls: stats.calls,
    dispatchCount: dispatches,
    collectCount: collections,
    idleWorkers: idle,
    advice: available
      ? delegationAdvice({ execution: stats, dispatchCount: dispatches, idleWorkers: idle })
      : '投影不可用（旧宿主/旧装配）：无法判断 Lead 执行占比——执行工作仍一律先 relay_dispatch 派活。',
    basis: available ? 'projection' : 'unavailable',
    ...(memory === undefined ? {} : { dispatchMemory: memory }),
  };
}

/** 失败形状（B1 转成工具 fail(...)；code 统一 invalid-args，字段在 field 里）。 */
function invalidArg(field, message) {
  return { ok: false, code: 'invalid-args', field, message };
}

/** 写范围路径安全：必须是工作区相对路径（绝对路径 / 盘符 / UNC / 含 '..' 段一律拒）。 */
function isSafeWriteScope(entry) {
  if (typeof entry !== 'string') return false;
  const value = entry.trim();
  if (value === '' || value.length > SCOPE_ITEM_MAX) return false;
  if (isAbsolute(value) || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return false;
  return !value.replace(/\\/g, '/').split('/').includes('..');
}

/**
 * relay_dispatch 参数校验（§2.4.2；先于一切 IO）。成功返回归一值，失败返回
 * `{ok:false, code:'invalid-args', field, message}`。
 */
export function validateDispatchArgs(args) {
  if (!isObject(args)) return invalidArg('args', 'dispatch 参数必须是对象');
  const itemId = typeof args.itemId === 'string' ? args.itemId.trim() : '';
  if (itemId === '' || itemId.length < ITEM_ID_MIN || itemId.length > ITEM_ID_MAX || !ITEM_ID_PATTERN.test(itemId)) {
    return invalidArg('itemId', 'itemId 必填：台账条目 id（' + ITEM_ID_MIN + '-' + ITEM_ID_MAX + ' 字符，' + ITEM_ID_PATTERN + '）');
  }
  const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
  if (brief === '' || brief.length > BRIEF_MAX) return invalidArg('brief', 'brief 必填：目标一句话可验收（1-' + BRIEF_MAX + ' 字符）');
  if (!Array.isArray(args.docs) || args.docs.length < 1 || args.docs.length > DOCS_MAX) {
    return invalidArg('docs', 'docs 必填：必读指针 1-' + DOCS_MAX + ' 条（每条 1-' + DOC_MAX + ' 字符）');
  }
  const docs = [];
  for (let index = 0; index < args.docs.length; index += 1) {
    const doc = typeof args.docs[index] === 'string' ? args.docs[index].trim() : '';
    if (doc === '' || doc.length > DOC_MAX) return invalidArg('docs', 'docs 第 ' + (index + 1) + ' 条必须 1-' + DOC_MAX + ' 字符');
    docs.push(doc);
  }
  if (!Array.isArray(args.writeScope) || args.writeScope.length < 1 || args.writeScope.length > SCOPE_MAX) {
    return invalidArg('writeScope', 'writeScope 必填：工作区相对路径/目录 1-' + SCOPE_MAX + ' 条（每条 1-' + SCOPE_ITEM_MAX + ' 字符）');
  }
  const writeScope = [];
  for (let index = 0; index < args.writeScope.length; index += 1) {
    const scope = typeof args.writeScope[index] === 'string' ? args.writeScope[index].trim() : '';
    if (!isSafeWriteScope(scope)) {
      return invalidArg('writeScope', 'writeScope 第 ' + (index + 1) + ' 条必须是工作区相对路径（禁止绝对路径与 ".."）');
    }
    writeScope.push(scope);
  }
  const acceptance = typeof args.acceptance === 'string' ? args.acceptance.trim() : '';
  if (acceptance === '' || acceptance.length > ACCEPTANCE_MAX) {
    return invalidArg('acceptance', 'acceptance 必填：可测口径（命令/对照项，1-' + ACCEPTANCE_MAX + ' 字符）');
  }
  let next = null;
  if (args.next !== undefined && args.next !== null) {
    if (typeof args.next !== 'string') return invalidArg('next', 'next 必须是字符串');
    const trimmed = args.next.trim();
    if (trimmed.length > NEXT_MAX) return invalidArg('next', 'next 最多 ' + NEXT_MAX + ' 字符');
    if (trimmed !== '') next = trimmed;
  }
  let worker = null;
  if (args.worker !== undefined && args.worker !== null) {
    if (typeof args.worker !== 'string' || args.worker.trim() === '' || args.worker.trim().length > WORKER_MAX) {
      return invalidArg('worker', 'worker 必须是现成队友名（1-' + WORKER_MAX + ' 字符）');
    }
    worker = args.worker.trim();
  }
  for (const flag of ['force', 'accept_dirty']) {
    if (args[flag] !== undefined && typeof args[flag] !== 'boolean') return invalidArg(flag, flag + ' 必须是布尔值');
  }
  return {
    ok: true,
    value: {
      itemId,
      brief,
      docs,
      writeScope,
      acceptance,
      next,
      worker,
      force: args.force === true,
      accept_dirty: args.accept_dirty === true,
    },
  };
}

/** reportPath 派生：`.scratch/context-relay/reports/<itemId>.md`；非法 id 返回 null（args 校验先行）。 */
export function reportPathOf(itemId) {
  if (typeof itemId !== 'string') return null;
  const id = itemId.trim();
  if (id.length < ITEM_ID_MIN || id.length > ITEM_ID_MAX || !ITEM_ID_PATTERN.test(id)) return null;
  return DELEGATION_REPORT_DIR + '/' + id + '.md';
}

/** dispatchId 派生：`d-<itemId>-<base36 时间戳>`（≤48 字符；重派以它区分回执新旧）。 */
export function dispatchIdOf(itemId, now = Date.now()) {
  const stamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  return 'd-' + String(itemId) + '-' + Math.max(0, stamp).toString(36);
}

/**
 * 新 dispatchId（保证与上一次不同：同一毫秒内重派也必须换 revision，否则旧回执会被当新回执）。
 * previous 为上一次落盘/内存的 dispatchId（可缺省）。
 */
export function nextDispatchId(itemId, previous, now = Date.now()) {
  let stamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  let id = dispatchIdOf(itemId, stamp);
  while (typeof previous === 'string' && previous !== '' && id === previous) {
    stamp += 1;
    id = dispatchIdOf(itemId, stamp);
  }
  return id;
}

/**
 * dispatch 记录路径（workspace 相对）：`<DISPATCH_DIR>/<scopeId>/<itemId>.json`。
 * scopeId 非法/缺失 → `_workspace`（跨会话不串记录）；itemId 非法 → null。
 */
export function dispatchRecordPathOf(scopeId, itemId) {
  if (typeof itemId !== 'string') return null;
  const id = itemId.trim();
  if (id.length < ITEM_ID_MIN || id.length > ITEM_ID_MAX || !ITEM_ID_PATTERN.test(id)) return null;
  const scope = typeof scopeId === 'string' && RECORD_SCOPE_PATTERN.test(scopeId) ? scopeId : '_workspace';
  return DELEGATION_DISPATCH_DIR + '/' + scope + '/' + id + '.json';
}

/**
 * 回执新鲜度判定（C8/M-06，纯函数）：头 task 必须等于 itemId、头 revision 必须等于本次 dispatchId。
 * - dispatchId 缺失 → needs-dispatch-id（调用方应要求显式传 dispatchId，绝不接受任意 revision）
 * - 头无效 → report-invalid / report-task-mismatch / stale-report
 */
export function receiptFreshnessOf(parsed, itemId, dispatchId) {
  if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) return { fresh: false, reason: 'report-invalid' };
  if (typeof parsed.task !== 'string' || parsed.task !== itemId) return { fresh: false, reason: 'report-task-mismatch' };
  if (typeof dispatchId !== 'string' || dispatchId === '') return { fresh: false, reason: 'needs-dispatch-id' };
  if (parsed.revision !== dispatchId) return { fresh: false, reason: 'stale-report' };
  return { fresh: true };
}

/**
 * 标准 5 字段 brief（§4.3 逐字模板）：目标 / 必读 1–3 / 写范围 / 验收 / 回执；
 * 附 dispatchId + reportPath + verdict 枚举，新建 worker 时即 startMember.prompt。
 */
export function composeDispatchBrief({ itemId, dispatchId, brief, docs, writeScope, acceptance, reportPath } = {}) {
  const id = String(itemId ?? '');
  const dispatch = typeof dispatchId === 'string' && dispatchId !== '' ? dispatchId : dispatchIdOf(id);
  const report = typeof reportPath === 'string' && reportPath !== '' ? reportPath : reportPathOf(id);
  const docText = Array.isArray(docs) ? docs.join('；') : String(docs ?? '');
  const scopeText = Array.isArray(writeScope) ? writeScope.join('；') : String(writeScope ?? '');
  const head = '[context-relay] 派活 · ' + id + ' · dispatch ' + dispatch;
  const goal = '1) 目标：' + String(brief ?? '').trim();
  const reading = '2) 必读（1–3 份，按序自取，含 when/role）：' + docText;
  const scope = '3) 写范围：' + scopeText + '（越界禁止；只改这些文件/目录）';
  const accept = '4) 验收：' + String(acceptance ?? '').trim();
  const receipt = '5) 回执：' + report + '（≤4KB advisory；头 3 行 `task: ' + id + '` / `revision: ' + dispatch + '` / `verdict: done|needs-human|blocked`；正文节：结论/证据(file:line)/改动/验证/未验证/风险/下一步；头 3 行是机器契约、不贴用户，给用户正文默认三问：你看到什么/要你做什么/有什么影响（要细节时再给四段：结论/影响/需要你做什么/证据位置））；可选「## 用户可见」节：1–2 句用户能懂的话（你看到什么/要你做什么/有什么影响；needs-human 再加「## 需要你决定」= 问题+推荐+默认；缺失不拒绝，插件兜底）';
  const tail = '收尾：落盘后只发 1 条 ≤200 字消息给 Lead（`task-' + id + ' report ' + report + ' verdict=<...>`）；先 relay_checkpoint 再回执；不读写台账；P0 先报 Lead；只改写范围。';
  return [head, goal, reading, scope, accept, receipt, tail].join('\n');
}

/** 回执头单行宽松解析：允许 markdown 列表前缀/加粗/中文冒号；返回 {key,value} 或 null。 */
function parseHeadLine(line) {
  if (typeof line !== 'string') return null;
  let value = line.trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
  value = value.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '').trim();
  const match = value.match(/^([A-Za-z][A-Za-z-]*)\s*[:：]\s*(.*)$/);
  if (match === null) return null;
  return { key: match[1].toLowerCase(), value: match[2].trim() };
}

/**
 * 回执头 3 行解析（§4.2）：task / revision / verdict（顺序固定，乱序视为无效头）。
 * verdict 严格三值；返回 `{ok, reason?, task?, revision?, verdict?, headLines, body?}`。
 */
export function parseReportHead(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  const nonEmpty = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '') nonEmpty.push({ index, line: lines[index] });
  }
  const headLines = nonEmpty.slice(0, HEAD_KEYS.length).map((entry) => entry.line.trim());
  if (nonEmpty.length < HEAD_KEYS.length) return { ok: false, reason: 'head-missing', headLines };
  const parsed = {};
  for (let index = 0; index < HEAD_KEYS.length; index += 1) {
    const line = parseHeadLine(headLines[index]);
    if (line === null) return { ok: false, reason: 'head-missing', headLines };
    if (line.key !== HEAD_KEYS[index]) return { ok: false, reason: 'head-order', headLines };
    parsed[HEAD_KEYS[index]] = line.value;
  }
  if (parsed.task === '' || parsed.revision === '') return { ok: false, reason: 'head-missing', headLines };
  const verdict = parsed.verdict.toLowerCase();
  if (!VERDICTS.includes(verdict)) return { ok: false, reason: 'verdict-invalid', headLines, verdict };
  const body = lines.slice(nonEmpty[HEAD_KEYS.length - 1].index + 1).join('\n').trim();
  return { ok: true, task: parsed.task, revision: parsed.revision, verdict, headLines, body };
}

/** 取正文「结论」节（任意 # 级标题；缺失/空返回空串）。 */
function conclusionSection(body) {
  const lines = body.split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^#{1,6}\s*结论\s*$/.test(lines[index].trim())) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return '';
  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,6}\s+\S/.test(lines[index].trim())) break;
    collected.push(lines[index]);
  }
  return collected.join('\n').trim();
}

/**
 * digest（≤600 Unicode 码点）：优先「## 结论」节，否则正文前部；压缩空白。
 * 回执头在 parseReportHead 已剥离（长报告不吞头）。
 */
export function digestOf(parsed) {
  const source = isObject(parsed) && typeof parsed.body === 'string'
    ? parsed.body
    : isObject(parsed) && typeof parsed.text === 'string' ? parsed.text : '';
  const section = conclusionSection(source);
  const text = (section !== '' ? section : source).replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > DELEGATION_DIGEST_CHARS ? chars.slice(0, DELEGATION_DIGEST_CHARS).join('') : text;
}


/**
 * dsh-context-relay — notice 投递与状态（v0.10 C4）。
 *
 * 职责：
 * - `deliverPlan`：track 无条件生效；notice **投递成功后**才 claim 去重键（claim 后置，M-11/A-13）；
 *   投递前统一做正文脱敏（M-21：凭据不进入会话历史/UI），失败不 claim（下一步自动重试）。
 * - 通知状态单点：LAST_BAND / CAPACITY_NOTIFIED / LAST_PANEL / PENDING_CLOSURE / LEDGER_GUARD / BOUNDARY_NOTICES。
 * - 压缩复位（A-04/M-11）：`armedBandOf` 检测 compactionSeq 上升 → 到线档位重新武装，并清掉
 *   LEDGER_GUARD / BOUNDARY_NOTICES（被压缩遮蔽的焦点/闭环/边界事实下一步重注入）。
 * - 边界 notice 两段式（A-13/A-15）：先预留（不记「已投递」），下一次 pre-step 从会话事件确认
 *   真正落盘后才记 delivered；同一 previous→phase 的每次真实 crossing 用出现序号区分（旧实现
 *   「每会话仅一次」会吞掉第二次同边界）。
 * - `safeTarget`：闭环 target 只取首行、过凭据脱敏（M-21）。
 *
 * @module dsh-context-relay/agent/notice/deliver
 */
import { capMap, contentText, noticeMessage } from '../shared.js';
import { NOTICE_MAX_BYTES, clipUtf8, phaseLabelOf } from '../../output.js';

/** 到线提醒内存状态（sessionId → {band, compactionSeq}）：只维护「上次看到的 band」。 */
export const LAST_BAND = new Map();
/** 容量保全上升沿去重：sessionId → {used}（窗口占比 ≥capacityThreshold，默认 55% 时注入一次；回落/压缩后重新武装）。 */
export const CAPACITY_NOTIFIED = new Map();
/** 面板变更去重（v0.5.1）：sessionId → 面板签名（模式 + 自动授权开关）。 */
export const LAST_PANEL = new Map();
/** 台账闭环：sessionId → [{tool, target}]（最近 3 条变更类工具成功后的待落账改动）。 */
export const PENDING_CLOSURE = new Map();
/**
 * 台账行级注入去重键：sessionId → {focus, bandKey, closureSig, teamSeen, dispatchSig, basisUnavailable?}。
 * 只有对应内容变化才注入（rev/时间戳/count 不作键）；claim 在注入成功后。
 */
export const LEDGER_GUARD = new Map();
/**
 * phase 边界 notice 状态：sessionId → {counters, pending, delivered}。
 * counters: previous→phase 的出现序号（A-15：每次 crossing 独立，不再每会话只一次）；
 * pending: 已预留未确认投递的 key → {pair, marker}；delivered: 已确认落盘的 key。
 */
export const BOUNDARY_NOTICES = new Map();

const REDACTED = '[REDACTED]';
/** 凭据模式（与 shared.assertNoCredentials 同源；投递侧只脱敏不拒绝——notice 不进存储层）。 */
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
];
const SECRET_ASSIGNMENT = /["']?\b(?:[a-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|private[_-]?key)|key)["']?\s*[:=]\s*["']?(?!null\b|false\b|true\b|\[REDACTED\])[^\s"',;}{]{4,}/gi;
/** 边界投递确认只回看最近 N 条事件（notice 在上一 tool 调用内注入，必在末尾）。 */
const BOUNDARY_SCAN_LIMIT = 200;
/** delivered 键集合上限（长期宿主进程防泄漏；crossing 数远小于此）。 */
const BOUNDARY_DELIVERED_MAX = 100;

/** 正文凭据脱敏（幂等；notice 正文 ≤600 B，正则开销可忽略）。 */
export function redactNoticeText(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(SECRET_ASSIGNMENT, REDACTED);
}

/**
 * 闭环 target 安全化（M-21）：只取首行（防 heredoc/命令换行进入历史）、过凭据脱敏。
 * 不做长度截断——目标文本早已由工具参数限定，截断会把正常文件名切坏。
 */
export function safeTarget(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  return redactNoticeText(raw.split(/\r?\n/, 1)[0].trim());
}

/** 记录一笔「改动未落账」（post-execute 收集；只留最近 3 条，旧到新）。 */
export function recordClosure(sessionId, tool, target) {
  if (sessionId === undefined || sessionId === null) return;
  const memory = PENDING_CLOSURE.get(sessionId) ?? [];
  PENDING_CLOSURE.set(sessionId, [...memory, { tool, target }].slice(-3));
  capMap(PENDING_CLOSURE);
}

/** 台账写入成功（整表替换/patch）后视为已落账，清闭环提示。 */
export function clearClosure(sessionId) {
  if (sessionId === undefined || sessionId === null) return;
  PENDING_CLOSURE.delete(sessionId);
}

function applyBand(sessionId, value) {
  if (value === undefined || value === null) return;
  LAST_BAND.set(sessionId, { band: value.band, compactionSeq: value.compactionSeq });
  capMap(LAST_BAND);
}

function applyCapacity(sessionId, value) {
  if (value === undefined) return;
  if (value === null) {
    CAPACITY_NOTIFIED.delete(sessionId);
    return;
  }
  CAPACITY_NOTIFIED.set(sessionId, value);
  capMap(CAPACITY_NOTIFIED);
}

function applyPanel(sessionId, value) {
  if (value === undefined) return;
  LAST_PANEL.set(sessionId, value);
  capMap(LAST_PANEL);
}

function applyGuard(sessionId, value) {
  if (value === undefined) return;
  LEDGER_GUARD.set(sessionId, value);
  capMap(LEDGER_GUARD);
}

function applyState(sessionId, state) {
  if (state === undefined || state === null) return;
  applyBand(sessionId, state.lastBand);
  applyCapacity(sessionId, state.capacity);
  applyPanel(sessionId, state.panelSig);
  applyGuard(sessionId, state.guard);
}

/**
 * 投递本步计划：track 无条件生效；有 notice 且成功注入才应用 claims。
 * @returns {{delivered: boolean, text?: string}}
 */
export function deliverPlan(caller, sessionId, plan) {
  if (plan === undefined || plan === null) return { delivered: false };
  applyState(sessionId, plan.track);
  const notice = plan.notice;
  if (notice === null || notice === undefined) return { delivered: false };
  if (typeof caller?.inject !== 'function') return { delivered: false };
  const text = clipUtf8(redactNoticeText(notice.text), NOTICE_MAX_BYTES);
  try {
    caller.inject(noticeMessage(text, notice.summary));
  } catch {
    return { delivered: false };
  }
  applyState(sessionId, plan.claims);
  return { delivered: true, text };
}

/**
 * 到线档位读取 + 压缩复位（A-04/M-11）：
 * - 无内存：用持久 notice seed（notice 晚于最近压缩才作数）；
 * - 有内存且 compactionSeq 上升：band 重新武装为 ok，并清 LEDGER_GUARD/BOUNDARY_NOTICES。
 * 返回 {band, compactionSeq, reset, seeded}；写回由后续 track/claims 完成（claim 后置）。
 */
export function armedBandOf(sessionId, persisted) {
  const persistedSeq = Number.isInteger(persisted?.lastCompactionSeq) ? persisted.lastCompactionSeq : -1;
  const memory = LAST_BAND.get(sessionId);
  if (memory === undefined) {
    return { band: persisted?.band ?? 'ok', compactionSeq: persistedSeq, reset: false, seeded: true };
  }
  let band = memory.band;
  let compactionSeq = Number.isInteger(memory.compactionSeq) ? memory.compactionSeq : -1;
  let reset = false;
  if (persistedSeq > compactionSeq) {
    // 成功压缩：上下文里旧的焦点/闭环/边界 notice 已被遮蔽——到线提醒与台账 guard 一起复位。
    band = 'ok';
    compactionSeq = persistedSeq;
    reset = true;
    LEDGER_GUARD.delete(sessionId);
    BOUNDARY_NOTICES.delete(sessionId);
  }
  return { band, compactionSeq, reset, seeded: false };
}

function boundaryMarkerOf(previous, phase) {
  if (previous === 'user-gate') return { kind: 'user-gate', phase: String(phase) };
  return { kind: 'phase', previous: String(previous), phase: String(phase) };
}

function boundaryPairOf(marker) {
  return marker.kind === 'user-gate' ? 'user-gate→' + String(marker.phase ?? '') : marker.previous + '→' + marker.phase;
}

function boundaryStoreOf(sessionId) {
  let state = BOUNDARY_NOTICES.get(sessionId);
  if (state === undefined) {
    state = { counters: new Map(), pending: new Map(), delivered: new Set() };
    BOUNDARY_NOTICES.set(sessionId, state);
    capMap(BOUNDARY_NOTICES);
  }
  return state;
}

/**
 * 边界 notice 预留（tools.js 在注入前调用，签名保持 (sessionId, previous, phase)）：
 * 只做预留、不记「已投递」；同一 crossing 重复调用返回 false；下次 pre-step 确认落盘后才 delivered。
 * A-15：同一 previous→phase 的每次 crossing 用出现序号作 key（不再每会话仅一次）。
 */
export function claimBoundaryNotice(sessionId, previous, phase) {
  if (sessionId === undefined || sessionId === null) return false;
  const state = boundaryStoreOf(sessionId);
  const marker = boundaryMarkerOf(previous, phase);
  const pair = boundaryPairOf(marker);
  for (const entry of state.pending.values()) if (entry.pair === pair) return false;
  const occurrence = state.counters.get(pair) ?? 0;
  const key = pair + '#' + occurrence;
  state.counters.set(pair, occurrence + 1);
  state.pending.set(key, { pair, marker });
  return true;
}

function boundaryEvidence(event, marker) {
  if (event?.type !== 'user/message') return false;
  const message = event.data;
  if (message?.source?.kind !== 'dsh-context-relay' || message?.source?.form !== 'notice') return false;
  const text = contentText(message.content);
  if (marker.kind === 'user-gate') return text.startsWith('[context-relay] 用户汇报');
  return text.startsWith('[插件状态]\n阶段边界：' + phaseLabelOf(marker.previous) + ' → ' + phaseLabelOf(marker.phase) + '（');
}

/**
 * 确认边界 notice 真正落盘（A-13「先投递成功再记」）：回看最近事件，有注入证据 → delivered；
 * 没有证据（注入失败/无 inject）→ 丢弃预留，让后续 crossing 仍可提示。
 */
export function confirmBoundaryNotices(sessionId, session) {
  const state = BOUNDARY_NOTICES.get(sessionId);
  if (state === undefined || state.pending.size === 0) return { confirmed: 0, dropped: 0 };
  let events = [];
  try { events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []; } catch { events = []; }
  const start = Math.max(0, events.length - BOUNDARY_SCAN_LIMIT);
  let confirmed = 0;
  let dropped = 0;
  for (const [key, entry] of [...state.pending]) {
    let hit = false;
    for (let index = events.length - 1; index >= start; index -= 1) {
      if (boundaryEvidence(events[index], entry.marker)) { hit = true; break; }
    }
    state.pending.delete(key);
    if (hit) {
      state.delivered.add(key);
      while (state.delivered.size > BOUNDARY_DELIVERED_MAX) state.delivered.delete(state.delivered.values().next().value);
      confirmed += 1;
    } else dropped += 1;
  }
  return { confirmed, dropped };
}

/** 边界状态快照（测试/诊断；只读副本）。 */
export function boundaryStateOf(sessionId) {
  const state = BOUNDARY_NOTICES.get(sessionId);
  if (state === undefined) return { counters: {}, pending: [], delivered: [] };
  return {
    counters: Object.fromEntries(state.counters),
    pending: [...state.pending.values()].map((entry) => entry.pair),
    delivered: [...state.delivered],
  };
}

/** 清理 notice 层内存（插件卸载/测试）。 */
export function clearNoticeMemory() {
  LAST_BAND.clear();
  CAPACITY_NOTIFIED.clear();
  LAST_PANEL.clear();
  PENDING_CLOSURE.clear();
  LEDGER_GUARD.clear();
  BOUNDARY_NOTICES.clear();
}

/**
 * dsh-context-relay — 官方 sessionProjections 投影单元（host-only，无 wire）。
 *
 * 纯函数 fold：从 committed Session 事件增量派生 relay 需要的全部派生状态，
 * 替代 agent.js 里对 session.snapshotEvents() 的三处全量扫描（官方已标
 * @deprecated：new calls are prohibited，见 dsh-session/lib/index.js:1434）。
 *
 * 派生字段：
 *   phase / goal / exitCriteria  ← relay_phase 调用（PTC 子调用或直调配对）
 *   organizeCount                ← 只计真实压缩成功（调用/失败/空压缩不计）
 *   compactionEpoch              ← 成功 compaction/end 计数（诊断用；哨兵不按其重新武装）
 *   noticeBand / lastNoticeSeq   ← 最近一条 relay notice 的 band 与 seq（跨压缩保留，整会话去重）
 *   lastCompactionSeq            ← 最近一次成功 compaction/end 的 seq（诊断用）
 *   lastContinueActionSeq        ← 最近一次「真正的继续动作」（成功压缩 / 成功接力）的 seq
 *                                  （B-P2-1/P2-9：到线重申判定改读投影，热路径不再 snapshotEvents）
 *   toolCalls / executionCalls    ← Router P0 度量：本会话工具调用总数 / 其中执行类
 *                                  （bash/pwsh/write/edit）计数；PTC 与直调双形态同口径，
 *                                  排除传输层 run_code，不会重复计数
 *
 * 契约：apply 无副作用、O(1)/事件；无关事件返回同一 state 引用（registry 的
 * Object.is 门依赖这一点）；事件缺字段/畸形一律安全（不抛错）。
 *
 * 事件形态双兼容：
 *   PTC：tool/ptc-dispatch（data { name, arguments(对象), isError, content })
 *   直调：tool/call（arguments 为 JSON 字符串）+ tool/result（按 callId 配对）
 *
 * @module dsh-context-relay/projection
 */

import { ROUTER_DENY_TOOLS } from './agent/protocol.js';

/** 官方投影表的 key（进程级唯一；同 key + stateVersion 共享 cells）。 */
export const RELAY_PROJECTION_KEY = 'relay';

/** relay_phase 只认这五个取值（非法值忽略，避免脏参数污染派生状态）。 */
const KNOWN_PHASES = new Set(['discover', 'decide', 'build', 'verify', 'ship']);

const TOOL_PREFIX = 'relay_';
const PHASE_TOOL = TOOL_PREFIX + 'phase';
const ORGANIZE_TOOL = TOOL_PREFIX + 'organize';
/** relay_organize 成功摘要（agent.js 里 render 文本的前缀；失败/空压缩均不以它开头）。 */
const ORGANIZE_OK_PREFIX = 'organized: freed';
const HANDOFF_TOOL = TOOL_PREFIX + 'handoff';
/** relay_handoff 成功摘要标记（agent.js 的 render 文本里含它；失败/busy/lead-only 都不匹配）。 */
const HANDOFF_OK_MARK = 'relay session created via ';
/** 本插件 notice 正文/summary 的固定标记前缀（哨兵与去重派生共用）。 */
const BAND_MARKER = '[context-relay] band=';
/** 直调形态 pending 配对上限：只在 turn 内短暂存在，异常断链时也不无界增长。 */
const MAX_PENDING = 16;
/** 执行类工具（Router P0 度量口径）：本地命令执行 + 文件写入；与协议段 ROUTER_DENY_TOOLS 单一真源对齐。 */
const EXECUTION_TOOLS = new Set(ROUTER_DENY_TOOLS);
/** PTC 传输层工具名：外层 tool/call 的 run_code 与程序内工具调用不是同一层，计入会重复计数。 */
const TRANSPORT_TOOL = 'run_code';

/**
 * 初始状态（frozen，apply 永不修改它；需要变更时返回新对象）。
 * compactionEpoch 从 0 起；lastNoticeSeq/lastCompactionSeq 用 -1 表示「尚无」。
 */
export const initialState = Object.freeze({
  phase: 'discover',
  goal: null,
  exitCriteria: null,
  organizeCount: 0,
  compactionEpoch: 0,
  noticeBand: null,
  lastNoticeSeq: -1,
  lastCompactionSeq: -1,
  lastContinueActionSeq: -1,
  toolCalls: 0,
  executionCalls: 0,
});

/** 取内容块数组里第一段 text（PTC 与 tool/result 的 content 同形）。 */
function firstText(content) {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

/** arguments 双形态归一：PTC 已是对象；直调是模型产出的原始 JSON 字符串。 */
function parseArgs(value) {
  if (value !== null && typeof value === 'object') return value;
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 从文本里抓 band（不依赖正则，避免转义噪音；只认本插件固定标记）。 */
function bandOf(text) {
  const flat = typeof text === 'string' ? text : '';
  const index = flat.indexOf(BAND_MARKER);
  if (index < 0) return null;
  const start = index + BAND_MARKER.length;
  let end = start;
  while (end < flat.length) {
    const code = flat.charCodeAt(end);
    const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    if (!word) break;
    end += 1;
  }
  return end > start ? flat.slice(start, end) : null;
}

/**
 * 应用一次 relay_phase 的参数。phase 非法时整个调用忽略（不覆盖 goal/exit）。
 * **只在 phase 变化时允许清空 goal/exit_criteria**（未提供即 null，避免上一 phase 的
 * 旧目标残留到新 phase 的 brief）；同 phase 的调用（例如 autoChoose 自决流程用
 * relay_phase({phase: 当前 phase, next_operation}) 记录决定）缺省字段沿用旧值——
 * 否则记录决定会清空投影 goal/exit，压缩 brief 丢「目标/退出条件」（B-P1-1）。
 */
function applyPhaseArgs(state, args) {
  if (args === null || typeof args !== 'object') return state;
  const phase = typeof args.phase === 'string' && KNOWN_PHASES.has(args.phase) ? args.phase : null;
  if (phase === null) return state;
  const providedGoal = typeof args.goal === 'string' ? args.goal : null;
  const providedExit = typeof args.exit_criteria === 'string'
    ? args.exit_criteria
    : typeof args.exitCriteria === 'string' ? args.exitCriteria : null;
  const samePhase = phase === state.phase;
  const goal = samePhase && providedGoal === null ? state.goal : providedGoal;
  const exitCriteria = samePhase && providedExit === null ? state.exitCriteria : providedExit;
  if (phase === state.phase && goal === state.goal && exitCriteria === state.exitCriteria) return state;
  return { ...state, phase, goal, exitCriteria };
}

/** 记录「真正的继续动作」seq（成功压缩 / 成功接力共用；只增不减）。 */
function markContinueAction(state, seq) {
  const next = Number.isInteger(seq) ? seq : -1;
  const current = Number.isInteger(state.lastContinueActionSeq) ? state.lastContinueActionSeq : -1;
  if (next <= current) return state;
  return { ...state, lastContinueActionSeq: next };
}

/** organizeCount 只 +1 真实压缩成功；同时记录继续动作 seq（到线重申判定用）。 */
function bumpOrganize(state, seq) {
  return markContinueAction({ ...state, organizeCount: state.organizeCount + 1 }, seq);
}

/**
 * 记一次工具调用（Router P0 度量；PTC 与直调双形态共用）。
 * 排除传输层 run_code：PTC 会话里外层 tool/call=run_code、程序内才有真实工具名，
 * 两层都计会把同一次执行算两遍。只认字符串工具名；没产生计数变化返回同一 state 引用。
 */
function countToolCall(state, name) {
  if (typeof name !== 'string' || name === TRANSPORT_TOOL) return state;
  const toolCalls = (Number.isInteger(state.toolCalls) ? state.toolCalls : 0) + 1;
  const executionCalls = (Number.isInteger(state.executionCalls) ? state.executionCalls : 0) + (EXECUTION_TOOLS.has(name) ? 1 : 0);
  return { ...state, toolCalls, executionCalls };
}

/** 复制 state 并去掉内部 pending 字段（直调配对路径用，不在公开初始状态里）。 */
function withoutPending(state) {
  const next = {};
  for (const key of Object.keys(state)) {
    if (key !== 'pendingRelayCalls') next[key] = state[key];
  }
  return next;
}

/** 记录一条直调 relay_* 调用，等 tool/result 按 callId 结算（有上限，防断链泄漏）。 */
function trackPendingCall(state, callId, entry) {
  const current = state.pendingRelayCalls;
  const pending = current === undefined ? {} : { ...current };
  pending[callId] = entry;
  const callIds = Object.keys(pending);
  if (callIds.length > MAX_PENDING) delete pending[callIds[0]];
  return { ...state, pendingRelayCalls: pending };
}

/** 直调 tool/result 结算：只认 success；phase 应用，organize/handoff 按成功文本记录。 */
function settleDirectResult(state, event) {
  const data = event !== null && typeof event === 'object' ? event.data : undefined;
  const message = data !== null && typeof data === 'object' ? data.message : undefined;
  const callId = message !== null && typeof message === 'object' ? message.toolCallId : undefined;
  const pending = state.pendingRelayCalls;
  if (typeof callId !== 'string' || pending === undefined || !Object.hasOwn(pending, callId)) return state;
  const entry = pending[callId];
  const nextPending = { ...pending };
  delete nextPending[callId];
  const next = Object.keys(nextPending).length === 0 ? withoutPending(state) : { ...state, pendingRelayCalls: nextPending };
  const failed = data.error !== undefined || message.isError === true;
  if (failed) return next;
  const text = firstText(message.content);
  const seq = Number.isInteger(event.seq) ? event.seq : -1;
  if (entry.name === PHASE_TOOL) return applyPhaseArgs(next, entry.args);
  if (entry.name === ORGANIZE_TOOL && text.includes(ORGANIZE_OK_PREFIX)) return bumpOrganize(next, seq);
  if (entry.name === HANDOFF_TOOL && text.includes(HANDOFF_OK_MARK)) return markContinueAction(next, seq);
  return next;
}

/** relay notice：只认本插件 source；保留最近 notice 的 band/seq（agent 面按「段」去重：成功压缩开新段）。 */
function applyNotice(state, event) {
  const data = event !== null && typeof event === 'object' ? event.data : undefined;
  const source = data !== null && typeof data === 'object' ? data.source : undefined;
  if (source === null || typeof source !== 'object' || source.kind !== 'dsh-context-relay') return state;
  const seq = Number.isInteger(event.seq) ? event.seq : -1;
  const fromContent = bandOf(firstText(data.content));
  const band = fromContent !== null ? fromContent : bandOf(typeof source.summary === 'string' ? source.summary : '');
  if (band === null) return state;
  if (band === state.noticeBand && seq === state.lastNoticeSeq) return state;
  return { ...state, noticeBand: band, lastNoticeSeq: seq };
}

/**
 * 压缩纪元前进：只认成功压缩（data.error 为空的 compaction/end）。epoch 只作诊断计数，
 * 档位记忆（noticeBand + lastNoticeSeq）保留最近一次 notice；agent 面把它与 lastCompactionSeq 比较：
 * notice 早于最近一次成功压缩 → 属于旧段，重新武装（2026-10-25 用户口径：段内不重复，新段可再提醒）。
 */
function applyCompactionEnd(state, event) {
  if (event.data !== null && typeof event.data === 'object' && event.data.error !== undefined) return state;
  const seq = Number.isInteger(event !== null && typeof event === 'object' ? event.seq : undefined) ? event.seq : state.lastCompactionSeq;
  return { ...state, compactionEpoch: state.compactionEpoch + 1, lastCompactionSeq: seq };
}

/** PTC 形态的 relay 语义（phase/organize/handoff；不含计数——计数在 fold 里与语义正交应用）。 */
function applyPtcRelay(state, data, event) {
  const name = data.name;
  if (name === PHASE_TOOL) return data.isError === true ? state : applyPhaseArgs(state, parseArgs(data.arguments));
  if (name === ORGANIZE_TOOL) {
    if (data.isError === true) return state;
    return firstText(data.content).startsWith(ORGANIZE_OK_PREFIX) ? bumpOrganize(state, event.seq) : state;
  }
  if (name === HANDOFF_TOOL) {
    if (data.isError === true) return state;
    return firstText(data.content).includes(HANDOFF_OK_MARK) ? markContinueAction(state, event.seq) : state;
  }
  return state;
}

/** 直调形态的 pending 跟踪（只有三个 relay 工具需要按 callId 等 result 结算）。 */
function trackDirectRelayCall(state, data) {
  const name = data.name;
  const callId = data.callId;
  if (typeof name !== 'string' || typeof callId !== 'string') return state;
  if (name !== PHASE_TOOL && name !== ORGANIZE_TOOL && name !== HANDOFF_TOOL) return state;
  return trackPendingCall(state, callId, { name, args: parseArgs(data.arguments) });
}

/**
 * 投影 fold：一条 committed 事件 → 下一 state。
 * @param {object} state - 当前派生状态（initialState 或上一次 apply 的结果）。
 * @param {object} event - 真实 Session 事件 { type, seq, data }。
 * @returns {object} 变更时返回新对象；无关/无变化返回同一 state 引用。
 */
export function foldRelayEvent(state, event) {
  if (state === null || typeof state !== 'object') return state;
  const type = event !== null && typeof event === 'object' ? event.type : undefined;
  switch (type) {
    case 'tool/ptc-dispatch': {
      const data = event.data;
      if (data === null || typeof data !== 'object') return state;
      // 语义（phase/organize/handoff）与计数正交：先应用语义，再按 data.name 记一次调用。
      return countToolCall(applyPtcRelay(state, data, event), data.name);
    }
    case 'tool/call': {
      const data = event.data;
      if (data === null || typeof data !== 'object') return state;
      // 直调形态：relay_* 进 pending 等 result 结算；计数按「尝试调用」即时记（不依赖 result）。
      return countToolCall(trackDirectRelayCall(state, data), data.name);
    }
    case 'tool/result':
      return settleDirectResult(state, event);
    case 'user/message':
      return applyNotice(state, event);
    case 'compaction/end':
      return applyCompactionEnd(state, event);
    default:
      return state;
  }
}

/** 官方投影单元定义（host 平面注册；stateSchema 为 duck-typed，官方运行时只调 .parse）。 */
export function relayProjectionDefinition() {
  return {
    key: RELAY_PROJECTION_KEY,
    // v3（2026-11-03）：新增 toolCalls/executionCalls（Router P0 执行占比度量）。
    // v2（2026-10-29）：新增 lastContinueActionSeq（成功压缩/接力的 seq，B-P2-1/P2-9）。
    // 官方 registry 按 (key, stateVersion) 共享 cells：版本一变，旧缓存 cells 失效，下次 touch
    // 时从 committed 日志全量重 fold（历史事件形态完全兼容，旧字段语义不变）。
    stateVersion: 3,
    stateSchema: { parse: (value) => value },
    init: () => initialState,
    apply: foldRelayEvent,
  };
}

/**
 * dsh-context-relay — 到线哨兵层（v0.10 C4：采集 → 规划 → 投递 编排）。
 *
 * - 采集：本模块每步读压力/phase/投影/面板/台账/团队/边界确认/压缩复位，产出 facts；
 * - 规划：纯函数 planNotices(facts)（notice/plan.js）——本步 0/1 条、≤900 字符、固定优先级；
 * - 投递：deliverPlan（notice/deliver.js）——**投递成功后**才 claim 去重键（M-11）、正文脱敏（M-21）。
 * 另含：队友 escalation、派活闸门、面板实时状态发布。热路径优先用 relay 投影；snapshotEvents 仅 fallback。
 * 2026-11-01 用户裁决：删除「到线即处理」「到线未处理每 8 步重申 / 重启补催」——处理点在 phase 边界。
 *
 * @module dsh-context-relay/agent/sentinel
 */
import { PHASES, bandFor, capacityOf, capacityRatioOf, contextCheckChoice, readPressure } from '../policy.js';
import { panelStateOf, publishLiveState } from '../panel-store.js';
import { deriveOrganizeCount, derivePhase, derivePhaseMeta, lastCompactionEventOf, persistedSentinel, pressureOf, relayStateOf, sentinelFromProjection } from './derive.js';
import { TOOL_PREFIX, capMap, cwdOf, isSubagentSession, logInfo, logWarn } from './shared.js';
import { mergeTeamContext, readTeamContext, teamContextRelativePath } from './team-context.js';
import { normalizeWorkItemsConfig, phaseFocusLine, readWorkItems, workItemsRelativePath, workItemsScopeOf } from './work-items.js';
import { CHAIN_LOOKBACK, attributeCompaction, writeHostCompactionRecovery } from './compaction-fallback.js';
import { CHAIN_RELATIVE, readChain } from './chain.js';
import { listMembers, roleOf, sendToMember } from '../team-api.js';
import { isPlaneTracked, planeStatusOf } from '../plane/ensure.js';
import { readRoster, retiredNamesOf, squadMembersOf } from './team.js';
import {
  CAPACITY_NOTIFIED, LAST_BAND, LAST_PANEL, LEDGER_GUARD, PENDING_CLOSURE,
  armedBandOf, clearClosure, clearNoticeMemory, confirmBoundaryNotices, deliverPlan, recordClosure, safeTarget,
} from './notice/deliver.js';
import { SENTINEL_RANK, escalationText, ledgerHasUnclosedItems, planNotices } from './notice/plan.js';

/** 通知层状态与文案的单点（兼容导出：既有工具/测试从 sentinel.js 取这些名字）。 */
export {
  BOUNDARY_NOTICES, CAPACITY_NOTIFIED, LAST_BAND, LAST_PANEL, LEDGER_GUARD, PENDING_CLOSURE, claimBoundaryNotice,
} from './notice/deliver.js';
export {
  capacityNoticeText, escalationHint, panelChangeText, phaseBoundarySummary, phaseBoundaryText, sentinelSummary, sentinelText,
} from './notice/plan.js';

/**
 * 变更类工具（M-03/A-12/B-02）：只认真正写文件的工具。bash/pwsh 含大量只读侦察
 * （grep/cat/ls/git/node），不再计入「改动未落账」——闭环提示只在 write/edit/apply_patch 成功后出现。
 */
const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch']);

/** 同一 plugin 实例（ctx）只注册一次 pre-step 监听，避免热装配重复弹。 */
const SENTINEL_BOUND = new WeakSet();

/** 队友 escalation 去重：sessionId → 已发送请示的 band（band 上升才允许再发；B-P2-4）。 */
export const ESCALATIONS = new Map();

/**
 * P0-D 主动上下文管理（v0.11 §3.4）：sessionId → {phase, pending, delivered, lastAtStep, ...}。
 * 首个 pre-step 只 seed（不提醒）；phase/task 事件入 pending，planNotices 生成 context-check notice，
 * 投递成功才 commit（delivered/冷却步数）。压缩复位不清本 Map（delivered 防重放）。
 */
export const CONTEXT_CHECK_MEMORY = new Map();
/** P0-D 工具后置信号队列（create_goal / task_board_run 成功后由 post-execute 入队）。 */
export const PENDING_TASK_SIGNALS = new Map();
/** 同一会话任意两条 context-check 的最小步数间隔（§3.4.7）。 */
export const CONTEXT_CHECK_MIN_STEPS = 3;
const CONTEXT_CHECK_DELIVERED_MAX = 100;
const CONTEXT_CHECK_RETRY_MAX = 5;
const PENDING_TASK_SIGNALS_MAX = 16;

function contextMemoryOf(session) {
  const id = session?.id;
  if (typeof id !== 'string' || id === '') return undefined;
  let memory = CONTEXT_CHECK_MEMORY.get(id);
  if (memory === undefined) {
    memory = {
      phase: undefined,
      phaseSeq: 0,
      pending: [],
      delivered: new Set(),
      lastAtStep: undefined,
      retries: 0,
      shipScanSeq: undefined,
      shipNotified: false,
      tick: 0,
    };
    CONTEXT_CHECK_MEMORY.set(id, memory);
    capMap(CONTEXT_CHECK_MEMORY);
  }
  return memory;
}

function contextStepOf(session, memory) {
  const seq = session?.seq;
  if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
  memory.tick += 1;
  return memory.tick;
}

function taskSignalKeyOf(result, args, session) {
  const raw = result?.goal?.id ?? result?.goalId ?? result?.taskId ?? result?.task?.id ?? args?.goalId ?? args?.taskId;
  if (typeof raw === 'string' && raw !== '') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  const seq = session?.seq;
  return 'seq:' + (typeof seq === 'number' && Number.isFinite(seq) ? seq : 'unknown');
}

/** post-execute 入队新任务信号（只留给下一步 pre-step 消费；cap 16/会话）。 */
function enqueueTaskSignal(session, kind, result, args) {
  const id = session?.id;
  if (typeof id !== 'string' || id === '') return;
  const key = taskSignalKeyOf(result, args, session);
  const queue = PENDING_TASK_SIGNALS.get(id) ?? [];
  queue.push({ kind, key });
  PENDING_TASK_SIGNALS.set(id, queue.slice(-PENDING_TASK_SIGNALS_MAX));
  capMap(PENDING_TASK_SIGNALS);
}

function pushContextTrigger(memory, trigger) {
  if (memory.delivered.has(trigger.key)) return;
  if (memory.pending.some((row) => row.key === trigger.key)) return;
  memory.pending.push(trigger);
}

function drainTaskSignals(session, memory) {
  const id = session?.id;
  if (typeof id !== 'string' || id === '') return;
  const queued = PENDING_TASK_SIGNALS.get(id);
  if (!Array.isArray(queued) || queued.length === 0) return;
  PENDING_TASK_SIGNALS.delete(id);
  for (const signal of queued) {
    pushContextTrigger(memory, {
      kind: signal.kind,
      key: 'task:' + signal.kind + '#' + signal.key,
      taskKey: signal.key,
    });
  }
}

/** ship 段第一条真实用户消息（source.kind !== 'dsh-context-relay'）；按 session.seq 缓存扫描。 */
function scanShipUserTrigger(session, memory, step) {
  if (memory.shipScanSeq === undefined) {
    memory.shipScanSeq = step;
    return;
  }
  if (memory.shipScanSeq === step) return; // 同一步已扫过：不重复扫描
  let events = [];
  try { events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []; } catch { events = []; }
  const start = Number.isFinite(memory.shipScanSeq) ? memory.shipScanSeq : 0;
  let found;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue;
    const eventSeq = Number.isInteger(event.seq) ? event.seq : undefined;
    if (eventSeq === undefined || eventSeq <= start) continue;
    if (event?.data?.source?.kind === 'dsh-context-relay') continue;
    found = eventSeq;
  }
  const lastSeq = Array.isArray(events) && events.length > 0 && Number.isInteger(events[events.length - 1]?.seq)
    ? events[events.length - 1].seq
    : start;
  memory.shipScanSeq = step ?? lastSeq;
  if (found !== undefined && memory.shipNotified !== true) {
    memory.shipNotified = true;
    pushContextTrigger(memory, { kind: 'user-after-ship', key: 'task:user-after-ship#' + found, taskKey: String(found) });
  }
}

/**
 * 采集 P0-D 事实（fail-open）：phase 变化 / 新任务信号 / ship 后首条用户消息 → 合并成一条
 * contextCheck fact（含 recommendation/keys/step）；首个 pre-step 只 seed。
 */
function contextCheckFactOf({ session, phase, state, capacity, panel, organizeCount, subagent }) {
  if (subagent) return undefined;
  const memory = contextMemoryOf(session);
  if (memory === undefined) return undefined;
  const step = contextStepOf(session, memory);
  const current = PHASES.includes(phase) ? phase : undefined;
  if (memory.phase === undefined) {
    // 首个 pre-step 只 seed（不提醒）；task 信号保留到下一步，避免启动噪音/重放。
    if (current !== undefined) memory.phase = current;
    if (current === 'ship') { memory.shipScanSeq = step; memory.shipNotified = false; }
    drainTaskSignals(session, memory);
    return undefined;
  }
  if (current !== undefined && current !== memory.phase) {
    const previous = memory.phase;
    memory.phase = current;
    if (current === 'ship') { memory.shipScanSeq = step; memory.shipNotified = false; }
    // 到 organize/relay 的跨界由既有边界 notice 给动作；这里不重复入队（§3.4.3 overBudget 抑制）。
    if ((SENTINEL_RANK[state?.band] ?? 0) < (SENTINEL_RANK.organize ?? 2)) {
      memory.phaseSeq += 1;
      pushContextTrigger(memory, {
        kind: 'phase',
        key: 'phase:' + previous + '>' + current + '#' + memory.phaseSeq,
        from: previous,
        to: current,
      });
    }
  }
  if (current === 'ship') scanShipUserTrigger(session, memory, step);
  drainTaskSignals(session, memory);
  memory.pending = memory.pending.filter((trigger) => !memory.delivered.has(trigger.key));
  if (memory.pending.length === 0) return undefined;
  if (memory.lastAtStep !== undefined && step - memory.lastAtStep < CONTEXT_CHECK_MIN_STEPS) return undefined;
  const phaseTrigger = memory.pending.find((trigger) => trigger.kind === 'phase');
  const taskTrigger = memory.pending.find((trigger) => trigger.kind !== 'phase');
  const triggers = [phaseTrigger, taskTrigger].filter((trigger) => trigger !== undefined);
  if (triggers.length === 0) return undefined;
  const recommendation = contextCheckChoice({
    band: state?.band,
    organizeCount,
    panel,
    trigger: phaseTrigger !== undefined ? 'phase' : 'task',
    capacityAtRisk: capacity?.atRisk === true,
  });
  return {
    phase: phaseTrigger === undefined ? undefined : { from: phaseTrigger.from, to: phaseTrigger.to },
    task: taskTrigger === undefined ? undefined : { kind: taskTrigger.kind, key: taskTrigger.taskKey },
    recommendation,
    panel,
    band: state?.band,
    capacity,
    keys: triggers.map((trigger) => trigger.key),
    step,
  };
}

/** 投递成功才提交：key 入 delivered（cap 100）、清 pending、记录冷却步数。 */
function commitContextCheck(sessionId, claim, step) {
  const memory = CONTEXT_CHECK_MEMORY.get(sessionId);
  if (memory === undefined) return;
  const keys = Array.isArray(claim?.keys) ? claim.keys : [];
  for (const key of keys) {
    if (typeof key !== 'string' || key === '') continue;
    memory.delivered.add(key);
    memory.pending = memory.pending.filter((trigger) => trigger.key !== key);
  }
  while (memory.delivered.size > CONTEXT_CHECK_DELIVERED_MAX) memory.delivered.delete(memory.delivered.values().next().value);
  memory.lastAtStep = step;
  memory.retries = 0;
}

/** 注入缺失/抛错：不 claim，pending 保留；最多重试 5 步后丢弃（防内存泄漏）。 */
function failContextCheck(ctx, sessionId) {
  const memory = CONTEXT_CHECK_MEMORY.get(sessionId);
  if (memory === undefined) return;
  memory.retries += 1;
  if (memory.retries > CONTEXT_CHECK_RETRY_MAX) {
    const dropped = memory.pending.length;
    memory.pending = [];
    memory.retries = 0;
    logWarn(ctx, '[context-check] pending dropped after ' + CONTEXT_CHECK_RETRY_MAX + ' failed delivery steps: session=' + sessionId + ' dropped=' + dropped);
  }
}

/** 闭环 target（M-21）：file_path/path 取 basename；apply_patch 取 patch 头目标文件；一律首行 + 脱敏。 */
function closureTargetOf(args) {
  if (args === null || typeof args !== 'object') return '';
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
  if (path !== '') return safeTarget(path.split('/').pop());
  const patch = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
  if (patch !== '') {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch);
    if (match !== null) return safeTarget(match[1].split('/').pop());
  }
  return '';
}


/** 队友 escalation 是否已发过（同一 band 或更高档已发）；重启后复用投影里的持久 notice 标记。 */
function escalationAlreadySent(sessionId, band, projected) {
  const rank = SENTINEL_RANK[band] ?? 0;
  const sentBand = sessionId === undefined ? undefined : ESCALATIONS.get(sessionId);
  if (sentBand !== undefined && rank <= (SENTINEL_RANK[sentBand] ?? 0)) return true;
  if (projected !== undefined) {
    const persisted = sentinelFromProjection(projected);
    if (persisted?.band !== undefined && rank <= (SENTINEL_RANK[persisted.band] ?? 0)) return true;
  }
  return false;
}

/** 请示发送成功才记账；band 上升后 rank 超过记录值会再次允许发送。 */
function markEscalated(sessionId, band) {
  if (sessionId === undefined) return;
  ESCALATIONS.set(sessionId, band);
  capMap(ESCALATIONS);
}

/**
 * 队友到线时向上一级请示（Agent Teams 成员 → Lead；普通 subagent 无 Team 服务则返回未发送，由 notice 文案提示自行 send_message）。
 * 失败只降级为「未发送」，不影响提醒注入。B-P2-4：同 (sessionId, band) 只发一次——每次
 * relay_phase 尝试都发会让 Lead 收件箱被同一事实刷屏；band 上升后才允许再请示。
 */
export async function escalateToLead(ctx, caller, state, phase, projected) {
  const sessionId = caller?.session?.id;
  if (escalationAlreadySent(sessionId, state.band, projected)) return { sent: false, deduped: true };
  const membership = roleOf(ctx, caller);
  if (membership === undefined || membership.role !== 'teammate') return { sent: false, reason: 'not a teammate' };
  const sent = await sendToMember(ctx, caller, 'lead', [{ type: 'text', text: escalationText(membership.name, state, phase) }], { signal: new AbortController().signal });
  if (!sent.ok) {
    logWarn(ctx, '[escalation] failed: ' + sent.reason);
    return { sent: false, reason: sent.reason };
  }
  markEscalated(sessionId, state.band);
  // v0.6.3：把「这个队友要 Lead 决策」落到 Lead 的团队上下文快照里——Lead 焦点行会带出
  // 「队友待处理」，不依赖 Lead 记得主动查（也不按时间重提）。
  try {
    const root = membership?.root;
    const leadSessionId = root?.session?.id ?? root?.id;
    if (typeof leadSessionId === 'string' && leadSessionId !== '') {
      // v0.11 P0-B：[队友] 待处理行只来自 squad——legacy 队友的请示不写快照（消息仍送达）。
      const inSquad = squadMembersOf(readRoster(cwdOf(caller.session), leadSessionId), [{ name: membership.name }]).length > 0;
      if (inSquad) await mergeTeamContext(cwdOf(caller.session), leadSessionId, { name: membership.name, band: state.band, phase });
    }
  } catch { /* 快照写失败不影响请示 */ }
  logInfo(ctx, '[escalation] sent session=' + String(sessionId ?? '?') + ' band=' + state.band);
  return { sent: true, name: membership.name };
}

/** relay_* 工具调用后刷新 composer 面板实时状态（失败不影响工具主流程）。 */
export function publishLiveFor(ctx, session, thresholds) {
  try {
    if (session === undefined || session === null || session.id === undefined || session.id === null) return;
    const projected = relayStateOf(ctx, session);
    const state = bandFor(pressureOf(ctx, session), thresholds);
    publishLiveState(session.id, {
      band: state.band,
      used: state.used,
      window: state.window,
      ratio: state.ratio,
      phase: derivePhase(session, projected),
      organizeCount: deriveOrganizeCount(session, projected),
      overBudget: state.band === 'organize' || state.band === 'relay',
    });
  } catch { /* 面板实时状态失败不影响工具 */ }
}

/** 安全读一个队友的上下文（live 优先/冷读持久日志），读不到返回 undefined。 */
export async function teammateState(ctx, member) {
  const query = ctx.get('sessionQuery');
  if (query === undefined || typeof query.observeSession !== 'function') return undefined;
  let lease;
  try {
    lease = await query.observeSession(member.id, { projectionMode: 'all' });
    const pressure = readPressure({ projection: lease?.projections?.values?.contextPressure });
    return pressure;
  } catch {
    return undefined;
  } finally {
    try { lease?.[Symbol.dispose]?.(); } catch { /* 忽略 */ }
  }
}

/**
 * v0.6.3：派活时的队友上下文评估（用户口径：管理队友上下文应在**派活时**决定，而不是等 phase 边界）。
 *
 * 主路径 = tools/pre-execute 闸门：Lead 用 send_message 派活前，插件先读该队友档位/状态——
 * **每个 (target, band, status) 首次/变化时给一次判断点**（deny，本条消息不发出）：状态 + 两个选项——
 * ①先管理再派（checkpoint → freshen(reset)/renew，处理完重派）；②直接派（原样重发即放行，本次算
 * Lead 的判断）；同状态后续派活直接放行，不再重复打断（P1 D2=A）。
 * 空闲队友（status≠running）= 派活，首次/状态变化给判断点；忙队友（running）只有到线/读不到时才给（协调消息不拦）。
 * 同时写团队上下文快照（phase 边界 team_note 闸门的兜底），压缩/重启后仍在。
 *
 * 兜底路径 = tools/post-execute：若闸门被绕过（例如装配顺序），派活后仍会读一次档位并在下一步
 * 注入一次「[派活·队友上下文]」——快照已记的不重复催。
 */
export const PENDING_DISPATCH = new Map();
/**
 * v0.9.0 批次4 P1 派活判断点记忆（D2=A）：sessionId → Map<target, 'band|status'>。
 * 同一 (target, band, status) 只打断一次；状态变化才再给判断点；同状态重发直接放行。
 */
export const DISPATCH_ACK = new Map();

/** rc.2 send_message 参数是 {agent,message}。pre/post 共用。 */
export function sendTargetOf(exec) {
  const args = exec?.arguments;
  return typeof args?.agent === 'string' && args.agent !== '' ? args.agent : '';
}

/** v0.11 P0-B：队友退役后清掉派活提示/判断点记忆（名字仍在 catalog，但不再待处理）。 */
export function forgetDispatchRows(...names) {
  const targets = new Set(names.map((name) => String(name ?? '')).filter((name) => name !== ''));
  if (targets.size === 0) return;
  for (const [sessionId, rows] of PENDING_DISPATCH) {
    const kept = Array.isArray(rows) ? rows.filter((row) => !targets.has(row?.target)) : [];
    if (kept.length === 0) PENDING_DISPATCH.delete(sessionId);
    else PENDING_DISPATCH.set(sessionId, kept);
  }
  for (const [sessionId, ack] of DISPATCH_ACK) {
    for (const name of [...ack.keys()]) {
      if (targets.has(name)) ack.delete(name);
    }
    if (ack.size === 0) DISPATCH_ACK.delete(sessionId);
  }
}

/** band → 派活前是否需要先管理该队友上下文（'' = 不需要）。v0.9.0 批次3：relay_dispatch 复用同一判断（导出防两份漂移）。 */
export function dispatchNeedOf(band) {
  if (band === 'organize' || band === 'relay') {
    return '先让它 relay_checkpoint 收口，再 relay_freshen({reset:true, brief:新任务}) 真清空复用（同成员、0 额度）；同任务内减压用 freshen（同代≤2），换身份才 renew';
  }
  if (band === 'unavailable') return '读不到它的上下文（指标不可用）：先 relay_team_status 确认，或管理后再派';
  if (band === 'unknown') return '读不到它的上下文：先 relay_team_status 确认状态，或按 new/renew 处理后再派';
  return '';
}

/** 派活目标的 roster 视图：只有当前小队（squad）可派；退休代/legacy 拒绝而不是冷启动旧上下文。 */
function dispatchRosterOf(session, membership, listed) {
  const root = membership?.root;
  const leadSessionId = root?.session?.id ?? root?.id ?? session?.id;
  let roster;
  try { roster = readRoster(cwdOf(session), leadSessionId); } catch { roster = undefined; }
  const teammates = Array.isArray(listed?.members) ? listed.members.filter((member) => member?.role === 'teammate') : [];
  return {
    leadSessionId,
    retired: retiredNamesOf(roster),
    squad: squadMembersOf(roster, teammates),
    all: teammates,
  };
}

/** send_message 派活 → 评估目标队友上下文；需要管理时记提示 + 写团队上下文快照（失败 fail-open）。 */
async function evaluateDispatch(ctx, session, exec, thresholds) {
  const target = sendTargetOf(exec);
  if (target === '' || target === 'lead') return;
  const membership = roleOf(ctx, exec.agent);
  if (membership?.role !== 'lead') return;
  const listed = await listMembers(ctx, exec.agent);
  if (!listed.ok) return;
  const roster = dispatchRosterOf(session, membership, listed);
  const match = roster.all.find((item) => item.name === target || item.id === target);
  if (match === undefined || roster.retired.has(match.name)) return;
  const member = roster.squad.find((item) => item.name === match.name);
  if (member === undefined) return;
  const pressure = await teammateState(ctx, member);
  const band = pressure === undefined ? 'unknown' : bandFor(pressure, thresholds).band;
  const action = dispatchNeedOf(band);
  if (action === '') return;
  const cwd = cwdOf(session);
  const leadSessionId = roster.leadSessionId;
  let alreadyPending = false;
  try { alreadyPending = readTeamContext(cwd, leadSessionId).pending.some((row) => row.name === member.name); } catch { alreadyPending = false; }
  try { await mergeTeamContext(cwd, leadSessionId, { name: member.name, band }); } catch { /* 快照写失败不影响提示 */ }
  if (alreadyPending) return; // 已在待处理：escalation/上次派活已提示过，不重复催
  const rows = PENDING_DISPATCH.get(session.id) ?? [];
  PENDING_DISPATCH.set(session.id, rows.filter((row) => row.target !== member.name).concat({ target: member.name, band, ratio: pressure?.ratio, action }).slice(-3));
  capMap(PENDING_DISPATCH);
}

/**
 * pre-execute 闸门：派活前先读状态，按 (target, band, status) 首次/变化时给一次判断点
 * （deny，本条消息不发出）；同状态后续派活直接放行（P1 D2=A；重发同状态即派）。
 * - 空闲队友（status≠running）：首次/状态变化给判断点——模型看过状态后原样重发即派；
 * - 忙队友（running）：只有到线/读不到（需要管理）才给判断点，普通协调消息不拦；
 * - 退休代：恒 deny（分支在 ack 之前，身份错误不允许被去重）。
 */
async function evaluateDispatchGate(ctx, session, exec, thresholds) {
  const target = sendTargetOf(exec);
  if (target === '' || target === 'lead') return undefined;
  const membership = roleOf(ctx, exec.agent);
  if (membership?.role !== 'lead') return undefined;
  const listed = await listMembers(ctx, exec.agent);
  if (!listed.ok) return undefined;
  const roster = dispatchRosterOf(session, membership, listed);
  const match = roster.all.find((item) => item.name === target || item.id === target);
  if (match === undefined) return undefined;
  if (roster.retired.has(match.name)) {
    return {
      kind: 'deny',
      reason: 'send_message refused: ' + match.name + ' 是已退休代（catalog 仍保留，但不再派活/不再驻留）。用 relay_team_status 找同 lineage 的当前代；旧细节用 session_event_read 回读，不要冷启动旧上下文。',
    };
  }
  const member = roster.squad.find((item) => item.name === match.name);
  // v0.11 P0-B：非 squad（legacy/历史成员）默认不可派活——要它先 adopt，不用就 retire。
  if (member === undefined) {
    return {
      kind: 'deny',
      reason: 'send_message refused: ' + match.name + ' 不在当前小队（历史/legacy 成员默认隐藏、不可派活）。查看：relay_team_status({include_legacy:true})；要用它先 relay_team_status({manage:{action:\'adopt\',names:[\'' + match.name + '\'],reason:\'…\'}})；不再需要用 manage:{action:\'retire\',scope:\'legacy\',keep:[...],reason:\'…\'} 清理。',
    };
  }
  const pressure = await teammateState(ctx, member);
  const band = pressure === undefined ? 'unknown' : bandFor(pressure, thresholds).band;
  const management = dispatchNeedOf(band);
  const statusLabel = String(member.status ?? 'unknown');
  const idle = statusLabel !== 'running'; // 空闲队友 = 一次新派活
  // 忙队友的普通协调消息不拦（只拦需要管理的）；空闲队友首次/状态变化时给判断点。
  if (management === '' && !idle) return undefined;
  // P1（D2=A）：按 (target, band, status) 记忆——同状态后续派活直接放行；状态变化再判断一次。
  const ackKey = band + '|' + statusLabel;
  let ackMap = DISPATCH_ACK.get(session.id);
  if (ackMap === undefined) { ackMap = new Map(); DISPATCH_ACK.set(session.id, ackMap); capMap(DISPATCH_ACK); }
  if (ackMap.get(member.name) === ackKey) return undefined;
  ackMap.set(member.name, ackKey);
  const ratioText = pressure?.ratio === undefined ? '' : '（' + Math.round(pressure.ratio * 1000) / 10 + '%）';
  // 到线/读不到：记快照（pending）——即使 Lead 决定直接派，phase 边界 team_note 闸门仍会兜底。
  if (management !== '') {
    try {
      const root = membership.root;
      const leadSessionId = root?.session?.id ?? root?.id ?? session.id;
      await mergeTeamContext(cwdOf(session), leadSessionId, { name: member.name, band });
    } catch { /* 快照写失败不影响闸门 */ }
  }
  const stateText = member.name + ' band=' + band + ratioText + ' · status=' + statusLabel;
  if (management !== '') {
    return {
      kind: 'deny',
      reason: '派活前先读状态：' + stateText + '——' + management
        + '。两种做法：①先管理再派（推荐：发消息让它 relay_checkpoint，再 relay_freshen({reset:true, brief:新任务})，换身份才 relay_renew；处理完再派活）；②直接派（接受脏上下文：原样重发本次 send_message 即放行，本次算你的判断，phase 边界仍需 team_note）。',
    };
  }
  const hint = band === 'warn' ? '可派，但任务收口后要让它 relay_checkpoint' : '在线内，可直接派（大任务前也可先 checkpoint）';
  return {
    kind: 'deny',
    reason: '派活前先读状态：' + stateText + '——' + hint + '。判断：直接派 → 原样重发本次 send_message 即放行；先管理 → 让它 relay_checkpoint，必要时 relay_freshen({reset:true, brief}) 后重派。',
  };
}

/**
 * P1-A（v0.11）：宿主自动压缩兜底待投递事实（sessionId → {kind,compactionSeq,path?,writeFailed?,error?}）。
 * 快照写成功/失败都保留到下一条 recovery notice 投递成功（claims.guard.fallbackSeq）后清除。
 */
export const HOST_FALLBACK = new Map();

/**
 * 注册到线提醒 pre-step 监听（同一 ctx 只注册一次；返回 dispose）。
 * currentCapacityRatio：容量线比例读取（v0.11 P0-E 独立配置；缺省回落 capacityRatioOf() 默认 55%）。
 * compactionFallback：P1-A 宿主自动压缩兜底 on（默认）/ off（不写快照、不提示）。
 */
export function installSentinel(ctx, currentThresholds, workItems, contextCheck = true, currentCapacityRatio = () => capacityRatioOf(), compactionFallback = true) {
  // 工作台账配置（v0.5.0）：host 装配传入归一化配置；缺省按默认（enabled=true）——老装配/单测兼容。
  const workItemsConfig = workItems ?? normalizeWorkItemsConfig({});
  const contextCheckOn = contextCheck !== false;
  /** P1-A：宿主自动压缩兜底开关（默认 on；off 不归因、不写快照、不提示——v0.10 旧行为）。 */
  const compactionFallbackOn = compactionFallback !== false;
  if (SENTINEL_BOUND.has(ctx)) return () => {};
  SENTINEL_BOUND.add(ctx);
  return ctx.effect(() => {
    // v0.6.3：派活前闸门——send_message 到队友前先读该队友档位；到线/读不到拦一次（deny），
    // Lead 决定「先管理再派」还是「直接派」（重发即放行）。不改 Agent Teams 工具，只在 dispatch 前读状态。
    const dispatchGate = async function dshContextRelayDispatchGate(exec, next) {
      try {
        const session = exec?.agent?.session;
        if (session !== undefined && session?.id !== undefined && !isSubagentSession(session) && String(exec?.name ?? '') === 'send_message') {
          const denied = await evaluateDispatchGate(ctx, session, exec, currentThresholds());
          if (denied !== undefined) return denied;
        }
      } catch { /* fail-open：闸门自己失败不得阻断派活 */ }
      return next();
    };
    const disposePre = ctx.on('tools/pre-execute', dispatchGate);
    // v0.6.0：变更类工具成功 → 记「待落账」；relay_work_items **写入**成功 → 视为已落账（B-04：
    // 只读调用不再清 pending——查一眼台账不会把未落账改动标成已闭环）。
    const disposePost = ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        const session = exec?.agent?.session;
        if (session !== undefined && session.id !== undefined && !isSubagentSession(session) && result?.isError !== true) {
          const name = String(exec?.name ?? '');
          if (name === TOOL_PREFIX + 'work_items') {
            const args = exec?.arguments;
            const wroteLedger = Array.isArray(args?.items) || result?.mode === 'replace' || result?.mode === 'patch';
            if (wroteLedger) clearClosure(session.id);
          } else if (MUTATION_TOOLS.has(name)) {
            recordClosure(session.id, name, closureTargetOf(exec?.arguments));
          } else if (contextCheckOn && (name === 'create_goal' || name === 'task_board_run')) {
            // P0-D B1/B2：新 goal / 任务板卡片启动 → 下一步 pre-step 发起点自查。
            enqueueTaskSignal(session, name === 'create_goal' ? 'goal' : 'task-board', result, exec?.arguments);
          } else if (name === 'send_message') {
            // v0.6.3：派活时评估该队友上下文（和工具解耦：不改 Agent Teams 工具，只在执行后读状态）。
            try { await evaluateDispatch(ctx, session, exec, currentThresholds()); } catch { /* fail-open */ }
          }
        }
      } catch { /* fail-open */ }
      return next();
    });
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const caller = payload?.agent;
        if (caller !== undefined && caller.session !== undefined) {
          const session = caller.session;
          // 已接力的旧会话是审计档：不再提醒/重申（否则会反复催一个已经交接完的会话）。
          if (panelStateOf(session.id).handedOff === true) return next();
          const projected = relayStateOf(ctx, session);
          const thresholds = currentThresholds();
          // 压力只读一次——到线档位与容量保全共用同一事实（不重复读投影）。
          const pressure = pressureOf(ctx, session);
          const state = bandFor(pressure, thresholds);
          const capacity = capacityOf(pressure, { ratio: currentCapacityRatio() });
          const phase = derivePhase(session, projected);
          const persisted = persistedSentinel(session, projected);
          // 边界 notice 两段式（A-13）：先确认上一次预留是否**真落盘**（有注入证据才记 delivered）。
          const boundary = confirmBoundaryNotices(session.id, session);
          // 压缩复位（A-04/M-11）：compactionSeq 上升 → band 重新武装并清 LEDGER_GUARD/BOUNDARY_NOTICES。
          const armed = armedBandOf(session.id, persisted);
          if (armed.reset) logInfo(ctx, '[compaction] notice guards re-armed session=' + session.id + ' seq=' + String(armed.compactionSeq));
          if (boundary.confirmed > 0) logInfo(ctx, '[boundary] delivered session=' + session.id + ' confirmed=' + boundary.confirmed);
          const rank = SENTINEL_RANK[state.band] ?? 0;
          const overBudget = rank >= (SENTINEL_RANK.organize ?? 0);
          const organizeCount = deriveOrganizeCount(session, projected);
          // 面板实时状态：每个 pre-step 都发布（host 的 GET /context-relay/panel 读它）。
          try {
            publishLiveState(session.id, { band: state.band, used: state.used, window: state.window, ratio: state.ratio, phase, organizeCount, overBudget });
          } catch { /* 实时状态失败不阻断 */ }
          const subagent = isSubagentSession(session);
          // 平面事实（C15/设计 §5）：只读 ensure 已跟踪的 agent——生产 pre-step 更早的惰性 ensure 已回填；
          // 未跟踪（精简句柄/未 reconcile）不产生降级噪音。installed=false 或 degradations 非空由 plan
          // 转成「每压缩周期一次」的 notice（claim 后置、压缩复位），并指向 relay_status.plane。
          let plane;
          try { if (isPlaneTracked(caller)) plane = planeStatusOf(caller); } catch { plane = undefined; }
          const panel = subagent ? undefined : panelStateOf(session.id);
          // P0-D：phase/task 事件采集（fail-open；首个 pre-step 只 seed）；off 时完全静默。
          const contextCheckFact = contextCheckOn
            ? contextCheckFactOf({ session, phase, state, capacity, panel, organizeCount, subagent })
            : undefined;
          const workItemsOn = workItemsConfig.enabled !== false;
          // 台账/团队上下文只对 Lead 读一次（队友没有 relay_work_items 工具面，notice 也不带台账——M-12）。
          let ledger;
          let teamCtx;
          if (!subagent && workItemsOn) {
            const cwd = cwdOf(session);
            const scopeId = workItemsScopeOf(session);
            // C7/pre-step 只读：热路径不做惰性迁移写盘（也不为旧 workspace 台账每步多一次 stat）——只读当前台账。
            try { ledger = readWorkItems(cwd, { pathOverride: workItemsConfig.pathOverride, scopeId, migrateLegacy: false }); } catch { ledger = undefined; }
            try { teamCtx = readTeamContext(cwd, scopeId); } catch { teamCtx = undefined; }
            // [闭环] 只在「有分点可落账」时才有意义：没有台账（无处落账）或没有未闭合分点时清掉待落账标记，
            // 否则之后新开分点会把陈年改动翻出来重提（用户 2026-11-16 反馈）。读取失败（undefined）不禁用。
            if (ledger !== undefined && !ledgerHasUnclosedItems(ledger)) clearClosure(session.id);
          }
          // P1-A（v0.11）：宿主自动压缩兜底——armed.reset 表示检测到新成功压缩；归因后仅 host 写快照+提示。
          // 归因/写盘全部 fail-open（只 logWarn，不阻断 pre-step）；unknown 不写、只提示日志（避免与 relay_organize 重复）。
          let compactionFallbackFact;
          if (compactionFallbackOn) {
            if (HOST_FALLBACK.has(session.id)) compactionFallbackFact = HOST_FALLBACK.get(session.id);
            if (armed.reset) {
              try {
                const cwd = cwdOf(session);
                // 投影热路径不扫日志；仅在 armed.reset 这一步补扫一次 compactionId（P1-A 归因）。
                const compactionId = persisted.lastCompactionId ?? lastCompactionEventOf(session)?.compactionId;
                const attribution = attributeCompaction({
                  compactionId,
                  entries: readChain(cwd, CHAIN_LOOKBACK),
                });
                if (attribution === 'host') {
                  const meta = derivePhaseMeta(session, projected);
                  const scopeId = workItemsScopeOf(session);
                  const written = await writeHostCompactionRecovery(cwd, {
                    sessionId: session.id,
                    compactionId,
                    at: new Date().toISOString(),
                    phase,
                    goal: meta.goal,
                    exitCriteria: meta.exit_criteria,
                    ledger: ledger === undefined ? undefined : {
                      path: '.scratch/context-relay/' + workItemsRelativePath(workItemsConfig.pathOverride, scopeId),
                      counts: ledger.counts,
                      focus: phaseFocusLine(ledger),
                    },
                    teamPending: Array.isArray(teamCtx?.pending) ? teamCtx.pending.map((row) => row.name) : [],
                    teamContextPath: scopeId === undefined ? undefined : '.scratch/context-relay/' + teamContextRelativePath(scopeId),
                    progressPath: '.scratch/context-relay/progress.md',
                    chainPath: CHAIN_RELATIVE,
                  });
                  if (!written.snapshotOk) {
                    logWarn(ctx, '[compaction-fallback] snapshot write failed session=' + session.id + ': ' + String(written.snapshotError ?? 'unknown'));
                  }
                  if (!written.chainOk) {
                    logWarn(ctx, '[compaction-fallback] chain append failed session=' + session.id + ': ' + String(written.chainError ?? 'unknown'));
                  }
                  compactionFallbackFact = {
                    kind: 'host',
                    compactionSeq: armed.compactionSeq,
                    ...(written.snapshotOk
                      ? { path: written.relativePath }
                      : { writeFailed: true, error: String(written.snapshotError ?? 'unknown') }),
                  };
                  HOST_FALLBACK.set(session.id, compactionFallbackFact);
                  capMap(HOST_FALLBACK);
                  logInfo(ctx, '[compaction-fallback] host session=' + session.id + ' compactionSeq=' + String(armed.compactionSeq) + ' snapshot=' + String(written.relativePath));
                } else if (attribution === 'unknown') {
                  logWarn(ctx, '[compaction-fallback] unknown attribution session=' + session.id + ' compactionSeq=' + String(armed.compactionSeq));
                } else {
                  logInfo(ctx, '[compaction-fallback] attribution=' + attribution + ' session=' + session.id);
                }
              } catch (error) {
                logWarn(ctx, '[compaction-fallback] skipped session=' + session.id + ': ' + String(error?.message ?? error));
              }
            }
          }
          const rising = rank > (SENTINEL_RANK[armed.band] ?? 0);
          // 队友/子会话：只在 organize/relay 向上一级（Team Lead）请示压缩/交接（warn 只本地提示，减少 Lead 收件箱噪音）。
          let escalation;
          if (rising && subagent && (state.band === 'organize' || state.band === 'relay')) {
            escalation = await escalateToLead(ctx, caller, state, phase, projected);
          }
          const memory = LAST_BAND.get(session.id);
          const capacityMemory = CAPACITY_NOTIFIED.get(session.id);
          // 采集 → 纯规划（每步 0/1 条、≤900 字符、固定优先级）→ 投递（成功后才 claim 去重键）。
          const plan = planNotices({
            subagent,
            phase,
            state,
            lastBand: armed.band,
            compactionSeq: armed.compactionSeq,
            panel,
            escalation,
            ledgerEnabled: workItemsOn,
            ledger,
            teamContext: teamCtx,
            pendingClosure: PENDING_CLOSURE.get(session.id) ?? [],
            dispatchRows: PENDING_DISPATCH.get(session.id) ?? [],
            guard: LEDGER_GUARD.get(session.id) ?? {},
            capacity,
            capacityMemory,
            panelPrevious: subagent ? undefined : LAST_PANEL.get(session.id),
            organizeCount,
            // P0-D：起点/新任务自查（recommendation/keys/step）；undefined = 本步无待发事件。
            contextCheck: contextCheckFact,
            // D-04：bandFor 对「指标/投影均不可用」显式返回 band=unavailable（不再静默 ok）→ M-14 一次性提示。
            metricsUnavailable: state.band === 'unavailable',
            plane,
            // P1-A：宿主自动压缩兜底（undefined = 本步无待发事实；off/unknown/relay 归因不传）。
            compactionFallback: compactionFallbackFact,
            canInject: typeof caller.inject === 'function',
          });
          const delivered = deliverPlan(caller, session.id, plan);
          const kind = plan.notice === null ? null : plan.notice.kind;
          if (delivered.delivered) {
            if (kind === 'context-check') {
              // P0-D：投递成功才 commit（delivered/冷却）；pending 同 key 清除。
              commitContextCheck(session.id, plan.claims?.contextCheck, contextCheckFact?.step);
            }
            if (kind === 'phase' || kind === 'capacity' || kind === 'unavailable' || kind === 'plane' || kind === 'context-check' || kind === 'recovery') {
              logInfo(ctx, '[reminder] inject session=' + session.id + ' band=' + state.band + ' phase=' + phase + (kind === 'recovery' ? ' kind=recovery' : ''));
            } else if (kind === 'panel') {
              logInfo(ctx, '[panel] change noticed session=' + session.id);
            }
            if (plan.claims?.capacity !== undefined) {
              logInfo(ctx, '[capacity] notice session=' + session.id + ' ratio=' + String(capacity.ratio));
            }
            if (plan.claims?.dropDispatch === true) PENDING_DISPATCH.delete(session.id);
          } else if (kind === 'context-check') {
            // 注入缺失/失败：不 claim，pending 保留；超过 5 步丢弃（§3.4.4 失败口径）。
            failContextCheck(ctx, session.id);
          }
          // P1-A：recovery 投递成功（或 guard 已记录同一 compactionSeq）后清除待投递事实，避免下一步重发。
          if (delivered.delivered && kind === 'recovery') HOST_FALLBACK.delete(session.id);
          if (LEDGER_GUARD.get(session.id)?.fallbackSeq !== undefined) HOST_FALLBACK.delete(session.id);
          // 无候选行时的 guard/dispatch 状态变更不需要投递，直接生效（旧口径：不丢已评估的派活提示）。
          if (plan.track?.dropDispatch === true) PENDING_DISPATCH.delete(session.id);
          if (plan.capacityRearmed) {
            logInfo(ctx, '[capacity] re-armed session=' + session.id + ' used ' + String(capacityMemory?.used) + ' → ' + String(state.used));
          }
          // 回退/同档：只更新状态不提醒（回退时记一次日志，避免每 step 刷屏）。
          if (!plan.rising && memory !== undefined && memory.band !== state.band && rank < (SENTINEL_RANK[memory.band] ?? 0)) {
            logInfo(ctx, '[reminder] skip session=' + session.id + ' band=' + state.band + ' (fell back from ' + memory.band + ')');
          }
        }
      } catch { /* 到线提醒失败不得阻断步骤 */ }
      return next();
    });
    return () => {
      SENTINEL_BOUND.delete(ctx);
      dispose();
      disposePost();
      disposePre();
    };
  }, 'dsh-context-relay: reminder');
}

/** 清理哨兵内存（插件卸载/测试）。 */
export function clearSentinelMemory() {
  clearNoticeMemory();
  ESCALATIONS.clear();
  PENDING_DISPATCH.clear();
  DISPATCH_ACK.clear();
  CONTEXT_CHECK_MEMORY.clear();
  PENDING_TASK_SIGNALS.clear();
  HOST_FALLBACK.clear();
}

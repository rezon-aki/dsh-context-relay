/**
 * dsh-context-relay — 派生层：压力读取 / relay 投影读取 / 日志 fallback 派生（phase、计数、哨兵 seed）。
 * 热路径优先读官方投影（O(1)）；投影不可用（fake-ctx/旧宿主）才回退 session.snapshotEvents 扫描。
 *
 * @module dsh-context-relay/agent/derive
 */
import { bandFor, normalizePhase, readPressure } from '../policy.js';
import { RELAY_PROJECTION_KEY } from '../projection.js';
import { capMap, contentText, TOOL_PREFIX } from './shared.js';

export const PHASE_MEMORY = new Map();
export const ORGANIZE_MEMORY = new Map();
/**
 * phase 预算实测（每会话，进程内）：{phase, used, previous?, previousCostTokens?}。
 * 当前 phase 起点 used 用于 relay_status.budget.currentPhaseCostTokens；跨 phase 时算出
 * 上一 phase 实测消耗（previous/previousCostTokens），供 warn 档 budget_plan 的 estimate_tokens
 * 缺省值（模型不填估计时用实测）。不跨进程重启、不跨 handoff 新会话——拿不到就返回 undefined
 * （调用方按「无历史」处理，仍强制模型给 can_finish/estimate_tokens）。
 */
export const PHASE_BUDGET = new Map();

/** 读当前会话的 phase 预算实测快照（无则 undefined）。 */
export function phaseBudgetMemory(session) {
  const id = session?.id;
  return id === undefined || id === null ? undefined : PHASE_BUDGET.get(id);
}

/** 写 phase 预算实测快照（成功声明/切换后才写；拒绝路径不写）。 */
export function recordPhaseBudget(session, entry) {
  const id = session?.id;
  if (id === undefined || id === null || entry === undefined || entry === null) return;
  PHASE_BUDGET.set(id, entry);
  capMap(PHASE_BUDGET);
}
/** 兜底 tokenMeter 降频（P2#16）：sessionId → {tick, measuredTick, used}。 */
export const MEASURE_MEMORY = new Map();

/** 哨兵档位排序（到线提醒去重/升级判定）。 */
const SENTINEL_RANK = { ok: 0, warn: 1, organize: 2, relay: 3 };
/** 哨兵消息里的固定标记：用于从持久 user/message 事件派生已提醒档位。 */
const SENTINEL_MARK = /\[context-relay\] band=(\w+)/;

/** 持久日志派生缓存（sessionId → {seq, band, lastCompactionSeq}）；丢了下一次扫描重建（只用于冷启动 seed）。 */
export const SENTINEL_SCAN = new Map();

/** 兜底测量间隔（P2#16）：投影缺 used 时每会话每 5 次取压至多 measure 一次。 */
const MEASURE_EVERY = 5;

/**
 * 兜底测量降频（P2#16）：不报 usage 的 provider 投影里没有 used，每次 fallback 都
 * measure 是 O(surface) 成本；改为每会话每 5 次取压最多测量一次，其余次数复用最近值。
 * session.id 缺失（测试/异常）时不缓存、照常测量。
 */
function measuredFallback(ctx, session) {
  const id = session?.id;
  const previous = id === undefined || id === null ? undefined : MEASURE_MEMORY.get(id);
  const tick = (previous?.tick ?? 0) + 1;
  const due = previous === undefined || previous.used === undefined || tick - previous.measuredTick >= MEASURE_EVERY;
  if (!due) {
    MEASURE_MEMORY.set(id, { tick, measuredTick: previous.measuredTick, used: previous.used });
    return previous.used === undefined ? undefined : { totalTokens: previous.used };
  }
  let measurement;
  try {
    const meter = ctx.get('tokenMeter');
    if (meter !== undefined && typeof meter.measure === 'function') measurement = meter.measure(session);
  } catch { /* 忽略 */ }
  if (id !== undefined && id !== null) {
    MEASURE_MEMORY.set(id, { tick, measuredTick: tick, used: measurement?.totalTokens });
    capMap(MEASURE_MEMORY);
  }
  return measurement;
}

/**
 * 读会话压力：优先 sessionProjections 投影（窗口/上报/投影都在里面），
 * 投影已给出 used 时直接返回，不调 tokenMeter.measure —— 官方注释明确 measure
 * 每次克隆全部 surface 节点（O(surface)），哨兵每个 pre-step 都调会放大成本；
 * 投影缺 used 时的 meter 兜底再按 MEASURE_EVERY 降频（P2#16）。
 */
export function pressureOf(ctx, session) {
  let projection;
  try {
    const projections = ctx.get('sessionProjections');
    if (projections !== undefined && typeof projections.snapshot === 'function') {
      projection = projections.snapshot(session, ['contextPressure']).values?.contextPressure;
    }
  } catch { /* 投影不可用时退回 meter */ }
  const fromProjection = readPressure({ projection });
  if (fromProjection.used !== undefined) return fromProjection;
  return readPressure({ projection, measurement: measuredFallback(ctx, session) });
}

export function stateOf(ctx, session, thresholds) {
  return bandFor(pressureOf(ctx, session), thresholds);
}

/**
 * 读官方 relay 投影 state（batch3 热路径，audit G）：host 平面在 index.js 用
 * lib/projection.js 的 relayProjectionDefinition 注册，agent 平面只读。
 * stateOf(session, key) 读 host 活状态（O(1)，不需 wire）；投影未注册/不可用/抛错
 * 一律返回 undefined → 调用方走日志扫描 fallback（fake-ctx 测试与旧宿主）。
 */
export function relayStateOf(ctx, session) {
  try {
    const projections = ctx.get('sessionProjections');
    const stateOfProjection = projections?.stateOf;
    if (typeof stateOfProjection !== 'function') return undefined;
    const state = stateOfProjection.call(projections, session, RELAY_PROJECTION_KEY);
    return state !== null && typeof state === 'object' ? state : undefined;
  } catch {
    return undefined;
  }
}

/** organize 真正发生压缩的结果文案前缀（拒绝/busy/抛错/无可压缩历史都不匹配，故不计入「已压缩」）。 */
const ORGANIZE_DONE = /^organized: freed/;

/**
 * 枚举会话日志里本插件的工具调用（只取「已完成」的），并附带结果文本/isError。
 * PTC 模式下 relay 工具经 run_code 转发，日志类型是 tool/ptc-dispatch（完成）/
 * tool/ptc-dispatch-start（在途）——不是 tool/call（那是外层 run_code 自己的调用），
 * 结果（content/isError）直接在同一事件上；直接调用模式下是 tool/call + tool/result，
 * 按 callId 配对。两种形态都兼容，避免静默丢派生状态。
 */
export function relayToolCalls(session) {
  let events = [];
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  } catch { events = []; }
  const results = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (message?.toolCallId !== undefined) results.set(message.toolCallId, message);
  }
  const calls = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const type = event?.type;
    if (type !== 'tool/call' && type !== 'tool/ptc-dispatch') continue;
    const name = event.data?.name;
    if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) continue;
    let args = event.data?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = undefined; }
    }
    if (type === 'tool/ptc-dispatch') {
      calls.push({ name, args, seq: event.seq, completed: true, isError: event.data?.isError === true, text: contentText(event.data?.content) });
      continue;
    }
    // B-P2-7：直调形态「完成」= 存在配对的 tool/result；无 result 的中断调用
    // （crash/resume 留下的 tool/call）不算完成，不参与 phase/organize/handoff 派生。
    const result = event.data?.callId === undefined ? undefined : results.get(event.data.callId);
    calls.push({ name, args, seq: event.seq, completed: result !== undefined, isError: result?.isError === true, text: contentText(result?.content) });
  }
  return calls;
}

/**
 * 派生当前 phase 的 goal/exit_criteria（audit D）：
 * 优先读 relay 投影（batch3），无投影时从日志参数重放（fallback，零新存储）。
 * fallback 与投影同口径（B-P1-1/P2-2）：只认**成功**（isError!==true）且与当前 phase
 * 一致的声明；同 phase 缺省字段沿用旧值，phase 变化才清空——否则记录 next_operation
 * 的同 phase 调用或被拒绝的下一 phase 声明会污染 brief 的目标/退出条件。
 */
export function derivePhaseMeta(session, projected) {
  if (projected !== undefined) {
    return {
      goal: typeof projected.goal === 'string' && projected.goal !== '' ? projected.goal : undefined,
      exit_criteria: typeof projected.exitCriteria === 'string' && projected.exitCriteria !== '' ? projected.exitCriteria : undefined,
    };
  }
  let phase = 'discover';
  let goal;
  let exitCriteria;
  for (const call of relayToolCalls(session)) {
    if (call.name !== TOOL_PREFIX + 'phase' || call.completed !== true || call.isError === true) continue;
    let next;
    try { next = normalizePhase(call.args?.phase, phase); } catch { continue; /* 单条坏参数忽略 */ }
    if (next !== phase) {
      phase = next;
      goal = undefined;
      exitCriteria = undefined;
    }
    if (typeof call.args?.goal === 'string') goal = call.args.goal;
    if (typeof call.args?.exit_criteria === 'string') exitCriteria = call.args.exit_criteria;
  }
  return { goal, exit_criteria: exitCriteria };
}

/**
 * 派生当前 phase：优先读 relay 投影（batch3 热路径）；无投影时扫日志（fallback：
 * 最近一次 relay_phase 调用参数就是真源，resume/压缩后可重放）。
 */
export function derivePhase(session, projected) {
  if (projected !== undefined) {
    try { return normalizePhase(projected.phase); } catch { /* 坏投影回退日志扫描 */ }
  }
  const id = session?.id;
  const seq = session?.seq ?? 0;
  const cached = PHASE_MEMORY.get(id);
  if (cached !== undefined && cached.seq === seq) return cached.phase;
  let phase = 'discover';
  for (const call of relayToolCalls(session)) {
    if (call.name !== TOOL_PREFIX + 'phase' || call.completed !== true) continue;
    // phase 边界闸门按 isError 抛错（未切换）：失败调用不得被派生为 phase 切换。
    if (call.isError === true) continue;
    try { phase = normalizePhase(call.args?.phase, phase); } catch { /* 单条坏参数忽略 */ }
  }
  PHASE_MEMORY.set(id, { seq, phase });
  capMap(PHASE_MEMORY);
  return phase;
}

/**
 * 从日志派生本会话**真正发生压缩**的次数（「压缩还是接力」的推荐依据；可重放）。
 * 只认 'organized: freed'：拒绝（below-threshold/二次压缩）、busy/抛错（isError）、
 * 无可压缩历史（'no compactable history'，result===null）都不计，否则首次真实压缩会被
 * 计数守卫挡掉、推荐也会误翻 handoff（audit A；口径经 Lead 裁决修正）。
 */
export function deriveOrganizeCount(session, projected) {
  if (projected !== undefined) {
    const count = projected.organizeCount;
    return Number.isInteger(count) && count >= 0 ? count : 0;
  }
  const id = session?.id;
  const seq = session?.seq ?? 0;
  const cached = ORGANIZE_MEMORY.get(id);
  if (cached !== undefined && cached.seq === seq) return cached.count;
  let count = 0;
  for (const call of relayToolCalls(session)) {
    if (call.name !== TOOL_PREFIX + 'organize' || call.completed !== true || call.isError === true) continue;
    if (ORGANIZE_DONE.test(call.text)) count += 1;
  }
  ORGANIZE_MEMORY.set(id, { seq, count });
  capMap(ORGANIZE_MEMORY);
  return count;
}

/**
 * 两段式「压缩→新会话」第 2 段是否「尚未到线」：面板生效预设为 two-stage、本会话已压缩过
 * （第 1 段已完成）、且当前 band 未到 organize/relay（ok/warn）。到线 = organize/relay。
 * 工具体（relay_handoff）用它拒绝同一到线的立即交接；审批闸门（panel-gate B-P2-6）用同一
 * 口径预判「注定被拒」→ 不弹无谓审批。零副作用纯读。
 */
export function twoStageHandoffNotDue(panel, ctx, session, thresholds) {
  if (panel?.defaultOperation !== 'compress-then-handoff') return false;
  if (session === undefined || session === null) return false;
  if (deriveOrganizeCount(session, relayStateOf(ctx, session)) < 1) return false;
  const band = bandFor(pressureOf(ctx, session), thresholds).band;
  return band === 'ok' || band === 'warn';
}

/**
 * 投影可用时从 relay 投影 state 取冷启动 seed 信息（batch3 热路径）。
 * 口径（2026-10-25 用户裁决）：升线提醒。重启/首次无内存 lastBand 时，只有「notice 晚于
 * 最近一次成功压缩」的持久 notice 才作为 seed（否则 ok）；seed 后当前 band 更高要立刻提醒一次。
 */
export function sentinelFromProjection(state) {
  if (state === undefined) return undefined;
  const lastCompactionSeq = Number.isInteger(state.lastCompactionSeq) ? state.lastCompactionSeq : -1;
  const lastNoticeSeq = Number.isInteger(state.lastNoticeSeq) ? state.lastNoticeSeq : -1;
  const band = typeof state.noticeBand === 'string' && lastNoticeSeq > lastCompactionSeq ? state.noticeBand : undefined;
  return { band, lastCompactionSeq };
}

/**
 * 冷启动 seed 状态 {band?, lastCompactionSeq}：优先读 relay 投影，投影不可用
 * （fake-ctx/旧宿主）时退回日志派生。
 * 只用于「重启/模块重建后第一次 pre-step」：notice 晚于最近一次成功压缩才算已提醒档位，
 * 否则从 ok 起算（压缩后再到线必提醒）。lastCompactionSeq 同时用于运行期检测新压缩。
 * 冷缓存从尾部反向扫（无 200 事件窗口）；之后按 seq 增量扫描。
 */
export function persistedSentinel(session, projected) {
  const fromProjection = sentinelFromProjection(projected);
  if (fromProjection !== undefined) return fromProjection;
  const id = session?.id;
  const seq = session?.seq ?? 0;
  const cached = SENTINEL_SCAN.get(id);
  if (cached !== undefined && cached.seq === seq) return cached;
  let events = [];
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  } catch {
    events = [];
  }
  const eventSeqOf = (event, index) => (typeof event?.seq === 'number' ? event.seq : index);
  // 最近一条 relay notice + 最近一次成功压缩：notice 早于压缩 → 旧段已结束（重新武装）。
  let band;
  let lastNoticeSeq = -1;
  let lastCompactionSeq = cached?.lastCompactionSeq ?? -1;
  const floor = cached?.seq ?? 0;
  // 诊断用：最近一次成功压缩落点（不参与哨兵去重）。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const currentSeq = eventSeqOf(event, index);
    if (currentSeq < floor) break;
    if (event?.type !== 'compaction/end' || event.data?.error !== undefined) continue;
    if (currentSeq > lastCompactionSeq) lastCompactionSeq = currentSeq;
    break;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const currentSeq = eventSeqOf(event, index);
    if (currentSeq < floor) break;
    if (event?.type !== 'user/message') continue;
    const message = event.data;
    if (message?.source?.kind !== 'dsh-context-relay' || message?.source?.form !== 'notice') continue;
    const block = Array.isArray(message.content) ? message.content.find((item) => item?.type === 'text') : undefined;
    const match = SENTINEL_MARK.exec(String(block?.text ?? '')) ?? SENTINEL_MARK.exec(String(message?.source?.summary ?? ''));
    if (match !== null && SENTINEL_RANK[match[1]] !== undefined) {
      band = match[1];
      lastNoticeSeq = currentSeq;
      break;
    }
  }
  const effectiveBand = band !== undefined && lastNoticeSeq > lastCompactionSeq ? band : undefined;
  const state = { seq, band: effectiveBand, lastCompactionSeq };
  SENTINEL_SCAN.set(id, state);
  capMap(SENTINEL_SCAN);
  return state;
}

/** 清理派生缓存（插件卸载/测试）。 */
export function clearDeriveMemory() {
  PHASE_MEMORY.clear();
  ORGANIZE_MEMORY.clear();
  PHASE_BUDGET.clear();
  SENTINEL_SCAN.clear();
  MEASURE_MEMORY.clear();
}

/**
 * dsh-context-relay — 到线哨兵层：升线提醒（phase 优先：只告知，不要求中段动作）、队友 escalation、
 * 面板实时状态发布。热路径优先用 relay 投影；snapshotEvents 仅无投影 fallback。
 * 2026-11-01 用户裁决：删除「到线即处理」「到线未处理每 8 步重申 / 重启补催」——处理点在 phase 边界。
 *
 * @module dsh-context-relay/agent/sentinel
 */
import { bandFor, readPressure } from '../policy.js';
import { panelStateOf, publishLiveState } from '../panel-store.js';
import { deriveOrganizeCount, derivePhase, persistedSentinel, pressureOf, relayStateOf, sentinelFromProjection, stateOf } from './derive.js';
import { operationLabel, panelLineOf, phaseLine } from './panel-gate.js';
import { TOOL_PREFIX, capMap, cwdOf, isSubagentSession, logInfo, logWarn, noticeMessage } from './shared.js';
import { mergeTeamContext, readTeamContext, teamPendingText } from './team-context.js';
import { normalizeWorkItemsConfig, phaseFocusLine, phaseLine as ledgerPhaseLine, readWorkItems, workItemsScopeOf } from './work-items.js';

/**
 * 到线提醒内存状态（sessionId → {band, compactionSeq}）：只维护「上次看到的 band」。
 * 口径（2026-10-25 用户裁决）：**升线提醒**——rank 高于上次才注入；成功压缩把 band 置 ok
 * （压缩多少次都不压掉提醒，压缩后再到线必提醒）；回退只更新状态，不提醒。
 */
export const LAST_BAND = new Map();
/** 队友 escalation 去重：sessionId → 已发送请示的 band（band 上升才允许再发；B-P2-4）。 */
export const ESCALATIONS = new Map();
/** phase 边界指令 notice 去重：sessionId → Set<"previous→phase">（每会话每边界只注入一次；P3）。 */
export const BOUNDARY_NOTICES = new Map();
/**
 * 面板变更去重（v0.5.1）：sessionId → 面板签名（模式 + 自动授权开关）。人类中途在 composer
 * 「接力」chip 改模式/授权后，下一次 pre-step 主动注入一条面板提醒（以前只有到线/phase 边界
 * notice 才带授权事实，模型等不到就会误判「仍需审批」）。首次见到某会话只记签名、不提醒。
 */
export const LAST_PANEL = new Map();
/**
 * v0.6.0 台账闭环（事件驱动，不看时间）：
 * - PENDING_CLOSURE：变更类工具（write/edit/bash…）成功后的待落账改动（sessionId → [{tool,target}]）；
 * - LEDGER_GUARD：上次注入的焦点/rev，只在「焦点变化」或「出现新改动」时注入，避免每步重复刷屏。
 */
export const PENDING_CLOSURE = new Map();
export const LEDGER_GUARD = new Map();
const MUTATION_TOOLS = new Set(['write', 'edit', 'bash', 'pwsh', 'apply_patch']);
const GUARD_MAX = 200;

function closureTargetOf(args) {
  if (args === null || typeof args !== 'object') return '';
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
  if (path !== '') return path.split('/').pop();
  if (typeof args.command === 'string') return args.command.trim().slice(0, 40);
  return '';
}

/** 同一 plugin 实例（ctx）只注册一次 pre-step 监听，避免热装配重复弹。 */
const SENTINEL_BOUND = new WeakSet();
const SENTINEL_RANK = { ok: 0, warn: 1, organize: 2, relay: 3 };
// SENTINEL_MARK（持久 notice band 标记）由 derive.persistedSentinel 使用，见 derive.js。

/** P3：phase 边界指令 notice 去重（同 previous→phase 每会话一次）；返回 true 表示本次应注入。 */
export function claimBoundaryNotice(sessionId, previous, phase) {
  const key = previous + '→' + phase;
  const seen = BOUNDARY_NOTICES.get(sessionId);
  if (seen !== undefined && seen.has(key)) return false;
  if (seen === undefined) {
    BOUNDARY_NOTICES.set(sessionId, new Set([key]));
    capMap(BOUNDARY_NOTICES);
  } else {
    seen.add(key);
  }
  return true;
}

/**
 * 到线提醒正文：**升线**时注入（同一档不重复；成功压缩后重新武装，与压缩次数无关）。
 * 开头固定标记 [context-relay] band=<band> 保留（冷启动 seed / 持久派生靠它）。
 * Lead 只给事实 + phase 优先指引 + 协议指针（完整 advice 在 relay_status.advice，不重复占窗口）；
 * subagent 队友：向上一级请示压缩/交接（能自动发消息就代发），不自行 relay/问人。
 */
export function sentinelText(phase, state, subagent = false, panel, escalation, routerMode = false, ledger) {
  const marker = '[context-relay] band=' + state.band + ' · ';
  // 工作台账（契约 §5）：非空 pending>0 时正文末尾加一行；空台账/未传 → 正文与旧版逐字一致。
  const ledgerPhase = ledger !== undefined && ledger !== null ? ledgerPhaseLine(ledger) : '';
  const ledgerSuffix = ledger !== undefined && ledger !== null && ledger.counts !== undefined && ledger.counts.pending > 0
    ? '\n工作台账：未闭合 ' + ledger.counts.pending + ' / 共 ' + ledger.counts.total
      + (ledgerPhase === '' ? '' : ' · ' + ledgerPhase)
      + '（relay_work_items 查看/更新；phase 边界前收口）'
    : '';
  if (subagent) {
    if (state.band === 'warn') {
      return marker + '队友到 warn：不做压缩/交接，继续做完当前任务；任务/phase 边界先 relay_checkpoint，可自行 relay_freshen（同代最多 2 次）；到 organize/relay 再向 Lead 请示；不向人类提问。' + ledgerSuffix;
    }
    return marker + '队友会话·到线请示：' + phaseLine(phase, state) + '\n' + escalationHint(escalation) + '：本会话继续/压缩/收尾交接由上一级（Lead）决定（relay_organize 与 relay_handoff 都是 Lead-only）；到任务/phase 边界可先 relay_checkpoint 再自行 relay_freshen（同代最多 2 次，机制同 Lead 压缩），其余等 Lead 答复；等答复期间继续做完当前 phase，不自行 relay_organize/relay_handoff、不向人类提问；决定后把结论/未决项回执 Lead。' + ledgerSuffix;
  }
  const panelLine = panelLineOf(panel, routerMode);
  return marker + '到线提醒（插件 notice，非用户发言）· ' + phaseLine(phase, state)
    + (panelLine === '' ? '' : '\n' + panelLine)
    + '\nphase 优先：本 phase 做完、不中途压缩/接力；处理点在 phase 边界（模式「' + operationLabel(routerMode === true && panel?.defaultOperation === 'compress-then-handoff' ? null : panel?.defaultOperation) + '」，细节见常驻协议 §到线提醒与面板）。'
    + (panel?.autoChoose === true ? '\nautoChoose=on（模型自决档）：执行前用 relay_phase({next_operation}) 记录，chip 显示「自动」。' : '')
    + (state.band === 'organize' || state.band === 'relay' ? '\ndoc_lint 由插件自动跑（并入 brief/evidence），需补查再手动。' : '')
    + '\n到线建议：用 relay_recommend({operation:"continue|compress|handoff", reason:"≤60字"}) 把推荐写给插件（只做面板高亮/参考，不自动执行；最终按模式/人类）。'
    + ledgerSuffix;
}

/** notice 的 summary（≤120 字符；UI 单行展示，同样按身份分支）。 */
export function sentinelSummary(state, phase, subagent) {
  return '[context-relay] band=' + state.band + ' · phase=' + phase + ' · ' + (subagent ? '队友会话到线请示（非用户发言）' : 'relay 到线提醒（非用户发言）');
}

/** 队友到线请示正文（自动发给 Team Lead；自包含、≤400 字）。 */
function escalationText(name, state, phase) {
  const pct = state.ratio === undefined ? '?' : Math.round(state.ratio * 1000) / 10 + '%';
  return '[context-relay] 队友到线请示（自动）：' + String(name) + ' band=' + state.band + '（' + pct + '）· phase=' + phase
    + '。请决定：① 收尾继续（不压缩、不开新 phase）；② 由你接力（你调 relay_handoff）；③ 收尾改派。relay_organize/relay_handoff 都是 Lead-only，它在答复前继续当前 phase，不自行 relay、不问人类。';
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

/** 请示结果的模型可读提示（sent / 已发过 / 未发送三种）。 */
export function escalationHint(escalation) {
  if (escalation?.sent === true) return '已自动向上一级（Lead）发出请示（send_message）';
  if (escalation?.deduped === true) return '已向上一级（Lead）发过本档请示（不重复发送，等答复）';
  return '请用 send_message 向上一级（Lead / 父 agent）请示';
}

/** 面板模式 → phase 边界动作（只陈述事实/动作，不弹审批；与 relay_phase 拒绝口径一致）。 */
function boundaryActionOf(panel, routerMode) {
  const operation = routerMode === true && panel?.defaultOperation === 'compress-then-handoff' ? null : panel?.defaultOperation;
  if (operation === 'continue') return '边界直接 relay_phase（模式=继续）';
  if (operation === 'compress') return '边界先 relay_organize（模式=压缩继续）';
  if (operation === 'handoff') return '边界先 relay_handoff（模式=接力新会话）';
  if (operation === 'compress-then-handoff') return '第 1 次到线先 relay_organize（第 2 次才 relay_handoff）';
  if (panel?.autoChoose === true) return 'autoChoose=on：先 relay_phase({next_operation}) 记录';
  return '模式未设：先问人类（继续/压缩/接力）';
}

/**
 * 焦点行附带的「上下文状态」行（v0.6.3，事件驱动）：Lead 自己的到线档位 + 队友待处理。
 * 只在内容变化时随台账焦点行注入（不看时间、不每步重复），压缩后从快照文件恢复。
 */
export function ledgerContextLine(state, panel, routerMode, teamContext) {
  const lines = [];
  if (state !== undefined && state !== null && state.band !== 'ok') {
    const rank = SENTINEL_RANK[state.band] ?? 0;
    lines.push('[上下文] band=' + state.band + (rank >= 2 ? '（' + boundaryActionOf(panel, routerMode) + '）' : ''));
  }
  const teamText = teamPendingText(teamContext);
  if (teamText !== '') {
    lines.push('[队友] ' + teamText + ' —— phase 边界先处理（relay_team_status 有建议），relay_phase 未写 team_note 会被拒');
  }
  return lines.join('\n');
}

/**
 * 队友到线时向上一级请示（Agent Teams 成员 → Lead；普通 subagent 无 Team 服务则返回未发送，由 notice 文案提示自行 send_message）。
 * 失败只降级为「未发送」，不影响提醒注入。B-P2-4：同 (sessionId, band) 只发一次——每次
 * relay_phase 尝试都发会让 Lead 收件箱被同一事实刷屏；band 上升后才允许再请示。
 */
export async function escalateToLead(ctx, caller, state, phase, projected) {
  const sessionId = caller?.session?.id;
  if (escalationAlreadySent(sessionId, state.band, projected)) return { sent: false, deduped: true };
  const teams = ctx.get('agentTeams');
  if (teams === undefined || typeof teams.tryMembership !== 'function' || typeof teams.sendMessage !== 'function') return { sent: false, reason: 'agentTeams unavailable' };
  try {
    const membership = teams.tryMembership(caller);
    if (membership === undefined || membership.role !== 'teammate') return { sent: false, reason: 'not a teammate' };
    await teams.sendMessage(caller, {
      target: 'lead',
      content: [{ type: 'text', text: escalationText(membership.name, state, phase) }],
      signal: new AbortController().signal,
    });
    markEscalated(sessionId, state.band);
    // v0.6.3：把「这个队友要 Lead 决策」落到 Lead 的团队上下文快照里——Lead 焦点行会带出
    // 「队友待处理」，不依赖 Lead 记得主动查（也不按时间重提）。
    try {
      const root = membership?.root;
      const leadSessionId = root?.session?.id ?? root?.id;
      if (typeof leadSessionId === 'string' && leadSessionId !== '') {
        mergeTeamContext(cwdOf(caller.session), leadSessionId, { name: membership.name, band: state.band, phase });
      }
    } catch { /* 快照写失败不影响请示 */ }
    logInfo(ctx, '[escalation] sent session=' + String(sessionId ?? '?') + ' band=' + state.band);
    return { sent: true, name: membership.name };
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 120);
    logWarn(ctx, '[escalation] failed: ' + reason);
    return { sent: false, reason };
  }
}

/** 面板签名（模式 + 三个免审开关；autoChoose 影响模式语义，一并算入）。 */
function panelSignature(panel) {
  return JSON.stringify([panel?.defaultOperation ?? null, panel?.autoChoose === true, panel?.autoCompress === true, panel?.autoHandoff === true, panel?.authorizeNext === true]);
}

/** 面板变更提醒正文（v0.5.1；≤300 字符，只给事实，不要求中途动作）。 */
export function panelChangeText(panel, routerMode = false) {
  const onOff = (value) => (value === true ? 'on' : 'off');
  const operation = routerMode === true && panel?.defaultOperation === 'compress-then-handoff' ? null : panel?.defaultOperation;
  const approval = '压缩免审=' + (panel?.autoCompress === true ? 'on（autoCompress）' : panel?.authorizeNext === true ? 'on（授权下一次）' : 'off')
    + ' · 接力免审=' + (panel?.autoHandoff === true ? 'on（autoHandoff）' : panel?.authorizeNext === true ? 'on（授权下一次）' : 'off');
  return '[context-relay] 面板已更新（插件 notice，非用户发言）'
    + '\n模式=' + operationLabel(operation)
    + ' · autoChoose=' + onOff(panel?.autoChoose)
    + ' · autoCompress=' + onOff(panel?.autoCompress)
    + ' · autoHandoff=' + onOff(panel?.autoHandoff)
    + ' · authorizeNext=' + onOff(panel?.authorizeNext)
    + '\n本 phase 继续；phase 边界按新模式执行（' + approval + '）。';
}

/** 面板变更时注入一次（无变化/首次见到只记签名）；band 到线提醒已带全量面板状态时不重复（suppress）。 */
function notifyPanelChange(ctx, caller, session, panel, routerMode, suppress = false) {
  if (panel === undefined || panel === null) return;
  const signature = panelSignature(panel);
  const previous = LAST_PANEL.get(session.id);
  LAST_PANEL.set(session.id, signature); // 无论是否提醒都记签名：否则被抑制的变更会在下一步补发成重复提醒
  capMap(LAST_PANEL);
  if (suppress || previous === undefined || previous === signature || typeof caller.inject !== 'function') return;
  caller.inject(noticeMessage(panelChangeText(panel, routerMode), '[context-relay] 面板已更新（非用户发言）'));
  logInfo(ctx, '[panel] change noticed session=' + session.id);
}

/** phase 边界提醒（phase 完成仍超线时注入；不带 band= 固定标记，避免污染冷启动 seed）。 */
export function phaseBoundaryText(previous, phase, state, panel, action, routerMode = false) {
  return '[context-relay] phase 边界 · ' + previous + ' → ' + phase + '（phase 完成仍超线，非用户发言）· ' + phaseLine(phase, state)
    + '\n' + action
    + '\n' + panelLineOf(panel, routerMode);
}

export function phaseBoundarySummary(state) {
  return '[context-relay] phase 边界 · band=' + state.band + ' · 完成仍超线（非用户发言）';
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
 * 主路径 = tools/pre-execute 闸门：Lead 每次用 send_message 派活前，插件先读该队友档位/状态——
 * **每次都先给一个判断点**（deny，本条消息不发出）：状态 + 两个选项——①先管理再派（checkpoint →
 * freshen(reset)/renew，处理完重派）；②直接派（原样重发即放行，本次算 Lead 的判断）。
 * 空闲队友（status≠running）= 派活，必给判断点；忙队友（running）只有到线/读不到时才给（协调消息不拦）。
 * 同时写团队上下文快照（phase 边界 team_note 闸门的兜底），压缩/重启后仍在。
 *
 * 兜底路径 = tools/post-execute：若闸门被绕过（例如装配顺序），派活后仍会读一次档位并在下一步
 * 注入一次「[派活·队友上下文]」——快照已记的不重复催。
 */
export const PENDING_DISPATCH = new Map();
/** 派活判断点记忆：sessionId → Set<target>（已给出状态、等模型判断后的重发；重发即消费）。 */
export const DISPATCH_DECISION = new Map();

/** band → 派活前是否需要先管理该队友上下文（'' = 不需要）。 */
function dispatchNeedOf(band) {
  if (band === 'organize' || band === 'relay') {
    return '先让它 relay_checkpoint 收口，再 relay_freshen({reset:true, brief:新任务}) 真清空复用（同成员、0 额度）；同任务内减压用 freshen（同代≤2），换身份才 renew';
  }
  if (band === 'unknown') return '读不到它的上下文：先 relay_team_status 确认状态，或按 new/renew 处理后再派';
  return '';
}

function dispatchText(entries) {
  const lines = entries.slice(0, 3).map((entry) => '[派活·队友上下文] ' + entry.target + ' band=' + entry.band
    + (entry.ratio === undefined ? '' : '（' + Math.round(entry.ratio * 1000) / 10 + '%）')
    + ' → ' + entry.action + '；任务已发出，先让它按上面处理再开工，别把新任务做进脏上下文。');
  if (entries.length > 3) lines.push('（另 ' + (entries.length - 3) + ' 个队友同样需要处理）');
  lines.push('未处理的，phase 边界 team_note 闸门不会放过（会拒绝切 phase）。');
  return lines.join('\n');
}

/** send_message 派活 → 评估目标队友上下文；需要管理时记提示 + 写团队上下文快照（失败 fail-open）。 */
async function evaluateDispatch(ctx, session, exec, thresholds) {
  const target = typeof exec?.arguments?.target === 'string' ? exec.arguments.target : '';
  if (target === '' || target === 'lead') return;
  const teams = ctx.get('agentTeams');
  if (teams === undefined || typeof teams.tryMembership !== 'function' || typeof teams.listMembers !== 'function') return;
  const membership = teams.tryMembership(exec.agent);
  if (membership?.role !== 'lead') return;
  let members;
  try { members = teams.listMembers(exec.agent); } catch { return; }
  const member = Array.isArray(members) ? members.find((item) => item?.role === 'teammate' && item?.name === target) : undefined;
  if (member === undefined) return;
  const pressure = await teammateState(ctx, member);
  const band = pressure === undefined ? 'unknown' : bandFor(pressure, thresholds).band;
  const action = dispatchNeedOf(band);
  if (action === '') return;
  const cwd = cwdOf(session);
  const root = membership.root;
  const leadSessionId = root?.session?.id ?? root?.id ?? session.id;
  let alreadyPending = false;
  try { alreadyPending = readTeamContext(cwd, leadSessionId).pending.some((row) => row.name === target); } catch { alreadyPending = false; }
  try { mergeTeamContext(cwd, leadSessionId, { name: target, band }); } catch { /* 快照写失败不影响提示 */ }
  if (alreadyPending) return; // 已在待处理：escalation/上次派活已提示过，不重复催
  const rows = PENDING_DISPATCH.get(session.id) ?? [];
  PENDING_DISPATCH.set(session.id, rows.filter((row) => row.target !== target).concat({ target, band, ratio: pressure?.ratio, action }).slice(-3));
  capMap(PENDING_DISPATCH);
}

/**
 * pre-execute 闸门：每次派活前先读状态，给模型一个判断点（deny，本条消息不发出）。
 * - 空闲队友（status≠running）：每次派活都给判断点——模型看过状态后原样重发即派；
 * - 忙队友（running）：只有到线/读不到（需要管理）才给判断点，普通协调消息不拦。
 */
async function evaluateDispatchGate(ctx, session, exec, thresholds) {
  const target = typeof exec?.arguments?.target === 'string' ? exec.arguments.target : '';
  if (target === '' || target === 'lead') return undefined;
  const teams = ctx.get('agentTeams');
  if (teams === undefined || typeof teams.tryMembership !== 'function' || typeof teams.listMembers !== 'function') return undefined;
  const membership = teams.tryMembership(exec.agent);
  if (membership?.role !== 'lead') return undefined;
  let members;
  try { members = teams.listMembers(exec.agent); } catch { return undefined; }
  const member = Array.isArray(members) ? members.find((item) => item?.role === 'teammate' && item?.name === target) : undefined;
  if (member === undefined) return undefined;
  const pressure = await teammateState(ctx, member);
  const band = pressure === undefined ? 'unknown' : bandFor(pressure, thresholds).band;
  const management = dispatchNeedOf(band);
  const statusLabel = String(member.status ?? 'unknown');
  const idle = statusLabel !== 'running'; // 空闲队友 = 一次新派活
  // 忙队友的普通协调消息不拦（只拦需要管理的）；空闲队友每次派活都给判断点。
  if (management === '' && !idle) return undefined;
  let pending = DISPATCH_DECISION.get(session.id);
  if (pending === undefined) { pending = new Set(); DISPATCH_DECISION.set(session.id, pending); capMap(DISPATCH_DECISION); }
  if (pending.has(target)) { // 上一步已给出状态：本次是模型判断后的重发/管理消息 → 放行
    pending.delete(target);
    return undefined;
  }
  pending.add(target);
  const ratioText = pressure?.ratio === undefined ? '' : '（' + Math.round(pressure.ratio * 1000) / 10 + '%）';
  // 到线/读不到：记快照（pending）——即使 Lead 决定直接派，phase 边界 team_note 闸门仍会兜底。
  if (management !== '') {
    try {
      const root = membership.root;
      const leadSessionId = root?.session?.id ?? root?.id ?? session.id;
      mergeTeamContext(cwdOf(session), leadSessionId, { name: target, band });
    } catch { /* 快照写失败不影响闸门 */ }
  }
  const stateText = target + ' band=' + band + ratioText + ' · status=' + statusLabel;
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

/** 注册到线提醒 pre-step 监听（同一 ctx 只注册一次；返回 dispose）。 */
export function installSentinel(ctx, currentThresholds, routerMode = false, workItems) {
  // 工作台账配置（v0.5.0）：host 装配传入归一化配置；缺省按默认（enabled=true）——老装配/单测兼容。
  const workItemsConfig = workItems ?? normalizeWorkItemsConfig({});
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
    // v0.6.0：变更类工具成功 → 记「待落账」；relay_work_items 成功 → 视为已落账，清 pending。
    const disposePost = ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        const session = exec?.agent?.session;
        if (session !== undefined && session.id !== undefined && !isSubagentSession(session) && result?.isError !== true) {
          const name = String(exec?.name ?? '');
          if (name === TOOL_PREFIX + 'work_items') {
            PENDING_CLOSURE.delete(session.id);
          } else if (MUTATION_TOOLS.has(name)) {
            const memory = PENDING_CLOSURE.get(session.id) ?? [];
            PENDING_CLOSURE.set(session.id, [...memory, { tool: name, target: closureTargetOf(exec?.arguments) }].slice(-3));
            capMap(PENDING_CLOSURE);
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
          const state = stateOf(ctx, session, thresholds);
          const phase = derivePhase(session, projected);
          const persisted = persistedSentinel(session, projected);
          const rank = SENTINEL_RANK[state.band] ?? 0;
          const overBudget = rank >= (SENTINEL_RANK.organize ?? 0);
          // 面板实时状态：每个 pre-step 都发布（host 的 GET /context-relay/panel 读它）。
          try {
            publishLiveState(session.id, { band: state.band, used: state.used, window: state.window, ratio: state.ratio, phase, organizeCount: deriveOrganizeCount(session, projected), overBudget });
          } catch { /* 实时状态失败不阻断 */ }
          const memory = LAST_BAND.get(session.id);
          let lastBand;
          let lastCompactionSeq;
          if (memory === undefined) {
            // 重启/首次：持久 notice 晚于最近成功压缩才作为 seed，否则从 ok 起算。
            lastBand = persisted.band ?? 'ok';
            lastCompactionSeq = Number.isInteger(persisted.lastCompactionSeq) ? persisted.lastCompactionSeq : -1;
          } else {
            lastBand = memory.band;
            lastCompactionSeq = Number.isInteger(memory.compactionSeq) ? memory.compactionSeq : -1;
            const compactedSeq = Number.isInteger(persisted.lastCompactionSeq) ? persisted.lastCompactionSeq : -1;
            if (compactedSeq > lastCompactionSeq) {
              // 成功压缩 → 到线提醒重新武装（压缩多少次都不压掉提醒）。
              lastBand = 'ok';
              lastCompactionSeq = compactedSeq;
            }
          }
          const subagent = isSubagentSession(session);
          const panel = subagent ? undefined : panelStateOf(session.id);
          let notified = false;
          if (rank > (SENTINEL_RANK[lastBand] ?? 0)) {
            // 队友/子会话：只在 organize/relay 向上一级（Team Lead）请示压缩/交接（warn 只本地提示，减少 Lead 收件箱噪音）。
            const wantEscalation = subagent && (state.band === 'organize' || state.band === 'relay');
            const escalation = wantEscalation ? await escalateToLead(ctx, caller, state, phase) : undefined;
            if (typeof caller.inject === 'function') {
              // 工作台账（契约 §5）：注入前读（仅 enabled；读失败静默，绝不阻断到线提醒）。
              let ledger;
              if (workItemsConfig.enabled !== false) {
                try { ledger = readWorkItems(cwdOf(session), { pathOverride: workItemsConfig.pathOverride, scopeId: workItemsScopeOf(session) }); } catch { ledger = undefined; }
              }
              caller.inject(noticeMessage(sentinelText(phase, state, subagent, panel, escalation, routerMode, ledger), sentinelSummary(state, phase, subagent)));
              notified = true;
              logInfo(ctx, '[reminder] inject session=' + session.id + ' band=' + state.band + ' phase=' + phase);
            }
            LAST_BAND.set(session.id, { band: state.band, compactionSeq: lastCompactionSeq });
            capMap(LAST_BAND);
          } else {
            // 回退/同档：只更新状态不提醒（回退时记一次日志，避免每 step 刷屏）。
            if (memory !== undefined && memory.band !== state.band && rank < (SENTINEL_RANK[memory.band] ?? 0)) {
              logInfo(ctx, '[reminder] skip session=' + session.id + ' band=' + state.band + ' (fell back from ' + memory.band + ')');
            }
            LAST_BAND.set(session.id, { band: state.band, compactionSeq: lastCompactionSeq });
            capMap(LAST_BAND);
          }
          // v0.5.1：面板变更提醒（band 到线提醒已带全量面板状态时不重复）。只对 Lead/root 会话——
          // 队友面板不承载决策；首次见到某会话只记签名，避免新会话首步噪音。
          if (!subagent) notifyPanelChange(ctx, caller, session, panel, routerMode, notified);

          // v0.6.3：派活时的队友上下文评估结果 → 下一步注入一次（事件驱动，不按时间；快照去重）。
          // 本步已经讲过队友待处理，台账上下文行就不再重复同一批队友。
          let dispatchNotified = false;
          if (!subagent) {
            const dispatch = PENDING_DISPATCH.get(session.id);
            if (dispatch !== undefined && dispatch.length > 0) {
              PENDING_DISPATCH.delete(session.id);
              try {
                if (typeof caller.inject === 'function') {
                  caller.inject(noticeMessage(dispatchText(dispatch), '[context-relay] 派活 · 队友上下文（非用户发言）'));
                  dispatchNotified = true;
                }
              } catch { /* 注入失败不阻断 */ }
            }
          }

          // v0.6.0 台账闭环（事件驱动，不看时间）：焦点行（队列常驻）+ 变更未落账的闭环提示。
          // v0.6.3：焦点行同时带「上下文状态」（Lead 的 band/边界动作 + 队友待处理）——上下文管理不靠记忆：
          // 只在焦点/rev 变化、闭环提示、队友待处理变化时随行注入（不按时间、不每步重复）；读/注入失败 fail-open。
          if (!subagent && workItemsConfig.enabled !== false) {
            try {
              const cwd = cwdOf(session);
              const scopeId = workItemsScopeOf(session);
              let ledger;
              try { ledger = readWorkItems(cwd, { pathOverride: workItemsConfig.pathOverride, scopeId }); } catch { ledger = undefined; }
              const focus = ledger?.exists === true ? phaseFocusLine(ledger) : '';
              // 本步已注入到线提醒（含 band）时不再重复上下文行；guard 记全量，避免下一步补发成重复。
              // 上下文行只在「有真实事件」时随本行注入（焦点/rev 变化、闭环提示、队友待处理变化）——
              // 重启/模块重建不重发到线提醒（沿用「重启不补催」口径）。
              const teamCtx = readTeamContext(cwd, scopeId);
              const contextFull = ledgerContextLine(state, panel, routerMode, teamCtx);
              const context = notified || dispatchNotified ? '' : contextFull;
              const pending = PENDING_CLOSURE.get(session.id) ?? [];
              const guardMemory = LEDGER_GUARD.get(session.id);
              const closureCount = pending.length;
              const focusChanged = focus !== '' && (guardMemory === undefined || guardMemory.focus !== focus || guardMemory.rev !== ledger?.rev);
              const teamText = teamPendingText(teamCtx);
              const teamChanged = teamText !== '' && (guardMemory === undefined || guardMemory.team !== teamText);
              const closureNeeded = closureCount > 0 && (guardMemory === undefined || guardMemory.closureCount !== closureCount);
              if (focusChanged || closureNeeded || teamChanged) {
                const lines = [];
                if (focus !== '') lines.push(focus);
                if (context !== '') lines.push(context);
                if (closureNeeded) {
                  const list = pending.map((entry) => entry.tool + (entry.target === '' ? '' : '(' + entry.target + ')')).join(' / ');
                  lines.push('[闭环] 上一步改动未落账：' + list + ' —— 更新当前分点的 status/next/evidence（relay_work_items），或说明归到哪条分点；关 phase 前必须落账。');
                }
                if (lines.length > 0 && typeof caller.inject === 'function') {
                  caller.inject(noticeMessage(lines.join('\n'), '[context-relay] 台账 · 非用户发言'));
                }
              }
              LEDGER_GUARD.set(session.id, { phase: ledger?.currentPhase?.phase ?? null, focus, rev: ledger?.rev, context: contextFull, team: teamText, closureCount });
              capMap(LEDGER_GUARD);
            } catch { /* fail-open：读台账/注入失败不阻断步骤 */ }
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
  LAST_BAND.clear();
  ESCALATIONS.clear();
  BOUNDARY_NOTICES.clear();
  LAST_PANEL.clear();
  PENDING_CLOSURE.clear();
  PENDING_DISPATCH.clear();
  DISPATCH_DECISION.clear();
  LEDGER_GUARD.clear();
}

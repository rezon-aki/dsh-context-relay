/**
 * dsh-context-relay — 到线哨兵层：升线提醒（phase 优先：只告知，不要求中段动作）、队友 escalation、
 * 面板实时状态发布。热路径优先用 relay 投影；snapshotEvents 仅无投影 fallback。
 * 2026-11-01 用户裁决：删除「到线即处理」「到线未处理每 8 步重申 / 重启补催」——处理点在 phase 边界。
 *
 * @module dsh-context-relay/agent/sentinel
 */
import { bandFor, capacityOf, readPressure } from '../policy.js';
import { panelStateOf, publishLiveState } from '../panel-store.js';
import { deriveOrganizeCount, derivePhase, persistedSentinel, pressureOf, relayStateOf, sentinelFromProjection } from './derive.js';
import { operationLabel, panelLineOf, phaseLine } from './panel-gate.js';
import { TOOL_PREFIX, capMap, cwdOf, isSubagentSession, logInfo, logWarn, noticeMessage } from './shared.js';
import { PENDING_BANDS, mergeTeamContext, readTeamContext, teamPendingText } from './team-context.js';
import { normalizeWorkItemsConfig, phaseFocusLine, phaseLine as ledgerPhaseLine, readWorkItems, workItemsScopeOf } from './work-items.js';
import { listMembers, roleOf, sendToMember } from '../team-api.js';
import { activeMembersOf, readRoster, retiredNamesOf } from './team.js';

/**
 * 到线提醒内存状态（sessionId → {band, compactionSeq}）：只维护「上次看到的 band」。
 * 口径（2026-10-25 用户裁决）：**升线提醒**——rank 高于上次才注入；成功压缩把 band 置 ok
 * （压缩多少次都不压掉提醒，压缩后再到线必提醒）；回退只更新状态，不提醒。
 */
export const LAST_BAND = new Map();
/**
 * v0.9.0 #7 容量保全上升沿去重：sessionId → true（窗口占比 ≥85% 时注入一次；回落/压缩后重新武装）。
 * 只提示不自动动作（D7=A）；窗口未知（basis='unavailable'）不保全、不注入。
 */
export const CAPACITY_NOTIFIED = new Map();
/** P2（设计 §2.6）：压缩生效判定——used 较上次容量 notice 时下降 ≥15% 即重新武装（即便 ratio 仍 ≥85% 仍 atRisk）。 */
const CAPACITY_REARM_DROP_RATIO = 0.15;
/** 容量保全 notice 正文（上升沿注入一次；与到线提醒同 step 触发时合并为一条）。 */
export function capacityNoticeText(capacity) {
  const pct = (ratio) => (ratio === undefined ? '?' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%');
  return '[context-relay] 容量保全（插件 notice，非用户发言）：上下文已逼近硬窗口（ratio ' + pct(capacity?.ratio) + '，阈值 ' + pct(capacity?.threshold) + '）'
    + '——立即收尾当前动作：停止开新活/不派新任务；先写 brief/progress/台账收口，再按模式/人类授权调用 relay_organize({force:true}) 或 relay_handoff 保全。'
    + '这是「phase 中段不打断」的唯一例外；预算档本身不构成例外。';
}
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
 * - LEDGER_GUARD：v0.9.0 批次4 起是**行级注入去重键**——focus/bandKey/closureSig/teamSeen/dispatchSig，
 *   只有对应内容变化才注入（rev/时间戳/count 不作键）；同 step 最多一条 notice，被抑制的行下一步补。
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
export function sentinelText(phase, state, subagent = false, panel, escalation, ledger) {
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
  const panelLine = panelLineOf(panel);
  return marker + '到线提醒（插件 notice，非用户发言）· ' + phaseLine(phase, state)
    + (panelLine === '' ? '' : '\n' + panelLine)
    + '\nphase 优先：本 phase 做完、不中途压缩/接力；处理点在 phase 边界（模式「' + operationLabel(panel?.defaultOperation) + '」，细节见常驻协议 §到线提醒与面板）。'
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
function boundaryActionOf(panel) {
  const operation = panel?.defaultOperation;
  if (operation === 'continue') return '边界直接 relay_phase（模式=继续）';
  if (operation === 'compress') return '边界先 relay_organize（模式=压缩继续）';
  if (operation === 'handoff') return '边界先 relay_handoff（模式=接力新会话）';
  return '模式未设：先问人类（继续/压缩/接力）';
}

/** 台账批次字符上限（P1）：超限先丢 [队友]、再丢 [上下文]；不截断正文、不丢焦点/闭环/派活。 */
const LEDGER_BATCH_MAX = 900;

/** [上下文] 行（band≠ok 才渲染；文本与旧 ledgerContextLine 前半段逐字一致）。 */
function bandLineOf(state, panel) {
  if (state === undefined || state === null || state.band === 'ok') return '';
  const rank = SENTINEL_RANK[state.band] ?? 0;
  return '[上下文] band=' + state.band + (rank >= 2 ? '（' + boundaryActionOf(panel) + '）' : '');
}

/** [队友] 行（teamPendingText 非空才渲染；文本与旧 ledgerContextLine 后半段逐字一致）。 */
function teamLineOf(teamText) {
  return '[队友] ' + teamText + ' —— phase 边界先处理（relay_team_status 有建议），建议用 relay_phase 的 team_note 记一行结论（只 warning，不拒绝）';
}

/** P1 闭环去重键：未落账签名（tool:target 列表，顺序即发生顺序；PENDING_CLOSURE 已 slice(-3)）。 */
function closureSigOf(pending) {
  return Array.isArray(pending) && pending.length > 0 ? JSON.stringify(pending.map((entry) => entry.tool + ':' + entry.target)) : '';
}

/** 闭环提示行（文本与旧批次逐字一致）。 */
function closureLineOf(pending) {
  const list = pending.map((entry) => entry.tool + (entry.target === '' ? '' : '(' + entry.target + ')')).join(' / ');
  return '[闭环] 上一步改动未落账：' + list + ' —— 更新当前分点的 status/next/evidence（relay_work_items），或说明归到哪条分点；关 phase 前必须落账。';
}

/**
 * P1 队友状态表（D3=A）：待处理名 → 当前 band。仍处于待处理档的 name 保留（handled 不清 = 不是恢复）；
 * row 转 ok/被清除视为恢复 → 删该名（恢复后同档位重入 = 新事件，再提示一次）；pending 名以当前 band 覆盖。
 */
function teamSeenOf(previous, teamCtx) {
  const seen = previous ?? {};
  const rows = Array.isArray(teamCtx?.rows) ? teamCtx.rows : [];
  const next = {};
  for (const [name, band] of Object.entries(seen)) {
    const row = rows.find((item) => item.name === name);
    if (row !== undefined && PENDING_BANDS.includes(row.band)) next[name] = row.band;
  }
  for (const row of Array.isArray(teamCtx?.pending) ? teamCtx.pending : []) next[row.name] = row.band;
  return next;
}

/** P1 派活提示签名：sorted(target:band)，集合/档位变化才注入。 */
function dispatchSigOf(rows) {
  return rows.map((row) => row.target + ':' + row.band).sort().join(',');
}

/** 批次总字符（按 \n join 计）。 */
function batchLengthOf(rows) {
  return rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.text.length, 0) + rows.length - 1;
}

/**
 * 焦点行附带的「上下文状态」行（v0.6.3，事件驱动）：Lead 自己的到线档位 + 队友待处理。
 * P1 起行级去重（到线 notice 覆盖的 band 不重复、队友行按 rows.band 状态表驱动），保留本函数供旧调用方。
 */
export function ledgerContextLine(state, panel, teamContext) {
  const lines = [];
  const bandLine = bandLineOf(state, panel);
  if (bandLine !== '') lines.push(bandLine);
  const teamText = teamPendingText(teamContext);
  if (teamText !== '') lines.push(teamLineOf(teamText));
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
      mergeTeamContext(cwdOf(caller.session), leadSessionId, { name: membership.name, band: state.band, phase });
    }
  } catch { /* 快照写失败不影响请示 */ }
  logInfo(ctx, '[escalation] sent session=' + String(sessionId ?? '?') + ' band=' + state.band);
  return { sent: true, name: membership.name };
}

/** 面板签名（模式 + 三个免审开关；autoChoose 影响模式语义，一并算入）。 */
function panelSignature(panel) {
  return JSON.stringify([panel?.defaultOperation ?? null, panel?.autoChoose === true, panel?.autoCompress === true, panel?.autoHandoff === true, panel?.authorizeNext === true]);
}

/** 面板变更提醒正文（v0.5.1；≤300 字符，只给事实，不要求中途动作）。 */
export function panelChangeText(panel) {
  const onOff = (value) => (value === true ? 'on' : 'off');
  const operation = panel?.defaultOperation;
  const approval = '压缩免审=' + (panel?.autoCompress === true ? 'on（autoCompress）' : panel?.authorizeNext === true ? 'on（授权下一次）' : 'off')
    + ' · 接力免审=' + (panel?.autoHandoff === true ? 'on（autoHandoff）' : panel?.authorizeNext === true ? 'on（授权下一次）' : 'off');
  return '[context-relay] 面板已更新（插件 notice，非用户发言）'
    + '\n模式=' + operationLabel(operation)
    + ' · autoChoose=' + onOff(panel?.autoChoose)
    + ' · autoCompress=' + onOff(panel?.autoCompress)
    + ' · autoHandoff=' + onOff(panel?.autoHandoff)
    + ' · authorizeNext=' + onOff(panel?.authorizeNext)
    + ' · 架构师=' + onOff(panel?.architect)
    + '\n本 phase 继续；phase 边界按新模式执行（' + approval + '）。';
}

/**
 * 面板变更时注入一次（无变化/首次见到只记签名）；band 到线提醒已带全量面板状态时不重复（suppress）。
 * 返回 true 表示本步真的注入了面板 notice（P1：同 step 已注入 notice 时台账批次后移一步）。
 */
function notifyPanelChange(ctx, caller, session, panel, suppress = false) {
  if (panel === undefined || panel === null) return false;
  const signature = panelSignature(panel);
  const previous = LAST_PANEL.get(session.id);
  LAST_PANEL.set(session.id, signature); // 无论是否提醒都记签名：否则被抑制的变更会在下一步补发成重复提醒
  capMap(LAST_PANEL);
  if (suppress || previous === undefined || previous === signature || typeof caller.inject !== 'function') return false;
  caller.inject(noticeMessage(panelChangeText(panel), '[context-relay] 面板已更新（非用户发言）'));
  logInfo(ctx, '[panel] change noticed session=' + session.id);
  return true;
}

/** phase 边界提醒（phase 完成仍超线时注入；不带 band= 固定标记，避免污染冷启动 seed）。 */
export function phaseBoundaryText(previous, phase, state, panel, action) {
  return '[context-relay] phase 边界 · ' + previous + ' → ' + phase + '（phase 完成仍超线，非用户发言）· ' + phaseLine(phase, state)
    + '\n' + action
    + '\n' + panelLineOf(panel);
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

/** band → 派活前是否需要先管理该队友上下文（'' = 不需要）。v0.9.0 批次3：relay_dispatch 复用同一判断（导出防两份漂移）。 */
export function dispatchNeedOf(band) {
  if (band === 'organize' || band === 'relay') {
    return '先让它 relay_checkpoint 收口，再 relay_freshen({reset:true, brief:新任务}) 真清空复用（同成员、0 额度）；同任务内减压用 freshen（同代≤2），换身份才 renew';
  }
  if (band === 'unknown') return '读不到它的上下文：先 relay_team_status 确认状态，或按 new/renew 处理后再派';
  return '';
}

/** 派活目标的 roster 视图：只把“当前代”当可派队友；退休代拒绝而不是冷启动旧上下文。 */
function dispatchRosterOf(session, membership, listed) {
  const root = membership?.root;
  const leadSessionId = root?.session?.id ?? root?.id ?? session?.id;
  let roster;
  try { roster = readRoster(cwdOf(session), leadSessionId); } catch { roster = undefined; }
  const teammates = Array.isArray(listed?.members) ? listed.members.filter((member) => member?.role === 'teammate') : [];
  return {
    leadSessionId,
    retired: retiredNamesOf(roster),
    active: activeMembersOf(roster, teammates),
    all: teammates,
  };
}

function dispatchText(entries) {
  const lines = entries.slice(0, 3).map((entry) => '[派活·队友上下文] ' + entry.target + ' band=' + entry.band
    + (entry.ratio === undefined ? '' : '（' + Math.round(entry.ratio * 1000) / 10 + '%）')
    + ' → ' + entry.action + '；任务已发出，先让它按上面处理再开工，别把新任务做进脏上下文。');
  if (entries.length > 3) lines.push('（另 ' + (entries.length - 3) + ' 个队友同样需要处理）');
  lines.push('未处理的，phase 边界会再提醒一次；建议用 relay_phase 的 team_note 记一行处理结论（只 warning，不拒绝）。');
  return lines.join('\n');
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
  const member = roster.active.find((item) => item.name === match.name);
  if (member === undefined) return;
  const pressure = await teammateState(ctx, member);
  const band = pressure === undefined ? 'unknown' : bandFor(pressure, thresholds).band;
  const action = dispatchNeedOf(band);
  if (action === '') return;
  const cwd = cwdOf(session);
  const leadSessionId = roster.leadSessionId;
  let alreadyPending = false;
  try { alreadyPending = readTeamContext(cwd, leadSessionId).pending.some((row) => row.name === member.name); } catch { alreadyPending = false; }
  try { mergeTeamContext(cwd, leadSessionId, { name: member.name, band }); } catch { /* 快照写失败不影响提示 */ }
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
  const member = roster.active.find((item) => item.name === match.name);
  if (member === undefined) return undefined;
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
      mergeTeamContext(cwdOf(session), leadSessionId, { name: member.name, band });
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

/** 注册到线提醒 pre-step 监听（同一 ctx 只注册一次；返回 dispose）。 */
export function installSentinel(ctx, currentThresholds, workItems) {
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
          // v0.9.0 #7：压力只读一次——到线档位与容量保全共用同一事实（不重复读投影）。
          const pressure = pressureOf(ctx, session);
          const state = bandFor(pressure, thresholds);
          const capacity = capacityOf(pressure);
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
          let noticeText = null;
          let noticeSummary = null;
          if (rank > (SENTINEL_RANK[lastBand] ?? 0)) {
            // 队友/子会话：只在 organize/relay 向上一级（Team Lead）请示压缩/交接（warn 只本地提示，减少 Lead 收件箱噪音）。
            const wantEscalation = subagent && (state.band === 'organize' || state.band === 'relay');
            const escalation = wantEscalation ? await escalateToLead(ctx, caller, state, phase) : undefined;
            // 工作台账（契约 §5）：注入前读（仅 enabled；读失败静默，绝不阻断到线提醒）。
            let ledger;
            if (workItemsConfig.enabled !== false) {
              try { ledger = readWorkItems(cwdOf(session), { pathOverride: workItemsConfig.pathOverride, scopeId: workItemsScopeOf(session) }); } catch { ledger = undefined; }
            }
            noticeText = sentinelText(phase, state, subagent, panel, escalation, ledger);
            noticeSummary = sentinelSummary(state, phase, subagent);
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
          // v0.9.0 #7：容量保全上升沿一次性 notice（不自动压缩/接力）。
          // band 与容量同一 step 都触发时合并为一条（容量段追加在到线提醒之后）。
          // P2 修复（设计 §2.6「压缩成功也重置」）：notice 时记录 used；后续 used 较 notice 时下降 ≥15%
          // 视为压缩生效——即使 ratio 仍 ≥85%（仍 atRisk）也重新武装一次，允许再次提示一次；
          // ratio 回落到阈值以下同样重置（原行为）。
          let capacityMemory = CAPACITY_NOTIFIED.get(session.id);
          if (capacity.atRisk !== true) {
            CAPACITY_NOTIFIED.delete(session.id);
            capacityMemory = undefined;
          } else if (capacityMemory !== undefined && capacityMemory !== true
            && Number.isFinite(capacityMemory.used) && Number.isFinite(state.used)
            && state.used <= capacityMemory.used * (1 - CAPACITY_REARM_DROP_RATIO)) {
            logInfo(ctx, '[capacity] re-armed session=' + session.id + ' used ' + String(capacityMemory.used) + ' → ' + String(state.used));
            CAPACITY_NOTIFIED.delete(session.id);
            capacityMemory = undefined;
          }
          const capacityRising = capacity.atRisk === true && capacityMemory === undefined;
          if (capacityRising) {
            const capacityText = capacityNoticeText(capacity);
            noticeText = noticeText === null ? capacityText : noticeText + '\n' + capacityText;
            noticeSummary = noticeSummary === null ? '[context-relay] 容量保全（非用户发言）' : noticeSummary;
            CAPACITY_NOTIFIED.set(session.id, { used: Number.isFinite(state.used) ? state.used : undefined });
            capMap(CAPACITY_NOTIFIED);
            logInfo(ctx, '[capacity] notice session=' + session.id + ' ratio=' + String(capacity.ratio));
          }
          let notified = false;
          if (noticeText !== null && typeof caller.inject === 'function') {
            caller.inject(noticeMessage(noticeText, noticeSummary));
            notified = true;
            logInfo(ctx, '[reminder] inject session=' + session.id + ' band=' + state.band + ' phase=' + phase);
          }
          // v0.5.1：面板变更提醒（band 到线提醒已带全量面板状态时不重复）。只对 Lead/root 会话——
          // 队友面板不承载决策；首次见到某会话只记签名，避免新会话首步噪音。
          // P1：面板变更 notice 与到线/容量 notice 同级——同 step 已注入 notice 时台账批次整体后移一步。
          const panelNotified = !subagent && notifyPanelChange(ctx, caller, session, panel, notified);
          const stepNotified = notified || panelNotified === true;

          // v0.9.0 批次4 P1：焦点/[上下文]/[闭环]/[队友]/派活提示各自独立行级键，只注入「本次变化」的行；
          // 同一 step 最多一条 notice；到线/容量/边界/面板 notice 同 step 视为已覆盖 [上下文]（记键不注入）；
          // 被抑制/超上限丢弃的行不推进 guard → 下一步补一次（不丢事件）；读台账/团队失败 fail-open。
          if (!subagent) {
            try {
              const workItemsOn = workItemsConfig.enabled !== false;
              const cwd = cwdOf(session);
              const scopeId = workItemsScopeOf(session);
              let ledger;
              let teamCtx;
              if (workItemsOn) {
                try { ledger = readWorkItems(cwd, { pathOverride: workItemsConfig.pathOverride, scopeId }); } catch { ledger = undefined; }
                try { teamCtx = readTeamContext(cwd, scopeId); } catch { teamCtx = undefined; }
              }
              const focus = workItemsOn && ledger?.exists === true ? phaseFocusLine(ledger) : '';
              const bandLine = workItemsOn ? bandLineOf(state, panel) : '';
              const pending = workItemsOn ? (PENDING_CLOSURE.get(session.id) ?? []) : [];
              const closureSig = closureSigOf(pending);
              const teamText = workItemsOn ? teamPendingText(teamCtx) : '';
              const teamPending = workItemsOn && Array.isArray(teamCtx?.pending) ? teamCtx.pending : [];
              const dispatchRows = PENDING_DISPATCH.get(session.id) ?? [];
              const dispatchSig = dispatchSigOf(dispatchRows);
              const guard = LEDGER_GUARD.get(session.id) ?? {};
              const canInject = typeof caller.inject === 'function';

              if (stepNotified) {
                // 本步 notice 已带 band/模式事实：[上下文] 记键不注入；其余行不推进 guard，下一步补。
                LEDGER_GUARD.set(session.id, workItemsOn ? { ...guard, bandKey: bandLine } : guard);
                capMap(LEDGER_GUARD);
              } else {
                // 候选行只放本次变化的行；顺序固定：焦点 → 上下文 → 闭环 → 队友 → 派活。
                const candidates = [];
                if (focus !== '' && focus !== (guard.focus ?? '')) candidates.push({ kind: 'focus', text: focus });
                if (closureSig !== '' && closureSig !== (guard.closureSig ?? '')) candidates.push({ kind: 'closure', text: closureLineOf(pending) });
                if (teamText !== '' && teamPending.some((row) => (guard.teamSeen ?? {})[row.name] !== row.band)) candidates.push({ kind: 'team', text: teamLineOf(teamText) });
                // [上下文] 沿用旧「批次附带」语义：只在同 step 有焦点/闭环/队友变化时随行注入。
                // P1 只减不增——纯 band 变化的单独注入会在无台账会话新增噪音（旧行为 0 条），也破坏既有到线/容量硬门。
                const bandChanged = bandLine !== '' && bandLine !== (guard.bandKey ?? '');
                if (bandChanged && candidates.length > 0) candidates.splice(candidates[0].kind === 'focus' ? 1 : 0, 0, { kind: 'band', text: bandLine });
                if (dispatchRows.length > 0 && dispatchSig !== (guard.dispatchSig ?? '')) candidates.push({ kind: 'dispatch', text: dispatchText(dispatchRows) });
                // 上限 900：超限按 [队友] → [上下文] 顺序丢弃（这两类由下一次事件再触发）；不截断正文，不丢焦点/闭环/派活。
                let batch = candidates;
                if (batchLengthOf(batch) > LEDGER_BATCH_MAX) batch = batch.filter((row) => row.kind !== 'team');
                if (batchLengthOf(batch) > LEDGER_BATCH_MAX) batch = batch.filter((row) => row.kind !== 'band');
                const kept = new Set(batch.map((row) => row.kind));
                const injected = batch.length > 0 && canInject;
                if (injected) {
                  caller.inject(noticeMessage(batch.map((row) => row.text).join('\n'), '[context-relay] 台账 · 非用户发言'));
                }
                // 注入成功（或本步无候选）才提交键；被抑制/丢弃/注入失败的行保持旧键，下一步补。
                if (batch.length === 0 || injected) {
                  const teamDropped = candidates.some((row) => row.kind === 'team') && !kept.has('team');
                  LEDGER_GUARD.set(session.id, {
                    focus: focus === '' ? '' : kept.has('focus') ? focus : (guard.focus ?? ''),
                    bandKey: bandLine === '' ? '' : kept.has('band') ? bandLine : (guard.bandKey ?? ''),
                    closureSig: closureSig === '' ? '' : kept.has('closure') ? closureSig : (guard.closureSig ?? ''),
                    teamSeen: teamDropped ? (guard.teamSeen ?? {}) : teamSeenOf(guard.teamSeen, teamCtx),
                    dispatchSig: kept.has('dispatch') ? dispatchSig : (guard.dispatchSig ?? ''),
                  });
                  capMap(LEDGER_GUARD);
                  if (dispatchRows.length > 0) PENDING_DISPATCH.delete(session.id);
                }
              }
            } catch { /* fail-open：读台账/团队/注入失败不阻断步骤 */ }
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
  CAPACITY_NOTIFIED.clear();
  ESCALATIONS.clear();
  BOUNDARY_NOTICES.clear();
  LAST_PANEL.clear();
  PENDING_CLOSURE.clear();
  PENDING_DISPATCH.clear();
  DISPATCH_ACK.clear();
  LEDGER_GUARD.clear();
}

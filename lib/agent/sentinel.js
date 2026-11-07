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
import { capMap, isSubagentSession, logInfo, logWarn, noticeMessage } from './shared.js';

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
export function sentinelText(phase, state, subagent = false, panel, escalation, routerMode = false) {
  const marker = '[context-relay] band=' + state.band + ' · ';
  if (subagent) {
    if (state.band === 'warn') {
      return marker + '队友到 warn：不做压缩/交接，继续做完当前任务；任务/phase 边界先 relay_checkpoint，可自行 relay_freshen（同代最多 2 次）；到 organize/relay 再向 Lead 请示；不向人类提问。';
    }
    return marker + '队友会话·到线请示：' + phaseLine(phase, state) + '\n' + escalationHint(escalation) + '：本会话继续/压缩/收尾交接由上一级（Lead）决定（relay_organize 与 relay_handoff 都是 Lead-only）；到任务/phase 边界可先 relay_checkpoint 再自行 relay_freshen（同代最多 2 次，机制同 Lead 压缩），其余等 Lead 答复；等答复期间继续做完当前 phase，不自行 relay_organize/relay_handoff、不向人类提问；决定后把结论/未决项回执 Lead。';
  }
  const panelLine = panelLineOf(panel, routerMode);
  return marker + '到线提醒（插件 notice，非用户发言）· ' + phaseLine(phase, state)
    + (panelLine === '' ? '' : '\n' + panelLine)
    + '\nphase 优先：本 phase 做完、不中途压缩/接力；处理点在 phase 边界（模式「' + operationLabel(routerMode === true && panel?.defaultOperation === 'compress-then-handoff' ? null : panel?.defaultOperation) + '」，细节见常驻协议 §到线提醒与面板）。'
    + (panel?.autoChoose === true ? '\nautoChoose=on（模型自决档）：执行前用 relay_phase({next_operation}) 记录，chip 显示「自动」。' : '')
    + (state.band === 'organize' || state.band === 'relay' ? '\ndoc_lint 由插件自动跑（并入 brief/evidence），需补查再手动。' : '')
    + '\n到线建议：用 relay_recommend({operation:"continue|compress|handoff", reason:"≤60字"}) 把推荐写给插件（只做面板高亮/参考，不自动执行；最终按模式/人类）。';
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
    logInfo(ctx, '[escalation] sent session=' + String(sessionId ?? '?') + ' band=' + state.band);
    return { sent: true, name: membership.name };
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 120);
    logWarn(ctx, '[escalation] failed: ' + reason);
    return { sent: false, reason };
  }
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

/** 注册到线提醒 pre-step 监听（同一 ctx 只注册一次；返回 dispose）。 */
export function installSentinel(ctx, currentThresholds, routerMode = false) {
  if (SENTINEL_BOUND.has(ctx)) return () => {};
  SENTINEL_BOUND.add(ctx);
  return ctx.effect(() => {
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
          if (rank > (SENTINEL_RANK[lastBand] ?? 0)) {
            const subagent = isSubagentSession(session);
            // 队友/子会话：只在 organize/relay 向上一级（Team Lead）请示压缩/交接（warn 只本地提示，减少 Lead 收件箱噪音）。
            const wantEscalation = subagent && (state.band === 'organize' || state.band === 'relay');
            const escalation = wantEscalation ? await escalateToLead(ctx, caller, state, phase) : undefined;
            const panel = subagent ? undefined : panelStateOf(session.id);
            if (typeof caller.inject === 'function') {
              caller.inject(noticeMessage(sentinelText(phase, state, subagent, panel, escalation, routerMode), sentinelSummary(state, phase, subagent)));
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

        }
      } catch { /* 到线提醒失败不得阻断步骤 */ }
      return next();
    });
    return () => {
      SENTINEL_BOUND.delete(ctx);
      dispose();
    };
  }, 'dsh-context-relay: reminder');
}

/** 清理哨兵内存（插件卸载/测试）。 */
export function clearSentinelMemory() {
  LAST_BAND.clear();
  ESCALATIONS.clear();
  BOUNDARY_NOTICES.clear();
}

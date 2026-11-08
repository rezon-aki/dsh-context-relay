/**
 * dsh-context-relay — 面板闸门层：到线建议文案（advice，phase 优先）、面板状态行、
 * 官方 tools/pre-execute 审批硬门（含 B-P2-6 只读预判，注定被拒的调用不弹窗）。
 *
 * @module dsh-context-relay/agent/panel-gate
 */
import { bandFor, normalizePhase, shouldOrganize } from '../policy.js';
import { panelStateOf } from '../panel-store.js';
import { deriveOrganizeCount, pressureOf, relayStateOf, twoStageHandoffNotDue } from './derive.js';
import { INFLIGHT, TOOL_PREFIX, isTeammateSession, logWarn } from './shared.js';

/**
 * 队友（subagent/teammate）版建议（B-P2-5）：不读面板模式命令、不叫它问人类或调
 * relay_handoff（后者对 subagent 一律 lead-only 拒绝）——统一改为向 Lead 请示。
 * 2026-11-01 phase 优先：到线不打断当前 phase，处理点在 phase 边界（由 Lead 决定）。
 */
export function adviceForSubagent(band) {
  if (band === 'relay' || band === 'organize') {
    return '已到线（' + band + '，队友会话）：**phase 优先**——继续做完当前 phase，不中途压缩/接力；同时用 send_message 向上一级（Lead / 父 agent）请示：本会话继续收尾/压缩/交接由 Lead 决定（不自行 relay_organize/relay_handoff——两者都是 Lead-only）；把结论与未决项（未完成/未尝试及原因）回执 Lead，phase 边界按 Lead 决定处理。';
  }
  if (band === 'warn') return '预算预警（warn，队友会话）：当前 phase 照常做完；开新 phase 前向 Lead 报告预算余量，到线时由 Lead 决定，不自行 relay。';
  return '仍在预算内（队友会话）：按 phase 正常推进；到线时向 Lead 请示，不自行 relay。';
}

/**
 * 到线建议（2026-11-01 用户裁决：**phase 优先**——预算是 phase 边界闸门，phase 中段不为
 * 预算打断工作；开新 phase 前先估计能否在阈值前完成，放不下就拆票或先做一次 relay 操作；
 * phase 完成时再检查是否要 relay 操作。取代 2026-10-28「到线即处理」口径）。
 * 面板两种模式语义不同：人类模式（持久）= 严格按模式执行（模型不另选）；autoChoose = 模型自决档
 *（模型自己判断压缩/接力、不向人类确认，执行前先用 relay_phase({next_operation}) 记录）。
 */
export function adviceFor(band, choice, panel = {}, routerMode = false) {
  const wrapUp = '收尾记录写三清单：已完成 / 未完成（原因）/ 未尝试（原因，含发现但没修的问题），放进 brief 或 handoff，不许静默丢弃。';
  const recommended = choice?.recommendation === 'handoff' ? 'handoff' : 'organize';
  // v0.3.8/v0.4.0：模型侧建议必须跟随人类面板模式（持久）；长模式下升级残留的「压缩→新会话」按无模式处理。
  const effectivePreset = panel?.defaultOperation === undefined || panel.defaultOperation === null || panel.defaultOperation === ''
    || (routerMode === true && panel.defaultOperation === 'compress-then-handoff')
    ? null
    : panel.defaultOperation;
  const hasPreset = effectivePreset !== null;
  const presetLabel = hasPreset ? recommendationLabel(effectivePreset) : '';
  const panelLine = panel?.autoChoose === true && !hasPreset && routerMode !== true
    ? '面板（composer「接力」chip，本会话）：「自动（模型决定）」模式——压缩/接力由你自己判断，执行前用 relay_phase({phase, next_operation}) 记录；chip 显示模式「自动」（已记录的操作在 title/popover），chip 上光点 =「授权下一次操作」（绿=已授权一次免审 / 黄=未授权）。'
    : routerMode === true
      ? '面板（composer「接力」chip，本会话）：可选**模式**（继续 / 压缩继续 / 接力新会话；问我=不设模式，模式在本会话持久、不消费）与三个免审来源（autoCompress / autoHandoff / authorizeNext）；**人类模式 = 严格按模式执行，不要另选**；问我时由你问人类。'
      : '面板（composer「接力」chip，本会话）：可选**模式**（继续 / 压缩继续 / 接力新会话 / 压缩→新会话（第一次压缩，第二次新会话）；问我=不设模式，模式在本会话持久、不消费）与三个免审来源（autoCompress / autoHandoff / authorizeNext）；**人类模式 = 严格按模式执行，不要另选**；问我时由你问人类。';
  const presetLine = hasPreset
    ? '当前模式=' + operationLabel(effectivePreset) + '（本会话持久、不消费；严格按它执行；模式只决定做什么，不产生审批豁免——压缩仍按 autoCompress/authorizeNext，接力仍按 autoHandoff/authorizeNext）。'
    : '';
  const autoLine = panel?.autoChoose === true
    ? (hasPreset
      ? 'autoChoose=on（模型自决档）：当前**人类模式优先**，严格按模式执行；模式切回「自动」时由你自决（执行前用 relay_phase({phase, next_operation:"compress"|"handoff"}) 记录）。'
      : 'autoChoose=on（模型自决档）：压缩/接力由你自己判断，不要向人类确认；执行前先 relay_phase({phase, next_operation:"compress"|"handoff"}) 记录判断（chip 显示模式「自动」+流光，title 显示已记录的具体操作），已记录则按记录执行，操作成功后该记录清空（模式「自动」持久不变）。')
    : '';
  const presetBasis = hasPreset ? '面板模式=' + presetLabel + '，按模式执行' : '';
  if (band === 'relay') return '已到硬上限（relay）：**phase 优先**——本 phase 继续做完（该跑的测试/该提交的改动/该验证的结论一项不能省），**不中途压缩/接力**；完成后调 relay_phase 切 phase 时按面板模式/人类选择处理继续方式（**不开新 phase**）。' + (hasPreset ? presetBasis + '（人类已选）。' : '推荐接力（人类坚持留同会话则只允许压缩一次）。') + panelLine + presetLine + (autoLine === '' ? '' : autoLine) + wrapUp;
  if (band === 'organize') return '已超预算（organize）：**phase 优先**——本 phase 继续做完（不因到线砍活），**不中途压缩/接力**；完成后调 relay_phase 切 phase 时按面板模式/人类选择处理继续方式（**不开新 phase**；' + (hasPreset ? presetBasis : (recommended === 'handoff' ? '本会话已压缩过，推荐接力' : '本会话尚未压缩，推荐先压缩')) + '）。' + panelLine + presetLine + (autoLine === '' ? '' : autoLine) + wrapUp;
  if (band === 'warn') return '预算预警（warn）：本 phase 照常做完，不要因预算砍活；**开新 phase 前先估计本 phase 能否在阈值前完成**（relay_status.budget 的 headroom→organize 与上一 phase 实测消耗）——放不下就拆票（budget_plan.action="split"，缩小本 phase 范围）或先做一次 relay 操作（action="relay"）；warn 档切 phase 时 relay_phase 强制 budget_plan。';
  return '仍在预算内：按 phase 正常推进；开新 phase 前看一眼 relay_status.budget 的 headroom；压缩与接力都是可选动作，phase 中间不动历史。';
}

export function phaseLine(phase, state) {
  const pctText = state.ratio === undefined ? String(state.used ?? '?') + ' tokens' : Math.round(state.ratio * 1000) / 10 + '%';
  return 'phase=' + phase + ' band=' + state.band + ' used=' + pctText;
}

/**
 * 审批闸门（tools/pre-execute 返回 ask）：只按工具名精确匹配 relay_*，且只在「本次动作
 * 尚未被 composer 面板授权」时问人。**审批层只管 relay_organize / relay_handoff**：
 * phase 的**预算边界**不走官方审批（由 relay_phase 按面板模式处理）；
 * **验收（进 ship）也不弹审批**——2026-11-01 用户裁决：弹窗多余；门 = 新上下文独立审查 + 汇报
 * （user_gate.review + report，宿主只查非空，见 tools.checkUserGate）。
 * 授权口径（rev5.5 正交模型，唯一真源）：「面板模式（持久）只决定做什么，不产生审批豁免；
 * 免审只来自 autoCompress / autoHandoff / authorizeNext（一次性，操作成功后消费）。」
 * - relay_handoff(human_approved=true)：面板 autoHandoff=true 或 authorizeNext=true 免审批；
 * - relay_organize（任何压缩，含首次/第二次/自动模式自选）：默认 ask；面板 autoCompress=true
 *   或 authorizeNext=true 免审批。
 * - relay_phase（含进 ship 的验收）：不走审批——验收由工具级「一次自查 + 汇报」负责。
 * B-P2-6：注定被工具体拒绝的调用（below-threshold / already-organized / handoff-invalid /
 * relay-busy / lead-only）直接放行，让工具返回结构化拒绝——不弹无谓审批（零副作用；
 * 审批噪音会训练人类无脑点同意，削弱硬门价值）。
 * 其余调用返回 undefined（放行）。
 */
export function approvalGateOf(ctx, exec, thresholds, routerMode = false, options = {}) {
  const name = exec?.name;
  const session = exec?.agent?.session;
  const panel = panelStateOf(session?.id);
  const isOrganize = name === TOOL_PREFIX + 'organize';
  const isHandoff = name === TOOL_PREFIX + 'handoff';
  // ── B-P2-6：只读预判「注定被拒」的调用（与工具体内守卫同口径，不产生副作用）──
  if ((isOrganize || isHandoff) && session?.id !== undefined && INFLIGHT.has(session.id)) return undefined; // relay-busy
  if (isOrganize) {
    if (isTeammateSession(ctx, exec?.agent)) return undefined; // lead-only（工具体拒绝）
    const force = exec.arguments?.force === true;
    if (!shouldOrganize(bandFor(pressureOf(ctx, session), thresholds), force).organize) return undefined; // below-threshold
    // v0.3.8：人类在面板明确选「压缩继续」时，非 force 的二次压缩不再是「注定被拒」——进入审批分支。
    if (!force && panel.defaultOperation !== 'compress' && deriveOrganizeCount(session, relayStateOf(ctx, session)) >= 1) return undefined; // already-organized
  }
  if (isHandoff) {
    if (isTeammateSession(ctx, exec?.agent)) return undefined; // lead-only（工具体拒绝）
    if (exec.arguments?.human_approved !== true) return undefined; // human-approval-required
    const status = exec.arguments?.status;
    if (typeof status?.goal !== 'string' || status.goal.trim() === '') return undefined; // handoff-invalid（缺 goal）
    try { normalizePhase(status?.phase); } catch { return undefined; } // handoff-invalid（非法 phase）
    // 两段式「压缩→新会话」未到线（同一到线压完立即交接）注定被工具体拒绝 → 不弹审批。
    // v0.3.8：长模式没有该档，两段式预判不适用于长模式。
    if (routerMode !== true && twoStageHandoffNotDue(panel, ctx, session, thresholds)) return undefined;
  }
  if (isHandoff && panel.autoHandoff !== true && panel.authorizeNext !== true) {
    // rev5.5（人类裁决：收敛成正交模型）：面板模式只决定做什么、不再自带免审；
    // 新会话默认都要一次人类授权，除非 autoHandoff（持久）或 authorizeNext（只免一次）。
    return {
      reason: 'relay_handoff creates and starts a NEW top-level relay session and consumes quota; an explicit human Go/No-go is required (or enable autoHandoff / authorize the next operation from the composer panel)',
      displayReason: { en: 'Create and start a new relay session (consumes quota)?', zh: '是否创建并启动新的接力会话？（会消耗额度）' },
    };
  }
  // rev5.4（用户反馈「非自动模式的压缩也要弹，不弹压缩自动授权按钮有毛用」）：
  // 任何一次 relay_organize 默认都要过一次官方授权闸门（不论首次/第二次、自动/预设），
  // 只有人类的显式授权才免审：autoCompress（压缩自动授权）或 authorizeNext（授权下一次操作）。
  if (isOrganize && panel.autoCompress !== true && panel.authorizeNext !== true) {
    const second = exec.arguments?.force === true && session !== undefined && deriveOrganizeCount(session, relayStateOf(ctx, session)) >= 1;
    return {
      reason: second
        ? 'relay_organize would run a SECOND compression in this session (force=true); compression drift compounds — an explicit human Go/No-go is required (or enable autoCompress in the composer panel)'
        : 'relay_organize compresses this session context; an explicit human Go/No-go is required (or enable autoCompress / authorize the next operation from the composer panel)',
      displayReason: second
        ? { en: 'Run a second context compression in this session?', zh: '是否在本会话执行第二次上下文压缩？' }
        : { en: 'Compress this session context?', zh: '是否压缩本会话上下文？' },
    };
  }
  // 团队优先契约（2026-11-08）：已有团队时 Lead 开子代理需人类确认；无团队/非 Lead 放行。
  const teamGate = teamFirstSubagentGate(ctx, exec, options);
  if (teamGate !== undefined) return teamGate;
  return undefined;
}

/** 面板模式中文标签（到线提醒 / phase 边界提醒 / advice 共用；与 client 的 chip 短标签一致）。 */
const OPERATION_LABELS = { compress: '压缩', handoff: '接力', continue: '继续', 'compress-then-handoff': '压缩→新会话' };
export function operationLabel(operation) {
  return OPERATION_LABELS[operation] ?? '问我';
}
/** v0.3.4：推荐段改用面板档位长 label（与 client popover 表盘/推荐行叫法一致，P2-4）；模式/advice 仍用短 label。 */
const RECOMMEND_LABELS = { compress: '压缩继续', handoff: '接力新会话', continue: '继续', 'compress-then-handoff': '压缩→新会话' };
export function recommendationLabel(operation) {
  return RECOMMEND_LABELS[operation] ?? operationLabel(operation);
}

/** 面板状态一句话摘要（到线提醒 / phase 边界提醒 共用；不写死阈值；autoDecision 是模型本次到线记录的操作）。 */
export function panelLineOf(panel, routerMode = false) {
  if (panel === undefined) return '';
  const onOff = (value) => (value === true ? 'on' : 'off');
  const next = panel.autoDecision === undefined || panel.autoDecision === null
    ? (panel.autoChoose === true ? 'auto（未决）' : '无')
    : panel.autoDecision.operation;
  // v0.3.3：模型推荐只做展示/参考（不产生决策/授权）。
  // v0.3.4（P2-3）：存储 ≤120（policy 归一），展示/提醒 ≤60（与 client 推荐行一致）；空理由不渲染空括号。
  // v0.3.4（P2-4）：label 用面板档位长名（压缩继续/接力新会话），host 提醒与 client 面板叫法统一。
  const recommendReason = String(panel.recommendedReason ?? '').trim().slice(0, 60);
  // v0.3.5：长模式（routerMode）不展示已移除档位的升级残留推荐（v0.3.3 旧长会话可能存 cth）。
  const recommendedOperation = routerMode === true && panel.recommendedOperation === 'compress-then-handoff'
    ? null
    : panel.recommendedOperation;
  const recommended = recommendedOperation === undefined || recommendedOperation === null
    ? ''
    : '·模型推荐=' + recommendationLabel(recommendedOperation) + (recommendReason === '' ? '' : '(' + recommendReason + ')');
  // v0.3.8：长模式旧面板快照的 cth 模式同样按「问我」展示（该档在长模式不存在）。
  const defaultOperation = routerMode === true && panel.defaultOperation === 'compress-then-handoff' ? null : panel.defaultOperation;
  return '面板（接力 chip）：模式=' + operationLabel(defaultOperation)
    + '·autoChoose=' + onOff(panel.autoChoose)
    + '·autoCompress=' + onOff(panel.autoCompress)
    + '·autoHandoff=' + onOff(panel.autoHandoff)
    + '·authorizeNext=' + onOff(panel.authorizeNext)
    + (next === '无' ? '' : '·已记录操作=' + next)
    + recommended;
}

/** 团队优先契约覆盖的子代理工具名：relay preset 同时注册 spawn（subagent）与 fork（subagent_fork），两者都必须过门。 */
const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'subagent_fork']);

/**
 * 团队优先契约硬门（2026-11-08 用户需求）：已有 agent team 的 Lead 调用子代理
 * （subagent / subagent_fork）时，返回官方审批 ask（人类允许一次才放行）。
 * 无团队 / 非 Lead / 非子代理工具 / 配置 'off' 时放行。
 * 软契约文本在 TEAM_LEAD_PROTOCOL_TEXT；本门是它的可执行版本。
 */
export function teamFirstSubagentGate(ctx, exec, options = {}) {
  if (options.teamFirstSubagents === 'off') return undefined;
  if (!SUBAGENT_TOOL_NAMES.has(exec?.name) || exec?.agent === undefined) return undefined;
  if (isTeammateSession(ctx, exec.agent)) return undefined;
  let teams;
  try { teams = ctx.get('agentTeams'); } catch { return undefined; }
  if (teams === undefined || typeof teams.tryMembership !== 'function' || typeof teams.listMembers !== 'function') return undefined;
  let membership;
  try { membership = teams.tryMembership(exec.agent); } catch { return undefined; }
  if (membership?.role !== 'lead') return undefined;
  let members;
  try { members = teams.listMembers(exec.agent); } catch { return undefined; }
  const teammates = Array.isArray(members) ? members.filter((member) => member?.role === 'teammate') : [];
  if (teammates.length === 0) return undefined;
  return {
    tag: 'team-first-subagent',
    reason: 'an agent team exists in this session: spawning a subagent instead of reusing teammates needs an explicit human ack (team-first contract: default to teammates; ask the user before opening a subagent)',
    displayReason: { en: 'An agent team exists — create a subagent instead of using teammates?', zh: '已有智能体团队：仍要新开子代理（而非使用队友）吗？' },
  };
}

/** 注册官方审批 waterfall（返回 dispose）；handoffApproval="off" 的部署不调用。 */
export function installApprovalGate(ctx, currentThresholds, routerMode = false, options = {}) {
  // ── 人类确认硬门（audit H）：官方 tools/pre-execute 审批 waterfall ──────────────────
  // 返回 {kind:'ask', reason, displayReason} 由官方运行时解析：allowed-once 才继续；
  // rejected/cancelled/unavailable 一律 deny（fail-closed，且 ask/decided 落审批审计事件）。
  // 审批服务缺失时直接 deny 并给部署提示（配置 handoffApproval="off" 仅供无审批 UI 的部署）。
  // 只按工具名精确匹配 relay_*：PTC 子调用同样进 waterfall；绝不 gate run_code 自身。
  ctx.effect(() => {
    const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const gate = approvalGateOf(ctx, exec, currentThresholds(), routerMode, options);
        if (gate === undefined) return next();
        const approval = ctx.get('approval');
        if (approval === undefined || typeof approval.request !== 'function') {
          if (gate.tag === 'team-first-subagent') {
            // 软契约：无审批 UI 的部署不 fail-close（只有协议文本生效），否则会把 subagent 功能卡死。
            logWarn(ctx, '[approval] unavailable tool=' + String(exec?.name) + ' — team-first gate skipped (no approval UI)');
            return next();
          }
          logWarn(ctx, '[approval] unavailable tool=' + String(exec?.name) + ' — fail-closed deny');
          return {
            kind: 'deny',
            reason: gate.reason + '; approval channel unavailable in this deployment — configure handoffApproval="off" only if this relay deployment has no approval UI (residual risk documented in VERDICT)',
            info: { name: 'RelayApprovalUnavailable', code: 'relay-approval-unavailable' },
          };
        }
        const downstream = await next();
        if (downstream === undefined || downstream.kind !== 'allow') return downstream;
        return { kind: 'ask', reason: gate.reason, displayReason: gate.displayReason };
      } catch (error) {
        // 审批链路异常同样 fail-closed：宁可拒绝，不可静默放行不可逆动作。
        return { kind: 'deny', reason: 'context-relay approval gate failed (fail-closed): ' + String(error?.message ?? error) };
      }
    }, { prepend: true });
    return dispose;
  }, 'dsh-context-relay: approval gate');
}

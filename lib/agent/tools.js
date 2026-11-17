/**
 * dsh-context-relay — 五个模型工具（relay_status / relay_phase / relay_organize /
 * relay_handoff / doc_lint）。工具名、参数 schema、输出形状由测试锁定。
 *
 * @module dsh-context-relay/agent/tools
 */
import { PANEL_OPERATIONS, bandFor, budgetGate, buildPhaseBrief, capacityOf, continueChoice, formatStatus, isExitPhase, normalizeBudgetPlan, normalizePhase, normalizePhaseState, phaseBudget, shouldOrganize, userReportWarnings } from '../policy.js';
import { lessonsView, recordLessons } from '../lessons.js';
import { panelStateOf, publishLiveState, updatePanelState } from '../panel-store.js';
import { PHASE_MEMORY, deriveExit, deriveOrganizeCount, derivePhase, derivePhaseMeta, persistedSentinel, phaseBudgetMemory, pressureOf, recordPhaseBudget, relayStateOf, relayToolCalls } from './derive.js';
import { adviceFor, adviceForSubagent, operationLabel } from './panel-gate.js';
import {
  LAST_BAND, claimBoundaryNotice, escalateToLead, escalationHint, phaseBoundarySummary,
  phaseBoundaryText, publishLiveFor, teammateState,
} from './sentinel.js';
import {
  TOOL_PREFIX, appendWorkspaceFile, capMap, claimRelayOperation, cwdOf, fail, isSubagentSession, isTeammateSession, logInfo, logWarn,
  lossless, noticeMessage, runDocLint, writeWorkspaceFile,
} from './shared.js';
import { createRelayHandoffTool, providerModelOf } from './handoff.js';
import { buildDocIndex, renderDocIndex, readDoc, searchDocs, checkSessionDocs } from '../docs.js';
import { appendChainEntry, buildRecallSection, readChain, workspaceRelativePath } from './chain.js';
import { buildManualRecallSection } from './recall.js';
import { readTeamContext, replaceTeamContext } from './team-context.js';
import { listMembers, roleOf } from '../team-api.js';
import { readRoster, retiredRecordsOf, squadMembersOf, squadSummaryOf } from './team.js';
import { PHASE_LIMITS, WORK_ITEM_STATUSES, applyPhaseCarry, checkPhaseGate, checkShipGate, createPhaseItems, formatWorkItemLines, ledgerAgeMinutes, ledgerAgeSuffix, ledgerBriefSection, ledgerLine, phaseFocusLine, phaseItemsOf, phaseLine, phaseSummary, readArchive, readWorkItems, workItemsScopeOf, writeWorkItems } from './work-items.js';
import { delegationGateCheck, delegationSnapshot, normalizeDelegationConfig } from './delegation.js';
import { planeStatusOf } from '../plane/ensure.js';

/** phase 边界队友 triage 建议（band → 动作；只给建议，不代执行）。 */
const TEAM_TRIAGE_ACTION = Object.freeze({
  ok: 'keep：下一 phase 直接复用',
  warn: '任务收口后 relay_checkpoint，下一 phase 复用（必要时 freshen 减压，同代 ≤2）',
  organize: '收口后 relay_checkpoint + relay_freshen({reset:true, brief:下一 phase 任务}) 真清空复用（同成员、0 额度）；换身份才 renew',
  relay: '收口后 relay_checkpoint + relay_freshen({reset:true, brief:下一 phase 任务}) 真清空复用（同成员、0 额度）；换身份才 renew',
  unknown: '读不到压力：先 relay_team_status 重试或人工判断',
});
/** phase 边界 team_note 上限（一行处理结论）。 */
const TEAM_NOTE_LIMIT = 300;

/** 每个 phase 起点的模型提示（随 relay_phase 结果返回，契约语义的即时提醒）。 */
const PHASE_HINTS = {
  discover: 'discover：先摸清事实与边界；会改变方向的边界问题，用大白话一次问清（附推荐），别默默假设。',
  decide: 'decide：定清方案与取舍；用户的选择一次问清；exit_criteria 写可验收口径。',
  verify: 'verify：定清需求与边界；新上下文独立审查（偏移/劣化/偷懒/缺失），带 user_gate 进 ship。',
};

/**
 * 用户门校验（契约 1，2026-11-01；用户最终口径：实现者自查有盲区——必须让**新上下文**
 * （新会话 / 新队友 / 新子智能体，不共享实现者的对话）做一次独立审查，再向用户汇报）。
 * review = 独立审查结论：审查者身份 + 两点结论（需求是否已定/边界是否确定；实现是否忠实）+ 逐条对照实现与证据找偏移/劣化/偷懒/缺失；
 * report = 大白话汇报（需求 → 实现 + 证据 → 审查结论 → 边界/取舍/没做到的）；
 * questions 每条必须附推荐（契约 2 宿主校验；**不设题数上限**）。
 * 宿主只强制「写了没有」（review / report 非空），不机械校验内容对错：对不对由用户判断
 * （不弹审批弹窗；handoff 不是验收）。
 * v0.9.0 D1=B（只提醒不拒绝）：通过用户门后额外算 user_gate.report 的四段式/字数/内部细节 warning——
 * **不新增任何拒绝**（review/report 非空仍是唯一硬门），warning 随 relay_phase 结果返回 + 一次性 notice。
 * details_requested:true 仅放宽「细节展开」提示（展开建议≤4000字，仍非硬拒豁免）；report 原文不落任何地方。
 */
function checkUserGate(gate) {
  const refuse = (why) => { throw new Error('relay_phase refused (user gate): ' + why); };
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    refuse('进入 ship 必须带 user_gate——先让**新会话/新队友/新子智能体**做一次独立审查，再向用户汇报：user_gate.review 写审查者身份与发现（需求是否已定 / 实现是否忠实，偏移/劣化/偷懒/缺失，无写「无」）；user_gate.report 写大白话汇报（需求 → 实现 + 证据 → 审查结论 → 边界/取舍/没做到的）。');
  }
  const review = typeof gate.review === 'string' ? gate.review.trim() : '';
  if (review === '') {
    refuse('user_gate.review 不能为空——实现者自己的「没问题」不算数：必须由**新会话/新队友/新子智能体**（不共享实现上下文）对照用户最终需求做独立审查，写清审查者（session id / 队友名 / subagent id）与发现（偏移/劣化/偷懒/缺失；无写「无」）。宿主不校验内容对错，但这一步不能跳过。');
  }
  const report = typeof gate.report === 'string' ? gate.report.trim() : '';
  if (report === '') refuse('user_gate.report 不能为空：用大白话汇报「用户原话需求 → 实际实现 + 证据 → 独立审查结论 → 边界问题/取舍/没做到的」。');
  let questions = [];
  if (gate.questions !== undefined) {
    if (!Array.isArray(gate.questions)) refuse('user_gate.questions 必须是数组。');
    questions = gate.questions.map((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) refuse('user_gate.questions[' + index + '] 必须是 {question, recommendation, answer?}。');
      const question = typeof item.question === 'string' ? item.question.trim() : '';
      const recommendation = typeof item.recommendation === 'string' ? item.recommendation.trim() : '';
      if (question === '') refuse('user_gate.questions[' + index + '].question 不能为空。');
      if (recommendation === '') refuse('user_gate.questions[' + index + '].recommendation 不能为空——契约：每个给用户的边界问题都必须附推荐。');
      return { question, recommendation, answer: typeof item.answer === 'string' ? item.answer.trim() : undefined };
    });
  }
  // C9/AUDIT §12：验收分级——默认最小必要；重型验证（全量矩阵/真机端到端/大样本/多轮审查/跨环境/压测/复跑）
  // 默认不做，只有用户明确授权（approved_by_user:true）才允许按 heavy 记账，否则拒绝。
  let verification;
  if (gate.verification !== undefined) {
    const refuseVerification = (why) => { throw new Error('relay_phase refused (verification): ' + why); };
    if (gate.verification === null || typeof gate.verification !== 'object' || Array.isArray(gate.verification)) {
      refuseVerification('user_gate.verification 必须是 {tier:"minimal"|"heavy", approved_by_user?, items?}。');
    }
    const tier = gate.verification.tier;
    if (tier !== 'minimal' && tier !== 'heavy') {
      refuseVerification('user_gate.verification.tier 必须是 minimal 或 heavy——默认验收只做最小必要（目标模块测试 + 单次独立 diff 审查 + 必要时一次语法/静态检查）。');
    }
    if (tier === 'heavy' && gate.verification.approved_by_user !== true) {
      refuseVerification('重型验证需用户明确授权：全量测试矩阵/真机端到端/大样本采样/多轮独立审查/跨环境矩阵/性能压测/重复复跑默认不做——把用户 Go 的原话记进 user_gate.verification.approved_by_user=true 再按 heavy 记账；未授权只做最小必要（tier="minimal"）。');
    }
    let items = [];
    if (gate.verification.items !== undefined) {
      if (!Array.isArray(gate.verification.items)) refuseVerification('user_gate.verification.items 必须是字符串数组（本次实际跑过的验证项）。');
      if (gate.verification.items.length > 8) refuseVerification('user_gate.verification.items 最多 8 条（同类可概括成一条）；收到 ' + gate.verification.items.length + ' 条。');
      items = gate.verification.items.map((item, index) => {
        if (typeof item !== 'string' || item.trim() === '') refuseVerification('user_gate.verification.items[' + index + '] 必须是非空字符串。');
        return item.trim();
      });
    }
    verification = { tier, ...(tier === 'heavy' ? { approved_by_user: true } : {}), items };
  }
  // D1=B：warning 只统计（纯函数、不抛、不拒绝）；reportChars 为 trim 后 Unicode 码点数，不落原文。
  const detailsRequested = gate.details_requested === true;
  const reportWarnings = userReportWarnings(report, { detailsRequested });
  return {
    review, report, questions, reportChars: reportWarnings.chars, warnings: reportWarnings.warnings,
    ...(verification === undefined ? {} : { verification }),
    // v0.9.0 P2 修复：details_requested 只放宽提示——开关与 info 提示透传到工具结果/notice（绝不改变结果）。
    ...(detailsRequested ? { detailsRequested: true } : {}),
    ...(reportWarnings.info === undefined ? {} : { info: reportWarnings.info }),
  };
}

/**
 * 契约自检（2026-11-01 用户口径：模型工作时自己思考两条契约）：三问自检。
 * C9/AUDIT §12：contract_check 降为 **ship 必填**（ship 前的交付自检）；其他 phase 可选——
 * 缺失不再 warning（仅当模型主动传入但内容为空/残缺时给 warning），避免形式化每次必记。
 * requirement = 契约①-定需求（用户哪条需求、语义/边界定了没、还差什么歧义）；
 * fidelity = 契约①-忠实实现（偏移/劣化/偷懒/缺失检查）；attention = 契约②（是否需要用户注意力、为何最小高影响）。
 */
function checkContractCheck(check) {
  const refuse = (why) => { throw new Error('relay_phase refused (contract check): ' + why); };
  if (check === null || typeof check !== 'object' || Array.isArray(check)) {
    refuse('切 phase 前先自检两条用户契约并写 contract_check{requirement, fidelity, attention}：① 需求是否已定（本阶段对应用户哪条需求、语义/边界定没定、还差什么歧义）；② 实现是否忠实（偏移/劣化/偷懒/缺失，无写「无」）；③ 是否需要用户注意力、为何最小高影响（不需要写「不打扰」）。答不出就别切 phase。');
  }
  const requirement = typeof check.requirement === 'string' ? check.requirement.trim() : '';
  const fidelity = typeof check.fidelity === 'string' ? check.fidelity.trim() : '';
  const attention = typeof check.attention === 'string' ? check.attention.trim() : '';
  if (requirement === '') refuse('contract_check.requirement 不能为空——契约①-定需求：本阶段对应用户哪条需求？语义/边界定了吗？未定的歧义写出来（后面问用户）。');
  if (fidelity === '') refuse('contract_check.fidelity 不能为空——契约①-忠实实现：本阶段实现有没有偏移/劣化/偷懒/缺失（没有写「无」）。');
  if (attention === '') refuse('contract_check.attention 不能为空——契约②-注意力：本阶段是否需要用户注意力、为何最小高影响（不需要写「不打扰」）。');
}

/**
 * 设计门（AUDIT §12 两段式第一段；C9）：首次进入 build（开工）前必须已有用户确认过的设计。
 * 产品面：relay_phase 首次进 build（previous ∈ {discover, decide}）强制 design_gate{path, user_approved:true}；
 * 缺失/无效 → 拒绝且零副作用（不切 phase、不写台账/lessons/面板）。
 * path = 用户确认过的设计文档路径；user_approved 必须为 true（design gate 是显式停下等确认的点，不是并行项）。
 */
function checkDesignGate(gate) {
  const refuse = (why) => { throw new Error('relay_phase refused (design gate): ' + why); };
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    refuse('首次进入 build 前必须先过设计门（两段式第一段）：把设计（架构 / 改动面 / 验收口径 / 风险）交用户确认，确认后带 design_gate{path, user_approved:true}（path=用户确认过的设计文档路径）；未确认不得开工，本次零副作用。');
  }
  const path = typeof gate.path === 'string' ? gate.path.trim() : '';
  if (path === '') refuse('design_gate.path 不能为空——写用户确认过的设计文档路径（例如 .scratch/context-relay/architecture/<task>.md）；本次零副作用。');
  if (gate.user_approved !== true) refuse('design_gate.user_approved 必须为 true——设计门是显式等用户确认的点；用户没确认不许开工。本次零副作用。');
  return { path, user_approved: true };
}

/** relay_phase 摘要 text 的行宽 / 条目宽 / 软上限（P2：模型只读 text，行动要点不得丢）。 */
const PHASE_TEXT_LINE_MAX = 220;
const PHASE_TEXT_ITEM_MAX = 180;
const PHASE_TEXT_SOFT_MAX = 1600;

/**
 * relay_phase 结果的人类可读摘要（v0.9.0 P2 / D5=A；模型可见通道 = text，其余结构化字段
 * 仍供 PTC / 测试 / 宿主读取）。纯函数：只读 result（不 IO、不随机、不取时间、不改入参），
 * 行前缀固定、只输出非空行；超软上限先截 lessons 明细（保留条数与指向 lessons.md），
 * 不删 phase/warnings/user_gate。隐私：user_gate 只有 done/字数/计数/warning code，
 * report/review 原文从不进入 text。
 */
function phaseResultText(result) {
  const build = (lessonsDetail) => {
    const r = result ?? {};
    const lines = [];
    const num = (item) => (item === undefined || item === null ? '?' : String(item));
    const clip = (text, limit = PHASE_TEXT_LINE_MAX) => {
      const chars = Array.from(String(text ?? ''));
      return chars.length <= limit ? chars.join('') : chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
    };
    const phase = String(r.phase ?? '');
    const previous = r.previous === undefined || r.previous === null ? undefined : String(r.previous);
    const band = r.band ?? r.budget?.band ?? (r.context === undefined ? undefined : 'ok');
    lines.push(clip('phase: ' + phase
      + (previous !== undefined && previous !== phase ? '（' + previous + ' → ' + phase + '）' : '')
      + (band === undefined ? '' : ' · band=' + String(band))));
    if (r.exit_reason !== undefined) lines.push(clip('exit: ' + phase + '：' + clip(r.exit_reason, 150)));
    if (r.resumed === true) lines.push(clip('resume: 从出口恢复'));
    if (r.design !== undefined && r.design !== null) lines.push(clip('design: 设计门已过（用户已确认）· ' + String(r.design.path ?? '')));
    if (r.context !== undefined && r.context !== null) {
      const ratio = r.context.ratio;
      const pct = typeof ratio === 'number' ? (Math.round(ratio * 1000) / 10).toFixed(1) + '%' : '?';
      lines.push(clip('context: 上下文 ' + pct + ' · action=' + String(r.context.action ?? '?')));
    }
    if (r.budget !== undefined && r.budget !== null) {
      const b = r.budget;
      const parts = ['band=' + String(b.band ?? '?'), 'headroom→organize=' + num(b.headroomToOrganize)];
      if (b.lastPhaseCostTokens !== undefined) parts.push('上一 phase 消耗=' + num(b.lastPhaseCostTokens));
      if (b.estimateTokens !== undefined) parts.push('估计=' + num(b.estimateTokens));
      if (b.fits !== undefined) parts.push('fits=' + String(b.fits));
      if (b.canFinish !== undefined) parts.push('can_finish=' + String(b.canFinish));
      if (b.action !== undefined) parts.push('action=' + String(b.action));
      if (typeof b.note === 'string' && b.note !== '') parts.push(clip(b.note, 60));
      lines.push(clip('budget: ' + parts.join(' · ')));
    }
    if (r.ledger !== undefined && r.ledger !== null) {
      const l = r.ledger;
      const parts = [];
      if (l.phase !== undefined) {
        parts.push('phase ' + String(l.phase), '分点 ' + num(l.done) + '/' + num(l.planned));
        if (Number(l.pending) > 0) parts.push('未闭合 ' + num(l.pending));
        if (Array.isArray(l.opened) && l.opened.length > 0) parts.push('新开 ' + l.opened.join(','));
        if (Array.isArray(l.carried) && l.carried.length > 0) parts.push('carry ' + l.carried.join(','));
        if (Array.isArray(l.carryIgnored) && l.carryIgnored.length > 0) parts.push('carry 忽略 ' + l.carryIgnored.join(','));
        if (Array.isArray(l.leftover) && l.leftover.length > 0) parts.push('leftover ' + l.leftover.join(','));
      }
      if (typeof l.hint === 'string' && l.hint !== '') parts.push(l.hint);
      if (parts.length > 0) lines.push(clip('ledger: ' + parts.join(' · ')));
    }
    if (r.team !== undefined && r.team !== null) {
      const team = r.team;
      const members = Array.isArray(team.members) ? team.members : [];
      const pending = Array.isArray(team.pending) ? team.pending : [];
      if (pending.length === 0) {
        lines.push(clip('team: 队友都在线内'));
      } else {
        const names = pending.map((name) => {
          const row = members.find((member) => member?.name === name);
          return String(name) + (row === undefined ? '' : '(' + String(row.band ?? '?') + ')');
        });
        lines.push(clip('team: 待处理 ' + names.join(',')
          + (typeof team.hint === 'string' ? ' · ' + clip(team.hint, 120) : '')));
      }
    }
    if (r.user_gate !== undefined && r.user_gate !== null) {
      const gate = r.user_gate;
      const parts = ['review=' + String(gate.review ?? 'done'), 'report=' + num(gate.reportChars) + ' 字', 'questions=' + num(gate.questions)];
      if (gate.verification !== undefined && gate.verification !== null) parts.push('verification=' + String(gate.verification.tier ?? '?'));
      if (gate.detailsRequested === true) parts.push('details_requested');
      const codes = Array.isArray(gate.warnings)
        ? gate.warnings.map((warning) => String(warning?.code ?? warning?.message ?? 'warning'))
        : [];
      if (codes.length > 0) parts.push('warnings: ' + codes.join(','));
      lines.push(clip('user_gate: ' + parts.join(' · ')));
    }
    const warnings = [r.workItemsWarning, r.teamWarning, r.contractWarning, r.delegationWarning]
      .filter((item) => typeof item === 'string' && item !== '')
      .map((item) => clip(String(item).replace(/\s*\n\s*/g, ' '), PHASE_TEXT_ITEM_MAX));
    warnings.forEach((message, index) => lines.push(clip((index === 0 ? 'warnings: ' : '  · ') + message)));
    if (r.delegation !== undefined && r.delegation !== null) {
      const d = r.delegation;
      const calls = d.calls ?? {};
      const pct = typeof d.execRatio === 'number' ? (Math.round(d.execRatio * 1000) / 10).toFixed(1) + '%' : '?';
      const parts = ['exec ' + pct + '（' + num(calls.exec) + '/' + num(calls.total) + '）'];
      if (d.dispatchCount !== undefined) parts.push('派活 ' + num(d.dispatchCount) + ' / 收口 ' + num(d.collectCount));
      if (d.idleWorkers !== undefined) parts.push('空闲队友 ' + (d.idleWorkers === null ? '?' : num(d.idleWorkers)));
      if (d.basis === 'unavailable') parts.push('投影不可用，仅参考');
      if (typeof d.advice === 'string' && d.advice !== '') parts.push(clip(d.advice, 100));
      lines.push(clip('delegation: ' + parts.join(' · ')));
    }
    if (r.lessons !== undefined && r.lessons !== null) {
      const lessons = r.lessons;
      const selected = Array.isArray(lessons.selected) ? lessons.selected.slice(0, 3) : [];
      const recorded = lessons.recorded;
      let head = 'lessons: ' + num(lessons.total) + ' 条（' + num(lessons.bytes) + 'B）';
      if (recorded !== undefined && recorded !== null) {
        head += ' · 本次录入 新增' + num(recorded.added) + '/合并' + num(recorded.merged) + '/淘汰' + num(recorded.evicted);
      }
      if (selected.length === 0 || lessonsDetail === false) {
        lines.push(clip(head + (selected.length === 0 ? '' : ' · 回灌 ' + selected.length + ' 条，明细见 lessons.md')));
      } else {
        lines.push(clip(head + ' · 回灌：'));
        for (const entry of selected) {
          const item = '[' + String(entry?.tag ?? '-') + '] ' + String(entry?.text ?? '') + '（证据 ' + String(entry?.evidence ?? '') + '）';
          lines.push(clip('  - ' + clip(item.replace(/\s*\n\s*/g, ' '), PHASE_TEXT_ITEM_MAX)));
        }
        if (lessons.injection !== undefined && lessons.injection !== null && lessons.injection.truncated === true) {
          lines.push(clip('  · 注入已截断' + (Number(lessons.injection.dropped) > 0 ? '（丢 ' + num(lessons.injection.dropped) + ' 条）' : '（字段已压缩）') + '；完整见 lessons.md'));
        }
      }
    }
    if (typeof r.reminder === 'string' && r.reminder !== '') lines.push(clip('next: ' + r.reminder));
    if (typeof r.hint === 'string' && r.hint !== '') lines.push(clip('hint: ' + r.hint));
    if (typeof r.summary === 'string' && r.summary !== '') lines.push(clip('summary: ' + r.summary));
    return lines.join('\n');
  };
  const detailed = build(true);
  return detailed.length <= PHASE_TEXT_SOFT_MAX ? detailed : build(false);
}

/** 投影计数字段（旧宿主/投影缺失/畸形按 0；负值不猜）。 */
function projectedCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** 执行类计数（投影 v3+ 同口径：bash/pwsh/write/edit，排除 run_code 传输层）。 */
function executionOf(projected) {
  const calls = projectedCount(projected?.executionCalls);
  const total = projectedCount(projected?.toolCalls);
  return { calls, total, ratio: total > 0 ? Math.round((calls / total) * 1000) / 1000 : 0 };
}

/**
 * C7/A-10：本次出口是从哪个主链 phase 退出的（DESIGN §4.2「恢复从退出前 phase 继续」）。
 * 投影只存出口 kind/reason、不存来源：进程内先读成功出口时写下的 PHASE_MEMORY.exit.from；
 * 重启/热重载后按会话日志重放（与 deriveExit 同口径：只认成功调用）。
 * 用途：ship 是不可逆声明，ship→blocked/cancel 后恢复回 ship 时仍按「回到退出前 phase」放行；
 * 其余出口恢复/正常路径的 ship 门禁不变（仍只能从 verify 进）。
 */
function exitOriginOf(session) {
  const id = session?.id;
  const remembered = id === undefined || id === null ? undefined : PHASE_MEMORY.get(id)?.exit?.from;
  if (remembered !== undefined) return remembered;
  let phase = 'discover';
  let origin;
  for (const call of relayToolCalls(session)) {
    if (call.name !== TOOL_PREFIX + 'phase' || call.completed !== true || call.isError === true) continue;
    let next;
    try { next = normalizePhaseState(call.args?.phase, phase); } catch { continue; }
    if (next === phase) continue;
    if (isExitPhase(next)) origin = origin ?? phase;
    else origin = undefined;
    phase = next;
  }
  return isExitPhase(phase) ? origin : undefined;
}

/** 构建六个工具定义（runtime = { ctx, currentThresholds, injectBrief, ... }）。 */
export function createRelayTools(runtime) {
  const { ctx, currentThresholds, injectBrief } = runtime;
  // v0.9.0 批次3 / v0.10.0 C14b：build→verify 委派闸门（默认 warn 只提醒；strict 原样生效、命中即拒；
  // off 关闭——见 normalizeDelegationConfig）。strict 拒绝路径零副作用（见 relay_phase）。
  const delegation = runtime.delegation ?? normalizeDelegationConfig({});
  const delegationGateMode = delegation.gate;
  // 工作台账（v0.5.0）：旧装配/单测未传 workItems 时按默认开启（契约 §0：空台账 = 旧行为不变）。
  const workItems = runtime.workItems ?? { enabled: true, gate: 'strict', phaseGate: 'strict', max: 30, pathOverride: undefined };
  /** 读台账（enabled=false 不读；读永不抛，仍防御性降级——闸门 fail-open）；scopeId=根会话（会话级台账）。 */
  const readLedger = (cwd, session) => {
    if (workItems.enabled === false) return undefined;
    try { return readWorkItems(cwd, { pathOverride: workItems.pathOverride, scopeId: workItemsScopeOf(session) }); } catch { return undefined; }
  };
  return [
    {
      name: TOOL_PREFIX + 'status',
      description: 'Read context pressure, phase, organizeCount, execution ratio (Lead-side bash/pwsh/write/edit calls), delegation (Lead exec ratio/dispatch/idle workers/advice), compaction debt, budget headroom and next action; continue.needed=true means the continue decision is due. Call at phase start and before delegating. Lead only; teammates see themselves.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
      async execute(_args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_status requires a calling agent');
        // batch3：一次读出 relay 投影 state，phase/计数/哨兵都优先用它（热路径不碰 snapshotEvents）。
        const projected = relayStateOf(ctx, caller.session);
        const phase = derivePhase(caller.session, projected);
        const self = pressureOf(ctx, caller.session);
        const state = bandFor(self, currentThresholds());
        // v0.9.0 #7 / v0.11 P0-E：容量保全事实（硬窗口占比 ≥capacityThreshold，默认 55%、独立配置；
        // 窗口未知 basis='unavailable' 不猜、不保全）。
        const capacity = capacityOf(self, { ratio: runtime.currentCapacityRatio?.() });
        // v0.9.0 #10：出口状态（投影优先；无投影时日志 fallback 取 relay_phase 参数）。
        const exit = deriveExit(caller.session, projected);
        const team = [];
        let teamSummary;
        let teamAvailable = false;
        const membership = roleOf(ctx, caller);
        if (membership?.role === 'lead') {
          try {
            const listed = await listMembers(ctx, caller);
            if (listed.ok) {
              teamAvailable = true;
              const root = membership.root;
              const leadSessionId = root?.session?.id ?? root?.id ?? caller.session.id;
              const cwdForTeam = cwdOf(caller.session);
              const allTeammates = listed.members.filter((item) => item?.role === 'teammate');
              const roster = readRoster(cwdForTeam, leadSessionId);
              const archivedTeam = (() => { try { return retiredRecordsOf(cwdForTeam, leadSessionId, { limit: 200 }); } catch { return []; } })();
              // v0.11 P0-B：relay_status.team 默认只含 squad；legacy/retired 只给计数（不逐行展开）。
              teamSummary = squadSummaryOf(roster, allTeammates, { squadMax: runtime.squadMax ?? 8, retiredRecords: archivedTeam });
              for (const member of squadMembersOf(roster, allTeammates)) {
                const pressure = await teammateState(ctx, member);
                const band = pressure === undefined ? 'unknown' : bandFor(pressure, currentThresholds()).band;
                team.push({ name: member.name, status: member.status, used: pressure?.used, ratio: pressure?.ratio, band });
              }
            }
          } catch { /* 团队信息不可用时只报自己 */ }
        }
        const organizeCount = deriveOrganizeCount(caller.session, projected);
        const persisted = persistedSentinel(caller.session, projected);
        // Router P0 度量（投影 v3；旧宿主/无投影时按 0 处理）：Lead 亲自执行占比 + 压缩债务。
        // 执行类口径在 lib/projection.js（bash/pwsh/write/edit，排除 run_code 传输层）。
        const execution = executionOf(projected);
        // debt = 本会话已发生真实压缩（organizeCount>=1）→ 后续 handoff 的源上下文已脏，该交接。
        const compaction = { count: organizeCount, lastSeq: persisted.lastCompactionSeq, debt: organizeCount >= 1 };
        const panel = panelStateOf(caller.session.id);
        // v0.5.1：面板授权事实进 text（模型唯一可靠的面板视图）——人类中途打开 autoCompress/autoHandoff
        // 时，模型以前只从到线/phase 边界 notice 得知，等不到就会误判「仍需审批」。
        // 面板状态已经 normalizePanelState 白名单归一（退役/未知字段不会出现），这里只透传生效值。
        const panelReport = {
          defaultOperation: panel.defaultOperation,
          autoCompress: panel.autoCompress,
          autoHandoff: panel.autoHandoff,
          authorizeNext: panel.authorizeNext,
        };
        const choice = continueChoice(state, organizeCount, panel);
        // phase 优先协议（2026-11-01）：预算事实 = headroom→各线 + 本 phase 已消耗 + 上一 phase 实测消耗。
        const budget = phaseBudget(self, currentThresholds());
        const budgetMemory = phaseBudgetMemory(caller.session);
        if (budgetMemory !== undefined && budgetMemory.phase === phase && self.used !== undefined && Number.isFinite(budgetMemory.used)) {
          budget.currentPhaseCostTokens = Math.max(0, self.used - budgetMemory.used);
        }
        if (budgetMemory?.previous !== undefined && Number.isFinite(budgetMemory.previousCostTokens)) {
          budget.previousPhase = { phase: budgetMemory.previous, costTokens: budgetMemory.previousCostTokens };
        }
        // B-P2-5：队友会话不读取面板模式命令，统一改为向 Lead 请示（不自行 relay、不问人类）。
        const advice = isTeammateSession(ctx, caller)
          ? adviceForSubagent(state.band)
          : adviceFor(state.band, choice, panel);
        // P2#8 瘦身：只回结构化 essentials + text；阈值与「压缩/接力」选择题留在 text（协议里也有），
        // 不再重复返回 thresholds / continue.options 大对象。diagnostics 供宿主排障（P2#13）。
        const diagnostics = { pressureSource: self.source, lastCompactionSeq: persisted.lastCompactionSeq, organizeCount };
        const report = {
          ok: true,
          phase,
          ...(exit === undefined ? {} : { exit }),
          capacity,
          lead: { used: self.used, window: self.window, ratio: self.ratio, band: state.band },
          team,
          ...(teamSummary === undefined ? {} : { teamSummary }),
          organizeCount,
          execution,
          compaction,
          continue: choice === undefined ? undefined : { needed: choice.needed, band: choice.band, organizeCount: choice.organizeCount, recommendation: choice.recommendation, reason: choice.reason, preset: choice.preset },
          panel: panelReport,
          advice,
          budget,
          diagnostics,
        };
        // v0.9.0 批次3：delegation 度量——执行占比复用 execution（同源同值）；派活/收口取投影 v5 成功
        // 计数；idleWorkers 来自本轮团队列表（团队不可用/非 Lead 给 null，不猜 0）；投影不可用 basis 如实标注。
        report.delegation = delegationSnapshot({
          execution,
          dispatchCount: projectedCount(projected?.dispatchCalls),
          collectCount: projectedCount(projected?.collectCalls),
          idleWorkers: teamAvailable ? team.filter((member) => member.status !== 'running').length : null,
          projectedAvailable: projected !== undefined,
        });
        // v0.10 C2：agent 平面自检（M-02：preset 切换/热重载后是否真的装上了；降级经 seams.degradation 汇总）。
        // 只加字段：role = 当前身份，installed = 平面是否已装好，degradations = seam/安装降级（去重）。
        report.plane = planeStatusOf(caller);
        // 工作台账（契约 §5）：enabled 时附结构化摘要；仅非空台账在 text 末尾加一行（空台账不改旧输出）。
        const ledger = readLedger(cwdOf(caller.session), caller.session);
        let statusText = formatStatus({ ...report, thresholds: currentThresholds() });
        if (ledger !== undefined) {
          report.workItems = {
            exists: ledger.exists,
            rev: ledger.rev,
            updatedAt: ledger.updatedAt,
            counts: ledger.counts,
            path: ledger.relativePath,
            corrupt: ledger.corruptBackup !== undefined,
            ageMinutes: ledgerAgeMinutes(ledger),
            // v0.6.0：phase 元数据与队列焦点（常显，不用时间判定）。
            phase: ledger.currentPhase ?? null,
            phaseLine: phaseLine(ledger),
            focus: phaseFocusLine(ledger),
            unphased: ledger.items.filter((item) => item?.phase === null || item?.phase === undefined).length,
          };
          if (ledger.exists === true && ledger.counts.total > 0) {
            const line = phaseLine(ledger);
            statusText += '\n' + (line === '' ? '' : 'phase: ' + line + ' · ') + ledgerLine(ledger.counts);
            const focus = phaseFocusLine(ledger);
            if (focus !== '') statusText += '\n' + focus;
          }
        }
        report.text = statusText;
        // 面板实时状态：每次 relay_* 工具调用后刷新（composer chip 轮询读它）。
        try {
          publishLiveState(caller.session.id, { band: state.band, used: self.used, window: self.window, ratio: self.ratio, phase, organizeCount, overBudget: state.band === 'organize' || state.band === 'relay' });
        } catch { /* 面板实时状态失败不影响工具 */ }
        return lossless(report);
      },
    },
    {
      name: TOOL_PREFIX + 'recommend',
      description: 'Record the Lead model recommendation for the composer panel highlight (reference only; never executes a relay op or grants approval).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['operation'],
        properties: {
          operation: { type: 'string', enum: ['continue', 'compress', 'handoff'], description: 'Recommended operation (continue / compress / handoff).' },
          reason: { type: 'string', description: 'Short rationale (trimmed to 120 chars).' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_recommend requires a calling agent');
        // 推荐只展示/参考：队友/子会话不得写（Lead 的面板决策由 Lead 提）。
        if (isTeammateSession(ctx, caller) || isSubagentSession(caller.session)) {
          return fail('lead-only', 'relay_recommend is Lead-only', { summary: 'refused: subagent/teammate sessions must not write the Lead panel recommendation; report the suggestion to the Lead instead.' });
        }
        const operation = args?.operation;
        if (!PANEL_OPERATIONS.includes(operation)) {
          return fail('invalid-operation', 'operation must be one of ' + PANEL_OPERATIONS.join('|'), { summary: 'refused: operation must be one of ' + PANEL_OPERATIONS.join('|') + '.' });
        }
        const reason = String(args?.reason ?? '').trim().slice(0, 120);
        const at = Date.now();
        // 只写推荐三字段：绝不写 defaultOperation/授权字段（推荐不产生决策/豁免）。
        updatePanelState(caller.session.id, { recommendedOperation: operation, recommendedReason: reason, recommendedAt: at }, { source: 'agent' });
        return lossless({
          ok: true,
          operation,
          reason,
          at,
          text: '已提交模型推荐：' + operationLabel(operation) + (reason === '' ? '' : '（理由：' + reason + '）') + '。面板会高亮；最终仍按模式/人类决定，不会自动执行压缩/接力。',
        });
      },
    },
    {
      name: TOOL_PREFIX + 'phase',
      description: 'Declare/switch phase (5-chain + blocked|cancel; exit_reason 1-200; exits skip gates). discover/decide need exit_criteria; first build needs design_gate{path,user_approved:true}; ship needs verify + user_gate (warnings never block; heavy verification needs user Go). warn band needs budget_plan; contract_check at ship; build->verify delegation gate; over budget: composer panel mode; see protocol.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['phase'],
        properties: {
          phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship', 'blocked', 'cancel'] },
          exit_reason: { type: 'string', description: 'Required for phase blocked|cancel (1-200 chars, why exiting); ignored on main-chain phases.' },
          goal: { type: 'string', description: 'One-line goal.' },
          exit_criteria: { type: 'string', description: 'Done criterion.' },
          items: {
            type: 'array', maxItems: PHASE_LIMITS.points,
            description: 'This phase points (1-8 short titles): created as open ledger items with phase=this phase. [] declares a single-thread task (allowed by the strict phase gate).',
            items: { type: 'string', description: 'One work point (<=120 chars).' },
          },
          carry: {
            type: 'array', maxItems: PHASE_LIMITS.carry,
            description: 'Work item ids from the previous phase to bring into this phase; without carry the strict phase gate refuses when the previous phase still has unclosed points.',
            items: { type: 'string' },
          },
          design_gate: {
            type: 'object', additionalProperties: false, required: ['path', 'user_approved'],
            description: 'Design gate (required on the first build entry from discover/decide): the user has explicitly approved the design document before implementation starts.',
            properties: {
              path: { type: 'string', description: 'Design document path the user approved (e.g. .scratch/context-relay/architecture/<task>.md).' },
              user_approved: { type: 'boolean', description: 'Must be true: the user explicitly approved this design before implementation; the gate is an explicit stop, not a parallel review.' },
            },
          },
          team_note: {
            type: 'string',
            description: 'Boundary teammate-context note (one line, <=300); recommended when a teammate is at organize/relay/unreadable. Missing notes never refuse the phase switch.',
          },
          budget_plan: {
            type: 'object', additionalProperties: false, required: ['action'],
            description: 'warn band phase switch: estimate fit before threshold; proceed|split|relay.',
            properties: {
              action: { type: 'string', enum: ['proceed', 'split', 'relay'], description: 'proceed=fits; split=narrow scope; relay=relay op first.' },
              can_finish: { type: 'boolean', description: 'Fits before the threshold?' },
              estimate_tokens: { type: 'number', description: 'Est. tokens (defaults to last phase cost).' },
              note: { type: 'string', description: 'One-line rationale.' },
            },
          },
          contract_check: {
            type: 'object', additionalProperties: false, required: ['requirement', 'fidelity', 'attention'],
            description: 'Self-check; required at ship; optional on other phase switches (only a provided-but-incomplete value warns).',
            properties: {
              requirement: { type: 'string', description: '契约1a 需求已定（无歧义、边界确定）' },
              fidelity: { type: 'string', description: '契约1b 实现忠实（无偏移/劣化/偷懒/缺失）' },
              attention: { type: 'string', description: '契约2 注意力（不打扰写「不打扰」）' },
            },
          },
          user_gate: {
            type: 'object', additionalProperties: false, required: ['review', 'report'],
            description: 'Lead verify->ship: independent fresh-context review + plain report (human judges) + verification tier. Order of review/report is not checked; report format/length issues only warn (never block).',
            properties: {
              review: { type: 'string', description: '独立审查（新会话/新队友/新子智能体）：审查者身份 + 需求是否已定/边界 + 偏移/劣化/偷懒/缺失发现' },
              report: { type: 'string', description: '四段式大白话汇报：结论→影响→需要你做什么→证据位置（默认≤600字；warning 不阻断）' },
              verification: {
                type: 'object', additionalProperties: false, required: ['tier'],
                description: 'Acceptance tier actually run: minimal = target-module tests + one independent diff review (+syntax check if needed); heavy = full matrix/e2e/samples/multi-round/matrix/perf/rerun and needs explicit user approval.',
                properties: {
                  tier: { type: 'string', enum: ['minimal', 'heavy'], description: 'minimal (default minimal-necessary acceptance) | heavy (only with user Go).' },
                  approved_by_user: { type: 'boolean', description: 'Required true when tier=heavy: the user explicitly approved heavy verification.' },
                  items: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Verification items actually run (<=8 short strings).' },
                },
              },
              details_requested: { type: 'boolean', description: '用户明确索要细节时 true（仅放宽细节展开提示，不是硬拒豁免、不改变结果）。' },
              questions: {
                type: 'array', description: 'Boundary questions asked, each with a recommendation (one batch; no fixed cap).',
                items: {
                  type: 'object', additionalProperties: false, required: ['question', 'recommendation'],
                  properties: {
                    question: { type: 'string' },
                    recommendation: { type: 'string' },
                    answer: { type: 'string' },
                  },
                },
              },
            },
          },
          lessons: {
            type: 'array', maxItems: 3, description: '<=3 evidence-backed lessons (deduped/capped; returns top 3).',
            items: {
              type: 'object', additionalProperties: false, required: ['text', 'evidence'],
              properties: {
                tag: { type: 'string', description: 'kebab tag.' },
                text: { type: 'string', description: 'one line (<=200 chars)' },
                evidence: { type: 'string', description: 'proof pointer (<=200 chars)' },
              },
            },
          },
        },
      },
      // P2（D5=A）：模型可见通道 = 人类可读 text（同 relay_status 模式；旧值兜底 JSON，防御性）。
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_phase requires a calling agent');
        const session = caller.session;
        const projected = relayStateOf(ctx, session);
        const previous = derivePhase(session, projected);
        // v0.9.0 #10（D6=A）：phase 取值扩为「5 主链 + 2 显式出口（blocked/cancel）」；出口不是第 6/7 个 phase，
        // 不进分点/预算/phase 闸门；任意 phase 可进，带 exit_reason 是进入出口的唯一硬要求。
        const phase = normalizePhaseState(args?.phase);
        const exitTarget = isExitPhase(phase);
        const fromExit = isExitPhase(previous);
        // C7/A-10：出口来源（仅从出口恢复时用到）——用于判断「恢复从退出前 phase 继续」，见 exitOriginOf。
        const exitOrigin = fromExit ? exitOriginOf(caller.session) : undefined;
        const thresholds = currentThresholds();
        const state = bandFor(pressureOf(ctx, session), thresholds);
        const overBudget = state.band === 'organize' || state.band === 'relay';
        const crossing = phase !== previous;
        // 主链切换（出口/恢复都不算）：出口旁路预算/分点/面板闸门；恢复不要求 budget_plan（D6=A）。
        const mainCrossing = crossing && !exitTarget && !fromExit;
        // 进/换出口必须先给原因（1-200 字符）；校验先于任何副作用——缺原因拒绝且零副作用。
        let exitReason;
        if (exitTarget) {
          exitReason = typeof args?.exit_reason === 'string' ? args.exit_reason.trim() : '';
          if (exitReason === '') throw new Error('relay_phase refused (exit): 进入 ' + phase + ' 出口必须带 exit_reason（1-200 字符，写清等什么/为何取消）；本次零副作用。');
          if (Array.from(exitReason).length > 200) throw new Error('relay_phase refused (exit): exit_reason 最多 200 字符（收到 ' + Array.from(exitReason).length + '）；本次零副作用。');
        }
        // C7/A-02：items 只在主链跨 phase（开新 phase）时登记分点。本次没有登记机会时（同 phase 声明、
        // 出口、从出口恢复）必须显式拒绝——绝不能像旧版那样静默丢弃「模型以为已登记、实际无台账」。
        // 位置先于任何副作用（面板/台账/lessons 都还没写），拒绝零副作用。
        if (args?.items !== undefined && (!mainCrossing || workItems.enabled === false)) {
          const why = workItems.enabled === false
            ? '工作台账已禁用（workItems=false），无法登记分点'
            : exitTarget
              ? '这是 ' + phase + ' 出口，出口不登记分点'
              : fromExit
                ? '这是从出口恢复到 ' + phase + '，恢复不登记分点'
                : '本次 phase 未切换（' + previous + ' → ' + phase + '）';
          const fix = workItems.enabled === false
            ? '需要台账请先启用 workItems 配置（workItems:false 时工具面不读写台账）。'
            : '补分点请用 relay_work_items（Lead-only），或留到下一次跨 phase 时带 items。';
          throw new Error('relay_phase refused (items): ' + why + '——items 只在主链跨 phase（开新 phase）时登记分点；本次未登记任何分点（零副作用）。' + fix);
        }
        // discover/decide 必须写可验收的完成口径（审计缺口：exit_criteria 原本可选，验收标准无真源）。
        // C7/A-11：只在 crossing 校验——同 phase 重声明（例如只记 lessons）不强制重复给口径。
        if (crossing && (phase === 'discover' || phase === 'decide') && (typeof args?.exit_criteria !== 'string' || args.exit_criteria.trim() === '')) {
          throw new Error('relay_phase refused: phase "' + phase + '" requires exit_criteria（可验收的完成口径）——写清「谁 / 拿什么 / 怎么判」，例如 exit_criteria="两份报告落盘且含证据链接，doc_lint 通过"。build/verify/ship 不强制。');
        }

        // 用户门（契约 1）：ship 是唯一的验收声明——只能从 verify 进；Lead 必须带「独立审查 + 大白话汇报」的 user_gate
        // （review：新会话/新队友/新子智能体做的独立审查——需求是否已定 + 实现是否忠实，偏移/劣化/偷懒/缺失；report：汇报给用户）。
        // 2026-11-01 用户口径：不靠机械——实现者自查有盲区，审查必须交给新上下文；宿主只强制「写了没有」，内容对不对由用户判断；不弹审批弹窗。
        let userGate;
        let userGateWarnings;
        let userGateDetails;
        if (crossing && phase === 'ship') {
          // 验收声明只能由 Lead 做：队友/子智能体即便从 verify 进也不许 ship（2026-11-01 审查修复）。
          if (isTeammateSession(ctx, caller)) {
            throw new Error('relay_phase refused (lead-only): 队友/子智能体不做验收声明——ship 是 Lead 的事；把结论/边界/未决项回执 Lead，由 Lead 做新上下文独立审查并向用户汇报。');
          }
          // C7/A-10：ship 出口可恢复——ship→blocked/cancel 后按 DESIGN §4.2「恢复从退出前 phase 继续」回 ship
          // （仅当本次出口确实是从 ship 退出）；其余情况仍只能从 verify 进。门禁不放松：下面 user_gate、
          // 上方 contract_check、下方 ship 台账闸门照旧全部生效。
          const recoveringShip = fromExit && exitOrigin === 'ship';
          if (previous !== 'verify' && !recoveringShip) throw new Error('relay_phase refused: 进 ship 只能从 verify 来——先声明 verify 做验收（独立审查：需求是否已定 / 实现是否忠实），再带 user_gate 进 ship；跳过验收不算完成。');
          const checked = checkUserGate(args?.user_gate);
          // D1=B：warning 不阻断 ship（用户门硬门仍只有 review/report 非空）；report 原文不落盘。
          // P2 修复：details_requested/info 一并回传给调用方（仅提示层，不改变结果）。
          userGate = {
            review: 'done', questions: checked.questions.length, reportChars: checked.reportChars,
            ...(checked.verification === undefined ? {} : { verification: checked.verification }),
            ...(checked.detailsRequested === true ? { detailsRequested: true } : {}),
            ...(checked.info === undefined ? {} : { info: checked.info }),
          };
          if (checked.warnings.length > 0) {
            userGate.warnings = checked.warnings;
            userGateWarnings = checked.warnings;
          }
          if (checked.detailsRequested === true) userGateDetails = true;
        }
        // 契约自检（C9/AUDIT §12）：contract_check 只在 ship 必填（交付自检，用户门的一部分）；其他 phase 可选——
        // 缺失不再 warning（避免形式化每次必记）；模型主动传入但内容为空/残缺时仍给一次 warning。
        // 任何面板写入——拒绝路径不得有副作用（SPEC G-6：缺/空 → throw（不切换、不写盘））。
        // 队友跨 phase 走 escalation（仅超预算时由下方 escalation 抛错；ship 前自检由 Lead 必填）。
        let contractWarning;
        if (crossing && !exitTarget && (phase === 'ship' || args?.contract_check !== undefined)) {
          try {
            checkContractCheck(args?.contract_check);
          } catch (error) {
            const message = String(error?.message ?? error).replace(/^relay_phase refused \(contract check\): /, '');
            if (phase === 'ship') throw error;
            if (!(overBudget && isTeammateSession(ctx, caller))) contractWarning = message;
          }
        }
        // 开 phase 前预算可行性闸门（2026-11-01 用户口径：phase 优先 + 先估计再开 phase）。
        // 仅 warn 档强制（ok 档 headroom→organize >5% 窗口；organize/relay 档由下方面板闸门接管）。
        // 拒绝路径零副作用：不改模式、不切 phase、不写 lessons。
        const budgetMemoryBefore = phaseBudgetMemory(session);
        const crossBudget = mainCrossing ? phaseBudget(pressureOf(ctx, session), thresholds) : undefined;
        const lastPhaseCostTokens = mainCrossing && budgetMemoryBefore !== undefined
          && Number.isFinite(budgetMemoryBefore.used) && state.used !== undefined
          ? Math.max(0, state.used - budgetMemoryBefore.used)
          : undefined;
        let budgetReport;
        let budgetReminder;
        // phase 完成时复查（所有档）：跨 phase 响应都带 budget 事实（上一 phase 实测消耗 + headroom）；
        // warn 档额外要求 budget_plan 并回估计/动作。ok 档不强制（headroom→organize >5% 窗口）。
        if (mainCrossing) {
          budgetReport = {
            band: state.band,
            headroomToWarn: crossBudget.headroomToWarn,
            headroomToOrganize: crossBudget.headroomToOrganize,
            headroomToRelay: crossBudget.headroomToRelay,
            ...(lastPhaseCostTokens === undefined ? {} : { lastPhaseCostTokens }),
          };
        }
        if (mainCrossing && state.band === 'warn') {
          const plan = normalizeBudgetPlan(args?.budget_plan);
          const gate = budgetGate(plan, crossBudget, lastPhaseCostTokens);
          budgetReport = {
            ...budgetReport,
            ...(gate.estimateTokens === undefined ? {} : { estimateTokens: gate.estimateTokens }),
            ...(gate.canFinish === undefined ? {} : { canFinish: gate.canFinish }),
            ...(gate.fits === undefined ? {} : { fits: gate.fits }),
            action: plan.action,
            ...(plan.note === undefined ? {} : { note: plan.note }),
          };
          const headroomText = String(crossBudget.headroomToOrganize ?? '?');
          const teammate = isTeammateSession(ctx, caller);
          if (gate.ok !== true && teammate && plan.action === 'relay') {
            throw new Error('relay_phase refused (budget plan, teammate session, lead-only): 队友不自行 relay——把预算不足事实（headroom→organize=' + headroomText + '，estimate=' + String(gate.estimateTokens ?? '?') + '）与建议用 send_message 请示 Lead，由 Lead 决定压缩/接力；或改用 budget_plan.action="split" 缩小本 phase 范围后重试。');
          }
          if (gate.code === 'relay-op-first') {
            throw new Error('relay_phase refused (budget plan): 估计本 phase 放不下 → 先做一次 relay 操作再开：按面板模式（若有）或推荐调 relay_organize({phase:"' + previous + '", brief:"<本 phase 结论与证据指针>", force:true})（未到 organize 线必须 force；本会话未压缩过推荐压缩）或 relay_handoff({human_approved:true, status:{phase:"' + previous + '", ...}})（已压缩过/要干净上下文）；执行仍按授权闸门（压缩可能弹一次官方授权，autoCompress/authorizeNext 免审；接力 autoHandoff/authorizeNext 免审）；成功后重试 relay_phase。或改 budget_plan.action="split" 拆票。');
          }
          if (gate.code === 'estimate-over-headroom') {
            throw new Error('relay_phase refused (budget plan): estimate_tokens=' + String(gate.estimateTokens ?? '?') + ' 超过剩余 headroom→organize=' + headroomText + '，与 can_finish=true 矛盾——改成真实估计；或 can_finish=false + ' + (teammate ? '向 Lead 请示 relay（relay 由 Lead 决定，lead-only）或 action="split"。' : 'action="split"/"relay"。'));
          }
          if (gate.code === 'phase-does-not-fit') {
            throw new Error('relay_phase refused (budget plan): 估计本 phase 放不下（can_finish=false 或 estimate 超过 headroom）却 action="proceed"——放不下就不能直接开新 phase：拆票（action="split"，缩小本 phase 范围后重试）' + (teammate ? '；或 send_message 向 Lead 请示 relay（relay 由 Lead 决定，lead-only）。' : '或先做一次 relay 操作（action="relay"）。'));
          }
          if (gate.code !== undefined) throw new Error('relay_phase refused (budget plan): ' + String(gate.code));
          if (plan.action === 'split') budgetReminder = '已拆票（budget_plan.action=split）：本 phase 按缩小后的范围做（goal/exit_criteria 已收窄）；phase 完成时再检查是否要 relay 操作。';
          logInfo(ctx, '[budget] session=' + session.id + ' phase=' + phase + ' band=warn estimate=' + String(gate.estimateTokens ?? '?') + ' headroom=' + headroomText + ' action=' + plan.action);
        }
        // 工作台账 ship 闸门（契约 §5）：user_gate 校验之后、任何写盘/面板写入之前——strict 拒绝零副作用
        // （未切 phase、未写 lessons）；warn 档只附提示、不拒绝。
        let ledgerSnapshot;
        let workItemsWarning;
        if (phase === 'ship') {
          ledgerSnapshot = readLedger(cwdOf(session), session);
          if (ledgerSnapshot !== undefined) {
            const shipGate = checkShipGate(ledgerSnapshot, { gate: workItems.gate });
            if (shipGate?.ok !== true) throw new Error('relay_phase refused (work items): ' + String(shipGate?.message ?? 'work items incomplete'));
            if (Array.isArray(shipGate.warnings) && shipGate.warnings.length > 0) workItemsWarning = shipGate.warnings.join('；');
          }
        }
        // 关 phase 闸门（v0.6.0 G2）：本 phase 未收口的分点必须收口或用 carry 显式带走；单线程任务 items: []。
        // 位置与 ship 闸门一致（契约自检/预算闸门之后、任何写盘之前），拒绝零副作用。
        let phaseGateInfo;
        let openedItems;
        let carriedIds = [];
        if (mainCrossing) {
          ledgerSnapshot = ledgerSnapshot ?? readLedger(cwdOf(session), session);
          if (ledgerSnapshot !== undefined && ledgerSnapshot.exists === true) {
            const carry = Array.isArray(args?.carry) ? args.carry : [];
            const gatePhase = ledgerSnapshot.currentPhase?.phase ?? previous;
            const checked = checkPhaseGate(ledgerSnapshot, { phase: gatePhase, carry, gate: workItems.phaseGate ?? 'strict' });
            if (checked.ok !== true) throw new Error('relay_phase refused (work items, phase open): ' + checked.message);
            carriedIds = checked.carried;
            phaseGateInfo = checked;
          }
          if (args?.items !== undefined) {
            if (!Array.isArray(args.items)) throw new Error('relay_phase refused (items): items 必须是字符串数组（每个字符串是一条分点）');
            if (args.items.length > PHASE_LIMITS.points) throw new Error('relay_phase refused (items): 最多 ' + PHASE_LIMITS.points + ' 条分点（收到 ' + args.items.length + '）');
            if (args.items.some((title) => typeof title !== 'string')) throw new Error('relay_phase refused (items): items 的每个元素必须是字符串（分点标题）');
            openedItems = createPhaseItems(args.items, { phase, existing: ledgerSnapshot?.items ?? [] });
          }
        }
        // v0.9.0 批次3 / v0.10.0 C14b：build→verify 委派闸门（D1=A：默认 warn 只提醒不拒绝；off 不查；
        // strict 原样生效、命中即拒）。位置=台账收口闸门之后、第一笔写盘/面板写入之前：
        // strict 拒绝路径零副作用（未切 phase、未写面板/lessons/台账）。只对 root Lead 生效。
        let delegationReport;
        let delegationWarning;
        if (mainCrossing && previous === 'build' && phase === 'verify' && delegationGateMode !== 'off'
          && !isTeammateSession(ctx, caller) && !isSubagentSession(session)) {
          ledgerSnapshot = ledgerSnapshot ?? readLedger(cwdOf(session), session);
          const checked = delegationGateCheck({
            from: previous,
            to: phase,
            execution: executionOf(projected),
            ledger: ledgerSnapshot,
            sessionId: session.id,
            mode: delegationGateMode,
          });
          const gateWarnings = Array.isArray(checked.warnings) ? checked.warnings : [];
          if (delegationGateMode === 'strict' && checked.ok !== true) {
            const message = gateWarnings.map((warning) => warning.message).join('；');
            throw new Error('relay_phase refused (delegation gate): ' + message);
          }
          delegationReport = {
            ok: true,
            execRatio: checked.stats?.execRatio,
            calls: checked.stats?.calls,
            warnings: gateWarnings,
          };
          if (gateWarnings.length > 0) delegationWarning = gateWarnings.map((warning) => warning.message).join('；');
        }
        // 设计门（AUDIT §12 两段式第一段；C9）：首次进入 build（开工）必须有用户确认过的设计文档指针。
        // 位置：所有只读闸门之后、任何写盘/面板/notice 之前——缺失拒绝零副作用（不切 phase、不写台账/lessons/面板）。
        // 正常主链只从 discover/decide 首次进 build；从出口恢复（previous=blocked/cancel）不重复要求（门已在首次进入时过）。
        let designGate;
        if (mainCrossing && phase === 'build' && (previous === 'discover' || previous === 'decide')) {
          designGate = checkDesignGate(args?.design_gate);
        }
        const phaseHint = mainCrossing ? PHASE_HINTS[phase] : undefined;
        const publish = (phaseName) => {
          try {
            publishLiveState(session.id, { band: state.band, used: state.used, window: state.window, ratio: state.ratio, phase: phaseName, organizeCount: deriveOrganizeCount(session, projected), overBudget });
          } catch { /* 面板实时状态失败不影响工具 */ }
        };
        // P3：同一 previous→phase 边界的指令 notice 每会话只注入一次（见 sentinel.claimBoundaryNotice）。
        // 拒绝分支只 throw（错误必达，notice 同义双写纯浪费）——notice 只留给「继续」放行分支。
        const injectBoundary = (panel, action) => {
          if (!claimBoundaryNotice(session.id, previous, phase)) return;
          try {
            if (typeof caller.inject === 'function') caller.inject(noticeMessage(phaseBoundaryText(previous, phase, state, panel, action), phaseBoundarySummary(state)));
          } catch { /* notice 注入失败不阻断 */ }
        };
        // 队友会话：不读面板模式、不要求问人类——到线一律向上一级请示压缩/交接，先做完当前 phase。
        if (mainCrossing && overBudget && isTeammateSession(ctx, caller)) {
          const escalation = await escalateToLead(ctx, caller, state, phase, projected);
          publish(previous);
          throw new Error('relay_phase refused (teammate session, band=' + state.band + '): 队友会话不自行切 phase、不读面板模式、不问人类——' + escalationHint(escalation) + '本会话继续/压缩/收尾交接由 Lead 决定；先做完当前 phase 并把结论/未决项回执 Lead，等 Lead 决定后再继续。');
        }
        let reminder;
        let operation;
        let panel;
        // 出口/恢复旁路面板闸门（D6=A：出口不进、恢复不要求 budget_plan/继续方式选择）。
        if (mainCrossing && overBudget) {
          // phase 边界闸门：只按 composer 面板状态处理，不调用官方审批。
          // 面板状态经 normalizePanelState 归一：只有 4 个有效档位（问我/继续/压缩继续/接力新会话）参与分支。
          panel = panelStateOf(session.id);
          operation = panel.defaultOperation;
          if (operation === 'continue') {
            // 契约自检已在 crossing 前置统一校验（2026-11-01 审查 P2：拒绝路径不写盘）。
            // v0.4.0：模式持久不消费——「继续」放行后模式保持。
            reminder = '按面板模式「继续」：已放行本次 phase 切换（不压缩不接力）；模式保持（不消费），下一个到线仍按「继续」处理。';
          } else if (operation === 'compress') {
            // rev5.5 正交模型：模式只决定「做什么」，不再自带免审——执行时仍按授权规则（可能弹一次）。
            // v0.4.0：模式持久，relay_phase 拒绝路径不改模式。
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 按面板模式「压缩继续」先整理再切 phase——调用 relay_organize({phase:"' + previous + '", brief:"<本 phase 结论与证据指针>"})，成功后再重试 relay_phase({phase:"' + phase + '"}). 模式保持（不消费）；压缩执行仍会过一次官方授权（autoCompress/授权下一次操作 才免问）。');
          } else if (operation === 'handoff') {
            // v0.4.0：模式持久，接力成功后由新会话继承（失败/审批拒绝不改模式）。
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 按面板模式「接力新会话」先收尾再开新会话——调用 relay_handoff({human_approved:true, status:{phase:"' + previous + '", ...}})；模式保持（不消费；接力成功后新会话继承该模式）；接力执行仍会过一次官方授权（autoHandoff/授权下一次操作 才免问）。');
          } else {
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 已超预算，开新 phase 须由人类选择继续方式（压缩继续 / 接力新会话 / 继续）——先问人类（一次问清、附推荐与默认），或让人类在 composer 面板「接力」chip 选模式/自动授权；人类明确后再调对应工具或重试 relay_phase。');
          }
        }
        if (budgetReminder !== undefined) reminder = budgetReminder;
        // v0.6.3：phase 边界「队友上下文」提醒（v0.7.0 起降为 warning，不拒绝切 phase）：
        // 队友到线/读不到时不能静默忘记；建议写 team_note（一行处理结论）留痕。triage 结果写进团队上下文快照，
        // Lead 的台账焦点行会持续带出「队友待处理」（事件驱动，不按时间、不轮询）。
        const teamNote = typeof args?.team_note === 'string' ? args.team_note.trim() : '';
        if (teamNote.length > TEAM_NOTE_LIMIT) throw new Error('relay_phase refused (team note): team_note 最多 ' + TEAM_NOTE_LIMIT + ' 字（一行处理结论）。');
        let teamNoteWarning;
        let teamTriage;
        let teamContextCwd;
        let teamContextScope;
        // v0.9.0 批次3：ship 委派快照复用本轮团队列表算 idleWorkers（不额外 IO；读不到=null 不猜 0）。
        let delegationIdleWorkers = null;
        if (mainCrossing && !isTeammateSession(ctx, caller) && !isSubagentSession(session)) {
          teamContextCwd = cwdOf(session);
          teamContextScope = workItemsScopeOf(session);
          const snapshot = readTeamContext(teamContextCwd, teamContextScope);
          let pending = [];
          try {
            const membership = roleOf(ctx, caller);
            if (membership?.role === 'lead') {
              const listed = await listMembers(ctx, caller);
              const root = membership.root;
              const leadSessionId = root?.session?.id ?? root?.id ?? session.id;
              const roster = readRoster(cwdOf(session), leadSessionId);
              const members = listed.ok ? squadMembersOf(roster, listed.members.filter((member) => member?.role === 'teammate')) : [];
              if (listed.ok) delegationIdleWorkers = members.filter((member) => member.status !== 'running').length;
              if (members.length > 0) {
                const thresholdsNow = currentThresholds();
                const rows = await Promise.all(members.map(async (member) => {
                  const pressure = await teammateState(ctx, member);
                  const band = pressure === undefined ? 'unknown' : bandFor(pressure, thresholdsNow).band;
                  return { name: member.name, band, action: TEAM_TRIAGE_ACTION[band] ?? TEAM_TRIAGE_ACTION.unknown };
                }));
                pending = rows.filter((row) => row.band === 'organize' || row.band === 'relay' || row.band === 'unknown').map((row) => row.name);
                teamTriage = {
                  members: rows.slice(0, 6),
                  ...(rows.length > 6 ? { omitted: rows.length - 6 } : {}),
                  hint: pending.length > 0
                    ? '边界处理：' + pending.join(', ') + ' 到线/读不到——按 action 处理，并建议在 team_note 写一行处理结论（不写不拒绝）；不要轮询 relay_team_status。'
                    : '队友都在线内：无需处理队友上下文。',
                  ...(pending.length > 0 ? { pending } : {}),
                };
              }
            }
          } catch { teamTriage = undefined; }
          // 读不到 Agent Teams（或本进程不是 Lead）时，用上次落盘的快照兜底：不静默丢掉待处理。
          if (pending.length === 0 && snapshot.pending !== undefined) pending = snapshot.pending.map((row) => row.name);
          if (pending.length > 0 && teamNote === '') {
            // v0.7.0：队友上下文提醒降级为 warning（不拒绝切 phase）；G9：不当机械闸门。
            teamNoteWarning = '队友 ' + pending.join(', ') + ' 到线/读不到——phase 边界建议先处理（relay_checkpoint / relay_freshen({reset:true, brief}) / relay_renew）；本次放行，但请把结论记进 team_note/台账。';
          }
        }
        // 契约自检（预算内切 phase）已在上方 crossing 前置统一校验（拒绝路径不写盘）。
        // 经验存档（ACE 式演化手册）：声明 phase 时顺带记录本 phase 的可复用做法；只有这里写盘（拒绝路径不写）。
        // 回灌只在跨 phase（crossing）时发生：同 phase 声明（如只记 lessons）不重复注入 ≤1KB 的历史经验（v0.2.17 A6）。
        // 读/写都受 lessons.js 的容量与去重约束；recordLessons 每次成功的 phase 调用都可以写。
        const lessonsCwd = cwdOf(session);
        let lessonsReport;
        if (typeof lessonsCwd === 'string' && lessonsCwd !== '') {
          const recorded = Array.isArray(args?.lessons) ? await recordLessons(lessonsCwd, args.lessons) : undefined;
          const archive = lessonsView(lessonsCwd, { goal: String(args?.goal ?? '') });
          lessonsReport = {
            ...(recorded === undefined ? {} : { recorded: { added: recorded.added, merged: recorded.merged, evicted: recorded.evicted, saved: recorded.saved } }),
            total: archive.total,
            bytes: archive.bytes,
            // 注入上限（fix-tools）：模型需要知道注入是否被截断/丢条；仅跨 phase 回灌。
            ...(crossing ? {
              selected: archive.selected,
              ...(archive.injection === undefined ? {} : { injection: archive.injection }),
            } : {}),
          };
        }
        // 出口/恢复也写内存缓存（derivePhase/deriveExit 在无投影 fallback 时读取；出口带原因 + 来源 phase）。
        // exit.from = 退出前的主链 phase（C7/A-10）：供 ship 出口恢复判断「回到退出前 phase」。
        const exitFrom = exitTarget ? (fromExit ? exitOrigin ?? previous : previous) : undefined;
        PHASE_MEMORY.set(session.id, { seq: session.seq, phase, ...(exitTarget ? { exit: { kind: phase, reason: exitReason, ...(exitFrom === undefined ? {} : { from: exitFrom }) } } : {}) });
        capMap(PHASE_MEMORY);
        // phase 预算实测（成功声明/切换后才写）：本 phase 起点 used + 上一 phase 实测消耗（warn 档 estimate_tokens 缺省值）。
        // v0.9.0 #10：出口不是主链 phase，不写预算实测（避免把 blocked/cancel 当成预算阶段）。
        if (!exitTarget) {
          recordPhaseBudget(session, mainCrossing
            ? { phase, used: state.used, previous, ...(lastPhaseCostTokens === undefined ? {} : { previousCostTokens: lastPhaseCostTokens }) }
            : budgetMemoryBefore ?? { phase, used: state.used });
        }
        // v0.3.3：成功切 phase = 本次到线的模型推荐已过期，清空推荐三字段（只展示，不参与决策）。
        if (crossing) updatePanelState(session.id, { recommendedOperation: null, recommendedReason: '', recommendedAt: null }, { source: 'agent' });
        if (mainCrossing && overBudget) {
          // 模式持久：边界提醒里的面板状态就是当前模式（不再有消费后的「问我」）。
          injectBoundary(panelStateOf(session.id), '按面板模式「继续」放行本次切换（模式保持）；phase 完成后仍超线，注意下一次继续方式。');
        }
        // 工作台账（v0.6.0）：跨 phase 时落账——carry 迁移 + 新分点 + currentPhase 一次写入，再报本 phase 摘要。
        let ledgerReport;
        if (mainCrossing && ledgerSnapshot !== undefined) {
          const baseItems = ledgerSnapshot.exists === true ? ledgerSnapshot.items : [];
          const carriedFromPhase = ledgerSnapshot.currentPhase?.phase ?? previous;
          const carriedItems = carriedIds.length > 0 ? applyPhaseCarry(baseItems, { carry: carriedIds, from: carriedFromPhase, to: phase }) : baseItems;
          const nextItems = openedItems !== undefined && openedItems.length > 0 ? [...carriedItems, ...openedItems] : carriedItems;
          const shouldWrite = ledgerSnapshot.exists === true || nextItems.length > 0;
          if (shouldWrite) {
            const written = await writeWorkItems(cwdOf(session), {
              items: nextItems,
              ...(ledgerSnapshot.exists === true ? { rev: ledgerSnapshot.rev } : {}),
              updatedBy: session.id,
              max: workItems.max,
              pathOverride: workItems.pathOverride,
              scopeId: workItemsScopeOf(session),
              currentPhase: { phase, goal: args?.goal, exitCriteria: args?.exit_criteria, since: Date.now(), openedAtRev: ledgerSnapshot.exists === true ? ledgerSnapshot.rev : 0 },
            });
            if (written?.ok === true) {
              const summary = phaseSummary({ currentPhase: written.ledger.currentPhase, items: written.ledger.items });
              ledgerReport = {
                phase,
                planned: summary.planned,
                done: summary.done,
                pending: summary.pending,
                ...(openedItems !== undefined && openedItems.length > 0 ? { opened: openedItems.map((item) => item.id) } : {}),
                ...(carriedIds.length > 0 ? { carried: carriedIds } : {}),
                ...(phaseGateInfo?.ignored?.length > 0 ? { carryIgnored: phaseGateInfo.ignored } : {}),
                ...(phaseGateInfo?.leftover?.length > 0 ? { leftover: phaseGateInfo.leftover } : {}),
                ...(summary.planned === 0 ? { hint: '本 phase 没有分点：用 relay_work_items 记 2–4 条，或用 relay_phase({items:[...]}) 下次带上；单线程小任务可忽略。' } : {}),
              };
            } else {
              workItemsWarning = 'phase ledger write failed: ' + String(written?.message ?? written?.code ?? 'unknown') + '（phase 已切换，台账未更新）';
            }
          }
        }
        // v0.6.2：台账缺失的遗漏分支——跨 phase 时给一次开账提示（事件驱动，不注入、不看时间）。
        if (mainCrossing && ledgerReport === undefined && workItems.enabled !== false
          && (ledgerSnapshot === undefined || ledgerSnapshot.exists !== true)
          && (openedItems === undefined || openedItems.length === 0)) {
          ledgerReport = { hint: '本会话还没有工作台账：本 phase 有 2+ 分点时用 relay_phase({items:[...]}) 开账（或 relay_work_items 建账）；单线程小任务可忽略。' };
        }
        // v0.6.3：队友上下文快照落盘——Lead 台账焦点行据此显示「队友待处理」（压缩/重启后仍在）；
        // triage 在 phase 切换前已算好并过闸门（未处理时拒绝），这里只写成功结果。
        if (teamContextCwd !== undefined && (teamTriage !== undefined || teamNote !== '')) {
          try {
            await replaceTeamContext(teamContextCwd, teamContextScope, {
              phase,
              rows: (teamTriage?.members ?? []).map((row) => ({ name: row.name, band: row.band })),
              ...(teamNote === '' ? {} : { note: teamNote, handled: teamTriage?.pending ?? [] }),
            });
          } catch { /* 快照写失败不阻断 phase 切换 */ }
        }
        publish(phase);
        // v0.9.0 D1=B：ship 的 report warning 随结果返回 + 一条去重插件 notice（非用户发言，不阻断）；
        // 只回 warning 摘要，不落 report 原文。
        if ((userGateWarnings !== undefined || userGateDetails === true) && typeof caller.inject === 'function' && claimBoundaryNotice(session.id, 'user-gate', phase)) {
          try {
            const lines = [];
            if (userGateWarnings !== undefined) {
              lines.push('[context-relay] 用户汇报 warning（不阻断，插件 notice，非用户发言）：'
                + userGateWarnings.map((warning) => warning.message).join('；'));
              lines.push('本次 ship 已放行（不是审批门）；按提示补四段式正文即可，细节放 L2 文档只给路径。');
            }
            // P2 修复：details_requested 时附一次「用户已授权展开细节」（同一条 notice，去重逻辑不变）。
            if (userGateDetails === true) {
              lines.push('用户已授权展开细节（details_requested:true）：展开建议≤4000字，四段骨架仍建议保留；本次 ship 不因此改变结果（不是硬拒豁免）。');
            }
            const summary = userGateWarnings !== undefined
              ? '[context-relay] 用户汇报 warning（不阻断，非用户发言）'
              : '[context-relay] 用户汇报提示（非用户发言）';
            caller.inject(noticeMessage(lines.join('\n'), summary));
          } catch { /* notice 注入失败不影响 ship */ }
        }
        // v0.9.0 批次3：ship 结果带 delegation 快照（用户汇报素材；advisory，不机械校验 report 文本）。
        if (phase === 'ship' && !exitTarget && delegationReport === undefined) {
          delegationReport = delegationSnapshot({
            execution: executionOf(projected),
            dispatchCount: projectedCount(projected?.dispatchCalls),
            collectCount: projectedCount(projected?.collectCalls),
            idleWorkers: delegationIdleWorkers,
            projectedAvailable: projected !== undefined,
          });
        }
        // P2（D5=A）：删两处入参回显（goal/exit_criteria；真源在台账 currentPhase / 投影 derivePhaseMeta /
        // 模型刚提交的参数本身），结构化事实全部保留；text 由纯函数从结果对象渲染（模型唯一可见通道）。
        const result = {
          phase,
          previous,
          ...(exitTarget ? { exit_reason: exitReason, resumed: false } : {}),
          ...(!exitTarget && fromExit ? { resumed: true } : {}),
          ...(overBudget ? { band: state.band } : {}),
          ...(mainCrossing && state.band === 'ok' ? { context: { action: 'continue', ratio: state.ratio } } : {}),
          ...(budgetReport === undefined ? {} : { budget: budgetReport }),
          ...(designGate === undefined ? {} : { design: designGate }),
          ...(userGate === undefined ? {} : { user_gate: userGate }),
          ...(ledgerReport === undefined ? {} : { ledger: ledgerReport }),
          ...(teamTriage === undefined ? {} : { team: { ...teamTriage, ...(teamNote === '' ? {} : { note: teamNote, handled: teamTriage.pending ?? [] }) } }),
          ...(workItemsWarning === undefined ? {} : { workItemsWarning }),
          ...(teamNoteWarning === undefined ? {} : { teamWarning: teamNoteWarning }),
          ...(contractWarning === undefined ? {} : { contractWarning }),
          ...(delegationReport === undefined ? {} : { delegation: delegationReport }),
          ...(delegationWarning === undefined ? {} : { delegationWarning }),
          ...(phaseHint === undefined ? {} : { hint: phaseHint }),
          ...(reminder === undefined ? {} : { reminder }),
          ...(lessonsReport === undefined ? {} : { lessons: lessonsReport }),
          summary: 'phase → ' + phase + ' (was ' + previous + ')'
            + (exitTarget ? '；显式出口（' + (phase === 'blocked' ? '阻塞' : '取消') + '）：' + exitReason : '')
            + (!exitTarget && fromExit ? '；从出口恢复' : '')
            + (operation === 'continue' ? '；面板模式=继续（保持）' : ''),
        };
        result.text = phaseResultText(result);
        return lossless(result);
      },
    },
    {
      name: TOOL_PREFIX + 'organize',
      description: 'Phase-boundary compression: write the phase brief and run one controlled compaction. Refused below threshold or on a second compression unless force=true or the composer panel mode is 压缩继续 (compress). Approval: autoCompress/authorizeNext only — a mode selection does not grant an approval exemption (see protocol).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['phase'],
        properties: {
          phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship'] },
          brief: { type: 'string', description: 'Compression-survival brief (markdown, <=2000 chars): goal/phase, decisions, constraints, evidence pointers (file:line), risks, next step; no progress log.' },
          key_docs: { type: 'array', items: { type: 'string' }, description: 'Important-file index for this project (<=8 workspace paths; path — role — why read after compaction): entry, core modules, configs, contracts, tests.' },
          force: { type: 'boolean', description: 'Force below threshold (rare).' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.summary ?? JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_organize requires a calling agent');
        // P3：与 relay_handoff 对齐——队友/子会话不得自行压缩（有损、不可逆），由 Lead 决定；
        // 结构化 lead-only，零副作用。
        if (isTeammateSession(ctx, caller)) {
          return fail('lead-only', 'relay_organize is Lead-only', { organized: false, briefInjected: false, summary: 'refused: subagent/teammate sessions must report to the Lead; only the Lead may run relay_organize. Report the current phase conclusion/open items to the Lead and keep working on the current phase.' });
        }
        const release = claimRelayOperation(caller.session);
        if (release === undefined) {
          return fail('relay-busy', 'busy: another relay operation in flight', { organized: false, briefInjected: false, summary: 'refused: busy — another relay operation (relay_organize/relay_handoff) is in flight in this session; wait for it to settle, then retry.' });
        }
        try {
          const before = pressureOf(ctx, caller.session);
          const state = bandFor(before, currentThresholds());
          const decision = shouldOrganize(state, args?.force === true);
          // P2#2 守卫前移：被拒路径零副作用——不跑 doc_lint（同步 git 子进程）、不写 brief 文件。
          if (!decision.organize) {
            logInfo(ctx, '[organize] skip session=' + caller.session.id + ' reason=' + decision.reason);
            return fail('below-threshold', 'not organized: ' + decision.reason, { organized: false, band: state.band, briefInjected: false, summary: 'not organized: ' + decision.reason + '. Call with force=true only if you are at a real phase boundary.' });
          }
          const projected = relayStateOf(ctx, caller.session);
          const organizeCount = deriveOrganizeCount(caller.session, projected);
          // v0.3.8/v0.4.0：人类在面板把模式选为「压缩继续」时按人类选择执行第二次压缩（审批仍由 autoCompress/authorizeNext 决定）；
          // 无模式时维持现行规则：第二次压缩需人类明确要求（force）。
          const panelPreset = panelStateOf(caller.session.id).defaultOperation;
          if (organizeCount >= 1 && args?.force !== true && panelPreset !== 'compress') {
            logInfo(ctx, '[organize] skip session=' + caller.session.id + ' reason=already-organized count=' + organizeCount);
            return fail('already-organized', 'this session already compressed once (' + organizeCount + ')', { organized: false, band: state.band, organizeCount, briefInjected: false, summary: 'refused: this session already compressed once (' + organizeCount + '). At the phase boundary ask the human to choose handoff (relay_handoff); or, if the human selects 「压缩继续」 in the composer panel, retry without force (approval still applies); only if the human explicitly insists on compressing again, retry with force=true. Compression drift compounds.' });
          }
          const engine = ctx.get('compaction');
          if (engine === undefined || typeof engine.compactIfNeeded !== 'function') {
            // P2#9：引擎缺失是降级而非崩溃——结构化 ok:false + code，不抛普通 Error。
            logWarn(ctx, '[organize] skip session=' + caller.session.id + ' reason=compaction-unavailable');
            return fail('compaction-unavailable', 'compaction service unavailable in this preset', { organized: false, band: state.band, briefInjected: false, summary: 'refused: compaction service unavailable in this preset (degraded preset); no compression was attempted. Use relay_handoff or continue without organizing.' });
          }
          const phase = normalizePhase(args?.phase, derivePhase(caller.session, projected));
          const phaseMeta = derivePhaseMeta(caller.session, projected);
          const cwd = cwdOf(caller.session);
          const lint = runDocLint(cwd);
          const baseBrief = buildPhaseBrief({ phase, goal: phaseMeta.goal, exitCriteria: phaseMeta.exit_criteria, decisions: args?.brief === undefined ? [] : String(args.brief).split(/\n+/), constraints: [], evidence: [lint.evidence], keyDocs: args?.key_docs, next: [] });
          // 工作台账（契约 §5）：brief 生成后、写盘前追加未闭合项段（空台账不追加 → 旧行为不变）。
          // v0.7.1：台账跟会话走（scopeId=根会话）；漏传 session 会读到旧 workspace 级文件 →
          // 压缩 brief 的「未闭合工作项」在默认配置下永远为空（或串入别的会话）。
          const ledgerRead = readLedger(cwd, caller.session);
          const ledgerSection = ledgerRead === undefined ? '' : ledgerBriefSection(ledgerRead);
          // docs v2（v0.8.0）：压缩后的 brief 必须带 L0 文档索引——新上下文靠它知道「有哪些文档、何时读、去哪取」。
          const docsSection = (() => {
            try {
              const rendered = renderDocIndex(buildDocIndex(cwd));
              return rendered.shown === 0 ? '' : rendered.text;
            } catch { return ''; }
          })();
          const brief = baseBrief + (ledgerSection === '' ? '' : '\n' + ledgerSection) + (docsSection === '' ? '' : '\n' + docsSection);
          let briefPath;
          try {
            briefPath = await writeWorkspaceFile(cwd, 'phase-' + phase + '-' + Date.now() + '.md', brief);
          } catch (error) {
            // P2#9：写盘失败结构化降级，不再裸抛；压缩不尝试，避免「压缩了却没有 brief」。
            const reason = String(error?.message ?? error);
            logWarn(ctx, '[organize] failed session=' + caller.session.id + ' code=brief-write-failed reason=' + reason);
            return fail('brief-write-failed', 'phase brief could not be written: ' + reason, { organized: false, band: state.band, briefInjected: false, docLint: { level: lint.level, summary: lint.summary }, summary: 'organize aborted: phase brief could not be written to .scratch/context-relay (' + reason + '); compression was NOT attempted. Check workspace write permission (cwd: ' + cwd + ').' });
          }
          const route = providerModelOf(caller);
          const options = { provider: route.provider, model: route.model };
          const signal = exec?.signal ?? new AbortController().signal;
          let result;
          try {
            result = await engine.compactIfNeeded({ session: caller.session, options }, 'context-overflow', signal);
          } catch (error) {
            const message = String(error?.message ?? error);
            const busy = String(error?.code ?? '') === 'busy' || /busy|active/i.test(message);
            logWarn(ctx, '[organize] failed session=' + caller.session.id + ' code=' + (busy ? 'compaction-busy' : 'compaction-failed') + ' reason=' + message);
            return fail(busy ? 'compaction-busy' : 'compaction-failed', message, { busy, organized: false, band: state.band, briefPath, briefInjected: false, docLint: { level: lint.level, summary: lint.summary }, summary: 'organize failed' + (busy ? ' (compaction busy, retry after current turn)' : '') + ': ' + message });
          }
          // 压缩可恢复化（2026-11-03）：把「本会话 id + 被遮蔽事件 seq 区间 + brief 路径」写成
          // 链式索引，并把「压缩与链式召回」段追加进 brief（文件与注入同源）；失败只降级、不阻断压缩。
          const organized = result !== null && result !== undefined;
          const shadowedSeqs = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.filter((seq) => Number.isInteger(seq)) : [];
          const compactionInfo = organized
            ? {
                compactionId: result?.compactionId === undefined ? undefined : String(result.compactionId),
                shadowedStart: shadowedSeqs.length > 0 ? Math.min(...shadowedSeqs) : undefined,
                shadowedEnd: shadowedSeqs.length > 0 ? Math.max(...shadowedSeqs) : undefined,
                freedTokens: result?.shadowedTokenCount,
              }
            : undefined;
          let chainInfo;
          let recallSection = '';
          let manualRecall = '';
          if (organized) {
            try {
              chainInfo = await appendChainEntry(cwd, {
                kind: 'compaction',
                sessionId: caller.session.id,
                phase,
                goal: phaseMeta.goal,
                compactionId: compactionInfo.compactionId,
                shadowedStart: compactionInfo.shadowedStart,
                shadowedEnd: compactionInfo.shadowedEnd,
                freedTokens: compactionInfo.freedTokens,
                briefPath: workspaceRelativePath(cwd, briefPath),
              });
              recallSection = buildRecallSection({ sessionId: caller.session.id, compaction: compactionInfo, entries: readChain(cwd, 8), briefPath: workspaceRelativePath(cwd, briefPath) });
              await appendWorkspaceFile(cwd, briefPath, '\n' + recallSection + '\n');
            } catch (error) {
              logWarn(ctx, '[organize] chain index failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error));
            }
            // A+B（2026-11-08 实测缺口）：官方压缩只自动恢复 runtime-context / AGENTS.md 基线 / skill 目录；
            // touch 发现的附加 AGENTS.md 与被遮蔽的 skill 调用不会回来——压缩后注入手动召回指针（以 shadowedEnd 为上界）。
            try {
              manualRecall = buildManualRecallSection({ session: caller.session, shadowedEnd: compactionInfo?.shadowedEnd });
              if (manualRecall !== '') await appendWorkspaceFile(cwd, briefPath, '\n' + manualRecall + '\n');
            } catch (error) {
              logWarn(ctx, '[organize] manual recall failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error));
            }
          }
          // M2-G：搬到「压缩成功且真压了」之后。inject 是 next-step inbox——下一 step 才作为
          // user/message 落盘，因此无论压缩前调用还是压缩后调用，在 surface 上都是压缩完成后可见；
          // 失败/busy/无可压缩历史不注入，busy 重试也不会叠加重复 notice。
          let briefInjected = false;
          if (result !== null && result !== undefined && injectBrief && typeof caller.inject === 'function') {
            try {
              const header = '[context-relay] phase brief · ' + phase + '（压缩后注入，非用户发言）\n'
                + '接手第一步：先按「关键文件索引」读入口文件（完整 brief 见 ' + briefPath + '；索引若被截断先读完整文件），再继续本 phase。\n'
                + '以下关键结论在压缩后继续以此为准：\n';
              // P3-8：brief 超长时静默 slice 会先丢尾部的证据指针/关键文档（恰是压缩后最需要的
              // 可恢复引用）——超限时在尾部标注截断并给出完整文件路径，不静默。
              const recallTail = [recallSection, manualRecall]
                .filter((section) => section !== '')
                .map((section) => '\n\n' + section)
                .join('');
              const maxChars = 4000;
              const truncation = '\n\n[brief truncated: 完整内容见 ' + briefPath + ']';
              // P2-1（2026-11-03 审查）：召回段是压缩后唯一的可恢复入口，不能被尾部截断切掉——
              // 超限时先截 brief 正文（指向完整文件），保住末尾的「链式召回 + 手动召回」段。
              const base = header + brief;
              const text = base.length + recallTail.length <= maxChars
                ? base + recallTail
                : base.slice(0, Math.max(0, maxChars - recallTail.length - truncation.length)) + truncation + recallTail;
              caller.inject(noticeMessage(text, '[context-relay] phase brief · ' + phase + ' · 压缩后注入（非用户发言）'));
              briefInjected = true;
            } catch (error) {
              logWarn(ctx, '[organize] inject failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error));
            }
          }
          const after = pressureOf(ctx, caller.session);
          const afterState = bandFor(after, currentThresholds());
          const freed = result?.shadowedTokenCount;
          // 成功压缩 → 到线提醒重新武装（压缩多少次都不压掉到线提醒；下次到线必提醒）。
          if (organized) LAST_BAND.set(caller.session.id, { band: 'ok', compactionSeq: persistedSentinel(caller.session, relayStateOf(ctx, caller.session)).lastCompactionSeq });
          // F3 + v3 + v0.4.0：成功压缩只清一次性状态（模型自决、「授权下一次操作」、模型推荐）；
          // 面板模式持久、不消费（失败/拒绝/无压缩历史同样不改模式）。
          if (organized) {
            try {
              updatePanelState(caller.session.id, {
                authorizeNext: false,
                // v0.3.3：压缩成功 = 本次到线的模型推荐已消费/过期。
                recommendedOperation: null,
                recommendedReason: '',
                recommendedAt: null,
              }, { source: 'agent' });
            } catch { /* 忽略 */ }
          }
          logInfo(ctx, '[organize] ok session=' + caller.session.id + ' freed=' + String(freed ?? '?') + ' band=' + state.band + '→' + afterState.band + ' briefInjected=' + briefInjected);
          return lossless({
            ok: true,
            organized,
            band: state.band,
            afterBand: afterState.band,
            before: { used: before.used, ratio: before.ratio },
            after: { used: after.used, ratio: after.ratio },
            freedTokens: freed,
            briefPath,
            briefInjected,
            manualRecallInjected: briefInjected && manualRecall !== '',
            // 实际提交释放的「仍驻留」id 数（内核已自动释放的不计入，避免虚报）。
            compaction: compactionInfo,
            chain: chainInfo === undefined ? undefined : { path: chainInfo.relativePath, entries: chainInfo.entries },
            // 只有真正发生压缩才 +1；'no compactable history' 不计（否则会挡住下一次真实压缩）。
            organizeCount: organized ? organizeCount + 1 : organizeCount,
            docLint: { level: lint.level, summary: lint.summary },
            summary: ((result === null || result === undefined)
              ? 'no compactable history; brief written to ' + briefPath
              : 'organized: freed ' + String(freed ?? '?') + ' tokens; band ' + state.band + ' → ' + afterState.band + '; brief ' + briefPath) + (briefInjected ? '; brief injected into context after compaction' : ''),
          });
        } finally {
          release();
          publishLiveFor(ctx, caller.session, currentThresholds());
        }
      },
    },
    {
      name: TOOL_PREFIX + 'doc',
      description: 'Relay session docs: L0 index -> fetch only the docs you need. Actions: index (rendered L0 index), list (entries; include=all for raw), read (path + optional section/offset/limit; bounded), search (query -> path:line snippets), lint (advisory doc health). Caps are advisory: oversize content stays on disk.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['index', 'list', 'read', 'search', 'lint'], description: 'Operation.' },
          path: { type: 'string', description: 'Doc path relative to .scratch/context-relay (e.g. docs/decisions.md).' },
          section: { type: 'string', description: 'Heading substring to read only that section.' },
          query: { type: 'string', description: 'Literal text to search across docs.' },
          offset: { type: 'integer', description: '0-based line offset (read).' },
          byteOffset: { type: 'integer', minimum: 0, description: 'Byte offset within a long line (read).' },
          limit: { type: 'integer', description: 'Max lines (read) / matches (search).' },
          include: { type: 'string', enum: ['index', 'all'], description: 'list: index (default) or all scanned docs.' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_doc requires a calling agent');
        const cwd = cwdOf(caller.session);
        const action = args?.action;
        if (action === 'index') {
          const index = buildDocIndex(cwd);
          const rendered = renderDocIndex(index);
          const text = rendered.text + '\n- counts: L1/L2/raw=' + index.counts.indexed + '/' + index.counts.raw + ' · bytes=' + rendered.bytes + ' · digest=' + rendered.digest;
          return lossless({ ok: true, action, bytes: rendered.bytes, digest: rendered.digest, shown: rendered.shown, omitted: rendered.omitted, counts: index.counts, text });
        }
        if (action === 'list') {
          const include = args?.include === 'all' ? 'all' : 'index';
          const index = buildDocIndex(cwd, { include });
          const lines = index.entries.map((entry) => '- [' + entry.layer + '] ' + (entry.relPath || entry.path) + ' — ' + (entry.role || '（未标注作用）') + (entry.when === '' ? '' : '（' + entry.when + '）') + ' · ' + entry.bytes + 'B · ' + entry.updated);
          return lossless({ ok: true, action, include, total: index.counts.total, shown: lines.length, entries: index.entries.map((entry) => ({ path: entry.relPath || entry.path, layer: entry.layer, role: entry.role, when: entry.when, bytes: entry.bytes, updated: entry.updated })), text: lines.length === 0 ? '（无文档）' : lines.join('\n') });
        }
        if (action === 'read') {
          if (args?.byteOffset !== undefined && (!Number.isSafeInteger(args.byteOffset) || args.byteOffset < 0)) return fail('invalid-byte-offset', 'byteOffset must be a non-negative integer');
          const out = readDoc(cwd, args?.path, { section: args?.section, offset: args?.offset, byteOffset: args?.byteOffset, limit: args?.limit });
          if (out.ok !== true) return fail(out.code ?? 'read-failed', out.error ?? 'read failed', { path: out.path, sections: out.sections });
          const head = '# ' + out.path + (out.title === '' ? '' : ' · ' + out.title) + ' · ' + out.totalLines + ' 行 / ' + out.totalBytes + 'B' + (out.section === undefined ? '' : ' · section=' + out.section);
          const sections = out.sections.length === 0 ? '' : '\nsections: ' + out.sections.map((item) => item.title).join(' / ');
          return lossless({ ...out, action, text: head + sections + '\n\n' + out.text + (out.truncated ? '\n… ' + out.hint : '') });
        }
        if (action === 'search') {
          const out = searchDocs(cwd, args?.query, { limit: args?.limit });
          if (out.ok !== true) return fail(out.code ?? 'search-failed', out.error ?? 'search failed');
          const lines = out.matches.map((match) => match.path + ':' + match.line + ' — ' + match.snippet);
          const text = lines.length === 0 ? '（无命中；可试 relay_doc list include=all 或更短关键词）' : lines.join('\n');
          return lossless({ ...out, action, text });
        }
        if (action === 'lint') {
          const check = checkSessionDocs({ workspaceRoot: cwd });
          const text = 'relay_doc lint: ' + (check.ok ? 'PASS' : 'WARN') + '\n' + check.detail;
          return lossless({ ok: true, action, ...check, text });
        }
        return fail('invalid-action', 'action must be one of index/list/read/search/lint', { action });
      },
    },
    {
      name: 'doc_lint',
      description: 'Four doc-governance checks (quota / banned wording / index paths / git), read-only; output is a <=2KB summary.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Extra docs (<=20).' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('doc_lint requires a calling agent');
        const cwd = cwdOf(caller.session);
        const lint = runDocLint(cwd, args?.paths, 2048);
        return lossless({ ok: lint.ok, level: lint.level, workspaceRoot: cwd, summary: lint.summary, text: lint.summary });
      },
    },
    {
      name: TOOL_PREFIX + 'work_items',
      description: 'Read or maintain the Leader\'s phase work ledger (work-items/<session>.json; handoff copies it). Lead-only. No args = read. Lead: items (whole-list replace, optional rev; officialTaskId=official task id ref). Marking done requires lead_confirm (3×true; see schema). Done items removed on replace are archived to <ledger>-archive.ndjson (archive.path/count). Call at phase start/before handoff.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          items: {
            type: 'array', maxItems: 100, description: 'Whole-list replace (Lead only).',
            items: {
              type: 'object', additionalProperties: false, required: ['id', 'title', 'status'],
              properties: {
                id: { type: 'string', description: '2-32 chars, ^[a-z0-9][a-z0-9-]*$ (unique).' },
                title: { type: 'string', description: '<=120 chars.' },
                status: { type: 'string', enum: [...WORK_ITEM_STATUSES] },
                owner: { type: 'string', description: '<=40 chars (empty = Lead).' },
                next: { type: 'string', description: 'Required for doing; open may be empty (<=160 chars).' },
                blocked: { type: 'string', description: 'Required for blocked (<=200 chars).' },
                evidence: { type: 'array', items: { type: 'string' }, description: '<=3 pointers (file:line / command).' },
                acceptance: { type: 'string', description: '<=160 chars.' },
                depends: { type: 'array', items: { type: 'string' }, description: '<=8 existing item ids.' },
                phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship'] },
                officialTaskId: { type: 'string', description: 'Optional official task-board id reference (1-64 chars, e.g. task-xxx); stored as-is, existence NOT validated.' },
                lead_confirm: {
                  type: 'object', additionalProperties: false,
                  description: 'Required when this item changes from non-done to done: Lead confirmation that no_drift/no_missing/no_regression are ALL true after reviewing diff/requirements/tests. Missing/incomplete → whole-table done-gate refusal (zero side effects). Already-done items may omit it (stored confirmation is kept).',
                  properties: {
                    no_drift: { type: 'boolean', description: 'true = no drift from requirements/design.' },
                    no_missing: { type: 'boolean', description: 'true = nothing required is missing.' },
                    no_regression: { type: 'boolean', description: 'true = tests/verification passed; no regression.' },
                  },
                  required: ['no_drift', 'no_missing', 'no_regression'],
                },
              },
            },
          },
          rev: { type: 'number', description: 'Optimistic lock: current rev from a prior read.' },
          drop: { type: 'array', items: { type: 'string' }, description: 'Explicitly remove these ids on whole-list replace; non-done items cannot be removed silently.' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_work_items requires a calling agent');
        // 台账是 Leader 自己的项目管理队列：只有 root Lead 可读写；队友/子代理一律 lead-only。
        if (isSubagentSession(caller.session)) {
          return fail('lead-only', 'relay_work_items is Lead-only', { summary: 'refused: the work ledger belongs to the Leader; teammates report to the Lead instead of editing it.' });
        }
        if (workItems.enabled === false) {
          return fail('work-items-disabled', 'work items are disabled by config (workItems=false)', { summary: 'refused: work ledger disabled (workItems=false); nothing was read or written.' });
        }
        const cwd = cwdOf(caller.session);
        const scopeId = workItemsScopeOf(caller.session);
        const identity = 'lead';
        const readNow = () => readWorkItems(cwd, { pathOverride: workItems.pathOverride, scopeId });
        /** 成功返回体（契约 §3 输出形状固定）。 */
        const present = (mode, ledger, items, archived) => {
          const unclosed = formatWorkItemLines(items, { limit: 12 });
          const counts = ledger.counts;
          const totals = counts.pending + ' pending / ' + counts.total + ' total (rev ' + ledger.rev + ')';
          // v0.9.0 #39（D4=A）：归档可查——读返回体带 archive:{path,count}（读失败给 error 不阻断）。
          const archive = readArchive(cwd, { pathOverride: workItems.pathOverride, scopeId });
          return lossless({
            ok: true,
            mode,
            exists: ledger.exists,
            rev: ledger.rev,
            updatedAt: ledger.updatedAt,
            relativePath: ledger.relativePath,
            counts,
            items,
            unclosed,
            archive: archive.ok === true ? { path: archive.relativePath, count: archive.count } : { path: archive.relativePath, count: 0, error: archive.error },
            ...(archived === undefined ? {} : { archived }),
            summary: mode === 'patch' ? 'work items patched by ' + identity + ': ' + totals : mode === 'replace' ? 'work items replaced: ' + totals : 'work items read: ' + totals,
            text: '工作台账（' + ledger.relativePath + '）· rev ' + ledger.rev + ' · 未闭合 ' + counts.pending + ' / 共 ' + counts.total
              + (unclosed.length > 0 ? '\n' + unclosed.join('\n') : '（暂无未闭合项）')
              + (archive.count > 0 ? '\n归档：' + archive.relativePath + '（' + archive.count + ' 条，可 read 查明细）' : ''),
          });
        };
        /** 写失败按稳定 code 返回（契约 §3）。 */
        const failedWrite = (result) => fail(result?.code ?? 'write-failed', String(result?.message ?? 'work ledger write failed'), {
          ...(Array.isArray(result?.errors) ? { errors: result.errors } : {}),
          ...(result?.currentRev === undefined ? {} : { currentRev: result.currentRev }),
          ...(result?.counts === undefined ? {} : { counts: result.counts }),
          summary: 'refused: ' + String(result?.code ?? 'write-failed') + ' — ' + String(result?.message ?? 'work ledger write failed'),
        });
        const hasItems = Array.isArray(args?.items);
        // items（整表替换，Lead-only）。
        if (hasItems) {
          // v0.6.0：整表替换不丢 phase——未写 phase 的条目继承原条目或 currentPhase（carriedFrom 同理）。
          const current = readNow();
          const metaPhase = current?.currentPhase?.phase ?? null;
          const knownById = new Map(current.items.map((item) => [item.id, item]));
          const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
          const items = args.items.map((raw) => {
            if (!isPlain(raw)) return raw;
            const known = typeof raw.id === 'string' ? knownById.get(raw.id) : undefined;
            const phase = raw.phase ?? known?.phase ?? metaPhase;
            const carriedFrom = raw.carriedFrom ?? known?.carriedFrom;
            // v0.9.0 #35：officialTaskId 像 phase/carriedFrom 一样 known 继承（未提供则保留旧值）。
            const officialTaskId = raw.officialTaskId ?? known?.officialTaskId;
            return {
              ...raw,
              ...(phase === undefined || phase === null ? {} : { phase }),
              ...(carriedFrom === undefined || carriedFrom === null ? {} : { carriedFrom }),
              ...(officialTaskId === undefined || officialTaskId === null ? {} : { officialTaskId }),
            };
          });
          // 关账闸门旁路修复：整表替换不得静默删除未完成条目（blocked 也算），必须显式 drop。
          const keptIds = new Set(items.map((item) => (isPlain(item) && typeof item.id === 'string' ? item.id : null)).filter((id) => typeof id === 'string'));
          const removed = current.items.filter((item) => !keptIds.has(item.id));
          const drop = (Array.isArray(args?.drop) ? args.drop : []).filter((id) => typeof id === 'string' && id !== '');
          const dropSet = new Set(drop);
          const unknownDrop = drop.filter((id) => !knownById.has(id));
          if (unknownDrop.length > 0) {
            return fail('invalid-drop', 'drop 引用了不存在的条目：' + unknownDrop.join(', ') + '（先 relay_work_items() 读当前台账）', { summary: 'refused: drop lists unknown item id(s).' });
          }
          const droppedButKept = drop.filter((id) => keptIds.has(id));
          if (droppedButKept.length > 0) {
            return fail('invalid-drop', 'drop 与 items 同时包含：' + droppedButKept.join(', ') + '——要么保留要么删除', { summary: 'refused: drop ids are still present in items.' });
          }
          const silent = removed.filter((item) => item.status !== 'done' && !dropSet.has(item.id));
          if (silent.length > 0) {
            return fail('phase-not-closed', '整表替换删除了未完成条目：' + silent.map((item) => item.id).join(', ') + '——未完成条目不得静默删除：要作废请用 drop:[ids] 显式声明，或先标 done/blocked 并写原因', {
              ids: silent.map((item) => item.id),
              summary: 'refused: whole-list replace would silently drop unclosed item(s); pass drop:[ids] explicitly or close them first.',
            });
          }
          // v0.9.0 #39（D4=A）：整表替换移除的 done 项自动归档（不再静默删）；显式 drop 的 done 项同样归档。
          // P3-4：归档交给 writeWorkItems，只在 stale-rev/validate 等可失败前置通过后才 append——
          // 失败路径（stale-revision / invalid-item / archive-failed）都不会留下孤儿归档。
          const removedDone = removed.filter((item) => item.status === 'done' && !dropSet.has(item.id));
          const droppedDone = removed.filter((item) => item.status === 'done' && dropSet.has(item.id));
          const archiveEntries = [
            ...removedDone.map((item) => ({ item, reason: 'removed-done' })),
            ...droppedDone.map((item) => ({ item, reason: 'dropped' })),
          ];
          const written = await writeWorkItems(cwd, {
            items,
            rev: typeof args?.rev === 'number' ? args.rev : current.rev,
            updatedBy: caller.session?.id,
            max: workItems.max,
            pathOverride: workItems.pathOverride,
            scopeId,
            archiveEntries,
          });
          if (written?.ok !== true) return failedWrite(written);
          return present('replace', { ...written.ledger, exists: true, relativePath: written.relativePath, counts: written.counts }, written.ledger.items, written.archived);
        }
        // 无 items → 读。
        const ledger = readNow();
        return present('read', ledger, ledger.items);
      },
    },
    createRelayHandoffTool(runtime),
  ];
}

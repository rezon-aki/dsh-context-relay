/**
 * dsh-context-relay — 五个模型工具（relay_status / relay_phase / relay_organize /
 * relay_handoff / doc_lint）。工具名、参数 schema、输出形状由测试锁定。
 *
 * @module dsh-context-relay/agent/tools
 */
import { PANEL_OPERATIONS, bandFor, budgetGate, buildPhaseBrief, continueChoice, formatStatus, normalizeBudgetPlan, normalizePhase, phaseBudget, shouldOrganize } from '../policy.js';
import { lessonsView, recordLessons } from '../lessons.js';
import { panelStateOf, publishLiveState, updatePanelState } from '../panel-store.js';
import { PHASE_MEMORY, deriveOrganizeCount, derivePhase, derivePhaseMeta, persistedSentinel, phaseBudgetMemory, pressureOf, recordPhaseBudget, relayStateOf, twoStageHandoffNotDue } from './derive.js';
import { adviceFor, adviceForSubagent, operationLabel } from './panel-gate.js';
import {
  LAST_BAND, claimBoundaryNotice, escalateToLead, escalationHint, phaseBoundarySummary,
  phaseBoundaryText, publishLiveFor, teammateState,
} from './sentinel.js';
import {
  TOOL_PREFIX, capMap, claimRelayOperation, cwdOf, fail, isSubagentSession, isTeammateSession, logInfo, logWarn,
  lossless, noticeMessage, runDocLint, writeWorkspaceFile,
} from './shared.js';
import { createRelayHandoffTool, providerModelOf } from './handoff.js';
import { appendChainEntry, buildRecallSection, readChain, workspaceRelativePath } from './chain.js';
import { appendFileSync } from 'node:fs';

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
  return { review, report, questions };
}

/**
 * 契约自检（2026-11-01 用户口径：模型工作时自己思考两条契约）：每次切 phase 前必须先答三问。
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
 * 两段式闸门（2026-11-02 用户澄清）：「压缩→新会话」= 第 1 次到线（band=organize/relay 的
 * phase 边界）只压缩并留在本会话继续，第 2 次到线才开新会话；单次到线不得压缩后立即接力。
 * 面板模式仍是 compress-then-handoff、本会话已压缩过（organizeCount>=1）、但当前未到线
 * （band 不是 organize/relay）时拒绝 relay_handoff——拒绝发生在任何副作用之前（不建会话、
 * 不写 handoff 文件/发布箱、不改模式）。band organize/relay（下一次到线）、mode 为
 * handoff/null、或 organizeCount=0（第 1 段还没做）时放行。
 * 注：relay_handoff 工具定义在 handoff.js；闸门在 tools.js 的装配点包装 execute（先于工具内一切副作用）。
 */
function twoStageRefusal(ctx, currentThresholds, caller) {
  const thresholds = currentThresholds();
  if (!twoStageHandoffNotDue(panelStateOf(caller.session.id), ctx, caller.session, thresholds)) return undefined;
  const organizeCount = deriveOrganizeCount(caller.session, relayStateOf(ctx, caller.session));
  const band = bandFor(pressureOf(ctx, caller.session), thresholds).band;
  return fail('two-stage-not-due', 'relay_handoff refused (two-stage mode, band=' + band + ', organizeCount=' + organizeCount + '): 面板「压缩→新会话」两段式的第 1 段压缩已完成，当前未到线——应留在本会话继续，不要立即 relay_handoff；第 2 段只在下一次到线（band=organize/relay 的 phase 边界）执行。本次零副作用：未建会话、未写 handoff 文件、未改模式。下一步：继续本会话工作，下一次到线再调 relay_handoff({human_approved:true, status:{phase, goal, next_actions, ...}})；若人类明确现在就要交接，先把 composer「接力」chip 的模式改成「接力新会话」（defaultOperation=handoff）或改成「问我」（defaultOperation=null），再重试本调用。', {
    band,
    organizeCount,
    summary: 'refused: two-stage mode compress-then-handoff — stage-1 compression is already done, but this is the same line-crossing (band=' + band + ', not organize/relay). No session created, no handoff file or handoff box entry written, mode unchanged. Keep working in this session; hand off at the NEXT line-crossing (band=organize/relay). If the human explicitly wants a new session now, have them set the composer mode to "接力新会话" (defaultOperation=handoff) or set it to asking (null), then retry.',
  });
}

/** relay_handoff 装配：先过两段式闸门，再执行原工具（闸门拒绝路径零副作用）。 */
function handoffWithTwoStageGate(runtime) {
  const tool = createRelayHandoffTool(runtime);
  const execute = tool.execute;
  tool.execute = async (args, exec) => {
    const caller = exec?.agent;
    // v0.3.8：长模式没有「压缩→新会话」档——两段式闸门只对经典 Relay 生效。
    const refused = caller === undefined || runtime.routerMode === true ? undefined : twoStageRefusal(runtime.ctx, runtime.currentThresholds, caller);
    return refused === undefined ? execute(args, exec) : refused;
  };
  return tool;
}

/** 构建六个工具定义（runtime = { ctx, currentThresholds, injectBrief, routerMode }）。 */
export function createRelayTools(runtime) {
  // routerMode=true（relay-long 长模式）：面板隐藏档（压缩→新会话 / 自动）在 relay_phase 边界闸门按「继续」归一。
  const { ctx, currentThresholds, injectBrief, routerMode } = runtime;
  return [
    {
      name: TOOL_PREFIX + 'status',
      description: 'Read context pressure, phase, organizeCount, execution ratio (Lead-side bash/pwsh/write/edit calls), compaction debt, budget headroom and next action; continue.needed=true means the continue decision is due. Call at phase start and before delegating. Lead only; teammates see themselves.',
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
        const team = [];
        const teams = ctx.get('agentTeams');
        if (teams !== undefined && typeof teams.tryMembership === 'function') {
          try {
            const membership = teams.tryMembership(caller);
            if (membership?.role === 'lead') {
              for (const member of teams.listMembers(caller)) {
                if (member.role === 'lead') continue;
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
        const toolCalls = Number.isInteger(projected?.toolCalls) && projected.toolCalls >= 0 ? projected.toolCalls : 0;
        const executionCalls = Number.isInteger(projected?.executionCalls) && projected.executionCalls >= 0 ? projected.executionCalls : 0;
        const execution = {
          calls: executionCalls,
          total: toolCalls,
          ratio: toolCalls > 0 ? Math.round((executionCalls / toolCalls) * 1000) / 1000 : 0,
        };
        // debt = 本会话已发生真实压缩（organizeCount>=1）→ 后续 handoff 的源上下文已脏，该交接。
        const compaction = { count: organizeCount, lastSeq: persisted.lastCompactionSeq, debt: organizeCount >= 1 };
        const panel = panelStateOf(caller.session.id);
        // v0.3.8：长模式没有「压缩→新会话」档——升级残留预设按无预设处理，避免模型可见 text 出现该档。
        const choicePanel = routerMode === true && panel.defaultOperation === 'compress-then-handoff' ? undefined : panel;
        const choice = continueChoice(state, organizeCount, choicePanel);
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
          : adviceFor(state.band, choice, panel, routerMode);
        // P2#8 瘦身：只回结构化 essentials + text；阈值与「压缩/接力」选择题留在 text（协议里也有），
        // 不再重复返回 thresholds / continue.options 大对象。diagnostics 供宿主排障（P2#13）。
        const diagnostics = { pressureSource: self.source, lastCompactionSeq: persisted.lastCompactionSeq, organizeCount };
        const report = {
          ok: true,
          phase,
          lead: { used: self.used, window: self.window, ratio: self.ratio, band: state.band },
          team,
          organizeCount,
          execution,
          compaction,
          continue: choice === undefined ? undefined : { needed: choice.needed, band: choice.band, organizeCount: choice.organizeCount, recommendation: choice.recommendation, reason: choice.reason, preset: choice.preset },
          advice,
          budget,
          diagnostics,
        };
        report.text = formatStatus({ ...report, thresholds: currentThresholds() });
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
          operation: routerMode === true
            ? { type: 'string', enum: ['continue', 'compress', 'handoff'], description: 'Recommended operation (long mode: continue / compress / handoff).' }
            : { type: 'string', enum: ['compress', 'continue', 'handoff', 'compress-then-handoff'], description: 'Recommended operation.' },
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
        // v0.3.4：长模式（Relay · 超长任务）只有 3 个操作档——经典模式的「压缩→新会话」已移除；
        // 收到该档直接拒绝（先于任何 updatePanelState/副作用）；classic 仍接受四档（schema enum 不变）。
        if (routerMode === true && operation === 'compress-then-handoff') {
          return fail('invalid-operation', 'compress-then-handoff is not available in Relay · 超长任务 mode; use compress or handoff (classic-only preset).', { summary: 'refused: compress-then-handoff is classic-only; in Relay · 超长任务 mode use compress or handoff.' });
        }
        if (!PANEL_OPERATIONS.includes(operation)) {
          return fail('invalid-operation', 'operation must be one of ' + PANEL_OPERATIONS.join('|'), { summary: 'refused: operation must be one of ' + PANEL_OPERATIONS.join('|') + '.' });
        }
        const reason = String(args?.reason ?? '').trim().slice(0, 120);
        const at = Date.now();
        // 只写推荐三字段：绝不写 defaultOperation/autoDecision/授权字段（推荐不产生决策/豁免）。
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
      description: 'Declare/switch phase (discover..ship). discover/decide need exit_criteria; every switch needs contract_check; warn band needs budget_plan (fit: proceed|split|relay). ship needs verify + user_gate (fresh-context review + report). Over budget follows composer panel mode; see protocol. next_operation records autoChoose.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['phase'],
        properties: {
          phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship'] },
          next_operation: { type: 'string', enum: ['compress', 'handoff', 'auto'], description: 'autoChoose: record next op (compress|handoff); auto clears.' },
          goal: { type: 'string', description: 'One-line goal.' },
          exit_criteria: { type: 'string', description: 'Done criterion.' },
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
            description: 'Self-check; required on every phase switch.',
            properties: {
              requirement: { type: 'string', description: '契约1a 需求已定（无歧义、边界确定）' },
              fidelity: { type: 'string', description: '契约1b 实现忠实（无偏移/劣化/偷懒/缺失）' },
              attention: { type: 'string', description: '契约2 注意力（不打扰写「不打扰」）' },
            },
          },
          user_gate: {
            type: 'object', additionalProperties: false, required: ['review', 'report'],
            description: 'Lead verify->ship: independent fresh-context review + plain report (human judges).',
            properties: {
              review: { type: 'string', description: '独立审查（新会话/新队友/新子智能体）：审查者身份 + 需求是否已定/边界 + 偏移/劣化/偷懒/缺失发现' },
              report: { type: 'string', description: '大白话汇报：需求→实现+证据→审查结论→边界/取舍/没做到' },
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
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args, exec) {
        const caller = exec?.agent;
        if (caller === undefined) throw new Error('relay_phase requires a calling agent');
        const session = caller.session;
        const projected = relayStateOf(ctx, session);
        const previous = derivePhase(session, projected);
        const phase = normalizePhase(args?.phase);
        const thresholds = currentThresholds();
        const state = bandFor(pressureOf(ctx, session), thresholds);
        const overBudget = state.band === 'organize' || state.band === 'relay';
        const crossing = phase !== previous;
        // discover/decide 必须写可验收的完成口径（审计缺口：exit_criteria 原本可选，验收标准无真源）。
        if ((phase === 'discover' || phase === 'decide') && (typeof args?.exit_criteria !== 'string' || args.exit_criteria.trim() === '')) {
          throw new Error('relay_phase refused: phase "' + phase + '" requires exit_criteria（可验收的完成口径）——写清「谁 / 拿什么 / 怎么判」，例如 exit_criteria="两份报告落盘且含证据链接，doc_lint 通过"。build/verify/ship 不强制。');
        }

        // 用户门（契约 1）：ship 是唯一的验收声明——只能从 verify 进；Lead 必须带「独立审查 + 大白话汇报」的 user_gate
        // （review：新会话/新队友/新子智能体做的独立审查——需求是否已定 + 实现是否忠实，偏移/劣化/偷懒/缺失；report：汇报给用户）。
        // 2026-11-01 用户口径：不靠机械——实现者自查有盲区，审查必须交给新上下文；宿主只强制「写了没有」，内容对不对由用户判断；不弹审批弹窗。
        let userGate;
        if (crossing && phase === 'ship') {
          // 验收声明只能由 Lead 做：队友/子智能体即便从 verify 进也不许 ship（2026-11-01 审查修复）。
          if (isTeammateSession(ctx, caller)) {
            throw new Error('relay_phase refused (lead-only): 队友/子智能体不做验收声明——ship 是 Lead 的事；把结论/边界/未决项回执 Lead，由 Lead 做新上下文独立审查并向用户汇报。');
          }
          if (previous !== 'verify') throw new Error('relay_phase refused: 进 ship 只能从 verify 来——先声明 verify 做验收（独立审查：需求是否已定 / 实现是否忠实），再带 user_gate 进 ship；跳过验收不算完成。');
          const checked = checkUserGate(args?.user_gate);
          userGate = { review: 'done', questions: checked.questions.length };
        }
        // 契约自检（2026-11-01 审查 P2）：跨 phase 必须先校验 contract_check，再落 next_operation 等
        // 任何面板写入——拒绝路径不得有副作用（SPEC G-6：缺/空 → throw（不切换、不写盘））。
        // 队友跨 phase 走 escalation（仅超预算时由下方 escalation 抛错；预算内切换同样必须自检）。
        if (crossing && !(overBudget && isTeammateSession(ctx, caller))) checkContractCheck(args?.contract_check);
        // 开 phase 前预算可行性闸门（2026-11-01 用户口径：phase 优先 + 先估计再开 phase）。
        // 仅 warn 档强制（ok 档 headroom→organize >5% 窗口；organize/relay 档由下方面板闸门接管）。
        // 拒绝路径零副作用：不写 autoDecision、不改模式、不切 phase、不写 lessons。
        const budgetMemoryBefore = phaseBudgetMemory(session);
        const crossBudget = crossing ? phaseBudget(pressureOf(ctx, session), thresholds) : undefined;
        const lastPhaseCostTokens = crossing && budgetMemoryBefore !== undefined
          && Number.isFinite(budgetMemoryBefore.used) && state.used !== undefined
          ? Math.max(0, state.used - budgetMemoryBefore.used)
          : undefined;
        let budgetReport;
        let budgetReminder;
        // phase 完成时复查（所有档）：跨 phase 响应都带 budget 事实（上一 phase 实测消耗 + headroom）；
        // warn 档额外要求 budget_plan 并回估计/动作。ok 档不强制（headroom→organize >5% 窗口）。
        if (crossing) {
          budgetReport = {
            band: state.band,
            headroomToWarn: crossBudget.headroomToWarn,
            headroomToOrganize: crossBudget.headroomToOrganize,
            headroomToRelay: crossBudget.headroomToRelay,
            ...(lastPhaseCostTokens === undefined ? {} : { lastPhaseCostTokens }),
          };
        }
        if (crossing && state.band === 'warn') {
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
        const phaseHint = crossing ? PHASE_HINTS[phase] : undefined;
        // 模型自决（v3）：记录/清除「下一次操作」。写入在 phase 合法性/exit_criteria/契约自检
        // （以及 warn 档 budget_plan）校验之后、超预算面板闸门之前——拒绝路径不写盘；同一 phase 也可调用。
        const requested = args?.next_operation;
        const nextOperation = requested === 'compress' || requested === 'handoff' || requested === 'auto' ? requested : undefined;
        let decisionIgnored;
        if (nextOperation === 'compress' || nextOperation === 'handoff') {
          const updated = updatePanelState(session.id, { autoDecision: { operation: nextOperation, at: Date.now() } }, { source: 'agent' });
          // autoChoose=off 时归一化丢弃自决（面板保持未决「自动」）→ 报告被忽略。
          if (updated.autoDecision === null) decisionIgnored = 'autoChoose=off：模型自决只在 autoChoose=on 时保留';
        } else if (nextOperation === 'auto') {
          updatePanelState(session.id, { autoDecision: null }, { source: 'agent' });
        }
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
            if (typeof caller.inject === 'function') caller.inject(noticeMessage(phaseBoundaryText(previous, phase, state, panel, action, routerMode), phaseBoundarySummary(state)));
          } catch { /* notice 注入失败不阻断 */ }
        };
        // 队友会话：不读面板模式、不要求问人类——到线一律向上一级请示压缩/交接，先做完当前 phase。
        if (crossing && overBudget && isTeammateSession(ctx, caller)) {
          const escalation = await escalateToLead(ctx, caller, state, phase, projected);
          publish(previous);
          throw new Error('relay_phase refused (teammate session, band=' + state.band + '): 队友会话不自行切 phase、不读面板模式、不问人类——' + escalationHint(escalation) + '本会话继续/压缩/收尾交接由 Lead 决定；先做完当前 phase 并把结论/未决项回执 Lead，等 Lead 决定后再继续。');
        }
        let reminder;
        let operation;
        let panel;
        /** relay-long 隐藏档归一：命中时记档名（'compress-then-handoff' | 'autoChoose' | undefined）。 */
        let longHidden;
        if (crossing && overBudget) {
          // phase 边界闸门：只按 composer 面板状态处理，不调用官方审批。
          panel = panelStateOf(session.id);
          operation = panel.defaultOperation;
          // relay-long（routerMode=true）只有 3 个操作档（继续/压缩继续/接力新会话；表盘另含「问我」）：
          // v0.3.4 起「压缩→新会话」已从长模式移除（不再两段式），存量预设按「继续」放行并清空；
          // 「自动（autoChoose）」仍是长模式隐藏档，同样按「继续」放行，autoChoose 持久开关不动。
          // classic（routerMode≠true）行为完全不变（含两段式）。
          longHidden = routerMode === true
            ? (operation === 'compress-then-handoff' ? 'compress-then-handoff' : panel.autoChoose === true ? 'autoChoose' : undefined)
            : undefined;
          if (operation === 'continue' || longHidden !== undefined) {
            // 契约自检已在 crossing 前置统一校验（2026-11-01 审查 P2：拒绝路径不写盘）。
            // v0.4.0：模式持久不消费——「继续」放行后模式保持；只有长模式存量非法档位（压缩→新会话）才归一清空。
            if (longHidden === 'compress-then-handoff') {
              updatePanelState(session.id, { defaultOperation: null }, { source: 'agent' });
              reminder = '长模式已移除该档：存量预设按继续处理并清空（长模式没有「压缩→新会话」），已放行本次 phase 切换（不压缩不接力）；要压缩/接力请在 chip 的 4 项里显式选择（问我/继续/压缩继续/接力新会话）。';
            } else if (longHidden === 'autoChoose') {
              reminder = '长模式已隐藏「自动（模型决定）」档：按「继续」处理，已放行本次 phase 切换（不压缩不接力），autoChoose 开关不动；要压缩/接力请在 chip 的 4 项里显式选择（问我/继续/压缩继续/接力新会话）。';
            } else {
              reminder = '按面板模式「继续」：已放行本次 phase 切换（不压缩不接力）；模式保持（不消费），下一个到线仍按「继续」处理。';
            }
          } else if (operation === 'compress') {
            // rev5.5 正交模型：模式只决定「做什么」，不再自带免审——执行时仍按授权规则（可能弹一次）。
            // v0.4.0：模式持久，relay_phase 拒绝路径不改模式。
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 按面板模式「压缩继续」先整理再切 phase——调用 relay_organize({phase:"' + previous + '", brief:"<本 phase 结论与证据指针>"})，成功后再重试 relay_phase({phase:"' + phase + '"}). 模式保持（不消费）；压缩执行仍会过一次官方授权（autoCompress/授权下一次操作 才免问）。');
          } else if (operation === 'handoff') {
            // v0.4.0：模式持久，接力成功后由新会话继承（失败/审批拒绝不改模式）。
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 按面板模式「接力新会话」先收尾再开新会话——调用 relay_handoff({human_approved:true, status:{phase:"' + previous + '", ...}})；模式保持（不消费；接力成功后新会话继承该模式）；接力执行仍会过一次官方授权（autoHandoff/授权下一次操作 才免问）。');
          } else if (operation === 'compress-then-handoff') {
            // 两段式：organizeCount=0 → 第 1 段先压缩（模式保持，下一次到线走第 2 段）；
            // 已成功压缩过 → 第 2 段抛错指令接力（模式保持，接力成功后新会话继承）。两段执行都按正交授权规则（可能各弹一次）。
            if (deriveOrganizeCount(session, projected) < 1) {
              publish(previous);
              throw new Error('relay_phase refused (band=' + state.band + '): 按面板模式「压缩→新会话」第 1/2 步——先调 relay_organize({phase:"' + previous + '", brief:"<本 phase 结论与证据指针>"})；压缩成功后留在本会话继续（重试 relay_phase({phase:"' + phase + '"}）），不要立即 relay_handoff；第 2 步只在下一次到线执行。模式保持（下一次到线执行第 2 步接力）；压缩执行仍过一次官方授权（autoCompress/授权下一次操作 免问）。');
            }
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 按面板模式「压缩→新会话」第 2/2 步（本会话已压缩过）——调 relay_handoff({human_approved:true, status:{phase:"' + previous + '", ...}})；模式保持（接力成功后新会话继承该模式）；接力执行仍过一次官方授权（autoHandoff/授权下一次操作 免问）。');
          } else if (panel.autoChoose === true) {
            // v3：优先用模型经 relay_phase({next_operation}) 记录的决定；无决定才退回推荐（不把推荐写成决定）。
            const decided = panel.autoDecision === undefined || panel.autoDecision === null ? undefined : panel.autoDecision.operation;
            const recommended = decided ?? (deriveOrganizeCount(session, projected) < 1 ? 'compress' : 'handoff');
            const action = recommended === 'compress' ? '压缩继续' : '接力新会话';
            const basis = decided === undefined ? '按推荐' : '按已记录的操作';
            // 模型自决档：未记录时提示先记录（title/popover 才显示具体操作），不把推荐当成已决。
            const recordHint = decided === undefined
              ? '（当前未记录——先用 relay_phase({phase:"' + previous + '", next_operation:"' + recommended + '"}）记录模型自决，title/popover 才会显示具体操作「压缩/新会话」）'
              : '';
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): autoChoose=on（模型自决档），' + basis + '自动选「' + action + '」' + recordHint + '——' + (recommended === 'compress' ? '调用 relay_organize({phase:"' + previous + '", brief:...})，成功后重试 relay_phase' : '调用 relay_handoff({human_approved:true, ...})') + (recommended === 'compress' ? '；压缩是否需官方审批由面板 autoCompress/authorizeNext 决定。' : '；接力是否需官方审批由面板 autoHandoff/authorizeNext 决定。'));
          } else {
            publish(previous);
            throw new Error('relay_phase refused (band=' + state.band + '): 已超预算，开新 phase 须由人类选择继续方式（压缩继续 / 接力新会话 / 继续）——先问人类（一次问清、附推荐与默认），或让人类在 composer 面板「接力」chip 选模式/自动授权；人类明确后再调对应工具或重试 relay_phase。');
          }
        }
        if (budgetReminder !== undefined) reminder = budgetReminder;
        // 契约自检（预算内切 phase）已在上方 crossing 前置统一校验（拒绝路径不写盘）。
        // 经验存档（ACE 式演化手册）：声明 phase 时顺带记录本 phase 的可复用做法；只有这里写盘（拒绝路径不写）。
        // 回灌只在跨 phase（crossing）时发生：同 phase 记录 next_operation 的调用不重复注入 ≤1KB 的历史经验（v0.2.17 A6）。
        // 读/写都受 lessons.js 的容量与去重约束；recordLessons 每次成功的 phase 调用都可以写。
        const lessonsCwd = cwdOf(session);
        let lessonsReport;
        if (typeof lessonsCwd === 'string' && lessonsCwd !== '') {
          const recorded = Array.isArray(args?.lessons) ? recordLessons(lessonsCwd, args.lessons) : undefined;
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
        PHASE_MEMORY.set(session.id, { seq: session.seq, phase });
        capMap(PHASE_MEMORY);
        // phase 预算实测（成功声明/切换后才写）：本 phase 起点 used + 上一 phase 实测消耗（warn 档 estimate_tokens 缺省值）。
        recordPhaseBudget(session, crossing
          ? { phase, used: state.used, previous, ...(lastPhaseCostTokens === undefined ? {} : { previousCostTokens: lastPhaseCostTokens }) }
          : budgetMemoryBefore ?? { phase, used: state.used });
        // v0.3.3：成功切 phase = 本次到线的模型推荐已过期，清空推荐三字段（只展示，不参与决策）。
        if (crossing) updatePanelState(session.id, { recommendedOperation: null, recommendedReason: '', recommendedAt: null }, { source: 'agent' });
        if (crossing && overBudget) {
          // 模式持久：边界提醒里的面板状态就是当前模式（不再有消费后的「问我」）。
          injectBoundary(panelStateOf(session.id), longHidden === 'compress-then-handoff'
            ? '长模式已移除该档：存量预设按继续放行本次切换并清空（长模式没有「压缩→新会话」）；phase 完成后仍超线，注意下一次继续方式。'
            : longHidden === 'autoChoose'
              ? '长模式隐藏档「自动（模型决定）」按「继续」放行本次切换（autoChoose 开关不动）；phase 完成后仍超线，注意下一次继续方式。'
              : '按面板模式「继续」放行本次切换（模式保持）；phase 完成后仍超线，注意下一次继续方式。');
        }
        publish(phase);
        return lossless({
          phase,
          previous,
          ...(overBudget ? { band: state.band } : {}),
          ...(budgetReport === undefined ? {} : { budget: budgetReport }),
          ...(userGate === undefined ? {} : { user_gate: userGate }),
          ...(phaseHint === undefined ? {} : { hint: phaseHint }),
          ...(reminder === undefined ? {} : { reminder }),
          ...(lessonsReport === undefined ? {} : { lessons: lessonsReport }),
          ...(nextOperation === undefined ? {} : { next_operation: nextOperation }),
          ...(decisionIgnored === undefined ? {} : { next_operation_ignored: true }),
          goal: args?.goal,
          exit_criteria: args?.exit_criteria,
          summary: 'phase → ' + phase + ' (was ' + previous + ')' + (operation === 'continue' || longHidden !== undefined ? '；面板模式=继续（' + (longHidden === undefined ? '保持' : '隐藏档归一') + '）' : '')
            + (nextOperation === undefined ? '' : '；本次记录操作=' + nextOperation + (decisionIgnored === undefined ? '' : '（被忽略：' + decisionIgnored + '）')),
        });
      },
    },
    {
      name: TOOL_PREFIX + 'organize',
      description: 'Phase-boundary compression: write the phase brief and run one controlled compaction. Refused below threshold or on a second compression unless force=true or the composer panel mode is 压缩继续 (compress). Approval: autoCompress/authorizeNext only — a mode selection does not grant an approval exemption (see protocol).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['phase'],
        properties: {
          phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship'] },
          brief: { type: 'string', description: 'Decisions + evidence pointers (short markdown).' },
          key_docs: { type: 'array', items: { type: 'string' }, description: 'Docs to open first (<=8).' },
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
          const brief = buildPhaseBrief({ phase, goal: phaseMeta.goal, exitCriteria: phaseMeta.exit_criteria, decisions: args?.brief === undefined ? [] : String(args.brief).split(/\n+/), constraints: [], evidence: [lint.evidence], keyDocs: args?.key_docs, next: [] });
          let briefPath;
          try {
            briefPath = writeWorkspaceFile(cwd, 'phase-' + phase + '-' + Date.now() + '.md', brief);
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
          if (organized) {
            try {
              chainInfo = appendChainEntry(cwd, {
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
              appendFileSync(briefPath, '\n' + recallSection + '\n', 'utf8');
            } catch (error) {
              logWarn(ctx, '[organize] chain index failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error));
            }
          }
          // M2-G：搬到「压缩成功且真压了」之后。inject 是 next-step inbox——下一 step 才作为
          // user/message 落盘，因此无论压缩前调用还是压缩后调用，在 surface 上都是压缩完成后可见；
          // 失败/busy/无可压缩历史不注入，busy 重试也不会叠加重复 notice。
          let briefInjected = false;
          if (result !== null && result !== undefined && injectBrief && typeof caller.inject === 'function') {
            try {
              const header = '[context-relay] phase brief · ' + phase + '（压缩后注入，非用户发言）\n以下关键结论在压缩后继续以此为准：\n';
              // P3-8：brief 超长时静默 slice 会先丢尾部的证据指针/关键文档（恰是压缩后最需要的
              // 可恢复引用）——超限时在尾部标注截断并给出完整文件路径，不静默。
              const recallTail = recallSection === '' ? '' : '\n\n' + recallSection;
              const maxChars = 4000;
              const truncation = '\n\n[brief truncated: 完整内容见 ' + briefPath + ']';
              // P2-1（2026-11-03 审查）：召回段是压缩后唯一的可恢复入口，不能被尾部截断切掉——
              // 超限时先截 brief 正文（指向完整文件），保住末尾的「压缩与链式召回」段。
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
                autoDecision: null,
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
    handoffWithTwoStageGate(runtime),
  ];
}

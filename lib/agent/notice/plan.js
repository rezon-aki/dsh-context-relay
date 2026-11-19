/**
 * dsh-context-relay — notice 规划层（v0.10 C4）：纯函数 planNotices(facts)。
 *
 * 每步采集到的事实（facts）→ 本步 notice 计划（0/1 条、正文 ≤900 字符）+ 状态变更意图：
 * - track：无论是否投递都生效的状态（回退档位跟踪、容量重新武装/清空、面板签名基线）；
 * - claims：**投递成功后**才写入的去重键（到线档位、容量 used、面板签名、台账行级键）；
 * - notice：本步唯一一条 notice（kind=phase|capacity|panel|ledger|unavailable|plane）。
 * 纯函数：只读 facts、不改任何模块状态、不注入、不抛错（坏事实按空降级）。
 *
 * @module dsh-context-relay/agent/notice/plan
 */
import { operationLabel } from '../panel-gate.js';
import { PENDING_BANDS, teamPendingText } from '../team-context.js';
import { phaseFocusLine, phaseLine as ledgerPhaseLine } from '../work-items.js';
import { PANEL_OPERATIONS, contextCheckChoice, operationLongLabelOf } from '../../policy.js';
import { bandLabelOf, phaseLabelOf, renderFourPart, scrubUserText } from '../../output.js';

/** 每步 notice 字符上限（与台账批次上限同口径）。 */
export const NOTICE_MAX = 900;
/** 台账批次字符上限（P1）：超限先丢 [队友]、再丢 [上下文]；不截断正文、不丢焦点/闭环/派活。 */
const LEDGER_BATCH_MAX = 900;
/** P2：压缩生效判定——used 较上次容量 notice 时下降 ≥15% 即重新武装（即便 ratio 仍 ≥capacityThreshold 仍 atRisk）。 */
const CAPACITY_REARM_DROP_RATIO = 0.15;
/** 哨兵档位排序（到线提醒去重/升级判定）；unavailable = 显式降级档（D-04），与 ok 同秩不升线。 */
export const SENTINEL_RANK = { ok: 0, unavailable: 0, warn: 1, organize: 2, relay: 3 };

/** 容量保全 notice 正文（上升沿注入一次；与到线提醒同 step 触发时合并为一条）。
 * P0-D：这是「最坏兜底」，不是常规路径；只提醒，不自动压缩/接力。 */
export function capacityNoticeText(capacity, panel) {
  const pct = (ratio) => (ratio === undefined ? '?' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%');
  return renderFourPart({
    conclusion: '容量保全（最坏兜底，独立配置）：上下文已逼近硬窗口 ' + pct(capacity?.ratio) + '（容量线 ' + pct(capacity?.threshold) + '）。',
    impact: '继续增长可能被宿主强制压缩或截断；这是阶段中段的唯一例外；不自动执行（不自动压缩/不自动接力）。',
    action: '先看当前档位与余量；立即收尾当前动作：停止开新活/不派新任务；先写交接、进度与工作台账收口，再由人类授权压缩继续或接力新会话（面板模式=' + panelModeTextOf(panel) + '）。',
    evidence: ['面板「接力」chip 的实时用量'],
  });
}

/** P1-A（v0.11）：宿主自动压缩兜底 notice 正文（最多一次/compactionSeq；失败也如实告知、不阻断）。 */
export function recoveryNoticeText(fallback) {
  const path = typeof fallback?.path === 'string' && fallback.path !== '' ? fallback.path : undefined;
  const error = scrubUserText(typeof fallback?.error === 'string' && fallback.error !== '' ? fallback.error.slice(0, 120) : 'IO 错误');
  return renderFourPart({
    conclusion: '宿主自动压缩已发生（插件未主持，无法生成完整交接摘要）。',
    impact: fallback?.writeFailed === true
      ? '最小恢复快照写入失败（' + error + '）——请以进度记录/工作台账为准；旧上下文已遮蔽。'
      : '已写最小恢复快照 ' + (path ?? '?') + '；旧上下文已遮蔽。',
    action: '关键结论用会话回读（session_event_read）复核；此后到阶段边界主动压缩继续，避免再次被动压缩。',
    evidence: [fallback?.writeFailed === true ? '恢复快照写入失败（原因见结构化结果）' : '恢复快照：' + (path ?? '见结构化结果')],
  });
}

/** 推荐动作标签：contextCheckChoice 用 organize（策略动作），面板标签用 compress；统一在此映射。 */
function operationTextOf(operation) {
  return operation === 'organize' ? '压缩继续' : operationLongLabelOf(operation);
}

/** 面板模式文案（未设 = 问我）；与 policy 的档位标签同源。 */
function panelModeTextOf(panel) {
  const operation = PANEL_OPERATIONS.includes(panel?.defaultOperation) ? panel.defaultOperation : null;
  return operation === null ? '问我' : operationLongLabelOf(operation);
}

/** P0-D：到线/自查共用动作菜单。起点四选一；warn 起三选一（不再把「继续」当推荐）。 */
function contextCheckMenuOf(tone) {
  return tone === 'preventive'
    ? '四选一：①继续（无需操作）②压缩继续（同一会话）③清空复用（让空闲队友重置后接新任务）④交接新会话（开新会话继续）'
    : '三选一：①压缩继续（同一会话）②清空复用（让空闲队友重置后接新任务）③交接新会话（开新会话继续）';
}

/** 面板状态的人话行（原始开关名只留在结构化结果/日志）。 */
function panelHumanLineOf(panel) {
  if (panel === undefined || panel === null) return '';
  const onOff = (value) => (value === true ? '开' : '关');
  const recommended = panel.recommendedOperation === undefined || panel.recommendedOperation === null
    ? ''
    : ' · 模型推荐=' + operationLongLabelOf(panel.recommendedOperation)
      + (String(panel.recommendedReason ?? '').trim() === '' ? '' : '(' + String(panel.recommendedReason).trim().slice(0, 60) + ')');
  return '面板模式=' + panelModeTextOf(panel)
    + ' · 压缩免审批=' + onOff(panel.autoCompress)
    + ' · 交接免审批=' + onOff(panel.autoHandoff)
    + ' · 下一次操作授权=' + onOff(panel.authorizeNext)
    + recommended;
}

/**
 * 到线提醒正文（P0-D 四档语义）：warn=现在就该动手；organize/relay=兜底告警；capacity=最坏兜底。
 * 正文固定四段（§2.4）；band= 等机器标记只进 summary（冷启动 seed / 持久派生靠它）。
 * subagent 队友：向上一级请示压缩/交接（能自动发消息就代发），不自行 relay/问人。
 * M-12：队友稿恒不带台账行（工具面没有 relay_work_items，也不该看到 Lead 的台账计数）。
 */
export function sentinelText(phase, state, subagent = false, panel, escalation, ledger, recommendation, organizeCount = 0) {
  const band = state.band;
  const ratioText = state.ratio === undefined
    ? (state.used === undefined ? '用量未知' : String(state.used) + ' tokens')
    : (Math.round(state.ratio * 1000) / 10).toFixed(1) + '%';
  const phaseText = '阶段「' + phaseLabelOf(phase) + '」';
  if (subagent) {
    // M-12：队友工具面没有 relay_work_items，也不该看到 Lead 的台账计数——队友稿不带台账行。
    if (band === 'warn') {
      return renderFourPart({
        conclusion: '队友会话·到线提醒：上下文 ' + ratioText + '（' + bandLabelOf(band) + '）。',
        impact: '本任务还能继续做完；再涨会进入需要上一级（Lead）决策的兜底档。',
        action: '继续做完当前任务；任务/阶段边界先写工作记录（checkpoint）；需要减压时由 Lead 决定，不自行压缩/交接，也不询问用户。',
        evidence: ['上下文计量（见面板）'],
      });
    }
    return renderFourPart({
      conclusion: '队友会话·到线请示：上下文 ' + ratioText + '（' + bandLabelOf(band) + '）。',
      impact: '本会话继续/压缩/收尾交接由上一级（Lead）决定；等答复期间继续做完当前阶段。',
      action: escalationHint(escalation) + '；到任务/阶段边界先写工作记录（checkpoint）；不自行压缩/交接、不向人类提问；决定后把结论与未决项回执 Lead。',
      evidence: ['上下文计量（见面板）'],
    });
  }
  // 工作台账（契约 §5）：Lead 非空 pending>0 时并入影响段；空台账/未传 → 不追加。
  const ledgerPhase = ledger !== undefined && ledger !== null ? ledgerPhaseLine(ledger) : '';
  const ledgerImpact = ledger !== undefined && ledger !== null && ledger.counts !== undefined && ledger.counts.pending > 0
    ? '工作台账：未闭合 ' + ledger.counts.pending + ' / 共 ' + ledger.counts.total
      + (ledgerPhase === '' ? '' : ' · ' + ledgerPhase)
      + '（阶段边界前收口）'
    : '';
  const recommendationOfBand = recommendation ?? contextCheckChoice({ band: state.band, organizeCount, panel });
  const tone = recommendationOfBand.tone ?? 'preventive';
  const conclusion = tone === 'now'
    ? '到线提醒（插件 notice，非用户发言）：上下文 ' + ratioText + '，现在就该动手管理，不要等到兜底。'
    : tone === 'last-resort'
      ? '到线提醒（插件 notice，非用户发言）：容量最坏兜底——立即收尾（不自动执行）。'
      : tone === 'fallback' && band === 'relay'
        ? '到线提醒（插件 notice，非用户发言）：兜底告警升级——已超预期，本应已在 warn/organize 前处理。'
        : tone === 'fallback'
          ? '到线提醒（插件 notice，非用户发言）：兜底告警——本应已在 warn 30% 前处理。'
          : '到线提醒（插件 notice，非用户发言）· ' + phaseText + '：上下文 ' + ratioText + '。';
  const impact = tone === 'last-resort'
    ? '继续增长可能被强制压缩或截断；不自动执行任何动作。' + (ledgerImpact === '' ? '' : '；' + ledgerImpact)
    : '再涨会进入压缩/接力兜底档；本阶段可继续做完，但下一个阶段边界前要处理。' + (ledgerImpact === '' ? '' : '；' + ledgerImpact);
  const panelLine = panelHumanLineOf(panel);
  return renderFourPart({
    conclusion,
    impact,
    action: contextCheckMenuOf(tone)
      + '；推荐：' + operationTextOf(recommendationOfBand.operation) + '（理由：' + scrubUserText(recommendationOfBand.reason) + '）。'
      + '先看当前档位与余量，再执行推荐动作'
      + (band === 'organize' || band === 'relay' ? '。文档体检由插件自动跑（结果并入交接摘要）' : '')
      + (panelLine === '' ? '' : '。' + panelLine),
    evidence: ['面板「接力」chip 的实时用量'],
  });
}

/** 起点/新任务自查正文（P0-D 主路径入口）：与到线提醒共用推荐纯函数与工具路径。 */
export function contextCheckText(fact) {
  const recommendation = fact?.recommendation ?? contextCheckChoice({ band: fact?.band });
  const tone = recommendation.tone ?? 'preventive';
  const trigger = contextTriggerLineOf(fact);
  const threshold = fact?.capacity?.threshold;
  const thresholdText = threshold === undefined ? '' : ' ' + (Math.round(threshold * 1000) / 10).toFixed(1) + '%';
  const conclusion = tone === 'last-resort'
    ? '容量保全线' + thresholdText + '（最坏兜底，独立配置，非用户发言）：已到最后防线，立即收尾当前动作、停止开新活/派活。'
    : tone === 'fallback' && fact?.band === 'relay'
      ? '到线提醒（兜底告警升级，非用户发言）：已超预期，本应已在 warn/organize 前处理；立即收尾并在最近边界交接。'
      : tone === 'fallback'
        ? '到线提醒（兜底告警，非用户发言）：本应已在 warn 30% 前处理，现已进入兜底档——请在最近阶段边界压缩或交接，并清空复用队员上下文。'
        : tone === 'now'
          ? '到线提醒（插件 notice，非用户发言）：现在就该动手管理上下文，不要等到兜底。'
          : '上下文自查（主路径自查，非用户发言）：' + trigger + '。';
  const impact = tone === 'last-resort'
    ? '继续增长可能被强制压缩或截断；不自动执行（不自动压缩/不自动接力）。'
    : '本阶段可继续做完；再涨会进入兜底档，处理成本更高。';
  return renderFourPart({
    conclusion,
    impact,
    action: '先看当前档位与余量，预估本任务/阶段能否在阈值前完成；'
      + contextCheckMenuOf(tone)
      + '；推荐：' + operationTextOf(recommendation.operation) + '（理由：' + scrubUserText(recommendation.reason) + '）。'
      + '面板模式=' + panelModeTextOf(fact?.panel),
    evidence: ['面板「接力」chip 的实时用量', trigger],
  });
}

/** 起点触发器单行（phase / 新任务信号；二者合并时用 · 连接）。 */
function contextTriggerLineOf(fact) {
  const parts = [];
  if (fact?.phase !== undefined && fact.phase !== null) {
    const newTask = fact.phase.from === 'ship' && fact.phase.to === 'discover';
    parts.push((newTask ? '新任务开始' : '新阶段开始') + '「' + phaseLabelOf(fact.phase.from) + ' → ' + phaseLabelOf(fact.phase.to) + '」');
  }
  if (fact?.task !== undefined && fact.task !== null) {
    const kind = fact.task.kind;
    const label = kind === 'goal' ? '目标' : kind === 'task-board' ? '任务板' : kind === 'user-after-ship' ? '交付后首条用户消息' : String(kind ?? '任务');
    parts.push((fact.phase?.from === 'ship' && fact.phase?.to === 'discover' ? '任务信号' : '新任务开始') + '（' + label + '）');
  }
  return parts.length > 0 ? parts.join(' · ') : '上下文自查';
}

/** notice 的 summary（≤120 字符；UI 单行展示，同样按身份分支）。 */
export function sentinelSummary(state, phase, subagent) {
  return '[context-relay] band=' + state.band + ' · phase=' + phase + ' · ' + (subagent ? '队友会话到线请示（非用户发言）' : 'relay 到线提醒（非用户发言）');
}

/** 队友到线请示正文（自动发给 Team Lead；自包含、≤400 字）。 */
export function escalationText(name, state, phase) {
  const pct = state.ratio === undefined ? '?' : Math.round(state.ratio * 1000) / 10 + '%';
  return '[context-relay] 队友到线请示（自动）：' + String(name) + ' band=' + state.band + '（' + pct + '）· phase=' + phase
    + '。请决定：① 收尾继续（不压缩、不开新 phase）；② 由你接力（你调 relay_handoff）；③ 收尾改派。relay_organize/relay_handoff 都是 Lead-only，它在答复前继续当前 phase，不自行 relay、不问人类。';
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

/** [上下文] 行（rank>0 即 warn 以上才渲染；档位用中文标签，不贴 band=）。
 * ok / unavailable 不渲染：指标不可用由 M-14 的 unavailable notice 表达，不混进台账行（D-04）。 */
export function bandLineOf(state, panel) {
  if (state === undefined || state === null) return '';
  const rank = SENTINEL_RANK[state.band] ?? 0;
  if (rank === 0) return '';
  return '[上下文] 档位=' + state.band + (rank >= 2 ? '（' + boundaryActionOf(panel) + '）' : '');
}

/** [队友] 行（teamPendingText 非空才渲染；文本与旧 ledgerContextLine 后半段逐字一致）。 */
export function teamLineOf(teamText) {
  return '[队友] ' + teamText + ' —— phase 边界先处理（relay_team_status 有建议），建议用 relay_phase 的 team_note 记一行结论（只 warning，不拒绝）';
}

/** P1 闭环去重键：未落账签名（tool:target 列表，顺序即发生顺序；PENDING_CLOSURE 已 slice(-3)）。 */
export function closureSigOf(pending) {
  return Array.isArray(pending) && pending.length > 0 ? JSON.stringify(pending.map((entry) => entry.tool + ':' + entry.target)) : '';
}

/** 台账是否有可落账的未闭合分点（open/doing/blocked）：没有台账文件也算「没有」——[闭环] 无处落账。 */
export function ledgerHasUnclosedItems(ledger) {
  if (ledger === null || typeof ledger !== 'object' || ledger.exists !== true) return false;
  const pendingCount = ledger.counts?.pending;
  if (Number.isInteger(pendingCount)) return pendingCount > 0;
  if (!Array.isArray(ledger.items)) return false;
  return ledger.items.some((item) => item?.status !== 'done');
}

/** 闭环提示行（文本与旧批次逐字一致）。 */
export function closureLineOf(pending) {
  const list = pending.map((entry) => entry.tool + (entry.target === '' ? '' : '(' + entry.target + ')')).join(' / ');
  return '[闭环] 上一步改动未落账：' + list + ' —— 更新当前分点的 status/next/evidence（relay_work_items），或说明归到哪条分点；关 phase 前必须落账。';
}

/**
 * P1 队友状态表（D3=A）：待处理名 → 当前 band。仍处于待处理档的 name 保留（handled 不清 = 不是恢复）；
 * row 转 ok/被清除视为恢复 → 删该名（恢复后同档位重入 = 新事件，再提示一次）；pending 名以当前 band 覆盖。
 */
export function teamSeenOf(previous, teamContext) {
  const seen = previous ?? {};
  const rows = Array.isArray(teamContext?.rows) ? teamContext.rows : [];
  const next = {};
  for (const [name, band] of Object.entries(seen)) {
    const row = rows.find((item) => item.name === name);
    if (row !== undefined && PENDING_BANDS.includes(row.band)) next[name] = row.band;
  }
  for (const row of Array.isArray(teamContext?.pending) ? teamContext.pending : []) next[row.name] = row.band;
  return next;
}

/** P1 派活提示签名：sorted(target:band)，集合/档位变化才注入。 */
export function dispatchSigOf(rows) {
  return rows.map((row) => row.target + ':' + row.band).sort().join(',');
}

/** 派活提示正文（最多 3 条 + 余量说明）。 */
export function dispatchText(entries) {
  const lines = entries.slice(0, 3).map((entry) => '[派活·队友上下文] ' + entry.target + ' 档位=' + entry.band
    + (entry.ratio === undefined ? '' : '（' + Math.round(entry.ratio * 1000) / 10 + '%）')
    + ' → ' + entry.action + '；任务已发出，先让它按上面处理再开工，别把新任务做进脏上下文。');
  if (entries.length > 3) lines.push('（另 ' + (entries.length - 3) + ' 个队友同样需要处理）');
  lines.push('未处理的，phase 边界会再提醒一次；建议用 relay_phase 的 team_note 记一行处理结论（只 warning，不拒绝）。');
  return lines.join('\n');
}

/** 批次总字符（按 \n join 计）。 */
function batchLengthOf(rows) {
  return rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.text.length, 0) + rows.length - 1;
}

/** 面板签名（模式 + 三个免审开关）。 */
export function panelSignatureOf(panel) {
  return JSON.stringify([panel?.defaultOperation ?? null, panel?.autoCompress === true, panel?.autoHandoff === true, panel?.authorizeNext === true]);
}

/** 面板变更提醒正文（v0.5.1；四段式，≤300 字符，只给事实，不要求中途动作）。 */
export function panelChangeText(panel) {
  const onOff = (value) => (value === true ? '开' : '关');
  const operation = panel?.defaultOperation;
  return renderFourPart({
    conclusion: '面板已更新（插件 notice，非用户发言）：本阶段继续，阶段边界按新模式执行。',
    impact: '压缩免审批：' + onOff(panel?.autoCompress)
      + '；交接免审批：' + onOff(panel?.autoHandoff)
      + '；下一次操作授权：' + onOff(panel?.authorizeNext)
      + '；架构师：' + onOff(panel?.architect) + '。',
    action: '无需其他操作；阶段边界按「' + operationLongLabelOf(operation) + '」执行。',
    evidence: ['面板「接力」chip 可随时改回'],
  });
}

/** phase 边界提醒（phase 完成仍超线时注入；不带 band= 固定标记，避免污染冷启动 seed）。 */
export function phaseBoundaryText(previous, phase, state, panel, action) {
  const ratioText = state?.ratio === undefined
    ? (state?.used === undefined ? '用量未知' : String(state.used) + ' tokens')
    : (Math.round(state.ratio * 1000) / 10).toFixed(1) + '%';
  const actionText = scrubUserText(action).replace(/[。；]+$/g, '');
  const panelLine = panelHumanLineOf(panel);
  return renderFourPart({
    conclusion: '阶段边界 · ' + phaseLabelOf(previous) + ' → ' + phaseLabelOf(phase)
      + '（本阶段完成时仍超线：上下文 ' + ratioText + '，非用户发言）。',
    impact: '已放行本次切换；' + actionText + '。',
    action: '继续下一阶段；到下一个阶段边界前注意管理上下文' + (panelLine === '' ? '' : '。' + panelLine),
    evidence: ['面板「接力」chip 的实时用量'],
  });
}

export function phaseBoundarySummary(state) {
  return '[context-relay] phase 边界 · band=' + state.band + ' · 完成仍超线（非用户发言）';
}

/** M-14：指标不可用（投影/计量均缺）时的一次性保守提示——不静默当 ok（bandFor 显式返回 band=unavailable，D-04）。 */
export function unavailableNoticeText() {
  return renderFourPart({
    conclusion: '上下文指标不可用（插件 notice，非用户发言）：投影/计量都没有提供用量，档位无法判定——不当作 ok。',
    impact: '可能已超预算而不可知，继续增长有被动压缩风险。',
    action: '开新阶段前人工确认上下文余量（或恢复投影接入）；本阶段照常推进。此提示每段一次，压缩后重新提示。',
    evidence: ['面板「接力」chip 与投影状态'],
  });
}

/**
 * C15/设计 §5：平面降级事实（planeStatusOf 输出）→ 每压缩周期一次的 notice 计划。
 * installed=false 或 degradations 非空才提示；返回 {sig, text}（sig 作 guard 键），健康返回 null。
 * 文案第一行给指针（截断时仍可见），随后列 seam 名与原因；degradations 已由 degradationsOf 按 seam 去重。
 */
export function planeIssueOf(plane) {
  if (plane === null || typeof plane !== 'object') return null;
  const degradations = Array.isArray(plane.degradations) ? plane.degradations : [];
  const installed = plane.installed === true;
  if (installed && degradations.length === 0) return null;
  const role = String(plane.role ?? 'unknown');
  const lines = [];
  if (!installed) lines.push('- 平面未装好（role=' + role + '）：工具裁剪 / 影子协议段可能未生效');
  for (const entry of degradations.slice(0, 6)) {
    lines.push('- seam ' + String(entry?.seam ?? '?') + '（' + String(entry?.level ?? 'degraded') + '）：' + String(entry?.reason ?? ''));
  }
  if (degradations.length > 6) lines.push('- 另 ' + (degradations.length - 6) + ' 条 seam 降级（见 relay_status.plane.degradations）');
  return {
    sig: JSON.stringify([role, installed, degradations.map((entry) => [entry?.seam, entry?.level, entry?.reason])]),
    text: renderFourPart({
      conclusion: '平面/seam 降级（插件 notice，非用户发言）：依赖这些 seam 的 relay 能力正在降级。',
      impact: '工具裁剪 / 影子协议段可能未生效；每压缩周期提示一次。',
      action: '需要排查时看 relay_status 的平面自检（relay_status.plane），完整原因与降级清单见结构化结果。',
      evidence: lines,
    }),
  };
}

/**
 * 台账批次规划（Lead）：焦点 → [上下文] → 闭环 → 队友 → 派活；行级去重 + 900 字符上限。
 * 返回 { notice, claims, track }：有注入时 guard 走 claims（投递成功后提交）；无候选行时走 track
 * （无需投递直接生效）；被丢弃/超限的行不推进 guard，下一步补。
 */
function planLedgerBatch(facts, guardInput) {
  const guard = guardInput ?? {};
  const ledgerEnabled = facts.ledgerEnabled !== false;
  const state = facts.state;
  const panel = facts.panel;
  const bandLine = ledgerEnabled ? bandLineOf(state, panel) : '';
  const focus = ledgerEnabled && facts.ledger?.exists === true ? phaseFocusLine(facts.ledger) : '';
  // [闭环] 只在「有分点可落账」时才有意义：台账存在且还有 open/doing/blocked 分点才提示；
  // 无台账文件（无处落账）或台账全部 done 时不发，提醒只会变噪音（用户 2026-11-16 反馈）。
  const pending = ledgerEnabled && ledgerHasUnclosedItems(facts.ledger) && Array.isArray(facts.pendingClosure) ? facts.pendingClosure : [];
  const closureSig = closureSigOf(pending);
  const teamText = ledgerEnabled ? teamPendingText(facts.teamContext) : '';
  const teamPending = ledgerEnabled && Array.isArray(facts.teamContext?.pending) ? facts.teamContext.pending : [];
  const dispatchRows = Array.isArray(facts.dispatchRows) ? facts.dispatchRows : [];
  const dispatchSig = dispatchSigOf(dispatchRows);
  const candidates = [];
  if (focus !== '' && focus !== (guard.focus ?? '')) candidates.push({ kind: 'focus', text: focus });
  if (closureSig !== '' && closureSig !== (guard.closureSig ?? '')) candidates.push({ kind: 'closure', text: closureLineOf(pending) });
  if (teamText !== '' && teamPending.some((row) => (guard.teamSeen ?? {})[row.name] !== row.band)) candidates.push({ kind: 'team', text: teamLineOf(teamText) });
  // [上下文] 沿用旧「批次附带」语义：只在同 step 有焦点/闭环/队友变化时随行注入。
  const bandChanged = bandLine !== '' && bandLine !== (guard.bandKey ?? '');
  if (bandChanged && candidates.length > 0) candidates.splice(candidates[0].kind === 'focus' ? 1 : 0, 0, { kind: 'band', text: bandLine });
  if (dispatchRows.length > 0 && dispatchSig !== (guard.dispatchSig ?? '')) candidates.push({ kind: 'dispatch', text: dispatchText(dispatchRows) });
  let batch = candidates;
  if (batchLengthOf(batch) > LEDGER_BATCH_MAX) batch = batch.filter((row) => row.kind !== 'team');
  if (batchLengthOf(batch) > LEDGER_BATCH_MAX) batch = batch.filter((row) => row.kind !== 'band');
  const kept = new Set(batch.map((row) => row.kind));
  const injected = batch.length > 0 && facts.canInject === true;
  const notice = injected
    ? { kind: 'ledger', text: batch.map((row) => row.text).join('\n'), summary: '[context-relay] 台账 · 非用户发言' }
    : null;
  const nextGuard = (batch.length === 0 || injected) ? {
    ...guard,
    focus: focus === '' ? '' : kept.has('focus') ? focus : (guard.focus ?? ''),
    bandKey: bandLine === '' ? '' : kept.has('band') ? bandLine : (guard.bandKey ?? ''),
    closureSig: closureSig === '' ? '' : kept.has('closure') ? closureSig : (guard.closureSig ?? ''),
    teamSeen: candidates.some((row) => row.kind === 'team') && !kept.has('team') ? (guard.teamSeen ?? {}) : teamSeenOf(guard.teamSeen, facts.teamContext),
    dispatchSig: kept.has('dispatch') ? dispatchSig : (guard.dispatchSig ?? ''),
  } : null;
  if (nextGuard === null) return { notice, claims: null, track: null };
  const stateChange = { guard: nextGuard, dropDispatch: dispatchRows.length > 0 };
  // 本步没有可注入行：状态变更直接生效（无需投递）；有注入：投递成功后 claim。
  return injected ? { notice, claims: stateChange, track: null } : { notice, claims: null, track: stateChange };
}

/**
 * 本步 notice 计划（纯函数）。
 *
 * @param {object} facts 采集事实：
 *   subagent, phase, state（bandFor 结果）, lastBand, compactionSeq, panel, escalation,
 *   ledgerEnabled, ledger, teamContext, pendingClosure, dispatchRows, guard,
 *   capacity（capacityOf 结果）, capacityMemory, panelPrevious, metricsUnavailable, canInject,
 *   plane（planeStatusOf 结果：role/installed/degradations；C15/§5 首步降级可见性）
 * @returns {{notice: null|{kind: string, text: string, summary: string}, claims: object, track: object,
 *   rising: boolean, capacityRising: boolean, capacityRearmed: boolean, panelChanged: boolean}}
 */
export function planNotices(facts) {
  const subagent = facts?.subagent === true;
  const state = facts?.state ?? { band: 'ok' };
  const phase = facts?.phase;
  const organizeCount = Number.isFinite(facts?.organizeCount) ? Math.max(0, Math.trunc(facts.organizeCount)) : 0;
  const rank = SENTINEL_RANK[state.band] ?? 0;
  const rising = rank > (SENTINEL_RANK[facts?.lastBand] ?? 0);
  const compactionSeq = Number.isInteger(facts?.compactionSeq) ? facts.compactionSeq : -1;
  const claims = {};
  const track = {};
  let notice = null;

  // ① 到线提醒 / 队友请示（升线才注入）；claim 后置到投递成功。
  if (rising) {
    // M-12：队友 notice 不带 Lead 台账行（它没有 relay_work_items 工具面，也不该看到 Lead 计数）。
    const ledgerForText = subagent ? undefined : facts?.ledger;
    const recommendation = facts?.contextCheck?.recommendation
      ?? contextCheckChoice({ band: state.band, organizeCount, panel: facts?.panel, trigger: 'band', capacityAtRisk: facts?.capacity?.atRisk === true });
    notice = {
      kind: 'phase',
      text: sentinelText(phase, state, subagent, facts?.panel, facts?.escalation, ledgerForText, recommendation, organizeCount),
      summary: sentinelSummary(state, phase, subagent),
    };
    claims.lastBand = { band: state.band, compactionSeq };
  } else {
    track.lastBand = { band: state.band, compactionSeq };
  }

  // ② 容量保全：回落/压缩降 15% 重新武装（track），上升沿注入一次（claim used）。
  const capacity = facts?.capacity ?? {};
  const capacityMemory = facts?.capacityMemory;
  let capacityRearmed = false;
  let capacityArmed = capacityMemory;
  const usedKnown = Number.isFinite(state.used);
  if (capacity.atRisk !== true) {
    if (capacityMemory !== undefined) track.capacity = null;
    capacityArmed = undefined;
  } else if (capacityMemory !== undefined && capacityMemory !== true
    && Number.isFinite(capacityMemory.used) && usedKnown
    && state.used <= capacityMemory.used * (1 - CAPACITY_REARM_DROP_RATIO)) {
    // P2：压缩生效（used 降 ≥15%）→ 即使 ratio 仍 ≥capacityThreshold（默认 55%）也重新武装，可再提示一次。
    track.capacity = null;
    capacityArmed = undefined;
    capacityRearmed = true;
  }
  const capacityRising = capacity.atRisk === true && capacityArmed === undefined;
  if (capacityRising) {
    const capacityText = capacityNoticeText(capacity, facts?.panel);
    let attached = false;
    if (notice === null) {
      notice = { kind: 'capacity', text: capacityText, summary: '[context-relay] 容量保全（非用户发言）' };
      attached = true;
    } else if (notice.text.length + 1 + capacityText.length <= NOTICE_MAX) {
      // 与到线提醒同 step：合并为一条（容量段追加在到线提醒之后，旧口径）。
      notice.text = notice.text + '\n' + capacityText;
      attached = true;
    }
    // 超 900：本条只发到线，容量上升沿下一步单独补（不丢事件、不截断正文）。
    if (attached) claims.capacity = { used: usedKnown ? state.used : undefined };
  }

  // ③ 面板变更提醒：首次见到只记签名；同 step 已有到线/容量 notice 时视为已覆盖（claim 签名）。
  let panelChanged = false;
  if (!subagent && facts?.panel !== undefined && facts?.panel !== null) {
    const signature = panelSignatureOf(facts.panel);
    const previous = facts.panelPrevious;
    if (previous === undefined || previous === signature) {
      track.panelSig = signature;
    } else {
      panelChanged = true;
      if (notice !== null) claims.panelSig = signature;
      else {
        notice = { kind: 'panel', text: panelChangeText(facts.panel), summary: '[context-relay] 面板已更新（非用户发言）' };
        claims.panelSig = signature;
      }
    }
  }

  // ③b P0-D 起点/新任务自查（主路径入口）：面板之后、台账之前。若本步已有更高优先 notice
  // （到线/容量/面板），不生成也不 claim，pending 留给下一步补（信息不丢）。
  if (notice === null && !subagent && facts?.contextCheck !== undefined) {
    const fact = facts.contextCheck;
    const recommendation = fact.recommendation
      ?? contextCheckChoice({ band: state.band, organizeCount, panel: facts?.panel, trigger: fact.task !== undefined ? 'task' : 'phase', capacityAtRisk: facts?.capacity?.atRisk === true });
    notice = {
      kind: 'context-check',
      text: contextCheckText({ ...fact, band: state.band, capacity, recommendation, panel: facts?.panel }),
      summary: '[context-relay] 上下文自查（非用户发言）',
    };
    claims.contextCheck = { keys: Array.isArray(fact.keys) ? fact.keys : [] };
  }

  // ④ 台账批次（Lead 专属；注意：即使 workItems 关闭，派活提示仍生效——旧口径）。
  if (!subagent) {
    if (notice !== null) {
      // 本步 notice 已带 band/模式事实：[上下文] 记键不注入；其余行不推进 guard，下一步补。
      if (facts?.ledgerEnabled !== false) claims.guard = { ...(facts?.guard ?? {}), bandKey: bandLineOf(state, facts?.panel) };
    } else {
      const planned = planLedgerBatch(facts, facts?.guard);
      if (planned.notice !== null) notice = planned.notice;
      if (planned.claims !== null) {
        claims.guard = planned.claims.guard;
        if (planned.claims.dropDispatch === true) claims.dropDispatch = true;
      }
      if (planned.track !== null) {
        track.guard = planned.track.guard;
        if (planned.track.dropDispatch === true) track.dropDispatch = true;
      }
    }
  }

  // ⑤ M-14：指标不可用（投影/计量均缺）一次性保守提示——只在本步无其他 notice 时补。
  if (notice === null && !subagent && facts?.metricsUnavailable === true
    && (facts?.guard ?? {}).basisUnavailable !== true) {
    notice = { kind: 'unavailable', text: unavailableNoticeText(), summary: '[context-relay] 上下文指标不可用（非用户发言）' };
    // 与台账批次的 guard 变更合并（批次为空时它放在 track 里；一律随本条 notice 投递成功后提交）。
    const base = claims.guard ?? track.guard ?? (facts?.guard ?? {});
    track.guard = undefined;
    claims.guard = { ...base, basisUnavailable: true };
  }

  // ⑤b P1-A（v0.11）：宿主自动压缩兜底——插件未主持压缩，写最小恢复快照并提示一次；
  // claims.guard.fallbackSeq = compactionSeq（投递成功才 claim，同一次压缩不重发；off/unknown 由 sentinel 不传 fact）。
  if (notice === null && !subagent && facts?.compactionFallback !== undefined && facts?.compactionFallback !== null) {
    const fallback = facts.compactionFallback;
    if (Number.isInteger(fallback.compactionSeq) && (facts?.guard ?? {}).fallbackSeq !== fallback.compactionSeq) {
      notice = {
        kind: 'recovery',
        text: recoveryNoticeText(fallback),
        summary: '[context-relay] 宿主自动压缩兜底（非用户发言）',
      };
      const base = claims.guard ?? track.guard ?? (facts?.guard ?? {});
      track.guard = undefined;
      claims.guard = { ...base, fallbackSeq: fallback.compactionSeq };
    }
  }

  // ⑥ 平面/seam 降级（C15/设计 §5）：installed=false 或 degradations 非空 → 本压缩周期一次。
  // 本步已有更高优先级 notice 时只等下一步（不 claim，不丢事实）；claim guard.planeSig 且压缩复位
  // （deliver 清 LEDGER_GUARD）后重新提示，文案列 seam 名/原因并指向 relay_status.plane。
  const planeIssue = planeIssueOf(facts?.plane);
  if (notice === null && planeIssue !== null && (facts?.guard ?? {}).planeSig !== planeIssue.sig) {
    notice = { kind: 'plane', text: planeIssue.text, summary: '[context-relay] 平面/seam 降级（非用户发言）' };
    const base = claims.guard ?? track.guard ?? (facts?.guard ?? {});
    track.guard = undefined;
    claims.guard = { ...base, planeSig: planeIssue.sig };
  }

  // 每步 ≤1 条、≤900 字符（硬保证）。正常 builder 文本均低于上限；台账批次已先按类别丢弃降长，
  // 剩余极端情形（焦点/闭环单行超长）只从尾部截断，行前缀与语义保留。
  if (notice !== null && notice.text.length > NOTICE_MAX) notice.text = notice.text.slice(0, NOTICE_MAX - 1) + '…';
  return { notice, claims, track, rising, capacityRising, capacityRearmed, panelChanged };
}

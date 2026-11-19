/**
 * dsh-context-relay — 用户输出层（relay-audit §2.4「说人话」）。
 *
 * 纯函数：四段式（结论 / 影响 / 需要你做什么 / 证据）、受众分离、内部键黑名单。
 * - 用户可见文案只用 `human.*` / notice 正文；
 * - 模型/机器字段（band=、headroomTo*、dispatchId、revision、seq、code:、autoCompress...）
 *   只进 summary / 结构化字段 / facts / 日志，不进用户文案。
 *
 * @module dsh-context-relay/output
 */

/** 用户四段式的固定标签（顺序即契约）。 */
export const HUMAN_LABELS = Object.freeze({
  conclusion: '结论',
  impact: '影响',
  action: '需要你做什么',
  evidence: '证据',
});

/** phase 的中文标签（用户文案不直接暴露 discover/build 等模型术语）。 */
export const PHASE_LABELS = Object.freeze({
  discover: '探索',
  decide: '决策',
  build: '构建',
  verify: '验证',
  ship: '交付',
  blocked: '阻塞',
  cancel: '取消',
  'user-gate': '用户验收',
});

/** 档位的中文标签（用户文案不贴 band=）。 */
export const BAND_LABELS = Object.freeze({
  ok: '在线内',
  warn: '预警（现在动手）',
  organize: '兜底（压缩继续/接力新会话）',
  relay: '硬上限（该交接）',
  unavailable: '指标不可用',
});

export function phaseLabelOf(phase) {
  const key = String(phase ?? '');
  return PHASE_LABELS[key] ?? key;
}

export function bandLabelOf(band) {
  const key = String(band ?? '');
  return BAND_LABELS[key] ?? key;
}

/** 内部键黑名单（relay-audit §2.4.4 / §4.4）：用户文案不得含这些原始键。 */
export const INTERNAL_KEY_NAMES = Object.freeze([
  'band=', 'headroomTo', 'dispatchId', 'revision', 'code:', 'seq', 'autoCompress', 'autoHandoff', 'authorizeNext',
]);

const INTERNAL_KEY_PATTERNS = Object.freeze([
  ['band=', /\bband=/],
  ['headroomTo', /\bheadroomTo/],
  ['dispatchId', /\bdispatchId\b/],
  ['revision', /\brevision\b/],
  ['code:', /\bcode:/],
  ['seq', /\bseq\b/],
  ['autoCompress', /\bautoCompress\b/],
  ['autoHandoff', /\bautoHandoff\b/],
  ['authorizeNext', /\bauthorizeNext\b/],
]);

/** 返回文本里出现的内部键名（顺序同黑名单；空数组 = 干净）。 */
export function internalKeysIn(text) {
  const source = String(text ?? '');
  return INTERNAL_KEY_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

/** 按 Unicode 码点截断（不切断代理对）；超长以省略号结尾。 */
export function clipUserText(text, limit = 300) {
  const chars = Array.from(String(text ?? ''));
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 300;
  return chars.length <= cap ? chars.join('') : chars.slice(0, Math.max(0, cap - 1)).join('') + '…';
}

/** 归一四段式对象：去空白、evidence 变数组；无证据时给可读占位。 */
export function humanParts(input = {}) {
  const textOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const evidence = (Array.isArray(input.evidence) ? input.evidence : [input.evidence])
    .map(textOf).filter((item) => item !== '');
  return {
    conclusion: textOf(input.conclusion),
    impact: textOf(input.impact),
    action: textOf(input.action),
    evidence: evidence.length > 0 ? evidence : ['无'],
  };
}

/** 渲染四段式用户文案（固定四行、固定顺序）。 */
export function renderFourPart(input = {}) {
  const parts = humanParts(input);
  return [
    HUMAN_LABELS.conclusion + '：' + parts.conclusion,
    HUMAN_LABELS.impact + '：' + parts.impact,
    HUMAN_LABELS.action + '：' + parts.action,
    HUMAN_LABELS.evidence + '：' + parts.evidence.join('；'),
  ].join('\n');
}

/** 把一段技术提示降级成用户可读文本：内部键换中文标签。 */
export function scrubUserText(text) {
  return String(text ?? '')
    .replace(/\bband=([a-z]+)/gi, '档位')
    .replace(/\bheadroomTo[A-Za-z]+/g, '余量')
    .replace(/\bdispatchId\b/g, '派活编号')
    .replace(/\brevision\b/g, '版本')
    .replace(/\bseq\b/g, '序号')
    .replace(/\bautoCompress\b/g, '压缩免审批')
    .replace(/\bautoHandoff\b/g, '交接免审批')
    .replace(/\bauthorizeNext\b/g, '下一次授权')
    .replace(/\bcode:/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统一失败文案（≤300 字四段；具体原因留在结构化 error/summary/日志，不进用户文案）。 */
export function failureHumanOf(message) {
  const reason = scrubUserText(message);
  return humanParts({
    conclusion: '操作未完成：' + clipUserText(reason, 80),
    impact: '本次没有产生任何改动（零副作用）。',
    action: '按提示修正参数或时机后重试；不需要其他操作。',
    evidence: ['详细原因见本次结果的结构化错误字段（排障用）'],
  });
}

function pctOf(ratio) {
  return typeof ratio === 'number' && Number.isFinite(ratio) ? (Math.round(ratio * 1000) / 10).toFixed(1) + '%' : '?';
}

const OPERATION_LABELS = Object.freeze({ continue: '继续', compress: '压缩继续', handoff: '接力新会话' });

function operationLabelOf(operation) {
  return OPERATION_LABELS[operation] ?? '';
}

function onOff(value) {
  return value === true ? '开' : '关';
}

/** 人话版 relay_status（四段式）。内部字段只留在结构化结果与 facts。 */
export function statusHumanOf(report = {}) {
  const phase = phaseLabelOf(report?.phase);
  const band = report?.lead?.band ?? 'ok';
  const ratio = report?.lead?.ratio;
  const organizeCount = Number.isInteger(report?.organizeCount) ? report.organizeCount : 0;
  const budget = report?.budget;
  const capacity = report?.capacity;
  const panel = report?.panel;
  const choice = report?.continue;
  const conclusion = '上下文 ' + pctOf(ratio) + '（' + bandLabelOf(band) + '），阶段「' + phase + '」'
    + (organizeCount > 0 ? '，本会话已压缩 ' + organizeCount + ' 次' : '') + '。';
  const impacts = [];
  if (Number.isFinite(budget?.headroomToWarn)) impacts.push('离预警档还有约 ' + budget.headroomToWarn + ' tokens');
  if (Number.isFinite(budget?.headroomToOrganize)) impacts.push('离兜底档还有约 ' + budget.headroomToOrganize + ' tokens');
  if (Number.isFinite(budget?.currentPhaseCostTokens)) impacts.push('本阶段已消耗约 ' + budget.currentPhaseCostTokens + ' tokens');
  if (capacity?.atRisk === true) impacts.push('已到容量保全线（' + pctOf(capacity.ratio) + '，线 ' + pctOf(capacity.threshold) + '），继续增长可能被强制压缩');
  if (report?.compaction?.debt === true) impacts.push('本会话压缩过，源上下文已变脏，交接会给新会话更干净的起点');
  if (Array.isArray(report?.team) && report.team.length > 0) {
    const pending = report.team.filter((member) => member?.band === 'organize' || member?.band === 'relay');
    if (pending.length > 0) impacts.push('队友待处理 ' + pending.length + ' 人（' + pending.map((member) => member.name).join('、') + '）');
  }
  if (impacts.length === 0) impacts.push('没有额外可见影响。');
  const actions = [];
  const preset = choice?.preset ?? panel?.defaultOperation;
  if (preset !== undefined && preset !== null && operationLabelOf(preset) !== '') actions.push('面板模式已设为「' + operationLabelOf(preset) + '」，按它执行');
  if (band === 'warn') actions.push('本阶段照常做完；开新阶段前先估算余量，放不下就压缩、接力或拆小范围');
  else if (band === 'organize') actions.push('本阶段做完后，在阶段边界选择压缩继续或接力新会话；不要中途打断');
  else if (band === 'relay') actions.push('本阶段做完后尽快交接新会话；不要中途压缩');
  else if (band === 'unavailable') actions.push('开新阶段前人工确认剩余上下文（或恢复投影接入）');
  else actions.push('按本阶段推进；开新阶段前看一眼余量');
  if (panel !== undefined && panel !== null) {
    actions.push('压缩免审批：' + onOff(panel.autoCompress) + '；交接免审批：' + onOff(panel.autoHandoff) + '；下一次操作授权：' + onOff(panel.authorizeNext));
  }
  const evidence = ['面板「接力」chip 的实时用量'];
  if (report?.workItems?.relativePath !== undefined) evidence.push('工作台账：' + String(report.workItems.relativePath));
  return humanParts({ conclusion, impact: impacts.join('；'), action: actions.join('；'), evidence });
}

/** 人话版 relay_phase 结果（四段式）。 */
export function phaseHumanOf(result = {}) {
  const r = result ?? {};
  const phase = phaseLabelOf(r.phase);
  const previous = r.previous !== undefined && r.previous !== null && r.previous !== r.phase ? phaseLabelOf(r.previous) : null;
  const band = r.band ?? r.budget?.band;
  const conclusion = (r.exit_reason !== undefined && (r.phase === 'blocked' || r.phase === 'cancel'))
    ? '已进入「' + phase + '」出口：' + clipUserText(scrubUserText(r.exit_reason), 120)
    : '阶段已切换到「' + phase + '」' + (previous === null ? '' : '（上一阶段「' + previous + '」）')
      + (band === undefined ? '' : '，上下文档位：' + bandLabelOf(band)) + '。';
  const impacts = [];
  const budget = r.budget;
  if (Number.isFinite(budget?.headroomToOrganize)) impacts.push('离兜底档还有约 ' + budget.headroomToOrganize + ' tokens');
  if (Number.isFinite(budget?.lastPhaseCostTokens)) impacts.push('上一阶段实测消耗约 ' + budget.lastPhaseCostTokens + ' tokens');
  if (r.ledger !== undefined && r.ledger !== null) {
    const done = Number.isFinite(r.ledger.done) ? r.ledger.done : 0;
    const planned = Number.isFinite(r.ledger.planned) ? r.ledger.planned : 0;
    impacts.push('工作台账：分点 ' + done + '/' + planned + (Number(r.ledger.pending) > 0 ? '，未闭合 ' + r.ledger.pending : ''));
  }
  if (Array.isArray(r.team?.pending) && r.team.pending.length > 0) impacts.push('队友待处理：' + r.team.pending.join('、'));
  const warnings = [r.warning, r.workItemsWarning, r.teamWarning, r.contractWarning, r.delegationWarning].filter((item) => typeof item === 'string' && item !== '');
  for (const warning of warnings) impacts.push(scrubUserText(warning));
  if (impacts.length === 0) impacts.push('没有额外可见影响。');
  const actions = [];
  if (typeof r.hint === 'string' && r.hint !== '') actions.push(clipUserText(scrubUserText(r.hint), 160));
  if (r.user_gate !== undefined && r.user_gate !== null) actions.push('把四段汇报交给用户确认；需要裁决的问题已随结果返回');
  if (actions.length === 0) actions.push('按本阶段目标推进；阶段边界再检查预算与台账。');
  const evidence = [];
  if (r.design?.path !== undefined) evidence.push('设计文档：' + String(r.design.path));
  if (r.user_gate !== undefined && r.user_gate !== null) {
    evidence.push('用户汇报 ' + String(r.user_gate.reportChars ?? '?') + ' 字，边界问题 ' + String(r.user_gate.questions ?? 0) + ' 条');
  }
  if (evidence.length === 0) evidence.push('结构化阶段事实与日志（排障用）');
  return humanParts({ conclusion, impact: impacts.join('；'), action: actions.join('；'), evidence });
}

function kbOf(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? (Math.round(bytes / 1024 * 10) / 10).toFixed(1) + ' KB' : '?';
}

/** 人话版 handoff 结果（四段式；sessionId 等内部字段只留在结构化结果）。 */
export function handoffHumanOf(result = {}) {
  const r = result ?? {};
  const title = typeof r.title === 'string' && r.title !== '' ? scrubUserText(r.title) : '接力会话';
  const caps = r.caps ?? {};
  const conclusion = '接力会话已创建（' + title + '）——新会话已拿到交接摘要，旧会话保留为审计档案。';
  const impacts = [];
  if (caps.bytes !== undefined) impacts.push('摘要 ' + kbOf(caps.bytes.used) + '/' + kbOf(caps.bytes.limit) + ' 注入新会话，完整内容在交接文件（' + kbOf(caps.fullBytes) + '）');
  const handover = r.handover;
  if (handover !== undefined && handover !== null) {
    const inventory = handover.inventory ?? {};
    const cleanup = handover.cleanup;
    const skipped = new Set([...(Array.isArray(inventory.skipped) ? inventory.skipped : []), ...(Array.isArray(cleanup?.skipped) ? cleanup.skipped : [])]);
    const countOf = (key) => (skipped.has(key) ? 'N/A' : String(Array.isArray(inventory[key]) ? inventory[key].length : 0));
    const cleanedOf = (key, actions) => (skipped.has(key) ? 'N/A' : String(Array.isArray(cleanup?.[key]) ? cleanup[key].filter((row) => actions.includes(row.action)).length : 0));
    const parts = [];
    parts.push('后台任务 ' + countOf('jobs') + (cleanup === null ? ' 未清理' : '→已处理 ' + cleanedOf('jobs', ['killed', 'cancelled-with-owner'])));
    parts.push('定时任务 ' + countOf('schedules') + (cleanup === null ? ' 未迁移' : '→已迁移 ' + cleanedOf('schedules', ['transferred'])));
    parts.push('队友 ' + countOf('teammates') + (cleanup === null ? ' 未清理' : '→已中断 ' + cleanedOf('teammates', ['interrupted'])));
    parts.push('子智能体 ' + countOf('subagents') + (cleanup === null ? ' 未清理' : '→已中断 ' + cleanedOf('subagents', ['interrupted'])));
    impacts.push('交接清理：' + parts.join(' / '));
    if (cleanup === null) impacts.push('清理未完成：' + scrubUserText(handover.error));
    else if (Array.isArray(handover.cleanup.errors) && handover.cleanup.errors.length > 0) impacts.push('清理告警 ' + handover.cleanup.errors.length + ' 条');
    if (handover.truncated === true) impacts.push('结构化清理清单已截断（完整结果见交接文件）');
  }
  if (r.progress?.updated === true) impacts.push('滚动进度已更新：' + String(r.progress.path));
  if (r.workItemsWarning !== undefined) impacts.push('工作台账文件损坏，已备份后按空台账继续交接');
  if (r.info?.code === 'relay-attach-failed') impacts.push('新会话未绑定工作区，需要时手动挂载');
  if (impacts.length === 0) impacts.push('没有额外可见影响。');
  const action = '从会话列表打开新会话继续；旧会话只作审计，不要继续在旧会话里改。'
    + (typeof r.summary === 'string' && r.summary.includes('重复接力') ? '注意：这是重复接力，会再建会话/耗额度。' : '');
  return humanParts({ conclusion, impact: impacts.join('；'), action, evidence: [String(r.handoffPath ?? '交接文件（路径见结构化结果）')] });
}

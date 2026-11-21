/**
 * dsh-context-relay — 内部事实输出层（relay-audit-2 W2/D3）。
 *
 * 工具返回是正常函数结果：状态 / 发生了什么 / 卡在哪 / 下一步 / 证据 / 风险。
 * - 不产任何「用户段」：没有用户段标记、user 字段、user 可见选项，也没有替 Lead 写的话；
 * - Lead 是唯一对用户说话的人；工具文本只供 Lead 判断，不要求原样转发；
 * - notice 层用机器状态头/尾（插件 notice，非用户发言），与工具结果分开。
 *
 * @module dsh-context-relay/output
 */

/** notice 机器的固定头/尾（v0.14 P2：notice 不再使用用户汇报标签）。 */
export const NOTICE_HEAD = '[插件状态]';
export const NOTICE_DISCLAIMER = '这不是用户发言。不要复述本段；对用户请用三问重写（简单确认不套）。';
/** notice 正文硬上限（UTF-8 字节；server-side rendering 兜底）。 */
export const NOTICE_MAX_BYTES = 600;

/** 按 UTF-8 字节截断（不切断 surrogate pair），超长以省略号结尾。 */
export function clipUtf8(text, maxBytes) {
  const source = String(text ?? '');
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : 0;
  if (Buffer.byteLength(source, 'utf8') <= cap) return source;
  if (cap <= Buffer.byteLength('…', 'utf8')) return '';
  let out = '';
  let used = 0;
  for (const char of source) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (used + bytes + Buffer.byteLength('…', 'utf8') > cap) break;
    out += char;
    used += bytes;
  }
  return out + '…';
}

/** phase 的中文标签（内部事实可读化，不暴露 discover/build 等模型术语）。 */
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

/** 档位的中文标签。 */
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

/** 内部键黑名单（排障/测试用；工具事实本身可以出现，但 notice 用户文案不得含）。 */
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

/** 归一 notice 四段式对象：去空白、evidence 变数组；无证据时给可读占位。 */
export function noticeParts(input = {}) {
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

/** 渲染 notice 机器状态体：固定头 + 状态正文 + 依据 + 固定尾，硬上限 600 B。 */
export function renderNoticeText(input = {}) {
  const parts = noticeParts(input);
  const body = [parts.conclusion, parts.impact, parts.action].filter((line) => line !== '').join('\n');
  const proof = parts.evidence.filter((item) => item !== '无').join('；');
  const budget = NOTICE_MAX_BYTES - Buffer.byteLength(NOTICE_HEAD, 'utf8') - Buffer.byteLength(NOTICE_DISCLAIMER, 'utf8') - 2;
  let evidence = proof === '' ? '' : '依据：' + proof;
  const evidenceCap = Math.floor(budget * 0.45);
  if (Buffer.byteLength(evidence, 'utf8') > evidenceCap) evidence = clipUtf8(evidence, evidenceCap);
  const bodyBudget = Math.max(0, budget - (evidence === '' ? 0 : Buffer.byteLength(evidence, 'utf8') + 1));
  const bodyText = clipUtf8(body, bodyBudget);
  return [NOTICE_HEAD, bodyText, evidence, NOTICE_DISCLAIMER].filter((line) => line !== '').join('\n');
}

/** 把一段技术提示降级成 notice 可读文本：内部键换中文标签。 */
export function scrubNoticeText(text) {
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

/** 工具事实的固定标记（模型可见；不是用户消息，也不得原样贴给用户）。 */
export const MODEL_STATE_MARK = '[内部事实·供 Lead 判断，不要原样贴给用户]';
export const INTERNAL_ERROR_MARK = '[内部错误·供 Lead 排障，不要原样贴给用户]';
export const INTERNAL_DETAILS_MARK = '[内部细节·供 Lead 判断，不要原样贴给用户]';

/**
 * 工具结果的事实形状（W2/§6.3.2）：status/phase/collect/handoff 共用。
 * 声明的是模型判断用的事实（发生了什么/下一步/证据/风险），不是用户话术；
 * additionalProperties 允许各工具追加领域字段（team/caps/handover/...）。
 */
export const FACT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'Internal facts for the Lead: ok/status/phase/effects/retryable/next/evidence/risk/facts/summary/text. No user-facing section.',
  properties: {
    ok: { type: 'boolean', description: 'true = success; false = actionable failure or partial success.' },
    status: { type: 'string', description: 'Tool-specific state (accepted/collected/pending/...).' },
    phase: { type: 'string', description: 'Phase fact.' },
    effects: { type: 'string', description: 'What already happened; never omit after a side effect.' },
    retryable: { type: 'boolean', description: 'Whether the same call may be retried as-is.' },
    next: { description: 'Next action (string or structured recovery list).' },
    evidence: { description: 'Evidence pointers (paths, seq, report).' },
    risk: { description: 'Known risk or unverified fact.' },
    facts: { type: 'object', additionalProperties: true, description: 'Same facts as a stable block.' },
    summary: { type: 'string', description: 'One-line internal summary.' },
    text: { type: 'string', description: 'Internal fact text (not for the user verbatim).' },
  },
  additionalProperties: true,
});

/**
 * 调用方未声明副作用时的唯一文案：不冒充「零副作用」，提醒模型先核对。
 * fail() 的默认值与本文件的 render 兜底同源，避免两处措辞漂移。
 */
export const EFFECTS_UNRECORDED = '未记录副作用（调用方未声明）；重试前先核对 summary/facts 与实际写盘。';

/** 事实的一行可读化：对象/数组 JSON，标量原样。 */
function factLine(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 失败/部分成功的 render：只给内部事实——原因、已经发生什么、能不能重试、下一步。
 * 不生成任何用户话术，也不把英文技术句包装成「给用户」。
 */
export function failureRenderText(result = {}) {
  const reason = typeof result.error === 'string' && result.error !== ''
    ? result.error
    : (typeof result.summary === 'string' && result.summary !== '' ? result.summary : '操作未完成。');
  const handoffPath = typeof result.handoffPath === 'string' && result.handoffPath !== '' ? result.handoffPath : undefined;
  const sessionId = typeof result.sessionId === 'string' && result.sessionId !== '' ? result.sessionId : undefined;
  const lines = [INTERNAL_ERROR_MARK, '原因：' + reason];
  if (result.partial === true) {
    lines.push('部分成功：新会话已创建并被接受；旧会话清理未完成。');
    if (sessionId !== undefined) lines.push('新会话：' + sessionId);
    if (handoffPath !== undefined) lines.push('交接单：' + handoffPath);
    const unclean = result.facts?.unclean;
    if (unclean !== undefined) lines.push('未清项：' + factLine(unclean));
  } else {
    // 预接受失败也可能已经写盘/半建会话：把事实摊开，不伪造「零副作用」。
    if (handoffPath !== undefined) lines.push('交接单：' + handoffPath);
    if (sessionId !== undefined) lines.push('会话：' + sessionId);
  }
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  if (summary !== '' && summary !== reason) lines.push('事实：' + clipUserText(summary, 600));
  const effects = factLine(result.effects);
  lines.push('已经发生：' + (effects === '' ? EFFECTS_UNRECORDED : effects));
  lines.push('可否重试：' + (result.retryable === false ? '否' : '是'));
  const next = factLine(result.next);
  if (next !== '') lines.push('下一步：' + next);
  return lines.join('\n');
}

/** 内部工具默认 render：成功 = 内部事实标记 + 正文；失败 = 可行动失败事实。 */
export function renderInternalResult(result = {}, pick = (value) => (typeof value?.text === 'string' && value.text !== '' ? value.text : undefined)) {
  if (result?.ok === false) return failureRenderText(result);
  const text = pick(result);
  return MODEL_STATE_MARK + '\n' + (text === undefined ? JSON.stringify(result) : text);
}

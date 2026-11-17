/**
 * dsh-context-relay — 纯函数策略层（无 IO、无 ctx，可单测）。
 *
 * 职责：阈值归一化 / 压力分档 / phase 校验 / 人类可读状态 / phase brief / 有界 handoff。
 * 设计依据：docs/research/01-dsh-architecture.md（40% 不是内核概念，须插件层实现）、
 *          04-human-agent-protocol.md（P0/P1/P2、handoff 七字段、一次 Go/No-go）。
 *
 * 阈值口径（2026-10-20 用户明确要求；2026-11-01 用户把默认基准改为 35%）：窗口已知时**只用比例线**
 * （新部署默认基准 35% → warn 30% / organize 35% / relay 45%）；绝对 token 线只在窗口未知 / 为 0 时兜底
 * （100k/130k/160k）。v0.10 C10：legacy config.thresholds 双口径已删——阈值只有 settings.threshold 一个来源。
 *
 * v0.10 C6（M-17/D-07/D-14/B-13）：本模块是策略唯一真源——阈值解析（resolveEffectiveThresholds/
 * thresholdsFromPercent）、面板默认值映射（panelDefaultsOf）、面板模式标签（OPERATION_LABELS*）都在此，
 * host/agent/client 只消费；不再各平面各自复写。
 */

import { posix } from 'node:path';

/** host 发布 live 设置的进程内键（index.js/agent.js/panel-store 共用同一 Symbol.for）；panelDefaultsOf 读取它。 */
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');

/**
 * 委派执行占比阈值（v0.9.0 批次3；D-14：常量下沉 policy，纯策略层不再反向 import agent 模块）。
 * Lead 自身执行占比超过该值即 warn（delegation 纯函数模块从本模块取用）。
 */
export const DELEGATION_EXEC_RATIO_MAX = 0.2;

export const PHASES = ['discover', 'decide', 'build', 'verify', 'ship'];
/** 面板授权契约版本（v0.10.0=3）：版本变更 = 会话本地授权一次性失效（panel-store 显式 warn）。 */
export const PANEL_SCHEMA_VERSION = 3;
export const PHASE_EXITS = Object.freeze(['blocked', 'cancel']);
export const ALL_PHASES = Object.freeze([...PHASES, ...PHASE_EXITS]);
export const CAPACITY_PRESERVE_RATIO = 0.85;
export const USER_REPORT_LIMITS = Object.freeze({ maxChars: 600, detailedMaxChars: 4000, maxLineChars: 400 });

/**
 * 绝对 token 兜底线（仅在窗口未知时使用；社区经验拐点约 100k）。
 * 比例线才是新部署默认（DEFAULT_SETTINGS.threshold=35 → 30/35/45）；不再保留 legacy 阈值常量。
 */
const TOKEN_FALLBACK_LINES = Object.freeze({
  warnTokens: 100000,
  organizeTokens: 130000,
  relayTokens: 160000,
});

/** 默认生效阈值的基线比例（= DEFAULT_SETTINGS.threshold=35 派生：warn 30% / organize 35% / relay 45%）。 */
const BASELINE_RATIOS = Object.freeze({ warnRatio: 0.3, organizeRatio: 0.35, relayRatio: 0.45 });

/**
 * 侧栏可配置的 relay 设置（2026-10-25 v2 口径）：阈值基准（%）+ 面板各选项的默认值。
 * 阈值口径：基准 = 二次提醒阈值（organize），提醒 = 基准 − 5%，硬线 = 基准 + 10%
 * ——默认基准 35% → 30% / 35% / 45%（2026-11-01 用户把默认从 40% 改为 35%）。
 * 这里只存「默认值」：composer 面板按会话覆盖（见 panel-store）；新会话未改面板时用这些默认。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  threshold: 35,
  defaultOperation: null,
  autoCompress: false,
  autoHandoff: false,
  /** 「你的 token 预算无上限」注入的**默认值**（默认开；侧栏 UI 已移除，改由 composer 模型选择器旁的小胶囊按会话控制，v0.2.7）。 */
  unlimitedBudget: true,
  /** 专职架构师（v0.6.4）：Lead 是否把工程路线设计交给专职架构师队友（composer 小胶囊按会话控制；此值为默认）。 */
  architect: true,
});

/**
 * 侧栏设置 → 面板默认值（唯一映射，v0.10 C6/M-17/D-07）：panel-store 在本模块之上解析按会话面板，
 * host/agent/client 一律消费解析结果，不再各自复写六字段映射。
 * 缺省从 host 发布的进程内 live 设置读（Symbol.for('dsh-context-relay.settings')）；显式传参供单测/纯函数调用。
 * 非布尔控制位按 undefined 交给 normalizePanelState 回落规范默认。
 */
export function panelDefaultsOf(settings = globalThis[SETTINGS_KEY]) {
  if (settings === null || settings === undefined || typeof settings !== 'object') return undefined;
  return {
    defaultOperation: settings.defaultOperation,
    autoCompress: settings.autoCompress,
    autoHandoff: settings.autoHandoff,
    // v0.2.7：unlimitedBudget 是侧栏默认字段（UI 控件已移除），作为面板生效值的默认来源；
    // 非布尔（旧/残缺全局设置）按 undefined 交给归一化 → null（跟随规范默认 true）。
    unlimitedBudget: typeof settings.unlimitedBudget === 'boolean' ? settings.unlimitedBudget : undefined,
    // v0.6.4：专职架构师开关的默认来源（缺省跟随规范默认 true）。
    architect: typeof settings.architect === 'boolean' ? settings.architect : undefined,
  };
}

/**
 * 归一化侧栏设置：threshold 缺省取默认值，存在则必须是有限数值（其余类型一律抛错，由路由回 400）；
 * 合法数值裁剪到 [20,85]；unlimitedBudget 必须是布尔（缺省 true）；旧字段（autoPhase/autoHandoff/
 * autoContinue）一律忽略。
 */
export function normalizeSettings(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const raw = source.threshold;
  if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw))) {
    throw new Error('context-relay: threshold must be a finite percentage, got ' + String(raw));
  }
  const unlimited = source.unlimitedBudget;
  if (unlimited !== undefined && typeof unlimited !== 'boolean') {
    throw new Error('context-relay: unlimitedBudget must be a boolean, got ' + String(unlimited));
  }
  const architect = source.architect;
  if (architect !== undefined && typeof architect !== 'boolean') {
    throw new Error('context-relay: architect must be a boolean, got ' + String(architect));
  }
  return {
    threshold: raw === undefined ? DEFAULT_SETTINGS.threshold : Math.min(85, Math.max(20, Math.round(raw))),
    defaultOperation: PANEL_OPERATIONS.includes(source.defaultOperation) ? source.defaultOperation : null,
    autoCompress: source.autoCompress === true,
    autoHandoff: source.autoHandoff === true,
    unlimitedBudget: unlimited === undefined ? DEFAULT_SETTINGS.unlimitedBudget : unlimited,
    architect: architect === undefined ? DEFAULT_SETTINGS.architect : architect,
  };
}

/**
 * 当前进程生效设置：host 发布的 live 设置（侧栏热生效）覆盖规范默认；无发布（单测/直接挂载）
 * → 规范默认。供拿不到 agent apply 闭包的模块（如 shared.effectiveUnlimitedBudgetOf）读全局默认值。
 */
export function currentSettings(settings = globalThis[SETTINGS_KEY]) {
  return normalizeSettings(settings !== null && typeof settings === 'object' ? settings : {});
}

/**
 * 面板「模式」（defaultOperation）：继续 / 压缩继续 / 接力新会话；null = 问我。
 * v0.4.0 持久语义：人类选定的模式在本会话内一直有效（不消费，每次到线都按它执行）；
 * 接力成功后由 relay_handoff 同步给新会话。v0.10 C10：旧「压缩→新会话」档已从枚举删除。
 */
export const PANEL_OPERATIONS = Object.freeze(['compress', 'handoff', 'continue']);

/**
 * 面板模式中文标签（单一真源，v0.10 C6/D-14）：短标签用于到线提醒/状态行/advice，
 * 长标签用于表盘/推荐行；agent 侧 panel-gate 只做转发，不再各自复制。
 */
export const OPERATION_LABELS = Object.freeze({ compress: '压缩', handoff: '接力', continue: '继续' });
export const OPERATION_LONG_LABELS = Object.freeze({ compress: '压缩继续', handoff: '接力新会话', continue: '继续' });

/** 面板模式短标签；未知/空 → 「问我」。 */
export function operationLabelOf(operation) {
  return OPERATION_LABELS[operation] ?? '问我';
}

/** 面板模式长标签（表盘/推荐行叫法）；未知 → 回落短标签。 */
export function operationLongLabelOf(operation) {
  return OPERATION_LONG_LABELS[operation] ?? operationLabelOf(operation);
}

/**
 * 面板状态（按会话）：模式 + 三个自动授权 + 注入开关。
 * - autoCompress：压缩操作自动授权（任何压缩不再走审批；rev5.4）
 * - autoHandoff：开新会话自动授权（relay_handoff 不再走审批）
 * - authorizeNext：一次性预授权「下一次 relay 操作执行」免官方审批（成功即消费，无 TTL）
 */
// 面板状态默认基线：字段与 normalizePanelState 输出一致（11 字段），保留导出供 panel-store/测试派发默认值。
// 历史/退役字段已删除：旧 panel.json 里的键由白名单归一丢弃（不迁移、不回显）。
export const DEFAULT_PANEL_STATE = Object.freeze({
  defaultOperation: null,
  autoCompress: false,
  autoHandoff: false,
  handedOff: false,
  authorizeNext: false,
  // v0.2.7：本会话「你的 token 预算无上限」注入开关（null=跟随 settings 默认；panelDefaultsOf 会补出生效值）。
  unlimitedBudget: null,
  // v0.6.4：本会话「工程路线交给专职架构师」开关（null=跟随 settings 默认；同上）。
  architect: null,
  // v0.9.0 #56：架构师模型按会话；null=未显式选择→运行时取模型选择器默认值。
  // 形状 {provider, model, reasoningEffort?}；对象=显式选择（sticky）。
  architectModel: null,
  // v0.2.7：交接后新会话的注入设置（null=跟随当前会话生效值；true/false=强制开/关）。
  handoffUnlimitedBudget: null,
  // v0.3.3：模型推荐（只做面板高亮/参考；绝不参与预设/授权决策）。op=null 时 reason=''、at=null。
  recommendedOperation: null,
  recommendedReason: '',
  recommendedAt: null,
});

/**
 * 归一化面板状态（全字段白名单）：非法模式/未知键丢弃，布尔严格化。
 * 退役字段不在白名单，旧数据按未知键丢弃。
 */
export function normalizePanelState(input = {}) {
  const operation = PANEL_OPERATIONS.includes(input?.defaultOperation) ? input.defaultOperation : null;
  // v0.3.3 模型推荐：op 只认 PANEL_OPERATIONS；reason 只收字符串（trim + ≤120）；at 只收有限正数（trunc）。
  // op=null 时不保留理由/时间（旧脏记录归一后不会出现「有理由没操作」的半截推荐）。
  const recommendedOperation = PANEL_OPERATIONS.includes(input?.recommendedOperation) ? input.recommendedOperation : null;
  const recommendedReason = recommendedOperation !== null && typeof input?.recommendedReason === 'string'
    ? input.recommendedReason.trim().slice(0, 120)
    : '';
  const recommendedAt = recommendedOperation !== null && finitePositive(input?.recommendedAt) ? Math.trunc(input.recommendedAt) : null;
  return {
    defaultOperation: operation,
    autoCompress: input?.autoCompress === true,
    autoHandoff: input?.autoHandoff === true,
    // 内部字段：本会话已完成接力（归档）→ 不再注入任何到线提醒/重申。
    handedOff: input?.handedOff === true,
    authorizeNext: input?.authorizeNext === true,
    // v0.2.7：三值严格化（null=跟随默认/继承）。
    unlimitedBudget: triState(input?.unlimitedBudget),
    handoffUnlimitedBudget: triState(input?.handoffUnlimitedBudget),
    // v0.6.4：专职架构师开关同样三值（null=跟随 settings 默认）。
    architect: triState(input?.architect),
    // v0.9.0 #56：架构师模型按会话；非法/缺字段归 null（未显式选择→运行时取模型默认值）。
    architectModel: normalizeArchitectModel(input?.architectModel),
    // v0.3.3：模型推荐三字段（只展示/参考；人类 PUT 显式决策时由 host 清空）。
    recommendedOperation,
    recommendedReason,
    recommendedAt,
  };
}

/** v0.2.7：三值开关归一化——true/false 保留，其余（含 "true"/1/undefined）一律 null（跟随/继承）。 */
function triState(value) {
  return value === true ? true : value === false ? false : null;
}

/** 模型路由片段：provider/model/effort 都是非空短字符串；非法整体归 null。 */
function modelPart(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : undefined;
}

/** v0.7.0：架构师模型 {provider, model, reasoningEffort?}；缺 provider/model 或非法 → null；默认解析器复用它做合法性校验。 */
export function normalizeArchitectModel(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = modelPart(value.provider);
  const model = modelPart(value.model);
  if (provider === undefined || model === undefined) return null;
  const reasoningEffort = modelPart(value.reasoningEffort);
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

/** 由基准百分比推导三档比例（warn = 基准 − 5%，relay = 基准 + 10%，边界夹取）。 */
export function thresholdsFromPercent(threshold = DEFAULT_SETTINGS.threshold) {
  const settings = normalizeSettings({ threshold });
  const organizeRatio = settings.threshold / 100;
  const warnRatio = Math.max(0.02, (settings.threshold - 5) / 100);
  const relayRatio = Math.min(0.98, (settings.threshold + 10) / 100);
  return normalizeThresholds({
    warnRatio,
    organizeRatio,
    relayRatio,
    warnTokens: TOKEN_FALLBACK_LINES.warnTokens,
    organizeTokens: TOKEN_FALLBACK_LINES.organizeTokens,
    relayTokens: TOKEN_FALLBACK_LINES.relayTokens,
  });
}

/**
 * 生效阈值唯一解析入口（v0.10 C6：M-17/D-07；C10 删 legacy 双口径）：host（settings 路由 / 面板 live）
 * 与 agent（工具 / 哨兵 / 审批）共用——阈值只有 settings.threshold 一个来源，统一由此派生。
 * @param {{settings?: object}} input
 * @returns {object} normalizeThresholds 形状
 */
export function resolveEffectiveThresholds({ settings } = {}) {
  return thresholdsFromPercent(normalizeSettings(settings ?? {}).threshold);
}

/**
 * handoff 摘要的 advisory 预算（UTF-8 字节；v0.8.0「文档系统 v2」默认 16KB）。
 * 只决定摘要注入多少、什么时候分层——不拒绝、不截断丢数据：完整内容始终由 fullMarkdown 落盘。
 */
export const HANDOFF_SUMMARY_BYTES = 16384;

/**
 * handoff 摘要的 advisory 阈值（v0.8.0 起只做建议，不拒绝、不丢数据）：
 * - totalBytes：摘要 markdown 的字节预算（= HANDOFF_SUMMARY_BYTES；超出→摘要分层 + marker，完整版不截断）；
 * - itemChars / items：摘要里单条与各列表的建议上限；完整版（fullMarkdown）不受这些限制。
 */
export const HANDOFF_LIMITS = Object.freeze({
  totalBytes: HANDOFF_SUMMARY_BYTES,
  /** 摘要单条建议上限（Unicode 码点；截断不切断 surrogate 对）。 */
  itemChars: 200,
  /** 摘要每个数组的建议条数上限。 */
  items: Object.freeze({
    evidence: 12,
    key_docs: 8,
    done: 12,
    success_criteria: 5,
    next_actions: 8,
    blocked: 8,
    decisions: 10,
    constraints: 8,
    risks: 8,
    open_questions: 5,
    discarded: 8,
  }),
});

/** 摘要被 advisory 预算/条目阈值裁剪时的显式 marker（完整内容在同目录 handoff 文件里）。 */
const HANDOFF_SUMMARY_MARKER = '> [摘要已分层（advisory 阈值）→ 完整内容见工作区里的「完整交接单」文件（不截断、不丢数据）]';

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 归一化并校验阈值配置；比例必须严格递增且都 < 1。 */
export function normalizeThresholds(input = {}) {
  const out = {
    warnRatio: input.warnRatio ?? BASELINE_RATIOS.warnRatio,
    organizeRatio: input.organizeRatio ?? BASELINE_RATIOS.organizeRatio,
    relayRatio: input.relayRatio ?? BASELINE_RATIOS.relayRatio,
    warnTokens: input.warnTokens ?? TOKEN_FALLBACK_LINES.warnTokens,
    organizeTokens: input.organizeTokens ?? TOKEN_FALLBACK_LINES.organizeTokens,
    relayTokens: input.relayTokens ?? TOKEN_FALLBACK_LINES.relayTokens,
  };
  for (const key of ['warnRatio', 'organizeRatio', 'relayRatio']) {
    const value = out[key];
    if (!(typeof value === 'number') || !(value > 0) || !(value < 1)) {
      throw new Error('context-relay: ' + key + ' must be a ratio in (0,1), got ' + String(value));
    }
  }
  if (!(out.warnRatio < out.organizeRatio && out.organizeRatio < out.relayRatio)) {
    throw new Error('context-relay: thresholds must satisfy warnRatio < organizeRatio < relayRatio');
  }
  for (const key of ['warnTokens', 'organizeTokens', 'relayTokens']) {
    if (!finitePositive(out[key])) throw new Error('context-relay: ' + key + ' must be a positive number');
  }
  if (!(out.warnTokens < out.organizeTokens && out.organizeTokens < out.relayTokens)) {
    throw new Error('context-relay: token thresholds must satisfy warn < organize < relay');
  }
  return out;
}

/**
 * 从投影/计量读取压力。优先 projectedTokens（下一请求估算：compaction 遮蔽后立即下降，
 * organize/哨兵才能看到真实变化）；缺失时退回 provider 上报的 pressureTokens
 * （最近一次请求用量，不随本轮增长、compaction 自身无 usage 故不下降）；
 * 再缺退回 tokenMeter.totalTokens（无窗口）。
 */
export function readPressure({ projection, measurement } = {}) {
  const p = projection ?? {};
  const window = finitePositive(p.contextWindow) ? p.contextWindow : undefined;
  const reported = finitePositive(p.pressureTokens) ? p.pressureTokens : undefined;
  const projected = finitePositive(p.projectedTokens) ? p.projectedTokens : undefined;
  const total = finitePositive(measurement?.totalTokens) ? measurement.totalTokens : undefined;
  const used = projected ?? reported ?? total;
  return {
    used: used === undefined ? undefined : Math.round(used),
    window: window === undefined ? undefined : Math.round(window),
    ratio: window !== undefined && used !== undefined ? used / window : undefined,
    source: projected !== undefined ? 'projected' : reported !== undefined ? 'pressure' : total !== undefined ? 'meter' : 'unavailable',
  };
}

/**
 * 分档：窗口已知（>0）时**只用比例线**；窗口未知 / 为 0 时才退回绝对 token 线。
 * 依据 02：40% 不是普适悬崖，但 1M 窗口下绝对 100k 线 ≈ 9.8% 会过早触发，
 * 所以绝对线只作窗口未知时的兜底，不再与比例线「取更严」。
 *
 * D-04（v0.10 C6）：指标/投影/计量全部不可用（used 缺失）时显式返回 band='unavailable'，
 * **不再静默当 ok**——不参与升线/预算闸门/容量保全，由 notice/plan.js 的 M-14 一次性保守提示
 * 要求人工确认上下文余量（host 冷启动/投影缺失也可观测）。
 */
export function bandFor(pressure, thresholds = thresholdsFromPercent()) {
  const t = thresholds;
  const used = pressure?.used;
  if (used === undefined) return { band: 'unavailable', basis: 'unavailable', used };
  if (!finitePositive(pressure.window)) {
    const tokenBand = used >= t.relayTokens ? 'relay' : used >= t.organizeTokens ? 'organize' : used >= t.warnTokens ? 'warn' : 'ok';
    return { band: tokenBand, basis: 'tokens', used, tokenBand };
  }
  const ratio = used / pressure.window;
  const band = ratio >= t.relayRatio ? 'relay' : ratio >= t.organizeRatio ? 'organize' : ratio >= t.warnRatio ? 'warn' : 'ok';
  return { band, basis: 'ratio', used, window: Math.round(pressure.window), ratio: round4(ratio) };
}

/** 是否该做一次上下文整理（organize 档以上，或显式 force）。 */
export function shouldOrganize(state, force = false) {
  if (force === true) return { organize: true, reason: 'forced' };
  if (state?.band === 'organize' || state?.band === 'relay') return { organize: true, reason: 'threshold:' + state.band };
  return { organize: false, reason: 'below-threshold:' + String(state?.band ?? 'ok') };
}

/**
 * 「压缩继续 vs 接力开新会话」的人类选择题：两个都是可选动作，插件不默认执行。
 * 到 phase 边界且 band ≥ organize 时必须由人类选；本函数给出选项、推荐与理由。
 * 推荐口径：relay 档 → 接力；本会话已压缩过 1 次 → 接力（避免二次压缩叠加漂移）；否则 → 压缩。
 * v0.3.8/v0.4.0：面板模式（人类设置，持久）优先于规则推荐——模型侧建议必须与人类选择一致；
 * 已压缩过时面板明确选「压缩继续」也按人类选择执行（审批仍由 autoCompress/authorizeNext 决定）。
 */
export function continueChoice(state, organizeCount = 0, panel = undefined) {
  const band = state?.band;
  if (band !== 'organize' && band !== 'relay') return undefined;
  const count = Number.isFinite(organizeCount) ? Math.max(0, Math.trunc(organizeCount)) : 0;
  const preset = PANEL_OPERATIONS.includes(panel?.defaultOperation) ? panel.defaultOperation : null;
  let recommendation;
  let reason;
  if (preset === 'compress') {
    recommendation = 'organize';
    reason = '面板模式=压缩继续（人类已选；已压缩过也按人类选择执行，审批仍按 autoCompress/authorizeNext）';
  } else if (preset === 'handoff') {
    recommendation = 'handoff';
    reason = '面板模式=接力新会话（人类已选；按模式执行，审批仍按 autoHandoff/authorizeNext）';
  } else if (preset === 'continue') {
    recommendation = 'continue';
    reason = '面板模式=继续（人类已选：不压缩不接力）';
  } else {
    recommendation = band === 'relay' || count >= 1 ? 'handoff' : 'organize';
    reason = band === 'relay'
      ? '已到 relay 硬上限：必须收尾；推荐接力开新会话（人类坚持留同会话则只允许压缩一次，下个 phase 边界必须接力）'
      : count >= 1
        ? '本会话已压缩过 1 次：再次压缩会叠加摘要漂移，推荐接力开新会话'
        : '本会话还没压缩过：首次压缩成本低且保留对话细节；想要干净上下文也可选接力';
  }
  return {
    needed: true,
    band,
    organizeCount: count,
    recommendation,
    reason,
    preset,
    options: [
      { id: 'organize', label: '压缩后继续同一会话', tradeoff: '保留对话细节；有损压缩会丢失已遮蔽的细节，多次压缩会累积漂移' },
      { id: 'handoff', label: '接力开新会话', tradeoff: '干净上下文；只带结构化交接单（≤8KB），未落盘的对话细节会丢；需人类 Go/消耗额度' },
    ],
    ask: '到 phase 边界先向人类列这两个选项（一次问清、附推荐与默认），人类选定后才执行对应工具；不要自行压缩或接力。',
  };
}

/**
 * 主动上下文管理推荐（v0.11 P0-D §3.4.5）：同一口径服务起点提醒与到线 notice 改写。
 * 面板模式优先；capacity 是唯一 last-resort；warn 不再推荐继续（除非面板显式设为继续）。
 * 返回 {operation:'continue'|'organize'|'handoff', reason, fromPanel, tone: preventive|now|fallback|last-resort}。
 */
export function contextCheckChoice({ band, organizeCount = 0, panel, trigger, capacityAtRisk } = {}) {
  const count = Number.isFinite(organizeCount) ? Math.max(0, Math.trunc(organizeCount)) : 0;
  const preset = PANEL_OPERATIONS.includes(panel?.defaultOperation) ? panel.defaultOperation : null;
  const tone = capacityAtRisk === true
    ? 'last-resort'
    : band === 'relay' || band === 'organize'
      ? 'fallback'
      : band === 'warn'
        ? 'now'
        : 'preventive';
  if (preset !== null) {
    const operation = preset === 'compress' ? 'organize' : preset;
    return { operation, reason: '面板模式已由人类设定，优先遵循面板', fromPanel: true, tone };
  }
  if (capacityAtRisk === true) {
    return {
      operation: 'handoff',
      reason: 'capacity 最坏兜底：已逼近硬窗口，立即收尾；按授权压缩或交接，不自动执行',
      fromPanel: false,
      tone: 'last-resort',
    };
  }
  if (band === 'relay') {
    return {
      operation: 'handoff',
      reason: 'relay 45% 兜底告警升级：已超预期，立即收尾并在最近边界交接',
      fromPanel: false,
      tone: 'fallback',
    };
  }
  if (band === 'organize') {
    return {
      operation: count >= 1 ? 'handoff' : 'organize',
      reason: count >= 1
        ? 'organize 35% 兜底告警：本应已在 warn 前管理；已压缩过，再压有漂移风险'
        : 'organize 35% 兜底告警：本应已在 warn 前管理；最近边界压缩或交接',
      fromPanel: false,
      tone: 'fallback',
    };
  }
  if (band === 'warn') {
    return {
      operation: count >= 1 ? 'handoff' : 'organize',
      reason: count >= 1
        ? 'warn 30%：现在就该动手——已压缩过，推荐交接（再压有漂移风险）'
        : 'warn 30%：现在就该动手——未压缩过，先压缩继续最便宜',
      fromPanel: false,
      tone: 'now',
    };
  }
  if (band === 'unavailable') {
    return {
      operation: 'continue',
      reason: '上下文指标不可用（band=unavailable）：保守继续，先人工确认余量（不猜）',
      fromPanel: false,
      tone: 'preventive',
    };
  }
  return {
    operation: 'continue',
    reason: '余量充足：本次任务/phase 预估可完成；边界再评估'
      + (trigger === 'task' ? '；若任务超出预估，warn 时立即处理' : ''),
    fromPanel: false,
    tone: 'preventive',
  };
}

/** 预算可行性动作（relay_phase.budget_plan.action，2026-11-01 phase 优先协议）。 */
export const BUDGET_ACTIONS = Object.freeze(['proceed', 'split', 'relay']);

/**
 * phase 预算余量（phase 优先协议的数据基础）：距 warn / organize / relay 线的剩余 tokens。
 * 窗口已知时线 = round(window × ratio)；窗口未知时才用绝对 *Tokens 兜底。负值归 0。
 * 用于：relay_status.budget（开 phase 前看 headroom）、relay_phase warn 档预算闸门、跨 phase 复查。
 */
export function phaseBudget(pressure, thresholds = thresholdsFromPercent()) {
  const state = bandFor(pressure, thresholds);
  // 窗口判定直接用 pressure.window：bandFor 在 used 缺失时会提前返回 unavailable（不带 window），
  // 但「窗口已知」这一事实仍成立——此时线值仍应按比例算，避免 thresholds 误退回 *Tokens 兜底。
  const window = finitePositive(pressure?.window) ? Math.round(pressure.window) : undefined;
  const lineOf = (ratio, tokens) => (window === undefined ? tokens : Math.round(window * ratio));
  const used = state.used;
  const headroomOf = (line) => (used === undefined ? undefined : Math.max(0, line - used));
  const lines = {
    warn: lineOf(thresholds.warnRatio, thresholds.warnTokens),
    organize: lineOf(thresholds.organizeRatio, thresholds.organizeTokens),
    relay: lineOf(thresholds.relayRatio, thresholds.relayTokens),
  };
  return {
    band: state.band,
    basis: state.basis,
    used,
    window,
    ratio: state.ratio,
    headroomToWarn: headroomOf(lines.warn),
    headroomToOrganize: headroomOf(lines.organize),
    headroomToRelay: headroomOf(lines.relay),
    thresholds: lines,
  };
}

/**
 * 归一化 relay_phase({budget_plan})：切 phase 前的预算可行性估计。
 * 至少给 estimate_tokens 或 can_finish 之一（先估计再开 phase）；拒绝抛 Error（零副作用）。
 * action：proceed=放得下继续；split=拆票（缩小本 phase 范围）；relay=先做一次 relay 操作再开。
 */
export function normalizeBudgetPlan(input) {
  const refuse = (why) => { throw new Error('relay_phase refused (budget plan): ' + why); };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    refuse('切 phase 前先做预算可行性估计：budget_plan{action:' + BUDGET_ACTIONS.join('|') + ', can_finish?, estimate_tokens?, note?}——estimate_tokens=本 phase 预计消耗（缺省用上一 phase 实测消耗），can_finish=能否在阈值前完成；放不下就 action="split"（拆票：缩小本 phase 范围）或 action="relay"（先做一次 relay 操作再开）。');
  }
  const action = input.action;
  if (!BUDGET_ACTIONS.includes(action)) {
    refuse('budget_plan.action 必须是 ' + BUDGET_ACTIONS.join('|') + '（proceed=放得下继续；split=拆票缩小范围；relay=先做一次 relay 操作再开）。');
  }
  const estimate = input.estimate_tokens;
  if (estimate !== undefined && (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0)) {
    refuse('budget_plan.estimate_tokens 必须是非负有限数（本 phase 预计消耗 tokens）。');
  }
  const canFinish = input.can_finish;
  if (canFinish !== undefined && typeof canFinish !== 'boolean') {
    refuse('budget_plan.can_finish 必须是布尔。');
  }
  if (estimate === undefined && canFinish === undefined) {
    refuse('budget_plan 至少给 estimate_tokens 或 can_finish 之一——先估计本 phase 能否在阈值前完成，再决定 proceed/split/relay。');
  }
  const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
  return { action, estimateTokens: estimate, canFinish, note: note === '' ? undefined : note };
}

/**
 * budget_plan 闸门（纯函数，供 relay_phase warn 档切 phase 用）：
 * ① action=relay → 先做 relay 操作；② 声明放得下（can_finish=true）但 estimate > headroom = 矛盾；
 * ③ can_finish=false 却 action=proceed → 拒绝。estimate 缺省用上一 phase 实测消耗。
 */
export function budgetGate(plan, budget, lastPhaseCostTokens) {
  const estimateTokens = plan.estimateTokens ?? (Number.isFinite(lastPhaseCostTokens) ? lastPhaseCostTokens : undefined);
  const headroom = budget?.headroomToOrganize;
  const fits = plan.canFinish !== undefined
    ? plan.canFinish
    : estimateTokens !== undefined && headroom !== undefined ? estimateTokens <= headroom : undefined;
  const facts = { action: plan.action, estimateTokens, canFinish: plan.canFinish, fits, headroomToOrganize: headroom };
  if (plan.action === 'relay') return { ok: false, code: 'relay-op-first', facts, ...facts };
  if (fits === true && estimateTokens !== undefined && headroom !== undefined && estimateTokens > headroom) {
    return { ok: false, code: 'estimate-over-headroom', facts, ...facts };
  }
  if (fits === false && plan.action === 'proceed') return { ok: false, code: 'phase-does-not-fit', facts, ...facts };
  return { ok: true, ...facts };
}

/** phase 校验；空值取默认 discover。 */
export function normalizePhase(value, fallback = 'discover') {
  if (value === undefined || value === null || value === '') return fallback;
  const phase = String(value).trim().toLowerCase();
  if (!PHASES.includes(phase)) throw new Error('context-relay: unknown phase "' + String(value) + '"; expected one of ' + PHASES.join('|'));
  return phase;
}

export function normalizePhaseState(value, fallback = 'discover') {
  if (value === undefined || value === null || value === '') return fallback;
  const phase = String(value).trim().toLowerCase();
  if (!ALL_PHASES.includes(phase)) throw new Error('context-relay: unknown phase "' + String(value) + '"; expected one of ' + ALL_PHASES.join('|'));
  return phase;
}

export const isExitPhase = (value) => PHASE_EXITS.includes(value);

/** 只使用已知硬窗口与实际用量，不把预算线当作容量线。 */
export function capacityOf(pressure, { ratio = CAPACITY_PRESERVE_RATIO } = {}) {
  // ratio 仅为测试可调：非 (0,1) 的非法值回落常量（容量线不进 settings，D7=A）。
  const threshold = finitePositive(ratio) && ratio < 1 ? ratio : CAPACITY_PRESERVE_RATIO;
  const known = finitePositive(pressure?.window) && typeof pressure?.used === 'number' && Number.isFinite(pressure.used) && pressure.used >= 0;
  if (!known) return { atRisk: false, ratio: undefined, threshold, basis: 'unavailable' };
  const usedRatio = pressure.used / pressure.window;
  return { atRisk: usedRatio >= threshold, ratio: usedRatio, threshold, basis: 'ratio' };
}

/** D1=B：只提醒不拒绝；返回统计，不落 report 原文。 */
export function userReportWarnings(report, { detailsRequested = false } = {}) {
  const text = typeof report === 'string' ? report.trim() : '';
  const chars = [...text].length;
  const warnings = [];
  const template = 'warning（不阻断）：建议四段式（结论/影响/需要你做什么/证据位置）且默认≤600字；细节放 L2 文档只给路径，不贴命令输出/日志；本次 ship 不因此被拒，按提示补正文即可。';
  const tags = [...text.matchAll(/^[ \t]*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?(结论|影响|需要你(?:做什么)?|证据位置)(?:\*\*|__)?\s*[:：]?(?:\*\*|__)?[ \t]*/gm)];
  const names = tags.map((m) => m[1].startsWith('需要你') ? '需要你做什么' : m[1]);
  const formatOk = names.join('|') === '结论|影响|需要你做什么|证据位置'
    && tags.every((m, i) => text.slice(m.index + m[0].length, tags[i + 1]?.index ?? text.length).replace(/[*_#\s]/g, '') !== '');
  if (text === '') warnings.push({ code: 'report-empty', message: '汇报为空；user_gate.report 仍须非空。' });
  if (!formatOk) warnings.push({ code: 'report-format', message: template });
  const limit = detailsRequested ? USER_REPORT_LIMITS.detailedMaxChars : USER_REPORT_LIMITS.maxChars;
  if (chars > limit) warnings.push({ code: 'report-too-long', message: 'warning（不阻断）：汇报共 ' + chars + ' 字，建议≤' + limit + '字；细节移入文档。' });
  // details_requested=true 时用户已授权展开细节：不产 internal-details 提示（仅提示层放宽，不是硬拒豁免）。
  if (!detailsRequested) {
    const dump = /(?:^|\n)\s*(?:\$ |>>> |\[exit code:|(?:stdout|stderr|命令输出|日志输出)\s*[:：]|diff --git|@@ |\d{4}-\d{2}-\d{2}[^\n]*(?:INFO|WARN|ERROR))/m.test(text)
      || text.split('\n').filter((line) => /^[+-](?![+-])/.test(line)).length > 8;
    if (dump || /\x60{3}|~{3}/.test(text) || text.split('\n').some((line) => [...line].length > USER_REPORT_LIMITS.maxLineChars)) {
      warnings.push({ code: 'report-internal-details', message: 'warning（不阻断）：不倾倒命令输出/日志/长 diff，正文给人话结论与证据路径。' });
    }
  }
  return { ok: warnings.length === 0, chars, formatOk, warnings, ...(detailsRequested ? { info: '用户已授权展开细节' } : {}) };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function pct(ratio) {
  return ratio === undefined ? '?' : (Math.round(ratio * 1000) / 10).toFixed(1) + '%';
}

function list(value) {
  if (!Array.isArray(value)) return [];
  // 归一化单行：换行/连续空白压成单空格，避免用户/模型文本伪造 markdown 标题破坏结构。
  return value.map((v) => String(v).replace(/\s+/g, ' ').trim()).filter((v) => v !== '');
}

/** 空段直接跳过（返回空串，不再输出「（无）」）；单值（字符串）也接受，供 goal/exitCriteria 使用。 */
function section(title, value) {
  const body = list(Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);
  if (body.length === 0) return '';
  return '## ' + title + '\n' + body.map((item) => '- ' + item).join('\n');
}

const onOff = (value) => (value === true ? 'on' : 'off');

/**
 * continue 行的「审批事实」后缀（v0.5.1）：以前硬编码「压缩/接力仍需审批」，面板已开
 * autoCompress / autoHandoff / authorizeNext 时同样照说——模型因此误判「没授权」而不敢压缩。
 * 有面板信息按真实开关渲染；没有（旧调用方/单测）保持旧文案。
 */
function authorizationSuffix(panel) {
  if (panel === undefined || panel === null) return '；压缩/接力仍需审批';
  return '；压缩免审=' + onOff(panel.autoCompress) + ' · 接力免审=' + onOff(panel.autoHandoff) + ' · 授权下一次=' + onOff(panel.authorizeNext);
}

/** 人类可读的紧凑状态（供 relay_status 的 text 渲染；token 数字放证据层）。 */
export function formatStatus(report) {
  const t = report?.thresholds ?? thresholdsFromPercent();
  const lead = report?.lead ?? {};
  const lines = [];
  lines.push('phase: ' + (report?.phase ?? 'discover'));
  lines.push('lead: ' + pct(lead.ratio) + (lead.window !== undefined ? ' (' + lead.used + '/' + lead.window + ')' : lead.used !== undefined ? ' (' + lead.used + ' tokens)' : '') + ' band=' + String(lead.band ?? 'ok'));
  lines.push('thresholds: warn ' + pct(t.warnRatio) + ' / organize ' + pct(t.organizeRatio) + ' / relay ' + pct(t.relayRatio) + (lead.window === undefined ? '（窗口未知：兜底 ' + t.warnTokens + '/' + t.organizeTokens + '/' + t.relayTokens + ' tokens）' : ''));
  // Router P0 度量（可选行；无 execution/compaction 时整行不渲染）。
  const execution = report?.execution;
  const compaction = report?.compaction;
  const debtText = compaction === undefined || compaction === null
    ? ''
    : 'compaction debt: ' + (compaction.debt === true ? 'yes' : 'no') + '(' + String(compaction.count ?? 0) + ')';
  if (execution !== undefined && execution !== null) {
    lines.push('exec: ' + String(execution.calls ?? 0) + '/' + String(execution.total ?? 0) + ' calls (' + pct(execution.ratio) + ')' + (debtText === '' ? '' : ' · ' + debtText));
  } else if (debtText !== '') {
    lines.push(debtText);
  }
  // v0.9.0 批次3：delegation 度量行（可选；无 delegation 字段/旧调用整行不渲染，旧输出不变）。
  // basis unavailable 如实标注「仅参考」；idleWorkers null（团队不可用/非 Lead）显示 ?，不猜 0。
  const delegation = report?.delegation;
  if (delegation !== undefined && delegation !== null) {
    const calls = delegation.calls ?? {};
    const idle = Number.isInteger(delegation.idleWorkers) ? String(delegation.idleWorkers) : '?';
    lines.push('delegation: Lead 执行 ' + pct(delegation.execRatio) + '（' + String(calls.exec ?? 0) + '/' + String(calls.total ?? 0)
      + '，目标 ≤' + Math.round(DELEGATION_EXEC_RATIO_MAX * 100) + '% warn）· 派活 ' + String(delegation.dispatchCount ?? 0)
      + ' / 收口 ' + String(delegation.collectCount ?? 0) + ' · 空闲队友 ' + idle
      + (delegation.basis === 'unavailable' ? '（投影不可用，仅参考）' : ''));
    if (typeof delegation.advice === 'string' && delegation.advice !== '') lines.push('delegation-advice: ' + delegation.advice);
  }
  // 预算事实（phase 优先协议）：开 phase 前估计 / phase 完成时复查用。
  const budget = report?.budget;
  if (budget !== undefined && budget !== null) {
    const num = (value) => (value === undefined || value === null ? '?' : String(value));
    lines.push('budget: headroom→warn ' + num(budget.headroomToWarn) + ' / →organize ' + num(budget.headroomToOrganize) + ' / →relay ' + num(budget.headroomToRelay)
      + ' tokens · 本 phase 已消耗 ' + num(budget.currentPhaseCostTokens)
      + (budget.previousPhase === undefined || budget.previousPhase === null ? '' : ' · 上一 phase(' + String(budget.previousPhase.phase) + ') 实测 ' + num(budget.previousPhase.costTokens)));
  }
  if (report?.capacity?.atRisk === true) lines.push('capacity: ' + pct(report.capacity.ratio) + ' ≥ ' + pct(report.capacity.threshold) + ' → 容量保全（收尾/交接准备；预算档本身不构成中途打断例外）');
  const team = Array.isArray(report?.team) ? report.team : [];
  if (team.length > 0) {
    lines.push('team:');
    for (const member of team) {
      lines.push('- ' + String(member.name) + ' ' + pct(member.ratio) + ' ' + String(member.status ?? '?') + ' band=' + String(member.band ?? '?'));
    }
  }
  const choice = report?.continue;
  if (choice !== undefined && choice !== null) {
    // 结构化返回已瘦身（continue.options 移除）：选项 A/B 与阈值只保留在 text 里，模型照此问人类。
    // reason 只留在 JSON 字段（continue.reason），text 不重复占窗口。
    if (choice.preset !== undefined && choice.preset !== null) {
      lines.push('continue: 面板模式=' + operationLongLabelOf(choice.preset) + '（人类已选，按它执行' + authorizationSuffix(report?.panel) + '）');
    } else {
      lines.push('continue: 需人类选择（band=' + String(choice.band) + '，本会话已压缩 ' + String(choice.organizeCount) + ' 次；选项 A「压缩后继续同一会话」→ relay_organize / B「接力开新会话」→ relay_handoff）→ 推荐 ' + String(choice.recommendation));
    }
  }
  // 面板授权事实（v0.5.1）：模型只能从 text 读到面板状态，以前只有到线/phase 边界 notice 才带
  // autoCompress 等开关——人类中途打开自动授权后模型看不到，会误判「需要审批」。这里每次
  // relay_status 都给一行真实开关（无面板信息时整行不渲染，旧输出不变）。
  const panel = report?.panel;
  if (panel !== undefined && panel !== null) {
    lines.push('panel: 模式=' + operationLongLabelOf(panel.defaultOperation)
      + ' · autoCompress=' + onOff(panel.autoCompress)
      + ' · autoHandoff=' + onOff(panel.autoHandoff)
      + ' · authorizeNext=' + onOff(panel.authorizeNext));
  }
  // advice 只供宿主/UI 消费（面板 chip 等）：模型侧只收上面渲染的 text（tools.js relay_status 的 render 只读 v.text），
  // 结构化 advice 不进模型上下文——模型侧以 text + 到线提醒 + 超预算拒绝错误为准。
  return lines.join('\n');
}

/** phase 边界 brief（写盘 + 压缩成功后注入；含下一 phase 的 DoD）。只渲染非空段。 */
export function buildPhaseBrief({ phase, goal, exitCriteria, decisions, constraints, evidence, keyDocs, next } = {}) {
  const name = normalizePhase(phase);
  // 2026-11-08 用户需求：关键文件索引是压缩后接手第一入口，排在前部（注入超限时先截尾部证据，不截索引）。
  const parts = [
    section('目标', goal),
    section('退出条件', exitCriteria),
    section('关键文件索引（了解当前项目所需；先读入口；path — 作用 — 为何重要）', shapeDocList(keyDocs, HANDOFF_LIMITS.items.key_docs).items),
    section('已定决策', decisions),
    section('硬约束', constraints),
    section('证据指针', evidence),
    section('下一 phase', next),
  ].filter((part) => part !== '');
  return ['# Phase Brief · ' + name, '', ...parts, ''].join('\n');
}

/** 按 Unicode 码点截断（不切断 surrogate 对）；超长以省略号结尾。 */
function clipChars(text, limit) {
  const chars = Array.from(String(text));
  return chars.length <= limit ? chars.join('') : chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
}

/** 归一化列表：压成单行、去空白（结构约束，不是体积截断——完整版同样适用）。 */
function normalizeList(value) {
  return list(value);
}

/**
 * 关键文档：先 posix.normalize 再判定，只收 workspace 相对 POSIX 路径。
 * `~` 前缀、绝对路径、盘符、反斜杠、`..` 越界、空段一律丢弃；`./` 与重复斜杠被规范化掉，并去重。
 * 这是结构/安全约束（与体积无关），完整版也走同一份白名单。
 */
function normalizeDocList(value) {
  const safe = normalizeList(value)
    .map((path) => posix.normalize(path))
    .filter((path) => path.startsWith('~') === false
      && path.startsWith('/') === false
      && /^[A-Za-z]:/.test(path) === false
      && path.includes('\\') === false
      && path !== '.'
      && path.split('/').every((segment) => segment !== '..' && segment !== ''));
  return [...new Set(safe)];
}

/** 摘要用有界列表：截条数 + 截单条（advisory），返回用量供 caps 标注；完整版不做这一步。 */
function shapeList(items, limit) {
  const kept = items.slice(0, limit);
  const clipped = kept.map((item) => clipChars(item, HANDOFF_LIMITS.itemChars));
  return {
    items: clipped,
    used: clipped.length,
    dropped: items.length - kept.length,
    clipped: clipped.filter((item, index) => item !== kept[index]).length,
  };
}

/** 关键文档摘要版：白名单 + advisory 条数/单条裁剪。 */
function shapeDocList(value, limit) {
  return shapeList(normalizeDocList(value), limit);
}

function capsLine(info) {
  const itemText = Object.keys(HANDOFF_LIMITS.items)
    .map((key) => key + ' ' + info.items[key].used + '/' + HANDOFF_LIMITS.items[key])
    .join(' · ');
  return clipChars(
    'caps (advisory): bytes ' + info.bytesUsed + ' · ' + itemText + ' · truncated=' + (info.truncated ? 'yes' : 'no'),
    300,
  );
}

/**
 * 渲染一份 handoff markdown。
 * - full=false：摘要（注入新会话首条消息）——按 budget 做 advisory 截断，超预算整段/尾部丢弃并记账；
 * - full=true：完整版（写盘真源）——预算无限，列表不做条数/单条裁剪（只保留结构必需的单行归一化）。
 */
function renderHandoff({ goal, phase, lists, info, when, sessionId, budget, full = false }) {
  const lines = [];
  let used = 0;
  /** 这里只记「字节预算导致的截断」；条目级截断由 caps 单独标注。 */
  let truncated = false;
  const dropped = [];
  const push = (line) => {
    const text = String(line ?? '');
    const size = Buffer.byteLength(text, 'utf8') + 1;
    if (used + size > budget) {
      truncated = true;
      return false;
    }
    lines.push(text);
    used += size;
    return true;
  };
  const pushSection = (title, entries) => {
    // 预算不足时该段记入 dropped，但继续尝试后续更短的段（状态段排在最前，优先拿到预算；
    // 后续短段仍可能塞进剩余字节，不再整段硬停。dropped 完整才能让 caps.truncatedSections 准确）。
    if (!push('## ' + title)) {
      dropped.push(title);
      return;
    }
    if (entries.length === 0) {
      if (!push('（无）')) dropped.push(title);
      return;
    }
    for (const entry of entries) {
      if (!push('- ' + entry)) {
        dropped.push(title);
        break;
      }
    }
  };

  push('# Handoff · ' + clipChars(goal, 120));
  push('');
  push('> created: ' + when + ' | from session: ' + (full ? sessionId : clipChars(sessionId, 80)) + ' | phase: ' + phase);
  push('> ' + capsLine(info));
  push('> 本文件是接力后新团队的第一手上下文；旧会话保留为审计档，不再派活。');
  push('');

  pushSection('状态', [
    // 摘要正文 goal 截断：超长 goal 不挤掉状态段；完整版保留原文。
    '目标：' + (full ? goal : clipChars(goal, 200)),
    ...lists.success_criteria.map((item) => '成功标准：' + item),
    ...lists.next_actions.map((item) => '下一步（DoD）：' + item),
    ...lists.blocked.map((item) => '阻塞：' + item),
    ...lists.done.map((item) => '已完成：' + item),
  ]);
  pushSection('首条指令', ['你是接力后的新 Lead。先确认本文件中的目标与未决问题，用 relay_phase 声明当前 phase，再按 phase 派活；不要自行裁决 P0 未决项。']);
  if (lists.key_docs.length > 0) pushSection('关键文档（workspace 相对路径；先读入口）', lists.key_docs);
  pushSection('证据（文件/命令/URL/会话 id）', lists.evidence);
  pushSection('已定决策（含理由）', lists.decisions);
  pushSection('未决问题（按 P0/P1/P2 标注，P0 必须人类裁决）', lists.open_questions);
  pushSection('风险与回滚', lists.risks);
  pushSection('硬约束', lists.constraints);
  pushSection('明确丢弃的上下文', lists.discarded);

  return { markdown: lines.join('\n') + '\n', bytes: Buffer.byteLength(lines.join('\n') + '\n', 'utf8'), truncated, dropped };
}

/** 渲染直到 capsLine 里的字节数稳定（行宽变化会轻微改变总字节）。 */
function renderStable(render, initialInfo) {
  let info = initialInfo;
  let rendered = render(info);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = { ...info, bytesUsed: rendered.bytes };
    const stable = next.bytesUsed === info.bytesUsed && next.truncated === info.truncated;
    info = next;
    if (stable) break;
    rendered = render(info);
  }
  return { rendered, info };
}

/**
 * 结构化 handoff 双输出（v0.8.0「文档系统 v2」）：
 * - markdown：摘要（注入新会话首条消息；按 advisory 预算有界，超预算整段/尾部截断 + 显式 marker）；
 * - fullMarkdown：完整版（写盘真源；全部字段/条目/原文，不截断不丢段）；
 * - caps：保留现有字段形状（bytes/chars/items/truncated/truncatedSections）+ fullBytes/split/warnings。
 * 只有 goal 缺失等非法输入才抛错——体积不再触发拒绝。
 * @returns {{markdown: string, fullMarkdown: string, caps: object}}
 */
export function buildHandoff(input = {}) {
  const source = input ?? {};
  const status = source.status ?? {};
  // goal 也归一化成单行：换行会把标题/状态段拆开，伪造 markdown 结构。
  const goal = String(status.goal ?? '').replace(/\s+/g, ' ').trim();
  if (goal === '') throw new Error('context-relay: goal is required for a handoff');
  // v0.9.0 #10/M4：交接单状态段 phase 允许 5 主链 + 2 显式出口（blocked/cancel 会话也可交接）。
  const phase = normalizePhaseState(status.phase, 'discover');
  const limits = HANDOFF_LIMITS.items;
  const budget = finitePositive(source.summaryBytes) ? Math.trunc(source.summaryBytes) : HANDOFF_SUMMARY_BYTES;
  // 完整版列表：只做结构归一化（单行/路径白名单），不截条数、不截单条。
  const full = {
    evidence: normalizeList(source.evidence),
    key_docs: normalizeDocList(source.key_docs),
    done: normalizeList(status.done),
    success_criteria: normalizeList(status.success_criteria),
    next_actions: normalizeList(status.next_actions),
    blocked: normalizeList(status.blocked),
    decisions: normalizeList(source.decisions),
    constraints: normalizeList(source.constraints),
    risks: normalizeList(source.risks),
    open_questions: normalizeList(source.open_questions),
    discarded: normalizeList(source.discarded),
  };
  // 摘要版列表：advisory 条数/单条上限（摘要只收短的；完整条目在 fullMarkdown）。
  const shaped = Object.fromEntries(Object.keys(limits).map((key) => [key, shapeList(full[key], limits[key])]));
  const summaryLists = Object.fromEntries(Object.keys(limits).map((key) => [key, shaped[key].items]));
  const summaryItems = Object.fromEntries(Object.keys(limits).map((key) => [key, { used: shaped[key].used, limit: limits[key] }]));
  const fullItems = Object.fromEntries(Object.keys(limits).map((key) => [key, { used: full[key].length, limit: limits[key] }]));
  const goalClipped = Array.from(goal).length > 200;
  const itemTruncated = goalClipped || Object.keys(limits).some((key) => shaped[key].dropped > 0 || shaped[key].clipped > 0);
  // 两类原因分开记账（v0.2.6）：条数超上限（items:key）vs 单条超 200 字符（chars:key）。
  const itemSections = [
    ...(goalClipped ? ['goal'] : []),
    ...Object.keys(limits).flatMap((key) => [
      ...(shaped[key].dropped > 0 ? ['items:' + key] : []),
      ...(shaped[key].clipped > 0 ? ['chars:' + key] : []),
    ]),
  ];
  const when = source.createdAt ?? new Date().toISOString();
  const sessionId = String(source.sessionId ?? 'unknown');

  // 完整版：预算无限、不裁剪；capsLine 的 bytes 迭代到稳定。
  const fullRender = renderStable(
    (info) => renderHandoff({ goal, phase, lists: full, info, when, sessionId, budget: Infinity, full: true }),
    { items: fullItems, bytesUsed: 0, truncated: false },
  );
  const fullMarkdown = fullRender.rendered.markdown;

  // 摘要：预算里预留 marker 空间；超预算整段/尾部截断后追加显式 marker（完整内容在 fullMarkdown/文件）。
  const markerBytes = Buffer.byteLength(HANDOFF_SUMMARY_MARKER, 'utf8') + 1;
  const contentBudget = Math.max(0, budget - markerBytes);
  const renderSummary = (info) => renderHandoff({ goal, phase, lists: summaryLists, info, when, sessionId, budget: contentBudget });
  let summaryInfo = { items: summaryItems, bytesUsed: 0, truncated: itemTruncated };
  let summaryRendered = renderSummary(summaryInfo);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const truncated = itemTruncated || summaryRendered.truncated;
    const next = { items: summaryItems, bytesUsed: summaryRendered.bytes + (truncated ? markerBytes : 0), truncated };
    const stable = next.bytesUsed === summaryInfo.bytesUsed && next.truncated === summaryInfo.truncated;
    summaryInfo = next;
    if (stable) break;
    summaryRendered = renderSummary(summaryInfo);
  }
  const summaryMarkdown = summaryInfo.truncated ? summaryRendered.markdown + HANDOFF_SUMMARY_MARKER + '\n' : summaryRendered.markdown;
  const summaryBytes = Buffer.byteLength(summaryMarkdown, 'utf8');
  const fullBytes = Buffer.byteLength(fullMarkdown, 'utf8');
  const split = summaryMarkdown !== fullMarkdown;
  const truncatedSections = [...new Set([
    ...itemSections,
    ...summaryRendered.dropped.map((title) => 'section:' + title),
    ...(summaryRendered.truncated ? ['bytes'] : []),
  ])];
  const warnings = [];
  if (split) {
    warnings.push('handoff 摘要（注入新会话的首条消息）为 ' + summaryBytes + '/' + budget + ' B（advisory 预算）：完整内容 '
      + fullBytes + ' B 已写入 handoff 文件（fullMarkdown，不截断、不丢数据）'
      + (truncatedSections.length > 0 ? '；摘要相对完整版精简：' + truncatedSections.join(', ') : '')
      + '。caps 只做建议，不拒绝交接。');
  }
  const caps = {
    bytes: { used: summaryBytes, limit: budget },
    // chars 统一为 Unicode 码点口径（与 itemChars 截断一致；不用 UTF-16 code unit）。
    chars: { used: Array.from(summaryMarkdown).length, itemLimit: HANDOFF_LIMITS.itemChars },
    items: summaryItems,
    truncated: summaryInfo.truncated,
    truncatedSections,
    fullBytes,
    split,
    warnings,
  };
  return { markdown: summaryMarkdown, fullMarkdown, caps };
}

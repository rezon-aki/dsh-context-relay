/**
 * dsh-context-relay — 纯函数策略层（无 IO、无 ctx，可单测）。
 *
 * 职责：阈值归一化 / 压力分档 / phase 校验 / 人类可读状态 / phase brief / 有界 handoff。
 * 设计依据：docs/research/01-dsh-architecture.md（40% 不是内核概念，须插件层实现）、
 *          04-human-agent-protocol.md（P0/P1/P2、handoff 七字段、一次 Go/No-go）。
 *
 * 阈值口径（2026-10-20 用户明确要求；2026-11-01 用户把默认基准改为 35%）：窗口已知时**只用比例线**
 * （新部署默认基准 35% → warn 30% / organize 35% / relay 45%）；绝对 token 线只在窗口未知 / 为 0 时兜底
 * （保留原 100k/130k/160k 配置作 fallback）。DEFAULT_THRESHOLDS 是 legacy config.thresholds 路径的兜底默认比例
 * （0.35/0.40/0.50，仅部署显式配置 legacy 阈值时使用），不是新部署的生效默认。
 */

import { posix } from 'node:path';

export const PHASES = ['discover', 'decide', 'build', 'verify', 'ship'];

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** legacy config.thresholds 路径的兜底默认比例（新部署默认走 DEFAULT_SETTINGS.threshold=35 → 30/35/45）。 */
  warnRatio: 0.35,
  organizeRatio: 0.4,
  relayRatio: 0.5,
  /** 绝对 token 兜底（仅在窗口未知时使用；社区经验拐点约 100k）。 */
  warnTokens: 100000,
  organizeTokens: 130000,
  relayTokens: 160000,
});

export const BANDS = ['ok', 'warn', 'organize', 'relay'];

/**
 * 侧栏可配置的 relay 设置（2026-10-25 v2 口径）：阈值基准（%）+ 面板各选项的默认值。
 * 阈值口径：基准 = 二次提醒阈值（organize），提醒 = 基准 − 5%，硬线 = 基准 + 10%
 * ——默认基准 35% → 30% / 35% / 45%（2026-11-01 用户把默认从 40% 改为 35%）。
 * 这里只存「默认值」：composer 面板按会话覆盖（见 panel-store）；新会话未改面板时用这些默认。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  threshold: 35,
  defaultOperation: null,
  autoChoose: false,
  autoCompress: false,
  autoHandoff: false,
  /** 「你的 token 预算无上限」注入的**默认值**（默认开；侧栏 UI 已移除，改由 composer 模型选择器旁的小胶囊按会话控制，v0.2.7）。 */
  unlimitedBudget: true,
});

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
  return {
    threshold: raw === undefined ? DEFAULT_SETTINGS.threshold : Math.min(85, Math.max(20, Math.round(raw))),
    defaultOperation: PANEL_OPERATIONS.includes(source.defaultOperation) ? source.defaultOperation : null,
    autoChoose: source.autoChoose === true,
    autoCompress: source.autoCompress === true,
    autoHandoff: source.autoHandoff === true,
    unlimitedBudget: unlimited === undefined ? DEFAULT_SETTINGS.unlimitedBudget : unlimited,
  };
}

/**
 * 面板「默认操作」：压缩继续 / 接力新会话 / 继续（不拦新 phase）/
 * 压缩→新会话（第一次到线压缩，第二次到线接力）；null = 问我。
 * 一次性语义：过线并完成 phase 时按此执行一次，用掉即清空（compress-then-handoff 是两段：
 * 第一段压缩后保留预设，第二段接力后清空）。
 */
export const PANEL_OPERATIONS = Object.freeze(['compress', 'handoff', 'continue', 'compress-then-handoff']);

/**
 * 面板状态（按会话）：默认操作 + 四个自动授权 + 模型自决。
 * - autoChoose：模型自动选择压缩/新会话（不再问人）
 * - autoCompress：压缩操作自动授权（任何压缩不再走审批；rev5.4）
 * - autoHandoff：开新会话自动授权（relay_handoff 不再走审批）
 * - authorizeNext：一次性预授权「下一次 relay 操作执行」免官方审批（成功即消费，无 TTL）
 * - autoDecision：内部字段——模型经 relay_phase({next_operation}) 记录的下一次操作（一次性消费）
 */
// 面板状态默认基线：字段与 normalizePanelState 输出一致（13 字段），保留导出供 panel-store/测试派发默认值。
// 历史内部字段 handoffPreAuthorized 已删除：旧 panel.json 里的该键由白名单归一丢弃。
export const DEFAULT_PANEL_STATE = Object.freeze({
  defaultOperation: null,
  autoChoose: false,
  autoCompress: false,
  autoHandoff: false,
  handedOff: false,
  authorizeNext: false,
  autoDecision: null,
  // v0.2.7：本会话「你的 token 预算无上限」注入开关（null=跟随 settings 默认；panelDefaultsOf 会补出生效值）。
  unlimitedBudget: null,
  // v0.2.7：交接后新会话的注入设置（null=跟随当前会话生效值；true/false=强制开/关）。
  handoffUnlimitedBudget: null,
  // v0.2.14：下一次 relay_handoff 创建的新会话使用的 agent preset（null=跟随本会话 preset；成功后 sticky 不消费）。
  handoffPreset: null,
  // v0.3.3：模型推荐（只做面板高亮/参考；绝不参与预设/授权决策）。op=null 时 reason=''、at=null。
  recommendedOperation: null,
  recommendedReason: '',
  recommendedAt: null,
});

/**
 * 归一化面板状态：非法默认操作归 null，布尔严格化。
 * 先局部求值 operation/autoChoose 再判 autoDecision（不依赖对象字面量的求值顺序）；
 * autoDecision 只依赖 autoChoose —— 与 defaultOperation 无关（侧栏默认值常非 null，不能因此让自决失效）。
 */
export function normalizePanelState(input = {}) {
  const operation = PANEL_OPERATIONS.includes(input?.defaultOperation) ? input.defaultOperation : null;
  const autoChoose = input?.autoChoose === true;
  const decision = input?.autoDecision;
  const autoDecision = autoChoose === true
    && decision !== null && typeof decision === 'object'
    && (decision.operation === 'compress' || decision.operation === 'handoff')
    && Number.isFinite(decision.at)
    ? { operation: decision.operation, at: decision.at }
    : null;
  // v0.3.3 模型推荐：op 只认 PANEL_OPERATIONS；reason 只收字符串（trim + ≤120）；at 只收有限正数（trunc）。
  // op=null 时不保留理由/时间（旧脏记录归一后不会出现「有理由没操作」的半截推荐）。
  const recommendedOperation = PANEL_OPERATIONS.includes(input?.recommendedOperation) ? input.recommendedOperation : null;
  const recommendedReason = recommendedOperation !== null && typeof input?.recommendedReason === 'string'
    ? input.recommendedReason.trim().slice(0, 120)
    : '';
  const recommendedAt = recommendedOperation !== null && finitePositive(input?.recommendedAt) ? Math.trunc(input.recommendedAt) : null;
  return {
    defaultOperation: operation,
    autoChoose,
    autoCompress: input?.autoCompress === true,
    autoHandoff: input?.autoHandoff === true,
    // 内部字段：本会话已完成接力（归档）→ 不再注入任何到线提醒/重申。
    handedOff: input?.handedOff === true,
    authorizeNext: input?.authorizeNext === true,
    autoDecision,
    // v0.2.7：三值严格化（null=跟随默认/继承）。
    unlimitedBudget: triState(input?.unlimitedBudget),
    handoffUnlimitedBudget: triState(input?.handoffUnlimitedBudget),
    // v0.2.14：交接目标 preset（旧 panel.json 缺字段/脏值 → null；合法值范围另由 host PUT 按 relayPresetIds 校验）。
    handoffPreset: normalizePresetId(input?.handoffPreset),
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

/** preset id 字符集：字母/数字开头 + [A-Za-z0-9._-]，总长 1-64；其余（含旧脏值）归 null。 */
function normalizePresetId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
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
    warnTokens: DEFAULT_THRESHOLDS.warnTokens,
    organizeTokens: DEFAULT_THRESHOLDS.organizeTokens,
    relayTokens: DEFAULT_THRESHOLDS.relayTokens,
  });
}

/** handoff 有界 schema 的硬上限（见 buildHandoff）。 */
export const HANDOFF_LIMITS = Object.freeze({
  /** 整份 markdown 的 UTF-8 字节上限。 */
  totalBytes: 8192,
  /** 单条上限（Unicode 码点；截断不切断 surrogate 对）。 */
  itemChars: 200,
  /** 每个数组的条数上限。 */
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

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 归一化并校验阈值配置；比例必须严格递增且都 < 1。 */
export function normalizeThresholds(input = {}) {
  const out = {
    warnRatio: input.warnRatio ?? DEFAULT_THRESHOLDS.warnRatio,
    organizeRatio: input.organizeRatio ?? DEFAULT_THRESHOLDS.organizeRatio,
    relayRatio: input.relayRatio ?? DEFAULT_THRESHOLDS.relayRatio,
    warnTokens: input.warnTokens ?? DEFAULT_THRESHOLDS.warnTokens,
    organizeTokens: input.organizeTokens ?? DEFAULT_THRESHOLDS.organizeTokens,
    relayTokens: input.relayTokens ?? DEFAULT_THRESHOLDS.relayTokens,
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
 */
export function bandFor(pressure, thresholds = DEFAULT_THRESHOLDS) {
  const t = thresholds;
  const used = pressure?.used;
  if (used === undefined) return { band: 'ok', basis: 'unavailable', used };
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
 */
export function continueChoice(state, organizeCount = 0) {
  const band = state?.band;
  if (band !== 'organize' && band !== 'relay') return undefined;
  const count = Number.isFinite(organizeCount) ? Math.max(0, Math.trunc(organizeCount)) : 0;
  const recommendation = band === 'relay' || count >= 1 ? 'handoff' : 'organize';
  const reason = band === 'relay'
    ? '已到 relay 硬上限：必须收尾；推荐接力开新会话（人类坚持留同会话则只允许压缩一次，下个 phase 边界必须接力）'
    : count >= 1
      ? '本会话已压缩过 1 次：再次压缩会叠加摘要漂移，推荐接力开新会话'
      : '本会话还没压缩过：首次压缩成本低且保留对话细节；想要干净上下文也可选接力';
  return {
    needed: true,
    band,
    organizeCount: count,
    recommendation,
    reason,
    options: [
      { id: 'organize', label: '压缩后继续同一会话', tradeoff: '保留对话细节；有损压缩会丢失已遮蔽的细节，多次压缩会累积漂移' },
      { id: 'handoff', label: '接力开新会话', tradeoff: '干净上下文；只带结构化交接单（≤8KB），未落盘的对话细节会丢；需人类 Go/消耗额度' },
    ],
    ask: '到 phase 边界先向人类列这两个选项（一次问清、附推荐与默认），人类选定后才执行对应工具；不要自行压缩或接力。',
  };
}

/** 预算可行性动作（relay_phase.budget_plan.action，2026-11-01 phase 优先协议）。 */
export const BUDGET_ACTIONS = Object.freeze(['proceed', 'split', 'relay']);

/**
 * phase 预算余量（phase 优先协议的数据基础）：距 warn / organize / relay 线的剩余 tokens。
 * 窗口已知时线 = round(window × ratio)；窗口未知时才用绝对 *Tokens 兜底。负值归 0。
 * 用于：relay_status.budget（开 phase 前看 headroom）、relay_phase warn 档预算闸门、跨 phase 复查。
 */
export function phaseBudget(pressure, thresholds = DEFAULT_THRESHOLDS) {
  const state = bandFor(pressure, thresholds);
  // 窗口判定直接用 pressure.window：bandFor 在 used 缺失时会提前返回（不带 window），
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

/** 人类可读的紧凑状态（供 relay_status 的 text 渲染；token 数字放证据层）。 */
export function formatStatus(report) {
  const t = report?.thresholds ?? DEFAULT_THRESHOLDS;
  const lead = report?.lead ?? {};
  const lines = [];
  lines.push('phase: ' + (report?.phase ?? 'discover'));
  lines.push('lead: ' + pct(lead.ratio) + (lead.window !== undefined ? ' (' + lead.used + '/' + lead.window + ')' : lead.used !== undefined ? ' (' + lead.used + ' tokens)' : '') + ' band=' + String(lead.band ?? 'ok'));
  lines.push('thresholds: warn ' + pct(t.warnRatio) + ' / organize ' + pct(t.organizeRatio) + ' / relay ' + pct(t.relayRatio) + (lead.window === undefined ? '（窗口未知：兜底 ' + t.warnTokens + '/' + t.organizeTokens + '/' + t.relayTokens + ' tokens）' : ''));
  // Router P0 度量（可选行；classic 调用不带 execution/compaction 时整行不渲染，旧输出不变）。
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
  // 预算事实（phase 优先协议）：开 phase 前估计 / phase 完成时复查用。
  const budget = report?.budget;
  if (budget !== undefined && budget !== null) {
    const num = (value) => (value === undefined || value === null ? '?' : String(value));
    lines.push('budget: headroom→warn ' + num(budget.headroomToWarn) + ' / →organize ' + num(budget.headroomToOrganize) + ' / →relay ' + num(budget.headroomToRelay)
      + ' tokens · 本 phase 已消耗 ' + num(budget.currentPhaseCostTokens)
      + (budget.previousPhase === undefined || budget.previousPhase === null ? '' : ' · 上一 phase(' + String(budget.previousPhase.phase) + ') 实测 ' + num(budget.previousPhase.costTokens)));
  }
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
    lines.push('continue: 需人类选择（band=' + String(choice.band) + '，本会话已压缩 ' + String(choice.organizeCount) + ' 次；选项 A「压缩后继续同一会话」→ relay_organize / B「接力开新会话」→ relay_handoff）→ 推荐 ' + String(choice.recommendation));
  }
  // advice 只供宿主/UI 消费（面板 chip 等）：模型侧只收上面渲染的 text（tools.js relay_status 的 render 只读 v.text），
  // 结构化 advice 不进模型上下文——模型侧以 text + 到线提醒 + 超预算拒绝错误为准。
  return lines.join('\n');
}

/** phase 边界 brief（写盘 + 压缩成功后注入；含下一 phase 的 DoD）。只渲染非空段。 */
export function buildPhaseBrief({ phase, goal, exitCriteria, decisions, constraints, evidence, keyDocs, next } = {}) {
  const name = normalizePhase(phase);
  const parts = [
    section('目标', goal),
    section('退出条件', exitCriteria),
    section('已定决策', decisions),
    section('硬约束', constraints),
    section('证据指针', evidence),
    section('关键文档（workspace 相对路径；先读入口）', shapeDocList(keyDocs, HANDOFF_LIMITS.items.key_docs).items),
    section('下一 phase', next),
  ].filter((part) => part !== '');
  return ['# Phase Brief · ' + name, '', ...parts, ''].join('\n');
}

/** 按 Unicode 码点截断（不切断 surrogate 对）；超长以省略号结尾。 */
function clipChars(text, limit) {
  const chars = Array.from(String(text));
  return chars.length <= limit ? chars.join('') : chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
}

/** 有界数组：截条数 + 截单条，返回用量供 caps 标注。 */
function shapeList(value, limit) {
  const raw = list(value);
  const kept = raw.slice(0, limit);
  const items = kept.map((item) => clipChars(item, HANDOFF_LIMITS.itemChars));
  return {
    items,
    used: items.length,
    dropped: raw.length - kept.length,
    clipped: items.filter((item, index) => item !== kept[index]).length,
  };
}

/**
 * 关键文档：先 posix.normalize 再判定，只收 workspace 相对 POSIX 路径。
 * `~` 前缀、绝对路径、盘符、反斜杠、`..` 越界、空段一律丢弃；`./` 与重复斜杠被规范化掉，并去重。
 */
function shapeDocList(value, limit) {
  const safe = list(value)
    .map((path) => posix.normalize(path))
    .filter((path) => path.startsWith('~') === false
      && path.startsWith('/') === false
      && /^[A-Za-z]:/.test(path) === false
      && path.includes('\\') === false
      && path !== '.'
      && path.split('/').every((segment) => segment !== '..' && segment !== ''));
  return shapeList([...new Set(safe)], limit);
}

function capsLine(info) {
  const itemText = Object.keys(HANDOFF_LIMITS.items)
    .map((key) => key + ' ' + info.items[key].used + '/' + HANDOFF_LIMITS.items[key])
    .join(' · ');
  return clipChars(
    'caps: bytes ' + info.bytesUsed + '/' + HANDOFF_LIMITS.totalBytes + ' · ' + itemText + ' · truncated=' + (info.truncated ? 'yes' : 'no'),
    300,
  );
}

function renderHandoff({ goal, phase, lists, info, when, sessionId }) {
  const lines = [];
  let used = 0;
  /** 这里只记「字节预算导致的截断」；条目级截断由 caps 单独标注。 */
  let truncated = false;
  const dropped = [];
  const push = (line) => {
    const text = String(line ?? '');
    const size = Buffer.byteLength(text, 'utf8') + 1;
    if (used + size > HANDOFF_LIMITS.totalBytes) {
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
  push('> created: ' + when + ' | from session: ' + clipChars(sessionId, 80) + ' | phase: ' + phase);
  push('> ' + capsLine(info));
  push('> 本文件是接力后新团队的第一手上下文；旧会话保留为审计档，不再派活。');
  push('');

  pushSection('状态', [
    // 正文 goal 截断：超长 goal 不得挤掉状态段（标题已单独 clip，目标在正文保留前 200 字符）。
    '目标：' + clipChars(goal, 200),
    ...lists.success_criteria.items.map((item) => '成功标准：' + item),
    ...lists.next_actions.items.map((item) => '下一步（DoD）：' + item),
    ...lists.blocked.items.map((item) => '阻塞：' + item),
    ...lists.done.items.map((item) => '已完成：' + item),
  ]);
  pushSection('首条指令', ['你是接力后的新 Lead。先确认本文件中的目标与未决问题，用 relay_phase 声明当前 phase，再按 phase 派活；不要自行裁决 P0 未决项。']);
  if (lists.key_docs.items.length > 0) pushSection('关键文档（workspace 相对路径；先读入口）', lists.key_docs.items);
  pushSection('证据（文件/命令/URL/会话 id）', lists.evidence.items);
  pushSection('已定决策（含理由）', lists.decisions.items);
  pushSection('未决问题（按 P0/P1/P2 标注，P0 必须人类裁决）', lists.open_questions.items);
  pushSection('风险与回滚', lists.risks.items);
  pushSection('硬约束', lists.constraints.items);
  pushSection('明确丢弃的上下文', lists.discarded.items);

  return { markdown: lines.join('\n') + '\n', bytes: Buffer.byteLength(lines.join('\n') + '\n', 'utf8'), truncated, dropped };
}

/**
 * 有界结构化 handoff：status（phase/goal/success_criteria/done/next_actions/blocked）
 * + evidence（≤12 条，每条 ≤200 字符，含 doc_lint 结论）+ 其余七字段语义数组。
 * 超限截断并在 caps 标注。
 * @returns {{markdown: string, caps: object}}
 */
export function buildHandoff(input = {}) {
  const source = input ?? {};
  const status = source.status ?? {};
  // goal 也归一化成单行：换行会把标题/状态段拆开，伪造 markdown 结构。
  const goal = String(status.goal ?? '').replace(/\s+/g, ' ').trim();
  if (goal === '') throw new Error('context-relay: goal is required for a handoff');
  const phase = normalizePhase(status.phase, 'discover');
  const limits = HANDOFF_LIMITS.items;
  const lists = {
    evidence: shapeList(source.evidence, limits.evidence),
    key_docs: shapeDocList(source.key_docs, limits.key_docs),
    done: shapeList(status.done, limits.done),
    success_criteria: shapeList(status.success_criteria, limits.success_criteria),
    next_actions: shapeList(status.next_actions, limits.next_actions),
    blocked: shapeList(status.blocked, limits.blocked),
    decisions: shapeList(source.decisions, limits.decisions),
    constraints: shapeList(source.constraints, limits.constraints),
    risks: shapeList(source.risks, limits.risks),
    open_questions: shapeList(source.open_questions, limits.open_questions),
    discarded: shapeList(source.discarded, limits.discarded),
  };
  const itemTruncated = Object.keys(limits).some((key) => lists[key].dropped > 0 || lists[key].clipped > 0);
  // 两类原因分开记账（v0.2.6）：条数超上限（items:key）vs 单条超 200 字符（chars:key）——
  // 旧的单一 items:key 让 hint 把条数裁剪误报成字符裁剪（同 8KB 误报一类的问题）。
  const itemSections = Object.keys(limits).flatMap((key) => [
    ...(lists[key].dropped > 0 ? ['items:' + key] : []),
    ...(lists[key].clipped > 0 ? ['chars:' + key] : []),
  ]);
  const when = source.createdAt ?? new Date().toISOString();
  const sessionId = String(source.sessionId ?? 'unknown');
  const items = Object.fromEntries(Object.keys(limits).map((key) => [key, { used: lists[key].used, limit: limits[key] }]));

  let info = { items, bytesUsed: 0, truncated: itemTruncated };
  let rendered = { markdown: '', bytes: 0, truncated: itemTruncated, dropped: [] };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    rendered = renderHandoff({ goal, phase, lists, info, when, sessionId });
    const next = {
      items,
      bytesUsed: rendered.bytes,
      truncated: itemTruncated || rendered.truncated,
      sections: [...new Set([...itemSections, ...rendered.dropped.map((title) => 'section:' + title), ...(rendered.truncated ? ['bytes'] : [])])],
    };
    const stable = next.bytesUsed === info.bytesUsed && next.truncated === info.truncated && (next.sections?.length ?? 0) === (info.sections?.length ?? 0);
    info = next;
    if (stable) break;
  }
  const caps = {
    bytes: { used: rendered.bytes, limit: HANDOFF_LIMITS.totalBytes },
    // chars 统一为 Unicode 码点口径（与 itemChars 截断一致；不用 UTF-16 code unit）。
    chars: { used: Array.from(rendered.markdown).length, itemLimit: HANDOFF_LIMITS.itemChars },
    items,
    truncated: info.truncated,
    truncatedSections: info.sections ?? [],
  };
  return { markdown: rendered.markdown, caps };
}

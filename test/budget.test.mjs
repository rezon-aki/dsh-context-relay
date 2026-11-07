/**
 * dsh-context-relay — relay v0.2.2「phase 优先的预算协议」测试（自包含）。
 *
 * 真源：.scratch/context-relay/budget-contract-v022-2026-11-01.md
 * （§2 纯函数 / §3 派生内存 / §4 工具契约 / §5 文案 / §7 测试矩阵）。
 * 只测新增行为，不 import 其它测试文件；agent 级 fake ctx/services/session 参照
 * test/agent.test.mjs 的最小写法在本文件复制（test 文件会重复执行，不能 import）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_THRESHOLDS, budgetGate, formatStatus, normalizeBudgetPlan, phaseBudget } from '../lib/policy.js';
import { apply } from '../lib/agent.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { clearSharedMemory } from '../lib/agent/shared.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearPanelMemory, configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';

/** 每次切 phase 必填的契约自检（预算闸门排在自检之后，这里给固定值）。 */
const CONTRACT_CHECK = {
  requirement: '需求已定：relay v0.2.2 phase 优先预算协议（边界：只新增 test/budget.test.mjs）',
  fidelity: '实现忠实，无偏移/劣化/偷懒/缺失',
  attention: '本阶段不打扰用户（无最小高影响点）',
};

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-budget-'));
}

/** 每个测试前重置进程级共享状态（派生内存/哨兵/共享锁/面板/handoff 发布箱）。 */
function resetSharedState() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearSharedMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-budget-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  // 测试夹具：budget 用例按显式基准 40%（35/40/50）编写；默认基准 35% 由 policy/index 测试覆盖。
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  delete globalThis[Symbol.for('dsh-context-relay.handoff.routes')];
}

/** 极简 fake ctx：只实现 agent.js 用到的接口，捕获注册产物 + logger 里程碑。 */
function fakeCtx(overrides = {}) {
  const tools = new Map();
  const sections = [];
  const events = [];
  const cleanups = [];
  const logs = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      const cleanup = typeof dispose === 'function' ? dispose : () => {};
      cleanups.push(cleanup);
      return cleanup;
    },
    on(name, listener, options) {
      events.push({ name, listener, options });
      return () => {};
    },
    logger: {
      info(message) { logs.push('info ' + message); },
      warn(message) { logs.push('warn ' + message); },
    },
    systemPrompt: {
      section(definition) { sections.push(definition); return () => {}; },
      context() { return () => {}; },
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return overrides.services?.[name]; },
  };
  return { ctx, tools, sections, events, cleanups, logs };
}

function fakeSession({ id = 'session-test', cwd, log = [], seq, header, requestHeader } = {}) {
  const builtHeader = header ?? (cwd === undefined ? {} : { cwd });
  return {
    id,
    header: builtHeader,
    get seq() { return seq ?? log.length; },
    snapshotEvents() { return log; },
    requestHeader: requestHeader ?? (() => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } })),
  };
}

/** services + 可变压力状态（模拟 contextPressure 投影变化）。 */
function fakeServices({ session, pressure = { contextWindow: 1_000_000, projectedTokens: 20_000 }, compaction, extra = {} } = {}) {
  const state = { pressure };
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens ?? 0 }) },
    compaction,
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
    sessionQuery: undefined,
    ...extra,
  };
  return { services, state };
}

function applyAgent(services, config = {}) {
  const { ctx, tools, sections, events, cleanups, logs } = fakeCtx({ services });
  apply(ctx, config);
  return { ctx, tools, sections, events, cleanups, logs };
}

/**
 * agent 级夹具：temp cwd（避免污染仓库 lessons/scratch）+ 可调压力 + 工具调用入口。
 * header 传 {origin:'subagent'} 可模拟队友会话；extra 覆盖 services（如 agentTeams）。
 */
function harness({ id, pressure = { contextWindow: 1_000_000, projectedTokens: 20_000 }, header, extra } = {}) {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id, cwd, header: { ...(header ?? {}), cwd }, seq: 0 });
  const bundle = fakeServices({ session, pressure, extra });
  const applied = applyAgent(bundle.services);
  const agent = { session, options: {}, inject() {} };
  const phase = (args) => applied.tools.get('relay_phase').execute(args, { agent });
  const status = () => applied.tools.get('relay_status').execute({}, { agent });
  return { cwd, session, ...bundle, ...applied, phase, status };
}

/** 取 rejection 的 error（多断言场景比 assert.rejects 正则更好定位）。 */
async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to be rejected');
}

// ────────────────────────────────────────────────────────────────────────────
// §2 纯函数：phaseBudget / normalizeBudgetPlan / budgetGate
// ────────────────────────────────────────────────────────────────────────────

test('policy.phaseBudget: 1M 窗口按 35%/40%/50% 比例线计算 headroom', () => {
  const budget = phaseBudget({ used: 100_000, window: 1_000_000 }, DEFAULT_THRESHOLDS);
  assert.equal(budget.band, 'ok');
  assert.equal(budget.basis, 'ratio');
  assert.equal(budget.used, 100_000);
  assert.equal(budget.window, 1_000_000);
  assert.equal(budget.ratio, 0.1);
  assert.deepEqual(budget.thresholds, { warn: 350_000, organize: 400_000, relay: 500_000 });
  assert.equal(budget.headroomToWarn, 250_000);
  assert.equal(budget.headroomToOrganize, 300_000);
  assert.equal(budget.headroomToRelay, 400_000);

  const warn = phaseBudget({ used: 370_000, window: 1_000_000 }, DEFAULT_THRESHOLDS);
  assert.equal(warn.band, 'warn');
  assert.equal(warn.headroomToWarn, 0, '已过 warn 线：headroom 归 0');
  assert.equal(warn.headroomToOrganize, 30_000);
  assert.equal(warn.headroomToRelay, 130_000);
});

test('policy.phaseBudget: 窗口未知用 *Tokens 兜底；used 缺失 headroom=undefined；超线归 0', () => {
  const noWindow = phaseBudget({ used: 120_000 }, DEFAULT_THRESHOLDS);
  assert.equal(noWindow.band, 'warn');
  assert.equal(noWindow.basis, 'tokens');
  assert.equal(noWindow.window, undefined);
  assert.deepEqual(noWindow.thresholds, { warn: 100_000, organize: 130_000, relay: 160_000 });
  assert.equal(noWindow.headroomToWarn, 0);
  assert.equal(noWindow.headroomToOrganize, 10_000);
  assert.equal(noWindow.headroomToRelay, 40_000);

  const unavailable = phaseBudget({}, DEFAULT_THRESHOLDS);
  assert.equal(unavailable.band, 'ok');
  assert.equal(unavailable.basis, 'unavailable');
  assert.equal(unavailable.used, undefined);
  assert.equal(unavailable.headroomToWarn, undefined);
  assert.equal(unavailable.headroomToOrganize, undefined);
  assert.equal(unavailable.headroomToRelay, undefined);

  const over = phaseBudget({ used: 600_000, window: 1_000_000 }, DEFAULT_THRESHOLDS);
  assert.equal(over.band, 'relay');
  assert.deepEqual(
    [over.headroomToWarn, over.headroomToOrganize, over.headroomToRelay],
    [0, 0, 0],
    '超过所有线：headroom 不得为负',
  );
});

test('policy.normalizeBudgetPlan: 缺/非法 action、estimate/can_finish 类型、两个估计都缺 → throw', () => {
  const refused = (input) => assert.throws(() => normalizeBudgetPlan(input), /budget plan/, 'input=' + JSON.stringify(input));
  for (const input of [undefined, null, [], 'proceed', 42, {}]) refused(input);
  refused({ action: 'continue' });
  refused({ action: '' });
  refused({ action: 'proceed', estimate_tokens: '100' });
  refused({ action: 'proceed', estimate_tokens: -1 });
  refused({ action: 'proceed', estimate_tokens: Infinity });
  refused({ action: 'proceed', estimate_tokens: NaN });
  refused({ action: 'proceed', estimate_tokens: null });
  refused({ action: 'proceed', can_finish: 'true' });
  refused({ action: 'proceed', can_finish: 1 });
  refused({ action: 'proceed', can_finish: null });
  refused({ action: 'proceed' });
  refused({ action: 'split', note: '只给 note 不算估计' });
  // 拒绝文案必须给三选一指引（proceed|split|relay），模型才能自我纠正。
  assert.throws(() => normalizeBudgetPlan(undefined), /proceed\|split\|relay/);
  assert.throws(() => normalizeBudgetPlan({}), /proceed\|split\|relay/);
});

test('policy.normalizeBudgetPlan: 合法输入归一化（驼峰字段 + note 单行截断）', () => {
  assert.deepEqual(
    normalizeBudgetPlan({ action: 'proceed', estimate_tokens: 12_000, can_finish: true }),
    { action: 'proceed', estimateTokens: 12_000, canFinish: true, note: undefined },
  );
  assert.deepEqual(
    normalizeBudgetPlan({ action: 'split', estimate_tokens: 0, note: '  缩小\n范围\t  ' }),
    { action: 'split', estimateTokens: 0, canFinish: undefined, note: '缩小 范围' },
  );
  assert.deepEqual(
    normalizeBudgetPlan({ action: 'proceed', can_finish: false }),
    { action: 'proceed', estimateTokens: undefined, canFinish: false, note: undefined },
  );
  assert.equal(normalizeBudgetPlan({ action: 'proceed', can_finish: true, note: 42 }).note, undefined, 'note 非字符串忽略');
  assert.equal(normalizeBudgetPlan({ action: 'proceed', can_finish: true, note: '   ' }).note, undefined, '空 note 归一为 undefined');
  const long = normalizeBudgetPlan({ action: 'proceed', can_finish: true, note: 'x'.repeat(300) });
  assert.equal(long.note.length, 200, 'note ≤200 字符截断');
});

test('policy.budgetGate: relay-op-first / estimate-over-headroom / phase-does-not-fit / ok', () => {
  const budget = { headroomToOrganize: 30_000, headroomToRelay: 130_000 };

  const relay = budgetGate({ action: 'relay', canFinish: false }, budget);
  assert.equal(relay.ok, false);
  assert.equal(relay.code, 'relay-op-first', '① action=relay 优先拒绝：先做一次 relay 操作');
  assert.equal(relay.facts.action, 'relay');

  const over = budgetGate({ action: 'proceed', canFinish: true, estimateTokens: 40_000 }, budget);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'estimate-over-headroom', '② 声明放得下但 estimate 超 headroom = 矛盾');
  assert.equal(over.facts.fits, true);
  assert.equal(over.facts.estimateTokens, 40_000);

  const notFit = budgetGate({ action: 'proceed', canFinish: false }, budget);
  assert.equal(notFit.ok, false);
  assert.equal(notFit.code, 'phase-does-not-fit', '③ 放不下却 proceed：拒绝');
  assert.equal(notFit.facts.fits, false);

  const ok = budgetGate({ action: 'proceed', canFinish: true, estimateTokens: 10_000 }, budget);
  assert.equal(ok.ok, true);
  assert.equal(ok.fits, true);
  assert.equal(ok.estimateTokens, 10_000);
  assert.equal(ok.canFinish, true);
  assert.equal(ok.headroomToOrganize, 30_000);

  const split = budgetGate({ action: 'split', canFinish: false }, budget);
  assert.equal(split.ok, true, 'split 在放不下时放行（拆票）');
  assert.equal(split.fits, false);

  // can_finish 缺省时 fits 由 estimate 推断：超 headroom → 放不下；proceed 被 ③ 拒绝，split 放行。
  const inferredOver = budgetGate({ action: 'proceed', estimateTokens: 40_000 }, budget);
  assert.equal(inferredOver.code, 'phase-does-not-fit');
  assert.equal(inferredOver.fits, false);
  assert.equal(budgetGate({ action: 'split', estimateTokens: 40_000 }, budget).ok, true);

  const unknownHeadroom = budgetGate({ action: 'proceed', canFinish: true, estimateTokens: 999_999 }, {});
  assert.equal(unknownHeadroom.ok, true, 'headroom 不可得时不做矛盾校验');
});

test('policy.budgetGate: estimate 缺省用上一 phase 实测消耗 lastPhaseCostTokens', () => {
  const fits = budgetGate({ action: 'proceed' }, { headroomToOrganize: 30_000 }, 20_000);
  assert.equal(fits.ok, true);
  assert.equal(fits.estimateTokens, 20_000, '未填 estimate 时用上一 phase 实测');
  assert.equal(fits.fits, true);

  const over = budgetGate({ action: 'proceed' }, { headroomToOrganize: 30_000 }, 40_000);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'phase-does-not-fit');
  assert.equal(over.estimateTokens, 40_000);
  assert.equal(over.fits, false);

  const explicit = budgetGate({ action: 'proceed', estimateTokens: 1_000 }, { headroomToOrganize: 30_000 }, 40_000);
  assert.equal(explicit.ok, true);
  assert.equal(explicit.estimateTokens, 1_000, '显式 estimate 优先于 lastPhaseCostTokens');

  const noLast = budgetGate({ action: 'proceed' }, { headroomToOrganize: 30_000 }, undefined);
  assert.equal(noLast.fits, undefined);
  assert.equal(noLast.ok, true, '无 estimate/无 last：不做推断（调用方另有必填估计闸门）');
});

// ────────────────────────────────────────────────────────────────────────────
// §4 relay_phase：warn 档 budget_plan 闸门
// ────────────────────────────────────────────────────────────────────────────

test('relay_phase warn 档缺 budget_plan：拒绝且零副作用（phase/面板预设/autoDecision 不变）', async () => {
  const h = harness({ id: 'session-budget-missing', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  updatePanelState(h.session.id, { defaultOperation: 'continue' });
  const error = await rejectionOf(h.phase({
    phase: 'build',
    contract_check: CONTRACT_CHECK,
    lessons: [{ text: '拒绝路径零副作用', evidence: 'test/budget.test.mjs' }],
  }));
  assert.match(error.message, /budget plan/);
  assert.match(error.message, /budget_plan/);
  assert.match(error.message, /先估计|先做预算可行性估计/);

  const report = await h.status();
  assert.equal(report.phase, 'discover', '拒绝不切换 phase');
  assert.equal(report.lead.band, 'warn');
  assert.equal(panelStateOf(h.session.id).defaultOperation, 'continue', '拒绝路径不消费/改写面板一次性预设');
  assert.equal(existsSync(join(h.cwd, '.scratch', 'context-relay', 'lessons.md')), false, '拒绝路径不写 lessons');

  // 拒绝路径在 next_operation 写盘之前：autoDecision 也不能被这次调用写入。
  const h2 = harness({ id: 'session-budget-missing-auto', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  updatePanelState(h2.session.id, { autoChoose: true, autoDecision: { operation: 'compress', at: 1_234 } });
  await rejectionOf(h2.phase({ phase: 'build', contract_check: CONTRACT_CHECK, next_operation: 'handoff' }));
  const panel = panelStateOf(h2.session.id);
  assert.deepEqual(panel.autoDecision, { operation: 'compress', at: 1_234 }, '拒绝路径不写 autoDecision');
  assert.equal(panel.autoChoose, true, '持久开关保持');
});

test('relay_phase warn 档 can_finish=false + proceed：拒绝并给 split/relay 指引', async () => {
  const h = harness({ id: 'session-budget-notfit', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const error = await rejectionOf(h.phase({
    phase: 'build',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'proceed', can_finish: false },
  }));
  assert.match(error.message, /can_finish/);
  assert.match(error.message, /split/);
  assert.match(error.message, /relay/);
  assert.equal((await h.status()).phase, 'discover');
});

test('relay_phase warn 档 estimate_tokens 超 headroom + can_finish=true：拒绝（矛盾）', async () => {
  const h = harness({ id: 'session-budget-over', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const error = await rejectionOf(h.phase({
    phase: 'build',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'proceed', can_finish: true, estimate_tokens: 100_000 },
  }));
  assert.match(error.message, /headroom/);
  assert.match(error.message, /estimate_tokens=100000/);
  assert.match(error.message, /can_finish=true/);
  assert.equal((await h.status()).phase, 'discover');
});

test('relay_phase warn 档 action=relay：拒绝并给 relay_organize/relay_handoff/force 指令', async () => {
  const h = harness({ id: 'session-budget-relayop', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const error = await rejectionOf(h.phase({
    phase: 'build',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'relay', can_finish: false },
  }));
  assert.match(error.message, /relay_organize/);
  assert.match(error.message, /relay_handoff/);
  assert.match(error.message, /force:true/, '未到 organize 线时必须提示 force');
  assert.match(error.message, /split/, '同时给出拆票备选');
  assert.equal((await h.status()).phase, 'discover');
});

test('relay_phase warn 档 action=split：放行切换，返回 budget.action=split + 拆票 reminder', async () => {
  const h = harness({ id: 'session-budget-split', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const result = await h.phase({
    phase: 'build',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'split', can_finish: false, estimate_tokens: 80_000, note: '缩小到只写测试' },
  });
  assert.equal(result.phase, 'build');
  assert.equal(result.previous, 'discover');
  assert.equal(result.budget.band, 'warn');
  assert.equal(result.budget.action, 'split');
  assert.equal(result.budget.fits, false);
  assert.equal(result.budget.canFinish, false);
  assert.equal(result.budget.estimateTokens, 80_000);
  assert.equal(result.budget.note, '缩小到只写测试');
  assert.match(result.reminder, /拆票/);
  assert.match(result.reminder, /缩小/);
  assert.equal(result.band, undefined, 'warn 不属于 overBudget：不返回顶层 band');
});

test('relay_phase warn 档 action=proceed + can_finish=true：放行切换，返回 budget 事实', async () => {
  const h = harness({ id: 'session-budget-proceed', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const result = await h.phase({
    phase: 'verify',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'proceed', can_finish: true, estimate_tokens: 10_000, note: '  放得下  ' },
  });
  assert.equal(result.phase, 'verify');
  assert.equal(result.previous, 'discover');
  assert.equal(result.band, undefined, 'warn 不属于 overBudget：不返回顶层 band');
  assert.equal(result.budget.band, 'warn');
  assert.equal(result.budget.action, 'proceed');
  assert.ok(result.budget.headroomToOrganize > 0, 'headroomToOrganize 应为正数');
  assert.equal(result.budget.headroomToOrganize, 30_000);
  assert.equal(result.budget.headroomToRelay, 130_000);
  assert.equal(result.budget.fits, true);
  assert.equal(result.budget.canFinish, true);
  assert.equal(result.budget.estimateTokens, 10_000);
  assert.equal(result.budget.note, '放得下');
  assert.equal(result.budget.lastPhaseCostTokens, undefined, '首次跨 phase 无历史实测');
  assert.equal(result.reminder, undefined);
  assert.ok(h.logs.some((line) => line.includes('[budget]')), '成功放行写 [budget] 里程碑日志');
});

test('relay_phase 非 warn 档：不强制 budget_plan，传入的 plan 被忽略（ok 档直接切换）', async () => {
  const h = harness({ id: 'session-budget-okband', pressure: { contextWindow: 1_000_000, projectedTokens: 20_000 } });
  // 非法 plan（缺 action）也不校验：非 warn 档忽略 budget_plan。
  const result = await h.phase({ phase: 'build', contract_check: CONTRACT_CHECK, budget_plan: { action: 'bogus' } });
  assert.equal(result.phase, 'build');
  // 契约 §1.3：跨 phase 响应带 budget 事实（所有档）；ok 档不强制 budget_plan、也不给动作。
  assert.equal(result.budget.band, 'ok');
  assert.equal(result.budget.action, undefined, '非 warn 档不返回 budget_plan 动作');
  assert.equal(result.budget.headroomToOrganize, 380_000);
  const report = await h.status();
  assert.equal(report.phase, 'build');
  assert.equal(report.lead.band, 'ok');
  assert.ok(report.budget.headroomToOrganize > 300_000, 'ok 档 headroom 远超 5% 窗口');
});

test('relay_phase 非跨 phase（warn 档）：不强制 budget_plan，响应不含 budget 字段', async () => {
  const h = harness({ id: 'session-budget-samephase', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const result = await h.phase({ phase: 'discover', contract_check: CONTRACT_CHECK, exit_criteria: '测试全绿' });
  assert.equal(result.phase, 'discover');
  assert.equal(result.previous, 'discover');
  assert.equal(result.budget, undefined, '非跨 phase 响应不含 budget（契约 §4）');
});

test('relay_phase 跨 phase 实测消耗：lastPhaseCostTokens = 两次 used 差值（同 phase 声明不覆盖起点）', async () => {
  const h = harness({ id: 'session-budget-cost', pressure: { contextWindow: 1_000_000, projectedTokens: 100_000 } });
  // ① ok 档跨 phase：首次声明记录本 phase 起点 used=100k。
  const first = await h.phase({ phase: 'build', contract_check: CONTRACT_CHECK });
  assert.equal(first.phase, 'build');
  assert.equal(first.budget.band, 'ok', 'ok 档跨 phase 也回 budget 事实（契约 §1.3）');
  assert.equal(first.budget.lastPhaseCostTokens, undefined, '首次跨 phase 无历史实测');
  // ② 同 phase 再次声明（压力已变）不覆盖起点——否则下面差值会算错。
  h.state.pressure = { contextWindow: 1_000_000, projectedTokens: 150_000 };
  await h.phase({ phase: 'build', contract_check: CONTRACT_CHECK });
  // ③ 压力升到 warn 后跨 phase：上一 phase 实测 = 370k - 100k = 270k。
  h.state.pressure = { contextWindow: 1_000_000, projectedTokens: 370_000 };
  const second = await h.phase({
    phase: 'verify',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'proceed', can_finish: true, estimate_tokens: 10_000 },
  });
  assert.equal(second.phase, 'verify');
  assert.equal(second.previous, 'build');
  assert.equal(second.budget.lastPhaseCostTokens, 270_000, '起点不应被同 phase 的后续声明覆盖');
  assert.equal(second.budget.headroomToOrganize, 30_000);
  // ④ relay_status 复查：本 phase 已消耗 + 上一 phase 实测。
  const report = await h.status();
  assert.equal(report.budget.currentPhaseCostTokens, 0);
  assert.deepEqual(report.budget.previousPhase, { phase: 'build', costTokens: 270_000 });
  assert.match(report.text, /上一 phase\(build\) 实测 270000/);
});

// ────────────────────────────────────────────────────────────────────────────
// §4 relay_status.budget（开 phase 前看 headroom / phase 完成后复查）
// ────────────────────────────────────────────────────────────────────────────

test('relay_status warn 档返回 budget（headroom/thresholds/text budget 行）', async () => {
  const h = harness({ id: 'session-budget-status', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const report = await h.status();
  assert.equal(report.budget.band, 'warn');
  assert.equal(report.budget.used, 370_000);
  assert.equal(report.budget.window, 1_000_000);
  assert.equal(report.budget.ratio, 0.37);
  assert.deepEqual(report.budget.thresholds, { warn: 350_000, organize: 400_000, relay: 500_000 });
  assert.equal(report.budget.headroomToWarn, 0);
  assert.equal(report.budget.headroomToOrganize, 30_000);
  assert.equal(report.budget.headroomToRelay, 130_000);
  assert.match(report.text, /budget: headroom→warn 0 \/ →organize 30000 \/ →relay 130000 tokens/);
  assert.match(report.text, /本 phase 已消耗 \?/, '无 phase 预算内存时如实显示 ?');
  // warn 档的下一步建议：开新 phase 前先估计（budget_plan）——不再有 mid-phase 指令。
  assert.match(report.advice, /budget_plan/);
  assert.match(report.advice, /拆票/);
});

// ────────────────────────────────────────────────────────────────────────────
// §4 队友会话：warn 档 action=relay 改为 Lead 请示（lead-only）
// ────────────────────────────────────────────────────────────────────────────

test('relay_phase 队友会话 warn 档 action=relay：lead-only，请示 Lead 而非自行 relay', async () => {
  const sent = [];
  const h = harness({
    id: 'session-budget-teammate',
    pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 },
    header: { origin: 'subagent' },
    extra: {
      agentTeams: {
        tryMembership: () => ({ role: 'teammate', name: 'budget-tester' }),
        sendMessage: async (caller, request) => { sent.push(request); },
        listMembers: () => [],
      },
    },
  });
  updatePanelState(h.session.id, { defaultOperation: 'compress' });
  const error = await rejectionOf(h.phase({
    phase: 'build',
    contract_check: CONTRACT_CHECK,
    budget_plan: { action: 'relay', can_finish: false },
  }));
  assert.match(error.message, /lead-only/);
  assert.match(error.message, /Lead/);
  assert.match(error.message, /send_message/);
  assert.match(error.message, /split/, '同时给出拆票备选');
  assert.equal(sent.length, 0, 'warn 档预算拒绝不触发 escalation（escalation 只在 organize/relay 跨 phase）');
  assert.equal(panelStateOf(h.session.id).defaultOperation, 'compress', '队友拒绝路径不消费预设');
  assert.equal((await h.status()).phase, 'discover');
  const report = await h.status();
  assert.match(report.advice, /Lead/, '队友 status 建议是向 Lead 请示口径');
});

// ────────────────────────────────────────────────────────────────────────────
// §5 文案：protocol / 哨兵升线 / advice
// ────────────────────────────────────────────────────────────────────────────

test('protocol 文案：phase 优先 + budget_plan + 拆票 + 先写好文档再交接；旧 nag 不再是指令', () => {
  resetSharedState();
  const { sections } = applyAgent(fakeServices({ session: fakeSession({ id: 'session-budget-protocol', cwd: tmpCwd(), seq: 0 }) }).services);
  const text = sections[0].text;
  assert.match(text, /phase 优先/);
  assert.match(text, /预算/);
  assert.match(text, /budget_plan/);
  assert.match(text, /拆票/);
  assert.match(text, /phase 完成时再检查是否要 relay 操作/);
  assert.match(text, /先写好文档再交接/);
  // 契约 §5/§7：删除「到线即处理 / 每 8 步重申」旧口径，且不再有 mid-phase 执行指令。
  assert.doesNotMatch(text, /到线即处理/);
  assert.doesNotMatch(text, /每 8 步重申/);
  assert.doesNotMatch(text, /不用等 phase 完成/);
  assert.doesNotMatch(text, /现在调 tools\.relay_organize/);
  // 到线提醒段：升线只告知预算状态与 phase 优先指引。
  assert.match(text, /升线 notice 只告知/);
  assert.match(text, /不中途压缩\/接力/);
});

test('sentinel: warn 升线只注入 1 条；随后 8 步不再注入（旧 nag 已删）', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-budget-sentinel', cwd: tmpCwd(), seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const { events } = applyAgent(bundle.services);
  const listener = events.find((event) => event.name === 'agent/pre-step').listener;
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);

  await step();
  assert.equal(injected.length, 1, '升到 warn：只注入 1 条');
  assert.match(injected[0].source.summary, /band=warn/);
  // warn 档 notice：只告知 phase 优先 + 处理点在 phase 边界（细节指向常驻协议），不含 mid-phase relay 指令。
  assert.match(injected[0].content[0].text, /phase 优先/);
  assert.match(injected[0].content[0].text, /处理点在 phase 边界/);
  assert.match(injected[0].content[0].text, /常驻协议/);
  assert.doesNotMatch(injected[0].content[0].text, /现在调 tools\.relay_organize/);
  // 长度回归：Lead 到线提醒 ≤300 字符（原 749；advice 复述删掉后只留事实+指引+指针）
  assert.ok(injected[0].content[0].text.length <= 365, 'warn notice chars ' + injected[0].content[0].text.length);
  for (let index = 0; index < 8; index += 1) await step();
  assert.equal(injected.length, 1, '同档 9 步只提醒一次：不再每 8 步重申');

  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step();
  assert.equal(injected.length, 2, '升线语义保留：升到 organize 再提醒一次');
  for (let index = 0; index < 8; index += 1) await step();
  assert.equal(injected.length, 2, 'organize 同档 8 步不重申');
});

test('advice：organize 档 phase 优先、无「现在调 tools.relay_organize」；warn 档提 budget_plan/拆票', async () => {
  const organize = harness({ id: 'session-budget-advice-organize', pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const report = await organize.status();
  assert.equal(report.lead.band, 'organize');
  assert.match(report.advice, /phase 优先/);
  assert.match(report.advice, /本 phase 继续做完|不中途压缩\/接力/);
  assert.doesNotMatch(report.advice, /现在调 tools\.relay_organize/);
  assert.doesNotMatch(report.advice, /每 8 步/);

  const warn = harness({ id: 'session-budget-advice-warn', pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 } });
  const warnReport = await warn.status();
  assert.equal(warnReport.lead.band, 'warn');
  assert.match(warnReport.advice, /budget_plan/);
  assert.match(warnReport.advice, /拆票/);
  assert.match(warnReport.advice, /headroom/);
  assert.doesNotMatch(warnReport.advice, /现在调 tools\.relay_organize/);
});

// ────────────────────────────────────────────────────────────────────────────
// 顺序保证：先写好文档再交接（handoff 快照 + 滚动进度文件先于首条消息）
// ────────────────────────────────────────────────────────────────────────────

test('relay_handoff 顺序保证：followup 调用时 handoff-*.md 与 progress.md 已写盘', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const dir = join(cwd, '.scratch', 'context-relay');
  const session = fakeSession({ id: 'session-budget-handoff', cwd, seq: 0 });
  const liveSession = { id: 'session-budget-handoff-new', header: { cwd }, requestHeader: () => undefined };
  const observed = [];
  const { services } = fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-budget-handoff-new' }; } },
      agents: {
        list: () => [{
          session: liveSession,
          status: 'idle',
          followup() {
            const files = existsSync(dir) ? readdirSync(dir) : [];
            observed.push({
              progress: existsSync(join(dir, 'progress.md')),
              handoffs: files.filter((name) => /^handoff-\d+\.md$/.test(name)),
            });
          },
        }],
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({
    human_approved: true,
    status: { phase: 'build', goal: 'budget handoff ordering', next_actions: ['keep testing'] },
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(observed.length >= 1, '新会话收到首条消息（followup 被调用）');
  for (const snapshot of observed) {
    assert.equal(snapshot.progress, true, '.scratch/context-relay/progress.md 在首条消息前已写盘');
    assert.equal(snapshot.handoffs.length, 1, 'handoff-<ts>.md 在首条消息前已写盘');
  }
  const handoffRaw = readFileSync(join(dir, observed[0].handoffs[0]), 'utf8');
  assert.match(handoffRaw, /budget handoff ordering/, 'handoff 快照内容完整');
  assert.match(readFileSync(join(dir, 'progress.md'), 'utf8'), /持有会话：session-budget-handoff-new/, '滚动进度文件持有会话已切到新会话');
  assert.equal(result.progress.updated, true);
});

// ────────────────────────────────────────────────────────────────────────────
// §6 文案：formatStatus 的 exec/compaction 可选行（classic 输出不变）
// ────────────────────────────────────────────────────────────────────────────

test('formatStatus：exec/compaction 是可选行——classic 调用输出不变，新行稳定可测', () => {
  const base = { phase: 'build', lead: { ratio: 0.42, used: 420000, window: 1000000, band: 'warn' }, thresholds: DEFAULT_THRESHOLDS, advice: 'keep going' };
  const classic = formatStatus(base);
  assert.equal(classic.split('\n').some((line) => line.startsWith('exec: ')), false, '不带 metrics 的旧调用不渲染新行');
  assert.equal(classic.split('\n').some((line) => line.startsWith('compaction debt: ')), false);
  // 新调用：metrics 行插在 thresholds 之后，其余行与 classic 完全一致。
  const metrics = formatStatus({
    ...base,
    execution: { calls: 3, total: 57, ratio: 0.053 },
    compaction: { count: 1, lastSeq: 42, debt: true },
  });
  const extra = metrics.split('\n').filter((line) => !classic.split('\n').includes(line));
  assert.deepEqual(extra, ['exec: 3/57 calls (5.3%) · compaction debt: yes(1)']);
  // 只有其一也渲染（防御旧调用方/过渡期投影）。
  assert.match(formatStatus({ ...base, execution: { calls: 0, total: 0, ratio: 0 } }), /exec: 0\/0 calls \(0\.0%\)/);
  assert.match(formatStatus({ ...base, compaction: { count: 0, lastSeq: -1, debt: false } }), /compaction debt: no\(0\)/);
});

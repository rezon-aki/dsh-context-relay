import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { CONTEXT_CHECK_MEMORY, clearSentinelMemory } from '../lib/agent/sentinel.js';
import { NOTICE_MAX, capacityNoticeText, contextCheckText, planNotices, sentinelText } from '../lib/agent/notice/plan.js';
import { contextCheckChoice } from '../lib/policy.js';
import { clearPanelMemory, configurePanelStore, updatePanelState } from '../lib/panel-store.js';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');

function resetShared() {
  globalThis[SETTINGS_KEY] = { threshold: 35, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearPanelMemory();
  clearSentinelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-cc-panel-')), 'panel.json') });
}

/** 极简 fake ctx：只实现 agent.js/sentinel 用到的接口。 */
function fakeCtx(services = {}) {
  const tools = new Map();
  const sections = [];
  const events = [];
  const logs = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn(message) { logs.push(String(message)); } },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, sections, events, logs };
}

function fakeSession({ id, cwd, log = [] }) {
  const state = { seq: 0 };
  return {
    id,
    header: { cwd },
    log,
    setSeq(value) { state.seq = value; },
    get seq() { return state.seq; },
    snapshotEvents() { return log; },
    requestHeader() { return { config: { provider: 'deepseek', model: 'test' } }; },
  };
}

/** 可变的压力/phase 投影（sentinel 走投影热路径，不依赖日志派生）。 */
function fakeServices(session, { pressure = 2000, phase = 'discover' } = {}) {
  const state = { pressure, phase, organizeCount: 0, lastCompactionSeq: -1, noticeBand: undefined, lastNoticeSeq: -1 };
  const services = {
    sessionProjections: {
      snapshot() { return { values: { contextPressure: { projectedTokens: state.pressure, contextWindow: 100000 } } }; },
      stateOf() {
        return {
          phase: state.phase,
          organizeCount: state.organizeCount,
          lastCompactionSeq: state.lastCompactionSeq,
          noticeBand: state.noticeBand,
          lastNoticeSeq: state.lastNoticeSeq,
        };
      },
    },
    tokenMeter: { measure() { return { totalTokens: state.pressure }; } },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
  return { services, state };
}

function sentinelOf({ session, services, config = {} }) {
  const bundle = fakeCtx(services);
  apply(bundle.ctx, config);
  const listener = bundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const post = bundle.events.find((event) => event.name === 'tools/post-execute').listener;
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);
  return { ...bundle, listener, post, agent, injected, step };
}

const BASE_FACTS = {
  subagent: false,
  phase: 'build',
  state: { band: 'ok', used: 2000, window: 100000, ratio: 0.02 },
  lastBand: 'ok',
  compactionSeq: -1,
  panel: { defaultOperation: null, autoCompress: false, autoHandoff: false, authorizeNext: false },
  ledgerEnabled: false,
  ledger: undefined,
  teamContext: undefined,
  pendingClosure: [],
  dispatchRows: [],
  guard: {},
  capacity: { atRisk: false, ratio: 0.02, threshold: 0.55 },
  capacityMemory: undefined,
  panelPrevious: JSON.stringify([null, false, false, false]),
  organizeCount: 0,
  metricsUnavailable: false,
  canInject: true,
};
const facts = (over) => ({ ...BASE_FACTS, ...over });

// ── 1. 推荐纯函数 ──────────────────────────────────────────────────────

test('contextCheckChoice：全档 tone/推荐；warn 不返回 continue；ok=continue；unavailable 保守；面板优先；capacity last-resort', () => {
  const ok = contextCheckChoice({ band: 'ok' });
  assert.equal(ok.operation, 'continue');
  assert.equal(ok.tone, 'preventive');
  const warn = contextCheckChoice({ band: 'warn' });
  assert.notEqual(warn.operation, 'continue', 'warn 不再推荐继续');
  assert.equal(warn.operation, 'organize');
  assert.equal(warn.tone, 'now');
  assert.match(warn.reason, /现在就该动手/);
  assert.equal(contextCheckChoice({ band: 'warn', organizeCount: 1 }).operation, 'handoff');
  const organize = contextCheckChoice({ band: 'organize' });
  assert.equal(organize.operation, 'organize');
  assert.equal(organize.tone, 'fallback');
  assert.match(organize.reason, /兜底告警/);
  assert.match(organize.reason, /本应已在 warn/);
  assert.equal(contextCheckChoice({ band: 'organize', organizeCount: 2 }).operation, 'handoff');
  assert.equal(contextCheckChoice({ band: 'relay' }).operation, 'handoff');
  assert.equal(contextCheckChoice({ band: 'relay' }).tone, 'fallback');
  const unavailable = contextCheckChoice({ band: 'unavailable' });
  assert.equal(unavailable.operation, 'continue');
  assert.match(unavailable.reason, /人工确认余量/);
  const capacity = contextCheckChoice({ band: 'ok', capacityAtRisk: true });
  assert.equal(capacity.operation, 'handoff');
  assert.equal(capacity.tone, 'last-resort');
  assert.match(capacity.reason, /最坏兜底/);
  assert.match(capacity.reason, /不自动执行/);
  const panel = contextCheckChoice({ band: 'warn', panel: { defaultOperation: 'handoff' } });
  assert.equal(panel.operation, 'handoff');
  assert.equal(panel.fromPanel, true);
  assert.match(panel.reason, /面板/);
  assert.equal(contextCheckChoice({ band: 'warn', panel: { defaultOperation: 'continue' } }).operation, 'continue', '面板显式继续优先');
  assert.equal(contextCheckChoice({ band: 'ok', trigger: 'task' }).reason.includes('warn 时立即处理'), true);
});

// ── 2. planNotices 分支 / 合并 / 优先级 ────────────────────────────────

const ccFact = (over = {}) => ({
  phase: { from: 'discover', to: 'decide' },
  recommendation: contextCheckChoice({ band: 'ok' }),
  band: 'ok',
  keys: ['phase:discover>decide#1'],
  step: 2,
  ...over,
});

test('planNotices：context-check 分支（面板之后、台账之前）；claim keys；phase+task 合并 ≤900', () => {
  const plan = planNotices(facts({ contextCheck: ccFact() }));
  assert.equal(plan.notice.kind, 'context-check');
  assert.match(plan.notice.text, /新阶段开始「探索 → 决策」/);
  assert.match(plan.notice.text, /下一步：三选一：压缩继续 \/ 清空复用 \/ 交接新会话/);
  assert.match(plan.notice.text, /三选一/);
  assert.deepEqual(plan.claims.contextCheck, { keys: ['phase:discover>decide#1'] });
  assert.ok(plan.notice.text.length <= NOTICE_MAX);

  const merged = planNotices(facts({
    contextCheck: ccFact({ task: { kind: 'goal', key: 'g1' }, keys: ['phase:discover>decide#1', 'task:goal#g1'] }),
  }));
  assert.match(merged.notice.text, /目标/);
  assert.match(merged.notice.text, /探索 → 决策/);
  assert.deepEqual(merged.claims.contextCheck.keys, ['phase:discover>decide#1', 'task:goal#g1']);
  assert.ok(merged.notice.text.length <= NOTICE_MAX);
});

test('planNotices：更高优先 notice 占用时 context-check 不 claim（下一步补发）', () => {
  const rising = planNotices(facts({
    state: { band: 'warn', used: 36000, window: 100000, ratio: 0.36 },
    lastBand: 'ok',
    capacity: { atRisk: false, ratio: 0.36, threshold: 0.55 },
    contextCheck: ccFact({ band: 'warn', recommendation: contextCheckChoice({ band: 'warn' }) }),
  }));
  assert.equal(rising.notice.kind, 'phase', '到线提醒优先');
  assert.equal(rising.claims.contextCheck, undefined, '被覆盖不 claim');
  const next = planNotices(facts({
    state: { band: 'warn', used: 36000, window: 100000, ratio: 0.36 },
    lastBand: 'warn',
    capacity: { atRisk: false, ratio: 0.36, threshold: 0.55 },
    contextCheck: ccFact({ band: 'warn', recommendation: contextCheckChoice({ band: 'warn' }) }),
  }));
  assert.equal(next.notice.kind, 'context-check', '下一步补发');
  assert.deepEqual(next.claims.contextCheck.keys, ['phase:discover>decide#1']);
});

test('文案：warn 三选一/现在就该动手且不含继续做完；organize/relay 兜底；capacity 最坏兜底不自动；≤900', () => {
  const warn = contextCheckText({
    band: 'warn',
    task: { kind: 'task-board', key: 't1' },
    recommendation: contextCheckChoice({ band: 'warn' }),
    panel: { defaultOperation: null },
  });
  assert.match(warn, /现在就该动手/);
  assert.match(warn, /三选一/);
  assert.match(warn, /压缩继续/);
  assert.match(warn, /清空复用/);
  assert.match(warn, /交接/);
  assert.doesNotMatch(warn, /继续做完当前任务/);
  assert.ok(warn.length <= NOTICE_MAX);

  const organize = contextCheckText({ band: 'organize', recommendation: contextCheckChoice({ band: 'organize' }), panel: {} });
  assert.match(organize, /兜底告警/);
  assert.match(organize, /本应已在 warn/);
  const relay = contextCheckText({ band: 'relay', recommendation: contextCheckChoice({ band: 'relay' }), panel: {} });
  assert.match(relay, /兜底告警升级/);
  assert.match(relay, /已超预期/);

  const capacity = capacityNoticeText({ ratio: 0.56, threshold: 0.55 });
  assert.match(capacity, /最坏兜底/);
  assert.match(capacity, /不自动执行/);
  assert.ok(capacity.length <= NOTICE_MAX);

  const panelText = contextCheckText({
    band: 'warn',
    recommendation: contextCheckChoice({ band: 'warn', panel: { defaultOperation: 'handoff' } }),
    panel: { defaultOperation: 'handoff' },
  });
  assert.match(panelText, /推荐：接力新会话/);
  assert.match(panelText, /面板模式=接力新会话/);
});
// ── 3. sentinel 事件 ───────────────────────────────────────────────────

test('sentinel：首个 pre-step 只 seed；phase 变化 1 条、同 phase 重复 0 条', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-'));
  const session = fakeSession({ id: 'session-cc-phase', cwd });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'discover' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  assert.equal(bundle.injected.length, 0, '首个 pre-step 只 seed（不提醒）');
  state.phase = 'decide';
  session.setSeq(2);
  await bundle.step();
  assert.equal(bundle.injected.length, 1);
  const text = bundle.injected[0].content[0].text;
  assert.match(text, /新阶段开始「探索 → 决策」/);
  assert.match(text, /^\[插件状态\]\n上下文自查：/);
  assert.match(text, /下一步：三选一：压缩继续 \/ 清空复用 \/ 交接新会话/);
  assert.match(text, /三选一/);
  session.setSeq(3);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '同 phase 不重复');
});

test('sentinel：ship → discover 标记「新任务开始」', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-ship-new-'));
  const session = fakeSession({ id: 'session-cc-ship-new', cwd });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'ship' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  state.phase = 'discover';
  session.setSeq(2);
  await bundle.step();
  assert.equal(bundle.injected.length, 1);
  assert.match(bundle.injected[0].content[0].text, /新任务开始「交付 → 探索」/);
});

test('sentinel：ship 段首条真实用户消息 1 条/段；插件 notice 不算；同段后续不重复', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-ship-user-'));
  const session = fakeSession({ id: 'session-cc-ship-user', cwd });
  const { services } = fakeServices(session, { pressure: 2000, phase: 'ship' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  session.log.push({ seq: 2, type: 'user/message', data: { source: { kind: 'dsh-context-relay', form: 'notice' }, content: [] } });
  session.setSeq(2);
  await bundle.step();
  assert.equal(bundle.injected.length, 0, '插件 notice 不是真实用户消息');
  session.log.push({ seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } });
  session.setSeq(3);
  await bundle.step();
  assert.equal(bundle.injected.length, 1);
  assert.match(bundle.injected[0].content[0].text, /交付后首条用户消息/);
  session.log.push({ seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再做一点' }] } });
  session.setSeq(4);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '每个 ship 段只算第一条');
});

test('sentinel：create_goal 与 task_board_run 各 1 条（post-execute 入队，下一步投递）', async () => {
  for (const row of [
    { name: 'create_goal', result: { goal: { id: 'g1' } }, label: '目标' },
    { name: 'task_board_run', result: { taskId: 't1' }, label: '任务板' },
  ]) {
    resetShared();
    const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-task-'));
    const session = fakeSession({ id: 'session-cc-task-' + row.name, cwd });
    const { services } = fakeServices(session, { pressure: 2000, phase: 'build' });
    const bundle = sentinelOf({ session, services });
    session.setSeq(1);
    await bundle.step();
    assert.equal(bundle.injected.length, 0);
    session.setSeq(2);
    await bundle.post({ name: row.name, arguments: {}, agent: { session } }, row.result, async () => undefined);
    await bundle.step();
    assert.equal(bundle.injected.length, 1, row.name + ' 应触发 1 条');
    assert.match(bundle.injected[0].content[0].text, new RegExp('新任务开始（' + row.label + '）'));
  }
});

test('sentinel：phase+task 同一步合并一条；overBudget 跨 phase 抑制', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-merge-'));
  const session = fakeSession({ id: 'session-cc-merge', cwd });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'build' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  state.phase = 'verify';
  session.setSeq(2);
  await bundle.post({ name: 'task_board_run', arguments: {}, agent: { session } }, { taskId: 't-merge' }, async () => undefined);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, 'phase+task 合并一条');
  const text = bundle.injected[0].content[0].text;
  assert.match(text, /构建 → 验证/);
  assert.match(text, /任务板/);

  // overBudget：band=organize 时的 phase 变化不新增 context-check（边界 notice 负责动作）
  resetShared();
  const dirB = mkdtempSync(join(tmpdir(), 'relay-cc-over-'));
  const sessionB = fakeSession({ id: 'session-cc-over', cwd: dirB });
  const { services: servicesB, state: stateB } = fakeServices(sessionB, { pressure: 40000, phase: 'discover' });
  stateB.noticeBand = 'organize';
  stateB.lastNoticeSeq = 1;
  const bundleB = sentinelOf({ session: sessionB, services: servicesB });
  sessionB.setSeq(1);
  await bundleB.step();
  assert.equal(bundleB.injected.length, 0, 'band=organize 已由持久 notice seed，不重报');
  stateB.phase = 'decide';
  sessionB.setSeq(2);
  await bundleB.step();
  assert.equal(bundleB.injected.length, 0, '跨 phase overBudget 不入队');
});

test('sentinel：重启首个 pre-step 只 seed 不重放；压缩复位不清 context 去重键', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-replay-'));
  const session = fakeSession({ id: 'session-cc-replay', cwd });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'discover' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  state.phase = 'decide';
  session.setSeq(2);
  await bundle.step();
  assert.equal(bundle.injected.length, 1);
  // 模拟重启：清进程内哨兵记忆；首步只 seed，不重放已送达的 phase 事件。
  clearSentinelMemory();
  session.setSeq(3);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '重启 seed 不重放');
  // 压缩复位：不重新发同一条 context-check。
  state.lastCompactionSeq = 3;
  session.setSeq(4);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '压缩复位不清 delivered 去重');
});

test('sentinel：投递成功才 claim；无 inject 时 pending 保留，恢复后补发', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-claim-'));
  const session = fakeSession({ id: 'session-cc-claim', cwd });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'discover' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  state.phase = 'decide';
  session.setSeq(2);
  const memory = () => CONTEXT_CHECK_MEMORY.get(session.id);
  bundle.agent.inject = undefined;
  await bundle.step();
  assert.equal(bundle.injected.length, 0);
  assert.equal(memory().delivered.size, 0, '未投递不 claim');
  assert.ok(memory().pending.length >= 1, 'pending 保留');
  bundle.agent.inject = (message) => bundle.injected.push(message);
  session.setSeq(3);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '恢复 inject 后补发');
  assert.equal(memory().delivered.size, 1, '投递成功才写 delivered');
  assert.equal(memory().pending.length, 0);
});

test('sentinel：面板模式优先（handoff）体现在推荐与文案；contextCheck:off 全静默', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-panel-'));
  const session = fakeSession({ id: 'session-cc-panel', cwd });
  updatePanelState(session.id, { defaultOperation: 'handoff' });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'build' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  state.phase = 'verify';
  session.setSeq(2);
  await bundle.step();
  assert.equal(bundle.injected.length, 1);
  assert.match(bundle.injected[0].content[0].text, /推荐：接力新会话/);
  assert.match(bundle.injected[0].content[0].text, /面板模式=接力新会话/);
  assert.match(bundle.injected[0].content[0].text, /面板/);

  resetShared();
  const dirOff = mkdtempSync(join(tmpdir(), 'relay-cc-off-'));
  const sessionOff = fakeSession({ id: 'session-cc-off', cwd: dirOff });
  const { services: servicesOff, state: stateOff } = fakeServices(sessionOff, { pressure: 2000, phase: 'build' });
  const bundleOff = sentinelOf({ session: sessionOff, services: servicesOff, config: { contextCheck: 'off' } });
  sessionOff.setSeq(1);
  await bundleOff.step();
  stateOff.phase = 'verify';
  sessionOff.setSeq(2);
  await bundleOff.step();
  assert.equal(bundleOff.injected.length, 0, 'contextCheck:off 全静默');
  assert.equal(CONTEXT_CHECK_MEMORY.has(sessionOff.id), false, 'off 不建立上下文记忆');
});

test('sentinel：不同事件间冷却 ≥3 步；blocked/cancel 与恢复同 phase 不触发', async () => {
  resetShared();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-cc-cooldown-'));
  const session = fakeSession({ id: 'session-cc-cooldown', cwd });
  const { services, state } = fakeServices(session, { pressure: 2000, phase: 'build' });
  const bundle = sentinelOf({ session, services });
  session.setSeq(1);
  await bundle.step();
  // 第一个 task 在 seq2 投递；第二个 task 在 seq3 入队但冷却未到。
  session.setSeq(2);
  await bundle.post({ name: 'create_goal', arguments: {}, agent: { session } }, { goal: { id: 'g1' } }, async () => undefined);
  await bundle.step();
  assert.equal(bundle.injected.length, 1);
  session.setSeq(3);
  await bundle.post({ name: 'task_board_run', arguments: {}, agent: { session } }, { taskId: 't1' }, async () => undefined);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '步骤间隔 <3 不投递（pending 保留）');
  session.setSeq(4);
  await bundle.step();
  assert.equal(bundle.injected.length, 1, '间隔 2 步仍不投递');
  session.setSeq(5);
  await bundle.step();
  assert.equal(bundle.injected.length, 2, '间隔达到 3 步后补发');
  assert.match(bundle.injected[1].content[0].text, /任务板/);

  // 出口不触发；恢复同 phase 不触发。
  resetShared();
  const dirExit = mkdtempSync(join(tmpdir(), 'relay-cc-exit-'));
  const exitSession = fakeSession({ id: 'session-cc-exit', cwd: dirExit });
  const { services: exitServices, state: exitState } = fakeServices(exitSession, { pressure: 2000, phase: 'build' });
  const exitBundle = sentinelOf({ session: exitSession, services: exitServices });
  exitSession.setSeq(1);
  await exitBundle.step();
  exitState.phase = 'blocked';
  exitSession.setSeq(2);
  await exitBundle.step();
  assert.equal(exitBundle.injected.length, 0, '进入 blocked 不触发');
  exitState.phase = 'build';
  exitSession.setSeq(3);
  await exitBundle.step();
  assert.equal(exitBundle.injected.length, 0, '从出口恢复同 phase 不触发');
});

test('到线文案：warn/organize/relay/capacity 四档语义与面板优先（sentinelText/contextCheckText）', () => {
  const warn = sentinelText('build', { band: 'warn', used: 36000, window: 100000, ratio: 0.36 }, false, { defaultOperation: null });
  assert.match(warn, /现在就该动手/);
  assert.match(warn, /三选一/);
  assert.doesNotMatch(warn, /继续做完当前任务/);
  const organize = sentinelText('build', { band: 'organize', used: 42000, window: 100000, ratio: 0.42 }, false, { defaultOperation: null });
  assert.match(organize, /兜底告警/);
  assert.match(organize, /本应已在 warn 30% 前处理/);
  const relay = sentinelText('build', { band: 'relay', used: 52000, window: 100000, ratio: 0.52 }, false, { defaultOperation: null });
  assert.match(relay, /兜底告警升级/);
  const panel = sentinelText('build', { band: 'warn', used: 36000, window: 100000, ratio: 0.36 }, false, { defaultOperation: 'handoff' });
  assert.match(panel, /推荐：接力新会话/);
  assert.match(panel, /面板/);
  const capacityContext = contextCheckText({
    band: 'organize',
    capacity: { atRisk: true, ratio: 0.56, threshold: 0.55 },
    recommendation: contextCheckChoice({ band: 'organize', capacityAtRisk: true }),
    panel: {},
  });
  assert.match(capacityContext, /容量保全线/);
  assert.match(capacityContext, /最坏兜底/);
  assert.match(capacityContext, /不自动执行/);
  assert.ok(capacityContext.length <= NOTICE_MAX);
});

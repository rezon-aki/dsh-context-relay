/**
 * v0.9.0 批次2 — 状态机出口 + 容量保全（#10/#7；D6=A/D7=A）+ 出口/用户门相关接线测试。
 *
 * 覆盖：relay_phase 出口矩阵（原因必填/任意 phase 可进/拒绝零副作用/恢复 resumed/不参与预算与
 * 分点闸门/ship 仍只能从 verify 进）、deriveExit（投影与日志 fallback）、relay_status.capacity、
 * 哨兵容量保全上升沿一次性 notice（回落重置）、panel-gate 交接 status.phase 接受出口。
 * 全部写 mkdtemp 临时目录，不触真实工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore, panelStateOf } from '../lib/panel-store.js';
import { clearDeriveMemory, deriveExit, derivePhase } from '../lib/agent/derive.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { approvalGateOf } from '../lib/agent/panel-gate.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { readWorkItems } from '../lib/agent/work-items.js';

const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';
const CONTRACT_CHECK = { requirement: '需求已定：状态机出口+容量保全；边界：本文件写范围', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };
const thresholds = thresholdsFromPercent(40);

function resetSharedState() {
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  delete globalThis[Symbol.for('dsh-context-relay.handoff.routes')];
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-exit-panel-')), 'panel.json') });
  clearSentinelMemory();
  clearDeriveMemory();
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-exit-'));
}

function fakeCtx(overrides = {}) {
  const services = overrides.services ?? {};
  const tools = new Map();
  const sections = [];
  const events = [];
  const logs = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener, options) { events.push({ name, listener, options }); return () => {}; },
    logger: { info(message) { logs.push('info ' + message); }, warn(message) { logs.push('warn ' + message); } },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, sections, events, logs };
}

function fakeSession({ id = 'session-exit', cwd, log = [], seq, header } = {}) {
  const builtHeader = header ?? (cwd === undefined ? {} : { cwd });
  return {
    id,
    header: builtHeader,
    get seq() { return seq ?? log.length; },
    snapshotEvents() { return log; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function fakeServices({ session, pressure = { contextWindow: 1_000_000, projectedTokens: 20_000 } } = {}) {
  const state = { pressure };
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens ?? 0 }) },
    compaction: undefined,
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
    sessionQuery: undefined,
  };
  return { services, state };
}

function applyAgent(services, config = {}) {
  const bundle = fakeCtx({ services });
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL, ...config });
  return bundle;
}

function writeLedger(cwd, items, { rev = 1, currentPhase } = {}) {
  const path = join(cwd, WORK_ITEMS_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rev, updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'test', ...(currentPhase === undefined ? {} : { currentPhase }), items }, null, 2));
  return path;
}

function readLedgerFile(cwd) {
  return JSON.parse(readFileSync(join(cwd, WORK_ITEMS_REL), 'utf8'));
}

function harness({ id, pressure, log } = {}) {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id, cwd, seq: 0, log });
  const bundle = fakeServices({ session, pressure });
  const applied = applyAgent(bundle.services);
  const agent = { session, options: {}, inject() {} };
  const phase = (args) => applied.tools.get('relay_phase').execute(args, { agent });
  const status = () => applied.tools.get('relay_status').execute({}, { agent });
  return { cwd, session, agent, applied, phase, status, ...bundle };
}

// ── 出口矩阵 ───────────────────────────────────────────────────────────

test('relay_phase 出口：缺 exit_reason 拒绝且零副作用（不切 phase、不写台账/面板）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'b1', title: '实现', status: 'doing', next: 'x', phase: 'build' }], { rev: 1, currentPhase: { phase: 'build', goal: 'g', since: 1, openedAtRev: 1 } });
  const session = fakeSession({ id: 'session-exit-missing', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const call = (args) => bundle.tools.get('relay_phase').execute(args, { agent });
  await call({ phase: 'build', contract_check: CONTRACT_CHECK });
  const ledgerBefore = readLedgerFile(cwd);
  const before = panelStateOf(session.id);
  for (const bad of [{ phase: 'blocked' }, { phase: 'cancel', exit_reason: '   ' }, { phase: 'blocked', exit_reason: 'x'.repeat(201) }]) {
    await assert.rejects(call({ ...bad, contract_check: CONTRACT_CHECK }), /refused \(exit\)/);
  }
  assert.deepEqual(panelStateOf(session.id), before, '拒绝路径零副作用：面板不变');
  assert.equal((await bundle.tools.get('relay_status').execute({}, { agent })).phase, 'build', '拒绝不切 phase');
  assert.deepEqual(readLedgerFile(cwd), ledgerBefore, '拒绝不写台账');
});

test('relay_phase 出口：任意 phase 可进 blocked/cancel；status 带 exit；恢复 resumed=true', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-exit-kind', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const call = (args) => bundle.tools.get('relay_phase').execute(args, { agent });
  // discover 直接出口（任意 phase 可进）
  const blocked = await call({ phase: 'blocked', exit_reason: '等用户裁决 X', contract_check: CONTRACT_CHECK });
  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.previous, 'discover');
  assert.equal(blocked.exit_reason, '等用户裁决 X');
  assert.equal(blocked.resumed, false);
  const status = await bundle.tools.get('relay_status').execute({}, { agent });
  assert.equal(status.phase, 'blocked');
  assert.deepEqual({ kind: status.exit.kind, reason: status.exit.reason }, { kind: 'blocked', reason: '等用户裁决 X' });
  assert.match(status.text, /^phase: blocked/m);
  // 恢复：从出口回主链，resumed=true（不要求 budget_plan）。
  const resumed = await call({ phase: 'build', contract_check: CONTRACT_CHECK, goal: 'g' });
  assert.equal(resumed.phase, 'build');
  assert.equal(resumed.previous, 'blocked');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.budget, undefined, '恢复不要求/不返回 budget 闸门');
  const afterRestore = await bundle.tools.get('relay_status').execute({}, { agent });
  assert.equal(afterRestore.exit, undefined, '回主链后不再有 exit');
  // cancel：另一会话直接取消。
  const cwd2 = tmpCwd();
  const s2 = fakeSession({ id: 'session-exit-cancel', cwd: cwd2, seq: 0 });
  const b2 = applyAgent(fakeServices({ session: s2 }).services);
  const a2 = { session: s2, options: {} };
  await b2.tools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent: a2 });
  const canceled = await b2.tools.get('relay_phase').execute({ phase: 'cancel', exit_reason: '任务取消', contract_check: CONTRACT_CHECK }, { agent: a2 });
  assert.equal(canceled.phase, 'cancel');
  const status2 = await b2.tools.get('relay_status').execute({}, { agent: a2 });
  assert.deepEqual({ kind: status2.exit.kind, reason: status2.exit.reason }, { kind: 'cancel', reason: '任务取消' });
  // verify→build 返修回边允许（受控回边；不属出口，正常走主链）。
  await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  const rework = await call({ phase: 'build', contract_check: CONTRACT_CHECK });
  assert.equal(rework.phase, 'build');
  assert.equal(rework.previous, 'verify');
});

test('relay_phase 出口旁路：出口不触发 phase/分点闸门、不写台账；出口后 ship 仍拒', async () => {
  resetSharedState();
  // 先正常开 build（空台账），再把「未收口 + currentPhase=build」写进台账：主链切 phase 会被 strict gate 拒绝。
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-exit-gate', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services, { workItemsPhaseGate: 'strict' });
  const agent = { session, options: {} };
  const call = (args) => bundle.tools.get('relay_phase').execute(args, { agent });
  await call({ phase: 'build', contract_check: CONTRACT_CHECK });
  // 主链验证：此时切 verify 会被 strict 分点闸门拒绝（证明台账确有未收口项）。
  writeLedger(cwd, [{ id: 'b1', title: '未收口', status: 'doing', next: 'x', phase: 'build' }], { rev: 2, currentPhase: { phase: 'build', goal: 'g', since: 1, openedAtRev: 2 } });
  await assert.rejects(call({ phase: 'verify', contract_check: CONTRACT_CHECK }), /work items, phase open/);
  const before = readLedgerFile(cwd);
  const blocked = await call({ phase: 'blocked', exit_reason: '等外部依赖', contract_check: CONTRACT_CHECK });
  assert.equal(blocked.phase, 'blocked', '出口不触发分点闸门');
  assert.equal(blocked.ledger, undefined, '出口不写台账');
  assert.deepEqual(readLedgerFile(cwd), before, '出口不改台账文件');
  // ship 仍只能从 verify 进：从 blocked 进 ship 拒绝。
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK }), /只能从 verify 来/);
});

test('deriveExit：无投影时从日志 fallback 重建出口（restart 后仍可读）', () => {
  resetSharedState();
  const session = fakeSession({
    id: 'session-derive-exit',
    cwd: tmpCwd(),
    seq: 0,
    log: [
      { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'build', goal: 'g' }, isError: false, content: [] } },
      { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'relay_phase', arguments: { phase: 'blocked', exit_reason: '等用户' }, isError: false, content: [] } },
      { type: 'tool/ptc-dispatch', seq: 3, data: { name: 'relay_phase', arguments: { phase: 'build' }, isError: true, content: [] } },
    ],
  });
  assert.equal(derivePhase(session, undefined), 'blocked');
  const exit = deriveExit(session, undefined);
  assert.equal(exit.kind, 'blocked');
  assert.equal(exit.reason, '等用户');
  // 恢复调用成功后无 exit。
  const restored = fakeSession({
    id: 'session-derive-exit-restored',
    cwd: tmpCwd(),
    seq: 0,
    log: [
      { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'blocked', exit_reason: '等用户' }, isError: false, content: [] } },
      { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'relay_phase', arguments: { phase: 'build', goal: 'g' }, isError: false, content: [] } },
    ],
  });
  assert.equal(derivePhase(restored, undefined), 'build');
  assert.equal(deriveExit(restored, undefined), undefined);
});

// ── 容量保全 ───────────────────────────────────────────────────────────

test('relay_status.capacity：≥85% 报事实 + text 容量行；窗口未知 basis=unavailable 不保全', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-capacity-status', cwd: tmpCwd(), seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 860_000 } });
  const applied = applyAgent(bundle.services);
  const agent = { session, options: {}, inject() {} };
  const status = await applied.tools.get('relay_status').execute({}, { agent });
  assert.equal(status.capacity.atRisk, true);
  assert.equal(status.capacity.basis, 'ratio');
  assert.equal(status.capacity.threshold, 0.85);
  assert.equal(status.capacity.ratio, 0.86);
  assert.match(status.text, /capacity: 86\.0% ≥ 85\.0% → 容量保全/);
  // 回落：不 atRisk 不渲染容量行。
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 500_000 };
  const dropped = await applied.tools.get('relay_status').execute({}, { agent });
  assert.equal(dropped.capacity.atRisk, false);
  assert.doesNotMatch(dropped.text, /capacity:/);
  // 窗口未知：不猜、不保全。
  const unknownSession = fakeSession({ id: 'session-capacity-unknown', cwd: tmpCwd(), seq: 0 });
  const unknown = applyAgent(fakeServices({ session: unknownSession, pressure: { projectedTokens: 900_000 } }).services);
  const unknownStatus = await unknown.tools.get('relay_status').execute({}, { agent: { session: unknownSession, options: {}, inject() {} } });
  assert.equal(unknownStatus.capacity.atRisk, false);
  assert.equal(unknownStatus.capacity.basis, 'unavailable');
});

test('哨兵容量保全 notice：上升沿一次性注入、同档不重复、回落后重新武装；不自动压缩/接力', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-capacity-sentinel', cwd: tmpCwd(), seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 840_000 } });
  const applied = applyAgent(bundle.services);
  const listener = applied.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);
  // 84%：到线提醒（relay 档）但未到容量线——只有 band notice。
  await step();
  assert.equal(injected.length, 1);
  assert.doesNotMatch(injected[0].content[0].text, /容量保全/);
  // 86%：同 band 不重复提醒，但容量上升沿注入一条容量 notice（合并/单条）。
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 860_000 };
  await step();
  assert.equal(injected.length, 2, '容量上升沿注入一次');
  const capacityText = injected[1].content[0].text;
  assert.match(capacityText, /容量保全/);
  assert.match(capacityText, /ratio 86\.0%，阈值 85\.0%/);
  assert.match(capacityText, /phase 中段不打断」的唯一例外/);
  assert.doesNotMatch(capacityText, /自动压缩|自动接力/, '只提示不自动动作');
  // 同档再走 8 步：不重复。
  for (let index = 0; index < 8; index += 1) await step();
  assert.equal(injected.length, 2, '容量 notice 不重复');
  // 回落到 40%：重置武装（不注入）；再次到 86% → 再注入一次。
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 400_000 };
  await step();
  assert.equal(injected.length, 2, '回落不注入');
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 860_000 };
  await step();
  assert.equal(injected.length, 3, '回落重置后再次上升沿提醒');
  assert.match(injected[2].content[0].text, /容量保全/);
  // 窗口未知：不注入容量 notice。
  resetSharedState();
  const blindSession = fakeSession({ id: 'session-capacity-blind', cwd: tmpCwd(), seq: 0 });
  const blind = applyAgent(fakeServices({ session: blindSession, pressure: { projectedTokens: 900_000 } }).services);
  const blindListener = blind.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const blindInjected = [];
  await blindListener({ agent: { session: blindSession, inject(message) { blindInjected.push(message); } } }, async () => undefined);
  assert.ok(blindInjected.every((message) => !message.content[0].text.includes('容量保全')), '窗口未知不保全');
});

// ── panel-gate：交接 status.phase 接受出口 ────────────────────────────

test('panel-gate：relay_handoff status.phase 允许 blocked/cancel（不再误判 handoff-invalid）', () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-exit-handoff', cwd: tmpCwd(), seq: 0 });
  const ctx = fakeCtx().ctx;
  const exec = (phase) => ({
    name: 'relay_handoff',
    agent: { session, options: {} },
    arguments: { human_approved: true, status: { phase, goal: 'g' } },
  });
  const blocked = approvalGateOf(ctx, exec('blocked'), thresholds);
  assert.equal(blocked?.kind, undefined, '出口 phase 不判 handoff-invalid（进入审批询问）');
  assert.match(blocked.reason, /human Go\/No-go/);
  const bogus = approvalGateOf(ctx, exec('bogus'), thresholds);
  assert.equal(bogus, undefined, '非法 phase 仍不弹无谓审批（handoff-invalid 预判）');
});

test('relay_handoff：blocked/cancel 会话可交接（status.phase schema/执行归一接受出口值，M4）', async () => {
  // schema：status.phase enum 与 normalizePhaseState 对齐（5 主链 + 2 出口）。
  resetSharedState();
  const probeSession = fakeSession({ id: 'session-exit-handoff-schema', cwd: tmpCwd(), seq: 0 });
  const probe = applyAgent(fakeServices({ session: probeSession }).services);
  assert.deepEqual(
    probe.tools.get('relay_handoff').parameters.properties.status.properties.phase.enum,
    ['discover', 'decide', 'build', 'verify', 'ship', 'blocked', 'cancel'],
    'status.phase enum 含出口（M4 §3.5）',
  );
  // 执行：出口 phase 照常交接成功（不再 handoff-invalid）。
  for (const phase of ['blocked', 'cancel']) {
    resetSharedState();
    const cwd = tmpCwd();
    const session = fakeSession({ id: 'session-exit-handoff-' + phase, cwd, seq: 0 });
    const newSessionId = 'session-exit-handoff-new-' + phase;
    // fake live agent：followup 同时写官方 inbox（acceptanceOf 的首条消息接管证据契约）。
    const liveSession = { id: newSessionId, header: { cwd }, requestHeader: () => undefined, inbox: { nextTurn: [], nextStep: [] } };
    const followed = [];
    const bundle = fakeServices({ session });
    bundle.services.agents = { list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); liveSession.inbox.nextTurn.push(message); } }] };
    bundle.services.sessionController = { async create() { return { sessionId: newSessionId }; } };
    bundle.services.workspaceRegistry = { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } };
    bundle.services.sessionTitle = { rename() {} };
    bundle.services.approval = { async request() { return 'allowed-once'; } };
    const applied = applyAgent(bundle.services);
    const result = await applied.tools.get('relay_handoff').execute(
      { human_approved: true, status: { goal: 'handoff from ' + phase, phase } },
      { agent: { session, options: {} } },
    );
    // 断言点 = 出口 phase 被接受（不再 handoff-invalid）并进入创建/派发路径；
    // fake live agent 不提供官方接管证据时工具按契约降级为 takeover-unconfirmed（非本用例断言点）。
    assert.notEqual(result.code, 'handoff-invalid', phase + '：出口 phase 不再被判 handoff-invalid（M4）: ' + JSON.stringify(result).slice(0, 240));
    assert.equal(typeof result.sessionId, 'string', phase + '：已进入创建/派发路径');
    assert.ok(followed.length >= 1, phase + '：首条消息已发出');
  }
});


test('容量保全重新武装（P2-3）：压缩后 used 大降但仍 ≥85% → 允许再次提示一次', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-capacity-rearm', cwd, seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 1_000_000 } });
  const applied = applyAgent(bundle.services);
  const listener = applied.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const texts = () => injected.map((message) => message.content[0].text).filter((text) => text.includes('容量保全'));
  const step = () => listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  await step();
  assert.equal(texts().length, 1, '100% 首次容量 notice');
  // 压缩生效：used 1.0M → 0.85M（下降 15%）；ratio 仍 85% ≥ 阈值 → 仍 atRisk，但重新武装允许再提示一次。
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 850_000 };
  await step();
  assert.equal(texts().length, 2, 'used 较 notice 时下降 ≥15% → 仍 atRisk 也重新提示一次');
  // 同 used 再 step：不重复。
  await step();
  assert.equal(texts().length, 2, '同 used 不重复提示');
  // 下降不足 15%（850k → 800k，仍 ≥阈值）不重新武装。
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 800_000 };
  await step();
  assert.equal(texts().length, 2, '下降不足 15% 不重新武装');
});

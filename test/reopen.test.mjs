/**
 * dsh-context-relay — v0.11 P0-C ship 受控 reopen（设计 §3.3 验收矩阵）。
 *
 * 覆盖 strict/warn/off 三档矩阵、零副作用拒绝、reopen 后二次 ship 重新过
 * user_gate/contract_check、ship→discover 标 newTask、同 phase 重复 ship warning、
 * deriveReopen→relay_status.reopen、压缩/重启后日志重放。工具数仍 15（budget-snapshot 断言）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory, derivePhase, deriveReopen } from '../lib/agent/derive.js';
import { foldRelayEvent, initialState } from '../lib/projection.js';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';
const CONTRACT_CHECK = { requirement: '需求已定', fidelity: '实现忠实，无偏移', attention: '不打扰' };
const SHIP_GATE = { review: 'fresh 独立审查：需求已定、实现忠实', report: '结论：完成\n影响：无\n需要你做什么：无需\n证据位置：x:1' };
const DESIGN_GATE = { path: '.scratch/context-relay/architecture/ctx-hardening.md', user_approved: true, ask_ref: '用户确认：按这份设计推进', not_doing: ['不发布 npm', '不改本机配置'] };
const REOPEN = { reason: '用户提出返修：补边界用例', user_approved: true };

function resetSharedState() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-reopen-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  globalThis[SETTINGS_KEY] = { threshold: 35, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-reopen-'));
}

function fakeCtx(services) {
  const tools = new Map();
  const events = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, events };
}

function fakeSession({ id, cwd, log = [] }) {
  return {
    id,
    header: { cwd },
    seq: 0,
    snapshotEvents() { return log; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function fakeServices(session, pressure = { contextWindow: 1_000_000, projectedTokens: 20_000 }) {
  return {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: pressure.projectedTokens ?? 0 }) },
    compaction: undefined,
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
    sessionQuery: undefined,
  };
}

/** apply agent → phase/status 调用封装（默认 strict；可传 reopenGate/session）。 */
function harness({ reopenGate, session } = {}) {
  resetSharedState();
  const active = session ?? fakeSession({ id: 'session-reopen-' + Math.random().toString(36).slice(2), cwd: tmpCwd() });
  const bundle = fakeCtx(fakeServices(active));
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL, ...(reopenGate === undefined ? {} : { reopenGate }) });
  const agent = { session: active, options: {} };
  const call = (args) => bundle.tools.get('relay_phase').execute(args, { agent });
  const status = () => bundle.tools.get('relay_status').execute({}, { agent });
  const toShip = async () => {
    await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
    await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
    const shipped = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
    assert.equal(shipped.phase, 'ship');
  };
  return { call, status, toShip, session: active };
}

test('P0-C strict：ship→build/verify 缺 reopen 零副作用拒绝；合法 reopen 记录；二次 ship 重新要双门', async () => {
  const h = harness();
  await h.toShip();
  // 缺失 reopen：strict 拒绝，phase 不切（仍 ship）。
  await assert.rejects(h.call({ phase: 'build', contract_check: CONTRACT_CHECK }), /reopen/, 'ship→build 修复必须显式 reopen');
  assert.equal((await h.status()).phase, 'ship', '拒绝零副作用：phase 仍 ship');
  // 不完整 reopen（user_approved 非 true）：同样拒绝。
  await assert.rejects(h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: { reason: '返修', user_approved: false } }), /reopen/);
  // 合法 reopen：放行 + 结果记录。
  const reworked = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: REOPEN });
  assert.equal(reworked.phase, 'verify');
  assert.equal(reworked.previous, 'ship');
  assert.deepEqual(reworked.reopen, { from: 'ship', to: 'verify', reason: REOPEN.reason, userApproved: true });
  // 返修后回到 ship：user_gate、contract_check 必须重新给（全额闸门）。
  await h.call({ phase: 'build', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await assert.rejects(h.call({ phase: 'ship', contract_check: CONTRACT_CHECK }), /user_gate/, 'reopen 后二次 ship 重新要 user_gate');
  await assert.rejects(h.call({ phase: 'ship', user_gate: SHIP_GATE }), /contract_check/, 'reopen 后二次 ship 重新要 contract_check');
  const reshipped = await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  assert.equal(reshipped.phase, 'ship');
  // relay_status 可观测（进程内缓存，不扫日志）。
  const status = await h.status();
  assert.equal(status.reopen.count, 1);
  assert.equal(status.reopen.last.from, 'ship');
  assert.equal(status.reopen.last.to, 'verify');
  assert.equal(status.reopen.last.reason, REOPEN.reason);
  assert.equal(status.reopen.last.userApproved, true);
  assert.match(status.text, /reopen: 1 次/);
});

test('P0-C warn：缺/不完整 reopen 放行 + warning + 记录 missing；合法 reopen 记录且无 warning', async () => {
  const h = harness({ reopenGate: 'warn' });
  await h.toShip();
  const allowed = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  assert.equal(allowed.phase, 'verify', 'warn 档放行');
  assert.equal(allowed.warning, 'reopen-missing');
  assert.deepEqual(allowed.reopen, { from: 'ship', to: 'verify', missing: ['reopen'] });
  // 不完整：记录缺项明细。
  await h.call({ phase: 'build', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  const incomplete = await h.call({ phase: 'build', contract_check: CONTRACT_CHECK, reopen: { reason: '返修' } });
  assert.equal(incomplete.warning, 'reopen-missing');
  // 可观测契约：已提供的 reason 原样保留（不丢审计事实），缺失项进 missing；未提供的 userApproved 不虚构。
  assert.deepEqual(incomplete.reopen, { from: 'ship', to: 'build', reason: '返修', missing: ['reopen.user_approved'] });
  // 显式给了 user_approved:false：保留调用方给的值 + 记入 missing（不静默改写）。
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  const denied = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: { reason: '返修', user_approved: false } });
  assert.deepEqual(denied.reopen, { from: 'ship', to: 'verify', reason: '返修', userApproved: false, missing: ['reopen.user_approved'] });
  // 合法 reopen：记录、无 warning（先重新交付一次，再从 ship 退出）。
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  const valid = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: REOPEN });
  assert.equal(valid.warning, undefined);
  assert.equal(valid.reopen.userApproved, true);
});

test('P0-C off：缺失 reopen 放行且不记录（v0.10 旧行为）；非 ship reopen 忽略', async () => {
  const h = harness({ reopenGate: 'off' });
  await h.toShip();
  const allowed = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  assert.equal(allowed.phase, 'verify');
  assert.equal(allowed.reopen, undefined);
  assert.equal(allowed.warning, undefined);
  // 非 ship 提供 reopen：off 忽略（不拒绝、不记录）。
  const ignored = await h.call({ phase: 'build', contract_check: CONTRACT_CHECK, reopen: { reason: 'x', user_approved: true } });
  assert.equal(ignored.phase, 'build');
  assert.equal(ignored.reopen, undefined);
});

test('P0-C off：日志中的历史 reopen 不计入 relay_status.reopen（off 不记录）', async () => {
  const log = [
    { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'build' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'relay_phase', arguments: { phase: 'verify' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 3, data: { name: 'relay_phase', arguments: { phase: 'ship' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 4, data: { name: 'relay_phase', arguments: { phase: 'build', reopen: REOPEN }, isError: false, content: [] } },
  ];
  const session = fakeSession({ id: 'session-reopen-off-replay', cwd: tmpCwd(), log });
  const h = harness({ session, reopenGate: 'off' });
  const status = await h.status();
  assert.equal(status.reopen.count, 0, 'off 档不记录 reopen（日志参数也不计）');
  assert.doesNotMatch(status.text, /reopen:/);
});

test('P0-C strict/warn：非 ship 提供 reopen → fail(invalid-args) 拒绝（零副作用）', async () => {
  for (const reopenGate of ['strict', 'warn']) {
    const h = harness({ reopenGate });
    const refused = await h.call({ phase: 'decide', exit_criteria: '方案定稿', reopen: REOPEN });
    assert.equal(refused.ok, false, reopenGate + '：非 ship reopen 必须拒绝');
    assert.equal(refused.code, 'invalid-args', reopenGate + '：设计 §3.3 固定拒绝码 invalid-args');
    assert.equal(refused.field, 'reopen');
    assert.match(refused.error, /reopen/);
    assert.equal((await h.status()).phase, 'discover', reopenGate + '：拒绝零副作用');
  }
});

test('P0-C 返回式拒绝（ok:false）不推进 phase：投影/日志派生同口径（零副作用）', async () => {
  const refusal = [{ type: 'text', text: JSON.stringify({ ok: false, code: 'invalid-args', error: 'reopen 只用于 ship 退出到 build/verify' }) }];
  const event = {
    type: 'tool/ptc-dispatch',
    seq: 1,
    data: { name: 'relay_phase', arguments: { phase: 'decide', reopen: REOPEN }, isError: false, content: refusal },
  };
  // 投影：ok:false 的成功事件不得应用 args.phase。
  const projected = foldRelayEvent(initialState, event);
  assert.equal(projected.phase, 'discover', '投影不因返回式拒绝推进 phase');
  // 日志派生：同一事件在冷启动重放时同样不算 phase 切换。
  const session = fakeSession({ id: 'session-reopen-refused-replay', cwd: tmpCwd(), log: [event] });
  assert.equal(derivePhase(session, undefined), 'discover', '日志派生不因返回式拒绝推进 phase');
});

test('P0-C ship→discover：放行并标 newTask（新任务开始），无需 reopen', async () => {
  const h = harness();
  await h.toShip();
  const next = await h.call({ phase: 'discover', exit_criteria: '新任务范围定稿' });
  assert.equal(next.phase, 'discover');
  assert.equal(next.previous, 'ship');
  assert.equal(next.newTask, true, 'ship→discover = 新任务开始');
  assert.equal(next.reopen, undefined);
});

test('P0-C 同 phase 重复 ship：带 user_gate/reopen 时 warning ship-already-delivered，不拒绝', async () => {
  const h = harness();
  await h.toShip();
  const again = await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  assert.equal(again.phase, 'ship');
  assert.equal(again.warning, 'ship-already-delivered');
  const viaReopen = await h.call({ phase: 'ship', reopen: REOPEN });
  assert.equal(viaReopen.warning, 'ship-already-delivered', '提供 reopen 也提示已交付（不拒绝）');
  // 不提供 user_gate/reopen 的重复声明：不告警（兼容旧调用）。
  const silent = await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK });
  assert.equal(silent.warning, undefined);
});

test('P0-C deriveReopen/relay_status：压缩/重启后从日志重放 ship→build 记录', async () => {
  const log = [
    { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'build', design_gate: DESIGN_GATE }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'relay_phase', arguments: { phase: 'verify' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 3, data: { name: 'relay_phase', arguments: { phase: 'ship' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 4, data: { name: 'relay_phase', arguments: { phase: 'build', reopen: REOPEN }, isError: false, content: [] } },
    // 失败调用不得计数（strict 拒绝的日志形态）。
    { type: 'tool/ptc-dispatch', seq: 5, data: { name: 'relay_phase', arguments: { phase: 'verify', reopen: REOPEN }, isError: true, content: [] } },
  ];
  const session = fakeSession({ id: 'session-reopen-replay', cwd: tmpCwd(), log });
  assert.equal(derivePhase(session, undefined), 'build', '日志重放 phase=build');
  const derived = deriveReopen(session);
  assert.equal(derived.count, 1, '只计成功且确实 ship→build/verify 的 reopen');
  assert.deepEqual(
    { from: derived.last.from, to: derived.last.to, reason: derived.last.reason, userApproved: derived.last.userApproved },
    { from: 'ship', to: 'build', reason: REOPEN.reason, userApproved: true },
  );
  // 模拟重启：清派生缓存后 relay_status 冷启动重放（无投影 → 允许扫日志）。
  clearDeriveMemory();
  const h = harness({ session });
  const status = await h.status();
  assert.equal(status.reopen.count, 1);
  assert.equal(status.reopen.last.to, 'build');
  assert.match(status.text, /reopen: 1 次（最近 ship→build/);
});

test('P0-C reopen.reason 边界：1-200 字符（201 拒绝、200/1 放行）', async () => {
  const h = harness();
  await h.toShip();
  const ok200 = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: { reason: 'a'.repeat(200), user_approved: true } });
  assert.equal(ok200.phase, 'verify');
  await h.call({ phase: 'build', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  await assert.rejects(h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: { reason: 'a'.repeat(201), user_approved: true } }), /reopen/);
  await assert.rejects(h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: { reason: '   ', user_approved: true } }), /reopen/);
  const ok1 = await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK, reopen: { reason: 'x', user_approved: true } });
  assert.equal(ok1.reopen.reason, 'x');
});

test('P0-C 工具数保持 15（reopen 只扩 relay_phase 参数，不新增工具）', async () => {
  resetSharedState();
  const bundle = fakeCtx(fakeServices(fakeSession({ id: 'session-reopen-count', cwd: tmpCwd() })));
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL });
  // preset 常驻 8 条（Lead-only 5 + 队友 2 走 agent/created，budget-snapshot 已锁 15）。
  assert.equal(bundle.tools.size, 8);
  const phaseTool = bundle.tools.get('relay_phase');
  assert.deepEqual(phaseTool.parameters.properties.reopen.required, ['reason', 'user_approved']);
  assert.equal(phaseTool.parameters.properties.reopen.additionalProperties, false);
});

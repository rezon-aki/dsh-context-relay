/**
 * C9/AUDIT §12：用户门两段式 + 验收分级（设计门 / 实现↔设计对齐 / 最小必要验收 / 重型验证授权）。
 *
 * 覆盖：
 * - 设计门：relay_phase 首次进 build（previous ∈ {discover, decide}）必须带 design_gate{path, user_approved:true}；
 *   缺失/无效 → 拒绝且零副作用（不切 phase、不写台账/lessons/面板）；通过 → 结果回显 design；
 *   首次过门后 verify→build 返修不再要求（只锁「首次进入 build」）。
 * - 验收分级：ship 的 user_gate.verification{tier}——heavy 无 approved_by_user:true 即拒（重型验证需用户明确授权），
 *   heavy 有授权 / minimal 默认放行；结果只回摘要（review 状态/字数/分级/条目数，不落 report 原文）。
 * - review/report 硬门不校验顺序（只查非空）；两者缺一仍拒。
 * - contract_check 仅 ship 必填：普通 phase 缺失不告警（主动传入但残缺才 warning），ship 缺失即拒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore, panelStateOf } from '../lib/panel-store.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { internalKeysIn } from '../lib/output.js';

const CONTRACT_CHECK = { requirement: '需求已定：C9 用户门两段式；边界：只改 relay 协议/工具/测试', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '不打扰用户（无最小高影响点）' };
const SHIP_GATE = { review: 'fresh subagent 独立审查：需求已定、实现忠实，无偏移/劣化/偷懒/缺失', report: '大白话汇报：需求 → 实现 + 证据 → 无偏差、边界已说明' };
const DESIGN_GATE = { path: '.scratch/context-relay/architecture/complete-form-2026-11-16.md', user_approved: true, ask_ref: '用户确认：按这份设计推进', not_doing: ['不发布 npm', '不改本机配置'] };

function resetSharedState() {
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearPanelMemory();
  clearSentinelMemory();
  clearDeriveMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-gate-panel-')), 'panel.json') });
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-gate-'));
}

function fakeCtx(services = {}) {
  const tools = new Map();
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools };
}

function fakeSession({ id = 'session-gate', cwd } = {}) {
  return { id, header: cwd === undefined ? {} : { cwd }, get seq() { return 0; }, snapshotEvents() { return []; } };
}

function fakeServices({ session }) {
  return {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1_000_000, projectedTokens: 20_000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 20_000 }) },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
}

/** ok 档（不触发 budget_plan 闸门）的 relay_phase harness。 */
function harness(id) {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id, cwd });
  const { ctx, tools } = fakeCtx(fakeServices({ session }));
  apply(ctx, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const agent = { session, options: {}, inject() {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  const status = () => tools.get('relay_status').execute({}, { agent });
  return { cwd, session, tools, call, status };
}

// ── 设计门（两段式第一段：开工前显式停）──────────────────────────────

test('设计门：首次进 build 缺 design_gate → 拒绝且零副作用（不切 phase/不写台账/lessons/面板）', async () => {
  const h = harness('session-design-missing');
  const ledgerPath = join(h.cwd, '.scratch/context-relay/work-items.json');
  const before = panelStateOf(h.session.id);
  const error = await h.call({ phase: 'build', contract_check: CONTRACT_CHECK }).then(() => undefined, (err) => err);
  assert.ok(error instanceof Error);
  assert.match(error.message, /设计门/);
  assert.match(error.message, /design_gate/);
  assert.match(error.message, /零副作用/);
  assert.equal((await h.status()).phase, 'discover', '拒绝不切 phase');
  assert.equal(existsSync(ledgerPath), false, '拒绝不写台账');
  assert.equal(existsSync(join(h.cwd, '.scratch/context-relay/lessons.md')), false, '拒绝不写 lessons');
  assert.deepEqual(panelStateOf(h.session.id), before, '拒绝不写面板');
});

test('设计门：design_gate 无效（空 path / user_approved 非 true / 非对象）→ 拒绝且零副作用', async () => {
  const h = harness('session-design-invalid');
  for (const gate of [{ path: '  ', user_approved: true }, { path: 'docs/design.md', user_approved: false }, { path: 'docs/design.md' }, 'docs/design.md', null]) {
    await assert.rejects(h.call({ phase: 'build', design_gate: gate, contract_check: CONTRACT_CHECK }), /design_gate/, JSON.stringify(gate));
  }
  assert.equal((await h.status()).phase, 'discover');
});

test('设计门：discover→build 带 design_gate{path,user_approved:true} 放行，结果回显 design', async () => {
  const h = harness('session-design-ok');
  const result = await h.call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  assert.equal(result.phase, 'build');
  assert.equal(result.previous, 'discover');
  assert.deepEqual(result.design, DESIGN_GATE, '结果回显 design（path+已确认+ask_ref+not_doing）');
  assert.match(result.text, /^design: 设计门已过（用户已确认）· /m);
  assert.equal((await h.status()).phase, 'build');
});

test('设计门：decide→build 同样必须带（决策后开工前仍要用户确认设计）', async () => {
  const h = harness('session-design-decide');
  await h.call({ phase: 'decide', contract_check: CONTRACT_CHECK, exit_criteria: '设计稿经用户确认' });
  await assert.rejects(h.call({ phase: 'build', contract_check: CONTRACT_CHECK }), /设计门/);
  const ok = await h.call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  assert.equal(ok.phase, 'build');
  assert.equal(ok.previous, 'decide');
  assert.equal(ok.design.path, DESIGN_GATE.path);
});

test('设计门：首次过门后 verify→build 返修不再要求 design_gate', async () => {
  const h = harness('session-design-rework');
  await h.call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  const rework = await h.call({ phase: 'build', contract_check: CONTRACT_CHECK });
  assert.equal(rework.phase, 'build');
  assert.equal(rework.previous, 'verify');
  assert.equal(rework.design, undefined, '返修不重复回显设计门');
});

// ── 验收分级（最小必要 / 重型需授权）───────────────────────────────────

async function reachVerify(h) {
  await h.call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  await h.call({ phase: 'verify', contract_check: CONTRACT_CHECK });
}

test('验收分级：heavy 无 approved_by_user → ship 拒绝且零副作用', async () => {
  const h = harness('session-verify-heavy-noauth');
  await reachVerify(h);
  const before = panelStateOf(h.session.id);
  for (const verification of [{ tier: 'heavy' }, { tier: 'heavy', approved_by_user: false }, { tier: 'bogus' }, { approved_by_user: true }, null]) {
    await assert.rejects(h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { ...SHIP_GATE, verification } }), /验收方式不合规/, JSON.stringify(verification));
  }
  assert.equal((await h.status()).phase, 'verify', '拒绝不切 phase');
  assert.deepEqual(panelStateOf(h.session.id), before, '拒绝不写面板');
});

test('验收分级：heavy 带 approved_by_user:true 放行；minimal 默认放行；两者都回显摘要', async () => {
  const heavy = harness('session-verify-heavy-ok');
  await reachVerify(heavy);
  const heavyShip = await heavy.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { ...SHIP_GATE, verification: { tier: 'heavy', approved_by_user: true, items: ['npm test', '真机端到端'] } } });
  assert.equal(heavyShip.phase, 'ship');
  assert.deepEqual(heavyShip.user_gate.verification, { tier: 'heavy', approved_by_user: true, items: ['npm test', '真机端到端'] });
  assert.match(heavyShip.text, /verification=heavy/);
  const minimal = harness('session-verify-minimal');
  await reachVerify(minimal);
  const minimalShip = await minimal.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { ...SHIP_GATE, verification: { tier: 'minimal', items: ['node --test test/user-gate.test.mjs'] } } });
  assert.equal(minimalShip.phase, 'ship');
  assert.deepEqual(minimalShip.user_gate.verification, { tier: 'minimal', items: ['node --test test/user-gate.test.mjs'] });
  assert.equal('approved_by_user' in minimalShip.user_gate.verification, false);
  assert.match(minimalShip.text, /verification=minimal/);
});

test('验收分级：items 非法（非数组/空串/超过 8 条）拒绝', async () => {
  const h = harness('session-verify-items');
  await reachVerify(h);
  for (const items of ['not-array', [''], ['  '], Array.from({ length: 9 }, (_, i) => 'item-' + i)]) {
    await assert.rejects(h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { ...SHIP_GATE, verification: { tier: 'minimal', items } } }), /验收方式不合规/);
  }
});

// ── review/report 硬门：非空即可，不校验顺序 ─────────────────────────

test('review/report 顺序无关：两种书写顺序都放行；缺一仍拒', async () => {
  const a = harness('session-gate-order-a');
  await reachVerify(a);
  const reviewFirst = await a.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'fresh review', report: '结论：完成；影响：无；需要你做什么：无需；证据位置：test' } });
  assert.equal(reviewFirst.phase, 'ship');
  const b = harness('session-gate-order-b');
  await reachVerify(b);
  const reportFirst = await b.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { report: '结论：完成；影响：无；需要你做什么：无需；证据位置：test', review: 'fresh review' } });
  assert.equal(reportFirst.phase, 'ship');
  assert.equal(reportFirst.user_gate.review, 'done', '只回摘要，不机械校验顺序语义');
  const c = harness('session-gate-order-missing');
  await reachVerify(c);
  await assert.rejects(c.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'fresh review' } }), /user_gate\.report/);
  await assert.rejects(c.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { report: '汇报正文' } }), /user_gate\.review/);
});

// ── contract_check：ship 必填，其他 phase 可选 ────────────────────────

test('contract_check 仅 ship 必填：普通 phase 缺失不告警（可选）', async () => {
  const h = harness('session-contract-optional');
  const build = await h.call({ phase: 'build', design_gate: DESIGN_GATE });
  assert.equal(build.phase, 'build');
  assert.equal(build.contractWarning, undefined, 'build 缺 contract_check 不再 warning（可选）');
  const verify = await h.call({ phase: 'verify' });
  assert.equal(verify.contractWarning, undefined, 'verify 缺 contract_check 同样不告警');
});

test('contract_check：主动传入但残缺的普通 phase 仍 warning（不静默）', async () => {
  const partial = harness('session-contract-partial');
  const partialBuild = await partial.call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: { requirement: '  ', fidelity: 'f', attention: 'a' } });
  assert.match(partialBuild.contractWarning, /requirement/, '主动传入但残缺仍 warning');
});

test('contract_check：ship 必填——缺失即拒，带齐放行', async () => {
  const h = harness('session-contract-ship');
  await reachVerify(h);
  await assert.rejects(h.call({ phase: 'ship', user_gate: SHIP_GATE }), /contract_check/);
  const shipped = await h.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  assert.equal(shipped.phase, 'ship');
});

test('relay_phase 拒绝：可行动内部事实（code/facts/effects/retryable/next），零副作用', async () => {
  const h = harness('session-refusal-facts');
  const error = await h.call({ phase: 'build', contract_check: CONTRACT_CHECK }).then(() => undefined, (err) => err);
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'design gate');
  assert.ok(error.facts.detail.startsWith('relay_phase refused (design gate)'), '原始细节只进 facts');
  assert.match(error.facts.effects, /零副作用/, '已发生什么');
  assert.equal(error.facts.retryable, true, '能否重试');
  assert.ok(typeof error.facts.next === 'string' && error.facts.next !== '', '下一步');
  assert.equal(error.human, undefined, '不再产 human 用户段');
  assert.match(error.message, /本次没有切换阶段/, 'message 只作内部事实');
  assert.equal((await h.status()).phase, 'discover', '拒绝零副作用（不切 phase）');
});

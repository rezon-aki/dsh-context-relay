/**
 * 风险档落盘探针（relay-audit §2.5.2 / p3-calib 建议 1）：
 * relay_phase 成功时把 risk{tier,source,reasons} 写进台账 currentPhase.risk（即使本 phase 没有分点），
 * relay_status 与 relay_work_items 都能读回同一 tier；旧台账缺 risk 时保持 absent（不伪造 T2）。
 * 全部写 mkdtemp 临时目录，不触真实工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';

const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';
const CONTRACT_CHECK = { requirement: '需求已定：风险档落盘探针；边界：只改写范围', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };
const DESIGN_GATE = { path: '.scratch/context-relay/architecture/risk-probe.md', user_approved: true, ask_ref: '用户确认：按设计推进', not_doing: ['不发布 npm'] };

function resetSharedState() {
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-risk-panel-')), 'panel.json') });
  clearSentinelMemory();
}

function fakeCtx(services) {
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

function fakeSession({ id, cwd }) {
  return {
    id,
    header: { cwd },
    seq: 0,
    snapshotEvents() { return []; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function applyAgent({ cwd, sessionId }) {
  const pressure = { contextWindow: 1_000_000, projectedTokens: 20000 };
  const session = fakeSession({ id: sessionId, cwd });
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: pressure.projectedTokens }) },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
  const bundle = fakeCtx(services);
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL });
  return { tools: bundle.tools, session, agent: { session, options: {} } };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-risk-'));
}

test('relay_phase 风险档落盘：空分点也写 currentPhase.risk，status/work_items 读回同一 tier', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const { tools, agent } = applyAgent({ cwd, sessionId: 'risk-probe-lead' });
  const phase = (args) => tools.get('relay_phase').execute(args, { agent });

  const first = await phase({ phase: 'decide', exit_criteria: '风险档读回探针通过', risk: { tier: 'T1', reason: 'docs-only 改动', paths: ['docs/a.md'], lines: 10 } });
  assert.equal(first.phase, 'decide');
  assert.equal(first.risk.tier, 'T1');
  assert.equal(first.risk.source, 'declared');
  const disk = JSON.parse(readFileSync(join(cwd, WORK_ITEMS_REL), 'utf8'));
  assert.deepEqual(disk.items, [], '本 phase 没有分点也落 currentPhase');
  assert.deepEqual(disk.currentPhase.risk, { tier: 'T1', source: 'declared', reasons: [] }, '风险档写进阶段记录');

  const status = await tools.get('relay_status').execute({}, { agent });
  assert.equal(status.workItems.phase.phase, 'decide');
  assert.equal(status.workItems.phase.risk.tier, 'T1', 'relay_status 读回同一 tier');
  assert.equal(status.workItems.phase.risk.source, 'declared');
  assert.match(status.text, /phase: phase decide .*risk T1\(declared\)/, 'model 可见通道也带 risk');

  const read = await tools.get('relay_work_items').execute({}, { agent });
  assert.equal(read.phase.phase, 'decide');
  assert.equal(read.phase.risk.tier, 'T1', 'relay_work_items 读回同一 tier');
  assert.match(read.text, /阶段：decide · risk T1\(declared\)/);

  // 未显式声明时继承本会话上一档，并继续落盘（不是每次新建 T2）。
  const second = await phase({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  assert.equal(second.risk.tier, 'T1', '未声明时继承本会话风险档');
  const after = JSON.parse(readFileSync(join(cwd, WORK_ITEMS_REL), 'utf8'));
  assert.equal(after.currentPhase.phase, 'build');
  assert.equal(after.currentPhase.risk.tier, 'T1');
  assert.equal(after.currentPhase.risk.source, 'declared', '继承档保留来源');
});

test('旧台账缺 risk：relay_status/relay_work_items 保持 absent（不伪造 T2）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const path = join(cwd, WORK_ITEMS_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1, rev: 3, updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'old',
    currentPhase: { phase: 'build', goal: '旧记录', since: 1, openedAtRev: 2 },
    items: [{ id: 'p1', title: '旧分点', status: 'doing', next: '推进', phase: 'build' }],
  }, null, 2));
  const { tools, agent } = applyAgent({ cwd, sessionId: 'risk-probe-old' });

  const status = await tools.get('relay_status').execute({}, { agent });
  assert.equal(status.workItems.phase.phase, 'build');
  assert.equal('risk' in status.workItems.phase, false, '旧记录不补 risk 字段');
  assert.doesNotMatch(status.text, /risk T[0-9]/, 'text 不伪造风险档');

  const read = await tools.get('relay_work_items').execute({}, { agent });
  assert.equal(read.phase.phase, 'build');
  assert.equal('risk' in read.phase, false, '旧记录 risk 保持 absent');
  assert.doesNotMatch(read.text, /risk T[0-9]/);
});

/**
 * W2/W3（D3）：工具返回只给内部事实，不产任何用户段。
 * - status/phase/collect/handoff：无 user/human/[给用户]；render 是内部事实；
 * - collect 未验证必须标 unverified，不冒充“全部完成/已核对”；
 * - handoff 清理 skipped 必须说“未检查/不适用”；接受后清理失败 = 部分成功 + 新会话/未清项/恢复动作。
 * 全部走真实工具 execute + output.render；tmp 工作区，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/agent.js';
import { createRelayHandoffTool } from '../lib/agent/handoff.js';
import { clearDelegationMemory, createDelegationTools } from '../lib/agent/delegation-tools.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { configurePanelStore, clearPanelMemory } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { INTERNAL_ERROR_MARK, MODEL_STATE_MARK } from '../lib/output.js';

const LEAD_CONFIRM = { no_drift: true, no_missing: true, no_regression: true };
const thresholds = thresholdsFromPercent(35);
const FORBIDDEN = /\[给用户\]|你看到什么：|要你做什么：|有什么影响：/;

function tmpCwd() { return mkdtempSync(join(tmpdir(), 'relay-w2-')); }

function resetShared() {
  clearDeriveMemory(); clearSentinelMemory(); clearPanelMemory(); clearDelegationMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-w2-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
}

function fakeSession({ id, cwd, header = { cwd } }) {
  return { id, header, seq: 0, requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }), snapshotEvents: () => [] };
}

function fakeCtx(services = {}) {
  const tools = new Map();
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools };
}

function renderOf(tool, result) {
  const blocks = tool.output.render({}, result);
  assert.equal(blocks[0].type, 'text');
  return blocks[0].text;
}

function assertInternal(rendered, name) {
  assert.ok(rendered.startsWith(MODEL_STATE_MARK) || rendered.startsWith(INTERNAL_ERROR_MARK), name + ' 必须以内部事实/错误标记开头：' + rendered.slice(0, 80));
  assert.doesNotMatch(rendered, FORBIDDEN, name + ' 不得出现用户段/三问模板');
}

function collectHarness(cwd, sessionId) {
  const lead = { session: fakeSession({ id: sessionId, cwd }) };
  const subagents = { rootOf: () => lead, namesOf: () => ({ self: 'lead' }) };
  const { ctx } = fakeCtx({ subagents });
  const definitions = createDelegationTools({ ctx, currentThresholds: () => thresholds, workItems: { enabled: true, max: 30 }, allowSpawn: false, squadMax: 8 });
  return { lead, collect: definitions.find((tool) => tool.name === 'relay_collect') };
}

async function seedDoing(cwd, sessionId, id) {
  const written = await writeWorkItems(cwd, {
    items: [{ id, title: id, status: 'doing', owner: 'worker-1', next: '回执 .scratch/context-relay/reports/' + id + '.md', phase: 'build' }],
    updatedBy: sessionId, scopeId: sessionId,
  });
  assert.equal(written.ok, true, JSON.stringify(written));
}

function writeReceipt(cwd, id, { revision, verdict = 'done', evidence = false, conclusion = '技术摘要：内部细节。' }) {
  const dir = join(cwd, '.scratch/context-relay/reports');
  mkdirSync(dir, { recursive: true });
  const lines = ['task: ' + id, 'revision: ' + revision, 'verdict: ' + verdict, '', '## 结论', conclusion, ''];
  if (evidence) lines.push('- commit: abc1234', '- cmd: node --test test/user-view.test.mjs', '- exit: 0', '');
  writeFileSync(join(dir, id + '.md'), lines.join('\n'));
}

test('collect：只返回事实，无 user/human/用户段；verified 不误标', async () => {
  resetShared();
  const cwd = tmpCwd();
  const sessionId = 'session-w2-collect';
  await seedDoing(cwd, sessionId, 'a1');
  writeReceipt(cwd, 'a1', { revision: 'd-a1', evidence: true, conclusion: '登录按钮修好了。' });
  const { lead, collect } = collectHarness(cwd, sessionId);
  const result = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.user, undefined, '无 user 字段');
  assert.equal(result.human, undefined, '无 human 用户话术');
  assert.equal(result.verification, 'verified');
  assert.equal(result.facts.kind, 'collect');
  assert.deepEqual(result.facts.evidence, [result.reportPath]);
  assert.match(result.digest, /登录按钮修好了/);
  const rendered = renderOf(collect, result);
  assertInternal(rendered, 'collect verified');
  assert.ok(rendered.includes(result.reportPath), '内部事实给报告路径');
  assert.ok(rendered.includes('verdict done'), '内部事实给 verdict');
  assert.doesNotMatch(rendered, /结果已经核对|全部完成/);
});

test('collect：未验证必须标 unverified，digest/文本不得冒充完成', async () => {
  resetShared();
  const cwd = tmpCwd();
  const sessionId = 'session-w2-collect-unverified';
  await seedDoing(cwd, sessionId, 'a2');
  writeReceipt(cwd, 'a2', { revision: 'd-a2', conclusion: '修复完成，全部完成。' });
  const { lead, collect } = collectHarness(cwd, sessionId);
  const result = await collect.execute({ itemId: 'a2', dispatchId: 'd-a2', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification, 'unverified');
  assert.equal(result.unverified, true);
  assert.match(result.digest, /^\[evidence:unverified:commit\+verification\]/, 'digest 开头明示未验证');
  assert.match(result.text, /尚未验证/, '工具文本明示未验证');
  assert.equal(result.facts.verification, 'unverified');
  assert.ok(typeof result.facts.risk === 'string' && result.facts.risk.includes('evidence missing'), 'facts 标风险');
  assert.equal(result.user, undefined);
  assert.equal(result.human, undefined);
  const rendered = renderOf(collect, result);
  assertInternal(rendered, 'collect unverified');
  assert.match(rendered, /尚未验证/);
  assert.doesNotMatch(rendered, /结果已经核对/);
});

test('status/phase：内部事实与下一步，无用户段；teammate 不返回面板字段', async () => {
  resetShared();
  const cwd = tmpCwd();
  const leadSession = fakeSession({ id: 'session-w2-lead', cwd });
  const teammateSession = fakeSession({ id: 'session-w2-mate', cwd, header: { cwd, origin: 'subagent', delegationDepth: 1, parentSession: 'session-w2-lead' } });
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 20000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 20000 }) },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
  const { ctx, tools } = fakeCtx(services);
  apply(ctx, {});
  const lead = { session: leadSession, options: {} };
  const status = await tools.get('relay_status').execute({}, { agent: lead });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.user, undefined);
  assert.equal(status.human, undefined);
  assert.equal(status.facts.kind, 'status');
  assert.ok(typeof status.facts.next === 'string' && status.facts.next !== '', 'status facts.next');
  const statusRender = renderOf(tools.get('relay_status'), status);
  assertInternal(statusRender, 'status');
  assert.ok(statusRender.includes('phase'), '内部事实保留 phase');

  const teammate = await tools.get('relay_status').execute({}, { agent: { session: teammateSession, options: {} } });
  assert.equal(teammate.user, undefined);
  assert.equal(teammate.human, undefined);
  assert.equal(teammate.panel, undefined, 'teammate 不返回面板授权字段');
  assertInternal(renderOf(tools.get('relay_status'), teammate), 'teammate status');

  const phase = await tools.get('relay_phase').execute({ phase: 'build', risk: { tier: 'T1', reason: 'docs', paths: ['docs/a.md'], lines: 10 } }, { agent: lead });
  assert.equal(phase.user, undefined);
  assert.equal(phase.human, undefined);
  assert.equal(phase.facts.kind, 'phase');
  assert.equal(phase.facts.riskTier, 'T1');
  assert.ok(typeof phase.facts.next === 'string' && phase.facts.next !== '', 'phase facts.next');
  const phaseRender = renderOf(tools.get('relay_phase'), phase);
  assertInternal(phaseRender, 'phase');
  assert.match(tools.get('relay_phase').parameters.properties.user_gate.properties.report.description, /三问/);
});

function handoffHarness(cwd, { jobs } = {}) {
  clearPanelMemory(); configurePanelStore({ panelPath: join(cwd, 'panel.json') });
  const calls = [];
  const inbox = { nextTurn: [], nextStep: [] };
  const child = {
    session: { id: 'new', header: { cwd }, requestHeader: () => undefined, snapshotEvents: () => [] },
    inbox,
    followup(message) { calls.push('dispatch'); inbox.nextTurn.push(message); },
    cancel() { inbox.nextTurn.length = 0; },
  };
  const services = {
    agents: { async create() { calls.push('create'); return { agent: child, async dispose() { calls.push('dispose'); } }; }, get: () => child },
    agentPresets: { async mount() {} },
    jobs: jobs ?? { list: () => [], kill() { calls.push('kill'); } },
    workspaceRegistry: { async resolveByPath() { return { id: 'ws', async attachSession() {} }; } },
  };
  const ctx = { get: (name) => services[name], logger: { warn() {}, info() {} }, on: () => () => {}, effect: (fn) => fn() };
  const session = { id: 'old', header: { cwd }, snapshotEvents: () => [], requestHeader: () => undefined };
  const tool = createRelayHandoffTool({ ctx, currentThresholds: () => ({ baseline: 0.35 }), presetId: 'relay', inheritOnHandoff: false, workItems: { enabled: false } });
  return { tool, session };
}

test('handoff：成功只给内部事实；链式记忆可取，清理 skipped 说“未检查/不适用”', async () => {
  resetShared();
  const cwd = tmpCwd();
  const { tool, session } = handoffHarness(cwd);
  const result = await tool.execute({ human_approved: true, status: { goal: 'handoff', next_actions: ['continue'] } }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.user, undefined);
  assert.equal(result.human, undefined);
  assert.equal(result.facts.kind, 'handoff');
  assert.equal(result.facts.chain, '.scratch/context-relay/chain.ndjson');
  assert.ok(result.facts.evidence.includes('.scratch/context-relay/chain.ndjson'));
  assert.match(result.text, /session_event_read/);
  assert.match(result.text, /不重建小队|不重建/);
  assert.match(result.text, /未检查\/不适用/, 'skipped 清理必须说未检查/不适用');
  const skipped = result.facts.cleanup?.skipped ?? [];
  assert.ok(skipped.length > 0, 'harness 未启用 schedule/team → skipped 非空');
  assert.doesNotMatch(result.text, /没有需要清理/);
  const rendered = renderOf(tool, result);
  assertInternal(rendered, 'handoff success');
  assert.match(rendered, /未检查\/不适用/);
});

test('handoff：接受后清理失败 = 部分成功，带新会话/未清项/恢复动作/不可重试', async () => {
  resetShared();
  const cwd = tmpCwd();
  const jobs = {
    list(owner) { return [{ id: 'j1', owner, status: 'running', kind: 'bash', label: 'test' }]; },
    kill() { throw new Error('kill denied'); },
  };
  const { tool, session } = handoffHarness(cwd, { jobs });
  const result = await tool.execute({ human_approved: true, status: { goal: 'handoff', next_actions: ['continue'] } }, { agent: { session, options: {} } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'handoff-cleanup-failed');
  assert.equal(result.partial, true);
  assert.equal(result.retryable, false);
  assert.ok(typeof result.sessionId === 'string' && result.sessionId !== '', '带新会话入口');
  assert.ok(typeof result.handoffPath === 'string' && result.handoffPath !== '', '带交接单/恢复入口');
  assert.equal(result.facts.partial, true);
  assert.ok(result.facts.unclean !== undefined, '带未清项');
  assert.ok(typeof result.next === 'string' && result.next.includes('不要重复 relay_handoff'), '带恢复动作');
  const rendered = renderOf(tool, result);
  assert.ok(rendered.startsWith(INTERNAL_ERROR_MARK));
  assert.match(rendered, /部分成功/);
  assert.match(rendered, /新会话：/);
  assert.match(rendered, /未清项：/);
  assert.match(rendered, /可否重试：否/);
  assert.doesNotMatch(rendered, FORBIDDEN);
});

test('handoff：预接受失败仍是内部错误，不伪造部分成功', async () => {
  resetShared();
  const cwd = tmpCwd();
  const { tool, session } = handoffHarness(cwd);
  const refused = await tool.execute({ status: { goal: 'x' } }, { agent: { session, options: {} } });
  assert.equal(refused.ok, false);
  assert.notEqual(refused.partial, true);
  assert.equal(refused.user, undefined);
  assert.equal(refused.human, undefined);
  assert.ok(refused.effects !== undefined && refused.retryable !== undefined && refused.next !== undefined);
  const rendered = renderOf(tool, refused);
  assert.ok(rendered.startsWith(INTERNAL_ERROR_MARK));
  assert.match(rendered, /可否重试：否/);
  assert.match(rendered, /先向用户取得明确 Go\/No-go/);
  assert.doesNotMatch(rendered, FORBIDDEN);
});

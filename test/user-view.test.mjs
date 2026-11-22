/**
 * W2/W3（D3）：工具返回只给内部事实，不产任何用户段。
 * - status/phase/collect/handoff：无 user/human/[给用户]；render 是内部事实；
 * - collect 未验证必须标 unverified，不冒充“全部完成/已核对”；
 * - handoff 清理 skipped 必须说“未检查/不适用”；接受后清理失败 = 部分成功 + 新会话/未清项/恢复动作。
 * 全部走真实工具 execute + output.render；tmp 工作区，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  assert.match(tools.get('relay_phase').parameters.properties.user_gate.properties.report.description, /正式汇报/);
});

function handoffHarness(cwd, { jobs, agents, sessionId = 'old', dispatchError } = {}) {
  clearPanelMemory(); configurePanelStore({ panelPath: join(cwd, 'panel.json') });
  const calls = [];
  const inbox = { nextTurn: [], nextStep: [] };
  const child = {
    session: { id: 'new', header: { cwd }, requestHeader: () => undefined, snapshotEvents: () => [] },
    inbox,
    followup(message) { calls.push('dispatch'); inbox.nextTurn.push(message); if (dispatchError !== undefined) throw dispatchError; },
    cancel() { inbox.nextTurn.length = 0; },
  };
  const services = {
    agents: agents ?? { async create() { calls.push('create'); return { agent: child, async dispose() { calls.push('dispose'); } }; }, get: () => child },
    agentPresets: { async mount() {} },
    jobs: jobs ?? { list: () => [], kill() { calls.push('kill'); } },
    workspaceRegistry: { async resolveByPath() { return { id: 'ws', async attachSession() {} }; } },
  };
  const ctx = { get: (name) => services[name], logger: { warn() {}, info() {} }, on: () => () => {}, effect: (fn) => fn() };
  const session = { id: sessionId, header: { cwd }, snapshotEvents: () => [], requestHeader: () => undefined };
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

/** 写盘后失败/已有交接单：事实必须摊开且渲染可见，不伪称零副作用。 */
function assertHandoffFailureFacts(tool, result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, code);
  assert.ok(typeof result.handoffPath === 'string' && result.handoffPath !== '', '带交接单路径');
  assert.equal(existsSync(result.handoffPath), true, '交接单确实在盘上');
  assert.ok(typeof result.effects === 'string' && result.effects !== '', 'effects 非空');
  assert.ok(result.effects.includes(result.handoffPath), 'effects 带交接单路径');
  assert.doesNotMatch(result.effects, /零副作用|没有产生任何改动/, '不伪称零副作用');
  assert.equal(result.facts.effects, result.effects, 'facts 与顶层 effects 同源');
  assert.equal(result.retryable, false, '写盘后失败不可原地重试');
  assert.ok(typeof result.next === 'string' && result.next !== '', '带明确下一步');
  assert.equal(result.user, undefined);
  assert.equal(result.human, undefined);
  const rendered = renderOf(tool, result);
  assert.ok(rendered.startsWith(INTERNAL_ERROR_MARK));
  assert.match(rendered, /交接单：/);
  assert.ok(rendered.includes(result.handoffPath), 'render 显示 handoffPath');
  assert.match(rendered, /事实：/, 'render 显示 summary');
  assert.match(rendered, /已经发生：/);
  assert.match(rendered, /可否重试：否/);
  assert.doesNotMatch(rendered, /零副作用/);
  assert.doesNotMatch(rendered, FORBIDDEN);
  return rendered;
}

test('handoff：预接受、写盘后失败——effects 非空/不可重试/交接单可见，不伪造零副作用', async () => {
  resetShared();
  const cwd = tmpCwd();
  const { tool, session } = handoffHarness(cwd, {
    sessionId: 'session-preaccept-write-fail',
    agents: { async create() { throw new Error('create boom'); } },
  });
  const result = await tool.execute({ human_approved: true, status: { goal: 'create fail', next_actions: ['finish'] } }, { agent: { session, options: {} } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'session-create-failed');
  assert.notEqual(result.partial, true, '预接受失败不是部分成功');
  assert.ok(typeof result.handoffPath === 'string' && result.handoffPath !== '', '带交接单路径');
  assert.match(result.handoffPath, /handoff-\d+\.md$/, '交接单路径是已写盘文件');
  assert.equal(existsSync(result.handoffPath), true, '交接单确实已写盘');
  assert.ok(typeof result.effects === 'string' && result.effects !== '', 'effects 非空');
  assert.doesNotMatch(result.effects, /零副作用|没有产生任何改动/, '不伪称零副作用');
  assert.ok(result.effects.includes('交接单已写盘') && result.effects.includes(result.handoffPath), 'effects 说明交接单已写盘');
  assert.match(result.effects, /创建失败\/半创建|没有建出新会话/, 'effects 说明没有可用新会话');
  assert.match(result.effects, /旧会话仍活跃/, 'effects 说明旧会话仍活跃');
  assert.equal(result.retryable, false, '写盘后失败不可原地重试');
  assert.ok(typeof result.next === 'string' && /不要重复 relay_handoff/.test(result.next), '恢复动作明确不重复交接');
  assert.equal(result.facts.effects, result.effects, 'facts 与顶层 effects 同源');
  assert.equal(result.user, undefined);
  assert.equal(result.human, undefined);
  const rendered = renderOf(tool, result);
  assert.ok(rendered.startsWith(INTERNAL_ERROR_MARK));
  assert.match(rendered, /交接单：/);
  assert.ok(rendered.includes(result.handoffPath), 'render 显示 handoffPath');
  assert.match(rendered, /事实：/, 'render 显示 summary');
  assert.match(rendered, /已经发生：/);
  assert.match(rendered, /可否重试：否/);
  assert.doesNotMatch(rendered, /零副作用/);
  assert.doesNotMatch(rendered, FORBIDDEN);
});

test('handoff：交接单已写、首条消息未被接受（followup-failed）——effects 摊开/不可重试', async () => {
  resetShared();
  const cwd = tmpCwd();
  const { tool, session } = handoffHarness(cwd, {
    sessionId: 'session-followup-fail',
    dispatchError: new Error('followup rejected'),
  });
  const result = await tool.execute({ human_approved: true, status: { goal: 'followup fail', next_actions: ['finish'] } }, { agent: { session, options: {} } });
  const rendered = assertHandoffFailureFacts(tool, result, 'followup-failed');
  assert.equal(result.partial, undefined, '预接受失败不是部分成功');
  assert.match(result.effects, /新会话 .* 已创建/);
  assert.match(result.effects, /首条消息未被接受（followup-failed）/);
  assert.match(result.effects, /旧会话仍活跃/);
  assert.match(result.next, /不要重复 relay_handoff/);
  assert.ok(rendered.includes('followup-failed'), 'render 事实含失败码');
});

test('handoff：交接单已写、progress 写盘失败（progress-write-failed）——effects 摊开/不可重试', async () => {
  resetShared();
  const cwd = tmpCwd();
  // 把 progress.md 预建成目录：updateProgress 的原子替换必然抛错，稳定命中该分支。
  mkdirSync(join(cwd, '.scratch', 'context-relay', 'progress.md'), { recursive: true });
  const { tool, session } = handoffHarness(cwd, { sessionId: 'session-progress-fail' });
  const result = await tool.execute({ human_approved: true, status: { goal: 'progress fail', next_actions: ['finish'] } }, { agent: { session, options: {} } });
  assertHandoffFailureFacts(tool, result, 'progress-write-failed');
  assert.match(result.effects, /新会话 .* 已创建/);
  assert.match(result.effects, /progress\.md 未更新/);
  assert.match(result.effects, /旧会话仍活跃/);
  assert.match(result.next, /修复 progress 写入/);
});

test('handoff：已有已接受交接单（recovery-required）——摊开旧交接单/目标会话/effects', async () => {
  resetShared();
  const cwd = tmpCwd();
  const dir = join(cwd, '.scratch', 'context-relay');
  mkdirSync(dir, { recursive: true });
  const handoffPath = join(dir, 'handoff-existing.md');
  writeFileSync(handoffPath, '# existing accepted handoff\n');
  writeFileSync(join(dir, 'handoff-recovery-session-recovery-required.json'), JSON.stringify({
    sessionId: 'new-accepted',
    state: 'accepted',
    handoffPath,
    takeover: { accepted: true },
    recovery: [{ step: 'cancel-job:j1', error: 'kill denied' }],
  }));
  delete globalThis[Symbol.for('dsh-context-relay.handoff.recovery')];
  const { tool, session } = handoffHarness(cwd, { sessionId: 'session-recovery-required' });
  const result = await tool.execute({ human_approved: true, status: { goal: 'duplicate handoff', next_actions: ['finish'] } }, { agent: { session, options: {} } });
  const rendered = assertHandoffFailureFacts(tool, result, 'recovery-required');
  assert.equal(result.sessionId, 'new-accepted', '带已接受的目标会话');
  assert.equal(result.handoffPath, handoffPath, '带已有交接单路径');
  assert.match(result.effects, /本次没有新建会话或交接单/);
  assert.match(result.effects, /已有已接受的交接单/);
  assert.match(result.effects, /仍需按 recovery 收尾/);
  assert.deepEqual(result.recovery, [{ step: 'cancel-job:j1', error: 'kill denied' }]);
  assert.match(result.next, /不要重复 relay_handoff/);
  assert.ok(rendered.includes('new-accepted'), 'render 显示目标会话');
});

test('organize：brief 已写盘、压缩失败（compaction-failed）——effects 摊开 brief/未注入/docLint', async () => {
  resetShared();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-organize-compaction-fail', cwd });
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 420000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 420000 }) },
    compaction: { async compactIfNeeded() { throw new Error('provider exploded'); } },
  };
  const { ctx, tools } = fakeCtx(services);
  apply(ctx, {});
  const tool = tools.get('relay_organize');
  const result = await tool.execute({ phase: 'build', brief: 'decided X', force: true }, { agent: { session, options: {} } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'compaction-failed');
  assert.ok(typeof result.briefPath === 'string' && result.briefPath !== '');
  assert.equal(existsSync(result.briefPath), true, 'brief 确实已写盘');
  assert.ok(typeof result.effects === 'string' && result.effects !== '', 'effects 非空');
  assert.ok(result.effects.includes(result.briefPath), 'effects 带 brief 路径');
  assert.match(result.effects, /本次压缩未完成/);
  assert.match(result.effects, /未注入/);
  assert.match(result.effects, /docLint/);
  assert.doesNotMatch(result.effects, /零副作用|没有产生任何改动/);
  assert.equal(result.retryable, true, '压缩失败可重试（重试会另写一份 brief）');
  assert.ok(typeof result.next === 'string' && result.next.includes(result.briefPath) && /重试/.test(result.next));
  assert.equal(result.facts.effects, result.effects);
  const rendered = renderOf(tool, result);
  assert.ok(rendered.startsWith(INTERNAL_ERROR_MARK));
  assert.ok(rendered.includes(result.briefPath), 'render 显示 briefPath');
  assert.match(rendered, /已经发生：/);
  assert.match(rendered, /可否重试：是/);
  assert.doesNotMatch(rendered, /零副作用/);
});

test('W2 schema：status/phase/collect/handoff 的 output.schema 声明事实形状（不再只是 object）', async () => {
  resetShared();
  const { ctx, tools } = fakeCtx();
  apply(ctx, {});
  const { collect } = collectHarness(tmpCwd(), 'session-w2-schema');
  const { tool: handoff } = handoffHarness(tmpCwd());
  const fields = ['ok', 'status', 'phase', 'effects', 'retryable', 'next', 'evidence', 'risk', 'facts', 'summary'];
  for (const [name, tool] of [['relay_status', tools.get('relay_status')], ['relay_phase', tools.get('relay_phase')], ['relay_collect', collect], ['relay_handoff', handoff]]) {
    assert.ok(tool !== undefined, name + ' 存在');
    assert.ok(tool.output?.schema !== undefined, name + ' 有 output.schema');
    assert.equal(tool.output.schema.type, 'object', name + ' schema 类型');
    assert.equal(tool.output.schema.additionalProperties, true, name + ' 允许工具扩展字段');
    for (const field of fields) assert.ok(field in (tool.output.schema.properties ?? {}), name + ' schema 缺事实字段: ' + field);
    assert.doesNotMatch(JSON.stringify(tool.output.schema), /用户可见|给用户正文/);
  }
});

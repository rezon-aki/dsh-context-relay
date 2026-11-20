/**
 * v0.13 P4（plain-report D1/D4）：工具默认 render 给「拿给用户看的那段」。
 * - collect/handoff：先 [给用户] 三问，再 [内部细节·不要转述]（digest/证据/字段名不投递）；
 * - status/phase/dispatch 等内部工具：带 [模型状态/内部] 标记，不生成 [给用户]；
 * - 失败：只给 [内部错误] 一行，不再把 human 四段 JSON 当输出；
 * - 回执「## 用户可见」节优先，缺失时中性兜底；模板加可选节（缺失不拒绝）。
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
import { composeDispatchBrief } from '../lib/agent/delegation.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { configurePanelStore, clearPanelMemory } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { INTERNAL_DETAILS_MARK, INTERNAL_ERROR_MARK, MODEL_STATE_MARK, internalKeysIn } from '../lib/output.js';

const LEAD_CONFIRM = { no_drift: true, no_missing: true, no_regression: true };
const thresholds = thresholdsFromPercent(35);
/** 用户段里不得出现的内部字段名（原始键护栏，不是词表）。 */
const INTERNAL_FIELD_RE = /reportPath|technicalDigest|dispatchId|revision|verdict|commit|digest|sessionId|handoffPath|summary|headroomTo|band=|\bseq\b/;

function tmpCwd() { return mkdtempSync(join(tmpdir(), 'relay-p4-')); }

function resetShared() {
  clearDeriveMemory(); clearSentinelMemory(); clearPanelMemory(); clearDelegationMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-p4-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
}

function fakeSession({ id, cwd }) {
  return { id, header: { cwd }, seq: 0, requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }), snapshotEvents: () => [] };
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

function writeReceipt(cwd, id, { revision, verdict = 'done', userVisible }) {
  const dir = join(cwd, '.scratch/context-relay/reports');
  mkdirSync(dir, { recursive: true });
  const lines = ['task: ' + id, 'revision: ' + revision, 'verdict: ' + verdict, '', '## 结论', '技术摘要：内部细节。', ''];
  if (userVisible !== undefined) lines.push('## 用户可见', '你看到什么：' + userVisible.see, '要你做什么：' + userVisible.need, '有什么影响：' + userVisible.impact, '');
  if (userVisible?.decision !== undefined) lines.push('## 需要你决定', userVisible.decision, '');
  writeFileSync(join(dir, id + '.md'), lines.join('\n'));
}

test('collect render：默认先给 [给用户] 三问，digest/证据留在结构化字段；内部字段名不进用户段', async () => {
  resetShared();
  const cwd = tmpCwd();
  const sessionId = 'session-p4-collect';
  await seedDoing(cwd, sessionId, 'a1');
  writeReceipt(cwd, 'a1', { revision: 'd-a1-p4', userVisible: { see: '登录按钮修好了。', need: '不用。', impact: '没有额外影响。' } });
  const { lead, collect } = collectHarness(cwd, sessionId);
  const result = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-p4', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.user.see, '登录按钮修好了。', '回执「## 用户可见」优先');
  assert.match(result.digest, /登录按钮修好了/, 'digest 取用户可见节');
  assert.ok(typeof result.technicalDigest === 'string' && result.technicalDigest.includes('技术摘要'), '技术摘要留在 technicalDigest');
  const rendered = renderOf(collect, result);
  assert.ok(rendered.startsWith('[给用户]'), '默认 render 以 [给用户] 开头');
  for (const label of ['你看到什么：', '要你做什么：', '有什么影响：']) assert.ok(rendered.includes(label), '三问齐全：' + label);
  assert.ok(rendered.includes(INTERNAL_DETAILS_MARK), '技术细节有内部标记');
  assert.ok(rendered.includes('报告：'), '内部段给报告路径（继续操作要用）');
  assert.ok(!rendered.includes(result.digest), 'digest 不进默认 render');
  assert.ok(!rendered.includes(result.technicalDigest), '技术摘要不进默认 render');
  const userPart = rendered.split(INTERNAL_DETAILS_MARK)[0];
  assert.deepEqual(internalKeysIn(userPart), [], '用户段无内部键');
  assert.doesNotMatch(userPart, INTERNAL_FIELD_RE, '用户段无内部字段名：' + userPart);
});

test('collect render：无「## 用户可见」时中性兜底；needs-human 带需要你决定', async () => {
  resetShared();
  const cwd = tmpCwd();
  const sessionId = 'session-p4-collect-fallback';
  await seedDoing(cwd, sessionId, 'a1');
  writeReceipt(cwd, 'a1', { revision: 'd-a1-fb' });
  const { lead, collect } = collectHarness(cwd, sessionId);
  const done = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-fb', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.match(done.digest, /一项工作完成了/, '中性兜底一句话');
  assert.doesNotMatch(done.digest, /技术摘要/, '技术摘要不投递');
  const rendered = renderOf(collect, done);
  assert.ok(rendered.startsWith('[给用户]'));
  // needs-human verdict → blocked 的真实 execute 路径
  await seedDoing(cwd, sessionId, 'a2');
  writeReceipt(cwd, 'a2', { revision: 'd-a2-fb', verdict: 'needs-human', userVisible: { see: '需要你拍板。', need: '选 A 还是 B。', impact: '决定前不动。', decision: '问题：A/B？推荐：A；默认：A。' } });
  const blocked = await collect.execute({ itemId: 'a2', dispatchId: 'd-a2-fb', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.equal(blocked.verdict, 'needs-human');
  assert.match(blocked.user.need, /需要你决定：问题：A\/B？推荐：A/, '需要你决定并入 need');
  const blockedRender = renderOf(collect, blocked);
  assert.ok(blockedRender.startsWith('[给用户]'));
  assert.ok(blockedRender.includes('需要你决定'), 'needs-human 的 render 指出要用户决定');
});

test('status/phase render：凡带 human 的工具默认先给用户段；技术事实留 [内部细节]', async () => {
  resetShared();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-p4-internal', cwd });
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 20000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 20000 }) },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
  const { ctx, tools } = fakeCtx(services);
  apply(ctx, {});
  const agent = { session, options: {} };
  const status = await tools.get('relay_status').execute({}, { agent });
  const phase = await tools.get('relay_phase').execute({ phase: 'build', risk: { tier: 'T1', reason: 'docs', paths: ['docs/a.md'], lines: 10 } }, { agent });
  for (const [name, tool, result] of [['relay_status', tools.get('relay_status'), status], ['relay_phase', tools.get('relay_phase'), phase]]) {
    const rendered = renderOf(tool, result);
    assert.ok(rendered.startsWith('[给用户]'), name + ' render 默认先给用户段（D1：凡带 human 的工具）');
    for (const label of ['你看到什么：', '要你做什么：', '有什么影响：']) assert.ok(rendered.includes(label), name + ' 三问齐全：' + label);
    assert.ok(rendered.includes(INTERNAL_DETAILS_MARK), name + ' 技术细节有内部标记');
    const userPart = rendered.split(INTERNAL_DETAILS_MARK)[0];
    assert.doesNotMatch(userPart, INTERNAL_FIELD_RE, name + ' 用户段无内部字段名：' + userPart);
    assert.match(rendered.slice(rendered.indexOf(INTERNAL_DETAILS_MARK)), /phase|band=|context/, name + ' 内部段仍保留模型状态');
  }
});

function handoffHarness(cwd) {
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
    jobs: { list: () => [], kill() { calls.push('kill'); } },
    workspaceRegistry: { async resolveByPath() { return { id: 'ws', async attachSession() {} }; } },
  };
  const ctx = { get: (name) => services[name], logger: { warn() {}, info() {} }, on: () => () => {}, effect: (fn) => fn() };
  const session = { id: 'old', header: { cwd }, snapshotEvents: () => [], requestHeader: () => undefined };
  const tool = createRelayHandoffTool({ ctx, currentThresholds: () => ({ baseline: 0.35 }), presetId: 'relay', inheritOnHandoff: false, workItems: { enabled: false } });
  return { tool, session };
}

test('handoff render：[给用户] 先说新会话已建好，内部段保留 summary；失败给 [内部错误]', async () => {
  resetShared();
  const cwd = tmpCwd();
  const { tool, session } = handoffHarness(cwd);
  const result = await tool.execute({ human_approved: true, status: { goal: 'handoff', next_actions: ['continue'] } }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.user.visible, true);
  const rendered = renderOf(tool, result);
  assert.ok(rendered.startsWith('[给用户]'), 'handoff 默认 render 以 [给用户] 开头');
  for (const label of ['你看到什么：', '要你做什么：', '有什么影响：']) assert.ok(rendered.includes(label), label);
  assert.ok(rendered.includes(INTERNAL_DETAILS_MARK), '技术 summary 有内部标记');
  const userPart = rendered.split(INTERNAL_DETAILS_MARK)[0];
  assert.doesNotMatch(userPart, INTERNAL_FIELD_RE, '用户段无内部字段名：' + userPart);
  // 失败路径（缺 human_approved）：只给内部错误一行，不把 human 四段当输出
  const refused = await tool.execute({ status: { goal: 'x' } }, { agent: { session: { ...session, id: 'old2' }, options: {} } });
  assert.equal(refused.ok, false);
  const failedText = renderOf(tool, refused);
  assert.ok(failedText.startsWith(INTERNAL_ERROR_MARK), '失败 render 以内部错误标记开头');
  assert.ok(!failedText.startsWith('{'), '失败不是 JSON 包络');
  assert.ok(!failedText.includes('"human"'), '失败不把 human 四段投递');
});

test('dispatch brief：worker 回执模板含可选 ## 用户可见 / ## 需要你决定（缺失不拒绝）', () => {
  const brief = composeDispatchBrief({ itemId: 'a1', dispatchId: 'd-a1', brief: '目标', docs: ['r.md'], writeScope: ['lib/'], acceptance: 'ok', reportPath: '.scratch/context-relay/reports/a1.md' });
  assert.match(brief, /## 用户可见/, '模板含可选用户可见节');
  assert.match(brief, /需要你决定/, 'needs-human 时加需要你决定');
  assert.match(brief, /缺失不拒绝/, '缺失不拒绝');
});

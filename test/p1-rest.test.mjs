/**
 * v0.13 P1 剩余四块验收（relay-systemic-audit §6 D2/D3/D4）：
 * ① collect 回执证据（commit+verification，缺只标 unverified）
 * ② user_gate.review_ref（path/revision/verdict；warn 默认，receiptVerify=strict 拒）
 * ③ protocol 的 subagent 只读例外（执行活仍必须 relay_dispatch + report/commit 回填）
 * ④ schema 外参数 warn→JSONL（strictToolArgs=true 才拒）
 * 全部走工具 execute / apply 装配的真实路径；tmp 工作区 + 进程内 fake 服务，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { createRelayTools } from '../lib/agent/tools.js';
import { clearDelegationMemory, createDelegationTools } from '../lib/agent/delegation-tools.js';
import { PROTOCOL_TEXT, ROUTER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';

const LEAD_CONFIRM = { no_drift: true, no_missing: true, no_regression: true };
const thresholds = thresholdsFromPercent(35);
const CONTRACT_CHECK = { requirement: 'r', fidelity: 'f', attention: 'a' };
const DESIGN_GATE = { path: '.scratch/design.md', user_approved: true, ask_ref: 'go', not_doing: ['no npm'] };

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-p1rest-'));
}

function resetShared() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-p1rest-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearDelegationMemory();
}

function fakeSession({ id, cwd }) {
  return {
    id,
    header: { cwd },
    seq: 0,
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
    snapshotEvents: () => [],
  };
}

/** apply 用最小 fake ctx（tools/events/sections/logs 捕获）。 */
function fakeCtx(services = {}) {
  const tools = new Map();
  const events = [];
  const logs = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn(line) { logs.push(String(line)); } },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, events, logs };
}

function fakeServices(session) {
  return {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 20000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 20000 }) },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
}

function applyAgent(services, config = {}) {
  const { ctx, tools, events, logs } = fakeCtx(services);
  apply(ctx, config);
  return { tools, events, logs };
}

// ── ① relay_collect：回执正文证据块（commit + verification；缺只标 unverified）──────

function collectHarness(cwd) {
  const lead = { session: fakeSession({ id: 'session-p1-collect', cwd }) };
  const subagents = { rootOf: () => lead, namesOf: () => ({ self: 'lead' }) };
  const { ctx } = fakeCtx({ subagents });
  const definitions = createDelegationTools({
    ctx,
    currentThresholds: () => thresholds,
    workItems: { enabled: true, max: 30 },
    allowSpawn: false,
    squadMax: 8,
  });
  return { lead, collect: definitions.find((tool) => tool.name === 'relay_collect') };
}

async function seedDoing(cwd, ids) {
  const written = await writeWorkItems(cwd, {
    items: ids.map((id) => ({ id, title: id, status: 'doing', owner: 'worker-1', next: '回执 .scratch/context-relay/reports/' + id + '.md', phase: 'build' })),
    updatedBy: 'session-p1-collect',
    scopeId: 'session-p1-collect',
  });
  assert.equal(written.ok, true, JSON.stringify(written));
}

function writeReport(cwd, id, { revision, verdict = 'done', conclusion, evidenceBlock }) {
  const dir = join(cwd, '.scratch/context-relay/reports');
  mkdirSync(dir, { recursive: true });
  const body = ['task: ' + id, 'revision: ' + revision, 'verdict: ' + verdict, '', '## 结论', conclusion, ''];
  if (evidenceBlock !== undefined) body.push('## 验证', evidenceBlock, '');
  writeFileSync(join(dir, id + '.md'), body.join('\n'));
}

test('① relay_collect：正文含 commit+verification → evidence verified；缺失 → unverified 且 digest 明示（warn 不拒）', async () => {
  resetShared();
  const cwd = tmpCwd();
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  await seedDoing(cwd, ['e1', 'e2']);
  writeReport(cwd, 'e1', {
    revision: 'd-e1-test',
    conclusion: '证据齐全，完成。',
    evidenceBlock: '- commit: ' + sha + '\n- tree: clean\n- cmd: npm test\n  exit: 0\n  count: 1015\n  log: .scratch/context-relay/logs/t.log',
  });
  writeReport(cwd, 'e2', { revision: 'd-e2-test', conclusion: '旧格式回执，只有结论。' });
  const { lead, collect } = collectHarness(cwd);

  const verified = await collect.execute({ itemId: 'e1', dispatchId: 'd-e1-test', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.verdict, 'done');
  assert.deepEqual(verified.evidence, {
    verdict: 'verified',
    commit: sha,
    verification: { cmd: 'npm test', exit: '0', count: '1015', log: '.scratch/context-relay/logs/t.log' },
    missing: [],
  });
  assert.equal(verified.digest, '证据齐全，完成。', 'user_visible 默认 false → digest 仍是技术摘要');
  assert.equal(readWorkItems(cwd, { scopeId: 'session-p1-collect' }).items.find((item) => item.id === 'e1').status, 'done');

  const unverified = await collect.execute({ itemId: 'e2', dispatchId: 'd-e2-test', lead_confirm: LEAD_CONFIRM }, { agent: lead });
  assert.equal(unverified.ok, true, 'warn 不拒：仍收口');
  assert.equal(unverified.verdict, 'done');
  assert.deepEqual(unverified.evidence, { verdict: 'unverified', missing: ['commit', 'verification'] });
  assert.match(unverified.digest, /^\[evidence:unverified:commit\+verification\] /);
  assert.match(unverified.evidenceWarning, /commit/);
  assert.equal(readWorkItems(cwd, { scopeId: 'session-p1-collect' }).items.find((item) => item.id === 'e2').status, 'done');
});

// ── ② user_gate.review_ref：path 存在 + revision=HEAD + verdict=done ──────────────

function reviewFixture(tag) {
  const cwd = tmpCwd();
  execFileSync('git', ['-C', cwd, 'init', '-q']);
  execFileSync('git', ['-C', cwd, 'config', 'user.email', 'p1@test']);
  execFileSync('git', ['-C', cwd, 'config', 'user.name', 'p1']);
  writeFileSync(join(cwd, 'a.txt'), 'x');
  execFileSync('git', ['-C', cwd, 'add', '-A']);
  execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
  const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync(join(cwd, '.scratch', 'context-relay', 'reports'), { recursive: true });
  writeFileSync(join(cwd, '.scratch', 'design.md'), '# design');
  const reportPath = '.scratch/context-relay/reports/review-' + tag + '.md';
  writeFileSync(join(cwd, reportPath), 'task: review-' + tag + '\nrevision: ' + head + '\nverdict: done\n\n## 结论\n审查通过。\n');
  return { cwd, head, reportPath };
}

async function shipWithReviewRef({ tag, receiptVerify, revisionOf }) {
  const { cwd, head, reportPath } = reviewFixture(tag);
  const ctx = fakeCtx().ctx;
  const phase = createRelayTools({
    ctx, currentThresholds: () => thresholds, injectBrief: true,
    workItems: { enabled: true }, delegation: { gate: 'warn' }, docs: {},
    ...(receiptVerify === undefined ? {} : { receiptVerify }),
  }).find((tool) => tool.name === 'relay_phase');
  const session = fakeSession({ id: 'session-p1-review-' + tag, cwd });
  const agent = { session, options: {} };
  const call = (args) => phase.execute(args, { agent });
  await call({ phase: 'build', design_gate: DESIGN_GATE });
  await call({ phase: 'verify' });
  const gate = { review: '独立审查通过', report: '汇报', review_ref: { path: reportPath, revision: revisionOf(head), verdict: 'done' } };
  return { call, gate, cwd, head, reportPath, session };
}

test('② user_gate.review_ref：合法 → verified；revision 不符 → warn（ship 放行）；strict 拒；off 跳过', async () => {
  resetShared();
  const okPath = await shipWithReviewRef({ tag: 'ok', revisionOf: (head) => head });
  const shipped = await okPath.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: okPath.gate });
  assert.equal(shipped.phase, 'ship');
  assert.equal(shipped.user_gate.review_ref.status, 'verified', JSON.stringify(shipped.user_gate.review_ref));
  assert.equal(shipped.user_gate.review_ref.path, okPath.reportPath);
  assert.equal(shipped.user_gate.review_ref.revision, okPath.head);

  resetShared();
  const warnPath = await shipWithReviewRef({ tag: 'warn', revisionOf: () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  const warned = await warnPath.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: warnPath.gate });
  assert.equal(warned.phase, 'ship', '默认 warn：ship 放行');
  assert.equal(warned.user_gate.review_ref.status, 'unverified');
  assert.deepEqual(warned.user_gate.review_ref.problems, ['revision-mismatch']);
  assert.ok(warned.user_gate.warnings.some((obj) => obj.code === 'review-ref:revision-mismatch'), JSON.stringify(warned.user_gate.warnings));

  resetShared();
  const strictPath = await shipWithReviewRef({ tag: 'strict', receiptVerify: 'strict', revisionOf: () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  await assert.rejects(strictPath.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: strictPath.gate }), /review_ref|review ref/, 'strict 才拒');

  resetShared();
  const offPath = await shipWithReviewRef({ tag: 'off', receiptVerify: 'off', revisionOf: () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  const off = await offPath.call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: offPath.gate });
  assert.equal(off.phase, 'ship');
  assert.equal(off.user_gate.review_ref, undefined, 'off 完全跳过');
});

// ── ③ protocol：subagent 只读例外；执行活仍必须 relay_dispatch ───────────────────

test('③ protocol：只读审查/探针可用官方 subagent，执行活仍必须 relay_dispatch 且回填 report+commit', () => {
  assert.match(PROTOCOL_TEXT, /任何执行工作一律派 worker/);
  assert.match(PROTOCOL_TEXT, /只读.*官方 subagent/);
  assert.match(PROTOCOL_TEXT, /report\+commit/);
  assert.doesNotMatch(PROTOCOL_TEXT, /不要手工 subagent\/send_message 派执行活/, '旧的绝对禁令已改为带例外的口径');
  assert.match(ROUTER_PROTOCOL_TEXT, /只读审查\/探针可用/);
  assert.match(ROUTER_PROTOCOL_TEXT, /回填 report\+commit/);
  assert.match(ROUTER_PROTOCOL_TEXT, /执行活不要手工 subagent/);
});

// ── ④ schema 外参数：warn 只记 JSONL；strictToolArgs=true 拒绝 ───────────────────

function argLogPath(cwd) {
  return join(cwd, '.scratch/context-relay/logs/tool-args-warnings.jsonl');
}

test('④ 参数校验：schema 外字段 warn 记 (tool,field) JSONL 不拒；strictToolArgs=true 拒绝', async () => {
  resetShared();
  const warnCwd = tmpCwd();
  const warnSession = fakeSession({ id: 'session-p1-args-warn', cwd: warnCwd });
  const warnBundle = applyAgent(fakeServices(warnSession));
  const warnAgent = { session: warnSession, options: {} };
  const warned = await warnBundle.tools.get('relay_status').execute({ bogus_field: 1 }, { agent: warnAgent });
  assert.equal(warned.ok, true, '默认只 warn，不拒绝: ' + JSON.stringify(warned));
  const logText = readFileSync(argLogPath(warnCwd), 'utf8').trim().split('\n');
  assert.equal(logText.length, 1);
  const entry = JSON.parse(logText[0]);
  assert.equal(entry.tool, 'relay_status');
  assert.deepEqual(entry.fields, ['bogus_field']);
  assert.ok(warnBundle.logs.some((line) => /unknown args for relay_status: bogus_field/.test(line)));
  // 合法参数不记日志
  await warnBundle.tools.get('relay_status').execute({}, { agent: warnAgent });
  assert.equal(readFileSync(argLogPath(warnCwd), 'utf8').trim().split('\n').length, 1, '已知字段不写 warn');

  resetShared();
  const strictCwd = tmpCwd();
  const strictSession = fakeSession({ id: 'session-p1-args-strict', cwd: strictCwd });
  const strictBundle = applyAgent(fakeServices(strictSession), { strictToolArgs: true });
  const refused = await strictBundle.tools.get('relay_status').execute({ bogus_field: 1 }, { agent: { session: strictSession, options: {} } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'invalid-args');
  assert.deepEqual(refused.fields, ['bogus_field']);
  assert.match(refused.summary, /strictToolArgs=true/);
  assert.equal(JSON.parse(readFileSync(argLogPath(strictCwd), 'utf8').trim()).fields[0], 'bogus_field', '拒绝路径也留审计日志');
});

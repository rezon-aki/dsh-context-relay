/**
 * v0.5.0 工作台账 · 闸门接入测试（T2，契约 §3/§5/§6）：
 * relay_work_items 工具（Lead 全量 / 队友受限 / 错误码）、relay_status 摘要、relay_organize brief 段、
 * relay_phase ship 闸门（user_gate 之后、零副作用）与 leftover、relay_handoff 台账段
 * （next_actions 顺序 / 正文 8KB / 首条消息入口 / corrupt fail-open）、到线提醒台账行、
 * team-tools checkpoint 摘要 / renew owner 迁移。
 * 每个闸门都含「空台账 = 旧行为不变」回归断言；文件全部写 mkdtemp 临时目录，不触真实工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { clearSentinelMemory, sentinelText } from '../lib/agent/sentinel.js';
import { thresholdsFromPercent } from '../lib/policy.js';

const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';
const CONTRACT_CHECK = { requirement: '需求已定：工作台账闸门接入；边界：只改 T2 写范围', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };
const SHIP_GATE = { review: 'fresh subagent 独立审查：需求已定、实现忠实，无偏移/劣化/偷懒/缺失', report: '大白话汇报：需求 → 实现 + 证据 → 无偏差、边界已说明' };
const thresholds = thresholdsFromPercent(35);

/** 每个测试前重置进程级共享状态（与 agent.test.mjs 同口径，避免跨测试污染）。 */
function resetSharedState() {
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  delete globalThis[Symbol.for('dsh-context-relay.handoff.routes')];
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-panel-')), 'panel.json') });
  clearSentinelMemory();
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-wi-'));
}

function fakeCtx(overrides = {}) {
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
    get(name) { return overrides.services?.[name]; },
  };
  return { ctx, tools, sections, events, logs };
}

function fakeSession({ id = 'session-test', cwd, log = [], seq, header } = {}) {
  const builtHeader = header ?? (cwd === undefined ? {} : { cwd });
  return {
    id,
    header: builtHeader,
    get seq() { return seq ?? log.length; },
    snapshotEvents() { return log; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function fakeServices({ session, pressure = { contextWindow: 1_000_000, projectedTokens: 20000 }, compaction, extra = {} } = {}) {
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
  const bundle = fakeCtx({ services });
  apply(bundle.ctx, config);
  return bundle;
}

function writeLedger(cwd, items, { rev = 1 } = {}) {
  const path = join(cwd, WORK_ITEMS_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rev, updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'test', items }, null, 2));
  return path;
}

function readLedgerFile(cwd) {
  return JSON.parse(readFileSync(join(cwd, WORK_ITEMS_REL), 'utf8'));
}

/** 最小 handoff 夹具（新会话 + 首条消息捕获；与 agent.test.mjs 的 handoff 成功夹具同口径）。 */
function handoffServices({ session, cwd, followed }) {
  const childId = 'session-new';
  const liveSession = { id: childId, header: { cwd }, requestHeader: () => undefined };
  return fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: childId }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); } }] },
      sessionTitle: { rename() {} },
    },
  });
}

// ── relay_work_items 工具 ──────────────────────────────────────────────

test('relay_work_items：注册且无参=读（空台账 exists=false）；Lead 整表替换 + rev 乐观锁 + 校验错误码', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-lead', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const tool = tools.get('relay_work_items');
  assert.ok(tool !== undefined, 'relay_work_items 已注册');
  const agent = { session, options: {} };
  assert.match(tool.description, /work ledger/);

  const empty = await tool.execute({}, { agent });
  assert.equal(empty.ok, true);
  assert.equal(empty.mode, 'read');
  assert.equal(empty.exists, false);
  assert.equal(empty.counts.total, 0);
  assert.deepEqual(empty.unclosed, []);
  assert.equal(empty.relativePath, WORK_ITEMS_REL);
  assert.match(empty.text, /工作台账/);

  const replaced = await tool.execute({
    items: [
      { id: 'api-export', title: '导出 API', status: 'doing', owner: 'worker-1', next: '写完 handler', evidence: ['lib/index.js:120'], phase: 'build' },
      { id: 'schema', title: '定 schema', status: 'done', evidence: ['docs/schema.md:1'] },
    ],
  }, { agent });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.equal(replaced.mode, 'replace');
  assert.equal(replaced.exists, true);
  assert.equal(replaced.rev, 1);
  assert.equal(replaced.counts.total, 2);
  assert.equal(replaced.counts.pending, 1);
  assert.equal(replaced.updatedAt !== null, true);
  const disk = readLedgerFile(cwd);
  assert.equal(disk.rev, 1);
  assert.equal(disk.items.length, 2);

  const stale = await tool.execute({ items: [{ id: 'x1', title: 'x', status: 'done', evidence: ['e:1'] }], rev: 0 }, { agent });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  assert.equal(stale.currentRev, 1);
  assert.equal(readLedgerFile(cwd).rev, 1, 'stale 拒绝不得覆盖');

  const invalid = await tool.execute({ items: [{ id: 'bad-1', title: '缺 next', status: 'doing' }] }, { agent });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid-item');
  assert.ok(Array.isArray(invalid.errors) && invalid.errors.length > 0);
  assert.equal(readLedgerFile(cwd).rev, 1, '校验失败不得落盘');
});

test('relay_work_items：队友只能 patch 自己 owner 的项；整表替换 lead-only；非 Team subagent 只读也被拒', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'own-a', title: '队友分支', status: 'doing', owner: 'worker-1', next: '改文件' },
    { id: 'lead-a', title: 'Lead 分支', status: 'doing', owner: 'lead', next: '评审' },
  ], { rev: 4 });
  const lead = { session: fakeSession({ id: 'session-wi-lead2', cwd, seq: 0 }), options: {} };
  const teammate = { session: fakeSession({ id: 'session-wi-w1', cwd, seq: 0, header: { cwd, origin: 'subagent' } }), options: {} };
  const plainSub = { session: fakeSession({ id: 'session-wi-sub', cwd, seq: 0, header: { cwd, origin: 'subagent' } }), options: {} };
  const teams = {
    tryMembership: (caller) => (caller === teammate ? { role: 'teammate', name: 'worker-1' } : caller === lead ? { role: 'lead', name: 'lead' } : undefined),
    listMembers: () => [],
  };
  const { tools } = applyAgent(fakeServices({ session: lead.session, extra: { agentTeams: teams } }).services);
  const tool = tools.get('relay_work_items');

  const read = await tool.execute({}, { agent: teammate });
  assert.equal(read.ok, true);
  assert.equal(read.items.length, 2, '队友读全量');
  const patched = await tool.execute({ updates: [{ id: 'own-a', status: 'done', evidence: ['lib/a.js:1'] }] }, { agent: teammate });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.equal(patched.mode, 'patch');
  assert.equal(patched.counts.done, 1);
  assert.equal(patched.rev, 5);
  assert.equal(readLedgerFile(cwd).rev, 5);
  const scoped = await tool.execute({ updates: [{ id: 'lead-a', status: 'done' }] }, { agent: teammate });
  assert.equal(scoped.ok, false);
  assert.equal(scoped.code, 'teammate-scope');
  const replace = await tool.execute({ items: [{ id: 'x1', title: 'x', status: 'done', evidence: ['e:1'] }] }, { agent: teammate });
  assert.equal(replace.ok, false);
  assert.equal(replace.code, 'lead-only', '队友不能整表替换');
  const subRead = await tool.execute({}, { agent: plainSub });
  assert.equal(subRead.ok, false);
  assert.equal(subRead.code, 'lead-only', '非 Team subagent 连读都不行');
  const noop = await tool.execute({ updates: [] }, { agent: teammate });
  assert.equal(noop.code, 'invalid-item');
});

test('relay_work_items：workItems=false 时结构化拒绝且不读写（work-items-disabled）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-off', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services, { workItems: false });
  const result = await tools.get('relay_work_items').execute({}, { agent: { session, options: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'work-items-disabled');
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay', 'work-items.json')), false);
});

// ── relay_status ──────────────────────────────────────────────────────

test('relay_status：台账存在附 workItems 摘要 + text 末行；空台账 text 与旧输出一致（无 work-items 行）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-status', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const empty = await tools.get('relay_status').execute({}, { agent });
  assert.equal(empty.workItems.exists, false);
  assert.equal(empty.workItems.counts.total, 0);
  assert.equal(empty.workItems.path, WORK_ITEMS_REL);
  assert.equal(empty.workItems.corrupt, false);
  assert.ok(!empty.text.includes('work-items:'), '空台账 text 不新增行');

  writeLedger(cwd, [
    { id: 'api-export', title: '导出 API', status: 'doing', next: '写 handler' },
    { id: 'blocked-1', title: '等外部接口', status: 'blocked', blocked: '对方未给 schema' },
    { id: 'done-1', title: '已完成', status: 'done', evidence: ['a:1'] },
  ], { rev: 7 });
  const report = await tools.get('relay_status').execute({}, { agent });
  assert.equal(report.workItems.exists, true);
  assert.equal(report.workItems.rev, 7);
  assert.equal(report.workItems.counts.total, 3);
  assert.equal(report.workItems.counts.pending, 2);
  assert.equal(report.workItems.corrupt, false);
  assert.match(report.text, /work-items: 未闭合 2 \/ 共 3 \(doing 1 · blocked 1 · open 0 · done 1\) · rev 7/);

  // 损坏文件：fail-open 视为空台账 + corrupt=true（文件被隔离备份），不抛、不阻断状态读取。
  writeFileSync(join(cwd, WORK_ITEMS_REL), '{ not json');
  const corrupt = await tools.get('relay_status').execute({}, { agent });
  assert.equal(corrupt.workItems.exists, false);
  assert.equal(corrupt.workItems.corrupt, true);
  assert.ok(readdirSync(join(cwd, '.scratch', 'context-relay')).some((name) => name.startsWith('work-items.json.corrupt-')), '损坏文件已备份');
});

// ── relay_organize ────────────────────────────────────────────────────

test('relay_organize：brief 写盘追加「未闭合工作项」段；空台账不追加（旧行为不变）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'api-export', title: '导出 API', status: 'doing', next: '写 handler', phase: 'build' }], { rev: 3 });
  const session = fakeSession({ id: 'session-wi-org', cwd, seq: 0 });
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 100 }; } };
  const { tools } = applyAgent(fakeServices({ session, compaction }).services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: '完成设计', force: true }, { agent: { session, options: {}, inject() {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const briefText = readFileSync(result.briefPath, 'utf8');
  assert.match(briefText, /## 未闭合工作项/);
  assert.match(briefText, /\[api-export\] 导出 API/);
  assert.match(briefText, /台账：\.scratch\/context-relay\/work-items\.json · rev 3/);
  assert.ok(Buffer.byteLength(briefText, 'utf8') > 0);

  const emptyCwd = tmpCwd();
  const emptySession = fakeSession({ id: 'session-wi-org-empty', cwd: emptyCwd, seq: 0 });
  const emptyBundle = fakeServices({ session: emptySession, compaction });
  const emptyTools = applyAgent(emptyBundle.services).tools;
  const emptyResult = await emptyTools.get('relay_organize').execute({ phase: 'build', brief: '完成设计', force: true }, { agent: { session: emptySession, options: {}, inject() {} } });
  assert.equal(emptyResult.ok, true);
  const emptyBrief = readFileSync(emptyResult.briefPath, 'utf8');
  assert.ok(!emptyBrief.includes('## 未闭合工作项'), '空台账 brief 不新增段');
});

// ── relay_phase：ship 闸门 ────────────────────────────────────────────

test('relay_phase → ship：台账未闭合 strict 拒绝（user_gate 校验之后、零副作用）；done 无 evidence 拒绝；空台账放行', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'branch-a', title: '分支 A', status: 'doing', next: '写完' }], { rev: 1 });
  const session = fakeSession({ id: 'session-wi-ship', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  await call({ phase: 'build', contract_check: CONTRACT_CHECK });
  await call({ phase: 'verify', contract_check: CONTRACT_CHECK });

  updatePanelState(session.id, { autoDecision: null });
  await assert.rejects(
    call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE, next_operation: 'compress' }),
    /relay_phase refused \(work items\): .*work ledger is not closed/,
    '未闭合项拒绝 ship',
  );
  assert.equal(panelStateOf(session.id).autoDecision, null, '拒绝路径零副作用：未写面板自决策');
  const afterReject = await tools.get('relay_status').execute({}, { agent });
  assert.equal(afterReject.phase, 'verify', '拒绝后 phase 未切换');

  writeLedger(cwd, [{ id: 'branch-a', title: '分支 A', status: 'done' }], { rev: 2 });
  await assert.rejects(
    call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }),
    /relay_phase refused \(work items\): .*require evidence/,
    'done 项必须有 evidence',
  );

  writeLedger(cwd, [{ id: 'branch-a', title: '分支 A', status: 'done', evidence: ['lib/a.js:1'] }], { rev: 3 });
  const shipped = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  assert.equal(shipped.phase, 'ship');
  assert.equal(shipped.previous, 'verify');
  assert.equal(shipped.workItemsWarning, undefined, 'strict 通过不附 warning');

  // 空台账回归：无 work-items 文件时 ship 与旧行为完全一致（不因闸门受影响）。
  const emptyCwd = tmpCwd();
  const emptySession = fakeSession({ id: 'session-wi-ship-empty', cwd: emptyCwd, seq: 0 });
  const emptyTools = applyAgent(fakeServices({ session: emptySession }).services).tools;
  const emptyAgent = { session: emptySession, options: {} };
  const emptyCall = (args) => emptyTools.get('relay_phase').execute(args, { agent: emptyAgent });
  await emptyCall({ phase: 'build', contract_check: CONTRACT_CHECK });
  await emptyCall({ phase: 'verify', contract_check: CONTRACT_CHECK });
  const emptyShipped = await emptyCall({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
  assert.equal(emptyShipped.phase, 'ship');
  assert.equal(emptyShipped.workItemsWarning, undefined);
});

test('relay_phase → ship：workItemsGate=warn 只附 workItemsWarning 不拒绝；off 完全放行', async () => {
  resetSharedState();
  for (const [gate, expectWarn] of [['warn', true], ['off', false]]) {
    const cwd = tmpCwd();
    writeLedger(cwd, [{ id: 'branch-a', title: '分支 A', status: 'doing', next: '写完' }], { rev: 1 });
    const session = fakeSession({ id: 'session-wi-ship-' + gate, cwd, seq: 0 });
    const { tools } = applyAgent(fakeServices({ session }).services, { workItemsGate: gate });
    const agent = { session, options: {} };
    const call = (args) => tools.get('relay_phase').execute(args, { agent });
    await call({ phase: 'build', contract_check: CONTRACT_CHECK });
    await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
    const shipped = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
    assert.equal(shipped.phase, 'ship', gate + ': 不拒绝');
    if (expectWarn) assert.match(shipped.workItemsWarning, /not done\/blocked|evidence/);
    else assert.equal(shipped.workItemsWarning, undefined, 'off 不附 warning');
  }
});

test('relay_phase 跨 phase：ledger 带上一 phase 未闭合 id（leftover 非空才加）；同 phase/空台账不加字段', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'b1', title: '阶段遗留', status: 'doing', next: 'x', phase: 'build' },
    { id: 'b2', title: '阶段完成', status: 'done', evidence: ['a:1'], phase: 'build' },
    { id: 'b3', title: '阶段阻塞', status: 'blocked', blocked: '等接口', phase: 'build' },
    { id: 'c1', title: '其他阶段', status: 'doing', next: 'y', phase: 'verify' },
  ], { rev: 1 });
  const session = fakeSession({ id: 'session-wi-leftover', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  const toBuild = await call({ phase: 'build', contract_check: CONTRACT_CHECK });
  assert.equal(toBuild.ledger, undefined, '上一 phase(discover) 无遗留 → 不加 ledger');
  const toVerify = await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  assert.deepEqual(toVerify.ledger.leftover, ['b1', 'b3'], '未闭合=未 done（含 blocked），含 phase=上一 phase 的项');
  assert.equal(toVerify.ledger.counts.total, 4);
  assert.equal(toVerify.summary.includes('ledger'), false, 'ledger 只加字段，不改 summary');

  const same = await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  assert.equal(same.ledger, undefined, '同 phase 非 crossing 不加 ledger');

  const emptyCwd = tmpCwd();
  const emptySession = fakeSession({ id: 'session-wi-leftover-empty', cwd: emptyCwd, seq: 0 });
  const emptyTools = applyAgent(fakeServices({ session: emptySession }).services).tools;
  const emptyAgent = { session: emptySession, options: {} };
  await emptyTools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent: emptyAgent });
  const emptySwitched = await emptyTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: emptyAgent });
  assert.equal(emptySwitched.ledger, undefined, '空台账旧行为不变');
});

// ── relay_handoff ─────────────────────────────────────────────────────

test('relay_handoff：台账未闭合项进 next_actions（用户→台账→旧会话清单）、正文段、首条消息入口行、返回 workItems', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'api-export', title: '导出 API', status: 'doing', owner: 'worker-1', next: '写完 handler', phase: 'build' },
    { id: 'docs-1', title: '补文档', status: 'open', next: '写 README', phase: 'build' },
    { id: 'done-1', title: '已完成项', status: 'done', evidence: ['lib/x.js:1'] },
  ], { rev: 5 });
  const session = fakeSession({ id: 'session-wi-handoff', cwd, seq: 0 });
  const followed = [];
  const { tools } = applyAgent(handoffServices({ session, cwd, followed }).services);
  const result = await tools.get('relay_handoff').execute({
    status: { phase: 'build', goal: 'work ledger handoff', next_actions: ['用户下一步'] },
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.workItems.relativePath, WORK_ITEMS_REL);
  assert.equal(result.workItems.rev, 5);
  assert.equal(result.workItems.counts.total, 3);
  assert.deepEqual(result.workItems.omitted, [], '未闭合 2 条 ≤ next_actions 上限');
  assert.equal(result.workItemsWarning, undefined);
  const file = readFileSync(result.handoffPath, 'utf8');
  assert.match(file, /## 工作台账/);
  assert.match(file, /\[api-export\] 导出 API/);
  assert.match(file, /\[docs-1\] 补文档/);
  assert.ok(Buffer.byteLength(file, 'utf8') <= 8192);
  assert.equal(followed.length, 1);
  const text = followed[0].content[0].text;
  assert.match(text, /## 接手入口/);
  assert.match(text, /工作台账：\.scratch\/context-relay\/work-items\.json（未闭合 2 \/ 共 3；前 2 条：/);
  const userIdx = text.indexOf('下一步（DoD）：用户下一步');
  const ledgerIdx = text.indexOf('下一步（DoD）：[api-export]');
  const inventoryIdx = text.indexOf('下一步（DoD）：旧会话残留');
  assert.ok(userIdx >= 0 && ledgerIdx > userIdx, '台账项排在用户条目之后');
  assert.ok(inventoryIdx > ledgerIdx, '台账项排在旧会话残留清单之前');
});

test('relay_handoff：空台账 = 旧行为不变（无台账段/入口行/返回字段）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-handoff-empty', cwd, seq: 0 });
  const followed = [];
  const { tools } = applyAgent(handoffServices({ session, cwd, followed }).services);
  const result = await tools.get('relay_handoff').execute({
    status: { phase: 'build', goal: 'empty ledger handoff', next_actions: ['用户下一步'] },
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.workItems, undefined);
  assert.equal(result.workItemsWarning, undefined);
  const file = readFileSync(result.handoffPath, 'utf8');
  assert.ok(!file.includes('## 工作台账'));
  const text = followed[0].content[0].text;
  assert.ok(!text.includes('工作台账：'), '空台账首条消息无入口行');
  const userIdx = text.indexOf('下一步（DoD）：用户下一步');
  const inventoryIdx = text.indexOf('下一步（DoD）：旧会话残留');
  assert.ok(userIdx >= 0 && inventoryIdx > userIdx, '旧行为：用户条目在前、清单在后');
});

test('relay_handoff：台账段追加后文件仍 ≤8KB——超出截断并写明，不静默', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const longTitle = (index) => ('T' + index + '-').padEnd(120, 'x');
  const longNext = (index) => ('N' + index + '-').padEnd(160, 'y');
  writeLedger(cwd, Array.from({ length: 10 }, (_, index) => ({
    id: 'wi-' + String(index).padStart(2, '0'), title: longTitle(index), status: 'doing', next: longNext(index), owner: 'w' + index,
  })), { rev: 9 });
  const session = fakeSession({ id: 'session-wi-handoff-big', cwd, seq: 0 });
  const followed = [];
  const { tools } = applyAgent(handoffServices({ session, cwd, followed }).services);
  const result = await tools.get('relay_handoff').execute({
    status: {
      phase: 'build',
      goal: '8kb cap handoff',
      done: Array.from({ length: 12 }, (_, index) => ('done-' + index + '-').padEnd(200, 'd')),
    },
    evidence: Array.from({ length: 11 }, (_, index) => ('ev-' + index + '-').padEnd(200, 'e')).concat([('doc_lint: ' + 'L'.repeat(170)).slice(0, 200)]),
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const file = readFileSync(result.handoffPath, 'utf8');
  const bytes = Buffer.byteLength(file, 'utf8');
  assert.ok(bytes <= 8192, '追加台账段后 handoff 文件 ≤8KB，实际 ' + bytes);
  assert.match(file, /\[工作台账段因 8KB 上限截断\]/, '超限必须有明确截断说明，不静默');
  assert.match(file, /## 工作台账/, '台账段头部尽量保留');
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit);
  assert.equal(followed.length, 1);
});

test('relay_handoff：workItems=false 完全回退旧行为（台账文件存在也不读/不追加）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'api-export', title: '导出 API', status: 'doing', next: '写完 handler' }]);
  const session = fakeSession({ id: 'session-wi-handoff-off', cwd, seq: 0 });
  const followed = [];
  const { tools } = applyAgent(handoffServices({ session, cwd, followed }).services, { workItems: false });
  const result = await tools.get('relay_handoff').execute({
    status: { phase: 'build', goal: 'disabled ledger handoff', next_actions: ['用户下一步'] },
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.workItems, undefined);
  assert.ok(!readFileSync(result.handoffPath, 'utf8').includes('## 工作台账'));
  assert.ok(!followed[0].content[0].text.includes('工作台账：'));
});

test('relay_handoff：台账损坏 fail-open（不拒绝交接）+ workItemsWarning + summary 提示 + 隔离备份', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'x1', title: 'x', status: 'doing', next: 'y' }]);
  writeFileSync(join(cwd, WORK_ITEMS_REL), '{ broken json');
  const session = fakeSession({ id: 'session-wi-handoff-corrupt', cwd, seq: 0 });
  const followed = [];
  const { tools } = applyAgent(handoffServices({ session, cwd, followed }).services);
  const result = await tools.get('relay_handoff').execute({
    status: { phase: 'build', goal: 'corrupt ledger handoff', next_actions: ['用户下一步'] },
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.workItemsWarning, /损坏/);
  assert.match(result.summary, /工作台账文件损坏/);
  assert.equal(result.workItems, undefined, '损坏按空台账，不返回 workItems');
  assert.ok(readdirSync(join(cwd, '.scratch', 'context-relay')).some((name) => name.startsWith('work-items.json.corrupt-')), '损坏文件已隔离备份');
  assert.ok(!readFileSync(result.handoffPath, 'utf8').includes('## 工作台账'));
});

// ── 到线提醒 ──────────────────────────────────────────────────────────

test('sentinelText：台账非空 pending>0 时正文末尾追加台账行（Lead/队友都加）；空/未传不加', () => {
  const state = { band: 'organize' };
  const ledger = { exists: true, counts: { total: 5, pending: 2, doing: 1, blocked: 1, open: 0, done: 3 } };
  const leadText = sentinelText('build', state, false, undefined, undefined, false, ledger);
  assert.match(leadText, /\n工作台账：未闭合 2 \/ 共 5（relay_work_items 查看，交接前先更新）$/);
  const subText = sentinelText('build', state, true, undefined, { sent: true }, false, ledger);
  assert.match(subText, /工作台账：未闭合 2 \/ 共 5/);
  const empty = { exists: false, counts: { total: 0, pending: 0 } };
  assert.ok(!sentinelText('build', state, false, undefined, undefined, false, empty).includes('工作台账'));
  assert.ok(!sentinelText('build', state, false, undefined, undefined, false, undefined).includes('工作台账'));
  const doneLedger = { exists: true, counts: { total: 3, pending: 0, done: 3 } };
  assert.ok(!sentinelText('build', state, false, undefined, undefined, false, doneLedger).includes('工作台账'));
});

test('到线提醒接入：台账非空时注入的 notice 带台账行；空台账 notice 与旧版一致', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'api-export', title: '导出 API', status: 'doing', next: '写完 handler' }]);
  const session = fakeSession({ id: 'session-wi-reminder', cwd, seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { events } = applyAgent(bundle.services);
  const listener = events.find((entry) => entry.name === 'agent/pre-step')?.listener;
  assert.ok(listener !== undefined, 'pre-step 监听已注册');
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  await listener({ agent }, async () => ({}));
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /工作台账：未闭合 1 \/ 共 1/);

  const emptyCwd = tmpCwd();
  const emptySession = fakeSession({ id: 'session-wi-reminder-empty', cwd: emptyCwd, seq: 0 });
  const emptyBundle = fakeServices({ session: emptySession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const emptyEvents = applyAgent(emptyBundle.services).events;
  const emptyListener = emptyEvents.find((entry) => entry.name === 'agent/pre-step')?.listener;
  const emptyInjected = [];
  await emptyListener({ agent: { session: emptySession, options: {}, inject(message) { emptyInjected.push(message); } } }, async () => ({}));
  assert.equal(emptyInjected.length, 1);
  assert.ok(!emptyInjected[0].content[0].text.includes('工作台账'), '空台账到线提醒不新增行');

  // workItems=false：即使台账文件存在也不读（完全回退旧行为）。
  const offCwd = tmpCwd();
  writeLedger(offCwd, [{ id: 'api-export', title: '导出 API', status: 'doing', next: '写完 handler' }]);
  const offSession = fakeSession({ id: 'session-wi-reminder-off', cwd: offCwd, seq: 0 });
  const offBundle = fakeServices({ session: offSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const offEvents = applyAgent(offBundle.services, { workItems: false }).events;
  const offInjected = [];
  await offEvents.find((entry) => entry.name === 'agent/pre-step')?.listener({ agent: { session: offSession, options: {}, inject(message) { offInjected.push(message); } } }, async () => ({}));
  assert.equal(offInjected.length, 1);
  assert.ok(!offInjected[0].content[0].text.includes('工作台账'), 'workItems=false 到线提醒不读台账');
});

// ── team-tools：checkpoint 摘要 / renew owner 迁移 ──────────────────────

function fakeTeamCtx(services = {}) {
  const tools = new Map();
  const listeners = [];
  const warns = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn(...args) { warns.push(args.join(' ')); } },
    systemPrompt: { section() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, listeners, warns };
}

function makeTeamAgent({ sessionId, cwd }) {
  const injected = [];
  return {
    session: {
      id: sessionId,
      header: { cwd },
      seq: 0,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
      snapshotEvents: () => [],
    },
    inject(message) { injected.push(message); },
    injected,
  };
}

function teamMembership(role, name, root) {
  return { role, name, root };
}

function makeTeamService({ members = [], memberships = new Map(), spawnResult } = {}) {
  const calls = { spawn: [], send: [], interrupt: [] };
  return {
    calls,
    tryMembership(agent) { return memberships.get(agent); },
    listMembers() { return members; },
    async spawnTeammate(caller, request) {
      calls.spawn.push(request);
      return spawnResult === undefined
        ? { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } }
        : spawnResult(request);
    },
    async sendMessage(caller, request) { calls.send.push(request); return { messageId: 'm1' }; },
    interrupt(caller, name) { calls.interrupt.push(name); return { previousStatus: 'running' }; },
  };
}

const TEAM_LEAD = 'session-team-lead';
const workItemsConfig = { enabled: true, gate: 'strict', max: 30, pathOverride: undefined };

test('relay_checkpoint：返回体带自己 owner 的未闭合台账摘要（无则 null）；workItems=false 不读', async () => {
  resetSharedState();
  const dir = tmpCwd();
  writeLedger(dir, [
    { id: 'own-a', title: '自己分支', status: 'doing', owner: 'impl-g1', next: '继续改' },
    { id: 'own-b', title: '自己阻塞项', status: 'blocked', owner: 'impl-g1', blocked: '等接口' },
    { id: 'own-done', title: '自己完成项', status: 'done', owner: 'impl-g1', evidence: ['a:1'] },
    { id: 'other-a', title: '别人分支', status: 'doing', owner: 'impl-g2', next: 'x' },
  ]);
  const lead = makeTeamAgent({ sessionId: TEAM_LEAD, cwd: dir });
  const teammate = makeTeamAgent({ sessionId: 'session-impl-1', cwd: dir });
  const teams = makeTeamService({ memberships: new Map([[teammate, teamMembership('teammate', 'impl-g1', lead)]]) });
  const bundle = fakeTeamCtx({ agentTeams: teams });
  const { teammateTools } = createTeamTools({ ctx: bundle.ctx, currentThresholds: () => thresholds, workItems: workItemsConfig });
  const checkpoint = teammateTools.find((tool) => tool.name === 'relay_checkpoint');
  const result = await checkpoint.execute({ one_line: '完成登录修复' }, { agent: teammate });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.workItems), 'checkpoint 返回 workItems 摘要数组');
  assert.equal(result.workItems.length, 2, '只含自己 owner 的未闭合项（doing+blocked，done 排除）');
  assert.match(result.workItems[0], /own-/);
  assert.ok(result.workItems.every((line) => !line.includes('other-a')));

  const noLedgerDir = tmpCwd();
  const noLedgerAgent = makeTeamAgent({ sessionId: 'session-impl-2', cwd: noLedgerDir });
  const noLedgerTeams = makeTeamService({ memberships: new Map([[noLedgerAgent, teamMembership('teammate', 'impl-g1', lead)]]) });
  const noLedgerBundle = fakeTeamCtx({ agentTeams: noLedgerTeams });
  const noLedgerTools = createTeamTools({ ctx: noLedgerBundle.ctx, currentThresholds: () => thresholds, workItems: workItemsConfig }).teammateTools;
  const noLedgerResult = await noLedgerTools.find((tool) => tool.name === 'relay_checkpoint').execute({ one_line: '无台账' }, { agent: noLedgerAgent });
  assert.equal(noLedgerResult.ok, true);
  assert.equal(noLedgerResult.workItems, null, '无自己的未闭合项 → null');

  const offDir = tmpCwd();
  writeLedger(offDir, [{ id: 'own-a', title: '自己分支', status: 'doing', owner: 'impl-g1', next: '继续改' }]);
  const offAgent = makeTeamAgent({ sessionId: 'session-impl-3', cwd: offDir });
  const offTeams = makeTeamService({ memberships: new Map([[offAgent, teamMembership('teammate', 'impl-g1', lead)]]) });
  const offBundle = fakeTeamCtx({ agentTeams: offTeams });
  const offTools = createTeamTools({ ctx: offBundle.ctx, currentThresholds: () => thresholds, workItems: { enabled: false, gate: 'strict', max: 30, pathOverride: undefined } }).teammateTools;
  const offResult = await offTools.find((tool) => tool.name === 'relay_checkpoint').execute({ one_line: '禁用台账' }, { agent: offAgent });
  assert.equal(offResult.ok, true);
  assert.equal(offResult.workItems, null, 'workItems=false 不读台账');
});

test('relay_renew：换代成功后 owner 从旧代名迁移到新代名（workItemsMigrated）；失败不阻断', async () => {
  resetSharedState();
  const dir = tmpCwd();
  writeLedger(dir, [
    { id: 'own-a', title: '自己分支', status: 'doing', owner: 'impl-g1', next: '继续改' },
    { id: 'other-a', title: '别人分支', status: 'doing', owner: 'reviewer', next: 'x' },
  ]);
  const lead = makeTeamAgent({ sessionId: TEAM_LEAD, cwd: dir });
  const teammate = makeTeamAgent({ sessionId: 'session-impl-1', cwd: dir });
  const teams = makeTeamService({
    members: [
      { id: TEAM_LEAD, name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-impl-1', name: 'impl-g1', role: 'teammate', status: 'inactive', description: '实现' },
    ],
    memberships: new Map([[lead, teamMembership('lead', 'lead', lead)]]),
  });
  const bundle = fakeTeamCtx({ agentTeams: teams });
  // 先写 checkpoint（renew 前置条件）
  const writeTeams = makeTeamService({ memberships: new Map([[teammate, teamMembership('teammate', 'impl-g1', lead)]]) });
  const writeBundle = fakeTeamCtx({ agentTeams: writeTeams });
  const writeTools = createTeamTools({ ctx: writeBundle.ctx, currentThresholds: () => thresholds, workItems: workItemsConfig }).teammateTools;
  const checkpoint = await writeTools.find((tool) => tool.name === 'relay_checkpoint').execute({ one_line: '登录修复完成' }, { agent: teammate });
  assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
  // 换代
  const leadTools = createTeamTools({ ctx: bundle.ctx, currentThresholds: () => thresholds, workItems: workItemsConfig }).leadTools;
  const renew = leadTools.find((tool) => tool.name === 'relay_renew');
  const result = await renew.execute({ name: 'impl-g1' }, { agent: lead });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.next.name, 'impl-g2');
  assert.equal(result.workItemsMigrated, 1, '1 条 owner 迁移');
  const ledgerAfter = readLedgerFile(dir);
  const own = ledgerAfter.items.find((item) => item.id === 'own-a');
  assert.equal(own.owner, 'impl-g2', '同 lineage 新代名接手');
  const other = ledgerAfter.items.find((item) => item.id === 'other-a');
  assert.equal(other.owner, 'reviewer', '非旧代名 owner 不迁移');
});

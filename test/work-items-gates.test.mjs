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
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { confirmKeyOf } from '../lib/risk.js';
import { readTeamContext } from '../lib/agent/team-context.js';
import { emptyRoster, ensureLineage, writeRoster } from '../lib/agent/team.js';
import { subagentsFromLegacy } from './team-fixture.mjs';

const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';
const CONTRACT_CHECK = { requirement: '需求已定：工作台账闸门接入；边界：只改 T2 写范围', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };
const SHIP_GATE = { review: 'fresh subagent 独立审查：需求已定、实现忠实，无偏移/劣化/偷懒/缺失', report: '大白话汇报：需求 → 实现 + 证据 → 无偏差、边界已说明' };
/** C9 设计门：首次进 build 必须带用户确认过的设计文档指针（AUDIT §12）。 */
const DESIGN_GATE = { path: '.scratch/context-relay/architecture/complete-form-2026-11-16.md', user_approved: true, ask_ref: '用户确认：按这份设计推进', not_doing: ['不发布 npm', '不改本机配置'] };
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
  const provided = overrides.services ?? {};
  const fixture = provided.agentTeams !== undefined && provided.subagents === undefined ? subagentsFromLegacy(provided.agentTeams) : undefined;
  const services = fixture === undefined ? provided : { ...provided, subagents: fixture, agents: provided.agents ?? fixture.agentsService };
  const normalized = services;
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
    get(name) { return normalized[name]; },
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
  // 既有夹具统一用旧 workspace 级路径（显式 workItemsPath 覆盖）——会话级默认路径由本文件新增用例单独覆盖。
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL, ...config });
  return bundle;
}

/** 会话级默认路径装配（不注入 workItemsPath 覆盖）。 */
function applyAgentScoped(services, config = {}) {
  const bundle = fakeCtx({ services });
  apply(bundle.ctx, config);
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

/** 最小 handoff 夹具（新会话 + 首条消息捕获；与 agent.test.mjs 的 handoff 成功夹具同口径）。 */
function handoffServices({ session, cwd, followed }) {
  const childId = 'session-new';
  const liveSession = { id: childId, header: { cwd }, requestHeader: () => undefined };
  return fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: childId }; } },
      // Official followup accepts the identified message into nextTurn before returning.
      agents: { list: () => [{ session: liveSession, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup(message) { followed.push(message); this.inbox.nextTurn.push(message); } }] },
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
      { id: 'schema', title: '定 schema', status: 'done', evidence: ['docs/schema.md:1'], lead_confirm: { no_drift: true, no_missing: true, no_regression: true } },
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

  const stale = await tool.execute({ items: [{ id: 'x1', title: 'x', status: 'done', evidence: ['e:1'] }], drop: ['api-export', 'schema'], rev: 0 }, { agent });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  assert.equal(stale.currentRev, 1);
  assert.equal(readLedgerFile(cwd).rev, 1, 'stale 拒绝不得覆盖');

  const invalid = await tool.execute({ items: [{ id: 'bad-1', title: '缺 next', status: 'doing' }], drop: ['api-export', 'schema'] }, { agent });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid-item');
  assert.ok(Array.isArray(invalid.errors) && invalid.errors.length > 0);
  assert.equal(readLedgerFile(cwd).rev, 1, '校验失败不得落盘');
});

test('relay_work_items：整表替换不得静默删除未完成条目；done 移除自动归档（显式 drop 的 done 也归档）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'keep-1', title: '保留', status: 'doing', next: '继续' },
    { id: 'drop-1', title: '待作废', status: 'blocked', blocked: '方案取消' },
    { id: 'done-1', title: '已完成', status: 'done', evidence: ['e:1'] },
  ], { rev: 3 });
  const session = fakeSession({ id: 'session-wi-drop', cwd, seq: 0 });
  const tool = applyAgent(fakeServices({ session }).services).tools.get('relay_work_items');
  const agent = { session, options: {} };
  const items = [{ id: 'keep-1', title: '保留', status: 'doing', next: '继续' }];
  const silent = await tool.execute({ items, rev: 3 }, { agent });
  assert.equal(silent.ok, false);
  assert.equal(silent.code, 'phase-not-closed');
  assert.deepEqual(silent.ids, ['drop-1'], '未完成条目必须显式 drop；done 项允许移除（自动归档）');
  assert.equal(readLedgerFile(cwd).rev, 3, '拒绝不落盘');
  const badDrop = await tool.execute({ items, drop: ['nope'], rev: 3 }, { agent });
  assert.equal(badDrop.code, 'invalid-drop');
  const dropped = await tool.execute({ items, drop: ['drop-1'], rev: 3 }, { agent });
  assert.equal(dropped.ok, true, JSON.stringify(dropped));
  assert.equal(dropped.counts.total, 1);
  // v0.9.0 #39（D4=A）：被移除的 done-1 自动归档（reason=removed-done），返回体给 archived + archive 概要。
  assert.deepEqual(dropped.archived, { count: 1, path: '.scratch/context-relay/work-items-archive.ndjson' });
  assert.equal(dropped.archive.count, 1);
  const records = readFileSync(join(cwd, '.scratch/context-relay/work-items-archive.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, 'removed-done');
  assert.equal(records[0].item.id, 'done-1');
  assert.equal(records[0].rev, 3);
  const both = await tool.execute({ items, drop: ['keep-1'], rev: dropped.rev }, { agent });
  assert.equal(both.code, 'invalid-drop');
  // 显式 drop done → 归档 reason=dropped。
  writeLedger(cwd, [
    { id: 'keep-1', title: '保留', status: 'doing', next: '继续' },
    { id: 'done-2', title: '完成2', status: 'done', evidence: ['e:2'] },
  ], { rev: 5 });
  const droppedDone = await tool.execute({ items, drop: ['done-2'], rev: 5 }, { agent });
  assert.equal(droppedDone.ok, true, JSON.stringify(droppedDone));
  assert.equal(droppedDone.archived.count, 1);
  const more = readFileSync(join(cwd, '.scratch/context-relay/work-items-archive.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(more.length, 2);
  assert.equal(more[1].reason, 'dropped');
  assert.equal(more[1].item.id, 'done-2');
});

test('relay_work_items：officialTaskId 透传/继承；archive 返回与 over-cap/archive-failed 路径', async () => {
  resetSharedState();
  // officialTaskId：整表替换透传 + 已知条目未提供时保留旧值。
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-official', cwd, seq: 0 });
  const tool = applyAgent(fakeServices({ session }).services).tools.get('relay_work_items');
  const agent = { session, options: {} };
  const first = await tool.execute({ items: [{ id: 'task-a', title: 'A', status: 'open', officialTaskId: 'task-42' }] }, { agent });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.items[0].officialTaskId, 'task-42');
  assert.equal(first.archive.count, 0, '无归档时 archive.count=0');
  assert.equal(first.archive.path, '.scratch/context-relay/work-items-archive.ndjson');
  const second = await tool.execute({ items: [{ id: 'task-a', title: 'A2', status: 'open' }], rev: first.rev }, { agent });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.items[0].officialTaskId, 'task-42', '未提供 officialTaskId 时 known 继承旧值');
  const invalid = await tool.execute({ items: [{ id: 'task-a', title: 'A2', status: 'open' }, { id: 'task-b', title: 'B', status: 'open', officialTaskId: 'bad id' }], rev: second.rev }, { agent });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid-item');
  assert.equal(invalid.errors[0].code, 'invalid-official-task-id');
  // over-cap：replace 31 条（含 done）→ 自动归档最旧 done，write 成功并返回 archived。
  const overCwd = tmpCwd();
  const overSession = fakeSession({ id: 'session-wi-overcap', cwd: overCwd, seq: 0 });
  const overTool = applyAgent(fakeServices({ session: overSession }).services).tools.get('relay_work_items');
  const overAgent = { session: overSession, options: {} };
  const done = { id: 'done-old', title: '完成', status: 'done', evidence: ['e:1'], lead_confirm: { no_drift: true, no_missing: true, no_regression: true } };
  const opens = Array.from({ length: 29 }, (_, index) => ({ id: 'open-' + index, title: 'O' + index, status: 'open' }));
  const base = await overTool.execute({ items: [done, ...opens] }, { agent: overAgent });
  assert.equal(base.ok, true, JSON.stringify(base));
  const overflow = await overTool.execute({ items: [...base.items, { id: 'open-new', title: 'N', status: 'open' }], rev: base.rev }, { agent: overAgent });
  assert.equal(overflow.ok, true, JSON.stringify(overflow));
  assert.equal(overflow.counts.total, 30);
  assert.deepEqual(overflow.archived, { count: 1, path: '.scratch/context-relay/work-items-archive.ndjson' });
  assert.equal(overflow.archive.count, 1);
  assert.equal(readFileSync(join(overCwd, '.scratch/context-relay/work-items-archive.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))[0].reason, 'over-cap');
  // archive-failed：归档目标被目录占用 → 拒绝整次写入，台账不变。
  const failCwd = tmpCwd();
  const failSession = fakeSession({ id: 'session-wi-archive-fail', cwd: failCwd, seq: 0 });
  const failTool = applyAgent(fakeServices({ session: failSession }).services).tools.get('relay_work_items');
  const failAgent = { session: failSession, options: {} };
  const seeded = await failTool.execute({ items: [{ id: 'keep', title: 'K', status: 'open' }, { id: 'done-a', title: 'D', status: 'done', evidence: ['e:1'], lead_confirm: { no_drift: true, no_missing: true, no_regression: true } }] }, { agent: failAgent });
  assert.equal(seeded.ok, true);
  mkdirSync(join(failCwd, '.scratch/context-relay/work-items-archive.ndjson'), { recursive: true });
  const refused = await failTool.execute({ items: [{ id: 'keep', title: 'K', status: 'open' }], rev: seeded.rev }, { agent: failAgent });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'archive-failed');
  assert.equal(readLedgerFile(failCwd).items.length, 2, '归档失败台账不变');
});

test('P3-4 归档顺序（整表替换）：stale-rev/validate 失败不留孤儿归档；成功才归档 removed-done', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const archiveFile = join(cwd, '.scratch/context-relay/work-items-archive.ndjson');
  writeLedger(cwd, [
    { id: 'keep-1', title: '保留', status: 'doing', next: '继续' },
    { id: 'done-old', title: '已完成', status: 'done', evidence: ['e:1'] },
  ], { rev: 3 });
  const session = fakeSession({ id: 'session-wi-archive-order', cwd, seq: 0 });
  const tool = applyAgent(fakeServices({ session }).services).tools.get('relay_work_items');
  const agent = { session, options: {} };
  // stale rev：移除 done-old 本会归档——但 rev 校验失败必须零副作用（不得先 append）。
  const items = [{ id: 'keep-1', title: '保留', status: 'doing', next: '继续' }];
  const stale = await tool.execute({ items, rev: 2 }, { agent });
  assert.equal(stale.code, 'stale-revision');
  assert.equal(existsSync(archiveFile), false, 'stale 拒绝不得先归档');
  assert.equal(readLedgerFile(cwd).rev, 3, 'stale 拒绝不落盘');
  // validate 失败：保留 keep-1、新条目 doing 缺 next → 整次拒绝，归档不新增。
  const invalid = await tool.execute({ items: [...items, { id: 'bad-1', title: '缺 next', status: 'doing' }], rev: 3 }, { agent });
  assert.equal(invalid.code, 'invalid-item');
  assert.equal(existsSync(archiveFile), false, 'validate 失败不得先归档');
  assert.equal(readLedgerFile(cwd).rev, 3, '校验失败不落盘');
  // 成功路径：removed-done 归档照旧（校验通过后才 append）。
  const replaced = await tool.execute({ items, rev: 3 }, { agent });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual(replaced.archived, { count: 1, path: '.scratch/context-relay/work-items-archive.ndjson' });
  assert.equal(JSON.parse(readFileSync(archiveFile, 'utf8').trim()).reason, 'removed-done');
});

test('relay_phase：carry 无效 id 显式报告；items 非字符串拒绝', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'b1', title: '遗留', status: 'doing', next: 'x', phase: 'build' },
    { id: 'b2', title: '完成', status: 'done', evidence: ['e:1'], phase: 'build' },
  ], { rev: 1, currentPhase: { phase: 'build', goal: 'g', since: 1, openedAtRev: 1 } });
  const session = fakeSession({ id: 'session-wi-carry-ignored', cwd, seq: 0 });
  const tool = applyAgent(fakeServices({ session }).services).tools.get('relay_phase');
  const agent = { session, options: {} };
  const ok = await tool.execute({ phase: 'verify', contract_check: CONTRACT_CHECK, carry: ['b1', 'b2', 'missing'] }, { agent });
  assert.equal(ok.ok ?? true, true);
  assert.deepEqual(ok.ledger.carried, ['b1']);
  assert.deepEqual(ok.ledger.carryIgnored, ['b2', 'missing'], '已 done/不存在 的 carry 显式报告，不静默');

  const plainCwd = tmpCwd();
  const plainSession = fakeSession({ id: 'session-wi-items-type', cwd: plainCwd, seq: 0 });
  const plainTool = applyAgent(fakeServices({ session: plainSession }).services).tools.get('relay_phase');
  await assert.rejects(
    () => plainTool.execute({ phase: 'build', contract_check: CONTRACT_CHECK, items: ['ok', 123] }, { agent: { session: plainSession, options: {} } }),
    /items 的每个元素必须是字符串/,
  );
});

test('relay_work_items：v0.7.0 起 Lead-only；队友/子代理读写一律拒绝', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'own-a', title: '队友分支', status: 'doing', owner: 'worker-1', next: '改文件' },
    { id: 'lead-a', title: 'Lead 分支', status: 'doing', owner: 'lead', next: '评审' },
  ], { rev: 4 });
  const lead = { session: fakeSession({ id: 'session-wi-lead2', cwd, seq: 0 }), options: {} };
  const teammate = { session: fakeSession({ id: 'session-wi-w1', cwd, seq: 0, header: { cwd, origin: 'subagent' } }), options: {} };
  const { tools } = applyAgent(fakeServices({ session: lead.session }).services);
  const tool = tools.get('relay_work_items');

  for (const agent of [teammate]) {
    const read = await tool.execute({}, { agent });
    assert.equal(read.ok, false, '队友不能读 Leader 台账');
    assert.equal(read.code, 'lead-only');
    const patch = await tool.execute({ updates: [{ id: 'own-a', status: 'done' }] }, { agent });
    assert.equal(patch.ok, false);
    assert.equal(patch.code, 'lead-only');
    const replace = await tool.execute({ items: [{ id: 'x1', title: 'x', status: 'done', evidence: ['e:1'] }] }, { agent });
    assert.equal(replace.ok, false);
    assert.equal(replace.code, 'lead-only');
  }
  const leadRead = await tool.execute({}, { agent: lead });
  assert.equal(leadRead.ok, true);
  assert.equal(leadRead.items.length, 2);
  const leadReplace = await tool.execute({ items: [{ id: 'x1', title: 'x', status: 'done', evidence: ['e:1'], lead_confirm: { no_drift: true, no_missing: true, no_regression: true } }], rev: 4, drop: ['own-a', 'lead-a'] }, { agent: lead });
  assert.equal(leadReplace.ok, true, JSON.stringify(leadReplace));
});

test('relay_work_items：完成确认门——新变 done 缺/不完整/含 false lead_confirm → done-gate 拒绝（零副作用）；三项 true 通过', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'p1', title: '进行中', status: 'doing', next: 'x' }], { rev: 1 });
  const session = fakeSession({ id: 'session-wi-done-gate', cwd, seq: 0 });
  const tool = applyAgent(fakeServices({ session }).services).tools.get('relay_work_items');
  const agent = { session, options: {} };
  const confirm = { no_drift: true, no_missing: true, no_regression: true };
  const doneItem = (lead_confirm) => [{ id: 'p1', title: '进行中', status: 'done', evidence: ['e:1'], ...(lead_confirm === undefined ? {} : { lead_confirm }) }];
  const revBefore = readLedgerFile(cwd).rev;
  const cases = [
    ['缺失', undefined],
    ['不完整', { no_drift: true, no_missing: true }],
    ['含 false', { no_drift: true, no_missing: true, no_regression: false }],
  ];
  for (const [label, leadConfirm] of cases) {
    const refused = await tool.execute({ items: doneItem(leadConfirm), rev: revBefore }, { agent });
    assert.equal(refused.ok, false, label);
    assert.equal(refused.code, 'done-gate', label);
    assert.equal(readLedgerFile(cwd).rev, revBefore, label + '：整表拒绝零副作用');
    assert.equal(readLedgerFile(cwd).items[0].status, 'doing', label + '：条目不置 done');
  }
  const passed = await tool.execute({ items: doneItem(confirm), rev: revBefore }, { agent });
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(passed.counts.done, 1);
  assert.deepEqual(readLedgerFile(cwd).items[0].lead_confirm, confirm, '三项 true 才置 done 并写入条目');
});

test('relay_work_items：auto 确认经工具契约消费（auto+confirmKey），同 id 内容变更后旧确认失效', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'auto-wi', title: '改 README', status: 'doing', next: '写说明', evidence: ['README.md:1'], phase: 'build' },
  ], { rev: 1, currentPhase: { phase: 'build', goal: 'g', since: 1, openedAtRev: 1, risk: { tier: 'T0', source: 'declared', reasons: ['docs'] } } });
  const session = fakeSession({ id: 'session-wi-auto-confirm', cwd, seq: 0 });
  const tool = applyAgent(fakeServices({ session }).services).tools.get('relay_work_items');
  const agent = { session, options: {} };
  // 输入 schema 必须允许复用形态（否则模型只能按 schema 传三项 true，永远进不了复用分支）。
  const schema = tool.parameters.properties.items.items.properties.lead_confirm;
  assert.deepEqual(schema.properties.auto.enum, ['T0', 'T1']);
  assert.ok(schema.properties.confirmKey && schema.properties.diffHash, 'schema 列出 confirmKey/diffHash');
  assert.ok(JSON.stringify(schema.anyOf ?? []).includes('confirmKey'), 'schema 允许 auto+confirmKey 复用形态');
  const item = { id: 'auto-wi', title: '改 README', status: 'done', evidence: ['README.md:1'] };
  const first = await tool.execute({ rev: 1, items: [item] }, { agent });
  assert.equal(first.ok, true, JSON.stringify(first));
  const saved = readLedgerFile(cwd).items[0].lead_confirm;
  assert.equal(saved.auto, 'T0');
  assert.match(saved.confirmKey, /^[0-9a-f]{16}$/);
  assert.match(saved.diffHash, /^[0-9a-f]{16}$/);
  assert.equal(saved.confirmKey, confirmKeyOf({ itemId: 'auto-wi', rev: 1, diffHash: saved.diffHash }), 'diffHash 真进了 confirmKeyOf（key 绑内容指纹）');
  // 重复请求只回传 auto+confirmKey+diffHash（不带三项布尔）→ 走工具 execute 复用盘上确认。
  const replay = await tool.execute({
    rev: readLedgerFile(cwd).rev,
    items: [{ ...item, lead_confirm: { auto: saved.auto, confirmKey: saved.confirmKey, diffHash: saved.diffHash } }],
  }, { agent });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(readLedgerFile(cwd).items[0].lead_confirm.confirmKey, saved.confirmKey, '复用盘上三项 true');
  // 同 id 改内容后重放旧 key → done-gate 整表拒绝（零副作用）。
  const rev = readLedgerFile(cwd).rev;
  const changed = { ...item, title: '改 README v2', evidence: ['README.md:2'] };
  const refused = await tool.execute({
    rev,
    items: [{ ...changed, lead_confirm: { auto: saved.auto, confirmKey: saved.confirmKey, diffHash: saved.diffHash } }],
  }, { agent });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'done-gate');
  assert.equal(readLedgerFile(cwd).rev, rev, '拒绝零副作用');
  // 不带显式确认重写同 id 新内容：旧确认不保留。
  const plain = await tool.execute({ rev, items: [changed] }, { agent });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(readLedgerFile(cwd).items[0].lead_confirm, null, '内容变更后旧确认失效');
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
  // v0.5.1：面板授权事实进 relay_status（模型唯一可靠的面板视图）+ 台账新鲜度后缀。
  assert.equal(report.panel.defaultOperation, null);
  assert.equal(report.panel.autoCompress, false);
  assert.match(report.text, /panel: 模式=问我 · autoCompress=off · autoHandoff=off · authorizeNext=off/);
  assert.doesNotMatch(report.text, /autoChoose|autoDecision/, 'C10：退役面板字段不得出现在 text');
  assert.doesNotMatch(report.text, /更新于 \d+ 分钟前/, 'v0.6.0：不再用时间判定台账新鲜度');
  // v0.6.0：currentPhase 进 workItems 摘要与 text（phase 行 + 焦点行）
  writeFileSync(join(cwd, WORK_ITEMS_REL), JSON.stringify({
    version: 1, rev: 8, updatedAt: '2026-11-13T00:00:00.000Z', updatedBy: 'test',
    currentPhase: { phase: 'build', goal: 'g', since: 1, openedAtRev: 7 },
    items: [{ id: 'p1', title: '分点一', status: 'doing', next: '推进', phase: 'build' }],
  }, null, 2));
  const phased = await tools.get('relay_status').execute({}, { agent });
  assert.equal(phased.workItems.phase.phase, 'build');
  assert.match(phased.text, /phase: phase build · 分点 0\/1/);
  assert.match(phased.text, /\[台账·build 0\/1\] doing「分点一」next「推进」/);

  // 损坏文件：fail-open 视为空台账 + corrupt=true（文件被隔离备份），不抛、不阻断状态读取。
  writeFileSync(join(cwd, WORK_ITEMS_REL), '{ not json');
  const corrupt = await tools.get('relay_status').execute({}, { agent });
  assert.equal(corrupt.workItems.exists, false);
  assert.equal(corrupt.workItems.corrupt, true);
  assert.ok(readdirSync(join(cwd, '.scratch', 'context-relay')).some((name) => name.startsWith('work-items.json.corrupt-')), '损坏文件已备份');
});

// ── 会话级台账（v0.5.1：跟会话走） ───────────────────────────────────

test('会话级台账：同 cwd 两个会话互不串账；队友不碰 Lead 台账（v0.7.0 Lead-only）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const leadA = fakeSession({ id: 'session-scope-a', cwd, seq: 0 });
  const leadB = fakeSession({ id: 'session-scope-b', cwd, seq: 0 });
  const bundleA = applyAgentScoped(fakeServices({ session: leadA }).services);
  const bundleB = applyAgentScoped(fakeServices({ session: leadB }).services);
  const agentA = { session: leadA, options: {} };
  const agentB = { session: leadB, options: {} };
  const callA = (args) => bundleA.tools.get('relay_work_items').execute(args, { agent: agentA });
  const callB = (args) => bundleB.tools.get('relay_work_items').execute(args, { agent: agentB });

  const wrote = await callA({ items: [{ id: 'a1', title: 'A 分支', status: 'open', owner: 'mate-1', next: '开工' }] });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.match(wrote.relativePath, /^.scratch\/context-relay\/work-items\/session-scope-a\.json$/);
  assert.equal((await callA({})).exists, true);
  assert.equal((await callB({})).exists, false, '另一个会话读不到本会话台账');

  // v0.7.0：台账是 Leader 自己的项目管理队列；队友不读也不写。
  const mate = fakeSession({ id: 'session-scope-a-mate', cwd, header: { cwd, origin: 'subagent', parentSession: 'session-scope-a' }, seq: 0 });
  const mateBundle = applyAgentScoped(fakeServices({ session: mate }).services);
  const mateAgent = { session: mate, options: {} };
  const mateRead = await mateBundle.tools.get('relay_work_items').execute({}, { agent: mateAgent });
  assert.equal(mateRead.ok, false, '队友不能读 Leader 台账');
  assert.equal(mateRead.code, 'lead-only');
});

test('会话级台账：旧 workspace 级文件在首次读取时按 updatedBy 迁移到本会话（不偷别人的）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-scope-migrate', cwd, seq: 0 });
  mkdirSync(join(cwd, '.scratch', 'context-relay'), { recursive: true });
  writeFileSync(join(cwd, WORK_ITEMS_REL), JSON.stringify({
    version: 1,
    rev: 4,
    updatedAt: new Date().toISOString(),
    updatedBy: session.id,
    items: [{ id: 'm1', title: 'M', status: 'doing', next: '继续' }],
  }));
  const { tools } = applyAgentScoped(fakeServices({ session }).services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.workItems.exists, true, '旧台账已迁移');
  assert.match(report.workItems.path, /work-items\/session-scope-migrate\.json$/);
  assert.equal(readWorkItems(cwd, { scopeId: session.id }).items[0].id, 'm1');
  // 另一个会话读不到这份台账（迁移只在 updatedBy 匹配时发生）
  assert.equal(readWorkItems(cwd, { scopeId: 'session-scope-other' }).exists, false);
});

test('relay_handoff：会话级台账复制到新会话（rev 保留），交接单/入口行/返回体指向新路径', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-scope-handoff', cwd, seq: 0 });
  const seeded = await writeWorkItems(cwd, { items: [{ id: 'h1', title: 'H', status: 'doing', next: '交接中' }], scopeId: session.id });
  assert.equal(seeded.ok, true);
  const followed = [];
  const { tools } = applyAgentScoped(handoffServices({ session, cwd, followed }).services);
  const result = await tools.get('relay_handoff').execute({
    status: { phase: 'build', goal: '会话级台账交接', next_actions: ['用户下一步'] },
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.workItems.relativePath, '.scratch/context-relay/work-items/session-new.json', '返回体指向新会话台账');
  assert.equal(result.workItems.rev, seeded.ledger.rev, '复制保留 rev');
  const childLedger = readWorkItems(cwd, { scopeId: 'session-new' });
  assert.equal(childLedger.exists, true);
  assert.equal(childLedger.items[0].id, 'h1');
  const text = followed[0].content[0].text;
  assert.match(text, /工作台账：\.scratch\/context-relay\/work-items\/session-new\.json/);
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

test('relay_organize：默认（无 workItemsPath 覆盖）读会话级台账，旧 workspace 级文件不串入 brief', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sessionId = 'session-wi-org-scope';
  // 旧 workspace 级台账（另一会话/旧版本遗留）：不得被本次 brief 读到。
  writeLedger(cwd, [{ id: 'stale', title: '陈旧条目', status: 'open' }], { rev: 2 });
  // 本会话级台账：organize brief 应只带它。
  const scopedPath = join(cwd, '.scratch/context-relay/work-items', sessionId + '.json');
  mkdirSync(dirname(scopedPath), { recursive: true });
  writeFileSync(scopedPath, JSON.stringify({
    version: 1, rev: 5, updatedAt: '2026-11-15T00:00:00.000Z', updatedBy: 'test',
    items: [{ id: 'api-export', title: '导出 API', status: 'doing', next: '写 handler', phase: 'build' }],
  }, null, 2));
  const session = fakeSession({ id: sessionId, cwd, seq: 0 });
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 100 }; } };
  const { tools } = applyAgentScoped(fakeServices({ session, compaction }).services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: '完成设计', force: true }, { agent: { session, options: {}, inject() {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const briefText = readFileSync(result.briefPath, 'utf8');
  assert.match(briefText, /## 未闭合工作项/);
  assert.match(briefText, /\[api-export\] 导出 API/);
  assert.match(briefText, /work-items\/session-wi-org-scope\.json · rev 5/);
  assert.ok(!briefText.includes('陈旧条目'), '不得读 workspace 级旧台账');
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
  await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  await call({ phase: 'verify', contract_check: CONTRACT_CHECK });

  updatePanelState(session.id, { autoDecision: null });
  await assert.rejects(
    call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE, next_operation: 'compress' }),
    (error) => /工作台账还没收口/.test(error.message) && /work ledger is not closed/.test(error.message),
    '未闭合项拒绝 ship',
  );
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), 'autoDecision'), false, '拒绝路径零副作用：不写退役自决字段');
  const afterReject = await tools.get('relay_status').execute({}, { agent });
  assert.equal(afterReject.phase, 'verify', '拒绝后 phase 未切换');

  writeLedger(cwd, [{ id: 'branch-a', title: '分支 A', status: 'done' }], { rev: 2 });
  await assert.rejects(
    call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }),
    (error) => /工作台账还没收口/.test(error.message) && /require evidence/.test(error.message),
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
  await emptyCall({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
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
    await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
    await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
    const shipped = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE });
    assert.equal(shipped.phase, 'ship', gate + ': 不拒绝');
    if (expectWarn) assert.match(shipped.workItemsWarning, /not done\/blocked|evidence/);
    else assert.equal(shipped.workItemsWarning, undefined, 'off 不附 warning');
  }
});

test('relay_phase → ship：user_gate.report 四段式/字数只 warning 不阻断（D1=B）；空 review/report 仍拒', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-user-gate', cwd, seq: 0 });
  const injected = [];
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  const badReport = '这次改动很多，具体命令输出如下：\n$ npm test\n全部通过，应该没问题。';
  const shipped = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'fresh subagent 独立审查：无偏移', report: badReport } });
  assert.equal(shipped.phase, 'ship', '格式不合规不阻断 ship');
  assert.equal(shipped.previous, 'verify');
  assert.equal(shipped.user_gate.review, 'done');
  assert.ok(shipped.user_gate.reportChars > 0);
  assert.ok(Array.isArray(shipped.user_gate.warnings) && shipped.user_gate.warnings.length > 0, '缺段/内部细节 → warning');
  assert.ok(shipped.user_gate.warnings.some((warning) => warning.code === 'report-format'));
  assert.ok(shipped.user_gate.warnings.some((warning) => warning.code === 'report-internal-details'));
  assert.equal('report' in shipped.user_gate, false, '不落 report 原文');
  assert.equal(injected.length, 1, '一次性 notice 提示 warning（不阻断）');
  assert.match(injected[0].source.summary, /用户汇报 warning/);
  assert.match(injected[0].content[0].text, /不阻断/);
  assert.equal((await tools.get('relay_status').execute({}, { agent })).phase, 'ship', 'phase 已正常切换');

  // 空 review / 空 report 仍是用户门硬门（不得放宽）。
  const gateCwd = tmpCwd();
  const gateSession = fakeSession({ id: 'session-wi-user-gate-hard', cwd: gateCwd, seq: 0 });
  const gateTools = applyAgent(fakeServices({ session: gateSession }).services).tools;
  const gateAgent = { session: gateSession, options: {} };
  const gateCall = (args) => gateTools.get('relay_phase').execute(args, { agent: gateAgent });
  await gateCall({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  await gateCall({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await assert.rejects(gateCall({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: '  ', report: 'x' } }), /验收汇报/);
  await assert.rejects(gateCall({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'fresh review', report: '' } }), /验收汇报/);
  assert.equal((await gateTools.get('relay_status').execute({}, { agent: gateAgent })).phase, 'verify', '硬门拒绝不切 phase');
});

test('relay_phase → ship：details_requested 仅放宽细节展开提示（不是硬拒豁免）', async () => {
  resetSharedState();
  const report = '结论：完成\n影响：无\n需要你做什么：无需\n证据位置：test/work-items-gates.test.mjs\n';
  const detailed = report + '细节：' + 'x'.repeat(700) + '\n```\n$ npm test\n```';
  const run = async (userGate) => {
    const cwd = tmpCwd();
    const session = fakeSession({ id: 'session-wi-details-' + Math.random().toString(36).slice(2), cwd, seq: 0 });
    const tools = applyAgent(fakeServices({ session }).services).tools;
    const injected = [];
    const agent = { session, options: {}, inject(message) { injected.push(message); } };
    const call = (args) => tools.get('relay_phase').execute(args, { agent });
    await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
    await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
    const result = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'fresh review', report: detailed, ...userGate } });
    return { result, injected };
  };
  const normalRun = await run({});
  const normal = normalRun.result;
  assert.equal(normal.phase, 'ship');
  assert.ok(normal.user_gate.warnings.some((warning) => warning.code === 'report-internal-details'), '默认档：代码块/长细节提示');
  assert.equal(normal.user_gate.detailsRequested, undefined, '默认档不回 detailsRequested');
  assert.equal(normal.user_gate.info, undefined, '默认档不回 info');
  const authorizedRun = await run({ details_requested: true });
  const authorized = authorizedRun.result;
  assert.equal(authorized.phase, 'ship', 'details_requested 不改变结果');
  assert.ok(!(authorized.user_gate.warnings ?? []).some((warning) => warning.code === 'report-internal-details'), '用户已授权展开：不再提示内部细节');
  assert.ok(!(authorized.user_gate.warnings ?? []).some((warning) => warning.code === 'report-too-long'), '700 字在展开档（≤4000）内不提示超长');
  // P2-1 修复：details_requested 与 info 提示透传到结果 + 同一（去重）notice（不阻断、不落原文）。
  assert.equal(authorized.user_gate.detailsRequested, true, 'details_requested 透传结果');
  assert.match(String(authorized.user_gate.info ?? ''), /用户已授权展开/, 'info 提示透传结果');
  assert.equal('report' in authorized.user_gate, false, '不落 report 原文');
  assert.equal(authorizedRun.injected.length, 1, 'details_requested 附一次提示 notice');
  assert.match(authorizedRun.injected[0].content[0].text, /用户已授权展开细节/);
  assert.doesNotMatch(authorizedRun.injected[0].content[0].text, /x{50}/, 'notice 不落报告原文');
});

test('relay_phase 跨 phase：strict 拒绝未收口；carry 显式带走；items 开分点并落 currentPhase', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [
    { id: 'b1', title: '阶段遗留', status: 'doing', next: 'x', phase: 'build' },
    { id: 'b2', title: '阶段完成', status: 'done', evidence: ['a:1'], phase: 'build' },
    { id: 'b3', title: '阶段阻塞', status: 'blocked', blocked: '等接口', phase: 'build' },
    { id: 'c1', title: '其他阶段', status: 'doing', next: 'y', phase: 'verify' },
  ], { rev: 1 });
  const session = fakeSession({ id: 'session-wi-leftover', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services, { workItemsPhaseGate: 'strict' });
  const agent = { session, options: {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  // discover→build：discover 无未闭合 → 放行；items 开分点（中文标题回退 point）
  const toBuild = await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK, items: ['实现闸门'] });
  assert.equal(toBuild.ledger.phase, 'build');
  assert.deepEqual(toBuild.ledger.opened, ['point']);
  assert.equal(toBuild.ledger.planned, 4, 'build 既有 3 条 + 新分点');
  assert.equal(readLedgerFile(cwd).currentPhase.phase, 'build');
  // build→verify：b1/b3/point 未收口 → strict 拒绝，零副作用（currentPhase 不变）
  await assert.rejects(() => call({ phase: 'verify', contract_check: CONTRACT_CHECK }), /工作台账还没收口/);
  assert.equal(readLedgerFile(cwd).currentPhase.phase, 'build');
  // 显式 carry → 放行；条目 phase 改到 verify 并记 carriedFrom
  const toVerify = await call({ phase: 'verify', contract_check: CONTRACT_CHECK, carry: ['b1', 'b3', 'point'], items: ['验收'] });
  assert.deepEqual(toVerify.ledger.carried, ['b1', 'b3', 'point']);
  assert.deepEqual(toVerify.ledger.leftover, undefined, '全部收口/carry → 无 leftover');
  const file = readLedgerFile(cwd);
  assert.equal(file.currentPhase.phase, 'verify');
  assert.equal(file.items.find((item) => item.id === 'b1').phase, 'verify');
  assert.equal(file.items.find((item) => item.id === 'b1').carriedFrom, 'build');
  assert.equal(toVerify.summary.includes('ledger'), false, 'ledger 只加字段，不改 summary');

  const same = await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  assert.equal(same.ledger, undefined, '同 phase 非 crossing 不加 ledger');

  const emptyCwd = tmpCwd();
  const emptySession = fakeSession({ id: 'session-wi-leftover-empty', cwd: emptyCwd, seq: 0 });
  const emptyTools = applyAgent(fakeServices({ session: emptySession }).services).tools;
  const emptyAgent = { session: emptySession, options: {} };
  await emptyTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: emptyAgent });
  const emptySwitched = await emptyTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: emptyAgent });
  // fix-p2：空台账单线程也把 design_gate.path 落成 pin（否则下次 index/交接就丢）；
  // 因此不再有「还没有工作台账」提示，改为「本 phase 没有分点」提示。
  assert.match(emptySwitched.ledger.hint, /没有分点/);
  assert.deepEqual(readLedgerFile(emptyCwd).currentPhase.pins, [DESIGN_GATE.path], '空台账也持久化 pin');
});

test('relay_phase：phase=null 未收口条目不能绕过 strict 关 phase 闸（C7/A-03 复现）；carry 可带走', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'n1', title: '无 phase 未收口', status: 'doing', next: 'x' }], {
    rev: 1, currentPhase: { phase: 'build', goal: 'g', since: 1, openedAtRev: 1 },
  });
  const session = fakeSession({ id: 'session-wi-null-gate', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services, { workItemsPhaseGate: 'strict' });
  const agent = { session, options: {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  await assert.rejects(call({ phase: 'verify', contract_check: CONTRACT_CHECK }), /工作台账还没收口/, 'phase=null 条目纳入 strict 关闸');
  assert.equal(readLedgerFile(cwd).currentPhase.phase, 'build', '拒绝零副作用（currentPhase 不变）');
  const carried = await call({ phase: 'verify', contract_check: CONTRACT_CHECK, carry: ['n1'] });
  assert.equal(carried.phase, 'verify');
  assert.deepEqual(carried.ledger.carried, ['n1'], '显式 carry 可带走无 phase 条目');
  assert.equal(readLedgerFile(cwd).items.find((item) => item.id === 'n1').phase, 'verify', 'carry 后条目落到新 phase（不静默丢下）');
});

test('relay_phase：items 只在主链跨 phase 登记（C7/A-02）——同 phase/出口/出口恢复显式拒绝且零副作用', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-same-items', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK, items: ['首个分点'] });
  const before = readLedgerFile(cwd);
  // 同 phase 带 items：显式拒绝（旧版静默丢弃 → 模型以为已登记）；错误给 relay_work_items 指路。
  await assert.rejects(
    call({ phase: 'build', contract_check: CONTRACT_CHECK, items: ['迟到分点'] }),
    (error) => /分点登记/.test(error.message) && /本次 phase 未切换/.test(error.message) && /relay_work_items/.test(error.message),
    '同 phase items 必须显式拒绝',
  );
  assert.deepEqual(readLedgerFile(cwd), before, '同 phase items 拒绝：台账零副作用');
  await assert.rejects(call({ phase: 'build', items: [] }), /分点登记/, '同 phase 空 items 也显式拒绝');
  // 出口不登记分点。
  await assert.rejects(call({ phase: 'blocked', exit_reason: '等用户', contract_check: CONTRACT_CHECK, items: ['x'] }), /出口不登记分点/);
  assert.deepEqual(readLedgerFile(cwd), before, '出口 items 拒绝：台账零副作用');
  await call({ phase: 'blocked', exit_reason: '等用户', contract_check: CONTRACT_CHECK });
  // 从出口恢复也不登记分点（恢复的子 phase 语义不写台账）。
  await assert.rejects(call({ phase: 'verify', contract_check: CONTRACT_CHECK, items: ['y'] }), /恢复不登记分点/);
  // 回归：合法主链 crossing 仍正常登记分点（台账照旧写入）。
  const resumed = await call({ phase: 'build', contract_check: CONTRACT_CHECK });
  assert.equal(resumed.phase, 'build');
  const crossed = await call({ phase: 'verify', contract_check: CONTRACT_CHECK, items: ['验收分点'] });
  assert.equal(crossed.ledger.phase, 'verify');
  assert.equal(crossed.ledger.opened.length, 1, '主链 crossing 的 items 仍登记');
  assert.equal(readLedgerFile(cwd).currentPhase.phase, 'verify');
});

// ── 台账闭环（v0.6.0 事件驱动） ────────────────────────────────────────

test('台账闭环：焦点行事件驱动注入；变更未落账 → 闭环提示；落账后焦点更新、不重复', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const phaseMeta = { phase: 'build', goal: 'g', since: 1, openedAtRev: 2 };
  writeLedger(cwd, [
    { id: 'p1', title: '实现闸门', status: 'doing', next: '写测试', phase: 'build' },
    { id: 'p2', title: '补文档', status: 'open', phase: 'build' },
  ], { rev: 2, currentPhase: phaseMeta });
  const session = fakeSession({ id: 'session-ledger-guard', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services);
  // 单一模式（v0.9.0）下 team-tools 也注册 pre-step，sentinel 在最后注册：取最后一个 pre-step 才是到线哨兵。
  const listener = bundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const post = bundle.events.find((event) => event.name === 'tools/post-execute').listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);

  await step();
  assert.equal(injected.length, 1, 'focus line injected once');
  assert.match(injected[0].content[0].text, /\[台账·build 0\/2\] doing「实现闸门」next「写测试」/);
  await step();
  assert.equal(injected.length, 1, 'same focus is not re-injected');

  // 变更类工具成功 → 待落账 → 下一步注入闭环提示
  await post({ name: 'write', agent, arguments: { file_path: 'lib/x.js' } }, { isError: false }, async () => undefined);
  await step();
  assert.equal(injected.length, 2);
  assert.match(injected[1].content[0].text, /\[闭环\] 上一步改动未落账：write\(x\.js\)/);
  await step();
  assert.equal(injected.length, 2, 'closure prompt is not repeated per step');

  // relay_work_items 写入成功（items 整表替换）= 已落账：清 pending；只读调用不再清（B-04）
  await post({ name: 'relay_work_items', agent, arguments: { items: [] } }, { isError: false }, async () => undefined);
  writeLedger(cwd, [
    { id: 'p1', title: '实现闸门', status: 'done', evidence: ['test/x'], phase: 'build' },
    { id: 'p2', title: '补文档', status: 'open', phase: 'build' },
  ], { rev: 3, currentPhase: phaseMeta });
  await step();
  assert.equal(injected.length, 3);
  assert.match(injected[2].content[0].text, /\[台账·build 1\/2\]/);
  assert.match(injected[2].content[0].text, /未领取：open「补文档」/);
});

test('台账闭环：未落账签名去重（同签名不重复；count 不变内容变 → 重提示；落账清空后同签名再提示）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const phaseMeta = { phase: 'build', goal: 'g', since: 1, openedAtRev: 2 };
  writeLedger(cwd, [{ id: 'p1', title: '实现闸门', status: 'doing', next: '写测试', phase: 'build' }], { rev: 2, currentPhase: phaseMeta });
  const session = fakeSession({ id: 'session-ledger-sig', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services);
  const listener = bundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const post = bundle.events.find((event) => event.name === 'tools/post-execute').listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);
  const mutate = (path) => post({ name: 'write', agent, arguments: { file_path: path } }, { isError: false }, async () => undefined);

  await step(); // 首步：只有焦点行
  assert.equal(injected.length, 1);
  assert.doesNotMatch(injected[0].content[0].text, /\[闭环\]/);

  await mutate('a.js');
  await step();
  assert.equal(injected.length, 2);
  assert.equal(
    injected[1].content[0].text,
    '[闭环] 上一步改动未落账：write(a.js) —— 更新当前分点的 status/next/evidence（relay_work_items），或说明归到哪条分点；关 phase 前必须落账。\n这不是用户发言。不要复述本段；对用户请用三问重写。',
    'P1 内容等价：闭环行文本与旧 builder 逐字一致',
  );
  await step();
  assert.equal(injected.length, 2, '同签名不重复提示');

  // count 变化 → 重提示（b/c 两次改动同一步注入一次）
  await mutate('b.js');
  await mutate('c.js');
  await step();
  assert.equal(injected.length, 3, '签名变化提示一次');
  assert.match(injected[2].content[0].text, /write\(a\.js\) \/ write\(b\.js\) \/ write\(c\.js\)/);

  // count 封顶 3 后内容滚动（slice(-3)）→ 签名变化必然重提示一次（旧 count 键会漏）
  await mutate('d.js');
  await step();
  assert.equal(injected.length, 4, 'count 不变但内容变 → 重提示');
  assert.match(injected[3].content[0].text, /write\(b\.js\) \/ write\(c\.js\) \/ write\(d\.js\)/);
  assert.doesNotMatch(injected[3].content[0].text, /write\(a\.js\)/);
  await step();
  assert.equal(injected.length, 4, '同签名不再重复');

  // relay_work_items 写入成功（items 整表替换）= 已落账：清 pending → 再次同样改动 = 新事件，重新提示一次
  // （只读调用不清 pending 是 B-04 的修复点；旧断言把「查一眼台账」也当落账）
  await post({ name: 'relay_work_items', agent, arguments: { items: [] } }, { isError: false }, async () => undefined);
  await step();
  assert.equal(injected.length, 4, '落账清空本身不注入');
  await mutate('d.js');
  await step();
  assert.equal(injected.length, 5, '清空后同签名重新提示一次');
  assert.match(injected[4].content[0].text, /\[闭环\] 上一步改动未落账：write\(d\.js\)/);
});

test('relay_phase 跨 phase：有队伍时自动带队友 triage；队友待处理未写 team_note 只 warning（放行）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-team-triage', cwd, seq: 0 });
  const teams = {
    tryMembership: () => ({ role: 'lead', root: { session: { id: 'session-team-triage' } } }),
    listMembers: () => [
      { id: 'session-m1', name: 'mate-1', role: 'teammate', status: 'inactive' },
      { id: 'session-m2', name: 'mate-2', role: 'teammate', status: 'inactive' },
    ],
  };
  const sessionQuery = {
    async observeSession(memberId) {
      const projectedTokens = memberId === 'session-m1' ? 420000 : 20000; // 夹具阈值 40 → organize 档
      return { projections: { values: { contextPressure: { contextWindow: 1000000, projectedTokens } } }, [Symbol.dispose]() {} };
    },
  };
  // v0.11 P0-B：triage 只看 squad → 先把两名成员登记为当前小队。
  const roster = emptyRoster();
  for (const name of ['mate-1', 'mate-2']) ensureLineage(roster, name, { name, sessionId: 'session-' + name });
  await writeRoster(cwd, roster, 'session-team-triage');
  const bundle = applyAgent(fakeServices({ session, extra: { agentTeams: teams, sessionQuery } }).services);
  const phase = bundle.tools.get('relay_phase');
  const ctxFile = join(cwd, '.scratch/context-relay/team-context/session-team-triage.json');

  // 队友 mate-1 到 organize 且没写 team_note：v0.7.0 只 warning，不拒绝切 phase。
  const warned = await phase.execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } });
  assert.match(warned.teamWarning, /mate-1/, '队友上下文提醒降级为 warning');
  // fix-p2：空台账也落 pin（design_gate.path），不再以「不写台账」为不变量。
  assert.ok(existsSync(join(cwd, WORK_ITEMS_REL)), '空台账落 pin');
  assert.deepEqual(readLedgerFile(cwd).currentPhase.pins, [DESIGN_GATE.path], 'pin 跟随 design_gate');
  assert.ok(existsSync(ctxFile), 'triage 快照照常落盘');
  assert.deepEqual(warned.team.pending, ['mate-1']);

  // 写了处理结论后 triage 全量返回，handler 标记已处理（焦点行不再重复催）。
  const result = await phase.execute({ phase: 'verify', contract_check: CONTRACT_CHECK, team_note: 'mate-1 已 checkpoint，边界后 freshen(reset) 复用' }, { agent: { session, options: {} } });
  assert.equal(result.team.members.length, 2);
  assert.deepEqual(result.team.members.map((row) => row.name), ['mate-1', 'mate-2']);
  assert.equal(result.team.members[0].band, 'organize');
  assert.match(result.team.members[0].action, /relay_freshen\(\{reset:true/);
  assert.deepEqual(result.team.pending, ['mate-1']);
  assert.deepEqual(result.team.handled, ['mate-1']);
  assert.match(result.team.note, /freshen/);
  assert.match(result.team.hint, /不要轮询/);
  const snapshot = JSON.parse(readFileSync(ctxFile, 'utf8'));
  assert.deepEqual(snapshot.rows.map((row) => row.name), ['mate-1', 'mate-2']);
  assert.deepEqual(snapshot.handled, ['mate-1']);
  assert.equal(readTeamContext(cwd, 'session-team-triage').pending.length, 0, '已处理的不再是待处理');

  // 无队伍：不加 team 段（旧行为不变）
  const plainSession = fakeSession({ id: 'session-team-triage-plain', cwd, seq: 0 });
  const plain = applyAgent(fakeServices({ session: plainSession }).services);
  const plainResult = await plain.tools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session: plainSession, options: {} } });
  assert.equal(plainResult.team, undefined);
});

test('台账闭环：空台账/队友会话不注入（旧行为不变）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const lead = fakeSession({ id: 'session-ledger-guard-empty', cwd, seq: 0 });
  const leadBundle = applyAgent(fakeServices({ session: lead }).services);
  const leadListener = leadBundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const leadInjected = [];
  await leadListener({ agent: { session: lead, inject(message) { leadInjected.push(message); } } }, async () => undefined);
  assert.equal(leadInjected.length, 0, 'no ledger → no focus/closure noise');
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
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit, '注入摘要 ≤ advisory 预算');
  assert.ok(Buffer.byteLength(followed[0].content[0].text, 'utf8') <= result.caps.bytes.limit + 2048, '首条消息 = 摘要 + 指针 + 入口，总量有界');
  assert.equal(result.handoffFileBytes, Buffer.byteLength(file, 'utf8'), '完整文件字节记账');
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

test('relay_handoff：台账段完整追加（不截断）——摘要 ≤ advisory 预算，完整文件含全部台账/用户内容', async () => {
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
      goal: 'large handoff',
      done: Array.from({ length: 12 }, (_, index) => ('done-' + index + '-').padEnd(200, 'd')),
    },
    // 15 条 evidence（> 摘要 advisory 12 条）：摘要裁剪、完整版全收。
    evidence: Array.from({ length: 14 }, (_, index) => ('ev-' + index + '-').padEnd(200, 'e')).concat([('doc_lint: ' + 'L'.repeat(170)).slice(0, 200)]),
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(followed.length, 1);
  assert.ok(result.caps.split, '摘要与完整版不同（evidence > advisory 条数）');
  assert.ok(result.caps.warnings.length > 0, 'advisory 说明');
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit, '摘要 ≤ advisory 预算');
  assert.ok(Buffer.byteLength(followed[0].content[0].text, 'utf8') <= result.caps.bytes.limit + 2048, '首条消息总量有界');
  const file = readFileSync(result.handoffPath, 'utf8');
  assert.equal(result.handoffFileBytes, Buffer.byteLength(file, 'utf8'), '完整文件字节记账 = caps.fullBytes');
  assert.equal(result.caps.fullBytes, result.handoffFileBytes);
  assert.match(file, /## 工作台账/, '完整文件含台账段');
  assert.match(file, /\[wi-09\]/, '台账 10 条全部落盘');
  assert.match(file, /done-11-/, '用户 done 内容完整落盘');
  assert.ok(file.includes('ev-13-'), '超摘要上限的 evidence 也完整落盘');
  assert.ok(!file.includes('工作台账段因 8KB 上限截断'), '不再有台账截断说明');
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

test('sentinelText：台账非空 pending>0 时 Lead 正文末尾追加台账行；队友不加（M-12）；空/未传不加', () => {
  const state = { band: 'organize' };
  const ledger = { exists: true, counts: { total: 5, pending: 2, doing: 1, blocked: 1, open: 0, done: 3 } };
  const leadText = sentinelText('build', state, false, undefined, undefined, ledger);
  assert.match(leadText, /工作台账：未闭合 2 \/ 共 5（阶段边界前收口）/);
  assert.doesNotMatch(leadText, /band=/, '用户文案不带内部键');
  assert.doesNotMatch(leadText, /更新于 \d+ 分钟前|已停滞/, '不再按时间提示台账新鲜度');
  // M-12：depth-1 队友工具面没有 relay_work_items，显式传 ledger 也不渲染台账行（不再教用被裁工具/展示 Lead 计数）。
  const subText = sentinelText('build', state, true, undefined, { sent: true }, ledger);
  assert.doesNotMatch(subText, /工作台账/);
  const empty = { exists: false, counts: { total: 0, pending: 0 } };
  assert.ok(!sentinelText('build', state, false, undefined, undefined, empty).includes('工作台账'));
  assert.ok(!sentinelText('build', state, false, undefined, undefined, undefined).includes('工作台账'));
  const doneLedger = { exists: true, counts: { total: 3, pending: 0, done: 3 } };
  assert.ok(!sentinelText('build', state, false, undefined, undefined, doneLedger).includes('工作台账'));
});

test('到线提醒接入：台账非空时注入的 notice 带台账行；空台账 notice 与旧版一致', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'api-export', title: '导出 API', status: 'doing', next: '写完 handler' }]);
  const session = fakeSession({ id: 'session-wi-reminder', cwd, seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { events } = applyAgent(bundle.services);
  const listener = events.filter((entry) => entry.name === 'agent/pre-step').at(-1)?.listener;
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
  const emptyListener = emptyEvents.filter((entry) => entry.name === 'agent/pre-step').at(-1)?.listener;
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
  await offEvents.filter((entry) => entry.name === 'agent/pre-step').at(-1)?.listener({ agent: { session: offSession, options: {}, inject(message) { offInjected.push(message); } } }, async () => ({}));
  assert.equal(offInjected.length, 1);
  assert.ok(!offInjected[0].content[0].text.includes('工作台账'), 'workItems=false 到线提醒不读台账');
});

test('pre-step 台账只读：旧 workspace 台账不被惰性迁移写盘（C7/B-10 热路径无写副作用）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-wi-preread', cwd, seq: 0 });
  mkdirSync(join(cwd, '.scratch', 'context-relay'), { recursive: true });
  writeFileSync(join(cwd, WORK_ITEMS_REL), JSON.stringify({
    version: 1, rev: 2, updatedAt: new Date().toISOString(), updatedBy: session.id,
    items: [{ id: 'legacy-1', title: '旧台账', status: 'doing', next: 'n' }],
  }));
  // 不注入 workItemsPath（会话级默认路径）→ 默认读路径本会触发迁移。
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { events } = applyAgentScoped(bundle.services);
  const listener = events.filter((entry) => entry.name === 'agent/pre-step').at(-1)?.listener;
  assert.ok(listener !== undefined, 'pre-step 监听已注册');
  await listener({ agent: { session, options: {}, inject() {} } }, async () => ({}));
  const scopedPath = join(cwd, '.scratch', 'context-relay', 'work-items', session.id + '.json');
  assert.equal(existsSync(scopedPath), false, 'pre-step 只读：不得迁移写盘');
  assert.ok(existsSync(join(cwd, WORK_ITEMS_REL)), '旧 workspace 台账原样保留');
});

// ── team-tools：checkpoint 摘要 / renew owner 迁移 ──────────────────────

function fakeTeamCtx(services = {}) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
  const tools = new Map();
  const listeners = [];
  const warns = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn(...args) { warns.push(args.join(' ')); } },
    systemPrompt: { section() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return normalized[name]; },
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
const workItemsConfig = { enabled: true, gate: 'strict', max: 30, pathOverride: WORK_ITEMS_REL };

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

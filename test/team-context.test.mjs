/**
 * v0.6.3 团队上下文快照 + Lead/队友上下文防遗忘（事件驱动）：
 * 快照模块单测、relay_team_status 落快照与 pending、relay_phase 的 team_note 硬闸门（含快照兜底）、
 * 台账焦点行携带 band/队友待处理且只在变化时注入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import {
  TEAM_CONTEXT_DIR, clearTeamContextRow, mergeTeamContext, readTeamContext, replaceTeamContext, teamContextRelativePath, teamPendingText,
} from '../lib/agent/team-context.js';

const CONTRACT_CHECK = { requirement: '需求已定：上下文管理防遗忘', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户' };
const TEAM_CONTEXT_REL = TEAM_CONTEXT_DIR.join('/');
const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';
const thresholds = thresholdsFromPercent(35);

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-tc-'));
}

function resetSharedState() {
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-panel-')), 'panel.json') });
  clearSentinelMemory();
}

function fakeSession({ id = 'session-test', cwd, seq, header } = {}) {
  return {
    id,
    header: header ?? (cwd === undefined ? {} : { cwd }),
    get seq() { return seq ?? 0; },
    snapshotEvents() { return []; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function fakeServices({ session, pressure = { contextWindow: 1_000_000, projectedTokens: 20000 }, extra = {} } = {}) {
  const state = { pressure };
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens ?? 0 }) },
    agentTeams: { tryMembership: () => ({ role: 'lead', root: { session: { id: session.id } } }), listMembers: () => [] },
    sessionQuery: undefined,
    ...extra,
  };
  return { services, state };
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
    get(name) { return services?.[name]; },
  };
  return { ctx, tools, events };
}

function fakeTeamCtx(services = {}) {
  const tools = new Map();
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools };
}

function makeAgent({ sessionId, cwd }) {
  const injected = [];
  return {
    session: { id: sessionId, header: { cwd }, seq: 0, requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }), snapshotEvents: () => [] },
    inject(message) { injected.push(message); },
    injected,
  };
}

function writeLedger(cwd, items, { rev = 1, currentPhase } = {}) {
  const path = join(cwd, WORK_ITEMS_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rev, updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'test', ...(currentPhase === undefined ? {} : { currentPhase }), items }, null, 2));
  return path;
}

function applyAgent(services, config = {}) {
  const bundle = fakeCtx(services);
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL, ...config });
  return bundle;
}

// ── 快照模块 ───────────────────────────────────────────────────────────

test('team-context：无文件/非法 scope → exists=false；merge 保留其它队友、新 escalation 清 handled', () => {
  const cwd = tmpCwd();
  const empty = readTeamContext(cwd, 'session-lead-x');
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.pending, []);
  assert.equal(teamContextRelativePath('session-lead-x'), TEAM_CONTEXT_REL + '/session-lead-x.json');
  // 非法 scope id（路径穿越）：不读也不写
  assert.equal(readTeamContext(cwd, '../evil').exists, false);
  assert.equal(mergeTeamContext(cwd, '../evil', { name: 'a', band: 'organize' }).ok, false);

  mergeTeamContext(cwd, 'session-lead-x', { name: 'mate-a', band: 'organize' });
  mergeTeamContext(cwd, 'session-lead-x', { name: 'mate-b', band: 'ok' });
  let context = readTeamContext(cwd, 'session-lead-x');
  assert.deepEqual(context.rows.map((row) => row.name).sort(), ['mate-a', 'mate-b']);
  assert.deepEqual(context.pending.map((row) => row.name), ['mate-a'], 'warn/ok 不算待处理');

  replaceTeamContext(cwd, 'session-lead-x', { phase: 'build', rows: [{ name: 'mate-a', band: 'organize' }, { name: 'mate-b', band: 'relay' }], note: '已处理', handled: ['mate-a'] });
  context = readTeamContext(cwd, 'session-lead-x');
  assert.deepEqual(context.pending.map((row) => row.name), ['mate-b'], 'handled 的队友不再待处理');
  assert.deepEqual(context.handled, ['mate-a']);
  assert.equal(context.note, '已处理');
  assert.equal(context.phase, 'build');

  // 新 escalation = 新的待处理：清掉该名字的 handled
  mergeTeamContext(cwd, 'session-lead-x', { name: 'mate-a', band: 'relay' });
  context = readTeamContext(cwd, 'session-lead-x');
  assert.deepEqual(context.pending.map((row) => row.name).sort(), ['mate-a', 'mate-b']);

  // clear 只删该队友
  assert.equal(clearTeamContextRow(cwd, 'session-lead-x', 'mate-a').cleared, true);
  context = readTeamContext(cwd, 'session-lead-x');
  assert.deepEqual(context.rows.map((row) => row.name), ['mate-b']);
  assert.equal(clearTeamContextRow(cwd, 'session-lead-x', 'nobody').cleared, false);
});

test('team-context：损坏 JSON fail-open；teamPendingText 有界；未知 band 归 unknown', () => {
  const cwd = tmpCwd();
  const path = join(cwd, TEAM_CONTEXT_REL, 'session-lead-bad.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ broken json');
  const broken = readTeamContext(cwd, 'session-lead-bad');
  assert.equal(broken.exists, false);
  assert.deepEqual(broken.pending, []);

  replaceTeamContext(cwd, 'session-lead-big', {
    rows: [
      { name: 'a', band: 'organize' }, { name: 'b', band: 'relay' }, { name: 'c', band: 'weird' },
      { name: 'd', band: 'unknown' }, { name: 'e', band: 'organize' },
    ],
  });
  const context = readTeamContext(cwd, 'session-lead-big');
  assert.equal(context.pending.length, 5, 'organize/relay/unknown 都待处理');
  const text = teamPendingText(context, 3);
  assert.match(text, /队友待处理 5：a\(organize\)、b\(relay\)、c\(unknown\)/);
  assert.match(text, /等 5 人/);
  const stored = JSON.parse(readFileSync(join(cwd, TEAM_CONTEXT_REL, 'session-lead-big.json'), 'utf8'));
  assert.equal(stored.version, 1);
});

// ── relay_team_status：落快照 + pending ────────────────────────────────

test('relay_team_status：队友到线写团队上下文快照 + pending 提示；重复查询仍拒绝', async () => {
  resetSharedState();
  const dir = tmpCwd();
  const lead = makeAgent({ sessionId: 'session-tc-lead', cwd: dir });
  const members = [
    { id: 'session-tc-a', name: 'impl-a', role: 'teammate', status: 'inactive' },
    { id: 'session-tc-b', name: 'impl-b', role: 'teammate', status: 'inactive' },
  ];
  const teams = {
    tryMembership: () => ({ role: 'lead', name: 'lead', root: { session: { id: 'session-tc-lead' } } }),
    listMembers: () => members,
    async sendMessage() { return { messageId: 'm1' }; },
  };
  const sessionQuery = {
    async observeSession(memberId) {
      const projectedTokens = memberId === 'session-tc-a' ? 420000 : 20000;
      return { projections: { values: { contextPressure: { contextWindow: 1000000, projectedTokens } } }, [Symbol.dispose]() {} };
    },
  };
  const bundle = fakeTeamCtx({ agentTeams: teams, sessionQuery });
  const { leadTools } = createTeamTools({ ctx: bundle.ctx, currentThresholds: () => thresholds, workItems: { enabled: true, gate: 'strict', max: 30, pathOverride: WORK_ITEMS_REL } });
  const status = leadTools.find((tool) => tool.name === 'relay_team_status');
  const report = await status.execute({}, { agent: lead });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.pending, ['impl-a']);
  assert.match(report.text, /队友上下文待处理：impl-a/);
  const file = join(dir, TEAM_CONTEXT_REL, 'session-tc-lead.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(snapshot.rows.map((row) => row.name).sort(), ['impl-a', 'impl-b']);
  assert.deepEqual(readTeamContext(dir, 'session-tc-lead').pending.map((row) => row.name), ['impl-a']);
  const again = await status.execute({}, { agent: lead });
  assert.equal(again.ok, false, '状态没变的重复查询仍拒绝');
});

// ── relay_phase：team_note 硬闸门 + 快照兜底 ───────────────────────────

test('relay_phase 跨 phase：读不到 Agent Teams 时用快照兜底——队友待处理仍要 team_note', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-tc-fallback', cwd, seq: 0 });
  mergeTeamContext(cwd, 'session-tc-fallback', { name: 'mate-9', band: 'relay' });
  const bundle = applyAgent(fakeServices({ session }).services);
  const phase = bundle.tools.get('relay_phase');
  await assert.rejects(
    phase.execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } }),
    /team context.*mate-9.*team_note/s,
  );
  const ok = await phase.execute({ phase: 'build', contract_check: CONTRACT_CHECK, team_note: 'mate-9 已 checkpoint；phase 边界后 handoff 重建小队' }, { agent: { session, options: {} } });
  assert.equal(readTeamContext(cwd, 'session-tc-fallback').pending.length, 0);
  assert.equal(readTeamContext(cwd, 'session-tc-fallback').note, 'mate-9 已 checkpoint；phase 边界后 handoff 重建小队');
  assert.equal(ok.team, undefined, '无 Agent Teams 服务 → 不加 team 段');
});

// ── 台账焦点行：带上下文状态，只在变化时注入 ───────────────────────────

test('台账焦点行带上下文状态：band 过线 + 队友待处理只在变化时注入', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }], { rev: 1, currentPhase: { phase: 'build', since: 1 } });
  mergeTeamContext(cwd, 'session-ctx-line', { name: 'mate-1', band: 'organize' });
  const session = fakeSession({ id: 'session-ctx-line', cwd, seq: 0 });
  const { services, state } = fakeServices({ session });
  const { events } = applyAgent(services);
  const listener = events.find((entry) => entry.name === 'agent/pre-step').listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => ({}));

  await step(); // band=ok：焦点行 + 队友待处理
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /\[台账·build 0\/1\]/);
  assert.match(injected[0].content[0].text, /\[队友\] 队友待处理 1：mate-1\(organize\)/);
  assert.doesNotMatch(injected[0].content[0].text, /\[上下文\]/, 'ok 档不写 band 行');
  await step(); // 状态没变：不重复
  assert.equal(injected.length, 1);

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step(); // organize 升线：只发到线提醒（不重复上下文行）
  assert.equal(injected.length, 2);
  assert.match(injected[1].source.summary, /band=organize/);

  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }, { id: 'p2', title: '补文档', status: 'open', phase: 'build' }], { rev: 2, currentPhase: { phase: 'build', since: 1 } });
  await step(); // rev 变化：焦点行 + 上下文行（band/边界动作）
  assert.equal(injected.length, 3);
  assert.match(injected[2].content[0].text, /\[上下文\] band=organize（模式未设：先问人类/);
  assert.match(injected[2].content[0].text, /\[队友\] 队友待处理 1：mate-1\(organize\)/);

  assert.equal(clearTeamContextRow(cwd, 'session-ctx-line', 'mate-1').cleared, true);
  await step(); // 队友已处理：不再带队友行
  assert.equal(injected.length, 3);
  mergeTeamContext(cwd, 'session-ctx-line', { name: 'mate-1', band: 'relay' });
  await step(); // 新 escalation：再注入一次
  assert.equal(injected.length, 4);
  assert.match(injected[3].content[0].text, /mate-1\(relay\)/);
});

// ── 派活时评估队友上下文（用户口径：管理点在派活，不在等 phase 边界） ──

test('派活时评估队友上下文：send_message 到 organize 队友 → 下一步提示 + 快照待处理；ok 队友不提示、不重复催', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const leadSession = fakeSession({ id: 'session-dispatch-lead', cwd, seq: 0 });
  const teams = {
    tryMembership: (caller) => (caller?.session?.id === 'session-dispatch-lead'
      ? { role: 'lead', name: 'lead', root: { session: { id: 'session-dispatch-lead' } } }
      : undefined),
    listMembers: () => [
      { id: 'session-dm-1', name: 'mate-1', role: 'teammate', status: 'inactive' },
      { id: 'session-dm-2', name: 'mate-2', role: 'teammate', status: 'inactive' },
    ],
    async sendMessage() { return { messageId: 'm1' }; },
  };
  const sessionQuery = {
    async observeSession(memberId) {
      const projectedTokens = memberId === 'session-dm-1' ? 420000 : 20000; // 夹具阈值 40 → organize 档
      return { projections: { values: { contextPressure: { contextWindow: 1000000, projectedTokens } } }, [Symbol.dispose]() {} };
    },
  };
  const { services } = fakeServices({ session: leadSession, extra: { agentTeams: teams, sessionQuery } });
  const bundle = applyAgent(services);
  const post = bundle.events.find((entry) => entry.name === 'tools/post-execute').listener;
  const pre = bundle.events.find((entry) => entry.name === 'agent/pre-step').listener;
  const injected = [];
  const leadAgent = { session: leadSession, options: {}, inject(message) { injected.push(message); } };
  const send = (target) => post({ name: 'send_message', arguments: { target, message: '开始做 X' }, agent: leadAgent }, { isError: false }, async () => ({}));

  await send('mate-1'); // 到线队友：派活需要先管理
  await send('mate-2'); // 在线内：不需要
  await send('nobody'); // 不是队友：不评估
  await pre({ agent: leadAgent }, async () => ({}));
  assert.equal(injected.length, 1, '只有需要管理的队友提示一次');
  const text = injected[0].content[0].text;
  assert.match(text, /\[派活·队友上下文\] mate-1 band=organize/);
  assert.match(text, /relay_freshen\(\{reset:true/);
  assert.match(text, /team_note/);
  assert.doesNotMatch(text, /mate-2 band=/);
  const snapshot = readTeamContext(cwd, 'session-dispatch-lead');
  assert.deepEqual(snapshot.pending.map((row) => row.name), ['mate-1']);

  // 同一队友已在待处理：再派活不重复催（快照即去重）
  await send('mate-1');
  await pre({ agent: leadAgent }, async () => ({}));
  assert.equal(injected.length, 1);
});

test('每次派活先读状态：空闲队友每次都先给判断点（到线给管理选项 / 在线内给「直接派/先管理」），忙队友只拦到线', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const leadSession = fakeSession({ id: 'session-gate-lead', cwd, seq: 0 });
  const tokens = { 'session-dm-1': 420000, 'session-dm-2': 20000 }; // 阈值 40 → organize / ok
  const status = { 'session-dm-1': 'inactive', 'session-dm-2': 'inactive', 'session-dm-3': 'running' };
  const teams = {
    tryMembership: (caller) => (caller?.session?.id === 'session-gate-lead'
      ? { role: 'lead', name: 'lead', root: { session: { id: 'session-gate-lead' } } }
      : undefined),
    listMembers: () => [
      { id: 'session-dm-1', name: 'mate-1', role: 'teammate', status: status['session-dm-1'] },
      { id: 'session-dm-2', name: 'mate-2', role: 'teammate', status: status['session-dm-2'] },
      { id: 'session-dm-3', name: 'mate-3', role: 'teammate', status: status['session-dm-3'] },
    ],
    async sendMessage() { return { messageId: 'm1' }; },
  };
  const sessionQuery = {
    async observeSession(memberId) {
      const projectedTokens = tokens[memberId] ?? 20000;
      return { projections: { values: { contextPressure: { contextWindow: 1000000, projectedTokens } } }, [Symbol.dispose]() {} };
    },
  };
  const { services } = fakeServices({ session: leadSession, extra: { agentTeams: teams, sessionQuery } });
  const bundle = applyAgent(services);
  // 本插件的派活闸门（同 ctx 上可能还有别的 pre-execute 监听，按名字取）。
  const pre = bundle.events.filter((entry) => entry.name === 'tools/pre-execute').map((entry) => entry.listener).find((listener) => listener.name === 'dshContextRelayDispatchGate');
  const leadAgent = { session: leadSession, options: {} };
  const call = (target) => pre({ name: 'send_message', arguments: { target, message: '做 X' }, agent: leadAgent, signal: new AbortController().signal }, async () => ({ kind: 'allow' }));

  // 到线 + 空闲：判断点给「先管理再派 / 直接派」
  const denied = await call('mate-1');
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /派活前先读状态：mate-1 band=organize/);
  assert.match(denied.reason, /先管理再派/);
  assert.match(denied.reason, /直接派/);
  assert.deepEqual(readTeamContext(cwd, 'session-gate-lead').pending.map((row) => row.name), ['mate-1'], '拦住即记快照：直接派也不会在边界漏掉');
  assert.equal((await call('mate-1')).kind, 'allow', '模型判断后原样重发 = 派活');

  // 在线内但空闲：每次派活也要先读状态（判断点：直接派 / 先管理）
  const okGate = await call('mate-2');
  assert.equal(okGate.kind, 'deny');
  assert.match(okGate.reason, /mate-2 band=ok/);
  assert.match(okGate.reason, /在线内，可直接派/);
  assert.equal((await call('mate-2')).kind, 'allow');
  assert.equal((await call('mate-2')).kind, 'deny', '下一次派活重新给判断点（每次派活）');
  assert.equal((await call('mate-2')).kind, 'allow');

  // 忙队友：普通协调消息不拦；到线才拦
  assert.equal((await call('mate-3')).kind, 'allow', 'running + ok：协调消息直接放行');
  tokens['session-dm-3'] = 520000; // running + relay
  const busyStale = await call('mate-3');
  assert.equal(busyStale.kind, 'deny');
  assert.match(busyStale.reason, /mate-3 band=relay/);
  assert.equal((await call('mate-3')).kind, 'allow');

  // 非队友直接放行
  assert.equal((await call('nobody')).kind, 'allow');
});
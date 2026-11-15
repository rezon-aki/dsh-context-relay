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
import { phaseFocusLine, readWorkItems } from '../lib/agent/work-items.js';
import { emptyRoster, ensureLineage, retireGeneration, writeRoster } from '../lib/agent/team.js';
import { subagentsFromLegacy } from './team-fixture.mjs';

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

function fakeSession({ id = 'session-test', cwd, seq, header, events = [] } = {}) {
  return {
    id,
    header: header ?? (cwd === undefined ? {} : { cwd }),
    get seq() { return seq ?? 0; },
    snapshotEvents() { return events; },
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

function fakeCtx(services = {}) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
  const tools = new Map();
  const events = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return normalized?.[name]; },
  };
  return { ctx, tools, events };
}

function fakeTeamCtx(services = {}) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
  const tools = new Map();
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return normalized[name]; },
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

test('relay_phase 跨 phase：读不到 Agent Teams 时用快照兜底——队友待处理只 warning，不拒绝', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-tc-fallback', cwd, seq: 0 });
  mergeTeamContext(cwd, 'session-tc-fallback', { name: 'mate-9', band: 'relay' });
  const bundle = applyAgent(fakeServices({ session }).services);
  const phase = bundle.tools.get('relay_phase');
  const warned = await phase.execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } });
  assert.match(warned.teamWarning, /mate-9/, 'v0.7.0：队友上下文提醒降级为 warning，不拒绝切 phase');
  const ok = await phase.execute({ phase: 'verify', contract_check: CONTRACT_CHECK, team_note: 'mate-9 已 checkpoint；phase 边界后 handoff 重建小队' }, { agent: { session, options: {} } });
  assert.equal(readTeamContext(cwd, 'session-tc-fallback').pending.length, 0);
  assert.equal(readTeamContext(cwd, 'session-tc-fallback').note, 'mate-9 已 checkpoint；phase 边界后 handoff 重建小队');
  assert.equal(ok.team, undefined, '无 Agent Teams 服务 → 不加 team 段');
});

// ── 台账焦点行：带上下文状态，只在变化时注入 ───────────────────────────

test('台账行级去重（P1）：focus/上下文/队友各自内容变化才注入；rev-only 静默；恢复后重入再提示', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const scope = 'session-ctx-line';
  const items = () => [
    { id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' },
    { id: 'p2', title: '补文档', status: 'open', phase: 'build' },
  ];
  writeLedger(cwd, [items()[0]], { rev: 1, currentPhase: { phase: 'build', since: 1 } });
  mergeTeamContext(cwd, scope, { name: 'mate-1', band: 'organize' });
  const session = fakeSession({ id: scope, cwd, seq: 0 });
  const { services, state } = fakeServices({ session });
  const { events } = applyAgent(services);
  const listener = events.filter((entry) => entry.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => ({}));
  // A2 内容等价：注入的行 = 现有 builder 的逐字输出（P1 不改行文本）。
  const focusLine = () => phaseFocusLine(readWorkItems(cwd, { pathOverride: WORK_ITEMS_REL }));
  const teamText = () => teamPendingText(readTeamContext(cwd, scope));

  await step(); // 首步：焦点行 + 队友待处理（同一 step 一条 notice）
  assert.equal(injected.length, 1);
  assert.ok(injected[0].content[0].text.includes(focusLine()), '焦点行与 builder 逐字一致');
  assert.ok(injected[0].content[0].text.includes('[队友] ' + teamText() + ' ——'), '队友行与 builder 逐字一致');
  assert.doesNotMatch(injected[0].content[0].text, /\[上下文\]/, 'ok 档不写 band 行');
  await step(); // 状态没变：不重复
  assert.equal(injected.length, 1);

  // D3=A：handled（phase 边界 team_note 记过结论）≠ 恢复 → 同 band 重入不重复提示
  replaceTeamContext(cwd, scope, { rows: [{ name: 'mate-1', band: 'organize' }], handled: ['mate-1'] });
  await step(); // pending 为空：不注入
  assert.equal(injected.length, 1);
  mergeTeamContext(cwd, scope, { name: 'mate-1', band: 'organize' }); // 新 escalation 清 handled，band 未变
  await step();
  assert.equal(injected.length, 1, 'handled 后同 band 重入不重复（handled≠恢复；D3=A）');

  // rev-only（焦点文本不变）不算变化 → 静默（P1 主因修复：rev 不再进键）
  writeLedger(cwd, [items()[0]], { rev: 2, currentPhase: { phase: 'build', since: 1 } });
  await step();
  assert.equal(injected.length, 1, 'rev 变化不算');

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step(); // organize 升线：只发到线提醒（D1=A：同 step 视为已覆盖 [上下文]，记键不注入）
  assert.equal(injected.length, 2);
  assert.match(injected[1].source.summary, /band=organize/);
  assert.doesNotMatch(injected[1].content[0].text, /\[上下文\]/);

  writeLedger(cwd, items(), { rev: 3, currentPhase: { phase: 'build', since: 1 } });
  await step(); // 焦点文本变化：只发变化行（不再重挂 context/team）
  assert.equal(injected.length, 3);
  const changed = injected[2].content[0].text;
  assert.match(changed, /\[台账·build 0\/2\]/);
  assert.doesNotMatch(changed, /\[上下文\]/, 'band 键未变：不重复');
  assert.doesNotMatch(changed, /\[队友\]/, '队友行未变：不重复');

  assert.equal(clearTeamContextRow(cwd, scope, 'mate-1').cleared, true);
  await step(); // 队友恢复（row 清除）：静默，删 seen
  assert.equal(injected.length, 3);
  mergeTeamContext(cwd, scope, { name: 'mate-1', band: 'relay' });
  await step(); // 恢复后重入 = 新事件（D3=A）：再提示一次
  assert.equal(injected.length, 4);
  assert.match(injected[3].content[0].text, /mate-1\(relay\)/);
});

test('冷启动/热重载：guard 丢失后首步汇总一次（focus+上下文+队友），次步静默', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const scope = 'session-reload';
  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }], { rev: 1, currentPhase: { phase: 'build', since: 1 } });
  mergeTeamContext(cwd, scope, { name: 'mate-1', band: 'organize' });
  // 持久 notice 标记（重启后 LAST_BAND 靠投影/日志 seed）→ 首步不再发到线 notice，直接汇总台账批次。
  const notice = {
    seq: 4,
    type: 'user/message',
    data: { source: { kind: 'dsh-context-relay', form: 'notice' }, content: [{ type: 'text', text: '[context-relay] band=organize · 到线提醒（插件 notice，非用户发言）' }] },
  };
  const session = fakeSession({ id: scope, cwd, seq: 5, events: [notice] });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  clearSentinelMemory(); // 热重载/重启：guard 丢失（band 由持久 marker 恢复）
  const { events } = applyAgent(services);
  const listener = events.filter((entry) => entry.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => ({}));

  await step();
  assert.equal(injected.length, 1, '重启后首步汇总一次');
  const text = injected[0].content[0].text;
  assert.match(text, /\[台账·build 0\/1\]/);
  assert.match(text, /\[上下文\] band=organize/);
  assert.match(text, /\[队友\] 队友待处理 1：mate-1\(organize\)/);
  assert.ok(text.length <= 900, '汇总批次 ≤900，实际 ' + text.length);
  await step();
  assert.equal(injected.length, 1, '次步静默');

  // 再次热重载（clearSentinelMemory 后重装）：仍是一次性汇总，不按步重播。
  clearSentinelMemory();
  await step();
  assert.equal(injected.length, 2, '重新加载后再汇总一次');
  await step();
  assert.equal(injected.length, 2, '仍不按步重播');
});

test('同 step 单条 notice 优先级：到线 notice 覆盖上下文行，台账批次后移一步补上（不丢）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const scope = 'session-priority';
  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }], { rev: 1, currentPhase: { phase: 'build', since: 1 } });
  const session = fakeSession({ id: scope, cwd, seq: 0 });
  const { services, state } = fakeServices({ session });
  const { events } = applyAgent(services);
  const listener = events.filter((entry) => entry.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => ({}));

  await step(); // 首步：焦点行
  assert.equal(injected.length, 1);
  // 同一步：升线（到线 notice）+ 台账焦点变化 → 只注入到线 notice
  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }, { id: 'p2', title: '补文档', status: 'open', phase: 'build' }], { rev: 2, currentPhase: { phase: 'build', since: 1 } });
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step();
  assert.equal(injected.length, 2, '同一 step 最多一条 notice（到线优先）');
  assert.match(injected[1].source.summary, /band=organize/);
  assert.doesNotMatch(injected[1].content[0].text, /\[台账·/, '批次被抑制：不丢，后移一步');
  await step(); // 下一步补：焦点变化行注入，band 已被 notice 覆盖不重复
  assert.equal(injected.length, 3);
  assert.match(injected[2].content[0].text, /\[台账·build 0\/2\]/);
  assert.doesNotMatch(injected[2].content[0].text, /\[上下文\]/, 'D1=A：到线 notice 已覆盖 band 行');
  await step();
  assert.equal(injected.length, 3, '补过之后静默');
});

test('批次上限 900：超限先丢 [队友] 再丢 [上下文]，focus/闭环保留且不截断正文；丢弃的行下一步补', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const scope = 'session-batch-cap';
  writeLedger(cwd, [{
    id: 'p1', title: 'a'.repeat(120), status: 'doing', next: 'b'.repeat(160), phase: 'build',
  }], { rev: 1, currentPhase: { phase: 'build', since: 1 } });
  mergeTeamContext(cwd, scope, { name: 'mate-1', band: 'organize' });
  const notice = {
    seq: 4,
    type: 'user/message',
    data: { source: { kind: 'dsh-context-relay', form: 'notice' }, content: [{ type: 'text', text: '[context-relay] band=organize · 到线提醒（插件 notice，非用户发言）' }] },
  };
  const session = fakeSession({ id: scope, cwd, seq: 5, events: [notice] });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  clearSentinelMemory();
  const bundle = applyAgent(services);
  const listener = bundle.events.filter((entry) => entry.name === 'agent/pre-step').at(-1).listener;
  const post = bundle.events.find((entry) => entry.name === 'tools/post-execute').listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => ({}));
  const longNames = ['x'.repeat(180) + '.js', 'y'.repeat(180) + '.js', 'z'.repeat(180) + '.js'];
  for (const name of longNames) {
    await post({ name: 'write', agent, arguments: { file_path: '/tmp/' + name } }, { isError: false }, async () => undefined);
  }

  await step(); // 超长批次：focus+上下文+闭环+队友
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.ok(text.includes(phaseFocusLine(readWorkItems(cwd, { pathOverride: WORK_ITEMS_REL }))), 'focus 保留且正文不截断');
  assert.match(text, /\[闭环\] 上一步改动未落账：write\(x+\.js\)/);
  assert.doesNotMatch(text, /\[队友\]/, '超限先丢 [队友]');
  assert.doesNotMatch(text, /\[上下文\]/, '仍超限再丢 [上下文]');
  await step(); // 被丢弃的两类下一步补（不推进 guard → 不丢事件）
  assert.equal(injected.length, 2);
  assert.match(injected[1].content[0].text, /\[上下文\] band=organize/);
  assert.match(injected[1].content[0].text, /\[队友\] 队友待处理 1：mate-1\(organize\)/);
  await step();
  assert.equal(injected.length, 2, '补齐后静默');
});

// ── 派活时评估队友上下文（用户口径：管理点在派活，不在等 phase 边界） ──

test('派活时评估队友上下文：到线队友下一步提示一次 + 快照待处理；同签名不重复、band 变化再提示', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const leadSession = fakeSession({ id: 'session-dispatch-lead', cwd, seq: 0 });
  const tokens = { 'session-dm-1': 420000, 'session-dm-2': 20000 }; // 夹具阈值 40 → organize / ok
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
      const projectedTokens = tokens[memberId] ?? 20000;
      return { projections: { values: { contextPressure: { contextWindow: 1000000, projectedTokens } } }, [Symbol.dispose]() {} };
    },
  };
  const { services, state } = fakeServices({ session: leadSession, extra: { agentTeams: teams, sessionQuery } });
  const bundle = applyAgent(services);
  const post = bundle.events.find((entry) => entry.name === 'tools/post-execute').listener;
  const pre = bundle.events.filter((entry) => entry.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const leadAgent = { session: leadSession, options: {}, inject(message) { injected.push(message); } };
  const send = (target) => post({ name: 'send_message', arguments: { agent: target, message: '开始做 X' }, agent: leadAgent }, { isError: false }, async () => ({}));
  const step = () => pre({ agent: leadAgent }, async () => ({}));

  await send('mate-1'); // 到线队友：派活需要先管理
  await send('mate-2'); // 在线内：不需要
  await send('nobody'); // 不是队友：不评估
  await step();
  assert.equal(injected.length, 1, '只有需要管理的队友提示一次（同一 step 一条 notice）');
  const text = injected[0].content[0].text;
  assert.match(text, /\[派活·队友上下文\] mate-1 band=organize/);
  assert.match(text, /relay_freshen\(\{reset:true/);
  assert.match(text, /team_note/);
  assert.doesNotMatch(text, /mate-2 band=/);
  const snapshot = readTeamContext(cwd, 'session-dispatch-lead');
  assert.deepEqual(snapshot.pending.map((row) => row.name), ['mate-1']);
  await step();
  assert.equal(injected.length, 1, '状态没变：不重复注入');

  // 同一队友已在待处理：再派活不重复催（快照即去重）
  await send('mate-1');
  await step();
  assert.equal(injected.length, 1);

  // 签名去重（P1）：快照待处理清掉后再派同一 target/band → 同签名静默
  assert.equal(clearTeamContextRow(cwd, 'session-dispatch-lead', 'mate-1').cleared, true);
  await send('mate-1');
  await step();
  assert.equal(injected.length, 1, '同 (target, band) 签名不重复注入');

  // band 变化（organize → relay）→ 签名变化再注入一次
  tokens['session-dm-1'] = 520000;
  assert.equal(clearTeamContextRow(cwd, 'session-dispatch-lead', 'mate-1').cleared, true);
  await send('mate-1');
  await step();
  assert.equal(injected.length, 2, 'band 变化 → 再提示一次');
  assert.match(injected[1].content[0].text, /mate-1\(relay\)/);
  assert.match(injected[1].content[0].text, /\[派活·队友上下文\] mate-1 band=relay/);

  // 同 step 单条 notice 优先级：到线 notice 与派活提示同 step → 只发 notice，派活提示下一步补（不丢）
  assert.equal(clearTeamContextRow(cwd, 'session-dispatch-lead', 'mate-1').cleared, true);
  tokens['session-dm-1'] = 420000; // band 回到 organize → 派活签名变化（新事件）
  await send('mate-1');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 }; // Lead 自己升线到 organize
  await step();
  assert.equal(injected.length, 3, '同 step 最多一条 notice（到线优先）');
  assert.match(injected[2].source.summary, /band=organize/);
  assert.doesNotMatch(injected[2].content[0].text, /\[派活·队友上下文\]/);
  await step();
  assert.equal(injected.length, 4, '下一步补派活提示（不丢）');
  assert.match(injected[3].content[0].text, /\[派活·队友上下文\] mate-1 band=organize/);
});

test('派活判断点按 (target,band,status) 首次/变化才打断：同状态后续放行；band/status 变化再拦；退休代恒 deny', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const leadSession = fakeSession({ id: 'session-gate-lead', cwd, seq: 0 });
  const tokens = { 'session-dm-1': 420000, 'session-dm-2': 20000 }; // 阈值 40 → organize / ok
  const status = { 'session-dm-1': 'inactive', 'session-dm-2': 'inactive', 'session-dm-3': 'running' };
  // 退休代 fixture：roster 里已 retiredAt 的代数仍然出现在 catalog → 闸门恒 deny（身份错误不吃 ack 去重）。
  const roster = emptyRoster();
  const lineage = ensureLineage(roster, 'old-mate', { name: 'mate-retired', role: 'worker' });
  retireGeneration(lineage, 'mate-retired', 'renewed');
  writeRoster(cwd, roster, 'session-gate-lead');
  const teams = {
    tryMembership: (caller) => (caller?.session?.id === 'session-gate-lead'
      ? { role: 'lead', name: 'lead', root: { session: { id: 'session-gate-lead' } } }
      : undefined),
    listMembers: () => [
      { id: 'session-dm-1', name: 'mate-1', role: 'teammate', status: status['session-dm-1'] },
      { id: 'session-dm-2', name: 'mate-2', role: 'teammate', status: status['session-dm-2'] },
      { id: 'session-dm-3', name: 'mate-3', role: 'teammate', status: status['session-dm-3'] },
      { id: 'session-dm-x', name: 'mate-retired', role: 'teammate', status: 'inactive' },
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
  const call = (target) => pre({ name: 'send_message', arguments: { agent: target, message: '做 X' }, agent: leadAgent, signal: new AbortController().signal }, async () => ({ kind: 'allow' }));

  // 到线 + 空闲：首次判断点给「先管理再派 / 直接派」（deny 文案逐字不变）
  const denied = await call('mate-1');
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /派活前先读状态：mate-1 band=organize/);
  assert.match(denied.reason, /先管理再派/);
  assert.match(denied.reason, /直接派/);
  assert.deepEqual(readTeamContext(cwd, 'session-gate-lead').pending.map((row) => row.name), ['mate-1'], '拦住即记快照：直接派也不会在边界漏掉');
  assert.equal((await call('mate-1')).kind, 'allow', '模型判断后原样重发 = 派活');
  assert.equal((await call('mate-1')).kind, 'allow', '同 band/status 后续派活直接放行（不再重复打断）');

  // band 变化（organize → relay）→ 再给一次判断点
  tokens['session-dm-1'] = 520000;
  const bandChanged = await call('mate-1');
  assert.equal(bandChanged.kind, 'deny', 'band 变化重新打断');
  assert.match(bandChanged.reason, /mate-1 band=relay/);
  assert.equal((await call('mate-1')).kind, 'allow');

  // 在线内（ok）空闲：首次判断点 → 同状态放行（不再每次派活都打断）
  const okGate = await call('mate-2');
  assert.equal(okGate.kind, 'deny');
  assert.match(okGate.reason, /mate-2 band=ok/);
  assert.match(okGate.reason, /在线内，可直接派/);
  assert.equal((await call('mate-2')).kind, 'allow');
  assert.equal((await call('mate-2')).kind, 'allow', '同 band/status 不再打断');

  // 忙队友：普通协调消息不拦；到线首次拦一次，同状态后续放行
  assert.equal((await call('mate-3')).kind, 'allow', 'running + ok：协调消息直接放行');
  tokens['session-dm-3'] = 520000; // running + relay
  const busyStale = await call('mate-3');
  assert.equal(busyStale.kind, 'deny');
  assert.match(busyStale.reason, /mate-3 band=relay/);
  assert.equal((await call('mate-3')).kind, 'allow');
  // status 变化（running → inactive）→ 再给一次判断点
  status['session-dm-3'] = 'inactive';
  const statusChanged = await call('mate-3');
  assert.equal(statusChanged.kind, 'deny', 'status 变化重新打断');
  assert.match(statusChanged.reason, /status=inactive/);
  assert.equal((await call('mate-3')).kind, 'allow');

  // 退休代恒 deny（身份错误不允许被 ack 去重）
  const retiredFirst = await call('mate-retired');
  assert.equal(retiredFirst.kind, 'deny');
  assert.match(retiredFirst.reason, /已退休代/);
  assert.equal((await call('mate-retired')).kind, 'deny', '退休代重发仍 deny');

  // clearSentinelMemory（插件卸载/热重载）清 DISPATCH_ACK：同状态重新给一次判断点
  clearSentinelMemory();
  assert.equal((await call('mate-2')).kind, 'deny', 'ack 随 clearSentinelMemory 清理，重新给判断点');
  assert.equal((await call('mate-2')).kind, 'allow');

  // 非队友直接放行
  assert.equal((await call('nobody')).kind, 'allow');
});
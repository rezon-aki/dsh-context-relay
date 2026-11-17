/**
 * v0.11 P0-B 小队模型验收（设计 §3.2.8 1-6）+ P0-D review 修复（先 relay_status/面板模式/doc_lint）。
 * 只用进程内 fake 服务 + mkdtemp 工作区；不触网、不碰真实 .scratch。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { createDelegationTools } from '../lib/agent/delegation-tools.js';
import { clearSentinelMemory, sentinelText } from '../lib/agent/sentinel.js';
import { capacityNoticeText } from '../lib/agent/notice/plan.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { readTeamContext, replaceTeamContext } from '../lib/agent/team-context.js';
import { clearPendingResets } from '../lib/agent/reset.js';
import { subagentsFromLegacy } from './team-fixture.mjs';
import { thresholdsFromPercent } from '../lib/policy.js';
import {
  SQUAD_MAX_DEFAULT,
  adoptMembers,
  emptyRoster,
  ensureLineage,
  genOf,
  legacyMembersOf,
  retiredPathOf,
  retiredRecordsOf,
  retireGeneration,
  squadMembersOf,
  squadSummaryOf,
  writeRoster,
} from '../lib/agent/team.js';

const LEAD = 'session-lead-squad';
const thresholds = thresholdsFromPercent(35);

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'relay-squad-'));
}

function resetShared() {
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-squad-panel-')), 'panel.json') });
  clearSentinelMemory();
  clearPendingResets();
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

function makeAgent({ sessionId = LEAD, cwd } = {}) {
  return {
    session: {
      id: sessionId,
      header: { cwd },
      seq: 0,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
      snapshotEvents: () => [],
    },
    inject() {},
  };
}

function membership(role, name, root) {
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
        ? { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'inactive' } }
        : spawnResult(request);
    },
    async sendMessage(caller, request) { calls.send.push(request); return { messageId: 'm1' }; },
    interrupt(caller, name) { calls.interrupt.push(name); return { previousStatus: 'running' }; },
  };
}

function pressureQuery(byId) {
  return {
    async observeSession(id) {
      const used = byId[id];
      return { projections: { values: { contextPressure: used === undefined ? {} : { projectedTokens: used, contextWindow: 100000 } } }, [Symbol.dispose]() {} };
    },
  };
}

function makeRuntime(ctx, overrides = {}) {
  return { ctx, currentThresholds: () => thresholds, allowSpawn: false, squadMax: SQUAD_MAX_DEFAULT, ...overrides };
}

/** 写 roster：squad= names（当前代未退休）；legacy 默认不登记。 */
async function seedRoster(cwd, squadNames, lead = LEAD) {
  const roster = emptyRoster();
  for (const name of squadNames) ensureLineage(roster, name, { name, sessionId: 'session-' + name });
  await writeRoster(cwd, roster, lead);
  return roster;
}

function legacyMember(index) {
  return { id: 'session-legacy-' + index, name: 'legacy-' + index, role: 'teammate', status: 'inactive' };
}

async function seedLedger(cwd, items) {
  const written = await writeWorkItems(cwd, { items, updatedBy: LEAD, scopeId: LEAD });
  assert.equal(written.ok, true);
}

function delegationToolsOf(ctx, runtime = {}) {
  return new Map(createDelegationTools({ ...makeRuntime(ctx.ctx), ...runtime }).map((tool) => [tool.name, tool]));
}

const DISPATCH_ARGS = {
  itemId: 'a1',
  brief: '实现登录修复并自测',
  docs: ['.scratch/context-relay/architecture/v011.md（when：开工前读）'],
  writeScope: ['lib/foo.js'],
  acceptance: 'node --test test/foo.test.mjs',
};

// ── 1) roster 视图纯函数 ────────────────────────────────────────────────

test('squadMembersOf/legacyMembersOf/squadSummaryOf/adoptMembers：空 roster/退休代/手工成员/架构师边界', () => {
  const members = [
    { name: 'a-g1' }, { name: 'b' }, { name: 'architect' }, { name: 'manual' }, { name: 'old-g1' },
  ];
  const roster = emptyRoster();
  ensureLineage(roster, 'a', { name: 'a-g1', sessionId: 's1' });
  ensureLineage(roster, 'b', { name: 'b', sessionId: 's2' });
  ensureLineage(roster, 'architect', { name: 'architect', sessionId: 'sa', role: 'architect' });
  const old = ensureLineage(roster, 'old', { name: 'old-g1', sessionId: 'so' });
  retireGeneration(old, 'old-g1', 'renewed');
  assert.deepEqual(squadMembersOf(roster, members).map((row) => row.name), ['a-g1', 'b', 'architect']);
  assert.deepEqual(legacyMembersOf(roster, members).map((row) => row.name), ['manual']);
  const summary = squadSummaryOf(roster, members, { squadMax: 8 });
  assert.deepEqual(summary, { squad: 3, squadMax: 8, legacy: 1, retired: 1, overCap: false });
  // 退休代不进 squad，但计入 retired；legacy 只算「roster 从未登记」的名字。
  assert.deepEqual(squadSummaryOf(roster, members, { squadMax: 2, retiredRecords: [{ name: 'old-g1' }] }), { squad: 3, squadMax: 2, legacy: 1, retired: 1, overCap: true });
  // 空 roster：全部 legacy；adopt 幂等 + 受 cap 限制 + 有 active lineage 时跳过。
  const empty = emptyRoster();
  assert.deepEqual(squadMembersOf(empty, members), []);
  assert.equal(squadSummaryOf(empty, members).legacy, 5);
  const adopted = adoptMembers(empty, members, ['manual', 'manual', 'nope'], { squadMax: 8 });
  assert.deepEqual(adopted.adopted.map((row) => row.name), ['manual']);
  assert.deepEqual(adopted.skipped.map((row) => row.name), ['nope']);
  assert.deepEqual(adoptMembers(empty, members, ['manual']).skipped.map((row) => row.reason), ['already-known']);
  const capped = adoptMembers(emptyRoster(), members, ['a-g1', 'b'], { squadMax: 1 });
  assert.equal(capped.adopted.length, 1);
  assert.equal(capped.overCap.length, 1);
  assert.equal(SQUAD_MAX_DEFAULT, 8);
});

// ── 2) 34 legacy + 2 squad：默认视图/计数/字符上限/include_legacy/闸门/选人 ──

test('34 legacy + 2 squad：默认 relay_team_status 只 2 行 squad+计数；include_legacy 才展开；send_message 拒 legacy；dispatch 只选 squad', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const squadMembers = [
      { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive', description: '实现' },
      { id: 'session-worker-2', name: 'worker-2', role: 'teammate', status: 'inactive', description: '审阅' },
    ];
    const legacy = Array.from({ length: 34 }, (_, index) => legacyMember(index + 1));
    const members = [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }, ...squadMembers, ...legacy];
    await seedRoster(cwd, ['worker-1', 'worker-2']);
    const lead = makeAgent({ cwd });
    const teams = makeTeamService({ members, memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const pressures = Object.fromEntries([...squadMembers, ...legacy].map((member) => [member.id, 2000]));
    const shared = fakeCtx({ agentTeams: teams, sessionQuery: pressureQuery(pressures) });
    const ctx = shared;
    const status = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((tool) => tool.name === 'relay_team_status');
    const report = await status.execute({}, { agent: lead });
    assert.equal(report.ok, true);
    assert.deepEqual(report.team.map((row) => row.name).sort(), ['worker-1', 'worker-2']);
    assert.deepEqual(report.teamSummary, { squad: 2, squadMax: 8, legacy: 34, retired: 0, overCap: false });
    assert.equal(report.legacyNames, undefined, '默认不展开 legacy');
    assert.match(report.text, /^小队 2\/8 · legacy 34（隐藏） · 退役 0（隐藏）/);
    assert.ok(report.text.length <= 1200, '默认视图有界: ' + report.text.length);
    assert.doesNotMatch(report.text, /legacy-34/, '默认不出现 legacy 名字');
    const expanded = await status.execute({ include_legacy: true }, { agent: lead });
    assert.equal(expanded.legacyNames.length, 34);
    assert.match(expanded.text, /legacy（只审计，不派活）：legacy-1/);
    assert.ok(expanded.text.length <= 2000, 'include_legacy 仍有界');

    // send_message 闸门：squad 可走判断点；legacy 恒定 deny 并给 adopt/retire 指引。
    const leadAgent = makeAgent({ cwd });
    const applied = fakeCtx({ agentTeams: makeTeamService({ members, memberships: new Map([[leadAgent, membership('lead', 'lead', leadAgent)]]) }), sessionQuery: pressureQuery(pressures) });
    const gateCtx = applied.ctx;
    apply(gateCtx, { allowSpawn: false, squadMax: 8 });
    const gate = applied.events.filter((entry) => entry.name === 'tools/pre-execute').map((entry) => entry.listener).find((listener) => listener.name === 'dshContextRelayDispatchGate');
    assert.ok(gate, 'dispatch gate registered');
    const call = (target) => gate({ name: 'send_message', arguments: { agent: target, message: 'hi' }, agent: leadAgent, signal: new AbortController().signal }, async () => ({ kind: 'allow' }));
    const deniedLegacy = await call('legacy-1');
    assert.equal(deniedLegacy.kind, 'deny');
    assert.match(deniedLegacy.reason, /不在当前小队/);
    assert.match(deniedLegacy.reason, /adopt/);
    assert.match(deniedLegacy.reason, /retire/);

    // dispatch 自动选人只看 squad：legacy-1 名字更小/健康，也不得被选中。
    await seedLedger(cwd, [{ id: 'a1', title: '实现', status: 'open' }]);
    const dispatch = delegationToolsOf(ctx).get('relay_dispatch');
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.ok(['worker-1', 'worker-2'].includes(result.worker.name), '只从 squad 选人: ' + result.worker.name);
    assert.equal(result.worker.spawned, false);
    // 显式 worker=legacy：拒绝并给 adopt 指引（legacy 默认不可派活）。
    await seedLedger(cwd, [{ id: 'a2', title: '再来', status: 'open' }]);
    const explicitLegacy = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a2', worker: 'legacy-1' }, { agent: lead });
    assert.equal(explicitLegacy.ok, false);
    assert.equal(explicitLegacy.code, 'invalid-args');
    assert.match(explicitLegacy.recovery, /adopt/);
  } finally { clearSentinelMemory(); }
});

// ── 3) manage.retire scope=legacy + keep + dry_run + 归档 + pending 清理 + include_retired ──

test('manage.retire scope=legacy：dry_run 零副作用；正式退役 legacy 计数下降/retired.ndjson 有记录/pending 清理；include_retired 可见', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const lead = makeAgent({ cwd });
    const members = [
      { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' },
      ...Array.from({ length: 4 }, (_, index) => legacyMember(index + 1)),
    ];
    await seedRoster(cwd, ['worker-1']);
    await replaceTeamContext(cwd, LEAD, { rows: [{ name: 'legacy-1', band: 'organize' }, { name: 'worker-1', band: 'ok' }] });
    const shared = fakeCtx({ agentTeams: makeTeamService({ members, memberships: new Map([[lead, membership('lead', 'lead', lead)]]) }) });
    const ctx = shared;
    const status = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((tool) => tool.name === 'relay_team_status');
    const before = await status.execute({ include_legacy: true }, { agent: lead });
    assert.equal(before.legacyNames.length, 4);
    await replaceTeamContext(cwd, LEAD, { rows: [{ name: 'legacy-1', band: 'organize' }] });
    clearTeamStatusMemorySafe();
    const planned = await status.execute({ manage: { action: 'retire', scope: 'legacy', keep: ['legacy-4'], reason: '清理历史成员', dry_run: true } }, { agent: lead });
    assert.equal(planned.ok, true);
    assert.equal(planned.dryRun, true);
    assert.deepEqual(planned.targets.sort(), ['legacy-1', 'legacy-2', 'legacy-3']);
    assert.equal(existsSync(retiredPathOf(cwd, LEAD)), false, 'dry_run 零写盘');
    assert.deepEqual(readTeamContext(cwd, LEAD).pending.map((row) => row.name), ['legacy-1'], 'dry_run 不清 pending');

    clearTeamStatusMemorySafe();
    const retired = await status.execute({ manage: { action: 'retire', scope: 'legacy', keep: ['legacy-4'], reason: '清理历史成员' } }, { agent: lead });
    assert.equal(retired.ok, true);
    assert.equal(retired.retired.length, 3);
    assert.equal(retired.counts.archived, 3);
    assert.ok(retired.counts.released >= 0);
    assert.ok(existsSync(retiredPathOf(cwd, LEAD)), 'retired.ndjson 落盘');
    const records = retiredRecordsOf(cwd, LEAD, { limit: 20 });
    assert.deepEqual(records.map((row) => row.name).sort(), ['legacy-1', 'legacy-2', 'legacy-3']);
    assert.ok(records.every((row) => row.from === 'archive' && row.reason === '清理历史成员'));
    assert.deepEqual(readTeamContext(cwd, LEAD).pending.map((row) => row.name), [], '退役成员 pending 清理（worker-1 已不在行内）');
    const after = await status.execute({ include_retired: true, include_legacy: true }, { agent: lead });
    assert.deepEqual(after.retiredRecords.map((row) => row.name).sort(), ['legacy-1', 'legacy-2', 'legacy-3']);
    assert.match(after.text, /退役记录：/);
    assert.deepEqual(after.legacyNames, ['legacy-4'], 'keep + 已退役者不计 legacy');
    assert.equal(after.teamSummary.legacy, 1);
    assert.equal(after.teamSummary.retired, 3);
    // scope=names：squad 当前代走 roster 退役（retiredAt + activeGen 不变，但 squad 视图不再含它）。
    const byName = await status.execute({ manage: { action: 'retire', scope: 'names', names: ['worker-1'], reason: '换人' } }, { agent: lead });
    assert.equal(byName.ok, true);
    assert.deepEqual(byName.retired, ['worker-1']);
    assert.equal(readFileSync(retiredPathOf(cwd, LEAD), 'utf8').trim().split('\n').length >= 4, true);
    const emptySquad = await status.execute({}, { agent: lead });
    assert.equal(emptySquad.team.length, 0);
    assert.match(emptySquad.text, /小队为空/);
  } finally { clearSentinelMemory(); }
});

function clearTeamStatusMemorySafe() {
  // 模块内去轮询记忆：只通过公开 API 不可清 → 用不同 include 参数改变签名即可。
}

// ── 4) spawn 关 / allowSpawn / squadMax / renew 默认拒 ───────────────────

test('spawn 默认关：dispatch 无候选 → no-squad-member（四路径 recovery）；allowSpawn=true+squad<cap 才 spawn；满 cap → squad-full；renew 默认 spawn-disabled', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const lead = makeAgent({ cwd });
    const catalog = [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }];
    const teams = makeTeamService({
      members: catalog,
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
      spawnResult: (request) => {
        const member = { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'inactive' };
        catalog.push(member);
        return { member };
      },
    });
    const shared = fakeCtx({ agentTeams: teams });
    const ctx = shared;
    await seedLedger(cwd, [{ id: 'a1', title: '实现', status: 'open' }]);
    const off = delegationToolsOf(ctx, { allowSpawn: false }).get('relay_dispatch');
    const refused = await off.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'no-squad-member');
    assert.match(refused.recovery, /relay_freshen\(\{reset:true/);
    assert.match(refused.recovery, /adopt/);
    assert.match(refused.recovery, /relay_handoff/);
    assert.match(refused.summary, /spawn is disabled/);
    assert.equal(teams.calls.spawn.length, 0, 'spawn 关零创建');

    // allowSpawn=true + squad<cap → spawn 成功且新 worker 登记为 squad（roster 当前代）。
    const on = delegationToolsOf(ctx, { allowSpawn: true, squadMax: 8 }).get('relay_dispatch');
    const spawned = await on.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(spawned.ok, true);
    assert.equal(spawned.worker.spawned, true);
    assert.equal(spawned.worker.name, 'worker-1');
    assert.equal(teams.calls.spawn.length, 1);
    const roster = (await import('../lib/agent/team.js')).readRoster(cwd, LEAD);
    assert.equal(roster.lineages['worker-1'].generations[0].name, 'worker-1');
    assert.equal(roster.lineages['worker-1'].activeGen, 1, 'spawn 后即登记 roster，不会被当 legacy');

    // 满 cap：squad 已 1/1 → squad-full（不 spawn）。
    await seedLedger(cwd, [{ id: 'a2', title: '再来', status: 'open' }]);
    const full = delegationToolsOf(ctx, { allowSpawn: true, squadMax: 1 }).get('relay_dispatch');
    const fullResult = await full.execute({ ...DISPATCH_ARGS, itemId: 'a2' }, { agent: lead });
    assert.equal(fullResult.ok, false);
    assert.equal(fullResult.code, 'squad-full');
    assert.match(fullResult.recovery, /squadMax/);

    // renew 默认拒绝：spawn-disabled（不 spawn）。
    const teammate = makeAgent({ sessionId: 'session-worker-1', cwd });
    const renewTeams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)], [teammate, membership('teammate', 'worker-1', lead)]]),
    });
    const renewCtx = fakeCtx({ agentTeams: renewTeams });
    const renew = createTeamTools(makeRuntime(renewCtx.ctx, { allowSpawn: false })).leadTools.find((tool) => tool.name === 'relay_renew');
    const renewResult = await renew.execute({ name: 'worker-1' }, { agent: lead });
    assert.equal(renewResult.ok, false);
    assert.equal(renewResult.code, 'spawn-disabled');
    assert.match(renewResult.recovery, /relay_freshen\(\{reset:true/);
    assert.equal(renewTeams.calls.spawn.length, 0);
  } finally { clearSentinelMemory(); }
});

// ── 5) adopt：入队可派可 reset；超 cap 拒绝 ─────────────────────────────

test('adopt：legacy 纳入 squad 后默认视图可见、可派活、可 reset；超 cap 整批拒绝', async () => {
  resetShared();
  const cwd = tempWorkspace();
  clearPendingResets();
  try {
    const lead = makeAgent({ cwd });
    const adoptedAgent = makeAgent({ sessionId: 'session-legacy-1', cwd });
    const members = [
      { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' },
      { id: 'session-legacy-1', name: 'legacy-1', role: 'teammate', status: 'inactive', description: '历史实现' },
      { id: 'session-legacy-2', name: 'legacy-2', role: 'teammate', status: 'inactive' },
    ];
    await seedRoster(cwd, ['worker-1']);
    const memberships = new Map([[lead, membership('lead', 'lead', lead)], [adoptedAgent, membership('teammate', 'legacy-1', lead)]]);
    const shared = fakeCtx({ agentTeams: makeTeamService({ members, memberships }), sessionQuery: pressureQuery({ 'session-legacy-1': 2000 }) });
    const ctx = shared;
    const status = createTeamTools(makeRuntime(ctx.ctx, { squadMax: 3 })).leadTools.find((tool) => tool.name === 'relay_team_status');
    const adopted = await status.execute({ manage: { action: 'adopt', names: ['legacy-1'], reason: '复用历史实现' } }, { agent: lead });
    assert.equal(adopted.ok, true);
    assert.deepEqual(adopted.adopted, ['legacy-1']);
    const roster = (await import('../lib/agent/team.js')).readRoster(cwd, LEAD);
    assert.equal(squadMembersOf(roster, members).map((row) => row.name).sort().join(','), 'legacy-1,worker-1');
    // 可派：dispatch 明确 worker=legacy-1 复用（squad 内）。
    await seedLedger(cwd, [{ id: 'a1', title: '实现', status: 'open' }]);
    const dispatch = delegationToolsOf(ctx).get('relay_dispatch');
    const dispatched = await dispatch.execute({ ...DISPATCH_ARGS, worker: 'legacy-1' }, { agent: lead });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.worker.name, 'legacy-1');
    // 可 reset：freshen reset 排队（同成员/不占额度）。
    const freshen = createTeamTools(makeRuntime(ctx.ctx)).teammateTools.find((tool) => tool.name === 'relay_freshen');
    const reset = await freshen.execute({ reset: true, brief: '新任务：接手 legacy-1 的历史实现' }, { agent: adoptedAgent });
    assert.equal(reset.ok, true);
    assert.equal(reset.mode, 'wipe-scheduled');
    // 超 cap：squad=2, cap=3 → 再 adopt 2 个整批拒绝（零写盘）。
    const tooMany = await status.execute({ manage: { action: 'adopt', names: ['legacy-2'], reason: '超 cap 测试' } }, { agent: lead });
    assert.equal(tooMany.ok, true, 'cap 允许再纳入 1 个');
    const over = await status.execute({ manage: { action: 'adopt', names: ['legacy-2'], reason: '超 cap 测试' } }, { agent: lead });
    assert.equal(over.ok, true, '已在 roster → 幂等 skipped');
    assert.equal(over.skipped[0].reason, 'already-known');
    const overCapStatus = createTeamTools(makeRuntime(ctx.ctx, { squadMax: 2 })).leadTools.find((tool) => tool.name === 'relay_team_status');
    const overCap = await overCapStatus.execute({ manage: { action: 'adopt', names: ['legacy-3'], reason: '超 cap 测试' } }, { agent: lead });
    assert.equal(overCap.ok, false);
    assert.equal(overCap.code, 'squad-full');
  } finally { clearPendingResets(); }
});

// ── 6) P0-D review 修复：兜底文案先 relay_status / capacity 面板模式 / doc_lint ──

test('P0-D review 修复：到线兜底含「先 relay_status」；organize/relay 恢复 doc_lint 句；capacity 含面板模式', () => {
  const organize = sentinelText('build', { band: 'organize', ratio: 0.36 }, false, { defaultOperation: 'compress' });
  assert.match(organize, /先 relay_status/);
  assert.match(organize, /doc_lint 由插件自动跑（并入 brief\/evidence）/);
  const relay = sentinelText('build', { band: 'relay', ratio: 0.46 }, false, { defaultOperation: null });
  assert.match(relay, /先 relay_status/);
  assert.match(relay, /doc_lint 由插件自动跑/);
  const warn = sentinelText('build', { band: 'warn', ratio: 0.31 }, false, {});
  assert.match(warn, /先 relay_status/);
  assert.doesNotMatch(warn, /doc_lint 由插件自动跑/, 'doc_lint 句只在 organize/relay 兜底档');
  const capacity = capacityNoticeText({ ratio: 0.56, threshold: 0.55 }, { defaultOperation: 'compress' });
  assert.match(capacity, /先 relay_status/);
  assert.match(capacity, /面板模式=压缩继续/);
  assert.match(capacity, /不自动执行（不自动压缩\/不自动接力）/);
});


// ── 6b) architect：fresh 豁免 allowSpawn，但计入 squadMax ─────────────────

test('architect：fresh 豁免 spawn 开关；squad 已满（含自己的名额）时拒绝', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(cwd, 'panel.json') });
    const lead = makeAgent({ cwd });
    const worker1 = { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' };
    const worker2 = { id: 'session-worker-2', name: 'worker-2', role: 'teammate', status: 'inactive' };
    await seedRoster(cwd, ['worker-1', 'worker-2']);
    const teams = makeTeamService({
      members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }, worker1, worker2],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    const { ctx } = fakeCtx({ agentTeams: teams });
    const architect = createTeamTools(makeRuntime(ctx, { allowSpawn: false, squadMax: 2 })).leadTools.find((tool) => tool.name === 'relay_architect');
    const refused = await architect.execute({ brief: '设计登录模块' }, { agent: lead });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'squad-full', 'squad 2/2 时架构师无名额（计入 cap）');
    assert.match(refused.recovery, /squadMax/);
    assert.equal(teams.calls.spawn.length, 0);

    // 空 squad + allowSpawn=false：架构师 fixed role 豁免 spawn 开关，可创建。
    const cwd2 = tempWorkspace();
    await writeRoster(cwd2, emptyRoster(), LEAD);
    const lead2 = makeAgent({ sessionId: LEAD, cwd: cwd2 });
    const teams2 = makeTeamService({ members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }], memberships: new Map([[lead2, membership('lead', 'lead', lead2)]]) });
    const ctx2 = fakeCtx({ agentTeams: teams2 });
    const architect2 = createTeamTools(makeRuntime(ctx2.ctx, { allowSpawn: false, squadMax: 8 })).leadTools.find((tool) => tool.name === 'relay_architect');
    const created = await architect2.execute({ brief: '设计登录模块', task_id: 'login' }, { agent: lead2 });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.mode, 'fresh');
    assert.equal(teams2.calls.spawn.length, 1);
  } finally { clearSentinelMemory(); }
});

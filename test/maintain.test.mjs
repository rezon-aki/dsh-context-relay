/**
 * v0.13 B1（relay-systemic-audit §6 D1-B）：relay_team_status manage.maintain 验收。
 * Lead 只发标准维护消息（relay_checkpoint → relay_freshen），不擦除、不 spawn、不改 roster；
 * 全部走工具 execute（真实调用路径），不直接调内部函数。只用进程内 fake 服务 + mkdtemp 工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamTools, clearTeamStatusMemory } from '../lib/agent/team-tools.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearPendingResets, hasPendingReset } from '../lib/agent/reset.js';
import { emptyRoster, ensureLineage, readRoster, retiredPathOf, writeRoster } from '../lib/agent/team.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { subagentsFromLegacy } from './team-fixture.mjs';

const LEAD = 'session-lead-maintain';
const thresholds = thresholdsFromPercent(35);

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'relay-maintain-'));
}

function resetShared() {
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-maintain-panel-')), 'panel.json') });
  clearSentinelMemory();
  clearPendingResets();
  clearTeamStatusMemory();
}

function fakeCtx(services = {}) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register() { return () => {}; } },
    get(name) { return normalized?.[name]; },
  };
  return { ctx };
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

function makeTeamService({ members = [], memberships = new Map(), sendMessage } = {}) {
  const calls = { send: [] };
  return {
    calls,
    tryMembership(agent) { return memberships.get(agent); },
    listMembers() { return members; },
    async sendMessage(caller, request) {
      calls.send.push(request);
      return typeof sendMessage === 'function' ? sendMessage(request) : { messageId: 'm-' + calls.send.length };
    },
    interrupt() { return { previousStatus: 'running' }; },
  };
}

function makeRuntime(ctx) {
  return { ctx, currentThresholds: () => thresholds, allowSpawn: false, squadMax: 8 };
}

async function seedRoster(cwd, names) {
  const roster = emptyRoster();
  for (const name of names) ensureLineage(roster, name, { name, sessionId: 'session-' + name });
  await writeRoster(cwd, roster, LEAD);
  return roster;
}

function statusOf(ctx) {
  return createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((tool) => tool.name === 'relay_team_status');
}

function messageText(call) {
  return call.content.find((block) => block.type === 'text').text;
}

function leadAndWorkers(cwd) {
  const lead = makeAgent({ cwd });
  const members = [
    { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' },
    { id: 'session-worker-2', name: 'worker-2', role: 'teammate', status: 'running' },
  ];
  return { lead, members, memberships: new Map([[lead, membership('lead', 'lead', lead)]]) };
}

test('manage.maintain：逐人发标准 relay_checkpoint → relay_freshen({reset:true}) 消息，零擦除零写盘', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const { lead, members, memberships } = leadAndWorkers(cwd);
    await seedRoster(cwd, ['worker-1', 'worker-2']);
    const before = readRoster(cwd, LEAD);
    const teams = makeTeamService({ members, memberships });
    const status = statusOf(fakeCtx({ agentTeams: teams }));
    const result = await status.execute({ manage: { action: 'maintain', names: ['worker-1', 'worker-2'], brief: '接手登录修复，先读交接记录' } }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'maintain');
    assert.equal(result.reset, true, 'reset 默认 true（真清空复用）');
    assert.deepEqual(result.sent.map((row) => row.name).sort(), ['worker-1', 'worker-2']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.counts, { targets: 2, sent: 2, failed: 0 });
    assert.equal(teams.calls.send.length, 2);
    for (const call of teams.calls.send) {
      const text = messageText(call);
      assert.match(text, /relay_checkpoint/);
      assert.match(text, /relay_freshen\(\{reset:true, brief:"接手登录修复，先读交接记录"\}\)/);
      assert.match(text, /不要手工 subagent/);
    }
    assert.deepEqual(readRoster(cwd, LEAD), before, 'maintain 不改 roster');
    assert.equal(existsSync(retiredPathOf(cwd, LEAD)), false, 'maintain 不写退役归档');
    assert.equal(hasPendingReset('session-worker-1'), false, 'Lead 不直接排队擦除');
    assert.equal(hasPendingReset('session-worker-2'), false, 'running 目标同样只发消息');
  } finally {
    clearSentinelMemory();
    clearPendingResets();
  }
});

test('manage.maintain：reset:false 发同任务 freshen；brief 必填；dry_run 零消息', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const { lead, members, memberships } = leadAndWorkers(cwd);
    await seedRoster(cwd, ['worker-1']);
    const teams = makeTeamService({ members, memberships });
    const status = statusOf(fakeCtx({ agentTeams: teams }));

    const dry = await status.execute({ manage: { action: 'maintain', names: ['worker-1'], brief: '新任务', dry_run: true } }, { agent: lead });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.targets, ['worker-1']);
    assert.equal(teams.calls.send.length, 0, 'dry_run 零消息');

    const noBrief = await status.execute({ manage: { action: 'maintain', names: ['worker-1'] } }, { agent: lead });
    assert.equal(noBrief.ok, false);
    assert.equal(noBrief.code, 'invalid-args');
    assert.match(noBrief.error, /brief/);

    const fresh = await status.execute({ manage: { action: 'maintain', names: ['worker-1'], brief: '继续实现', reset: false } }, { agent: lead });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.reset, false);
    const text = messageText(teams.calls.send[0]);
    assert.match(text, /relay_freshen\(\{brief:"继续实现"\}\)/);
    assert.doesNotMatch(text, /reset:true/);
  } finally {
    clearSentinelMemory();
    clearPendingResets();
  }
});

test('manage.maintain：发送失败/非小队/架构师逐人报因，不影响其他成员', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const lead = makeAgent({ cwd });
    const members = [
      { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' },
      { id: 'session-worker-2', name: 'worker-2', role: 'teammate', status: 'inactive' },
      { id: 'session-legacy-1', name: 'legacy-1', role: 'teammate', status: 'inactive' },
      { id: 'session-architect', name: 'architect', role: 'teammate', status: 'inactive' },
    ];
    await seedRoster(cwd, ['worker-1', 'worker-2']);
    const before = readRoster(cwd, LEAD);
    const teams = makeTeamService({
      members,
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
      sendMessage: (request) => {
        if (request.target === 'worker-1') throw new Error('mailbox busy');
        return { messageId: 'm-' + request.target };
      },
    });
    const status = statusOf(fakeCtx({ agentTeams: teams }));
    const result = await status.execute({ manage: { action: 'maintain', names: ['worker-1', 'legacy-1', 'architect', 'worker-2', 'ghost'], brief: '复用' } }, { agent: lead });
    assert.equal(result.ok, true, '部分失败仍返回逐人结果');
    assert.deepEqual(result.sent.map((row) => row.name), ['worker-2'], '一个失败不影响其他成员');
    const reasons = Object.fromEntries(result.failed.map((row) => [row.name, row.reason]));
    assert.match(reasons['worker-1'], /mailbox busy/);
    assert.match(reasons['legacy-1'], /not-in-squad/);
    assert.match(reasons['architect'], /relay_architect/);
    assert.match(reasons['ghost'], /not-in-squad/);
    assert.equal(result.counts.sent, 1);
    assert.equal(result.counts.failed, 4);
    assert.deepEqual(readRoster(cwd, LEAD), before, '失败不写 roster');
  } finally {
    clearSentinelMemory();
    clearPendingResets();
  }
});

test('manage：maintain 与 adopt/retire 顺序调用互不冲突', async () => {
  resetShared();
  const cwd = tempWorkspace();
  try {
    const lead = makeAgent({ cwd });
    const members = [
      { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-worker-1', name: 'worker-1', role: 'teammate', status: 'inactive' },
      { id: 'session-legacy-1', name: 'legacy-1', role: 'teammate', status: 'inactive' },
    ];
    await seedRoster(cwd, ['worker-1']);
    const teams = makeTeamService({ members, memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const status = statusOf(fakeCtx({ agentTeams: teams }));

    const notYet = await status.execute({ manage: { action: 'maintain', names: ['legacy-1'], brief: '接手' } }, { agent: lead });
    assert.equal(notYet.ok, false);
    assert.equal(notYet.code, 'no-targets');
    assert.match(notYet.failed[0].reason, /adopt/);

    const adopted = await status.execute({ manage: { action: 'adopt', names: ['legacy-1'], reason: '复用历史实现' } }, { agent: lead });
    assert.equal(adopted.ok, true);
    const maintained = await status.execute({ manage: { action: 'maintain', names: ['legacy-1'], brief: '接手历史实现' } }, { agent: lead });
    assert.equal(maintained.ok, true);
    assert.deepEqual(maintained.sent.map((row) => row.name), ['legacy-1']);

    const retired = await status.execute({ manage: { action: 'retire', scope: 'names', names: ['worker-1'], reason: '清理' } }, { agent: lead });
    assert.equal(retired.ok, true);
    assert.deepEqual(retired.retired, ['worker-1']);
  } finally {
    clearSentinelMemory();
    clearPendingResets();
  }
});

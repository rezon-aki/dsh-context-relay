/**
 * relay_rehydrate（v0.3.2）测试：跨会话记录分区的 plan / apply / 失败半成品防护。
 * 纯文件 IO + fake agentTeams；不触网、不碰真实 workspace 记录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import {
  LEGACY_PARTITION_ID,
  buildCheckpointMarkdown,
  ensureLineage,
  partitionRelativePath,
  profilePathOf,
  readLedger,
  readRoster,
  rosterPathOf,
  teamBaseOf,
  teamRootOf,
  writeCheckpoint,
  writeRoster,
} from '../lib/agent/team.js';

const thresholds = thresholdsFromPercent(35);

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'relay-rehydrate-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 在指定记录根建 roster + 可选 profile/checkpoint（名字缺省 = lineage）。 */
function seedPartition(cwd, leadSessionId, seeds) {
  const roster = { version: 1, lineages: {} };
  for (const [lineage, seed] of Object.entries(seeds)) {
    const name = seed.name ?? lineage;
    ensureLineage(roster, lineage, { name, sessionId: seed.sessionId, role: seed.role });
    if (seed.profile !== undefined) {
      const path = profilePathOf(cwd, lineage, leadSessionId);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, seed.profile);
    }
    if (seed.checkpoint !== undefined) {
      const built = buildCheckpointMarkdown({ lineage, name, gen: seed.gen ?? 1, input: { one_line: seed.checkpoint } });
      writeCheckpoint(cwd, lineage, built.markdown, leadSessionId);
    }
  }
  writeRoster(cwd, roster, leadSessionId);
  return roster;
}

/** 递归把记录根内文件 mtime 定为同一时刻（updatedAt 断言用）。 */
function touchFiles(root, iso) {
  const when = new Date(iso);
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else utimesSync(path, when, when);
    }
  };
  walk(root);
}

function fakeCtx(services = {}) {
  const listeners = [];
  const warns = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn(...args) { warns.push(args.join(' ')); } },
    systemPrompt: { section() { return () => {}; } },
    tools: { register() { return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, listeners, warns };
}

function makeAgent({ sessionId = 'session-lead', cwd = '/tmp' } = {}) {
  return {
    session: {
      id: sessionId,
      header: { cwd },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
    },
    inject() {},
  };
}

function membership(role, name, root) {
  return { role, name, root };
}

function makeTeamService({ members = [], memberships = new Map(), spawnResult, sendResult } = {}) {
  const calls = { spawn: [], send: [] };
  return {
    calls,
    tryMembership(agent) { return memberships.get(agent); },
    listMembers() { return members; },
    async spawnTeammate(caller, request) {
      calls.spawn.push(request);
      if (spawnResult !== undefined) return spawnResult(request);
      return { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } };
    },
    async sendMessage(caller, request) { calls.send.push(request); return sendResult ?? { messageId: 'm1' }; },
  };
}

function makeRuntime(ctx) {
  return { ctx, currentThresholds: () => thresholds };
}

function rehydrateToolOf(ctx) {
  const { leadTools } = createTeamTools(makeRuntime(ctx));
  return leadTools.find((tool) => tool.name === 'relay_rehydrate');
}

// ── plan ───────────────────────────────────────────────────────────────

test('plan：默认最新非当前分区（含 legacy）、显式 from、非法/不存在 from、无记录 skip', async () => {
  const dir = tempWorkspace();
  try {
    seedPartition(dir, 'session-old', { impl: { name: 'impl-g1', sessionId: 'old-w1', checkpoint: '旧任务完成 A', profile: '# 实现职责', role: '实现' } });
    seedPartition(dir, 'session-new', { review: { name: 'review-g1', checkpoint: '新任务完成 B' } });
    seedPartition(dir, undefined, { legacy: { name: 'legacy-g1', checkpoint: 'legacy 记录' } });
    touchFiles(teamBaseOf(dir), '2026-10-01T00:00:00.000Z');
    touchFiles(teamRootOf(dir, 'session-old'), '2026-10-02T00:00:00.000Z');
    touchFiles(teamRootOf(dir, 'session-new'), '2026-10-03T00:00:00.000Z');
    const lead = makeAgent({ sessionId: 'session-current', cwd: dir });
    const teams = makeTeamService({ memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const ctx = fakeCtx({ agentTeams: teams });
    const tool = rehydrateToolOf(ctx.ctx);
    const latest = await tool.execute({}, { agent: lead });
    assert.equal(latest.ok, true);
    assert.equal(latest.mode, 'plan');
    assert.equal(latest.from, 'session-new');
    assert.equal(latest.spawnCount, 1);
    assert.deepEqual(latest.lineages.map((item) => item.proposedName), ['review-g1']);
    assert.match(latest.text, /from=session-new/);
    assert.match(latest.text, /spawn=1/);
    const explicit = await tool.execute({ from: 'session-old' }, { agent: lead });
    assert.equal(explicit.from, 'session-old');
    assert.equal(explicit.lineages[0].profileRole, '实现');
    assert.equal(explicit.lineages[0].hasCheckpoint, true);
    const legacy = await tool.execute({ from: LEGACY_PARTITION_ID }, { agent: lead });
    assert.equal(legacy.from, LEGACY_PARTITION_ID);
    assert.equal(legacy.lineages[0].proposedName, 'legacy-g1');
    const missing = await tool.execute({ from: 'session-nope' }, { agent: lead });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'partition-not-found');
    for (const bad of ['../escape', 'a/b', 'a.b']) {
      const result = await tool.execute({ from: bad }, { agent: lead });
      assert.equal(result.ok, false, '非法 from 拒绝: ' + bad);
      assert.equal(result.code, 'partition-not-found');
    }
    // 无记录 lineage → plan action=skip（spawnCount 不计）
    seedPartition(dir, 'session-ghost', { ghost: { name: 'ghost-g1', role: '无记录' } });
    touchFiles(teamRootOf(dir, 'session-ghost'), '2026-10-04T00:00:00.000Z');
    const ghost = await tool.execute({ from: 'session-ghost' }, { agent: lead });
    assert.equal(ghost.ok, true);
    assert.equal(ghost.lineages[0].action, 'skip');
    assert.equal(ghost.spawnCount, 0);
    // 完全没有分区 → 结构化拒绝
    const empty = tempWorkspace();
    try {
      const solo = makeAgent({ sessionId: 'session-current', cwd: empty });
      const emptyTool = rehydrateToolOf(fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[solo, membership('lead', 'lead', solo)]]) }) }).ctx);
      const none = await emptyTool.execute({}, { agent: solo });
      assert.equal(none.ok, false);
      assert.equal(none.code, 'partition-not-found');
    } finally { cleanup(empty); }
  } finally { cleanup(dir); }
});

// ── apply ──────────────────────────────────────────────────────────────

test('apply：spawn 参数含 fromSessionId+checkpoint/profile，写分区 roster/ledger + rehydrate.json', async () => {
  const dir = tempWorkspace();
  try {
    seedPartition(dir, 'session-old', { impl: { name: 'impl-g1', sessionId: 'old-w1', checkpoint: '旧交接：完成 A', profile: '# 实现职责', role: '实现' } });
    const lead = makeAgent({ sessionId: 'session-lead', cwd: dir });
    const teams = makeTeamService({
      members: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    const ctx = fakeCtx({ agentTeams: teams });
    const result = await rehydrateToolOf(ctx.ctx).execute({ from: 'session-old', apply: true }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'apply');
    assert.equal(result.from, 'session-old');
    assert.equal(result.spawned.length, 1);
    assert.equal(result.reused.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(teams.calls.spawn.length, 1);
    const request = teams.calls.spawn[0];
    assert.equal(request.name, 'impl-g1');
    assert.equal(request.context, 'fresh');
    assert.equal(request.provider, 'spawn');
    assert.equal(request.description, '实现');
    const prompt = request.prompt[0].text;
    assert.match(prompt, /旧交接：完成 A/);
    assert.match(prompt, /# 实现职责/);
    assert.match(prompt, /session-old/);
    assert.ok(prompt.includes('team/session-old/impl/'), 'prompt 记录目录指向源分区');
    assert.match(prompt, /session_event_read/);
    assert.match(prompt, /核验 1 个可判定事实/);
    const roster = readRoster(dir, 'session-lead');
    assert.equal(roster.lineages.impl.generations[0].name, 'impl-g1');
    assert.equal(roster.lineages.impl.generations[0].sessionId, 'session-impl-g1');
    assert.ok(rosterPathOf(dir, 'session-lead').length > 0);
    const ledger = readLedger(dir, 'impl', 20, 'session-lead');
    assert.ok(ledger.some((entry) => entry.event === 'rehydrate' && entry.from === 'session-old' && entry.name === 'impl-g1'));
    const metaPath = join(teamRootOf(dir, 'session-lead'), 'rehydrate.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(meta.version, 1);
    assert.equal(meta.from, 'session-old');
    assert.deepEqual(meta.mappings, [{ lineage: 'impl', name: 'impl-g1', action: 'spawn', sessionId: 'session-impl-g1' }]);
    assert.match(result.text, /spawned=1/);
    assert.match(result.text, /session-lead\/rehydrate\.json/);
  } finally { cleanup(dir); }
});

test('apply：当前 Team 已有同名成员 → sendMessage 复用，不 spawn；无记录 lineage → skip', async () => {
  const dir = tempWorkspace();
  try {
    seedPartition(dir, 'session-old', {
      impl: { name: 'impl-g1', checkpoint: '旧交接', profile: '# 实现' },
      ghost: { name: 'ghost-g1', role: '无记录' },
    });
    const lead = makeAgent({ sessionId: 'session-lead', cwd: dir });
    const teams = makeTeamService({
      members: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'existing-w1', name: 'impl-g1', role: 'teammate', status: 'inactive' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    const ctx = fakeCtx({ agentTeams: teams });
    const result = await rehydrateToolOf(ctx.ctx).execute({ from: 'session-old', apply: true }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.spawned.length, 0);
    assert.equal(result.reused.length, 1);
    assert.equal(result.reused[0].name, 'impl-g1');
    assert.equal(result.reused[0].sessionId, 'existing-w1');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].lineage, 'ghost');
    assert.equal(result.failed.length, 0);
    assert.equal(teams.calls.spawn.length, 0, '同名成员不 spawn');
    assert.equal(teams.calls.send.length, 1);
    assert.equal(teams.calls.send[0].target, 'impl-g1');
    const sendText = teams.calls.send[0].content[0].text;
    assert.match(sendText, /session-old/);
    assert.ok(sendText.includes('team/session-old/impl/'), '复用说明带记录分区路径');
    assert.match(sendText, /先核验/);
    const meta = JSON.parse(readFileSync(join(teamRootOf(dir, 'session-lead'), 'rehydrate.json'), 'utf8'));
    assert.deepEqual(meta.mappings, [
      { lineage: 'impl', name: 'impl-g1', action: 'reuse', sessionId: 'existing-w1' },
      { lineage: 'ghost', action: 'skip' },
    ]);
    // 幂等性提示：rehydrate.json 已存在且 from 相同
    const again = await rehydrateToolOf(ctx.ctx).execute({ from: 'session-old', apply: true }, { agent: lead });
    assert.equal(again.ok, true);
    assert.match(again.text, /幂等性有限/);
  } finally { cleanup(dir); }
});

test('apply：spawn 失败不写该 lineage roster，继续其余；返回 failed 但 ok:true', async () => {
  const dir = tempWorkspace();
  try {
    seedPartition(dir, 'session-old', {
      impl: { name: 'impl-g1', checkpoint: 'impl 交接', profile: '# 实现' },
      review: { name: 'review-g1', checkpoint: 'review 交接', profile: '# 审阅' },
    });
    const lead = makeAgent({ sessionId: 'session-lead', cwd: dir });
    const teams = makeTeamService({
      members: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
      spawnResult: (request) => {
        if (request.name === 'impl-g1') throw Object.assign(new Error('Team member limit 8 reached'), { code: 'TEAM_MEMBER_LIMIT' });
        return { member: { id: 'session-review-g1', name: 'review-g1', role: 'teammate', status: 'inactive', diagnostics: [] } };
      },
    });
    const ctx = fakeCtx({ agentTeams: teams });
    const result = await rehydrateToolOf(ctx.ctx).execute({ from: 'session-old', apply: true }, { agent: lead });
    assert.equal(result.ok, true, '部分失败仍返回 ok:true');
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].lineage, 'impl');
    assert.equal(result.failed[0].code, 'member-limit');
    assert.match(String(result.failed[0].error), /member limit/i);
    assert.equal(result.spawned.length, 1);
    assert.equal(result.spawned[0].lineage, 'review');
    const roster = readRoster(dir, 'session-lead');
    assert.deepEqual(Object.keys(roster.lineages), ['review'], '失败 lineage 不写半成品 roster');
    assert.equal(roster.lineages.review.generations[0].sessionId, 'session-review-g1');
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-lead'), [], '失败 lineage 不写 ledger');
    assert.ok(readLedger(dir, 'review', 20, 'session-lead').some((entry) => entry.event === 'rehydrate'));
    assert.match(result.text, /failed=1/);
    assert.match(result.text, /impl:member-limit/);
    const meta = JSON.parse(readFileSync(join(teamRootOf(dir, 'session-lead'), 'rehydrate.json'), 'utf8'));
    assert.equal(meta.mappings.find((item) => item.lineage === 'impl').action, 'failed');
  } finally { cleanup(dir); }
});

test('apply 前置：服务缺失/非 Lead/非法 from 都结构化拒绝且无副作用', async () => {
  const dir = tempWorkspace();
  try {
    seedPartition(dir, 'session-old', { impl: { name: 'impl-g1', checkpoint: '旧交接', profile: '# 实现' } });
    const lead = makeAgent({ sessionId: 'session-lead', cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    // agentTeams 缺失 → services-unavailable
    const noService = await rehydrateToolOf(fakeCtx({}).ctx).execute({ apply: true }, { agent: lead });
    assert.equal(noService.ok, false);
    assert.equal(noService.code, 'services-unavailable');
    // 非 Lead → lead-only
    const teams = makeTeamService({
      members: [],
      memberships: new Map([
        [lead, membership('lead', 'lead', lead)],
        [teammate, membership('teammate', 'impl-g1', lead)],
      ]),
    });
    const tool = rehydrateToolOf(fakeCtx({ agentTeams: teams }).ctx);
    const nonLead = await tool.execute({ from: 'session-old', apply: true }, { agent: teammate });
    assert.equal(nonLead.ok, false);
    assert.equal(nonLead.code, 'lead-only');
    // 非法 from → partition-not-found，且不 spawn
    const invalid = await tool.execute({ from: '../escape', apply: true }, { agent: lead });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'partition-not-found');
    assert.equal(teams.calls.spawn.length, 0);
    assert.equal(teams.calls.send.length, 0);
  } finally { cleanup(dir); }
});

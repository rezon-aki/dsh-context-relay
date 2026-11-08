/**
 * 队友保鲜（v0.3.0 P0 / v0.3.2 分区+真清空）测试：
 * 记录/代际/体检纯逻辑 + workspace 文件 IO + 五工具契约 + reset pre-step 执行器 + agent 装配。
 * 不触网、不真机：fake agentTeams/sessionQuery；文件写到 mkdtemp 临时目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { TEAM_LEAD_PROTOCOL_TEXT, TEAM_WORKER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { clearPendingResets, hasPendingReset } from '../lib/agent/reset.js';
import { clearSentinelMemory, LAST_BAND } from '../lib/agent/sentinel.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import {
  TEAM_LIMITS,
  appendLedger,
  archiveCheckpoint,
  buildCheckpointMarkdown,
  buildRenewPrompt,
  checkpointPathOf,
  classifyHealth,
  ensureLineage,
  genOf,
  handoffPathOf,
  isValidTeammateName,
  ledgerPathOf,
  lineageOf,
  nextGenName,
  partitionRelativePath,
  readCheckpoint,
  readLedger,
  readRoster,
  retireGeneration,
  writeCheckpoint,
  writeRoster,
} from '../lib/agent/team.js';

const LEAD = 'session-lead';
const thresholds = thresholdsFromPercent(35);

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'relay-team-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── 纯逻辑 ─────────────────────────────────────────────────────────────

test('lineage/gen/next 名：<lineage>-g<N>，无后缀视为首代，跳过已占用名字', () => {
  assert.equal(lineageOf('impl'), 'impl');
  assert.equal(lineageOf('impl-g2'), 'impl');
  assert.equal(lineageOf('a-b-g10'), 'a-b');
  assert.equal(genOf('impl'), 1);
  assert.equal(genOf('impl-g2'), 2);
  assert.deepEqual(nextGenName('impl', [], 0), { name: 'impl-g1', gen: 1 });
  assert.deepEqual(nextGenName('impl', ['impl-g1', 'impl-g2'], 1), { name: 'impl-g3', gen: 3 });
  assert.deepEqual(nextGenName('impl', ['impl-g2'], 1), { name: 'impl-g3', gen: 3 });
  assert.equal(isValidTeammateName('impl-g2'), true);
  assert.equal(isValidTeammateName('Impl-2'), false);
  assert.equal(isValidTeammateName('lead'), false);
});

test('buildCheckpointMarkdown：一行结论必填；列表/单条超限裁剪；整份 ≤4KB 标记', () => {
  const empty = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl', gen: 1, input: {} });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'checkpoint-empty');
  const many = Array.from({ length: 12 }, (_, index) => 'done-' + index);
  const built = buildCheckpointMarkdown({
    lineage: 'impl',
    name: 'impl',
    gen: 3,
    input: { one_line: ' 完成登录修复 ', kind: 'phase', done: many, evidence: ['a'.repeat(400)] },
  });
  assert.equal(built.ok, true);
  assert.match(built.markdown, /impl 第 3 代/);
  assert.match(built.markdown, /## 一行结论\n完成登录修复/);
  assert.match(built.markdown, /## 完成/);
  assert.equal(built.caps.items, TEAM_LIMITS.checkpointItems + 1, 'done 截到 8 条 + evidence 1 条');
  assert.equal(built.caps.truncated, true);
  const line = built.markdown.split('\n').find((item) => item.startsWith('- aaa'));
  assert.ok(line.length <= TEAM_LIMITS.checkpointItemChars + 2, '单条 ≤200 字符');
  const huge = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl', gen: 1, input: { one_line: 'x', done: Array.from({ length: 8 }, () => 'y'.repeat(200)), evidence: Array.from({ length: 8 }, () => 'e'.repeat(200)), decisions: Array.from({ length: 8 }, () => 'd'.repeat(200)), constraints: Array.from({ length: 8 }, () => 'c'.repeat(200)) } });
  assert.ok(Buffer.byteLength(huge.markdown, 'utf8') <= TEAM_LIMITS.checkpointBytes, '整份 ≤4096B');
  assert.ok(huge.markdown.includes('[checkpoint truncated'), '超限有截断标记');
});

test('ledger：有界（≤200 条 / ≤8KB），坏行跳过；roster 退役代际', () => {
  const dir = tempWorkspace();
  try {
    for (let index = 0; index < 205; index += 1) appendLedger(dir, 'impl', { event: 'checkpoint', gen: 1, name: 'impl', n: index });
    const entries = readLedger(dir, 'impl', 500);
    assert.ok(entries.length <= TEAM_LIMITS.ledgerEntries && entries.length > 1, '条数 ≤200 且仍有历史');
    assert.equal(entries[entries.length - 1].n, 204);
    assert.ok(entries[0].n > 0, '按字节上限淘汰最旧');
    assert.ok(Buffer.byteLength(readFileSync(ledgerPathOf(dir, 'impl'), 'utf8'), 'utf8') <= TEAM_LIMITS.ledgerBytes);
    const roster = { version: 1, lineages: {} };
    const entry = ensureLineage(roster, 'impl', { name: 'impl-g1', sessionId: 's1' });
    ensureLineage(roster, 'impl', { name: 'impl-g2', sessionId: 's2' });
    assert.equal(retireGeneration(entry, 'impl-g1', 'band'), true);
    assert.equal(entry.generations[0].retiredAt === undefined, false);
    assert.equal(entry.generations[0].reason, 'band');
    writeRoster(dir, roster);
    const reread = readRoster(dir);
    assert.equal(reread.lineages.impl.generations.length, 2);
    assert.equal(reread.lineages.impl.activeGen, 2);
  } finally { cleanup(dir); }
});

test('checkpoint 文件：写/读/换代归档；buildRenewPrompt 含 profile+交接+召回且 ≤6KB', () => {
  const dir = tempWorkspace();
  try {
    const built = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: '完成 A', decisions: ['选 B 因为 C'], next_actions: ['跑测试'] } });
    writeCheckpoint(dir, 'impl', built.markdown);
    const read = readCheckpoint(dir, 'impl');
    assert.ok(read !== undefined);
    assert.equal(read.bytes, built.caps.bytes);
    const prompt = buildRenewPrompt({ lineage: 'impl', newName: 'impl-g2', gen: 2, prevName: 'impl-g1', profile: '# 职责\n实现登录', checkpoint: read.text, ledger: [{ gen: 1, name: 'impl-g1', sessionId: 's1' }], leadSessionId: 'session-lead' });
    assert.match(prompt, /impl-g2/);
    assert.match(prompt, /team\/session-lead\/impl\//, 'renew prompt 记录目录带 Lead 分区');
    const legacyPrompt = buildRenewPrompt({ lineage: 'impl', newName: 'impl-g2', gen: 2, prevName: 'impl-g1', profile: '# 职责', checkpoint: '# 旧交接', ledger: [], leadSessionId: 'session-lead', recordDir: '.scratch/context-relay/team/impl' });
    assert.match(legacyPrompt, /team\/impl\/（profile/, 'legacy-only 记录时按实际记录目录给指针');
    assert.doesNotMatch(legacyPrompt, /team\/session-lead\/impl\/（profile/, '不指向不存在的分区记录目录');
    assert.match(prompt, /实现登录/);
    assert.match(prompt, /选 B 因为 C/);
    assert.match(prompt, /session_event_read/);
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= TEAM_LIMITS.promptBytes);
    const archived = archiveCheckpoint(dir, 'impl', 1);
    assert.ok(archived !== undefined);
    assert.ok(existsSync(handoffPathOf(dir, 'impl', 1)));
    assert.equal(existsSync(checkpointPathOf(dir, 'impl')), false);
  } finally { cleanup(dir); }
});

test('classifyHealth：fresh/watch/stale/spent/unknown 与建议动作', () => {
  assert.equal(classifyHealth({ band: 'ok' }).health, 'fresh');
  assert.equal(classifyHealth({ band: 'warn' }).health, 'watch');
  assert.equal(classifyHealth({ band: 'organize' }, true).health, 'stale');
  assert.equal(classifyHealth({ band: 'relay' }, false).health, 'spent');
  assert.equal(classifyHealth({ band: 'unknown' }).health, 'unknown');
  assert.match(classifyHealth({ band: 'organize' }, true).action, /relay_freshen\(\{reset:true/);
  assert.match(classifyHealth({ band: 'organize' }, true).action, /仅换身份/);
  assert.doesNotMatch(classifyHealth({ band: 'organize' }, true).action, /先换新/);
  assert.match(classifyHealth({ band: 'organize' }, false).action, /relay_checkpoint/);
});

// ── 工具契约（fake ctx） ───────────────────────────────────────────────

function fakeCtx(services = {}) {
  const sections = [];
  const tools = new Map();
  const listeners = [];
  const warns = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn(...args) { warns.push(args.join(' ')); } },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, sections, tools, listeners, warns };
}

function agentScopeRecorder(calls, sections) {
  return {
    inject(services, callback) {
      if (services.length === 1 && services[0] === 'tools') {
        callback({ tools: { register(definition) { calls.push(definition.name); return () => {}; }, restrict() { return () => {}; } } });
        return { dispose() {} };
      }
      if (services.length === 1 && services[0] === 'systemPrompt') {
        callback({ systemPrompt: { section(definition) { sections.push(definition); return () => {}; } } });
        return { dispose() {} };
      }
      throw new Error('unexpected inject: ' + JSON.stringify(services));
    },
  };
}

function makeAgent({ sessionId = 'session-lead', cwd = '/tmp', header = {}, calls, sections } = {}) {
  const injected = [];
  return {
    session: {
      id: sessionId,
      header: { cwd, ...header },
      seq: 0,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
      snapshotEvents: () => [],
    },
    ctx: agentScopeRecorder(calls ?? [], sections ?? []),
    inject(message) { injected.push(message); },
    injected,
  };
}

/** 给 fake agent 的 session 装上真清空所需的 surface/append（模拟 DSH 会话）。 */
function withSurface(agent, { nodes = [1, 2, 3], failAppend } = {}) {
  const calls = [];
  const surface = { nodes: [...nodes] };
  agent.session.surface = surface;
  agent.session.eventAt = (seq) => ({ seq });
  agent.session.deriveEventMessage = (event) => ({ role: event.seq === nodes[0] ? 'system' : 'assistant' });
  agent.session.append = (type, data, opts) => {
    calls.push({ type, data, opts });
    if (failAppend !== undefined) throw new Error(failAppend);
    const replacement = Math.max(0, ...surface.nodes) + 1;
    surface.nodes = surface.nodes.filter((seq) => seq < opts.surfaceOp.startSeq || seq > opts.surfaceOp.endSeq).concat(replacement);
    return { seq: replacement };
  };
  return calls;
}

function membership(role, name, root) {
  return { role, name, root };
}

function fakePressure(used, window = 100000) {
  return {
    snapshot() { return { values: { contextPressure: { projectedTokens: used, contextWindow: window } } }; },
  };
}

function makeTeamService({ members = [], memberships = new Map(), spawnResult, sendResult } = {}) {
  const calls = { spawn: [], send: [], interrupt: [] };
  return {
    calls,
    tryMembership(agent) { return memberships.get(agent); },
    listMembers() { return members; },
    async spawnTeammate(caller, request) {
      calls.spawn.push(request);
      return spawnResult === undefined ? { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } } : spawnResult(request);
    },
    async sendMessage(caller, request) { calls.send.push(request); return sendResult ?? { messageId: 'm1' }; },
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

function makeRuntime(ctx) {
  return { ctx, currentThresholds: () => thresholds };
}

function findPreStepListener(ctx) {
  return ctx.listeners.find((entry) => entry.name === 'agent/pre-step')?.listener;
}

// ── 工具契约 ───────────────────────────────────────────────────────────

test('relay_checkpoint：队友写记录到 <leadSessionId>/ 分区（文件+ledger+roster），非队友拒绝', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const teams = makeTeamService({ memberships: new Map([
      [teammate, membership('teammate', 'impl-g1', lead)],
      [lead, membership('lead', 'lead', lead)],
    ]) });
    const ctx = fakeCtx({ agentTeams: teams });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    const checkpointTool = teammateTools.find((tool) => tool.name === 'relay_checkpoint');
    const refused = await checkpointTool.execute({ one_line: 'x' }, { agent: lead });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'teammate-only');
    const result = await checkpointTool.execute({ one_line: '完成登录修复', done: ['改 a.js'], kind: 'task', task_id: 'task-1' }, { agent: teammate });
    assert.equal(result.ok, true);
    assert.equal(result.path, checkpointPathOf(dir, 'impl', LEAD));
    assert.match(result.path, new RegExp('team/' + LEAD + '/impl/checkpoint\\.md$'));
    assert.ok(existsSync(result.path));
    assert.match(readFileSync(result.path, 'utf8'), /完成登录修复/);
    assert.equal(readLedger(dir, 'impl', 20, LEAD).length, 1);
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-other'), [], '别的不相关分区读不到（legacy 回退也空）');
    const roster = readRoster(dir, LEAD);
    assert.equal(roster.lineages.impl.generations[0].name, 'impl-g1');
    assert.equal(roster.lineages.impl.generations[0].sessionId, 'session-w1');
    assert.ok(existsSync(join(dir, '.scratch', 'context-relay', 'team', LEAD, 'roster.json')));
    assert.equal(existsSync(join(dir, '.scratch', 'context-relay', 'team', 'roster.json')), false, '不写 legacy 根');
  } finally { cleanup(dir); }
});

test('relay_team_status：Lead 读团队健康（records 根 + stale/spent 动作），队友拒绝', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-w1', name: 'impl-g1', role: 'teammate', status: 'inactive', description: '实现' },
        { id: 'session-w2', name: 'review-g1', role: 'teammate', status: 'inactive', description: '审阅' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)], [teammate, membership('teammate', 'impl-g1', lead)]]),
    });
    const ctx = fakeCtx({ agentTeams: teams, sessionQuery: pressureQuery({ 'session-w1': 36000, 'session-w2': 40000 }) });
    const { leadTools } = createTeamTools(makeRuntime(ctx.ctx));
    const statusTool = leadTools.find((tool) => tool.name === 'relay_team_status');
    const nonLead = await statusTool.execute({}, { agent: teammate });
    assert.equal(nonLead.ok, false);
    assert.equal(nonLead.code, 'lead-only');
    const roster = { version: 1, lineages: {} };
    ensureLineage(roster, 'impl', { name: 'impl-g1', sessionId: 'session-w1' });
    writeRoster(dir, roster, LEAD);
    const built = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: 'wip' } });
    writeCheckpoint(dir, 'impl', built.markdown, LEAD);
    const report = await statusTool.execute({}, { agent: lead });
    assert.equal(report.ok, true);
    assert.equal(report.team.length, 2);
    const impl = report.team.find((row) => row.name === 'impl-g1');
    const review = report.team.find((row) => row.name === 'review-g1');
    assert.equal(impl.gen, 1);
    assert.equal(impl.health, 'stale');
    assert.equal(review.health, 'spent');
    assert.deepEqual(report.stale.sort(), ['impl-g1', 'review-g1']);
    assert.match(report.text, /records=\.scratch\/context-relay\/team\/session-lead\//);
    assert.match(report.text, /stale → 边界 reset 复用（真清空，0 额度）；仅换身份才 renew/);
    assert.match(report.text, /spent → 先 checkpoint 再 reset 复用（0 额度）；仅换身份才 renew/);
    assert.match(impl.action, /relay_freshen\(\{reset:true/, '结构化 action 也 reset-first');
    assert.doesNotMatch(impl.action, /relay_renew）|先换新/);
    assert.ok(report.text.length <= 2000, '团队报告有界');
  } finally { cleanup(dir); }
});

test('relay_renew：无 checkpoint 先催（pending）；有记录则换代（分区交接/roster/ledger + 展示路径）', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-w1', name: 'impl-g1', role: 'teammate', status: 'inactive', description: '实现' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    const ctx = fakeCtx({ agentTeams: teams });
    const { leadTools } = createTeamTools(makeRuntime(ctx.ctx));
    const renew = leadTools.find((tool) => tool.name === 'relay_renew');
    const pending = await renew.execute({ name: 'impl-g1' }, { agent: lead });
    assert.equal(pending.ok, false);
    assert.equal(pending.code, 'checkpoint-missing');
    assert.equal(pending.requested, true);
    assert.equal(teams.calls.send.length, 1);
    assert.match(teams.calls.send[0].content[0].text, /relay_checkpoint/);
    // 队友写好记录（同分区）
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const writeCtx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }) });
    const { teammateTools } = createTeamTools(makeRuntime(writeCtx.ctx));
    await teammateTools[0].execute({ one_line: '登录修复完成', decisions: ['不改鉴权'] }, { agent: teammate });
    const result = await renew.execute({ name: 'impl-g1', reason: 'band=organize' }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.previous.name, 'impl-g1');
    assert.equal(result.next.name, 'impl-g2');
    assert.equal(teams.calls.spawn.length, 1);
    assert.equal(teams.calls.spawn[0].name, 'impl-g2');
    assert.equal(teams.calls.spawn[0].context, 'fresh');
    assert.equal(teams.calls.spawn[0].provider, 'spawn');
    assert.match(teams.calls.spawn[0].prompt[0].text, /登录修复完成/);
    assert.match(teams.calls.spawn[0].prompt[0].text, /不改鉴权/);
    assert.ok(existsSync(handoffPathOf(dir, 'impl', 1, LEAD)));
    assert.equal(existsSync(checkpointPathOf(dir, 'impl', LEAD)), false);
    assert.match(result.text, /team\/session-lead\/impl\/handoffs\/gen-1\.md/, 'handoff 展示路径带分区');
    const roster = readRoster(dir, LEAD);
    assert.equal(roster.lineages.impl.generations.find((item) => item.name === 'impl-g1').retiredAt !== undefined, true);
    assert.equal(roster.lineages.impl.generations.find((item) => item.name === 'impl-g2').sessionId, 'session-impl-g2');
    assert.equal(roster.lineages.impl.activeGen, 2);
    assert.ok(readLedger(dir, 'impl', 20, LEAD).some((entry) => entry.event === 'renew'));
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-other'), [], '不串到别的分区');
    const again = await renew.execute({ name: 'impl-g1' }, { agent: lead });
    assert.equal(again.code, 'already-retired', '已退役代际不允许再次换代');
  } finally { cleanup(dir); }
});

test('relay_renew：成员额度满（TEAM_MEMBER_LIMIT）→ member-limit + reset/freshen/接力指引，旧代不退役', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-w1', name: 'impl-g1', role: 'teammate', status: 'inactive', description: '实现' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
      spawnResult: () => { throw Object.assign(new Error('Team member limit 8 reached'), { code: 'TEAM_MEMBER_LIMIT' }); },
    });
    const ctx = fakeCtx({ agentTeams: teams });
    const { leadTools } = createTeamTools(makeRuntime(ctx.ctx));
    const renew = leadTools.find((tool) => tool.name === 'relay_renew');
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const writeCtx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }) });
    const { teammateTools } = createTeamTools(makeRuntime(writeCtx.ctx));
    await teammateTools[0].execute({ one_line: '完成' }, { agent: teammate });
    const result = await renew.execute({ name: 'impl-g1' }, { agent: lead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'member-limit');
    assert.equal(result.memberLimit, true);
    assert.doesNotMatch(result.summary, /maxMembers/, '用户裁决不改部署上限，文案不再建议调高');
    assert.match(result.summary, /relay_freshen\(\{reset:true/);
    assert.match(result.summary, /relay_handoff/);
    assert.match(result.summary, /relay_rehydrate/);
    const roster = readRoster(dir, LEAD);
    assert.equal(roster.lineages.impl.generations.find((item) => item.name === 'impl-g1').retiredAt, undefined, '旧代不退役');
    assert.equal(teams.calls.spawn.length, 1);
  } finally { cleanup(dir); }
});

test('relay_renew：running 旧代先 interrupt；目标不存在/非 Lead 结构化拒绝', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-w1', name: 'impl-g1', role: 'teammate', status: 'running', description: '实现' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)], [teammate, membership('teammate', 'impl-x', lead)]]),
    });
    const ctx = fakeCtx({ agentTeams: teams });
    const { leadTools } = createTeamTools(makeRuntime(ctx.ctx));
    const renew = leadTools.find((tool) => tool.name === 'relay_renew');
    // 准备 checkpoint（同分区）
    const writeTeams = makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) });
    const writeCtx = fakeCtx({ agentTeams: writeTeams });
    await createTeamTools(makeRuntime(writeCtx.ctx)).teammateTools[0].execute({ one_line: 'done' }, { agent: teammate });
    const result = await renew.execute({ name: 'impl-g1' }, { agent: lead });
    assert.equal(result.ok, true);
    assert.deepEqual(teams.calls.interrupt, ['impl-g1']);
    const missing = await renew.execute({ name: 'nope' }, { agent: lead });
    assert.equal(missing.code, 'not-found');
    const refused = await renew.execute({ name: 'impl-g1' }, { agent: teammate });
    assert.equal(refused.code, 'lead-only');
  } finally { cleanup(dir); }
});

test('relay_freshen：Lead 拒绝/低 band 拒绝；官方压缩 + brief 注入 + 分区 chain/ledger；同代上限 2 次', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const low = makeAgent({ sessionId: 'session-w2', cwd: dir });
    // A+B：历史上被压缩遮蔽的附加 AGENTS.md / 已加载 skill 应进入压缩后注入的手动召回段。
    teammate.session.snapshotEvents = () => [
      { seq: 1, type: 'user/message', data: { source: { kind: 'agent-instructions', form: 'instructions', baseline: false, changes: [{ action: 'set', scope: 'pkg', path: 'pkg/AGENTS.md' }] }, content: [] } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'skill-invocation', form: 'instructions', name: 'code-review' }, content: [] } },
    ];
    const memberships = new Map([
      [teammate, membership('teammate', 'impl-g1', lead)],
      [low, membership('teammate', 'review-g1', lead)],
    ]);
    const engineCalls = [];
    const engine = { async compactIfNeeded(agentCtx, trigger) { engineCalls.push({ trigger, agentCtx }); return { shadowedSeqs: [3, 9], shadowedTokenCount: 1500, compactionId: 'c1' }; } };
    const projections = {
      snapshot(session) {
        const used = session.id === 'session-w2' ? 10000 : 45000;
        return { values: { contextPressure: { projectedTokens: used, contextWindow: 100000 } } };
      },
    };
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships }), sessionProjections: projections, compaction: engine });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    const freshen = teammateTools.find((tool) => tool.name === 'relay_freshen');
    const refused = await freshen.execute({}, { agent: lead });
    assert.equal(refused.code, 'teammate-only');
    const below = await freshen.execute({}, { agent: low });
    assert.equal(below.code, 'below-threshold');
    const ok = await freshen.execute({ phase: 'build', brief: '决定 A\n证据 b:1' }, { agent: teammate, signal: new AbortController().signal });
    assert.equal(ok.ok, true);
    assert.equal(ok.organized, true);
    assert.equal(ok.freedTokens, 1500);
    assert.equal(ok.briefInjected, true);
    assert.equal(ok.manualRecallInjected, true, '手动召回（A+B）随 brief 注入');
    assert.match(ok.briefPath, new RegExp('team/' + LEAD + '/impl/freshen-'));
    assert.ok(existsSync(ok.briefPath));
    const brief = readFileSync(ok.briefPath, 'utf8');
    assert.match(brief, /Phase Brief · build/);
    assert.match(brief, /决定 A/);
    assert.match(brief, /链式召回/);
    assert.match(brief, /压缩后手动召回/, 'brief 文件同样保留手动召回段');
    assert.match(brief, /pkg\/AGENTS\.md/);
    assert.match(brief, /code-review/);
    assert.equal(engineCalls.length, 1);
    assert.equal(engineCalls[0].trigger, 'context-overflow');
    assert.ok(teammate.injected.length >= 1, '压缩后 brief 注入下一 step');
    assert.match(String(teammate.injected[0]?.content?.[0]?.text ?? ''), /队友 freshen/);
    assert.match(String(teammate.injected[0]?.content?.[0]?.text ?? ''), /压缩后手动召回/);
    assert.match(String(teammate.injected[0]?.content?.[0]?.text ?? ''), /pkg\/AGENTS\.md/);
    assert.match(readFileSync(join(dir, '.scratch', 'context-relay', 'chain.ndjson'), 'utf8'), /teammate-freshen/);
    assert.ok(readLedger(dir, 'impl', 20, LEAD).some((entry) => entry.event === 'freshen' && entry.name === 'impl-g1'));
    const second = await freshen.execute({ phase: 'verify', brief: '第二轮' }, { agent: teammate, force: true });
    assert.equal(second.ok, true);
    assert.equal(second.freshenCount, 2);
    assert.equal(engineCalls.length, 2);
    const third = await freshen.execute({}, { agent: teammate, force: true });
    assert.equal(third.code, 'already-freshened');
    // reset 模式：真清空排队（不调压缩、不计入同代 freshen 次数、低于 organize 也允许）
    const resetOk = await freshen.execute({ reset: true, phase: 'build', brief: '新任务：巡检告警' }, { agent: low });
    assert.equal(resetOk.ok, true, 'reset 允许低于 organize');
    assert.equal(resetOk.mode, 'wipe-scheduled');
    assert.equal(resetOk.scheduled, true);
    assert.match(resetOk.text, /真清空/);
    assert.equal(engineCalls.length, 2, 'reset 不调压缩服务');
    assert.equal(hasPendingReset('session-w2'), true);
    assert.match(resetOk.briefPath, new RegExp('team/' + LEAD + '/review/freshen-\\d+-reset\\.md$'));
    const resetBrief = readFileSync(resetOk.briefPath, 'utf8');
    assert.match(resetBrief, /\[context-relay\] 上下文真清空\(reset\)·build/);
    assert.match(resetBrief, /旧任务已归档：会话 session-w2/);
    assert.match(resetBrief, /session_event_read 读 shadowed/);
    assert.match(resetBrief, /team\/session-lead\/review\/checkpoint\.md/);
    assert.match(resetBrief, /新任务：巡检告警/);
    assert.match(resetBrief, /按新任务执行/);
    assert.match(resetBrief, /不引用旧任务/);
    assert.deepEqual(readLedger(dir, 'review', 20, LEAD), [], 'reset 只排队，pre-step 才记账');
    // reset 不占同代 freshen 次数：同一成员仍可正常 freshen
    const afterReset = await freshen.execute({ phase: 'build', brief: '新任务进行中', force: true }, { agent: low });
    assert.equal(afterReset.ok, true);
    assert.equal(afterReset.freshenCount, 1);
    assert.equal(engineCalls.length, 3);
    assert.equal(hasPendingReset('session-w2'), true, 'pending 仍在，等下一次 pre-step');
  } finally {
    clearPendingResets();
    cleanup(dir);
  }
});

test('relay_freshen reset：legacy-only checkpoint 的 brief 指向真实 legacy 路径（不造假分区路径）', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    // legacy 记录：不带 leadSessionId → .scratch/context-relay/team/<lineage>/checkpoint.md
    const built = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: '旧任务已完成' } });
    writeCheckpoint(dir, 'impl', built.markdown);
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }) });
    const freshen = createTeamTools(makeRuntime(ctx.ctx)).teammateTools.find((tool) => tool.name === 'relay_freshen');
    const scheduled = await freshen.execute({ reset: true, phase: 'build', brief: '新任务：巡检' }, { agent: teammate });
    assert.equal(scheduled.ok, true);
    assert.equal(scheduled.mode, 'wipe-scheduled');
    const brief = readFileSync(scheduled.briefPath, 'utf8');
    assert.match(brief, /team\/impl\/checkpoint\.md/, 'legacy 回退时 brief 用实际 legacy 路径');
    assert.doesNotMatch(brief, new RegExp('team/' + LEAD + '/impl/checkpoint\\.md'), '不指向不存在的分区文件');
  } finally {
    clearPendingResets();
    cleanup(dir);
  }
});

test('relay_freshen：压缩引擎缺失/失败结构化降级，不注入', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const teams = () => makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) });
    const ctx = fakeCtx({ agentTeams: teams(), sessionProjections: fakePressure(45000) });
    const unavailable = await createTeamTools(makeRuntime(ctx.ctx)).teammateTools.find((tool) => tool.name === 'relay_freshen').execute({}, { agent: teammate });
    assert.equal(unavailable.code, 'compaction-unavailable');
    const failing = { async compactIfNeeded() { const error = new Error('busy'); error.code = 'busy'; throw error; } };
    const ctx2 = fakeCtx({ agentTeams: teams(), sessionProjections: fakePressure(45000), compaction: failing });
    const busy = await createTeamTools(makeRuntime(ctx2.ctx)).teammateTools.find((tool) => tool.name === 'relay_freshen').execute({}, { agent: teammate });
    assert.equal(busy.code, 'compaction-busy');
    assert.equal(busy.briefInjected, false);
  } finally { cleanup(dir); }
});

// ── reset pre-step 执行器 ──────────────────────────────────────────────

test('pre-step：consume pending → 真清空 surface + ledger reset + chain + LAST_BAND；只消费一次', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  clearSentinelMemory();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const calls = withSurface(teammate, { nodes: [4, 9, 15] });
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }) });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    const freshen = teammateTools.find((tool) => tool.name === 'relay_freshen');
    const scheduled = await freshen.execute({ reset: true, phase: 'build', brief: '新任务：修复 X' }, { agent: teammate });
    assert.equal(scheduled.mode, 'wipe-scheduled');
    const listener = findPreStepListener(ctx);
    assert.equal(typeof listener, 'function', 'createTeamTools 注册 pre-step 执行器');
    let nextCalls = 0;
    const next = async () => { nextCalls += 1; return { messages: [] }; };
    await listener({ agent: teammate, signal: new AbortController().signal }, next);
    assert.equal(nextCalls, 1, '执行器必须继续 next()');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'user/message');
    assert.deepEqual(calls[0].opts.surfaceOp, { op: 'replace', startSeq: 9, endSeq: 15 });
    assert.deepEqual(calls[0].opts.sourceEventSeqs, [9, 15]);
    assert.match(calls[0].data.content[0].text, /上下文真清空\(reset\)·build/);
    assert.match(calls[0].data.content[0].text, /已遮蔽 surface seq 9–15（2 节点）/);
    assert.match(readFileSync(scheduled.briefPath, 'utf8'), /已遮蔽 surface seq 9–15/);
    assert.equal(hasPendingReset('session-w1'), false);
    const entries = readLedger(dir, 'impl', 20, LEAD);
    const reset = entries.find((entry) => entry.event === 'reset');
    assert.ok(reset !== undefined, 'reset 记账到本 Team 分区');
    assert.equal(reset.name, 'impl-g1');
    assert.equal(reset.gen, 1);
    assert.equal(reset.phase, 'build');
    assert.equal(reset.sessionId, 'session-w1');
    assert.equal(reset.shadowedStart, 9);
    assert.equal(reset.shadowedEnd, 15);
    assert.equal(reset.shadowedNodes, 2);
    assert.match(reset.brief, /team\/session-lead\/impl\/freshen-\d+-reset\.md/);
    assert.match(reset.checkpoint, /team\/session-lead\/impl\/checkpoint\.md/);
    assert.match(readFileSync(join(dir, '.scratch', 'context-relay', 'chain.ndjson'), 'utf8'), /reset=true/);
    assert.equal(LAST_BAND.get('session-w1')?.band, 'ok');
    // 第二次 pre-step：无 pending，不再 append
    await listener({ agent: teammate, signal: new AbortController().signal }, next);
    assert.equal(nextCalls, 2);
    assert.equal(calls.length, 1);
  } finally {
    clearPendingResets();
    cleanup(dir);
  }
});

test('pre-step：wipe 失败回退官方压缩 + brief 注入，ledger 记 fallback，绝不 throw', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  clearSentinelMemory();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    withSurface(teammate, { nodes: [1, 2], failAppend: 'surface replacement rejected' });
    const engineCalls = [];
    const engine = { async compactIfNeeded(agentCtx, trigger) { engineCalls.push({ trigger, agentCtx }); return { shadowedSeqs: [2], shadowedTokenCount: 500, compactionId: 'c9' }; } };
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }), compaction: engine });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    await teammateTools.find((tool) => tool.name === 'relay_freshen').execute({ reset: true, phase: 'verify', brief: '新任务：复核 Y' }, { agent: teammate });
    const listener = findPreStepListener(ctx);
    let nextCalls = 0;
    await assert.doesNotReject(async () => listener({ agent: teammate, signal: new AbortController().signal }, async () => { nextCalls += 1; }));
    assert.equal(nextCalls, 1);
    assert.equal(engineCalls.length, 1);
    assert.equal(engineCalls[0].trigger, 'context-overflow');
    assert.equal(teammate.injected.length, 1);
    assert.match(String(teammate.injected[0]?.content?.[0]?.text ?? ''), /reset 回退/);
    const fallback = readLedger(dir, 'impl', 20, LEAD).find((entry) => entry.event === 'freshen');
    assert.ok(fallback !== undefined, '回退按 freshen 记账（有损压缩算入同代次数）');
    assert.equal(fallback.reset, true);
    assert.match(String(fallback.fallback), /surface replacement rejected/);
    assert.equal(hasPendingReset('session-w1'), false);
  } finally {
    clearPendingResets();
    cleanup(dir);
  }
});

test('pre-step：wipe 失败且压缩无进展 → ledger 记 reset-failed，不置 LAST_BAND ok', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  clearSentinelMemory();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    withSurface(teammate, { nodes: [1, 2], failAppend: 'surface replacement rejected' });
    const engine = { async compactIfNeeded() { return null; } };
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }), compaction: engine });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    await teammateTools.find((tool) => tool.name === 'relay_freshen').execute({ reset: true, phase: 'verify', brief: '新任务' }, { agent: teammate });
    const listener = findPreStepListener(ctx);
    await assert.doesNotReject(async () => listener({ agent: teammate, signal: new AbortController().signal }, async () => {}));
    const entries = readLedger(dir, 'impl', 20, LEAD);
    const failed = entries.find((entry) => entry.event === 'reset-failed');
    assert.ok(failed !== undefined, '无可压缩历史时如实记 reset-failed');
    assert.match(String(failed.reason), /surface replacement rejected/);
    assert.equal(LAST_BAND.get('session-w1')?.band, undefined, '未真正降载就不标 ok');
  } finally {
    clearPendingResets();
    cleanup(dir);
  }
});

test('pre-step：无 pending 时直接 next()，不做任何 IO', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    withSurface(teammate);
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }) });
    createTeamTools(makeRuntime(ctx.ctx));
    const listener = findPreStepListener(ctx);
    let nextCalls = 0;
    await listener({ agent: teammate }, async () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal(existsSync(join(dir, '.scratch')), false, '无 pending 不落盘');
  } finally { cleanup(dir); }
});

// ── agent 装配 ────────────────────────────────────────────────────────

test('装配：routerMode 下 root 注册 status/renew/rehydrate + 注入 team-lead 段；队友注册 checkpoint/freshen + 注入 team-worker 段；classic 不注册', async () => {
  // root
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  const listener = f.listeners.find((entry) => entry.name === 'agent/created');
  assert.ok(listener !== undefined);
  const rootCalls = [];
  const rootSections = [];
  await listener.listener({ agent: makeAgent({ calls: rootCalls, sections: rootSections }) });
  assert.deepEqual(rootCalls, ['relay_team_status', 'relay_renew', 'relay_rehydrate'], 'root 拿到 Lead 保鲜/重建工具');
  assert.ok(rootSections.some((section) => section.name === 'context-relay:team-lead' && section.text === TEAM_LEAD_PROTOCOL_TEXT));
  // teammate
  const teammateCalls = [];
  const teammateSections = [];
  const teammate = makeAgent({ sessionId: 'session-w1', header: { origin: 'subagent', delegationDepth: 1 }, calls: teammateCalls, sections: teammateSections });
  const g = fakeCtx({ agentTeams: { tryMembership: (agent) => (agent === teammate ? { role: 'teammate', name: 'impl-g1' } : undefined) } });
  apply(g.ctx, { routerMode: true });
  await g.listeners.find((entry) => entry.name === 'agent/created').listener({ agent: teammate });
  assert.deepEqual(teammateCalls, ['relay_checkpoint', 'relay_freshen'], '队友拿到 checkpoint + freshen 工具');
  assert.ok(teammateSections.some((section) => section.name === 'context-relay:team-worker' && section.text === TEAM_WORKER_PROTOCOL_TEXT));
  assert.ok(!teammateCalls.includes('relay_team_status'), '队友不拿 Lead 工具');
  // classic：不注册、不注入
  const c = fakeCtx();
  apply(c.ctx, {});
  const classicCalls = [];
  const classicSections = [];
  await c.listeners.find((entry) => entry.name === 'agent/created').listener({ agent: makeAgent({ calls: classicCalls, sections: classicSections }) });
  assert.deepEqual(classicCalls, []);
  assert.ok(!classicSections.some((section) => String(section.name).startsWith('context-relay:team')));
});

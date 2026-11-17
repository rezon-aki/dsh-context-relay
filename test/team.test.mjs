/**
 * 队友保鲜（v0.3.0 P0 / v0.3.2 分区+真清空）测试：
 * 记录/代际/体检纯逻辑 + workspace 文件 IO + 五工具契约 + reset pre-step 执行器 + agent 装配。
 * 不触网、不真机：fake agentTeams/sessionQuery；文件写到 mkdtemp 临时目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearTeamStatusMemory, createTeamTools } from '../lib/agent/team-tools.js';
import { TEAM_LEAD_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { clearPendingResets, hasPendingReset } from '../lib/agent/reset.js';
import { clearSentinelMemory, dispatchNeedOf, LAST_BAND } from '../lib/agent/sentinel.js';
import { DISPATCH_HEALTHS, clearDelegationMemory, createDelegationTools, delegationMemoryState, dispatchHealthOf } from '../lib/agent/delegation-tools.js';
import { DELEGATION_DISPATCH_DIR, dispatchRecordPathOf, receiptFreshnessOf } from '../lib/agent/delegation.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { readTeamContext } from '../lib/agent/team-context.js';
import { clearSharedMemory, consumePendingBudgetInherit, markPendingArchitect } from '../lib/agent/shared.js';
import { COLLECT_OK_PREFIX, DISPATCH_OK_PREFIX } from '../lib/projection.js';
import { subagentsFromLegacy } from './team-fixture.mjs';
import { thresholdsFromPercent } from '../lib/policy.js';
import { configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';
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
  ledgerArchivePathOf,
  ledgerPathOf,
  lineageOf,
  nextGenName,
  partitionRelativePath,
  readCheckpoint,
  readLedger,
  readLedgerArchive,
  readRoster,
  renderCheckpointForPrompt,
  retireGeneration,
  writeCheckpoint,
  writeRoster,
} from '../lib/agent/team.js';

const LEAD = 'session-lead';
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
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
  assert.equal(isValidTeammateName('2impl'), false, 'rc.2 要求字母开头');
  assert.equal(isValidTeammateName('a'.repeat(32)), true, 'rc.2 上限 32');
  assert.equal(isValidTeammateName('a'.repeat(33)), false, '超过 32 必须提前拒绝');
  assert.equal(isValidTeammateName('a'.repeat(30) + '-g2'), false, '长 lineage 的后代名超过 32');
});

test('buildCheckpointMarkdown：一行结论必填；写盘完整（不截断/不丢条目）；prompt 渲染有界+指针', async () => {
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
  assert.equal(built.caps.items, 13, '不丢条目：12 done + 1 evidence 全部写入');
  assert.equal(built.caps.truncated, false, '写盘不截断（truncated 仅保留兼容字段）');
  for (const item of many) assert.ok(built.markdown.includes('- ' + item), '每条都在：' + item);
  assert.ok(built.markdown.includes('a'.repeat(400)), '单条不再裁到 200 字符');
  assert.equal(built.full, built.markdown);
  assert.equal(renderCheckpointForPrompt(''), '');
  // 落盘完整：writeCheckpoint 原样写 full（不再生成截断版）
  const dir = tempWorkspace();
  try {
    const written = await writeCheckpoint(dir, 'impl', built.markdown);
    const read = readCheckpoint(dir, 'impl');
    assert.equal(read.text, built.full, '文件内容 = 完整 markdown');
    assert.equal(read.bytes, written.bytes);
  } finally { cleanup(dir); }
  // 超建议体积：markdown(full) 完整；promptText 有界 + 指针 + 显式 marker（高优先级段保留）
  const huge = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl', gen: 1, input: {
    one_line: 'x',
    done: Array.from({ length: 8 }, (_, index) => 'DONE-' + index + '-' + 'd'.repeat(190)),
    decisions: Array.from({ length: 8 }, (_, index) => '决策-' + index + '-' + 'm'.repeat(190)),
    evidence: Array.from({ length: 8 }, (_, index) => '证据-' + index + '-' + 'e'.repeat(190)),
    constraints: Array.from({ length: 8 }, (_, index) => '约束-' + index + '-' + 'c'.repeat(190)),
  } });
  assert.ok(huge.caps.bytes > TEAM_LIMITS.checkpointBytes, '完整内容可超建议体积');
  assert.equal(huge.caps.over, true);
  assert.equal(huge.caps.truncated, false);
  assert.ok(huge.markdown.includes('DONE-7-'), '超限也不丢低优先级条目（写盘完整）');
  assert.ok(Buffer.byteLength(huge.promptText, 'utf8') <= TEAM_LIMITS.checkpointBytes, 'prompt 渲染有界');
  assert.match(huge.promptText, /完整 checkpoint 见 .*checkpoint\.md/);
  assert.match(huge.promptText, /超建议体积/);
  assert.ok(huge.promptText.includes('## 决策'), 'prompt 保留高优先级段');
  assert.ok(!huge.promptText.includes('DONE-0-'), 'prompt 丢弃低优先级段（内容仍在完整文件里）');
  assert.equal(renderCheckpointForPrompt(huge.markdown, { maxBytes: TEAM_LIMITS.checkpointBytes }), huge.promptText, 'renderCheckpointForPrompt 与 promptText 同一出口');
});

test('ledger：live 有界（≤200 条 / ≤8KB）+ 超界归档不丢数据 + readLedgerArchive 可读；坏行跳过；roster 退役代际', async () => {
  const dir = tempWorkspace();
  try {
    for (let index = 0; index < 205; index += 1) await appendLedger(dir, 'impl', { event: 'checkpoint', gen: 1, name: 'impl', n: index });
    const appended = await appendLedger(dir, 'impl', { event: 'checkpoint', gen: 1, name: 'impl', n: 205 });
    assert.ok(appended.archived > 0, 'appendLedger 返回 archived 计数');
    const entries = readLedger(dir, 'impl', 500);
    assert.ok(entries.length <= TEAM_LIMITS.ledgerEntries && entries.length > 1, 'live 条数 ≤200 且仍有历史');
    assert.equal(entries[entries.length - 1].n, 205);
    assert.ok(entries[0].n > 0, 'live 只保留最新有界窗口');
    assert.ok(Buffer.byteLength(readFileSync(ledgerPathOf(dir, 'impl'), 'utf8'), 'utf8') <= TEAM_LIMITS.ledgerBytes, 'live 文件 ≤8KB');
    const archive = readLedgerArchive(dir, 'impl', 500);
    assert.ok(archive.length > 0, '归档可读');
    assert.equal(archive[0].n, 0, '归档保留最旧条目（原样 JSONL）');
    assert.deepEqual(
      entries.map((entry) => entry.n).concat(archive.map((entry) => entry.n)).sort((left, right) => left - right),
      Array.from({ length: 206 }, (_, index) => index),
      '206 条一条不丢：live + 归档',
    );
    const archivePath = ledgerArchivePathOf(dir, 'impl');
    assert.ok(existsSync(archivePath), '归档路径 ledger-archive-<年份>.ndjson');
    assert.match(readFileSync(archivePath, 'utf8'), /"n":0/, '归档是原样 JSONL');
    appendFileSync(archivePath, '{bad json\n', 'utf8');
    assert.equal(readLedgerArchive(dir, 'impl', 500).length, archive.length, '归档坏行跳过');
    const roster = { version: 1, lineages: {} };
    const entry = ensureLineage(roster, 'impl', { name: 'impl-g1', sessionId: 's1' });
    ensureLineage(roster, 'impl', { name: 'impl-g2', sessionId: 's2' });
    assert.equal(retireGeneration(entry, 'impl-g1', 'band'), true);
    assert.equal(entry.generations[0].retiredAt === undefined, false);
    assert.equal(entry.generations[0].reason, 'band');
    await writeRoster(dir, roster);
    const reread = readRoster(dir);
    assert.equal(reread.lineages.impl.generations.length, 2);
    assert.equal(reread.lineages.impl.activeGen, 2);
  } finally { cleanup(dir); }
});

test('checkpoint 文件：写/读/换代归档；buildRenewPrompt 有界+指针（完整 checkpoint 落盘）', async () => {
  const dir = tempWorkspace();
  try {
    const built = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: '完成 A', decisions: ['选 B 因为 C'], next_actions: ['跑测试'] } });
    await writeCheckpoint(dir, 'impl', built.markdown);
    const read = readCheckpoint(dir, 'impl');
    assert.ok(read !== undefined);
    assert.equal(read.bytes, built.caps.bytes);
    const prompt = buildRenewPrompt({ lineage: 'impl', newName: 'impl-g2', gen: 2, prevName: 'impl-g1', profile: '# 职责\n实现登录', checkpoint: read.text, ledger: [{ gen: 1, name: 'impl-g1', sessionId: 's1' }], leadSessionId: 'session-lead' });
    assert.match(prompt, /impl-g2/);
    assert.match(prompt, /team\/session-lead\/impl\//, 'renew prompt 记录目录带 Lead 分区');
    assert.match(prompt, /完整 checkpoint.*session-lead\/impl\/checkpoint\.md/, 'prompt 始终给完整 checkpoint 指针');
    assert.doesNotMatch(prompt, /超建议体积/, '未超预算：完整交接直接注入');
    const legacyPrompt = buildRenewPrompt({ lineage: 'impl', newName: 'impl-g2', gen: 2, prevName: 'impl-g1', profile: '# 职责', checkpoint: '# 旧交接', ledger: [], leadSessionId: 'session-lead', recordDir: '.scratch/context-relay/team/impl' });
    assert.match(legacyPrompt, /team\/impl\/（profile/, 'legacy-only 记录时按实际记录目录给指针');
    assert.doesNotMatch(legacyPrompt, /team\/session-lead\/impl\/（profile/, '不指向不存在的分区记录目录');
    assert.match(prompt, /实现登录/);
    assert.match(prompt, /选 B 因为 C/);
    assert.match(prompt, /跑测试/);
    assert.match(prompt, /session_event_read/);
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= TEAM_LIMITS.promptBytes);
    // 超预算：checkpoint 完整落盘；prompt 有界 + marker + 指针，按优先级保留
    const hugeBuilt = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: {
      one_line: '大交接',
      done: Array.from({ length: 8 }, (_, index) => 'DONE-LOW-' + index + '-' + 'd'.repeat(180)),
      decisions: Array.from({ length: 8 }, (_, index) => '决策-' + index + '-' + 'm'.repeat(180)),
      evidence: Array.from({ length: 8 }, (_, index) => '证据-' + index + '-' + 'e'.repeat(180)),
      constraints: Array.from({ length: 8 }, (_, index) => '约束-' + index + '-' + 'c'.repeat(180)),
      open_questions: Array.from({ length: 8 }, (_, index) => '未决-' + index + '-' + 'q'.repeat(180)),
      next_actions: Array.from({ length: 8 }, (_, index) => '下一步-' + index + '-' + 'n'.repeat(180)),
    } });
    await writeCheckpoint(dir, 'impl', hugeBuilt.markdown);
    const hugeRead = readCheckpoint(dir, 'impl');
    assert.ok(hugeRead.bytes > TEAM_LIMITS.checkpointBytes, 'checkpoint 落盘完整（可超建议体积）');
    assert.ok(hugeRead.text.includes('DONE-LOW-7-'), '低优先级条目也完整落盘');
    const hugePrompt = buildRenewPrompt({ lineage: 'impl', newName: 'impl-g2', gen: 2, prevName: 'impl-g1', profile: '# 职责\n实现登录', checkpoint: hugeRead.text, ledger: [{ gen: 1, name: 'impl-g1', sessionId: 's1' }], leadSessionId: 'session-lead' });
    assert.ok(Buffer.byteLength(hugePrompt, 'utf8') <= TEAM_LIMITS.promptBytes, 'prompt 有界');
    assert.match(hugePrompt, /超建议体积/, 'prompt 带显式 marker');
    assert.match(hugePrompt, /完整 checkpoint 见 \.scratch\/context-relay\/team\/session-lead\/impl\/checkpoint\.md/);
    assert.ok(hugePrompt.includes('## 决策') && hugePrompt.includes('## 证据'), '按优先级保留高价值段');
    assert.ok(!hugePrompt.includes('DONE-LOW-0-') && !hugePrompt.includes('下一步-0-'), '低优先级段让位（完整内容在 checkpoint 文件）');
    const archived = await archiveCheckpoint(dir, 'impl', 1);
    assert.ok(archived !== undefined);
    assert.equal(archived.bytes, hugeRead.bytes, '换代归档保留完整 checkpoint');
    assert.ok(readFileSync(handoffPathOf(dir, 'impl', 1), 'utf8').includes('DONE-LOW-7-'), '归档内容完整');
    assert.ok(existsSync(handoffPathOf(dir, 'impl', 1)));
    assert.equal(existsSync(checkpointPathOf(dir, 'impl')), false);
  } finally { cleanup(dir); }
});

test('classifyHealth：fresh/watch/stale/spent/unknown/unavailable 与建议动作', () => {
  assert.equal(classifyHealth({ band: 'ok' }).health, 'fresh');
  assert.equal(classifyHealth({ band: 'warn' }).health, 'watch');
  assert.equal(classifyHealth({ band: 'organize' }, true).health, 'stale');
  assert.equal(classifyHealth({ band: 'relay' }, false).health, 'spent');
  assert.equal(classifyHealth({ band: 'unknown' }).health, 'unknown');
  // v0.11 P0-A：band=unavailable（指标不可用）不得落 fresh；归 unknown 且不可自动选人。
  const unavailable = classifyHealth({ band: 'unavailable' });
  assert.equal(unavailable.health, 'unknown');
  assert.equal(unavailable.band, 'unavailable');
  assert.match(unavailable.action, /指标不可用/);
  assert.match(unavailable.action, /unavailable/);
  assert.match(dispatchNeedOf('unavailable'), /指标不可用/);
  assert.notEqual(dispatchNeedOf('unavailable'), dispatchNeedOf('ok'));
  assert.match(classifyHealth({ band: 'organize' }, true).action, /relay_freshen\(\{reset:true/);
  assert.match(classifyHealth({ band: 'organize' }, true).action, /仅换身份/);
  assert.doesNotMatch(classifyHealth({ band: 'organize' }, true).action, /先换新/);
  assert.match(classifyHealth({ band: 'organize' }, false).action, /relay_checkpoint/);
});

// ── 工具契约（fake ctx） ───────────────────────────────────────────────

function fakeCtx(services = {}) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
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
    get(name) { return normalized[name]; },
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

function makeTeamService({ members = [], memberships = new Map(), spawnResult, sendResult, sendError } = {}) {
  const calls = { spawn: [], send: [], interrupt: [] };
  return {
    calls,
    tryMembership(agent) { return memberships.get(agent); },
    listMembers() { return members; },
    async spawnTeammate(caller, request) {
      calls.spawn.push(request);
      return spawnResult === undefined ? { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } } : spawnResult(request);
    },
    async sendMessage(caller, request) {
      calls.send.push(request);
      if (sendError !== undefined) throw new Error(sendError);
      return sendResult ?? { messageId: 'm1' };
    },
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
    clearTeamStatusMemory();
    const nonLead = await statusTool.execute({}, { agent: teammate });
    assert.equal(nonLead.ok, false);
    assert.equal(nonLead.code, 'lead-only');
    const roster = { version: 1, lineages: {} };
    ensureLineage(roster, 'impl', { name: 'impl-g1', sessionId: 'session-w1' });
    await writeRoster(dir, roster, LEAD);
    const built = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: 'wip' } });
    await writeCheckpoint(dir, 'impl', built.markdown, LEAD);
    const report = await statusTool.execute({}, { agent: lead });
    assert.equal(report.ok, true);
    assert.equal(report.team.length, 2);
    const impl = report.team.find((row) => row.name === 'impl-g1');
    const review = report.team.find((row) => row.name === 'review-g1');
    assert.equal(impl.gen, 1);
    assert.equal(impl.rosterKnown, true, 'v0.11 P0-A：roster 当前代标记 rosterKnown');
    assert.equal(review.rosterKnown, false, 'catalog 有、roster 无的成员 rosterKnown=false');
    assert.equal(report.phase, null, '无台账时 Lead phase 为 null');
    assert.equal(impl.phase, null);
    assert.equal(impl.items, undefined, '无台账时不带条目计数');
    assert.equal(impl.health, 'stale');
    assert.equal(review.health, 'spent');
    assert.deepEqual(report.stale.sort(), ['impl-g1', 'review-g1']);
    assert.match(report.text, /records=\.scratch\/context-relay\/team\/session-lead\//);
    assert.match(report.text, /小队目标=4（按需扩到 maxActiveSubagents/, 'v0.9.0 #28：小队目标 4 口径');
    assert.match(report.text, /stale → 边界 reset 复用（真清空，0 额度）；仅换身份才 renew/);
    assert.match(report.text, /spent → 先 checkpoint 再 reset 复用（0 额度）；仅换身份才 renew/);
    assert.match(impl.action, /relay_freshen\(\{reset:true/, '结构化 action 也 reset-first');
    assert.doesNotMatch(impl.action, /relay_renew）|先换新/);
    assert.ok(report.text.length <= 2000, '团队报告有界');
    // v0.6.0 去轮询：状态没变的重复调用直接拒绝（信息没变）
    const again = await statusTool.execute({}, { agent: lead });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'unchanged-poll');
    assert.equal(again.unchanged, true);
    assert.match(again.summary, /do not poll/);
    assert.match(again.text, /phase 边界会带 triage/);
  } finally { clearTeamStatusMemory(); cleanup(dir); }
});

test('relay_architect：未显式选择时用模型默认，显式传路由且不阻塞', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teams = makeTeamService({ memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const route = { provider: 'p', model: 'last-used', reasoningEffort: 'high' };
    const sessionProjections = { stateOf: (_session, key) => key === 'modelSelection' ? { lastUsed: route } : [{ provider: 'other', model: 'allowlisted' }] };
    const ctx = fakeCtx({ agentTeams: teams, sessionProjections });
    const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    assert.ok(tool, 'relay_architect 已注册');
    const result = await tool.execute({ brief: '设计登录模块' }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.code, 'architect-model-unselected');
    assert.equal(result.modelSource, 'default');
    assert.deepEqual(result.model, route);
    assert.match(result.text, /默认跟随模型选择；可覆盖/);
    assert.equal(teams.calls.spawn.length, 1);
    assert.deepEqual(teams.calls.spawn[0].agentOptions, route);
  } finally { cleanup(dir); }
});

test('relay_architect：面板已选模型时创建 architect（legacy 路径；文档路径/roster 落盘）', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    updatePanelState(LEAD, { architectModel: { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' } });
    const teams = makeTeamService({
      members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    // v0.7.1：架构师模型受官方子代理白名单约束；夹具把 geekai/gpt-6.1-sol 列为允许路由。
    const sessionProjections = { stateOf: (_session, key) => (key === 'subagentModelSelectionPolicy' ? [{ provider: 'geekai', model: 'gpt-6.1-sol' }] : undefined) };
    const ctx = fakeCtx({ agentTeams: teams, sessionProjections });
    const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ brief: '设计登录模块', task_id: 'login', doc_pointers: ['docs/login.md'], write_scope: ['.scratch/context-relay/architecture/'] }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.mode, 'fresh');
    assert.equal(result.name, 'architect');
    assert.equal(result.docPath, '.scratch/context-relay/architecture/login.md');
    assert.deepEqual(result.model, { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' });
    assert.equal(teams.calls.spawn.length, 1);
    assert.equal(teams.calls.spawn[0].name, 'architect');
    assert.equal(result.modelSource, 'panel');
    assert.deepEqual(teams.calls.spawn[0].agentOptions, result.model);
    assert.match(teams.calls.spawn[0].prompt[0].text, /设计登录模块/);
    assert.match(teams.calls.spawn[0].prompt[0].text, /context-relay\/architecture\/login\.md/);
    assert.ok(existsSync(join(dir, '.scratch', 'context-relay', 'team', LEAD, 'roster.json')), 'architect lineage 写入 roster');
  } finally { cleanup(dir); }
});

test('relay_architect：模型不在官方子代理白名单 → 拒绝且零 spawn（不绕过策略）', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    updatePanelState(LEAD, { architectModel: { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' } });
    const teams = makeTeamService({ members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }], memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const sessionProjections = { stateOf: (_session, key) => (key === 'subagentModelSelectionPolicy' ? [{ provider: 'deepseek-account', model: 'deepseek-flash' }] : undefined) };
    const ctx = fakeCtx({ agentTeams: teams, sessionProjections });
    const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ brief: '设计登录模块' }, { agent: lead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'architect-model-not-allowed');
    assert.deepEqual(result.allowedModels, [{ provider: 'deepseek-account', model: 'deepseek-flash' }]);
    assert.match(result.summary, /allowlist/);
    assert.equal(teams.calls.spawn.length, 0, '白名单外的模型不得创建成员');
  } finally { cleanup(dir); }
});

test('relay_architect：没有白名单记录时只允许 Lead 当前路由（官方语义），不允许任意模型', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    updatePanelState(LEAD, { architectModel: { provider: 'geekai', model: 'gpt-6.1-sol' } });
    const teams = makeTeamService({ members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }], memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const sessionProjections = { stateOf: (_session, key) => (key === 'modelSelection' ? { pending: null, lastUsed: { provider: 'deepseek', model: 'test' } } : undefined) };
    const ctx = fakeCtx({ agentTeams: teams, sessionProjections });
    const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ brief: '设计登录模块' }, { agent: lead });
    assert.equal(result.code, 'architect-model-not-allowed');
    assert.deepEqual(result.allowedModels, [{ provider: 'deepseek', model: 'test' }]);
    assert.equal(teams.calls.spawn.length, 0);
  } finally { cleanup(dir); }
});

test('relay_architect：pending 优先/部署默认/无服务继承/显式 sticky/非法 effort', async () => {
  const scenarios = [
    { selection: { pending: { provider: 'p', model: 'pending' }, lastUsed: { provider: 'p', model: 'last' } }, expected: { provider: 'p', model: 'pending' } },
    { deployment: { provider: 'p', model: 'deployment' }, expected: { provider: 'p', model: 'deployment' } },
    { expected: null },
    { selected: { provider: 'p', model: 'sticky', reasoningEffort: 'max' }, selection: { pending: { provider: 'z', model: 'changed' } }, expected: { provider: 'p', model: 'sticky', reasoningEffort: 'max' } },
    { selection: { lastUsed: { provider: 'p', model: 'valid', reasoningEffort: 'bad effort' } }, expected: { provider: 'p', model: 'valid' } },
    { selection: { lastUsed: { provider: 'p', model: 'valid' } }, expected: { provider: 'p', model: 'valid' } },
  ];
  for (const scenario of scenarios) {
    const dir = tempWorkspace();
    try {
      configurePanelStore({ panelPath: join(dir, 'panel.json') });
      const lead = makeAgent({ sessionId: LEAD, cwd: dir });
      lead.session.requestHeader = () => ({});
      updatePanelState(LEAD, { architectModel: scenario.selected ?? null });
      const teams = makeTeamService({ memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
      const services = { agentTeams: teams };
      if (scenario.selection) services.sessionProjections = { stateOf: (_session, key) => key === 'modelSelection' ? scenario.selection : scenario.selected ? [scenario.selected] : undefined };
      if (scenario.deployment) services.agentDefaultModel = { currentSelection: () => scenario.deployment };
      const ctx = fakeCtx(services);
      const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
      const result = await tool.execute({ brief: '设计' }, { agent: lead });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.modelSource, scenario.selected ? 'panel' : 'default');
      assert.deepEqual(result.model, scenario.expected);
      assert.equal(teams.calls.spawn.length, 1);
      assert.deepEqual(teams.calls.spawn[0].agentOptions, scenario.expected ?? undefined);
      if (scenario.expected === null) assert.match(result.text, /默认跟随 Lead（官方继承）/);
    } finally { cleanup(dir); }
  }
});

test('relay_architect：continue 未选也可复用已有代与模型，不 spawn', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teams = makeTeamService({ members: [{ id: 'session-architect', name: 'architect', role: 'teammate', status: 'inactive' }], memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    updatePanelState(LEAD, { architectModel: null });
    await writeCheckpoint(dir, 'architect', '## 架构师记录', LEAD);
    const ctx = fakeCtx({ agentTeams: teams });
    const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ brief: '继续设计', mode: 'continue' }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.model, null);
    assert.equal(result.modelSource, 'default');
    assert.equal(teams.calls.spawn.length, 0);
    assert.equal(teams.calls.send.length, 1);
    assert.match(result.text, /默认值只影响 fresh 新建/);
  } finally { cleanup(dir); }
});

test('relay_architect：显式选择且投影读取失败仍拒绝，零 spawn', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    updatePanelState(LEAD, { architectModel: { provider: 'p', model: 'explicit' } });
    const teams = makeTeamService({ memberships: new Map([[lead, membership('lead', 'lead', lead)]]) });
    const ctx = fakeCtx({ agentTeams: teams, sessionProjections: { stateOf() { throw new Error('unavailable'); } } });
    const tool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ brief: '设计' }, { agent: lead });
    assert.equal(result.code, 'architect-model-policy-unavailable');
    assert.equal(teams.calls.spawn.length, 0);
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
    assert.equal(teams.calls.spawn[0].provider, 'spawn-in-process', 'rc.2 优先 spawn-in-process');
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
    assert.doesNotMatch(result.summary, /relay_rehydrate/, 'v0.7.0 已删除 rehydrate 工具');
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
    await writeCheckpoint(dir, 'impl', built.markdown);
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
    // M-05/C3：真清空成功也 inject 一条结果 notice（队友模型必须知道旧上下文已清空）。
    assert.equal(teammate.injected.length, 1, '成功结果 notice 注入一条');
    const successNotice = String(teammate.injected[0]?.content?.[0]?.text ?? '');
    assert.match(successNotice, /reset 结果：真清空成功/);
    assert.match(successNotice, /session_event_read/);
    assert.equal(teammate.injected[0]?.source?.form, 'notice', 'notice 身份（非用户发言）');
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
    // M-05/C3：回退成功 = brief 注入 + 一条结果 notice（旧上下文没真清空，队友必须知道）。
    assert.equal(teammate.injected.length, 2);
    assert.match(String(teammate.injected[0]?.content?.[0]?.text ?? ''), /reset 回退/);
    assert.match(String(teammate.injected[1]?.content?.[0]?.text ?? ''), /reset 结果：真清空未生效/);
    assert.match(String(teammate.injected[1]?.content?.[0]?.text ?? ''), /回退官方压缩/);
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
    // M-05/C3：失败也 inject 一条结果 notice（旧上下文仍在，不能静默继续）。
    assert.equal(teammate.injected.length, 1);
    const failureNotice = String(teammate.injected[0]?.content?.[0]?.text ?? '');
    assert.match(failureNotice, /reset 结果：真清空失败/);
    assert.match(failureNotice, /旧上下文仍在/);
    assert.match(failureNotice, /compaction made no progress/);
  } finally {
    clearPendingResets();
    cleanup(dir);
  }
});

test('pre-step：wipe 失败且压缩服务不可用 → 结果 notice + ledger reset-failed（不静默）', async () => {
  const dir = tempWorkspace();
  clearPendingResets();
  clearSentinelMemory();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    withSurface(teammate, { nodes: [1, 2], failAppend: 'surface replacement rejected' });
    const ctx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }) });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    await teammateTools.find((tool) => tool.name === 'relay_freshen').execute({ reset: true, phase: 'build', brief: '新任务' }, { agent: teammate });
    await findPreStepListener(ctx)({ agent: teammate, signal: new AbortController().signal }, async () => {});
    const failed = readLedger(dir, 'impl', 20, LEAD).find((entry) => entry.event === 'reset-failed');
    assert.ok(failed !== undefined, '压缩不可用也要记 reset-failed（team_status 可见）');
    assert.match(String(failed.reason), /compaction unavailable/);
    assert.equal(teammate.injected.length, 1);
    assert.match(String(teammate.injected[0]?.content?.[0]?.text ?? ''), /reset 结果：真清空失败/);
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

// ── 派活/收口（relay_dispatch / relay_collect，v0.9.0 批次3） ──────────────

/** 标准派活参数（用例按需浅覆盖 itemId/worker/force 等字段）。 */
const DISPATCH_ARGS = Object.freeze({
  itemId: 'a1',
  brief: '实现登录修复并自测',
  docs: ['.scratch/context-relay/architecture/v090.md（when：开工前读设计）'],
  writeScope: ['lib/foo.js'],
  acceptance: 'node --test test/foo.test.mjs',
});

/** v0.10.x 完成确认门：新变 done 的条目必须带三项均 true 的 lead_confirm。 */
const LEAD_CONFIRM = { no_drift: true, no_missing: true, no_regression: true };

async function seedLedger(dir, items) {
  const written = await writeWorkItems(dir, { items, updatedBy: LEAD, scopeId: LEAD });
  assert.equal(written.ok, true, '台账 seed 写入成功');
  return written;
}

function ledgerItem(dir, itemId) {
  return readWorkItems(dir, { scopeId: LEAD }).items.find((item) => item.id === itemId);
}

function ledgerRev(dir) {
  return readWorkItems(dir, { scopeId: LEAD }).rev;
}

function writeReportRaw(dir, itemId, text) {
  const reports = join(dir, '.scratch', 'context-relay', 'reports');
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, itemId + '.md'), text, 'utf8');
}

function writeReceipt(dir, itemId, options = {}) {
  const dispatchId = options.dispatchId ?? ('d-' + itemId + '-test');
  const verdict = options.verdict ?? 'done';
  const conclusion = options.conclusion ?? ('完成 ' + itemId);
  writeReportRaw(dir, itemId, [
    'task: ' + itemId,
    'revision: ' + dispatchId,
    'verdict: ' + verdict,
    '',
    '## 结论',
    conclusion,
    '',
    '## 证据',
    '- lib/foo.js:1',
    '',
  ].join('\n'));
  return dispatchId;
}

function delegationToolsOf(ctx, runtime = {}) {
  const tools = createDelegationTools({ ...makeRuntime(ctx.ctx), ...runtime });
  return {
    dispatch: tools.find((tool) => tool.name === 'relay_dispatch'),
    collect: tools.find((tool) => tool.name === 'relay_collect'),
  };
}

function dispatchCtx({ dir, members = [], pressures = {}, spawnResult, sendError, sessionQuery } = {}) {
  const lead = makeAgent({ sessionId: LEAD, cwd: dir });
  const teams = makeTeamService({
    members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }, ...members],
    memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    ...(spawnResult === undefined ? {} : { spawnResult }),
    ...(sendError === undefined ? {} : { sendError }),
  });
  const query = sessionQuery ?? (Object.keys(pressures).length > 0 ? pressureQuery(pressures) : undefined);
  const ctx = fakeCtx({
    agentTeams: teams,
    ...(query === undefined ? {} : { sessionQuery: query }),
  });
  return { lead, teams, ctx };
}

/** dispatch 记录文件（测试断言用；路径 = delegation.js 单源派生）。 */
function dispatchRecordFile(dir, itemId, scopeId = LEAD) {
  return join(dir, ...dispatchRecordPathOf(scopeId, itemId).split('/'));
}

function readDispatchRecord(dir, itemId, scopeId = LEAD) {
  const path = dispatchRecordFile(dir, itemId, scopeId);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

test('relay_dispatch：复用空闲干净 worker → 标准 5 字段 brief + 台账 doing+owner+next + 返回 worker/reportPath/dispatchId', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive', description: '实现' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.itemId, 'a1');
    assert.match(result.dispatchId, /^d-a1-[0-9a-z]+$/);
    assert.equal(result.reportPath, '.scratch/context-relay/reports/a1.md');
    assert.deepEqual(result.worker, { name: 'worker-1', reused: true, spawned: false, status: 'inactive' });
    assert.ok(result.text.startsWith(DISPATCH_OK_PREFIX + 'a1 '), '投影成功 marker（与投影常量同源，防漂移）');
    // 派活消息 = 标准 5 字段 brief + reportPath + dispatchId
    assert.equal(teams.calls.send.length, 1);
    const briefText = teams.calls.send[0].content[0].text;
    for (const marker of [
      '1) 目标：实现登录修复并自测',
      '2) 必读（1–3 份',
      '3) 写范围：lib/foo.js',
      '4) 验收：node --test test/foo.test.mjs',
      '5) 回执：',
    ]) assert.ok(briefText.includes(marker), 'brief 含 ' + marker);
    assert.ok(briefText.includes(result.dispatchId), 'brief 含 dispatchId');
    assert.ok(briefText.includes(result.reportPath), 'brief 含 reportPath');
    assert.match(briefText, /verdict: done\|needs-human\|blocked/);
    // 台账 doing + owner + next
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'doing');
    assert.equal(stored.owner, 'worker-1');
    assert.match(stored.next, /reports\/a1\.md/);
    assert.equal(result.ledger.status, 'doing');
    assert.equal(result.ledger.owner, 'worker-1');
    assert.equal(result.brief.fields.length, 5);
    assert.equal(existsSync(join(dir, '.scratch', 'context-relay', 'reports')), true, 'reports/ 目录按需创建（设计 §2.4.2 步骤 4）');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：缺 brief/docs/writeScope/acceptance 或非法写范围 → invalid-args 且零副作用', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const bad = [
      { itemId: 'a1', docs: DISPATCH_ARGS.docs, writeScope: DISPATCH_ARGS.writeScope, acceptance: DISPATCH_ARGS.acceptance },
      { itemId: 'a1', brief: 'x', writeScope: DISPATCH_ARGS.writeScope, acceptance: DISPATCH_ARGS.acceptance },
      { itemId: 'a1', brief: 'x', docs: DISPATCH_ARGS.docs, acceptance: DISPATCH_ARGS.acceptance },
      { itemId: 'a1', brief: 'x', docs: DISPATCH_ARGS.docs, writeScope: DISPATCH_ARGS.writeScope },
      { ...DISPATCH_ARGS, writeScope: ['/etc/passwd'] },
      { ...DISPATCH_ARGS, writeScope: ['../outside.js'] },
      { ...DISPATCH_ARGS, docs: [] },
      { ...DISPATCH_ARGS, docs: ['a', 'b', 'c', 'd'] },
    ];
    for (const args of bad) {
      const refused = await dispatch.execute(args, { agent: lead });
      assert.equal(refused.ok, false, '应拒绝: ' + JSON.stringify(args).slice(0, 80));
      assert.equal(refused.code, 'invalid-args');
    }
    assert.equal(teams.calls.send.length, 0, '拒绝不发消息');
    assert.equal(teams.calls.spawn.length, 0, '拒绝不 spawn');
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'open', '台账不变');
    assert.equal(stored.owner, null);
    assert.equal(ledgerRev(dir), 1, '台账 rev 不变');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：item 不存在/done/already-dispatched 结构化拒绝；force 只重发不写台账', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [
      { id: 'a2', title: '已关闭', status: 'done', evidence: ['.scratch/context-relay/reports/a2.md'], lead_confirm: LEAD_CONFIRM },
      { id: 'a3', title: '进行中', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a3.md' },
    ]);
    const { dispatch } = delegationToolsOf(ctx);
    const missing = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'zz' }, { agent: lead });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'item-not-found');
    const closed = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a2' }, { agent: lead });
    assert.equal(closed.ok, false);
    assert.equal(closed.code, 'item-closed');
    const doing = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a3' }, { agent: lead });
    assert.equal(doing.ok, false);
    assert.equal(doing.code, 'already-dispatched');
    assert.equal(doing.owner, 'worker-1');
    assert.match(doing.recovery, /relay_collect/);
    assert.equal(teams.calls.send.length, 0);
    assert.equal(teams.calls.spawn.length, 0);
    const revBefore = ledgerRev(dir);
    const forced = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a3', force: true }, { agent: lead });
    assert.equal(forced.ok, true, 'force 重发成功');
    assert.equal(forced.worker.reused, true);
    assert.ok(forced.text.startsWith(DISPATCH_OK_PREFIX + 'a3 '));
    assert.equal(teams.calls.send.length, 1, 'force 只发消息');
    assert.equal(teams.calls.spawn.length, 0, 'force 不 spawn');
    assert.equal(ledgerRev(dir), revBefore, 'force 不写台账');
    assert.equal(ledgerItem(dir, 'a3').status, 'doing');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：无空闲 worker → 按 worker-1 新建（prompt=标准 brief）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.deepEqual(result.worker, { name: 'worker-1', reused: false, spawned: true, status: 'provisioning' });
    assert.equal(teams.calls.spawn.length, 1);
    assert.equal(teams.calls.spawn[0].name, 'worker-1');
    assert.ok(teams.calls.spawn[0].prompt[0].text.includes('1) 目标：'), 'prompt 即标准 brief');
    assert.equal(ledgerItem(dir, 'a1').owner, 'worker-1');
    assert.equal(ledgerItem(dir, 'a1').status, 'doing');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：member-limit → 结构化失败 + 台账回滚', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir, spawnResult: () => { throw new Error('member limit reached'); } });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'member-limit');
    assert.equal(result.effect, 'ledger rolled back');
    assert.match(result.summary, /reset|handoff/);
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'open', '台账回滚为 open');
    assert.equal(stored.owner, null, 'owner 回滚');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：脏上下文队友默认拒绝（先管理再派指引 + 快照）；accept_dirty:true 放行', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 38000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const refused = await dispatch.execute({ ...DISPATCH_ARGS, worker: 'worker-1' }, { agent: lead });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'worker-needs-management');
    assert.match(refused.recovery, /relay_freshen\(\{reset:true/);
    assert.equal(refused.worker.band, 'organize');
    assert.equal(teams.calls.send.length, 0, '拒绝不发消息');
    assert.equal(ledgerItem(dir, 'a1').status, 'open', '拒绝零台账副作用');
    const snapshot = readTeamContext(dir, LEAD);
    assert.ok(snapshot.pending.some((row) => row.name === 'worker-1'), '写团队上下文快照（phase 边界兜底）');
    const accepted = await dispatch.execute({ ...DISPATCH_ARGS, worker: 'worker-1', accept_dirty: true }, { agent: lead });
    assert.equal(accepted.ok, true, 'accept_dirty 放行');
    assert.equal(teams.calls.send.length, 1);
    assert.equal(ledgerItem(dir, 'a1').owner, 'worker-1');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch 自动选人 health：仅 fresh/watch 可复用（stale/spent/unknown 排除；设计 §2.4.2 步骤 3b）', async () => {
  // 判定纯函数：显式 health 优先（官方 seam 带 health 时），否则按设计口径由 band(+checkpoint) 派生。
  assert.equal(dispatchHealthOf({ health: 'stale' }, { band: 'ok', ratio: 0.1 }), 'stale');
  assert.equal(DISPATCH_HEALTHS.includes('stale'), false, 'stale 即使压力 band=ok 也不可自动复用');
  assert.equal(dispatchHealthOf({}, { band: 'ok' }), 'fresh');
  assert.equal(dispatchHealthOf({}, { band: 'warn' }), 'watch');
  assert.equal(dispatchHealthOf({}, { band: 'organize' }), 'spent');
  assert.equal(dispatchHealthOf({}, { band: 'relay' }), 'spent');
  assert.equal(dispatchHealthOf({}, { band: 'unknown' }), 'unknown');
  assert.equal(dispatchHealthOf({}, { band: 'unavailable' }), 'unknown', 'v0.11 P0-A：unavailable 与 unknown 同归 unknown（不得落 fresh）');
  assert.equal(DISPATCH_HEALTHS.includes(dispatchHealthOf({}, { band: 'organize' })), false);
  assert.equal(DISPATCH_HEALTHS.includes(dispatchHealthOf({}, { band: 'unknown' })), false);
  assert.equal(DISPATCH_HEALTHS.includes(dispatchHealthOf({}, { band: 'unavailable' })), false, 'unavailable 被 DISPATCH_HEALTHS 排除');
  // 集成 A：worker-1 到线（38% → band=organize → health=spent/stale）→ 不自动复用，改新建 worker-2。
  const dirA = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir: dirA,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 38000 },
    });
    await seedLedger(dirA, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.worker.spawned, true, 'stale/spent 队友不自动复用');
    assert.equal(result.worker.name, 'worker-2', 'worker-1 名字已占用，沿用既有 spawn 路径新建 worker-2');
    assert.equal(teams.calls.send.length, 0);
    assert.equal(teams.calls.spawn.length, 1);
  } finally { cleanup(dirA); clearDelegationMemory(); }
  // 集成 B：读不到队友档位（无 sessionQuery → band=unknown → health=unknown）→ 不自动复用。
  const dirB = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({ dir: dirB, members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }] });
    await seedLedger(dirB, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.worker.spawned, true, '读不到档位（unknown）的队友不自动复用');
    assert.equal(result.worker.name, 'worker-2');
    assert.equal(teams.calls.send.length, 0);
  } finally { cleanup(dirB); clearDelegationMemory(); }
});

test('relay_dispatch 自动选人：clean(ok+ck) 优先、dirty(unavailable) 排除；显式 dirty 拒、accept_dirty 放行（v0.11 P0-A）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [
        { id: 'session-clean', name: 'clean-w', role: 'teammate', status: 'inactive' },
        { id: 'session-dirty', name: 'dirty-w', role: 'teammate', status: 'inactive' },
      ],
      // dirty-w 有 sessionQuery 但压力指标缺失 → band=unavailable（不是 unknown）。
      pressures: { 'session-clean': 2000, 'session-dirty': undefined },
    });
    const roster = { version: 1, lineages: {} };
    ensureLineage(roster, 'clean-w', { name: 'clean-w', sessionId: 'session-clean' });
    await writeRoster(dir, roster, LEAD);
    const built = buildCheckpointMarkdown({ lineage: 'clean-w', name: 'clean-w', gen: 1, input: { one_line: 'clean baseline' } });
    await writeCheckpoint(dir, 'clean-w', built.markdown, LEAD);
    await seedLedger(dir, [
      { id: 'a1', title: '自动选 clean', status: 'open' },
      { id: 'a2', title: '显式 dirty', status: 'open' },
    ]);
    const { dispatch } = delegationToolsOf(ctx);
    const auto = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a1' }, { agent: lead });
    assert.equal(auto.ok, true);
    assert.equal(auto.worker.name, 'clean-w', 'unavailable 的 dirty-w 不得被自动选人');
    assert.equal(auto.worker.reused, true);
    assert.equal(auto.selection.mode, 'reused');
    assert.equal(auto.selection.score, 0, 'fresh(ok) score=0');
    assert.deepEqual([...auto.selection.considered].sort(), ['clean-w', 'dirty-w']);
    assert.ok(auto.selection.excluded.some((row) => row.name === 'dirty-w' && row.reason === 'health-unknown'), 'dirty 候选给出排除原因');
    assert.equal(auto.selection.truncated, false);
    assert.equal(teams.calls.send.length, 1);

    const refused = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a2', worker: 'dirty-w' }, { agent: lead });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'worker-needs-management');
    assert.equal(refused.worker.band, 'unavailable');
    assert.match(refused.summary, /指标不可用/);
    assert.equal(teams.calls.send.length, 1, '显式 dirty 拒绝不发消息');
    assert.equal(ledgerItem(dir, 'a2').status, 'open');

    const accepted = await dispatch.execute({ ...DISPATCH_ARGS, itemId: 'a2', worker: 'dirty-w', accept_dirty: true }, { agent: lead });
    assert.equal(accepted.ok, true, 'accept_dirty 放行（Lead 显式判断）');
    assert.equal(accepted.worker.name, 'dirty-w');
    assert.equal(accepted.selection.score, null, '脏候选无可用评分');
    assert.equal(teams.calls.send.length, 2);
    assert.equal(ledgerItem(dir, 'a2').owner, 'dirty-w');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch 自动选人：候选读取上限 12，超出标 truncated（v0.11 P0-A）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const members = Array.from({ length: 14 }, (_, index) => ({ id: 'session-w' + (index + 1), name: 'worker-' + (index + 1), role: 'teammate', status: 'inactive' }));
    const pressures = Object.fromEntries(members.map((member) => [member.id, 2000]));
    const { lead, ctx } = dispatchCtx({ dir, members, pressures });
    await seedLedger(dir, [{ id: 'a1', title: '14 人候选', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.worker.name, 'worker-1', '12 名内按 score+name 选首个');
    assert.equal(result.selection.considered.length, 12, '只读 12 个候选 band');
    assert.equal(result.selection.truncated, true);
    assert.ok(result.selection.excluded.some((row) => row.name === 'worker-13' && row.reason === 'candidate-limit'));
    assert.ok(result.selection.excluded.some((row) => row.name === 'worker-14' && row.reason === 'candidate-limit'));
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch 自动选人：候选 band 并发读取（Promise.all，非串行）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    const sessionQuery = {
      async observeSession() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        inFlight -= 1;
        return { projections: { values: { contextPressure: { projectedTokens: 2000, contextWindow: 100000 } } }, [Symbol.dispose]() {} };
      },
    };
    const members = ['w1', 'w2', 'w3'].map((name) => ({ id: 'session-' + name, name: name + '-member', role: 'teammate', status: 'inactive' }));
    const { lead, ctx } = dispatchCtx({ dir, members, sessionQuery });
    await seedLedger(dir, [{ id: 'a1', title: '并发读 band', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(maxInFlight, 3, '3 个候选同时读 band（串行会是 1）');
    assert.equal(result.selection.considered.length, 3);
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：worker-1..9 名字耗尽 → worker-name-exhausted（与 spawn 满额 member-limit 区分）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const busy = [];
    for (let index = 1; index <= 9; index += 1) busy.push({ id: 'session-w' + index, name: 'worker-' + index, role: 'teammate', status: 'running' });
    const { lead, teams, ctx } = dispatchCtx({ dir, members: busy });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'worker-name-exhausted', '名字耗尽独立 code（不是 member-limit）');
    assert.match(result.recovery, /复用|改名/);
    assert.equal(teams.calls.spawn.length, 0, '名字耗尽不尝试 spawn（spawn 额度可能仍有）');
    assert.equal(teams.calls.send.length, 0);
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'open', '零台账副作用');
    assert.equal(stored.owner, null);
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch/relay_collect：非 Lead → lead-only（零副作用）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch, collect } = delegationToolsOf(ctx);
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir });
    const dispatched = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: teammate });
    assert.equal(dispatched.ok, false);
    assert.equal(dispatched.code, 'lead-only');
    const collected = await collect.execute({ itemId: 'a1' }, { agent: teammate });
    assert.equal(collected.ok, false);
    assert.equal(collected.code, 'lead-only');
    assert.equal(teams.calls.send.length, 0);
    assert.equal(ledgerItem(dir, 'a1').status, 'open');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：立即读回执头 3 行 + digest（≤600）→ 台账 done（evidence=reportPath）、只回 digest；重复 collect 幂等', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a1.md' }]);
    writeReceipt(dir, 'a1', { dispatchId: 'd-a1-test', conclusion: '登录修复完成，node --test 全绿' });
    const { collect } = delegationToolsOf(ctx);
    const result = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-test', lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'collected');
    assert.equal(result.verdict, 'done');
    assert.equal(result.digest, '登录修复完成，node --test 全绿');
    assert.ok(Array.from(result.digest).length <= 600);
    assert.ok(!result.text.includes('## 证据'), '只回 digest，不返回报告正文');
    assert.equal(result.reportPath, '.scratch/context-relay/reports/a1.md');
    assert.equal(result.ledger.status, 'done');
    assert.ok(result.text.startsWith(COLLECT_OK_PREFIX + 'a1 '), '投影成功 marker（与投影常量同源，防漂移）');
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'done');
    assert.deepEqual(stored.evidence, ['.scratch/context-relay/reports/a1.md']);
    assert.equal(stored.next, null);
    // 幂等：同 digest + alreadyCollected；不写盘
    const revAfter = ledgerRev(dir);
    const again = await collect.execute({ itemId: 'a1' }, { agent: lead });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyCollected, true);
    assert.equal(again.digest, result.digest);
    assert.equal(ledgerRev(dir), revAfter, '幂等路径不写盘');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：verdict=done 缺/不完整 lead_confirm → confirmation-required（条目不置 done、台账不变）；三项 true 才置 done 并写入条目', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [{ id: 'a1', title: '等进行中', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a1.md' }]);
    writeReceipt(dir, 'a1', { dispatchId: 'd-a1-confirm', conclusion: '完成，测试全绿' });
    const { collect } = delegationToolsOf(ctx);
    const revBefore = ledgerRev(dir);
    const missing = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-confirm' }, { agent: lead });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'confirmation-required');
    assert.match(missing.error, /no_drift/);
    const incomplete = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-confirm', lead_confirm: { no_drift: true, no_missing: true } }, { agent: lead });
    assert.equal(incomplete.code, 'confirmation-required');
    const falseFlag = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-confirm', lead_confirm: { no_drift: true, no_missing: true, no_regression: false } }, { agent: lead });
    assert.equal(falseFlag.code, 'confirmation-required');
    assert.equal(ledgerItem(dir, 'a1').status, 'doing', '条目不置 done');
    assert.equal(ledgerRev(dir), revBefore, '台账不变（不写盘）');
    const passed = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-confirm', lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(passed.ok, true, JSON.stringify(passed));
    assert.equal(passed.status, 'collected');
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'done');
    assert.deepEqual(stored.lead_confirm, LEAD_CONFIRM, '三项 true 才置 done 并写入 lead_confirm');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：needs-human/blocked → 台账 blocked + 原因', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [
      { id: 'a1', title: '需要确认', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a1.md' },
      { id: 'a2', title: '被阻塞', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a2.md' },
    ]);
    writeReceipt(dir, 'a1', { verdict: 'needs-human', conclusion: '需要用户确认权限模型' });
    writeReceipt(dir, 'a2', { verdict: 'blocked', conclusion: '依赖的接口尚未发布' });
    const { collect } = delegationToolsOf(ctx);
    const needsHuman = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-test' }, { agent: lead });
    assert.equal(needsHuman.ok, true);
    assert.equal(needsHuman.verdict, 'needs-human');
    assert.equal(needsHuman.ledger.status, 'blocked');
    assert.equal(ledgerItem(dir, 'a1').status, 'blocked');
    assert.equal(ledgerItem(dir, 'a1').blocked, '需要用户确认权限模型');
    const blocked = await collect.execute({ itemId: 'a2', dispatchId: 'd-a2-test' }, { agent: lead });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.verdict, 'blocked');
    assert.equal(ledgerItem(dir, 'a2').blocked, '依赖的接口尚未发布');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：报告缺失/坏头/revision 不匹配 → pending 且不改台账；未派活 → invalid-args', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [
      { id: 'a1', title: '等进行中', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a1.md' },
      { id: 'a2', title: '未派活', status: 'open' },
    ]);
    const { collect } = delegationToolsOf(ctx);
    const revBefore = ledgerRev(dir);
    const missing = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-x' }, { agent: lead });
    assert.equal(missing.ok, true);
    assert.equal(missing.status, 'pending');
    assert.equal(missing.reason, 'report-missing');
    assert.ok(!missing.text.startsWith(COLLECT_OK_PREFIX), 'pending 不算成功 marker');
    assert.equal(ledgerItem(dir, 'a1').status, 'doing');
    assert.equal(ledgerRev(dir), revBefore, 'pending 不写台账');
    writeReportRaw(dir, 'a1', '这不是回执\n没有头 3 行\n');
    const invalid = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-x' }, { agent: lead });
    assert.equal(invalid.status, 'pending');
    assert.equal(invalid.reason, 'report-invalid');
    assert.ok(Array.isArray(invalid.head) && invalid.head.length > 0, 'report-invalid 附已读头部片段供排查');
    writeReceipt(dir, 'a1', { dispatchId: 'd-a1-old' });
    const stale = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-new' }, { agent: lead });
    assert.equal(stale.status, 'pending');
    assert.equal(stale.reason, 'stale-report');
    assert.ok(Array.isArray(stale.head) && stale.head.length === 3, 'stale 附已读头部片段');
    assert.equal(ledgerItem(dir, 'a1').status, 'doing');
    // C8/M-06：回执头 task 必须是 itemId——错任务回执不得收口（即使 revision 匹配）。
    writeReportRaw(dir, 'a1', ['task: a2', 'revision: d-a1-new', 'verdict: done', '', '## 结论', '别的分点', ''].join('\n'));
    const wrongTask = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-new' }, { agent: lead });
    assert.equal(wrongTask.status, 'pending');
    assert.equal(wrongTask.reason, 'report-task-mismatch');
    assert.equal(ledgerItem(dir, 'a1').status, 'doing', '错任务回执不改台账');
    const notDispatched = await collect.execute({ itemId: 'a2' }, { agent: lead });
    assert.equal(notDispatched.ok, false);
    assert.equal(notDispatched.code, 'invalid-args');
    const badWait = await collect.execute({ itemId: 'a1', waitMs: 999999 }, { agent: lead });
    assert.equal(badWait.ok, false);
    assert.equal(badWait.code, 'invalid-args');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('dispatch → fake worker 回执 → collect 全流程：台账 done（evidence=reportPath）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch, collect } = delegationToolsOf(ctx);
    const dispatched = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(dispatched.ok, true);
    writeReceipt(dir, 'a1', { dispatchId: dispatched.dispatchId, conclusion: '登录修复完成；node --test 全绿' });
    const collected = await collect.execute({ itemId: 'a1', dispatchId: dispatched.dispatchId, lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(collected.ok, true);
    assert.equal(collected.status, 'collected');
    assert.equal(collected.verdict, 'done');
    assert.equal(collected.ledger.status, 'done');
    assert.ok(Array.from(collected.digest).length <= 600);
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'done');
    assert.deepEqual(stored.evidence, ['.scratch/context-relay/reports/a1.md']);
    assert.equal(stored.next, null);
  } finally { cleanup(dir); clearDelegationMemory(); }
});


// ── 派活/收口失败路径 + 持久化（C8/M-06/C10）────────────────────────────

test('relay_dispatch：dispatchId 落盘（dispatch/<scope>/<itemId>.json）；reload 丢内存后 collect 仍按落盘 revision 校验', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch, collect } = delegationToolsOf(ctx);
    const dispatched = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.dispatchPersist, 'ok');
    const record = readDispatchRecord(dir, 'a1');
    assert.equal(record.dispatchId, dispatched.dispatchId, '落盘 dispatchId = 返回/ brief 里的 revision');
    assert.equal(record.itemId, 'a1');
    assert.equal(record.scopeId, LEAD);
    assert.equal(record.worker, 'worker-1');
    assert.equal(record.reportPath, '.scratch/context-relay/reports/a1.md');
    assert.equal(dispatchRecordPathOf(LEAD, 'a1'), DELEGATION_DISPATCH_DIR + '/' + LEAD + '/a1.json');
    const state = delegationMemoryState(dir);
    assert.equal(state.inMemory, 1, '内存缓存 1 条');
    assert.equal(state.persisted, 1, '落盘记录 1 条（可观测）');
    // 模拟插件 reload：清进程内记忆（落盘不动）→ collect 不传 dispatchId 也能从落盘记录判新鲜度。
    clearDelegationMemory();
    assert.equal(delegationMemoryState(dir).cleared, true);
    writeReceipt(dir, 'a1', { dispatchId: dispatched.dispatchId });
    const collected = await collect.execute({ itemId: 'a1', lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(collected.ok, true);
    assert.equal(collected.status, 'collected');
    assert.equal(ledgerItem(dir, 'a1').status, 'done');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：reload 后旧回执不得假收口（落盘新 dispatchId 判 stale；新回执才收口）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch, collect } = delegationToolsOf(ctx);
    const v1 = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    writeReceipt(dir, 'a1', { dispatchId: v1.dispatchId, verdict: 'done' });
    clearDelegationMemory(); // 插件 reload：内存里没有 v1
    const v2 = await dispatch.execute({ ...DISPATCH_ARGS, force: true }, { agent: lead });
    assert.equal(v2.ok, true);
    assert.notEqual(v2.dispatchId, v1.dispatchId, '重派必须换 revision（同毫秒也不能复用）');
    assert.equal(readDispatchRecord(dir, 'a1').dispatchId, v2.dispatchId, '落盘以最新 dispatchId 为准');
    const stale = await collect.execute({ itemId: 'a1' }, { agent: lead });
    assert.equal(stale.ok, true);
    assert.equal(stale.status, 'pending');
    assert.equal(stale.reason, 'stale-report', '旧回执 revision != 落盘 dispatchId');
    assert.equal(ledgerItem(dir, 'a1').status, 'doing', '旧回执不得假收口');
    writeReceipt(dir, 'a1', { dispatchId: v2.dispatchId, conclusion: '重新派活后完成' });
    const collected = await collect.execute({ itemId: 'a1', lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(collected.status, 'collected');
    assert.equal(collected.verdict, 'done');
    assert.equal(collected.digest, '重新派活后完成');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：无落盘 dispatch 记录且无内存 → needs-dispatch-id（绝不接受任意 revision）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [{ id: 'a1', title: '等进行中', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a1.md' }]);
    // 磁盘上有一份任意 revision 的回执（旧报告），但没有任何 dispatch 记录可校验新鲜度。
    writeReceipt(dir, 'a1', { dispatchId: 'd-a1-anything' });
    const { collect } = delegationToolsOf(ctx);
    const refused = await collect.execute({ itemId: 'a1' }, { agent: lead });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'needs-dispatch-id');
    assert.match(refused.recovery, /dispatchId/);
    assert.equal(ledgerItem(dir, 'a1').status, 'doing', '拒绝不改台账（不假收口）');
    // 显式传 dispatchId → revision 匹配才收口。
    const explicit = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-anything', lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(explicit.status, 'collected');
    assert.equal(ledgerItem(dir, 'a1').status, 'done');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：send-failed → 台账回滚 + 不落 dispatch 记录（C10 失败路径）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({
      dir,
      members: [{ id: 'session-w1', name: 'worker-1', role: 'teammate', status: 'inactive' }],
      pressures: { 'session-w1': 2000 },
      sendError: 'send transport down',
    });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'send-failed');
    assert.equal(result.effect, 'ledger rolled back');
    assert.equal(teams.calls.send.length, 1, '确实尝试过发送');
    const stored = ledgerItem(dir, 'a1');
    assert.equal(stored.status, 'open', '台账回滚为 open');
    assert.equal(stored.owner, null, 'owner 回滚');
    assert.equal(existsSync(dispatchRecordFile(dir, 'a1')), false, '发送失败不落 dispatch 记录（不会假收口）');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_dispatch：台账写失败 → ledger-write-failed（零消息、零 dispatch 记录）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, teams, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    // 台账写锁路径做成符号链接 → workspaceStore 路径守卫拒绝 → writeWorkItems 结构化失败。
    const ledgerFile = join(dir, '.scratch', 'context-relay', 'work-items', LEAD + '.json');
    symlinkSync('.', ledgerFile + '.lock');
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ledger-write-failed');
    assert.equal(teams.calls.send.length, 0, '台账写失败不发消息');
    assert.equal(teams.calls.spawn.length, 0, '台账写失败不 spawn');
    assert.equal(existsSync(dispatchRecordFile(dir, 'a1')), false, '没有派发就没有 dispatch 记录');
    assert.equal(ledgerItem(dir, 'a1').status, 'open');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

test('relay_collect：报告超 64KB → reportTruncated 标记 + digest 有界（完整报告留文件）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    const { lead, ctx } = dispatchCtx({ dir });
    await seedLedger(dir, [{ id: 'a1', title: '大报告', status: 'doing', owner: 'worker-1', next: '执行分点并回执 .scratch/context-relay/reports/a1.md' }]);
    const body = 'task: a1\nrevision: d-a1-big\nverdict: done\n\n## 结论\n大报告完成\n\n## 证据\n' + 'x'.repeat(70000);
    writeReportRaw(dir, 'a1', body);
    const { collect } = delegationToolsOf(ctx);
    const result = await collect.execute({ itemId: 'a1', dispatchId: 'd-a1-big', lead_confirm: LEAD_CONFIRM }, { agent: lead });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'collected');
    assert.equal(result.reportTruncated, true, '超过 64KB 读取上限显式标记');
    assert.ok(result.reportBytes > 65536);
    assert.equal(result.digest, '大报告完成');
    assert.equal(ledgerItem(dir, 'a1').status, 'done');
  } finally { cleanup(dir); clearDelegationMemory(); }
});

// ── relay_team_status：reset 汇总 + deeper 签名（C8/M-05/C16）──────────────

test('relay_team_status：汇总 reset 结果（真清空/回退/失败）；reset 失败可见旧上下文仍在', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-w1', name: 'impl-g1', role: 'teammate', status: 'inactive' },
        { id: 'session-w2', name: 'impl2-g1', role: 'teammate', status: 'inactive' },
        { id: 'session-w3', name: 'impl3-g1', role: 'teammate', status: 'inactive' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    const ctx = fakeCtx({ agentTeams: teams, sessionQuery: pressureQuery({ 'session-w1': 2000, 'session-w2': 2000, 'session-w3': 2000 }) });
    const statusTool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((tool) => tool.name === 'relay_team_status');
    clearTeamStatusMemory();
    await appendLedger(dir, 'impl', { event: 'reset', name: 'impl-g1', gen: 1, at: '2026-11-16T01:00:00.000Z' }, LEAD);
    await appendLedger(dir, 'impl2', { event: 'freshen', reset: true, name: 'impl2-g1', gen: 1, at: '2026-11-16T01:01:00.000Z' }, LEAD);
    await appendLedger(dir, 'impl3', { event: 'reset-failed', name: 'impl3-g1', gen: 1, reason: 'surface replacement rejected', at: '2026-11-16T01:02:00.000Z' }, LEAD);
    const report = await statusTool.execute({}, { agent: lead });
    assert.equal(report.ok, true);
    assert.deepEqual(report.reset.ok, ['impl-g1'], '真清空成功');
    assert.deepEqual(report.reset.fallback, ['impl2-g1'], '回退压缩');
    assert.equal(report.reset.failed[0].name, 'impl3-g1');
    assert.match(String(report.reset.failed[0].reason), /surface replacement rejected/);
    assert.match(report.text, /reset 结果：真清空 impl-g1 · 回退压缩 impl2-g1 · 失败 impl3-g1/);
    assert.equal(report.team.find((row) => row.name === 'impl3-g1').reset.event, 'failed');
  } finally { clearTeamStatusMemory(); cleanup(dir); }
});

test('relay_team_status：deeper（孙代理数）变化不被「未变」误拒（C16）', async () => {
  const dir = tempWorkspace();
  try {
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    let deeper = 1;
    const subagents = {
      rootOf: () => lead,
      namesOf: () => ({ self: 'lead' }),
      async listDescendants() {
        const rows = [{ kind: 'child', id: 'session-w1', parentId: LEAD, depth: 1, mode: 'continuable', path: 'impl-g1', name: 'impl-g1' }];
        for (let index = 0; index < deeper; index += 1) {
          rows.push({ kind: 'child', id: 'gc-' + index, parentId: 'session-w1', depth: 2, mode: 'continuable', path: 'impl-g1/gc-' + index });
        }
        return rows;
      },
    };
    const ctx = fakeCtx({ subagents, agents: { get: (id) => ({ status: id === LEAD ? 'running' : 'idle' }) }, sessionQuery: pressureQuery({ 'session-w1': 2000 }) });
    const statusTool = createTeamTools(makeRuntime(ctx.ctx)).leadTools.find((tool) => tool.name === 'relay_team_status');
    clearTeamStatusMemory();
    const first = await statusTool.execute({}, { agent: lead });
    assert.equal(first.ok, true);
    assert.equal(first.deeper, 1, 'deeper 字段回显');
    deeper = 2;
    const second = await statusTool.execute({}, { agent: lead });
    assert.equal(second.ok, true, '孙代理数量变化 = 状态变化（不得误拒为 unchanged-poll）');
    assert.equal(second.deeper, 2);
    const third = await statusTool.execute({}, { agent: lead });
    assert.equal(third.ok, false);
    assert.equal(third.code, 'unchanged-poll', '状态确实没变才拒绝');
  } finally { clearTeamStatusMemory(); cleanup(dir); }
});

// ── agent 装配 ────────────────────────────────────────────────────────

test('装配：单一模式恒注册团队工具/段（不再依赖 routerMode 参数）', async () => {
  // root：不传 routerMode 也按单一模式装配 Lead 保鲜/架构师工具 + team-lead 段。
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = f.listeners.find((entry) => entry.name === 'agent/created');
  assert.ok(listener !== undefined);
  const rootCalls = [];
  const rootSections = [];
  await listener.listener({ agent: makeAgent({ calls: rootCalls, sections: rootSections }) });
  assert.deepEqual(rootCalls, ['relay_team_status', 'relay_renew', 'relay_architect', 'relay_dispatch', 'relay_collect'], 'root 拿到 Lead 保鲜/架构师/派活/收口工具（v0.9.0 批次3 顺序）');
  assert.ok(rootSections.some((section) => section.name === 'context-relay:team-lead' && section.text === TEAM_LEAD_PROTOCOL_TEXT));
  // teammate
  const teammateCalls = [];
  const teammateSections = [];
  const teammate = makeAgent({ sessionId: 'session-w1', header: { origin: 'subagent', delegationDepth: 1 }, calls: teammateCalls, sections: teammateSections });
  const g = fakeCtx({ agentTeams: { tryMembership: (agent) => (agent === teammate ? { role: 'teammate', name: 'impl-g1' } : undefined) } });
  apply(g.ctx, {});
  await g.listeners.find((entry) => entry.name === 'agent/created').listener({ agent: teammate });
  assert.deepEqual(teammateCalls, ['relay_checkpoint', 'relay_freshen'], '队友拿到 checkpoint + freshen 工具');
  assert.deepEqual(teammateSections.map((section) => section.name), ['context-relay:protocol'], '队友只注入紧凑协议（不再叠第二条 team-worker 段）');
  assert.ok(!teammateCalls.includes('relay_team_status'), '队友不拿 Lead 工具');
  assert.ok(!teammateCalls.includes('relay_dispatch') && !teammateCalls.includes('relay_collect'), '队友不拿派活/收口工具');
  // 架构师：只拿 relay_checkpoint（不拿 dispatch/collect）
  markPendingArchitect(LEAD);
  const architectCalls = [];
  const architect = makeAgent({ sessionId: 'session-arch', header: { origin: 'subagent', delegationDepth: 1, parentSession: LEAD }, calls: architectCalls, sections: [] });
  await g.listeners.find((entry) => entry.name === 'agent/created').listener({ agent: architect });
  assert.deepEqual(architectCalls, ['relay_checkpoint'], '架构师只拿 checkpoint（不拿 dispatch/collect）');
  // v0.10.0：退役 config.routerMode 被静默忽略（无 warn）→ 仍按单一模式装配。
  const c = fakeCtx();
  apply(c.ctx, { routerMode: false });
  assert.equal(c.warns.some((line) => /routerMode/.test(line)), false, '退役配置不再有专用 warn');
  const legacyCalls = [];
  const legacySections = [];
  await c.listeners.find((entry) => entry.name === 'agent/created').listener({ agent: makeAgent({ calls: legacyCalls, sections: legacySections }) });
  assert.deepEqual(legacyCalls, ['relay_team_status', 'relay_renew', 'relay_architect', 'relay_dispatch', 'relay_collect'], '退役配置不影响装配：仍为单一模式');
});

test('装配：delegationGate config（off/非法/strict）不崩；v0.10.0 C14b strict 原样生效（不再 reserved warn）', async () => {
  const off = fakeCtx();
  assert.doesNotThrow(() => apply(off.ctx, { delegationGate: 'off' }));
  assert.equal(off.warns.some((line) => /delegationGate/.test(line)), false, 'off 不产生日志');
  const invalid = fakeCtx();
  assert.doesNotThrow(() => apply(invalid.ctx, { delegationGate: 'banana' }));
  assert.equal(invalid.warns.some((line) => /delegationGate/.test(line)), false, '非法值按缺省 warn 归一（不崩）');
  const strict = fakeCtx();
  assert.doesNotThrow(() => apply(strict.ctx, { delegationGate: 'strict' }));
  assert.equal(strict.warns.some((line) => /delegationGate/.test(line)), false, 'strict 不再归一 warn、不再打 reserved warn（strict 生效 info 日志见 agent.test.mjs）');
});

test('装配/reload：进程内 dispatch 记忆丢失可观测（warn + relay_status.delegation.dispatchMemory）', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    // 上一代插件派过活：工作区有落盘 dispatch 记录。
    const recordDir = join(dir, '.scratch', 'context-relay', 'dispatch', LEAD);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, 'a1.json'), JSON.stringify({ version: 1, itemId: 'a1', scopeId: LEAD, dispatchId: 'd-a1-old' }) + '\n');
    const live = makeAgent({ sessionId: 'session-live', cwd: dir });
    const f = fakeCtx({ agents: { list: () => [live], get: () => live } });
    clearDelegationMemory(); // 插件 reload：上一代卸载清理
    apply(f.ctx, {});
    assert.ok(f.warns.some((line) => /in-memory dispatch memory is empty while 1 persisted dispatch record/.test(line)), 'reload 丢内存必须可观测（warn）');
    const statusTool = f.tools.get('relay_status');
    const report = await statusTool.execute({}, { agent: live });
    assert.equal(report.delegation.dispatchMemory.cleared, true, 'relay_status.delegation.dispatchMemory 可见');
    assert.equal(report.delegation.dispatchMemory.inMemory, 0);
    assert.match(String(report.delegation.dispatchMemory.note), /persisted dispatch records/);
  } finally { clearDelegationMemory(); cleanup(dir); }
});

test('装配：workItems:false 与 delegation-first 协议冲突 → warn 一次（不拒绝装载，C8/C13）', () => {
  const off = fakeCtx();
  assert.doesNotThrow(() => apply(off.ctx, { workItems: false }), '配置组合只 warn，不拒绝装载');
  assert.ok(off.warns.some((line) => /workItems:false conflicts with the delegation-first protocol/.test(line)), '冲突 warn 可见');
  assert.ok(off.warns.some((line) => /relay_dispatch\/relay_collect/.test(line)), 'warn 指明受影响工具');
  const on = fakeCtx();
  apply(on.ctx, {});
  assert.equal(on.warns.some((line) => /workItems:false conflicts/.test(line)), false, '默认开启不告警');
});

// ── v0.10.0：Lead 预算开关继承（spawn 时继承 / freshen 同步） ──────────────

/** 在 fake ctx 上挂 lib/agent.js 的 agent/created 监听器，模拟 rc.2 spawn 创建子会话的瞬间。 */
function installCreatedListener(fake) {
  apply(fake.ctx, {});
  const found = fake.listeners.find((entry) => entry.name === 'agent/created');
  assert.ok(found, 'agent/created listener registered');
  return found.listener;
}

test('relay_renew：spawn 前登记 Lead 预算开关，新队友子会话面板继承（失败也清标记）', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    globalThis[SETTINGS_KEY] = { unlimitedBudget: true };
    updatePanelState(LEAD, { unlimitedBudget: false });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    let createdListener;
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-w1', name: 'impl-g1', role: 'teammate', status: 'inactive', description: '实现' },
        { id: 'session-w2', name: 'review-g1', role: 'teammate', status: 'inactive', description: '审阅' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
      spawnResult: (request) => {
        if (request.name.startsWith('review')) throw new Error('provider boom');
        const child = { session: { id: 'session-' + request.name, header: { origin: 'subagent', delegationDepth: 1, parentSession: LEAD } } };
        createdListener({ agent: child });
        return { member: { id: child.session.id, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } };
      },
    });
    const f = fakeCtx({ agentTeams: teams });
    createdListener = installCreatedListener(f);
    const { leadTools } = createTeamTools(makeRuntime(f.ctx));
    const renew = leadTools.find((tool) => tool.name === 'relay_renew');
    await writeCheckpoint(dir, 'impl', '## 记录\n登录修复完成', LEAD);
    await writeCheckpoint(dir, 'review', '## 记录\n审阅完成', LEAD);
    const result = await renew.execute({ name: 'impl-g1', reason: 'band=organize' }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(panelStateOf('session-impl-g2').unlimitedBudget, false, '子会话继承 Lead false（覆盖全局 true）');
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, 'spawn 结束后标记已清');
    globalThis[SETTINGS_KEY].unlimitedBudget = true;
    assert.equal(panelStateOf('session-impl-g2').unlimitedBudget, false, 'force 显式落库，全局后续变化不翻转');
    // 失败路径：spawn 抛错也要清标记（否则残留 60s 内会误继承下一次 spawn）
    const failed = await renew.execute({ name: 'review-g1' }, { agent: lead });
    assert.equal(failed.ok, false);
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, 'spawn 失败也清标记');
  } finally {
    delete globalThis[SETTINGS_KEY];
    clearSharedMemory();
    cleanup(dir);
  }
});

test('relay_architect：fresh spawn 继承 Lead 预算开关（与 pending 架构师标记同 try/finally 清理）', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    globalThis[SETTINGS_KEY] = { unlimitedBudget: true };
    // 进程级面板 Map 跨测试共享：显式清掉其它用例留下的架构师模型选择，避免走显式白名单校验。
    updatePanelState(LEAD, { unlimitedBudget: false, architectModel: null });
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    let createdListener;
    const teams = makeTeamService({
      members: [{ id: LEAD, name: 'lead', role: 'lead', status: 'running' }],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
      spawnResult: (request) => {
        const child = { session: { id: 'session-' + request.name, header: { origin: 'subagent', delegationDepth: 1, parentSession: LEAD } } };
        createdListener({ agent: child });
        return { member: { id: child.session.id, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } };
      },
    });
    const f = fakeCtx({ agentTeams: teams });
    createdListener = installCreatedListener(f);
    const tool = createTeamTools(makeRuntime(f.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ brief: '设计登录模块', task_id: 'login' }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(panelStateOf('session-architect').unlimitedBudget, false, '架构师子会话继承 Lead false');
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, 'spawn 结束后标记已清');
  } finally {
    delete globalThis[SETTINGS_KEY];
    clearSharedMemory();
    cleanup(dir);
  }
});

test('relay_freshen：复用同会话时同步 Lead 当前预算开关（不回写 Lead）', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    globalThis[SETTINGS_KEY] = { unlimitedBudget: true };
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    updatePanelState(LEAD, { unlimitedBudget: false });
    const teammate = makeAgent({ sessionId: 'session-w1', cwd: dir, header: { parentSession: LEAD } });
    const ctx = fakeCtx({
      agentTeams: makeTeamService({ memberships: new Map([[teammate, membership('teammate', 'impl-g1', lead)]]) }),
      sessionProjections: { snapshot: () => ({ values: { contextPressure: { projectedTokens: 1000, contextWindow: 100000 } } }) },
      tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    });
    const { teammateTools } = createTeamTools(makeRuntime(ctx.ctx));
    const freshen = teammateTools.find((tool) => tool.name === 'relay_freshen');
    await freshen.execute({ phase: 'build', brief: '继续' }, { agent: teammate });
    assert.equal(panelStateOf('session-w1').unlimitedBudget, false, '队友 freshen 时同步 Lead false');
    assert.equal(panelStateOf(LEAD).unlimitedBudget, false, '不回写 Lead');
    updatePanelState(LEAD, { unlimitedBudget: true });
    await freshen.execute({ phase: 'build', brief: '继续' }, { agent: teammate });
    assert.equal(panelStateOf('session-w1').unlimitedBudget, true, 'Lead 改开后下次 freshen 同步 true');
    // 无 parentSession（非 spawn 会话）→ 不同步、不抛；面板继续跟随全局
    const orphan = makeAgent({ sessionId: 'session-w2', cwd: dir });
    const orphanCtx = fakeCtx({ agentTeams: makeTeamService({ memberships: new Map([[orphan, membership('teammate', 'review-g1', lead)]]) }) });
    await createTeamTools(makeRuntime(orphanCtx.ctx)).teammateTools
      .find((tool) => tool.name === 'relay_freshen').execute({ phase: 'build', brief: 'x' }, { agent: orphan });
    assert.equal(panelStateOf('session-w2').unlimitedBudget, true, '无 parentSession 不写面板（跟随全局 true）');
  } finally {
    delete globalThis[SETTINGS_KEY];
    clearSharedMemory();
    cleanup(dir);
  }
});

test('relay_dispatch：spawn 前登记 Lead 预算开关，worker 子会话面板继承', async () => {
  const dir = tempWorkspace();
  clearDelegationMemory();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    globalThis[SETTINGS_KEY] = { unlimitedBudget: true };
    updatePanelState(LEAD, { unlimitedBudget: false });
    let createdListener;
    const { lead, ctx } = dispatchCtx({
      dir,
      spawnResult: (request) => {
        const child = { session: { id: 'session-' + request.name, header: { origin: 'subagent', delegationDepth: 1, parentSession: LEAD } } };
        createdListener({ agent: child });
        return { member: { id: child.session.id, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } };
      },
    });
    createdListener = installCreatedListener(ctx);
    await seedLedger(dir, [{ id: 'a1', title: '实现登录修复', status: 'open' }]);
    const { dispatch } = delegationToolsOf(ctx);
    const result = await dispatch.execute({ ...DISPATCH_ARGS }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.worker.spawned, true, '走 spawn 路径');
    assert.equal(panelStateOf('session-worker-1').unlimitedBudget, false, 'worker 子会话继承 Lead false');
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, 'spawn 结束后标记已清');
  } finally {
    delete globalThis[SETTINGS_KEY];
    clearSharedMemory();
    cleanup(dir);
    clearDelegationMemory();
  }
});

test('relay_architect：mode=continue 复用当前架构师时同步 Lead 当前预算开关（review P2-2）', async () => {
  const dir = tempWorkspace();
  try {
    configurePanelStore({ panelPath: join(dir, 'panel.json') });
    globalThis[SETTINGS_KEY] = { unlimitedBudget: true };
    const lead = makeAgent({ sessionId: LEAD, cwd: dir });
    updatePanelState(LEAD, { unlimitedBudget: false, architectModel: null });
    const teams = makeTeamService({
      members: [
        { id: LEAD, name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-architect', name: 'architect', role: 'teammate', status: 'inactive', description: '专职架构师' },
      ],
      memberships: new Map([[lead, membership('lead', 'lead', lead)]]),
    });
    const f = fakeCtx({ agentTeams: teams });
    const tool = createTeamTools(makeRuntime(f.ctx)).leadTools.find((item) => item.name === 'relay_architect');
    const result = await tool.execute({ mode: 'continue', brief: '继续设计登录模块', task_id: 'login' }, { agent: lead });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(panelStateOf('session-architect').unlimitedBudget, false, 'continue 复用同步 Lead false');
  } finally {
    delete globalThis[SETTINGS_KEY];
    clearSharedMemory();
    cleanup(dir);
  }
});



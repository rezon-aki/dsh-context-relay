/**
 * dsh-context-relay — v0.11 P1-A 宿主自动压缩兜底（设计 §3.5 验收）。
 *
 * 覆盖四态归因夹具、host→快照六类指针+chain 追加+notice 一次、同 compactionSeq 不重发、
 * relay 命中不写、unknown 不写只提示（日志）、off 不写、IO 失败 fail-open、通知优先级不丢。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { appendChainEntry, readChain } from '../lib/agent/chain.js';
import {
  attributeCompaction, buildRecoverySnapshot, recoveryRelativePathOf,
  writeHostCompactionRecovery, RECOVERY_MAX_BYTES,
} from '../lib/agent/compaction-fallback.js';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';

function resetSharedState() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-fallback-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  globalThis[SETTINGS_KEY] = { threshold: 35, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true };
}

function tmpCwd() { return mkdtempSync(join(tmpdir(), 'relay-fallback-')); }

function fakeCtx(services) {
  const tools = new Map();
  const events = [];
  const logs = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: {
      info(message) { logs.push('info ' + message); },
      warn(message) { logs.push('warn ' + message); },
    },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, events, logs };
}

function fakeSession({ id, cwd, log = [] }) {
  return {
    id,
    header: { cwd },
    get seq() { return log.length; },
    snapshotEvents() { return log; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function fakeServices(session, state) {
  return {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens ?? 0 }) },
    compaction: undefined,
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
    sessionQuery: undefined,
  };
}

function harness({ config, log, pressure = { contextWindow: 1_000_000, projectedTokens: 20_000 } } = {}) {
  resetSharedState();
  const cwd = tmpCwd();
  const sessionLog = log ?? [];
  const session = fakeSession({ id: 'session-fallback-' + Math.random().toString(36).slice(2), cwd, log: sessionLog });
  const state = { pressure };
  const bundle = fakeCtx(fakeServices(session, state));
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL, ...(config === undefined ? {} : config) });
  const listener = bundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);
  return { cwd, session, sessionLog, state, bundle, step, injected, agent };
}

const compactionEvent = (seq, compactionId) => ({ type: 'compaction/end', seq, data: { compactionId, turn: seq } });
const noticeText = (message) => message.content[0].text;

// ── 归因纯函数 ─────────────────────────────────────────────────────────

test('P1-A 归因四态：compaction→relay-organize / freshen→relay-freshen / 无命中→host / 无 id→unknown', () => {
  const entries = [
    { kind: 'compaction', compactionId: 'c-relay', sessionId: 's' },
    { kind: 'teammate-freshen', compactionId: 'c-fresh', sessionId: 's' },
    { kind: 'teammate-reset', compactionId: 'c-reset', sessionId: 's' },
    { kind: 'handoff', compactionId: 'c-handoff', sessionId: 's' },
  ];
  assert.equal(attributeCompaction({ compactionId: 'c-relay', entries }), 'relay-organize');
  assert.equal(attributeCompaction({ compactionId: 'c-fresh', entries }), 'relay-freshen');
  assert.equal(attributeCompaction({ compactionId: 'c-reset', entries }), 'relay-freshen');
  assert.equal(attributeCompaction({ compactionId: 'c-other', entries }), 'host');
  assert.equal(attributeCompaction({ compactionId: 'c-handoff', entries }), 'host', '非压缩类条目不算插件主持');
  for (const missing of [undefined, '', '   ', null, 42]) {
    assert.equal(attributeCompaction({ compactionId: missing, entries }), 'unknown');
  }
  // host 兜底自己写的 chain 条目不得回认成 relay-organize。
  assert.equal(attributeCompaction({ compactionId: 'c-host', entries: [{ kind: 'compaction', compactionId: 'c-host', note: 'host-auto-fallback' }] }), 'host');
  // 只回看最近 20 条：更早的同 id 命中不算。
  const older = [{ kind: 'compaction', compactionId: 'c-old' }, ...Array.from({ length: 20 }, (_, index) => ({ kind: 'handoff', compactionId: 'x' + index }))];
  assert.equal(attributeCompaction({ compactionId: 'c-old', entries: older }), 'host');
});

// ── 快照构建/写盘 ──────────────────────────────────────────────────────

test('P1-A 快照：六类指针齐全、≤2KB、sessionId 路径安全', () => {
  const snapshot = buildRecoverySnapshot({
    sessionId: '../../evil/session',
    compactionId: 'c1',
    at: '2026-11-17T00:00:00.000Z',
    phase: 'build',
    goal: '目标'.repeat(500),
    exitCriteria: '验收'.repeat(500),
    ledger: { path: '.scratch/context-relay/work-items/s.json', counts: { pending: 2, total: 3 }, focus: '焦点'.repeat(400) },
    teamPending: ['mate-1', 'mate-2'],
    teamContextPath: '.scratch/context-relay/team-context/s.json',
    progressPath: '.scratch/context-relay/progress.md',
    chainPath: '.scratch/context-relay/chain.ndjson',
  });
  for (const heading of ['宿主自动压缩', '1. 会话与压缩身份', '2. phase / 目标 / 退出条件', '3. 工作台账焦点', '4. 团队待处理', '5. 滚动进度', '6. 链式召回']) {
    assert.ok(snapshot.includes(heading), '快照缺段: ' + heading);
  }
  assert.ok(snapshot.includes('session_event_read'), '召回指引存在');
  assert.ok(Buffer.byteLength(snapshot, 'utf8') <= RECOVERY_MAX_BYTES, 'UTF-8 字节数 ' + Buffer.byteLength(snapshot, 'utf8'));
  assert.equal(recoveryRelativePathOf('../../evil/session'), 'recovery/compaction-.._.._evil_session.md');
  assert.equal(recoveryRelativePathOf(''), 'recovery/compaction-unknown.md');
});

test('P1-A 写盘：快照路径/大小正确 + chain 追加 kind=compaction note=host-auto-fallback', async () => {
  const cwd = tmpCwd();
  const result = await writeHostCompactionRecovery(cwd, {
    sessionId: 'session-write', compactionId: 'c-write', at: '2026-11-17T00:00:00.000Z', phase: 'verify', goal: 'g',
    ledger: { path: '.scratch/context-relay/work-items/session-write.json', counts: { pending: 1, total: 2 }, focus: '焦点行' },
  });
  assert.equal(result.snapshotOk, true);
  assert.equal(result.chainOk, true);
  assert.equal(result.relativePath, '.scratch/context-relay/recovery/compaction-session-write.md');
  const absolute = join(cwd, result.relativePath);
  assert.ok(existsSync(absolute));
  const content = readFileSync(absolute, 'utf8');
  assert.ok(Buffer.byteLength(content, 'utf8') <= RECOVERY_MAX_BYTES);
  assert.match(content, /session-write/);
  assert.match(content, /c-write/);
  assert.match(content, /phase: verify/);
  const chain = readChain(cwd, 20);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].kind, 'compaction');
  assert.equal(chain[0].note, 'host-auto-fallback');
  assert.equal(chain[0].compactionId, 'c-write');
  assert.equal(chain[0].sessionId, 'session-write');
  assert.equal(chain[0].briefPath, result.relativePath);
});

test('P1-A IO 失败 fail-open：快照写失败不抛、chain 仍尝试、结果如实标注', async () => {
  const cwd = tmpCwd();
  // 用同名文件占住 recovery 目录 → 原子写失败。
  mkdirSync(join(cwd, '.scratch', 'context-relay'), { recursive: true });
  writeFileSync(join(cwd, '.scratch', 'context-relay', 'recovery'), 'blocked');
  const result = await writeHostCompactionRecovery(cwd, { sessionId: 'session-io', compactionId: 'c-io', phase: 'build' });
  assert.equal(result.snapshotOk, false, '快照失败');
  assert.ok(typeof result.snapshotError === 'string' && result.snapshotError !== '');
  assert.equal(result.chainOk, true, 'chain 独立成功');
  assert.equal(readChain(cwd, 20).at(-1).compactionId, 'c-io');
});

// ── sentinel 集成 ─────────────────────────────────────────────────────

test('P1-A host：压缩复位→快照+chain+recovery notice 一次；同 compactionSeq 不重发；新压缩再提示', async () => {
  const h = harness();
  await h.step(); // seed（无压缩）：不提示
  assert.equal(h.injected.length, 0);
  h.sessionLog.push(compactionEvent(1, 'auto-1'));
  await h.step();
  assert.equal(h.injected.length, 1, 'host 归因：一条 recovery notice');
  assert.match(h.injected[0].source.summary, /宿主自动压缩兜底/);
  const text = noticeText(h.injected[0]);
  assert.match(text, /宿主自动压缩已发生/);
  assert.match(text, /recovery\/compaction-session-fallback-/);
  assert.match(text, /session_event_read/);
  assert.match(text, /压缩继续/);
  // 快照落盘 ≤2KB + chain 条目。
  const snapshotPath = join(h.cwd, '.scratch', 'context-relay', 'recovery', 'compaction-' + h.session.id + '.md');
  assert.ok(existsSync(snapshotPath), '快照路径 ' + snapshotPath);
  const snapshot = readFileSync(snapshotPath, 'utf8');
  assert.ok(Buffer.byteLength(snapshot, 'utf8') <= RECOVERY_MAX_BYTES);
  assert.match(snapshot, /auto-1/);
  assert.match(snapshot, /6\. 链式召回/);
  const chain = readChain(h.cwd, 20);
  assert.equal(chain.at(-1).compactionId, 'auto-1');
  assert.equal(chain.at(-1).note, 'host-auto-fallback');
  // 同一 compactionSeq 不重发。
  await h.step();
  assert.equal(h.injected.length, 1, '同 compactionSeq 不重发');
  // 新压缩 → 新提示（guard 复位 + 新 seq claim）。
  h.sessionLog.push(compactionEvent(2, 'auto-2'));
  await h.step();
  assert.equal(h.injected.length, 2, '新压缩再提示一次');
  assert.match(noticeText(h.injected[1]), /auto-2|compaction-session-fallback/);
});

test('P1-A relay 归因：chain 同 id（organize/freshen）→ 不写快照、不提示', async () => {
  const h = harness();
  await h.step();
  await appendChainEntry(h.cwd, { kind: 'compaction', sessionId: h.session.id, compactionId: 'relay-1', phase: 'build' });
  h.sessionLog.push(compactionEvent(1, 'relay-1'));
  await h.step();
  assert.equal(h.injected.length, 0, 'relay-organize 归因不提示');
  assert.equal(existsSync(join(h.cwd, '.scratch', 'context-relay', 'recovery', 'compaction-' + h.session.id + '.md')), false, '不写快照');
  // freshen 同理。
  await appendChainEntry(h.cwd, { kind: 'teammate-freshen', sessionId: h.session.id, compactionId: 'relay-2' });
  h.sessionLog.push(compactionEvent(2, 'relay-2'));
  await h.step();
  assert.equal(h.injected.length, 0, 'relay-freshen 归因不提示');
});

test('P1-A unknown：compactionId 缺失不写快照、只 logWarn', async () => {
  const h = harness();
  await h.step();
  h.sessionLog.push({ type: 'compaction/end', seq: 1, data: { turn: 1 } }); // 无 compactionId
  await h.step();
  assert.equal(h.injected.length, 0, 'unknown 不提示');
  assert.equal(existsSync(join(h.cwd, '.scratch', 'context-relay', 'recovery', 'compaction-' + h.session.id + '.md')), false, '不写快照');
  assert.ok(h.bundle.logs.some((line) => line.startsWith('warn ') && line.includes('unknown attribution')), 'unknown 只 logWarn');
});

test('P1-A off：compactionFallback=off → 不归因、不写快照、不提示', async () => {
  const h = harness({ config: { compactionFallback: 'off' } });
  await h.step();
  h.sessionLog.push(compactionEvent(1, 'auto-off'));
  await h.step();
  assert.equal(h.injected.length, 0);
  assert.equal(existsSync(join(h.cwd, '.scratch', 'context-relay', 'recovery', 'compaction-' + h.session.id + '.md')), false);
  assert.equal(readChain(h.cwd, 20).length, 0);
});

test('P1-A IO 失败 fail-open：快照写失败仍发 notice（如实告知）、pre-step 不抛', async () => {
  const h = harness();
  await h.step();
  mkdirSync(join(h.cwd, '.scratch', 'context-relay'), { recursive: true });
  writeFileSync(join(h.cwd, '.scratch', 'context-relay', 'recovery'), 'blocked');
  h.sessionLog.push(compactionEvent(1, 'auto-io'));
  await h.step();
  assert.equal(h.injected.length, 1, '写失败仍提示（fail-open）');
  assert.match(noticeText(h.injected[0]), /最小恢复快照写入失败/);
  assert.ok(h.bundle.logs.some((line) => line.startsWith('warn ') && line.includes('snapshot write failed')), 'IO 失败 logWarn');
});

test('P1-A 通知优先级：到线提示占用本步 → recovery 下一步补，不丢', async () => {
  const h = harness();
  await h.step();
  // 同一 step：压缩复位 + 压力升到 relay（到线/容量优先）；recovery 应让位并下一步补。
  h.state.pressure = { contextWindow: 1_000_000, projectedTokens: 560_000 };
  h.sessionLog.push(compactionEvent(1, 'auto-priority'));
  await h.step();
  assert.equal(h.injected.length, 1, '本步只一条（到线/容量）');
  assert.doesNotMatch(h.injected[0].source.summary, /宿主自动压缩兜底/);
  await h.step();
  assert.equal(h.injected.length, 2, '下一步补 recovery');
  assert.match(h.injected[1].source.summary, /宿主自动压缩兜底/);
});

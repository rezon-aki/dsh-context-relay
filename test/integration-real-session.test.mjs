/**
 * 真实 Session 集成测试（审计 P2#15）：用官方 @deepseek-ai/dsh-session 构造真实会话，
 * 按真实 append 顺序（turn/start → step/start → user/message → assistant/message →
 * tool/call|tool/ptc-dispatch → tool/result → turn/end）驱动 lib/agent.js 的日志派生，
 * 补 fake ctx 单测覆盖不到的：真实事件信封与 surface 校验、compaction checkpoint 替换行、
 * 「只有成功压缩才计数」与「冷启动跨 200 条事件仍能派生哨兵档位」。
 *
 * 官方包不可用（无本机 dsh 安装）时全部用例 skip 并注明原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/agent.js';

const FIRED_KEY = Symbol.for('dsh-context-relay.sentinel.fired');
const NOTICE_TEXT = '[context-relay] band=organize · 自动提醒（插件 notice，非用户发言）· phase=build';
const NOTICE_SUMMARY = '[context-relay] band=organize · phase=build · relay 自动提醒（非用户发言）';

/** 官方 Session 定位：从 `which dsh` realpath 推导安装根（与 test/agent.test.mjs 的 V4 契约测试同法）。 */
async function loadOfficialSession() {
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    const installRoot = dirname(dirname(realpathSync(bin)));
    const entry = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
    if (!existsSync(entry)) return undefined;
    return await import(pathToFileURL(entry).href);
  } catch {
    return undefined;
  }
}

const Session = (await loadOfficialSession())?.Session;
const SKIP = Session === undefined ? 'official @deepseek-ai/dsh-session not found (no local dsh install)' : false;

/** 真实空会话：header 走官方 version 4 校验，不注入 seed（等价 store.create 的初始态）。 */
function newSession() {
  const id = 'integration-' + randomUUID();
  return Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false });
}

function appendUser(session, { text = 'user turn', source = { kind: 'user' } } = {}) {
  return session.append('user/message', { role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source }, { surfaceOp: 'append' });
}

function appendAssistant(session, turn, step) {
  return session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: { role: 'assistant', id: randomUUID(), content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  }, { surfaceOp: 'append' });
}

function appendToolCall(session, turn, step, name, args) {
  const callId = 'call_' + randomUUID();
  session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) });
  return callId;
}

function appendToolResult(session, turn, step, callId, text, options = {}) {
  const data = {
    turn,
    step,
    message: { role: 'tool', id: randomUUID(), source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }], isError: options.isError === true },
  };
  if (options.error !== undefined) data.error = options.error;
  return session.append('tool/result', data, { surfaceOp: 'append' });
}

/** PTC 真实形态：dispatch-start（在途）+ dispatch（完成；content 是工具 render 的文本）。 */
function appendPtcDispatch(session, name, args, text, { isError = false } = {}) {
  const callId = 'call_' + randomUUID();
  const base = { rootCallId: callId, parentCallId: callId, subCallId: callId + ':ptc:1' };
  session.append('tool/ptc-dispatch-start', { ...base, name, arguments: args });
  return session.append('tool/ptc-dispatch', { ...base, name, arguments: args, isError, content: [{ type: 'text', text }] });
}

function fakeServices({ projectedTokens = 20000 } = {}) {
  const state = { pressure: { contextWindow: 1_000_000, projectedTokens } };
  return {
    state,
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens }) },
  };
}

function applyAgent(services, applyFn = apply) {
  const tools = new Map();
  const events = [];
  const cleanups = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      const cleanup = typeof dispose === 'function' ? dispose : () => {};
      cleanups.push(cleanup);
      return cleanup;
    },
    on(name, listener, options) {
      events.push({ name, listener, options });
      return () => {};
    },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  applyFn(ctx, {});
  return { tools, preStep: events.find((event) => event.name === 'agent/pre-step'), cleanups };
}

async function deriveReport(session) {
  const { tools } = applyAgent(fakeServices());
  return tools.get('relay_status').execute({}, { agent: { session, options: {} } });
}

test('real Session: PTC log derives phase and counts only successful organizes', { skip: SKIP }, async () => {
  const session = newSession();
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  appendUser(session);
  appendAssistant(session, 1, 1);
  appendPtcDispatch(session, 'relay_phase', { phase: 'build' }, '{"phase":"build","previous":"discover","summary":"phase → build (was discover)"}');
  // 在途压缩：只有 dispatch-start，没有完成行 → 不计数
  const inFlight = 'call_' + randomUUID();
  session.append('tool/ptc-dispatch-start', { rootCallId: inFlight, parentCallId: inFlight, subCallId: inFlight + ':ptc:1', name: 'relay_organize', arguments: { phase: 'build' } });
  // 成功压缩：计 1（content 文本是 relay_organize 的 summary 渲染）
  appendPtcDispatch(session, 'relay_organize', { phase: 'build', brief: 'k' }, 'organized: freed 1234 tokens; band ok → ok; brief /x; brief injected into context (survives compaction)');
  // 压缩抛错：isError=true → 不计数
  appendPtcDispatch(session, 'relay_organize', { phase: 'build', brief: 'k', force: true }, 'organize failed: boom', { isError: true });
  // below-threshold 拒绝：isError=false 但不是成功压缩 → 不计数
  appendPtcDispatch(session, 'relay_organize', { phase: 'build', brief: 'k' }, 'not organized: below-threshold:ok. Brief (with doc_lint: PASS) written to /x.');
  // 最近一次 completed relay_phase 决定 phase
  appendPtcDispatch(session, 'relay_phase', { phase: 'verify' }, '{"phase":"verify","previous":"build"}');
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  assert.ok(session.seq > 10, '真实事件序列已落盘: ' + session.seq);
  const report = await deriveReport(session);
  assert.equal(report.phase, 'verify', 'phase 取最近 completed relay_phase');
  assert.equal(report.organizeCount, 1, '在途/抛错/拒绝不计数，只计成功压缩');
});

test('real Session: direct tool/call+tool/result rows count only successful organizer results', { skip: SKIP }, async () => {
  const session = newSession();
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  appendUser(session);
  appendAssistant(session, 1, 1);
  const phaseCall = appendToolCall(session, 1, 1, 'relay_phase', { phase: 'verify' });
  appendToolResult(session, 1, 1, phaseCall, '{"phase":"verify","previous":"discover","summary":"phase → verify (was discover)"}');
  const okCall = appendToolCall(session, 1, 2, 'relay_organize', { phase: 'verify', brief: 'k' });
  appendToolResult(session, 1, 2, okCall, 'organized: freed 999 tokens; band organize → ok; brief /x');
  const busyCall = appendToolCall(session, 1, 3, 'relay_organize', { phase: 'verify', brief: 'k', force: true });
  appendToolResult(session, 1, 3, busyCall, 'organize failed (compaction busy, retry after current turn): busy', { isError: true, error: { code: 'busy', message: 'busy' } });
  const refuseCall = appendToolCall(session, 1, 4, 'relay_organize', { phase: 'verify', brief: 'k' });
  appendToolResult(session, 1, 4, refuseCall, 'not organized: below-threshold:ok. Brief (with doc_lint: PASS) written to /x.');
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  const report = await deriveReport(session);
  assert.equal(report.phase, 'verify');
  assert.equal(report.organizeCount, 1, '按 toolCallId 匹配结果，只有成功压缩计数');
});

test('real Session: persisted band suppresses sentinel after plugin re-init beyond 200 events', { skip: SKIP }, async () => {
  delete globalThis[FIRED_KEY];
  const session = newSession();
  // 旧 relay notice 在最前：远超旧实现「只看最近 200 条事件」的窗口
  session.append('user/message', { role: 'user', id: randomUUID(), content: [{ type: 'text', text: NOTICE_TEXT }], source: { kind: 'dsh-context-relay', form: 'notice', summary: NOTICE_SUMMARY } }, { surfaceOp: 'append' });
  for (let index = 0; index < 150; index += 1) {
    session.append('step/start', { turn: 1, step: index + 2 });
    session.append('tool/call', { turn: 1, step: index + 2, callId: 'call_' + randomUUID(), name: 'read', arguments: JSON.stringify({ file_path: '/x' }) });
  }
  assert.ok(session.seq > 300, 'notice 距末尾 >200 条事件: ' + session.seq);

  // 新模块实例 = 插件重建（模块级 SENTINEL_SCAN 冷缓存）
  const coldApply = (await import('../lib/agent.js?cold=' + Date.now())).apply;
  const services = fakeServices({ projectedTokens: 420_000 });
  const { preStep } = applyAgent(services, coldApply);
  assert.ok(preStep !== undefined, 'agent/pre-step listener registered');
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  await preStep.listener({ agent }, async () => undefined);
  // 2026-11-01 phase 优先：持久 notice band=organize 作为 seed → 同档不重复、无重启补催（nag 已删除）。
  assert.equal(injected.length, 0, '持久 band 作为 seed：重启后同档不再补提醒');
  await preStep.listener({ agent }, async () => undefined);
  assert.equal(injected.length, 0, 'seed 不重放');

  // 控制组：同档压力 + 无持久 notice 的新会话 → 监听器确实提醒一次
  const fresh = newSession();
  const injectedFresh = [];
  await preStep.listener({ agent: { session: fresh, inject(message) { injectedFresh.push(message); } } }, async () => undefined);
  assert.equal(injectedFresh.length, 1, '无持久档位的同档会话仍提醒一次');
  assert.match(injectedFresh[0].source.summary, /band=organize/);

  // 该会话升到 relay：升线仍提醒一次（band=relay），之后同档不重复
  services.state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await preStep.listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, '升档仍提醒一次');
  assert.match(injected[0].source.summary, /band=relay/);
  await preStep.listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, '同档不重复');
});

test('real Session: compaction rows and checkpoint surface replacement keep derivation stable', { skip: SKIP }, async () => {
  const session = newSession();
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const userSeq = appendUser(session, { text: 'long history A' }).seq;
  const assistantSeq = appendAssistant(session, 1, 1).seq;
  appendPtcDispatch(session, 'relay_phase', { phase: 'build' }, '{"phase":"build"}');
  appendPtcDispatch(session, 'relay_organize', { phase: 'build', brief: 'k' }, 'organized: freed 1234 tokens; band ok → ok; brief /x');
  const compactStart = session.append('compaction/start', { compactionId: 'compact-1', turn: 1 }).seq;
  const compactSummary = session.append('compaction/summary', { compactionId: 'compact-1', summary: [{ type: 'text', text: 'condensed history' }] }).seq;
  session.append('compaction/end', { compactionId: 'compact-1', turn: 1 });
  // 真实 checkpoint：user/message 以 replace 遮蔽压缩前的 surface 区间；sourceEventSeqs 覆盖全部被遮蔽节点
  const checkpointSeq = session.append('user/message', {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: '[checkpoint] condensed history' }],
    source: { kind: 'compact-checkpoint', compactionId: 'compact-1' },
  }, { surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: assistantSeq }, sourceEventSeqs: [compactStart, compactSummary, userSeq, assistantSeq] }).seq;
  session.append('step/start', { turn: 1, step: 2 });
  appendPtcDispatch(session, 'relay_phase', { phase: 'verify' }, '{"phase":"verify","previous":"build"}');
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  // 真实 surface 折叠生效：checkpoint 遮蔽旧区间
  const nodes = session.surface.nodes;
  assert.ok(nodes.includes(checkpointSeq), 'checkpoint 进入 surface');
  assert.ok(!nodes.includes(userSeq) && !nodes.includes(assistantSeq), '被遮蔽节点退出 surface');

  const report = await deriveReport(session);
  assert.equal(report.phase, 'verify', '压缩后新 phase 仍按最近 completed 派生');
  assert.equal(report.organizeCount, 1, '压缩/替换行不影响组织计数');
});

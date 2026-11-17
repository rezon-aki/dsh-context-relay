import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import {
  LAST_BAND, LEDGER_GUARD, PENDING_CLOSURE, armedBandOf, boundaryStateOf, claimBoundaryNotice,
  clearNoticeMemory, confirmBoundaryNotices, deliverPlan, redactNoticeText, safeTarget,
} from '../lib/agent/notice/deliver.js';

/** C4 投递层（claim 后置/脱敏/边界两段式/压缩复位）+ 采集层修复（M-03/M-11/M-12/M-14/M-21/B-04）集成。 */

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-notice-'));
}

function resetSharedState() {
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  clearPanelMemory();
  clearSentinelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-notice-panel-')), 'panel.json') });
}

function fakeCtx(services) {
  const tools = new Map();
  const sections = [];
  const events = [];
  const logs = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, listener, options) { events.push({ name, listener, options }); return () => {}; },
    logger: { info(message) { logs.push('info ' + message); }, warn(message) { logs.push('warn ' + message); } },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, sections, events, logs };
}

function fakeSession({ id = 'session-notice', cwd, log = [], seq, header } = {}) {
  return {
    id,
    header: header ?? (cwd === undefined ? {} : { cwd }),
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
    ...extra,
  };
  return { services, state };
}

function applyAgent(services, config = {}) {
  const bundle = fakeCtx(services);
  apply(bundle.ctx, config);
  return bundle;
}

function preStepOf(bundle) {
  return bundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
}

function postExecuteOf(bundle) {
  return bundle.events.find((event) => event.name === 'tools/post-execute').listener;
}

/** 直接写一份显式 pathOverride 的台账（与 agent.test 的旧 workspace 级路径同口径）。 */
function writeLedger(cwd, items, { rev = 1, currentPhase } = {}) {
  const path = join(cwd, '.scratch', 'context-relay', 'work-items.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rev, updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'test', ...(currentPhase === undefined ? {} : { currentPhase }), items }, null, 2));
}

// ── 投递层单元 ─────────────────────────────────────────────────────────

test('deliverPlan：claim 后置——注入成功才更新去重键；无 inject/注入抛错不 claim（下一步重试）', () => {
  resetSharedState();
  const notice = { kind: 'phase', text: '[context-relay] band=warn · hi', summary: 'x' };
  const plan = { notice, track: {}, claims: { lastBand: { band: 'warn', compactionSeq: -1 } } };
  const injected = [];
  assert.deepEqual(deliverPlan({ inject: (message) => injected.push(message) }, 'session-claim', plan), { delivered: true, text: notice.text });
  assert.equal(injected.length, 1);
  assert.equal(injected[0].source.form, 'notice');
  assert.deepEqual(LAST_BAND.get('session-claim'), { band: 'warn', compactionSeq: -1 });

  // 没有 inject：不投递、不 claim（保留重试机会）
  const failed = deliverPlan(undefined, 'session-retry', plan);
  assert.equal(failed.delivered, false);
  assert.equal(LAST_BAND.has('session-retry'), false);
  // 重试成功才 claim
  const retried = [];
  assert.equal(deliverPlan({ inject: (message) => retried.push(message) }, 'session-retry', plan).delivered, true);
  assert.equal(LAST_BAND.get('session-retry').band, 'warn');

  // inject 抛错：不 claim
  const throwing = deliverPlan({ inject() { throw new Error('boom'); } }, 'session-throw', plan);
  assert.equal(throwing.delivered, false);
  assert.equal(LAST_BAND.has('session-throw'), false);

  // track 无条件生效（回退档位跟踪不需要投递）
  deliverPlan({}, 'session-track', { notice: null, track: { lastBand: { band: 'ok', compactionSeq: -1 } }, claims: {} });
  assert.deepEqual(LAST_BAND.get('session-track'), { band: 'ok', compactionSeq: -1 });
});

test('notice 脱敏（M-21）：safeTarget 只取首行 + 凭据脱敏；deliver 正文同样脱敏', () => {
  resetSharedState();
  assert.equal(safeTarget('first line\nsecond line'), 'first line');
  assert.equal(safeTarget('  spaced target  '), 'spaced target');
  assert.equal(safeTarget('sk-abcdefghijklmnopqrstuvwx'), '[REDACTED]');
  assert.doesNotMatch(redactNoticeText('Bearer abcdefghijklmnopqrstuvwxyz'), /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redactNoticeText('token: abcdefgh12345'), /abcdefgh12345/);
  assert.doesNotMatch(redactNoticeText('ghp_abcdefghijklmnopqrstuvwxyz0123'), /ghp_/);
  assert.equal(redactNoticeText('phase build · normal text'), 'phase build · normal text', '正常正文不被改动');

  const injected = [];
  const plan = {
    notice: { kind: 'phase', text: '[context-relay] 命中 sk-abcdefghijklmnopqrstuvwx 与 token=abcdefgh12345', summary: 'x' },
    track: {},
    claims: {},
  };
  deliverPlan({ inject: (message) => injected.push(message) }, 'session-redact', plan);
  const text = injected[0].content[0].text;
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwx/);
  assert.doesNotMatch(text, /abcdefgh12345/);
});

test('边界 notice 两段式（A-13/A-15）：先预留不记投递；有注入证据才记；每次真实 crossing 都提示', () => {
  resetSharedState();
  const sessionId = 'session-boundary';
  // 第一次 crossing：预留 → 无证据 → 丢弃（不记 delivered，后续仍可提示）
  assert.equal(claimBoundaryNotice(sessionId, 'build', 'verify'), true);
  assert.equal(claimBoundaryNotice(sessionId, 'build', 'verify'), false, '同一 crossing 只预留一次');
  const empty = fakeSession({ id: sessionId, log: [] });
  assert.deepEqual(confirmBoundaryNotices(sessionId, empty), { confirmed: 0, dropped: 1 });
  assert.deepEqual(boundaryStateOf(sessionId).delivered, []);
  assert.equal(claimBoundaryNotice(sessionId, 'build', 'verify'), true, '未投递成功不永久吞掉此边界');

  // 第二次 crossing：会话事件里有注入证据 → 记 delivered
  const log = [{
    type: 'user/message',
    seq: 3,
    data: {
      content: [{ type: 'text', text: '[context-relay] phase 边界 · build → verify（phase 完成仍超线，非用户发言）· phase=verify band=warn used=40%\n按面板模式「继续」放行本次切换（模式保持）；phase 完成后仍超线，注意下一次继续方式。' }],
      source: { kind: 'dsh-context-relay', form: 'notice', summary: '[context-relay] phase 边界 · band=warn · 完成仍超线（非用户发言）' },
    },
  }];
  const hit = fakeSession({ id: sessionId, log });
  assert.deepEqual(confirmBoundaryNotices(sessionId, hit), { confirmed: 1, dropped: 0 });
  assert.equal(boundaryStateOf(sessionId).delivered.length, 1);

  // A-15：同一 previous→phase 的第三次真实 crossing 仍给提示（旧实现「每会话仅一次」会吞）
  assert.equal(claimBoundaryNotice(sessionId, 'build', 'verify'), true);
  assert.equal(boundaryStateOf(sessionId).counters['build→verify'], 3);
  // user-gate 边界同样两段式
  assert.equal(claimBoundaryNotice(sessionId, 'user-gate', 'ship'), true);
  const userGateLog = [{ type: 'user/message', seq: 9, data: { content: [{ type: 'text', text: '[context-relay] 用户汇报 warning（不阻断，插件 notice，非用户发言）：x' }], source: { kind: 'dsh-context-relay', form: 'notice', summary: 'x' } } }];
  assert.deepEqual(confirmBoundaryNotices(sessionId, fakeSession({ id: sessionId, log: userGateLog })), { confirmed: 1, dropped: 1 }, 'build→verify 无证据被丢弃；user-gate 有证据确认');
  clearNoticeMemory();
});

test('压缩复位（A-04/M-11）：compactionSeq 上升 → band 重新武装 + 清 LEDGER_GUARD/BOUNDARY_NOTICES', () => {
  resetSharedState();
  const sessionId = 'session-compaction';
  LAST_BAND.set(sessionId, { band: 'relay', compactionSeq: -1 });
  LEDGER_GUARD.set(sessionId, { focus: '[台账·build 1/2]', teamSeen: { 'mate-1': 'organize' } });
  claimBoundaryNotice(sessionId, 'build', 'verify');
  // seed：无内存时用持久 notice band 起算（notice 晚于压缩才作数）
  const seeded = armedBandOf('session-seed', { band: 'organize', lastCompactionSeq: 7 });
  assert.deepEqual(seeded, { band: 'organize', compactionSeq: 7, reset: false, seeded: true });
  // 压缩发生：seq 上升
  const armed = armedBandOf(sessionId, { band: undefined, lastCompactionSeq: 12 });
  assert.equal(armed.reset, true);
  assert.equal(armed.band, 'ok', '升线提醒重新武装');
  assert.equal(armed.compactionSeq, 12);
  assert.equal(LEDGER_GUARD.has(sessionId), false, '被遮蔽的焦点/闭环/队友行下一步重注入');
  assert.equal(boundaryStateOf(sessionId).pending.length, 0, '边界键随压缩复位');
  // 投递成功后 claim 的新 compactionSeq 写回（claim 后置）→ 同一压缩只复位一次
  LAST_BAND.set(sessionId, { band: 'ok', compactionSeq: 12 });
  assert.equal(armedBandOf(sessionId, { lastCompactionSeq: 12 }).reset, false, '同一压缩只复位一次');
  clearNoticeMemory();
});

test('压缩复位清 planeSig：平面降级 guard 被压缩遮蔽 → 下一步重新提示（C15/§5）', () => {
  resetSharedState();
  const sessionId = 'session-compaction-plane';
  LAST_BAND.set(sessionId, { band: 'ok', compactionSeq: -1 });
  LEDGER_GUARD.set(sessionId, { planeSig: JSON.stringify(['lead', false, [['tools', 'degraded', 'x']]]) });
  const armed = armedBandOf(sessionId, { lastCompactionSeq: 5 });
  assert.equal(armed.reset, true);
  assert.equal(LEDGER_GUARD.has(sessionId), false, '压缩后平面降级 guard 一并复位');
  clearNoticeMemory();
});

// ── 采集/编排集成（apply 装配 + 真实 pre/post 监听） ─────────────────────

test('M-03/B-02：只读 bash/pwsh 成功不再触发 [闭环]；write/edit 才记「改动未落账」', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // [闭环] 只在台账有未闭合分点时提示（用户 2026-11-16 反馈）→ 先建一条 doing 分点再测可执行场景。
  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }], { currentPhase: { phase: 'build', since: 1 } });
  const session = fakeSession({ id: 'session-m03', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const pre = preStepOf(bundle);
  const post = postExecuteOf(bundle);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => pre({ agent }, async () => undefined);
  await step(); // 首步：焦点行（台账已有未闭合分点）
  assert.equal(injected.length, 1);

  await post({ name: 'bash', agent, arguments: { command: 'grep -rn foo . && cat x' } }, { isError: false }, async () => undefined);
  await post({ name: 'pwsh', agent, arguments: { command: 'Get-ChildItem -Recurse' } }, { isError: false }, async () => undefined);
  await step();
  assert.equal(injected.length, 1, '只读侦察不再每步叠加 ~233 字符闭环误报');
  assert.equal(PENDING_CLOSURE.has(session.id), false);

  await post({ name: 'write', agent, arguments: { file_path: '/tmp/dir/x.js' } }, { isError: false }, async () => undefined);
  await post({ name: 'edit', agent, arguments: { file_path: 'lib/y.js' } }, { isError: false }, async () => undefined);
  await step();
  assert.equal(injected.length, 2);
  assert.match(injected[1].content[0].text, /\[闭环\] 上一步改动未落账：write\(x\.js\) \/ edit\(y\.js\)/);

  // apply_patch：target 取 patch 头目标文件（不把补丁正文带进历史）
  await post({
    name: 'apply_patch',
    agent,
    arguments: { input: '*** Begin Patch\n*** Update File: src/z.js\n@@\n-a\n+b\n*** End Patch' },
  }, { isError: false }, async () => undefined);
  await step();
  assert.match(injected[2].content[0].text, /apply_patch\(z\.js\)/);
});

test('M-21：闭环 target 只取首行 + 凭据脱敏（命令/路径片段不原样进会话历史）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // [闭环] 只在台账有未闭合分点时提示（用户 2026-11-16 反馈）→ 先建一条 doing 分点。
  writeLedger(cwd, [{ id: 'p1', title: '修', status: 'doing', next: 'x', phase: 'build' }], { currentPhase: { phase: 'build', since: 1 } });
  const session = fakeSession({ id: 'session-m21', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const pre = preStepOf(bundle);
  const post = postExecuteOf(bundle);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => pre({ agent }, async () => undefined);
  await step(); // 首步：焦点行
  assert.equal(injected.length, 1);
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/secret\nsecond-line-should-not-leak.js' } }, { isError: false }, async () => undefined);
  await step();
  const text = injected[1].content[0].text;
  assert.match(text, /write\(secret\)/, 'target 只留首行');
  assert.doesNotMatch(text, /second-line-should-not-leak/);

  await post({ name: 'write', agent, arguments: { file_path: '/tmp/sk-abcdefghijklmnopqrstuvwx.js' } }, { isError: false }, async () => undefined);
  await step();
  const redacted = injected[2].content[0].text;
  assert.match(redacted, /\[REDACTED\]/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwx/, '凭据片段不进入 notice/历史');
});

test('B-04：只读 relay_work_items 不再清 pending；写入型（items / mode=replace）才清并停发闭环', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // 先建一条未闭合分点：否则「无台账/全 done」时 [闭环] 本就抑制（用户 2026-11-16 反馈），测不到 B-04 差异。
  writeLedger(cwd, [{ id: 'p1', title: '修', status: 'doing', next: 'x', phase: 'build' }], { currentPhase: { phase: 'build', since: 1 } });
  const session = fakeSession({ id: 'session-b04', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const pre = preStepOf(bundle);
  const post = postExecuteOf(bundle);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => pre({ agent }, async () => undefined);

  await step(); // 首步：焦点行
  assert.equal(injected.length, 1);
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/a.js' } }, { isError: false }, async () => undefined);
  await step();
  assert.equal(injected.length, 2);
  assert.match(injected[1].content[0].text, /\[闭环\] 上一步改动未落账：write\(a\.js\)/);
  // 只读台账（无参）：不清 pending
  await post({ name: 'relay_work_items', agent, arguments: {} }, { isError: false, mode: 'read' }, async () => undefined);
  assert.notEqual(PENDING_CLOSURE.has(session.id), false, '只读不再清 pending');
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/b.js' } }, { isError: false }, async () => undefined);
  await step();
  assert.match(injected[2].content[0].text, /write\(a\.js\) \/ write\(b\.js\)/, '未落账签名累积（只读没有清）');

  // 写入型调用（items 整表替换）：清 pending → 下一次只提示新改动。
  // 用真实写盘模拟「落账 + 开下一条 doing 分点」：闭环提示依赖台账仍有未闭合分点（用户 2026-11-16 反馈），
  // 只清内存不落盘的假台账会掩盖「落账后没有分点可落账」的真实路径。
  await post({ name: 'relay_work_items', agent, arguments: { items: [] } }, { isError: false, mode: 'replace' }, async () => undefined);
  writeLedger(cwd, [{ id: 'p2', title: '新活', status: 'doing', next: 'y', phase: 'build' }], { rev: 2, currentPhase: { phase: 'build', since: 2 } });
  assert.equal(PENDING_CLOSURE.has(session.id), false);
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/c.js' } }, { isError: false }, async () => undefined);
  await step();
  assert.match(injected[3].content[0].text, /\[台账·build 0\/1\] doing「新活」next「y」/);
  assert.match(injected[3].content[0].text, /\[闭环\] 上一步改动未落账：write\(c\.js\)/);
});

test('闭环抑制：台账全部 done（ship）→ 焦点行/[闭环] 都不再出现；出现 doing 分点后恢复提醒', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-closure-done', cwd, seq: 0 });
  writeLedger(cwd, [{ id: 'p1', title: '收尾', status: 'done', phase: 'ship' }], { currentPhase: { phase: 'ship', since: 1 } });
  const bundle = applyAgent(fakeServices({ session }).services, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const pre = preStepOf(bundle);
  const post = postExecuteOf(bundle);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/done.js' } }, { isError: false }, async () => undefined);
  await pre({ agent }, async () => undefined);
  const first = injected.map((message) => message.content[0].text).join('\n');
  assert.equal(injected.length, 0, 'ship 全闭环 + 无可落账分点：没有任何可执行提醒');
  assert.doesNotMatch(first, /\[闭环\]/, '全部 done → 不再催闭环');
  assert.doesNotMatch(first, /可以关 phase（relay_phase）/, 'ship 已收尾，不再催 relay_phase');
  assert.equal(PENDING_CLOSURE.has(session.id), false, 'pre-step 清掉「无分点可落账」的待落账标记');
  // 重新开一个 doing 分点后：焦点/闭环恢复提醒（可执行）
  writeLedger(cwd, [{ id: 'p2', title: '新活', status: 'doing', next: 'x', phase: 'build' }], { currentPhase: { phase: 'build', since: 2 } });
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/open.js' } }, { isError: false }, async () => undefined);
  await pre({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /\[台账·build 0\/1\] doing「新活」next「x」/);
  assert.match(injected[0].content[0].text, /\[闭环\] 上一步改动未落账：write\(open\.js\)/);
});

test('闭环抑制：无台账文件 → 写文件不再催落账（无处落账）；先建 open 分点后照常提醒', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-closure-no-ledger', cwd, seq: 0 });
  const bundle = applyAgent(fakeServices({ session }).services, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const pre = preStepOf(bundle);
  const post = postExecuteOf(bundle);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/x.js' } }, { isError: false }, async () => undefined);
  await pre({ agent }, async () => undefined);
  assert.equal(injected.length, 0, '无台账：没有分点可落账 → 不提示');
  assert.equal(PENDING_CLOSURE.has(session.id), false, 'pre-step 清掉「无处落账」的待落账标记（防陈年改动重提）');
  // 真实场景：先建一条 open 分点，闭环提醒才可执行
  writeLedger(cwd, [{ id: 'p1', title: '新活', status: 'open', phase: 'build' }], { currentPhase: { phase: 'build', since: 1 } });
  await post({ name: 'write', agent, arguments: { file_path: '/tmp/open.js' } }, { isError: false }, async () => undefined);
  await pre({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.match(text, /\[台账·build 0\/1\] 未领取：open「新活」/);
  assert.match(text, /\[闭环\] 上一步改动未落账：write\(open\.js\)/);
});

test('M-12：队友到线 notice 不含 Lead 台账行/计数，也不教用被裁的 relay_work_items', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'p1', title: 'Lead 的活', status: 'doing', next: 'x', phase: 'build' }], { currentPhase: { phase: 'build', since: 1 } });
  const sub = fakeSession({ id: 'session-m12', cwd, header: { cwd, origin: 'subagent' } });
  const bundle = applyAgent(fakeServices({ session: sub, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services, { workItemsPath: '.scratch/context-relay/work-items.json' });
  const injected = [];
  await preStepOf(bundle)({ agent: { session: sub, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.match(text, /队友会话·到线请示/);
  assert.doesNotMatch(text, /工作台账/);
  assert.doesNotMatch(text, /relay_work_items/);
  assert.doesNotMatch(text, /共 1/);
});

test('M-14：指标不可用（投影/计量均缺）一次性保守提示，不静默当 ok；同段不重复', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-m14', cwd: tmpCwd(), seq: 0 });
  const { services } = fakeServices({ session });
  services.sessionProjections = { snapshot: () => ({ values: {} }) };
  delete services.tokenMeter;
  const bundle = applyAgent(services);
  const pre = preStepOf(bundle);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  await pre({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /上下文指标不可用/);
  assert.match(injected[0].content[0].text, /不当作 ok/);
  await pre({ agent }, async () => undefined);
  assert.equal(injected.length, 1, '每段只提示一次');
});

test('M-11/A-04：压缩后 focus/上下文 guard 复位 → 同一条焦点行重新注入（不再永久丢）；每步仍只一条', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeLedger(cwd, [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }], { currentPhase: { phase: 'build', since: 1 } });
  const log = [];
  const session = fakeSession({ id: 'session-m11', cwd, log });
  // P1-A（v0.11）默认 on 会在压缩复位时额外发 recovery notice；本用例只验台账 guard 复位，关掉兜底隔离。
  const bundle = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services, { workItemsPath: '.scratch/context-relay/work-items.json', compactionFallback: 'off' });
  const pre = preStepOf(bundle);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = () => pre({ agent }, async () => undefined);

  await step(); // 升线 organize：band notice（已知盖上下文行）
  assert.equal(injected.length, 1);
  assert.match(injected[0].source.summary, /band=organize/);
  await step(); // 焦点行补一次（band 行已被上一条覆盖）
  assert.equal(injected.length, 2);
  assert.match(injected[1].content[0].text, /\[台账·build 0\/1\]/);
  await step(); // 无变化：静默
  assert.equal(injected.length, 2);

  // 成功压缩（compactionSeq 上升）→ 被遮蔽的焦点/上下文键复位
  log.push({ type: 'compaction/end', seq: 10, data: { compactionId: 'c1', turn: 1 } });
  await step();
  assert.equal(injected.length, 3, '压缩后重新武装：到线提醒再来一次（且只有一条）');
  assert.match(injected[2].source.summary, /band=organize/);
  await step();
  assert.equal(injected.length, 4, '压缩后焦点行重新注入（guard 已复位）');
  assert.match(injected[3].content[0].text, /\[台账·build 0\/1\]/);
  await step();
  assert.equal(injected.length, 4, '复位后同内容仍去重');
});

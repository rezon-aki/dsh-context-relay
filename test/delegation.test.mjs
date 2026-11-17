import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_EXEC_RATIO_MAX,
  DELEGATION_MIN_CALLS,
  DELEGATION_GATE_DEFAULT,
  DELEGATION_GATE_MODES,
  DISPATCH_CANDIDATE_LIMIT,
  DISPATCH_HEALTHS,
  dispatchScoreOf,
  rankDispatchCandidates,
  DELEGATION_REPORT_DIR,
  DELEGATION_REPORT_READ_BYTES,
  DELEGATION_DIGEST_CHARS,
  normalizeDelegationConfig,
  isLeadOwner,
  hasLeadExecEvidence,
  leadOwnedPoints,
  delegationGateCheck,
  delegationAdvice,
  delegationSnapshot,
  validateDispatchArgs,
  composeDispatchBrief,
  parseReportHead,
  digestOf,
  reportPathOf,
  dispatchIdOf,
  nextDispatchId,
  dispatchRecordPathOf,
  receiptFreshnessOf,
  registerDispatchMemoryProbe,
  dispatchMemoryState,
  DELEGATION_DISPATCH_DIR,
} from '../lib/agent/delegation.js';

const SESSION = 'session-lead-1';

/** 台账条目（work-items.js 归一后的字段形状；只关心本模块用到的字段）。 */
function item(id, phase, overrides = {}) {
  return {
    id,
    title: id,
    status: 'done',
    owner: null,
    next: null,
    blocked: null,
    evidence: [],
    acceptance: null,
    depends: [],
    phase,
    ...overrides,
  };
}

function ledgerOf(items, extra = {}) {
  return { ok: true, exists: true, rev: 1, currentPhase: null, counts: {}, items, ...extra };
}

function executionOf(exec, total) {
  return { calls: exec, total, ratio: total > 0 ? Math.round((exec / total) * 1000) / 1000 : 0 };
}

const VALID_DISPATCH = {
  itemId: 'a1',
  brief: '实现 X 分点并把回执写到报告文件',
  docs: ['docs/A.md（when/role：开工前读）', 'lib/x.js（接口真源）'],
  writeScope: ['lib/x.js', 'test/x.test.mjs'],
  acceptance: 'node --test test/x.test.mjs 全绿',
};

// ---------- 常量与配置归一 ----------

test('常量口径：阈值/样本下限/默认档/回执目录与读取上限单源', () => {
  assert.equal(DELEGATION_EXEC_RATIO_MAX, 0.2);
  assert.equal(DELEGATION_MIN_CALLS, 10);
  assert.equal(DELEGATION_GATE_DEFAULT, 'warn');
  assert.deepEqual([...DELEGATION_GATE_MODES], ['warn', 'off', 'strict']);
  assert.ok(Object.isFrozen(DELEGATION_GATE_MODES));
  assert.equal(DELEGATION_REPORT_DIR, '.scratch/context-relay/reports');
  assert.equal(DELEGATION_REPORT_READ_BYTES, 65536);
  assert.equal(DELEGATION_DIGEST_CHARS, 600);
});

test('dispatchScoreOf：score=healthRank*10+bandRank；running/不可用档 → null', () => {
  assert.equal(dispatchScoreOf({ health: 'fresh', band: 'ok' }), 0);
  assert.equal(dispatchScoreOf({ health: 'fresh', band: 'warn' }), 1);
  assert.equal(dispatchScoreOf({ health: 'watch', band: 'ok' }), 10);
  assert.equal(dispatchScoreOf({ health: 'watch', band: 'warn' }), 11);
  assert.equal(dispatchScoreOf({ health: 'fresh', band: 'ok', status: 'running' }), null);
  assert.equal(dispatchScoreOf({ health: 'unknown', band: 'unavailable' }), null);
  assert.equal(dispatchScoreOf({ health: 'fresh', band: 'unavailable' }), null, 'band 不可用即使显式 health=fresh 也不可自动复用');
  assert.equal(dispatchScoreOf({ health: 'stale', band: 'organize' }), null);
  assert.equal(dispatchScoreOf({ health: 'watch', band: 'unknown' }), null);
  assert.equal(dispatchScoreOf({}), null);
});

test('rankDispatchCandidates：排除 unavailable/unknown/running；score → rosterKnown → name 确定性排序', () => {
  const ranked = rankDispatchCandidates([
    { name: 'b-watch', health: 'watch', band: 'ok' },
    { name: 'a-warn', health: 'fresh', band: 'warn' },
    { name: 'z-fresh', health: 'fresh', band: 'ok' },
    { name: 'a-fresh', health: 'fresh', band: 'ok' },
    { name: 'known-late', health: 'fresh', band: 'ok', rosterKnown: true },
    { name: 'dirty', health: 'unknown', band: 'unavailable' },
    { name: 'unknown-band', health: 'unknown', band: 'unknown' },
    { name: 'busy', health: 'fresh', band: 'ok', status: 'running' },
  ]);
  assert.deepEqual(ranked.map((row) => row.name), ['known-late', 'a-fresh', 'z-fresh', 'a-warn', 'b-watch']);
  assert.deepEqual(ranked.map((row) => row.score), [0, 0, 0, 1, 10]);
  assert.ok(ranked.every((row) => DISPATCH_HEALTHS.includes(row.health)), '只保留 fresh/watch');
  assert.equal(DISPATCH_CANDIDATE_LIMIT, 12);
  assert.deepEqual(rankDispatchCandidates(null), []);
});

test('normalizeDelegationConfig：默认 warn；off / strict 原样保留（v0.10.0 C14b strict 生效）；非法 → warn', () => {
  assert.deepEqual(normalizeDelegationConfig(), { gate: 'warn' });
  assert.deepEqual(normalizeDelegationConfig({}), { gate: 'warn' });
  assert.deepEqual(normalizeDelegationConfig(null), { gate: 'warn' });
  assert.deepEqual(normalizeDelegationConfig({ delegationGate: 'warn' }), { gate: 'warn' });
  assert.deepEqual(normalizeDelegationConfig({ delegationGate: 'off' }), { gate: 'off' });
  // v0.10.0 C14b：strict 不再归一为 warn（v0.9.0 的 requestedStrict 标记已删，config.patch 路径原样生效）。
  assert.deepEqual(normalizeDelegationConfig({ delegationGate: 'strict' }), { gate: 'strict' });
  for (const bad of ['STRICT', 'on', '', 123, null, true, {}]) {
    assert.deepEqual(normalizeDelegationConfig({ delegationGate: bad }), { gate: 'warn' }, '非法值归一 warn：' + String(bad));
  }
});

// ---------- 台账 owner / lead-exec ----------

test('isLeadOwner：null/空/lead/self/根会话 id 视为 Lead 所有，worker 名不算', () => {
  for (const owner of [undefined, null, '', '   ', 'lead', 'Lead', ' self ', SESSION]) {
    assert.equal(isLeadOwner(owner, SESSION), true, '应为 Lead 所有：' + String(owner));
  }
  assert.equal(isLeadOwner('worker-1', SESSION), false);
  assert.equal(isLeadOwner('session-other', SESSION), false);
  assert.equal(isLeadOwner(42, SESSION), false);
});

test('hasLeadExecEvidence：前缀 + 非空原因（大小写不敏感），空原因/非数组/非字符串忽略', () => {
  assert.equal(hasLeadExecEvidence([]), false);
  assert.equal(hasLeadExecEvidence(undefined), false);
  assert.equal(hasLeadExecEvidence(null), false);
  assert.equal(hasLeadExecEvidence('lead-exec: x'), false);
  assert.equal(hasLeadExecEvidence(['lead-exec: 单行修复断链 URL，无 worker 可派']), true);
  assert.equal(hasLeadExecEvidence(['x', 'lead-exec:\u00a0原因']), true, '原因前空白也算非空');
  assert.equal(hasLeadExecEvidence(['Lead-Exec: 大小写不敏感']), true);
  assert.equal(hasLeadExecEvidence(['lead-exec:']), false, '原因为空拒');
  assert.equal(hasLeadExecEvidence(['lead-exec:    ']), false);
  assert.equal(hasLeadExecEvidence(['prefix lead-exec: x']), false, '必须是前缀');
  assert.equal(hasLeadExecEvidence([1, null, 'lead-exec: ok']), true, '非字符串条目忽略');
});

test('leadOwnedPoints：只收 build/verify 非 blocked 的 Lead 所有分点，phase 缺失回退 currentPhase', () => {
  const ledger = ledgerOf([
    item('a1', 'build', { owner: null }),
    item('a2', 'verify', { owner: 'lead' }),
    item('a3', 'build', { owner: 'worker-1' }),
    item('a4', 'build', { owner: 'self', evidence: ['lead-exec: x'] }),
    item('a5', 'build', { owner: null, status: 'blocked' }),
    item('a6', null, { owner: '' }),
    item('a7', 'ship', { owner: null }),
    item('a8', 'discover', { owner: SESSION }),
  ], { currentPhase: { phase: 'build', goal: null, exitCriteria: null } });
  const own = leadOwnedPoints(ledger, SESSION);
  assert.deepEqual(own.leadOwnedIds, ['a1', 'a2', 'a4', 'a6']);
  assert.deepEqual(own.points, [
    { id: 'a1', status: 'done' },
    { id: 'a2', status: 'done' },
    { id: 'a4', status: 'done' },
    { id: 'a6', status: 'done' },
  ]);
  // 空/不存在台账安全返回空
  assert.deepEqual(leadOwnedPoints(null, SESSION), { leadOwnedIds: [], points: [] });
  assert.deepEqual(leadOwnedPoints({ exists: false, items: [item('x1', 'build')] }, SESSION), { leadOwnedIds: [], points: [] });
  assert.deepEqual(leadOwnedPoints(ledgerOf([]), SESSION), { leadOwnedIds: [], points: [] });
});

// ---------- build→verify 委派闸门（三档） ----------

test('delegationGateCheck：仅 build→verify 触发；其他切换/无参数恒空结果', () => {
  const ratioLedger = ledgerOf([item('a1', 'build', { owner: 'worker-1' })]);
  const execution = executionOf(50, 100);
  for (const pair of [[undefined, undefined], ['discover', 'build'], ['verify', 'ship'], ['build', 'ship']]) {
    const result = delegationGateCheck({ from: pair[0], to: pair[1], execution, ledger: ratioLedger, sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.stats, { execRatio: 0, calls: { exec: 0, total: 0 }, leadOwned: [] });
  }
});

test('delegationGateCheck off：命中条件也不查、不产出 warning', () => {
  const ledger = ledgerOf([item('a1', 'build', { owner: null })]);
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(50, 100), ledger, sessionId: SESSION, mode: 'off' });
  assert.deepEqual(result, { ok: true, warnings: [], stats: { execRatio: 0, calls: { exec: 0, total: 0 }, leadOwned: [] } });
});

test('delegationGateCheck warn：执行占比超阈值且样本 ≥10 → lead-exec-ratio（warn 不拒绝）', () => {
  const ledger = ledgerOf([item('a1', 'build', { owner: 'worker-1' })]);
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(151, 289), ledger, sessionId: SESSION, mode: 'warn' });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'lead-exec-ratio');
  assert.equal(result.warnings[0].message, 'build 阶段 Lead 执行占比 52%（151/289，阈值 20%）：分点应派 worker（relay_dispatch），你只做决策/验收抽样');
  assert.equal(result.stats.execRatio, 0.522);
  assert.deepEqual(result.stats.calls, { exec: 151, total: 289 });
  assert.deepEqual(result.stats.leadOwned, []);
  assert.equal(result.code, undefined);
});

test('delegationGateCheck warn：样本 <10 / 占比等于阈值 / 未超阈值 → 不报 lead-exec-ratio', () => {
  const ledger = ledgerOf([item('a1', 'build', { owner: 'worker-1' })]);
  const base = { from: 'build', to: 'verify', ledger, sessionId: SESSION, mode: 'warn' };
  assert.deepEqual(delegationGateCheck({ ...base, execution: executionOf(5, 9) }).warnings, [], '样本不足不判（D2=A）');
  assert.deepEqual(delegationGateCheck({ ...base, execution: executionOf(2, 10) }).warnings, [], 'ratio=0.2 未超过阈值');
  assert.deepEqual(delegationGateCheck({ ...base, execution: executionOf(10, 100) }).warnings, [], 'ratio=0.1 不报');
});

test('delegationGateCheck warn：Lead 所有 build/verify 分点无 lead-exec → lead-owned-points；worker/有证据/blocked/别 phase 不报', () => {
  const ledger = ledgerOf([
    item('b1', 'build', { owner: null }),
    item('b2', 'verify', { owner: 'lead' }),
    item('b3', 'build', { owner: null, evidence: ['lead-exec: 单行修复，无 worker 可派'] }),
    item('b4', 'build', { owner: null, status: 'blocked', blocked: '等用户裁决' }),
    item('b5', 'build', { owner: 'worker-1' }),
    item('b6', 'ship', { owner: null }),
  ], { currentPhase: { phase: 'build', goal: null, exitCriteria: null } });
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(0, 20), ledger, sessionId: SESSION, mode: 'warn' });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'lead-owned-points');
  assert.match(result.warnings[0].message, /b1, b2/);
  assert.match(result.warnings[0].message, /lead-exec:<原因>/);
  assert.ok(!result.warnings[0].message.includes('b3'), 'b3 有 lead-exec 证据：不进 warning');
  // P2-4：stats.leadOwned = Lead 所有 build/verify 分点 id 全集（含已有 lead-exec 证据的 b3；blocked/worker/别 phase 不计）。
  assert.deepEqual(result.stats.leadOwned, ['b1', 'b2', 'b3']);
  assert.deepEqual(result.stats.leadOwned.filter((id) => ['b1', 'b2'].includes(id)), ['b1', 'b2']);
});

test('delegationGateCheck warn：分点无 item.phase 时回退台账 currentPhase.phase', () => {
  const ledger = ledgerOf([item('c1', null, { owner: null })], { currentPhase: { phase: 'verify', goal: null, exitCriteria: null } });
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(0, 20), ledger, sessionId: SESSION, mode: 'warn' });
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.stats.leadOwned, ['c1']);
});

test('delegationGateCheck warn：两类条件同时命中 → 两条 warning（顺序 ratio → points），warn 仍放行', () => {
  const ledger = ledgerOf([item('d1', 'build', { owner: null })]);
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(30, 60), ledger, sessionId: SESSION, mode: 'warn' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['lead-exec-ratio', 'lead-owned-points']);
});

test('delegationGateCheck strict：命中 → ok:false + code delegation-gate + message；干净 → 放行', () => {
  const ledger = ledgerOf([item('e1', 'build', { owner: null })]);
  const refused = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(30, 60), ledger, sessionId: SESSION, mode: 'strict' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'delegation-gate');
  assert.equal(refused.warnings.length, 2);
  assert.match(refused.message, /Lead 执行占比 50%/);
  assert.match(refused.message, /lead-exec/);
  // 干净台账 + 低占比：strict 放行
  const cleanLedger = ledgerOf([item('e2', 'build', { owner: 'worker-1' })]);
  const clean = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(1, 20), ledger: cleanLedger, sessionId: SESSION, mode: 'strict' });
  assert.equal(clean.ok, true);
  assert.equal(clean.code, undefined);
});

test('v0.10.0 C14b：config strict 原样生效——命中即拒（warn 同触发项仍放行）', () => {
  const ledger = ledgerOf([item('s1', 'build', { owner: null })]);
  const triggered = { from: 'build', to: 'verify', execution: executionOf(30, 60), ledger, sessionId: SESSION };
  const strict = delegationGateCheck({ ...triggered, mode: normalizeDelegationConfig({ delegationGate: 'strict' }).gate });
  assert.equal(strict.ok, false, 'strict：命中即拒');
  assert.equal(strict.code, 'delegation-gate');
  assert.match(strict.message, /Lead 执行占比 50%/);
  const warn = delegationGateCheck({ ...triggered, mode: normalizeDelegationConfig({ delegationGate: 'warn' }).gate });
  assert.equal(warn.ok, true, 'warn：同触发项只提醒、放行');
  assert.equal(warn.warnings.length, 2);
  assert.equal(warn.code, undefined);
});

test('delegationGateCheck：tools 缺省 mode → warn；ids 超过 8 条截断并写「等 N 条」', () => {
  const items = [];
  for (let index = 1; index <= 9; index += 1) items.push(item('p' + index, 'build', { owner: null }));
  const ledger = ledgerOf(items);
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: executionOf(0, 10), ledger, sessionId: SESSION });
  assert.equal(result.ok, true, '缺省档为 warn');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /p1, p2, p3, p4, p5, p6, p7, p8 等 9 条/);
  assert.deepEqual(result.stats.leadOwned.length, 9);
});

test('delegationGateCheck：execution 兼容投影计数 {executionCalls,toolCalls} 形态', () => {
  const ledger = ledgerOf([item('a1', 'build', { owner: 'worker-1' })]);
  const result = delegationGateCheck({ from: 'build', to: 'verify', execution: { executionCalls: 15, toolCalls: 50 }, ledger, sessionId: SESSION, mode: 'warn' });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'lead-exec-ratio');
  assert.deepEqual(result.stats.calls, { exec: 15, total: 50 });
});

// ---------- delegation advice / snapshot ----------

test('delegationAdvice：四规则按序（样本不足 → 超阈值 → 空闲未派 → 空串）', () => {
  assert.equal(
    delegationAdvice({ execution: executionOf(5, 9), dispatchCount: 0, idleWorkers: 3 }),
    '样本不足（<10 次工具调用）：指标仅参考；执行工作一律先 relay_dispatch 派活。',
  );
  assert.equal(
    delegationAdvice({ execution: executionOf(3, 10), dispatchCount: 2, idleWorkers: 0 }),
    'Lead 执行占比 30%（3/10，阈值 20%，warn 档）：把剩余执行工作用 relay_dispatch 派给 worker；你只做交互/决策/派活/验收抽样。',
  );
  assert.equal(
    delegationAdvice({ execution: executionOf(0, 10), dispatchCount: 0, idleWorkers: 2 }),
    '有 2 个空闲队友且本会话 0 次 relay_dispatch：先派活，不要自己写。',
  );
  assert.equal(delegationAdvice({ execution: executionOf(0, 10), dispatchCount: 1, idleWorkers: 2 }), '', '已派过活不再提示');
  assert.equal(delegationAdvice({ execution: executionOf(0, 10), dispatchCount: 0, idleWorkers: null }), '', '团队不可用（null）不猜');
  assert.equal(delegationAdvice(), '样本不足（<10 次工具调用）：指标仅参考；执行工作一律先 relay_dispatch 派活。');
});

test('delegationSnapshot：字段齐全、execRatio 3 位小数、idleWorkers null 保留', () => {
  const snapshot = delegationSnapshot({ execution: executionOf(3, 57), dispatchCount: 2, collectCount: 1, idleWorkers: 5, projectedAvailable: true });
  assert.deepEqual(Object.keys(snapshot), ['execRatio', 'calls', 'dispatchCount', 'collectCount', 'idleWorkers', 'advice', 'basis']);
  assert.equal(snapshot.execRatio, 0.053);
  assert.deepEqual(snapshot.calls, { exec: 3, total: 57 });
  assert.equal(snapshot.dispatchCount, 2);
  assert.equal(snapshot.collectCount, 1);
  assert.equal(snapshot.idleWorkers, 5);
  assert.equal(snapshot.advice, '');
  assert.equal(snapshot.basis, 'projection');
  const unknownTeam = delegationSnapshot({ execution: executionOf(0, 10), idleWorkers: null });
  assert.equal(unknownTeam.idleWorkers, null, 'null 保留（不猜 0）');
  const missingTeam = delegationSnapshot({ execution: executionOf(0, 10) });
  assert.equal(missingTeam.idleWorkers, null, 'undefined 归一为 null');
});

test('delegationSnapshot：projectedAvailable=false → basis unavailable 且计数按 0（不静默当正常）', () => {
  const snapshot = delegationSnapshot({ execution: executionOf(3, 57), dispatchCount: 2, collectCount: 1, idleWorkers: 5, projectedAvailable: false });
  assert.equal(snapshot.basis, 'unavailable');
  assert.equal(snapshot.execRatio, 0);
  assert.deepEqual(snapshot.calls, { exec: 0, total: 0 });
  assert.equal(snapshot.dispatchCount, 0);
  assert.equal(snapshot.collectCount, 0);
  assert.equal(snapshot.idleWorkers, 5, '团队列表独立于投影，照常保留');
  // P2-5：投影不可用时 advice 明确「无法判断执行占比（旧宿主）」，不再误报「样本不足」。
  assert.ok(snapshot.advice.includes('投影不可用（旧宿主/旧装配）：无法判断 Lead 执行占比'), snapshot.advice);
  assert.ok(!snapshot.advice.includes('样本不足'));
});

test('delegationSnapshot：advice 与 delegationAdvice 同源（超阈值/空闲规则一致）', () => {
  const over = delegationSnapshot({ execution: executionOf(30, 60), dispatchCount: 1, idleWorkers: 4 });
  assert.equal(over.advice, delegationAdvice({ execution: executionOf(30, 60), dispatchCount: 1, idleWorkers: 4 }));
  const idle = delegationSnapshot({ execution: executionOf(0, 20), dispatchCount: 0, idleWorkers: 3 });
  assert.match(idle.advice, /有 3 个空闲队友且本会话 0 次 relay_dispatch/);
});

// ---------- dispatch 参数校验 ----------

test('validateDispatchArgs：合法 5 字段通过并归一（trim / 默认值）', () => {
  const checked = validateDispatchArgs({
    ...VALID_DISPATCH,
    brief: '  实现 X  ',
    docs: [' docs/A.md ', 'lib/x.js'],
    writeScope: [' lib/x.js '],
    next: '  执行分点  ',
    force: true,
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.value.itemId, 'a1');
  assert.equal(checked.value.brief, '实现 X');
  assert.deepEqual(checked.value.docs, ['docs/A.md', 'lib/x.js']);
  assert.deepEqual(checked.value.writeScope, ['lib/x.js']);
  assert.equal(checked.value.acceptance, VALID_DISPATCH.acceptance);
  assert.equal(checked.value.next, '执行分点');
  assert.equal(checked.value.force, true);
  assert.equal(checked.value.accept_dirty, false);
  assert.equal(checked.value.worker, null);
});

test('validateDispatchArgs：缺 brief/docs/writeScope/acceptance/itemId → 结构化拒绝 invalid-args', () => {
  for (const field of ['itemId', 'brief', 'docs', 'writeScope', 'acceptance']) {
    const args = { ...VALID_DISPATCH };
    delete args[field];
    const checked = validateDispatchArgs(args);
    assert.equal(checked.ok, false, '缺 ' + field + ' 应拒');
    assert.equal(checked.code, 'invalid-args');
    assert.equal(checked.field, field);
    assert.equal(typeof checked.message, 'string');
  }
  assert.equal(validateDispatchArgs(null).ok, false);
  assert.equal(validateDispatchArgs('nope').ok, false);
});

test('validateDispatchArgs：itemId 必须匹配台账 id 形态（2-32 字符）', () => {
  for (const bad of ['Bad_ID', 'a', 'x'.repeat(33), 'a b', '../x', '']) {
    const checked = validateDispatchArgs({ ...VALID_DISPATCH, itemId: bad });
    assert.equal(checked.ok, false, '非法 itemId 应拒：' + JSON.stringify(bad));
    assert.equal(checked.field, 'itemId');
  }
  for (const good of ['a1', 'x-1', 'build-fix-p2', '1'.repeat(32)]) {
    assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, itemId: good }).ok, true, '合法 itemId：' + good);
  }
});

test('validateDispatchArgs：docs 1-3 条、每条 1-200 字符', () => {
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: [] }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: ['a', 'b', 'c', 'd'] }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: ['a'] }).ok, true);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: ['a', 'b', 'c'] }).ok, true);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: [''] }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: ['d'.repeat(201)] }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, docs: [1] }).ok, false);
});

test('validateDispatchArgs：writeScope 1-8 条、工作区相对路径（绝对路径/.. 拒）', () => {
  const bad = ['/tmp/x', '../x', 'lib/../x', 'C:\\temp\\x', '\\server\\share', '', 's'.repeat(201)];
  for (const pathValue of bad) {
    const checked = validateDispatchArgs({ ...VALID_DISPATCH, writeScope: [pathValue] });
    assert.equal(checked.ok, false, '非法写范围应拒：' + JSON.stringify(pathValue));
    assert.equal(checked.field, 'writeScope');
  }
  for (const pathValue of ['lib/x.js', 'test/', 'lib/**', './lib/x.js', 'a/b/c.md']) {
    assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, writeScope: [pathValue] }).ok, true, '合法写范围：' + pathValue);
  }
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, writeScope: [] }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, writeScope: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }).ok, false);
});

test('validateDispatchArgs：brief/acceptance/next 长度上限与布尔字段类型', () => {
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, brief: 'b'.repeat(801) }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, brief: 'b'.repeat(800) }).ok, true);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, acceptance: 'a'.repeat(301) }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, next: 'n'.repeat(161) }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, next: '  ' }).ok, true, '空 next 视为缺省');
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, next: 'ok' }).value.next, 'ok');
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, force: 'yes' }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, accept_dirty: 1 }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, worker: 42 }).ok, false);
  assert.equal(validateDispatchArgs({ ...VALID_DISPATCH, worker: ' worker-1 ' }).value.worker, 'worker-1');
});

// ---------- 标准 brief 组装 ----------

test('composeDispatchBrief：5 字段 + dispatchId + reportPath + verdict 枚举（§4.3 模板）', () => {
  const brief = composeDispatchBrief({
    itemId: 'a1',
    dispatchId: 'd-a1-test',
    brief: '实现 X',
    docs: ['docs/A.md', 'lib/x.js'],
    writeScope: ['lib/x.js', 'test/x.test.mjs'],
    acceptance: 'node --test test/x.test.mjs',
    reportPath: '.scratch/context-relay/reports/a1.md',
  });
  const lines = brief.split('\n');
  assert.equal(lines[0], '[context-relay] 派活 · a1 · dispatch d-a1-test');
  assert.equal(lines[1], '1) 目标：实现 X');
  assert.equal(lines[2], '2) 必读（1–3 份，按序自取，含 when/role）：docs/A.md；lib/x.js');
  assert.equal(lines[3], '3) 写范围：lib/x.js；test/x.test.mjs（越界禁止；只改这些文件/目录）');
  assert.equal(lines[4], '4) 验收：node --test test/x.test.mjs');
  assert.match(lines[5], /^5\) 回执：\.scratch\/context-relay\/reports\/a1\.md（≤4KB advisory；头 3 行/);
  assert.ok(lines[5].includes('task: a1'), 'brief 含回执头 task 字段');
  assert.ok(lines[5].includes('revision: d-a1-test'), 'brief 含 revision=dispatchId');
  assert.ok(lines[5].includes('verdict: done|needs-human|blocked'), 'brief 含 verdict 枚举');
  assert.match(lines[6], /^收尾：落盘后只发 1 条 ≤200 字消息给 Lead/);
  assert.ok(lines[6].includes('task-a1 report .scratch/context-relay/reports/a1.md verdict=<...>'));
});

test('composeDispatchBrief：未传 dispatchId/reportPath 时确定性派生', () => {
  const brief = composeDispatchBrief({ itemId: 'a1', brief: 'g', docs: ['d'], writeScope: ['s'], acceptance: 'a' });
  assert.match(brief, /^\[context-relay\] 派活 · a1 · dispatch d-a1-[0-9a-z]+\n/, 'dispatchId 按 d-<itemId>-<base36> 派生');
  assert.ok(brief.includes('5) 回执：.scratch/context-relay/reports/a1.md'));
});

// ---------- 回执头解析 ----------

test('parseReportHead：合法 3 行（含加粗/中文冒号/列表前缀/CRLF）通过并提取 revision/body', () => {
  const plain = parseReportHead('task: a1\nrevision: d-a1-x\nverdict: done\n\n## 结论\n完成了 X。');
  assert.equal(plain.ok, true);
  assert.equal(plain.task, 'a1');
  assert.equal(plain.revision, 'd-a1-x');
  assert.equal(plain.verdict, 'done');
  assert.deepEqual(plain.headLines, ['task: a1', 'revision: d-a1-x', 'verdict: done']);
  assert.ok(plain.body.startsWith('## 结论'));
  assert.equal(plain.body.includes('revision:'), false, 'body 不含回执头');

  const decorated = parseReportHead('- **task：** a1\r\n2. __revision__: d-a1-x\r\n- `verdict`: blocked\r\n\r\n## 结论\r\n卡在等裁决。');
  assert.equal(decorated.ok, true);
  assert.equal(decorated.task, 'a1');
  assert.equal(decorated.revision, 'd-a1-x');
  assert.equal(decorated.verdict, 'blocked');
  assert.equal(decorated.body.trim(), '## 结论\n卡在等裁决。', 'body 统一为 LF 行；头剥离后不含装饰符');

  assert.equal(parseReportHead('task: a1\nrevision: d-a1-x\nverdict: DONE\n').verdict, 'done', 'verdict 大小写不敏感归一');
  assert.equal(parseReportHead('task: a1\nrevision: d-a1-x\nverdict: needs-human\n').verdict, 'needs-human');
});

test('parseReportHead：头缺失/乱序/verdict 非法 → ok:false + reason', () => {
  assert.equal(parseReportHead('').ok, false);
  assert.equal(parseReportHead('task: a1\nrevision: d-a1-x\n').reason, 'head-missing');
  const unordered = parseReportHead('revision: d-a1-x\ntask: a1\nverdict: done\n');
  assert.equal(unordered.ok, false);
  assert.equal(unordered.reason, 'head-order');
  const badVerdict = parseReportHead('task: a1\nrevision: d-a1-x\nverdict: issues\n');
  assert.equal(badVerdict.ok, false);
  assert.equal(badVerdict.reason, 'verdict-invalid');
  // 历史报告风格「# 标题 + 头」不算合法头（新契约要求头 3 行在文件最前，无标题行）
  const withTitle = parseReportHead('# 回执\ntask: a1\nrevision: d-a1-x\nverdict: done\n');
  assert.equal(withTitle.ok, false);
  // 空 task/revision 值与无法识别的行
  assert.equal(parseReportHead('task:\nrevision: d-a1-x\nverdict: done\n').ok, false);
  assert.equal(parseReportHead('任务：a1\nrevision: d-a1-x\nverdict: done\n').ok, false, '键名必须是英文 task/revision/verdict');
});

// ---------- digest ----------

test('digestOf：优先「## 结论」节，缺失取正文前部（压缩空白 ≤600 码点）', () => {
  const withSection = parseReportHead('task: a1\nrevision: d-a1-x\nverdict: done\n\n## 结论\n实现 X 完成。\n\n## 证据\nlib/x.js:10\n');
  assert.equal(digestOf(withSection), '实现 X 完成。');
  const levelOne = parseReportHead('task: a1\nrevision: d-a1-x\nverdict: done\n\n# 结论\n用小标题也认。\n# 证据\nx\n');
  assert.equal(digestOf(levelOne), '用小标题也认。');
  const noSection = { ok: true, body: '第一段结论。\n第二行  细节。' };
  assert.equal(digestOf(noSection), '第一段结论。 第二行 细节。', '无结论节取正文前部并压缩空白');
  const long = { ok: true, body: '## 结论\n' + 'a'.repeat(1000) };
  assert.equal(Array.from(digestOf(long)).length, DELEGATION_DIGEST_CHARS);
  const emoji = { ok: true, body: '😀'.repeat(1000) };
  assert.equal(Array.from(digestOf(emoji)).length, DELEGATION_DIGEST_CHARS, '按 Unicode 码点截断');
  assert.equal(digestOf(undefined), '');
  assert.equal(digestOf({ ok: false }), '');
});

test('digestOf：长报告不吞头（head 已在 parse 剥离）', () => {
  const head = 'task: a1\nrevision: d-a1-x\nverdict: done\n';
  const body = '\n## 结论\n' + 'B'.repeat(4000) + '\n';
  const parsed = parseReportHead(head + body);
  const digest = digestOf(parsed);
  assert.equal(digest.startsWith('BBBB'), true);
  assert.equal(digest.includes('task:'), false);
  assert.equal(digest.includes('revision:'), false);
});

// ---------- reportPath / dispatchId ----------

test('reportPathOf：确定性路径；非法 id 返回 null', () => {
  assert.equal(reportPathOf('a1'), '.scratch/context-relay/reports/a1.md');
  assert.equal(reportPathOf(' a1 '), '.scratch/context-relay/reports/a1.md');
  assert.equal(reportPathOf('build-fix-p2'), '.scratch/context-relay/reports/build-fix-p2.md');
  for (const bad of [undefined, null, '', 'A1', '../x', 'a', 'x'.repeat(33), 42]) {
    assert.equal(reportPathOf(bad), null, '非法 id 返回 null：' + JSON.stringify(bad));
  }
});

test('dispatchIdOf：d-<itemId>-<base36(now)>；不同时间不同 id；长度 ≤48', () => {
  const expected = 'd-a1-' + (1700000000000).toString(36);
  assert.equal(dispatchIdOf('a1', 1700000000000), expected);
  assert.notEqual(dispatchIdOf('a1', 1700000000000), dispatchIdOf('a1', 1700000000001));
  const longId = 'x'.repeat(32);
  assert.equal(dispatchIdOf(longId, 1700000000000).length, ('d-' + longId + '-' + (1700000000000).toString(36)).length);
  assert.ok(dispatchIdOf(longId, 1700000000000).length <= 48);
  assert.match(dispatchIdOf('a1', 0), /^d-a1-0$/);
});

// ---------- 纯逻辑闭环（validate → brief → 回执 → parse → digest） ----------

test('闭环：校验通过 → 组装 brief → worker 按头 3 行写回执 → collect 解析 digest', () => {
  const checked = validateDispatchArgs(VALID_DISPATCH);
  assert.equal(checked.ok, true);
  const dispatchId = dispatchIdOf(VALID_DISPATCH.itemId, 1700000000000);
  const reportPath = reportPathOf(VALID_DISPATCH.itemId);
  const brief = composeDispatchBrief({ ...checked.value, dispatchId, reportPath });
  assert.ok(brief.includes('revision: ' + dispatchId));
  const workerReceipt = 'task: a1\nrevision: ' + dispatchId + '\nverdict: done\n\n## 结论\n已实现 X，测试全绿。\n\n## 证据\nlib/x.js:1\n';
  const parsed = parseReportHead(workerReceipt);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.task, VALID_DISPATCH.itemId);
  assert.equal(parsed.revision, dispatchId, '回执 revision 与 dispatchId 一致（collect 用它防旧回执）');
  assert.equal(parsed.verdict, 'done');
  assert.equal(digestOf(parsed), '已实现 X，测试全绿。');
});



// ---------- dispatch 落盘 / 回执新鲜度 / 内存可观测（v0.10 C8）----------

test('dispatchRecordPathOf：dispatch/<scopeId>/<itemId>.json；非法 scope 落 _workspace；非法 itemId 返回 null', () => {
  assert.equal(DELEGATION_DISPATCH_DIR, '.scratch/context-relay/dispatch');
  assert.equal(dispatchRecordPathOf('session-lead-1', 'a1'), '.scratch/context-relay/dispatch/session-lead-1/a1.json');
  assert.equal(dispatchRecordPathOf('session-lead-1', ' a1 '), '.scratch/context-relay/dispatch/session-lead-1/a1.json');
  for (const scope of [undefined, null, '', 'a/../b', 'bad scope', 42]) {
    assert.equal(dispatchRecordPathOf(scope, 'a1'), '.scratch/context-relay/dispatch/_workspace/a1.json', 'scope 归一 _workspace：' + String(scope));
  }
  for (const bad of [undefined, null, '', 'A1', '../x', 'a', 'x'.repeat(33), 42]) {
    assert.equal(dispatchRecordPathOf('session-lead-1', bad), null, '非法 itemId → null：' + JSON.stringify(bad));
  }
});

test('nextDispatchId：与上次 dispatchId 必不同（同毫秒重派也换 revision）；同项不同时间不同', () => {
  const first = dispatchIdOf('a1', 1700000000000);
  assert.notEqual(nextDispatchId('a1', first, 1700000000000), first, '同毫秒重派必须换 id');
  assert.equal(nextDispatchId('a1', first, 1700000000000), dispatchIdOf('a1', 1700000000001), '冲突时递增 1ms');
  assert.equal(nextDispatchId('a1', undefined, 1700000000000), first, '无上次 id 用当前时间');
  assert.match(nextDispatchId('a1', undefined), /^d-a1-[0-9a-z]+$/);
  assert.notEqual(nextDispatchId('a1', undefined, 1700000000000), nextDispatchId('a1', undefined, 1700000000001));
});

test('receiptFreshnessOf：task 必须等于 itemId、revision 必须等于本次 dispatchId；缺 dispatchId 拒', () => {
  const parsed = { ok: true, task: 'a1', revision: 'd-a1-x', verdict: 'done' };
  assert.deepEqual(receiptFreshnessOf(parsed, 'a1', 'd-a1-x'), { fresh: true });
  assert.deepEqual(receiptFreshnessOf({ ...parsed, revision: 'd-a1-old' }, 'a1', 'd-a1-x'), { fresh: false, reason: 'stale-report' });
  assert.deepEqual(receiptFreshnessOf({ ...parsed, task: 'a2' }, 'a1', 'd-a1-x'), { fresh: false, reason: 'report-task-mismatch' }, '错任务回执不得收口');
  assert.deepEqual(receiptFreshnessOf(parsed, 'a1', undefined), { fresh: false, reason: 'needs-dispatch-id' });
  assert.deepEqual(receiptFreshnessOf(parsed, 'a1', ''), { fresh: false, reason: 'needs-dispatch-id' });
  assert.deepEqual(receiptFreshnessOf(undefined, 'a1', 'd-a1-x'), { fresh: false, reason: 'report-invalid' });
  assert.deepEqual(receiptFreshnessOf({ ok: false, reason: 'head-order' }, 'a1', 'd-a1-x'), { fresh: false, reason: 'report-invalid' });
});

test('delegationSnapshot：dispatch 记忆被 reload 清空时暴露 dispatchMemory（relay_status 字段）；未清空不加字段', () => {
  try {
    registerDispatchMemoryProbe(() => ({ inMemory: 0, cleared: false, clearedAt: null }));
    assert.equal(delegationSnapshot({ dispatchCount: 0 }).dispatchMemory, undefined, '未清空不加字段（旧输出不变）');
    assert.equal(dispatchMemoryState().cleared, false);
    registerDispatchMemoryProbe(() => ({ inMemory: 0, cleared: true, clearedAt: '2026-11-16T00:00:00.000Z' }));
    const snapshot = delegationSnapshot({ dispatchCount: 1, projectedAvailable: true });
    assert.equal(snapshot.dispatchMemory.inMemory, 0);
    assert.equal(snapshot.dispatchMemory.cleared, true);
    assert.equal(snapshot.dispatchMemory.clearedAt, '2026-11-16T00:00:00.000Z');
    assert.match(String(snapshot.dispatchMemory.note), /persisted dispatch records under \.scratch\/context-relay\/dispatch/);
    // 投影不可用时也照常暴露（记忆状态与投影无关）
    assert.equal(delegationSnapshot({ projectedAvailable: false }).dispatchMemory.cleared, true);
    // 探针抛错/返回垃圾 → 不加字段（可观测字段绝不影响主流程）
    registerDispatchMemoryProbe(() => { throw new Error('probe down'); });
    assert.equal(delegationSnapshot({}).dispatchMemory, undefined);
    registerDispatchMemoryProbe(() => 'nope');
    assert.equal(delegationSnapshot({}).dispatchMemory, undefined);
  } finally {
    registerDispatchMemoryProbe(null);
  }
  assert.equal(dispatchMemoryState(), null, '无探针 → null（旧装配安全）');
});

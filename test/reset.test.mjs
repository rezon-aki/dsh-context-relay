import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPendingResets,
  computeResetRange,
  hasPendingReset,
  performWipe,
  scheduleReset,
  takePendingReset,
} from '../lib/agent/reset.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * fake session：surface.nodes 为当前可见事件 seq（升序），node0 默认系统提示；
 * append 记录调用并按 surfaceOp=replace 把区间节点换成新 seq（模拟真实 surface 更新）。
 */
function fakeSession({ nodes = [1, 2, 3], roles = {}, failAppend = false, appendError = 'append rejected' } = {}) {
  const calls = [];
  const session = {
    surface: { nodes: [...nodes] },
    calls,
    eventAt(seq) { return { seq, fake: true }; },
    deriveEventMessage(event) {
      if (Object.hasOwn(roles, event.seq)) {
        const role = roles[event.seq];
        return role === null ? null : { role };
      }
      return { role: event.seq === nodes[0] ? 'system' : 'assistant' };
    },
    append(type, data, opts) {
      calls.push({ type, data, opts });
      if (failAppend) throw new Error(appendError);
      const replacement = Math.max(0, ...session.surface.nodes) + 1;
      const { startSeq, endSeq } = opts.surfaceOp;
      session.surface.nodes = session.surface.nodes.filter((seq) => seq < startSeq || seq > endSeq).concat(replacement);
      return { seq: replacement, data, type };
    },
  };
  return session;
}

test('computeResetRange keeps the system head and shadows every other surface node', () => {
  const session = fakeSession({ nodes: [3, 8, 15, 31] });
  assert.deepEqual(computeResetRange(session), { ok: true, startSeq: 8, endSeq: 31, shadowedSeqs: [8, 15, 31], nodeCount: 4 });
});

test('computeResetRange refuses a surface shorter than system + one message', () => {
  assert.equal(computeResetRange(fakeSession({ nodes: [7] })).code, 'surface-too-short');
  assert.equal(computeResetRange(fakeSession({ nodes: [] })).code, 'surface-too-short');
  assert.equal(computeResetRange({ surface: {} }).code, 'surface-too-short');
});

test('computeResetRange refuses when node0 is not a system message', () => {
  const userHead = computeResetRange(fakeSession({ nodes: [2, 9], roles: { 2: 'user' } }));
  assert.equal(userHead.ok, false);
  assert.equal(userHead.code, 'no-system-head');
  const emptyHead = computeResetRange(fakeSession({ nodes: [2, 9], roles: { 2: null } }));
  assert.equal(emptyHead.ok, false);
  assert.equal(emptyHead.code, 'no-system-head');
});

test('computeResetRange reports range-failed instead of throwing', () => {
  const session = fakeSession({ nodes: [1, 2, 3] });
  session.eventAt = () => { throw new Error('seq read failed'); };
  const result = computeResetRange(session);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'range-failed');
  assert.match(result.reason, /seq read failed/);
});

test('performWipe appends one user/message with exact replacement metadata', () => {
  clearPendingResets();
  const session = fakeSession({ nodes: [11, 18, 26, 40] });
  const result = performWipe(undefined, session, '旧任务归档。新任务：修复 X。');

  assert.equal(result.ok, true);
  assert.equal(result.seq, 41);
  assert.equal(result.startSeq, 18);
  assert.equal(result.endSeq, 40);
  assert.deepEqual(result.shadowedSeqs, [18, 26, 40]);
  assert.equal(result.shadowedNodes, 3);
  assert.equal(session.calls.length, 1);

  const call = session.calls[0];
  assert.equal(call.type, 'user/message');
  assert.deepEqual(Object.keys(call.opts.surfaceOp).sort(), ['endSeq', 'op', 'startSeq']);
  assert.deepEqual(call.opts.surfaceOp, { op: 'replace', startSeq: 18, endSeq: 40 });
  assert.deepEqual(call.opts.sourceEventSeqs, [18, 26, 40]);
  assert.equal(call.opts.sourceEventSeqs.includes(11), false);
  assert.equal(call.data.role, 'user');
  assert.deepEqual(call.data.content, [{ type: 'text', text: '旧任务归档。新任务：修复 X。' }]);
  assert.deepEqual(call.data.source, { kind: 'reset', reason: 'relay-reset', shadowed: 3 });
  assert.match(call.data.id, UUID_RE);
  assert.deepEqual(session.surface.nodes, [11, 41]);
});

test('performWipe carries a custom reason and stringifies the brief', () => {
  const session = fakeSession({ nodes: [1, 2] });
  const result = performWipe(undefined, session, 12345, { reason: 'task-boundary' });
  assert.equal(result.ok, true);
  assert.equal(session.calls[0].data.content[0].text, '12345');
  assert.equal(session.calls[0].data.source.reason, 'task-boundary');
});

test('every wipe appends a fresh random message id', () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const session = fakeSession({ nodes: [1, 2 + i] });
    performWipe(undefined, session, 'b');
    ids.push(session.calls[0].data.id);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, UUID_RE);
});

test('performWipe measures tokens before append and after append; missing/throwing meter is not fatal', () => {
  const session = fakeSession({ nodes: [1, 5, 9] });
  let reads = 0;
  const ctx = { get: (name) => { assert.equal(name, 'tokenMeter'); return { measure: (target) => { assert.equal(target, session); reads += 1; return { totalTokens: reads === 1 ? 900 : 120 }; } }; } };
  const result = performWipe(ctx, session, 'b');
  assert.equal(result.beforeTokens, 900);
  assert.equal(result.afterTokens, 120);

  const missing = performWipe(undefined, fakeSession({ nodes: [1, 2] }), 'b');
  assert.equal(missing.ok, true);
  assert.equal(missing.beforeTokens, undefined);
  assert.equal(missing.afterTokens, undefined);

  const ctxThrows = { get() { throw new Error('service unavailable'); } };
  const meterDown = performWipe(ctxThrows, fakeSession({ nodes: [1, 2] }), 'b');
  assert.equal(meterDown.ok, true);
  assert.equal(meterDown.beforeTokens, undefined);

  const meterThrows = { get: () => ({ measure() { throw new Error('meter down'); } }) };
  const measuredDown = performWipe(meterThrows, fakeSession({ nodes: [1, 2] }), 'b');
  assert.equal(measuredDown.ok, true);
  assert.equal(measuredDown.afterTokens, undefined);
});

test('performWipe propagates append errors and leaves the surface untouched', () => {
  const session = fakeSession({ nodes: [1, 2, 7], failAppend: true, appendError: 'surface replacement rejected' });
  assert.throws(() => performWipe(undefined, session, 'b'), /surface replacement rejected/);
  assert.equal(session.calls.length, 1);
  assert.deepEqual(session.surface.nodes, [1, 2, 7]);
});

test('performWipe refuses an invalid range without appending', () => {
  const short = fakeSession({ nodes: [1] });
  const result = performWipe(undefined, short, 'b');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'surface-too-short');
  assert.equal(short.calls.length, 0);
});

test('pending reset queue: per-session replace, one-shot take, has/clear', () => {
  clearPendingResets();
  const first = { brief: 'a' };
  assert.deepEqual(scheduleReset('s1', first), { replaced: false });
  assert.equal(hasPendingReset('s1'), true);
  const second = { brief: 'b' };
  assert.deepEqual(scheduleReset('s1', second), { replaced: true });
  assert.equal(takePendingReset('s1'), second);
  assert.equal(hasPendingReset('s1'), false);
  assert.equal(takePendingReset('s1'), undefined);

  scheduleReset('s2', { brief: 'c' });
  scheduleReset('s3', { brief: 'd' });
  clearPendingResets();
  assert.equal(hasPendingReset('s2'), false);
  assert.equal(hasPendingReset('s3'), false);
});

test('scheduleReset requires a non-empty string sessionId', () => {
  clearPendingResets();
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.throws(() => scheduleReset(bad, { brief: 'x' }), TypeError);
  }
  assert.equal(hasPendingReset(''), false);
});

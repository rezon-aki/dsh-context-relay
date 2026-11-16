import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-session 0.2.2-rc.2 src/index.ts:562,853,745,1108 / surface.ts:245,472）：
//   session.surface.nodes → readonly SessionSeq[]；
//   session.append(type, data, {surfaceOp: {op:'replace', startSeq, endSeq}, sourceEventSeqs}) → {seq,...}；
//   session.eventAt(seq) / session.deriveEventMessage(event)（node0 必须是 system 消息）。
function rc2Session() {
  const session = {
    surface: { nodes: [1, 2, 3] },
    append() { return { seq: 4 }; },
    eventAt(seq) { return { seq }; },
    deriveEventMessage() { return { role: 'system' }; },
  };
  return session;
}

test('seam: rc.2 session wipe（surface.nodes/append replace）形状通过', () => {
  assert.deepEqual(seamShape('wipe', rc2Session()), { ok: true, missing: [] });
});

test('seam: 空 surface 仍是合法形状（长度由 computeResetRange 运行时拒）', () => {
  const session = rc2Session();
  session.surface.nodes = [];
  assert.deepEqual(seamShape('wipe', session), { ok: true, missing: [] });
});

test('seam: 旧无 surface / 非数组 nodes 形状 → degraded 且不抛错', () => {
  const noSurface = { append() {}, eventAt() {}, deriveEventMessage() {} };
  assert.deepEqual(seamShape('wipe', noSurface), { ok: false, missing: ['surface.nodes'] });

  const setNodes = rc2Session();
  setNodes.surface.nodes = new Set([1, 2]);
  assert.deepEqual(seamShape('wipe', setNodes).missing, ['surface.nodes']);
});

test('seam: 无 append 替换面 → degraded 且不抛错', () => {
  const session = rc2Session();
  delete session.append;
  assert.deepEqual(seamShape('wipe', session).missing, ['append']);
  assert.equal(seamShape('wipe', undefined).ok, false);
});

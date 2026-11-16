import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-agent 0.2.2-rc.2 src/index.ts:300,580,588）：
//   list() → Agent[]；get(id) → Agent | undefined；turnBoundaryOf(session) → TurnBoundaryProjection。
const rc2 = { list() { return []; }, get() {}, turnBoundaryOf() { return { openTurnStartSeq: null, lastTurn: 0 }; } };

test('seam: rc.2 agents（list/get/turnBoundaryOf）形状通过', () => {
  assert.deepEqual(seamShape('agents', rc2), { ok: true, missing: [] });
});

test('seam: 旧 turnBoundary 命名形状 → degraded 且不抛错', () => {
  const verdict = seamShape('agents', { list() {}, get() {}, turnBoundary() {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['turnBoundaryOf']);
});

test('seam: 服务缺失 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('agents', undefined), { ok: false, missing: ['list', 'get', 'turnBoundaryOf'] });
});

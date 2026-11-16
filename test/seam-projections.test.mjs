import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-session-projection 0.2.2-rc.2 src/index.ts:443,456,514）：
//   register(definition) → Promise<ProjectionHandle>；snapshot(session, keys?) → {asOfSeq, values}；
//   stateOf(session, key) → unknown（deprecated 但 relay 的 fallback 读取仍走它）。
const rc2 = { register() { return Promise.resolve({ stateOf() {}, dispose() {} }); }, snapshot() { return { asOfSeq: 0, values: {} }; }, stateOf() {} };

test('seam: rc.2 sessionProjections（register/snapshot/stateOf）形状通过', () => {
  assert.deepEqual(seamShape('projections', rc2), { ok: true, missing: [] });
});

test('seam: 缺 stateOf 的新形状（本插件未适配前）→ degraded 且不抛错', () => {
  const verdict = seamShape('projections', { register() {}, snapshot() {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['stateOf']);
});

test('seam: 服务缺失 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('projections', undefined), { ok: false, missing: ['register', 'snapshot', 'stateOf'] });
});

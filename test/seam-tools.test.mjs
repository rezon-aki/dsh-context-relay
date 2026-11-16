import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-tools 0.2.2-rc.2 src/index.ts:139,162）：
//   register(definition) → disposer；restrict({allow?, deny?}) → disposer（agent.ctx 作用域）。
const rc2 = { register() { return () => {}; }, restrict() { return () => {}; } };

test('seam: rc.2 tools（register/restrict）形状通过', () => {
  assert.deepEqual(seamShape('tools', rc2), { ok: true, missing: [] });
});

test('seam: 旧 denyTool 命名形状 → degraded 且不抛错', () => {
  const verdict = seamShape('tools', { register() {}, denyTool() {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['restrict']);
});

test('seam: 服务缺失 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('tools', null), { ok: false, missing: ['register', 'restrict'] });
});

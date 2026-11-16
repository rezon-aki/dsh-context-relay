import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-system-prompt 0.2.2-rc.2 src/index.ts:485）：
//   section({name, order, text}) → disposer；agent.ctx 上注册同名 section 覆盖全局。
// 覆盖语义由宿主保证，形状层只锁注册面（语义漂移靠 CI 真机装配 smoke）。
const rc2 = { section() { return () => {}; }, context() {}, tools() {}, variable() {} };

test('seam: rc.2 systemPrompt（section）形状通过', () => {
  assert.deepEqual(seamShape('systemPrompt', rc2), { ok: true, missing: [] });
});

test('seam: 旧 addSection 命名形状 → degraded 且不抛错', () => {
  const verdict = seamShape('systemPrompt', { addSection() {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['section']);
});

test('seam: 服务缺失 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('systemPrompt', {}), { ok: false, missing: ['section'] });
});

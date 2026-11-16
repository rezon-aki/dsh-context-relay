import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-agent-preset-registry 0.2.2-rc.2 src/index.ts:333,365）：
//   composedPreset(ctx) → preset id | undefined；select(agent, preset) → Promise<preset id>。
const rc2 = { composedPreset() { return 'relay-long'; }, select() { return Promise.resolve('relay-long'); }, register() {} };

test('seam: rc.2 agentPresets（composedPreset/select）形状通过', () => {
  assert.deepEqual(seamShape('preset', rc2), { ok: true, missing: [] });
});

test('seam: 旧 compose-only 形状 → degraded 且不抛错', () => {
  const verdict = seamShape('preset', { compose() {}, select() {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['composedPreset']);
});

test('seam: 服务缺失/原始值 → degraded 且不抛错', () => {
  for (const value of [undefined, null, 0, 'agentPresets']) {
    assert.deepEqual(seamShape('preset', value), { ok: false, missing: ['composedPreset', 'select'] });
  }
});

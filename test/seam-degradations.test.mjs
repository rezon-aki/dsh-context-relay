import test from 'node:test';
import assert from 'node:assert/strict';
import { degradation, degradationsOf, seamShape } from '../lib/seams.js';

test('degradation: 生成 degraded 记录（reason 可为 seamShape().missing 数组）', () => {
  assert.deepEqual(degradation('agents', 'missing list'), { seam: 'agents', reason: 'missing list', level: 'degraded' });
  assert.deepEqual(degradation('schedule', ['catalog', 'edit']), { seam: 'schedule', reason: 'catalog, edit', level: 'degraded' });
});

test('degradation: 显式 unavailable 与非法 level 归一', () => {
  assert.deepEqual(degradation('compaction', 'service unavailable', 'unavailable'), { seam: 'compaction', reason: 'service unavailable', level: 'unavailable' });
  assert.equal(degradation('team', undefined, 'bogus').level, 'degraded');
  assert.equal(degradation('team', undefined).reason, '');
});

test('degradationsOf: 按 seam 去重、reason 合并、level 取最严重', () => {
  const records = [
    degradation('schedule', 'catalog'),
    degradation('agents', 'turnBoundaryOf'),
    degradation('schedule', 'edit'),
    degradation('schedule', 'catalog'),
    degradation('agents', 'service unavailable', 'unavailable'),
  ];
  assert.deepEqual(degradationsOf(records), [
    { seam: 'schedule', reason: 'catalog; edit', level: 'degraded' },
    { seam: 'agents', reason: 'turnBoundaryOf; service unavailable', level: 'unavailable' },
  ]);
});

test('degradationsOf: 接受嵌套数组、忽略非法记录、空输入返回空列表', () => {
  const records = [degradation('tools', 'restrict'), [null, 'x', { seam: '' }, { reason: 'no seam' }, degradation('preset', 'select')]];
  assert.deepEqual(degradationsOf(records), [
    { seam: 'tools', reason: 'restrict', level: 'degraded' },
    { seam: 'preset', reason: 'select', level: 'degraded' },
  ]);
  assert.deepEqual(degradationsOf([]), []);
  assert.deepEqual(degradationsOf(undefined), []);
});

test('seamShape: 未知 seam 名显式降级、不抛错', () => {
  const verdict = seamShape('nope', {});
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['unknown seam "nope"']);
});

test('seamShape: 观测值 getter 抛错也只降级、不打断调用方', () => {
  const hostile = { get composedPreset() { throw new Error('boom'); } };
  const verdict = seamShape('preset', hostile);
  assert.equal(verdict.ok, false);
  assert.match(verdict.missing[0], /^seam probe failed: boom/);
});

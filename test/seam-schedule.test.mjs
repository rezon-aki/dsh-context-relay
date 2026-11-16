import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-schedule 0.2.2-rc.2 src/index.ts:381,414,441,555）：
//   list({active?,limit?,offset?}) → {items,shown,total,limit,offset}（分页对象，不可迭代——M-01 的断裂点）；
//   catalog() → ScheduleCatalogEntry[]；create({title,prompt,timing,target?}) → entry；edit({id,action,patch}) → entry/冲突码。
const service = { list() {}, catalog() {}, create() {}, edit() {} };
const page = { items: [{ id: 's-1' }], shown: 1, total: 1, limit: 100, offset: 0 };

test('seam: rc.2 schedule 服务形状通过', () => {
  assert.deepEqual(seamShape('schedule', service), { ok: true, missing: [] });
});

test('seam: rc.2 list() 分页返回体形状通过', () => {
  assert.deepEqual(seamShape('schedule', page), { ok: true, missing: [] });
});

test('seam: 旧 rc.1 list/create/delete 服务形状 → degraded 且不抛错', () => {
  const verdict = seamShape('schedule', { list() {}, create() {}, delete() {} });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['catalog', 'edit']);
});

test('seam: 旧数组 list() 返回（for...of 断裂点）→ degraded 且不抛错', () => {
  const verdict = seamShape('schedule', []);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['items', 'shown', 'total', 'limit', 'offset']);
});

test('seam: 服务缺失 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('schedule', undefined), { ok: false, missing: ['schedule service/list page'] });
});

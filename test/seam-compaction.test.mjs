import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';

// rc.2 官方形状（@deepseek-ai/dsh-compaction 0.2.2-rc.2）：
//   引擎：compactIfNeeded(agent, trigger, signal) → CompactionResult | null（还有 compactNow/compactRegion）；
//   返回：CompactionResult {compactionId, endSeq, shadowedSeqs, shadowedTokenCount, ...}；
//   事件：compaction/end data {compactionId, turn, error?}（投影按 data.error 判定成功压缩）。
const engine = { compactIfNeeded() {}, compactNow() {}, compactRegion() {} };
const result = { compactionId: 'compaction-1', startSeq: 10, summarySeq: 11, endSeq: 12, summary: [], shadowedRange: { start: 3, end: 4 }, shadowedSeqs: [3, 4], shadowedTokenCount: 321 };

test('seam: rc.2 compaction 引擎形状通过', () => {
  assert.deepEqual(seamShape('compaction', engine), { ok: true, missing: [] });
});

test('seam: rc.2 CompactionResult 返回形状通过', () => {
  assert.deepEqual(seamShape('compaction', result), { ok: true, missing: [] });
});

test('seam: rc.2 compaction/end 事件形状通过（成功与失败）', () => {
  assert.deepEqual(seamShape('compaction', { type: 'compaction/end', data: { compactionId: 'compaction-1', turn: 2 } }), { ok: true, missing: [] });
  assert.deepEqual(seamShape('compaction', { type: 'compaction/end', data: { compactionId: 'compaction-1', turn: null, error: 'summarizer failed' } }), { ok: true, missing: [] });
});

test('seam: 旧 compact() 引擎形状 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('compaction', { compact() {} }).missing, ['compaction engine/result/event']);
  assert.deepEqual(seamShape('compaction', { compactNow() {}, compactRegion() {} }).missing, ['compactIfNeeded']);
});

test('seam: 残缺返回/事件形状 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('compaction', { compactionId: 'compaction-1', endSeq: 12 }).missing, ['shadowedSeqs', 'shadowedTokenCount']);
  assert.deepEqual(seamShape('compaction', { type: 'compaction/end' }).missing, ['compactionId', 'turn']);
  assert.equal(seamShape('compaction', undefined).ok, false);
});

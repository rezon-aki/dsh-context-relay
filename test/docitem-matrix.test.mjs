/**
 * isDocItem 混淆矩阵回归（p3-calib：证据路径优先 + 标题兜底）。
 * 样本：test/fixtures/docitem-cases.mjs（223 条真实台账证据，truth 固化）。
 * 修复前基线（同一样本实测）：P 92.1% / R 83.4% / Acc 80.7%；
 * 目标：路径存在样本召回 ≥95%，精确率不降。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDocItem } from '../lib/risk.js';
import { DOC_ITEM_CASES } from './fixtures/docitem-cases.mjs';

test('isDocItem：路径存在样本召回 ≥95%、精确率不降（混淆矩阵）', () => {
  const rows = DOC_ITEM_CASES.map((item) => ({
    truth: item.truth,
    pred: isDocItem({ title: item.title, evidence: item.evidence }),
  }));
  const count = (truth, pred) => rows.filter((row) => row.truth === truth && row.pred === pred).length;
  const tp = count('doc', true);
  const fn = count('doc', false);
  const fp = count('code', true);
  const tn = count('code', false);
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const accuracy = (tp + tn) / rows.length;
  const matrix = 'TP=' + tp + ' FN=' + fn + ' FP=' + fp + ' TN=' + tn
    + ' · P=' + precision.toFixed(3) + ' R=' + recall.toFixed(3) + ' Acc=' + accuracy.toFixed(3);
  assert.ok(recall >= 0.95, '路径存在样本召回 ≥95%（当前 ' + matrix + '）');
  assert.ok(precision >= 0.92, '精确率不低于修复前 92.1%（当前 ' + matrix + '）');
  assert.ok(accuracy >= 0.9, '准确率 ≥90%（当前 ' + matrix + '）');
});

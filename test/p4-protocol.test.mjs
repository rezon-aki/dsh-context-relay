/**
 * v0.13 D2/D3/D5 探针（0.14.0-dev 更新）：用户汇报三问 / 旧四段只 warning / 工具无用户段 / 架构师机制诊断触发句。
 * 只读纯函数与协议常量；台账探针用 tmp 工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userReportWarnings } from '../lib/policy.js';
import { ARCHITECT_LEAD_PROTOCOL_TEXT, PROTOCOL_TEXT, REDLINE_PROTOCOL_TEXT, ROUTER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';

test('D2 正式汇报：任意自然语言零格式 warning；超长/倾倒只 warning', () => {
  const natural = '登录按钮修好了。\n不用你做什么；没有额外影响。';
  const ok = userReportWarnings(natural);
  assert.deepEqual(ok.warnings, [], '自然语言零格式 warning');
  assert.equal('formatOk' in ok, false, 'formatOk 已删除');
  const four = '结论：完成。\n影响：无。\n需要你做什么：无需。\n证据位置：a:1';
  assert.deepEqual(userReportWarnings(four).warnings, [], '旧四段不再有 legacy warning');
  const long = 'x'.repeat(601);
  assert.ok(userReportWarnings(long).warnings.some((warning) => warning.code === 'report-too-long'), '601 字只 warning');
  const dump = '$ npm test\n[exit code: 0]';
  assert.ok(userReportWarnings(dump).warnings.some((warning) => warning.code === 'report-internal-details'), '倾倒日志只 warning');
  assert.deepEqual(userReportWarnings(dump, { detailsRequested: true }).warnings, [], '用户要细节时放宽');
});

test('D5 协议：交互口径唯一真源 = redline §与用户交互 + Lead 自写 + 机制/协议诊断归 architect', () => {
  assert.match(PROTOCOL_TEXT, /与用户交互（最小注意力 × 最大影响）/);
  assert.match(REDLINE_PROTOCOL_TEXT, /## 与用户交互（最小注意力 × 最大影响）/);
  assert.match(REDLINE_PROTOCOL_TEXT, /工具返回只是内部事实/);
  assert.doesNotMatch(REDLINE_PROTOCOL_TEXT, /\[给用户\]/);
  assert.doesNotMatch(REDLINE_PROTOCOL_TEXT, /从工具返回的 .*段起稿/);
  assert.doesNotMatch(PROTOCOL_TEXT, /三问|四段式|三段式/, '模板词不得回到常驻协议');
  assert.match(ARCHITECT_LEAD_PROTOCOL_TEXT, /机制\/协议\/汇报方式的诊断与设计也先交 architect/);
  assert.match(ARCHITECT_LEAD_PROTOCOL_TEXT, /Lead 不自行拍这类方案/);
});

test('D3 用户段字段已删除：旧台账带可见标记也不落、不读回', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-d3-'));
  const written = await writeWorkItems(cwd, {
    items: [
      { id: 'silent', title: 'silent', status: 'doing', owner: 'w', next: 'x' },
      { id: 'visible', title: 'visible', status: 'doing', owner: 'w', next: 'x', user_visible: true },
    ],
    updatedBy: 'session-d3', scopeId: 'session-d3',
  });
  assert.equal(written.ok, true, JSON.stringify(written));
  const read = readWorkItems(cwd, { scopeId: 'session-d3' });
  assert.equal(read.items.find((item) => item.id === 'visible').user_visible, undefined, '旧字段被忽略');
});

/**
 * v0.13 D2/D3/D5 探针：用户汇报三问 / 旧四段只 warning / user_visible 默认 false / 架构师机制诊断触发句。
 * 只读纯函数与协议常量；台账探针用 tmp 工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userReportWarnings } from '../lib/policy.js';
import { ARCHITECT_LEAD_PROTOCOL_TEXT, PROTOCOL_TEXT, ROUTER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';

test('D2 三问：合规零 warning；旧四段只给 legacy warning（不拒）', () => {
  const three = '你看到什么：登录按钮修好了。\n要你做什么：不用。\n有什么影响：没有额外影响。';
  const ok = userReportWarnings(three);
  assert.equal(ok.formatOk, true);
  assert.deepEqual(ok.warnings, [], '三问零 warning');
  const four = '结论：完成。\n影响：无。\n需要你做什么：无需。\n证据位置：a:1';
  const legacy = userReportWarnings(four);
  assert.equal(legacy.formatOk, true, '旧四段仍识别');
  assert.ok(legacy.warnings.some((warning) => warning.code === 'report-four-part-legacy'), '旧四段只 warning');
  assert.equal(legacy.ok, false, '只是 warning，不抛不拒（调用方 ship 照常）');
  assert.ok(!userReportWarnings(four, { detailsRequested: true }).warnings.some((warning) => warning.code === 'report-four-part-legacy'), '用户要细节时四段免迁移提示');
});

test('D5 协议：汇报默认三问 + 来源约束/默认沉默 + 机制/协议诊断归 architect、Lead 不自行拍', () => {
  assert.match(PROTOCOL_TEXT, /汇报默认三问/);
  assert.match(ROUTER_PROTOCOL_TEXT, /## 用户汇报规范（默认三问/);
  assert.match(ROUTER_PROTOCOL_TEXT, /来源约束.*\[给用户\]/);
  assert.match(ROUTER_PROTOCOL_TEXT, /没有 \[给用户\] 段就不发进度消息/);
  assert.match(ARCHITECT_LEAD_PROTOCOL_TEXT, /机制\/协议\/汇报方式的诊断与设计也先交 architect/);
  assert.match(ARCHITECT_LEAD_PROTOCOL_TEXT, /Lead 不自行拍这类方案/);
});

test('D3 user_visible：默认 false 不落字段；true 原样读回', async () => {
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
  assert.equal(read.items.find((item) => item.id === 'silent').user_visible, undefined, '缺字段 = false（不落）');
  assert.equal(read.items.find((item) => item.id === 'visible').user_visible, true, 'true 持久化');
});

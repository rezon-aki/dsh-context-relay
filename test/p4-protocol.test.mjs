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

test('D5 协议：汇报默认三问 + Lead 自写（不从工具用户段起稿）+ 机制/协议诊断归 architect', () => {
  assert.match(PROTOCOL_TEXT, /汇报默认三问/);
  assert.match(ROUTER_PROTOCOL_TEXT, /## 用户汇报规范（Lead 是唯一对用户说话的人；默认三问）/);
  assert.match(ROUTER_PROTOCOL_TEXT, /工具返回只是内部事实/);
  assert.match(ROUTER_PROTOCOL_TEXT, /Lead 自己写三问/);
  assert.doesNotMatch(ROUTER_PROTOCOL_TEXT, /\[给用户\]/);
  assert.doesNotMatch(ROUTER_PROTOCOL_TEXT, /从工具返回的 .*段起稿/);
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

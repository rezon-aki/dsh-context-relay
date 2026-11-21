/**
 * W1 探针：Lead 是唯一对用户说话的人；工具返回只作内部事实，裁决必须当场给卡片；
 * 架构师清空走真实路径；协议硬词与 T0/T1 风险档矩阵对齐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROTOCOL_TEXT, ROUTER_PROTOCOL_TEXT, TEAMMATE_PROTOCOL_TEXT, ARCHITECT_LEAD_PROTOCOL_TEXT, ARCHITECT_WORKER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { INTERNAL_DETAILS_MARK, INTERNAL_ERROR_MARK, MODEL_STATE_MARK } from '../lib/output.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Sources: no tool user-segment drafting; Lead writes the three questions', () => {
  for (const [name, text] of [['PROTOCOL', PROTOCOL_TEXT], ['ROUTER', ROUTER_PROTOCOL_TEXT], ['TEAMMATE', TEAMMATE_PROTOCOL_TEXT], ['ARCHITECT_LEAD', ARCHITECT_LEAD_PROTOCOL_TEXT], ['ARCHITECT_WORKER', ARCHITECT_WORKER_PROTOCOL_TEXT]]) {
    assert.doesNotMatch(text, /\[给用户\]/, name + ' must not mention a user segment');
  }
  assert.match(ROUTER_PROTOCOL_TEXT, /工具返回只是内部事实/);
  assert.match(ROUTER_PROTOCOL_TEXT, /Lead 自己写三问/);
  assert.doesNotMatch(ROUTER_PROTOCOL_TEXT, /从工具返回的 .*段起稿/);
  assert.doesNotMatch(ROUTER_PROTOCOL_TEXT, /没有 .*段就不发进度消息/);
  assert.match(ROUTER_PROTOCOL_TEXT, /不得把工具段\/字段原样贴给用户/);
});

test('Decision card: seven fields, docs only evidence, no path-only decision', () => {
  assert.match(ROUTER_PROTOCOL_TEXT, /裁决卡（硬规则）/);
  for (const field of ['问题', '选项 A/B', '各自影响面', '收益/风险', '推荐', '默认', '不选会怎样']) {
    assert.ok(ROUTER_PROTOCOL_TEXT.includes(field), 'decision card missing: ' + field);
  }
  assert.match(ROUTER_PROTOCOL_TEXT, /文档只作证据/);
  assert.match(ROUTER_PROTOCOL_TEXT, /禁止只说/);
  assert.match(ARCHITECT_LEAD_PROTOCOL_TEXT, /裁决卡直接问用户/);
  assert.match(ARCHITECT_WORKER_PROTOCOL_TEXT, /七字段/);
});

test('Risk tiers: declared T0/T1 exceptions qualify the hard gates', () => {
  assert.match(PROTOCOL_TEXT, /风险档免门矩阵/);
  assert.match(PROTOCOL_TEXT, /T0[^\n]*免设计门[^\n]*user_gate/);
  assert.match(PROTOCOL_TEXT, /T1[^\n]*免设计门[^\n]*一次 diff 审查/);
  assert.match(PROTOCOL_TEXT, /T2[^\n]*全门/);
  assert.match(PROTOCOL_TEXT, /已声明例外|已声明的风险档例外/);
});

test('Architect: only checkpoint; clean context via Lead relay_architect fresh', () => {
  assert.doesNotMatch(ARCHITECT_WORKER_PROTOCOL_TEXT, /由你自己执行|你会收到 relay_freshen|自己执行 freshen/);
  assert.match(ARCHITECT_WORKER_PROTOCOL_TEXT, /Lead 用 relay_architect\(\{mode:'fresh'/);
  assert.match(ARCHITECT_WORKER_PROTOCOL_TEXT, /只写 checkpoint/);
});

test('tools.js: report schema still asks for the three questions; no four-part wording', () => {
  const source = read('lib/agent/tools.js');
  assert.doesNotMatch(source, /四段式大白话汇报/);
  assert.doesNotMatch(source, /（四段汇报）/);
  assert.match(source, /默认三问大白话汇报/);
});

test('Internal marks: facts for the Lead, not user speech', () => {
  for (const [name, mark] of [['模型状态', MODEL_STATE_MARK], ['内部细节', INTERNAL_DETAILS_MARK], ['内部错误', INTERNAL_ERROR_MARK]]) {
    assert.match(mark, /供 Lead/, name + ' 新口径');
    assert.doesNotMatch(mark, /可引用但要讲清楚/, name + ' 不再当用户话术');
  }
});

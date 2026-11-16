import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  DEFAULT_SETTINGS,
  OPERATION_LABELS,
  OPERATION_LONG_LABELS,
  PANEL_OPERATIONS,
  normalizeSettings,
  operationLabelOf,
  operationLongLabelOf,
} from '../lib/policy.js';

// v0.10 C12（C12/C15/D-12）：client 常量 ↔ host 真源的单点契约。
// lib/client.js 是浏览器 bundle（window.__ModuleLoader__），不能 import host 模块 → 操作档/标签/
// 阈值边界/API 路由在 client 里逐字镜像；本文件断言「逐字一致」，任何一侧漂移立即红。
// 原先散落在 client-panel.test.mjs 的常量/公式源码断言也收敛到这里（D-12：契约断言集中单文件）。

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

/** 抽取并求值 client 契约常量区（#region client-contract-constants）；返回区段内常量/纯函数。 */
function clientContractConstants() {
  const BEGIN = '#region client-contract-constants';
  const END = '#endregion client-contract-constants';
  const markerAt = clientSource.indexOf(BEGIN);
  const endMarkerAt = clientSource.indexOf(END);
  assert.ok(markerAt >= 0 && endMarkerAt > markerAt, 'lib/client.js 必须有 client-contract-constants 标记区（契约是真源镜像）');
  const begin = clientSource.indexOf('\n', markerAt) + 1;
  const end = clientSource.lastIndexOf('\n', endMarkerAt);
  assert.ok(begin > 0 && end > begin, '契约区标记必须各占一行（begin/end marker 之间是纯声明）');
  const region = clientSource.slice(begin, end);
  const names = [
    'SETTINGS_API', 'PANEL_API', 'WORK_ITEMS_API', 'ARCHITECT_MODELS_API', 'POLL_MS',
    'OPERATION_VALUES', 'OPERATION_LABELS', 'OPERATION_LONG_LABELS',
    'THRESHOLD_MIN', 'THRESHOLD_MAX', 'OPERATION_OPTIONS', 'operationLabelOf', 'operationLongLabelOf',
  ];
  return runInNewContext(region + '\n;({ ' + names.join(', ') + ' })');
}

const client = clientContractConstants();

/** host 路由常量只存在于 lib/index.js 模块作用域（未导出）→ 按源码契约逐字核对。 */
function hostRoute(name) {
  const match = hostSource.match(new RegExp("const " + name + " = ['\"]([^'\"]+)['\"];"));
  assert.ok(match, 'lib/index.js 缺路由常量 ' + name);
  return match[1];
}

test('C12 契约区：client 常量可独立求值（纯字面量镜像，不 import host）', () => {
  assert.equal(typeof client.POLL_MS, 'number');
  assert.ok(client.POLL_MS >= 1000, '轮询周期必须是毫秒级常量');
  assert.ok(Array.isArray(client.OPERATION_VALUES) && client.OPERATION_VALUES.length >= 1);
  assert.equal(typeof client.operationLabelOf, 'function');
  assert.equal(typeof client.operationLongLabelOf, 'function');
});

// v0.10.0 C10：退役档已从 host PANEL_OPERATIONS 删除 —— 两平面直接全集一致，不再有「去退役档」过滤。
const RETIRED_OPERATIONS = Object.freeze(['compress-then-handoff']);

test('C12/C10 契约：client 操作档 = host PANEL_OPERATIONS（集合与顺序逐字一致）', () => {
  assert.deepEqual([...PANEL_OPERATIONS], ['compress', 'handoff', 'continue'], 'host 单一模式三档');
  assert.deepEqual([...client.OPERATION_VALUES], [...PANEL_OPERATIONS], '操作档必须与 host PANEL_OPERATIONS 一致');
  for (const retired of RETIRED_OPERATIONS) {
    assert.equal(PANEL_OPERATIONS.includes(retired), false, '退役档不得留在 host enum：' + retired);
    assert.equal(client.OPERATION_VALUES.includes(retired), false, '退役档不得出现在 client 操作档：' + retired);
    assert.equal(client.OPERATION_LABELS[retired], undefined, '退役档不得有 client 标签：' + retired);
  }
});

test('C12 契约：client 操作标签与 policy.OPERATION_LABELS / OPERATION_LONG_LABELS 逐字一致', () => {
  const pick = (source) => Object.fromEntries([...client.OPERATION_VALUES].map((operation) => [operation, source[operation]]));
  assert.deepEqual({ ...client.OPERATION_LABELS }, pick(OPERATION_LABELS), '短标签漂移（chip 用）');
  assert.deepEqual({ ...client.OPERATION_LONG_LABELS }, pick(OPERATION_LONG_LABELS), '长标签漂移（表盘/读出行/推荐用）');
});

test('C12 契约：client 标签取词/兜底与 policy.operationLabelOf / operationLongLabelOf 同口径', () => {
  const samples = [...client.OPERATION_VALUES, null, undefined, '', 'bogus'];
  for (const operation of samples) {
    assert.equal(client.operationLabelOf(operation), operationLabelOf(operation), '短标签取词漂移：' + String(operation));
    assert.equal(client.operationLongLabelOf(operation), operationLongLabelOf(operation), '长标签取词漂移：' + String(operation));
  }
  // 退役档在 client 按未知档回落「问我」（host 的旧标签随 C10 一并删除；两平面对退役值都不再提供档位）。
  for (const retired of RETIRED_OPERATIONS) {
    assert.equal(client.operationLabelOf(retired), '问我', '退役档不提供短标签：' + retired);
    assert.equal(client.operationLongLabelOf(retired), '问我', '退役档不提供长标签：' + retired);
  }
});

test('C12 契约：面板选项 label = host 长标签（表盘/读出行/推荐同一套词）+ 问我兜底', () => {
  const byValue = new Map(client.OPERATION_OPTIONS.map((option) => [option.value, option]));
  assert.equal(byValue.size, client.OPERATION_VALUES.length + 1, '选项 = 问我 + 全部支持档，无重复');
  assert.equal(byValue.get(null).label, '问我');
  for (const operation of client.OPERATION_VALUES) {
    const option = byValue.get(operation);
    assert.ok(option, '缺操作档选项：' + operation);
    assert.equal(option.label, OPERATION_LONG_LABELS[operation], '选项 label 必须用 host 长标签：' + operation);
    assert.equal(typeof option.hint, 'string', 'hint 是 UI 文案（非 host 契约），但必须存在');
  }
});

test('C12 契约：阈值输入边界 = policy.normalizeSettings 裁剪区间（[20,85]）', () => {
  assert.equal(client.THRESHOLD_MIN, 20);
  assert.equal(client.THRESHOLD_MAX, 85);
  // 输入框边界必须正好落在 host 的裁剪边界上：越界值被钳到边界，说明边界没漂移。
  assert.equal(normalizeSettings({ threshold: client.THRESHOLD_MIN }).threshold, client.THRESHOLD_MIN);
  assert.equal(normalizeSettings({ threshold: client.THRESHOLD_MAX }).threshold, client.THRESHOLD_MAX);
  assert.equal(normalizeSettings({ threshold: client.THRESHOLD_MIN - 1 }).threshold, client.THRESHOLD_MIN);
  assert.equal(normalizeSettings({ threshold: client.THRESHOLD_MAX + 1 }).threshold, client.THRESHOLD_MAX);
  assert.ok(DEFAULT_SETTINGS.threshold >= client.THRESHOLD_MIN && DEFAULT_SETTINGS.threshold <= client.THRESHOLD_MAX);
});

test('C12 契约：client API 路由 = host 路由常量（设置/面板/台账/架构师目录）', () => {
  assert.equal(client.SETTINGS_API, hostRoute('SETTINGS_ROUTE'));
  assert.equal(client.PANEL_API, hostRoute('PANEL_ROUTE'));
  assert.equal(client.WORK_ITEMS_API, hostRoute('WORK_ITEMS_ROUTE'));
  assert.equal(client.ARCHITECT_MODELS_API, hostRoute('ARCHITECT_MODELS_ROUTE'));
});

test('C12/C10/D-12：client 退役死分支（autoChoose/autoDecision/cth）与本地派生公式已删除', () => {
  // 自决（autoChoose/autoDecision）v0.10.0 C10 从 host 面板删净：client 不得再读/写这两个字段。
  assert.equal(clientSource.includes('autoDecision'), false, 'autoDecision 死分支已删');
  assert.equal(clientSource.includes('autoChoose'), false, 'autoChoose 兼容写字段已删（PUT 不再写、也不读）');
  // 标签/推荐映射只保留契约区一套（不再有 CHIP_LABELS / RECOMMEND_OPERATIONS 第二套映射）。
  assert.equal(clientSource.includes('CHIP_LABELS'), false, 'CHIP_LABELS 重复映射已删');
  assert.equal(clientSource.includes('RECOMMEND_OPERATIONS'), false, 'RECOMMEND_OPERATIONS 重复映射已删');
  // 阈值只消费宿主 GET（C6/D-07），client 不得本地派生 ±5/+10。
  assert.equal(clientSource.includes('Number(settings.threshold) - 5'), false, '本地 warn 公式已删');
  assert.equal(clientSource.includes('Number(settings.threshold) + 10'), false, '本地 relay 公式已删');
  // cth 退役：bundle 里不再出现该退役值（选择/推荐/映射旧分支全删；C10 兼容债 grep 也不会命中）。
  assert.equal(clientSource.includes('compress-then-handoff'), false, 'cth 退役值不得再出现在 client');
});

test('C15：全文件只有一条 4s 轮询定时器 / 一份 visibilitychange 监听（双轮询已合并）', () => {
  assert.equal((clientSource.match(/setInterval\(/g) || []).length, 1, '只能有一个 setInterval（panel + 台账共享轮询）');
  assert.equal((clientSource.match(/addEventListener\("visibilitychange"/g) || []).length, 1, '只能注册一份 visibilitychange 监听');
  assert.equal((clientSource.match(/removeEventListener\("visibilitychange"/g) || []).length, 1, '监听必须成对移除');
  // 同一轮询 tick 内两条只读路由都由共享 load 发出（单次并行 fetch）。
  assert.ok(clientSource.includes('fetch(PANEL_API +'), '共享轮询取 panel');
  assert.ok(clientSource.includes('fetch(WORK_ITEMS_API +'), '共享轮询取 work-items');
});

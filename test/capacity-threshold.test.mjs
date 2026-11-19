/**
 * dsh-context-relay — v0.11 P0-E 容量保全线独立化（设计 §3.6 验收 1-6 集成面）。
 *
 * 纯函数（normalizeSettings/capacityOf）断言在 test/policy.test.mjs；本文件覆盖
 * 「settings.capacityThreshold（默认 55，独立配置）→ sentinel / relay_status / formatStatus」
 * 的接线与 56% 触发、46% 不触发、54% 已有 relay 无容量 notice、压缩后 ≥15% 重新武装。
 * 全部写 mkdtemp 临时目录，不触真实工作区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { NOTICE_MAX } from '../lib/agent/notice/plan.js';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const WORK_ITEMS_REL = '.scratch/context-relay/work-items.json';

/** 进程级共享状态复位：live 设置显式固定（threshold 默认 35 → 30/35/45；容量线缺省 55）。 */
function resetSharedState({ threshold = 35, capacityThreshold } = {}) {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-capacity-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  globalThis[SETTINGS_KEY] = {
    threshold,
    ...(capacityThreshold === undefined ? {} : { capacityThreshold }),
    defaultOperation: null,
    autoCompress: false,
    autoHandoff: false,
    unlimitedBudget: true,
    architect: true,
  };
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-capacity-'));
}

function fakeCtx(services) {
  const tools = new Map();
  const events = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, events };
}

function fakeSession({ id, cwd }) {
  return {
    id,
    header: { cwd },
    seq: 0,
    snapshotEvents() { return []; },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  };
}

function fakeServices({ session, state }) {
  return {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens ?? 0 }) },
    compaction: undefined,
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
    sessionQuery: undefined,
  };
}

/** apply agent → 捕获 pre-step 监听 / relay_status；inject 收集 notice 文本。 */
function harness({ pressure, settings, id = 'session-capacity-' + Math.random().toString(36).slice(2) } = {}) {
  resetSharedState(settings);
  const session = fakeSession({ id, cwd: tmpCwd() });
  const state = { pressure };
  const services = fakeServices({ session, state });
  const bundle = fakeCtx(services);
  apply(bundle.ctx, { workItemsPath: WORK_ITEMS_REL });
  const listener = bundle.events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);
  const status = () => bundle.tools.get('relay_status').execute({}, { agent });
  const noticeTexts = (needle) => injected.map((message) => message.content[0].text).filter((text) => text.includes(needle));
  return { state, injected, step, status, noticeTexts };
}

function pressureOfRatio(ratio) {
  return { contextWindow: 1_000_000, projectedTokens: Math.round(ratio * 1_000_000) };
}

test('P0-E 验收 5：relay_status.capacity.threshold=0.55，formatStatus 显示 55%；46% 时 band=relay 但容量不触发', async () => {
  const h = harness({ pressure: pressureOfRatio(0.56) });
  const status = await h.status();
  assert.equal(status.capacity.threshold, 0.55, '默认容量线 0.55（独立配置）');
  assert.equal(status.capacity.basis, 'ratio');
  assert.equal(status.capacity.atRisk, true);
  assert.equal(status.capacity.ratio, 0.56);
  assert.equal(status.lead.band, 'relay');
  assert.match(status.text, /capacity: 56\.0% ≥ 55\.0% → 容量保全（独立配置/);
  // 46%：band=relay（45% 线）但未到 55% 容量线 → 不保全、不渲染容量行。
  h.state.pressure = pressureOfRatio(0.46);
  const below = await h.status();
  assert.equal(below.lead.band, 'relay');
  assert.equal(below.capacity.atRisk, false);
  assert.doesNotMatch(below.text, /capacity:/);
  // 窗口未知：不猜、不保全，但仍如实报告独立配置阈值。
  h.state.pressure = { projectedTokens: 900_000 };
  const blind = await h.status();
  assert.equal(blind.capacity.atRisk, false);
  assert.equal(blind.capacity.basis, 'unavailable');
  assert.equal(blind.capacity.threshold, 0.55);
});

test('P0-E 验收 2/5：capacityThreshold 独立配置生效（70%），且不参与 band 派生', async () => {
  const h = harness({ pressure: pressureOfRatio(0.56), settings: { capacityThreshold: 70 } });
  const below = await h.status();
  assert.equal(below.capacity.threshold, 0.7);
  assert.equal(below.capacity.atRisk, false, '56% < 配置 70% 不触发');
  assert.equal(below.lead.band, 'relay', 'band 仍由 threshold=35 派生（45% 硬线）');
  h.state.pressure = pressureOfRatio(0.71);
  const at = await h.status();
  assert.equal(at.capacity.atRisk, true);
  assert.match(at.text, /capacity: 71\.0% ≥ 70\.0%/);
});

test('P0-E 验收 3：54% 已有 relay 时无容量 notice；56% 容量 notice 渲染 55%', async () => {
  const h = harness({ pressure: pressureOfRatio(0.46) });
  await h.step();
  assert.equal(h.injected.length, 1, '46%：只有到线 notice');
  assert.doesNotMatch(h.injected[0].content[0].text, /容量保全/);
  h.state.pressure = pressureOfRatio(0.54);
  await h.step();
  assert.equal(h.noticeTexts('容量保全').length, 0, '54% < 55% 且 relay 已触发 → 无容量 notice');
  h.state.pressure = pressureOfRatio(0.56);
  await h.step();
  assert.equal(h.noticeTexts('容量保全').length, 1, '56% ≥ 55% → 容量上升沿注入一次');
  const text = h.noticeTexts('容量保全')[0];
  assert.match(text, /56\.0%（容量线 55\.0%）/);
  assert.match(text, /最坏兜底/);
  assert.match(text, /不自动执行（不自动压缩\/不自动接力）/);
  // 同档不重复；回落重置后再次上升沿再提示一次。
  await h.step();
  assert.equal(h.noticeTexts('容量保全').length, 1);
});

test('P0-E 验收 4：到线与容量同 step 合并为一条 ≤900，文案同时含 band 与容量线', async () => {
  const h = harness({ pressure: pressureOfRatio(0.1) });
  await h.step();
  const before = h.injected.length;
  h.state.pressure = pressureOfRatio(0.56);
  await h.step();
  assert.equal(h.injected.length, before + 1, '同 step 只注入一条（升 relay + 容量上升沿合并）');
  const text = h.injected.at(-1).content[0].text;
  assert.match(text, /容量最坏兜底/);
  assert.match(text, /容量保全/);
  assert.match(text, /容量线 55\.0%/);
  assert.ok(text.length <= NOTICE_MAX, '合并后 ≤900 字符，实际 ' + text.length);
});

test('P0-E 验收 3：压缩后 used 降 ≥15% 且仍 ≥55% → capacityRearmed 再提示一次', async () => {
  const h = harness({ pressure: pressureOfRatio(1.0) });
  await h.step();
  assert.equal(h.noticeTexts('容量保全').length, 1, '100% 首次容量 notice');
  h.state.pressure = pressureOfRatio(0.8); // 降 20%，仍 ≥55%
  await h.step();
  assert.equal(h.noticeTexts('容量保全').length, 2, '下降 ≥15% 重新武装后再提示一次');
  h.state.pressure = pressureOfRatio(0.79); // 再降 1.25% < 15%
  await h.step();
  assert.equal(h.noticeTexts('容量保全').length, 2, '下降不足 15% 不重新武装');
});

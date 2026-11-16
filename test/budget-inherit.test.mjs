/**
 * v0.10.0：Lead「预算无上限」开关继承给由它创建的队友/架构师/dispatch worker。
 *
 * 覆盖 shared 层契约（三值判定 / pending 继承登记的 mark-consume-过期-clear）与
 * lib/agent.js agent/created 监听器的子会话写入（depth=1 + origin=subagent + parentSession）。
 * 工具侧真实路径（relay_renew / relay_dispatch spawn 继承、relay_freshen 同会话同步）在
 * test/team.test.mjs（复用该文件的 fake team 夹具）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/agent.js';
import {
  clearPendingBudgetInherit,
  clearSharedMemory,
  consumePendingBudgetInherit,
  effectiveUnlimitedBudgetOf,
  markPendingBudgetInherit,
} from '../lib/agent/shared.js';
import { clearPanelMemory, configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const LEAD = 'session-lead-budget';

/** 进程级共享状态复位：面板落临时文件、live 设置与 pending 登记清空。 */
function resetSharedState(settings) {
  clearPanelMemory();
  clearSharedMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-budget-inherit-panel-')), 'panel.json') });
  if (settings === undefined) delete globalThis[SETTINGS_KEY];
  else globalThis[SETTINGS_KEY] = settings;
}

/** 极简 fake ctx：只实现 lib/agent.js apply 用到的接口（照 budget-snapshot 夹具口径）。 */
function fakeCtx() {
  const tools = new Map();
  const sections = [];
  const events = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get() { return undefined; },
  };
  return { ctx, tools, sections, events };
}

function createdListenerOf(ctx) {
  const found = ctx.events.find((entry) => entry.name === 'agent/created');
  assert.ok(found, 'agent/created listener registered');
  return found.listener;
}

function childAgent(id, parentSession, header = {}) {
  return { session: { id, header: { origin: 'subagent', delegationDepth: 1, parentSession, ...header } } };
}

// ── shared：三值判定 ───────────────────────────────────────────────────

test('effectiveUnlimitedBudgetOf：panel 显式 true/false 覆盖全局；未写跟随 settings.unlimitedBudget', () => {
  resetSharedState({ unlimitedBudget: true });
  try {
    // 未写 panel → 跟随全局
    assert.equal(effectiveUnlimitedBudgetOf('session-unset'), true);
    // 面板显式 false 覆盖全局 true
    updatePanelState('session-off', { unlimitedBudget: false });
    assert.equal(effectiveUnlimitedBudgetOf('session-off'), false);
    // 面板显式 true 覆盖全局 false
    globalThis[SETTINGS_KEY] = { unlimitedBudget: false };
    updatePanelState('session-on', { unlimitedBudget: true });
    assert.equal(effectiveUnlimitedBudgetOf('session-on'), true);
    assert.equal(effectiveUnlimitedBudgetOf('session-unset'), false, '未写 panel 跟随全局关');
    // 无 agent 上下文（undefined/null 会话）→ 全局默认
    assert.equal(effectiveUnlimitedBudgetOf(undefined), false);
    assert.equal(effectiveUnlimitedBudgetOf(null), false);
    // 可注入 settings 解析器（agent apply 的 config+live 闭包；无 live 发布时按该解析器）
    delete globalThis[SETTINGS_KEY];
    assert.equal(effectiveUnlimitedBudgetOf('session-unset', () => ({ unlimitedBudget: false })), false);
    assert.equal(effectiveUnlimitedBudgetOf('session-unset', () => ({ unlimitedBudget: true })), true);
  } finally {
    resetSharedState();
  }
});

// ── shared：pending 继承登记 ───────────────────────────────────────────

test('pending 预算继承：mark→consume 返回值并删除；clear 后 consume=undefined；过期(>60s)返回 undefined', () => {
  resetSharedState();
  try {
    markPendingBudgetInherit(LEAD, false);
    assert.equal(consumePendingBudgetInherit(LEAD), false, 'mark false → consume false');
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, '消费即删');
    markPendingBudgetInherit(LEAD, true);
    assert.equal(consumePendingBudgetInherit(LEAD), true, 'mark true → consume true');
    markPendingBudgetInherit(LEAD, true);
    clearPendingBudgetInherit(LEAD);
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, 'clear 后无标记');
    // 过期：伪造 Date.now（同文件顺序执行，try/finally 恢复）
    markPendingBudgetInherit(LEAD, true);
    const realNow = Date.now;
    Date.now = () => realNow() + 60001;
    try {
      assert.equal(consumePendingBudgetInherit(LEAD), undefined, '过期标记视为失败残留');
      assert.equal(consumePendingBudgetInherit(LEAD), undefined, '过期消费即删');
    } finally {
      Date.now = realNow;
    }
    // 非法 key 不登记、不抛
    markPendingBudgetInherit(undefined, true);
    markPendingBudgetInherit('', true);
    assert.equal(consumePendingBudgetInherit(undefined), undefined);
    assert.equal(consumePendingBudgetInherit(''), undefined);
  } finally {
    resetSharedState();
  }
});

// ── agent/created：子会话面板继承 ─────────────────────────────────────

test('agent/created：父标记 false → 子会话面板 false；无标记不落 panel；父 true → true（depth=1 且 origin=subagent）', () => {
  resetSharedState({ unlimitedBudget: true });
  try {
    const fake = fakeCtx();
    apply(fake.ctx, {});
    const created = createdListenerOf(fake);
    // ① 父开关 false：子会话创建后面板显式 false（覆盖全局 true）
    markPendingBudgetInherit(LEAD, false);
    created({ agent: childAgent('session-child-off', LEAD) });
    assert.equal(panelStateOf('session-child-off').unlimitedBudget, false);
    assert.equal(consumePendingBudgetInherit(LEAD), undefined, '监听器消费标记');
    // ② 无标记：不写 panel（不改全局后仍跟随全局，证明没有 materialize 记录）
    created({ agent: childAgent('session-child-none', LEAD) });
    delete globalThis[SETTINGS_KEY];
    assert.equal(panelStateOf('session-child-none').unlimitedBudget, null, '无标记不落 panel（无记录 → null）');
    globalThis[SETTINGS_KEY] = { unlimitedBudget: false };
    assert.equal(panelStateOf('session-child-none').unlimitedBudget, false, '无标记不落 panel（跟随全局）');
    // ③ 父开关 true：子会话写 true（覆盖全局 false）；force 语义：全局后续变化不翻转
    globalThis[SETTINGS_KEY] = { unlimitedBudget: false };
    markPendingBudgetInherit(LEAD, true);
    created({ agent: childAgent('session-child-on', LEAD) });
    assert.equal(panelStateOf('session-child-on').unlimitedBudget, true);
    globalThis[SETTINGS_KEY] = { unlimitedBudget: false };
    assert.equal(panelStateOf('session-child-on').unlimitedBudget, true, 'force 显式落库');
    // ④ 非直接子会话（depth=2）/非 subagent origin 不消费、不写
    markPendingBudgetInherit(LEAD, false);
    created({ agent: childAgent('session-child-deep', LEAD, { delegationDepth: 2 }) });
    created({ agent: { session: { id: 'session-child-root', header: { parentSession: LEAD } } } });
    assert.equal(consumePendingBudgetInherit(LEAD), false, '非 depth=1/非 subagent 不消费标记');
    assert.equal(panelStateOf('session-child-deep').unlimitedBudget, false, 'depth=2 不写入（跟随全局 false）');
  } finally {
    resetSharedState();
  }
});

// ── agent/created：继承值 == 当时全局默认时仍需 force 落库（review P2-1）────
test('agent/created：继承值等于当时全局默认也 force 落库（全局默认消失后仍为显式 true）', () => {
  resetSharedState({ unlimitedBudget: true });
  try {
    const fake = fakeCtx();
    apply(fake.ctx, {});
    const created = createdListenerOf(fake);
    markPendingBudgetInherit(LEAD, true);
    created({ agent: childAgent('session-child-force', LEAD) });
    delete globalThis[SETTINGS_KEY];
    assert.equal(panelStateOf('session-child-force').unlimitedBudget, true, 'force 写入显式面板值：全局默认消失后仍 true（不写则回落 null/规范默认）');
  } finally {
    resetSharedState();
  }
});


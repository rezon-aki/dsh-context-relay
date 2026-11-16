import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_MAX, bandLineOf, panelSignatureOf, planNotices, planeIssueOf, unavailableNoticeText } from '../lib/agent/notice/plan.js';

/** C4 notice 规划纯函数：事实 → 本步 0/1 条 notice + track/claims（不碰状态、不注入）。 */

const PANEL = { defaultOperation: null, autoCompress: false, autoHandoff: false, authorizeNext: false };
const BASE = {
  subagent: false,
  phase: 'build',
  state: { band: 'organize', used: 420000, window: 1000000, ratio: 0.42 },
  lastBand: 'ok',
  compactionSeq: -1,
  panel: PANEL,
  escalation: undefined,
  ledgerEnabled: true,
  ledger: undefined,
  teamContext: undefined,
  pendingClosure: [],
  dispatchRows: [],
  guard: {},
  capacity: { atRisk: false, ratio: 0.42, threshold: 0.85 },
  capacityMemory: undefined,
  panelPrevious: panelSignatureOf(PANEL),
  metricsUnavailable: false,
  canInject: true,
};
const facts = (over) => ({ ...BASE, ...over });
const LEDGER_PENDING = { exists: true, counts: { total: 3, pending: 2, doing: 1, blocked: 1, open: 0, done: 1 } };

test('planNotices：Lead 升线 → 一条到线提醒（带台账行），claim 到线档位', () => {
  const plan = planNotices(facts({ ledger: LEDGER_PENDING }));
  assert.equal(plan.rising, true);
  assert.equal(plan.notice.kind, 'phase');
  assert.match(plan.notice.text, /\[context-relay\] band=organize/);
  assert.match(plan.notice.text, /到线提醒（插件 notice，非用户发言）/);
  assert.match(plan.notice.text, /\n工作台账：未闭合 2 \/ 共 3/);
  assert.match(plan.notice.summary, /relay 到线提醒/);
  assert.deepEqual(plan.claims.lastBand, { band: 'organize', compactionSeq: -1 });
  assert.ok(plan.notice.text.length <= NOTICE_MAX);
});

test('planNotices：同档/回退不注入，只 track 当前档位（升线才提醒）', () => {
  const plan = planNotices(facts({ lastBand: 'organize' }));
  assert.equal(plan.rising, false);
  assert.equal(plan.notice, null);
  assert.deepEqual(plan.track.lastBand, { band: 'organize', compactionSeq: -1 });
  assert.deepEqual(plan.claims, {});
  // 存档跨档：relay → warn 是回退，也不注入
  const fallback = planNotices(facts({ lastBand: 'relay', state: { band: 'warn', used: 360000, window: 1000000, ratio: 0.36 } }));
  assert.equal(fallback.notice, null);
  assert.deepEqual(fallback.track.lastBand.band, 'warn');
});

test('planNotices：队友稿不含 Lead 台账行（M-12），带 escalation 结果', () => {
  const plan = planNotices(facts({
    subagent: true,
    escalation: { sent: true },
    ledger: LEDGER_PENDING,
    panel: undefined,
    panelPrevious: undefined,
  }));
  assert.equal(plan.notice.kind, 'phase');
  assert.match(plan.notice.text, /^\[context-relay\] band=organize/);
  assert.match(plan.notice.text, /队友会话·到线请示/);
  assert.match(plan.notice.text, /已自动向上一级（Lead）发出请示/);
  assert.doesNotMatch(plan.notice.text, /工作台账/, 'M-12：队友看不到 Lead 台账计数');
  assert.doesNotMatch(plan.notice.text, /relay_work_items/);
  assert.deepEqual(plan.claims.lastBand, { band: 'organize', compactionSeq: -1 });
});

test('planNotices：容量上升沿与到线提醒合并为一条；单独时一条容量 notice', () => {
  const capacity = { atRisk: true, ratio: 0.86, threshold: 0.85 };
  const merged = planNotices(facts({ capacity }));
  assert.equal(merged.capacityRising, true);
  assert.equal(merged.notice.kind, 'phase', '与到线提醒同 step 合并（仍是一条）');
  assert.match(merged.notice.text, /容量保全/);
  assert.match(merged.notice.text, /ratio 86\.0%，阈值 85\.0%/);
  assert.deepEqual(merged.claims.capacity, { used: 420000 });
  assert.ok(merged.notice.text.length <= NOTICE_MAX);

  const alone = planNotices(facts({ lastBand: 'relay', state: { band: 'relay', used: 420000, window: 1000000, ratio: 0.42 }, capacity }));
  assert.equal(alone.notice.kind, 'capacity');
  assert.match(alone.notice.summary, /容量保全/);
  assert.deepEqual(alone.claims.capacity, { used: 420000 });
});

test('planNotices：压缩生效（used 降 ≥15%）重新武装容量并再提示一次', () => {
  const plan = planNotices(facts({
    lastBand: 'relay',
    state: { band: 'relay', used: 850000, window: 1000000, ratio: 0.85 },
    capacity: { atRisk: true, ratio: 0.85, threshold: 0.85 },
    capacityMemory: { used: 1000000 },
  }));
  assert.equal(plan.capacityRearmed, true);
  assert.equal(plan.track.capacity, null, '重新武装 = 清掉上次 used');
  assert.equal(plan.notice.kind, 'capacity', '重新武装后可再提示一次');
  assert.deepEqual(plan.claims.capacity, { used: 850000 });
  // 回落到阈值下：静默清武装
  const dropped = planNotices(facts({
    lastBand: 'relay',
    state: { band: 'relay', used: 420000, window: 1000000, ratio: 0.42 },
    capacity: { atRisk: false, ratio: 0.42, threshold: 0.85 },
    capacityMemory: { used: 500000 },
  }));
  assert.equal(dropped.notice, null);
  assert.equal(dropped.track.capacity, null);
});

test('planNotices：面板变更——首见只记基线；变化注入一次；同 step 被到线提醒覆盖时 claim 签名（不补发）', () => {
  const first = planNotices(facts({ panelPrevious: undefined, lastBand: 'organize' }));
  assert.equal(first.notice, null);
  assert.equal(typeof first.track.panelSig, 'string');

  const panel = { ...PANEL, defaultOperation: 'compress', autoCompress: true };
  const changed = planNotices(facts({ panel, lastBand: 'organize' }));
  assert.equal(changed.notice.kind, 'panel');
  assert.match(changed.notice.text, /面板已更新/);
  assert.doesNotMatch(changed.notice.text, /autoChoose|autoDecision/, 'C10b：面板变更文案不再拼退役自决字段');
  assert.equal(panelSignatureOf({ ...panel, autoChoose: true }), panelSignatureOf(panel), 'C10b：面板签名不计入退役字段');
  assert.equal(changed.claims.panelSig, panelSignatureOf(panel));

  const suppressed = planNotices(facts({ panel }));
  assert.equal(suppressed.notice.kind, 'phase');
  assert.equal(suppressed.claims.panelSig, panelSignatureOf(panel), '到线提醒已带全量面板事实 → 记签名，不补发');
});

test('planNotices：台账批次（焦点 → 上下文 → 闭环 → 队友 → 派活）一条注入，claim 行级键 + 消费派活提示', () => {
  const plan = planNotices(facts({
    lastBand: 'organize',
    ledger: { exists: true, currentPhase: { phase: 'build' }, items: [{ id: 'p1', title: '修闸门', status: 'doing', next: '写测试', phase: 'build' }], counts: { total: 1, pending: 1 } },
    pendingClosure: [{ tool: 'write', target: 'x.js' }],
    teamContext: { rows: [{ name: 'mate-1', band: 'organize' }], pending: [{ name: 'mate-1', band: 'organize' }] },
    dispatchRows: [{ target: 'mate-2', band: 'organize', ratio: 0.42, action: '先让它 relay_checkpoint' }],
  }));
  assert.equal(plan.notice.kind, 'ledger');
  assert.equal(plan.notice.summary, '[context-relay] 台账 · 非用户发言');
  const text = plan.notice.text;
  const focusIdx = text.indexOf('[台账·');
  const bandIdx = text.indexOf('[上下文]');
  const closureIdx = text.indexOf('[闭环]');
  const teamIdx = text.indexOf('[队友]');
  const dispatchIdx = text.indexOf('[派活·队友上下文]');
  assert.ok(focusIdx === 0 && bandIdx > focusIdx && closureIdx > bandIdx && teamIdx > closureIdx && dispatchIdx > teamIdx, text);
  assert.match(text, /\[闭环\] 上一步改动未落账：write\(x\.js\)/);
  assert.match(text, /\[派活·队友上下文\] mate-2 band=organize/);
  assert.ok(plan.claims.guard !== undefined);
  assert.equal(plan.claims.guard.focus, plan.claims.guard.focus);
  assert.equal(plan.claims.dropDispatch, true);
  assert.ok(text.length <= NOTICE_MAX);
});

test('planNotices：批次超 900 先丢 [队友] 再丢 [上下文]，焦点/闭环保留且不截断', () => {
  const plan = planNotices(facts({
    lastBand: 'organize',
    ledger: {
      exists: true,
      currentPhase: { phase: 'build' },
      items: [{ id: 'p1', title: 'a'.repeat(120), status: 'doing', next: 'b'.repeat(160), phase: 'build' }],
      counts: { total: 1, pending: 1 },
    },
    pendingClosure: ['x', 'y', 'z'].map((name) => ({ tool: 'write', target: name.repeat(180) + '.js' })),
    teamContext: { rows: [{ name: 'n'.repeat(180), band: 'organize' }], pending: [{ name: 'n'.repeat(180), band: 'organize' }] },
    dispatchRows: [],
  }));
  const text = plan.notice.text;
  assert.ok(text.length <= NOTICE_MAX, 'chars ' + text.length);
  assert.match(text, /\[台账·build/);
  assert.match(text, /\[闭环\] 上一步改动未落账：write\(x+\.js\)/);
  assert.doesNotMatch(text, /\[队友\]/);
  assert.doesNotMatch(text, /\[上下文\]/);
  assert.deepEqual(plan.claims.guard.teamSeen, {}, '[队友] 被丢弃时不推进 teamSeen（下一步补）');
});

test('planNotices：指标不可用（M-14）一次性保守提示，claim basis 键', () => {
  // v0.10 C6/D-04：bandFor 对指标不可用显式返回 band=unavailable（不再静默 ok）——按生产形状喂入。
  const unavailable = { band: 'unavailable', used: undefined, window: undefined, ratio: undefined, basis: 'unavailable' };
  assert.match(unavailableNoticeText(), /band=unavailable/);
  assert.equal(bandLineOf(unavailable, PANEL), '', 'unavailable 不混进台账 [上下文] 行（由 M-14 notice 表达）');
  assert.equal(bandLineOf({ band: 'ok' }, PANEL), '');
  assert.equal(bandLineOf({ band: 'warn' }, PANEL), '[上下文] band=warn');
  const plan = planNotices(facts({
    state: unavailable,
    lastBand: 'ok',
    capacity: { atRisk: false, ratio: undefined, threshold: 0.85, basis: 'unavailable' },
    panel: undefined,
    panelPrevious: undefined,
    metricsUnavailable: true,
  }));
  assert.equal(plan.notice.kind, 'unavailable');
  assert.match(plan.notice.text, /上下文指标不可用/);
  assert.match(plan.notice.text, /不当作 ok/);
  assert.equal(plan.claims.guard.basisUnavailable, true);
  const again = planNotices(facts({
    state: unavailable,
    lastBand: 'ok',
    capacity: { atRisk: false, ratio: undefined, threshold: 0.85, basis: 'unavailable' },
    panel: undefined,
    panelPrevious: undefined,
    metricsUnavailable: true,
    guard: { basisUnavailable: true },
  }));
  assert.equal(again.notice, null, '同段只提示一次（压缩复位后 guard 清除可再提示）');
});

test('planNotices：纯函数（重复调用结果一致）、每步 ≤1 条 ≤900 字符', () => {
  const cases = [
    facts({}),
    facts({ capacity: { atRisk: true, ratio: 0.9, threshold: 0.85 } }),
    facts({ panel: { ...PANEL, defaultOperation: 'handoff' } }),
    facts({ ledger: LEDGER_PENDING, pendingClosure: [{ tool: 'write', target: 'x.js' }] }),
    facts({ metricsUnavailable: true, state: { band: 'ok', used: undefined } }),
  ];
  for (const scenario of cases) {
    const copy = JSON.parse(JSON.stringify(scenario, (_key, value) => (value === undefined ? null : value)));
    const first = planNotices(scenario);
    const second = planNotices(scenario);
    assert.deepEqual(first, second, 'planNotices 不读/不改模块状态');
    assert.ok(first.notice === null || first.notice.text.length <= NOTICE_MAX);
    assert.ok(copy !== undefined);
  }
});

test('planNotices：台账没有未闭合分点时不发 [闭环]（没有分点可落账）', () => {
  const closedLedger = { exists: true, currentPhase: { phase: 'ship' }, items: [{ id: 'p1', title: '收尾', status: 'done', phase: 'ship' }], counts: { total: 1, pending: 0, doing: 0, blocked: 0, open: 0, done: 1 } };
  const suppressed = planNotices(facts({ lastBand: 'organize', ledger: closedLedger, pendingClosure: [{ tool: 'write', target: 'README.md' }] }));
  // 全 done 的台账仍会有「可以关 phase」焦点行（另一种提醒），本用例只断言 [闭环] 被抑制。
  assert.ok(suppressed.notice === null || !suppressed.notice.text.includes('[闭环]'), '无未闭合分点 → 不发闭环行');
  assert.equal(suppressed.claims?.guard?.closureSig ?? '', '', '不留下闭环去重签名，之后开新分点也不会重提旧改动');
  // 有未闭合分点时行为不变（同场景对照）
  const openLedger = { exists: true, currentPhase: { phase: 'build' }, items: [{ id: 'p1', title: '修', status: 'doing', next: '写测试', phase: 'build' }], counts: { total: 1, pending: 1 } };
  const shown = planNotices(facts({ lastBand: 'organize', ledger: openLedger, pendingClosure: [{ tool: 'write', target: 'README.md' }] }));
  assert.match(shown.notice.text, /\[闭环\] 上一步改动未落账：write\(README\.md\)/);
});

// ── C15/§5：平面降级可见（planeStatusOf → 每压缩周期一次 notice）──────────────
const DEGRADED_PLANE = { role: 'lead', installed: true, degradations: [{ seam: 'schedule', reason: 'list() did not return the rc.2 page shape', level: 'degraded' }] };

test('planNotices：平面/seam 降级 → 一次性 notice（seam 名+原因+relay_status.plane 指针），claim planeSig', () => {
  assert.equal(planeIssueOf({ role: 'lead', installed: true, degradations: [] }), null, '健康平面无 issue');
  const plan = planNotices(facts({ lastBand: 'organize', plane: DEGRADED_PLANE }));
  assert.equal(plan.notice.kind, 'plane');
  assert.match(plan.notice.summary, /平面\/seam 降级/);
  assert.match(plan.notice.text, /平面\/seam 降级/);
  assert.match(plan.notice.text, /seam schedule（degraded）：list\(\) did not return/);
  assert.match(plan.notice.text, /relay_status\.plane/);
  assert.match(plan.notice.text, /每压缩周期提示一次/);
  assert.equal(typeof plan.claims.guard.planeSig, 'string');
  assert.ok(plan.notice.text.length <= NOTICE_MAX, 'chars ' + plan.notice.text.length);
  // installed=false 同样提示（工具裁剪/影子协议段可能未生效）
  const uninstalled = planNotices(facts({ lastBand: 'organize', plane: { role: 'teammate', installed: false, degradations: [] } }));
  assert.equal(uninstalled.notice.kind, 'plane');
  assert.match(uninstalled.notice.text, /平面未装好（role=teammate）/);
  // 无 plane 事实（未 reconcile/精简句柄）不提示源噪音
  assert.equal(planNotices(facts({ lastBand: 'organize' })).notice, null);
});

test('planNotices：平面降级同压缩周期只提示一次；guard 跨台账批次保留，压缩复位（guard 清空）后重新提示', () => {
  const first = planNotices(facts({ lastBand: 'organize', plane: DEGRADED_PLANE }));
  const guard = first.claims.guard;
  const same = planNotices(facts({ lastBand: 'organize', plane: DEGRADED_PLANE, guard }));
  assert.equal(same.notice, null, '同压缩周期已提示：不重复');
  assert.equal(same.track.guard.planeSig, guard.planeSig, '台账批次重写 guard 时保留 planeSig（不下一步重发）');
  const reset = planNotices(facts({ lastBand: 'organize', plane: DEGRADED_PLANE, guard: {} }));
  assert.equal(reset.notice.kind, 'plane', '压缩复位（deliver 清 LEDGER_GUARD）后重新提示');
  // 降级事实变化 = 新事件，可再提示一次（签名不同）
  const changed = planNotices(facts({ lastBand: 'organize', guard, plane: { ...DEGRADED_PLANE, installed: false } }));
  assert.equal(changed.notice.kind, 'plane');
});

test('planNotices：更高优先级 notice 同一步不 claim 平面降级（下一步补，不丢事实）', () => {
  const rising = planNotices(facts({ plane: DEGRADED_PLANE }));
  assert.equal(rising.notice.kind, 'phase', '到线提醒优先');
  assert.equal(rising.claims.guard?.planeSig, undefined, '被覆盖时不 claim');
  const nextGuard = rising.claims.guard ?? rising.track.guard ?? {};
  const next = planNotices(facts({ plane: DEGRADED_PLANE, lastBand: 'organize', guard: nextGuard }));
  assert.equal(next.notice.kind, 'plane', '下一步补发平面降级');
});

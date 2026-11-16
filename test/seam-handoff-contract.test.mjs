import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayHandoffTool } from '../lib/agent/handoff.js';
import { configurePanelStore, clearPanelMemory } from '../lib/panel-store.js';

// rc.2 官方形状（@deepseek-ai/dsh-schedule 0.2.2-rc.2）：
//   list(req?: {active?,limit?,offset?}) → ScheduleListResult {items,shown,total,limit,offset}（非数组、不可迭代）
//   entry = ScheduleRecord & {target, involvedSessionIds, status, ...}（target.kind==='session' 才是旧会话归属）
//   edit({id,action:'update',patch:{target},...}) 改投递目标保留规则与投递史；delete 走 edit({action:'delete'})。
// 审计 M-01 建议：按 rc.2 Host-wide target 语义重写，形状不符降级 N/A+warn 而非 preflight 拒绝。
const LIST_LIMIT = 500;

function catalogEntry(id, target, extra = {}) {
  return {
    id,
    kind: 'every',
    title: 'timer ' + id,
    prompt: 'run ' + id,
    everySeconds: 300,
    scheduledAt: '2026-11-16T00:00:00.000Z',
    target,
    involvedSessionIds: target.kind === 'session' ? [target.sessionId] : [],
    status: 'active',
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    ...extra,
  };
}

function page(items, offset = 0) {
  return { items, shown: items.length, total: items.length, limit: items.length || 1, offset };
}

function harness({ schedule } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-seam-'));
  delete globalThis[Symbol.for('dsh-context-relay.handoff.recovery')];
  clearPanelMemory();
  configurePanelStore({ panelPath: join(cwd, 'panel.json') });
  const calls = [];
  const warns = [];
  const session = { id: 'old', header: { cwd }, snapshotEvents: () => [], requestHeader: () => undefined };
  const inbox = { nextTurn: [], nextStep: [] };
  const child = {
    session: { id: 'new', header: { cwd }, requestHeader: () => undefined, snapshotEvents: () => [] },
    inbox,
    followup(message) { inbox.nextTurn.push(message); },
    cancel() {},
  };
  const services = {
    agents: { async create() { calls.push('create'); return { agent: child, async dispose() {} }; }, get: () => child },
    agentPresets: { async mount() {} },
    sessionController: { async create() { calls.push('controller-create'); return { sessionId: 'new' }; } },
    // child-1 是旧会话树里的子智能体：它名下的定时任务也要盘点/改投递目标（不中断 idle 子级）。
    subagents: { async listDescendants() { return [{ kind: 'child', id: 'child-1', mode: 'one-shot', activity: 'idle', depth: 1 }]; } },
    workspaceRegistry: { async resolveByPath() { return { id: 'ws', async attachSession() {} }; } },
    ...(schedule === undefined ? {} : { schedule }),
  };
  const ctx = {
    get: (name) => services[name],
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    on: () => () => {},
    effect: (fn) => fn(),
  };
  const tool = createRelayHandoffTool({ ctx, currentThresholds: () => ({ baseline: 0.35 }), presetId: 'relay', inheritOnHandoff: false, workItems: { enabled: false } });
  return { cwd, calls, warns, run: () => tool.execute({ human_approved: true, status: { goal: 'seam contract' } }, { agent: { session, options: {} } }) };
}

test('seam: rc.2 分页 list() 收集旧会话树任务并只改投递目标（edit，不 create/delete）', async () => {
  const tasks = [
    catalogEntry('s-old-1', { kind: 'session', sessionId: 'old' }),
    catalogEntry('s-old-2', { kind: 'session', sessionId: 'old' }, { status: 'paused' }),
    catalogEntry('s-child', { kind: 'session', sessionId: 'child-1' }, { kind: 'cron', expression: '*/5 * * * *', timeZone: 'UTC' }),
    catalogEntry('s-stranger', { kind: 'session', sessionId: 'other' }),
    catalogEntry('s-new', { kind: 'new', create: {} }),
    catalogEntry('s-new-once', { kind: 'new_once', sessionId: 'session-schedule-x', create: {} }),
    catalogEntry('s-ended', { kind: 'session', sessionId: 'old' }, { status: 'ended' }),
  ];
  const listCalls = [];
  const editCalls = [];
  const schedule = {
    async list(request = {}) {
      listCalls.push({ ...request });
      // 服务可能应用比请求更小的页：插件必须按返回值 offset/total 翻页，不能只取第一页。
      const size = 2;
      const offset = request.offset ?? 0;
      const items = tasks.slice(offset, offset + size);
      return { items, shown: items.length, total: tasks.length, limit: size, offset };
    },
    async edit(request) {
      editCalls.push(request);
      assert.equal(request.action, 'update', 'cleanup 迁移用 edit 改 target，不删除源任务');
      return catalogEntry(request.id, { kind: 'session', sessionId: request.patch.target.sessionId });
    },
    async create() { throw new Error('cleanup must not recreate schedules: rc.2 edit retarget preserves the rule and delivery history'); },
    async remove() { throw new Error('cleanup must not delete schedules: retarget is the migration'); },
  };
  const h = harness({ schedule });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sessionId, 'new');
  // 归属 = target.kind==='session' 的 sessionId ∈ 旧会话树；ended / other-target 不进盘点。
  assert.deepEqual(r.handover.inventory.schedules.map((row) => [row.id, row.owner]), [
    ['s-old-1', 'old'],
    ['s-old-2', 'old'],
    ['s-child', 'child-1'],
  ]);
  assert.deepEqual(r.handover.inventory.errors, []);
  assert.ok(!r.handover.inventory.skipped.includes('schedule'));
  assert.deepEqual(editCalls, [
    { id: 's-old-1', action: 'update', patch: { target: { kind: 'session', sessionId: 'new' } } },
    { id: 's-old-2', action: 'update', patch: { target: { kind: 'session', sessionId: 'new' } } },
    { id: 's-child', action: 'update', patch: { target: { kind: 'session', sessionId: 'new' } } },
  ]);
  assert.deepEqual(r.handover.cleanup.schedules.map((row) => [row.id, row.action]), [
    ['s-old-1', 'transferred'],
    ['s-old-2', 'transferred'],
    ['s-child', 'transferred'],
  ]);
  assert.deepEqual(r.handover.cleanup.errors, []);
  assert.match(r.summary, /定时任务 3→3 已迁移/, r.summary);
  assert.ok(listCalls.length >= 4, '必须翻页取全量: ' + JSON.stringify(listCalls));
  assert.ok(listCalls.every((call) => call.limit === LIST_LIMIT), '显式 rc.2 limit: ' + JSON.stringify(listCalls));
  assert.ok(listCalls.some((call) => Number.isSafeInteger(call.offset) && call.offset > 0), '必须带 offset 翻页');
});

test('seam: 无 schedule 服务时走 skipped=N/A，交接正常完成', async () => {
  const h = harness({});
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.handover.inventory.skipped.includes('schedule'));
  assert.ok(r.handover.cleanup.skipped.includes('schedule'));
  assert.deepEqual(r.handover.inventory.schedules, []);
  assert.deepEqual(r.handover.inventory.errors, []);
  assert.match(r.summary, /定时任务 N\/A/, r.summary);
});

test('seam: list() 返回 rc.1 数组/null/坏 items 时降级 N/A+warn，不拒绝 preflight', async () => {
  const cases = [
    () => [catalogEntry('s', { kind: 'session', sessionId: 'old' })],
    () => ({ items: null, shown: 0, total: 0, limit: 100, offset: 0 }),
    () => null,
    () => undefined,
  ];
  for (const [index, listOf] of cases.entries()) {
    const h = harness({ schedule: { async list() { return listOf(); }, async edit() { throw new Error('must not migrate on shape mismatch'); } } });
    const r = await h.run();
    assert.equal(r.ok, true, 'case ' + index + ': ' + JSON.stringify(r).slice(0, 500));
    assert.ok(r.handover.inventory.skipped.includes('schedule'), 'case ' + index);
    assert.deepEqual(r.handover.inventory.errors, [], 'case ' + index + ' 形状不符不得拒绝交接');
    assert.deepEqual(r.handover.inventory.schedules, [], 'case ' + index);
    assert.ok(h.warns.some((message) => /schedule/i.test(message) && /N\/A|shape/i.test(message)), 'case ' + index + ': ' + h.warns.join(' | '));
    assert.match(r.summary, /定时任务 N\/A/, 'case ' + index);
  }
});

test('seam: list 有而 edit 缺（形状不兼容）时降级 N/A+warn', async () => {
  const h = harness({ schedule: { async list() { return page([catalogEntry('s', { kind: 'session', sessionId: 'old' })]); } } });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.handover.inventory.skipped.includes('schedule'));
  assert.deepEqual(r.handover.inventory.schedules, []);
  assert.ok(h.warns.some((message) => /schedule seam unsupported/i.test(message)), h.warns.join(' | '));
});

test('seam: cleanup 时任务已消失（edit → schedule_not_found）不算清理失败', async () => {
  const h = harness({ schedule: {
    async list() { return page([catalogEntry('s-gone', { kind: 'session', sessionId: 'old' })]); },
    async edit() { return { id: 's-gone', code: 'schedule_not_found' }; },
  } });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.handover.cleanup.schedules[0].action, 'not-found');
  assert.deepEqual(r.handover.cleanup.errors, []);
});

test('seam: edit 返回 schedule_conflict（未提交）时清理失败并留 recovery，不记 transferred', async () => {
  const h = harness({ schedule: {
    async list() { return page([catalogEntry('s-conflict', { kind: 'session', sessionId: 'old' })]); },
    async edit() { return { id: 's-conflict', code: 'schedule_conflict' }; },
  } });
  const r = await h.run();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'handoff-cleanup-failed');
  assert.match(JSON.stringify(r.recovery), /schedule_conflict/);
  assert.equal(r.handover.cleanup.schedules[0].action, 'pending');
});

test('seam: edit 返回的 target 未指向新会话时清理失败（不假记 transferred）', async () => {
  const h = harness({ schedule: {
    async list() { return page([catalogEntry('s-unconfirmed', { kind: 'session', sessionId: 'old' })]); },
    async edit() { return catalogEntry('s-unconfirmed', { kind: 'session', sessionId: 'old' }); },
  } });
  const r = await h.run();
  assert.equal(r.code, 'handoff-cleanup-failed');
  assert.match(JSON.stringify(r.recovery), /did not confirm the retarget/);
  assert.equal(r.handover.cleanup.schedules[0].action, 'pending');
});

test('seam: 可选盘点 list() 抛错降级 N/A+warn，不记 errors、不拒绝 preflight（C15 缺口3）', async () => {
  const h = harness({ schedule: { async list() { throw new Error('schedule storage boom'); }, async edit() { throw new Error('must not migrate after skipped inventory'); } } });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.handover.inventory.skipped.includes('schedule'));
  assert.deepEqual(r.handover.inventory.errors, [], '可选盘点抛错不得计入 errors（否则会 preflight fail）');
  assert.deepEqual(r.handover.inventory.schedules, []);
  assert.deepEqual(r.handover.cleanup.schedules, []);
  assert.ok(h.warns.some((message) => /schedule inventory unavailable/i.test(message) && /N\/A/i.test(message)), h.warns.join(' | '));
  assert.match(r.summary, /定时任务 N\/A/);
});

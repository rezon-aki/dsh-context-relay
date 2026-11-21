import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIncidentEntries, readIncidents, recordIncident, settleIncidents } from '../lib/agent/incidents.js';

const LEAD = 'session-lead';
const tempCwd = () => mkdtempSync(join(tmpdir(), 'relay-incidents-'));
const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

test('incidents：crossed/escalated 记录 worker/itemId/dispatchId；at 可回填；relay_status 读取', async () => {
  const cwd = tempCwd();
  try {
    const first = recordIncident(cwd, {
      event: 'crossed', leadSessionId: LEAD, sessionId: 'session-w1', worker: 'probe',
      itemId: 'p2-task', dispatchId: 'd-p2-x', phase: 'build', band: 'organize',
      ratio: 0.353, used: 353000, window: 1000000, subagent: true,
      at: '2026-11-21T11:25:00.535Z', reason: 'backfill',
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = recordIncident(cwd, {
      event: 'escalated', leadSessionId: LEAD, sessionId: 'session-w1', worker: 'probe',
      itemId: 'p2-task', dispatchId: 'd-p2-x', band: 'relay', ratio: 0.451,
      at: '2026-11-21T11:29:25.391Z',
    });
    assert.equal(second.ok, true);
    const entries = readIncidentEntries(cwd, LEAD);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].at, '2026-11-21T11:25:00.535Z', 'at 按给定时间回填（不伪造成写盘时间）');
    assert.equal(entries[0].worker, 'probe');
    assert.equal(entries[0].itemId, 'p2-task');
    assert.equal(entries[0].dispatchId, 'd-p2-x');
    assert.equal(entries[1].event, 'escalated');
    const report = readIncidents(cwd, LEAD, { limit: 5 });
    assert.equal(report.count, 2);
    assert.equal(report.recent.at(-1).band, 'relay');
    const raw = readFileSync(join(cwd, '.scratch', 'context-relay', 'team', LEAD, 'incidents.ndjson'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
  } finally { cleanup(cwd); }
});

test('incidents：collect 结算（settled 只一次，completed/finalBand/assessment 落盘）；无事故 skip', async () => {
  const cwd = tempCwd();
  try {
    assert.deepEqual(settleIncidents(cwd, LEAD, { dispatchId: 'd-none' }), { ok: true, skipped: 'no-incident' });
    recordIncident(cwd, {
      event: 'crossed', leadSessionId: LEAD, sessionId: 'session-w1', worker: 'probe',
      itemId: 'p2-task', dispatchId: 'd-p2-x', phase: 'build', band: 'organize', ratio: 0.353, subagent: true,
    });
    const assessment = { needPriorContext: true, canFinish: false, action: 'checkpoint-freshen', source: 'receipt' };
    const settled = settleIncidents(cwd, LEAD, {
      dispatchId: 'd-p2-x', sessionId: 'session-w1', itemId: 'p2-task', worker: 'probe',
      completed: true, assessment, reason: 'done',
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const entries = readIncidentEntries(cwd, LEAD);
    const last = entries.at(-1);
    assert.equal(last.event, 'settled');
    assert.equal(last.dispatchId, 'd-p2-x');
    assert.equal(last.itemId, 'p2-task');
    assert.equal(last.completed, true);
    assert.equal(last.finalBand, 'organize');
    assert.deepEqual(last.assessment, assessment);
    // 同 dispatch 不重复结算
    const again = settleIncidents(cwd, LEAD, { dispatchId: 'd-p2-x', completed: true });
    assert.equal(again.ok, true);
    assert.equal(again.skipped, 'already-settled');
    assert.equal(readIncidentEntries(cwd, LEAD).length, 2);
  } finally { cleanup(cwd); }
});

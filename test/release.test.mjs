import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseRetiredGenerations, releaseSettledChildren } from '../lib/agent/release.js';
import { writeRoster } from '../lib/agent/team.js';

function fakeServices({ rows = [], agents = {}, calls = [], failDrain = false, teammates = [] } = {}) {
  const subagents = {
    async listChildren() { return rows; },
    async drainChildren(parent, ids) {
      if (failDrain) throw new Error('drain failed');
      calls.push([parent.session.id, ids]);
    },
  };
  const services = { subagents, agents: { get: (id) => agents[id] }, agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [{ id: 'lead-1', role: 'lead' }, ...teammates.map((id) => ({ id, role: 'teammate' }))] } };
  return { get: (name) => services[name] };
}

test('releaseSettledChildren：one-shot idle / 已卸载 child 可释放；running / 活 continuable / 队友 / external 跳过', async () => {
  const calls = [];
  const ctx = fakeServices({
    rows: [
      { id: 'one-shot-idle', mode: 'one-shot' },
      { id: 'one-shot-busy', mode: 'one-shot' },
      { id: 'cont-idle-live', mode: 'continuable' },
      { id: 'cont-unloaded', mode: 'continuable' },
      { id: 'worker-1', mode: 'continuable' },
      { id: 'external-1', mode: 'external' },
      { id: 'lead-1', mode: 'one-shot' },
    ],
    agents: { 'one-shot-idle': { status: 'idle' }, 'one-shot-busy': { status: 'running' }, 'cont-idle-live': { status: 'idle' }, 'worker-1': { status: 'idle' } },
    calls,
    teammates: ['worker-1'],
  });
  const caller = { session: { id: 'lead-1' } };
  const released = await releaseSettledChildren(ctx, caller);
  assert.deepEqual([...released].sort(), ['cont-unloaded', 'one-shot-idle'].sort());
  assert.deepEqual(calls, [['lead-1', ['one-shot-idle', 'cont-unloaded']]]);
});

test('releaseSettledChildren：服务缺失 / 查询或释放失败都降级为空列表（不抛）', async () => {
  assert.deepEqual(await releaseSettledChildren({ get: () => undefined }, { session: { id: 'l' } }), []);
  const throwing = { get: (name) => (name === 'subagents' ? { async listChildren() { throw new Error('query down'); } } : undefined) };
  assert.deepEqual(await releaseSettledChildren(throwing, { session: { id: 'l' } }), []);
  const failing = fakeServices({ rows: [{ id: 'c1', mode: 'one-shot' }], failDrain: true });
  assert.deepEqual(await releaseSettledChildren(failing, { session: { id: 'l' } }), []);
});

test('releaseRetiredGenerations：只释放 retired 且带 sessionId 的旧代（可按 lineage 过滤）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-release-'));
  try {
    const roster = {
      lineages: {
        impl: {
          profile: { role: '', description: '', writeScopes: [], createdAt: '2026-11-01T00:00:00.000Z' },
          generations: [
            { gen: 1, name: 'impl-g1', sessionId: 'session-old-1', createdAt: '2026-11-01T00:00:00.000Z', retiredAt: '2026-11-08T00:00:00.000Z' },
            { gen: 2, name: 'impl-g2', sessionId: 'session-new-1', createdAt: '2026-11-08T00:00:00.000Z' },
            { gen: 3, name: 'impl-g3', createdAt: '2026-11-08T00:00:00.000Z' },
          ],
          activeGen: 2,
        },
        qa: {
          profile: { role: '', description: '', writeScopes: [], createdAt: '2026-11-01T00:00:00.000Z' },
          generations: [{ gen: 1, name: 'qa-g1', sessionId: 'session-old-qa', createdAt: '2026-11-01T00:00:00.000Z', retiredAt: '2026-11-08T00:00:00.000Z' }],
          activeGen: 1,
        },
      },
    };
    writeRoster(dir, roster, 'lead-1');
    const calls = [];
    const ctx = fakeServices({ calls });
    const caller = { session: { id: 'lead-1' } };
    const all = await releaseRetiredGenerations(ctx, caller, { cwd: dir });
    assert.deepEqual(all.sort(), ['session-old-1', 'session-old-qa'].sort());
    const onlyImpl = await releaseRetiredGenerations(ctx, caller, { cwd: dir, lineages: ['impl'] });
    assert.deepEqual(onlyImpl, ['session-old-1']);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

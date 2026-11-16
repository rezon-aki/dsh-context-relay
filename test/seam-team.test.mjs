import test from 'node:test';
import assert from 'node:assert/strict';
import { seamShape } from '../lib/seams.js';
import { capabilitiesOf } from '../lib/team-api.js';

// rc.2 官方形状（@deepseek-ai/dsh-subagent 0.2.2-rc.2 src/index.ts:252,300,312,368,392,427）：
//   subagents.rootOf(caller)/namesOf(agent) 判定成员身份；listDescendants(rootSessionId) 枚举；
//   sendMessage/interrupt/startActivation 提供能力；relay 经 capabilitiesOf(ctx) 读取能力清单。
function subagentsService(overrides = {}) {
  return {
    rootOf() { return {}; },
    namesOf() { return { self: 'lead' }; },
    listDescendants() { return Promise.resolve([]); },
    sendMessage() { return Promise.resolve('message-1'); },
    interrupt() {},
    startActivation() { return Promise.resolve({}); },
    ...overrides,
  };
}

const ctxWith = (service) => ({ get: (name) => (name === 'subagents' ? service : undefined) });

test('seam: rc.2 subagents 树 capabilitiesOf 输出形状通过', () => {
  assert.deepEqual(seamShape('team', capabilitiesOf(ctxWith(subagentsService()))), { ok: true, missing: [] });
});

test('seam: rc.1 风格旧服务（capabilitiesOf → kind none）→ degraded 且不抛错', () => {
  const verdict = seamShape('team', capabilitiesOf(ctxWith({ listChildren() {}, spawn() {}, interrupt() {} })));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.missing.includes('kind=subagents'));
  assert.ok(verdict.missing.includes('capability.listMembers'));
});

test('seam: 无 subagents 服务/原始值 → degraded 且不抛错', () => {
  assert.deepEqual(seamShape('team', capabilitiesOf(ctxWith(undefined))), {
    ok: false,
    missing: ['kind=subagents', 'capability.role', 'capability.listMembers', 'capability.send', 'capability.spawn'],
  });
  assert.deepEqual(seamShape('team', null).missing, ['capabilities kind']);
});

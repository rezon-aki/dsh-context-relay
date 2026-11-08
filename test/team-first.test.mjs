import test from 'node:test';
import assert from 'node:assert/strict';
import { teamFirstSubagentGate } from '../lib/agent/panel-gate.js';

const lead = { session: { id: 'session-lead' }, header: { cwd: '/tmp' } };
const worker = { session: { id: 'session-w1' }, header: { origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 } };

function ctxWith(teams) {
  return { get: (name) => (name === 'agentTeams' ? teams : undefined) };
}
function teamService({ teammates = ['w1'], leadMembership = { role: 'lead', name: 'lead' } } = {}) {
  return {
    tryMembership: (agent) => (agent === lead ? leadMembership : agent === worker ? { role: 'teammate', name: 'w1' } : undefined),
    listMembers: () => [{ id: 'session-lead', name: 'lead', role: 'lead' }, ...teammates.map((name) => ({ id: 'session-' + name, name, role: 'teammate' }))],
  };
}

test('团队优先：有团队时 Lead 调用 subagent → 返回审批 ask 门', () => {
  const gate = teamFirstSubagentGate(ctxWith(teamService()), { name: 'subagent', agent: lead });
  assert.equal(gate?.tag, 'team-first-subagent');
  assert.match(String(gate.reason), /team/i);
  assert.match(String(gate.displayReason.zh), /团队/);
});

test('团队优先：无团队 / 非 subagent / 队友 / 配置 off / 服务缺失 均放行（undefined）', () => {
  assert.equal(teamFirstSubagentGate(ctxWith(teamService({ teammates: [] })), { name: 'subagent', agent: lead }), undefined, '无队友放行');
  assert.equal(teamFirstSubagentGate(ctxWith(teamService()), { name: 'bash', agent: lead }), undefined, '非 subagent 放行');
  assert.equal(teamFirstSubagentGate(ctxWith(teamService()), { name: 'subagent', agent: worker }), undefined, '队友调用 subagent 不拦');
  assert.equal(teamFirstSubagentGate(ctxWith(teamService()), { name: 'subagent', agent: lead }, { teamFirstSubagents: 'off' }), undefined, '配置 off 放行');
  assert.equal(teamFirstSubagentGate(ctxWith(undefined), { name: 'subagent', agent: lead }), undefined, 'teams 服务缺失放行');
  assert.equal(teamFirstSubagentGate(ctxWith(teamService({ leadMembership: { role: 'teammate', name: 'x' } })), { name: 'subagent', agent: lead }), undefined, '非 Lead 放行');
});

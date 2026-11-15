/**
 * 团队适配层（rc.2 subagents 树）的能力探测与语义映射。
 * 不触网、不碰真实 DSH：全部 fake 服务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_NONE, TEAM_SUBAGENTS, capabilitiesOf, drainChildren, interruptMember, listChildren,
  listMembers, listMembersSync, roleOf, roleOfDetailed, sendToMember, startMember, teamKindOf,
} from '../lib/team-api.js';
import { PTC_BASE_PLUGINS } from '../lib/preset-base.js';

const agent = (id) => ({ id, session: { id } });

function ctxOf(services) {
  return { get: (name) => services[name] };
}

function subagentsOf({ root = agent('session-lead'), descendants = [], send, interrupt, start, providers = ['spawn'] } = {}) {
  return {
    rootOf: () => root,
    namesOf: (caller) => ({ self: caller.session.id === root.session.id ? 'lead' : caller.session.id === 'session-w1' ? 'w1' : caller.session.id }),
    listDescendants: async () => descendants,
    resolveName: async (_caller, name) => {
      if (name === 'w1') return 'session-w1';
      if (name === 'lead') return root.session.id;
      throw new Error('not found: ' + name);
    },
    sendMessage: send,
    interrupt,
    startActivation: start,
    getProvider: (name) => (providers.includes(name) ? { name } : undefined),
  };
}

const row = (id, parentId, extra = {}) => ({ id, parentId, depth: 1, kind: 'child', activity: 'inactive', mode: 'continuable', label: id, path: id, ...extra });

test('能力探测：subagents / none', () => {
  assert.equal(teamKindOf(ctxOf({ subagents: { rootOf() {}, namesOf() {} } })), TEAM_SUBAGENTS);
  assert.equal(teamKindOf(ctxOf({})), TEAM_NONE);
  assert.equal(capabilitiesOf(ctxOf({})).spawn, false);
  const caps = capabilitiesOf(ctxOf({ subagents: subagentsOf({ start: async () => ({}) }) }));
  assert.equal(caps.kind, TEAM_SUBAGENTS);
  assert.equal(caps.syncMembers, false);
  assert.equal(caps.spawn, true);
});

test('roleOf：根=lead、子=teammate；ctx.get 抛错=unavailable', () => {
  const lead = agent('session-lead');
  const subs = ctxOf({ subagents: subagentsOf() });
  assert.equal(roleOf(subs, lead).role, 'lead');
  assert.equal(roleOf(subs, lead).name, 'lead');
  assert.equal(roleOf(subs, agent('session-w1')).role, 'teammate');
  assert.equal(roleOf(subs, agent('session-w1')).name, 'w1');

  const broken = { get: () => { throw new Error('service boom'); } };
  const detail = roleOfDetailed(broken, lead);
  assert.equal(detail.ok, false);
  assert.equal(detail.code, 'unavailable');
  assert.equal(roleOf(broken, lead), undefined);
});

test('listMembers：把 listDescendants 映射为 teammate；diagnostic 不进成员', async () => {
  const subs = ctxOf({ subagents: subagentsOf({
    descendants: [row('session-w1', 'session-lead'), row('session-deep', 'session-w1', { depth: 2, activity: 'running', path: 'w1/deep' }), { kind: 'diagnostic', id: 'session-bad', reason: 'corrupt' }],
  }) });
  const listed = await listMembers(subs, agent('session-lead'));
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.members.map((member) => [member.id, member.name, member.status]), [
    ['session-w1', 'session-w1', 'inactive'],
  ]);
  assert.equal(listed.deeper, 1, '孙代理只计入 deeper，不算 Lead 队友');
  assert.deepEqual(listed.diagnostics, [{ id: 'session-bad', reason: 'corrupt' }]);
  assert.equal(listMembersSync(subs, agent('session-lead')).code, 'async-only');
});

test('listMembers：服务不可用返回明确原因，不抛', async () => {
  const broken = ctxOf({ subagents: { rootOf() { return agent('session-lead'); }, namesOf() { return { self: 'lead' }; }, listDescendants: async () => { throw new Error('query down'); } } });
  const listed = await listMembers(broken, agent('session-lead'));
  assert.equal(listed.ok, false);
  assert.match(listed.reason, /query down/);
  const none = await listMembers(ctxOf({}), agent('session-lead'));
  assert.equal(none.code, 'no-service');
});

test('sendToMember：名字解析成 SessionId 后发送', async () => {
  const calls = [];
  const subs = ctxOf({ subagents: subagentsOf({ send: async (sender, targetId, content, options) => { calls.push({ sender: sender.id, targetId, text: content[0].text, signal: options.signal }); return 'message-1'; } }) });
  const sent = await sendToMember(subs, agent('session-lead'), 'w1', 'hello');
  assert.equal(sent.ok, true);
  assert.equal(sent.messageId, 'message-1');
  assert.equal(calls[0].targetId, 'session-w1');
});

test('interruptMember：authority 是 {kind:"ancestor",agent}；失败返回原因', async () => {
  const calls = [];
  const subs = ctxOf({ subagents: subagentsOf({ interrupt: (id, authority) => { calls.push({ id, authority }); } }) });
  const result = await interruptMember(subs, agent('session-lead'), { id: 'session-w1', name: 'w1' });
  assert.equal(result.ok, true);
  assert.equal(calls[0].id, 'session-w1');
  assert.equal(calls[0].authority.kind, 'ancestor');
  assert.equal(calls[0].authority.agent.session.id, 'session-lead');

  const failing = ctxOf({ subagents: subagentsOf({ interrupt: () => { throw new Error('UNAUTHORIZED'); } }) });
  const failed = await interruptMember(failing, agent('session-lead'), { id: 'session-w1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'interrupt-failed');
});

test('startMember：spawn-in-process + delivery=parent；limit 错误映射 member-limit', async () => {
  const specs = [];
  const subs = ctxOf({ subagents: subagentsOf({ providers: ['spawn', 'spawn-in-process'], start: async (spec) => { specs.push(spec); return { childId: 'session-g2', name: 'w1-g2' }; } }) });
  const started = await startMember(subs, agent('session-lead'), { name: 'w1-g2', description: 'gen2', prompt: 'go', signal: new AbortController().signal });
  assert.equal(started.ok, true);
  assert.equal(started.member.id, 'session-g2');
  assert.equal(specs[0].provider, 'spawn-in-process');
  assert.equal(specs[0].delivery, 'parent');
  assert.equal(specs[0].name, 'w1-g2');
  assert.equal(specs[0].prompt[0].text, 'go');

  // 调用方传未注册的 provider → 退回可用 provider。
  const specs2 = [];
  const renamed = ctxOf({ subagents: subagentsOf({ providers: ['spawn-in-process'], start: async (spec) => { specs2.push(spec); return { childId: 'session-g3', name: 'w1-g3' }; } }) });
  const started2 = await startMember(renamed, agent('session-lead'), { name: 'w1-g3', description: 'gen3', prompt: 'go', provider: 'unknown-provider' });
  assert.equal(started2.ok, true);
  assert.equal(specs2[0].provider, 'spawn-in-process');

  const limited = ctxOf({ subagents: subagentsOf({ start: async () => { throw new Error('maxActiveSubagents limit reached'); } }) });
  const failed = await startMember(limited, agent('session-lead'), { name: 'w1-g4', description: '', prompt: 'go' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'member-limit');
});

test('startMember：透传 agentOptions（架构师模型）', async () => {
  const specs = [];
  const subs = ctxOf({ subagents: subagentsOf({ start: async (spec) => { specs.push(spec); return { childId: 'session-arch', name: 'architect' }; } }) });
  const started = await startMember(subs, agent('session-lead'), {
    name: 'architect',
    description: '专职架构师',
    prompt: 'go',
    agentOptions: { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' },
  });
  assert.equal(started.ok, true);
  assert.deepEqual(specs[0].agentOptions, { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' });
});

test('listChildren/drainChildren：列直接子级；逐 id 释放明确 unsupported', async () => {
  const subs = ctxOf({ subagents: subagentsOf({
    descendants: [row('session-w1', 'session-lead'), row('session-deep', 'session-w1', { depth: 2 }), { kind: 'diagnostic', id: 'session-bad', reason: 'corrupt' }],
  }) });
  const listed = await listChildren(subs, 'session-lead');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.rows.map((entry) => entry.id), ['session-w1']);
  const drained = await drainChildren(subs, agent('session-lead'), ['session-w1']);
  assert.equal(drained.ok, false);
  assert.equal(drained.code, 'unsupported');
});

test('preset base：只保留 rc.2 行数据', () => {
  const ids = PTC_BASE_PLUGINS.map((entry) => entry.id);
  assert.ok(ids.includes('tool-executor-ptc'));
  assert.ok(ids.includes('tool-office'));
  assert.ok(!ids.includes('tool-subagent-list-agents'));
});

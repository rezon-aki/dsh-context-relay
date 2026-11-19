/**
 * 声明式 agent 平面 · 角色表契约（v0.10 C2）：
 * ROLES 四角色单一真源（deny/sections/tools/seed）、协议文本从 protocol.js/worker.js 导入不复制、
 * roleOfAgent 纯函数判定（root/depth1 teammate/架构师认领/depth≥2 worker，fork 血缘不算子代理）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, LEAD_ONLY_TOOLS as LEGACY_LEAD_ONLY, SUBAGENT_ONLY_HIDDEN_TOOLS as LEGACY_SUBAGENT_HIDDEN } from '../lib/agent.js';
import {
  LEAD_ONLY_TOOLS,
  PROTOCOL_SECTION_NAME,
  ROLES,
  SUBAGENT_ASK_USER_DENY,
  SUBAGENT_ONLY_HIDDEN_TOOLS,
  TEAMMATE_DOC_DENY,
  WORKER_RELAY_DENY,
  delegationDepthOf,
  roleOfAgent,
} from '../lib/plane/roles.js';
import {
  ARCHITECT_WORKER_PROTOCOL_TEXT,
  ROUTER_DENY_TOOLS,
  ROUTER_PROTOCOL_TEXT,
  TEAMMATE_PROTOCOL_TEXT,
  TEAM_LEAD_PROTOCOL_TEXT,
} from '../lib/agent/protocol.js';
import { WORKER_PROTOCOL_TEXT } from '../lib/agent/worker.js';

const sessionAgent = (header, extra = {}) => ({ session: { header, ...extra } });

test('ROLES 覆盖四角色：deny/sections/tools/skills/seed 形状齐全，工具组名 → agent.js 可解析', () => {
  assert.deepEqual(Object.keys(ROLES).sort(), ['architect', 'lead', 'teammate', 'worker']);
  const knownGroups = new Set(['lead', 'delegation', 'teammate', 'checkpoint']);
  for (const [role, table] of Object.entries(ROLES)) {
    assert.ok(Array.isArray(table.deny), role + ' deny 是数组');
    assert.ok(Array.isArray(table.sections), role + ' sections 是数组');
    assert.ok(Array.isArray(table.tools), role + ' tools 是数组');
    assert.ok(Array.isArray(table.skills), role + ' skills 是数组');
    for (const group of table.deny) {
      assert.equal(typeof group.label, 'string', role + ' deny.label');
      assert.ok(Array.isArray(group.names) && group.names.length > 0, role + ' deny.names 非空');
    }
    for (const section of table.sections) {
      assert.equal(typeof section.name, 'string');
      assert.equal(typeof section.order, 'number');
      assert.equal(typeof section.text, 'string');
      assert.ok(section.text.length > 0, role + ' section 文本非空');
    }
    for (const group of table.tools) assert.ok(knownGroups.has(group.group), role + ' 工具组 ' + group.group + ' 必须由 agent.js 提供');
  }
  assert.equal(ROLES.lead.seed, true, 'root Lead 需要默认档种子');
  for (const role of ['teammate', 'architect', 'worker']) assert.equal(ROLES[role].seed, false, role + ' 不种默认档');
  // w5 角色技能：human-loop 只给 Lead（skills 无 deny，全局注册会对子智能体也可见）。
  assert.deepEqual([...ROLES.lead.skills], ['human-loop']);
  for (const role of ['teammate', 'architect', 'worker']) assert.deepEqual([...ROLES[role].skills], [], role + ' 不装配 human-loop');
});

test('协议文本单一真源：roles 段直接引用 protocol.js / worker.js（不复制文本）', () => {
  const byName = (role, name) => ROLES[role].sections.find((section) => section.name === name);
  assert.equal(byName('lead', 'context-relay:router').text, ROUTER_PROTOCOL_TEXT);
  assert.equal(byName('lead', 'context-relay:router').order, 10152);
  assert.equal(byName('lead', 'context-relay:team-lead').text, TEAM_LEAD_PROTOCOL_TEXT);
  assert.equal(byName('lead', 'context-relay:team-lead').order, 10153);
  for (const [role, text] of [['teammate', TEAMMATE_PROTOCOL_TEXT], ['architect', ARCHITECT_WORKER_PROTOCOL_TEXT], ['worker', WORKER_PROTOCOL_TEXT]]) {
    const section = ROLES[role].sections.find((entry) => entry.name === PROTOCOL_SECTION_NAME);
    assert.ok(section !== undefined, role + ' 用同名协议段覆盖 preset');
    assert.equal(section.text, text, role + ' 协议文本必须与导入源一致');
    assert.equal(section.order, 10150, role + ' order 沿用 preset 段顺序');
  }
});

test('deny 清单：root 只裁执行类；队友裁 lead-only + doc + ask_user；架构师裁 lead-only + phase + ask_user；worker 再裁 status/doc', () => {
  assert.deepEqual(ROLES.lead.deny.map((group) => group.names), [ROUTER_DENY_TOOLS]);
  assert.deepEqual([...LEAD_ONLY_TOOLS], ['relay_organize', 'relay_handoff', 'relay_recommend', 'relay_work_items']);
  assert.deepEqual([...SUBAGENT_ONLY_HIDDEN_TOOLS], ['relay_phase']);
  assert.deepEqual([...SUBAGENT_ASK_USER_DENY], ['ask_user_question']);
  assert.deepEqual([...TEAMMATE_DOC_DENY], ['relay_doc']);
  assert.deepEqual([...WORKER_RELAY_DENY], ['relay_status', 'relay_doc']);
  assert.deepEqual(ROLES.teammate.deny.map((group) => group.names), [LEAD_ONLY_TOOLS, TEAMMATE_DOC_DENY, SUBAGENT_ASK_USER_DENY]);
  assert.deepEqual(ROLES.architect.deny.map((group) => group.names), [LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS, SUBAGENT_ASK_USER_DENY]);
  assert.deepEqual(ROLES.worker.deny.map((group) => group.names), [LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS, WORKER_RELAY_DENY, SUBAGENT_ASK_USER_DENY]);
  // 不变量：ask_user 不在 Lead 的 deny 里；所有非 Lead 角色都裁掉它。
  assert.ok(!ROLES.lead.deny.some((group) => group.names.includes('ask_user_question')));
  for (const role of ['teammate', 'architect', 'worker']) {
    assert.ok(ROLES[role].deny.some((group) => group.names.includes('ask_user_question')), role + ' 必须裁掉 ask_user_question');
  }
  // 旧导出名从 agent.js 继续可用（router.test 等消费），且与单一真源同值。
  assert.deepEqual([...LEGACY_LEAD_ONLY], [...LEAD_ONLY_TOOLS]);
  assert.deepEqual([...LEGACY_SUBAGENT_HIDDEN], [...SUBAGENT_ONLY_HIDDEN_TOOLS]);
});

test('roleOfAgent：root=lead（fork 血缘不算子代理）；depth1=teammate；depth≥2=worker', () => {
  assert.equal(roleOfAgent(sessionAgent({})), 'lead');
  assert.equal(roleOfAgent(sessionAgent({ parentSession: 'session-parent' })), 'lead', '普通 fork 根会话是 lead');
  assert.equal(roleOfAgent(undefined), 'lead', '缺 agent/session 按 root 兜底');
  assert.equal(roleOfAgent({}), 'lead');
  assert.equal(roleOfAgent(sessionAgent({ origin: 'subagent' })), 'teammate', 'origin=subagent 无 depth → depth1');
  assert.equal(roleOfAgent(sessionAgent({ delegationDepth: 1 })), 'teammate');
  assert.equal(roleOfAgent(sessionAgent({ origin: 'subagent', delegationDepth: 1 })), 'teammate');
  assert.equal(roleOfAgent(sessionAgent({ origin: 'subagent', delegationDepth: 2 })), 'worker');
  assert.equal(roleOfAgent(sessionAgent({ origin: 'subagent', delegationDepth: 5 })), 'worker');
  assert.equal(roleOfAgent(sessionAgent({ origin: 'subagent', delegationDepth: 0 })), 'teammate', 'depth=0 但 origin=subagent → 按 depth1 处理');
});

test('roleOfAgent：架构师按注入的 isArchitect 认领（pending/roster 由 agent.js 提供），异常降级 teammate', () => {
  const architect = sessionAgent({ origin: 'subagent', parentSession: 'lead', delegationDepth: 1 });
  assert.equal(roleOfAgent(architect, { isArchitect: () => true }), 'architect');
  assert.equal(roleOfAgent(architect, { isArchitect: () => false }), 'teammate');
  assert.equal(roleOfAgent(architect, { isArchitect: () => { throw new Error('roster boom'); } }), 'teammate', '认领异常按 teammate 降级');
  assert.equal(roleOfAgent(architect, { isArchitect: 'yes' }), 'teammate', '非函数注入忽略');
  // 深度不是 1 时不消耗架构师判定（只在直接队友上认领）。
  let asked = 0;
  const worker = sessionAgent({ origin: 'subagent', delegationDepth: 2 });
  assert.equal(roleOfAgent(worker, { isArchitect: () => { asked += 1; return true; } }), 'worker');
  assert.equal(asked, 0, 'worker 不查询架构师认领');
  assert.equal(roleOfAgent(sessionAgent({}), { isArchitect: () => true }), 'lead', 'root 不查询架构师认领');
});

test('roleOfAgent 纯函数：不修改入参、可反复调用（同一事实同一结果）', () => {
  const agent = sessionAgent({ origin: 'subagent', delegationDepth: 1, parentSession: 'lead' }, { id: 'session-x' });
  const before = JSON.stringify(agent);
  const first = roleOfAgent(agent, { isArchitect: () => false });
  const second = roleOfAgent(agent, { isArchitect: () => false });
  assert.equal(first, 'teammate');
  assert.equal(second, first);
  assert.equal(JSON.stringify(agent), before, 'roleOfAgent 不得改动 agent/session');
  assert.equal(delegationDepthOf(agent), 1);
  assert.equal(delegationDepthOf(sessionAgent({})), 0);
  assert.equal(delegationDepthOf(sessionAgent({ origin: 'subagent', delegationDepth: 3 })), 3);
});

test('表驱动装配仍等价旧行为：apply+agent/created 的 root/队友 deny 与协议段来自 ROLES', async () => {
  // 用最小 fake ctx 走公开入口，断言实际装配与表一致（防表与 agent.js 脱钩）。
  const events = [];
  const sections = [];
  const ctx = {
    effect(fn) { const out = fn(); return typeof out === 'function' ? out : () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; } },
    tools: { register() { return () => {}; } },
    get() { return undefined; },
  };
  apply(ctx, {});
  const created = events.find((entry) => entry.name === 'agent/created');
  assert.ok(created !== undefined, 'agent/created 监听存在');
  const calls = [];
  const agentSections = [];
  const agentSkills = [];
  const agent = {
    session: { header: {} },
    ctx: {
      inject(services, callback) {
        if (services[0] === 'tools') { callback({ tools: { restrict(filter) { calls.push(filter.deny[0]); return () => {}; }, register() { return () => {}; } } }); return { dispose() {} }; }
        if (services[0] === 'skills') { callback({ skills: { register(definition) { agentSkills.push(definition.name); return () => {}; } } }); return { dispose() {} }; }
        callback({ systemPrompt: { section(definition) { agentSections.push(definition); return () => {}; } } });
        return { dispose() {} };
      },
    },
  };
  await created.listener({ agent });
  assert.deepEqual(calls, [...ROLES.lead.deny[0].names], 'root deny 来自角色表');
  assert.deepEqual(agentSkills, ['human-loop'], 'Lead 在 agent scope 装配 human-loop（来自角色表 skills）');
  assert.ok(!calls.includes('ask_user_question'), 'Lead 保留提问工具');
  assert.deepEqual(agentSections.map((section) => section.name), ROLES.lead.sections.map((section) => section.name));
  assert.deepEqual(agentSections.map((section) => section.text), ROLES.lead.sections.map((section) => section.text));
});

/**
 * P0-A1/A2 actor lint（真源：architecture/relay-systemic-audit.md §7.2-1）。
 *
 * 探针不是读常量自证：走 lib/agent.js 的 apply + agent/created 真实装配，取各角色
 * 实际注入的 section 文本与工具面；再断言文本中出现的工具名属于该角色工具面，
 * 跨角色工具（Lead 没有 checkpoint/freshen）必须在同一行注明「发消息让队友自己执行」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/agent.js';
import { markPendingArchitect } from '../lib/agent/shared.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { ARCHITECT_TOOL_NAMES, LEAD_TOOL_NAMES, TEAMMATE_TOOL_NAMES, WORKER_TOOL_NAMES } from './tool-surface.mjs';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { emptyRoster, ensureLineage, writeRoster } from '../lib/agent/team.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { subagentsFromLegacy } from './team-fixture.mjs';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const TOOL_RE = /\b(?:relay_[a-z][a-z0-9_]*|doc_lint)\b/g;
/** 跨角色执行限定：同一行出现这些词才算「让队友自己执行」，不是 Lead 直接调。 */
const DELEGATE_RE = /发消息|让队友|队友自己|它自己|你自己|由你自己|收到.*自己|Lead 用/;

/** 进程级共享状态复位（与 budget-snapshot.test.mjs 同口径）。 */
function resetSharedState() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-actor-contract-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  globalThis[SETTINGS_KEY] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true };
}

/** 极简 fake ctx：只实现 apply 用到的接口，捕获 preset 层工具注册 / section / 事件监听。 */
function fakeCtx() {
  const tools = new Map();
  const sections = [];
  const events = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on(name, listener) {
      events.push({ name, listener });
      return () => {};
    },
    logger: { info() {}, warn() {} },
    systemPrompt: {
      section(definition) { sections.push(definition); return () => {}; },
      context() { return () => {}; },
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get() { return undefined; },
  };
  return { ctx, tools, sections, events };
}

/** fake agent 自己的作用域：捕获 restrict 名单 / 注册的工具定义 / 影子 section。 */
function agentScope({ id, header }) {
  const registered = new Map();
  const restricted = [];
  const sections = [];
  const skills = [];
  const agent = {
    session: { id, header, seq: 0 },
    ctx: {
      inject(services, callback) {
        if (services.length === 1 && services[0] === 'tools') {
          callback({
            tools: {
              restrict(payload) { for (const name of payload?.deny ?? []) restricted.push(name); return () => {}; },
              register(definition) { registered.set(definition.name, definition); return () => {}; },
            },
          });
          return { dispose() {} };
        }
        if (services.length === 1 && services[0] === 'systemPrompt') {
          callback({ systemPrompt: { section(definition) { sections.push(definition); return () => {}; } } });
          return { dispose() {} };
        }
        if (services.length === 1 && services[0] === 'skills') {
          callback({ skills: { register(definition) { skills.push(definition.name); return () => {}; } } });
          return { dispose() {} };
        }
        throw new Error('unexpected agent-scope inject: ' + JSON.stringify(services));
      },
    },
    inject() {},
  };
  return { agent, registered, restricted, sections, skills };
}

/** 真实装配：apply → agent/created（lead/teammate/architect/worker）→ 求值后的文本 + 工具面。 */
async function assemble() {
  resetSharedState();
  const preset = fakeCtx();
  apply(preset.ctx, {});
  const created = preset.events.find((event) => event.name === 'agent/created');
  assert.ok(created, 'agent/created 装配入口必须存在');
  const specs = {
    lead: { id: 'session-actor-contract-lead', header: {} },
    teammate: { id: 'session-actor-contract-teammate', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'session-actor-contract-lead' } },
    architect: { id: 'session-actor-contract-architect', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'session-actor-contract-architect-parent' } },
    worker: { id: 'session-actor-contract-worker', header: { origin: 'subagent', delegationDepth: 2, parentSession: 'session-actor-contract-teammate' } },
  };
  markPendingArchitect(specs.architect.header.parentSession);
  const out = {};
  for (const [role, spec] of Object.entries(specs)) {
    const scope = agentScope(spec);
    await created.listener({ agent: scope.agent });
    const shadow = new Map(scope.sections.map((definition) => [definition.name, definition]));
    const resolve = (definition) => String(typeof definition.text === 'function' ? definition.text({ agent: scope.agent }) : definition.text ?? '');
    const presetNames = new Set(preset.sections.map((definition) => definition.name));
    const text = [
      ...preset.sections.map((definition) => resolve(shadow.get(definition.name) ?? definition)),
      ...scope.sections.filter((definition) => !presetNames.has(definition.name)).map(resolve),
    ].join('\n');
    const tools = [...preset.tools.keys()].filter((name) => !scope.restricted.includes(name));
    for (const name of scope.registered.keys()) if (!tools.includes(name)) tools.push(name);
    out[role] = { text, tools };
  }
  return out;
}

/** 找出「文本提到但该角色工具面没有、且同行没有跨角色限定」的行。 */
function actorViolations(text, toolNames) {
  const offenders = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(TOOL_RE)) {
      const name = match[0];
      if (toolNames.includes(name)) continue;
      if (DELEGATE_RE.test(line)) continue;
      offenders.push({ name, line: line.trim().slice(0, 140) });
    }
  }
  return offenders;
}

test('A2 前置：角色工具面 registry 与 apply 装配实测一致（Lead 13）', async () => {
  const roles = await assemble();
  assert.deepEqual(roles.lead.tools, [...LEAD_TOOL_NAMES]);
  assert.deepEqual(roles.teammate.tools, [...TEAMMATE_TOOL_NAMES]);
  assert.deepEqual(roles.architect.tools, [...ARCHITECT_TOOL_NAMES]);
  assert.deepEqual(roles.worker.tools, [...WORKER_TOOL_NAMES]);
  assert.equal(LEAD_TOOL_NAMES.length, 13);
  assert.ok(!LEAD_TOOL_NAMES.includes('relay_checkpoint'), 'Lead 工具面不得含 relay_checkpoint');
  assert.ok(!LEAD_TOOL_NAMES.includes('relay_freshen'), 'Lead 工具面不得含 relay_freshen');
});

test('A2 actor lint：Lead 文本不得直接调 checkpoint/freshen，跨角色工具须注明发消息让队友自己执行', async () => {
  const { lead } = await assemble();
  const offenders = actorViolations(lead.text, LEAD_TOOL_NAMES);
  assert.deepEqual(offenders, [], 'Lead 文本直接提到非本部工具且未注明由队友执行：' + JSON.stringify(offenders, null, 1));
  assert.match(lead.text, /Lead 面 13 个工具不含/, 'Lead 文本必须标注 checkpoint/freshen 的归属');
  const cross = lead.text.split('\n').filter((line) => /relay_checkpoint|relay_freshen/.test(line));
  assert.ok(cross.length >= 4, 'Lead 文本应保留 4 处换人/保鲜说明（实际 ' + cross.length + '）');
  for (const line of cross) assert.match(line, /发消息/, 'Lead 提 checkpoint/freshen 时必须写「发消息让队友」：' + line.trim().slice(0, 120));
});


const DESIGN_GATE = { path: '.scratch/context-relay/architecture/actor-tools.md', user_approved: true, ask_ref: '用户确认：按设计推进', not_doing: ['不发布 npm'] };
const CONTRACT_CHECK = { requirement: '需求已定：工具结果文本 actor 化', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };

/** 工具结果文本夹具：Lead + 一名到线队友，触发 relay_phase triage 与 relay_team_status 的 action 文案。 */
async function toolResultTexts() {
  resetSharedState();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-actor-tools-'));
  const session = { id: 'session-actor-tools-lead', header: { cwd }, seq: 0, snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) };
  const teams = {
    tryMembership: () => ({ role: 'lead', root: { session: { id: session.id } } }),
    listMembers: () => [{ id: 'session-actor-tools-m1', name: 'mate-1', role: 'teammate', status: 'inactive' }],
  };
  const sessionQuery = {
    async observeSession(memberId) {
      const projectedTokens = memberId === 'session-actor-tools-m1' ? 420000 : 20000;
      return { projections: { values: { contextPressure: { contextWindow: 1000000, projectedTokens } } }, [Symbol.dispose]() {} };
    },
  };
  const roster = emptyRoster();
  ensureLineage(roster, 'mate-1', { name: 'mate-1', sessionId: 'session-actor-tools-m1' });
  await writeRoster(cwd, roster, session.id);
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 20000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 20000 }) },
    agentTeams: teams,
    sessionQuery,
  };
  const preset = toolCtx(services);
  apply(preset.ctx, {});
  const agent = { session, options: {}, inject() {} };
  const phase = await preset.tools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent });
  const teamTools = createTeamTools({ ctx: preset.ctx, currentThresholds: () => thresholdsFromPercent(40), allowSpawn: false, squadMax: 8 });
  const statusTool = teamTools.leadTools.find((tool) => tool.name === 'relay_team_status');
  assert.ok(statusTool !== undefined, 'relay_team_status 已注册');
  const status = await statusTool.execute({}, { agent });
  return [
    { name: 'relay_phase', text: String(phase.text ?? '') },
    { name: 'relay_team_status', text: String(status.text ?? '') },
  ];
}

/** 与 fakeCtx 同构，但暴露 ctx.get 服务（工具执行需要投影/团队/台账）。 */
function toolCtx(services) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
  const tools = new Map();
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return normalized?.[name]; },
  };
  return { ctx, tools };
}

test('A2+ actor lint：工具结果文本也不得让 Lead 直接调队友工具（需注明发消息让队友自己执行）', async () => {
  const surfaces = await toolResultTexts();
  for (const surface of surfaces) {
    const offenders = actorViolations(surface.text, LEAD_TOOL_NAMES);
    assert.deepEqual(offenders, [], surface.name + ' 结果文本直接提到非本部工具且未注明由队友执行：' + JSON.stringify(offenders, null, 1));
    // 裸词「checkpoint / freshen / reset 复用」同样要写明由队友执行（不做工具名匹配就漏掉）。
    const actionLines = surface.text.split('\n').filter((line) => /checkpoint|freshen/.test(line));
    assert.ok(actionLines.length > 0, surface.name + ' 结果文本应含队友动作行（避免空样本自证）');
    for (const line of actionLines) {
      assert.match(line, /发消息|让队友|队友自己|它自己|你自己|由你自己/, surface.name + ' 动作行未写明由队友执行：' + line);
    }
  }
});

test('A2 actor lint：架构师只写 checkpoint；清空由 Lead 用 relay_architect fresh（不再要求自己 freshen）', async () => {
  const { architect } = await assemble();
  const offenders = actorViolations(architect.text, ARCHITECT_TOOL_NAMES);
  assert.deepEqual(offenders, [], '架构师文本直接提到非本部工具且未注明由 Lead 执行：' + JSON.stringify(offenders, null, 1));
  assert.doesNotMatch(architect.text, /由你自己执行|你会收到 relay_freshen|自己执行 freshen/, '架构师不得被要求自己 freshen/reset');
  const line = architect.text.split('\n').find((entry) => entry.includes('relay_architect'));
  assert.ok(line, '架构师收尾段必须说明真实清空路径');
  assert.match(line, /Lead 用 relay_architect/, '清空路径须写明 Lead 用 relay_architect');
  assert.match(line, /checkpoint/, '架构师只写 checkpoint');
});

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

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const TOOL_RE = /\b(?:relay_[a-z][a-z0-9_]*|doc_lint)\b/g;
/** 跨角色执行限定：同一行出现这些词才算「让队友自己执行」，不是 Lead 直接调。 */
const DELEGATE_RE = /发消息|让队友|队友自己|它自己|你自己|由你自己|收到.*自己/;

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

test('A2 actor lint：架构师文本不得出现 Lead 会发 relay_freshen，须注明自己执行', async () => {
  const { architect } = await assemble();
  const offenders = actorViolations(architect.text, ARCHITECT_TOOL_NAMES);
  assert.deepEqual(offenders, [], '架构师文本直接提到非本部工具且未注明由自己执行：' + JSON.stringify(offenders, null, 1));
  assert.doesNotMatch(architect.text, /Lead.*(发|调).*relay_freshen/, '架构师文本不得声称 Lead 会发/调 freshen');
  const line = architect.text.split('\n').find((entry) => entry.includes('relay_freshen'));
  assert.ok(line, '架构师收尾段必须说明 freshen 归属');
  assert.match(line, /你自己|自己执行/, '架构师段须写明由自己执行 freshen');
});

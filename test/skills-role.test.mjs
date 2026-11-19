/**
 * w5 · 角色注入裁剪——技能面（审计 §2.6.4 / Q8=C，dispatch d-w5-mwnn8hdo）。
 *
 * host 的 SkillRegistry.register 把技能落到「调用方 ctx 的 scope 层」：全局 ctx 注册 → global 层；
 * agent preset 的 standing mount ctx（agent.ctx）注册 → 该 agent 的 scope 层。读时合并 global +
 * 观看 scope 链，nearer 覆盖同名（dsh-skill/lib/index.js：register() 取 scopeOf(this.ctx)；类文档
 * "A read merges the global layer with the viewing scope's chain"）。skills 没有 tools.restrict
 * 那样的 deny/restrict，所以角色专属技能只能「不全局注册 + 按角色在 agent scope 注册」：
 *   - 全局：context-relay / doc-governance（非 relay 会话仍可用）；
 *   - 角色：human-loop（只有 relay Lead；子智能体不该向用户提问，skills 面也不该背用户门语义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply as applyHost } from '../lib/index.js';
import { apply as applyAgent } from '../lib/agent.js';
import { markPendingArchitect } from '../lib/agent/shared.js';
import { GLOBAL_SKILL_NAMES, skillDefinitionOf } from '../lib/skills.js';
import { ROLES } from '../lib/plane/roles.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';

/**
 * 分层技能注册表（按 host 文档语义的最小 fake）：scope 注册只进该 scope 层；
 * namesOf(scope) = global + 该 scope 层，同名 nearer 覆盖（本测试里名字不重复）。
 */
function layeredSkills() {
  const global = new Map();
  const layers = new Map();
  const layerOf = (scopeId) => {
    if (!layers.has(scopeId)) layers.set(scopeId, new Map());
    return layers.get(scopeId);
  };
  const service = (scopeId) => ({
    register(definition) {
      const layer = scopeId === undefined ? global : layerOf(scopeId);
      layer.set(definition.name, definition);
      return () => { layer.delete(definition.name); };
    },
  });
  const namesOf = (scopeId) => {
    const merged = new Map(global);
    if (scopeId !== undefined) for (const [name, definition] of layerOf(scopeId)) merged.set(name, definition);
    return [...merged.keys()].sort();
  };
  return { host: service(undefined), forScope: (id) => service(id), namesOf };
}

function resetSharedState() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-skills-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.handoffs')];
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
}

/** 最小 host ctx（index.js apply 需要 preset 注册 + projections/webServer 注入）+ 分层技能服务。 */
function fakeHost(registry) {
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    skills: registry.host,
    agentPresets: { register: async () => () => {} },
    get(name) { return name === 'sessionProjections' ? {} : undefined; },
    inject(wanted, callback) {
      if (wanted.includes('sessionProjections')) {
        callback({ effect: (fn) => { fn(); }, logger: { info() {}, warn() {} }, sessionProjections: { register: () => () => {} } });
      }
      if (wanted.includes('webServer')) {
        callback({ effect: (fn) => { fn(); }, get: () => undefined, webServer: { register: () => () => {} } });
      }
    },
  };
  return { ctx };
}

/** 最小 preset ctx（lib/agent.js apply）：只捕获 agent/created 与常量 section/工具注册。 */
function fakePresetCtx() {
  const events = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, listener) { events.push({ name, listener }); return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; } },
    tools: { register() { return () => {}; } },
    get() { return undefined; },
  };
  return { ctx, events };
}

/** 角色 agent：ctx.inject 分别给 tools / systemPrompt / skills（skills 服务按 agent scope 落层）。 */
function scopedAgent(registry, id, header) {
  return {
    session: { id, header, seq: 0 },
    ctx: {
      inject(services, callback) {
        if (services.length === 1 && services[0] === 'tools') {
          callback({ tools: { restrict: () => () => {}, register: () => () => {} } });
          return { dispose() {} };
        }
        if (services.length === 1 && services[0] === 'systemPrompt') {
          callback({ systemPrompt: { section: () => () => {} } });
          return { dispose() {} };
        }
        if (services.length === 1 && services[0] === 'skills') {
          callback({ skills: registry.forScope(id) });
          return { dispose() {} };
        }
        throw new Error('unexpected agent-scope inject: ' + JSON.stringify(services));
      },
    },
  };
}

test('w5 技能面：全局只注册 context-relay/doc-governance，human-loop 不全局', () => {
  resetSharedState();
  const registry = layeredSkills();
  const tmp = mkdtempSync(join(tmpdir(), 'relay-skills-host-'));
  applyHost(fakeHost(registry).ctx, { presetId: 'relay', settingsPath: join(tmp, 'settings.json'), panelPath: join(tmp, 'panel.json') });
  assert.deepEqual([...GLOBAL_SKILL_NAMES], ['context-relay', 'doc-governance']);
  assert.deepEqual(registry.namesOf(undefined), ['context-relay', 'doc-governance'], '非 relay 会话可见全局技能，不含 human-loop');
  // human-loop 定义可从随包 SKILL.md 读出（角色注册的数据源）。
  const humanLoop = skillDefinitionOf('human-loop');
  assert.equal(humanLoop?.name, 'human-loop');
  assert.equal(humanLoop?.invocation?.modelInvocable, true, 'human-loop 对模型可见（角色专属，不是用户手册）');
  assert.ok(humanLoop.description.length > 0 && humanLoop.content.length > 0, '定义带描述与正文');
  // context-relay 是用户手册（disable-model-invocation: true），即使全局也不进模型 catalog。
  assert.equal(skillDefinitionOf('context-relay')?.invocation?.modelInvocable, false);
});

test('w5 技能面：human-loop 只在 relay Lead 的 agent scope；teammate/architect/worker 不装配', async () => {
  resetSharedState();
  const registry = layeredSkills();
  const tmp = mkdtempSync(join(tmpdir(), 'relay-skills-host-'));
  applyHost(fakeHost(registry).ctx, { presetId: 'relay', settingsPath: join(tmp, 'settings.json'), panelPath: join(tmp, 'panel.json') });
  const preset = fakePresetCtx();
  applyAgent(preset.ctx, {});
  const created = preset.events.find((entry) => entry.name === 'agent/created');
  assert.ok(created !== undefined, 'agent/created 安装入口存在');

  markPendingArchitect('session-skills-lead');
  const lead = scopedAgent(registry, 'session-skills-lead', {});
  const teammate = scopedAgent(registry, 'session-skills-teammate', { origin: 'subagent', parentSession: 'session-skills-lead', delegationDepth: 1 });
  const architect = scopedAgent(registry, 'session-skills-architect', { origin: 'subagent', parentSession: 'session-skills-lead', delegationDepth: 1 });
  const worker = scopedAgent(registry, 'session-skills-worker', { origin: 'subagent', parentSession: 'session-skills-teammate', delegationDepth: 2 });
  for (const agent of [lead, teammate, architect, worker]) await created.listener({ agent });

  assert.deepEqual(registry.namesOf('session-skills-lead'), ['context-relay', 'doc-governance', 'human-loop'], 'Lead 三者都有（全局 + 角色）');
  for (const role of ['teammate', 'architect', 'worker']) {
    assert.deepEqual(registry.namesOf('session-skills-' + role), ['context-relay', 'doc-governance'], role + ' 技能面无 human-loop');
  }
  // 角色表单一真源：只 Lead 有角色技能；其余空。
  assert.deepEqual([...ROLES.lead.skills], ['human-loop']);
  for (const role of ['teammate', 'architect', 'worker']) assert.deepEqual([...ROLES[role].skills], []);
});

test('w5 host 契约：skills.register 落到调用方 ctx 的 scope 层（源码断言，缺官方安装时跳过）', () => {
  const source = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js';
  if (!existsSync(source)) return;
  const text = readFileSync(source, 'utf8');
  assert.match(text, /const scope = scopeOf\(this\.ctx\)/, 'register() 按调用方 ctx 取 scope');
  assert.match(text, /A read merges the global layer[\s*]+with the viewing scope/, '读时合并 global + 观看 scope 链');
  // 没有 deny/restrict 面：角色专属只能靠「不全局注册 + 按 scope 注册」。
  assert.equal(/skills\.(?:restrict|deny)\(/.test(text), false, 'skills 服务没有 restrict/deny API');
});

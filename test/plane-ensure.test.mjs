/**
 * 声明式 agent 平面 · 幂等 reconcile 契约（v0.10 C2，治 M-02）：
 * 重复安装幂等 / apply 时枚举 live agents 回填 / agent-preset/selected 事件回填 / agent/created 路径保留 /
 * 每步惰性兜底 / relay_status.plane 可见 / 反向切换卸载或降级可见。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/agent.js';
import { clearPlaneMemory, disposeAllPlanes, disposePlane, ensureAgentPlane, isPlaneTracked, planeStatusOf } from '../lib/plane/ensure.js';
import { LEAD_ONLY_TOOLS, ROLES, SUBAGENT_ASK_USER_DENY, SUBAGENT_ONLY_HIDDEN_TOOLS, TEAMMATE_DOC_DENY, WORKER_RELAY_DENY } from '../lib/plane/roles.js';
import { ARCHITECT_WORKER_PROTOCOL_TEXT, ROUTER_DENY_TOOLS, TEAMMATE_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';

/** 进程级共享状态重置（面板持久化指到临时文件，不读写真实 home）。 */
function resetShared() {
  clearPlaneMemory();
  clearPanelMemory();
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-plane-panel-')), 'panel.json') });
}

/** 极简 fake host ctx：记录 effect/事件/预设面注册，get(name) 返回测试服务。 */
function hostCtx(services = {}) {
  const events = [];
  const effects = [];
  const presetSections = [];
  const presetTools = new Map();
  const warns = [];
  const ctx = {
    effect(fn, label) {
      const out = fn();
      const dispose = typeof out === 'function' ? out : () => {};
      effects.push({ label, dispose });
      return dispose;
    },
    on(name, listener, options) { events.push({ name, listener, options }); return () => {}; },
    logger: { info() {}, warn(...args) { warns.push(args.join(' ')); } },
    systemPrompt: { section(definition) { presetSections.push(definition); return () => {}; } },
    tools: { register(definition) { presetTools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  const effect = (label) => effects.find((entry) => typeof entry.label === 'string' && entry.label.includes(label));
  const event = (name) => events.find((entry) => entry.name === name);
  return { ctx, events, effects, presetSections, presetTools, warns, effect, event };
}

/** 会话句柄（relay_status/panel 需要 id/header；压力读取走 fake 投影）。 */
function liveSession(id = 'session-plane', cwd = '/tmp') {
  return {
    id,
    header: { cwd },
    get seq() { return 0; },
    snapshotEvents() { return []; },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
  };
}

/**
 * 真实形状的 agent：ctx.inject 记录 restrict/register/section，返回带 dispose 的 fiber。
 * options.noDispose=true 时模拟不可逆 composition（inject 结果无 dispose）。
 */
function scopedAgent({ sessionId = 'session-plane', header = {}, noDispose = false, restrictThrows = new Set(), injectThrows = false, getService } = {}) {
  const state = { restricted: [], registered: [], sections: [], skills: [], disposed: [] };
  const fiber = (kind) => (noDispose ? {} : {
    dispose() { state.disposed.push(kind); },
  });
  const agent = {
    session: { ...liveSession(sessionId), header },
    ctx: {
      ...(typeof getService === 'function' ? { get: (name) => getService(name) } : {}),
      inject(services, callback) {
        if (injectThrows) throw new Error('service unavailable');
        if (services.length === 1 && services[0] === 'tools') {
          callback({
            tools: {
              restrict(filter) {
                const name = filter.deny?.[0];
                if (restrictThrows.has(name)) throw new Error('unknown global tool "' + name + '"');
                state.restricted.push(name);
                return () => {};
              },
              register(definition) { state.registered.push(definition.name); return () => {}; },
            },
          });
          return fiber('tools');
        }
        if (services.length === 1 && services[0] === 'systemPrompt') {
          callback({ systemPrompt: { section(definition) { state.sections.push(definition); return () => {}; } } });
          return fiber('systemPrompt');
        }
        if (services.length === 1 && services[0] === 'skills') {
          callback({ skills: { register(definition) { state.skills.push(definition.name); return () => {}; } } });
          return fiber('skills');
        }
        throw new Error('unexpected inject ' + JSON.stringify(services));
      },
    },
  };
  return { agent, state };
}

const planeOf = (agent) => planeStatusOf(agent);

/** 角色技能定义（fake）：名字即注册名；host skills 无 deny，按 scope 注册（w5）。 */
const testSkillOf = (name) => ({ name, description: '测试技能', content: '# 测试', invocation: { modelInvocable: true, userInvocable: true } });

test('ensureAgentPlane 幂等：重复调用只装一次（restrict/注册/section/seed 均不重复）', () => {
  resetShared();
  const { agent, state } = scopedAgent({ sessionId: 'session-plane-idem' });
  let seeds = 0;
  const runtime = { toolsOf: (group) => (group === 'lead' ? [{ name: 'relay_team_status' }] : []), skillOf: testSkillOf, seed: () => { seeds += 1; } };
  const first = ensureAgentPlane(agent, runtime);
  assert.equal(first.ok, true);
  assert.equal(first.role, 'lead');
  assert.equal(first.installed, true);
  assert.equal(seeds, 1, 'root seed 只执行一次');
  assert.deepEqual(state.skills, ['human-loop'], 'Lead 在 agent scope 装配 human-loop（全局不再注册）');
  const before = { restricted: state.restricted.length, registered: state.registered.length, sections: state.sections.length, skills: state.skills.length };
  const second = ensureAgentPlane(agent, runtime);
  assert.equal(second.idempotent, true, '第二次直接短路');
  assert.deepEqual([state.restricted.length, state.registered.length, state.sections.length, state.skills.length], [before.restricted, before.registered, before.sections, before.skills], '重复安装不得重复注入');
  assert.equal(seeds, 1, '重复安装不重复 seed');
  assert.deepEqual(planeOf(agent), { role: 'lead', installed: true, degradations: [] });
});

test('ensureAgentPlane 按角色表装配：teammate/architect/worker 的 deny/section/工具组与表一致', () => {
  resetShared();
  const runtime = {
    toolsOf: (group) => (group === 'teammate' ? [{ name: 'relay_checkpoint' }, { name: 'relay_freshen' }] : [{ name: 'relay_checkpoint' }]),
    isArchitect: () => false,
  };
  const teammate = scopedAgent({ sessionId: 'session-plane-teammate', header: { origin: 'subagent', delegationDepth: 1 } });
  assert.equal(ensureAgentPlane(teammate.agent, runtime).role, 'teammate');
  assert.deepEqual(teammate.state.restricted, [...LEAD_ONLY_TOOLS, ...TEAMMATE_DOC_DENY, ...SUBAGENT_ASK_USER_DENY], '队友裁 lead-only + doc + ask_user');
  assert.deepEqual(teammate.state.registered, ['relay_checkpoint', 'relay_freshen']);
  assert.deepEqual(teammate.state.skills, [], '队友不装配 human-loop（角色技能只给 Lead）');
  assert.equal(teammate.state.sections[0].text, TEAMMATE_PROTOCOL_TEXT);

  const architectRuntime = { ...runtime, isArchitect: () => true };
  const architect = scopedAgent({ sessionId: 'session-plane-arch', header: { origin: 'subagent', parentSession: 'lead', delegationDepth: 1 } });
  assert.equal(ensureAgentPlane(architect.agent, architectRuntime).role, 'architect');
  assert.deepEqual(architect.state.restricted, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS, ...SUBAGENT_ASK_USER_DENY], '架构师裁 lead-only + phase + ask_user');
  assert.deepEqual(architect.state.registered, ['relay_checkpoint'], '架构师只拿 checkpoint');
  assert.deepEqual(architect.state.skills, [], '架构师不装配 human-loop');
  assert.equal(architect.state.sections[0].text, ARCHITECT_WORKER_PROTOCOL_TEXT);

  const worker = scopedAgent({ sessionId: 'session-plane-worker', header: { origin: 'subagent', delegationDepth: 2 } });
  const workerResult = ensureAgentPlane(worker.agent, runtime);
  assert.equal(workerResult.role, 'worker');
  assert.deepEqual(worker.state.restricted, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS, ...WORKER_RELAY_DENY, ...SUBAGENT_ASK_USER_DENY], 'worker 裁 lead-only + phase + status/doc + ask_user');
  assert.deepEqual(worker.state.registered, [], 'worker 不注册角色工具');
  assert.deepEqual(worker.state.skills, [], 'worker 不装配 human-loop');
  assert.deepEqual(worker.state.sections.map((section) => section.name), ['context-relay:protocol']);
});

test('w5 ask_user_question：non-lead 用 agent-scope restrict 裁掉；restrict 失败只 warn 不抛', () => {
  resetShared();
  const runtime = { toolsOf: () => [], isArchitect: () => false };
  for (const header of [
    { origin: 'subagent', delegationDepth: 1 },
    { origin: 'subagent', delegationDepth: 2 },
  ]) {
    const agent = scopedAgent({ sessionId: 'session-plane-ask-' + header.delegationDepth, header });
    assert.equal(ensureAgentPlane(agent.agent, runtime).ok, true);
    assert.ok(agent.state.restricted.includes('ask_user_question'), '非 Lead 必须裁掉提问工具：depth=' + header.delegationDepth);
  }
  // restrict 不识别该工具名（旧内核/preset 未装工具）→ 全部失败只 warn + degradation，不阻断安装。
  const failing = scopedAgent({
    sessionId: 'session-plane-ask-fail',
    header: { origin: 'subagent', delegationDepth: 1 },
    restrictThrows: new Set(['ask_user_question']),
  });
  assert.doesNotThrow(() => ensureAgentPlane(failing.agent, runtime));
  assert.ok(!failing.state.restricted.includes('ask_user_question'), '失败的工具名不进入已裁名单');
  assert.equal(planeOf(failing.agent).installed, true, 'ask_user 裁剪失败不阻断平面安装');
  assert.ok(planeOf(failing.agent).degradations.some((entry) => entry.seam === 'tools' && /subagent ask_user restrict: no tools restricted/.test(entry.reason)));
});

test('w5 技能服务缺失：Lead 的 human-loop 注册失败只降级，不阻断工具/协议段', () => {
  resetShared();
  const target = scopedAgent({
    sessionId: 'session-plane-skills-missing',
    header: {},
    getService: (name) => (name === 'skills' ? undefined : {}),
  });
  assert.doesNotThrow(() => ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf }));
  assert.deepEqual(target.state.skills, [], 'skills 服务缺失时没有注册');
  assert.equal(planeOf(target.agent).installed, false, '角色所需 effect 未全部装上');
  assert.ok(planeOf(target.agent).degradations.some((entry) => entry.seam === 'skills' && entry.level === 'unavailable'), '技能降级可见');
});

test('M-02 主路径 · apply 时枚举 live agents 回填：relay agent 装上、非 relay agent 不动', () => {
  resetShared();
  const relayAgent = scopedAgent({ sessionId: 'session-live-relay', header: {} });
  const ptcAgent = scopedAgent({ sessionId: 'session-live-ptc', header: {} });
  const composed = new Map([['session-live-relay', 'relay-long'], ['session-live-ptc', 'ptc']]);
  const host = hostCtx({
    agents: { list: () => [relayAgent.agent, ptcAgent.agent], get: (id) => (id === 'session-live-relay' ? relayAgent.agent : undefined) },
    agentPresets: { composedPreset: (agentCtx) => composed.get(agentCtx === relayAgent.agent.ctx ? 'session-live-relay' : 'session-live-ptc') },
  });
  apply(host.ctx, { presetId: 'relay-long', relayPresetIds: ['relay-long'] });
  assert.deepEqual(planeOf(relayAgent.agent), { role: 'lead', installed: true, degradations: [] }, '既有 live relay agent 被回填');
  assert.deepEqual(relayAgent.state.restricted, [...ROUTER_DENY_TOOLS], '回填的 root 拿到 Router deny');
  assert.equal(planeOf(ptcAgent.agent).installed, false, '非 relay agent 不装');
  assert.deepEqual(ptcAgent.state.restricted, []);
  assert.equal(isPlaneTracked(ptcAgent.agent), false);
});

test('M-02 主路径 · agent-preset/selected 事件回填：ptc→relay 切换不重发 created 也能装（幂等）', () => {
  resetShared();
  const agent = scopedAgent({ sessionId: 'session-switch', header: {} });
  let composedId = 'ptc';
  const host = hostCtx({
    agents: { get: (id) => (id === 'session-switch' ? agent.agent : undefined) },
    agentPresets: { composedPreset: () => composedId },
  });
  apply(host.ctx, { presetId: 'relay-long', relayPresetIds: ['relay-long'] });
  const selected = host.event('agent-preset/selected');
  assert.ok(selected !== undefined, 'agent-preset/selected 监听已注册');
  assert.equal(planeOf(agent.agent).installed, false);
  // 官方事件签名：(sessionId, agentPreset)；select() 先 recompose（composed 已变）再 append 事件。
  composedId = 'relay-long';
  selected.listener('session-switch', 'relay-long');
  assert.deepEqual(planeOf(agent.agent), { role: 'lead', installed: true, degradations: [] });
  const restrictedCount = agent.state.restricted.length;
  selected.listener('session-switch', 'relay-long');
  assert.equal(agent.state.restricted.length, restrictedCount, '事件重复触发幂等');
  // 事件参数不是 relay → 不装。
  const other = scopedAgent({ sessionId: 'session-other', header: {} });
  host.events.find((entry) => entry.name === 'agent-preset/selected').listener('session-other', 'ptc');
  assert.equal(planeOf(other.agent).installed, false);
});

test('agent/created 路径保留：无 agentPresets/agents 服务时（旧内核/最小装配）仍按创建事件安装', () => {
  resetShared();
  const host = hostCtx({});
  apply(host.ctx, { presetId: 'relay', relayPresetIds: ['relay'] });
  const created = host.event('agent/created');
  assert.ok(created !== undefined);
  const root = scopedAgent({ sessionId: 'session-created' });
  created.listener({ agent: root.agent });
  assert.deepEqual(planeOf(root.agent), { role: 'lead', installed: true, degradations: [] });
  assert.deepEqual(root.state.restricted, [...ROUTER_DENY_TOOLS]);
});

test('每步惰性兜底：监听器缺失窗口里创建的 relay agent，下一个 pre-step 补装（只补一次）', async () => {
  resetShared();
  let composedId = 'relay-long';
  const orphan = scopedAgent({ sessionId: 'session-orphan', header: {} });
  const host = hostCtx({
    agents: { get: (id) => (id === 'session-orphan' ? orphan.agent : undefined) },
    agentPresets: { composedPreset: () => composedId },
  });
  apply(host.ctx, { presetId: 'relay-long', relayPresetIds: ['relay-long'] });
  // pre-step 监听器顺序：team-tools reset applier → 平面惰性 ensure → sentinel（末位；agent.test 的 .at(-1) 约定）。
  const preSteps = host.events.filter((entry) => entry.name === 'agent/pre-step').map((entry) => entry.listener);
  assert.equal(preSteps.length, 3, 'reset applier + plane lazy ensure + sentinel');
  const lazy = { listener: preSteps[1] };
  assert.equal(planeOf(orphan.agent).installed, false);
  let advanced = 0;
  const advance = async () => { advanced += 1; };
  await lazy.listener({ agent: orphan.agent }, advance);
  assert.equal(advanced, 1, 'pre-step 必须调用 next() 推进步骤');
  assert.deepEqual(planeOf(orphan.agent), { role: 'lead', installed: true, degradations: [] });
  const restrictedCount = orphan.state.restricted.length;
  await lazy.listener({ agent: orphan.agent }, advance);
  assert.equal(orphan.state.restricted.length, restrictedCount, '已装 agent 的后续每一步不重复安装');
  // 非 relay agent 不装（composed 门控）。
  composedId = 'ptc';
  const other = scopedAgent({ sessionId: 'session-orphan-ptc', header: {} });
  await lazy.listener({ agent: other.agent }, advance);
  assert.equal(planeOf(other.agent).installed, false);
});

test('relay_status.plane 可见：role/installed/degradations；会话句柄回退也能读到', async () => {
  resetShared();
  const host = hostCtx({
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1_000_000, projectedTokens: 20_000 } } }) },
    tokenMeter: { measure: () => ({ totalTokens: 20_000 }) },
  });
  apply(host.ctx, { presetId: 'relay', relayPresetIds: ['relay'] });
  const root = scopedAgent({ sessionId: 'session-plane-status' });
  host.event('agent/created').listener({ agent: root.agent });
  const at = (agent) => host.presetTools.get('relay_status').execute({}, { agent });
  const report = await at(root.agent);
  assert.deepEqual(report.plane, { role: 'lead', installed: true, degradations: [] }, 'relay_status 带平面自检字段');
  // 只有会话句柄（relay_status 的 exec.agent 与安装对象不同引用）→ 按 sessionId 回退读同一记录。
  const viaSession = await at({ session: root.agent.session, options: {} });
  assert.deepEqual(viaSession.plane, report.plane);
  // 未安装的 teammate 会话：role 如实、installed=false（M-02 的静默降级变得可见）。
  const teammateSession = liveSession('session-plane-uninstalled');
  teammateSession.header = { origin: 'subagent', delegationDepth: 1 };
  const uninstalled = await at({ session: teammateSession, options: {} });
  assert.deepEqual(uninstalled.plane, { role: 'teammate', installed: false, degradations: [] });
  // 既有字段不受影响（只加字段）。
  assert.equal(typeof report.lead.band, 'string');
  assert.equal(typeof report.text, 'string');
});

test('反向切换（preset 从 relay 切走）：代际 dispose 卸载 agent-scope 注册，状态变未安装', () => {
  resetShared();
  const agent = scopedAgent({ sessionId: 'session-leave', header: {} });
  let composedId = 'relay-long';
  const host = hostCtx({
    agents: { get: (id) => (id === 'session-leave' ? agent.agent : undefined) },
    agentPresets: { composedPreset: () => composedId },
  });
  apply(host.ctx, { presetId: 'relay-long', relayPresetIds: ['relay-long'] });
  host.event('agent-created');
  ensureAgentPlane(agent.agent, { toolsOf: () => [], skillOf: testSkillOf });
  assert.equal(planeOf(agent.agent).installed, true);
  composedId = 'ptc';
  const cleanup = host.effect('plane dispose on preset leave');
  assert.ok(cleanup !== undefined, '代际卸载 cleanup 已注册');
  cleanup.dispose();
  assert.deepEqual(planeOf(agent.agent), { role: 'lead', installed: false, degradations: [] }, '可逆卸载：干净摘除，无降级');
  assert.deepEqual(agent.state.disposed.sort(), ['skills', 'systemPrompt', 'tools'], '注入 fiber 被 dispose（restrict/注册/影子段/技能撤销）');
});

test('反向切换仍绑定另一代 relay（迁移期 id 别名互切）：保留平面不误卸', () => {
  resetShared();
  const agent = scopedAgent({ sessionId: 'session-alias', header: {} });
  let composedId = 'relay-long';
  const host = hostCtx({
    agents: { get: () => agent.agent },
    agentPresets: { composedPreset: () => composedId },
  });
  apply(host.ctx, { presetId: 'relay-long', relayPresetIds: ['relay-long', 'relay'] });
  ensureAgentPlane(agent.agent, { toolsOf: () => [], skillOf: testSkillOf });
  const cleanup = host.effect('plane dispose on preset leave');
  composedId = 'relay';
  cleanup.dispose();
  assert.equal(planeOf(agent.agent).installed, true, '别名互切（relay-long→relay）由新一代际接管，平面保持');
  // 明确切走（非 relay）时才卸载。
  composedId = 'ptc';
  cleanup.dispose();
  assert.equal(planeOf(agent.agent).installed, false);
});

test('不可逆 composition：注入 fiber 无 dispose → 卸载记 degradation（不静默）', () => {
  resetShared();
  const target = scopedAgent({ sessionId: 'session-irreversible', header: {}, noDispose: true });
  ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf });
  assert.equal(planeOf(target.agent).installed, true);
  const result = disposePlane(target.agent, 'preset-left');
  assert.equal(result.ok, true);
  assert.equal(result.clean, false, '不可逆 → clean=false');
  const status = planeOf(target.agent);
  assert.equal(status.installed, false);
  assert.ok(status.degradations.length > 0, '降级记录可见');
  assert.ok(status.degradations.some((entry) => entry.seam === 'tools' && /uninstall incomplete/.test(entry.reason)));
  assert.ok(status.degradations.some((entry) => entry.seam === 'systemPrompt'));
  assert.equal(typeof result.role, 'string');
});

test('fail-open 降级：ctx 缺失 / restrict 全部失败 / 服务缺失 → degradations 汇总，不抛错', () => {
  resetShared();
  // 1) 无 agent.ctx：两个 seam 都 unavailable，installed=false。
  const noCtx = { session: liveSession('session-noctx') };
  const result = ensureAgentPlane(noCtx, { toolsOf: () => [], seed: () => { throw new Error('panel boom'); } });
  assert.equal(result.ok, true);
  assert.equal(result.installed, false);
  const status = planeOf(noCtx);
  assert.equal(status.installed, false);
  assert.equal(status.role, 'lead');
  assert.ok(status.degradations.some((entry) => entry.seam === 'tools' && entry.level === 'unavailable'));
  assert.ok(status.degradations.some((entry) => entry.seam === 'systemPrompt' && entry.level === 'unavailable'));
  // 2) restrict 全部失败：installed 仍为 true（effect 注入成功），但降级可见。
  const target = scopedAgent({ sessionId: 'session-degraded', header: {}, restrictThrows: new Set(ROUTER_DENY_TOOLS) });
  const rootResult = ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf });
  assert.equal(rootResult.installed, true);
  const degraded = planeOf(target.agent);
  assert.ok(degraded.degradations.some((entry) => entry.seam === 'tools' && /no tools restricted/.test(entry.reason)));
  // 3) inject 抛错：不抛到调用方，降级可见。
  const throwing = scopedAgent({ sessionId: 'session-inject-throw', header: {}, injectThrows: true });
  assert.doesNotThrow(() => ensureAgentPlane(throwing.agent, { toolsOf: () => [], skillOf: testSkillOf }));
  assert.equal(planeOf(throwing.agent).installed, false);
  assert.ok(planeOf(throwing.agent).degradations.some((entry) => entry.seam === 'tools' && /skipped/.test(entry.reason)));
  // 4) 未知 agent 句柄：disposePlane 返回结构化 not-installed，不抛。
  assert.deepEqual(disposePlane({ session: liveSession('session-never') }), { ok: false, code: 'not-installed', installed: false });
});

test('半装成（一个 seam 服务缺失）也进入状态机：installed=false 且代际清理仍 dispose 已注入的 fiber', () => {
  resetShared();
  const target = scopedAgent({
    sessionId: 'session-partial',
    header: {},
    getService: (name) => (name === 'systemPrompt' ? { section() {} } : undefined),
  });
  const result = ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf });
  assert.equal(result.installed, false, 'tools seam 缺失 → 未完全装好');
  assert.deepEqual(target.state.sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], '可用的 seam 照装（root 两段）');
  assert.ok(planeOf(target.agent).degradations.some((entry) => entry.seam === 'tools' && entry.level === 'unavailable'));
  assert.deepEqual(target.state.disposed, [], '此时未卸载');
  const all = disposeAllPlanes({ reason: 'preset-left' });
  assert.ok(all.disposed.includes('session-partial'), '半装成的 agent-scope 注册必须被清理');
  assert.deepEqual(target.state.disposed, ['systemPrompt']);
});

test('半装成后重试：先撤旧 agent-scope 注册再重装（不叠加 restrict/section）', () => {
  resetShared();
  let toolsAvailable = false;
  const target = scopedAgent({
    sessionId: 'session-retry',
    header: {},
    getService: (name) => (name === 'tools' ? (toolsAvailable ? {} : undefined) : {}),
  });
  assert.equal(ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf }).installed, false);
  assert.equal(target.state.sections.length, 2);
  toolsAvailable = true;
  assert.equal(ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf }).installed, true);
  assert.deepEqual(target.state.restricted, [...ROUTER_DENY_TOOLS], '重试只裁一次');
  assert.ok(!target.state.disposed.includes('tools'), '第一次安装 tools 被跳过、无旧 tools fiber 需撤');
  assert.ok(target.state.disposed.includes('systemPrompt'), '重装前撤掉旧 fiber（真实系统同名 section 覆盖 → 净效果仍 2 段）');
  assert.equal(target.state.sections.length, 4, 'fake 记录只增不减：旧 2 段 + 重装 2 段（对应真实系统 2 段）');
  const before = [...target.state.restricted];
  assert.equal(ensureAgentPlane(target.agent, { toolsOf: () => [], skillOf: testSkillOf }).idempotent, true, '装好后幂等短路');
  assert.deepEqual(target.state.restricted, before);
});

test('disposeAllPlanes 遍历会话记录：多 agent 一起清理，failed 可观测', () => {
  resetShared();
  const a = scopedAgent({ sessionId: 'session-all-a', header: {} });
  const b = scopedAgent({ sessionId: 'session-all-b', header: {}, noDispose: true });
  ensureAgentPlane(a.agent, { toolsOf: () => [], skillOf: testSkillOf });
  ensureAgentPlane(b.agent, { toolsOf: () => [], skillOf: testSkillOf });
  const result = disposeAllPlanes({ reason: 'preset-left' });
  assert.deepEqual(result.disposed.sort(), ['session-all-a']);
  assert.deepEqual(result.failed.sort(), ['session-all-b']);
  assert.equal(planeOf(a.agent).installed, false);
  assert.ok(planeOf(b.agent).degradations.some((entry) => /uninstall incomplete/.test(entry.reason)));
  // 未安装的 agent 不在遍历范围。
  const never = ensureAgentPlane(scopedAgent({ sessionId: 'session-all-never' }).agent, { toolsOf: () => [], skillOf: testSkillOf });
  assert.equal(never.installed, true);
});
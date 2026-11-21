/**
 * dsh-context-relay — 注入预算快照（v0.10.0 C11：M-09 / A-06 / A-07 / A-09 / D-10）。
 *
 * 真源：.scratch/private-docs/audits/audit-2026-11-16/（AUDIT-2026-11-16.md §4 M-09、
 * A-protocol.md A-06/A-07/A-09、D-arch.md D-10）；设计稿
 * .scratch/context-relay/architecture/complete-form-2026-11-16.md §3 C11 行。
 *
 * 「装配实测」= 跑 lib/agent.js 的 apply(fake ctx) 捕获 preset 层注册（8 工具 + 4 常驻 section），
 * 再经 agent/created 在 fake agent scope 捕获各角色的 restrict / register / 同名影子 section；
 * 常驻 section 文本按 apply 里的 text(context) 用该角色会话上下文求值——不是把 lib 常量相加。
 * 四角色 = lead（root）/ teammate（depth=1）/ architect（depth=1 + pending 认领）/ worker（depth≥2）。
 *
 * 快照只记录字节漂移（diagnostic，不设失败门——R1）；工具面/角色表/deny 仍是契约。
 * 有意变更时更新本文件快照并在回执里写明预算变化（新增工具 = 每请求常驻注入回涨）。
 * 快照值为 C11 实现时（C9/C10 之后）的实测值；15 工具 = 常驻 8 + lead-only 5 + 队友 2。
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

/** 进程级共享状态复位（与 test/budget.test.mjs 同口径）：面板落临时文件 + live 设置显式固定。 */
function resetSharedState() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-budget-snapshot-panel-')), 'panel.json') });
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

/** 工具 schema 字符口径（与 agent.test.mjs P2-19 一致）：desc 字符 + parameters JSON 字符。 */
const schemaCharsOf = (definition) => definition.description.length + JSON.stringify(definition.parameters).length;

/** section 文本求值：apply 的函数式 section 用该角色会话上下文求值；字符串直接用。 */
function textCharsOf(definition, agent) {
  const text = typeof definition.text === 'function' ? definition.text({ agent }) : definition.text;
  return String(text ?? '').length;
}

/**
 * 一次装配实测：apply(preset 层) → 逐角色 agent/created（agent 层 restrict/register/section）。
 * 返回 preset 工具表、15 工具全集、四角色实测快照。
 */
async function assembleAll() {
  resetSharedState();
  const preset = fakeCtx();
  apply(preset.ctx, {});
  const created = preset.events.find((event) => event.name === 'agent/created');
  assert.ok(created, 'agent/created 装配入口必须存在（角色平面随 agent 创建安装）');
  const specs = {
    lead: { id: 'session-budget-snapshot-lead', header: {} },
    teammate: { id: 'session-budget-snapshot-teammate', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'session-budget-snapshot-lead' } },
    architect: { id: 'session-budget-snapshot-architect', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'session-budget-snapshot-architect-parent' } },
    worker: { id: 'session-budget-snapshot-worker', header: { origin: 'subagent', delegationDepth: 2, parentSession: 'session-budget-snapshot-teammate' } },
  };
  // 架构师身份 = spawn 前 pending 标记（创建瞬间 consume；不依赖 team 服务/roster）。
  markPendingArchitect(specs.architect.header.parentSession);
  const scopes = {};
  for (const [role, spec] of Object.entries(specs)) {
    const scope = agentScope(spec);
    await created.listener({ agent: scope.agent });
    scopes[role] = { scope, measured: measureRole(scope, preset.tools, preset.sections) };
  }
  // 15 工具全集：preset 常驻 8 + root lead-only 5 + 直接队友 2。
  const allTools = new Map([...preset.tools, ...scopes.lead.scope.registered, ...scopes.teammate.scope.registered]);
  return {
    presetTools: preset.tools,
    allTools,
    measured: Object.fromEntries(Object.entries(scopes).map(([role, entry]) => [role, entry.measured])),
    skills: Object.fromEntries(Object.entries(scopes).map(([role, entry]) => [role, entry.scope.skills])),
  };
}

/** 装配一个角色的可见面：常驻 section（同名影子覆盖 + 角色独有段）+ 裁剪后工具面。 */
function measureRole(scope, presetTools, presetSections) {
  const roleByName = new Map(scope.sections.map((definition) => [definition.name, definition]));
  const sections = presetSections.map((definition) => {
    const effective = roleByName.get(definition.name) ?? definition;
    return [definition.name, textCharsOf(effective, scope.agent)];
  });
  for (const definition of scope.sections) {
    if (presetSections.some((preset) => preset.name === definition.name)) continue;
    sections.push([definition.name, textCharsOf(definition, scope.agent)]);
  }
  const denied = [...scope.restricted];
  const deniedSet = new Set(denied);
  const active = [...presetTools.values()].filter((definition) => !deniedSet.has(definition.name));
  for (const definition of scope.registered.values()) {
    if (deniedSet.has(definition.name) || active.some((entry) => entry.name === definition.name)) continue;
    active.push(definition);
  }
  const sectionChars = sections.reduce((sum, [, chars]) => sum + chars, 0);
  const toolDescChars = active.reduce((sum, definition) => sum + definition.description.length, 0);
  const toolSchemaChars = active.reduce((sum, definition) => sum + schemaCharsOf(definition), 0);
  return {
    sections,
    sectionChars,
    denied,
    roleTools: [...scope.registered.keys()],
    tools: active.map((definition) => definition.name),
    toolDescChars,
    toolSchemaChars,
    totalChars: sectionChars + toolSchemaChars,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// A-06 / D-10：15 个模型工具逐条 desc + params JSON 字符快照
// ────────────────────────────────────────────────────────────────────────────

/** 15 工具 = preset 常驻 8 + lead-only 5 + 队友 2；值 = [desc 字符, JSON.stringify(parameters) 字符]。 */
const TOOL_SCHEMA_SNAPSHOT = {
  relay_status: [346, 62],
  relay_recommend: [133, 311],
  relay_phase: [370, 8020],
  relay_organize: [314, 651],
  relay_doc: [345, 960],
  doc_lint: [110, 147],
  relay_work_items: [392, 2844],
  relay_handoff: [384, 1534],
  relay_team_status: [496, 1518],
  relay_renew: [357, 291],
  relay_architect: [718, 759],
  relay_dispatch: [248, 1314],
  relay_collect: [659, 1839],
  relay_checkpoint: [338, 1207],
  relay_freshen: [416, 952],
};

/** 15 工具 schema 合计（0.14.0-dev W2：删除 dispatch/work_items 用户段字段、risk 的 user_visible → params 22,409；desc 5,626；schema 28,035）。 */
const TOOL_SCHEMA_TOTALS = { desc: 5626, params: 22409, schema: 28035 };

test('C11 M-09/A-06/D-10：15 个模型工具 desc + params JSON 字符快照（新增/删除工具必须更新快照）', async () => {
  const { allTools } = await assembleAll();
  assert.equal(allTools.size, 15, '模型工具总数=15（常驻 8 + lead-only 5 + 队友 2）');
  assert.deepEqual(
    [...allTools.keys()].sort(),
    Object.keys(TOOL_SCHEMA_SNAPSHOT).sort(),
    '工具集合与快照不一致：新增/删除/改名工具必须同步更新快照并复核常驻预算',
  );
  let desc = 0;
  let params = 0;
  for (const [name, definition] of allTools) {
    const [descChars, paramChars] = TOOL_SCHEMA_SNAPSHOT[name];
    assert.equal(definition.description.length, descChars, name + ' description 字符漂移（单条预算需重定）');
    assert.equal(JSON.stringify(definition.parameters).length, paramChars, name + ' parameters JSON 字符漂移（单条预算需重定）');
    desc += definition.description.length;
    params += JSON.stringify(definition.parameters).length;
  }
  assert.deepEqual(
    { desc, params, schema: desc + params },
    TOOL_SCHEMA_TOTALS,
    '15 工具 schema 总量漂移：每请求常驻注入回涨无闸门，必须有意更新',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// A-07 / A-09：4 角色装配实测快照（section 求值 + restrict + 注册工具，非常量求和）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 四角色实测快照（由 apply + agent/created 装配后测得，不是 lib 常量求和）：
 *   sections = 常驻 section [name, 求值后字符]（同名角色影子段覆盖 preset 段；角色独有段追加）
 *   sectionChars = 常驻文本合计；denied = 该角色被 restrict 的工具名；
 *   roleTools = 该角色 agent-scope 注册的工具；tools = 角色实际可见工具面；
 *   toolDescChars/toolSchemaChars = 可见工具的 desc / desc+params JSON 合计；
 *   totalChars = sectionChars + toolSchemaChars（每请求常驻注入总量）。
 * 值来源：C11 实测（C9/C10 之后）；v0.11 P0-E 容量线独立配置后 lead 协议 +41 字符；
 * v0.11 P0-B 小队纪律 + relay_team_status manage schema 后 lead 段/工具面同步实测；
 * w1 设计门回显/深度模板后 lead 协议 +534、architect 协议 +77，relay_phase schema 同步实测；
 * w3 说人话后 protocol 回执句 +11、router 回执段 +7、teammate 协议 +32（仍 ≤7200/≤2000/≤1300 字符预算）；
 * w5 角色注入裁剪后：teammate/architect/worker 裁 ask_user；human-loop 不再全局注册，只在 Lead 的 agent scope 注册；
 * w6b relations 后 relay_doc desc +40 / params +10：lead 与 architect 工具面同步 +50（teammate/worker 无 relay_doc）。
 * fix-p1 角色矩阵按审计 §2.6 修正：doc_lint 只 Lead；teammate/worker 保留 relay_doc；architect/worker 裁 relay_status。
 * A1 actor 化（2026-11-20）：Lead 面 checkpoint/freshen 改为「发消息让队友自己执行」——protocol +63、
 * ledger +13、router +29、team-lead +30（lead 段合计 +135），architect 收尾句 +28；更新实测快照。
 *   → teammate: status+phase+doc+checkpoint+freshen（12,509 schema）；architect: doc+checkpoint（2,850）；
 *   worker: 只 relay_doc（1,305）；fix3 补 lead_confirm 复用字段后 Lead 13 工具 23,991 schema（relay_phase params 7,513）。
 * v0.13 B1 维护入口（manage.maintain）：relay_team_status desc +122 / params +367（含 brief/reset）→ lead 面 +489。
 * v0.13 P1 ② review_ref：relay_phase params +517（user_gate.review_ref）；协议 PROTOCOL 7160→7200 / ROUTER 2028→2052（D3 只读例外句）。
 * 0.14.0-dev W1/W2：协议补风险档矩阵/裁决卡、删工具用户段起稿；工具删 user_visible 字段。
 * 实测：PROTOCOL 8,074 / ROUTER 2,395 / TEAM_LEAD 933 / ARCHITECT(worker) 845；lead schema 25,122。
 */
const ROLE_SNAPSHOT = {
  lead: {
    sections: [
      ['context-relay:phase', 5189],
      ['context-relay:redline', 1178],
    ],
    sectionChars: 6367,
    denied: ['bash', 'pwsh', 'write', 'edit'],
    roleTools: ['relay_team_status', 'relay_renew', 'relay_architect', 'relay_dispatch', 'relay_collect'],
    tools: [...LEAD_TOOL_NAMES],
    toolDescChars: 4872,
    // v0.13 fix4：collect lead_confirm schema 改由 LEAD_CONFIRM_SPEC 生成（描述变长 +135）。
    // v0.13 fix5：relay_phase report schema 三问化 +44；router 2196→2246。
    toolSchemaChars: 25122,
    totalChars: 31489,
  },
  teammate: {
    sections: [
      ['context-relay:phase', 1320],
      ['context-relay:redline', 15],
    ],
    sectionChars: 1335,
    denied: ['relay_organize', 'relay_handoff', 'relay_recommend', 'relay_work_items', 'doc_lint', 'ask_user_question'],
    roleTools: ['relay_checkpoint', 'relay_freshen'],
    tools: [...TEAMMATE_TOOL_NAMES],
    toolDescChars: 1815,
    // v0.13 fix5：relay_phase report schema 三问化 +44 同样进队友面。
    toolSchemaChars: 13016,
    totalChars: 14351,
  },
  architect: {
    sections: [
      ['context-relay:phase', 845],
      ['context-relay:redline', 15],
    ],
    sectionChars: 860,
    denied: ['relay_organize', 'relay_handoff', 'relay_recommend', 'relay_work_items', 'relay_phase', 'relay_status', 'doc_lint', 'ask_user_question'],
    roleTools: ['relay_checkpoint'],
    tools: [...ARCHITECT_TOOL_NAMES],
    toolDescChars: 683,
    toolSchemaChars: 2850,
    totalChars: 3710,
  },
  worker: {
    sections: [
      ['context-relay:phase', 371],
      ['context-relay:redline', 15],
    ],
    sectionChars: 386,
    denied: ['relay_organize', 'relay_handoff', 'relay_recommend', 'relay_work_items', 'relay_phase', 'relay_status', 'doc_lint', 'ask_user_question'],
    roleTools: [],
    tools: [...WORKER_TOOL_NAMES],
    toolDescChars: 345,
    toolSchemaChars: 1305,
    totalChars: 1691,
  },
};

test('C11 A-07/A-09：4 角色装配实测快照（section 求值 + restrict + 注册工具，非常量求和）', async () => {
  const { measured, skills } = await assembleAll();
  for (const role of Object.keys(ROLE_SNAPSHOT)) {
    const actual = measured[role];
    const expected = ROLE_SNAPSHOT[role];
    // 字节字段只记录漂移（diagnostic/快照差），不设失败门（R1）。
    const byteDrift = ['sections', 'sectionChars', 'toolDescChars', 'toolSchemaChars', 'totalChars']
      .filter((key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      .map((key) => key + ' ' + JSON.stringify(expected[key]) + '→' + JSON.stringify(actual[key]));
    if (byteDrift.length > 0) console.log('[diagnostic] budget snapshot drift ' + role + ': ' + byteDrift.join(' | '));
    // 工具面/角色表/deny 是契约（非字节预算）：漂移即失败。
    for (const key of ['tools', 'roleTools', 'denied']) {
      assert.deepEqual(actual[key], expected[key], role + ' 工具面/角色表漂移: ' + key);
    }
  }
  // w5 技能面：human-loop 只给 Lead（agent scope），子智能体不装配（skills 无 deny，全局会对所有会话可见）。
  assert.deepEqual(skills.lead, ['human-loop'], 'Lead 技能面在 agent scope 注册 human-loop');
  for (const role of ['teammate', 'architect', 'worker']) assert.deepEqual(skills[role], [], role + ' 不装配 human-loop');
  // A-07：TEAMMATE 协议段长度只记录（R1），不设字节失败门。
  const protocolChars = (role) => measured[role].sections.find(([name]) => name === 'context-relay:phase')[1];
  console.log('[diagnostic] TEAMMATE phase chars=' + protocolChars('teammate'));
  // A-09：root 常驻文本按装配实测（而不是把 lib 常量相加）；四角色按身份递减、工具面按角色裁剪。
  assert.ok(measured.lead.sectionChars > measured.teammate.sectionChars, 'root 常驻文本应多于直接队友');
  assert.ok(measured.teammate.sectionChars > measured.worker.sectionChars, '直接队友常驻文本应多于普通子代理');
  assert.ok(measured.lead.tools.length > measured.teammate.tools.length, 'root 工具面应大于直接队友');
});

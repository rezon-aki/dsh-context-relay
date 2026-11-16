import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/agent.js';
import { createRelayTools } from '../lib/agent/tools.js';
import { createDelegationTools } from '../lib/agent/delegation-tools.js';
import { ROUTER_DENY_TOOLS } from '../lib/agent/protocol.js';
import { readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { clearPanelMemory, configurePanelStore, liveStateOf, panelStateOf, updatePanelState } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { subagentsFromLegacy } from './team-fixture.mjs';

const HANDOFF_KEY = Symbol.for('dsh-context-relay.handoffs');
/** 每次切 phase 必填的契约自检（两条用户契约的工作时落地）。 */
const CONTRACT_CHECK = { requirement: '需求已定：用户要两条契约；边界：只改 relay 插件', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };
/** 进 ship 的用户门（新上下文独立审查 + 大白话汇报；宿主只校验非空）。 */
const SHIP_GATE = { review: 'fresh subagent 独立审查：需求已定、实现忠实，无偏移/劣化/偷懒/缺失', report: '大白话汇报：需求 → 实现 + 证据 → 无偏差、边界已说明' };
/** C9 设计门：首次进 build 必须带用户确认过的设计文档指针。 */
const DESIGN_GATE = { path: '.scratch/context-relay/architecture/complete-form-2026-11-16.md', user_approved: true };

/**
 * 每个测试前重置进程级共享状态（handoff 发布箱 + 侧栏 live 设置 + 面板状态 Map）。
 * 面板状态会持久化到 panel.json：固定指到临时路径，避免读写真实 home 数据干扰测试。
 */
function resetSharedState() {
  delete globalThis[HANDOFF_KEY];
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  // 测试夹具：本文件 band 数学（提醒/预算/advice）按显式基准 40%（35/40/50）编写；
  // 生产默认基准改为 35%（30/35/45）由 policy/index 测试覆盖。
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  delete globalThis[Symbol.for('dsh-context-relay.handoff.routes')];
  clearPanelMemory();
  clearSentinelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-panel-')), 'panel.json') });
}

/** 极简 fake ctx：只实现 agent.js 用到的接口，捕获注册产物 + logger 里程碑。 */
function fakeCtx(overrides = {}) {
  const provided = overrides.services ?? {};
  const fixture = provided.agentTeams !== undefined && provided.subagents === undefined ? subagentsFromLegacy(provided.agentTeams) : undefined;
  const services = fixture === undefined ? provided : { ...provided, subagents: fixture, agents: provided.agents ?? fixture.agentsService };
  // Official followup persists acceptance in the inbox before returning.
  const receiptAgents = new WeakSet();
  const withReceipt = (agent) => {
    if (agent === undefined || typeof agent.followup !== 'function' || receiptAgents.has(agent)) return agent;
    receiptAgents.add(agent);
    agent.inbox ??= { nextTurn: [], nextStep: [] };
    const followup = agent.followup;
    agent.followup = function(message) { const out = followup.call(this, message); this.inbox.nextTurn.push(message); return out; };
    return agent;
  };
  if (services.agents !== undefined) {
    services.agents = { ...services.agents };
    for (const method of ['get', 'list']) if (typeof services.agents[method] === 'function') {
      const original = services.agents[method];
      services.agents[method] = (...args) => { const out = original(...args); return Array.isArray(out) ? out.map(withReceipt) : withReceipt(out); };
    }
    if (typeof services.agents.create === 'function') {
      const create = services.agents.create;
      services.agents.create = async (...args) => { const handle = await create(...args); withReceipt(handle.agent); return handle; };
    }
  }
  const tools = new Map();
  const sections = [];
  const events = [];
  const cleanups = [];
  const logs = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      const cleanup = typeof dispose === 'function' ? dispose : () => {};
      cleanups.push(cleanup);
      return cleanup;
    },
    on(name, listener, options) {
      events.push({ name, listener, options });
      return () => {};
    },
    logger: {
      info(message) { logs.push('info ' + message); },
      warn(message) { logs.push('warn ' + message); },
    },
    systemPrompt: {
      section(definition) { sections.push(definition); return () => {}; },
      context() { return () => {}; },
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx, tools, sections, events, cleanups, logs };
}

function fakeSession({ id = 'session-test', cwd, log = [], seq, header, requestHeader } = {}) {
  const builtHeader = header ?? (cwd === undefined ? {} : { cwd });
  return {
    id,
    header: builtHeader,
    get seq() { return seq ?? log.length; },
    snapshotEvents() { return log; },
    requestHeader: requestHeader ?? (() => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } })),
  };
}

/** services + 可变压力状态（模拟 contextPressure 投影变化）。 */
function fakeServices({ session, pressure = { contextWindow: 1_000_000, projectedTokens: 20000 }, compaction, extra = {} } = {}) {
  const state = { pressure };
  const services = {
    sessionProjections: { snapshot: () => ({ values: { contextPressure: state.pressure } }) },
    tokenMeter: { measure: () => ({ totalTokens: state.pressure.projectedTokens ?? 0 }) },
    compaction,
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
    sessionQuery: undefined,
    ...extra,
  };
  return { services, state };
}

function applyAgent(services, config = {}) {
  const { ctx, tools, sections, events, cleanups, logs } = fakeCtx({ services });
  apply(ctx, config);
  return { ctx, tools, sections, events, cleanups, logs };
}

/** 取官方 tools/pre-execute 审批 waterfall 监听器（audit H）。 */
function preExecuteListener(events) {
  const found = events.find((event) => event.name === 'tools/pre-execute');
  assert.ok(found, 'tools/pre-execute approval gate registered');
  return found.listener;
}

/**
 * 模拟官方运行时对 ask 决议的解析（dsh-tools serviceAsk）：allowed-once 才放行，
 * rejected/cancelled/unavailable 一律 deny。用于不起真实 GUI 的审批路径测试。
 */
async function resolveApproval(listener, exec, approval) {
  const decision = await listener(exec, async () => ({ kind: 'allow' }));
  if (decision.kind !== 'ask') return decision;
  const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: decision.reason, displayReason: decision.displayReason });
  return outcome === 'allowed-once' ? { kind: 'allow' } : { kind: 'deny', outcome };
}

function preStepListener(events) {
  // v0.9.0 单一模式：teamTools 恒创建（自带 reset applier 的 agent/pre-step 监听），
  // 到线提醒监听由 installSentinel 后注册（最后一条）。宿主按注册顺序执行 waterfall，
  // 测试取 sentinel 监听（末位）与既有 .at(-1) 约定一致。
  const found = events.filter((event) => event.name === 'agent/pre-step').at(-1);
  assert.ok(found, 'agent/pre-step listener registered');
  return found.listener;
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-test-'));
}

/** v0.9.0 批次3：写一份台账（scope=根会话 id；默认 build/done），用于委派闸门/集成测试。 */
async function seedRelayLedger(cwd, scopeId, items) {
  const result = await writeWorkItems(cwd, {
    items: items.map((item) => ({
      id: item.id,
      title: item.title ?? item.id,
      status: item.status ?? 'done',
      owner: item.owner ?? null,
      next: item.next ?? null,
      blocked: item.blocked ?? null,
      evidence: item.evidence ?? [],
      phase: item.phase ?? 'build',
    })),
    scopeId,
    updatedBy: scopeId,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ledger;
}

/** v0.9.0 批次3：直接 createRelayTools（不经 agent.js 装配），用于 runtime.delegation 三档/零副作用测试。 */
function directRelayTools(services, { delegation, workItems } = {}) {
  const { ctx } = fakeCtx({ services });
  const definitions = createRelayTools({
    ctx,
    currentThresholds: () => thresholdsFromPercent(35),
    workItems: { enabled: true, gate: 'strict', phaseGate: 'strict', max: 30, pathOverride: undefined, ...workItems },
    ...(delegation === undefined ? {} : { delegation }),
  });
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

/** v0.9.0 批次3 集成：root Lead 的 agent-scope 记录器（登记工具定义 + restrict 名单 + sections）。 */
function rootLeadHarness({ sessionId, cwd }) {
  const registered = new Map();
  const restricted = [];
  const sections = [];
  const agent = {
    session: {
      id: sessionId,
      header: { cwd },
      seq: 0,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
      snapshotEvents: () => [],
    },
    ctx: {
      inject(services, callback) {
        if (services.length === 1 && services[0] === 'tools') {
          callback({
            tools: {
              register(definition) { registered.set(definition.name, definition); return () => {}; },
              restrict(payload) { for (const name of payload?.deny ?? []) restricted.push(name); return () => {}; },
            },
          });
          return { dispose() {} };
        }
        if (services.length === 1 && services[0] === 'systemPrompt') {
          callback({ systemPrompt: { section(definition) { sections.push(definition); return () => {}; } } });
          return { dispose() {} };
        }
        throw new Error('unexpected agent scope inject: ' + JSON.stringify(services));
      },
    },
    inject() {},
  };
  return { agent, registered, restricted, sections };
}

/**
 * batch3：在 fakeServices 的投影服务上挂 relay 投影 stateOf（模拟 host 平面注册
 * lib/projection.js 的 relayProjectionDefinition）；记录 stateOf 调用 key 供断言。
 */
function attachRelayProjection(bundle, projection) {
  bundle.stateOfCalls = [];
  bundle.services.sessionProjections.stateOf = (session, key) => {
    bundle.stateOfCalls.push(key);
    return projection;
  };
  return bundle;
}

/** 包一层 snapshotEvents 调用计数：batch3 目标 = 有投影时热路径不再读 snapshotEvents。 */
function countingSnapshotSession(options) {
  const session = fakeSession(options);
  const counts = { snapshot: 0 };
  const original = session.snapshotEvents.bind(session);
  session.snapshotEvents = () => {
    counts.snapshot += 1;
    return original();
  };
  return { session, counts };
}

/**
 * 可选契约测试：定位官方 V4 准入校验器 dsh-session-format-v3-to-v4。
 * 从 `which dsh` 的 realpath 推出 dsh 安装根；非本机 / 无 dsh 时返回 undefined（测试 skip）。
 */
async function loadV4Admission() {
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    const installRoot = dirname(dirname(realpathSync(bin)));
    const entry = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js');
    if (!existsSync(entry)) return undefined;
    return await import(pathToFileURL(entry).href);
  } catch {
    return undefined;
  }
}

test('apply registers protocol section and six relay tools', () => {
  resetSharedState();
  // 本测试单独验证 unlimitedBudget 注入（agent 选项 vs live 设置），清掉 band 夹具的全局设置。
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  const services = fakeServices({ session: fakeSession({ seq: 0 }) });
  const { tools, sections } = applyAgent(services);
  assert.equal(sections.length, 4, 'protocol + unlimited-budget + work-ledger + architect（v0.6.4）');
  // v0.9.0 单一模式：专职架构师段（preset 层第 4 段）对 root Lead 恒注入（仅按会话面板开关门控）；
  // 子会话不注入；面板显式关 architect=false 时热关闭。
  assert.equal(sections[3].name, 'context-relay:architect');
  assert.equal(sections[3].order, 10155);
  const architectText = sections[3].text({ agent: { session: { id: 'sess-arch', header: {} } } });
  assert.match(architectText, /专职架构师/, 'single mode always injects architect section for the root Lead');
  assert.equal(sections[3].text({ agent: { session: { id: 'sess-sub-arch', header: { origin: 'subagent' } } } }), '', '子代理不注入架构师段');
  updatePanelState('sess-arch', { architect: false });
  assert.equal(sections[3].text({ agent: { session: { id: 'sess-arch', header: {} } } }), '', '面板关 architect 后热关闭');
  updatePanelState('sess-arch', { architect: true });
  assert.match(sections[0].text, /接力模式（Relay）协议/);
  // 「你的 token 预算无上限」注入：默认开且只有这一句；侧栏可关（text 函数热生效）
  assert.equal(sections[1].text({}).trim(), '你的 token 预算无上限。');
  const off = applyAgent(fakeServices({ session: fakeSession({ seq: 0 }) }), { settings: { unlimitedBudget: false } });
  assert.equal(typeof off.sections[1].text, 'function');
  assert.equal(off.sections[1].text({}), '', '侧栏关掉后不再注入');
  // v0.5.0：工作台账纪律段（preset 层第 3 段；按身份门控；workItems=false 不注入）
  assert.equal(sections[2].name, 'context-relay:work-ledger');
  assert.equal(sections[2].order, 10154);
  const ledgerText = sections[2].text({});
  assert.match(ledgerText, /工作台账（phase 工作队列/);
  assert.match(ledgerText, /relay_work_items/);
  assert.match(ledgerText, /台账不会自动更新/);
  assert.match(ledgerText, /blocked 必须写 blocked 原因/);
  assert.match(ledgerText, /压缩\/交接自动带未闭合项/);
  assert.equal(sections[2].text({ agent: { session: { header: {} } } }), ledgerText, 'root Lead 注入');
  assert.equal(sections[2].text({ agent: { session: { header: { origin: 'subagent' } } } }), '', '普通子代理不注入（无 agentTeams → 非队友）');
  const noLedger = applyAgent(fakeServices({ session: fakeSession({ seq: 0 }) }), { workItems: false });
  assert.equal(noLedger.sections[2].text({}), '', 'workItems=false 时不注入台账纪律段');
  assert.ok(off.tools.get('relay_phase') !== undefined);
  assert.match(sections[0].text, /Phase 状态机/);
  assert.match(sections[0].text, /团队纪律/);
  // 用户口径（2026-10-24）：阈值/收尾/继续方式只在跨档到线提醒里出现，协议本体不写死
  assert.ok(!sections[0].text.includes('35%/40%/50%'), 'protocol must not hardcode thresholds');
  // 2026-11-01 用户更正：预算=上下文预算属于设计理念，不写进常驻协议、不写死 40%
  assert.ok(!sections[0].text.includes('40%'), 'protocol must not hardcode 40%');
  assert.ok(!sections[0].text.includes('高效区'), 'protocol must not embed the efficiency-zone philosophy');
  assert.ok(!sections[0].text.includes('上下文预算'), 'protocol must not embed the context-budget philosophy');
  // 侧栏热生效：不重建 agent 平面，段 text() 直接读 live 设置
  globalThis[Symbol.for('dsh-context-relay.settings')] = { unlimitedBudget: false };
  assert.equal(sections[1].text({}), '', 'live 关闭热生效');
  globalThis[Symbol.for('dsh-context-relay.settings')] = { unlimitedBudget: true };
  assert.equal(sections[1].text({}).trim(), '你的 token 预算无上限。', 'live 打开热生效');
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  assert.match(sections[0].text, /只在跨档时出现/);
  // 压缩/接力都是可选项，由人类/面板选（到线提醒里给动作）
  assert.match(sections[0].text, /严格按模式执行/);
  // P2/A3 修正：插件在压缩时自动跑 doc_lint 并把结果写进 brief/evidence，模型手动补充只在需要时
  assert.match(sections[0].text, /插件自动跑 doc_lint/, 'doc_lint 由插件自动跑（不再是模型压缩后必跑）');
  // 2026-10-25 用户口径：预算只当 phase 边界闸门——本 phase 未完成不看预算，超预算不得开新 phase
  assert.match(sections[0].text, /phase 边界闸门/);
  assert.match(sections[0].text, /不开新 phase/);
  assert.match(sections[0].text, /不挡当前 phase 的工作/);
  // v0.10.0 C10：退役档位句/派生插入句已从常驻协议删净，不得回潮。
  assert.doesNotMatch(sections[0].text, /没有「压缩后立即开新会话」档/, 'P3：LONG 派生插入句已删除');
  assert.doesNotMatch(sections[0].text, /compress-then-handoff|autoChoose|autoDecision/, 'C10：退役标识不得回到常驻协议');
  assert.match(sections[0].text, /不要先调 relay_phase/);
  // 2026-10-25 面板契约：到线提醒与压缩次数解耦、一次性默认操作、授权/免审口径、不再弹官方审批
  assert.match(sections[0].text, /到线提醒/);
  assert.match(sections[0].text, /与压缩次数无关/);
  // v0.4.0：模式持久（不消费），到线按模式执行
  assert.match(sections[0].text, /\*\*持久\*\*（不消费）/);
  // B-P1-2：授权语义收敛到唯一权威句（预设不产生豁免；免审只来自三个授权）
  assert.match(sections[0].text, /模式只决定「做什么」/);
  assert.match(sections[0].text, /不产生审批豁免/);
  assert.match(sections[0].text, /免审只来自 autoCompress \/ autoHandoff \/ authorizeNext/);
  assert.doesNotMatch(sections[0].text, /本次免审批|视为已授权|pre-authorize/);
  // 工具描述同步提面板、不提审批弹窗
  assert.match(tools.get('relay_phase').description, /composer panel/);
  assert.match(tools.get('relay_handoff').description, /composer panel/);
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, ['doc_lint', 'relay_doc', 'relay_handoff', 'relay_organize', 'relay_phase', 'relay_recommend', 'relay_status', 'relay_work_items']);
});

test('v0.2.7：unlimitedBudget 注入段按会话读 composer 小胶囊设置（热生效；面板快照覆盖全局默认）', () => {
  resetSharedState();
  const { sections } = applyAgent(fakeServices({ session: fakeSession({ seq: 0 }) }));
  const text = sections[1].text;
  const ctxOf = (id) => ({ agent: { session: fakeSession({ id }) } });
  // 默认（无面板记录 + settings 默认开）→ 注入一句
  assert.equal(text(ctxOf('session-budget-prompt')).trim(), '你的 token 预算无上限。');
  // 本会话关（composer 小胶囊 PUT 的同一份 panel 状态）→ 空串；再开 → 恢复（热生效，不重建 agent 平面）
  updatePanelState('session-budget-prompt', { unlimitedBudget: false });
  assert.equal(text(ctxOf('session-budget-prompt')), '', '本会话关 → 不再注入');
  updatePanelState('session-budget-prompt', { unlimitedBudget: true });
  assert.equal(text(ctxOf('session-budget-prompt')).trim(), '你的 token 预算无上限。', '本会话开 → 注入（热生效）');
  // 面板显式快照覆盖全局默认：全局关但本会话写过 true → 仍注入；未改面板的其它会话跟随全局关
  globalThis[Symbol.for('dsh-context-relay.settings')] = { unlimitedBudget: false };
  assert.equal(text(ctxOf('session-budget-prompt')).trim(), '你的 token 预算无上限。', '面板快照覆盖全局默认');
  assert.equal(text(ctxOf('session-budget-other')), '', '未改面板的会话跟随全局默认关');
  // 无 agent 上下文（诊断 assembly）→ 回退全局默认（此时全局关 → 空串）
  assert.equal(text({}), '');
});

test('v0.2.7：relay_handoff 在首条消息（首 step prompt assembly）之前把 unlimitedBudget 写入子会话', async () => {
  const cases = [
    // 每例令全局默认与期望相反：不写子会话时子值会等于 globalDefault，断言失败——确保测到 handoff 真的写入（非 vacuous）
    { name: 'inherit-on', globalDefault: false, parent: { unlimitedBudget: true }, expect: true },
    { name: 'inherit-off', globalDefault: true, parent: { unlimitedBudget: false }, expect: false },
    { name: 'force-on', globalDefault: false, parent: { unlimitedBudget: false, handoffUnlimitedBudget: true }, expect: true },
    { name: 'force-off', globalDefault: true, parent: { unlimitedBudget: true, handoffUnlimitedBudget: false }, expect: false },
    // 交接值恰好等于当时 settings 默认：no-op 优化会吞掉写入 → 必须 force 显式落库（否则日后默认变化会翻转强制语义）
    { name: 'inherit-on-equals-default', globalDefault: true, parent: { unlimitedBudget: true }, expect: true },
  ];
  for (const item of cases) {
    resetSharedState();
    globalThis[Symbol.for('dsh-context-relay.settings')].unlimitedBudget = item.globalDefault;
    const cwd = tmpCwd();
    const parentId = 'session-budget-' + item.name;
    const childId = 'session-budget-child-' + item.name;
    const session = fakeSession({ id: parentId, cwd, seq: 0 });
    if (Object.keys(item.parent).length > 0) updatePanelState(parentId, item.parent);
    // v0.7.1：架构师模型随 handoff 继承（与 unlimitedBudget 同一时机写入子会话）。
    updatePanelState(parentId, { architectModel: { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' } });
    const seen = [];
    const liveSession = { id: childId, header: { cwd }, requestHeader: () => undefined };
    const { tools } = applyAgent(fakeServices({
      session,
      extra: {
        sessionController: { async create() { return { sessionId: childId }; } },
        // followup 回调内采样子会话面板 = 首条消息触发首 step 的时刻；必须已写入
        agents: { list: () => [{ session: liveSession, status: 'idle', followup() { seen.push(panelStateOf(childId).unlimitedBudget); } }] },
        sessionTitle: { rename() {} },
      },
    }).services);
    const result = await tools.get('relay_handoff').execute({ status: { goal: 'budget ' + item.name }, human_approved: true }, { agent: { session, options: {} } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(seen.length, 1, '首条消息只发一次');
    assert.equal(seen[0], item.expect, item.name + ': followup 时子会话已带 unlimitedBudget=' + String(item.expect));
    assert.equal(panelStateOf(childId).unlimitedBudget, item.expect, item.name + ': 交接后子会话面板值');
    assert.deepEqual(panelStateOf(childId).architectModel, { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' }, item.name + ': 架构师模型随交接继承');
    // 强制语义持久性：交接后把侧栏默认改成相反值——只有「显式落库」的子会话记录才能保持交接设定
    // （相等默认的 no-op 被 force 关掉；没写记录时此处会翻转成 !expect 而失败）。
    globalThis[Symbol.for('dsh-context-relay.settings')].unlimitedBudget = item.expect !== true;
    assert.equal(panelStateOf(childId).unlimitedBudget, item.expect, item.name + ': 默认后续变化不翻转交接设定');
  }
  resetSharedState();
});

test('relay_status reports phase/band/advice', async () => {
  resetSharedState();
  const session = fakeSession({ seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.phase, 'discover');
  assert.equal(report.lead.band, 'ok');
  assert.match(report.text, /phase: discover/);
  // 2026-10-25：organize 档 advice 只挡「开新 phase」，并要求收尾三清单
  const overSession = fakeSession({ id: 'session-advice-organize', seq: 0 });
  const over = fakeServices({ session: overSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools: overTools } = applyAgent(over.services);
  const overReport = await overTools.get('relay_status').execute({}, { agent: { session: overSession, options: {} } });
  assert.equal(overReport.lead.band, 'organize');
  assert.match(overReport.advice, /不开新 phase/);
  assert.match(overReport.advice, /三清单/);
});

test('relay_phase over budget: 面板四分支（continue / compress / handoff / ask；autoChoose 已退役）', async () => {
  resetSharedState();
  const make = (id, preset) => {
    const session = fakeSession({ id, cwd: tmpCwd(), seq: 0 });
    const bundle = fakeServices({
      session,
      pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
      compaction: { async compactIfNeeded() { return { shadowedTokenCount: 5 }; } },
    });
    const { tools } = applyAgent(bundle.services);
    const injected = [];
    if (preset !== undefined) updatePanelState(id, preset);
    const call = (args = {}) => tools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {}, inject(message) { injected.push(message); } } });
    return { session, tools, call, injected, state: bundle.state };
  };

  // 1) continue：放行切换 + reminder + 模式保持 + phase 边界提醒
  const cont = make('session-panel-continue', { defaultOperation: 'continue' });
  const switched = await cont.call();
  assert.equal(switched.previous, 'discover');
  assert.equal(switched.phase, 'build');
  assert.equal(switched.band, 'organize');
  // phase 完成复查：跨 phase 响应全档带 budget 事实（organize 档「继续」放行路径也有）
  assert.equal(switched.budget.band, 'organize', '跨 phase 响应全档带 budget（continue 放行路径）');
  assert.equal(typeof switched.budget.headroomToOrganize, 'number');
  assert.match(switched.reminder, /继续/);
  assert.match(switched.summary, /面板模式=继续/);
  assert.equal(panelStateOf('session-panel-continue').defaultOperation, 'continue', '模式持久不消费（下一个到线仍按「继续」）');
  assert.equal(cont.injected.length, 1);
  assert.match(cont.injected[0].source.summary, /phase 边界/);
  assert.match(cont.injected[0].content[0].text, /phase 完成仍超线/);
  // 同 phase 重复声明不是「开新 phase」：不提醒、不动预设（退役自决字段写入被白名单丢弃）
  updatePanelState('session-panel-continue', { autoChoose: true, autoDecision: { operation: 'compress', at: 1 } });
  const same = await cont.call();
  assert.equal(same.phase, 'build');
  assert.equal(same.reminder, undefined);
  assert.equal(cont.injected.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('session-panel-continue'), 'autoChoose'), false);

  // 2) compress：不切换 + 抛错（指令先 organize 再重试）；模式持久：relay_phase 拒绝不改模式
  const compress = make('session-panel-compress', { defaultOperation: 'compress' });
  await assert.rejects(compress.call(), (error) => /relay_organize/.test(error.message) && /授权/.test(error.message));
  assert.equal(panelStateOf('session-panel-compress').defaultOperation, 'compress', 'relay_phase 拒绝不改模式（B-P2-3）');
  assert.equal(compress.injected.length, 0, '拒绝分支只 throw，不再重复注入 phase 边界 notice（错误必达）');
  // 抛错不算切换：后续 status 仍 discover（fallback derivePhase 按 isError 忽略）
  const status = await compress.tools.get('relay_status').execute({}, { agent: { session: compress.session, options: {} } });
  assert.equal(status.phase, 'discover');
  // organize 成功后模式保持（v0.4.0 持久）
  const organized = await compress.tools.get('relay_organize').execute({ phase: 'discover', brief: 'x' }, { agent: { session: compress.session, options: {}, inject() {} } });
  assert.equal(organized.organized, true, JSON.stringify(organized));
  assert.equal(panelStateOf('session-panel-compress').defaultOperation, 'compress', 'organize 成功后模式保持（仍按压缩继续）');

  // 3) handoff：不切换 + 不再自带预授权（rev5.5 正交模型）+ 抛错；B-P2-3：预设保留到接力成功
  const handoff = make('session-panel-handoff', { defaultOperation: 'handoff' });
  await assert.rejects(handoff.call(), (error) => /relay_handoff/.test(error.message) && /授权/.test(error.message));
  const panel = panelStateOf('session-panel-handoff');
  assert.equal(panel.defaultOperation, 'handoff', 'relay_phase 拒绝不改接力模式');
  assert.equal(panel.authorizeNext, false, '模式只决定操作，不产生授权');
  assert.equal(handoff.injected.length, 0, '拒绝分支只 throw（notice 不再同义双写）');

  // 4) 退役自决存档（autoChoose/autoDecision）被丢弃 → 等同「未设模式」（问人类），不切换
  const auto = make('session-panel-auto', { autoChoose: true, autoDecision: { operation: 'handoff', at: 1 } });
  assert.deepEqual(Object.keys(panelStateOf('session-panel-auto')).some((key) => key === 'autoChoose' || key === 'autoDecision'), false);
  await assert.rejects(auto.call(), (error) => /问人类/.test(error.message) && /composer 面板/.test(error.message));
  assert.equal(auto.injected.length, 0);

  // 5) 未设模式：不切换 + 抛错（问人类 / composer 面板选模式）
  const ask = make('session-panel-ask', {});
  await assert.rejects(ask.call(), (error) => /问人类/.test(error.message) && /composer 面板/.test(error.message));
  assert.equal(ask.injected.length, 0);

  // 预算内：无需面板，直接切换；不返回 band
  const okSession = fakeSession({ id: 'session-panel-ok', seq: 0 });
  const okTools = applyAgent(fakeServices({ session: okSession, pressure: { contextWindow: 1_000_000, projectedTokens: 20_000 } }).services).tools;
  const okSwitch = await okTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: { session: okSession, options: {} } });
  assert.equal(okSwitch.phase, 'verify');
  assert.equal(okSwitch.band, undefined);
});

test('v0.10.0 面板退役档归一：cth→null（问我）、自决字段整体丢弃', async () => {
  resetSharedState();
  const make = (id, preset) => {
    const session = fakeSession({ id, cwd: tmpCwd(), seq: 0 });
    const bundle = fakeServices({
      session,
      pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
      compaction: { async compactIfNeeded() { return { shadowedTokenCount: 5 }; } },
    });
    const { tools } = applyAgent(bundle.services);
    if (preset !== undefined) updatePanelState(id, preset);
    const injected = [];
    const call = (args = {}) => tools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {}, inject(message) { injected.push(message); } } });
    return { session, tools, call, injected };
  };

  // 1) 存量档「压缩→新会话」：面板归一 null（问我）——不再有隐藏档放行/两段式，超预算按「问人类」拒绝
  const cth = make('session-hidden-cth', { defaultOperation: 'compress-then-handoff' });
  assert.equal(panelStateOf('session-hidden-cth').defaultOperation, null, 'cth 归一 null（问我；D8=A）');
  await assert.rejects(cth.call(), (error) => /问人类/.test(error.message) && /composer 面板/.test(error.message));
  assert.equal(panelStateOf('session-hidden-cth').defaultOperation, null, '归一后保持 null');
  assert.equal(cth.injected.length, 0, '拒绝分支零副作用（不再注入边界 notice）');

  // 2) 退役自决存档：字段整体不进白名单（不保留为高级开关）
  const auto = make('session-hidden-auto', { autoChoose: true, autoDecision: { operation: 'handoff', at: 1 } });
  for (const key of ['autoChoose', 'autoDecision']) {
    assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('session-hidden-auto'), key), false, '退役字段不得出现：' + key);
  }
  await assert.rejects(auto.call(), (error) => /问人类/.test(error.message));

  // 3) 非隐藏档仍按原语义（「压缩」继续拒绝、预设保留）
  const compress = make('session-hidden-compress', { defaultOperation: 'compress' });
  await assert.rejects(compress.call(), /relay_organize/);
  assert.equal(panelStateOf('session-hidden-compress').defaultOperation, 'compress', '非隐藏档不消费');

  // 4) 侧栏默认值（未改过面板的会话）里的 cth 同样归一（normalizeSettings）：relay_phase 按「问我」
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff' };
  const settingsSession = fakeSession({ id: 'session-hidden-settings-cth', cwd: tmpCwd(), seq: 0 });
  const settingsTools = applyAgent(fakeServices({ session: settingsSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services).tools;
  assert.equal(panelStateOf(settingsSession.id).defaultOperation, null, 'settings 默认 cth 归一 null');
  await assert.rejects(settingsTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session: settingsSession, options: {} } }), /问人类/);

  // 5) v0.10.0：退役 config.routerMode 被静默忽略（无 warn）；仍按单一模式放行
  const legacySession = fakeSession({ id: 'session-hidden-router-off', cwd: tmpCwd(), seq: 0 });
  const legacy = applyAgent(fakeServices({ session: legacySession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services, { routerMode: false });
  updatePanelState('session-hidden-router-off', { defaultOperation: 'continue' });
  const legacySwitch = await legacy.tools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session: legacySession, options: {} } });
  assert.equal(legacySwitch.phase, 'build', '退役 config.routerMode 被忽略：仍按单一模式放行');
  assert.equal(legacy.logs.some((line) => /routerMode/.test(line)), false, '退役配置不再有专用 warn');
});

test('relay_phase is durable: derived from tool/call events after resume', async () => {
  resetSharedState();
  const log = [
    { type: 'tool/call', seq: 0, data: { callId: 'call-phase-1', name: 'relay_phase', arguments: JSON.stringify({ phase: 'build' }) } },
    { type: 'tool/result', seq: 1, data: { message: { toolCallId: 'call-phase-1', content: [{ type: 'text', text: '{"phase":"build"}' }] } } },
  ];
  const session = fakeSession({ seq: 2, log });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.phase, 'build');
  const switched = await tools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } });
  assert.equal(switched.phase, 'verify');
  assert.equal(switched.previous, 'build');
});

test('fallback derivePhase: isError 的 relay_phase 调用不算切换（phase 边界闸门抛错）', async () => {
  resetSharedState();
  const log = [
    { type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_phase', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: '{"phase":"build"}' }] } },
    { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'ship' }, isError: true, content: [{ type: 'text', text: 'relay_phase refused (band=organize)' }] } },
  ];
  const session = fakeSession({ id: 'session-phase-error', seq: 2, log });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.phase, 'build', 'failed (isError) relay_phase must not change the derived phase');
});

test('relay_organize below-threshold refusal is side-effect free (no doc_lint, no brief file)', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ cwd, seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_organize').execute({ phase: 'discover', brief: 'nothing yet' }, { agent: { session, options: {} } });
  assert.equal(result.organized, false);
  assert.match(result.summary, /not organized/);
  assert.equal(result.briefInjected, false);
  // P2#2 守卫前移：被拒路径零副作用——不跑 doc_lint（同步 git 子进程）、不写盘、不返回 lint/brief。
  assert.equal(result.docLint, undefined);
  assert.equal(result.briefPath, undefined);
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay')), false, 'refusal must not write a brief file');
});

test('relay_organize force calls compaction engine and reports freed tokens', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ cwd, seq: 0 });
  let called = null;
  const compaction = { async compactIfNeeded(agentCtx, trigger) { called = { agentCtx, trigger }; return { shadowedTokenCount: 1234 }; } };
  const { services } = fakeServices({ session, compaction });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'decided X', force: true }, { agent: { session, options: {} } });
  assert.equal(result.ok, true);
  assert.equal(result.freedTokens, 1234);
  assert.equal(called.trigger, 'context-overflow');
  assert.ok(result.docLint.level);
});

test('relay_organize writes chain index and injects chain recall section (compaction → recoverable)', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ cwd, seq: 0 });
  const compaction = { async compactIfNeeded() { return { compactionId: 'compact-1', shadowedTokenCount: 777, shadowedSeqs: [120, 130, 125] }; } };
  const { services } = fakeServices({ session, compaction });
  const { tools } = applyAgent(services);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'decided Y', force: true }, { agent });
  assert.equal(result.ok, true);
  assert.equal(result.compaction.compactionId, 'compact-1');
  assert.equal(result.compaction.shadowedStart, 120);
  assert.equal(result.compaction.shadowedEnd, 130);
  assert.equal(result.compaction.freedTokens, 777);
  assert.equal(result.chain.path, '.scratch/context-relay/chain.ndjson');
  assert.equal(result.chain.entries, 1);
  assert.equal(injected.length, 1);
  const notice = injected[0].content[0].text;
  assert.match(notice, /压缩与链式召回/);
  assert.match(notice, /session-test/);
  assert.match(notice, /seq 120–130/);
  assert.doesNotMatch(notice, /召回规则/, '召回纪律在常驻协议，注入段不重复');
  assert.match(notice, /chain\.ndjson/);
  assert.ok(existsSync(join(cwd, '.scratch', 'context-relay', 'chain.ndjson')));
  const briefText = readFileSync(result.briefPath, 'utf8');
  assert.match(briefText, /压缩与链式召回/, 'brief file and injected text stay in sync');
});

test('relay_organize injects manual recall pointers for shadowed instructions and skills (A+B)', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'agent-instructions', form: 'instructions', baseline: false, changes: [{ action: 'set', scope: 'pkg', path: 'pkg/AGENTS.md' }] }, content: [{ type: 'text', text: '<system-reminder>additional instructions</system-reminder>' }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'skill-invocation', form: 'instructions', name: 'code-review' }, content: [{ type: 'text', text: '<skill_content name="code-review">…' }] } },
    { seq: 3, type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '<skill_content name="tdd">…' }] } } },
    { seq: 4, type: 'tool/ptc-dispatch', data: { name: 'skill', isError: false, content: [{ type: 'text', text: '<skill_content name="browser-skill">…' }] } },
  ];
  const session = fakeSession({ id: 'session-organize-manual-recall', cwd, seq: log.length, log });
  const compaction = { async compactIfNeeded() { return { compactionId: 'compact-recall', shadowedTokenCount: 42, shadowedSeqs: [1, 2, 3, 4] }; } };
  const { services } = fakeServices({ session, compaction });
  const { tools } = applyAgent(services);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'decided Z', force: true }, { agent });
  assert.equal(result.ok, true);
  assert.equal(result.manualRecallInjected, true);
  const notice = injected[0].content[0].text;
  assert.match(notice, /压缩后手动召回/);
  assert.match(notice, /pkg\/AGENTS\.md/, 'shadowed additional AGENTS.md path is listed');
  assert.match(notice, /read 重新读取/, 'retrieval hint tells the model how to trigger re-injection');
  assert.match(notice, /code-review/, 'skill-invocation skill name is listed');
  assert.match(notice, /tdd/, 'skill tool result skill name is listed');
  assert.match(notice, /browser-skill/, 'PTC-dispatched skill result name is listed');
  assert.ok(notice.length <= 4000, 'injected text stays bounded');
  const briefText = readFileSync(result.briefPath, 'utf8');
  assert.match(briefText, /压缩后手动召回/, 'brief file keeps the recall section too');
});

test('long brief truncation keeps the chain recall section (P2-1)', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-long-brief', cwd, seq: 0 });
  // 让尾部同时带「链式召回 + 手动召回」两段，验证截断只切 brief 正文。
  session.snapshotEvents = () => [
    { seq: 1, type: 'user/message', data: { source: { kind: 'agent-instructions', form: 'instructions', baseline: false, changes: [{ action: 'set', scope: 'pkg', path: 'pkg/AGENTS.md' }] }, content: [] } },
  ];
  const compaction = { async compactIfNeeded() { return { compactionId: 'compact-long', shadowedTokenCount: 5, shadowedSeqs: [10, 20] }; } };
  const { services } = fakeServices({ session, compaction });
  const { tools } = applyAgent(services);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x'.repeat(6000), force: true }, { agent });
  assert.equal(result.ok, true);
  const notice = injected[0].content[0].text;
  assert.ok(notice.length <= 4000, 'injected notice stays <= 4000 chars, got ' + notice.length);
  assert.match(notice, /brief truncated/);
  assert.match(notice, /压缩与链式召回/, 'recall section survives truncation');
  assert.match(notice, /链式索引：\.scratch\/context-relay\/chain\.ndjson/, '召回段保留链式索引入口');
  assert.match(notice, /压缩后手动召回/, '手动召回段同样不被尾部截断切掉');
  assert.match(notice, /pkg\/AGENTS\.md/);
  const briefRaw = readFileSync(result.briefPath, 'utf8');
  assert.ok(briefRaw.length > 4000, 'brief file keeps the full text');
  assert.match(briefRaw, /压缩与链式召回/);
});

test('doc_lint tool returns a bounded summary and fails loudly', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  writeFileSync(join(cwd, 'AGENTS.md'), '已废弃的做法\n' + 'x'.repeat(5000));
  const session = fakeSession({ cwd, seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const result = await tools.get('doc_lint').execute({}, { agent: { session, options: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.level, 'FAIL');
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 2048);
  assert.match(result.text, /quota/);
  assert.match(result.text, /banned/);
  assert.equal(result.workspaceRoot, cwd);
});

test('reminders: 升线提醒（同档不重复），回退后再升线仍提醒；notice 形状不变', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-reminder-1', cwd });
  const { services, state } = fakeServices({ session });
  const { events, logs } = applyAgent(services);
  const listener = preStepListener(events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);

  await step(); // ok：不提醒（无 baseline 噪音）
  assert.equal(injected.length, 0);
  // 每个 pre-step 都发布面板实时状态
  assert.equal(liveStateOf(session.id).band, 'ok');
  assert.equal(liveStateOf(session.id).overBudget, false);

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 360_000 };
  await step(); // warn
  assert.equal(injected.length, 1);
  const message = injected[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'dsh-context-relay');
  assert.equal(message.source.plugin, undefined);
  assert.equal(message.source.form, 'notice');
  assert.ok(message.source.summary.length <= 120, 'summary chars ' + message.source.summary.length);
  assert.match(message.source.summary, /\[context-relay\] band=warn/);
  assert.match(message.content[0].text, /到线提醒（插件 notice，非用户发言）/);
  assert.match(message.content[0].text, /接力 chip/, 'notice explains the composer panel');
  assert.match(message.content[0].text, /phase 优先/, 'notice keeps the phase-first rule');
  assert.match(message.content[0].text, /不中途压缩\/接力/, 'notice keeps the no-mid-phase-compress rule');
  assert.match(message.content[0].text, /处理点在 phase 边界/, 'notice points action to the phase boundary');
  assert.doesNotMatch(message.content[0].text, /thresholds=/, '阈值不重复塞进 notice（协议/status 里有）');
  // 长度回归：Lead 到线提醒 ≤365 字符（原 749；v0.3.3 追加一行 relay_recommend 指引 ≈114 字符）
  assert.ok(message.content[0].text.length <= 365, 'Lead notice chars ' + message.content[0].text.length);
  assert.equal(liveStateOf(session.id).band, 'warn');
  assert.equal(liveStateOf(session.id).phase, 'discover');
  await step(); // 同档重复：不提醒
  assert.equal(injected.length, 1);

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step(); // organize
  assert.equal(injected.length, 2);
  assert.match(injected[1].source.summary, /band=organize/);
  assert.equal(liveStateOf(session.id).overBudget, true);
  await step();
  assert.equal(injected.length, 2);

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await step(); // relay
  assert.equal(injected.length, 3);
  await step();
  assert.equal(injected.length, 3);

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 300_000 };
  await step(); // 回退不提醒
  assert.equal(injected.length, 3);
  assert.equal(liveStateOf(session.id).band, 'ok');
  assert.ok(logs.some((line) => line.includes('[reminder] skip')), 'fall-back logged once');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 360_000 };
  await step(); // 回退后再升线：提醒（口径：升线就提醒，不是整会话每档一次）
  assert.equal(injected.length, 4);
  assert.match(injected[3].source.summary, /band=warn/);
});

test('面板变更提醒（v0.5.1）：人类改模式/授权后下一次 pre-step 注入一次；同签名不重复；与到线提醒同一步不双发', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-panel-change', cwd });
  const { services, state } = fakeServices({ session });
  const { events } = applyAgent(services);
  const listener = preStepListener(events);
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);

  await step(); // 首次见到：只记签名，不提醒
  assert.equal(injected.length, 0);

  updatePanelState(session.id, { defaultOperation: 'compress', autoCompress: true }, { source: 'agent' });
  await step();
  assert.equal(injected.length, 1, '面板变更 → 一次提醒');
  const text = injected[0].content[0].text;
  assert.match(text, /面板已更新/);
  assert.match(text, /模式=压缩 ·/);
  assert.match(text, /autoCompress=on/);
  assert.doesNotMatch(text, /autoChoose|autoDecision/, 'C10b：面板变更文案不再拼退役自决字段');
  assert.match(text, /压缩免审=on（autoCompress）/);
  assert.equal(injected[0].source.form, 'notice');
  assert.ok(injected[0].source.summary.length <= 120);

  await step();
  assert.equal(injected.length, 1, '同签名不重复提醒');

  // 到线提醒同一步已带全量面板状态：只发到线提醒，不额外发面板提醒。
  updatePanelState(session.id, { autoHandoff: true }, { source: 'agent' });
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 360_000 };
  await step();
  assert.equal(injected.length, 2, '升线 + 面板变更同一步只发到线提醒');
  assert.match(injected[1].content[0].text, /到线提醒（插件 notice，非用户发言）/);
  assert.match(injected[1].content[0].text, /autoHandoff=on/, '到线提醒本身带全量面板状态');
  await step();
  assert.equal(injected.length, 2, '被到线提醒覆盖的面板变更不得在下一步补发');
});

test('reminder listener registration is idempotent per ctx', async () => {
  resetSharedState();
  const session = fakeSession({ seq: 0 });
  const { services, state } = fakeServices({ session });
  const { ctx, events } = fakeCtx({ services });
  apply(ctx, {});
  apply(ctx, {});
  // v0.9.0 单一模式：teamTools 恒创建（reset applier）也会注册 agent/pre-step；
  // 原意「到线提醒不重复注册」按行为断言：重复 apply 后同一压力只注入一条 notice。
  const listeners = events.filter((event) => event.name === 'agent/pre-step').map((event) => event.listener);
  assert.ok(listeners.length >= 2, 'single mode registers team reset applier + sentinel');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 360_000 };
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  for (const listener of listeners) await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, '重复 apply 不重复注册到线提醒（sentinel 只注入一次）');
});

test('reminders: 模块重建靠持久 notice seed；同模块多实例共享 lastBand（不重复提醒）', async () => {
  resetSharedState();
  const prior = {
    type: 'user/message',
    seq: 1,
    data: {
      role: 'user',
      id: 'notice-1',
      content: [{ type: 'text', text: '[context-relay] 自动提醒（插件 notice，非用户发言）· band=organize · phase=build' }],
      source: { kind: 'dsh-context-relay', form: 'notice', summary: '[context-relay] band=organize · phase=build' },
    },
  };
  const session = fakeSession({ id: 'session-sentinel-reload', log: [prior] });
  const { services, state } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { events } = applyAgent(services); // 新实例（模拟热重载/模块重建）
  const listener = preStepListener(events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 430_000 };
  await listener({ agent }, async () => undefined);
  // 2026-11-01 phase 优先：持久 notice band=organize 只当 seed（同档不重复、无重启补催；nag 已删除）。
  assert.equal(injected.length, 0, 'persisted notice band=organize seeds lastBand: same band never repeats after module rebuild');
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 0, 'restart seed is not replayed');
  // 更高一档仍提醒：seed 只抑制同档。
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, 'a higher band still reminds after restart');
  assert.match(injected[0].source.summary, /band=relay/);
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, 'same higher band is not repeated');

  // 共享 Map 也跨实例：A 实例提醒过的 warn，B 实例不再弹
  const fresh = fakeSession({ id: 'session-sentinel-shared', log: [] });
  const { services: servicesA, state: stateA } = fakeServices({ session: fresh, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const agentA = { session: fresh, inject() {} };
  await preStepListener(applyAgent(servicesA).events)({ agent: agentA }, async () => undefined);
  const { services: servicesB } = fakeServices({ session: fresh, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const injectedB = [];
  const agentB = { session: fresh, inject(message) { injectedB.push(message); } };
  await preStepListener(applyAgent(servicesB).events)({ agent: agentB }, async () => undefined);
  assert.equal(injectedB.length, 0, 'shared fired map suppresses duplicate warn');
  assert.ok(stateA.pressure.projectedTokens > 0);
});

test('reminders: 3 consecutive pre-steps inject once; cross bands once; subagent wording branches', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const lead = fakeSession({ id: 'session-sentinel-3x', cwd });
  const { services, state } = fakeServices({ session: lead, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const listener = preStepListener(applyAgent(services).events);
  const injected = [];
  const agent = { session: lead, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);

  await step();
  await step();
  await step();
  assert.equal(injected.length, 1, '3 consecutive pre-steps in one band -> exactly one inject');
  // Lead 文案保留：到线提醒 + 面板状态 + phase 优先指引（细节指向常驻协议）
  assert.match(injected[0].content[0].text, /到线提醒（插件 notice，非用户发言）/);
  assert.match(injected[0].content[0].text, /接力 chip/);
  assert.match(injected[0].content[0].text, /phase 优先/);

  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step();
  await step();
  assert.equal(injected.length, 2, 'cross to organize -> once');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await step();
  await step();
  assert.equal(injected.length, 3, 'cross to relay -> once');

  // subagent（队友）会话：origin:'subagent' → 队友版文案，不得出现 Lead 的 relay/问人指令
  resetSharedState();
  const sub = fakeSession({ id: 'session-sentinel-subagent', header: { cwd, origin: 'subagent' } });
  const subServices = fakeServices({ session: sub, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const subInjected = [];
  await preStepListener(applyAgent(subServices.services).events)({ agent: { session: sub, inject(message) { subInjected.push(message); } } }, async () => undefined);
  assert.equal(subInjected.length, 1);
  const text = subInjected[0].content[0].text;
  assert.match(text, /^\[context-relay\] band=organize/);
  assert.match(text, /队友会话·到线请示/);
  assert.match(text, /向上一级（Lead \/ 父 agent）请示/, 'no Team service -> tell it to send_message upward');
  assert.match(text, /回执 Lead/);
  assert.match(text, /relay_organize/);
  assert.match(text, /不自行 relay_organize\/relay_handoff/);
  assert.match(text, /不向人类提问/);
  assert.ok(!text.includes('向人类要一次 Go/No-go'), 'subagent must not be told to ask the human');
  assert.match(subInjected[0].source.summary, /队友会话到线请示/);
  assert.ok(subInjected[0].source.summary.length <= 120);

  // delegationDepth>0 是同一事实的持久化兜底
  const depth = fakeSession({ id: 'session-sentinel-depth', header: { cwd, delegationDepth: 1 } });
  const depthServices = fakeServices({ session: depth, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const depthInjected = [];
  await preStepListener(applyAgent(depthServices.services).events)({ agent: { session: depth, inject(message) { depthInjected.push(message); } } }, async () => undefined);
  assert.match(depthInjected[0].content[0].text, /队友会话·到线请示/);
});

test('reminders: 队友到线自动向 Lead 请示压缩/交接，只发一次', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-escalate', header: { cwd, origin: 'subagent' } });
  const sent = [];
  const { services } = fakeServices({
    session: sub,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    extra: {
      agentTeams: {
        tryMembership: () => ({ role: 'teammate', name: 'panel-agent' }),
        sendMessage: async (caller, request) => { sent.push({ caller, request }); },
        listMembers: () => [],
      },
    },
  });
  const injected = [];
  const agent = { session: sub, inject(message) { injected.push(message); } };
  const listener = preStepListener(applyAgent(services).events);
  await listener({ agent }, async () => undefined);
  await listener({ agent }, async () => undefined);
  assert.equal(sent.length, 1, 'same band -> escalate once');
  assert.equal(sent[0].request.target, 'lead');
  const message = sent[0].request.content[0].text;
  assert.match(message, /队友到线请示/);
  assert.match(message, /band=organize/);
  assert.match(message, /relay_handoff/, 'Lead must be told it can hand off');
  assert.match(injected[0].content[0].text, /已自动向上一级（Lead）发出请示/);
});

test('reminders: 队友 warn 档只本地提示、不 escalation（减少 Lead 收件箱噪音）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-escalate-warn', header: { cwd, origin: 'subagent' } });
  const sent = [];
  const { services } = fakeServices({
    session: sub,
    pressure: { contextWindow: 1_000_000, projectedTokens: 370_000 },
    extra: {
      agentTeams: {
        tryMembership: () => ({ role: 'teammate', name: 'panel-agent' }),
        sendMessage: async (caller, request) => { sent.push({ caller, request }); },
        listMembers: () => [],
      },
    },
  });
  const injected = [];
  const agent = { session: sub, inject(message) { injected.push(message); } };
  const listener = preStepListener(applyAgent(services).events);
  await listener({ agent }, async () => undefined);
  await listener({ agent }, async () => undefined);
  assert.equal(sent.length, 0, 'warn 不 escalation');
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /队友到 warn/);
  assert.match(injected[0].content[0].text, /relay_checkpoint/);
});

test('relay_phase: 队友会话超预算不消费面板预设、不问人类，改为向上级请示', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-phase-teammate', header: { cwd, origin: 'subagent' } });
  const sent = [];
  const bundle = fakeServices({
    session: sub,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    extra: {
      agentTeams: {
        tryMembership: () => ({ role: 'teammate', name: 'panel-agent' }),
        sendMessage: async (caller, request) => { sent.push({ caller, request }); },
        listMembers: () => [],
      },
    },
  });
  const { tools } = applyAgent(bundle.services);
  updatePanelState(sub.id, { defaultOperation: 'compress' });
  const injected = [];
  await assert.rejects(
    tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session: sub, options: {}, inject(message) { injected.push(message); } } }),
    (error) => /teammate session/.test(error.message) && /队友会话不自行切 phase/.test(error.message) && /Lead/.test(error.message),
  );
  assert.equal(panelStateOf(sub.id).defaultOperation, 'compress', '侧栏/面板预设不被队友会话消费');
  assert.equal(sent.length, 1, 'escalation sent to Lead');
  assert.equal(injected.length, 0, '拒绝分支只 throw（escalation 走 send_message），不重复注入 notice');
  const status = await tools.get('relay_status').execute({}, { agent: { session: sub, options: {} } });
  assert.equal(status.phase, 'discover', '抛错不算切换');
});

test('relay_handoff requires human approval and records nothing on refusal', async () => {
  resetSharedState();
  const session = fakeSession({ cwd: tmpCwd(), seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const refused = await tools.get('relay_handoff').execute({ status: { goal: 'x' } }, { agent: { session, options: {} } });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /human approval required|refused/);
});

test('relay_handoff creates a new root session, bounded handoff, and records it for M3', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-caller', cwd, seq: 0 });
  const created = [];
  const followed = [];
  const cleanupCalls = { killedJobs: [], retargetedSchedules: [], scheduleListRequests: [], createCalls: [], deleteCalls: [], teammateInterrupts: [], subagentInterrupts: [], drained: [], drainedDescendants: [], order: [] };
  const liveSession = { id: 'session-new', header: { cwd }, requestHeader: () => undefined };
  // rc.2 ScheduleCatalogEntry 形状：record + target/involvedSessionIds/status（dsh-schedule types.d.ts:394-417）。
  const scheduleTasks = () => [
    { id: 'sched-old', kind: 'every', title: 'check build', prompt: 'check the build', everySeconds: 300, scheduledAt: '2026-11-01T15:00:00.000Z', target: { kind: 'session', sessionId: 'session-caller' }, involvedSessionIds: ['session-caller'], status: 'active' },
    { id: 'sched-once', kind: 'at', title: 'review PR', prompt: 'review the pr', scheduledAt: '2026-11-01T15:30:00.000Z', target: { kind: 'session', sessionId: 'session-caller' }, involvedSessionIds: ['session-caller'], status: 'active' },
    { id: 'sched-mate', kind: 'cron', title: 'mate cron', prompt: 'mate cron prompt', expression: '*/5 * * * *', timeZone: 'UTC', scheduledAt: '2026-11-01T16:00:00.000Z', target: { kind: 'session', sessionId: 'teammate-1' }, involvedSessionIds: ['teammate-1'], status: 'active' },
  ];
  const { services } = fakeServices({
    session,
    extra: {
      jobs: {
        // 真实契约：list(owner) 也返回 unowned jobs（owner 缺省、任何 caller 可见）——插件必须过滤，不能误杀。
        list: (owner) => {
          const owned = {
            'session-caller': [
              { id: 'bash-old', kind: 'bash', label: 'dev server', status: 'running', owner: 'session-caller' },
              { id: 'bash-done', kind: 'bash', label: 'finished', status: 'completed', owner: 'session-caller' },
            ],
            'teammate-1': [{ id: 'bash-mate', kind: 'bash', label: 'mate job', status: 'running', owner: 'teammate-1' }],
            'child-1': [{ id: 'bash-child', kind: 'bash', label: 'child job', status: 'running', owner: 'child-1' }],
            'child-broken': [{ id: 'bash-broken', kind: 'bash', label: 'broken child job', status: 'running', owner: 'child-broken' }],
          }[owner] ?? [];
          return [...owned, { id: 'job-global', kind: 'bash', label: 'host-wide unowned', status: 'running' }];
        },
        kill: (...args) => { cleanupCalls.killedJobs.push(args); cleanupCalls.order.push('job-kill'); },
      },
      schedule: {
        // rc.2 Host-wide API：list() 返回分页对象；归属看 entry.target.sessionId（队友名下也按会话 id 归属）。
        list: async (request = {}) => {
          cleanupCalls.scheduleListRequests.push({ ...request });
          const items = scheduleTasks();
          return { items, shown: items.length, total: items.length, limit: request.limit ?? 100, offset: request.offset ?? 0 };
        },
        // 迁移 = edit 改投递目标（保留规则与投递史）；不 create/delete 新副本。
        edit: async (request) => {
          cleanupCalls.retargetedSchedules.push(request);
          cleanupCalls.order.push('schedule-transfer');
          const task = scheduleTasks().find((entry) => entry.id === request.id);
          return { ...task, target: { kind: 'session', sessionId: request.patch.target.sessionId } };
        },
        create: async (...args) => { cleanupCalls.createCalls.push(args); throw new Error('rc.2 cleanup must not recreate schedules'); },
        delete: async (...args) => { cleanupCalls.deleteCalls.push(args); throw new Error('rc.2 cleanup must not delete schedules'); },
      },
      subagents: {
        rootOf: () => ({ session: { id: 'session-caller' } }),
        namesOf: (caller) => ({ self: caller?.session?.id === 'session-caller' ? 'lead' : caller?.session?.id }),
        listDescendants: async () => [
          { kind: 'child', id: 'child-1', mode: 'one-shot', activity: 'running', parentId: 'session-caller', depth: 1, path: 'child' },
          { kind: 'child', id: 'teammate-1', mode: 'continuable', activity: 'running', parentId: 'session-caller', depth: 1, path: 'reviewer' },
          { kind: 'child', id: 'child-broken', mode: 'one-shot', activity: 'idle', parentId: 'session-caller', depth: 1, path: 'broken' },
        ],
        interrupt: (id, authority) => { cleanupCalls.subagentInterrupts.push({ id, authority }); cleanupCalls.order.push('subagent-interrupt'); },
        drainDescendants: async (parents) => { cleanupCalls.drainedDescendants.push(parents.map((parent) => parent.session.id)); cleanupCalls.order.push('drain-descendants'); },
      },
      sessionController: {
        async create(request) { created.push(request); return { sessionId: 'session-new' }; },
      },
      agents: {
        get: (id) => (id === 'teammate-1' || id === 'child-1' ? { status: 'running' } : undefined),
        list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); } }],
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({
    status: {
      phase: 'build',
      goal: 'ship the relay plugin',
      success_criteria: ['preset roster shows relay'],
      done: ['ratio thresholds landed'],
      next_actions: ['inject and try a phase'],
      blocked: ['P0: UI auto-switch approval'],
    },
    evidence: ['dsh-plugins/dsh-context-relay/lib/agent.js'],
    decisions: ['use official compaction'],
    constraints: ['no kernel patch'],
    open_questions: ['P1: auto switch UI?'],
    risks: ['busy compaction'],
    discarded: ['old tool outputs'],
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  // E2E（2026-11-01 真机）发现：summary 尾部 `+ +` 一元加号把收尾提示算成 NaN
  assert.match(result.summary, /open it from the session list to continue\. Old session is kept as audit archive\./);
  assert.ok(!result.summary.includes('NaN'), 'summary 不得出现 NaN');
  assert.equal(result.createdVia, 'sessionController.create');
  assert.equal(created[0].agentPreset, 'relay');
  assert.equal(created[0].cwd, cwd);
  assert.equal(result.sessionId, 'session-new');
  assert.equal(followed.length, 1, '只发 handoff 首条消息；清理结果不再另发给新会话（2026-11-01 用户要求）');
  const text = followed[0].content[0].text;
  assert.match(text, /# Handoff · ship the relay plugin/);
  assert.match(text, /## 首条指令/);
  assert.match(text, /## 未决问题/);
  assert.match(text, /doc_lint:/); // 自动附一条 doc_lint 结论
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit);
  assert.equal(result.caps.items.evidence.used, 2); // 1 条 doc_lint + 1 条传入
  assert.match(result.handoffPath, /handoff-\d+\.md$/);
  // 交接清理（2026-11-01 用户需求）：后台任务取消、定时任务迁移、队友/子智能体中断并交给新会话
  assert.deepEqual([...cleanupCalls.killedJobs].sort((a, b) => a[0].localeCompare(b[0])), [
    ['bash-broken', 'child-broken', 'relay handoff: moved to new session'],
    ['bash-child', 'child-1', 'relay handoff: moved to new session'],
    ['bash-mate', 'teammate-1', 'relay handoff: moved to new session'],
    ['bash-old', 'session-caller', 'relay handoff: moved to new session'],
  ], '取消旧会话树（Lead/队友/子智能体/诊断子级）名下运行中的后台任务（归属不能跨会话转移）');
  assert.ok(result.handover.inventory.jobs.some((job) => job.id === 'bash-broken'), 'diagnostic 行的子会话 id 也参与 owner 枚举/清理');
  // unowned job 对任何 caller 可见：不得被当作旧会话残留误杀/误记（P1）
  assert.ok(cleanupCalls.killedJobs.every(([id]) => id !== 'job-global'), 'unowned job 不能杀');
  assert.ok(!result.handover.inventory.jobs.some((job) => job.id === 'job-global'), 'unowned job 不进盘点');
  // rc.2 定时任务是 Host-wide：list 分页取全量，按 target.sessionId 归属旧会话树（含队友名下），
  // cleanup 用 edit 改投递目标（规则/投递史保留）——不重建、不删除源任务。
  assert.deepEqual(cleanupCalls.scheduleListRequests, [{ limit: 500, offset: 0 }], 'rc.2 list 显式分页参数（一次取全量）');
  assert.equal(cleanupCalls.retargetedSchedules.length, 3, '定时任务迁移到新会话（Lead 2 + 队友 1）');
  assert.deepEqual(cleanupCalls.retargetedSchedules, [
    { id: 'sched-old', action: 'update', patch: { target: { kind: 'session', sessionId: 'session-new' } } },
    { id: 'sched-once', action: 'update', patch: { target: { kind: 'session', sessionId: 'session-new' } } },
    { id: 'sched-mate', action: 'update', patch: { target: { kind: 'session', sessionId: 'session-new' } } },
  ], 'cleanup 只把投递目标改到新会话（同一 id，保留规则与投递史）');
  assert.deepEqual(cleanupCalls.createCalls, [], 'rc.2 cleanup 不重建定时任务');
  assert.deepEqual(cleanupCalls.deleteCalls, [], 'rc.2 cleanup 不删除源定时任务');
  assert.deepEqual(cleanupCalls.subagentInterrupts.map((entry) => entry.id), ['teammate-1', 'child-1'], '先中断队友、再中断驻留子智能体（队友不重复中断）');
  assert.equal(cleanupCalls.subagentInterrupts[0].authority.kind, 'ancestor', 'DSH 契约：interrupt authority 必须是 {kind:"ancestor",agent}');
  assert.equal(cleanupCalls.subagentInterrupts[0].authority.agent.session.id, 'session-caller');
  assert.deepEqual(cleanupCalls.drainedDescendants, [['session-caller']], 'drainDescendants 覆盖 materializing/深层子级');
  // 清理顺序（用户要求「尤其清理顺序」）：先中断成员，再 drain，再取消后台任务，最后迁移定时任务。
  const orderIndex = (tag) => cleanupCalls.order.indexOf(tag);
  assert.ok(orderIndex('subagent-interrupt') >= 0, '先中断成员');
  assert.ok(orderIndex('drain-descendants') < orderIndex('job-kill'), '先 drain 成员再取消后台任务');
  assert.ok(orderIndex('job-kill') < orderIndex('schedule-transfer'), '先取消后台任务再迁移定时任务');
  assert.equal(result.handover.cleanup.jobs[0].action, 'killed');
  assert.equal(result.handover.cleanup.schedules[0].action, 'transferred');
  assert.equal(result.handover.cleanup.teammates[0].action, 'interrupted');
  assert.equal(result.handover.cleanup.subagents[0].action, 'interrupted');
  assert.deepEqual(result.handover.inventory.subagents.map((entry) => entry.id), ['child-1', 'child-broken'], '队友不计入子智能体盘点（去重）');
  // 正常完整盘点不包含 diagnostic；诊断失败的零副作用分支单独覆盖。
  assert.equal(result.handover.inventory.errors.length, 0);
  assert.equal(result.handover.cleanup.errors.length, 0);
  assert.equal(result.handover.inventory.schedules.filter((item) => item.owner === 'teammate-1').length, 1, '盘点按 owner 枚举队友定时任务');
  assert.match(text, /旧会话残留-定时任务 3 条/, '交接清单随 handoff 首条消息交给新会话');
  assert.match(text, /旧会话残留-后台任务 4 个/);
  assert.equal(result.handover.inventory.jobs.length, 4, '盘点含队友/子智能体/诊断子级名下任务');
  assert.equal(result.hint, undefined, '未截断不返回 hint（不打扰正常路径）');
  // next_actions cap（8）：清单追加在用户工作之后（用户条目先出现），完整清单由 handoff 文件/工具返回 handover 兜底
  const userIdx = text.indexOf('下一步（DoD）：inject and try a phase');
  const inventoryIdx = text.indexOf('旧会话残留-后台任务');
  assert.ok(userIdx >= 0 && inventoryIdx > userIdx, '用户 next_actions 排在自动清单之前');
  // 2026-11-01 用户要求：清理结果只落 handoff 文件 + 工具返回，不再作为第二条消息发给新会话。
  assert.ok(!followed.some((message) => /交接清理结果/.test(JSON.stringify(message))), '新会话消息里没有清理报告');
  // summary 用清理结果计数（不是仅盘点数）
  assert.match(result.summary, /后台任务 4→4 已取消/);
  assert.match(result.summary, /定时任务 3→3 已迁移/);
  assert.match(result.summary, /队友 1→1 已中断/);
  assert.match(result.summary, /子智能体 2→1 已中断/);
  // handoff 文件追加交接清单 + 清理结果（首条消息有 handoffPath 指路）
  const handoffFile = readFileSync(result.handoffPath, 'utf8');
  assert.match(handoffFile, /## 交接清单（旧会话残留，自动盘点）/);
  assert.match(handoffFile, /## 交接清理结果/);
  assert.match(handoffFile, /bash-old → killed/, '清理结果逐行细节仍落在 handoff 文件（不再发给新会话）');
  assert.match(text, /## 完整交接单（全部细节）/, '首条消息给出完整交接单路径');
  // 接手入口（progress.md 长线状态 + chain.ndjson 召回索引合并为一段）：首条消息给两个路径
  assert.match(text, /## 接手入口/);
  assert.match(text, /progress\.md/);
  assert.match(text, /chain\.ndjson/);
  // handoff 条目已写入（旧会话 id → 新会话 id）

  const chainRaw = readFileSync(join(cwd, '.scratch', 'context-relay', 'chain.ndjson'), 'utf8');
  assert.match(chainRaw, /"kind":"handoff"/);
  assert.match(chainRaw, /"childSessionId":"session-new"/);
  assert.equal(result.progress.updated, true, JSON.stringify(result.progress));
  assert.equal(result.progress.path, '.scratch/context-relay/progress.md');
  const progressRaw = readFileSync(join(cwd, '.scratch', 'context-relay', 'progress.md'), 'utf8');
  assert.match(progressRaw, /持有会话：session-new/);
  assert.match(progressRaw, /## 交接时间线/);
  const { parseProgress } = await import('../lib/agent/progress.js');
  const progressState = parseProgress(progressRaw);
  assert.equal(progressState.holder, 'session-new');
  assert.equal(progressState.timeline.length, 1);
  assert.equal(progressState.updates, 1);
  assert.equal(progressState.goal, 'ship the relay plugin');
  // boundedHandover：>20 截断 + truncated 标记；cleanup=null 路径也不能丢标记（P3）
  const { boundedHandover } = await import('../lib/agent/handoff.js');
  const oversized = { jobs: Array.from({ length: 25 }, (_, index) => ({ id: 'j' + index })), schedules: [], teammates: [], subagents: [], errors: [] };
  const capped = boundedHandover(oversized, null);
  assert.equal(capped.inventory.jobs.length, 20);
  assert.equal(capped.truncated, true, 'cleanup=null 也不能丢 truncated');
  assert.equal(capped.cleanup, null);
});

test('relay_handoff 交接清理：drain 结算的子智能体后台任务不静默漏报（2026-11-01 审查 P1 / 真机 E2E 发现）', async () => {
  resetSharedState();
  const drained = { value: false };
  const jobs = {
    list: () => {
      const rows = [{ id: 'bash-lead', kind: 'bash', label: 'lead job', status: 'running', owner: 'session-drain-old' }];
      if (!drained.value) rows.push({ id: 'bash-child', kind: 'bash', label: 'child job', status: 'running', owner: 'child-1' });
      // 真实契约：list(owner) 也返回 unowned jobs —— 插件必须过滤，不能误杀。
      return [...rows, { id: 'job-global', kind: 'bash', label: 'unowned', status: 'running' }];
    },
    // 真实内核语义：子智能体被 drain 时其名下任务随 owner teardown 结算，kill 返回 already-finished。
    kill: (id) => (id === 'bash-child' ? 'already-finished' : 'requested'),
  };
  const subagents = {
    listDescendants: async () => [{ kind: 'child', id: 'child-1', mode: 'continuable', activity: 'running', depth: 1 }],
    // 真实 API：listChildren 返回 SubagentCatalogEntry（无 kind/activity 字段）。
    listChildren: async () => [{ id: 'child-1', createdAt: 0, mode: 'continuable', label: 'child' }],
    interrupt: () => {},
    drainChildren: async () => { drained.value = true; },
    drainDescendants: async () => { drained.value = true; },
  };
  const schedule = { list: async () => [], create: async () => ({ id: 'sched-new' }), delete: async () => ({ deleted: true }) };
  const h = handoffPanelHarness({ oldId: 'session-drain-old', newId: 'session-drain-new', extraServices: { jobs, subagents, schedule } });
  const result = await h.handoff('drain settle');
  assert.equal(result.ok, true, JSON.stringify(result));
  const rows = result.handover.cleanup.jobs;
  assert.ok(rows.some((row) => row.id === 'bash-child' && row.action === 'cancelled-with-owner'), 'drain 结算的任务要报 cancelled-with-owner：' + JSON.stringify(rows));
  assert.ok(rows.some((row) => row.id === 'bash-lead' && row.action === 'killed'));
  assert.ok(!rows.some((row) => row.id === 'job-global'), 'unowned job 不能误杀');
  assert.equal(result.handover.inventory.jobs.length, 2, '盘点仍包含子智能体任务');
  assert.match(result.summary, /后台任务 2→2 已取消/, result.summary);
  resetSharedState();
});

test('relay_handoff 交接清理：服务未启用时按 N/A 跳过（不假报 errors、不假干净）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-clean-missing-old', newId: 'session-clean-missing-new', extraServices: { jobs: undefined, schedule: undefined, agentTeams: undefined, subagents: undefined } });
  const result = await h.handoff('no cleanup services');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.handover.inventory.jobs, []);
  assert.deepEqual(result.handover.inventory.schedules, []);
  assert.deepEqual(result.handover.cleanup.errors, [], '服务未启用的类别不算错误（N/A），也不伪造清理记录');
  assert.ok(!result.summary.includes('NaN'), 'summary 不得出现 NaN（cleanup=null 路径）');
  // 不假干净（2026-11-01 审查 P1）：服务缺失写 N/A，不是「无/0」，且 summary/报告/清单三处一致。
  for (const key of ['jobs', 'schedule', 'teammates', 'subagents']) {
    assert.ok(result.handover.inventory.skipped.includes(key), 'inventory.skipped 含 ' + key);
    assert.ok(result.handover.cleanup.skipped.includes(key), 'cleanup.skipped 含 ' + key);
  }
  assert.match(result.summary, /N\/A/, 'summary 标注 N/A：' + result.summary);
  // 2026-11-01 用户要求：清理结果不再发给新会话（只追加 handoff 文件 + 工具返回）。
  assert.equal(h.followed.length, 1, '新会话只收 handoff 首条消息');
  const cleanupText = readFileSync(result.handoffPath, 'utf8');
  assert.match(cleanupText, /后台任务：N\/A/);
  assert.match(cleanupText, /定时任务：N\/A/);
  assert.match(cleanupText, /队友：N\/A/);
  assert.match(cleanupText, /子智能体：N\/A/);
  // 模型漏填 next_actions 时宿主补一条兜底提示，不静默交接空清单
  assert.match(h.followed[0].content[0].text, /未提供 next_actions（模型未记录未完成工作）/);
});

test('relay_handoff 交接预检：盘点失败零副作用；不 dispatch/清旧活', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-fail-caller', cwd, seq: 0 });
  const followed = [];
  const created = [];
  const removed = [];
  const liveSession = { id: 'session-fail-new', header: { cwd }, requestHeader: () => undefined };
  const { services } = fakeServices({
    session,
    extra: {
      jobs: {
        list: (owner) => (owner === 'session-fail-caller' ? [{ id: 'bash-fail', kind: 'bash', label: 'x', status: 'running', owner: 'session-fail-caller' }] : []),
        kill: () => { throw new Error('kill boom'); },
      },
      schedule: {
        list: async () => [
          { id: 'sched-create-fail', kind: 'cron', title: 'fail create', prompt: 'p', expression: '* * * * *', timeZone: 'UTC', scheduledAt: '2026-11-02T00:00:00.000Z' },
          { id: 'sched-delete-fail', kind: 'daily', title: 'fail delete', prompt: 'p2', time: '09:00:00', timeZone: 'UTC', scheduledAt: '2026-11-02T01:00:00.000Z' },
          { id: 'sched-rollback-fail', kind: 'weekly', title: 'fail rollback', prompt: 'p3', time: '09:00:00', timeZone: 'UTC', weekdays: [1], scheduledAt: '2026-11-02T02:00:00.000Z' },
        ],
        create: async (sessionId, request) => {
          if (request.title === 'fail create') throw new Error('create boom');
          created.push([sessionId, request]);
          return { id: 'new-sched-' + created.length };
        },
        delete: async (request) => {
          if (request.id === 'sched-delete-fail') throw new Error('delete boom');
          if (request.id === 'sched-rollback-fail') throw new Error('delete boom (rollback case)');
          // 回滚删除新行也可能失败：必须记 errors，不能静默双份
          if (request.id === 'new-sched-2') throw new Error('rollback boom');
          removed.push(request);
          return { deleted: true };
        },
      },
      subagents: { listDescendants: async () => { throw new Error('descendants boom'); } },
      sessionController: { async create() { return { sessionId: 'session-fail-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); } }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'partial cleanup failure' } }, { agent: { session, options: {} } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'handoff-preflight-failed');
  assert.equal(result.takeover, undefined);
  assert.equal(followed.length, 0);
  assert.equal(result.handoffPath, undefined);
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
  assert.match(JSON.stringify(result.recovery), /descendants boom/);
  assert.equal(panelStateOf(session.id).handedOff, false);
  assert.match(result.summary, /Preflight failed/);

});

test('relay_handoff inherits caller model route and permission onto the new session', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const callerSession = fakeSession({
    id: 'session-inherit-caller',
    cwd,
    seq: 0,
    requestHeader: () => ({
      config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 300000 },
      adapterDefaults: { maxTokens: false },
    }),
  });
  const permissionCalls = [];
  const followed = [];
  const childSession = { id: 'session-inherit-child', header: { cwd }, requestHeader: () => undefined };
  const liveAgent = { session: childSession, status: 'idle', followup(message) { followed.push(message); } };
  const { services } = fakeServices({
    session: callerSession,
    extra: {
      sessionController: { async create() { return { sessionId: childSession.id }; } },
      agents: { list: () => [liveAgent] },
      permissionPresets: {
        permissionState: () => ({ preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }),
        current: () => 'workspace-write',
        set(session, name) { permissionCalls.push([session, name]); },
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({ status: { goal: 'inherit me' }, human_approved: true }, { agent: { session: callerSession, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.inherited.model, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 300000 });
  assert.deepEqual(result.inherited.permission, { preset: 'workspace-write' });
  assert.equal(permissionCalls.length, 1);
  assert.equal(permissionCalls[0][0], childSession);
  assert.equal(permissionCalls[0][1], 'workspace-write');
  assert.equal(followed.length, 1, '只发 handoff 首条消息（清理结果不再另发）');

  // 子会话 relay preset 的 agent/request 监听：首个请求套用旧会话路由，消费一次即失效
  const child = applyAgent(fakeServices({ session: childSession }));
  const request = child.events.find((event) => event.name === 'agent/request');
  assert.ok(request !== undefined, 'agent/request listener registered');
  const base = { provider: 'deployment-default', model: 'deployment-default' };
  const first = await request.listener({ agent: { session: childSession } }, async () => base);
  assert.deepEqual(first, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 300000 });
  const second = await request.listener({ agent: { session: childSession } }, async () => base);
  assert.deepEqual(second, base, 'route applies only once');
});

test('relay_handoff inherits a custom permission bundle by appending knob events', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const callerSession = fakeSession({ id: 'session-inherit-custom-caller', cwd, seq: 0, requestHeader: () => undefined });
  const appended = [];
  const childSession = {
    id: 'session-inherit-custom-child',
    header: { cwd },
    requestHeader: () => undefined,
    append(type, data) { appended.push([type, data]); },
  };
  const liveAgent = { session: childSession, status: 'idle', followup() {} };
  const { services } = fakeServices({
    session: callerSession,
    extra: {
      sessionController: { async create() { return { sessionId: childSession.id }; } },
      agents: { list: () => [liveAgent] },
      permissionPresets: {
        permissionState: () => ({ preset: null, sandbox: 'danger-full-access', approval: 'never' }),
        current: () => 'custom',
        set() { throw new Error('must not use set() for custom'); },
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({ status: { goal: 'custom inherit' }, human_approved: true }, { agent: { session: callerSession, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.inherited.permission, { preset: null, sandbox: 'danger-full-access', approval: 'never' });
  assert.deepEqual(appended.map(([type]) => type), ['sandbox/mode', 'approval/policy']);
  assert.equal(appended[0][1].mode, 'danger-full-access');
  assert.equal(appended[1][1].policy, 'never');
});

test('relay_handoff inheritOnHandoff=false leaves the new session on deployment defaults', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const callerSession = fakeSession({ id: 'session-noinherit-caller', cwd, seq: 0 });
  const permissionCalls = [];
  const childSession = { id: 'session-noinherit-child', header: { cwd }, requestHeader: () => undefined };
  const liveAgent = { session: childSession, status: 'idle', followup() {} };
  const { services } = fakeServices({
    session: callerSession,
    extra: {
      sessionController: { async create() { return { sessionId: childSession.id }; } },
      agents: { list: () => [liveAgent] },
      permissionPresets: {
        permissionState: () => ({ preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }),
        current: () => 'workspace-write',
        set(session, name) { permissionCalls.push([session, name]); },
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services, { inheritOnHandoff: false });
  const result = await tools.get('relay_handoff').execute({ status: { goal: 'no inherit' }, human_approved: true }, { agent: { session: callerSession, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.inherited, undefined);
  assert.equal(permissionCalls.length, 0);
  const child = applyAgent(fakeServices({ session: childSession }));
  const request = child.events.find((event) => event.name === 'agent/request');
  const base = { provider: 'deployment-default', model: 'deployment-default' };
  assert.deepEqual(await request.listener({ agent: { session: childSession } }, async () => base), base);
});

test('relay_handoff：超大 evidence 不再拒绝——摘要 advisory 收短、完整文件含全部原文', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ cwd, seq: 0 });
  const created = [];
  const followed = [];
  const newSession = { id: 'pending', requestHeader: () => undefined };
  const { services } = fakeServices({
    session,
    extra: {
      agents: {
        async create(options) {
          created.push(options);
          return { agent: { session: newSession, followup(message) { followed.push(message); } }, async dispose() {} };
        },
      },
      agentPresets: { async mount(agentCtx, id) { agentCtx.mounted = id; } },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const oversized = Array.from({ length: 20 }, (_, index) => 'e' + index + '-' + 'x'.repeat(300));
  const result = await tools.get('relay_handoff').execute({
    status: { goal: 'bounded handoff', phase: 'verify' },
    evidence: oversized,
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.code, undefined, '不再有 handoff-truncated 拒绝');
  assert.equal(result.caps.truncated, true, '摘要按 advisory 阈值收短');
  assert.ok(result.caps.truncatedSections.includes('chars:evidence'), '单条裁剪记账：' + JSON.stringify(result.caps.truncatedSections));
  assert.ok(result.caps.split, '完整版单独输出');
  assert.ok(result.caps.fullBytes > result.caps.bytes.used);
  assert.equal(created.length, 1, '直接交接（agents.create 回退路径）');
  assert.equal(created[0].meta.agentPreset, 'relay');
  assert.equal(created[0].meta.cwd, cwd);
  assert.equal(followed.length, 1, '只发 handoff 首条消息（清理报告不再另发）');
  const message = followed[0].content[0].text;
  assert.ok(Buffer.byteLength(message, 'utf8') <= result.caps.bytes.limit + 2048, '首条消息有界');
  assert.match(message, /## 完整交接单（全部细节）/);
  assert.match(message, /完整交接单：\.scratch\/context-relay\/handoff-\d+\.md — 用 read 或 relay_doc read 按需取/);
  const full = readFileSync(result.handoffPath, 'utf8');
  assert.ok(full.includes('e0-' + 'x'.repeat(300)), '完整文件保留第 1 条原文');
  assert.ok(full.includes('e19-' + 'x'.repeat(300)), '完整文件保留第 20 条原文');
});

test('v0.10.0：relay_handoff 目标恒为唯一模式（退役 handoffPreset 不再存在）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-hp-caller', cwd, seq: 0 });
  const created = [];
  const followed = [];
  const liveSession = { id: 'session-hp-child', header: { cwd }, requestHeader: () => undefined };
  const { services } = fakeServices({
    session,
    extra: {
      sessionController: { async create(request) { created.push(request); return { sessionId: 'session-hp-child' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); } }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  // host 经 preset 行 config 透传白名单：首项 = 唯一模式 id
  const { tools } = applyAgent(services, { relayPresetIds: ['relay-long'] });
  // 退役字段写入被丢弃（面板无该键）
  updatePanelState(session.id, { handoffPreset: 'relay' });
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), 'handoffPreset'), false);
  const result = await tools.get('relay_handoff').execute(
    { status: { goal: 'next session in single mode' }, human_approved: true },
    { agent: { session, options: {} } },
  );
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.createdVia, 'sessionController.create');
  assert.equal(created[0].agentPreset, 'relay-long', 'controller.create 恒用唯一模式');
  // 新会话面板没有退役字段
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('session-hp-child'), 'handoffPreset'), false);
  assert.equal(followed.length, 1);
});

test('v0.10.0：relay_handoff agents.create 路径 meta.agentPreset/presets.mount 恒为唯一模式', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const created = [];
  const mounted = [];
  const { services } = fakeServices({
    session: fakeSession({ id: 'unused-session-hp', cwd }),
    extra: {
      agents: {
        async create(options) {
          created.push(options);
          // 真实 agents.create 会调用 setup(agentCtx) 挂载 preset——fake 也要调，才能验证 presets.mount 用的模式 id。
          await options.setup?.({});
          const id = 'session-hp-agents-new-' + created.length;
          return { agent: { session: { id, header: { cwd }, requestHeader: () => undefined }, followup() {} } };
        },
      },
      agentPresets: { async mount(agentCtx, id) { mounted.push(id); agentCtx.mounted = id; } },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services, { relayPresetIds: ['relay-long'] });
  const handoff = async (sessionId) => {
    const session = fakeSession({ id: sessionId, cwd, seq: 0 });
    const result = await tools.get('relay_handoff').execute(
      { status: { goal: 'preset selection ' + sessionId }, human_approved: true },
      { agent: { session, options: {} } },
    );
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  };
  // 多次 handoff：目标恒唯一模式 id（meta.agentPreset 与 presets.mount 一致）
  await handoff('session-hp-a');
  assert.equal(created[0].meta.agentPreset, 'relay-long');
  assert.equal(mounted[0], 'relay-long', 'presets.mount 与 meta.agentPreset 一致');
  await handoff('session-hp-b');
  assert.equal(created[1].meta.agentPreset, 'relay-long');
  assert.equal(mounted[1], 'relay-long');
  await handoff('session-hp-c');
  assert.equal(created[2].meta.agentPreset, 'relay-long');
  assert.equal(mounted[2], 'relay-long');
  // 面板无退役字段
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('session-hp-a'), 'handoffPreset'), false);
});

test('relay_handoff refuses subagent/teammate callers before side effects', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const { services } = fakeServices({ session: fakeSession({ seq: 0 }) });
  const subSession = fakeSession({ id: 'session-sub-handoff', header: { cwd, origin: 'subagent' } });
  const { tools } = applyAgent(services);
  const refused = await tools.get('relay_handoff').execute(
    { status: { goal: 'should not happen' }, human_approved: true },
    { agent: { session: subSession, options: {} } },
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Lead-only/);
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay')), false, 'refusal must not write a handoff file');
});

test('reminder listener stays inside the relay preset scope (no {global:true})', () => {
  resetSharedState();
  const { services } = fakeServices({ session: fakeSession({ seq: 0 }) });
  const { events } = applyAgent(services);
  const found = events.find((event) => event.name === 'agent/pre-step');
  assert.ok(found, 'agent/pre-step listener registered');
  // dsh-scope 契约：{global:true} 绕过 scope 过滤、会收全进程所有 agent（普通会话也会被
  // 计量并注入它没有的 relay 工具文案）；默认 scope 覆盖本 preset 血统 + subagent 子代。
  // fake ctx 不实现 scope 派发，无法在此模拟「非本 scope 的 agent 不触发」；
  // 真实隔离由 dsh-scope 提供（audit-core P1-1），这里只锁定注册形态。
  assert.equal(found.options, undefined);
});

test('pressureOf skips tokenMeter.measure when the projection already has a value', async () => {
  resetSharedState();
  const session = fakeSession({ seq: 0 });
  let measures = 0;
  const { services } = fakeServices({ session, extra: { tokenMeter: { measure() { measures += 1; return { totalTokens: 1 }; } } } });
  const { tools } = applyAgent(services);
  await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(measures, 0, 'projection has a value -> no O(surface) measure');

  // 投影没有可用 used 时才退回 meter。
  const bareSession = fakeSession({ id: 'session-meter-fallback', seq: 0 });
  let bareMeasures = 0;
  const bare = applyAgent({
    sessionProjections: { snapshot: () => ({ values: {} }) },
    tokenMeter: { measure() { bareMeasures += 1; return { totalTokens: 20000 }; } },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  });
  const report = await bare.tools.get('relay_status').execute({}, { agent: { session: bareSession, options: {} } });
  assert.equal(bareMeasures, 1);
  assert.equal(report.lead.used, 20000);
});

test('teammateState releases the session observation lease via Symbol.dispose', async () => {
  resetSharedState();
  const session = fakeSession({ seq: 0 });
  let released = 0;
  const { services } = fakeServices({
    session,
    extra: {
      agentTeams: {
        tryMembership: () => ({ role: 'lead' }),
        listMembers: () => [{ id: 'member-1', name: 'worker', status: 'running', role: 'teammate' }],
      },
      sessionQuery: {
        async observeSession() {
          return {
            projections: { values: { contextPressure: { contextWindow: 1_000_000, projectedTokens: 100_000 } } },
            [Symbol.dispose]() { released += 1; },
          };
        },
      },
    },
  });
  const { tools } = applyAgent(services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.team.length, 1);
  assert.equal(report.team[0].band, 'ok');
  assert.equal(released, 1, 'SessionObservation lease released with [Symbol.dispose]');
});

test('contract: injected notice source passes official V4 durable-row admission', async (t) => {
  resetSharedState();
  const v4 = await loadV4Admission();
  if (v4 === undefined) {
    t.skip('official dsh-session-format-v3-to-v4 not found via which dsh');
    return;
  }
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-v4-contract', cwd });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  await preStepListener(applyAgent(services).events)({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  // 持久化后的形状是 user/message 行；source 必须是 producer-owned kind，
  // 否则 V4 准入（重启/冷读 validation:'current'）会拒收整条日志。
  const row = { type: 'user/message', seq: 0, data: injected[0] };
  assert.doesNotThrow(() => v4.assertV4RowAdmission(row));
  // 反向证明断言有效：V4 已退役的 kind:'plugin' 包装仍被拒收。
  const retired = { ...row, data: { ...injected[0], source: { kind: 'plugin', plugin: 'dsh-context-relay', form: 'notice', summary: 'x' } } };
  assert.throws(() => v4.assertV4RowAdmission(retired), /producer-owned/);
});

test('phase and organizeCount derive from PTC dispatch rows (real relay runtime shape)', async () => {
  resetSharedState();
  const log = [
    { type: 'tool/ptc-dispatch-start', seq: 0, data: { name: 'relay_phase', arguments: { phase: 'build' } } },
    { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'build' } } },
    { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 1234 tokens; band organize → ok' }] } },
    { type: 'tool/result', seq: 3, data: { message: {} } },
  ];
  const session = fakeSession({ id: 'session-ptc-derive', seq: 4, log });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  // PTC 模式：relay 工具日志是 tool/ptc-dispatch，不是 tool/call（旧实现会丢状态）
  assert.equal(report.phase, 'build');
  assert.equal(report.organizeCount, 1);
  assert.equal(report.continue.needed, true);
  assert.equal(report.continue.recommendation, 'handoff', 'already compressed once -> recommend handoff');
  // P2#8 瘦身：structured 返回不含 thresholds / continue.options 大对象，但 text 里保留阈值与选择题。
  assert.equal(report.ok, true);
  assert.equal(report.thresholds, undefined);
  assert.equal(report.continue.options, undefined);
  assert.equal(report.continue.ask, undefined);
  assert.match(report.text, /continue: 需人类选择/);
  assert.match(report.text, /选项 A「压缩后继续同一会话」/);
  assert.match(report.text, /thresholds: warn 35\.0% \/ organize 40\.0% \/ relay 50\.0%/);
  // P2#13 diagnostics
  assert.deepEqual(Object.keys(report.diagnostics).sort(), ['lastCompactionSeq', 'organizeCount', 'pressureSource']);
  assert.equal(report.diagnostics.organizeCount, 1);
  assert.equal(report.diagnostics.pressureSource, 'projected');
  assert.equal(report.diagnostics.lastCompactionSeq, -1);
});

test('relay_status asks the human to choose compress vs handoff; first compression is recommended', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-choice-fresh', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.lead.band, 'organize');
  assert.equal(report.continue.needed, true);
  assert.equal(report.continue.recommendation, 'organize');
  assert.match(report.advice, /问人类/);
  assert.match(report.text, /continue: 需人类选择/);
});

test('fresh deploy（无 config/文件）：agent 默认按基准 35% 分档（30/35/45），不回落 legacy 35/40/50', async () => {
  resetSharedState();
  // 模拟 fresh deploy 的 wiring：host 发布默认设置（explicit=false），relay-agent 行 config 不带 thresholds。
  globalThis[Symbol.for('dsh-context-relay.settings')] = {
    threshold: 35, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true, explicit: false,
  };
  const session = fakeSession({ id: 'session-fresh-defaults', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 320_000 } });
  const { tools } = applyAgent(services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.lead.band, 'warn', '32% 应落在 warn（30%≤ratio<35%），不是 ok（旧 wiring 会回落 legacy 35/40/50）');
  assert.match(report.text, /thresholds: warn 30\.0% \/ organize 35\.0% \/ relay 45\.0%/);
});

test('relay_organize refuses a second compression unless the human forces it', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const session = fakeSession({ id: 'session-second-compression', cwd, seq: 1, log });
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 10 }; } };
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction });
  const { tools } = applyAgent(services);
  const refused = await tools.get('relay_organize').execute({ phase: 'build', brief: 'again' }, { agent: { session, options: {} } });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /already compressed once/);
  // 二次压缩拒绝同样零副作用：不写 brief、不跑 doc_lint。
  assert.equal(refused.briefPath, undefined);
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay')), false, 'second-compression refusal must not write a brief file');
  const forced = await tools.get('relay_organize').execute({ phase: 'build', brief: 'again', force: true }, { agent: { session, options: {} } });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.ok(forced.organizeCount >= 2);
  assert.equal(readdirSync(join(cwd, '.scratch', 'context-relay')).filter((name) => name.endsWith('.md')).length, 1, 'only the forced compression writes a brief');
});

test('v0.3.8 面板预设=compress：relay_status 推荐/文案跟随人类选择；已压缩过也允许第二次压缩（仍走审批）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const session = fakeSession({ id: 'session-v038-panel-compress', cwd, seq: 1, log: organizedLog });
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 12 }; } };
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { defaultOperation: 'compress' });

  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.organizeCount, 1);
  assert.equal(report.continue.recommendation, 'organize', '面板压缩继续优先于「已压缩过→推荐接力」规则');
  assert.equal(report.continue.preset, 'compress');
  assert.match(report.text, /continue: 面板模式=压缩继续/);
  assert.match(report.advice, /面板模式=压缩继续，按模式执行/);
  assert.doesNotMatch(report.advice, /本会话已压缩过，推荐接力/, '不出现与面板矛盾的规则推荐');

  // 已压缩过 1 次 + 面板模式 compress + 非 force：按人类明确选择执行第二次压缩，成功后模式保持（持久）。
  const second = await tools.get('relay_organize').execute({ phase: 'build', brief: 'second' }, { agent: { session, options: {} } });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.organized, true);
  assert.equal(second.organizeCount, 2);
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress', '压缩成功后模式保持（v0.4.0 持久）');
});

test('v0.3.8 面板预设=handoff：relay_status 推荐=handoff 且文案报人类选择', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const session = fakeSession({ id: 'session-v038-panel-handoff', cwd, seq: 1, log: organizedLog });
  const { tools } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services);
  updatePanelState(session.id, { defaultOperation: 'handoff' });
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.organizeCount, 1);
  assert.equal(report.continue.recommendation, 'handoff');
  assert.equal(report.continue.preset, 'handoff');
  assert.match(report.text, /continue: 面板模式=接力新会话/);
  assert.doesNotMatch(report.text, /需人类选择/);
});

test('v0.9.0 单一模式 advice 只列 4 档、不出现退役「压缩→新会话」；退役配置被忽略', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const makeReport = async (id, config = {}) => {
    const session = fakeSession({ id, cwd, seq: 0 });
    const { tools, logs } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services, config);
    // 升级残留：旧会话可能存了已移除档位的预设；应归一为 null 且不写进模型可见文本。
    updatePanelState(id, { defaultOperation: 'compress-then-handoff' });
    return { report: await tools.get('relay_status').execute({}, { agent: { session, options: {} } }), logs };
  };
  const single = await makeReport('session-v038-single-advice');
  assert.match(single.report.advice, /继续 \/ 压缩继续 \/ 接力新会话/);
  assert.doesNotMatch(single.report.advice, /压缩→新会话/, '单一模式模型可见 advice 不得出现已移除档位');
  assert.equal(single.report.continue.preset, null, '升级残留预设归一 null（问我）');
  assert.doesNotMatch(single.report.text, /压缩→新会话/);

  // v0.10.0：退役 config.routerMode 被静默忽略（无 warn、行为同上）
  const legacy = await makeReport('session-v038-legacy-advice', { routerMode: false });
  assert.match(legacy.report.advice, /继续 \/ 压缩继续 \/ 接力新会话/);
  assert.equal(legacy.report.continue.preset, null);
  assert.equal(legacy.logs.some((line) => /routerMode/.test(line)), false, '退役配置不再有专用 warn');
});

test('v0.9.0 单一模式到线提醒：cth 残留归一「问我」，不出现已移除档位', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const listenerOf = (events) => events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const noticeOf = async (id, config = {}) => {
    const session = fakeSession({ id, cwd });
    const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
    const injected = [];
    const listener = listenerOf(applyAgent(services, config).events);
    updatePanelState(id, { defaultOperation: 'compress-then-handoff' });
    await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
    return injected[0]?.content?.[0]?.text ?? '';
  };
  const singleText = await noticeOf('session-v038-single-notice-cth');
  assert.ok(singleText.length > 0, '到线提醒仍注入');
  assert.doesNotMatch(singleText, /压缩→新会话/, '到线提醒不得显示已移除档位');
  assert.match(singleText, /模式「问我」/, '残留预设按「问我」展示');
  // v0.10.0：退役 config.routerMode 被忽略：同一文案
  const legacyText = await noticeOf('session-v038-legacy-notice-cth', { routerMode: false });
  assert.doesNotMatch(legacyText, /压缩→新会话/);
  assert.match(legacyText, /模式「问我」/);
});

test('relay_organize injects the phase brief only after a successful compaction', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-organize-inject', cwd, seq: 0 });
  const order = [];
  const injected = [];
  const compaction = { async compactIfNeeded() { order.push('compact'); return { shadowedTokenCount: 4321 }; } };
  const { services } = fakeServices({ session, compaction });
  const { tools } = applyAgent(services);
  const agent = { session, options: {}, inject(message) { order.push('inject'); injected.push(message); } };
  const eventsBefore = session.snapshotEvents().length;
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'decided X', force: true }, { agent });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['compact', 'inject'], 'brief injected after compaction succeeded');
  assert.equal(result.briefInjected, true);
  assert.match(result.summary, /brief injected into context after compaction/);
  assert.equal(injected.length, 1);
  const message = injected[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'dsh-context-relay');
  assert.equal(message.source.form, 'notice');
  assert.ok(message.source.summary.length <= 120, 'summary fits the 120-char contract');
  assert.doesNotMatch(message.source.summary, /band=/, 'summary must not pollute the reminder band seed scan');
  const text = message.content[0].text;
  assert.ok(text.length <= 4000, 'injected text is bounded to 4000 chars');
  assert.match(text, /\[context-relay\] phase brief · build（压缩后注入，非用户发言）/);
  assert.match(text, /Phase Brief · build/);
  assert.match(text, /decided X/);
  // 无 phase 元数据时不渲染空段占位符（audit D）
  assert.doesNotMatch(text, /（无）/);
  assert.equal(session.snapshotEvents().length, eventsBefore, 'injection must not write the session log/surface');
});

test('relay_organize refusal paths never inject; agent without inject still works', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const injected = [];
  const compaction = { async compactIfNeeded() { throw new Error('compaction must not run on refusal'); } };
  // 低于阈值：默认 20000/1M 是 ok 档，不带 force 必然拒绝且不注入
  const session = fakeSession({ id: 'session-organize-below', cwd, seq: 0 });
  const { services } = fakeServices({ session, compaction });
  const { tools } = applyAgent(services);
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const below = await tools.get('relay_organize').execute({ phase: 'discover', brief: 'nothing yet' }, { agent });
  assert.equal(below.organized, false);
  assert.equal(below.briefInjected, false);
  assert.equal(injected.length, 0, 'below threshold -> no injection');
  // 二次压缩拒绝：日志里已有一次成功 relay_organize，压力处于 organize 档
  const log = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 100 tokens' }] } }];
  const again = fakeSession({ id: 'session-organize-again', cwd, seq: 1, log });
  const { services: againServices } = fakeServices({ session: again, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction });
  const { tools: againTools } = applyAgent(againServices);
  const againResult = await againTools.get('relay_organize').execute({ phase: 'build', brief: 'again' }, { agent: { session: again, options: {}, inject(message) { injected.push(message); } } });
  assert.equal(againResult.ok, false);
  assert.match(againResult.summary, /already compressed once/);
  assert.equal(againResult.briefInjected, false);
  assert.equal(injected.length, 0, 'second compression refused -> no injection');
  // 兼容旧调用方（agent 无 inject）：不报错，briefInjected:false
  const bare = fakeSession({ id: 'session-organize-bare', cwd, seq: 0 });
  const { services: bareServices } = fakeServices({ session: bare, compaction: { async compactIfNeeded() { return { shadowedTokenCount: 9 }; } } });
  const { tools: bareTools } = applyAgent(bareServices);
  const bareResult = await bareTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: bare, options: {} } });
  assert.equal(bareResult.ok, true);
  assert.equal(bareResult.briefInjected, false);
});

test('no compactable history does not count and does not block the next real compression', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // 上一次 organize 返回 'no compactable history'（没有发生压缩）：不得触发二次压缩守卫。
  const log = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'no compactable history; brief written to x.md' }] } }];
  const session = fakeSession({ id: 'session-noop-then-real', cwd, seq: 1, log });
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 321 }; } };
  const { tools } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction }).services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'now real' }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.freedTokens, 321);
  assert.equal(result.organizeCount, 1);
});

test('organizeCount counts only successful compressions across log shapes', async () => {
  resetSharedState();
  const dispatch = (seq, data) => ({ type: 'tool/ptc-dispatch', seq, data });
  const scenarios = [
    // PTC 成功：压缩出 token → 计 1
    { name: 'ptc organized', log: [dispatch(0, { name: 'relay_organize', arguments: {}, isError: false, content: [{ type: 'text', text: 'organized: freed 100 tokens; band organize → ok' }] })], expected: 1 },
    // 没有真正发生压缩（无可压缩历史）→ 不计（Lead 裁决口径：只认 'organized: freed'）
    { name: 'ptc no compactable history', log: [dispatch(0, { name: 'relay_organize', arguments: {}, isError: false, content: [{ type: 'text', text: 'no compactable history; brief written to x.md' }] })], expected: 0 },
    // 一次真压缩 + 一次空转：只计真压缩
    {
      name: 'ptc organized then no compactable history',
      log: [
        dispatch(0, { name: 'relay_organize', arguments: {}, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] }),
        dispatch(1, { name: 'relay_organize', arguments: {}, isError: false, content: [{ type: 'text', text: 'no compactable history; brief written to x.md' }] }),
      ],
      expected: 1,
    },
    // PTC 低于阈值拒绝（isError:false 但文案不是成功）→ 不计
    { name: 'ptc below-threshold', log: [dispatch(0, { name: 'relay_organize', arguments: {}, isError: false, content: [{ type: 'text', text: 'not organized: below-threshold:ok. Call with force=true only if you are at a real phase boundary.' }] })], expected: 0 },
    // PTC 抛错/busy（isError:true）→ 不计
    { name: 'ptc error', log: [dispatch(0, { name: 'relay_organize', arguments: {}, isError: true, content: [{ type: 'text', text: 'organize failed (compaction busy, retry after current turn): busy' }] })], expected: 0 },
    // 直接调用模式：tool/call + tool/result 按 callId 配对（前一个抛错、后一个成功）
    {
      name: 'direct call pair',
      log: [
        { type: 'tool/call', seq: 0, data: { callId: 'c1', name: 'relay_organize', arguments: '{}' } },
        { type: 'tool/result', seq: 1, data: { message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'organize failed: boom' }] } } },
        { type: 'tool/call', seq: 2, data: { callId: 'c2', name: 'relay_organize', arguments: '{}' } },
        { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'organized: freed 42 tokens' }] } } },
      ],
      expected: 1,
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const session = fakeSession({ id: 'session-count-' + index, seq: 100, log: scenario.log });
    const { tools } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services);
    const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
    assert.equal(report.organizeCount, scenario.expected, scenario.name);
  }
});

test('relay_organize injects the brief only on success; busy retry injects once; injectBrief=false disables', async () => {
  resetSharedState();
  const cwd = tmpCwd();

  // 1) 无可压缩历史（result === null）：不注入
  const emptySession = fakeSession({ id: 'session-organize-null', cwd, seq: 0 });
  const emptyInjected = [];
  const emptyTools = applyAgent(fakeServices({ session: emptySession, compaction: { async compactIfNeeded() { return null; } } }).services).tools;
  const empty = await emptyTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true },
    { agent: { session: emptySession, options: {}, inject(message) { emptyInjected.push(message); } } });
  assert.equal(empty.ok, true);
  assert.equal(empty.organized, false);
  assert.equal(empty.organizeCount, 0, 'result === null (no compaction) must not count as organized');
  assert.equal(empty.briefInjected, false);
  assert.equal(emptyInjected.length, 0, 'result === null -> no injection');

  // 2) busy 失败不注入；force 重试成功后只注入一次（不会重复叠加 notice）
  const retrySession = fakeSession({ id: 'session-organize-busy-retry', cwd, seq: 0 });
  const retryInjected = [];
  const retryAgent = { session: retrySession, options: {}, inject(message) { retryInjected.push(message); } };
  let attempt = 0;
  const busyThenOk = {
    async compactIfNeeded() {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('compaction busy'), { code: 'busy' });
      return { shadowedTokenCount: 77 };
    },
  };
  const retryTools = applyAgent(fakeServices({ session: retrySession, compaction: busyThenOk }).services).tools;
  const failed = await retryTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: retryAgent });
  assert.equal(failed.ok, false);
  assert.equal(failed.busy, true);
  assert.equal(failed.briefInjected, false);
  assert.equal(retryInjected.length, 0, 'busy failure -> no injection');
  const retried = await retryTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: retryAgent });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retryInjected.length, 1, 'busy retry injects exactly one brief');
  assert.equal(retried.briefInjected, true);
  assert.match(retried.summary, /brief injected into context after compaction/);

  // 3) config.injectBrief=false：成功压缩也不注入（M2-G 有/无注入 A/B 开关）
  const offSession = fakeSession({ id: 'session-organize-inject-off', cwd, seq: 0 });
  const offInjected = [];
  const offTools = applyAgent(
    fakeServices({ session: offSession, compaction: { async compactIfNeeded() { return { shadowedTokenCount: 5 }; } } }).services,
    { injectBrief: false },
  ).tools;
  const off = await offTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true },
    { agent: { session: offSession, options: {}, inject(message) { offInjected.push(message); } } });
  assert.equal(off.ok, true);
  assert.equal(off.briefInjected, false);
  assert.equal(offInjected.length, 0, 'injectBrief=false disables injection');
});

test('reminders: 冷启动跨 200 事件仍从持久 notice seed（模块重建不重复提醒）', async () => {
  resetSharedState();
  const notice = {
    type: 'user/message',
    seq: 1,
    data: {
      role: 'user',
      id: 'notice-old',
      content: [{ type: 'text', text: '[context-relay] 自动提醒（插件 notice，非用户发言）· band=organize · phase=build' }],
      source: { kind: 'dsh-context-relay', form: 'notice', summary: '[context-relay] band=organize · phase=build' },
    },
  };
  // 上一条 notice 在 seq 1；其后 400 条事件 → 旧实现「只扫最近 200 条」会漏掉它。
  const log = [notice, ...Array.from({ length: 400 }, (_, index) => ({ type: 'turn/start', seq: index + 2 }))];
  const session = fakeSession({ id: 'session-cold-start-deep', log });
  const { services, state } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const listener = preStepListener(applyAgent(services).events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  await listener({ agent }, async () => undefined);
  // 2026-11-01 phase 优先：跨 200 事件仍从持久 notice seed 出 band=organize → 同档不重复、无重启补催。
  assert.equal(injected.length, 0, 'persisted band seeds across the >200-event window: no restart re-alert');
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 0, 'seed does not replay on the next pre-step');
  // 更高一档仍提醒：持久派生 band=organize，relay 档 > organize
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  assert.match(injected[0].source.summary, /band=relay/);
});

test('reminders: 成功压缩重新武装（压缩两次仍提醒）；同档不重复', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // 压缩前已经提醒过 organize 档（notice seq 0）；随后发生一次成功压缩。
  const log = [
    {
      type: 'user/message',
      seq: 0,
      data: {
        role: 'user',
        id: 'notice-epoch-old',
        content: [{ type: 'text', text: '[context-relay] 自动提醒（插件 notice，非用户发言）· band=organize · phase=build' }],
        source: { kind: 'dsh-context-relay', form: 'notice', summary: '[context-relay] band=organize · phase=build' },
      },
    },
    { type: 'compaction/end', seq: 1, data: { compactionId: 'c1', turn: 1 } },
  ];
  const session = fakeSession({ id: 'session-epoch-reset', cwd, log });
  const { services, state } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const { events, logs } = applyAgent(services);
  const listener = preStepListener(events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);

  // 压缩前的 organize notice 属于旧段 → 压缩后重新武装，warn 档提醒一次
  await step();
  assert.equal(injected.length, 1);
  assert.match(injected[0].source.summary, /band=warn/);
  await step();
  assert.equal(injected.length, 1, 'same band never repeats without a new compaction (no jitter)');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step();
  assert.equal(injected.length, 2);
  assert.match(injected[1].source.summary, /band=organize/);
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await step();
  assert.equal(injected.length, 3);
  assert.match(injected[2].source.summary, /band=relay/);
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 300_000 };
  await step();
  assert.equal(injected.length, 3, 'falling back never reminds');

  // 再发生一次成功压缩 → 再次重新武装：warn 再提醒一次（压缩多少次都不压掉提醒）
  log.push({ type: 'compaction/end', seq: 2, data: { compactionId: 'c2', turn: 1 } });
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 360_000 };
  await step();
  assert.equal(injected.length, 4, 'a second successful compaction re-arms the warn band again');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step();
  assert.equal(injected.length, 5, 'organize fires once in the new segment');
  assert.ok(logs.some((line) => line.includes('[reminder] inject')), 'reminder milestone logged');
});

test('reminders: 模块重建后旧段（压缩前）notice 不再抑制新段', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [
    {
      type: 'user/message',
      seq: 0,
      data: {
        role: 'user',
        id: 'notice-rebuild-old',
        content: [{ type: 'text', text: '[context-relay] 自动提醒（插件 notice，非用户发言）· band=relay · phase=build' }],
        source: { kind: 'dsh-context-relay', form: 'notice', summary: '[context-relay] band=relay · phase=build' },
      },
    },
    { type: 'compaction/end', seq: 1, data: { compactionId: 'c1', turn: 1 } },
  ];
  const session = fakeSession({ id: 'session-epoch-rebuild', cwd, log });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  // 新模块实例 = 插件重建（模块级 SENTINEL_SCAN 冷缓存）；压缩前的 notice 同样算已提醒。
  const cold = await import('../lib/agent.js?epoch-rebuild=' + Date.now());
  const { ctx, events } = fakeCtx({ services });
  cold.apply(ctx, {});
  const injected = [];
  await preStepListener(events)({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 1, 'old-segment notice no longer suppresses the new segment after rebuild');
  assert.match(injected[0].source.summary, /band=warn/);
});

test('approval gate: handoff / forced second organize ask for official approval; off disables; fail-closed deny', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  let outcome = 'allowed-once';
  const approval = {
    requests: [],
    async request(input) { this.requests.push(input); return outcome; },
  };
  const session = fakeSession({ id: 'session-approval', cwd, seq: 0 });
  const { services, state } = fakeServices({
    session,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    extra: { approval },
  });
  const { events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const handoffExec = { name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'c1', agent: { session }, signal: new AbortController().signal };

  // 通过：ask → allowed-once → 放行；审批 reason 是英文审计理由 + displayReason 本地化
  assert.equal((await resolveApproval(gate, handoffExec, approval)).kind, 'allow');
  assert.equal(approval.requests.length, 1);
  assert.match(approval.requests[0].reason, /human/i);
  const asked = await gate(handoffExec, async () => ({ kind: 'allow' }));
  assert.equal(asked.kind, 'ask');
  assert.ok(asked.displayReason.en.length > 0 && asked.displayReason.zh.length > 0);
  // 拒绝：rejected → deny（fail-closed）
  outcome = 'rejected';
  assert.equal((await resolveApproval(gate, handoffExec, approval)).kind, 'deny');
  // human_approved !== true / 非 relay 工具 / 下游已 deny：gate 不介入
  assert.equal((await gate({ ...handoffExec, arguments: { human_approved: false } }, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal((await gate({ ...handoffExec, name: 'read' }, async () => ({ kind: 'allow' }))).kind, 'allow');
  const downstreamDeny = await gate(handoffExec, async () => ({ kind: 'deny', reason: 'other gate' }));
  assert.deepEqual(downstreamDeny, { kind: 'deny', reason: 'other gate' });
  // B-P2-6：注定被工具体拒绝的调用直接放行（不弹审批、零副作用）
  assert.equal((await gate({ ...handoffExec, arguments: { human_approved: true } }, async () => ({ kind: 'allow' }))).kind, 'allow', 'handoff 缺 goal 注定 handoff-invalid，不弹审批');
  assert.equal((await gate({ ...handoffExec, arguments: { human_approved: true, status: { goal: 'x', phase: 'bogus' } } }, async () => ({ kind: 'allow' }))).kind, 'allow', 'handoff 非法 phase 注定 handoff-invalid，不弹审批');
  const subExecutor = { ...handoffExec, agent: { session: fakeSession({ id: 'session-approval-sub', header: { origin: 'subagent' } }) } };
  assert.equal((await gate(subExecutor, async () => ({ kind: 'allow' }))).kind, 'allow', 'subagent 调 handoff 注定 lead-only，不弹审批');
  // rev5.4：任何压缩默认都要 ask（不再有「首次压缩免审批」）；二次 force 用专门理由文案。
  const freshSession = fakeSession({ id: 'session-approval-fresh', cwd });
  const organizeExec = { name: 'relay_organize', arguments: { phase: 'build' }, callId: 'c2', agent: { session: freshSession }, signal: new AbortController().signal };
  // B-P2-6：below-threshold（非 force）注定被工具拒绝 → 不弹审批
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 20_000 };
  assert.equal((await gate(organizeExec, async () => ({ kind: 'allow' }))).kind, 'allow', 'below-threshold organize 不弹审批');
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  const organizeAsk = await gate(organizeExec, async () => ({ kind: 'allow' }));
  assert.equal(organizeAsk.kind, 'ask');
  assert.match(organizeAsk.reason, /compresses this session context/);
  // autoCompress / authorizeNext 是人类显式授权 → 免审
  updatePanelState('session-approval-fresh', { autoCompress: true });
  assert.equal((await gate(organizeExec, async () => ({ kind: 'allow' }))).kind, 'allow');
  updatePanelState('session-approval-fresh', { autoCompress: false, authorizeNext: true });
  assert.equal((await gate(organizeExec, async () => ({ kind: 'allow' }))).kind, 'allow');
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const secondExec = { ...organizeExec, arguments: { phase: 'build', force: true }, agent: { session: fakeSession({ id: 'session-approval-organized', cwd, log: organizedLog }) } };
  const secondAsk = await gate(secondExec, async () => ({ kind: 'allow' }));
  assert.equal(secondAsk.kind, 'ask');
  assert.match(secondAsk.reason, /SECOND compression/);
  // B-P2-6：非 force 的二次压缩注定 already-organized → 不弹审批
  const nonForceExec = { ...secondExec, arguments: { phase: 'build' } };
  assert.equal((await gate(nonForceExec, async () => ({ kind: 'allow' }))).kind, 'allow', 'already-organized 不弹审批');
  // v0.3.8：面板预设=compress 时二次压缩不再注定被拒 → 必须正常进入审批分支（ask）。
  updatePanelState('session-approval-organized', { defaultOperation: 'compress' });
  const presetSecondAsk = await gate(nonForceExec, async () => ({ kind: 'allow' }));
  assert.equal(presetSecondAsk.kind, 'ask', '面板预设压缩继续时二次压缩应弹审批而非预判放行');
  updatePanelState('session-approval-organized', { defaultOperation: null });
  // v0.9.0 D8=A：cth 档退役（归一 null=问我）→ B-P2-6 的「两段式未到线注定被拒」预判不再存在；
  // handoff 恒走正常审批（ask），不因旧预设值免审。
  const twoStageSession = fakeSession({ id: 'session-approval-two-stage', cwd, seq: 0, log: organizedLog });
  updatePanelState('session-approval-two-stage', { defaultOperation: 'compress-then-handoff' });
  assert.equal(panelStateOf('session-approval-two-stage').defaultOperation, null, 'cth 归一 null（退役）');
  const twoStageExec = { ...handoffExec, agent: { session: twoStageSession } };
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 130_000 }; // 13% → ok（未到线）
  assert.equal((await gate(twoStageExec, async () => ({ kind: 'allow' }))).kind, 'ask', 'cth 退役后无两段式预判：交接仍正常 ask');
  // 下一次到线（organize）→ 同样正常 ask（预设不自动免审）
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  assert.equal((await gate(twoStageExec, async () => ({ kind: 'allow' }))).kind, 'ask', '下一次到线仍正常 ask');

  // 审批服务缺失：fail-closed deny + 部署提示（可配置 off）
  const noApprovalApply = applyAgent(fakeServices({ session: fakeSession({ id: 'session-approval-missing', cwd }) }).services);
  const missing = await preExecuteListener(noApprovalApply.events)(handoffExec, async () => ({ kind: 'allow' }));
  assert.equal(missing.kind, 'deny');
  assert.equal(missing.info.code, 'relay-approval-unavailable');
  assert.match(missing.reason, /handoffApproval="off"/);

  // handoffApproval='off'：不注册审批 gate；human_approved 参数仍在工具体内守卫
  // （v0.6.3：报数时排除派活闸门——它挂在 pre-execute 上但不属于审批）。
  const off = applyAgent(fakeServices({ session: fakeSession({ id: 'session-approval-off', cwd }) }).services, { handoffApproval: 'off' });
  const offGates = off.events.filter((event) => event.name === 'tools/pre-execute').map((event) => event.listener);
  assert.equal(offGates.filter((listener) => listener.name !== 'dshContextRelayDispatchGate').length, 0);
  const offRefused = await off.tools.get('relay_handoff').execute({ status: { goal: 'x' } }, { agent: { session: fakeSession({ id: 'session-approval-off-tool', cwd }), options: {} } });
  assert.equal(offRefused.ok, false);
  assert.equal(offRefused.code, 'human-approval-required');
});

test('approval gate rev5.4: 自动/非自动的首次压缩都 ask；autoCompress / 授权下一次操作 免审', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  let outcome = 'allowed-once';
  const approval = { requests: [], async request(input) { this.requests.push(input); return outcome; } };
  const session = fakeSession({ id: 'session-approval-auto', cwd, seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, extra: { approval } });
  const { events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const exec = (target) => ({ name: 'relay_organize', arguments: { phase: 'build' }, callId: 'c-auto', agent: { session: target }, signal: new AbortController().signal });
  updatePanelState('session-approval-auto', { autoChoose: true });
  // 自动模式：模型自选压缩（首次压缩，非 force）→ ask
  const autoAsk = await gate(exec(session), async () => ({ kind: 'allow' }));
  assert.equal(autoAsk.kind, 'ask');
  assert.match(autoAsk.reason, /compresses this session context/);
  assert.ok(autoAsk.displayReason.zh.includes('压缩'));
  // allowed-once → 放行；rejected → deny（fail-closed）
  assert.equal((await resolveApproval(gate, exec(session), approval)).kind, 'allow');
  outcome = 'rejected';
  assert.equal((await resolveApproval(gate, exec(session), approval)).kind, 'deny');
  // autoCompress（压缩自动授权）开 → 免审
  updatePanelState('session-approval-auto', { autoCompress: true });
  assert.equal((await gate(exec(session), async () => ({ kind: 'allow' }))).kind, 'allow');
  // 授权下一次操作（authorizeNext）→ 免审
  updatePanelState('session-approval-auto', { autoCompress: false, authorizeNext: true });
  assert.equal((await gate(exec(session), async () => ({ kind: 'allow' }))).kind, 'allow');
  // rev5.4：非自动模式（无任何面板状态）的首次压缩也 ask
  const plain = exec(fakeSession({ id: 'session-approval-plain', cwd }));
  const plainAsk = await gate(plain, async () => ({ kind: 'allow' }));
  assert.equal(plainAsk.kind, 'ask');
  assert.match(plainAsk.reason, /compresses this session context/);
  resetSharedState();
});

test('concurrent relay operations in one session: second call returns structured busy; lock releases', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-concurrent', cwd });
  let releaseCompact;
  const compaction = {
    compactIfNeeded() {
      if (releaseCompact === undefined) return new Promise((resolve) => { releaseCompact = resolve; });
      return { shadowedTokenCount: 5 };
    },
  };
  const applied = applyAgent(fakeServices({ session, compaction }).services);
  const { tools } = applied;
  const gate = preExecuteListener(applied.events);
  const agent = { session, options: {}, inject() {} };
  const first = tools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent });
  // C5b：brief 写盘改为异步门面（await workspaceStore.writeAtomic）→ 等一等，让首个操作真正进到 compaction。
  for (let spin = 0; releaseCompact === undefined && spin < 200; spin += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  // B-P2-6：在途 relay 操作注定 relay-busy → 审批闸门直接放行（不弹无谓审批）
  const busyExec = { name: 'relay_organize', arguments: { phase: 'build', brief: 'y', force: true }, callId: 'busy', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(busyExec, async () => ({ kind: 'allow' }))).kind, 'allow', 'relay-busy 在途时不弹审批');
  const second = await tools.get('relay_organize').execute({ phase: 'build', brief: 'y', force: true }, { agent: { session, options: {}, inject() {} } });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'relay-busy');
  assert.match(second.error, /busy: another relay operation in flight/);
  // organize/handoff 共用同一会话锁（不可并发建会话）
  const handoffBusy = await tools.get('relay_handoff').execute({ status: { goal: 'x' }, human_approved: true }, { agent });
  assert.equal(handoffBusy.ok, false);
  assert.equal(handoffBusy.code, 'relay-busy');
  releaseCompact({ shadowedTokenCount: 10 });
  const done = await first;
  assert.equal(done.ok, true);
  const after = await tools.get('relay_organize').execute({ phase: 'build', brief: 'z', force: true }, { agent });
  assert.notEqual(after.code, 'relay-busy', 'lock released after the first operation settles');

  // 失败路径同样释放锁（finally）
  const failSession = fakeSession({ id: 'session-concurrent-fail', cwd });
  const failTools = applyAgent(fakeServices({ session: failSession, compaction: { async compactIfNeeded() { throw new Error('nope'); } } }).services).tools;
  const failed = await failTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: failSession, options: {} } });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'compaction-failed');
  const retried = await failTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: failSession, options: {} } });
  assert.equal(retried.code, 'compaction-failed', 'not relay-busy: the failed call released the lock');
});

test('error contract: organize/handoff failure paths return structured ok:false with code', async () => {
  resetSharedState();
  const cwd = tmpCwd();

  // 1) compaction 服务缺失：不抛普通 Error，结构化 code
  const engineSession = fakeSession({ id: 'session-err-engine', cwd });
  const engineTools = applyAgent(fakeServices({ session: engineSession }).services).tools;
  const noEngine = await engineTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: engineSession, options: {} } });
  assert.equal(noEngine.ok, false);
  assert.equal(noEngine.code, 'compaction-unavailable');

  // 2) brief 写盘失败：cwd 是文件 → .scratch mkdir ENOTDIR；压缩不尝试
  const fileAsCwd = join(cwd, 'not-a-dir');
  writeFileSync(fileAsCwd, 'x');
  const writeSession = fakeSession({ id: 'session-err-write', cwd: fileAsCwd });
  const writeTools = applyAgent(fakeServices({ session: writeSession, compaction: { async compactIfNeeded() { return { shadowedTokenCount: 1 }; } } }).services).tools;
  const writeFail = await writeTools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: writeSession, options: {} } });
  assert.equal(writeFail.ok, false);
  assert.equal(writeFail.code, 'brief-write-failed');
  assert.match(writeFail.summary, /compression was NOT attempted/);

  // 3) handoff 写盘失败：发生在建会话之前（无 sessionController 调用）
  let createdSessions = 0;
  const handoffWriteSession = fakeSession({ id: 'session-err-handoff-write', cwd: fileAsCwd });
  const hwTools = applyAgent(fakeServices({ session: handoffWriteSession, extra: { sessionController: { async create() { createdSessions += 1; return { sessionId: 'session-x' }; } } } }).services).tools;
  const handoffWrite = await hwTools.get('relay_handoff').execute({ status: { goal: 'x' }, human_approved: true }, { agent: { session: handoffWriteSession, options: {} } });
  assert.equal(handoffWrite.ok, false);
  assert.equal(handoffWrite.code, 'recovery-unreadable');
  assert.equal(createdSessions, 0, 'no session created when the handoff file cannot be written');

  // 4) attachWorkspace 失败但会话可用 → 降级成功（ok:true + info.code）+ summary 明示
  const attachCwd = tmpCwd();
  const attachSession = fakeSession({ id: 'session-err-attach', cwd: attachCwd });
  const liveSession = { id: 'session-new', header: { cwd: attachCwd }, requestHeader: () => undefined };
  const followupCalls = [];
  const attachTools = applyAgent(fakeServices({
    session: attachSession,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup(message) { followupCalls.push(message); } }] },
      sessionTitle: { rename() {} },
      // 故意不提供 workspaceRegistry → attach 失败
    },
  }).services).tools;
  const attachFail = await attachTools.get('relay_handoff').execute({ status: { goal: 'attach me' }, human_approved: true }, { agent: { session: attachSession, options: {} } });
  assert.equal(attachFail.ok, true, JSON.stringify(attachFail));
  assert.equal(attachFail.info.code, 'relay-attach-failed');
  assert.equal(attachFail.sessionId, 'session-new');
  assert.match(attachFail.summary, /workspace attach failed/);
  assert.equal(followupCalls.length, 1, 'first prompt 仍派发（attach 失败不阻断；清理报告不再另发）');

  // 5) followup 失败：会话已建 → 结构化失败 + halfCreated + 重试指引（清理见专门测试）
  const followupCwd = tmpCwd();
  const followupSession = fakeSession({ id: 'session-err-followup', cwd: followupCwd });
  const liveBroken = { id: 'session-new', header: { cwd: followupCwd }, requestHeader: () => undefined };
  const followupTools = applyAgent(fakeServices({
    session: followupSession,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-new' }; } },
      agents: { list: () => [{ session: liveBroken, status: 'idle', followup() { throw new Error('dispatch boom'); } }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  }).services).tools;
  const followupFail = await followupTools.get('relay_handoff').execute({ status: { goal: 'dispatch me' }, human_approved: true }, { agent: { session: followupSession, options: {} } });
  assert.equal(followupFail.ok, false);
  assert.equal(followupFail.code, 'followup-failed');
  assert.equal(followupFail.sessionId, 'session-new');
  assert.equal(followupFail.halfCreated, true);
  assert.equal(existsSync(join(followupCwd, '.scratch', 'context-relay', 'progress.md')), false, 'followup 失败时回滚新建的滚动进度文件');
  assert.match(followupFail.summary, /Retry relay_handoff/);
});

test('pressure fallback measures at most once per 5 resolutions and reuses the last value', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-measure-ratelimit', seq: 0 });
  let measures = 0;
  const services = {
    sessionProjections: { snapshot: () => ({ values: {} }) },
    tokenMeter: { measure() { measures += 1; return { totalTokens: 1000 + measures }; } },
    agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] },
  };
  const { tools } = applyAgent(services);
  const call = () => tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  const first = await call();
  assert.equal(measures, 1);
  assert.equal(first.lead.used, 1001);
  for (let index = 0; index < 4; index += 1) await call();
  assert.equal(measures, 1, 'next 4 resolutions reuse the last measured value');
  const sixth = await call();
  assert.equal(measures, 2, 'fifth resolution interval re-measures once');
  assert.equal(sixth.lead.used, 1002);
});

test('observability: logger milestones for organize/reminder/handoff; missing logger is safe', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-logs', cwd });
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 7 }; } };
  const { tools, logs } = applyAgent(fakeServices({ session, compaction }).services);
  const organized = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session, options: {}, inject() {} } });
  assert.equal(organized.ok, true);
  assert.ok(logs.some((line) => line.includes('[organize] ok')), 'organize milestone logged');

  // 到线提醒：注入记 inject；回退记一次 skip
  const reminderSession = fakeSession({ id: 'session-logs-reminder', cwd });
  const reminderServices = fakeServices({ session: reminderSession, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const reminderApply = applyAgent(reminderServices.services);
  const listener = preStepListener(reminderApply.events);
  const injected = [];
  const reminderAgent = { session: reminderSession, inject(message) { injected.push(message); } };
  await listener({ agent: reminderAgent }, async () => undefined);
  assert.equal(injected.length, 1);
  assert.ok(reminderApply.logs.some((line) => line.includes('[reminder] inject')), 'reminder inject milestone logged');
  reminderServices.services.sessionProjections.snapshot = () => ({ values: { contextPressure: { contextWindow: 1_000_000, projectedTokens: 1_000 } } });
  await listener({ agent: reminderAgent }, async () => undefined);
  assert.ok(reminderApply.logs.some((line) => line.includes('[reminder] skip')), 'fall-back skip reason logged once');

  // logger 缺失：安全降级，不抛错
  const bare = fakeCtx({ services: fakeServices({ session: fakeSession({ id: 'session-logs-bare', cwd }), compaction: { async compactIfNeeded() { return { shadowedTokenCount: 1 }; } } }).services });
  bare.ctx.logger = undefined;
  apply(bare.ctx, {});
  const bareSession = fakeSession({ id: 'session-logs-bare-2', cwd });
  const bareResult = await bare.tools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: bareSession, options: {} } });
  assert.equal(bareResult.ok, true, 'missing logger must not break the tools');
});

test('relay_organize carries phase goal/exit_criteria into the brief and injected notice', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [
    { type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_phase', arguments: { phase: 'build', goal: 'ship batch-1 fixes', exit_criteria: 'npm test green + check pass' } } },
  ];
  const session = fakeSession({ id: 'session-phase-meta', cwd, seq: 1, log });
  const injected = [];
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 100 }; } };
  const { tools } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction }).services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'decided: keep 200-char clip', force: true },
    { agent: { session, options: {}, inject(message) { injected.push(message); } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.briefInjected, true);
  const brief = readFileSync(result.briefPath, 'utf8');
  for (const text of [brief, injected[0].content[0].text]) {
    assert.match(text, /phase brief · build|Phase Brief · build/);
    assert.match(text, /ship batch-1 fixes/);
    assert.match(text, /npm test green \+ check pass/);
    assert.doesNotMatch(text, /（无）/, 'empty sections are skipped, not rendered as placeholders');
  }
  assert.match(brief, /## 目标/);
  assert.match(brief, /## 退出条件/);
  assert.match(brief, /decided: keep 200-char clip/);
});

test('relay projection drives phase/organizeCount/phaseMeta and skips snapshotEvents', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // 日志里 phase=discover 且没有成功压缩；投影说 verify / 已真正压缩 2 次 → 必须以投影为准
  const log = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_phase', arguments: { phase: 'discover' } } }];
  const { session, counts } = countingSnapshotSession({ id: 'session-projected', cwd, log });
  const projection = { phase: 'verify', goal: '投影里的目标', exitCriteria: '投影里的退出条件', organizeCount: 2, compactionEpoch: 1, noticeBand: undefined, lastNoticeSeq: -1, lastCompactionSeq: 3 };
  const bundle = attachRelayProjection(fakeServices({
    session,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    compaction: { async compactIfNeeded() { return { shadowedTokenCount: 42 }; } },
  }), projection);
  const { tools } = applyAgent(bundle.services);

  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.phase, 'verify', 'projection wins over log-derived discover');
  assert.equal(report.organizeCount, 2);
  assert.equal(report.diagnostics.lastCompactionSeq, 3);
  assert.deepEqual(bundle.stateOfCalls, ['relay'], 'status reads the relay projection state once, with the fixed key');
  assert.equal(counts.snapshot, 0, 'projection hot path must not call session.snapshotEvents');

  // relay_phase 的 previous 也来自投影；超预算（420k=organize）按面板一次性默认操作「继续」放行
  updatePanelState(session.id, { defaultOperation: 'continue' });
  const switched = await tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'ship', user_gate: SHIP_GATE }, { agent: { session, options: {} } });
  assert.equal(switched.previous, 'verify');
  assert.equal(switched.phase, 'ship');
  assert.match(switched.reminder, /继续/);
  assert.equal(panelStateOf(session.id).defaultOperation, 'continue', 'mode persists (v0.4.0)');

  // organize：投影 organizeCount=2 → 非 force 拒绝；force 成功且 brief 用投影 goal/exitCriteria
  const refused = await tools.get('relay_organize').execute({ phase: 'verify', brief: 'x' }, { agent: { session, options: {} } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'already-organized');
  const forced = await tools.get('relay_organize').execute({ phase: 'verify', brief: 'x', force: true }, { agent: { session, options: {} } });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  const brief = readFileSync(forced.briefPath, 'utf8');
  assert.match(brief, /投影里的目标/);
  assert.match(brief, /投影里的退出条件/);
  // organize 的 phase/计数/phaseMeta 仍以投影为准；成功压缩后额外扫一次日志派生「手动召回」清单（稀有路径，非热路径）。
  assert.equal(counts.snapshot, 1, 'organize success scans the log once for the manual recall list; hot-path derivation still uses the projection');
});

test('Router P0 度量：relay_status 报执行占比与压缩债务（投影 v3 计数字段）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const projection = {
    phase: 'build', goal: null, exitCriteria: null, organizeCount: 1, compactionEpoch: 1,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: 42, lastContinueActionSeq: 42,
    toolCalls: 57, executionCalls: 3,
  };
  const { session, counts } = countingSnapshotSession({ id: 'session-metrics', cwd });
  const bundle = attachRelayProjection(fakeServices({ session }), projection);
  const report = await applyAgent(bundle.services).tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.deepEqual(report.execution, { calls: 3, total: 57, ratio: 0.053 }, '执行类占比 3/57 四舍五入到 3 位');
  assert.deepEqual(report.compaction, { count: 1, lastSeq: 42, debt: true }, '真实压缩过 → 后续 handoff 源已脏');
  assert.equal(report.organizeCount, 1, '旧字段语义不变');
  assert.match(report.text, /exec: 3\/57 calls \(5\.3%\)/);
  assert.match(report.text, /compaction debt: yes\(1\)/);
  assert.deepEqual(bundle.stateOfCalls, ['relay'], 'status 只读一次投影');
  assert.equal(counts.snapshot, 0, '度量不引入 snapshotEvents 热路径');
});

test('Router P0 度量：无执行/未压缩 → ratio=0、debt=no，text 行稳定可测', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const projection = {
    phase: 'discover', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: -1, lastContinueActionSeq: -1,
    toolCalls: 0, executionCalls: 0,
  };
  const { session } = countingSnapshotSession({ id: 'session-metrics-zero', cwd });
  const bundle = attachRelayProjection(fakeServices({ session }), projection);
  const report = await applyAgent(bundle.services).tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.deepEqual(report.execution, { calls: 0, total: 0, ratio: 0 }, 'total=0 时 ratio=0（不产生 NaN）');
  assert.deepEqual(report.compaction, { count: 0, lastSeq: -1, debt: false });
  assert.match(report.text, /exec: 0\/0 calls \(0\.0%\) · compaction debt: no\(0\)/);
});

test('v0.9.0 批次3 delegation 度量：relay_status 返回 delegation 块（exec/派活/收口/空闲队友/advice/basis）', async () => {
  resetSharedState();
  const members = [
    { id: 'session-member-running', name: 'worker-1', role: 'teammate', status: 'running' },
    { id: 'session-member-idle1', name: 'worker-2', role: 'teammate', status: 'idle' },
    { id: 'session-member-idle2', name: 'worker-3', role: 'teammate', status: 'idle' },
  ];
  const baseProjection = (extra) => ({
    phase: 'build', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: -1, lastContinueActionSeq: -1,
    ...extra,
  });
  const metricsOf = async (id, projection) => {
    const { session } = countingSnapshotSession({ id, cwd: tmpCwd() });
    const bundle = attachRelayProjection(fakeServices({
      session,
      extra: { agentTeams: { tryMembership: () => ({ role: 'lead' }), listMembers: () => members } },
    }), projection);
    return applyAgent(bundle.services).tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  };
  // 正常：3/57=5.3%，已派 2 / 收口 1 → 四规则都不命中（advice 空）
  const normal = await metricsOf('session-delegation-normal', baseProjection({ toolCalls: 57, executionCalls: 3, dispatchCalls: 2, collectCalls: 1 }));
  assert.deepEqual(normal.delegation, {
    execRatio: 0.053,
    calls: { exec: 3, total: 57 },
    dispatchCount: 2,
    collectCount: 1,
    idleWorkers: 2,
    advice: '',
    basis: 'projection',
  });
  assert.match(normal.text, /delegation: Lead 执行 5\.3%（3\/57，目标 ≤20% warn）· 派活 2 \/ 收口 1 · 空闲队友 2/);
  assert.doesNotMatch(normal.text, /delegation-advice/);
  // 规则1：样本不足（toolCalls<10）
  const sample = await metricsOf('session-delegation-sample', baseProjection({ toolCalls: 7, executionCalls: 4, dispatchCalls: 0, collectCalls: 0 }));
  assert.match(sample.delegation.advice, /样本不足（<10 次工具调用）/);
  // 规则2：样本足够且执行占比 >20%
  const over = await metricsOf('session-delegation-over', baseProjection({ toolCalls: 100, executionCalls: 30, dispatchCalls: 0, collectCalls: 0 }));
  assert.equal(over.delegation.execRatio, 0.3);
  assert.match(over.delegation.advice, /Lead 执行占比 30%（30\/100，阈值 20%，warn 档）/);
  // 规则3：占比正常、有 2 个空闲队友且本会话 0 次派活 → text 追加 advice 行
  const idle = await metricsOf('session-delegation-idle', baseProjection({ toolCalls: 20, executionCalls: 1, dispatchCalls: 0, collectCalls: 0 }));
  assert.match(idle.delegation.advice, /有 2 个空闲队友且本会话 0 次 relay_dispatch/);
  assert.match(idle.text, /delegation-advice: 有 2 个空闲队友且本会话 0 次 relay_dispatch/);
  // 投影不可用（旧宿主）：basis=unavailable、计数 0、idleWorkers null 不猜 0、text 如实标注
  const legacySession = fakeSession({ id: 'session-delegation-unavailable', cwd: tmpCwd() });
  const legacy = await applyAgent(fakeServices({ session: legacySession, extra: { agentTeams: undefined } }).services)
    .tools.get('relay_status').execute({}, { agent: { session: legacySession, options: {} } });
  assert.equal(legacy.delegation.basis, 'unavailable');
  assert.deepEqual(legacy.delegation.calls, { exec: 0, total: 0 });
  assert.equal(legacy.delegation.idleWorkers, null, '团队服务不可用 → null，不猜 0');
  assert.match(legacy.text, /（投影不可用，仅参考）/);
  assert.match(legacy.text, /空闲队友 \?/);
});

test('v0.9.0 批次3 build→verify 委派闸门：默认 warn 放行 + delegation/delegationWarning（不阻断）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const id = 'session-deleg-gate-warn';
  await seedRelayLedger(cwd, id, [{ id: 'bp1', title: 'build point', status: 'done' }]);
  const { session } = countingSnapshotSession({ id, cwd });
  const bundle = attachRelayProjection(fakeServices({ session }), {
    phase: 'build', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: -1, lastContinueActionSeq: -1,
    toolCalls: 100, executionCalls: 30,
  });
  const { tools } = applyAgent(bundle.services);
  const result = await tools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } });
  assert.equal(result.phase, 'verify', 'warn 档不阻断 build→verify');
  assert.equal(result.delegation.ok, true);
  assert.equal(result.delegation.execRatio, 0.3);
  assert.deepEqual(result.delegation.calls, { exec: 30, total: 100 });
  assert.deepEqual(result.delegation.warnings.map((warning) => warning.code), ['lead-exec-ratio', 'lead-owned-points']);
  assert.match(result.delegationWarning, /Lead 执行占比 30%/);
  assert.match(result.delegationWarning, /bp1/);
  // 补 lead-exec 证据 + 执行占比正常 → 闸门仍返回 delegation 事实，但 warnings 空、无 delegationWarning
  const cleanCwd = tmpCwd();
  const cleanId = 'session-deleg-gate-clean';
  await seedRelayLedger(cleanCwd, cleanId, [{ id: 'bp1', title: 'build point', status: 'done', evidence: ['lead-exec: 单行修复断链 URL，无 worker 可派'] }]);
  const cleanSession = fakeSession({ id: cleanId, cwd: cleanCwd });
  const cleanBundle = attachRelayProjection(fakeServices({ session: cleanSession }), {
    phase: 'build', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: -1, lastContinueActionSeq: -1,
    toolCalls: 100, executionCalls: 5,
  });
  const clean = await applyAgent(cleanBundle.services).tools.get('relay_phase')
    .execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: { session: cleanSession, options: {} } });
  assert.equal(clean.phase, 'verify');
  assert.deepEqual(clean.delegation.warnings, []);
  assert.equal('delegationWarning' in clean, false);
});

test('v0.9.0 批次3 build→verify 委派闸门：config off 不检查、无字段', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const id = 'session-deleg-gate-off';
  await seedRelayLedger(cwd, id, [{ id: 'bp1', title: 'build point', status: 'done' }]);
  const { session } = countingSnapshotSession({ id, cwd });
  const bundle = attachRelayProjection(fakeServices({ session }), {
    phase: 'build', toolCalls: 100, executionCalls: 30,
  });
  const { tools } = applyAgent(bundle.services, { delegationGate: 'off' });
  const result = await tools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } });
  assert.equal(result.phase, 'verify');
  assert.equal('delegation' in result, false, 'off：不计算、结果无 delegation 字段');
  assert.equal('delegationWarning' in result, false);
});

test('v0.9.0 批次3 build→verify 委派闸门：strict runtime 拒绝且零副作用（v0.10.0 启用路径）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const id = 'session-deleg-gate-strict';
  await seedRelayLedger(cwd, id, [{ id: 'bp1', title: 'build point', status: 'done' }]);
  const ledgerPath = join(cwd, '.scratch', 'context-relay', 'work-items', id + '.json');
  const ledgerBefore = readFileSync(ledgerPath, 'utf8');
  const panelBefore = panelStateOf(id);
  const { session } = countingSnapshotSession({ id, cwd });
  const { services } = fakeServices({ session });
  services.sessionProjections.stateOf = () => ({
    phase: 'build', toolCalls: 100, executionCalls: 30,
  });
  const tools = directRelayTools(services, { delegation: { gate: 'strict', requestedStrict: true } });
  await assert.rejects(
    tools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: { session, options: {} } }),
    /relay_phase refused \(delegation gate\)/,
  );
  assert.equal(readFileSync(ledgerPath, 'utf8'), ledgerBefore, 'strict 拒绝路径不改台账');
  assert.deepEqual(panelStateOf(id), panelBefore, 'strict 拒绝路径不写面板');
  assert.equal(readWorkItems(cwd, { scopeId: id }).currentPhase, null, 'phase 未切换（台账 currentPhase 未写）');
});

test('v0.9.0 批次3 非 build→verify 不检查闸门；ship 结果带 delegation 快照（用户汇报素材）', async () => {
  resetSharedState();
  // 1) discover→build：非 build→verify 边，不产出 delegation 闸门字段/警告
  const discoverCwd = tmpCwd();
  const discoverSession = fakeSession({ id: 'session-deleg-nongate', cwd: discoverCwd });
  const discoverBundle = attachRelayProjection(fakeServices({ session: discoverSession }), {
    phase: 'discover', toolCalls: 120, executionCalls: 40,
  });
  const discover = await applyAgent(discoverBundle.services).tools.get('relay_phase')
    .execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session: discoverSession, options: {} } });
  assert.equal(discover.phase, 'build');
  assert.equal('delegationWarning' in discover, false);
  assert.equal('delegation' in discover, false);
  // 2) verify→ship：成功结果带 delegation 快照（与 relay_status 同块；advisory，不机械校验 report）
  const shipCwd = tmpCwd();
  const shipId = 'session-deleg-ship';
  const shipSession = fakeSession({ id: shipId, cwd: shipCwd });
  const shipBundle = attachRelayProjection(fakeServices({ session: shipSession }), {
    phase: 'verify', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: -1, lastContinueActionSeq: -1,
    toolCalls: 57, executionCalls: 3, dispatchCalls: 2, collectCalls: 1,
  });
  const ship = await applyAgent(shipBundle.services).tools.get('relay_phase')
    .execute({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }, { agent: { session: shipSession, options: {} } });
  assert.equal(ship.phase, 'ship');
  assert.deepEqual(ship.delegation, {
    execRatio: 0.053,
    calls: { exec: 3, total: 57 },
    dispatchCount: 2,
    collectCount: 1,
    idleWorkers: 0,
    advice: '',
    basis: 'projection',
  });
  assert.equal('delegationWarning' in ship, false, 'ship 委派统计 advisory：不产 warning');
});

test('v0.9.0 批次3 集成：build 分点全流程 dispatch→回执→collect→台账 done（Lead 无 write/edit/bash）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const leadSessionId = 'session-int-lead';
  const worker = { id: 'session-int-worker', name: 'worker-1', role: 'teammate', status: 'idle' };
  const sent = [];
  const legacyTeams = {
    tryMembership(agent) {
      const id = agent?.session?.id;
      if (id === leadSessionId) return { role: 'lead' };
      if (id === worker.id) return { role: 'teammate', name: worker.name };
      return undefined;
    },
    listMembers() { return [worker]; },
    sendMessage(caller, request) { sent.push({ caller, request }); return { messageId: 'm-int-1' }; },
  };
  const session = fakeSession({ id: leadSessionId, cwd });
  const projection = {
    phase: 'discover', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: null, lastNoticeSeq: -1, lastCompactionSeq: -1, lastContinueActionSeq: -1,
    toolCalls: 20, executionCalls: 0, dispatchCalls: 1, collectCalls: 1,
  };
  const bundle = attachRelayProjection(fakeServices({
    session,
    extra: {
      agentTeams: legacyTeams,
      sessionQuery: {
        async observeSession() {
          return { projections: { values: { contextPressure: { projectedTokens: 10000, contextWindow: 100000 } } }, [Symbol.dispose]() {} };
        },
      },
    },
  }), projection);
  const { tools, events } = applyAgent(bundle.services);
  const created = events.find((entry) => entry.name === 'agent/created');
  assert.ok(created, 'agent/created 监听已注册');
  const { agent: rootAgent, registered, restricted } = rootLeadHarness({ sessionId: leadSessionId, cwd });
  await created.listener({ agent: rootAgent });
  // root Lead 工具面：执行类工具被裁；派活/收口工具以 Lead-only agent-scope 注册
  for (const name of ROUTER_DENY_TOOLS) {
    assert.ok(restricted.includes(name), name + ' 必须被 root restrict 裁掉');
    assert.ok(!registered.has(name), name + ' 不得出现在 Lead 的 agent-scope 工具面');
  }
  for (const name of ['relay_dispatch', 'relay_collect']) assert.ok(registered.has(name), name + ' 已注册');
  const flow = [];
  const call = async (tool, args, name) => { flow.push(name); return tool.execute(args, { agent: rootAgent }); };
  // 1) 建 build 分点（台账）
  const opened = await call(tools.get('relay_phase'), { phase: 'build', design_gate: DESIGN_GATE, items: ['wire metrics'], contract_check: CONTRACT_CHECK }, 'relay_phase');
  assert.deepEqual(opened.ledger.opened, ['wire-metrics']);
  // 2) 派活：复用空闲 worker + 标准 5 字段 brief + 台账 doing+owner
  const dispatched = await call(registered.get('relay_dispatch'), {
    itemId: 'wire-metrics',
    brief: '把 delegation 度量接进 relay_status 并补测试',
    docs: ['.scratch/context-relay/architecture/v090-batch3.md §2.2', 'test/agent.test.mjs'],
    writeScope: ['lib/agent/tools.js', 'test/agent.test.mjs'],
    acceptance: 'node --test test/agent.test.mjs',
  }, 'relay_dispatch');
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  assert.equal(dispatched.worker.name, 'worker-1');
  assert.equal(dispatched.worker.reused, true);
  assert.equal(sent.length, 1, 'brief 已发给 worker');
  const brief = sent[0].request.content[0].text;
  for (const field of ['1) 目标：', '2) 必读', '3) 写范围', '4) 验收', '5) 回执：']) assert.ok(brief.includes(field), 'brief 含 ' + field);
  assert.ok(brief.includes(dispatched.reportPath), 'brief 含 reportPath');
  assert.ok(brief.includes(dispatched.dispatchId), 'brief 含 dispatchId');
  const doingItem = readWorkItems(cwd, { scopeId: leadSessionId }).items.find((item) => item.id === 'wire-metrics');
  assert.equal(doingItem.status, 'doing');
  assert.equal(doingItem.owner, 'worker-1');
  assert.ok(doingItem.next.includes(dispatched.reportPath), '台账 next 指向回执路径');
  // 3) fake worker 按回执契约写盘（头 3 行 + 结论节）
  const reportAbs = join(cwd, dispatched.reportPath);
  mkdirSync(dirname(reportAbs), { recursive: true });
  writeFileSync(reportAbs, 'task: wire-metrics\nrevision: ' + dispatched.dispatchId + '\nverdict: done\n\n## 结论\n度量接线完成，测试全绿。\n\n## 证据\ntest/agent.test.mjs:1\n');
  // 4) 收口：只回 digest；台账 done + evidence=reportPath
  const collected = await call(registered.get('relay_collect'), { itemId: 'wire-metrics', dispatchId: dispatched.dispatchId }, 'relay_collect');
  assert.equal(collected.ok, true, JSON.stringify(collected));
  assert.equal(collected.status, 'collected');
  assert.equal(collected.verdict, 'done');
  assert.match(collected.digest, /度量接线完成/);
  assert.ok(!collected.text.includes('## 证据'), 'collect 只回 digest，不返回报告正文');
  const doneItem = readWorkItems(cwd, { scopeId: leadSessionId }).items.find((item) => item.id === 'wire-metrics');
  assert.equal(doneItem.status, 'done');
  assert.deepEqual(doneItem.evidence, [dispatched.reportPath]);
  assert.equal(doneItem.next, null);
  // 5) 全程 Lead 只调 relay_*（执行类工具已被裁）
  assert.ok(flow.every((name) => name.startsWith('relay_')), 'flow 只调 relay_*：' + flow.join(','));
  for (const name of ['bash', 'pwsh', 'write', 'edit']) assert.ok(!flow.includes(name), 'flow 无 ' + name);
  // 6) execRatio 不升：派活/收口是 relay_*（投影 v5 成功计数），不计执行类
  const status = await tools.get('relay_status').execute({}, { agent: { session: rootAgent.session, options: {} } });
  assert.equal(status.execution.calls, 0);
  assert.equal(status.delegation.calls.exec, 0);
  assert.equal(status.delegation.execRatio, 0);
  assert.equal(status.delegation.dispatchCount, 1);
  assert.equal(status.delegation.collectCount, 1);
});

test('projection unavailable or throwing falls back to log scanning', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [
    { type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_phase', arguments: { phase: 'build' } } },
    { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_organize', arguments: {}, isError: false, content: [{ type: 'text', text: 'organized: freed 5 tokens' }] } },
  ];
  const pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  // 1) stateOf 抛错 → 回退日志派生
  const throwingSession = fakeSession({ id: 'session-projection-throw', cwd, log });
  const throwing = fakeServices({ session: throwingSession, pressure });
  throwing.services.sessionProjections.stateOf = () => { throw new Error('projection boom'); };
  const throwingReport = await applyAgent(throwing.services).tools.get('relay_status').execute({}, { agent: { session: throwingSession, options: {} } });
  assert.equal(throwingReport.phase, 'build');
  assert.equal(throwingReport.organizeCount, 1);
  // 2) 旧宿主：投影服务只有 snapshot、没有 stateOf → 回退日志派生
  const legacySession = fakeSession({ id: 'session-projection-legacy', cwd, log });
  const legacyReport = await applyAgent(fakeServices({ session: legacySession, pressure }).services).tools.get('relay_status').execute({}, { agent: { session: legacySession, options: {} } });
  assert.equal(legacyReport.phase, 'build');
  assert.equal(legacyReport.organizeCount, 1);
  // 3) 投影 state 非对象（单元未注册）→ 回退日志派生
  const missingSession = fakeSession({ id: 'session-projection-missing', cwd, log });
  const missing = fakeServices({ session: missingSession, pressure });
  missing.services.sessionProjections.stateOf = () => undefined;
  const missingReport = await applyAgent(missing.services).tools.get('relay_status').execute({}, { agent: { session: missingSession, options: {} } });
  assert.equal(missingReport.phase, 'build');
  assert.equal(missingReport.organizeCount, 1);
});

test('reminders: 投影 noticeBand/lastCompactionSeq 驱动 seed 与重新武装', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const { session, counts } = countingSnapshotSession({ id: 'session-projection-sentinel', cwd });
  const projection = { phase: 'build', organizeCount: 0, compactionEpoch: 1, noticeBand: 'organize', lastNoticeSeq: 7, lastCompactionSeq: 5 };
  const bundle = attachRelayProjection(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } }), projection);
  const listener = preStepListener(applyAgent(bundle.services).events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  // 已有 organize 档提醒（同段内）→ warn 档被抑制
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 0, 'notice in the same segment suppresses lower band');
  // 投影推进到新段（notice 落在旧段）→ 重新武装：warn 提醒一次
  projection.compactionEpoch = 2;
  projection.lastCompactionSeq = 9;
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, 'a new segment re-arms the warn band');
  assert.match(injected[0].source.summary, /band=warn/);
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 1, 'same band dedupes once');
  // 只向上跨档：relay 档提醒一次
  bundle.services.sessionProjections.snapshot = () => ({ values: { contextPressure: { contextWindow: 1_000_000, projectedTokens: 520_000 } } });
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 2, 'upward band still reminds once');
  assert.match(injected[1].source.summary, /band=relay/);
  await listener({ agent }, async () => undefined);
  assert.equal(injected.length, 2, 'same band dedupes once');
  assert.equal(counts.snapshot, 0, 'reminder projection path avoids snapshotEvents');

  // 旧段 notice 不再抑制新段（重新武装）
  const stale = fakeSession({ id: 'session-projection-stale', cwd });
  const staleProjection = { phase: 'build', organizeCount: 0, compactionEpoch: 5, noticeBand: 'relay', lastNoticeSeq: 3, lastCompactionSeq: 4 };
  const staleListener = preStepListener(applyAgent(attachRelayProjection(fakeServices({ session: stale, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } }), staleProjection).services).events);
  const staleInjected = [];
  await staleListener({ agent: { session: stale, inject(message) { staleInjected.push(message); } } }, async () => undefined);
  assert.equal(staleInjected.length, 1, 'old-segment notice no longer suppresses the new segment');
  assert.match(staleInjected[0].source.summary, /band=warn/);
});

test('relay_handoff best-effort disposes half-created sessions and reports halfCreated (P2#1)', async () => {
  resetSharedState();
  // 1) findLive 超时：controller 已建会话但 agents.list 找不到 live → dispose 一次 + halfCreated
  const cwd = tmpCwd();
  const disposedLive = [];
  const timeoutCaller = fakeSession({ id: 'session-half-timeout', cwd });
  const timeoutTools = applyAgent(fakeServices({
    session: timeoutCaller,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-half-1' }; } },
      agents: {
        list: () => [],
        get(sessionId) { return { dispose() { disposedLive.push(sessionId); } }; },
      },
      sessionTitle: { rename() {} },
    },
  }).services).tools;
  const timedOut = await timeoutTools.get('relay_handoff').execute({ status: { goal: 'half timeout' }, human_approved: true }, { agent: { session: timeoutCaller, options: {} } });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'session-not-live');
  assert.equal(timedOut.halfCreated, true);
  assert.deepEqual(disposedLive, [], 'agents.get returns bare Agent, not an owned disposer');
  assert.ok(timedOut.recovery.length > 0);
  assert.match(timedOut.summary, /reuse retained destination/);

  // 2) followup 失败：会话 live 但首条消息发不出去 → dispose 一次 + halfCreated + 重试指引
  const followupCwd = tmpCwd();
  const disposedFollowup = [];
  const followupCaller = fakeSession({ id: 'session-half-followup', cwd: followupCwd });
  const live = { id: 'session-half-2', header: { cwd: followupCwd }, requestHeader: () => undefined };
  const followupTools = applyAgent(fakeServices({
    session: followupCaller,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-half-2' }; } },
      agents: {
        list: () => [{ session: live, status: 'idle', followup() { throw new Error('dispatch boom'); } }],
        get(sessionId) { return { dispose() { disposedFollowup.push(sessionId); } }; },
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  }).services).tools;
  const followupFail = await followupTools.get('relay_handoff').execute({ status: { goal: 'half followup' }, human_approved: true }, { agent: { session: followupCaller, options: {} } });
  assert.equal(followupFail.ok, false);
  assert.equal(followupFail.code, 'followup-failed');
  assert.equal(followupFail.halfCreated, true);
  assert.deepEqual(disposedFollowup, [], 'bare Agent.dispose is not a public API');
  assert.ok(followupFail.recovery.length > 0);
  assert.match(followupFail.summary, /Retry relay_handoff/);

  // 3) 无 agents.get/dispose：跳过清理且不阻断返回（best-effort）
  const noGetCwd = tmpCwd();
  const noGetCaller = fakeSession({ id: 'session-half-noget', cwd: noGetCwd });
  const liveNoGet = { id: 'session-half-3', header: { cwd: noGetCwd }, requestHeader: () => undefined };
  const noGetTools = applyAgent(fakeServices({
    session: noGetCaller,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-half-3' }; } },
      agents: { list: () => [{ session: liveNoGet, status: 'idle', followup() { throw new Error('nope'); } }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  }).services).tools;
  const noGet = await noGetTools.get('relay_handoff').execute({ status: { goal: 'no get' }, human_approved: true }, { agent: { session: noGetCaller, options: {} } });
  assert.equal(noGet.ok, false);
  assert.equal(noGet.code, 'followup-failed');
  assert.equal(noGet.halfCreated, true);
});

test('live sidebar settings: 只剩 threshold；超预算切 phase 由面板而非侧栏开关决定', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-live-settings', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 400_000 } });
  const { tools } = applyAgent(services);
  assert.equal((await tools.get('relay_status').execute({}, { agent: { session, options: {} } })).lead.band, 'organize');
  // 侧栏旧字段（autoPhase/autoHandoff/autoContinue）一律忽略：只剩 threshold 生效
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 70, autoPhase: true, autoHandoff: true, autoContinue: true };
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.lead.band, 'ok', 'sidebar threshold 70% moves 40% usage into the ok band');
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40 };
  // 超预算 + 未预设面板 → relay_phase 抛错（旧 autoPhase 已不存在）
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session, options: {} } }), /relay_phase refused/);
  // 面板一次性默认操作「继续」→ 放行
  updatePanelState(session.id, { defaultOperation: 'continue' });
  const switched = await tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session, options: {} } });
  assert.equal(switched.phase, 'build');
  assert.match(switched.reminder, /继续/);
  resetSharedState();
});

test('approval gate: phase 不审批；预设不产生豁免；autoHandoff/autoCompress/authorizeNext 免审；注定被拒不弹窗', async () => {
  resetSharedState();
  const approval = { requests: [], async request(input) { this.requests.push(input); return 'allowed-once'; } };
  const session = fakeSession({ id: 'session-panel-gate', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, extra: { approval } });
  const { events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const next = async () => ({ kind: 'allow' });
  // 1) relay_phase 不再有官方审批（即使超预算）
  const phaseExec = { name: 'relay_phase', arguments: { phase: 'build' }, callId: 'c2', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(phaseExec, next)).kind, 'allow');
  // 2) handoff：默认 ask；autoHandoff=true → allow；面板预设不产生豁免（rev5.5）
  const handoffExec = { name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'c3', agent: { session }, signal: new AbortController().signal };
  const asked = await gate(handoffExec, next);
  assert.equal(asked.kind, 'ask');
  assert.match(asked.reason, /human Go\/No-go/);
  updatePanelState(session.id, { autoHandoff: true });
  assert.equal((await gate(handoffExec, next)).kind, 'allow');
  updatePanelState(session.id, { autoHandoff: false, defaultOperation: 'handoff' });
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '一次性预设只决定做什么，不产生审批豁免');
  updatePanelState(session.id, { defaultOperation: null, authorizeNext: true });
  assert.equal((await gate(handoffExec, next)).kind, 'allow', 'authorizeNext 一次性免审');
  // 3) 二次 organize（force=true 且已压缩过）：默认 ask；autoCompress=true → allow
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const secondSession = fakeSession({ id: 'session-panel-gate-organize', cwd: tmpCwd(), log: organizedLog });
  const secondExec = { name: 'relay_organize', arguments: { phase: 'build', force: true }, callId: 'c4', agent: { session: secondSession }, signal: new AbortController().signal };
  assert.equal((await gate(secondExec, next)).kind, 'ask');
  updatePanelState(secondSession.id, { autoCompress: true });
  assert.equal((await gate(secondExec, next)).kind, 'allow');
  // rev5.4：首次 compress（organizeCount=0）也要 ask；autoCompress=true → allow
  const freshSession = fakeSession({ id: 'session-panel-gate-fresh', cwd: tmpCwd() });
  const freshExec = { ...secondExec, arguments: { phase: 'build' }, agent: { session: freshSession } };
  assert.equal((await gate(freshExec, next)).kind, 'ask');
  updatePanelState(freshSession.id, { autoCompress: true });
  assert.equal((await gate(freshExec, next)).kind, 'allow');
  // 4) subagent 的 organize/handoff 注定 lead-only → 不弹审批，交给工具体返回结构化拒绝
  const subSession = fakeSession({ id: 'session-panel-gate-sub', header: { origin: 'subagent' } });
  const subHandoff = { ...handoffExec, agent: { session: subSession } };
  const subOrganize = { ...secondExec, agent: { session: subSession } };
  assert.equal((await gate(subHandoff, next)).kind, 'allow', 'subagent handoff 注定 lead-only，不弹审批');
  assert.equal((await gate(subOrganize, next)).kind, 'allow', 'subagent organize 注定 lead-only，不弹审批');
  resetSharedState();
});

test('面板默认操作出现在到线提醒与 relay_status 建议里；autoChoose/autoDecision 退役（D8=A）', async () => {
  // ① 旧 autoChoose/autoDecision 存储值归一退役：advice/提醒不再有模型自决档，退回「问我」
  resetSharedState();
  const session = fakeSession({ id: 'session-panel-advice-auto', seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, events } = applyAgent(bundle.services);
  updatePanelState(session.id, { autoChoose: true, authorizeNext: true, autoDecision: { operation: 'handoff', at: 1 } });
  for (const key of ['autoChoose', 'autoDecision']) {
    assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), key), false, '退役字段不得出现：' + key);
  }
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.match(report.advice, /继续 \/ 压缩继续 \/ 接力新会话/);
  assert.match(report.advice, /composer「接力」chip/);
  assert.doesNotMatch(report.advice, /autoChoose=on|模型自决档|next_operation/, '退役档不再出现在 advice');
  const listener = preStepListener(events);
  const injected = [];
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.match(text, /模式=问我/, '退役后按未设模式展示');
  assert.match(text, /authorizeNext=on/);
  assert.doesNotMatch(text, /autoChoose=on/, 'autoChoose 退役不再显示 on');
  assert.doesNotMatch(text, /autoChoose/, 'P2-2：模型可见面板行不再出现退役字段 autoChoose');
  assert.doesNotMatch(text, /已记录操作=/, 'autoDecision 退役后不再展示');
  assert.ok(text.length <= 500, 'notice chars ' + text.length);
  // ② 人类模式：提醒读回「模式=压缩」
  resetSharedState();
  const presetSession = fakeSession({ id: 'session-panel-advice-preset', seq: 0 });
  const presetBundle = fakeServices({ session: presetSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const preset = applyAgent(presetBundle.services);
  updatePanelState(presetSession.id, { defaultOperation: 'compress' });
  const presetInjected = [];
  presetBundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await preStepListener(preset.events)({ agent: { session: presetSession, inject(message) { presetInjected.push(message); } } }, async () => undefined);
  assert.equal(presetInjected.length, 1);
  const presetText = presetInjected[0].content[0].text;
  assert.match(presetText, /模式=压缩/);
  assert.doesNotMatch(presetText, /autoChoose=on/);
  resetSharedState();
});

test('handoff 授权闭环：「授权下一次操作」免审 → 接力成功后消费；面板预设不再自带免审（rev5.5）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-preauth', cwd, seq: 0 });
  const liveSession = { id: 'session-preauth-new', header: { cwd }, requestHeader: () => undefined };
  const { services } = fakeServices({
    session,
    pressure: { contextWindow: 1_000_000, projectedTokens: 520_000 },
    extra: {
      approval: { async request() { return 'allowed-once'; } },
      sessionController: { async create() { return { sessionId: 'session-preauth-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools, events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const next = async () => ({ kind: 'allow' });
  const handoffExec = { name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'c1', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '未预授权时仍问人');
  // relay_phase 超预算 + 面板预设「接力」→ 不切换、抛错；预设只决定操作、不再自带免审，且保留到接力成功
  updatePanelState(session.id, { defaultOperation: 'handoff' });
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session, options: {} } }), /relay_handoff/);
  assert.equal(panelStateOf(session.id).defaultOperation, 'handoff', 'B-P2-3：接力预设保留到成功路径消费');
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '预设不再自动免审');
  // 人类在面板点「授权下一次操作」→ 一次性免审
  updatePanelState(session.id, { authorizeNext: true });
  assert.equal((await gate(handoffExec, next)).kind, 'allow', '一次性授权免审批');
  const result = await tools.get('relay_handoff').execute({ status: { goal: 'authorized relay' }, human_approved: true }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(panelStateOf(session.id).authorizeNext, false, '接力成功后一次性授权被消费');
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '消费后再次接力需要审批');
  resetSharedState();
});

test('relay_* 工具调用后发布面板实时状态（composer chip 数据源）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-live-publish', cwd, seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction: { async compactIfNeeded() { return { shadowedTokenCount: 1 }; } } });
  const { tools } = applyAgent(services);
  assert.equal(liveStateOf(session.id), undefined, '没有 step/工具调用前不发布');
  await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  let live = liveStateOf(session.id);
  assert.equal(live.band, 'organize');
  assert.equal(live.overBudget, true);
  assert.equal(live.phase, 'discover');
  // 超预算 + 未预设 → relay_phase 抛错也会刷新 live（phase 仍是 discover）
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session, options: {} } }));
  live = liveStateOf(session.id);
  assert.equal(live.phase, 'discover');
  assert.equal(live.band, 'organize');
  // organize 成功后刷新 live
  const organized = await tools.get('relay_organize').execute({ phase: 'discover', brief: 'x', force: true }, { agent: { session, options: {} } });
  assert.equal(organized.ok, true);
  assert.ok(liveStateOf(session.id).updatedAt >= live.updatedAt);
  assert.equal(liveStateOf(session.id).phase, 'discover');
  resetSharedState();
});

test('v0.9.0 面板预设「压缩→新会话」退役（MIG4/D8=A）：侧栏/面板旧值归一「问我」，超预算问人类（不再两段式）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [];
  const session = fakeSession({ id: 'session-cth-two-stage', cwd, log });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  // 侧栏默认值（未改过面板的会话）：cth 载入即归一 null（问我）。
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff' };
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const call = (args = {}) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE, ...args }, { agent });
  assert.equal(panelStateOf(session.id).defaultOperation, null, '侧栏默认 cth 归一 null（问我）');
  // 未设模式 → 问人类（一次问清、附推荐与默认）；拒绝零副作用、无两段式指令
  await assert.rejects(call(), (error) => /问人类/.test(error.message) && /composer 面板/.test(error.message));
  assert.equal(panelStateOf(session.id).defaultOperation, null, '拒绝后仍 null');
  assert.equal(panelStateOf(session.id).authorizeNext, false, '预设不产生授权');
  assert.equal(injected.length, 0, '拒绝分支零 notice（错误必达）');
  // 压缩成功后（旧 cth 第 2 段场景已不存在）：仍按「问我」处理，不出现两段式指令
  log.push({ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'discover' }, isError: false, content: [{ type: 'text', text: 'organized: freed 321 tokens' }] } });
  await assert.rejects(call({ phase: 'verify' }), (error) => /问人类/.test(error.message) && !/两段式|第 2\/2 步/.test(error.message));
  assert.equal(panelStateOf(session.id).defaultOperation, null);
  assert.equal(injected.length, 0);
  resetSharedState();
});
test('v0.9.0 旧「压缩→新会话」预设不产生两段式/免审（D8=A）；接力按 rev5.5 授权模型成功并消费', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // 本会话已成功压缩过一次：旧 cth 预设若仍存在会命中第 2 段——退役后应归一「问我」。
  const log = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'discover' }, isError: false, content: [{ type: 'text', text: 'organized: freed 100 tokens' }] } }];
  const session = fakeSession({ id: 'session-cth-e2e', cwd, log });
  const liveSession = { id: 'session-cth-new', header: { cwd }, requestHeader: () => undefined };
  const { services } = fakeServices({
    session,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    extra: {
      approval: { async request() { return 'allowed-once'; } },
      sessionController: { async create() { return { sessionId: 'session-cth-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-1', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools, events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const next = async () => ({ kind: 'allow' });
  const handoffExec = { name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'c1', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '未授权时仍问人');

  updatePanelState(session.id, { defaultOperation: 'compress-then-handoff' });
  assert.equal(panelStateOf(session.id).defaultOperation, null, '旧 cth 归一 null（问我）');
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  // 旧 cth 归一「问我」后：超预算 relay_phase 仍是问人类（不再有第 2/2 段指令）
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent }),
    (error) => /问人类/.test(error.message) && !/第 2\/2 步/.test(error.message));
  assert.equal(panelStateOf(session.id).defaultOperation, null, '归一后保持 null');
  assert.equal(panelStateOf(session.id).authorizeNext, false, '预设不再自带免审');
  assert.equal(injected.length, 0, '拒绝分支只 throw，不再注入 notice');
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '预设不自动免审');

  // 人类点「授权下一次操作」→ 一次性免审 → 接力成功只消费一次性授权（模式不继承）
  updatePanelState(session.id, { authorizeNext: true });
  assert.equal((await gate(handoffExec, next)).kind, 'allow', '一次性授权免审批');
  const result = await tools.get('relay_handoff').execute({ status: { goal: 'single relay' }, human_approved: true }, { agent });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(panelStateOf(session.id).authorizeNext, false, '接力成功后一次性授权被消费');
  assert.equal(panelStateOf(session.id).defaultOperation, null, '旧 cth 不再保留');
  assert.equal(panelStateOf('session-cth-new').defaultOperation, null, '新会话不继承旧模式（强制继承已删）');
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '消费后再次接力需要审批');
  resetSharedState();
});
test('v0.9.0 两段式闸门退役（D8=A）：旧 cth 预设归一「问我」，交接走正常路径、不再返回 two-stage-not-due', async () => {
  resetSharedState();
  const organized = { type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } };
  // 旧 cth 预设 + 已压缩 + 各档压力（含旧「未到线」场景）：归一 null 后交接正常成功（无预判拒绝）
  const cases = [
    ['ok', { contextWindow: 1_000_000, projectedTokens: 20_000 }],
    ['warn', { contextWindow: 1_000_000, projectedTokens: 360_000 }],
    ['organize', { contextWindow: 1_000_000, projectedTokens: 420_000 }],
    ['relay', { contextWindow: 1_000_000, projectedTokens: 600_000 }],
  ];
  for (const [index, [band, pressure]] of cases.entries()) {
    const h = handoffPanelHarness({ oldId: 'session-two-stage-retired-' + index, newId: 'session-two-stage-retired-new-' + index, log: [organized], pressure });
    updatePanelState(h.session.id, { defaultOperation: 'compress-then-handoff' });
    assert.equal(panelStateOf(h.session.id).defaultOperation, null, band + '：旧 cth 归一 null');
    const result = await h.handoff('retired two-stage ' + band);
    assert.equal(result.ok, true, band + ': ' + JSON.stringify(result));
    assert.equal(result.code, undefined, band + '：不再返回 two-stage-not-due');
    assert.equal(panelStateOf(h.session.id).handedOff, true, band + '：接力成功');
  }
  // 侧栏默认 cth 同样归一 null：交接正常成功（不再被两段式闸门拒绝）
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff' };
  const h = handoffPanelHarness({ oldId: 'session-two-stage-settings', newId: 'session-two-stage-settings-new', log: [organized], pressure: { contextWindow: 1_000_000, projectedTokens: 20_000 } });
  assert.equal(panelStateOf(h.session.id).defaultOperation, null, '侧栏默认 cth 归一 null');
  const result = await h.handoff('settings default');
  assert.equal(result.ok, true, JSON.stringify(result));
  resetSharedState();
});
test('v0.9.0 面板状态文本：cth 档退役（归一「问我」），到线提醒/advice/错误文案都不出现已移除档位；旧挡位回归', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-cth-labels', cwd });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, events } = applyAgent(services);
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff' };

  // relay_status advice：cth 归一后按「问我」展示
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.doesNotMatch(report.advice, /压缩→新会话/, 'advice 不出现已移除档位');
  assert.match(report.advice, /问我/);

  // 到线提醒（升线）：模式「问我」
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  await preStepListener(events)({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /模式「问我」/);
  assert.doesNotMatch(injected[0].content[0].text, /压缩→新会话/);

  // 拒绝分支只 throw：问人类文案同样不出现已移除档位（不再注入 notice）
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent }),
    (error) => /问人类/.test(error.message) && !/压缩→新会话/.test(error.message));
  assert.equal(injected.length, 1, '拒绝分支不再追加 phase 边界 notice');

  // 旧挡位回归：compress 仍是单段「压缩」语义（B-P2-3：预设保留到 organize 成功，不预授权接力）
  resetSharedState();
  const oldSession = fakeSession({ id: 'session-old-compress', cwd: tmpCwd() });
  const old = fakeServices({
    session: oldSession,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    compaction: { async compactIfNeeded() { return { shadowedTokenCount: 2 }; } },
  });
  const oldTools = applyAgent(old.services).tools;
  updatePanelState(oldSession.id, { defaultOperation: 'compress' });
  await assert.rejects(oldTools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session: oldSession, options: {} } }), /relay_organize/);
  assert.equal(panelStateOf(oldSession.id).defaultOperation, 'compress', 'relay_phase 拒绝不改模式');
  const oldOrganized = await oldTools.get('relay_organize').execute({ phase: 'discover', brief: 'x' }, { agent: { session: oldSession, options: {}, inject() {} } });
  assert.equal(oldOrganized.organized, true);
  assert.equal(panelStateOf(oldSession.id).defaultOperation, 'compress', 'organize 成功后模式保持');
  assert.equal(panelStateOf(oldSession.id).authorizeNext, false, 'compress 不得预授权接力');
  // continue 旧分支不受新挡位影响
  updatePanelState(oldSession.id, { defaultOperation: 'continue' });
  const switched = await oldTools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'verify' }, { agent: { session: oldSession, options: {} } });
  assert.equal(switched.phase, 'verify');
  assert.match(switched.reminder, /继续/);
  resetSharedState();
});
test('relay_phase: discover/decide 必须写 exit_criteria（仅 crossing；A-11 同 phase 重声明不强制）', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-acceptance', seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const call = (args) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {}, inject() {} } });
  // 先切到 build（build/verify/ship 不强制 exit_criteria）。
  const build = await call({ phase: 'build', design_gate: DESIGN_GATE });
  assert.equal(build.phase, 'build', 'build 不强制 exit_criteria');
  await assert.rejects(call({ phase: 'discover', goal: 'x' }), /exit_criteria/, 'crossing 进 discover 缺验收口径必须拒绝');
  await assert.rejects(call({ phase: 'discover', goal: 'x', exit_criteria: '   ' }), /exit_criteria/, '空白 exit_criteria 不算');
  await assert.rejects(call({ phase: 'decide', goal: 'y' }), /exit_criteria/, 'crossing 进 decide 同样必填');
  // C7/A-11：同 phase 重声明不再强制 exit_criteria；C10 起 next_operation 参数已删（传入也不回显/不写面板）。
  const same = await call({ phase: 'build' });
  assert.equal(same.phase, 'build');
  assert.equal(same.previous, 'build');
  const legacyArg = await call({ phase: 'build', next_operation: 'compress' });
  assert.equal('next_operation' in legacyArg, false, 'next_operation 死路径已删（不再回显）');
  assert.equal('next_operation_ignored' in legacyArg, false, '不再有 ignored 回显');
  const ok = await call({ phase: 'discover', goal: 'x', exit_criteria: '报告落盘且含证据，doc_lint 通过' });
  assert.equal(ok.phase, 'discover');
  // v0.9.0 P2（D5=A）：goal/exit_criteria 是入参回显，已从结果删除（真源在台账 currentPhase/投影/入参本身）。
  assert.equal('goal' in ok, false, 'P2：goal 回显已删除');
  assert.equal('exit_criteria' in ok, false, 'P2：exit_criteria 回显已删除');
});

test('v0.9.0 P2：relay_phase 成功结果带人类可读 text，output.render 只回 text（非 JSON）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-p2-text', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const tool = tools.get('relay_phase');
  // C9：非 ship 缺 contract_check 不再 warning；text 仍锁定 phase/design/ledger 行前缀（模型只看 text，要点不得丢）。
  const result = await tool.execute({ phase: 'build', design_gate: DESIGN_GATE }, { agent });
  assert.equal(result.phase, 'build');
  assert.equal(typeof result.text, 'string', '成功结果带 text');
  assert.match(result.text, /^phase: build（discover → build）/m);
  assert.match(result.text, /^design: 设计门已过（用户已确认）· /m);
  assert.match(result.text, /^ledger: /m);
  assert.doesNotMatch(result.text, /^warnings: /m, '非 ship 缺 contract_check 不再 warning');
  assert.ok(!result.text.startsWith('{'), 'text 不是 JSON 包络');
  const rendered = tool.output.render({}, result);
  assert.deepEqual(rendered, [{ type: 'text', text: result.text }], 'render 直接返回 text（模型唯一可见通道）');
  assert.ok(!rendered[0].text.startsWith('{'), 'render 非 JSON');
  // 防御性 fallback：无 text 的旧值仍回 JSON（不丢结构化事实）。
  assert.equal(tool.output.render({}, { phase: 'build' })[0].text, JSON.stringify({ phase: 'build' }));
  // 同 phase 声明：只输出少量行（≤300）。
  const same = await tool.execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent });
  assert.ok(same.text.length <= 300, '同 phase 文本 ≤300，实际 ' + same.text.length);
  assert.match(same.text, /^summary: phase → build \(was build\)/m);
});

test('v0.9.0 P2：goal/exit_criteria 删除，budget/context/ledger/user_gate/delegation/lessons/hint 字段保留', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-p2-fields', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {}, inject() {} };
  const call = (args) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, ...args }, { agent });
  const build = await call({ phase: 'build', design_gate: DESIGN_GATE });
  assert.equal(build.phase, 'build');
  for (const field of ['budget', 'context', 'ledger', 'lessons']) assert.ok(field in build, 'P2 保留字段: ' + field);
  // discover 带退出条件回到主链：hint 行/字段仍在，但 goal/exit_criteria 回显删除。
  const discover = await call({ phase: 'discover', goal: '目标是 G', exit_criteria: '口径是 E' });
  assert.equal(discover.phase, 'discover');
  assert.ok('hint' in discover, 'PHASE_HINTS 提示保留');
  for (const field of ['goal', 'exit_criteria']) assert.equal(field in discover, false, 'P2 删除入参回显: ' + field);
  assert.match(discover.text, /^hint: discover：/m);
  await call({ phase: 'build', design_gate: DESIGN_GATE });
  await call({ phase: 'verify' });
  const ship = await call({ phase: 'ship', user_gate: SHIP_GATE });
  assert.equal(ship.phase, 'ship');
  assert.equal(ship.user_gate.review, 'done', 'user_gate 只回摘要（review=done）');
  assert.equal(typeof ship.user_gate.reportChars, 'number');
  assert.ok('delegation' in ship, 'ship 带 delegation 快照（P2 保留）');
  assert.equal('goal' in ship, false, 'ship 的 goal 回显已删除');
  assert.match(ship.text, /^user_gate: review=done · report=\d+ 字/m);
});

test('v0.9.0 P2：text 体积（build ≤600 / ship ≤900 / lessons ≤1,600）与隐私（report/review 原文不进 text）', async () => {
  resetSharedState();
  const lineMax = (text) => Math.max(...text.split('\n').map((line) => Array.from(line).length));
  // build 切换：≤600，且 ≤0.6×JSON（无 lessons.selected 才有比例约束）。
  const buildCwd = tmpCwd();
  const buildSession = fakeSession({ id: 'session-p2-volume-build', cwd: buildCwd, seq: 0 });
  const buildTools = applyAgent(fakeServices({ session: buildSession }).services).tools;
  const build = await buildTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session: buildSession, options: {} } });
  assert.ok(build.text.length <= 600, 'build 切换 text ≤600，实际 ' + build.text.length);
  assert.ok(build.text.length <= 0.6 * JSON.stringify(build).length, 'build text ≤0.6×JSON，实际 ' + (build.text.length / JSON.stringify(build).length).toFixed(3));
  assert.ok(lineMax(build.text) <= 220, '每行 ≤220，实际 ' + lineMax(build.text));
  // ship：≤900；10KB review/report 输入只回字数/计数/warning code，原文不进 text。
  const shipCwd = tmpCwd();
  const shipSession = fakeSession({ id: 'session-p2-volume-ship', cwd: shipCwd, seq: 0 });
  const shipTools = applyAgent(fakeServices({ session: shipSession }).services).tools;
  const shipAgent = { session: shipSession, options: {}, inject() {} };
  await shipTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: shipAgent });
  await shipTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: shipAgent });
  const review = '独立审查：' + 'x'.repeat(5000);
  const report = '汇报：' + 'y'.repeat(5000);
  const ship = await shipTools.get('relay_phase').execute({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review, report } }, { agent: shipAgent });
  assert.ok(ship.text.length <= 900, 'ship text ≤900，实际 ' + ship.text.length);
  assert.ok(ship.text.length <= 0.6 * JSON.stringify(ship).length, 'ship text ≤0.6×JSON，实际 ' + (ship.text.length / JSON.stringify(ship).length).toFixed(3));
  assert.match(ship.text, /^user_gate: review=done · report=5003 字 · questions=0 · warnings: report-format/m);
  assert.equal(ship.text.includes('x'.repeat(200)), false, 'review 原文不进 text');
  assert.equal(ship.text.includes('y'.repeat(200)), false, 'report 原文不进 text');
  assert.equal(ship.text.includes('独立审查：'), false, 'review 原文（含前缀）不进 text');
  // lessons 回灌：明细保留在 text，总体积 ≤1,600；比例豁免（只查上限）。
  const lessonsCwd = tmpCwd();
  const lessonsSession = fakeSession({ id: 'session-p2-volume-lessons', cwd: lessonsCwd, seq: 0 });
  const lessonsTools = applyAgent(fakeServices({ session: lessonsSession }).services).tools;
  const lessonsAgent = { session: lessonsSession, options: {} };
  const longText = (ch) => ch.repeat(190);
  await lessonsTools.get('relay_phase').execute({ phase: 'discover', goal: 'g', exit_criteria: 'e', lessons: [
    { tag: 'a', text: longText('甲'), evidence: 'p:1' },
    { tag: 'b', text: longText('乙'), evidence: 'p:2' },
    { tag: 'c', text: longText('丙'), evidence: 'p:3' },
  ] }, { agent: lessonsAgent });
  const withLessons = await lessonsTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK, lessons: [{ tag: 'a', text: longText('甲'), evidence: 'p:4' }] }, { agent: lessonsAgent });
  assert.ok(withLessons.text.length <= 1600, 'lessons 回灌 text ≤1,600，实际 ' + withLessons.text.length);
  assert.match(withLessons.text, /^lessons: 3 条/m, '回灌条数保留在 text');
  assert.match(withLessons.text, /^  - \[a\] 甲/m, '回灌明细（≤3 条）保留在 text');
  assert.equal(withLessons.lessons.selected.length, 3, '结构化 selected 仍保留（PTC/测试读对象）');
  assert.ok(lineMax(withLessons.text) <= 220, '每行 ≤220，实际 ' + lineMax(withLessons.text));
});

test('relay_phase: lessons 存档（≤3、必须带证据、重复合并）；仅跨 phase 回灌相关经验', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-lessons', cwd, seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const call = (args) => tools.get('relay_phase').execute(args, { agent: { session, options: {}, inject() {} } });
  // 同 phase（discover→discover）：只记盘，不回灌 selected/injection（v0.2.17 A6）
  const first = await call({
    phase: 'discover',
    goal: '跑测试并提交',
    exit_criteria: 'npm test 全绿',
    lessons: [
      { tag: 'test', text: '提交前先跑 npm test', evidence: 'AGENTS.md:1' },
      { text: '没有证据的空话' },
    ],
  });
  assert.equal(first.lessons.recorded.added, 1, '无证据条目被挡在门外');
  assert.equal(first.lessons.total, 1);
  assert.equal(first.lessons.selected, undefined, '同 phase 不回灌 selected');
  assert.equal(first.lessons.injection, undefined, '同 phase 不回灌 injection');
  assert.ok(existsSync(join(cwd, '.scratch', 'context-relay', 'lessons.md')));
  assert.match(readFileSync(join(cwd, '.scratch', 'context-relay', 'lessons.md'), 'utf8'), /提交前先跑 npm test/);
  // 跨 phase（discover→build）：重复条目合并 + 回灌最相关历史条目 + 注入上限用量
  const second = await call({
    phase: 'build',
    design_gate: DESIGN_GATE,
    contract_check: CONTRACT_CHECK,
    goal: '测试',
    lessons: [{ tag: 'test', text: '提交前先跑 npm test', evidence: 'AGENTS.md:2' }],
  });
  assert.equal(second.lessons.recorded.merged, 1, '重复条目只合并');
  assert.equal(second.lessons.total, 1, '不追加新行');
  assert.equal(second.lessons.selected[0].evidence, 'AGENTS.md:2', '证据刷新且在相关度里排前');
  // 注入上限用量（lessonsView.injection）透传给模型：需要知道注入是否被截断/丢条
  assert.equal(typeof second.lessons.injection?.limit, 'number');
  assert.equal(second.lessons.injection.truncated, false);
  // 被拒绝的 phase 声明不写盘
  const before = readFileSync(join(cwd, '.scratch', 'context-relay', 'lessons.md'), 'utf8');
  await assert.rejects(call({ phase: 'decide', lessons: [{ tag: 'x', text: '不该被存', evidence: 'e:1' }] }), /exit_criteria/);
  assert.equal(readFileSync(join(cwd, '.scratch', 'context-relay', 'lessons.md'), 'utf8'), before, '拒绝路径不写经验');
});

test('v0.2.17 A6：lessons 只在跨 phase 回灌——同 phase 记录 next_operation 不返回 selected/injection', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-lessons-crossing', cwd, seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true });
  const call = (args) => tools.get('relay_phase').execute(args, { agent: { session, options: {}, inject() {} } });
  // ① 跨 phase 切换：返回 selected/injection（现有行为）
  const crossing = await call({
    phase: 'build',
    design_gate: DESIGN_GATE,
    contract_check: CONTRACT_CHECK,
    lessons: [{ tag: 't', text: '跨 phase 注入的历史经验', evidence: 'AGENTS.md:1' }],
  });
  assert.equal(crossing.phase, 'build');
  assert.ok(Array.isArray(crossing.lessons.selected), '跨 phase 返回 selected');
  assert.equal(typeof crossing.lessons.injection?.limit, 'number', '跨 phase 带 injection 上限');
  // ② 同 phase 重声明：只回 recorded/total/bytes，不回 selected/injection
  const same = await call({
    phase: 'build',
    lessons: [{ tag: 't2', text: '同 phase 记录的经验', evidence: 'AGENTS.md:2' }],
  });
  assert.equal(same.phase, 'build');
  assert.equal('next_operation' in same, false, 'C10：next_operation 死路径已删');
  assert.equal(same.lessons.selected, undefined, '同 phase 不回灌 selected');
  assert.equal(same.lessons.injection, undefined, '同 phase 不回灌 injection');
  assert.equal(typeof same.lessons.total, 'number', '同 phase 仍返回 total 摘要');
  assert.equal(typeof same.lessons.bytes, 'number', '同 phase 仍返回 bytes 摘要');
  assert.equal(same.lessons.recorded.added, 1, 'recordLessons 行为不变（同 phase 仍写盘）');
  resetSharedState();
});

test('F1：phase 优先文案——到线不要求中段动作；warn 档 advice 指向 budget_plan/拆票', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-f1-advice', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { defaultOperation: 'compress' });
  const organize = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.match(organize.advice, /phase 优先/);
  assert.match(organize.advice, /不中途压缩\/接力/);
  assert.match(organize.advice, /phase 边界|切 phase/);
  assert.match(organize.advice, /三清单/);
  assert.doesNotMatch(organize.advice, /现在调 tools\.relay_organize|现在调 tools\.relay_handoff/, 'phase 中段不再给「现在调」指令');
  // B-P1-2：预设只决定做什么，不产生审批豁免
  assert.match(organize.advice, /严格按模式执行/);
  assert.match(organize.advice, /不产生审批豁免/);
  assert.match(organize.advice, /autoCompress|autoHandoff|authorizeNext/);
  assert.doesNotMatch(organize.advice, /本次免审批|视为已授权/);
  // warn 档：预算是 phase 边界闸门，开新 phase 前先估计（budget_plan）；放不下拆票或先做一次 relay 操作
  const warnSession = fakeSession({ id: 'session-f1-advice-warn', seq: 0 });
  const warnTools = applyAgent(fakeServices({ session: warnSession, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } }).services).tools;
  const warn = await warnTools.get('relay_status').execute({}, { agent: { session: warnSession, options: {} } });
  assert.match(warn.advice, /预算预警/);
  assert.match(warn.advice, /budget_plan/);
  assert.match(warn.advice, /拆票/);
  resetSharedState();
});

test('F2：phase 优先——升线只提醒一次，不再每 8 步重申（nag 已移除）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [];
  const session = fakeSession({ id: 'session-f2-nag', cwd, log });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const listener = preStepListener(applyAgent(services).events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = async (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      log.push({ type: 'step/start', seq: log.length + 1 });
      await listener({ agent }, async () => undefined);
    }
  };
  await step();
  assert.equal(injected.length, 1, 'crossing reminder');
  await step(8);
  assert.equal(injected.length, 1, 'nag removed: no repeat 8 steps later');
  await step(10);
  assert.equal(injected.length, 1, 'nag removed: no repeat after more steps');
  // 真正继续动作（成功的 organize 日志事件）同样不再产生额外提醒
  log.push({ type: 'tool/ptc-dispatch', seq: log.length + 1, data: { name: 'relay_organize', isError: false, arguments: { phase: 'build' }, content: [{ type: 'text', text: 'organized: freed 100 tokens; band organize → ok; brief /x' }] } });
  await step(10);
  assert.equal(injected.length, 1, '升线只提醒一次（处理动作也不触发重申）');
});

test('rev5.5：面板模式「接力」不是预授权；旧 cth 归一「问我」；接力成功后模式在旧会话持久（不跨会话继承）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-f3', cwd, seq: 0 });
  const approval = { async request() { return 'allowed-once'; } };
  const { services } = fakeServices({ session, extra: { approval } });
  const { events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const exec = (target) => ({ name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'f3', agent: { session: target }, signal: new AbortController().signal });
  assert.equal((await gate(exec(session), async () => ({ kind: 'allow' }))).kind, 'ask', '无预设仍要人工确认');
  // rev5.5 正交模型：预设只决定「做什么」，不再自带免审
  updatePanelState(session.id, { defaultOperation: 'handoff' });
  assert.equal((await gate(exec(session), async () => ({ kind: 'allow' }))).kind, 'ask', '预设「接力」不再免审');
  updatePanelState(session.id, { defaultOperation: 'compress-then-handoff' });
  assert.equal(panelStateOf(session.id).defaultOperation, null, '旧 cth 归一 null（问我）');
  assert.equal((await gate(exec(session), async () => ({ kind: 'allow' }))).kind, 'ask', '旧 cth 预设同样不免审');
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', isError: false, arguments: { phase: 'build' }, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const organized = fakeSession({ id: 'session-f3b', cwd, log: organizedLog });
  updatePanelState(organized.id, { defaultOperation: 'compress-then-handoff' });
  assert.equal(panelStateOf(organized.id).defaultOperation, null, '旧 cth 归一 null');
  // 同一到线（band ok）：cth 退役后无两段式预判 → 正常 ask（不因旧预设值免审）
  assert.equal((await gate(exec(organized), async () => ({ kind: 'allow' }))).kind, 'ask', 'cth 退役后无两段式预判 → 正常 ask');
  // 下一次到线（band organize）：仍不免审（rev5.5）
  const organizedGateServices = fakeServices({ session: organized, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, extra: { approval } });
  const organizedGate = preExecuteListener(applyAgent(organizedGateServices.services).events);
  assert.equal((await organizedGate(exec(organized), async () => ({ kind: 'allow' }))).kind, 'ask', '仍不免审（模式只决定做什么）');
  // 只有人类显式授权才免审
  updatePanelState(organized.id, { authorizeNext: true });
  assert.equal((await organizedGate(exec(organized), async () => ({ kind: 'allow' }))).kind, 'allow', '一次性授权免审');
  // 直接接力成功后模式持久（新会话继承）
  const liveSession = { id: 'session-f3-new', header: { cwd }, requestHeader: () => undefined };
  const bundle = fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-f3-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const toolsBundle = applyAgent(bundle.services).tools;
  updatePanelState(session.id, { defaultOperation: 'handoff' });
  const result = await toolsBundle.get('relay_handoff').execute({ human_approved: true, status: { goal: 'x' } }, { agent: { session, options: {} } });
  assert.equal(result.ok, true);
  assert.equal(panelStateOf(session.id).defaultOperation, 'handoff', 'v0.4.0：模式在旧会话持久不消费（不跨会话继承；新会话由新根 seed 默认压缩继续）');
});

test('relay_handoff 成功后标记 handedOff：旧会话不再注入到线提醒/重申', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-handedoff', cwd, seq: 0 });
  const liveSession = { id: 'session-handedoff-new', header: { cwd }, requestHeader: () => undefined };
  const approval = { async request() { return 'allowed-once'; } };
  const { services, state } = fakeServices({
    session,
    extra: {
      approval,
      sessionController: { async create() { return { sessionId: 'session-handedoff-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools, events } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'x' } }, { agent: { session, options: {} } });
  assert.equal(result.ok, true);
  assert.equal(panelStateOf(session.id).handedOff, true);
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  const injected = [];
  await preStepListener(events)({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 0, 'archived session must not be nagged');
});

test('v0.10 C10 relay_phase next_operation 死路径已删：schema 不暴露，传入被忽略、零面板写入', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-next-op', seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  assert.equal('next_operation' in tools.get('relay_phase').parameters.properties, false, 'schema 不再暴露 next_operation');
  const call = (args) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {} } });
  const recorded = await call({ phase: 'build', design_gate: DESIGN_GATE, next_operation: 'compress' });
  assert.equal(recorded.phase, 'build');
  assert.equal('next_operation' in recorded, false, '结果不再回显 next_operation');
  assert.equal('next_operation_ignored' in recorded, false);
  assert.doesNotMatch(recorded.summary, /记录操作|被忽略/, '摘要不再提 next_operation');
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), 'autoDecision'), false, '不写任何自决字段');
  resetSharedState();
});
test('v0.10 C10：退役自决存档（autoChoose/autoDecision）被丢弃 → 到线按「问人类」', async () => {
  resetSharedState();
  const make = (id, decision, log = []) => {
    const session = fakeSession({ id, cwd: tmpCwd(), seq: log.length, log });
    const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
    const { tools } = applyAgent(bundle.services);
    updatePanelState(id, { autoChoose: true, autoDecision: decision });
    const injected = [];
    return { session, tools, injected, call: (args = {}) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE, ...args }, { agent: { session, options: {}, inject(message) { injected.push(message); } } }) };
  };
  // 退役存档被白名单丢弃：到线按「问人类」拒绝（不再按已记录决定指示）
  const toHandoff = make('session-decide-handoff', { operation: 'handoff', at: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('session-decide-handoff'), 'autoDecision'), false);
  await assert.rejects(toHandoff.call(), (error) => /问人类/.test(error.message) && !/已记录/.test(error.message));
  assert.equal(toHandoff.injected.length, 0, '拒绝分支只 throw');
  // 已压缩过：同样按「问人类」
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const toCompress = make('session-decide-compress', { operation: 'compress', at: 2 }, organizedLog);
  await assert.rejects(toCompress.call(), (error) => /问人类/.test(error.message) && !/已记录/.test(error.message));
  assert.equal(toCompress.injected.length, 0);
  resetSharedState();
});
test('v3 relay_organize 成功清 authorizeNext（模式持久不消费）；失败不改模式/授权', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 7 }; } };
  // ① 成功压缩消费 authorizeNext；退役自决存档被丢弃
  const session = fakeSession({ id: 'session-organize-v3', cwd, seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true, autoDecision: { operation: 'handoff', at: 9 }, authorizeNext: true });
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), 'autoDecision'), false);
  assert.equal(panelStateOf(session.id).defaultOperation, null, '无显式模式');
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session, options: {} } });
  assert.equal(result.organized, true);
  const panel = panelStateOf(session.id);
  assert.equal(panel.authorizeNext, false, '成功压缩消费一次性授权');
  // ② 人类预设模式：成功压缩不消费 defaultOperation
  const presetSession = fakeSession({ id: 'session-organize-v3-preset', cwd, seq: 0 });
  const presetTools = applyAgent(fakeServices({ session: presetSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction }).services).tools;
  updatePanelState(presetSession.id, { defaultOperation: 'compress' });
  const presetResult = await presetTools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session: presetSession, options: {} } });
  assert.equal(presetResult.organized, true);
  assert.equal(panelStateOf(presetSession.id).defaultOperation, 'compress', '模式持久不消费');
  // ③ 失败（compaction 抛错）不消费授权、不改模式
  const failSession = fakeSession({ id: 'session-organize-v3-fail', cwd, seq: 0 });
  const failTools = applyAgent(fakeServices({ session: failSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction: { async compactIfNeeded() { throw new Error('boom'); } } }).services).tools;
  updatePanelState(failSession.id, { autoCompress: true, authorizeNext: true });
  const failed = await failTools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session: failSession, options: {} } });
  assert.equal(failed.ok, false);
  assert.equal(panelStateOf(failSession.id).authorizeNext, true, '失败不消费一次性授权');
  resetSharedState();
});
test('v3 relay_handoff 成功清 authorizeNext（同一次写入）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-handoff-v3', cwd, seq: 0 });
  const liveSession = { id: 'session-handoff-v3-new', header: { cwd }, requestHeader: () => undefined };
  const { services } = fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-handoff-v3-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { authorizeNext: true });
  const result = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'x' } }, { agent: { session, options: {} } });
  assert.equal(result.ok, true);
  const panel = panelStateOf(session.id);
  assert.equal(panel.authorizeNext, false);
  assert.equal(panel.handedOff, true);
  resetSharedState();
});

test('v3 approval gate：authorizeNext 一次性免审 relay_handoff 与二次 force 压缩', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-gate-v3', seq: 0 });
  const { services } = fakeServices({ session, extra: { approval: { async request() { return 'allowed-once'; } } } });
  const { events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const next = async () => ({ kind: 'allow' });
  const handoffExec = { name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'v1', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(handoffExec, next)).kind, 'ask');
  updatePanelState(session.id, { authorizeNext: true });
  assert.equal((await gate(handoffExec, next)).kind, 'allow');
  // 二次 force 压缩同理
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const secondSession = fakeSession({ id: 'session-gate-v3b', cwd: tmpCwd(), log: organizedLog });
  const organizeExec = { name: 'relay_organize', arguments: { phase: 'build', force: true }, callId: 'v2', agent: { session: secondSession }, signal: new AbortController().signal };
  assert.equal((await gate(organizeExec, next)).kind, 'ask');
  updatePanelState(secondSession.id, { authorizeNext: true });
  assert.equal((await gate(organizeExec, next)).kind, 'allow');
  resetSharedState();
});

test('v3 4 个发布点都带 live.organizeCount（relay_status/relay_phase/pre-step/publishLiveFor）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const organized = (seq) => ({ type: 'tool/ptc-dispatch', seq, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } });
  const session = fakeSession({ id: 'session-live-count', cwd, seq: 2, log: [organized(0), organized(1)] });
  const { services } = fakeServices({ session, compaction: { async compactIfNeeded() { return { shadowedTokenCount: 3 }; } } });
  const { tools, events } = applyAgent(services);
  const agent = { session, options: {} };
  await tools.get('relay_status').execute({}, { agent });
  assert.equal(liveStateOf(session.id).organizeCount, 2);
  await tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent });
  assert.equal(liveStateOf(session.id).organizeCount, 2);
  await preStepListener(events)({ agent: { session, inject() {} } }, async () => undefined);
  assert.equal(liveStateOf(session.id).organizeCount, 2);
  // publishLiveFor（relay_* 工具 finally）：force 压缩不改变日志派生计数
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { ...agent, inject() {} } });
  assert.equal(result.organized, true);
  assert.equal(liveStateOf(session.id).organizeCount, 2);
  resetSharedState();
});

/** §3.8 夹具：handoff 成功/失败路径 + 新会话 id（followup 可抛错模拟半创建失败）。 */
function handoffPanelHarness({ oldId, newId, failFollowup = false, extraServices = {}, pressure, log = [] }) {
  const cwd = tmpCwd();
  const session = fakeSession({ id: oldId, cwd, seq: 0, log });
  const liveSession = { id: newId, header: { cwd }, requestHeader: () => undefined };
  const followed = [];
  const { services } = fakeServices({
    session,
    ...(pressure === undefined ? {} : { pressure }),
    extra: {
      approval: { async request() { return 'allowed-once'; } },
      sessionController: { async create() { return { sessionId: newId }; } },
      agents: {
        list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); if (failFollowup) throw new Error('dispatch boom'); } }],
        get(sessionId) { return { dispose() { /* best-effort cleanup */ } }; },
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
      ...extraServices,
    },
  });
  const { tools } = applyAgent(services);
  const handoff = (goal = 'sync panel', extra = {}) => tools.get('relay_handoff').execute({ human_approved: true, status: { goal }, ...extra }, { agent: { session, options: {} } });
  return { cwd, session, newId, tools, handoff, followed };
}
const PERSISTENT_SWITCHES = (panel) => ({
  autoCompress: panel.autoCompress, autoHandoff: panel.autoHandoff, authorizeNext: panel.authorizeNext,
});

test('v0.9.0 #26/#53：接力成功清空旧会话全部授权（模式/架构师保留仅审计）；新会话不继承任何模式/授权', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-sync-old', newId: 'session-sync-new' });
  updatePanelState(h.session.id, {
    defaultOperation: 'handoff', autoCompress: true, autoHandoff: true,
    authorizeNext: true, architect: true, architectModel: { provider: 'geekai', model: 'gpt-6.1-sol' },
  });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  // 旧会话：接力归档 = 会话本地授权全部失效（只清 autoCompress/autoHandoff/authorizeNext；退役自决字段本就不在面板状态里）
  const oldPanel = panelStateOf(h.session.id);
  assert.deepEqual(PERSISTENT_SWITCHES(oldPanel), { autoCompress: false, autoHandoff: false, authorizeNext: false });
  assert.equal(oldPanel.handedOff, true);
  // 只清授权：模式与架构师不是授权，保留仅审计
  assert.equal(oldPanel.defaultOperation, 'handoff', '旧会话模式不消费、保留原值仅审计');
  assert.equal(oldPanel.architect, true);
  assert.deepEqual(oldPanel.architectModel, { provider: 'geekai', model: 'gpt-6.1-sol' });
  // 新会话：模式/授权都不继承（按侧栏默认从零开始；真实宿主由新根 seed 置「压缩继续」）
  const newPanel = panelStateOf(h.newId);
  assert.deepEqual(PERSISTENT_SWITCHES(newPanel), { autoCompress: false, autoHandoff: false, authorizeNext: false });
  assert.equal(newPanel.defaultOperation, null);
  assert.equal(newPanel.handedOff, false);
  // 非授权继承仍成立：架构师开关/显式模型选择随接力 sticky
  assert.equal(newPanel.architect, true);
  assert.deepEqual(newPanel.architectModel, { provider: 'geekai', model: 'gpt-6.1-sol' });
  resetSharedState();
});

test('v0.9.0 #53 授权不继承：新会话按侧栏默认从零开始（不被旧会话混合授权钉住）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-sync-mixed-old', newId: 'session-sync-mixed-new' });
  updatePanelState(h.session.id, { autoCompress: false, autoHandoff: true, authorizeNext: true });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  // 新会话没有继承快照 → 跟随侧栏默认（resetSharedState 的默认全关）
  assert.deepEqual(PERSISTENT_SWITCHES(panelStateOf(h.newId)), { autoCompress: false, autoHandoff: false, authorizeNext: false });
  // 侧栏默认改开授权 → 未钉住的新会话跟随（证明没有写入继承值）
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: true, autoHandoff: true };
  assert.deepEqual(PERSISTENT_SWITCHES(panelStateOf(h.newId)), { autoCompress: true, autoHandoff: true, authorizeNext: false });
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  resetSharedState();
});

test('v0.9.0 #26：面板模式不随接力继承（旧会话保留仅审计；新会话按 seed/默认，不再带过去）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-mode-sync-old', newId: 'session-mode-sync-new' });
  updatePanelState(h.session.id, { defaultOperation: 'compress' });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(panelStateOf(h.session.id).defaultOperation, 'compress', '旧会话模式不消费、保留仅审计');
  // 本夹具不跑 agent/created 的 seed：新会话保持默认 null；关键是「不继承旧档、也不钉住」
  assert.equal(panelStateOf(h.newId).defaultOperation, null, '不继承旧模式（真实宿主由新根 seed 置「压缩继续」）');
  // 未钉住 = 侧栏默认变化会生效（证明没有写入继承快照）
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'handoff', autoCompress: false, autoHandoff: false };
  assert.equal(panelStateOf(h.newId).defaultOperation, 'handoff', '新会话未被继承值钉住，按侧栏默认');
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  resetSharedState();
});

test('v0.9.0 handoff 保留 architectModel=null，接力后仍未显式选择', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-arch-null-old', newId: 'session-arch-null-new' });
  updatePanelState(h.session.id, { architectModel: null }, { force: true });
  updatePanelState(h.newId, { architectModel: { provider: 'geekai', model: 'gpt-6.1-sol' } });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(panelStateOf(h.newId).architectModel, null, '未显式选择随接力继承，不沿用目标会话旧选择');
  resetSharedState();
});

test('v0.9.0 #53 handoff 失败路径：旧会话授权不消费/不清空，新会话不写继承（仍为默认值）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-sync-fail-old', newId: 'session-sync-fail-new', failFollowup: true });
  updatePanelState(h.session.id, { defaultOperation: 'handoff', autoCompress: true, autoHandoff: true, authorizeNext: true });
  const result = await h.handoff('fail sync');
  assert.equal(result.ok, false);
  assert.equal(result.halfCreated, true);
  // 失败不消费/不清空旧会话授权（授权失效只发生在接力成功归档后）
  const oldPanel = panelStateOf(h.session.id);
  assert.equal(oldPanel.autoCompress, true);
  assert.equal(oldPanel.autoHandoff, true);
  assert.equal(oldPanel.authorizeNext, true);
  assert.equal(oldPanel.defaultOperation, 'handoff');
  assert.equal(oldPanel.handedOff, false);
  // 失败路径不写继承记录：新会话仍是默认值
  assert.deepEqual(PERSISTENT_SWITCHES(panelStateOf(h.newId)), { autoCompress: false, autoHandoff: false, authorizeNext: false });
  assert.equal(panelStateOf(h.newId).defaultOperation, null);
  resetSharedState();
});

test('文案：autoChoose 模型自决档退役（D8=A）——advice/常驻协议不再出现自决指令，人类模式严格按模式执行', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-copy-auto', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, events, sections } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true });
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), 'autoChoose'), false, '退役字段不得出现');
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  // advice：单模式四档 + 严格按模式执行；不再有模型自决/记录决定的指令
  assert.match(report.advice, /继续 \/ 压缩继续 \/ 接力新会话/);
  assert.match(report.advice, /严格按模式执行/);
  assert.match(report.advice, /问人类/);
  assert.doesNotMatch(report.advice, /自决|next_operation|autoChoose=on/);
  // 到线提醒正文同样不再有自决文案
  const listener = preStepListener(events);
  const injected = [];
  await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.match(text, /模式「问我」/);
  assert.doesNotMatch(text, /自决|autoChoose=on/);
  // P2-19：工具描述只留一行指针，语义收敛协议
  const desc = tools.get('relay_phase').description;
  // v0.9.0 M2：描述补出口/exit_reason/user_gate warning 语义 → 实测 348，预算按实测+50 上调到 400（#68）。
  assert.ok(desc.length <= 400, 'relay_phase description 已瘦身: ' + desc.length);
  assert.ok(!desc.includes('\n'), 'description 单行');
  assert.match(desc, /composer panel/);
  assert.match(desc, /protocol/);
  // 常驻协议同步：退役标识已删净 + 人类模式权威句（其余交互纪律断言保持）
  const protocol = sections[0].text;
  assert.doesNotMatch(protocol, /autoChoose|autoDecision|next_operation/);
  assert.match(protocol, /严格按模式执行/);
  assert.match(protocol, /\*\*持久\*\*（不消费）/);
  assert.match(protocol, /authorizeNext/);
  assert.match(protocol, /提问工具只用于简单问题/, '提问纪律：只把简单问题放提问工具');
  assert.match(protocol, /复杂问题不走提问工具/, '提问纪律：复杂问题用普通消息白话展开');
  assert.match(protocol, /pending 不是跳过、不是同意/, '提问纪律：超时 pending 的语义');
  assert.match(protocol, /汇报一律四段式/, '交互纪律：用户汇报四段式（D1=B 只提醒不拒绝）');
  assert.match(protocol, /等待纪律/, '等待纪律：派活后不空转等队友');
  assert.match(protocol, /wait_agent \/ list_agents/, '等待纪律：点名不要循环调用的工具');
  assert.match(protocol, /回执会自动作为消息送达/, '等待纪律：回执自动送达');
  assert.match(protocol, /≤120s/, '等待纪律：只在被阻塞时有界等待');
  assert.match(protocol, /完整上下文索引/, '用户门：Lead 必须给全上下文索引');
  assert.match(protocol, /不重跑技术验证、不重读第三方源码/, '用户门：审查范围限定需求↔实现对齐');
  assert.match(protocol, /最多 1 轮/, '用户门：审查轮数上限');
  assert.match(protocol, /审查超时或未完成不算通过/, '用户门：#15 审查超时/未完成不算通过');
  resetSharedState();
});
test('文案：人类模式 = 严格按模式执行（不含模型自决指令）', async () => {
  resetSharedState();
  for (const preset of ['compress', 'handoff']) {
    const session = fakeSession({ id: 'session-copy-' + preset, cwd: tmpCwd(), seq: 0 });
    const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
    const { tools } = applyAgent(services);
    updatePanelState(session.id, { defaultOperation: preset });
    const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
    assert.match(report.advice, /面板模式/, preset + ': 人类模式文案提到面板模式');
    assert.match(report.advice, /严格按模式执行/, preset + ': 严格按模式执行');
    assert.doesNotMatch(report.advice, /自决/, preset + ': 人类预设不提示模型自决');
  }
  resetSharedState();
});

test('文案闭环：退役 next_operation 参数被忽略，到线按「问人类」提示', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-copy-loop', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true });
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  await assert.rejects(
    tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE, next_operation: 'handoff' }, { agent }),
    (error) => /问人类/.test(error.message) && !/按已记录/.test(error.message) && !/模型自决档/.test(error.message),
  );
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf(session.id), 'autoDecision'), false, '不写自决字段');
  assert.equal(injected.length, 0, '拒绝分支只 throw');
  resetSharedState();
});
// ───────────── 2026-10-29 审计修复回归（core：B-P1/P2/P3 + Lead 设计缺口）─────────────

test('B-P1-1/P2-2 fallback：同 phase 记录 next_operation 保留 phaseMeta；isError 的下一 phase 声明不污染 brief', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [
    { type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_phase', arguments: { phase: 'build', goal: 'G-current', exit_criteria: 'E-current' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 1, data: { name: 'relay_phase', arguments: { phase: 'build', next_operation: 'compress' }, isError: false, content: [] } },
    { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'relay_phase', arguments: { phase: 'verify', goal: 'G-rejected', exit_criteria: 'E-rejected' }, isError: true, content: [] } },
  ];
  const session = fakeSession({ id: 'session-fallback-meta', cwd, seq: log.length, log });
  const { tools } = applyAgent(fakeServices({
    session,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    compaction: { async compactIfNeeded() { return { shadowedTokenCount: 3 }; } },
  }).services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const brief = readFileSync(result.briefPath, 'utf8');
  assert.match(brief, /G-current/, '同 phase 记录 next_operation 后 goal 必须保留（B-P1-1）');
  assert.match(brief, /E-current/);
  assert.doesNotMatch(brief, /G-rejected|E-rejected/, '被拒绝（isError）的下一 phase 声明不得污染 brief（B-P2-2）');
  assert.match(brief, /# Phase Brief · build/);
});

test('B-P2-3：compress 模式 organize 失败/成功都不改模式（持久）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-preset-consume', cwd, seq: 0 });
  let fail = true;
  const compaction = { async compactIfNeeded() { if (fail) throw new Error('boom'); return { shadowedTokenCount: 4 }; } };
  const { tools } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction }).services);
  updatePanelState(session.id, { defaultOperation: 'compress' });
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent: { session, options: {}, inject() {} } }), /relay_organize/);
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress', 'relay_phase 拒绝不改模式');
  const failed = await tools.get('relay_organize').execute({ phase: 'discover', brief: 'x' }, { agent: { session, options: {}, inject() {} } });
  assert.equal(failed.ok, false);
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress', 'organize 失败不改模式');
  fail = false;
  const organized = await tools.get('relay_organize').execute({ phase: 'discover', brief: 'x' }, { agent: { session, options: {}, inject() {} } });
  assert.equal(organized.organized, true);
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress', 'organize 成功后模式保持');
});

test('B-P2-4：队友 relay_phase 连续超预算尝试只向 Lead 请示一次；band 上升后允许再请示', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-escalate-dedupe', header: { cwd, origin: 'subagent' } });
  const sent = [];
  const bundle = fakeServices({
    session: sub,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    extra: {
      agentTeams: {
        tryMembership: () => ({ role: 'teammate', name: 'escalate-agent' }),
        sendMessage: async (caller, request) => { sent.push(request); },
        listMembers: () => [],
      },
    },
  });
  const { tools } = applyAgent(bundle.services);
  const injected = [];
  const agent = { session: sub, options: {}, inject(message) { injected.push(message); } };
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent }), /teammate session/);
  assert.equal(sent.length, 1);
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'verify' }, { agent }),
    (error) => /teammate session/.test(error.message) && /不重复发送/.test(error.message));
  assert.equal(sent.length, 1, 'same band: escalation deduped（B-P2-4）');
  assert.equal(injected.length, 0, '拒绝分支只 throw（去重提示在错误文案里）');
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', design_gate: DESIGN_GATE }, { agent }), /teammate session/);
  assert.equal(sent.length, 2, 'band 上升（relay）后允许再请示一次');
  assert.match(sent[1].content[0].text, /band=relay/);
});

test('B-P2-5：队友 relay_status advice 改为向 Lead 请示（不自行 relay、不问人类、跳过面板预设命令）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-status-subagent', header: { cwd, origin: 'subagent' } });
  const { tools } = applyAgent(fakeServices({ session: sub, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services);
  updatePanelState(sub.id, { defaultOperation: 'handoff' });
  const report = await tools.get('relay_status').execute({}, { agent: { session: sub, options: {} } });
  assert.match(report.advice, /send_message/, '队友必须被指引用 send_message 向 Lead 请示');
  assert.match(report.advice, /Lead/);
  assert.match(report.advice, /不自行 relay/);
  assert.doesNotMatch(report.advice, /现在调 tools\.relay_handoff|现在调 tools\.relay_organize/, '不得给队友 lead-only 操作指令');
  assert.doesNotMatch(report.advice, /问人类（≤3 题/, '队友不得向人类提问');
});

test('B-P2-7：fallback 无配对 tool/result 的中断 relay_phase 调用不算切换', async () => {
  resetSharedState();
  const log = [
    { type: 'tool/call', seq: 0, data: { callId: 'call-interrupted', name: 'relay_phase', arguments: JSON.stringify({ phase: 'build' }) } },
    // 中断后会话继续产生其他工具结果——旧判据（index < lastResult）会把它当完成
    { type: 'tool/call', seq: 1, data: { callId: 'call-read', name: 'read', arguments: JSON.stringify({ file_path: '/x' }) } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'call-read', content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const session = fakeSession({ id: 'session-interrupted', cwd: tmpCwd(), seq: 3, log });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.equal(report.phase, 'discover', '无 result 的 relay_phase 调用不参与 phase 派生');
});

test('B-P2-9：phase 优先——投影可用时 pre-step 热路径 0 次 snapshotEvents（升线只提醒一次）', async () => {
  resetSharedState();
  const log = [];
  const { session, counts } = countingSnapshotSession({ id: 'session-nag-projected', cwd: tmpCwd(), log });
  const projection = {
    phase: 'build', goal: null, exitCriteria: null, organizeCount: 0, compactionEpoch: 0,
    noticeBand: 'organize', lastNoticeSeq: 5, lastCompactionSeq: -1, lastContinueActionSeq: -1,
  };
  const bundle = attachRelayProjection(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }), projection);
  const listener = preStepListener(applyAgent(bundle.services).events);
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  const step = async (times = 1) => {
    for (let index = 0; index < times; index += 1) {
      log.push({ type: 'step/start', seq: log.length + 1 });
      await listener({ agent }, async () => undefined);
    }
  };
  // 持久投影 band=organize 作为 seed：同档不重复、无重启补催（nag 已删除）
  await step();
  assert.equal(injected.length, 0, 'persisted projection band=organize seeds lastBand: no re-alert');
  await step(8);
  assert.equal(injected.length, 0, 'nag removed: still 0 after 8 steps');
  assert.ok(counts.snapshot === 0, '投影可用时 pre-step 热路径不得调用 snapshotEvents，实际 ' + counts.snapshot);
  // 升到 relay：提醒一次，之后不再重申
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await step();
  assert.equal(injected.length, 1, 'higher band still reminds');
  assert.match(injected[0].source.summary, /band=relay/);
  await step(8);
  assert.equal(injected.length, 1, 'no nag after crossing');
  assert.ok(counts.snapshot === 0, '升线/同档路径全程不调用 snapshotEvents，实际 ' + counts.snapshot);
});

test('P2-21：permissionPresets.permissionState（private API）缺失时 logWarn，不静默跳过', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const callerSession = fakeSession({ id: 'session-perm-missing-caller', cwd, seq: 0 });
  const childSession = { id: 'session-perm-missing-child', header: { cwd }, requestHeader: () => undefined };
  const { services } = fakeServices({
    session: callerSession,
    extra: {
      sessionController: { async create() { return { sessionId: childSession.id }; } },
      agents: { list: () => [{ session: childSession, status: 'idle', followup() {} }] },
      permissionPresets: { set() {}, current: () => 'custom' },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools, logs } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'perm' } }, { agent: { session: callerSession, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(logs.some((line) => line.includes('[handoff] permission inheritance skipped') && line.includes('private API missing')), '缺失 private API 必须 warn');
  assert.equal(result.inherited.permission, undefined, '不可用时不继承（新会话回落部署默认）');
});

test('P3：队友 relay_organize 返回结构化 lead-only（零副作用，与 relay_handoff 对齐）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-sub-organize', header: { cwd, origin: 'subagent' } });
  const { tools } = applyAgent(fakeServices({
    session: sub,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    compaction: { async compactIfNeeded() { return { shadowedTokenCount: 9 }; } },
  }).services);
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x', force: true }, { agent: { session: sub, options: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lead-only');
  assert.match(result.summary, /only the Lead may run relay_organize/);
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay')), false, '被拒路径零副作用');
});

test('P3：relay_handoff 非法 status.phase 返回结构化 handoff-invalid（不裸抛）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-handoff-bad-phase', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const result = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'x', phase: 'bogus' } }, { agent: { session, options: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'handoff-invalid');
  assert.match(result.summary, /unknown phase/);
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay')), false, '非法输入不写 handoff 文件');
});

test('Lead 缺口：handedOff=true 的重复接力仍执行（兼容）但 summary 明确警告会再建会话/耗额度', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-dup-handoff-old', newId: 'session-dup-handoff-new' });
  const first = await h.handoff('first relay');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.doesNotMatch(first.summary, /重复接力/);
  const second = await h.handoff('second relay');
  assert.equal(second.ok, true, 'handedOff=true 仍允许（向后兼容/人类可能坚持再接力）');
  assert.match(second.summary, /handedOff=true/, 'summary 必须点明会话已接力过');
  assert.match(second.summary, /重复接力/);
  assert.equal(panelStateOf(h.session.id).handedOff, true, '静音语义保留');
  resetSharedState();
});

test('B-P1-2 文本契约：协议/工具描述/运行期 advice 不含旧授权口径，且含权威句关键词', async () => {
  resetSharedState();
  const forbidden = /本次免审批|视为已授权|pre-authorize|pre-authorizes|handoffPreAuthorized/;
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-copy-contract', cwd, seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, sections } = applyAgent(services);
  const protocol = sections[0].text;
  assert.doesNotMatch(protocol, forbidden, '常驻协议不得残留旧授权口径');
  assert.match(protocol, /模式只决定「做什么」/);
  assert.match(protocol, /不产生审批豁免/);
  assert.match(protocol, /免审只来自 autoCompress \/ autoHandoff \/ authorizeNext/);
  for (const name of ['relay_status', 'relay_phase', 'relay_organize', 'relay_handoff', 'doc_lint']) {
    assert.doesNotMatch(tools.get(name).description, forbidden, name + ' description 不得残留旧授权口径');
  }
  assert.match(tools.get('relay_organize').description, /autoCompress/);
  assert.match(tools.get('relay_handoff').description, /autoHandoff/);
  assert.match(tools.get('relay_handoff').description, /does not grant an approval exemption/);
  // 运行期 advice：各一次性预设下都不得宣称免审
  for (const preset of ['compress', 'handoff', 'compress-then-handoff', 'continue']) {
    const id = 'session-copy-contract-' + preset;
    const presetSession = fakeSession({ id, cwd: tmpCwd(), seq: 0 });
    const presetTools = applyAgent(fakeServices({ session: presetSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services).tools;
    updatePanelState(id, { defaultOperation: preset });
    const report = await presetTools.get('relay_status').execute({}, { agent: { session: presetSession, options: {} } });
    assert.doesNotMatch(report.advice, forbidden, preset + ' advice 不得残留旧授权口径');
  }
  // 到线提醒同样统一
  const noticeSession = fakeSession({ id: 'session-copy-contract-notice', cwd: tmpCwd(), seq: 0 });
  const noticeTools = applyAgent(fakeServices({ session: noticeSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services);
  updatePanelState(noticeSession.id, { defaultOperation: 'handoff' });
  const injected = [];
  await preStepListener(noticeTools.events)({ agent: { session: noticeSession, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.doesNotMatch(injected[0].content[0].text, forbidden, '到线提醒不得残留旧授权口径');
  resetSharedState();
});
test('P3：超长 brief 注入时标注截断与完整文件路径（不静默丢证据指针/关键文档）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-brief-trunc', cwd, seq: 0 });
  const { tools } = applyAgent(fakeServices({
    session,
    pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
    compaction: { async compactIfNeeded() { return { shadowedTokenCount: 1 }; } },
  }).services);
  const injected = [];
  const brief = Array.from({ length: 300 }, (_, index) => 'decision-' + index + '-' + 'x'.repeat(10)).join('\n');
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief }, { agent: { session, options: {}, inject(message) { injected.push(message); } } });
  assert.equal(result.briefInjected, true);
  const text = injected[0].content[0].text;
  assert.ok(text.length <= 4200, '注入 notice 有界，实际 ' + text.length);
  assert.match(text, /\[brief truncated: 完整内容见 /);
  assert.ok(text.includes(result.briefPath), '截断标注包含完整 brief 文件路径');
});
test('P2-19/C11：工具描述瘦身预算（每条 ≤1 行 / 总字符预算；v0.3.3 八条 + A-06 lead-only 五条装配实测）', async () => {
  resetSharedState();
  const { tools, sections, events } = applyAgent(fakeServices({ session: fakeSession({ id: 'session-desc-budget', seq: 0 }) }));
  const definitions = [...tools.values()];
  let descriptionChars = 0;
  let parameterChars = 0;
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string', definition.name + ' description 存在');
    assert.ok(!definition.description.includes('\n'), definition.name + ' description 必须单行');
    // v0.5.0：新增 relay_work_items（结构化字段 schema，desc 372）后上调预算；仍是硬上限，不是取消
    assert.ok(definition.description.length <= 400, definition.name + ' description 超预算: ' + definition.description.length);
    descriptionChars += definition.description.length;
    parameterChars += JSON.stringify(definition.parameters).length;
  }
  // v0.9.0 批次3：relay_status/relay_phase 描述各加 delegation 口径（设计 §3.3 要求），
  // 实测 2323 → 预算按设计 ≤2400（实测+50 向上取整；#68：只调预算，不删语义、不砍约束内容）。
  assert.ok(descriptionChars <= 2400, '八条工具描述总字符 <=2400（v0.9.0 批次3 实测 2323+50），实际 ' + descriptionChars);
  // v0.9.0 批次2：设计强制新增 schema 字段（relay_phase.phase 扩 2 出口 + exit_reason、user_gate.details_requested、
  // relay_work_items.officialTaskId）→ 实测 8504，预算按实测+96 上调到 8600（仍逐条受 ≤400/单行约束；#68）。
  // C9/AUDIT §12：relay_phase 新增 design_gate{path,user_approved} + user_gate.verification{tier,approved_by_user,items}，
  // 实测 9970，预算按实测+130 上调到 10100（C11 注入预算快照重定基线；仍逐条受 ≤400/单行约束）。
  assert.ok(parameterChars <= 10100, '参数 schema 总字符 <=10100（C9 实测 9970+130），实际 ' + parameterChars);
  // C11/A-06（M-09）：此前只测常驻 8 条，root 独有 5 条（team 3 + dispatch/collect）无断言。
  // 装配实测：走 agent/created 在 root agent scope 捕获实际注册的 lead-only 工具定义（不是常量求和）。
  const created = events.find((entry) => entry.name === 'agent/created');
  assert.ok(created, 'agent/created 装配入口存在');
  const { agent: rootAgent, registered } = rootLeadHarness({ sessionId: 'session-desc-budget-root', cwd: tmpCwd() });
  await created.listener({ agent: rootAgent });
  const leadOnlyNames = ['relay_team_status', 'relay_renew', 'relay_architect', 'relay_dispatch', 'relay_collect'];
  assert.deepEqual([...registered.keys()], leadOnlyNames, 'root agent-scope 注册的 lead-only 工具面（新增/删除须同步预算）');
  let leadDescriptionChars = 0;
  let leadParameterChars = 0;
  for (const name of leadOnlyNames) {
    const definition = registered.get(name);
    assert.equal(typeof definition.description, 'string', name + ' description 存在');
    assert.ok(!definition.description.includes('\n'), name + ' description 必须单行');
    // lead-only 描述比常驻工具长（A-06 实测 relay_architect 718 / relay_collect 447），上限 800 只防回涨。
    assert.ok(definition.description.length <= 800, name + ' description 超预算: ' + definition.description.length);
    leadDescriptionChars += definition.description.length;
    leadParameterChars += JSON.stringify(definition.parameters).length;
  }
  // A-06 实测 2,141/3,000 → 预算按实测+~3% 定格；15 工具逐条精确快照见 test/budget-snapshot.test.mjs。
  assert.ok(leadDescriptionChars <= 2200, 'lead-only 5 条描述总字符 <=2200（实测 2141），实际 ' + leadDescriptionChars);
  assert.ok(leadParameterChars <= 3100, 'lead-only 5 条参数总字符 <=3100（实测 3000），实际 ' + leadParameterChars);
  assert.deepEqual(tools.get('relay_phase').parameters.properties.budget_plan.properties.action.enum, ['proceed', 'split', 'relay'], 'warn 档 budget_plan 三选一进参数 schema');
  // 语义收敛协议：模式/授权口径在协议里完整复述（描述只留指针；退役标识不回流）
  const protocol = sections[0].text;
  for (const keyword of ['autoCompress', 'autoHandoff', 'authorizeNext', '模式只决定「做什么」']) {
    assert.ok(protocol.includes(keyword), '协议必须承载语义 ' + keyword);
  }
  for (const retired of ['autoChoose', 'autoDecision', 'next_operation']) {
    assert.equal(protocol.includes(retired), false, '退役标识不得回到协议: ' + retired);
  }
});

test('relay_phase: ship 用户门 = 新上下文独立审查 + 大白话汇报（仅 verify 进；宿主只校验非空，不机械校验内容）', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-ship-gate', seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const call = (args) => tools.get('relay_phase').execute(args, { agent });
  // 默认 phase=discover：直接 ship 被拒（只能从 verify 进）
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK }), /verify/, 'ship 只能从 verify 进');
  await call({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK });
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK }), /verify/, '从 build 直接 ship 被拒');
  await call({ phase: 'verify', contract_check: CONTRACT_CHECK });
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK }), /user_gate/, '缺 user_gate 被拒');
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: '  ', report: 'r' } }), /review/, '空 review 被拒');
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'r', report: '' } }), /report/, '空 report 被拒');
  await assert.rejects(call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: 'r', report: 'p', questions: [{ question: 'q?' }] } }), /recommendation/, 'questions 每条必须带 recommendation');
  const questions = Array.from({ length: 5 }, (_, index) => ({ question: 'q' + index, recommendation: 'r' + index }));
  const shipped = await call({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: '短', report: '短', questions } });
  assert.equal(shipped.phase, 'ship');
  assert.equal(shipped.previous, 'verify');
  assert.equal(shipped.user_gate.review, 'done', '宿主只回 done（不机械回显/校验内容）');
  assert.equal(shipped.user_gate.questions, 5);
  // 短内容放行：证明宿主不机械校验内容（对不对由用户判断）
  const shortSession = fakeSession({ id: 'session-ship-gate-short', seq: 0 });
  const shortTools = applyAgent(fakeServices({ session: shortSession }).services).tools;
  const shortAgent = { session: shortSession, options: {} };
  await shortTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: shortAgent });
  const allowed = await shortTools.get('relay_phase').execute({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: { review: '无', report: '好' } }, { agent: shortAgent });
  assert.equal(allowed.phase, 'ship');
});

test('relay_phase: subagent/Agent Teams 队友不做验收声明（ship → lead-only）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const sub = fakeSession({ id: 'session-ship-sub', header: { cwd, origin: 'subagent' } });
  const subAgent = { session: sub, options: {} };
  const subTools = applyAgent(fakeServices({ session: sub }).services).tools;
  await subTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: subAgent });
  await assert.rejects(subTools.get('relay_phase').execute({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }, { agent: subAgent }), /lead-only/, 'subagent 不能声明 ship');
  const teammate = fakeSession({ id: 'session-ship-team', cwd });
  const teamTools = applyAgent(fakeServices({ session: teammate, extra: { agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'reviewer' }), listMembers: () => [] } } }).services).tools;
  const teamAgent = { session: teammate, options: {} };
  await teamTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: teamAgent });
  await assert.rejects(teamTools.get('relay_phase').execute({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }, { agent: teamAgent }), /lead-only/, 'Agent Teams 队友不能声明 ship');
});

test('contract_check 仅 ship 必填（C9）：普通 phase 缺失不告警；主动传入但残缺才 warning', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-contract', seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const missing = await tools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE }, { agent });
  assert.equal(missing.phase, 'build');
  assert.equal(missing.contractWarning, undefined, '普通 phase 缺自检不再 warning（可选，非形式化必记）');
  const empty = await tools.get('relay_phase').execute({ phase: 'verify', contract_check: { requirement: '  ', fidelity: 'f', attention: 'a' } }, { agent });
  assert.match(empty.contractWarning, /requirement/, '主动传入但残缺仍 warning（不静默丢意图）');
  const ok = await tools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent });
  assert.equal(ok.contractWarning, undefined, '自检完整不告警');
  // 超预算 + 面板「继续」：跨 phase 缺自检同样不 warning；模式持久不消费。
  const overSession = fakeSession({ id: 'session-contract-over', seq: 0 });
  const overBundle = fakeServices({ session: overSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const overTools = applyAgent(overBundle.services).tools;
  const overAgent = { session: overSession, options: {}, inject() {} };
  updatePanelState(overSession.id, { defaultOperation: 'continue' });
  const crossed = await overTools.get('relay_phase').execute({ phase: 'verify' }, { agent: overAgent });
  assert.equal(crossed.phase, 'verify');
  assert.equal(crossed.contractWarning, undefined, '超预算普通 phase 缺自检也不 warning');
  assert.equal(panelStateOf(overSession.id).defaultOperation, 'continue', '模式持久（不消费）');
  // ship 前必须自检（唯一必填点）。
  const shipSession = fakeSession({ id: 'session-contract-ship', seq: 0 });
  const shipTools = applyAgent(fakeServices({ session: shipSession }).services).tools;
  const shipAgent = { session: shipSession, options: {} };
  await shipTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: shipAgent });
  await assert.rejects(shipTools.get('relay_phase').execute({ phase: 'ship', user_gate: SHIP_GATE }, { agent: shipAgent }), /contract_check/);
  const shipped = await shipTools.get('relay_phase').execute({ phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }, { agent: shipAgent });
  assert.equal(shipped.phase, 'ship');
  // 队友普通 phase 缺自检同样不 warning。
  const teammateSession = fakeSession({ id: 'session-contract-team', seq: 0 });
  const teammateTools = applyAgent(fakeServices({ session: teammateSession, extra: { agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'rev' }), listMembers: () => [] } } }).services).tools;
  const teammate = await teammateTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE }, { agent: { session: teammateSession, options: {} } });
  assert.equal(teammate.phase, 'build');
  assert.equal(teammate.contractWarning, undefined);
});

test('approval gate: 验收（relay_phase 进 ship）不弹审批；organize/handoff 仍 ask', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  let outcome = 'allowed-once';
  const approval = { async request() { return outcome; } };
  const session = fakeSession({ id: 'session-approval-ship', cwd, seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, extra: { approval } });
  const { events } = applyAgent(services);
  const gate = preExecuteListener(events);
  const shipExec = { name: 'relay_phase', arguments: { phase: 'ship', contract_check: CONTRACT_CHECK, user_gate: SHIP_GATE }, callId: 'c-ship', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(shipExec, async () => ({ kind: 'allow' }))).kind, 'allow', 'ship 验收不进审批层（拆除弹窗）');
  assert.equal((await gate({ ...shipExec, arguments: { phase: 'build', contract_check: CONTRACT_CHECK } }, async () => ({ kind: 'allow' }))).kind, 'allow', '普通 phase 切换也不弹审批');
  const organizeExec = { name: 'relay_organize', arguments: { phase: 'build' }, callId: 'c-org', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(organizeExec, async () => ({ kind: 'allow' }))).kind, 'ask', '压缩仍过官方审批');
  const handoffExec = { name: 'relay_handoff', arguments: { human_approved: true, status: { goal: 'x' } }, callId: 'c-h', agent: { session }, signal: new AbortController().signal };
  assert.equal((await gate(handoffExec, async () => ({ kind: 'allow' }))).kind, 'ask', '接力仍过官方审批');
  assert.equal(outcome, 'allowed-once');
});

test('relay_handoff：超大输入不再拒绝（handoff-truncated 已删除）——摘要注入有界、完整文件含全部原文', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-truncate', cwd, seq: 0 });
  const liveSession = { id: 'session-truncate-new', header: { cwd }, requestHeader: () => undefined };
  const followed = [];
  const { services } = fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-truncate-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); } }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const long = 'x'.repeat(200);
  const fill = (prefix, count) => Array.from({ length: count }, (_, index) => prefix + index + long);
  const result = await tools.get('relay_handoff').execute({
    status: {
      goal: 'truncate the handoff',
      phase: 'build',
      success_criteria: fill('sc', 5),
      done: fill('done', 12),
      next_actions: fill('next', 8),
      blocked: fill('blk', 8),
      open_questions: fill('q', 5),
      risks: fill('risk', 8),
    },
    evidence: fill('ev', 20),
    decisions: fill('dec', 10),
    constraints: fill('con', 8),
    discarded: fill('dis', 8),
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.code, undefined, '不再有 handoff-truncated');
  assert.equal(result.caps.truncated, true, '摘要按 advisory 阈值分层');
  assert.ok(result.caps.truncatedSections.length > 0, 'truncatedSections 记账');
  assert.equal(result.caps.split, true, '完整版单独输出');
  assert.ok(result.caps.warnings.length > 0, 'advisory 说明');
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit, '摘要不超 advisory 预算');
  assert.equal(followed.length, 1);
  const full = readFileSync(result.handoffPath, 'utf8');
  assert.ok(full.includes('ev19' + long), '第 20 条 evidence 完整原文落在完整文件');
  assert.ok(full.includes('dis7' + long), 'discarded 段完整原文落在完整文件');
  assert.ok(Buffer.byteLength(full, 'utf8') > result.caps.bytes.limit, '完整文件可以超过摘要预算');
  const message = followed[0].content[0].text;
  assert.match(message, /## 完整交接单（全部细节）/);
  assert.match(result.summary, /saved/);
  assert.match(result.summary, /完整内容在文件/);
});

test('relay_handoff：单条超 200 字符只影响摘要，完整文件保留原文', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-item-clip-old', newId: 'session-item-clip-new' });
  const item = '长'.repeat(260);
  const result = await h.handoff('item clip', { status: { goal: 'item clip', next_actions: [item] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.caps.truncatedSections, ['chars:next_actions'], '只有单条字符裁剪，不是字节预算/条数');
  assert.ok(result.caps.bytes.used < result.caps.bytes.limit, '摘要远没到预算：' + JSON.stringify(result.caps.bytes));
  assert.equal(h.followed.length, 1, '交接照常完成');
  const summary = h.followed[0].content[0].text;
  assert.ok(summary.includes('长'.repeat(199) + '…'), '摘要保留 200 字 advisory 截断');
  assert.ok(!summary.includes(item), '摘要不含未截断原文');
  const full = readFileSync(result.handoffPath, 'utf8');
  assert.ok(full.includes('下一步（DoD）：' + item), '完整文件保留 260 字原文');
  resetSharedState();
});

test('relay_handoff：列表条数超 advisory 上限只影响摘要，完整文件含全部条目', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-count-clip-old', newId: 'session-count-clip-new' });
  const nextActions = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
  const result = await h.handoff('count clip', { status: { goal: 'count clip', next_actions: nextActions } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.caps.truncatedSections, ['items:next_actions'], '条数超上限记 items:');
  assert.ok(result.caps.truncated, '摘要按 advisory 条数上限裁剪');
  assert.equal(h.followed.length, 1);
  const summary = h.followed[0].content[0].text;
  assert.ok(!summary.includes('下一步（DoD）：u8'), '摘要只收前 8 条');
  const full = readFileSync(result.handoffPath, 'utf8');
  for (const entry of nextActions) assert.ok(full.includes('下一步（DoD）：' + entry), '完整文件含 ' + entry);
  resetSharedState();
});

test('relay_handoff：自动交接清单只进完整文件（摘要保留用户 next_actions，不再拒绝/丢用户内容）', async () => {
  resetSharedState();
  const jobs = {
    list: (owner) => (owner === 'session-inv-old' ? [{ id: 'bash-x', kind: 'bash', label: 'job', status: 'running', owner: 'session-inv-old' }] : []),
    kill: () => 'requested',
  };
  const h = handoffPanelHarness({ oldId: 'session-inv-old', newId: 'session-inv-new', extraServices: { jobs, subagents: undefined } });
  const result = await h.handoff('inv cap', { status: { goal: 'inv cap', next_actions: Array.from({ length: 8 }, (_, index) => 'u' + index) } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.caps.truncated, true, '自动清单挤不进摘要 next_actions 条数上限');
  assert.deepEqual(result.caps.truncatedSections, ['items:next_actions'], '只有 next_actions 槽位冲突，用户章节/字节都合规');
  assert.equal(result.hint, undefined, '正常路径不返回 hint');
  assert.equal(h.followed.length, 1, '交接照常完成');
  for (let index = 0; index < 8; index += 1) {
    assert.ok(h.followed[0].content[0].text.includes('下一步（DoD）：u' + index), '用户 next_actions 保留：u' + index);
  }
  const full = readFileSync(result.handoffPath, 'utf8');
  assert.match(full, /旧会话残留-后台任务/, '自动清单完整落在完整文件');
  resetSharedState();
});

test('relay_handoff：近预算时用户内容与自动清单都完整落盘（摘要分层，不丢数据）', async () => {
  resetSharedState();
  const big = (label) => label + '-' + 'x'.repeat(190);
  const jobs = {
    list: (owner) => (owner === 'session-near-old' ? [{ id: 'bash-long-label', kind: 'bash', label: big('label'), status: 'running', owner: 'session-near-old' }] : []),
    kill: () => 'requested',
  };
  const h = handoffPanelHarness({ oldId: 'session-near-old', newId: 'session-near-new', extraServices: { jobs, subagents: undefined } });
  const result = await h.handoff('near cap', {
    status: {
      goal: 'near cap',
      phase: 'build',
      done: Array.from({ length: 9 }, (_, index) => big('done' + index)),
      next_actions: Array.from({ length: 6 }, (_, index) => big('next' + index)),
    },
    evidence: Array.from({ length: 10 }, (_, index) => big('ev' + index)),
    decisions: Array.from({ length: 6 }, (_, index) => big('dec' + index)),
    risks: Array.from({ length: 3 }, (_, index) => big('risk' + index)),
  });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.equal(result.caps.items.decisions.used, 6, '摘要保留用户 decisions');
  assert.ok(result.caps.items.next_actions.used >= 6, '摘要保留用户 next_actions（自动清单排在后面被条数上限裁）');
  assert.ok(result.caps.split, '摘要与完整版分层（不拒绝）');
  assert.ok(result.caps.warnings.length > 0, 'advisory 说明');
  assert.equal(result.inventoryDropped, undefined, '不再有 inventoryDropped 降级');
  const raw = readFileSync(result.handoffPath, 'utf8');
  assert.match(raw, /dec5-/, '用户 decisions 完整写入完整文件');
  assert.match(raw, /done8-/, '用户 done 完整写入完整文件');
  assert.match(raw, /旧会话残留-后台任务/, '自动清单也完整写入完整文件');
  resetSharedState();
});

test('relay_handoff：纯字节超限（无 chars:）也走摘要分层 + 完整文件（不拒绝）', async () => {
  resetSharedState();
  const big = (label) => label + '-' + 'x'.repeat(190);
  const jobs = {
    list: (owner) => (owner === 'session-bytes-old' ? [{ id: 'bash-1', kind: 'bash', label: 'job', status: 'running', owner: 'session-bytes-old' }] : []),
    kill: () => 'requested',
  };
  const h = handoffPanelHarness({ oldId: 'session-bytes-old', newId: 'session-bytes-new', extraServices: { jobs, subagents: undefined } });
  const result = await h.handoff('bytes cap', {
    status: {
      goal: 'bytes cap',
      phase: 'build',
      done: Array.from({ length: 10 }, (_, index) => big('done' + index)),
      next_actions: Array.from({ length: 6 }, (_, index) => big('next' + index)),
    },
    evidence: Array.from({ length: 9 }, (_, index) => big('ev' + index)),
    decisions: Array.from({ length: 6 }, (_, index) => big('dec' + index)),
    risks: Array.from({ length: 3 }, (_, index) => big('risk' + index)),
  });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.ok(!result.caps.truncatedSections.some((entry) => entry.startsWith('chars:')), '清单行都很短，不误报 chars:');
  assert.equal(result.caps.items.done.used, 10, '摘要保留用户 done 段');
  assert.equal(result.caps.items.decisions.used, 6, '摘要保留用户 decisions 段');
  assert.equal(result.caps.items.risks.used, 3, '摘要保留用户 risks 段');
  const full = readFileSync(result.handoffPath, 'utf8');
  assert.match(full, /done9-/, '完整文件含全部用户 done');
  assert.match(full, /risk2-/, '完整文件含全部用户 risks');
  resetSharedState();
});

test('relay_handoff：清理报告完整追加到完整文件（不再 8KB 截断）', async () => {
  resetSharedState();
  const big = (label) => label + '-' + 'x'.repeat(190);
  const jobs = {
    list: (owner) => (owner === 'session-append-old' ? [{ id: 'bash-long-label', kind: 'bash', label: big('label'), status: 'running', owner: 'session-append-old' }] : []),
    kill: () => 'requested',
  };
  const schedule = { list: async () => [], create: async () => ({ id: 'sched-new' }), delete: async () => ({ deleted: true }) };
  const h = handoffPanelHarness({ oldId: 'session-append-old', newId: 'session-append-new', extraServices: { jobs, schedule, subagents: undefined } });
  const result = await h.handoff('append cap', {
    status: {
      goal: 'append cap',
      phase: 'build',
      done: Array.from({ length: 9 }, (_, index) => big('done' + index)),
      next_actions: Array.from({ length: 6 }, (_, index) => big('next' + index)),
    },
    evidence: Array.from({ length: 9 }, (_, index) => big('ev' + index)),
    decisions: Array.from({ length: 6 }, (_, index) => big('dec' + index)),
    risks: Array.from({ length: 3 }, (_, index) => big('risk' + index)),
  });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit);
  assert.equal(typeof result.handoffFileBytes, 'number');
  assert.equal(result.caps.fullBytes, result.handoffFileBytes, 'fullBytes = 最终完整文件字节');
  assert.equal(result.cleanupReportTruncated, false, '清理报告不再截断');
  const raw = readFileSync(result.handoffPath, 'utf8');
  assert.equal(Buffer.byteLength(raw, 'utf8'), result.handoffFileBytes, '实际文件字节 = 记账');
  assert.match(raw, /## 交接清理结果/, '清理报告完整落盘');
  assert.match(raw, /bash-long-label/, '清理明细逐行落盘');
  assert.doesNotMatch(raw, /因 handoff 8KB 上限已截断/);
  assert.match(result.summary, /saved/);
  resetSharedState();
});

test('交接顺序保证：新会话收到首条消息前 handoff 快照 + progress.md 已写盘（先写好文档再交接）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-order-caller', cwd, seq: 0 });
  const liveSession = { id: 'session-order-new', header: { cwd }, requestHeader: () => undefined };
  // followup 被调用瞬间采样磁盘：首条消息派发前文档必须已经写完。
  const observed = [];
  const { services } = fakeServices({
    session,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-order-new' }; } },
      agents: {
        list: () => [{
          session: liveSession,
          status: 'idle',
          followup(message) {
            const root = join(cwd, '.scratch', 'context-relay');
            const handoffs = readdirSync(root).filter((name) => /^handoff-\d+\.md$/.test(name));
            observed.push({
              text: message.content[0].text,
              progressExists: existsSync(join(root, 'progress.md')),
              handoffs,
              handoffBytes: handoffs.length === 0 ? 0 : readFileSync(join(root, handoffs[0]), 'utf8').length,
            });
          },
        }],
      },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  const { tools } = applyAgent(services);
  const result = await tools.get('relay_handoff').execute(
    { human_approved: true, status: { phase: 'build', goal: 'order guarantee' } },
    { agent: { session, options: {} } },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(observed.length >= 1, '首条消息已派发');
  const first = observed[0];
  // 顺序 = 写 handoff 快照 → 建新会话 → 更新 progress.md → 发首条消息（live.followup）。
  assert.equal(first.progressExists, true, 'progress.md 先于首条消息写盘');
  assert.equal(first.handoffs.length, 1, 'handoff 快照先于首条消息写盘');
  assert.ok(result.handoffPath.endsWith(first.handoffs[0]), '结果里的 handoff 路径就是已写盘的文件');
  assert.ok(first.handoffBytes > 0, 'handoff 快照内容非空');
  assert.match(first.text, /# Handoff · order guarantee/);
  assert.match(first.text, /## 完整交接单（全部细节）\n/);
  assert.ok(first.text.includes('.scratch/context-relay/handoff-'), '首条消息含完整交接单 workspace 相对路径');
  assert.match(first.text, /\.scratch\/context-relay\/progress\.md/, '首条消息指向滚动进度文件');
  assert.equal(result.progress.updated, true);
  assert.equal(result.progress.path, '.scratch/context-relay/progress.md');
  resetSharedState();
});

// ── v0.3.3 模型推荐（relay_recommend）───────────────────────────────────────

test('v0.3.3 relay_recommend：Lead 写推荐三字段（reason trim/≤120），只展示不改预设/授权', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-rec-lead', seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  const longReason = '  理由' + '长'.repeat(200) + '  ';
  const result = await tools.get('relay_recommend').execute({ operation: 'compress', reason: longReason }, { agent });
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'compress');
  assert.equal(result.reason.length, 120, 'reason 裁 120 字');
  assert.ok(result.reason.startsWith('理由'));
  assert.equal(typeof result.at, 'number');
  assert.match(result.text, /已提交模型推荐/);
  assert.match(result.text, /压缩/);
  assert.match(result.text, /不会自动执行/, 'text 明确「不会自动执行压缩/接力」');
  const panel = panelStateOf(session.id);
  assert.equal(panel.recommendedOperation, 'compress');
  assert.equal(panel.recommendedReason, result.reason);
  assert.equal(panel.recommendedAt, result.at);
  // 推荐绝不写决策/授权字段
  assert.equal(panel.defaultOperation, null);
  assert.equal(panel.authorizeNext, false);
  assert.equal(Object.prototype.hasOwnProperty.call(panel, 'autoDecision'), false);
  // 单一模式只接受三档；空 reason 允许；拒绝零副作用
  for (const operation of ['continue', 'handoff']) {
    const next = await tools.get('relay_recommend').execute({ operation }, { agent });
    assert.equal(next.ok, true, operation);
    assert.equal(next.reason, '');
    assert.equal(panelStateOf(session.id).recommendedOperation, operation);
  }
  const retiredOp = await tools.get('relay_recommend').execute({ operation: 'compress-then-handoff', reason: '两段式' }, { agent });
  assert.equal(retiredOp.ok, false, '退役档推荐被拒');
  assert.equal(retiredOp.code, 'invalid-operation');
  assert.match(retiredOp.error, /operation must be one of compress\|handoff\|continue/);
  assert.equal(panelStateOf(session.id).recommendedOperation, 'handoff', '拒绝路径零副作用（原推荐保留）');
  assert.equal(panelStateOf(session.id).defaultOperation, null, '推荐不消费/不改一次性预设');
});

test('v0.3.3 relay_recommend：队友/子会话 lead-only、非法操作 invalid-operation，零副作用', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // subagent（header.origin=subagent）
  const sub = fakeSession({ id: 'session-rec-sub', header: { cwd, origin: 'subagent' } });
  const subRes = await applyAgent(fakeServices({ session: sub }).services).tools.get('relay_recommend')
    .execute({ operation: 'compress' }, { agent: { session: sub, options: {} } });
  assert.equal(subRes.ok, false);
  assert.equal(subRes.code, 'lead-only');
  assert.equal(panelStateOf(sub.id).recommendedOperation, null);
  // Agent Teams 队友（无 subagent header，靠 tryMembership 判定）
  const teammate = fakeSession({ id: 'session-rec-team', cwd });
  const teamTools = applyAgent(fakeServices({
    session: teammate,
    extra: { agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'reviewer' }), listMembers: () => [] } },
  }).services).tools;
  const teamRes = await teamTools.get('relay_recommend').execute({ operation: 'handoff' }, { agent: { session: teammate, options: {} } });
  assert.equal(teamRes.ok, false);
  assert.equal(teamRes.code, 'lead-only');
  assert.equal(panelStateOf(teammate.id).recommendedOperation, null);
  // 非法 operation → invalid-operation，不写推荐
  const lead = fakeSession({ id: 'session-rec-invalid', seq: 0 });
  const leadTools = applyAgent(fakeServices({ session: lead }).services).tools;
  const bad = await leadTools.get('relay_recommend').execute({ operation: 'bogus', reason: 'x' }, { agent: { session: lead, options: {} } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid-operation');
  assert.equal(panelStateOf(lead.id).recommendedOperation, null);
});

test('v0.10.0 relay_recommend：单一模式三档，退役/未知档拒绝且零副作用', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-rec-v034-single', seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  assert.deepEqual(tools.get('relay_recommend').parameters.properties.operation.enum, ['continue', 'compress', 'handoff']);
  assert.doesNotMatch(JSON.stringify(tools.get('relay_recommend').parameters), /compress-then-handoff/);
  // v0.3.5 F4：reason 口径统一 120（schema 不再写 160）
  const reasonDesc = tools.get('relay_recommend').parameters.properties.reason.description;
  assert.match(reasonDesc, /120/);
  assert.doesNotMatch(reasonDesc, /160/);
  updatePanelState(session.id, { recommendedOperation: 'continue', recommendedReason: '单一模式三档', recommendedAt: 1234 }, { source: 'agent' });
  const agent = { session, options: {} };
  const rejected = await tools.get('relay_recommend').execute({ operation: 'compress-then-handoff', reason: '两段式' }, { agent });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid-operation');
  assert.match(rejected.error, /operation must be one of compress\|handoff\|continue/);
  const kept = panelStateOf(session.id);
  assert.deepEqual([kept.recommendedOperation, kept.recommendedReason, kept.recommendedAt], ['continue', '单一模式三档', 1234], '拒绝路径零副作用（原推荐保留）');
  assert.equal(kept.defaultOperation, null, '拒绝不写预设');
  assert.equal(kept.authorizeNext, false, '拒绝不写授权');
  // 三个合法档都接受
  for (const operation of ['continue', 'compress', 'handoff']) {
    const ok = await tools.get('relay_recommend').execute({ operation }, { agent });
    assert.equal(ok.ok, true, operation);
    assert.equal(panelStateOf(session.id).recommendedOperation, operation);
  }
});
test('v0.3.3 到线提醒：Lead notice（warn/organize）带 relay_recommend 指引与「模型推荐=」；队友文案不含', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const lead = fakeSession({ id: 'session-rec-notice', cwd });
  const { services, state } = fakeServices({ session: lead, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const listener = preStepListener(applyAgent(services).events);
  updatePanelState(lead.id, { recommendedOperation: 'handoff', recommendedReason: '干净上下文更适合下一阶段', recommendedAt: 1234 });
  const injected = [];
  const agent = { session: lead, inject(message) { injected.push(message); } };
  const step = () => listener({ agent }, async () => undefined);
  await step(); // warn
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /relay_recommend/);
  // v0.3.4 P2-4：推荐段用面板档位长 label（与 client 推荐行一致）。
  assert.match(injected[0].content[0].text, /模型推荐=接力新会话/);
  assert.match(injected[0].content[0].text, /干净上下文更适合下一阶段/);
  // v0.3.4 P2-3：展示/提醒理由截 60（存储仍 120）。
  const longReason = '理'.repeat(80);
  updatePanelState(lead.id, { recommendedReason: longReason }, { source: 'agent' });
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await step(); // organize
  assert.equal(injected.length, 2);
  assert.match(injected[1].content[0].text, /relay_recommend/);
  assert.match(injected[1].content[0].text, /模型推荐=接力新会话\(/);
  assert.ok(injected[1].content[0].text.includes(longReason.slice(0, 60)), '提醒展示理由前 60 字');
  assert.equal(injected[1].content[0].text.includes(longReason.slice(0, 61)), false, '提醒不展示第 61 字');
  // 空理由：不渲染空括号（v0.3.4 P2-3）
  updatePanelState(lead.id, { recommendedReason: '' }, { source: 'agent' });
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await step(); // relay
  assert.equal(injected.length, 3);
  assert.match(injected[2].content[0].text, /模型推荐=接力新会话/);
  assert.doesNotMatch(injected[2].content[0].text, /模型推荐=接力新会话\(/);
  assert.doesNotMatch(injected[2].content[0].text, /模型推荐=[^\n]*\(\)/);

  // 队友文案不改：不含 relay_recommend 指引与推荐行
  resetSharedState();
  const sub = fakeSession({ id: 'session-rec-notice-sub', header: { cwd, origin: 'subagent' } });
  const subServices = fakeServices({ session: sub, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const subInjected = [];
  await preStepListener(applyAgent(subServices.services).events)({
    agent: { session: sub, inject(message) { subInjected.push(message); } },
  }, async () => undefined);
  assert.equal(subInjected.length, 1);
  const subText = subInjected[0].content[0].text;
  assert.match(subText, /队友会话·到线请示/);
  assert.doesNotMatch(subText, /relay_recommend/);
  assert.doesNotMatch(subText, /模型推荐=/);
});

test('v0.3.5 升级残留：旧 cth 推荐不再进到线提醒（单一模式无该档）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const stamp = (sessionId, reason) => updatePanelState(sessionId, {
    recommendedOperation: 'compress-then-handoff',
    recommendedReason: reason,
    recommendedAt: 1762460000999,
  }, { source: 'agent' });
  // 单一模式：cth 推荐残留不展示（不显示推荐段、不出现已删档位名）
  const session = fakeSession({ id: 'session-rec-v035-single', cwd });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const sentinelListenerOf = (events) => events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const listener = sentinelListenerOf(applyAgent(services).events);
  stamp(session.id, '旧档残留');
  const injected = [];
  await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  assert.doesNotMatch(text, /模型推荐/);
  assert.doesNotMatch(text, /压缩→新会话/);
});
test('v0.3.3 推荐清理：relay_phase 成功切 phase / relay_organize 压缩成功 / relay_handoff 接力成功后三字段归空', async () => {
  resetSharedState();
  const recommendationOf = (sessionId) => {
    const panel = panelStateOf(sessionId);
    return { operation: panel.recommendedOperation, reason: panel.recommendedReason, at: panel.recommendedAt };
  };
  const setRecommendation = (sessionId) => updatePanelState(sessionId, {
    recommendedOperation: 'continue',
    recommendedReason: '本会话继续收尾',
    recommendedAt: 1762460000999,
  }, { source: 'agent' });
  const cleared = { operation: null, reason: '', at: null };

  // ① relay_phase 成功切 phase
  const phaseSession = fakeSession({ id: 'session-rec-clean-phase', seq: 0 });
  const phaseTools = applyAgent(fakeServices({ session: phaseSession }).services).tools;
  setRecommendation(phaseSession.id);
  const switched = await phaseTools.get('relay_phase').execute({ phase: 'build', design_gate: DESIGN_GATE, contract_check: CONTRACT_CHECK }, { agent: { session: phaseSession, options: {} } });
  assert.equal(switched.phase, 'build');
  assert.deepEqual(recommendationOf(phaseSession.id), cleared, '切 phase 成功后推荐清空');

  // ② relay_organize organized===true
  const orgCwd = tmpCwd();
  const orgSession = fakeSession({ id: 'session-rec-clean-organize', cwd: orgCwd, seq: 0 });
  const orgTools = applyAgent(fakeServices({
    session: orgSession,
    compaction: { async compactIfNeeded() { return { shadowedTokenCount: 7 }; } },
  }).services).tools;
  setRecommendation(orgSession.id);
  const organized = await orgTools.get('relay_organize').execute({ phase: 'build', brief: 'cleanup recommendation', force: true }, { agent: { session: orgSession, options: {}, inject() {} } });
  assert.equal(organized.organized, true, JSON.stringify(organized));
  assert.deepEqual(recommendationOf(orgSession.id), cleared, '压缩成功后推荐清空');

  // ③ relay_handoff 成功消费点
  const hCwd = tmpCwd();
  const hSession = fakeSession({ id: 'session-rec-clean-handoff', cwd: hCwd, seq: 0 });
  const childSession = { id: 'session-rec-clean-child', header: { cwd: hCwd }, requestHeader: () => undefined };
  const hServices = fakeServices({
    session: hSession,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-rec-clean-child' }; } },
      agents: { list: () => [{ session: childSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws-rec', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  }).services;
  const hTools = applyAgent(hServices).tools;
  setRecommendation(hSession.id);
  const handed = await hTools.get('relay_handoff').execute({ human_approved: true, status: { phase: 'build', goal: 'cleanup recommendation' } }, { agent: { session: hSession, options: {} } });
  assert.equal(handed.ok, true, JSON.stringify(handed));
  assert.deepEqual(recommendationOf(hSession.id), cleared, '接力成功后旧会话推荐清空');
  assert.deepEqual(recommendationOf('session-rec-clean-child'), cleared, '新会话不继承推荐');
});
test('v0.6.4/v0.9.0 专职架构师段：单一模式恒注入（不再依赖 routerMode 参数）；Lead 段按会话开关热生效；名为 architect 的队友拿架构师段', () => {
  resetSharedState();
  const leadAgent = { session: fakeSession({ id: 'session-arch-lead', seq: 0, header: {} }) };
  const architectAgent = { session: fakeSession({ id: 'session-arch-worker', seq: 0, header: { origin: 'subagent' } }) };
  const teams = {
    tryMembership: (agent) => {
      if (agent === leadAgent) return { role: 'lead' };
      if (agent === architectAgent) return { role: 'teammate', name: 'architect' };
      return undefined;
    },
    listMembers: () => [],
  };
  const { services } = fakeServices({ session: leadAgent.session, extra: { agentTeams: teams } });
  // v0.9.0 单一模式：apply 后 routerMode 恒 true → 架构师段恒注入（不依赖 config.routerMode 参数）
  const single = applyAgent(services);
  const section = single.sections.find((item) => item.name === 'context-relay:architect');
  assert.ok(section, '单一模式恒注入架构师段');
  assert.match(section.text({ agent: leadAgent }), /专职架构师/, 'root Lead：分工段');
  assert.match(section.text({ agent: leadAgent }), /工程实现路线设计交给 architect/);
  for (const phrase of ['默认值跟随「模型」选择器', '已选过则沿用', '不拒绝、不阻塞', 'handoff 继承']) {
    assert.ok(section.text({ agent: leadAgent }).includes(phrase), '架构师注入缺短语: ' + phrase);
  }
  // v0.9.0：旧部署显式 routerMode=false 不再回退 classic（生产恒单一模式，仅 warn）
  const legacy = applyAgent(fakeServices({ session: fakeSession({ id: 'session-arch-legacy', seq: 0, header: {} }), extra: { agentTeams: teams } }).services, { routerMode: false });
  assert.match(legacy.sections.find((item) => item.name === 'context-relay:architect').text({ agent: leadAgent }), /专职架构师/, '旧 routerMode=false 配置仍注入（single 恒开）');
  // 架构师自己的协议由 agent/created 的 ARCHITECT_WORKER 影子注入（见 router 测试），
  // preset 层架构师段只给 Lead，避免与 TEAMMATE/TEAM_WORKER 叠加。
  assert.equal(section.text({ agent: architectAgent }), '', 'preset 层架构师段不重复注入 worker');
  // 会话开关关掉 → Lead 段不注入
  updatePanelState('session-arch-lead', { architect: false });
  assert.equal(section.text({ agent: leadAgent }), '', '面板小胶囊关掉 → Lead 段空');
  // 未改面板的新会话跟随 settings 默认（关）→ 不注入
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, architect: false };
  assert.equal(section.text({ agent: { session: fakeSession({ id: 'session-arch-fresh', seq: 0, header: {} }) } }), '');
});

test('v081 relay_doc forwards byteOffset and validates nonnegative integers', async()=>{
 resetSharedState();const cwd=tmpCwd();const root=join(cwd,'.scratch','context-relay');mkdirSync(root,{recursive:true});writeFileSync(join(root,'long.md'),'a'.repeat(24000));const session=fakeSession({id:'doc-bytes',cwd});const {tools}=applyAgent(fakeServices({session}).services);const doc=tools.get('relay_doc');assert.equal(doc.parameters.properties.byteOffset.minimum,0);
 const first=await doc.execute({action:'read',path:'long.md'},{agent:{session}});assert.equal(first.ok,true,JSON.stringify(first));assert.ok(first.nextByteOffset>0);
 const next=await doc.execute({action:'read',path:'long.md',byteOffset:first.nextByteOffset},{agent:{session}});assert.equal(next.ok,true);assert.equal(next.byteOffset,first.nextByteOffset);
 for(const byteOffset of [-1,1.5,'1'])assert.equal((await doc.execute({action:'read',path:'long.md',byteOffset},{agent:{session}})).code,'invalid-byte-offset');
});

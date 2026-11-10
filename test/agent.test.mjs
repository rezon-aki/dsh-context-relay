import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/agent.js';
import { clearPanelMemory, configurePanelStore, liveStateOf, panelStateOf, updatePanelState } from '../lib/panel-store.js';
import { listHandoffs } from '../lib/handoff-store.js';

const HANDOFF_KEY = Symbol.for('dsh-context-relay.handoffs');
/** 每次切 phase 必填的契约自检（两条用户契约的工作时落地）。 */
const CONTRACT_CHECK = { requirement: '需求已定：用户要两条契约；边界：只改 relay 插件', fidelity: '实现忠实，无偏移/劣化/偷懒/缺失', attention: '本阶段不打扰用户（无最小高影响点）' };
/** 进 ship 的用户门（新上下文独立审查 + 大白话汇报；宿主只校验非空）。 */
const SHIP_GATE = { review: 'fresh subagent 独立审查：需求已定、实现忠实，无偏移/劣化/偷懒/缺失', report: '大白话汇报：需求 → 实现 + 证据 → 无偏差、边界已说明' };

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
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-panel-')), 'panel.json') });
}

/** 极简 fake ctx：只实现 agent.js 用到的接口，捕获注册产物 + logger 里程碑。 */
function fakeCtx(overrides = {}) {
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
    get(name) { return overrides.services?.[name]; },
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
  const found = events.find((event) => event.name === 'agent/pre-step');
  assert.ok(found, 'agent/pre-step listener registered');
  return found.listener;
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-test-'));
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
  assert.equal(sections.length, 3, 'protocol section + unlimited-budget section + work-ledger section（v0.5.0）');
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
  assert.match(ledgerText, /工作台账（多分支任务真源/);
  assert.match(ledgerText, /relay_work_items/);
  assert.match(ledgerText, /不更新 = 新会话与用户面板看不到/);
  assert.match(ledgerText, /blocked 必须写 blocked 原因/);
  assert.match(ledgerText, /交接与压缩会自动把未闭合项/);
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
  // 2026-11-02 用户澄清：两段式（第 1 次到线压缩并留在本会话，第 2 次才开新会话）+ 直接接力路径
  assert.match(sections[0].text, /不要立即 relay_handoff/);
  assert.match(sections[0].text, /第二次到线才 relay_handoff/);
  assert.match(sections[0].text, /不要先调 relay_phase/);
  // 2026-10-25 面板契约：到线提醒与压缩次数解耦、一次性默认操作、授权/免审口径、不再弹官方审批
  assert.match(sections[0].text, /到线提醒/);
  assert.match(sections[0].text, /与压缩次数无关/);
  // v0.4.0：模式持久（不消费），到线按模式执行
  assert.match(sections[0].text, /\*\*持久\*\*（不消费）/);
  assert.match(sections[0].text, /autoChoose 只决定谁选操作，不产生免审/);
  // B-P1-2：授权语义收敛到唯一权威句（预设不产生豁免；免审只来自三个授权）
  assert.match(sections[0].text, /模式只决定「做什么」/);
  assert.match(sections[0].text, /不产生审批豁免/);
  assert.match(sections[0].text, /免审只来自 autoCompress \/ autoHandoff \/ authorizeNext/);
  assert.doesNotMatch(sections[0].text, /本次免审批|视为已授权|pre-authorize/);
  assert.match(sections[0].text, /autoChoose/);
  // 工具描述同步提面板、不提审批弹窗
  assert.match(tools.get('relay_phase').description, /composer panel/);
  assert.match(tools.get('relay_handoff').description, /composer panel/);
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, ['doc_lint', 'relay_handoff', 'relay_organize', 'relay_phase', 'relay_recommend', 'relay_status', 'relay_work_items']);
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

test('relay_phase over budget: 面板五分支（continue / compress / handoff / autoChoose / ask）', async () => {
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
    const call = (args = {}) => tools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {}, inject(message) { injected.push(message); } } });
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
  // 同 phase 重复声明不是「开新 phase」：不提醒、不动预设
  updatePanelState('session-panel-continue', { autoChoose: true });
  const same = await cont.call();
  assert.equal(same.phase, 'build');
  assert.equal(same.reminder, undefined);
  assert.equal(cont.injected.length, 1);
  assert.equal(panelStateOf('session-panel-continue').autoChoose, true);

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

  // 4) autoChoose（无预设）：不切换 + 抛错；未压缩过 → 推荐压缩继续；autoChoose 是持久开关不消费
  const auto = make('session-panel-auto', { autoChoose: true });
  await assert.rejects(auto.call(), (error) => /autoChoose=on/.test(error.message) && /压缩继续/.test(error.message));
  assert.equal(panelStateOf('session-panel-auto').autoChoose, true);
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

test('v0.3.1 relay-long（routerMode）面板隐藏档归一：压缩→新会话 / 自动 按「继续」放行；classic 不变', async () => {
  resetSharedState();
  const make = (id, preset, config = {}) => {
    const session = fakeSession({ id, cwd: tmpCwd(), seq: 0 });
    const bundle = fakeServices({
      session,
      pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 },
      compaction: { async compactIfNeeded() { return { shadowedTokenCount: 5 }; } },
    });
    const { tools } = applyAgent(bundle.services, config);
    if (preset !== undefined) updatePanelState(id, preset);
    const injected = [];
    const call = (args = {}) => tools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {}, inject(message) { injected.push(message); } } });
    return { session, tools, call, injected };
  };

  // 1) v0.3.4：长模式 + 存量档「压缩→新会话」：不再两段式——按「继续」放行（不压缩不接力）并清空预设
  const cth = make('session-long-hidden-cth', { defaultOperation: 'compress-then-handoff' }, { routerMode: true });
  const switched = await cth.call();
  assert.equal(switched.phase, 'build');
  assert.equal(switched.previous, 'discover');
  assert.equal(switched.band, 'organize');
  assert.match(switched.reminder, /长模式已移除该档/);
  assert.match(switched.reminder, /按继续处理并清空/);
  assert.match(switched.reminder, /chip 的 4 项/);
  assert.match(switched.reminder, /问我\/继续\/压缩继续\/接力新会话/);
  assert.match(switched.summary, /面板模式=继续（隐藏档归一）/);
  assert.equal(panelStateOf('session-long-hidden-cth').defaultOperation, null, '存量档按 continue 同一路径清空');
  assert.equal(cth.injected.length, 1, '放行路径注入 phase 边界 notice');
  assert.match(cth.injected[0].content[0].text, /长模式已移除该档/);
  assert.match(cth.injected[0].content[0].text, /并清空/);
  assert.match(cth.injected[0].content[0].text, /注意下一次继续方式/);

  // 2) 长模式 + 存量隐藏档「自动（模型决定）」：按「继续」放行；autoChoose 持久开关不动（零副作用）
  const auto = make('session-long-hidden-auto', { autoChoose: true }, { routerMode: true });
  const autoSwitch = await auto.call();
  assert.equal(autoSwitch.phase, 'build');
  assert.match(autoSwitch.reminder, /长模式已隐藏/);
  assert.match(autoSwitch.reminder, /自动（模型决定）/);
  assert.match(autoSwitch.reminder, /autoChoose 开关不动/);
  assert.match(autoSwitch.reminder, /chip 的 4 项/);
  assert.equal(panelStateOf('session-long-hidden-auto').autoChoose, true, 'autoChoose 开关不被消费/改写');
  assert.equal(panelStateOf('session-long-hidden-auto').defaultOperation, null);

  // 3) 长模式非隐藏档仍按原语义（「压缩」继续拒绝、预设保留）
  const compress = make('session-long-hidden-compress', { defaultOperation: 'compress' }, { routerMode: true });
  await assert.rejects(compress.call(), /relay_organize/);
  assert.equal(panelStateOf('session-long-hidden-compress').defaultOperation, 'compress', '非隐藏档不消费');

  // 4) classic 完全不变：同一隐藏档仍被拦截（压缩→新会话指令 / autoChoose 自决），预设与开关不消费
  const classicCth = make('session-classic-hidden-cth', { defaultOperation: 'compress-then-handoff' });
  await assert.rejects(classicCth.call(), /压缩→新会话/);
  assert.equal(panelStateOf('session-classic-hidden-cth').defaultOperation, 'compress-then-handoff', 'classic 不归一、不消费');
  assert.equal(classicCth.injected.length, 0, '拒绝分支零副作用（不再注入边界 notice）');
  const classicAuto = make('session-classic-hidden-auto', { autoChoose: true });
  await assert.rejects(classicAuto.call(), /autoChoose=on/);
  assert.equal(panelStateOf('session-classic-hidden-auto').autoChoose, true);

  // 5) fail-safe：routerMode 非布尔 true 不生效（运行时严格布尔）→ 仍按 classic 拦截
  const loose = make('session-loose-hidden-cth', { defaultOperation: 'compress-then-handoff' }, { routerMode: 'true' });
  await assert.rejects(loose.call(), /压缩→新会话/);
  assert.equal(panelStateOf('session-loose-hidden-cth').defaultOperation, 'compress-then-handoff');
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

test('reminder listener registration is idempotent per ctx', () => {
  resetSharedState();
  const session = fakeSession({ seq: 0 });
  const { services } = fakeServices({ session });
  const { ctx, events } = fakeCtx({ services });
  apply(ctx, {});
  apply(ctx, {});
  assert.equal(events.filter((event) => event.name === 'agent/pre-step').length, 1);
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
    tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session: sub, options: {}, inject(message) { injected.push(message); } } }),
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
  const { listHandoffs } = await import('../lib/handoff-store.js');
  assert.equal(listHandoffs().length, 0);
});

test('relay_handoff creates a new root session, bounded handoff, and records it for M3', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-caller', cwd, seq: 0 });
  const created = [];
  const followed = [];
  const cleanupCalls = { killedJobs: [], createdSchedules: [], deletedSchedules: [], teammateInterrupts: [], subagentInterrupts: [], drained: [], drainedDescendants: [], order: [] };
  const liveSession = { id: 'session-new', header: { cwd }, requestHeader: () => undefined };
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
        // 按 owner session 枚举（队友名下也可能有定时任务记录）
        list: async ({ sessionId }) => ({
          'session-caller': [
            { id: 'sched-old', kind: 'every', title: 'check build', prompt: 'check the build', everySeconds: 300 },
            { id: 'sched-once', kind: 'after', title: 'review PR', prompt: 'review the pr', afterSeconds: 600, scheduledAt: '2026-11-01T15:00:00.000Z' },
          ],
          'teammate-1': [{ id: 'sched-mate', kind: 'cron', title: 'mate cron', prompt: 'mate cron prompt', expression: '*/5 * * * *', timeZone: 'UTC', scheduledAt: '2026-11-01T16:00:00.000Z' }],
        }[sessionId] ?? []),
        create: async (sessionId, request) => { cleanupCalls.createdSchedules.push([sessionId, request]); cleanupCalls.order.push('schedule-transfer'); return { id: 'sched-new' }; },
        delete: async (request) => { cleanupCalls.deletedSchedules.push(request); return { deleted: true }; },
      },
      agentTeams: {
        tryMembership: () => ({ role: 'lead', name: 'lead' }),
        listMembers: () => [
          { role: 'lead', name: 'lead', status: 'running' },
          { role: 'teammate', id: 'teammate-1', name: 'reviewer', status: 'running' },
        ],
        interrupt: (caller, name) => { cleanupCalls.teammateInterrupts.push(name); cleanupCalls.order.push('teammate-interrupt'); },
      },
      subagents: {
        listDescendants: async () => [
          { kind: 'child', id: 'child-1', mode: 'continuable', activity: 'running', parentId: 'session-caller', depth: 1 },
          { kind: 'child', id: 'teammate-1', mode: 'continuable', activity: 'running', parentId: 'session-caller', depth: 1 },
          { kind: 'diagnostic', id: 'child-broken', reason: 'corrupt' },
        ],
        // 真实 API：listChildren 返回 SubagentCatalogEntry（无 kind/activity 字段）。
        listChildren: async () => [{ id: 'child-1', createdAt: 0, mode: 'continuable', label: 'child' }],
        interrupt: (id, authority) => { cleanupCalls.subagentInterrupts.push({ id, authority }); cleanupCalls.order.push('subagent-interrupt'); },
        drainChildren: async (caller, ids) => { cleanupCalls.drained.push(ids); cleanupCalls.order.push('drain-children'); },
        drainDescendants: async (parents) => { cleanupCalls.drainedDescendants.push(parents.map((parent) => parent.session.id)); cleanupCalls.order.push('drain-descendants'); },
      },
      sessionController: {
        async create(request) { created.push(request); return { sessionId: 'session-new' }; },
      },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup(message) { followed.push(message); } }] },
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
  assert.deepEqual(cleanupCalls.killedJobs, [
    ['bash-old', 'session-caller', 'relay handoff: moved to new session'],
    ['bash-mate', 'teammate-1', 'relay handoff: moved to new session'],
    ['bash-child', 'child-1', 'relay handoff: moved to new session'],
    ['bash-broken', 'child-broken', 'relay handoff: moved to new session'],
  ], '取消旧会话树（Lead/队友/子智能体/诊断子级）名下运行中的后台任务（归属不能跨会话转移）');
  assert.ok(result.handover.inventory.jobs.some((job) => job.id === 'bash-broken'), 'diagnostic 行的子会话 id 也参与 owner 枚举/清理');
  // unowned job 对任何 caller 可见：不得被当作旧会话残留误杀/误记（P1）
  assert.ok(cleanupCalls.killedJobs.every(([id]) => id !== 'job-global'), 'unowned job 不能杀');
  assert.ok(!result.handover.inventory.jobs.some((job) => job.id === 'job-global'), 'unowned job 不进盘点');
  // 定时任务按 owner session 枚举（含队友名下），after 用绝对 scheduledAt 迁移（不重新计时）
  assert.equal(cleanupCalls.createdSchedules.length, 3, '定时任务迁移到新会话（Lead 2 + 队友 1）');
  assert.deepEqual(cleanupCalls.createdSchedules[0], ['session-new', { title: 'check build', prompt: 'check the build', every_seconds: 300 }]);
  assert.deepEqual(cleanupCalls.createdSchedules[1], ['session-new', { title: 'review PR', prompt: 'review the pr', at: '2026-11-01T15:00:00.000Z' }]);
  assert.deepEqual(cleanupCalls.createdSchedules[2], ['session-new', { title: 'mate cron', prompt: 'mate cron prompt', cron: { expression: '*/5 * * * *', time_zone: 'UTC' } }]);
  assert.deepEqual(cleanupCalls.deletedSchedules, [
    { sessionId: 'session-caller', id: 'sched-old' },
    { sessionId: 'session-caller', id: 'sched-once' },
    { sessionId: 'teammate-1', id: 'sched-mate' },
  ], '迁移成功后按 owner 删除旧定时任务');
  assert.deepEqual(cleanupCalls.teammateInterrupts, ['reviewer'], '中断运行中的队友');
  assert.equal(cleanupCalls.subagentInterrupts.length, 1, '中断运行中的子智能体（队友不算子智能体，去重）');
  assert.equal(cleanupCalls.subagentInterrupts[0].id, 'child-1');
  assert.equal(cleanupCalls.subagentInterrupts[0].authority.kind, 'ancestor', 'DSH 契约：interrupt authority 必须是 {kind:"ancestor",agent}');
  assert.equal(cleanupCalls.subagentInterrupts[0].authority.agent.session.id, 'session-caller');
  assert.deepEqual(cleanupCalls.drained, [['child-1']], '释放驻留子智能体');
  assert.deepEqual(cleanupCalls.drainedDescendants, [['session-caller']], 'drainDescendants 覆盖 materializing/深层子级');
  // 清理顺序（用户要求「尤其清理顺序」）：先中断成员，再 drain，再取消后台任务，最后迁移定时任务。
  const orderIndex = (tag) => cleanupCalls.order.indexOf(tag);
  assert.ok(orderIndex('teammate-interrupt') >= 0 && orderIndex('subagent-interrupt') >= 0, '先中断成员');
  assert.ok(orderIndex('teammate-interrupt') < orderIndex('drain-descendants'), '中断队友先于 drain');
  assert.ok(orderIndex('drain-descendants') < orderIndex('job-kill'), '先 drain 成员再取消后台任务');
  assert.ok(orderIndex('job-kill') < orderIndex('schedule-transfer'), '先取消后台任务再迁移定时任务');
  assert.equal(result.handover.cleanup.jobs[0].action, 'killed');
  assert.equal(result.handover.cleanup.schedules[0].action, 'transferred');
  assert.equal(result.handover.cleanup.teammates[0].action, 'interrupted');
  assert.equal(result.handover.cleanup.subagents[0].action, 'interrupted');
  assert.deepEqual(result.handover.inventory.subagents.map((entry) => entry.id), ['child-1'], '队友不计入子智能体盘点（去重）');
  // listDescendants 的 diagnostic 行不能静默丢弃：其 catalog 不可读 → 记 errors（P2）
  assert.ok(result.handover.inventory.errors.some((line) => /child-broken/.test(line)), 'diagnostic 行进 inventory.errors');
  assert.ok(result.handover.cleanup.errors.some((line) => /child-broken/.test(line)), 'diagnostic 行进 cleanup.errors');
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
  assert.match(result.summary, /子智能体 1→1 已中断/);
  // handoff 文件追加交接清单 + 清理结果（首条消息有 handoffPath 指路）
  const handoffFile = readFileSync(result.handoffPath, 'utf8');
  assert.match(handoffFile, /## 交接清单（旧会话残留，自动盘点）/);
  assert.match(handoffFile, /## 交接清理结果/);
  assert.match(handoffFile, /bash-old → killed/, '清理结果逐行细节仍落在 handoff 文件（不再发给新会话）');
  assert.match(text, /## Handoff 文件/, '首条消息给出 handoff 文件路径');
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
  // M3 发布箱：宿主侧靠 recordHandoff/listHandoffs 拉取
  const { listHandoffs } = await import('../lib/handoff-store.js');
  const items = listHandoffs();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, result.handoffId);
  assert.equal(items[0].sessionId, 'session-new');
  assert.equal(items[0].parentSessionId, 'session-caller');
  assert.equal(items[0].phase, 'build');
  assert.match(items[0].goal, /ship the relay plugin/);
  assert.ok(items[0].summary.length <= 200);
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
  for (const key of ['jobs', 'schedule', 'agentTeams', 'subagents']) {
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

test('relay_handoff 交接清理：单项失败降级记录 errors、不阻断接力；create 成功 delete 失败时回滚新行', async () => {
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
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(followed.length, 1, '接力照常交付，但清理报告不再发给新会话');
  assert.deepEqual(result.handover.cleanup.jobs.map((row) => row.action), ['kill-failed']);
  assert.deepEqual(result.handover.cleanup.schedules.map((row) => row.action), ['transfer-failed', 'transfer-failed', 'transfer-failed']);
  assert.ok(result.handover.cleanup.errors.some((line) => /kill boom/.test(line)));
  assert.ok(result.handover.cleanup.errors.some((line) => /create boom/.test(line)));
  assert.ok(result.handover.cleanup.errors.some((line) => /delete boom/.test(line)));
  assert.ok(result.handover.cleanup.errors.some((line) => /descendants boom/.test(line)), '盘点失败也会进 cleanup.errors');
  // 兜底提示：inventory 非空（有残留任务）且模型漏填 next_actions 时也要提示
  assert.match(followed[0].content[0].text, /旧会话未提供 next_actions（模型未记录未完成工作）/, '有自动清单也要提示漏填');
  // summary 反映清理结果（不是盘点数）：1 个 job 取消失败 → 1→0；3 个迁移全失败 → 3→0
  assert.match(result.summary, /后台任务 1→0 已取消/);
  assert.match(result.summary, /定时任务 3→0 已迁移/);
  // create 成功但 delete 失败：回滚刚建的新行，避免旧+新双份
  assert.deepEqual(created, [
    ['session-fail-new', { title: 'fail delete', prompt: 'p2', daily: { time: '09:00:00', time_zone: 'UTC' } }],
    ['session-fail-new', { title: 'fail rollback', prompt: 'p3', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1] } }],
  ]);
  assert.deepEqual(removed, [{ sessionId: 'session-fail-new', id: 'new-sched-1' }], '回滚删除新行（第二条回滚失败记 errors）');
  assert.ok(result.handover.cleanup.errors.some((line) => /schedule rollback new-sched-2/.test(line)), '回滚自身失败也要记 errors');
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

test('relay_handoff preflight：超大 evidence 先拒绝（不建会话/不写文件），精简后 agents.create 回退成功', async () => {
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
  const refused = await tools.get('relay_handoff').execute({
    status: { goal: 'bounded handoff', phase: 'verify' },
    evidence: oversized,
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(refused.ok, false, JSON.stringify(refused).slice(0, 200));
  assert.equal(refused.code, 'handoff-truncated');
  assert.equal(refused.caps.truncated, true);
  assert.ok(refused.caps.truncatedSections.includes('chars:evidence'), '单条 200 字符裁剪记账：' + JSON.stringify(refused.caps.truncatedSections));
  assert.match(refused.hint, /未创建会话/);
  assert.equal(created.length, 0, '预检拒绝不建会话（修改后重试即可，不重复接力）');
  assert.equal(followed.length, 0);
  // 精简后重试：caps 合规 → agents.create 回退路径成功
  const evidence = Array.from({ length: 11 }, (_, index) => 'e' + index + '-' + 'x'.repeat(150));
  const result = await tools.get('relay_handoff').execute({
    status: { goal: 'bounded handoff', phase: 'verify' },
    evidence,
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.caps.truncated, false, '合规 handoff 不标截断');
  assert.equal(created.length, 1);
  assert.equal(created[0].meta.agentPreset, 'relay');
  assert.equal(created[0].meta.cwd, cwd);
  assert.equal(followed.length, 1, '只发 handoff 首条消息（清理报告不再另发）');
  const bytes = Buffer.byteLength(followed[0].content[0].text, 'utf8');
  assert.ok(bytes <= result.caps.bytes.limit, 'handoff bytes ' + bytes);
  const { listHandoffs } = await import('../lib/handoff-store.js');
  assert.equal(listHandoffs().length, 1);
});

test('relay_handoff 用面板 handoffPreset 选择下一个会话模式（controller 路径；sticky 不消费；不继承子会话）', async () => {
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
  // host 经 preset 行 config 透传两个模式 id（relayPresetIds 白名单）
  const { tools } = applyAgent(services, { relayPresetIds: ['relay', 'relay-long'] });
  updatePanelState(session.id, { handoffPreset: 'relay-long' });
  const result = await tools.get('relay_handoff').execute(
    { status: { goal: 'next session in long mode' }, human_approved: true },
    { agent: { session, options: {} } },
  );
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.createdVia, 'sessionController.create');
  assert.equal(created[0].agentPreset, 'relay-long', 'controller.create 用面板选择的模式');
  // sticky：成功后父会话面板不清 handoffPreset（开关可见即可预期）
  assert.equal(panelStateOf(session.id).handoffPreset, 'relay-long');
  // 不继承：新会话自己的面板保持默认 null（下一次接力由新会话人类自己选）
  assert.equal(panelStateOf('session-hp-child').handoffPreset, null);
  assert.equal(followed.length, 1);
});

test('relay_handoff agents.create 路径：meta.agentPreset/presets.mount 同用面板 handoffPreset；白名单外/缺省回落本 preset', async () => {
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
  const { tools } = applyAgent(services, { relayPresetIds: ['relay', 'relay-long'] });
  const handoff = async (sessionId, handoffPreset) => {
    const session = fakeSession({ id: sessionId, cwd, seq: 0 });
    updatePanelState(sessionId, { handoffPreset });
    const result = await tools.get('relay_handoff').execute(
      { status: { goal: 'preset selection ' + sessionId }, human_approved: true },
      { agent: { session, options: {} } },
    );
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  };
  // 白名单内：relay-long → meta.agentPreset 与 presets.mount 三处一致
  await handoff('session-hp-a', 'relay-long');
  assert.equal(created[0].meta.agentPreset, 'relay-long');
  assert.equal(mounted[0], 'relay-long', 'presets.mount 与 meta.agentPreset 一致');
  // 白名单外的旧值（其它部署/历史 preset id）→ 回落本会话 preset
  await handoff('session-hp-b', 'ptc');
  assert.equal(created[1].meta.agentPreset, 'relay');
  assert.equal(mounted[1], 'relay');
  // 显式 null（跟随本会话）→ 同样回落本会话 preset
  await handoff('session-hp-c', null);
  assert.equal(created[2].meta.agentPreset, 'relay');
  assert.equal(mounted[2], 'relay');
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
  const { listHandoffs } = await import('../lib/handoff-store.js');
  assert.equal(listHandoffs().length, 0);
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

test('v0.3.8 长模式 advice 只列三档、不出现「压缩→新会话」；classic 仍保留该标签', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const makeReport = async (id, routerMode) => {
    const session = fakeSession({ id, cwd, seq: 0 });
    const { tools } = applyAgent(fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } }).services, { routerMode });
    // 升级残留：长模式旧会话可能存了已移除档位的预设；应按无预设处理且不把它写进模型可见文本。
    updatePanelState(id, { defaultOperation: 'compress-then-handoff' });
    return { report: await tools.get('relay_status').execute({}, { agent: { session, options: {} } }), session };
  };
  const long = await makeReport('session-v038-long-advice', true);
  assert.match(long.report.advice, /继续 \/ 压缩继续 \/ 接力新会话/);
  assert.doesNotMatch(long.report.advice, /压缩→新会话/, '长模式模型可见 advice 不得出现已移除档位');
  assert.equal(long.report.continue.preset, null, '长模式升级残留预设按无预设处理');
  assert.doesNotMatch(long.report.text, /压缩→新会话/);

  const classic = await makeReport('session-v038-classic-advice', false);
  assert.match(classic.report.advice, /压缩→新会话/, 'classic 面板档位列表照旧');
  assert.equal(classic.report.continue.preset, 'compress-then-handoff');
  assert.match(classic.report.text, /continue: 面板模式=压缩→新会话/);
});

test('v0.3.8 长模式到线提醒/面板行不显示升级残留的 cth 默认操作；classic 仍显示', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const listenerOf = (events) => events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const noticeOf = async (id, routerMode) => {
    const session = fakeSession({ id, cwd });
    const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
    const injected = [];
    const listener = listenerOf(applyAgent(services, { routerMode }).events);
    updatePanelState(id, { defaultOperation: 'compress-then-handoff' });
    await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
    return injected[0]?.content?.[0]?.text ?? '';
  };
  const longText = await noticeOf('session-v038-long-notice-cth', true);
  assert.ok(longText.length > 0, '长模式应注入到线提醒');
  assert.doesNotMatch(longText, /压缩→新会话/, '长模式到线提醒不得显示已移除档位');
  assert.match(longText, /模式「问我」/, '长模式残留预设按「问我」展示');
  const classicText = await noticeOf('session-v038-classic-notice-cth', false);
  assert.match(classicText, /模式「压缩→新会话」/, 'classic 仍正常显示该档');
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
  // B-P2-6：两段式「压缩→新会话」同一到线（已压缩 + 未到线）注定被工具体拒绝 → 不弹审批
  const twoStageSession = fakeSession({ id: 'session-approval-two-stage', cwd, seq: 0, log: organizedLog });
  updatePanelState('session-approval-two-stage', { defaultOperation: 'compress-then-handoff' });
  const twoStageExec = { ...handoffExec, agent: { session: twoStageSession } };
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 130_000 }; // 13% → ok（未到线）
  assert.equal((await gate(twoStageExec, async () => ({ kind: 'allow' }))).kind, 'allow', '两段式未到线注定被拒 → 不弹审批');
  // 下一次到线（organize）→ 仍按两段式正常 ask（预设不自动免审）
  state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  assert.equal((await gate(twoStageExec, async () => ({ kind: 'allow' }))).kind, 'ask', '下一次到线仍正常 ask');
  // v0.3.8：长模式没有「压缩→新会话」档——两段式预判不生效（不因它免审）。
  const longTwoStageSession = fakeSession({ id: 'session-approval-long-two-stage', cwd, seq: 0, log: organizedLog });
  updatePanelState('session-approval-long-two-stage', { defaultOperation: 'compress-then-handoff' });
  const longGate = preExecuteListener(applyAgent(fakeServices({ session: longTwoStageSession, pressure: { contextWindow: 1_000_000, projectedTokens: 130_000 }, extra: { approval } }).services, { routerMode: true }).events);
  const longTwoStageExec = { ...handoffExec, agent: { session: longTwoStageSession } };
  assert.equal((await longGate(longTwoStageExec, async () => ({ kind: 'allow' }))).kind, 'ask', '长模式两段式预判不生效：正常走接力审批');

  // 审批服务缺失：fail-closed deny + 部署提示（可配置 off）
  const noApprovalApply = applyAgent(fakeServices({ session: fakeSession({ id: 'session-approval-missing', cwd }) }).services);
  const missing = await preExecuteListener(noApprovalApply.events)(handoffExec, async () => ({ kind: 'allow' }));
  assert.equal(missing.kind, 'deny');
  assert.equal(missing.info.code, 'relay-approval-unavailable');
  assert.match(missing.reason, /handoffApproval="off"/);

  // handoffApproval='off'：不注册 gate；human_approved 参数仍在工具体内守卫
  const off = applyAgent(fakeServices({ session: fakeSession({ id: 'session-approval-off', cwd }) }).services, { handoffApproval: 'off' });
  assert.equal(off.events.filter((event) => event.name === 'tools/pre-execute').length, 0);
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
  assert.equal(handoffWrite.code, 'handoff-write-failed');
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
  assert.deepEqual(disposedLive, ['session-half-1'], 'half-created session disposed exactly once');
  assert.match(timedOut.summary, /half-created session cleanup attempted/);
  assert.match(timedOut.summary, /Retry relay_handoff/);

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
  assert.deepEqual(disposedFollowup, ['session-half-2'], 'half-created session disposed exactly once');
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
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session, options: {} } }), /relay_phase refused/);
  // 面板一次性默认操作「继续」→ 放行
  updatePanelState(session.id, { defaultOperation: 'continue' });
  const switched = await tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session, options: {} } });
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

test('面板默认操作与 autoChoose 出现在到线提醒与 relay_status 建议里（rev5.2 两模式互斥）', async () => {
  // ① autoChoose 模式（模型自决）：advice/提醒带 autoChoose + 授权 + 已记录决定
  resetSharedState();
  const session = fakeSession({ id: 'session-panel-advice-auto', seq: 0 });
  const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, events } = applyAgent(bundle.services);
  updatePanelState(session.id, { autoChoose: true, authorizeNext: true, autoDecision: { operation: 'handoff', at: 1 } });
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.match(report.advice, /autoChoose=on/);
  assert.match(report.advice, /composer「接力」chip/);
  assert.match(report.advice, /next_operation/, 'advice 提示记录模型自决');
  const listener = preStepListener(events);
  const injected = [];
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 420_000 };
  await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  assert.equal(injected.length, 1);
  const text = injected[0].content[0].text;
  // rev5.2 互斥：autoChoose=on 时显式模式被忽略（显示「问我」）
  assert.match(text, /模式=问我/);
  assert.match(text, /autoChoose=on/);
  // panelLineOf 去掉同值重复字段：autoDecision 与「下一次操作」只报一次（排障/提醒共用）
  assert.match(text, /authorizeNext=on/);
  assert.match(text, /已记录操作=handoff/);
  assert.doesNotMatch(text, /autoDecision=/, 'autoDecision 与已记录操作同值，不重复报');
  // 长度回归：autoChoose 变体 ≤500 字符（原 985；v0.3.3 追加 relay_recommend 指引行）
  assert.ok(text.length <= 500, 'autoChoose notice chars ' + text.length);
  // ② 人类模式（autoChoose=off）：提醒读回「模式=压缩」
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
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session, options: {} } }), /relay_handoff/);
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
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session, options: {} } }));
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

test('panel 预设「压缩→新会话」第 1 段：不切换、保留预设、指令 organize；压缩成功后第 2 段保留预设、指令 handoff（成功后消费）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const log = [];
  const session = fakeSession({ id: 'session-cth-two-stage', cwd, log });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  // 侧栏默认值（未改过面板的会话）：两段都由同一 session 的派生状态演进。
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff' };
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  const call = (args = {}) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', ...args }, { agent });

  // 第 1 段：organizeCount=0 → 不切换、预设保留（含侧栏默认值）、抛错指令 organize；
  // 文案必须写明「压缩成功后留在本会话继续，不要立即 relay_handoff；第 2 步只在下一次到线」（2026-11-02 用户澄清）。
  await assert.rejects(call(), (error) => /relay_organize/.test(error.message)
    && /压缩成功后留在本会话继续/.test(error.message)
    && /不要立即 relay_handoff/.test(error.message)
    && /第 2 步只在下一次到线执行/.test(error.message));
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress-then-handoff', '第 1 段保留模式');
  assert.equal(panelStateOf(session.id).authorizeNext, false, '预设不产生授权');
  assert.equal(injected.length, 0, '拒绝分支只 throw，不再注入 phase 边界 notice（错误必达）');
  await assert.rejects(call(), (error) => /relay_organize/.test(error.message) && /第 1\/2 步/.test(error.message) && /不要立即 relay_handoff/.test(error.message));
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress-then-handoff');
  assert.equal(injected.length, 0, '重试拒绝同样零 notice');

  // 压缩成功（日志出现 organized: freed）→ 第 2 段：预设仍保留，抛错指令 handoff（rev5.5：不再自带预授权）
  log.push({ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'discover' }, isError: false, content: [{ type: 'text', text: 'organized: freed 321 tokens' }] } });
  // 换一个目标 phase 以便观察第 2 段 notice（同 discover→build 边界已注入过去重）
  await assert.rejects(call({ phase: 'verify' }), (error) => /relay_handoff/.test(error.message)
    && !/先调 relay_organize/.test(error.message)
    && /第 2\/2 步/.test(error.message)
    && /授权/.test(error.message));
  const panel = panelStateOf(session.id);
  assert.equal(panel.defaultOperation, 'compress-then-handoff', '第 2 段保留模式（持久，不消费，B-P2-3）');
  assert.equal(panel.authorizeNext, false);
  assert.equal(injected.length, 0);
  assert.equal(liveStateOf(session.id).phase, 'discover', '第 2 段也不切换 phase');
  resetSharedState();
});

test('compress-then-handoff 端到端：第 2 段不再自带免审 → 授权下一次操作后接力成功并消费（rev5.5）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  // 本会话已成功压缩过一次：预设命中时直接进入第 2 段（无需再压缩）。
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
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent }),
    (error) => /relay_handoff/.test(error.message) && /第 2\/2 步/.test(error.message));
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress-then-handoff', 'B-P2-3：模式保留（持久，不消费）');
  assert.equal(panelStateOf(session.id).authorizeNext, false, 'rev5.5：预设不再自带免审');
  assert.equal(injected.length, 0, '拒绝分支只 throw，不再注入 notice');
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '预设不自动免审');

  // 人类点「授权下一次操作」→ 一次性免审 → 接力成功只消费一次性授权（模式持久）
  updatePanelState(session.id, { authorizeNext: true });
  assert.equal((await gate(handoffExec, next)).kind, 'allow', '一次性授权免审批');
  const result = await tools.get('relay_handoff').execute({ status: { goal: 'cth relay' }, human_approved: true }, { agent });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(panelStateOf(session.id).authorizeNext, false, '接力成功后一次性授权被消费');
  assert.equal(panelStateOf(session.id).defaultOperation, 'compress-then-handoff', '接力成功后模式不消费（v0.4.0 持久）');
  assert.equal(panelStateOf('session-cth-new').defaultOperation, 'compress-then-handoff', '新会话继承当前模式');
  assert.equal((await gate(handoffExec, next)).kind, 'ask', '消费后再次接力需要审批');
  resetSharedState();
});

test('两段式闸门（2026-11-02 用户澄清）：「压缩→新会话」同一到线压完立即 relay_handoff 被拒（零副作用）；下一次到线/非两段式预设/未压缩时允许', async () => {
  resetSharedState();
  const organized = { type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } };
  const PRESSURE = {
    ok: { contextWindow: 1_000_000, projectedTokens: 20_000 },       // 2% → ok（同一到线压缩后回落）
    warn: { contextWindow: 1_000_000, projectedTokens: 360_000 },    // 36% → warn（未到线）
    organize: { contextWindow: 1_000_000, projectedTokens: 420_000 },// 42% → organize（下一次到线）
    relay: { contextWindow: 1_000_000, projectedTokens: 600_000 },   // 60% → relay（下一次到线）
  };
  // ── 拒绝：预设 compress-then-handoff + 已压缩（organizeCount>=1）+ 未到线（ok/warn）──
  for (const band of ['ok', 'warn']) {
    const started = [];
    const sessionCwd = tmpCwd();
    const session = fakeSession({ id: 'session-two-stage-deny-' + band, cwd: sessionCwd, seq: 0, log: [organized] });
    const { services } = fakeServices({
      session,
      pressure: PRESSURE[band],
      extra: { sessionController: { async create() { started.push('created'); return { sessionId: 'should-not-exist' }; } } },
    });
    const tool = applyAgent(services).tools.get('relay_handoff');
    updatePanelState(session.id, { defaultOperation: 'compress-then-handoff', authorizeNext: true });
    const result = await tool.execute({ human_approved: true, status: { goal: 'same-crossing' } }, { agent: { session, options: {} } });
    assert.equal(result.ok, false, band + '：同一到线压完不得立即接力');
    assert.equal(result.code, 'two-stage-not-due');
    assert.equal(result.band, band);
    assert.equal(result.organizeCount, 1);
    // 可执行指引：第 1 段已完成 / 留在本会话 / 第 2 段只在下一次到线 / 人类坚持时改预设
    assert.match(result.error, /第 1 段压缩已完成/);
    assert.match(result.error, /不要立即 relay_handoff/);
    assert.match(result.error, /下一次到线/);
    assert.match(result.error, /defaultOperation=handoff/);
    assert.match(result.error, /defaultOperation=null/);
    assert.match(result.summary, /stage-1 compression is already done/);
    // 零副作用：不建会话、不写 handoff/brief 文件、不写 handoff 发布箱、不改模式/不消费授权
    assert.equal(started.length, 0, '被拒路径不创建会话');
    assert.equal(existsSync(join(sessionCwd, '.scratch', 'context-relay')), false, '被拒路径不写 handoff/brief 文件');
    assert.equal(listHandoffs().length, 0, '被拒路径不写 handoff 发布箱');
    assert.equal(panelStateOf(session.id).defaultOperation, 'compress-then-handoff', '被拒路径不改模式');
    assert.equal(panelStateOf(session.id).authorizeNext, true, '被拒路径不消费授权');
    assert.equal(panelStateOf(session.id).handedOff, false);
  }
  // 面板生效值来自侧栏默认（未改过面板的会话）时同样生效、同样不消费默认值
  const fromSettings = fakeSession({ id: 'session-two-stage-settings', cwd: tmpCwd(), seq: 0, log: [organized] });
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff', autoChoose: false };
  const settingsTools = applyAgent(fakeServices({ session: fromSettings, pressure: PRESSURE.ok }).services).tools;
  const settingsResult = await settingsTools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'settings default' } }, { agent: { session: fromSettings, options: {} } });
  assert.equal(settingsResult.ok, false);
  assert.equal(settingsResult.code, 'two-stage-not-due');
  assert.equal(panelStateOf(fromSettings.id).defaultOperation, 'compress-then-handoff', '侧栏默认值不因拒绝被消费');
  resetSharedState();

  // ── 允许：下一次到线（organize/relay）、organizeCount=0（第 1 段未做）、非两段式/无预设 ──
  const allowedCases = [
    ['cth + organize（下一次到线）', { preset: 'compress-then-handoff', log: [organized], pressure: PRESSURE.organize }],
    ['cth + relay（下一次到线）', { preset: 'compress-then-handoff', log: [organized], pressure: PRESSURE.relay }],
    ['cth + ok 但 organizeCount=0（第 1 段未做）', { preset: 'compress-then-handoff', log: [], pressure: PRESSURE.ok }],
    ['预设=handoff（单段）+ ok + 已压缩', { preset: 'handoff', log: [organized], pressure: PRESSURE.ok }],
    ['无预设 + ok + 已压缩', { preset: null, log: [organized], pressure: PRESSURE.ok }],
  ];
  for (const [index, [label, options]] of allowedCases.entries()) {
    const h = handoffPanelHarness({
      oldId: 'session-two-stage-allow-' + index,
      newId: 'session-two-stage-allow-new-' + index,
      log: options.log,
      pressure: options.pressure,
    });
    updatePanelState(h.session.id, { defaultOperation: options.preset });
    const result = await h.handoff('two-stage allow');
    assert.equal(result.ok, true, label + ': ' + JSON.stringify(result));
    assert.equal(panelStateOf(h.session.id).handedOff, true, label + '：接力成功');
  }
  resetSharedState();
});

test('面板状态文本支持「压缩→新会话」标签：到线提醒 / phase 边界 / relay_status advice；旧挡位回归', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const session = fakeSession({ id: 'session-cth-labels', cwd });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, events } = applyAgent(services);
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'compress-then-handoff' };

  // relay_status advice：操作标签 + 当前预设
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  assert.match(report.advice, /压缩→新会话/);
  assert.match(report.advice, /当前模式=压缩→新会话/);

  // 到线提醒（升线）：面板行显示新挡位标签
  const injected = [];
  const agent = { session, inject(message) { injected.push(message); } };
  await preStepListener(events)({ agent }, async () => undefined);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /模式=压缩→新会话/);

  // 拒绝分支只 throw：错误文案同样带新挡位标签与下一步指令（不再重复注入 notice）
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent }),
    (error) => /relay_organize/.test(error.message) && /压缩→新会话/.test(error.message));
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
  await assert.rejects(oldTools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session: oldSession, options: {} } }), /relay_organize/);
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

test('relay_phase: discover/decide 必须写 exit_criteria（验收口径），build/verify/ship 不强制', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-acceptance', seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  const call = (args) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {}, inject() {} } });
  await assert.rejects(call({ phase: 'discover', goal: 'x' }), /exit_criteria/, 'discover 缺验收口径必须拒绝');
  await assert.rejects(call({ phase: 'discover', goal: 'x', exit_criteria: '   ' }), /exit_criteria/, '空白 exit_criteria 不算');
  await assert.rejects(call({ phase: 'decide', goal: 'y' }), /exit_criteria/, 'decide 同样必填');
  const ok = await call({ phase: 'discover', goal: 'x', exit_criteria: '报告落盘且含证据，doc_lint 通过' });
  assert.equal(ok.phase, 'discover');
  assert.equal(ok.exit_criteria, '报告落盘且含证据，doc_lint 通过');
  const build = await call({ phase: 'build' });
  assert.equal(build.phase, 'build', 'build 不强制 exit_criteria');
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
    contract_check: CONTRACT_CHECK,
    lessons: [{ tag: 't', text: '跨 phase 注入的历史经验', evidence: 'AGENTS.md:1' }],
  });
  assert.equal(crossing.phase, 'build');
  assert.ok(Array.isArray(crossing.lessons.selected), '跨 phase 返回 selected');
  assert.equal(typeof crossing.lessons.injection?.limit, 'number', '跨 phase 带 injection 上限');
  // ② 同 phase（autoChoose 记录 next_operation）：只回 recorded/total/bytes，不回 selected/injection
  const same = await call({
    phase: 'build',
    next_operation: 'compress',
    lessons: [{ tag: 't2', text: '同 phase 记录的经验', evidence: 'AGENTS.md:2' }],
  });
  assert.equal(same.phase, 'build');
  assert.equal(same.next_operation, 'compress', '同 phase 仍记录 next_operation');
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

test('rev5.5：面板模式「接力」/「压缩→新会话」不再视为预授权；接力成功后模式持久（新会话继承）', async () => {
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
  assert.equal((await gate(exec(session), async () => ({ kind: 'allow' }))).kind, 'ask', '两段式预设同样不免审');
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', isError: false, arguments: { phase: 'build' }, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const organized = fakeSession({ id: 'session-f3b', cwd, log: organizedLog });
  updatePanelState(organized.id, { defaultOperation: 'compress-then-handoff' });
  // 同一到线（band ok）：两段式第 2 段未到线 → 注定被工具体拒绝，不弹审批（B-P2-6）
  assert.equal((await gate(exec(organized), async () => ({ kind: 'allow' }))).kind, 'allow', '两段式未到线注定被拒 → 不弹审批');
  // 下一次到线（band organize）：第 2 段仍不免审（rev5.5）
  const organizedGateServices = fakeServices({ session: organized, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, extra: { approval } });
  const organizedGate = preExecuteListener(applyAgent(organizedGateServices.services).events);
  assert.equal((await organizedGate(exec(organized), async () => ({ kind: 'allow' }))).kind, 'ask', '第 2 段也不再免审');
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
  assert.equal(panelStateOf(session.id).defaultOperation, 'handoff', 'v0.4.0：模式持久不消费（新会话继承）');
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

test('v3 relay_phase next_operation：autoChoose=on 记录模型自决 / auto 清除 / autoChoose=off 忽略', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-next-op', seq: 0 });
  const { services } = fakeServices({ session });
  const { tools } = applyAgent(services);
  // M3：next_operation 必须进 parameters
  assert.deepEqual(tools.get('relay_phase').parameters.properties.next_operation.enum, ['compress', 'handoff', 'auto']);
  updatePanelState(session.id, { autoChoose: true });
  const call = (args) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, ...args }, { agent: { session, options: {} } });
  const recorded = await call({ phase: 'build', next_operation: 'compress' });
  assert.equal(recorded.next_operation, 'compress');
  assert.equal(recorded.next_operation_ignored, undefined);
  const panel = panelStateOf(session.id);
  assert.equal(panel.autoDecision.operation, 'compress');
  assert.equal(typeof panel.autoDecision.at, 'number');
  // 同 phase 也可记录（不触发闸门/回退），且可改向
  const same = await call({ phase: 'build', next_operation: 'handoff' });
  assert.equal(same.phase, 'build');
  assert.equal(panelStateOf(session.id).autoDecision.operation, 'handoff');
  // 'auto' → 清除
  const cleared = await call({ phase: 'build', next_operation: 'auto' });
  assert.equal(cleared.next_operation, 'auto');
  assert.equal(panelStateOf(session.id).autoDecision, null);
  // autoChoose=off → 归一化丢弃（面板保持未决「自动」）并报告被忽略
  updatePanelState(session.id, { autoChoose: false });
  const ignored = await call({ phase: 'build', next_operation: 'compress' });
  assert.equal(ignored.next_operation_ignored, true);
  assert.equal(panelStateOf(session.id).autoDecision, null);
  assert.match(ignored.summary, /被忽略/);
  resetSharedState();
});

test('v3 到线 autoChoose 优先已记录的模型决定（handoff/compress 两向）', async () => {
  resetSharedState();
  const make = (id, decision, log = []) => {
    const session = fakeSession({ id, cwd: tmpCwd(), seq: log.length, log });
    const bundle = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
    const { tools } = applyAgent(bundle.services);
    updatePanelState(id, { autoChoose: true, autoDecision: decision });
    const injected = [];
    return { session, tools, injected, call: (args = {}) => tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', ...args }, { agent: { session, options: {}, inject(message) { injected.push(message); } } }) };
  };
  // 推荐本应是「压缩」（未压缩过），但模型已决定 handoff → 按决定
  const toHandoff = make('session-decide-handoff', { operation: 'handoff', at: 1 });
  await assert.rejects(toHandoff.call(), (error) => /接力新会话/.test(error.message) && /已记录/.test(error.message));
  assert.equal(toHandoff.injected.length, 0, '拒绝分支只 throw（决定/下一步在错误文案里）');
  // 推荐本应是「接力」（已压缩过），但模型已决定 compress → 按决定
  const organizedLog = [{ type: 'tool/ptc-dispatch', seq: 0, data: { name: 'relay_organize', arguments: { phase: 'build' }, isError: false, content: [{ type: 'text', text: 'organized: freed 10 tokens' }] } }];
  const toCompress = make('session-decide-compress', { operation: 'compress', at: 2 }, organizedLog);
  await assert.rejects(toCompress.call(), /压缩继续/);
  assert.equal(toCompress.injected.length, 0);
  resetSharedState();
});

test('v3 relay_organize 成功一次写清 autoDecision+authorizeNext（模式持久不消费）；失败不改模式', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const compaction = { async compactIfNeeded() { return { shadowedTokenCount: 7 }; } };
  // ① autoChoose 模式（rev5.2 互斥：auto 模式下无 preset）：成功压缩消费 autoDecision + authorizeNext
  const session = fakeSession({ id: 'session-organize-v3', cwd, seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true, autoDecision: { operation: 'handoff', at: 9 }, authorizeNext: true });
  assert.equal(panelStateOf(session.id).defaultOperation, null, '互斥：autoChoose=on 时 preset 被忽略');
  const result = await tools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session, options: {} } });
  assert.equal(result.organized, true);
  const panel = panelStateOf(session.id);
  assert.equal(panel.autoDecision, null);
  assert.equal(panel.authorizeNext, false);
  assert.equal(panel.autoChoose, true, '其他授权开关不受影响');
  // ② 人类预设模式（autoChoose=off）：成功压缩消费 defaultOperation='compress'
  const presetSession = fakeSession({ id: 'session-organize-v3-preset', cwd, seq: 0 });
  const presetTools = applyAgent(fakeServices({ session: presetSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction }).services).tools;
  updatePanelState(presetSession.id, { defaultOperation: 'compress' });
  const presetResult = await presetTools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session: presetSession, options: {} } });
  assert.equal(presetResult.organized, true);
  assert.equal(panelStateOf(presetSession.id).defaultOperation, 'compress', '模式持久不消费');
  // 失败（compaction 抛错）不消费
  const failSession = fakeSession({ id: 'session-organize-v3-fail', cwd, seq: 0 });
  const failTools = applyAgent(fakeServices({ session: failSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 }, compaction: { async compactIfNeeded() { throw new Error('boom'); } } }).services).tools;
  updatePanelState(failSession.id, { autoChoose: true, autoDecision: { operation: 'compress', at: 1 }, authorizeNext: true });
  const failed = await failTools.get('relay_organize').execute({ phase: 'build', brief: 'x' }, { agent: { session: failSession, options: {} } });
  assert.equal(failed.ok, false);
  assert.deepEqual(panelStateOf(failSession.id).autoDecision, { operation: 'compress', at: 1 });
  assert.equal(panelStateOf(failSession.id).authorizeNext, true);
  resetSharedState();
});

test('v3 relay_handoff 成功清 autoDecision + authorizeNext（同一次写入）', async () => {
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
  updatePanelState(session.id, { autoChoose: true, autoDecision: { operation: 'handoff', at: 5 }, authorizeNext: true });
  const result = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'x' } }, { agent: { session, options: {} } });
  assert.equal(result.ok, true);
  const panel = panelStateOf(session.id);
  assert.equal(panel.autoDecision, null);
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
  await tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent });
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
  autoChoose: panel.autoChoose, autoCompress: panel.autoCompress, autoHandoff: panel.autoHandoff, authorizeNext: panel.authorizeNext,
});

test('§3.8 接力成功后旧会话消费后的 4 个持久开关同步到新会话；一次性/内部字段不继承', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-sync-old', newId: 'session-sync-new' });
  updatePanelState(h.session.id, {
    defaultOperation: 'handoff', autoChoose: true, autoCompress: true, autoHandoff: true,
    authorizeNext: true, autoDecision: { operation: 'handoff', at: 1 },
  });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  // 旧会话：一次性授权被本次 handoff 消费；模式（「自动」=autoChoose）持久、自决/内部字段清掉
  const oldPanel = panelStateOf(h.session.id);
  assert.equal(oldPanel.authorizeNext, false);
  assert.equal(oldPanel.autoDecision, null);
  assert.equal(oldPanel.defaultOperation, null);
  // 新会话继承 4 个持久开关与「自动」模式（取旧会话消费后的值：authorizeNext 已被消费 → false）
  const newPanel = panelStateOf(h.newId);
  assert.deepEqual(PERSISTENT_SWITCHES(newPanel), { autoChoose: true, autoCompress: true, autoHandoff: true, authorizeNext: false });
  // 模型决定 / 内部字段不继承（显式 defaultOperation 模式继承见下一条测试）
  assert.equal(newPanel.defaultOperation, null);
  assert.equal(newPanel.autoDecision, null);
  assert.equal(newPanel.handedOff, false);
  resetSharedState();
});

test('§3.8 同步的是具体值（混合开关）；新会话记录覆盖侧栏默认', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-sync-mixed-old', newId: 'session-sync-mixed-new' });
  updatePanelState(h.session.id, { autoChoose: true, autoCompress: false, autoHandoff: true, authorizeNext: true });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(PERSISTENT_SWITCHES(panelStateOf(h.newId)), { autoChoose: true, autoCompress: false, autoHandoff: true, authorizeNext: false });
  // 新会话已有继承快照 → 不再跟随侧栏默认（侧栏全关也保持继承值）
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false };
  assert.deepEqual(PERSISTENT_SWITCHES(panelStateOf(h.newId)), { autoChoose: true, autoCompress: false, autoHandoff: true, authorizeNext: false });
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  resetSharedState();
});

test('v0.4.0 模式接力继承：defaultOperation 带到新会话；目标为超长任务时经典 cth 归一为「问我」', async () => {
  resetSharedState();
  // classic 源 + classic 目标：模式原样继承
  const h = handoffPanelHarness({ oldId: 'session-mode-sync-old', newId: 'session-mode-sync-new' });
  updatePanelState(h.session.id, { defaultOperation: 'compress' });
  const result = await h.handoff();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(panelStateOf(h.session.id).defaultOperation, 'compress', '旧会话模式不消费');
  assert.equal(panelStateOf(h.newId).defaultOperation, 'compress', '新会话继承经典模式');
  // 「带过去」= 钉住：之后侧栏默认变化也不影响已继承的新会话
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: 'handoff', autoChoose: false, autoCompress: false, autoHandoff: false };
  assert.equal(panelStateOf(h.newId).defaultOperation, 'compress', '继承的模式被钉住，不随后日侧栏默认漂移');
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  // classic 源 + 长任务目标：cth 在长模式不存在 → 新会话按「问我」继承
  const cwd = tmpCwd();
  const oldSession = fakeSession({ id: 'session-mode-long-old', cwd, seq: 0 });
  const liveSession = { id: 'session-mode-long-new', header: { cwd }, requestHeader: () => undefined };
  const bundle = fakeServices({
    session: oldSession,
    extra: {
      sessionController: { async create() { return { sessionId: 'session-mode-long-new' }; } },
      agents: { list: () => [{ session: liveSession, status: 'idle', followup() {} }] },
      workspaceRegistry: { async resolveByPath() { return { id: 'ws', title: 'ws', async attachSession() {} }; } },
      sessionTitle: { rename() {} },
    },
  });
  // host 装配：relayPresetIds = [classic, long]（面板「下一个新会话 preset」白名单同源）
  const tools = applyAgent(bundle.services, { presetId: 'relay', relayPresetIds: ['relay', 'relay-long'] }).tools;
  updatePanelState(oldSession.id, { defaultOperation: 'compress-then-handoff', handoffPreset: 'relay-long' });
  const longResult = await tools.get('relay_handoff').execute({ human_approved: true, status: { goal: 'classic to long' } }, { agent: { session: oldSession, options: {} } });
  assert.equal(longResult.ok, true, JSON.stringify(longResult));
  assert.equal(panelStateOf('session-mode-long-new').defaultOperation, null, '长模式没有「压缩→新会话」→ 按「问我」继承');
  resetSharedState();
});

test('§3.8 handoff 失败路径不同步面板设置（新会话不写入继承记录）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-sync-fail-old', newId: 'session-sync-fail-new', failFollowup: true });
  updatePanelState(h.session.id, { autoChoose: true, autoCompress: true, autoHandoff: true, authorizeNext: true });
  const result = await h.handoff('fail sync');
  assert.equal(result.ok, false);
  assert.equal(result.halfCreated, true);
  // 失败不消费旧会话授权、也不同步到新会话（新会话仍是默认值）
  const oldPanel = panelStateOf(h.session.id);
  assert.equal(oldPanel.authorizeNext, true);
  assert.equal(oldPanel.handedOff, false);
  assert.deepEqual(PERSISTENT_SWITCHES(panelStateOf(h.newId)), { autoChoose: false, autoCompress: false, autoHandoff: false, authorizeNext: false });
  resetSharedState();
});

test('文案：autoChoose=on = 模型自决档（自决 + 先记录再执行，不出现「问人类」指令）', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-copy-auto', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools, events, sections } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true });
  const report = await tools.get('relay_status').execute({}, { agent: { session, options: {} } });
  // advice：模型自决 + 先 relay_phase 记录 + 面板显示「自动」/「下一次」
  assert.match(report.advice, /自决/);
  assert.match(report.advice, /next_operation/);
  assert.match(report.advice, /自动/);
  assert.match(report.advice, /不要向人类确认/);
  assert.doesNotMatch(report.advice, /问人类/, 'autoChoose 提示词不得把「问人类」当指令');
  // 到线提醒正文同样
  const listener = preStepListener(events);
  const injected = [];
  await listener({ agent: { session, inject(message) { injected.push(message); } } }, async () => undefined);
  const text = injected[0].content[0].text;
  assert.match(text, /自决/);
  assert.match(text, /自动/);
  assert.doesNotMatch(text, /问人类/);
  // P2-19：两种模式的完整规则收敛到协议（描述只留一行指针，不再重复长篇模式说明）
  const desc = tools.get('relay_phase').description;
  assert.ok(desc.length <= 320, 'relay_phase description 已瘦身: ' + desc.length);
  assert.ok(!desc.includes('\n'), 'description 单行');
  assert.match(desc, /composer panel/);
  assert.match(desc, /protocol/);
  // 常驻协议同步区分
  const protocol = sections[0].text;
  assert.match(protocol, /模型自决档/);
  assert.match(protocol, /严格按模式执行/);
  assert.match(protocol, /\*\*持久\*\*（不消费）/);
  assert.match(protocol, /do not ask the human|不要向人类确认/);
  assert.match(protocol, /next_operation/);
  assert.match(protocol, /authorizeNext/);
  assert.match(protocol, /提问工具只用于简单问题/, '提问纪律：只把简单问题放提问工具');
  assert.match(protocol, /复杂问题不走提问工具/, '提问纪律：复杂问题用普通消息白话展开');
  assert.match(protocol, /pending 不是跳过、不是同意/, '提问纪律：超时 pending 的语义');
  assert.match(protocol, /汇报一律大白话/, '交互纪律：白话汇报规则');
  assert.match(protocol, /等待纪律/, '等待纪律：派活后不空转等队友');
  assert.match(protocol, /wait_agent \/ list_agents \/ team_task_list/, '等待纪律：点名不要循环调用的工具');
  assert.match(protocol, /回执会自动作为消息送达/, '等待纪律：回执自动送达');
  assert.match(protocol, /≤120s/, '等待纪律：只在被阻塞时有界等待');
  assert.match(protocol, /完整上下文索引/, '用户门：Lead 必须给全上下文索引');
  assert.match(protocol, /不重跑技术验证、不重读第三方源码/, '用户门：审查范围限定需求↔实现对齐');
  assert.match(protocol, /最多 1 轮/, '用户门：审查轮数上限');
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

test('文案闭环：relay_phase 记录 next_operation 后，同次到线 autoChoose 按该决定提示', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-copy-loop', seq: 0 });
  const { services } = fakeServices({ session, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const { tools } = applyAgent(services);
  updatePanelState(session.id, { autoChoose: true });
  const injected = [];
  const agent = { session, options: {}, inject(message) { injected.push(message); } };
  // 推荐方向是压缩（未压缩过），但模型记录 handoff → 闸门按已记录决定指示接力
  await assert.rejects(
    tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build', next_operation: 'handoff' }, { agent }),
    (error) => /按已记录的操作.*接力新会话/.test(error.message) && /模型自决档/.test(error.message) && /已记录/.test(error.message),
  );
  assert.equal(panelStateOf(session.id).autoDecision.operation, 'handoff');
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
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent: { session, options: {}, inject() {} } }), /relay_organize/);
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
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent }), /teammate session/);
  assert.equal(sent.length, 1);
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'verify' }, { agent }),
    (error) => /teammate session/.test(error.message) && /不重复发送/.test(error.message));
  assert.equal(sent.length, 1, 'same band: escalation deduped（B-P2-4）');
  assert.equal(injected.length, 0, '拒绝分支只 throw（去重提示在错误文案里）');
  bundle.state.pressure = { contextWindow: 1_000_000, projectedTokens: 520_000 };
  await assert.rejects(tools.get('relay_phase').execute({ contract_check: CONTRACT_CHECK, phase: 'build' }, { agent }), /teammate session/);
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
test('P2-19：工具描述瘦身预算（每条 ≤1 行 / 总字符预算；语义收敛协议；v0.3.3 六条工具）', () => {
  resetSharedState();
  const { tools, sections } = applyAgent(fakeServices({ session: fakeSession({ id: 'session-desc-budget', seq: 0 }) }));
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
  assert.ok(descriptionChars <= 2000, '七条工具描述总字符 <=2000，实际 ' + descriptionChars);
  assert.ok(parameterChars <= 7500, '参数 schema 总字符 <=7500（v0.5.0：relay_work_items 结构化 items/updates），实际 ' + parameterChars);
  assert.deepEqual(tools.get('relay_phase').parameters.properties.budget_plan.properties.action.enum, ['proceed', 'split', 'relay'], 'warn 档 budget_plan 三选一进参数 schema');
  // 语义收敛协议：模式/授权规则在协议里完整复述（描述只留指针）
  const protocol = sections[0].text;
  for (const keyword of ['autoCompress', 'autoHandoff', 'authorizeNext', 'next_operation', '模型自决档', '模式只决定「做什么」']) {
    assert.ok(protocol.includes(keyword), '协议必须承载语义 ' + keyword);
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
  await call({ phase: 'build', contract_check: CONTRACT_CHECK });
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

test('contract_check 三问自检：每次切 phase 必填；超预算「继续」先自检、拒绝不丢模式', async () => {
  resetSharedState();
  const session = fakeSession({ id: 'session-contract', seq: 0 });
  const { tools } = applyAgent(fakeServices({ session }).services);
  const agent = { session, options: {} };
  await assert.rejects(tools.get('relay_phase').execute({ phase: 'build' }, { agent }), /contract_check/, '缺 contract_check 被拒');
  await assert.rejects(tools.get('relay_phase').execute({ phase: 'build', contract_check: { requirement: '  ', fidelity: 'f', attention: 'a' } }, { agent }), /requirement/, '空 requirement 被拒');
  await assert.rejects(tools.get('relay_phase').execute({ phase: 'build', contract_check: { requirement: 'r', fidelity: '', attention: 'a' } }, { agent }), /fidelity/, '空 fidelity 被拒');
  await assert.rejects(tools.get('relay_phase').execute({ phase: 'build', contract_check: { requirement: 'r', fidelity: 'f', attention: ' ' } }, { agent }), /attention/, '空 attention 被拒');
  const ok = await tools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent });
  assert.equal(ok.phase, 'build');
  // 超预算 + 面板「继续」：先自检；自检拒绝不丢预设，放行后才消费
  const overSession = fakeSession({ id: 'session-contract-over', seq: 0 });
  const overBundle = fakeServices({ session: overSession, pressure: { contextWindow: 1_000_000, projectedTokens: 420_000 } });
  const overTools = applyAgent(overBundle.services).tools;
  const overAgent = { session: overSession, options: {}, inject() {} };
  updatePanelState(overSession.id, { defaultOperation: 'continue' });
  await assert.rejects(overTools.get('relay_phase').execute({ phase: 'verify' }, { agent: overAgent }), /contract_check/);
  assert.equal(panelStateOf(overSession.id).defaultOperation, 'continue', '自检拒绝不丢预设');
  const crossed = await overTools.get('relay_phase').execute({ phase: 'verify', contract_check: CONTRACT_CHECK }, { agent: overAgent });
  assert.equal(crossed.phase, 'verify');
  assert.equal(panelStateOf(overSession.id).defaultOperation, 'continue', '放行后模式持久（不消费）');
  // P2（2026-11-01 审查）：contract_check 被拒不得落 next_operation/autoDecision（拒绝路径无副作用）。
  const pollutionSession = fakeSession({ id: 'session-contract-pollution', seq: 0 });
  const pollutionTools = applyAgent(fakeServices({ session: pollutionSession }).services).tools;
  updatePanelState(pollutionSession.id, { autoChoose: true });
  assert.equal(panelStateOf(pollutionSession.id).autoDecision, null);
  await assert.rejects(pollutionTools.get('relay_phase').execute({ phase: 'verify', next_operation: 'handoff' }, { agent: { session: pollutionSession, options: {} } }), /contract_check/);
  assert.equal(panelStateOf(pollutionSession.id).autoDecision, null, '自检拒绝后不得写 autoDecision');
  // P2（二次复核发现）：队友预算内切 phase 同样必须自检（只有超预算走 escalation 的路径可免）。
  const teammateSession = fakeSession({ id: 'session-contract-team', seq: 0 });
  const teammateTools = applyAgent(fakeServices({ session: teammateSession, extra: { agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'rev' }), listMembers: () => [] } } }).services).tools;
  const teammateAgent = { session: teammateSession, options: {} };
  await assert.rejects(teammateTools.get('relay_phase').execute({ phase: 'build' }, { agent: teammateAgent }), /contract_check/, '队友预算内切 phase 也必须自检');
  const teammateOk = await teammateTools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent: teammateAgent });
  assert.equal(teammateOk.phase, 'build');
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

test('relay_handoff 预检：超 8KB 直接拒绝（不写文件/不建会话），hint 给原因与重写指引、不写用户可见说明', async () => {
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
      discarded: fill('dis', 8),
    },
    evidence: fill('ev', 12),
    decisions: fill('dec', 10),
    constraints: fill('con', 8),
    human_approved: true,
  }, { agent: { session, options: {} } });
  assert.equal(result.ok, false, JSON.stringify(result).slice(0, 300));
  assert.equal(result.code, 'handoff-truncated');
  assert.equal(result.caps.truncated, true, '超 8KB 必须标 truncated');
  assert.ok(result.caps.truncatedSections.length > 0, 'truncatedSections 记账');
  assert.ok(result.caps.truncatedSections.includes('bytes'), 'bytes 记账：' + JSON.stringify(result.caps.truncatedSections));
  assert.ok(result.caps.bytes.used <= result.caps.bytes.limit, '记账用正文不超硬上限');
  assert.equal(typeof result.hint, 'string', '拒绝时返回 hint 管理提示');
  assert.match(result.hint, /8KB 上限/);
  assert.match(result.hint, /丢掉的段|超过 200 字符/);
  assert.match(result.hint, /改短|精简/);
  assert.match(result.hint, /key_docs/, '长材料走 key_docs 引用');
  assert.match(result.hint, /未写 handoff 文件、未创建会话/, '预检拒绝零副作用：不写文件/不建会话，重试不重复接力');
  assert.match(result.hint, /不要写进 progress\.md/, 'progress.md 自身会裁剪，不是溢出目的地（审查 P1）');
  assert.match(result.hint, /不要在给用户的汇报里写截断说明/, '不写用户可见的截断说明（用户 2026-11-01 裁决）');
  assert.match(result.summary, /refused/);
  assert.equal(followed.length, 0, '预检拒绝不发首条消息（不建会话）');
  assert.equal(existsSync(join(cwd, '.scratch', 'context-relay')), false, '预检拒绝不写 handoff/progress 文件');
});

test('relay_handoff 预检：单条 200 字符裁剪 → 拒绝，hint 不误报 8KB（2026-11-01 用户反馈）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-item-clip-old', newId: 'session-item-clip-new' });
  const result = await h.handoff('item clip', { status: { goal: 'item clip', next_actions: ['长'.repeat(260)] } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'handoff-truncated');
  assert.deepEqual(result.caps.truncatedSections, ['chars:next_actions'], '只有单条字符裁剪，不是字节预算/条数');
  assert.ok(result.caps.bytes.used < result.caps.bytes.limit, '文档本体没到 8KB：' + JSON.stringify(result.caps.bytes));
  assert.match(result.hint, /超过 200 字符/, 'hint 必须说清是单条字符裁剪');
  assert.ok(!result.hint.includes('8KB 上限'), '单条裁剪不得误报 8KB 上限：' + result.hint);
  assert.match(result.hint, /不要在给用户的汇报里写截断说明/);
  assert.equal(h.followed.length, 0, '预检拒绝不建会话/不发消息');
  resetSharedState();
});

test('relay_handoff 预检：列表条数超上限 → 拒绝且不误报 200 字符/8KB（2026-11-01 审查 P2）', async () => {
  resetSharedState();
  const h = handoffPanelHarness({ oldId: 'session-count-clip-old', newId: 'session-count-clip-new' });
  const result = await h.handoff('count clip', { status: { goal: 'count clip', next_actions: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'] } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'handoff-truncated');
  assert.deepEqual(result.caps.truncatedSections, ['items:next_actions'], '条数超上限记 items:');
  assert.match(result.hint, /列表条数超出上限/);
  assert.ok(!result.hint.includes('超过 200 字符'), '条数裁剪不得误报字符裁剪：' + result.hint);
  assert.ok(!result.hint.includes('8KB 上限'), '条数裁剪不得误报 8KB：' + result.hint);
  assert.equal(h.followed.length, 0);
  resetSharedState();
});

test('relay_handoff：仅自动交接清单被 cap 裁时不阻断（用户文档本身合规、不返 hint 引导重复接力）', async () => {
  resetSharedState();
  const jobs = {
    list: (owner) => (owner === 'session-inv-old' ? [{ id: 'bash-x', kind: 'bash', label: 'job', status: 'running', owner: 'session-inv-old' }] : []),
    kill: () => 'requested',
  };
  const h = handoffPanelHarness({ oldId: 'session-inv-old', newId: 'session-inv-new', extraServices: { jobs, subagents: undefined } });
  const result = await h.handoff('inv cap', { status: { goal: 'inv cap', next_actions: Array.from({ length: 8 }, (_, index) => 'u' + index) } });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.caps.truncated, true, '自动清单挤不进 next_actions cap 8');
  assert.deepEqual(result.caps.truncatedSections, ['items:next_actions'], '只有 next_actions 槽位冲突，用户章节/字节都合规');
  assert.equal(result.hint, undefined, '仅自动清单裁剪不返回 hint（不引导重复接力）');
  assert.equal(h.followed.length, 1, '交接照常完成');
  assert.match(result.summary, /自动交接清单未全部放进 next_actions/, result.summary);
  // 用户 8 条 next_actions 必须全部保留（自动清单排在其后，只能它被裁）
  for (let index = 0; index < 8; index += 1) {
    assert.ok(h.followed[0].content[0].text.includes('下一步（DoD）：u' + index), '用户 next_actions 保留：u' + index);
  }
  resetSharedState();
});

test('relay_handoff：自动清单若会把用户章节挤掉 → 丢弃清单行用干净用户版交接（P1 回归，2026-11-01 二轮审查）', async () => {
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
  assert.equal(result.caps.truncated, false, '自动清单被丢弃后用户版交接必须干净：' + JSON.stringify(result.caps.truncatedSections));
  assert.equal(result.caps.items.decisions.used, 6, '用户 decisions 不被自动清单挤掉');
  assert.equal(result.caps.items.next_actions.used, 6, '自动清单未放入 next_actions（用户 6 条）');
  assert.match(result.summary, /自动交接清单未放进 next_actions（保护用户章节：8KB 预算）/, result.summary);
  assert.match(result.summary, /完整清单见本工具返回的 handover 字段/, '不谎称清单在 handoff 文件追加段（8KB 满时追加段可能为空）');
  assert.equal(result.inventoryDropped, true, '返回体显式告知清单被丢弃');
  assert.equal(result.inventoryDropReason, '8KB 预算');
  const raw = readFileSync(result.handoffPath, 'utf8');
  assert.match(raw, /dec5-/, '用户 decisions 仍完整写入 handoff 文件（不静默丢内容）');
  resetSharedState();
});

test('relay_handoff：自动清单仅因字节预算（无 chars:）挤掉用户章节也会被丢弃（P3 覆盖缺口，2026-11-01 三轮审查）', async () => {
  resetSharedState();
  const big = (label) => label + '-' + 'x'.repeat(190);
  // 短清单行（都 ≤200 字符）：full 只会出现 items:next_actions + bytes/section:，不会出现 chars:。
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
  assert.equal(result.caps.truncated, false, '用户版交接干净：' + JSON.stringify(result.caps.truncatedSections));
  assert.equal(result.inventoryDropped, true);
  assert.equal(result.inventoryDropReason, '8KB 预算', '字节/丢段原因，不是 chars:（清单行都很短）');
  assert.equal(result.caps.items.done.used, 10, '用户 done 段不被挤掉');
  assert.equal(result.caps.items.decisions.used, 6, '用户 decisions 段不被挤掉');
  assert.equal(result.caps.items.risks.used, 3, '用户 risks 段不被挤掉');
  resetSharedState();
});

test('relay_handoff：清理报告 append 后 handoff 文件仍 ≤8KB（2026-11-01 审查 P2）', async () => {
  resetSharedState();
  const big = (label) => label + '-' + 'x'.repeat(190);
  const jobs = {
    list: (owner) => (owner === 'session-append-old' ? [{ id: 'bash-long-label', kind: 'bash', label: big('label'), status: 'running', owner: 'session-append-old' }] : []),
    kill: () => 'requested',
  };
  const schedule = { list: async () => [], create: async () => ({ id: 'sched-new' }), delete: async () => ({ deleted: true }) };
  const h = handoffPanelHarness({ oldId: 'session-append-old', newId: 'session-append-new', extraServices: { jobs, schedule, subagents: undefined } });
  // 交接前就把用户文档写到接近 8KB（预检必须通过：用户内容不截断），让清理报告 append 放不下。
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
  assert.ok(result.handoffFileBytes <= result.caps.bytes.limit, '最终 handoff 文件 ' + result.handoffFileBytes + ' 字节 ≤ 上限 ' + result.caps.bytes.limit);
  assert.equal(result.cleanupReportTruncated, true, 'append 放不下时必须截断并显式标注');
  // 放不下时可能整段不 append（文件保持 ≤8KB），截断事实由返回字段 + summary 兜底；完整清单在工具返回的 handover 字段里。
  const rawBytes = Buffer.byteLength(readFileSync(result.handoffPath, 'utf8'), 'utf8');
  assert.ok(rawBytes <= result.caps.bytes.limit, '实际文件 ' + rawBytes + ' ≤ 上限');
  assert.match(result.summary, /8KB 上限截断/, result.summary);
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
  assert.match(first.text, /## Handoff 文件\n/);
  assert.ok(first.text.includes(result.handoffPath), '首条消息含 handoff 文件路径');
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
  assert.equal(panel.autoDecision, null);
  assert.equal(panel.authorizeNext, false);
  // 四个合法档位都接受；空 reason 允许
  for (const operation of ['continue', 'handoff', 'compress-then-handoff']) {
    const next = await tools.get('relay_recommend').execute({ operation }, { agent });
    assert.equal(next.ok, true, operation);
    assert.equal(next.reason, '');
    assert.equal(panelStateOf(session.id).recommendedOperation, operation);
  }
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

test('v0.3.4 relay_recommend：长模式只接受三档，compress-then-handoff 拒绝且零副作用；classic 仍接受四档', async () => {
  resetSharedState();
  // 长模式：先放一条推荐作为「零副作用」基线
  const long = fakeSession({ id: 'session-rec-v034-long', seq: 0 });
  const longTools = applyAgent(fakeServices({ session: long }).services, { routerMode: true }).tools;
  // v0.3.8：长模式 operation schema 只暴露三档（模型可见 schema 不出现已移除的 compress-then-handoff）。
  assert.deepEqual(longTools.get('relay_recommend').parameters.properties.operation.enum, ['continue', 'compress', 'handoff']);
  assert.doesNotMatch(JSON.stringify(longTools.get('relay_recommend').parameters), /compress-then-handoff/);
  // v0.3.5 F4：reason 口径统一 120（schema 不再写 160）
  const reasonDesc = longTools.get('relay_recommend').parameters.properties.reason.description;
  assert.match(reasonDesc, /120/);
  assert.doesNotMatch(reasonDesc, /160/);
  updatePanelState(long.id, { recommendedOperation: 'continue', recommendedReason: '长模式三档', recommendedAt: 1234 }, { source: 'agent' });
  const longAgent = { session: long, options: {} };
  const rejected = await longTools.get('relay_recommend').execute({ operation: 'compress-then-handoff', reason: '两段式' }, { agent: longAgent });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid-operation');
  assert.match(rejected.error, /compress-then-handoff is not available in Relay · 超长任务 mode/);
  assert.match(rejected.error, /use compress or handoff/);
  const kept = panelStateOf(long.id);
  assert.deepEqual([kept.recommendedOperation, kept.recommendedReason, kept.recommendedAt], ['continue', '长模式三档', 1234], '拒绝路径零副作用（原推荐保留）');
  assert.equal(kept.defaultOperation, null, '拒绝不写预设');
  assert.equal(kept.authorizeNext, false, '拒绝不写授权');
  // 长模式三个合法档都接受
  for (const operation of ['continue', 'compress', 'handoff']) {
    const ok = await longTools.get('relay_recommend').execute({ operation }, { agent: longAgent });
    assert.equal(ok.ok, true, operation);
    assert.equal(panelStateOf(long.id).recommendedOperation, operation);
  }
  // classic：同值仍接受（两段式是 classic-only 档）
  const classic = fakeSession({ id: 'session-rec-v034-classic', seq: 0 });
  const classicTools = applyAgent(fakeServices({ session: classic }).services).tools;
  assert.deepEqual(classicTools.get('relay_recommend').parameters.properties.operation.enum, ['compress', 'continue', 'handoff', 'compress-then-handoff'], 'classic 四档不变');
  const accepted = await classicTools.get('relay_recommend').execute({ operation: 'compress-then-handoff', reason: '经典两段式' }, { agent: { session: classic, options: {} } });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.operation, 'compress-then-handoff');
  assert.equal(panelStateOf(classic.id).recommendedOperation, 'compress-then-handoff');
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

test('v0.3.5 长模式升级残留：v0.3.3 存的 cth 推荐不再进到线提醒（classic 仍展示）', async () => {
  resetSharedState();
  const cwd = tmpCwd();
  const stamp = (sessionId, reason) => updatePanelState(sessionId, {
    recommendedOperation: 'compress-then-handoff',
    recommendedReason: reason,
    recommendedAt: 1762460000999,
  }, { source: 'agent' });
  // relay-long：该档已移除 → 提醒里按无推荐处理（不显示推荐段、不出现已删档位名）
  const long = fakeSession({ id: 'session-rec-v035-long', cwd });
  const longServices = fakeServices({ session: long, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  // routerMode 会先注册 team reset 的 pre-step 执行器；sentinel 是后注册的（取最后一个）
  const sentinelListenerOf = (events) => events.filter((event) => event.name === 'agent/pre-step').at(-1).listener;
  const longListener = sentinelListenerOf(applyAgent(longServices.services, { routerMode: true }).events);
  stamp(long.id, '旧长会话残留');
  const longInjected = [];
  await longListener({ agent: { session: long, inject(message) { longInjected.push(message); } } }, async () => undefined);
  assert.equal(longInjected.length, 1);
  const longText = longInjected[0].content[0].text;
  assert.doesNotMatch(longText, /模型推荐/);
  assert.doesNotMatch(longText, /压缩→新会话/);
  // classic：同一份旧值照常展示（classic 仍保留该档）
  resetSharedState();
  const classic = fakeSession({ id: 'session-rec-v035-classic', cwd });
  const classicServices = fakeServices({ session: classic, pressure: { contextWindow: 1_000_000, projectedTokens: 360_000 } });
  const classicListener = sentinelListenerOf(applyAgent(classicServices.services).events);
  stamp(classic.id, '经典两段式');
  const classicInjected = [];
  await classicListener({ agent: { session: classic, inject(message) { classicInjected.push(message); } } }, async () => undefined);
  assert.equal(classicInjected.length, 1);
  assert.match(classicInjected[0].content[0].text, /模型推荐=压缩→新会话/);
  assert.match(classicInjected[0].content[0].text, /经典两段式/);
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
  const switched = await phaseTools.get('relay_phase').execute({ phase: 'build', contract_check: CONTRACT_CHECK }, { agent: { session: phaseSession, options: {} } });
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

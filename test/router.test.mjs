/**
 * Router / per-agent 契约测试（v0.2.12 Router + v0.2.17 B+C+D；v0.9.0 单一模式）：
 * 协议文本资产与预算回归 + 单一模式恒注入 LONG base（classic 仅迁移期同行为别名）
 * + root Lead 恒装 Router（工具面裁剪 + 协议段 + 队友保鲜段）
 * + 非 root 的 lead-only 工具裁剪（B，fail-open）
 * + 子代理 worker 短协议影子覆盖（C：普通子代理；直接队友装紧凑队友协议）
 * + 普通子代理额外隐藏 relay_phase（D：非 root 且非队友；队友/root 保留）。
 * 2026-11-03 用户裁决：范围内不加 relay_route/relay_inbox；协议/回执契约/PTC 模板先行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS } from '../lib/agent.js';
import { ARCHITECT_LEAD_PROTOCOL_TEXT, ARCHITECT_NAME, ARCHITECT_WORKER_PROTOCOL_TEXT, PROTOCOL_TEXT, PROTOCOL_TEXT_LONG, ROUTER_DENY_TOOLS, ROUTER_PROTOCOL_TEXT, TEAMMATE_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { WORKER_PROTOCOL_TEXT } from '../lib/agent/worker.js';
import { subagentsFromLegacy } from './team-fixture.mjs';
import { clearSharedMemory, markPendingArchitect } from '../lib/agent/shared.js';
import { clearPanelMemory, configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';

/** 最小 fake ctx：记录 systemPrompt section、工具注册、事件监听与 warn。 */
function fakeCtx(services = {}) {
  const fixture = services.agentTeams !== undefined && services.subagents === undefined ? subagentsFromLegacy(services.agentTeams) : undefined;
  const normalized = fixture === undefined ? services : { ...services, subagents: fixture, agents: services.agents ?? fixture.agentsService };
  const sections = [];
  const tools = new Map();
  const listeners = [];
  const warns = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on(name, listener) {
      listeners.push({ name, listener });
      return () => {};
    },
    logger: { info() {}, warn(...args) { warns.push(args.join(' ')); } },
    systemPrompt: {
      section(definition) { sections.push(definition); return () => {}; },
      context() { return () => {}; },
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    get(name) { return normalized[name]; },
  };
  return { ctx, sections, tools, listeners, warns };
}

/** 造一个带 session.header 的 agent；calls=restrict 记录，sections=注入的完整 section 定义。
 * options.sessionId：给 root 会话种子的路径提供会话 id（缺省不带 id，种子 fail-open 跳过）。 */
function makeAgent(header, calls, sections = [], options = {}) {
  const restrictThrows = options.restrictThrows ?? new Set();
  const registered = [];
  return {
    session: { header, ...(options.sessionId === undefined ? {} : { id: options.sessionId }) },
    registered,
    ctx: {
      inject(services, callback) {
        if (options.injectThrows === true) throw new Error('service unavailable');
        if (services.length === 1 && services[0] === 'tools') {
          callback({
            tools: {
              restrict(filter) {
                const name = filter.deny?.[0];
                if (restrictThrows.has(name)) throw new Error('unknown global tool "' + name + '"');
                calls.push(name);
                return () => {};
              },
              register(definition) { registered.push(definition.name); return () => {}; },
            },
          });
          return { dispose() {} };
        }
        if (services.length === 1 && services[0] === 'systemPrompt') {
          callback({ systemPrompt: { section(definition) { sections.push(definition); return () => {}; } } });
          return { dispose() {} };
        }
        throw new Error('unexpected inject services: ' + JSON.stringify(services));
      },
    },
  };
}

/** per-agent 安装监听器（classic 也注册；routerMode 只是 root 分支多做事）。 */
function agentListener(f) {
  return f.listeners.find((entry) => entry.name === 'agent/created');
}

test('超长任务协议资产：角色纪律 / 回执契约 / PTC dispatch+collect 模板齐全', () => {
  const text = ROUTER_PROTOCOL_TEXT;
  assert.match(text, /接力模式（Lead 只调度）/);
  assert.match(text, /Lead，只调度、不执行/);
  // 与默认协议推荐段冲突时本模式优先（否则「小任务可自干」会误导 Lead）
  assert.match(text, /本模式为唯一模式，Lead 只调度是常驻职责/);
  assert.match(text, /Lead 只调度/);
  assert.match(text, /写文件、改代码、跑命令\/测试、查日志一律派 worker/);
  assert.match(text, /不设「小任务自己干」例外/);
  for (const phrase of ['不设自做额度', '用户交互、决策、派活、验收抽样', '验收抽样（≤3 次/phase', '写实现文档、读长日志也派 worker', '只作异常信号，不设允许比例', '面板默认档', '新会话默认=压缩继续', '不继承旧模式/授权']) {
    assert.ok(text.includes(phrase), 'ROUTER 缺短语: ' + phrase);
  }
  // 回执契约：文件 ≤4KB + 单条消息 ≤200 字 + 头 3 行机读 + verdict
  assert.match(text, /≤4KB/);
  assert.match(text, />4KB 只提示分层/);
  assert.equal(text.includes('缺节/>4KB'), false);
  assert.match(text, /≤200 字/);
  assert.match(text, /verdict: done\|needs-human\|blocked/);
  assert.match(text, /context-relay\/reports\/<taskId>\.md/);
  // PTC 两段模板：dispatch（批量建卡+spawn）与 collect（短等+digest）
  assert.match(text, /PTC dispatch 模板/);
  assert.match(text, /PTC collect 模板/);
  assert.match(text, /subagent\(\{ name: who/);
  assert.match(text, /send_message\(\{ agent: who/);
  assert.match(text, /wait_agent/);
  assert.match(text, /digest/);
  // 边界如实：PTC 软约束 + 消息不可过滤
  assert.match(text, /node:fs/);
  assert.match(text, /软约束/);
  // 度量引用（与 relay_status 字段联动）
  assert.match(text, /relay_status\.execution/);
  assert.match(text, /relay_status\.compaction\.debt/);
});

test('v0.9.0 skill 同步 Lead 职责、默认档与架构师模型口径', () => {
  const text = readFileSync(new URL('../skills/context-relay/SKILL.md', import.meta.url), 'utf8');
  for (const phrase of ['## Lead 职责', '用户交互、决策（裁决）、派活、验收抽样', '不亲自改码/跑测试/写实现文档/读长日志', '不设自做额度', '派活或拆票', '≤3 次/phase', '不设允许比例/额度、不作为闸门', 'worker 必须亲自写/跑', '新 root 默认压缩继续', '模式和授权不跨会话继承', '默认值跟随「模型」选择器', '已选过则沿用该选择', '默认（跟随模型选择）', 'handoff 继承']) {
    assert.ok(text.includes(phrase), 'SKILL 缺短语: ' + phrase);
  }
  assert.ok(!text.includes('当前实现仍 seed'));
  for (const phrase of ['四段式', '结论：', '影响：', '需要你做什么：', '证据位置：', '只提醒不拒绝', '绝不阻断ship', 'details_requested:true', '≤4000字', '官方任务板为准', 'officialTaskId', '默认 4 人', 'maxActiveSubagents', '容量保全', 'exit_reason']) assert.ok(text.includes(phrase), phrase);
});

test('prompt 字符预算回归 + 硬约束短语：PROTOCOL ≤6500 / ROUTER ≤3250', () => {
  // 常驻协议每个请求都在上下文里：体量回归（v0.2.16 再精简 + 审查回补后预算）与「不得为省字牺牲硬约束」双保险。
  // v0.4.1：压缩 brief 增加「关键文件索引」要求（+~96 字符），预算随之上调。
  // v0.5.0：新增「等待纪律」（约 110 字符）后上调到 5550；仍是硬上限，不是取消。
  // v0.9.0 批次2实测 PROTOCOL 6431 / ROUTER 3155 / TEAM_LEAD 796 / PROTOCOL_TEXT_LONG 6351；预算按实测+50向上取整，保留全部硬约束。
  // 这里约束常驻注入字符体积，不是文档落盘硬门；保留全部必需短语断言。
  assert.ok(PROTOCOL_TEXT.length <= 6500, 'PROTOCOL_TEXT 超预算: ' + PROTOCOL_TEXT.length);
  assert.ok(ROUTER_PROTOCOL_TEXT.length <= 3250, 'ROUTER_PROTOCOL_TEXT 超预算: ' + ROUTER_PROTOCOL_TEXT.length);
  const protocolRequired = [
    '四段式', '只提醒不拒绝', '容量保全', '≥85%', 'exit_reason', "phase:'blocked'|'cancel'", 'verify→build', '审查超时或未完成不算通过', '默认 4 人', '绑定会话+操作+版本', '不跨会话继承', '派活 brief 五字段缺一不可',
    '模式只决定「做什么」',
    '不产生审批豁免',
    '免审只来自 autoCompress / autoHandoff / authorizeNext',
    'autoChoose/autoDecision 已退役',
    '完整上下文索引',
    '最多 1 轮',
    '≤10 个工具调用 / ≤5 分钟',
    'contract_check{requirement, fidelity, attention}',
    'pending 不是跳过、不是同意',
    'phase 边界闸门',
    '不开新 phase',
    '升线 notice 只告知',
    '交接单 = 摘要 + 完整文件',
    '不因超长拒绝交接',
    '所有字节/条数上限只是 advisory',
    'handoff 不是验收',
    '每轮召回 ≤3 条',
    '先写好文档再交接',
    '≤3 条相关历史经验（≤1KB）',
  ];
  for (const phrase of protocolRequired) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 硬约束短语缺失: ' + phrase);
  }
  const routerRequired = [
    '用户汇报规范', '结论：', '影响：', '需要你做什么：', '证据位置：', '只提醒不拒绝', '不阻断 ship/任何 phase', '≤600 字', '≤4000字', 'details_requested:true', '目标：', '必读（1–3 份', '写范围：', '验收：', '回执：', '默认 4 人', 'maxActiveSubagents', '满额排队/报阻塞',
    "不设自做额度",
    "用户交互、决策、派活、验收抽样",
    "验收抽样（≤3 次/phase",
    "写实现文档、读长日志也派 worker",
    "只作异常信号，不设允许比例",
    "面板默认档",
    "新会话默认=压缩继续",
    "不继承旧模式/授权",
    'root Lead，只调度、不执行',
    '不设「小任务自己干」例外',
    'PTC dispatch 模板',
    'PTC collect 模板',
    '≤4KB',
    '≤200 字',
    'verdict: done|needs-human|blocked',
    'context-relay/reports/<taskId>.md',
    'node:fs',
    '软约束',
    'relay_status.execution',
    'relay_status.compaction.debt',
  ];
  for (const phrase of routerRequired) {
    assert.ok(ROUTER_PROTOCOL_TEXT.includes(phrase), 'ROUTER 硬约束短语缺失: ' + phrase);
  }
  // 阈值不得写死在常驻协议（按百分比/30·35·45 数字判断）
  assert.ok(!/(^|[^0-9])(30|35|45)\s*%/.test(PROTOCOL_TEXT), '协议不得写死阈值百分比');
  // v0.2.15 审查 P1/P2 回归：旧误导措辞不得回到常驻协议（lessons 实际注入 3 条；autoChoose 不是「自动授权」）
  assert.ok(!PROTOCOL_TEXT.includes('8 条相关历史经验'), '协议不得再写旧 lessons 注入数量');
  assert.ok(!PROTOCOL_TEXT.includes('三个自动授权'), '协议不得再用「三个自动授权」误称');
  for (const text of [PROTOCOL_TEXT, PROTOCOL_TEXT_LONG, ROUTER_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT]) assert.doesNotMatch(text, /固定 2[-–]4 人|小任务可以自干/);
  // v0.2.17 A1：默认协议注入整个 preset（队友/子智能体也收到），不得再自称「你是 Lead」
  assert.ok(!PROTOCOL_TEXT.includes('你是 relay 模式的 Lead'), '协议不得再对 worker 误称「你是 Lead」');
});

test('v0.2.17 C：worker 协议短文本 250–400 字符，覆盖身份/回报/到线/边界/写范围', () => {
  assert.ok(WORKER_PROTOCOL_TEXT.length >= 250 && WORKER_PROTOCOL_TEXT.length <= 400, 'worker 协议字符数 ' + WORKER_PROTOCOL_TEXT.length);
  const required = [
    'worker（子代理），不是 Lead',
    '不运行 relay phase 流程',
    '压缩/接力',
    '证据(file:line)',
    '≤200 字',
    '报告路径',
    '到线',
    '只向 Lead 请示',
    '不直接问人类',
    '交回 Lead',
    '写范围',
  ];
  for (const phrase of required) assert.ok(WORKER_PROTOCOL_TEXT.includes(phrase), 'worker 协议缺短语: ' + phrase);
  // worker 短文本不得再出现 Lead 专属协议标题/自称（避免 worker 误跑 phase 流程）
  assert.ok(!WORKER_PROTOCOL_TEXT.includes('你是 relay 模式的 Lead'));
});

test('v0.3.2 队友保鲜协议资产：Lead/队友段预算 + 真清空 reset/手动重建 纪律', () => {
  assert.ok(TEAM_LEAD_PROTOCOL_TEXT.length <= 850, 'TEAM_LEAD 超预算: ' + TEAM_LEAD_PROTOCOL_TEXT.length);
  for (const phrase of ['队友是长期资产', 'relay_team_status', 'relay_checkpoint', 'relay_renew', '没有 checkpoint 不换代', 'escalation', 'ledger/roster']) {
    assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes(phrase), 'Lead 保鲜段缺短语: ' + phrase);
  }
  // v0.3.2：reset 是真清空（同成员/不占额度），renew 只换身份；v0.8.1 新 Lead 按交接单/progress/checkpoint 手动重建
  for (const phrase of ['relay_freshen({reset:true', '真清空', '不占额度', '只用于换身份/角色', 'member-limit', 'relay_handoff']) {
    assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes(phrase), 'Lead 段缺 reset/手动重建 纪律: ' + phrase);
  }
  for (const phrase of ['relay_checkpoint', 'relay_freshen', '同代≤2', '不向人类提问', 'session_event_read', '快照权威', '真清空', '只写自己 lineage', '≤100 字']) {
    assert.ok(TEAMMATE_PROTOCOL_TEXT.includes(phrase), '紧凑队友段缺短语: ' + phrase);
  }
  // v0.3.2 真机会话反馈：固定小队/复用优先 + 成员额度稀缺（spawn 与 renew 都占额）
  for (const phrase of ['固定小队', '成员额度', 'relay_team_status']) {
    assert.ok(ROUTER_PROTOCOL_TEXT.includes(phrase), 'ROUTER 复用/额度纪律缺失: ' + phrase);
  }
  assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes('member-limit'), 'Lead 段缺 member-limit 处理指引');
});

test('Router deny 清单：只含执行/写类工具（read/glob/grep 保持可用）', () => {
  assert.deepEqual([...ROUTER_DENY_TOOLS], ['bash', 'pwsh', 'write', 'edit']);
  for (const allowed of ['read', 'glob', 'grep', 'subagent', 'spawn_teammate', 'relay_status']) {
    assert.ok(!ROUTER_DENY_TOOLS.includes(allowed), allowed + ' 不应在 deny 清单');
  }
  // v0.2.17 B：lead-only 工具清单 = 注册名（relay_ 前缀防漂移）
  assert.deepEqual([...LEAD_ONLY_TOOLS], ['relay_organize', 'relay_handoff', 'relay_recommend', 'relay_work_items']);
  // v0.2.17 D：普通子代理额外隐藏清单只含 relay_phase（relay_status 仍可见），与 lead-only 不重叠
  assert.deepEqual([...SUBAGENT_ONLY_HIDDEN_TOOLS], ['relay_phase']);
  assert.equal(LEAD_ONLY_TOOLS.filter((name) => SUBAGENT_ONLY_HIDDEN_TOOLS.includes(name)).length, 0);
});

test('v0.9.0 单一模式：默认配置即注入单模式协议；root 恒裁执行类工具并注入 Router/团队段', async () => {
  assert.ok(!PROTOCOL_TEXT.includes('Router 模式'), 'PROTOCOL_TEXT 派生源不应含 Router 段');
  assert.ok(!PROTOCOL_TEXT.includes('超长任务模式（Relay · 超长任务）'), 'PROTOCOL_TEXT 派生源不应含旧模式段');
  // v0.2.13 搬入：派活与回执纪律 + 单模式双名
  assert.match(PROTOCOL_TEXT, /派活与回执/);
  assert.match(PROTOCOL_TEXT, /≤4KB/);
  assert.match(PROTOCOL_TEXT, /≤200 字/);
  assert.match(PROTOCOL_TEXT, /接力模式（Relay）· 超长任务/);
  // base（派生源）不写 Router 专属硬规则「不设自己干例外」——它只在 ROUTER 段承载
  assert.ok(!PROTOCOL_TEXT.includes('不设「小任务自己干」例外'));
  // 默认配置（无 routerMode 参数）也按唯一模式装配：协议恒 LONG base，root 恒裁 + 注入 Router/团队段。
  const f = fakeCtx();
  apply(f.ctx, {});
  const names = f.sections.map((section) => section.name);
  assert.ok(!names.includes('context-relay:router'), 'generation 作用域不静态注入 router section（per-agent 安装）');
  assert.ok(names.includes('context-relay:protocol'), '常驻 relay 协议照旧注入');
  assert.equal(f.sections.find((section) => section.name === 'context-relay:protocol').text, PROTOCOL_TEXT_LONG, '默认配置注入单模式 base（LONG）');
  const listener = agentListener(f);
  assert.ok(listener !== undefined, 'per-agent 安装监听器始终注册');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], '单一模式 root 恒裁执行类工具');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], 'root 注入 Router + 队友保鲜段');
});

test('v0.3.8/v0.9.0 单模式常驻协议：PROTOCOL_TEXT_LONG 去掉「压缩→新会话 / 两段式」且为唯一注入 base', () => {
  // 预算与短语：长版本由 classic 派生，仍承载全部硬约束；只去掉长模式不存在的档位。
  assert.ok(PROTOCOL_TEXT_LONG.length <= 6450, 'PROTOCOL_TEXT_LONG 超预算: ' + PROTOCOL_TEXT_LONG.length);
  assert.ok(!PROTOCOL_TEXT_LONG.includes('压缩→新会话'), '长模式协议不得出现已移除档位');
  assert.ok(!PROTOCOL_TEXT_LONG.includes('两段式'), '长模式协议不得出现两段式说明');
  for (const phrase of [
    '继续/压缩继续/接力新会话',
    '本模式只有这三档',
    '模式只决定「做什么」',
    '不产生审批豁免',
    'phase 边界闸门',
    '不开新 phase',
    'contract_check{requirement, fidelity, attention}',
  ]) {
    assert.ok(PROTOCOL_TEXT_LONG.includes(phrase), '长模式协议缺短语: ' + phrase);
  }
  // classic 文本不变：仍支持四档与两段式。
  assert.ok(PROTOCOL_TEXT.includes('压缩→新会话'));
  assert.ok(PROTOCOL_TEXT.includes('两段式'));

  // 装配：唯一模式恒注入 LONG base（config.routerMode 真假都同样装配，旧配置被忽略）。
  const classic = fakeCtx();
  apply(classic.ctx, {});
  assert.equal(classic.sections.find((section) => section.name === 'context-relay:protocol').text, PROTOCOL_TEXT_LONG);
  const long = fakeCtx();
  apply(long.ctx, { routerMode: true });
  assert.equal(long.sections.find((section) => section.name === 'context-relay:protocol').text, PROTOCOL_TEXT_LONG);
});

test('v0.9.0 单一模式：agent/created 恒安装——非 root 裁 lead-only（普通子代理另裁 relay_phase），root 恒裁 + 注入 Router', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  assert.ok(listener !== undefined, 'per-agent 安装监听器始终注册');
  // rc.2 起 depth=1 子会话就是直接队友：装紧凑队友协议，只裁 lead-only。
  for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent(header, calls, sections) });
    assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], '直接队友只裁 lead-only：' + JSON.stringify(header));
    assert.equal(sections[0]?.text, TEAMMATE_PROTOCOL_TEXT, '直接队友装紧凑队友协议：' + JSON.stringify(header));
  }
  // depth≥2 才是普通子代理：裁 lead-only + 额外隐藏 relay_phase + 影子协议。
  {
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 2 }, calls, sections) });
    assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '普通子代理应裁 lead-only + relay_phase');
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol']);
  }
  // root → 恒裁 Router deny 清单 + 注入 Router/团队段（relay_phase 保留）
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [...ROUTER_DENY_TOOLS]);
  assert.ok(!calls.includes('relay_phase'), 'root 保留 relay_phase');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead']);
  // parentSession 是 fork 血缘，不是 subagent：普通 fork 根会话按 root 处理（恒裁 + 装 Router）。
  const forkCalls = [];
  const forkSections = [];
  await listener.listener({ agent: makeAgent({ parentSession: 'session-parent' }, forkCalls, forkSections) });
  assert.deepEqual(forkCalls, [...ROUTER_DENY_TOOLS], '普通 fork 根会话不被当子代理');
  assert.deepEqual(forkSections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], '普通 fork 根会话按 root 装配');
});

test('v0.2.17 B：非 root 工具裁剪 fail-open——单名未注册跳过、全部失败 warn、inject 失败不抛', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  // 单个工具名未注册 → 其余仍裁
  const partial = [];
  await listener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 2 }, partial, [], { restrictThrows: new Set(['relay_organize']) }) });
  assert.deepEqual(partial, ['relay_handoff', 'relay_recommend', 'relay_work_items', ...SUBAGENT_ONLY_HIDDEN_TOOLS], '未知工具名跳过，其余仍裁（含 D）');
  // 全部失败 ≠ 平台缺单个工具：必须 warn，不能静默 fail-open
  await listener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 2 }, [], [], { restrictThrows: new Set([...LEAD_ONLY_TOOLS]) }) });
  assert.ok(f.warns.some((line) => line.includes('worker restrict: no tools restricted')), '全部 restrict 失败应 warn');
  // inject 本身失败 → warn 后跳过，不抛（不阻断会话创建）
  await assert.doesNotReject(async () => listener.listener({ agent: makeAgent({ origin: 'subagent' }, [], [], { injectThrows: true }) }), 'inject 失败不得让 agent/created 抛错');
  assert.ok(f.warns.some((line) => line.includes('worker restrict skipped')), 'restrict 失败应 warn 记录');
});

test('v0.2.17 C：非 root 非队友 → 同名影子覆盖 context-relay:protocol（order 沿用 10150）', async () => {
  const f = fakeCtx(); // 无 agentTeams 服务：不可能有队友 → 覆盖所有非 root
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 }, calls, sections) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'context-relay:protocol', '必须与 preset 层同名才能影子覆盖');
  assert.equal(sections[0].order, 10150, 'order 沿用 preset 段顺序');
  assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT);
});

test('v0.2.17 C：直接队友装紧凑队友协议（同名影子覆盖），但 B 仍裁 lead-only 工具', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'worker' }) } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], '队友也禁用 lead-only 工具（到线/交接交回 Lead）');
  assert.ok(!calls.includes('relay_phase'), 'D：队友保留 relay_phase（内含队友分相拒绝/请示逻辑）');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '队友协议用同名 section 影子覆盖');
  assert.equal(sections[0].text, TEAMMATE_PROTOCOL_TEXT, '队友拿紧凑队友协议（不再用 10KB 全量协议）');
});

test('v0.2.17 C：root 不注入 worker 影子（只装 Router/团队段）；非 root agent.ctx 缺失时 fail-open 只 warn', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({}, [], sections) });
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], 'root 只装 Router/团队段，不装 worker 影子');
  // 非 root 深代 ctx 缺失（非常规 composition）→ 不抛，warn
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: { session: { header: { origin: 'subagent', delegationDepth: 2 } } } }));
  assert.ok(f.warns.some((line) => line.includes('worker restrict skipped: agent.ctx unavailable')));
  assert.ok(f.warns.some((line) => line.includes('worker protocol skipped: agent.ctx unavailable')));
});

test('routerMode=true：root agent 经 agent/created 在自身 scope 注入 Router 段 + 逐名 restrict（Lead-only）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  // 生成作用域不再静态注入 router section：只给 per-agent root Lead 安装
  assert.ok(!f.sections.some((section) => section.name === 'context-relay:router'), 'generation scope 不应注入 router section');
  const listener = agentListener(f);
  assert.ok(listener !== undefined, 'routerMode=true 应有 agent/created 监听器');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, ['bash', 'pwsh', 'write', 'edit'], 'root agent 应逐名 deny 执行类工具');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], 'root agent 应注入超长任务协议段 + 队友保鲜段');
  assert.equal(sections[0].text, ROUTER_PROTOCOL_TEXT);
  assert.equal(sections[1].text, TEAM_LEAD_PROTOCOL_TEXT, '队友保鲜段文本与资产一致');
});

test('routerMode=true：depth=1 直接队友装紧凑队友协议 + checkpoint/freshen；depth≥2 子代理裁 relay_phase + worker 影子；都不裁 Router 工具', async () => {
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  const listener = agentListener(f);
  const teammateCalls = [];
  const teammateSections = [];
  const teammate = makeAgent({ origin: 'subagent', delegationDepth: 1 }, teammateCalls, teammateSections);
  await listener.listener({ agent: teammate });
  assert.deepEqual(teammateCalls, [...LEAD_ONLY_TOOLS], '直接队友只裁 lead-only（保留 relay_phase）');
  assert.ok(!teammateCalls.includes('bash'), '不裁 Router 执行类工具');
  assert.deepEqual(teammateSections.map((section) => section.name), ['context-relay:protocol'], '直接队友只装紧凑协议（不再叠 team-worker 段）');
  assert.equal(teammateSections[0].text, TEAMMATE_PROTOCOL_TEXT);
  assert.deepEqual(teammate.registered, ['relay_checkpoint', 'relay_freshen'], '直接队友拿 checkpoint/freshen');
  // depth≥2：普通子代理
  const calls = [];
  const sections = [];
  const deep = makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 }, calls, sections);
  await listener.listener({ agent: deep });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '普通子代理只裁 lead-only + relay_phase');
  assert.ok(!calls.includes('bash'), '不裁 Router 执行类工具');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '普通子代理只注入 worker 影子');
  assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT);
});

test('routerMode=true：fail-open——单个工具名未注册时其余仍裁、监听器不抛（不阻断会话创建）', async () => {
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  const listener = agentListener(f);
  const calls = [];
  await listener.listener({ agent: makeAgent({}, calls, [], { restrictThrows: new Set(['pwsh']) }) });
  assert.deepEqual(calls, ['bash', 'write', 'edit'], '未知工具名跳过，其余仍裁');
  // inject 本身失败（tools/systemPrompt 任一）→ warn 后跳过，不抛
  const throwing = makeAgent({}, [], [], { injectThrows: true });
  await assert.doesNotReject(async () => listener.listener({ agent: throwing }), 'inject 失败不得让 agent/created 抛错');
  assert.ok(f.warns.some((line) => line.includes('router restrict skipped')), 'restrict 失败应 warn 记录');
  assert.ok(f.warns.some((line) => line.includes('router protocol skipped')), 'protocol 注入失败应 warn 记录');
  // 全部名字都失败 ≠ 平台缺单个工具：必须 warn，不能静默 fail-open
  await listener.listener({ agent: makeAgent({}, [], [], { restrictThrows: new Set(['bash', 'pwsh', 'write', 'edit']) }) });
  assert.ok(f.warns.some((line) => line.includes('no tools restricted')), '全部 restrict 失败应 warn');
  // agent.ctx 缺失（非常规 composition）：warn 后跳过，不抛
  await assert.doesNotReject(async () => listener.listener({ agent: { session: { header: {} } } }), 'ctx 缺失不得抛');
  assert.ok(f.warns.some((line) => line.includes('agent.ctx unavailable')), 'ctx 缺失应 warn');
});

test('v0.9.0 单一模式：config.routerMode 被忽略（恒开装配），false 另 warn；任何值 root 都裁', async () => {
  for (const value of [false, 'true', 1, undefined, null]) {
    const f = fakeCtx();
    apply(f.ctx, { routerMode: value });
    assert.ok(!f.sections.some((section) => section.name === 'context-relay:router'), 'routerMode=' + JSON.stringify(value) + ' 不应静态注入 router section（per-agent 安装）');
    const listener = agentListener(f);
    assert.ok(listener !== undefined, 'per-agent 监听器始终注册');
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent({}, calls, sections) });
    assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], '单一模式 root 恒裁 routerMode=' + JSON.stringify(value));
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], 'root 恒注入 Router/团队段 routerMode=' + JSON.stringify(value));
    if (value === false) assert.ok(f.warns.some((line) => line.includes('config.routerMode=false ignored')), '显式 false 应 warn 已忽略');
  }
});

test('v0.9.0 单一模式：live settings.routerMode 不再影响装配（恒裁），清理设置前后一致', async () => {
  const key = Symbol.for('dsh-context-relay.settings');
  const previous = globalThis[key];
  try {
    globalThis[key] = { ...(previous ?? {}), routerMode: true };
    const f = fakeCtx();
    apply(f.ctx, {});
    const listener = agentListener(f);
    assert.ok(listener !== undefined, 'per-agent 监听器始终注册');
    const calls = [];
    await listener.listener({ agent: makeAgent({}, calls) });
    assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], '单一模式 root 恒裁（与 live settings 无关）');
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
  const after = fakeCtx();
  apply(after.ctx, {});
  const listener = agentListener(after);
  assert.ok(listener !== undefined, 'per-agent 监听器始终注册');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], '清理 live settings 后行为一致（单一模式恒裁）');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], '清理后 root 仍注入 Router/团队段');
});

test('v0.9.0 单一模式：所有新 root 都 seed compress（不覆盖显式值；非 root 不种；fail-open）', async () => {
  // 面板状态是进程级单例 + 持久化：固定到临时 panel.json，避免读写真实 home 数据。
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-router-panel-')), 'panel.json') });
  try {
    // 单一模式：root 无显式面板 → 种 defaultOperation='compress'
    const long = fakeCtx();
    apply(long.ctx, { routerMode: true });
    const longListener = agentListener(long);
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed' }) });
    assert.equal(panelStateOf('session-long-seed').defaultOperation, 'compress', 'relay-long 新根会话默认操作=压缩继续');

    // 人类显式保存的值不被覆盖（含显式 null=问我）
    updatePanelState('session-long-seed-handoff', { defaultOperation: 'handoff' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-handoff' }) });
    assert.equal(panelStateOf('session-long-seed-handoff').defaultOperation, 'handoff', '显式预设不被种子覆盖');
    updatePanelState('session-long-seed-ask', { defaultOperation: null }, { force: true });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-ask' }) });
    assert.equal(panelStateOf('session-long-seed-ask').defaultOperation, null, '显式「问我」(null) 不被种子覆盖');

    updatePanelState('session-long-seed-auto', { autoChoose: true });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-auto' }) });
    assert.equal(panelStateOf('session-long-seed-auto').defaultOperation, 'compress', 'autoChoose退役归一后新会话默认compress');
    assert.equal(panelStateOf('session-long-seed-auto').autoChoose, false, '旧模型自决档归一false');

    // v0.9.0 单一模式：cth 档退役（策略层归一时丢弃为 null，不再算显式记录）→ 新 root 种子照常写 compress；残留 cth 不得保留。
    updatePanelState('session-long-seed-stale-cth-preset', { defaultOperation: 'compress-then-handoff' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-stale-cth-preset' }) });
    assert.notEqual(panelStateOf('session-long-seed-stale-cth-preset').defaultOperation, 'compress-then-handoff', '升级残留 cth 档不得保留');
    assert.equal(panelStateOf('session-long-seed-stale-cth-preset').defaultOperation, 'compress', '单一模式所有新 root 都 seed compress');

    // v0.3.5：v0.3.3 长会话升级残留的 cth 推荐在根会话创建时清空（该档已从长模式移除）
    updatePanelState('session-long-seed-stale-cth', { recommendedOperation: 'compress-then-handoff', recommendedReason: '旧推荐', recommendedAt: 1234 }, { source: 'agent' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-stale-cth' }) });
    assert.equal(panelStateOf('session-long-seed-stale-cth').recommendedOperation, null, '升级残留 cth 推荐清空');
    assert.equal(panelStateOf('session-long-seed-stale-cth').recommendedReason, '');
    assert.equal(panelStateOf('session-long-seed-stale-cth').defaultOperation, 'compress', '种子照常');

    // 非 root（队友/子代理）不种：worker 会话保持未设置
    await longListener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 1 }, [], [], { sessionId: 'session-long-seed-worker' }) });
    assert.equal(panelStateOf('session-long-seed-worker').defaultOperation, null, '非 root 不种');

    // 单一模式不再区分 classic 装配：默认配置的所有新 root 同样 seed compress
    const classic = fakeCtx();
    apply(classic.ctx, {});
    await agentListener(classic).listener({ agent: makeAgent({}, [], [], { sessionId: 'session-classic-seed' }) });
    assert.equal(panelStateOf('session-classic-seed').defaultOperation, 'compress', '单一模式所有新 root 都 seed compress');

    // fail-open：root 无 session.id（非常规 composition）不抛
    await assert.doesNotReject(async () => longListener.listener({ agent: makeAgent({}, [], []) }), '缺 session.id 不得让 agent/created 抛错');
  } finally {
    clearPanelMemory();
  }
});

test('v0.2.17 D：普通子代理额外隐藏 relay_phase——各 membership 形状（无服务/undefined/普通成员）都裁，影子协议仍在', async () => {
  const cases = [
    { label: 'no-teams', services: {} },
    { label: 'membership-undefined', services: { agentTeams: { tryMembership: () => undefined } } },
    { label: 'role-worker', services: { agentTeams: { tryMembership: () => ({ role: 'worker', name: 'w' }) } } },
  ];
  for (const item of cases) {
    const f = fakeCtx(item.services);
    apply(f.ctx, {});
    const calls = [];
    const sections = [];
    await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 }, calls, sections) });
    assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '普通子代理应裁三项（' + item.label + '）');
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '影子协议照装（' + item.label + '）');
    assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT, '影子文本不变（' + item.label + '）');
  }
});

test('v0.2.17 D：队友只裁 organize/handoff（relay_phase 保留、装紧凑协议）；root 恒裁并装 Router', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'worker' }) } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], '队友只裁 lead-only 工具，D 不生效');
  assert.ok(!calls.includes('relay_phase'), '队友保留 relay_phase（分相/请示逻辑在执行层）');
  assert.equal(sections[0]?.text, TEAMMATE_PROTOCOL_TEXT, '队友装紧凑队友协议');
  // root：恒裁 Router deny 清单 + 装 Router/团队段——relay_phase 对所有身份可见
  const g = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate' }) } });
  apply(g.ctx, {});
  const rootCalls = [];
  const rootSections = [];
  await agentListener(g).listener({ agent: makeAgent({}, rootCalls, rootSections) });
  assert.deepEqual(rootCalls, [...ROUTER_DENY_TOOLS], 'root 恒裁 Router deny 清单');
  assert.deepEqual(rootSections.map((section) => section.name), ['context-relay:router', 'context-relay:team-lead'], 'root 装 Router/团队段');
});


test('v0.7.1 创建瞬间架构师识别：pending 标记认领（不依赖 subagents 服务），消费后下一个 depth=1 是普通队友', async () => {
  clearSharedMemory();
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  const listener = agentListener(f);
  // 模拟 relay_architect：spawn 前登记 pending（rc.2 的 agent/created 早于 subagents.resident 登记）。
  markPendingArchitect('session-lead');
  const calls = [];
  const sections = [];
  const architect = makeAgent({ origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 }, calls, sections);
  await listener.listener({ agent: architect });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '架构师只裁 lead-only + relay_phase');
  assert.deepEqual(architect.registered, ['relay_checkpoint'], '架构师只拿 checkpoint，不拿 freshen');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol']);
  assert.equal(sections[0].text, ARCHITECT_WORKER_PROTOCOL_TEXT, 'pending 命中 → 架构师独立协议');
  // pending 消费后：同父的下一个 depth=1 子会话是普通队友。
  const teammateCalls = [];
  const teammateSections = [];
  const teammate = makeAgent({ origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 }, teammateCalls, teammateSections);
  await listener.listener({ agent: teammate });
  assert.deepEqual(teammate.registered, ['relay_checkpoint', 'relay_freshen'], '下一个 depth=1 是队友');
  assert.equal(teammateSections[0].text, TEAMMATE_PROTOCOL_TEXT, '队友拿紧凑队友协议');
  clearSharedMemory();
});

test('v0.7.1 创建瞬间架构师识别：resume 后 roster 里的 sessionId 仍认架构师', async () => {
  clearSharedMemory();
  const cwd = mkdtempSync(join(tmpdir(), 'relay-router-arch-'));
  const rosterDir = join(cwd, '.scratch', 'context-relay', 'team', 'session-lead');
  mkdirSync(rosterDir, { recursive: true });
  writeFileSync(join(rosterDir, 'roster.json'), JSON.stringify({
    version: 1,
    lineages: {
      architect: {
        profile: { role: 'architect', description: '专职架构师' },
        generations: [{ gen: 1, name: 'architect', sessionId: 'session-arch-1', createdAt: '2026-11-15T00:00:00.000Z' }],
        activeGen: 1,
      },
    },
  }));
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  const sections = [];
  const architect = makeAgent(
    { origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1, cwd },
    [],
    sections,
    { sessionId: 'session-arch-1' },
  );
  await agentListener(f).listener({ agent: architect });
  assert.equal(sections[0].text, ARCHITECT_WORKER_PROTOCOL_TEXT, 'roster 命中 → 架构师协议（resume/重启）');
  clearSharedMemory();
});

test('v0.2.17 D：fail-open——relay_phase 未注册时只 warn，B 与影子协议不受影响', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 }, calls, sections, { restrictThrows: new Set(['relay_phase']) }) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], 'relay_phase 未注册 → 跳过，B 仍生效');
  assert.ok(f.warns.some((line) => line.includes('subagent restrict: no tools restricted')), 'D 全部失败应 warn（不静默）');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '影子协议不受 D 失败影响');
  // agent.ctx 缺失：两段 restrict 均只 warn、不抛（不阻断会话创建）
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: { session: { header: { origin: 'subagent', delegationDepth: 2 } } } }));
  assert.ok(f.warns.some((line) => line.includes('subagent restrict skipped: agent.ctx unavailable')), 'ctx 缺失时 D 也 fail-open + warn');
});
// ── v0.6.4 专职架构师协议资产 ─────────────────────────────────────────
test('v0.6.4 专职架构师协议资产：固定队友名 + Lead/架构师两段预算与硬约束', () => {
  assert.equal(ARCHITECT_NAME, 'architect');
  assert.ok(ARCHITECT_LEAD_PROTOCOL_TEXT.length <= 900, 'ARCHITECT_LEAD 超预算: ' + ARCHITECT_LEAD_PROTOCOL_TEXT.length);
  assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.length <= 700, 'ARCHITECT_WORKER 超预算: ' + ARCHITECT_WORKER_PROTOCOL_TEXT.length);
  for (const phrase of ['默认值跟随「模型」选择器', '已选过则沿用', '不拒绝、不阻塞', 'handoff 继承', '专职架构师', '与用户对齐需求', '工程实现路线设计交给', 'relay_architect', '固定 lineage', '工程实现文档', '待决策', '与用户敲定', '低上下文', '新任务到达', '不是它交付后自行清空']) {
    assert.ok(ARCHITECT_LEAD_PROTOCOL_TEXT.includes(phrase), 'ARCHITECT_LEAD 缺短语: ' + phrase);
  }
  for (const phrase of ['低上下文', '只读必须的上下文', '.scratch/context-relay/architecture/', '待决策', '报 Lead', 'relay_checkpoint', '不要自行 freshen', 'relay_freshen({reset:true, brief:新任务})', '不改产品代码']) {
    assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.includes(phrase), 'ARCHITECT_WORKER 缺短语: ' + phrase);
  }
  assert.ok(!ARCHITECT_WORKER_PROTOCOL_TEXT.includes('你是 relay 模式的 Lead'));
});

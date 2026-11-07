/**
 * Router / per-agent 契约测试（v0.2.12 Router + v0.2.17 B+C+D）：
 * 协议文本资产与预算回归 + classic 缺省不注入 Router（root 行为不变）
 * + root Lead 的 Router 安装（仅 routerMode、仅 root）
 * + 非 root 的 lead-only 工具裁剪（B：classic 也生效，fail-open）
 * + 子代理 worker 短协议影子覆盖（C：非 root 且非队友；队友保留全协议）
 * + 普通子代理额外隐藏 relay_phase（D：非 root 且非队友；队友/root 保留）。
 * 2026-11-03 用户裁决：范围内不加 relay_route/relay_inbox；协议/回执契约/PTC 模板先行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS } from '../lib/agent.js';
import { PROTOCOL_TEXT, PROTOCOL_TEXT_LONG, ROUTER_DENY_TOOLS, ROUTER_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT, TEAM_WORKER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { WORKER_PROTOCOL_TEXT } from '../lib/agent/worker.js';
import { clearPanelMemory, configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';

/** 最小 fake ctx：记录 systemPrompt section、工具注册、事件监听与 warn。 */
function fakeCtx(services = {}) {
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
    get(name) { return services[name]; },
  };
  return { ctx, sections, tools, listeners, warns };
}

/** 造一个带 session.header 的 agent；calls=restrict 记录，sections=注入的完整 section 定义。
 * options.sessionId：给 root 会话种子的路径提供会话 id（缺省不带 id，种子 fail-open 跳过）。 */
function makeAgent(header, calls, sections = [], options = {}) {
  const restrictThrows = options.restrictThrows ?? new Set();
  return {
    session: { header, ...(options.sessionId === undefined ? {} : { id: options.sessionId }) },
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
  assert.match(text, /超长任务模式（Relay · 超长任务）/);
  assert.match(text, /Lead，只调度、不执行/);
  // 与默认协议推荐段冲突时本模式优先（否则「小任务可自干」会误导 Lead）
  assert.match(text, /本模式优先于默认 Relay 协议中的推荐段/);
  assert.match(text, /Lead 只调度/);
  assert.match(text, /写文件、改代码、跑命令\/测试、查日志一律派 worker/);
  assert.match(text, /不设「小任务自己干」例外/);
  // 回执契约：文件 ≤4KB + 单条消息 ≤200 字 + 头 3 行机读 + verdict
  assert.match(text, /≤4KB/);
  assert.match(text, /≤200 字/);
  assert.match(text, /verdict: done\|needs-human\|blocked/);
  assert.match(text, /context-relay\/reports\/<taskId>\.md/);
  // PTC 两段模板：dispatch（批量建卡+spawn）与 collect（短等+digest）
  assert.match(text, /PTC dispatch 模板/);
  assert.match(text, /PTC collect 模板/);
  assert.match(text, /team_task_create/);
  assert.match(text, /spawn_teammate/);
  assert.match(text, /wait_agent/);
  assert.match(text, /digest/);
  // 边界如实：PTC 软约束 + 消息不可过滤
  assert.match(text, /node:fs/);
  assert.match(text, /软约束/);
  // 度量引用（与 relay_status 字段联动）
  assert.match(text, /relay_status\.execution/);
  assert.match(text, /relay_status\.compaction\.debt/);
});

test('prompt 字符预算回归 + 硬约束短语：PROTOCOL ≤5300 / ROUTER ≤2000', () => {
  // 常驻协议每个请求都在上下文里：体量回归（v0.2.16 再精简 + 审查回补后预算）与「不得为省字牺牲硬约束」双保险
  assert.ok(PROTOCOL_TEXT.length <= 5300, 'PROTOCOL_TEXT 超预算: ' + PROTOCOL_TEXT.length);
  assert.ok(ROUTER_PROTOCOL_TEXT.length <= 2000, 'ROUTER_PROTOCOL_TEXT 超预算: ' + ROUTER_PROTOCOL_TEXT.length);
  const protocolRequired = [
    '一次性预设只决定「做什么」',
    '不产生审批豁免',
    '免审只来自 autoCompress / autoHandoff / authorizeNext',
    'autoChoose 只决定谁选操作，不产生免审',
    '完整上下文索引',
    '最多 1 轮',
    '≤10 个工具调用 / ≤5 分钟',
    'contract_check{requirement, fidelity, attention}',
    'pending 不是跳过、不是同意',
    'phase 边界闸门',
    '不开新 phase',
    '升线 notice 只告知',
    '单条 ≤200 字符、整篇 ≤8KB',
    'evidence 用户 ≤11 条',
    'handoff 不是验收',
    '每轮召回 ≤3 条',
    '先写好文档再交接',
    '≤3 条相关历史经验（≤1KB）',
  ];
  for (const phrase of protocolRequired) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 硬约束短语缺失: ' + phrase);
  }
  const routerRequired = [
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

test('v0.3.2 队友保鲜协议资产：Lead/队友段预算 + 真清空 reset/rehydrate 纪律', () => {
  assert.ok(TEAM_LEAD_PROTOCOL_TEXT.length <= 800, 'TEAM_LEAD 超预算: ' + TEAM_LEAD_PROTOCOL_TEXT.length);
  assert.ok(TEAM_WORKER_PROTOCOL_TEXT.length <= 500, 'TEAM_WORKER 超预算: ' + TEAM_WORKER_PROTOCOL_TEXT.length);
  for (const phrase of ['队友是长期资产', 'relay_team_status', 'relay_checkpoint', 'relay_renew', '没有 checkpoint 不换代', 'escalation', 'ledger/roster']) {
    assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes(phrase), 'Lead 保鲜段缺短语: ' + phrase);
  }
  // v0.3.2：reset 是真清空（同成员/不占额度），renew 只换身份，满额/重启走 handoff+rehydrate
  for (const phrase of ['relay_freshen({reset:true', '真清空', '不占额度', '只用于换身份/角色', 'member-limit', 'relay_handoff', 'relay_rehydrate']) {
    assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes(phrase), 'Lead 段缺 reset/rehydrate 纪律: ' + phrase);
  }
  for (const phrase of ['relay_checkpoint', 'relay_freshen', '同代最多 2 次', '不向人类提问', 'session_event_read', '快照权威']) {
    assert.ok(TEAM_WORKER_PROTOCOL_TEXT.includes(phrase), '队友保鲜段缺短语: ' + phrase);
  }
  for (const phrase of ['relay_freshen({reset:true', '真清空', '不引用旧上下文', '≤100 字']) {
    assert.ok(TEAM_WORKER_PROTOCOL_TEXT.includes(phrase), '队友段缺 reset 纪律: ' + phrase);
  }
  // v0.3.2 真机会话反馈：固定小队/复用优先 + 成员额度稀缺（spawn 与 renew 都占额）
  for (const phrase of ['固定小队', '成员额度', 'relay_team_status']) {
    assert.ok(ROUTER_PROTOCOL_TEXT.includes(phrase), 'ROUTER 复用/额度纪律缺失: ' + phrase);
  }
  assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes('member-limit'), 'Lead 段缺 member-limit 处理指引');
  assert.ok(TEAM_WORKER_PROTOCOL_TEXT.includes('必须调用'), '队友段缺 checkpoint 硬要求');
});

test('Router deny 清单：只含执行/写类工具（read/glob/grep 保持可用）', () => {
  assert.deepEqual([...ROUTER_DENY_TOOLS], ['bash', 'pwsh', 'write', 'edit']);
  for (const allowed of ['read', 'glob', 'grep', 'subagent', 'spawn_teammate', 'relay_status']) {
    assert.ok(!ROUTER_DENY_TOOLS.includes(allowed), allowed + ' 不应在 deny 清单');
  }
  // v0.2.17 B：lead-only 工具清单 = 注册名（relay_ 前缀防漂移）
  assert.deepEqual([...LEAD_ONLY_TOOLS], ['relay_organize', 'relay_handoff', 'relay_recommend']);
  // v0.2.17 D：普通子代理额外隐藏清单只含 relay_phase（relay_status 仍可见），与 lead-only 不重叠
  assert.deepEqual([...SUBAGENT_ONLY_HIDDEN_TOOLS], ['relay_phase']);
  assert.equal(LEAD_ONLY_TOOLS.filter((name) => SUBAGENT_ONLY_HIDDEN_TOOLS.includes(name)).length, 0);
});

test('classic 行为不变：默认不注入超长任务协议段；root 不裁工具、不注入任何影子协议', async () => {
  assert.ok(!PROTOCOL_TEXT.includes('Router 模式'), 'classic PROTOCOL_TEXT 不应含 Router 段');
  assert.ok(!PROTOCOL_TEXT.includes('超长任务模式（Relay · 超长任务）'), 'classic PROTOCOL_TEXT 不应含超长任务模式段');
  // v0.2.13 搬入：派活与回执纪律（推荐）+ 指向超长任务模式
  assert.match(PROTOCOL_TEXT, /派活与回执/);
  assert.match(PROTOCOL_TEXT, /≤4KB/);
  assert.match(PROTOCOL_TEXT, /≤200 字/);
  assert.match(PROTOCOL_TEXT, /接力模式（Relay）· 超长任务/);
  // 默认模式不裁工具面：协议只推荐派活，不写死「不设自己干例外」（那是超长任务模式的硬规则）
  assert.ok(!PROTOCOL_TEXT.includes('不设「小任务自己干」例外'));
  const f = fakeCtx();
  apply(f.ctx, {});
  const names = f.sections.map((section) => section.name);
  assert.ok(!names.includes('context-relay:router'), '默认配置不应注入 router section');
  assert.ok(names.includes('context-relay:protocol'), '常驻 relay 协议照旧注入');
  // v0.2.17 B：classic 也注册 per-agent 安装监听器；但 root 分支在 classic 不做任何事（行为不变）
  const listener = agentListener(f);
  assert.ok(listener !== undefined, 'classic 也应注册 per-agent 安装监听器');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [], 'classic root 不裁工具');
  assert.deepEqual(sections, [], 'classic root 不注入 worker/router 影子协议');
});

test('v0.3.8 长模式常驻协议：PROTOCOL_TEXT_LONG 去掉「压缩→新会话 / 两段式」，classic 不变且装配按模式选择', () => {
  // 预算与短语：长版本由 classic 派生，仍承载全部硬约束；只去掉长模式不存在的档位。
  assert.ok(PROTOCOL_TEXT_LONG.length <= 5300, 'PROTOCOL_TEXT_LONG 超预算: ' + PROTOCOL_TEXT_LONG.length);
  assert.ok(!PROTOCOL_TEXT_LONG.includes('压缩→新会话'), '长模式协议不得出现已移除档位');
  assert.ok(!PROTOCOL_TEXT_LONG.includes('两段式'), '长模式协议不得出现两段式说明');
  for (const phrase of [
    '继续/压缩继续/接力新会话',
    '本模式只有这三档',
    '一次性预设只决定「做什么」',
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

  // 装配：classic 用经典协议，routerMode 用长模式协议（逐字相等）。
  const classic = fakeCtx();
  apply(classic.ctx, {});
  assert.equal(classic.sections.find((section) => section.name === 'context-relay:protocol').text, PROTOCOL_TEXT);
  const long = fakeCtx();
  apply(long.ctx, { routerMode: true });
  assert.equal(long.sections.find((section) => section.name === 'context-relay:protocol').text, PROTOCOL_TEXT_LONG);
});

test('v0.2.17 B/D：classic 也监听 agent/created——非 root 裁 lead-only（普通子代理另裁 relay_phase），root 不裁', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  assert.ok(listener !== undefined, 'classic 也应注册 per-agent 安装监听器');
  // 非 root 的三种 header 形状（origin/parentSession/delegationDepth 任一成立）→ 裁 lead-only 工具
  for (const header of [{ origin: 'subagent' }, { parentSession: 'session-parent' }, { delegationDepth: 1 }]) {
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent(header, calls, sections) });
    // 无 agentTeams 服务 → 不可能有队友 → B + D + C：裁 lead-only + 额外隐藏 relay_phase + 影子协议
    assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '非 root 普通子代理应裁 lead-only + relay_phase：' + JSON.stringify(header));
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol']);
  }
  // root → 不裁任何工具（classic 不变；relay_phase 保留）
  const calls = [];
  await listener.listener({ agent: makeAgent({}, calls) });
  assert.deepEqual(calls, []);
  assert.ok(!calls.includes('relay_phase'), 'root 保留 relay_phase');
});

test('v0.2.17 B：非 root 工具裁剪 fail-open——单名未注册跳过、全部失败 warn、inject 失败不抛', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  // 单个工具名未注册 → 其余仍裁
  const partial = [];
  await listener.listener({ agent: makeAgent({ origin: 'subagent' }, partial, [], { restrictThrows: new Set(['relay_organize']) }) });
  assert.deepEqual(partial, ['relay_handoff', 'relay_recommend', ...SUBAGENT_ONLY_HIDDEN_TOOLS], '未知工具名跳过，其余仍裁（含 D）');
  // 全部失败 ≠ 平台缺单个工具：必须 warn，不能静默 fail-open
  await listener.listener({ agent: makeAgent({ origin: 'subagent' }, [], [], { restrictThrows: new Set([...LEAD_ONLY_TOOLS]) }) });
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
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'context-relay:protocol', '必须与 preset 层同名才能影子覆盖');
  assert.equal(sections[0].order, 10150, 'order 沿用 preset 段顺序');
  assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT);
});

test('v0.2.17 C：agentTeams.tryMembership 返回 undefined（普通子代理）→ 仍覆盖', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => undefined } });
  apply(f.ctx, {});
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent' }, [], sections) });
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol']);
  assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT);
});

test('v0.2.17 C：队友保留全协议（不影子覆盖），但 B 仍裁 lead-only 工具', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'worker' }) } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], '队友也禁用 lead-only 工具（到线/交接交回 Lead）');
  assert.ok(!calls.includes('relay_phase'), 'D：队友保留 relay_phase（内含队友分相拒绝/请示逻辑）');
  assert.deepEqual(sections, [], '队友保留 preset 全量协议（task-15 已中性化身份句）');
});

test('v0.2.17 C：tryMembership 抛错 → 保守不覆盖（保留全协议）并 warn，B 不受影响', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => { throw new Error('team boom'); } } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: makeAgent({ origin: 'subagent' }, calls, sections) }));
  assert.deepEqual(sections, [], '区分失败时不得覆盖全协议');
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], 'B 工具裁剪照旧');
  assert.ok(!calls.includes('relay_phase'), 'D：区分不了队友时保守保留 relay_phase');
  assert.ok(f.warns.some((line) => line.includes('worker protocol skipped: team membership unavailable')), 'warn 记录');
  // ctx.get 本身抛错（服务层异常）→ 同样保守不覆盖，不阻断会话创建
  const g = fakeCtx();
  g.ctx.get = () => { throw new Error('service boom'); };
  apply(g.ctx, {});
  const sections2 = [];
  await assert.doesNotReject(async () => agentListener(g).listener({ agent: makeAgent({ origin: 'subagent' }, [], sections2) }));
  assert.deepEqual(sections2, [], '服务解析失败不得覆盖全协议');
  assert.ok(g.warns.some((line) => line.includes('worker protocol skipped: team membership unavailable')), 'get 抛错同样 warn');
});

test('v0.2.17 C：root 不注入 worker 影子；非 root agent.ctx 缺失时 fail-open 只 warn', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({}, [], sections) });
  assert.deepEqual(sections, [], 'root 保留 preset 全量协议');
  // 非 root 但 ctx 缺失（非常规 composition）→ 不抛，warn
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: { session: { header: { origin: 'subagent' } } } }));
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

test('routerMode=true：非 root 只做 B+C+D（裁 lead-only + relay_phase + worker 影子），不裁 Router 工具、不注入 Router 段', async () => {
  const f = fakeCtx();
  apply(f.ctx, { routerMode: true });
  const listener = agentListener(f);
  for (const header of [
    { origin: 'subagent' },
    { parentSession: 'session-parent' },
    { delegationDepth: 1 },
    { origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 },
  ]) {
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent(header, calls, sections) });
    assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '非 root 只裁 lead-only + relay_phase：' + JSON.stringify(header));
    assert.ok(!calls.includes('bash'), '非 root 不裁 Router 执行类工具：' + JSON.stringify(header));
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '非 root 只注入 worker 影子（不注入 Router 段）：' + JSON.stringify(header));
  }
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

test('routerMode 非布尔 true 不装 Router 安装（listener 仍因 B 存在）：避免字符串配置误开', async () => {
  for (const value of [false, 'true', 1, undefined, null]) {
    const f = fakeCtx();
    apply(f.ctx, { routerMode: value });
    assert.ok(!f.sections.some((section) => section.name === 'context-relay:router'), 'routerMode=' + JSON.stringify(value) + ' 不应静态注入 router section');
    const listener = agentListener(f);
    assert.ok(listener !== undefined, 'classic/B 的 per-agent 监听器始终注册');
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent({}, calls, sections) });
    assert.deepEqual(calls, [], 'root 不应被裁 routerMode=' + JSON.stringify(value));
    assert.deepEqual(sections, [], 'root 不应注入 router 段 routerMode=' + JSON.stringify(value));
  }
});

test('live settings 覆盖 routerMode（内部验证用）：host 进程内可开启，清理后 root 恢复不裁', async () => {
  const key = Symbol.for('dsh-context-relay.settings');
  const previous = globalThis[key];
  try {
    globalThis[key] = { ...(previous ?? {}), routerMode: true };
    const f = fakeCtx();
    apply(f.ctx, {});
    const listener = agentListener(f);
    assert.ok(listener !== undefined, 'live settings routerMode=true 应生效');
    const calls = [];
    await listener.listener({ agent: makeAgent({}, calls) });
    assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], 'live routerMode 打开 root 应裁');
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
  const after = fakeCtx();
  apply(after.ctx, {});
  const listener = agentListener(after);
  assert.ok(listener !== undefined, 'B：classic 也注册 per-agent 安装');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [], '清理 live settings 后 root 恢复不裁');
  assert.deepEqual(sections, [], '清理后 root 不注入 router 段');
});

test('v0.3.1 relay-long 新根会话默认操作种子=continue（不覆盖显式值；classic 不种；fail-open）', async () => {
  // 面板状态是进程级单例 + 持久化：固定到临时 panel.json，避免读写真实 home 数据。
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-router-panel-')), 'panel.json') });
  try {
    // routerMode（relay-long）：root 无显式面板 → 种 defaultOperation='continue'
    const long = fakeCtx();
    apply(long.ctx, { routerMode: true });
    const longListener = agentListener(long);
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed' }) });
    assert.equal(panelStateOf('session-long-seed').defaultOperation, 'continue', 'relay-long 新根会话默认操作=继续');

    // 人类显式保存的值不被覆盖（含显式 null=问我）
    updatePanelState('session-long-seed-handoff', { defaultOperation: 'handoff' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-handoff' }) });
    assert.equal(panelStateOf('session-long-seed-handoff').defaultOperation, 'handoff', '显式预设不被种子覆盖');
    updatePanelState('session-long-seed-ask', { defaultOperation: null }, { force: true });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-ask' }) });
    assert.equal(panelStateOf('session-long-seed-ask').defaultOperation, null, '显式「问我」(null) 不被种子覆盖');

    // v0.3.8：长模式升级残留的面板预设也在根会话创建时清空（长模式没有该档）
    updatePanelState('session-long-seed-stale-cth-preset', { defaultOperation: 'compress-then-handoff' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-stale-cth-preset' }) });
    assert.equal(panelStateOf('session-long-seed-stale-cth-preset').defaultOperation, null, '长模式升级残留预设清空');

    // v0.3.5：v0.3.3 长会话升级残留的 cth 推荐在根会话创建时清空（该档已从长模式移除）
    updatePanelState('session-long-seed-stale-cth', { recommendedOperation: 'compress-then-handoff', recommendedReason: '旧推荐', recommendedAt: 1234 }, { source: 'agent' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-stale-cth' }) });
    assert.equal(panelStateOf('session-long-seed-stale-cth').recommendedOperation, null, '升级残留 cth 推荐清空');
    assert.equal(panelStateOf('session-long-seed-stale-cth').recommendedReason, '');
    assert.equal(panelStateOf('session-long-seed-stale-cth').defaultOperation, 'continue', '种子照常');

    // 非 root（队友/子代理）不种：长模式下 worker 会话保持未设置
    await longListener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 1 }, [], [], { sessionId: 'session-long-seed-worker' }) });
    assert.equal(panelStateOf('session-long-seed-worker').defaultOperation, null, '非 root 不种');

    // classic：root 不种
    const classic = fakeCtx();
    apply(classic.ctx, {});
    await agentListener(classic).listener({ agent: makeAgent({}, [], [], { sessionId: 'session-classic-seed' }) });
    assert.equal(panelStateOf('session-classic-seed').defaultOperation, null, 'classic 不种');

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
    await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }, calls, sections) });
    assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS], '普通子代理应裁三项（' + item.label + '）');
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '影子协议照装（' + item.label + '）');
    assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT, '影子文本不变（' + item.label + '）');
  }
});

test('v0.2.17 D：队友只裁 organize/handoff（relay_phase 保留、不装影子）；root 不裁任何工具', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'worker' }) } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], '队友只裁 lead-only 工具，D 不生效');
  assert.ok(!calls.includes('relay_phase'), '队友保留 relay_phase（分相/请示逻辑在执行层）');
  assert.deepEqual(sections, [], '队友保留全协议');
  // root（classic）：什么都不裁、不装影子——relay_phase 对所有身份可见
  const g = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate' }) } });
  apply(g.ctx, {});
  const rootCalls = [];
  const rootSections = [];
  await agentListener(g).listener({ agent: makeAgent({}, rootCalls, rootSections) });
  assert.deepEqual(rootCalls, [], 'root 不裁任何工具');
  assert.deepEqual(rootSections, [], 'root 不装影子协议');
});

test('v0.2.17 D：fail-open——relay_phase 未注册时只 warn，B 与影子协议不受影响', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent' }, calls, sections, { restrictThrows: new Set(['relay_phase']) }) });
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS], 'relay_phase 未注册 → 跳过，B 仍生效');
  assert.ok(f.warns.some((line) => line.includes('subagent restrict: no tools restricted')), 'D 全部失败应 warn（不静默）');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:protocol'], '影子协议不受 D 失败影响');
  // agent.ctx 缺失：两段 restrict 均只 warn、不抛（不阻断会话创建）
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: { session: { header: { origin: 'subagent' } } } }));
  assert.ok(f.warns.some((line) => line.includes('subagent restrict skipped: agent.ctx unavailable')), 'ctx 缺失时 D 也 fail-open + warn');
});

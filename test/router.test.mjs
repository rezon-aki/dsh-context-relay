/**
 * Router / per-agent 契约测试（v0.2.12 Router + v0.2.17 B+C+D；v0.9.0 单一模式）：
 * 协议文本资产与预算回归 + 单一模式恒注入 PROTOCOL_TEXT base（v0.10.0 删派生/别名）
 * + root Lead 恒装 Router（工具面裁剪 + 协议段 + 队友保鲜段）
 * + 非 root 的 lead-only 工具裁剪（B，fail-open）
 * + 子代理 worker 短协议影子覆盖（C：普通子代理；直接队友装紧凑队友协议）
 * + 普通子代理额外隐藏 relay_phase（D：非 root 且非队友；队友/root 保留）。
 * 2026-11-03 用户裁决：范围内不加 relay_route/relay_inbox；协议/回执契约先行。v0.9.0 批次3 起派活/收口工具化（relay_dispatch/relay_collect 替代旧 PTC 手写模板）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS } from '../lib/agent.js';
import { SUBAGENT_ASK_USER_DENY, SUBAGENT_DOC_LINT_DENY, SUBAGENT_STATUS_DENY } from '../lib/plane/roles.js';
import { ARCHITECT_LEAD_PROTOCOL_TEXT, ARCHITECT_NAME, ARCHITECT_WORKER_PROTOCOL_TEXT, PHASE_PROTOCOL_TEXT, PROTOCOL_TEXT, REDLINE_PROTOCOL_TEXT, ROUTER_DENY_TOOLS, ROUTER_PROTOCOL_TEXT, TEAMMATE_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT, UNLIMITED_BUDGET_TEXT, WORK_LEDGER_PROTOCOL_TEXT } from '../lib/agent/protocol.js';
import { WORKER_PROTOCOL_TEXT } from '../lib/agent/worker.js';
import { subagentsFromLegacy } from './team-fixture.mjs';
import { clearSharedMemory, markPendingArchitect } from '../lib/agent/shared.js';
import { clearPanelMemory, configurePanelStore, panelStateOf, updatePanelState } from '../lib/panel-store.js';

/** section 文本求值：preset 段是 text(context) 函数；测试用 root Lead 上下文求值。 */
const LEAD_CTX = { agent: { session: { id: 'session-router-lead', header: {}, seq: 0 } } };
const sectionText = (definition, context = LEAD_CTX) => String(typeof definition?.text === 'function' ? definition.text(context) : definition?.text ?? '');

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
        if (services.length === 1 && services[0] === 'skills') {
          callback({ skills: { register(definition) { (options.skills ?? []).push(definition.name); return () => {}; } } });
          return { dispose() {} };
        }
        throw new Error('unexpected inject services: ' + JSON.stringify(services));
      },
    },
  };
}

/** per-agent 安装监听器（单一模式恒注册；root 分支装 Router/团队段）。 */
function agentListener(f) {
  return f.listeners.find((entry) => entry.name === 'agent/created');
}

/** w5 角色 deny 期望（顺序 = roles.js 表内 deny 组顺序）。 */
const TEAMMATE_DENY = [...LEAD_ONLY_TOOLS, ...SUBAGENT_DOC_LINT_DENY, ...SUBAGENT_ASK_USER_DENY];
const ARCHITECT_DENY = [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS, ...SUBAGENT_STATUS_DENY, ...SUBAGENT_DOC_LINT_DENY, ...SUBAGENT_ASK_USER_DENY];
const WORKER_DENY = [...LEAD_ONLY_TOOLS, ...SUBAGENT_ONLY_HIDDEN_TOOLS, ...SUBAGENT_STATUS_DENY, ...SUBAGENT_DOC_LINT_DENY, ...SUBAGENT_ASK_USER_DENY];

test('超长任务协议资产：角色纪律 / 派活与收口工具 / 回执契约齐全', () => {
  const text = ROUTER_PROTOCOL_TEXT;
  assert.match(text, /调度纪律（Lead 只调度）/);
  assert.match(text, /root Lead，只调度、不执行/);
  assert.match(text, /任何执行工作一律派 worker/);
  assert.match(text, /不设「小任务自己干」例外/);
  for (const phrase of ['不设自做额度', '用户交互、决策、派活、验收抽样', '验收抽样（≤3 次/phase', '写实现文档、读长日志也派 worker', '目标 ≤20%', 'warn 只提醒', 'strict 命中即拒', '面板默认档', '新会话默认=压缩继续', '不继承旧模式/授权']) {
    assert.ok(text.includes(phrase), 'ROUTER 缺短语: ' + phrase);
  }
  // 回执契约：文件 ≤4KB + 单条消息 ≤200 字 + 头 3 行机读 + verdict
  assert.match(text, /≤4KB/);
  assert.match(text, /≤200 字/);
  assert.match(text, /verdict: done\|needs-human\|blocked/);
  assert.match(text, /context-relay\/reports\/<taskId>\.md/);
  // 派活与收口工具化（v0.9.0 批次3；替代旧 PTC 手写模板）
  assert.match(text, /派活与回执（工具化：relay_dispatch \/ relay_collect）/);
  for (const phrase of ['relay_dispatch', 'relay_collect', '≤120s', 'digest', 'reportPath', 'evidence=reportPath', '只回 digest']) {
    assert.ok(text.includes(phrase), 'ROUTER 派活/收口缺短语: ' + phrase);
  }
  // 旧 PTC 手写模板不得回潮
  for (const oldPhrase of ['PTC dispatch 模板', 'PTC collect 模板', 'subagent({ name: who', 'send_message({ agent: who']) {
    assert.equal(text.includes(oldPhrase), false, 'ROUTER 不应再有旧 PTC 模板片段: ' + oldPhrase);
  }
  // 边界如实：PTC 软约束
  assert.match(text, /node:fs/);
  assert.match(text, /软约束/);
  // 度量引用（与 relay_status.delegation 字段联动）
  assert.match(text, /relay_status\.delegation/);
  // lead-exec / build/verify owner 口径唯一真源在 base §派活与回执
  assert.ok(PROTOCOL_TEXT.includes('lead-exec'));
  assert.ok(PROTOCOL_TEXT.includes('build/verify 分点 owner 必须是 worker'));
  assert.ok(WORK_LEDGER_PROTOCOL_TEXT.includes('见 §派活与回执'));
  assert.equal(WORK_LEDGER_PROTOCOL_TEXT.includes('build/verify 分点 owner 必须是 worker'), false);
});

test('v0.9.0 skill 同步 Lead 职责、默认档与架构师模型口径', () => {
  const text = readFileSync(new URL('../skills/context-relay/SKILL.md', import.meta.url), 'utf8');
  for (const phrase of ['## Lead 职责', '用户交互、决策（裁决）、派活、验收抽样', '不亲自改码/跑测试/写实现文档/读长日志', '不设自做额度', '派活或拆票', '≤3 次/phase', '目标 ≤20%', 'relay_dispatch', 'relay_collect', 'lead-exec', '派活与收口', '委派统计', 'worker 必须亲自写/跑', '新 root 默认压缩继续', '模式和授权不跨会话继承', '默认值跟随「模型」选择器', '已选过则沿用该选择', '默认（跟随模型选择）', 'handoff 继承']) {
    assert.ok(text.includes(phrase), 'SKILL 缺短语: ' + phrase);
  }
  assert.ok(!text.includes('当前实现仍 seed'));
  for (const phrase of ['四段式', '结论：', '影响：', '需要你做什么：', '证据位置：', '只提醒不拒绝', '绝不阻断ship', 'details_requested:true', '≤4000字', '官方任务板为准', 'officialTaskId', '固定小队默认上限 8', 'spawn 默认允许', '容量保全', 'capacityThreshold', 'exit_reason']) assert.ok(text.includes(phrase), phrase);
});

test('prompt 字符预算回归 + 硬约束短语：PROTOCOL ≤8200 / ROUTER ≤2450 / TEAMMATE ≤1350', () => {
  // 常驻协议每个请求都在上下文里：体量回归（v0.14 P1 合并后重新定格）与「不得为省字牺牲硬约束」双保险。
  // 0.14.0-dev P1：Lead 的 6 个静态段合并为 1 段（PROTOCOL_TEXT，字节预算见下一条）；字符上限保持原量级。
  assert.ok(PROTOCOL_TEXT.length <= 8200, 'PROTOCOL_TEXT 超预算: ' + PROTOCOL_TEXT.length);
  assert.ok(ROUTER_PROTOCOL_TEXT.length <= 2450, 'ROUTER_PROTOCOL_TEXT 超预算: ' + ROUTER_PROTOCOL_TEXT.length);
  // C11/A-07（M-09）：TEAMMATE 是 depth-1 直接队友的**整段**注入文本，防无界漂移。
  assert.ok(TEAMMATE_PROTOCOL_TEXT.length <= 1320, 'TEAMMATE_PROTOCOL_TEXT 超预算: ' + TEAMMATE_PROTOCOL_TEXT.length);
  const protocolRequired = [
    '汇报默认三问', '只提醒不拒绝', '容量保全', '容量保全线（默认 55%', '不自动压缩', 'exit_reason', "phase:'blocked'|'cancel'", 'verify→build', '审查超时或未完成不算通过', '固定小队上限 8', 'spawn 默认允许', '绑定会话+操作+版本', '不跨会话继承', '派活 brief 五字段缺一不可',
    '模式只决定「做什么」',
    '不产生审批豁免',
    '免审只来自 autoCompress / autoHandoff / authorizeNext',
    '完整上下文索引',
    '最多 1 轮',
    '≤10 个工具调用 / ≤5 分钟',
    'contract_check{requirement, fidelity, attention}',
    'reopen（build/verify）',
    'pending 不是跳过、不是同意',
    'phase 边界闸门',
    '不开新 phase',
    '现在就该动手',
    '交接单 = 摘要 + 完整文件',
    '不因超长拒绝交接',
    '字节/条数上限只是 advisory',
    'handoff 不是验收',
    '每轮召回 ≤3 条',
    '先写好文档再交接',
    '≤3 条相关历史经验',
    '派活与回执（工具化',
    'relay_dispatch',
    'relay_collect',
    'digest≤600字',
    'lead-exec',
    '目标 ≤20%',
    'warn 只提醒',
    // 合同条款（P1 只删重复说明，纪律本体仍在合并协议里）
    '验收用户门（实现者自查有盲区）',
    '必须让新上下文的模型做一次独立审查，再向用户汇报',
    '边界问题即发现即报',
    '人类注意力最小高影响',
    '问题批量一次问清',
    '不限题数',
    'P0/不可逆',
    '超时≠同意',
    '授权口径（唯一真源）',
    // C9/AUDIT §12 两段式用户门：设计门（开工前显式停）+ 实现↔设计对齐（并行）+ 最小必要验收/重型授权
    '两个对齐点',
    '（A）设计门（开工前，显式停）',
    'design_gate{path,user_approved:true,ask_ref,not_doing}',
    '实现↔设计对齐',
    '与其他验收**并行**、不串行终检',
    '默认不做、须用户明确授权',
    'verification{tier:minimal|heavy,approved_by_user?,items[]}',
    '不校验顺序',
  ];
  for (const phrase of protocolRequired) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 硬约束短语缺失: ' + phrase);
  }
  // 汇报规范（§提问与汇报）在红线段（10199，system 最末）；ROUTER 只留调度/派活。
  const redlineRequired = [
    '提问与汇报（白话优先）', '你看到什么：', '要你做什么：', '有什么影响：', '默认三问', '只提醒不拒绝', '只给 warning', '不阻断 ship/任何 phase', '≤600 字', '≤4000字', 'details_requested:true',
  ];
  for (const phrase of redlineRequired) {
    assert.ok(REDLINE_PROTOCOL_TEXT.includes(phrase), 'REDLINE 硬约束短语缺失: ' + phrase);
  }
  const routerRequired = [
    '目标：', '必读（1–3 份', '写范围：', '验收：', '回执：',
    "不设自做额度",
    "用户交互、决策、派活、验收抽样",
    "验收抽样（≤3 次/phase",
    "写实现文档、读长日志也派 worker",
    "目标 ≤20%",
    "warn 只提醒",
    "strict 命中即拒",
    '面板默认档',
    '新会话默认=压缩继续',
    '不继承旧模式/授权',
    'root Lead，只调度、不执行',
    '不设「小任务自己干」例外',
    'relay_dispatch',
    'relay_collect',
    '≤120s',
    'digest',
    'reportPath',
    'evidence=reportPath',
    '≤4KB',
    '≤200 字',
    'verdict: done|needs-human|blocked',
    'context-relay/reports/<taskId>.md',
    'node:fs',
    '软约束',
    'relay_status.delegation',
  ];
  for (const phrase of routerRequired) {
    assert.ok(ROUTER_PROTOCOL_TEXT.includes(phrase), 'ROUTER 硬约束短语缺失: ' + phrase);
  }
  // 已上收到合并协议的小队口径：ROUTER 不再重复（队段在 TEAM_LEAD 片段）
  for (const phrase of ['固定小队上限 8', '优先复用', 'relay_team_status']) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 缺小队口径: ' + phrase);
    assert.equal(ROUTER_PROTOCOL_TEXT.includes(phrase), false, 'ROUTER 不应重复小队口径: ' + phrase);
  }
  // 阈值不得写死在常驻协议（按百分比/30·35·45 数字判断）
  assert.ok(!/(^|[^0-9])(30|35|45)\s*%/.test(PROTOCOL_TEXT), '协议不得写死阈值百分比');
  // v0.2.15 审查 P1/P2 回归：旧误导措辞不得回到常驻协议
  assert.ok(!PROTOCOL_TEXT.includes('8 条相关历史经验'), '协议不得再写旧 lessons 注入数量');
  assert.ok(!PROTOCOL_TEXT.includes('三个自动授权'), '协议不得再用「三个自动授权」误称');
  for (const text of [PROTOCOL_TEXT, ROUTER_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT]) assert.doesNotMatch(text, /固定 2[-–]4 人|小任务可以自干/);
  // v0.2.17 A1：默认协议注入整个 preset（队友/子智能体也收到），不得再自称「你是 Lead」
  assert.ok(!PROTOCOL_TEXT.includes('你是 relay 模式的 Lead'), '协议不得再对 worker 误称「你是 Lead」');
});
test('v0.14 P1 真源唯一性 / 指针可达 / 合同条款清单（防删防回潮）', () => {
  // 合并后唯一真源 = PROTOCOL_TEXT；片段常量只做构建，不再重复注入。
  const resident = [PROTOCOL_TEXT, UNLIMITED_BUDGET_TEXT].join('\n');
  const countIn = (haystack, phrase) => haystack.split(phrase).length - 1;
  // 1) 真源句 occurrence==1（任何片段复制都会超 1）
  for (const phrase of ['不产生审批豁免', '免审只来自 autoCompress', '模式只决定「做什么」', '现在就该动手', '派活 brief 五字段缺一不可', '回执契约（写进 worker brief）', '授权口径（唯一真源）', 'lead-exec:<原因>']) {
    assert.equal(countIn(resident, phrase), 1, '真源句应恰好出现 1 次: ' + phrase + '（实际 ' + countIn(resident, phrase) + '）');
  }
  // 2) 小队口径只在合并文本出现一次；ROUTER 不重复
  for (const phrase of ['固定小队上限 8', '优先复用', 'relay_team_status']) {
    assert.equal(countIn(resident, phrase), 1, '上收口径应只出现 1 次: ' + phrase);
    assert.equal(ROUTER_PROTOCOL_TEXT.includes(phrase), false, 'ROUTER 不应重复: ' + phrase);
  }
  // 3) 指针可解析：ROUTER/LEDGER 的「见 §…」对应真源段真实存在
  assert.ok(ROUTER_PROTOCOL_TEXT.includes('见 §授权口径'), 'ROUTER 缺 §授权口径 指针');
  assert.ok(PROTOCOL_TEXT.includes('## 授权口径（唯一真源）'), '指针目标缺失: ## 授权口径（唯一真源）');
  assert.ok(WORK_LEDGER_PROTOCOL_TEXT.includes('见 §派活与回执'), 'LEDGER 缺 §派活与回执 指针');
  assert.ok(PROTOCOL_TEXT.includes('## Phase 状态机'), '指针目标缺失: ## Phase 状态机');
  assert.ok(PROTOCOL_TEXT.includes('## 派活与回执'), '指针目标缺失: ## 派活与回执');
  assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes('队友保鲜'), '指针目标缺失: 队友保鲜');
  // 4) 合同条款清单：只删重复句，条款本体必须仍在合并文本
  for (const phrase of ['验收用户门（实现者自查有盲区）', '必须让新上下文的模型做一次独立审查，再向用户汇报', '完整上下文索引', '最多 1 轮', '审查超时或未完成不算通过', '边界问题即发现即报', '人类注意力最小高影响', '问题批量一次问清', '不限题数', 'P0/不可逆', '超时≠同意', 'handoff 不是验收', '授权口径（唯一真源）', '模式只决定「做什么」', '不产生审批豁免', '免审只来自 autoCompress / autoHandoff / authorizeNext', '绑定会话+操作+版本', '不跨会话继承', '（A）设计门（开工前，显式停）', 'T2 首次进 build', 'design_gate{path,user_approved:true,ask_ref,not_doing}', '实现↔设计对齐', '与其他验收**并行**、不串行终检', '默认不做、须用户明确授权', 'verification{tier:minimal|heavy,approved_by_user?,items[]}']) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 合同条款缺失: ' + phrase);
  }
  // 5) 旧口径清零（既有禁令仍不得回潮）
  for (const oldPhrase of ['只作异常信号', '不设允许比例', 'PTC dispatch 模板', '小任务可以自干']) {
    assert.equal(resident.includes(oldPhrase), false, '旧口径回潮: ' + oldPhrase);
  }
});

test('v0.14 C3：四条丢失规则回写（升线去重/出口语义/每 phase 一次/交接不发消息+不回放+归档名）', () => {
  for (const phrase of [
    '到线只在升线时提醒', '同档不重复，与压缩次数无关',
    'blocked=等用户/外部，cancel=任务取消',
    '人类同步每 phase 最多一次非 P0',
    '不再给新会话发消息', '不回放/重建', 'progress-archive-<年份>.md',
  ]) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'C3 规则缺失: ' + phrase);
  }
});
test('v0.14 P1：redline(10199)+phase(10150) 两段结构（字节只记录，不设门）', () => {
  // v0.14 P1 验收：Lead 常驻协议拆 redline（system 最末）+ phase（角色影子覆盖），
  // 装配只剩这两段；unlimitedBudget 句并入 redline 顶部。字节按 UTF-8 只做 diagnostic（R1：不设失败门）。
  const redline = Buffer.byteLength(REDLINE_PROTOCOL_TEXT, 'utf8');
  const phase = Buffer.byteLength(PHASE_PROTOCOL_TEXT, 'utf8');
  const budget = Buffer.byteLength(UNLIMITED_BUDGET_TEXT, 'utf8');
  const register = REDLINE_PROTOCOL_TEXT.slice(REDLINE_PROTOCOL_TEXT.lastIndexOf('## 用户语域'));
  console.log('[diagnostic] protocol bytes: redline=' + redline + ' phase=' + phase
    + ' unlimited=' + budget + ' total=' + (redline + 2 + phase + budget)
    + ' register=' + Buffer.byteLength(register, 'utf8'));
  // 结构断言（非字节）：两段都有落点，redline 以用户语域收尾。
  assert.ok(PHASE_PROTOCOL_TEXT.startsWith('## phase 优先'), 'phase 以 phase 优先开头');
  assert.ok(register.startsWith('## 用户语域'), 'redline 以用户语域段收尾');
  assert.ok(redline > 0 && phase > 0);
});

test('v0.14 P1：WORK_LEDGER 片段承载台账核心纪律', () => {
  // 合并后片段仍单独导出；长度只记录（R1），台账纪律靠短语断言防止静默删掉。
  console.log('[diagnostic] WORK_LEDGER chars=' + WORK_LEDGER_PROTOCOL_TEXT.length);
  for (const phrase of ['台账是 **Lead 的项目管理队列**', 'relay_work_items', 'done+evidence', 'lead_confirm={no_drift,no_missing,no_regression}', '默认上限 30', 'archive.ndjson', '见 §派活与回执']) {
    assert.ok(WORK_LEDGER_PROTOCOL_TEXT.includes(phrase), 'WORK_LEDGER 缺规则: ' + phrase);
  }
  // 触发式注入说明（焦点行/同 step 一条 notice）属插件行为，已移到 SKILL 用法说明；
  // 片段只保留「读什么、何时写、如何收口」的硬规则。
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

test('v0.14 P1 队友保鲜协议资产：Lead/队友段预算 + 真清空 reset/手动重建 纪律', () => {
  assert.ok(TEAM_LEAD_PROTOCOL_TEXT.length <= 950, 'TEAM_LEAD 超预算: ' + TEAM_LEAD_PROTOCOL_TEXT.length);
  for (const phrase of ['固定小队上限 8', 'spawn 默认允许', 'relay_team_status', 'relay_checkpoint', 'relay_freshen({reset:true', 'relay_architect', 'relay_organize/relay_handoff', 'lead-only', '不问人类']) {
    assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes(phrase), 'Lead 保鲜段缺短语: ' + phrase);
  }
  // v0.3.2：reset 是真清空（同成员/不占额度）；架构师例外由 Lead 用 relay_architect fresh 新开代
  for (const phrase of ['真清空', '不占额度', 'Lead 不代调', '架构师例外', "mode:'fresh'"]) {
    assert.ok(TEAM_LEAD_PROTOCOL_TEXT.includes(phrase), 'Lead 段缺 reset/架构师 纪律: ' + phrase);
  }
  for (const phrase of ['relay_checkpoint', 'relay_freshen', '同代≤2', '不向人类提问', 'session_event_read', '快照权威', '真清空', '只写自己 lineage', '≤100 字', 'dispatchId', '必读 1–3 份']) {
    assert.ok(TEAMMATE_PROTOCOL_TEXT.includes(phrase), '紧凑队友段缺短语: ' + phrase);
  }
  // 小队/额度口径在合并协议里（TEAM_LEAD 片段），ROUTER 不再重复
  for (const phrase of ['固定小队上限 8', 'relay_team_status']) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 缺小队口径: ' + phrase);
    assert.equal(ROUTER_PROTOCOL_TEXT.includes(phrase), false, 'ROUTER 不应重复: ' + phrase);
  }
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

test('v0.9.0 单一模式：默认配置即注入单模式协议；root 恒裁执行类工具，无角色影子段', async () => {
  assert.ok(!PROTOCOL_TEXT.includes('Router 模式'), 'PROTOCOL_TEXT base 不应含 Router 段');
  assert.ok(!PROTOCOL_TEXT.includes('超长任务模式（Relay · 超长任务）'), 'PROTOCOL_TEXT base 不应含旧模式段');
  // v0.2.13 搬入：派活与回执纪律 + 单模式双名
  assert.match(PROTOCOL_TEXT, /派活与回执/);
  assert.match(PROTOCOL_TEXT, /≤4KB/);
  assert.match(PROTOCOL_TEXT, /≤200 字/);
  assert.match(PROTOCOL_TEXT, /接力模式（Relay）· 超长任务/);
  // v0.14 P1：ROUTER 片段已合入 PROTOCOL_TEXT，Lead 专属硬规则只在 ROUTER 片段出现一次。
  assert.equal(PROTOCOL_TEXT.split('不设「小任务自己干」例外').length - 1, 1);
  // 唯一模式装配：协议恒为 PROTOCOL_TEXT base，root 恒裁；root 无角色影子段。
  const f = fakeCtx();
  apply(f.ctx, {});
  const names = f.sections.map((section) => section.name);
  assert.ok(!names.includes('context-relay:router'), 'generation 作用域不静态注入 router section（per-agent 安装）');
  assert.ok(names.includes('context-relay:phase'), '常驻 relay 协议 phase 段照旧注入');
  assert.ok(names.includes('context-relay:redline'), '红线段注入（system 最末）');
  assert.equal(sectionText(f.sections.find((section) => section.name === 'context-relay:phase')), PHASE_PROTOCOL_TEXT, 'phase 段 = phaseProtocolText 默认形态');
  assert.equal(sectionText(f.sections.find((section) => section.name === 'context-relay:redline')), UNLIMITED_BUDGET_TEXT + '\n' + REDLINE_PROTOCOL_TEXT, '红线段顶部带预算句');
  const listener = agentListener(f);
  assert.ok(listener !== undefined, 'per-agent 安装监听器始终注册');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], '单一模式 root 恒裁执行类工具');
  assert.deepEqual(sections, [], 'v0.14 P1：root 无角色影子段（协议全在 preset 层）');
});

test('v0.3.8/v0.9.0/v0.10.0 单模式常驻协议：唯一 PROTOCOL_TEXT base，退役档/两段式句已删', () => {
  // 预算与短语：v0.10.0 删掉退役档（压缩→新会话/两段式）句与 LONG 派生后，base 仍承载全部硬约束。
  // v0.11 P0-E 容量线 55% 后实测 6,490；v0.11 P0-B 小队纪律（固定小队 8/spawn 关/reset 复用）后实测 6,552 → 预算同步到 6,560。
  // w1 设计门回显/深度模板后实测 7,086 → 预算同步到 7,200；v0.13 D2 三问后实测 7,236 → 7,300。
  // 0.14.0-dev W1/W2（风险档矩阵/裁决卡/内部事实）后实测 8,074 → 预算 8,200。
  assert.ok(PROTOCOL_TEXT.length <= 8200, 'PROTOCOL_TEXT 超预算: ' + PROTOCOL_TEXT.length);
  for (const retiredPhrase of ['压缩→新会话', '两段式', '本模式只有这三档', 'autoChoose', 'autoDecision']) {
    assert.ok(!PROTOCOL_TEXT.includes(retiredPhrase), '退役句不得回到常驻协议: ' + retiredPhrase);
  }
  for (const phrase of [
    '继续/压缩继续/接力新会话',
    '模式只决定「做什么」',
    '不产生审批豁免',
    'phase 边界闸门',
    '不开新 phase',
    'contract_check{requirement, fidelity, attention}',
  ]) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), '常驻协议缺短语: ' + phrase);
  }
  // 装配：唯一模式恒注入 PROTOCOL_TEXT；退役 host 配置（routerMode/legacyPresetCompat）被忽略。
  const plain = fakeCtx();
  apply(plain.ctx, {});
  assert.equal(sectionText(plain.sections.find((section) => section.name === 'context-relay:phase')), PHASE_PROTOCOL_TEXT);
  const retiredConfig = fakeCtx();
  apply(retiredConfig.ctx, { routerMode: true });
  assert.equal(sectionText(retiredConfig.sections.find((section) => section.name === 'context-relay:phase')), PHASE_PROTOCOL_TEXT);
  assert.equal(retiredConfig.warns.some((line) => /routerMode|legacy/.test(line)), false, '退役配置不再有专用 warn');
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
    assert.deepEqual(calls, TEAMMATE_DENY, '直接队友裁 lead-only + doc + ask_user：' + JSON.stringify(header));
    assert.equal(sections[0]?.text, TEAMMATE_PROTOCOL_TEXT, '直接队友装紧凑队友协议：' + JSON.stringify(header));
  }
  // depth≥2 才是普通子代理：裁 lead-only + 额外隐藏 relay_phase + 影子协议。
  {
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 2 }, calls, sections) });
    assert.deepEqual(calls, WORKER_DENY, '普通子代理裁 lead-only + relay_phase + status/doc + ask_user');
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:phase']);
  }
  // root → 恒裁 Router deny 清单 + 注入 Router/团队段（relay_phase 保留）
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, [...ROUTER_DENY_TOOLS]);
  assert.ok(!calls.includes('relay_phase'), 'root 保留 relay_phase');
  assert.deepEqual(sections, [], 'v0.14 P1：root 无角色影子段');
  // parentSession 是 fork 血缘，不是 subagent：普通 fork 根会话按 root 处理（恒裁 + 装 Router）。
  const forkCalls = [];
  const forkSections = [];
  await listener.listener({ agent: makeAgent({ parentSession: 'session-parent' }, forkCalls, forkSections) });
  assert.deepEqual(forkCalls, [...ROUTER_DENY_TOOLS], '普通 fork 根会话不被当子代理');
  assert.deepEqual(forkSections, [], '普通 fork 根会话按 root 装配（无角色影子段）');
});

test('v0.2.17 B：非 root 工具裁剪 fail-open——单名未注册跳过、全部失败 warn、inject 失败不抛', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  // 单个工具名未注册 → 其余仍裁
  const partial = [];
  await listener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 2 }, partial, [], { restrictThrows: new Set(['relay_organize']) }) });
  assert.deepEqual(partial, WORKER_DENY.filter((name) => name !== 'relay_organize'), '未知工具名跳过，其余仍裁（含 D）');
  // 全部失败 ≠ 平台缺单个工具：必须 warn，不能静默 fail-open
  await listener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 2 }, [], [], { restrictThrows: new Set([...LEAD_ONLY_TOOLS]) }) });
  assert.ok(f.warns.some((line) => line.includes('worker restrict: no tools restricted')), '全部 restrict 失败应 warn');
  // inject 本身失败 → warn 后跳过，不抛（不阻断会话创建）
  await assert.doesNotReject(async () => listener.listener({ agent: makeAgent({ origin: 'subagent' }, [], [], { injectThrows: true }) }), 'inject 失败不得让 agent/created 抛错');
  assert.ok(f.warns.some((line) => line.includes('worker restrict skipped')), 'restrict 失败应 warn 记录');
});

test('v0.2.17 C：非 root 非队友 → 同名影子覆盖 context-relay:phase（order 沿用 10150）', async () => {
  const f = fakeCtx(); // 无 agentTeams 服务：不可能有队友 → 覆盖所有非 root
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 }, calls, sections) });
  assert.deepEqual(calls, WORKER_DENY);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'context-relay:phase', '必须与 preset 层同名才能影子覆盖');
  assert.equal(sections[0].order, 10150, 'order 沿用 preset 段顺序');
  assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT);
});

test('v0.2.17 C：直接队友装紧凑队友协议（同名影子覆盖），但 B 仍裁 lead-only 工具', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'worker' }) } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, TEAMMATE_DENY, '队友禁用 lead-only + doc + ask_user（到线/交接交回 Lead）');
  assert.ok(!calls.includes('relay_phase'), 'D：队友保留 relay_phase（内含队友分相拒绝/请示逻辑）');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:phase'], '队友协议用同名 section 影子覆盖');
  assert.equal(sections[0].text, TEAMMATE_PROTOCOL_TEXT, '队友拿紧凑队友协议（不再用 10KB 全量协议）');
});

test('v0.2.17 C：root 不注入 worker 影子（只装 Router/团队段）；非 root agent.ctx 缺失时 fail-open 只 warn', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({}, [], sections) });
  assert.deepEqual(sections, [], 'root 不装 worker 影子（协议段由 preset 层提供）');
  // 非 root 深代 ctx 缺失（非常规 composition）→ 不抛，warn
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: { session: { header: { origin: 'subagent', delegationDepth: 2 } } } }));
  assert.ok(f.warns.some((line) => line.includes('worker restrict skipped: agent.ctx unavailable')));
  assert.ok(f.warns.some((line) => line.includes('worker protocol skipped: agent.ctx unavailable')));
});

test('root agent 经 agent/created 在自身 scope 注入 Router 段 + 逐名 restrict（Lead-only）', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  // 生成作用域不再静态注入 router section：只给 per-agent root Lead 安装
  assert.ok(!f.sections.some((section) => section.name === 'context-relay:router'), 'generation scope 不应注入 router section');
  const listener = agentListener(f);
  assert.ok(listener !== undefined, '应有 agent/created 监听器');
  const calls = [];
  const sections = [];
  await listener.listener({ agent: makeAgent({}, calls, sections) });
  assert.deepEqual(calls, ['bash', 'pwsh', 'write', 'edit'], 'root agent 应逐名 deny 执行类工具');
  assert.deepEqual(sections, [], 'v0.14 P1：root 无独立 Router/团队段（协议全在 preset 层）');
});

test('depth=1 直接队友装紧凑队友协议 + checkpoint/freshen；depth≥2 子代理裁 relay_phase + worker 影子；都不裁 Router 工具', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  const teammateCalls = [];
  const teammateSections = [];
  const teammate = makeAgent({ origin: 'subagent', delegationDepth: 1 }, teammateCalls, teammateSections);
  await listener.listener({ agent: teammate });
  assert.deepEqual(teammateCalls, TEAMMATE_DENY, '直接队友裁 lead-only + doc + ask_user（保留 relay_phase）');
  assert.ok(!teammateCalls.includes('bash'), '不裁 Router 执行类工具');
  assert.deepEqual(teammateSections.map((section) => section.name), ['context-relay:phase'], '直接队友只装紧凑协议（不再叠 team-worker 段）');
  assert.equal(teammateSections[0].text, TEAMMATE_PROTOCOL_TEXT);
  assert.deepEqual(teammate.registered, ['relay_checkpoint', 'relay_freshen'], '直接队友拿 checkpoint/freshen');
  // depth≥2：普通子代理
  const calls = [];
  const sections = [];
  const deep = makeAgent({ origin: 'subagent', parentSession: 'session-parent', delegationDepth: 2 }, calls, sections);
  await listener.listener({ agent: deep });
  assert.deepEqual(calls, WORKER_DENY, '普通子代理裁 lead-only + relay_phase + status/doc + ask_user');
  assert.ok(!calls.includes('bash'), '不裁 Router 执行类工具');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:phase'], '普通子代理只注入 worker 影子');
  assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT);
});

test('fail-open：单个工具名未注册时其余仍裁、监听器不抛（不阻断会话创建）', async () => {
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  const calls = [];
  await listener.listener({ agent: makeAgent({}, calls, [], { restrictThrows: new Set(['pwsh']) }) });
  assert.deepEqual(calls, ['bash', 'write', 'edit'], '未知工具名跳过，其余仍裁');
  // inject 本身失败（tools/systemPrompt 任一）→ warn 后跳过，不抛
  const throwing = makeAgent({}, [], [], { injectThrows: true });
  await assert.doesNotReject(async () => listener.listener({ agent: throwing }), 'inject 失败不得让 agent/created 抛错');
  assert.ok(f.warns.some((line) => line.includes('router restrict skipped')), 'restrict 失败应 warn 记录');
  // v0.14 P1：root 无角色影子段，protocol seam 不再有每-agent 注入，故无 protocol skipped warn。
  // 全部名字都失败 ≠ 平台缺单个工具：必须 warn，不能静默 fail-open
  await listener.listener({ agent: makeAgent({}, [], [], { restrictThrows: new Set(['bash', 'pwsh', 'write', 'edit']) }) });
  assert.ok(f.warns.some((line) => line.includes('no tools restricted')), '全部 restrict 失败应 warn');
  // agent.ctx 缺失（非常规 composition）：warn 后跳过，不抛
  await assert.doesNotReject(async () => listener.listener({ agent: { session: { header: {} } } }), 'ctx 缺失不得抛');
  assert.ok(f.warns.some((line) => line.includes('agent.ctx unavailable')), 'ctx 缺失应 warn');
});

test('v0.10.0 退役 config.routerMode 被忽略（无 warn、不改变装配）；任何值 root 都裁', async () => {
  for (const value of [false, 'true', 1, undefined, null]) {
    const f = fakeCtx();
    apply(f.ctx, { routerMode: value });
    assert.ok(!f.sections.some((section) => section.name === 'context-relay:router'), '退役配置 ' + JSON.stringify(value) + ' 不应静态注入 router section（per-agent 安装）');
    assert.equal(f.warns.some((line) => /routerMode/.test(line)), false, '退役配置不再有专用 warn');
    const listener = agentListener(f);
    assert.ok(listener !== undefined, 'per-agent 监听器始终注册');
    const calls = [];
    const sections = [];
    await listener.listener({ agent: makeAgent({}, calls, sections) });
    assert.deepEqual(calls, [...ROUTER_DENY_TOOLS], '单一模式 root 恒裁（退役配置不影响）');
    assert.deepEqual(sections, [], 'root 恒无角色影子段');
  }
});

test('v0.9.0 单一模式：live settings 里残留的退役键不影响装配（恒裁），清理设置前后一致', async () => {
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
  assert.deepEqual(sections, [], '清理后 root 仍无角色影子段');
});

test('v0.9.0 单一模式：所有新 root 都 seed compress（不覆盖显式值；非 root 不种；fail-open）', async () => {
  // 面板状态是进程级单例 + 持久化：固定到临时 panel.json，避免读写真实 home 数据。
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-router-panel-')), 'panel.json') });
  try {
    // 单一模式：root 无显式面板 → 种 defaultOperation='compress'
    const long = fakeCtx();
    apply(long.ctx, {});
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

    // 退役自决字段残留：不再算显式记录 → 新 root 种子照常写 compress（写入本身被白名单丢弃）。
    updatePanelState('session-long-seed-stale-retired', { autoChoose: true, autoDecision: { operation: 'compress', at: 1 }, defaultOperation: 'compress-then-handoff' });
    await longListener.listener({ agent: makeAgent({}, [], [], { sessionId: 'session-long-seed-stale-retired' }) });
    assert.equal(panelStateOf('session-long-seed-stale-retired').defaultOperation, 'compress', '退役档残留被归一后照常 seed compress');

    // 非 root（队友/子代理）不种：worker 会话保持未设置
    await longListener.listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 1 }, [], [], { sessionId: 'session-long-seed-worker' }) });
    assert.equal(panelStateOf('session-long-seed-worker').defaultOperation, null, '非 root 不种');

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
    assert.deepEqual(calls, WORKER_DENY, '普通子代理应裁 lead-only + phase + status/doc + ask_user（' + item.label + '）');
    assert.deepEqual(sections.map((section) => section.name), ['context-relay:phase'], '影子协议照装（' + item.label + '）');
    assert.equal(sections[0].text, WORKER_PROTOCOL_TEXT, '影子文本不变（' + item.label + '）');
  }
});

test('v0.2.17 D：队友只裁 organize/handoff（relay_phase 保留、装紧凑协议）；root 恒裁并装 Router', async () => {
  const f = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate', name: 'worker' }) } });
  apply(f.ctx, {});
  const calls = [];
  const sections = [];
  await agentListener(f).listener({ agent: makeAgent({ origin: 'subagent', delegationDepth: 1 }, calls, sections) });
  assert.deepEqual(calls, TEAMMATE_DENY, '队友裁 lead-only + doc + ask_user，phase 保留');
  assert.ok(!calls.includes('relay_phase'), '队友保留 relay_phase（分相/请示逻辑在执行层）');
  assert.equal(sections[0]?.text, TEAMMATE_PROTOCOL_TEXT, '队友装紧凑队友协议');
  // root：恒裁 Router deny 清单 + 装 Router/团队段——relay_phase 对所有身份可见
  const g = fakeCtx({ agentTeams: { tryMembership: () => ({ role: 'teammate' }) } });
  apply(g.ctx, {});
  const rootCalls = [];
  const rootSections = [];
  await agentListener(g).listener({ agent: makeAgent({}, rootCalls, rootSections) });
  assert.deepEqual(rootCalls, [...ROUTER_DENY_TOOLS], 'root 恒裁 Router deny 清单');
  assert.deepEqual(rootSections, [], 'root 无角色影子段');
});


test('v0.7.1 创建瞬间架构师识别：pending 标记认领（不依赖 subagents 服务），消费后下一个 depth=1 是普通队友', async () => {
  clearSharedMemory();
  const f = fakeCtx();
  apply(f.ctx, {});
  const listener = agentListener(f);
  // 模拟 relay_architect：spawn 前登记 pending（rc.2 的 agent/created 早于 subagents.resident 登记）。
  markPendingArchitect('session-lead');
  const calls = [];
  const sections = [];
  const architect = makeAgent({ origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 }, calls, sections);
  await listener.listener({ agent: architect });
  assert.deepEqual(calls, ARCHITECT_DENY, '架构师裁 lead-only + relay_phase + ask_user');
  assert.deepEqual(architect.registered, ['relay_checkpoint'], '架构师只拿 checkpoint，不拿 freshen');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:phase']);
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
  apply(f.ctx, {});
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
  assert.deepEqual(calls, [...LEAD_ONLY_TOOLS, ...SUBAGENT_STATUS_DENY, ...SUBAGENT_DOC_LINT_DENY, ...SUBAGENT_ASK_USER_DENY], 'relay_phase 未注册 → 跳过，其余仍裁');
  assert.ok(f.warns.some((line) => line.includes('subagent restrict: no tools restricted')), 'D 全部失败应 warn（不静默）');
  assert.deepEqual(sections.map((section) => section.name), ['context-relay:phase'], '影子协议不受 D 失败影响');
  // agent.ctx 缺失：两段 restrict 均只 warn、不抛（不阻断会话创建）
  await assert.doesNotReject(async () => agentListener(f).listener({ agent: { session: { header: { origin: 'subagent', delegationDepth: 2 } } } }));
  assert.ok(f.warns.some((line) => line.includes('subagent restrict skipped: agent.ctx unavailable')), 'ctx 缺失时 D 也 fail-open + warn');
});
// ── v0.6.4 专职架构师协议资产 ─────────────────────────────────────────
test('v0.6.4 专职架构师协议资产：固定队友名 + Lead/架构师两段预算与硬约束', () => {
  assert.equal(ARCHITECT_NAME, 'architect');
  assert.ok(ARCHITECT_LEAD_PROTOCOL_TEXT.length <= 900, 'ARCHITECT_LEAD 超预算: ' + ARCHITECT_LEAD_PROTOCOL_TEXT.length);
  assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.length <= 850, 'ARCHITECT_WORKER 超预算: ' + ARCHITECT_WORKER_PROTOCOL_TEXT.length);
  for (const phrase of ['默认值跟随「模型」选择器', '已选过则沿用', '不拒绝', 'handoff 继承', '专职架构师', '与用户对齐需求', '工程实现路线设计交给', 'relay_architect', '固定 lineage', '工程实现文档', '待决策', '与用户敲定', '低上下文', '新任务到达', '它自己不清空']) {
    assert.ok(ARCHITECT_LEAD_PROTOCOL_TEXT.includes(phrase), 'ARCHITECT_LEAD 缺短语: ' + phrase);
  }
  // 0.14.0-dev W1 新契约：架构师只写 checkpoint，清空由 Lead 用 relay_architect({mode:'fresh'}) 新开代；
  // 架构师没有 relay_freshen，不再要求它自己 freshen。
  for (const phrase of ['低上下文', '只读必须的上下文', '.scratch/context-relay/architecture/', '待决策', '报 Lead', 'relay_checkpoint', '不要自行 freshen', '只写 checkpoint', "relay_architect({mode:'fresh'", '不改产品代码', '**设计门材料**', 'design_gate{path,user_approved:true,ask_ref', '未确认只交付文档、不开工', '验收默认最小必要', '重型验证须用户明确授权']) {
    assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.includes(phrase), 'ARCHITECT_WORKER 缺短语: ' + phrase);
  }
  assert.ok(!ARCHITECT_WORKER_PROTOCOL_TEXT.includes('relay_freshen({reset:true'), '架构师不执行 freshen（清空由 Lead 走 relay_architect fresh）');
  assert.ok(!ARCHITECT_WORKER_PROTOCOL_TEXT.includes('你是 relay 模式的 Lead'));
});

test('w1 设计深度模板：T0/T1/T2 分层 + 七段 ≤3 页 + 提案 ≤5 进 SKILL，doc_lint 只 advisory', () => {
  // v0.14 P1：设计深度模板属于 L2 用法，移到 SKILL；常驻协议只保留 design_gate 形状。
  for (const phrase of ['ask_ref', 'not_doing', 'design_gate{path,user_approved:true,ask_ref,not_doing}']) {
    assert.ok(PROTOCOL_TEXT.includes(phrase), 'PROTOCOL 缺 design_gate 形状: ' + phrase);
  }
  assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.includes('七段 ≤3 页'), 'ARCHITECT_WORKER 缺设计深度');
  assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.includes('提案 ≤5'), 'ARCHITECT_WORKER 缺提案上限');
  const skill = readFileSync(new URL('../skills/context-relay/SKILL.md', import.meta.url), 'utf8');
  for (const phrase of ['设计深度模板', 'T0 文档/琐碎', 'T1 局部代码', 'T2 高风险', 'ask_ref', 'not_doing', '七段 ≤3 页', '提案 ≤5']) {
    assert.ok(skill.includes(phrase), 'SKILL 缺设计深度模板: ' + phrase);
  }
});

test('v0.14 P1 返修回归：redline/phase 边界、六项 must-fix 与 SKILL 章节落点', () => {
  // 两段 order：phase 10150（角色影子覆盖）+ redline 10199（system 最末）。
  const f = fakeCtx();
  apply(f.ctx, {});
  const phase = f.sections.find((section) => section.name === 'context-relay:phase');
  const redline = f.sections.find((section) => section.name === 'context-relay:redline');
  assert.equal(phase.order, 10150);
  assert.equal(redline.order, 10199, 'redline 必须在 system 最末（10199）');
  const ph = sectionText(phase);
  const red = sectionText(redline);
  // must-fix 1：T2 设计门 + T0/T1 reopen 免用户确认（与 tools.js 的 risk.tier 判定对齐）。
  assert.match(ph, /T2 首次进 build 须带 design_gate/);
  assert.match(ph, /T0[^\n]*reopen 用户确认/);
  assert.match(ph, /T1[^\n]*reopen 用户确认/);
  // must-fix 3：安全禁令回写协议（SKILL 不注入模型，不能只写在 SKILL）。
  for (const phrase of ['不自行裁决 P0', '不代人类回答偏好', "handoffApproval='off'", '不自行打开面板自动授权']) {
    assert.ok(red.includes(phrase), 'REDLINE 缺安全禁令: ' + phrase);
  }
  // must-fix 4：交接纪律（旧会话不残留工作 / skipped 语义 / progress 持有会话）。
  for (const phrase of ['status.next_actions/blocked', '旧会话不再开新活', 'skipped=未检查/不适用', 'progress.md 头「持有会话」', '先写好文档再交接']) {
    assert.ok(ph.includes(phrase), 'PHASE 缺交接纪律: ' + phrase);
  }
  // must-fix 5：丢失硬规则回归。
  for (const phrase of ['每个 phase 先 relay_status', '不进分点/预算闸门', 'authorizeNext（一次性，成功后消费）', '起点', 'doc_lint', 'blocked 必须写 blocked 原因', 'owner 写队友名', 'depends 只引已有 id']) {
    assert.ok((ph + red).includes(phrase), '协议缺硬规则: ' + phrase);
  }
  // must-fix 6：SKILL 体积只记录（R1），机制落点靠章节/短语断言。
  const skill = readFileSync(new URL('../skills/context-relay/SKILL.md', import.meta.url), 'utf8');
  console.log('[diagnostic] SKILL bytes=' + Buffer.byteLength(skill, 'utf8'));
  for (const phrase of ['## doc_lint', '## 文档索引（docs v2）', '## 事件注入', 'retire/adopt/maintain']) {
    assert.ok(skill.includes(phrase), 'SKILL 缺章节/机制: ' + phrase);
  }
  assert.doesNotMatch(skill, /不重复硬门/, 'SKILL 不得再声称不重复硬门（它确实摘要了硬门）');
});

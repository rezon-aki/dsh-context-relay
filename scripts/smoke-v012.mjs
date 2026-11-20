#!/usr/bin/env node
/**
 * dsh-context-relay v0.12 / v0.13-dev 重启后冒烟（真机验证的可执行部分）。
 *
 * 设计口径：
 *   - 只走工具面：所有断言都从工具定义 execute()（与宿主注册同一个 createRelayTools /
 *     createTeamTools / createRelayHandoffTool 工厂）取得结果；不 import risk/work-items/docs
 *     等内部实现函数来「自证」。参数先按工具 parameters 做 schema 校验（required /
 *     additionalProperties / enum / anyOf），保证只用模型能看到的字段。
 *   - 默认 dry-run：不写仓库、不写真实台账/metrics；只读检查在 OS 临时目录构造最小
 *     fixture（不触碰 .scratch/context-relay）。--apply 才跑写路径，且同样隔离在临时目录，
 *     结束后删除；可用 --keep 保留现场。
 *   - 不重启宿主、不调模型、不建真实会话：需要真实宿主的项见 docs/runbook-v012.md 的人工清单。
 *
 * 用法：
 *   node scripts/smoke-v012.mjs                 # dry-run（只读）
 *   node scripts/smoke-v012.mjs --apply         # 只读 + 临时目录写路径
 *   node scripts/smoke-v012.mjs --apply --keep  # 保留临时目录便于排障
 *   node scripts/smoke-v012.mjs --no-live       # 跳过运行中宿主的 HTTP 路由探测
 *   node scripts/smoke-v012.mjs --live-url http://127.0.0.1:3080
 *
 * 退出码：有 FAIL 为 1；全 PASS/SKIP 为 0。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRelayTools } from '../lib/agent/tools.js';
import { createRelayHandoffTool } from '../lib/agent/handoff.js';
import { createTeamTools } from '../lib/agent/team-tools.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';

const NL = String.fromCharCode(10);
const APPLY = process.argv.includes('--apply');
const KEEP = process.argv.includes('--keep');
const NO_LIVE = process.argv.includes('--no-live');
const VERBOSE = process.argv.includes('--verbose');
const liveUrlArg = process.argv.indexOf('--live-url');
const LIVE_URL = liveUrlArg >= 0 && process.argv[liveUrlArg + 1] !== undefined
  ? process.argv[liveUrlArg + 1].replace(/\/+$/, '')
  : (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
const THRESHOLDS = Object.freeze({ warnRatio: 0.3, organizeRatio: 0.35, relayRatio: 0.45 });
let seq = 0;
const sid = (name) => 'smoke-' + process.pid + '-' + (++seq) + '-' + name;

// ── 输出 ────────────────────────────────────────────────────────────────────
const results = [];
const SKIP = Symbol('skip');
const skip = (reason) => ({ [SKIP]: true, reason });
const pad = (text, width) => String(text) + ' '.repeat(Math.max(0, width - String(text).length));
function emit(result) {
  results.push(result);
  const tag = result.status === 'PASS' ? '[PASS]' : result.status === 'FAIL' ? '[FAIL]' : '[SKIP]';
  console.log(tag + ' ' + pad(result.id, 26) + result.title);
  if (result.detail !== '' && (result.status !== 'PASS' || VERBOSE)) console.log('       ' + result.detail.replace(/\n/g, '\n       '));
}
async function check(id, title, fn, { mode = 'read' } = {}) {
  if (mode === 'write' && !APPLY) {
    return emit({ id, title, status: 'SKIP', detail: '写检查：需 --apply（默认 dry-run 不写台账/metrics）' });
  }
  try {
    const detail = await fn();
    if (detail !== null && typeof detail === 'object' && detail[SKIP] === true) {
      return emit({ id, title, status: 'SKIP', detail: detail.reason });
    }
    return emit({ id, title, status: 'PASS', detail: detail ?? '' });
  } catch (error) {
    const message = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, VERBOSE ? 20 : 4).join('\n');
    return emit({ id, title, status: 'FAIL', detail: message });
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };

// ── 临时工作区 ──────────────────────────────────────────────────────────────
const kept = [];
function withWorkspace(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
  clearPanelMemory();
  configurePanelStore({ panelPath: join(cwd, 'panel.json') });
  mkdirSync(join(cwd, '.scratch', 'context-relay'), { recursive: true });
  return Promise.resolve()
    .then(() => fn(cwd))
    .finally(() => {
      if (KEEP) { kept.push(cwd); return; }
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
    });
}

// ── schema 校验（只用工具 parameters 允许的字段）─────────────────────────────
function schemaErrors(schema, value, path = 'args') {
  const errors = [];
  if (schema === null || typeof schema !== 'object') return errors;
  if (schema.anyOf !== undefined && Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.some((branch) => {
      const probe = [];
      validateSchema(branch, value, path, probe);
      return probe.length === 0;
    });
    if (!branches) errors.push(path + ' 不满足 anyOf 的任一分支');
  }
  validateSchema(schema, value, path, errors);
  return errors;
}
function validateSchema(schema, value, path, errors) {
  if (value === undefined || schema === null || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { errors.push(path + ' 应为 object'); return; }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (value[key] === undefined) errors.push(path + '.' + key + ' 为必填');
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(path + '.' + key + ' 不在 schema 允许字段内');
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) validateSchema(child, value[key], path + '.' + key, errors);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { errors.push(path + ' 应为 array'); return; }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(path + ' 超过 maxItems=' + schema.maxItems);
    if (schema.items !== undefined) value.forEach((item, index) => validateSchema(schema.items, item, path + '[' + index + ']', errors));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') { errors.push(path + ' 应为 string'); return; }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(path + ' 不在 enum 内');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(path + ' 应为 ' + schema.type); return; }
    if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(path + ' 应为整数');
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(path + ' 小于 minimum');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(path + ' 应为 boolean');
  }
}
function toolMap(tools) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}
function callTool(tool, args, exec) {
  const errors = schemaErrors(tool.parameters, args);
  if (errors.length > 0) throw new Error(tool.name + ' 参数不在 schema 允许范围：' + errors.join('；'));
  return tool.execute(args, exec);
}

// ── 工具运行时（与宿主装配同形的最小替身）──────────────────────────────────
function runtimeFor({ cwd, docs, projection, pressure, workItems } = {}) {
  const services = {
    sessionProjections: {
      stateOf: () => projection,
      snapshot: () => ({ values: { contextPressure: pressure } }),
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) { return services[name]; },
    effect(fn) { return typeof fn === 'function' ? fn() : () => {}; },
    on() { return () => {}; },
  };
  return {
    ctx,
    currentThresholds: () => THRESHOLDS,
    currentCapacityRatio: () => 0.55,
    workItems: workItems ?? { enabled: true, gate: 'strict', phaseGate: 'strict', max: 30 },
    docs,
    delegation: { gate: 'warn' },
    reopenGate: 'strict',
    injectBrief: false,
  };
}
function agentFor(cwd, id, extraHeader = {}) {
  return { session: { id, header: { cwd, ...extraHeader }, seq: 0, snapshotEvents: () => [] }, options: {} };
}
function execFor(cwd, id) {
  return { agent: agentFor(cwd, id) };
}

// ── fixture ────────────────────────────────────────────────────────────────
function fixtureDoc(cwd, rel, title, extra = []) {
  const path = join(cwd, '.scratch', 'context-relay', rel);
  mkdirSync(dirname(path), { recursive: true });
  const lines = ['---', 'title: ' + title, 'role: ' + title + ' 作用', 'layer: L2', 'when: 需要 ' + title + ' 时', ...extra, '---', '# ' + title];
  writeFileSync(path, lines.join(NL) + NL);
}
function seedDocs(cwd) {
  const r = join(cwd, '.scratch', 'context-relay');
  mkdirSync(r, { recursive: true });
  // progress.key_docs 作为 pin fallback：A/B/C 都能验证「只单列 pin」。
  writeFileSync(join(r, 'progress.md'), ['# 进度', '', '<!-- relay-progress:json', JSON.stringify({ key_docs: ['architecture/design.md — 设计稿'] }), '-->', ''].join(NL));
  writeFileSync(join(r, 'lessons.md'), '# 经验' + NL);
  fixtureDoc(cwd, 'docs/note.md', '说明');
  fixtureDoc(cwd, 'docs/with-facts.md', '事实', ['constraints: 只读；不改 schema', 'contracts: relay_doc 只读']);
  fixtureDoc(cwd, 'architecture/design.md', '设计');
  fixtureDoc(cwd, 'decisions/d-1.md', '决策一');
  writeFileSync(join(r, 'decisions.md'), '---' + NL + 'title: 决策' + NL + 'role: 决策 作用' + NL + 'layer: L2' + NL + 'when: 需要 决策 时' + NL + '---' + NL + '# 决策' + NL);
  mkdirSync(join(r, 'reports'), { recursive: true });
  writeFileSync(join(r, 'reports', 'task-1.md'), '# 回执' + NL + '细节' + NL);
  for (let i = 0; i < 4; i += 1) writeFileSync(join(r, 'handoff-' + i + '.md'), '# 交接 ' + i + NL);
  for (let i = 0; i < 2; i += 1) writeFileSync(join(r, 'phase-build-' + i + '.md'), '# brief ' + i + NL);
}
const docsRuntime = (docs) => ({ docs });

// ── 文档索引检查 ────────────────────────────────────────────────────────────
async function docsIndexResult(cwd, docs, sessionName) {
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, docs })));
  const doc = tools.get('relay_doc');
  assert(doc !== undefined, 'relay_doc 未注册');
  return callTool(doc, { action: 'index' }, execFor(cwd, sid(sessionName)));
}

// ── confirmKey 流程（只走 relay_phase / relay_work_items 的 schema 字段）────
function schemaSafeItem(item) {
  const out = { id: item.id, title: item.title, status: item.status };
  for (const key of ['owner', 'next', 'blocked', 'acceptance', 'evidence', 'depends', 'phase', 'officialTaskId']) {
    const value = item[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ── handoff harness（与宿主服务同形；不 import 内部派生函数）────────────────
function handoffHarness({ cwd, accept }) {
  delete globalThis[Symbol.for('dsh-context-relay.handoff.recovery')];
  clearPanelMemory();
  configurePanelStore({ panelPath: join(cwd, 'panel.json') });
  const log = [];
  const calls = [];
  const atDispatch = {};
  const handoffGlob = () => readdirSync(join(cwd, '.scratch', 'context-relay')).filter((name) => /^handoff-\d+\.md$/.test(name));
  const session = { id: 'old-' + process.pid + '-' + (++seq), header: { cwd }, snapshotEvents: () => [], requestHeader: () => undefined };
  const inbox = { nextTurn: [] };
  const child = {
    session: { id: 'new-' + process.pid + '-' + (++seq), header: { cwd }, requestHeader: () => undefined, snapshotEvents: () => log },
    inbox,
    followup(message) {
      calls.push('dispatch');
      atDispatch.handoffFile = handoffGlob().length > 0;
      atDispatch.progress = existsSync(join(cwd, '.scratch', 'context-relay', 'progress.md'));
      atDispatch.text = message?.content?.[0]?.text ?? '';
      if (accept) {
        inbox.nextTurn.push(message);
        log.push({ type: 'agent/inbox/spliced', seq: 1, data: { inserted: [message] } });
      }
    },
    cancel() { calls.push('cancel'); },
  };
  const services = {
    agents: { async create() { calls.push('create'); return { agent: child, async dispose() { calls.push('dispose'); } }; }, get: () => child },
    agentPresets: { async mount() {} },
    jobs: { list: () => [], kill() {} },
    workspaceRegistry: { async resolveByPath() { return { id: 'ws', async attachSession() {} }; } },
  };
  const ctx = { get: (name) => services[name], logger: { info() {}, warn() {} }, on() { return () => {}; }, effect: (fn) => fn() };
  const tool = createRelayHandoffTool({
    ctx,
    currentThresholds: () => THRESHOLDS,
    presetId: 'relay-long',
    singlePresetId: 'relay-long',
    inheritOnHandoff: false,
    riskTierOf: () => 'T0',
    workItems: { enabled: false },
  });
  return { cwd, tool, session, calls, inbox, atDispatch };
}
function metricsEventsOf(cwd) {
  const dir = join(cwd, '.scratch', 'context-relay', 'metrics');
  if (!existsSync(dir)) return [];
  const events = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.ndjson'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split(NL)) {
      if (line.trim() === '') continue;
      try { events.push(JSON.parse(line)); } catch { /* 坏行忽略 */ }
    }
  }
  return events;
}

// ── team 面 harness ─────────────────────────────────────────────────────────
function teamHarness(cwd) {
  clearPanelMemory();
  configurePanelStore({ panelPath: join(cwd, 'panel.json') });
  const lead = agentFor(cwd, 'lead-' + process.pid + '-' + (++seq));
  const teammateName = 'w1';
  const teammate = agentFor(cwd, 'tm-' + process.pid + '-' + (++seq), { delegationDepth: 1, parentSession: lead.session.id });
  const services = {
    subagents: {
      rootOf: () => lead,
      namesOf: () => ({ self: teammateName, parent: 'lead' }),
      listDescendants: () => [],
    },
  };
  const ctx = { logger: { info() {}, warn() {} }, get: (name) => services[name], effect: (fn) => fn(), on() { return () => {}; } };
  const built = createTeamTools({
    ctx,
    currentThresholds: () => THRESHOLDS,
    workItems: { enabled: false },
    allowSpawn: false,
  });
  return { lead, teammate, ...built };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log('dsh-context-relay v0.12 / v0.13-dev 重启后冒烟');
console.log('模式：' + (APPLY ? 'apply（只读 + 临时目录写路径）' : 'dry-run（只读；不写台账/metrics）') + ' · 仓库：' + process.cwd());
console.log('说明：只走工具 execute() 与工具 parameters schema；写路径全部隔离在 OS 临时目录。' + NL);

// A. relay_status：docs 块 + delegation 字段
await check('status.docs', 'relay_status 返回 docs 埋点块（干净会话 available=false）', async () => withWorkspace(async (cwd) => {
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, projection: { phase: 'discover' } })));
  const status = await callTool(tools.get('relay_status'), {}, execFor(cwd, sid('status-docs')));
  assert(status.docs !== null && typeof status.docs === 'object', '缺少 docs 块');
  assert(typeof status.docs.file === 'string' && status.docs.file.includes('metrics/'), 'docs.file 形状不对');
  assert(status.docs.available === false, '干净工作区不应有可用的 metrics');
  assert(status.docs.injects === 0, 'injects 应为 0');
  return 'available=false · file=' + status.docs.file + ' · injects=0';
}));

await check('status.delegation', 'relay_status 返回 delegation 度量（投影可用）', async () => withWorkspace(async (cwd) => {
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, projection: { phase: 'build', toolCalls: 10, executionCalls: 4, dispatchCalls: 2, collectCalls: 1 } })));
  const status = await callTool(tools.get('relay_status'), {}, execFor(cwd, sid('status-delegation')));
  const d = status.delegation;
  assert(d !== null && typeof d === 'object', '缺少 delegation 字段');
  assert(d.execRatio === 0.4, 'execRatio 应为 4/10=0.4，实际 ' + d.execRatio);
  assert(d.calls?.exec === 4 && d.calls?.total === 10, 'calls 计数不对：' + JSON.stringify(d.calls));
  assert(d.dispatchCount === 2 && d.collectCount === 1, 'dispatch/collect 计数不对');
  assert(d.idleWorkers === null, '无团队服务时 idleWorkers 应为 null（不猜 0）');
  assert(d.basis === 'projection', 'basis 应为 projection');
  assert(typeof d.advice === 'string' && d.advice.length > 0, '缺少 advice');
  assert(status.text.includes('delegation:'), 'status.text 缺 delegation 行');
  return 'execRatio=0.4 · dispatch=2 · collect=1 · idleWorkers=null · basis=projection';
}));

// B. 文档索引 A/B/C + 三个回滚开关
await check('docs.A', 'relay_doc index：A 层在役/带决策单列 + 目录折叠 + raw 不单列', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const r = await docsIndexResult(cwd, { metrics: false }, 'docs-a');
  assert(r.level === 'A', '默认应为 A 层，实际 ' + r.level);
  assert(r.text.includes('### 在役（先读）') && r.text.includes('### 带决策'), '缺少在役/带决策分组');
  assert(r.text.includes('### 折叠（按目录，展开即取全）'), '缺少折叠分组');
  assert(r.text.includes('- \`architecture/design.md\`'), 'progress.key_docs pin 未单列');
  assert(r.text.includes('docs/with-facts.md') && r.text.includes('!2'), '带决策语义标记缺失');
  assert(r.text.includes('relay_doc list prefix=docs'), '折叠组缺展开命令');
  assert(!/- \x60reports\/task-1\.md\x60/m.test(r.text), 'raw/reports 不应单列');
  assert(!/- \x60docs\/note\.md\x60/m.test(r.text), '普通 L2 应收进目录组');
  assert(r.groups.length >= 3 && r.groups.every((group) => group.command !== ''), 'groups 形状/命令不完整（实际 ' + r.groups.length + ' 组）');
  return 'level=A shown=' + r.shown + ' omitted=' + r.omitted + ' groups=' + r.groups.length;
}));

await check('docs.B', 'relay_doc index：docs.width 触发 B（只单列 pin）', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const r = await docsIndexResult(cwd, { width: 200, metrics: false }, 'docs-b');
  assert(r.level === 'B', 'width=200 应触发 B（总单列宽度超限，pin 本身不超），实际 ' + r.level);
  assert(!r.text.includes('### 带决策'), 'B 层不应再有带决策分组');
  assert(r.text.includes('- \`architecture/design.md\`'), 'B 层应只保留 pin 单列');
  assert(r.shown === 1, 'B 层 singles 应只剩 pin（1 条），实际 ' + r.shown);
  return 'level=B shown=1（仅 pin）';
}));

await check('docs.C', 'relay_doc index：docs.maxGroups 触发 C（一行计数 + 展开命令）', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const r = await docsIndexResult(cwd, { maxGroups: 0, metrics: false }, 'docs-c');
  assert(r.level === 'C', 'maxGroups=0 应触发 C，实际 ' + r.level);
  assert(/其余 \d+ 份文档 \/ \d+ 个目录已折叠/.test(r.text), 'C 层缺折叠计数行');
  assert(r.text.includes('relay_doc list include=all'), 'C 层折叠行缺展开命令');
  assert(r.text.includes('- \`architecture/design.md\`'), 'C 层仍应展示 pin');
  return 'level=C · ' + (r.text.match(/其余 \d+ 份文档 \/ \d+ 个目录已折叠/) ?? [''])[0];
}));

await check('docs.layout=flat', 'relay_doc index：docs.layout=flat 关掉 W/G 自动层级', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const r = await docsIndexResult(cwd, { layout: false, width: 1, maxGroups: 0, metrics: false }, 'docs-flat');
  assert(r.level === 'A', 'layout=flat 时 width/maxGroups 不应再触发层级，实际 ' + r.level);
  assert(r.text.includes('### 带决策'), 'layout=flat 应保持 A 层分组');
  return 'level=A（width=1 + maxGroups=0 均被忽略）';
}));

await check('docs.select=legacy', 'relay_doc index：docs.select=legacy 真回滚 v0.11 渲染', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const r = await docsIndexResult(cwd, { select: 'legacy', metrics: false }, 'docs-legacy');
  assert(r.level === 'legacy', '应为 legacy，实际 ' + r.level);
  assert(r.text.includes('### 先读（L1）') && r.text.includes('### 按需（L2）'), 'legacy 缺少 L1/L2 分组');
  assert(!r.text.includes('### 在役（先读）') && !r.text.includes('### 带决策'), 'legacy 不应有 v0.12 分组');
  assert(r.text.includes('docs/note.md'), 'legacy 应把普通 L2 也单列');
  assert(r.text.includes('另有 ') && r.text.includes('历史产物未入索引'), 'legacy 缺历史产物尾行');
  return 'level=legacy · L1/L2 全单列 + 历史尾行';
}));

await check('docs.metrics=off', 'relay_doc index / relay_status：docs.metrics=off 不写 events、不带 docs 块', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, docs: { metrics: false } })));
  const doc = tools.get('relay_doc');
  const r = await callTool(doc, { action: 'index' }, execFor(cwd, sid('docs-metrics-off')));
  assert(r.level === 'A', '索引本身仍应可用');
  assert(!existsSync(join(cwd, '.scratch', 'context-relay', 'metrics')), 'metrics=off 不应创建 metrics 目录/文件');
  const status = await callTool(tools.get('relay_status'), {}, execFor(cwd, sid('docs-metrics-off')));
  assert(!Object.hasOwn(status, 'docs'), 'metrics=off 时 relay_status 不应带 docs 块');
  return '无 metrics 目录 · relay_status 无 docs 块';
}));

// C. relay_phase 三个拒绝路径（零副作用）
await check('phase.T2-design-gate', 'relay_phase：T2 首次进 build 缺 ask_ref/not_doing 零副作用拒绝', async () => withWorkspace(async (cwd) => {
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, projection: { phase: 'discover' } })));
  const phase = tools.get('relay_phase');
  let error;
  try {
    await callTool(phase, {
      phase: 'build',
      risk: { tier: 'T2', reason: '冒烟：公开面', paths: ['lib/agent/tools.js'] },
      design_gate: { path: '.scratch/context-relay/architecture/design.md', user_approved: true },
    }, execFor(cwd, sid('phase-design')));
  } catch (caught) { error = caught; }
  assert(error !== undefined, '应拒绝旧式 design_gate');
  assert(error.code === 'design gate', '拒绝 code 应为 design gate，实际 ' + error.code);
  assert(error.human !== undefined && ['conclusion', 'impact', 'action'].every((key) => typeof error.human[key] === 'string' && error.human[key] !== '') && Array.isArray(error.human.evidence) && error.human.evidence.length > 0, '拒绝不是四段式 human');
  assert(!existsSync(join(cwd, '.scratch', 'context-relay', 'work-items')), '拒绝路径不应写台账');
  return 'code=design gate · human 四段完整 · 未写台账';
}));

await check('phase.ship-user-gate', 'relay_phase：verify→ship 缺 user_gate 零副作用拒绝', async () => withWorkspace(async (cwd) => {
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, projection: { phase: 'verify' } })));
  let error;
  try {
    await callTool(tools.get('relay_phase'), {
      phase: 'ship',
      risk: { tier: 'T2', reason: '冒烟：验收', paths: ['lib/agent/tools.js'] },
    }, execFor(cwd, 'phase-ship'));
  } catch (caught) { error = caught; }
  assert(error !== undefined, '应拒绝缺 user_gate 的 ship');
  assert(error.code === 'user gate', '拒绝 code 应为 user gate，实际 ' + error.code);
  assert(!existsSync(join(cwd, '.scratch', 'context-relay', 'work-items')), '拒绝路径不应写台账');
  return 'code=user gate · 零副作用';
}));

await check('phase.warn-budget-plan', 'relay_phase：warn 档跨 phase 缺 budget_plan 零副作用拒绝', async () => withWorkspace(async (cwd) => {
  const tools = toolMap(createRelayTools(runtimeFor({
    cwd,
    projection: { phase: 'build' },
    pressure: { contextWindow: 1000, pressureTokens: 320 },
  })));
  let error;
  try {
    await callTool(tools.get('relay_phase'), {
      phase: 'verify',
      risk: { tier: 'T2', reason: '冒烟：warn 档', paths: ['lib/agent/tools.js'] },
    }, execFor(cwd, 'phase-budget'));
  } catch (caught) { error = caught; }
  assert(error !== undefined, 'warn 档缺 budget_plan 应拒绝');
  assert(error.code === 'budget plan', '拒绝 code 应为 budget plan，实际 ' + error.code);
  assert(!existsSync(join(cwd, '.scratch', 'context-relay', 'work-items')), '拒绝路径不应写台账');
  return 'band=warn · code=budget plan · 零副作用';
}));

// D. relay_handoff：审批拒绝 + 注入事件时点
await check('handoff.approval', 'relay_handoff：human_approved=false 零副作用拒绝', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const h = handoffHarness({ cwd, accept: true });
  const before = readdirSync(join(cwd, '.scratch', 'context-relay')).filter((name) => /^handoff-\d+\.md$/.test(name)).length;
  const result = await callTool(h.tool, { human_approved: false, status: { goal: '冒烟' } }, { agent: { session: h.session, options: {} } });
  assert(result.ok === false && result.code === 'human-approval-required', '应拒绝未审批的交接');
  assert(h.calls.length === 0, '拒绝路径不应建会话/发消息');
  const after = readdirSync(join(cwd, '.scratch', 'context-relay')).filter((name) => /^handoff-\d+\.md$/.test(name)).length;
  assert(after === before, '拒绝路径不应写 handoff 文件（before=' + before + ' after=' + after + '）');
  return 'code=human-approval-required · 无文件/会话副作用';
}));

await check('handoff.injection-timing', 'relay_handoff：注入只在验收成功后（失败无事件；成功 1 条 site=handoff）', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  // 失败验收：新会话未收下首条消息，不得写注入事件。
  const failed = handoffHarness({ cwd, accept: false });
  const failedResult = await callTool(failed.tool, { human_approved: true, status: { goal: '冒烟失败交接', next_actions: ['continue'] } }, { agent: { session: failed.session, options: {} } });
  assert(failedResult.ok === false && failedResult.code === 'takeover-unconfirmed', '未验收应返回 takeover-unconfirmed，实际 ' + failedResult.code);
  assert(metricsEventsOf(cwd).length === 0, '失败交接收尾不得写 docs 注入事件');
  assert(failed.inbox.nextTurn.length === 0, '失败交接不应把消息塞进新会话');
  // 全新目录做成功路径：首条消息注入前，handoff 文件与 progress 已落盘；事件只在验收后写。
  const okCwd = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
  try {
    clearPanelMemory();
    configurePanelStore({ panelPath: join(okCwd, 'panel.json') });
    mkdirSync(join(okCwd, '.scratch', 'context-relay'), { recursive: true });
    seedDocs(okCwd);
    const ok = handoffHarness({ cwd: okCwd, accept: true });
    const okResult = await callTool(ok.tool, { human_approved: true, status: { goal: '冒烟成功交接', next_actions: ['continue'] }, key_docs: ['progress.md'] }, { agent: { session: ok.session, options: {} } });
    assert(okResult.ok === true, '交接应成功：' + JSON.stringify(okResult.code ?? okResult.summary));
    assert(ok.atDispatch.handoffFile === true, '首条消息注入时 handoff 文件应已落盘');
    assert(ok.atDispatch.progress === true, '首条消息注入时 progress.md 应已存在');
    assert(ok.atDispatch.text.includes('文档索引') && ok.atDispatch.text.includes('完整交接单'), '首条消息应含文档索引与完整交接单位置');
    const events = metricsEventsOf(okCwd);
    const injects = events.filter((event) => event.type === 'inject');
    assert(injects.length === 1, '成功交接应写 1 条注入事件，实际 ' + injects.length);
    assert(injects[0].site === 'handoff', '注入事件 site 应为 handoff，实际 ' + injects[0].site);
  } finally {
    if (KEEP) kept.push(okCwd); else rmSync(okCwd, { recursive: true, force: true });
  }
  return '失败=0 事件 · 成功=1 条 site=handoff · 注入前文件已落盘';
}), { mode: 'write' });

// E. relay_work_items：confirmKey 二次确认复用
await check('workitems.confirmKey', 'relay_work_items：T1 自动确认 → auto+confirmKey 复用 → 内容/错 key 失效', async () => withWorkspace(async (cwd) => {
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, projection: { phase: 'discover' } })));
  const phase = tools.get('relay_phase');
  const work = tools.get('relay_work_items');
  const id = 'wi-' + process.pid + '-' + (++seq);
  const exec = execFor(cwd, id);
  const built = await callTool(phase, {
    phase: 'build',
    risk: { tier: 'T1', reason: '冒烟：文档条目', paths: ['docs/note.md'], lines: 3 },
    items: ['文档条目'],
  }, exec);
  assert(built !== undefined, 'T1 build 切换失败');
  const read1 = await callTool(work, {}, exec);
  assert(read1.ok === true && read1.items.length === 1, '台账应有 1 条 phase 分点');
  const openItem = schemaSafeItem(read1.items[0]);
  const done = await callTool(work, {
    rev: read1.rev,
    items: [openItem, { id: 'doc-a', title: '文档条目', status: 'done', evidence: ['docs/note.md:1'], phase: 'build' }],
  }, exec);
  assert(done.ok === true, 'T1 文档条目应自动确认：' + JSON.stringify(done.code ?? done.message));
  const confirmed = done.items.find((item) => item.id === 'doc-a');
  const stored = confirmed?.lead_confirm;
  assert(stored?.auto === 'T1', 'auto 应为 T1，实际 ' + stored?.auto);
  assert(/^[0-9a-f]{8,64}$/.test(stored?.confirmKey ?? ''), 'confirmKey 应为 8-64 hex');
  assert(stored?.no_drift === true && stored?.no_missing === true && stored?.no_regression === true, '自动确认应写三项 true');
  const keep = (items, exclude) => items.filter((item) => item.id !== exclude).map(schemaSafeItem);
  const reuse = await callTool(work, {
    rev: done.rev,
    items: [...keep(done.items, 'doc-a'), { id: 'doc-a', title: '文档条目', status: 'done', evidence: ['docs/note.md:1'], phase: 'build', lead_confirm: { auto: stored.auto, confirmKey: stored.confirmKey } }],
  }, exec);
  assert(reuse.ok === true, '同 key 重放应复用确认：' + JSON.stringify(reuse.code ?? reuse.message));
  const reused = reuse.items.find((item) => item.id === 'doc-a');
  assert(reused?.lead_confirm?.confirmKey === stored.confirmKey, '复用后 confirmKey 应保持');
  assert(reused?.lead_confirm?.no_drift === true && reused?.lead_confirm?.no_regression === true, '复用后应保留三项 true');
  assert(reuse.rev === done.rev + 1, '复用请求应正常递增 rev');
  const revAfterReuse = reuse.rev;
  const changed = await callTool(work, {
    rev: revAfterReuse,
    items: [...keep(reuse.items, 'doc-a'), { id: 'doc-a', title: '文档条目改了内容', status: 'done', evidence: ['docs/note.md:1'], phase: 'build', lead_confirm: { auto: stored.auto, confirmKey: stored.confirmKey } }],
  }, exec);
  assert(changed.ok === false && changed.code === 'done-gate', '内容指纹变化后旧 key 应失效（done-gate），实际 ' + changed.code);
  const wrong = await callTool(work, {
    rev: revAfterReuse,
    items: [...keep(reuse.items, 'doc-a'), { id: 'doc-a', title: '文档条目', status: 'done', evidence: ['docs/note.md:1'], phase: 'build', lead_confirm: { auto: stored.auto, confirmKey: 'deadbeefdeadbeef' } }],
  }, exec);
  assert(wrong.ok === false && wrong.code === 'done-gate', '错误 confirmKey 应被拒（done-gate），实际 ' + wrong.code);
  const after = await callTool(work, {}, exec);
  assert(after.rev === revAfterReuse, '拒绝路径不应改 rev');
  return 'auto=T1 · key=' + stored.confirmKey + ' · 复用 rev=' + reuse.rev + ' · 内容变更=done-gate · 错 key=done-gate';
}), { mode: 'write' });

// F. status docs 块在真实注入后可用（--apply）
await check('status.docs-after-index', 'relay_status：索引注入后 docs 块 available=true 且计数命中', async () => withWorkspace(async (cwd) => {
  seedDocs(cwd);
  const tools = toolMap(createRelayTools(runtimeFor({ cwd, projection: { phase: 'build' } })));
  const doc = tools.get('relay_doc');
  const sessionId = sid('status-after-index');
  const index = await callTool(doc, { action: 'index' }, execFor(cwd, sessionId));
  assert(index.level === 'A', '索引应正常渲染');
  const status = await callTool(tools.get('relay_status'), {}, execFor(cwd, sessionId));
  assert(status.docs?.available === true, '一次索引后 docs.available 应为 true');
  assert(status.docs.injects >= 1, 'docs.injects 应 >=1');
  assert(status.text.includes('docs: 注入 1'), 'status.text 应带 docs 计数行');
  return 'available=true · injects=' + status.docs.injects + ' · hits=' + status.docs.hits;
}), { mode: 'write' });

// G. team 面可用性：schema 在 + Lead 调用被拒（只读路径）
await check('team.tools', 'team 面：relay_checkpoint / relay_freshen 已注册且 Lead 调用被拒', async () => withWorkspace(async (cwd) => {
  const team = teamHarness(cwd);
  assert(team.teammateTools.map((tool) => tool.name).sort().join(',') === 'relay_checkpoint,relay_freshen', 'teammate 工具面不完整：' + team.teammateTools.map((tool) => tool.name));
  assert(team.leadTools.some((tool) => tool.name === 'relay_team_status'), 'Lead 工具面缺 relay_team_status');
  const checkpoint = team.teammateTools.find((tool) => tool.name === 'relay_checkpoint');
  const freshen = team.teammateTools.find((tool) => tool.name === 'relay_freshen');
  assert(checkpoint?.parameters?.required?.includes('one_line') === true, 'checkpoint schema 缺 one_line required');
  assert(freshen?.parameters?.properties?.reset?.type === 'boolean', 'freshen schema 缺 reset');
  const leadCheckpoint = await callTool(checkpoint, { one_line: 'lead 不应写' }, { agent: team.lead });
  assert(leadCheckpoint.ok === false && leadCheckpoint.code === 'teammate-only', 'Lead 调 checkpoint 应被拒');
  const leadFreshen = await callTool(freshen, { reset: true, brief: 'lead 不应 freshen' }, { agent: team.lead });
  assert(leadFreshen.ok === false && leadFreshen.code === 'teammate-only', 'Lead 调 freshen 应被拒');
  assert(!existsSync(join(cwd, '.scratch', 'context-relay', 'team')), '拒绝路径不应写 team 记录');
  return 'teammateTools=checkpoint,freshen · lead 调用=teammate-only · 零写入';
}));

await check('team.checkpoint-freshen', 'team 面：队友 checkpoint 可写、freshen reset 可排队', async () => withWorkspace(async (cwd) => {
  const team = teamHarness(cwd);
  const checkpoint = team.teammateTools.find((tool) => tool.name === 'relay_checkpoint');
  const freshen = team.teammateTools.find((tool) => tool.name === 'relay_freshen');
  const saved = await callTool(checkpoint, {
    one_line: '冒烟：team 面可用',
    done: ['checkpoint 可写'],
    evidence: ['scripts/smoke-v012.mjs'],
  }, { agent: team.teammate });
  assert(saved.ok === true && typeof saved.path === 'string', 'checkpoint 应写入成功');
  assert(existsSync(saved.path), 'checkpoint 文件不存在：' + saved.path);
  const text = readFileSync(saved.path, 'utf8');
  assert(text.includes('冒烟：team 面可用'), 'checkpoint 内容缺一行结论');
  const reset = await callTool(freshen, { reset: true, brief: '冒烟 reset：只读探测后继续' }, { agent: team.teammate });
  assert(reset.ok === true && reset.mode === 'wipe-scheduled', 'freshen reset 应排队，实际 ' + JSON.stringify(reset.code ?? reset.mode));
  assert(typeof reset.briefPath === 'string' && existsSync(reset.briefPath), 'reset brief 文件不存在');
  return 'checkpoint=' + saved.bytes + 'B · freshen=wipe-scheduled';
}), { mode: 'write' });

// H. 运行中宿主：插件 HTTP 路由是否真的挂上（只读；401 即已注册）
await check('live.routes', '运行中宿主：/context-relay/* 路由已注册（401/403 视为已挂载）', async () => {
  if (NO_LIVE) return skip('--no-live');
  const paths = ['/context-relay/panel?sessionId=smoke', '/context-relay/settings', '/context-relay/work-items?sessionId=smoke', '/context-relay/architect-models?sessionId=smoke'];
  const rows = [];
  for (const path of paths) {
    let response;
    try {
      response = await fetch(LIVE_URL + path, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
    } catch (error) {
      return skip('无法连接 ' + LIVE_URL + '（' + (error?.cause?.code ?? error?.name ?? 'unknown') + '）；宿主未启动时该项不判失败');
    }
    if (response.status === 404) throw new Error(path + ' 返回 404：插件路由未挂载（宿主未加载这份插件，或 profile/重启未生效）');
    const mounted = response.status === 200 || response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400);
    if (!mounted) throw new Error(path + ' 返回 ' + response.status + '（预期 200/3xx/401/403；404 表示路由未挂载）');
    rows.push(path.split('?')[0] + '=' + response.status);
  }
  return 'live=' + LIVE_URL + ' · ' + rows.join(' · ');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
const count = (status) => results.filter((result) => result.status === status).length;
console.log(NL + '汇总：PASS ' + count('PASS') + ' · FAIL ' + count('FAIL') + ' · SKIP ' + count('SKIP'));
if (results.some((result) => result.status === 'FAIL')) {
  console.log('失败项：' + results.filter((result) => result.status === 'FAIL').map((result) => result.id).join(', '));
  if (APPLY) console.log('排障：加 --keep 保留临时目录，或用 --verbose 看完整堆栈。');
  process.exitCode = 1;
} else if (!APPLY) {
  console.log('dry-run 完成。写路径（confirmKey 复用 / 真注入事件 / team 写入）请加 --apply。');
}
if (kept.length > 0) console.log('保留的临时目录：' + NL + kept.map((cwd) => '  ' + cwd).join(NL));

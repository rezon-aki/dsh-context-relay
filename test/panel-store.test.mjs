import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePanelState, PANEL_OPERATIONS, PANEL_SCHEMA_VERSION } from '../lib/policy.js';
import {
  LIVE_TTL_MS,
  MAX_SESSION_ID,
  clearPanelMemory,
  configurePanelStore,
  defaultPanelPath,
  isValidSessionId,
  liveStateOf,
  loadPanelStore,
  panelStateOf,
  publishLiveState,
  resolvePanelState,
  savePanelStore,
  updatePanelState,
} from '../lib/panel-store.js';

const tmpPanelPath = () => join(mkdtempSync(join(tmpdir(), 'relay-panel-store-')), 'panel.json');
/** 规范面板默认值基线：从 policy 白名单派生（不硬编码字段，删/加内部字段时测试自动跟随）。 */
const DEFAULT = normalizePanelState({});
/** 侧栏设置发布位（host 平面写入；panel-store 读作按会话面板的默认值）。 */
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');

/** 测试默认侧栏设置（单模式合法档；已退役字段不再发布）。 */
const publishSidebarDefaults = (overrides = {}) => {
  globalThis[SETTINGS_KEY] = {
    threshold: 50,
    defaultOperation: 'compress',
    autoCompress: true,
    autoHandoff: true,
    ...overrides,
  };
};
const readPanelFile = (panelPath) => JSON.parse(readFileSync(panelPath, 'utf8'));

beforeEach(() => { clearPanelMemory(); delete globalThis[SETTINGS_KEY]; });
afterEach(() => { clearPanelMemory(); delete globalThis[SETTINGS_KEY]; });

test('defaultPanelPath: ~/.dsh/data/dsh-context-relay/panel.json，config.panelPath 可覆盖', () => {
  assert.equal(defaultPanelPath(), join(homedir(), '.dsh', 'data', 'dsh-context-relay', 'panel.json'));
  assert.equal(defaultPanelPath({ panelPath: '/tmp/custom-panel.json' }), '/tmp/custom-panel.json');
  assert.equal(defaultPanelPath({ panelPath: '' }), defaultPanelPath());
});

test('isValidSessionId: 拒绝 __proto__/NUL/超长/空白/伪 id，接受真实会话 id 形状', () => {
  for (const bad of ['', '__proto__', 'constructor\u0000x', 'a b', 'session/evil', '-leading', '.dot', 'x'.repeat(MAX_SESSION_ID + 1), 42, null, undefined, {}]) {
    assert.equal(isValidSessionId(bad), false, '应拒绝: ' + String(bad));
  }
  for (const ok of ['session-07d9bef2-9c1c-4f39-82dc-185ea7649a20', '0070a9b4-8439-431f-adff-b6c8a9494363', 'a', 'A_b-1', 'x'.repeat(MAX_SESSION_ID)]) {
    assert.equal(isValidSessionId(ok), true, '应接受: ' + String(ok));
  }
});

test('resolvePanelState: 合并默认/记录/补丁，退役/未知字段一律由白名单丢弃', () => {
  const defaults = { defaultOperation: 'compress', autoCompress: true, autoHandoff: false };
  assert.deepEqual(resolvePanelState({ defaults }), { ...DEFAULT, defaultOperation: 'compress', autoCompress: true });
  // record / patch 覆盖默认值；未知键丢弃
  const merged = resolvePanelState({ defaults, record: { autoCompress: false, unrelated: 'drop' }, patch: { autoHandoff: true } });
  assert.equal(merged.autoCompress, false);
  assert.equal(merged.autoHandoff, true);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'unrelated'), false);
  // 退役字段（自动选择档/模型自决/交接目标 preset/handoffPreAuthorized）不进状态
  const retired = resolvePanelState({
    defaults: { autoChoose: true, defaultOperation: 'handoff' },
    record: { handoffPreset: 'relay' },
    patch: { autoDecision: { operation: 'compress', at: 1 }, handoffPreAuthorized: true },
  });
  assert.deepEqual(retired, { ...DEFAULT, defaultOperation: 'handoff' });
  for (const key of ['autoChoose', 'autoDecision', 'handoffPreset', 'handoffPreAuthorized']) {
    assert.equal(Object.prototype.hasOwnProperty.call(retired, key), false, '退役字段不得出现：' + key);
  }
  // 单一模式三档
  assert.deepEqual(PANEL_OPERATIONS, ['compress', 'handoff', 'continue']);
});

test('panelStateOf: 无记录返回侧栏默认值且不落盘；非法 sessionId 同样安全', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  assert.deepEqual(panelStateOf('sess-missing'), DEFAULT);
  publishSidebarDefaults();
  const withDefaults = panelStateOf('sess-missing');
  assert.equal(withDefaults.defaultOperation, 'compress');
  assert.equal(withDefaults.autoCompress, true);
  for (const bad of [undefined, null, '', 42, {}, '__proto__', 'x'.repeat(MAX_SESSION_ID + 1)]) assert.deepEqual(panelStateOf(bad), withDefaults);
  assert.equal(existsSync(panelPath), false);
});

test('unlimitedBudget（v0.2.7）：settings 默认值合并成面板生效值；会话显式写入后按快照覆盖', () => {
  configurePanelStore({ panelPath: tmpPanelPath() });
  // 无 live 设置（或设置里没有该字段）→ null：agent 回退 DEFAULT_SETTINGS，client 不渲染胶囊（relay 标记另判）
  assert.equal(panelStateOf('sess-budget').unlimitedBudget, null);
  // settings 默认值 false → 未改过面板的会话生效 false
  globalThis[SETTINGS_KEY] = { threshold: 35, unlimitedBudget: false, explicit: true };
  assert.equal(panelStateOf('sess-budget').unlimitedBudget, false);
  // 人类面板写入 true = 整份快照 → 此后不再跟随 settings 默认（SPEC V4 语义）
  updatePanelState('sess-budget', { unlimitedBudget: true });
  globalThis[SETTINGS_KEY] = { threshold: 35, unlimitedBudget: false, explicit: true };
  assert.equal(panelStateOf('sess-budget').unlimitedBudget, true, '面板写入后不再跟随默认');
  // handoffUnlimitedBudget 三值：缺省 null（交接跟随当前会话）；显式 false 保留
  assert.equal(panelStateOf('sess-budget-2').handoffUnlimitedBudget, null);
  updatePanelState('sess-budget-2', { handoffUnlimitedBudget: false });
  assert.equal(panelStateOf('sess-budget-2').handoffUnlimitedBudget, false);
});

test('退役字段（自动选择/自决/交接目标 preset）：写入被丢弃不落盘，旧 panel.json 脏值不报错', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  // 退役字段写入 = 归一丢弃 → 与当前生效值相同 → no-op 不落盘
  updatePanelState('sess-hp', { handoffPreset: 'relay-long', autoChoose: true, autoDecision: { operation: 'compress', at: 1 } });
  for (const key of ['handoffPreset', 'autoChoose', 'autoDecision']) {
    assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('sess-hp'), key), false, '退役字段不得出现在状态：' + key);
  }
  assert.equal(existsSync(panelPath), false, '退役字段写入是 no-op，不创建会话记录');
  // 旧 panel.json：退役/脏字段按白名单丢弃；同记录授权按 schema 迁移失效
  writeFileSync(panelPath, JSON.stringify({
    sessions: {
      'sess-hp-old': { handoffPreset: 'not a preset id!', autoChoose: true },
      'sess-hp-missing': { autoCompress: true },
      'sess-hp-number': { handoffPreset: 42, autoDecision: { operation: 'compress', at: 1 } },
    },
  }), 'utf8');
  clearPanelMemory();
  loadPanelStore({ panelPath });
  assert.deepEqual(panelStateOf('sess-hp-old'), DEFAULT);
  assert.equal(panelStateOf('sess-hp-old').autoCompress, false, '同记录其它字段不受脏值影响，旧授权已失效');
  assert.deepEqual(panelStateOf('sess-hp-missing'), DEFAULT);
  assert.equal(panelStateOf('sess-hp-missing').autoCompress, false, '无版本旧文件：授权字段一次性失效');
  assert.deepEqual(panelStateOf('sess-hp-number'), DEFAULT);
});

test('loadPanelStore: 文件缺失空载；正常文件归一化，非法 sessionId 与非对象值跳过、旧死字段丢弃', () => {
  const panelPath = tmpPanelPath();
  // 缺失（首次运行）：空载
  assert.equal(loadPanelStore({ panelPath }).size, 0);
  writeFileSync(panelPath, JSON.stringify({
    sessions: {
      'sess-1': { defaultOperation: 'compress', autoChoose: true, handoffPreAuthorized: true, unrelated: 'drop' },
      'sess-2': { defaultOperation: 'nope', autoChoose: 1 },
      '__proto__': { autoChoose: true },
      'bad id': { autoChoose: true },
      '': { autoChoose: true },
    },
  }), 'utf8');
  const sessions = loadPanelStore({ panelPath });
  assert.equal(sessions.size, 2); // '__proto__'/'bad id'/空 id 被跳过
  // D8=A：autoChoose 退役恒 false；旧文件（无 schemaVersion）授权迁移后 autoChoose/授权失效；handoffPreAuthorized 已删除
  assert.deepEqual(panelStateOf('sess-1'), { ...DEFAULT, defaultOperation: 'compress' });
  assert.deepEqual(panelStateOf('sess-2'), DEFAULT);
  // 每次调用都重新载入（清空旧 Map 后按文件重建）；先落盘收口迁移标脏，再换到缺失文件路径
  savePanelStore();
  assert.equal(loadPanelStore({ panelPath: tmpPanelPath() }).size, 0);
});

test('loadPanelStore: 损坏文件先隔离备份 + warn + 保留内存旧值（不静默清空旧快照）', () => {
  const panelPath = tmpPanelPath();
  const warnings = [];
  configurePanelStore({ panelPath }, { warn: (message) => warnings.push(String(message)) });
  writeFileSync(panelPath, JSON.stringify({ sessions: { 'sess-old': { defaultOperation: 'compress' } } }), 'utf8');
  assert.equal(loadPanelStore({ panelPath }).size, 1);
  // 语法损坏：rename 为 *.corrupt-<ts>，内存旧值保留，warn 一次
  writeFileSync(panelPath, '{ "sessions": { broken', 'utf8');
  const kept = loadPanelStore({ panelPath });
  assert.equal(kept.size, 1);
  assert.equal(panelStateOf('sess-old').defaultOperation, 'compress', '损坏文件不得清空内存旧值');
  assert.equal(existsSync(panelPath), false, '损坏文件应被隔离（rename）');
  const backups = readdirSync(join(panelPath, '..')).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  assert.match(readFileSync(join(panelPath, '..', backups[0]), 'utf8'), /broken|sessions/, '备份保留损坏原文');
  assert.equal(warnings.filter((line) => /panel store unreadable/.test(line)).length, 1, '损坏隔离 warn 一次（schema 迁移 warn 另计）');
  assert.match(warnings.find((line) => /panel store unreadable/.test(line)), /panel store unreadable/);
  // 结构损坏（JSON 合法但缺 sessions 对象）同样隔离 + 保留旧值；同 key 告警限频（不重复刷）
  writeFileSync(panelPath, '{}', 'utf8');
  assert.equal(loadPanelStore({ panelPath }).size, 1);
  assert.equal(panelStateOf('sess-old').defaultOperation, 'compress');
  assert.equal(warnings.filter((line) => /panel store (unreadable|malformed)/.test(line)).length, 1, '30s 内同 key 告警只报一次');
  // sessions 为数组同样属于结构畸形 → 隔离 + 保留旧值
  writeFileSync(panelPath, JSON.stringify({ sessions: [] }), 'utf8');
  assert.equal(loadPanelStore({ panelPath }).size, 1);
  assert.equal(panelStateOf('sess-old').defaultOperation, 'compress');
  // 三次损坏三次隔离，备份名唯一（同名冲突加序号，绝不覆盖已有备份）
  assert.equal(readdirSync(join(panelPath, '..')).filter((name) => name.includes('.corrupt-')).length, 3);
});

test('loadPanelStore: 文件会话数超过上限（500）时只保留最近 500 条（最早写入淘汰）', () => {
  const panelPath = tmpPanelPath();
  const sessions = {};
  for (let index = 0; index < 600; index += 1) sessions['sess-' + index] = { autoChoose: index % 2 === 0 };
  writeFileSync(panelPath, JSON.stringify({ sessions }), 'utf8');
  const loaded = loadPanelStore({ panelPath });
  assert.equal(loaded.size, 500);
  assert.equal(loaded.has('sess-0'), false);
  assert.equal(loaded.has('sess-100'), true);
  assert.equal(loaded.has('sess-599'), true);
});

test('loadPanelStore: 文件缺失但内存有未落盘修改（上次写盘失败）→ 保留内存，不静默丢（B-P2-10 连带）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-panel-pending-'));
  const panelPath = join(dir, 'panel.json');
  const warnings = [];
  configurePanelStore({ panelPath }, { warn: (message) => warnings.push(String(message)) });
  chmodSync(dir, 0o500); // 目录不可写 → 落盘失败，但文件仍不存在
  try {
    updatePanelState('sess-pending', { autoCompress: true }); // 内存写入成功，落盘失败（dirty 保留）
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(panelStateOf('sess-pending').autoCompress, true);
  // 热重载/再次 apply 触发 load：文件不存在但内存有 pending 修改 → 保留内存，不静默丢弃
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-pending').autoCompress, true);
  assert.equal(warnings.some((line) => /in-memory changes are pending/.test(line)), true);
});

test('updatePanelState(panel): 人类面板写入 = 整份生效值快照（侧栏默认固化为会话记录）', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  publishSidebarDefaults();
  const snapshot = updatePanelState('sess-snap', { autoCompress: false });
  assert.deepEqual(snapshot, { ...DEFAULT, defaultOperation: 'compress', autoCompress: false, autoHandoff: true });
  // 快照落盘（全字段，含侧栏默认值）
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-snap'], snapshot);
  // 侧栏默认改变：未改面板的会话跟随，改过的会话保持快照
  publishSidebarDefaults({ defaultOperation: 'compress', autoChoose: false, autoCompress: false, autoHandoff: false });
  assert.equal(panelStateOf('sess-other').defaultOperation, 'compress');
  assert.deepEqual(panelStateOf('sess-snap'), snapshot);
});

test('updatePanelState: 归一化后与当前生效值相同的 no-op 不落盘、不创建快照（避免内部写固化侧栏默认值）', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  publishSidebarDefaults();
  // 与侧栏默认完全相同的面板写入 → 没有语义变化 → 不落盘（会话继续跟随侧栏默认）
  const noop = updatePanelState('sess-noop', { autoCompress: true, autoHandoff: true, defaultOperation: 'compress' });
  assert.equal(noop.autoCompress, true);
  assert.equal(existsSync(panelPath), false, 'no-op 不得创建会话快照');
  publishSidebarDefaults({ defaultOperation: 'continue', autoCompress: false, autoHandoff: false });
  assert.equal(panelStateOf('sess-noop').defaultOperation, 'continue', '未落盘的会话继续跟随侧栏默认');
  assert.equal(panelStateOf('sess-noop').autoCompress, false);
});

test('updatePanelState(agent): 只落 patch 显式字段、不 materialize 侧栏默认值（handoff 子会话不被固化）', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  publishSidebarDefaults();
  // agent 写 handedOff：记录只有 { handedOff: true }，读取时其余字段仍来自侧栏默认
  const held = updatePanelState('sess-agent', { handedOff: true }, { source: 'agent' });
  assert.equal(held.handedOff, true);
  assert.equal(held.defaultOperation, 'compress');
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-agent'], { handedOff: true });
  // agent 内部写 4 个授权字段：只落这 4 个显式键（不写 defaultOperation/autoDecision 默认值）。
  // 先把侧栏默认改为不同的值，验证 agent 稀疏写入钉住显式授权、未写字段继续跟随默认。
  publishSidebarDefaults({ autoCompress: false, autoHandoff: false });
  updatePanelState('sess-child', { autoCompress: true, autoHandoff: true, authorizeNext: false }, { source: 'agent' });
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-child'], { autoCompress: true, autoHandoff: true, authorizeNext: false });
  // 侧栏默认改变：子会话未被固化的字段跟随新默认，显式继承的授权保留
  publishSidebarDefaults({ defaultOperation: 'continue', autoCompress: false, autoHandoff: false });
  const child = panelStateOf('sess-child');
  assert.equal(child.defaultOperation, 'continue');
  assert.equal(child.autoCompress, true);
  assert.equal(child.autoHandoff, true);
  // 重启回读：稀疏记录 + 当前侧栏默认合并正确
  clearPanelMemory();
  loadPanelStore({ panelPath });
  const reloaded = panelStateOf('sess-child');
  assert.equal(reloaded.defaultOperation, 'continue');
  assert.equal(reloaded.autoCompress, true);
  // 死字段 handoffPreAuthorized 即使旧调用方传入也不落库
  updatePanelState('sess-agent', { handoffPreAuthorized: false }, { source: 'agent' });
  assert.equal(Object.prototype.hasOwnProperty.call(readPanelFile(panelPath).sessions['sess-agent'], 'handoffPreAuthorized'), false);
});

test('updatePanelState(agent): 退役自决字段写入是 no-op 不落盘', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  publishSidebarDefaults({ defaultOperation: 'compress' });
  // 退役字段归一化丢弃 → 与当前相同 → 不落盘
  updatePanelState('sess-dec', { autoDecision: { operation: 'compress', at: 1 } }, { source: 'agent' });
  assert.equal(existsSync(panelPath), false);
  const retired = updatePanelState('sess-dec2', { autoChoose: true }, { source: 'agent' });
  assert.equal(Object.prototype.hasOwnProperty.call(retired, 'autoChoose'), false);
  assert.equal(existsSync(panelPath), false, '退役字段不得创建会话记录');
});

test('v0.3.3 模型推荐：agent 稀疏写入三字段、落盘/重启回读；显式清空后不再出现（推荐只展示）', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  publishSidebarDefaults();
  // agent 写入 = 稀疏记录：只落推荐三字段，不 materialize 侧栏默认值
  const written = updatePanelState('sess-rec', {
    recommendedOperation: 'compress',
    recommendedReason: '  首次压缩成本低，保留对话细节  ',
    recommendedAt: 1762460000123,
  }, { source: 'agent' });
  assert.equal(written.recommendedOperation, 'compress');
  assert.equal(written.recommendedReason, '首次压缩成本低，保留对话细节');
  assert.equal(written.recommendedAt, 1762460000123);
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-rec'], {
    recommendedOperation: 'compress',
    recommendedReason: '首次压缩成本低，保留对话细节',
    recommendedAt: 1762460000123,
  });
  // 其余字段仍跟随侧栏默认（推荐不影响决策字段）
  assert.equal(panelStateOf('sess-rec').defaultOperation, 'compress');
  assert.equal(panelStateOf('sess-rec').authorizeNext, false);
  // 重启（同一 panelPath 重新载入）回读推荐
  clearPanelMemory();
  loadPanelStore({ panelPath });
  const reloaded = panelStateOf('sess-rec');
  assert.equal(reloaded.recommendedOperation, 'compress');
  assert.equal(reloaded.recommendedReason, '首次压缩成本低，保留对话细节');
  assert.equal(reloaded.recommendedAt, 1762460000123);
  // 显式清空三字段（人类已决策/操作成功后的清理路径）→ 记录里理由/时间归空，不回退成旧值
  updatePanelState('sess-rec', { recommendedOperation: null, recommendedReason: '', recommendedAt: null }, { source: 'agent' });
  const cleared = panelStateOf('sess-rec');
  assert.equal(cleared.recommendedOperation, null);
  assert.equal(cleared.recommendedReason, '');
  assert.equal(cleared.recommendedAt, null);
  clearPanelMemory();
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-rec').recommendedOperation, null);
  // handoff 子会话的稀疏记录同样可带推荐（只落显式键）
  updatePanelState('sess-rec-child', { recommendedOperation: 'handoff', recommendedReason: '', recommendedAt: 99 }, { source: 'agent' });
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-rec-child'], { recommendedOperation: 'handoff', recommendedReason: '', recommendedAt: 99 });
});

test('会话上限 500 按最近写入 LRU 淘汰（更新刷新顺序，活跃旧会话不被新会话挤出）', () => {
  const panelPath = tmpPanelPath();
  const sessions = {};
  for (let index = 0; index < 500; index += 1) sessions['sess-' + index] = { autoChoose: index % 2 === 0 };
  writeFileSync(panelPath, JSON.stringify({ sessions }), 'utf8');
  clearPanelMemory();
  loadPanelStore({ panelPath });
  // 活跃的 sess-0 更新一次 → 刷新为最近使用；随后新增第 501 个会话
  updatePanelState('sess-0', { autoCompress: true });
  // v0.9.0 D8=A：autoChoose 退役（写入 no-op）——用授权字段制造第 501 个会话
  updatePanelState('sess-new', { autoCompress: true });
  assert.equal(panelStateOf('sess-0').autoCompress, true, '活跃旧会话不得被淘汰');
  const file = readPanelFile(panelPath).sessions;
  assert.equal(Object.prototype.hasOwnProperty.call(file, 'sess-0'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(file, 'sess-1'), false, '淘汰的是最久未用的 sess-1');
  assert.equal(Object.keys(file).length, 500);
});

test('savePanelStore: 写前 re-read 磁盘按 sessionId 合并（本实例脏记录覆盖同名键、其它进程的新会话保留）', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  loadPanelStore({ panelPath });
  updatePanelState('sess-A', { autoCompress: true });
  // 模拟另一个进程在本实例 load 之后写入 sess-remote（并有更新的 sess-A 字段）
  const disk = readPanelFile(panelPath);
  disk.sessions['sess-remote'] = { defaultOperation: 'continue' };
  writeFileSync(panelPath, JSON.stringify(disk), 'utf8');
  // 本实例再改 sess-A → 合并写：sess-remote 保留，sess-A 由本实例覆盖
  updatePanelState('sess-A', { autoHandoff: true });
  const merged = readPanelFile(panelPath).sessions;
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'sess-remote'), true, '其它进程写入的会话不得丢失');
  assert.equal(merged['sess-remote'].defaultOperation, 'continue');
  assert.equal(merged['sess-A'].autoHandoff, true);
  assert.equal(merged['sess-A'].autoCompress, true);
});

test('双进程共享 panel.json：各自 load 后写回不丢对方更新（B-P2-14 跨进程）', async () => {
  const panelPath = tmpPanelPath();
  const storeUrl = JSON.stringify(new URL('../lib/panel-store.js', import.meta.url).href);
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'relay-2proc-')), 'child.mjs');
  writeFileSync(scriptPath, [
    'import { configurePanelStore, loadPanelStore, updatePanelState } from ' + storeUrl + ';',
    'const [panelPath, sessionId] = process.argv.slice(2);',
    'configurePanelStore({ panelPath });',
    'loadPanelStore({ panelPath });',
    'process.stdout.write("loaded\\n");',
    'process.stdin.once("data", () => {',
    '  updatePanelState(sessionId, { autoCompress: true });',
    '  process.stdout.write("saved\\n", () => process.exit(0));',
    '});',
  ].join('\n'), 'utf8');
  /** 启动子进程并等它 load 完成（此时两个进程看到同一份（空）文件 = 各自持有旧内存快照）。 */
  const startChild = (sessionId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, panelPath, sessionId], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timeout: ' + stderr)); }, 20000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('loaded')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => { if (!stdout.includes('loaded')) { clearTimeout(timer); reject(new Error('child exited ' + code + ': ' + stderr)); } });
  });
  const waitExit = (child) => new Promise((resolve) => child.on('exit', resolve));
  // 两个进程都先 load 到同一份（空）快照，再依次写盘：B 的内存是旧快照，靠 save 前 re-read 合并保住 A。
  const first = await startChild('sess-proc-A');
  const second = await startChild('sess-proc-B');
  first.stdin.write('go\n');
  await waitExit(first);
  second.stdin.write('go\n');
  await waitExit(second);
  const sessions = readPanelFile(panelPath).sessions;
  assert.equal(Object.prototype.hasOwnProperty.call(sessions, 'sess-proc-A'), true, '进程 A 的更新被进程 B 覆盖丢失');
  assert.equal(Object.prototype.hasOwnProperty.call(sessions, 'sess-proc-B'), true);
});

test('savePanelStore: 写盘失败 warn（限频）并返回 false，内存状态保留可重试', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-panel-store-'));
  writeFileSync(join(dir, 'blocker'), 'x', 'utf8');
  const warnings = [];
  configurePanelStore({ panelPath: join(dir, 'blocker', 'panel.json') }, { warn: (message) => warnings.push(String(message)) });
  const next = updatePanelState('sess-fail', { autoCompress: true });
  assert.equal(next.autoCompress, true);
  assert.deepEqual(panelStateOf('sess-fail'), next);
  assert.equal(savePanelStore(), false);
  assert.equal(warnings.filter((line) => /write failed/.test(line)).length, 1, '写盘失败必须 warn 一次');
  // 再次尝试：仍失败；30s 内告警限频不重复刷
  assert.equal(updatePanelState('sess-fail', { autoHandoff: true }).autoHandoff, true);
  assert.equal(warnings.filter((line) => /write failed/.test(line)).length, 1);
});

// ── M-13：dirty 非空时 reload 保留合并 + warn；写盘失败不静默清 dirty ──────
test('M-13：正常文件载入时 dirty 非空 → 保留内存改动并合并磁盘其它会话 + warn；写盘失败不清 dirty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-panel-merge-'));
  const panelPath = join(dir, 'panel.json');
  const warnings = [];
  configurePanelStore({ panelPath }, { warn: (message) => warnings.push(String(message)) });
  updatePanelState('sess-saved', { autoCompress: true }); // 正常落盘（dirty 清空）
  assert.equal(existsSync(panelPath), true);
  // 目录不可写 → 落盘失败；内存写入成功、dirty 保留（旧实现会在下次 load 静默丢掉）
  chmodSync(dir, 0o500);
  try { updatePanelState('sess-pending', { autoCompress: true }); } finally { chmodSync(dir, 0o700); }
  assert.equal(panelStateOf('sess-pending').autoCompress, true);
  assert.equal(warnings.some((line) => /write failed/.test(line)), true, '写盘失败必须 warn');
  // 外部/旧快照写入磁盘（不含 sess-pending，且 sess-saved 是旧值）→ 再次载入
  writeFileSync(panelPath, JSON.stringify({
    schemaVersion: PANEL_SCHEMA_VERSION,
    sessions: { 'sess-saved': { autoCompress: false }, 'sess-disk': { defaultOperation: 'compress' } },
  }), 'utf8');
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-pending').autoCompress, true, 'dirty 内存改动不得被正常载入静默清掉');
  assert.equal(panelStateOf('sess-saved').autoCompress, false, '非 dirty 会话按磁盘载入');
  assert.equal(panelStateOf('sess-disk').defaultOperation, 'compress', '磁盘其它进程写入的会话保留');
  assert.equal(warnings.some((line) => /pending/.test(line)), true, '保留合并必须 warn');
  // 仍标脏：下一次写盘把合并结果落盘
  assert.equal(savePanelStore(), true);
  const saved = readPanelFile(panelPath).sessions;
  assert.equal(saved['sess-pending'].autoCompress, true);
  assert.equal(saved['sess-saved'].autoCompress, false);
  assert.equal(saved['sess-disk'].defaultOperation, 'compress');
});

test('实时状态：新鲜数据可读，超过 LIVE_TTL_MS 未更新视为 stale（不下发旧 band/「已到线」）', () => {
  assert.equal(liveStateOf('sess-live'), undefined);
  publishLiveState('sess-live', { band: 'relay', used: 500000, window: 1000000, ratio: 0.5, phase: 'verify', overBudget: true });
  const live = liveStateOf('sess-live');
  assert.equal(live.band, 'relay');
  assert.equal(live.used, 500000);
  assert.equal(live.overBudget, true);
  assert.equal(typeof live.updatedAt, 'number');
  // 显式注入旧时间戳（模拟 agent 停止发布）→ stale 视为未发布
  clearPanelMemory();
  publishLiveState('sess-stale', { band: 'relay', overBudget: true }, Date.now() - LIVE_TTL_MS - 1);
  assert.equal(liveStateOf('sess-stale'), undefined);
  assert.equal(LIVE_TTL_MS >= 60 * 1000, true);
  // overBudget 严格布尔；非有限数丢弃；band 缺省 ok
  publishLiveState('sess-live2', { used: NaN, window: Infinity, overBudget: 'yes' });
  const loose = liveStateOf('sess-live2');
  assert.equal(loose.band, 'ok');
  assert.equal(loose.used, undefined);
  assert.equal(loose.window, undefined);
  assert.equal(loose.overBudget, false);
  // 非法 sessionId 不写（__proto__ 等伪 id 不得进入 Map）
  for (const bad of ['', '__proto__', 'bad id', 'x'.repeat(MAX_SESSION_ID + 1), undefined]) publishLiveState(bad, { band: 'ok' });
  assert.equal(liveStateOf('__proto__'), undefined);
  clearPanelMemory();
  assert.equal(liveStateOf('sess-live'), undefined);
});

test('实时状态 LRU：更新已有会话刷新顺序，超过 500 淘汰最久未发布', () => {
  for (let index = 0; index < 500; index += 1) publishLiveState('live-' + index, { band: 'ok' });
  publishLiveState('live-0', { band: 'warn' }); // 刷新
  publishLiveState('live-new', { band: 'ok' }); // 第 501 个
  assert.equal(liveStateOf('live-0').band, 'warn');
  assert.equal(liveStateOf('live-1'), undefined, '淘汰的是最久未更新的 live-1');
  assert.equal(liveStateOf('live-new').band, 'ok');
});

test('落盘格式：{ schemaVersion, sessions: { <id>: 状态 } }，无残留 tmp 文件；面板快照含全部字段', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  const next = updatePanelState('sess-u', { defaultOperation: 'handoff', autoHandoff: true });
  assert.deepEqual(next, { ...DEFAULT, defaultOperation: 'handoff', autoHandoff: true });
  assert.deepEqual(readPanelFile(panelPath), { schemaVersion: PANEL_SCHEMA_VERSION, sessions: { 'sess-u': next } });
  assert.deepEqual(readdirSync(join(panelPath, '..')).filter((name) => name.endsWith('.tmp')), []);
  // 增量合并：只改传入键，其余保持
  assert.deepEqual(updatePanelState('sess-u', { defaultOperation: null }), { ...next, defaultOperation: null });
});
test('architect（v0.6.4）：settings 默认值合并成面板生效值；会话显式写入后按快照覆盖', () => {
  configurePanelStore({ panelPath: tmpPanelPath() });
  assert.equal(panelStateOf('sess-arch').architect, null);
  globalThis[SETTINGS_KEY] = { threshold: 35, architect: false, explicit: true };
  assert.equal(panelStateOf('sess-arch').architect, false);
  updatePanelState('sess-arch', { architect: true });
  globalThis[SETTINGS_KEY] = { threshold: 35, architect: false, explicit: true };
  assert.equal(panelStateOf('sess-arch').architect, true, '面板写入后不再跟随默认');
});

// ── panel.json schemaVersion 迁移（授权一次性失效；v0.10.0=3）────────────
test('schema 迁移 v2→v3：旧授权一次性失效并显式 warn，保留模式/架构师；写盘落 v3（幂等）', () => {
  const panelPath = tmpPanelPath();
  const warnings = [];
  configurePanelStore({ panelPath }, { warn: (message) => warnings.push(String(message)) });
  writeFileSync(panelPath, JSON.stringify({
    schemaVersion: 2,
    sessions: {
      'sess-mig': {
        defaultOperation: 'compress', autoChoose: true, autoCompress: true, autoHandoff: true,
        authorizeNext: true, autoDecision: { operation: 'compress', at: 1 },
        architect: true, architectModel: { provider: 'geekai', model: 'gpt-6.1-sol' },
        handedOff: false, unlimitedBudget: true, handoffUnlimitedBudget: false,
      },
      'sess-clean': { defaultOperation: 'continue' },
    },
  }), 'utf8');
  const loaded = loadPanelStore({ panelPath });
  assert.equal(loaded.size, 2);
  const migrated = panelStateOf('sess-mig');
  // 授权失效（只清授权，不清模式/架构师）；退役自决字段按白名单丢弃
  assert.equal(migrated.autoCompress, false, '旧授权 autoCompress 失效');
  assert.equal(migrated.autoHandoff, false, '旧授权 autoHandoff 失效');
  assert.equal(migrated.authorizeNext, false, '旧授权 authorizeNext 失效');
  for (const key of ['autoChoose', 'autoDecision']) assert.equal(Object.prototype.hasOwnProperty.call(migrated, key), false);
  assert.equal(migrated.defaultOperation, 'compress', '模式不是授权：保留');
  assert.equal(migrated.architect, true, '架构师不是授权：保留');
  assert.deepEqual(migrated.architectModel, { provider: 'geekai', model: 'gpt-6.1-sol' });
  assert.equal(migrated.unlimitedBudget, true);
  assert.equal(migrated.handoffUnlimitedBudget, false);
  assert.deepEqual(panelStateOf('sess-clean'), { ...DEFAULT, defaultOperation: 'continue' });
  assert.equal(warnings.filter((line) => /authorization schema 2 != v3/.test(line)).length, 1, '版本失效必须显式 warn 一次');
  // 标脏 + 写盘落 schemaVersion（只失效授权字段，模式/架构师写回原值）
  assert.equal(savePanelStore(), true);
  const saved = readPanelFile(panelPath);
  assert.equal(saved.schemaVersion, PANEL_SCHEMA_VERSION);
  assert.equal(saved.sessions['sess-mig'].autoCompress, false);
  assert.equal(saved.sessions['sess-mig'].authorizeNext, false);
  assert.equal(saved.sessions['sess-mig'].defaultOperation, 'compress');
  assert.equal(saved.sessions['sess-mig'].architect, true);
  assert.equal(Object.prototype.hasOwnProperty.call(saved.sessions['sess-mig'], 'autoChoose'), false, '退役字段不写回磁盘');
  // 二次载入（v3）：不重复清——迁移后重新开的授权保持
  updatePanelState('sess-mig', { autoCompress: true });
  clearPanelMemory();
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-mig').autoCompress, true, 'v3 文件不得再次失效授权');
  assert.equal(warnings.filter((line) => /authorization schema/.test(line)).length, 1, 'v3 载入不再 migrate/warn');
});

test('schema 迁移：任意旧版本（含无版本）都失效授权；无记录旧文件写盘补 schemaVersion', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  writeFileSync(panelPath, JSON.stringify({ schemaVersion: 1, sessions: { 'sess-v1': { autoCompress: true, autoHandoff: true } } }), 'utf8');
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-v1').autoCompress, false, 'schemaVersion 1 != 3 → 授权失效');
  assert.equal(panelStateOf('sess-v1').autoHandoff, false);
  assert.equal(savePanelStore(), true);
  assert.equal(readPanelFile(panelPath).schemaVersion, PANEL_SCHEMA_VERSION);
  // 无版本（v1 前形态）同样失效
  const noVersionPath = tmpPanelPath();
  configurePanelStore({ panelPath: noVersionPath });
  writeFileSync(noVersionPath, JSON.stringify({ sessions: { 'sess-nv': { autoCompress: true } } }), 'utf8');
  loadPanelStore({ panelPath: noVersionPath });
  assert.equal(panelStateOf('sess-nv').autoCompress, false, '无版本旧文件：授权失效');
  // 空旧文件（无版本、无记录可清）：载入后 save 仍写当前版本，避免永久停留在无版本形态
  const emptyPath = tmpPanelPath();
  configurePanelStore({ panelPath: emptyPath });
  writeFileSync(emptyPath, JSON.stringify({ sessions: {} }), 'utf8');
  loadPanelStore({ panelPath: emptyPath });
  assert.equal(savePanelStore(), true);
  assert.equal(readPanelFile(emptyPath).schemaVersion, PANEL_SCHEMA_VERSION);
});

test('schema：当前版本（v3）文件载入不失效授权（同版本内授权仍按会话有效）', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  writeFileSync(panelPath, JSON.stringify({
    schemaVersion: PANEL_SCHEMA_VERSION,
    sessions: { 'sess-v2': { autoCompress: true, autoHandoff: true, authorizeNext: true, defaultOperation: 'continue' } },
  }), 'utf8');
  loadPanelStore({ panelPath });
  const state = panelStateOf('sess-v2');
  assert.equal(state.autoCompress, true);
  assert.equal(state.autoHandoff, true);
  assert.equal(state.authorizeNext, true);
  assert.equal(state.defaultOperation, 'continue');
  // 无脏记录时 save 保持既有 no-op 语义（不为写版本而重写）
  assert.equal(savePanelStore(), true);
  assert.equal(readPanelFile(panelPath).schemaVersion, PANEL_SCHEMA_VERSION);
});
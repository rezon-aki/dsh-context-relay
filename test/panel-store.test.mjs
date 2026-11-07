import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePanelState, PANEL_OPERATIONS } from '../lib/policy.js';
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

const publishSidebarDefaults = (overrides = {}) => {
  globalThis[SETTINGS_KEY] = {
    threshold: 50,
    defaultOperation: 'compress-then-handoff',
    autoChoose: false,
    autoCompress: true,
    autoHandoff: true,
    explicit: true,
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

test('resolvePanelState: 合并默认/记录/补丁，并固化不变量（autoChoose ⇒ defaultOperation=null；autoDecision 仅 autoChoose）', () => {
  const defaults = { defaultOperation: 'compress', autoChoose: false, autoCompress: true, autoHandoff: false };
  assert.deepEqual(resolvePanelState({ defaults }), { ...DEFAULT, defaultOperation: 'compress', autoCompress: true });
  // 遗留/旧数据里 autoChoose 与 preset 同时存在：读时 auto 优先（默认操作忽略、autoDecision 保留）
  assert.deepEqual(
    resolvePanelState({ defaults: { autoChoose: true, defaultOperation: 'handoff' }, patch: { autoDecision: { operation: 'compress', at: 5 } } }),
    { ...DEFAULT, autoChoose: true, autoDecision: { operation: 'compress', at: 5 } },
  );
  // record / patch 覆盖默认值；未知键丢弃
  const merged = resolvePanelState({ defaults, record: { autoCompress: false, unrelated: 'drop' }, patch: { autoHandoff: true } });
  assert.equal(merged.autoCompress, false);
  assert.equal(merged.autoHandoff, true);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'unrelated'), false);
  // autoDecision 只在 autoChoose 开启时保留
  assert.equal(resolvePanelState({ defaults: { autoChoose: false }, patch: { autoDecision: { operation: 'compress', at: 1 } } }).autoDecision, null);
  // 字段白名单：handoffPreAuthorized 已删除（旧数据/旧调用方传入都不得出现在状态里）
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT, 'handoffPreAuthorized'), false);
  assert.deepEqual(PANEL_OPERATIONS, ['compress', 'handoff', 'continue', 'compress-then-handoff']);
});

test('panelStateOf: 无记录返回侧栏默认值且不落盘；非法 sessionId 同样安全', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  assert.deepEqual(panelStateOf('sess-missing'), DEFAULT);
  publishSidebarDefaults();
  const withDefaults = panelStateOf('sess-missing');
  assert.equal(withDefaults.defaultOperation, 'compress-then-handoff');
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

test('handoffPreset（v0.2.14）：默认 null；合法值面板写入/落盘/重启保留；旧 panel.json 缺字段或脏值 → null', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  assert.equal(panelStateOf('sess-hp').handoffPreset, null, '缺省 null = 跟随本会话 preset');
  // 人类面板写入 relay-long = 整份快照 + 落盘；重启（同一 panelPath 重新载入）保留
  updatePanelState('sess-hp', { handoffPreset: 'relay-long' });
  assert.equal(panelStateOf('sess-hp').handoffPreset, 'relay-long');
  assert.equal(JSON.parse(readFileSync(panelPath, 'utf8')).sessions['sess-hp'].handoffPreset, 'relay-long');
  clearPanelMemory();
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-hp').handoffPreset, 'relay-long');
  // 旧 panel.json：缺字段 → null；脏值（非法字符/非字符串）→ null（白名单归一化，不整条丢弃）
  writeFileSync(panelPath, JSON.stringify({
    sessions: {
      'sess-hp-old': { handoffPreset: 'not a preset id!' },
      'sess-hp-missing': { autoCompress: true },
      'sess-hp-number': { handoffPreset: 42 },
    },
  }), 'utf8');
  clearPanelMemory();
  loadPanelStore({ panelPath });
  assert.equal(panelStateOf('sess-hp-old').handoffPreset, null);
  assert.equal(panelStateOf('sess-hp-old').autoCompress, false, '同记录其它字段不受脏值影响');
  assert.equal(panelStateOf('sess-hp-missing').handoffPreset, null);
  assert.equal(panelStateOf('sess-hp-number').handoffPreset, null);
  // 显式清空（null）合法：sticky 语义下由人类关掉开关
  updatePanelState('sess-hp-old', { handoffPreset: 'relay' });
  updatePanelState('sess-hp-old', { handoffPreset: null });
  assert.equal(panelStateOf('sess-hp-old').handoffPreset, null);
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
  // autoChoose 优先于遗留 preset；handoffPreAuthorized 已删除 → 不再出现在状态里
  assert.deepEqual(panelStateOf('sess-1'), { ...DEFAULT, autoChoose: true });
  assert.deepEqual(panelStateOf('sess-2'), DEFAULT);
  // 每次调用都重新载入（清空旧 Map 后按文件重建）
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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /panel store unreadable/);
  // 结构损坏（JSON 合法但缺 sessions 对象）同样隔离 + 保留旧值；同 key 告警限频（不重复刷）
  writeFileSync(panelPath, '{}', 'utf8');
  assert.equal(loadPanelStore({ panelPath }).size, 1);
  assert.equal(panelStateOf('sess-old').defaultOperation, 'compress');
  assert.equal(warnings.filter((line) => /panel store/.test(line)).length, 1, '30s 内同 key 告警只报一次');
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
  assert.deepEqual(snapshot, { ...DEFAULT, defaultOperation: 'compress-then-handoff', autoCompress: false, autoHandoff: true });
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
  const noop = updatePanelState('sess-noop', { autoCompress: true, autoHandoff: true, defaultOperation: 'compress-then-handoff' });
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
  assert.equal(held.defaultOperation, 'compress-then-handoff');
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-agent'], { handedOff: true });
  // handoff 成功后同步子会话的 4 个持久授权：只落这 4 个显式字段（不写 defaultOperation/autoDecision 默认值）。
  // 先把侧栏默认改为与父会话授权不同的值，模拟「人类在父会话面板里改过授权」后子会话的继承。
  publishSidebarDefaults({ autoCompress: false, autoHandoff: false });
  updatePanelState('sess-child', { autoChoose: false, autoCompress: true, autoHandoff: true, authorizeNext: false }, { source: 'agent' });
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-child'], { autoChoose: false, autoCompress: true, autoHandoff: true, authorizeNext: false });
  // 侧栏默认改变：子会话未被固化的字段跟随新默认，显式继承的授权保留
  publishSidebarDefaults({ defaultOperation: 'continue', autoChoose: false, autoCompress: false, autoHandoff: false });
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

test('updatePanelState(agent): 被丢弃的 autoDecision 是 no-op 不落盘；autoChoose=on 时落稀疏记录', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  publishSidebarDefaults({ autoChoose: false, defaultOperation: 'compress' });
  // autoChoose=off：归一化丢弃模型自决 → 与当前相同 → 不落盘（B-P2-8 根因）
  updatePanelState('sess-dec', { autoDecision: { operation: 'compress', at: 1 } }, { source: 'agent' });
  assert.equal(existsSync(panelPath), false);
  // autoChoose=on：自决保留 → 只落 autoDecision 一个显式字段
  publishSidebarDefaults({ autoChoose: true, defaultOperation: null });
  updatePanelState('sess-dec2', { autoDecision: { operation: 'handoff', at: 2 } }, { source: 'agent' });
  assert.deepEqual(readPanelFile(panelPath).sessions['sess-dec2'], { autoDecision: { operation: 'handoff', at: 2 } });
  assert.deepEqual(panelStateOf('sess-dec2').autoDecision, { operation: 'handoff', at: 2 });
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
  assert.equal(panelStateOf('sess-rec').defaultOperation, 'compress-then-handoff');
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
  updatePanelState('sess-new', { autoChoose: true });
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

test('落盘格式：{ sessions: { <id>: 状态 } }，无残留 tmp 文件；面板快照含全部字段', () => {
  const panelPath = tmpPanelPath();
  configurePanelStore({ panelPath });
  const next = updatePanelState('sess-u', { defaultOperation: 'handoff', autoHandoff: true });
  assert.deepEqual(next, { ...DEFAULT, defaultOperation: 'handoff', autoHandoff: true });
  assert.deepEqual(readPanelFile(panelPath), { sessions: { 'sess-u': next } });
  assert.deepEqual(readdirSync(join(panelPath, '..')).filter((name) => name.endsWith('.tmp')), []);
  // 增量合并：只改传入键，其余保持
  assert.deepEqual(updatePanelState('sess-u', { defaultOperation: null }), { ...next, defaultOperation: null });
});

/**
 * dsh-context-relay — 面板状态存储（按会话）。
 *
 * host 平面（PUT /context-relay/panel、GET 读 live）与 agent 平面（relay_phase 读取/消费
 * 面板模式、审批闸门读授权开关）共用本模块：进程内 globalThis（Symbol.for，抗热重载多实例）
 * 共享 Map，并持久化到 ~/.dsh/data/dsh-context-relay/panel.json（原子写）。
 *
 * 两部分状态：
 *   panel  按会话的稀疏记录（只存显式写过的字段；读取时 resolvePanelState 合并侧栏默认值/规范默认值）。
 *          人类面板写入 = 整份生效值快照（SPEC V4：面板写入后才按会话快照覆盖）；
 *          agent 内部写入（updatePanelState(id, patch, {source:'agent'})）= 只落 patch 显式字段，
 *          不 materialize 侧栏默认值——未在面板改过的会话始终跟随侧栏默认，handoff 子会话不会被固化。
 *   live   Map<sessionId, {band, used, window, ratio, phase, organizeCount, overBudget, updatedAt}>
 *          （agent 每次 step 发布；读取时超过 LIVE_TTL_MS 未更新视为 stale → undefined，client 渲染中性降级 chip、不显示旧值）。
 *
 * 不变量唯一固化点：resolvePanelState()（autoChoose ⇒ defaultOperation=null；autoDecision 仅 autoChoose）。
 * 失败模式：文件损坏先隔离为 *.corrupt-<ts> 再 warn、保留内存旧值；写盘失败 warn（限频）并返回 false；
 * 写前 re-read 磁盘按 sessionId 合并（多进程各自 dirty 记录覆盖同名键、其它键保留）。
 * v0.9.0 #53/D3=A：panel.json 顶层 schemaVersion（授权契约版本，policy.js PANEL_SCHEMA_VERSION）——
 * 旧文件（无版本/版本不符）首次载入一次性清授权字段（只清授权，不清模式/架构师），标脏并在下次写盘落新版本（幂等）。
 *
 * @module dsh-context-relay/panel-store
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PANEL_OPERATIONS, PANEL_SCHEMA_VERSION, normalizePanelState } from './policy.js';
import { hostStore } from './storage.js';

const PANEL_KEY = Symbol.for('dsh-context-relay.panel');
const LIVE_KEY = Symbol.for('dsh-context-relay.live');
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
/** 内存/文件里最多保留的会话数（长期宿主防泄漏；超出按最近写入 LRU 淘汰）。 */
const MAX_SESSIONS = 500;
/** sessionId 上限（面板路由；超长按非法处理）。 */
export const MAX_SESSION_ID = 200;
/** 合法 sessionId：首字符字母/数字，其余 [A-Za-z0-9_-]，1-200 位（拒绝 __proto__/NUL/超长/伪 id）。 */
const SESSION_ID_RE = new RegExp('^[A-Za-z0-9][A-Za-z0-9_-]{0,' + (MAX_SESSION_ID - 1) + '}$');
/** 面板实时状态超过该毫秒数未更新视为 stale（agent 停止发布后不再显示旧 band/「已到线」）。 */
export const LIVE_TTL_MS = 10 * 60 * 1000;
/** 失败告警限频。 */
const WARN_THROTTLE_MS = 30 * 1000;
const CORRUPT_SUFFIX = '.corrupt-';

/** 合法 sessionId 校验（GET/PUT/载入/写盘同校）。 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/** 面板状态文件默认路径（config.panelPath 可覆盖，测试用）。 */
export function defaultPanelPath(config = {}) {
  const custom = config.panelPath;
  if (typeof custom === 'string' && custom !== '') return custom;
  return join(homedir(), '.dsh', 'data', 'dsh-context-relay', 'panel.json');
}

function store() {
  const current = globalThis[PANEL_KEY];
  if (current !== undefined && current.sessions instanceof Map) {
    // 兼容旧版模块实例（热重载）留下的 store：补齐新字段。
    if (!(current.dirty instanceof Set)) current.dirty = new Set();
    if (!(current.warnedAt instanceof Map)) current.warnedAt = new Map();
    if (typeof current.schemaStale !== 'boolean') current.schemaStale = false;
    return current;
  }
  const created = { path: defaultPanelPath(), sessions: new Map(), dirty: new Set(), warnedAt: new Map(), schemaStale: false, logger: undefined };
  globalThis[PANEL_KEY] = created;
  return created;
}

function liveStore() {
  const current = globalThis[LIVE_KEY];
  if (current instanceof Map) return current;
  const created = new Map();
  globalThis[LIVE_KEY] = created;
  return created;
}

/** 失败告警（同 key 30s 内只报一次；logger 不可用静默）。 */
function warnOnce(current, key, message) {
  const now = Date.now();
  const last = current.warnedAt.get(key);
  if (last !== undefined && now - last < WARN_THROTTLE_MS) return;
  current.warnedAt.set(key, now);
  try { current.logger?.warn?.('[dsh-context-relay] ' + message); } catch { /* logger 不可用忽略 */ }
}

/** 按最近写入顺序淘汰（Map 插入序 = LRU 序；调用方用 delete+set 刷新顺序）。 */
function capSessions(map) {
  while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
}

/** 写一条并刷新 LRU 顺序。 */
function touchSession(map, sessionId, value) {
  map.delete(sessionId);
  map.set(sessionId, value);
  capSessions(map);
}

/** 损坏文件隔离：rename 为 <path>.corrupt-<ts>（同名冲突加序号，绝不覆盖已有备份；失败 undefined）。 */
function quarantineFile(path) {
  const stamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const backup = path + CORRUPT_SUFFIX + stamp + (attempt === 0 ? '' : '-' + attempt);
    if (existsSync(backup)) continue;
    try {
      renameSync(path, backup);
      return backup;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 应用 host 配置（panelPath/logger）；只影响后续读写。 */
export function configurePanelStore(config = {}, logger) {
  const current = store();
  current.path = defaultPanelPath(config);
  if (logger !== undefined) current.logger = logger;
  return current.path;
}

/**
 * 归一化磁盘上的会话记录：保留稀疏性（只保留原记录里出现过的白名单字段），
 * 旧版全字段快照仍按全字段读回；未知键/已删除字段丢弃。
 */
function normalizeStoredRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return normalizePanelState(value);
  const normalized = normalizePanelState(value);
  const record = {};
  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) record[key] = normalized[key];
  }
  return record;
}

/**
 * v0.9.0 #53/D3=A：schema 版本变更 = 会话本地授权失效。只清授权/自决字段
 * （autoCompress/autoHandoff/authorizeNext/autoChoose/autoDecision），保留 defaultOperation/architect 等非授权字段；
 * 只改记录里已存在的键（不扩散 wire 形状），返回是否变化用于标脏。
 */
const EXPIRED_AUTH_FIELDS = Object.freeze({ autoChoose: false, autoCompress: false, autoHandoff: false, authorizeNext: false, autoDecision: null });
function expireAuthorization(record) {
  const next = { ...record };
  let changed = false;
  for (const [key, value] of Object.entries(EXPIRED_AUTH_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || next[key] === value) continue;
    next[key] = value;
    changed = true;
  }
  return { record: next, changed };
}

/**
 * 从文件载入面板状态（幂等）。返回会话 Map。
 * - 文件缺失（首次运行）：正常空载；
 * - 文件损坏/结构畸形：先隔离为 *.corrupt-<ts> 并 warn，**保留内存旧值**（不静默清空旧快照）；
 * - 正常文件：重建 Map（非法 sessionId 跳过，值归一化）。
 */
export function loadPanelStore(config = {}) {
  const current = store();
  if (config !== undefined) current.path = defaultPanelPath(config);
  let raw;
  try {
    raw = JSON.parse(readFileSync(current.path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 文件不存在：正常空载；但若内存里有尚未落盘的修改（上次写盘失败），不能静默丢弃。
      if (current.dirty.size > 0) {
        warnOnce(current, 'load:' + current.path, 'panel store missing but in-memory changes are pending; keeping in-memory sessions');
        return current.sessions;
      }
      current.sessions.clear();
      return current.sessions;
    }
    const backup = quarantineFile(current.path);
    warnOnce(current, 'load:' + current.path,
      'panel store unreadable (' + String(error?.message ?? error) + '); '
      + (backup === undefined ? 'backup failed, keeping in-memory sessions' : 'renamed to ' + backup + ', keeping in-memory sessions'));
    return current.sessions;
  }
  const sessions = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw.sessions : undefined;
  if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) {
    const backup = quarantineFile(current.path);
    warnOnce(current, 'load:' + current.path,
      'panel store malformed (missing "sessions" object); '
      + (backup === undefined ? 'backup failed, keeping in-memory sessions' : 'renamed to ' + backup + ', keeping in-memory sessions'));
    return current.sessions;
  }
  // v0.9.0 #53/D3=A：授权契约版本（schemaVersion）变更 → 旧文件授权一次性失效（幂等；下次写盘落 v2）。
  const storedVersion = raw.schemaVersion;
  const expireAuthorizationOnLoad = storedVersion !== PANEL_SCHEMA_VERSION;
  // M-13：上次写盘失败/未落盘的 dirty 记录不能被一次正常载入静默清掉——先快照，载入磁盘后按
  // sessionId 合并回来（内存值覆盖同名磁盘键、其余磁盘键保留），并保持标脏等下次写盘重试。
  const pending = current.dirty instanceof Set && current.dirty.size > 0
    ? new Map([...current.dirty]
      .map((sessionId) => [sessionId, current.sessions.get(sessionId)])
      .filter(([, record]) => record !== undefined))
    : new Map();
  current.sessions.clear();
  current.dirty.clear();
  current.schemaStale = expireAuthorizationOnLoad;
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (!isValidSessionId(sessionId)) continue;
    const normalized = normalizeStoredRecord(value);
    if (!expireAuthorizationOnLoad) {
      current.sessions.set(sessionId, normalized);
      continue;
    }
    const expired = expireAuthorization(normalized);
    if (expired.changed) current.dirty.add(sessionId); // 标脏：下次自然写盘落 schemaVersion + 失效结果
    current.sessions.set(sessionId, expired.record);
  }
  capSessions(current.sessions);
  if (pending.size > 0) {
    for (const [sessionId, record] of pending) touchSession(current.sessions, sessionId, record);
    for (const sessionId of pending.keys()) current.dirty.add(sessionId);
    warnOnce(current, 'load-merge:' + current.path,
      'panel store reloaded while ' + pending.size + ' session change(s) were pending (last write failed); '
      + 'in-memory values kept over disk and retried on next write');
  }
  if (expireAuthorizationOnLoad) {
    warnOnce(current, 'schema:' + current.path,
      'panel store authorization schema ' + String(storedVersion ?? 'missing') + ' != v' + PANEL_SCHEMA_VERSION
      + ': session-local authorization expired (autoCompress/autoHandoff/authorizeNext/autoChoose/autoDecision); '
      + 'mode/architect preserved; v' + PANEL_SCHEMA_VERSION + ' persists on next write');
  }
  return current.sessions;
}

/** 侧栏设置发布的进程内全局（host apply / settings PUT 时写入）。 */
function panelDefaultsOf() {
  const live = globalThis[SETTINGS_KEY];
  if (live === null || typeof live !== 'object') return undefined;
  return {
    defaultOperation: live.defaultOperation,
    autoChoose: live.autoChoose,
    autoCompress: live.autoCompress,
    autoHandoff: live.autoHandoff,
    // v0.2.7：unlimitedBudget 是侧栏默认字段（UI 控件已移除），作为面板生效值的默认来源；
    // 非布尔（旧/残缺全局设置）按 undefined 交给归一化 → null（跟随规范默认 true）。
    unlimitedBudget: typeof live.unlimitedBudget === 'boolean' ? live.unlimitedBudget : undefined,
    // v0.6.4：专职架构师开关的默认来源（缺省跟随规范默认 true）。
    architect: typeof live.architect === 'boolean' ? live.architect : undefined,
  };
}

/**
 * 面板状态唯一解析入口（读写共用）：合并侧栏默认值 + 会话记录 + 补丁，并固化全部不变量。
 * - 记录通常是稀疏的（agent 只落显式字段），缺失字段回落到侧栏默认值 / 规范默认值；
 * - autoChoose（模型自决档）与显式模式互斥，读时 auto 优先（遗留/旧数据同样处理）；
 * - autoDecision 只在 autoChoose 开启时保留。
 */
export function resolvePanelState({ defaults, record, patch } = {}) {
  const state = normalizePanelState({ ...(defaults ?? {}), ...(record ?? {}), ...(patch ?? {}) });
  if (state.autoChoose === true) state.defaultOperation = null;
  else state.autoDecision = null;
  return state;
}

/** 读一个会话的面板状态（不落库）：会话记录覆盖侧栏默认值，都没有时返回规范默认。 */
export function panelStateOf(sessionId) {
  const defaults = panelDefaultsOf();
  if (!isValidSessionId(sessionId)) return resolvePanelState({ defaults });
  return resolvePanelState({ defaults, record: store().sessions.get(sessionId) });
}

/** 两个归一化状态的语义比较（归一化后键序稳定，JSON 等价即语义相同）。 */
function sameState(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * agent 内部写入的稀疏记录：只落 patch 显式字段（从解析后的生效值取，保证类型/归一化一致）；
 * 不 materialize 侧栏默认值。autoChoose 写入时一并固化其依赖字段，避免记录残留互斥旧值。
 */
function sparseRecord(record, patch, resolved) {
  const next = record !== undefined && record !== null && typeof record === 'object' ? { ...record } : {};
  for (const key of Object.keys(patch)) {
    if (key === 'handoffPreAuthorized') continue; // rev5.5 删除的死字段：旧调用方传入也不落库
    if (!Object.prototype.hasOwnProperty.call(resolved, key)) continue; // 未知键丢弃
    next[key] = resolved[key];
  }
  // 开 auto 时清掉记录里残留的显式模式（不变量在读取侧也兜底）；其余依赖字段不物化。
  if (patch.autoChoose === true) next.defaultOperation = null;
  return next;
}

/**
 * 合并更新一个会话的面板状态并持久化；返回写入后的生效状态（panelStateOf 语义）。
 * options.source：
 *   'panel'（默认）= 人类面板写入 → 整份生效值快照（SPEC V4 语义，此后不再跟随侧栏默认）；
 *   'agent' = agent 内部写入 → 只落 patch 显式字段，不 materialize 侧栏默认值。
 * options.force === true → 即使归一化后与当前生效值完全相同也显式落库：交接继承用——
 *   强制/不注入的值不随后日侧栏默认变化（否则 no-op 会让子会话继续跟随全局默认）。
 * 归一化后与当前生效值完全相同（no-op）→ 不落盘、不创建记录（避免内部写把侧栏默认值固化；force 除外）。
 * options.persist === false → 只改内存，由调用方决定何时 savePanelStore（host PUT 用于上报 persisted）。
 */
export function updatePanelState(sessionId, patch = {}, options = {}) {
  const current = store();
  const defaults = panelDefaultsOf();
  const source = options?.source === 'agent' ? 'agent' : 'panel';
  const safePatch = patch !== null && typeof patch === 'object' ? patch : {};
  if (!isValidSessionId(sessionId)) {
    // 非法会话语义上不落库（路由层已 400；内核 session.id 必合法，这里只是防御）。
    return resolvePanelState({ defaults, patch: safePatch });
  }
  const record = current.sessions.get(sessionId);
  const before = resolvePanelState({ defaults, record });
  const after = resolvePanelState({ defaults, record, patch: safePatch });
  if (!options?.force && sameState(before, after)) return after;
  touchSession(current.sessions, sessionId, source === 'agent' ? sparseRecord(record, safePatch, after) : after);
  current.dirty.add(sessionId);
  if (options?.persist !== false) savePanelStore();
  return after;
}

/**
 * 模式种子（长模式新根会话）：仅当该会话还没有显式面板记录/defaultOperation 时写入。
 * 不覆盖人类显式保存的值（含显式 null=问我）；autoChoose=on（长模式隐藏档）不种——该存档由长模式语义归一处理。
 * 返回是否写入；无效会话/已有显式值时 false（fail-open，不抛）。
 */
export function seedPanelOperation(sessionId, operation) {
  if (!isValidSessionId(sessionId) || !PANEL_OPERATIONS.includes(operation)) return false;
  const record = store().sessions.get(sessionId);
  if (record !== null && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, 'defaultOperation')) return false;
  const before = panelStateOf(sessionId);
  if (before.autoChoose === true || before.defaultOperation === operation) return false;
  updatePanelState(sessionId, { defaultOperation: operation }, { source: 'agent' });
  return true;
}

/**
 * 原子写盘（tmp + rename）。写前 re-read 磁盘并按 sessionId 合并：本实例脏记录覆盖同名键，
 * 其它进程写入的其它会话保留（B-P2-14 跨进程写安全）。无脏记录时直接成功（不重写文件）。
 * 写失败：warn（限频）、保留内存状态并返回 false（调用方据此上报 persisted:false）。
 */
export function savePanelStore() {
  const current = store();
  const dirty = current.dirty instanceof Set ? current.dirty : new Set();
  // 无脏记录时通常不重写；但 schema 迁移后（载入旧版本文件）要写一次 schemaVersion 收口（幂等）。
  if (dirty.size === 0 && current.schemaStale !== true) return true;
  try {
    let diskSessions = {};
    try {
      const raw = JSON.parse(readFileSync(current.path, 'utf8'));
      if (raw !== null && typeof raw === 'object' && raw.sessions !== null && typeof raw.sessions === 'object') diskSessions = raw.sessions;
    } catch { /* 文件不存在/损坏：按空处理（损坏已在 load 侧隔离备份） */ }
    const merged = Object.create(null);
    for (const [sessionId, value] of Object.entries(diskSessions)) {
      if (isValidSessionId(sessionId)) merged[sessionId] = value;
    }
    for (const [sessionId, value] of current.sessions) {
      if (!dirty.has(sessionId)) continue; // 内存里没改过的记录不覆盖磁盘（可能是其它进程的新值）
      delete merged[sessionId];
      merged[sessionId] = value;
    }
    const keys = Object.keys(merged);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete merged[key];
    // 单一持久化层 hostStore（temp+fsync+rename；无跨进程锁、写前重读合并由本函数负责）。
    hostStore().writeAtomic(current.path, JSON.stringify({ schemaVersion: PANEL_SCHEMA_VERSION, sessions: merged }, null, 2) + '\n');
    dirty.clear();
    current.schemaStale = false;
    return true;
  } catch (error) {
    warnOnce(current, 'save:' + current.path,
      'panel store write failed (' + String(error?.code ?? error?.message ?? error) + '); in-memory state kept, changes will retry on next write');
    return false;
  }
}

/** agent 每 step 发布本会话的实时压力/phase（host 的 GET /context-relay/panel 读它）。 */
export function publishLiveState(sessionId, live, now = Date.now()) {
  if (!isValidSessionId(sessionId)) return;
  const map = liveStore();
  map.delete(sessionId); // LRU：刷新最近发布顺序
  map.set(sessionId, {
    band: typeof live?.band === 'string' ? live.band : 'ok',
    used: Number.isFinite(live?.used) ? live.used : undefined,
    window: Number.isFinite(live?.window) ? live.window : undefined,
    ratio: Number.isFinite(live?.ratio) ? live.ratio : undefined,
    phase: typeof live?.phase === 'string' ? live.phase : undefined,
    organizeCount: Number.isInteger(live?.organizeCount) && live.organizeCount >= 0 ? live.organizeCount : undefined,
    overBudget: live?.overBudget === true,
    updatedAt: Number.isFinite(now) ? now : Date.now(),
  });
  capSessions(map);
}

/** 读本会话实时状态：无记录或超过 LIVE_TTL_MS 未更新（stale）返回 undefined。 */
export function liveStateOf(sessionId) {
  if (!isValidSessionId(sessionId)) return undefined;
  const live = liveStore().get(sessionId);
  if (live === undefined) return undefined;
  if (!Number.isFinite(live.updatedAt) || Date.now() - live.updatedAt > LIVE_TTL_MS) return undefined;
  return live;
}

/** 测试/卸载清理：清空进程内两个 Map（不删文件）。 */
export function clearPanelMemory() {
  const current = store();
  current.sessions.clear();
  if (current.dirty instanceof Set) current.dirty.clear();
  if (current.warnedAt instanceof Map) current.warnedAt.clear();
  current.schemaStale = false;
  current.logger = undefined;
  liveStore().clear();
}

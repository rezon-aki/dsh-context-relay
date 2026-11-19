/**
 * dsh-context-relay — agent 平面声明式 reconcile（幂等安装 / 状态 / 卸载）。
 *
 * 一次安装 = 在 agent 自己的作用域（agent.ctx）注入三类 effect：
 *   tools        deny 裁剪（逐名 restrict，fail-open）+ 角色专属工具注册
 *   systemPrompt 影子协议段（同名 section 覆盖 preset 层）
 *   skills       角色专属技能注册（host skills 无 deny：只按 scope 注册，见 lib/skills.js）
 * 安装幂等：同一 agent 重复 ensure 只装一次（去掉 M-02 的双入口重复 restrict/注册）；
 * 卸载：持有注入 fiber，反向切换（preset 从 relay 切走）时 dispose 掉 agent-scope 注册；
 * 无法 dispose 的合成（非常规 composition）记 degradation，不静默。
 *
 * 状态（模块级，单进程共享；ensure.js 是 ESM 规范 URL，不随 agent.js 的 ?relay= 查询串重建）：
 *   RECORDS   agent → record（权威，WeakMap 不阻止 agent 回收）
 *   BY_SESSION sessionId → record（relay_status 以会话回退读取 / 代际清理遍历；有界防泄漏）
 *
 * @module dsh-context-relay/plane/ensure
 */
import { capMap } from '../agent/shared.js';
import { degradation, degradationsOf, seamShape } from '../seams.js';
import { ROLES, roleOfAgent } from './roles.js';

/** agent → record（权威；WeakMap 让已回收 agent 的记录随之消失）。 */
const RECORDS = new WeakMap();
/** sessionId → record（迭代用；relay_status 的调用方若只是 {session} 句柄也读得到状态）。 */
const BY_SESSION = new Map();
/** 会话记录上限（长期宿主防泄漏；超出删最早插入项）。 */
const RECORD_CAP = 500;

const isObject = (value) => value !== null && typeof value === 'object';
const messageOf = (error) => String(error?.message ?? error);

function sessionIdOf(agent) {
  const id = agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function warnOf(runtime, message) {
  try { runtime?.ctx?.logger?.warn?.(message); } catch { /* 日志失败不阻断装配 */ }
}

/** 记录一条降级（seam 名固定为官方 seam：tools/systemPrompt/preset 等；去重由 degradationsOf 做）。 */
function degrade(record, seam, reason, level = 'degraded') {
  try { record.degradations.push(degradation(seam, reason, level)); } catch { /* 降级记录失败不阻断 */ }
}

/** agent 自己的 scope；非常规 composition（缺 ctx/inject）→ undefined，调用方 fail-open。 */
function scopeOf(agent) {
  const scope = agent?.ctx;
  return isObject(scope) && typeof scope.inject === 'function' ? scope : undefined;
}

/** 服务存在性预检：scope.get 不可用（测试/精简句柄）时不预检，照常 inject。 */
function serviceStateOf(scope, name) {
  if (typeof scope?.get !== 'function') return { known: false, value: undefined };
  try { return { known: true, value: scope.get(name) }; } catch { return { known: true, value: undefined }; }
}

/** 在 agent 作用域注入一个 effect（fiber 存入 record，供反向切换 dispose）。 */
function injectEffect(agent, record, seam, serviceName, callback, labels, runtime) {
  const scope = scopeOf(agent);
  if (scope === undefined) {
    for (const label of labels) {
      warnOf(runtime, '[dsh-context-relay] ' + label + ' skipped: agent.ctx unavailable');
      degrade(record, seam, label + ' skipped: agent.ctx unavailable', 'unavailable');
    }
    return;
  }
  const state = serviceStateOf(scope, serviceName);
  if (state.known === true && (state.value === undefined || state.value === null)) {
    for (const label of labels) {
      warnOf(runtime, '[dsh-context-relay] ' + label + ' skipped: ' + serviceName + ' service unavailable');
      degrade(record, seam, label + ' skipped: ' + serviceName + ' service unavailable', 'unavailable');
    }
    return;
  }
  try {
    const fiber = scope.inject([serviceName], callback);
    if (fiber !== undefined && fiber !== null) record.fibers.push({ seam, fiber });
  } catch (error) {
    const reason = messageOf(error);
    for (const label of labels) {
      warnOf(runtime, '[dsh-context-relay] ' + label + ' skipped: ' + reason);
      degrade(record, seam, label + ' skipped: ' + reason);
    }
  }
}

/** 取角色工具组定义（runtime.toolsOf 由 agent.js 提供；异常按空组降级）。 */
function toolDefinitionsOf(record, runtime, group) {
  try {
    const definitions = runtime?.toolsOf?.(group);
    return Array.isArray(definitions) ? definitions : [];
  } catch (error) {
    degrade(record, 'tools', 'tool group "' + group + '" unavailable: ' + messageOf(error));
    return [];
  }
}

/** 工具面：逐名 restrict（未知工具名单名跳过，全部失败才记降级）+ 角色专属工具注册。 */
function installTools(agent, record, role, runtime) {
  const table = ROLES[role];
  const labels = [...table.deny.map((group) => group.label), ...table.tools.map((group) => group.label)];
  injectEffect(agent, record, 'tools', 'tools', (runtimeCtx) => {
    const tools = runtimeCtx?.tools;
    const shape = seamShape('tools', tools);
    if (shape.ok !== true) degrade(record, 'tools', 'tools seam shape: ' + shape.missing.join(', '), 'unavailable');
    const restrict = typeof tools?.restrict === 'function' ? tools.restrict.bind(tools) : undefined;
    for (const group of table.deny) {
      const failed = [];
      let applied = 0;
      for (const name of group.names) {
        if (restrict === undefined) { failed.push(name); continue; }
        try { restrict({ deny: [name] }); applied += 1; } catch { failed.push(name); }
      }
      // 单名失败通常是该平台未注册该工具 → 正常跳过；**全部失败**才 warn（preset 工具面异常/内核改工具名）。
      if (applied === 0 && group.names.length > 0) {
        const reason = group.label + ': no tools restricted (failed: ' + failed.join(',') + ')';
        warnOf(runtime, '[dsh-context-relay] ' + reason);
        degrade(record, 'tools', reason);
      }
    }
    const register = typeof tools?.register === 'function' ? tools.register.bind(tools) : undefined;
    for (const group of table.tools) {
      for (const definition of toolDefinitionsOf(record, runtime, group.group)) {
        if (register === undefined) break;
        try { register(definition); } catch (error) {
          const reason = group.label + ' skipped ' + String(definition?.name ?? '?') + ': ' + messageOf(error);
          warnOf(runtime, '[dsh-context-relay] ' + reason);
          degrade(record, 'tools', reason);
        }
      }
    }
  }, labels, runtime);
}

/** 影子协议段：同名 section 在 agent 层覆盖 preset 层（依赖官方 systemPrompt scoped 同名覆盖语义）。 */
function installSections(agent, record, role, runtime) {
  const table = ROLES[role];
  const labels = table.sections.map((entry) => entry.label ?? entry.name);
  injectEffect(agent, record, 'systemPrompt', 'systemPrompt', (runtimeCtx) => {
    const prompt = runtimeCtx?.systemPrompt;
    const shape = seamShape('systemPrompt', prompt);
    if (shape.ok !== true) degrade(record, 'systemPrompt', 'systemPrompt seam shape: ' + shape.missing.join(', '), 'unavailable');
    for (const entry of table.sections) {
      const label = entry.label ?? entry.name;
      try { prompt?.section?.({ name: entry.name, order: entry.order, text: entry.text }); } catch (error) {
        const reason = label + ' skipped: ' + messageOf(error);
        warnOf(runtime, '[dsh-context-relay] ' + reason);
        degrade(record, 'systemPrompt', reason);
      }
    }
  }, labels, runtime);
}

/** 角色专属技能：在 agent scope 注册（register 落到调用方 scope 层；读时合并 global + scope 链）。
 * 失败只 warn + degradation，不阻断工具/协议段安装。 */
function installSkills(agent, record, role, runtime) {
  const names = ROLES[role].skills;
  if (names.length === 0) return;
  const labels = names.map((name) => 'skill "' + name + '"');
  injectEffect(agent, record, 'skills', 'skills', (runtimeCtx) => {
    const skills = runtimeCtx?.skills;
    const register = typeof skills?.register === 'function' ? skills.register.bind(skills) : undefined;
    for (const name of names) {
      if (register === undefined) {
        const reason = 'skill "' + name + '" skipped: skills.register unavailable';
        warnOf(runtime, '[dsh-context-relay] ' + reason);
        degrade(record, 'skills', reason, 'unavailable');
        continue;
      }
      let definition;
      try { definition = runtime?.skillOf?.(name); } catch (error) {
        const reason = 'skill "' + name + '" skipped: ' + messageOf(error);
        warnOf(runtime, '[dsh-context-relay] ' + reason);
        degrade(record, 'skills', reason);
        continue;
      }
      if (definition === undefined || definition === null) {
        const reason = 'skill "' + name + '" skipped: definition unavailable';
        warnOf(runtime, '[dsh-context-relay] ' + reason);
        degrade(record, 'skills', reason, 'unavailable');
        continue;
      }
      try { register(definition); } catch (error) {
        const reason = 'skill "' + name + '" skipped: ' + messageOf(error);
        warnOf(runtime, '[dsh-context-relay] ' + reason);
        degrade(record, 'skills', reason);
      }
    }
  }, labels, runtime);
}

/**
 * 幂等安装一个 agent 的角色平面。重复调用安全：已安装 → 直接返回（不重复 restrict/注册/section/skill）；
 * 失败/卸载后再次调用会重建（先清旧记录再装）。
 * @param {object} agent live agent（需 session 事实；ctx 是 agent 自己的作用域）
 * @param {{ctx?: object, seed?: Function, isArchitect?: Function, toolsOf?: Function, skillOf?: Function}} [runtime]
 *   ctx 仅用于 logger；seed 是 root Lead 默认档种子；isArchitect 认领架构师；toolsOf(group) 返回工具定义；
 *   skillOf(name) 返回技能注册定义（缺省按 definition unavailable 降级）。
 * @returns {{ok: boolean, role: string|null, installed: boolean, idempotent?: boolean, degradations?: object[]}}
 */
export function ensureAgentPlane(agent, runtime = {}) {
  if (!isObject(agent)) return { ok: false, code: 'invalid-agent', role: null, installed: false };
  const existing = RECORDS.get(agent);
  if (existing !== undefined && existing.installed === true) {
    return { ok: true, role: existing.role, installed: true, idempotent: true };
  }
  const role = roleOfAgent(agent, { isArchitect: runtime.isArchitect });
  const record = existing ?? { role, installed: false, degradations: [], fibers: [], uninstalledReason: undefined };
  // 半装成/失败后重试：先撤掉上一轮 agent-scope 注册，再重新装（幂等 = 只装一次，不叠加）。
  if (existing !== undefined && existing.fibers.length > 0) disposeRecord(existing, 'reinstall');
  record.role = role;
  record.installed = false;
  record.degradations = [];
  record.fibers = [];
  record.uninstalledReason = undefined;
  RECORDS.set(agent, record);
  const sessionId = sessionIdOf(agent);
  if (sessionId !== undefined) { BY_SESSION.set(sessionId, record); capMap(BY_SESSION, RECORD_CAP); }
  // root Lead：新会话默认操作档种子（失败只 warn，不阻断会话创建）。
  if (ROLES[role].seed === true && typeof runtime.seed === 'function') {
    try { runtime.seed(agent); } catch (error) { warnOf(runtime, '[dsh-context-relay] root default seed skipped: ' + messageOf(error)); }
  }
  installTools(agent, record, role, runtime);
  installSections(agent, record, role, runtime);
  installSkills(agent, record, role, runtime);
  // 角色需要的 effect 全部注入成功才算装好；服务缺失/ctx 缺失 → installed=false（relay_status 自检可见）。
  record.installed = record.fibers.length === 2 + (ROLES[role].skills.length > 0 ? 1 : 0);
  return { ok: true, role, installed: record.installed, degradations: degradationsOf(record.degradations) };
}

function recordOf(target) {
  if (isObject(target)) return RECORDS.get(target);
  if (typeof target === 'string') return BY_SESSION.get(target);
  return undefined;
}

/** 卸载一条记录携带的 agent-scope 注册；fiber 不可 dispose（不可逆）→ 记 degraded，不静默。 */
function disposeRecord(record, reason) {
  let incomplete = false;
  for (const cell of record.fibers) {
    const fiber = cell?.fiber;
    const seam = cell?.seam === 'systemPrompt' || cell?.seam === 'skills' ? cell.seam : 'tools';
    try {
      if (fiber !== undefined && fiber !== null && typeof fiber.dispose === 'function') {
        const pending = fiber.dispose();
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(() => {});
      } else {
        incomplete = true;
        degrade(record, seam, 'plane uninstall incomplete (' + reason + '): agent-scope registration is not reversible');
      }
    } catch (error) {
      incomplete = true;
      degrade(record, seam, 'plane uninstall incomplete (' + reason + '): ' + messageOf(error));
    }
  }
  record.fibers = [];
  record.installed = false;
  record.uninstalledReason = String(reason ?? 'manual').slice(0, 80);
  return incomplete === false;
}

/**
 * 卸载一个 agent（或会话）的角色平面：反向切换/显式清理用。dispose agent-scope 注入 fiber，
 * 撤销 restrict/工具注册/影子 section；不可逆时记录 degradation 并返回 clean:false。
 * @param {object|string} target agent 对象或 sessionId
 * @param {string} [reason] 卸载原因（'preset-left' 等，进记录/降级文本）
 * @returns {{ok: boolean, role?: string, clean?: boolean, installed?: boolean, code?: string}}
 */
export function disposePlane(target, reason = 'manual') {
  const record = recordOf(target);
  if (record === undefined) return { ok: false, code: 'not-installed', installed: false };
  const clean = disposeRecord(record, reason);
  return { ok: true, role: record.role, clean, installed: false };
}

/**
 * relay preset 代际卸载时全量清理（反向切换：preset 从 relay 切走）。
 * stillRelay(sessionId) 为 true 的会话仍绑定在另一代 relay 上（迁移期 relay id 别名切换）→ 保留平面。
 * @param {{reason?: string, stillRelay?: (sessionId: string) => boolean}} [options]
 * @returns {{disposed: string[], failed: string[]}}
 */
export function disposeAllPlanes(options = {}) {
  const disposed = [];
  const failed = [];
  for (const [sessionId, record] of [...BY_SESSION.entries()]) {
    // 半装成（部分 seam 注入成功但 installed=false）同样持有 agent-scope 注册 → 必须卸载。
    if (record.installed !== true && record.fibers.length === 0) continue;
    if (typeof options.stillRelay === 'function' && options.stillRelay(sessionId) === true) continue;
    if (disposeRecord(record, options.reason ?? 'preset-left')) disposed.push(sessionId); else failed.push(sessionId);
  }
  return { disposed, failed };
}

/**
 * 读取一个 agent 的平面状态（relay_status.plane 的数据源；永不抛错）。
 * @param {object} agent
 * @returns {{role: string, installed: boolean, degradations: object[]}}
 */
export function planeStatusOf(agent) {
  const record = isObject(agent) ? RECORDS.get(agent) : undefined;
  const fallback = record ?? (() => { const id = sessionIdOf(agent); return id === undefined ? undefined : BY_SESSION.get(id); })();
  if (fallback !== undefined) {
    return { role: fallback.role, installed: fallback.installed === true, degradations: degradationsOf(fallback.degradations) };
  }
  return { role: roleOfAgent(agent), installed: false, degradations: [] };
}

/** 该 agent 是否已被本平面的 ensure 处理过（每步惰性兜底据此避免重复尝试/重复告警）。 */
export function isPlaneTracked(agent) {
  return isObject(agent) && RECORDS.has(agent);
}

/** 清空会话级索引（测试/卸载用；WeakMap 权威记录随 agent 回收，不强清）。 */
export function clearPlaneMemory() {
  BY_SESSION.clear();
}

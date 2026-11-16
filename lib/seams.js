/**
 * dsh-context-relay — 官方 seam 契约层（只支持 DSH 0.2.2-rc.2+）。
 *
 * 9 个官方 seam 各一条**最低必要**形状断言（依据 rc.2 官方源码；见各 check 注释）：
 *   preset       agentPresets：composedPreset(ctx) / select(agent, preset)
 *   agents       agents：list() / get(id) / turnBoundaryOf(session)
 *   tools        tools：register(def) / restrict({deny})
 *   systemPrompt systemPrompt：section({name, order, text})（scoped 同名覆盖依赖它）
 *   compaction   compaction：compactIfNeeded(agent, trigger, signal)、CompactionResult、
 *                compaction/end 事件 data（三个观测点，任一出现即按该点断言）
 *   projections  sessionProjections：register / snapshot / stateOf
 *   schedule     schedule：list / catalog / create / edit；list() 分页对象
 *   wipe         session：surface.nodes / append(type, data, {surfaceOp}) /
 *                eventAt / deriveEventMessage
 *   team         capabilitiesOf(ctx) 输出：kind=subagents + 核心能力清单
 *
 * 契约：探测只读、永不抛错（输入任意值都返回判定对象）；服务缺失/形状不符由调用方
 * 登记降级并向模型/人类可见（不静默 fail-open）。降级记录经 `degradation` 生成、
 * `degradationsOf` 按 seam 去重汇总后进入 relay_status.plane.degradations 与首步 notice。
 *
 * @module dsh-context-relay/seams
 */

const isObject = (value) => value !== null && typeof value === 'object';
const isFunction = (value, name) => typeof value?.[name] === 'function';
const isString = (value) => typeof value === 'string' && value !== '';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isArray = (value) => Array.isArray(value);
const isNullableNumber = (value) => value === null || isNumber(value);

/** 缺失的方法名（value 为 undefined/null/原始值时全部缺失）。 */
function missingMethods(value, names) {
  return names.filter((name) => !isFunction(value, name));
}

/** 缺失的字段名；fields = { name: predicate }。 */
function missingFields(value, fields) {
  const missing = [];
  for (const [name, predicate] of Object.entries(fields)) {
    if (!predicate(isObject(value) ? value[name] : undefined)) missing.push(name);
  }
  return missing;
}

// ── 各 seam 的最低断言 ─────────────────────────────────────────────────────

/** preset：官方 AgentPresetRegistry.composedPreset(ctx) 与 select(agent, preset)。 */
function presetShape(value) {
  return missingMethods(value, ['composedPreset', 'select']);
}

/** agents：官方 AgentRegistry.list() / get(id) / turnBoundaryOf(session)。 */
function agentsShape(value) {
  return missingMethods(value, ['list', 'get', 'turnBoundaryOf']);
}

/** tools：官方 ToolsService.register(definition) / restrict({allow?, deny?})。 */
function toolsShape(value) {
  return missingMethods(value, ['register', 'restrict']);
}

/** systemPrompt：官方 SystemPrompt.section({name, order, text})（agent.ctx 上注册同名 section 覆盖全局）。 */
function systemPromptShape(value) {
  return missingMethods(value, ['section']);
}

/** compaction 返回体字段（官方 CompactionResult 核心：identity/边界/遮蔽集/释放量）。 */
const COMPACTION_RESULT_FIELDS = Object.freeze({
  compactionId: isString,
  endSeq: isNumber,
  shadowedSeqs: isArray,
  shadowedTokenCount: isNumber,
});

/** compaction/end 事件 data（官方：compactionId + turn，error 可选）。 */
const COMPACTION_END_FIELDS = Object.freeze({
  compactionId: isString,
  turn: isNullableNumber,
});

/**
 * compaction：三个观测点——
 *   引擎：compactIfNeeded(agent, trigger, signal)（relay organize/freshen 唯一调用面）；
 *   返回：CompactionResult（读 compactionId/shadowedSeqs/shadowedTokenCount）；
 *   事件：compaction/end data（投影按 data.error 判定成功压缩）。
 */
function compactionShape(value) {
  if (isObject(value) && value.type === 'compaction/end') {
    return missingFields(value.data, COMPACTION_END_FIELDS);
  }
  if (isFunction(value, 'compactIfNeeded') || isFunction(value, 'compactNow') || isFunction(value, 'compactRegion')) {
    return missingMethods(value, ['compactIfNeeded']);
  }
  if (isObject(value) && ('endSeq' in value || 'shadowedSeqs' in value || 'compactionId' in value)) {
    return missingFields(value, COMPACTION_RESULT_FIELDS);
  }
  return ['compaction engine/result/event'];
}

/** projections：官方 SessionProjectionRegistry.register(definition) / snapshot(session, keys) / stateOf(session, key)。 */
function projectionsShape(value) {
  return missingMethods(value, ['register', 'snapshot', 'stateOf']);
}

/** schedule list() 分页返回体（官方 ScheduleListResult；数组是旧 shape）。 */
const SCHEDULE_PAGE_FIELDS = Object.freeze({
  items: isArray,
  shown: isNumber,
  total: isNumber,
  limit: isNumber,
  offset: isNumber,
});

/**
 * schedule：官方 ScheduleService.list(request?) / catalog() / create(request) / edit(request)；
 * list() 返回分页对象（非数组），create 请求 {title, prompt, timing, target?}。
 * 或传入 list() 的分页结果，单独断言返回形状（M-01 的静默断裂点）。
 */
function scheduleShape(value) {
  const methods = ['list', 'catalog', 'create', 'edit'];
  if (methods.some((name) => isFunction(value, name))) return missingMethods(value, methods);
  if (isObject(value)) return missingFields(value, SCHEDULE_PAGE_FIELDS);
  return ['schedule service/list page'];
}

/**
 * wipe：官方 Session 的 surfaceOp replace 面——surface.nodes（当前可见 seq）、
 * append(type, data, {surfaceOp: {op: 'replace', startSeq, endSeq}}) 返回 {seq}、
 * eventAt(seq) / deriveEventMessage(event)（node0 必须是 system）。
 */
function wipeShape(value) {
  const missing = [];
  if (!isArray(value?.surface?.nodes)) missing.push('surface.nodes');
  for (const name of ['append', 'eventAt', 'deriveEventMessage']) {
    if (!isFunction(value, name)) missing.push(name);
  }
  return missing;
}

/** team 核心能力（capabilitiesOf 输出）：成员身份/枚举/发消息/新建；interrupt/drain 属清理能力，缺失只降级不判坏。 */
const TEAM_CAPABILITIES = Object.freeze(['role', 'listMembers', 'send', 'spawn']);

/** team：官方 subagents 树的 capabilitiesOf(ctx) 输出（kind=subagents 即 rootOf/namesOf 探测成立）。 */
function teamShape(value) {
  if (!isObject(value) || typeof value.kind !== 'string') return ['capabilities kind'];
  const missing = [];
  if (value.kind !== 'subagents') missing.push('kind=subagents');
  for (const name of TEAM_CAPABILITIES) {
    if (value[name] !== true) missing.push('capability.' + name);
  }
  return missing;
}

const CHECKS = Object.freeze({
  preset: presetShape,
  agents: agentsShape,
  tools: toolsShape,
  systemPrompt: systemPromptShape,
  compaction: compactionShape,
  projections: projectionsShape,
  schedule: scheduleShape,
  wipe: wipeShape,
  team: teamShape,
});

// ── 导出 API ──────────────────────────────────────────────────────────────

/**
 * 判定一个 seam 的观测值是否符合 rc.2 最低形状。
 * 只读、永不抛错；未知 seam 名返回 ok:false（显式降级，不 fail-open）。
 * @param {string} name 9 个 seam 名之一：preset/agents/tools/systemPrompt/compaction/projections/schedule/wipe/team
 * @param {unknown} value 待判定的服务/结果/事件/会话对象
 * @returns {{ok: boolean, missing: string[]}}
 */
export function seamShape(name, value) {
  const check = CHECKS[name];
  if (typeof check !== 'function') return { ok: false, missing: ['unknown seam "' + String(name) + '"'] };
  let missing;
  try {
    missing = check(value);
  } catch (error) {
    // 观测值带恶意/失效 getter 时也只降级，不打断调用方。
    missing = ['seam probe failed: ' + String(error?.message ?? error)];
  }
  return { ok: missing.length === 0, missing };
}

const LEVELS = new Set(['degraded', 'unavailable']);

/**
 * 生成一条降级记录。level: degraded（服务在但不符形状/能力缺失）或
 * unavailable（服务未装配，调用方明确告知）——缺省 degraded。
 * @param {string} seam seam 名
 * @param {string|string[]} reason 降级原因（数组自动拼接，通常是 seamShape().missing）
 * @param {'degraded'|'unavailable'} [level] 降级级别
 * @returns {{seam: string, reason: string, level: 'degraded'|'unavailable'}}
 */
export function degradation(seam, reason, level = 'degraded') {
  return {
    seam: String(seam ?? ''),
    reason: Array.isArray(reason) ? reason.join(', ') : String(reason ?? ''),
    level: LEVELS.has(level) ? level : 'degraded',
  };
}

/**
 * 汇总/去重降级记录：接受（嵌套）数组，按 seam 合并——reason 去重后 `; ` 拼接、
 * level 取最严重（unavailable > degraded），输出顺序按首次出现。非法记录忽略。
 * @param {unknown} records degradation() 记录（可嵌套数组）
 * @returns {{seam: string, reason: string, level: 'degraded'|'unavailable'}[]}
 */
export function degradationsOf(records) {
  const order = [];
  const merged = new Map();
  const visit = (list) => {
    for (const record of isArray(list) ? list : [list]) {
      if (isArray(record)) { visit(record); continue; }
      if (!isObject(record) || typeof record.seam !== 'string' || record.seam === '') continue;
      const level = record.level === 'unavailable' ? 'unavailable' : 'degraded';
      const reason = isString(record.reason) ? record.reason : String(record.reason ?? '');
      const current = merged.get(record.seam);
      if (current === undefined) {
        order.push(record.seam);
        merged.set(record.seam, { reasons: reason === '' ? [] : [reason], level });
        continue;
      }
      if (reason !== '' && !current.reasons.includes(reason)) current.reasons.push(reason);
      if (level === 'unavailable') current.level = 'unavailable';
    }
  };
  visit(records);
  return order.map((seam) => {
    const entry = merged.get(seam);
    return { seam, reason: entry.reasons.join('; '), level: entry.level };
  });
}

/**
 * dsh-context-relay — 团队能力适配层（只支持 DSH 0.2.2-rc.2+）。
 *
 * rc.2 起 `@deepseek-ai/dsh-agent-team` 只剩共享任务板，队友由 `subagents` 的
 * subagent 树表达；本模块业务代码只调语义函数，不直接碰服务形状。
 *
 * 能力探测：`subagents.rootOf` + `subagents.namesOf` 存在 → subagents；否则 none。
 * 降级契约：拿不到等价能力时返回 `{ok:false, code, reason}`，绝不抛异常；
 * rc.2 没有逐 id 释放（drainChildren）→ 明确 unsupported。
 *
 * @module dsh-context-relay/team-api
 */

export const TEAM_SUBAGENTS = 'subagents';
export const TEAM_NONE = 'none';

function serviceOf(ctx, name) {
  try { return ctx?.get?.(name); } catch { return undefined; }
}

function reasonOf(error) {
  return String(error?.message ?? error).slice(0, 200);
}

function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** 进程内 Agent 注册表：rc.2 的“running”是 agent.status，不是 catalog 的 activity（后者只表示驻留）。 */
function agentsOf(ctx) {
  try { return ctx?.get?.('agents'); } catch { return undefined; }
}

function memberStatusOf(ctx, id) {
  const agent = agentsOf(ctx)?.get?.(id);
  return agent?.status === 'running' ? 'running' : 'inactive';
}

/** 子智能体树深度：header.delegationDepth 优先；缺失时用 namesOf.self 的路径层数兜底。 */
function depthOf(caller, self) {
  const headerDepth = caller?.session?.header?.delegationDepth;
  if (Number.isInteger(headerDepth) && headerDepth >= 0) return headerDepth;
  if (self === 'lead') return 0;
  if (typeof self === 'string' && self.includes('/')) return self.split('/').length;
  return 1;
}

/** 适配层当前后端：subagents / none。只读探测，不抛。 */
export function teamKindOf(ctx) {
  const subagents = serviceOf(ctx, 'subagents');
  if (subagents !== undefined && subagents !== null && typeof subagents.rootOf === 'function' && typeof subagents.namesOf === 'function') return TEAM_SUBAGENTS;
  return TEAM_NONE;
}

/** 团队能力清单（调用方据此给明确降级原因，而不是猜方法是否存在）。 */
export function capabilitiesOf(ctx) {
  const kind = teamKindOf(ctx);
  if (kind !== TEAM_SUBAGENTS) {
    return { kind, role: false, listMembers: false, syncMembers: false, send: false, interrupt: false, spawn: false, drainSelected: false };
  }
  const subagents = serviceOf(ctx, 'subagents');
  return {
    kind,
    role: true,
    listMembers: typeof subagents.listDescendants === 'function',
    syncMembers: false,
    send: typeof subagents.sendMessage === 'function',
    interrupt: typeof subagents.interrupt === 'function',
    spawn: typeof subagents.startActivation === 'function',
    drainSelected: false,
  };
}

/** 团队记录分区的 Lead 会话 id（subagents: root session id）。 */
export function rootSessionIdOf(membership) {
  const root = membership?.root;
  const id = root?.session?.id ?? root?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * 角色详情（永不抛）：ok:true 且 membership 可能 undefined（服务在、但不是团队成员）；
 * ok:false 的 code 为 no-service / unavailable。
 * membership 形状：{ root, id, role, name, parent?, depth, direct, kind }。
 */
export function roleOfDetailed(ctx, caller) {
  if (caller === undefined || caller === null) return { ok: false, code: 'unavailable', reason: 'caller unavailable' };
  // ctx.get 本身抛错 = 服务层异常（不是「没有团队服务」）：调用方必须保守处理，不能当成普通子代理。
  try { ctx?.get?.('subagents'); } catch (error) {
    return { ok: false, code: 'unavailable', reason: 'team service lookup failed: ' + reasonOf(error) };
  }
  const kind = teamKindOf(ctx);
  if (kind === TEAM_NONE) return { ok: false, code: 'no-service', reason: 'subagents unavailable' };
  try {
    const subagents = serviceOf(ctx, 'subagents');
    const root = subagents.rootOf(caller);
    const names = subagents.namesOf(caller);
    const id = sessionIdOf(caller);
    const rootId = sessionIdOf(root);
    const role = id !== undefined && id === rootId ? 'lead' : 'teammate';
    const self = typeof names?.self === 'string' && names.self !== '' ? names.self : (role === 'lead' ? 'lead' : id);
    const depth = role === 'lead' ? 0 : depthOf(caller, self);
    return {
      ok: true,
      kind,
      membership: {
        kind,
        root,
        id,
        role,
        name: self,
        ...(typeof names?.parent === 'string' && names.parent !== '' ? { parent: names.parent } : {}),
        depth,
        direct: role === 'teammate' && depth === 1,
      },
    };
  } catch (error) {
    return { ok: false, kind, code: 'unavailable', reason: 'subagents tree lookup failed: ' + reasonOf(error) };
  }
}

/** 便捷版：拿不到就 undefined；role 用 `roleOf(ctx, caller)?.role`。 */
export function roleOf(ctx, caller) {
  const detail = roleOfDetailed(ctx, caller);
  return detail.ok ? detail.membership : undefined;
}

/** 把 subagents.listDescendants 的 child 行映射成 TeamMemberView 形状（role=teammate）。 */
function memberOfDescendant(ctx, entry) {
  const name = typeof entry.path === 'string' && entry.path !== ''
    ? entry.path
    : (typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id);
  return {
    id: entry.id,
    name,
    role: 'teammate',
    // catalog 的 activity 只表示“会话驻留”，空闲 parked 队友也是 running；
    // 模型侧状态与官方 list_agents 同口径，读 agent.status。
    status: memberStatusOf(ctx, entry.id),
    ...(typeof entry.label === 'string' ? { description: entry.label } : {}),
    mode: entry.mode,
    depth: entry.depth,
    parentId: entry.parentId,
    direct: entry.depth === 1,
    ...(entry.hasChildren === true ? { hasChildren: true } : {}),
  };
}

/**
 * 列出当前 Lead 的成员（async）。返回 `{ok:true, kind, members}` 或 `{ok:false, code, reason}`。
 * 用 listDescendants(root) 映射为 teammate。
 */
export async function listMembers(ctx, caller, { signal } = {}) {
  const kind = teamKindOf(ctx);
  if (kind !== TEAM_SUBAGENTS) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  const subagents = serviceOf(ctx, 'subagents');
  if (typeof subagents.listDescendants !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.listDescendants unavailable' };
  try {
    const root = subagents.rootOf(caller);
    const rootId = sessionIdOf(root);
    if (rootId === undefined) return { ok: false, kind, code: 'unavailable', reason: 'subagent tree root has no session id' };
    const entries = await subagents.listDescendants(rootId, signal);
    const members = [];
    const diagnostics = [];
    let deeper = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.kind === 'diagnostic') { diagnostics.push({ id: entry.id, reason: entry.reason }); continue; }
      if (entry?.kind !== 'child' || typeof entry.id !== 'string') continue;
      if (entry.depth !== 1) { deeper += 1; continue; }
      // 与官方 list_agents 同口径：只有 continuable 的直属子智能体才是“队友”；
      // one-shot/external 是执行子任务，不是可 checkpoint/freshen/renew 的成员。
      if (entry.mode !== 'continuable') continue;
      members.push(memberOfDescendant(ctx, entry));
    }
    return { ok: true, kind, members, diagnostics, deeper };
  } catch (error) {
    return { ok: false, kind, code: 'unavailable', reason: 'subagents.listDescendants failed: ' + reasonOf(error) };
  }
}

/** 成员列表只有异步能力：同步调用方据此跳过同步闸门。 */
export function listMembersSync(ctx) {
  const kind = teamKindOf(ctx);
  return {
    ok: false,
    kind,
    code: kind === TEAM_SUBAGENTS ? 'async-only' : 'no-service',
    reason: kind === TEAM_SUBAGENTS ? 'subagents listing is asynchronous' : 'subagents unavailable',
  };
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
}

/**
 * 给成员发消息（async）。target 可以是 member 对象、成员名、'lead' 或 session id。
 * 返回 `{ok:true, messageId}` 或 `{ok:false, code, reason}`。
 */
export async function sendToMember(ctx, caller, target, content, { signal } = {}) {
  const kind = teamKindOf(ctx);
  if (kind !== TEAM_SUBAGENTS) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  const subagents = serviceOf(ctx, 'subagents');
  if (typeof subagents.sendMessage !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.sendMessage unavailable' };
  const abort = signal ?? new AbortController().signal;
  const blocks = contentBlocks(content);
  const resolved = await resolveTargetId(ctx, caller, target, abort);
  if (!resolved.ok) return resolved;
  try {
    const messageId = await subagents.sendMessage(caller, resolved.id, blocks, { signal: abort });
    return { ok: true, kind, messageId };
  } catch (error) {
    return { ok: false, kind, code: 'send-failed', reason: reasonOf(error) };
  }
}

/** 解析消息/中断目标：member.id / 'lead' / 成员名 / session id。 */
async function resolveTargetId(ctx, caller, target, signal) {
  const kind = teamKindOf(ctx);
  if (target !== null && typeof target === 'object' && typeof target.id === 'string' && target.id !== '') return { ok: true, kind, id: target.id };
  const text = typeof target === 'string' ? target.trim() : '';
  if (text === '') return { ok: false, kind, code: 'invalid-target', reason: 'target required' };
  const subagents = serviceOf(ctx, 'subagents');
  try {
    const root = subagents.rootOf(caller);
    const rootId = sessionIdOf(root);
    if (text === 'lead' || text === 'root') {
      if (rootId === undefined) return { ok: false, kind, code: 'invalid-target', reason: 'subagent tree root has no session id' };
      return { ok: true, kind, id: rootId };
    }
    const resolved = await subagents.resolveName(caller, text, signal);
    if (typeof resolved === 'string' && resolved !== '') return { ok: true, kind, id: resolved };
    return { ok: false, kind, code: 'not-found', reason: 'no team member named ' + text };
  } catch (error) {
    return { ok: false, kind, code: 'not-found', reason: 'could not resolve member ' + text + ': ' + reasonOf(error) };
  }
}

/** 中断一个成员（async）。target 可以是 member 对象或成员名；返回 `{ok:true}` / `{ok:false,...}`。 */
export async function interruptMember(ctx, caller, target) {
  const kind = teamKindOf(ctx);
  if (kind !== TEAM_SUBAGENTS) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  const subagents = serviceOf(ctx, 'subagents');
  if (typeof subagents.interrupt !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.interrupt unavailable' };
  const resolved = await resolveTargetId(ctx, caller, target, new AbortController().signal);
  if (!resolved.ok) return resolved;
  try { subagents.interrupt(resolved.id, { kind: 'ancestor', agent: caller }); return { ok: true, kind, id: resolved.id }; } catch (error) { return { ok: false, kind, code: 'interrupt-failed', reason: reasonOf(error) }; }
}

/** 选择新建 provider：优先 spawn-in-process，退回官方默认 spawn。 */
function spawnProviderOf(subagents) {
  if (typeof subagents?.getProvider !== 'function') return 'spawn';
  for (const name of ['spawn-in-process', 'spawn']) {
    try { if (subagents.getProvider(name) !== undefined) return name; } catch { /* 继续看下一个 */ }
  }
  return 'spawn';
}

/**
 * 新建一个成员（async）：startActivation（continuable child）。
 * 返回 `{ok:true, member:{id,name,status,role}}` 或 `{ok:false, code:'member-limit'|'spawn-failed'|..., reason}`。
 */
export async function startMember(ctx, caller, { name, description, prompt, provider, signal, agentOptions } = {}) {
  const kind = teamKindOf(ctx);
  if (kind !== TEAM_SUBAGENTS) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  const subagents = serviceOf(ctx, 'subagents');
  const abort = signal ?? new AbortController().signal;
  const blocks = contentBlocks(prompt);
  if (typeof subagents.startActivation !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.startActivation unavailable' };
  try {
    const requested = typeof provider === 'string' && provider !== '' ? provider : undefined;
    const registered = requested !== undefined && (typeof subagents.getProvider !== 'function' || subagents.getProvider(requested) !== undefined);
    const activation = await subagents.startActivation({
      provider: registered ? requested : spawnProviderOf(subagents),
      ...(typeof description === 'string' && description !== '' ? { label: description } : { label: name ?? 'teammate' }),
      ...(typeof name === 'string' && name !== '' ? { name } : {}),
      prompt: blocks,
      parent: caller,
      signal: abort,
      delivery: 'parent',
      ...(agentOptions !== undefined && agentOptions !== null && typeof agentOptions === 'object' ? { agentOptions } : {}),
    });
    // 消费 result 的 rejection（子级模型/传输失败走 stopReason，基础设施失败才会 reject）；
    // 不观察会留下未处理的 Promise rejection。
    try { activation?.result?.catch?.(() => {}); } catch { /* 非标准 provider 返回值 */ }
    return { ok: true, kind, member: { id: activation?.childId, name: activation?.name ?? name, status: 'provisioning', role: 'teammate' }, activation };
  } catch (error) {
    const message = reasonOf(error);
    return { ok: false, kind, code: /limit|capacity|maxActive|too many/i.test(message) ? 'member-limit' : 'spawn-failed', reason: message };
  }
}

/**
 * 直接子会话列表（release 用）：从 listDescendants 过滤 depth=1。
 * 返回 `{ok:true, rows}` / `{ok:false, reason}`；rows 形状对齐 SubagentCatalogEntry。
 */
export async function listChildren(ctx, parentSessionId) {
  const kind = teamKindOf(ctx);
  const subagents = serviceOf(ctx, 'subagents');
  if (subagents === undefined) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  try {
    if (typeof subagents.listDescendants !== 'function') {
      return { ok: false, kind, code: 'unsupported', reason: 'subagents.listDescendants unavailable' };
    }
    const entries = await subagents.listDescendants(parentSessionId);
    const rows = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.kind === 'child' && entry.parentId === parentSessionId)
      .map((entry) => ({ id: entry.id, createdAt: 0, mode: entry.mode, label: entry.label, activity: entry.activity }));
    return { ok: true, kind, rows };
  } catch (error) {
    return { ok: false, kind, code: 'unavailable', reason: reasonOf(error) };
  }
}

/**
 * 释放指定子会话（release 用）：rc.2 只有 drainDescendants(parents)
 * （释放整棵树），没有逐 id 释放的等价能力 → 明确 unsupported。
 */
export async function drainChildren(ctx, caller, ids) {
  const kind = teamKindOf(ctx);
  const subagents = serviceOf(ctx, 'subagents');
  if (subagents === undefined) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  return { ok: false, kind, code: 'unsupported', reason: 'subagents exposes drainDescendants(parents) only; selected-child drain is unavailable' };
}

/**
 * dsh-context-relay — 团队能力适配层。
 *
 * DSH 0.2.1/0.2.2-rc.1 用 `agentTeams`（experimental agent-team）表达队友；
 * 0.2.2-rc.2 起 `@deepseek-ai/dsh-agent-team` 只剩共享任务板，队友改由
 * `subagents` 的 subagent 树表达。本模块把差异收在一处，业务代码只调语义函数。
 *
 * 能力探测：
 * - `agentTeams.tryMembership` 存在 → legacy（rc.1 路径，行为不变）
 * - 否则 `subagents.rootOf` + `subagents.namesOf` 存在 → subagents（rc.2 路径）
 * - 都没有 → none
 *
 * 降级契约（rc.2）：拿不到等价能力时返回 `{ok:false, code, reason}`，绝不抛异常；
 * rc.2 没有的逐 id 释放（drainChildren）明确返回 unsupported。
 *
 * @module dsh-context-relay/team-api
 */

export const TEAM_LEGACY = 'legacy';
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

/** 适配层当前后端：legacy / subagents / none。只读探测，不抛。 */
export function teamKindOf(ctx) {
  const teams = serviceOf(ctx, 'agentTeams');
  if (teams !== undefined && teams !== null && typeof teams.tryMembership === 'function') return TEAM_LEGACY;
  const subagents = serviceOf(ctx, 'subagents');
  if (subagents !== undefined && subagents !== null && typeof subagents.rootOf === 'function' && typeof subagents.namesOf === 'function') return TEAM_SUBAGENTS;
  return TEAM_NONE;
}

/** 团队能力清单（调用方据此给明确降级原因，而不是猜方法是否存在）。 */
export function capabilitiesOf(ctx) {
  const kind = teamKindOf(ctx);
  if (kind === TEAM_LEGACY) {
    const teams = serviceOf(ctx, 'agentTeams');
    return {
      kind,
      role: true,
      listMembers: typeof teams?.listMembers === 'function',
      syncMembers: typeof teams?.listMembers === 'function',
      send: typeof teams?.sendMessage === 'function',
      interrupt: typeof teams?.interrupt === 'function',
      spawn: typeof teams?.spawnTeammate === 'function',
      drainSelected: true,
    };
  }
  if (kind === TEAM_SUBAGENTS) {
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
  return { kind, role: false, listMembers: false, syncMembers: false, send: false, interrupt: false, spawn: false, drainSelected: false };
}

/** 团队记录分区的 Lead 会话 id（legacy: root.session.id；subagents: root session id）。 */
export function rootSessionIdOf(membership) {
  const root = membership?.root;
  const id = root?.session?.id ?? root?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * 角色详情（永不抛）：ok:true 且 membership 可能 undefined（服务在、但不是团队成员）；
 * ok:false 的 code 为 no-service / unavailable。
 * membership 形状与 rc.1 TeamMembership 对齐：{ root, id, role, name, kind }。
 */
export function roleOfDetailed(ctx, caller) {
  if (caller === undefined || caller === null) return { ok: false, code: 'unavailable', reason: 'caller unavailable' };
  // ctx.get 本身抛错 = 服务层异常（不是「没有团队服务」）：调用方必须保守处理，不能当成普通子代理。
  try { ctx?.get?.('agentTeams'); ctx?.get?.('subagents'); } catch (error) {
    return { ok: false, code: 'unavailable', reason: 'team service lookup failed: ' + reasonOf(error) };
  }
  const kind = teamKindOf(ctx);
  if (kind === TEAM_NONE) return { ok: false, code: 'no-service', reason: 'agentTeams/subagents unavailable' };
  if (kind === TEAM_LEGACY) {
    try {
      const membership = serviceOf(ctx, 'agentTeams').tryMembership(caller);
      return { ok: true, kind, membership: membership === null ? undefined : membership };
    } catch (error) {
      return { ok: false, kind, code: 'unavailable', reason: 'agentTeams.tryMembership failed: ' + reasonOf(error) };
    }
  }
  try {
    const subagents = serviceOf(ctx, 'subagents');
    const root = subagents.rootOf(caller);
    const names = subagents.namesOf(caller);
    const role = sessionIdOf(caller) !== undefined && sessionIdOf(caller) === sessionIdOf(root) ? 'lead' : 'teammate';
    return {
      ok: true,
      kind,
      membership: { kind, root, id: sessionIdOf(caller), role, name: typeof names?.self === 'string' ? names.self : (role === 'lead' ? 'lead' : sessionIdOf(caller)) },
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
function memberOfDescendant(entry) {
  const name = typeof entry.path === 'string' && entry.path !== ''
    ? entry.path
    : (typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id);
  return {
    id: entry.id,
    name,
    role: 'teammate',
    status: entry.activity === 'running' ? 'running' : 'inactive',
    ...(typeof entry.label === 'string' ? { description: entry.label } : {}),
    mode: entry.mode,
    depth: entry.depth,
    parentId: entry.parentId,
  };
}

/**
 * 列出当前 Lead 的成员（async）。返回 `{ok:true, kind, members}` 或 `{ok:false, code, reason}`。
 * rc.1 直接转 listMembers(caller)；rc.2 用 listDescendants(root) 映射为 teammate。
 */
export async function listMembers(ctx, caller, { signal } = {}) {
  const kind = teamKindOf(ctx);
  if (kind === TEAM_LEGACY) {
    const teams = serviceOf(ctx, 'agentTeams');
    if (typeof teams?.listMembers !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'agentTeams.listMembers unavailable' };
    try {
      const members = teams.listMembers(caller);
      if (!Array.isArray(members)) return { ok: false, kind, code: 'unavailable', reason: 'agentTeams.listMembers returned a non-array' };
      return { ok: true, kind, members };
    } catch (error) {
      return { ok: false, kind, code: 'unavailable', reason: 'agentTeams.listMembers failed: ' + reasonOf(error) };
    }
  }
  if (kind === TEAM_SUBAGENTS) {
    const subagents = serviceOf(ctx, 'subagents');
    if (typeof subagents.listDescendants !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.listDescendants unavailable' };
    try {
      const root = subagents.rootOf(caller);
      const rootId = sessionIdOf(root);
      if (rootId === undefined) return { ok: false, kind, code: 'unavailable', reason: 'subagent tree root has no session id' };
      const entries = await subagents.listDescendants(rootId, signal);
      const members = [];
      const diagnostics = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry?.kind === 'diagnostic') { diagnostics.push({ id: entry.id, reason: entry.reason }); continue; }
        if (entry?.kind !== 'child' || typeof entry.id !== 'string') continue;
        members.push(memberOfDescendant(entry));
      }
      return { ok: true, kind, members, diagnostics };
    } catch (error) {
      return { ok: false, kind, code: 'unavailable', reason: 'subagents.listDescendants failed: ' + reasonOf(error) };
    }
  }
  return { ok: false, kind, code: 'no-service', reason: 'agentTeams/subagents unavailable' };
}

/** 同步成员列表：只有 rc.1 有同步能力；rc.2 返回 unsupported（调用方据此跳过同步闸门）。 */
export function listMembersSync(ctx, caller) {
  const kind = teamKindOf(ctx);
  if (kind !== TEAM_LEGACY) return { ok: false, kind, code: kind === TEAM_SUBAGENTS ? 'async-only' : 'no-service', reason: kind === TEAM_SUBAGENTS ? 'subagents listing is asynchronous' : 'agentTeams/subagents unavailable' };
  const teams = serviceOf(ctx, 'agentTeams');
  if (typeof teams?.listMembers !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'agentTeams.listMembers unavailable' };
  try {
    const members = teams.listMembers(caller);
    if (!Array.isArray(members)) return { ok: false, kind, code: 'unavailable', reason: 'agentTeams.listMembers returned a non-array' };
    return { ok: true, kind, members };
  } catch (error) {
    return { ok: false, kind, code: 'unavailable', reason: 'agentTeams.listMembers failed: ' + reasonOf(error) };
  }
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
  const blocks = contentBlocks(content);
  const abort = signal ?? new AbortController().signal;
  if (kind === TEAM_LEGACY) {
    const teams = serviceOf(ctx, 'agentTeams');
    if (typeof teams?.sendMessage !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'agentTeams.sendMessage unavailable' };
    const name = typeof target === 'string' ? target : target?.name ?? target?.id;
    if (typeof name !== 'string' || name === '') return { ok: false, kind, code: 'invalid-target', reason: 'target name required' };
    try {
      const result = await teams.sendMessage(caller, { target: name, content: blocks, signal: abort });
      return { ok: true, kind, messageId: result?.messageId };
    } catch (error) {
      return { ok: false, kind, code: 'send-failed', reason: reasonOf(error) };
    }
  }
  if (kind === TEAM_SUBAGENTS) {
    const subagents = serviceOf(ctx, 'subagents');
    if (typeof subagents.sendMessage !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.sendMessage unavailable' };
    const resolved = await resolveTargetId(ctx, caller, target, abort);
    if (!resolved.ok) return resolved;
    try {
      const messageId = await subagents.sendMessage(caller, resolved.id, blocks, { signal: abort });
      return { ok: true, kind, messageId };
    } catch (error) {
      return { ok: false, kind, code: 'send-failed', reason: reasonOf(error) };
    }
  }
  return { ok: false, kind, code: 'no-service', reason: 'agentTeams/subagents unavailable' };
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
  if (kind === TEAM_LEGACY) {
    const teams = serviceOf(ctx, 'agentTeams');
    if (typeof teams?.interrupt !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'agentTeams.interrupt unavailable' };
    const name = typeof target === 'string' ? target : target?.name;
    if (typeof name !== 'string' || name === '') return { ok: false, kind, code: 'invalid-target', reason: 'target name required' };
    try { teams.interrupt(caller, name); return { ok: true, kind }; } catch (error) { return { ok: false, kind, code: 'interrupt-failed', reason: reasonOf(error) }; }
  }
  if (kind === TEAM_SUBAGENTS) {
    const subagents = serviceOf(ctx, 'subagents');
    if (typeof subagents.interrupt !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.interrupt unavailable' };
    const resolved = await resolveTargetId(ctx, caller, target, new AbortController().signal);
    if (!resolved.ok) return resolved;
    try { subagents.interrupt(resolved.id, { kind: 'ancestor', agent: caller }); return { ok: true, kind, id: resolved.id }; } catch (error) { return { ok: false, kind, code: 'interrupt-failed', reason: reasonOf(error) }; }
  }
  return { ok: false, kind, code: 'no-service', reason: 'agentTeams/subagents unavailable' };
}

/** 选择 rc.2 的新建 provider：优先 spawn-in-process，退回官方默认 spawn。 */
function spawnProviderOf(subagents) {
  if (typeof subagents?.getProvider !== 'function') return 'spawn';
  for (const name of ['spawn-in-process', 'spawn']) {
    try { if (subagents.getProvider(name) !== undefined) return name; } catch { /* 继续看下一个 */ }
  }
  return 'spawn';
}

/**
 * 新建一个成员（async）。legacy 走 spawnTeammate，rc.2 走 startActivation（continuable child）。
 * 返回 `{ok:true, member:{id,name,status,role}}` 或 `{ok:false, code:'member-limit'|'spawn-failed'|..., reason}`。
 */
export async function startMember(ctx, caller, { name, description, prompt, provider, signal } = {}) {
  const kind = teamKindOf(ctx);
  const abort = signal ?? new AbortController().signal;
  const blocks = contentBlocks(prompt);
  if (kind === TEAM_LEGACY) {
    const teams = serviceOf(ctx, 'agentTeams');
    if (typeof teams?.spawnTeammate !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'agentTeams.spawnTeammate unavailable' };
    try {
      const result = await teams.spawnTeammate(caller, { name, description, prompt: blocks, context: 'fresh', provider: typeof provider === 'string' && provider !== '' ? provider : 'spawn', signal: abort });
      return { ok: true, kind, member: result?.member };
    } catch (error) {
      const message = reasonOf(error);
      return { ok: false, kind, code: /TEAM_MEMBER_LIMIT|member limit/i.test(message) ? 'member-limit' : 'spawn-failed', reason: message };
    }
  }
  if (kind === TEAM_SUBAGENTS) {
    const subagents = serviceOf(ctx, 'subagents');
    if (typeof subagents.startActivation !== 'function') return { ok: false, kind, code: 'unsupported', reason: 'subagents.startActivation unavailable' };
    try {
      // 调用方可能传 rc.1 的 provider 名（默认 spawn）；rc.2 若没有该注册名就退回可用的 spawn provider。
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
      });
      return { ok: true, kind, member: { id: activation?.childId, name: activation?.name ?? name, status: 'provisioning', role: 'teammate' } };
    } catch (error) {
      const message = reasonOf(error);
      return { ok: false, kind, code: /limit|capacity|maxActive|too many/i.test(message) ? 'member-limit' : 'spawn-failed', reason: message };
    }
  }
  return { ok: false, kind, code: 'no-service', reason: 'agentTeams/subagents unavailable' };
}

/**
 * 直接子会话列表（release 用）：legacy 走 listChildren，rc.2 从 listDescendants 过滤 depth=1。
 * 返回 `{ok:true, rows}` / `{ok:false, reason}`；rows 形状对齐 SubagentCatalogEntry。
 */
export async function listChildren(ctx, parentSessionId) {
  const kind = teamKindOf(ctx);
  const subagents = serviceOf(ctx, 'subagents');
  // 这条能力只属于 subagents 服务（rc.1 listChildren / rc.2 listDescendants），不依赖团队后端。
  if (subagents === undefined) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  try {
    if (typeof subagents.listChildren === 'function') {
      const rows = await subagents.listChildren(parentSessionId);
      return { ok: true, kind, rows: Array.isArray(rows) ? rows : [] };
    }
    if (typeof subagents.listDescendants === 'function') {
      const entries = await subagents.listDescendants(parentSessionId);
      const rows = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry?.kind === 'child' && entry.parentId === parentSessionId)
        .map((entry) => ({ id: entry.id, createdAt: 0, mode: entry.mode, label: entry.label, activity: entry.activity }));
      return { ok: true, kind, rows };
    }
    return { ok: false, kind, code: 'unsupported', reason: 'subagents exposes neither listChildren nor listDescendants' };
  } catch (error) {
    return { ok: false, kind, code: 'unavailable', reason: reasonOf(error) };
  }
}

/**
 * 释放指定子会话（release 用）：legacy 走 drainChildren；rc.2 只有 drainDescendants(parents)
 * （释放整棵树），没有逐 id 释放的等价能力 → 明确 unsupported，不误伤整棵树。
 */
export async function drainChildren(ctx, caller, ids) {
  const kind = teamKindOf(ctx);
  const subagents = serviceOf(ctx, 'subagents');
  if (subagents === undefined) return { ok: false, kind, code: 'no-service', reason: 'subagents unavailable' };
  if (typeof subagents.drainChildren === 'function') {
    try { await subagents.drainChildren(caller, ids); return { ok: true, kind, ids }; } catch (error) { return { ok: false, kind, code: 'drain-failed', reason: reasonOf(error) }; }
  }
  // rc.2 只有 drainDescendants(parents)：整棵树 teardown，没有逐 id 释放的等价能力。
  return { ok: false, kind, code: 'unsupported', reason: 'subagents exposes drainDescendants(parents) only; selected-child drain is unavailable' };
}

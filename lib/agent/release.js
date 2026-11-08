/**
 * dsh-context-relay — 资源释放（压缩时点 / 队友换代时）。
 *
 * relay 能真正回收的内存只有「整会话卸载」这一种：
 *   - 压缩本身只 shadow 事件、不删 append-only 日志（内核无 truncate API），当前会话释放不了；
 *   - 当前 Lead 名下已 settled 的直接子会话、以及 roster 中已退休的队友代，是 subagent manager
 *     owned 的 resident activation——用官方 `subagents.listChildren` + `drainChildren` 释放；
 *     `ctx.agents.get(id)?.dispose?.()` 拿不到创建者独占的 AgentHandle，不可靠，不要用。
 *
 * 所有函数 best-effort：服务缺失 / 查询失败 / 单批释放失败都返回已释放 id 列表或 []，绝不抛给调用方。
 *
 * @module dsh-context-relay/agent/release
 */
import { readRoster } from './team.js';

/** 单次释放上限（防御异常大的 catalog；正常小队远小于此）。 */
export const RELEASE_BATCH_LIMIT = 64;

function subagentsOf(ctx) {
  try { return ctx?.get?.('subagents'); } catch { return undefined; }
}

function agentsOf(ctx) {
  try { return ctx?.get?.('agents'); } catch { return undefined; }
}

/** 当前 Lead 名下队友的会话 id 集合（队友是 continuable child，绝不能当普通子会话释放）。 */
function teammateIdsOf(ctx, caller) {
  const ids = new Set();
  try {
    const teams = ctx.get('agentTeams');
    if (teams === undefined || typeof teams.tryMembership !== 'function' || typeof teams.listMembers !== 'function') return ids;
    if (teams.tryMembership(caller)?.role !== 'lead') return ids;
    for (const member of teams.listMembers(caller)) {
      if (member?.role !== 'lead' && typeof member?.id === 'string' && member.id !== '') ids.add(member.id);
    }
  } catch { /* 团队服务异常：只做保守释放（下面对 continuable 已跳过） */ }
  return ids;
}

/**
 * 单个 catalog 子会话是否可安全释放：
 *  - external/unknown 无本地会话，跳过；
 *  - one-shot 终态 child：agent 已卸载或当前 idle → 可释放；
 *  - continuable child（含队友）：只在 agent 已不存活（未加载）时释放——活着的 continuable 可能
 *    在等队列消息，压缩时点不主动终结；队友由 teammateIds 另行排除。
 */
function isReleasable(ctx, row, teammateIds) {
  if (row === null || typeof row !== 'object') return false;
  const id = row.id;
  if (typeof id !== 'string' || id === '' || teammateIds.has(id)) return false;
  if (row.mode === 'external' || row.mode === 'unknown') return false;
  const agent = agentsOf(ctx)?.get?.(id);
  if (agent === undefined) return true;
  return row.mode === 'one-shot' && agent.status === 'idle';
}

function uniqueIds(ids) {
  const out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || out.includes(id)) continue;
    out.push(id);
    if (out.length >= RELEASE_BATCH_LIMIT) break;
  }
  return out;
}

async function drain(ctx, caller, ids, label, log) {
  const list = uniqueIds(ids);
  if (list.length === 0) return [];
  const subagents = subagentsOf(ctx);
  if (subagents === undefined || typeof subagents.drainChildren !== 'function') {
    if (typeof log === 'function') log(label + ': subagents service unavailable');
    return [];
  }
  try {
    await subagents.drainChildren(caller, list);
    return list;
  } catch (error) {
    if (typeof log === 'function') log(label + ': drainChildren failed: ' + String(error?.message ?? error));
    return [];
  }
}

/**
 * 释放当前 Lead 名下已 settled 的直接子会话（普通 subagent；不含 running/队友）。返回实际提交释放的 id 列表。
 * 判定用 subagentCatalog 的 mode + 活 agent.status（见 isReleasable）；catalog 不含 activity，
 * 不要用 kind/activity 过滤（那会永远为空）。
 */
export async function releaseSettledChildren(ctx, caller, { log } = {}) {
  const subagents = subagentsOf(ctx);
  if (subagents === undefined || typeof subagents.listChildren !== 'function') return [];
  let rows;
  try {
    rows = await subagents.listChildren(caller.session.id);
  } catch (error) {
    if (typeof log === 'function') log('release settled children: listChildren failed: ' + String(error?.message ?? error));
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const teammateIds = teammateIdsOf(ctx, caller);
  return drain(
    ctx,
    caller,
    rows.filter((row) => isReleasable(ctx, row, teammateIds)).map((row) => row.id).filter((id) => id !== caller.session.id),
    'release settled children',
    log,
  );
}

/**
 * 释放 roster 中已退休（retiredAt 已写）的队友代会话；可选只释放指定 lineage。
 * 旧代 sessionId 来自 roster generations（team.js 维护），不猜。
 */
export async function releaseRetiredGenerations(ctx, caller, { cwd, log, lineages } = {}) {
  if (typeof cwd !== 'string' || cwd === '') return [];
  let roster;
  try {
    roster = readRoster(cwd, caller.session.id);
  } catch {
    return [];
  }
  const wanted = Array.isArray(lineages) ? new Set(lineages) : undefined;
  const ids = [];
  for (const [lineage, entry] of Object.entries(roster?.lineages ?? {})) {
    if (wanted !== undefined && !wanted.has(lineage)) continue;
    for (const generation of entry?.generations ?? []) {
      if (generation === null || typeof generation !== 'object' || generation.retiredAt === undefined) continue;
      ids.push(generation.sessionId);
    }
  }
  return drain(ctx, caller, ids, 'release retired generations', log);
}

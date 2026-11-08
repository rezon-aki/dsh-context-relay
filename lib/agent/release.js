/**
 * dsh-context-relay — 资源释放（压缩时点 / 队友换代时，best-effort）。
 *
 * 事实（2026-11-08 实测 + 安装内核 dsh-subagent/lib/types/manager.js）：
 *   - subagent manager 在本地子会话「自然结算」时就会 close→dispose→resident.delete
 *     （watchLocalSettlement），已结算子会话通常已不在 resident，没有可回收资源；
 *   - 压缩只 shadow 事件、不删 append-only 日志（内核无 truncate API），当前会话释放不了；
 *   - 因此本模块只处理「仍然驻留」的 activation：one-shot idle（结算前的短暂窗口）与刚被
 *     interrupt 仍在驻留的旧代（renew 时）。通常返回空列表，不做内存收益承诺。
 *   - 释放走官方 `subagents.listChildren` + `drainChildren`；已卸载的 id 不再提交（否则会虚报
 *     「已释放」数量）。`ctx.agents.get(id)?.dispose?.()` 拿不到创建者独占的 AgentHandle，不可靠。
 *
 * 所有函数 best-effort：服务缺失 / 查询失败 / 单批释放失败都返回已提交的 id 列表或 []；异常由调用点兜底。
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
 * 单个 catalog 子会话是否「仍驻留且可安全释放」：
 *  - 已卸载（agents.get 为空）＝内核结算时已释放，跳过（无可回收资源，也不虚报计数）；
 *  - external/unknown 无本地会话，跳过；
 *  - 驻留 one-shot 且 idle → 可释放（结算前的短暂窗口）；
 *  - 驻留 continuable（含队友）不主动终结（可能在等队列消息）；队友由 teammateIds 另行排除。
 */
function isReleasable(ctx, row, teammateIds) {
  if (row === null || typeof row !== 'object') return false;
  const id = row.id;
  if (typeof id !== 'string' || id === '' || teammateIds.has(id)) return false;
  if (row.mode === 'external' || row.mode === 'unknown') return false;
  const agent = agentsOf(ctx)?.get?.(id);
  if (agent === undefined) return false;
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
 * 释放当前 Lead 名下「仍驻留」的已结算 one-shot 子会话（普通 subagent；不含 running/队友）。
 * 已卸载的子会话在内核结算时已释放，这里不提交、不计数。返回实际提交释放的 id 列表。
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
 * 释放 roster 中已退休（retiredAt 已写）且「仍驻留」的队友代会话；可选只释放指定 lineage。
 * 旧代 sessionId 来自 roster generations（team.js 维护），不猜；已卸载的旧代跳过（内核已释放）。
 */
export async function releaseRetiredGenerations(ctx, caller, { cwd, log, lineages } = {}) {
  if (typeof cwd !== 'string' || cwd === '') return [];
  const agents = agentsOf(ctx);
  if (agents === undefined || typeof agents.get !== 'function') return [];
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
  return drain(ctx, caller, ids.filter((id) => agents.get(id) !== undefined), 'release retired generations', log);
}

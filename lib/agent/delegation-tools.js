/**
 * dsh-context-relay — Lead 派活/收口工具（v0.9.0 批次3）：relay_dispatch / relay_collect。
 *
 * dispatch：取台账分点 → 复用空闲 worker 或新建 → 发标准 5 字段 brief（目标/必读/写范围/验收/回执）
 *   → 台账写 doing+owner+next → 返回 worker/reportPath/dispatchId；发送失败回滚台账。
 * collect：有界短等（≤120s）→ 只读回执头 3 行 + digest（≤600 码点）→ 台账 done/blocked → 只回 digest。
 * 纯逻辑（brief 组装/回执解析/路径与 id 派生）在 delegation.js；团队能力复用 team-api.js 既有 seam。
 * Lead-only，root agent-scope 注册（installRootLead）；队友/架构师不注册。不做轮询/队列/自动重试。
 *
 * @module dsh-context-relay/agent/delegation-tools
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workspaceStore } from '../storage.js';
import { capabilitiesOf, listMembers, roleOf, rootSessionIdOf, sendToMember, startMember } from '../team-api.js';
import { bandFor } from '../policy.js';
import { ARCHITECT_NAME } from './protocol.js';
import { TEAM_PROVIDER, classifyHealth, clipText, ensureLineage, genOf, isValidTeammateName, lineageOf, readRoster, squadMembersOf, usedNamesOf, writeRoster } from './team.js';
import { rememberActivation } from './activations.js';
import { mergeTeamContext } from './team-context.js';
import { isLeadConfirmComplete, normalizeWorkItemsConfig, readWorkItems, workItemsScopeOf, writeWorkItems } from './work-items.js';
import { COLLECT_OK_PREFIX, DISPATCH_OK_PREFIX } from '../projection.js';
import { TOOL_PREFIX, capMap, clearPendingBudgetInherit, cwdOf, effectiveUnlimitedBudgetOf, fail, logInfo, logWarn, lossless, markPendingBudgetInherit, storagePath } from './shared.js';
import { dispatchNeedOf, teammateState } from './sentinel.js';
import {
  DELEGATION_DISPATCH_DIR,
  DELEGATION_REPORT_READ_BYTES,
  DISPATCH_CANDIDATE_LIMIT,
  DISPATCH_HEALTHS,
  composeDispatchBrief,
  digestOf,
  dispatchRecordPathOf,
  dispatchScoreOf,
  nextDispatchId,
  parseReportHead,
  rankDispatchCandidates,
  receiptFreshnessOf,
  registerDispatchMemoryProbe,
  reportPathOf,
  validateDispatchArgs,
} from './delegation.js';

/** collect 有界短等上限（设计 §2.4.3：≤120s；不做后台轮询）。 */
const WAIT_MAX_MS = 120000;
const WAIT_INTERVAL_MS = 250;
/** 自动选人可复用的 health 单源在 delegation.js（v0.11 §3.1）；此处兼容导出，避免既有调用方/测试漂移。 */
export { DISPATCH_HEALTHS };
/** 新建 worker 候选名（worker-1..worker-9 中最小未占用；最多试 3 个防名字冲突竞态）。 */
const WORKER_NAME_MAX = 9;
const WORKER_NAME_TRIES = 3;
/**
 * 自动选人 health 判定（设计 §2.4.2 步骤 3b / R2）：显式 health 优先（官方 seam/夹具若提供），
 * 否则按设计口径由 band+checkpoint 派生（classifyHealth 单源：ok→fresh / warn→watch /
 * organize·relay→stale·spent / 读不到→unknown）。stale/spent/unknown/corrupt 均不可自动复用。
 */
export function dispatchHealthOf(candidate, state, hasCheckpoint = false) {
  const explicit = typeof candidate?.health === 'string' && candidate.health !== '' ? candidate.health : '';
  return explicit !== '' ? explicit : classifyHealth({ band: state?.band, ratio: state?.ratio }, hasCheckpoint).health;
}

/** 自动选人被排除的原因（selection.excluded 可解释；不影响评分纯函数）。 */
function exclusionReasonOf({ health, band, status }) {
  if (String(status ?? '') === 'running') return 'running';
  if (!DISPATCH_HEALTHS.includes(health)) return 'health-' + health;
  if (band !== 'ok' && band !== 'warn') return 'band-' + band;
  return null;
}

/**
 * 进程内 dispatch 记忆（scopeId:itemId → dispatchId）。只是缓存：C8/M-06 起新鲜度权威是
 * `.scratch/context-relay/dispatch/<scopeId>/<itemId>.json`（workspaceStore 落盘），
 * 插件 reload/进程重启后 relay_collect 仍按落盘 dispatchId 判新旧，旧回执不会被假收口。
 */
const LAST_DISPATCH = new Map();
const LAST_DISPATCH_MAX = 200;
/** 插件 reload/卸载清空内存的时间（可观测：relay_status.delegation.dispatchMemory）。 */
let DISPATCH_MEMORY_CLEARED_AT = null;

/**
 * 卸载/测试清理（agent.js 的清理 effect 调用）。持久化 dispatch 记录**不删**——它才是
 * reload 后收口的新鲜度权威；这里只清进程内缓存并记可观测状态。
 */
export function clearDelegationMemory(ctx) {
  const had = LAST_DISPATCH.size;
  LAST_DISPATCH.clear();
  DISPATCH_MEMORY_CLEARED_AT = new Date().toISOString();
  if (had > 0) {
    logWarn(ctx, '[delegation] in-memory dispatch memory cleared (' + had + ' entries) on unload/reload; persisted dispatch records under ' + DELEGATION_DISPATCH_DIR + '/ remain the freshness authority for relay_collect');
  }
}

/** workspaceStore 的 target 是「记录目录内相对名」（如 progress.md）；dispatch 契约路径是工作区相对——换算一次。 */
const RECORD_STORE_ROOT = '.scratch/context-relay/';
function storeRelativeOf(workspaceRelative) {
  return workspaceRelative.startsWith(RECORD_STORE_ROOT) ? workspaceRelative.slice(RECORD_STORE_ROOT.length) : workspaceRelative;
}
/** 工作区相对路径 → 绝对路径（读路径专用：不经 storagePath，避免只读检查创建目录的副作用）。 */
function recordAbsoluteOf(cwd, workspaceRelative) {
  return join(cwd, ...workspaceRelative.split('/'));
}

/**
 * 内存 dispatch 记忆状态（relay_status 可观测）。persisted 只在给 cwd 时统计（本工作区落盘记录数）；
 * 无 cwd 的探针调用不报伪 0（避免「有落盘记录却显示 0」的误导）。
 */
export function delegationMemoryState(cwd) {
  const state = { inMemory: LAST_DISPATCH.size, cleared: DISPATCH_MEMORY_CLEARED_AT !== null, clearedAt: DISPATCH_MEMORY_CLEARED_AT };
  if (typeof cwd !== 'string' || cwd === '') return state;
  state.persisted = 0;
  try {
    const root = recordAbsoluteOf(cwd, DELEGATION_DISPATCH_DIR);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        state.persisted += readdirSync(join(root, entry.name)).filter((name) => name.endsWith('.json')).length;
      } catch { /* 单目录不可读忽略 */ }
    }
  } catch { /* 没有落盘记录 */ }
  return state;
}

registerDispatchMemoryProbe(() => delegationMemoryState());

/** dispatch 记录相对路径（scopeId 缺失/非法 → _workspace）；非法 itemId → undefined。 */
function dispatchRecordOf(cwd, scopeId, itemId) {
  const relative = dispatchRecordPathOf(scopeId, itemId);
  if (relative === null) return undefined;
  try {
    const absolute = recordAbsoluteOf(cwd, relative);
    if (!existsSync(absolute)) return undefined;
    const text = readFileSync(absolute, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || parsed.itemId !== itemId) return undefined;
    if (typeof parsed.dispatchId !== 'string' || parsed.dispatchId === '') return undefined;
    const expectedScope = typeof scopeId === 'string' && scopeId !== '' ? scopeId : '_workspace';
    if (typeof parsed.scopeId === 'string' && parsed.scopeId !== expectedScope) return undefined;
    return parsed;
  } catch { return undefined; }
}

/** 落盘 dispatch 记录（先写台账再发 brief，发送成功才写；写失败如实回显，不阻断收口路径）。 */
async function saveDispatchRecord(cwd, record) {
  const relative = dispatchRecordPathOf(record.scopeId, record.itemId);
  if (relative === null) throw new Error('invalid dispatch record path');
  await workspaceStore(cwd).writeAtomic(storeRelativeOf(relative), JSON.stringify(record) + '\n');
  return relative;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function signalOf(exec) {
  return exec?.signal ?? new AbortController().signal;
}

function teammatesOf(listed) {
  return Array.isArray(listed?.members) ? listed.members.filter((member) => member?.role === 'teammate') : [];
}

function readRosterSafe(cwd, leadSessionId) {
  try { return readRoster(cwd, leadSessionId); } catch { return { version: 1, lineages: {} }; }
}

function rosterNamesOf(roster) {
  const names = new Set();
  for (const entry of Object.values(roster?.lineages ?? {})) {
    for (const name of usedNamesOf(entry)) if (typeof name === 'string' && name !== '') names.add(name);
  }
  return names;
}

function doingOwnersOf(items) {
  const owners = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status === 'doing' && typeof item.owner === 'string' && item.owner !== '') owners.add(item.owner);
  }
  return owners;
}

/** 队友上下文档位（读不到 → unknown，不猜）。 */
async function bandStateOf(ctx, member, thresholds) {
  const pressure = await teammateState(ctx, member);
  return pressure === undefined
    ? { band: 'unknown', ratio: undefined }
    : { band: bandFor(pressure, thresholds).band, ratio: pressure?.ratio };
}

function sleep(ms, signal) {
  return new Promise((resolveWait) => {
    if (signal?.aborted) { resolveWait(); return; }
    let timer;
    const done = () => {
      clearTimeout(timer);
      try { signal?.removeEventListener?.('abort', done); } catch { /* ignore */ }
      resolveWait();
    };
    timer = setTimeout(done, ms);
    try { signal?.addEventListener?.('abort', done, { once: true }); } catch { /* ignore */ }
  });
}

/**
 * 安全读回执前部（≤64KB；完整报告仍在文件里）。
 * 返回 { exists:true, text, bytes, truncated } / { exists:false } / { exists:false, pathError|readError }。
 */
function readReportHead(cwd, reportPath) {
  let absolute;
  try {
    absolute = storagePath(cwd, join(cwd, reportPath));
  } catch (error) {
    return { exists: false, pathError: String(error?.message ?? error) };
  }
  let fd;
  try {
    fd = openSync(absolute, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, DELEGATION_REPORT_READ_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { exists: true, text: buffer.subarray(0, offset).toString('utf8'), bytes: size, truncated: size > length };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: false, readError: String(error?.message ?? error) };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 回执路径派生（非法 itemId → undefined；正常路径由参数校验先行保证）。 */
function reportPathOfId(itemId) {
  try {
    const path = reportPathOf(itemId);
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
}

export function createDelegationTools(runtime = {}) {
  const { ctx } = runtime;
  // 工作台账配置（agent 行装配传入归一化配置；缺省按默认（enabled=true），老装配/单测兼容）。
  const workItems = runtime.workItems ?? normalizeWorkItemsConfig({});
  const currentThresholds = typeof runtime.currentThresholds === 'function' ? runtime.currentThresholds : () => undefined;
  // v0.11 P0-B 小队模型：spawn 默认关闭；squadMax 默认 8（config 可上调）。
  const allowSpawn = runtime.allowSpawn === true;
  const squadMax = Number.isInteger(runtime.squadMax) && runtime.squadMax > 0 ? Math.min(32, runtime.squadMax) : 8;
  /** 无候选时的四路径 recovery（spawn 关 / squad 满共用；设计 §3.2.4）。 */
  const SQUAD_RECOVERY = '① 让现有队员 relay_checkpoint → relay_freshen({reset:true, brief}) 全清复用（同成员/0 额度）；② relay_team_status({manage:{action:\'adopt\',names:[...],reason}}) 把有用历史成员纳入小队；③ phase 边界 relay_handoff 重建小队；④ 确需扩队把 config allowSpawn 设为 true 且 squadMax 足够';

  const ledgerOf = (caller, scopeId) => readWorkItems(cwdOf(caller.session), { pathOverride: workItems.pathOverride, scopeId });
  const writeLedgerItems = async (caller, scopeId, items, rev) => writeWorkItems(cwdOf(caller.session), {
    items,
    rev,
    updatedBy: caller.session?.id,
    max: workItems.max,
    pathOverride: workItems.pathOverride,
    scopeId,
  });

  /** 选人：显式 worker 校验/band 检查，或自动复用空闲干净队友，或规划新建候选名。 */
  async function selectWorker({ caller, args, items, cwd, leadSessionId, signal }) {
    const caps = capabilitiesOf(ctx);
    if (caps.listMembers !== true || caps.send !== true) {
      return { ok: false, result: fail('team-unavailable', 'team services unavailable (' + caps.kind + ': listMembers=' + String(caps.listMembers) + ', send=' + String(caps.send) + ')', {
        recovery: '降级：用官方 subagent 手工建 worker + relay_work_items 记 owner/next（工具不可用时的唯一降级路径）',
        summary: 'refused: team services unavailable; degrade to official subagent + relay_work_items({owner,next}).',
      }) };
    }
    const listed = await listMembers(ctx, caller, { signal });
    if (listed.ok !== true) {
      return { ok: false, result: fail('team-read-failed', String(listed.reason ?? listed.code ?? 'could not list team members'), {
        recovery: '重试；仍失败用官方 subagent 手工派 + relay_work_items 记 owner/next',
        summary: 'refused: could not list team members.',
      }) };
    }
    const roster = readRosterSafe(cwd, leadSessionId);
    const all = teammatesOf(listed);
    // v0.11 P0-B：自动/显式选人都只看 squad（legacy/退休代不可派活）。
    const squad = squadMembersOf(roster, all);
    const thresholds = currentThresholds();
    const explicit = asText(args.worker).trim();
    if (explicit !== '') {
      const chosen = squad.find((member) => member.name === explicit);
      if (chosen === undefined) {
        const known = all.some((member) => member.name === explicit);
        return { ok: false, result: fail('invalid-args', known
          ? 'worker ' + explicit + ' is not in the current squad (legacy/retired); adopt it first or omit worker'
          : 'worker not found: ' + explicit, {
          recovery: '先用 relay_team_status 确认当前小队；历史成员要派活先 manage:{action:\'adopt\',names:[...],reason}；或省略 worker 自动选人',
          summary: 'refused: explicit worker is not a current squad member.',
        }) };
      }
      const state = await bandStateOf(ctx, chosen, thresholds);
      const management = dispatchNeedOf(state.band);
      if (management !== '' && args.accept_dirty !== true) {
        try { await mergeTeamContext(cwd, leadSessionId, { name: chosen.name, band: state.band }); } catch { /* 快照 fail-open */ }
        return { ok: false, result: fail('worker-needs-management', 'worker ' + chosen.name + ' band=' + state.band + '; manage its context before dispatching', {
          worker: { name: chosen.name, band: state.band, ratio: state.ratio },
          recovery: '① 先让它 relay_checkpoint，再 relay_freshen({reset:true, brief}) 真清空后重派（推荐）；或 ② accept_dirty:true 直接派（你显式判断，接受脏上下文）',
          summary: management,
        }) };
      }
      // 显式 worker：接受脏上下文（accept_dirty）时仍放行；selection 记录评分与候选事实。
      const rosterKnownNames = rosterNamesOf(roster);
      const health = dispatchHealthOf(chosen, state);
      const score = dispatchScoreOf({ health, band: state.band, status: chosen.status, rosterKnown: rosterKnownNames.has(chosen.name) });
      return {
        ok: true,
        mode: 'reused',
        member: chosen,
        pick: { mode: 'reused', score, considered: [chosen.name], excluded: [], truncated: false },
      };
    }
    const doingOwners = doingOwnersOf(items);
    const excluded = [];
    const pool = [];
    for (const candidate of squad) {
      if (lineageOf(candidate.name) === ARCHITECT_NAME) { excluded.push({ name: candidate.name, reason: 'architect' }); continue; }
      if (String(candidate.status ?? '') === 'running') { excluded.push({ name: candidate.name, reason: 'running' }); continue; }
      if (doingOwners.has(candidate.name)) { excluded.push({ name: candidate.name, reason: 'already-owning' }); continue; }
      pool.push(candidate);
    }
    // 并发读候选 band（避免 34 人串行 await）；候选读取上限 12，超出标 truncated。
    const truncated = pool.length > DISPATCH_CANDIDATE_LIMIT;
    const shortlist = pool.slice(0, DISPATCH_CANDIDATE_LIMIT);
    for (const skipped of pool.slice(DISPATCH_CANDIDATE_LIMIT)) excluded.push({ name: skipped.name, reason: 'candidate-limit' });
    const states = await Promise.all(shortlist.map((candidate) => bandStateOf(ctx, candidate, thresholds)));
    const rosterKnown = rosterNamesOf(roster);
    const reviewed = shortlist.map((candidate, index) => {
      const state = states[index];
      const health = dispatchHealthOf(candidate, state);
      return {
        member: candidate,
        name: candidate.name,
        status: candidate.status,
        health,
        band: state.band,
        rosterKnown: rosterKnown.has(candidate.name),
        reason: exclusionReasonOf({ health, band: state.band, status: candidate.status }),
      };
    });
    for (const row of reviewed) {
      if (row.reason !== null) excluded.push({ name: row.name, reason: row.reason, health: row.health, band: row.band });
    }
    const ranked = rankDispatchCandidates(reviewed);
    const considered = reviewed.map((row) => row.name);
    if (ranked.length > 0) {
      return {
        ok: true,
        mode: 'reused',
        member: ranked[0].member,
        pick: { mode: 'reused', score: ranked[0].score, considered, excluded, truncated },
      };
    }
    const squadFull = squad.length >= squadMax;
    // v0.11 P0-B：spawn 默认关闭；无空闲 squad 时拒绝并给四路径 recovery。
    if (!allowSpawn) {
      return { ok: false, result: fail(squadFull ? 'squad-full' : 'no-squad-member', squadFull
        ? 'squad full (' + squad.length + '/' + squadMax + '); spawn disabled (allowSpawn=false)'
        : 'no idle squad member; spawn disabled (allowSpawn=false)', {
        squad: { size: squad.length, max: squadMax },
        recovery: SQUAD_RECOVERY,
        summary: squadFull
          ? 'refused: squad is full (' + squad.length + '/' + squadMax + ') and spawn is disabled; reset-reuse, adopt, or handoff instead.'
          : 'refused: no idle squad member and spawn is disabled; reset-reuse, adopt, or handoff instead.',
      }) };
    }
    if (squadFull) {
      return { ok: false, result: fail('squad-full', 'squad full (' + squad.length + '/' + squadMax + '); raise config squadMax or reuse/adopt', {
        squad: { size: squad.length, max: squadMax },
        recovery: SQUAD_RECOVERY,
        summary: 'refused: squad is full (' + squad.length + '/' + squadMax + '); reset-reuse, adopt, retire, or raise config squadMax.',
      }) };
    }
    if (caps.spawn !== true) {
      return { ok: false, result: fail('team-unavailable', 'no idle worker and spawn unavailable (' + caps.kind + ')', {
        recovery: '降级：用官方 subagent 手工建 worker + relay_work_items 记 owner/next',
        summary: 'refused: no idle worker and spawn is unavailable.',
      }) };
    }
    const used = new Set([...teammatesOf(listed).map((entry) => entry.name), ...rosterNamesOf(roster)]);
    const candidates = [];
    for (let index = 1; index <= WORKER_NAME_MAX && candidates.length < WORKER_NAME_TRIES; index += 1) {
      const name = 'worker-' + index;
      if (!used.has(name) && isValidTeammateName(name)) candidates.push(name);
    }
    if (candidates.length === 0) {
      // 名字耗尽 ≠ 并发满额：spawn 额度可能还有，只是 worker-1..N 已被当前/退休代占用。
      return { ok: false, result: fail('worker-name-exhausted', 'no available worker name: worker-1..' + WORKER_NAME_MAX + ' all used by current/retired teammates', {
        recovery: '复用/改名：先 reset 一个空闲队友继续用（同成员、0 额度），或 phase 边界 relay_handoff 重建小队；也可用 worker 参数显式指定现有队友名',
        summary: 'worker-name-exhausted: worker-1..worker-N names are taken (spawn capacity is not the issue); reuse/reset an idle teammate, rename via handoff, or pass an explicit worker name.',
      }) };
    }
    return { ok: true, mode: 'spawn', candidates, pick: { mode: 'spawn', score: null, considered, excluded, truncated } };
  }

  const dispatch = {
    name: TOOL_PREFIX + 'dispatch',
    description: 'Lead-only: take one work-ledger item, reuse or spawn a worker, send the standard 5-field brief (goal/docs/scope/acceptance/receipt), mark the ledger item doing with owner+next, and return worker + reportPath + dispatchId. Refuses incomplete briefs.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['itemId', 'brief', 'docs', 'writeScope', 'acceptance'],
      properties: {
        itemId: { type: 'string', description: 'Ledger item id (^[a-z0-9][a-z0-9-]*$); item must exist and not be done.' },
        brief: { type: 'string', description: 'Goal, one line, verifiable (1-800 chars).' },
        docs: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' }, description: 'Required reading pointers 1-3 (path/INDEX + when/role), each <=200 chars.' },
        writeScope: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'Allowed workspace-relative paths/globs (1-200 chars each); out-of-scope writes forbidden.' },
        acceptance: { type: 'string', description: 'Testable acceptance: command or checklist (1-300 chars).' },
        next: { type: 'string', description: 'Optional ledger next (<=160); default: execute the point and write the receipt.' },
        worker: { type: 'string', description: 'Optional existing teammate name; omit to auto-reuse an idle worker or spawn one.' },
        force: { type: 'boolean', description: 'Item already doing: resend the brief to the current owner (recovery path).' },
        accept_dirty: { type: 'boolean', description: 'Dispatch to a worker at organize/relay/unknown band (explicit Lead judgment; default refuses with management guidance).' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_dispatch requires a calling agent');
      const membership = roleOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') {
        return fail('lead-only', 'relay_dispatch is Lead-only', { summary: 'refused: only the root Lead may dispatch work.' });
      }
      if (workItems.enabled === false) {
        return fail('work-items-disabled', 'work ledger is disabled (workItems:false)', { summary: 'refused: work ledger disabled; enable workItems before dispatching.' });
      }
      const validated = validateDispatchArgs(args ?? {});
      if (validated?.ok !== true) {
        return fail('invalid-args', 'incomplete dispatch brief: ' + String(validated?.message ?? 'invalid arguments'), { summary: 'refused: incomplete/invalid dispatch brief; nothing was sent or written.' });
      }
      // 参数归一（trim/默认值）用纯函数返回的 value，避免二次解释。
      const input = validated.value;
      const cwd = cwdOf(caller.session);
      const scopeId = workItemsScopeOf(caller.session);
      const leadSessionId = rootSessionIdOf(membership) ?? caller.session?.id;
      const itemId = input.itemId;
      const reportPath = reportPathOfId(itemId);
      if (reportPath === undefined) return fail('invalid-args', 'invalid itemId: ' + itemId, { summary: 'refused: invalid itemId.' });
      const ledger = ledgerOf(caller, scopeId);
      const items = Array.isArray(ledger.items) ? ledger.items : [];
      const index = items.findIndex((item) => item?.id === itemId);
      if (index === -1) {
        return fail('item-not-found', 'work item not found: ' + itemId, {
          recovery: '先用 relay_work_items / relay_phase({items}) 建账及该分点，再 dispatch',
          summary: 'refused: work item not found in the ledger; create it first.',
        });
      }
      const item = items[index];
      if (item.status === 'done') return fail('item-closed', 'work item ' + itemId + ' is done', { summary: 'refused: item is already done.' });
      const force = input.force === true;
      if (item.status === 'doing' && force !== true) {
        return fail('already-dispatched', 'work item ' + itemId + ' is already doing (owner=' + String(item.owner ?? '?') + ')', {
          owner: item.owner ?? null,
          reportPath,
          recovery: '先 relay_collect({itemId}) 收口；要重发 brief 才用 force:true（只发消息不 spawn）',
          summary: 'refused: item already dispatched; collect it first, or pass force:true to resend the brief.',
        });
      }
      // ── 选人（force = 重发：目标为当前 owner，只发消息）──
      let selection;
      if (force === true) {
        const ownerName = asText(item.owner).trim();
        if (ownerName === '') return fail('invalid-args', 'force requires the item to have an owner', { summary: 'refused: force resend needs item.owner.' });
        const caps = capabilitiesOf(ctx);
        if (caps.listMembers !== true || caps.send !== true) {
          return fail('team-unavailable', 'team services unavailable (' + caps.kind + ')', { recovery: '修服务后重试；或换 worker', summary: 'refused: team services unavailable.' });
        }
        const listed = await listMembers(ctx, caller, { signal: signalOf(exec) });
        if (listed.ok !== true) return fail('team-read-failed', String(listed.reason ?? 'could not list team members'), { recovery: '重试 relay_dispatch(force:true)', summary: 'refused: could not list team members.' });
        const owner = squadMembersOf(readRosterSafe(cwd, leadSessionId), teammatesOf(listed)).find((member) => member.name === ownerName);
        if (owner === undefined) {
          return fail('invalid-args', 'force: current owner is not a resolvable teammate: ' + ownerName, { recovery: '换 worker 重派，或先修台账 owner', summary: 'refused: force owner not resolvable.' });
        }
        selection = {
          ok: true,
          mode: 'reused',
          member: owner,
          force: true,
          pick: { mode: 'reused', score: null, considered: [ownerName], excluded: [], truncated: false },
        };
      } else {
        selection = await selectWorker({ caller, args: input, items, cwd, leadSessionId, signal: signalOf(exec) });
        if (selection.ok !== true) return selection.result;
      }
      const next = input.next === null
        ? '执行分点并回执 ' + reportPath
        : input.next;
      // C8/M-06：新旧以落盘 dispatchId 区分（同一毫秒重派也要换 revision，旧回执不得当新回执）。
      const priorDispatch = dispatchRecordOf(cwd, scopeId, itemId);
      const dispatchId = nextDispatchId(itemId, priorDispatch?.dispatchId ?? LAST_DISPATCH.get(scopeId + ':' + itemId));
      const briefText = composeDispatchBrief({
        itemId,
        dispatchId,
        brief: input.brief,
        docs: input.docs,
        writeScope: input.writeScope,
        acceptance: input.acceptance,
        reportPath,
      });
      if (typeof briefText !== 'string' || briefText === '') {
        return fail('invalid-args', 'could not compose the standard brief', { summary: 'refused: brief composition failed; nothing was sent or written.' });
      }
      // 设计 §2.4.2 步骤 4：reports/ 目录按需创建（路径先过 storagePath 防越界/符号链接）。
      try {
        mkdirSync(dirname(storagePath(cwd, join(cwd, reportPath))), { recursive: true });
      } catch (error) {
        return fail('invalid-args', 'report path rejected: ' + String(error?.message ?? error), { summary: 'refused: report path rejected; nothing was sent or written.' });
      }
      // ── 台账先写 doing（先写后发；失败零消息零 spawn）──
      let written;
      let planned = selection.mode === 'spawn' ? selection.candidates[0] : selection.member.name;
      if (force !== true) {
        written = await writeLedgerItems(caller, scopeId, items.map((row, rowIndex) => (rowIndex === index
          ? { ...row, status: 'doing', owner: planned, next }
          : row)), ledger.rev);
        if (written?.ok !== true) {
          return fail('ledger-write-failed', 'could not mark item doing: ' + String(written?.message ?? written?.code ?? 'unknown'), { summary: 'refused: work-ledger write failed; nothing was sent.' });
        }
      }
      const rollback = async () => {
        if (force === true || written === undefined) return 'no ledger write';
        try {
          const rolled = await writeLedgerItems(caller, scopeId, items, written.ledger.rev);
          return rolled?.ok === true ? 'ledger rolled back' : 'ledger rollback failed: ' + String(rolled?.message ?? rolled?.code ?? 'unknown');
        } catch (error) {
          return 'ledger rollback failed: ' + String(error?.message ?? error);
        }
      };
      // ── 派发：复用=sendToMember；新建=startMember（prompt 即首条消息）──
      let dispatchedName = planned;
      let dispatchedStatus = String(selection.member?.status ?? 'inactive');
      if (selection.mode === 'reused') {
        const sent = await sendToMember(ctx, caller, selection.member, [{ type: 'text', text: briefText }], { signal: signalOf(exec) });
        if (sent.ok !== true) {
          const effect = await rollback();
          return fail('send-failed', String(sent.reason ?? sent.code ?? 'send failed'), {
            effect,
            recovery: '修服务/名称后 relay_dispatch({force:true}) 重发；或换 worker 重派',
            summary: 'refused: brief was not sent' + (effect === 'ledger rolled back' ? '; ledger rolled back.' : '.'),
          });
        }
      } else {
        let spawned;
        let memberLimit = false;
        for (let attempt = 0; attempt < selection.candidates.length; attempt += 1) {
          const candidate = selection.candidates[attempt];
          if (attempt > 0) {
            const rewritten = await writeLedgerItems(caller, scopeId, items.map((row, rowIndex) => (rowIndex === index
              ? { ...row, status: 'doing', owner: candidate, next }
              : row)), written.ledger.rev);
            if (rewritten?.ok !== true) {
              return fail('ledger-write-failed', 'could not update planned worker name: ' + String(rewritten?.message ?? rewritten?.code ?? 'unknown'), { summary: 'refused: work-ledger write failed; nothing was sent.' });
            }
            written = rewritten;
          }
          // v0.10.0：每次 spawn 尝试前登记 Lead 预算开关，尝试结束（成功/失败）都撤销。
          markPendingBudgetInherit(leadSessionId, effectiveUnlimitedBudgetOf(caller.session.id));
          try {
            spawned = await startMember(ctx, caller, {
              name: candidate,
              description: 'worker ' + itemId,
              prompt: [{ type: 'text', text: briefText }],
              provider: TEAM_PROVIDER,
              signal: signalOf(exec),
            });
          } finally {
            clearPendingBudgetInherit(leadSessionId);
          }
          if (spawned.ok === true) { dispatchedName = candidate; break; }
          if (spawned.code === 'member-limit') { memberLimit = true; break; }
          logWarn(ctx, '[dispatch] spawn failed name=' + candidate + ': ' + String(spawned.reason ?? spawned.code ?? 'unknown'));
          if (!/name|exist|duplicate|collision|invalid/i.test(String(spawned.reason ?? ''))) break;
        }
        if (spawned?.ok !== true) {
          const effect = await rollback();
          const code = memberLimit ? 'member-limit' : 'spawn-failed';
          return fail(code, String(spawned?.reason ?? spawned?.code ?? 'spawn failed'), {
            effect,
            memberLimit,
            recovery: memberLimit
              ? '不重试：reset 复用空闲队友 / phase 边界 relay_handoff 重建小队'
              : '修服务/名称后 relay_dispatch({force:true}) 重发；或换 worker 重派',
            summary: memberLimit
              ? 'member-limit: 子智能体并发额度已满，worker 未创建（台账已回滚）。不重试：reset 复用空闲队友，或 phase 边界 relay_handoff 重建小队。'
              : 'refused: could not start the worker (台账已回滚).',
          });
        }
        // v0.11 P0-B：spawn 成功即登记为当前小队代 + 记 activation 句柄——否则新 worker 会被当成 legacy，无法复用/退役释放。
        try {
          const roster = readRosterSafe(cwd, leadSessionId);
          ensureLineage(roster, lineageOf(dispatchedName), {
            name: dispatchedName,
            gen: genOf(dispatchedName),
            sessionId: spawned.member?.id,
            role: 'teammate',
            description: 'worker ' + itemId,
          });
          await writeRoster(cwd, roster, leadSessionId);
        } catch (error) {
          logWarn(ctx, '[dispatch] roster register failed name=' + dispatchedName + ': ' + String(error?.message ?? error));
        }
        if (spawned.member?.id !== undefined) rememberActivation(spawned.member.id, spawned.activation);
        dispatchedStatus = String(spawned.member?.status ?? 'provisioning');
      }
      // 派发成功才落盘 dispatch 记录（重启/reload 后 relay_collect 的新鲜度权威）；写失败如实回显，不回滚已发出的 brief。
      let dispatchPersist = 'ok';
      try {
        await saveDispatchRecord(cwd, {
          version: 1,
          itemId,
          scopeId: scopeId ?? null,
          dispatchId,
          worker: dispatchedName,
          reportPath,
          mode: selection.mode,
          at: new Date().toISOString(),
        });
      } catch (error) {
        dispatchPersist = 'failed: ' + String(error?.message ?? error);
        logWarn(ctx, '[dispatch] dispatch record write failed item=' + itemId + ': ' + dispatchPersist);
      }
      LAST_DISPATCH.set(scopeId + ':' + itemId, dispatchId);
      capMap(LAST_DISPATCH, LAST_DISPATCH_MAX);
      logInfo(ctx, '[dispatch] item=' + itemId + ' worker=' + dispatchedName + ' report=' + reportPath + ' dispatch=' + dispatchId + (force === true ? ' force' : ''));
      const ledgerRev = force === true ? ledger.rev : written.ledger.rev;
      const ledgerNext = force === true ? (item.next ?? next) : next;
      return lossless({
        ok: true,
        itemId,
        dispatchId,
        dispatchPersist,
        worker: {
          name: dispatchedName,
          reused: selection.mode === 'reused',
          spawned: selection.mode === 'spawn',
          status: selection.mode === 'spawn' ? dispatchedStatus : String(selection.member?.status ?? 'inactive'),
        },
        selection: selection.pick,
        reportPath,
        brief: { fields: ['goal', 'docs', 'writeScope', 'acceptance', 'receipt'], bytes: Buffer.byteLength(briefText, 'utf8') },
        ledger: { rev: ledgerRev, status: 'doing', owner: dispatchedName, next: ledgerNext },
        summary: 'dispatched item ' + itemId + ' to ' + dispatchedName + ' (report ' + reportPath + ', dispatch ' + dispatchId + ')',
        text: DISPATCH_OK_PREFIX + itemId + ' to ' + dispatchedName + (selection.mode === 'spawn' ? ' (spawned)' : ' (reused)')
          + ' · report ' + reportPath + ' · dispatch ' + dispatchId
          + (dispatchPersist === 'ok' ? '' : '；dispatchId 落盘失败（' + dispatchPersist + '）：收口请显式传 dispatchId')
          + '；完成后 relay_collect({itemId:' + JSON.stringify(itemId) + '}) 收口（只回 digest）。',
      });
    },
  };

  const collect = {
    name: TOOL_PREFIX + 'collect',
    description: 'Lead-only: bounded short wait (<=120s), read only the receipt head (task/revision/verdict) + digest (<=600 chars), mark the ledger item done (evidence=reportPath) or blocked (reason), and return the digest only. Full report stays in the report file. '
      + 'Freshness is verified against the persisted dispatch record (survives plugin reload/restart) and the receipt task must match the item; a receipt whose revision differs is stale and never collected. '
      + 'A verdict=done receipt requires lead_confirm={no_drift,no_missing,no_regression} all true (review diff/requirements/tests first); missing/incomplete returns confirmation-required and leaves the ledger unchanged.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['itemId'],
      properties: {
        itemId: { type: 'string', description: 'Ledger item id dispatched earlier.' },
        waitMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Bounded wait for the receipt (default 0 = read immediately; recommend 30000 for a short wait).' },
        dispatchId: { type: 'string', description: 'dispatchId from relay_dispatch. Optional while the persisted dispatch record exists; REQUIRED when it does not (reload/restart cleared memory and no record) — collect refuses unverifiable receipts.' },
        lead_confirm: {
          type: 'object', additionalProperties: false,
          description: 'Required when the receipt verdict=done: Lead completion confirmation that no_drift/no_missing/no_regression are ALL true after reviewing diff/requirements/tests. Missing/incomplete → confirmation-required (ledger unchanged).',
          properties: {
            no_drift: { type: 'boolean', description: 'true = no drift from requirements/design.' },
            no_missing: { type: 'boolean', description: 'true = nothing required is missing.' },
            no_regression: { type: 'boolean', description: 'true = tests/verification passed; no regression.' },
          },
          required: ['no_drift', 'no_missing', 'no_regression'],
        },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_collect requires a calling agent');
      const membership = roleOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') {
        return fail('lead-only', 'relay_collect is Lead-only', { summary: 'refused: only the root Lead may collect receipts.' });
      }
      if (workItems.enabled === false) {
        return fail('work-items-disabled', 'work ledger is disabled (workItems:false)', { summary: 'refused: work ledger disabled; enable workItems before collecting.' });
      }
      const itemId = asText(args?.itemId).trim();
      if (itemId === '') return fail('invalid-args', 'itemId required', { summary: 'refused: itemId required.' });
      const reportPath = reportPathOfId(itemId);
      if (reportPath === undefined) return fail('invalid-args', 'invalid itemId: ' + itemId, { summary: 'refused: invalid itemId.' });
      const rawWait = args?.waitMs;
      if (rawWait !== undefined && (!Number.isInteger(rawWait) || rawWait < 0 || rawWait > WAIT_MAX_MS)) {
        return fail('invalid-args', 'waitMs must be an integer 0-' + WAIT_MAX_MS, { summary: 'refused: waitMs out of range.' });
      }
      const waitMs = rawWait === undefined ? 0 : rawWait;
      const cwd = cwdOf(caller.session);
      const scopeId = workItemsScopeOf(caller.session);
      const ledger = ledgerOf(caller, scopeId);
      const items = Array.isArray(ledger.items) ? ledger.items : [];
      const index = items.findIndex((item) => item?.id === itemId);
      if (index === -1) return fail('item-not-found', 'work item not found: ' + itemId, { summary: 'refused: work item not found in the ledger.' });
      const item = items[index];
      let read = readReportHead(cwd, reportPath);
      if (read.pathError !== undefined) {
        return fail('invalid-args', 'report path rejected: ' + read.pathError, { summary: 'refused: report path rejected.' });
      }
      // 已 done：幂等路径（报告存在 → 同 digest + alreadyCollected，不写盘；否则 item-closed）。
      if (item.status === 'done') {
        const parsedDone = read.exists === true ? parseReportHead(read.text) : undefined;
        if (parsedDone?.ok === true) {
          const doneDigest = digestOf(parsedDone);
          return lossless({
            ok: true, status: 'collected', itemId, verdict: parsedDone.verdict,
            head: parsedDone.headLines, digest: doneDigest, reportPath,
            reportBytes: read.bytes, ledger: { rev: ledger.rev, status: 'done' },
            alreadyCollected: true, sampled: false,
            summary: 'already collected item ' + itemId + ' (' + parsedDone.verdict + '); no ledger write',
            text: COLLECT_OK_PREFIX + itemId + ' · verdict ' + parsedDone.verdict + ' · ledger done · alreadyCollected（未写盘）· report ' + reportPath + '\n' + doneDigest,
          });
        }
        return fail('item-closed', 'work item ' + itemId + ' is already done (no readable report at ' + reportPath + ')', { reportPath, summary: 'refused: item already done and its report is missing/invalid.' });
      }
      // 未派活（非 doing）且无报告 → 结构化失败（等也没有意义）。
      if (item.status !== 'doing' && read.exists !== true) {
        return fail('invalid-args', 'work item ' + itemId + ' has not been dispatched (status=' + String(item.status) + ') and has no report at ' + reportPath, {
          recovery: '先 relay_dispatch 派活，再 relay_collect',
          summary: 'refused: item is not doing and has no report; dispatch it first.',
        });
      }
      // ── 新鲜度权威（C8/M-06）：显式参数 > 落盘 dispatch 记录 > 进程内缓存；都没有 → 强制要参数，
      //    绝不再「expected 缺省则接受任意 revision」（reload/重启后旧回执会假收口）──
      const expectedGiven = asText(args?.dispatchId).trim();
      const persisted = dispatchRecordOf(cwd, scopeId, itemId);
      const expected = expectedGiven !== '' ? expectedGiven : (persisted?.dispatchId ?? LAST_DISPATCH.get(scopeId + ':' + itemId));
      if (expected === undefined) {
        return fail('needs-dispatch-id', 'no persisted dispatch record for item ' + itemId + ' and no dispatchId given (process memory empty after reload/restart); receipt freshness cannot be verified', {
          itemId,
          reportPath,
          persisted: false,
          recovery: '显式 relay_collect({itemId, dispatchId})：dispatchId 见 relay_dispatch 返回/回执 revision 行；确无派活则先 relay_dispatch',
          summary: 'refused: no dispatchId available (no persisted dispatch record and no argument) — refusing to collect a possibly stale receipt; pass dispatchId explicitly.',
        });
      }
      // ── 有界短等：只读回执头，到 deadline 仍不合规 → pending（不改台账）──
      const startedAt = Date.now();
      const pendingResult = (reason, parsed, lastRead) => lossless({
        ok: true,
        status: 'pending',
        itemId,
        reason,
        waitedMs: Date.now() - startedAt,
        reportPath,
        ...(Array.isArray(parsed?.headLines) ? { head: parsed.headLines } : {}),
        ...(parsed?.ok === true && typeof parsed.revision === 'string' ? { revision: parsed.revision } : {}),
        ...(lastRead?.exists === true ? { reportBytes: lastRead.bytes } : {}),
        summary: 'collect pending: ' + reason + ' (bounded wait; ledger unchanged)',
        text: 'collect pending · ' + reason + ' · 台账未变；等回执消息后再 relay_collect（不要轮询）。',
      });
      let parsed = read.exists === true ? parseReportHead(read.text) : undefined;
      for (;;) {
        if (exec?.signal?.aborted) return pendingResult('aborted', parsed, read);
        let reason;
        if (read.exists === true) {
          if (parsed?.ok === true) {
            // 头 task 必须等于 itemId（错任务回执不得收口）+ revision 必须等于本次 dispatchId。
            const freshness = receiptFreshnessOf(parsed, itemId, expected);
            if (freshness.fresh === true) break;
            reason = freshness.reason;
          } else {
            reason = 'report-invalid';
          }
        } else {
          reason = 'report-missing';
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= waitMs) return pendingResult(reason, parsed, read);
        await sleep(Math.min(WAIT_INTERVAL_MS, waitMs - elapsed), exec?.signal);
        read = readReportHead(cwd, reportPath);
        parsed = read.exists === true ? parseReportHead(read.text) : undefined;
      }
      // ── 命中：digest（≤600 码点）+ 台账 done/blocked（rev 乐观锁）──
      const digest = digestOf(parsed);
      const verdict = parsed.verdict;
      const done = verdict === 'done';
      // v0.10.x 完成确认门：done 回执收口前必须有 Lead 完成确认（三项均 true）——
      // 缺失/不完整 → confirmation-required，条目不置 done、台账不变（先复核 diff/需求/测试）。
      if (done && !isLeadConfirmComplete(args?.lead_confirm)) {
        return fail('confirmation-required', 'receipt verdict=done requires Lead completion confirmation lead_confirm={no_drift:true,no_missing:true,no_regression:true}（先复核 diff / 需求 / 测试：无偏移、无缺失、无回退）——本次台账未变，条目仍为 ' + item.status + '。', {
          itemId,
          verdict,
          reportPath,
          recovery: '复核 diff/需求/测试后重试 relay_collect({itemId, lead_confirm:{no_drift:true,no_missing:true,no_regression:true}})',
          summary: 'confirmation-required: done verdict needs complete lead_confirm (3×true); ledger unchanged.',
        });
      }
      const nextItem = done
        ? {
          ...item,
          status: 'done',
          lead_confirm: { no_drift: true, no_missing: true, no_regression: true },
          evidence: [reportPath, ...(Array.isArray(item.evidence) ? item.evidence : [])].filter((entry, entryIndex, list) => typeof entry === 'string' && entry !== '' && list.indexOf(entry) === entryIndex).slice(0, 3),
          next: null,
        }
        : { ...item, status: 'blocked', blocked: clipText(digest, 200) || ('worker reported ' + verdict) };
      const written = await writeLedgerItems(caller, scopeId, items.map((row, rowIndex) => (rowIndex === index ? nextItem : row)), ledger.rev);
      if (written?.ok !== true) {
        return fail('ledger-write-failed', 'report read but work-ledger write failed: ' + String(written?.message ?? written?.code ?? 'unknown'), {
          reportPath,
          recovery: '重试 relay_collect（报告仍在，幂等）',
          summary: 'failed: receipt read but the ledger was not updated; retry collect (idempotent).',
        });
      }
      const ledgerStatus = done ? 'done' : 'blocked';
      logInfo(ctx, '[collect] item=' + itemId + ' verdict=' + verdict + ' ledger=' + ledgerStatus + ' report=' + reportPath);
      return lossless({
        ok: true,
        status: 'collected',
        itemId,
        verdict,
        head: parsed.headLines,
        digest,
        reportPath,
        reportBytes: read.bytes,
        ...(read.truncated === true ? { reportTruncated: true } : {}),
        ledger: { rev: written.ledger.rev, status: ledgerStatus },
        sampled: false,
        summary: 'collected item ' + itemId + ': verdict=' + verdict + '; ledger ' + ledgerStatus + '; report ' + reportPath,
        text: COLLECT_OK_PREFIX + itemId + ' · verdict ' + verdict + ' · ledger ' + ledgerStatus + ' · report ' + reportPath + ' · digest≤600\n'
          + (Array.isArray(parsed.headLines) ? parsed.headLines.join('\n') + '\n' : '') + digest,
      });
    },
  };

  return [dispatch, collect];
}

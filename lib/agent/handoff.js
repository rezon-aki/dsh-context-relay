/**
 * dsh-context-relay — relay_handoff 层：新会话创建（sessionController/agents.create 双路）、
 * workspace attach、半创建清理、模型路由与权限继承、handoff 路由注入。
 *
 * @module dsh-context-relay/agent/handoff
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { buildHandoff, normalizePhaseState } from '../policy.js';
import { copyWorkItemsToScope, ledgerEntryLine, ledgerHandoffSection, ledgerNextActions, readWorkItems, workItemsScopeOf } from './work-items.js';
import { panelStateOf, updatePanelState } from '../panel-store.js';
import { derivePhase, relayStateOf } from './derive.js';
import { PROGRESS_RELATIVE, restoreProgress, updateProgress } from './progress.js';
import { appendChainEntry, CHAIN_RELATIVE, workspaceRelativePath } from './chain.js';
import { publishLiveFor } from './sentinel.js';
import { progressKeyDocs, renderDocIndexSection } from '../docs.js';
import { noteInjection } from '../docs-metrics.js';
import { normalizeDocsOptions } from '../docs-policy.js';
import { FACT_OUTPUT_SCHEMA, clipUtf8, renderInternalResult } from '../output.js';
import { TEAM_NONE, interruptMember, listMembers, roleOf, teamKindOf } from '../team-api.js';
import { assertNoCredentials, storagePath, workspaceStore } from '../storage.js';
import {
  TOOL_PREFIX, capMap, claimRelayOperation, cwdOf, fail, handoffTitle, isTeammateSession,
  logInfo, logWarn, lossless, runDocLint, userMessage, writeWorkspaceFile,
} from './shared.js';

/** relay_handoff 继承：子会话首个模型请求要套用的旧会话路由（globalThis，跨模块实例/热重载共享；消费即删）。 */
const HANDOFF_ROUTES_KEY = Symbol.for('dsh-context-relay.handoff.routes');
function handoffRoutes() {
  const current = globalThis[HANDOFF_ROUTES_KEY];
  if (current !== undefined && typeof current.get === 'function' && typeof current.set === 'function') return current;
  const map = new Map();
  globalThis[HANDOFF_ROUTES_KEY] = map;
  return map;
}

// ── 交接清理（2026-11-01 用户需求）─────────────────────────────────────────
// relay_handoff 成功后旧会话不应残留：后台任务取消、定时任务迁移到新会话、
// 运行中的队友/子智能体中断。盘点/清理结果只写 handoff 文件与工具返回，
// 不再给新会话另发消息（2026-11-01 用户要求：那条「旧会话交接清单 + 清理结果」没用）。
const HANDOFF_CLEANUP_REASON = 'relay handoff: moved to new session';
/** 交接清理报告（写入 handoff 文件）的字符上限，避免文件被无界撑大。 */
const CLEANUP_REPORT_LIMIT = 2000;
/** 首条注入消息的分段预算（v0.14 P2：总 ≤8,000 B；8KB 预算只裁摘要，索引靠渲染分组、不再字节裁剪）。 */
const HANDOFF_INJECT_SUMMARY_BYTES = 6000;
const HANDOFF_INJECT_ENTRY_BYTES = 500;
const HANDOFF_FIRST_MESSAGE_BYTES = 8000;

/** Redact credential-bearing strings without persisting even the rejected value. */
function sanitize(value) {
  if (typeof value === 'string') { try { assertNoCredentials(value); return value; } catch { return '[REDACTED credential-like text]'; } }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
function reasonOf(error) { return sanitize(String(error?.message ?? error)); }

/** 锁内读 + 原子替换（async write lock 不阻塞事件循环；handoff 恢复日志只追加不截断）。 */
async function appendHandoff(cwd, target, text) {
  const clean = sanitize(text);
  const store = workspaceStore(cwd);
  const path = store.path(target);
  return store.withFileLock(path, () => store.replace(path, (store.readText(path) ?? '') + clean));
}

/**
 * 旧会话树中会持有资源的 session id（Lead + 队友 + 子智能体）。
 * jobs 是 session-owned，必须按 owner 逐个取消；rc.2 schedules 是 Host-wide 任务，归属看 target.sessionId，
 * 同样按旧会话树逐个改投递目标，否则旧会话归档后投递失败（2026-11-01 用户需求）。
 */
async function residualSessionIds(ctx, caller) {
  const owners = [caller.session.id];
  try {
    if (roleOf(ctx, caller)?.role === 'lead') {
      const listed = await listMembers(ctx, caller);
      if (listed.ok) for (const member of listed.members) {
        if (member.role !== 'lead' && typeof member.id === 'string') owners.push(member.id);
      }
    }
  } catch { /* 降级：只处理 Lead 自己的资源 */ }
  try {
    const subagents = ctx.get('subagents');
    if (subagents !== undefined && typeof subagents.listDescendants === 'function') {
      for (const entry of await subagents.listDescendants(caller.session.id)) {
        // diagnostic 行也带候选子会话 id：其 catalog 不可读，但名下资源仍要清，另记 errors。
        if ((entry?.kind === 'child' || entry?.kind === 'diagnostic') && typeof entry.id === 'string') owners.push(entry.id);
      }
    }
  } catch { /* 降级：只处理可枚举的资源 */ }
  return [...new Set(owners)];
}

/** listDescendants 也会把 Team 成员算作子级：按会话 id 去重，避免重复中断/计数。 */
async function teammateSessionIds(ctx, caller) {
  const ids = new Set();
  try {
    if (roleOf(ctx, caller)?.role === 'lead') {
      const listed = await listMembers(ctx, caller);
      if (listed.ok) for (const member of listed.members) {
        if (member.role !== 'lead' && typeof member.id === 'string') ids.add(member.id);
      }
    }
  } catch { /* 降级 */ }
  return ids;
}

/**
 * rc.2 ScheduleService.list() 返回分页对象 { items, shown, total, limit, offset }（非数组、不可迭代）。
 * 按服务上限显式翻页取全量；返回 undefined 表示形状不符（调用方降级 N/A+warn，不阻断交接）。
 */
async function listHostSchedules(schedule) {
  const limit = 500;
  const rows = [];
  for (let offset = 0; ;) {
    const page = await schedule.list({ limit, offset });
    if (page === null || typeof page !== 'object' || !Array.isArray(page.items)) return undefined;
    rows.push(...page.items);
    if (page.items.length === 0) return rows;
    const total = Number.isSafeInteger(page.total) ? page.total : undefined;
    if (total !== undefined && rows.length >= total) return rows;
    const next = (Number.isSafeInteger(page.offset) ? page.offset : offset) + page.items.length;
    if (total === undefined && page.items.length < limit) return rows;
    if (next <= offset) return rows;
    offset = next;
  }
}

/**
 * 冲突后重读单个 Host 任务（C3 设计承诺）：优先 rc.2 view({id})，退回 catalog()/分页 list 查找。
 * 返回 entry（读到）、null（任务已消失）、undefined（无法读取）；可选路径永不抛错。
 */
async function readHostSchedule(schedule, id) {
  try {
    if (typeof schedule?.view === 'function') {
      const entry = await schedule.view({ id });
      if (entry?.code === 'schedule_not_found') return null;
      return entry !== null && typeof entry === 'object' ? entry : undefined;
    }
    let entries;
    if (typeof schedule?.catalog === 'function') {
      const catalog = await schedule.catalog();
      entries = Array.isArray(catalog) ? catalog : undefined;
    } else if (typeof schedule?.list === 'function') {
      entries = await listHostSchedules(schedule);
    }
    if (entries === undefined) return undefined;
    return entries.find((entry) => entry?.id === id) ?? null;
  } catch {
    return undefined;
  }
}

/** rc.2 Host-wide 任务归属 = 投递目标 Session（target.kind==='session'）；new/new_once 自建会话，不属旧会话树。 */
function scheduleOwnerOf(entry) {
  const target = entry?.target;
  return target?.kind === 'session' && typeof target.sessionId === 'string' ? target.sessionId : undefined;
}

/**
 * 旧会话树运行中的后台任务快照（收集与清理共用同一口径；2026-11-01 审查 P1：
 * 清理须在中断子智能体之前快照，否则 drain 结算的任务会被静默漏报）。
 * 返回 { available, rows }：available=false 表示 jobs 服务未启用（报告写 N/A，不假干净）。
 */
function listRunningJobs(ctx, owners) {
  const jobs = ctx.get('jobs');
  if (jobs === undefined || typeof jobs.list !== 'function') return { available: false, rows: [] };
  const rows = [];
  const seen = new Set();
  for (const owner of owners) {
    for (const job of jobs.list(owner)) {
      // list(owner) 也返回 unowned jobs（任何 caller 可见）：按 owner 过滤，避免误杀宿主级无主任务。
      if (job.owner !== owner) continue;
      if (job.status !== 'running' && job.status !== 'stopping') continue;
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      rows.push({ id: job.id, kind: job.kind, label: job.label, status: job.status, owner });
    }
  }
  return { available: true, rows };
}

/** 有界拼接 + 截断标记（P2：清单不许静默截断——2026-11-01 审查）。 */
function boundedJoin(items, maxChars = 160) {
  const all = items.join('、');
  if (all.length <= maxChars) return { text: all, truncated: false, total: items.length };
  return { text: all.slice(0, maxChars), truncated: true, total: items.length };
}

/** 截断说明（无截断返回空串）。 */
function truncationNote(info) {
  return info.truncated ? '…（共 ' + info.total + ' 条，已截断；完整清单见清理结果与 handover 结构化字段）' : '';
}

/** 只读盘点：旧会话树还在跑/待处理的资源（服务未启用记 skipped=N/A；调用失败记入 errors，不假干净）。 */
async function collectHandover(ctx, caller) {
  // skipped：服务未启用的类别 -> 报告写 N/A，不写「无/0」（2026-11-01 审查 P1）。
  const inventory = { jobs: [], schedules: [], teammates: [], subagents: [], skipped: [], errors: [] };
  const sessionId = caller.session.id;
  const owners = await residualSessionIds(ctx, caller);
  try {
    const info = listRunningJobs(ctx, owners);
    if (info.available === false) inventory.skipped.push('jobs');
    inventory.jobs = info.rows;
  } catch (error) { inventory.errors.push('inventory jobs: ' + reasonOf(error)); }
  try {
    const schedule = ctx.get('schedule');
    if (schedule === undefined || typeof schedule.list !== 'function' || typeof schedule.edit !== 'function') {
      // 服务缺失/形状不符（非 rc.2）只降级 N/A+warn：可选盘点不得拒绝交接（审计 M-01 建议）。
      if (schedule !== undefined) logWarn(ctx, '[handoff] schedule seam unsupported (list/edit unavailable); schedule inventory skipped as N/A');
      inventory.skipped.push('schedule');
    } else {
      const entries = await listHostSchedules(schedule);
      if (entries === undefined) {
        logWarn(ctx, '[handoff] schedule seam unsupported: list() did not return the rc.2 page shape {items,shown,total,limit,offset}; schedule inventory skipped as N/A');
        inventory.skipped.push('schedule');
      } else {
        const ownersSet = new Set(owners);
        const seen = new Set();
        let malformed = 0;
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') { malformed += 1; continue; }
          if (entry.status === 'ended') continue;
          const owner = scheduleOwnerOf(entry);
          if (owner === undefined || !ownersSet.has(owner) || seen.has(entry.id)) continue;
          seen.add(entry.id);
          inventory.schedules.push({ id: entry.id, kind: entry.kind, title: entry.title, scheduledAt: entry.scheduledAt, owner });
        }
        if (malformed > 0) logWarn(ctx, '[handoff] schedule inventory skipped ' + malformed + ' malformed entr' + (malformed === 1 ? 'y' : 'ies') + ' (does not block handoff)');
      }
    }
  } catch (error) {
    // C3/审查缺口3：可选盘点不得阻断交接——list 调用抛错与形状不符同口径（N/A + warn，不记 errors）。
    logWarn(ctx, '[handoff] schedule inventory unavailable: ' + reasonOf(error) + '; schedule skipped as N/A (does not block handoff)');
    if (!inventory.skipped.includes('schedule')) inventory.skipped.push('schedule');
  }
  const teammateIds = await teammateSessionIds(ctx, caller);
  try {
    if (teamKindOf(ctx) === TEAM_NONE) inventory.skipped.push('teammates');
    else if (roleOf(ctx, caller)?.role === 'lead') {
      const listed = await listMembers(ctx, caller);
      if (!listed.ok) inventory.errors.push('inventory teammates: ' + listed.reason);
      else for (const member of listed.members) {
        if (member.role === 'lead') continue;
        inventory.teammates.push({ name: member.name, status: member.status, id: member.id });
      }
    }
  } catch (error) { inventory.errors.push('inventory teammates: ' + reasonOf(error)); }
  try {
    const subagents = ctx.get('subagents');
    if (subagents === undefined) inventory.skipped.push('subagents');
    else if (typeof subagents.listDescendants === 'function') {
      for (const entry of await subagents.listDescendants(sessionId)) {
        if (entry?.kind === 'diagnostic') { inventory.errors.push('subagents diagnostic ' + entry.id + ': ' + entry.reason); continue; }
        if (entry?.kind !== 'child' || typeof entry.id !== 'string') continue;
        if (teammateIds.has(entry.id)) continue;
        inventory.subagents.push({ id: entry.id, mode: entry.mode, activity: entry.activity, depth: entry.depth });
      }
    }
  } catch (error) { inventory.errors.push('inventory subagents: ' + reasonOf(error)); }
  return inventory;
}

/** 交接清单 → handoff next_actions 行（显式交给新会话处理；有截断标记 + N/A，不静默——2026-11-01 审查 P2/P1）。 */
function handoverInventoryLines(inventory) {
  const lines = [];
  const skipped = Array.isArray(inventory.skipped) ? inventory.skipped : [];
  if (skipped.includes('schedule')) lines.push('旧会话残留-定时任务：N/A（schedule 服务未启用或形状不兼容，未盘点/未迁移）');
  if (inventory.schedules.length > 0) {
    const info = boundedJoin(inventory.schedules.map((item) => item.title));
    lines.push('旧会话残留-定时任务 ' + inventory.schedules.length + ' 条：' + info.text + truncationNote(info) + '（接力成功后自动迁移到本会话，请按原意图处理）');
  }
  if (skipped.includes('jobs')) lines.push('旧会话残留-后台任务：N/A（服务未启用，未盘点/未取消）');
  if (inventory.jobs.length > 0) {
    const info = boundedJoin(inventory.jobs.map((job) => job.id + (job.label ? '（' + job.label + '）' : '')));
    lines.push('旧会话残留-后台任务 ' + inventory.jobs.length + ' 个：' + info.text + truncationNote(info) + '（接力成功后自动取消；需要重跑的由本会话处理）');
  }
  if (skipped.includes('teammates')) lines.push('旧会话残留-队友：N/A（服务未启用，未盘点/未中断）');
  if (inventory.teammates.length > 0) {
    const info = boundedJoin(inventory.teammates.map((member) => member.name + '（' + member.status + '）'));
    lines.push('旧会话残留-队友 ' + inventory.teammates.length + ' 名：' + info.text + truncationNote(info) + '（接力后中断运行中的轮次；队友不能跨会话继承，需要时本会话重新 spawn）');
  }
  if (skipped.includes('subagents')) lines.push('旧会话残留-子智能体：N/A（服务未启用，未盘点/未中断）');
  if (inventory.subagents.length > 0) {
    const info = boundedJoin(inventory.subagents.map((entry) => entry.id));
    lines.push('旧会话残留-子智能体 ' + inventory.subagents.length + ' 个：' + info.text + truncationNote(info) + '（接力后中断运行中的轮次；rc.2 没有逐 id 释放 API，资源随旧根归档/宿主关闭结算；如需结果请本会话重新委派）');
  }
  return lines;
}

/** 清理结果 → markdown（只追加到 handoff 文件；不再作为消息发给新会话——2026-11-01 用户要求。有界 + N/A + 截断计数）。 */
function renderCleanupReport(cleanup, limit = CLEANUP_REPORT_LIMIT) {
  const lines = ['## 交接清理结果（旧会话 → 新会话）'];
  const skipped = Array.isArray(cleanup.skipped) ? cleanup.skipped : [];
  const na = (key) => skipped.includes(key);
  // 错误放最前：报告被截断时「需人工确认的错误」不能先被切掉（P3）。
  if (cleanup.errors.length > 0) lines.push('- 需人工确认的错误：' + cleanup.errors.join('；'));
  lines.push('- 后台任务：' + (na('jobs') ? 'N/A（服务未启用，未清理）' : (cleanup.jobs.length === 0 ? '无' : cleanup.jobs.map((job) => job.id + ' → ' + job.action).join('；'))));
  lines.push('- 定时任务：' + (na('schedule') ? 'N/A（schedule 服务未启用或形状不兼容，未迁移）' : (cleanup.schedules.length === 0 ? '无' : cleanup.schedules.map((item) => item.title + ' → ' + item.action).join('；'))));
  lines.push('- 队友：' + (na('teammates') ? 'N/A（服务未启用，未中断）' : (cleanup.teammates.length === 0 ? '无' : cleanup.teammates.map((member) => member.name + '（' + member.action + '）').join('；'))));
  lines.push('- 子智能体：' + (na('subagents') ? 'N/A（服务未启用，未中断）' : (cleanup.subagents.length === 0 ? '无' : cleanup.subagents.map((entry) => entry.id + ' → ' + entry.action).join('；'))));
  let text = lines.join('\n') + '\n';
  if (text.length > limit) {
    const totals = '后台任务 ' + cleanup.jobs.length + ' / 定时任务 ' + cleanup.schedules.length + ' / 队友 ' + cleanup.teammates.length + ' / 子智能体 ' + cleanup.subagents.length;
    text = text.slice(0, Math.max(0, limit - 160)) + '\n…（清理报告已截断：' + totals + '；完整结果见旧会话工具返回的 handover 结构化字段）\n';
  }
  return text;
}

/** 结构化返回体的条数上限：渲染文本有界，结构化数组也不能无界（P3；导出供单测）。 */
export function boundedHandover(inventory, cleanup) {
  const cap = 20;
  let cut = false;
  const slice = (list) => { if (list.length > cap) { cut = true; return list.slice(0, cap); } return list; };
  const boundedInventory = { ...inventory, jobs: slice(inventory.jobs), schedules: slice(inventory.schedules), teammates: slice(inventory.teammates), subagents: slice(inventory.subagents), errors: slice(inventory.errors) };
  if (cleanup === null) return { inventory: boundedInventory, cleanup: null, ...(cut ? { truncated: true } : {}) };
  const boundedCleanup = { ...cleanup, jobs: slice(cleanup.jobs), schedules: slice(cleanup.schedules), teammates: slice(cleanup.teammates), subagents: slice(cleanup.subagents), errors: slice(cleanup.errors) };
  return { inventory: boundedInventory, cleanup: boundedCleanup, ...(cut ? { truncated: true } : {}) };
}

/** Each mutating step is journaled before/after; stop at its recovery point on failure. */
async function performHandoverCleanup(ctx, caller, newSessionId, inventory, journal) {
  const report = { jobs: [], schedules: [], teammates: [], subagents: [], skipped: [...inventory.skipped], errors: [], recovery: [], steps: [] };
  const effects = [];
  const step = async (name, action, recovery) => {
    const row = { step: name, state: 'planned', effects: [...effects], recovery };
    report.steps.push(row);
    try {
      await journal(row); // Cannot mutate old work without a durable recovery point.
      const effect = await action();
      effects.push(effect);
      row.state = 'completed';
      row.effects = [...effects];
      await journal(row);
      return effect;
    } catch (error) {
      row.state = 'failed';
      row.error = reasonOf(error);
      row.effects = [...effects, { step: name, outcome: 'unknown if operation threw after commit; reconcile before retry' }];
      report.errors.push(name + ': ' + row.error);
      report.recovery.push({ ...row });
      try { await journal(row); } catch (writeError) { report.recovery.push({ step: 'journal', error: reasonOf(writeError), effects: [...effects], recovery: 'Persist this returned recovery record to the full handoff file before retrying.' }); }
      throw error;
    }
  };
  try {
    if (inventory.errors.length > 0) throw new Error('inventory incomplete: ' + inventory.errors.join('; '));
    const owners = [...new Set([caller.session.id, ...inventory.teammates.map(x => x.id), ...inventory.subagents.map(x => x.id), ...inventory.jobs.map(x => x.owner), ...inventory.schedules.map(x => x.owner)])];
    const jobsSnapshot = listRunningJobs(ctx, owners);
    if (!jobsSnapshot.available && !report.skipped.includes('jobs')) report.skipped.push('jobs');
    for (const member of inventory.teammates) {
      const row = { ...member, action: 'recorded' };
      report.teammates.push(row);
      if (member.status !== 'running') continue;
      await step('interrupt-teammate:' + member.name, async () => {
        const result = await interruptMember(ctx, caller, member);
        if (!result.ok) throw new Error(result.reason);
        row.action = 'interrupted';
        return { step: 'interrupt-teammate', sessionId: member.id, name: member.name };
      }, 'Resume the existing teammate with send_message using its checkpoint; do not respawn blindly.');
    }
    const subagents = ctx.get('subagents');
    for (const entry of inventory.subagents) {
      const row = { ...entry, action: 'recorded' };
      report.subagents.push(row);
      if (entry.activity !== 'running') continue;
      await step('interrupt-subagent:' + entry.id, async () => {
        if (typeof subagents?.interrupt !== 'function') throw new Error('subagents.interrupt unavailable');
        await subagents.interrupt(entry.id, { kind: 'ancestor', agent: caller });
        row.action = 'interrupted';
        return { step: 'interrupt-subagent', sessionId: entry.id, mode: entry.mode };
      }, 'Continue this child from its checkpoint with send_message when continuable; for one-shot work re-delegate using the full handoff and existing result pointers.');
    }
    if (typeof subagents?.drainDescendants === 'function') await step('drain-descendants', async () => {
      await subagents.drainDescendants([caller]);
      return { step: 'drain-descendants', descendants: inventory.subagents };
    }, 'Read child checkpoints/results; resume continuable members, or re-delegate one-shot work from the recorded pointers. Drain may already have stopped some descendants.');
    const jobs = ctx.get('jobs');
    const seenJobs = new Set();
    if (jobsSnapshot.available && typeof jobs?.kill !== 'function') throw new Error('jobs.kill unavailable');
    for (const job of [...jobsSnapshot.rows, ...listRunningJobs(ctx, owners).rows]) {
      if (seenJobs.has(job.id)) continue;
      seenJobs.add(job.id);
      const row = { ...job, action: 'pending' };
      report.jobs.push(row);
      await step('cancel-job:' + job.id, async () => {
        const outcome = await jobs.kill(job.id, job.owner, HANDOFF_CLEANUP_REASON);
        row.action = outcome === 'already-finished' ? (job.owner === caller.session.id ? 'already-finished' : 'cancelled-with-owner') : 'killed';
        return { step: 'cancel-job', ...row };
      }, 'Inspect job_output and its launch tool event/checkpoint (owner ' + job.owner + ', job ' + job.id + ', label ' + (job.label ?? '') + '); restart only unfinished work with its original command. Cancellation has no automatic inverse.');
    }
    const schedule = ctx.get('schedule');
    for (const item of inventory.schedules) {
      const row = { id: item.id, title: item.title, kind: item.kind, owner: item.owner, action: 'pending' };
      report.schedules.push(row);
      await step('migrate-schedule:' + item.id, async () => {
        if (typeof schedule?.edit !== 'function') throw new Error('schedule.edit unavailable at cleanup time');
        // rc.2 Host-wide 任务换投递目标即可：规则与投递史都保留（审计 M-01 建议），无需 create/delete 双份。
        const request = { id: item.id, action: 'update', patch: { target: { kind: 'session', sessionId: newSessionId } } };
        await journal({ step: 'schedule-source:' + item.id, state: 'planned', source: item, request, recovery: 'rc.2 Host-wide task unchanged before retarget; rule and delivery history are preserved.' });
        let updated = await schedule.edit(request);
        if (updated?.code === 'schedule_conflict') {
          // C3 设计承诺：乐观并发冲突（未提交）→ 重读当前任务一次，带最新 updatedAt 重试 edit 仅 1 次；
          // 仍冲突则走通用 throw 交 recovery（不静默改记 transferred）。重读失败不阻断重试。
          const current = await readHostSchedule(schedule, item.id);
          logWarn(ctx, '[handoff] schedule.edit conflict id=' + item.id + '; re-read '
            + (current === null ? 'not-found' : current === undefined ? 'unavailable' : 'updatedAt=' + String(current.updatedAt ?? '?'))
            + '; retrying edit once');
          const expectedUpdatedAt = typeof current?.updatedAt === 'string' ? current.updatedAt : undefined;
          updated = await schedule.edit(expectedUpdatedAt === undefined ? request : { ...request, expectedUpdatedAt });
        }
        if (typeof updated?.code === 'string') {
          if (updated.code === 'schedule_not_found') {
            row.action = 'not-found';
            return { step: 'migrate-schedule', ...row };
          }
          throw new Error('schedule.edit refused: ' + updated.code);
        }
        if (typeof updated?.id !== 'string') throw new Error('schedule.edit returned no entry; inspect host schedules before retrying');
        // 只认官方返回的当前 task 状态：target 未确认改到新会话时不能记 transferred。
        if (updated?.target?.kind !== 'session' || updated.target.sessionId !== newSessionId) throw new Error('schedule.edit did not confirm the retarget; inspect host schedules before retrying');
        row.action = 'transferred';
        row.target = { kind: 'session', sessionId: newSessionId };
        effects.push({ step: 'schedule-retargeted', id: item.id, target: row.target });
        await journal({ step: 'schedule-retargeted:' + item.id, state: 'completed', effects: [...effects], recovery: 'Target changed to ' + newSessionId + '; retarget the same id back to the old owner Session to undo.' });
        return { step: 'migrate-schedule', ...row };
      }, 'Source ' + item.owner + '/' + item.id + ' is still armed on the old Session; retarget it with edit({id, action:"update", patch:{target:{kind:"session", sessionId:"' + newSessionId + '"}}}). Rule and delivery history are preserved; retarget the same id to undo.');
    }
  } catch (error) {
    if (report.errors.length === 0) {
      const row = { step: 'cleanup-preparation', error: reasonOf(error), effects: [...effects], recovery: 'Re-inventory old resources and resume at the first unfinished step; do not repeat completed cancellations.' };
      report.errors.push(row.step + ': ' + row.error);
      report.recovery.push(row);
      try { await journal(row); } catch (writeError) { report.recovery.push({ step: 'journal', error: reasonOf(writeError), recovery: 'Persist returned recovery to the full handoff file.' }); }
    }
  }
  return report;
}

async function attachWorkspace(ctx, sessionId, cwd, delays = [0, 250, 750]) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || cwd === undefined) return { ok: false, error: 'workspace service or cwd unavailable' };
  let lastError = 'unknown';
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i] > 0) await new Promise((resolve) => setTimeout(resolve, delays[i]));
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (workspace === undefined) workspace = await registry.create(cwd);
      await workspace.attachSession(sessionId);
      return { ok: true, workspaceId: workspace.id, title: workspace.title };
    } catch (error) {
      lastError = reasonOf(error);
    }
  }
  return { ok: false, error: lastError };
}

/** Retained failures are reusable recovery points, never anonymous orphan sessions. */
const RECOVERY_SESSIONS_KEY = Symbol.for('dsh-context-relay.handoff.recovery');
function recoverySessions() { return globalThis[RECOVERY_SESSIONS_KEY] ??= new Map(); }
function recoveryName(sourceId) { return 'handoff-recovery-' + encodeURIComponent(sourceId) + '.json'; }
async function persistRecovery(cwd, sourceId, value) { await writeWorkspaceFile(cwd, recoveryName(sourceId), JSON.stringify(sanitize(value))); }
function retainedRecovery(cwd, sourceId) {
  const memory = recoverySessions().get(sourceId);
  if (memory !== undefined) return memory;
  try { const value = JSON.parse(readFileSync(join(cwd, '.scratch/context-relay', recoveryName(sourceId)), 'utf8')); return value.state === 'completed' ? undefined : value; }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

function acceptanceOf(live, message) {
  if ([...(live.inbox?.nextTurn ?? []), ...(live.inbox?.nextStep ?? [])].some(item => item.id === message.id)) return { accepted: true, evidence: 'agent.inbox', messageId: message.id };
  for (const event of live.session.snapshotEvents?.() ?? []) {
    if ((event.type === 'user/message' && event.data?.id === message.id)
      || (event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(item => item.id === message.id))) return { accepted: true, evidence: event.type, seq: event.seq, messageId: message.id };
  }
  return { accepted: false, messageId: message.id };
}

async function disposeHalfCreated(ctx, sourceId, sessionId, live, handle, journal, cwd) {
  handoffRoutes().delete(sessionId);
  const recovery = [];
  if (sessionId === undefined) return recovery;
  if (typeof handle?.dispose === 'function') {
    try { await handle.dispose(); await persistRecovery(cwd, sourceId, { sessionId, state: 'completed' }); recoverySessions().delete(sourceId); return [{ step: 'dispose-new-session', state: 'completed', sessionId }]; }
    catch (error) { recovery.push({ step: 'dispose-new-session', error: reasonOf(error), recovery: 'Retry the owned handle disposer; otherwise reuse this same session, never create another.' }); }
  }
  // Controller-created Agents have no public disposer capability. Park + reuse, not agents.get(...).dispose().
  try {
    if (typeof live?.cancel !== 'function') throw new Error('new agent cancel unavailable');
    live.cancel({ kind: 'hook', reason: 'relay handoff not accepted; retained for recovery' });
    if (typeof live.whenIdle === 'function') await live.whenIdle();
    recovery.push({ step: 'park-new-session', state: 'completed', sessionId, recovery: 'Retry relay_handoff from the old session; it reuses this session.' });
  } catch (error) { recovery.push({ step: 'park-new-session', error: reasonOf(error), sessionId, recovery: 'Stop the destination explicitly and retry this recovery point; do not create another session.' }); }
  recoverySessions().set(sourceId, { sessionId, live, handle });
  try { await persistRecovery(cwd, sourceId, { sessionId, state: 'parked', recovery }); } catch (error) { recovery.push({ step: 'persist-retained-session', error: reasonOf(error), recovery: 'Save returned destination id; do not create another session.' }); }
  try { await journal({ step: 'retained-session', sessionId, sourceId, recovery }); } catch (error) { recovery.push({ step: 'journal', error: reasonOf(error), recovery: 'Persist this returned sessionId and recovery information before retrying.' }); }
  return recovery;
}

/** 会话最新请求头的 provider/model（压缩调用用）。 */
export function providerModelOf(caller) {
  const header = caller?.session?.requestHeader?.();
  const config = header?.config ?? {};
  return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort };
}

/**
 * 旧会话当前模型路由：优先未消费的 modelSelection pending（UI 刚切但还没发请求），
 * 其次最新 request/header（adapterDefaults 标记的 effort/maxTokens 视为模型默认，不继承），
 * 最后 agent options 兜底。与官方 subagent 的 parentAgentOptionsForDelegation 同口径。
 */
function callerRoute(ctx, caller) {
  const session = caller?.session;
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
  let pending;
  try {
    const projections = ctx.get('sessionProjections');
    pending = typeof projections?.stateOf === 'function' ? projections.stateOf(session, 'modelSelection')?.pending : undefined;
  } catch { pending = undefined; }
  const config = header?.config ?? {};
  const options = caller?.options ?? {};
  const effortDefaulted = header?.adapterDefaults?.reasoningEffort === true;
  const maxTokensDefaulted = header?.adapterDefaults?.maxTokens === true;
  const provider = pending?.provider ?? config.provider ?? options.provider;
  const model = pending?.model ?? config.model ?? options.model;
  const reasoningEffort = pending !== undefined && pending !== null
    ? pending.reasoningEffort
    : effortDefaulted ? undefined : (config.reasoningEffort ?? options.reasoningEffort);
  const maxTokens = maxTokensDefaulted ? undefined : (config.maxTokens ?? options.maxTokens);
  const route = {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
  };
  return Object.keys(route).length > 0 ? route : undefined;
}

/**
 * relay_handoff 继承旧会话设置（模型 + 权限）：
 * - 模型：controller 路径没有创建时模型入口 → 记进 HANDOFF_ROUTES，子会话首个 agent/request 套用；
 * - 权限：直接落到子会话事件（perms.set 走 preset 名；custom 组合按 knob 事件补齐）。
 * 失败一律降级为「不继承」，不阻断接力。
 */
function inheritCallerSettings(ctx, caller, childSession, withRoute) {
  const inherited = {};
  try {
    const route = callerRoute(ctx, caller);
    if (route !== undefined) {
      if (withRoute) {
        handoffRoutes().set(childSession.id, route);
        capMap(handoffRoutes());
      }
      inherited.model = route;
    }
  } catch { /* 路由继承失败不阻断 */ }
  try {
    const perms = ctx.get('permissionPresets');
    if (perms !== undefined && typeof perms.set === 'function') {
      // P2-21：permissionState 是官方 private API（d.ts 标注 private）；缺失时不能静默跳过
      // custom 权限继承——新会话会回落部署默认权限（可能更宽/更严），必须留 warn 便于排障。
      if (typeof perms.permissionState !== 'function') {
        logWarn(ctx, '[handoff] permission inheritance skipped: permissionPresets.permissionState unavailable (private API missing); new session keeps the deployment default permission');
      } else {
        const name = typeof perms.current === 'function' ? perms.current(caller.session) : undefined;
        if (typeof name === 'string' && name !== 'custom') {
          perms.set(childSession, name);
          inherited.permission = { preset: name };
        } else {
          const state = perms.permissionState(caller.session);
          if (state !== null && state !== undefined) {
            if (typeof state.sandbox === 'string') childSession.append('sandbox/mode', { mode: state.sandbox, source: 'relay-handoff' });
            if (typeof state.approval === 'string') childSession.append('approval/policy', { policy: state.approval, source: 'relay-handoff' });
            inherited.permission = { preset: state.preset, sandbox: state.sandbox, approval: state.approval };
          }
        }
      }
    }
  } catch (error) {
    logWarn(ctx, '[handoff] inherit permission skipped: ' + reasonOf(error));
  }
  return Object.keys(inherited).length > 0 ? inherited : undefined;
}

/** T0 交接廉价 lint 的风险档：进程内记忆优先，其次台账 currentPhase.risk（插件重载后仍能省 git 全量 lint）。 */
export function lintRiskTierOf(memoryTier, ledger) {
  const memory = typeof memoryTier === 'string' && memoryTier !== '' ? memoryTier : undefined;
  const stored = typeof ledger?.currentPhase?.risk?.tier === 'string' ? ledger.currentPhase.risk.tier : undefined;
  return memory ?? stored;
}

/** relay_handoff 工具定义（runtime = { ctx, currentThresholds, presetId, singlePresetId, inheritOnHandoff, relayPresetIds }）。 */
export function createRelayHandoffTool(runtime) {
  const { ctx, currentThresholds, presetId, inheritOnHandoff, relayPresetIds } = runtime;
  const docs = normalizeDocsOptions(runtime.docs);
  /** v0.9.0 M4（D2=A/#5/#59/#61）：交接目标恒为唯一生产模式 id（host 经 relayPresetIds 首项传 single）。
   * 旧 runtime/直接挂载缺 singlePresetId 时退化为白名单首项或本 preset——不再有「两个模式任选」语义。 */
  const singlePresetId = typeof runtime.singlePresetId === 'string' && runtime.singlePresetId !== ''
    ? runtime.singlePresetId
    : (Array.isArray(relayPresetIds) && relayPresetIds.length > 0 ? relayPresetIds[0] : presetId);
  return {
    name: TOOL_PREFIX + 'handoff',
    description: 'Handoff: bounded advisory summary (default 16KB) injected into a new top-level relay session + full un-truncated handoff file in the workspace (all fields/items/verbatim, read on demand); Lead-only; human_approved=true. Approval: autoHandoff/authorizeNext only — a mode selection does not grant an approval exemption (see protocol / composer panel). Old session kept as audit archive.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['human_approved'],
      properties: {
        human_approved: { type: 'boolean', description: 'true only after explicit human approval.' },
        status: {
          type: 'object', additionalProperties: false,
          description: 'Status block.',
          properties: {
            // v0.9.0 #10/M4：status.phase 允许 5 主链 + 2 显式出口（blocked/cancel 会话也可交接）。
            phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship', 'blocked', 'cancel'] },
            goal: { type: 'string', description: 'Goal.' },
            success_criteria: { type: 'array', items: { type: 'string' } },
            done: { type: 'array', items: { type: 'string' }, description: 'Done.' },
            next_actions: { type: 'array', items: { type: 'string' }, description: 'Next DoD.' },
            blocked: { type: 'array', items: { type: 'string' }, description: 'Blockers/P0.' },
          },
        },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence pointers (<=11; a doc_lint line is auto-appended and counts into the 12 cap).' },
        key_docs: { type: 'array', items: { type: 'string' }, description: 'Docs to open first (<=8).' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions with reasons (<=10).' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints (<=8).' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'Open questions tagged P0/P1/P2 (<=5).' },
        risks: { type: 'array', items: { type: 'string' }, description: 'Risks/rollback (<=8).' },
        discarded: { type: 'array', items: { type: 'string' }, description: 'Discarded context (<=8).' },
        title: { type: 'string', description: 'Optional title.' },
      },
    },
    // D3/W2：只给内部事实（新会话/清理状态/恢复入口），不产用户段。
    output: { schema: FACT_OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: renderInternalResult(v, (x) => x?.text ?? x?.summary) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_handoff requires a calling agent');
      // 协议禁止队友建顶层会话：subagent/teammate 只能回执 Lead，由 Lead 做接力。
      if (isTeammateSession(ctx, caller)) {
        return fail('lead-only', 'relay_handoff is Lead-only', { summary: 'refused: subagent/teammate sessions must report to the Lead; only the Lead may create the relay session.' });
      }
      if (args?.human_approved !== true) {
        return fail('human-approval-required', 'human approval required', { retryable: false, next: '先向用户取得明确 Go/No-go；拿到 human_approved=true 后重试。', summary: 'refused: ask the human for an explicit Go/No-go first, then call again with human_approved=true. Suggested checklist: goal still correct? P0 open questions resolved? anything in discarded that the human needs?' });
      }
      const release = claimRelayOperation(caller.session);
      if (release === undefined) {
        return fail('relay-busy', 'busy: another relay operation in flight', { summary: 'refused: busy — another relay operation (relay_organize/relay_handoff) is in flight in this session; wait for it to settle, then retry.' });
      }
      // Lead 设计缺口：handedOff=true 仍允许（兼容/人类可能坚持再接力），但成功 summary 必须
      // 明确警告这是重复接力（会再建会话/耗额度）；旧会话静音语义保留。
      const alreadyHandedOff = panelStateOf(caller.session.id).handedOff === true;
      if (alreadyHandedOff) logWarn(ctx, '[handoff] duplicate relay: session already handed off, creating another session');
      try {
        const cwd = cwdOf(caller.session);
        const status = { ...(args?.status ?? {}) };
        let phase;
        try {
          // v0.9.0 #10/M4：出口会话（blocked/cancel）也可交接——按 ALL_PHASES 归一（derivePhase 的 fallback 同样可为出口）。
          phase = normalizePhaseState(status.phase, derivePhase(caller.session, relayStateOf(ctx, caller.session)));
        } catch (error) {
          // P3：非法 status.phase 返回结构化 handoff-invalid（不裸抛）。
          const message = reasonOf(error);
          logWarn(ctx, '[handoff] invalid status: ' + message);
          return fail('handoff-invalid', message, { summary: 'refused: ' + message + ' (phase must be discover|decide|build|verify|ship|blocked|cancel); no handoff file or session was created.' });
        }
        status.phase = phase;
        let retained;
        try { retained = retainedRecovery(cwd, caller.session.id); } catch (error) { return fail('recovery-unreadable', reasonOf(error), { summary: 'Recover unreadable handoff recovery manifest before creating another session.' }); }
        if (retained?.takeover?.accepted === true) return fail('recovery-required', 'Destination already accepted; reconcile recorded cleanup before any new handoff', {
          sessionId: retained.sessionId,
          handoffPath: retained.handoffPath,
          recovery: retained.recovery,
          effects: '本次没有新建会话或交接单；已有已接受的交接单：' + retained.handoffPath + '；目标会话 ' + retained.sessionId + ' 仍需按 recovery 收尾；旧会话仍活跃。',
          retryable: false,
          next: '先按 recovery 完成目标会话 ' + retained.sessionId + ' 的收尾；不要重复 relay_handoff 再建会话。',
          summary: 'Continue accepted destination ' + retained.sessionId + '; finish recorded recovery, do not create duplicate handoff.',
        });
        // Validate service availability before documents or child state can change.
        const agentsService = ctx.get('agents');
        const presets = ctx.get('agentPresets');
        const controller = ctx.get('sessionController');
        if (!(typeof controller?.create === 'function' || (typeof agentsService?.create === 'function' && typeof presets?.mount === 'function'))) return fail('services-unavailable', 'agents/agentPresets service unavailable', { summary: 'handoff preflight refused; no documents or sessions changed.' });
        // 工作台账（契约 §5）：enabled 时读；读/损坏都 fail-open（不阻断交接），corrupt 时透出 workItemsWarning。
        const workItemsConfig = runtime.workItems ?? { enabled: true, gate: 'strict', max: 30, pathOverride: undefined };
        let ledger;
        if (workItemsConfig.enabled !== false) {
          try { ledger = readWorkItems(cwd, { pathOverride: workItemsConfig.pathOverride, scopeId: workItemsScopeOf(caller.session) }); } catch (error) { logWarn(ctx, '[handoff] work items read failed: ' + reasonOf(error)); ledger = undefined; }
        }
        const ledgerNext = ledger !== undefined && ledger.exists === true ? ledgerNextActions(ledger.items) : { actions: [], omitted: [] };
        const workItemsWarning = ledger?.corruptBackup === undefined
          ? undefined
          : '工作台账文件损坏，已备份到 ' + ledger.corruptBackup + '，按空台账继续（fail-open，未阻断交接）';
        if (workItemsWarning !== undefined) logWarn(ctx, '[handoff] ' + workItemsWarning);
        // 交接盘点（2026-11-01 用户需求）：旧会话树残留的后台任务/定时任务/队友/子智能体显式交给新会话。
        // 追加在用户 next_actions 之后：buildHandoff 的 next_actions 有 8 条上限，不能让自动清单挤掉未完成工作；
        // 完整清单另由 handoff 文件与工具返回 handover 兜底（v0.2.5 起不再给新会话另发消息）。
        const inventory = await collectHandover(ctx, caller);
        if (inventory.errors.length > 0) return fail('handoff-preflight-failed', 'Old resource inventory incomplete', { recovery: inventory.errors, summary: 'Preflight failed; no handoff document, destination, or old-work mutation. Repair inventory service and retry.' });
        const inventoryLines = handoverInventoryLines(inventory);
        const userNextActions = Array.isArray(status.next_actions) ? status.next_actions : [];
        // 工作台账（契约 §5）：台账未闭合项排在用户条目之后、旧会话残留清单之前（自动清单不挤掉用户工作）。
        const fallbackNextAction = '旧会话未提供 next_actions（模型未记录未完成工作）：新会话请从状态/证据/旧会话记录接手，先对齐用户需求再开工。';
        const nextActions = [...userNextActions, ...ledgerNext.actions, ...inventoryLines];
        // 未完成工作模型漏填时的兜底提示：宿主无法自动采集在手任务，但不能静默交接（有自动清单时也要提示）。
        if (userNextActions.length === 0) nextActions.push(fallbackNextAction);
        if (nextActions.length > 0) status.next_actions = nextActions;
        const goalText = String(status.goal ?? '').replace(/\s+/g, ' ').trim();
        // relay-docs-v2：T0 交接只跑廉价 lint（cheapOnly，免 git 全量子进程）；重载后由台账 currentPhase.risk 兜底。
        const memoryTier = typeof runtime.riskTierOf === 'function' ? runtime.riskTierOf(caller.session.id) : undefined;
        const riskTier = lintRiskTierOf(memoryTier, ledger);
        const lint = runDocLint(cwd, undefined, 1024, { sessionDocs: true, ...(riskTier === undefined ? {} : { riskTier }) });
        const suppliedEvidence = (Array.isArray(args?.evidence) ? args.evidence : []).map((item) => String(item));
        const evidence = suppliedEvidence.some((item) => /doc_lint:/.test(item)) ? suppliedEvidence : [lint.evidence, ...suppliedEvidence];
        let handoff;
        try {
          handoff = buildHandoff({
            status,
            evidence,
            summaryBytes: HANDOFF_INJECT_SUMMARY_BYTES,
            key_docs: args?.key_docs,
            decisions: args?.decisions,
            constraints: args?.constraints,
            open_questions: args?.open_questions,
            risks: args?.risks,
            discarded: args?.discarded,
            sessionId: caller.session.id,
          });
        } catch (error) {
          return fail('handoff-invalid', reasonOf(error), { summary: 'refused: ' + reasonOf(error) });
        }
        // v0.8.0（文档系统 v2）：体积只做 advisory——不再预检拒绝（handoff-truncated 已删除）。
        // 摘要（handoff.markdown）注入新会话首条消息；完整内容（全部字段/条目/原文）写盘按需取。
        let fullMarkdown = handoff.fullMarkdown;
        // 工作台账正文段（契约 §5）：完整追加到完整文件（不截断、不静默丢）；摘要里只保留台账计数入口行。
        if (ledger !== undefined && ledger.exists === true && ledger.counts.total > 0) {
          const section = String(ledgerHandoffSection(ledger, { omitted: ledgerNext.omitted }) ?? '');
          if (section !== '') fullMarkdown += (fullMarkdown.endsWith('\n') ? '' : '\n') + section + '\n';
        }
        let handoffPath;
        // 顺序保证（用户 2026-11-01：交接时先写好文档再交接）：先写 handoff 快照文件 → 建新会话
        // → 更新滚动进度文件 progress.md → 最后才把首条消息发给新会话（live.followup）。因此新会话
        // 收到首条消息前文档已写盘；doc_lint 只作证据、不设拒绝硬门（用户裁决 A）。
        try {
          handoffPath = await writeWorkspaceFile(cwd, 'handoff-' + Date.now() + '.md', fullMarkdown);
        } catch (error) {
          // P2#9：写盘失败结构化降级；此时尚未建会话，无副作用。
          const reason = reasonOf(error);
          logWarn(ctx, '[handoff] failed code=handoff-write-failed reason=' + reason);
          return fail('handoff-write-failed', 'handoff could not be written: ' + reason, { summary: 'handoff aborted: could not write the handoff file under .scratch/context-relay (' + reason + '); no session was created. Check workspace write permission (cwd: ' + cwd + ').' });
        }
        const route = inheritOnHandoff ? callerRoute(ctx, caller) : undefined;
        // 目标 preset 恒为唯一模式 id（v0.9.0 M4 起单模式；不再按会话选择交接目标）。
        const targetPresetId = singlePresetId;
        const operationId = randomUUID();
        const journal = (record) => appendHandoff(cwd, handoffPath, '\n\n## handoff recovery\n' + JSON.stringify(sanitize({ operationId, owner: caller.session.id, ...record }), null, 2) + '\n');
        let sessionId;
        let live;
        let ownedHandle;
        let createdVia = 'agents.create';
        try {
          if (retained !== undefined) {
            sessionId = retained.sessionId;
            live = retained.live ?? agentsService?.get?.(sessionId);
            ownedHandle = retained.handle;
            if (live === undefined) throw new Error('retained session unavailable; recover session ' + sessionId + ' before creating another');
            createdVia = 'recovery-reuse';
          } else if (controller !== undefined && typeof controller.create === 'function') {
            // GUI 同款路径：sessionController.create 负责组装 agent/preset/模型选择，
            // 比裸 agents.create 更稳（实测裸 create + followup 会在首轮触发
            // provider INVALID_REQUEST: all tools deferred）。
            createdVia = 'sessionController.create';
            const created = await controller.create({ cwd, agentPreset: targetPresetId });
            sessionId = created.sessionId;
            // 不继承调用方模型路由：官方 selectModel 会 agentDefaultModel.saveSelection(...)，
            // 静默改写部署默认模型；新会话用部署默认路由（见 audit-core #3）。
            const candidate = agentsService?.get?.(sessionId);
            live = typeof candidate?.followup === 'function' ? candidate : agentsService?.list?.().find(candidate => candidate.session?.id === sessionId);
            if (live === undefined) {
              const recovery = await disposeHalfCreated(ctx, caller.session.id, sessionId, live, ownedHandle, journal, cwd);
              return fail('session-not-live', 'created session unavailable; retained for recovery', {
                sessionId,
                handoffPath,
                halfCreated: true,
                recovery,
                effects: '交接单已写盘：' + handoffPath + '；已创建会话 ' + sessionId + ' 但不可用（半创建，保留待恢复）；首条消息未发送；旧会话仍活跃。',
                retryable: false,
                next: '按 recovery 处理半创建会话 ' + sessionId + '；先按交接单 ' + handoffPath + ' 恢复，不要重复 relay_handoff 再建会话。',
                summary: 'Old session remains active; reuse retained destination ' + sessionId + ' after recovery.',
              });
            }
          } else {
            if (agentsService === undefined || typeof agentsService.create !== 'function' || presets === undefined) {
              logWarn(ctx, '[handoff] degraded code=services-unavailable');
              return fail('services-unavailable', 'agents/agentPresets service unavailable', {
                handoffPath,
                effects: '交接单已写盘：' + handoffPath + '；没有创建新会话（agents/agentPresets 服务不可用）；旧会话仍活跃。',
                retryable: false,
                next: '先修复 preset 部署；已有交接单可直接用于恢复（' + handoffPath + '），不要重复 relay_handoff 再写交接单/再建会话。',
                summary: 'handoff written to ' + handoffPath + ' but could not create a new session (agents/agentPresets services unavailable in this preset); relay manually or fix the preset deployment.',
              });
            }
            sessionId = 'session-' + randomUUID();
            const routeConfig = route !== undefined ? { ...route } : undefined;
            const seed = routeConfig === undefined ? undefined : [{ type: 'request/header', seq: 0, time: Date.now(), data: { header: { config: routeConfig }, reason: 'initial' } }];
            const handle = await agentsService.create({
              sessionId,
              ...(routeConfig === undefined ? {} : { agentOptions: routeConfig }),
              meta: { cwd, agentPreset: targetPresetId },
              setup: async (agentCtx) => { await presets.mount(agentCtx, targetPresetId); },
              ...(seed === undefined ? {} : { seed }),
            });
            ownedHandle = handle;
            live = handle.agent;
          }
          recoverySessions().set(caller.session.id, { sessionId, live, handle: ownedHandle });
          await persistRecovery(cwd, caller.session.id, { sessionId, state: 'created', handoffPath });
        } catch (error) {
          const reason = reasonOf(error);
          logWarn(ctx, '[handoff] failed code=session-create-failed reason=' + reason);
          const recovery = await disposeHalfCreated(ctx, caller.session.id, sessionId, live, ownedHandle, journal, cwd);
          const halfCreated = typeof sessionId === 'string' && sessionId !== '';
          return fail('session-create-failed', 'session creation failed: ' + reason, {
            handoffPath,
            sessionId,
            recovery,
            effects: '交接单已写盘：' + handoffPath + '；' + (halfCreated ? '会话 ' + sessionId + ' 创建失败/半创建（已记入 recovery）；' : '没有建出新会话；') + '首条消息未发送；旧会话仍活跃。',
            retryable: false,
            next: '先按交接单 ' + handoffPath + ' 核对/恢复；按 recovery 处理半创建会话，不要重复 relay_handoff 再写交接单/再建会话。',
            summary: 'handoff written but session creation failed: ' + reason + '. Handoff file: ' + handoffPath + ' (no session was started).',
          });
        }
        // 继承旧会话的模型路由（controller 路径无创建时入口，延到子会话首个请求）与权限。
        const inherited = inheritOnHandoff && live !== undefined
          ? inheritCallerSettings(ctx, caller, live.session, createdVia === 'sessionController.create')
          : undefined;
        if (inherited !== undefined) logInfo(ctx, '[handoff] inherit session=' + sessionId + ' ' + JSON.stringify(inherited));
        const attach = await attachWorkspace(ctx, sessionId, cwd);
        // P2#1：attach 失败但会话可用（agent 已 live）→ 降级成功继续交付：summary 明确
        // 「workspace attach failed: …」，返回体带 info.code='relay-attach-failed' 供上层识别。
        const attachError = attach.ok === true ? undefined : String(attach.error ?? 'unknown');
        if (attachError !== undefined) logWarn(ctx, '[handoff] degraded code=workspace-attach-failed session=' + sessionId + ' reason=' + attachError);
        const title = String(args?.title ?? '').trim() || handoffTitle(goalText);
        try { ctx.get('sessionTitle')?.rename?.(live.session, title); } catch { /* 标题失败不阻断 */ }
        // v0.5.1：台账跟会话走——交接把源会话的会话级台账复制到新会话作用域（rev 保留），
        // 新会话入口行/返回体指向新路径；无台账、显式共享 workItemsPath、目标已存在 → 跳过（fail-open）。
        let childLedgerRelative;
        if (workItemsConfig.enabled !== false) {
          try {
            childLedgerRelative = await copyWorkItemsToScope(cwd, {
              fromScopeId: workItemsScopeOf(caller.session),
              toScopeId: sessionId,
              pathOverride: workItemsConfig.pathOverride,
            });
          } catch (error) { logWarn(ctx, '[handoff] work items copy failed: ' + reasonOf(error)); }
        }
        // 滚动进度文件（长线记忆，2026-11-01 用户要求 B 方案）：交接时合并/滚动；失败不阻断接力。
        let progress;
        try {
          progress = await updateProgress(cwd, {
            sessionId,
            phase,
            status,
            evidence,
            decisions: args?.decisions,
            constraints: args?.constraints,
            risks: args?.risks,
            open_questions: args?.open_questions,
            key_docs: args?.key_docs,
            handoffPath,
          });
          if (progress.corruptBackup !== undefined) logWarn(ctx, '[handoff] progress corrupted, backup: ' + progress.corruptBackup);
        } catch (error) {
          progress = { updated: false, error: reasonOf(error) };
          logWarn(ctx, '[handoff] progress update failed: ' + reasonOf(error));
          const recovery = await disposeHalfCreated(ctx, caller.session.id, sessionId, live, ownedHandle, journal, cwd);
          try { await journal({ step: 'progress-write-failed', error: reasonOf(error), effects: ['old work unchanged'], recovery }); } catch (writeError) { recovery.push({ step: 'journal', error: reasonOf(writeError), recovery: 'Persist returned recovery before retry.' }); }
          return fail('progress-write-failed', reasonOf(error), {
            sessionId,
            handoffPath,
            recovery,
            effects: '交接单已写盘：' + handoffPath + '；新会话 ' + sessionId + ' 已创建；progress.md 未更新；首条消息未发送；旧会话仍活跃。',
            retryable: false,
            next: '按 recovery 处理新会话 ' + sessionId + ' 并修复 progress 写入；先按交接单恢复，不要重复 relay_handoff 再建会话。',
            summary: 'Progress document incomplete; no prompt dispatched and old work remains active.',
          });
        }
        // 首条消息的接手入口：progress.md（长线状态）+ chain.ndjson（召回索引）+ 指针回读方式。
        // 细节（归档规则/回读实测/召回纪律）在常驻协议，这里只给指针，避免交接时重复占窗口。
        const progressPointer = progress?.updated === true
          ? '长线状态：' + PROGRESS_RELATIVE + '；'
          : '长线状态：progress.md 本次更新失败（见工具返回）；';
        // 工作台账（契约 §5）：首条消息的接手入口追加台账入口行（非空时 '\n' 前缀）。
        // v0.14：优先读交接后的子会话台账（doing 已归一 open），入口行不把旧 owner/doing 带给新 Lead。
        const childLedger = childLedgerRelative === undefined ? undefined : (() => { try { return readWorkItems(cwd, { scopeId: sessionId }); } catch { return undefined; } })();
        const ledgerForEntry = childLedger !== undefined && childLedger.exists === true ? childLedger : ledger;
        const ledgerEntry = ledgerForEntry !== undefined && ledgerForEntry.exists === true
          ? ledgerEntryLine(childLedgerRelative === undefined ? ledgerForEntry : { ...ledgerForEntry, relativePath: childLedgerRelative })
          : '';
        const entryNote = '\n\n## 接手入口\n' + progressPointer + '召回索引：' + CHAIN_RELATIVE
          + '；回读旧会话用 session_event_read({session_id, seq})；细节见常驻协议。'
          + '\n交接只保证链式记忆可取，不保证队伍回来：不重建小队、不回放队友、不自动 spawn。'
          + (ledgerEntry === '' ? '' : '\n' + ledgerEntry);
        // v0.2.7「交接后新会话注入」：子会话值 = 父会话 handoffUnlimitedBudget（若显式）否则父会话生效值；
        // 必须在 live.followup（触发新会话首个 step 的 prompt assembly）之前写入，否则首条注入可能读到旧值。
        // 写失败只丢继承、不阻断接力（与既有 4 个持久开关的继承同口径）。
        try {
          const parentPanel = panelStateOf(caller.session.id);
          const childBudget = parentPanel.handoffUnlimitedBudget === true || parentPanel.handoffUnlimitedBudget === false
            ? parentPanel.handoffUnlimitedBudget
            : parentPanel.unlimitedBudget;
          // force=true：即使交接值恰好等于当前 settings 默认也显式落子会话记录，
          // 保证「强制注入/不注入」不随后日侧栏默认变化（no-op 优化会吞掉相等值）。
          updatePanelState(sessionId, { unlimitedBudget: childBudget }, { source: 'agent', force: true });
          logInfo(ctx, '[handoff] budget toggle session=' + sessionId + ' unlimitedBudget=' + String(childBudget));
        } catch (error) {
          logWarn(ctx, '[handoff] budget toggle inherit skipped: ' + reasonOf(error));
        }
        let takeover;
        let docIndexRendered;
        try {
          let docIndexText = '';
          try {
            // relay-docs-v2：pin = 台账 currentPhase.pins + 本次 key_docs + progress.key_docs fallback；
            // 折叠组本身也是入口（shown=0 但 groups>0 时同样注入，保证任何路径 ≤2 次调用可达）。
            const pins = [...(ledger?.currentPhase?.pins ?? []), ...(Array.isArray(args?.key_docs) ? args.key_docs : []), ...progressKeyDocs(cwd)];
            const index = renderDocIndexSection(cwd, { pins, select: docs.select, layout: docs.layout, width: docs.width, maxGroups: docs.maxGroups });
            if (index.shown > 0 || index.groups.length > 0) {
              docIndexText = index.text.trimEnd();
              docIndexRendered = index;
            }
          } catch (error) { logWarn(ctx, '[handoff] doc index: ' + reasonOf(error)); }
          // v0.14 P2：首条仍用 userMessage（source.kind='user'），只加机器头并压到 ≤8KB；
          // 8KB 预算只裁摘要（索引过长靠渲染分组），完整内容始终在 handoff 文件。
          const firstHeader = '[交接摘要·系统生成，非用户发言]\n';
          const firstTail = '\n\n用户可见的话自己写（不套模板）；内部记号与禁词见协议 §用户语域。';
          const docIndexInjected = docIndexText === '' ? '' : '\n\n' + docIndexText;
          const entryInjected = clipUtf8(entryNote, HANDOFF_INJECT_ENTRY_BYTES);
          const fullPointer = '\n\n## 完整交接单（全部细节）\n完整交接单：' + workspaceRelativePath(cwd, handoffPath) + ' — 用 read 或 relay_doc read 按需取';
          const fixedBytes = Buffer.byteLength(firstHeader + docIndexInjected + fullPointer + entryInjected + firstTail, 'utf8');
          const summaryInjected = clipUtf8(handoff.markdown, Math.max(0, HANDOFF_FIRST_MESSAGE_BYTES - fixedBytes));
          const message = userMessage(firstHeader + summaryInjected + docIndexInjected + fullPointer + entryInjected + firstTail);
          await journal({ step: 'inventory', state: 'completed', inventory, recovery: 'Full inventory; old work unchanged.' });
          await journal({ step: 'dispatch', state: 'planned', sessionId, messageId: message.id, recovery: 'Old work remains active; dispose or reuse destination if not accepted.' });
          await live.followup(message);
          takeover = acceptanceOf(live, message);
          if (!takeover.accepted) { const error = new Error('No official inbox/event evidence for first-message acceptance'); error.code = 'takeover-unconfirmed'; throw error; }
          await journal({ step: 'takeover-confirmed', ...takeover, sessionId });
          // 注入埋点只在交接验收成功后写（与 organize 的成功门控对齐）：失败/半创建不得留「已注入」事件。
          if (docIndexRendered !== undefined && docs.metrics) { try { noteInjection({ cwd, sessionId, site: 'handoff', rendered: docIndexRendered }); } catch { /* 埋点失败不阻断交接 */ } }
          const accepted = { sessionId, handoffPath, takeover, state: 'accepted', recovery: 'Consult complete handoff journal before resuming cleanup; do not create another destination.' };
          recoverySessions().set(caller.session.id, accepted);
          await persistRecovery(cwd, caller.session.id, accepted);
        } catch (error) {
          const reason = reasonOf(error);
          const recovery = await disposeHalfCreated(ctx, caller.session.id, sessionId, live, ownedHandle, journal, cwd);
          try { if (progress?.updated === true) await restoreProgress(progress); }
          catch (rollbackError) { recovery.push({ step: 'restore-progress', error: reasonOf(rollbackError), effects: ['progress may still point to ' + sessionId], recovery: 'Restore old progress using its backup and full handoff before retry.' }); }
          const code = error?.code === 'takeover-unconfirmed' ? 'takeover-unconfirmed' : 'followup-failed';
          try { await journal({ step: code, error: reason, effects: ['old work unchanged'], recovery }); }
          catch (writeError) { recovery.push({ step: 'journal', error: reasonOf(writeError), recovery: 'Persist returned recovery in full handoff before retry.' }); }
          return fail(code, reason, {
            sessionId,
            handoffPath,
            halfCreated: true,
            recovery,
            effects: '交接单已写盘：' + handoffPath + '；新会话 ' + sessionId + ' 已创建；首条消息未被接受（' + code + '）；旧会话仍活跃；清理/复用见 recovery。',
            retryable: false,
            next: '按 recovery 清理或复用新会话 ' + sessionId + '；先按交接单恢复，不要重复 relay_handoff 再建会话。',
            summary: 'Handoff not accepted; old session remains active. Retry relay_handoff only after following cleanup/reuse recovery: ' + handoffPath,
          });
        }
        // Chain index is appended only after acceptance.
        try {
          await appendChainEntry(cwd, {
            kind: 'handoff',
            sessionId: caller.session.id,
            childSessionId: sessionId,
            phase,
            goal: goalText,
            handoffPath: workspaceRelativePath(cwd, handoffPath),
          });
        } catch (error) {
          logWarn(ctx, '[handoff] chain index failed: ' + reasonOf(error));
        }
        // 交接清理（2026-11-01）：旧会话树不残留——后台任务取消、定时任务迁移、队友/子智能体中断；
        // 交接清单 + 清理结果只写进 handoff 文件与工具返回，不再给新会话另发消息（2026-11-01 用户要求）。
        const inventoryBlock = inventoryLines.length > 0 ? '## 交接清单（旧会话残留，自动盘点）\n' + inventoryLines.join('\n') + '\n\n' : '';
        // v0.8.0：清理报告/交接清单完整追加到完整文件（不截断、不静默丢）；truncated 保留 false 兼容返回形状。
        const cleanupDelivery = { bytes: 0, truncated: false };
        const appendCleanupReport = async (report) => {
          try {
            await appendHandoff(cwd, handoffPath, '\n\n' + inventoryBlock + report);
            cleanupDelivery.bytes = statSync(handoffPath).size;
          } catch (error) { cleanupDelivery.error = reasonOf(error); }
        };
        let handover;
        // summary 计数必须来自未截断的全量（boundedHandover 截断前），否则 >20 时少报（P3）。
        const handoverTotals = { jobs: inventory.jobs.length, schedules: inventory.schedules.length, teammates: inventory.teammates.length, subagents: inventory.subagents.length, cleanedJobs: null, cleanedSchedules: null, cleanedTeammates: null, cleanedSubagents: null };
        try {
          const cleanup = await performHandoverCleanup(ctx, caller, sessionId, inventory, journal);
          if (inventory.errors.length > 0) cleanup.errors = [...new Set([...inventory.errors, ...cleanup.errors])];
          handover = boundedHandover(inventory, cleanup);
          handoverTotals.cleanedJobs = cleanup.jobs.filter((row) => row.action === 'killed' || row.action === 'cancelled-with-owner').length;
          handoverTotals.cleanedSchedules = cleanup.schedules.filter((row) => row.action === 'transferred').length;
          handoverTotals.cleanedTeammates = cleanup.teammates.filter((row) => row.action === 'interrupted').length;
          handoverTotals.cleanedSubagents = cleanup.subagents.filter((row) => row.action === 'interrupted').length;
          await appendCleanupReport(renderCleanupReport(cleanup, Infinity));
          if (cleanup.errors.length > 0) {
            if (cleanupDelivery.error !== undefined) cleanup.recovery.push({ step: 'cleanup-report', error: cleanupDelivery.error, recovery: 'Persist returned recovery in the full handoff file.' });
            const accepted = { sessionId, handoffPath, takeover, state: 'recovery-required', recovery: cleanup.recovery };
            recoverySessions().set(caller.session.id, accepted);
            try { await persistRecovery(cwd, caller.session.id, accepted); } catch (error) { cleanup.recovery.push({ step: 'persist-recovery', error: reasonOf(error), recovery: 'Persist this returned recovery before restarting host.' }); }
            return fail('handoff-cleanup-failed', 'Destination accepted; old cleanup stopped at recovery point', {
              sessionId, handoffPath, takeover, handover, recovery: cleanup.recovery,
              partial: true,
              effects: '新会话已创建并接受首条消息；旧会话清理停在恢复点，未完成的清理项见 unclean/recovery。',
              retryable: false,
              next: '按 recovery 逐项完成旧会话清理；不要重复 relay_handoff 再建会话。链式记忆用 chain.ndjson/交接指针 + session_event_read 按 seq 回读。',
              facts: { partial: true, sessionId, handoffPath, unclean: { errors: cleanup.errors, recovery: cleanup.recovery }, chain: CHAIN_RELATIVE },
              summary: 'Destination accepted; cleanup failed. Old session remains resumable; follow full handoff recovery journal.',
            });
          }
          logInfo(ctx, '[handoff] cleanup jobs=' + cleanup.jobs.length + ' schedules=' + cleanup.schedules.length + ' teammates=' + cleanup.teammates.length + ' subagents=' + cleanup.subagents.length + ' errors=' + cleanup.errors.length);
        } catch (error) {
          const reason = reasonOf(error);
          handover = { ...boundedHandover(inventory, null), error: reason, truncated: true };
          logWarn(ctx, '[handoff] cleanup failed: ' + reason);
          // 整体清理抛错也要留痕：清理失败与残留清单写入 handoff 文件与返回体 handover（不再给新会话发消息）。
          await appendCleanupReport(renderCleanupReport({ jobs: [], schedules: [], teammates: [], subagents: [], skipped: inventory.skipped, errors: [...inventory.errors, 'cleanup failed: ' + reason] }));
        }
        if (handover?.cleanup === null || cleanupDelivery.error !== undefined) {
          const recovery = [{ step: 'cleanup-report', error: cleanupDelivery.error ?? handover.error, effects: handover, recovery: 'Persist returned effects into full handoff and reconcile old work before retry.' }];
          return fail('handoff-cleanup-failed', 'Cleanup/report failed after acceptance', {
            sessionId, handoffPath, takeover, handover, recovery,
            partial: true,
            effects: '新会话已创建并接受首条消息；旧会话清理未完成或清理报告未落盘。',
            retryable: false,
            next: '按 recovery 把清理结果补写进完整交接单并完成旧会话清理；不要重复 relay_handoff 再建会话。',
            facts: { partial: true, sessionId, handoffPath, unclean: { error: cleanupDelivery.error ?? handover.error, recovery }, chain: CHAIN_RELATIVE },
            summary: 'Destination accepted; cleanup incomplete; old session remains resumable.',
          });
        }
        try { await persistRecovery(cwd, caller.session.id, { sessionId, state: 'completed' }); recoverySessions().delete(caller.session.id); }
        catch (error) { const recovery = [{ step: 'complete-recovery-manifest', error: reasonOf(error), effects: handover, recovery: 'All recorded cleanup completed; mark this manifest completed after verifying the handoff journal. Do not create a duplicate destination.' }]; try { journal({ step: 'complete-recovery-manifest', recovery }); } catch (journalError) { recovery.push({ step: 'journal', error: reasonOf(journalError), recovery: 'Persist this returned recovery into the complete handoff document.' }); } return fail('handoff-cleanup-failed', reasonOf(error), { sessionId, handoffPath, takeover, recovery, partial: true, effects: '新会话已创建并接受；旧会话清理已记录；恢复清单最终写盘失败。', retryable: false, next: '按 recovery 核对并补写恢复清单；不要重复 relay_handoff 再建会话。', facts: { partial: true, sessionId, handoffPath, unclean: { recovery }, chain: CHAIN_RELATIVE }, summary: 'Destination accepted and cleanup recorded; final recovery manifest write failed. Follow recovery before any retry.' }); }
        // 服务未启用（N/A）与截断：summary 显式标注，不假干净/不静默（2026-11-01 审查 P1/P2）。
        const cleanupSkipped = new Set([...(Array.isArray(inventory.skipped) ? inventory.skipped : []), ...(Array.isArray(handover?.cleanup?.skipped) ? handover.cleanup.skipped : [])]);
        const countText = (key, value) => (cleanupSkipped.has(key) ? 'N/A' : String(value));
        const cleanedText = (key, value, verb) => (cleanupSkipped.has(key) ? 'N/A' : value + verb);
        // v0.9.0 #26/#53（D3=A）：接力成功 = 旧会话归档 → 会话本地授权全部失效：
        // autoCompress / autoHandoff / authorizeNext 置 false（authorizeNext 原为「消费一次性」，现按授权失效一并清）；
        // 模型推荐清空（旧会话归档，推荐不再有意义）。
        // 只清授权/一次性状态：模式 defaultOperation 与架构师 architect/architectModel 保留仅审计（不删）。
        // handedOff：本会话已归档，后续 pre-step 不再注入到线提醒/重申（旧会话静音语义保留）。
        try {
          updatePanelState(caller.session.id, {
            handedOff: true,
            autoCompress: false,
            autoHandoff: false,
            authorizeNext: false,
            recommendedOperation: null,
            recommendedReason: '',
            recommendedAt: null,
          }, { source: 'agent' });
        } catch { /* 忽略 */ }
        // v0.9.0 #26/#53（D3=A）：模式与授权不随接力继承——新会话模式由新根 seed 默认「压缩继续」
        // （批次1 已实现，本段不再 force 覆盖），免审授权从零开始（按侧栏默认）；旧会话授权已在上方清空。
        // 只继承非授权的架构师开关/显式模型选择（v0.6.4/#56），source=agent + force 钉住值；
        // 同步失败只丢继承，不阻断接力。
        try {
          const inheritedPanel = panelStateOf(caller.session.id);
          // v0.6.4：专职架构师开关随接力继承（父会话生效值；force 钉住，不随后日默认漂移）。
          // v0.9.0 #56：显式 architectModel 随接力 sticky；null=新会话未显式选择→跟随新会话模型默认。
          updatePanelState(sessionId, { architect: inheritedPanel.architect, architectModel: inheritedPanel.architectModel ?? null }, { source: 'agent', force: true });
        } catch { /* 忽略 */ }
        logInfo(ctx, '[handoff] ok session=' + sessionId + ' via=' + createdVia + ' preset=' + targetPresetId + ' title=' + title + (alreadyHandedOff ? ' duplicate=true' : '') + (attachError === undefined ? '' : ' workspace=attach-failed'));
        // v0.8.0：caps 语义改 advisory；fullBytes 取最终完整文件字节（含台账段/清理报告）。
        const caps = { ...handoff.caps, fullBytes: cleanupDelivery.bytes > 0 ? cleanupDelivery.bytes : Buffer.byteLength(fullMarkdown, 'utf8') };
        const result = {
          ok: true,
          takeover,
          sessionId,
          title,
          phase,
          handoffPath,
          caps,
          warnings: caps.warnings,
          ...(ledgerForEntry !== undefined && ledgerForEntry.exists === true ? { workItems: { relativePath: childLedgerRelative ?? ledgerForEntry.relativePath, rev: ledgerForEntry.rev, counts: ledgerForEntry.counts, omitted: ledgerNext.omitted } } : {}),
          ...(workItemsWarning === undefined ? {} : { workItemsWarning }),
          progress: progress.updated === true
            ? { updated: true, path: PROGRESS_RELATIVE, bytes: progress.bytes, archived: progress.archived }
            : { updated: false, error: progress.error },

          workspace: attach,
          createdVia,
          ...(inherited === undefined ? {} : { inherited }),
          ...(attachError === undefined ? {} : { info: { code: 'relay-attach-failed', message: 'workspace attach failed: ' + attachError } }),
          ...(handover === undefined ? {} : { handover }),
          ...(handover === undefined ? {} : { handoffFileBytes: cleanupDelivery.bytes, cleanupReportTruncated: cleanupDelivery.truncated }),
          docLint: { level: lint.level, summary: lint.summary },
          summary: 'relay session created via ' + createdVia + ': ' + sessionId + ' (' + title + '); handoff: ' + handoffPath + ' (saved：摘要已注入新会话，完整内容在文件；摘要 ' + caps.bytes.used + '/' + caps.bytes.limit + ' B，完整 ' + caps.fullBytes + ' B' + (caps.split ? '，摘要按 advisory 阈值分层（细节见 caps.warnings）' : '') + ')' + (attachError === undefined ? '' : '; workspace attach failed: ' + attachError + ' — session is usable without the workspace binding; attach cwd manually from the session list') + (handover === undefined ? '' : '; 交接清理：后台任务 ' + countText('jobs', handoverTotals.jobs) + '→' + (handover.cleanup === null ? '未清理' : cleanedText('jobs', handoverTotals.cleanedJobs, ' 已取消')) + ' / 定时任务 ' + countText('schedule', handoverTotals.schedules) + '→' + (handover.cleanup === null ? '未迁移' : cleanedText('schedule', handoverTotals.cleanedSchedules, ' 已迁移')) + ' / 队友 ' + countText('teammates', handoverTotals.teammates) + '→' + (handover.cleanup === null ? '未清理' : cleanedText('teammates', handoverTotals.cleanedTeammates, ' 已中断')) + ' / 子智能体 ' + countText('subagents', handoverTotals.subagents) + '→' + (handover.cleanup === null ? '未清理' : cleanedText('subagents', handoverTotals.cleanedSubagents, ' 已中断')) + (handover.cleanup === null ? '；清理失败：' + handover.error : (handover.cleanup.errors.length > 0 ? '；清理告警 ' + handover.cleanup.errors.length + ' 条' : '')) + (handover.truncated === true ? '；结构化清理清单已截断（>20 条，完整结果见 handover 字段与 handoff 文件）' : '')) + '; open it from the session list to continue. Old session is kept as audit archive.' + (progress?.updated === true ? '; 滚动进度：' + PROGRESS_RELATIVE : '') + (workItemsWarning === undefined ? '' : '; 工作台账文件损坏（已备份到 ' + ledger.corruptBackup + '，按空台账 fail-open 继续交接）')
            + (alreadyHandedOff ? ' **警告：该会话 handedOff=true 已完成过接力，这是重复接力（会再建会话/耗额度）；旧会话静音语义保留，若不是有意重复请直接继续旧会话。**' : ''),
        };
        // D3/W2：成功也只返回内部事实——新会话入口、清理状态、链式记忆指针、下一步。
        const skippedList = [...cleanupSkipped];
        const cleanupFact = handover === undefined ? undefined : {
          jobs: handoverTotals.jobs,
          schedules: handoverTotals.schedules,
          teammates: handoverTotals.teammates,
          subagents: handoverTotals.subagents,
          ...(skippedList.length === 0 ? {} : { skipped: skippedList }),
          ...(Array.isArray(handover.cleanup?.errors) && handover.cleanup.errors.length > 0 ? { errors: handover.cleanup.errors } : {}),
        };
        result.text = 'handoff accepted · 新会话 ' + sessionId + '（' + title + '）· 旧会话已归档（只作审计，不再开新活）。'
          + '链式记忆：' + CHAIN_RELATIVE + ' + progress + 交接指针；需要时用 session_event_read({session_id, seq}) 按 seq 回读；'
          + '交接只保证链式记忆可取，不保证队伍回来：不重建小队、不回放队友、不自动 spawn。'
          + (skippedList.length === 0 ? '' : ' 清理未检查/不适用：' + skippedList.join('、') + '。')
          + (Array.isArray(handover?.cleanup?.errors) && handover.cleanup.errors.length > 0 ? ' 清理告警 ' + handover.cleanup.errors.length + ' 条，详见交接单。' : '')
          + (attachError === undefined ? '' : ' 新会话未绑定工作区，需要时手动挂载。')
          + ' 下一步：从会话列表打开新会话继续。';
        result.facts = {
          kind: 'handoff',
          status: 'accepted',
          sessionId,
          handoffPath,
          phase,
          chain: CHAIN_RELATIVE,
          next: '从会话列表打开新会话继续；需要旧上下文时按 chain.ndjson/交接指针用 session_event_read 回读。',
          evidence: [handoffPath, PROGRESS_RELATIVE, CHAIN_RELATIVE],
          ...(cleanupFact === undefined ? {} : { cleanup: cleanupFact }),
          ...(skippedList.length === 0 ? {} : { risk: 'cleanup-unchecked' }),
          ...(caps.split ? { summarySplit: true } : {}),
        };
        return lossless(result);
      } finally {
        release();
        publishLiveFor(ctx, caller.session, currentThresholds());
      }
    },
  };
}

/** 子会话首个 agent/request 套用旧会话路由（controller.create 无创建时模型入口）。 */
export function installHandoffRoute(ctx) {
  // ── relay_handoff 继承：子会话首次模型请求套用旧会话路由（controller.create 不接收模型）──
  // 只在「本会话还没有任何 request/header」时生效；消费即删，用户之后的 UI 换模型不受影响。
  ctx.effect(() => ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    try {
      const session = payload?.agent?.session;
      if (session === undefined) return resolved;
      const route = handoffRoutes().get(session.id);
      if (route === undefined) return resolved;
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
      handoffRoutes().delete(session.id);
      if (header !== undefined) return resolved;
      logInfo(ctx, '[handoff] inherit route applied session=' + session.id + ' ' + JSON.stringify(route));
      return { ...resolved, ...route };
    } catch {
      return resolved;
    }
  }, { prepend: true }), 'dsh-context-relay: handoff route');
}

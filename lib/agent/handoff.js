/**
 * dsh-context-relay — relay_handoff 层：新会话创建（sessionController/agents.create 双路）、
 * workspace attach、半创建清理、模型路由与权限继承、handoff 路由注入。
 *
 * @module dsh-context-relay/agent/handoff
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { HANDOFF_LIMITS, buildHandoff, normalizePhase } from '../policy.js';
import { panelStateOf, updatePanelState } from '../panel-store.js';
import { recordHandoff } from '../handoff-store.js';
import { derivePhase, relayStateOf } from './derive.js';
import { PROGRESS_RELATIVE, restoreProgress, updateProgress } from './progress.js';
import { appendChainEntry, CHAIN_RELATIVE, workspaceRelativePath } from './chain.js';
import { publishLiveFor } from './sentinel.js';
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

function reasonOf(error) {
  return String(error?.message ?? error).slice(0, 160);
}

/**
 * 旧会话树中会持有资源的 session id（Lead + 队友 + 子智能体）。
 * jobs/schedules 是 session-owned：归属无法跨会话转移，必须按 owner 逐个处理，
 * 否则队友/子智能体名下的任务会在旧会话归档后继续跑（2026-11-01 用户需求）。
 */
async function residualSessionIds(ctx, caller) {
  const owners = [caller.session.id];
  try {
    const teams = ctx.get('agentTeams');
    if (teams !== undefined && typeof teams.tryMembership === 'function' && typeof teams.listMembers === 'function' && teams.tryMembership(caller)?.role === 'lead') {
      for (const member of teams.listMembers(caller)) {
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
    const teams = ctx.get('agentTeams');
    if (teams !== undefined && typeof teams.tryMembership === 'function' && typeof teams.listMembers === 'function' && teams.tryMembership(caller)?.role === 'lead') {
      for (const member of teams.listMembers(caller)) {
        if (member.role !== 'lead' && typeof member.id === 'string') ids.add(member.id);
      }
    }
  } catch { /* 降级 */ }
  return ids;
}

/** ScheduleRecord → create 请求（定时任务迁移到新会话，保留绝对到期时刻）。 */
function scheduleCreateOf(record) {
  const base = { title: record.title, prompt: record.prompt };
  switch (record.kind) {
    // after 记录同时带绝对 scheduledAt：用 at 迁移，避免从「交接这一刻」重新计时。
    case 'after':
    case 'at': return { ...base, at: record.scheduledAt };
    case 'every': return { ...base, every_seconds: record.everySeconds };
    case 'daily': return { ...base, daily: { time: record.time, time_zone: record.timeZone } };
    case 'weekly': return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } };
    case 'cron': return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } };
    default: throw new Error('unsupported schedule kind: ' + String(record?.kind));
  }
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
    if (schedule === undefined || typeof schedule.list !== 'function') inventory.skipped.push('schedule');
    else {
      const seen = new Set();
      for (const owner of owners) {
        for (const record of await schedule.list({ sessionId: owner })) {
          if (record?.status === 'inactive') continue;
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          inventory.schedules.push({ id: record.id, kind: record.kind, title: record.title, scheduledAt: record.scheduledAt, owner });
        }
      }
    }
  } catch (error) { inventory.errors.push('inventory schedule: ' + reasonOf(error)); }
  const teammateIds = await teammateSessionIds(ctx, caller);
  try {
    const teams = ctx.get('agentTeams');
    if (teams === undefined) inventory.skipped.push('agentTeams');
    else if (typeof teams.tryMembership === 'function' && teams.tryMembership(caller)?.role === 'lead' && typeof teams.listMembers === 'function') {
      for (const member of teams.listMembers(caller)) {
        if (member.role === 'lead') continue;
        inventory.teammates.push({ name: member.name, status: member.status, id: member.id });
      }
    }
  } catch (error) { inventory.errors.push('inventory agentTeams: ' + reasonOf(error)); }
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
  if (skipped.includes('schedule')) lines.push('旧会话残留-定时任务：N/A（服务未启用，未盘点/未迁移）');
  if (inventory.schedules.length > 0) {
    const info = boundedJoin(inventory.schedules.map((item) => item.title));
    lines.push('旧会话残留-定时任务 ' + inventory.schedules.length + ' 条：' + info.text + truncationNote(info) + '（接力成功后自动迁移到本会话，请按原意图处理）');
  }
  if (skipped.includes('jobs')) lines.push('旧会话残留-后台任务：N/A（服务未启用，未盘点/未取消）');
  if (inventory.jobs.length > 0) {
    const info = boundedJoin(inventory.jobs.map((job) => job.id + (job.label ? '（' + job.label + '）' : '')));
    lines.push('旧会话残留-后台任务 ' + inventory.jobs.length + ' 个：' + info.text + truncationNote(info) + '（接力成功后自动取消；需要重跑的由本会话处理）');
  }
  if (skipped.includes('agentTeams')) lines.push('旧会话残留-队友：N/A（服务未启用，未盘点/未中断）');
  if (inventory.teammates.length > 0) {
    const info = boundedJoin(inventory.teammates.map((member) => member.name + '（' + member.status + '）'));
    lines.push('旧会话残留-队友 ' + inventory.teammates.length + ' 名：' + info.text + truncationNote(info) + '（接力后中断运行中的轮次；队友不能跨会话继承，需要时本会话重新 spawn）');
  }
  if (skipped.includes('subagents')) lines.push('旧会话残留-子智能体：N/A（服务未启用，未盘点/未中断）');
  if (inventory.subagents.length > 0) {
    const info = boundedJoin(inventory.subagents.map((entry) => entry.id));
    lines.push('旧会话残留-子智能体 ' + inventory.subagents.length + ' 个：' + info.text + truncationNote(info) + '（接力后中断并释放；如需结果请本会话重新委派）');
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
  lines.push('- 定时任务：' + (na('schedule') ? 'N/A（服务未启用，未迁移）' : (cleanup.schedules.length === 0 ? '无' : cleanup.schedules.map((item) => item.title + ' → ' + item.action + (item.newId === undefined ? '' : '（新 id ' + item.newId + '）')).join('；'))));
  lines.push('- 队友：' + (na('agentTeams') ? 'N/A（服务未启用，未中断）' : (cleanup.teammates.length === 0 ? '无' : cleanup.teammates.map((member) => member.name + '（' + member.action + '）').join('；'))));
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

/**
 * 交接文档超限时的预检提示（2026-11-01 用户追加；v0.2.6 按 user 反馈 + 独立审查重写）：
 * ① 区分三类原因：8KB 字节上限（bytes/section:）vs 列表条数超上限（items:）vs 单条超 200 字符（chars:）——
 *    旧文案把条目裁剪/条数裁剪都写成「达到 8KB 上限」，模型照抄成「因 8KB 上限做了 200 字截断」。
 * ② 超限在写文件/建会话**之前**就拒绝（code=handoff-truncated），修改后重试不会重复接力/耗额度。
 * ③ 溢出细节只能写进不受这些上限约束的文档（progress.md 自身 ≤8KB 且会裁剪，不能当溢出容器）。
 * ④ 不要在给用户的汇报里写截断说明（用户 2026-11-01：没信息量，把交接文档写好就够了）。
 */
function handoffTruncationHint(caps) {
  const sections = Array.isArray(caps?.truncatedSections) ? caps.truncatedSections : [];
  const droppedSections = sections.filter((item) => item.startsWith('section:')).map((item) => item.slice('section:'.length));
  const droppedLists = sections.filter((item) => item.startsWith('items:')).map((item) => item.slice('items:'.length));
  const clippedLists = sections.filter((item) => item.startsWith('chars:')).map((item) => item.slice('chars:'.length));
  const bytes = caps?.bytes;
  const causes = [];
  if (sections.includes('bytes')) {
    causes.push('整体达到 8KB 上限（' + (bytes?.used ?? '?') + '/' + (bytes?.limit ?? '?') + ' 字节）' + (droppedSections.length > 0 ? '，丢掉的段：' + droppedSections.join('、') : ''));
  }
  if (droppedLists.length > 0) causes.push('列表条数超出上限被裁：' + droppedLists.join('、') + '（各列表上限见 caps.items）');
  if (clippedLists.length > 0) causes.push('单条超过 ' + HANDOFF_LIMITS.itemChars + ' 字符被裁的列表：' + clippedLists.join('、'));
  if (causes.length === 0) causes.push('部分段/条目超限被裁');
  return '交接文档超限（' + causes.join('；') + '）。**本次未写 handoff 文件、未创建会话**（按下面修改后直接重试 relay_handoff 即可，不会重复接力/耗额度）。处理：优先级 goal/next_actions/blocked/done（接手必需）> key_docs > evidence > decisions > open_questions/risks/constraints/discarded（后段可丢）；把超长条目改短，需要细节就写进**不受这些上限约束的已有文档或新建文件**（**不要写进 progress.md——它自身 ≤8KB 且会裁剪**）并在 key_docs 里引用；**不要在给用户的汇报里写截断说明或「未丢实质信息」之类的解释**（2026-11-01 用户裁决：没信息量，把交接文档写好就够了）。';
}

/** 执行交接清理（best-effort，逐项记录；失败不阻断接力，但写进结果让新会话/用户处理）。 */
async function performHandoverCleanup(ctx, caller, newSessionId) {
  const sessionId = caller.session.id;
  // skipped：服务未启用的类别 -> 报告写 N/A，不假干净（2026-11-01 审查 P1）。
  const report = { jobs: [], schedules: [], teammates: [], subagents: [], skipped: [], errors: [] };
  const owners = await residualSessionIds(ctx, caller);
  const teammateIds = await teammateSessionIds(ctx, caller);
  // 先快照旧会话树「运行中」的后台任务，再中断成员：drain 会结算子智能体名下任务（owner teardown），
  // 快照保证这些任务出现在清理结果里，而不是被静默漏报（2026-11-01 审查 P1，真机 E2E 发现）。
  let jobsSnapshot;
  try { jobsSnapshot = listRunningJobs(ctx, owners); } catch (error) { report.errors.push('jobs snapshot: ' + reasonOf(error)); }
  // 先停「会继续产生工作」的成员（队友/子智能体），再统一取消旧会话树的后台任务，避免清理期间新任务被拉起。
  try {
    const teams = ctx.get('agentTeams');
    if (teams === undefined) report.skipped.push('agentTeams');
    else if (typeof teams.tryMembership === 'function' && teams.tryMembership(caller)?.role === 'lead' && typeof teams.listMembers === 'function') {
      for (const member of teams.listMembers(caller)) {
        if (member.role === 'lead') continue;
        const row = { name: member.name, status: member.status, action: 'recorded' };
        if (member.status === 'running' && typeof teams.interrupt === 'function') {
          try { teams.interrupt(caller, member.name); row.action = 'interrupted'; } catch (error) { row.action = 'interrupt-failed'; report.errors.push('teammate ' + member.name + ': ' + reasonOf(error)); }
        }
        report.teammates.push(row);
      }
    }
  } catch (error) { report.errors.push('agentTeams: ' + reasonOf(error)); }
  try {
    const subagents = ctx.get('subagents');
    if (subagents === undefined) report.skipped.push('subagents');
    else if (typeof subagents.listDescendants === 'function') {
      const listed = await subagents.listDescendants(sessionId);
      for (const entry of listed) if (entry?.kind === 'diagnostic') report.errors.push('subagents diagnostic ' + entry.id + ': ' + entry.reason);
      const descendants = listed.filter((entry) => entry?.kind === 'child' && typeof entry.id === 'string' && !teammateIds.has(entry.id));
      for (const entry of descendants) {
        const row = { id: entry.id, mode: entry.mode, action: 'recorded' };
        if (entry.activity === 'running' && typeof subagents.interrupt === 'function') {
          try { subagents.interrupt(entry.id, { kind: 'ancestor', agent: caller }); row.action = 'interrupted'; } catch (error) { row.action = 'interrupt-failed'; report.errors.push('subagent ' + entry.id + ': ' + reasonOf(error)); }
        }
        report.subagents.push(row);
      }
      if (typeof subagents.listChildren === 'function' && typeof subagents.drainChildren === 'function') {
        try {
          const direct = (await subagents.listChildren(sessionId)).filter((entry) => entry?.kind === 'child' && typeof entry.id === 'string').map((entry) => entry.id);
          if (direct.length > 0) await subagents.drainChildren(caller, direct);
        } catch (error) { report.errors.push('subagents drain: ' + reasonOf(error)); }
      }
      // drainDescendants 会 abort materializing 子级并停掉全部 managed 后代（覆盖 provisioning/深层子级）。
      if (typeof subagents.drainDescendants === 'function') {
        try { await subagents.drainDescendants([caller]); } catch (error) { report.errors.push('subagents drainDescendants: ' + reasonOf(error)); }
      }
    }
  } catch (error) { report.errors.push('subagents: ' + reasonOf(error)); }
  try {
    const jobs = ctx.get('jobs');
    if (jobs === undefined || typeof jobs.list !== 'function' || typeof jobs.kill !== 'function') report.skipped.push('jobs');
    else {
      const attempted = new Set();
      const handle = (job) => {
        if (attempted.has(job.id)) return;
        attempted.add(job.id);
        const row = { id: job.id, kind: job.kind, label: job.label, owner: job.owner, action: 'killed' };
        try {
          const outcome = jobs.kill(job.id, job.owner, HANDOFF_CLEANUP_REASON);
          // 已被 owner 中断结算（子智能体 drain 时 teardown）：报 cancelled-with-owner——不漏报也不假报 killed。
          if (outcome === 'already-finished') row.action = job.owner === sessionId ? 'already-finished' : 'cancelled-with-owner';
        } catch (error) { row.action = 'kill-failed'; report.errors.push('job ' + job.id + ': ' + reasonOf(error)); }
        report.jobs.push(row);
      };
      for (const job of jobsSnapshot?.rows ?? []) handle(job);
      // 中断期间/之后新出现的运行中任务：再扫一遍（attempted 去重，不会重复取消）。
      try { for (const job of listRunningJobs(ctx, owners).rows) handle(job); } catch (error) { report.errors.push('jobs rescan: ' + reasonOf(error)); }
    }
  } catch (error) { report.errors.push('jobs: ' + reasonOf(error)); }
  try {
    const schedule = ctx.get('schedule');
    if (schedule === undefined || typeof schedule.list !== 'function' || typeof schedule.create !== 'function' || typeof schedule.delete !== 'function') report.skipped.push('schedule');
    else {
      const seen = new Set();
      for (const owner of owners) {
        for (const record of await schedule.list({ sessionId: owner })) {
          if (record?.status === 'inactive') continue;
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          const row = { id: record.id, title: record.title, kind: record.kind, action: 'transferred' };
          let created;
          try {
            created = await schedule.create(newSessionId, scheduleCreateOf(record));
          } catch (error) {
            row.action = 'transfer-failed';
            report.errors.push('schedule ' + record.id + ': ' + reasonOf(error));
            report.schedules.push(row);
            continue;
          }
          try {
            const removed = await schedule.delete({ sessionId: owner, id: record.id });
            if (removed?.deleted === false) row.note = 'old row already absent';
            else row.newId = created?.id;
          } catch (error) {
            // 旧行未删成功：回滚刚建的新行，避免旧+新双份。
            row.action = 'transfer-failed';
            try { if (created?.id !== undefined) await schedule.delete({ sessionId: newSessionId, id: created.id }); } catch (rollbackError) { report.errors.push('schedule rollback ' + created.id + ': ' + reasonOf(rollbackError)); }
            report.errors.push('schedule ' + record.id + ': ' + reasonOf(error));
          }
          report.schedules.push(row);
        }
      }
    }
  } catch (error) { report.errors.push('schedule: ' + reasonOf(error)); }
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
      lastError = String(error?.message ?? error);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * P2#1 半创建清理：best-effort dispose 已创建但未交付的会话。
 * agents.get 缺失 / 无 dispose / 清理抛错都跳过（不阻断失败返回，也不影响正常路径）。
 */
function disposeHalfCreated(ctx, sessionId) {
  if (sessionId === undefined || sessionId === null) return;
  try {
    ctx.get('agents')?.get?.(sessionId)?.dispose?.();
  } catch { /* 清理失败不阻断返回 */ }
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
    logWarn(ctx, '[handoff] inherit permission skipped: ' + String(error?.message ?? error));
  }
  return Object.keys(inherited).length > 0 ? inherited : undefined;
}

/** relay_handoff 工具定义（runtime = { ctx, currentThresholds, presetId, inheritOnHandoff, relayPresetIds }）。 */
export function createRelayHandoffTool(runtime) {
  const { ctx, currentThresholds, presetId, inheritOnHandoff, relayPresetIds } = runtime;
  // 交接目标 preset 白名单（v0.2.14）：旧 runtime 只传 presetId 时退化为「只认本 preset」。
  const presetChoices = Array.isArray(relayPresetIds) && relayPresetIds.length > 0 ? relayPresetIds : [presetId];
  return {
    name: TOOL_PREFIX + 'handoff',
    description: 'Bounded handoff (<=8KB, <=200 chars/item, detail via key_docs; no truncation notes to user) + new top-level relay session; Lead-only; human_approved=true. Approval: autoHandoff/authorizeNext only — one-time preset does not grant an approval exemption (see protocol / composer panel). Old session kept as audit archive.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['human_approved'],
      properties: {
        human_approved: { type: 'boolean', description: 'true only after explicit human approval.' },
        status: {
          type: 'object', additionalProperties: false,
          description: 'Status block.',
          properties: {
            phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship'] },
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
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.summary ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_handoff requires a calling agent');
      // 协议禁止队友建顶层会话：subagent/teammate 只能回执 Lead，由 Lead 做接力。
      if (isTeammateSession(ctx, caller)) {
        return fail('lead-only', 'relay_handoff is Lead-only', { summary: 'refused: subagent/teammate sessions must report to the Lead; only the Lead may create the relay session.' });
      }
      if (args?.human_approved !== true) {
        return fail('human-approval-required', 'human approval required', { summary: 'refused: ask the human for an explicit Go/No-go first, then call again with human_approved=true. Suggested checklist: goal still correct? P0 open questions resolved? anything in discarded that the human needs?' });
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
          phase = normalizePhase(status.phase, derivePhase(caller.session, relayStateOf(ctx, caller.session)));
        } catch (error) {
          // P3：非法 status.phase 返回结构化 handoff-invalid（不裸抛）。
          const message = String(error?.message ?? error);
          logWarn(ctx, '[handoff] invalid status: ' + message);
          return fail('handoff-invalid', message, { summary: 'refused: ' + message + ' (phase must be discover|decide|build|verify|ship); no handoff file or session was created.' });
        }
        status.phase = phase;
        // 交接盘点（2026-11-01 用户需求）：旧会话树残留的后台任务/定时任务/队友/子智能体显式交给新会话。
        // 追加在用户 next_actions 之后：buildHandoff 的 next_actions 有 8 条上限，不能让自动清单挤掉未完成工作；
        // 完整清单另由 handoff 文件与工具返回 handover 兜底（v0.2.5 起不再给新会话另发消息）。
        const inventory = await collectHandover(ctx, caller);
        const inventoryLines = handoverInventoryLines(inventory);
        const userNextActions = Array.isArray(status.next_actions) ? status.next_actions : [];
        const nextActions = [...userNextActions, ...inventoryLines];
        // 未完成工作模型漏填时的兜底提示：宿主无法自动采集在手任务，但不能静默交接（有自动清单时也要提示）。
        if (userNextActions.length === 0) {
          nextActions.push('旧会话未提供 next_actions（模型未记录未完成工作）：新会话请从状态/证据/旧会话记录接手，先对齐用户需求再开工。');
        }
        if (nextActions.length > 0) status.next_actions = nextActions;
        const goalText = String(status.goal ?? '').replace(/\s+/g, ' ').trim();
        const lint = runDocLint(cwd);
        const suppliedEvidence = (Array.isArray(args?.evidence) ? args.evidence : []).map((item) => String(item));
        const evidence = suppliedEvidence.some((item) => /doc_lint:/.test(item)) ? suppliedEvidence : [lint.evidence, ...suppliedEvidence];
        let handoff;
        try {
          handoff = buildHandoff({
            status,
            evidence,
            key_docs: args?.key_docs,
            decisions: args?.decisions,
            constraints: args?.constraints,
            open_questions: args?.open_questions,
            risks: args?.risks,
            discarded: args?.discarded,
            sessionId: caller.session.id,
          });
        } catch (error) {
          return fail('handoff-invalid', String(error?.message ?? error), { summary: 'refused: ' + String(error?.message ?? error) });
        }
        // 预检（v0.2.6，用户 2026-11-01「只要把交接文档写好就行」+ 两轮独立审查 P1）：
        // ① 用户内容本身超限 → 在写文件/建会话之前直接拒绝（改短后重试 = 不会重复接力/耗额度）；
        // ② 插件自加的「自动交接清单」若把整篇挤超预算（bytes/丢段/单条裁剪）→ 丢弃清单行、用干净的用户版交接
        //    （完整清单见工具返回 handover；handoff 文件追加段受 8KB 限制，可能被截断/未追加）——绝不静默丢用户章节，也不误报；
        // ③ 只有清单自己抢 next_actions cap 8 的槽位（items:next_actions；用户条目在前全部保留）时照常交接。
        let inventoryDropped = false;
        let inventoryDropReason = '';
        if (handoff.caps.truncated === true) {
          const userOnlyNextActions = userNextActions.length > 0
            ? userNextActions
            : nextActions.filter((line) => !inventoryLines.includes(line));
          let userOnly;
          try {
            userOnly = buildHandoff({
              status: { ...status, next_actions: userOnlyNextActions },
              evidence,
              key_docs: args?.key_docs,
              decisions: args?.decisions,
              constraints: args?.constraints,
              open_questions: args?.open_questions,
              risks: args?.risks,
              discarded: args?.discarded,
              sessionId: caller.session.id,
            });
          } catch { userOnly = handoff; }
          if (userOnly.caps.truncated === true) {
            const hint = handoffTruncationHint(userOnly.caps);
            logWarn(ctx, '[handoff] refused code=handoff-truncated sections=' + JSON.stringify(userOnly.caps.truncatedSections));
            return fail('handoff-truncated', 'handoff content exceeds caps', {
              caps: userOnly.caps,
              hint,
              summary: 'relay_handoff refused (content over caps; no handoff file, no session created; trim items / move detail into files via key_docs and retry): ' + hint,
            });
          }
          const sections = Array.isArray(handoff.caps.truncatedSections) ? handoff.caps.truncatedSections : [];
          const risky = sections.some((section) => section === 'bytes' || section.startsWith('section:') || section.startsWith('chars:'));
          if (risky) {
            handoff = userOnly;
            inventoryDropped = true;
            inventoryDropReason = sections.includes('bytes') || sections.some((section) => section.startsWith('section:'))
              ? '8KB 预算'
              : '单条 200 字符上限';
            logInfo(ctx, '[handoff] auto handover inventory dropped from next_actions to protect user sections (reason=' + inventoryDropReason + '; sections=' + JSON.stringify(sections) + ')');
          } else {
            logInfo(ctx, '[handoff] only auto handover inventory next_actions slots clipped (cap 8); user items kept');
          }
        }
        let handoffPath;
        // 顺序保证（用户 2026-11-01：交接时先写好文档再交接）：先写 handoff 快照文件 → 建新会话
        // → 更新滚动进度文件 progress.md → 最后才把首条消息发给新会话（live.followup）。因此新会话
        // 收到首条消息前文档已写盘；doc_lint 只作证据、不设拒绝硬门（用户裁决 A）。
        try {
          handoffPath = writeWorkspaceFile(cwd, 'handoff-' + Date.now() + '.md', handoff.markdown);
        } catch (error) {
          // P2#9：写盘失败结构化降级；此时尚未建会话，无副作用。
          const reason = String(error?.message ?? error);
          logWarn(ctx, '[handoff] failed code=handoff-write-failed reason=' + reason);
          return fail('handoff-write-failed', 'handoff could not be written: ' + reason, { summary: 'handoff aborted: could not write the handoff file under .scratch/context-relay (' + reason + '); no session was created. Check workspace write permission (cwd: ' + cwd + ').' });
        }
        const agentsService = ctx.get('agents');
        const presets = ctx.get('agentPresets');
        const controller = ctx.get('sessionController');
        const route = inheritOnHandoff ? callerRoute(ctx, caller) : undefined;
        // 下一个会话模式（v0.2.14 面板滑动开关）：面板 handoffPreset ∈ 白名单则用它，否则回退本会话 preset。
        // sticky 语义：成功后不消费/不清（开关可见即可预期）；也不继承到子会话（子会话自己的面板保持默认）。
        const preferredPreset = panelStateOf(caller.session.id).handoffPreset;
        const targetPresetId = presetChoices.includes(preferredPreset) ? preferredPreset : presetId;
        let sessionId;
        let live;
        let createdVia = 'agents.create';
        try {
          if (controller !== undefined && typeof controller.create === 'function') {
            // GUI 同款路径：sessionController.create 负责组装 agent/preset/模型选择，
            // 比裸 agents.create 更稳（实测裸 create + followup 会在首轮触发
            // provider INVALID_REQUEST: all tools deferred）。
            createdVia = 'sessionController.create';
            const created = await controller.create({ cwd, agentPreset: targetPresetId });
            sessionId = created.sessionId;
            // 不继承调用方模型路由：官方 selectModel 会 agentDefaultModel.saveSelection(...)，
            // 静默改写部署默认模型；新会话用部署默认路由（见 audit-core #3）。
            const findLive = () => ctx.get('agents')?.list?.().find((candidate) => candidate.session?.id === sessionId);
            for (let attempt = 0; attempt < 20 && live === undefined; attempt += 1) {
              live = findLive();
              if (live === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (live === undefined) {
              logWarn(ctx, '[handoff] degraded code=session-not-live session=' + sessionId);
              // P2#1：半创建会话 best-effort 清理，避免会话列表污染 + 重试累积。
              disposeHalfCreated(ctx, sessionId);
              return fail('session-not-live', 'new session agent did not become live', { sessionId, handoffPath, halfCreated: true, summary: 'session ' + sessionId + ' was created but its agent did not become live within ~1s; half-created session cleanup attempted (best-effort dispose). Handoff file: ' + handoffPath + '. Retry relay_handoff to create a fresh session.' });
            }
          } else {
            if (agentsService === undefined || typeof agentsService.create !== 'function' || presets === undefined) {
              logWarn(ctx, '[handoff] degraded code=services-unavailable');
              return fail('services-unavailable', 'agents/agentPresets service unavailable', { handoffPath, summary: 'handoff written to ' + handoffPath + ' but could not create a new session (agents/agentPresets services unavailable in this preset); relay manually or fix the preset deployment.' });
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
            live = handle.agent;
          }
        } catch (error) {
          const reason = String(error?.message ?? error);
          logWarn(ctx, '[handoff] failed code=session-create-failed reason=' + reason);
          return fail('session-create-failed', 'session creation failed: ' + reason, { handoffPath, summary: 'handoff written but session creation failed: ' + reason + '. Handoff file: ' + handoffPath + ' (no session was started).' });
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
        // 滚动进度文件（长线记忆，2026-11-01 用户要求 B 方案）：交接时合并/滚动；失败不阻断接力。
        let progress;
        try {
          progress = updateProgress(cwd, {
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
        }
        // 首条消息的接手入口：progress.md（长线状态）+ chain.ndjson（召回索引）+ 指针回读方式。
        // 细节（归档规则/回读实测/召回纪律）在常驻协议，这里只给指针，避免交接时重复占窗口。
        const progressPointer = progress?.updated === true
          ? '长线状态：' + PROGRESS_RELATIVE + '；'
          : '长线状态：progress.md 本次更新失败（见工具返回）；';
        const entryNote = '\n\n## 接手入口\n' + progressPointer + '召回索引：' + CHAIN_RELATIVE
          + '；回读旧会话用 session_event_read({session_id, seq})；细节见常驻协议。';
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
          logWarn(ctx, '[handoff] budget toggle inherit skipped: ' + String(error?.message ?? error));
        }
        try {
          live.followup(userMessage(handoff.markdown + '\n\n## Handoff 文件\n' + handoffPath + entryNote));
        } catch (error) {
          const reason = String(error?.message ?? error);
          logWarn(ctx, '[handoff] degraded code=followup-failed session=' + sessionId + ' reason=' + reason);
          // P2#1：会话已建但首条消息没发出去 = 半创建，best-effort 清理后让调用方重试；
          // 进度文件也要回滚到交接前（否则「持有会话」指向一个没收到手的手术的会话）。
          handoffRoutes().delete(sessionId);
          disposeHalfCreated(ctx, sessionId);
          try { if (progress?.updated === true) restoreProgress(progress); } catch { /* best-effort */ }
          return fail('followup-failed', 'first prompt failed to dispatch: ' + reason, { sessionId, handoffPath, halfCreated: true, summary: 'session ' + sessionId + ' was created but the handoff first prompt failed to dispatch: ' + reason + '; half-created session cleanup attempted (best-effort dispose). Handoff file: ' + handoffPath + '. Retry relay_handoff to create a fresh session.' });
        }
        // 链式召回索引（2026-11-03）：旧会话 id → 新会话 id + handoff 路径；写失败不阻断接力。
        try {
          appendChainEntry(cwd, {
            kind: 'handoff',
            sessionId: caller.session.id,
            childSessionId: sessionId,
            phase,
            goal: goalText,
            handoffPath: workspaceRelativePath(cwd, handoffPath),
          });
        } catch (error) {
          logWarn(ctx, '[handoff] chain index failed: ' + String(error?.message ?? error));
        }
        // 交接清理（2026-11-01）：旧会话树不残留——后台任务取消、定时任务迁移、队友/子智能体中断；
        // 交接清单 + 清理结果只写进 handoff 文件与工具返回，不再给新会话另发消息（2026-11-01 用户要求）。
        const inventoryBlock = inventoryLines.length > 0 ? '## 交接清单（旧会话残留，自动盘点）\n' + inventoryLines.join('\n') + '\n\n' : '';
        // P2-1（2026-11-01 审查）：清理报告 append 后 handoff 文件仍须 ≤8KB；记录最终字节与是否截断。
        const cleanupDelivery = { bytes: 0, truncated: false };
        const appendCleanupReport = (report) => {
          const block = '\n\n' + inventoryBlock + report;
          let payload = block;
          try {
            const currentBytes = existsSync(handoffPath) ? statSync(handoffPath).size : 0;
            const budget = Math.max(0, handoff.caps.bytes.limit - currentBytes);
            if (Buffer.byteLength(payload, 'utf8') > budget) {
              cleanupDelivery.truncated = true;
              const note = '\n…（清理报告/清单因 handoff 8KB 上限已截断；完整结果见本工具返回的 handover 结构化字段与旧会话记录）\n';
              const keep = budget - Buffer.byteLength(note, 'utf8');
              if (keep > 0) {
                let cut = payload;
                while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > keep) cut = cut.slice(0, -1);
                payload = cut + note;
              } else payload = '';
            }
            if (payload !== '') appendFileSync(handoffPath, payload, 'utf8');
            cleanupDelivery.bytes = existsSync(handoffPath) ? statSync(handoffPath).size : 0;
          } catch (error) { logWarn(ctx, '[handoff] cleanup report append failed: ' + reasonOf(error)); }
        };
        let handover;
        // summary 计数必须来自未截断的全量（boundedHandover 截断前），否则 >20 时少报（P3）。
        const handoverTotals = { jobs: inventory.jobs.length, schedules: inventory.schedules.length, teammates: inventory.teammates.length, subagents: inventory.subagents.length, cleanedJobs: null, cleanedSchedules: null, cleanedTeammates: null, cleanedSubagents: null };
        try {
          const cleanup = await performHandoverCleanup(ctx, caller, sessionId);
          if (inventory.errors.length > 0) cleanup.errors = [...new Set([...inventory.errors, ...cleanup.errors])];
          handover = boundedHandover(inventory, cleanup);
          handoverTotals.cleanedJobs = cleanup.jobs.filter((row) => row.action === 'killed' || row.action === 'cancelled-with-owner').length;
          handoverTotals.cleanedSchedules = cleanup.schedules.filter((row) => row.action === 'transferred').length;
          handoverTotals.cleanedTeammates = cleanup.teammates.filter((row) => row.action === 'interrupted').length;
          handoverTotals.cleanedSubagents = cleanup.subagents.filter((row) => row.action === 'interrupted').length;
          appendCleanupReport(renderCleanupReport(cleanup));
          logInfo(ctx, '[handoff] cleanup jobs=' + cleanup.jobs.length + ' schedules=' + cleanup.schedules.length + ' teammates=' + cleanup.teammates.length + ' subagents=' + cleanup.subagents.length + ' errors=' + cleanup.errors.length);
        } catch (error) {
          const reason = reasonOf(error);
          handover = { ...boundedHandover(inventory, null), error: reason, truncated: true };
          logWarn(ctx, '[handoff] cleanup failed: ' + reason);
          // 整体清理抛错也要留痕：清理失败与残留清单写入 handoff 文件与返回体 handover（不再给新会话发消息）。
          appendCleanupReport(renderCleanupReport({ jobs: [], schedules: [], teammates: [], subagents: [], skipped: inventory.skipped, errors: [...inventory.errors, 'cleanup failed: ' + reason] }));
        }
        // 服务未启用（N/A）与截断：summary 显式标注，不假干净/不静默（2026-11-01 审查 P1/P2）。
        const cleanupSkipped = new Set([...(Array.isArray(inventory.skipped) ? inventory.skipped : []), ...(Array.isArray(handover?.cleanup?.skipped) ? handover.cleanup.skipped : [])]);
        const countText = (key, value) => (cleanupSkipped.has(key) ? 'N/A' : String(value));
        const cleanedText = (key, value, verb) => (cleanupSkipped.has(key) ? 'N/A' : value + verb);
        let handoffId;
        try {
          handoffId = recordHandoff({
            sessionId,
            parentSessionId: caller.session.id,
            title,
            phase,
            goal: goalText.slice(0, 120),
            summary: evidence[0] ?? ('phase ' + phase + ' handoff'),
          });
        } catch { /* 发布箱失败不影响接力本身（M3 提示降级为手动打开） */ }
        // 接力成功后消费一次性状态：handoff / compress-then-handoff 预设（B-P2-3：只在这条
        // 成功路径消费，relay_phase 拒绝时不再清）、模型自决 autoDecision、「授权下一次操作」
        // authorizeNext（autoHandoff 是持久开关，不消费）；handedOff：本会话已归档，后续 pre-step
        // 不再注入到线提醒/重申（旧会话静音语义保留）。
        try {
          const panelNow = panelStateOf(caller.session.id);
          const consumed = panelNow.defaultOperation === 'handoff' || panelNow.defaultOperation === 'compress-then-handoff' ? { defaultOperation: null } : {};
          // v0.3.3：接力成功 = 本次到线的模型推荐已消费（旧会话归档，推荐不再有意义）。
          updatePanelState(caller.session.id, {
            handedOff: true,
            autoDecision: null,
            authorizeNext: false,
            ...consumed,
            recommendedOperation: null,
            recommendedReason: '',
            recommendedAt: null,
          }, { source: 'agent' });
        } catch { /* 忽略 */ }
        // §3.8（2026-10-28 人类追加需求）：接力成功后把旧会话**消费后**的 4 个持久授权开关
        // 同步到新会话（新会话 composer chip 读到同样设置）；一次性预设 defaultOperation、
        // 模型自决 autoDecision、内部字段 handedOff、交接目标 handoffPreset 不继承（v0.2.14：新的子会话保持默认开关）；
        // agent 来源写入：只落显式字段，不把侧栏默认值固化成新会话快照（B-P2-8）；
        // 同步失败只丢继承，不阻断接力。
        try {
          const inheritedPanel = panelStateOf(caller.session.id);
          updatePanelState(sessionId, {
            autoChoose: inheritedPanel.autoChoose,
            autoCompress: inheritedPanel.autoCompress,
            autoHandoff: inheritedPanel.autoHandoff,
            authorizeNext: inheritedPanel.authorizeNext,
          }, { source: 'agent' });
        } catch { /* 忽略 */ }
        logInfo(ctx, '[handoff] ok session=' + sessionId + ' via=' + createdVia + ' preset=' + targetPresetId + ' title=' + title + (alreadyHandedOff ? ' duplicate=true' : '') + (attachError === undefined ? '' : ' workspace=attach-failed'));
        return lossless({
          ok: true,
          sessionId,
          title,
          phase,
          handoffPath,
          handoffId,
          caps: handoff.caps,
          progress: progress.updated === true
            ? { updated: true, path: PROGRESS_RELATIVE, bytes: progress.bytes, archived: progress.archived }
            : { updated: false, error: progress.error },

          workspace: attach,
          createdVia,
          ...(inherited === undefined ? {} : { inherited }),
          ...(attachError === undefined ? {} : { info: { code: 'relay-attach-failed', message: 'workspace attach failed: ' + attachError } }),
          ...(handover === undefined ? {} : { handover }),
          ...(inventoryDropped ? { inventoryDropped: true, inventoryDropReason } : {}),
          ...(handover === undefined ? {} : { handoffFileBytes: cleanupDelivery.bytes, cleanupReportTruncated: cleanupDelivery.truncated }),
          docLint: { level: lint.level, summary: lint.summary },
          summary: 'relay session created via ' + createdVia + ': ' + sessionId + ' (' + title + '); handoff: ' + handoffPath + ' (' + handoff.caps.bytes.used + '/' + handoff.caps.bytes.limit + ' B' + (handoff.caps.truncated ? ', 自动交接清单未全部放进 next_actions（cap 8），完整清单见本工具返回的 handover 字段' : '') + (inventoryDropped ? '; 自动交接清单未放进 next_actions（保护用户章节：' + inventoryDropReason + '），完整清单见本工具返回的 handover 字段' : '') + ')' + (attachError === undefined ? '' : '; workspace attach failed: ' + attachError + ' — session is usable without the workspace binding; attach cwd manually from the session list') + (handover === undefined ? '' : '; 交接清理：后台任务 ' + countText('jobs', handoverTotals.jobs) + '→' + (handover.cleanup === null ? '未清理' : cleanedText('jobs', handoverTotals.cleanedJobs, ' 已取消')) + ' / 定时任务 ' + countText('schedule', handoverTotals.schedules) + '→' + (handover.cleanup === null ? '未迁移' : cleanedText('schedule', handoverTotals.cleanedSchedules, ' 已迁移')) + ' / 队友 ' + countText('agentTeams', handoverTotals.teammates) + '→' + (handover.cleanup === null ? '未清理' : cleanedText('agentTeams', handoverTotals.cleanedTeammates, ' 已中断')) + ' / 子智能体 ' + countText('subagents', handoverTotals.subagents) + '→' + (handover.cleanup === null ? '未清理' : cleanedText('subagents', handoverTotals.cleanedSubagents, ' 已中断')) + (handover.cleanup === null ? '；清理失败：' + handover.error : (handover.cleanup.errors.length > 0 ? '；清理告警 ' + handover.cleanup.errors.length + ' 条' : '')) + (handover.truncated === true ? '；结构化清理清单已截断（>20 条，完整结果见 handover 字段与 handoff 文件）' : '') + (cleanupDelivery.truncated === true ? '；handoff 文件清理报告因 8KB 上限截断（完整结果见 handover 字段）' : '')) + '; open it from the session list to continue. Old session is kept as audit archive.' + (progress?.updated === true ? '; 滚动进度：' + PROGRESS_RELATIVE : '')
            + (alreadyHandedOff ? ' **警告：该会话 handedOff=true 已完成过接力，这是重复接力（会再建会话/耗额度）；旧会话静音语义保留，若不是有意重复请直接继续旧会话。**' : ''),
        });
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
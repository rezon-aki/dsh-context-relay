/**
 * dsh-context-relay — 队友保鲜工具（P0/P1）：relay_checkpoint / relay_freshen /
 * relay_team_status / relay_renew / relay_architect。
 *
 * 工具按 agent 角色注册（agent scope，不污染其他 agent）：
 * - 队友：relay_checkpoint（写自己的工作记录）/ relay_freshen（同任务减压 or 真清空 reset）
 * - Lead：relay_team_status（体检）/ relay_renew（归档换代）/ relay_architect（固定架构师）
 * 执行层再次校验身份（Lead-only / 队友-only），与注册面互为纵深。
 *
 * 架构师默认取模型选择器默认选择（已选 sticky），composer 可覆盖，未选不拒绝。
 * 所有 team 记录 IO 都带本 Team 的 leadSessionId 分区（membership.root.session.id）；
 * reset 的真清空由 createTeamTools 注册的 agent/pre-step 执行器消费（同实例一次，失败回退压缩）。
 *
 * @module dsh-context-relay/agent/team-tools
 */
import { bandFor, buildPhaseBrief, normalizePhase } from '../policy.js';
import { ARCHITECT_NAME } from './protocol.js';
import { clearTeamContextRow, replaceTeamContext } from './team-context.js';
import { derivePhase, derivePhaseMeta, pressureOf, relayStateOf, stateOf } from './derive.js';
import { TOOL_PREFIX, appendWorkspaceFile, claimRelayOperation, clearPendingArchitect, clearPendingBudgetInherit, cwdOf, effectiveUnlimitedBudgetOf, fail, logInfo, logWarn, lossless, markPendingArchitect, markPendingBudgetInherit, noticeMessage, runDocLint } from './shared.js';
import { formatWorkItemLines, normalizeWorkItemsConfig, readWorkItems, workItemsScopeOf } from './work-items.js';
import { LAST_BAND, forgetDispatchRows, teammateState } from './sentinel.js';
import { providerModelOf } from './handoff.js';
import { panelStateOf, updatePanelState } from '../panel-store.js';
import { modelSelectionDefaultOf } from '../model-default.js';
import { appendChainEntry, workspaceRelativePath } from './chain.js';
import { buildManualRecallSection } from './recall.js';
import { renderInternalResult } from '../output.js';
import { disposeActivation, rememberActivation, takeActivation } from './activations.js';
import { capabilitiesOf, interruptMember, listMembers, roleOf, sendToMember, startMember } from '../team-api.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeResetRange, hasPendingReset, performWipe, scheduleReset, takePendingReset } from './reset.js';
import {
  SQUAD_MAX_CEILING,
  SQUAD_MAX_DEFAULT,
  TEAM_LIMITS,
  TEAM_PROVIDER,
  adoptMembers,
  appendLedger,
  archiveRetired,
  archiveCheckpoint,
  buildCheckpointMarkdown,
  buildRenewPrompt,
  checkpointPathOf,
  classifyHealth,
  clipText,
  ensureLineage,
  genOf,
  isValidTeammateName,
  legacyMembersOf,
  lineageDirOf,
  lineageOf,
  nextGenName,
  partitionRelativePath,
  readCheckpoint,
  readLedger,
  readProfile,
  readRoster,
  retiredNamesOf,
  retireGeneration,
  retiredRecordsOf,
  squadMembersOf,
  squadSummaryOf,
  usedNamesOf,
  writeCheckpoint,
  writeRoster,
} from './team.js';

const TEAM_STATUS_TEXT_MAX = 2000;
/**
 * v0.6.0：relay_team_status 去轮询——同一 Lead 会话重复读到**完全相同**的团队状态时拒绝：
 * 信息没变，轮询没有意义（队友回执会自动送达；phase 边界会带 triage）。状态真的变了才返回全量。
 */
const TEAM_STATUS_MEMORY = new Map();
const TEAM_STATUS_MEMORY_MAX = 200;

function teamStatusSignature(rows, retired = [], deeper = 0, summary = {}) {
  // v0.6.1 新字段进签名：phase/条目计数变化也算状态变化，否则 phase 切换后合法查询会被误拒。
  // v0.7.0：退役代变化也算状态变化（否则“旧代消失”后合法查询被误拒）。
  // v0.10 C8/C16：deeper（孙代理数量）与 reset 结果也进签名——否则孙代理/reset 变化被判「未变」误拒。
  // v0.11 P0-B：squad/legacy/retired 计数 + include_* 视图进签名（计数变化 = 状态变化）。
  return JSON.stringify([
    rows.map((row) => [
      row.name, row.gen, row.rosterKnown === true, row.status, row.band, row.health, row.checkpoint?.exists === true,
      row.phase ?? null, row.items?.doing ?? 0, row.items?.blocked ?? 0,
      row.reset === undefined ? null : row.reset.event + '@' + (row.reset.at ?? ''),
    ]),
    retired,
    Number.isInteger(deeper) && deeper > 0 ? deeper : 0,
    summary.legacy ?? 0,
    summary.retired ?? 0,
    summary.squadMax ?? 0,
    summary.includeLegacy === true,
    summary.includeRetired === true,
  ]);
}
/** 默认列表渲染上限（include_* 时名字列表有界；余量只给计数）。 */
const STATUS_LIST_LIMIT = 20;

/**
 * reset 结果（C8/M-05）：从本 lineage ledger 找最近一次真清空/回退/失败事件，供 team_status 汇总。
 * 成功=event:'reset'；回退=event:'freshen' 且 reset:true；失败=event:'reset-failed'。
 */
function resetStateOf(cwd, lineage, leadSessionId) {
  let entries;
  try { entries = readLedger(cwd, lineage, TEAM_LIMITS.ledgerEntries, leadSessionId); } catch { return undefined; }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.event === 'reset') return { event: 'reset', at: typeof entry.at === 'string' ? entry.at : undefined };
    if (entry?.event === 'freshen' && entry?.reset === true) return { event: 'fallback', at: typeof entry.at === 'string' ? entry.at : undefined };
    if (entry?.event === 'reset-failed') return { event: 'failed', at: typeof entry.at === 'string' ? entry.at : undefined, reason: clipText(entry.reason ?? '', 120) };
  }
  return undefined;
}

/** reset 结果注入队友模型（成功/失败都注入一条结果 notice；inject 缺失/抛错不阻断 pre-step）。 */
function injectResetNotice(agent, text, summary) {
  if (agent === null || typeof agent !== 'object' || typeof agent.inject !== 'function') return false;
  try { agent.inject(noticeMessage(text, summary)); return true; } catch { return false; }
}

/** 清理去轮询内存（插件卸载/测试）。 */
export function clearTeamStatusMemory() {
  TEAM_STATUS_MEMORY.clear();
}
/** 同代 freshen（官方压缩）上限：压缩有损，但 freshen 优先于换代（不占成员额度）。reset 真清空不计入。 */
const FRESHEN_LIMIT = 2;

function membershipOf(ctx, caller) {
  return roleOf(ctx, caller);
}

/** 本 Team 的记录分区 id = Lead 会话 id（队友的 membership.root 是 Lead；Lead 的 root 是自己）。 */
function leadSessionIdOf(membership) {
  const root = membership?.root;
  const id = root?.session?.id ?? root?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function signalOf(exec) {
  return exec?.signal ?? new AbortController().signal;
}

function teammatesOf(listed) {
  return Array.isArray(listed?.members) ? listed.members.filter((member) => member?.role === 'teammate') : [];
}

/** 文档文件名安全化：只留字母数字/点/下划线/短横，限 60；空值用时间戳。 */
function safeTaskId(value) {
  const text = String(value ?? '').trim();
  if (text === '') return 'task-' + Date.now();
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || ('task-' + Date.now());
}

function checkpointRequestText(name) {
  return '请先调用 relay_checkpoint 写本轮结构化交接（一行结论/完成/决策/证据/约束/未决/下一步；4KB 为 advisory，完整落盘），'
    + '然后回一句「checkpoint 已写」。Lead 会在收到后为你换代（新队友读你的记录接手），不要自行压缩/交接。'
    + '（队友：' + String(name ?? '?') + '）';
}

/** v0.13 B1：Lead 维护请求的标准句式（只发消息，不擦除、不 spawn、不改 roster——执行权仍在队友自己手里）。 */
function maintainRequestText(brief, reset) {
  const call = 'relay_freshen({' + (reset ? 'reset:true, ' : '') + 'brief:' + JSON.stringify(brief) + '})';
  return '[context-relay] Lead 维护请求（标准顺序：relay_checkpoint → ' + call + '）：先调用 relay_checkpoint 写本轮结构化交接'
    + '（一行结论/完成/决策/证据/约束/未决/下一步；4KB 为 advisory，完整落盘），再调用上面的 relay_freshen '
    + (reset ? '真清空（旧任务上下文可丢）' : '做同任务减压（同代≤2 次）')
    + '，然后按 brief 接手新任务（同成员复用、0 额度、不占 spawn）。不要手工 subagent，不要向用户提问。';
}

function relativeHandoff(lineage, gen, leadSessionId) {
  return partitionRelativePath(leadSessionId, lineage, 'handoffs', 'gen-' + gen + '.md');
}

const HEALTH_ACTION = Object.freeze({
  fresh: '可派',
  watch: '做完后发消息让该队友自己 relay_checkpoint（到边界再处理）',
  stale: '发消息让该队友自己 relay_freshen({reset:true, brief}) 真清空复用（0 额度）；换身份/角色且 allowSpawn 才 renew',
  spent: '先发消息让该队友自己 relay_checkpoint，再自己 relay_freshen({reset:true, brief}) 复用（0 额度）；换身份/角色且 allowSpawn 才 renew',
  unknown: '读不到',
});

function renderTeamStatus(report, recordsRelative) {
  const summary = report.teamSummary ?? {};
  const lines = ['小队 ' + report.team.length + '/' + (summary.squadMax ?? SQUAD_MAX_DEFAULT)
    + (summary.overCap === true ? '（超上限：先 retire 或调大 config squadMax）' : '')
    + ' · legacy ' + String(summary.legacy ?? 0) + '（隐藏） · 退役 ' + String(summary.retired ?? 0) + '（隐藏）'
    + ' · running=' + report.active + ' · records=' + recordsRelative
    + ' · 并发额度=部署配置 maxActiveSubagents（默认 8/root；spawn 默认关，换人 reset 复用不占额）'];
  for (const row of report.team) {
    const checkpoint = row.checkpoint.exists ? 'ck:' + row.checkpoint.bytes + 'B' : 'ck:missing';
    lines.push('- ' + row.name + ' · ' + row.status + ' · ' + (row.ratio === undefined ? '?' : Math.round(row.ratio * 1000) / 10 + '%')
      + ' ' + row.band + ' · ' + checkpoint + ' · ' + row.health + ' → ' + (HEALTH_ACTION[row.health] ?? row.action));
  }
  if (report.team.length === 0) {
    lines.push('小队为空：用 relay_team_status({manage:{action:\'adopt\',names:[...],reason}}) 纳入有用历史成员；或把 config allowSpawn 设为 true 后 relay_dispatch 新建；phase 边界也可 relay_handoff 重建。');
  }
  if (Array.isArray(report.legacyNames) && report.legacyNames.length > 0) {
    const shown = report.legacyNames.slice(0, STATUS_LIST_LIMIT);
    lines.push('legacy（只审计，不派活）：' + shown.join(', ') + (report.legacyNames.length > STATUS_LIST_LIMIT ? ' 等 ' + report.legacyNames.length + ' 个' : '')
      + '。要用请 manage:{action:\'adopt\',names:[...]}；要清理请 manage:{action:\'retire\',scope:\'legacy\',keep:[...]}。');
  }
  if (Array.isArray(report.retiredRecords) && report.retiredRecords.length > 0) {
    const shown = report.retiredRecords.slice(0, STATUS_LIST_LIMIT);
    lines.push('退役记录：' + shown.map((row) => row.name + (row.from === 'archive' ? '(归档)' : '') + (row.reason === undefined ? '' : '（' + clipText(row.reason, 40) + '）')).join(', ')
      + (report.retiredRecords.length > STATUS_LIST_LIMIT ? ' 等 ' + report.retiredRecords.length + ' 条' : '') + '（只审计，不派活）');
  }
  let text = lines.join('\n');
  if (text.length > TEAM_STATUS_TEXT_MAX) text = text.slice(0, TEAM_STATUS_TEXT_MAX - 1) + '…';
  return text;
}

/** reset 后模型唯一可见的 brief：旧任务归档指针 + 用户新任务 + 只按 brief 执行的硬约束。 */
function buildResetBrief({ phase, sessionId, leadSessionId, lineage, checkpointRelative, userBrief, hasCheckpoint }) {
  const checkpoint = checkpointRelative ?? partitionRelativePath(leadSessionId, lineage, 'checkpoint.md');
  return [
    '[context-relay] 上下文真清空(reset)·' + phase,
    '旧任务已归档：会话 ' + sessionId + '（重置前事件可用 session_event_read 读 shadowed）；工作记录 ' + checkpoint
      + (hasCheckpoint ? '' : '（未写：旧任务细节可能丢失，先 relay_checkpoint）'),
    String(userBrief ?? '').trim() || '（未给 brief：按 Lead 新任务单执行）',
    '你 reset 后只看到本条 brief：按新任务执行；结束后回一条 ≤100 字消息给 Lead 报告 reset 完成；不引用旧任务。',
  ].join('\n');
}

/**
 * v0.7.1：本会话允许的子代理模型路由（官方 `subagentModelSelectionPolicy` 会话投影）。
 * 只校验显式覆盖；默认动态路由不上白名单（等价官方父路由继承）。
 * 没有投影记录 → 按官方语义只允许父会话当前路由；投影/父路由都读不到 → fail closed。
 */
function architectModelPolicy(ctx, caller) {
  let policy;
  let selection;
  try {
    const projections = ctx?.get?.('sessionProjections');
    policy = projections?.stateOf?.(caller.session, 'subagentModelSelectionPolicy');
    selection = projections?.stateOf?.(caller.session, 'modelSelection');
  } catch (error) {
    return { ok: false, reason: 'model-selection projection unavailable: ' + String(error?.message ?? error) };
  }
  const routes = Array.isArray(policy)
    ? policy.filter((route) => route !== null && typeof route === 'object' && typeof route.provider === 'string' && typeof route.model === 'string')
    : [];
  if (routes.length > 0) return { ok: true, routes, source: 'session' };
  const parent = selection !== null && selection !== undefined ? (selection.pending ?? selection.lastUsed) : undefined;
  let route = parent !== null && parent !== undefined && typeof parent.provider === 'string' && typeof parent.model === 'string'
    ? { provider: parent.provider, model: parent.model }
    : undefined;
  if (route === undefined) {
    try {
      const fallback = providerModelOf(caller);
      if (fallback !== null && fallback !== undefined && typeof fallback.provider === 'string' && typeof fallback.model === 'string') {
        route = { provider: fallback.provider, model: fallback.model };
      }
    } catch { route = undefined; }
  }
  if (route === undefined) return { ok: false, reason: 'no subagent model allowlist recorded and no parent route available' };
  return { ok: true, routes: [route], source: 'parent' };
}

/** 构建三件套（按角色分组；runtime = { ctx, currentThresholds, provider? }）。 */
export function createTeamTools(runtime) {
  const { ctx, currentThresholds } = runtime;
  // 工作台账配置（v0.5.0）：host 装配传入归一化配置；缺省按默认（enabled=true）——老装配/单测兼容。
  const workItems = runtime.workItems ?? normalizeWorkItemsConfig({});
  const provider = typeof runtime.provider === 'string' && runtime.provider !== '' ? runtime.provider : TEAM_PROVIDER;
  // v0.11 P0-B 小队模型：spawn 默认关（allowSpawn）；squadMax 默认 8（含架构师，config 可上调）。
  const allowSpawn = runtime.allowSpawn === true;
  const squadMax = Number.isInteger(runtime.squadMax) && runtime.squadMax > 0
    ? Math.min(SQUAD_MAX_CEILING, runtime.squadMax)
    : SQUAD_MAX_DEFAULT;

  /**
   * 官方压缩 + brief 注入 + chain/ledger 记账（freshen 与 reset 失败回退共用）。
   * 只把 compactIfNeeded 的异常抛给调用方；chain/ledger/注入失败仅 warn。
   */
  async function compactWithBrief({ caller, cwd, lineage, leadSessionId, name, gen, phase, brief, briefPath, engine, signal, reset = false, fallbackReason }) {
    const route = providerModelOf(caller);
    const result = await engine.compactIfNeeded({ session: caller.session, options: { provider: route.provider, model: route.model } }, 'context-overflow', signal);
    const organized = result !== null && result !== undefined;
    const shadowedSeqs = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.filter((seq) => Number.isInteger(seq)) : [];
    const compactionInfo = organized ? {
      compactionId: result?.compactionId === undefined ? undefined : String(result.compactionId),
      shadowedStart: shadowedSeqs.length > 0 ? Math.min(...shadowedSeqs) : undefined,
      shadowedEnd: shadowedSeqs.length > 0 ? Math.max(...shadowedSeqs) : undefined,
      freedTokens: result?.shadowedTokenCount,
    } : undefined;
    let chainInfo;
    let recallSection = '';
    let manualRecall = '';
    if (organized) {
      try {
        chainInfo = await appendChainEntry(cwd, {
          kind: 'teammate-freshen', sessionId: caller.session.id, phase,
          note: 'lineage=' + lineage + ' name=' + name + ' gen=' + gen + (reset ? ' reset=true' : '')
            + (fallbackReason === undefined ? '' : ' fallback=' + clipText(fallbackReason, 60)),
          compactionId: compactionInfo.compactionId, shadowedStart: compactionInfo.shadowedStart, shadowedEnd: compactionInfo.shadowedEnd,
          freedTokens: compactionInfo.freedTokens, briefPath: workspaceRelativePath(cwd, briefPath),
        });
        recallSection = '[context-relay] 链式召回：本会话 ' + caller.session.id + ' 压缩遮蔽 seq '
          + (compactionInfo.shadowedStart === undefined ? '未报告' : compactionInfo.shadowedStart + '–' + compactionInfo.shadowedEnd)
          + '；索引 .scratch/context-relay/chain.ndjson；旧内容按 session_event_read({session_id, seq}) 回读。';
        await appendWorkspaceFile(cwd, briefPath, '\n' + recallSection + '\n');
      } catch (error) { logWarn(ctx, '[freshen] chain index failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error)); }
      try {
        await appendLedger(cwd, lineage, {
          event: 'freshen', gen, name, sessionId: caller.session.id, phase,
          ...(reset ? { reset: true } : {}),
          ...(fallbackReason === undefined ? {} : { fallback: clipText(fallbackReason, 160) }),
          freedTokens: compactionInfo.freedTokens, shadowedStart: compactionInfo.shadowedStart, shadowedEnd: compactionInfo.shadowedEnd,
          brief: workspaceRelativePath(cwd, briefPath), at: new Date().toISOString(),
        }, leadSessionId);
      } catch (error) { logWarn(ctx, '[freshen] ledger append failed: ' + String(error?.message ?? error)); }
      // A+B（2026-11-08 实测缺口）：官方不恢复被遮蔽的附加 AGENTS.md / 已调用过的 skill——压缩后注入手动召回指针。
      try {
        manualRecall = buildManualRecallSection({ session: caller.session, shadowedEnd: compactionInfo.shadowedEnd });
        if (manualRecall !== '') await appendWorkspaceFile(cwd, briefPath, '\n' + manualRecall + '\n');
      } catch (error) { logWarn(ctx, '[freshen] manual recall failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error)); }
    }
    let briefInjected = false;
    if (organized && typeof caller.inject === 'function') {
      try {
        const label = reset ? 'reset 回退（压缩+brief）' : 'freshen';
        const header = '[context-relay] 队友 ' + label + ' · ' + phase + '（压缩后注入，非用户发言）\n'
          + '接手：先按「关键文件索引」读入口文件（完整 brief 见 ' + briefPath + '），再继续当前任务。\n'
          + '以下关键结论在压缩后继续以此为准：\n';
        const recallTail = [recallSection, manualRecall]
          .filter((section) => section !== '')
          .map((section) => '\n\n' + section)
          .join('');
        const truncation = '\n\n[brief truncated: 完整内容见 ' + briefPath + ']';
        const maxChars = 4000;
        const base = header + brief;
        const text = base.length + recallTail.length <= maxChars ? base + recallTail : base.slice(0, Math.max(0, maxChars - recallTail.length - truncation.length)) + truncation + recallTail;
        caller.inject(noticeMessage(text, '[context-relay] 队友 ' + label + ' · ' + phase + ' · 压缩后注入（非用户发言）'));
        briefInjected = true;
      } catch (error) { logWarn(ctx, '[freshen] inject failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error)); }
    }
    return { organized, compactionInfo, chainInfo, recallSection, briefInjected, manualRecallInjected: briefInjected && manualRecall !== '', freedTokens: result?.shadowedTokenCount };
  }

  /**
   * reset 执行器：pre-step 时消费 pending，performWipe 真清空；
   * 失败回退官方压缩 + brief 注入（绝不 throw——pre-step 异常会打断 agent loop）。
   * next() 只在监听器末尾调用一次，避免异常路径重复推进步骤。
   */
  function installResetApplier() {
    const consume = async (payload) => {
      const agent = payload?.agent;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId === '' || !hasPendingReset(sessionId)) return;
      const pending = takePendingReset(sessionId);
      if (pending === undefined) return;
      const cwd = cwdOf(agent.session);
      let wipe;
      try {
        const range = computeResetRange(agent.session);
        const resetLine = range.ok === true
          ? '\n\n[reset] 已遮蔽 surface seq ' + range.startSeq + '–' + range.endSeq + '（' + range.shadowedSeqs.length + ' 节点）；旧事件可用 session_event_read({session_id: ' + sessionId + ', seq}) 召回；chain 索引 .scratch/context-relay/chain.ndjson。'
          : '';
        try { await appendWorkspaceFile(cwd, pending.briefPath, resetLine); } catch { /* brief 文件补写失败不阻断 wipe */ }
        wipe = performWipe(ctx, agent.session, pending.brief + resetLine, { reason: 'relay-reset' });
      } catch (error) {
        wipe = { ok: false, code: 'wipe-append-failed', reason: String(error?.message ?? error) };
      }
      if (wipe?.ok === true) {
        const freedTokens = Number.isFinite(wipe.beforeTokens) && Number.isFinite(wipe.afterTokens)
          ? Math.max(0, wipe.beforeTokens - wipe.afterTokens) : undefined;
        try {
          await appendLedger(cwd, pending.lineage, {
            event: 'reset', gen: pending.gen, name: pending.name, sessionId, phase: pending.phase,
            shadowedStart: wipe.startSeq, shadowedEnd: wipe.endSeq, shadowedNodes: wipe.shadowedNodes, freedTokens,
            brief: workspaceRelativePath(cwd, pending.briefPath), checkpoint: workspaceRelativePath(cwd, pending.checkpointPath),
            at: new Date().toISOString(),
          }, pending.leadSessionId);
        } catch (error) { logWarn(ctx, '[reset] ledger append failed: ' + String(error?.message ?? error)); }
        try {
          await appendChainEntry(cwd, {
            kind: 'teammate-reset', sessionId, phase: pending.phase,
            note: 'lineage=' + pending.lineage + ' gen=' + pending.gen + ' reset=true',
            shadowedStart: wipe.startSeq, shadowedEnd: wipe.endSeq, freedTokens,
            briefPath: workspaceRelativePath(cwd, pending.briefPath),
          });
        } catch (error) { logWarn(ctx, '[reset] chain index failed: ' + String(error?.message ?? error)); }
        LAST_BAND.set(sessionId, { band: 'ok' });
        logInfo(ctx, '[reset] wiped session=' + sessionId + ' lineage=' + pending.lineage + ' shadowed=' + wipe.shadowedNodes + ' freed=' + String(freedTokens ?? '?'));
        // M-05/C3：成功也要给队友模型一条结果 notice（它现在只看到 brief——必须知道旧上下文已真清空）。
        injectResetNotice(agent,
          '[context-relay] reset 结果：真清空成功（surface seq ' + wipe.startSeq + '–' + wipe.endSeq + '，遮蔽 ' + wipe.shadowedNodes + ' 节点）。旧上下文已不可见，按 brief 执行；需要旧事件用 session_event_read({session_id: ' + sessionId + ', seq}) 召回（chain 索引 .scratch/context-relay/chain.ndjson）。',
          '[context-relay] reset 完成（真清空）');
        return;
      }
      const reason = String(wipe?.reason ?? wipe?.code ?? 'unknown');
      logWarn(ctx, '[reset] wipe failed session=' + sessionId + ' code=' + String(wipe?.code ?? '?') + ' reason=' + reason + '; falling back to compaction+brief');
      // M-05/C3：失败路径同样注入结果 notice——不经 notice 队友会以为已清空而继续用旧上下文。
      let fallback = null;
      let fallbackError;
      try {
        const engine = ctx.get('compaction');
        if (engine === undefined || typeof engine.compactIfNeeded !== 'function') {
          logWarn(ctx, '[reset] compaction unavailable; fallback brief not injected');
        } else {
          fallback = await compactWithBrief({
            caller: agent, cwd, lineage: pending.lineage, leadSessionId: pending.leadSessionId,
            name: pending.name, gen: pending.gen, phase: pending.phase,
            brief: pending.brief, briefPath: pending.briefPath, engine, signal: payload?.signal,
            reset: true, fallbackReason: reason,
          });
        }
      } catch (error) {
        fallbackError = String(error?.message ?? error);
        logWarn(ctx, '[reset] fallback failed session=' + sessionId + ' reason=' + fallbackError);
      }
      if (fallback?.organized === true) {
        LAST_BAND.set(sessionId, { band: 'ok' });
        logInfo(ctx, '[reset] fallback compaction+brief session=' + sessionId + ' organized=true');
        injectResetNotice(agent,
          '[context-relay] reset 结果：真清空未生效（' + clipText(reason, 120) + '），已回退官方压缩+brief 注入（有损：旧任务细节可能部分保留）。按 brief 执行，不要把上下文当作全新。',
          '[context-relay] reset 回退（压缩+brief）');
        return;
      }
      const failedDetail = fallbackError !== undefined
        ? 'fallback error: ' + fallbackError
        : (fallback === null ? 'compaction unavailable' : 'compaction made no progress');
      try {
        await appendLedger(cwd, pending.lineage, {
          event: 'reset-failed', gen: pending.gen, name: pending.name, sessionId, phase: pending.phase,
          reason: clipText(reason + '；' + failedDetail, 160), at: new Date().toISOString(),
        }, pending.leadSessionId);
      } catch (error) { logWarn(ctx, '[reset] failed-ledger append failed: ' + String(error?.message ?? error)); }
      let briefRelative = pending.briefPath;
      try { briefRelative = workspaceRelativePath(cwd, pending.briefPath); } catch { /* 展示路径失败仍用绝对路径 */ }
      injectResetNotice(agent,
        '[context-relay] reset 结果：真清空失败（' + clipText(reason, 120) + '；' + clipText(failedDetail, 120) + '）。旧上下文仍在；brief 已落盘 ' + briefRelative + '（可能未注入）。请继续当前任务或向 Lead 报告 reset 失败。',
        '[context-relay] reset 失败（旧上下文仍在）');
      logInfo(ctx, '[reset] reset-failed recorded session=' + sessionId + ' detail=' + failedDetail);
    };
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      const proceed = typeof next === 'function' ? next : async () => {};
      try { await consume(payload); } catch (error) { logWarn(ctx, '[reset] pre-step applier failed: ' + String(error?.message ?? error)); }
      return proceed();
    }), 'dsh-context-relay: pending reset applier');
  }
  installResetApplier();

  /** 队友：写自己的工作记录（结构化交接；4KB 仅 advisory，完整落盘）。 */
  const checkpoint = {
    name: TOOL_PREFIX + 'checkpoint',
    description: 'Write this teammate\'s durable work record (structured handoff; 4KB is advisory and never truncates) to .scratch/context-relay/team/<leadSessionId>/<lineage>/checkpoint.md + ledger. '
      + 'Call when a task completes, before switching task/phase, or when the Lead asks: without it a successor generation cannot inherit your context. Teammate-only.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['one_line'],
      properties: {
        one_line: { type: 'string', description: 'One-line conclusion (<=300 chars).' },
        kind: { type: 'string', description: 'task | phase | handoff (default task).' },
        task_id: { type: 'string', description: 'Optional task-board id this checkpoint closes.' },
        done: { type: 'array', items: { type: 'string' }, description: 'Done (<=8 items, <=200 chars each).' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions with reasons (<=8).' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence pointers file:line / report path (<=8).' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints / must-not-do (<=8).' },
        next_actions: { type: 'array', items: { type: 'string' }, description: 'Next actions for the successor (<=8).' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'Open questions (<=8).' },
        failed_attempts: { type: 'array', items: { type: 'string' }, description: 'Failed attempts / do-not-retry (<=8).' },
        pointers: { type: 'array', items: { type: 'string' }, description: 'Old session ids / paths for chain recall (<=8).' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: renderInternalResult(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_checkpoint requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined) return fail('teammate-only', 'relay_checkpoint is for Agent Teams teammates', { summary: 'refused: only a Team teammate may write a teammate checkpoint. Report to the Lead instead.' });
      if (membership.role !== 'teammate') return fail('teammate-only', 'relay_checkpoint is teammate-only', { summary: 'refused: Lead does not write teammate checkpoints; teammates own their records.' });
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      const lineage = lineageOf(membership.name);
      const genBase = genOf(membership.name);
      const roster = readRoster(cwd, leadSessionId);
      let gen = genBase;
      const entry = ensureLineage(roster, lineage, { name: membership.name, sessionId: caller.session?.id, role: '', description: '' });
      const current = entry?.generations?.find((item) => item.name === membership.name);
      if (current !== undefined && Number.isInteger(current.gen)) gen = current.gen;
      const built = buildCheckpointMarkdown({ lineage, name: membership.name, gen, input: args ?? {} });
      if (built.ok !== true) return fail(built.code, built.error, { summary: 'checkpoint rejected: ' + built.error });
      let written;
      try {
        written = await writeCheckpoint(cwd, lineage, built.markdown, leadSessionId);
      } catch (error) {
        return fail('checkpoint-write-failed', String(error?.message ?? error), { summary: 'checkpoint write failed; work can continue but the Lead must not renew without a record.' });
      }
      try { await appendLedger(cwd, lineage, { event: 'checkpoint', gen, name: membership.name, sessionId: caller.session?.id, kind: args?.kind ?? 'task', taskId: args?.task_id, oneLine: clipText(args?.one_line, 200), bytes: written.bytes, at: new Date().toISOString() }, leadSessionId); } catch (error) { logWarn(ctx, '[team] ledger append failed: ' + String(error?.message ?? error)); }
      try { await writeRoster(cwd, roster, leadSessionId); } catch (error) { logWarn(ctx, '[team] roster write failed: ' + String(error?.message ?? error)); }
      logInfo(ctx, '[team] checkpoint ' + membership.name + ' lineage=' + lineage + ' gen=' + gen + ' bytes=' + written.bytes);
      // 工作台账（契约 §5）：附自己 owner 的未闭合（pending）条目摘要；无则 null；读失败降级为 null，不阻断 checkpoint。
      let workItemsSummary = null;
      if (workItems.enabled !== false) {
        try {
          const ledger = readWorkItems(cwd, { pathOverride: workItems.pathOverride, scopeId: workItemsScopeOf(caller.session) });
          const own = ledger.exists === true
            ? ledger.items.filter((item) => item.owner === membership.name && item.status !== 'done')
            : [];
          if (own.length > 0) workItemsSummary = formatWorkItemLines(own, { limit: 8 });
        } catch (error) { logWarn(ctx, '[team] work items read failed: ' + String(error?.message ?? error)); }
      }
      return lossless({
        ok: true,
        path: written.path,
        bytes: written.bytes,
        caps: { limitBytes: TEAM_LIMITS.checkpointBytes, items: built.caps.items, truncated: built.caps.truncated },
        workItems: workItemsSummary,
        summary: 'checkpoint 已写入（' + written.bytes + '/' + TEAM_LIMITS.checkpointBytes + 'B）',
        text: 'checkpoint 已写入 ' + written.path + '（' + written.bytes + '/' + TEAM_LIMITS.checkpointBytes + 'B advisory）'
          + (built.caps.over === true ? '，超出建议体积但已完整落盘（不裁剪）' : '')
          + '。下一步：可请求 Lead 决定是否换代（你不需要自行压缩/交接）。',
      });
    },
  };

  /**
   * 队友：freshen（同任务内官方压缩，同代 ≤2）或 reset（真清空，同成员/不占额度/不计入 ≤2）。
   * reset 只排队：下一次 pre-step 由 installResetApplier 执行 surface 替换；这里不调压缩服务。
   */
  const freshen = {
    name: TOOL_PREFIX + 'freshen',
    description: 'Compact this teammate\'s own context at a task/phase boundary with the same controlled compaction the Lead uses (brief written first, official context-overflow compaction, brief injected after success). '
      + 'At most twice per generation (lossy; prefer this over renewal). reset:true = true wipe at the next pre-step (same member, no quota, old task context gone; applies below threshold and is not counted). Teammate-only.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        phase: { type: 'string', enum: ['discover', 'decide', 'build', 'verify', 'ship'] },
        brief: { type: 'string', description: 'Decisions + evidence pointers (short markdown). reset: the new task brief (the only user message left after wipe).' },
        key_docs: { type: 'array', items: { type: 'string' }, description: 'Important-file index for this project (<=8 workspace paths; path — role — why read after compaction): entry, core modules, configs, contracts, tests.' },
        force: { type: 'boolean', description: 'Force below threshold (rare; only when the Lead explicitly asked).' },
        reset: { type: 'boolean', description: 'True wipe: old task context is no longer needed. Queued until the next pre-step replaces every non-system surface node; the model then sees only the reset brief. Same member, no quota, allowed below threshold, not counted toward the freshen limit. Failure falls back to compaction.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: renderInternalResult(v, (x) => x?.text ?? x?.summary) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_freshen requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'teammate') return fail('teammate-only', 'relay_freshen is teammate-only', { summary: 'refused: only a Team teammate may freshen its own context; the Lead uses relay_organize.' });
      // v0.10.0：复用同会话 freshen 时把 Lead 当前的预算开关同步到本会话（失败只 warn，不阻断 freshen）。
      try {
        const parentId = caller.session?.header?.parentSession;
        if (typeof parentId === 'string' && parentId !== '') {
          updatePanelState(caller.session.id, { unlimitedBudget: effectiveUnlimitedBudgetOf(parentId) }, { source: 'agent', force: true });
        }
      } catch (error) {
        logWarn(ctx, '[freshen] budget sync skipped: ' + String(error?.message ?? error));
      }
      const release = claimRelayOperation(caller.session);
      if (release === undefined) return fail('relay-busy', 'busy: another relay operation is in flight in this session', { summary: 'refused: busy — another relay operation is in flight; wait for it to settle, then retry.' });
      try {
        const leadSessionId = leadSessionIdOf(membership);
        const cwd = cwdOf(caller.session);
        const lineage = lineageOf(membership.name);
        const gen = genOf(membership.name);
        const before = pressureOf(ctx, caller.session);
        const state = stateOf(ctx, caller.session, currentThresholds());
        const projected = relayStateOf(ctx, caller.session);
        const phase = normalizePhase(args?.phase, derivePhase(caller.session, projected));
        const phaseMeta = derivePhaseMeta(caller.session, projected);
        const reset = args?.reset === true;
        if (reset) {
          const checkpointInfo = (() => { try { return readCheckpoint(cwd, lineage, leadSessionId); } catch { return undefined; } })();
          const checkpointPath = checkpointInfo?.path ?? checkpointPathOf(cwd, lineage, leadSessionId);
          const checkpointRelative = checkpointInfo === undefined
            ? partitionRelativePath(leadSessionId, lineage, 'checkpoint.md')
            : workspaceRelativePath(cwd, checkpointInfo.path);
          const brief = buildResetBrief({
            phase, sessionId: caller.session.id, leadSessionId, lineage, checkpointRelative,
            userBrief: args?.brief, hasCheckpoint: checkpointInfo !== undefined,
          });
          let briefPath;
          try {
            const dir = lineageDirOf(cwd, lineage, leadSessionId);
            mkdirSync(dir, { recursive: true });
            briefPath = join(dir, 'freshen-' + Date.now() + '-reset.md');
            writeFileSync(briefPath, brief, 'utf8');
          } catch (error) {
            return fail('brief-write-failed', String(error?.message ?? error), { summary: 'reset aborted: brief could not be written; nothing was scheduled.' });
          }
          let scheduled;
          try {
            scheduled = scheduleReset(caller.session.id, {
              brief, userBrief: String(args?.brief ?? ''), phase, lineage, name: membership.name, gen,
              leadSessionId, briefPath, checkpointPath,
            });
          } catch (error) {
            return fail('reset-schedule-failed', String(error?.message ?? error), { summary: 'reset aborted: could not queue the wipe.' });
          }
          try { await clearTeamContextRow(cwd, leadSessionId, membership.name); } catch { /* 快照清理失败不影响 reset */ }
          logInfo(ctx, '[reset] queued session=' + caller.session.id + ' lineage=' + lineage + ' gen=' + gen + ' replaced=' + scheduled.replaced);
          return lossless({
            ok: true, mode: 'wipe-scheduled', briefPath, scheduled: true,
            text: '已排队：下一次模型请求前真清空旧上下文（同成员/不占额度）',
          });
        }
        if (state.band !== 'organize' && state.band !== 'relay' && args?.force !== true) {
          return fail('below-threshold', 'not freshened: band=' + state.band, { band: state.band, summary: 'not freshened: band=' + state.band + '; freshen only at a task/phase boundary when band>=organize (or force=true after the Lead explicitly asks).' });
        }
        let freshenCount = 0;
        try { freshenCount = readLedger(cwd, lineage, TEAM_LIMITS.ledgerEntries, leadSessionId).filter((entry) => entry?.event === 'freshen' && entry?.name === membership.name).length; } catch { freshenCount = 0; }
        if (freshenCount >= FRESHEN_LIMIT) {
          return fail('already-freshened', 'this generation already freshened ' + freshenCount + ' times (limit ' + FRESHEN_LIMIT + ')', { summary: 'refused: this generation already freshened ' + freshenCount + ' times (limit ' + FRESHEN_LIMIT + '; compression drift compounds). Ask the Lead to relay_renew: the successor reads your checkpoint, the old generation retires.' });
        }
        const engine = ctx.get('compaction');
        if (engine === undefined || typeof engine.compactIfNeeded !== 'function') return fail('compaction-unavailable', 'compaction service unavailable', { summary: 'refused: compaction service unavailable in this preset; use relay_checkpoint and ask the Lead to renew.' });
        const lint = runDocLint(cwd);
        const brief = buildPhaseBrief({
          phase,
          goal: phaseMeta.goal,
          exitCriteria: phaseMeta.exit_criteria,
          decisions: args?.brief === undefined ? [] : String(args.brief).split(/\n+/),
          constraints: [],
          evidence: [lint.evidence],
          keyDocs: args?.key_docs,
          next: ['同代最多 freshen 2 次；仍脏→先 relay_checkpoint，再请 Lead relay_renew'],
        });
        let briefPath;
        try {
          const dir = lineageDirOf(cwd, lineage, leadSessionId);
          mkdirSync(dir, { recursive: true });
          briefPath = join(dir, 'freshen-' + Date.now() + '.md');
          writeFileSync(briefPath, brief, 'utf8');
        } catch (error) {
          return fail('brief-write-failed', String(error?.message ?? error), { summary: 'freshen aborted: brief could not be written; compression was NOT attempted.' });
        }
        let compacted;
        try {
          compacted = await compactWithBrief({
            caller, cwd, lineage, leadSessionId, name: membership.name, gen, phase,
            brief, briefPath, engine, signal: exec?.signal ?? new AbortController().signal,
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          const busy = String(error?.code ?? '') === 'busy' || /busy|active/i.test(message);
          return fail(busy ? 'compaction-busy' : 'compaction-failed', message, { busy, organized: false, briefPath, briefInjected: false, docLint: { level: lint.level, summary: lint.summary }, summary: 'freshen failed' + (busy ? ' (compaction busy, retry after current turn)' : '') + ': ' + message });
        }
        const after = pressureOf(ctx, caller.session);
        const afterState = bandFor(after, currentThresholds());
        const freed = compacted.freedTokens;
        if (compacted.organized) LAST_BAND.set(caller.session.id, { band: 'ok', compactionSeq: undefined });
        try { await clearTeamContextRow(cwd, leadSessionId, membership.name); } catch { /* 快照清理失败不影响 freshen */ }
        logInfo(ctx, '[freshen] ok session=' + caller.session.id + ' lineage=' + lineage + ' freed=' + String(freed ?? '?') + ' band=' + state.band + '→' + afterState.band + ' briefInjected=' + compacted.briefInjected);
        return lossless({
          ok: true, organized: compacted.organized, band: state.band, afterBand: afterState.band,
          before: { used: before.used, ratio: before.ratio }, after: { used: after.used, ratio: after.ratio },
          freedTokens: freed, briefPath, briefInjected: compacted.briefInjected,
          manualRecallInjected: compacted.manualRecallInjected === true,
          compaction: compacted.compactionInfo,
          chain: compacted.chainInfo === undefined ? undefined : { path: compacted.chainInfo.relativePath, entries: compacted.chainInfo.entries },
          freshenCount: compacted.organized ? freshenCount + 1 : freshenCount,
          docLint: { level: lint.level, summary: lint.summary },
          summary: (compacted.organized ? 'freshened: freed ' + String(freed ?? '?') + ' tokens; band ' + state.band + ' → ' + afterState.band + '; brief ' + briefPath : 'no compactable history; brief written to ' + briefPath) + (compacted.briefInjected ? '; brief injected after compaction' : ''),
          text: '队友 freshen 完成（同代第 ' + (freshenCount + 1) + ' 次，上限 ' + FRESHEN_LIMIT + ' 次）：' + (compacted.organized ? '释放 ' + String(freed ?? '?') + ' tokens，band ' + state.band + '→' + afterState.band + '；' : '无可压缩历史；') + 'brief=' + briefPath + (compacted.briefInjected ? '（压缩后已注入关键结论）' : '') + '。仍脏→先 relay_checkpoint，再请 Lead relay_renew。',
        });
      } finally {
        release();
      }
    },
  };

  // ── 小队管理动作（v0.11 P0-B；不新增工具，走 relay_team_status 的 manage 参数）────────
  const MANAGE_NAMES_MAX = 30;
  const MANAGE_TARGETS_MAX = 50;
  const MANAGE_TEXT_MAX = 600;
  const MANAGE_BRIEF_MAX = 600;

  /**
   * manage.retire / manage.adopt 写 roster；manage.maintain 只发标准维护消息（不擦除/spawn/写 roster）。
   * 全部 fail-open 逐条记账（不阻断其余目标）；dry_run 零写盘零消息。
   * retire scope='legacy' 不写 roster（避免污染 squad，仅归档 retired.ndjson）；
   * scope='names' 走 retireGeneration（roster 标 retiredAt + ledger event:'retire'）。
   */
  async function manageTeam({ caller, leadSessionId, cwd, roster, allMembers, args, signal }) {
    const action = typeof args?.action === 'string' ? args.action : '';
    if (action !== 'retire' && action !== 'adopt' && action !== 'maintain') return fail('invalid-args', 'manage.action must be retire|adopt|maintain', { summary: 'refused: manage.action must be "retire", "adopt" or "maintain".' });
    const dryRun = args?.dry_run === true;
    const names = Array.isArray(args?.names) ? args.names.map((name) => String(name ?? '').trim()).filter((name) => name !== '') : [];
    const keep = Array.isArray(args?.keep) ? args.keep.map((name) => String(name ?? '').trim()).filter((name) => name !== '') : [];
    if (names.length > MANAGE_NAMES_MAX || keep.length > MANAGE_NAMES_MAX) {
      return fail('invalid-args', 'names/keep must be <= ' + MANAGE_NAMES_MAX, { summary: 'refused: names/keep too long (max ' + MANAGE_NAMES_MAX + ' each).' });
    }
    const squad = squadMembersOf(roster, allMembers);
    if (action === 'maintain') {
      return maintainTeam({ caller, squad, args, names, dryRun, signal });
    }
    const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
    if (reason === '' || [...reason].length > 200) return fail('invalid-args', 'manage.reason required (1-200 chars)', { summary: 'refused: manage.reason is required (1-200 chars).' });
    const archived = (() => { try { return retiredRecordsOf(cwd, leadSessionId, { limit: 200 }); } catch { return []; } })();
    const retiredSet = new Set([...retiredNamesOf(roster), ...archived.map((row) => row.name)]);

    if (action === 'adopt') {
      if (names.length === 0) return fail('invalid-args', 'adopt requires names (1-' + MANAGE_NAMES_MAX + ')', { summary: 'refused: adopt requires a non-empty names list.' });
      const known = new Set();
      for (const entry of Object.values(roster.lineages ?? {})) {
        for (const generation of entry?.generations ?? []) if (typeof generation?.name === 'string') known.add(generation.name);
      }
      const fresh = names.filter((name) => !known.has(name));
      if (squad.length + fresh.length > squadMax) {
        return fail('squad-full', 'adopt would exceed squad (' + squad.length + '+' + fresh.length + ' > ' + squadMax + ')', {
          squad: { size: squad.length, max: squadMax },
          over: fresh,
          recovery: '先 retire 空闲成员、调大 config squadMax，或减少 adopt 名单',
          summary: 'refused: adopt would exceed squadMax (' + squad.length + '/' + squadMax + '); retire or raise squadMax first.',
        });
      }
      const result = adoptMembers(roster, allMembers, names, { squadMax });
      if (!dryRun && result.adopted.length > 0) {
        try { await writeRoster(cwd, roster, leadSessionId); } catch (error) {
          return fail('roster-write-failed', String(error?.message ?? error), { summary: 'refused: roster write failed; nothing adopted.' });
        }
        for (const row of result.adopted) {
          try { await appendLedger(cwd, row.lineage, { event: 'adopt', gen: genOf(row.name), name: row.name, sessionId: row.sessionId, reason, at: new Date().toISOString() }, leadSessionId); } catch (error) { logWarn(ctx, '[team] adopt ledger failed: ' + String(error?.message ?? error)); }
        }
        TEAM_STATUS_MEMORY.delete(leadSessionId);
      }
      const adoptedNames = result.adopted.map((row) => row.name);
      const text = (dryRun ? 'dry_run：将纳入小队 ' : '已纳入小队 ') + (adoptedNames.length === 0 ? '0 个' : adoptedNames.join(', '))
        + (result.skipped.length > 0 ? '；跳过 ' + result.skipped.length + ' 个（' + result.skipped.map((row) => row.name + ':' + row.reason).join(', ') + '）' : '')
        + (result.overCap.length > 0 ? '；超 cap ' + result.overCap.length + ' 个' : '')
        + '；小队 ' + (squad.length + result.adopted.length) + '/' + squadMax
        + (dryRun ? '（dry_run 零写盘）' : '');
      return lossless({
        ok: true, action: 'adopt', dryRun,
        adopted: adoptedNames, skipped: result.skipped, overCap: result.overCap,
        counts: { adopted: result.adopted.length, skipped: result.skipped.length, overCap: result.overCap.length, squad: squad.length, squadMax },
        summary: (dryRun ? 'dry_run: would adopt ' : 'adopted ') + result.adopted.length + ' member(s)',
        text: clipText(text, MANAGE_TEXT_MAX),
      });
    }

    const scope = typeof args?.scope === 'string' ? args.scope : '';
    if (scope !== 'legacy' && scope !== 'names') return fail('invalid-args', 'retire scope must be legacy|names', { summary: 'refused: retire requires scope="legacy" or scope="names".' });
    if (scope === 'names' && names.length === 0) return fail('invalid-args', 'retire scope=names requires names', { summary: 'refused: retire scope=names requires a non-empty names list.' });
    const jobs = [];
    const skipped = [];
    if (scope === 'legacy') {
      for (const member of legacyMembersOf(roster, allMembers, retiredSet)) {
        if (keep.includes(member.name)) { skipped.push({ name: member.name, reason: 'kept' }); continue; }
        jobs.push({ name: member.name, member, kind: 'legacy', gen: genOf(member.name) });
      }
    } else {
      for (const name of names) {
        const lineage = lineageOf(name);
        const entry = roster.lineages?.[lineage];
        const generation = Array.isArray(entry?.generations) ? entry.generations.find((row) => row.name === name) : undefined;
        if (generation === undefined) { skipped.push({ name, reason: 'not-in-roster (use scope=legacy)' }); continue; }
        if (generation.retiredAt !== undefined) { skipped.push({ name, reason: 'already-retired' }); continue; }
        jobs.push({ name, member: allMembers.find((item) => item.name === name), kind: 'retire', lineage, entry, gen: generation.gen });
      }
    }
    if (jobs.length > MANAGE_TARGETS_MAX) {
      return fail('too-many-targets', 'retire targets ' + jobs.length + ' > ' + MANAGE_TARGETS_MAX, { summary: 'refused: retire targets exceed ' + MANAGE_TARGETS_MAX + '; narrow the list or use keep.' });
    }
    const counts = { targets: jobs.length, interrupted: 0, released: 0, archived: 0, failed: 0 };
    if (dryRun) {
      return lossless({
        ok: true, action: 'retire', scope, dryRun: true,
        targets: jobs.map((job) => job.name), skipped, counts,
        summary: 'dry_run: would retire ' + jobs.length + ' member(s)',
        text: clipText('dry_run：将退役 ' + jobs.length + ' 个（' + (scope === 'legacy' ? 'legacy 批量' : '显式名单') + '）'
          + (skipped.length > 0 ? '；跳过 ' + skipped.length + ' 个' : '') + '；零写盘零消息', MANAGE_TEXT_MAX),
      });
    }
    const retired = [];
    const failed = [];
    for (const job of jobs) {
      try {
        const member = job.member;
        if (member?.status === 'running') {
          const interrupted = await interruptMember(ctx, caller, member);
          if (interrupted.ok) counts.interrupted += 1;
        }
        let released = false;
        if (typeof member?.id === 'string' && member.id !== '') {
          try { released = await disposeActivation(member.id); } catch { released = false; }
          if (released) counts.released += 1;
        }
        if (scope === 'names') retireGeneration(job.entry, job.name, reason);
        try { await clearTeamContextRow(cwd, leadSessionId, job.name); } catch { /* 快照清理失败不阻断 */ }
        forgetDispatchRows(job.name);
        // releasable：只有 relay 自己创建的成员才有句柄；手工/旧成员为 false（如实报，不承诺释放）。
        retired.push({ name: job.name, gen: job.gen, sessionId: member?.id, reason, kind: job.kind, released, at: new Date().toISOString() });
      } catch (error) {
        failed.push({ name: job.name, reason: String(error?.message ?? error) });
      }
    }
    try {
      const archivedResult = await archiveRetired(cwd, leadSessionId, retired);
      counts.archived = archivedResult.appends;
    } catch (error) {
      failed.push({ name: 'archive', reason: String(error?.message ?? error) });
    }
    if (scope === 'names' && retired.length > 0) {
      try { await writeRoster(cwd, roster, leadSessionId); } catch (error) { failed.push({ name: 'roster', reason: String(error?.message ?? error) }); }
      for (const job of jobs) {
        if (!retired.some((row) => row.name === job.name)) continue;
        try { await appendLedger(cwd, job.lineage, { event: 'retire', gen: job.gen, name: job.name, reason, at: new Date().toISOString() }, leadSessionId); } catch { /* ledger 失败不阻断 */ }
      }
    }
    TEAM_STATUS_MEMORY.delete(leadSessionId);
    counts.failed = failed.length;
    const namesText = retired.slice(0, 8).map((row) => row.name).join(', ') + (retired.length > 8 ? ' 等' : '');
    const text = '已退役 ' + retired.length + ' 个（' + (scope === 'legacy' ? 'legacy 批量' : '显式名单') + '）：' + (namesText === '' ? '0' : namesText)
      + '；归档 ' + counts.archived + ' 条；interrupt ' + counts.interrupted + ' / release ' + counts.released
      + (failed.length > 0 ? '；失败 ' + failed.map((row) => row.name).join(', ') : '')
      + '。名字仍在 catalog（rc.2 不删名）：不再派活/展示；真清空团队用 relay_handoff。';
    return lossless({
      ok: true, action: 'retire', scope, dryRun: false,
      retired: retired.map((row) => row.name), skipped, failed, counts,
      summary: 'retired ' + retired.length + ' member(s)',
      text: clipText(text, MANAGE_TEXT_MAX),
    });
  }

  /**
   * manage.maintain（v0.13 B1）：Lead 只发标准维护消息（checkpoint → freshen），不擦除/spawn/写 roster；
   * 逐人 fail-open（一个发送失败不影响其余目标），dry_run 只列目标、零消息。
   */
  async function maintainTeam({ caller, squad, args, names, dryRun, signal }) {
    const brief = typeof args?.brief === 'string' ? args.brief.trim() : '';
    const reset = args?.reset !== false;
    if (names.length === 0) return fail('invalid-args', 'maintain requires names (1-' + MANAGE_NAMES_MAX + ')', { summary: 'refused: maintain requires a non-empty names list.' });
    if (brief === '') return fail('invalid-args', 'maintain.brief required', { summary: 'refused: maintain.brief is required (the new-task brief sent to each teammate).' });
    if ([...brief].length > MANAGE_BRIEF_MAX) return fail('invalid-args', 'maintain.brief too long (max ' + MANAGE_BRIEF_MAX + ' chars)', { summary: 'refused: maintain.brief exceeds ' + MANAGE_BRIEF_MAX + ' characters.' });
    const byName = new Map(squad.map((member) => [member.name, member]));
    const targets = [];
    const failed = [];
    for (const name of names) {
      if (lineageOf(name) === ARCHITECT_NAME) {
        failed.push({ name, reason: 'architect has no relay_freshen: use relay_architect({mode:"continue"}) or mode:"fresh"' });
        continue;
      }
      const member = byName.get(name);
      if (member === undefined) {
        failed.push({ name, reason: 'not-in-squad (adopt first; legacy/retired cannot be maintained)' });
        continue;
      }
      if (!targets.includes(member)) targets.push(member);
    }
    const modeText = reset ? '真清空 reset:true' : '同任务 freshen（reset:false）';
    if (dryRun) {
      return lossless({
        ok: true, action: 'maintain', reset, dryRun: true,
        targets: targets.map((member) => member.name), sent: [], failed,
        counts: { targets: targets.length, sent: 0, failed: failed.length },
        summary: 'dry_run: would request maintenance for ' + targets.length + ' member(s)',
        text: clipText('dry_run：将给 ' + targets.length + ' 个队友发维护请求（' + modeText + '）；失败 ' + failed.length + ' 个；零消息零写盘', MANAGE_TEXT_MAX),
      });
    }
    if (targets.length === 0) {
      return fail('no-targets', 'no maintainable squad member in names', {
        failed,
        summary: 'refused: none of the names is a maintainable squad member (see failed reasons).',
      });
    }
    const sent = [];
    for (const member of targets) {
      try {
        const result = await sendToMember(ctx, caller, member, [{ type: 'text', text: maintainRequestText(brief, reset) }], { signal });
        if (result.ok === true) sent.push({ name: member.name, messageId: result.messageId });
        else failed.push({ name: member.name, reason: result.reason ?? result.code ?? 'send failed' });
      } catch (error) {
        failed.push({ name: member.name, reason: String(error?.message ?? error) });
      }
    }
    const sentNames = sent.map((row) => row.name);
    const failedText = failed.map((row) => row.name + '（' + clipText(row.reason, 60) + '）').join(', ');
    return lossless({
      ok: true, action: 'maintain', reset, dryRun: false,
      sent, failed,
      counts: { targets: targets.length, sent: sent.length, failed: failed.length },
      summary: 'sent maintenance request to ' + sent.length + '/' + targets.length + ' member(s)',
      text: clipText('已发维护请求 ' + sent.length + ' 个（' + modeText + '）：' + (sentNames.length === 0 ? '无' : sentNames.join(', '))
        + (failed.length === 0 ? '' : '；失败 ' + failed.length + ' 个：' + failedText)
        + '。未擦除任何上下文：队友自己执行 relay_checkpoint → relay_freshen 后回执。', MANAGE_TEXT_MAX),
    });
  }

  /** Lead：队友保鲜体检（默认只看 squad；include_legacy/include_retired 显式查看历史）。 */
  const status = {
    name: TOOL_PREFIX + 'team_status',
    description: 'Lead-only team freshness. Default reads only the current squad (row: lineage/gen/status/band/checkpoint/health/action) plus legacy/retired counts; include_legacy/include_retired reveal hidden names. '
      + 'manage:{action:"retire"|"adopt",reason,...} writes; action:"maintain",names,brief[,reset] sends the standard relay_checkpoint → relay_freshen request and never wipes/spawns (dry_run available; catalog names stay). squadMax caps the squad; spawn is off. Do not poll: unchanged re-reads are refused.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        include_legacy: { type: 'boolean', description: 'Show hidden historical members (legacy): <=20 names + remainder count.' },
        include_retired: { type: 'boolean', description: 'Show hidden retired records: <=20 compact entries + remainder count.' },
        manage: {
          type: 'object', additionalProperties: false, required: ['action'],
          properties: {
            action: { type: 'string', enum: ['retire', 'adopt', 'maintain'], description: 'retire: stop assigning/showing targets. adopt: add useful historical members. maintain: message each target to run relay_checkpoint → relay_freshen itself (Lead never wipes directly).' },
            scope: { type: 'string', enum: ['legacy', 'names'], description: 'retire only: legacy = all hidden historical members except keep; names = explicit list (may include current squad).' },
            names: { type: 'array', items: { type: 'string' }, description: 'retire scope=names / adopt / maintain: exact member names (<=30).' },
            keep: { type: 'array', items: { type: 'string' }, description: 'retire scope=legacy: names to keep (<=30).' },
            reason: { type: 'string', description: 'retire/adopt required (1-200 chars).' },
            brief: { type: 'string', description: 'maintain only: required new-task brief (<=600 chars), sent verbatim to each target.' },
            reset: { type: 'boolean', description: 'maintain only: default true = relay_freshen({reset:true}) true wipe; false = same-task freshen.' },
            dry_run: { type: 'boolean', description: 'Plan only: zero writes, zero messages.' },
          },
        },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: renderInternalResult(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_team_status requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_team_status is Lead-only', { summary: 'refused: only the Team Lead may read the team freshness report.' });
      const caps = capabilitiesOf(ctx);
      if (!caps.listMembers) return fail('services-unavailable', 'team roster unavailable (' + caps.kind + ')', { summary: 'refused: team roster listing is unavailable; no team report.' });
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      const roster = readRoster(cwd, leadSessionId);
      const listed = await listMembers(ctx, caller);
      if (!listed.ok) return fail('team-read-failed', listed.reason, { summary: 'refused: could not list team members.' });
      const allMembers = teammatesOf(listed);
      if (args?.manage !== undefined && args.manage !== null) {
        return manageTeam({ caller, leadSessionId, cwd, roster, allMembers, args: args.manage, signal: signalOf(exec) });
      }
      const archived = (() => { try { return retiredRecordsOf(cwd, leadSessionId, { limit: 200 }); } catch { return []; } })();
      const includeLegacy = args?.include_legacy === true;
      const includeRetired = args?.include_retired === true;
      const retiredSet = new Set([...retiredNamesOf(roster), ...archived.map((row) => row.name)]);
      // v0.11 P0-B：默认只展示当前小队（squad）；legacy/retired 只给计数，include_* 才展开。
      const squad = squadMembersOf(roster, allMembers);
      const legacyMembers = legacyMembersOf(roster, allMembers, retiredSet);
      const summary = squadSummaryOf(roster, allMembers, { squadMax, retiredRecords: archived });
      const thresholds = currentThresholds();
      // v0.6.1：phase 边界 triage 的可见性——Lead 当前 phase + 队友名下进行中/阻塞条目数（只读）。
      let ledger;
      try { ledger = readWorkItems(cwd, { pathOverride: workItems.pathOverride, scopeId: workItemsScopeOf(caller.session) }); } catch { ledger = undefined; }
      const leadPhase = ledger?.currentPhase?.phase ?? null;
      const rows = [];
      for (const member of squad) {
        const pressure = await teammateState(ctx, member);
        const state = pressure === undefined ? { band: 'unknown' } : bandFor(pressure, thresholds);
        const lineage = lineageOf(member.name);
        const entry = roster.lineages[lineage];
        const known = entry?.generations?.find((item) => item.name === member.name);
        const gen = known !== undefined && Number.isInteger(known.gen) ? known.gen : genOf(member.name);
        let checkpointInfo;
        try { checkpointInfo = readCheckpoint(cwd, lineage, leadSessionId); } catch { checkpointInfo = undefined; }
        const health = classifyHealth(state, checkpointInfo !== undefined);
        // C8/M-05：reset 结果汇总（成功/回退/失败）——失败时 Lead 必须知道旧上下文仍在。
        const reset = resetStateOf(cwd, lineage, leadSessionId);
        rows.push({
          name: member.name,
          lineage,
          gen,
          rosterKnown: known !== undefined,
          status: member.status,
          band: state.band,
          ratio: state.ratio,
          checkpoint: { exists: checkpointInfo !== undefined, bytes: checkpointInfo?.bytes, updatedAt: checkpointInfo?.updatedAt },
          health: health.health,
          action: health.action,
          ...(reset === undefined ? {} : { reset }),
          phase: leadPhase,
          ...(ledger?.exists === true ? {
            items: {
              doing: ledger.items.filter((item) => item.owner === member.name && item.status === 'doing').length,
              blocked: ledger.items.filter((item) => item.owner === member.name && item.status === 'blocked').length,
            },
          } : {}),
        });
      }
      const active = rows.filter((row) => row.status === 'running').length;
      const stale = rows.filter((row) => row.health === 'stale' || row.health === 'spent').map((row) => row.name);
      // v0.6.3：队友上下文待处理（到线/读不到）——Lead 不轮询也要看到：随 team_status 落快照，
      // 再由台账焦点行事件驱动地带出来；phase 边界 relay_phase 未处理会被拒（team_note 硬闸门）。
      const pending = rows.filter((row) => row.band === 'organize' || row.band === 'relay' || row.band === 'unknown').map((row) => row.name);
      const architectRow = rows.find((row) => lineageOf(row.name) === ARCHITECT_NAME);
      // C8/C16：deeper（孙代理数量）必须进签名（否则孙代理变化被判未变误拒）。
      const deeper = Number.isInteger(listed.deeper) && listed.deeper > 0 ? listed.deeper : 0;
      // C8/M-05：reset 结果汇总（成功/回退/失败）——失败时模型可见旧上下文仍在。
      const resetSummary = { ok: [], fallback: [], failed: [] };
      for (const row of rows) {
        if (row.reset?.event === 'reset') resetSummary.ok.push(row.name);
        else if (row.reset?.event === 'fallback') resetSummary.fallback.push(row.name);
        else if (row.reset?.event === 'failed') resetSummary.failed.push({ name: row.name, reason: row.reset.reason ?? null });
      }
      const hasResets = resetSummary.ok.length + resetSummary.fallback.length + resetSummary.failed.length > 0;
      const report = {
        ok: true,
        phase: leadPhase,
        team: rows,
        active,
        stale,
        pending,
        // v0.11 P0-B：默认只给计数；名字只在 include_retired:true 时以 retiredRecords 返回。
        retired: summary.retired,
        teamSummary: summary,
        architect: architectRow === undefined ? { present: false } : { present: true, name: architectRow.name, health: architectRow.health },
        ...(deeper > 0 ? { deeper } : {}),
        ...(hasResets ? { reset: resetSummary } : {}),
        ...(includeLegacy ? { legacyNames: legacyMembers.map((member) => member.name) } : {}),
        ...(includeRetired ? { retiredRecords: archived.slice(0, STATUS_LIST_LIMIT) } : {}),
        roster: { teammates: rows.length, legacy: summary.legacy, retired: summary.retired },
        text: '',
      };
      // 去轮询（v0.6.0）：与上次完全相同的团队状态 = 信息没变，直接拒绝；变了才返回全量。
      const signature = teamStatusSignature(rows, [...retiredSet], deeper, {
        legacy: summary.legacy, retired: summary.retired, squadMax, includeLegacy, includeRetired,
      });
      const memory = TEAM_STATUS_MEMORY.get(leadSessionId);
      if (memory !== undefined && memory.signature === signature) {
        const steps = Number.isFinite(caller.session?.seq) && Number.isFinite(memory.seq) ? Math.max(0, caller.session.seq - memory.seq) : undefined;
        return fail('unchanged-poll', 'relay_team_status refused (polling, unchanged): 团队状态与上次查询完全一致，读到的还是同一份信息——不要轮询等待。替代做法：① 回执会自动作为消息送达并叫醒你；② phase 边界（relay_phase 跨 phase）会自动带 triage 摘要；③ 结束本回合等回执，或从工作台账队列推进下一分点（relay_work_items 读队列）。', {
          unchanged: true,
          ...(steps === undefined ? {} : { sinceSteps: steps }),
          team: report.team.map((row) => ({ name: row.name, band: row.band, health: row.health })),
          summary: 'refused: team state is unchanged since the previous relay_team_status (do not poll). Teammate replies arrive as messages; phase boundaries carry triage automatically. End the turn or advance a ledger point (relay_work_items) instead.',
          text: 'relay_team_status 拒绝（轮询无变化）：团队状态与上次查询一致。不要轮询——回执会自动送达；phase 边界会带 triage；等队友请结束回合或推进台账下一分点（relay_work_items）。',
        });
      }
      TEAM_STATUS_MEMORY.set(leadSessionId, { signature, seq: Number.isFinite(caller.session?.seq) ? caller.session.seq : undefined });
      if (TEAM_STATUS_MEMORY.size > TEAM_STATUS_MEMORY_MAX) TEAM_STATUS_MEMORY.clear();
      report.text = renderTeamStatus(report, partitionRelativePath(leadSessionId) + '/')
        + (stale.length > 0
      ? '\n建议：先处理 stale/spent：' + stale.join(', ') + '（stale：边界让队友 relay_freshen({reset:true, brief}) 真清空复用（同成员、0 额度）；spent：先 relay_checkpoint 补记录再 reset 复用。换身份/角色且 config allowSpawn=true 才 relay_renew；spawn 关时不要重试：reset 复用，或 phase 边界 relay_handoff 重建）。'
      : '\n建议：全部 fresh/watch，无需换代。')
        + (pending.length > 0
      ? '\n队友上下文待处理：' + pending.join(', ') + '——phase 边界先处理（发消息让该队友自己 checkpoint/freshen/reset/renew）并建议用 team_note 记一行（只 warning，不拒绝）；不要轮询本工具。'
      : '')
        + (hasResets
      ? '\nreset 结果：真清空 ' + (resetSummary.ok.length > 0 ? resetSummary.ok.join(', ') : '0')
        + ' · 回退压缩 ' + (resetSummary.fallback.length > 0 ? resetSummary.fallback.join(', ') : '0')
        + ' · 失败 ' + (resetSummary.failed.length > 0 ? resetSummary.failed.map((row) => row.name + '（' + String(row.reason ?? '?') + '）').join(', ') : '0')
        + '（失败=旧上下文仍在：先 relay_checkpoint 补记录，再重试 reset 或让 Lead 决定）'
      : '')
        + (summary.overCap
      ? '\n小队超上限（' + summary.squad + '/' + summary.squadMax + '）：先 retire 空闲成员或调大 config squadMax；adopt/spawn 会被拒。'
      : '');
      // v0.6.3：快照落盘（焦点行/phase 闸门共用；写失败不影响报告）。
      try {
        await replaceTeamContext(cwd, leadSessionId, { phase: leadPhase, rows: rows.map((row) => ({ name: row.name, band: row.band })) });
      } catch { /* 快照写失败不影响体检 */ }
      return lossless(report);
    },
  };
  /** Lead：归档换代（checkpoint → 新代际队友；占成员额度，只用于换身份/角色）。 */
  const renew = {
    name: TOOL_PREFIX + 'renew',
    description: 'Renew one teammate: archive its checkpoint and spawn the next generation (<lineage>-g<N>), which starts from the record + recall pointers and verifies a fact before waiting for work. '
      + 'Requires an existing checkpoint; if missing, asks the teammate to write one and returns pending. Old generation is interrupted if running and never assigned again. Lead-only.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: { type: 'string', description: 'Exact teammate name to renew (target from list_agents/spawn_teammate).' },
        reason: { type: 'string', description: 'One-line reason (e.g. band=organize, 3 phases served).' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: renderInternalResult(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_renew requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_renew is Lead-only', { summary: 'refused: only the Team Lead may renew a teammate.' });
      const caps = capabilitiesOf(ctx);
      if (!caps.listMembers) return fail('services-unavailable', 'team roster unavailable (' + caps.kind + ')', { summary: 'refused: team roster is unavailable; cannot renew.' });
      // v0.11 P0-B：renew 默认拒绝（spawn 关闭）——换人不靠新建，reset 全清复用。
      if (!allowSpawn) {
        return fail('spawn-disabled', 'relay_renew is disabled: spawn is off (config allowSpawn=false)', {
          recovery: '换人不靠新建：发消息让目标自己 relay_checkpoint → relay_freshen({reset:true, brief}) 全清复用（同成员/0 额度）；只有换身份/角色且确需新代时才把 config allowSpawn 设为 true',
          summary: 'refused: spawn is disabled (allowSpawn=false); use checkpoint + relay_freshen({reset:true, brief}) to reuse the same member instead of renewing.',
        });
      }
      if (!caps.spawn) return fail('services-unavailable', 'team spawn unavailable (' + caps.kind + ')', { summary: 'refused: team spawn is unavailable; cannot renew.' });
      const target = String(args?.name ?? '').trim();
      if (target === '') return fail('invalid-name', 'name required', { summary: 'refused: name required (exact teammate name).' });
      const listed = await listMembers(ctx, caller);
      if (!listed.ok) return fail('team-read-failed', listed.reason, { summary: 'refused: could not list team members.' });
      const members = teammatesOf(listed);
      const member = members.find((item) => item.name === target);
      if (member === undefined) return fail('not-found', 'teammate not found: ' + target, { summary: 'refused: no teammate named ' + target + '; list_agents for exact targets.' });
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      const lineage = lineageOf(member.name);
      const prevGen = genOf(member.name);
      const roster = readRoster(cwd, leadSessionId);
      // v0.11 P0-B：换代也要受 squadMax 约束（同名额替换：排除目标自身后不得已达上限）。
      const squad = squadMembersOf(roster, teammatesOf(listed));
      if (squad.filter((item) => item.name !== member.name).length >= squadMax) {
        return fail('squad-full', 'squad full (' + squad.length + '/' + squadMax + '); renew would exceed the cap', {
          squad: { size: squad.length, max: squadMax },
          recovery: '先 retire 空闲成员、调大 config squadMax，或让目标 reset 复用（同成员/0 额度）',
          summary: 'refused: renew would exceed squadMax (' + squad.length + '/' + squadMax + '); retire or raise squadMax first.',
        });
      }
      const entry = ensureLineage(roster, lineage, { name: member.name, sessionId: member.id, role: '', description: member.description ?? '' });
      const knownGeneration = entry.generations.find((item) => item.name === member.name);
      if (knownGeneration !== undefined && knownGeneration.retiredAt !== undefined) {
        return fail('already-retired', 'teammate ' + member.name + ' is already retired', { summary: 'refused: ' + member.name + ' is retired; renew its successor generation instead.' });
      }
      let checkpointInfo;
      try { checkpointInfo = readCheckpoint(cwd, lineage, leadSessionId); } catch { checkpointInfo = undefined; }
      if (checkpointInfo === undefined) {
        let requested = false;
        const sent = await sendToMember(ctx, caller, member, [{ type: 'text', text: checkpointRequestText(member.name) }], { signal: signalOf(exec) });
        if (sent.ok) requested = true;
        else logWarn(ctx, '[team] checkpoint request failed: ' + sent.reason);
        return fail('checkpoint-missing', 'no checkpoint for ' + member.name + '; requested=' + String(requested), {
          requested,
          summary: 'refused: no checkpoint yet — ' + (requested ? 'asked ' + member.name + ' to call relay_checkpoint; retry relay_renew after it replies' : 'ask the teammate to call relay_checkpoint first, then retry'),
        });
      }
      const used = members.map((item) => item.name).concat(usedNamesOf(entry));
      const existing = entry.generations.filter((item) => item.name === member.name).map((item) => item.gen);
      const highest = Math.max(prevGen, ...(existing.length > 0 ? existing : [prevGen]), ...entry.generations.map((item) => item.gen));
      const next = nextGenName(lineage, used, highest);
      if (!isValidTeammateName(next.name)) return fail('invalid-name', 'next generation name invalid: ' + next.name, { summary: 'refused: derived name ' + next.name + ' is not a valid rc.2 child name (1-32 chars, starts with a letter, lower-kebab-case).' });
      const reason = clipText(args?.reason ?? '', 200);
      if (member.status === 'running') {
        const interrupted = await interruptMember(ctx, caller, member);
        if (interrupted.ok) logInfo(ctx, '[team] interrupted running teammate before renew: ' + member.name);
        else logWarn(ctx, '[team] interrupt failed before renew: ' + interrupted.reason);
      }
      let profile;
      try { profile = readProfile(cwd, lineage, leadSessionId); } catch { profile = undefined; }
      if (profile === undefined) {
        const seeded = entry.profile ?? {};
        const parts = [seeded.role, seeded.description].filter((value) => typeof value === 'string' && value.trim() !== '');
        if (parts.length > 0) profile = parts.join(' · ');
      }
      const ledger = readLedger(cwd, lineage, 10, leadSessionId);
      // legacy-only 记录时按实际 checkpoint 路径给记录目录（与 reset brief 同口径），避免新代去不存在的分区找记录。
      const recordDir = workspaceRelativePath(cwd, checkpointInfo.path).replace(/\/checkpoint\.md$/, '');
      const prompt = buildRenewPrompt({ lineage, newName: next.name, gen: next.gen, prevName: member.name, profile, checkpoint: checkpointInfo.text, ledger, leadSessionId, recordDir });
      const startNext = () => startMember(ctx, caller, {
        name: next.name,
        description: clipText(member.description ?? ('队友 ' + lineage + ' 第 ' + next.gen + ' 代'), 200),
        prompt: [{ type: 'text', text: prompt }],
        provider,
        signal: signalOf(exec),
      });
      // v0.10.0：spawn 前登记 Lead 当前预算开关，agent/created 写入新队友面板；成败都撤销。
      let spawned;
      markPendingBudgetInherit(leadSessionId, effectiveUnlimitedBudgetOf(caller.session.id));
      try {
        spawned = await startNext();
        // rc.2 并发额度按 root 计；旧代是 continuable activation，interrupt 不会释放槽位。
        // 满了先释放旧代再重试一次（旧会话仍可按名冷恢复，不会丢记录）。
        if (spawned.ok !== true && spawned.code === 'member-limit') {
          // 只有 relay 自己创建的成员才有句柄；legacy/模型自建成员没有 handle，重试也释放不了。
          const old = takeActivation(member.id);
          if (old !== undefined) {
            try { await old.dispose?.(); } catch { /* dispose 失败仍尝试重启，失败会报到下面 */ }
            logInfo(ctx, '[team] released old activation before renew retry: ' + member.name);
            spawned = await startNext();
          }
        }
      } finally {
        clearPendingBudgetInherit(leadSessionId);
      }
      if (!spawned.ok) {
        const memberLimit = spawned.code === 'member-limit';
        return fail(memberLimit ? 'member-limit' : 'spawn-failed', spawned.reason, {
          memberLimit,
          next: { name: next.name, gen: next.gen },
          summary: memberLimit
            ? 'member-limit: 子智能体并发额度已满，无法换代（' + next.name + ' 未创建）。到上限报阻塞、不重试：① 发消息让 ' + member.name + ' 自己 relay_checkpoint 后自己 relay_freshen({reset:true, brief}) 真清空复用（0 额度）；② phase 边界 relay_handoff（团队重启）后按交接单重建小队。'
            : 'refused/failed: could not spawn ' + next.name + '; check provider availability. If the old activation was released to make room, it can still be resumed by name.',
        });
      }
      const newMember = spawned.member;
      // 成功的换代：旧代立即释放（不再驻留、不再占并发额度；catalog 名字保留供审计）。
      if (typeof member.id === 'string' && member.id !== '') {
        const released = await disposeActivation(member.id);
        if (released) logInfo(ctx, '[team] released retired activation: ' + member.name);
      }
      if (newMember?.id !== undefined) rememberActivation(newMember.id, spawned.activation);
      const archived = await (async () => { try { return await archiveCheckpoint(cwd, lineage, prevGen, leadSessionId); } catch (error) { logWarn(ctx, '[team] archive checkpoint failed: ' + String(error?.message ?? error)); return undefined; } })();
      retireGeneration(entry, member.name, reason === '' ? 'renew' : reason);
      if (newMember !== undefined && newMember !== null) {
        ensureLineage(roster, lineage, { name: next.name, gen: next.gen, sessionId: newMember.id, role: '', description: '' });
      }
      entry.activeGen = next.gen;
      let rosterError;
      try { await writeRoster(cwd, roster, leadSessionId); } catch (error) { rosterError = String(error?.message ?? error); logWarn(ctx, '[team] roster write failed after renew: ' + rosterError); }
      const handoffRelative = relativeHandoff(lineage, prevGen, leadSessionId);
      try {
        await appendLedger(cwd, lineage, { event: 'renew', gen: prevGen, name: member.name, to: next.name, toGen: next.gen, handoff: handoffRelative, reason, at: new Date().toISOString() }, leadSessionId);
      } catch (error) { logWarn(ctx, '[team] ledger append failed after renew: ' + String(error?.message ?? error)); }
      try { await clearTeamContextRow(cwd, leadSessionId, member.name); } catch { /* 快照清理失败不阻断换代 */ }
      logInfo(ctx, '[team] renew ' + member.name + ' → ' + next.name + ' (gen ' + next.gen + ')');
      return lossless({
        ok: true,
        previous: { name: member.name, gen: prevGen, status: member.status },
        next: { name: next.name, gen: next.gen, target: next.name, sessionId: newMember?.id },
        handoff: archived === undefined ? undefined : { path: archived.path, bytes: archived.bytes },
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        rosterWrite: rosterError === undefined ? 'ok' : 'failed: ' + rosterError,
        summary: 'renewed ' + member.name + ' → ' + next.name,
        text: '已换代：' + member.name + ' → ' + next.name + '（gen ' + next.gen + '）。新队友已读取记录，会先核验事实再等任务；旧代不再派活。'
          + (archived === undefined ? '（checkpoint 固化失败：检查记录目录权限）' : '交接已固化：' + handoffRelative)
          + (rosterError === undefined ? '' : '；roster 写盘失败：' + rosterError),
      });
    },
  };
  /** Lead：创建/复用固定架构师；未选跟随模型默认，已选 sticky，composer 可覆盖。 */
  const architect = {
    name: TOOL_PREFIX + 'architect',
    description: 'Lead-only (relay-long): start a fresh architect for one engineering task, or continue the current architect. '
      + 'The architect model defaults to the composer model selector\'s default selection (the Lead\'s current default model); a choice already made in this session is kept, and the composer model menu can override it anytime (explicit overrides must be inside the official subagent model allowlist). No selection is required and the call never blocks. '
      + 'Fresh requires the old generation checkpoint, retires it, and starts a clean context; continue reuses the current generation (a model change requires fresh). '
      + 'Returns the doc path the architect must write (size advisory; seven sections; preserve full content on disk).',
    parameters: {
      type: 'object', additionalProperties: false, required: ['brief'],
      properties: {
        brief: { type: 'string', description: 'Requirement brief for this task (<=2000 chars): user intent, boundaries, acceptance.' },
        task_id: { type: 'string', description: 'Stable task id used in the doc filename; default task-<timestamp>.' },
        mode: { type: 'string', enum: ['fresh', 'continue'], description: 'fresh (default): clean architect context for a new task; continue: reuse the current architect (must be low context).' },
        doc_pointers: { type: 'array', items: { type: 'string' }, description: 'Project docs/module entry pointers the architect should read (<=8).' },
        write_scope: { type: 'array', items: { type: 'string' }, description: 'Allowed doc write scope (<=8 paths).' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: renderInternalResult(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_architect requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_architect is Lead-only', { summary: 'refused: only the Lead may create/continue the architect.' });
      const panel = panelStateOf(caller.session.id);
      if (panel.architect === false) return fail('architect-disabled', 'architect is disabled in this session panel', { summary: 'refused: the architect chip is off in this session.' });
      const selected = panel.architectModel;
      const defaultRoute = selected === null ? modelSelectionDefaultOf(ctx, { session: caller.session, options: caller.options }) : null;
      const spawnRoute = selected ?? defaultRoute;
      const modelSource = selected !== null ? 'panel' : 'default';
      // 显式覆盖才校验白名单；默认路由等价官方父路由继承，不引入新拒绝。
      if (selected !== null) {
        const policy = architectModelPolicy(ctx, caller);
        if (policy.ok !== true) {
          return fail('architect-model-policy-unavailable', policy.reason, {
            allowedModels: [],
            summary: 'refused: could not read this session\'s subagent model allowlist; fix the official subagent model-selection settings or start a new session before creating the architect.',
          });
        }
        if (policy.routes.some((route) => route.provider === selected.provider && route.model === selected.model) !== true) {
          return fail('architect-model-not-allowed', 'selected architect model is outside this session\'s subagent model allowlist', {
            allowedModels: policy.routes,
            summary: 'refused: the selected architect model is not in this session\'s subagent model allowlist (' + policy.routes.map((route) => route.provider + '/' + route.model).join(', ') + '). Add it in the official subagent model settings (new session) or pick an allowed model.',
          });
        }
      }
      const mode = args?.mode === 'continue' ? 'continue' : 'fresh';
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      const roster = readRoster(cwd, leadSessionId);
      const listed = await listMembers(ctx, caller);
      if (!listed.ok) return fail('team-read-failed', listed.reason, { summary: 'refused: could not list current team members.' });
      const active = squadMembersOf(roster, teammatesOf(listed));
      const existing = active.find((member) => lineageOf(member.name) === ARCHITECT_NAME);
      // v0.11 P0-B：架构师豁免 allowSpawn（固定角色），但计入 squadMax——其他成员占满时先清理/复用。
      if (active.filter((member) => lineageOf(member.name) !== ARCHITECT_NAME).length >= squadMax) {
        return fail('squad-full', 'squad full (' + active.length + '/' + squadMax + '); architect fresh would exceed the cap', {
          squad: { size: active.length, max: squadMax },
          recovery: '先 retire 空闲成员、调大 config squadMax，或让架构师 continue 复用当前代',
          summary: 'refused: architect counts toward squadMax and the squad is full; retire or raise squadMax first.',
        });
      }
      const taskId = safeTaskId(args?.task_id);
      const docPath = '.scratch/context-relay/architecture/' + taskId + '.md';
      if (mode === 'continue') {
        if (existing === undefined) return fail('architect-missing', 'no active architect to continue', { summary: 'refused: no active architect; use mode=fresh to create one.' });
        // v0.10.0 P2-2：continue 复用不 spawn，架构师工具面也没有 freshen——这里同样把 Lead 当前预算开关同步到架构师会话。
        try {
          updatePanelState(existing.id, { unlimitedBudget: effectiveUnlimitedBudgetOf(caller.session.id) }, { source: 'agent', force: true });
        } catch (error) {
          logWarn(ctx, '[architect] budget sync skipped: ' + String(error?.message ?? error));
        }
        const text = '架构师继续任务：' + taskId + '。需求 brief：' + clipText(args?.brief, 2000) + '。交付文档：' + docPath + '（沿用当前上下文；若上下文已脏，回执 Lead 请求 fresh）。';
        const sent = await sendToMember(ctx, caller, existing, [{ type: 'text', text }], { signal: signalOf(exec) });
        if (!sent.ok) return fail('send-failed', sent.reason, { summary: 'refused: could not send the task to the current architect.' });
        return lossless({ ok: true, mode: 'continue', name: existing.name, docPath, model: selected, modelSource, summary: 'continued architect ' + existing.name + ' (model change requires fresh)', text: '已把任务发给当前架构师 ' + existing.name + '；continue 复用当前代与当前模型，默认值只影响 fresh 新建，换模型请用 mode:"fresh"。' });
      }
      let prevGen = 0;
      let prevName;
      if (existing !== undefined) {
        const lineage = ARCHITECT_NAME;
        let checkpointInfo;
        try { checkpointInfo = readCheckpoint(cwd, lineage, leadSessionId); } catch { checkpointInfo = undefined; }
        if (checkpointInfo === undefined) {
          const sent = await sendToMember(ctx, caller, existing, [{ type: 'text', text: checkpointRequestText(existing.name) }], { signal: signalOf(exec) });
          return fail('checkpoint-missing', 'no architect checkpoint; asked the current architect to write one', { requested: sent.ok === true, summary: 'refused: fresh architect needs the old generation checkpoint; retry after it replies.' });
        }
        prevGen = genOf(existing.name);
        prevName = existing.name;
        if (existing.status === 'running') {
          const interrupted = await interruptMember(ctx, caller, existing);
          if (interrupted.ok !== true) logWarn(ctx, '[architect] interrupt before fresh failed: ' + interrupted.reason);
        }
        const old = takeActivation(existing.id);
        if (old !== undefined) { try { await old.dispose?.(); } catch { /* 容量释放失败仍尝试 spawn，失败会返回 */ } }
        try { await archiveCheckpoint(cwd, lineage, prevGen, leadSessionId); } catch (error) { logWarn(ctx, '[architect] archive checkpoint failed: ' + String(error?.message ?? error)); }
      }
      const entry = ensureLineage(roster, ARCHITECT_NAME, existing === undefined
        ? { role: 'architect', description: '专职架构师' }
        : { name: existing.name, sessionId: existing.id, role: 'architect', description: '专职架构师' });
      // 名字在 catalog 里永久唯一：active 与退役代都算已占用，避免用旧名 spawn 被拒。
      const used = [...teammatesOf(listed).map((member) => member.name), ...usedNamesOf(entry)];
      let next;
      if (existing === undefined && !used.includes(ARCHITECT_NAME)) next = { name: ARCHITECT_NAME, gen: 1 };
      else {
        const highest = Math.max(prevGen, ...(entry.generations ?? []).map((row) => row.gen));
        next = nextGenName(ARCHITECT_NAME, used, highest);
      }
      if (!isValidTeammateName(next.name)) return fail('invalid-name', 'derived architect name invalid: ' + next.name, { summary: 'refused: architect name is not a valid rc.2 child name.' });
      const docs = Array.isArray(args?.doc_pointers) ? args.doc_pointers.filter((item) => typeof item === 'string').slice(0, 8) : [];
      const scopes = Array.isArray(args?.write_scope) ? args.write_scope.filter((item) => typeof item === 'string').slice(0, 8) : [];
      const prompt = [
        '[context-relay] 架构师任务 · ' + taskId,
        '用户需求 brief：' + clipText(args?.brief, 2000),
        docs.length === 0 ? '' : '文档/模块入口：' + docs.join('；'),
        scopes.length === 0 ? '' : '写范围：' + scopes.join('；'),
        '交付：' + docPath + '（体积 advisory，摘要+完整落盘；七段：需求对齐/技术路线/模块接口/数据协议/风险取舍/待决策/实现步骤与验收）',
        '待决策每条写清：问题/影响/选项+推荐；完成后 relay_checkpoint 并回执 Lead；不自行 freshen/reset，不向用户提问，不改产品代码。',
      ].filter((line) => line !== '').join('\n');
      try { mkdirSync(join(cwd, '.scratch', 'context-relay', 'architecture'), { recursive: true }); } catch { /* 目录创建失败由架构师写文档时暴露 */ }
      // v0.7.1：rc.2 的 agent/created 先于 subagents.resident 登记，团队服务在创建瞬间不可用；
      // spawn 前登记 pending 标记，创建回调用 header.parentSession 认领架构师身份（成功/失败都撤销）。
      markPendingArchitect(leadSessionId);
      markPendingBudgetInherit(leadSessionId, effectiveUnlimitedBudgetOf(caller.session.id));
      let spawned;
      try {
        spawned = await startMember(ctx, caller, {
          name: next.name,
          description: '专职架构师',
          prompt: [{ type: 'text', text: prompt }],
          provider,
          ...(spawnRoute === null ? {} : { agentOptions: spawnRoute }),
          signal: signalOf(exec),
        });
      } finally {
        clearPendingArchitect(leadSessionId);
        clearPendingBudgetInherit(leadSessionId);
      }
      if (!spawned.ok) {
        const memberLimit = spawned.code === 'member-limit';
        return fail(memberLimit ? 'member-limit' : 'spawn-failed', spawned.reason, {
          memberLimit,
          summary: memberLimit
            ? 'member-limit: 并发额度已满，架构师未创建；先释放/重置其他成员后重试。'
            : 'refused/failed: could not start the architect; check the selected model/provider and provider availability.',
        });
      }
      const newMember = spawned.member;
      if (newMember?.id !== undefined) rememberActivation(newMember.id, spawned.activation);
      ensureLineage(roster, ARCHITECT_NAME, { name: next.name, gen: next.gen, sessionId: newMember?.id, role: 'architect', description: '专职架构师' });
      if (prevName !== undefined) retireGeneration(entry, prevName, 'architect-fresh');
      let rosterError;
      try { await writeRoster(cwd, roster, leadSessionId); } catch (error) { rosterError = String(error?.message ?? error); logWarn(ctx, '[architect] roster write failed: ' + rosterError); }
      try { await appendLedger(cwd, ARCHITECT_NAME, { event: 'architect-fresh', gen: next.gen, name: next.name, from: prevName, taskId, docPath, at: new Date().toISOString() }, leadSessionId); } catch (error) { logWarn(ctx, '[architect] ledger append failed: ' + String(error?.message ?? error)); }
      return lossless({
        ok: true,
        mode: 'fresh',
        name: next.name,
        gen: next.gen,
        docPath,
        model: spawnRoute,
        modelSource,
        previous: prevName,
        rosterWrite: rosterError === undefined ? 'ok' : 'failed: ' + rosterError,
        summary: 'started architect ' + next.name + ' for ' + taskId,
        text: '架构师已启动：' + next.name + '（model=' + (spawnRoute === null
          ? '默认跟随 Lead（官方继承）'
          : spawnRoute.provider + '/' + spawnRoute.model + (spawnRoute.reasoningEffort === undefined ? '' : ' · ' + spawnRoute.reasoningEffort) + (modelSource === 'default' ? '（默认跟随模型选择；可覆盖）' : '')) + '）。交付文档：' + docPath + '。',
      });
    },
  };

  return { leadTools: [status, renew, architect], teammateTools: [checkpoint, freshen] };
}

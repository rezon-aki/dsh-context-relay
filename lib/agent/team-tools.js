/**
 * dsh-context-relay — 队友保鲜工具（P0/P1）：relay_checkpoint / relay_freshen /
 * relay_team_status / relay_renew / relay_architect。
 *
 * 工具按 agent 角色注册（agent scope，不污染 classic relay）：
 * - 队友：relay_checkpoint（写自己的工作记录）/ relay_freshen（同任务减压 or 真清空 reset）
 * - Lead：relay_team_status（体检）/ relay_renew（归档换代）/ relay_architect（固定架构师）
 * 执行层再次校验身份（Lead-only / 队友-only），与注册面互为纵深。
 *
 * 所有 team 记录 IO 都带本 Team 的 leadSessionId 分区（membership.root.session.id）；
 * reset 的真清空由 createTeamTools 注册的 agent/pre-step 执行器消费（同实例一次，失败回退压缩）。
 *
 * @module dsh-context-relay/agent/team-tools
 */
import { bandFor, buildPhaseBrief, normalizePhase } from '../policy.js';
import { ARCHITECT_NAME } from './protocol.js';
import { clearTeamContextRow, replaceTeamContext } from './team-context.js';
import { derivePhase, derivePhaseMeta, pressureOf, relayStateOf, stateOf } from './derive.js';
import { TOOL_PREFIX, claimRelayOperation, clearPendingArchitect, cwdOf, fail, logInfo, logWarn, lossless, markPendingArchitect, noticeMessage, runDocLint } from './shared.js';
import { formatWorkItemLines, normalizeWorkItemsConfig, readWorkItems, workItemsScopeOf } from './work-items.js';
import { LAST_BAND, teammateState } from './sentinel.js';
import { providerModelOf } from './handoff.js';
import { panelStateOf } from '../panel-store.js';
import { appendChainEntry, workspaceRelativePath } from './chain.js';
import { buildManualRecallSection } from './recall.js';
import { disposeActivation, rememberActivation, takeActivation } from './activations.js';
import { capabilitiesOf, interruptMember, listMembers, roleOf, sendToMember, startMember } from '../team-api.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeResetRange, hasPendingReset, performWipe, scheduleReset, takePendingReset } from './reset.js';
import {
  TEAM_LIMITS,
  TEAM_PROVIDER,
  activeMembersOf,
  appendLedger,
  archiveCheckpoint,
  buildCheckpointMarkdown,
  buildRenewPrompt,
  checkpointPathOf,
  classifyHealth,
  clipText,
  ensureLineage,
  genOf,
  isValidTeammateName,
  lineageDirOf,
  lineageOf,
  nextGenName,
  partitionRelativePath,
  readCheckpoint,
  readLedger,
  readProfile,
  readRoster,
  retireGeneration,
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

function teamStatusSignature(rows, retired = []) {
  // v0.6.1 新字段进签名：phase/条目计数变化也算状态变化，否则 phase 切换后合法查询会被误拒。
  // v0.7.0：退役代变化也算状态变化（否则“旧代消失”后合法查询被误拒）。
  return JSON.stringify([rows.map((row) => [row.name, row.gen, row.status, row.band, row.health, row.checkpoint?.exists === true, row.phase ?? null, row.items?.doing ?? 0, row.items?.blocked ?? 0]), retired]);
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
  return '请先调用 relay_checkpoint 写本轮结构化交接（一行结论/完成/决策/证据/约束/未决/下一步；≤4KB），'
    + '然后回一句「checkpoint 已写」。Lead 会在收到后为你换代（新队友读你的记录接手），不要自行压缩/交接。'
    + '（队友：' + String(name ?? '?') + '）';
}

function relativeHandoff(lineage, gen, leadSessionId) {
  return partitionRelativePath(leadSessionId, lineage, 'handoffs', 'gen-' + gen + '.md');
}

const HEALTH_ACTION = Object.freeze({
  fresh: '可派',
  watch: '做完即 checkpoint',
  stale: '边界 reset 复用（真清空，0 额度）；仅换身份才 renew',
  spent: '先 checkpoint 再 reset 复用（0 额度）；仅换身份才 renew',
  unknown: '读不到',
});

function renderTeamStatus(report, recordsRelative) {
  const lines = ['team=' + report.team.length + ' · running=' + report.active + ' · records=' + recordsRelative + ' · 并发额度=部署配置 maxActiveSubagents（默认 8/root；renew 释放旧代后不占额）'];
  for (const row of report.team) {
    const checkpoint = row.checkpoint.exists ? 'ck:' + row.checkpoint.bytes + 'B' : 'ck:missing';
    lines.push('- ' + row.name + ' · ' + row.status + ' · ' + (row.ratio === undefined ? '?' : Math.round(row.ratio * 1000) / 10 + '%')
      + ' ' + row.band + ' · ' + checkpoint + ' · ' + row.health + ' → ' + (HEALTH_ACTION[row.health] ?? row.action));
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
        chainInfo = appendChainEntry(cwd, {
          kind: 'teammate-freshen', sessionId: caller.session.id, phase,
          note: 'lineage=' + lineage + ' name=' + name + ' gen=' + gen + (reset ? ' reset=true' : '')
            + (fallbackReason === undefined ? '' : ' fallback=' + clipText(fallbackReason, 60)),
          compactionId: compactionInfo.compactionId, shadowedStart: compactionInfo.shadowedStart, shadowedEnd: compactionInfo.shadowedEnd,
          freedTokens: compactionInfo.freedTokens, briefPath: workspaceRelativePath(cwd, briefPath),
        });
        recallSection = '[context-relay] 链式召回：本会话 ' + caller.session.id + ' 压缩遮蔽 seq '
          + (compactionInfo.shadowedStart === undefined ? '未报告' : compactionInfo.shadowedStart + '–' + compactionInfo.shadowedEnd)
          + '；索引 .scratch/context-relay/chain.ndjson；旧内容按 session_event_read({session_id, seq}) 回读。';
        appendFileSync(briefPath, '\n' + recallSection + '\n', 'utf8');
      } catch (error) { logWarn(ctx, '[freshen] chain index failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error)); }
      try {
        appendLedger(cwd, lineage, {
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
        if (manualRecall !== '') appendFileSync(briefPath, '\n' + manualRecall + '\n', 'utf8');
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
        try { appendFileSync(pending.briefPath, resetLine, 'utf8'); } catch { /* brief 文件补写失败不阻断 wipe */ }
        wipe = performWipe(ctx, agent.session, pending.brief + resetLine, { reason: 'relay-reset' });
      } catch (error) {
        wipe = { ok: false, code: 'wipe-append-failed', reason: String(error?.message ?? error) };
      }
      if (wipe?.ok === true) {
        const freedTokens = Number.isFinite(wipe.beforeTokens) && Number.isFinite(wipe.afterTokens)
          ? Math.max(0, wipe.beforeTokens - wipe.afterTokens) : undefined;
        try {
          appendLedger(cwd, pending.lineage, {
            event: 'reset', gen: pending.gen, name: pending.name, sessionId, phase: pending.phase,
            shadowedStart: wipe.startSeq, shadowedEnd: wipe.endSeq, shadowedNodes: wipe.shadowedNodes, freedTokens,
            brief: workspaceRelativePath(cwd, pending.briefPath), checkpoint: workspaceRelativePath(cwd, pending.checkpointPath),
            at: new Date().toISOString(),
          }, pending.leadSessionId);
        } catch (error) { logWarn(ctx, '[reset] ledger append failed: ' + String(error?.message ?? error)); }
        try {
          appendChainEntry(cwd, {
            kind: 'teammate-reset', sessionId, phase: pending.phase,
            note: 'lineage=' + pending.lineage + ' gen=' + pending.gen + ' reset=true',
            shadowedStart: wipe.startSeq, shadowedEnd: wipe.endSeq, freedTokens,
            briefPath: workspaceRelativePath(cwd, pending.briefPath),
          });
        } catch (error) { logWarn(ctx, '[reset] chain index failed: ' + String(error?.message ?? error)); }
        LAST_BAND.set(sessionId, { band: 'ok' });
        logInfo(ctx, '[reset] wiped session=' + sessionId + ' lineage=' + pending.lineage + ' shadowed=' + wipe.shadowedNodes + ' freed=' + String(freedTokens ?? '?'));
        return;
      }
      const reason = String(wipe?.reason ?? wipe?.code ?? 'unknown');
      logWarn(ctx, '[reset] wipe failed session=' + sessionId + ' code=' + String(wipe?.code ?? '?') + ' reason=' + reason + '; falling back to compaction+brief');
      try {
        const engine = ctx.get('compaction');
        if (engine === undefined || typeof engine.compactIfNeeded !== 'function') {
          logWarn(ctx, '[reset] compaction unavailable; fallback brief not injected');
          return;
        }
        const fallback = await compactWithBrief({
          caller: agent, cwd, lineage: pending.lineage, leadSessionId: pending.leadSessionId,
          name: pending.name, gen: pending.gen, phase: pending.phase,
          brief: pending.brief, briefPath: pending.briefPath, engine, signal: payload?.signal,
          reset: true, fallbackReason: reason,
        });
        if (fallback.organized) {
          LAST_BAND.set(sessionId, { band: 'ok' });
        } else {
          try {
            appendLedger(cwd, pending.lineage, {
              event: 'reset-failed', gen: pending.gen, name: pending.name, sessionId, phase: pending.phase,
              reason: clipText(reason, 160), at: new Date().toISOString(),
            }, pending.leadSessionId);
          } catch (error) { logWarn(ctx, '[reset] failed-ledger append failed: ' + String(error?.message ?? error)); }
        }
        logInfo(ctx, '[reset] fallback compaction+brief session=' + sessionId + ' organized=' + String(fallback.organized));
      } catch (error) {
        logWarn(ctx, '[reset] fallback failed session=' + sessionId + ' reason=' + String(error?.message ?? error));
      }
    };
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      const proceed = typeof next === 'function' ? next : async () => {};
      try { await consume(payload); } catch (error) { logWarn(ctx, '[reset] pre-step applier failed: ' + String(error?.message ?? error)); }
      return proceed();
    }), 'dsh-context-relay: pending reset applier');
  }
  installResetApplier();

  /** 队友：写自己的工作记录（≤4KB 结构化交接）。 */
  const checkpoint = {
    name: TOOL_PREFIX + 'checkpoint',
    description: 'Write this teammate\'s durable work record (<=4KB structured handoff) to .scratch/context-relay/team/<leadSessionId>/<lineage>/checkpoint.md + ledger. '
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
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
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
        written = writeCheckpoint(cwd, lineage, built.markdown, leadSessionId);
      } catch (error) {
        return fail('checkpoint-write-failed', String(error?.message ?? error), { summary: 'checkpoint write failed; work can continue but the Lead must not renew without a record.' });
      }
      try { appendLedger(cwd, lineage, { event: 'checkpoint', gen, name: membership.name, sessionId: caller.session?.id, kind: args?.kind ?? 'task', taskId: args?.task_id, oneLine: clipText(args?.one_line, 200), bytes: written.bytes, at: new Date().toISOString() }, leadSessionId); } catch (error) { logWarn(ctx, '[team] ledger append failed: ' + String(error?.message ?? error)); }
      try { writeRoster(cwd, roster, leadSessionId); } catch (error) { logWarn(ctx, '[team] roster write failed: ' + String(error?.message ?? error)); }
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
        text: 'checkpoint 已写入 ' + written.path + '（' + written.bytes + '/' + TEAM_LIMITS.checkpointBytes + 'B）'
          + (built.caps.truncated ? '，超出 caps 的部分已按上限裁剪' : '')
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
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? v?.summary ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_freshen requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'teammate') return fail('teammate-only', 'relay_freshen is teammate-only', { summary: 'refused: only a Team teammate may freshen its own context; the Lead uses relay_organize.' });
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
          try { clearTeamContextRow(cwd, leadSessionId, membership.name); } catch { /* 快照清理失败不影响 reset */ }
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
        try { clearTeamContextRow(cwd, leadSessionId, membership.name); } catch { /* 快照清理失败不影响 freshen */ }
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

  /** Lead：队友保鲜体检。 */
  const status = {
    name: TOOL_PREFIX + 'team_status',
    description: 'Team freshness report for the Lead: one row per teammate (lineage, generation, status, context band, checkpoint presence, health, suggested action) plus the record partition root. '
      + 'Read before assigning new work; stale/spent teammates should checkpoint then reset (true wipe); renew only for an identity/role change. Do not poll: unchanged re-reads are refused. Lead-only.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(_args, exec) {
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
      const members = activeMembersOf(roster, allMembers);
      const retired = allMembers.filter((member) => !members.includes(member)).map((member) => member.name);
      const thresholds = currentThresholds();
      // v0.6.1：phase 边界 triage 的可见性——Lead 当前 phase + 队友名下进行中/阻塞条目数（只读）。
      let ledger;
      try { ledger = readWorkItems(cwd, { pathOverride: workItems.pathOverride, scopeId: workItemsScopeOf(caller.session) }); } catch { ledger = undefined; }
      const leadPhase = ledger?.currentPhase?.phase ?? null;
      const rows = [];
      for (const member of members) {
        const pressure = await teammateState(ctx, member);
        const state = pressure === undefined ? { band: 'unknown' } : bandFor(pressure, thresholds);
        const lineage = lineageOf(member.name);
        const entry = roster.lineages[lineage];
        const known = entry?.generations?.find((item) => item.name === member.name);
        const gen = known !== undefined && Number.isInteger(known.gen) ? known.gen : genOf(member.name);
        let checkpointInfo;
        try { checkpointInfo = readCheckpoint(cwd, lineage, leadSessionId); } catch { checkpointInfo = undefined; }
        const health = classifyHealth(state, checkpointInfo !== undefined);
        rows.push({
          name: member.name,
          lineage,
          gen,
          status: member.status,
          band: state.band,
          ratio: state.ratio,
          checkpoint: { exists: checkpointInfo !== undefined, bytes: checkpointInfo?.bytes, updatedAt: checkpointInfo?.updatedAt },
          health: health.health,
          action: health.action,
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
      const report = {
        ok: true,
        phase: leadPhase,
        team: rows,
        active,
        stale,
        pending,
        retired,
        architect: architectRow === undefined ? { present: false } : { present: true, name: architectRow.name, health: architectRow.health },
        ...(Number.isInteger(listed.deeper) && listed.deeper > 0 ? { deeper: listed.deeper } : {}),
        roster: { teammates: rows.length, retired: retired.length },
        text: '',
      };
      // 去轮询（v0.6.0）：与上次完全相同的团队状态 = 信息没变，直接拒绝；变了才返回全量。
      const signature = teamStatusSignature(rows, retired);
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
      ? '\n建议：先处理 stale/spent：' + stale.join(', ') + '（stale：边界让队友 relay_freshen({reset:true, brief}) 真清空复用（同成员、0 额度）；spent：先 relay_checkpoint 补记录再 reset 复用。仅换身份/角色才 relay_renew；renew 报 member-limit 不要重试：reset 复用，或 phase 边界 relay_handoff 团队重启后按交接单重建）。'
      : '\n建议：全部 fresh/watch，无需换代。')
        + (pending.length > 0
      ? '\n队友上下文待处理：' + pending.join(', ') + '——phase 边界先处理（checkpoint/freshen/reset/renew）并建议用 team_note 记一行（只 warning，不拒绝）；不要轮询本工具。'
      : '')
        + (retired.length > 0
      ? '\n退休代（只审计，不派活/不发消息）：' + retired.slice(0, 8).join(', ') + (retired.length > 8 ? ' 等 ' + retired.length + ' 个' : '')
      : '');
      // v0.6.3：快照落盘（焦点行/phase 闸门共用；写失败不影响报告）。
      try {
        replaceTeamContext(cwd, leadSessionId, { phase: leadPhase, rows: rows.map((row) => ({ name: row.name, band: row.band })) });
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
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_renew requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_renew is Lead-only', { summary: 'refused: only the Team Lead may renew a teammate.' });
      const caps = capabilitiesOf(ctx);
      if (!caps.listMembers || !caps.spawn) return fail('services-unavailable', 'team roster/spawn unavailable (' + caps.kind + ')', { summary: 'refused: team roster or spawn is unavailable; cannot renew.' });
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
      let spawned = await startNext();
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
      if (!spawned.ok) {
        const memberLimit = spawned.code === 'member-limit';
        return fail(memberLimit ? 'member-limit' : 'spawn-failed', spawned.reason, {
          memberLimit,
          next: { name: next.name, gen: next.gen },
          summary: memberLimit
            ? 'member-limit: 子智能体并发额度已满，无法换代（' + next.name + ' 未创建）。不要重试 renew：① 让 ' + member.name + ' relay_checkpoint 后 relay_freshen({reset:true, brief}) 真清空复用（0 额度）；② phase 边界 relay_handoff（团队重启）后按交接单重建小队。'
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
      const archived = (() => { try { return archiveCheckpoint(cwd, lineage, prevGen, leadSessionId); } catch (error) { logWarn(ctx, '[team] archive checkpoint failed: ' + String(error?.message ?? error)); return undefined; } })();
      retireGeneration(entry, member.name, reason === '' ? 'renew' : reason);
      if (newMember !== undefined && newMember !== null) {
        ensureLineage(roster, lineage, { name: next.name, gen: next.gen, sessionId: newMember.id, role: '', description: '' });
      }
      entry.activeGen = next.gen;
      let rosterError;
      try { writeRoster(cwd, roster, leadSessionId); } catch (error) { rosterError = String(error?.message ?? error); logWarn(ctx, '[team] roster write failed after renew: ' + rosterError); }
      const handoffRelative = relativeHandoff(lineage, prevGen, leadSessionId);
      try {
        appendLedger(cwd, lineage, { event: 'renew', gen: prevGen, name: member.name, to: next.name, toGen: next.gen, handoff: handoffRelative, reason, at: new Date().toISOString() }, leadSessionId);
      } catch (error) { logWarn(ctx, '[team] ledger append failed after renew: ' + String(error?.message ?? error)); }
      try { clearTeamContextRow(cwd, leadSessionId, member.name); } catch { /* 快照清理失败不阻断换代 */ }
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
  /** Lead：为一次工程任务创建/复用固定架构师（模型来自面板选择，不设默认）。 */
  const architect = {
    name: TOOL_PREFIX + 'architect',
    description: 'Lead-only (relay-long): start a fresh architect for one engineering task with the model chosen in the composer chip, or continue the current architect. '
      + 'Requires panel.architectModel; if unset, ask the user once instead of inheriting the Lead model. Fresh requires the old generation checkpoint, retires it, and starts a clean context; continue reuses the current generation. '
      + 'Returns the doc path the architect must write (<=8KB, seven sections).',
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
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_architect requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_architect is Lead-only', { summary: 'refused: only the Lead may create/continue the architect.' });
      const panel = panelStateOf(caller.session.id);
      if (panel.architect === false) return fail('architect-disabled', 'architect is disabled in this session panel', { summary: 'refused: the architect chip is off in this session.' });
      const selected = panel.architectModel;
      if (selected === null || selected === undefined || typeof selected.provider !== 'string' || typeof selected.model !== 'string') {
        return fail('architect-model-unselected', 'architectModel is not selected in the session panel', {
          summary: 'refused: choose the architect model in the composer model menu (or ask the user once) before creating the architect; this tool never inherits the Lead model by default.',
          hint: 'Ask the user once: which provider/model (and reasoning effort) should the architect use? The composer model menu stores it (subject to the official subagent model allowlist); handoff inherits it.',
        });
      }
      // v0.7.1：架构师模型必须落在官方子代理白名单内（会话投影；无记录时按官方语义只允许 Lead 当前路由）。
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
      const mode = args?.mode === 'continue' ? 'continue' : 'fresh';
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      const roster = readRoster(cwd, leadSessionId);
      const listed = await listMembers(ctx, caller);
      if (!listed.ok) return fail('team-read-failed', listed.reason, { summary: 'refused: could not list current team members.' });
      const active = activeMembersOf(roster, teammatesOf(listed));
      const existing = active.find((member) => lineageOf(member.name) === ARCHITECT_NAME);
      const taskId = safeTaskId(args?.task_id);
      const docPath = '.scratch/context-relay/architecture/' + taskId + '.md';
      if (mode === 'continue') {
        if (existing === undefined) return fail('architect-missing', 'no active architect to continue', { summary: 'refused: no active architect; use mode=fresh to create one.' });
        const text = '架构师继续任务：' + taskId + '。需求 brief：' + clipText(args?.brief, 2000) + '。交付文档：' + docPath + '（沿用当前上下文；若上下文已脏，回执 Lead 请求 fresh）。';
        const sent = await sendToMember(ctx, caller, existing, [{ type: 'text', text }], { signal: signalOf(exec) });
        if (!sent.ok) return fail('send-failed', sent.reason, { summary: 'refused: could not send the task to the current architect.' });
        return lossless({ ok: true, mode: 'continue', name: existing.name, docPath, model: selected, summary: 'continued architect ' + existing.name + ' (model change requires fresh)', text: '已把任务发给当前架构师 ' + existing.name + '；continue 复用当前代与当前模型，换模型请用 mode:"fresh"。' });
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
        try { archiveCheckpoint(cwd, lineage, prevGen, leadSessionId); } catch (error) { logWarn(ctx, '[architect] archive checkpoint failed: ' + String(error?.message ?? error)); }
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
        '交付：' + docPath + '（≤8KB；七段：需求对齐/技术路线/模块接口/数据协议/风险取舍/待决策/实现步骤与验收）',
        '待决策每条写清：问题/影响/选项+推荐；完成后 relay_checkpoint 并回执 Lead；不自行 freshen/reset，不向用户提问，不改产品代码。',
      ].filter((line) => line !== '').join('\n');
      try { mkdirSync(join(cwd, '.scratch', 'context-relay', 'architecture'), { recursive: true }); } catch { /* 目录创建失败由架构师写文档时暴露 */ }
      // v0.7.1：rc.2 的 agent/created 先于 subagents.resident 登记，团队服务在创建瞬间不可用；
      // spawn 前登记 pending 标记，创建回调用 header.parentSession 认领架构师身份（成功/失败都撤销）。
      markPendingArchitect(leadSessionId);
      let spawned;
      try {
        spawned = await startMember(ctx, caller, {
          name: next.name,
          description: '专职架构师',
          prompt: [{ type: 'text', text: prompt }],
          provider,
          agentOptions: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) },
          signal: signalOf(exec),
        });
      } finally {
        clearPendingArchitect(leadSessionId);
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
      try { writeRoster(cwd, roster, leadSessionId); } catch (error) { rosterError = String(error?.message ?? error); logWarn(ctx, '[architect] roster write failed: ' + rosterError); }
      try { appendLedger(cwd, ARCHITECT_NAME, { event: 'architect-fresh', gen: next.gen, name: next.name, from: prevName, taskId, docPath, at: new Date().toISOString() }, leadSessionId); } catch (error) { logWarn(ctx, '[architect] ledger append failed: ' + String(error?.message ?? error)); }
      return lossless({
        ok: true,
        mode: 'fresh',
        name: next.name,
        gen: next.gen,
        docPath,
        model: selected,
        previous: prevName,
        rosterWrite: rosterError === undefined ? 'ok' : 'failed: ' + rosterError,
        summary: 'started architect ' + next.name + ' for ' + taskId,
        text: '架构师已启动：' + next.name + '（model=' + selected.provider + '/' + selected.model + (selected.reasoningEffort === undefined ? '' : ' · ' + selected.reasoningEffort) + '）。交付文档：' + docPath + '。',
      });
    },
  };

  return { leadTools: [status, renew, architect], teammateTools: [checkpoint, freshen] };
}

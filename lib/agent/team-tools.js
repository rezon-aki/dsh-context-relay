/**
 * dsh-context-relay — 队友保鲜工具（P0/P1）：relay_checkpoint / relay_freshen /
 * relay_team_status / relay_renew / relay_rehydrate。
 *
 * 工具按 agent 角色注册（agent scope，不污染 classic relay）：
 * - 队友：relay_checkpoint（写自己的工作记录）/ relay_freshen（同任务减压 or 真清空 reset）
 * - Lead：relay_team_status（体检）/ relay_renew（归档换代）/ relay_rehydrate（跨会话按记录重建小队）
 * 执行层再次校验身份（Lead-only / 队友-only），与注册面互为纵深。
 *
 * 所有 team 记录 IO 都带本 Team 的 leadSessionId 分区（membership.root.session.id）；
 * reset 的真清空由 createTeamTools 注册的 agent/pre-step 执行器消费（同实例一次，失败回退压缩）。
 *
 * @module dsh-context-relay/agent/team-tools
 */
import { bandFor, buildPhaseBrief, normalizePhase } from '../policy.js';
import { derivePhase, derivePhaseMeta, pressureOf, relayStateOf, stateOf } from './derive.js';
import { TOOL_PREFIX, claimRelayOperation, cwdOf, fail, logInfo, logWarn, lossless, noticeMessage, runDocLint } from './shared.js';
import { LAST_BAND, teammateState } from './sentinel.js';
import { providerModelOf } from './handoff.js';
import { appendChainEntry, workspaceRelativePath } from './chain.js';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeResetRange, hasPendingReset, performWipe, scheduleReset, takePendingReset } from './reset.js';
import {
  LEGACY_PARTITION_ID,
  TEAM_LIMITS,
  TEAM_PROVIDER,
  appendLedger,
  archiveCheckpoint,
  buildCheckpointMarkdown,
  buildRehydratePrompt,
  buildRenewPrompt,
  checkpointPathOf,
  classifyHealth,
  clipText,
  ensureLineage,
  genOf,
  isValidTeammateName,
  lineageDirOf,
  lineageOf,
  listPartitions,
  nextGenName,
  partitionRelativePath,
  planRehydrate,
  readCheckpoint,
  readCheckpointFromRoot,
  readLedger,
  readLedgerFromRoot,
  readProfile,
  readProfileFromRoot,
  readRoster,
  retireGeneration,
  teamBaseOf,
  teamRootOf,
  usedNamesOf,
  writeCheckpoint,
  writeRoster,
} from './team.js';

const TEAM_STATUS_TEXT_MAX = 2000;
/** 同代 freshen（官方压缩）上限：压缩有损，但 freshen 优先于换代（不占成员额度）。reset 真清空不计入。 */
const FRESHEN_LIMIT = 2;
const REHYDRATE_META_FILE = 'rehydrate.json';

function teamsOf(ctx) {
  try { return ctx?.get?.('agentTeams'); } catch { return undefined; }
}

function membershipOf(ctx, caller) {
  const teams = teamsOf(ctx);
  if (teams === undefined || typeof teams.tryMembership !== 'function' || caller === undefined) return undefined;
  try { return teams.tryMembership(caller); } catch { return undefined; }
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

function teammatesOf(teams, caller) {
  const members = teams.listMembers(caller);
  return Array.isArray(members) ? members.filter((member) => member?.role === 'teammate') : [];
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
  const lines = ['team=' + report.team.length + ' · running=' + report.active + ' · records=' + recordsRelative + ' · 成员额度=部署配置（spawn/renew 都永久占额，满后不可再建）'];
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

/** 构建三件套（按角色分组；runtime = { ctx, currentThresholds, provider? }）。 */
export function createTeamTools(runtime) {
  const { ctx, currentThresholds } = runtime;
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
    }
    let briefInjected = false;
    if (organized && typeof caller.inject === 'function') {
      try {
        const label = reset ? 'reset 回退（压缩+brief）' : 'freshen';
        const header = '[context-relay] 队友 ' + label + ' · ' + phase + '（压缩后注入，非用户发言）\n以下关键结论在压缩后继续以此为准；完整 brief 见 ' + briefPath + '：\n';
        const recallTail = recallSection === '' ? '' : '\n\n' + recallSection;
        const truncation = '\n\n[brief truncated: 完整内容见 ' + briefPath + ']';
        const maxChars = 4000;
        const base = header + brief;
        const text = base.length + recallTail.length <= maxChars ? base + recallTail : base.slice(0, Math.max(0, maxChars - recallTail.length - truncation.length)) + truncation + recallTail;
        caller.inject(noticeMessage(text, '[context-relay] 队友 ' + label + ' · ' + phase + ' · 压缩后注入（非用户发言）'));
        briefInjected = true;
      } catch (error) { logWarn(ctx, '[freshen] inject failed session=' + caller.session.id + ' reason=' + String(error?.message ?? error)); }
    }
    return { organized, compactionInfo, chainInfo, recallSection, briefInjected, freedTokens: result?.shadowedTokenCount };
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
      return lossless({
        ok: true,
        path: written.path,
        bytes: written.bytes,
        caps: { limitBytes: TEAM_LIMITS.checkpointBytes, items: built.caps.items, truncated: built.caps.truncated },
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
        key_docs: { type: 'array', items: { type: 'string' }, description: 'Docs to open first (<=8).' },
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
        logInfo(ctx, '[freshen] ok session=' + caller.session.id + ' lineage=' + lineage + ' freed=' + String(freed ?? '?') + ' band=' + state.band + '→' + afterState.band + ' briefInjected=' + compacted.briefInjected);
        return lossless({
          ok: true, organized: compacted.organized, band: state.band, afterBand: afterState.band,
          before: { used: before.used, ratio: before.ratio }, after: { used: after.used, ratio: after.ratio },
          freedTokens: freed, briefPath, briefInjected: compacted.briefInjected,
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
      + 'Read before assigning new work; stale/spent teammates should checkpoint then reset (true wipe); renew only for an identity/role change. Lead-only.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(_args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_team_status requires a calling agent');
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_team_status is Lead-only', { summary: 'refused: only the Team Lead may read the team freshness report.' });
      const teams = teamsOf(ctx);
      if (teams === undefined || typeof teams.listMembers !== 'function') return fail('services-unavailable', 'agentTeams unavailable', { summary: 'refused: Agent Teams service unavailable; no team report.' });
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      const roster = readRoster(cwd, leadSessionId);
      let members;
      try { members = teammatesOf(teams, caller); } catch (error) { return fail('team-read-failed', String(error?.message ?? error), { summary: 'refused: could not list team members.' }); }
      const thresholds = currentThresholds();
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
        });
      }
      const active = rows.filter((row) => row.status === 'running').length;
      const stale = rows.filter((row) => row.health === 'stale' || row.health === 'spent').map((row) => row.name);
      const report = { ok: true, team: rows, active, stale, roster: { teammates: rows.length }, text: '' };
      report.text = renderTeamStatus(report, partitionRelativePath(leadSessionId) + '/')
        + (stale.length > 0
      ? '\n建议：先处理 stale/spent：' + stale.join(', ') + '（stale：边界让队友 relay_freshen({reset:true, brief}) 真清空复用（同成员、0 额度）；spent：先 relay_checkpoint 补记录再 reset 复用。仅换身份/角色才 relay_renew；renew 报 member-limit 不要重试：reset 复用，或 phase 边界 relay_handoff 团队重启后 relay_rehydrate 按记录重建小队）。'
      : '\n建议：全部 fresh/watch，无需换代。');
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
      const teams = teamsOf(ctx);
      if (teams === undefined || typeof teams.listMembers !== 'function' || typeof teams.spawnTeammate !== 'function') return fail('services-unavailable', 'agentTeams unavailable', { summary: 'refused: Agent Teams service unavailable; cannot renew.' });
      const target = String(args?.name ?? '').trim();
      if (target === '') return fail('invalid-name', 'name required', { summary: 'refused: name required (exact teammate name).' });
      let members;
      try { members = teammatesOf(teams, caller); } catch (error) { return fail('team-read-failed', String(error?.message ?? error), { summary: 'refused: could not list team members.' }); }
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
        try {
          await teams.sendMessage(caller, { target: member.name, content: [{ type: 'text', text: checkpointRequestText(member.name) }], signal: signalOf(exec) });
          requested = true;
        } catch (error) { logWarn(ctx, '[team] checkpoint request failed: ' + String(error?.message ?? error)); }
        return fail('checkpoint-missing', 'no checkpoint for ' + member.name + '; requested=' + String(requested), {
          requested,
          summary: 'refused: no checkpoint yet — ' + (requested ? 'asked ' + member.name + ' to call relay_checkpoint; retry relay_renew after it replies' : 'ask the teammate to call relay_checkpoint first, then retry'),
        });
      }
      const used = members.map((item) => item.name).concat(usedNamesOf(entry));
      const existing = entry.generations.filter((item) => item.name === member.name).map((item) => item.gen);
      const highest = Math.max(prevGen, ...(existing.length > 0 ? existing : [prevGen]), ...entry.generations.map((item) => item.gen));
      const next = nextGenName(lineage, used, highest);
      if (!isValidTeammateName(next.name)) return fail('invalid-name', 'next generation name invalid: ' + next.name, { summary: 'refused: derived name ' + next.name + ' is not lower-kebab-case (<=64 chars).' });
      const reason = clipText(args?.reason ?? '', 200);
      if (member.status === 'running') {
        try { teams.interrupt(caller, member.name); logInfo(ctx, '[team] interrupted running teammate before renew: ' + member.name); } catch (error) { logWarn(ctx, '[team] interrupt failed before renew: ' + String(error?.message ?? error)); }
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
      let spawned;
      try {
        spawned = await teams.spawnTeammate(caller, {
          name: next.name,
          description: clipText(member.description ?? ('队友 ' + lineage + ' 第 ' + next.gen + ' 代'), 200),
          prompt: [{ type: 'text', text: prompt }],
          context: 'fresh',
          provider,
          signal: signalOf(exec),
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        const memberLimit = /TEAM_MEMBER_LIMIT|member limit/i.test(message);
        return fail(memberLimit ? 'member-limit' : 'spawn-failed', message, {
          memberLimit,
          next: { name: next.name, gen: next.gen },
          summary: memberLimit
            ? 'member-limit: 成员额度已满，无法换代（' + next.name + ' 未创建，旧代原样保留）。不要重试 renew：① 让 ' + member.name + ' relay_checkpoint 后 relay_freshen({reset:true, brief}) 真清空复用（0 额度）；② phase 边界 relay_handoff（团队重启）后 relay_rehydrate 按记录重建小队。'
            : 'refused/failed: could not spawn ' + next.name + '; old generation left as-is. Check provider availability.',
        });
      }
      const newMember = spawned?.member;
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
          + (archived === undefined ? '（checkpoint 固化失败：' + '检查记录目录权限' + '）' : '交接已固化：' + handoffRelative)
          + (rosterError === undefined ? '' : '；roster 写盘失败：' + rosterError),
      });
    },
  };

  /** Lead：跨会话 rehydrate——按旧分区记录在新 Team（新 Lead 会话）重建小队。 */
  const rehydrate = {
    name: TOOL_PREFIX + 'rehydrate',
    description: 'Rebuild the team in this Lead session from another record partition (cross-session continuity after a team restart). '
      + 'apply:false returns the plan (default latest non-current partition, or from=<partition id>). apply:true spawns missing lineages from profile/checkpoint/ledger and reuses existing same-name teammates; '
      + 'spawn failures are reported per lineage and never leave a half-written roster. Lead-only.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Source partition id (Lead session id of the previous team, or "legacy"); default = latest updated non-current partition.' },
        apply: { type: 'boolean', description: 'false/omitted = plan only; true = spawn/reuse members from the source records.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v?.text ?? JSON.stringify(v) }] },
    async execute(args, exec) {
      const caller = exec?.agent;
      if (caller === undefined) throw new Error('relay_rehydrate requires a calling agent');
      const teams = teamsOf(ctx);
      if (teams === undefined || typeof teams.tryMembership !== 'function') return fail('services-unavailable', 'agentTeams unavailable', { summary: 'refused: Agent Teams service unavailable; cannot rehydrate.' });
      const membership = membershipOf(ctx, caller);
      if (membership === undefined || membership.role !== 'lead') return fail('lead-only', 'relay_rehydrate is Lead-only', { summary: 'refused: only the Team Lead may rehydrate a team.' });
      const leadSessionId = leadSessionIdOf(membership);
      const cwd = cwdOf(caller.session);
      let plan;
      try { plan = planRehydrate(cwd, { from: args?.from, currentSessionId: leadSessionId }); } catch (error) { return fail('plan-failed', String(error?.message ?? error), { summary: 'refused: could not scan record partitions.' }); }
      if (plan.ok !== true) return fail(plan.code, plan.reason, { summary: 'refused: ' + plan.reason });
      const planText = 'rehydrate 计划：from=' + plan.from + (plan.defaultFrom ? '（未指定 from：默认取最新非当前分区，并行 Lead 会话请显式传 from 复核）' : '') + '；lineages=' + plan.lineages.length
        + (plan.lineages.length === 0 ? '' : '（' + plan.lineages.map((item) => item.lineage + ':' + item.action).join(', ') + '）')
        + '；spawn=' + plan.spawnCount
        + (plan.warnings.length === 0 ? '' : '；warnings=' + plan.warnings.join('；'))
        + '。apply:true 执行重建（新成员占新 Team 配额）。';
      if (args?.apply !== true) return lossless({ ok: true, mode: 'plan', ...plan, text: planText });
      if (typeof teams.listMembers !== 'function' || typeof teams.spawnTeammate !== 'function' || typeof teams.sendMessage !== 'function') {
        return fail('services-unavailable', 'agentTeams spawn/list/send unavailable', { summary: 'refused: Agent Teams service cannot list or spawn members; cannot apply.' });
      }
      let sourceRoot;
      try {
        sourceRoot = plan.from === LEGACY_PARTITION_ID ? teamBaseOf(cwd) : listPartitions(cwd).find((part) => part.id === plan.from)?.root;
      } catch (error) { return fail('plan-failed', String(error?.message ?? error), { summary: 'refused: could not resolve the source partition.' }); }
      if (sourceRoot === undefined) return fail('partition-not-found', 'source partition disappeared: ' + plan.from, { summary: 'refused: source partition disappeared during apply.' });
      let members;
      try { members = teams.listMembers(caller); } catch (error) { return fail('team-read-failed', String(error?.message ?? error), { summary: 'refused: could not list current team members.' }); }
      const knownNames = new Set((Array.isArray(members) ? members : []).map((member) => member?.name).filter((name) => typeof name === 'string'));
      const signal = signalOf(exec);
      let roster = readRoster(cwd, leadSessionId);
      const spawned = [];
      const reused = [];
      const skipped = [];
      const failed = [];
      for (const item of plan.lineages) {
        if (item.action === 'skip') {
          skipped.push({ lineage: item.lineage, reason: item.reason ?? 'no-record' });
          continue;
        }
        const name = item.proposedName;
        if (knownNames.has(name)) {
          const existing = (Array.isArray(members) ? members : []).find((member) => member?.name === name);
          const recordDir = partitionRelativePath(plan.from, item.lineage);
          const text = '跨会话 rehydrate：沿用已有队友 ' + name + '（记录分区 ' + recordDir + '/，源会话 ' + plan.from + '）。先核验一个事实、等 Lead 派活；需要旧细节用 session_event_read({session_id: ' + plan.from + ', seq})，不引用旧对话。';
          try {
            await teams.sendMessage(caller, { target: name, content: [{ type: 'text', text }], signal });
            reused.push({ lineage: item.lineage, name, sessionId: existing?.id });
          } catch (error) {
            failed.push({ lineage: item.lineage, name, code: 'reuse-failed', error: String(error?.message ?? error) });
          }
          continue;
        }
        const profile = readProfileFromRoot(sourceRoot, item.lineage);
        const checkpoint = readCheckpointFromRoot(sourceRoot, item.lineage);
        const ledger = readLedgerFromRoot(sourceRoot, item.lineage, 10);
        const prompt = buildRehydratePrompt({
          lineage: item.lineage, name, gen: item.gen, profile,
          checkpoint: checkpoint?.text, ledger, fromSessionId: plan.from,
        });
        const description = clipText(item.profileRole !== '' ? item.profileRole : ('rehydrate 自 ' + plan.from + ' · ' + item.lineage), 200);
        let result;
        try {
          result = await teams.spawnTeammate(caller, {
            name, description, prompt: [{ type: 'text', text: prompt }],
            context: 'fresh', provider, signal,
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          const code = /TEAM_MEMBER_LIMIT|member limit/i.test(message) ? 'member-limit' : 'spawn-failed';
          failed.push({ lineage: item.lineage, name, code, error: message });
          continue;
        }
        const memberId = result?.member?.id;
        const record = { lineage: item.lineage, name, action: 'spawn', sessionId: memberId };
        try {
          ensureLineage(roster, item.lineage, { name, gen: item.gen, sessionId: memberId, role: item.profileRole, description });
          writeRoster(cwd, roster, leadSessionId);
        } catch (error) {
          logWarn(ctx, '[rehydrate] roster write failed lineage=' + item.lineage + ' reason=' + String(error?.message ?? error));
        }
        try {
          appendLedger(cwd, item.lineage, {
            event: 'rehydrate', from: plan.from, gen: item.gen, name, sessionId: memberId,
            checkpoint: checkpoint === undefined ? undefined : workspaceRelativePath(cwd, checkpoint.path),
            at: new Date().toISOString(),
          }, leadSessionId);
        } catch (error) { logWarn(ctx, '[rehydrate] ledger append failed lineage=' + item.lineage + ' reason=' + String(error?.message ?? error)); }
        knownNames.add(name);
        spawned.push(record);
      }
      const metaRelative = partitionRelativePath(leadSessionId, REHYDRATE_META_FILE);
      const metaPath = join(teamRootOf(cwd, leadSessionId), REHYDRATE_META_FILE);
      let previousFrom;
      try { previousFrom = JSON.parse(readFileSync(metaPath, 'utf8'))?.from; } catch { previousFrom = undefined; }
      const mappings = [
        ...spawned.map((item) => ({ lineage: item.lineage, name: item.name, action: 'spawn', sessionId: item.sessionId })),
        ...reused.map((item) => ({ lineage: item.lineage, name: item.name, action: 'reuse', sessionId: item.sessionId })),
        ...skipped.map((item) => ({ lineage: item.lineage, name: undefined, action: 'skip' })),
        ...failed.map((item) => ({ lineage: item.lineage, name: item.name, action: 'failed' })),
      ];
      let metaWritten = true;
      try {
        mkdirSync(teamRootOf(cwd, leadSessionId), { recursive: true });
        writeFileSync(metaPath, JSON.stringify({ version: 1, from: plan.from, at: new Date().toISOString(), mappings }, null, 2), 'utf8');
      } catch (error) {
        metaWritten = false;
        logWarn(ctx, '[rehydrate] metadata write failed: ' + String(error?.message ?? error));
      }
      const repeat = previousFrom === plan.from
        ? '注意：' + metaRelative + ' 已存在且 from 相同——可重复执行，但幂等性有限（同名成员会走 reuse）。'
        : '';
      const text = 'rehydrate 完成：from=' + plan.from + ' · spawned=' + spawned.length + ' · reused=' + reused.length
        + ' · skipped=' + skipped.length + ' · failed=' + failed.length
        + (failed.length === 0 ? '' : '（失败：' + failed.map((item) => item.lineage + ':' + item.code).join(', ') + '）')
        + (metaWritten ? '；元数据 ' + metaRelative : '；元数据写盘失败')
        + '。' + (repeat === '' ? '新成员会先核验事实再等活。' : repeat);
      logInfo(ctx, '[rehydrate] apply from=' + plan.from + ' spawned=' + spawned.length + ' reused=' + reused.length + ' failed=' + failed.length);
      return lossless({
        ok: true, mode: 'apply', from: plan.from,
        spawned, reused, skipped, failed,
        roster: spawned.length === 0 ? 'unchanged' : 'updated',
        text,
      });
    },
  };

  return { leadTools: [status, renew, rehydrate], teammateTools: [checkpoint, freshen] };
}

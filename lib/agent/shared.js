/**
 * dsh-context-relay — agent 面共享小工具（日志/失败契约/容量上限/notice/workspace 写盘/身份判定）。
 *
 * @module dsh-context-relay/agent/shared
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { docLint, docLintEvidence, formatDocLint } from '../lint.js';

/** 模块级 Map 容量上限（P2#4：长期宿主进程防泄漏；超出删最早插入项）。 */
const MEMORY_CAP = 500;
/** 同一会话并发的 relay 操作（P2#5，organize/handoff 串行化）：sessionId → true。 */
export const INFLIGHT = new Map();

export const TOOL_PREFIX = 'relay_';

export function cwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/** 工具输出必须是 lossless JSON：undefined 字段会污染输出，统一走一次 JSON 往返。 */
export function lossless(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Map 容量上限：超出删最早插入项（P2#4；各处复用，避免重复实现）。 */
export function capMap(map, limit = MEMORY_CAP) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

/** 可观测性（P2#13）：logger 缺失或抛错都不得影响工具/哨兵主流程。 */
export function logAt(ctx, level, message) {
  try { ctx?.logger?.[level]?.(message); } catch { /* 日志失败不阻断主流程 */ }
}
export function logInfo(ctx, message) {
  logAt(ctx, 'info', message);
}
export function logWarn(ctx, message) {
  logAt(ctx, 'warn', message);
}

/** 统一失败契约（P2#9）：{ok:false, code, error, ...extra}；summary 给模型读降级信息。 */
export function fail(code, message, extra = {}) {
  return lossless({ ok: false, code, error: message, ...extra });
}

/** P2#5 串行化：返回 release 函数；undefined 表示同一会话已有 relay 操作在途。 */
export function claimRelayOperation(session) {
  const id = session?.id;
  if (id === undefined || id === null) return () => {};
  if (INFLIGHT.has(id)) return undefined;
  INFLIGHT.set(id, true);
  return () => {
    INFLIGHT.delete(id);
  };
}


/** 工具结果消息/内容块里的首个文本（organize 成功判据依赖它；非文本结果返回空串）。 */
export function contentText(blocks) {
  const block = Array.isArray(blocks) ? blocks.find((item) => item?.type === 'text') : undefined;
  return typeof block?.text === 'string' ? block.text : '';
}

/**
 * 会话身份：subagent 子会话（队友）。运行时类型见 dsh-session SessionHeader：
 * `origin?: 'subagent'` 由 dsh-subagent 的 childSessionMeta 写入，`delegationDepth > 0`
 * 是同一事实的持久化兜底。`header.parentSession` 是 fork 血缘（普通 fork 也会带），不用于判定。
 */
export function isSubagentSession(session) {
  const header = session?.header;
  if (header === undefined || header === null) return false;
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

/**
 * 队友身份（完整判定，2026-11-01 审查修复）：subagent header 之外，Agent Teams 成员会话
 * （dsh-experimental-agent-team 的 spawn_teammate）不一定带 origin=subagent header——
 * 再查 agentTeams.tryMembership(caller).role。无团队服务时退化为 header 判定。
 * 用途：ship 验收声明 / relay_organize / relay_handoff 的 lead-only 硬门。
 */
export function isTeammateSession(ctx, caller) {
  if (isSubagentSession(caller?.session)) return true;
  try {
    const teams = ctx?.get?.('agentTeams');
    if (teams !== undefined && typeof teams.tryMembership === 'function') return teams.tryMembership(caller)?.role === 'teammate';
  } catch { /* 团队服务异常按非队友处理（header 判定已覆盖 subagent） */ }
  return false;
}

export function writeWorkspaceFile(cwd, name, content) {
  const root = join(cwd, '.scratch', 'context-relay');
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** 安全跑 doc_lint：失败也写明原因（不静默当 ok），输出有界。 */
export function runDocLint(cwd, paths, maxBytes = 1024) {
  try {
    const result = docLint({ workspaceRoot: cwd, paths });
    return { ok: result.ok, level: result.level, summary: formatDocLint(result, maxBytes), evidence: docLintEvidence(result) };
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 120);
    return { ok: false, level: 'ERROR', summary: 'doc_lint: unavailable (' + reason + ')', evidence: 'doc_lint: unavailable (' + reason + ')' };
  }
}

export function handoffTitle(goal) {
  const text = String(goal ?? '').replace(/\s+/g, ' ').trim();
  return 'Relay · ' + (text.length > 36 ? text.slice(0, 36) + '…' : text || 'handoff');
}

export function userMessage(text) {
  return { role: 'user', id: randomUUID(), content: [{ type: 'text', text: String(text) }], source: { kind: 'user' } };
}

/**
 * 插件 notice（非用户发言）：source.kind 用 producer-owned kind（V4 准入拒绝已退役的
 * kind:'plugin'，见 dsh-session-format-v3-to-v4 的 assertV4RowAdmission）；
 * form:'notice' + summary ≤120 字符（CONTEXT_SUMMARY_MAX_CHARS）。哨兵/phase brief 注入共用。
 */
export function noticeMessage(text, summary) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'dsh-context-relay', form: 'notice', summary: String(summary).slice(0, 120) },
  };
}

/** 清理模块级内存（插件卸载/测试）。 */
export function clearSharedMemory() {
  INFLIGHT.clear();
}

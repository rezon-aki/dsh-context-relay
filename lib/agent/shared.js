/**
 * dsh-context-relay — agent 面共享小工具（日志/失败契约/容量上限/notice/workspace 写盘/身份判定）。
 *
 * @module dsh-context-relay/agent/shared
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { docLint, docLintEvidence, formatDocLint } from '../lint.js';
import { panelStateOf } from '../panel-store.js';
import { currentSettings } from '../policy.js';
import { roleOf } from '../team-api.js';
import { assertNoCredentials, storagePath, workspaceStore } from '../storage.js';
import { docsHashOf } from '../risk.js';

/** 模块级 Map 容量上限（P2#4：长期宿主进程防泄漏；超出删最早插入项）。 */
const MEMORY_CAP = 500;
/** 同一会话并发的 relay 操作（P2#5，organize/handoff 串行化）：sessionId → true。 */
export const INFLIGHT = new Map();
/**
 * v0.7.1：待创建架构师的父会话（relay_architect 在 spawn **之前**登记，agent/created 用
 * child.header.parentSession 匹配并消费）。rc.2 的 agent/created 早于 subagents 的 resident
 * 登记，此时 rootOf/namesOf 一定抛 UNAUTHORIZED，不能靠团队服务识别身份；spawn 前登记的
 * pending 标记是创建瞬间唯一可用的身份线索。TTL 60s，spawn 失败立即撤销。
 */
const PENDING_ARCHITECTS = new Map();
export function markPendingArchitect(parentSessionId) {
  if (typeof parentSessionId === 'string' && parentSessionId !== '') PENDING_ARCHITECTS.set(parentSessionId, Date.now());
}
export function clearPendingArchitect(parentSessionId) {
  if (typeof parentSessionId === 'string') PENDING_ARCHITECTS.delete(parentSessionId);
}
/** 消费标记；过期（>60s）视为失败残留，返回 false。 */
export function consumePendingArchitect(parentSessionId) {
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return false;
  const at = PENDING_ARCHITECTS.get(parentSessionId);
  if (at === undefined) return false;
  PENDING_ARCHITECTS.delete(parentSessionId);
  return Date.now() - at <= 60000;
}

/**
 * v0.10.0：「预算无上限」继承登记（父会话 id → {enabled, at}）。spawn 前登记父会话生效值，
 * agent/created 用 child.header.parentSession 匹配并写入子会话面板；与 PENDING_ARCHITECTS 同窗口
 * （TTL 60s，spawn 结束即撤销，成功/失败都清）。
 */
const PENDING_BUDGET_INHERIT = new Map();
export function markPendingBudgetInherit(parentSessionId, enabled) {
  if (typeof parentSessionId === 'string' && parentSessionId !== '') PENDING_BUDGET_INHERIT.set(parentSessionId, { enabled: enabled === true, at: Date.now() });
}
export function clearPendingBudgetInherit(parentSessionId) {
  if (typeof parentSessionId === 'string') PENDING_BUDGET_INHERIT.delete(parentSessionId);
}
/** 消费标记：返回登记的 enabled；无标记/过期（>60s）→ undefined。 */
export function consumePendingBudgetInherit(parentSessionId) {
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return undefined;
  const entry = PENDING_BUDGET_INHERIT.get(parentSessionId);
  if (entry === undefined) return undefined;
  PENDING_BUDGET_INHERIT.delete(parentSessionId);
  return Date.now() - entry.at <= 60000 ? entry.enabled : undefined;
}

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
 * 顶层会话判定：只看 subagent 事实（origin/delegationDepth），不看 parentSession。
 * parentSession 是 fork 血缘，普通 fork 是独立子智能体树的根，不能当子代理处理。
 */
export function isRootSession(session) {
  return !isSubagentSession(session);
}

/**
 * 队友身份（完整判定，2026-11-01 审查修复）：subagent header 之外，团队服务里的成员会话
 * 不一定带 origin=subagent header——再查团队适配层的 role。无团队服务时退化为 header 判定。
 * 用途：ship 验收声明 / relay_organize / relay_handoff 的 lead-only 硬门。
 */
export function isTeammateSession(ctx, caller) {
  if (isSubagentSession(caller?.session)) return true;
  return roleOf(ctx, caller)?.role === 'teammate';
}

/** 会话生效的「预算无上限」：本会话 panel 显式值优先，否则跟随进程级设置默认。 */
export function effectiveUnlimitedBudgetOf(sessionId, settingsOf = currentSettings) {
  const panelValue = sessionId === undefined || sessionId === null ? null : panelStateOf(sessionId).unlimitedBudget;
  if (panelValue === true || panelValue === false) return panelValue;
  return settingsOf().unlimitedBudget !== false;
}


// 凭据检测/路径守卫已迁入 lib/storage.js（C5 单一持久化层）；这里保留再导出，供仍用同步
// 路径守卫/凭据检测的调用方（delegation-tools 等）复用。写盘一律走异步 workspaceStore 门面。
export { assertNoCredentials, storagePath };

/** 原子覆盖记录目录内文件（异步门面：路径守卫 + 凭据检测 + temp+fsync+rename；M-20 不阻塞事件循环）。 */
export async function writeWorkspaceFile(cwd, target, content) {
  return workspaceStore(cwd).writeAtomic(target, content);
}

/** 记录目录内加锁追加（brief 的链式召回段等后置追加：读旧 + 原子替换，跨进程互斥）。 */
export async function appendWorkspaceFile(cwd, target, text) {
  const store = workspaceStore(cwd);
  const path = store.path(target);
  return store.withFileLock(path, () => store.replace(path, (store.readText(path) ?? '') + text));
}

/** doc_lint 昂贵检查的 docsHash 缓存（relay-audit §2.5.4）：同 hash 10 分钟内跳过；T0 只跑廉价检查。 */
const LINT_CACHE = new Map();
const LINT_CACHE_TTL_MS = 10 * 60 * 1000;
function lintDocsHash(cwd) {
  const entries = [];
  for (const target of [join(cwd, 'AGENTS.md'), join(cwd, '.scratch', 'context-relay')]) {
    try {
      const stat = statSync(target);
      entries.push({ path: target, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* 缺文件不影响哈希 */ }
  }
  return docsHashOf(entries, 'governance-v1');
}

/** 安全跑 doc_lint：失败也写明原因（不静默当 ok），输出有界；T0 只跑廉价检查，昂贵检查按 docsHash 去重。 */
export function runDocLint(cwd, paths, maxBytes = 1024, extra = { sessionDocs: true }) {
  try {
    const riskTier = extra?.riskTier;
    const cheapOnly = riskTier === 'T0';
    const docsHash = lintDocsHash(cwd);
    if (!cheapOnly && extra?.sessionDocs !== false) {
      const cached = LINT_CACHE.get(docsHash);
      if (cached !== undefined && Date.now() - cached.at < LINT_CACHE_TTL_MS) {
        return { ...cached.result, docsHash, cached: true };
      }
    }
    const result = docLint({
      workspaceRoot: cwd,
      paths,
      ...extra,
      sessionDocs: cheapOnly ? false : extra?.sessionDocs === true,
      cheapOnly,
    });
    const out = { ok: result.ok, level: result.level, summary: formatDocLint(result, maxBytes), evidence: docLintEvidence(result) };
    if (!cheapOnly) {
      LINT_CACHE.set(docsHash, { at: Date.now(), result: out });
      if (LINT_CACHE.size > MEMORY_CAP) LINT_CACHE.delete(LINT_CACHE.keys().next().value);
    }
    return { ...out, docsHash, ...(cheapOnly ? { cheap: true } : {}) };
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
  PENDING_ARCHITECTS.clear();
  PENDING_BUDGET_INHERIT.clear();
}

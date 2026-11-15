/**
 * dsh-context-relay — agent 面共享小工具（日志/失败契约/容量上限/notice/workspace 写盘/身份判定）。
 *
 * @module dsh-context-relay/agent/shared
 */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { docLint, docLintEvidence, formatDocLint } from '../lint.js';
import { roleOf } from '../team-api.js';

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


/** Credentials are rejected before any persistent write; errors never include the value. */
export function assertNoCredentials(content) {
  const text = String(content).replace(/\\["']/g, '"');
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(text)
    || /["']?\b(?:[a-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|private[_-]?key)|key)["']?\s*[:=]\s*["']?(?!null\b|false\b|true\b|\[REDACTED\])[^\s"',;}{]{4,}/i.test(text)) {
    throw new Error('relay storage: credential-like content rejected (value omitted)');
  }
}

/** Resolve each parent before creating descendants; reject traversal and all symlink hops. */
export function storagePath(cwd, target) {
  const base = resolve(cwd);
  const path = resolve(target);
  const rel = relative(base, path);
  const relay = relative(join(base, '.scratch', 'context-relay'), path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)
    || isAbsolute(relay) || relay === '..' || relay.startsWith('..' + sep)) throw new Error('relay storage: path outside workspace record directory');
  const realBase = realpathSync(base);
  let current = base;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (i < parts.length - 1) {
        try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = lstatSync(current);
      }
    }
    if (stat?.isSymbolicLink()) throw new Error('relay storage: symbolic link path rejected');
    if (stat) {
      let actual;
      try { actual = relative(realBase, realpathSync(current)); } catch (error) {
        // A contender can observe a lock just before its owner unlinks it. Only the
        // final component may become absent; revalidate its parent before creation.
        if (error.code !== 'ENOENT' || i !== parts.length - 1) throw error;
        actual = relative(realBase, realpathSync(dirname(current)));
      }
      if (isAbsolute(actual) || actual === '..' || actual.startsWith('..' + sep)) throw new Error('relay storage: resolved path outside workspace');
    }
  }
  return path;
}

function removeIfPresent(path) {
  try {
    unlinkSync(path);
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** A live owner is never stolen; dead/malformed locks expire after staleMs. */
export function withStorageLock(cwd, target, action, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const path = storagePath(cwd, target);
  const lock = storagePath(cwd, path + '.lock');
  const deadline = Date.now() + timeoutMs;
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      let old;
      try {
        old = lstatSync(lock);
        if (old.isSymbolicLink()) throw new Error('relay storage: symbolic link lock rejected');
        if (Date.now() - old.mtimeMs > staleMs) {
          let owner;
          try { owner = JSON.parse(readFileSync(lock, 'utf8')).pid; } catch { /* incomplete dead owner */ }
          if (!Number.isInteger(owner) || owner <= 0) stale = true;
          else try { process.kill(owner, 0); } catch (error) { stale = error.code === 'ESRCH'; }
        }
        if (stale) {
          const current = lstatSync(lock);
          if (current.ino === old.ino && current.dev === old.dev) removeIfPresent(lock);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error('relay storage: file lock timeout; retry operation');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const owner = fstatSync(fd);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fsyncSync(fd);
    // Temp files from a killed owner are never authoritative; retain the last renamed file.
    for (const name of readdirSync(dirname(path))) if (name.startsWith(path.slice(dirname(path).length + 1) + '.tmp-') || name.startsWith(path.slice(dirname(path).length + 1) + '.pending.tmp-')) removeIfPresent(storagePath(cwd, join(dirname(path), name)));
    return action();
  } finally {
    closeSync(fd);
    try { const current = lstatSync(lock); if (current.ino === owner.ino && current.dev === owner.dev) removeIfPresent(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Caller holds the file/transaction lock. Replace is durable and never exposes partial content. */
export function atomicStorageReplace(cwd, target, content) {
  assertNoCredentials(content);
  const path = storagePath(cwd, target);
  for (const name of readdirSync(dirname(path))) if (name.startsWith(path.slice(dirname(path).length + 1) + '.tmp-')) removeIfPresent(storagePath(cwd, join(dirname(path), name)));
  const tmp = storagePath(cwd, path + '.tmp-' + process.pid + '-' + randomUUID());
  let fd;
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const data = Buffer.from(String(content));
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    storagePath(cwd, path);
    renameSync(tmp, path);
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeIfPresent(tmp);
  }
  return path;
}

/** O_APPEND, one syscall per complete NDJSON line, fsynced before returning. Caller holds lock. */
export function appendStorageLine(cwd, target, line) {
  assertNoCredentials(line);
  if (!line.endsWith('\n') || line.slice(0, -1).includes('\n')) throw new Error('relay storage: expected one complete NDJSON line');
  const fd = openSync(storagePath(cwd, target), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const size = fstatSync(fd).size;
  try {
    const data = Buffer.from(line);
    if (writeSync(fd, data) !== data.length) throw new Error('relay storage: incomplete append; retry operation');
    fsyncSync(fd);
  } catch (error) { ftruncateSync(fd, size); fsyncSync(fd); throw error; }
  finally { closeSync(fd); }
}

/** Redo journal: idempotent archive/live replacements survive a crash between renames. */
export function recoverStorageTransaction(cwd, target) {
  const journal = storagePath(cwd, target + '.pending');
  let writes;
  try { writes = JSON.parse(readFileSync(journal, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const item of writes) { storagePath(cwd, item.path); assertNoCredentials(item.content); }
  for (const item of writes) atomicStorageReplace(cwd, item.path, item.content);
  removeIfPresent(journal);
}
export function storageTransaction(cwd, target, writes) {
  for (const item of writes) { storagePath(cwd, item.path); assertNoCredentials(item.content); }
  atomicStorageReplace(cwd, target + '.pending', JSON.stringify(writes));
  recoverStorageTransaction(cwd, target);
}

export function writeStorageFile(cwd, path, content, options = {}) {
  assertNoCredentials(content);
  return withStorageLock(cwd, path, () => {
    if (Object.hasOwn(options, 'expected')) {
      let current;
      try { current = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== options.expected) throw new Error('relay storage: revision conflict; reload before retry');
    }
    return atomicStorageReplace(cwd, path, content);
  });
}

export function writeWorkspaceFile(cwd, name, content) {
  return writeStorageFile(cwd, join(cwd, '.scratch', 'context-relay', name), content);
}

/** 安全跑 doc_lint：失败也写明原因（不静默当 ok），输出有界。 */
export function runDocLint(cwd, paths, maxBytes = 1024, extra = { sessionDocs: true }) {
  try {
    const result = docLint({ workspaceRoot: cwd, paths, ...extra });
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
  PENDING_ARCHITECTS.clear();
}

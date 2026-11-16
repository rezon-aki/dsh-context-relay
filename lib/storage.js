/**
 * dsh-context-relay — 单一持久化层（v0.10.0 C5）。
 *
 * 两个数据面（设计稿 §2 storage 行）：
 * - workspaceStore(cwd)：`.scratch/context-relay/` 记录目录内的写盘。写者互斥走跨进程文件锁
 *   `<file>.lock`，**异步指数退避**（10→1000ms，waitMs 上限 1000ms）——等待期间不阻塞宿主
 *   事件循环（修 M-20；不做同步睡眠）；替换一律 temp+fsync+rename（崩溃不截断）；
 *   NDJSON 追加用 O_APPEND 单次 write+fsync；多文件替换走 redo journal `<file>.pending`
 *   （崩溃后幂等重放，修 M-04/B-03）。路径越界/符号链接在解析阶段拒绝。
 * - hostStore()：宿主私有目录（如 ~/.dsh/data/dsh-context-relay/panel.json）的原子写：
 *   temp+fsync+rename，**不加跨进程锁**（设计裁决 4：last-writer-wins + 调用方冲突 warn）。
 *
 * 所有写入统一过 `assertNoCredentials`（修 M-08：只拒已知凭据前缀/高熵值；错误只报命中字段，
 * 值永不回显）。同步原语（atomicStorageReplace/appendStorageLine/...）保留给仍为同步调用的旧
 * 调用方（shared.js 再导出）；新代码只用 store 门面。
 *
 * @module dsh-context-relay/storage
 */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { lstat as lstatAsync, open as openAsync, readFile as readFileAsync, unlink as unlinkAsync } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

/** 写锁重试退避：首轮 10ms，逐次翻倍到 1000ms；默认最多等 1000ms（异步等待，M-20）。 */
export const LOCK_RETRY_INITIAL_MS = 10;
export const LOCK_RETRY_MAX_MS = 1000;
export const LOCK_WAIT_MS = 1000;
/** 残缺锁（无 pid 记录）按年龄回收；持有 pid 仍活着的锁永不抢占（官方 withFileLock 语义）。 */
export const LOCK_STALE_MS = 30000;
/** 新建文件/锁的权限位（0600：仅本用户可读写）。 */
const STORAGE_MODE = 0o600;

// ── 凭据检测（M-08 / D-03）──────────────────────────────────────────────────
/**
 * 已知凭据形状（前缀/固定形态）。命中即拒绝：这些形态几乎不可能是正常人类文本。
 * 字段名进错误信息，值永不回显（B-context B-05：错误带命中字段）。
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['openai-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['url-credentials', /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s/:@]+:[^\s@/]{6,}@/],
]);
/** 已知凭据键名；裸 `key` 刻意不在表里——`key: docs/…` / `the key: design` 必须放行（M-08 误杀案例）。 */
const CREDENTIAL_KEY_NAMES = new Set([
  'token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'credentials',
  'api_key', 'api-key', 'apikey', 'access_key', 'access-key', 'secret_key', 'secret-key',
  'private_key', 'private-key', 'client_secret', 'client-secret',
  'auth_token', 'auth-token', 'access_token', 'access-token', 'refresh_token', 'refresh-token',
]);
/**
 * `<key> = <value>` 的键位（JSON/普通文本通用）。token 长度设上限（避免长串上回溯放大），
 * 先粗匹配再按键名表判定——对比嵌套量词正则，长文本上是线性开销。
 */
const CREDENTIAL_KEY = /(?<![A-Za-z0-9_.])([A-Za-z0-9_-]{2,40})["']?\s*[:=]\s*/g;
/** 键名是否凭据字段（支持 `x_api_key` 这类前缀形态）。 */
function isCredentialKey(key) {
  const name = String(key).toLowerCase();
  if (CREDENTIAL_KEY_NAMES.has(name)) return true;
  for (const candidate of CREDENTIAL_KEY_NAMES) {
    if (name.endsWith('_' + candidate) || name.endsWith('-' + candidate)) return true;
  }
  return false;
}
/** 键位前的字符不能是标识符的一部分（`mytoken:` 不算 `token`）。 */
function keyBoundaryOk(text, index) {
  if (index === 0) return true;
  return !/[A-Za-z0-9_.]/.test(text[index - 1]);
}
/** 占位值（none/null/redacted/...）不算凭据。 */
const CREDENTIAL_PLACEHOLDER = /^(?:none|null|nil|true|false|undefined|redacted|changeme|example|secret|password|token|xxx+|\*+|-+|…|\.\.\.|\[REDACTED\])$/i;

/** 取匹配后的值候选：带引号取到配对引号，否则取到分隔符为止。 */
function credentialValueOf(text) {
  const trimmed = text.replace(/^\s+/, '');
  if (trimmed === '') return undefined;
  const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : undefined;
  if (quote !== undefined) {
    const end = trimmed.indexOf(quote, 1);
    return end < 0 ? undefined : trimmed.slice(1, end);
  }
  const match = /^[^\s"'\x60,;}{\[\]]+/.exec(trimmed);
  return match === null ? undefined : match[0];
}

/**
 * 值是否像凭据（B-05 口径：已知前缀除外，通用键只在值高熵时拒绝）：
 * 非 ASCII（中文说明）/ URL/路径放行；长度 ≥16 的 ASCII 值或 12-15 的多字符类值判为凭据。
 */
function looksLikeSecret(value) {
  const text = String(value);
  if (text.length < 12 || CREDENTIAL_PLACEHOLDER.test(text)) return false;
  if (!/^[\x21-\x7E]+$/.test(text)) return false;
  if (text.includes('://') || /^(?:\.{0,2}\/|[A-Za-z]:\\|~\/)/.test(text)) return false;
  if (text.length >= 16) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(text)).length;
  return classes >= 2;
}

/** 返回命中字段名（known 前缀名或凭据键名）；未命中返回 undefined。 */
function credentialFieldOf(text) {
  for (const [field, pattern] of CREDENTIAL_PATTERNS) if (pattern.test(text)) return field;
  for (const match of text.matchAll(CREDENTIAL_KEY)) {
    if (!isCredentialKey(match[1]) || !keyBoundaryOk(text, match.index)) continue;
    const value = credentialValueOf(text.slice(match.index + match[0].length));
    if (value !== undefined && looksLikeSecret(value)) return String(match[1]).toLowerCase();
  }
  return undefined;
}

/** Credentials are rejected before any persistent write; errors name the field but never the value. */
export function assertNoCredentials(content) {
  const text = String(content).replace(/\\["']/g, '"');
  const field = credentialFieldOf(text);
  if (field !== undefined) throw new Error('relay storage: credential-like content rejected (field: ' + field + '; value omitted)');
}

// ── 路径守卫（保留 shared.js 原语义）──────────────────────────────────────
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

function fsyncDirectorySync(dir) {
  let fd;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 删除文件并把目录项变更 fsync 落盘；不存在视为成功。 */
export function removeIfPresent(path) {
  try {
    unlinkSync(path);
    fsyncDirectorySync(dirname(path));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// ── 同步原子原语（shared.js 旧 API 的实现；调用方持有锁时使用）────────────
/** temp+fsync+rename：目录内一次原子替换，读者只会看到旧内容或完整新内容。 */
function writeTempAndRename(path, content, { cleanTemp = false } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (cleanTemp) {
    const base = path.slice(dir.length + 1);
    for (const name of readdirSync(dir)) if (name.startsWith(base + '.tmp-')) removeIfPresent(join(dir, name));
  }
  const tmp = path + '.tmp-' + process.pid + '-' + randomUUID();
  let fd;
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, STORAGE_MODE);
    const data = Buffer.from(String(content));
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    fsyncDirectorySync(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeIfPresent(tmp);
  }
  return path;
}

/**
 * 任意绝对路径的原子替换（hostStore 与显式 pathOverride 的同步调用方）：
 * 不限制在 workspace 记录目录内（路径由调用方/配置负责），统一过凭据检测。
 */
export function atomicFileReplace(path, content) {
  assertNoCredentials(content);
  return writeTempAndRename(path, content);
}

/** Caller holds the file/transaction lock. Replace is durable and never exposes partial content. */
export function atomicStorageReplace(cwd, target, content) {
  assertNoCredentials(content);
  const path = storagePath(cwd, target);
  return writeTempAndRename(path, content, { cleanTemp: true });
}

/** O_APPEND, one syscall per complete NDJSON line, fsynced before returning. Caller holds lock. */
export function appendStorageLine(cwd, target, line) {
  assertNoCredentials(line);
  if (!line.endsWith('\n') || line.slice(0, -1).includes('\n')) throw new Error('relay storage: expected one complete NDJSON line');
  const fd = openSync(storagePath(cwd, target), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, STORAGE_MODE);
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

// ── workspace 异步门面（锁：异步退避，M-20）──────────────────────────────
function waitMsOf(options) {
  const raw = Number(options?.waitMs);
  if (!Number.isFinite(raw)) return LOCK_WAIT_MS;
  return Math.min(LOCK_WAIT_MS, Math.max(0, raw));
}

function staleMsOf(options) {
  const raw = Number(options?.staleMs);
  return Number.isFinite(raw) && raw >= 0 ? raw : LOCK_STALE_MS;
}

async function pidGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

/** 回收陈旧锁：死 pid 立即回收；残缺记录按 mtime 年龄回收；活 pid 的锁永不抢占。 */
async function takeOverStaleLock(lock, staleMs) {
  let before;
  try { before = await lstatAsync(lock); } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
  if (before.isSymbolicLink()) throw new Error('relay storage: symbolic link lock rejected');
  let pid;
  try { pid = JSON.parse(await readFileAsync(lock, 'utf8'))?.pid; } catch { pid = undefined; }
  const gone = await pidGone(pid);
  const stale = gone || (!Number.isInteger(pid) && Date.now() - before.mtimeMs > staleMs);
  if (!stale) return false;
  // inode 复验：绝不删除别的进程刚取得（或尚未写完记录）的锁。
  let current;
  try { current = await lstatAsync(lock); } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
  if (current.ino !== before.ino || current.dev !== before.dev) return false;
  try { await unlinkAsync(lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const dir = dirname(lock);
  let fd;
  try { fd = openSync(dir, constants.O_RDONLY); fsyncSync(fd); } finally { if (fd !== undefined) closeSync(fd); }
  return true;
}

/** 取得 `<path>.lock`（wx 独占创建）：EEXIST → 陈旧回收或异步退避重试；超时抛错。 */
async function acquireLock(lock, waitMs, staleMs) {
  const deadline = Date.now() + waitMs;
  let delay = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    try {
      const handle = await openAsync(lock, 'wx', STORAGE_MODE);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        await handle.sync();
      } finally { await handle.close(); }
      return await lstatAsync(lock);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (await takeOverStaleLock(lock, staleMs)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('relay storage: file lock timeout; retry operation');
    await sleepFor(Math.min(delay, remaining));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
}

async function releaseLock(lock, owner) {
  try {
    const current = await lstatAsync(lock);
    if (current.ino === owner.ino && current.dev === owner.dev) await unlinkAsync(lock);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const dir = dirname(lock);
  let fd;
  try { fd = openSync(dir, constants.O_RDONLY); fsyncSync(fd); } finally { if (fd !== undefined) closeSync(fd); }
}

/** 清理崩溃遗留的 temp 文件（`<name>.tmp-*` / `<name>.pending.tmp-*`）；只动本目标名。 */
function cleanupTempDebris(path) {
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name.startsWith(base + '.tmp-') || name.startsWith(base + '.pending.tmp-')) removeIfPresent(join(dir, name));
  }
}

/**
 * workspace 记录目录（cwd/.scratch/context-relay）的写入门面。target 为记录目录内相对名
 * （如 'progress.md'）或记录目录内绝对路径；越界/符号链接在解析时拒绝。
 * 异步方法内部用跨进程写锁串行化，等待为异步退避（不阻塞事件循环）。
 */
export function workspaceStore(cwd) {
  const root = resolve(typeof cwd === 'string' && cwd !== '' ? cwd : '.');
  const pathOf = (target) => {
    if (typeof target !== 'string' || target === '') throw new Error('relay storage: target path required');
    return storagePath(root, isAbsolute(target) ? target : join(root, '.scratch', 'context-relay', target));
  };
  const normalizeWrites = (writes) => (Array.isArray(writes) ? writes : []).map((item) => {
    if (item === null || typeof item !== 'object' || typeof item.content !== 'string') throw new Error('relay storage: write content must be a string');
    return { path: pathOf(item.path), content: item.content };
  });

  /** 加锁执行 action（action 返回 Promise 或值）；锁释放严格在 action 之后。 */
  const withFileLock = async (target, action, options = {}) => {
    const path = pathOf(target);
    const lock = pathOf(path + '.lock');
    const owner = await acquireLock(lock, waitMsOf(options), staleMsOf(options));
    try {
      cleanupTempDebris(path);
      return await action(path);
    } finally {
      await releaseLock(lock, owner);
    }
  };

  /** 加锁原子替换（可选 expected 乐观锁：与当前内容不一致 → revision conflict）。 */
  const writeAtomic = async (target, content, options = {}) => {
    const path = pathOf(target);
    await withFileLock(path, () => {
      if (Object.hasOwn(options, 'expected')) {
        let current;
        try { current = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current !== options.expected) throw new Error('relay storage: revision conflict; reload before retry');
      }
      return atomicStorageReplace(root, path, content);
    });
    return path;
  };

  /** 加锁追加一条完整 NDJSON 行（先重放可能残留的 redo journal）。 */
  const appendLine = async (target, line) => withFileLock(target, (path) => {
    recoverStorageTransaction(root, path);
    appendStorageLine(root, path, line);
    return path;
  });

  /** 调用方持有锁：重放该 target 的 redo journal（崩溃恢复）。 */
  const recover = (target) => recoverStorageTransaction(root, pathOf(target));

  /** 调用方持有锁：原子替换（不重复加锁）。 */
  const replace = (target, content) => atomicStorageReplace(root, pathOf(target), content);

  /** 调用方持有锁：journal + 多文件原子替换（writes = [{path, content}]，path 为绝对或记录内相对名）。 */
  const applyWrites = (target, writes) => {
    const path = pathOf(target);
    const normalized = normalizeWrites(writes);
    recoverStorageTransaction(root, path);
    storageTransaction(root, path, normalized);
    return path;
  };

  /** 加锁执行事务（journal + 多文件原子替换，失败可重放）。 */
  const transaction = async (target, writes) => withFileLock(target, () => applyWrites(target, writes));

  /** 加锁读文本：不存在返回 undefined（读取无锁，rename 原子性保证读者不会看到半截）。 */
  const readText = (target) => {
    try { return readFileSync(pathOf(target), 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  };

  /** 加锁删除（不存在视为成功）。 */
  const remove = async (target) => withFileLock(target, (path) => { removeIfPresent(path); });

  return { cwd: root, path: pathOf, withFileLock, writeAtomic, appendLine, transaction, applyWrites, recover, replace, readText, remove };
}

// ── host 门面（~/.dsh 等宿主私有数据：fsync+rename，无跨进程锁）──────────
export function hostStore() {
  return {
    /** 原子替换任意宿主路径（temp+fsync+rename；写前过凭据检测）。 */
    writeAtomic(file, content) {
      if (typeof file !== 'string' || file === '') throw new Error('relay storage: host file path required');
      return atomicFileReplace(file, content);
    },
  };
}

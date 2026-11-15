/**
 * dsh-context-relay — 链式召回索引（chain of recall）。
 *
 * 压缩/接力时把「会话 id + 被遮蔽事件 seq 区间 + brief/handoff 路径」追加到
 * `.scratch/context-relay/chain.ndjson`（条目/字节双上限），压缩后注入的 brief 引用它；
 * 超界时最旧条目原样旋转进 `.scratch/context-relay/chain-archive-<年>.ndjson`（不丢指针）；
 * 模型用 `session_event_read({session_id, seq})` 按指针精确回读（本机实测 46–650ms）。
 *
 * 为什么是指针而不是全文检索：本机实测 session_search / session_event_search 30s 超时，
 * 不可作为主路径（2026-11-03，本会话）；指针式召回是唯一稳定路径。
 *
 * @module dsh-context-relay/agent/chain
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const CHAIN_FILE = 'chain.ndjson';
/** workspace 相对路径（写进 brief / 首条消息）。 */
export const CHAIN_RELATIVE = '.scratch/context-relay/' + CHAIN_FILE;
/** 有界：条目数与字节双上限（超出旋转到归档，不丢数据；live 仍 ≤ 两上限）。 */
export const CHAIN_MAX_ENTRIES = 100;
export const CHAIN_MAX_BYTES = 32768;
/** 归档文件前缀：chain-archive-<年份>.ndjson（年份取条目 ts 前 4 位）。 */
export const CHAIN_ARCHIVE_PREFIX = 'chain-archive-';
export const CHAIN_RECALL_HEADER = '## 压缩与链式召回（插件生成）';
export const CHAIN_KINDS = ['compaction', 'handoff', 'teammate-freshen', 'teammate-reset'];

const FIELDS = { sessionId: 80, parentSessionId: 80, childSessionId: 80, phase: 20, goal: 120, compactionId: 80, briefPath: 200, handoffPath: 200, note: 200 };

function rootOf(cwd) { return join(cwd, '.scratch', 'context-relay'); }
export function chainPathOf(cwd) { return join(rootOf(cwd), CHAIN_FILE); }
/** 归档文件路径（chain-archive-<年份>.ndjson）。 */
export function chainArchivePathOf(cwd, year) { return join(rootOf(cwd), CHAIN_ARCHIVE_PREFIX + String(year) + '.ndjson'); }

function clip(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return Array.from(text).length <= max ? text : Array.from(text).slice(0, Math.max(0, max - 1)).join('') + '…';
}

function seqOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 归一化一条索引（未知字段丢弃、字符串截断、seq 只收非负整数）。 */
export function normalizeChainEntry(input = {}) {
  const kind = CHAIN_KINDS.includes(input.kind) ? input.kind : 'compaction';
  const entry = {
    v: 1,
    ts: clip(input.ts ?? new Date().toISOString(), 40),
    kind,
    sessionId: clip(input.sessionId, FIELDS.sessionId),
    phase: clip(input.phase, FIELDS.phase),
    goal: clip(input.goal, FIELDS.goal),
  };
  for (const key of ['parentSessionId', 'childSessionId', 'compactionId', 'briefPath', 'handoffPath', 'note']) {
    const value = clip(input[key], FIELDS[key]);
    if (value !== '') entry[key] = value;
  }
  for (const key of ['shadowedStart', 'shadowedEnd', 'freedTokens']) {
    const value = seqOf(input[key]);
    if (value !== undefined) entry[key] = value;
  }
  return entry;
}

/** workspace 相对路径（写进索引/注入文本；越界路径原样返回，不泄露绝对路径以外信息）。 */
export function workspaceRelativePath(cwd, target) {
  if (typeof target !== 'string' || target === '') return '';
  const rel = relative(cwd, target);
  if (rel === '') return '.';
  if (rel.startsWith('..')) return target;
  return rel.split(sep).join('/');
}

function parseLines(raw) {
  const entries = [];
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(normalizeChainEntry(parsed));
    } catch { /* 坏行跳过：索引可降级，不阻断压缩/接力 */ }
  }
  return entries;
}

function bytesOf(text) { return Buffer.byteLength(text, 'utf8'); }

/** 解析一行 JSONL 为归一化条目（坏行/非对象返回 undefined）。 */
function tryEntryOf(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? normalizeChainEntry(parsed) : undefined;
  } catch { return undefined; }
}

/** 归档年份：条目 ts 前 4 位（解析失败用当前年）。 */
function archiveYearOf(entry) {
  const match = /^\d{4}/.exec(typeof entry.ts === 'string' ? entry.ts : '');
  return match === null ? String(new Date().getFullYear()) : match[0];
}

/** 把被移出的条目原样（JSONL）追加到按年归档文件，O_APPEND 与主文件并发口径一致。 */
function appendArchive(cwd, items) {
  if (items.length === 0) return 0;
  const byYear = new Map();
  for (const item of items) {
    const year = archiveYearOf(item.entry);
    const lines = byYear.get(year);
    if (lines === undefined) byYear.set(year, [item.line]); else lines.push(item.line);
  }
  for (const [year, lines] of byYear) appendFileSync(chainArchivePathOf(cwd, year), lines.join('\n') + '\n', 'utf8');
  return items.length;
}

/** 读最近的索引条目（最旧→最新；坏行跳过）。只读 live，不含归档（归档用 readChainArchive）。 */
export function readChain(cwd, limit = 20) {
  const path = chainPathOf(cwd);
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const entries = parseLines(raw);
  const size = Number.isInteger(limit) && limit > 0 ? limit : 20;
  return entries.slice(-size);
}

/** 读最近 N 条归档条目（最旧→最新；按年文件升序拼接；坏行/坏文件跳过；归一化同 readChain）。 */
export function readChainArchive(cwd, limit = 20) {
  let names;
  try { names = readdirSync(rootOf(cwd)); } catch { return []; }
  const files = names.filter((name) => name.startsWith(CHAIN_ARCHIVE_PREFIX) && name.endsWith('.ndjson')).sort();
  const entries = [];
  for (const name of files) {
    try { entries.push(...parseLines(readFileSync(join(rootOf(cwd), name), 'utf8'))); } catch { /* 坏文件跳过：归档可降级，不阻断召回 */ }
  }
  const size = Number.isInteger(limit) && limit > 0 ? limit : 20;
  return entries.slice(-size);
}

/**
 * 追加一条索引并保持有界：超界时把将被丢弃的最旧条目原样（JSONL）旋转进
 * chain-archive-<年份>.ndjson（不丢指针），live 仍 ≤ 条目/字节双上限。
 * 写盘先 tmp 再 rename，失败抛错由调用方降级。
 * @returns {{path: string, relativePath: string, entries: number, bytes: number, archived: number}}
 */
export function appendChainEntry(cwd, input = {}) {
  const path = chainPathOf(cwd);
  mkdirSync(rootOf(cwd), { recursive: true });
  // P2-3（2026-11-03 审查）：常见路径用 O_APPEND 单行追加（并发会话互不覆盖，不会丢别人的行）；
  // 只有超界时才读-改-写旋转（归档也是 O_APPEND；极低概率与并发追加交错，最坏归档重复/少 1–2 条，指针仍在）。
  appendFileSync(path, JSON.stringify(normalizeChainEntry(input)) + '\n', 'utf8');
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= CHAIN_MAX_ENTRIES && bytesOf(raw) <= CHAIN_MAX_BYTES) {
    return { path, relativePath: CHAIN_RELATIVE, entries: lines.length, bytes: bytesOf(raw), archived: 0 };
  }
  // 坏行不计数、旋转时直接移出 live（无法解读，无召回价值）；有效条目保持原样行不重编码。
  const items = [];
  for (const line of lines) {
    const entry = tryEntryOf(line);
    if (entry !== undefined) items.push({ line, entry });
  }
  // 从最新往回收，累计到条目/字节上限为止；更旧的有效条目移出 live → 归档。
  let start = items.length;
  let text = '';
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index].line + '\n' + text;
    if (items.length - index > CHAIN_MAX_ENTRIES || bytesOf(candidate) > CHAIN_MAX_BYTES) break;
    start = index;
    text = candidate;
  }
  // 极端兜底：live 连一条原样行都放不下时，保留最新一条的归一化行（归一化后必有界），仍不丢指针。
  if (start === items.length && items.length > 0) {
    start = items.length - 1;
    text = JSON.stringify(items[start].entry) + '\n';
  }
  const archived = appendArchive(cwd, items.slice(0, start));
  const tmp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return { path, relativePath: CHAIN_RELATIVE, entries: items.length - start, bytes: bytesOf(text), archived };
}

/** 一行一个指针（≤200 字符），供 brief 的「历史指针」段使用。 */
export function formatChainPointers(entries, limit = 5) {
  const list = Array.isArray(entries) ? entries.slice(-Math.max(1, limit)) : [];
  return list.map((entry) => {
    const parts = ['[' + entry.kind + '] session=' + (entry.sessionId || '?')];
    if (entry.shadowedStart !== undefined && entry.shadowedEnd !== undefined) parts.push('压缩遮蔽 seq ' + entry.shadowedStart + '–' + entry.shadowedEnd);
    if (entry.childSessionId !== undefined) parts.push('→ ' + entry.childSessionId);
    if (entry.handoffPath !== undefined) parts.push(entry.handoffPath);
    if (entry.briefPath !== undefined) parts.push(entry.briefPath);
    if (entry.goal !== '') parts.push(entry.goal);
    return clip(parts.join(' · '), 200);
  });
}

/**
 * 压缩后注入的「压缩与链式召回」段：本会话遮蔽区间 + 历史指针（召回纪律已在常驻协议，不重复）。
 * 有界（默认 ≤900 字符），随 brief 注入（brief 注入总上限 4000 字符，超长由调用方截断并留完整文件路径）。
 */
export function buildRecallSection({ sessionId, compaction = {}, entries = [], briefPath, maxChars = 900 } = {}) {
  const lines = [CHAIN_RECALL_HEADER];
  const seqText = compaction.shadowedStart !== undefined && compaction.shadowedEnd !== undefined
    ? '遮蔽事件 seq ' + compaction.shadowedStart + '–' + compaction.shadowedEnd
    : (compaction.shadowedStart === undefined ? '遮蔽事件 seq 未报告' : '遮蔽事件 seq ' + compaction.shadowedStart);
  lines.push('- 本会话 ' + (sessionId || '?') + ' 压缩' + (compaction.compactionId === undefined ? '' : '（' + compaction.compactionId + '）') + '，' + seqText + (compaction.freedTokens === undefined ? '' : '，释放 ' + compaction.freedTokens + ' tokens') + (briefPath === undefined ? '' : '；完整 brief：' + briefPath) + '。');
  lines.push('- 链式索引：' + CHAIN_RELATIVE + '（逐行一条：会话 id + 遮蔽 seq 区间 + brief/handoff 路径）。');
  const pointers = formatChainPointers(entries);
  if (pointers.length > 0) {
    lines.push('- 历史指针：');
    for (const pointer of pointers) lines.push('  ' + pointer);
  } else {
    lines.push('- 历史指针：暂无（首条索引由本次压缩写入）。');
  }
  const text = lines.join('\n');
  return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

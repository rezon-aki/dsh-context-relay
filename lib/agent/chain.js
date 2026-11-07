/**
 * dsh-context-relay — 链式召回索引（chain of recall）。
 *
 * 压缩/接力时把「会话 id + 被遮蔽事件 seq 区间 + brief/handoff 路径」追加到
 * `.scratch/context-relay/chain.ndjson`（有界），压缩后注入的 brief 引用它；
 * 模型用 `session_event_read({session_id, seq})` 按指针精确回读（本机实测 46–650ms）。
 *
 * 为什么是指针而不是全文检索：本机实测 session_search / session_event_search 30s 超时，
 * 不可作为主路径（2026-11-03，本会话）；指针式召回是唯一稳定路径。
 *
 * @module dsh-context-relay/agent/chain
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const CHAIN_FILE = 'chain.ndjson';
/** workspace 相对路径（写进 brief / 首条消息）。 */
export const CHAIN_RELATIVE = '.scratch/context-relay/' + CHAIN_FILE;
/** 有界：条目数与字节双上限（超出丢最旧）。 */
export const CHAIN_MAX_ENTRIES = 100;
export const CHAIN_MAX_BYTES = 32768;
export const CHAIN_RECALL_HEADER = '## 压缩与链式召回（插件生成）';
export const CHAIN_KINDS = ['compaction', 'handoff', 'teammate-freshen', 'teammate-reset'];

const FIELDS = { sessionId: 80, parentSessionId: 80, childSessionId: 80, phase: 20, goal: 120, compactionId: 80, briefPath: 200, handoffPath: 200, note: 200 };

function rootOf(cwd) { return join(cwd, '.scratch', 'context-relay'); }
export function chainPathOf(cwd) { return join(rootOf(cwd), CHAIN_FILE); }

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

/** 读最近的索引条目（最旧→最新；坏行跳过）。 */
export function readChain(cwd, limit = 20) {
  const path = chainPathOf(cwd);
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const entries = parseLines(raw);
  const size = Number.isInteger(limit) && limit > 0 ? limit : 20;
  return entries.slice(-size);
}

/**
 * 追加一条索引并保持有界（条目/字节双上限，超出丢最旧）。写盘先 tmp 再 rename，失败抛错由调用方降级。
 * @returns {{path: string, relativePath: string, entries: number, bytes: number}}
 */
export function appendChainEntry(cwd, input = {}) {
  const path = chainPathOf(cwd);
  mkdirSync(rootOf(cwd), { recursive: true });
  // P2-3（2026-11-03 审查）：常见路径用 O_APPEND 单行追加（并发会话互不覆盖，不会丢别人的行）；
  // 只有超界时才读-改-写轮转（极低概率与并发追加交错，最坏丢最旧 1–2 条指针，只影响召回）。
  appendFileSync(path, JSON.stringify(normalizeChainEntry(input)) + '\n', 'utf8');
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= CHAIN_MAX_ENTRIES && bytesOf(raw) <= CHAIN_MAX_BYTES) {
    return { path, relativePath: CHAIN_RELATIVE, entries: lines.length, bytes: bytesOf(raw) };
  }
  const entries = parseLines(raw);
  while (entries.length > CHAIN_MAX_ENTRIES) entries.shift();
  let text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  while (entries.length > 1 && bytesOf(text) > CHAIN_MAX_BYTES) {
    entries.shift();
    text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  }
  const tmp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return { path, relativePath: CHAIN_RELATIVE, entries: entries.length, bytes: bytesOf(text) };
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

/**
 * dsh-context-relay — 会话文档分层与索引（v0.8.0 docs v2 基础模块）。
 *
 * 目标（对齐官方 dsh-agent-instructions / dsh-tool-skill 的模式）：
 *   索引/摘要常驻（小）+ 正文按需取（无上限）+ 结构契约 + 显式标记。
 *   L0 索引：本模块渲染（自动生成、不落盘、按 digest 判断变化）。
 *   L1 摘要：handoff / phase brief / progress / lessons（先读层）。
 *   L2 详情：architecture / docs / decisions / research（按需读）。
 *   L3 原始：reports / archive / team 记录（默认不入索引，可 search/list 取）。
 *
 * frontmatter（可选；有则覆盖分类推断）：
 *   ---
 *   title: 关键决策
 *   role: 一句话说明这份文档是干什么的
 *   layer: L2
 *   when: 需要知道「为什么这么做」时
 *   owner: session-xxx
 *   updated: 2026-11-15
 *   ---
 *
 * 只读扫描 + 文本处理 + 有界读取，不写任何文件；异常一律降级为结构化结果。
 *
 * @module dsh-context-relay/docs
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const RELAY_ROOT = '.scratch/context-relay';
export const DOCS_DIR = 'docs';
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BT = String.fromCharCode(96);
const NUL = String.fromCharCode(0);

/** 文档系统的 advisory 上限：只影响索引/读取的有界性，不做硬拒绝。 */
export const DOC_LIMITS = Object.freeze({
  indexBytes: 2048,
  readLines: 120,
  readBytes: 8192,
  searchLimit: 20,
  searchSnippet: 160,
  l1WarnBytes: 16384,
  docWarnBytes: 65536,
  maxScanFiles: 4000,
  maxReadBytes: 524288,
  indexEntries: 24,
});

const SKIP_DIRS = new Set(['tmp', 'logs', 'node_modules', '.git', 'team']);
/** 只扫描这些子目录（其余如 d1-upload/ 部署暂存、logs/ 一律跳过，防止 4000 文件上限被污染）。 */
const ALLOW_DIRS = new Set(['docs', 'architecture', 'research', 'decisions', 'reports', 'archive']);
/** 默认索引里最多保留的 handoff 份数 / phase brief 份数（旧的仍可 list include=all 或 search）。 */
const INDEX_HANDOFFS = 3;
const INDEX_BRIEFS = 2;
const LAYERS = new Set(['L1', 'L2']);

const bytesOf = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
const isoDay = (ms) => {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
};
const clip = (text, max) => {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
};

/** relay 根目录（绝对）。 */
export function relayRootOf(cwd) {
  return join(String(cwd ?? '.'), RELAY_ROOT);
}

/** 会话文档目录（绝对；不一定存在）。 */
export function docsRootOf(cwd) {
  return join(relayRootOf(cwd), DOCS_DIR);
}

function posixRelative(from, to) {
  return relative(from, to).split(sep).join('/');
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return null; }
}

function splitLines(text) {
  return String(text ?? '').split(NL).map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line));
}

/** 解析 frontmatter（只认单行 key: value；与官方 skill frontmatter 同款最小实现）。 */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  const lines = splitLines(source);
  if (lines.length < 2 || lines[0].trim() !== '---') return { meta: {}, body: source, hasFrontmatter: false };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { end = index; break; }
  }
  if (end < 0) return { meta: {}, body: source, hasFrontmatter: false };
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (value !== '') meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join(NL), hasFrontmatter: true };
}

/** 文件名 → 旧产物分类（无 frontmatter 时用；role/when 只是默认建议，可加 frontmatter 覆盖）。 */
function legacyKind(relPath) {
  const name = relPath.split('/').pop() ?? '';
  if (relPath.startsWith('archive/')) return { kind: 'archive', layer: 'raw', role: '归档原文', when: '需要旧版本原文时' };
  if (/^handoff-[^/]+[.]md$/i.test(name)) return { kind: 'handoff', layer: 'L1', role: '交接快照', when: '新会话接手先读（最新的优先）' };
  if (/^phase-[a-z]+-[^/]+[.]md$/i.test(name)) return { kind: 'brief', layer: 'L1', role: 'phase brief', when: '压缩后/阶段交接先读' };
  if (name === 'progress.md') return { kind: 'progress', layer: 'L1', role: '滚动进度', when: '需要长线状态/决策时读头部' };
  if (name === 'lessons.md') return { kind: 'lessons', layer: 'L1', role: '经验存档', when: '跨 phase 复用做法/踩坑前' };
  if (name === 'decisions.md' || relPath.startsWith('decisions/')) return { kind: 'decisions', layer: 'L2', role: '关键决策', when: '需要知道「为什么这么做」时' };
  if (relPath.startsWith('architecture/') || relPath.startsWith('docs/architecture/')) return { kind: 'architecture', layer: 'L2', role: '架构/实现路线', when: '改对应模块/评审路线前' };
  if (relPath.startsWith('research/') || relPath.startsWith('docs/research/')) return { kind: 'research', layer: 'L2', role: '调研', when: '需要事实/上游资料时' };
  if (relPath.startsWith(DOCS_DIR + '/')) return { kind: 'doc', layer: 'L2', role: '', when: '' };
  if (/^progress-archive-[^/]+[.]md$/i.test(name)) return { kind: 'archive', layer: 'raw', role: '进度归档', when: '需要旧时间线时' };
  if (relPath.startsWith('reports/')) return { kind: 'report', layer: 'raw', role: '工作回执', when: '按任务名 search' };
  return { kind: 'other', layer: 'raw', role: '', when: '' };
}

function entryOf(cwd, absolutePath, stat) {
  const relPath = posixRelative(relayRootOf(cwd), absolutePath);
  const base = legacyKind(relPath);
  let header;
  try { header = docHeader(absolutePath); } catch { return undefined; }
  const meta = header.meta;
  const metaLayer = typeof meta.layer === 'string' ? meta.layer.trim() : '';
  const layer = LAYERS.has(metaLayer) ? metaLayer : (metaLayer === 'raw' || metaLayer === 'L3' ? 'raw' : base.layer);
  return {
    path: posixRelative(cwd, absolutePath),
    relPath,
    name: absolutePath.split(sep).pop() ?? relPath,
    title: typeof meta.title === 'string' ? meta.title : 'unknown',
    role: typeof meta.role === 'string' && meta.role !== '' ? meta.role : (base.role || 'unknown'),
    when: typeof meta.when === 'string' && meta.when !== '' ? meta.when : (base.when || 'unknown'),
    layer,
    kind: base.kind,
    owner: typeof meta.owner === 'string' ? meta.owner : 'unknown',
    updated: typeof meta.updated === 'string' && meta.updated !== '' ? meta.updated : 'unknown',
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    source: header.lines > 0 ? 'frontmatter' : 'legacy',
  };
}

function walkMarkdown(dir, state, depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (state.files.length >= state.maxFiles) { state.truncated = true; return; }
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // 顶层只进白名单目录；白名单目录内部可继续递归（docs/** 等），深度上限 4。
      if (depth === 0 && !ALLOW_DIRS.has(entry.name)) continue;
      if (depth >= state.maxDepth) { state.truncated = true; continue; }
      walkMarkdown(full, state, depth + 1);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    state.files.push(full);
  }
}

/** 扫描会话文档树（只读）。 */
export function scanDocs(cwd, { dir, exhaustive = false } = {}) {
  const root = typeof dir === 'string' && dir !== '' ? resolve(dir) : relayRootOf(cwd);
  const state = { files: [], truncated: false, maxFiles: exhaustive ? Infinity : DOC_LIMITS.maxScanFiles, maxDepth: exhaustive ? Infinity : 4 };
  if (existsSync(root)) walkMarkdown(root, state);
  const entries = [];
  for (const file of state.files) {
    let stat;
    try { stat = statSync(file); } catch { continue; }
    const entry = entryOf(cwd, file, stat);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, scanned: state.files.length, truncated: state.truncated, root };
}

const LAYER_RANK = { L1: 0, L2: 1, raw: 2 };
const KIND_RANK = { handoff: 0, brief: 1, progress: 2, lessons: 3, decisions: 4, architecture: 5, doc: 6, research: 7 };

function rank(a, b) {
  const layer = (LAYER_RANK[a.layer] ?? 9) - (LAYER_RANK[b.layer] ?? 9);
  if (layer !== 0) return layer;
  const kind = (KIND_RANK[a.kind] ?? 50) - (KIND_RANK[b.kind] ?? 50);
  if (kind !== 0) return kind;
  return b.mtimeMs - a.mtimeMs;
}

function baseIndexable(entry) {
  if (!LAYERS.has(entry.layer)) return false;
  if (entry.source === 'frontmatter') return true;
  if (entry.layer === 'L1') return true;
  return entry.kind === 'architecture' || entry.kind === 'decisions' || entry.kind === 'research';
}

/**
 * 构建文档索引：默认只把「最新 3 份 handoff + 最新 2 份 brief」放进 L1（避免 66 份交接单淹没索引），
 * 其余条目仍可 list include=all / search 取到；raw（reports/归档）默认不入索引。
 */
export function buildDocIndex(cwd, { include = 'index', exhaustive = false } = {}) {
  const scanned = scanDocs(cwd, { exhaustive });
  const sorted = [...scanned.entries].sort(rank);
  const topOf = (kind, limit) => new Set(sorted.filter((entry) => entry.kind === kind).slice(0, limit).map((entry) => entry.relPath));
  const topHandoffs = topOf('handoff', INDEX_HANDOFFS);
  const topBriefs = topOf('brief', INDEX_BRIEFS);
  const indexable = (entry) => {
    if (!baseIndexable(entry)) return false;
    if (entry.kind === 'handoff') return topHandoffs.has(entry.relPath);
    if (entry.kind === 'brief') return topBriefs.has(entry.relPath);
    return true;
  };
  const entries = include === 'all' ? sorted : sorted.filter(indexable);
  const counts = {
    total: sorted.length,
    indexed: sorted.filter(indexable).length,
    raw: sorted.filter((entry) => !indexable(entry)).length,
    truncated: scanned.truncated,
  };
  return { entries, all: sorted, counts, truncated: scanned.truncated, root: scanned.root, topHandoffs, topBriefs };
}

/** 单条索引行：path — role（when）· size · updated */
export function formatIndexEntry(entry, { withWhen = true } = {}) {
  const parts = [BT + (entry.relPath || entry.path) + BT, '—', entry.role === '' ? '（未标注作用）' : entry.role];
  if (withWhen && entry.when !== '') parts.push('（' + entry.when + '）');
  const size = entry.bytes >= 1024 ? (entry.bytes / 1024).toFixed(1) + 'KB' : entry.bytes + 'B';
  parts.push('· ' + size, '· ' + entry.updated);
  return '- ' + parts.join(' ');
}

/** 渲染 L0 索引（≤maxBytes；超出从尾部截断并留显式 marker）。 */
export function renderDocIndex(index, { maxBytes = DOC_LIMITS.indexBytes } = {}) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const all = Array.isArray(index?.all) ? index.all : entries;
  const header = '## 文档索引（插件生成 L0；路径相对 ' + RELAY_ROOT + '/）';
  const l1 = entries.filter((entry) => entry.layer === 'L1');
  const l2 = entries.filter((entry) => entry.layer === 'L2');
  const others = Math.max(0, all.length - entries.length);
  const tail = others > 0 ? ['- 另有 ' + others + ' 份历史产物未入索引（reports/归档等）：用 ' + BT + 'relay_doc search <关键词>' + BT + ' 或 ' + BT + 'relay_doc list include=all' + BT + ' 取'] : [];
  const build = (visibleL1, visibleL2) => {
    const out = [header];
    if (visibleL1.length > 0) out.push('### 先读（L1）', ...visibleL1.map((entry) => formatIndexEntry(entry)));
    if (visibleL2.length > 0) out.push('### 按需（L2）', ...visibleL2.map((entry) => formatIndexEntry(entry)));
    const dropped = entries.length - visibleL1.length - visibleL2.length;
    const extra = dropped > 0 ? ['- 索引已截断：' + dropped + ' 条未显示（' + BT + 'relay_doc list' + BT + ' 取全量；预算 ' + maxBytes + 'B）'] : [];
    out.push(...extra, ...tail);
    return out.join(NL);
  };
  const visibleL1 = [...l1];
  const visibleL2 = [...l2];
  let text = build(visibleL1, visibleL2);
  let guard = 0;
  while (bytesOf(text) > maxBytes && (visibleL2.length > 0 || visibleL1.length > 1) && guard < 200) {
    if (visibleL2.length > 0) visibleL2.pop();
    else visibleL1.pop();
    text = build(visibleL1, visibleL2);
    guard += 1;
  }
  const shown = visibleL1.length + visibleL2.length;
  const omitted = entries.length - shown;
  if (bytesOf(text) > maxBytes) text = clip(text, Math.max(0, maxBytes - 30)) + NL + '…（索引超预算已截断）';
  return { text, bytes: bytesOf(text), digest: docIndexDigest(text), shown, omitted, truncated: omitted > 0 || bytesOf(text) > maxBytes };
}

/** 索引内容 digest（变了才重新注入）。 */
export function docIndexDigest(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** 便捷：直接渲染当前索引（handoff/brief/relay_doc 共用）。 */
export function renderDocIndexSection(cwd, options = {}) {
  return renderDocIndex(buildDocIndex(cwd), options);
}

/** 解析 read 的路径：只接受 relay 根内文件。 */
function resolveDocPath(cwd, path) {
  const raw = String(path ?? '').trim();
  if (raw === '' || raw.includes(NUL)) return { error: 'path 为空或非法' };
  if (raw.startsWith('~') || raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return { error: '只接受 relay 文档相对路径（不接受绝对路径/~）' };
  const relayRoot = relayRootOf(cwd);
  let normalized = raw;
  if (normalized.startsWith(RELAY_ROOT + '/')) normalized = normalized.slice(RELAY_ROOT.length + 1);
  else if (normalized.startsWith('.scratch/context-relay/')) normalized = normalized.slice('.scratch/context-relay/'.length);
  const abs = resolve(relayRoot, normalized);
  if (!isInside(relayRoot, abs)) return { error: '路径越出 relay 文档根目录' };
  const realRoot = safeRealpath(relayRoot);
  const realAbs = safeRealpath(abs);
  if (realRoot !== null && realAbs !== null && !isInside(realRoot, realAbs)) return { error: '符号链接越出 relay 文档根目录' };
  return { abs };
}

/** 提取标题结构：{ level, title, line }（line 0-based）。 */
export function headingsOf(text) {
  const headings = [];
  splitLines(text).forEach((line, index) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('#')) return;
    let level = 0;
    while (level < trimmed.length && trimmed[level] === '#') level += 1;
    if (level === 0 || level > 6) return;
    if (trimmed.length <= level || trimmed[level] !== ' ') return;
    headings.push({ level, title: trimmed.slice(level + 1).trim(), line: index });
  });
  return headings;
}

/** Stream line locations, retaining only a bounded prefix even for one huge line. */
function* docLines(path, prefixBytes = 8192) {
  const fd = openSync(path, 'r');
  const block = Buffer.alloc(65536);
  let position = 0, start = 0, line = 0, prefix = Buffer.alloc(0);
  try {
    let count;
    while ((count = readSync(fd, block, 0, block.length, position)) > 0) {
      let from = 0;
      for (let i = 0; i < count; i += 1) {
        if (block[i] !== 10) continue;
        if (prefix.length < prefixBytes) prefix = Buffer.concat([prefix, block.subarray(from, Math.min(i, from + prefixBytes - prefix.length))]);
        yield { text: prefix.toString('utf8').replace(/\r$/, ''), line: line++, start, end: position + i + 1 };
        start = position + i + 1; prefix = Buffer.alloc(0); from = i + 1;
      }
      if (prefix.length < prefixBytes) prefix = Buffer.concat([prefix, block.subarray(from, Math.min(count, from + prefixBytes - prefix.length))]);
      position += count;
    }
    yield { text: prefix.toString('utf8').replace(/\r$/, ''), line, start, end: position };
  } finally { closeSync(fd); }
}

/** Bounded prefix for frontmatter; document bodies are never loaded wholesale. */
function docHeader(path) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(DOC_LIMITS.maxReadBytes);
  let count;
  try { count = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
  const text = buffer.subarray(0, count).toString('utf8');
  const parsed = parseFrontmatter(text);
  const lines = parsed.hasFrontmatter ? splitLines(text).findIndex((line, index) => index > 0 && line.trim() === '---') + 1 : 0;
  return { meta: parsed.meta, lines };
}

/** 有界读取；offset 为正文/章节内行号，byteOffset 为文件绝对字节续读位置。 */
export function readDoc(cwd, path, { section, offset = 0, byteOffset, limit = DOC_LIMITS.readLines, maxBytes = DOC_LIMITS.readBytes } = {}) {
  const resolved = resolveDocPath(cwd, path);
  if (resolved.error !== undefined) return { ok: false, code: 'invalid-path', error: resolved.error, path: String(path ?? '') };
  if (byteOffset !== undefined && (!Number.isSafeInteger(byteOffset) || byteOffset < 0)) return { ok: false, code: 'invalid-offset', error: 'byteOffset 必须是非负安全整数', path };
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const maxLines = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : DOC_LIMITS.readLines;
  const budget = Number.isInteger(maxBytes) && maxBytes >= 4 ? Math.min(maxBytes, DOC_LIMITS.readBytes) : DOC_LIMITS.readBytes;
  try {
    const size = statSync(resolved.abs).size;
    const header = docHeader(resolved.abs);
    const sections = [], candidates = [undefined, undefined, undefined];
    const needle = typeof section === 'string' ? section.trim().toLowerCase() : '';
    let totalLines = 0;
    for (const row of docLines(resolved.abs)) {
      if (row.line < header.lines) continue;
      const line = row.line - header.lines;
      totalLines = line + 1;
      const heading = headingsOf(row.text)[0];
      if (!heading) continue;
      const item = { level: heading.level, title: heading.title, line };
      if (sections.length < 64) sections.push(item);
      for (const candidate of candidates) if (candidate && candidate.endLine === undefined && line > candidate.line && item.level <= candidate.level) candidate.endLine = line;
      if (!needle) continue;
      const title = item.title.toLowerCase();
      const matches = [title === needle, title.startsWith(needle), title.includes(needle)];
      matches.forEach((match, i) => { if (match && !candidates[i]) candidates[i] = { ...item }; });
    }
    const matched = candidates.find(Boolean);
    if (needle && !matched) return { ok: false, code: 'section-not-found', error: '未找到标题包含「' + section + '」的章节', path, sections };
    const first = matched?.line ?? 0, last = matched?.endLine ?? totalLines;
    let from = size, until = size, nextLine = first + start, sectionStart = size, sectionEnd = size;
    for (const row of docLines(resolved.abs)) {
      const line = row.line - header.lines;
      if (line === first) sectionStart = row.start;
      if (line === last) sectionEnd = row.start;
      if (line === first + start) from = row.start;
      if (byteOffset === undefined) {
        if (line === first + start + maxLines) until = row.start;
      } else if (row.start <= byteOffset && (row.end > byteOffset || row.start === size)) nextLine = line;
    }
    if (byteOffset !== undefined) {
      if (byteOffset < sectionStart || byteOffset > sectionEnd) return { ok: false, code: 'invalid-offset', error: 'byteOffset 越出正文/章节范围', path };
      from = byteOffset;
      for (const row of docLines(resolved.abs)) if (row.line - header.lines === nextLine + maxLines) { until = row.start; break; }
    }
    until = Math.min(until, sectionEnd);
    from = Math.min(from, until);
    const fd = openSync(resolved.abs, 'r');
    const buffer = Buffer.alloc(Math.min(budget, until - from));
    let count;
    try { count = readSync(fd, buffer, 0, buffer.length, from); } finally { closeSync(fd); }
    // Keep a whole UTF-8 code point at the byte boundary; never silently replace its tail.
    if (from + count < until) {
      let lead = count - 1;
      while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
      if (lead >= 0) {
        const byte = buffer[lead], width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
        if (lead + width > count) count = lead;
      }
    }
    if (count > 0 && (buffer[0] & 0xc0) === 0x80) return { ok: false, code: 'invalid-offset', error: 'byteOffset 位于 UTF-8 字符内部；请使用上次返回的 nextByteOffset', path };
    const text = buffer.subarray(0, count).toString('utf8');
    const end = from + count, truncated = end < sectionEnd;
    let continuationLine = nextLine;
    for (const byte of buffer.subarray(0, count)) if (byte === 10) continuationLine += 1;
    return { ok: true, path: posixRelative(cwd, resolved.abs), title: header.meta.title ?? 'unknown', layer: header.meta.layer ?? 'unknown', role: header.meta.role ?? 'unknown', when: header.meta.when ?? 'unknown', totalLines, totalBytes: size, offset: byteOffset === undefined ? start : nextLine - first, byteOffset: from, section: matched?.title, sections, lines: text === '' ? 0 : text.split(NL).length - (text.endsWith(NL) ? 1 : 0), text, truncated, nextOffset: truncated ? continuationLine - first : undefined, nextByteOffset: truncated ? end : undefined, ...(truncated ? { hint: '还有内容：read path 加 offset=' + (continuationLine - first) + ' 与 byteOffset=' + end + (needle ? '、section=' + section : '') + ' 续读' } : {}) };
  } catch (error) { return { ok: false, code: 'unreadable', error: '读不到文档：' + String(error?.code ?? error), path: String(path ?? '') }; }
}

/** 跨会话文档检索：只回 path:line + 摘要，不整篇 dump。 */
export function searchDocs(cwd, query, { limit = DOC_LIMITS.searchLimit, include = 'all' } = {}) {
  const needle = String(query ?? '').trim();
  if (needle === '') return { ok: false, code: 'empty-query', error: 'query 不能为空' };
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : DOC_LIMITS.searchLimit;
  const index = buildDocIndex(cwd, { include: include === 'all' ? 'all' : 'index' });
  const matches = [];
  let scanned = 0;
  let truncated = false;
  const lower = needle.toLowerCase();
  for (const entry of index.entries) {
    if (matches.length >= max) { truncated = true; break; }
    let text;
    try {
      if (entry.bytes > DOC_LIMITS.maxReadBytes) continue;
      text = readFileSync(join(cwd, entry.path), 'utf8');
    } catch { continue; }
    scanned += 1;
    const lines = splitLines(text);
    for (let index2 = 0; index2 < lines.length; index2 += 1) {
      if (!lines[index2].toLowerCase().includes(lower)) continue;
      matches.push({ path: entry.relPath || entry.path, line: index2 + 1, layer: entry.layer, snippet: clip(lines[index2].trim(), DOC_LIMITS.searchSnippet) });
      if (matches.length >= max) { truncated = true; break; }
    }
  }
  return { ok: true, query: needle, matches, scanned, truncated, candidates: index.entries.length };
}

/** 反引号里的路径型指针（死链体检用）。 */
export function findDocPointers(text) {
  const raw = String(text ?? '');
  const tokens = raw.split(BT);
  const found = [];
  for (let index = 1; index < tokens.length; index += 2) {
    const token = tokens[index].trim();
    const pathname = token.replace(/(?::\d+(?:-\d+)?)?(?:#.*)?$/, '');
    if (token === '' || token.includes(' ')) continue;
    const lower = pathname.toLowerCase();
    if (!(lower.endsWith('.md') || lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.ndjson') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.txt'))) continue;
    if (!token.includes('/') && !lower.endsWith('.md')) continue;
    found.push(token);
  }
  return [...new Set(found)];
}

/** 会话文档体检（advisory，不阻断）。 */
export function checkSessionDocs({ workspaceRoot } = {}) {
  const cwd = String(workspaceRoot ?? process.cwd());
  const root = relayRootOf(cwd);
  if (!existsSync(root)) return { name: 'docs', level: 'soft', ok: true, detail: '无 relay 文档目录（跳过）' };
  const index = buildDocIndex(cwd, { exhaustive: true });
  const rendered = renderDocIndex(index);
  const warnings = [];
  const docsFiles = index.all.filter((entry) => entry.relPath.startsWith(DOCS_DIR + '/'));
  const missingFrontmatter = docsFiles.filter((entry) => entry.source !== 'frontmatter');
  if (missingFrontmatter.length > 0) warnings.push('docs/ 内 ' + missingFrontmatter.length + ' 份缺 frontmatter（role/layer/when）：' + missingFrontmatter.slice(0, 3).map((entry) => entry.relPath).join(', '));
  const roles = new Map();
  for (const entry of index.all) if (entry.role !== '' && entry.role !== 'unknown' && entry.layer !== 'raw') roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
  const duplicate = [...roles].filter(([, count]) => count > 1);
  if (duplicate.length > 0) warnings.push('重复 role：' + duplicate.slice(0, 3).map(([role, count]) => role + ' x' + count).join(', '));
  const l1 = index.all.filter((entry) => entry.layer === 'L1');
  const oversize = l1.filter((entry) => entry.bytes > DOC_LIMITS.l1WarnBytes);
  if (oversize.length > 0) warnings.push('L1 超 ' + (DOC_LIMITS.l1WarnBytes / 1024) + 'KB（advisory）：' + oversize.map((entry) => entry.relPath).join(', '));
  const pointers = [];
  const diagnose = (source, pointer, reason, suggestion) => pointers.push({ source, path: pointer, reason, suggestion });
  const checkPath = (source, pointer) => {
    const path = pointer.replace(/(?::\d+(?:-\d+)?)?(?:#.*)?$/, '');
    if (/^(?:https?:|mailto:)/.test(path)) return;
    const candidates = [resolve(cwd, path), resolve(root, path), resolve(root, source.split('/').slice(0, -1).join('/'), path)];
    const realCwd = safeRealpath(cwd);
    const target = candidates.find((item) => existsSync(item));
    if (!target) return diagnose(source, pointer, '目标不存在', '确认文件是否归档/换代；relay_doc list include=all 找到现路径并更新指针');
    const real = safeRealpath(target);
    if (!real || !realCwd || !isInside(realCwd, real)) return diagnose(source, pointer, '路径或符号链接越出 workspace/不可解析', '改为工作区内可解析的相对路径；不要复制工作区外内容');
    const version = pointer.match(/#(?:version|v)=([^&]+)/)?.[1];
    if (version) {
      let actual;
      try { const meta = docHeader(target).meta; actual = meta.version ?? meta.v; } catch { /* 诊断下方显式 unknown */ }
      if (actual !== version) diagnose(source, pointer, actual === undefined ? '目标版本 unknown' : '版本不匹配：期望 ' + version + '，实际 ' + actual, '核对目标 frontmatter 的 version/v 与交接快照；更新版本或改指向对应归档');
    }
    const seq = pointer.match(/#seq=([^&]+)/)?.[1];
    if (seq && !/^\d+(?:-\d+)?$/.test(seq)) diagnose(source, pointer, 'seq 格式无效', '填写非负整数 seq 或递增范围 start-end，并保留来源 session_id');
    else if (seq && Number(seq.split('-')[0]) > Number(seq.split('-').at(-1))) diagnose(source, pointer, 'seq 范围倒置', '核对来源事件，将 seq 起止改为非负递增范围');
  };
  for (const entry of index.all.filter((item) => LAYERS.has(item.layer))) {
    try {
      for (const row of docLines(join(cwd, entry.path), Infinity)) {
        const source = entry.relPath + ':' + (row.line + 1);
        for (const pointer of findDocPointers(row.text)) checkPath(source, pointer);
        for (const match of row.text.matchAll(/\]\(([^\s)]+)\)/g)) if (!/^(?:https?:|mailto:|#)/.test(match[1])) checkPath(source, match[1]);
        for (const match of row.text.matchAll(/session_event_read\(\{([^}]+)\}\)/g)) {
          const seq = match[1].match(/\bseq\s*:\s*([^,}]+)/)?.[1]?.trim();
          const session = match[1].match(/\bsession_id\s*:\s*['"]([^'"]+)['"]/)?.[1];
          if (!session || !/^\d+$/.test(seq ?? '')) diagnose(source, match[0], '来源 session_id 或 seq 无效/缺失', '补齐来源会话和非负整数 seq，再用 session_event_read 精确核验');
        }
      }
    } catch (error) { diagnose(entry.relPath, entry.path, '无法检查：' + String(error?.code ?? error), '检查文件权限与路径后重跑 relay_doc lint'); }
  }
  // Chain pointers retain their source/version/sequence independently of Markdown layers.
  for (const name of readdirSync(root).filter((name) => /^chain(?:-archive-[^/]+)?[.]ndjson$/.test(name))) {
    const full = join(root, name), real = safeRealpath(full), realRoot = safeRealpath(root);
    if (!real || !realRoot || !isInside(realRoot, real)) { diagnose(name, name, '链式索引越界/不可解析', '恢复 relay 根内普通索引文件后重跑 lint'); continue; }
    for (const row of docLines(full, Infinity)) {
      if (!row.text.trim()) continue;
      const source = name + ':' + (row.line + 1);
      let record;
      try { record = JSON.parse(row.text); } catch { diagnose(source, name, '索引 JSON 无效', '从归档/日志恢复该行，保留源副本后修复 JSON'); continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) { diagnose(source, name, '索引记录不是对象', '恢复包含 v/sessionId/seq/文件指针的记录'); continue; }
      if (record.v !== 1) diagnose(source, name, '索引版本 ' + String(record.v ?? 'unknown') + '，支持 v=1', '核对生成版本，使用匹配版本读取或保留原文后迁移为 v=1');
      if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) diagnose(source, name, '来源 sessionId 缺失', '从交接单/事件日志补齐来源会话 id');
      const start = record.shadowedStart, end = record.shadowedEnd;
      if ((start !== undefined || end !== undefined) && (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start)) diagnose(source, name, 'seq 遮蔽区间无效/不完整', '核对来源 sessionId 的压缩事件，补齐非负递增 shadowedStart/shadowedEnd');
      for (const key of ['briefPath', 'handoffPath']) if (record[key]) checkPath(source, String(record[key]));
    }
  }
  if (index.counts.truncated || index.truncated) warnings.push('扫描达到上限；拆分目录后重跑 lint，未检查部分不算通过');
  if (pointers.length > 0) warnings.push('坏指针 ' + pointers.length + ' 条：' + pointers.map((item) => item.source + ' > ' + item.path + '：' + item.reason + '；修复：' + item.suggestion).join('；'));
  const detail = 'L1 ' + l1.length + ' / L2 ' + index.all.filter((entry) => entry.layer === 'L2').length + ' / raw ' + index.counts.raw + ' · 索引 ' + rendered.bytes + 'B/' + DOC_LIMITS.indexBytes + 'B' + (warnings.length === 0 ? ' · 无 warning' : ' · ' + warnings.join('；'));
  return { name: 'docs', level: 'soft', ok: warnings.length === 0, detail, warnings, pointers, seqVerification: 'unknown：本地 lint 仅验来源/seq/版本结构；事件是否存在须 session_event_read 核验' };
}

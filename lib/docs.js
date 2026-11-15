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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
const ALLOW_DIRS = new Set(['docs', 'architecture', 'research', 'reports']);
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
  if (/^handoff-[^/]+[.]md$/i.test(name)) return { kind: 'handoff', layer: 'L1', role: '交接快照', when: '新会话接手先读（最新的优先）' };
  if (/^phase-[a-z]+-[^/]+[.]md$/i.test(name)) return { kind: 'brief', layer: 'L1', role: 'phase brief', when: '压缩后/阶段交接先读' };
  if (name === 'progress.md') return { kind: 'progress', layer: 'L1', role: '滚动进度', when: '需要长线状态/决策时读头部' };
  if (name === 'lessons.md') return { kind: 'lessons', layer: 'L1', role: '经验存档', when: '跨 phase 复用做法/踩坑前' };
  if (name === 'decisions.md') return { kind: 'decisions', layer: 'L2', role: '关键决策', when: '需要知道「为什么这么做」时' };
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
  let text = '';
  if (stat.size <= DOC_LIMITS.maxReadBytes) {
    try { text = readFileSync(absolutePath, 'utf8'); } catch { return undefined; }
  }
  const parsed = parseFrontmatter(text);
  const meta = parsed.meta;
  const metaLayer = typeof meta.layer === 'string' ? meta.layer.trim() : '';
  const layer = LAYERS.has(metaLayer) ? metaLayer : (metaLayer === 'raw' || metaLayer === 'L3' ? 'raw' : base.layer);
  return {
    path: posixRelative(cwd, absolutePath),
    relPath,
    name: absolutePath.split(sep).pop() ?? relPath,
    title: typeof meta.title === 'string' ? meta.title : '',
    role: typeof meta.role === 'string' && meta.role !== '' ? meta.role : base.role,
    when: typeof meta.when === 'string' && meta.when !== '' ? meta.when : base.when,
    layer,
    kind: base.kind,
    owner: typeof meta.owner === 'string' ? meta.owner : '',
    updated: typeof meta.updated === 'string' && meta.updated !== '' ? meta.updated : isoDay(stat.mtimeMs),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    source: parsed.hasFrontmatter ? 'frontmatter' : 'legacy',
  };
}

function walkMarkdown(dir, state, depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (state.files.length >= DOC_LIMITS.maxScanFiles) { state.truncated = true; return; }
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // 顶层只进白名单目录；白名单目录内部可继续递归（docs/** 等），深度上限 4。
      if (depth === 0 && !ALLOW_DIRS.has(entry.name)) continue;
      if (depth >= 4) continue;
      walkMarkdown(full, state, depth + 1);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    state.files.push(full);
  }
}

/** 扫描会话文档树（只读）。 */
export function scanDocs(cwd, { dir } = {}) {
  const root = typeof dir === 'string' && dir !== '' ? resolve(dir) : relayRootOf(cwd);
  const state = { files: [], truncated: false };
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
export function buildDocIndex(cwd, { include = 'index' } = {}) {
  const scanned = scanDocs(cwd);
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

/** 有界读取一份会话文档（L2 按需访问入口）。 */
export function readDoc(cwd, path, { section, offset = 0, limit = DOC_LIMITS.readLines, maxBytes = DOC_LIMITS.readBytes } = {}) {
  const resolved = resolveDocPath(cwd, path);
  if (resolved.error !== undefined) return { ok: false, code: 'invalid-path', error: resolved.error, path: String(path ?? '') };
  let text;
  let size;
  try {
    size = statSync(resolved.abs).size;
    if (size > DOC_LIMITS.maxReadBytes) return { ok: false, code: 'too-large', error: '文档超过 maxReadBytes=' + DOC_LIMITS.maxReadBytes + '，请用 offset/limit 分段或官方 read 工具', path };
    text = readFileSync(resolved.abs, 'utf8');
  } catch (error) {
    return { ok: false, code: 'unreadable', error: '读不到文档：' + String(error?.code ?? error), path: String(path ?? '') };
  }
  const parsed = parseFrontmatter(text);
  const bodyLines = splitLines(parsed.body);
  const sections = headingsOf(parsed.body);
  let startLine = 0;
  let endLine = bodyLines.length;
  let matchedSection;
  if (typeof section === 'string' && section.trim() !== '') {
    const needle = section.trim().toLowerCase();
    matchedSection = sections.find((item) => item.title.toLowerCase() === needle)
      ?? sections.find((item) => item.title.toLowerCase().startsWith(needle))
      ?? sections.find((item) => item.title.toLowerCase().includes(needle));
    if (matchedSection === undefined) {
      return { ok: false, code: 'section-not-found', error: '未找到标题包含「' + section + '」的章节', path, sections };
    }
    startLine = matchedSection.line;
    const next = sections.find((item) => item.line > matchedSection.line && item.level <= matchedSection.level);
    endLine = next === undefined ? bodyLines.length : next.line;
  }
  const start = Math.max(0, Number.isInteger(offset) && offset >= 0 ? offset : 0);
  const maxLines = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : DOC_LIMITS.readLines;
  const picked = [];
  let used = 0;
  let index = startLine + start;
  for (; index < endLine && picked.length < maxLines; index += 1) {
    const line = bodyLines[index] ?? '';
    const size2 = bytesOf(line) + 1;
    if (used + size2 > maxBytes && picked.length > 0) break;
    picked.push(line);
    used += size2;
  }
  const nextOffset = index < endLine ? index - startLine : undefined;
  const truncated = index < endLine;
  const out = {
    ok: true,
    path: posixRelative(cwd, resolved.abs),
    title: typeof parsed.meta.title === 'string' ? parsed.meta.title : '',
    layer: typeof parsed.meta.layer === 'string' ? parsed.meta.layer : '',
    role: typeof parsed.meta.role === 'string' ? parsed.meta.role : '',
    when: typeof parsed.meta.when === 'string' ? parsed.meta.when : '',
    totalLines: bodyLines.length,
    totalBytes: size,
    offset: start,
    section: matchedSection === undefined ? undefined : matchedSection.title,
    sections,
    lines: picked.length,
    text: picked.join(NL),
    truncated,
    nextOffset,
  };
  if (truncated) out.hint = '还有内容：read path 加 offset=' + nextOffset + ' 或 section=<标题> 精读';
  return out;
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
    const token = tokens[index].trim().split(':')[0].trim();
    if (token === '' || token.includes(' ')) continue;
    const lower = token.toLowerCase();
    if (!(lower.endsWith('.md') || lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.txt'))) continue;
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
  const index = buildDocIndex(cwd);
  const rendered = renderDocIndex(index);
  const warnings = [];
  const docsFiles = index.all.filter((entry) => entry.relPath.startsWith(DOCS_DIR + '/'));
  const missingFrontmatter = docsFiles.filter((entry) => entry.source !== 'frontmatter');
  if (missingFrontmatter.length > 0) warnings.push('docs/ 内 ' + missingFrontmatter.length + ' 份缺 frontmatter（role/layer/when）：' + missingFrontmatter.slice(0, 3).map((entry) => entry.relPath).join(', '));
  const roles = new Map();
  for (const entry of index.all) if (entry.role !== '' && entry.layer !== 'raw') roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
  const duplicate = [...roles].filter(([, count]) => count > 1);
  if (duplicate.length > 0) warnings.push('重复 role：' + duplicate.slice(0, 3).map(([role, count]) => role + ' x' + count).join(', '));
  const l1 = index.all.filter((entry) => entry.layer === 'L1');
  const oversize = l1.filter((entry) => entry.bytes > DOC_LIMITS.l1WarnBytes);
  if (oversize.length > 0) warnings.push('L1 超 ' + (DOC_LIMITS.l1WarnBytes / 1024) + 'KB（advisory）：' + oversize.map((entry) => entry.relPath).join(', '));
  const broken = [];
  for (const entry of l1.slice(0, 8)) {
    let text;
    try {
      if (entry.bytes > DOC_LIMITS.maxReadBytes) continue;
      text = readFileSync(join(cwd, entry.path), 'utf8');
    } catch { continue; }
    for (const pointer of findDocPointers(text)) {
      if (!existsSync(resolve(cwd, pointer)) && !existsSync(resolve(relayRootOf(cwd), pointer))) broken.push(entry.relPath + ' > ' + pointer);
    }
  }
  if (broken.length > 0) warnings.push('坏指针 ' + broken.length + ' 条（L1 前 8 份抽样）：' + broken.slice(0, 3).join('；'));
  const detail = 'L1 ' + l1.length + ' / L2 ' + index.all.filter((entry) => entry.layer === 'L2').length + ' / raw ' + index.counts.raw + ' · 索引 ' + rendered.bytes + 'B/' + DOC_LIMITS.indexBytes + 'B' + (warnings.length === 0 ? ' · 无 warning' : ' · ' + warnings.join('；'));
  return { name: 'docs', level: 'soft', ok: warnings.length === 0, detail, warnings };
}

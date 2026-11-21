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
 *   constraints: 先读 docs/x.md; 预算 2KB   # 可选，; 分隔（AOCI S；无约束写 none）
 *   contracts: relay_doc index 返回 digest  # 可选（AOCI A；仅契约类文档）
 *   relations: supersedes: docs/old.md, architecture/new.md  # 可选，, 分隔，≤8（AOCI R；related 一跳）
 *   ---
 *
 * 只读扫描 + 文本处理 + 有界读取，不写任何文件；异常一律降级为结构化结果。
 *
 * @module dsh-context-relay/docs
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { countSemantic, formatSingle, isDecisionDoc, normalizePins, pinOverflowOf, renderIndex, selectIndex, workspacePinsOf } from './docs-policy.js';
import { normalizeDocList } from './policy.js';

export const RELAY_ROOT = '.scratch/context-relay';
export const DOCS_DIR = 'docs';
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BT = String.fromCharCode(96);
const NUL = String.fromCharCode(0);

/** 文档系统的 advisory 上限：只影响索引/读取的有界性，不做硬拒绝。 */
export const DOC_LIMITS = Object.freeze({
  /**
   * 索引字节预算：0 = 不限（缺省）。索引去折叠：字节不再触发 A→B/C 降级；
   * 只有调用方显式传 maxBytes>0（工具/测试）时才保留字节护栏。截断事实一律走 truncated/WARN，不静默丢。
   */
  indexBytes: 0,
  /** docs.width 的配置表示例值（README 配置表来源）；渲染缺省不传 width（= 不限列），只在显式配置 docs.width 时触发 A→B。 */
  indexWidth: 1024,
  readLines: 120,
  readBytes: 8192,
  searchLimit: 20,
  searchSnippet: 160,
  l1WarnBytes: 16384,
  docWarnBytes: 65536,
  maxScanFiles: 4000,
  maxReadBytes: 524288,
});

const SKIP_DIRS = new Set(['tmp', 'logs', 'node_modules', '.git', 'team']);
/** 只扫描这些子目录（其余如 d1-upload/ 部署暂存、logs/ 一律跳过，防止 4000 文件上限被污染）。 */
const ALLOW_DIRS = new Set(['docs', 'architecture', 'research', 'decisions', 'reports', 'archive']);
/** 默认扫描深度（exhaustive 不设限）；更深目录会超出 relay_doc index/list/search 的视野，lint 必须 WARN。 */
const DEFAULT_SCAN_DEPTH = 4;
/** v0.11 legacy 渲染（docs.select=legacy 真回滚）保留原 2048B 字节预算与折叠，不受 v2 的 indexBytes=0（不限）影响。 */
const LEGACY_INDEX_BYTES = 2048;
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

/** relations 单条上限（advisory；超出部分不解析，由 lint WARN 报数——不静默丢）。 */
export const DOC_RELATION_LIMIT = 8;

/**
 * AOCI R：解析 frontmatter `relations`（`,`/`;`/`；` 分隔，≤8，可带
 * `supersedes:`/`implements:`/`evidence_for:` 前缀，也可写成 `type path`）。
 * 路径走 normalizeDocList 白名单（绝对路径/`~`/`..` 记为 invalid，交给 lint advisory）；
 * `none` = 显式无关系。只存声明，不展开（related 一跳由反向索引回答）。
 * overflow = 去重后超出 DOC_RELATION_LIMIT 的条数（交给 lint WARN，不静默丢弃）。
 */
export function parseRelationsDetailed(value) {
  const relations = [];
  const seen = new Set();
  let overflow = 0;
  for (const piece of String(value ?? '').split(/[,;；]/)) {
    const text = piece.trim();
    if (text === '' || /^none$/i.test(text)) continue;
    const match = text.match(/^(supersedes|implements|evidence_for)(?:\s*[:：]\s*|\s+)(.+)$/i);
    const type = match === null ? '' : match[1].toLowerCase();
    const raw = match === null ? text : match[2].trim();
    const [target] = normalizeDocList([raw]);
    const relation = target === undefined ? { type, target: raw, invalid: true } : { type, target };
    const key = type + ':' + relation.target;
    if (seen.has(key)) continue;
    seen.add(key);
    if (relations.length >= DOC_RELATION_LIMIT) { overflow += 1; continue; }
    relations.push(relation);
  }
  return { relations, overflow };
}

/** 兼容入口：只要 relations 数组（overflow 见 parseRelationsDetailed 与 entry.relationsOverflow）。 */
export function parseRelations(value) {
  return parseRelationsDetailed(value).relations;
}

/** relations 目标 → relay 相对路径（`.scratch/context-relay/` 前缀归一）。 */
function relationRelOf(target) {
  const text = String(target ?? '').replace(/^\.\//, '');
  return text.startsWith(RELAY_ROOT + '/') ? text.slice(RELAY_ROOT.length + 1) : text;
}

/** relations 目标是否存在（relay 根或 workspace 相对路径；白名单已在解析时过滤）。 */
function relationExists(cwd, relation) {
  if (relation?.invalid === true) return false;
  const target = String(relation?.target ?? '');
  return [resolve(relayRootOf(cwd), target), resolve(cwd, target)].some((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
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
  const { relations, overflow: relationsOverflow } = parseRelationsDetailed(meta.relations);
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
    // relay-docs-v2 §3（additive）：选择层用 constraints/contracts 判「带决策」；
    // metaRole/metaWhen 记录 frontmatter 是否显式给了 role/when（legacy 默认不算）。
    // countSemantic：AOCI S/A 条数（; 分隔、none=0）→ L0 的 !n / An 标记与 schema lint。
    constraints: typeof meta.constraints === 'string' ? meta.constraints : '',
    contracts: typeof meta.contracts === 'string' ? meta.contracts : '',
    constraintsCount: countSemantic(meta.constraints),
    contractsCount: countSemantic(meta.contracts),
    // AOCI R：relations 声明（类型前缀可省）→ L0 的 →n 标记、related 出/入边与 lint 坏指针。
    relations,
    relationsCount: relations.length,
    relationsOverflow,
    metaRole: typeof meta.role === 'string' && meta.role !== '',
    metaWhen: typeof meta.when === 'string' && meta.when !== '',
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
      // 顶层只进白名单目录；白名单目录内部可继续递归（docs/** 等）。
      if (depth === 0 && !ALLOW_DIRS.has(entry.name)) continue;
      // 超出默认深度的目录：exhaustive 仍递归（lint 要全量查），默认扫描跳过并记 truncated；
      // 两种情况都记进 deepDirs，交给 lint WARN——默认索引/搜索看不到它们，不能静默丢。
      if (depth >= DEFAULT_SCAN_DEPTH) state.deepDirs.push(posixRelative(state.root, full));
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
  const state = { files: [], truncated: false, deepDirs: [], maxFiles: exhaustive ? Infinity : DOC_LIMITS.maxScanFiles, maxDepth: exhaustive ? Infinity : DEFAULT_SCAN_DEPTH, root };
  if (existsSync(root)) walkMarkdown(root, state);
  const entries = [];
  for (const file of state.files) {
    let stat;
    try { stat = statSync(file); } catch { continue; }
    const entry = entryOf(cwd, file, stat);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, scanned: state.files.length, truncated: state.truncated, root, deepDirs: state.deepDirs };
}

/**
 * 扫描截断的可见化（relay-doc lint 用；纯函数）：达到文件上限、超出默认深度。
 * 默认索引/搜索覆盖不到的文档必须能从这里看到，不静默丢（relations 超限由 checkSessionDocs 单独报数）。
 */
export function scanLimitWarnings({ total = 0, deepDirs = [], maxScanFiles = DOC_LIMITS.maxScanFiles } = {}) {
  const warnings = [];
  if (total > maxScanFiles) warnings.push('文档数 ' + total + ' 超默认扫描上限 ' + maxScanFiles + '：relay_doc index/list/search 只覆盖前 ' + maxScanFiles + ' 份；按目录拆分或归档后重跑 relay_doc lint');
  if (deepDirs.length > 0) warnings.push('默认扫描深度 ' + DEFAULT_SCAN_DEPTH + '：' + deepDirs.length + ' 个更深目录不在 relay_doc index/list/search 视野（清单位于结构化 deepDirs；用 relay_doc read <path> 直取或上移到 ≤' + DEFAULT_SCAN_DEPTH + ' 层）：' + deepDirs.slice(0, 3).join(', ') + (deepDirs.length > 3 ? ' 等' : ''));
  return warnings;
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
export function buildDocIndex(cwd, { include = 'index', exhaustive = false, pins = [] } = {}) {
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
    deep: scanned.deepDirs.length,
    relationOverflow: sorted.filter((entry) => entry.relationsOverflow > 0).length,
  };
  // AOCI R 反向索引：扫描时一次算好「谁引用了谁」，related 一跳直接查；不递归、不进 L0。
  const relPaths = new Set(sorted.map((entry) => entry.relPath));
  const backlinks = new Map();
  for (const entry of sorted) {
    for (const relation of entry.relations) {
      if (relation.invalid === true) continue;
      const target = relationRelOf(relation.target);
      if (target === entry.relPath || !relPaths.has(target)) continue;
      const bucket = backlinks.get(target);
      if (bucket === undefined) backlinks.set(target, [{ source: entry.relPath, type: relation.type }]);
      else bucket.push({ source: entry.relPath, type: relation.type });
    }
  }
  return { entries, all: sorted, counts, truncated: scanned.truncated, root: scanned.root, deepDirs: scanned.deepDirs, topHandoffs, topBriefs, pins: normalizePins(pins), backlinks };
}

/** 单条索引行：path — role（when）· size · updated（保留旧导出签名）。 */
export function formatIndexEntry(entry, { withWhen = true } = {}) {
  return formatSingle(entry, { withWhen });
}

/** v0.11 单条索引行（docs.select=legacy 真回滚用：不带 v0.12 语义标记）。 */
function formatLegacyEntry(entry, { withWhen = true } = {}) {
  const parts = [BT + (entry.relPath || entry.path) + BT, '—', entry.role === '' ? '（未标注作用）' : entry.role];
  if (withWhen && entry.when !== '') parts.push('（' + entry.when + '）');
  const size = entry.bytes >= 1024 ? (entry.bytes / 1024).toFixed(1) + 'KB' : entry.bytes + 'B';
  parts.push('· ' + size, '· ' + entry.updated);
  return '- ' + parts.join(' ');
}

/** v0.11 目录键。 */
function legacyDirOf(relPath) {
  const cut = relPath.lastIndexOf('/');
  return cut < 0 ? '' : relPath.slice(0, cut);
}

/** v0.11 折叠组行（dir=null 表示极端预算下的「全部折叠」）。 */
function formatLegacyGroup(dir, members) {
  const reps = members.slice(0, 3).map((entry) => BT + (entry.relPath || entry.path) + BT).join('、');
  const label = dir === null ? '全部折叠' : dir === '' ? '（根目录）' : dir + '/';
  const command = dir === null || dir === ''
    ? BT + 'relay_doc list include=all' + BT
    : BT + 'relay_doc list prefix=' + dir + BT;
  return '- ' + label + ' — ' + members.length + ' 份（代表：' + reps + '）· ' + command + ' 展开';
}

/**
 * v0.11 索引渲染（docs.select=legacy 真回滚）：L1/L2 全单列 + 按目录折最大组 + 历史产物尾行；
 * 不消费在役/决策选择、不消费 pin、无 A/B/C 层级。逐行对齐 2eea328^:lib/docs.js:267-333。
 * 固定 fixture 的完整输出由 test/legacy-golden.test.mjs 逐字节锁定（改渲染必须显式更新 golden）。
 */
export function renderLegacyIndex(index, { maxBytes = LEGACY_INDEX_BYTES } = {}) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const all = Array.isArray(index?.all) ? index.all : entries;
  const singles = entries.filter((entry) => entry.layer === 'L1' || entry.layer === 'L2');
  const nonListed = Math.max(0, all.length - singles.length);
  const header = '## 文档索引（插件生成 L0；路径相对 ' + RELAY_ROOT + '/）';
  const tail = nonListed > 0 ? ['- 另有 ' + nonListed + ' 份历史产物未入索引（reports/归档等）：用 ' + BT + 'relay_doc search <关键词>' + BT + ' 或 ' + BT + 'relay_doc list include=all' + BT + ' 取'] : [];
  const keep = singles.length > 0 ? singles[0] : undefined;
  let visible = [...singles];
  let groups = [];
  const build = () => {
    const l1 = visible.filter((entry) => entry.layer === 'L1');
    const l2 = visible.filter((entry) => entry.layer === 'L2');
    const out = [header];
    if (l1.length > 0) out.push('### 先读（L1）', ...l1.map((entry) => formatLegacyEntry(entry)));
    if (l2.length > 0) out.push('### 按需（L2）', ...l2.map((entry) => formatLegacyEntry(entry)));
    if (groups.length > 0) out.push('### 折叠（按目录，展开即取全）', ...groups.map((group) => formatLegacyGroup(group.dir, group.members)));
    out.push(...tail);
    return out.join(NL);
  };
  let text = build();
  let guard = 0;
  // 字节护栏只在显式 maxBytes>0 时生效（legacy 缺省 LEGACY_INDEX_BYTES=2048）；保留第一条单列作为入口（避免 shown=0 时注入被跳过）。
  const capped = Number.isFinite(maxBytes) && maxBytes > 0;
  while (capped && bytesOf(text) > maxBytes && guard < 400) {
    const candidates = visible.filter((entry) => entry !== keep);
    if (candidates.length === 0) break;
    const byDir = new Map();
    for (const entry of candidates) {
      const dir = legacyDirOf(entry.relPath || entry.path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(entry);
    }
    let bestDir = '';
    let bestMembers = [];
    for (const [dir, members] of byDir) if (members.length > bestMembers.length) { bestDir = dir; bestMembers = members; }
    const chosen = new Set(bestMembers);
    visible = visible.filter((entry) => !chosen.has(entry));
    groups = [...groups, { dir: bestDir, members: bestMembers }];
    text = build();
    guard += 1;
  }
  // 极端预算：组行本身也放不下时合并成一行（仍带计数与命令）。
  if (capped && bytesOf(text) > maxBytes && groups.length > 1) {
    groups = [{ dir: null, members: groups.flatMap((group) => group.members) }];
    text = build();
  }
  // 极端预算下也只降级为「计数 + 展开命令」的最短形态：宁可略超 maxBytes，也不留无命令省略。
  if (capped && bytesOf(text) > maxBytes) text = header + NL + '- 共 ' + entries.length + ' 份文档已折叠（预算 ' + maxBytes + 'B）：用 ' + BT + 'relay_doc list include=all' + BT + ' 取';
  const shown = visible.length;
  const omitted = entries.length - shown;
  return {
    text,
    bytes: bytesOf(text),
    digest: docIndexDigest(text),
    level: 'legacy',
    paths: visible.map((entry) => entry.relPath || entry.path),
    groups: groups.map((group) => {
      const command = group.dir === null || group.dir === ''
        ? BT + 'relay_doc list include=all' + BT
        : BT + 'relay_doc list prefix=' + group.dir + BT;
      return { dir: group.dir, count: group.members.length, reps: group.members.slice(0, 3).map((entry) => entry.relPath || entry.path), command, bytes: bytesOf(formatLegacyGroup(group.dir, group.members)) };
    }),
    workspacePins: [],
    collapsed: omitted,
    shown,
    omitted,
  };
}

/** 工作区 pin 只展示真实存在的文件（relay 根内文件不算工作区 pin；不存在的 relay 路径也不冒充）。 */
function workspacePinsFor(index, pins) {
  const all = Array.isArray(index?.all) ? index.all : [];
  const candidates = workspacePinsOf(pins, all);
  const relayRoot = typeof index?.root === 'string' && index.root !== '' ? index.root : undefined;
  if (relayRoot === undefined) return candidates;
  const workspaceRoot = resolve(relayRoot, '..', '..');
  return candidates.filter((pin) => {
    try {
      const abs = resolve(workspaceRoot, pin);
      return existsSync(abs) && !isInside(relayRoot, abs);
    } catch { return false; }
  });
}

/**
 * 渲染 L0 索引（relay-docs-v2 §2.2/§2.3）：
 * 先选择（在役 + 带决策单列，其余按目录成组），再层级（A/B/C，只有显式 docs.width/docs.maxGroups 触发，默认 A）。
 * 索引去折叠：maxBytes 缺省 0 = 不限，字节不再触发 A→B/C；只有调用方显式传 maxBytes>0 时才做字节护栏。
 * docs.select=legacy 直接走 v0.11 渲染（不回退成近似；legacy 仍保留原 2048B 字节预算）。
 */
export function renderDocIndex(index, { maxBytes = DOC_LIMITS.indexBytes, pins, level = 'A', width = 0, maxGroups, select = true, layout = true } = {}) {
  if (select === false) {
    // legacy 是 v0.11 真回滚：缺省仍用 2048B 字节预算（与 golden 一致），显式 maxBytes>0 可覆盖。
    const legacyBudget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : LEGACY_INDEX_BYTES;
    const legacy = renderLegacyIndex(index, { maxBytes: legacyBudget });
    // v0.11 口径：truncated = 有省略或字节超护栏（不消费索引扫描的 truncated）。
    return { ...legacy, truncated: legacy.omitted > 0 || legacy.bytes > legacyBudget };
  }
  const all = Array.isArray(index?.all) ? index.all : (Array.isArray(index?.entries) ? index.entries : []);
  // docs.layout=flat 时 renderIndex 不做 W/G 自动层级；宽度/组数可经 config docs.width/docs.maxGroups 覆盖。
  const pinList = pins === undefined ? (index?.pins ?? []) : pins;
  const workspacePins = workspacePinsFor(index, pinList);
  const renderAt = (nextLevel, health = true) => renderIndex(selectIndex(all, { pins: pinList, level: nextLevel }), { width, maxGroups, maxBytes, health, layout, workspacePins });
  let rendered = renderAt(level);
  // 字节护栏只在显式 maxBytes>0 时生效（缺省 0 = 不限）：届时先丢 health、再降单列面，最后合成一行计数 + 取回命令。
  const capped = Number.isFinite(maxBytes) && maxBytes > 0;
  if (capped && rendered.bytes > maxBytes) rendered = renderAt(level, false);
  if (capped && rendered.bytes > maxBytes && rendered.level === 'A') rendered = renderAt('B');
  if (capped && rendered.bytes > maxBytes && rendered.level === 'B') rendered = renderAt('B', false);
  if (capped && rendered.bytes > maxBytes && rendered.level !== 'C') rendered = renderAt('C', false);
  // truncated 只表示「有内容没进正文且没有命令可回取」的保底口径：扫描触顶（或显式字节护栏超限）；折叠组有命令，不算 truncated。
  return { ...rendered, truncated: index?.truncated === true || (capped && rendered.bytes > maxBytes) };
}

/** 进度文件机器块里的 key_docs（pin 的 fallback；Q2 待定前不新增工具参数）。 */
const PROGRESS_JSON_MARK = '<!-- relay-progress:json';
export function progressKeyDocs(cwd) {
  try {
    const path = join(relayRootOf(cwd), 'progress.md');
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const start = raw.indexOf(PROGRESS_JSON_MARK);
    if (start < 0) return [];
    const end = raw.indexOf('-->', start + PROGRESS_JSON_MARK.length);
    if (end < 0) return [];
    const state = JSON.parse(raw.slice(start + PROGRESS_JSON_MARK.length, end).trim());
    return Array.isArray(state?.key_docs) ? state.key_docs.filter((item) => typeof item === 'string') : [];
  } catch { return [] };
}

/** 归一化 list.prefix：接受 relay 相对目录、.scratch/context-relay/ 前缀与尾斜杠。 */
export function normalizeDocPrefix(raw) {
  let prefix = String(raw ?? '').trim();
  if (prefix === '') return '';
  prefix = prefix.replace(/^\.\//, '');
  if (prefix.startsWith(RELAY_ROOT + '/')) prefix = prefix.slice(RELAY_ROOT.length + 1);
  return prefix.replace(/\/+$/, '');
}

/** 索引内容 digest（变了才重新注入）。 */
export function docIndexDigest(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** 便捷：直接渲染当前索引（handoff/brief/relay_doc 共用）。 */
export function renderDocIndexSection(cwd, options = {}) {
  return renderDocIndex(buildDocIndex(cwd, { pins: options.pins }), options);
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

/**
 * AOCI R：一跳关系查询——出边（本文件声明）+ 入边（buildDocIndex 的反向索引）。
 * 只查一跳，不递归；不存在的目标仍返回（exists=false），交给 lint 提示。
 */
export function relatedDocs(cwd, path) {
  const resolved = resolveDocPath(cwd, path);
  if (resolved.error !== undefined) return { ok: false, code: 'invalid-path', error: resolved.error, path: String(path ?? '') };
  let isFile = false;
  try { isFile = statSync(resolved.abs).isFile(); } catch { isFile = false; }
  if (!isFile) return { ok: false, code: 'not-found', error: '文档不存在', path: String(path ?? '') };
  const index = buildDocIndex(cwd, { include: 'all' });
  const relPath = posixRelative(relayRootOf(cwd), resolved.abs);
  const entry = index.all.find((item) => item.relPath === relPath);
  const out = (entry?.relations ?? []).map((relation) => ({
    type: relation.type,
    path: relationRelOf(relation.target),
    exists: relationExists(cwd, relation),
  }));
  const incoming = index.backlinks.get(relPath) ?? [];
  return { ok: true, path: relPath, out, in: incoming.map((link) => ({ source: link.source, type: link.type })) };
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

/** L2 文档 updated 超过这么多天算陈旧（advisory WARN；contracts 无法判断新旧时要明说）。 */
export const DOC_STALE_DAYS = 90;
/** 结构化 pointers 里保留的 advisory 明细条数；其余只按原因计数（不静默丢，也不让清单无界膨胀）。 */
export const DOC_ADVISORY_POINTER_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 活跃文档 = 先读层（L1）+ 当前 decisions/architecture：坏指针 FAIL；其余（普通 L2 / raw reports）只 WARN。 */
function isActiveDoc(entry) {
  return entry.layer === 'L1' || entry.kind === 'architecture' || isDecisionDoc(entry);
}

/**
 * 会话文档体检。分级（relay-doc 坏指针）：
 *   活跃文档（L1 + decisions/architecture 当前）坏指针 → level='hard'（docLint 汇总为 FAIL）；
 *   其余（普通 L2、reports/归档）→ 只 WARN，数量与首条进 detail，完整清单进 pointers。
 * relations/深度/文件数/relations 超限等原先的静默截断一律转 WARN；detail 只给计数 + 首条 + 取全清单的路径
 * （relay_doc lint 的 pointers / warnings 字段），避免 2KB 摘要把 warning 挤掉。
 */
export function checkSessionDocs({ workspaceRoot } = {}) {
  const cwd = String(workspaceRoot ?? process.cwd());
  const root = relayRootOf(cwd);
  if (!existsSync(root)) return { name: 'docs', level: 'soft', ok: true, detail: '无 relay 文档目录（跳过）', warnings: [], pointers: [], activePointers: 0, advisoryPointers: 0, deepDirs: [] };
  const keyDocs = progressKeyDocs(cwd);
  const index = buildDocIndex(cwd, { exhaustive: true, pins: keyDocs });
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
  const l2 = index.all.filter((entry) => entry.layer === 'L2');
  // AOCI 语义层 schema：constraints 覆盖全部 L2（原只查 architecture/decisions；无约束写 constraints: none，
  // 无 frontmatter 的旧文档先补 frontmatter）。research/report 不再豁免 L2 这一条。
  const missingConstraints = l2.filter((entry) => String(entry.constraints ?? '').trim() === '');
  if (missingConstraints.length > 0) warnings.push('L2 缺 constraints ' + missingConstraints.length + ' 份（advisory；无约束写 constraints: none，无 frontmatter 先补）：' + missingConstraints.slice(0, 3).map((entry) => entry.relPath).join(', ') + (missingConstraints.length > 3 ? ' 等' : ''));
  // contracts/updated 陈旧：L2 的 updated 无效 → WARN；超过 DOC_STALE_DAYS → WARN；声明 contracts 却无 updated → WARN。
  const invalidUpdated = [];
  const staleUpdated = [];
  const contractsWithoutUpdated = [];
  const nowMs = Date.now();
  for (const entry of l2) {
    const updated = String(entry.updated ?? '');
    if (updated === '' || updated === 'unknown') {
      if (entry.contractsCount > 0) contractsWithoutUpdated.push(entry);
      continue;
    }
    const ms = YMD_RE.test(updated) ? Date.parse(updated + 'T00:00:00Z') : NaN;
    if (!Number.isFinite(ms)) { invalidUpdated.push(entry.relPath + '=' + updated); continue; }
    const days = Math.floor((nowMs - ms) / DAY_MS);
    if (days > DOC_STALE_DAYS) staleUpdated.push(entry.relPath + '（' + days + ' 天）');
  }
  if (invalidUpdated.length > 0) warnings.push('L2 updated 格式无效 ' + invalidUpdated.length + ' 份（期望 YYYY-MM-DD）：' + invalidUpdated.slice(0, 3).join(', ') + (invalidUpdated.length > 3 ? ' 等' : ''));
  if (staleUpdated.length > 0) warnings.push('L2 updated 陈旧 > ' + DOC_STALE_DAYS + ' 天 ' + staleUpdated.length + ' 份（先核对内容再更新）：' + staleUpdated.slice(0, 3).join(', ') + (staleUpdated.length > 3 ? ' 等' : ''));
  if (contractsWithoutUpdated.length > 0) warnings.push('contracts 文档缺 updated ' + contractsWithoutUpdated.length + ' 份（contracts 是否陈旧无法判断）：' + contractsWithoutUpdated.slice(0, 3).map((entry) => entry.relPath).join(', ') + (contractsWithoutUpdated.length > 3 ? ' 等' : ''));
  // AOCI R（relay-audit §2.3）：relations 逐条验路径存在、无自环；一跳关系不展开，坏指针只 WARN。
  const relationIssues = [];
  for (const entry of index.all) {
    for (const relation of entry.relations) {
      if (relation.invalid === true) relationIssues.push(entry.relPath + ' → ' + relation.target + '（路径非法/越界）');
      else if (!relationExists(cwd, relation)) relationIssues.push(entry.relPath + ' → ' + relation.target + '（不存在）');
      else if (relationRelOf(relation.target) === entry.relPath) relationIssues.push(entry.relPath + ' → ' + relation.target + '（自环）');
    }
  }
  if (relationIssues.length > 0) warnings.push('关系坏指针 ' + relationIssues.length + ' 条（advisory）：' + relationIssues.slice(0, 3).join('；') + (relationIssues.length > 3 ? ' 等' : ''));
  const relationOverflowDocs = index.all.filter((entry) => entry.relationsOverflow > 0);
  if (relationOverflowDocs.length > 0) {
    const dropped = relationOverflowDocs.reduce((sum, entry) => sum + entry.relationsOverflow, 0);
    warnings.push('relations 超上限（>' + DOC_RELATION_LIMIT + ' 条）' + relationOverflowDocs.length + ' 份、多出 ' + dropped + ' 条未解析（不静默）：' + relationOverflowDocs.slice(0, 3).map((entry) => entry.relPath).join(', ') + (relationOverflowDocs.length > 3 ? ' 等' : ''));
  }
  const oversize = l1.filter((entry) => entry.bytes > DOC_LIMITS.l1WarnBytes);
  if (oversize.length > 0) warnings.push('L1 超 ' + (DOC_LIMITS.l1WarnBytes / 1024) + 'KB（advisory）' + oversize.length + ' 份：' + oversize.slice(0, 3).map((entry) => entry.relPath).join(', ') + (oversize.length > 3 ? ' 等' : ''));
  // 扫描/深度/文件数超限：默认索引/搜索看不到的部分必须显式 WARN（原先是静默 truncated）。
  warnings.push(...scanLimitWarnings({ total: index.all.length, deepDirs: index.deepDirs }));
  // progress.key_docs 超 PIN_LIMIT 时原先是静默 slice：这里报数（完整清单见 progress.md）。
  const pinOverflow = pinOverflowOf(keyDocs);
  if (pinOverflow.dropped > 0) warnings.push('progress.key_docs 超 PIN_LIMIT(' + pinOverflow.kept + '/' + pinOverflow.total + ' 保留，' + pinOverflow.dropped + ' 条未展示)：精简后重跑 relay_doc lint / relay_doc index 查看完整索引');
  const pointers = [];
  const diagnose = (source, pointer, reason, suggestion, active) => pointers.push({ source, path: pointer, reason, suggestion, severity: active ? 'fail' : 'warn' });
  const checkPath = (source, pointer, active) => {
    const path = pointer.replace(/(?::\d+(?:-\d+)?)?(?:#.*)?$/, '');
    if (/^(?:https?:|mailto:)/.test(path)) return;
    const candidates = [resolve(cwd, path), resolve(root, path), resolve(root, source.split('/').slice(0, -1).join('/'), path)];
    const realCwd = safeRealpath(cwd);
    const target = candidates.find((item) => existsSync(item));
    if (!target) return diagnose(source, pointer, '目标不存在', '确认文件是否归档/换代；relay_doc list include=all 找到现路径并更新指针', active);
    const real = safeRealpath(target);
    if (!real || !realCwd || !isInside(realCwd, real)) return diagnose(source, pointer, '路径或符号链接越出 workspace/不可解析', '改为工作区内可解析的相对路径；不要复制工作区外内容', active);
    const version = pointer.match(/#(?:version|v)=([^&]+)/)?.[1];
    if (version) {
      let actual;
      try { const meta = docHeader(target).meta; actual = meta.version ?? meta.v; } catch { /* 诊断下方显式 unknown */ }
      if (actual !== version) diagnose(source, pointer, actual === undefined ? '目标版本 unknown' : '版本不匹配：期望 ' + version + '，实际 ' + actual, '核对目标 frontmatter 的 version/v 与交接快照；更新版本或改指向对应归档', active);
    }
    const seq = pointer.match(/#seq=([^&]+)/)?.[1];
    if (seq && !/^\d+(?:-\d+)?$/.test(seq)) diagnose(source, pointer, 'seq 格式无效', '填写非负整数 seq 或递增范围 start-end，并保留来源 session_id', active);
    else if (seq && Number(seq.split('-')[0]) > Number(seq.split('-').at(-1))) diagnose(source, pointer, 'seq 范围倒置', '核对来源事件，将 seq 起止改为非负递增范围', active);
  };
  // L1/L2 + raw 全量做坏指针扫描：活跃文档 fail、其余 warn（reports/归档不再静默漏检）。
  for (const entry of index.all) {
    const active = isActiveDoc(entry);
    try {
      for (const row of docLines(join(cwd, entry.path), Infinity)) {
        const source = entry.relPath + ':' + (row.line + 1);
        for (const pointer of findDocPointers(row.text)) checkPath(source, pointer, active);
        for (const match of row.text.matchAll(/\]\(([^\s)]+)\)/g)) if (!/^(?:https?:|mailto:|#)/.test(match[1])) checkPath(source, match[1], active);
        for (const match of row.text.matchAll(/session_event_read\(\{([^}]+)\}\)/g)) {
          const seq = match[1].match(/\bseq\s*:\s*([^,}]+)/)?.[1]?.trim();
          const session = match[1].match(/\bsession_id\s*:\s*['"]([^'"]+)['"]/)?.[1];
          if (!session || !/^\d+$/.test(seq ?? '')) diagnose(source, match[0], '来源 session_id 或 seq 无效/缺失', '补齐来源会话和非负整数 seq，再用 session_event_read 精确核验', active);
        }
      }
    } catch (error) { diagnose(entry.relPath, entry.path, '无法检查：' + String(error?.code ?? error), '检查文件权限与路径后重跑 relay_doc lint', active); }
  }
  // Chain pointers retain their source/version/sequence independently of Markdown layers（raw 口径：只 WARN）。
  for (const name of readdirSync(root).filter((name) => /^chain(?:-archive-[^/]+)?[.]ndjson$/.test(name))) {
    const full = join(root, name), real = safeRealpath(full), realRoot = safeRealpath(root);
    if (!real || !realRoot || !isInside(realRoot, real)) { diagnose(name, name, '链式索引越界/不可解析', '恢复 relay 根内普通索引文件后重跑 lint', false); continue; }
    for (const row of docLines(full, Infinity)) {
      if (!row.text.trim()) continue;
      const source = name + ':' + (row.line + 1);
      let record;
      try { record = JSON.parse(row.text); } catch { diagnose(source, name, '索引 JSON 无效', '从归档/日志恢复该行，保留源副本后修复 JSON', false); continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) { diagnose(source, name, '索引记录不是对象', '恢复包含 v/sessionId/seq/文件指针的记录', false); continue; }
      if (record.v !== 1) diagnose(source, name, '索引版本 ' + String(record.v ?? 'unknown') + '，支持 v=1', '核对生成版本，使用匹配版本读取或保留原文后迁移为 v=1', false);
      if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) diagnose(source, name, '来源 sessionId 缺失', '从交接单/事件日志补齐来源会话 id', false);
      const start = record.shadowedStart, end = record.shadowedEnd;
      if ((start !== undefined || end !== undefined) && (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start)) diagnose(source, name, 'seq 遮蔽区间无效/不完整', '核对来源 sessionId 的压缩事件，补齐非负递增 shadowedStart/shadowedEnd', false);
      for (const key of ['briefPath', 'handoffPath']) if (record[key]) checkPath(source, String(record[key]), false);
    }
  }
  const failPointers = pointers.filter((item) => item.severity === 'fail');
  const warnPointers = pointers.filter((item) => item.severity !== 'fail');
  // 结构化清单：全部活跃 + 前 DOC_ADVISORY_POINTER_LIMIT 条 advisory；其余按原因计数（不静默丢，也不无界膨胀）。
  const advisoryKept = warnPointers.slice(0, DOC_ADVISORY_POINTER_LIMIT);
  const keptPointers = [...failPointers, ...advisoryKept];
  const pointerOverflow = warnPointers.length - advisoryKept.length;
  const advisoryReasons = {};
  for (const item of warnPointers) advisoryReasons[item.reason] = (advisoryReasons[item.reason] ?? 0) + 1;
  if (pointers.length > 0) {
    const first = failPointers[0] ?? warnPointers[0];
    const reasons = Object.entries(advisoryReasons).map(([reason, count]) => reason + ' x' + count).join(', ');
    // 放第一条：detail 有界（320 字）时先保住 FAIL 原因与计数，其余 warning 在结构化 warnings 里。
    warnings.unshift('坏指针 ' + pointers.length + ' 条（活跃 ' + failPointers.length + ' → FAIL / 其余 ' + warnPointers.length + ' → WARN' + (reasons === '' ? '' : '；advisory 原因 ' + reasons) + '）：首条 ' + first.source + ' > ' + first.path + '：' + first.reason + '；结构化 pointers 保留活跃全部 + 前 ' + DOC_ADVISORY_POINTER_LIMIT + ' 条 advisory（其余 ' + pointerOverflow + ' 条只计数，按 source 修复；每条含 suggestion）');
  }
  // detail 只给计数 + 前几条 warning；完整 warning 列表在结构化 warnings 字段（避免 lint 摘要静默丢 warning）。
  const boundedJoin = (list, maxChars = 320) => {
    let text = '';
    for (const item of list) {
      if (text !== '' && (text + '；' + item).length > maxChars) return text + '；…（共 ' + list.length + ' 条 warning，完整见 warnings 字段）';
      text = text === '' ? item : text + '；' + item;
    }
    return text;
  };
  const budget = DOC_LIMITS.indexBytes > 0 ? DOC_LIMITS.indexBytes + 'B' : '不限';
  const detail = 'L1 ' + l1.length + ' / L2 ' + l2.length + ' / raw ' + index.counts.raw + ' · 索引 ' + rendered.bytes + 'B/' + budget + (warnings.length === 0 ? ' · 无 warning' : ' · ' + boundedJoin(warnings));
  return {
    name: 'docs',
    level: failPointers.length > 0 ? 'hard' : 'soft',
    ok: warnings.length === 0,
    detail,
    warnings,
    pointers: keptPointers,
    pointersOmitted: pointerOverflow,
    advisoryReasons,
    activePointers: failPointers.length,
    advisoryPointers: warnPointers.length,
    deepDirs: index.deepDirs,
    seqVerification: 'unknown：本地 lint 仅验来源/seq/版本结构；事件是否存在须 session_event_read 核验',
  };
}

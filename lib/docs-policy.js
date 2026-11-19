/**
 * dsh-context-relay — relay 文档索引 v2 的选择/层级纯策略（无 IO）。
 *
 * relay-docs-v2 §2.2/§2.3：
 *   选择：在役（pin / 最新 handoff / 最新 brief / progress / lessons）+ 带决策
 *   （decisions，或 frontmatter 有 constraints/contracts 且 role/when 不是 legacy 默认）
 *   单列；其余按目录折叠为组行（份数 + 代表 1–3 + relay_doc list prefix=<目录>）。
 *   raw/reports 永不单列（只可折叠）。
 *   层级：A = 在役/决策单列 + 组行；B = 只保留 pin 单列 + 组行；C = pin + 一行计数。
 *   层由调用方给出的宽度/组数（W/G）触发，阈值等一周数据再定；默认 A 维持现行单层。
 *   不变量：任何被折叠的路径都能从组行命令 / include=all 在 ≤2 次调用内取到，
 *   不允许出现无命令的「N 条未显示」。
 *
 * @module dsh-context-relay/docs-policy
 */
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const BT = String.fromCharCode(96);

export const DOC_LEVELS = Object.freeze(['A', 'B', 'C']);
/** 在役「最新 handoff / brief」保留份数（与现行 docs.js 的 3/2 一致）。 */
export const IN_SERVICE_LIMITS = Object.freeze({ handoff: 3, brief: 2 });

const bytesOf = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
const keyOf = (entry) => entry?.relPath || entry?.path || '';
const isRaw = (entry) => entry?.layer === 'raw';
/** raw/reports 永不单列：按 kind 与路径兜底，frontmatter 把层抬到 L2 也不破这条。 */
const NEVER_SINGLE = /^(?:reports|archive)\//;
const isRawLike = (entry) => isRaw(entry) || entry?.kind === 'report' || entry?.kind === 'archive' || NEVER_SINGLE.test(keyOf(entry));
const digestOf = (text) => createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);

/** 索引行的目录键：relPath 的所在目录（根级文件为 ''）。 */
export function dirOf(relPath) {
  const cut = String(relPath ?? '').lastIndexOf('/');
  return cut < 0 ? '' : String(relPath).slice(0, cut);
}

function stripRelayPrefix(token) {
  return String(token ?? '').replace(/^\.\//, '').replace(/^\.scratch\/context-relay\//, '').replace(/^\/+/, '');
}

/** pin 允许「path — role — why」写法（key_docs 惯例）：只取破折号/中点前的路径。 */
function pinTokensOf(pin) {
  const raw = String(pin ?? '').trim().replace(/^`+|`+$/g, '');
  if (raw === '') return [];
  const token = stripRelayPrefix(raw.split(/\s+[—·]\s+/)[0].trim());
  return token === '' ? [] : [token];
}

/** 归一化 pin 列表（去重、去 relay 前缀/./、最多 32 个）。 */
export function normalizePins(pins) {
  const out = [];
  for (const pin of Array.isArray(pins) ? pins : []) {
    for (const token of pinTokensOf(pin)) if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, 32);
}

/** 条目是否被 pin（比较 relay 相对路径与 workspace 相对路径）。 */
export function isPinnedEntry(entry, pins) {
  const tokens = normalizePins(pins);
  const rel = keyOf(entry);
  const path = String(entry?.path ?? '');
  return tokens.some((token) => token === rel || token === path || token === stripRelayPrefix(path));
}

/** 带决策：decisions 目录/文件，或 frontmatter 有 constraints/contracts 且 role/when 非 legacy 默认。 */
export function isDecisionDoc(entry) {
  if (entry?.kind === 'decisions') return true;
  const annotated = (entry?.constraints ?? '') !== '' || (entry?.contracts ?? '') !== '';
  return annotated && entry?.source === 'frontmatter' && (entry?.metaRole === true || entry?.metaWhen === true);
}

function newestFirst(entries) {
  return [...entries].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
}

function dedupeByPath(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = keyOf(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 在役条目：最新 handoff/brief（按 kind 认，不要求 frontmatter）+ progress + lessons。 */
export function inServiceEntries(entries, { limits = IN_SERVICE_LIMITS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const ofKind = (kind) => newestFirst(list.filter((entry) => entry.kind === kind));
  return [
    ...ofKind('handoff').slice(0, limits.handoff ?? IN_SERVICE_LIMITS.handoff),
    ...ofKind('brief').slice(0, limits.brief ?? IN_SERVICE_LIMITS.brief),
    ...ofKind('progress'),
    ...ofKind('lessons'),
  ];
}

function singlesAt(entries, level, pins) {
  const pinned = entries.filter((entry) => !isRawLike(entry) && isPinnedEntry(entry, pins));
  if (level === 'B' || level === 'C') return dedupeByPath(pinned);
  const inService = inServiceEntries(entries).filter((entry) => !isRawLike(entry));
  const decisions = entries.filter((entry) => !isRawLike(entry) && isDecisionDoc(entry));
  return dedupeByPath([...pinned, ...inService, ...decisions]);
}

/** 组行的展开命令：目录用 prefix（子目录也覆盖），根目录用 include=all。 */
export function commandForDir(dir) {
  return String(dir ?? '') === '' ? 'relay_doc list include=all' : 'relay_doc list prefix=' + dir;
}

function groupsOf(entries) {
  const map = new Map();
  for (const entry of entries) {
    const dir = dirOf(keyOf(entry));
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir).push(entry);
  }
  return [...map.entries()]
    .map(([dir, members]) => {
      const sorted = newestFirst(members);
      return {
        dir,
        count: sorted.length,
        members: sorted,
        reps: sorted.slice(0, 3).map(keyOf),
        command: commandForDir(dir),
      };
    })
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

/**
 * 选择（relay-docs-v2 §2.2）：returns { level, singles, groups, stats, pins, entries }。
 * level 只决定「单列面」；A 默认，B 只 pin，C 只 pin（组行由 renderIndex 决定是否输出）。
 */
export function selectIndex(entries, { pins = [], level = 'A', limits } = {}) {
  const all = (Array.isArray(entries) ? entries : []).filter((entry) => entry !== null && typeof entry === 'object');
  const normalized = normalizePins(pins);
  const chosenLevel = DOC_LEVELS.includes(level) ? level : 'A';
  const singles = singlesAt(all, chosenLevel, normalized);
  const singleKeys = new Set(singles.map(keyOf));
  const rest = all.filter((entry) => !singleKeys.has(keyOf(entry)));
  const groups = groupsOf(rest);
  return {
    level: chosenLevel,
    singles,
    groups,
    stats: { total: all.length, singles: singles.length, groups: groups.length, folded: rest.length },
    pins: normalized,
    entries: all,
    limits,
  };
}

/** 单条索引行：path — role（when）· size · updated */
export function formatSingle(entry, { withWhen = true } = {}) {
  const parts = [BT + keyOf(entry) + BT, '—', (entry.role === '' || entry.role === undefined) ? '（未标注作用）' : entry.role];
  if (withWhen && entry.when !== '' && entry.when !== undefined) parts.push('（' + entry.when + '）');
  const size = entry.bytes >= 1024 ? (entry.bytes / 1024).toFixed(1) + 'KB' : entry.bytes + 'B';
  parts.push('· ' + size, '· ' + (entry.updated ?? 'unknown'));
  return '- ' + parts.join(' ');
}

/** 折叠组行：份数 + 代表 1–3 条 + 展开命令；不得出现无命令省略。 */
export function formatGroup(group) {
  const reps = group.reps.map((rel) => BT + rel + BT).join('、');
  const label = group.dir === '' ? '（根目录）' : group.dir + '/';
  return '- ' + label + ' — ' + group.count + ' 份（代表：' + reps + '）· ' + BT + group.command + BT + ' 展开';
}

const INDEX_HEADER = '## 文档索引（插件生成 L0；路径相对 .scratch/context-relay/）';

function singlesWidth(entries) {
  return entries.reduce((sum, entry) => sum + Array.from(formatSingle(entry)).length, 0);
}

/** 宽度/组数触发（W/G）：阈值由调用方给；未给时保持 sel.level（默认 A）。 */
function resolveLevel(sel, { width, maxGroups }) {
  let level = sel.level;
  if (level !== 'A') return level;
  if (Number.isFinite(width) && width > 0 && singlesWidth(sel.singles) > width) level = 'B';
  if (Number.isFinite(maxGroups) && maxGroups >= 0 && sel.groups.length > maxGroups) level = 'C';
  if (level === 'B' && Number.isFinite(width) && width > 0) {
    const pinned = sel.singles.filter((entry) => isPinnedEntry(entry, sel.pins));
    if (singlesWidth(pinned) > width) level = 'C';
  }
  return level;
}

/**
 * 渲染 L0 索引正文（relay-docs-v2 §2.3）：
 * A = 在役/决策单列 + 组行；B = 只 pin 单列 + 组行；C = pin + 一行「m 份 / n 组」。
 * 返回 { text, bytes, digest, level, paths, groups, collapsed, shown, omitted }。
 */
export function renderIndex(sel, { width, maxGroups } = {}) {
  const level = resolveLevel(sel, { width, maxGroups });
  const layout = level === sel.level ? sel : selectIndex(sel.entries, { pins: sel.pins, level });
  const singles = layout.singles;
  const pinned = singles.filter((entry) => isPinnedEntry(entry, layout.pins));
  const lines = [INDEX_HEADER];
  if (level === 'C') {
    if (pinned.length > 0) lines.push('### 在役（pin，不折叠）', ...pinned.map((entry) => formatSingle(entry)));
    if (layout.stats.folded > 0) lines.push('- 其余 ' + layout.stats.folded + ' 份文档 / ' + layout.groups.length + ' 个目录已折叠：' + BT + 'relay_doc list include=all' + BT + ' 展开');
  } else {
    const nonPinned = singles.filter((entry) => !isPinnedEntry(entry, layout.pins));
    const inService = level === 'A' ? nonPinned.filter((entry) => !isDecisionDoc(entry)) : [];
    const decisions = level === 'A' ? nonPinned.filter((entry) => isDecisionDoc(entry)) : [];
    if (pinned.length + inService.length > 0) lines.push('### 在役（先读）', ...pinned.map((entry) => formatSingle(entry)), ...inService.map((entry) => formatSingle(entry)));
    if (decisions.length > 0) lines.push('### 带决策', ...decisions.map((entry) => formatSingle(entry)));
    if (layout.groups.length > 0) lines.push('### 折叠（按目录，展开即取全）', ...layout.groups.map((group) => formatGroup(group)));
  }
  const text = lines.join(NL);
  const groups = layout.groups.map((group) => ({
    dir: group.dir,
    count: group.count,
    reps: group.reps,
    bytes: bytesOf(formatGroup(group)),
    command: group.command,
  }));
  return {
    text,
    bytes: bytesOf(text),
    digest: digestOf(text),
    level,
    paths: singles.map(keyOf),
    groups,
    collapsed: layout.stats.folded,
    shown: singles.length,
    omitted: layout.stats.folded,
  };
}

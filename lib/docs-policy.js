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
 *   头部：2 行 legend（层/标记含义：! 约束 · A 契约 · → 关系）+ health（索引字节 + L1/L2/raw 计数），超预算先丢 health。
 *   不变量：任何被折叠的路径都能从组行命令 / include=all 在 ≤2 次调用内取到，
 *   不允许出现无命令的「N 条未显示」。
 *
 * @module dsh-context-relay/docs-policy
 */
import { createHash } from 'node:crypto';

const NL = String.fromCharCode(10);
const BT = String.fromCharCode(96);

export const DOC_LEVELS = Object.freeze(['A', 'B', 'C']);

/** docs.* 回滚开关（relay-docs-v2 §2.5/§7）：默认全开；关掉逐项退回旧行为。
 *  select: false|'legacy'|'off' → 真回滚 v0.11 渲染（L1/L2 全单列 + 折最大组 + 历史尾行；无 A/B/C）
 *  layout: false|'flat'|'off' → 关闭 W/G 自动 A/B/C（只留字节护栏）
 *  metrics: false|'off' → 不写 metrics 事件（relay_status 也不带 docs 块） */
export const DEFAULT_DOCS_OPTIONS = Object.freeze({ select: true, layout: true, metrics: true });
/** docs.width / docs.maxGroups 是可选数值覆盖（缺省不返回键，保持旧配置对象形状）。 */
export function normalizeDocsOptions(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = (value, offValues) => !(value === false || offValues.includes(String(value ?? '').toLowerCase()));
  const width = Number.isFinite(source.width) && source.width > 0 ? Math.trunc(source.width) : undefined;
  const maxGroups = Number.isInteger(source.maxGroups) && source.maxGroups >= 0 ? source.maxGroups : undefined;
  return {
    select: enabled(source.select, ['legacy', 'off']),
    layout: enabled(source.layout, ['flat', 'off']),
    metrics: enabled(source.metrics, ['off']),
    ...(width === undefined ? {} : { width }),
    ...(maxGroups === undefined ? {} : { maxGroups }),
  };
}
/** 在役「最新 handoff / brief」保留份数（与现行 docs.js 的 3/2 一致）。 */
export const IN_SERVICE_LIMITS = Object.freeze({ handoff: 3, brief: 2 });

const bytesOf = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
/** 显示宽度（relay-docs-v2 §2.3）：CJK/全角/emoji 记 2 列，组合符与零宽记 0；字节数不再是层级触发量。 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    const cp = char.codePointAt(0);
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) continue;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    const wide = (cp >= 0x1100 && cp <= 0x115f)
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xa960 && cp <= 0xa97f)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe10 && cp <= 0xfe19)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1faff)
      || (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}
const keyOf = (entry) => entry?.relPath || entry?.path || '';
const isRaw = (entry) => entry?.layer === 'raw';
/** raw/reports 永不单列：按 kind 与路径兜底，frontmatter 把层抬到 L2 也不破这条。 */
const NEVER_SINGLE = /^(?:reports|archive)\//;
const isRawLike = (entry) => isRaw(entry) || entry?.kind === 'report' || entry?.kind === 'archive' || NEVER_SINGLE.test(keyOf(entry));
const digestOf = (text) => createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
const KB = (bytes) => (bytes / 1024).toFixed(2) + 'KB';
const DEFAULT_INDEX_BYTES = 2048; // 与 DOC_LIMITS.indexBytes 一致（纯策略不反向依赖 docs.js）

/**
 * constraints/contracts 条数（AOCI S/A）：`;` 或 `；` 分隔，`none`/空 = 0
 * （显式声明无约束不算缺失；计数用于 L0 的 `!n` / `An` 标记）。
 */
export function countSemantic(value) {
  const raw = String(value ?? '').trim();
  if (raw === '' || /^none$/i.test(raw)) return 0;
  return raw.split(/[;；]/).map((item) => item.trim()).filter((item) => item !== '' && !/^none$/i.test(item)).length;
}

/** L0 语义标记：`!约束数 A契约数`（0 不渲染）。 */
export function semanticMarksOf(entry) {
  const constraints = Number.isInteger(entry?.constraintsCount) ? entry.constraintsCount : countSemantic(entry?.constraints);
  const contracts = Number.isInteger(entry?.contractsCount) ? entry.contractsCount : countSemantic(entry?.contracts);
  return [constraints > 0 ? '!' + constraints : '', contracts > 0 ? 'A' + contracts : ''].filter(Boolean).join(' ');
}

/** L0 关系标记：`→关系数`（AOCI R；0 不渲染）。 */
export function relationMarkOf(entry) {
  const count = Number.isInteger(entry?.relationsCount) ? entry.relationsCount : Array.isArray(entry?.relations) ? entry.relations.length : 0;
  return count > 0 ? '→' + count : '';
}

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

/** pin 落账/展示的统一上限（relay_phase 落账与 normalizePins 共用，避免两处漂移）。 */
export const PIN_LIMIT = 32;
/** 归一化 pin 列表（去重、去 relay 前缀/./、最多 PIN_LIMIT 个）。 */
export function normalizePins(pins) {
  const out = [];
  for (const pin of Array.isArray(pins) ? pins : []) {
    for (const token of pinTokensOf(pin)) if (!out.includes(token)) out.push(token);
  }
  return out.slice(0, PIN_LIMIT);
}

/** 条目是否被 pin（比较 relay 相对路径与 workspace 相对路径）。 */
export function isPinnedEntry(entry, pins) {
  const tokens = normalizePins(pins);
  const rel = keyOf(entry);
  const path = String(entry?.path ?? '');
  return tokens.some((token) => token === rel || token === path || token === stripRelayPrefix(path));
}

/** 不在 relay 索引内的 pin（progress.key_docs 可指向工作区源码/文档）：保留可见，用普通 read 取。 */
export function workspacePinsOf(pins, entries) {
  const list = Array.isArray(entries) ? entries : [];
  return normalizePins(pins).filter((pin) => !list.some((entry) => isPinnedEntry(entry, [pin])));
}

/** 工作区 pin 行：不是 relay 文档，标注读取方式，避免被误当折叠入口。 */
export function formatWorkspacePin(path) {
  return '- ' + BT + path + BT + ' — 工作区 pin（不在 relay 根内；用 read 直接读）';
}

/** 带决策：decisions 目录/文件，或 frontmatter 有 constraints/contracts（none 不算）且 role/when 非 legacy 默认。 */
export function isDecisionDoc(entry) {
  if (entry?.kind === 'decisions') return true;
  return semanticMarksOf(entry) !== '' && entry?.source === 'frontmatter' && (entry?.metaRole === true || entry?.metaWhen === true);
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

/** 单条索引行：path — role（when）· !约束 A契约 →关系 · size · updated */
export function formatSingle(entry, { withWhen = true } = {}) {
  const parts = [BT + keyOf(entry) + BT, '—', (entry.role === '' || entry.role === undefined) ? '（未标注作用）' : entry.role];
  if (withWhen && entry.when !== '' && entry.when !== undefined) parts.push('（' + entry.when + '）');
  const marks = [semanticMarksOf(entry), relationMarkOf(entry)].filter(Boolean).join(' ');
  if (marks !== '') parts.push('· ' + marks);
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
/** 2–3 行头部的 legend（AOCI M1/P3）：只解释层与标记，不含正文。 */
const INDEX_LEGEND = '读法：L1 先读 / L2 按需；! 约束 · A 契约 · → 关系';

/** 健康行（复用选择结果的 entries，不新增扫描）：层计数 + 索引字节/上限。 */
export function healthLineOf(entries, bytes, maxBytes = DEFAULT_INDEX_BYTES) {
  const counts = { L1: 0, L2: 0, raw: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.layer === 'L1') counts.L1 += 1;
    else if (entry?.layer === 'L2') counts.L2 += 1;
    else counts.raw += 1;
  }
  return '索引 ' + KB(bytes) + '/' + KB(maxBytes) + ' · L1 ' + counts.L1 + ' / L2 ' + counts.L2 + ' / raw ' + counts.raw;
}

function singlesWidth(entries) {
  return entries.reduce((sum, entry) => sum + displayWidth(formatSingle(entry)), 0);
}

/** 宽度/组数触发（W/G）：W 由 docs.width（缺省 1024 列）触发；G 仅在 config docs.maxGroups 显式给出时触发。 */
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
export function renderIndex(sel, { width, maxGroups, health = true, maxBytes = DEFAULT_INDEX_BYTES, layout = true, workspacePins: workspacePinsOverride } = {}) {
  // docs.layout=flat：关闭 W/G 自动层级触发（旧行为）；字节护栏仍由 docs.js 做兜底。
  const level = layout === false ? sel.level : resolveLevel(sel, { width, maxGroups });
  const layoutSel = level === sel.level ? sel : selectIndex(sel.entries, { pins: sel.pins, level });
  const singles = layoutSel.singles;
  const pinned = singles.filter((entry) => isPinnedEntry(entry, layoutSel.pins));
  // 工作区 pin（progress.key_docs 指向 relay 根外真实文件）：由 docs.js 校验存在后传入；直接调用时保留纯推导。
  const workspacePins = Array.isArray(workspacePinsOverride) ? workspacePinsOverride : workspacePinsOf(sel.pins, sel.entries);
  const lines = [INDEX_HEADER, INDEX_LEGEND];
  const pinLines = [...pinned.map((entry) => formatSingle(entry)), ...workspacePins.map((path) => formatWorkspacePin(path))];
  if (level === 'C') {
    if (pinLines.length > 0) lines.push('### 在役（pin，不折叠）', ...pinLines);
    if (layoutSel.stats.folded > 0) lines.push('- 其余 ' + layoutSel.stats.folded + ' 份文档 / ' + layoutSel.groups.length + ' 个目录已折叠：' + BT + 'relay_doc list include=all' + BT + ' 展开');
  } else {
    const nonPinned = singles.filter((entry) => !isPinnedEntry(entry, layoutSel.pins));
    const inService = level === 'A' ? nonPinned.filter((entry) => !isDecisionDoc(entry)) : [];
    const decisions = level === 'A' ? nonPinned.filter((entry) => isDecisionDoc(entry)) : [];
    if (pinLines.length + inService.length > 0) lines.push('### 在役（先读）', ...pinLines, ...inService.map((entry) => formatSingle(entry)));
    if (decisions.length > 0) lines.push('### 带决策', ...decisions.map((entry) => formatSingle(entry)));
    if (layoutSel.groups.length > 0) lines.push('### 折叠（按目录，展开即取全）', ...layoutSel.groups.map((group) => formatGroup(group)));
  }
  // health 行含自身渲染后的字节数：两遍收敛（第二遍仅刷新数字），超预算时由 docs.js 先丢 health 行。
  let text = lines.join(NL);
  if (health) {
    let bytes = bytesOf(text);
    for (let pass = 0; pass < 2; pass += 1) {
      text = [lines[0], lines[1], healthLineOf(layoutSel.entries, bytes, maxBytes), ...lines.slice(2)].join(NL);
      bytes = bytesOf(text);
    }
  }
  const groups = layoutSel.groups.map((group) => ({
    dir: group.dir,
    count: group.count,
    reps: group.reps,
    bytes: bytesOf(formatGroup(group)),
    command: group.command,
  }));
  return {
    text,
    bytes: bytesOf(text),
    width: displayWidth(text),
    digest: digestOf(text),
    level,
    paths: singles.map(keyOf),
    groups,
    workspacePins,
    collapsed: layoutSel.stats.folded,
    shown: singles.length + workspacePins.length,
    omitted: layoutSel.stats.folded,
  };
}

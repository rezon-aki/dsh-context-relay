/**
 * dsh-context-relay — 滚动进度文件（长线记忆，2026-11-01 用户要求 B 方案）。
 *
 * 与一次性 handoff 快照分工：
 * - `handoff-<ts>.md`：本次增量的有界快照（临时性/审计），8KB 上限。
 * - `progress.md`（本模块）：跨多次接力的滚动主线——当前目标/状态、关键决策（追加去重）、
 *   证据入口、交接时间线；文件头「持有会话」随接力自动改到新会话；超上限自动把最旧内容
 *   归档到 `progress-archive-<年份>.md`，主文件保留归档指针。
 *
 * 人类可读 markdown + 末段 `<!-- relay-progress:json ... -->` 机器块（状态以 JSON 块为准）。
 *
 * @module dsh-context-relay/agent/progress
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROGRESS_FILE = 'progress.md';
/** workspace 相对路径（交给新会话时用）。 */
export const PROGRESS_RELATIVE = '.scratch/context-relay/' + PROGRESS_FILE;
/** 滚动文件字节上限（与 handoff 快照同口径；超限归档最旧内容）。 */
export const PROGRESS_LIMIT_BYTES = 8192;
const STATE_START = '<!-- relay-progress:json';
const STATE_END = '-->';
const CAPS = { decisions: 40, constraints: 8, risks: 8, open_questions: 8, evidence: 24, key_docs: 12, timeline: 30 };
const KEEP_MIN = { timeline: 5, decisions: 5, evidence: 5 };

function rootOf(cwd) { return join(cwd, '.scratch', 'context-relay'); }
function pathOf(cwd) { return join(rootOf(cwd), PROGRESS_FILE); }
function archivePathOf(cwd, year) { return join(rootOf(cwd), 'progress-archive-' + year + '.md'); }

/** 空状态（首次交接 / 文件不存在 / 文件损坏时的新起点）。 */
export function freshProgressState() {
  return {
    version: 1, holder: '', updatedAt: '', updates: 0, goal: '', phase: '',
    success_criteria: [], done: [], next_actions: [], blocked: [], open_questions: [],
    decisions: [], constraints: [], risks: [], evidence: [], key_docs: [], timeline: [],
  };
}

function asList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).map((item) => item.trim()).filter((item) => item !== '')
    : [];
}

function uniqueCap(items, cap) { return [...new Set(items)].slice(0, cap); }
/** 新条目在前 + 去重（决策/证据按「最近在前」展示）。 */
function prependUnique(existing, incoming, cap) { return uniqueCap([...incoming, ...existing], cap); }

/** 从 markdown 的机器块解析状态；缺失/损坏返回 undefined。 */
export function parseProgress(raw) {
  if (typeof raw !== 'string') return undefined;
  const start = raw.indexOf(STATE_START);
  if (start < 0) return undefined;
  const end = raw.indexOf(STATE_END, start + STATE_START.length);
  if (end < 0) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start + STATE_START.length, end).trim());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return { ...freshProgressState(), ...parsed };
  } catch { return undefined; }
}

/** 合并一次交接：状态段覆盖、决策/证据追加去重、时间线追加、持有会话改为新会话。 */
export function mergeProgress(state, update = {}) {
  const base = state ?? freshProgressState();
  const status = update.status ?? {};
  const now = String(update.now ?? new Date().toISOString());
  const sessionId = String(update.sessionId ?? base.holder ?? '');
  const goal = String(status.goal ?? base.goal ?? '').replace(/\s+/g, ' ').trim();
  const phase = String(status.phase ?? base.phase ?? '');
  const timelineEntry = { at: now, sessionId, phase, goal: goal.slice(0, 120), handoffPath: String(update.handoffPath ?? '') };
  return {
    ...base,
    version: 1,
    holder: sessionId,
    updatedAt: now,
    updates: (Number.isInteger(base.updates) ? base.updates : 0) + 1,
    goal,
    phase,
    success_criteria: status.success_criteria === undefined ? asList(base.success_criteria) : asList(status.success_criteria),
    done: status.done === undefined ? asList(base.done) : asList(status.done),
    next_actions: status.next_actions === undefined ? asList(base.next_actions) : asList(status.next_actions),
    blocked: status.blocked === undefined ? asList(base.blocked) : asList(status.blocked),
    open_questions: update.open_questions === undefined ? asList(base.open_questions) : asList(update.open_questions),
    decisions: prependUnique(asList(base.decisions), asList(update.decisions), CAPS.decisions),
    constraints: prependUnique(asList(base.constraints), asList(update.constraints), CAPS.constraints),
    risks: prependUnique(asList(base.risks), asList(update.risks), CAPS.risks),
    evidence: prependUnique(asList(base.evidence), asList(update.evidence), CAPS.evidence),
    key_docs: prependUnique(asList(base.key_docs), asList(update.key_docs), CAPS.key_docs),
    timeline: uniqueCap([timelineEntry, ...asList2(base.timeline)], CAPS.timeline),
  };
}

function asList2(value) { return Array.isArray(value) ? value : []; }

function bullet(items, empty = '（无）') { return items.length === 0 ? ['- ' + empty] : items.map((item) => '- ' + item.replace(/\s+/g, ' ')); }

/** 渲染 markdown（人类可读）+ 末段机器块（状态真源）。 */
export function renderProgress(state) {
  const lines = [];
  lines.push('# 接力进度（rolling）', '');
  lines.push('> 持有会话：' + (state.holder || '—') + ' · 最近更新：' + (state.updatedAt || '—') + ' · 累计交接：' + state.updates + ' 次');
  lines.push('> 这是跨接力的长线记忆文件：状态段覆盖、决策/证据追加、时间线滚动；超 8KB 自动归档最旧内容到 progress-archive-<年份>.md。机器数据以末段 JSON 块为准，请勿手改该块。', '');
  lines.push('## 当前目标', ...bullet([state.goal === '' ? '（未记录）' : '目标：' + state.goal, '阶段：' + (state.phase || '—'), ...state.success_criteria.map((item) => '成功标准：' + item)]), '');
  lines.push('## 当前状态', ...bullet([...state.done.map((item) => '已完成：' + item), ...state.blocked.map((item) => '阻塞：' + item), ...state.open_questions.map((item) => '未决：' + item)]), '');
  lines.push('## 未完成/下一步', ...bullet(state.next_actions), '');
  lines.push('## 关键决策（追加，最近在前）', ...bullet(state.decisions), '');
  // 超 8KB 时被压缩的事实显式展示（不静默；完整内容见最近 handoff 文件）。
  lines.push('## 硬约束 / 风险（追加，最近在前）', ...bullet([...state.constraints, ...state.risks, ...(typeof state.trimmed === 'string' && state.trimmed !== '' ? [state.trimmed] : [])]), '');
  lines.push('## 证据入口', ...bullet([...state.evidence, ...state.key_docs.map((item) => 'doc: ' + item)]), '');
  lines.push('## 交接时间线（最近在前）', ...bullet(state.timeline.map((entry) => entry.at + ' · session=' + entry.sessionId + ' · phase=' + entry.phase + (entry.handoffPath === '' ? '' : ' · handoff=' + entry.handoffPath) + (entry.goal === '' ? '' : ' · ' + entry.goal))), '');
  lines.push(STATE_START, JSON.stringify(state), STATE_END, '');
  return lines.join('\n');
}

function bytesOf(text) { return Buffer.byteLength(text, 'utf8'); }

/** 状态段（当前状态，不是历史滚动区）的条数上限：与 handoff 快照同口径，防无界增长。 */
const STATUS_CAPS = { success_criteria: 5, done: 12, next_actions: 8, blocked: 8, open_questions: 8, constraints: 8, risks: 8, key_docs: 12 };
const STATUS_ARRAYS = Object.keys(STATUS_CAPS);

/** 截断字符串到 max 字符（留省略号；非字符串原样返回）。 */
function clipText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * 有界渲染并归档（硬上限：主文件 ≤ limit 字节，2026-11-01 审查 P1 修复）：
 * 1) 先按旧规则把最旧时间线 → 决策 → 证据移进归档（各保留 KEEP_MIN 条）；
 * 2) 再逐级压缩状态段（success_criteria/done/next_actions/blocked/open_questions/
 *    constraints/risks/key_docs 的条数与条目长度）与历史列表条目长度，直到 ≤ limit；
 * 3) 被压缩的事实写进 state.trimmed 并在 markdown 中显式展示（不静默）。
 * 返回 { text, state, archived, bytes, year }。
 */
export function renderBoundedProgress(state, limit = PROGRESS_LIMIT_BYTES) {
  const candidate = JSON.parse(JSON.stringify(state));
  const archived = [];
  const trimmed = [];
  let itemsShortened = false;
  const year = String(candidate.updatedAt || new Date().toISOString()).slice(0, 4);
  let text = renderProgress(candidate);
  let bytes = bytesOf(text);
  const drain = (key, kind) => {
    if (!Array.isArray(candidate[key])) return;
    while (bytes > limit && candidate[key].length > KEEP_MIN[key]) {
      const index = candidate[key].length - 1;
      const [dropped] = candidate[key].splice(index, 1);
      archived.push(kind + ' ' + (typeof dropped === 'string' ? dropped : JSON.stringify(dropped)));
      text = renderProgress(candidate);
      bytes = bytesOf(text);
    }
  };
  drain('timeline', 'timeline');
  drain('decisions', 'decision');
  drain('evidence', 'evidence');
  /** 压缩一个列表：条数上限（caps×factor，至少 1）+ 条目长度；对象只压 goal/handoffPath。 */
  const clipList = (key, itemMax, factor, caps) => {
    if (!Array.isArray(candidate[key])) return;
    const cap = caps === undefined ? candidate[key].length : Math.max(1, Math.ceil(caps * factor));
    const before = candidate[key].length;
    if (before > cap) {
      candidate[key] = candidate[key].slice(0, cap);
      trimmed.push(key + ' ' + before + '→' + cap);
    }
    candidate[key] = candidate[key].map((item) => {
      if (typeof item === 'string') {
        const clipped = clipText(item, itemMax);
        if (clipped !== item) itemsShortened = true;
        return clipped;
      }
      if (item !== null && typeof item === 'object') {
        const next = { ...item };
        if (typeof next.goal === 'string') next.goal = clipText(next.goal, Math.min(itemMax, 120));
        if (typeof next.handoffPath === 'string') next.handoffPath = clipText(next.handoffPath, Math.min(itemMax, 120));
        return next;
      }
      return item;
    });
  };
  const rerender = () => { text = renderProgress(candidate); bytes = bytesOf(text); };
  const levels = [
    { item: 200, factor: 1 },
    { item: 160, factor: 0.75 },
    { item: 120, factor: 0.5 },
    { item: 80, factor: 0.33 },
    { item: 60, factor: 0.2 },
    { item: 40, factor: 0.1 },
    { item: 30, factor: 0.05 },
    { item: 20, factor: 0.02 },
  ];
  for (const { item, factor } of levels) {
    if (bytes <= limit) break;
    for (const key of STATUS_ARRAYS) clipList(key, item, factor, STATUS_CAPS[key]);
    rerender();
  }
  for (const [itemMax, factor] of [[120, 0.6], [60, 0.2], [30, 0.04]]) {
    if (bytes <= limit) break;
    for (const key of ['decisions', 'evidence', 'timeline']) clipList(key, itemMax, factor);
    rerender();
  }
  if (bytes > limit) {
    candidate.goal = String(candidate.goal).slice(0, 120);
    rerender();
  }
  if (trimmed.length > 0 || itemsShortened) {
    candidate.trimmed = '进度文件超 ' + limit + ' 字节已裁剪：' + trimmed.slice(0, 6).join('；') + (trimmed.length > 6 ? ' 等 ' + trimmed.length + ' 项' : '') + (itemsShortened ? '；部分条目已按上限截短' : '') + '（完整内容见最近 handoff 文件/旧会话）';
    rerender();
  }
  // 4) 兜底收敛：trimmed 注记/渲染开销本身也可能把文件顶过上限（复核 fuzz 发现）——
  //    继续极深裁剪直到 ≤ limit，保证返回的 bytes 与磁盘文件都不超上限。
  for (const [itemMax, factor] of [[15, 0.01], [8, 0.001]]) {
    if (bytes <= limit) break;
    for (const key of STATUS_ARRAYS) clipList(key, itemMax, factor, STATUS_CAPS[key]);
    for (const key of ['decisions', 'evidence', 'timeline']) clipList(key, itemMax, factor);
    rerender();
  }
  if (bytes > limit) {
    for (const key of [...STATUS_ARRAYS, 'decisions', 'evidence', 'timeline']) if (Array.isArray(candidate[key])) candidate[key] = [];
    rerender();
  }
  if (bytes > limit && typeof candidate.trimmed === 'string') { candidate.trimmed = ''; rerender(); }
  return { text, state: candidate, archived, bytes, year };
}

/** 把归档行追加到 progress-archive-<year>.md（首次带表头）。 */
export function appendProgressArchive(cwd, year, archived) {
  if (archived.length === 0) return undefined;
  mkdirSync(rootOf(cwd), { recursive: true });
  const file = archivePathOf(cwd, year);
  const header = existsSync(file) ? '' : '# 接力进度归档 ' + year + '\n\n> 由 progress.md 超 8KB 时自动归档（时间线/决策/证据，按淘汰顺序）。\n\n';
  appendFileSync(file, header + archived.map((line) => '- ' + line).join('\n') + '\n', 'utf8');
  return file;
}

/**
 * 滚动更新进度文件：读旧状态 → 合并本次交接 → 有界渲染 → 归档超限内容 → 写回。
 * 返回 {updated, path, relativePath, bytes, archived, updates, previousRaw?, corruptBackup?}；
 * previousRaw 供 followup 失败时 restoreProgress 回滚。
 */
export function updateProgress(cwd, update) {
  mkdirSync(rootOf(cwd), { recursive: true });
  const path = pathOf(cwd);
  let previousRaw;
  let state = freshProgressState();
  let corruptBackup;
  if (existsSync(path)) {
    try {
      previousRaw = readFileSync(path, 'utf8');
      const parsed = parseProgress(previousRaw);
      if (parsed === undefined) {
        corruptBackup = path + '.corrupt-' + Date.now();
        writeFileSync(corruptBackup, previousRaw, 'utf8');
      } else state = parsed;
    } catch { /* 读失败按首次交接处理 */ }
  }
  const merged = mergeProgress(state, update);
  const rendered = renderBoundedProgress(merged, PROGRESS_LIMIT_BYTES);
  const archiveFile = appendProgressArchive(cwd, rendered.year, rendered.archived);
  writeFileSync(path, rendered.text, 'utf8');
  return {
    updated: true,
    path,
    relativePath: PROGRESS_RELATIVE,
    bytes: rendered.bytes,
    archived: rendered.archived.length,
    archiveFile: archiveFile === undefined ? undefined : archiveFile.slice(archiveFile.indexOf('.scratch')),
    updates: rendered.state.updates,
    previousRaw,
    corruptBackup,
  };
}

/** followup 失败（半创建）时把进度文件恢复到交接前（没有旧内容则删除新建文件）。 */
export function restoreProgress(previous) {
  if (previous === undefined || previous.path === undefined) return;
  if (typeof previous.previousRaw === 'string') {
    writeFileSync(previous.path, previous.previousRaw, 'utf8');
    return;
  }
  try { unlinkSync(previous.path); } catch { /* 文件不存在：无需恢复 */ }
}

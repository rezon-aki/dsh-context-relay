/**
 * dsh-context-relay — 滚动进度文件（长线记忆，2026-11-01 用户要求 B 方案）。
 *
 * 与一次性 handoff 快照分工：
 * - `handoff-<ts>.md`：本次增量的有界快照（临时性/审计），8KB 上限。
 * - `progress.md`（本模块）：跨多次接力的滚动主线——当前目标/状态、关键决策（追加去重）、
 *   证据入口、交接时间线；文件头「持有会话」随接力自动改到新会话；超过 advisory 阈值
 *   （PROGRESS_LIMIT_BYTES，默认 32KB）时把最旧内容完整移入 `progress-archive-<年份>.md`；
 *   状态段超限被移除/截短的条目同样完整归档（主文件只留摘要 + 归档指针，不丢数据）。
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
/**
 * 滚动文件主文件字节上限（advisory 归档阈值，不是硬拒绝/截断：超限只把最旧或超出条目
 * **完整**移入 `progress-archive-<年份>.md`）。主文件保持 ≤ 该值以控制注入开销。
 */
export const PROGRESS_LIMIT_BYTES = 32768;
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

/**
 * 合并一次交接（不丢历史）：返回 { state, overflow }，overflow = 超历史 CAPS 的条目原文，
 * 供调用方归档（progress-archive-<年>.md），不再静默丢弃。
 */
export function mergeProgressWithOverflow(state, update = {}) {
  const base = state ?? freshProgressState();
  const status = update.status ?? {};
  const now = String(update.now ?? new Date().toISOString());
  const sessionId = String(update.sessionId ?? base.holder ?? '');
  const goal = String(status.goal ?? base.goal ?? '').replace(/\s+/g, ' ').trim();
  const phase = String(status.phase ?? base.phase ?? '');
  const timelineEntry = { at: now, sessionId, phase, goal: goal.slice(0, 120), handoffPath: String(update.handoffPath ?? '') };
  const overflow = [];
  const prependWithOverflow = (key, existing, incoming, cap) => {
    const all = [...new Set([...incoming, ...existing])];
    if (all.length > cap) overflow.push(...all.slice(cap).map((item) => 'history:' + key + ' ' + item));
    return all.slice(0, cap);
  };
  const timelineAll = uniqueCap([timelineEntry, ...asList2(base.timeline)], Number.MAX_SAFE_INTEGER);
  if (timelineAll.length > CAPS.timeline) {
    for (const entry of timelineAll.slice(CAPS.timeline)) overflow.push('history:timeline ' + JSON.stringify(entry));
  }
  const merged = {
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
    decisions: prependWithOverflow('decisions', asList(base.decisions), asList(update.decisions), CAPS.decisions),
    constraints: prependWithOverflow('constraints', asList(base.constraints), asList(update.constraints), CAPS.constraints),
    risks: prependWithOverflow('risks', asList(base.risks), asList(update.risks), CAPS.risks),
    evidence: prependWithOverflow('evidence', asList(base.evidence), asList(update.evidence), CAPS.evidence),
    key_docs: prependWithOverflow('key_docs', asList(base.key_docs), asList(update.key_docs), CAPS.key_docs),
    timeline: timelineAll.slice(0, CAPS.timeline),
  };
  return { state: merged, overflow };
}

/** 兼容旧调用：只返回合并后的 state（历史溢出由 mergeProgressWithOverflow 的 overflow 提供）。 */
export function mergeProgress(state, update = {}) {
  return mergeProgressWithOverflow(state, update).state;
}

function asList2(value) { return Array.isArray(value) ? value : []; }

function bullet(items, empty = '（无）') { return items.length === 0 ? ['- ' + empty] : items.map((item) => '- ' + item.replace(/\s+/g, ' ')); }

/** 渲染 markdown（人类可读）+ 末段机器块（状态真源）。 */
export function renderProgress(state) {
  const lines = [];
  lines.push('# 接力进度（rolling）', '');
  lines.push('> 持有会话：' + (state.holder || '—') + ' · 最近更新：' + (state.updatedAt || '—') + ' · 累计交接：' + state.updates + ' 次');
  lines.push('> 这是跨接力的长线记忆文件：状态段覆盖、决策/证据追加、时间线滚动；超过 advisory 阈值（默认 32KB）时把最旧/超出内容完整归档到 progress-archive-<年份>.md，主文件只留摘要与归档指针（不丢数据）。机器数据以末段 JSON 块为准，请勿手改该块。', '');
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
/** 历史滚动区的归档行前缀（沿用旧归档文件格式）。 */
const HISTORY_KIND = { decisions: 'decision', evidence: 'evidence', timeline: 'timeline' };

/** 截断字符串到 max 字符（留省略号；非字符串原样返回）。 */
function clipText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

/** 归档行：状态段 `status:<key> <完整原文>`，历史区沿用 `decision|evidence|timeline <原文>`（appendProgressArchive 逐行加 '- '）。 */
function archiveLine(key, item) {
  const kind = HISTORY_KIND[key];
  return (kind === undefined ? 'status:' + key : kind) + ' ' + (typeof item === 'string' ? item : JSON.stringify(item));
}

/** 归档文件的 workspace 相对路径：trimmed 注记指向它，保证被移除内容可回读。 */
function archiveRelativePathOf(year) { return '.scratch/context-relay/progress-archive-' + year + '.md'; }

/**
 * 有界渲染并归档（主文件 ≤ limit 字节；超限只移动/归档，不丢数据）：
 * 1) 先按旧规则把最旧时间线 → 决策 → 证据移进归档（各保留 KEEP_MIN 条）；
 * 2) 再逐级压缩状态段（success_criteria/done/next_actions/blocked/open_questions/
 *    constraints/risks/key_docs 的条数与条目长度）与历史列表条目长度，直到 ≤ limit；
 * 3) 所有被移除/被截短的条目都把**完整原文**推进 archived（同一条目多级截短只归档一次），
 *    由 updateProgress 落盘 progress-archive-<年>.md；主文件只留摘要 + 归档指针（state.trimmed），
 *    不允许内容只存在于裁剪注记里。
 * 返回 { text, state, archived, bytes, year, archiveRef }。
 */
export function renderBoundedProgress(state, limit = PROGRESS_LIMIT_BYTES) {
  const candidate = JSON.parse(JSON.stringify(state));
  const originals = JSON.parse(JSON.stringify(state));
  const archived = [];
  const trimmed = [];
  const archivedAt = new Set();
  let removedCount = 0;
  let shortenedCount = 0;
  const year = String(candidate.updatedAt || new Date().toISOString()).slice(0, 4);
  const archiveRef = archiveRelativePathOf(year);
  let text = renderProgress(candidate);
  let bytes = bytesOf(text);
  // 归档会追加 trimmed 注记（含 JSON 键开销，实测 ≤ 420B）：一旦需要裁剪，就把裁剪目标压到
  // limit - NOTE_RESERVE，保证加注记后主文件仍 ≤ limit（不靠丢弃注记，指针始终在）。
  const NOTE_RESERVE = 512;
  const target = bytes > limit ? Math.max(0, limit - NOTE_RESERVE) : limit;
  /** 归档一条完整原文（同一条目多级截短只归档一次）；返回是否新归档。 */
  const archiveOnce = (key, index) => {
    const id = key + ':' + index;
    if (archivedAt.has(id)) return false;
    archivedAt.add(id);
    const full = Array.isArray(originals[key]) ? originals[key][index] : undefined;
    archived.push(archiveLine(key, full === undefined ? '' : full));
    return true;
  };
  const drain = (key) => {
    if (!Array.isArray(candidate[key])) return;
    while (bytes > target && candidate[key].length > KEEP_MIN[key]) {
      const [dropped] = candidate[key].splice(candidate[key].length - 1, 1);
      archived.push(archiveLine(key, dropped));
      removedCount += 1;
      text = renderProgress(candidate);
      bytes = bytesOf(text);
    }
  };
  drain('timeline');
  drain('decisions');
  drain('evidence');
  /**
   * 压缩一个列表：条数上限（caps×factor，至少 1）+ 条目长度；对象只压 goal/handoffPath。
   * 被移除/被截短的条目按完整原文归档（下标按前缀对齐 originals：淘汰只从尾部移除）。
   */
  const clipList = (key, itemMax, factor, caps) => {
    if (!Array.isArray(candidate[key])) return;
    const cap = caps === undefined ? candidate[key].length : Math.max(1, Math.ceil(caps * factor));
    const before = candidate[key].length;
    if (before > cap) {
      for (let index = cap; index < before; index += 1) if (archiveOnce(key, index)) removedCount += 1;
      candidate[key] = candidate[key].slice(0, cap);
      trimmed.push(key + ' ' + before + '→' + cap);
    }
    candidate[key] = candidate[key].map((item, index) => {
      if (typeof item === 'string') {
        const clipped = clipText(item, itemMax);
        if (clipped !== item) { if (archiveOnce(key, index)) shortenedCount += 1; return clipped; }
        return item;
      }
      if (item !== null && typeof item === 'object') {
        const next = { ...item };
        if (typeof next.goal === 'string') next.goal = clipText(next.goal, Math.min(itemMax, 120));
        if (typeof next.handoffPath === 'string') next.handoffPath = clipText(next.handoffPath, Math.min(itemMax, 120));
        if (next.goal !== item.goal || next.handoffPath !== item.handoffPath) { if (archiveOnce(key, index)) shortenedCount += 1; }
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
    if (bytes <= target) break;
    for (const key of STATUS_ARRAYS) clipList(key, item, factor, STATUS_CAPS[key]);
    rerender();
  }
  for (const [itemMax, factor] of [[120, 0.6], [60, 0.2], [30, 0.04]]) {
    if (bytes <= target) break;
    for (const key of ['decisions', 'evidence', 'timeline']) clipList(key, itemMax, factor);
    rerender();
  }
  if (bytes > target && String(candidate.goal).length > 120) {
    const fullGoal = String(candidate.goal);
    archived.push(archiveLine('goal', fullGoal));
    shortenedCount += 1;
    trimmed.push('goal ' + fullGoal.length + '→120');
    candidate.goal = fullGoal.slice(0, 120);
    rerender();
  }
  // 4) 兜底收敛：注记/渲染开销本身也可能把文件顶过上限（复核 fuzz 发现）——
  //    继续极深裁剪直到 ≤ target（为注记预留空间），保证加注记后返回的 bytes 与磁盘文件都不超 limit；
  //    移除项全部进归档。
  for (const [itemMax, factor] of [[15, 0.01], [8, 0.001]]) {
    if (bytes <= target) break;
    for (const key of STATUS_ARRAYS) clipList(key, itemMax, factor, STATUS_CAPS[key]);
    for (const key of ['decisions', 'evidence', 'timeline']) clipList(key, itemMax, factor);
    rerender();
  }
  if (bytes > target) {
    for (const key of [...STATUS_ARRAYS, 'decisions', 'evidence', 'timeline']) {
      if (!Array.isArray(candidate[key])) continue;
      if (candidate[key].length > 0) trimmed.push(key + ' ' + candidate[key].length + '→0');
      for (let index = 0; index < candidate[key].length; index += 1) if (archiveOnce(key, index)) removedCount += 1;
      candidate[key] = [];
    }
    rerender();
  }
  // 5) 裁剪注记只写摘要计数 + 归档文件指针：完整原文都在归档里（不丢数据）。
  if (archived.length > 0) {
    const countText = '移除 ' + removedCount + ' 条 / 截短 ' + shortenedCount + ' 条';
    const summary = trimmed.length === 0
      ? countText
      : trimmed.slice(0, 6).join('；') + (trimmed.length > 6 ? ' 等 ' + trimmed.length + ' 项' : '') + '；' + countText;
    candidate.trimmed = '进度文件超 advisory 阈值 ' + limit + ' 字节已裁剪（' + summary
      + '）；被移除/截短的 ' + archived.length + ' 条完整原文已归档到 ' + archiveRef + '（主文件只留摘要，无数据丢失）';
    rerender();
  }
  // 6) 注记本身（含 JSON 块的键值开销）也可能把主文件顶过上限：先缩成一句；仍超则删除注记字段回到
  //    加注记前的尺寸（被裁剪数据已在归档里、不会因此丢失）。默认 32KB 下骨架 + 归档指针远小于 limit，
  //    只有 limit 小到连骨架都放不下（非默认配置）才会真正丢掉指针。
  if (bytes > limit && typeof candidate.trimmed === 'string') {
    candidate.trimmed = '超 ' + limit + ' 字节已裁剪，完整原文见 ' + archiveRef;
    rerender();
  }
  if (bytes > limit && 'trimmed' in candidate) { delete candidate.trimmed; rerender(); }
  return { text, state: candidate, archived, bytes, year, archiveRef };
}

/** 把归档行追加到 progress-archive-<year>.md（首次带表头）。 */
export function appendProgressArchive(cwd, year, archived) {
  if (archived.length === 0) return undefined;
  mkdirSync(rootOf(cwd), { recursive: true });
  const file = archivePathOf(cwd, year);
  const header = existsSync(file) ? '' : '# 接力进度归档 ' + year + '\n\n> 由 progress.md 超 advisory 阈值（默认 32KB）时自动归档（状态段被移除/截短的完整原文 + 最旧时间线/决策/证据，按淘汰顺序）。\n\n';
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
  const merged = mergeProgressWithOverflow(state, update);
  const rendered = renderBoundedProgress(merged.state, PROGRESS_LIMIT_BYTES);
  const archiveFile = appendProgressArchive(cwd, rendered.year, [...merged.overflow, ...rendered.archived]);
  writeFileSync(path, rendered.text, 'utf8');
  return {
    updated: true,
    path,
    relativePath: PROGRESS_RELATIVE,
    bytes: rendered.bytes,
    archived: rendered.archived.length + merged.overflow.length,
    historyArchived: merged.overflow.length,
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

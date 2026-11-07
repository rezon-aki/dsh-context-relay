/**
 * dsh-context-relay — 经验存档（可复用做法 / 踩过的坑），带防膨胀。
 *
 * 目的（ACE ICLR 2026 的「演化手册」思路）：跨 phase / 跨会话保留「验证过的做法」，
 * 而不是每次组织上下文都重写一份摘要（重写会塌缩、丢条目）。
 *
 * 防膨胀设计（四道闸）：
 *   1) 写入门槛：必须带证据指针（file:line / 命令 / URL），无证据不收；单次调用 ≤3 条、单条 ≤200 字。
 *   2) 去重合并：键 = tag + 规范化正文；重复命中只增加 seen 并刷新日期/证据，不追加新行。
 *   3) 双上限淘汰：≤40 条且 ≤8KB；超出按「复现次数（封顶 9×2）+ 新鲜度（7d=6 / 30d=3 / 90d=1）」淘汰最弱者。
 *   4) 读取限额：每次只注入前 3 条与当前 phase 目标相关的条目（按 token 重叠排序，回退新鲜度），
 *      注入总量 ≤1KB（超出先统一截字段、再截条数，并在 lessonsView.injection 标注）。
 *
 * 存储：<cwd>/.scratch/context-relay/lessons.md（单文件、人可读、可 git diff、原子写）。
 * 手工编辑：无法解析的非表头行原样保留，下次落盘不丢。
 *
 * @module dsh-context-relay/lessons
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LESSON_LIMITS = Object.freeze({
  entries: 40,
  bytes: 8192,
  text: 200,
  evidence: 200,
  tag: 24,
  perCall: 3,
  inject: 3,
  /** 单次注入（lessonsView.selected）的总 JSON 字节上限。 */
  injectBytes: 1024,
  seenCap: 99,
});

const LINE = /^- \[([a-z0-9][a-z0-9-]{0,23})\] (.{1,200}?) · 证据=(.{1,200}?) · seen=(\d{1,2}) · updated=(\d{4}-\d{2}-\d{2})$/u;
const HEADER = '# 经验存档（dsh-context-relay）\n\n> 每行一条；seen = 复现次数。超 40 条或 8KB 时按「复现次数 + 新鲜度」淘汰最弱条目；无法解析的手工行原样保留。\n\n';

export function lessonsPath(cwd) {
  return join(cwd, '.scratch', 'context-relay', 'lessons.md');
}

function today(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** 规范化 tag（小写 kebab；非法 → general）。 */
export function normalizeTag(value) {
  const tag = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LESSON_LIMITS.tag);
  return /^[a-z0-9][a-z0-9-]*$/.test(tag) ? tag : 'general';
}

/** 单行化 + 截断；字段分隔符（·）替换掉，避免破坏行格式。 */
export function normalizeText(value, limit = LESSON_LIMITS.text) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/·/g, '-').trim().slice(0, limit);
}

/** 解析存量文件：合法行 → 条目；非表头/非空的畸形行原样收集到 unknown（保存时保留）。 */
function parseContent(content) {
  const entries = [];
  const unknown = [];
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('>')) continue; // 表头/空行不算手工内容
    const match = LINE.exec(line);
    if (match === null) { unknown.push(line); continue; }
    entries.push({
      tag: match[1],
      text: match[2],
      evidence: match[3],
      seen: Math.min(Number(match[4]), LESSON_LIMITS.seenCap),
      updated: match[5],
    });
  }
  return { entries, unknown };
}

/** 解析存量文件（畸形行忽略，不抛错；保留视图见内部 parseContent）。 */
export function parseLessons(content) {
  return parseContent(content).entries;
}

/** 渲染成文件内容（条目在前、保留的手工行在后；确定性排序由调用方保证）。 */
export function formatLessons(entries, unknownLines = []) {
  const lines = entries.map((entry) => '- [' + entry.tag + '] ' + entry.text + ' · 证据=' + entry.evidence + ' · seen=' + entry.seen + ' · updated=' + entry.updated);
  const kept = (Array.isArray(unknownLines) ? unknownLines : []).map((line) => String(line ?? '').replace(/\r?\n/g, ' ').trim()).filter((line) => line !== '');
  return HEADER + [...lines, ...kept].join('\n') + (lines.length + kept.length === 0 ? '' : '\n');
}

function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** 淘汰分数：复现次数（封顶 9，×2）+ 新鲜度；分低者先淘汰。 */
export function lessonScore(entry, now = Date.now()) {
  const days = Math.max(0, (now - Date.parse(entry.updated + 'T00:00:00Z')) / 86_400_000);
  const recency = days <= 7 ? 6 : days <= 30 ? 3 : days <= 90 ? 1 : 0;
  return Math.min(entry.seen, 9) * 2 + recency;
}

function weakestIndex(entries, now) {
  let index = 0;
  let score = lessonScore(entries[0], now);
  for (let i = 1; i < entries.length; i += 1) {
    const current = lessonScore(entries[i], now);
    if (current < score) { index = i; score = current; }
  }
  return index;
}

/** token 集合（拉丁词 + 中文 bigram），用于相关度排序。 */
export function tokenSet(text) {
  const value = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const match of value.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) out.add(match[0]);
  for (const run of value.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

const viewOf = (entry) => ({ tag: entry.tag, text: entry.text, evidence: entry.evidence });
const viewBytes = (view) => bytesOf(JSON.stringify(view));

/** 按码点截断到 ≤limit 字符，超出以省略号结尾。 */
function clipField(text, limit) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= limit ? chars.join('') : chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
}

/**
 * 选前 limit 条：与 goal/paths 的 token 重叠优先，其次新鲜度。
 * 注入总量受 maxBytes（JSON 字节）约束：超限先统一截字段（text/evidence 码点），仍超再截条数。
 * 返回 { entries, bytes, truncated, dropped }；调用方据此标注「注入已截断」（truncated/dropped）。
 */
export function selectLessons(entries, { goal = '', paths = [], limit = LESSON_LIMITS.inject, maxBytes = LESSON_LIMITS.injectBytes } = {}) {
  const query = tokenSet([goal, ...paths].join(' '));
  const ranked = entries
    .map((entry) => {
      const haystack = tokenSet(entry.tag + ' ' + entry.text + ' ' + entry.evidence);
      let hit = 0;
      for (const token of query) if (haystack.has(token)) hit += 1;
      return { entry, hit };
    })
    .sort((a, b) => (b.hit - a.hit) || b.entry.updated.localeCompare(a.entry.updated))
    .slice(0, limit)
    .map((item) => viewOf(item.entry));
  const sizeOf = (views) => views.reduce((sum, view) => sum + viewBytes(view), 0);
  const whole = sizeOf(ranked);
  if (whole <= maxBytes) return { entries: ranked, bytes: whole, truncated: false, dropped: 0 };
  // 先截字段：所有条目的 text/evidence 统一截到同一码点上限，二分找能放进预算的最大上限。
  const render = (chars) => ranked.map((view) => ({ tag: view.tag, text: clipField(view.text, chars), evidence: clipField(view.evidence, chars) }));
  let low = 0;
  let high = Math.max(...ranked.map((view) => Math.max(Array.from(view.text).length, Array.from(view.evidence).length)));
  let best;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = render(mid);
    if (sizeOf(candidate) <= maxBytes) { best = candidate; low = mid + 1; } else high = mid - 1;
  }
  if (best !== undefined) return { entries: best, bytes: sizeOf(best), truncated: true, dropped: 0 };
  // 极端：字段清空仍超预算 → 从尾部截条数（至少保留 1 条）。
  const candidate = render(0);
  while (candidate.length > 1 && sizeOf(candidate) > maxBytes) candidate.pop();
  return { entries: candidate, bytes: sizeOf(candidate), truncated: true, dropped: ranked.length - candidate.length };
}

/**
 * 合并（去重 + 双上限淘汰）；返回新列表与计数。无证据的条目静默忽略（写入门槛）。
 * reservedBytes：文件里手工保留行占用的字节，计入 ≤8KB 预算（不参与淘汰）。
 */
export function mergeLessons(entries, incoming, { now = Date.now(), reservedBytes = 0 } = {}) {
  const list = entries.map((entry) => ({ ...entry }));
  const day = today(now);
  let added = 0;
  let merged = 0;
  const limited = Array.isArray(incoming) ? incoming.slice(0, LESSON_LIMITS.perCall) : [];
  for (const raw of limited) {
    const tag = normalizeTag(raw?.tag);
    const text = normalizeText(raw?.text);
    const evidence = normalizeText(raw?.evidence, LESSON_LIMITS.evidence);
    if (text === '' || evidence === '') continue;
    const key = tag + '\u0000' + text.toLowerCase();
    const hit = list.find((entry) => entry.tag + '\u0000' + entry.text.toLowerCase() === key);
    if (hit !== undefined) {
      hit.seen = Math.min(hit.seen + 1, LESSON_LIMITS.seenCap);
      hit.updated = day;
      hit.evidence = evidence;
      merged += 1;
      continue;
    }
    list.push({ tag, text, evidence, seen: 1, updated: day });
    added += 1;
  }
  let evicted = 0;
  while (list.length > LESSON_LIMITS.entries) { list.splice(weakestIndex(list, now), 1); evicted += 1; }
  while (bytesOf(formatLessons(list)) + reservedBytes > LESSON_LIMITS.bytes && list.length > 1) { list.splice(weakestIndex(list, now), 1); evicted += 1; }
  return { entries: list, added, merged, evicted };
}

function readContent(cwd) {
  try { return readFileSync(lessonsPath(cwd), 'utf8'); } catch { return ''; }
}

/** 读盘（缺失/畸形 → 空列表）。 */
export function loadLessons(cwd) {
  return parseContent(readContent(cwd)).entries;
}

/** 原子写盘；失败不抛（经验存档是增强项，不阻断工具主流程）。unknownLines = 手工保留行。 */
export function saveLessons(cwd, entries, unknownLines = []) {
  const path = lessonsPath(cwd);
  const text = formatLessons(entries, unknownLines);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.' + process.pid + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    return { ok: true, path, bytes: bytesOf(text) };
  } catch (error) {
    return { ok: false, path, error: String(error?.message ?? error) };
  }
}

/**
 * 记录本次经验（无有效条目且未触发淘汰 → undefined / 不落盘）。
 * 手工编辑行原样保留；本次入参全非法但存量超限被淘汰时仍落盘，并返回真实 evicted。
 */
export function recordLessons(cwd, incoming, { now = Date.now() } = {}) {
  if (!Array.isArray(incoming) || incoming.length === 0) return undefined;
  const parsed = parseContent(readContent(cwd));
  const unknownBytes = parsed.unknown.length === 0 ? 0 : bytesOf(parsed.unknown.join('\n') + '\n');
  const merged = mergeLessons(parsed.entries, incoming, { now, reservedBytes: unknownBytes });
  const changed = merged.added + merged.merged > 0 || merged.evicted > 0;
  if (!changed) return { added: 0, merged: 0, evicted: 0, total: merged.entries.length, saved: false, bytes: 0 };
  const saved = saveLessons(cwd, merged.entries, parsed.unknown);
  return { added: merged.added, merged: merged.merged, evicted: merged.evicted, total: merged.entries.length, saved: saved.ok, path: saved.path, bytes: saved.bytes };
}

/** 读取视图：总量 + 本次该注入的相关条目 + 注入预算用量（超限时 truncated/dropped 供调用方标注）。 */
export function lessonsView(cwd, { goal = '', paths = [] } = {}) {
  const entries = loadLessons(cwd);
  const picked = selectLessons(entries, { goal, paths });
  return {
    total: entries.length,
    bytes: bytesOf(formatLessons(entries)),
    selected: picked.entries,
    injection: { bytes: picked.bytes, limit: LESSON_LIMITS.injectBytes, truncated: picked.truncated, dropped: picked.dropped },
  };
}

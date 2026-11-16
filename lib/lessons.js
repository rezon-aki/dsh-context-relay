/**
 * dsh-context-relay — 经验存档（可复用做法 / 踩过的坑），带防膨胀。
 *
 * 目的（ACE ICLR 2026 的「演化手册」思路）：跨 phase / 跨会话保留「验证过的做法」，
 * 而不是每次组织上下文都重写一份摘要（重写会塌缩、丢条目）。
 *
 * 防膨胀设计（四道闸）：
 *   1) 写入门槛：必须带证据指针；合格输入先完整归档，live 单次 ≤3 条、字段 ≤200 字。
 *   2) 去重合并：键 = tag + 规范化正文；重复命中只增加 seen 并刷新日期/证据，不追加新行。
 *   3) 双上限归档：≤40 条且 ≤8KB；超出按「复现次数（封顶 9×2）+ 新鲜度（7d=6 / 30d=3 / 90d=1）」把最弱者移入
 *      lessons-archive.ndjson（只追加、不裁剪；live 少了但总数不丢）。
 *   4) 读取限额：每次只注入前 3 条与当前 phase 目标相关的条目（按 token 重叠排序，回退新鲜度），
 *      注入总量 ≤1KB（超出先统一截字段、再截条数，并在 lessonsView.injection 标注）。
 *
 * 存储：<cwd>/.scratch/context-relay/lessons.md（live 单文件、人可读、可 git diff、原子写）；
 *       被移出的条目追加到 .scratch/context-relay/lessons-archive.ndjson（一行一条 JSON，只追加不裁剪）。
 * 手工编辑：无法解析的非表头行原样保留，下次落盘不丢。
 *
 * @module dsh-context-relay/lessons
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoCredentials, workspaceStore } from './storage.js';

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
const HEADER = '# 经验存档（dsh-context-relay）\n\n> 每行一条；seen = 复现次数。超 40 条或 8KB 移入 lessons-archive.ndjson（不淘汰）；无法解析的手工行原样保留。\n\n';

export function lessonsPath(cwd) {
  return join(cwd, '.scratch', 'context-relay', 'lessons.md');
}

/** 归档路径：被移出 live 的条目按 NDJSON 追加于此（只追加、不裁剪）。 */
export function lessonsArchivePath(cwd) {
  return join(cwd, '.scratch', 'context-relay', 'lessons-archive.ndjson');
}

/**
 * 追加归档（一行一个 JSON：tag/text/evidence/seen/updated/evictedAt）；首次自动建文件。
 * 读旧 + 原子替换在 workspaceStore 异步写锁内（跨进程互斥）。
 * 失败降级返回 { ok:false, error }，不抛错、不阻断调用方（由调用方决定降级方式）。
 */
export async function archiveLessons(cwd, evictedEntries, { now = Date.now() } = {}) {
  const path = lessonsArchivePath(cwd);
  const list = Array.isArray(evictedEntries) ? evictedEntries : [];
  if (list.length === 0) return { ok: true, path, appended: 0 };
  try {
    const evictedAt = new Date(now).toISOString();
    const lines = list.map((entry) => JSON.stringify({
      tag: entry.tag,
      text: entry.text,
      evidence: entry.evidence,
      seen: entry.seen,
      updated: entry.updated,
      evictedAt,
      ...(entry.original === undefined ? {} : { original: entry.original }),
    }));
    lines.forEach(assertNoCredentials);
    const store = workspaceStore(cwd);
    const target = store.path(path);
    await store.withFileLock(target, () => store.replace(target, (store.readText(target) ?? '') + lines.join('\n') + '\n'));
    return { ok: true, path, appended: list.length };
  } catch (error) {
    return { ok: false, path, appended: 0, error: String(error?.message ?? error) };
  }
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
 * 合并（去重 + 双上限）；返回新列表与计数。无证据的条目静默忽略（写入门槛）。
 * 被移出的条目按移除顺序收进 evictedEntries（供调用方归档；不丢数据）。
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
  const evictedEntries = [];
  while (list.length > LESSON_LIMITS.entries) evictedEntries.push(list.splice(weakestIndex(list, now), 1)[0]);
  while (bytesOf(formatLessons(list)) + reservedBytes > LESSON_LIMITS.bytes && list.length > 1) evictedEntries.push(list.splice(weakestIndex(list, now), 1)[0]);
  return { entries: list, added, merged, evicted: evictedEntries.length, evictedEntries };
}

function readContent(cwd) {
  try { return readFileSync(lessonsPath(cwd), 'utf8'); } catch { return ''; }
}

/** 读盘（缺失/畸形 → 空列表）。 */
export function loadLessons(cwd) {
  return parseContent(readContent(cwd)).entries;
}

/**
 * 原子写盘 live 文件；写前先把 evictedEntries 追加进归档（NDJSON）。
 * 归档失败降级不阻断：本批淘汰回填 live（宁超 advisory 上限也不丢条目），仍照常写盘。
 * 写盘失败不抛（经验存档是增强项，不阻断工具主流程）。unknownLines = 手工保留行。
 * 返回 { ok, path, bytes, count, archive?, retained? }（archive = { ok, path, appended, error? }）。
 */
export async function saveLessons(cwd, entries, unknownLines = [], options = {}) {
  try {
    const store = workspaceStore(cwd);
    const target = store.path(lessonsPath(cwd));
    return await store.withFileLock(target, () => saveLessonsUnlocked(cwd, entries, unknownLines, options, store, target));
  } catch (error) { return { ok: false, path: lessonsPath(cwd), count: entries.length, error: String(error?.message ?? error) }; }
}

/** 调用方已持有 live 文件锁：归档（另文件，独立锁）+ 原子替换 live。 */
async function saveLessonsUnlocked(cwd, entries, unknownLines = [], { evictedEntries = [], now = Date.now() } = {}, store, target) {
  const evicted = Array.isArray(evictedEntries) ? evictedEntries : [];
  const archived = evicted.length === 0 ? undefined : await archiveLessons(cwd, evicted, { now });
  // 归档失败 → 回填 live 重试下次归档；live 上限是 advisory，不丢数据优先。
  const fallback = archived?.ok === false ? [...entries, ...evicted] : entries;
  const path = lessonsPath(cwd);
  const text = formatLessons(fallback, unknownLines);
  const meta = {
    count: fallback.length,
    ...(archived === undefined ? {} : { archive: archived }),
    ...(archived?.ok === false ? { retained: evicted.length } : {}),
  };
  try {
    store.replace(target, text);
    return { ok: true, path, bytes: bytesOf(text), ...meta };
  } catch (error) {
    return { ok: false, path, error: String(error?.message ?? error), ...meta };
  }
}

/**
 * 记录本次经验（无有效条目且未触发归档 → undefined / 不落盘）。
 * 手工编辑行原样保留；本次入参全非法但存量超限时仍落盘，并返回真实 evicted。
 * 触发归档时返回 archive 状态；归档失败降级不阻断（本批淘汰回填 live，retained 计数）。
 */
export async function recordLessons(cwd, incoming, { now = Date.now() } = {}) {
  if (!Array.isArray(incoming) || incoming.length === 0) return undefined;
  try {
    assertNoCredentials(JSON.stringify(incoming));
    const store = workspaceStore(cwd);
    const target = store.path(lessonsPath(cwd));
    return await store.withFileLock(target, async () => {
      // Persist exact input before any per-call/field normalization can discard it.
      const originals = incoming.flatMap((raw) => {
        if (normalizeText(raw?.text) === '' || normalizeText(raw?.evidence) === '') return [];
        return [{ tag: raw?.tag, text: raw?.text, evidence: raw?.evidence, seen: 1, updated: today(now), original: raw }];
      });
      const originalArchive = originals.length === 0 ? undefined : await archiveLessons(cwd, originals, { now });
      if (originalArchive?.ok === false) return { saved: false, error: originalArchive.error, archive: originalArchive };
      const parsed = parseContent(readContent(cwd));
      const unknownBytes = parsed.unknown.length === 0 ? 0 : bytesOf(parsed.unknown.join('\n') + '\n');
      const merged = mergeLessons(parsed.entries, incoming, { now, reservedBytes: unknownBytes });
      const changed = merged.added + merged.merged > 0 || merged.evicted > 0;
      if (!changed) return { added: 0, merged: 0, evicted: 0, total: merged.entries.length, saved: false, bytes: 0, ...(originalArchive === undefined ? {} : { originalArchive }) };
      const saved = await saveLessonsUnlocked(cwd, merged.entries, parsed.unknown, { evictedEntries: merged.evictedEntries, now }, store, target);
      return {
        added: merged.added,
        merged: merged.merged,
        evicted: merged.evicted,
        total: saved.count,
        saved: saved.ok,
        path: saved.path,
        bytes: saved.bytes,
        ...(saved.archive === undefined ? {} : { archive: saved.archive }),
        ...(saved.retained === undefined ? {} : { retained: saved.retained }),
        ...(saved.error === undefined ? {} : { error: saved.error }),
        ...(originalArchive === undefined ? {} : { originalArchive }),
      };
    });
  } catch (error) { return { saved: false, error: String(error?.message ?? error) }; }
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LESSON_LIMITS,
  archiveLessons,
  formatLessons,
  lessonScore,
  lessonsArchivePath,
  lessonsPath,
  lessonsView,
  loadLessons,
  mergeLessons,
  normalizeTag,
  normalizeText,
  parseLessons,
  recordLessons,
  saveLessons,
  selectLessons,
} from '../lib/lessons.js';

const freshCwd = () => mkdtempSync(join(tmpdir(), 'relay-lessons-'));

/** 造 count 条「最弱」条目（旧且只复现 1 次）：淘汰测试的最小夹具。 */
const oldEntries = (count, tag = 'old') => Array.from({ length: count }, (_, i) => ({
  tag,
  text: tag + '条目 ' + i,
  evidence: 'e:' + i,
  seen: 1,
  updated: '2025-01-01',
}));

test('lessons: tag/text 规范化（分隔符与空白、长度截断）', () => {
  assert.equal(normalizeTag('Build Test'), 'build-test');
  assert.equal(normalizeTag('!!!'), 'general');
  assert.equal(normalizeText('  a · b\n c  '), 'a - b c');
  assert.equal(normalizeText('x'.repeat(500)).length, LESSON_LIMITS.text);
});

test('lessons: parse/format 往返；畸形行不参与解析但可原样保留', () => {
  const entries = [{ tag: 'build', text: '先跑测试', evidence: 'AGENTS.md:1', seen: 3, updated: '2026-10-26' }];
  assert.deepEqual(parseLessons(formatLessons(entries)), entries);
  const mixed = formatLessons(entries) + 'garbage line\n- [Bad Tag] nope\n';
  assert.equal(parseLessons(mixed).length, 1);
  // 手工行不进条目，但 formatLessons 的第二参数可原样保留（HEADER 不算手工行）。
  const kept = formatLessons(entries, ['garbage line', '- [Bad Tag] nope']);
  assert.match(kept, /garbage line/);
  assert.match(kept, /- \[Bad Tag\] nope/);
  assert.equal(parseLessons(kept).length, 1);
});

test('lessons: HEADER 声明「超 40 条或 8KB 移入归档（不淘汰）」', () => {
  const text = formatLessons([{ tag: 't', text: 'x', evidence: 'e', seen: 1, updated: '2026-10-26' }]);
  assert.match(text, /lessons-archive\.ndjson/);
  assert.match(text, /不淘汰/);
  assert.doesNotMatch(text, /淘汰最弱/, '旧口径（淘汰丢条目）不得留在文件头');
  assert.equal(parseLessons(text).length, 1, '表头不参与解析');
});

test('lessons: 重复写入合并（seen+1、证据刷新），无证据条目静默丢弃', () => {
  const cwd = freshCwd();
  const first = recordLessons(cwd, [{ tag: 'test', text: '先跑 npm test 再提交', evidence: 'AGENTS.md:1' }]);
  assert.equal(first.added, 1);
  assert.equal(first.saved, true);
  const second = recordLessons(cwd, [
    { tag: 'test', text: '先跑 npm test 再提交', evidence: 'AGENTS.md:2' },
    { tag: 'x', text: '没有证据的空话' },
    { tag: 'x', text: '   ' , evidence: 'nope' },
  ]);
  assert.equal(second.merged, 1);
  assert.equal(second.added, 0);
  const entries = loadLessons(cwd);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].seen, 2);
  assert.equal(entries[0].evidence, 'AGENTS.md:2');
  // 全部无效 → 不落盘、返回 saved:false
  const cwd2 = freshCwd();
  const none = recordLessons(cwd2, [{ text: '无证据' }]);
  assert.equal(none.saved, false);
  assert.equal(existsSync(lessonsPath(cwd2)), false);
});

test('lessons: 单次调用最多 3 条；空数组返回 undefined', () => {
  const cwd = freshCwd();
  const result = recordLessons(cwd, [1, 2, 3, 4, 5].map((i) => ({ tag: 't', text: '条目 ' + i, evidence: 'e:' + i })));
  assert.equal(result.added, LESSON_LIMITS.perCall);
  assert.equal(loadLessons(cwd).length, LESSON_LIMITS.perCall);
  assert.equal(recordLessons(cwd, []), undefined);
});

test('lessons: 条数上限 40 把最弱条目移出 live（旧且少复现的先走，并入 evictedEntries）', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const entries = [];
  for (let i = 0; i < 38; i += 1) {
    entries.push({ tag: 'old', text: '旧条目 ' + i, evidence: 'e:' + i, seen: 1, updated: '2025-01-01' });
  }
  entries.push({ tag: 'hot', text: '高频条目', evidence: 'e:hot', seen: 9, updated: '2026-10-26' });
  entries.push({ tag: 'fresh', text: '新条目', evidence: 'e:fresh', seen: 1, updated: '2026-10-26' });
  const merged = mergeLessons(entries, [{ tag: 'new', text: '新增', evidence: 'e:new' }], { now });
  assert.ok(merged.entries.length <= LESSON_LIMITS.entries);
  assert.ok(merged.evicted >= 1);
  assert.equal(merged.evicted, merged.evictedEntries.length, 'evicted 计数与 evictedEntries 一致');
  assert.deepEqual(merged.evictedEntries.map((entry) => entry.text), ['旧条目 0'], '最弱条目先被移出');
  assert.deepEqual(Object.keys(merged.evictedEntries[0]).sort(), ['evidence', 'seen', 'tag', 'text', 'updated'], '移出条目是完整 entry');
  assert.ok(merged.entries.some((e) => e.tag === 'hot'), '高频条目必须保留');
  assert.ok(merged.entries.some((e) => e.tag === 'fresh'), '新条目优先保留');
  assert.ok(!merged.entries.some((e) => e.tag === 'old' && e.text === '旧条目 0'), 'live 不再含最旧条目');
  // 不修改入参
  assert.equal(entries[0].seen, 1);
  assert.equal(entries.length, 40);
});

test('lessons: 字节上限 8KB 兜底（长条目也不会撑爆；移出条目全部进 evictedEntries）', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const entries = [];
  for (let i = 0; i < LESSON_LIMITS.entries; i += 1) {
    entries.push({ tag: 'long', text: ('长' + i + ' ').repeat(60).slice(0, LESSON_LIMITS.text), evidence: 'e:' + i, seen: 1, updated: '2026-10-01' });
  }
  const merged = mergeLessons(entries, [], { now });
  const bytes = Buffer.byteLength(formatLessons(merged.entries), 'utf8');
  assert.ok(bytes <= LESSON_LIMITS.bytes, 'bytes=' + bytes);
  assert.ok(merged.entries.length > 1, '不能一条不剩');
  assert.equal(merged.evicted, merged.evictedEntries.length);
  assert.equal(merged.evictedEntries.length + merged.entries.length, LESSON_LIMITS.entries, 'live + 移出 = 全部条目');
  const liveTexts = new Set(merged.entries.map((entry) => entry.text));
  assert.ok(merged.evictedEntries.every((entry) => !liveTexts.has(entry.text)), '移出条目不在 live 里');
});

test('lessons: 读取按相关度选前 3 条（goal token 命中优先），并受注入上限', () => {
  const entries = [
    { tag: 'build', text: '提交前跑 npm test', evidence: 'AGENTS.md:1', seen: 1, updated: '2026-01-01' },
    { tag: 'docs', text: '文档改完跑 doc_lint', evidence: 'AGENTS.md:2', seen: 1, updated: '2026-10-20' },
    { tag: 'misc', text: '无关条目', evidence: 'x:1', seen: 1, updated: '2026-10-25' },
  ];
  const picked = selectLessons(entries, { goal: 'npm test 全绿', limit: 2 });
  assert.equal(picked.entries.length, 2);
  assert.equal(picked.entries[0].tag, 'build', 'token 命中的排最前');
  assert.equal(picked.truncated, false);
  assert.ok(picked.bytes <= LESSON_LIMITS.injectBytes);
});

test('lessons: 注入上限回归（selected ≤3 条、≤1KB）', () => {
  assert.equal(LESSON_LIMITS.inject, 3);
  assert.equal(LESSON_LIMITS.injectBytes, 1024);
});

test('lessons: 注入总量 ≤1KB：超长 3 条先统一截字段并标注 truncated', () => {
  const entries = [];
  for (let i = 0; i < LESSON_LIMITS.inject; i += 1) {
    entries.push({
      tag: 'long',
      text: ('长文本' + i + ' ').repeat(60).slice(0, LESSON_LIMITS.text),
      evidence: 'e:' + i + ' ' + '证据'.repeat(80),
      seen: 1,
      updated: '2026-10-01',
    });
  }
  const picked = selectLessons(entries, { goal: '' });
  assert.equal(picked.entries.length, LESSON_LIMITS.inject, '截字段后仍保留全部条数');
  assert.ok(picked.bytes <= LESSON_LIMITS.injectBytes, 'bytes=' + picked.bytes);
  assert.equal(picked.truncated, true, '超预算必须标注');
  assert.equal(picked.dropped, 0);
  for (const entry of picked.entries) {
    assert.ok(Array.from(entry.text).length <= LESSON_LIMITS.text);
    assert.ok(Array.from(entry.evidence).length <= LESSON_LIMITS.evidence);
  }
  assert.ok(picked.entries.some((entry) => entry.text.endsWith('…') || entry.evidence.endsWith('…')), '字段被截断');
  // lessonsView 透出注入预算用量
  const cwd = freshCwd();
  saveLessons(cwd, entries);
  const view = lessonsView(cwd, { goal: '' });
  assert.equal(view.injection.limit, LESSON_LIMITS.injectBytes);
  assert.equal(view.injection.truncated, true);
  assert.ok(view.injection.bytes <= LESSON_LIMITS.injectBytes);
  assert.equal(view.selected.length, LESSON_LIMITS.inject);
});

test('lessons: 手工编辑的未知行保存时原样保留', () => {
  const cwd = freshCwd();
  mkdirSync(dirname(lessonsPath(cwd)), { recursive: true });
  writeFileSync(
    lessonsPath(cwd),
    formatLessons([{ tag: 't', text: '旧条目', evidence: 'e:1', seen: 1, updated: '2026-10-01' }]) + '手写备注：这条不要删\n- [Bad Tag] nope\n',
    'utf8',
  );
  const recorded = recordLessons(cwd, [{ tag: 'n', text: '新经验', evidence: 'e:2' }]);
  assert.equal(recorded.saved, true);
  const text = readFileSync(lessonsPath(cwd), 'utf8');
  assert.match(text, /手写备注：这条不要删/, '手工行不得被静默删除');
  assert.match(text, /- \[Bad Tag\] nope/);
  assert.match(text, /新经验/);
  assert.equal(loadLessons(cwd).length, 2);
});

test('lessons: 早退分支返回真实 evicted，且本次入参全非法但有淘汰时落盘并归档（live 减少、归档含被淘汰条目）', () => {
  const cwd = freshCwd();
  const now = Date.parse('2026-10-26T00:00:00Z');
  mkdirSync(dirname(lessonsPath(cwd)), { recursive: true });
  writeFileSync(lessonsPath(cwd), formatLessons(oldEntries(45)), 'utf8');
  // 本次入参只有无证据条目 → added/merged=0，但存量 45 条应淘汰到 40 并落盘。
  const result = recordLessons(cwd, [{ text: '没有证据的空话' }], { now });
  assert.equal(result.added + result.merged, 0);
  assert.equal(result.evicted, 5);
  assert.equal(result.saved, true);
  assert.equal(result.total, LESSON_LIMITS.entries);
  assert.equal(loadLessons(cwd).length, LESSON_LIMITS.entries);
  // live 减少但归档含被淘汰条目：总数不丢。
  assert.equal(result.archive?.ok, true, '归档成功');
  assert.equal(result.archive.appended, 5);
  assert.equal(result.archive.path, lessonsArchivePath(cwd));
  const archived = readFileSync(lessonsArchivePath(cwd), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(archived.length, 5);
  assert.equal(archived.length + loadLessons(cwd).length, 45, 'live + 归档 = 总数，不丢数据');
  assert.deepEqual(archived.map((item) => item.text).sort(), ['old条目 0', 'old条目 1', 'old条目 2', 'old条目 3', 'old条目 4'].sort());
  assert.ok(!readFileSync(lessonsPath(cwd), 'utf8').includes('old条目 0'), '被淘汰条目不再留在 live');
});

test('lessons: 归档为 NDJSON（一行一个完整 JSON），追加不裁剪', () => {
  const cwd = freshCwd();
  const now = Date.parse('2026-10-26T00:00:00Z');
  mkdirSync(dirname(lessonsPath(cwd)), { recursive: true });
  writeFileSync(lessonsPath(cwd), formatLessons(oldEntries(45)), 'utf8');
  assert.equal(existsSync(lessonsArchivePath(cwd)), false, '首次淘汰前不建归档文件');
  recordLessons(cwd, [{ text: '无效' }], { now });
  const archivePath = lessonsArchivePath(cwd);
  assert.equal(existsSync(archivePath), true, '首次淘汰自动建归档文件');
  const firstLines = readFileSync(archivePath, 'utf8').trim().split('\n');
  assert.equal(firstLines.length, 5);
  const records = firstLines.map((line) => JSON.parse(line)); // 每行必须是合法 JSON（无表头/无多行）
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['evictedAt', 'evidence', 'seen', 'tag', 'text', 'updated']);
    assert.equal(record.tag, 'old');
    assert.equal(record.seen, 1);
    assert.equal(record.updated, '2025-01-01');
    assert.equal(record.evictedAt, new Date(now).toISOString(), 'evictedAt 用 now 的 ISO 时间');
  }
  // 第二轮淘汰再追加 5 条：旧归档行不裁剪。
  writeFileSync(lessonsPath(cwd), formatLessons(oldEntries(45, 'next')), 'utf8');
  const second = recordLessons(cwd, [{ text: '无效' }], { now });
  assert.equal(second.evicted, 5);
  const secondLines = readFileSync(archivePath, 'utf8').trim().split('\n');
  assert.equal(secondLines.length, 10, '归档只追加不裁剪');
  assert.deepEqual(secondLines.slice(0, 5), firstLines, '旧归档行原样保留');
  assert.equal(JSON.parse(secondLines[5]).text, 'next条目 0');
});

test('lessons: archiveLessons 空列表不建文件、不追加', () => {
  const cwd = freshCwd();
  const result = archiveLessons(cwd, []);
  assert.deepEqual(result, { ok: true, path: lessonsArchivePath(cwd), appended: 0 });
  assert.equal(existsSync(lessonsArchivePath(cwd)), false);
});

test('lessons: 归档 append 失败降级——不抛错、live 仍写盘、本批淘汰回填 live（不丢数据）', () => {
  const cwd = freshCwd();
  const now = Date.parse('2026-10-26T00:00:00Z');
  mkdirSync(dirname(lessonsPath(cwd)), { recursive: true });
  writeFileSync(lessonsPath(cwd), formatLessons(oldEntries(45)), 'utf8');
  // 用目录占位归档路径，制造 append 失败（EISDIR），不阻断主流程。
  mkdirSync(lessonsArchivePath(cwd), { recursive: true });
  const result = recordLessons(cwd, [{ text: '无效' }], { now });
  assert.equal(result.saved, true, '归档失败不阻断 live 写盘');
  assert.equal(result.archive?.ok, false, '失败如实返回（调用方可记录/重试）');
  assert.match(String(result.archive.error), /EISDIR|illegal operation/i);
  assert.equal(result.retained, 5, '回填计数');
  assert.equal(result.total, 45, '总数不丢（live 暂超 advisory 上限，下次写盘重试归档）');
  assert.equal(loadLessons(cwd).length, 45);
});

test('lessons: load 缺失/畸形文件返回空；save 原子写', () => {
  const cwd = freshCwd();
  assert.deepEqual(loadLessons(cwd), []);
  mkdirSync(dirname(lessonsPath(cwd)), { recursive: true });
  writeFileSync(lessonsPath(cwd), 'not a lessons file\n', 'utf8');
  assert.deepEqual(loadLessons(cwd), []);
  const saved = saveLessons(cwd, [{ tag: 't', text: 'x', evidence: 'e', seen: 1, updated: '2026-10-26' }]);
  assert.equal(saved.ok, true);
  assert.match(readFileSync(lessonsPath(cwd), 'utf8'), /- \[t\] x/);
});

test('lessons: lessonsView 只返回摘要字段，不泄露 seen/updated 内部字段', () => {
  const cwd = freshCwd();
  recordLessons(cwd, [{ tag: 't', text: '经验一', evidence: 'e:1' }]);
  const view = lessonsView(cwd, { goal: '经验' });
  assert.equal(view.total, 1);
  assert.deepEqual(Object.keys(view.selected[0]).sort(), ['evidence', 'tag', 'text']);
  assert.equal(view.injection.truncated, false);
  assert.equal(view.injection.limit, LESSON_LIMITS.injectBytes);
});

test('lessons: lessonScore 随复现与新鲜度单调', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const old = lessonScore({ seen: 1, updated: '2025-01-01' }, now);
  const fresh = lessonScore({ seen: 1, updated: '2026-10-25' }, now);
  const hot = lessonScore({ seen: 9, updated: '2026-10-25' }, now);
  assert.ok(fresh > old);
  assert.ok(hot > fresh);
});

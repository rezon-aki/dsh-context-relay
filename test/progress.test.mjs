import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROGRESS_LIMIT_BYTES,
  PROGRESS_RELATIVE,
  freshProgressState,
  mergeProgress,
  parseProgress,
  renderBoundedProgress,
  restoreProgress,
  updateProgress,
} from '../lib/agent/progress.js';

const tmpCwd = () => mkdtempSync(join(tmpdir(), 'relay-progress-'));
const progressPath = (cwd) => join(cwd, '.scratch', 'context-relay', 'progress.md');
const archivePath = (cwd, year) => join(cwd, '.scratch', 'context-relay', 'progress-archive-' + year + '.md');

test('滚动进度：首次交接创建文件（持有会话/时间线/JSON 机器块），再次交接滚动合并', () => {
  const cwd = tmpCwd();
  const first = updateProgress(cwd, {
    sessionId: 'session-a',
    phase: 'build',
    status: { goal: 'ship relay', phase: 'build', done: ['d1'], next_actions: ['n1'], blocked: ['b1'], success_criteria: ['s1'] },
    evidence: ['lib/agent.js:1'],
    decisions: ['use official compaction'],
    constraints: ['no kernel patch'],
    key_docs: ['docs/SPEC.md'],
    handoffPath: 'handoff-1.md',
  });
  assert.equal(first.updated, true);
  assert.equal(first.relativePath, PROGRESS_RELATIVE);
  const raw1 = readFileSync(progressPath(cwd), 'utf8');
  const state1 = parseProgress(raw1);
  assert.equal(state1.holder, 'session-a');
  assert.equal(state1.updates, 1);
  assert.equal(state1.timeline.length, 1);
  assert.match(raw1, /持有会话：session-a/);
  // 第二次交接：持有会话换新、状态覆盖、决策追加去重、时间线 2 条
  const second = updateProgress(cwd, {
    sessionId: 'session-b',
    phase: 'verify',
    status: { goal: 'ship relay', phase: 'verify', done: ['d1', 'd2'], next_actions: ['n2'], blocked: [] },
    evidence: ['lib/agent/handoff.js:1'],
    decisions: ['use official compaction', 'rolling progress file'],
    handoffPath: 'handoff-2.md',
    now: '2026-11-01T12:00:00.000Z',
  });
  assert.equal(second.updated, true);
  assert.equal(second.archived, 0);
  const state2 = parseProgress(readFileSync(progressPath(cwd), 'utf8'));
  assert.equal(state2.holder, 'session-b');
  assert.equal(state2.updates, 2);
  assert.equal(state2.timeline.length, 2);
  assert.equal(state2.timeline[0].handoffPath, 'handoff-2.md');
  assert.deepEqual(state2.decisions, ['use official compaction', 'rolling progress file'], '追加去重且最近在前（本次传入顺序，重复项只留一次）');
  assert.deepEqual(state2.next_actions, ['n2'], '状态段覆盖');
  assert.deepEqual(state2.done, ['d1', 'd2']);
});

test('滚动进度：超 8KB 自动归档最旧时间线/决策，主文件不超上限', () => {
  const cwd = tmpCwd();
  const many = Array.from({ length: 40 }, (_, index) => 'decision-' + index + '-' + 'x'.repeat(180));
  const result = updateProgress(cwd, {
    sessionId: 'session-big',
    phase: 'build',
    status: { goal: 'big goal', phase: 'build' },
    decisions: many,
    evidence: Array.from({ length: 24 }, (_, index) => 'evidence-' + index + '-' + 'x'.repeat(180)),
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(result.updated, true);
  assert.ok(result.bytes <= PROGRESS_LIMIT_BYTES, '主文件字节 ' + result.bytes + ' <= ' + PROGRESS_LIMIT_BYTES);
  assert.ok(result.archived > 0, '超限必须有归档条目');
  assert.ok(existsSync(archivePath(cwd, '2026')), '归档文件已创建');
  const archived = readFileSync(archivePath(cwd, '2026'), 'utf8');
  assert.match(archived, /^- (decision|evidence|timeline) /m);
  const state = parseProgress(readFileSync(progressPath(cwd), 'utf8'));
  assert.ok(state.decisions.length <= 40);
  assert.ok(Buffer.byteLength(readFileSync(progressPath(cwd), 'utf8'), 'utf8') <= PROGRESS_LIMIT_BYTES);
});

test('滚动进度：状态段超限也保证主文件不超上限并显式记录裁剪（2026-11-01 审查 P1）', () => {
  const cwd = tmpCwd();
  const big = (label) => Array.from({ length: 40 }, (_, index) => label + '-' + index + '-' + 'x'.repeat(190));
  const result = updateProgress(cwd, {
    sessionId: 'session-status-big',
    phase: 'build',
    status: { goal: 'status overflow', phase: 'build', success_criteria: big('sc'), done: big('done'), next_actions: big('next'), blocked: big('blocked') },
    open_questions: big('oq'),
    decisions: big('dec'),
    constraints: big('c'),
    risks: big('r'),
    evidence: big('ev'),
    key_docs: big('kd'),
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(result.updated, true);
  const raw = readFileSync(progressPath(cwd), 'utf8');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= PROGRESS_LIMIT_BYTES, '状态段超限时主文件也必须 <= 上限（实测 ' + Buffer.byteLength(raw, 'utf8') + '）');
  assert.ok(result.bytes <= PROGRESS_LIMIT_BYTES);
  const state = parseProgress(raw);
  assert.equal(typeof state.trimmed, 'string');
  assert.match(state.trimmed, /已裁剪/);
  assert.match(raw, /已裁剪/, '裁剪事实必须显式展示，不静默');
  assert.ok(state.done.length <= 12, 'done 条数受限');
  assert.ok(state.next_actions.length <= 8, 'next_actions 条数受限');
  assert.ok(state.key_docs.length <= 12, 'key_docs 条数受限');
});

test('滚动进度：条目长度裁剪也写入 trimmed（不静默；2026-11-01 复核发现）', () => {
  const cwd = tmpCwd();
  const result = updateProgress(cwd, {
    sessionId: 'session-item-clip',
    phase: 'build',
    status: { goal: 'item clip', phase: 'build', done: ['D'.repeat(20000)] },
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(result.updated, true);
  assert.ok(result.bytes <= PROGRESS_LIMIT_BYTES);
  const raw = readFileSync(progressPath(cwd), 'utf8');
  const state = parseProgress(raw);
  assert.equal(typeof state.trimmed, 'string', '条目长度裁剪也必须记录 trimmed（不静默）');
  assert.match(state.trimmed, /截短|已裁剪/);
  assert.match(raw, /已裁剪/);
  assert.ok(state.done[0].length < 2000, '超长条目被截短');
});

test('滚动进度：随机大状态 fuzz 仍保证主文件 ≤8KB（2026-11-01 复核发现）', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const text = (prefix, max) => prefix + 'x'.repeat(Math.floor(rand() * max));
  const list = (prefix, count) => Array.from({ length: count }, (_, index) => text(prefix + index, 400));
  for (let round = 0; round < 30; round += 1) {
    const cwd = tmpCwd();
    const result = updateProgress(cwd, {
      sessionId: 'session-fuzz-' + round,
      phase: 'build',
      status: {
        goal: text('goal', 5000),
        phase: 'build',
        success_criteria: list('sc', 1 + Math.floor(rand() * 40)),
        done: list('done', 1 + Math.floor(rand() * 40)),
        next_actions: list('next', 1 + Math.floor(rand() * 40)),
        blocked: list('blocked', 1 + Math.floor(rand() * 40)),
      },
      open_questions: list('q', Math.floor(rand() * 40)),
      decisions: list('d', Math.floor(rand() * 40)),
      constraints: list('c', Math.floor(rand() * 30)),
      risks: list('r', Math.floor(rand() * 30)),
      evidence: list('e', Math.floor(rand() * 40)),
      key_docs: list('kd', Math.floor(rand() * 20)),
      now: '2026-11-01T00:00:00.000Z',
    });
    const raw = readFileSync(progressPath(cwd), 'utf8');
    const bytes = Buffer.byteLength(raw, 'utf8');
    assert.ok(bytes <= PROGRESS_LIMIT_BYTES, 'round ' + round + ' 文件 ' + bytes + ' ≤ ' + PROGRESS_LIMIT_BYTES);
    assert.ok(result.bytes <= PROGRESS_LIMIT_BYTES, 'round ' + round + ' result.bytes ' + result.bytes);
  }
});

test('滚动进度：文件损坏时备份 .corrupt-<ts> 并重建；restoreProgress 回滚交接前内容', () => {
  const cwd = tmpCwd();
  mkdirSync(join(cwd, '.scratch', 'context-relay'), { recursive: true });
  writeFileSync(progressPath(cwd), 'broken markdown without json block', 'utf8');
  const result = updateProgress(cwd, { sessionId: 'session-fix', phase: 'build', status: { goal: 'recover' } });
  assert.equal(result.updated, true);
  assert.equal(typeof result.corruptBackup, 'string');
  assert.ok(existsSync(result.corruptBackup), '损坏文件已备份');
  assert.equal(parseProgress(readFileSync(progressPath(cwd), 'utf8')).holder, 'session-fix');
  // 回滚：第二次交接前的内容
  const previousRaw = readFileSync(progressPath(cwd), 'utf8');
  const second = updateProgress(cwd, { sessionId: 'session-next', phase: 'verify', status: { goal: 'recover' } });
  assert.equal(parseProgress(readFileSync(progressPath(cwd), 'utf8')).holder, 'session-next');
  restoreProgress(second);
  assert.equal(readFileSync(progressPath(cwd), 'utf8'), previousRaw, '回滚到交接前内容');
  // 首次交接失败回滚：没有旧内容 → 删除新建文件
  const fresh = tmpCwd();
  const created = updateProgress(fresh, { sessionId: 'session-first', phase: 'build', status: { goal: 'first' } });
  restoreProgress(created);
  assert.equal(existsSync(progressPath(fresh)), false, '首次创建的进度文件被删除');
});

test('滚动进度：merge 纯函数不修改入参；renderBoundedProgress 保留最少条数', () => {
  const cwd = tmpCwd();
  const original = freshProgressState();
  const merged = mergeProgress(original, { sessionId: 's', phase: 'build', status: { goal: 'g' } });
  assert.equal(original.holder, '');
  assert.equal(merged.holder, 's');
  const bounded = renderBoundedProgress({ ...merged, timeline: [{ at: '2026-11-01T00:00:00.000Z', sessionId: 's', phase: 'build', goal: 'g', handoffPath: 'h.md' }] });
  assert.ok(bounded.bytes <= PROGRESS_LIMIT_BYTES);
  assert.equal(bounded.archived.length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyPlan, buildClosure, cutoffMs, planArchive } from '../scripts/docs-archive.mjs';

const w = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const old = new Date('2026-09-01T00:00:00Z');
const now = Date.parse('2026-11-20T12:00:00Z');

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'relay-archive-')), '.scratch', 'context-relay');
  w(join(root, 'progress.md'), '# progress' + String.fromCharCode(10) + '- [活文件](reports/live.md)');
  w(join(root, 'reports', 'live.md'), '# live');
  w(join(root, 'reports', 'old.md'), '# old');
  w(join(root, 'reports', 'recent.md'), '# recent');
  w(join(root, 'handoff-1.md'), '# Handoff · same');
  w(join(root, 'handoff-2.md'), '# Handoff · same');
  w(join(root, 'architecture', 'design.md'), '# design');
  w(join(root, 'lessons.md'), '# lessons');
  for (const rel of ['reports/old.md', 'handoff-1.md', 'handoff-2.md', 'architecture/design.md', 'lessons.md']) {
    utimesSync(join(root, rel), old, old);
  }
  return root;
}

test('cutoff 是 N 个月前当日 00:00', () => {
  assert.equal(new Date(cutoffMs(1, now)).getDate(), 20);
  assert.equal(new Date(cutoffMs(1, now)).getHours(), 0);
});

test('闭包解析相对来源目录与 root，不动活文件', async () => {
  const root = fixture();
  const { closure } = buildClosure(root);
  assert.ok(closure.has('reports/live.md'));
  assert.ok(!closure.has('reports/old.md'));
});

test('计划只移闭包外旧产物，副本进 dupes 且保留最新', async () => {
  const root = fixture();
  await new Promise((r) => setTimeout(r, 20));
  const plan = planArchive({ root, months: 1, now });
  const olds = plan.moves.map((m) => m.old);
  assert.ok(olds.includes('reports/old.md'));
  assert.ok(!olds.includes('reports/live.md'));
  assert.ok(!olds.includes('reports/recent.md'));
  assert.ok(!olds.includes('progress.md'));
  assert.ok(!olds.includes('lessons.md'));
  assert.ok(!olds.includes('architecture/design.md'));
  assert.equal(plan.moves.filter((m) => m.old.startsWith('handoff-')).length, 1);
  assert.equal(plan.moves.find((m) => m.old.startsWith('handoff-')).new, 'archive/dupes/' + plan.moves.find((m) => m.old.startsWith('handoff-')).old);
});

test('apply 移动文件并追加 manifest，不删内容', async () => {
  const root = fixture();
  await new Promise((r) => setTimeout(r, 20));
  const plan = planArchive({ root, months: 1, now });
  const result = applyPlan(plan, { now });
  assert.ok(result.done.length >= 2);
  assert.match(readFileSync(result.manifest, 'utf8'), /"old":"reports\/old.md"/);
  assert.equal(readFileSync(join(root, 'archive', '2026', 'reports', 'old.md'), 'utf8'), '# old');
  assert.equal(readFileSync(join(root, 'reports', 'live.md'), 'utf8'), '# live');
});
test('近期副本也在闭包外去重（规则 3 不看 mtime）', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'relay-archive-')), '.scratch', 'context-relay');
  w(join(root, 'phase-build-recent-a.md'), '# Phase Brief · build' + String.fromCharCode(10) + 'same');
  w(join(root, 'phase-build-recent-b.md'), '# Phase Brief · build' + String.fromCharCode(10) + 'same');
  utimesSync(join(root, 'phase-build-recent-a.md'), new Date('2026-11-19T02:00:00Z'), new Date('2026-11-19T02:00:00Z'));
  utimesSync(join(root, 'phase-build-recent-b.md'), new Date('2026-11-19T03:00:00Z'), new Date('2026-11-19T03:00:00Z'));
  const plan = planArchive({ root, months: 1, now });
  assert.equal(plan.moves.length, 1);
  assert.ok(plan.moves[0].new.startsWith('archive/dupes/'));
  assert.equal(plan.moves[0].old, 'phase-build-recent-a.md');
});

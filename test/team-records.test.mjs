/**
 * 记录按 Lead 会话分区（partition）+ legacy 只读回退：路径/写读/归档。
 * 纯文件 IO + mkdtemp 临时目录：不触网、不碰真实 workspace 记录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_PARTITION_ID,
  TEAM_LIMITS,
  appendLedger,
  archiveCheckpoint,
  buildCheckpointMarkdown,
  checkpointPathOf,
  ensureLineage,
  handoffPathOf,
  ledgerPathOf,
  lineageDirOf,
  partitionRelativePath,
  profilePathOf,
  readCheckpoint,
  readLedger,
  readProfile,
  readRoster,
  retireGeneration,
  rosterPathOf,
  teamBaseOf,
  teamRootOf,
  writeCheckpoint,
  writeRoster,
} from '../lib/agent/team.js';

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'relay-team-records-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 建 roster：{ lineage: [代际名...] | { role?, description? } }；sid 缺省 = legacy。 */
function seedRoster(cwd, leadSessionId, seeds) {
  const roster = { version: 1, lineages: {} };
  for (const [lineage, seed] of Object.entries(seeds)) {
    if (Array.isArray(seed)) {
      for (const name of seed) ensureLineage(roster, lineage, { name, sessionId: 'session-' + name });
    } else {
      ensureLineage(roster, lineage, seed);
    }
  }
  writeRoster(cwd, roster, leadSessionId);
  return roster;
}

/** 递归把记录根内所有文件 mtime 定为同一时刻（updatedAt 断言用）。 */
function touchFiles(root, iso) {
  const when = new Date(iso);
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else utimesSync(path, when, when);
    }
  };
  walk(root);
}

function closeTo(iso, expected) {
  return Math.abs(Date.parse(iso) - Date.parse(expected)) < 2000;
}

function writeText(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

// ── 路径 ───────────────────────────────────────────────────────────────

test('路径：不传 leadSessionId = legacy 旧路径；传 sid = <base>/<sid> 分区路径', () => {
  const dir = tempWorkspace();
  try {
    const base = teamBaseOf(dir);
    assert.equal(base, join(dir, '.scratch', 'context-relay', 'team'));
    assert.equal(teamRootOf(dir), base, '旧调用团队根 = base');
    assert.equal(teamRootOf(dir, 'session-lead'), join(base, 'session-lead'));
    assert.equal(teamRootOf(dir, ''), base, '空字符串视为不分区');
    assert.equal(teamRootOf(dir, LEGACY_PARTITION_ID), base, 'legacy 哨兵 id = base 根');
    assert.equal(rosterPathOf(dir), join(base, 'roster.json'));
    assert.equal(rosterPathOf(dir, 'session-lead'), join(base, 'session-lead', 'roster.json'));
    assert.equal(lineageDirOf(dir, 'impl'), join(base, 'impl'));
    assert.equal(lineageDirOf(dir, 'impl', 'session-lead'), join(base, 'session-lead', 'impl'));
    assert.equal(profilePathOf(dir, 'impl'), join(base, 'impl', 'profile.md'));
    assert.equal(profilePathOf(dir, 'impl', 'session-lead'), join(base, 'session-lead', 'impl', 'profile.md'));
    assert.equal(checkpointPathOf(dir, 'impl', 'session-lead'), join(base, 'session-lead', 'impl', 'checkpoint.md'));
    assert.equal(ledgerPathOf(dir, 'impl', 'session-lead'), join(base, 'session-lead', 'impl', 'ledger.ndjson'));
    assert.equal(handoffPathOf(dir, 'impl', 2), join(base, 'impl', 'handoffs', 'gen-2.md'));
    assert.equal(handoffPathOf(dir, 'impl', 2, 'session-lead'), join(base, 'session-lead', 'impl', 'handoffs', 'gen-2.md'));
    assert.equal(partitionRelativePath('session-lead', 'impl'), '.scratch/context-relay/team/session-lead/impl');
    assert.equal(partitionRelativePath(undefined, 'impl'), '.scratch/context-relay/team/impl');
    assert.throws(() => teamRootOf(dir, 'a/../b'), /invalid partition id/, '分区 id 防路径穿越');
  } finally { cleanup(dir); }
});

// ── 分区写读 ───────────────────────────────────────────────────────────

test('写读分区：同 lineage 在两个 leadSessionId 下互不覆盖，目录自动创建', () => {
  const dir = tempWorkspace();
  try {
    const builtA = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: '分区 A 完成' } });
    const builtB = buildCheckpointMarkdown({ lineage: 'impl', name: 'impl-g1', gen: 1, input: { one_line: '分区 B 完成' } });
    writeCheckpoint(dir, 'impl', builtA.markdown, 'session-a');
    writeCheckpoint(dir, 'impl', builtB.markdown, 'session-b');
    assert.match(readFileSync(checkpointPathOf(dir, 'impl', 'session-a'), 'utf8'), /分区 A 完成/);
    assert.match(readFileSync(checkpointPathOf(dir, 'impl', 'session-b'), 'utf8'), /分区 B 完成/);
    assert.match(readCheckpoint(dir, 'impl', 'session-a').text, /分区 A 完成/);
    assert.match(readCheckpoint(dir, 'impl', 'session-b').text, /分区 B 完成/);
    assert.equal(readCheckpoint(dir, 'impl'), undefined, 'legacy 无记录');
    seedRoster(dir, 'session-a', { impl: ['impl-g1'] });
    seedRoster(dir, 'session-b', { review: ['review-g1'] });
    assert.deepEqual(Object.keys(readRoster(dir, 'session-a').lineages), ['impl']);
    assert.deepEqual(Object.keys(readRoster(dir, 'session-b').lineages), ['review']);
    appendLedger(dir, 'impl', { event: 'checkpoint', name: 'impl-g1', n: 1 }, 'session-a');
    appendLedger(dir, 'impl', { event: 'checkpoint', name: 'impl-g1', n: 2 }, 'session-a');
    appendLedger(dir, 'impl', { event: 'checkpoint', name: 'impl-g1', n: 9 }, 'session-b');
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-a').map((entry) => entry.n), [1, 2]);
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-b').map((entry) => entry.n), [9]);
    assert.deepEqual(readLedger(dir, 'impl', 'session-b').map((entry) => entry.n), [9], '第三参字符串 = sid');
    // 无 sid 写 = legacy，不污染分区
    writeCheckpoint(dir, 'impl', '# legacy', '');
    assert.equal(readFileSync(checkpointPathOf(dir, 'impl'), 'utf8'), '# legacy');
    assert.match(readCheckpoint(dir, 'impl', 'session-a').text, /分区 A 完成/);
  } finally { cleanup(dir); }
});

test('读盘回退：新分区无记录 → legacy；分区有记录 → 优先；都没有 = 现状空值', () => {
  const dir = tempWorkspace();
  try {
    seedRoster(dir, undefined, { impl: ['impl-g1'] });
    writeText(profilePathOf(dir, 'impl'), '# legacy 职责');
    writeCheckpoint(dir, 'impl', '# legacy 交接');
    appendLedger(dir, 'impl', { event: 'checkpoint', name: 'impl-g1', n: 1 });
    assert.match(readCheckpoint(dir, 'impl', 'session-new').text, /legacy 交接/);
    assert.match(readCheckpoint(dir, 'impl', LEGACY_PARTITION_ID).text, /legacy 交接/, 'legacy 哨兵 id 读 base 根');
    assert.match(readProfile(dir, 'impl', 'session-new'), /legacy 职责/);
    assert.equal(readRoster(dir, 'session-new').lineages.impl.activeGen, 1);
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-new').map((entry) => entry.n), [1]);
    assert.deepEqual(readLedger(dir, 'impl', 'session-new').map((entry) => entry.n), [1]);
    // 分区有记录 → 优先
    writeCheckpoint(dir, 'impl', '# 分区交接', 'session-new');
    writeText(profilePathOf(dir, 'impl', 'session-new'), '# 分区职责');
    const roster = { version: 1, lineages: {} };
    ensureLineage(roster, 'impl', { name: 'impl-g2' });
    writeRoster(dir, roster, 'session-new');
    appendLedger(dir, 'impl', { event: 'checkpoint', name: 'impl-g2', n: 2 }, 'session-new');
    assert.match(readCheckpoint(dir, 'impl', 'session-new').text, /分区交接/);
    assert.match(readProfile(dir, 'impl', 'session-new'), /分区职责/);
    assert.equal(readRoster(dir, 'session-new').lineages.impl.activeGen, 2);
    assert.deepEqual(readLedger(dir, 'impl', 20, 'session-new').map((entry) => entry.n), [2]);
    // 目录/lineage 不存在 → 现状空值
    assert.equal(readCheckpoint(dir, 'nope', 'session-new'), undefined);
    assert.equal(readProfile(dir, 'nope', 'session-new'), undefined);
    assert.deepEqual(readLedger(dir, 'nope', 20, 'session-new'), []);
    assert.equal(readRoster(dir, 'session-new').lineages.nope, undefined);
    assert.match(readFileSync(checkpointPathOf(dir, 'impl'), 'utf8'), /legacy 交接/, 'legacy 记录不被分区写删改');
  } finally { cleanup(dir); }
});

test('archiveCheckpoint：分区 own 归档；跨分区回退 legacy 固化且不搬移/删除', () => {
  const dir = tempWorkspace();
  try {
    writeCheckpoint(dir, 'impl', '# legacy 交接');
    writeCheckpoint(dir, 'impl', '# 分区交接', 'session-a');
    const archived = archiveCheckpoint(dir, 'impl', 1, 'session-a');
    assert.ok(archived !== undefined);
    assert.equal(archived.path, handoffPathOf(dir, 'impl', 1, 'session-a'));
    assert.match(readFileSync(archived.path, 'utf8'), /分区交接/);
    assert.equal(existsSync(checkpointPathOf(dir, 'impl', 'session-a')), false, '分区 latest 已清');
    assert.ok(existsSync(checkpointPathOf(dir, 'impl')), 'legacy latest 保留');
    // 分区无 latest 时回退读 legacy：固化到当前分区 handoffs，但 legacy 文件原样保留（只读回退）
    const legacyFallback = archiveCheckpoint(dir, 'impl', 2, 'session-b');
    assert.ok(legacyFallback !== undefined, '分区无 checkpoint 时回退 legacy 固化');
    assert.equal(legacyFallback.path, handoffPathOf(dir, 'impl', 2, 'session-b'));
    assert.match(readFileSync(legacyFallback.path, 'utf8'), /legacy 交接/);
    assert.ok(existsSync(checkpointPathOf(dir, 'impl')), 'legacy latest 不被删除');
    const legacyArchive = archiveCheckpoint(dir, 'impl', 3);
    assert.ok(legacyArchive !== undefined, '不传 sid 仍归档 legacy（旧行为）');
    assert.equal(existsSync(handoffPathOf(dir, 'impl', 3)), true);
    assert.equal(existsSync(checkpointPathOf(dir, 'impl')), false);
  } finally { cleanup(dir); }
});

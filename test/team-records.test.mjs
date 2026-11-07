/**
 * 记录按 Lead 会话分区（partition）+ legacy 只读回退 + 跨会话 rehydrate 计划/prompt 测试。
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
  buildRehydratePrompt,
  checkpointPathOf,
  ensureLineage,
  handoffPathOf,
  ledgerPathOf,
  lineageDirOf,
  listPartitions,
  partitionRelativePath,
  planRehydrate,
  profilePathOf,
  readCheckpoint,
  readCheckpointFromRoot,
  readLedger,
  readLedgerFromRoot,
  readProfile,
  readProfileFromRoot,
  readRoster,
  readRosterFromRoot,
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

test('read*FromRoot：精确读指定根，无 legacy 回退', () => {
  const dir = tempWorkspace();
  try {
    seedRoster(dir, undefined, { impl: ['impl-g1'] });
    writeText(profilePathOf(dir, 'impl'), '# legacy profile');
    writeCheckpoint(dir, 'impl', '# legacy checkpoint');
    appendLedger(dir, 'impl', { event: 'checkpoint', n: 1 });
    const base = teamBaseOf(dir);
    assert.match(readCheckpointFromRoot(base, 'impl').text, /legacy checkpoint/);
    assert.match(readProfileFromRoot(base, 'impl'), /legacy profile/);
    assert.equal(readRosterFromRoot(base).lineages.impl.activeGen, 1);
    assert.deepEqual(readLedgerFromRoot(base, 'impl', 20).map((entry) => entry.n), [1]);
    const partitionRoot = teamRootOf(dir, 'session-new');
    mkdirSync(partitionRoot, { recursive: true });
    assert.equal(readCheckpointFromRoot(partitionRoot, 'impl'), undefined);
    assert.equal(readProfileFromRoot(partitionRoot, 'impl'), undefined);
    assert.deepEqual(readRosterFromRoot(partitionRoot).lineages, {});
    assert.deepEqual(readLedgerFromRoot(partitionRoot, 'impl'), []);
    writeCheckpoint(dir, 'impl', '# 分区 checkpoint', 'session-new');
    assert.match(readCheckpointFromRoot(partitionRoot, 'impl').text, /分区 checkpoint/);
    writeFileSync(join(partitionRoot, 'roster.json'), '{not json');
    assert.deepEqual(readRosterFromRoot(partitionRoot).lineages, {}, '损坏 roster 容错 = 空');
  } finally { cleanup(dir); }
});

// ── 分区扫描 ───────────────────────────────────────────────────────────

test('listPartitions：分区 + legacy、updatedAt 取最大 mtime、lineages 摘要', () => {
  const dir = tempWorkspace();
  try {
    seedRoster(dir, undefined, { legacy: ['legacy-g1'] });
    writeCheckpoint(dir, 'legacy', '# legacy 交接');
    seedRoster(dir, 'session-a', { impl: ['impl-g1', 'impl-g2'] });
    writeCheckpoint(dir, 'impl', '# a 交接', 'session-a');
    writeText(profilePathOf(dir, 'impl', 'session-a'), '# a 职责');
    writeText(handoffPathOf(dir, 'impl', 1, 'session-a'), '# handoff');
    seedRoster(dir, 'session-b', { review: { role: 'reviewer', description: '审阅' } });
    touchFiles(teamBaseOf(dir), '2026-10-01T00:00:00.000Z');
    touchFiles(teamRootOf(dir, 'session-b'), '2026-10-02T00:00:00.000Z');
    touchFiles(teamRootOf(dir, 'session-a'), '2026-10-03T00:00:00.000Z');
    const parts = listPartitions(dir);
    assert.deepEqual(parts.map((part) => part.id), ['session-a', 'session-b', LEGACY_PARTITION_ID], 'updatedAt 降序，legacy 最旧');
    assert.deepEqual(parts.map((part) => part.kind), ['partition', 'partition', 'legacy']);
    const a = parts[0];
    assert.equal(a.root, teamRootOf(dir, 'session-a'));
    assert.ok(closeTo(a.updatedAt, '2026-10-03T00:00:00.000Z'));
    assert.deepEqual(a.lineages.map((item) => item.lineage), ['impl']);
    assert.deepEqual(a.lineages[0], {
      lineage: 'impl',
      hasCheckpoint: true,
      hasProfile: true,
      checkpointBytes: Buffer.byteLength('# a 交接'),
      activeGen: 2,
      generations: ['impl-g1', 'impl-g2'],
    });
    const b = parts[1];
    assert.ok(closeTo(b.updatedAt, '2026-10-02T00:00:00.000Z'));
    assert.deepEqual(b.lineages, [{ lineage: 'review', hasCheckpoint: false, hasProfile: false, checkpointBytes: 0, activeGen: 0, generations: [] }]);
    const legacy = parts[2];
    assert.equal(legacy.root, teamBaseOf(dir));
    assert.ok(closeTo(legacy.updatedAt, '2026-10-01T00:00:00.000Z'), 'legacy 不看子分区 mtime');
    assert.deepEqual(legacy.lineages.map((item) => item.lineage), ['legacy'], 'legacy 只扫自己的 lineage 目录');
    assert.equal(legacy.lineages[0].hasCheckpoint, true);
  } finally { cleanup(dir); }
});

test('listPartitions：损坏/缺失 roster 容错（跳过或空，不抛）', () => {
  const dir = tempWorkspace();
  try {
    const base = teamBaseOf(dir);
    mkdirSync(join(base, 'session-broken', 'impl'), { recursive: true });
    writeFileSync(join(base, 'session-broken', 'roster.json'), '{oops');
    writeCheckpoint(dir, 'impl', '# 坏分区里的交接', 'session-broken');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'roster.json'), 'not-json');
    mkdirSync(join(base, 'session-norooster', 'impl'), { recursive: true });
    writeFileSync(join(base, 'session-norooster', 'impl', 'checkpoint.md'), '# x');
    mkdirSync(join(base, 'session-empty', 'ghost'), { recursive: true });
    writeFileSync(join(base, 'session-empty', 'roster.json'), JSON.stringify({ version: 1, lineages: {} }));
    writeFileSync(join(base, 'session-empty', 'ghost', 'checkpoint.md'), '   ');
    const parts = listPartitions(dir);
    assert.deepEqual(parts.map((part) => part.id).sort(), [LEGACY_PARTITION_ID, 'session-broken', 'session-empty']);
    const broken = parts.find((part) => part.id === 'session-broken');
    assert.deepEqual(broken.lineages.map((item) => item.lineage), ['impl']);
    assert.equal(broken.lineages[0].hasCheckpoint, true);
    assert.equal(broken.lineages[0].checkpointBytes, Buffer.byteLength('# 坏分区里的交接'));
    assert.equal(broken.lineages[0].activeGen, 0);
    assert.deepEqual(broken.lineages[0].generations, []);
    const legacy = parts.find((part) => part.kind === 'legacy');
    assert.deepEqual(legacy.lineages, [], 'legacy 坏 roster + 无 lineage 目录 → 空');
    const empty = parts.find((part) => part.id === 'session-empty');
    assert.equal(empty.lineages[0].hasCheckpoint, false, '空白 checkpoint 视为无记录');
    const fresh = tempWorkspace();
    try { assert.deepEqual(listPartitions(fresh), []); } finally { cleanup(fresh); }
  } finally { cleanup(dir); }
});

// ── rehydrate 计划 ─────────────────────────────────────────────────────

test('planRehydrate：默认最新非当前分区（含 legacy）、显式 from、非法/不存在 from 结构化拒绝', () => {
  const dir = tempWorkspace();
  try {
    seedRoster(dir, undefined, { legacy: ['legacy-g1'] });
    writeCheckpoint(dir, 'legacy', '# legacy 记录');
    seedRoster(dir, 'session-old', { impl: ['impl-g1'] });
    writeCheckpoint(dir, 'impl', '# old 记录', 'session-old');
    seedRoster(dir, 'session-new', { review: ['review-g1'] });
    writeCheckpoint(dir, 'review', '# new 记录', 'session-new');
    touchFiles(teamBaseOf(dir), '2026-10-01T00:00:00.000Z');
    touchFiles(teamRootOf(dir, 'session-old'), '2026-10-02T00:00:00.000Z');
    touchFiles(teamRootOf(dir, 'session-new'), '2026-10-03T00:00:00.000Z');
    const latest = planRehydrate(dir);
    assert.equal(latest.ok, true);
    assert.equal(latest.from, 'session-new');
    assert.match(latest.updatedAt, /^2026-10-03/);
    assert.deepEqual(latest.lineages.map((item) => item.proposedName), ['review-g1']);
    assert.equal(latest.spawnCount, 1);
    assert.deepEqual(latest.warnings, []);
    assert.equal(latest.defaultFrom, true, '默认取最新分区时标记 defaultFrom');
    assert.equal(planRehydrate(dir, { currentSessionId: 'session-new' }).from, 'session-old');
    const legacyPlan = planRehydrate(dir, { from: LEGACY_PARTITION_ID });
    assert.equal(legacyPlan.ok, true);
    assert.equal(legacyPlan.from, 'legacy');
    assert.equal(legacyPlan.lineages[0].proposedName, 'legacy-g1');
    const explicit = planRehydrate(dir, { from: 'session-old' });
    assert.equal(explicit.from, 'session-old');
    assert.equal(explicit.defaultFrom, false);
    assert.equal(explicit.lineages[0].hasCheckpoint, true);
    const missing = planRehydrate(dir, { from: 'session-nope' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'partition-not-found');
    assert.match(missing.reason, /session-nope/);
    for (const bad of ['../escape', 'a/b', 'a.b', 'has space']) {
      const result = planRehydrate(dir, { from: bad });
      assert.equal(result.ok, false, '非法 from 拒绝: ' + bad);
      assert.equal(result.code, 'partition-not-found');
    }
    const solo = tempWorkspace();
    try {
      seedRoster(solo, 'session-a', { impl: ['impl-g1'] });
      writeCheckpoint(solo, 'impl', '# a 记录', 'session-a');
      const none = planRehydrate(solo, { currentSessionId: 'session-a' });
      assert.equal(none.ok, false, '排除当前会话后无候选');
      assert.equal(none.code, 'partition-not-found');
      assert.equal(none.lineages, undefined);
      assert.equal(planRehydrate(solo).from, 'session-a');
    } finally { cleanup(solo); }
  } finally { cleanup(dir); }
});

test('planRehydrate：proposedName/gen、no-record skip、只有 profile 的 warning、spawnCount', () => {
  const dir = tempWorkspace();
  try {
    const sid = 'session-lead';
    const roster = { version: 1, lineages: {} };
    const impl = ensureLineage(roster, 'impl', { name: 'impl-g1', sessionId: 's-g1' });
    ensureLineage(roster, 'impl', { name: 'impl-g2', sessionId: 's-g2', role: '实现' });
    ensureLineage(roster, 'impl', { name: 'impl-g3', sessionId: 's-g3' });
    retireGeneration(impl, 'impl-g1', 'band');
    retireGeneration(impl, 'impl-g3', 'band');
    ensureLineage(roster, 'review', { role: '审阅' });
    ensureLineage(roster, 'ghost', { role: '无记录' });
    writeRoster(dir, roster, sid);
    writeCheckpoint(dir, 'impl', '# impl 交接', sid);
    writeText(profilePathOf(dir, 'review', sid), '# 审阅职责');
    writeCheckpoint(dir, 'notes', '# notes 交接', sid);
    const plan = planRehydrate(dir);
    assert.equal(plan.ok, true);
    assert.equal(plan.from, sid);
    assert.equal(typeof plan.updatedAt, 'string');
    const byLineage = Object.fromEntries(plan.lineages.map((item) => [item.lineage, item]));
    assert.deepEqual(Object.keys(byLineage).sort(), ['ghost', 'impl', 'notes', 'review']);
    assert.equal(byLineage.impl.proposedName, 'impl-g2', '最近 active 代际（g3 已退休）');
    assert.equal(byLineage.impl.gen, 2);
    assert.equal(byLineage.impl.profileRole, '实现');
    assert.equal(byLineage.impl.hasCheckpoint, true);
    assert.equal(byLineage.impl.action, 'spawn');
    assert.equal(byLineage.review.proposedName, 'review', '无 roster 代际名 → lineage 本身');
    assert.equal(byLineage.review.gen, 1);
    assert.equal(byLineage.review.hasCheckpoint, false);
    assert.equal(byLineage.review.hasProfile, true);
    assert.equal(byLineage.review.action, 'spawn');
    assert.equal(byLineage.ghost.action, 'skip');
    assert.equal(byLineage.ghost.reason, 'no-record');
    assert.equal(byLineage.ghost.hasProfile, false);
    assert.equal(byLineage.notes.proposedName, 'notes', '无 roster 用 lineage 本身');
    assert.equal(byLineage.notes.gen, 1);
    assert.equal(byLineage.notes.profileRole, '');
    assert.equal(byLineage.notes.action, 'spawn');
    assert.equal(plan.spawnCount, 3);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /review/);
    assert.match(plan.warnings[0], /checkpoint/);
  } finally { cleanup(dir); }
});

// ── rehydrate prompt ───────────────────────────────────────────────────

test('buildRehydratePrompt：含 profile/checkpoint/fromSessionId/记录目录/核验与边界；超 maxBytes 截断', () => {
  const prompt = buildRehydratePrompt({
    lineage: 'impl',
    name: 'impl-g2',
    gen: 2,
    profile: '# 职责\n实现登录',
    checkpoint: '## 一行结论\n完成 A',
    ledger: [{ gen: 1, name: 'impl-g1', sessionId: 'session-w1' }],
    fromSessionId: 'session-old',
  });
  assert.match(prompt, /^# 你是队友 impl-g2（impl 第 2 代）/);
  assert.match(prompt, /实现登录/);
  assert.match(prompt, /完成 A/);
  assert.ok(prompt.includes('session-old'), '带旧会话 sessionId');
  assert.ok(prompt.includes('.scratch/context-relay/team/session-old/impl/'), '记录目录含 from 分区');
  assert.ok(prompt.includes('session_event_read({ session_id: session-old, seq })'), '旧会话召回指针');
  assert.match(prompt, /快照.*权威.*>.*指针.*>.*旧会话/);
  assert.match(prompt, /核验 1 个可判定事实/);
  assert.match(prompt, /不自行换代/);
  assert.match(prompt, /记录，不是上一个 Lead 会话的对话或身份/);
  assert.match(prompt, /gen=1 · name=impl-g1/);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= TEAM_LIMITS.promptBytes);
  const legacyPrompt = buildRehydratePrompt({ lineage: 'impl', name: 'impl-g1', gen: 1, fromSessionId: LEGACY_PARTITION_ID });
  assert.ok(legacyPrompt.includes('.scratch/context-relay/team/impl/'), 'legacy from → legacy 路径');
  assert.ok(!legacyPrompt.includes('team/legacy/'), 'legacy 不拼出伪分区目录');
  const huge = buildRehydratePrompt({
    lineage: 'impl',
    name: 'impl-g2',
    gen: 2,
    profile: '职责'.repeat(1000),
    checkpoint: '证'.repeat(3000),
    fromSessionId: 'session-old',
  });
  assert.ok(Buffer.byteLength(huge, 'utf8') <= TEAM_LIMITS.promptBytes, '默认 ≤ promptBytes');
  assert.ok(huge.includes('[rehydrate prompt truncated: ' + TEAM_LIMITS.promptBytes + ' bytes cap]'), '超限有截断标记');
  const small = buildRehydratePrompt({ lineage: 'impl', name: 'impl-g2', gen: 2, profile: 'x'.repeat(2000), checkpoint: 'y'.repeat(2000), fromSessionId: 's', maxBytes: 1000 });
  assert.ok(Buffer.byteLength(small, 'utf8') <= 1000);
  assert.ok(small.includes('truncated: 1000 bytes cap'));
});

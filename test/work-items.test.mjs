import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WORK_ITEMS_RELATIVE,
  WORK_ITEMS_DEFAULT_MAX,
  WORK_ITEM_LIMITS,
  WORK_ITEM_STATUSES,
  archivePathOf,
  appendArchive,
  readArchive,
  normalizeWorkItemsConfig,
  workItemsPathOf,
  readWorkItems,
  copyWorkItemsToScope,
  workItemsRelativePath,
  workItemsScopeOf,
  validateWorkItems,
  writeWorkItems,
  countsOf,
  pendingFirst,
  ledgerLine,
  ledgerAgeMinutes,
  ledgerAgeSuffix,
  formatWorkItemLines,
  ledgerNextActions,
  ledgerBriefSection,
  ledgerHandoffSection,
  ledgerEntryLine,
  checkShipGate,
  checkPhaseGate,
  applyPhaseCarry,
  createPhaseItems,
  phaseItemsOf,
  phaseSummary,
  phaseFocusLine,
  phaseLine,
} from '../lib/agent/work-items.js';

const tempCwd = () => mkdtempSync(join(tmpdir(), 'relay-work-items-'));
/** v0.10.x 完成确认门：新变 done 的条目必须带三项均 true 的 lead_confirm。 */
const LEAD_CONFIRM = { no_drift: true, no_missing: true, no_regression: true };
const ledgerPath = (cwd) => join(cwd, '.scratch', 'context-relay', 'work-items.json');
const seed = async (cwd, items, options = {}) => {
  const result = await writeWorkItems(cwd, { items, ...options });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const readSeed = (cwd) => readWorkItems(cwd);

// ---- config / path ----

test('normalizeWorkItemsConfig：默认 enabled/strict/warn/30，非法 gate 与 max 归一', async () => {
  assert.deepEqual(normalizeWorkItemsConfig(), { enabled: true, gate: 'strict', phaseGate: 'warn', pathOverride: undefined, max: 30 });
  assert.deepEqual(normalizeWorkItemsConfig({ workItems: false }), { enabled: false, gate: 'strict', phaseGate: 'warn', pathOverride: undefined, max: 30 });
  assert.equal(normalizeWorkItemsConfig({ workItemsPhaseGate: 'warn' }).phaseGate, 'warn');
  assert.equal(normalizeWorkItemsConfig({ workItemsPhaseGate: 'off' }).phaseGate, 'off');
  assert.equal(normalizeWorkItemsConfig({ workItemsPhaseGate: 'nonsense' }).phaseGate, 'warn');
  assert.equal(normalizeWorkItemsConfig({ workItemsGate: 'warn' }).gate, 'warn');
  assert.equal(normalizeWorkItemsConfig({ workItemsGate: 'off' }).gate, 'off');
  assert.equal(normalizeWorkItemsConfig({ workItemsGate: 'STRICT' }).gate, 'strict');
  assert.equal(normalizeWorkItemsConfig({ workItemsGate: 'nonsense' }).gate, 'strict');
  assert.equal(normalizeWorkItemsConfig({ workItemsMax: 0 }).max, 1);
  assert.equal(normalizeWorkItemsConfig({ workItemsMax: 1000 }).max, 100);
  assert.equal(normalizeWorkItemsConfig({ workItemsMax: '7' }).max, 7);
  assert.equal(normalizeWorkItemsConfig({ workItemsMax: 'x' }).max, WORK_ITEMS_DEFAULT_MAX);
  assert.equal(normalizeWorkItemsConfig({ workItemsPath: ' custom/items.json ' }).pathOverride, ' custom/items.json ');
  assert.equal(normalizeWorkItemsConfig({ workItemsPath: '   ' }).pathOverride, undefined);
  assert.equal(normalizeWorkItemsConfig({ workItemsPath: 42 }).pathOverride, undefined);
});

test('workItemsPathOf：默认绝对路径；相对 override 按 cwd 解析；绝对 override 原样', async () => {
  const cwd = '/tmp/example-cwd';
  assert.equal(workItemsPathOf(cwd), cwd + '/' + WORK_ITEMS_RELATIVE);
  assert.equal(workItemsPathOf(cwd, 'custom/items.json'), cwd + '/custom/items.json');
  assert.equal(workItemsPathOf(cwd, '/abs/items.json'), '/abs/items.json');
});

// ---- read / write ----

test('readWorkItems：文件不存在 → exists:false、空台账、ok:true、永不抛', async () => {
  const cwd = tempCwd();
  const read = readWorkItems(cwd);
  assert.equal(read.ok, true);
  assert.equal(read.exists, false);
  assert.equal(read.path, ledgerPath(cwd));
  assert.equal(read.relativePath, WORK_ITEMS_RELATIVE);
  assert.equal(read.rev, 0);
  assert.equal(read.updatedAt, null);
  assert.equal(read.updatedBy, null);
  assert.deepEqual(read.items, []);
  assert.deepEqual(read.counts, { total: 0, open: 0, doing: 0, blocked: 0, done: 0, pending: 0 });
  assert.equal(read.corruptBackup, undefined);
});

test('writeWorkItems/readWorkItems：合法写入并读回（归一化字段 + rev/updatedBy/version）', async () => {
  const cwd = tempCwd();
  const written = await seed(cwd, [
    { id: 'schema', title: '定 schema', status: 'done', evidence: ['lib/a.js:1'], lead_confirm: LEAD_CONFIRM },
    { id: 'api-export', title: '导出 API', status: 'doing', owner: 'worker-1', next: '写完 handler', acceptance: '单测全绿', depends: ['schema'], phase: 'build' },
    { id: 'blocked-x', title: '阻塞项', status: 'blocked', blocked: '等接口' },
  ], { updatedBy: 'session-1' });
  assert.equal(written.ok, true);
  assert.equal(written.ledger.rev, 1);
  assert.equal(written.ledger.updatedBy, 'session-1');
  assert.equal(written.ledger.items.length, 3);
  assert.equal(written.relativePath, WORK_ITEMS_RELATIVE);
  assert.deepEqual(written.counts, { total: 3, open: 0, doing: 1, blocked: 1, done: 1, pending: 2 });

  const read = readSeed(cwd);
  assert.equal(read.exists, true);
  assert.equal(read.rev, 1);
  assert.equal(read.updatedBy, 'session-1');
  assert.match(read.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const byId = new Map(read.items.map((item) => [item.id, item]));
  assert.equal(byId.get('api-export').owner, 'worker-1');
  assert.equal(byId.get('api-export').next, '写完 handler');
  assert.equal(byId.get('api-export').acceptance, '单测全绿');
  assert.deepEqual(byId.get('api-export').depends, ['schema']);
  assert.equal(byId.get('api-export').phase, 'build');
  assert.deepEqual(byId.get('schema').evidence, ['lib/a.js:1']);
  assert.equal(byId.get('blocked-x').blocked, '等接口');

  const raw = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.rev, 1);
  assert.equal(raw.items.length, 3);
});

test('writeWorkItems：rev 递增；内容不变保留 updatedAt、内容变化/新条目用 now', async () => {
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const stored = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8'));
  stored.items[0].updatedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(ledgerPath(cwd), JSON.stringify(stored), 'utf8');

  const first = readSeed(cwd);
  assert.equal(first.items[0].updatedAt, '2020-01-01T00:00:00.000Z');
  const same = await writeWorkItems(cwd, { items: first.items, rev: first.rev });
  assert.equal(same.ok, true);
  assert.equal(same.ledger.rev, first.rev + 1);
  assert.equal(same.ledger.items[0].updatedAt, '2020-01-01T00:00:00.000Z');

  const changed = await writeWorkItems(cwd, { items: [{ ...first.items[0], title: 'A2' }], rev: same.ledger.rev });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.ledger.items[0].updatedAt, '2020-01-01T00:00:00.000Z');
  assert.ok(Date.parse(changed.ledger.items[0].updatedAt) > Date.parse('2020-01-01T00:00:00.000Z'));

  const added = await writeWorkItems(cwd, { items: [...changed.ledger.items, { id: 'bb', title: 'B', status: 'open', next: 'x' }], rev: changed.ledger.rev });
  assert.equal(added.ok, true);
  const addedItem = added.ledger.items.find((item) => item.id === 'bb');
  assert.ok(Date.parse(addedItem.updatedAt) > Date.parse('2020-01-01T00:00:00.000Z'));
  assert.equal(added.ledger.rev, 4);
});

test('writeWorkItems：写空表（全部关闭）落盘成功且 counts 归零', async () => {
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const read = readSeed(cwd);
  const cleared = await writeWorkItems(cwd, { items: [], rev: read.rev });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.counts, { total: 0, open: 0, doing: 0, blocked: 0, done: 0, pending: 0 });
  assert.equal(cleared.ledger.rev, read.rev + 1);
  const after = readSeed(cwd);
  assert.equal(after.exists, true);
  assert.deepEqual(after.items, []);
});

test('writeWorkItems：rev 冲突 → stale-revision（附 currentRev/counts，且不覆盖文件）', async () => {
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const before = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8'));
  const stale = await writeWorkItems(cwd, { items: [{ id: 'bb', title: 'B', status: 'open', next: 'x' }], rev: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  assert.equal(stale.currentRev, 1);
  assert.equal(stale.counts.total, 1);
  assert.match(stale.message, /revision mismatch/);
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(cwd), 'utf8')), before);
  // 无 rev 的整表替换允许（旧会话兼容）。
  const noRev = await writeWorkItems(cwd, { items: [{ id: 'bb', title: 'B', status: 'open', next: 'x' }] });
  assert.equal(noRev.ok, true);
  assert.equal(noRev.ledger.rev, 2);
});

test('writeWorkItems：原子写不留 tmp 文件', async () => {
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const names = readdirSync(dirname(ledgerPath(cwd)));
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
  assert.ok(names.includes('work-items.json'));
});

test('writeWorkItems：写盘失败 → write-failed（不半写、不抛）', async () => {
  const cwd = tempCwd();
  const blocker = join(cwd, 'blocker');
  writeFileSync(blocker, 'not-a-directory', 'utf8');
  const result = await writeWorkItems(cwd, { items: [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }], pathOverride: join(blocker, 'nested', 'work-items.json') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'write-failed');
  assert.match(result.message, /failed to write work ledger/);
  assert.equal(existsSync(join(blocker, 'nested', 'work-items.json')), false);
});

test('readWorkItems：损坏 JSON → 隔离 .corrupt-<ts>、返回 corruptBackup、视为空台账', async () => {
  const cwd = tempCwd();
  mkdirSync(dirname(ledgerPath(cwd)), { recursive: true });
  writeFileSync(ledgerPath(cwd), '{not json', 'utf8');
  const read = readWorkItems(cwd);
  assert.equal(read.ok, true);
  assert.equal(read.exists, false);
  assert.deepEqual(read.items, []);
  assert.ok(read.corruptBackup.startsWith(ledgerPath(cwd) + '.corrupt-'));
  assert.equal(readFileSync(read.corruptBackup, 'utf8'), '{not json');
  assert.equal(existsSync(ledgerPath(cwd)), false);
  assert.equal(readdirSync(dirname(ledgerPath(cwd))).filter((name) => name.includes('.corrupt-')).length, 1);
  // 隔离后写盘从 rev 0 开始，不因损坏卡死。
  const written = await seed(cwd, [{ id: 'aa', title: 'A', status: 'open', next: 'go' }]);
  assert.equal(written.ledger.rev, 1);
});

test('readWorkItems：结构损坏（items 非数组）同样隔离并空台账', async () => {
  const cwd = tempCwd();
  mkdirSync(dirname(ledgerPath(cwd)), { recursive: true });
  writeFileSync(ledgerPath(cwd), JSON.stringify({ version: 1, rev: 3, items: { a: 1 } }), 'utf8');
  const read = readWorkItems(cwd);
  assert.equal(read.exists, false);
  assert.equal(read.rev, 0);
  assert.ok(read.corruptBackup);
});

// ---- validate ----

test('validateWorkItems：doing 缺 next、blocked 缺原因报错（open 允许空 next）', async () => {
  // v0.6.0：open = 未领取，允许 next 为空（phase 分点开张时由宿主创建）。
  assert.equal(validateWorkItems([{ id: 'aa', title: 'A', status: 'open' }]).ok, true);
  const missingNext = validateWorkItems([
    { id: 'bb', title: 'B', status: 'doing' },
  ]);
  assert.equal(missingNext.ok, false);
  assert.equal(missingNext.code, 'invalid-item');
  assert.equal(missingNext.errors.length, 1);
  assert.deepEqual(missingNext.errors.map((error) => error.code), ['missing-next']);
  assert.deepEqual(missingNext.errors.map((error) => error.index), [0]);

  const missingBlocked = validateWorkItems([{ id: 'aa', title: 'A', status: 'blocked' }]);
  assert.equal(missingBlocked.ok, false);
  assert.equal(missingBlocked.errors[0].code, 'missing-blocked');
  assert.match(missingBlocked.message, /invalid work items/);
});

test('validateWorkItems：重复 id → duplicate-id；非法 id → invalid-item/invalid-id', async () => {
  const duplicate = validateWorkItems([
    { id: 'aa', title: 'A', status: 'done' },
    { id: 'aa', title: 'B', status: 'done' },
  ]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate-id');
  assert.equal(duplicate.errors[0].code, 'duplicate-id');

  for (const badId of ['A', 'x', '-lead', 'has space', 'a'.repeat(WORK_ITEM_LIMITS.idMax + 1)]) {
    const result = validateWorkItems([{ id: badId, title: 'T', status: 'done' }]);
    assert.equal(result.ok, false, 'id 应被拒绝: ' + badId);
    assert.equal(result.code, 'invalid-item');
    assert.equal(result.errors[0].code, 'invalid-id');
  }
  assert.equal(validateWorkItems([{ id: 'a1', title: 'T', status: 'done' }]).ok, true);
});

test('validateWorkItems/writeWorkItems：超过 max 时先归档最旧 done 到 -archive.ndjson；done 不足才 ledger-full', async () => {
  const items = [0, 1, 2].map((index) => ({ id: 'item-' + index, title: 'T' + index, status: 'done', evidence: ['e:1'], lead_confirm: LEAD_CONFIRM, updatedAt: '2026-01-0' + (index + 1) + 'T00:00:00.000Z' }));
  // 纯校验仍报 ledger-full（超限归档在 writeWorkItems；validate 只给口径）。
  const tooMany = validateWorkItems(items, { max: 2 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'ledger-full');
  assert.match(tooMany.message, /at most 2/);
  assert.equal(validateWorkItems(items, { max: 3 }).ok, true);
  // 写入：3 条 done → 自动归档最旧 1 条（item-0），接受写入。
  const cwd = tempCwd();
  const write = await writeWorkItems(cwd, { items, max: 2, updatedBy: 'session-1' });
  assert.equal(write.ok, true, JSON.stringify(write));
  assert.deepEqual(write.archived, { count: 1, path: '.scratch/context-relay/work-items-archive.ndjson' });
  assert.deepEqual(write.ledger.items.map((item) => item.id), ['item-1', 'item-2']);
  const archiveLines = readFileSync(join(cwd, '.scratch/context-relay/work-items-archive.ndjson'), 'utf8').trim().split('\n');
  assert.equal(archiveLines.length, 1);
  const record = JSON.parse(archiveLines[0]);
  assert.equal(record.reason, 'over-cap');
  assert.equal(record.sessionId, 'session-1');
  assert.equal(record.rev, 0);
  assert.equal(record.item.id, 'item-0');
  assert.match(record.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readWorkItems(cwd).items.length, 2);
  // done 不足（4 条 > max 2，仅 1 条 done）：拒绝整次写入，台账不变。
  const mixed = [
    { id: 'done-x', title: 'D', status: 'done', evidence: ['e:1'], lead_confirm: LEAD_CONFIRM },
    { id: 'open-a', title: 'O', status: 'open' },
    { id: 'open-b', title: 'O', status: 'open' },
    { id: 'open-c', title: 'O', status: 'open' },
  ];
  const refusedCwd = tempCwd();
  const refused = await writeWorkItems(refusedCwd, { items: mixed, max: 2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ledger-full');
  assert.match(refused.message, /done/);
  assert.equal(readWorkItems(refusedCwd).exists, false, '拒绝路径不写台账');
});

test('validateWorkItems：depends 不存在 / 自引用 / 环 → invalid-item + 对应 per-error code', async () => {
  const missing = validateWorkItems([{ id: 'aa', title: 'A', status: 'done', depends: ['ghost'] }]);
  assert.equal(missing.code, 'invalid-item');
  assert.equal(missing.errors[0].code, 'depends-missing');

  const self = validateWorkItems([{ id: 'aa', title: 'A', status: 'done', depends: ['aa'] }]);
  assert.equal(self.ok, false);
  assert.equal(self.errors[0].code, 'depends-self');

  const cycle = validateWorkItems([
    { id: 'aa', title: 'A', status: 'done', depends: ['bb'] },
    { id: 'bb', title: 'B', status: 'done', depends: ['aa'] },
  ]);
  assert.equal(cycle.ok, false);
  assert.equal(cycle.code, 'invalid-item');
  assert.ok(cycle.errors.some((error) => error.code === 'depends-cycle'));

  const valid = validateWorkItems([
    { id: 'aa', title: 'A', status: 'done' },
    { id: 'bb', title: 'B', status: 'done', depends: ['aa'] },
  ]);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.items[1].depends, ['aa']);
});

test('validateWorkItems：合法条目归一（trim、未知字段丢弃、非 blocked 清空 blocked、缺省可选字段为 null/[]）', async () => {
  const result = validateWorkItems([{
    id: 'api-export',
    title: '  导出 API  ',
    status: 'done',
    owner: '  worker-1  ',
    next: '  收尾  ',
    blocked: '不应保留',
    evidence: ['  lib/a.js:1  '],
    acceptance: '  单测全绿  ',
    depends: [],
    phase: 'build',
    officialTaskId: '  task-abc  ',
    hidden: 'dropped',
  }]);
  assert.equal(result.ok, true);
  const item = result.items[0];
  assert.equal(item.title, '导出 API');
  assert.equal(item.owner, 'worker-1');
  assert.equal(item.next, '收尾');
  assert.equal(item.blocked, null);
  assert.deepEqual(item.evidence, ['lib/a.js:1']);
  assert.equal(item.acceptance, '单测全绿');
  assert.equal(item.phase, 'build');
  assert.equal(item.officialTaskId, 'task-abc', 'officialTaskId trim 后保留');
  assert.equal(item.hidden, undefined);
  assert.equal(item.updatedAt, null);

  const minimal = validateWorkItems([{ id: 'aa', title: 'A', status: 'done' }]).items[0];
  assert.equal(minimal.owner, null);
  assert.equal(minimal.next, null);
  assert.equal(minimal.blocked, null);
  assert.deepEqual(minimal.evidence, []);
  assert.deepEqual(minimal.depends, []);
  assert.equal(minimal.acceptance, null);
  assert.equal(minimal.phase, null);
  assert.equal(minimal.officialTaskId, null);

  assert.equal(validateWorkItems('nope').ok, false);
  assert.equal(validateWorkItems([]).ok, true);
  assert.deepEqual(WORK_ITEM_STATUSES, ['open', 'doing', 'blocked', 'done']);
});

test('officialTaskId（v0.9.0 #35）：可选引用、trim/长度/宽松字符集校验、contentKey 影响 updatedAt', async () => {
  for (const ok of ['task-123', 'Task_9.x:y', 'a', 'A'.repeat(64), '0f8fad5b-d9cb-469f-a165-70867728950e']) {
    const result = validateWorkItems([{ id: 'aa', title: 'A', status: 'open', officialTaskId: ok }]);
    assert.equal(result.ok, true, '合法 officialTaskId 接受: ' + ok);
    assert.equal(result.items[0].officialTaskId, ok);
  }
  // 非字符串 / 超长 / 非法字符 / 前导符号 → invalid-official-task-id（只校验形态，不校验官方存在性）。
  for (const bad of [42, true, {}, [], 'has space', '-leading', 'a'.repeat(65), 'task/abc']) {
    const result = validateWorkItems([{ id: 'aa', title: 'A', status: 'open', officialTaskId: bad }]);
    assert.equal(result.ok, false, '非法 officialTaskId 拒绝: ' + String(bad));
    assert.equal(result.errors[0].code, 'invalid-official-task-id');
  }
  assert.equal(validateWorkItems([{ id: 'aa', title: 'A', status: 'open', officialTaskId: '' }]).items[0].officialTaskId, null, '空串=不提供');
  assert.equal(validateWorkItems([{ id: 'aa', title: 'A', status: 'open', officialTaskId: '  task-1  ' }]).items[0].officialTaskId, 'task-1');
  // 写入/读回保留；contentKey 纳入 officialTaskId（变更才刷新 updatedAt）。
  const cwd = tempCwd();
  const first = await seed(cwd, [{ id: 'aa', title: 'A', status: 'open', officialTaskId: 'task-1' }]);
  assert.equal(first.ledger.items[0].officialTaskId, 'task-1');
  const stored = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8'));
  stored.items[0].updatedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(ledgerPath(cwd), JSON.stringify(stored), 'utf8');
  const unchanged = await writeWorkItems(cwd, { items: readSeed(cwd).items, rev: first.ledger.rev });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.ledger.items[0].updatedAt, '2020-01-01T00:00:00.000Z', '内容未变保留 updatedAt');
  assert.equal(unchanged.ledger.items[0].officialTaskId, 'task-1');
  const changed = await writeWorkItems(cwd, { items: [{ ...unchanged.ledger.items[0], officialTaskId: 'task-2' }], rev: unchanged.ledger.rev });
  assert.equal(changed.ledger.items[0].officialTaskId, 'task-2');
  assert.notEqual(changed.ledger.items[0].updatedAt, '2020-01-01T00:00:00.000Z', 'officialTaskId 变化刷新 updatedAt');
  // 行渲染：行尾 · official=<id>；无值不渲染。
  const lines = formatWorkItemLines([{ id: 'aa', title: 'A', status: 'done', evidence: ['e:1'], officialTaskId: 'task-1' }], { includeDone: true });
  assert.match(lines[0], / done · official=task-1$/);
  assert.doesNotMatch(formatWorkItemLines([{ id: 'bb', title: 'B', status: 'open' }])[0], /official=/);
});

test('archive（v0.9.0 #39）：最旧 done 优先、readArchive 计数/坏行跳过、appendArchive 失败不抛且台账不变', async () => {
  const cwd = tempCwd();
  const items = [
    { id: 'done-new', title: 'D2', status: 'done', evidence: ['e:1'], lead_confirm: LEAD_CONFIRM, updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'open-a', title: 'O', status: 'open', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'done-old', title: 'D1', status: 'done', evidence: ['e:1'], lead_confirm: LEAD_CONFIRM, updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const written = await writeWorkItems(cwd, { items, max: 2 });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(written.ledger.items.map((item) => item.id), ['done-new', 'open-a']);
  assert.equal(written.archived.count, 1);
  assert.equal(archivePathOf(cwd), join(cwd, '.scratch/context-relay/work-items-archive.ndjson'));
  const info = readArchive(cwd);
  assert.equal(info.ok, true);
  assert.equal(info.count, 1);
  assert.equal(info.relativePath, '.scratch/context-relay/work-items-archive.ndjson');
  // 坏行跳过（fail-open）不阻断。
  writeFileSync(archivePathOf(cwd), readFileSync(archivePathOf(cwd), 'utf8') + 'not-json\n', 'utf8');
  assert.equal(readArchive(cwd).count, 1);
  assert.equal(readArchive(tempCwd()).count, 0, '不存在 → count 0');
  // 归档目标被目录占用 → appendArchive ok:false（不抛）。
  const blockedCwd = tempCwd();
  mkdirSync(archivePathOf(blockedCwd), { recursive: true });
  const failed = await appendArchive(blockedCwd, { entries: [{ item: { id: 'aa', title: 'A', status: 'done' }, reason: 'removed-done' }], rev: 1, sessionId: 's' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'archive-failed');
  // writeWorkItems 归档失败 → archive-failed 且台账不变。
  const safe = tempCwd();
  const seeded = await writeWorkItems(safe, { items: [{ id: 'keep', title: 'K', status: 'open' }] });
  assert.equal(seeded.ok, true);
  mkdirSync(archivePathOf(safe), { recursive: true });
  const refused = await writeWorkItems(safe, {
    items: [...seeded.ledger.items, { id: 'done-a', title: 'D', status: 'done', evidence: ['e:1'], lead_confirm: LEAD_CONFIRM }, { id: 'done-b', title: 'D2', status: 'done', evidence: ['e:2'], lead_confirm: LEAD_CONFIRM }],
    max: 2,
    rev: seeded.ledger.rev,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'archive-failed');
  assert.deepEqual(readWorkItems(safe).items.map((item) => item.id), ['keep'], '归档失败台账不变');
});

test('完成确认门（writeWorkItems）：新变 done 缺/不完整/含 false 的 lead_confirm → done-gate 整表拒绝（零副作用）；三项 true 才落账；已 done 不受影响', async () => {
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'doing-a', title: '进行中', status: 'doing', next: 'x' }]);
  const rev = readWorkItems(cwd).rev;
  const doneItem = (lead_confirm) => [{ id: 'doing-a', title: '进行中', status: 'done', evidence: ['e:1'], ...(lead_confirm === undefined ? {} : { lead_confirm }) }];
  // ① 缺失 lead_confirm
  const missing = await writeWorkItems(cwd, { items: doneItem(undefined), rev });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'done-gate');
  assert.deepEqual(missing.ids, ['doing-a']);
  assert.match(missing.message, /no_drift/);
  assert.match(missing.message, /diff/);
  // ② 不完整（缺 no_regression）
  const partial = await writeWorkItems(cwd, { items: doneItem({ no_drift: true, no_missing: true }), rev });
  assert.equal(partial.code, 'done-gate');
  // ③ 任一项非 true
  const falseFlag = await writeWorkItems(cwd, { items: doneItem({ no_drift: true, no_missing: true, no_regression: false }), rev });
  assert.equal(falseFlag.code, 'done-gate');
  assert.equal(readWorkItems(cwd).rev, rev, '三次拒绝零副作用（rev 不变）');
  assert.equal(readWorkItems(cwd).items[0].status, 'doing', '条目不置 done');
  // ④ 三项均 true → 通过并落账 lead_confirm
  const passed = await writeWorkItems(cwd, { items: doneItem(LEAD_CONFIRM), rev });
  assert.equal(passed.ok, true, JSON.stringify(passed));
  const done = readWorkItems(cwd).items[0];
  assert.equal(done.status, 'done');
  assert.deepEqual(done.lead_confirm, LEAD_CONFIRM);
  // ⑤ 已 done 条目不受影响：整表重写不带 lead_confirm 仍通过，且保留盘上确认
  const rewrite = await writeWorkItems(cwd, { items: [{ id: 'doing-a', title: '进行中（改名）', status: 'done', evidence: ['e:2'] }], rev: passed.ledger.rev });
  assert.equal(rewrite.ok, true, JSON.stringify(rewrite));
  assert.deepEqual(readWorkItems(cwd).items[0].lead_confirm, LEAD_CONFIRM, '已 done 条目保留既有确认');
});

test('完成确认门：门先于超限预归档（新 done 不能以归档绕过）；拒绝时归档文件不变；已 done 显式不完整/含 false 不得覆盖', async () => {
  // ① 超限归档 × 门：无确认的新 done 本会被选作「最旧 done」预归档 → 必须在归档前拒绝
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'keep', title: 'K', status: 'open' }]);
  writeFileSync(archivePathOf(cwd), 'SENTINEL-ARCHIVE\n', 'utf8');
  const revBefore = readWorkItems(cwd).rev;
  const overCap = await writeWorkItems(cwd, {
    items: [
      { id: 'fresh-done', title: '未确认', status: 'done', evidence: ['e:1'], updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'open-a', title: 'O', status: 'open' },
      { id: 'open-b', title: 'O', status: 'open' },
    ],
    max: 2,
    rev: revBefore,
  });
  assert.equal(overCap.ok, false);
  assert.equal(overCap.code, 'done-gate');
  assert.deepEqual(overCap.ids, ['fresh-done']);
  assert.equal(readFileSync(archivePathOf(cwd), 'utf8'), 'SENTINEL-ARCHIVE\n', '拒绝时归档文件不变（不得先归档无确认 done）');
  assert.equal(readWorkItems(cwd).rev, revBefore, '拒绝不写台账');
  // ② 已 done 条目：显式 false / 不完整 → 拒绝且不覆盖盘上完整确认
  const cwd2 = tempCwd();
  await seed(cwd2, [{ id: 'closed', title: '已收尾', status: 'done', evidence: ['e:1'], lead_confirm: LEAD_CONFIRM }]);
  const rev2 = readWorkItems(cwd2).rev;
  for (const bad of [
    { no_drift: true, no_missing: true, no_regression: false },
    { no_drift: true, no_missing: true },
  ]) {
    const refused = await writeWorkItems(cwd2, { items: [{ id: 'closed', title: '已收尾', status: 'done', evidence: ['e:1'], lead_confirm: bad }], rev: rev2 });
    assert.equal(refused.ok, false, JSON.stringify(bad));
    assert.equal(refused.code, 'done-gate');
    assert.deepEqual(readWorkItems(cwd2).items[0].lead_confirm, LEAD_CONFIRM, '拒绝不得降级/覆盖既有确认');
  }
  // ③ 已 done 条目未显式提供确认 → 允许整表重写并保留盘上既有确认
  const rewrite = await writeWorkItems(cwd2, { items: [{ id: 'closed', title: '已收尾（改名）', status: 'done', evidence: ['e:2'] }], rev: rev2 });
  assert.equal(rewrite.ok, true, JSON.stringify(rewrite));
  assert.deepEqual(readWorkItems(cwd2).items[0].lead_confirm, LEAD_CONFIRM);
});

test('P3-4 归档顺序：validate 失败先于 append——不留孤儿归档、台账不变', async () => {
  const cwd = tempCwd();
  const seeded = await writeWorkItems(cwd, { items: [{ id: 'keep', title: 'K', status: 'open' }], max: 2 });
  assert.equal(seeded.ok, true);
  // 超限计划本可归档 done-a（最旧 done），但剩余条目重复 id → validate 拒绝：不得先 append。
  const refused = await writeWorkItems(cwd, {
    items: [
      { id: 'done-a', title: 'D', status: 'done', evidence: ['e:1'], updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'dup', title: 'A', status: 'open', updatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'dup', title: 'B', status: 'open', updatedAt: '2026-03-01T00:00:00.000Z' },
    ],
    max: 2,
    rev: seeded.ledger.rev,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'duplicate-id');
  assert.equal(readArchive(cwd).count, 0, 'validate 失败不得新增归档');
  assert.equal(existsSync(archivePathOf(cwd)), false, '不产生孤儿归档文件');
  assert.deepEqual(readWorkItems(cwd).items.map((item) => item.id), ['keep'], '台账不变');
});

// ---- counts / ordering ----

test('countsOf/pendingFirst：pending=未 done；排序 blocked→doing→open、组内 updatedAt 倒序、done 不出现', async () => {
  const items = [
    { id: 'open-old', title: 'O1', status: 'open', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'doing-new', title: 'D', status: 'doing', updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'blocked-none', title: 'B0', status: 'blocked', updatedAt: null },
    { id: 'done-x', title: 'X', status: 'done', updatedAt: '2026-04-01T00:00:00.000Z' },
    { id: 'blocked-new', title: 'B1', status: 'blocked', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'open-new', title: 'O2', status: 'open', updatedAt: '2026-05-01T00:00:00.000Z' },
  ];
  assert.deepEqual(countsOf(items), { total: 6, open: 2, doing: 1, blocked: 2, done: 1, pending: 5 });
  assert.deepEqual(pendingFirst(items).map((item) => item.id), ['blocked-new', 'blocked-none', 'doing-new', 'open-new', 'open-old']);
  assert.deepEqual(pendingFirst({ items }).map((item) => item.id), ['blocked-new', 'blocked-none', 'doing-new', 'open-new', 'open-old']);
});

// ---- rendering ----

test('ledgerLine：固定格式（counts / ledger 两种入参）', async () => {
  const counts = { total: 4, open: 1, doing: 1, blocked: 1, done: 1, pending: 3 };
  assert.equal(ledgerLine(counts), 'work-items: 未闭合 3 / 共 4 (doing 1 · blocked 1 · open 1 · done 1) · rev 0');
  assert.equal(ledgerLine({ ...counts, rev: 7 }), 'work-items: 未闭合 3 / 共 4 (doing 1 · blocked 1 · open 1 · done 1) · rev 7');
  assert.equal(ledgerLine({ rev: 5, items: [] }), 'work-items: 未闭合 0 / 共 0 (doing 0 · blocked 0 · open 0 · done 0) · rev 5');
  // readWorkItems().counts 携带不可枚举 rev（序列化形状不变），ledgerLine(counts) 也能显示真实 rev。
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'aa', title: 'A', status: 'open', next: 'go' }]);
  const read = readSeed(cwd);
  assert.deepEqual(read.counts, { total: 1, open: 1, doing: 0, blocked: 0, done: 0, pending: 1 });
  assert.equal(JSON.stringify(read.counts), '{"total":1,"open":1,"doing":0,"blocked":0,"done":0,"pending":1}');
  assert.equal(ledgerLine(read.counts), 'work-items: 未闭合 1 / 共 1 (doing 0 · blocked 0 · open 1 · done 0) · rev 1');
});

test('会话级路径：workItemsScopeOf（队友随 Lead）/ workItemsRelativePath（覆盖优先、非法作用域回落）', async () => {
  assert.equal(workItemsScopeOf({ id: 's-root', header: {} }), 's-root');
  assert.equal(workItemsScopeOf({ id: 's-team', header: { origin: 'subagent', parentSession: 's-root' } }), 's-root');
  assert.equal(workItemsScopeOf({ id: 's-nest', header: { delegationDepth: 2, parentSession: 's-team' } }), 's-team');
  assert.equal(workItemsScopeOf({ id: 's-x' }), 's-x');
  assert.equal(workItemsScopeOf(undefined), undefined);
  assert.equal(workItemsScopeOf({}), undefined);
  assert.equal(workItemsRelativePath(undefined, 's-root'), '.scratch/context-relay/work-items/s-root.json');
  assert.equal(workItemsRelativePath('custom/shared.json', 's-root'), 'custom/shared.json');
  assert.equal(workItemsRelativePath(undefined, 'bad/../id'), WORK_ITEMS_RELATIVE, '非法作用域回落旧路径');
  assert.equal(workItemsPathOf('/w', undefined, 's-root'), '/w/.scratch/context-relay/work-items/s-root.json');
  assert.equal(workItemsPathOf('/w', 'shared.json', 's-root'), '/w/shared.json', '显式覆盖优先');
});

test('会话级隔离 / 交接继承 / 旧 workspace 台账迁移', async () => {
  const cwd = tempCwd();
  const a = await writeWorkItems(cwd, { items: [{ id: 'aa', title: 'A', status: 'open', next: 'go' }], scopeId: 'scope-a' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.relativePath, '.scratch/context-relay/work-items/scope-a.json');
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-a' }).exists, true);
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-b' }).exists, false, '会话之间互不串账');

  // 交接继承：复制到新会话作用域（rev 保留），源台账保留
  const copied = await copyWorkItemsToScope(cwd, { fromScopeId: 'scope-a', toScopeId: 'scope-child' });
  assert.equal(copied, '.scratch/context-relay/work-items/scope-child.json');
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-child' }).rev, a.ledger.rev);
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-child' }).items[0].id, 'aa');
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-a' }).exists, true, '源台账不被移走');
  assert.equal(await copyWorkItemsToScope(cwd, { fromScopeId: 'scope-a', toScopeId: 'scope-child' }), undefined, '目标已存在不覆盖');
  assert.equal(await copyWorkItemsToScope(cwd, { fromScopeId: 'scope-a', toScopeId: 'scope-x', pathOverride: 'shared.json' }), undefined, '显式共享路径不复制');

  // 旧 workspace 级台账 → 会话级一次性迁移（仅最后写者=本作用域时；不会偷别人的台账）
  const legacyCwd = tempCwd();
  await writeWorkItems(legacyCwd, { items: [{ id: 'old', title: '旧', status: 'doing', next: 'n' }], scopeId: 'scope-legacy', updatedBy: 'scope-legacy' });
  const scopedPath = join(legacyCwd, '.scratch', 'context-relay', 'work-items', 'scope-legacy.json');
  renameSync(scopedPath, join(legacyCwd, '.scratch', 'context-relay', 'work-items.json'));
  const migrated = readWorkItems(legacyCwd, { scopeId: 'scope-legacy' });
  assert.equal(migrated.exists, true, '旧台账按 updatedBy 迁移到会话级');
  assert.equal(migrated.items[0].id, 'old');
  assert.equal(readWorkItems(legacyCwd, { scopeId: 'scope-other' }).exists, false, '其它会话不迁移、不偷台账');
  // 过渡期：别的会话写的旧文件不会覆盖本会话已迁移的台账
  writeFileSync(join(legacyCwd, '.scratch', 'context-relay', 'work-items.json'), JSON.stringify({
    version: 1, rev: 9, updatedAt: new Date().toISOString(), updatedBy: 'scope-other',
    items: [{ id: 'x1', title: 'X', status: 'open', next: 'n' }],
  }));
  assert.equal(readWorkItems(legacyCwd, { scopeId: 'scope-legacy' }).items[0].id, 'old', '他人旧文件不覆盖本会话');
});

test('ledgerAgeMinutes/ledgerAgeSuffix：新鲜度后缀（刚更新 / N 分钟前 / 停滞提醒；缺 updatedAt 为空）', async () => {
  const now = Date.parse('2026-11-12T12:00:00.000Z');
  assert.equal(ledgerAgeMinutes({ updatedAt: '2026-11-12T11:58:00.000Z' }, now), 2);
  assert.equal(ledgerAgeMinutes({ updatedAt: '2026-11-12T12:00:30.000Z' }, now), 0, '未来时间按 0 处理');
  assert.equal(ledgerAgeMinutes({}, now), null);
  assert.equal(ledgerAgeMinutes({ updatedAt: 'not-a-date' }, now), null);
  assert.equal(ledgerAgeSuffix({ updatedAt: '2026-11-12T11:59:30.000Z' }, { now }), ' · 刚更新');
  assert.equal(ledgerAgeSuffix({ updatedAt: '2026-11-12T11:50:00.000Z' }, { now }), ' · 更新于 10 分钟前');
  assert.match(ledgerAgeSuffix({ updatedAt: '2026-11-12T11:00:00.000Z' }, { now }), /^ · 更新于 60 分钟前（台账已停滞：phase 边界\/交接前先更新）$/);
  assert.equal(ledgerAgeSuffix({}, { now }), '');
  assert.equal(ledgerAgeSuffix({ updatedAt: '2026-11-12T11:00:00.000Z' }, { now, staleMinutes: 120 }), ' · 更新于 60 分钟前', '阈值可调');
});

test('formatWorkItemLines：有界行、owner/next/evidence 段、includeDone 与 limit', async () => {
  const items = [
    { id: 'doing-a', title: '进行中', status: 'doing', owner: 'worker-1', next: '写 handler', evidence: ['a.js:1', 'b.js:2'], updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'done-b', title: '已完成', status: 'done', officialTaskId: 'task-9', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'open-c', title: '待办', status: 'open', next: '开工', updatedAt: '2026-03-01T00:00:00.000Z' },
  ];
  const pendingLines = formatWorkItemLines(items);
  assert.deepEqual(pendingLines, [
    '- [doing-a] 进行中 · owner=worker-1 · → 写 handler · evidence 2 · doing',
    '- [open-c] 待办 · → 开工 · open',
  ]);
  assert.equal(formatWorkItemLines(items, { limit: 1 }).length, 1);
  assert.equal(formatWorkItemLines(items, { limit: 0 }).length, 0);
  const withDone = formatWorkItemLines(items, { includeDone: true });
  assert.equal(withDone.length, 3);
  assert.match(withDone[2], /\[done-b\] 已完成 · done · official=task-9$/);
  assert.deepEqual(formatWorkItemLines([], {}), []);
});

test('ledgerNextActions：pendingFirst 前 max 条，blocked 带原因，omitted 为剩余 id', async () => {
  const items = [
    { id: 'blocked-x', title: '阻塞项', status: 'blocked', blocked: '等接口', updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'doing-a', title: '进行中', status: 'doing', next: '写 handler', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'open-b', title: '待办', status: 'open', next: '开工', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'done-c', title: '完成', status: 'done' },
  ];
  const { actions, omitted } = ledgerNextActions(items, { max: 2 });
  assert.deepEqual(actions, ['[blocked-x] 阻塞项（阻塞：等接口）', '[doing-a] 进行中 → 写 handler']);
  assert.deepEqual(omitted, ['open-b']);
  const all = ledgerNextActions(items, { max: 8 });
  assert.equal(all.actions.length, 3);
  assert.deepEqual(all.omitted, []);
  assert.deepEqual(ledgerNextActions([], { max: 8 }), { actions: [], omitted: [] });
});

test('ledgerBriefSection/ledgerHandoffSection/ledgerEntryLine：空台账返回空；有内容时含路径/rev/计数/条目', async () => {
  const emptyCwd = tempCwd();
  const empty = readWorkItems(emptyCwd);
  assert.equal(ledgerBriefSection(empty), '');
  assert.equal(ledgerHandoffSection(empty), '');
  assert.equal(ledgerEntryLine(empty), '');

  const cwd = tempCwd();
  await seed(cwd, [
    { id: 'blocked-x', title: '阻塞项', status: 'blocked', blocked: '等接口' },
    { id: 'doing-a', title: '进行中', status: 'doing', next: '写 handler' },
    { id: 'done-c', title: '完成', status: 'done', evidence: ['x.js:1'], lead_confirm: LEAD_CONFIRM },
  ]);
  const read = readSeed(cwd);

  const brief = ledgerBriefSection(read, { limit: 1 });
  assert.match(brief, /^## 未闭合工作项\n/);
  assert.match(brief, /\[blocked-x\] 阻塞项/);
  assert.doesNotMatch(brief, /doing-a/);
  assert.ok(brief.includes('- 台账：' + WORK_ITEMS_RELATIVE + ' · rev 1 · 未闭合 2 / 共 3'));

  const handoff = ledgerHandoffSection(read, { limit: 2, omitted: ['open-y', 'open-z'] });
  assert.match(handoff, /^## 工作台账\n/);
  assert.ok(handoff.includes('- 台账：' + WORK_ITEMS_RELATIVE + ' · rev 1 · 未闭合 2 / 共 3'));
  assert.match(handoff, /\[doing-a\] 进行中/);
  assert.ok(handoff.includes('- 未带走项（超过 next_actions 上限）：open-y, open-z'));
  assert.doesNotMatch(ledgerHandoffSection(read, { omitted: [] }), /未带走项/);

  const entry = ledgerEntryLine(read);
  assert.ok(entry.startsWith('工作台账：' + WORK_ITEMS_RELATIVE + '（未闭合 2 / 共 3'));
  assert.match(entry, /前 2 条：\[blocked-x\] 阻塞项/);
  assert.match(entry, /用 relay_work_items 读）/);
  assert.match(ledgerEntryLine(read, { limit: 1 }), /；…；用 relay_work_items 读）/);
});

test('ledgerBriefSection：全部 done 时无未闭合段；handoff/entry 仍给台账计数', async () => {
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'done-a', title: '完成', status: 'done', evidence: ['x.js:1'], lead_confirm: LEAD_CONFIRM }]);
  const read = readSeed(cwd);
  assert.equal(ledgerBriefSection(read), '');
  assert.match(ledgerHandoffSection(read), /未闭合 0 \/ 共 1/);
  assert.match(ledgerEntryLine(read), /未闭合 0 \/ 共 1；用 relay_work_items 读）/);
});

// ---- ship gate ----

test('checkShipGate：strict 拒绝未 done/blocked 条目；done 缺 evidence 拒绝', async () => {
  const incomplete = checkShipGate({
    items: [
      { id: 'doing-a', title: 'A', status: 'doing', next: 'x' },
      { id: 'done-b', title: 'B', status: 'done', evidence: ['x.js:1'] },
    ],
  }, { gate: 'strict' });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'work-items-incomplete');
  assert.deepEqual(incomplete.ids, ['doing-a']);
  assert.match(incomplete.message, /doing-a/);

  const noEvidence = checkShipGate({
    items: [
      { id: 'done-a', title: 'A', status: 'done' },
      { id: 'done-b', title: 'B', status: 'done', evidence: ['x.js:1'] },
    ],
  });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.code, 'work-items-evidence-missing');
  assert.deepEqual(noEvidence.ids, ['done-a']);

  const pass = checkShipGate({
    items: [
      { id: 'done-a', title: 'A', status: 'done', evidence: ['x.js:1'] },
      { id: 'blocked-b', title: 'B', status: 'blocked', blocked: '外部依赖' },
    ],
  });
  assert.deepEqual(pass, { ok: true });
  assert.deepEqual(checkShipGate({ items: [] }), { ok: true });
  assert.deepEqual(checkShipGate(readWorkItems(tempCwd())), { ok: true });
});

test('checkShipGate：off 直接放行；warn 放行但给 warnings；默认 strict', async () => {
  const ledger = {
    items: [
      { id: 'doing-a', title: 'A', status: 'doing', next: 'x' },
      { id: 'done-b', title: 'B', status: 'done' },
    ],
  };
  assert.deepEqual(checkShipGate(ledger, { gate: 'off' }), { ok: true });
  const warned = checkShipGate(ledger, { gate: 'warn' });
  assert.equal(warned.ok, true);
  assert.equal(warned.warnings.length, 2);
  assert.match(warned.warnings[0], /doing-a/);
  assert.match(warned.warnings[1], /done-b/);
  const defaulted = checkShipGate(ledger);
  assert.equal(defaulted.ok, false);
  assert.equal(defaulted.code, 'work-items-incomplete');
  // readWorkItems 返回值同样可用。
  const cwd = tempCwd();
  await seed(cwd, [{ id: 'doing-a', title: 'A', status: 'doing', next: 'x' }]);
  assert.equal(checkShipGate(readSeed(cwd), { gate: 'warn' }).ok, true);
});

// ---- v0.6.0 phase 元数据 / 关 phase 闸门 ----

test('phase 元数据：currentPhase 读写、不传保留、phaseSummary/phaseFocusLine/phaseLine', async () => {
  const cwd = tempCwd();
  const written = await seed(cwd, [
    { id: 'gate', title: '实现关账闸门', status: 'doing', next: '写拒绝路径与测试', phase: 'build' },
    { id: 'docs', title: '写文档', status: 'open', phase: 'build' },
  ], { currentPhase: { phase: 'build', goal: '台账 phase 化', exitCriteria: '闸门生效', since: 1, openedAtRev: 0 }, updatedBy: 'session-x' });
  assert.equal(written.ok, true);
  const read = readWorkItems(cwd);
  assert.equal(read.currentPhase.phase, 'build');
  assert.equal(read.currentPhase.goal, '台账 phase 化');
  assert.equal(read.currentPhase.exitCriteria, '闸门生效');
  assert.deepEqual(phaseItemsOf(read, 'build').map((item) => item.id), ['gate', 'docs']);
  const summary = phaseSummary(read);
  assert.equal(summary.planned, 2);
  assert.equal(summary.done, 0);
  assert.equal(summary.pending, 2);
  assert.equal(summary.doing, 1);
  assert.match(phaseFocusLine(read), /doing「实现关账闸门」next「写拒绝路径与测试」/);
  assert.equal(phaseLine(read), 'phase build · 分点 0/2（未闭合 2）');
  // 不传 currentPhase → 保留原值；显式 null → 清空
  const kept = await seed(cwd, read.items, { rev: read.rev, currentPhase: undefined });
  assert.equal(kept.ledger.currentPhase.phase, 'build');
  const readKept = readWorkItems(cwd);
  const cleared = await writeWorkItems(cwd, { items: readKept.items, rev: readKept.rev, currentPhase: null });
  assert.equal(cleared.ok, true);
  assert.equal(readWorkItems(cwd).currentPhase, null);
  // 全部 done → 焦点行提示可以关 phase（主链非终点 phase 仍可执行）
  const done = await seed(cwd, [
    { id: 'gate', title: '实现关账闸门', status: 'done', evidence: ['test/agent.test.mjs'], phase: 'build', lead_confirm: LEAD_CONFIRM },
  ], { currentPhase: { phase: 'build' } });
  assert.equal(done.ok, true);
  assert.match(phaseFocusLine(readWorkItems(cwd)), /分点全闭环 → 可以关 phase（relay_phase）/);
  // ship 是主链终点：全 done 后没有「关 phase」下一步，焦点行不再出现（用户 2026-11-16 反馈）
  const shipLedger = { currentPhase: { phase: 'ship' }, items: [{ id: 'gate', title: '收尾', status: 'done', evidence: ['e'], phase: 'ship' }] };
  assert.equal(phaseFocusLine(shipLedger), '', 'ship 全闭环不再催 relay_phase');
});

test('checkPhaseGate：strict 拒绝未收口；carry 显式带走；warn 放行；空台账放行', async () => {
  const ledger = {
    exists: true,
    currentPhase: { phase: 'discover' },
    items: [
      { id: 'aa', title: 'A', status: 'open', phase: 'discover' },
      { id: 'bb', title: 'B', status: 'done', phase: 'discover', evidence: ['e'] },
      { id: 'cc', title: 'C', status: 'doing', next: 'x', phase: 'build' },
    ],
  };
  const strict = checkPhaseGate(ledger, { phase: 'discover', gate: 'strict' });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, 'phase-not-closed');
  assert.deepEqual(strict.leftover, ['aa']);
  assert.match(strict.message, /relay_work_items/);
  const carried = checkPhaseGate(ledger, { phase: 'discover', carry: ['aa'], gate: 'strict' });
  assert.equal(carried.ok, true);
  assert.deepEqual(carried.carried, ['aa']);
  assert.deepEqual(carried.leftover, []);
  assert.equal(checkPhaseGate(ledger, { phase: 'discover', gate: 'warn' }).ok, true);
  assert.equal(checkPhaseGate(ledger, { phase: 'discover', gate: 'off' }).ok, true);
  assert.equal(checkPhaseGate({ exists: false, items: [] }, { phase: 'discover' }).ok, true);
  const applied = applyPhaseCarry(ledger.items, { carry: ['aa'], from: 'discover', to: 'build' });
  const moved = applied.find((item) => item.id === 'aa');
  assert.equal(moved.phase, 'build');
  assert.equal(moved.carriedFrom, 'discover');
  assert.equal(applied.find((item) => item.id === 'bb').phase, 'discover');
});

test('checkPhaseGate：phase=null 条目纳入关闸（C7/A-03 strict 不可绕过），carry 可显式带走', async () => {
  const ledger = {
    exists: true,
    currentPhase: { phase: 'build' },
    items: [
      { id: 'phased', title: '本 phase 未收口', status: 'doing', next: 'x', phase: 'build' },
      { id: 'unphased', title: '未标 phase', status: 'doing', next: 'y', phase: null },
      { id: 'unphased-done', title: '无 phase 已完成', status: 'done', evidence: ['e:1'], phase: null },
      { id: 'later', title: '别的 phase', status: 'doing', next: 'z', phase: 'verify' },
    ],
  };
  const strict = checkPhaseGate(ledger, { phase: 'build', gate: 'strict' });
  assert.equal(strict.ok, false, 'phase=null 未闭合条目不能绕过 strict 关闸');
  assert.deepEqual(strict.leftover, ['phased', 'unphased']);
  assert.match(strict.message, /未标 phase，视同本 phase/);
  const carried = checkPhaseGate(ledger, { phase: 'build', carry: ['unphased'], gate: 'strict' });
  assert.equal(carried.ok, false, '只 carry 一条仍有另一条未收口');
  assert.deepEqual(carried.carried, ['unphased']);
  assert.deepEqual(carried.leftover, ['phased']);
  const warn = checkPhaseGate(ledger, { phase: 'build', gate: 'warn' });
  assert.equal(warn.ok, true, 'warn 只提示');
  assert.deepEqual(warn.warnings, ['phase "build" item not closed: phased', 'phase "build" item not closed: unphased']);
  const applied = applyPhaseCarry(ledger.items, { carry: ['unphased'], from: 'build', to: 'verify' });
  const moved = applied.find((item) => item.id === 'unphased');
  assert.equal(moved.phase, 'verify', '无 phase 条目 carry 后落到新 phase（不被静默丢下）');
  assert.equal(moved.carriedFrom, 'build');
  assert.equal(applied.find((item) => item.id === 'later').phase, 'verify', '别的 phase 条目不被 carry 影响');
  assert.equal(applied.find((item) => item.id === 'phased').phase, 'build');
});

test('readWorkItems migrateLegacy:false：只读路径不迁移写盘（C14）；默认仍迁移', async () => {
  const scopeId = 'scope-readonly';
  const writeLegacy = (cwd) => {
    const path = ledgerPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1, rev: 3, updatedAt: new Date().toISOString(), updatedBy: scopeId,
      items: [{ id: 'legacy-1', title: '旧台账条目', status: 'doing', next: 'n' }],
    }));
    return path;
  };
  const readonlyCwd = tempCwd();
  writeLegacy(readonlyCwd);
  const readonly = readWorkItems(readonlyCwd, { scopeId, migrateLegacy: false });
  assert.equal(readonly.exists, false, '只读路径不迁移：会话级台账仍为空');
  assert.equal(existsSync(join(readonlyCwd, '.scratch', 'context-relay', 'work-items', scopeId + '.json')), false, '只读路径不得写盘');
  assert.ok(existsSync(ledgerPath(readonlyCwd)), '旧 workspace 台账原样保留');
  const migratedCwd = tempCwd();
  writeLegacy(migratedCwd);
  const migrated = readWorkItems(migratedCwd, { scopeId });
  assert.equal(migrated.exists, true, '默认（工具/写路径）仍迁移');
  assert.equal(migrated.items[0].id, 'legacy-1');
  assert.ok(existsSync(join(migratedCwd, '.scratch', 'context-relay', 'work-items', scopeId + '.json')), '默认路径迁移写盘');
});

test('createPhaseItems：标题 → id（中文回退 point、冲突加后缀）、open 无 next、phase 正确', async () => {
  const created = createPhaseItems(['实现关账闸门', '实现关账闸门', 'write tests'], { phase: 'build', existing: [{ id: 'write-tests' }] });
  assert.equal(created.length, 3);
  assert.equal(created[0].id, 'point');
  assert.equal(created[1].id, 'point-2');
  assert.notEqual(created[2].id, 'write-tests');
  assert.equal(created[0].phase, 'build');
  assert.equal(created[0].status, 'open');
  assert.equal(created[0].next, null);
  assert.equal(created[0].carriedFrom, null);
  // 生成后能过整表校验（open 允许空 next）
  const validated = validateWorkItems(created);
  assert.equal(validated.ok, true, JSON.stringify(validated));
});

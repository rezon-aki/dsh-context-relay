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
  applyItemUpdates,
  migrateOwner,
  checkPhaseGate,
  applyPhaseCarry,
  createPhaseItems,
  phaseItemsOf,
  phaseSummary,
  phaseFocusLine,
  phaseLine,
} from '../lib/agent/work-items.js';

const tempCwd = () => mkdtempSync(join(tmpdir(), 'relay-work-items-'));
const ledgerPath = (cwd) => join(cwd, '.scratch', 'context-relay', 'work-items.json');
const seed = (cwd, items, options = {}) => {
  const result = writeWorkItems(cwd, { items, ...options });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const readSeed = (cwd) => readWorkItems(cwd);

// ---- config / path ----

test('normalizeWorkItemsConfig：默认 enabled/strict/30，非法 gate 与 max 归一', () => {
  assert.deepEqual(normalizeWorkItemsConfig(), { enabled: true, gate: 'strict', phaseGate: 'strict', pathOverride: undefined, max: 30 });
  assert.deepEqual(normalizeWorkItemsConfig({ workItems: false }), { enabled: false, gate: 'strict', phaseGate: 'strict', pathOverride: undefined, max: 30 });
  assert.equal(normalizeWorkItemsConfig({ workItemsPhaseGate: 'warn' }).phaseGate, 'warn');
  assert.equal(normalizeWorkItemsConfig({ workItemsPhaseGate: 'off' }).phaseGate, 'off');
  assert.equal(normalizeWorkItemsConfig({ workItemsPhaseGate: 'nonsense' }).phaseGate, 'strict');
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

test('workItemsPathOf：默认绝对路径；相对 override 按 cwd 解析；绝对 override 原样', () => {
  const cwd = '/tmp/example-cwd';
  assert.equal(workItemsPathOf(cwd), cwd + '/' + WORK_ITEMS_RELATIVE);
  assert.equal(workItemsPathOf(cwd, 'custom/items.json'), cwd + '/custom/items.json');
  assert.equal(workItemsPathOf(cwd, '/abs/items.json'), '/abs/items.json');
});

// ---- read / write ----

test('readWorkItems：文件不存在 → exists:false、空台账、ok:true、永不抛', () => {
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

test('writeWorkItems/readWorkItems：合法写入并读回（归一化字段 + rev/updatedBy/version）', () => {
  const cwd = tempCwd();
  const written = seed(cwd, [
    { id: 'schema', title: '定 schema', status: 'done', evidence: ['lib/a.js:1'] },
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

test('writeWorkItems：rev 递增；内容不变保留 updatedAt、内容变化/新条目用 now', () => {
  const cwd = tempCwd();
  seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const stored = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8'));
  stored.items[0].updatedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(ledgerPath(cwd), JSON.stringify(stored), 'utf8');

  const first = readSeed(cwd);
  assert.equal(first.items[0].updatedAt, '2020-01-01T00:00:00.000Z');
  const same = writeWorkItems(cwd, { items: first.items, rev: first.rev });
  assert.equal(same.ok, true);
  assert.equal(same.ledger.rev, first.rev + 1);
  assert.equal(same.ledger.items[0].updatedAt, '2020-01-01T00:00:00.000Z');

  const changed = writeWorkItems(cwd, { items: [{ ...first.items[0], title: 'A2' }], rev: same.ledger.rev });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.ledger.items[0].updatedAt, '2020-01-01T00:00:00.000Z');
  assert.ok(Date.parse(changed.ledger.items[0].updatedAt) > Date.parse('2020-01-01T00:00:00.000Z'));

  const added = writeWorkItems(cwd, { items: [...changed.ledger.items, { id: 'bb', title: 'B', status: 'open', next: 'x' }], rev: changed.ledger.rev });
  assert.equal(added.ok, true);
  const addedItem = added.ledger.items.find((item) => item.id === 'bb');
  assert.ok(Date.parse(addedItem.updatedAt) > Date.parse('2020-01-01T00:00:00.000Z'));
  assert.equal(added.ledger.rev, 4);
});

test('writeWorkItems：写空表（全部关闭）落盘成功且 counts 归零', () => {
  const cwd = tempCwd();
  seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const read = readSeed(cwd);
  const cleared = writeWorkItems(cwd, { items: [], rev: read.rev });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.counts, { total: 0, open: 0, doing: 0, blocked: 0, done: 0, pending: 0 });
  assert.equal(cleared.ledger.rev, read.rev + 1);
  const after = readSeed(cwd);
  assert.equal(after.exists, true);
  assert.deepEqual(after.items, []);
});

test('writeWorkItems：rev 冲突 → stale-revision（附 currentRev/counts，且不覆盖文件）', () => {
  const cwd = tempCwd();
  seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const before = JSON.parse(readFileSync(ledgerPath(cwd), 'utf8'));
  const stale = writeWorkItems(cwd, { items: [{ id: 'bb', title: 'B', status: 'open', next: 'x' }], rev: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  assert.equal(stale.currentRev, 1);
  assert.equal(stale.counts.total, 1);
  assert.match(stale.message, /revision mismatch/);
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath(cwd), 'utf8')), before);
  // 无 rev 的整表替换允许（旧会话兼容）。
  const noRev = writeWorkItems(cwd, { items: [{ id: 'bb', title: 'B', status: 'open', next: 'x' }] });
  assert.equal(noRev.ok, true);
  assert.equal(noRev.ledger.rev, 2);
});

test('writeWorkItems：原子写不留 tmp 文件', () => {
  const cwd = tempCwd();
  seed(cwd, [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }]);
  const names = readdirSync(dirname(ledgerPath(cwd)));
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
  assert.ok(names.includes('work-items.json'));
});

test('writeWorkItems：写盘失败 → write-failed（不半写、不抛）', () => {
  const cwd = tempCwd();
  const blocker = join(cwd, 'blocker');
  writeFileSync(blocker, 'not-a-directory', 'utf8');
  const result = writeWorkItems(cwd, { items: [{ id: 'aa', title: 'A', status: 'doing', next: 'go' }], pathOverride: join(blocker, 'nested', 'work-items.json') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'write-failed');
  assert.match(result.message, /failed to write work ledger/);
  assert.equal(existsSync(join(blocker, 'nested', 'work-items.json')), false);
});

test('readWorkItems：损坏 JSON → 隔离 .corrupt-<ts>、返回 corruptBackup、视为空台账', () => {
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
  const written = seed(cwd, [{ id: 'aa', title: 'A', status: 'open', next: 'go' }]);
  assert.equal(written.ledger.rev, 1);
});

test('readWorkItems：结构损坏（items 非数组）同样隔离并空台账', () => {
  const cwd = tempCwd();
  mkdirSync(dirname(ledgerPath(cwd)), { recursive: true });
  writeFileSync(ledgerPath(cwd), JSON.stringify({ version: 1, rev: 3, items: { a: 1 } }), 'utf8');
  const read = readWorkItems(cwd);
  assert.equal(read.exists, false);
  assert.equal(read.rev, 0);
  assert.ok(read.corruptBackup);
});

// ---- validate ----

test('validateWorkItems：doing 缺 next、blocked 缺原因报错（open 允许空 next）', () => {
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

test('validateWorkItems：重复 id → duplicate-id；非法 id → invalid-item/invalid-id', () => {
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

test('validateWorkItems：超过 max → ledger-full；写入同样受限', () => {
  const items = [0, 1, 2].map((index) => ({ id: 'item-' + index, title: 'T' + index, status: 'done' }));
  const tooMany = validateWorkItems(items, { max: 2 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'ledger-full');
  assert.match(tooMany.message, /at most 2/);
  assert.equal(validateWorkItems(items, { max: 3 }).ok, true);
  const write = writeWorkItems(tempCwd(), { items, max: 2 });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'ledger-full');
  assert.equal(writeWorkItems(tempCwd(), { items }).ok, true);
});

test('validateWorkItems：depends 不存在 / 自引用 / 环 → invalid-item + 对应 per-error code', () => {
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

test('validateWorkItems：合法条目归一（trim、未知字段丢弃、非 blocked 清空 blocked、缺省可选字段为 null/[]）', () => {
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

  assert.equal(validateWorkItems('nope').ok, false);
  assert.equal(validateWorkItems([]).ok, true);
  assert.deepEqual(WORK_ITEM_STATUSES, ['open', 'doing', 'blocked', 'done']);
});

// ---- counts / ordering ----

test('countsOf/pendingFirst：pending=未 done；排序 blocked→doing→open、组内 updatedAt 倒序、done 不出现', () => {
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

test('ledgerLine：固定格式（counts / ledger 两种入参）', () => {
  const counts = { total: 4, open: 1, doing: 1, blocked: 1, done: 1, pending: 3 };
  assert.equal(ledgerLine(counts), 'work-items: 未闭合 3 / 共 4 (doing 1 · blocked 1 · open 1 · done 1) · rev 0');
  assert.equal(ledgerLine({ ...counts, rev: 7 }), 'work-items: 未闭合 3 / 共 4 (doing 1 · blocked 1 · open 1 · done 1) · rev 7');
  assert.equal(ledgerLine({ rev: 5, items: [] }), 'work-items: 未闭合 0 / 共 0 (doing 0 · blocked 0 · open 0 · done 0) · rev 5');
  // readWorkItems().counts 携带不可枚举 rev（序列化形状不变），ledgerLine(counts) 也能显示真实 rev。
  const cwd = tempCwd();
  seed(cwd, [{ id: 'aa', title: 'A', status: 'open', next: 'go' }]);
  const read = readSeed(cwd);
  assert.deepEqual(read.counts, { total: 1, open: 1, doing: 0, blocked: 0, done: 0, pending: 1 });
  assert.equal(JSON.stringify(read.counts), '{"total":1,"open":1,"doing":0,"blocked":0,"done":0,"pending":1}');
  assert.equal(ledgerLine(read.counts), 'work-items: 未闭合 1 / 共 1 (doing 0 · blocked 0 · open 1 · done 0) · rev 1');
});

test('会话级路径：workItemsScopeOf（队友随 Lead）/ workItemsRelativePath（覆盖优先、非法作用域回落）', () => {
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

test('会话级隔离 / 交接继承 / 旧 workspace 台账迁移', () => {
  const cwd = tempCwd();
  const a = writeWorkItems(cwd, { items: [{ id: 'aa', title: 'A', status: 'open', next: 'go' }], scopeId: 'scope-a' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.relativePath, '.scratch/context-relay/work-items/scope-a.json');
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-a' }).exists, true);
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-b' }).exists, false, '会话之间互不串账');

  // 交接继承：复制到新会话作用域（rev 保留），源台账保留
  const copied = copyWorkItemsToScope(cwd, { fromScopeId: 'scope-a', toScopeId: 'scope-child' });
  assert.equal(copied, '.scratch/context-relay/work-items/scope-child.json');
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-child' }).rev, a.ledger.rev);
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-child' }).items[0].id, 'aa');
  assert.equal(readWorkItems(cwd, { scopeId: 'scope-a' }).exists, true, '源台账不被移走');
  assert.equal(copyWorkItemsToScope(cwd, { fromScopeId: 'scope-a', toScopeId: 'scope-child' }), undefined, '目标已存在不覆盖');
  assert.equal(copyWorkItemsToScope(cwd, { fromScopeId: 'scope-a', toScopeId: 'scope-x', pathOverride: 'shared.json' }), undefined, '显式共享路径不复制');

  // 旧 workspace 级台账 → 会话级一次性迁移（仅最后写者=本作用域时；不会偷别人的台账）
  const legacyCwd = tempCwd();
  writeWorkItems(legacyCwd, { items: [{ id: 'old', title: '旧', status: 'doing', next: 'n' }], scopeId: 'scope-legacy', updatedBy: 'scope-legacy' });
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

test('ledgerAgeMinutes/ledgerAgeSuffix：新鲜度后缀（刚更新 / N 分钟前 / 停滞提醒；缺 updatedAt 为空）', () => {
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

test('formatWorkItemLines：有界行、owner/next/evidence 段、includeDone 与 limit', () => {
  const items = [
    { id: 'doing-a', title: '进行中', status: 'doing', owner: 'worker-1', next: '写 handler', evidence: ['a.js:1', 'b.js:2'], updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'done-b', title: '已完成', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z' },
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
  assert.match(withDone[2], /\[done-b\] 已完成 · done$/);
  assert.deepEqual(formatWorkItemLines([], {}), []);
});

test('ledgerNextActions：pendingFirst 前 max 条，blocked 带原因，omitted 为剩余 id', () => {
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

test('ledgerBriefSection/ledgerHandoffSection/ledgerEntryLine：空台账返回空；有内容时含路径/rev/计数/条目', () => {
  const emptyCwd = tempCwd();
  const empty = readWorkItems(emptyCwd);
  assert.equal(ledgerBriefSection(empty), '');
  assert.equal(ledgerHandoffSection(empty), '');
  assert.equal(ledgerEntryLine(empty), '');

  const cwd = tempCwd();
  seed(cwd, [
    { id: 'blocked-x', title: '阻塞项', status: 'blocked', blocked: '等接口' },
    { id: 'doing-a', title: '进行中', status: 'doing', next: '写 handler' },
    { id: 'done-c', title: '完成', status: 'done', evidence: ['x.js:1'] },
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

test('ledgerBriefSection：全部 done 时无未闭合段；handoff/entry 仍给台账计数', () => {
  const cwd = tempCwd();
  seed(cwd, [{ id: 'done-a', title: '完成', status: 'done', evidence: ['x.js:1'] }]);
  const read = readSeed(cwd);
  assert.equal(ledgerBriefSection(read), '');
  assert.match(ledgerHandoffSection(read), /未闭合 0 \/ 共 1/);
  assert.match(ledgerEntryLine(read), /未闭合 0 \/ 共 1；用 relay_work_items 读）/);
});

// ---- ship gate ----

test('checkShipGate：strict 拒绝未 done/blocked 条目；done 缺 evidence 拒绝', () => {
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

test('checkShipGate：off 直接放行；warn 放行但给 warnings；默认 strict', () => {
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
  seed(cwd, [{ id: 'doing-a', title: 'A', status: 'doing', next: 'x' }]);
  assert.equal(checkShipGate(readSeed(cwd), { gate: 'warn' }).ok, true);
});

// ---- teammate edits / owner migration ----

test('applyItemUpdates：队友可改自己条目；未知 id/越权/合并后非法分别报错', () => {
  const cwd = tempCwd();
  seed(cwd, [
    { id: 'mine', title: '我的', status: 'doing', owner: 'worker-1', next: '写 handler' },
    { id: 'other', title: '别人', status: 'open', owner: 'worker-2', next: '开工' },
    { id: 'lead-item', title: 'Lead 的', status: 'open', next: '排期' },
  ]);
  const read = readSeed(cwd);

  const applied = applyItemUpdates(read, {
    owner: 'worker-1',
    updates: [{ id: 'mine', status: 'done', evidence: ['lib/x.js:1'] }],
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.counts.done, 1);
  const mine = applied.items.find((item) => item.id === 'mine');
  assert.equal(mine.status, 'done');
  assert.deepEqual(mine.evidence, ['lib/x.js:1']);
  assert.equal(mine.title, '我的');
  assert.equal(mine.owner, 'worker-1');

  // 修改 next 但 status 仍 doing → 合法。
  const nextOnly = applyItemUpdates(read, { owner: 'worker-1', updates: [{ id: 'mine', next: '写测试' }] });
  assert.equal(nextOnly.ok, true);
  assert.equal(nextOnly.items.find((item) => item.id === 'mine').next, '写测试');

  const unknown = applyItemUpdates(read, { owner: 'worker-1', updates: [{ id: 'ghost', status: 'done' }] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'invalid-item');
  assert.equal(unknown.errors[0].code, 'invalid-item');

  const scope = applyItemUpdates(read, { owner: 'worker-1', updates: [{ id: 'other', status: 'done' }] });
  assert.equal(scope.ok, false);
  assert.equal(scope.code, 'teammate-scope');
  assert.deepEqual(scope.ids, ['other']);

  // 无 owner 条目视为 Lead 名下：队友越权、lead 可改。
  assert.equal(applyItemUpdates(read, { owner: 'worker-1', updates: [{ id: 'lead-item', status: 'doing', next: 'x' }] }).code, 'teammate-scope');
  assert.equal(applyItemUpdates(read, { owner: 'lead', updates: [{ id: 'lead-item', status: 'doing', next: 'x' }] }).ok, true);

  const invalidMerged = applyItemUpdates(read, { owner: 'worker-2', updates: [{ id: 'other', status: 'blocked' }] });
  assert.equal(invalidMerged.ok, false);
  assert.equal(invalidMerged.code, 'invalid-item');
  assert.ok(invalidMerged.errors.some((error) => error.code === 'missing-blocked'));

  assert.equal(applyItemUpdates(read, { owner: 'worker-1', updates: [] }).code, 'invalid-item');
  assert.equal(applyItemUpdates(read, { owner: 'worker-1' }).code, 'invalid-item');
});

test('applyItemUpdates 结果可直接 writeWorkItems 落盘（读-改-写闭环）', () => {
  const cwd = tempCwd();
  seed(cwd, [{ id: 'mine', title: '我的', status: 'doing', owner: 'worker-1', next: '写 handler' }]);
  const read = readSeed(cwd);
  const applied = applyItemUpdates(read, { owner: 'worker-1', updates: [{ id: 'mine', status: 'done', evidence: ['lib/x.js:1'] }] });
  assert.equal(applied.ok, true);
  const written = writeWorkItems(cwd, { items: applied.items, rev: read.rev, updatedBy: 'worker-1' });
  assert.equal(written.ok, true);
  const after = readSeed(cwd);
  assert.equal(after.items[0].status, 'done');
  assert.deepEqual(after.items[0].evidence, ['lib/x.js:1']);
  assert.equal(after.rev, read.rev + 1);
});

test('migrateOwner：owner 从旧代迁到新代；无匹配/同代/空台账不写盘；非法参数报错', () => {
  const cwd = tempCwd();
  seed(cwd, [
    { id: 'item-a', title: 'A', status: 'doing', owner: 'worker-1-old', next: 'x' },
    { id: 'item-b', title: 'B', status: 'open', owner: 'worker-1-old', next: 'y' },
    { id: 'item-c', title: 'C', status: 'open', owner: 'worker-2', next: 'z' },
  ]);
  const read = readSeed(cwd);
  const migrated = migrateOwner(cwd, { from: 'worker-1-old', to: 'worker-1-new' });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, 2);
  assert.equal(migrated.counts.total, 3);
  const after = readSeed(cwd);
  assert.equal(after.items.find((item) => item.id === 'item-a').owner, 'worker-1-new');
  assert.equal(after.items.find((item) => item.id === 'item-b').owner, 'worker-1-new');
  assert.equal(after.items.find((item) => item.id === 'item-c').owner, 'worker-2');
  assert.equal(after.rev, read.rev + 1);

  const noMatch = migrateOwner(cwd, { from: 'nobody', to: 'somebody' });
  assert.deepEqual(noMatch, { ok: true, changed: 0, counts: after.counts });
  const same = migrateOwner(cwd, { from: 'worker-2', to: 'worker-2' });
  assert.equal(same.changed, 0);
  assert.equal(readSeed(cwd).rev, after.rev); // 无变化不落盘

  const emptyCwd = tempCwd();
  assert.deepEqual(migrateOwner(emptyCwd, { from: 'a', to: 'b' }), {
    ok: true,
    changed: 0,
    counts: { total: 0, open: 0, doing: 0, blocked: 0, done: 0, pending: 0 },
  });

  const invalid = migrateOwner(cwd, { from: '', to: 'x' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid-item');
  assert.equal(migrateOwner(cwd, {}).ok, false);
});

// ---- v0.6.0 phase 元数据 / 关 phase 闸门 ----

test('phase 元数据：currentPhase 读写、不传保留、phaseSummary/phaseFocusLine/phaseLine', () => {
  const cwd = tempCwd();
  const written = seed(cwd, [
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
  const kept = seed(cwd, read.items, { rev: read.rev, currentPhase: undefined });
  assert.equal(kept.ledger.currentPhase.phase, 'build');
  const readKept = readWorkItems(cwd);
  const cleared = writeWorkItems(cwd, { items: readKept.items, rev: readKept.rev, currentPhase: null });
  assert.equal(cleared.ok, true);
  assert.equal(readWorkItems(cwd).currentPhase, null);
  // 全部 done → 焦点行提示可以关 phase
  const done = seed(cwd, [
    { id: 'gate', title: '实现关账闸门', status: 'done', evidence: ['test/agent.test.mjs'], phase: 'build' },
  ], { currentPhase: { phase: 'build' } });
  assert.equal(done.ok, true);
  assert.match(phaseFocusLine(readWorkItems(cwd)), /分点全闭环/);
});

test('checkPhaseGate：strict 拒绝未收口；carry 显式带走；warn 放行；空台账放行', () => {
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

test('createPhaseItems：标题 → id（中文回退 point、冲突加后缀）、open 无 next、phase 正确', () => {
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

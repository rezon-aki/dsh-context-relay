import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertNoCredentials, hostStore, storagePath, workspaceStore } from '../lib/storage.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'relay-storage-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (cwd, name) => join(cwd, '.scratch', 'context-relay', name);

// ── M-08：凭据检测收紧（只拒已知前缀/高熵值；错误带字段名、不回显值）────────
test('M-08: 已知凭据形态拒绝；正常文本（含 key: 路径 / token: none）放行', () => {
  const rejected = [
    'token=abcdefghijklmnop',
    'api_key: abcdefghijklmnop',
    'password="hunter-secret"',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Bearer abcdefghijklmnopqrst',
    'sk-' + 'x'.repeat(24),
    'ghp_' + 'a'.repeat(30),
    'AKIA' + 'B'.repeat(16),
    'https://user:supersecret@example.com/path',
  ];
  for (const secret of rejected) {
    assert.throws(() => assertNoCredentials(secret), (error) => /credential/.test(error.message) && !error.message.includes(secret));
  }
  // 错误带命中字段名（值省略）
  assert.throws(() => assertNoCredentials('api_key: abcdefghijklmnop'), /api_key/);
  assert.throws(() => assertNoCredentials('token=abcdefghijklmnop'), /token/);
  // B 审计误杀案例：一律放行
  for (const safe of [
    'key: docs/design/DESIGN.md',
    'token: none',
    'the key: design',
    'api_key: 请向管理员索取',
    'password: 不告诉你',
    'token: null',
    '这是标题：设计',
    '见 docs/design/DESIGN.md 的 key: 说明',
  ]) {
    assert.doesNotThrow(() => assertNoCredentials(safe), '不应误杀: ' + safe);
  }
});

test('M-08: 所有写入门面统一过凭据检测（workspace/host，拒绝时旧内容不变）', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  await store.writeAtomic('brief.md', 'old');
  await assert.rejects(() => store.writeAtomic('brief.md', 'token=abcdefghijklmnop'), /credential/);
  assert.equal(readFileSync(record(cwd, 'brief.md'), 'utf8'), 'old', '拒绝后旧文件不变');
  await assert.rejects(() => store.appendLine('chain.ndjson', JSON.stringify({ note: 'api_key: abcdefghijklmnop' }) + '\n'), /credential/);
  const host = hostStore();
  const file = join(cwd, 'host', 'panel.json');
  host.writeAtomic(file, '{"schemaVersion":2}');
  assert.throws(() => host.writeAtomic(file, '{"x":"Bearer abcdefghijklmnopqrst"}'), /credential/);
  assert.equal(readFileSync(file, 'utf8'), '{"schemaVersion":2}');
});

// ── 路径守卫（越界/符号链接）──────────────────────────────────────────────
test('workspaceStore: 越界路径与符号链接在解析阶段拒绝，外部文件不被写', async () => {
  const cwd = fresh();
  const outside = fresh();
  const store = workspaceStore(cwd);
  assert.throws(() => store.path('../../../escape.md'), /outside/);
  assert.throws(() => store.path(join(outside, 'x.md')), /outside/);
  mkdirSync(record(cwd, ''), { recursive: true });
  writeFileSync(join(outside, 'target'), 'untouched');
  symlinkSync(join(outside, 'target'), record(cwd, 'linked.md'));
  await assert.rejects(() => store.writeAtomic('linked.md', 'bad'), /symbolic link/);
  assert.equal(readFileSync(join(outside, 'target'), 'utf8'), 'untouched');
  // 父目录符号链接同样拒绝
  const cwd2 = fresh();
  mkdirSync(join(cwd2, '.scratch'), { recursive: true });
  symlinkSync(outside, record(cwd2, ''));
  await assert.rejects(() => workspaceStore(cwd2).writeAtomic('x.md', 'bad'), /symbolic link/);
});

// ── 原子写 / NDJSON 追加 / redo journal ────────────────────────────────────
test('workspaceStore: 原子替换 + 乐观锁 expected + 单行 NDJSON 追加（无残留 tmp）', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  const path = await store.writeAtomic('brief.md', 'old');
  assert.equal(readFileSync(path, 'utf8'), 'old');
  await assert.rejects(() => store.writeAtomic('brief.md', 'bad', { expected: 'stale' }), /revision conflict/);
  assert.equal(readFileSync(path, 'utf8'), 'old');
  await store.writeAtomic('brief.md', 'new', { expected: 'old' });
  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.equal(await store.appendLine('chain.ndjson', '{"a":1}\n'), record(cwd, 'chain.ndjson'));
  await store.appendLine('chain.ndjson', '{"a":2}\n');
  assert.equal(readFileSync(record(cwd, 'chain.ndjson'), 'utf8'), '{"a":1}\n{"a":2}\n');
  await assert.rejects(() => store.appendLine('chain.ndjson', 'no-trailing-newline'), /NDJSON/);
  assert.deepEqual(readdirSync(record(cwd, '')).filter((name) => name.includes('.tmp-') || name.endsWith('.lock')), []);
});

test('workspaceStore: redo journal 幂等重放（崩溃后恢复 archive+live，重复恢复无副作用）', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  const live = await store.writeAtomic('chain.ndjson', 'old-live\n');
  const archive = store.path('chain-archive-2026.ndjson');
  const writes = [{ path: archive, content: 'archived\n' }, { path: live, content: 'new-live\n' }];
  await store.writeAtomic('chain.ndjson.pending', JSON.stringify(writes));
  await store.withFileLock('chain.ndjson', () => store.recover('chain.ndjson'));
  assert.equal(readFileSync(live, 'utf8'), 'new-live\n');
  await store.withFileLock('chain.ndjson', () => store.recover('chain.ndjson'));
  assert.equal(readFileSync(live, 'utf8'), 'new-live\n');
  assert.equal(readFileSync(archive, 'utf8'), 'archived\n');
  assert.equal(existsSync(record(cwd, 'chain.ndjson.pending')), false);
  // transaction 一步完成 journal+替换
  await store.transaction('chain.ndjson', [{ path: archive, content: 'archived2\n' }, { path: live, content: 'via-transaction\n' }]);
  assert.equal(readFileSync(live, 'utf8'), 'via-transaction\n');
  assert.equal(readFileSync(archive, 'utf8'), 'archived2\n');
});

test('workspaceStore: 并发读写不出现半截内容（rename 原子性，崩溃不截断）', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  const a = 'A'.repeat(200000);
  const b = 'B'.repeat(200000);
  await store.writeAtomic('big.txt', a);
  let done = false;
  const writer = (async () => {
    for (let index = 0; index < 8; index += 1) await store.writeAtomic('big.txt', index % 2 === 0 ? b : a);
    done = true;
  })();
  let reads = 0;
  while (!done) {
    const text = readFileSync(store.path('big.txt'), 'utf8');
    assert.ok(text === a || text === b, 'reader observed partial content: ' + text.length);
    reads += 1;
    await sleep(0);
  }
  await writer;
  assert.ok(reads > 0);
});

// ── 异步锁（M-20：退避等待不阻塞事件循环；超时/上限；陈旧回收）────────────
test('M-20: 写锁争用为异步退避——等待期间事件循环照常运行（无 Atomics.wait 同步睡眠）', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  const order = [];
  const holder = store.withFileLock('race.md', async () => { await sleep(120); order.push('lock-released'); });
  await sleep(10);
  const timer = sleep(20).then(() => order.push('timer'));
  const second = store.withFileLock('race.md', () => order.push('second-acquired'));
  await Promise.all([holder, timer, second]);
  assert.deepEqual(order, ['timer', 'lock-released', 'second-acquired'], '等待锁时 timer 必须先触发（事件循环未被阻塞）');
  // 实现层面不得再有同步睡眠
  const source = readFileSync(new URL('../lib/storage.js', import.meta.url), 'utf8');
  assert.equal(/Atomics\.wait/.test(source), false, 'storage.js 不得使用 Atomics.wait');
});

test('write lock: waitMs 上限 1000ms、活锁永不抢占；死 pid/残缺旧锁可回收', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  const path = store.path('locked.md');
  // 活持有者（本进程）→ 等待方超时；waitMs 传更大值也被钳制到上限 1000ms
  let release;
  const holder = store.withFileLock('locked.md', () => new Promise((resolve) => { release = resolve; }));
  await sleep(20);
  const started = Date.now();
  await assert.rejects(store.withFileLock('locked.md', () => {}, { waitMs: 5000 }), /lock timeout/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, 'waitMs 上限 1000ms（实测 ' + elapsed + 'ms）');
  release();
  await holder;
  // 死 pid → 立即回收（不需要等 mtime 老化）
  writeFileSync(path + '.lock', JSON.stringify({ pid: 2147483647, at: 0 }));
  assert.equal(await store.withFileLock('locked.md', () => 'taken-over'), 'taken-over');
  assert.equal(existsSync(path + '.lock'), false);
  // 残缺锁：新鲜 → 等待超时；老化（>staleMs）→ 回收
  writeFileSync(path + '.lock', '{"pid":');
  await assert.rejects(store.withFileLock('locked.md', () => {}, { waitMs: 60 }), /lock timeout/);
  const old = new Date(Date.now() - 60000);
  utimesSync(path + '.lock', old, old);
  assert.equal(await store.withFileLock('locked.md', () => 'stale-malformed-taken'), 'stale-malformed-taken');
  // 符号链接锁拒绝
  writeFileSync(join(cwd, 'victim'), 'untouched');
  symlinkSync(join(cwd, 'victim'), path + '.lock');
  await assert.rejects(store.withFileLock('locked.md', () => {}), /symbolic link/);
  assert.equal(readFileSync(join(cwd, 'victim'), 'utf8'), 'untouched');
});

test('write lock: 持有者进程崩溃（SIGKILL）后锁可回收，后继写不挂起', async () => {
  const cwd = fresh();
  const storageUrl = new URL('../lib/storage.js', import.meta.url).href;
  const script = 'import { workspaceStore } from ' + JSON.stringify(storageUrl) + ';'
    + ' const store = workspaceStore(' + JSON.stringify(cwd) + ');'
    + ' store.withFileLock("crash.md", () => { process.kill(process.pid, "SIGKILL"); });';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  const store = workspaceStore(cwd);
  assert.equal(await store.withFileLock('crash.md', () => 'recovered', { waitMs: 500 }), 'recovered');
  assert.equal(existsSync(store.path('crash.md.lock')), false);
});

// ── hostStore（~/.dsh 私有数据：fsync+rename，无跨进程锁）──────────────────
test('hostStore: 原子写任意宿主路径（自动建目录、无 tmp 残留、持久内容完整）', () => {
  const cwd = fresh();
  const file = join(cwd, 'data', 'dsh-context-relay', 'panel.json');
  const host = hostStore();
  assert.equal(host.writeAtomic(file, '{"schemaVersion":2,"sessions":{}}'), file);
  assert.equal(readFileSync(file, 'utf8'), '{"schemaVersion":2,"sessions":{}}');
  assert.deepEqual(readdirSync(join(cwd, 'data', 'dsh-context-relay')), ['panel.json']);
  host.writeAtomic(file, '{"schemaVersion":2,"sessions":{"a":{}}}');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.a !== undefined, true);
  assert.throws(() => host.writeAtomic('', 'x'), /host file path required/);
  assert.equal(storagePath(cwd, record(cwd, 'x.md')), record(cwd, 'x.md'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertNoCredentials, atomicStorageReplace, storagePath, workspaceStore } from '../lib/storage.js';
import { writeWorkspaceFile } from '../lib/agent/shared.js';
import { appendChainEntry, CHAIN_MAX_BYTES, formatChainPointers, readChain, readChainArchive } from '../lib/agent/chain.js';
import { appendLedger, readLedger, readLedgerArchive, readRoster, writeCheckpoint, writeRoster } from '../lib/agent/team.js';
import { lessonsArchivePath, lessonsPath, loadLessons, recordLessons, saveLessons } from '../lib/lessons.js';
const fresh = () => mkdtempSync(join(tmpdir(), 'relay-v081-'));
const record = (cwd, name) => join(cwd, '.scratch', 'context-relay', name);
const lines = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const child = async (script) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; p.stderr.on('data', (chunk) => { err += chunk; });
  const [code] = await once(p, 'exit'); assert.equal(code, 0, err);
};

test('storage: legacy sync lock is gone (no Atomics.wait / no shared.js re-export)', async () => {
  const shared = await import('../lib/agent/shared.js');
  assert.equal(shared.withStorageLock, undefined);
  assert.equal(shared.writeStorageFile, undefined);
  for (const file of ['../lib/agent/shared.js', '../lib/agent/chain.js', '../lib/agent/team.js', '../lib/lessons.js']) {
    assert.equal(/Atomics\.wait/.test(readFileSync(new URL(file, import.meta.url), 'utf8')), false, file + ' 不得使用 Atomics.wait');
  }
});

test('storage: traversal and parent/final symlinks reject before external writes', async () => {
  const cwd = fresh(), outside = fresh();
  await assert.rejects(() => writeWorkspaceFile(cwd, '../../../escape.md', 'safe'), /outside/);
  mkdirSync(join(cwd, '.scratch'));
  symlinkSync(outside, record(cwd, ''));
  for (const write of [() => writeWorkspaceFile(cwd, 'brief.md', 'safe'), () => appendChainEntry(cwd, {sessionId:'s'}), () => writeCheckpoint(cwd,'w1','safe'), () => writeRoster(cwd, {version:1}), () => appendLedger(cwd,'w1',{note:'safe'})]) await assert.rejects(write, /symbolic link|outside/);
  assert.equal((await saveLessons(cwd, [])).ok, false);
  assert.equal(readdirSync(outside).length, 0);
  const clean = fresh(); await writeWorkspaceFile(clean, 'ok.md', 'old');
  writeFileSync(join(outside, 'target'), 'untouched');
  symlinkSync(join(outside, 'target'), record(clean, 'linked.md'));
  await assert.rejects(() => writeWorkspaceFile(clean,'linked.md','bad'), /symbolic link/);
  assert.equal(readFileSync(join(outside,'target'),'utf8'),'untouched');
});

test('storage: concurrent writers serialize through the async lock (no lost updates)', async () => {
  const cwd = fresh();
  const store = workspaceStore(cwd);
  await Promise.all([
    appendChainEntry(cwd, { sessionId: 'c1' }),
    appendChainEntry(cwd, { sessionId: 'c2' }),
    appendLedger(cwd, 'w1', { sessionId: 'l1' }),
    appendLedger(cwd, 'w1', { sessionId: 'l2' }),
    recordLessons(cwd, [{ tag: 't', text: '并发经验 A', evidence: 'e:1' }]),
    recordLessons(cwd, [{ tag: 't', text: '并发经验 B', evidence: 'e:2' }]),
  ]);
  assert.deepEqual(readChain(cwd).map((entry) => entry.sessionId).sort(), ['c1', 'c2']);
  assert.deepEqual(readLedger(cwd, 'w1').map((entry) => entry.sessionId).sort(), ['l1', 'l2']);
  assert.deepEqual(loadLessons(cwd).map((entry) => entry.text).sort(), ['并发经验 A', '并发经验 B']);
  assert.deepEqual(readdirSync(record(cwd, '')).filter((name) => name.endsWith('.lock') || name.includes('.tmp-')), []);
  assert.ok(existsSync(store.path('chain.ndjson')));
});

test('storage: conservative credential detection covers every writer without echo', async () => {
  for (const secret of ['token=abcdefghijklmnop', 'api_key: abcdefghijklmnop', 'password="hunter-secret"', '-----BEGIN RSA PRIVATE KEY-----', 'Bearer abcdefghijklmnopqrst', 'sk-' + 'x'.repeat(24)]) {
    const cwd = fresh();
    assert.throws(() => assertNoCredentials(secret), (e) => /credential/.test(e.message) && !e.message.includes(secret));
    for (const write of [() => writeWorkspaceFile(cwd,'brief.md',secret), () => writeCheckpoint(cwd,'w1',secret), () => appendChainEntry(cwd,{sessionId:'s',note:secret}), () => appendLedger(cwd,'w1',{note:secret}), () => writeRoster(cwd,{description:secret})]) await assert.rejects(write,/credential/);
    const out = await recordLessons(cwd,[{tag:'t',text:secret,evidence:'e:1'}]);
    assert.equal(out.saved,false); assert.match(out.error,/credential/);
    assert.equal(existsSync(lessonsArchivePath(cwd)),false);
  }
});

test('storage: atomic replacement cleans failure debris and detects stale revisions', async () => {
  const cwd = fresh(), store = workspaceStore(cwd);
  const path = await writeWorkspaceFile(cwd, 'brief.md', 'old');
  await assert.rejects(() => store.writeAtomic('brief.md', 'bad', { expected: 'stale' }), /revision conflict/);
  assert.equal(readFileSync(path, 'utf8'), 'old');
  const dir = record(cwd, 'occupied'); mkdirSync(dir);
  await assert.rejects(() => store.writeAtomic('occupied', 'new'));
  assert.deepEqual(readdirSync(record(cwd, '')).filter((x) => x.includes('.tmp-') || x.endsWith('.lock')), []);
  writeFileSync(path + '.tmp-dead', 'partial');
  await store.writeAtomic('brief.md', 'new', { expected: 'old' });
  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.equal(existsSync(path + '.tmp-dead'), false);
  const a = readRoster(cwd), b = readRoster(cwd);
  await writeRoster(cwd, a);
  await assert.rejects(() => writeRoster(cwd, b), /revision conflict/);
});

test('storage: stale dead locks recover; live owners never get stolen', async () => {
  const cwd = fresh(), store = workspaceStore(cwd);
  const path = storagePath(cwd, record(cwd, 'lock-target'));
  writeFileSync(path + '.lock', JSON.stringify({ pid: 2147483647 }));
  const old = new Date(Date.now() - 60000); utimesSync(path + '.lock', old, old);
  assert.equal(await store.withFileLock('lock-target', () => 42), 42);
  let release;
  const holder = store.withFileLock('lock-target', () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(() => store.withFileLock('lock-target', () => {}, { waitMs: 60 }), /lock timeout/);
  release(); await holder;
  assert.equal(existsSync(path + '.lock'), false);
});

test('storage: redo journal recovers interrupted archive/live rename idempotently', async () => {
  const cwd = fresh(), store = workspaceStore(cwd);
  const path = await writeWorkspaceFile(cwd, 'chain.ndjson', 'old-live\n');
  const archive = record(cwd, 'chain-archive-2026.ndjson');
  const writes = [{ path: archive, content: 'archived\n' }, { path, content: 'new-live\n' }];
  await store.writeAtomic('chain.ndjson.pending', JSON.stringify(writes));
  await atomicStorageReplace(cwd, archive, 'archived\n');
  await store.withFileLock('chain.ndjson', () => store.recover('chain.ndjson'));
  assert.equal(readFileSync(path, 'utf8'), 'new-live\n');
  await store.withFileLock('chain.ndjson', () => store.recover('chain.ndjson'));
  assert.equal(readFileSync(archive, 'utf8'), 'archived\n');
  assert.equal(existsSync(record(cwd, 'chain.ndjson.pending')), false);
  const blocked = record(cwd, 'blocked'); mkdirSync(blocked);
  await assert.rejects(() => store.withFileLock('chain.ndjson', () => store.applyWrites('chain.ndjson', [{ path: blocked, content: 'bad' }, { path, content: 'later' }])), /EISDIR|ENOTEMPTY|illegal operation/i);
  assert.equal(readFileSync(path, 'utf8'), 'new-live\n');
});

test('storage: process death leaves recoverable journal and stale lock, not half output', async () => {
  const cwd = fresh(), store = workspaceStore(cwd);
  const path = await writeWorkspaceFile(cwd, 'crash-live', 'old');
  const archive = record(cwd, 'crash-archive');
  const storageUrl = new URL('../lib/storage.js', import.meta.url).href;
  const writes = [{ path: archive, content: 'complete archive' }, { path, content: 'complete live' }];
  const script = 'import { workspaceStore, atomicStorageReplace } from ' + JSON.stringify(storageUrl) + '; const cwd = ' + JSON.stringify(cwd) + '; const store = workspaceStore(cwd); store.withFileLock("crash-live", () => { atomicStorageReplace(cwd, ' + JSON.stringify(path + '.pending') + ', ' + JSON.stringify(JSON.stringify(writes)) + '); atomicStorageReplace(cwd, ' + JSON.stringify(archive) + ', "complete archive"); process.kill(process.pid, "SIGKILL"); });';
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const [code, signal] = await once(p, 'exit'); assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  await store.withFileLock('crash-live', () => store.recover('crash-live'));
  assert.equal(readFileSync(path, 'utf8'), 'complete live');
  assert.equal(readFileSync(archive, 'utf8'), 'complete archive');
  assert.equal(existsSync(record(cwd, 'crash-live.pending')), false);
  assert.equal(existsSync(record(cwd, 'crash-live.lock')), false);
});

test('chain: full long pointers survive live, byte overflow and archive', async () => {
  const cwd = fresh();
  const input = {sessionId:'session-' + 's'.repeat(400),parentSessionId:'p'.repeat(300),childSessionId:'c'.repeat(300),handoffPath:'dir with spaces/'.repeat(70)+'h.md',briefPath:'b'.repeat(500)};
  await appendChainEntry(cwd, input);
  for (const key of Object.keys(input)) assert.equal(readChain(cwd)[0][key], input[key]);
  assert.ok(formatChainPointers(readChain(cwd))[0].length <= 200);
  const huge = {sessionId:'huge',handoffPath:'h'.repeat(CHAIN_MAX_BYTES + 1)};
  await appendChainEntry(cwd, huge);
  const all = [...readChainArchive(cwd, 1000), ...readChain(cwd, 1000)];
  assert.equal(all.find((x) => x.sessionId === 'huge').handoffPath, huge.handoffPath);
  assert.equal(all.find((x) => x.sessionId === input.sessionId).handoffPath, input.handoffPath);
});

test('lessons: exact full inputs archive before limits and survive later eviction', async () => {
  const cwd = fresh();
  const incoming = Array.from({length:8},(_,i)=>({tag:'Long Tag '+i,text:('body '+i+' ·\n').repeat(100),evidence:('evidence '+i+'\n').repeat(60),extra:{i}}));
  const result = await recordLessons(cwd, incoming); assert.equal(result.saved, true);
  assert.equal(loadLessons(cwd).length, 3);
  assert.deepEqual(lines(lessonsArchivePath(cwd)).map((x) => x.original), incoming);
  for (let i = 0; i < 45; i += 1) assert.equal((await recordLessons(cwd,[{tag:'t',text:'later '+i,evidence:'e:'+i}])).saved, true);
  assert.deepEqual(lines(lessonsArchivePath(cwd)).filter((x) => x.original?.extra).map((x) => x.original), incoming);
  const failing = fresh(); storagePath(failing, lessonsArchivePath(failing)); mkdirSync(lessonsArchivePath(failing));
  assert.equal((await recordLessons(failing,incoming)).saved, false);
  assert.equal(existsSync(lessonsPath(failing)), false);
});

test('storage: multiple processes append and rotate chain/ledger/lessons without loss', async () => {
  const cwd = fresh();
  const chain = new URL('../lib/agent/chain.js', import.meta.url).href;
  const team = new URL('../lib/agent/team.js', import.meta.url).href;
  const lessons = new URL('../lib/lessons.js', import.meta.url).href;
  await Promise.all(Array.from({length:3},(_,w)=>child(
    'import {appendChainEntry} from ' + JSON.stringify(chain) + '; import {appendLedger} from ' + JSON.stringify(team) + '; import {recordLessons} from ' + JSON.stringify(lessons) + '; const cwd=' + JSON.stringify(cwd) + ';'
    + ' const pause = () => new Promise((resolve) => setTimeout(resolve, 20));'
    + ' async function retry(action) { for (let attempt = 0; attempt < 40; attempt += 1) { try { const out = await action(); if (out?.saved === false && /lock timeout/.test(String(out.error))) { await pause(); continue; } return out; } catch (error) { if (!/lock timeout/.test(String(error?.message))) throw error; await pause(); } } throw new Error("lock retries exhausted"); }'
    + ' for (let i = 0; i < 35; i += 1) { const id = ' + JSON.stringify('worker-' + w + '-') + ' + i; await retry(() => appendChainEntry(cwd, {sessionId:id})); await retry(() => appendLedger(cwd, "w1", {sessionId:id, note:"n".repeat(100)})); const out = await retry(() => recordLessons(cwd,[{tag:"t",text:id,evidence:"e:1"}])); if (out.saved !== true) throw new Error(JSON.stringify(out)); }'
  )));
  const chainAll = [...readChain(cwd, 1000), ...readChainArchive(cwd, 1000)];
  const ledgerAll = [...readLedger(cwd, 'w1', 1000), ...readLedgerArchive(cwd, 'w1', 1000)];
  for (const items of [chainAll, ledgerAll]) { assert.equal(items.length, 105); assert.equal(new Set(items.map((x) => x.sessionId)).size, 105); }
  const originals = lines(lessonsArchivePath(cwd)).filter((x) => x.original).map((x) => x.original.text);
  assert.equal(originals.length, 105); assert.equal(new Set(originals).size, 105);
  assert.ok(readChainArchive(cwd, 1000).length > 0, '3 进程并发下 chain 仍按上限旋转且不丢');
  assert.equal(readdirSync(record(cwd, '')).some((x) => x.endsWith('.lock') || x.endsWith('.pending') || x.includes('.tmp-')), false);
});

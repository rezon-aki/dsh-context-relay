import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { assertNoCredentials, atomicStorageReplace, recoverStorageTransaction, storagePath, storageTransaction, withStorageLock, writeStorageFile, writeWorkspaceFile } from '../lib/agent/shared.js';
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

test('storage: traversal and parent/final symlinks reject before external writes', () => {
  const cwd = fresh(), outside = fresh();
  assert.throws(() => writeWorkspaceFile(cwd, '../../../escape.md', 'safe'), /outside/);
  mkdirSync(join(cwd, '.scratch'));
  symlinkSync(outside, record(cwd, ''));
  for (const write of [() => writeWorkspaceFile(cwd, 'brief.md', 'safe'), () => appendChainEntry(cwd, {sessionId:'s'}), () => writeCheckpoint(cwd,'w1','safe'), () => writeRoster(cwd, {version:1}), () => appendLedger(cwd,'w1',{note:'safe'})]) assert.throws(write, /symbolic link/);
  assert.equal(saveLessons(cwd, []).ok, false);
  assert.equal(readdirSync(outside).length, 0);
  const clean = fresh(); writeWorkspaceFile(clean, 'ok.md', 'old');
  writeFileSync(join(outside, 'target'), 'untouched');
  symlinkSync(join(outside, 'target'), record(clean, 'linked.md'));
  assert.throws(() => writeWorkspaceFile(clean,'linked.md','bad'), /symbolic link/);
  assert.equal(readFileSync(join(outside,'target'),'utf8'),'untouched');
});

test('storage: legitimate lock release between lstat and realpath does not reject a contender', (t) => {
  const cwd=fresh(), path=storagePath(cwd,record(cwd,'racing'));
  const targets=[path,lessonsPath(cwd),record(cwd,'chain.ndjson'),record(cwd,'team/w1/ledger.ndjson')];
  const locks=new Set(targets.map((target)=>storagePath(cwd,target+'.lock')));
  for(const lock of locks) writeFileSync(lock,JSON.stringify({pid:process.pid}));
  const realpath=fs.realpathSync;
  const released=new Set();
  const probe=t.mock.method(fs,'realpathSync',function(target,...args) {
    if(locks.has(target) && !released.has(target)) { released.add(target); fs.unlinkSync(target); }
    return realpath(target,...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(withStorageLock(cwd,path,()=>42),42);
    assert.equal(recordLessons(cwd,[{tag:'t',text:'kept exactly',evidence:'e:1'}]).saved,true);
    appendChainEntry(cwd,{sessionId:'kept-chain'});
    appendLedger(cwd,'w1',{sessionId:'kept-ledger'});
    assert.equal(released.size,locks.size,'each writer must exercise disappearance between validation syscalls');
    for(const lock of locks) assert.equal(existsSync(lock),false);
    assert.equal(loadLessons(cwd)[0].text,'kept exactly');
    assert.equal(lines(lessonsArchivePath(cwd))[0].original.text,'kept exactly');
    assert.equal(readChain(cwd)[0].sessionId,'kept-chain');
    assert.equal(readLedger(cwd,'w1')[0].sessionId,'kept-ledger');
  } finally { probe.mock.restore(); syncBuiltinESMExports(); }
});

test('storage: conservative credential detection covers every writer without echo', () => {
  for (const secret of ['token=abcdefghijklmnop', 'api_key: abcdefghijklmnop', 'password="hunter-secret"', '-----BEGIN RSA PRIVATE KEY-----', 'Bearer abcdefghijklmnopqrst', 'sk-' + 'x'.repeat(24)]) {
    const cwd = fresh();
    assert.throws(() => assertNoCredentials(secret), (e) => /credential/.test(e.message) && !e.message.includes(secret));
    for (const write of [() => writeWorkspaceFile(cwd,'brief.md',secret), () => writeCheckpoint(cwd,'w1',secret), () => appendChainEntry(cwd,{sessionId:'s',note:secret}), () => appendLedger(cwd,'w1',{note:secret}), () => writeRoster(cwd,{description:secret})]) assert.throws(write,/credential/);
    const out = recordLessons(cwd,[{tag:'t',text:secret,evidence:'e:1'}]);
    assert.equal(out.saved,false); assert.match(out.error,/credential/);
    assert.equal(existsSync(lessonsArchivePath(cwd)),false);
  }
});

test('storage: atomic replacement cleans failure debris and detects stale revisions', () => {
  const cwd = fresh(), path = writeWorkspaceFile(cwd,'brief.md','old');
  assert.throws(() => writeStorageFile(cwd,path,'bad',{expected:'stale'}),/revision conflict/);
  assert.equal(readFileSync(path,'utf8'),'old');
  const dir = record(cwd,'occupied'); mkdirSync(dir);
  assert.throws(() => writeStorageFile(cwd,dir,'new'));
  assert.deepEqual(readdirSync(record(cwd,'')).filter(x => x.includes('.tmp-') || x.endsWith('.lock')), []);
  writeFileSync(path+'.tmp-dead','partial');
  writeStorageFile(cwd,path,'new',{expected:'old'});
  assert.equal(readFileSync(path,'utf8'),'new'); assert.equal(existsSync(path+'.tmp-dead'),false);
  const a = readRoster(cwd), b = readRoster(cwd);
  writeRoster(cwd,a);
  assert.throws(()=>writeRoster(cwd,b),/revision conflict/);
});

test('storage: stale dead locks recover; live owners never get stolen', () => {
  const cwd=fresh(), path=storagePath(cwd,record(cwd,'lock-target'));
  writeFileSync(path+'.lock',JSON.stringify({pid:2147483647}));
  const old=new Date(Date.now()-60000); utimesSync(path+'.lock',old,old);
  assert.equal(withStorageLock(cwd,path,()=>42),42);
  withStorageLock(cwd,path,()=>assert.throws(()=>withStorageLock(cwd,path,()=>{}, {timeoutMs:20,staleMs:0}),/lock timeout/));
  assert.equal(existsSync(path+'.lock'),false);
});

test('storage: redo journal recovers interrupted archive/live rename idempotently', () => {
  const cwd=fresh(), path=writeWorkspaceFile(cwd,'chain.ndjson','old-live\n');
  const archive=record(cwd,'chain-archive-2026.ndjson');
  const writes=[{path:archive,content:'archived\n'},{path,content:'new-live\n'}];
  atomicStorageReplace(cwd,path+'.pending',JSON.stringify(writes));
  atomicStorageReplace(cwd,archive,'archived\n');
  withStorageLock(cwd,path,()=>recoverStorageTransaction(cwd,path));
  assert.equal(readFileSync(path,'utf8'),'new-live\n');
  withStorageLock(cwd,path,()=>recoverStorageTransaction(cwd,path));
  assert.equal(readFileSync(archive,'utf8'),'archived\n'); assert.equal(existsSync(path+'.pending'),false);
  const blocked=record(cwd,'blocked'); mkdirSync(blocked);
  assert.throws(()=>withStorageLock(cwd,path,()=>storageTransaction(cwd,path,[{path:blocked,content:'bad'},{path,content:'later'}])));
  assert.equal(readFileSync(path,'utf8'),'new-live\n');
});

test('storage: process death leaves recoverable journal and stale lock, not half output', async () => {
  const cwd=fresh(), path=writeWorkspaceFile(cwd,'crash-live','old');
  const archive=record(cwd,'crash-archive');
  const shared=new URL('../lib/agent/shared.js',import.meta.url).href;
  const writes=[{path:archive,content:'complete archive'},{path,content:'complete live'}];
  const script='import {withStorageLock,atomicStorageReplace} from '+JSON.stringify(shared)+'; withStorageLock('+JSON.stringify(cwd)+','+JSON.stringify(path)+',()=>{atomicStorageReplace('+JSON.stringify(cwd)+','+JSON.stringify(path+'.pending')+','+JSON.stringify(JSON.stringify(writes))+'); atomicStorageReplace('+JSON.stringify(cwd)+','+JSON.stringify(archive)+',"complete archive"); process.kill(process.pid,"SIGKILL");});';
  const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
  const [code,signal]=await once(p,'exit'); assert.equal(code,null); assert.equal(signal,'SIGKILL');
  const old=new Date(Date.now()-60000); utimesSync(path+'.lock',old,old);
  withStorageLock(cwd,path,()=>recoverStorageTransaction(cwd,path));
  assert.equal(readFileSync(path,'utf8'),'complete live');
  assert.equal(readFileSync(archive,'utf8'),'complete archive');
  assert.equal(existsSync(path+'.pending'),false); assert.equal(existsSync(path+'.lock'),false);
});

test('chain: full long pointers survive live, byte overflow and archive', () => {
  const cwd=fresh();
  const input={sessionId:'session-'+ 's'.repeat(400),parentSessionId:'p'.repeat(300),childSessionId:'c'.repeat(300),handoffPath:'dir with spaces/'.repeat(70)+'h.md',briefPath:'b'.repeat(500)};
  appendChainEntry(cwd,input);
  for(const key of Object.keys(input)) assert.equal(readChain(cwd)[0][key],input[key]);
  assert.ok(formatChainPointers(readChain(cwd))[0].length<=200);
  const huge={sessionId:'huge',handoffPath:'h'.repeat(CHAIN_MAX_BYTES+1)};
  appendChainEntry(cwd,huge);
  const all=[...readChainArchive(cwd,1000),...readChain(cwd,1000)];
  assert.equal(all.find(x=>x.sessionId==='huge').handoffPath,huge.handoffPath);
  assert.equal(all.find(x=>x.sessionId===input.sessionId).handoffPath,input.handoffPath);
});

test('lessons: exact full inputs archive before limits and survive later eviction', () => {
  const cwd=fresh();
  const incoming=Array.from({length:8},(_,i)=>({tag:'Long Tag '+i,text:('body '+i+' ·\n').repeat(100),evidence:('evidence '+i+'\n').repeat(60),extra:{i}}));
  const result=recordLessons(cwd,incoming); assert.equal(result.saved,true);
  assert.equal(loadLessons(cwd).length,3);
  assert.deepEqual(lines(lessonsArchivePath(cwd)).map(x=>x.original),incoming);
  for(let i=0;i<45;i++) assert.equal(recordLessons(cwd,[{tag:'t',text:'later '+i,evidence:'e:'+i}]).saved,true);
  assert.deepEqual(lines(lessonsArchivePath(cwd)).filter(x=>x.original?.extra).map(x=>x.original),incoming);
  const failing=fresh(); storagePath(failing,lessonsArchivePath(failing)); mkdirSync(lessonsArchivePath(failing));
  assert.equal(recordLessons(failing,incoming).saved,false);
  assert.equal(existsSync(lessonsPath(failing)),false);
});

test('storage: multiple processes append and rotate chain/ledger/lessons without loss', async () => {
  const cwd=fresh();
  const chain=new URL('../lib/agent/chain.js',import.meta.url).href;
  const team=new URL('../lib/agent/team.js',import.meta.url).href;
  const lessons=new URL('../lib/lessons.js',import.meta.url).href;
  await Promise.all(Array.from({length:4},(_,w)=>child(
    'import {appendChainEntry} from '+JSON.stringify(chain)+'; import {appendLedger} from '+JSON.stringify(team)+'; import {recordLessons} from '+JSON.stringify(lessons)+'; const cwd='+JSON.stringify(cwd)+'; for(let i=0;i<35;i++){ const id='+JSON.stringify('worker-'+w+'-')+'+i; appendChainEntry(cwd,{sessionId:id}); appendLedger(cwd,"w1",{sessionId:id,note:"n".repeat(100)}); const out=recordLessons(cwd,[{tag:"t",text:id,evidence:"e:1"}]); if(!out.saved) throw new Error(JSON.stringify(out)); }'
  )));
  const chainAll=[...readChain(cwd,1000),...readChainArchive(cwd,1000)];
  const ledgerAll=[...readLedger(cwd,'w1',1000),...readLedgerArchive(cwd,'w1',1000)];
  for(const items of [chainAll,ledgerAll]) {assert.equal(items.length,140); assert.equal(new Set(items.map(x=>x.sessionId)).size,140);}
  const originals=lines(lessonsArchivePath(cwd)).filter(x=>x.original).map(x=>x.original.text);
  assert.equal(originals.length,140); assert.equal(new Set(originals).size,140);
  assert.equal(readdirSync(record(cwd,'')).some(x=>x.endsWith('.lock')||x.endsWith('.pending')||x.includes('.tmp-')),false);
});

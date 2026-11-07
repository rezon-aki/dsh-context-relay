import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAIN_MAX_ENTRIES,
  CHAIN_RELATIVE,
  appendChainEntry,
  buildRecallSection,
  chainPathOf,
  formatChainPointers,
  normalizeChainEntry,
  readChain,
  workspaceRelativePath,
} from '../lib/agent/chain.js';

function tmpCwd() { return mkdtempSync(join(tmpdir(), 'relay-chain-')); }

test('appendChainEntry writes bounded ndjson; readChain returns newest', () => {
  const cwd = tmpCwd();
  const out = appendChainEntry(cwd, { kind: 'compaction', sessionId: 'session-a', phase: 'build', goal: 'g1', compactionId: 'c1', shadowedStart: 10, shadowedEnd: 20, freedTokens: 100, briefPath: 'b.md' });
  assert.equal(out.relativePath, CHAIN_RELATIVE);
  assert.equal(out.entries, 1);
  const entries = readChain(cwd, 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'compaction');
  assert.equal(entries[0].sessionId, 'session-a');
  assert.equal(entries[0].shadowedStart, 10);
  assert.equal(entries[0].shadowedEnd, 20);
  appendChainEntry(cwd, { kind: 'handoff', sessionId: 'session-a', childSessionId: 'session-b', handoffPath: 'h.md' });
  const all = readChain(cwd, 10);
  assert.equal(all.length, 2);
  assert.equal(all[1].childSessionId, 'session-b');
});

test('appendChainEntry keeps entries and bytes bounded (drops oldest)', () => {
  const cwd = tmpCwd();
  for (let i = 0; i < CHAIN_MAX_ENTRIES + 20; i += 1) {
    appendChainEntry(cwd, { kind: 'compaction', sessionId: 'session-' + i, shadowedStart: i, shadowedEnd: i + 1 });
  }
  const entries = readChain(cwd, CHAIN_MAX_ENTRIES + 50);
  assert.equal(entries.length, CHAIN_MAX_ENTRIES);
  assert.equal(entries[entries.length - 1].sessionId, 'session-' + (CHAIN_MAX_ENTRIES + 19));
});

test('readChain tolerates corrupt lines and missing file', () => {
  const cwd = tmpCwd();
  assert.deepEqual(readChain(cwd), []);
  const path = chainPathOf(cwd);
  mkdirSync(join(cwd, '.scratch', 'context-relay'), { recursive: true });
  writeFileSync(path, 'not-json\n{"kind":"handoff","sessionId":"s1"}\n', 'utf8');
  const entries = readChain(cwd);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 's1');
});

test('normalizeChainEntry clips fields; bad seq/kind degrade safely', () => {
  const entry = normalizeChainEntry({ kind: 'nope', sessionId: 'x'.repeat(200), phase: 'build', shadowedStart: -5, shadowedEnd: 1.5, freedTokens: 10 });
  assert.equal(entry.kind, 'compaction');
  assert.ok(entry.sessionId.length <= 80);
  assert.equal(entry.shadowedStart, undefined);
  assert.equal(entry.shadowedEnd, undefined);
  assert.equal(entry.freedTokens, 10);
});

test('formatChainPointers renders session + shadow seq + handoff path', () => {
  const lines = formatChainPointers([
    { kind: 'handoff', sessionId: 'session-old', childSessionId: 'session-new', handoffPath: 'h.md', goal: 'old goal' },
    { kind: 'compaction', sessionId: 'session-x', shadowedStart: 5, shadowedEnd: 9 },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /session-old/);
  assert.match(lines[0], /session-new/);
  assert.match(lines[1], /seq 5–9/);
});

test('buildRecallSection includes session, shadow range, pointers (discipline lives in protocol); bounded', () => {
  const section = buildRecallSection({
    sessionId: 'session-x',
    compaction: { compactionId: 'c1', shadowedStart: 10, shadowedEnd: 20, freedTokens: 99 },
    entries: [{ kind: 'handoff', sessionId: 'session-old', handoffPath: 'h.md' }],
    briefPath: '.scratch/context-relay/brief.md',
  });
  assert.match(section, /压缩与链式召回/);
  assert.match(section, /session-x/);
  assert.match(section, /seq 10–20/);
  assert.match(section, /session-old/);
  // 召回纪律（session_event_read / ≤3 条 / 全文检索）在常驻协议，注入段不重复。
  assert.doesNotMatch(section, /召回规则/);
  assert.doesNotMatch(section, /session_event_read/);
  assert.ok(section.length <= 900);
});

test('buildRecallSection 默认上限 900 字符：历史指针很多时截断且有界', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    kind: 'handoff',
    sessionId: 'session-old-' + index,
    childSessionId: 'session-new-' + index,
    handoffPath: '.scratch/context-relay/handoff-' + index + '.md',
    goal: 'g'.repeat(100),
  }));
  const section = buildRecallSection({
    sessionId: 'session-x',
    compaction: { shadowedStart: 0, shadowedEnd: 999, freedTokens: 12345 },
    entries,
    briefPath: '.scratch/context-relay/brief.md',
  });
  assert.ok(section.length <= 900, 'section length ' + section.length);
  assert.match(section, /压缩与链式召回/);
});

test('workspaceRelativePath: workspace files relative, outside paths kept', () => {
  const cwd = '/tmp/ws';
  assert.equal(workspaceRelativePath(cwd, '/tmp/ws/.scratch/context-relay/a.md'), '.scratch/context-relay/a.md');
  assert.equal(workspaceRelativePath(cwd, '/etc/passwd'), '/etc/passwd');
});

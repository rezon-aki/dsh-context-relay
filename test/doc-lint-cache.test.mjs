/**
 * P1-4 回归：doc_lint 昂贵检查的缓存键必须含 paths/maxBytes 与文档 stat（内容变即失效）。
 * 旧键只看 AGENTS.md + relay 目录 mtime，改文档内容会 10 分钟内返回陈旧 lint。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDocLint } from '../lib/agent/shared.js';

function tmpWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-lint-cache-'));
  mkdirSync(join(cwd, '.scratch', 'context-relay', 'docs'), { recursive: true });
  writeFileSync(join(cwd, 'AGENTS.md'), '# workspace\n');
  writeFileSync(join(cwd, '.scratch', 'context-relay', 'docs', 'a.md'), '# A\n');
  return cwd;
}

test('P1-4 doc_lint 缓存键：paths/maxBytes/文档 stat 变化都失效', () => {
  const cwd = tmpWorkspace();
  const opts = { sessionDocs: true };
  const first = runDocLint(cwd, [], 1024, opts);
  assert.notEqual(first.cached, true, '首次运行不命中缓存');
  assert.equal(runDocLint(cwd, [], 1024, opts).cached, true, '同文档/参数 10 分钟内命中');

  // 只改文档内容（不新建/不删目录）：目录 mtime 不变，必须靠文件 stat 失效。
  writeFileSync(join(cwd, '.scratch', 'context-relay', 'docs', 'a.md'), '# A changed\n');
  assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, '文档内容变 → 缓存失效');

  // paths 进缓存键：不同 paths 不得复用（旧键探针 paths:['missing.md'] 返回旧结果）。
  assert.notEqual(runDocLint(cwd, ['AGENTS.md'], 1024, opts).cached, true, 'paths 不同 → 新键');
  assert.equal(runDocLint(cwd, ['AGENTS.md'], 1024, opts).cached, true, '同 paths 命中');

  // maxBytes 进缓存键：输出预算不同不得复用。
  assert.notEqual(runDocLint(cwd, [], 2048, opts).cached, true, 'maxBytes 不同 → 新键');
  assert.equal(runDocLint(cwd, [], 2048, opts).cached, true, '同 maxBytes 命中');
});

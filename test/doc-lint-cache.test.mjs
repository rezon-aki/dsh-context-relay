/**
 * P1-4 回归：doc_lint 昂贵检查的缓存键必须含 paths/maxBytes 与文档 stat（内容变即失效）。
 * 旧键只看 AGENTS.md + relay 目录 mtime，改文档内容会 10 分钟内返回陈旧 lint。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('P1-4b L0（~/.dsh/AGENTS.md）内容进缓存键：改 L0 即失效', () => {
  const cwd = tmpWorkspace();
  const home = mkdtempSync(join(tmpdir(), 'relay-lint-home-'));
  mkdirSync(join(home, 'dsh'));
  writeFileSync(join(home, 'dsh', 'AGENTS.md'), '# L0\n');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(home, 'dsh');
  try {
    const opts = { sessionDocs: true };
    assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, '首次不命中');
    assert.equal(runDocLint(cwd, [], 1024, opts).cached, true, '同 L0 命中');
    writeFileSync(join(home, 'dsh', 'AGENTS.md'), '# L0 changed\n');
    assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, 'L0 内容变 → 缓存失效');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('P1-4b extraDocs 内容进缓存键：改部署级治理文档即失效', () => {
  const cwd = tmpWorkspace();
  writeFileSync(join(cwd, 'GOV.md'), '# GOV\n');
  const opts = { sessionDocs: true, extraDocs: ['GOV.md'] };
  assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, '首次不命中');
  assert.equal(runDocLint(cwd, [], 1024, opts).cached, true, '同 extraDocs/内容 命中');
  writeFileSync(join(cwd, 'GOV.md'), '# GOV changed\n');
  assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, 'extraDocs 内容变 → 缓存失效');
});

test('P1-4b paths 先 normalize/限 20：去重与第 21 条起不进键', () => {
  const cwd = tmpWorkspace();
  const opts = { sessionDocs: true };
  const many = Array.from({ length: 25 }, (_, i) => 'docs/p' + i + '.md');
  assert.notEqual(runDocLint(cwd, many, 1024, opts).cached, true, '首次不命中');
  assert.equal(runDocLint(cwd, [...many, 'docs/never.md'], 1024, opts).cached, true, '第 21 条起不进键');
  assert.equal(runDocLint(cwd, [...many, ...many], 1024, opts).cached, true, '重复项去重后同键');
  assert.notEqual(runDocLint(cwd, ['missing.md'], 1024, opts).cached, true, '归一化后 paths 不同 → 新键');
});

test('P1-4b 越界 paths 不 stat（不读工作区外文件）', () => {
  const cwd = tmpWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'relay-lint-out-'));
  const outsideFile = join(outside, 'x.md');
  writeFileSync(outsideFile, '# x\n');
  const opts = { sessionDocs: true };
  assert.notEqual(runDocLint(cwd, [outsideFile], 1024, opts).cached, true, '首次不命中');
  assert.equal(runDocLint(cwd, [outsideFile], 1024, opts).cached, true, '同越界 paths 命中（未 stat）');
  writeFileSync(outsideFile, '# x changed\n');
  assert.equal(runDocLint(cwd, [outsideFile], 1024, opts).cached, true, '越界路径内容变不影响缓存键（docLint 直接拒绝）');
});

test('P1-4b relay md 超 4000 份：超限不缓存（不回放覆盖不全的旧结果）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-lint-many-'));
  const reports = join(cwd, '.scratch', 'context-relay', 'reports');
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(cwd, 'AGENTS.md'), '# workspace\n');
  for (let i = 0; i < 4001; i += 1) writeFileSync(join(reports, 'r' + String(i).padStart(5, '0') + '.md'), '# r\n');
  try {
    // sessionDocs 未开，避免 4k 份会话体检开销；缓存仍按默认口径启用（超限 → 不缓存）。
    const opts = { riskTier: 'T1' };
    assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, '超限首次不缓存');
    assert.notEqual(runDocLint(cwd, [], 1024, opts).cached, true, '超限再次也不复用');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

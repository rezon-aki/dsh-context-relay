import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseProgress, PROGRESS_LIMIT_BYTES, updateProgress } from '../lib/agent/progress.js';
import { workspaceStore } from '../lib/storage.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'relay-storage-progress-'));
const record = (cwd, name) => join(cwd, '.scratch', 'context-relay', name);
const progressPath = (cwd) => record(cwd, 'progress.md');
const readState = (cwd) => parseProgress(readFileSync(progressPath(cwd), 'utf8'));

// ── M-04/B-03：并发读-合并-写丢更新（锁内读-合并-写，不丢更新）──────────────
const writeWithRetry = async (cwd, update) => {
  // 写锁 waitMs 上限 1000ms（M-20：不阻塞宿主事件循环）→ 高争用下超时是显式错误、不是数据丢失；
  // 真实调用方（handoff）失败会显式报 progress-write-failed，这里按调用方语义重试。
  for (let attempt = 0; ; attempt += 1) {
    try { return await updateProgress(cwd, update); } catch (error) {
      if (!/lock timeout/.test(String(error?.message)) || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

test('progress 并发：并发 updateProgress 全部落账（20 路争用 + 显式超时重试，不丢更新）', async () => {
  const cwd = fresh();
  await updateProgress(cwd, { sessionId: 's0', phase: 'build', status: { goal: 'g' }, decisions: ['d0'], now: '2026-11-01T00:00:00.000Z' });
  const writers = 20;
  const results = await Promise.all(Array.from({ length: writers }, (_unused, index) => writeWithRetry(cwd, {
    sessionId: 's' + (index + 1),
    phase: 'build',
    status: { goal: 'g' },
    decisions: ['d' + (index + 1)],
    now: '2026-11-01T00:00:0' + (index % 10) + '.000Z',
  })));
  assert.equal(results.filter((result) => result.updated === true).length, writers);
  const state = readState(cwd);
  assert.equal(state.updates, writers + 1, '丢更新：updates=' + state.updates + '/' + (writers + 1));
  for (let index = 1; index <= writers; index += 1) assert.ok(state.decisions.includes('d' + index), '丢失 decision d' + index);
  // 文件始终完整可解析、不超 advisory 上限
  const raw = readFileSync(progressPath(cwd), 'utf8');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= PROGRESS_LIMIT_BYTES);
  assert.notEqual(parseProgress(raw), undefined);
});

test('progress 并发：6 路同时写（不重试）也在写锁 waitMs 内完成，无丢更新', async () => {
  const cwd = fresh();
  await updateProgress(cwd, { sessionId: 's0', phase: 'build', status: { goal: 'g' }, now: '2026-11-01T00:00:00.000Z' });
  const results = await Promise.all(Array.from({ length: 6 }, (_unused, index) => updateProgress(cwd, {
    sessionId: 'p' + (index + 1),
    phase: 'build',
    status: { goal: 'g' },
    evidence: ['e' + (index + 1)],
    now: '2026-11-01T00:00:0' + index + '.000Z',
  })));
  assert.equal(results.filter((result) => result.updated === true).length, 6);
  const state = readState(cwd);
  assert.equal(state.updates, 7);
  for (let index = 1; index <= 6; index += 1) assert.ok(state.evidence.includes('e' + index));
});

// ── 崩溃恢复：残留 redo journal 被重放（archive+主文件一致，不丢数据）────
test('progress 崩溃恢复：残留 redo journal 在下次交接重放，归档与主文件一致', async () => {
  const cwd = fresh();
  await updateProgress(cwd, { sessionId: 's1', phase: 'build', status: { goal: 'g' }, decisions: ['before'], now: '2026-11-01T00:00:00.000Z' });
  const store = workspaceStore(cwd);
  const previousRaw = readFileSync(progressPath(cwd), 'utf8');
  const archive = store.path('progress-archive-2026.md');
  // 模拟「journal 已落盘、替换尚未全部完成」的崩溃中间态
  await store.writeAtomic('progress.md.pending', JSON.stringify([
    { path: archive, content: '- history:decisions crash-archived\n' },
    { path: progressPath(cwd), content: previousRaw },
  ]));
  const result = await updateProgress(cwd, { sessionId: 's2', phase: 'verify', status: { goal: 'g' }, decisions: ['after'], now: '2026-11-02T00:00:00.000Z' });
  assert.equal(result.updated, true);
  assert.equal(existsSync(record(cwd, 'progress.md.pending')), false);
  assert.equal(existsSync(record(cwd, 'progress.md.lock')), false);
  const state = readState(cwd);
  assert.equal(state.updates, 2);
  assert.ok(state.decisions.includes('before'));
  assert.ok(state.decisions.includes('after'));
  assert.match(readFileSync(archive, 'utf8'), /crash-archived/);
});

// ── 进程崩溃：SIGKILL 留下的陈旧锁 + journal 可被下一次交接接管 ───────────
test('progress 崩溃恢复：SIGKILL 持有者残留的锁/journal 被下次 updateProgress 接管重放', async () => {
  const cwd = fresh();
  await updateProgress(cwd, { sessionId: 's1', phase: 'build', status: { goal: 'g' }, decisions: ['before'], now: '2026-11-01T00:00:00.000Z' });
  const storageUrl = new URL('../lib/storage.js', import.meta.url).href;
  const script = 'import { workspaceStore } from ' + JSON.stringify(storageUrl) + ';'
    + ' const cwd = ' + JSON.stringify(cwd) + ';'
    + ' const store = workspaceStore(cwd);'
    + ' const previous = store.readText("progress.md");'
    + ' store.withFileLock("progress.md", () => {'
    + '   store.replace("progress.md.pending", JSON.stringify([{ path: store.path("progress-archive-2026.md"), content: "- history:decisions killed" }, { path: store.path("progress.md"), content: previous }]));'
    + '   process.kill(process.pid, "SIGKILL");'
    + ' });';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(existsSync(record(cwd, 'progress.md.lock')), true, '崩溃应残留锁（模拟真实死锁场景）');
  const result = await updateProgress(cwd, { sessionId: 's2', phase: 'verify', status: { goal: 'g' }, decisions: ['after'], now: '2026-11-03T00:00:00.000Z' });
  assert.equal(result.updated, true);
  assert.equal(existsSync(record(cwd, 'progress.md.lock')), false);
  assert.equal(existsSync(record(cwd, 'progress.md.pending')), false);
  const state = readState(cwd);
  assert.equal(state.updates, 2);
  assert.ok(state.decisions.includes('before') && state.decisions.includes('after'));
  assert.match(readFileSync(record(cwd, 'progress-archive-2026.md'), 'utf8'), /killed/);
});

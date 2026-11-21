/**
 * dsh-context-relay — 落盘 dispatch 记录读写（v0.14 团队收尾）。
 *
 * dispatch 记录是 relay_collect 的新鲜度权威，也是 worker 侧「已开工（startedAt）/
 * 当前任务（itemId/dispatchId）」与事故绑定的唯一持久事实。本模块只做记录目录内的
 * 读/找/补丁写；路径派生在 delegation.js，业务守卫在 team-tools/sentinel。
 *
 * @module dsh-context-relay/agent/dispatch-records
 */
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELEGATION_DISPATCH_DIR } from './delegation.js';

/** 某个 Lead scope 的 dispatch 记录目录（scopeId 缺失 → undefined）。 */
export function dispatchScopeDirOf(cwd, scopeId) {
  if (typeof cwd !== 'string' || cwd === '' || typeof scopeId !== 'string' || scopeId === '') return undefined;
  return join(cwd, ...DELEGATION_DISPATCH_DIR.split('/'), scopeId);
}

/** 读一条记录（坏记录/不存在 → undefined，不抛）。 */
export function readDispatchRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
  } catch { return undefined; }
}

/** 列一个 scope 下的全部记录（[{path,record}]；读失败按空）。 */
export function listDispatchRecords(cwd, scopeId) {
  const dir = dispatchScopeDirOf(cwd, scopeId);
  if (dir === undefined || !existsSync(dir)) return [];
  const rows = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      const record = readDispatchRecord(path);
      if (record !== undefined) rows.push({ path, record });
    }
  } catch { /* 读失败按无记录 */ }
  return rows;
}

/** 按 dispatchId 找记录（找不到 → undefined）。 */
export function findDispatchRecordById(cwd, scopeId, dispatchId) {
  if (typeof dispatchId !== 'string' || dispatchId === '') return undefined;
  return listDispatchRecords(cwd, scopeId).find((row) => row.record.dispatchId === dispatchId);
}

/**
 * 找 worker 当前活跃 dispatch：优先按 workerSessionId（v2 记录），老记录缺失时按 worker 名；
 * itemIds 给定时只认这些台账分点（doing+owner），避免把已完成旧任务的记录当当前任务。
 * 多条命中取 at 最新（无 at 的记录排最后）。
 */
export function activeDispatchOf(cwd, scopeId, { sessionId, worker, itemIds } = {}) {
  const rows = listDispatchRecords(cwd, scopeId);
  const scoped = Array.isArray(itemIds) ? rows.filter((row) => itemIds.includes(row.record.itemId)) : rows;
  const bySession = scoped.filter((row) => typeof row.record.workerSessionId === 'string' && row.record.workerSessionId === sessionId && sessionId !== undefined);
  const pool = bySession.length > 0
    ? bySession
    : (typeof worker === 'string' && worker !== ''
      ? scoped.filter((row) => (row.record.workerSessionId === undefined || row.record.workerSessionId === null) && row.record.worker === worker)
      : []);
  if (pool.length === 0) return undefined;
  return pool.sort((left, right) => String(right.record.at ?? '').localeCompare(String(left.record.at ?? '')))[0];
}

/** 原子补丁一条记录（读-合并-temp+rename；失败返回 {ok:false}，不抛；并发读者不会看到半截）。 */
export function patchDispatchRecord(path, patch) {
  const record = readDispatchRecord(path);
  if (record === undefined || patch === null || typeof patch !== 'object') return { ok: false, error: 'dispatch record unreadable' };
  const temp = path + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const next = { ...record, ...patch };
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
    return { ok: true, record: next };
  } catch (error) {
    try { unlinkSync(temp); } catch { /* 已 rename/未创建 */ }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

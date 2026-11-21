/**
 * dsh-context-relay — 越线事故记录（v0.14 B/C/F4）。
 *
 * 任务一旦开工以完成为先：到 organize/relay 不再硬停，只记一条 incident（append-only NDJSON），
 * 供 relay_status 查询与后续校准。写盘失败 fail-open（不停任务）。
 * v0.14 团队收尾：补 worker/itemId/dispatchId 绑定、assessment/completed/finalBand 与 collect 结算。
 *
 * @module dsh-context-relay/agent/incidents
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { partitionRelativePath } from './team.js';

export const INCIDENT_LIMIT = 200;
const BANDS = new Set(['ok', 'warn', 'organize', 'relay', 'unknown']);
const EVENTS = new Set(['crossed', 'escalated', 'settled']);

export function incidentsRelativePath(leadSessionId) {
  return partitionRelativePath(leadSessionId, 'incidents.ndjson');
}

export function incidentsPathOf(cwd, leadSessionId) {
  return join(cwd, ...incidentsRelativePath(leadSessionId).split('/'));
}

/** 事故记录目录内的全部事件（坏行跳过；读失败 → []）。 */
export function readIncidentEntries(cwd, leadSessionId) {
  try {
    const path = incidentsPathOf(cwd, leadSessionId);
    if (!existsSync(path)) return [];
    const entries = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line);
        if (entry !== null && typeof entry === 'object') entries.push(entry);
      } catch { /* 坏行跳过 */ }
    }
    return entries;
  } catch { return []; }
}

/** 记录一条越线事故（best-effort；返回 {ok, path?, id?, error?}）。 */
export function recordIncident(cwd, input = {}) {
  const when = typeof input.at === 'string' && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  const entry = {
    version: 1,
    id: 'inc-' + randomUUID().slice(0, 8),
    at: when,
    event: EVENTS.has(input.event) ? input.event : 'crossed',
    leadSessionId: String(input.leadSessionId ?? ''),
    sessionId: String(input.sessionId ?? ''),
    worker: input.worker === undefined ? null : String(input.worker),
    itemId: input.itemId === undefined ? null : String(input.itemId),
    dispatchId: input.dispatchId === undefined ? null : String(input.dispatchId),
    phase: input.phase === undefined ? null : String(input.phase),
    band: BANDS.has(input.band) ? input.band : 'unknown',
    ratio: Number.isFinite(input.ratio) ? input.ratio : null,
    used: Number.isFinite(input.used) ? input.used : null,
    window: Number.isFinite(input.window) ? input.window : null,
    subagent: input.subagent === true,
    assessment: input.assessment !== null && typeof input.assessment === 'object' ? input.assessment : null,
    completed: typeof input.completed === 'boolean' ? input.completed : null,
    finalBand: BANDS.has(input.finalBand) ? input.finalBand : null,
    reason: input.reason === undefined ? null : String(input.reason),
  };
  if (entry.leadSessionId === '') return { ok: false, error: 'leadSessionId required' };
  try {
    const path = incidentsPathOf(cwd, entry.leadSessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
    return { ok: true, path: incidentsRelativePath(entry.leadSessionId), id: entry.id };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * collect 结算：同一 dispatch 的 crossed/escalated 之后补一条 settled（同 dispatch 只一次）。
 * 最近一条越线记录提供 band/ratio 作为 finalBand；completed 由回执 verdict 决定。
 * best-effort：无匹配事故/已结算 → {ok:true,skipped}；写盘失败 → {ok:false}。
 */
export function settleIncidents(cwd, leadSessionId, input = {}) {
  const dispatchId = typeof input.dispatchId === 'string' && input.dispatchId !== '' ? input.dispatchId : '';
  if (dispatchId === '') return { ok: true, skipped: 'no-dispatch-id' };
  const entries = readIncidentEntries(cwd, leadSessionId).filter((entry) => entry.dispatchId === dispatchId);
  if (entries.some((entry) => entry.event === 'settled')) return { ok: true, skipped: 'already-settled' };
  const crossing = entries.filter((entry) => entry.event === 'crossed' || entry.event === 'escalated');
  if (crossing.length === 0) return { ok: true, skipped: 'no-incident' };
  const last = crossing.at(-1);
  const settled = recordIncident(cwd, {
    event: 'settled',
    leadSessionId,
    sessionId: input.sessionId ?? last.sessionId,
    worker: input.worker ?? last.worker,
    itemId: input.itemId ?? last.itemId,
    dispatchId,
    phase: last.phase,
    band: last.band,
    ratio: last.ratio,
    used: last.used,
    window: last.window,
    subagent: last.subagent === true,
    assessment: input.assessment ?? null,
    completed: input.completed === true,
    finalBand: last.band,
    reason: input.reason === undefined ? null : String(input.reason),
  });
  return { ...settled, skipped: undefined };
}

/** 读最近事故（读盘永不抛；最多 INCIDENT_LIMIT 条，返回最近 limit 条）。 */
export function readIncidents(cwd, leadSessionId, { limit = 5 } = {}) {
  const relativePath = incidentsRelativePath(leadSessionId);
  const entries = readIncidentEntries(cwd, leadSessionId);
  if (entries.length === 0) return { exists: existsSync(incidentsPathOf(cwd, leadSessionId)), path: relativePath, count: 0, recent: [] };
  const capped = entries.slice(-INCIDENT_LIMIT);
  return { exists: true, path: relativePath, count: capped.length, recent: capped.slice(-Math.max(1, limit)) };
}

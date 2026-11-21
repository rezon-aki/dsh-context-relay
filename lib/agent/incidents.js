/**
 * dsh-context-relay — 越线事故记录（v0.14 B/C/F4）。
 *
 * 任务一旦开工以完成为先：到 organize/relay 不再硬停，只记一条 incident（append-only NDJSON），
 * 供 relay_status 查询与后续校准。写盘失败 fail-open（不停任务）。
 *
 * @module dsh-context-relay/agent/incidents
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { partitionRelativePath } from './team.js';

export const INCIDENT_LIMIT = 200;
const BANDS = new Set(['ok', 'warn', 'organize', 'relay', 'unknown']);

export function incidentsRelativePath(leadSessionId) {
  return partitionRelativePath(leadSessionId, 'incidents.ndjson');
}

export function incidentsPathOf(cwd, leadSessionId) {
  return join(cwd, ...incidentsRelativePath(leadSessionId).split('/'));
}

/** 记录一条越线事故（best-effort；返回 {ok, path?, id?, error?}）。 */
export function recordIncident(cwd, input = {}) {
  const entry = {
    version: 1,
    id: 'inc-' + randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    event: ['crossed', 'escalated', 'settled'].includes(input.event) ? input.event : 'crossed',
    leadSessionId: String(input.leadSessionId ?? ''),
    sessionId: String(input.sessionId ?? ''),
    worker: input.worker === undefined ? null : String(input.worker),
    dispatchId: input.dispatchId === undefined ? null : String(input.dispatchId),
    phase: input.phase === undefined ? null : String(input.phase),
    band: BANDS.has(input.band) ? input.band : 'unknown',
    ratio: Number.isFinite(input.ratio) ? input.ratio : null,
    used: Number.isFinite(input.used) ? input.used : null,
    window: Number.isFinite(input.window) ? input.window : null,
    subagent: input.subagent === true,
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

/** 读最近事故（读盘永不抛；最多 INCIDENT_LIMIT 条，返回最近 limit 条）。 */
export function readIncidents(cwd, leadSessionId, { limit = 5 } = {}) {
  const relativePath = incidentsRelativePath(leadSessionId);
  const empty = { exists: false, path: relativePath, count: 0, recent: [] };
  try {
    const path = incidentsPathOf(cwd, leadSessionId);
    if (!existsSync(path)) return empty;
    const rows = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const entries = [];
    for (const line of rows) {
      try { entries.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    const capped = entries.slice(-INCIDENT_LIMIT);
    return { exists: true, path: relativePath, count: capped.length, recent: capped.slice(-Math.max(1, limit)) };
  } catch {
    return empty;
  }
}

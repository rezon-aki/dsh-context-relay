/**
 * dsh-context-relay — 团队上下文快照（v0.6.3）。
 *
 * 「队友上下文管理不能靠 Lead 记」：队友到线（escalation）/Lead 体检（relay_team_status）/
 * phase 边界 triage 的结果落到 `.scratch/context-relay/team-context/<leadSessionId>.json`，
 * 由台账焦点行**事件驱动**地带出「队友待处理」——不看时间、不轮询、压缩后仍在。
 * phase 边界 relay_phase 在队友待处理且未写 team_note 时提醒（v0.7.0 起 warning，不拒绝）。
 *
 * 只依赖 node:fs / node:path；读盘永不抛，写盘原子（tmp + rename）。
 *
 * @module dsh-context-relay/agent/team-context
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicFileReplace } from '../storage.js';

export const TEAM_CONTEXT_DIR = Object.freeze(['.scratch', 'context-relay', 'team-context']);
/** 需要 Lead 决策的队友档位（与 phase 边界 triage 的 stale 口径一致）。 */
export const PENDING_BANDS = Object.freeze(['organize', 'relay', 'unknown']);
export const TEAM_CONTEXT_LIMITS = Object.freeze({ members: 20, note: 300, name: 64 });

const BAND_SET = new Set(['ok', 'warn', 'organize', 'relay', 'unknown']);
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nowIso = () => new Date().toISOString();

export function teamContextRelativePath(leadSessionId) {
  return TEAM_CONTEXT_DIR.concat([String(leadSessionId) + '.json']).join('/');
}

export function teamContextPathOf(cwd, leadSessionId) {
  return join(cwd, ...TEAM_CONTEXT_DIR, String(leadSessionId) + '.json');
}

function validScopeId(leadSessionId) {
  return typeof leadSessionId === 'string' && SCOPE_ID.test(leadSessionId);
}

function normalizeRow(row) {
  if (!isObject(row)) return null;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name === '' || name.length > TEAM_CONTEXT_LIMITS.name) return null;
  const band = BAND_SET.has(row.band) ? row.band : 'unknown';
  return { name, band, at: typeof row.at === 'string' ? row.at : nowIso() };
}

function emptyContext(leadSessionId) {
  return {
    exists: false,
    phase: null,
    rows: [],
    handled: [],
    pending: [],
    note: undefined,
    relativePath: validScopeId(leadSessionId) ? teamContextRelativePath(leadSessionId) : undefined,
  };
}

/** pending = 到线/读不到且「Lead 尚未在 phase 边界处理」的队友（handled 由 team_note 显式清除）。 */
function withPending(context) {
  const handled = Array.isArray(context.handled) ? context.handled : [];
  context.pending = context.rows.filter((row) => PENDING_BANDS.includes(row.band) && !handled.includes(row.name));
  return context;
}

/** 读快照：文件不存在/损坏/作用域非法 → 空快照（exists:false），永不抛。 */
export function readTeamContext(cwd, leadSessionId) {
  const context = emptyContext(leadSessionId);
  if (!validScopeId(leadSessionId) || typeof cwd !== 'string' || cwd === '') return context;
  const path = teamContextPathOf(cwd, leadSessionId);
  if (!existsSync(path)) return context;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return context; }
  if (!isObject(raw)) return context;
  context.exists = true;
  context.phase = typeof raw.phase === 'string' ? raw.phase : null;
  context.note = typeof raw.note === 'string' && raw.note !== '' ? raw.note : undefined;
  context.rows = (Array.isArray(raw.rows) ? raw.rows : []).map(normalizeRow).filter((row) => row !== null).slice(0, TEAM_CONTEXT_LIMITS.members);
  context.handled = (Array.isArray(raw.handled) ? raw.handled : []).filter((name) => typeof name === 'string');
  return withPending(context);
}

function write(cwd, leadSessionId, context) {
  if (!validScopeId(leadSessionId)) return false;
  const path = teamContextPathOf(cwd, leadSessionId);
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    phase: context.phase ?? null,
    rows: context.rows.slice(0, TEAM_CONTEXT_LIMITS.members),
    handled: (Array.isArray(context.handled) ? context.handled : []).slice(0, TEAM_CONTEXT_LIMITS.members),
    ...(context.note === undefined ? {} : { note: String(context.note).slice(0, TEAM_CONTEXT_LIMITS.note) }),
  };
  try {
    atomicFileReplace(path, JSON.stringify(payload, null, 2));
    return true;
  } catch { return false; }
}

/** 单行 upsert（队友 escalation / Lead 体检）：不清别人的行，保留其它队友的最新档位。 */
export function mergeTeamContext(cwd, leadSessionId, { name, band, phase } = {}) {
  const row = normalizeRow({ name, band });
  if (row === null) return { ok: false, code: 'invalid-row' };
  const context = readTeamContext(cwd, leadSessionId);
  const rows = context.rows.filter((item) => item.name !== row.name);
  rows.push(row);
  // 新 escalation = 新的待处理：清掉该名字的 handled 标记。
  const handled = (context.handled ?? []).filter((item) => item !== row.name);
  const written = write(cwd, leadSessionId, { phase: phase ?? context.phase, rows, handled });
  return written ? { ok: true, row, pending: withPending({ ...context, rows, handled }).pending.map((item) => item.name) } : { ok: false, code: 'write-failed' };
}

/** 全量替换（triage / 体检）：rows 是权威当前状态，pending 由 band 派生；note 记录处理结论。 */
export function replaceTeamContext(cwd, leadSessionId, { phase, rows = [], note, handled = [] } = {}) {
  const normalized = (Array.isArray(rows) ? rows : []).map(normalizeRow).filter((row) => row !== null).slice(0, TEAM_CONTEXT_LIMITS.members);
  const handledNames = Array.isArray(handled) ? handled.filter((name) => typeof name === 'string') : [];
  const written = write(cwd, leadSessionId, { phase, rows: normalized, note, handled: handledNames });
  return written ? { ok: true, rows: normalized, handled: handledNames, pending: withPending({ rows: normalized, handled: handledNames }).pending.map((row) => row.name) } : { ok: false, code: 'write-failed' };
}

/** 单行清除（队友 freshen/reset 成功后，它在 Lead 快照里不再是待处理）。 */
export function clearTeamContextRow(cwd, leadSessionId, name) {
  const context = readTeamContext(cwd, leadSessionId);
  if (context.exists !== true) return { ok: true, cleared: false };
  const rows = context.rows.filter((row) => row.name !== name);
  const handled = (context.handled ?? []).filter((item) => item !== name);
  if (rows.length === context.rows.length) return { ok: true, cleared: false };
  const written = write(cwd, leadSessionId, { phase: context.phase, rows, handled, note: context.note });
  return written ? { ok: true, cleared: true } : { ok: false, code: 'write-failed' };
}

/** 焦点行用的队友待处理摘要（'' = 没有待处理）；不按时间判断新鲜度——只看当前档位。 */
export function teamPendingText(context, limit = 4) {
  const pending = Array.isArray(context?.pending) ? context.pending : [];
  if (pending.length === 0) return '';
  const shown = pending.slice(0, limit).map((row) => row.name + '(' + row.band + ')').join('、');
  const omitted = pending.length > limit ? ' 等 ' + pending.length + ' 人' : '';
  return '队友待处理 ' + pending.length + '：' + shown + omitted;
}

/** 清空内存态（测试/卸载；本模块无内存态，保留对称接口）。 */
export function clearTeamContextMemory() {}

/**
 * dsh-context-relay — 队友保鲜核心（P0）：工作记录 / 代际 / 体检 / 换代 prompt。
 *
 * 纯逻辑 + workspace 文件 IO，不依赖 host context（便于单测）。记录位置（可选 leadSessionId 分区）：
 *   .scratch/context-relay/team/<leadSessionId>/roster.json            # 分区：当前 Lead 会话的 lineage / 代际权威
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/profile.md    # 长期职责（Lead 初始化）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/checkpoint.md # 最近一次结构化交接（队友写）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/ledger.ndjson # 代际/事件索引（live 有界）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/ledger-archive-<年份>.ndjson # 超界归档（不丢数据）
 *   .scratch/context-relay/team/<leadSessionId>/<lineage>/handoffs/gen-<n>.md # 换代时固化
 *   .scratch/context-relay/team/{roster.json,<lineage>/...}             # legacy（不传 leadSessionId 时的旧路径；跨分区只读回退）
 *
 * 约束：DSH 队友名字永久、不可复用；代际命名为 <lineage>-g<N>（lower-kebab）。
 *
 * @module dsh-context-relay/agent/team
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendStorageLine, assertNoCredentials, removeIfPresent, storagePath, workspaceStore } from '../storage.js';

/** team 记录根（workspace 相对目录）；与 handoff/progress 同属 .scratch/context-relay。 */
export const TEAM_DIR = Object.freeze(['.scratch', 'context-relay', 'team']);

/**
 * 记录/交接的建议上限（字节/条数，advisory）：v0.8.0 起只用于「提示 + prompt 渲染预算」，
 * 不再拒绝/截断/丢数据——checkpoint 落盘完整，ledger 超界最旧条目归档，换代 prompt 按优先级保留 + 指针。
 */
export const TEAM_LIMITS = Object.freeze({
  checkpointBytes: 4096,
  checkpointItems: 8,
  checkpointItemChars: 200,
  ledgerEntries: 200,
  ledgerBytes: 8192,
  promptBytes: 6000,
  profileBytes: 1024,
  /** retired.ndjson live 建议上限；超界最旧记录原样移入 retired-archive-<年份>.ndjson（不丢数据）。 */
  retiredBytes: 8192,
});

/** checkpoint 的列表字段（顺序即渲染顺序）。 */
export const CHECKPOINT_LISTS = Object.freeze(['done', 'decisions', 'evidence', 'constraints', 'next_actions', 'open_questions', 'failed_attempts', 'pointers']);

const CHECKPOINT_LABELS = Object.freeze({
  done: '完成',
  decisions: '决策',
  evidence: '证据',
  constraints: '约束',
  next_actions: '下一步',
  open_questions: '未决',
  failed_attempts: '失败尝试',
  pointers: '指针',
});

/** 换代默认使用的 subagent provider（官方 in-process spawn；见 dsh-subagent-spawn-in-process）。 */
export const TEAM_PROVIDER = 'spawn';

/** 固定小队默认上限（v0.11 P0-B；config squadMax 可上调，不写死）。 */
export const SQUAD_MAX_DEFAULT = 8;
/** squadMax 的防御上限（配置异常时不至于无限放行）。 */
export const SQUAD_MAX_CEILING = 32;

/** 分区 id 的合法字符集（leadSessionId / legacy 哨兵）：同时防路径穿越。 */
const PARTITION_ID = /^[A-Za-z0-9_-]+$/;

/** legacy 哨兵：'legacy' 映射到 <base>/ 根（partitionIdOf 把它当未分区）。 */
export const LEGACY_PARTITION_ID = 'legacy';

function partitionIdOf(leadSessionId) {
  if (leadSessionId === undefined || leadSessionId === null) return undefined;
  const id = String(leadSessionId).trim();
  if (id === '' || id === LEGACY_PARTITION_ID) return undefined; // legacy 哨兵 id = base 根
  if (!PARTITION_ID.test(id)) throw new Error('invalid partition id: ' + id);
  return id;
}

/** 记录根（base，workspace 相对）：与 handoff/progress 同属 .scratch/context-relay。 */
export function teamBaseOf(cwd) {
  return join(cwd, ...TEAM_DIR);
}

/** 记录根：带 leadSessionId → <base>/<sid>（分区）；不带（或 legacy 哨兵）→ base（legacy 旧行为）。 */
export function teamRootOf(cwd, leadSessionId) {
  const base = teamBaseOf(cwd);
  const id = partitionIdOf(leadSessionId);
  return id === undefined ? base : join(base, id);
}

export function teamRelativePath(...parts) {
  return TEAM_DIR.concat(parts).join('/');
}

/** teamRelativePath 的分区版：带 sid → .scratch/context-relay/team/<sid>/...；不带/legacy = 旧路径。 */
export function partitionRelativePath(leadSessionId, ...parts) {
  const id = partitionIdOf(leadSessionId);
  return id === undefined ? teamRelativePath(...parts) : teamRelativePath(id, ...parts);
}

/** 从队友名派生 lineage：w1-g2 → w1；无代际后缀则名字本身即 lineage。 */
export function lineageOf(name) {
  const text = String(name ?? '').trim();
  const match = text.match(/^(.*)-g(\d+)$/);
  return match === null ? text : match[1];
}

/** 从队友名取代际号；无后缀返回 1（首代默认）。 */
export function genOf(name) {
  const text = String(name ?? '').trim();
  const match = text.match(/^(.*)-g(\d+)$/);
  return match === null ? 1 : Math.max(1, Number(match[2]));
}

/** 下一个代际名：<lineage>-g<N>；跳过已被占用的名字。 */
export function nextGenName(lineage, usedNames = [], startGen = 0) {
  const base = String(lineage ?? '').trim();
  const used = new Set(Array.isArray(usedNames) ? usedNames.map((name) => String(name)) : []);
  let gen = Math.max(0, Math.trunc(startGen)) + 1;
  while (used.has(base + '-g' + gen)) gen += 1;
  return { name: base + '-g' + gen, gen };
}

/** 队友名合法性（与 DSH 0.2.2-rc.2 的 subagent 名字规则同口径，防 spawn 时才报错）。 */
export function isValidTeammateName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 32 && name !== 'lead' && /^[a-z][a-z0-9-]*$/.test(name);
}

export function clipText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// ── roster ─────────────────────────────────────────────────────────────

export function rosterPathOf(cwd, leadSessionId) {
  return join(teamRootOf(cwd, leadSessionId), 'roster.json');
}

export function emptyRoster() {
  return { version: 1, lineages: {} };
}

/** 防御式归一：旧/损坏文件不炸调用方；未知字段丢弃。 */
export function normalizeRoster(raw) {
  const roster = emptyRoster();
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return roster;
  const lineages = raw.lineages;
  if (lineages === undefined || lineages === null || typeof lineages !== 'object' || Array.isArray(lineages)) return roster;
  for (const [lineage, entry] of Object.entries(lineages)) {
    if (typeof lineage !== 'string' || lineage === '' || entry === null || typeof entry !== 'object') continue;
    const profile = entry.profile !== null && typeof entry.profile === 'object' ? entry.profile : {};
    const generations = Array.isArray(entry.generations) ? entry.generations : [];
    const cleanGenerations = [];
    for (const item of generations) {
      if (item === null || typeof item !== 'object') continue;
      const gen = Number.isInteger(item.gen) && item.gen > 0 ? item.gen : undefined;
      const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined;
      if (gen === undefined || name === undefined) continue;
      cleanGenerations.push({
        gen,
        name,
        sessionId: typeof item.sessionId === 'string' && item.sessionId !== '' ? item.sessionId : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        retiredAt: typeof item.retiredAt === 'string' ? item.retiredAt : undefined,
        reason: typeof item.reason === 'string' ? item.reason : undefined,
      });
    }
    roster.lineages[lineage] = {
      profile: {
        role: typeof profile.role === 'string' ? profile.role : '',
        description: typeof profile.description === 'string' ? profile.description : '',
        writeScopes: Array.isArray(profile.writeScopes) ? profile.writeScopes.filter((scope) => typeof scope === 'string') : [],
        createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : undefined,
      },
      generations: cleanGenerations,
      activeGen: Number.isInteger(entry.activeGen) && entry.activeGen > 0 ? entry.activeGen : (cleanGenerations.length > 0 ? cleanGenerations[cleanGenerations.length - 1].gen : 0),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
    };
  }
  return roster;
}

const ROSTER_REVISIONS = new WeakMap();
function parseRosterFile(path) {
  const text = readText(path);
  let roster;
  try { roster = text === undefined ? emptyRoster() : normalizeRoster(JSON.parse(text)); }
  catch { roster = emptyRoster(); }
  ROSTER_REVISIONS.set(roster, { path, text });
  return roster;
}

/** 精确读某个记录根（无回退）：记录根精确读取 / 分区扫描用。 */

/** 读 roster：先 <base>/<sid>/，文件不存在回退 legacy；都没有 = 空 roster。 */
export function readRoster(cwd, leadSessionId) {
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const path = rosterPathOf(cwd, id);
    if (existsSync(path)) return parseRosterFile(path);
    const roster = parseRosterFile(rosterPathOf(cwd));
    ROSTER_REVISIONS.set(roster, { path, text: undefined });
    return roster;
  }
  return parseRosterFile(rosterPathOf(cwd));
}

/** 写 roster（workspaceStore 异步写锁 + 基于最近读快照的乐观锁；revision conflict 抛错）。 */
export async function writeRoster(cwd, roster, leadSessionId) {
  const root = teamRootOf(cwd, leadSessionId);
  const path = join(root, 'roster.json');
  const revision = ROSTER_REVISIONS.get(roster);
  const text = JSON.stringify(roster);
  await workspaceStore(cwd).writeAtomic(path, text, revision?.path === path ? { expected: revision.text } : {});
  ROSTER_REVISIONS.set(roster, { path, text });
  return path;
}

/**
 * 确保 roster 里有该 lineage，并登记（或更新）一个代际。返回 lineage entry。
 * seed: { name?, sessionId?, gen?, role?, description?, writeScopes? }
 */
export function ensureLineage(roster, lineage, seed = {}) {
  const key = String(lineage ?? '').trim();
  if (key === '') throw new Error('lineage required');
  if (roster.lineages[key] === undefined) {
    roster.lineages[key] = {
      profile: {
        role: typeof seed.role === 'string' ? seed.role : '',
        description: typeof seed.description === 'string' ? seed.description : '',
        writeScopes: Array.isArray(seed.writeScopes) ? seed.writeScopes.filter((scope) => typeof scope === 'string').slice(0, 16) : [],
        createdAt: new Date().toISOString(),
      },
      generations: [],
      activeGen: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  const entry = roster.lineages[key];
  if (typeof seed.role === 'string' && seed.role !== '' && entry.profile.role === '') entry.profile.role = seed.role;
  if (typeof seed.description === 'string' && seed.description !== '' && entry.profile.description === '') entry.profile.description = seed.description;
  const name = typeof seed.name === 'string' && seed.name !== '' ? seed.name : undefined;
  if (name !== undefined) {
    const gen = Number.isInteger(seed.gen) && seed.gen > 0 ? seed.gen : genOf(name);
    let generation = entry.generations.find((item) => item.name === name);
    if (generation === undefined) {
      generation = { gen, name, sessionId: undefined, createdAt: new Date().toISOString(), retiredAt: undefined, reason: undefined };
      entry.generations.push(generation);
    }
    if (typeof seed.sessionId === 'string' && seed.sessionId !== '') generation.sessionId = seed.sessionId;
    if (generation.retiredAt === undefined) entry.activeGen = Math.max(entry.activeGen, generation.gen);
  }
  entry.updatedAt = new Date().toISOString();
  return entry;
}

/** 该 lineage 已用过的代际名（换代查重）。 */
export function usedNamesOf(entry) {
  return Array.isArray(entry?.generations) ? entry.generations.map((item) => item.name) : [];
}

/** roster 里所有已退休代的名字（rc.2 catalog 会永久保留旧代，状态/派活必须过滤）。 */
export function retiredNamesOf(roster) {
  const names = new Set();
  for (const entry of Object.values(roster?.lineages ?? {})) {
    for (const generation of entry?.generations ?? []) {
      if (generation?.retiredAt !== undefined && typeof generation.name === 'string') names.add(generation.name);
    }
  }
  return names;
}

/** 过滤掉已退休代，只留当前可派活的成员（roster 未登记的成员按活跃处理）。 */
export function activeMembersOf(roster, members) {
  const retired = retiredNamesOf(roster);
  return (Array.isArray(members) ? members : []).filter((member) => typeof member?.name === 'string' && !retired.has(member.name));
}

/** 标记某个代际退休（不删除记录，审计保留）。 */
export function retireGeneration(entry, name, reason) {
  const generation = Array.isArray(entry?.generations) ? entry.generations.find((item) => item.name === name) : undefined;
  if (generation === undefined) return false;
  generation.retiredAt = new Date().toISOString();
  generation.reason = clipText(reason, 200);
  entry.updatedAt = new Date().toISOString();
  return true;
}

// ── 小队视图（v0.11 P0-B）────────────────────────────────────────────────

/** roster 里出现过的全部代际名（含退休代）；用于区分 legacy（从未登记）。 */
export function rosterGenerationNames(roster) {
  const names = new Set();
  for (const entry of Object.values(roster?.lineages ?? {})) {
    for (const generation of entry?.generations ?? []) {
      if (typeof generation?.name === 'string') names.add(generation.name);
    }
  }
  return names;
}

/**
 * squad（当前小队）= catalog 成员中命中某 lineage 的 activeGen、且该代未退休者。
 * 单一判据；调用点不得再各自 filter（team_status/relay_status/派活/闸门共用）。
 */
export function squadMembersOf(roster, members) {
  const names = new Set();
  for (const entry of Object.values(roster?.lineages ?? {})) {
    const active = Array.isArray(entry?.generations) ? entry.generations.find((generation) => generation?.gen === entry?.activeGen) : undefined;
    if (active !== undefined && active.retiredAt === undefined && typeof active.name === 'string') names.add(active.name);
  }
  return (Array.isArray(members) ? members : []).filter((member) => typeof member?.name === 'string' && names.has(member.name));
}

/**
 * legacy（历史成员）= catalog 里存在、但 roster 中从未登记过的名字。
 * retiredNames：已退役记录（roster 退休代 + retired.ndjson 归档）——批量退役的 legacy 不再计为 legacy。
 */
export function legacyMembersOf(roster, members, retiredNames = []) {
  const known = rosterGenerationNames(roster);
  const retired = retiredNames instanceof Set ? retiredNames : new Set(Array.isArray(retiredNames) ? retiredNames : []);
  return (Array.isArray(members) ? members : []).filter((member) => typeof member?.name === 'string' && !known.has(member.name) && !retired.has(member.name));
}

/** 小队计数视图：{squad,squadMax,legacy,retired,overCap}（所有展示面共用）。 */
export function squadSummaryOf(roster, members, { squadMax = SQUAD_MAX_DEFAULT, retiredRecords = [] } = {}) {
  const retired = new Set(retiredNamesOf(roster));
  for (const record of Array.isArray(retiredRecords) ? retiredRecords : []) {
    if (typeof record?.name === 'string') retired.add(record.name);
  }
  const squad = squadMembersOf(roster, members).length;
  const legacy = legacyMembersOf(roster, members, retired).length;
  return { squad, squadMax, legacy, retired: retired.size, overCap: squad > squadMax };
}

/**
 * adopt：把 legacy 成员纳入小队（ensureLineage 写 profile/activeGen；幂等；受 squadMax 限制）。
 * 不写盘——调用方拿返回结果后统一 writeRoster。
 */
export function adoptMembers(roster, members, names, { squadMax = SQUAD_MAX_DEFAULT } = {}) {
  const list = Array.isArray(members) ? members : [];
  const byName = new Map(list.filter((member) => typeof member?.name === 'string').map((member) => [member.name, member]));
  const requested = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim();
    if (name !== '' && !requested.includes(name)) requested.push(name);
  }
  const adopted = [];
  const skipped = [];
  const overCap = [];
  let squadCount = squadMembersOf(roster, list).length;
  for (const name of requested) {
    const member = byName.get(name);
    if (member === undefined) { skipped.push({ name, reason: 'not-found' }); continue; }
    const lineage = lineageOf(name);
    const entry = roster.lineages?.[lineage];
    const known = Array.isArray(entry?.generations) ? entry.generations.find((generation) => generation.name === name) : undefined;
    if (known !== undefined) { skipped.push({ name, reason: 'already-known' }); continue; }
    const active = Array.isArray(entry?.generations) ? entry.generations.find((generation) => generation.gen === entry.activeGen) : undefined;
    if (active !== undefined && active.retiredAt === undefined) { skipped.push({ name, reason: 'lineage-active' }); continue; }
    if (squadCount >= squadMax) { overCap.push({ name, reason: 'squad-full' }); continue; }
    ensureLineage(roster, lineage, {
      name,
      sessionId: member.id,
      role: typeof member.role === 'string' ? member.role : '',
      description: typeof member.description === 'string' ? member.description : '',
    });
    adopted.push({ name, lineage, sessionId: member.id });
    squadCount += 1;
  }
  return { adopted, skipped, overCap };
}

// ── 文件路径 ───────────────────────────────────────────────────────────

export function lineageDirOf(cwd, lineage, leadSessionId) {
  return join(teamRootOf(cwd, leadSessionId), lineage);
}

export function profilePathOf(cwd, lineage, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'profile.md');
}

export function checkpointPathOf(cwd, lineage, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'checkpoint.md');
}

export function ledgerPathOf(cwd, lineage, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'ledger.ndjson');
}

/** ledger 超界归档文件前缀：ledger-archive-<年份>.ndjson（live 有界，归档不裁剪）。 */
export const LEDGER_ARCHIVE_PREFIX = 'ledger-archive-';

/** 归档文件路径（ledger-archive-<年份>.ndjson；年份默认今年）。 */
export function ledgerArchivePathOf(cwd, lineage, year = new Date().getFullYear(), leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), LEDGER_ARCHIVE_PREFIX + String(year) + '.ndjson');
}

export function handoffPathOf(cwd, lineage, gen, leadSessionId) {
  return join(lineageDirOf(cwd, lineage, leadSessionId), 'handoffs', 'gen-' + gen + '.md');
}

/** 退役归档前缀：retired-archive-<年份>.ndjson（与 ledger 归档同口径）。 */
export const RETIRED_ARCHIVE_PREFIX = 'retired-archive-';

/** 退役记录 live 文件：<teamRoot>/retired.ndjson（legacy 批量退役 + 显式 retire 的紧凑流水）。 */
export function retiredPathOf(cwd, leadSessionId) {
  return join(teamRootOf(cwd, leadSessionId), 'retired.ndjson');
}

/** 退役记录归档路径（retired-archive-<年份>.ndjson）。 */
export function retiredArchivePathOf(cwd, year = new Date().getFullYear(), leadSessionId) {
  return join(teamRootOf(cwd, leadSessionId), RETIRED_ARCHIVE_PREFIX + String(year) + '.ndjson');
}

// ── checkpoint ─────────────────────────────────────────────────────────

function readCheckpointIn(root, lineage) {
  const path = join(root, lineage, 'checkpoint.md');
  if (!existsSync(path)) return undefined;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  const text = readText(path);
  if (text === undefined || text.trim() === '') return undefined;
  return { path, text, bytes: byteLength(text), updatedAt: new Date(stats.mtimeMs).toISOString() };
}

/** 精确读某个记录根的 checkpoint（无回退）。 */

/** 读 checkpoint：先 <base>/<sid>/<lineage>/，文件缺失回退 legacy。 */
export function readCheckpoint(cwd, lineage, leadSessionId) {
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const found = readCheckpointIn(teamRootOf(cwd, id), lineage);
    if (found !== undefined) return found;
  }
  return readCheckpointIn(teamBaseOf(cwd), lineage);
}

/** 归一文本：折叠空白 + 去首尾，不截断（v0.8.0：写盘内容完整）。 */
function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 换代 prompt 里 checkpoint 各段的保留优先级（小 = 先保留）。
 * 身份/任务（preamble，0）> 结论 > 决策 > 证据 > 约束 > 未决 > 下一步 > 完成 > 失败尝试 > 指针。
 */
const CHECKPOINT_SECTION_PRIORITY = Object.freeze({
  一行结论: 1,
  决策: 2,
  证据: 3,
  约束: 4,
  未决: 5,
  下一步: 6,
  完成: 7,
  失败尝试: 8,
  指针: 9,
});

/** 把 checkpoint markdown 拆成带优先级的整段（不切段内文本；preamble = 身份/任务）。 */
function prioritizedCheckpointSections(markdown) {
  const text = String(markdown ?? '').trim();
  if (text === '') return [];
  return text.split(/\n(?=## )/).map((chunk, index) => {
    const section = chunk.trim();
    const firstLine = section.split('\n', 1)[0];
    const label = /^## /.test(firstLine) ? firstLine.replace(/^##\s*/, '').trim() : '';
    const priority = label === '' ? (index === 0 ? 0 : 100 + index) : (CHECKPOINT_SECTION_PRIORITY[label] ?? 100 + index);
    return { index, priority, text: section };
  }).sort((left, right) => left.priority - right.priority || left.index - right.index);
}

/**
 * checkpoint 的有界「prompt 渲染」出口（v0.8.0）：完整正文永远落盘（writeCheckpoint），
 * prompt 侧超 maxBytes 时按优先级保留整段 + 显式 marker + 完整记录指针，绝不切段内文本。
 */
export function renderCheckpointForPrompt(markdown, { maxBytes = TEAM_LIMITS.checkpointBytes, pointer = '<记录目录>/checkpoint.md' } = {}) {
  const text = String(markdown ?? '').trim();
  if (text === '') return '';
  if (byteLength(text) <= maxBytes) return text + '\n';
  const marker = '[checkpoint 超建议体积（>' + maxBytes + 'B）：以下按优先级保留；完整 checkpoint 见 ' + pointer + ']';
  const compose = (parts) => (parts.length === 0 ? marker : parts.join('\n\n') + '\n\n' + marker) + '\n';
  const selected = [];
  for (const section of prioritizedCheckpointSections(text)) {
    if (byteLength(compose(selected.concat(section.text))) > maxBytes) break;
    selected.push(section.text);
  }
  return compose(selected);
}

/**
 * 归一 checkpoint 输入并渲染 markdown（v0.8.0：写盘完整——不截断、不丢条目）。
 * 返回 { ok:true, markdown(=full), full, promptText(有界 prompt 渲染), caps } 或 { ok:false, code, error }。
 * caps 只作建议（advisory）：truncated 恒 false（保留字段兼容旧调用方），over 表示是否超建议体积。
 */
export function buildCheckpointMarkdown({ lineage, name, gen, input = {}, now = new Date() } = {}) {
  const oneLine = normalizeText(input.one_line);
  if (oneLine === '') return { ok: false, code: 'checkpoint-empty', error: 'one_line required' };
  const kind = clipText(input.kind ?? 'task', 24) || 'task';
  const taskId = clipText(input.task_id, 80);
  const lists = {};
  let items = 0;
  for (const field of CHECKPOINT_LISTS) {
    const raw = Array.isArray(input[field]) ? input[field] : [];
    const clean = [];
    for (const item of raw) {
      const text = normalizeText(item);
      if (text === '') continue;
      clean.push(text); // 不按 checkpointItems/checkpointItemChars 裁剪：落盘完整
    }
    lists[field] = clean;
    items += clean.length;
  }
  const lines = [
    '# 队友交接 · ' + String(name ?? '?') + '（' + String(lineage ?? '?') + ' 第 ' + String(gen ?? '?') + ' 代）',
    '> updated: ' + now.toISOString(),
    '> kind: ' + kind + (taskId === '' ? '' : ' · task: ' + taskId),
    '',
    '## 一行结论',
    oneLine,
  ];
  for (const field of CHECKPOINT_LISTS) {
    if (lists[field].length === 0) continue;
    lines.push('', '## ' + CHECKPOINT_LABELS[field]);
    for (const item of lists[field]) lines.push('- ' + item);
  }
  const markdown = lines.join('\n') + '\n';
  const bytes = byteLength(markdown);
  return {
    ok: true,
    markdown, // 完整内容：writeCheckpoint 原样落盘
    full: markdown,
    promptText: renderCheckpointForPrompt(markdown), // 有界摘要：给 prompt 用（完整内容在文件里）
    caps: { bytes, items, limitBytes: TEAM_LIMITS.checkpointBytes, truncated: false, over: bytes > TEAM_LIMITS.checkpointBytes },
  };
}

/** 写 checkpoint（workspaceStore 异步写锁 + 原子替换；完整落盘，不截断）。 */
export async function writeCheckpoint(cwd, lineage, markdown, leadSessionId) {
  // 兼容旧调用（字符串）与 buildCheckpointMarkdown 结果对象（取完整 full/markdown）。
  const text = typeof markdown === 'string' ? markdown : String(markdown?.full ?? markdown?.markdown ?? '');
  const path = checkpointPathOf(cwd, lineage, leadSessionId);
  await workspaceStore(cwd).writeAtomic(path, text); // 完整落盘，不截断（上限只作建议，见 TEAM_LIMITS）
  const bytes = byteLength(text);
  return { path, bytes, over: bytes > TEAM_LIMITS.checkpointBytes };
}

/**
 * 换代时把当前 checkpoint 固化为 handoffs/gen-<n>.md，并清掉 latest checkpoint。
 * 只读自己（legacy 或不带 sid 时的 base）的记录根：legacy 只读回退，绝不搬移/删除旧分区文件。
 */
export async function archiveCheckpoint(cwd, lineage, gen, leadSessionId) {
  const root = teamRootOf(cwd, leadSessionId);
  const store = workspaceStore(cwd);
  const latest = checkpointPathOf(cwd, lineage, leadSessionId);
  return store.withFileLock(latest, async () => {
    // 读：分区优先、缺失回退 legacy（升级前记录也能换代固化）；写：一律写当前分区 handoffs/。
    let current = readCheckpointIn(root, lineage);
    if (current === undefined && leadSessionId !== undefined) current = readCheckpointIn(teamBaseOf(cwd), lineage);
    if (current === undefined) return undefined;
    const path = join(root, lineage, 'handoffs', 'gen-' + gen + '.md');
    await store.writeAtomic(path, current.text);
    // 只清当前分区的 latest；legacy 记录只读，绝不搬移/删除旧分区文件。
    if (current.path === latest) {
      try { removeIfPresent(storagePath(cwd, current.path)); } catch { /* 清 latest 失败不阻断换代 */ }
    }
    return { path, bytes: current.bytes };
  });
}

function readProfileIn(root, lineage) {
  const text = readText(join(root, lineage, 'profile.md'));
  return text === undefined || text.trim() === '' ? undefined : text;
}

/** 精确读某个记录根的 profile（无回退）。 */

/** 读 profile：先 <base>/<sid>/<lineage>/，文件缺失/空文件回退 legacy。 */
export function readProfile(cwd, lineage, leadSessionId) {
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const text = readProfileIn(teamRootOf(cwd, id), lineage);
    if (text !== undefined) return text;
  }
  return readProfileIn(teamBaseOf(cwd), lineage);
}

// ── ledger ─────────────────────────────────────────────────────────────

function parseLedgerFile(path) {
  const text = readText(path);
  if (text === undefined) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); } catch { /* 损坏行跳过（记录不阻断） */ }
  }
  return entries;
}

function readLedgerIn(root, lineage, limit = 20) {
  return parseLedgerFile(join(root, lineage, 'ledger.ndjson')).slice(-Math.max(1, limit));
}

/** 精确读某个记录根的 ledger（无回退）。 */

/**
 * 读 ledger：先 <base>/<sid>/<lineage>/，无记录回退 legacy。
 * 第三参可为 limit（数字，旧签名）或 leadSessionId（字符串，便捷写法）。
 */
export function readLedger(cwd, lineage, limit = 20, leadSessionId) {
  if (typeof limit === 'string') {
    leadSessionId = limit;
    limit = 20;
  }
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const entries = readLedgerIn(teamRootOf(cwd, id), lineage, limit);
    if (entries.length > 0) return entries;
  }
  return readLedgerIn(teamBaseOf(cwd), lineage, limit);
}

/** 读归档（只读 ledger-archive-*.ndjson；多文件按名升序拼接，坏行/坏文件跳过）。 */
function readLedgerArchiveIn(root, lineage, limit) {
  const dir = join(root, lineage);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const files = names.filter((name) => name.startsWith(LEDGER_ARCHIVE_PREFIX) && name.endsWith('.ndjson')).sort();
  const entries = [];
  for (const name of files) entries.push(...parseLedgerFile(join(dir, name)));
  return entries.slice(-Math.max(1, limit));
}

/**
 * 读 ledger 归档：先 <base>/<sid>/<lineage>/，无归档回退 legacy；返回最旧→最新（坏行跳过）。
 * 第三参可为 limit（数字）或 leadSessionId（字符串，便捷写法，同 readLedger）。
 */
export function readLedgerArchive(cwd, lineage, limit = 50, leadSessionId) {
  if (typeof limit === 'string') {
    leadSessionId = limit;
    limit = 50;
  }
  const id = partitionIdOf(leadSessionId);
  if (id !== undefined) {
    const entries = readLedgerArchiveIn(teamRootOf(cwd, id), lineage, limit);
    if (entries.length > 0) return entries;
  }
  return readLedgerArchiveIn(teamBaseOf(cwd), lineage, limit);
}

/** 归档年份：条目 at 前 4 位；缺失/坏值用当前年。 */
function ledgerArchiveYearOf(entry) {
  const match = /^\d{4}/.exec(typeof entry?.at === 'string' ? entry.at : '');
  return match === null ? String(new Date().getFullYear()) : match[0];
}

/**
 * 追加一条 ledger：超界时把最旧条目原样（JSONL）追加到 ledger-archive-<年份>.ndjson
 * （O_APPEND 单行追加，不裁剪、不丢数据），live 仍 ≤ 建议上限。
 * 返回 {path, entries, bytes, archived}（archived = 本次移出 live 的条目数）。
 */
export async function appendLedger(cwd, lineage, entry, leadSessionId) {
  const root = teamRootOf(cwd, leadSessionId);
  const dir = join(root, lineage);
  const path = join(dir, 'ledger.ndjson');
  assertNoCredentials(JSON.stringify(entry));
  const store = workspaceStore(cwd);
  const target = store.path(path);
  return store.withFileLock(target, () => {
    store.recover(target);
    appendStorageLine(cwd, target, JSON.stringify(entry) + '\n');
    // 读全量 live：旧实现只读上限条，超界旧条目会被静默丢弃、无法归档。
    const items = parseLedgerFile(target).map((item) => ({ line: JSON.stringify(item), year: ledgerArchiveYearOf(item) }));
    let bytes = items.reduce((sum, item) => sum + byteLength(item.line) + 1, 0);
    const archivedByYear = new Map();
    while (items.length > 1 && (items.length > TEAM_LIMITS.ledgerEntries || bytes > TEAM_LIMITS.ledgerBytes)) {
      const removed = items.shift();
      bytes -= byteLength(removed.line) + 1;
      const bucket = archivedByYear.get(removed.year);
      if (bucket === undefined) archivedByYear.set(removed.year, [removed.line]);
      else bucket.push(removed.line);
    }
    let archived = 0;
    const writes = [];
    for (const [year, lines] of archivedByYear) {
      const archive = storagePath(cwd, ledgerArchivePathOf(cwd, lineage, year, leadSessionId));
      writes.push({ path: archive, content: (readText(archive) ?? '') + lines.join('\n') + '\n' });
      archived += lines.length;
    }
    const text = items.map((item) => item.line).join('\n') + '\n';
    if (archived > 0) store.applyWrites(target, [...writes, { path: target, content: text }]);
    return { path, entries: items.length, bytes: byteLength(text), archived };
  });
}

// ── 退役记录（retired.ndjson；legacy 批量退役 + 显式 retire 的紧凑流水）──

/** 归档年份：记录 at 前 4 位；缺失/坏值用当前年。 */
function retiredArchiveYearOf(record) {
  const match = /^\d{4}/.exec(typeof record?.at === 'string' ? record.at : '');
  return match === null ? String(new Date().getFullYear()) : match[0];
}

/** 读最近退役记录（live 尾部；损坏行跳过；不抛）。 */
export function readRetiredRecords(cwd, leadSessionId, limit = 20) {
  return parseLedgerFile(retiredPathOf(cwd, leadSessionId)).slice(-Math.max(1, limit));
}

/**
 * 追加退役记录（retired.ndjson）：live 超建议体积时把最旧记录原样移入
 * retired-archive-<年份>.ndjson（O_APPEND，不丢数据）。返回 {path, appends, archived}。
 */
export async function archiveRetired(cwd, leadSessionId, records, { limitBytes = TEAM_LIMITS.retiredBytes } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record !== null && typeof record === 'object' && typeof record.name === 'string');
  const path = retiredPathOf(cwd, leadSessionId);
  if (list.length === 0) return { path, appends: 0, archived: 0 };
  for (const record of list) assertNoCredentials(JSON.stringify(record));
  const store = workspaceStore(cwd);
  const target = store.path(path);
  return store.withFileLock(target, () => {
    store.recover(target);
    for (const record of list) appendStorageLine(cwd, target, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
    // 读全量 live：超界最旧记录原样进归档（与 appendLedger 同口径）。
    const items = parseLedgerFile(target).map((item) => ({ line: JSON.stringify(item), year: retiredArchiveYearOf(item) }));
    let bytes = items.reduce((sum, item) => sum + byteLength(item.line) + 1, 0);
    const archivedByYear = new Map();
    while (items.length > 1 && bytes > limitBytes) {
      const removed = items.shift();
      bytes -= byteLength(removed.line) + 1;
      const bucket = archivedByYear.get(removed.year);
      if (bucket === undefined) archivedByYear.set(removed.year, [removed.line]);
      else bucket.push(removed.line);
    }
    let archived = 0;
    const writes = [];
    for (const [year, lines] of archivedByYear) {
      const archive = storagePath(cwd, retiredArchivePathOf(cwd, year, leadSessionId));
      writes.push({ path: archive, content: (readText(archive) ?? '') + lines.join('\n') + '\n' });
      archived += lines.length;
    }
    const text = items.map((item) => item.line).join('\n') + '\n';
    if (archived > 0) store.applyWrites(target, [...writes, { path: target, content: text }]);
    return { path, appends: list.length, archived };
  });
}

/**
 * 合并视图：roster 退役代 + retired.ndjson 归档记录（最近 limit 条，去重按 name，roster 优先）。
 * 返回紧凑记录 {name, gen, reason, at, from:'roster'|'archive', kind?}。
 */
export function retiredRecordsOf(cwd, leadSessionId, { limit = 20 } = {}) {
  let roster;
  try { roster = readRoster(cwd, leadSessionId); } catch { roster = emptyRoster(); }
  const rows = [];
  for (const entry of Object.values(roster?.lineages ?? {})) {
    for (const generation of entry?.generations ?? []) {
      if (generation?.retiredAt === undefined || typeof generation?.name !== 'string') continue;
      rows.push({ name: generation.name, gen: generation.gen, reason: generation.reason, at: generation.retiredAt, from: 'roster' });
    }
  }
  const seen = new Set(rows.map((row) => row.name));
  for (const record of readRetiredRecords(cwd, leadSessionId, 200).reverse()) {
    if (typeof record?.name !== 'string' || seen.has(record.name)) continue;
    seen.add(record.name);
    rows.push({ name: record.name, gen: record.gen, reason: record.reason, at: record.at, from: 'archive', ...(typeof record.kind === 'string' ? { kind: record.kind } : {}) });
  }
  rows.sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')));
  return rows.slice(0, Math.max(1, limit));
}

export function formatLedgerPointers(entries, limit = 5) {
  const list = Array.isArray(entries) ? entries.slice(-Math.max(1, limit)) : [];
  return list.map((entry) => {
    const parts = ['gen=' + String(entry.gen ?? '?'), 'name=' + String(entry.name ?? '?')];
    if (typeof entry.sessionId === 'string' && entry.sessionId !== '') parts.push('session=' + entry.sessionId);
    if (typeof entry.handoff === 'string' && entry.handoff !== '') parts.push('handoff=' + entry.handoff);
    if (typeof entry.note === 'string' && entry.note !== '') parts.push(entry.note);
    return clipText(parts.join(' · '), 220);
  });
}

/**
 * 换代注入 prompt：profile + 上一代交接（按优先级保留）+ ledger 召回指针 + 先核验再等活。
 * v0.8.0：prompt 有界（≤ maxBytes）但不硬截断——超预算时按「身份/任务 > 结论 > 决策 > 证据 >
 * 约束 > 未决 > 下一步 > 完成/失败尝试/指针」整段保留，给显式 marker + 完整 checkpoint 指针；
 * 完整内容始终留在 checkpoint 文件里（落盘完整）。
 */
export function buildRenewPrompt({ lineage, newName, gen, prevName, profile, checkpoint, ledger = [], leadSessionId, recordDir, maxBytes = TEAM_LIMITS.promptBytes } = {}) {
  const recordRoot = String(recordDir ?? partitionRelativePath(leadSessionId, String(lineage ?? '?')));
  const checkpointPointer = recordRoot + '/checkpoint.md';
  const max = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : TEAM_LIMITS.promptBytes;
  const head = [
    '# 你是队友 ' + String(newName ?? '?') + '（' + String(lineage ?? '?') + ' 第 ' + String(gen ?? '?') + ' 代）',
    '',
    '上一代队友 ' + String(prevName ?? '?') + ' 已归档；你不是从零开始，但也没有它的对话记忆。下面是它的工作记录，先读、先核验，再等 Lead 派活。',
  ].join('\n');
  const tail = [
    '## 召回入口（链式，按需）',
    '- 完整 checkpoint（不限体积，权威）：' + checkpointPointer,
    '- 记录目录：' + recordRoot + '/（profile / checkpoint / ledger / handoffs）',
    formatLedgerPointers(ledger).length === 0 ? '- 历史代际：暂无' : '- 历史代际：\n' + formatLedgerPointers(ledger).map((line) => '  ' + line).join('\n'),
    '- 旧会话可按需 session_event_read({session_id, seq})：同 workspace 有权限；快照权威 > 指针 > 旧会话，每轮 ≤3 跳、命中即停。',
    '',
    '## 开工前（先做这一步，再等任务）',
    '1. 用 1-2 个只读工具核验一个可判定事实（文件存在 / 测试命令 / git status），不要凭记录复述就自信；',
    '2. 回一句 ≤100 字：已接手 + 核验结果；',
    '3. 不要自行扩大任务范围；等 Lead 用消息派活。',
    '',
    '## 边界',
    '- 记录写自己 lineage 的 team 目录（checkpoint 用 relay_checkpoint 工具）；不压缩/不交接/不建队友（都是 Lead 的事）；',
    '- 上下文到线（band warn/organize）会提醒你继续做完（已记 incident，不请示/不等答复）；不向人类提问、不自行换人。',
  ].join('\n');
  const profileText = String(profile ?? '').trim();
  const sections = prioritizedCheckpointSections(checkpoint);
  const units = [
    { priority: 0, text: '## 长期职责（profile）\n' + (profileText || '（未提供；按 Lead 的任务卡执行）') },
    ...(sections.length > 0
      ? sections.map((section) => ({ priority: 1 + section.priority, text: section.text }))
      : [{ priority: 1, text: '## 上一代交接（checkpoint）\n（没有 checkpoint：向 Lead 报告记录缺失，不要臆测）' }]),
  ];
  const marker = '[renew prompt 超建议体积（>' + max + 'B）：以下按优先级保留；完整 checkpoint 见 ' + checkpointPointer + ']';
  const render = (texts, capped) => {
    const parts = [head];
    if (capped) parts.push(marker);
    if (texts.length > 0) parts.push(texts.join('\n\n'));
    parts.push(tail);
    return parts.join('\n\n') + '\n';
  };
  const full = render(units.map((unit) => unit.text), false);
  if (byteLength(full) <= max) return full;
  const selected = [];
  for (const unit of units) {
    if (byteLength(render(selected.concat(unit.text), true)) > max) break;
    selected.push(unit.text);
  }
  return render(selected, true);
}

/** 记录目录（相对 workspace）：from 是分区 → 带分区；legacy/未知 → legacy 路径。 */
// ── 体检 ───────────────────────────────────────────────────────────────

/**
 * 队友健康档：fresh=可派；watch=可做完当前、边界先 checkpoint；stale=该换代；
 * spent=到线且没有 checkpoint（先补记录再换代）；unknown=读不到压力。
 */
export function classifyHealth(state, hasCheckpoint = false) {
  const band = state?.band ?? 'unknown';
  if (band === 'unknown') return { health: 'unknown', band, ratio: state?.ratio, action: '读不到该队友上下文；先 relay_team_status 重试或让 Lead 人工判断' };
  if (band === 'unavailable') return { health: 'unknown', band, ratio: state?.ratio, action: '指标不可用（band=unavailable）：读不到该队友上下文；先 relay_team_status 重试或让 Lead 人工判断（不可自动选人）' };
  if (band === 'organize' || band === 'relay') {
    const health = hasCheckpoint ? 'stale' : 'spent';
    return {
      health,
      band,
      ratio: state?.ratio,
      action: hasCheckpoint
        ? '边界让队友 relay_freshen({reset:true, brief}) 真清空复用（同成员、0 额度）；仅换身份/角色才 relay_renew'
        : '先让队友 relay_checkpoint 补记录，再 reset 复用（同成员、0 额度）；仅换身份/角色才 relay_renew',
    };
  }
  if (band === 'warn') return { health: 'watch', band, ratio: state?.ratio, action: '可以做完当前任务；任务/phase 边界发消息让该队友自己 relay_checkpoint，下一轮考虑换代' };
  return { health: 'fresh', band, ratio: state?.ratio, action: '可继续派活' };
}

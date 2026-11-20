#!/usr/bin/env node
/**
 * dsh-context-relay — 存量文档归置（引用闭包 + 归档，不删内容）。
 *
 * 用法：node scripts/docs-archive.mjs [--root DIR] [--months=N] [--apply]
 * 默认 dry-run（只打印计划）；--apply 才移动，并按行追加 archive/manifest.ndjson。
 *
 * 规则：
 *   - 闭包：扫描 root 下全部 .md/.json/.ndjson 的相对路径引用，命中文件一律保留；
 *   - 只归档「不在闭包内 且 mtime 早于 N 个月前当日 00:00」的文档产物；
 *   - handoff/brief 同 role+标题+内容的副本进 archive/dupes/（该条只受闭包约束，不看 mtime），闭包内保留；
 *   - 永不删除、永不改写；progress* 与 lessons*、最新 handoff、architecture 下的 .md 不动。
 *
 * @module dsh-context-relay/scripts/docs-archive
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WS_PREFIX = '.scratch/context-relay/';
const REF_RE = /(?:\.{1,2}\/|\/)?[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)*\.(?:md|json|ndjson)(?:#[\w.:-]+)?/g;
const SCAN_EXT = /\.(?:md|json|ndjson)$/;

/** 默认 root：从 cwd 向上找 .scratch/context-relay。 */
export function findRoot(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, '.scratch', 'context-relay');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** N 个月前的当日 00:00（本地时区）：2026-11-20 运行时默认阈值即 2026-10-20 00:00。 */
export function cutoffMs(months = 1, now = Date.now()) {
  const src = new Date(now);
  const target = new Date(src.getFullYear(), src.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(src.getDate(), lastDay));
  target.setHours(0, 0, 0, 0);
  return target.getTime();
}

/** 递归列出 root 下文件（相对 posix 路径），跳过 archive/ 与 .git/。 */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'archive') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(posix.relative(posix.normalize(root), posix.normalize(abs)));
    }
  };
  walk(root);
  return out.sort();
}

/** 文档产物范围：根目录 *.md + reports/**.md + reviews/**.md（staging/upload/team 不归置）。 */
export function isArtifact(rel) {
  if (!rel.endsWith('.md')) return false;
  const parts = rel.split('/');
  if (parts.length === 1) return true;
  return parts[0] === 'reports' || parts[0] === 'reviews';
}

/** 引用 → root 相对路径候选（相对来源目录、相对 root、工作区前缀）。 */
export function refCandidates(token, fromRel) {
  let t = token.replace(/#.*$/, '').trim();
  if (!t || /^[a-z]+:\/\//i.test(t)) return [];
  const at = t.indexOf(WS_PREFIX);
  if (at >= 0) t = t.slice(at + WS_PREFIX.length);
  const out = [];
  const push = (value) => {
    const normalized = posix.normalize(value.replace(/^\.\//, ''));
    if (!normalized.startsWith('..') && normalized !== '.' && !out.includes(normalized)) out.push(normalized);
  };
  if (t.startsWith('/')) push(t.slice(1));
  push(posix.join(posix.dirname(fromRel), t));
  push(t);
  return out;
}

/** 引用闭包：全部 .md/.json/.ndjson 中出现的相对路径 → 命中文件集合（root 相对）。 */
export function buildClosure(root, files = listFiles(root)) {
  const present = new Set(files);
  const closure = new Set();
  let refs = 0;
  for (const rel of files) {
    if (!SCAN_EXT.test(rel)) continue;
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(REF_RE)) {
      for (const candidate of refCandidates(match[0], rel)) {
        refs += 1;
        if (present.has(candidate)) closure.add(candidate);
      }
    }
  }
  return { closure, refs };
}

/** 最新 handoff（含 brief 命名的交接件）：最新一份永不归档。 */
export function latestHandoff(files, root) {
  let best = null;
  let bestMs = -1;
  for (const rel of files) {
    if (!/^handoff[^/]*\.md$/i.test(rel)) continue;
    const ms = statSync(join(root, rel)).mtimeMs;
    if (ms > bestMs) {
      best = rel;
      bestMs = ms;
    }
  }
  return best;
}

export function isProtected(rel, latest) {
  if (rel.startsWith('architecture/')) return true;
  const base = rel.split('/').pop();
  if (/^progress(?:\.|$|-|_)/.test(base) || /^lessons(?:\.|$|-|_)/.test(base)) return true;
  return latest !== null && rel === latest;
}

/** handoff/brief 副本识别键：role + 首标题 + 内容 sha。 */
export function dupeKey(rel, text) {
  const base = rel.split('/').pop();
  if (!/handoff|brief|^phase-/i.test(base)) return null;
  const role = (/^role:\s*(.+)$/m.exec(text)?.[1] ?? 'lead').trim();
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? base).replace(/\s+/g, ' ').trim();
  const sha = createHash('sha256').update(text).digest('hex');
  return role + '|' + title + '|' + sha;
}

/**
 * 计算归档计划（纯函数，不写盘）。
 * @returns {{root:string, months:number, cutoff:number, stats:object, moves:object[]}}
 */
export function planArchive({ root, months = 1, now = Date.now() }) {
  const files = listFiles(root);
  const cutoff = cutoffMs(months, now);
  const { closure, refs } = buildClosure(root, files);
  const latest = latestHandoff(files, root);
  const stats = { files: files.length, md: 0, json: 0, refs, closure: closure.size, artifacts: 0, protected: 0, live: 0, recent: 0, dupesKept: 0 };
  const moves = [];
  const byDupe = new Map();
  const artifacts = files.filter((rel) => {
    if (rel.endsWith('.md')) stats.md += 1;
    else if (rel.endsWith('.json')) stats.json += 1;
    return isArtifact(rel);
  });
  stats.artifacts = artifacts.length;
  for (const rel of artifacts) {
    const text = readFileSync(join(root, rel), 'utf8');
    const key = dupeKey(rel, text);
    if (!key) continue;
    const entries = byDupe.get(key) ?? [];
    entries.push({ rel, mtimeMs: statSync(join(root, rel)).mtimeMs });
    byDupe.set(key, entries);
  }
  const survivor = new Map();
  for (const [key, entries] of byDupe) {
    if (entries.length < 2) continue;
    survivor.set(key, entries.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).rel);
  }
  for (const rel of artifacts) {
    const mtimeMs = statSync(join(root, rel)).mtimeMs;
    if (isProtected(rel, latest)) {
      stats.protected += 1;
      continue;
    }
    if (closure.has(rel)) {
      stats.live += 1;
      continue;
    }
    const key = dupeKey(rel, readFileSync(join(root, rel), 'utf8'));
    if (key && survivor.get(key) === rel) stats.dupesKept += 1;
    if (key && survivor.has(key) && survivor.get(key) !== rel) {
      moves.push({ old: rel, new: 'archive/dupes/' + rel, reason: 'dupe of ' + survivor.get(key) });
      continue;
    }
    if (mtimeMs >= cutoff) {
      stats.recent += 1;
      continue;
    }
    const year = new Date(mtimeMs).getFullYear();
    moves.push({ old: rel, new: 'archive/' + year + '/' + rel, reason: 'mtime ' + new Date(mtimeMs).toISOString().slice(0, 10) + ', older than ' + months + ' month(s)' });
  }
  moves.sort((a, b) => a.old.localeCompare(b.old));
  const used = new Set(moves.map((m) => m.new));
  if (used.size !== moves.length) throw new Error('archive target collision within plan');
  return { root, months, cutoff, stats, moves };
}

/** 应用计划：移动 + 追加 manifest；目标已存在则跳过（绝不覆盖）。 */
export function applyPlan(plan, { now = Date.now() } = {}) {
  const manifest = join(plan.root, 'archive', 'manifest.ndjson');
  mkdirSync(dirname(manifest), { recursive: true });
  const movedAt = new Date(now).toISOString();
  const done = [];
  const skipped = [];
  for (const move of plan.moves) {
    const from = join(plan.root, move.old);
    const to = join(plan.root, move.new);
    if (!existsSync(from)) {
      skipped.push({ ...move, why: 'source missing (concurrent change)' });
      continue;
    }
    if (existsSync(to)) {
      skipped.push({ ...move, why: 'target exists' });
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    const bytes = statSync(from).size;
    const sha256 = createHash('sha256').update(readFileSync(from)).digest('hex');
    renameSync(from, to);
    appendFileSync(manifest, JSON.stringify({ old: move.old, new: move.new, bytes, sha256, movedAt, reason: move.reason }) + '\n');
    done.push(move);
  }
  return { done, skipped, manifest };
}

export function renderPlan(plan) {
  const { stats, months, cutoff } = plan;
  const lines = [
    'docs-archive plan: root=' + plan.root,
    'months=' + months + ' cutoff=' + new Date(cutoff).toISOString() + ' (local ' + new Date(cutoff).toString().slice(0, 15) + ')',
    'scan: ' + stats.files + ' files (' + stats.md + ' md, ' + stats.json + ' json), refs=' + stats.refs + ', closure=' + stats.closure,
    'artifacts=' + stats.artifacts + ' protected=' + stats.protected + ' in-closure=' + stats.live + ' recent=' + stats.recent + ' dupe-canonical=' + stats.dupesKept,
    'moves=' + plan.moves.length + ' (dupes=' + plan.moves.filter((m) => m.new.startsWith('archive/dupes/')).length + ')',
  ];
  for (const move of plan.moves) lines.push('  MOVE ' + move.old + ' -> ' + move.new + '  [' + move.reason + ']');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { apply: false, months: 1, root: null };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--months=')) args.months = Number(arg.slice(9));
    else if (arg.startsWith('--root=')) args.root = arg.slice(7);
    else throw new Error('unknown argument: ' + arg);
  }
  if (!Number.isInteger(args.months) || args.months < 1) throw new Error('--months must be a positive integer');
  return args;
}

export function run(argv = process.argv.slice(2), { cwd = process.cwd(), now = Date.now() } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node scripts/docs-archive.mjs [--root DIR] [--months=N] [--apply]');
    return null;
  }
  const root = args.root ? resolve(args.root) : findRoot(cwd);
  if (!root || !existsSync(root)) throw new Error('cannot locate .scratch/context-relay; pass --root');
  const plan = planArchive({ root, months: args.months, now });
  console.log(renderPlan(plan));
  if (!args.apply) {
    console.log('dry-run: no files moved (pass --apply)');
    return plan;
  }
  const result = applyPlan(plan, { now });
  console.log('applied: moved=' + result.done.length + ' skipped=' + result.skipped.length + ' manifest=' + result.manifest);
  for (const skip of result.skipped) console.log('  SKIP ' + skip.old + ' (' + skip.why + ')');
  return { ...plan, result };
}

const invoked = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try {
    run();
  } catch (error) {
    console.error('docs-archive: ' + error.message);
    process.exit(1);
  }
}

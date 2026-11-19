#!/usr/bin/env node
/**
 * dsh-context-relay — 文档埋点周报骨架（relay-docs-v2 §2.4/§4，离线只读）。
 *
 * 用法：node scripts/docs-metrics.mjs [--since 7d] [--root <.scratch/context-relay/metrics>] [--by group]
 * 行为：读 metrics 目录全部 *.ndjson（坏行跳过），按组出 inject/bytes/hits/hit%/wholeRead%/
 *       discover/neverOpened；样本不足（<5 会话或 <20 次注入）只报 insufficient sample，不改参数。
 *
 * @module dsh-context-relay/scripts/docs-metrics
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateDocsMetrics, readMetricsDir } from '../lib/docs-metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** '7d' / '24h' / ISO 日期 → 毫秒时间戳；非法值回退 7 天。 */
export function parseSinceMs(value, now = Date.now()) {
  const raw = String(value ?? '7d').trim();
  const relative = /^(\d+(?:\.\d+)?)([dh])$/.exec(raw);
  if (relative) {
    const unit = relative[2] === 'd' ? DAY_MS : 60 * 60 * 1000;
    return now - Number(relative[1]) * unit;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : now - 7 * DAY_MS;
}

const pct = (value) => (value === null || value === undefined ? '—' : (value * 100).toFixed(1) + '%');

/** 纯函数：事件数组 → 周报文本（测试直接调用）。 */
export function buildReport(events, { sinceMs = 0, sinceLabel = '7d', skipped = 0, files } = {}) {
  const agg = aggregateDocsMetrics(events, { sinceMs });
  const lines = [];
  lines.push('# relay docs metrics');
  lines.push('- since: ' + sinceLabel + (sinceMs > 0 ? '（' + new Date(sinceMs).toISOString() + ' 起）' : '（全部）'));
  lines.push('- samples: ' + agg.sessions + ' 会话 · ' + agg.injects + ' 次注入 · ' + agg.reads + ' 次读取 · ' + agg.searches + ' 次检索' + (files === undefined ? '' : ' · ' + files + ' 个文件'));
  if (!agg.sufficient) {
    lines.push('- insufficient sample: 门槛 ≥' + agg.needSessions + ' 会话且 ≥' + agg.needInjects + ' 次注入（当前 ' + agg.sessions + ' 会话 / ' + agg.injects + ' 注入）；不足顺延到 14 天，期间不调参');
  }
  if (skipped > 0) lines.push('- skipped: ' + skipped + ' 行坏 JSON/坏记录（已跳过）');
  lines.push('');
  lines.push('| group | injects | injectB | docs | reads | hit% | wholeRead% | discover | neverOpened |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  if (agg.groups.length === 0) lines.push('| (no events) | 0 | 0 | 0 | 0 | — | — | 0 | 0 |');
  for (const row of agg.groups) {
    lines.push('| ' + [row.group, row.injects, row.injectBytes, row.docs, row.reads, pct(row.hitRate), pct(row.wholeReadRate), row.discover, row.neverOpened].join(' | ') + ' |');
  }
  lines.push('');
  lines.push('- 判据（relay-docs-v2 §2.4）：hit≈0 + neverOpened>0 + discover>0 → 该组降 B；hit 高 + wholeRead% 高 → 先补 constraints 文案，不加字节；hit 高 + wholeRead% 低 → 保持 A。');
  if (agg.stepsMedian !== null) lines.push('- 注入→命中读步数中位数：' + agg.stepsMedian);
  return lines.join('\n');
}

/** 默认 metrics 目录：从 cwd 向上找 .scratch/context-relay/metrics（插件仓在 workspace 内也能直接跑）。 */
function defaultMetricsDir(cwd) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, '.scratch', 'context-relay', 'metrics');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(resolve(cwd), '.scratch', 'context-relay', 'metrics');
}

/** CLI 骨架：解析参数 → 读 metrics → 打印周报；返回退出码（只读，不写盘）。 */
export function run(argv, { cwd = process.cwd(), now = Date.now() } = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let since = '7d';
  let root;
  let by = 'group';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：node scripts/docs-metrics.mjs [--since 7d] [--root <metrics目录>] [--by group]\n');
      return 0;
    }
    if (arg === '--since') since = args[++index] ?? since;
    else if (arg.startsWith('--since=')) since = arg.slice('--since='.length);
    else if (arg === '--root') root = args[++index];
    else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg === '--by') by = args[++index] ?? by;
    else if (arg.startsWith('--by=')) by = arg.slice('--by='.length);
  }
  const metricsDir = root !== undefined ? resolve(cwd, root) : defaultMetricsDir(cwd);
  const { events, skipped, files } = readMetricsDir(metricsDir);
  const sinceMs = parseSinceMs(since, now);
  process.stdout.write(buildReport(events, { sinceMs, sinceLabel: since + (by === 'group' ? '' : ' · by=' + by), skipped, files }) + '\n');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}

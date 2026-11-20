/**
 * legacy golden 的固定 fixture。
 *
 * 不在仓库里提交 .scratch/ 目录（.gitignore 全局忽略），而是在测试里按固定顺序生成
 * `.scratch/context-relay/**`，并用固定 mtime 保证 handoff/brief 的“最新优先”排序稳定。
 * 任何 fixture 内容改动都必须显式更新 golden（见 test/legacy-golden.test.mjs）。
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURE_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

const NL = String.fromCharCode(10);
const fm = (title, layer, extra = []) => [
  '---',
  'title: ' + title,
  'role: ' + title + ' · 固定 fixture 的作用说明，故意写长以触发 v0.11 legacy 渲染的折最大目录组与字节预算',
  'layer: ' + layer,
  'when: 需要 ' + title + ' 的详细上下文或排查历史问题时读',
  'updated: 2026-01-02',
  ...extra,
  '---',
  '# ' + title,
  '',
  '正文只用于固定字节数；不要在这里写时间相关的内容。',
].join(NL);

const doc = (path, title, extra = []) => ({ path, content: fm(title, 'L2', extra) });
const l1 = (path, title, layer = 'L1') => ({ path, content: fm(title, layer) });
const raw = (path, title) => ({ path, content: ['# ' + title, '', '原始回执，legacy 只给历史尾行计数。'].join(NL) });

export const FIXTURE_FILES = [
  // L1：3 份 handoff + 2 份 brief + progress/lessons；mtime 递增，最后写入的 handoff 最新。
  l1('handoff-2026-01-01.md', '交接 A'),
  l1('handoff-2025-12-31.md', '交接 B'),
  l1('handoff-2025-12-30.md', '交接 C'),
  l1('phase-build-2026-01-01.md', '阶段材料 A'),
  l1('phase-build-2025-12-31.md', '阶段材料 B'),
  l1('progress.md', '滚动进度'),
  l1('lessons.md', '经验'),
  // 普通 L2 文档：目录组折叠的主要来源。
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => doc('docs/topic-' + String(n).padStart(2, '0') + '.md', '普通文档 ' + n, n === 1 ? [
    'constraints: 只读；不写盘',
    'contracts: legacy 渲染必须逐字节稳定',
    'relations: evidence_for docs/topic-02.md, supersedes docs/topic-03.md',
  ] : [])),
  // 架构/决策/调研：进一步撑开字节预算，并验证 legacy 忽略 v0.12 语义标记。
  ...[1, 2, 3, 4, 5].map((n) => doc('architecture/arch-' + n + '.md', '架构 ' + n)),
  ...[1, 2, 3, 4, 5].map((n) => doc('decisions/decision-' + n + '.md', '决策 ' + n)),
  ...[1, 2, 3, 4].map((n) => doc('research/research-' + n + '.md', '调研 ' + n)),
  // raw：reports 永不入索引，只贡献 legacy 的“另有 N 份历史产物”尾行。
  raw('reports/task-a.md', '回执 A'),
  raw('reports/task-b.md', '回执 B'),
  raw('reports/task-c.md', '回执 C'),
];

/** 在 cwd 下生成固定 fixture；固定 mtime 让排序与 golden 可复现。 */
export function buildLegacyFixture(cwd) {
  const root = join(cwd, '.scratch', 'context-relay');
  for (const [index, file] of FIXTURE_FILES.entries()) {
    const absolute = join(root, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content.endsWith(NL) ? file.content : file.content + NL);
    const mtime = new Date(FIXTURE_BASE_MS + index * 60_000);
    utimesSync(absolute, mtime, mtime);
  }
}

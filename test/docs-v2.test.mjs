import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDocIndex, DOC_LIMITS, progressKeyDocs, readDoc, renderDocIndex } from '../lib/docs.js';
import { normalizePins, renderIndex, selectIndex } from '../lib/docs-policy.js';
import { METRICS_MAX_LINES, docsMetricsSnapshot, noteInjection, readMetricsDir, readMetricsEvents, recordRead, recordSearch } from '../lib/docs-metrics.js';
import { buildReport, parseSinceMs, run as runMetricsReport } from '../scripts/docs-metrics.mjs';
import { createRelayTools } from '../lib/agent/tools.js';
import { readWorkItems } from '../lib/agent/work-items.js';

const NL = String.fromCharCode(10);
const w = (path, ...lines) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, lines.join(NL) + NL); };
const fm = (title, extra = []) => ['---', 'title: ' + title, 'role: ' + title + ' 作用', 'layer: L2', 'when: 需要 ' + title + ' 时', ...extra, '---', '# ' + title];

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-v2-'));
  const r = join(cwd, '.scratch', 'context-relay');
  w(join(r, 'docs', 'decisions.md'), ...fm('决策'));
  w(join(r, 'docs', 'note.md'), ...fm('说明'));
  w(join(r, 'docs', 'with-facts.md'), ...fm('事实', ['constraints: 只读；不改 schema']));
  w(join(r, 'docs', 'contracts-only.md'), '---', 'constraints: 没有 role/when 不算带决策', '---', '# 只折叠');
  w(join(r, 'architecture', 'design.md'), ...fm('设计'));
  w(join(r, 'decisions', 'd-1.md'), ...fm('决策一'));
  w(join(r, 'reports', 'task-1.md'), '# 回执', '细节');
  w(join(r, 'handoff-1.md'), '# 交接 1');
  w(join(r, 'handoff-2.md'), '# 交接 2');
  w(join(r, 'phase-build-1.md'), '# brief');
  w(join(r, 'progress.md'), '# 进度');
  w(join(r, 'lessons.md'), '# 经验');
  return { cwd, r, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('选择：在役 + 带决策单列；普通 L2 与 raw/reports 只折叠', () => {
  const fx = fixture();
  try {
    const index = buildDocIndex(fx.cwd);
    const sel = selectIndex(index.all);
    const singles = sel.singles.map((entry) => entry.relPath);
    for (const path of ['handoff-1.md', 'handoff-2.md', 'phase-build-1.md', 'progress.md', 'lessons.md', 'docs/decisions.md', 'decisions/d-1.md', 'docs/with-facts.md']) {
      assert.ok(singles.includes(path), '在役/带决策单列：' + path);
    }
    for (const path of ['docs/note.md', 'docs/contracts-only.md', 'architecture/design.md', 'reports/task-1.md']) {
      assert.ok(!singles.includes(path), '普通文档不单列：' + path);
    }
    const groups = new Map(sel.groups.map((group) => [group.dir, group.count]));
    assert.equal(groups.get('docs'), 2, 'docs/ 下 note + contracts-only 折叠');
    assert.equal(groups.get('architecture'), 1);
    assert.equal(groups.get('reports'), 1);
    const rendered = renderDocIndex(index);
    assert.match(rendered.text, /### 在役（先读）/);
    assert.match(rendered.text, /### 带决策/);
    assert.doesNotMatch(rendered.text, /^- `reports\//m, 'raw/reports 永不单列');
    assert.match(rendered.text, /reports\/ — 1 份（代表：`reports\/task-1\.md`）· `relay_doc list prefix=reports` 展开/);
    assert.match(rendered.text, /architecture\/ — 1 份/);
  } finally { fx.cleanup(); }
});

test('pin：优先单列；支持 key_docs 的「path — role」与 relay 前缀；raw 被 pin 也不单列', () => {
  const fx = fixture();
  try {
    assert.deepEqual(normalizePins(['architecture/design.md — 设计稿', '`docs/note.md`', '.scratch/context-relay/docs/with-facts.md']).sort(), ['architecture/design.md', 'docs/note.md', 'docs/with-facts.md']);
    const pins = ['architecture/design.md — 设计稿', 'reports/task-1.md'];
    const index = buildDocIndex(fx.cwd, { pins });
    const rendered = renderDocIndex(index);
    assert.match(rendered.text, /### 在役（先读）[\s\S]*- `architecture\/design\.md`/, 'pin 的 design 单列');
    assert.doesNotMatch(rendered.text, /^- `reports\/task-1\.md`/m, 'raw pin 永不单列');
    assert.match(rendered.text, /reports\/ — 1 份（代表：`reports\/task-1\.md`）/, 'raw pin 仍在折叠组内可见');
    const pinned = selectIndex(index.all, { pins: ['docs/note.md'] });
    assert.ok(pinned.singles.some((entry) => entry.relPath === 'docs/note.md'));
    // frontmatter 把 reports 抬到 L2 也不行：raw/reports 路径永不单列。
    w(join(fx.r, 'reports', 'elevated.md'), ...fm('抬层回执'));
    const elevated = selectIndex(buildDocIndex(fx.cwd).all, { pins: ['reports/elevated.md'] });
    assert.ok(!elevated.singles.some((entry) => entry.relPath === 'reports/elevated.md'));
  } finally { fx.cleanup(); }
});

test('层级 A/B/C：默认 A 维持现状；B 只 pin；C 一行计数 + include=all 命令；宽度/组数可触发', () => {
  const fx = fixture();
  try {
    const index = buildDocIndex(fx.cwd);
    const a = renderDocIndex(index);
    assert.equal(a.level, 'A');
    const b = renderDocIndex(index, { level: 'B' });
    assert.equal(b.level, 'B');
    assert.doesNotMatch(b.text, /### 带决策/);
    const c = renderDocIndex(index, { level: 'C' });
    assert.equal(c.level, 'C');
    assert.match(c.text, /其余 \d+ 份文档 \/ \d+ 个目录已折叠：`relay_doc list include=all` 展开/);
    assert.equal(renderDocIndex(index, { width: 1 }).level, 'B', 'W 触发 A→B');
    assert.equal(renderDocIndex(index, { maxGroups: 0 }).level, 'C', 'G 触发 A→C');
    const layout = selectIndex(index.all, { pins: ['architecture/design.md'], level: 'B' });
    assert.equal(layout.singles.length, 1, 'B 只保留 pin 单列');
    assert.equal(renderIndex(layout).shown, 1);
  } finally { fx.cleanup(); }
});

test('嵌套目录：组行 prefix 直达（任何路径 ≤2 次调用可达），根目录组带 include=all', () => {
  const fx = fixture();
  try {
    w(join(fx.r, 'docs', 'a', 'b', 'x.md'), ...fm('嵌套 X'));
    w(join(fx.r, 'docs', 'a', 'b', 'y.md'), ...fm('嵌套 Y'));
    w(join(fx.r, 'root-note.md'), ...fm('根级'));
    const index = buildDocIndex(fx.cwd);
    const rendered = renderDocIndex(index);
    assert.match(rendered.text, /docs\/a\/b\/ — 2 份/);
    assert.match(rendered.text, /relay_doc list prefix=docs\/a\/b/);
    assert.match(rendered.text, /（根目录） — \d+ 份（代表：[^\n]+）· `relay_doc list include=all` 展开/);
    const entries = buildDocIndex(fx.cwd, { include: 'all' }).entries.filter((entry) => entry.relPath.startsWith('docs/a/b/'));
    assert.equal(entries.length, 2, 'prefix=docs/a/b 可一次列出全部');
    assert.equal(readDoc(fx.cwd, 'docs/a/b/x.md').ok, true, '列出后读 = 第二次调用');
    const prefixes = rendered.text.split('relay_doc list prefix=').slice(1).map((part) => part.split(/[\s`]/)[0]);
    const reachable = index.all.every((entry) => rendered.text.includes('`' + entry.relPath + '`')
      || prefixes.some((prefix) => entry.relPath === prefix || entry.relPath.startsWith(prefix + '/'))
      || rendered.text.includes('relay_doc list include=all'));
    assert.equal(reachable, true, '0 条不可达');
    for (const line of rendered.text.split(NL)) {
      if (/份（代表|已折叠|另有/.test(line)) assert.match(line, /relay_doc/, '无命令省略：' + line);
    }
  } finally { fx.cleanup(); }
});

test('预算护栏：大量带决策文档撑爆 2KB 时降级 B/C，仍 0 不可达/0 无命令省略', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-v2-budget-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    for (let i = 0; i < 300; i += 1) w(join(r, 'decisions', 'd-' + i + '.md'), ...fm('决策 ' + i));
    for (let i = 0; i < 10; i += 1) w(join(r, 'architecture', 'a-' + i + '.md'), ...fm('架构 ' + i));
    const index = buildDocIndex(cwd);
    const rendered = renderDocIndex(index);
    assert.ok(rendered.bytes <= DOC_LIMITS.indexBytes, 'bytes ' + rendered.bytes);
    assert.ok(rendered.level === 'B' || rendered.level === 'C', '降级到 ' + rendered.level);
    assert.ok(rendered.omitted > 0);
    const prefixes = rendered.text.split('relay_doc list prefix=').slice(1).map((part) => part.split(/[\s`]/)[0]);
    const unreachable = index.all.filter((entry) => !(rendered.text.includes('`' + entry.relPath + '`')
      || prefixes.some((prefix) => entry.relPath === prefix || entry.relPath.startsWith(prefix + '/'))
      || rendered.text.includes('relay_doc list include=all')));
    assert.deepEqual(unreachable.map((entry) => entry.relPath), [], '0 条不可达');
    for (const line of rendered.text.split(NL)) {
      if (/份（代表|已折叠|另有/.test(line)) assert.match(line, /relay_doc/, '无命令省略：' + line);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('progress.key_docs 作为 pin fallback；currentPhase.pins 持久化可读', () => {
  const fx = fixture();
  try {
    w(join(fx.r, 'progress.md'), '# 进度', '', '<!-- relay-progress:json', JSON.stringify({ key_docs: ['architecture/design.md — 设计稿'] }), '-->');
    assert.deepEqual(progressKeyDocs(fx.cwd), ['architecture/design.md — 设计稿']);
    const pins = normalizePins(progressKeyDocs(fx.cwd));
    assert.deepEqual(pins, ['architecture/design.md']);
    const rendered = renderDocIndex(buildDocIndex(fx.cwd, { pins }));
    assert.match(rendered.text, /- `architecture\/design\.md`/);
    // 台账 currentPhase.pins（relay_phase 写入形状）可读且不被 normalize 丢弃
    mkdirSync(join(fx.r, 'work-items'), { recursive: true });
    writeFileSync(join(fx.r, 'work-items', 'pin-session.json'), JSON.stringify({ version: 1, rev: 1, currentPhase: { phase: 'build', since: 1, pins: ['architecture/design.md'] }, items: [] }));
    assert.deepEqual(readWorkItems(fx.cwd, { scopeId: 'pin-session' }).currentPhase.pins, ['architecture/design.md']);
  } finally { fx.cleanup(); }
});

function metricsRuntime() {
  return {
    ctx: { logger: { info() {}, warn() {} }, get() { return undefined; } },
    currentThresholds: () => ({ warnRatio: 0.3 }),
    injectBrief: true,
    routerMode: false,
    workItems: { enabled: false },
  };
}

test('relay_phase：design_gate.path 自动并入 currentPhase.pins，L0 随之被 pin 单列', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-v2-pin-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    w(join(r, 'architecture', 'design.md'), ...fm('设计稿'));
    const tools = createRelayTools({ ...metricsRuntime(), workItems: { enabled: true } });
    const phase = tools.find((definition) => definition.name === 'relay_phase');
    const doc = tools.find((definition) => definition.name === 'relay_doc');
    const session = { id: 'pin-phase-session', header: { cwd }, seq: 0 };
    const exec = { agent: { session, options: {} } };
    const built = await phase.execute({
      phase: 'build',
      items: ['实现'],
      design_gate: { path: '.scratch/context-relay/architecture/design.md', user_approved: true, ask_ref: '确认', not_doing: ['不做'] },
      contract_check: { requirement: 'r', fidelity: 'f', attention: 'a' },
    }, exec);
    assert.equal(built.phase, 'build');
    assert.deepEqual(readWorkItems(cwd, { scopeId: 'pin-phase-session' }).currentPhase.pins, ['.scratch/context-relay/architecture/design.md']);
    const index = await doc.execute({ action: 'index' }, exec);
    assert.match(index.text, /### 在役（先读）[\s\S]*- `architecture\/design\.md`/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('埋点：inject/read/search 写 ndjson（无正文/query），inIndex 归因与 200 行滚动', () => {
  const fx = fixture();
  try {
    const rendered = renderDocIndex(buildDocIndex(fx.cwd));
    const first = rendered.paths[0];
    assert.equal(noteInjection({ cwd: fx.cwd, sessionId: 'metrics-s1', site: 'index', rendered }).type, 'inject');
    const read = recordRead({ cwd: fx.cwd, sessionId: 'metrics-s1', path: first, mode: 'whole', bytes: 12 });
    assert.equal(read.inIndex, true);
    assert.equal(read.origin, 'index');
    recordRead({ cwd: fx.cwd, sessionId: 'metrics-s1', path: 'docs/note.md', origin: 'unknown' });
    recordSearch({ cwd: fx.cwd, sessionId: 'metrics-s1', query: '机密查询词', matches: ['docs/note.md'], scanned: 3, truncated: false });
    const { events, skipped } = readMetricsEvents(fx.cwd, 'metrics-s1');
    assert.equal(skipped, 0);
    assert.deepEqual(events.map((event) => event.type), ['inject', 'read', 'read', 'search']);
    const file = readFileSync(join(fx.r, 'metrics', 'metrics-s1.ndjson'), 'utf8');
    assert.ok(!file.includes('机密查询词'), '不存 query 原文');
    assert.ok(!file.includes('# 决策'), '不存正文');
    assert.match(file, /"queryHash":"[0-9a-f]{12}"/);
    // 没注入过的会话读路径：inIndex 未知记 null（重启/新会话不猜）。
    const unknown = recordRead({ cwd: fx.cwd, sessionId: 'metrics-unknown', path: first });
    assert.equal(unknown.inIndex, null);
    assert.ok(readFileSync(join(fx.r, 'metrics', 'metrics-unknown.ndjson'), 'utf8').includes('"inIndex":null'));
    const snap = docsMetricsSnapshot({ cwd: fx.cwd, sessionId: 'metrics-s1' });
    assert.equal(snap.injects, 1);
    assert.equal(snap.reads, 2);
    assert.equal(snap.hits, 1);
    assert.equal(snap.searches, 1);
    assert.equal(snap.inIndex, rendered.paths.length);

    for (let i = 0; i < 205; i += 1) noteInjection({ cwd: fx.cwd, sessionId: 'roll-session', site: 'index', rendered });
    const rolled = readMetricsEvents(fx.cwd, 'roll-session').events;
    assert.equal(rolled.length, METRICS_MAX_LINES);
    assert.equal(rolled[0].seq, 6);
    assert.equal(rolled.at(-1).seq, 205);

    // 写失败只降级：cwd 是普通文件时 mkdir 失败，不抛、不产生事件
    const badCwd = join(fx.cwd, 'plain-file.txt');
    writeFileSync(badCwd, 'x');
    assert.doesNotThrow(() => noteInjection({ cwd: badCwd, sessionId: 'bad', site: 'index', rendered }));
    assert.equal(noteInjection({ cwd: badCwd, sessionId: 'bad', site: 'index', rendered }), undefined);
  } finally { fx.cleanup(); }
});

test('relay_doc 工具：index 记 inject、read 记 read、search 记 search；relay_status.docs 给摘要', async () => {
  const fx = fixture();
  try {
    const tools = createRelayTools(metricsRuntime());
    const doc = tools.find((definition) => definition.name === 'relay_doc');
    const status = tools.find((definition) => definition.name === 'relay_status');
    const session = { id: 'docs-v2-metrics-tool', header: { cwd: fx.cwd }, seq: 0 };
    const exec = { agent: { session, options: {} } };
    const index = await doc.execute({ action: 'index' }, exec);
    assert.equal(index.ok, true);
    assert.equal(index.level, 'A');
    assert.ok(Array.isArray(index.groups) && index.groups.length > 0);
    const rendered = renderDocIndex(buildDocIndex(fx.cwd));
    const read = await doc.execute({ action: 'read', path: rendered.paths[0] }, exec);
    assert.equal(read.ok, true);
    const search = await doc.execute({ action: 'search', query: '决策' }, exec);
    assert.equal(search.ok, true);
    const report = await status.execute({}, exec);
    assert.equal(report.docs.available, true);
    assert.equal(report.docs.injects, 1);
    assert.equal(report.docs.reads, 1);
    assert.equal(report.docs.searches, 1);
    assert.equal(report.docs.hits, 1);
    assert.match(report.text, /docs: 注入 1 · 读 1 · 命中 1（100%）· 搜 1 · \.scratch\/context-relay\/metrics\/docs-v2-metrics-tool\.ndjson/);
  } finally { fx.cleanup(); }
});

test('周报骨架：aggregate 样本门槛/坏行跳过/组级指标；CLI 只读不写', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-v2-report-'));
  try {
    const now = Date.now();
    assert.equal(parseSinceMs('7d', now), now - 7 * 24 * 60 * 60 * 1000);
    assert.ok(Math.abs(parseSinceMs('24h', now) - (now - 24 * 60 * 60 * 1000)) < 5);
    assert.ok(Number.isFinite(parseSinceMs('not-a-date', now)));
    const events = [];
    for (let s = 0; s < 5; s += 1) {
      for (let i = 0; i < 4; i += 1) {
        events.push({ v: 1, ts: now - 1000, sessionId: 's' + s, seq: i * 2 + 1, type: 'inject', site: 'index', level: 'A', bytes: 120, groups: [{ g: 'docs', n: 3, b: 40 }], digest: 'x', policy: 'docs-v2' });
        if (i === 0) events.push({ v: 1, ts: now - 500, sessionId: 's' + s, seq: i * 2 + 2, type: 'read', path: 'docs/decisions.md', origin: 'index', mode: 'whole', bytes: 50, inIndex: true, truncated: false });
      }
    }
    events.push({ v: 1, ts: now - 500, sessionId: 's0', seq: 99, type: 'search', queryHash: 'abc123def456', qlen: 2, matches: 1, scanned: 3, truncated: false });
    const text = buildReport(events, { sinceMs: now - 24 * 60 * 60 * 1000, sinceLabel: '1d', skipped: 1, files: 5 });
    assert.match(text, /samples: 5 会话 · 20 次注入/);
    assert.doesNotMatch(text, /insufficient sample/);
    assert.match(text, /skipped: 1/);
    assert.match(text, /\| docs \| 20 \| 800 \| 3 \| 5 \| 100\.0% \| 100\.0% \| 0 \| 2 \|/);
    const poor = buildReport(events.slice(0, 4), { sinceMs: 0 });
    assert.match(poor, /insufficient sample: 门槛 ≥5 会话且 ≥20 次注入/);
    // CLI：metrics 目录 + 一条坏行；只读到 stdout，不写盘
    const dir = join(cwd, '.scratch', 'context-relay', 'metrics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's0.ndjson'), JSON.stringify(events[0]) + NL + '{bad json}' + NL);
    const before = readFileSync(join(dir, 's0.ndjson'), 'utf8');
    const writes = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      assert.equal(runMetricsReport(['--root', dir, '--since', '7d'], { cwd, now }), 0);
    } finally { process.stdout.write = original; }
    assert.match(writes.join(''), /# relay docs metrics/);
    assert.match(writes.join(''), /skipped: 1 行坏 JSON/);
    assert.equal(readFileSync(join(dir, 's0.ndjson'), 'utf8'), before, 'CLI 只读');
    assert.equal(readMetricsDir(dir).skipped, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

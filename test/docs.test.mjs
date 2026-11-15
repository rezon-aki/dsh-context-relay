import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildDocIndex, checkSessionDocs, docIndexDigest, DOC_LIMITS, parseFrontmatter, readDoc, renderDocIndex, searchDocs,
} from '../lib/docs.js';
import { createRelayTools } from '../lib/agent/tools.js';

const NL = String.fromCharCode(10);
const BT = String.fromCharCode(96);
const w = (path, ...lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join(NL) + NL);
};

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-test-'));
  const r = join(cwd, '.scratch', 'context-relay');
  w(join(r, 'docs', 'decisions.md'), '---', 'title: 决策', 'role: 决策与理由', 'layer: L2', 'when: 需要知道为什么时', '---', '', '# 决策', '', '## D1 虚拟索引', '理由：避免漂移。', '', '## D2 上限只做 advisory', '理由：不丢数据。');
  w(join(r, 'progress.md'), '# 进度', '', '参考 ' + BT + 'docs/decisions.md' + BT + ' 与 ' + BT + 'docs/missing.md' + BT);
  w(join(r, 'handoff-1.md'), '# 交接', '', '## 必读', '- ' + BT + 'docs/decisions.md' + BT);
  w(join(r, 'reports', 'task-1.md'), '# 回执', '细节');
  return { cwd, r, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('parseFrontmatter：解析 meta/body；无 frontmatter 原样返回', () => {
  const parsed = parseFrontmatter('---' + NL + 'title: X' + NL + 'role: 作用' + NL + '---' + NL + NL + '# 正文');
  assert.equal(parsed.hasFrontmatter, true);
  assert.deepEqual(parsed.meta, { title: 'X', role: '作用' });
  assert.match(parsed.body, /# 正文/);
  const plain = parseFrontmatter('# 无 frontmatter');
  assert.equal(plain.hasFrontmatter, false);
  assert.equal(plain.body, '# 无 frontmatter');
});

test('buildDocIndex/renderDocIndex：L1/L2 分层、raw 不入索引、relPath 渲染、digest 稳定', () => {
  const fx = fixture();
  try {
    const index = buildDocIndex(fx.cwd);
    assert.equal(index.counts.total, 4);
    assert.equal(index.counts.raw, 1);
    const l1 = index.entries.filter((entry) => entry.layer === 'L1').map((entry) => entry.relPath);
    const l2 = index.entries.filter((entry) => entry.layer === 'L2').map((entry) => entry.relPath);
    assert.ok(l1.includes('handoff-1.md'));
    assert.ok(l1.includes('progress.md'));
    assert.deepEqual(l2, ['docs/decisions.md']);
    const rendered = renderDocIndex(index);
    assert.ok(rendered.bytes <= DOC_LIMITS.indexBytes);
    assert.match(rendered.text, /先读（L1）/);
    assert.match(rendered.text, /按需（L2）/);
    assert.match(rendered.text, /docs\/decisions\.md/);
    assert.ok(!rendered.text.includes('.scratch/context-relay/docs/decisions.md'), '索引用 relay 相对路径');
    assert.match(rendered.text, /另有 1 份历史产物未入索引/);
    assert.equal(rendered.digest, docIndexDigest(rendered.text));
    assert.equal(docIndexDigest('a'), docIndexDigest('a'));
    assert.notEqual(docIndexDigest('a'), docIndexDigest('b'));
  } finally { fx.cleanup(); }
});

test('renderDocIndex：超索引预算时截断并留显式 marker（不静默）', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 40; i += 1) {
      w(join(fx.r, 'docs', 'note-' + i + '.md'), '---', 'role: 说明文档 ' + i, 'layer: L2', 'when: 需要时', '---', '# 说明');
    }
    const rendered = renderDocIndex(buildDocIndex(fx.cwd));
    assert.ok(rendered.bytes <= DOC_LIMITS.indexBytes, 'bytes ' + rendered.bytes);
    assert.equal(rendered.truncated, true);
    assert.ok(rendered.omitted > 0);
    assert.match(rendered.text, /索引已截断：\d+ 条未显示/);
  } finally { fx.cleanup(); }
});

test('readDoc：按标题/分页读取、越界与坏路径拒绝、给 nextOffset', () => {
  const fx = fixture();
  try {
    const section = readDoc(fx.cwd, 'docs/decisions.md', { section: 'D1' });
    assert.equal(section.ok, true);
    assert.equal(section.section, 'D1 虚拟索引');
    assert.match(section.text, /避免漂移/);
    assert.ok(!section.text.includes('D2'), 'section 只截取本节');
    const page = readDoc(fx.cwd, '.scratch/context-relay/docs/decisions.md', { offset: 0, limit: 3 });
    assert.equal(page.ok, true);
    assert.equal(page.lines, 3);
    assert.equal(page.truncated, true);
    assert.ok(Number.isInteger(page.nextOffset));
    const missing = readDoc(fx.cwd, 'docs/nope.md');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'unreadable');
    for (const bad of ['/etc/passwd', '~/x.md', '../outside.md']) {
      const rejected = readDoc(fx.cwd, bad);
      assert.equal(rejected.ok, false, bad);
      assert.equal(rejected.code, 'invalid-path', bad);
    }
    const noSection = readDoc(fx.cwd, 'docs/decisions.md', { section: '不存在的标题' });
    assert.equal(noSection.ok, false);
    assert.equal(noSection.code, 'section-not-found');
  } finally { fx.cleanup(); }
});

test('searchDocs：返回 path:line 摘要；空 query 拒绝；include 控制候选面', () => {
  const fx = fixture();
  try {
    const hit = searchDocs(fx.cwd, '理由');
    assert.equal(hit.ok, true);
    assert.ok(hit.matches.length >= 2);
    assert.ok(hit.matches.every((match) => typeof match.path === 'string' && Number.isInteger(match.line)));
    assert.equal(searchDocs(fx.cwd, '   ').code, 'empty-query');
    const rawOnly = searchDocs(fx.cwd, '细节', { include: 'index' });
    assert.equal(rawOnly.ok, true);
    assert.equal(rawOnly.matches.length, 0, 'raw 文档默认不在 index 候选面');
    const withAll = searchDocs(fx.cwd, '细节', { include: 'all' });
    assert.ok(withAll.matches.length >= 1);
  } finally { fx.cleanup(); }
});

test('checkSessionDocs：缺 frontmatter / 坏指针 / 超 L1 advisory 都给 warning，不阻断', () => {
  const fx = fixture();
  try {
    w(join(fx.r, 'docs', 'unregistered.md'), '# 没有 frontmatter 的文档');
    w(join(fx.r, 'handoff-2.md'), '# 交接', '读 ' + BT + 'docs/nowhere.md' + BT);
    w(join(fx.r, 'progress.md'), '# 进度', 'x'.repeat(17 * 1024));
    const check = checkSessionDocs({ workspaceRoot: fx.cwd });
    assert.equal(check.level, 'soft');
    assert.equal(check.ok, false);
    assert.ok(check.warnings.some((line) => line.includes('frontmatter')));
    assert.ok(check.warnings.some((line) => line.includes('坏指针')));
    assert.ok(check.warnings.some((line) => line.includes('advisory')));
    const empty = checkSessionDocs({ workspaceRoot: mkdtempSync(join(tmpdir(), 'relay-docs-empty-')) });
    assert.equal(empty.ok, true);
  } finally { fx.cleanup(); }
});

test('relay_doc 工具：index/list/read/search/lint 五个动作可用且有界', async () => {
  const fx = fixture();
  try {
    const runtime = {
      ctx: { logger: { info() {}, warn() {} } },
      currentThresholds: () => ({ warnRatio: 0.3 }),
      injectBrief: true,
      routerMode: false,
      workItems: { enabled: false },
    };
    const docTool = createRelayTools(runtime).find((definition) => definition.name === 'relay_doc');
    assert.ok(docTool !== undefined, 'relay_doc registered');
    const exec = { agent: { session: { id: 'session-doc-tool', header: { cwd: fx.cwd } } } };
    const index = await docTool.execute({ action: 'index' }, exec);
    assert.equal(index.ok, true);
    assert.match(index.text, /文档索引/);
    const list = await docTool.execute({ action: 'list' }, exec);
    assert.equal(list.ok, true);
    assert.equal(list.shown, 3);
    const all = await docTool.execute({ action: 'list', include: 'all' }, exec);
    assert.equal(all.shown, 4);
    const read = await docTool.execute({ action: 'read', path: 'docs/decisions.md', section: 'D2' }, exec);
    assert.equal(read.ok, true);
    assert.match(read.text, /不丢数据/);
    const search = await docTool.execute({ action: 'search', query: '理由' }, exec);
    assert.equal(search.ok, true);
    assert.ok(search.matches.length >= 2);
    const lint = await docTool.execute({ action: 'lint' }, exec);
    assert.equal(lint.action, 'lint');
    assert.match(lint.text, /relay_doc lint: (PASS|WARN)/);
    const bad = await docTool.execute({ action: 'nope' }, exec);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'invalid-action');
  } finally { fx.cleanup(); }
});

test('scan 白名单 + 最新 handoff 限制：部署暂存目录不污染索引，旧 handoff 仍可 include=all', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-scan-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    // 非白名单目录（部署暂存）不进扫描。
    w(join(r, 'd1-upload', '.scratch', 'context-relay', 'handoff-bogus.md'), '# 暂存副本');
    const base = Date.now() - 60_000;
    for (let i = 0; i < 5; i += 1) {
      const file = join(r, 'handoff-scan-' + i + '.md');
      w(file, '# 交接 ' + i);
      utimesSync(file, new Date(base + i * 1000), new Date(base + i * 1000));
    }
    const index = buildDocIndex(cwd);
    const handoffs = index.entries.filter((entry) => entry.kind === 'handoff');
    assert.equal(handoffs.length, 3, '默认索引只放最新 3 份 handoff');
    assert.ok(handoffs.some((entry) => entry.relPath === 'handoff-scan-4.md'));
    assert.ok(!handoffs.some((entry) => entry.relPath === 'handoff-scan-0.md'));
    const all = buildDocIndex(cwd, { include: 'all' });
    assert.equal(all.entries.filter((entry) => entry.kind === 'handoff').length, 5);
    assert.ok(all.entries.every((entry) => !entry.relPath.startsWith('d1-upload/')), '非白名单目录不扫描');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

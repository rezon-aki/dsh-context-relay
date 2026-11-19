import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildDocIndex, checkSessionDocs, docIndexDigest, DOC_LIMITS, parseFrontmatter, parseRelations, readDoc, relatedDocs, renderDocIndex, searchDocs,
} from '../lib/docs.js';

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

test('buildDocIndex/renderDocIndex：选择后在役/带决策单列、其余按目录折叠、relPath 渲染、digest 稳定', () => {
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
    assert.match(rendered.text, /### 在役（先读）/);
    assert.match(rendered.text, /### 带决策/);
    assert.match(rendered.text, /### 折叠（按目录，展开即取全）/);
    assert.match(rendered.text, /docs\/decisions\.md/);
    assert.ok(!rendered.text.includes('.scratch/context-relay/docs/decisions.md'), '索引用 relay 相对路径');
    // raw/reports 永不单列：只以组行（计数 + 命令）出现。
    assert.match(rendered.text, /reports\/ — 1 份（代表：`reports\/task-1\.md`）· `relay_doc list prefix=reports` 展开/);
    assert.equal(rendered.digest, docIndexDigest(rendered.text));
    assert.equal(docIndexDigest('a'), docIndexDigest('a'));
    assert.notEqual(docIndexDigest('a'), docIndexDigest('b'));
  } finally { fx.cleanup(); }
});

test('renderDocIndex：其余按目录成组（不丢条目、每条省略带命令）；level B/C 是显式机制', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 40; i += 1) {
      w(join(fx.r, 'docs', 'note-' + i + '.md'), '---', 'role: 说明文档 ' + i, 'layer: L2', 'when: 需要时', '---', '# 说明');
    }
    const index = buildDocIndex(fx.cwd);
    const rendered = renderDocIndex(index);
    assert.ok(rendered.bytes <= DOC_LIMITS.indexBytes, 'bytes ' + rendered.bytes);
    assert.equal(rendered.truncated, true, '有折叠组即计入 folded');
    assert.ok(rendered.omitted > 0);
    assert.match(rendered.text, /relay_doc list prefix=docs/);
    assert.match(rendered.text, /docs\/ — 40 份（代表：/);
    assert.equal(index.all.filter((entry) => entry.relPath.startsWith('docs/')).length, 41, '组内 41 份都经 prefix=docs 可达（decisions 单列另有其行）');
    for (const line of rendered.text.split(NL)) {
      if (/未显示|已折叠|另有|份（代表/.test(line)) assert.match(line, /relay_doc/, '省略必须带展开命令：' + line);
    }
    assert.ok(!rendered.text.includes('索引超预算已截断'), '不再用无命令的 clip 兜底');
    // 层级机制：B 只留 pin 单列 + 组行；C = pin + 一行计数（仍带 include=all 命令）。
    const b = renderDocIndex(index, { level: 'B' });
    assert.equal(b.level, 'B');
    assert.match(b.text, /### 折叠（按目录，展开即取全）/);
    assert.doesNotMatch(b.text, /### 带决策/);
    const c = renderDocIndex(index, { level: 'C' });
    assert.equal(c.level, 'C');
    assert.match(c.text, /其余 \d+ 份文档 \/ \d+ 个目录已折叠：`relay_doc list include=all` 展开/);
  } finally { fx.cleanup(); }
});

test('fixture 1,280 份：0 条不可达、0 条无命令省略、raw/reports 永不单列', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-1280-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const fm = (title) => ['---', 'title: ' + title, 'role: ' + title, 'layer: L2', 'when: 需要时', '---', '# ' + title];
    for (let i = 0; i < 600; i += 1) w(join(r, 'architecture', 'a-' + i + '.md'), ...fm('架构 ' + i));
    for (let i = 0; i < 300; i += 1) w(join(r, 'decisions', 'd-' + i + '.md'), ...fm('决策 ' + i));
    for (let i = 0; i < 300; i += 1) w(join(r, 'research', 'r-' + i + '.md'), ...fm('研究 ' + i));
    for (let i = 0; i < 80; i += 1) w(join(r, 'reports', 'task-' + i + '.md'), '# 回执 ' + i);
    // 1,280 份的预算压力下也带 AOCI 标记与 legend/health：pin 一份带 constraints 的架构稿。
    w(join(r, 'architecture', 'a-0.md'), '---', 'title: 架构 0', 'role: 架构 0', 'layer: L2', 'when: 需要时', 'constraints: 先读 docs/a.md; 版本 v1', 'relations: supersedes: architecture/a-1.md', '---', '# 架构 0');
    const index = buildDocIndex(cwd);
    assert.equal(index.all.length, 1280);
    const rendered = renderDocIndex(index, { pins: ['architecture/a-0.md'] });
    assert.ok(rendered.bytes <= DOC_LIMITS.indexBytes, 'bytes ' + rendered.bytes);
    assert.match(rendered.text, /读法：L1 先读 \/ L2 按需；! 约束 · A 契约 · → 关系/, 'legend 在预算压力下仍保留');
    assert.match(rendered.text, /`architecture\/a-0\.md`[^\n]*· !2 →1 · /, '折叠档位仍渲染 constraints/relations 标记');
    assert.match(rendered.text, /索引 [\d.]+KB\/2\.00KB · L1 \d+ \/ L2 \d+ \/ raw \d+/, 'health 行给层计数');
    const prefixes = [...rendered.text.matchAll(/relay_doc list prefix=([^\s`]+)/g)].map((match) => match[1]);
    assert.ok(prefixes.includes('architecture') && prefixes.includes('decisions') && prefixes.includes('research'), '三组都可展开：' + prefixes.join(','));
    const reachable = (rel) => rendered.text.includes('`' + rel + '`')
      || prefixes.some((prefix) => rel === prefix || rel.startsWith(prefix + '/'))
      || rendered.text.includes('relay_doc list include=all');
    const unreachable = index.all.filter((entry) => !reachable(entry.relPath));
    assert.deepEqual(unreachable.map((entry) => entry.relPath), [], '0 条不可达');
    for (const line of rendered.text.split(NL)) {
      if (/未显示|已折叠|另有|份（代表/.test(line)) assert.match(line, /relay_doc/, '无命令省略：' + line);
    }
    for (const line of rendered.text.split(NL)) assert.ok(!/^- `reports\//.test(line), 'raw 单列：' + line);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('AOCI 语义层：constraints/contracts 计数渲染 !n / An，none 不标；L0 legend/health 有界', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-aoci-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const fm = (extra = []) => ['---', 'role: 架构', 'layer: L2', 'when: 改前', ...extra, '---', '# 文档'];
    w(join(r, 'architecture', 'with.md'), ...fm(['constraints: 先读 docs/decisions.md; 预算 2KB; 不改工具名', 'contracts: index 返回 digest']));
    w(join(r, 'architecture', 'none.md'), ...fm(['constraints: none']));
    w(join(r, 'handoff-1.md'), '# 交接');
    w(join(r, 'reports', 'task-1.md'), '# 回执');
    const index = buildDocIndex(cwd);
    const withEntry = index.all.find((entry) => entry.relPath === 'architecture/with.md');
    assert.equal(withEntry.constraintsCount, 3);
    assert.equal(withEntry.contractsCount, 1);
    assert.equal(index.all.find((entry) => entry.relPath === 'architecture/none.md').constraintsCount, 0);
    const rendered = renderDocIndex(index);
    const lineOf = (text, rel) => text.split(NL).find((line) => line.includes(BT + rel + BT)) ?? '';
    assert.match(lineOf(rendered.text, 'architecture/with.md'), /· !3 A1 · /);
    assert.match(rendered.text, /^读法：L1 先读 \/ L2 按需；! 约束 · A 契约 · → 关系$/m);
    assert.match(rendered.text, /^索引 \d+\.\d{2}KB\/2\.00KB · L1 1 \/ L2 2 \/ raw 1$/m);
    assert.ok(rendered.bytes <= DOC_LIMITS.indexBytes, 'bytes ' + rendered.bytes);
    const pinned = renderDocIndex(index, { pins: ['architecture/none.md'] });
    assert.doesNotMatch(lineOf(pinned.text, 'architecture/none.md'), /![0-9]|A[0-9]/, 'none 不渲染标记');
    // 预算压力：每条决策都带 3 条 constraints，标记不挤爆 2KB（降级 A→B）。
    for (let i = 0; i < 120; i += 1) w(join(r, 'decisions', 'd-' + i + '.md'), ...fm(['constraints: a; b; c']));
    const big = renderDocIndex(buildDocIndex(cwd));
    assert.ok(big.bytes <= DOC_LIMITS.indexBytes, 'bytes ' + big.bytes);
    assert.ok(big.level === 'B' || big.level === 'C', '降级到 ' + big.level);
    assert.match(big.text, /^读法：L1 先读 \/ L2 按需；! 约束 · A 契约 · → 关系$/m);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('AOCI relations：解析前缀/白名单/≤8；related 一跳出+入边；lint 坏指针与自环 WARN', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-relations-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const fm = (extra = []) => ['---', 'role: 架构', 'layer: L2', 'when: 改前', 'constraints: none', ...extra, '---', '# 文档'];
    w(join(r, 'architecture', 'a.md'), ...fm(['relations: supersedes: architecture/b.md, implements architecture/c.md; evidence_for: research/e.md']));
    w(join(r, 'architecture', 'b.md'), ...fm(['relations: architecture/a.md']));
    w(join(r, 'architecture', 'c.md'), ...fm());
    w(join(r, 'research', 'e.md'), ...fm());
    w(join(r, 'architecture', 'bad.md'), ...fm(['relations: missing.md, ../escape.md']));
    w(join(r, 'architecture', 'self.md'), ...fm(['relations: architecture/self.md']));
    // frontmatter 解析：类型前缀（: 或空格）、none、去重、≤8 白名单。
    assert.deepEqual(parseRelations('supersedes: docs/a.md, implements docs/b.md; evidence_for: docs/c.md'), [
      { type: 'supersedes', target: 'docs/a.md' },
      { type: 'implements', target: 'docs/b.md' },
      { type: 'evidence_for', target: 'docs/c.md' },
    ]);
    assert.deepEqual(parseRelations('none'), [], 'relations: none = 显式无关系');
    assert.deepEqual(parseRelations('docs/a.md; docs/a.md'), [{ type: '', target: 'docs/a.md' }], '同类型去重');
    assert.equal(parseRelations(Array.from({ length: 10 }, (_, i) => 'docs/x' + i + '.md').join(', ')).length, 8, 'relations ≤8');
    assert.equal(parseRelations('/etc/passwd, ~/x.md, ../x.md')[0].invalid, true, '白名单外的路径标 invalid（lint 提示）');
    const index = buildDocIndex(cwd);
    const a = index.all.find((entry) => entry.relPath === 'architecture/a.md');
    assert.equal(a.relationsCount, 3);
    assert.deepEqual(a.relations.map(({ type, target }) => [type, target]), [
      ['supersedes', 'architecture/b.md'],
      ['implements', 'architecture/c.md'],
      ['evidence_for', 'research/e.md'],
    ]);
    const related = relatedDocs(cwd, 'architecture/a.md');
    assert.equal(related.ok, true);
    assert.deepEqual(related.out.map((edge) => [edge.type, edge.path, edge.exists]), [
      ['supersedes', 'architecture/b.md', true],
      ['implements', 'architecture/c.md', true],
      ['evidence_for', 'research/e.md', true],
    ]);
    assert.deepEqual(related.in, [{ source: 'architecture/b.md', type: '' }], '入边来自反向索引');
    // 一跳即停：b 的出边只回 a，a 的其它关系不递归进 b 的查询。
    const fromB = relatedDocs(cwd, 'architecture/b.md');
    assert.deepEqual(fromB.out.map((edge) => edge.path), ['architecture/a.md']);
    assert.deepEqual(fromB.in, [{ source: 'architecture/a.md', type: 'supersedes' }]);
    assert.equal(relatedDocs(cwd, '.scratch/context-relay/architecture/a.md').path, 'architecture/a.md', '接受 relay 前缀路径');
    assert.equal(relatedDocs(cwd, 'architecture/nope.md').code, 'not-found');
    assert.equal(relatedDocs(cwd, '../outside.md').code, 'invalid-path');
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.ok(check.warnings.some((line) => line.includes('关系坏指针') && line.includes('architecture/bad.md') && line.includes('不存在')));
    assert.ok(check.warnings.some((line) => line.includes('关系坏指针') && line.includes('self.md') && line.includes('自环')));
    assert.ok(!check.warnings.some((line) => line.includes('architecture/a.md →')), '正常关系不报');
    const { docLint } = await import('../lib/lint.js');
    const docs = docLint({ workspaceRoot: cwd, sessionDocs: true }).checks.find((item) => item.name === 'docs');
    assert.match(docs.detail, /关系坏指针/, 'doc_lint 的 docs 检查透出 relations advisory');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
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

test('checkSessionDocs：architecture/decisions 新文档缺 constraints 只 WARN；none/research/无 frontmatter 豁免', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-schema-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const fm = (role, extra = []) => ['---', 'role: ' + role, 'layer: L2', 'when: 改前', ...extra, '---', '# 文档'];
    w(join(r, 'architecture', 'missing.md'), ...fm('架构'));
    w(join(r, 'architecture', 'none.md'), ...fm('架构二', ['constraints: none']));
    w(join(r, 'architecture', 'legacy.md'), '# 无 frontmatter 旧文档');
    w(join(r, 'research', 'r.md'), ...fm('调研'));
    w(join(r, 'reports', 'task.md'), '# 回执');
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.ok(check.warnings.some((line) => line.includes('architecture/missing.md') && line.includes('constraints: none')));
    for (const rel of ['architecture/none.md', 'architecture/legacy.md', 'research/r.md', 'reports/task.md']) {
      assert.ok(!check.warnings.some((line) => line.includes('architecture/decisions 新文档缺 constraints') && line.includes(rel)), rel);
    }
    const { docLint } = await import('../lib/lint.js');
    const lint = docLint({ workspaceRoot: cwd, sessionDocs: true });
    const docs = lint.checks.find((item) => item.name === 'docs');
    assert.equal(docs.ok, false, 'schema advisory 让 docs 检查 WARN');
    assert.match(docs.detail, /缺 constraints/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('relay_doc 工具：index/list/read/search/related/lint 六个动作可用且有界', async () => {
  const { createRelayTools } = await import('../lib/agent/tools.js');
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
    const byPrefix = await docTool.execute({ action: 'list', prefix: '.scratch/context-relay/docs' }, exec);
    assert.equal(byPrefix.ok, true);
    assert.equal(byPrefix.shown, 1);
    assert.deepEqual(byPrefix.entries.map((entry) => entry.path), ['docs/decisions.md']);
    const read = await docTool.execute({ action: 'read', path: 'docs/decisions.md', section: 'D2' }, exec);
    assert.equal(read.ok, true);
    assert.match(read.text, /不丢数据/);
    const search = await docTool.execute({ action: 'search', query: '理由' }, exec);
    assert.equal(search.ok, true);
    assert.ok(search.matches.length >= 2);
    // AOCI R：related 一跳出/入边（fixture 追加两份互引文档），坏路径结构化失败。
    w(join(fx.r, 'docs', 'related-a.md'), '---', 'role: 关联 A', 'layer: L2', 'when: 需要时', 'relations: supersedes: docs/related-b.md', '---', '# A');
    w(join(fx.r, 'docs', 'related-b.md'), '---', 'role: 关联 B', 'layer: L2', 'when: 需要时', 'relations: docs/related-a.md', '---', '# B');
    const related = await docTool.execute({ action: 'related', path: 'docs/related-a.md' }, exec);
    assert.equal(related.ok, true);
    assert.deepEqual(related.out.map((edge) => [edge.type, edge.path]), [['supersedes', 'docs/related-b.md']]);
    assert.deepEqual(related.in, [{ source: 'docs/related-b.md', type: '' }]);
    assert.match(related.text, /out: supersedes docs\/related-b\.md/);
    assert.equal((await docTool.execute({ action: 'related', path: 'docs/nope.md' }, exec)).code, 'not-found');
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

test('v0.8.1 scan：顶层 decisions/archive 分类正确，排除目录在任意层都不扫描', () => {
  const fx = fixture();
  try {
    w(join(fx.r, 'decisions', 'route.md'), '# 路线');
    w(join(fx.r, 'archive', 'handoff-old.md'), '# 历史');
    for (const name of ['tmp', 'logs', 'node_modules', '.git', 'team']) {
      w(join(fx.r, name, 'skip.md'), '# skip');
      w(join(fx.r, 'decisions', name, 'skip.md'), '# skip');
    }
    const all = buildDocIndex(fx.cwd, { include: 'all' });
    assert.equal(all.entries.find((e) => e.relPath === 'decisions/route.md')?.layer, 'L2');
    assert.equal(all.entries.find((e) => e.relPath === 'archive/handoff-old.md')?.layer, 'raw');
    assert.ok(buildDocIndex(fx.cwd).entries.some((e) => e.relPath === 'decisions/route.md'));
    assert.ok(all.entries.every((e) => !e.relPath.endsWith('skip.md')));
  } finally { fx.cleanup(); }
});

test('v0.8.1 readDoc：>512KB 的 offset/section 可继续读，页有界且保留 UTF-8 原文', () => {
  const fx = fixture();
  try {
    const prefix = '# 文档\n' + '前文内容\n'.repeat(45000);
    const tail = '## 最后章节\n' + Array.from({ length: 12 }, (_, i) => '末尾-' + i).join('\n') + '\n## 下一章\n不要包含\n';
    writeFileSync(join(fx.r, 'docs', 'large.md'), prefix + tail);
    assert.ok(Buffer.byteLength(prefix + tail) > DOC_LIMITS.maxReadBytes);
    const page = readDoc(fx.cwd, 'docs/large.md', { offset: 45001, limit: 3 });
    assert.equal(page.ok, true);
    assert.match(page.text, /最后章节/);
    assert.equal(page.nextOffset, 45004);
    const next = readDoc(fx.cwd, 'docs/large.md', { offset: page.nextOffset, byteOffset: page.nextByteOffset, limit: 3 });
    assert.equal(next.ok, true);
    assert.match(next.text, /末尾-2/);
    const section = readDoc(fx.cwd, 'docs/large.md', { section: '最后章节', offset: 2, limit: 3 });
    assert.equal(section.ok, true);
    assert.equal(section.nextOffset, 5);
    assert.match(section.text, /末尾-1/);
    assert.doesNotMatch(section.text, /不要包含/);
    assert.ok(Buffer.byteLength(section.text) <= DOC_LIMITS.readBytes);
    assert.equal(readDoc(fx.cwd, 'docs/large.md', { byteOffset: -1 }).code, 'invalid-offset');
  } finally { fx.cleanup(); }
});

test('v0.8.1 readDoc：超长单行完整分页，不整读、不越过字节预算、不损失多字节字符', () => {
  const fx = fixture();
  try {
    const text = '汉🙂'.repeat(80000) + '\n最后一行';
    writeFileSync(join(fx.r, 'docs', 'one-line.md'), text);
    assert.equal(readDoc(fx.cwd, 'docs/one-line.md', { byteOffset: 1 }).code, 'invalid-offset');
    const pages = [];
    let offset = 0, byteOffset;
    for (let i = 0; i < 100; i += 1) {
      const page = readDoc(fx.cwd, 'docs/one-line.md', { offset, byteOffset });
      assert.equal(page.ok, true);
      assert.ok(Buffer.byteLength(page.text) <= DOC_LIMITS.readBytes);
      assert.doesNotMatch(page.text, /�/);
      pages.push(page.text);
      if (!page.truncated) break;
      assert.ok(page.nextByteOffset > (byteOffset ?? 0));
      offset = page.nextOffset; byteOffset = page.nextByteOffset;
    }
    assert.equal(pages.join(''), text);
  } finally { fx.cleanup(); }
});

test('v0.8.1 lint：覆盖全部 L1/L2、深层与大文件，坏路径/版本/seq 都给出可操作诊断', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 12; i += 1) w(join(fx.r, 'handoff-' + i + '.md'), '# H', BT + 'docs/missing-' + i + '.md' + BT);
    w(join(fx.r, 'docs', 'target.md'), '---', 'version: 2', '---', '# Target');
    w(join(fx.r, 'decisions', 'a', 'b', 'c', 'd', 'deep.md'), '[missing](missing-deep.md)', BT + 'docs/target.md#version=1' + BT, BT + 'docs/target.md#seq=9-2' + BT, 'session_event_read({session_id:"s", seq:-1})');
    w(join(fx.r, 'docs', 'huge.md'), 'x'.repeat(530000) + BT + 'docs/beyond-limit.md' + BT);
    symlinkSync('/etc/passwd', join(fx.r, 'docs', 'outside.md'));
    w(join(fx.r, 'decisions', 'unsafe.md'), BT + 'docs/outside.md' + BT);
    w(join(fx.r, 'chain.ndjson'), JSON.stringify({v: 2, sessionId: '', shadowedStart: 9, shadowedEnd: 2, briefPath: 'docs/missing-chain.md'}), '{bad json}');
    const check = checkSessionDocs({ workspaceRoot: fx.cwd });
    for (let i = 0; i < 12; i += 1) assert.ok(check.pointers.some((p) => p.path === 'docs/missing-' + i + '.md'));
    for (const path of ['missing-deep.md', 'docs/beyond-limit.md', 'docs/missing-chain.md']) assert.ok(check.pointers.some((p) => p.path === path), path);
    for (const reason of ['路径或符号链接越出', '版本不匹配', 'seq 范围倒置', '来源 session_id 或 seq', '索引版本', '来源 sessionId', 'seq 遮蔽区间', '索引 JSON']) assert.ok(check.pointers.some((p) => p.reason.includes(reason)), reason);
    assert.ok(check.pointers.every((p) => p.source && p.path && p.reason && p.suggestion));
    assert.match(check.seqVerification, /unknown/);
    assert.equal(check.level, 'soft');
  } finally { fx.cleanup(); }
});


test('v0.8.1 index：缺省元数据显式 unknown，大文件仍识别 frontmatter', () => {
  const fx = fixture();
  try {
    w(join(fx.r, 'docs', 'unknown.md'), '# 无元数据');
    w(join(fx.r, 'docs', 'metadata.md'), '---', 'title: 大文件', 'role: 详细事实', 'when: 修改事实前', 'layer: L2', 'owner: author', 'updated: 2026-11-15', '---', 'x'.repeat(530000));
    const all = buildDocIndex(fx.cwd, { include: 'all' });
    const unknown = all.entries.find((e) => e.relPath === 'docs/unknown.md');
    for (const key of ['title', 'role', 'when', 'owner', 'updated']) assert.equal(unknown[key], 'unknown', key);
    const large = all.entries.find((e) => e.relPath === 'docs/metadata.md');
    assert.equal(large.role, '详细事实');
    assert.equal(large.source, 'frontmatter');
  } finally { fx.cleanup(); }
});

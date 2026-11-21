import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildDocIndex, checkSessionDocs, docIndexDigest, DOC_LIMITS, parseFrontmatter, parseRelations, parseRelationsDetailed, readDoc, relatedDocs, renderDocIndex,
  scanLimitWarnings, searchDocs,
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
    assert.equal(DOC_LIMITS.indexBytes, 0, '索引字节预算缺省 0 = 不限（去折叠）');
    assert.equal(rendered.level, 'A');
    assert.equal(rendered.truncated, false);
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
    assert.equal(rendered.level, 'A', '缺省不再按字节/列宽降级');
    // fix2：折叠组有命令可回取，不算 truncated；只有显式字节护栏超限/扫描触顶才算。
    assert.equal(rendered.truncated, false, '有折叠组但有展开命令 → 不算 truncated');
    assert.equal(renderDocIndex(index, { maxBytes: 1 }).truncated, true, '显式字节护栏超限才 truncated');
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
    // 去折叠（本次修复）：旧 2048B 护栏把这里压成 C（shown=5）；现在 A 层全单列，无 pin 也显示。
    const noPin = renderDocIndex(index);
    assert.equal(noPin.level, 'A', '缺省 A 层（300 份 decisions 全单列）：' + noPin.level);
    assert.ok(noPin.bytes > 2048, 'bytes ' + noPin.bytes);
    assert.equal(noPin.truncated, false);
    assert.ok(noPin.shown > 0, '无 pin 时仍有单列（shown=' + noPin.shown + '）');
    const rendered = renderDocIndex(index, { pins: ['architecture/a-0.md'] });
    assert.match(rendered.text, /读法：L1 先读 \/ L2 按需；! 约束 · A 契约 · → 关系/, 'legend 在去折叠后仍保留');
    assert.match(rendered.text, /`architecture\/a-0\.md`[^\n]*· !2 →1 · /, '单列仍渲染 constraints/relations 标记');
    assert.match(rendered.text, /索引 [\d.]+KB\/不限 · L1 \d+ \/ L2 \d+ \/ raw \d+/, 'health 行给层计数 + 不限预算');
    const prefixes = [...rendered.text.matchAll(/relay_doc list prefix=([^\s`]+)/g)].map((match) => match[1]);
    // decisions/ 300 份现在都是 A 层单列（去折叠），不再成组；architecture/research/reports 仍有组行可展开。
    assert.ok(prefixes.includes('architecture') && prefixes.includes('research') && prefixes.includes('reports'), '组行可展开：' + prefixes.join(','));
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
    assert.match(rendered.text, /^索引 \d+\.\d{2}KB\/不限 · L1 1 \/ L2 2 \/ raw 1$/m);
    assert.equal(rendered.truncated, false);
    const pinned = renderDocIndex(index, { pins: ['architecture/none.md'] });
    assert.doesNotMatch(lineOf(pinned.text, 'architecture/none.md'), /![0-9]|A[0-9]/, 'none 不渲染标记');
    // 去折叠：120 份带 constraints 的决策默认全单列（不再因 2KB 字节降级 A→B/C），标记仍渲染。
    for (let i = 0; i < 120; i += 1) w(join(r, 'decisions', 'd-' + i + '.md'), ...fm(['constraints: a; b; c']));
    const big = renderDocIndex(buildDocIndex(cwd));
    assert.equal(big.level, 'A', '去折叠后保持 A 层：' + big.level);
    assert.ok(big.bytes > 2048, 'bytes ' + big.bytes);
    assert.ok(big.shown >= 120);
    assert.equal(big.truncated, false);
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
    // 活跃文档（L1 handoff/progress）坏指针 → hard（docLint 汇总 FAIL）；其余 warning 仍保留。
    assert.equal(check.level, 'hard');
    assert.equal(check.ok, false);
    assert.ok(check.activePointers > 0);
    assert.ok(check.pointers.some((item) => item.severity === 'fail' && item.source.startsWith('handoff-2.md')));
    assert.ok(check.warnings.some((line) => line.includes('frontmatter')));
    assert.ok(check.warnings.some((line) => line.includes('坏指针')));
    assert.ok(check.warnings.some((line) => line.includes('活跃')));
    assert.ok(check.warnings.some((line) => line.includes('advisory')));
    const empty = checkSessionDocs({ workspaceRoot: mkdtempSync(join(tmpdir(), 'relay-docs-empty-')) });
    assert.equal(empty.ok, true);
  } finally { fx.cleanup(); }
});

test('checkSessionDocs：constraints 覆盖全部 L2（缺就 WARN）；none 与 raw 豁免', async () => {
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
    // 原规则只查 architecture/decisions；现在 constraints 覆盖全部 L2（含 research 与无 frontmatter 的旧文档）。
    for (const rel of ['architecture/missing.md', 'architecture/legacy.md', 'research/r.md']) {
      assert.ok(check.warnings.some((line) => line.includes('L2 缺 constraints') && line.includes(rel)), rel);
    }
    for (const rel of ['architecture/none.md', 'reports/task.md']) {
      assert.ok(!check.warnings.some((line) => line.includes('L2 缺 constraints') && line.includes(rel)), rel);
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
    // L1 handoff 的坏指针是活跃文档 → hard（此前全 soft，374 条从不 FAIL）。
    assert.equal(check.level, 'hard');
    assert.ok(check.pointers.filter((item) => item.severity === 'fail').length > 0);
  } finally { fx.cleanup(); }
});


test('去折叠实测：A 层约 3KB（>原 2048B 护栏）仍单列、无 pin 也显示、health 标不限', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-unfold-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const role = '关键文档的作用说明，故意写长以逼近真实 workspace 的 A 层 3034B 索引（无 pin 也必须显示）';
    const when = '新会话接手或压缩后先读这一份，拿到完整上下文后再继续当前 phase';
    const fm = (title, extra = []) => ['---', 'title: ' + title, 'role: ' + role, 'layer: L1', 'when: ' + when, ...extra, '---', '# ' + title];
    const base = Date.now() - 60_000;
    ['handoff-a.md', 'handoff-b.md', 'handoff-c.md', 'phase-build-1.md', 'phase-ship-1.md', 'progress.md', 'lessons.md'].forEach((name, index) => {
      const file = join(r, name);
      w(file, ...fm(name));
      utimesSync(file, new Date(base + index * 1000), new Date(base + index * 1000));
    });
    for (let i = 0; i < 10; i += 1) w(join(r, 'docs', 'note-' + i + '.md'), '---', 'role: 普通文档 ' + i, 'layer: L2', 'when: 需要时', 'constraints: none', '---', '# 说明');
    const index = buildDocIndex(cwd);
    const rendered = renderDocIndex(index);
    // 实测：旧 2048B 护栏下这份 A 层会降级 C/B（无 pin 时 shown=0）；去折叠后 A 层保持原样。
    assert.ok(rendered.bytes > 2048, 'A 层字节应超过旧护栏：' + rendered.bytes);
    assert.equal(rendered.level, 'A');
    assert.equal(rendered.truncated, false);
    assert.equal(rendered.shown, 7, '7 条在役单列都在，无 pin 也显示');
    for (const name of ['handoff-a.md', 'phase-build-1.md', 'progress.md', 'lessons.md']) assert.ok(rendered.text.includes(name), name);
    assert.match(rendered.text, /^索引 \d+\.\d{2}KB\/不限 · L1 7 \/ L2 10 \/ raw 0$/m);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('relations 超上限不静默：relationsOverflow 计数 + lint WARN', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-relations-overflow-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const many = Array.from({ length: 10 }, (_, i) => 'docs/x' + i + '.md').join(', ');
    w(join(r, 'architecture', 'many.md'), '---', 'role: 架构', 'layer: L2', 'when: 改前', 'constraints: none', 'relations: ' + many, '---', '# 文档');
    assert.equal(parseRelations(many).length, 8, '解析仍截到上限 8');
    assert.equal(parseRelationsDetailed(many).overflow, 2, '多出的 2 条被计数');
    const index = buildDocIndex(cwd, { include: 'all' });
    const entry = index.all.find((item) => item.relPath === 'architecture/many.md');
    assert.equal(entry.relationsOverflow, 2);
    assert.equal(index.counts.relationOverflow, 1);
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.ok(check.warnings.some((line) => line.includes('relations 超上限') && line.includes('architecture/many.md') && line.includes('2 条未解析')));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('扫描深度/文件数超限：默认索引看不到的部分 WARN + deepDirs，exhaustive 仍全量', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-deep-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    w(join(r, 'docs', 'a', 'b', 'c', 'd', 'deep.md'), '# 深层', '读 ' + BT + 'docs/missing-deep.md' + BT);
    const shallow = buildDocIndex(cwd, { include: 'all' });
    assert.ok(!shallow.all.some((entry) => entry.relPath.endsWith('deep.md')), '默认扫描不进入第 5 层');
    assert.equal(shallow.truncated, true);
    assert.deepEqual(shallow.deepDirs, ['docs/a/b/c/d']);
    assert.equal(shallow.counts.deep, 1);
    const full = buildDocIndex(cwd, { exhaustive: true, include: 'all' });
    assert.ok(full.all.some((entry) => entry.relPath === 'docs/a/b/c/d/deep.md'), 'exhaustive 仍全量检查');
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.ok(check.warnings.some((line) => line.includes('默认扫描深度 4') && line.includes('docs/a/b/c/d')));
    assert.deepEqual(check.deepDirs, ['docs/a/b/c/d']);
    // 4000 文件上限不在测试里造 4000 份：纯函数直接验计数与命令。
    assert.match(scanLimitWarnings({ total: 4001 }).join('；'), /超默认扫描上限 4000/);
    assert.deepEqual(scanLimitWarnings({ total: 4000 }), [], '恰好 4000 份仍能全扫，不算截断');
    assert.deepEqual(scanLimitWarnings({ total: 3 }), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('坏指针分级：活跃文档 FAIL、L2/raw 只 WARN；docLint 汇总 FAIL/ WARN', async () => {
  const { docLint } = await import('../lib/lint.js');
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-severity-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const fm = (role, extra = []) => ['---', 'role: ' + role, 'layer: L2', 'when: 需要时', 'constraints: none', ...extra, '---'];
    w(join(r, 'handoff-a.md'), '# 交接', '读 ' + BT + 'docs/missing-active.md' + BT);
    w(join(r, 'architecture', 'a.md'), ...fm('架构'), '看 ' + BT + 'docs/missing-arch.md' + BT);
    w(join(r, 'research', 'r.md'), ...fm('调研'), '看 ' + BT + 'docs/missing-research.md' + BT);
    w(join(r, 'reports', 'task.md'), '# 回执', '看 ' + BT + 'docs/missing-report.md' + BT);
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.equal(check.level, 'hard', '有活跃坏指针 → hard');
    const severity = new Map(check.pointers.map((item) => [item.path, item.severity]));
    assert.equal(severity.get('docs/missing-active.md'), 'fail', 'L1 handoff');
    assert.equal(severity.get('docs/missing-arch.md'), 'fail', 'architecture 当前');
    assert.equal(severity.get('docs/missing-research.md'), 'warn', '普通 L2');
    assert.equal(severity.get('docs/missing-report.md'), 'warn', 'raw/reports');
    assert.equal(check.activePointers, 2);
    assert.equal(check.advisoryPointers, 2);
    assert.equal(check.pointersOmitted, 0);
    assert.deepEqual(check.advisoryReasons, { 目标不存在: 2 });
    assert.match(check.warnings.join('；'), /坏指针 4 条（活跃 2 → FAIL \/ 其余 2 → WARN；advisory 原因 目标不存在 x2）/);
    assert.match(check.warnings.join('；'), /结构化 pointers 保留活跃全部 \+ 前 20 条 advisory/);
    const failed = docLint({ workspaceRoot: cwd, sessionDocs: true });
    assert.equal(failed.level, 'FAIL', '活跃坏指针让 doc_lint 汇总 FAIL');
    assert.equal(failed.checks.find((item) => item.name === 'docs').level, 'hard');

    // 只有 L2/raw 坏指针时：docs 只 WARN，不 FAIL。
    const soft = mkdtempSync(join(tmpdir(), 'relay-docs-severity-soft-'));
    try {
      const sr = join(soft, '.scratch', 'context-relay');
      w(join(sr, 'research', 'r.md'), ...fm('调研'), '看 ' + BT + 'docs/missing-research.md' + BT);
      w(join(sr, 'reports', 'task.md'), '# 回执', '看 ' + BT + 'docs/missing-report.md' + BT);
      const softCheck = checkSessionDocs({ workspaceRoot: soft });
      assert.equal(softCheck.level, 'soft');
      assert.equal(softCheck.activePointers, 0);
      assert.equal(docLint({ workspaceRoot: soft, sessionDocs: true }).level, 'WARN');
    } finally { rmSync(soft, { recursive: true, force: true }); }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('contracts/updated 陈旧：缺 updated、格式无效、超 90 天都 WARN；新鲜文档不报', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-stale-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const fm = (extra = []) => ['---', 'role: 架构', 'layer: L2', 'when: 需要时', 'constraints: none', ...extra, '---', '# 文档'];
    w(join(r, 'architecture', 'stale.md'), ...fm(['updated: 2020-01-01']));
    w(join(r, 'architecture', 'invalid.md'), ...fm(['updated: 2026/01/01']));
    w(join(r, 'architecture', 'contracts.md'), ...fm(['contracts: index 返回 digest']));
    w(join(r, 'architecture', 'fresh.md'), ...fm(['updated: ' + new Date().toISOString().slice(0, 10)]));
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.ok(check.warnings.some((line) => line.includes('updated 陈旧') && line.includes('architecture/stale.md')), '超 90 天');
    assert.ok(check.warnings.some((line) => line.includes('updated 格式无效') && line.includes('architecture/invalid.md')), '格式无效');
    assert.ok(check.warnings.some((line) => line.includes('contracts 文档缺 updated') && line.includes('architecture/contracts.md')), 'contracts 无 updated');
    assert.ok(!check.warnings.some((line) => line.includes('architecture/fresh.md')), '新鲜文档不进 updated warning');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('advisory pointers 有界：前 20 条进结构化清单，其余按原因计数（不静默、也不无界膨胀）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-pointer-cap-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    for (let i = 0; i < 30; i += 1) w(join(r, 'reports', 'task-' + i + '.md'), '# 回执 ' + i, '看 ' + BT + 'docs/missing-' + i + '.md' + BT);
    const check = checkSessionDocs({ workspaceRoot: cwd });
    assert.equal(check.level, 'soft', 'raw/reports 只 WARN，不 FAIL');
    assert.equal(check.advisoryPointers, 30);
    assert.equal(check.pointers.length, 20, '只保留前 20 条 advisory 明细');
    assert.equal(check.pointersOmitted, 10);
    assert.deepEqual(check.advisoryReasons, { 目标不存在: 30 });
    assert.match(check.warnings.join('；'), /其余 10 条只计数/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('progress.key_docs 超 PIN_LIMIT 不静默：lint WARN 报保留/丢弃数', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-docs-pin-overflow-'));
  try {
    const r = join(cwd, '.scratch', 'context-relay');
    const keys = Array.from({ length: 35 }, (_, i) => 'docs/p' + i + '.md');
    w(join(r, 'progress.md'), '# 进度', '', '<!-- relay-progress:json', JSON.stringify({ key_docs: keys }), '-->');
    const check = checkSessionDocs({ workspaceRoot: cwd });
    const line = check.warnings.find((item) => item.includes('progress.key_docs'));
    assert.ok(line, '超 PIN_LIMIT 要给 WARN：' + check.warnings.join('；'));
    assert.match(line, /32\/35 保留，3 条未展示/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
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

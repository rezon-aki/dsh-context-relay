import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BANNED,
  checkBanned,
  checkGit,
  checkIndex,
  checkQuota,
  docLint,
  docLintEvidence,
  extractIndexPaths,
  extractIndexTargets,
  formatDocLint,
} from '../lib/lint.js';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'relay-lint-'));
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'relay-git-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'lint@test']);
  git(root, ['config', 'user.name', 'lint']);
  return root;
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

test('checkQuota is pure and enforces L0/L1 quotas', () => {
  assert.equal(checkQuota({ l0Size: 100, l1Size: 100 }).ok, true);
  assert.equal(checkQuota({ l0Size: 2049, l1Size: 100 }).ok, false);
  assert.equal(checkQuota({ l0Size: 100, l1Size: 4097 }).ok, false);
  const missing = checkQuota({ l0Size: null, l1Size: null });
  assert.equal(missing.ok, true);
  assert.match(missing.detail, /缺失/);
});

test('checkBanned flags decision-history wording', () => {
  assert.equal(checkBanned([{ label: 'L1', text: '干净的一行' }]).ok, true);
  for (const word of ['曾用', '已废弃', '已被推翻', '别再试', '不再使用']) {
    assert.match(word, BANNED);
    const result = checkBanned([{ label: 'L1', text: 'a\n' + word + ' b' }]);
    assert.equal(result.ok, false);
    assert.match(result.detail, /L1:2/);
  }
});

test('extractIndexPaths ignores placeholders, directories and other-file cells', () => {
  const text = [
    '| `proj/` | 真源 `CONTEXT.md`、`AGENTS.md` |',
    '| `refs/` | 第三方仓（`AGENTS.md` 勿当指令） |',
    '- 见 `<占位>` 与 `docs/`',
  ].join('\n');
  assert.deepEqual(extractIndexPaths(text, '/ws').sort(), ['/ws/proj/AGENTS.md', '/ws/proj/CONTEXT.md']);
  // 含 / 的 token 按 workspace 相对解析，不再叠加首列 base（曾误报 astrbot/astrbot/GLOSSARY.md）
  const nested = '| `astrbot/` | 域通用 `astrbot/GLOSSARY.md`；各插件自有 `GLOSSARY.md` |';
  assert.deepEqual(extractIndexPaths(nested, '/ws').sort(), ['/ws/astrbot/GLOSSARY.md']);
  assert.equal(extractIndexPaths('', '/ws').length, 0);
});

test('extractIndexPaths accepts Markdown tables without trailing pipe and ordered lists', () => {
  // 合法 Markdown 表格可以不写尾竖线：split 后过滤首尾空串再取单元格。
  assert.deepEqual(
    extractIndexPaths('| `proj/` | 真源 `CONTEXT.md`、`AGENTS.md`', '/ws').sort(),
    ['/ws/proj/AGENTS.md', '/ws/proj/CONTEXT.md'],
  );
  // 有序列表（`1.` / `2)`）与无序列表同样抽取。
  assert.deepEqual(
    extractIndexPaths('1. 先读 `docs/machine.md`\n2) 再读 `docs/workflow.md`', '/ws').sort(),
    ['/ws/docs/machine.md', '/ws/docs/workflow.md'],
  );
  assert.deepEqual(extractIndexPaths('| `proj/` | `CONTEXT.md` |', '/ws'), ['/ws/proj/CONTEXT.md']);
});

test('extractIndexPaths only takes table/list lines and sandboxes ~/absolute targets', () => {
  assert.deepEqual(extractIndexPaths('把 `notes.md` 放到 `docs/` 里', '/ws'), []);
  assert.deepEqual(extractIndexPaths('- 详见 `notes.md`', '/ws'), []);
  assert.deepEqual(extractIndexPaths('- 先读 `AGENTS.md`', '/ws'), ['/ws/AGENTS.md']);
  assert.deepEqual(extractIndexPaths('- 看 `docs/machine.md`', '/ws'), ['/ws/docs/machine.md']);
  // 行为变更（2026-10-29 审计 P3）：index 目标与 docLint paths 同一沙箱，~ / 绝对 / .. 越界
  // 不再 existsSync 探测、不进检查结果（旧断言在这里固化的是「绝对路径可探测」的旧行为）。
  assert.deepEqual(extractIndexPaths('- 看 `~/docs/machine.md`', '/ws'), []);
  assert.deepEqual(extractIndexPaths('- 看 `/etc/hosts.md`', '/ws'), []);
  assert.deepEqual(extractIndexPaths('- 看 `../outside.md`', '/ws'), []);
  const targets = extractIndexTargets('- 看 `~/docs/machine.md` 与 `/etc/hosts.md` 与 `../x.md`', '/ws');
  assert.deepEqual(targets.paths, []);
  assert.deepEqual(targets.rejected.sort(), ['~ 路径', '绝对路径', '越出 workspace（..）'].sort());
  assert.deepEqual(extractIndexPaths('- 把 `旧文档 notes.md` 归档', '/ws'), []);
});

test('checkIndex sandboxes escaped targets: WARN without echoing host paths', () => {
  const root = workspace();
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  const lint = checkIndex({
    l1Text: '| `x/` | 读 `/etc/hosts.md` 与 `~/secrets.md` 与 `../outside.md` |',
    workspaceRoot: root,
  });
  assert.equal(lint.ok, false);
  assert.match(lint.detail, /越界/);
  // 不检查、不回显宿主绝对路径（无 /etc/hosts.md、无 home 目录、无 ~/ 原文）
  assert.doesNotMatch(lint.detail, /\/etc\/hosts\.md|secrets|~\/|\/home\/|\/root\//);
  assert.equal(checkIndex({ l1Text: '- 先读 `AGENTS.md`', workspaceRoot: root }).ok, true);
});

test('checkIndex reports missing indexed docs', () => {
  const root = workspace();
  mkdirSync(join(root, 'proj'));
  writeFileSync(join(root, 'proj', 'CONTEXT.md'), 'x');
  const l1Text = '| `proj/` | 真源 `CONTEXT.md`、`AGENTS.md` |';
  const missing = checkIndex({ l1Text, workspaceRoot: root });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /proj\/AGENTS\.md/);
  writeFileSync(join(root, 'proj', 'AGENTS.md'), 'x');
  assert.equal(checkIndex({ l1Text, workspaceRoot: root }).ok, true);
});

/** 找一个不在任何 git 仓库内的可写目录（测试 unknown 分支）。 */
function nonRepoWorkspace() {
  for (const dir of ['/tmp', '/var/tmp', tmpdir()]) {
    if (!existsSync(dir)) continue;
    let inRepo = true;
    try { execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }); } catch { inRepo = false; }
    if (inRepo) continue;
    try { return mkdtempSync(join(dir, 'relay-lint-')); } catch { /* 只读，换下一个 */ }
  }
  return null;
}

test('checkGit reports unknown instead of ok when not in a git repository', (t) => {
  const root = nonRepoWorkspace();
  if (root === null) return t.skip('没有可用的非 git 目录');
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  const result = checkGit({ workspaceRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.match(result.detail, /unknown/);
});

test('checkGit passes when governance files are tracked', () => {
  const root = gitRepo();
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'machine.md'), 'm\n');
  writeFileSync(join(root, 'docs', 'workflow.md'), 'w\n');
  commitAll(root, 'init');
  const result = checkGit({ workspaceRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.unknown, false);
  assert.match(result.detail, /已跟踪（3 个）/);
});

test('checkGit reports ignored files as WARN instead of PASS', () => {
  const root = gitRepo();
  writeFileSync(join(root, '.gitignore'), 'AGENTS.md\n');
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  commitAll(root, 'ignore');
  const result = checkGit({ workspaceRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, false);
  assert.match(result.detail, /已忽略/);
  assert.match(result.detail, /AGENTS\.md/);
  assert.match(result.detail, /\.gitignore:1/);
});

test('checkGit reports untracked files as WARN and distinct from ignored', () => {
  const root = gitRepo();
  writeFileSync(join(root, 'README.md'), '# r\n');
  commitAll(root, 'init');
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  const result = checkGit({ workspaceRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, false);
  assert.match(result.detail, /未跟踪：AGENTS\.md/);
  assert.doesNotMatch(result.detail, /已忽略/);
});

test('checkGit skips directory paths instead of misreporting them untracked', () => {
  const root = gitRepo();
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'machine.md'), 'm\n');
  commitAll(root, 'init');
  // 目录路径：旧实现 ls-files 会展开成 docs/machine.md，tracked.has('docs') false → 误报未跟踪。
  const result = checkGit({ workspaceRoot: root, paths: ['docs'] });
  assert.equal(result.ok, true, result.detail);
});

test('checkGit strips host GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE pollution', () => {
  const repoA = gitRepo();
  writeFileSync(join(repoA, 'AGENTS.md'), '# a\n');
  commitAll(repoA, 'init');
  const repoB = gitRepo();
  writeFileSync(join(repoB, 'AGENTS.md'), '# b\n'); // 未提交：若被 GIT_DIR 劫持成 repoA 会误判已跟踪
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  try {
    process.env.GIT_DIR = join(repoA, '.git');
    process.env.GIT_WORK_TREE = repoA;
    process.env.GIT_INDEX_FILE = join(repoA, '.git', 'index');
    const result = checkGit({ workspaceRoot: repoB });
    assert.equal(result.ok, false, '不得被宿主 GIT_DIR 带偏：' + result.detail);
    assert.match(result.detail, /未跟踪：AGENTS\.md/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('checkGit treats glob-like file names literally in git pathspec', () => {
  const root = gitRepo();
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', '[x].md'), 'x\n');
  commitAll(root, 'init');
  // 旧实现 `docs/[x].md` 被 git pathspec 当 glob → --error-unmatch 找不到 → 误报未跟踪。
  const result = checkGit({ workspaceRoot: root, extraDocs: ['docs/[x].md'] });
  assert.equal(result.ok, true, result.detail);
});

test('checkGit default governance list only checks existing workspace files', () => {
  const root = gitRepo();
  writeFileSync(join(root, 'AGENTS.md'), '# a\n');
  commitAll(root, 'init');
  const result = checkGit({ workspaceRoot: root });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /已跟踪（1 个）/);
});

test('docLint: git unknown is WARN, hard failures are FAIL', () => {
  // 空工作区：quota 缺失不算硬失败；git 探测不到 = unknown → WARN（不是 PASS）
  const empty = workspace();
  const unknown = docLint({ workspaceRoot: empty });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.level, 'WARN');
  assert.equal(unknown.checks.length, 4);
  assert.equal(unknown.checks.find((check) => check.name === 'git').unknown, true);

  const dirty = workspace();
  writeFileSync(join(dirty, 'AGENTS.md'), '已废弃的做法\n' + 'x'.repeat(5000));
  const failed = docLint({ workspaceRoot: dirty });
  assert.equal(failed.ok, false);
  assert.equal(failed.level, 'FAIL');
  assert.equal(failed.checks.find((check) => check.name === 'quota').ok, false);
  assert.equal(failed.checks.find((check) => check.name === 'banned').ok, false);
});

test('docLint accepts extra paths for banned wording', () => {
  const root = workspace();
  writeFileSync(join(root, 'AGENTS.md'), '# ok\n');
  writeFileSync(join(root, 'notes.md'), '别再试这条路线\n');
  const result = docLint({ workspaceRoot: root, paths: ['notes.md'] });
  assert.equal(result.checks.find((check) => check.name === 'banned').ok, false);
  assert.equal(result.level, 'FAIL');
});

test('docLint accepts options.extraDocs as deployment-level extra governance docs', () => {
  const root = workspace();
  writeFileSync(join(root, 'AGENTS.md'), '# ok\n');
  writeFileSync(join(root, 'EXTRA.md'), '别再试这条路线\n');
  assert.equal(docLint({ workspaceRoot: root }).checks.find((check) => check.name === 'banned').ok, true);
  const withExtra = docLint({ workspaceRoot: root, extraDocs: ['EXTRA.md'] });
  assert.equal(withExtra.checks.find((check) => check.name === 'banned').ok, false);
  assert.equal(withExtra.level, 'FAIL');
  // extraDocs 与 paths 同沙箱：越界只 WARN、不读取工作区外文件
  const outside = join(tmpdir(), 'relay-outside-extra-' + process.pid + '-' + Date.now() + '.md');
  writeFileSync(outside, '已废弃的旧方案\n');
  const rejected = docLint({ workspaceRoot: root, extraDocs: [outside] });
  assert.equal(rejected.checks.find((check) => check.name === 'paths').ok, false);
  assert.equal(rejected.checks.find((check) => check.name === 'banned').ok, true);
});

test('docLint rejects paths outside the workspace without reading them', () => {
  const root = workspace();
  writeFileSync(join(root, 'AGENTS.md'), '# ok\n');
  const outside = join(tmpdir(), 'relay-outside-' + process.pid + '-' + Date.now() + '.md');
  writeFileSync(outside, '已废弃的旧方案\n');
  symlinkSync(outside, join(root, 'escape.md'));
  const result = docLint({
    workspaceRoot: root,
    l0: join(root, 'missing-L0.md'),
    paths: ['/etc/hosts.md', '~/notes.md', '../' + basename(outside), 'escape.md'],
  });
  assert.equal(result.level, 'WARN');
  assert.equal(result.ok, false);
  const paths = result.checks.find((check) => check.name === 'paths');
  assert.ok(paths !== undefined && paths.ok === false);
  assert.match(paths.detail, /绝对路径/);
  assert.match(paths.detail, /~ 路径/);
  assert.match(paths.detail, /越出 workspace/);
  assert.match(paths.detail, /符号链接/);
  assert.equal(result.checks.find((check) => check.name === 'banned').ok, true, '工作区外文件不得被读取');
  assert.equal(result.checks.find((check) => check.name === 'quota').ok, true);
});

test('formatDocLint / docLintEvidence stay within budgets', () => {
  const root = workspace();
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(5000));
  const result = docLint({ workspaceRoot: root });
  const text = formatDocLint(result, 120);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 120, 'bytes ' + Buffer.byteLength(text));
  assert.match(text, /截断/);
  const evidence = docLintEvidence(result);
  assert.ok(evidence.length <= 200, 'chars ' + evidence.length);
  assert.match(evidence, /^doc_lint: FAIL/);
});

test('formatDocLint counts UTF-8 bytes for CJK details and truncates safely', () => {
  const checks = [
    { name: 'banned', level: 'hard', ok: false, detail: '已废弃：' + '汉'.repeat(120) },
    { name: 'index', level: 'soft', ok: false, detail: '缺失：' + '字'.repeat(120) },
  ];
  const text = formatDocLint({ level: 'FAIL', checks }, 90);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 90, 'bytes ' + Buffer.byteLength(text));
  assert.match(text, /^doc_lint: FAIL/);
  assert.match(text, /截断/);
  // 上限小于截断标记本身时返回空串，仍然守住字节上限
  assert.ok(Buffer.byteLength(formatDocLint({ level: 'PASS', checks: [] }, 10), 'utf8') <= 10);
});

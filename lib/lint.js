/**
 * dsh-context-relay — 文档体系体检（只读、零依赖；吸收自 dsh-doc-kit/lib/lint.js）。
 *
 * 四项检查：
 *   1. quota  配额（硬）—— L0/L1 注入层字节数不得超过自律配额
 *   2. banned 被禁段落（硬）—— 注入层不得出现决策史措辞
 *   3. index  索引路径（软）—— 索引点名的文档是否真的存在
 *   4. git    治理文件（软）—— 是否已进 git（ignored 不算）；探测不到 = unknown（不是 ok）
 *
 * 单个检查是纯函数（输入数据、输出判定）；读文件与 git 探测只发生在 docLint 聚合器里。
 * 额外路径（options.paths 与部署级 options.extraDocs）只接受 workspace 相对路径：
 * 绝对路径 / ~ / .. 越界 → 结构化 WARN，且不读工作区外文件；index 检查的目标同此沙箱。
 * 治理文件清单默认 AGENTS.md（docs/machine.md、docs/workflow.md 仅存在时纳入），extraDocs 可追加。
 * git 探测走批量 ls-files + check-ignore（最多 2 次子进程，保留 4s timeout），并剥离宿主 GIT_DIR 等变量。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

/** 决策史/过程凭证类措辞——注入层不该出现。 */
export const BANNED = /曾用|已废弃|已被推翻|别再试|不再使用/;

export const DEFAULTS = Object.freeze({
  l0Quota: 2048,
  l1Quota: 4096,
});

const MAX_EXTRA_PATHS = 20;
const MAX_DETAIL_CHARS = 400;
const GIT_TIMEOUT = 4000;

const expand = (value) => (typeof value === 'string' && value.startsWith('~') ? join(homedir(), value.slice(1)) : value);
const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const fileSize = (path) => { try { return statSync(path).size; } catch { return null; } };
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** 治理文件默认清单（workspace 相对；仅检查存在的普通文件）；部署可经 options.extraDocs 追加。 */
const DEFAULT_GOVERNANCE = ['AGENTS.md', 'docs/machine.md', 'docs/workflow.md'];
const clip = (text, limit) => (text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…');

/** 调用方传入的 workspace 相对路径列表：去空、去重、限 20 条。 */
export function normalizePaths(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const path = String(item ?? '').trim();
    if (path !== '') seen.add(path);
  }
  return [...seen].slice(0, MAX_EXTRA_PATHS);
}

/** 校验调用方路径：只接受 workspace 相对路径；resolve（含符号链接）后必须仍在根内。 */
function resolveInside(root, value) {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw.includes('\0')) return { reason: '空路径或非法字符' };
  if (raw.startsWith('~')) return { reason: '~ 路径' };
  if (isAbsolute(raw)) return { reason: '绝对路径' };
  const full = resolve(root, raw);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) return { reason: '越出 workspace（..）' };
  try {
    const realRoot = realpathSync(root);
    const realFull = realpathSync(full);
    const realPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realFull !== realRoot && !realFull.startsWith(realPrefix)) return { reason: '符号链接越出 workspace' };
  } catch { /* 文件不存在/不可解析：readText 会返回 null，不读也不泄漏 */ }
  return { path: full };
}

/** 1 配额（硬）：纯函数。 */
export function checkQuota({ l0Size, l1Size, l0Quota = DEFAULTS.l0Quota, l1Quota = DEFAULTS.l1Quota } = {}) {
  const overL0 = l0Size !== null && l0Size !== undefined && l0Size > l0Quota;
  const overL1 = l1Size !== null && l1Size !== undefined && l1Size > l1Quota;
  return {
    name: 'quota',
    level: 'hard',
    ok: !overL0 && !overL1,
    detail: 'L0 ' + (l0Size ?? '缺失') + ' B / 配额 ' + l0Quota + '；L1 ' + (l1Size ?? '缺失') + ' B / 配额 ' + l1Quota,
  };
}

/** 2 被禁段落（硬）：纯函数。entries = [{label, text}]。 */
export function checkBanned(entries = []) {
  const dirty = [];
  for (const entry of entries) {
    const text = entry?.text;
    if (typeof text !== 'string' || text === '') continue;
    const label = String(entry?.label ?? '?');
    text.split('\n').forEach((line, index) => {
      if (BANNED.test(line)) dirty.push(label + ':' + (index + 1) + ' ' + line.trim().slice(0, 60));
    });
  }
  return {
    name: 'banned',
    level: 'hard',
    ok: dirty.length === 0,
    detail: dirty.length === 0 ? '无决策史措辞' : dirty.join(' | '),
  };
}

/** 描述他人文件惯例的单元格（如 refs/ 行里的 AGENTS.md）不是具体索引目标。 */
const PATTERN_CELL = /第三方|自带|示例/;

/** 裸文件名只认这些常见文档名；其余裸 .md 视为散文提及，不当索引目标。 */
const KNOWN_DOC_NAME = /^(AGENTS|CONTEXT|GLOSSARY|README|HANDOFF|DESIGN|SPEC|SKILL|CHANGELOG|CONTRIBUTING)\.md$/i;

/** 只有表格行、无序列表与有序列表参与索引抽取；普通散文里的反引号只是文字。 */
const INDEX_LINE = /^(?:\||[-*+]\s|[0-9]+[.)]\s)/;

const INDEX_EXT = /[.](md|mjs|json|ya?ml)$/;

/** 索引目标的路径解析：只接受 workspace 相对 POSIX 路径（与 extra paths 同一沙箱）；越界返回原因。 */
function resolveIndexTarget(target, base, workspaceRoot) {
  // 含 / 的按 workspace 相对，裸名相对首列 base（表格第一格）。
  const candidate = target.includes('/') ? target : base === '' ? target : base + '/' + target;
  const verdict = resolveInside(workspaceRoot, candidate);
  return verdict.path === undefined ? { rejected: String(verdict.reason) } : { path: verdict.path };
}

/**
 * 从索引文本里抽「被点名的路径」：跳过占位符、目录、散文提及、他人惯例单元格。纯函数。
 * 返回 { paths: workspace 内绝对路径（去重）, rejected: 越界原因列表 }；越界目标不回显宿主路径。
 */
export function extractIndexTargets(text, workspaceRoot) {
  if (typeof text !== 'string' || text === '') return { paths: [], rejected: [] };
  const found = new Set();
  const rejected = [];
  for (const line of text.split('\n')) {
    if (!line.includes('`')) continue;
    const trimmed = line.trim();
    if (!INDEX_LINE.test(trimmed)) continue;
    const isRow = trimmed.startsWith('|');
    // 表格行合法 Markdown 可以不写尾竖线：split 后去掉首尾空串再取单元格。
    const cells = isRow ? trimmed.split('|').map((cell) => cell.trim()) : [trimmed];
    if (isRow && cells[0] === '') cells.shift();
    if (isRow && cells[cells.length - 1] === '') cells.pop();
    let base = '';
    if (isRow) {
      const token = /`([^`]+)`/.exec(cells[0] ?? '');
      const path = token === null ? '' : token[1].trim();
      base = path.endsWith('/') ? path.slice(0, -1) : '';
    }
    for (const cell of cells) {
      if (PATTERN_CELL.test(cell)) continue;
      for (const match of cell.matchAll(/`([^`]+)`/g)) {
        const target = match[1].trim();
        if (target === '' || target.includes('<') || target.endsWith('/') || /\s/.test(target)) continue;
        if (!INDEX_EXT.test(target)) continue;
        // 列表项没有首列 base：裸文件名只认已知文档名，避免散文提及被当路径。
        if (!isRow && !target.includes('/') && !target.startsWith('~') && !isAbsolute(target) && !KNOWN_DOC_NAME.test(target)) continue;
        const verdict = resolveIndexTarget(target, base, workspaceRoot);
        if (verdict.path !== undefined) found.add(verdict.path);
        else rejected.push(verdict.rejected);
      }
    }
  }
  return { paths: [...found], rejected };
}

/** 兼容视图：只返回 workspace 内的索引目标（越界目标见 extractIndexTargets.rejected）。 */
export function extractIndexPaths(text, workspaceRoot) {
  return extractIndexTargets(text, workspaceRoot).paths;
}

/** 3 索引路径（软）：查点名的文档是否存在；越界目标只 WARN，不检查也不回显宿主绝对路径。 */
export function checkIndex({ l1Text, workspaceRoot, exists = existsSync } = {}) {
  const { paths, rejected } = extractIndexTargets(l1Text, workspaceRoot);
  const missing = paths.filter((path) => !exists(path));
  const parts = [];
  if (missing.length > 0) parts.push('缺失：' + missing.map((path) => path.replace(String(workspaceRoot) + '/', '')).join(' | '));
  if (rejected.length > 0) {
    parts.push('越界（只检查 workspace 相对路径，不回显工作区外目标）：' + [...new Set(rejected)].join('、'));
  }
  return {
    name: 'index',
    level: 'soft',
    ok: parts.length === 0,
    detail: parts.length === 0 ? paths.length + ' 条路径全部存在' : parts.join('；'),
  };
}

/** git 子进程环境：剥离宿主 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE，避免 -C 指定的 workspace 被劫持。 */
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/** 跑一次 git 子进程（同步，4s timeout）。git 不可用返回 null；非零退出保留 status。 */
function gitRun(cwd, args, input) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      input: input ?? '',
      timeout: GIT_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
      env: gitEnv(),
    });
    return { status: 0, stdout };
  } catch (error) {
    if (typeof error?.status === 'number') return { status: error.status, stdout: String(error?.stdout ?? '') };
    return null;
  }
}

const splitNul = (stdout) => String(stdout ?? '').split('\0').filter((item) => item !== '');

/** 一次 `ls-files --error-unmatch` 批量判定 tracked；非仓库/不可用返回 null（= unknown）。 */
function probeTracked(root, relPaths) {
  // :(literal) 防止文件名里的 glob/魔符被 git 当 pathspec 展开。
  const result = gitRun(root, ['ls-files', '--error-unmatch', '-z', '--', ...relPaths.map((path) => ':(literal)' + path)]);
  if (result === null || (result.status !== 0 && result.status !== 1)) return null;
  const tracked = new Set(splitNul(result.stdout));
  return relPaths.map((path) => tracked.has(path));
}

/** 一次 `check-ignore --stdin` 批量取未跟踪文件的忽略规则；返回 path → '来源:行 规则'。 */
function probeIgnored(root, relPaths) {
  const ignored = new Map();
  if (relPaths.length === 0) return ignored;
  const result = gitRun(root, ['check-ignore', '-z', '-v', '--stdin'], relPaths.join('\0') + '\0');
  if (result === null || (result.status !== 0 && result.status !== 1)) return ignored;
  const fields = splitNul(result.stdout);
  for (let index = 0; index + 3 < fields.length; index += 4) {
    ignored.set(fields[index + 3], fields[index] + ':' + fields[index + 1] + ' ' + fields[index + 2]);
  }
  return ignored;
}

/** 4 git（软）：批量只看工作区内存在的治理文件；ignored 与 untracked 都算 WARN，探测不到 = unknown。 */
export function checkGit({ workspaceRoot, paths = [], extraDocs = [] } = {}) {
  const root = String(workspaceRoot ?? '');
  const candidates = [];
  for (const path of [...DEFAULT_GOVERNANCE, ...normalizePaths(extraDocs), ...normalizePaths(paths)]) {
    const verdict = resolveInside(root, path);
    if (verdict.path !== undefined) candidates.push(verdict.path);
  }
  // 只检查普通文件：目录路径跳过（ls-files 会展开目录下文件，导致目录本身恒判「未跟踪」）。
  const targets = [...new Set(candidates)].filter(isFile);
  const unknown = (why) => ({
    name: 'git',
    level: 'soft',
    ok: false,
    unknown: true,
    detail: 'unknown: ' + why + '（按 unknown 处理，不是 ok）',
  });
  if (targets.length === 0) return unknown('无可检目标（工作区缺 AGENTS.md / docs 等治理文件）');
  const relPaths = targets.map((path) => relative(root, path));
  const trackedFlags = probeTracked(root, relPaths);
  if (trackedFlags === null) return unknown('不在 git 仓库内或 git 不可用，跳过');
  const untracked = relPaths.filter((path, index) => !trackedFlags[index]);
  if (untracked.length === 0) {
    return { name: 'git', level: 'soft', ok: true, unknown: false, detail: '已跟踪（' + targets.length + ' 个）' };
  }
  const ignored = probeIgnored(root, untracked);
  const plain = untracked.filter((path) => !ignored.has(path));
  const parts = [];
  if (plain.length > 0) parts.push('未跟踪：' + plain.join(' | '));
  if (ignored.size > 0) {
    parts.push('已忽略（未跟踪，不算 tracked）：' + [...ignored].map(([path, reason]) => path + '（' + reason + '）').join(' | '));
  }
  return { name: 'git', level: 'soft', ok: false, unknown: false, detail: parts.join('；') };
}

function markOf(check) {
  if (check.ok) return 'PASS';
  if (check.level === 'hard') return 'FAIL';
  return check.unknown === true ? 'UNKNOWN' : 'WARN';
}

/**
 * 聚合四项检查，返回 {ok, level, checks:[{name, level, ok, detail}], summary, workspaceRoot}。
 * level：有硬失败 → FAIL；仅有软失败（含 git unknown / 非法路径）→ WARN；否则 PASS。
 * ok：硬检查全过且没有路径被拒（被拒路径只报 WARN，且不读工作区外文件）。
 * workspaceRoot 必须由调用方传入（会话 cwd / 配置），不写死任何本机路径。
 */
export function docLint(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const workspaceRoot = resolve(expand(cfg.workspaceRoot ?? process.cwd()));
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const l0 = expand(cfg.l0 ?? join(dshHome, 'AGENTS.md'));
  const l1 = cfg.l1 === undefined ? join(workspaceRoot, 'AGENTS.md') : expand(cfg.l1);
  const accepted = [];
  const rejected = [];
  // options.paths = 单次调用附带文档；options.extraDocs = 部署级追加治理文档；二者同一沙箱口径。
  for (const path of [...normalizePaths(cfg.paths), ...normalizePaths(cfg.extraDocs)]) {
    const verdict = resolveInside(workspaceRoot, path);
    if (verdict.path === undefined) rejected.push(path + '（' + verdict.reason + '）');
    else accepted.push(verdict.path);
  }
  const l0Text = readText(l0);
  const l1Text = readText(l1);
  const extra = accepted.map((full) => ({ label: relative(workspaceRoot, full), text: readText(full) }));
  const checks = [
    checkQuota({ l0Size: fileSize(l0), l1Size: fileSize(l1), l0Quota: cfg.l0Quota, l1Quota: cfg.l1Quota }),
    checkBanned([{ label: 'L0', text: l0Text }, { label: 'L1', text: l1Text }, ...extra]),
    ...(rejected.length === 0 ? [] : [{
      name: 'paths',
      level: 'soft',
      ok: false,
      detail: '拒绝（仅接受 workspace 相对路径）：' + rejected.join(' | '),
    }]),
    checkIndex({ l1Text, workspaceRoot }),
    checkGit({ workspaceRoot, paths: accepted.map((full) => relative(workspaceRoot, full)), extraDocs: cfg.extraDocs }),
  ];
  const hardFail = checks.filter((check) => check.level === 'hard' && !check.ok);
  const softFail = checks.filter((check) => check.level === 'soft' && !check.ok);
  const level = hardFail.length > 0 ? 'FAIL' : softFail.length > 0 ? 'WARN' : 'PASS';
  const result = { ok: hardFail.length === 0 && rejected.length === 0, level, checks, workspaceRoot };
  result.summary = formatDocLint(result, 2048);
  return result;
}

/** 压缩成 ≤maxBytes 的可读摘要（output-budget 纪律）。 */
export function formatDocLint(result, maxBytes = 2048) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const level = String(result?.level ?? (result?.ok === false ? 'FAIL' : 'PASS'));
  const lines = ['doc_lint: ' + level];
  for (const check of checks) {
    lines.push('  [' + markOf(check) + '] ' + String(check.name) + '：' + clip(String(check.detail ?? ''), MAX_DETAIL_CHARS));
  }
  const text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const note = '\n…（已按 ' + maxBytes + 'B 上限截断）';
  const noteBytes = Buffer.byteLength(note, 'utf8');
  if (noteBytes > maxBytes) return '';            // 极端小上限：连标记都放不下，只能返回空串
  const budget = maxBytes - noteBytes;
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  // budget 按字节扣除、每行另计 1 字节换行，构造上 join 后必 ≤ maxBytes（越界分支不可达）。
  return kept.join('\n') + note;
}

/** 压成 ≤maxChars（默认 200）的一行，可直接进 handoff evidence / brief。 */
export function docLintEvidence(result, maxChars = 200) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const marks = checks.map((check) => check.name + '=' + markOf(check)).join(' ');
  const failed = checks
    .filter((check) => !check.ok)
    .map((check) => check.name + ':' + String(check.detail ?? '').split(' | ')[0])
    .join('；');
  const text = 'doc_lint: ' + String(result?.level ?? 'ERROR') + (marks === '' ? '' : ' · ' + marks) + (failed === '' ? '' : ' · ' + failed);
  return clip(text, maxChars);
}

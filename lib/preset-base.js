/**
 * dsh-context-relay — 官方 ptc preset 的 plugin 行数据资产（纯数据 + 版本选择，无副作用）。
 *
 * 两套真源：
 * - rc.1：DSH 0.2.1-rc.2 / 0.2.2-rc.1 的 `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`
 * - rc.2：DSH 0.2.2-rc.2 的同一文件（preset-ptc 声明内的 plugins 行）
 *
 * relay preset = 选中的行集合 + relay agent 行（插入 compaction 隔离组末尾，
 * 见 lib/index.js 的 relayPresetDefinition）；升级 DSH 后跑 `npm test`，
 * preset 漂移对比测试会列出官方文件与本数据的行差异。
 *
 * 选择逻辑：运行时读内核版本（`@deepseek-ai/dsh/package.json`）；>= 0.2.2-rc.2 用 rc.2 行，
 * 否则用 rc.1 行（读不到版本时保守回退 rc.1，保持旧内核行为）。
 *
 * 修改规则：只跟随对应官方 ptc patch 的增删改；relay 专属行不要写在这里。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** 递归冻结（数据资产只读；组合时 structuredClone 一份再改）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/** rc.1（0.2.1-rc.2 / 0.2.2-rc.1）行数据：保持旧内核行为逐字不变。 */
export const PTC_BASE_PLUGINS_RC1 = deepFreeze([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent powered by the {{model}} model.' } },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'planning',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    config: [{
      id: 'plan-mode',
      name: '@deepseek-ai/dsh-plan-mode',
      config: {
        section: `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`,
      },
    }],
  },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ],
  },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true } },
      { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', disabled: true, config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', disabled: true },
    ],
  },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
  { id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true },
]);

/** rc.2（0.2.2-rc.2+）行数据：跟随官方 preset-ptc 的 plugins 行（preset-ptc 外层声明不在此处）。 */
export const PTC_BASE_PLUGINS_RC2 = deepFreeze([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent powered by the {{model}} model.' } },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'planning',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    config: [{
      id: 'plan-mode',
      name: '@deepseek-ai/dsh-plan-mode',
      config: {
        section: `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`,
      },
    }],
  },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ],
  },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control', config: { interrupt: false } },
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true } },
      { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', disabled: true, config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', disabled: true },
    ],
  },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
  { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
  { id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true },
]);

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
  if (match === null) return undefined;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') };
}

/** semver 比较（支持工程实际用到的 rc 预发布段）；解析失败按相等处理。 */
export function compareDshVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.min(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return Number(x) < Number(y) ? -1 : 1;
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  if (left.pre.length === right.pre.length) return 0;
  return left.pre.length < right.pre.length ? -1 : 1;
}

function versionFromPackageJson(path) {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version;
  } catch { /* 不是 DSH 包或不可读 */ }
  return undefined;
}

function versionFromAncestors(start) {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const version = versionFromPackageJson(join(dir, 'package.json'));
    if (version !== undefined) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 运行内核版本：优先从 dsh 可执行文件路径找，其次 createRequire，最后常见全局安装路径。 */
export function installedDshVersion() {
  const argv = process.argv[1];
  if (typeof argv === 'string' && argv !== '') {
    // 通过 .bin/dsh 软链启动时 argv[1] 是软链：先解析到真实 bin.js，才能向上找到内核包。
    let script = argv;
    try { script = realpathSync(argv); } catch { /* 非文件入口（如测试 runner）继续用原路径 */ }
    const version = versionFromAncestors(dirname(script));
    if (version !== undefined) return version;
  }
  try {
    const version = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json')?.version;
    if (typeof version === 'string') return version;
  } catch { /* 插件未与内核同树安装 */ }
  return versionFromPackageJson('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
}

/** 版本 → 行数据：>= 0.2.2-rc.2 用 rc.2 行；读不到/旧内核用 rc.1 行（旧行为不变）。 */
export function ptcBaseForDshVersion(version) {
  return version !== undefined && compareDshVersions(version, '0.2.2-rc.2') >= 0 ? PTC_BASE_PLUGINS_RC2 : PTC_BASE_PLUGINS_RC1;
}

/** 本次进程探测到的内核版本（undefined = 读不到，按 rc.1 行处理）。 */
export const PTC_BASE_KERNEL_VERSION = installedDshVersion();
/** relay preset 实际使用的官方行（模块加载时按内核版本选择）。 */
export const PTC_BASE_PLUGINS = ptcBaseForDshVersion(PTC_BASE_KERNEL_VERSION);

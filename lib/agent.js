/**
 * dsh-context-relay — Agent 平面装配入口（随 relay preset 挂载）。
 *
 * 只做装配：常驻协议 section、八个模型工具注册、approval/哨兵/handoff 路由、卸载清理；
 * per-agent 角色平面（工具面裁剪 + 影子协议 + 角色工具）是声明式的：角色表单一真源
 * 在 lib/plane/roles.js，幂等 reconcile/状态/反向卸载在 lib/plane/ensure.js。
 * 具体实现见 lib/agent/{protocol,tools,derive,sentinel,panel-gate,handoff,shared}.js。
 *
 * @module dsh-context-relay/agent
 */
import { capacityRatioOf, normalizeSettings, resolveEffectiveThresholds } from './policy.js';
import { ARCHITECT_NAME, PHASE_SECTION_NAME, REDLINE_PROTOCOL_TEXT, REDLINE_SECTION_NAME, UNLIMITED_BUDGET_TEXT, phaseProtocolText } from './agent/protocol.js';
import { createRelayTools } from './agent/tools.js';
import { installApprovalGate } from './agent/panel-gate.js';
import { installSentinel, clearSentinelMemory } from './agent/sentinel.js';
import { clearDeriveMemory } from './agent/derive.js';
import { clearSharedMemory, consumePendingArchitect, consumePendingBudgetInherit, cwdOf, effectiveUnlimitedBudgetOf, fail, isRootSession, logInfo, TOOL_PREFIX } from './agent/shared.js';
import { clearActivations } from './agent/activations.js';
import { readRoster } from './agent/team.js';
import { installHandoffRoute } from './agent/handoff.js';
import { normalizeWorkItemsConfig } from './agent/work-items.js';
import { skillDefinitionOf } from './skills.js';
import { createTeamTools } from './agent/team-tools.js';
import { createDelegationTools, clearDelegationMemory, delegationMemoryState } from './agent/delegation-tools.js';
import { normalizeDelegationConfig } from './agent/delegation.js';
import { ensureAgentPlane, disposeAllPlanes, isPlaneTracked } from './plane/ensure.js';
import { normalizeDocsOptions } from './docs-policy.js';
import { panelStateOf, seedPanelOperation, updatePanelState } from './panel-store.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
/** 单一声明式角色表（v0.10 C2）：常量的真源在 lib/plane/roles.js，这里保留旧导出名供测试/外部消费。 */
export { LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS } from './plane/roles.js';


/** schema 顶层声明字段（缺 parameters/properties → undefined，视为不校验）。 */
function schemaPropsOf(definition) {
  const properties = definition?.parameters?.properties;
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties) ? properties : undefined;
}

/** schema 外顶层字段（v0.13 P1 ④：只查顶层；嵌套对象由各自工具校验）。 */
function unknownArgsOf(definition, args) {
  const properties = schemaPropsOf(definition);
  if (properties === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return [];
  const known = new Set(Object.keys(properties));
  return Object.keys(args).filter((key) => !known.has(key));
}

/** 未知字段记 (tool, field) 到独立 JSONL（fail-open；测试/审计可 grep）。 */
function recordArgWarning(ctx, exec, definition, fields) {
  try {
    const cwd = cwdOf(exec?.agent?.session);
    if (typeof cwd !== 'string' || cwd === '') return;
    const dir = join(cwd, '.scratch', 'context-relay', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'tool-args-warnings.jsonl'), JSON.stringify({
      at: new Date().toISOString(),
      tool: definition.name,
      fields,
      sessionId: exec?.agent?.session?.id,
    }) + '\n');
    ctx?.logger?.warn?.('[dsh-context-relay] unknown args for ' + definition.name + ': ' + fields.join(', '));
  } catch { /* 日志失败不影响工具调用 */ }
}

/** v0.13 P1 ④：schema 外参数 warn（默认）或拒（strictToolArgs=true）；不改变声明字段的行为。 */
function withArgGuard(definition, { strict = false, ctx } = {}) {
  if (definition === null || typeof definition !== 'object' || typeof definition.execute !== 'function') return definition;
  return {
    ...definition,
    async execute(args, exec) {
      const fields = unknownArgsOf(definition, args);
      if (fields.length > 0) {
        recordArgWarning(ctx, exec, definition, fields);
        if (strict === true) {
          return fail('invalid-args', definition.name + ' received field(s) not in its schema: ' + fields.join(', '), {
            tool: definition.name,
            fields,
            summary: 'refused: unknown argument field(s) for ' + definition.name + ': ' + fields.join(', ') + ' (strictToolArgs=true).',
          });
        }
      }
      return definition.execute(args, exec);
    },
  };
}

export const name = 'dsh-context-relay-agent';
/** 只硬依赖工具与提示词注册；其余服务在执行时动态解析（缺服务时降级为结构化错误）。 */
export const inject = ['tools', 'systemPrompt'];

/** 侧栏设置（阈值基准 + 三个自动授权开关）：host 写入 globalThis，agent 每次读取（热生效）。 */
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
function liveSettings() {
  const value = globalThis[SETTINGS_KEY];
  return value !== undefined && value !== null && typeof value === 'object' ? value : undefined;
}

export function apply(ctx, config = {}) {
  // 设置来源：预设行 config（默认）→ host 的 live 设置（globalThis，侧栏可改，热生效）覆盖。
  const configSettings = normalizeSettings(config.settings ?? {});
  const currentSettings = () => normalizeSettings({ ...configSettings, ...(liveSettings() ?? {}) });
  // 生效阈值与 host 同一解析入口（v0.10 C6/M-17/D-07；C10 删 legacy 双口径）：
  // 阈值只由 policy.resolveEffectiveThresholds 从 settings.threshold 派生；live 设置热生效（侧栏 PUT 后下一 step 即用）。
  const currentThresholds = () => resolveEffectiveThresholds({ settings: currentSettings() });
  // v0.11 P0-E：容量线独立配置（settings.capacityThreshold，默认见 DEFAULT_SETTINGS），与 band 阈值各自读取、不合并。
  const currentCapacityRatio = () => capacityRatioOf(currentSettings());
  const presetId = config.presetId ?? 'relay';
  /** preset 白名单（host 经 preset 行 config 传唯一模式 id）：agent 面校验用途。
   * 缺省/空数组只认本 preset（旧部署/直接挂载 agent 面的兼容口径）。 */
  const configuredPresetIds = Array.isArray(config.relayPresetIds) ? config.relayPresetIds.filter((id) => typeof id === 'string' && id !== '') : [];
  const relayPresetIds = configuredPresetIds.length > 0 ? configuredPresetIds : [presetId];
  /** v0.9.0 #5/#59/#61（D2=A）：唯一生产模式 id = 白名单首项（host 保证首项为 single）；交接目标恒用它。 */
  const singlePresetId = relayPresetIds[0];
  /** M2-G A/B 开关：默认注入；false 时不注入 brief（供「有/无注入」归因实验）。 */
  const injectBrief = config.injectBrief !== false;
  /** audit H 人类确认硬门：默认 required；'off' 仅供测试 / 无审批 UI 的部署（残余风险见 VERDICT）。 */
  const handoffApproval = config.handoffApproval === 'off' ? 'off' : 'required';
  /** 接力继承旧会话设置（模型路由 + 权限）：默认开；false 时新会话回到部署默认。 */
  const inheritOnHandoff = config.inheritOnHandoff !== false;
  /** 工作台账（v0.5.0）：工具/闸门/渲染共用同一归一化配置（host 路由也用它）。 */
  const workItems = normalizeWorkItemsConfig(config);
  /** P0-D 主动上下文管理起点提醒（v0.11）：on（默认）/ off（全静默）；只关新节点，不动到线/容量提醒。 */
  const contextCheck = config.contextCheck !== 'off';
  /** P0-C ship 受控 reopen（v0.11）：strict（默认）/ warn（放行+warning）/ off（v0.10 旧行为）。 */
  const reopenGate = config.reopenGate === 'warn' || config.reopenGate === 'off' ? config.reopenGate : 'strict';
  /** v0.13 P1 ②：回执证据/审查引用校验档——warn（默认，只警告）/ strict（不符即拒）/ off。 */
  const receiptVerify = config.receiptVerify === 'strict' || config.receiptVerify === 'off' ? config.receiptVerify : 'warn';
  /** v0.13 P1 ④：schema 外参数默认只记 JSONL；strictToolArgs=true 时拒绝。 */
  const strictToolArgs = config.strictToolArgs === true;
  const argGuard = { strict: strictToolArgs, ctx };
  /** P1-A 宿主自动压缩兜底（v0.11）：on（默认，写最小恢复快照+一次 notice）/ off（不写不提示）。 */
  const compactionFallback = config.compactionFallback !== 'off';
  /** docs v2 的三个回滚开关（default 全开）：select=legacy / layout=flat / metrics=off。 */
  const docs = normalizeDocsOptions(config.docs);
  /** P0-B 小队模型（v0.11；v0.14 起默认允许）：spawn 默认开（allowSpawn !== false，受 squadMax 约束）；显式 false 仍关。 */
  const allowSpawn = config.allowSpawn !== false;
  const squadMax = Number.isInteger(config.squadMax) && config.squadMax > 0 ? Math.min(32, config.squadMax) : 8;
  // C8/C13：workItems:false 与 delegation-first 协议互斥（v0.9 协议要求执行活一律 relay_dispatch，而
  // dispatch/collect 是台账支撑的，会被拒绝）——配置组合给一次 warn，不拒绝装载（部署仍可用 Lead 自干）。
  if (workItems.enabled === false) {
    ctx.logger?.warn?.('[dsh-context-relay] workItems:false conflicts with the delegation-first protocol: relay_dispatch/relay_collect are ledger-backed and will refuse; the Lead must execute directly or enable workItems (warn only, not rejected).');
  }
  /** 队友保鲜（v0.3.0 P0）：单一模式恒启用；按 agent 角色注册（Lead: status/renew；队友: checkpoint）。 */
  const teamTools = createTeamTools({ ctx, currentThresholds, workItems, allowSpawn, squadMax });
  /** 委派闸门（v0.9.0 批次3，D1=A/D3=A；v0.10.0 C14b strict 生效）：config-only，默认 warn；strict 命中即拒 build→verify。 */
  const delegation = normalizeDelegationConfig(config);
  if (delegation.gate === 'strict') {
    ctx.logger?.info?.('[dsh-context-relay] config.delegationGate="strict" enabled: build→verify is refused when the gate reports violations (Lead exec ratio >20% / Lead-owned build/verify points without lead-exec evidence); default warn only notifies');
  }
  /** 派活/收口（v0.9.0 批次3）：Lead-only 工具，agent-scope 注册（队友/架构师不注册）。 */
  const delegationTools = createDelegationTools({ ctx, currentThresholds, workItems, delegation, allowSpawn, squadMax, receiptVerify });

  // ── 常驻协议：整个 relay preset 共享，每 phase 稳定，不逐轮改 ──────────────
  // v0.14 P1：两段——phase（10150，可被角色影子段同名覆盖；台账/架构师按开关拼）
  // 与 redline（10199，system 最末；含 unlimitedBudget 句）。两者都是 text(context)：
  // 每次 assembly 重新求值（预算/架构师开关热生效）。
  const architectEnabledOf = (sessionId) => {
    const panelValue = sessionId === undefined || sessionId === null ? null : panelStateOf(sessionId).architect;
    return panelValue === true || panelValue === false ? panelValue : currentSettings().architect !== false;
  };
  /** redline：root Lead 拿完整红线；非 root 只保留 unlimitedBudget 句（角色影子段替换 phase）。 */
  const redlineTextOf = (context) => {
    const agent = context?.agent;
    const root = agent === undefined || agent === null || agent.session === undefined ? true : isRootSession(agent.session);
    const unlimited = effectiveUnlimitedBudgetOf(agent?.session?.id, currentSettings) === false ? '' : UNLIMITED_BUDGET_TEXT;
    if (!root) return unlimited;
    return unlimited === '' ? REDLINE_PROTOCOL_TEXT : unlimited + '\n' + REDLINE_PROTOCOL_TEXT;
  };
  /** phase：root Lead 按 workItems/architect 开关拼段；非 root 交给角色影子段（同名覆盖）。 */
  const phaseTextOf = (context) => {
    const agent = context?.agent;
    if (agent === undefined || agent === null || agent.session === undefined) return phaseProtocolText();
    return isRootSession(agent.session)
      ? phaseProtocolText({ workItems: workItems.enabled !== false, architect: architectEnabledOf(agent.session.id) })
      : '';
  };
  ctx.effect(() => ctx.systemPrompt.section({
    name: PHASE_SECTION_NAME,
    order: 10150,
    text: phaseTextOf,
  }), 'dsh-context-relay: phase section');
  ctx.effect(() => ctx.systemPrompt.section({
    name: REDLINE_SECTION_NAME,
    order: 10199,
    text: redlineTextOf,
  }), 'dsh-context-relay: redline section');

  // ── per-agent 平面（声明式 reconcile，v0.10 C2）─────────────────────────────
  // 角色 → {deny, sections, tools, seed} 的单一真源在 lib/plane/roles.js，幂等安装/卸载在 lib/plane/ensure.js；
  // 本段只负责「谁在什么时候被 reconcile」+ 把运行时依赖（工具组/种子/架构师判定）注入进去。
  // 作用域坑（seam findings Q1）：preset 行插件的 ctx 是「preset revision 挂载作用域」，
  // 在 apply 里直接 restrict 会裁掉该 revision 下所有 agent（含继承同 revision 的队友）→ 一律在 agent 自己的 ctx 上注入。
  // 四个入口（M-02：agent/created 只发一次，preset 切换/插件重载都不会重放）：
  //   ① agent/created ② apply 时枚举 live agents（回填）③ agent-preset/selected（官方切换事件）④ agent/pre-step 惰性兜底。
  // 反向切换（preset 从 relay 切走）：本代际卸载时 dispose agent-scope 注册；不可逆记 degradation（ensure.js）。

  /** 直接队友身份只能用创建瞬间的 header 事实（v0.7.1）：架构师 = spawn 前 pending 标记（relay_architect）
   * 或 roster 里的 sessionId（resume/重启后）。rc.2 的 agent/created 早于 subagents resident 登记，团队服务此时不可用。 */
  const architectByPending = (agent) => {
    const header = agent?.session?.header;
    if (header?.origin !== 'subagent' || header.delegationDepth !== 1) return false;
    return consumePendingArchitect(header.parentSession);
  };

  /** resume/重启后的架构师：roster 里已登记该 sessionId（relay_architect 在 spawn 成功后写盘）。 */
  const architectByRoster = (agent) => {
    const header = agent?.session?.header;
    const sessionId = agent?.session?.id;
    if (header?.origin !== 'subagent' || header.delegationDepth !== 1) return false;
    const parentId = header.parentSession;
    const cwd = header.cwd;
    if (typeof sessionId !== 'string' || sessionId === '' || typeof parentId !== 'string' || parentId === '' || typeof cwd !== 'string' || cwd === '') return false;
    try {
      const entry = readRoster(cwd, parentId).lineages?.[ARCHITECT_NAME];
      return Array.isArray(entry?.generations) && entry.generations.some((row) => row.sessionId === sessionId);
    } catch {
      return false;
    }
  };

  /** v0.9.0 #52/#55：单一模式所有新根会话默认档=压缩继续：
   * 仅当该会话无显式面板快照/defaultOperation 时写入（不覆盖人类显式值）；失败只 warn，不阻断会话创建。 */
  const seedRootDefault = (agent) => {
    try {
      seedPanelOperation(agent?.session?.id, 'compress');
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] default operation seed skipped: ' + String(error?.message ?? error));
    }
  };

  /** 角色表工具组 → 实际工具定义（组名见 lib/plane/roles.js；未命中的组按空处理）。 */
  const guardDefinitions = (definitions) => (Array.isArray(definitions) ? definitions.map((definition) => withArgGuard(definition, argGuard)) : []);
  const planeTools = new Map([
    ['lead', guardDefinitions(teamTools?.leadTools)],
    ['delegation', guardDefinitions(delegationTools)],
    ['teammate', guardDefinitions(teamTools?.teammateTools)],
    ['checkpoint', guardDefinitions(Array.isArray(teamTools?.teammateTools) ? teamTools.teammateTools.filter((definition) => definition.name === TOOL_PREFIX + 'checkpoint') : [])],
  ]);
  const planeRuntime = {
    ctx,
    seed: seedRootDefault,
    isArchitect: (agent) => {
      try { return architectByPending(agent) || architectByRoster(agent); } catch { return false; }
    },
    toolsOf: (group) => planeTools.get(group) ?? [],
    // w5：角色专属技能（human-loop 只给 Lead）——定义从随包 skills/<name>/SKILL.md 读，
    // 注册在 agent scope（host skills 无 deny，见 lib/skills.js）。
    skillOf: (name) => skillDefinitionOf(name),
  };

  /** live agent 当前 composition（官方 composedPreset(agent.ctx)）；服务缺失/异常 → undefined（不可判定）。 */
  const composedPresetOf = (agent) => {
    try {
      const presets = ctx.get?.('agentPresets');
      return typeof presets?.composedPreset === 'function' ? presets.composedPreset(agent?.ctx) : undefined;
    } catch { return undefined; }
  };
  const isRelayPresetId = (id) => typeof id === 'string' && relayPresetIds.includes(id);

  /** 该 agent 当前是否 relay：composition 优先，事件参数兜底（ptc→relay 切换瞬间只有事件参数可靠）。 */
  const isRelayAgent = (agent, hint) => isRelayPresetId(composedPresetOf(agent) ?? hint);

  /** 官方 agents.list()（Agent[]）；服务缺失/形状不符 → 空（非 relay 部署/旧内核不阻断）。 */
  const liveAgentsOf = () => {
    try {
      const agentsService = ctx.get?.('agents');
      const listed = typeof agentsService?.list === 'function' ? agentsService.list() : undefined;
      return Array.isArray(listed) ? listed : [];
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] live agent enumeration skipped: ' + String(error?.message ?? error));
      return [];
    }
  };

  const agentOfSession = (sessionId) => {
    try {
      const agentsService = ctx.get?.('agents');
      return typeof agentsService?.get === 'function' ? agentsService.get(sessionId) : undefined;
    } catch { return undefined; }
  };

  // C8/C9：reload/重启会清空进程内 dispatch 记忆；落盘 dispatch 记录才是 relay_collect 的新鲜度权威。
  // 内存为空而工作区已有落盘 dispatch 记录时 warn 一次（可观测，不改变行为；relay_status.delegation.dispatchMemory 亦可见）。
  if (delegationMemoryState().inMemory === 0) {
    for (const liveAgent of liveAgentsOf()) {
      const agentCwd = liveAgent?.session?.header?.cwd;
      if (typeof agentCwd !== 'string' || agentCwd === '') continue;
      const memory = delegationMemoryState(agentCwd);
      if (memory.persisted > 0) {
        ctx.logger?.warn?.('[dsh-context-relay] in-memory dispatch memory is empty while ' + memory.persisted + ' persisted dispatch record(s) exist under .scratch/context-relay/dispatch: plugin reload/restart lost process memory; relay_collect uses the persisted dispatchId as the freshness authority.');
        break;
      }
    }
  }

  /** relay agent → 幂等安装（非 relay 不动；已装过由 ensure 直接短路）。 */
  const reconcileAgent = (agent, hint) => {
    if (agent === undefined || agent === null || isRelayAgent(agent, hint) !== true) return false;
    return ensureAgentPlane(agent, planeRuntime).ok === true;
  };

  // ① agent/created：新 agent 创建即装（原有路径；本监听器本身只在 relay preset 代际内挂载）。
  // 异常只 warn，绝不阻断会话创建。
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    try { ensureAgentPlane(payload?.agent, planeRuntime); } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] per-agent install skipped: ' + String(error?.message ?? error));
    }
    // v0.10.0：spawn 前登记的「预算无上限」继承值写入新子会话面板；只认直接子会话（depth=1）。
    try {
      const child = payload?.agent?.session;
      const header = child?.header;
      if (typeof child?.id !== 'string' || child.id === '') return;
      if (header?.origin !== 'subagent' || header.delegationDepth !== 1) return;
      const parentId = header.parentSession;
      if (typeof parentId !== 'string' || parentId === '') return;
      const enabled = consumePendingBudgetInherit(parentId);
      if (enabled === undefined) return;
      updatePanelState(child.id, { unlimitedBudget: enabled }, { source: 'agent', force: true });
      logInfo(ctx, '[dsh-context-relay] budget toggle inherited session=' + child.id + ' unlimitedBudget=' + String(enabled));
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] budget inherit skipped: ' + String(error?.message ?? error));
    }
  }), 'dsh-context-relay: per-agent install');

  // ② apply 回填：preset 切换/插件重载时既有 live agent 不会重放 agent/created（M-02 主因）。
  for (const liveAgent of liveAgentsOf()) {
    try { reconcileAgent(liveAgent); } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] live agent backfill skipped: ' + String(error?.message ?? error));
    }
  }

  // ③ 后续切换：官方 agentPresets.select() = recompose + append agent-preset/selected，不重建 agent/不重发 created。
  // 事件签名（dsh-agent-preset-registry src/index.ts:77）：(sessionId, agentPreset)。
  ctx.effect(() => ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    try {
      if (!isRelayPresetId(agentPreset)) return;
      reconcileAgent(agentOfSession(sessionId), agentPreset);
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] preset-selected reconcile skipped: ' + String(error?.message ?? error));
    }
  }), 'dsh-context-relay: plane reconcile (preset selected)');

  // ④ 每步惰性兜底：只补「从未装过」的 relay agent（已装/已降级不重复尝试、不刷日志）。
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const proceed = typeof next === 'function' ? next : async () => {};
    try {
      const agent = payload?.agent;
      if (agent !== undefined && agent !== null && isPlaneTracked(agent) !== true && isRelayAgent(agent)) {
        ensureAgentPlane(agent, planeRuntime);
      }
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] lazy plane ensure skipped: ' + String(error?.message ?? error));
    }
    return proceed();
  }), 'dsh-context-relay: plane lazy ensure');

  // ⑤ 反向切换：relay preset 代际被卸载时 dispose agent-scope 注册（restrict/工具/影子 section）。
  // 仍绑定在另一代 relay（迁移期 relay-long/relay 别名互切）的会话保留平面，由新代际幂等接管。
  ctx.effect(() => () => {
    try {
      const result = disposeAllPlanes({
        reason: 'preset-left',
        stillRelay: (sessionId) => isRelayAgent(agentOfSession(sessionId)),
      });
      if (result.failed.length > 0) ctx.logger?.warn?.('[dsh-context-relay] plane dispose incomplete for ' + result.failed.length + ' session(s); agent-scope registrations may persist');
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] plane dispose skipped: ' + String(error?.message ?? error));
    }
  }, 'dsh-context-relay: plane dispose on preset leave');

  // ── 工具注册 ────────────────────────────────────────────────────────────
  // singlePresetId 供 relay_handoff 恒指向唯一模式（迁移期别名会话也交接回 single，M4）。
  const tools = createRelayTools({ ctx, currentThresholds, currentCapacityRatio, injectBrief, presetId, singlePresetId, inheritOnHandoff, relayPresetIds, workItems, delegation, squadMax, reopenGate, docs, receiptVerify });
  for (const definition of tools) {
    const guarded = withArgGuard(definition, argGuard);
    ctx.effect(() => ctx.tools.register(guarded), 'dsh-context-relay: ' + definition.name);
  }

  // ── 人类确认硬门（audit H）：官方 tools/pre-execute 审批 waterfall（fail-closed）──
  if (handoffApproval === 'required') {
    ctx.effect(() => installApprovalGate(ctx, currentThresholds), 'dsh-context-relay: approval gate');
  }

  // ── 到线提醒：升线时注入（同档不重复；成功压缩重新武装）；每 step 发布面板实时状态 ──
  ctx.effect(() => installSentinel(ctx, currentThresholds, workItems, contextCheck, currentCapacityRatio, compactionFallback), 'dsh-context-relay: reminder');

  // ── relay_handoff 继承：子会话首次模型请求套用旧会话路由（消费即删）──
  ctx.effect(() => installHandoffRoute(ctx), 'dsh-context-relay: handoff route');

  // ── 卸载清理：模块级缓存/哨兵/在途锁（handoff 路由是 globalThis，跨实例共享，不在此清）──
  ctx.effect(() => () => {
    clearDeriveMemory();
    clearSentinelMemory();
    clearSharedMemory();
    clearActivations();
    clearDelegationMemory(ctx);
  }, 'dsh-context-relay: state cleanup');
}

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
import { normalizeSettings, normalizeThresholds, thresholdsFromPercent } from './policy.js';
import { ARCHITECT_LEAD_PROTOCOL_TEXT, ARCHITECT_NAME, PROTOCOL_TEXT_LONG, UNLIMITED_BUDGET_TEXT, WORK_LEDGER_PROTOCOL_TEXT } from './agent/protocol.js';
import { createRelayTools } from './agent/tools.js';
import { installApprovalGate } from './agent/panel-gate.js';
import { installSentinel, clearSentinelMemory } from './agent/sentinel.js';
import { clearDeriveMemory } from './agent/derive.js';
import { clearSharedMemory, consumePendingArchitect, isRootSession, TOOL_PREFIX } from './agent/shared.js';
import { clearActivations } from './agent/activations.js';
import { readRoster } from './agent/team.js';
import { installHandoffRoute } from './agent/handoff.js';
import { normalizeWorkItemsConfig } from './agent/work-items.js';
import { createTeamTools } from './agent/team-tools.js';
import { createDelegationTools, clearDelegationMemory } from './agent/delegation-tools.js';
import { normalizeDelegationConfig } from './agent/delegation.js';
import { ensureAgentPlane, disposeAllPlanes, isPlaneTracked } from './plane/ensure.js';
import { panelStateOf, seedPanelOperation, updatePanelState } from './panel-store.js';
/** 单一声明式角色表（v0.10 C2）：常量的真源在 lib/plane/roles.js，这里保留旧导出名供测试/外部消费。 */
export { LEAD_ONLY_TOOLS, SUBAGENT_ONLY_HIDDEN_TOOLS } from './plane/roles.js';


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
  const legacyThresholds = config.thresholds === undefined ? undefined : normalizeThresholds(config.thresholds);
  const currentSettings = () => normalizeSettings({ ...configSettings, ...(liveSettings() ?? {}) });
  const currentThresholds = () => {
    const live = liveSettings();
    const explicit = live !== undefined && live.explicit === true;
    if (!explicit && legacyThresholds !== undefined) return legacyThresholds;
    return thresholdsFromPercent(currentSettings().threshold);
  };
  const presetId = config.presetId ?? 'relay';
  /** 迁移期 preset 白名单（host 经 preset 行 config 传 [唯一模式 id, classic 别名]）：agent 面校验用途。
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
  /** v0.9.0 单一模式（D2=A）：生产恒为单模式/恒路由；旧 config.routerMode 仅兼容读取（忽略并 warn，v0.10.0 移除）。 */
  if (config.routerMode === false) {
    ctx.logger?.warn?.('[dsh-context-relay] config.routerMode=false ignored: single relay mode always routes (deprecated; removed in v0.10.0)');
  }
  /** 工作台账（v0.5.0）：工具/闸门/渲染共用同一归一化配置（host 路由也用它）。 */
  const workItems = normalizeWorkItemsConfig(config);
  /** 队友保鲜（v0.3.0 P0）：单一模式恒启用；按 agent 角色注册（Lead: status/renew；队友: checkpoint）。 */
  const teamTools = createTeamTools({ ctx, currentThresholds, workItems });
  /** 委派闸门（v0.9.0 批次3，D1=A/D3=A）：config-only，默认 warn；strict 归一 warn + 一次日志（v0.10.0 启用）。 */
  const delegation = normalizeDelegationConfig(config);
  if (delegation.requestedStrict === true) {
    ctx.logger?.warn?.('[dsh-context-relay] config.delegationGate="strict" is reserved for v0.10.0; normalized to "warn" (build→verify only warns)');
  }
  /** 派活/收口（v0.9.0 批次3）：Lead-only 工具，agent-scope 注册（队友/架构师不注册）。 */
  const delegationTools = createDelegationTools({ ctx, currentThresholds, workItems, delegation });

  // ── 常驻协议：整个 relay preset 共享，每 phase 稳定，不逐轮改 ──────────────
  // v0.9.0 单一模式：恒注入单模式 base（PROTOCOL_TEXT_LONG 由 PROTOCOL_TEXT 派生，去掉 classic 专属档位）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'context-relay:protocol',
    order: 10150,
    text: PROTOCOL_TEXT_LONG,
  }), 'dsh-context-relay: protocol section');

  // ── Token 预算无上限注入（v0.2.7：按会话读 composer 小胶囊/继承的设置；缺省回退全局默认）──
  // text(context) 的 context.agent 来自 dsh-agent 对 AssembleContext 的扩展；每次 assembly 重新求值，
  // 人类在 composer 小胶囊上的改动对下一个 step 生效（热生效，不重建 agent 平面）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'context-relay:unlimited-budget',
    order: 10151,
    text: (context) => {
      const sessionId = context?.agent?.session?.id;
      const panelValue = sessionId === undefined || sessionId === null ? null : panelStateOf(sessionId).unlimitedBudget;
      const enabled = panelValue === true || panelValue === false ? panelValue : currentSettings().unlimitedBudget !== false;
      return enabled === false ? '' : UNLIMITED_BUDGET_TEXT;
    },
  }), 'dsh-context-relay: unlimited budget section');

  // ── 工作台账纪律段（v0.5.0）：常驻提示词，只对能读写台账的会话显示（root Lead / 真队友）──
  // 放在 preset 层而非 per-agent 层：worker/router 影子协议只覆盖同名 section，本段独立存在且按身份门控。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'context-relay:work-ledger',
    order: 10154,
    text: (context) => {
      if (workItems.enabled === false) return '';
      const agent = context?.agent;
      // 无 agent 上下文（静态查询/测试直接取 text）按 Lead 处理：最完整的口径。
      if (agent === undefined || agent === null || agent.session === undefined) return WORK_LEDGER_PROTOCOL_TEXT;
      // v0.7.0：台账是 Leader 自己的项目管理队列；队友/子代理不注入台账纪律。
      return isRootSession(agent.session) ? WORK_LEDGER_PROTOCOL_TEXT : '';
    },
  }), 'dsh-context-relay: work ledger section');

  // ── 专职架构师（v0.6.4）：单一模式下对 root Lead 恒注入（仅按会话面板开关门控）；
  // 架构师会话自己的协议在 agent/created 里用 ARCHITECT_WORKER 影子覆盖（避免与 TEAMMATE 段冲突）。
  const architectEnabledOf = (sessionId) => {
    const panelValue = sessionId === undefined || sessionId === null ? null : panelStateOf(sessionId).architect;
    return panelValue === true || panelValue === false ? panelValue : currentSettings().architect !== false;
  };
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'context-relay:architect',
    order: 10155,
    text: (context) => {
      const agent = context?.agent;
      const sessionId = agent?.session?.id;
      if (sessionId === undefined || sessionId === null) return '';
      if (isRootSession(agent.session)) return architectEnabledOf(sessionId) === false ? '' : ARCHITECT_LEAD_PROTOCOL_TEXT;
      return '';
    },
  }), 'dsh-context-relay: architect section');

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
      const sessionId = agent?.session?.id;
      seedPanelOperation(sessionId, 'compress');
      // v0.9.0 单一模式：没有「压缩→新会话」档——清升级残留的模式与推荐（D8=A）。
      const panelNow = panelStateOf(sessionId);
      if (panelNow.defaultOperation === 'compress-then-handoff') {
        updatePanelState(sessionId, { defaultOperation: null }, { source: 'agent' });
      }
      if (panelNow.recommendedOperation === 'compress-then-handoff') {
        updatePanelState(sessionId, { recommendedOperation: null, recommendedReason: '', recommendedAt: null }, { source: 'agent' });
      }
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] default operation seed skipped: ' + String(error?.message ?? error));
    }
  };

  /** 角色表工具组 → 实际工具定义（组名见 lib/plane/roles.js；未命中的组按空处理）。 */
  const planeTools = new Map([
    ['lead', Array.isArray(teamTools?.leadTools) ? teamTools.leadTools : []],
    ['delegation', Array.isArray(delegationTools) ? delegationTools : []],
    ['teammate', Array.isArray(teamTools?.teammateTools) ? teamTools.teammateTools : []],
    ['checkpoint', Array.isArray(teamTools?.teammateTools) ? teamTools.teammateTools.filter((definition) => definition.name === TOOL_PREFIX + 'checkpoint') : []],
  ]);
  const planeRuntime = {
    ctx,
    seed: seedRootDefault,
    isArchitect: (agent) => {
      try { return architectByPending(agent) || architectByRoster(agent); } catch { return false; }
    },
    toolsOf: (group) => planeTools.get(group) ?? [],
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
  const tools = createRelayTools({ ctx, currentThresholds, injectBrief, presetId, singlePresetId, inheritOnHandoff, relayPresetIds, workItems, delegation });
  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition), 'dsh-context-relay: ' + definition.name);
  }

  // ── 人类确认硬门（audit H）：官方 tools/pre-execute 审批 waterfall（fail-closed）──
  if (handoffApproval === 'required') {
    ctx.effect(() => installApprovalGate(ctx, currentThresholds), 'dsh-context-relay: approval gate');
  }

  // ── 到线提醒：升线时注入（同档不重复；成功压缩重新武装）；每 step 发布面板实时状态 ──
  ctx.effect(() => installSentinel(ctx, currentThresholds, workItems), 'dsh-context-relay: reminder');

  // ── relay_handoff 继承：子会话首次模型请求套用旧会话路由（消费即删）──
  ctx.effect(() => installHandoffRoute(ctx), 'dsh-context-relay: handoff route');

  // ── 卸载清理：模块级缓存/哨兵/在途锁（handoff 路由是 globalThis，跨实例共享，不在此清）──
  ctx.effect(() => () => {
    clearDeriveMemory();
    clearSentinelMemory();
    clearSharedMemory();
    clearActivations();
    clearDelegationMemory();
  }, 'dsh-context-relay: state cleanup');
}

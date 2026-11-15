/**
 * dsh-context-relay — Agent 平面装配入口（随 relay preset 挂载）。
 *
 * 只做装配：常驻协议 section、五个工具注册、per-agent 安装（Router/worker 的工具裁剪与影子协议）、
 * 审批硬门、到线哨兵、handoff 路由继承、卸载清理。
 * 具体实现见 lib/agent/{protocol,tools,derive,sentinel,panel-gate,handoff,shared}.js。
 *
 * @module dsh-context-relay/agent
 */
import { normalizeSettings, normalizeThresholds, thresholdsFromPercent } from './policy.js';
import { ARCHITECT_LEAD_PROTOCOL_TEXT, ARCHITECT_NAME, ARCHITECT_WORKER_PROTOCOL_TEXT, PROTOCOL_TEXT_LONG, ROUTER_DENY_TOOLS, ROUTER_PROTOCOL_TEXT, TEAMMATE_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT, UNLIMITED_BUDGET_TEXT, WORK_LEDGER_PROTOCOL_TEXT } from './agent/protocol.js';
import { createRelayTools } from './agent/tools.js';
import { installApprovalGate } from './agent/panel-gate.js';
import { installSentinel, clearSentinelMemory } from './agent/sentinel.js';
import { clearDeriveMemory } from './agent/derive.js';
import { clearSharedMemory, consumePendingArchitect, isRootSession, TOOL_PREFIX } from './agent/shared.js';
import { clearActivations } from './agent/activations.js';
import { readRoster } from './agent/team.js';
import { installHandoffRoute } from './agent/handoff.js';
import { WORKER_PROTOCOL_TEXT } from './agent/worker.js';
import { normalizeWorkItemsConfig } from './agent/work-items.js';
import { createTeamTools } from './agent/team-tools.js';
import { createDelegationTools, clearDelegationMemory } from './agent/delegation-tools.js';
import { normalizeDelegationConfig } from './agent/delegation.js';
import { panelStateOf, seedPanelOperation, updatePanelState } from './panel-store.js';


export const name = 'dsh-context-relay-agent';
/** 只硬依赖工具与提示词注册；其余服务在执行时动态解析（缺服务时降级为结构化错误）。 */
export const inject = ['tools', 'systemPrompt'];

/** lead-only 工具（v0.2.17 B：非 root 的 worker 会话裁掉；名字即 tools.js / handoff.js 的注册名）。
 * v0.7.1：台账 v0.7.0 起就是 Leader-only（执行层已拒队友）→ 把 relay_work_items 也裁掉，避免每个子代理白背 schema。 */
export const LEAD_ONLY_TOOLS = Object.freeze([TOOL_PREFIX + 'organize', TOOL_PREFIX + 'handoff', TOOL_PREFIX + 'recommend', TOOL_PREFIX + 'work_items']);

/** 普通子代理额外隐藏的工具（v0.2.17 D：仅非 root 且非队友；relay_phase 内含队友分相拒绝/请示逻辑，
 * 队友与 root 保留——纯上下文预算裁剪，执行层语义不变）。 */
export const SUBAGENT_ONLY_HIDDEN_TOOLS = Object.freeze([TOOL_PREFIX + 'phase']);

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

  // ── per-agent 安装（v0.2.12 Router + v0.2.17 B/C/D；单一模式对所有 agent 监听）─────
  // 作用域坑（seam findings Q1）：preset 行插件的 ctx 是「preset revision 挂载作用域」，
  // 在 apply 里直接 restrict 会裁掉该 revision 下所有 agent（含继承同 revision 的队友）。
  // 正解（内核 dsh-tool-subagent standing preset 同款先例）：监听 agent/created，在 agent
  // 自己的 ctx 上注入 tools/systemPrompt 再操作——只落该 agent layer；子会话的 scope chain
  // 父级是 generation 而非 Lead agent，不会误伤队友。
  // fail-open：任一名字未注册（如 Linux 下 pwsh）跳过；异常只 warn，绝不阻断会话创建。
  /** root = 顶层会话：只认 subagent 事实（origin/delegationDepth）；普通 fork 的 parentSession 是血缘，不是子代理。 */
  const isRootAgent = (session) => isRootSession(session);

  /** agent 自己的 scope；缺失（非常规 composition）→ warn 后跳过，不抛。 */
  const agentScopeOf = (agent, label) => {
    const scope = agent?.ctx;
    if (scope === undefined || scope === null || typeof scope.inject !== 'function') {
      ctx.logger?.warn?.('[dsh-context-relay] ' + label + ' skipped: agent.ctx unavailable');
      return undefined;
    }
    return scope;
  };

  /** 在 agent layer 逐名 restrict：restrict 校验「已知工具名」，一个名字未知会整体 throw，逐名保证 fail-open。 */
  const restrictAgentTools = (agent, names, label) => {
    const scope = agentScopeOf(agent, label);
    if (scope === undefined) return;
    try {
      scope.inject(['tools'], (runtimeCtx) => {
        const failed = [];
        let applied = 0;
        for (const name of names) {
          try { runtimeCtx.tools.restrict({ deny: [name] }); applied += 1; } catch { failed.push(name); }
        }
        // 单名失败通常是该平台未注册该工具 → 正常跳过；**全部失败**才 warn（preset 工具面异常/内核改工具名）。
        if (applied === 0) ctx.logger?.warn?.('[dsh-context-relay] ' + label + ': no tools restricted (failed: ' + failed.join(',') + ')');
      });
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] ' + label + ' skipped: ' + String(error?.message ?? error));
    }
  };

  /** 在 agent layer 注入一个 systemPrompt section（失败只 warn）。 */
  const installAgentSection = (agent, section, label) => {
    const scope = agentScopeOf(agent, label);
    if (scope === undefined) return;
    try {
      scope.inject(['systemPrompt'], (runtimeCtx) => { runtimeCtx.systemPrompt.section(section); });
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] ' + label + ' skipped: ' + String(error?.message ?? error));
    }
  };

  /** 在 agent layer 注册角色专属工具（agent scope；不污染其他 agent）。 */
  const registerAgentToolDefs = (agent, definitions, label) => {
    if (!Array.isArray(definitions) || definitions.length === 0) return;
    const scope = agentScopeOf(agent, label);
    if (scope === undefined) return;
    try {
      scope.inject(['tools'], (runtimeCtx) => {
        for (const definition of definitions) {
          try { runtimeCtx.tools.register(definition); } catch (error) { ctx.logger?.warn?.('[dsh-context-relay] ' + label + ' skipped ' + definition.name + ': ' + String(error?.message ?? error)); }
        }
      });
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] ' + label + ' skipped: ' + String(error?.message ?? error));
    }
  };

  /** root Lead：单一模式恒裁 bash/pwsh/write/edit + 注入 Router 协议段（v0.2.12；v0.9.0 恒开）。 */
  const installRootLead = (agent) => {
    restrictAgentTools(agent, ROUTER_DENY_TOOLS, 'router restrict');
    // Router 协议段只给 root Lead：队友/子会话是 worker（要亲自写/跑），看到「你是 Lead=Router」会反向误导。
    installAgentSection(agent, { name: 'context-relay:router', order: 10152, text: ROUTER_PROTOCOL_TEXT }, 'router protocol');
    // 队友保鲜（P0）：Lead 专属体检/换代工具与纪律段（独立 section，避免动 ROUTER 预算断言）。
    if (teamTools !== undefined) {
      // v0.9.0 批次3：顺序 status/renew/architect → dispatch/collect（Lead-only，root agent-scope）。
      registerAgentToolDefs(agent, [...teamTools.leadTools, ...delegationTools], 'team lead tools');
      installAgentSection(agent, { name: 'context-relay:team-lead', order: 10153, text: TEAM_LEAD_PROTOCOL_TEXT }, 'team lead protocol');
    }
  };

  /**
   * 直接队友：紧凑队友协议影子覆盖 preset 全量协议（10.9KB → 约 2.5KB）——
   * 队友不需要 Lead 的 phase 状态机/用户验收门/交接/压缩/面板纪律，只保留身份、汇报、
   * checkpoint/freshen、台账与 P0 上报。工具面仍保留 relay_phase（内含队友分相拒绝/请示逻辑）。
   */
  const installTeammatePlane = (agent) => {
    installAgentSection(agent, { name: 'context-relay:protocol', order: 10150, text: TEAMMATE_PROTOCOL_TEXT }, 'teammate protocol');
  };

  const installArchitectPlane = (agent) => {
    restrictAgentTools(agent, SUBAGENT_ONLY_HIDDEN_TOOLS, 'architect restrict');
    installAgentSection(agent, { name: 'context-relay:protocol', order: 10150, text: ARCHITECT_WORKER_PROTOCOL_TEXT }, 'architect protocol');
    if (teamTools !== undefined) {
      const checkpoint = teamTools.teammateTools.filter((definition) => definition.name === TOOL_PREFIX + 'checkpoint');
      registerAgentToolDefs(agent, checkpoint, 'architect tools');
    }
  };

  /**
   * 普通子代理（非 root 且非直接队友）的裁面 + 短 worker 协议（v0.2.17 C/D）：
   * C 用同名 section 在 agent layer 覆盖 preset 层全量协议；D 额外隐藏 relay_phase。
   */
  const installWorkerPlane = (agent) => {
    restrictAgentTools(agent, SUBAGENT_ONLY_HIDDEN_TOOLS, 'subagent restrict');
    installAgentSection(agent, { name: 'context-relay:protocol', order: 10150, text: WORKER_PROTOCOL_TEXT }, 'worker protocol');
  };

  /**
   * v0.7.1：rc.2 的 agent/created 早于 subagents 的 resident 登记（manager 在 create 返回后才
   * resident.set），创建瞬间 rootOf/namesOf 必然 UNAUTHORIZED → 旧实现把每个子代理都判成
   * "身份未知"，紧凑队友协议/架构师协议/checkpoint 工具全部装不上。创建瞬间的身份只能读
   * header 事实：depth 1 = 直接队友、depth ≥2 = 普通子代理；架构师用 spawn 前登记的 pending
   * 标记（relay_architect）或 roster 里的 sessionId（resume/重启后）认领。
   */
  const childDepthOf = (agent) => {
    const header = agent?.session?.header;
    if (header?.origin !== 'subagent' && !(typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) return 0;
    return Number.isInteger(header?.delegationDepth) && header.delegationDepth > 0 ? header.delegationDepth : 1;
  };

  /** relay_architect 在 spawn 前登记的 pending 标记（只认 depth=1 且父会话匹配；消费即失效）。 */
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

  /** 创建瞬间角色：只读 header 事实（rc.2 的团队服务此时尚未 resident，见上）。 */
  const roleAtCreation = (agent) => {
    const depth = childDepthOf(agent);
    if (depth <= 1) {
      const architect = architectByPending(agent) || architectByRoster(agent);
      return { kind: 'teammate', architect };
    }
    return { kind: 'worker', architect: false };
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

  /** agent/created：单一模式（v0.9.0 起无 classic 生产路径）。
   * root → seed 默认档 + Router 工具面裁剪/协议段/团队段；非 root → 一律裁 lead-only 工具；
   * 直接队友装紧凑队友协议 + checkpoint/freshen 工具面；普通子代理/孙代理裁 relay_phase 并装 worker 影子协议；
   * 架构师用独立影子协议。 */
  const installAgentPlane = (agent) => {
    if (agent === undefined || agent === null) return;
    if (isRootAgent(agent.session)) {
      seedRootDefault(agent);
      installRootLead(agent);
      return;
    }
    restrictAgentTools(agent, LEAD_ONLY_TOOLS, 'worker restrict');
    const role = roleAtCreation(agent);
    if (role.architect) {
      installArchitectPlane(agent);
    } else if (role.kind === 'teammate') {
      installTeammatePlane(agent);
      // 队友保鲜（P0）：单一模式里的直接队友拿到 relay_checkpoint + 记录纪律段。
      registerAgentToolDefs(agent, teamTools.teammateTools, 'team worker tools');
    } else if (role.kind === 'worker') {
      installWorkerPlane(agent);
    }
  };
  ctx.effect(() => ctx.on('agent/created', (payload) => installAgentPlane(payload?.agent)), 'dsh-context-relay: per-agent install');

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

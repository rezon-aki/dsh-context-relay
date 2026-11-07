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
import { PROTOCOL_TEXT, PROTOCOL_TEXT_LONG, ROUTER_DENY_TOOLS, ROUTER_PROTOCOL_TEXT, TEAM_LEAD_PROTOCOL_TEXT, TEAM_WORKER_PROTOCOL_TEXT, UNLIMITED_BUDGET_TEXT } from './agent/protocol.js';
import { createRelayTools } from './agent/tools.js';
import { installApprovalGate } from './agent/panel-gate.js';
import { installSentinel, clearSentinelMemory } from './agent/sentinel.js';
import { clearDeriveMemory } from './agent/derive.js';
import { clearSharedMemory, TOOL_PREFIX } from './agent/shared.js';
import { installHandoffRoute } from './agent/handoff.js';
import { WORKER_PROTOCOL_TEXT } from './agent/worker.js';
import { createTeamTools } from './agent/team-tools.js';
import { panelStateOf, seedPanelOperation, updatePanelState } from './panel-store.js';

export const name = 'dsh-context-relay-agent';
/** 只硬依赖工具与提示词注册；其余服务在执行时动态解析（缺服务时降级为结构化错误）。 */
export const inject = ['tools', 'systemPrompt'];

/** lead-only 工具（v0.2.17 B：非 root 的 worker 会话裁掉；名字即 tools.js / handoff.js 的注册名）。 */
export const LEAD_ONLY_TOOLS = Object.freeze([TOOL_PREFIX + 'organize', TOOL_PREFIX + 'handoff', TOOL_PREFIX + 'recommend']);

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
  /** 可选接力目标 preset 白名单（host 经 preset 行 config 传 [本模式, 长任务模式]）：面板 handoffPreset 的合法值来源。
   * 缺省/空数组只认本 preset（旧部署/直接挂载 agent 面的兼容口径）。 */
  const configuredPresetIds = Array.isArray(config.relayPresetIds) ? config.relayPresetIds.filter((id) => typeof id === 'string' && id !== '') : [];
  const relayPresetIds = configuredPresetIds.length > 0 ? configuredPresetIds : [presetId];
  /** M2-G A/B 开关：默认注入；false 时不注入 brief（供「有/无注入」归因实验）。 */
  const injectBrief = config.injectBrief !== false;
  /** audit H 人类确认硬门：默认 required；'off' 仅供测试 / 无审批 UI 的部署（残余风险见 VERDICT）。 */
  const handoffApproval = config.handoffApproval === 'off' ? 'off' : 'required';
  /** 接力继承旧会话设置（模型路由 + 权限）：默认开；false 时新会话回到部署默认。 */
  const inheritOnHandoff = config.inheritOnHandoff !== false;
  /** Router 模式（v0.2.12）：缺省关闭——classic 会话提示词/工具面完全不变；开启后只对 root Lead 注入 Router 协议段 + 工具面裁剪。
   * 正常部署走 preset 行 config（AGENT_OPTION_KEYS 透传）；host 进程内 live settings 的同名键只作内部/测试覆盖
   * （settings.json 与 HTTP 设置面没有该键，生产不会意外打开）。 */
  const routerMode = config.routerMode === true || liveSettings()?.routerMode === true;
  /** 队友保鲜（v0.3.0 P0）：仅 relay-long 模式启用；按 agent 角色注册（Lead: status/renew；队友: checkpoint）。 */
  const teamTools = routerMode ? createTeamTools({ ctx, currentThresholds }) : undefined;

  // ── 常驻协议：整个 relay preset 共享，每 phase 稳定，不逐轮改 ──────────────
  // v0.3.8：长模式（routerMode）用去掉「压缩→新会话 / 两段式」的派生协议；classic 文本不变。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'context-relay:protocol',
    order: 10150,
    text: routerMode ? PROTOCOL_TEXT_LONG : PROTOCOL_TEXT,
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

  // ── per-agent 安装（v0.2.12 Router + v0.2.17 B/C/D；classic 也监听）───────────────
  // 作用域坑（seam findings Q1）：preset 行插件的 ctx 是「preset revision 挂载作用域」，
  // 在 apply 里直接 restrict 会裁掉该 revision 下所有 agent（含继承同 revision 的队友）。
  // 正解（内核 dsh-tool-subagent standing preset 同款先例）：监听 agent/created，在 agent
  // 自己的 ctx 上注入 tools/systemPrompt 再操作——只落该 agent layer；子会话的 scope chain
  // 父级是 generation 而非 Lead agent，不会误伤队友。
  // fail-open：任一名字未注册（如 Linux 下 pwsh）跳过；异常只 warn，绝不阻断会话创建。
  /** root = 顶层会话：subagent/teammate 的 header 带 origin/parentSession/delegationDepth（与 B 判据互逆）。 */
  const isRootAgent = (header) => !(header?.origin === 'subagent' || header?.parentSession !== undefined || (header?.delegationDepth ?? 0) > 0);

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

  /** 在 agent layer 注册角色专属工具（agent scope；不污染 classic 会话与其他 agent）。 */
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

  /** root Lead：routerMode 时裁 bash/pwsh/write/edit + 注入 Router 协议段（v0.2.12；classic 不动 root）。 */
  const installRootLead = (agent) => {
    restrictAgentTools(agent, ROUTER_DENY_TOOLS, 'router restrict');
    // Router 协议段只给 root Lead：队友/子会话是 worker（要亲自写/跑），看到「你是 Lead=Router」会反向误导。
    installAgentSection(agent, { name: 'context-relay:router', order: 10152, text: ROUTER_PROTOCOL_TEXT }, 'router protocol');
    // 队友保鲜（P0）：Lead 专属体检/换代工具与纪律段（独立 section，避免动 ROUTER 预算断言）。
    if (teamTools !== undefined) {
      registerAgentToolDefs(agent, teamTools.leadTools, 'team lead tools');
      installAgentSection(agent, { name: 'context-relay:team-lead', order: 10153, text: TEAM_LEAD_PROTOCOL_TEXT }, 'team lead protocol');
    }
  };

  /**
   * 队友判定（v0.2.17 C 的 tryMembership 判据提前到这里，D 复用）：true=队友；false=普通子代理；
   * undefined=区分不了（teams 服务解析/查询抛错）→ 调用方保守处理（不裁 relay_phase、不覆盖协议）并 warn。
   */
  const teammateOf = (agent) => {
    const unavailable = (error) => {
      ctx.logger?.warn?.('[dsh-context-relay] worker protocol skipped: team membership unavailable (' + String(error?.message ?? error) + ')');
      return undefined;
    };
    let teams;
    try { teams = ctx.get?.('agentTeams'); }
    catch (error) { return unavailable(error); }
    if (teams === undefined || teams === null) return false; // 无团队服务 → 不可能有队友
    try { return teams.tryMembership?.(agent)?.role === 'teammate'; }
    catch (error) { return unavailable(error); }
  };

  /**
   * 普通子代理（非 root 且非队友）的裁面 + 短 worker 协议（v0.2.17 C/D）：
   * C 用同名 section 在 agent layer 覆盖 preset 层全量协议；D 额外隐藏 relay_phase
   * （队友保留——relay_phase 内有队友分相拒绝/请示逻辑）。队友、区分不了（undefined）一律不动。
   */
  const installWorkerPlane = (agent) => {
    if (teammateOf(agent) !== false) return;
    restrictAgentTools(agent, SUBAGENT_ONLY_HIDDEN_TOOLS, 'subagent restrict');
    installAgentSection(agent, { name: 'context-relay:protocol', order: 10150, text: WORKER_PROTOCOL_TEXT }, 'worker protocol');
  };

  /** relay-long 新 root 会话的默认模式种子=continue（v0.3.1；v0.4.0 模式持久后仍是新根会话初始模式）：
   * 仅当该会话无显式面板快照/defaultOperation 时写入（不覆盖人类显式值/接力继承值）；classic 不种；失败只 warn，不阻断会话创建。 */
  const seedLongRootDefault = (agent) => {
    if (!routerMode) return;
    try {
      const sessionId = agent?.session?.id;
      seedPanelOperation(sessionId, 'continue');
      // v0.3.8/v0.4.0：长模式没有「压缩→新会话」档——清升级残留的模式与推荐（经典 Relay 不受影响）。
      const panelNow = panelStateOf(sessionId);
      if (panelNow.defaultOperation === 'compress-then-handoff') {
        updatePanelState(sessionId, { defaultOperation: null }, { source: 'agent' });
      }
      if (panelNow.recommendedOperation === 'compress-then-handoff') {
        updatePanelState(sessionId, { recommendedOperation: null, recommendedReason: '', recommendedAt: null }, { source: 'agent' });
      }
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] long default operation seed skipped: ' + String(error?.message ?? error));
    }
  };

  /** agent/created：root → 只有 routerMode 时装 Router；非 root → 一律裁 lead-only 工具；
   * 普通子代理再裁 relay_phase 并装 worker 影子协议（队友只裁 lead-only、保留 relay_phase 与全协议）。 */
  const installAgentPlane = (agent) => {
    if (agent === undefined || agent === null) return;
    if (isRootAgent(agent.session?.header)) {
      if (routerMode) {
        seedLongRootDefault(agent);
        installRootLead(agent);
      }
      return;
    }
    restrictAgentTools(agent, LEAD_ONLY_TOOLS, 'worker restrict');
    installWorkerPlane(agent);
    // 队友保鲜（P0）：只有 relay-long 里的真队友才拿到 relay_checkpoint + 记录纪律段。
    if (routerMode && teamTools !== undefined && teammateOf(agent) === true) {
      registerAgentToolDefs(agent, teamTools.teammateTools, 'team worker tools');
      installAgentSection(agent, { name: 'context-relay:team-worker', order: 10153, text: TEAM_WORKER_PROTOCOL_TEXT }, 'team worker protocol');
    }
  };
  ctx.effect(() => ctx.on('agent/created', (payload) => installAgentPlane(payload?.agent)), 'dsh-context-relay: per-agent install');

  // ── 工具注册 ────────────────────────────────────────────────────────────
  const tools = createRelayTools({ ctx, currentThresholds, injectBrief, presetId, inheritOnHandoff, relayPresetIds, routerMode });
  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition), 'dsh-context-relay: ' + definition.name);
  }

  // ── 人类确认硬门（audit H）：官方 tools/pre-execute 审批 waterfall（fail-closed）──
  if (handoffApproval === 'required') {
    ctx.effect(() => installApprovalGate(ctx, currentThresholds, routerMode), 'dsh-context-relay: approval gate');
  }

  // ── 到线提醒：升线时注入（同档不重复；成功压缩重新武装）；每 step 发布面板实时状态 ──
  ctx.effect(() => installSentinel(ctx, currentThresholds, routerMode), 'dsh-context-relay: reminder');

  // ── relay_handoff 继承：子会话首次模型请求套用旧会话路由（消费即删）──
  ctx.effect(() => installHandoffRoute(ctx), 'dsh-context-relay: handoff route');

  // ── 卸载清理：模块级缓存/哨兵/在途锁（handoff 路由是 globalThis，跨实例共享，不在此清）──
  ctx.effect(() => () => {
    clearDeriveMemory();
    clearSentinelMemory();
    clearSharedMemory();
  }, 'dsh-context-relay: state cleanup');
}

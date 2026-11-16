/**
 * dsh-context-relay — 声明式 agent 平面：角色表（单一真源）。
 *
 * 角色 → { deny, sections, tools, seed }：
 *   deny     工具面裁剪（[{label, names}]；label 用于 fail-open/降级日志）
 *   sections 影子协议段（同名 section 覆盖 preset 层；[{name, order, text, label}]）
 *   tools    角色专属工具组（注册名由 agent/agent.js 的 planeRuntime.toolsOf 提供）
 *   seed     root Lead 的面板默认档种子（由 agent.js 提供实现）
 *
 * agent.js 只做薄封装：由本表驱动安装，幂等 reconcile 在 lib/plane/ensure.js。
 * 协议文本一律从 agent/protocol.js、agent/worker.js 导入（不复制，避免双份漂移）。
 *
 * 角色判定（M-02）：root = 顶层会话（只认 subagent 事实，fork 血缘不算子代理）；
 * depth=1 = 直接队友（架构师用 spawn 前 pending 标记或 roster 认领，由调用方注入判定）；
 * depth≥2 = 普通子代理（worker）。
 *
 * @module dsh-context-relay/plane/roles
 */
import { isRootSession, TOOL_PREFIX } from '../agent/shared.js';
import {
  ARCHITECT_WORKER_PROTOCOL_TEXT,
  ROUTER_DENY_TOOLS,
  ROUTER_PROTOCOL_TEXT,
  TEAMMATE_PROTOCOL_TEXT,
  TEAM_LEAD_PROTOCOL_TEXT,
} from '../agent/protocol.js';
import { WORKER_PROTOCOL_TEXT } from '../agent/worker.js';

/** lead-only 工具（v0.2.17 B：非 root 的 worker 会话裁掉；名字即 tools.js / handoff.js 的注册名）。
 * v0.7.1：台账 v0.7.0 起就是 Leader-only（执行层已拒队友）→ 把 relay_work_items 也裁掉，避免每个子代理白背 schema。 */
export const LEAD_ONLY_TOOLS = Object.freeze([TOOL_PREFIX + 'organize', TOOL_PREFIX + 'handoff', TOOL_PREFIX + 'recommend', TOOL_PREFIX + 'work_items']);

/** 普通子代理额外隐藏的工具（v0.2.17 D：仅非 root 且非队友；relay_phase 内含队友分相拒绝/请示逻辑，
 * 队友与 root 保留——纯上下文预算裁剪，执行层语义不变）。 */
export const SUBAGENT_ONLY_HIDDEN_TOOLS = Object.freeze([TOOL_PREFIX + 'phase']);

/** 影子协议段名（与 preset 层 context-relay:protocol 同名，靠宿主分层合并覆盖）。 */
export const PROTOCOL_SECTION_NAME = 'context-relay:protocol';

const section = (name, order, text, label) => Object.freeze({ name, order, text, label });
const denyGroup = (label, names) => Object.freeze({ label, names });
const toolGroup = (group, label) => Object.freeze({ group, label });

/** 四个角色的完整施工图（唯一真源）。 */
export const ROLES = Object.freeze({
  lead: Object.freeze({
    deny: Object.freeze([denyGroup('router restrict', ROUTER_DENY_TOOLS)]),
    sections: Object.freeze([
      section('context-relay:router', 10152, ROUTER_PROTOCOL_TEXT, 'router protocol'),
      section('context-relay:team-lead', 10153, TEAM_LEAD_PROTOCOL_TEXT, 'team lead protocol'),
    ]),
    // v0.9.0 批次3：顺序 status/renew/architect → dispatch/collect（Lead-only，root agent-scope）。
    tools: Object.freeze([toolGroup('lead', 'team lead tools'), toolGroup('delegation', 'delegation tools')]),
    seed: true,
  }),
  teammate: Object.freeze({
    deny: Object.freeze([denyGroup('worker restrict', LEAD_ONLY_TOOLS)]),
    sections: Object.freeze([section(PROTOCOL_SECTION_NAME, 10150, TEAMMATE_PROTOCOL_TEXT, 'teammate protocol')]),
    tools: Object.freeze([toolGroup('teammate', 'team worker tools')]),
    seed: false,
  }),
  architect: Object.freeze({
    deny: Object.freeze([
      denyGroup('worker restrict', LEAD_ONLY_TOOLS),
      denyGroup('architect restrict', SUBAGENT_ONLY_HIDDEN_TOOLS),
    ]),
    sections: Object.freeze([section(PROTOCOL_SECTION_NAME, 10150, ARCHITECT_WORKER_PROTOCOL_TEXT, 'architect protocol')]),
    tools: Object.freeze([toolGroup('checkpoint', 'architect tools')]),
    seed: false,
  }),
  worker: Object.freeze({
    deny: Object.freeze([
      denyGroup('worker restrict', LEAD_ONLY_TOOLS),
      denyGroup('subagent restrict', SUBAGENT_ONLY_HIDDEN_TOOLS),
    ]),
    sections: Object.freeze([section(PROTOCOL_SECTION_NAME, 10150, WORKER_PROTOCOL_TEXT, 'worker protocol')]),
    tools: Object.freeze([]),
    seed: false,
  }),
});

/**
 * 会话在 subagent 树里的深度：0 = root；1 = 直接队友；≥2 = 普通子代理。
 * 只读 header 事实（rc.2 的 agent/created 早于 subagents resident 登记，创建瞬间团队服务不可用）。
 * @param {object} agent
 * @returns {number}
 */
export function delegationDepthOf(agent) {
  const header = agent?.session?.header;
  if (isRootSession(agent?.session)) return 0;
  return Number.isInteger(header?.delegationDepth) && header.delegationDepth > 0 ? header.delegationDepth : 1;
}

/**
 * 纯函数角色判定：root=lead；depth=1=teammate（架构师由 options.isArchitect 认领）；depth≥2=worker。
 * options.isArchitect 只在该判定的调用方（agent.js，持有 pending/roster 事实）注入；异常按非架构师降级。
 * @param {object} agent
 * @param {{isArchitect?: (agent: object) => boolean}} [options]
 * @returns {'lead'|'teammate'|'architect'|'worker'}
 */
export function roleOfAgent(agent, options = {}) {
  const depth = delegationDepthOf(agent);
  if (depth <= 0) return 'lead';
  if (depth > 1) return 'worker';
  if (typeof options.isArchitect !== 'function') return 'teammate';
  try {
    return options.isArchitect(agent) === true ? 'architect' : 'teammate';
  } catch {
    return 'teammate';
  }
}

/**
 * 角色工具面单一真源（actor lint 与 budget 装配实测快照共用）。
 * 顺序 = 装配顺序（preset 常驻在前，agent scope 注册在后）；新增/删除工具必须同步改这里。
 */
export const LEAD_TOOL_NAMES = Object.freeze([
  'relay_status', 'relay_recommend', 'relay_phase', 'relay_organize', 'relay_doc', 'doc_lint', 'relay_work_items', 'relay_handoff',
  'relay_team_status', 'relay_renew', 'relay_architect', 'relay_dispatch', 'relay_collect',
]);

export const TEAMMATE_TOOL_NAMES = Object.freeze([
  'relay_status', 'relay_phase', 'relay_doc', 'relay_checkpoint', 'relay_freshen',
]);

export const ARCHITECT_TOOL_NAMES = Object.freeze(['relay_doc', 'relay_checkpoint']);

export const WORKER_TOOL_NAMES = Object.freeze(['relay_doc']);

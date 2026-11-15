/**
 * host/agent 共用的模型默认解析真源：与官方 client projected.next ?? catalog.default 同口径。
 * 只读、不调 llm；各来源失败独立降级，无法解析时返回 null。
 */
import { normalizeArchitectModel } from './policy.js';

export function modelSelectionDefaultOf(ctx, { session, options } = {}) {
  try {
    const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined;
    const selection = projections?.stateOf?.(session, 'modelSelection');
    const route = normalizeArchitectModel(selection?.pending ?? selection?.lastUsed);
    if (route !== null) return route;
  } catch { /* 投影不可用，尝试 header。 */ }
  try {
    const header = session?.requestHeader?.();
    const config = header?.config;
    const route = normalizeArchitectModel({
      provider: config?.provider,
      model: config?.model,
      ...(header?.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: config?.reasoningEffort }),
    });
    if (route !== null) return route;
  } catch { /* header 不可用，尝试部署默认。 */ }
  try {
    const defaults = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    const route = normalizeArchitectModel(defaults?.currentSelection?.());
    if (route !== null) return route;
  } catch { /* 部署默认不可用，尝试 agent options。 */ }
  try { return normalizeArchitectModel(options); } catch { return null; }
}

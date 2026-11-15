/**
 * dsh-context-relay — relay 自己创建的 subagent activation 句柄登记表。
 *
 * rc.2 没有逐 id 的 drainChildren；startActivation 返回的 activation.dispose() 是唯一
 * “只释放这一代”的官方能力。renew 必须在 spawn 新代前释放旧代，否则 continuable 子智能体
 * 会一直占 per-root 的 maxActiveSubagents 槽位。模型自己用官方 subagent 创建的成员没有
 * 这个句柄——只能 interrupt，不能逐 id 释放（不承诺）。
 *
 * 只在进程内有效；重启后旧 handle 自然丢失，退化为“不可释放”。
 *
 * @module dsh-context-relay/agent/activations
 */

const HANDLES = new Map();
const MAX = 200;

function keyOf(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
}

/** 登记一个 relay 创建的 activation（同 id 覆盖）。 */
export function rememberActivation(sessionId, activation) {
  const key = keyOf(sessionId);
  if (key === undefined || activation === undefined || activation === null) return;
  HANDLES.set(key, activation);
  while (HANDLES.size > MAX) HANDLES.delete(HANDLES.keys().next().value);
}

/** 取出并移除（调用方负责 dispose）。 */
export function takeActivation(sessionId) {
  const key = keyOf(sessionId);
  if (key === undefined) return undefined;
  const activation = HANDLES.get(key);
  if (activation === undefined) return undefined;
  HANDLES.delete(key);
  return activation;
}

/** 只删除登记，不 dispose（例如已自然结算）。 */
export function forgetActivation(sessionId) {
  const key = keyOf(sessionId);
  if (key !== undefined) HANDLES.delete(key);
}

/** 释放并移除；返回是否真的提交了 dispose（没有 handle / dispose 失败都返回 false）。 */
export async function disposeActivation(sessionId) {
  const activation = takeActivation(sessionId);
  if (activation === undefined || typeof activation.dispose !== 'function') return false;
  try {
    await activation.dispose();
    return true;
  } catch {
    return false;
  }
}

/** 测试/卸载清理。 */
export function clearActivations() {
  HANDLES.clear();
}

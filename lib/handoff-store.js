/**
 * dsh-context-relay — handoff 发布箱（M3 提示用；只提示不自动切页）。
 *
 * agent 面（lib/agent.js 的 relay_handoff 成功后）写入；Host 面（lib/index.js 的
 * GET /context-relay/api）读出；浏览器 client bundle 轮询后提示新会话可打开（不自动切页）。
 *
 * 用 globalThis 存：抗热重载/模块多实例；进程重启清空（client 侧只按 createdAt
 * 忽略页面加载前就存在的旧 handoff，不做跨进程持久化）。保留最近 8 条、按记录时间倒序，
 * 供 client 逐条消费（旧实现只读最新一条时可继续读 items[0]）；单字段截断。
 */

const KEY = Symbol.for('dsh-context-relay.handoffs');

/** 发布箱容量：保留最近 8 条（两次接力落在同一轮询窗口内时不互相覆盖）。 */
export const HANDOFF_STORE_LIMIT = 8;

const clip = (value, limit) => (value === undefined || value === null ? '' : String(value).slice(0, limit));

function box() {
  const current = globalThis[KEY];
  if (current !== undefined && current !== null && !Array.isArray(current) && Array.isArray(current.items)) return current;
  // 兼容旧版热重载：数组发布箱重置为空；单条发布箱（{seq,lastIdTs,latest}）迁移为 1 条。
  const items = current?.latest === undefined || current?.latest === null ? [] : [current.latest];
  const next = { seq: Number(current?.seq) || 0, lastIdTs: Number(current?.lastIdTs) || 0, items };
  globalThis[KEY] = next;
  return next;
}

/**
 * 记录一次成功 handoff；返回严格单调的复合 id（`<ms时间戳>-<seq>`）。
 * 时间戳前缀保证跨进程单调（进程重启后 seq 归零也不会与旧 id 等值 → client 不会把
 * 新 handoff 当已见吞掉）；lastIdTs 保证同一毫秒内仍严格递增。
 * 新记录插入队首，超过容量时丢弃最旧一条。
 */
export function recordHandoff(entry = {}) {
  const current = box();
  const ts = Math.max(Date.now(), current.lastIdTs + 1);
  current.lastIdTs = ts;
  const item = {
    id: ts + '-' + (++current.seq),
    sessionId: clip(entry.sessionId, 200),
    parentSessionId: clip(entry.parentSessionId, 200),
    title: clip(entry.title, 120),
    phase: clip(entry.phase, 20),
    goal: clip(entry.goal, 120),
    summary: clip(entry.summary, 200),
    createdAt: Date.now(),
  };
  current.items.unshift(item);
  if (current.items.length > HANDOFF_STORE_LIMIT) current.items.length = HANDOFF_STORE_LIMIT;
  return item.id;
}

/** 只读快照（数组、最新在前，只含最近 `HANDOFF_STORE_LIMIT` 条）；空箱返回空数组。 */
export function listHandoffs() {
  return box().items.map((item) => ({ ...item }));
}

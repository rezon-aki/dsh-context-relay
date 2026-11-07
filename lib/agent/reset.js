/**
 * dsh-context-relay — 真清空 reset 核心原语。
 *
 * 队友在任务边界排队一次 reset：该会话下一次模型请求前（调用方在 agent/pre-step
 * 执行），append 一条 user/message，用 surfaceOp=replace 覆盖除系统提示外的全部
 * 当前 surface 节点；旧事件留在 append-only 日志（可 session_event_read 召回），
 * 模型下一请求只看到 system + reset brief。真机证据见
 * `.scratch/context-relay/reports/probe-truth-wipe-20261107.md`。
 *
 * 本模块只负责范围计算 / surface 替换 / 内存 pending；ledger、chain、brief 与
 * 失败回退（官方压缩）由调用方负责。append 抛错原样抛出，由调用方决定 fallback。
 *
 * @module dsh-context-relay/agent/reset
 */
import { randomUUID } from 'node:crypto';

/** 内存 pending 队列：sessionId → 排队 payload（进程重启即丢，调用方按 scheduled 语义如实回报）。 */
const PENDING_RESETS = new Map();

function reasonOf(error) { return String(error?.message ?? error); }

/** 测当前会话 token（tokenMeter 缺失/抛错 → undefined，不阻断 reset）。 */
function measureTokens(ctx, session) {
  try { return ctx?.get?.('tokenMeter')?.measure?.(session)?.totalTokens ?? undefined; } catch { return undefined; }
}

/**
 * 计算真清空范围：保留 surface node0（系统提示），其余节点全部遮蔽。
 * @param {object} session DSH 会话（surface.nodes / eventAt / deriveEventMessage）。
 * @returns {{ok: true, startSeq: number, endSeq: number, shadowedSeqs: number[], nodeCount: number}
 *   | {ok: false, code: 'surface-too-short' | 'no-system-head' | 'range-failed', reason: string}}
 */
export function computeResetRange(session) {
  try {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) {
      return { ok: false, code: 'surface-too-short', reason: 'surface needs node0 (system) plus at least one more node; got ' + (Array.isArray(nodes) ? nodes.length : 'no nodes') };
    }
    const head = session.deriveEventMessage(session.eventAt(nodes[0]));
    if (head?.role !== 'system') {
      return { ok: false, code: 'no-system-head', reason: 'surface node0 is not a system message; refusing to wipe it' };
    }
    return { ok: true, startSeq: nodes[1], endSeq: nodes[nodes.length - 1], shadowedSeqs: nodes.slice(1), nodeCount: nodes.length };
  } catch (error) {
    return { ok: false, code: 'range-failed', reason: reasonOf(error) };
  }
}

/**
 * 执行一次真清空：append 一条 user/message 替换 [startSeq, endSeq] 的 surface 节点。
 * @param {object} ctx 插件上下文（可选；仅用于 tokenMeter 度量）。
 * @param {object} session DSH 会话。
 * @param {string} brief 清空后唯一保留的用户消息内容。
 * @param {{reason?: string}} [options] source.reason（默认 relay-reset）。
 * @returns {{ok: true, seq: number, startSeq: number, endSeq: number, shadowedSeqs: number[], shadowedNodes: number, beforeTokens: number | undefined, afterTokens: number | undefined}
 *   | {ok: false, code: string, reason: string}}
 */
export function performWipe(ctx, session, brief, options = {}) {
  const range = computeResetRange(session);
  if (range.ok !== true) return range;
  const { startSeq, endSeq, shadowedSeqs } = range;
  const beforeTokens = measureTokens(ctx, session);
  const message = {
    role: 'user',
    content: [{ type: 'text', text: String(brief) }],
    source: { kind: 'reset', reason: String(options.reason ?? 'relay-reset'), shadowed: shadowedSeqs.length },
    id: randomUUID(),
  };
  const event = session.append('user/message', message, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: shadowedSeqs });
  const afterTokens = measureTokens(ctx, session);
  return { ok: true, seq: event.seq, startSeq, endSeq, shadowedSeqs, shadowedNodes: shadowedSeqs.length, beforeTokens, afterTokens };
}

/**
 * 排队一次 reset（同会话覆盖；下一次 pre-step 由调用方消费）。
 * @param {string} sessionId 会话 id（必填非空字符串）。
 * @param {object} payload 原样保存（如 {brief, reason}）。
 * @returns {{replaced: boolean}} 是否覆盖了已有排队。
 */
export function scheduleReset(sessionId, payload) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('scheduleReset requires a non-empty sessionId string');
  const replaced = PENDING_RESETS.has(sessionId);
  PENDING_RESETS.set(sessionId, payload);
  return { replaced };
}

/** 取走并删除排队（没有 → undefined；只能消费一次）。 */
export function takePendingReset(sessionId) {
  if (!PENDING_RESETS.has(sessionId)) return undefined;
  const payload = PENDING_RESETS.get(sessionId);
  PENDING_RESETS.delete(sessionId);
  return payload;
}

/** 是否有排队（不消费）。 */
export function hasPendingReset(sessionId) { return PENDING_RESETS.has(sessionId); }

/** 清空全部排队（测试清理；生产不用）。 */
export function clearPendingResets() { PENDING_RESETS.clear(); }

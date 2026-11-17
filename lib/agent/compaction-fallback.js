/**
 * dsh-context-relay — P1-A 宿主自动压缩兜底（v0.11）。
 *
 * 两件事（全 fail-open，调用方 sentinel 负责 try/catch 与日志）：
 * 1) 归因纯函数 attributeCompaction：宿主压缩 vs 插件发起的压缩（relay_organize / relay_freshen）。
 *    信号 = compaction/end 的 compactionId + chain.ndjson 最近 ≤20 条条目（同 id 命中 kind）。
 * 2) 宿主归因时写最小恢复快照（≤2KB，原子写）+ 追加 chain 指针（kind=compaction, note=host-auto-fallback），
 *    给 Lead 在 phase 边界主动 relay_organize 前的恢复入口。不新增工具、不改内核。
 *
 * @module dsh-context-relay/agent/compaction-fallback
 */
import { workspaceStore } from '../storage.js';
import { appendChainEntry, CHAIN_RELATIVE } from './chain.js';

/** 四态归因（unknown 不写快照、只由调用方 logWarn）。 */
export const FALLBACK_ATTRIBUTIONS = Object.freeze(['relay-organize', 'relay-freshen', 'host', 'unknown']);
/** 恢复快照目录（workspace 记录目录内相对路径）。 */
export const RECOVERY_RELATIVE_DIR = 'recovery';
/** 快照硬上限（字节；超长按 UTF-8 安全截断）。 */
export const RECOVERY_MAX_BYTES = 2048;
/** chain 回看条数（设计 §3.5：最近 ≤20 条）。 */
export const CHAIN_LOOKBACK = 20;

/**
 * 归因纯函数：最近一次成功压缩是否由插件发起？
 * - compactionId 缺失/空 → unknown（不猜）；
 * - 同 id 命中 chain kind=compaction → relay-organize；命中 teammate-freshen/teammate-reset → relay-freshen；
 * - 有 id 但 chain 里没有同 id（或条目不可读/为空）→ host（宿主引擎自行压缩）；
 * - host 兜底自己写入的 kind=compaction 条目（note=host-auto-fallback）不算插件主持，跳过。
 */
export function attributeCompaction({ compactionId, entries } = {}) {
  if (typeof compactionId !== 'string' || compactionId.trim() === '') return 'unknown';
  const list = Array.isArray(entries) ? entries.slice(-CHAIN_LOOKBACK) : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.compactionId !== compactionId) continue;
    if (entry.note === 'host-auto-fallback') continue;
    if (entry.kind === 'compaction') return 'relay-organize';
    if (entry.kind === 'teammate-freshen' || entry.kind === 'teammate-reset') return 'relay-freshen';
  }
  return 'host';
}

/** 快照相对路径：sessionId 只保留安全字符（防路径注入），超长截断。 */
export function recoveryRelativePathOf(sessionId) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return RECOVERY_RELATIVE_DIR + '/compaction-' + (safe === '' ? 'unknown' : safe) + '.md';
}

/** 单行裁剪（展示字段，避免快照被长文本撑爆）。 */
function clip(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return '';
  const chars = Array.from(text);
  return chars.length <= max ? chars.join('') : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** UTF-8 安全截断：保证 byteLength ≤ maxBytes。 */
function clipUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const chars = Array.from(text);
  while (chars.length > 0 && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) chars.pop();
  return chars.join('') + '…';
}

/**
 * 构建最小恢复快照（纯函数，≤RECOVERY_MAX_BYTES）。
 * 六类指针：①会话/压缩身份 ②phase/goal/exit_criteria ③工作台账焦点 ④团队待处理 ⑤滚动进度 ⑥链式召回。
 */
export function buildRecoverySnapshot(input = {}) {
  const ledger = input.ledger;
  const counts = ledger === undefined || ledger === null ? undefined : ledger.counts;
  const countText = counts === undefined || counts === null
    ? '（无台账）'
    : 'pending ' + String(counts.pending ?? '?') + ' / total ' + String(counts.total ?? '?');
  const focusRaw = typeof ledger?.focus === 'string' && ledger.focus !== '' ? ledger.focus : '（无焦点行）';
  const pendingRaw = Array.isArray(input.teamPending) && input.teamPending.length > 0 ? input.teamPending.join(', ') : '无';
  // 六类指针固定保留：超 2KB 时逐轮缩小字段（而不是截掉后半篇），保证恢复入口齐全。
  const caps = { id: 200, text: 240, path: 200 };
  const build = (c) => [
    '# 宿主自动压缩 · 最小恢复快照',
    '',
    '- 归因: host（插件未主持压缩；完整 phase brief 未生成）',
    '- 生成时间: ' + clipUtf8(String(input.at ?? ''), 40),
    '',
    '## 1. 会话与压缩身份',
    '- sessionId: ' + clipUtf8(String(input.sessionId ?? '?'), c.id),
    '- compactionId: ' + clipUtf8(String(input.compactionId ?? '?'), c.id),
    '',
    '## 2. phase / 目标 / 退出条件',
    '- phase: ' + (clipUtf8(String(input.phase ?? ''), 40) || 'discover'),
    '- goal: ' + (clipUtf8(String(input.goal ?? ''), c.text) || '（未记录）'),
    '- exit_criteria: ' + (clipUtf8(String(input.exitCriteria ?? ''), c.text) || '（未记录）'),
    '',
    '## 3. 工作台账焦点',
    '- 路径: ' + (clipUtf8(String(ledger?.path ?? ''), c.path) || '（无台账）'),
    '- 计数: ' + clipUtf8(countText, 80),
    '- 焦点: ' + clipUtf8(focusRaw, c.text),
    '',
    '## 4. 团队待处理',
    '- 待处理队友: ' + clipUtf8(pendingRaw, c.text),
    '- 团队上下文: ' + (clipUtf8(String(input.teamContextPath ?? ''), c.path) || '（无）'),
    '',
    '## 5. 滚动进度',
    '- 进度文件: ' + (clipUtf8(String(input.progressPath ?? ''), c.path) || '.scratch/context-relay/progress.md'),
    '',
    '## 6. 链式召回',
    '- 链式索引: ' + (clipUtf8(String(input.chainPath ?? ''), c.path) || CHAIN_RELATIVE),
    '- 召回: 用 session_event_read({session_id, seq}) 按被遮蔽区间精确回读；先读本快照 + progress + 工作台账，再回读旧结论。',
    '',
    '> 旧上下文已被宿主压缩遮蔽：本快照不是完整 brief；建议此后在 phase 边界主动 relay_organize 生成完整 brief。',
  ].join('\n') + '\n';
  let text = build(caps);
  let rounds = 0;
  while (Buffer.byteLength(text, 'utf8') > RECOVERY_MAX_BYTES && rounds < 24) {
    caps.id = Math.max(16, Math.floor(caps.id * 0.75));
    caps.text = Math.max(24, Math.floor(caps.text * 0.75));
    caps.path = Math.max(16, Math.floor(caps.path * 0.75));
    text = build(caps);
    rounds += 1;
  }
  return clipUtf8(text, RECOVERY_MAX_BYTES);
}

/**
 * 写宿主兜底产物：最小恢复快照（原子写，覆盖）+ chain 指针（kind=compaction, note=host-auto-fallback）。
 * 永不抛：分别捕获快照/chain 失败并返回结果，由调用方决定 logWarn 与 notice 文案（fail-open）。
 * @returns {Promise<{snapshotOk:boolean, path?:string, bytes?:number, chainOk:boolean, snapshotError?:string, chainError?:string}>}
 */
export async function writeHostCompactionRecovery(cwd, input = {}) {
  const relativePath = recoveryRelativePathOf(input.sessionId);
  const content = buildRecoverySnapshot(input);
  let snapshotOk = false;
  let snapshotError;
  let bytes;
  try {
    const store = workspaceStore(cwd);
    await store.writeAtomic(relativePath, content);
    snapshotOk = true;
    bytes = Buffer.byteLength(content, 'utf8');
  } catch (error) {
    snapshotError = String(error?.message ?? error);
  }
  let chainOk = false;
  let chainError;
  try {
    await appendChainEntry(cwd, {
      kind: 'compaction',
      sessionId: String(input.sessionId ?? ''),
      phase: input.phase,
      goal: typeof input.goal === 'string' ? input.goal : undefined,
      compactionId: String(input.compactionId ?? ''),
      note: 'host-auto-fallback',
      briefPath: '.scratch/context-relay/' + relativePath,
    });
    chainOk = true;
  } catch (error) {
    chainError = String(error?.message ?? error);
  }
  return {
    snapshotOk,
    chainOk,
    relativePath: '.scratch/context-relay/' + relativePath,
    ...(bytes === undefined ? {} : { bytes }),
    ...(snapshotError === undefined ? {} : { snapshotError }),
    ...(chainError === undefined ? {} : { chainError }),
  };
}

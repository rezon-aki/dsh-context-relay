import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAY_PROJECTION_KEY,
  relayProjectionDefinition,
  initialState,
  foldRelayEvent,
} from '../lib/projection.js';

const PHASE_TOOL = 'relay_phase';
const ORGANIZE_TOOL = 'relay_organize';
const OK_TEXT = 'organized: freed 1234 tokens; band organize → ok; brief /tmp/phase.md';

/** 用公开的 definition（init + apply）折叠事件数组，模拟 registry 的驱动路径。 */
function fold(events) {
  const definition = relayProjectionDefinition();
  return events.reduce((state, event) => definition.apply(state, event), definition.init());
}

function ptc(seq, name, args, overrides = {}) {
  return {
    type: 'tool/ptc-dispatch',
    seq,
    data: { subCallId: 'sub-' + seq, name, arguments: args, isError: false, content: [], ...overrides },
  };
}

function ptcText(seq, name, text, overrides = {}) {
  return ptc(seq, name, undefined, { content: [{ type: 'text', text }], ...overrides });
}

function directCall(seq, name, callId, args) {
  return { type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } };
}

function directResult(seq, callId, text, failed = false) {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: failed },
      ...(failed ? { error: { name: 'ToolError', code: 'tool_failed' } } : {}),
    },
  };
}

function noticeEvent(seq, band, options = {}) {
  const summary = options.summary ?? ('[context-relay] band=' + band + ' · phase=build · relay 自动提醒（非用户发言）');
  const text = options.text ?? (summary + '；下一步：收尾当前 phase');
  return {
    type: 'user/message',
    seq,
    data: {
      role: 'user',
      id: 'msg-' + seq,
      content: [{ type: 'text', text }],
      source: { kind: options.kind ?? 'dsh-context-relay', form: 'notice', summary },
    },
  };
}

function compactionEnd(seq) {
  return { type: 'compaction/end', seq, data: { compactionId: 'comp-' + seq } };
}

test('definition: 官方契约字段与 duck-typed stateSchema', () => {
  const definition = relayProjectionDefinition();
  assert.equal(RELAY_PROJECTION_KEY, 'relay');
  assert.equal(definition.key, 'relay');
  assert.equal(definition.stateVersion, 3, 'v3 新增工具调用计数（Router P0 度量），stateVersion 必须 bump');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(definition.apply, foldRelayEvent);
  const value = { any: 'thing', nested: [1, 2, 3] };
  assert.equal(definition.stateSchema.parse(value), value);
  assert.deepEqual(definition.init(), initialState);
});

test('初始状态字段契约固定', () => {
  assert.deepEqual(initialState, {
    phase: 'discover',
    goal: null,
    exitCriteria: null,
    organizeCount: 0,
    compactionEpoch: 0,
    noticeBand: null,
    lastNoticeSeq: -1,
    lastCompactionSeq: -1,
    lastContinueActionSeq: -1,
    toolCalls: 0,
    executionCalls: 0,
  });
  assert.ok(Object.isFrozen(initialState), 'initialState 应冻结防误改');
});

test('PTC relay_phase 派生 phase/goal/exitCriteria', () => {
  const state = fold([ptc(1, PHASE_TOOL, { phase: 'build', goal: '实现投影', exit_criteria: '单测全绿' })]);
  assert.equal(state.phase, 'build');
  assert.equal(state.goal, '实现投影');
  assert.equal(state.exitCriteria, '单测全绿');
});

test('PTC phase：非法取值与 isError 调用不覆盖上一个有效 phase', () => {
  const state = fold([
    ptc(1, PHASE_TOOL, { phase: 'build' }),
    ptc(2, PHASE_TOOL, { phase: 'nope' }),
    ptc(3, PHASE_TOOL, { phase: 'decide' }, { isError: true }),
    ptc(4, PHASE_TOOL, null),
  ]);
  assert.equal(state.phase, 'build');
});

test('PTC phase：新 phase 未提供 goal/exit 时清空旧值（不残留上一 phase 目标）', () => {
  const state = fold([
    ptc(1, PHASE_TOOL, { phase: 'build', goal: 'old-goal', exit_criteria: 'old-exit' }),
    ptc(2, PHASE_TOOL, { phase: 'verify' }),
  ]);
  assert.equal(state.phase, 'verify');
  assert.equal(state.goal, null);
  assert.equal(state.exitCriteria, null);
});

test('直调 relay_phase：tool/call + tool/result 按 callId 配对后生效', () => {
  const state = fold([
    directCall(1, PHASE_TOOL, 'call-phase-1', { phase: 'decide', goal: 'g', exit_criteria: 'e' }),
    directResult(2, 'call-phase-1', 'phase → decide (was discover)'),
  ]);
  assert.equal(state.phase, 'decide');
  assert.equal(state.goal, 'g');
  assert.equal(state.exitCriteria, 'e');
});

test('直调 relay_phase：失败结果不生效，未配对调用不生效', () => {
  const state = fold([
    directCall(1, PHASE_TOOL, 'call-phase-1', { phase: 'ship' }),
    directResult(2, 'call-phase-1', 'boom', true),
    directCall(3, PHASE_TOOL, 'call-phase-2', { phase: 'verify' }),
  ]);
  assert.equal(state.phase, 'discover');
});

test('organizeCount：PTC 只计真实压缩成功，拒绝/空压缩/isError 不计', () => {
  let state = fold([
    ptcText(1, ORGANIZE_TOOL, OK_TEXT),
    ptcText(2, ORGANIZE_TOOL, 'not organized: below the organize zone. Brief written to /tmp/b.md'),
    ptcText(3, ORGANIZE_TOOL, 'no compactable history; brief written to /tmp/b.md'),
    ptcText(4, ORGANIZE_TOOL, OK_TEXT, { isError: true }),
    ptcText(5, ORGANIZE_TOOL, 'organized: freed 999 tokens; band organize → ok'),
  ]);
  assert.equal(state.organizeCount, 2);
  state = fold([ptcText(1, ORGANIZE_TOOL, '前缀不是 organized: freed 的文本：' + OK_TEXT)]);
  assert.equal(state.organizeCount, 0, 'PTC 判定按前缀 startsWith，不按包含');
});

test('organizeCount：直调按 callId 配对，成功计数、失败/错配/无结果不计', () => {
  const state = fold([
    directCall(1, ORGANIZE_TOOL, 'call-org-1', { phase: 'build' }),
    directResult(2, 'call-org-1', OK_TEXT),
    directResult(3, 'call-org-orphan', OK_TEXT),
    directCall(4, ORGANIZE_TOOL, 'call-org-2', { phase: 'build' }),
    directResult(5, 'call-org-2', OK_TEXT, true),
    directCall(6, ORGANIZE_TOOL, 'call-org-3', { phase: 'build' }),
    directResult(7, 'call-org-3', 'not organized: below the organize zone'),
    directCall(8, ORGANIZE_TOOL, 'call-org-4', { phase: 'build' }),
  ]);
  assert.equal(state.organizeCount, 1);
});

test('直调非 relay 工具调用不进入 pending（不产生派生变化）', () => {
  const definition = relayProjectionDefinition();
  const state = definition.init();
  const next = definition.apply(state, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'run_code', arguments: '{}' } });
  assert.equal(next, state);
  const settled = definition.apply(next, directResult(2, 'c1', OK_TEXT));
  assert.equal(settled, next);
  assert.equal(settled.organizeCount, 0);
});

test('Router P0 度量：PTC 按 data.name 计工具调用，执行类={bash,pwsh,write,edit}，isError 也计', () => {
  const state = fold([
    ptc(1, 'bash', { command: 'npm test' }),
    ptc(2, 'edit', { file_path: 'a.js' }),
    ptc(3, 'write', { file_path: 'b.js' }),
    ptc(4, 'pwsh', { command: 'Get-ChildItem' }),
    ptc(5, 'bash', { command: 'false' }, { isError: true }),
    ptc(6, 'read', { file_path: 'c.js' }),
    ptc(7, 'relay_status', {}),
    ptc(8, 'run_code', { code: 'inner transport name never appears here' }),
    { type: 'tool/ptc-dispatch-start', seq: 9, data: { name: 'bash', arguments: {} } },
  ]);
  // 1-7 计入（isError 的 bash 也算「尝试执行」）；run_code 是传输名排除；在途 start 行不单独计数。
  assert.equal(state.toolCalls, 7);
  assert.equal(state.executionCalls, 5, 'bash/edit/write/pwsh + isError bash');
});

test('Router P0 度量：直调 tool/call 即时计数（不依赖 result），run_code 传输层不计', () => {
  const state = fold([
    directCall(1, 'bash', 'call-bash-1', { command: 'ls' }),
    directResult(2, 'call-bash-1', 'ok'),
    directCall(3, 'read', 'call-read-1', {}),
    directResult(4, 'call-read-1', 'text'),
    directCall(5, 'run_code', 'call-transport-1', { code: '...' }),
    directCall(6, 'write', 'call-write-1', { file_path: 'x' }),
  ]);
  assert.equal(state.toolCalls, 3, 'bash/read/write；run_code 不计；无 result 的 write 是「尝试」也计');
  assert.equal(state.executionCalls, 2, 'bash + write');
});

test('Router P0 度量：PTC 外层 run_code 与程序内调用不重复计数（真实日志形态）', () => {
  const state = fold([
    directCall(1, 'run_code', 'call-root-1', { code: 'await tools.bash(...)' }),
    directResult(2, 'call-root-1', 'ok'),
    ptc(3, 'bash', { command: 'npm test' }),
    ptc(4, 'read', { file_path: 'lib/x.js' }),
  ]);
  assert.equal(state.toolCalls, 2, '只计程序内真实工具名：外层 run_code 是 PTC 传输调用');
  assert.equal(state.executionCalls, 1);
});

test('Router P0 度量：relay_* 调用同样计入总数（度量与 relay 语义正交）', () => {
  const state = fold([
    ptc(1, PHASE_TOOL, { phase: 'build' }),
    ptcText(2, ORGANIZE_TOOL, OK_TEXT),
  ]);
  assert.equal(state.toolCalls, 2);
  assert.equal(state.executionCalls, 0);
  assert.equal(state.phase, 'build', 'relay 语义照常生效');
  assert.equal(state.organizeCount, 1);
});

test('Router P0 度量：旧 v2 状态（无计数字段）从 0 起步，无关/不计数事件仍返回同一引用', () => {
  const definition = relayProjectionDefinition();
  const legacy = Object.freeze({
    phase: 'build',
    goal: 'g',
    exitCriteria: 'e',
    organizeCount: 1,
    compactionEpoch: 1,
    noticeBand: 'warn',
    lastNoticeSeq: 5,
    lastCompactionSeq: 6,
    lastContinueActionSeq: 6,
  });
  assert.equal(definition.apply(legacy, { type: 'turn/start', seq: 1, data: {} }), legacy, '无关事件同一引用');
  assert.equal(definition.apply(legacy, ptc(2, 'run_code', {})), legacy, 'run_code 不计数，同一引用');
  assert.equal(definition.apply(legacy, { type: 'tool/ptc-dispatch-start', seq: 3, data: { name: 'bash' } }), legacy, '在途行不计数，同一引用');
  const counted = definition.apply(legacy, ptc(4, 'bash', {}));
  assert.equal(counted.toolCalls, 1);
  assert.equal(counted.executionCalls, 1);
  assert.equal(counted.phase, 'build', '旧字段原样保留');
  assert.equal(counted.organizeCount, 1);
});

test('直调 relay_* 缺 callId：不计入 pending/语义不生效，但作为一次尝试计入总数', () => {
  const definition = relayProjectionDefinition();
  const state = definition.init();
  const next = definition.apply(state, { type: 'tool/call', seq: 1, data: { name: PHASE_TOOL, arguments: JSON.stringify({ phase: 'build' }) } });
  assert.notEqual(next, state, '尝试调用计入总数，state 必须更新');
  assert.equal(next.toolCalls, 1);
  assert.equal(next.phase, 'discover', '缺 callId 不进入 pending，语义不生效');
  assert.equal(definition.apply(next, directResult(2, 'untracked', 'phase → build')), next, '无 pending 的 result 是 no-op');
});

test('compaction/end：epoch 递增、noticeBand 跨压缩保留、记录 lastCompactionSeq', () => {
  let state = fold([noticeEvent(5, 'warn')]);
  assert.equal(state.noticeBand, 'warn');
  state = fold([noticeEvent(5, 'warn'), compactionEnd(6)]);
  assert.equal(state.compactionEpoch, 1);
  assert.equal(state.noticeBand, 'warn', '压缩不重置档位记忆（整会话每档只提醒一次）');
  assert.equal(state.lastCompactionSeq, 6);
  state = fold([compactionEnd(6), compactionEnd(9)]);
  assert.equal(state.compactionEpoch, 2);
  assert.equal(state.noticeBand, null);
  assert.equal(state.lastCompactionSeq, 9);
});

test('compaction/end：失败压缩（data.error）不推进 epoch、不改 band/lastCompactionSeq', () => {
  let state = fold([
    noticeEvent(5, 'warn'),
    { type: 'compaction/end', seq: 6, data: { compactionId: 'c6', error: 'busy' } },
  ]);
  assert.equal(state.compactionEpoch, 0);
  assert.equal(state.noticeBand, 'warn', '失败压缩不重置哨兵档位记忆');
  assert.equal(state.lastCompactionSeq, -1);
  state = fold([
    noticeEvent(5, 'warn'),
    { type: 'compaction/end', seq: 6, data: { compactionId: 'c6', error: 'busy' } },
    compactionEnd(7),
  ]);
  assert.equal(state.compactionEpoch, 1);
  assert.equal(state.noticeBand, 'warn', '失败压缩不清档位记忆');
  assert.equal(state.lastCompactionSeq, 7);
});

test('notice：只认本插件 source；压缩前的 notice 也认（跨压缩保留）', () => {
  const definition = relayProjectionDefinition();
  const base = { ...definition.init(), compactionEpoch: 1, lastCompactionSeq: 20 };
  assert.equal(definition.apply(base, noticeEvent(12, 'warn')).noticeBand, 'warn', '压缩前 seq 的 notice 仍记录');
  assert.equal(definition.apply(base, noticeEvent(12, 'warn', { kind: 'other-plugin' })), base, '非本插件 source 不认');
  assert.equal(
    definition.apply(base, noticeEvent(21, 'warn', { summary: 'no marker here', text: 'plain body' })),
    base,
    '无 band 标记的 notice 不认',
  );
  const accepted = definition.apply(base, noticeEvent(21, 'warn'));
  assert.equal(accepted.noticeBand, 'warn');
  assert.equal(accepted.lastNoticeSeq, 21);
  const upgraded = definition.apply(accepted, noticeEvent(22, 'organize'));
  assert.equal(upgraded.noticeBand, 'organize');
  assert.equal(upgraded.lastNoticeSeq, 22);
  assert.equal(upgraded.compactionEpoch, 1);
});

test('notice：首条压缩前（-1 锚点）的 notice 可以记录', () => {
  const state = fold([noticeEvent(3, 'warn')]);
  assert.equal(state.noticeBand, 'warn');
  assert.equal(state.lastNoticeSeq, 3);
});

test('未知/畸形事件返回同一 state 引用（registry Object.is 门依赖）', () => {
  const definition = relayProjectionDefinition();
  const state = definition.init();
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'step/end', seq: 2, data: {} },
    { type: 'unknown/event', seq: 3, data: null },
    {},
    null,
    undefined,
    { type: 'tool/ptc-dispatch' },
    { type: 'tool/ptc-dispatch', seq: 4, data: null },
    { type: 'tool/ptc-dispatch-start', seq: 5, data: { name: 'bash', arguments: {} } },
    { type: 'tool/call', data: { callId: 'no-name' } },
    { type: 'tool/result', data: { message: { toolCallId: 'nope' } } },
    { type: 'user/message', data: null },
    { type: 'user/message', seq: 6, data: { role: 'user', content: [], source: { kind: 'user' } } },
  ];
  for (const event of events) assert.equal(definition.apply(state, event), state);
});

test('apply 无副作用：frozen initialState 不被改写，返回新对象', () => {
  const definition = relayProjectionDefinition();
  const state = definition.init();
  const next = definition.apply(state, ptc(1, PHASE_TOOL, { phase: 'build', goal: 'g' }));
  assert.notEqual(next, state);
  assert.equal(state.phase, 'discover');
  assert.deepEqual(initialState, {
    phase: 'discover',
    goal: null,
    exitCriteria: null,
    organizeCount: 0,
    compactionEpoch: 0,
    noticeBand: null,
    lastNoticeSeq: -1,
    lastCompactionSeq: -1,
    lastContinueActionSeq: -1,
    toolCalls: 0,
    executionCalls: 0,
  });
});

test('B-P1-1：同 phase 再声明缺省 goal/exit_criteria 沿用旧值（不丢压缩 brief 的目标/退出条件）', () => {
  const state = fold([
    ptc(1, PHASE_TOOL, { phase: 'build', goal: 'G', exit_criteria: 'E' }),
    ptc(2, PHASE_TOOL, { phase: 'build' }),
    ptc(3, PHASE_TOOL, { phase: 'build', next_operation: 'compress' }),
  ]);
  assert.equal(state.phase, 'build');
  assert.equal(state.goal, 'G', 'same-phase 缺省 goal 不得清空');
  assert.equal(state.exitCriteria, 'E', 'same-phase 缺省 exit 不得清空');
  // 同 phase 显式给新值 → 覆盖
  const replaced = fold([
    ptc(1, PHASE_TOOL, { phase: 'build', goal: 'G', exit_criteria: 'E' }),
    ptc(2, PHASE_TOOL, { phase: 'build', goal: 'G2', exit_criteria: 'E2' }),
  ]);
  assert.equal(replaced.goal, 'G2');
  assert.equal(replaced.exitCriteria, 'E2');
});

test('B-P1-1：phase 变化时缺省 goal/exit_criteria 仍清空（不残留上一 phase 目标）', () => {
  const state = fold([
    ptc(1, PHASE_TOOL, { phase: 'build', goal: 'old-goal', exit_criteria: 'old-exit' }),
    ptc(2, PHASE_TOOL, { phase: 'verify' }),
    ptc(3, PHASE_TOOL, { phase: 'verify', next_operation: 'handoff' }),
  ]);
  assert.equal(state.phase, 'verify');
  assert.equal(state.goal, null);
  assert.equal(state.exitCriteria, null);
});

test('B-P2-1：lastContinueActionSeq 只记成功压缩/成功接力（PTC 形态）', () => {
  let state = fold([]);
  assert.equal(state.lastContinueActionSeq, -1, '初始无继续动作');
  state = fold([ptcText(1, ORGANIZE_TOOL, 'not organized: below-threshold:ok')]);
  assert.equal(state.lastContinueActionSeq, -1, '拒绝不是继续动作');
  const noChange = foldRelayEvent(state, ptcText(2, ORGANIZE_TOOL, OK_TEXT));
  assert.equal(noChange.lastContinueActionSeq, 2, '成功压缩记 seq');
  assert.equal(noChange.organizeCount, 1);
  // 失败 handoff（结构化 ok:false，isError=false）不算继续动作
  const failedHandoff = ptcText(3, 'relay_handoff', 'refused: human approval required');
  assert.equal(foldRelayEvent(noChange, failedHandoff).lastContinueActionSeq, 2, '失败 handoff 不算真正继续');
  // 成功 handoff 记 seq
  const okHandoff = ptcText(4, 'relay_handoff', 'relay session created via sessionController.create: session-x (t); handoff: /x.md');
  const afterHandoff = foldRelayEvent(noChange, okHandoff);
  assert.equal(afterHandoff.lastContinueActionSeq, 4);
  // 只增不减：后续较早 seq 的成功压缩不覆盖更大值
  const older = foldRelayEvent(afterHandoff, ptcText(2, ORGANIZE_TOOL, OK_TEXT));
  assert.equal(older.lastContinueActionSeq, 4);
});

test('B-P2-1：lastContinueActionSeq 直调形态按 callId 配对结算，无 result 不结算', () => {
  const withCall = fold([
    directCall(1, 'relay_handoff', 'call-h1', { human_approved: true }),
  ]);
  assert.equal(withCall.lastContinueActionSeq, -1, '无 result 的调用不结算');
  const settled = fold([
    directCall(1, 'relay_handoff', 'call-h1', { human_approved: true }),
    directResult(2, 'call-h1', 'relay session created via agents.create: session-y'),
  ]);
  assert.equal(settled.lastContinueActionSeq, 2, '成功 result 记 result 的 seq');
  const failed = fold([
    directCall(1, 'relay_handoff', 'call-h2', { human_approved: true }),
    directResult(2, 'call-h2', 'refused: lead-only', true),
  ]);
  assert.equal(failed.lastContinueActionSeq, -1, '失败 result 不记');
  const failedText = fold([
    directCall(1, 'relay_handoff', 'call-h3', { human_approved: true }),
    directResult(2, 'call-h3', 'refused: human approval required'),
  ]);
  assert.equal(failedText.lastContinueActionSeq, -1, '非成功文本（isError=false）不算继续动作');
});

test('未知 relay 直调（非 phase/organize/handoff）不进入 pending（但计入工具调用总数）', () => {
  const definition = relayProjectionDefinition();
  const state = definition.init();
  const next = definition.apply(state, { type: 'tool/call', seq: 1, data: { callId: 'c9', name: 'relay_status', arguments: '{}' } });
  assert.equal(next.toolCalls, 1, 'relay_status 也是工具调用，计入总数');
  assert.equal(next.pendingRelayCalls, undefined, '非 phase/organize/handoff 不进入 pending');
  assert.equal(next.phase, 'discover');
  const settled = definition.apply(next, directResult(2, 'c9', '{"ok":true}'));
  assert.equal(settled, next, '无 pending 的 result 不产生派生变化');
});

test('真实事件顺序回归：混合 PTC/notice/compaction 折叠（resume 全量重放）', () => {
  const state = fold([
    ptc(1, PHASE_TOOL, { phase: 'discover' }),
    ptc(2, 'relay_status', {}),
    ptcText(3, ORGANIZE_TOOL, 'not organized: below the organize zone'),
    noticeEvent(4, 'warn'),
    ptc(5, PHASE_TOOL, { phase: 'build', goal: '实现 G', exit_criteria: 'npm test 全绿' }),
    ptcText(6, ORGANIZE_TOOL, OK_TEXT),
    compactionEnd(7),
    noticeEvent(8, 'organize'),
    directCall(9, PHASE_TOOL, 'call-phase-9', { phase: 'verify', goal: '验收', exit_criteria: '全绿' }),
    directResult(10, 'call-phase-9', 'phase → verify'),
  ]);
  assert.equal(state.phase, 'verify');
  assert.equal(state.goal, '验收');
  assert.equal(state.exitCriteria, '全绿');
  assert.equal(state.organizeCount, 1);
  assert.equal(state.compactionEpoch, 1);
  assert.equal(state.noticeBand, 'organize');
  assert.equal(state.lastNoticeSeq, 8);
  assert.equal(state.lastCompactionSeq, 7);
  assert.equal(state.toolCalls, 6, '混合形态：5 条 PTC + 1 条直调 relay_phase 都计入总数');
  assert.equal(state.executionCalls, 0, '本次重放没有执行类调用');
});

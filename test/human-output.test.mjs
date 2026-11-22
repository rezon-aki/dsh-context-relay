/**
 * notice 机器体（插件状态头 + 固定尾，≤600 B）+ 失败事实契约。
 * 工具结果不再产用户段（见 user-view.test.mjs）；这里只锁 notice 文案与 fail(facts)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_DISCLAIMER, NOTICE_HEAD, NOTICE_MAX_BYTES, failureRenderText, noticeParts, internalKeysIn, renderNoticeText } from '../lib/output.js';
import {
  capacityNoticeText, contextCheckText, panelChangeText, phaseBoundaryText, planeIssueOf,
  recoveryNoticeText, sentinelText, unavailableNoticeText,
} from '../lib/agent/notice/plan.js';
import { contextCheckChoice } from '../lib/policy.js';
import { fail } from '../lib/agent/shared.js';

const PANEL = { defaultOperation: null, autoCompress: false, autoHandoff: false, authorizeNext: false };

/** 断言一段 notice 文案：机器头 + 固定尾齐全、内部键为零、UTF-8 ≤ 600 B。 */
function assertHuman(text, name) {
  assert.ok(text.startsWith(NOTICE_HEAD + '\n'), name + ' 缺机器头');
  assert.match(text.split('\n')[0], /非用户发言/, name + ' 首行缺「非用户发言」');
  assert.ok(text.endsWith(NOTICE_DISCLAIMER), name + ' 缺固定尾');
  assert.doesNotMatch(text, /结论：|需要你做什么：|证据：/, name + ' 仍是旧四段式');
  assert.deepEqual(internalKeysIn(text), [], name + ' 含内部键：' + internalKeysIn(text).join(','));
  assert.ok(Buffer.byteLength(text, 'utf8') <= NOTICE_MAX_BYTES, name + ' 超长：' + Buffer.byteLength(text, 'utf8') + 'B');
}

test('notice 机器体：机器头 + 正文 + 依据归一 + 固定尾', () => {
  const rendered = renderNoticeText({
    conclusion: '阶段已切换',
    impact: '没有额外可见影响',
    action: '按目标推进',
    evidence: ['docs/a.md:12', 'docs/b.md:3'],
  });
  const lines = rendered.split('\n');
  assert.equal(lines[0], NOTICE_HEAD);
  assert.equal(lines[1], '阶段已切换');
  assert.match(rendered, /依据：docs\/a\.md:12；docs\/b\.md:3/);
  assert.equal(lines.at(-1), NOTICE_DISCLAIMER);
  assert.deepEqual(noticeParts({ conclusion: 'a', impact: 'b', action: 'c' }).evidence, ['无']);
});

test('内部键黑名单：band= / headroomTo / dispatchId / revision / code: / seq / autoCompress 全部命中', () => {
  const dirty = 'band=organize headroomToOrganize=1200 dispatchId=d-1 revision=2 code:below seq=3 autoCompress=on';
  const keys = internalKeysIn(dirty);
  for (const key of ['band=', 'headroomTo', 'dispatchId', 'revision', 'code:', 'seq', 'autoCompress']) {
    assert.ok(keys.includes(key), '黑名单漏检 ' + key);
  }
  assert.deepEqual(internalKeysIn('结论：上下文 36%，阶段「构建」。'), []);
});

test('notice 正文：到线/容量/边界/面板/自查/不可用/恢复/平面统一机器体且无内部键', () => {
  const notices = {
    '到线-warn': sentinelText('build', { band: 'warn', ratio: 0.36 }, false, { ...PANEL, autoCompress: true, authorizeNext: true }),
    '到线-organize': sentinelText('build', { band: 'organize', ratio: 0.42 }, false, PANEL),
    '到线-relay': sentinelText('build', { band: 'relay', ratio: 0.52 }, false, PANEL),
    '到线-队友': sentinelText('build', { band: 'organize', ratio: 0.42 }, true, undefined, { sent: true }),
    '到线-队友warn': sentinelText('build', { band: 'warn', ratio: 0.37 }, true, undefined, undefined),
    '容量': capacityNoticeText({ ratio: 0.56, threshold: 0.55 }, { defaultOperation: 'compress' }),
    '边界': phaseBoundaryText('build', 'verify', { band: 'warn', ratio: 0.41 }, { defaultOperation: 'continue' }, '按面板模式「继续」放行本次切换（模式保持）'),
    '面板': panelChangeText({ defaultOperation: 'compress', autoCompress: true, autoHandoff: false, authorizeNext: false, architect: true }),
    '自查': contextCheckText({ band: 'warn', task: { kind: 'task-board' }, recommendation: contextCheckChoice({ band: 'warn' }), panel: PANEL }),
    '自查起点': contextCheckText({ phase: { from: 'discover', to: 'build' }, recommendation: contextCheckChoice({ band: 'ok' }), panel: PANEL }),
    '不可用': unavailableNoticeText(),
    '恢复': recoveryNoticeText({ path: '.scratch/context-relay/recovery/compaction-x.md' }),
    '恢复失败': recoveryNoticeText({ writeFailed: true, error: 'EACCES band=warn' }),
    '平面': planeIssueOf({ role: 'lead', installed: true, degradations: [{ seam: 'schedule', level: 'degraded', reason: 'list shape' }] }).text,
    '平面-架构师': planeIssueOf({ role: 'architect', installed: true, degradations: [{ seam: 'schedule', level: 'degraded' }] }).text,
  };
  for (const [name, text] of Object.entries(notices)) assertHuman(text, name);
});

test('notice summary 保留机器标记（band= 只进 summary）', () => {
  const warn = sentinelText('build', { band: 'warn', ratio: 0.36 }, false, PANEL);
  assert.doesNotMatch(warn, /band=/);
  const summary = '[context-relay] band=warn · phase=build · relay 到线提醒（非用户发言）';
  assert.deepEqual(internalKeysIn(summary), ['band='], '机器标记由黑名单发现，但只允许在 summary');
});

test('fail()：失败必须带 effects/reason/retryable/next，不产 human/user 用户段', () => {
  const result = fail(
    'below-threshold',
    'not organized: band=organize · headroomToOrganize=1200 · dispatchId=d-1 · revision=2 · code:below · seq=3 · autoCompress=on',
    { summary: 'refused: below threshold' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'below-threshold');
  assert.match(result.error, /band=organize/, '结构化 error 保留排障原文');
  assert.equal(result.reason, result.error);
  // 0.14.0-dev fix：未显式传 effects 时不得默认「零副作用」——调用方可能已写盘，只能说未记录、要求先核对。
  assert.match(result.effects, /未记录副作用|核对/);
  assert.doesNotMatch(result.effects, /零副作用|没有产生任何改动/);
  assert.equal(result.retryable, true);
  assert.match(result.next, /重试/);
  assert.equal(result.facts.code, 'below-threshold');
  assert.equal(result.facts.retryable, true);
  assert.equal(result.human, undefined);
  assert.equal(result.user, undefined);
  // 写盘后失败但调用方漏传 effects（真实存在的调用契约风险）：render 也必须摊开「未记录/需核对」。
  const afterWrite = fail('compaction-failed', 'phase brief written, then compaction failed', { summary: 'brief already on disk; compaction did not finish' });
  const afterWriteRender = failureRenderText(afterWrite);
  assert.doesNotMatch(afterWriteRender, /零副作用|没有产生任何改动/);
  assert.match(afterWriteRender, /已经发生：.*(未记录副作用|需核对)/);
  const partial = fail('handoff-cleanup-failed', 'Destination accepted; cleanup failed', {
    partial: true,
    sessionId: 'session-new',
    handoffPath: 'handoff.md',
    effects: '新会话已创建；旧会话清理未完成。',
    retryable: false,
    next: '按 recovery 完成清理；不要重复交接。',
    facts: { partial: true, unclean: ['job j1'] },
  });
  assert.equal(partial.partial, true);
  assert.equal(partial.retryable, false);
  assert.deepEqual(partial.facts.unclean, ['job j1']);
});
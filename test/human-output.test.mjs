/**
 * w3 说人话（relay-audit §2.4）：用户四段式 + 内部键黑名单。
 * 锁定：notice/状态/阶段/交接/报错的用户文案必须是四段、≤ 上限、不含内部键；
 * 机器字段只出现在 summary/facts/结构化结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failureHumanOf, handoffHumanOf, humanParts, internalKeysIn, phaseHumanOf, renderFourPart, statusHumanOf,
} from '../lib/output.js';
import {
  NOTICE_MAX, capacityNoticeText, contextCheckText, panelChangeText, phaseBoundaryText, planeIssueOf,
  recoveryNoticeText, sentinelText, unavailableNoticeText,
} from '../lib/agent/notice/plan.js';
import { contextCheckChoice } from '../lib/policy.js';
import { fail } from '../lib/agent/shared.js';

const FORBIDDEN = ['band=', 'headroomTo', 'dispatchId', 'revision', 'code:', 'seq', 'autoCompress'];
const PANEL = { defaultOperation: null, autoCompress: false, autoHandoff: false, authorizeNext: false };

/** 断言一段用户文案：四段齐全、内部键为零、字符 ≤ 上限。 */
function assertHuman(text, name, max = NOTICE_MAX) {
  for (const label of ['结论：', '影响：', '需要你做什么：', '证据：']) {
    assert.ok(text.includes(label), name + ' 缺「' + label + '」');
  }
  assert.deepEqual(internalKeysIn(text), [], name + ' 含内部键：' + internalKeysIn(text).join(','));
  assert.ok(Array.from(text).length <= max, name + ' 超长：' + Array.from(text).length);
}

test('四段式：固定顺序 + evidence 数组归一 + 空段占位', () => {
  const rendered = renderFourPart({
    conclusion: '阶段已切换',
    impact: '没有额外可见影响',
    action: '按目标推进',
    evidence: ['docs/a.md:12', 'docs/b.md:3'],
  });
  assert.deepEqual(rendered.split('\n').map((line) => line.split('：')[0]), ['结论', '影响', '需要你做什么', '证据']);
  assert.match(rendered, /证据：docs\/a\.md:12；docs\/b\.md:3/);
  assert.deepEqual(humanParts({ conclusion: 'a', impact: 'b', action: 'c' }).evidence, ['无']);
});

test('内部键黑名单：band= / headroomTo / dispatchId / revision / code: / seq / autoCompress 全部命中', () => {
  const dirty = 'band=organize headroomToOrganize=1200 dispatchId=d-1 revision=2 code:below seq=3 autoCompress=on';
  const keys = internalKeysIn(dirty);
  for (const key of ['band=', 'headroomTo', 'dispatchId', 'revision', 'code:', 'seq', 'autoCompress']) {
    assert.ok(keys.includes(key), '黑名单漏检 ' + key);
  }
  assert.deepEqual(internalKeysIn('结论：上下文 36%，阶段「构建」。'), []);
});

test('notice 正文：到线/容量/边界/面板/自查/不可用/恢复/平面统一四段且无内部键', () => {
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
  };
  for (const [name, text] of Object.entries(notices)) assertHuman(text, name);
});

test('notice summary 保留机器标记（band= 只进 summary）', () => {
  const warn = sentinelText('build', { band: 'warn', ratio: 0.36 }, false, PANEL);
  assert.doesNotMatch(warn, /band=/);
  const summary = '[context-relay] band=warn · phase=build · relay 到线提醒（非用户发言）';
  assert.deepEqual(internalKeysIn(summary), ['band='], '机器标记由黑名单发现，但只允许在 summary');
});

test('relay_status / relay_phase / handoff：human 四段无内部键，内部字段留在 facts', () => {
  const status = statusHumanOf({
    phase: 'build',
    lead: { used: 36000, window: 100000, ratio: 0.36, band: 'warn' },
    organizeCount: 0,
    budget: { headroomToWarn: 1000, headroomToOrganize: 2000, currentPhaseCostTokens: 500 },
    capacity: { atRisk: false, ratio: 0.36, threshold: 0.55 },
    continue: { preset: null },
    compaction: { count: 0, debt: false },
    panel: { defaultOperation: null, autoCompress: true, autoHandoff: false, authorizeNext: true },
    team: [],
    workItems: { relativePath: '.scratch/context-relay/work-items.json' },
  });
  assertHuman(renderFourPart(status), 'relay_status.human', 3000);

  const phase = phaseHumanOf({
    phase: 'build',
    previous: 'decide',
    band: 'warn',
    budget: { band: 'warn', headroomToOrganize: 1200, lastPhaseCostTokens: 3000 },
    ledger: { done: 1, planned: 2, pending: 1 },
    design: { path: '.scratch/context-relay/architecture/x.md' },
    hint: '先摸清事实与边界，再开工',
  });
  assertHuman(renderFourPart(phase), 'relay_phase.human', 3000);

  const handoff = handoffHumanOf({
    title: '接力测试',
    sessionId: 'session-internal-id',
    handoffPath: 'handoff-x.md',
    caps: { bytes: { used: 1024, limit: 16384 }, fullBytes: 20480 },
    progress: { updated: true, path: '.scratch/context-relay/progress.md' },
    handover: {
      inventory: { jobs: [{ id: 'j1' }], schedules: [], teammates: [], subagents: [], skipped: [] },
      cleanup: { jobs: [{ id: 'j1', action: 'killed' }], schedules: [], teammates: [], subagents: [], errors: [], skipped: [] },
    },
  });
  assertHuman(renderFourPart(handoff), 'relay_handoff.human', 3000);
  assert.doesNotMatch(renderFourPart(handoff), /session-internal-id/, 'human 不贴 session id');
});

test('fail()：统一失败文案 ≤300 字四段；技术细节/内部键只留结构化字段', () => {
  const result = fail(
    'below-threshold',
    'not organized: band=organize · headroomToOrganize=1200 · dispatchId=d-1 · revision=2 · code:below · seq=3 · autoCompress=on',
    { summary: 'refused: below threshold' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'below-threshold');
  assert.match(result.error, /band=organize/, '结构化 error 保留排障原文');
  assertHuman(renderFourPart(result.human), 'fail.human', 300);
  assert.deepEqual(internalKeysIn(renderFourPart(result.human)), []);
  // 直接调用（无四段入参）也统一成四段，而不是单行技术报错。
  const bare = failureHumanOf('revision=3 seq=9 code:x');
  assertHuman(renderFourPart(bare), 'failureHumanOf', 300);
});

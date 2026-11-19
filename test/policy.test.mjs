import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PHASES,
  CAPACITY_RATIO_DEFAULT,
  DELEGATION_EXEC_RATIO_MAX,
  DEFAULT_PANEL_STATE,
  DEFAULT_SETTINGS,
  HANDOFF_LIMITS,
  PHASE_EXITS,
  USER_REPORT_LIMITS,
  capacityOf,
  capacityRatioOf,
  isExitPhase,
  normalizePhaseState,
  userReportWarnings,
  HANDOFF_SUMMARY_BYTES,
  PANEL_OPERATIONS,
  PHASES,
  bandFor,
  buildHandoff,
  buildPhaseBrief,
  continueChoice,
  formatStatus,
  normalizePanelState,
  normalizePhase,
  normalizeSettings,
  thresholdsFromPercent,
  normalizeThresholds,
  readPressure,
  shouldOrganize,
  phaseBudget,
  OPERATION_LABELS,
  OPERATION_LONG_LABELS,
  operationLabelOf,
  operationLongLabelOf,
  panelDefaultsOf,
  resolveEffectiveThresholds,
} from '../lib/policy.js';

/** 默认生效阈值（policy 单一真源：DEFAULT_SETTINGS.threshold=35 → warn 30% / organize 35% / relay 45%）。 */
const DEFAULT_THRESHOLDS = thresholdsFromPercent(DEFAULT_SETTINGS.threshold);

test('threshold defaults are ratio-only 30/35/45 with token fallback', () => {
  const t = normalizeThresholds();
  assert.equal(t.warnRatio, 0.3);
  assert.equal(t.organizeRatio, 0.35);
  assert.equal(t.relayRatio, 0.45);
  assert.equal(t.warnTokens, 100000);
  assert.equal(t.organizeTokens, 130000);
  assert.equal(t.relayTokens, 160000);
  assert.throws(() => normalizeThresholds({ organizeRatio: 1 }), /ratio in \(0,1\)/);
  assert.throws(() => normalizeThresholds({ warnRatio: 0.5, organizeRatio: 0.4 }), /warnRatio < organizeRatio/);
  assert.throws(() => normalizeThresholds({ relayTokens: 0 }), /relayTokens must be a positive number/);
});

test('readPressure prefers projected next-request estimate, then reported, then meter', () => {
  // 官方投影文档：pressureTokens 是最近一次请求用量（不随本轮增长、压缩后不下降），
  // projectedTokens 才是下一请求估算（compaction 后立即反应）→ 必须优先 projected。
  assert.deepEqual(
    readPressure({ projection: { contextWindow: 1000, pressureTokens: 400, projectedTokens: 420 } }),
    { used: 420, window: 1000, ratio: 0.42, source: 'projected' },
  );
  assert.deepEqual(
    readPressure({ projection: { contextWindow: 1000, pressureTokens: 400 } }),
    { used: 400, window: 1000, ratio: 0.4, source: 'pressure' },
  );
  const m = readPressure({ measurement: { totalTokens: 321.6 } });
  assert.equal(m.used, 322);
  assert.equal(m.ratio, undefined);
  assert.equal(readPressure({}).source, 'unavailable');
});

test('bandFor: window known -> ratio only (no premature token warn)', () => {
  const t = DEFAULT_THRESHOLDS;
  // 1M 窗口下 110k (11%) 不得 warn —— 旧双线「取更严」会把 9.8% 判成 warn 的 bug
  const oneM = bandFor({ used: 100_000, window: 1_000_000 }, t);
  assert.equal(oneM.band, 'ok');
  assert.equal(oneM.basis, 'ratio');
  assert.equal(oneM.ratio, 0.1);
  assert.equal(bandFor({ used: 299_999, window: 1_000_000 }, t).band, 'ok');
  assert.equal(bandFor({ used: 300_000, window: 1_000_000 }, t).band, 'warn');
  assert.equal(bandFor({ used: 350_000, window: 1_000_000 }, t).band, 'organize');
  assert.equal(bandFor({ used: 449_999, window: 1_000_000 }, t).band, 'organize');
  assert.equal(bandFor({ used: 450_000, window: 1_000_000 }, t).band, 'relay');
  // 10M 窗口：绝对 line 不得参与
  assert.equal(bandFor({ used: 170_000, window: 10_000_000 }, t).band, 'ok');
});

test('bandFor: absolute tokens only fall back when window unknown/0', () => {
  const t = DEFAULT_THRESHOLDS;
  assert.equal(bandFor({ used: 90_000 }, t).band, 'ok');
  assert.equal(bandFor({ used: 110_000 }, t).band, 'warn');
  assert.equal(bandFor({ used: 140_000 }, t).band, 'organize');
  assert.equal(bandFor({ used: 170_000 }, t).band, 'relay');
  assert.equal(bandFor({ used: 170_000 }, t).basis, 'tokens');
  assert.equal(bandFor({ used: 110_000, window: 0 }, t).band, 'warn');
});

test('bandFor: 指标/投影/计量均不可用 → 显式 band=unavailable（D-04，不再静默 ok）', () => {
  const unavailable = bandFor({}, DEFAULT_THRESHOLDS);
  assert.deepEqual(unavailable, { band: 'unavailable', basis: 'unavailable', used: undefined });
  // 不参与升线/预算闸门/容量保全：organize 判定 false，phaseBudget 如实标注 unavailable。
  assert.equal(shouldOrganize(unavailable).organize, false);
  assert.equal(phaseBudget({}, DEFAULT_THRESHOLDS).band, 'unavailable');
  assert.equal(phaseBudget({}, DEFAULT_THRESHOLDS).basis, 'unavailable');
  // used 已知但窗口未知仍是 tokens 兜底（降级只针对 used 缺失，不吞掉部分指标）。
  assert.equal(bandFor({ used: 90_000 }, DEFAULT_THRESHOLDS).band, 'ok');
});

test('bandFor honours configured ratios', () => {
  const custom = normalizeThresholds({ warnRatio: 0.2, organizeRatio: 0.3, relayRatio: 0.4 });
  assert.equal(bandFor({ used: 250, window: 1000 }, custom).band, 'warn');
  assert.equal(bandFor({ used: 350, window: 1000 }, custom).band, 'organize');
  assert.equal(bandFor({ used: 450, window: 1000 }, custom).band, 'relay');
});

test('shouldOrganize', () => {
  assert.equal(shouldOrganize({ band: 'warn' }).organize, false);
  assert.equal(shouldOrganize({ band: 'organize' }).organize, true);
  assert.equal(shouldOrganize({ band: 'ok' }, true).organize, true);
});

test('normalizePhase', () => {
  assert.equal(normalizePhase(' BUILD '), 'build');
  assert.equal(normalizePhase(undefined), 'discover');
  assert.throws(() => normalizePhase('nope'), /unknown phase/);
  assert.deepEqual(PHASES, ['discover', 'decide', 'build', 'verify', 'ship']);
});

test('formatStatus is layered and shows default 30/35/45', () => {
  const text = formatStatus({
    phase: 'build',
    lead: { ratio: 0.412, used: 412000, window: 1000000, band: 'organize' },
    team: [{ name: 'worker-a', ratio: 0.22, status: 'running', band: 'ok' }],
    advice: 'call relay_organize now',
  });
  assert.match(text, /phase: build/);
  assert.match(text, /41\.2%/);
  assert.match(text, /warn 30\.0% \/ organize 35\.0% \/ relay 45\.0%/);
  assert.match(text, /worker-a/);
  assert.doesNotMatch(text, /(^|\n)advice: /, 'advice 只在结构化字段，text 不重复');
  // 窗口未知时展示 token 兜底
  const fallback = formatStatus({ phase: 'discover', lead: { used: 42000, band: 'ok' }, advice: '-' });
  assert.match(fallback, /兜底 100000\/130000\/160000 tokens/);
});

test('buildPhaseBrief normalizes phase and lists sections', () => {
  const md = buildPhaseBrief({ phase: 'verify', goal: 'validate', exitCriteria: ['tests green'], evidence: ['docs/SPEC.md'] });
  assert.match(md, /# 阶段交接摘要 · 验证/);
  assert.match(md, /\n\n结论：本阶段「验证」已收口/, '首段结论先行');
  assert.doesNotMatch(md, /Phase Brief/);
  assert.match(md, /## 退出条件/);
  assert.match(md, /docs\/SPEC\.md/);
});

test('buildHandoff keeps seven-field semantics inside a bounded schema', () => {
  const { markdown, caps } = buildHandoff({
    status: {
      phase: 'build',
      goal: 'ship context relay M2',
      success_criteria: ['plugin injects cleanly'],
      done: ['thresholds are ratio-only'],
      next_actions: ['run doc_lint after organize'],
      blocked: ['P0: user approval for UI switch'],
    },
    evidence: ['lib/policy.js', 'relay_organize returns freedTokens'],
    decisions: ['use compactIfNeeded with context-overflow trigger'],
    constraints: ['no kernel patch'],
    open_questions: ['P1: relay auto-switch?'],
    risks: ['compaction busy -> retry later'],
    discarded: ['old tool outputs'],
    sessionId: 'session-x',
    createdAt: '2026-10-19T00:00:00.000Z',
  });
  for (const needle of ['## 状态', '## 首条指令', '## 证据', '## 已定决策（含理由）', '## 未决问题', '## 风险与回滚', '## 硬约束', '## 明确丢弃的上下文']) {
    assert.ok(markdown.includes(needle), 'missing ' + needle);
  }
  assert.match(markdown, /from session: session-x/);
  assert.match(markdown, /目标：ship context relay M2/);
  assert.match(markdown, /下一步（DoD）：run doc_lint after organize/);
  assert.equal(caps.bytes.limit, HANDOFF_LIMITS.totalBytes);
  assert.ok(caps.bytes.used > 0 && caps.bytes.used <= HANDOFF_LIMITS.totalBytes);
  assert.equal(caps.items.evidence.used, 2);
  assert.equal(caps.items.decisions.limit, 10);
  assert.equal(caps.truncated, false);
});

test('buildHandoff reads only status.* for goal/phase/actions; flat legacy aliases are ignored', () => {
  assert.throws(() => buildHandoff({}), /goal is required/);
  assert.throws(() => buildHandoff({ goal: 'legacy goal', phase: 'verify' }), /goal is required/);
  const { markdown } = buildHandoff({
    status: { phase: 'verify', goal: 'canonical goal', success_criteria: ['canonical criterion'], next_actions: ['canonical next'] },
    evidence: ['canonical evidence'],
    successCriteria: ['legacy criterion'],
    nextActions: ['legacy next'],
    assets: ['legacy asset path'],
    openQuestions: ['legacy question'],
  });
  assert.match(markdown, /phase: verify/);
  assert.match(markdown, /^# Handoff · canonical goal/);
  assert.match(markdown, /成功标准：canonical criterion/);
  assert.match(markdown, /下一步（DoD）：canonical next/);
  assert.match(markdown, /canonical evidence/);
  for (const legacy of ['legacy criterion', 'legacy next', 'legacy asset path', 'legacy question']) {
    assert.ok(!markdown.includes(legacy), 'flat legacy field was still mapped: ' + legacy);
  }
});

test('buildHandoff truncates over-limit arrays and reports caps', () => {
  const evidence = Array.from({ length: 20 }, (_, i) => 'e' + i + '-' + 'x'.repeat(300));
  const decisions = Array.from({ length: 14 }, (_, i) => 'd' + i);
  const { markdown, caps } = buildHandoff({
    status: { goal: 'bounded', done: Array.from({ length: 20 }, (_, i) => 'done ' + i) },
    evidence,
    decisions,
  });
  assert.equal(caps.items.evidence.used, 12);
  assert.equal(caps.items.evidence.limit, 12);
  assert.equal(caps.items.done.used, 12);
  assert.equal(caps.items.decisions.used, 10);
  assert.equal(caps.truncated, true);
  assert.ok(caps.truncatedSections.includes('items:evidence'));
  assert.ok(caps.truncatedSections.includes('items:decisions'));
  // 单条 ≤200 字符（含省略号）
  for (const line of markdown.split('\n')) {
    if (line.startsWith('- e')) assert.ok(line.length <= 202, 'item too long: ' + line.length);
  }
});

test('buildHandoff 摘要按 advisory 预算分层，完整版 fullMarkdown 不截断不丢段', () => {
  const big = (prefix) => Array.from({ length: 40 }, () => prefix.repeat(195));
  const { markdown, fullMarkdown, caps } = buildHandoff({
    status: {
      goal: 'x',
      done: big('d'),
      next_actions: big('n'),
      blocked: big('b'),
      success_criteria: big('s'),
    },
    evidence: big('e'),
    decisions: big('m'),
    constraints: big('c'),
    risks: big('r'),
    open_questions: big('q'),
    discarded: big('x'),
  });
  // 摘要：advisory 预算（默认 16KB）内；超限整段/尾部截断 + 显式 marker 记账。
  assert.ok(Buffer.byteLength(markdown, 'utf8') <= HANDOFF_SUMMARY_BYTES, 'summary bytes ' + Buffer.byteLength(markdown));
  assert.ok(caps.bytes.used <= caps.bytes.limit);
  assert.equal(caps.bytes.limit, HANDOFF_SUMMARY_BYTES);
  assert.equal(caps.truncated, true);
  assert.equal(caps.split, true, '摘要与完整版不同');
  assert.ok(caps.fullBytes > caps.bytes.used, '完整版比摘要大：' + caps.fullBytes + ' vs ' + caps.bytes.used);
  assert.match(markdown, /摘要已分层/, '超预算留显式 marker');
  assert.ok(caps.warnings.length > 0, 'advisory 说明');
  const sectionTitles = ['状态', '首条指令', '证据（文件/命令/URL/会话 id）', '已定决策（含理由）', '未决问题（按 P0/P1/P2 标注，P0 必须人类裁决）', '风险与回滚', '硬约束', '明确丢弃的上下文'];
  const missing = sectionTitles.filter((title) => !markdown.includes('## ' + title));
  for (const title of missing) {
    assert.ok(caps.truncatedSections.includes('section:' + title), 'unreported dropped section: ' + title);
  }
  // 完整版：全部段/条目/原文都在（40 条 done/evidence 等不截断）。
  for (const title of sectionTitles) assert.ok(fullMarkdown.includes('## ' + title), '完整版缺段：' + title);
  assert.equal(fullMarkdown.split('\n').filter((line) => line.startsWith('- 已完成：' + 'd'.repeat(195))).length, 40, 'done 40 条全部保留');
  assert.ok(fullMarkdown.includes('- ' + 'e'.repeat(195)), 'evidence 原文保留');
});

test('continueChoice: compress-vs-handoff choice only at organize/relay bands, with recommendation', () => {
  // ok/warn 不进入选择题（warn 只收尾 phase）
  assert.equal(continueChoice({ band: 'ok' }), undefined);
  assert.equal(continueChoice({ band: 'warn' }), undefined);
  const first = continueChoice({ band: 'organize' }, 0);
  assert.equal(first.needed, true);
  assert.equal(first.recommendation, 'organize'); // 本会话尚未压缩 → 推荐先压缩
  assert.deepEqual(first.options.map((option) => option.id), ['organize', 'handoff']);
  assert.match(first.ask, /人类/);
  // 已压缩过 → 推荐接力（避免二次压缩叠加漂移）；relay 档 → 必推荐接力
  assert.equal(continueChoice({ band: 'organize' }, 1).recommendation, 'handoff');
  assert.equal(continueChoice({ band: 'relay' }, 0).recommendation, 'handoff');
  // 状态文本带出选择题
  const text = formatStatus({
    phase: 'build',
    lead: { ratio: 0.42, used: 420000, window: 1000000, band: 'organize' },
    thresholds: DEFAULT_THRESHOLDS,
    continue: continueChoice({ band: 'organize' }, 1),
    advice: 'ask the human',
  });
  assert.match(text, /continue: 需人类选择/);
  assert.match(text, /推荐 handoff/);
  assert.doesNotMatch(text, /already compressed once/, 'continue.reason 只在 JSON 字段，text 不重复');
});

test('continueChoice：面板模式（持久）优先于规则推荐（人类设置不被规则覆盖）', () => {
  const choiceAt = (preset, count = 0) => continueChoice({ band: 'organize' }, count, preset === undefined ? undefined : { defaultOperation: preset });

  // 面板模式=压缩继续：即使已压缩过也按人类选择，不再推荐接力
  const compress = choiceAt('compress', 1);
  assert.equal(compress.recommendation, 'organize');
  assert.equal(compress.preset, 'compress');
  assert.equal(compress.reason, '面板模式=压缩继续（人类已选；已压缩过也按人类选择执行，审批仍按 autoCompress/authorizeNext）');
  assert.deepEqual(compress.options.map((option) => option.id), ['organize', 'handoff']);

  // 面板模式=接力新会话
  const handoff = choiceAt('handoff', 1);
  assert.equal(handoff.recommendation, 'handoff');
  assert.equal(handoff.preset, 'handoff');
  assert.match(handoff.reason, /面板模式=接力新会话/);

  // 面板模式=继续：不压缩不接力
  const keep = choiceAt('continue', 1);
  assert.equal(keep.recommendation, 'continue');
  assert.equal(keep.reason, '面板模式=继续（人类已选：不压缩不接力）');

  // 无模式/空面板/非法值：仍走现行规则（已压缩过 → handoff；未压缩 → organize）
  assert.equal(continueChoice({ band: 'organize' }, 1, {}).recommendation, 'handoff');
  assert.equal(continueChoice({ band: 'organize' }, 0).preset, null);
  assert.equal(continueChoice({ band: 'organize' }, 0, { defaultOperation: 'bogus' }).preset, null);

  // formatStatus：有面板模式时只报「人类已选，按它执行」，不再出现规则推荐/选择题
  const text = formatStatus({
    phase: 'build',
    lead: { ratio: 0.42, used: 420000, window: 1000000, band: 'organize' },
    thresholds: DEFAULT_THRESHOLDS,
    continue: compress,
  });
  assert.match(text, /continue: 面板模式=压缩继续（人类已选，按它执行；压缩\/接力仍需审批）/);
  assert.doesNotMatch(text, /需人类选择|推荐 handoff|选项 A/);
});

test('formatStatus：面板授权事实如实渲染（v0.5.1——不再一律说「仍需审批」）', () => {
  const choice = continueChoice({ band: 'organize' }, 1, { defaultOperation: 'compress' });
  const base = {
    phase: 'build',
    lead: { ratio: 0.42, used: 420000, window: 1000000, band: 'organize' },
    thresholds: DEFAULT_THRESHOLDS,
    continue: choice,
  };
  // 旧调用方不提供面板信息：保持默认文案
  assert.match(formatStatus(base), /压缩\/接力仍需审批/);
  const text = formatStatus({ ...base, panel: { defaultOperation: 'compress', autoCompress: true, autoHandoff: false, authorizeNext: false } });
  assert.match(text, /continue: 面板模式=压缩继续（人类已选，按它执行；压缩免审=on · 接力免审=off · 授权下一次=off）/);
  assert.doesNotMatch(text, /压缩\/接力仍需审批/, 'autoCompress 已开时不得再谎称仍需审批');
  assert.match(text, /panel: 模式=压缩继续 · autoCompress=on · autoHandoff=off · authorizeNext=off/);
  // 未到线（无 continue）也渲染 panel 行；模式空 = 问我
  const quiet = formatStatus({
    phase: 'build',
    lead: { band: 'ok' },
    thresholds: DEFAULT_THRESHOLDS,
    panel: { defaultOperation: null, autoCompress: false, autoHandoff: false, authorizeNext: false },
  });
  assert.match(quiet, /panel: 模式=问我 · autoCompress=off · autoHandoff=off · authorizeNext=off/);
});

test('buildPhaseBrief renders only non-empty sections and accepts single string fields', () => {
  const md = buildPhaseBrief({ phase: 'build', goal: 'ship it', exitCriteria: 'tests green' });
  assert.match(md, /## 目标\n- ship it/);
  assert.match(md, /## 退出条件\n- tests green/);
  assert.ok(!md.includes('（无）'), 'empty sections must be skipped, not rendered as placeholders');
  const bare = buildPhaseBrief({ phase: 'discover' });
  assert.ok(!bare.includes('## 目标'));
  assert.ok(!bare.includes('（无）'));
});

test('buildHandoff sanitizes list items to one line and clips an oversized goal', () => {
  const { markdown } = buildHandoff({
    status: {
      goal: 'g'.repeat(9000),
      done: ['line1\n## 注入的伪标题\nline3'],
    },
    evidence: ['e'],
  });
  // 列表项换行被压成单空格：不得出现行首伪标题
  assert.ok(!markdown.split('\n').some((line) => line.startsWith('## 注入的伪标题')), 'newline inside an item created a fake heading');
  assert.match(markdown, /已完成：line1 ## 注入的伪标题 line3/);
  // 标题 clip 120、正文目标 clip 200：超长 goal 不得挤掉状态段
  assert.ok(markdown.split('\n')[0].length <= '# Handoff · '.length + 120);
  assert.ok(markdown.includes('目标：' + 'g'.repeat(199) + '…'), 'body goal must be clipped to 200 chars');
  assert.match(markdown, /## 状态/);
});

test('buildHandoff keeps the status section and retries later short sections under budget pressure', () => {
  const big = (prefix) => Array.from({ length: 12 }, () => prefix + 'x'.repeat(194));
  // 显式 advisory 预算 8KB：小预算下仍保留状态段并继续尝试后续短段（完整版不受影响）。
  const { markdown, fullMarkdown, caps } = buildHandoff({
    summaryBytes: 8192,
    status: {
      goal: 'bounded status survives',
      success_criteria: big('s'),
      next_actions: big('n'),
      blocked: big('b'),
      done: big('d'),
    },
    evidence: big('e'),
    decisions: Array.from({ length: 10 }, () => 'm' + 'x'.repeat(194)),
    open_questions: Array.from({ length: 5 }, () => 'q' + 'x'.repeat(194)),
    risks: Array.from({ length: 8 }, () => 'r' + 'x'.repeat(194)),
    constraints: ['c'],
  });
  assert.ok(Buffer.byteLength(markdown, 'utf8') <= 8192, 'summary bytes ' + Buffer.byteLength(markdown));
  assert.equal(caps.bytes.limit, 8192);
  // 状态段排在最前，先拿预算且目标仍在
  assert.match(markdown, /## 状态/);
  assert.match(markdown, /目标：bounded status survives/);
  // 预算被长段吃满后继续尝试后续短段：短的「硬约束」段仍能落地
  assert.match(markdown, /## 硬约束/);
  assert.ok(caps.truncated, 'budget pressure reported');
  assert.ok(caps.truncatedSections.some((entry) => entry.startsWith('section:')), 'dropped sections reported');
  assert.ok(caps.split, '摘要分层：完整版在 fullMarkdown');
  assert.ok(fullMarkdown.includes('## 硬约束') && fullMarkdown.split('\n').filter((line) => line.startsWith('- 成功标准：sx')).length === 12, '完整版不截断（success_criteria 12 条原文）');
  for (const title of ['证据（文件/命令/URL/会话 id）', '已定决策（含理由）', '未决问题（按 P0/P1/P2 标注，P0 必须人类裁决）', '风险与回滚']) {
    if (!markdown.includes('## ' + title)) {
      assert.ok(caps.truncatedSections.includes('section:' + title), 'unreported dropped section: ' + title);
    }
  }
});

test('formatStatus keeps thresholds and the compress-vs-handoff choice in text (slim structured status)', () => {
  const text = formatStatus({
    phase: 'build',
    lead: { ratio: 0.42, used: 420000, window: 1000000, band: 'organize' },
    thresholds: DEFAULT_THRESHOLDS,
    continue: { needed: true, band: 'organize', organizeCount: 1, recommendation: 'handoff', reason: 'already compressed once' },
    advice: 'ask the human',
  });
  // P2#8：结构化返回瘦身后，阈值与 A/B 选择题只保留在 text 里（模型照此问人类）。
  assert.match(text, /thresholds: warn 30\.0% \/ organize 35\.0% \/ relay 45\.0%/);
  assert.match(text, /选项 A「压缩后继续同一会话」/);
  assert.match(text, /B「接力开新会话」/);
  assert.match(text, /推荐 handoff/);
  assert.doesNotMatch(text, /(^|\n)advice: /, 'advice 只在结构化字段，text 不重复');
});


test('buildHandoff carries key docs as bounded workspace-relative entry points', () => {
  const { markdown, caps } = buildHandoff({
    status: { goal: 'relay docs' },
    key_docs: [
      'docs/workflow.md', '/etc/passwd', '../outside.md', 'docs/workflow.md',
      'C:' + String.fromCharCode(92) + 'x.md', 'docs/AGENTS.md',
      '~/docs/home.md', './docs/./entry.md', 'docs//dup.md', 'a/./b.md',
    ],
  });
  assert.match(markdown, /## 关键文档（workspace 相对路径；先读入口）/);
  assert.match(markdown, /- docs\/workflow\.md/);
  assert.match(markdown, /- docs\/AGENTS\.md/);
  // P3：先 posix.normalize 再判定——`./`、`.` 段与重复斜杠被规范化，`~`/绝对/.. 丢弃。
  assert.match(markdown, /- docs\/entry\.md/);
  assert.match(markdown, /- docs\/dup\.md/);
  assert.match(markdown, /- a\/b\.md/);
  assert.doesNotMatch(markdown, /passwd|outside|C:|~\/|\.\/|\.\.\//);
  assert.equal(caps.items.key_docs.used, 5);
});

test('buildHandoff clips items by Unicode code points and reports caps.chars in code points', () => {
  const emoji = String.fromCodePoint(0x1F600);
  const item = 'a'.repeat(198) + emoji + 'tail'; // 203 code points / >200 UTF-16 code units
  const { markdown, caps } = buildHandoff({ status: { goal: 'emoji ' + emoji.repeat(20) }, evidence: [item] });
  const line = markdown.split('\n').find((entry) => entry.startsWith('- a'));
  assert.ok(line !== undefined, 'evidence line rendered');
  const text = line.slice(2);
  assert.ok(Array.from(text).length <= HANDOFF_LIMITS.itemChars, 'code points=' + Array.from(text).length);
  assert.match(text, /…$/);
  // 不产生孤立 surrogate：😀 整颗保留或截在它之前，不切半颗。
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(lone.test(markdown), false, 'markdown must not contain lone surrogate');
  // caps.chars 统一 Unicode 码点口径（不是 UTF-16 code unit）
  assert.equal(caps.chars.used, Array.from(markdown).length);
  assert.ok(markdown.length > caps.chars.used, 'markdown.length 是 code unit，不能当口径');
});

test('DEFAULT_PANEL_STATE / normalizePanelState: 11 字段白名单（v0.3.3 模型推荐 + v0.6.4 架构师 + v0.7.0 架构师模型），退役字段不在白名单', () => {
  const keys = ['architect', 'architectModel', 'authorizeNext', 'autoCompress', 'autoHandoff', 'defaultOperation', 'handedOff', 'handoffUnlimitedBudget', 'recommendedAt', 'recommendedOperation', 'recommendedReason', 'unlimitedBudget'];
  assert.deepEqual(Object.keys(DEFAULT_PANEL_STATE).sort(), keys);
  // 退役/历史字段：旧 panel.json 的键由白名单丢弃，normalizePanelState 输出里不再出现。
  const state = normalizePanelState({ handoffPreAuthorized: true, autoChoose: true, autoDecision: { operation: 'compress', at: 1 }, handoffPreset: 'relay', defaultOperation: 'compress-then-handoff' });
  assert.equal('handoffPreAuthorized' in state, false, '旧 panel.json 的 handoffPreAuthorized 由白名单丢弃');
  assert.equal('autoChoose' in state, false, '自动选择档已删除');
  assert.equal('autoDecision' in state, false, '模型自决字段已删除');
  assert.equal('handoffPreset' in state, false, '交接目标 preset 字段已删除');
  assert.deepEqual(Object.keys(state).sort(), keys);
  assert.equal(state.defaultOperation, null, '未知/退役模式值归一 null（问我）');
  // v0.2.7 unlimitedBudget / handoffUnlimitedBudget：true/false 保留，其余（"true"/1/undefined）归 null（跟随/继承）
  assert.equal(normalizePanelState({ unlimitedBudget: true }).unlimitedBudget, true);
  assert.equal(normalizePanelState({ unlimitedBudget: false }).unlimitedBudget, false);
  assert.equal(normalizePanelState({ unlimitedBudget: 'true' }).unlimitedBudget, null, '字符串不得当真');
  assert.equal(normalizePanelState({}).unlimitedBudget, null, '缺省 null = 跟随 settings 默认');
  assert.equal(normalizePanelState({ handoffUnlimitedBudget: true }).handoffUnlimitedBudget, true);
  assert.equal(normalizePanelState({ handoffUnlimitedBudget: false }).handoffUnlimitedBudget, false);
  assert.equal(normalizePanelState({ handoffUnlimitedBudget: 'off' }).handoffUnlimitedBudget, null);
  assert.equal(normalizePanelState({}).handoffUnlimitedBudget, null, '缺省 null = 交接时跟随当前会话');
  // v0.6.4 专职架构师开关：三值严格化（null=跟随 settings 默认 true）
  assert.equal(normalizePanelState({ architect: true }).architect, true);
  assert.equal(normalizePanelState({ architect: false }).architect, false);
  assert.equal(normalizePanelState({ architect: 'true' }).architect, null);
  assert.equal(normalizePanelState({}).architect, null);
  // v0.7.0 架构师模型：{provider,model,reasoningEffort?}；缺 provider/model 或非法 → null（未选择）
  assert.deepEqual(normalizePanelState({ architectModel: { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' } }).architectModel, { provider: 'geekai', model: 'gpt-6.1-sol', reasoningEffort: 'max' });
  assert.deepEqual(normalizePanelState({ architectModel: { provider: 'geekai', model: 'gpt-6.1-sol' } }).architectModel, { provider: 'geekai', model: 'gpt-6.1-sol' });
  assert.equal(normalizePanelState({ architectModel: { provider: 'geekai' } }).architectModel, null);
  assert.equal(normalizePanelState({ architectModel: { provider: 'bad provider', model: 'x' } }).architectModel, null);
  assert.equal(normalizePanelState({}).architectModel, null, '缺省 null = 首次由 Lead 问用户');
});

test('buildPhaseBrief renders key docs and skips the section when empty', () => {
  const md = buildPhaseBrief({ phase: 'build', goal: 'x', keyDocs: ['docs/SPEC.md'] });
  assert.match(md, /## 关键文件索引/);
  assert.match(md, /- docs\/SPEC\.md/);
  assert.doesNotMatch(buildPhaseBrief({ phase: 'discover' }), /关键文件索引/);
});
test('settings: 阈值百分比推导 + 面板默认值六字段（新增 unlimitedBudget；旧字段忽略）', () => {
  const t = thresholdsFromPercent(40);
  assert.equal(t.warnRatio, 0.35);
  assert.equal(t.organizeRatio, 0.4);
  assert.equal(t.relayRatio, 0.5);
  assert.equal(thresholdsFromPercent(30).warnRatio, 0.25);
  assert.equal(thresholdsFromPercent(30).relayRatio, 0.4);
  assert.equal(thresholdsFromPercent(85).relayRatio, 0.95);
  assert.equal(thresholdsFromPercent(20).warnRatio, 0.15);
  // 2026-10-25 v2 口径：侧栏设置 = 阈值基准 + 面板各选项默认值（六字段）。
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, { threshold: 35, capacityThreshold: 55, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true });
  // 2026-11-01 用户裁决：默认基准 40% → 35%（提醒 30 / 二次提醒 35 / 硬线 45）。
  assert.deepEqual(thresholdsFromPercent(DEFAULT_SETTINGS.threshold), DEFAULT_THRESHOLDS);
  // 字段往返；退役/未知值归一默认（不落库）
  const roundTrip = { threshold: 55, capacityThreshold: 60, defaultOperation: 'compress', autoCompress: true, autoHandoff: true, unlimitedBudget: false, architect: false };
  assert.deepEqual(normalizeSettings(roundTrip), roundTrip);
  assert.deepEqual(
    normalizeSettings({ ...roundTrip, defaultOperation: 'compress-then-handoff', autoChoose: true }),
    { ...roundTrip, defaultOperation: null },
    '退役模式值归一 null（问我）',
  );
  // 阈值裁剪只对合法数值生效；非法默认操作归 null；布尔严格化（非 true 一律 false）
  assert.equal(normalizeSettings({ threshold: 99 }).threshold, 85);
  assert.equal(normalizeSettings({ threshold: 1 }).threshold, 20);
  assert.equal(normalizeSettings({ threshold: 40.4 }).threshold, 40);
  assert.equal(normalizeSettings({ threshold: undefined }).threshold, 35);
  // P3：threshold 只收有限 number —— null/boolean/数字字符串/NaN/Infinity/对象一律抛错（路由回 400）。
  for (const bad of [null, true, false, '40', 'nope', NaN, Infinity, {}, []]) {
    assert.throws(() => normalizeSettings({ threshold: bad }), /finite percentage/, '非法阈值类型必须拒绝：' + String(bad));
  }
  assert.equal(normalizeSettings({ defaultOperation: 'bogus' }).defaultOperation, null);
  assert.deepEqual(normalizeSettings({ autoCompress: 'true', autoHandoff: 0 }), DEFAULT_SETTINGS);
  // 旧字段（autoPhase/autoContinue/autoChoose 等）一律忽略，绝不回写。
  assert.deepEqual(
    normalizeSettings({ threshold: 55, autoPhase: true, autoContinue: true, autoApprove: true, autoChoose: true }),
    { threshold: 55, capacityThreshold: 55, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true },
  );
  assert.deepEqual(normalizeSettings({ autoPhase: true }), DEFAULT_SETTINGS);
  assert.throws(() => normalizeSettings({ threshold: 'nope' }), /finite percentage/);
  // unlimitedBudget 默认开；只接受布尔（非法类型抛错 → 路由 400）
  assert.equal(normalizeSettings({}).unlimitedBudget, true);
  assert.equal(normalizeSettings({ unlimitedBudget: false }).unlimitedBudget, false);
  for (const bad of ['yes', 1, null, {}, []]) {
    assert.throws(() => normalizeSettings({ unlimitedBudget: bad }), /unlimitedBudget must be a boolean/, '非法 unlimitedBudget 必须拒绝：' + String(bad));
  }
  // v0.6.4 专职架构师默认开；只接受布尔
  assert.equal(normalizeSettings({}).architect, true);
  assert.equal(normalizeSettings({ architect: false }).architect, false);
  for (const bad of ['yes', 1, null, {}, []]) {
    assert.throws(() => normalizeSettings({ architect: bad }), /architect must be a boolean/, '非法 architect 必须拒绝：' + String(bad));
  }
});

test('v0.11 P0-E normalizeSettings：capacityThreshold 独立默认 55 / 非法抛错 / 裁剪 [20,95]', () => {
  // 缺省 55（独立字段；不参与 band 派生、不与 threshold 合并）。
  assert.equal(normalizeSettings({}).capacityThreshold, 55);
  assert.equal(DEFAULT_SETTINGS.capacityThreshold, 55);
  // 独立：改 threshold 不影响 capacityThreshold；改 capacityThreshold 不影响 threshold/band 派生。
  assert.equal(normalizeSettings({ threshold: 60 }).capacityThreshold, 55);
  assert.equal(normalizeSettings({ threshold: 60 }).threshold, 60);
  const capOnly = normalizeSettings({ capacityThreshold: 70 });
  assert.equal(capOnly.capacityThreshold, 70);
  assert.equal(capOnly.threshold, 35);
  assert.deepEqual(thresholdsFromPercent(capOnly.threshold), DEFAULT_THRESHOLDS, '容量线不参与 band 派生');
  // 裁剪区间 [20,95]（与 threshold 的 [20,85] 各自独立；容量线不得抬高/降低 band 阈值）。
  assert.equal(normalizeSettings({ capacityThreshold: 99 }).capacityThreshold, 95);
  assert.equal(normalizeSettings({ capacityThreshold: 1 }).capacityThreshold, 20);
  assert.equal(normalizeSettings({ capacityThreshold: 54.6 }).capacityThreshold, 55);
  assert.equal(normalizeSettings({ threshold: 99, capacityThreshold: 60 }).threshold, 85);
  // 非法值抛错（host 路由 → 400），与 threshold 各自校验、互不掩盖。
  for (const bad of [null, true, false, '55', 'nope', NaN, Infinity, {}, []]) {
    assert.throws(() => normalizeSettings({ capacityThreshold: bad }), /capacityThreshold must be a finite percentage/, '非法 capacityThreshold 必须拒绝：' + String(bad));
  }
  assert.throws(() => normalizeSettings({ threshold: 'x', capacityThreshold: 60 }), /threshold must be a finite percentage/);
});

test('resolveEffectiveThresholds：唯一解析入口（settings.threshold → 派生；legacy 双口径已删）', () => {
  // 有 settings → 由 settings.threshold 派生（warn=基准−5 / organize=基准 / relay=基准+10）。
  assert.deepEqual(resolveEffectiveThresholds({ settings: { threshold: 30 } }), thresholdsFromPercent(30));
  assert.deepEqual(resolveEffectiveThresholds({ settings: { threshold: 60 } }), thresholdsFromPercent(60));
  // 无 settings / 空 settings → 默认基准 35% → 30/35/45。
  assert.deepEqual(resolveEffectiveThresholds({}), thresholdsFromPercent(DEFAULT_SETTINGS.threshold));
  assert.deepEqual(resolveEffectiveThresholds({ settings: {} }), thresholdsFromPercent(DEFAULT_SETTINGS.threshold));
  // legacy 入参已删除：即使旧调用方传入也不再生效（只有 settings 口径）。
  const legacy = { warnRatio: 0.45, organizeRatio: 0.5, relayRatio: 0.6, warnTokens: 100000, organizeTokens: 130000, relayTokens: 160000 };
  assert.deepEqual(resolveEffectiveThresholds({ legacyThresholds: legacy }), thresholdsFromPercent(DEFAULT_SETTINGS.threshold));
  assert.deepEqual(
    resolveEffectiveThresholds({ settings: { threshold: 30 }, explicit: true, legacyThresholds: legacy }),
    thresholdsFromPercent(30),
  );
});

test('panelDefaultsOf：侧栏设置 → 面板默认值唯一映射（host/agent 只消费）', () => {
  // 无 live 设置 / 非对象 → undefined（交给 normalizePanelState 回落规范默认）。
  assert.equal(panelDefaultsOf(null), undefined);
  assert.equal(panelDefaultsOf('bogus'), undefined);
  // 五字段映射：非布尔控制位按 undefined（不猜 true/false）。
  assert.deepEqual(
    panelDefaultsOf({ defaultOperation: 'compress', autoCompress: true, autoHandoff: true, unlimitedBudget: 'yes', architect: false }),
    { defaultOperation: 'compress', autoCompress: true, autoHandoff: true, unlimitedBudget: undefined, architect: false },
  );
  // 缺省参数 = host 发布在 globalThis[Symbol.for('dsh-context-relay.settings')] 的 live 设置。
  const key = Symbol.for('dsh-context-relay.settings');
  const previous = globalThis[key];
  try {
    globalThis[key] = { defaultOperation: 'handoff', autoCompress: false, unlimitedBudget: false, architect: true };
    assert.deepEqual(panelDefaultsOf(), { defaultOperation: 'handoff', autoCompress: false, autoHandoff: undefined, unlimitedBudget: false, architect: true });
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test('委派常量下沉 policy（D-14）：纯策略层不再反向 import agent 模块', () => {
  assert.equal(DELEGATION_EXEC_RATIO_MAX, 0.2);
});

test('panel operation labels：单一真源在 policy（短/长两套），未知回落「问我」', () => {
  assert.deepEqual(OPERATION_LABELS, { compress: '压缩', handoff: '接力', continue: '继续' });
  assert.deepEqual(OPERATION_LONG_LABELS, { compress: '压缩继续', handoff: '接力新会话', continue: '继续' });
  assert.equal(operationLabelOf('compress'), '压缩');
  assert.equal(operationLongLabelOf('handoff'), '接力新会话');
  assert.equal(operationLabelOf(null), '问我');
  assert.equal(operationLabelOf('bogus'), '问我');
  assert.equal(operationLongLabelOf('bogus'), '问我', '未知长标签回落短标签（问我）');
});

test('PANEL_OPERATIONS: 单一模式三档（compress/handoff/continue），退役旧档归一 null', () => {
  assert.deepEqual(PANEL_OPERATIONS, ['compress', 'handoff', 'continue']);
  for (const operation of PANEL_OPERATIONS) {
    assert.equal(normalizePanelState({ defaultOperation: operation }).defaultOperation, operation);
  }
  // 已退役的「压缩→新会话」旧值与任何未知值一样归 null（问我）
  assert.equal(normalizePanelState({ defaultOperation: 'compress-then-handoff' }).defaultOperation, null);
  assert.equal(normalizePanelState({ defaultOperation: 'compress-then-handoff!' }).defaultOperation, null);
  assert.equal(normalizeSettings({ defaultOperation: 'compress-then-handoff' }).defaultOperation, null, 'settings 侧同样归一');
});

test('normalizePanelState v3: authorizeNext 严格布尔；退役自决字段整体不出现', () => {
  assert.equal(normalizePanelState().authorizeNext, false);
  assert.equal(normalizePanelState({ authorizeNext: 1 }).authorizeNext, false);
  assert.equal(normalizePanelState({ authorizeNext: true }).authorizeNext, true);
  // 退役自决字段（自动选择档 + 模型自决记录）不进白名单：旧 panel.json 的脏值一律丢弃。
  const retired = normalizePanelState({ autoChoose: true, autoDecision: { operation: 'compress', at: 123 }, defaultOperation: 'handoff' });
  assert.equal('autoChoose' in retired, false);
  assert.equal('autoDecision' in retired, false);
  assert.equal(retired.defaultOperation, 'handoff', '同记录其它合法字段不受影响');
});

test('v0.3.3 模型推荐：normalizePanelState 三字段归一（非法 op/空理由/非数 at；op=null 清空）', () => {
  // 默认三字段与 DEFAULT_PANEL_STATE 基线一致
  assert.deepEqual(normalizePanelState().recommendedOperation, null);
  assert.equal(normalizePanelState().recommendedReason, '');
  assert.equal(normalizePanelState().recommendedAt, null);
  assert.deepEqual(
    [DEFAULT_PANEL_STATE.recommendedOperation, DEFAULT_PANEL_STATE.recommendedReason, DEFAULT_PANEL_STATE.recommendedAt],
    [null, '', null],
  );
  // 合法推荐：reason trim、at trunc（小数向下取整）；op 只认 PANEL_OPERATIONS
  const kept = normalizePanelState({ recommendedOperation: 'compress', recommendedReason: '  首次压缩成本低  ', recommendedAt: 1234.9 });
  assert.equal(kept.recommendedOperation, 'compress');
  assert.equal(kept.recommendedReason, '首次压缩成本低');
  assert.equal(kept.recommendedAt, 1234);
  for (const operation of PANEL_OPERATIONS) {
    assert.equal(normalizePanelState({ recommendedOperation: operation }).recommendedOperation, operation);
  }
  // 非法 op → null，且理由/时间一并丢弃（不留半截推荐）
  const badOp = normalizePanelState({ recommendedOperation: 'bogus', recommendedReason: 'why', recommendedAt: 99 });
  assert.equal(badOp.recommendedOperation, null);
  assert.equal(badOp.recommendedReason, '');
  assert.equal(badOp.recommendedAt, null);
  // reason：只收字符串；trim 后 ≤120
  assert.equal(normalizePanelState({ recommendedOperation: 'handoff', recommendedReason: '   ' }).recommendedReason, '');
  assert.equal(normalizePanelState({ recommendedOperation: 'handoff', recommendedReason: 42 }).recommendedReason, '');
  assert.equal(normalizePanelState({ recommendedOperation: 'handoff', recommendedReason: 'x'.repeat(200) }).recommendedReason.length, 120);
  // at：只收有限正数（0/负数/字符串/NaN/Infinity → null）
  for (const bad of [0, -1, '123', NaN, Infinity, {}, []]) {
    assert.equal(normalizePanelState({ recommendedOperation: 'handoff', recommendedAt: bad }).recommendedAt, null, '非法 at：' + String(bad));
  }
  // op=null 时清空 reason/at（旧脏记录归一）
  const cleared = normalizePanelState({ recommendedOperation: null, recommendedReason: 'stale', recommendedAt: 5 });
  assert.equal(cleared.recommendedOperation, null);
  assert.equal(cleared.recommendedReason, '');
  assert.equal(cleared.recommendedAt, null);
});

test('buildHandoff：next_actions 8 条上限时优先保留用户未完成工作，自动交接清单被截断（由 handoff 文件/工具返回兜底）', () => {
  const user = Array.from({ length: 8 }, (_, index) => 'u' + (index + 1));
  const built = buildHandoff({
    status: { goal: 'keep user work', next_actions: [...user, '旧会话残留-后台任务 1 个：bash-1（需要重跑的由本会话处理）'] },
  });
  for (const item of user) assert.ok(built.markdown.includes('下一步（DoD）：' + item), '用户 next_actions 全部保留：' + item);
  assert.ok(!built.markdown.includes('旧会话残留-后台任务'), '自动清单排在被截断的一端，不挤掉用户工作');
  assert.equal(built.caps.truncated, true);
});

// ────────────────────────────────────────────────────────────────────────────
// v0.9.0 批次2：状态机出口 / 容量保全 / 用户汇报 warning（D1=B/D6=A/D7=A）
// ────────────────────────────────────────────────────────────────────────────

test('v0.9.0 状态机出口常量：PHASE_EXITS/ALL_PHASES/normalizePhaseState/isExitPhase', () => {
  assert.deepEqual(PHASE_EXITS, ['blocked', 'cancel']);
  assert.deepEqual(ALL_PHASES, ['discover', 'decide', 'build', 'verify', 'ship', 'blocked', 'cancel']);
  assert.equal(ALL_PHASES.length, 7);
  assert.equal(PHASES.length, 5, '主链保持 5 值（工作项/预算/闸门只认主链）');
  for (const exit of PHASE_EXITS) assert.equal(PHASES.includes(exit), false, '出口不是 PHASES 成员');
  assert.equal(isExitPhase('blocked'), true);
  assert.equal(isExitPhase('cancel'), true);
  assert.equal(isExitPhase('build'), false);
  assert.equal(isExitPhase(undefined), false);
  assert.equal(normalizePhaseState('blocked'), 'blocked');
  assert.equal(normalizePhaseState(' CANCEL '), 'cancel');
  assert.equal(normalizePhaseState(undefined), 'discover');
  assert.equal(normalizePhaseState('', 'build'), 'build');
  assert.throws(() => normalizePhaseState('bogus'), /unknown phase/);
  // 主链 normalizePhase 保持只认 5 值（工作项/phase 闸门用；出口写入会被拒）。
  assert.throws(() => normalizePhase('blocked'), /unknown phase/);
});

test('v0.11 P0-E capacityOf/capacityRatioOf：独立容量线默认 55% / 窗口未知不猜 / used 缺失不误报', () => {
  assert.equal(CAPACITY_RATIO_DEFAULT, 0.55);
  assert.equal(capacityRatioOf(), 0.55);
  assert.equal(capacityRatioOf({ capacityThreshold: 40 }), 0.4);
  // 独立于 band 阈值：改 threshold 不影响容量比例，改 capacityThreshold 不影响 band 派生。
  assert.equal(capacityRatioOf(normalizeSettings({ threshold: 80 })), 0.55);
  assert.equal(thresholdsFromPercent(normalizeSettings({ capacityThreshold: 90 }).threshold).relayRatio, 0.45);
  // 防御性裁剪/回落：normalizeSettings 在路由层已裁剪 [20,95]；capacityRatioOf 对原始值同样收敛。
  assert.equal(capacityRatioOf({ capacityThreshold: 'x' }), 0.55);
  assert.equal(capacityRatioOf({ capacityThreshold: 1 }), 0.2);
  assert.equal(capacityRatioOf({ capacityThreshold: 99 }), 0.95);
  assert.deepEqual(capacityOf({ used: 54, window: 100 }), { atRisk: false, ratio: 0.54, threshold: 0.55, basis: 'ratio' });
  assert.deepEqual(capacityOf({ used: 55, window: 100 }), { atRisk: true, ratio: 0.55, threshold: 0.55, basis: 'ratio' });
  assert.equal(capacityOf({ used: 860_000, window: 1_000_000 }).atRisk, true);
  assert.equal(capacityOf({ used: 56, window: 100 }).atRisk, true, '0.56 ≥ 默认 0.55 触发');
  assert.equal(capacityOf({ used: 46, window: 100 }).atRisk, false, '0.46 < 默认 0.55 不触发');
  // 窗口未知 / 为 0 / used 缺失 → unavailable，不把预算/绝对 token 当容量线。
  for (const pressure of [undefined, {}, { used: 100_000 }, { window: 100_000 }, { used: 90, window: 0 }, { used: -1, window: 100 }]) {
    const capacity = capacityOf(pressure);
    assert.equal(capacity.atRisk, false, '窗口未知不保全：' + JSON.stringify(pressure));
    assert.equal(capacity.basis, 'unavailable');
    assert.equal(capacity.ratio, undefined);
    assert.equal(capacity.threshold, 0.55, '未知窗口仍报告独立配置阈值');
  }
  // 配置值生效（0.4 / 0.85 均可）；非法 ratio 回落默认 55%。
  assert.equal(capacityOf({ used: 40, window: 100 }, { ratio: 0.4 }).atRisk, true, '独立配置 40% 生效');
  assert.equal(capacityOf({ used: 90, window: 100 }, { ratio: 0.9 }).atRisk, true, '独立配置 90% 生效');
  assert.equal(capacityOf({ used: 55, window: 100 }, { ratio: 0.55 }).atRisk, true, '默认 55% 边界 atRisk');
  assert.equal(capacityOf({ used: 90, window: 100 }, { ratio: 2 }).threshold, 0.55, '非法 ratio 回落默认 55%');
});

test('v0.9.0 userReportWarnings：合规零 warning；缺段/乱序/空段/超长/代码块/输出 → 只 warning 不抛不拒', () => {
  const compliant = '结论：完成用户汇报校验接线。\n影响：无（用户可见行为不变）。\n需要你做什么：无需。\n证据位置：lib/policy.js:488、test/policy.test.mjs';
  const ok = userReportWarnings(compliant);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.formatOk, true);
  assert.equal(ok.chars, [...compliant.trim()].length);
  // markdown 加粗/#/列表 变体与「需要你」变体都识别（顺序固定）。
  assert.deepEqual(userReportWarnings('## 结论：完成\n**影响**：无\n- 需要你做什么：无需\n**证据位置**：a:1').warnings, []);
  assert.equal(userReportWarnings('结论：a\n影响：b\n需要你：c\n证据位置：d').formatOk, true);
  // 缺段 / 乱序 / 空段 → report-format（同一 code）。
  for (const bad of [
    '结论：a\n影响：b\n证据位置：d',
    '影响：b\n结论：a\n需要你做什么：c\n证据位置：d',
    '结论：\n影响：b\n需要你做什么：c\n证据位置：d',
  ]) {
    const result = userReportWarnings(bad);
    assert.equal(result.ok, false);
    assert.equal(result.formatOk, false);
    assert.ok(result.warnings.some((warning) => warning.code === 'report-format'));
  }
  // 600/601 与 4000/4001 边界（码点口径）。
  const filler = (total) => {
    const head = '结论：';
    const tail = '\n影响：无\n需要你做什么：无需\n证据位置：p:1';
    return head + 'x'.repeat(Math.max(0, total - [...head].length - [...tail].length)) + tail;
  };
  assert.equal(userReportWarnings(filler(600)).warnings.some((warning) => warning.code === 'report-too-long'), false, '600 字不提示');
  assert.equal(userReportWarnings(filler(601)).warnings.some((warning) => warning.code === 'report-too-long'), true, '601 字提示');
  assert.equal(userReportWarnings(filler(4000), { detailsRequested: true }).warnings.some((warning) => warning.code === 'report-too-long'), false, '展开档 4000 字不提示');
  assert.equal(userReportWarnings(filler(4001), { detailsRequested: true }).warnings.some((warning) => warning.code === 'report-too-long'), true, '展开档 4001 字提示');
  // 空/非字符串：只统计（不抛）——非空硬门由 checkUserGate 保持。
  for (const empty of ['', '   ', undefined, null, 42]) {
    const result = userReportWarnings(empty);
    assert.equal(result.chars, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'report-empty'));
  }
  // 代码块/超长行/命令输出 → report-internal-details；details_requested 时不产出。
  assert.ok(userReportWarnings(compliant + '\n```\nnpm test\n```').warnings.some((warning) => warning.code === 'report-internal-details'));
  assert.ok(userReportWarnings(compliant + '\n证据位置：' + 'p'.repeat(401)).warnings.some((warning) => warning.code === 'report-internal-details'));
  assert.ok(userReportWarnings(compliant + '\n$ npm test\n全部通过').warnings.some((warning) => warning.code === 'report-internal-details'));
  const authorized = userReportWarnings(compliant + '\n```\nnpm test\n```', { detailsRequested: true });
  assert.ok(!authorized.warnings.some((warning) => warning.code === 'report-internal-details'), '用户已授权展开细节');
  assert.equal(authorized.info, '用户已授权展开细节');
});

test('v0.9.0 formatStatus：capacity 事实行只在 atRisk 时出现（预算行之后）', () => {
  const atRisk = formatStatus({
    phase: 'build',
    lead: { band: 'organize', ratio: 0.87, used: 870_000, window: 1_000_000 },
    thresholds: normalizeThresholds(),
    budget: { headroomToWarn: 0, headroomToOrganize: 0, headroomToRelay: 60_000 },
    capacity: capacityOf({ used: 870_000, window: 1_000_000 }),
  });
  assert.match(atRisk, /capacity: 87\.0% ≥ 55\.0% → 容量保全（独立配置；收尾\/交接准备；预算档本身不构成中途打断例外）/);
  assert.ok(atRisk.indexOf('capacity:') > atRisk.indexOf('budget:'), 'capacity 行在 budget 行之后');
  assert.doesNotMatch(formatStatus({ phase: 'build', capacity: capacityOf({ used: 10, window: 100 }) }), /capacity:/, '不 atRisk 不渲染');
  assert.doesNotMatch(formatStatus({ phase: 'build' }), /capacity:/, '无 capacity 字段不渲染（旧输出不变）');
});
test('v0.9.0 批次3 formatStatus：delegation 行/advice 行/basis 如实标注（无字段旧输出不变）', () => {
  const baseReport = {
    phase: 'build',
    lead: { ratio: 0.412, used: 412000, window: 1000000, band: 'organize' },
    execution: { calls: 3, total: 57, ratio: 0.053 },
  };
  const text = formatStatus({
    ...baseReport,
    delegation: { execRatio: 0.053, calls: { exec: 3, total: 57 }, dispatchCount: 2, collectCount: 1, idleWorkers: 5, advice: '', basis: 'projection' },
  });
  assert.match(text, /delegation: Lead 执行 5\.3%（3\/57，目标 ≤20% warn）· 派活 2 \/ 收口 1 · 空闲队友 5/);
  assert.ok(text.indexOf('delegation:') > text.indexOf('exec:'), 'delegation 行在 exec 行之后');
  assert.doesNotMatch(text, /delegation-advice/);
  // idleWorkers null（团队不可用/非 Lead）→ 显示 ?，不猜 0
  const idleNull = formatStatus({
    ...baseReport,
    delegation: { execRatio: 0, calls: { exec: 0, total: 0 }, dispatchCount: 0, collectCount: 0, idleWorkers: null, advice: '', basis: 'projection' },
  });
  assert.match(idleNull, /· 空闲队友 \?$/m);
  // basis unavailable → 行尾如实标注「投影不可用，仅参考」
  const unavailable = formatStatus({
    ...baseReport,
    delegation: { execRatio: 0, calls: { exec: 0, total: 0 }, dispatchCount: 0, collectCount: 0, idleWorkers: null, advice: '', basis: 'unavailable' },
  });
  assert.match(unavailable, /· 空闲队友 \?（投影不可用，仅参考）$/m);
  // advice 非空 → 追加一行
  const advised = formatStatus({
    ...baseReport,
    delegation: { execRatio: 0.3, calls: { exec: 30, total: 100 }, dispatchCount: 0, collectCount: 0, idleWorkers: 3, advice: '有 3 个空闲队友且本会话 0 次 relay_dispatch：先派活，不要自己写。', basis: 'projection' },
  });
  assert.match(advised, /delegation-advice: 有 3 个空闲队友且本会话 0 次 relay_dispatch：先派活，不要自己写。/);
  assert.match(advised, /delegation: Lead 执行 30\.0%（30\/100，目标 ≤20% warn）/);
  // 无 delegation 字段 → 整组行不渲染（旧调用/单测输出不变）
  assert.doesNotMatch(formatStatus(baseReport), /delegation/);
});


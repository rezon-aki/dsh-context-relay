import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PANEL_STATE,
  DEFAULT_SETTINGS,
  DEFAULT_THRESHOLDS,
  HANDOFF_LIMITS,
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
} from '../lib/policy.js';

test('threshold defaults are ratio-only 35/40/50 with token fallback', () => {
  const t = normalizeThresholds();
  assert.equal(t.warnRatio, 0.35);
  assert.equal(t.organizeRatio, 0.4);
  assert.equal(t.relayRatio, 0.5);
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
  assert.equal(bandFor({ used: 349_999, window: 1_000_000 }, t).band, 'ok');
  assert.equal(bandFor({ used: 350_000, window: 1_000_000 }, t).band, 'warn');
  assert.equal(bandFor({ used: 400_000, window: 1_000_000 }, t).band, 'organize');
  assert.equal(bandFor({ used: 499_999, window: 1_000_000 }, t).band, 'organize');
  assert.equal(bandFor({ used: 500_000, window: 1_000_000 }, t).band, 'relay');
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
  assert.equal(bandFor({}, t).band, 'ok');
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

test('formatStatus is layered and shows 35/40/50', () => {
  const text = formatStatus({
    phase: 'build',
    lead: { ratio: 0.412, used: 412000, window: 1000000, band: 'organize' },
    team: [{ name: 'worker-a', ratio: 0.22, status: 'running', band: 'ok' }],
    advice: 'call relay_organize now',
  });
  assert.match(text, /phase: build/);
  assert.match(text, /41\.2%/);
  assert.match(text, /warn 35\.0% \/ organize 40\.0% \/ relay 50\.0%/);
  assert.match(text, /worker-a/);
  assert.doesNotMatch(text, /(^|\n)advice: /, 'advice 只在结构化字段，text 不重复');
  // 窗口未知时展示 token 兜底
  const fallback = formatStatus({ phase: 'discover', lead: { used: 42000, band: 'ok' }, advice: '-' });
  assert.match(fallback, /兜底 100000\/130000\/160000 tokens/);
});

test('buildPhaseBrief normalizes phase and lists sections', () => {
  const md = buildPhaseBrief({ phase: 'verify', goal: 'validate', exitCriteria: ['tests green'], evidence: ['docs/SPEC.md'] });
  assert.match(md, /# Phase Brief · verify/);
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

test('buildHandoff enforces total 8KB byte cap on pathological input', () => {
  const big = (prefix) => Array.from({ length: 40 }, () => prefix.repeat(195));
  const { markdown, caps } = buildHandoff({
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
  assert.ok(Buffer.byteLength(markdown, 'utf8') <= HANDOFF_LIMITS.totalBytes, 'bytes ' + Buffer.byteLength(markdown));
  assert.ok(caps.bytes.used <= HANDOFF_LIMITS.totalBytes);
  assert.equal(caps.truncated, true);
  // 字节预算用尽后整段跳过的 section 必须全部记入 caps.truncatedSections（SPEC:69/112）。
  const sectionTitles = ['状态', '首条指令', '证据（文件/命令/URL/会话 id）', '已定决策（含理由）', '未决问题（按 P0/P1/P2 标注，P0 必须人类裁决）', '风险与回滚', '硬约束', '明确丢弃的上下文'];
  const missing = sectionTitles.filter((title) => !markdown.includes('## ' + title));
  assert.ok(missing.length > 0, 'pathological input must drop whole sections');
  for (const title of missing) {
    assert.ok(caps.truncatedSections.includes('section:' + title), 'unreported dropped section: ' + title);
  }
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
  const { markdown, caps } = buildHandoff({
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
  assert.ok(Buffer.byteLength(markdown, 'utf8') <= HANDOFF_LIMITS.totalBytes, 'bytes ' + Buffer.byteLength(markdown));
  // 状态段排在最前，先拿预算且目标仍在
  assert.match(markdown, /## 状态/);
  assert.match(markdown, /目标：bounded status survives/);
  // 预算被长段吃满后继续尝试后续短段：短的「硬约束」段仍能落地
  assert.match(markdown, /## 硬约束/);
  assert.ok(caps.truncated, 'budget pressure reported');
  assert.ok(caps.truncatedSections.some((entry) => entry.startsWith('section:')), 'dropped sections reported');
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
  assert.match(text, /thresholds: warn 35\.0% \/ organize 40\.0% \/ relay 50\.0%/);
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

test('DEFAULT_PANEL_STATE / normalizePanelState: 13 字段白名单（v0.3.3 模型推荐），handoffPreAuthorized 已删除，unlimitedBudget 三值严格化', () => {
  const keys = ['authorizeNext', 'autoChoose', 'autoCompress', 'autoDecision', 'autoHandoff', 'defaultOperation', 'handedOff', 'handoffPreset', 'handoffUnlimitedBudget', 'recommendedAt', 'recommendedOperation', 'recommendedReason', 'unlimitedBudget'];
  assert.deepEqual(Object.keys(DEFAULT_PANEL_STATE).sort(), keys);
  assert.equal('handoffPreAuthorized' in DEFAULT_PANEL_STATE, false);
  const state = normalizePanelState({ handoffPreAuthorized: true, autoChoose: true, autoDecision: { operation: 'compress', at: 1 } });
  assert.equal('handoffPreAuthorized' in state, false, '旧 panel.json 的 handoffPreAuthorized 由白名单丢弃');
  assert.deepEqual(Object.keys(state).sort(), keys);
  assert.equal(state.autoChoose, true);
  assert.deepEqual(state.autoDecision, { operation: 'compress', at: 1 });
  // v0.2.7 unlimitedBudget / handoffUnlimitedBudget：true/false 保留，其余（"true"/1/undefined）归 null（跟随/继承）
  assert.equal(normalizePanelState({ unlimitedBudget: true }).unlimitedBudget, true);
  assert.equal(normalizePanelState({ unlimitedBudget: false }).unlimitedBudget, false);
  assert.equal(normalizePanelState({ unlimitedBudget: 'true' }).unlimitedBudget, null, '字符串不得当真');
  assert.equal(normalizePanelState({}).unlimitedBudget, null, '缺省 null = 跟随 settings 默认');
  assert.equal(normalizePanelState({ handoffUnlimitedBudget: true }).handoffUnlimitedBudget, true);
  assert.equal(normalizePanelState({ handoffUnlimitedBudget: false }).handoffUnlimitedBudget, false);
  assert.equal(normalizePanelState({ handoffUnlimitedBudget: 'off' }).handoffUnlimitedBudget, null);
  assert.equal(normalizePanelState({}).handoffUnlimitedBudget, null, '缺省 null = 交接时跟随当前会话');
  // v0.2.14 handoffPreset（下一个接力会话模式）：preset id 字符集 1-64 位、字母/数字开头；其余（含旧 panel.json 脏值）归 null
  assert.equal(DEFAULT_PANEL_STATE.handoffPreset, null);
  for (const ok of ['relay', 'relay-long', 'my.mode_1', 'a', 'A'.repeat(64), '9x']) {
    assert.equal(normalizePanelState({ handoffPreset: ok }).handoffPreset, ok, '合法 preset id 保留：' + ok);
  }
  for (const bad of [undefined, null, '', '-leading', '.dot', '_x', 'bad id', 'a'.repeat(65), 42, true, {}, []]) {
    assert.equal(normalizePanelState({ handoffPreset: bad }).handoffPreset, null, '非法值归 null：' + String(bad));
  }
});

test('buildPhaseBrief renders key docs and skips the section when empty', () => {
  const md = buildPhaseBrief({ phase: 'build', goal: 'x', keyDocs: ['docs/SPEC.md'] });
  assert.match(md, /## 关键文档/);
  assert.match(md, /- docs\/SPEC\.md/);
  assert.doesNotMatch(buildPhaseBrief({ phase: 'discover' }), /关键文档/);
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
  assert.deepEqual(DEFAULT_SETTINGS, { threshold: 35, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true });
  // 2026-11-01 用户裁决：默认基准 40% → 35%（提醒 30 / 二次提醒 35 / 硬线 45）。
  assert.deepEqual(thresholdsFromPercent(DEFAULT_SETTINGS.threshold), { ...DEFAULT_THRESHOLDS, warnRatio: 0.3, organizeRatio: 0.35, relayRatio: 0.45 });
  // 六字段往返（'compress-then-handoff' 是 v2 新挡位）
  const roundTrip = { threshold: 55, defaultOperation: 'compress-then-handoff', autoChoose: true, autoCompress: true, autoHandoff: true, unlimitedBudget: false };
  assert.deepEqual(normalizeSettings(roundTrip), roundTrip);
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
  assert.deepEqual(normalizeSettings({ autoChoose: 1, autoCompress: 'true', autoHandoff: 0 }), DEFAULT_SETTINGS);
  // 旧字段（autoPhase/autoContinue/autoApprove 等）一律忽略，绝不回写。
  assert.deepEqual(
    normalizeSettings({ threshold: 55, autoPhase: true, autoContinue: true, autoApprove: true }),
    { threshold: 55, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true },
  );
  assert.deepEqual(normalizeSettings({ autoPhase: true }), DEFAULT_SETTINGS);
  assert.throws(() => normalizeSettings({ threshold: 'nope' }), /finite percentage/);
  // unlimitedBudget 默认开；只接受布尔（非法类型抛错 → 路由 400）
  assert.equal(normalizeSettings({}).unlimitedBudget, true);
  assert.equal(normalizeSettings({ unlimitedBudget: false }).unlimitedBudget, false);
  for (const bad of ['yes', 1, null, {}, []]) {
    assert.throws(() => normalizeSettings({ unlimitedBudget: bad }), /unlimitedBudget must be a boolean/, '非法 unlimitedBudget 必须拒绝：' + String(bad));
  }
});

test('PANEL_OPERATIONS: 三种旧挡位 + v2「压缩→新会话」，normalizePanelState 全部接受', () => {
  assert.deepEqual(PANEL_OPERATIONS, ['compress', 'handoff', 'continue', 'compress-then-handoff']);
  for (const operation of PANEL_OPERATIONS) {
    assert.equal(normalizePanelState({ defaultOperation: operation }).defaultOperation, operation);
  }
  assert.equal(normalizePanelState({ defaultOperation: 'compress-then-handoff!' }).defaultOperation, null);
});

test('normalizePanelState v3: authorizeNext 严格布尔；autoDecision 只依赖 autoChoose（R2）', () => {
  assert.equal(normalizePanelState().authorizeNext, false);
  assert.equal(normalizePanelState().autoDecision, null);
  assert.equal(normalizePanelState({ authorizeNext: 1 }).authorizeNext, false);
  assert.equal(normalizePanelState({ authorizeNext: true }).authorizeNext, true);
  const decision = { operation: 'compress', at: 123 };
  assert.deepEqual(normalizePanelState({ autoChoose: true, autoDecision: decision }).autoDecision, decision);
  // R2：defaultOperation 非 null（侧栏默认值常见）不影响模型自决
  assert.deepEqual(normalizePanelState({ autoChoose: true, defaultOperation: 'handoff', autoDecision: decision }).autoDecision, decision);
  // autoChoose=false / 非法 operation / 非有限 at → null
  assert.equal(normalizePanelState({ autoChoose: false, autoDecision: decision }).autoDecision, null);
  assert.equal(normalizePanelState({ autoChoose: true, autoDecision: { operation: 'auto', at: 1 } }).autoDecision, null);
  assert.equal(normalizePanelState({ autoChoose: true, autoDecision: { operation: 'compress', at: 'now' } }).autoDecision, null);
  assert.equal(normalizePanelState({ autoChoose: true, autoDecision: { operation: 'compress', at: Infinity } }).autoDecision, null);
  // 归一化只保留 operation/at，未知键丢弃
  assert.deepEqual(normalizePanelState({ autoChoose: true, autoDecision: { operation: 'handoff', at: 2, reason: 'drop' } }).autoDecision, { operation: 'handoff', at: 2 });
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


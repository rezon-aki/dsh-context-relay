/**
 * v0.10.0 C10 兼容债防回潮：lib/ 全量 grep 断言（退役标识不得再出现）。
 *
 * 治 M-18/D-08/MIG4/5/7/8：沿 v0.9.0 迁移期留下的兼容面（cth/autoChoose/autoDecision/
 * handoffPreset/legacy thresholds/classic alias/routerMode/next_operation）已在 C10 一次删净，
 * 本测试对 lib/ 做静态 grep，任何一处退役标识回流即红（协议/注释/遗留字段都算）。
 *
 * 说明（唯一豁免）：C10 的写范围限定在 policy/index/agent/tools/protocol/client/panel-store；
 * 少量退役字段仍被 C10 范围外的文件读写（handoff 归档面板、notice 面板签名/文案、panel-gate 展示、
 * derive/projection 注释）。这些文件由后续 commit 收口，此处用显式 allowlist 记录欠账：
 *  - allowlist 条目必须真实命中（清理后不删条目 → 红，强制收紧）；
 *  - allowlist 之外的任何命中 → 红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIB_ROOT = new URL('../lib/', import.meta.url);
const libPath = (rel) => new URL(rel, LIB_ROOT);

/** 递归列出 lib/ 下全部 .js 源文件（相对 lib/ 的 posix 路径）。 */
function listLibFiles(dirUrl, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...listLibFiles(new URL(entry.name + '/', dirUrl), rel + '/'));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

/** 退役标识（子串匹配；v0.10.0 起 lib/ 不得出现）。 */
const RETIRED_TOKENS = Object.freeze([
  'autoChoose',
  'autoDecision',
  'handoffPreset',
  'handoffPreAuthorized',
  'DEFAULT_THRESHOLDS',
  'routerMode',
  'legacyPresetCompat',
  'next_operation',
  'compress-then-handoff',
  'LEGACY_PRESET',
  'settingsExplicit',
]);
/** 缩写/别名按词边界匹配（避免误伤英文单词子串）。 */
const RETIRED_WORDS = Object.freeze(['cth', 'classic']);

/** C10 范围外仍未删净的退役标识（file → tokens）；后续 commit 清理后必须同步删条目。 */
const OUT_OF_SCOPE_PENDING = Object.freeze({
  'agent/handoff.js': ['autoChoose', 'autoDecision', 'handoffPreset', 'classic'],
  'agent/notice/plan.js': ['autoChoose'],
  'agent/panel-gate.js': ['autoChoose', 'autoDecision', 'cth', 'compress-then-handoff'],
  'agent/derive.js': ['next_operation'],
  'projection.js': ['autoChoose', 'next_operation'],
});

/** 命中一条退役标识的行列表（1-based 行号 + 原文）。 */
function scan(text, token) {
  const hits = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let matched;
    if (token === 'cth' || token === 'classic') {
      matched = new RegExp('(?<![A-Za-z])' + token + '(?![A-Za-z])').test(line);
    } else {
      matched = line.includes(token);
    }
    if (matched) hits.push(index + 1 + ': ' + line.trim());
  }
  return hits;
}

/** 收集 allHits：{ file → { token → [line...] } } */
function collectHits() {
  const hits = {};
  for (const file of listLibFiles(LIB_ROOT)) {
    const text = readFileSync(libPath(file), 'utf8');
    for (const token of [...RETIRED_TOKENS, ...RETIRED_WORDS]) {
      const found = scan(text, token);
      if (found.length > 0) {
        hits[file] = hits[file] ?? {};
        hits[file][token] = found;
      }
    }
  }
  return hits;
}

test('C10 compat-grep：lib/ 不再出现退役标识（allowlist 之外零命中）', () => {
  const hits = collectHits();
  const unexpected = [];
  for (const [file, tokens] of Object.entries(hits)) {
    const allowed = OUT_OF_SCOPE_PENDING[file] ?? [];
    for (const [token, lines] of Object.entries(tokens)) {
      if (allowed.includes(token)) continue;
      for (const line of lines) unexpected.push(file + ':' + line + '  [token=' + token + ']');
    }
  }
  assert.deepEqual(unexpected, [], '退役标识回流（C10 已删净，仅允许 OUT_OF_SCOPE_PENDING 内欠账）:\n' + unexpected.join('\n'));
});

test('C10 compat-grep：allowlist 欠账仍然真实存在（清理后必须删条目，防豁免漂移）', () => {
  const hits = collectHits();
  const stale = [];
  for (const [file, tokens] of Object.entries(OUT_OF_SCOPE_PENDING)) {
    for (const token of tokens) {
      if (hits[file]?.[token] === undefined) stale.push(file + ' [token=' + token + '] 已不存在 → 删除 allowlist 条目');
    }
  }
  assert.deepEqual(stale, [], 'allowlist 条目已过期（对应退役标识已被清理）:\n' + stale.join('\n'));
});

test('C10 compat-grep：C10 写范围内文件必须零命中（policy/index/agent/tools/protocol/client/panel-store）', () => {
  const cleanFiles = ['policy.js', 'index.js', 'agent.js', 'agent/tools.js', 'agent/protocol.js', 'client.js', 'panel-store.js'];
  const hits = collectHits();
  const dirty = cleanFiles.filter((file) => hits[file] !== undefined)
    .map((file) => file + ' → ' + Object.keys(hits[file]).join(', '));
  assert.deepEqual(dirty, [], 'C10 清理面不得残留退役标识:\n' + dirty.join('\n'));
});

test('C10 契约：panel schemaVersion=3 / 单模式三档 / 退役导出已删', async () => {
  const policy = await import('../lib/policy.js');
  // 面板授权契约版本升级（v2 → v3）：旧版本载入一次性失效授权（panel-store 显式 warn，见 panel-store 测试）。
  assert.equal(policy.PANEL_SCHEMA_VERSION, 3);
  // 单模式三档（退役档不在 enum）
  assert.deepEqual([...policy.PANEL_OPERATIONS], ['compress', 'handoff', 'continue']);
  assert.deepEqual(Object.keys(policy.OPERATION_LABELS).sort(), ['compress', 'continue', 'handoff']);
  // 退役导出已删：DEFAULT_THRESHOLDS/BANDS 不再导出（D-13/BANDS 无消费者；legacy 阈值双口径删净）
  assert.equal('DEFAULT_THRESHOLDS' in policy, false, 'legacy DEFAULT_THRESHOLDS 导出已删');
  assert.equal('BANDS' in policy, false, '无消费者的 BANDS 导出已删');
  // 面板状态白名单不再含退役字段
  const state = policy.normalizePanelState({ autoChoose: true, autoDecision: { operation: 'compress', at: 1 }, handoffPreset: 'relay' });
  assert.deepEqual(Object.keys(state).sort(), [
    'architect', 'architectModel', 'authorizeNext', 'autoCompress', 'autoHandoff', 'defaultOperation',
    'handedOff', 'handoffUnlimitedBudget', 'recommendedAt', 'recommendedOperation', 'recommendedReason', 'unlimitedBudget',
  ]);
  // 阈值唯一解析入口：只认 settings（legacy 入参不再生效）
  assert.deepEqual(policy.resolveEffectiveThresholds({ settings: { threshold: 30 } }), policy.thresholdsFromPercent(30));
  assert.deepEqual(policy.resolveEffectiveThresholds({ legacyThresholds: { warnRatio: 0.45, organizeRatio: 0.5, relayRatio: 0.6 } }), policy.thresholdsFromPercent(policy.DEFAULT_SETTINGS.threshold));
});

test('C10 契约：协议单一文本 / relay_phase schema 无 next_operation / client 不再写 autoChoose', async () => {
  const protocol = await import('../lib/agent/protocol.js');
  assert.equal('PROTOCOL_TEXT_LONG' in protocol, false, '迁移期派生文本已删（唯一 PROTOCOL_TEXT）');
  assert.doesNotMatch(protocol.PROTOCOL_TEXT, /compress-then-handoff|autoChoose|autoDecision|两段式/, '退役协议句不得回到常驻文本');
  const phaseSchemaSource = readFileSync(libPath('agent/tools.js'), 'utf8');
  assert.equal(/name: TOOL_PREFIX \+ 'phase'[\s\S]*?properties: \{[\s\S]*?next_operation:/.test(phaseSchemaSource), false, 'relay_phase schema 不再暴露 next_operation');
  const clientSource = readFileSync(libPath('client.js'), 'utf8');
  assert.equal(clientSource.includes('autoChoose'), false, 'client PUT 不再写 autoChoose');
  const panelStoreSource = readFileSync(libPath('panel-store.js'), 'utf8');
  assert.match(panelStoreSource, /schemaVersion: PANEL_SCHEMA_VERSION/, 'panel.json 写盘带当前 schemaVersion');
  assert.doesNotMatch(panelStoreSource, /EXPIRED_AUTH_FIELDS[\s\S]{0,200}autoChoose/, '授权失效清单不含退役字段');
});

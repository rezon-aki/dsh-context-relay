/**
 * v0.13 fix4 复验三处（point-2 存疑 ①⑨③）：
 * ② collect 真读 receiptVerify：strict 缺 commit/verification 直接拒（零台账写入），warn 只标 unverified；
 *    两个新开关进 AGENT_OPTION_KEYS + README 配置表（单一真源生成）。
 * ③ collect 的 lead_confirm schema 由 LEAD_CONFIRM_SPEC 生成（不再手写副本）。
 * 全部走工具 execute 真实路径；tmp 工作区 + 进程内 fake 服务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDelegationTools, clearDelegationMemory } from '../lib/agent/delegation-tools.js';
import { LEAD_CONFIRM_FIELDS, LEAD_CONFIRM_REQUIRED_FIELDS, LEAD_CONFIRM_SCHEMA_PROPERTIES, readWorkItems, writeWorkItems } from '../lib/agent/work-items.js';
import { clearPanelMemory, configurePanelStore } from '../lib/panel-store.js';
import { clearSentinelMemory } from '../lib/agent/sentinel.js';
import { clearDeriveMemory } from '../lib/agent/derive.js';
import { thresholdsFromPercent } from '../lib/policy.js';
import { extractConfigTable, readAgentOptionKeys } from '../scripts/gen-config-table.mjs';

const LEAD_CONFIRM = { no_drift: true, no_missing: true, no_regression: true };
const thresholds = thresholdsFromPercent(35);

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), 'relay-fix4-'));
}

function resetShared() {
  clearDeriveMemory();
  clearSentinelMemory();
  clearPanelMemory();
  configurePanelStore({ panelPath: join(mkdtempSync(join(tmpdir(), 'relay-fix4-panel-')), 'panel.json') });
  delete globalThis[Symbol.for('dsh-context-relay.settings')];
  globalThis[Symbol.for('dsh-context-relay.settings')] = { threshold: 40, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true };
  clearDelegationMemory();
}

function fakeCtx(services = {}) {
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register() { return () => {}; } },
    get(name) { return services[name]; },
  };
  return { ctx };
}

function fakeSession({ id, cwd }) {
  return {
    id,
    header: { cwd },
    seq: 0,
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'test' } }),
    snapshotEvents: () => [],
  };
}

function collectHarness(cwd, sessionId, { receiptVerify } = {}) {
  const lead = { session: fakeSession({ id: sessionId, cwd }) };
  const subagents = { rootOf: () => lead, namesOf: () => ({ self: 'lead' }) };
  const { ctx } = fakeCtx({ subagents });
  const definitions = createDelegationTools({
    ctx,
    currentThresholds: () => thresholds,
    workItems: { enabled: true, max: 30 },
    allowSpawn: false,
    squadMax: 8,
    ...(receiptVerify === undefined ? {} : { receiptVerify }),
  });
  return { lead, collect: definitions.find((tool) => tool.name === 'relay_collect') };
}

async function seedDoing(cwd, sessionId, ids) {
  const written = await writeWorkItems(cwd, {
    items: ids.map((id) => ({ id, title: id, status: 'doing', owner: 'worker-1', next: '回执 .scratch/context-relay/reports/' + id + '.md', phase: 'build' })),
    updatedBy: sessionId,
    scopeId: sessionId,
  });
  assert.equal(written.ok, true, JSON.stringify(written));
}

function writeReport(cwd, id, { revision, evidenceBlock }) {
  const dir = join(cwd, '.scratch/context-relay/reports');
  mkdirSync(dir, { recursive: true });
  const body = ['task: ' + id, 'revision: ' + revision, 'verdict: done', 'assessment: needPriorContext=true canFinish=true action=direct', '', '## 结论', '完成。', ''];
  if (evidenceBlock !== undefined) body.push('## 验证', evidenceBlock, '');
  writeFileSync(join(dir, id + '.md'), body.join('\n'));
}

test('② receiptVerify：strict 缺 commit/verification 直接拒（零台账写入）；warn 只标 unverified', async () => {
  resetShared();
  const cwd = tmpCwd();
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  const session = 'session-fix4-collect';
  await seedDoing(cwd, session, ['strict-missing', 'strict-full']);
  writeReport(cwd, 'strict-missing', { revision: 'd-strict-missing' });
  writeReport(cwd, 'strict-full', { revision: 'd-strict-full', evidenceBlock: '- commit: ' + sha + '\n- cmd: npm test\n  exit: 0' });
  const legacyHarness = { ...collectHarness(cwd, session, { receiptVerify: 'strict' }), cwd, session };

  const refused = await legacyHarness.collect.execute({ itemId: 'strict-missing', dispatchId: 'd-strict-missing', lead_confirm: LEAD_CONFIRM }, { agent: legacyHarness.lead });
  assert.equal(refused.ok, false, 'strict：缺证据必须拒');
  assert.equal(refused.code, 'evidence-required');
  assert.deepEqual(refused.evidence.missing, ['commit', 'verification']);
  const afterRefused = readWorkItems(cwd, { scopeId: session }).items.find((item) => item.id === 'strict-missing');
  assert.equal(afterRefused.status, 'doing', '拒绝时零台账写入');

  const accepted = await legacyHarness.collect.execute({ itemId: 'strict-full', dispatchId: 'd-strict-full', lead_confirm: LEAD_CONFIRM }, { agent: legacyHarness.lead });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.evidence.verdict, 'verified');
  assert.equal(readWorkItems(cwd, { scopeId: session }).items.find((item) => item.id === 'strict-full').status, 'done');

  // warn（默认）：同一缺证据回执放行，只标 unverified + digest 明示。
  const warnSession = 'session-fix4-collect-warn';
  const warnCwd = tmpCwd();
  await seedDoing(warnCwd, warnSession, ['warn-missing']);
  writeReport(warnCwd, 'warn-missing', { revision: 'd-warn-missing' });
  const warnHarness = collectHarness(warnCwd, warnSession, { receiptVerify: 'warn' });
  const warned = await warnHarness.collect.execute({ itemId: 'warn-missing', dispatchId: 'd-warn-missing', lead_confirm: LEAD_CONFIRM }, { agent: warnHarness.lead });
  assert.equal(warned.ok, true, 'warn 放行');
  assert.equal(warned.evidence.verdict, 'unverified');
  assert.match(warned.digest, /^\[evidence:unverified:commit\+verification\] /);
  assert.match(warned.evidenceWarning, /commit/);
});

test('③ collect lead_confirm schema 由 LEAD_CONFIRM_SPEC 生成（无手写副本、无 anyOf）', () => {
  resetShared();
  const { collect } = collectHarness(tmpCwd(), 'session-fix4-schema');
  const leadConfirm = collect.parameters.properties.lead_confirm;
  assert.deepEqual(Object.keys(leadConfirm.properties), [...LEAD_CONFIRM_FIELDS], 'schema 键集 = LEAD_CONFIRM_FIELDS');
  assert.deepEqual(leadConfirm.required, [...LEAD_CONFIRM_REQUIRED_FIELDS], 'required = 三项人工确认');
  assert.deepEqual(leadConfirm.properties, { ...LEAD_CONFIRM_SCHEMA_PROPERTIES }, '字段 schema 与单源一致');
  assert.equal(leadConfirm.anyOf, undefined, 'collect 不接受 auto+confirmKey 代替三项 true');
});

test('② 配置键：receiptVerify/strictToolArgs 进 AGENT_OPTION_KEYS 与 README 配置表', () => {
  const keys = readAgentOptionKeys();
  assert.ok(keys.includes('receiptVerify'), 'AGENT_OPTION_KEYS 含 receiptVerify');
  assert.ok(keys.includes('strictToolArgs'), 'AGENT_OPTION_KEYS 含 strictToolArgs');
  const readmeZh = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const readmeEn = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8');
  assert.match(extractConfigTable(readmeZh), /\| `receiptVerify` \|/);
  assert.match(extractConfigTable(readmeZh), /\| `strictToolArgs` \|/);
  assert.match(extractConfigTable(readmeEn), /\| `receiptVerify` \|/);
  assert.match(extractConfigTable(readmeEn), /\| `strictToolArgs` \|/);
});

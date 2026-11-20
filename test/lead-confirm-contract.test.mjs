/**
 * P0-A3 lead_confirm 单源 contract（真源：architecture/relay-systemic-audit.md §7.2-2）。
 *
 * 探针走模型真实路径：createRelayTools → 工具定义 schema / execute()，不直调
 * writeWorkItems 的确认分支自证；fixture 只负责把台账 currentPhase.risk 置为 T1，
 * 让 relay_work_items 走生产同款自动确认，再回放 schema 允许的 auto+confirmKey 形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRelayTools } from '../lib/agent/tools.js';
import { LEAD_CONFIRM_AUTO_FIELDS, LEAD_CONFIRM_FIELDS, LEAD_CONFIRM_REQUIRED_FIELDS, writeWorkItems } from '../lib/agent/work-items.js';

function fakeCtx() {
  return {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on() { return () => {}; },
    logger: { info() {}, warn() {} },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    tools: { register() { return () => {}; } },
    get() { return undefined; },
  };
}

test('A3 contract：schema 的 lead_confirm 键集 = 单源常量；normalizer 白名单不漂移；auto+confirmKey 可经工具复用', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-confirm-contract-'));
  const session = { id: 'session-confirm-contract', header: { cwd }, seq: 0 };
  const agent = { session };
  const tools = createRelayTools({
    ctx: fakeCtx(),
    currentThresholds: () => ({ warn: 0.3, organize: 0.35, relay: 0.45 }),
    workItems: { enabled: true, max: 30 },
  });
  const tool = tools.find((definition) => definition.name === 'relay_work_items');
  assert.ok(tool, 'relay_work_items 必须注册');

  const leadConfirm = tool.parameters.properties.items.items.properties.lead_confirm;
  assert.deepEqual(Object.keys(leadConfirm.properties), [...LEAD_CONFIRM_FIELDS], 'schema 键集与 LEAD_CONFIRM_FIELDS 漂移');
  assert.deepEqual(leadConfirm.anyOf[0].required, [...LEAD_CONFIRM_REQUIRED_FIELDS], '三项确认 required 与常量漂移');
  assert.deepEqual(leadConfirm.anyOf[1].required, ['auto', 'confirmKey'], '复用 required 与契约漂移');
  for (const field of LEAD_CONFIRM_AUTO_FIELDS) assert.ok(field in leadConfirm.properties, 'schema 缺字段: ' + field);

  // fixture：只把台账 phase/risk 置为 T1（生产由 relay_phase 写；这里只搭数据）。
  const seeded = await writeWorkItems(cwd, {
    items: [],
    scopeId: session.id,
    currentPhase: { phase: 'build', risk: { tier: 'T1', source: 'declared', reasons: ['contract'] } },
  });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  // 真实路径 1：模型工具写 done 文档项（不带 lead_confirm）→ 生产同款 auto 确认并落盘。
  const doc = { id: 'contract-doc', title: '补契约文档', status: 'done', evidence: ['docs/contract.md:1'], phase: 'build' };
  const first = await tool.execute({ items: [doc] }, { agent });
  assert.equal(first.ok, true, JSON.stringify(first));
  const saved = first.items.find((item) => item.id === 'contract-doc');
  assert.equal(saved.lead_confirm.auto, 'T1');
  assert.match(saved.lead_confirm.confirmKey, /^[0-9a-f]{16}$/);
  assert.match(saved.lead_confirm.diffHash, /^[0-9a-f]{16}$/);

  // 真实路径 2：只回放 schema 允许的 auto+confirmKey（+diffHash，含未知字段）→ 复用盘上三项 true。
  const replay = await tool.execute({
    rev: first.rev,
    items: [{ ...doc, lead_confirm: { auto: saved.lead_confirm.auto, confirmKey: saved.lead_confirm.confirmKey, diffHash: saved.lead_confirm.diffHash, evil: true } }],
  }, { agent });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  const after = replay.items.find((item) => item.id === 'contract-doc');
  assert.deepEqual([after.lead_confirm.no_drift, after.lead_confirm.no_missing, after.lead_confirm.no_regression], [true, true, true]);
  assert.equal(after.lead_confirm.confirmKey, saved.lead_confirm.confirmKey);
  for (const key of Object.keys(after.lead_confirm)) assert.ok(LEAD_CONFIRM_FIELDS.includes(key), 'normalizer 白名单泄漏字段: ' + key);
  assert.equal(after.lead_confirm.evil, undefined, '未知字段必须被 normalizer 丢弃');

  // 真实路径 3：显式 3×true 仍可写 done（collect 收口同口径）。
  const explicit = await tool.execute({
    rev: replay.rev,
    items: [...replay.items, { id: 'contract-explicit', title: '显式确认', status: 'done', evidence: ['docs/x.md:1'], phase: 'build', lead_confirm: { no_drift: true, no_missing: true, no_regression: true } }],
  }, { agent });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
});

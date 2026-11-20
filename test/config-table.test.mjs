/**
 * 配置表单一真源：README.md / README.en.md 的表必须等于 scripts/gen-config-table.mjs 的输出。
 * 手改 README 表 → 本测试红；改表请改生成器后跑 `node scripts/gen-config-table.mjs --write`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../lib/policy.js';
import { DOC_LIMITS } from '../lib/docs.js';
import { normalizeDocsOptions } from '../lib/docs-policy.js';
import { normalizeWorkItemsConfig } from '../lib/agent/work-items.js';
import { normalizeDelegationConfig } from '../lib/agent/delegation.js';
import { SQUAD_MAX_DEFAULT } from '../lib/agent/team.js';
import {
  checkConfigTables,
  CONFIG_ROWS,
  extractConfigTable,
  readAgentOptionKeys,
  README_FILES,
  renderConfigTable,
} from '../scripts/gen-config-table.mjs';

const documentedTopLevelKeys = () => {
  const keys = new Set();
  for (const row of CONFIG_ROWS) {
    for (const token of row.key.replace(/`/g, '').split(' / ')) {
      const top = token.split('.')[0].trim();
      if (top !== '') keys.add(top);
    }
  }
  return keys;
};

const tableRows = (lang) => {
  const table = extractConfigTable(readFileSync(README_FILES[lang], 'utf8'));
  const map = new Map();
  for (const line of table.split('\n').slice(2)) {
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    map.set(cells[0], cells[1]);
  }
  return map;
};

test('config-table：README 中文/英文表逐字节等于生成器输出', () => {
  assert.deepEqual(checkConfigTables(), [], 'README 配置表漂移：跑 node scripts/gen-config-table.mjs --write');
  for (const lang of ['zh', 'en']) {
    const actual = extractConfigTable(readFileSync(README_FILES[lang], 'utf8'));
    assert.equal(actual, renderConfigTable(lang), lang + ' 表与生成器不一致');
  }
});

test('config-table：覆盖 AGENT_OPTION_KEYS，且没有未知的顶层配置键', () => {
  const agentKeys = readAgentOptionKeys();
  assert.ok(agentKeys.length >= 10, '解析 AGENT_OPTION_KEYS 失败：' + JSON.stringify(agentKeys));
  const documented = documentedTopLevelKeys();
  for (const key of agentKeys) assert.ok(documented.has(key), '配置表缺 AGENT_OPTION_KEYS 项：' + key);
  // 历史/宿主级键（不随 preset 行透传，但确实是 host config）：允许出现在表里。
  const allowedExtras = new Set(['threshold', 'settingsPath', 'architect', 'longPresetId']);
  const extras = [...documented].filter((key) => !agentKeys.includes(key) && !allowedExtras.has(key));
  assert.deepEqual(extras.sort(), [], '配置表出现未声明的顶层键');
  const missingExtras = [...allowedExtras].filter((key) => !documented.has(key));
  assert.deepEqual(missingExtras.sort(), [], '配置表缺少宿主级键');
});

test('config-table：默认值列从代码读取（settings/workItems/docs/delegation/squad）', () => {
  const workItems = normalizeWorkItemsConfig({});
  const delegation = normalizeDelegationConfig({});
  const docs = normalizeDocsOptions({});
  const rows = tableRows('zh');
  assert.equal(rows.get('`threshold` / `settings.threshold`'), String(DEFAULT_SETTINGS.threshold));
  assert.equal(rows.get('`settings.capacityThreshold`'), '`' + DEFAULT_SETTINGS.capacityThreshold + '`');
  assert.equal(rows.get('`squadMax`'), '`' + SQUAD_MAX_DEFAULT + '`');
  assert.equal(rows.get('`workItems`'), '`' + workItems.enabled + '`');
  assert.equal(rows.get('`workItemsGate`'), "`'" + workItems.gate + "'`");
  assert.equal(rows.get('`workItemsPhaseGate`'), "`'" + workItems.phaseGate + "'`");
  assert.equal(rows.get('`delegationGate`'), "`'" + delegation.gate + "'`");
  assert.equal(rows.get('`workItemsMax`'), '`' + workItems.max + '`');
  assert.equal(rows.get('`docs.select`'), '`' + docs.select + '`');
  assert.equal(rows.get('`docs.layout`'), '`' + docs.layout + '`');
  assert.equal(rows.get('`docs.metrics`'), '`' + docs.metrics + '`');
  assert.equal(rows.get('`docs.width`'), '`' + DOC_LIMITS.indexWidth + '`');
  assert.equal(tableRows('en').get('`workItemsPath`'), 'per session');
  assert.equal(tableRows('en').get('`docs.maxGroups`'), 'unset (G off)');
});

test('config-table：CLI --check 可直接用于 CI/手工校验', () => {
  const script = fileURLToPath(new URL('../scripts/gen-config-table.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, (result.stderr || result.stdout || '').trim());
  assert.match(result.stdout, /config table: OK/);
});

/**
 * legacy golden：固定 fixture 下把 v0.11 渲染（docs.select=legacy）逐字节锁住。
 *
 * 更新方式（显式）：UPDATE_GOLDEN=1 node --test test/legacy-golden.test.mjs
 * 更新后请 review test/fixtures/legacy-index.golden.md 的 diff 再提交。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocIndex, renderDocIndex } from '../lib/docs.js';
import { createRelayTools } from '../lib/agent/tools.js';
import { buildLegacyFixture } from './fixtures/legacy-index.fixture.mjs';

const GOLDEN_PATH = new URL('./fixtures/legacy-index.golden.md', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function runtimeFor(cwd) {
  return {
    ctx: {
      logger: { info() {}, warn() {} },
      get() { return undefined; },
      effect(fn) { return typeof fn === 'function' ? fn() : () => {}; },
      on() { return () => {}; },
    },
    currentThresholds: () => ({ warnRatio: 0.3, organizeRatio: 0.35, relayRatio: 0.45 }),
    currentCapacityRatio: () => 0.55,
    workItems: { enabled: false },
    docs: { select: 'legacy', metrics: false },
  };
}

test('legacy golden：固定 fixture 的 v0.11 渲染逐字节稳定', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-legacy-golden-'));
  try {
    buildLegacyFixture(cwd);
    const index = buildDocIndex(cwd);
    const direct = renderDocIndex(index, { select: false });
    assert.equal(direct.level, 'legacy', 'legacy 渲染 level 应为 legacy');
    assert.match(direct.text, /### 折叠（按目录，展开即取全）/, 'fixture 未触发目录折叠，golden 覆盖不足');
    assert.match(direct.text, /另有 3 份历史产物未入索引/, 'fixture 未触发历史产物尾行');
    assert.doesNotMatch(direct.text, /!\d|→/, 'legacy 渲染不应出现 v0.12 语义标记');

    let golden = existsSync(GOLDEN_PATH) ? readFileSync(GOLDEN_PATH, 'utf8') : '';
    if (UPDATE) {
      writeFileSync(GOLDEN_PATH, direct.text + '\n');
      golden = direct.text + '\n';
    }
    assert.equal(direct.text + '\n', golden, 'legacy golden 漂移：确认 diff 后跑 UPDATE_GOLDEN=1 node --test test/legacy-golden.test.mjs');

    // 工具路径：docs.select=legacy 必须走同一个渲染器；工具只在正文后追加 counts 行。
    const tools = createRelayTools(runtimeFor(cwd));
    const doc = tools.find((definition) => definition.name === 'relay_doc');
    assert.ok(doc !== undefined, 'relay_doc 未注册');
    const result = await doc.execute({ action: 'index' }, { agent: { session: { id: 'legacy-golden', header: { cwd }, seq: 0 }, options: {} } });
    assert.equal(result.level, 'legacy');
    assert.ok(result.text.startsWith(direct.text), '工具路径的 legacy 正文与 golden 不一致');
    const suffix = result.text.slice(direct.text.length);
    assert.match(suffix, /^\n- counts: indexed\/raw=\d+\/\d+ · total=\d+ · bytes=\d+ · level=legacy · digest=[0-9a-f]{16}$/);
    assert.ok(result.groups.length > 0, 'legacy 应返回折叠组信息');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

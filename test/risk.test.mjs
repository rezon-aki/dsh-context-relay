import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, confirmKeyOf, denyKeyOf, docsHashOf, isDocItem, isDocPath, reviewKeyOf } from '../lib/risk.js';

test('classifyRisk：T0 文档/≤20 行；T1 单模块；T2 公共面；未知保守 T2', () => {
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10 }).tier, 'T0');
  assert.equal(classifyRisk({ paths: ['README.md'], lines: 3 }).tier, 'T0');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 40 }).tier, 'T1', '文档 >20 行 → 至少 T1');
  assert.equal(classifyRisk({ paths: ['lib/a.js'], lines: 5 }).tier, 'T1', 'lib 代码 → 至少 T1');
  assert.equal(classifyRisk({ paths: ['package.json'] }).tier, 'T2', '公共面 → T2');
  assert.equal(classifyRisk({}).tier, 'T2', '无法判定 → 保守 T2');
  assert.equal(classifyRisk({ tier: 'T0' }).tier, 'T1', 'T0 缺 reason 降 T1');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['lib/x.js'] }).tier, 'T1', '自动升级优先于声明');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['docs/a.md'], publicSurface: true }).tier, 'T2');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], irreversible: true }).tier, 'T2');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 400 }).tier, 'T2');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10 }).source, 'derived');
  assert.equal(classifyRisk({ tier: 'T1', reason: '单模块' }).source, 'declared');
  assert.ok(classifyRisk({ paths: ['docs/a.md'], lines: 10 }).reasons.length > 0);
  assert.equal(isDocPath('docs/a.md'), true);
  assert.equal(isDocPath('lib/a.js'), false);
  assert.equal(isDocItem('补设计文档'), true);
  assert.equal(isDocItem('改 lib 函数'), false);
});

test('去重键：reviewKey/confirmKey/docsHash/denyKey 确定且随输入变化', () => {
  assert.equal(reviewKeyOf({ requirement: 'r', designPath: 'd', diffHash: 'h' }), reviewKeyOf({ requirement: 'r', designPath: 'd', diffHash: 'h' }));
  assert.notEqual(reviewKeyOf({ requirement: 'r1' }), reviewKeyOf({ requirement: 'r2' }));
  assert.notEqual(reviewKeyOf({ requirement: 'r', diffHash: 'a' }), reviewKeyOf({ requirement: 'r', diffHash: 'b' }));
  assert.match(reviewKeyOf({}), /^[0-9a-f]{16}$/);
  assert.equal(confirmKeyOf({ itemId: 'a', rev: 1 }), confirmKeyOf({ itemId: 'a', rev: 1 }));
  assert.notEqual(confirmKeyOf({ itemId: 'a', rev: 1 }), confirmKeyOf({ itemId: 'a', rev: 2 }));
  const base = [{ path: 'docs/a.md', mtimeMs: 1, size: 2 }];
  assert.equal(docsHashOf(base), docsHashOf([...base]));
  assert.notEqual(docsHashOf(base), docsHashOf([{ path: 'docs/a.md', mtimeMs: 2, size: 2 }]));
  assert.notEqual(docsHashOf(base), docsHashOf(base, 'governance-v2'));
  assert.equal(denyKeyOf({ phase: 'build' }), denyKeyOf({ phase: 'build' }));
  assert.notEqual(denyKeyOf({ phase: 'build' }), denyKeyOf({ phase: 'verify' }));
});

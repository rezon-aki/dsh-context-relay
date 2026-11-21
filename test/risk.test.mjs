import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, confirmKeyOf, denyKeyOf, docsHashOf, isDocItem, isDocPath, reviewKeyOf } from '../lib/risk.js';

test('classifyRisk：T0 文档/≤20 行；T1 单模块；T2 公共面；未知保守 T2', () => {
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10, reason: 'docs' }).tier, 'T0');
  assert.equal(classifyRisk({ paths: ['README.md'], lines: 3, reason: 'docs' }).tier, 'T0');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 40 }).tier, 'T1', '文档 >20 行 → 至少 T1');
  assert.equal(classifyRisk({ paths: ['lib/a.js'], lines: 5 }).tier, 'T1', 'lib 代码 → 至少 T1');
  assert.equal(classifyRisk({ paths: ['package.json'] }).tier, 'T2', '公共面 → T2');
  assert.equal(classifyRisk({}).tier, 'T2', '无法判定 → 保守 T2');
  assert.equal(classifyRisk({ tier: 'T0' }).tier, 'T1', 'T0 缺 reason 降 T1');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs' }).tier, 'T1', 'T0 只凭 reason、无实际 diff 证据 → T1');
  assert.match(classifyRisk({ tier: 'T0', reason: 'docs' }).reasons.join(';'), /actual diff evidence/);
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['docs/a.md'] }).tier, 'T1', 'T0 缺 lines → T1');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['docs/a.md'], lines: 10 }).tier, 'T0', 'T0 带实际 diff（仅文档 ≤20 行）通过');
  // fix-p1b：证据校验在派生之后——派生 T0 同样要显式 paths+lines+reason，缺任一降 T1。
  assert.equal(classifyRisk({ paths: ['docs/a.md'] }).tier, 'T1', '派生 T0 缺 lines+reason → T1');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10 }).tier, 'T1', '派生 T0 缺 reason → T1');
  assert.match(classifyRisk({ paths: ['docs/a.md'], lines: 10 }).reasons.join(';'), /actual diff evidence/);
  assert.equal(classifyRisk({ paths: ['docs/a.md'], reason: 'docs' }).tier, 'T1', '派生 T0 缺 lines → T1');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10, reason: 'docs' }).tier, 'T0', '派生 T0 带 paths+lines+reason 通过');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10, reason: 'docs' }).source, 'derived');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['lib/x.js'] }).tier, 'T1', '自动升级优先于声明');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['scripts/x.mjs'], lines: 3 }).tier, 'T1', 'T0 声明不能覆盖非文档路径');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['docs/a.md'], lines: 3, publicSurface: true }).tier, 'T2', '用户可见/公开面 → T2');
  assert.match(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['docs/a.md'], lines: 3, publicSurface: true }).reasons.join(';'), /public surface/);
  assert.equal(classifyRisk({ paths: ['lib/agent/tools.js'], lines: 5 }).tier, 'T2', '工具 schema 公开面 → T2');
  assert.equal(classifyRisk({ paths: ['lib/index.js'], lines: 5 }).tier, 'T2', 'preset/seam 公开面 → T2');
  assert.equal(classifyRisk({ tier: 'T0', reason: 'docs', paths: ['docs/a.md'], publicSurface: true }).tier, 'T2');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], irreversible: true }).tier, 'T2');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 400 }).tier, 'T2');
  assert.equal(classifyRisk({ paths: ['docs/a.md'], lines: 10, reason: 'docs' }).source, 'derived');
  assert.equal(classifyRisk({ tier: 'T1', reason: '单模块' }).source, 'declared');
  assert.ok(classifyRisk({ paths: ['docs/a.md'], lines: 10 }).reasons.length > 0);
  assert.equal(isDocPath('docs/a.md'), true);
  assert.equal(isDocPath('lib/a.js'), false);
  assert.equal(isDocItem('补设计文档'), true);
  assert.equal(isDocItem('改 lib 函数'), false);
  // 路径优先、标题只兜底（p3-calib 建议 4）：标题写文档但 evidence 是源码 → 非文档；无可用路径才看标题。
  assert.equal(isDocItem({ title: '改 lib 函数', evidence: ['README.md:1'] }), true);
  assert.equal(isDocItem({ title: '补设计文档', evidence: ['lib/x.js:1'] }), false, '文档标题不能覆盖源码 evidence');
  assert.equal(isDocItem({ title: '改 lib 函数', evidence: ['docs/x.md:1'] }), true);
  assert.equal(isDocItem({ title: '改 lib 函数', evidence: ['lib/x.js:1', 'test/a.mjs:2'] }), false);
  // 历史误判根因（p3-calib §4 FN/FP）：整条 evidence 带 verdict/大小/正文时仍要能抽出路径。
  assert.equal(isDocItem({ title: '通知可执行性', evidence: ['reports/notice-actionable-review.md verdict=pass-with-note'] }), true);
  assert.equal(isDocItem({ title: '实现审查', evidence: ['REVIEW-IMPL.md（6122B）'] }), true);
  assert.equal(isDocItem({ title: '任务记录', evidence: ['task-1.md: geo×5，另有 3 项待补'] }), true);
  assert.equal(isDocItem({ title: '群戳', evidence: ['reports/task-poke-perception.md', 'serve.py 群戳窗口'] }), false, '混合证据含代码 → 非文档');
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

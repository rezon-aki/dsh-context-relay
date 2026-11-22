/**
 * 用户语域审计（§8.6）：模板词归零、阈值只在配置表、决策卡指针、handoff 尾指针。
 * 只查当前行为面；历史 CHANGELOG/runbook/README 版本注记不在范围。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ARCHITECT_WORKER_PROTOCOL_TEXT, PHASE_PROTOCOL_TEXT, PROTOCOL_TEXT, REDLINE_PROTOCOL_TEXT } from '../lib/agent/protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const walk = (dir, ext) => readdirSync(join(root, dir), { recursive: true })
  .filter((name) => name.endsWith(ext))
  .map((name) => join(dir, name));
const section = (text, start, next) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, 'missing section: ' + start);
  const to = text.indexOf(next, from + start.length);
  return text.slice(from, to === -1 ? undefined : to);
};
const TEMPLATE_WORDS = /三问|四段|三段式/;

const design = read('docs/design/DESIGN.md');
const readmeZh = read('README.md');
const readmeEn = read('README.en.md');
const readmeSections = {
  'README 该问的才问': section(readmeZh, '### 2. 该问的才问', '### 3.'),
  'README 汇报与提问': section(readmeZh, '### 汇报与提问', '## 团队：'),
  'README.en Asking': section(readmeEn, '### 2. Asking only what has to be asked', '### 3.'),
  'README.en Reports': section(readmeEn, '### Reports and questions', '## The team:'),
};

test('模板词归零：lib 与 skills 当前行为面无三问/四段/三段式', () => {
  for (const file of [...walk('lib', '.js'), ...walk('skills', '.md')]) {
    assert.doesNotMatch(read(file), TEMPLATE_WORDS, file + ' 仍含模板词');
  }
  for (const [name, text] of Object.entries(readmeSections)) {
    assert.doesNotMatch(text, TEMPLATE_WORDS, name + ' 仍含模板词');
  }
  assert.doesNotMatch(design.slice(design.indexOf('### 4.8 人机交互'), design.indexOf('### 4.9')), TEMPLATE_WORDS);
  assert.doesNotMatch(read('lib/agent/tools.js'), /three-question/, 'tools 不含 three-question');
});

test('阈值只在配置表：提示面不写死默认百分比', () => {
  const surfaces = {
    protocol: [REDLINE_PROTOCOL_TEXT, PHASE_PROTOCOL_TEXT, PROTOCOL_TEXT].join('\n'),
    tools: read('lib/agent/tools.js'),
    'context-relay skill': read('skills/context-relay/SKILL.md'),
    'human-loop skill': read('skills/human-loop/SKILL.md'),
    'DESIGN 4.1': section(design, '### 4.1 上下文度量与预算', '### 4.2'),
    'DESIGN 4.8': section(design, '### 4.8 人机交互', '### 4.9'),
    ...readmeSections,
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.doesNotMatch(text, /默认\s*(30|35|45|55)%/, name + ' 写死了默认阈值');
  }
  for (const [name, text] of Object.entries(readmeSections)) {
    assert.doesNotMatch(text, /\b(30|35|45|55)%/, name + ' 交互段仍出现绝对百分比');
  }
});

test('决策卡指针：架构师七字段齐全，README 交互段不枚举字段', () => {
  for (const field of ['七字段', '问题', '选项 A/B', '各自影响面', '收益/风险', '推荐', '默认', '不选会怎样']) {
    assert.ok(ARCHITECT_WORKER_PROTOCOL_TEXT.includes(field), 'ARCHITECT_WORKER 缺: ' + field);
  }
  assert.doesNotMatch(readmeSections['README 汇报与提问'], /选项 A\/B/, 'README zh 用指针而非枚举');
  assert.doesNotMatch(readmeSections['README.en Reports'], /options A\/B/i, 'README en 用指针而非枚举');
});

test('handoff 尾：不枚举禁词，指向 §用户语域', () => {
  const line = read('lib/agent/handoff.js').split('\n').find((source) => source.includes('const firstTail =')) ?? '';
  assert.match(line, /§用户语域/);
  assert.doesNotMatch(line, /band=\/verdict\/relay_/);
});

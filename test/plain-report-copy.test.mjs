/**
 * v0.13 fix5 探针：四段改三问统一 + 内部段「原文数据，可引用但要讲清楚」。
 * 覆盖协议/SKILL/human-loop 文案与 tools.js 的 report schema/拒绝文案残留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROTOCOL_TEXT, ROUTER_PROTOCOL_TEXT, TEAMMATE_PROTOCOL_TEXT } from '../lib/agent/protocol.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('三问统一：protocol / SKILL / human-loop 不再要求四段汇报', () => {
  assert.match(PROTOCOL_TEXT, /汇报默认三问/);
  assert.match(ROUTER_PROTOCOL_TEXT, /默认三问/);
  assert.match(TEAMMATE_PROTOCOL_TEXT, /默认三问/);
  assert.doesNotMatch(TEAMMATE_PROTOCOL_TEXT, /汇报正文用四段式/);
  const skill = read('skills/context-relay/SKILL.md');
  assert.match(skill, /用户汇报规范（默认三问/);
  assert.match(skill, /原文数据，可引用但要讲清楚/);
  assert.match(skill, /status\/phase 保留用户段/);
  const humanLoop = read('skills/human-loop/SKILL.md');
  assert.match(humanLoop, /给用户看的内容默认三问/);
  assert.match(humanLoop, /你看到什么/);
  assert.doesNotMatch(humanLoop, /永远先给\*\*结论与影响\*\*/);
});

test('tools.js：report schema/拒绝文案/T1 提示已改三问（旧四段描述清零）', () => {
  const source = read('lib/agent/tools.js');
  assert.doesNotMatch(source, /四段式大白话汇报/);
  assert.doesNotMatch(source, /（四段汇报）/);
  assert.match(source, /默认三问大白话汇报/);
});

test('内部段标签：原文数据可引用但要讲清楚（不再写不要转述）', () => {
  const skill = read('skills/context-relay/SKILL.md');
  assert.match(skill, /原文数据，可引用但要讲清楚/);
  assert.doesNotMatch(skill, /不要转述给用户/);
});

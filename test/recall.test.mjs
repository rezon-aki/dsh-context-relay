import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_RECALL_HEADER, buildManualRecallSection, collectShadowedContext,
} from '../lib/agent/recall.js';

/** 最小会话替身：只提供 recall 用到的 snapshotEvents / surface。 */
function fakeSession(events, surfaceNodes) {
  return {
    id: 'session-recall',
    seq: events.length,
    snapshotEvents: () => events,
    ...(surfaceNodes === undefined ? {} : { surface: { nodes: surfaceNodes } }),
  };
}

function instructionEvent(seq, paths, { baseline = false, action = 'set' } = {}) {
  return {
    seq,
    type: 'user/message',
    data: {
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        ...(baseline ? { baseline: true } : {}),
        changes: paths.map((path) => ({ action, scope: 'scope:' + path, path })),
      },
      content: [{ type: 'text', text: '<system-reminder>instructions</system-reminder>' }],
    },
  };
}

function skillInvocationEvent(seq, name) {
  return {
    seq,
    type: 'user/message',
    data: {
      source: { kind: 'skill-invocation', form: 'instructions', name },
      content: [{ type: 'text', text: '<skill_content name="' + name + '">…' }],
    },
  };
}

function skillPtcDispatchEvent(seq, name) {
  return {
    seq,
    type: 'tool/ptc-dispatch',
    data: { name: 'skill', isError: false, content: [{ type: 'text', text: '<skill_content name="' + name + '">\n<skill_resources>…' }] },
  };
}

function skillResultEvent(seq, name) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        role: 'tool',
        content: [{ type: 'text', text: '<skill_content name="' + name + '">\n<skill_resources>…' }],
      },
    },
  };
}

test('collects additional AGENTS.md scopes and loaded skills, newest first', () => {
  const events = [
    instructionEvent(1, ['pkg-a/AGENTS.md']),
    instructionEvent(2, ['pkg-b/AGENTS.md']),
    skillInvocationEvent(3, 'code-review'),
    skillResultEvent(4, 'tdd'),
    skillPtcDispatchEvent(5, 'browser-skill'),
  ];
  const collected = collectShadowedContext(fakeSession(events));
  assert.deepEqual(collected.instructions, ['pkg-b/AGENTS.md', 'pkg-a/AGENTS.md']);
  assert.deepEqual(collected.skills, ['browser-skill', 'tdd', 'code-review']);
  assert.deepEqual(collected.omitted, { instructions: 0, skills: 0 });
});

test('skips baseline instructions, removals, duplicate scopes and unreadable events', () => {
  const events = [
    instructionEvent(1, ['pkg/AGENTS.md']),
    instructionEvent(2, ['pkg/AGENTS.md']),
    instructionEvent(3, ['pkg/AGENTS.md'], { baseline: true }),
    instructionEvent(4, ['gone/AGENTS.md'], { action: 'remove' }),
    { seq: 5, type: 'user/message', data: { source: { kind: 'skill-invocation', name: '' }, content: [] } },
    { seq: 6, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'not a skill' }] } } },
    { seq: 7, type: 'assistant/message', data: {} },
  ];
  const collected = collectShadowedContext(fakeSession(events));
  assert.deepEqual(collected.instructions, ['pkg/AGENTS.md']);
  assert.deepEqual(collected.skills, []);
});

test('skips entries still visible on the current surface', () => {
  const events = [
    instructionEvent(1, ['visible/AGENTS.md']),
    instructionEvent(2, ['shadowed/AGENTS.md']),
    skillResultEvent(3, 'visible-skill'),
    skillResultEvent(4, 'shadowed-skill'),
  ];
  // seq 1/3 仍在压缩后的 retained tail 上：可见的不需要召回。
  const collected = collectShadowedContext(fakeSession(events, [1, 3]));
  assert.deepEqual(collected.instructions, ['shadowed/AGENTS.md']);
  assert.deepEqual(collected.skills, ['shadowed-skill']);
});

test('caps each list and reports the omitted counts', () => {
  const events = [];
  for (let index = 1; index <= 12; index += 1) events.push(instructionEvent(index, ['pkg-' + index + '/AGENTS.md']));
  for (let index = 13; index <= 24; index += 1) events.push(skillResultEvent(index, 'skill-' + index));
  const collected = collectShadowedContext(fakeSession(events), { maxItems: 3 });
  assert.deepEqual(collected.instructions, ['pkg-12/AGENTS.md', 'pkg-11/AGENTS.md', 'pkg-10/AGENTS.md']);
  assert.deepEqual(collected.skills, ['skill-24', 'skill-23', 'skill-22']);
  assert.deepEqual(collected.omitted, { instructions: 9, skills: 9 });
});

test('renders a bounded section with retrieval hints; empty when nothing was shadowed', () => {
  const empty = buildManualRecallSection({ session: fakeSession([]) });
  assert.equal(empty, '');
  const section = buildManualRecallSection({
    session: fakeSession([
      instructionEvent(1, ['pkg/AGENTS.md']),
      skillInvocationEvent(2, 'code-review'),
    ]),
  });
  assert.ok(section.startsWith(MANUAL_RECALL_HEADER));
  assert.match(section, /pkg\/AGENTS\.md/);
  assert.match(section, /code-review/);
  assert.match(section, /read 重新读取/);
  assert.match(section, /skill\(\{name\}\)/);
  assert.ok(section.length <= 900);

  const bounded = buildManualRecallSection({
    session: fakeSession([instructionEvent(1, ['x'.repeat(400) + '/AGENTS.md'])]),
  });
  assert.ok(bounded.length <= 900, 'section stays bounded');
});

test('is tolerant of malformed or hostile sessions', () => {
  assert.equal(buildManualRecallSection({ session: undefined }), '');
  assert.equal(buildManualRecallSection({ session: {} }), '');
  const throwing = { snapshotEvents() { throw new Error('boom'); } };
  assert.equal(buildManualRecallSection({ session: throwing }), '');
  const badEvents = {
    snapshotEvents: () => [null, { type: 'user/message' }, { type: 'user/message', data: { source: null } }, { type: 'tool/result', data: null }],
  };
  assert.equal(buildManualRecallSection({ session: badEvents }), '');
});

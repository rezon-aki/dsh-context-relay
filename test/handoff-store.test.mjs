import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_STORE_LIMIT, recordHandoff, listHandoffs } from '../lib/handoff-store.js';

const BOX = Symbol.for('dsh-context-relay.handoffs');
const resetBox = () => { delete globalThis[BOX]; };
/** 复合 id 形如 `<ms时间戳>-<seq>`。 */
const parseId = (id) => {
  const match = /^(\d{10,})-(\d+)$/.exec(String(id));
  assert.ok(match !== null, 'handoff id 必须是 <ms>-<seq>：' + String(id));
  return [Number(match[1]), Number(match[2])];
};

test('发布箱：记录后 list 最新在前、空箱为空、id 为单调复合 id', () => {
  resetBox();
  assert.deepEqual(listHandoffs(), []); // 进程内尚未记录
  const first = recordHandoff({ sessionId: 's-0' });
  const second = recordHandoff({ sessionId: 's-1', parentSessionId: 'p-1', title: 'T', phase: 'build', goal: 'G', summary: 'S' });
  const [firstTs, firstSeq] = parseId(first);
  const [secondTs, secondSeq] = parseId(second);
  // 严格单调：同一毫秒内 seq 递增、时间戳前缀不倒退；跨毫秒时间戳前进。
  assert.ok(secondTs > firstTs || (secondTs === firstTs && secondSeq === firstSeq + 1));
  assert.ok(secondTs >= firstTs);
  assert.equal(secondSeq, firstSeq + 1);
  const items = listHandoffs();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, second);
  assert.equal(items[0].sessionId, 's-1');
  assert.equal(items[0].parentSessionId, 'p-1');
  assert.equal(items[0].phase, 'build');
  assert.equal(typeof items[0].createdAt, 'number');
  // 发布箱保留多条：最新在前，旧记录仍可见（client 逐条消费，跨会话提示不互相覆盖）
  assert.equal(items[1].id, first);
  recordHandoff({ sessionId: 's-2' });
  assert.equal(listHandoffs().length, 3);
  assert.equal(listHandoffs()[0].sessionId, 's-2');
});

test('发布箱：保留最近 8 条，createdAt 倒序（最新在前），更旧的被淘汰', () => {
  resetBox();
  for (let i = 0; i < 12; i += 1) recordHandoff({ sessionId: 's-' + i });
  const items = listHandoffs();
  assert.equal(HANDOFF_STORE_LIMIT, 8);
  assert.equal(items.length, HANDOFF_STORE_LIMIT);
  assert.deepEqual(items.map((item) => item.sessionId), Array.from({ length: 8 }, (_, i) => 's-' + (11 - i)));
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i - 1].createdAt >= items[i].createdAt, 'createdAt 必须倒序');
  }
});

test('发布箱：旧单条形态热重载后迁移为 1 条且 id 继续单调', () => {
  resetBox();
  globalThis[BOX] = {
    seq: 3,
    lastIdTs: 123,
    latest: { id: '123-3', sessionId: 'legacy', parentSessionId: '', title: 't', phase: 'build', goal: 'g', summary: 's', createdAt: 1 },
  };
  const items = listHandoffs();
  assert.equal(items.length, 1);
  assert.equal(items[0].sessionId, 'legacy');
  const id = recordHandoff({ sessionId: 'new' });
  const [ts, seq] = parseId(id);
  assert.equal(seq, 4, '迁移保留旧 seq');
  assert.ok(ts > 123, '迁移保留旧 lastIdTs 单调水位');
  assert.equal(listHandoffs()[0].sessionId, 'new');
  assert.equal(listHandoffs().length, 2);
});

test('发布箱：跨进程（发布箱重置后）id 不早于旧 id 且 seq 重新从 1 起', async () => {
  resetBox();
  const before = recordHandoff({ sessionId: 'old-process' });
  const [beforeTs] = parseId(before);
  await new Promise((resolve) => setTimeout(resolve, 5)); // 模拟进程重启的时间差
  resetBox(); // 进程重启 = globalThis 发布箱清空（模块是多实例也不影响）
  const after = recordHandoff({ sessionId: 'new-process' });
  const [afterTs, afterSeq] = parseId(after);
  assert.ok(afterTs > beforeTs, '新进程 id 时间戳前缀必须大于旧进程（大于 ' + beforeTs + '）：' + afterTs);
  assert.equal(afterSeq, 1, '新进程 seq 从 1 重新开始');
  // 旧实现 seq 复位后会与旧 id 等值（"1" === "1"）导致 client 静默吞掉新 handoff；复合 id 不会。
  assert.notEqual(after, before);
});

test('发布箱：字段截断且返回快照不被外部修改', () => {
  resetBox();
  recordHandoff({
    sessionId: 'S'.repeat(300),
    parentSessionId: 'P'.repeat(300),
    title: 'T'.repeat(200),
    phase: 'b'.repeat(40),
    goal: 'G'.repeat(200),
    summary: 'X'.repeat(500),
  });
  const [item] = listHandoffs();
  assert.equal(item.sessionId.length, 200);
  assert.equal(item.parentSessionId.length, 200);
  assert.equal(item.title.length, 120);
  assert.equal(item.phase.length, 20);
  assert.equal(item.goal.length, 120);
  assert.equal(item.summary.length, 200);
  item.title = 'mutated';
  assert.notEqual(listHandoffs()[0].title, 'mutated');
});

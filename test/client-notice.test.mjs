import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// lib/client.js 是浏览器 bundle（window.__ModuleLoader__ 格式）：用最小 React/DOM 桩
// 在 vm 里加载，只验证「dock 提示的会话归属」这一条真实浏览器语义。
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type(props ?? {});
      return { type, props: props ?? {}, children };
    },
    useReducer(_reducer, initial) { return [initial, () => {}]; },
    useEffect(effect) { effect(); return () => {}; },
  };
}

function loadClient(initialHandoffs = []) {
  const client = { component: null, visibility: [], exports: null, handoffs: initialHandoffs };
  const sandbox = {
    Date, Promise, Number, console,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, handoffs: client.handoffs }) }),
    document: {
      visibilityState: 'visible',
      addEventListener: (_name, fn) => { client.visibility.push(fn); },
      removeEventListener: () => {},
    },
    window: { __ModuleLoader__: { load: ({ factory }) => { client.exports = factory(() => fakeReact()); } } },
  };
  runInNewContext(source, sandbox);
  return client;
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function start(initialHandoffs = []) {
  const client = loadClient(initialHandoffs);
  client.exports.apply({
    slots: { inject: (_name, fn) => fn(), register: (_def, component) => { client.component = component; } },
    sessions: { refresh: () => Promise.resolve() },
    uiWorkspace: { openSession: () => {} },
    effect: (fn) => { fn(); return () => {}; },
  });
  return client;
}

function renderedText(tree) {
  return JSON.stringify(tree ?? null);
}

/** 递归找按钮（fake React 的树是普通对象：{type, props, children}）。 */
function findButton(tree, label) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return undefined;
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const found = findButton(item, label);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (tree.type === 'button' && Array.isArray(tree.children) && tree.children.includes(label)) return tree;
  for (const child of tree.children ?? []) {
    const found = findButton(child, label);
    if (found !== undefined) return found;
  }
  return undefined;
}

const handoff = (overrides = {}) => ({
  id: '1700000000000-1',
  createdAt: Date.now(),
  sessionId: 'session-new',
  parentSessionId: 'session-old',
  title: 'Relay · 测试',
  goal: '验证 dock 提示',
  ...overrides,
});

test('dock notice renders only in the session that created the handoff', async () => {
  const client = start([handoff()]);
  await flush();
  const own = client.component({ session: { sessionId: 'session-old' } });
  assert.equal(own.type, 'div');
  assert.match(renderedText(own), /接力完成，新会话已创建/);
  assert.equal(client.component({ session: { sessionId: 'session-new' } }), null);
  assert.equal(client.component({ session: { sessionId: 'session-other' } }), null);
});

test('dock notice without parentSessionId never renders anywhere', async () => {
  const client = start([handoff({ parentSessionId: '' })]);
  await flush();
  assert.equal(client.component({ session: { sessionId: '' } }), null);
  assert.equal(client.component({ session: { sessionId: 'session-old' } }), null);
  assert.equal(client.component({ session: { sessionId: 'session-other' } }), null);
});

test('multi-handoff 发布箱逐条消费：关闭一条后提示下一条（P3 发布箱多条，兼容最近 8 条）', async () => {
  const now = Date.now();
  const older = handoff({ id: '1700000000000-1', createdAt: now - 1000, title: '旧接力', goal: '旧目标' });
  const newer = handoff({ id: '1700000000001-2', createdAt: now, title: '新接力', goal: '新目标' });
  // 发布箱最新在前；逐条消费应从旧到新提示，不互相覆盖
  const client = start([newer, older]);
  await flush();
  const first = client.component({ session: { sessionId: 'session-old' } });
  assert.match(renderedText(first), /「旧接力」/);
  const closeFirst = findButton(first, '关闭');
  assert.ok(closeFirst, '提示条应有关闭按钮');
  closeFirst.props.onClick();
  const second = client.component({ session: { sessionId: 'session-old' } });
  assert.match(renderedText(second), /「新接力」/);
  findButton(second, '关闭').props.onClick();
  assert.equal(client.component({ session: { sessionId: 'session-old' } }), null);
});

test('dock notice is not re-created when already viewing the new session', async () => {
  const client = start([]);
  client.component({ session: { sessionId: 'session-new' } });
  client.handoffs = [handoff()];
  client.visibility[0]();
  await flush();
  assert.equal(client.component({ session: { sessionId: 'session-new' } }), null);
  assert.equal(client.component({ session: { sessionId: 'session-old' } }), null);
});

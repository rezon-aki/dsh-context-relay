import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// lib/client.js 是浏览器 bundle（window.__ModuleLoader__ 格式）：用迷你 React hooks 运行时 + DOM/fetch 桩
// 在 vm 里驱动真实 bundle，验证 composer 面板（RelayPanel）与侧栏设置卡（RelaySettings）的交互语义。
// 覆盖：B-P2-13 会话切换重置 popover、B-P2-15 授权文案权威句、B-P2-10 persisted:false 提示、
// P3 live stale/缺失时渲染中性降级 chip（不显示旧值）、多 handoff 逐条消费（配合 client-notice 的 dock 提示）。
// v0.2.14：popover「下一个接力新会话」二态滑动开关（role=switch / aria-checked / 显式 preset 写入 / 动效 CSS 契约）。
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** 迷你 React：足够驱动 RelayPanel（useState/useReducer/useRef/useCallback/useEffect + deps/cleanup）。 */
function createReactRuntime() {
  let active = null;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useReducer(reducer, initial) {
      const instance = active;
      const index = instance.cursor++;
      if (instance.hooks[index] === undefined) instance.hooks[index] = { value: initial };
      const slot = instance.hooks[index];
      return [slot.value, (action) => { slot.value = reducer(slot.value, action); instance.dirty = true; }];
    },
    useState(initial) {
      const instance = active;
      const index = instance.cursor++;
      if (instance.hooks[index] === undefined) instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = instance.hooks[index];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; instance.dirty = true; }];
    },
    useRef(initial) {
      const instance = active;
      const index = instance.cursor++;
      if (instance.hooks[index] === undefined) instance.hooks[index] = { ref: { current: initial } };
      return instance.hooks[index].ref;
    },
    useCallback(fn, deps) {
      const instance = active;
      const index = instance.cursor++;
      const slot = instance.hooks[index];
      if (slot === undefined || !sameDeps(slot.deps, deps)) { instance.hooks[index] = { fn, deps }; return fn; }
      return slot.fn;
    },
    useEffect(fn, deps) {
      const instance = active;
      const index = instance.cursor++;
      instance.pendingEffects.push({ index, fn, deps });
    },
  };

  function mount(component, props) {
    const instance = { component, props, hooks: [], cursor: 0, pendingEffects: [], dirty: true, tree: null, renders: 0 };
    const renderNow = () => {
      const previous = active;
      active = instance;
      instance.cursor = 0;
      instance.pendingEffects = [];
      instance.dirty = false;
      try { instance.tree = component(instance.props); } finally { active = previous; }
      instance.renders += 1;
      for (const effect of instance.pendingEffects) {
        const slot = instance.hooks[effect.index];
        if (slot !== undefined && slot.ran === true && sameDeps(slot.deps, effect.deps)) continue;
        if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
        const cleanup = effect.fn();
        instance.hooks[effect.index] = { ran: true, cleanup: typeof cleanup === 'function' ? cleanup : undefined, deps: effect.deps };
      }
    };
    instance.render = (nextProps) => { instance.props = { ...instance.props, ...(nextProps ?? {}) }; renderNow(); };
    // 等异步 fetch 链路落定；期间 setState 标记 dirty 则重渲染，最多 20 轮。
    instance.flush = async () => {
      for (let round = 0; round < 20; round += 1) {
        for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
        if (!instance.dirty) return;
        renderNow();
      }
    };
    renderNow();
    return instance;
  }

  return { React, mount };
}

const PANEL_DEFAULT = Object.freeze({
  defaultOperation: null,
  autoChoose: false,
  autoCompress: false,
  autoHandoff: false,
  handedOff: false,
  authorizeNext: false,
  autoDecision: null,
  // v0.3.3：模型推荐（relay_recommend 提交；只做面板高亮/参考，不改预设）
  recommendedOperation: null,
  recommendedReason: '',
  recommendedAt: null,
  // v0.2.7：composer「预算无上限」胶囊 / v0.2.8：chip「新会话注入『预算无上限』」开关
  unlimitedBudget: true,
  handoffUnlimitedBudget: null,
});
const LIVE = (overrides = {}) => ({ band: 'organize', used: 410000, window: 1000000, ratio: 0.41, phase: 'build', organizeCount: 1, overBudget: true, updatedAt: Date.now(), ...overrides });
const SETTINGS_DEFAULT = Object.freeze({ threshold: 40, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true });

function createEnv() {
  const timers = new Map();
  let nextTimer = 1;
  const listeners = { document: new Map(), window: new Map() };
  const add = (store) => (name, fn) => { const set = store.get(name) ?? new Set(); set.add(fn); store.set(name, set); };
  const remove = (store) => (name, fn) => { store.get(name)?.delete(fn); };
  const calls = [];
  const server = { panel: {}, settings: { ...SETTINGS_DEFAULT }, handoffs: [], panelPutResponse: null, settingsPutResponse: null, deferPanelGet: false, pendingPanelGets: [] };
  const respond = (data) => Promise.resolve({ status: 200, json: () => Promise.resolve(data) });
  const fakeFetch = (url, options = {}) => {
    const method = options?.method ?? 'GET';
    calls.push({ url, method, body: options?.body });
    if (url === '/context-relay/api') return respond({ ok: true, handoffs: server.handoffs });
    if (url === '/context-relay/settings') {
      if (method === 'PUT') return respond(server.settingsPutResponse ?? { ok: true, persisted: true, settings: server.settings });
      return respond({ ok: true, settings: server.settings, thresholds: {} });
    }
    if (url === '/context-relay/panel') {
      if (method === 'PUT') {
        if (server.panelPutResponse !== null) return respond(server.panelPutResponse);
        // 默认行为与 host 一致：写入后返回合并后的面板（测试可覆盖 panelPutResponse 模拟失败/持久化降级）。
        const patch = JSON.parse(String(options?.body ?? '{}'));
        const sessionId = patch.sessionId;
        const entry = server.panel[sessionId] ?? (server.panel[sessionId] = { panel: { ...PANEL_DEFAULT }, live: LIVE() });
        const { sessionId: _ignored, ...fields } = patch;
        entry.panel = { ...(entry.panel ?? PANEL_DEFAULT), ...fields };
        return respond({ ok: true, persisted: true, panel: entry.panel });
      }
      return respond({ ok: true });
    }
    if (url.startsWith('/context-relay/panel?')) {
      const sessionId = decodeURIComponent(url.slice(url.indexOf('sessionId=') + 'sessionId='.length));
      const entry = server.panel[sessionId] ?? { panel: null, live: null };
      const payload = { ok: true, sessionId, relay: entry.relay === true, ...entry, thresholds: {}, settings: { threshold: server.settings.threshold } };
      // 可挂起 GET：验证「慢 GET 不回滚刚点状态」需要控制回包时机。
      if (server.deferPanelGet === true) return new Promise((resolve) => { server.pendingPanelGets.push({ resolve, payload }); });
      return respond(payload);
    }
    return respond({ ok: false });
  };

  const requireStub = (name) => {
    if (name === 'react') return runtime.React;
    if (name === 'react-dom') return { createPortal: (node) => node };
    throw new Error('unknown client module: ' + name);
  };
  const captured = { exports: null };
  const fakeWindow = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener: add(listeners.window), removeEventListener: remove(listeners.window),
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame: () => {},
    __ModuleLoader__: { load: ({ factory }) => { captured.exports = factory(requireStub); } },
  };
  const fakeDocument = {
    visibilityState: 'visible', body: { tag: 'body' }, head: { appendChild: () => {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    addEventListener: add(listeners.document), removeEventListener: remove(listeners.document),
  };
  const sandbox = {
    Date, Promise, Number, Math, JSON, String, Object, Array, Error, console,
    setTimeout, clearTimeout,
    setInterval: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval: (id) => { timers.delete(id); },
    fetch: fakeFetch,
    document: fakeDocument,
    window: fakeWindow,
  };
  sandbox.globalThis = sandbox;
  const runtime = createReactRuntime();
  runInNewContext(source, sandbox);
  const client = captured.exports;
  const slots = {};
  client.apply({
    slots: { inject: (_name, fn) => fn(), register: (definition, component) => { slots[definition.name] = component; } },
    sessions: { refresh: () => Promise.resolve() },
    uiWorkspace: { openSession: () => {} },
    effect: (fn) => { fn(); return () => {}; },
  });
  const pollAll = () => { for (const fn of [...timers.values()]) fn(); };
  const resolvePendingPanelGets = (payload) => {
    const pending = server.pendingPanelGets.splice(0);
    for (const item of pending) item.resolve({ status: 200, json: () => Promise.resolve(payload ?? item.payload) });
  };
  return { slots, server, calls, mount: runtime.mount, pollAll, resolvePendingPanelGets };
}

/** 递归找节点（fake React 树：{type, props, children}）。 */
function find(tree, predicate, out = []) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) { for (const item of tree) find(item, predicate, out); return out; }
  if (typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  for (const child of tree.children ?? []) find(child, predicate, out);
  return out;
}
const byClass = (tree, className) => find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes(className));
const textOf = (tree) => JSON.stringify(tree ?? null);

/** 打开 popover（点 chip）并等渲染稳定。 */
async function openPopover(instance) {
  const chip = byClass(instance.tree, 'relay-v3-chip')[0];
  assert.ok(chip, '需要 chip 才能打开 popover');
  chip.props.onClick();
  await instance.flush();
  return byClass(instance.tree, 'relay-v3-popover')[0];
}

test('RelayPanel：会话切换重置 popover 展开态与 layout（B-P2-13，宿主复用组件实例）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: 'compress-then-handoff' }, live: LIVE({ band: 'organize' }) };
  env.server.panel.B = { relay: true, panel: { ...PANEL_DEFAULT, autoChoose: true }, live: LIVE({ band: 'ok', overBudget: false, ratio: 0.12 }) };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-chip').length, 1);
  assert.equal(byClass(instance.tree, 'relay-v3-popover').length, 0);
  // 打开 A 的 popover
  const popover = await openPopover(instance);
  assert.ok(popover);
  assert.equal(byClass(instance.tree, 'relay-v3-chip')[0].props['aria-expanded'], true);
  // 切到会话 B（组件实例被复用）→ 不得自动重开 popover，也不得沿用 A 的 layout
  instance.render({ sessionId: 'B' });
  await instance.flush();
  const chips = byClass(instance.tree, 'relay-v3-chip');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].props['aria-expanded'], false, '切换会话后 chip 必须收起');
  assert.equal(byClass(instance.tree, 'relay-v3-popover').length, 0, '切换会话后 popover 不得自动重开');
  assert.equal(env.calls.some((call) => call.url.includes('sessionId=B')), true, '切会话后应重新拉取 B 的面板数据');
});

test('RelayPanel：授权 hint/title 用权威句（B-P2-15：不再写「本次免审批」「接力/二次压缩」）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: 'handoff' }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  const popover = await openPopover(instance);
  assert.ok(popover);
  // 选项 hint：接力选项明确「预设只决定做什么，不免审批」
  const optionTitles = byClass(instance.tree, 'relay-v3-order').map((node) => String(node.props.title));
  const handoffOption = optionTitles.find((title) => title.includes('接力新会话'));
  assert.ok(handoffOption, '应有「接力新会话」选项');
  assert.match(handoffOption, /预设只决定做什么/);
  assert.match(handoffOption, /免审看 autoHandoff\/授权下一次/);
  assert.ok(!handoffOption.includes('本次免审批'));
  // 授权按钮 title：免审只来自 authorizeNext（一次性，操作成功后消费），不写旧的「接力/二次压缩」
  const auth = byClass(instance.tree, 'relay-v3-auth')[0];
  assert.ok(auth);
  assert.match(String(auth.props.title), /下一次 relay 操作仍需官方审批/);
  assert.match(String(auth.props.title), /操作成功后消费/);
  // popover 内可见权威句（单一真源）
  assert.match(textOf(popover), /一次性预设只决定「做什么」，不产生审批豁免；免审只来自 autoCompress \/ autoHandoff \/ authorizeNext（一次性，操作成功后消费）。/);
  // 整个 bundle 不得再出现旧口径短语
  assert.equal(/本次免审批|视为已授权|pre-authorize|handoffPreAuthorized|接力\/二次压缩/.test(source), false, 'client bundle 不得再出现旧授权口径');
});

test('RelayPanel：host 上报 persisted:false 时提示未写入磁盘（B-P2-10）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT }, live: LIVE() };
  env.server.panelPutResponse = { ok: true, persisted: false, message: 'panel state not persisted to disk', panel: { ...PANEL_DEFAULT, autoCompress: true } };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  await openPopover(instance);
  const switches = byClass(instance.tree, 'relay-v3-tank');
  assert.ok(switches.length >= 1);
  switches[0].props.onClick(); // 切换 autoCompress → PUT
  await instance.flush();
  const rendered = textOf(instance.tree);
  assert.match(rendered, /已保存（仅本会话；未写入磁盘，重启后会丢失）/);
  const put = env.calls.find((call) => call.url === '/context-relay/panel' && call.method === 'PUT');
  assert.ok(put);
  assert.match(String(put.body), /"sessionId":"A"/);
});

test('RelayPanel：live 缺失（冷启动/未发布/stale）渲染中性降级 chip，不显示旧 band/「已到线」（P3 live TTL 语义保留）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT }, live: null };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  const chips = byClass(instance.tree, 'relay-v3-chip');
  assert.equal(chips.length, 1, 'live 缺失（宿主冷启动）时 chip 仍须渲染');
  const chipText = textOf(chips[0]);
  assert.match(chipText, /接力/);
  assert.match(chipText, /pct-\?/, '实时比例未知时显示 ?');
  assert.equal(chipText.includes('已到线'), false, '不得显示旧 band/「已到线」');
  assert.equal(String(chips[0].props.title).includes('band '), false, 'title 不得伪报 band');
  assert.match(String(chips[0].props.title), /实时状态暂不可得/);
  const popover = await openPopover(instance);
  assert.ok(popover, '中性态 chip 仍可展开面板（持久预设/授权可用）');
  assert.match(textOf(popover), /载入后自动刷新/);
});

test('RelayPanel：A 有 live 切到 B 无 live 不串数据（降级态保持中性）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT }, live: LIVE() };
  env.server.panel.B = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: 'continue' }, live: null };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-chip').length, 1);
  instance.render({ sessionId: 'B' });
  await instance.flush();
  const chips = byClass(instance.tree, 'relay-v3-chip');
  assert.equal(chips.length, 1, 'B 无 live 也必须渲染 chip（但为中性态）');
  const text = textOf(instance.tree);
  assert.equal(text.includes('已到线'), false, 'B 不得继承 A 的「已到线」');
  assert.equal(text.includes('pct-41'), false, 'B 不得继承 A 的 41%');
  assert.match(text, /pct-\?/, 'B 的比例未知，应为 ?');
  assert.match(text, /继续/, 'B 的下一次操作仍来自 B 的持久 panel 状态');
});

test('RelaySettings：保存发送五字段（unlimitedBudget 已迁到 composer 小胶囊，不再由侧栏控制），写盘失败显示错误', async () => {
  const env = createEnv();
  env.server.settings = { threshold: 40, defaultOperation: 'handoff', autoChoose: false, autoCompress: true, autoHandoff: false, unlimitedBudget: false };
  const RelaySettings = env.slots['plugins.bundle.config'];
  const instance = env.mount(RelaySettings);
  await instance.flush();
  // 侧栏卡片不再渲染 unlimitedBudget 开关（迁移到 composer 模型选择器右侧小胶囊）
  assert.equal(textOf(instance.tree).includes('注入「你的 token 预算无上限」'), false);
  const save = find(instance.tree, (node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('保存'))[0];
  assert.ok(save, '设置卡应有保存按钮');
  save.props.onClick();
  await instance.flush();
  const put = env.calls.find((call) => call.url === '/context-relay/settings' && call.method === 'PUT');
  assert.ok(put);
  const body = JSON.parse(String(put.body));
  assert.deepEqual(Object.keys(body).sort(), ['autoChoose', 'autoCompress', 'autoHandoff', 'defaultOperation', 'threshold']);
  assert.equal(body.threshold, 40);
  assert.deepEqual(body, { threshold: 40, defaultOperation: 'handoff', autoChoose: false, autoCompress: true, autoHandoff: false });
  // 写盘失败（host 500 JSON）→ UI 显示错误而不是「已保存」
  env.server.settingsPutResponse = { ok: false, code: 'settings-persist-failed', persisted: false, message: 'settings.json write failed' };
  save.props.onClick();
  await instance.flush();
  assert.match(textOf(instance.tree), /settings\.json write failed/);
});

test('RelaySettings：侧栏不再提供 unlimitedBudget 开关（v0.2.7 迁移到 composer 小胶囊）', () => {
  assert.match(source, /conversation\.input\.right/);
  assert.match(source, /RelayBudgetToggle/);
  assert.equal(source.includes('toggleRow("默认：注入「你的 token 预算无上限」'), false);
});

test('RelayBudgetToggle：relay 会话渲染 chip 风格小胶囊，点击 PUT 切换本会话注入', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE() };
  const Component = env.slots['conversation.input.right'];
  const instance = env.mount(Component, { sessionId: 'A' });
  await instance.flush();
  const pills = byClass(instance.tree, 'relay-v3-chip');
  assert.equal(pills.length, 1, '渲染一个 chip 风格小胶囊');
  assert.equal(pills[0].props['aria-pressed'], true);
  assert.match(textOf(pills[0]), /预算无上限/);
  assert.equal(pills[0].props.style.order, 1, 'order:1 排到模型选择器（order:0）右侧（槽锚点 display:contents）');
  pills[0].props.onClick();
  await instance.flush();
  const put = env.calls.find((call) => call.url === '/context-relay/panel' && call.method === 'PUT');
  assert.ok(put);
  assert.deepEqual(JSON.parse(String(put.body)), { sessionId: 'A', unlimitedBudget: false });
  assert.equal(byClass(instance.tree, 'relay-v3-chip')[0].props['aria-pressed'], false, '按 host 回读面板渲染关闭态');
});

test('RelayBudgetToggle：非 relay 会话不渲染（relay:false / 旧 host 无 relay 字段）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: false, panel: { ...PANEL_DEFAULT }, live: LIVE() };
  const Component = env.slots['conversation.input.right'];
  const instance = env.mount(Component, { sessionId: 'A' });
  await instance.flush();
  assert.equal(instance.tree, null);
  env.server.panel.B = { panel: { ...PANEL_DEFAULT }, live: LIVE() }; // 旧 host 无 relay 字段 → 同样不显示
  instance.render({ sessionId: 'B' });
  await instance.flush();
  assert.equal(instance.tree, null);
});

test('RelayBudgetToggle：PUT 失败回滚到原状态，title 带错误（不静默失败）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE() };
  env.server.panelPutResponse = { ok: false, message: 'panel.json write failed' };
  const Component = env.slots['conversation.input.right'];
  const instance = env.mount(Component, { sessionId: 'A' });
  await instance.flush();
  byClass(instance.tree, 'relay-v3-chip')[0].props.onClick();
  await instance.flush();
  const pill = byClass(instance.tree, 'relay-v3-chip')[0];
  assert.equal(pill.props['aria-pressed'], true, '失败回滚到原状态');
  assert.match(String(pill.props.title), /panel\.json write failed/);
  // 轮询成功（宿主可读）后清掉上一次保存失败的错误，title 不长期残留
  env.pollAll();
  await instance.flush();
  const afterPoll = byClass(instance.tree, 'relay-v3-chip')[0];
  assert.equal(String(afterPoll.props.title).includes('panel.json write failed'), false);
});

test('RelayBudgetToggle：persisted:false 时显式告警（不谎报已保存），下一次成功落盘后清除', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE() };
  env.server.panelPutResponse = { ok: true, persisted: false, panel: { ...PANEL_DEFAULT, unlimitedBudget: false } };
  const Component = env.slots['conversation.input.right'];
  const instance = env.mount(Component, { sessionId: 'A' });
  await instance.flush();
  byClass(instance.tree, 'relay-v3-chip')[0].props.onClick();
  await instance.flush();
  let pill = byClass(instance.tree, 'relay-v3-chip')[0];
  assert.match(String(pill.props.title), /未写入磁盘/);
  assert.match(textOf(instance.tree), /⚠/);
  // 下一次成功落盘 → 告警清除
  env.server.panelPutResponse = null;
  pill.props.onClick();
  await instance.flush();
  pill = byClass(instance.tree, 'relay-v3-chip')[0];
  assert.equal(String(pill.props.title).includes('未写入磁盘'), false);
  assert.equal(textOf(instance.tree).includes('⚠'), false);
});

test('RelayBudgetToggle：PUT 后发起更早的慢 GET 不得回滚刚点状态（写入优先 §3.6）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE() };
  const Component = env.slots['conversation.input.right'];
  const instance = env.mount(Component, { sessionId: 'A' });
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-chip')[0].props['aria-pressed'], true);
  // 先发起一个挂起的慢 GET（旧快照：开），再点击关闭（PUT 成功写入 false）
  env.server.deferPanelGet = true;
  env.pollAll();
  // 时间戳保护按 ms 比较：确保点击（写入时间）晚于慢 GET 的发起时间，避免同 ms 假阴性
  await new Promise((resolve) => setTimeout(resolve, 5));
  byClass(instance.tree, 'relay-v3-chip')[0].props.onClick();
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-chip')[0].props['aria-pressed'], false);
  // 慢 GET 的旧快照返回 → 必须被丢弃，不回滚
  env.resolvePendingPanelGets({ ok: true, sessionId: 'A', relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE() });
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-chip')[0].props['aria-pressed'], false, '旧 GET 不得回滚刚点状态');
});

test('RelayPanel：接力 chip 独角兽电路纹——平时只留纹路不发光（无红光/无火星）、到线才深红底+发光+火星；非 relay/关闭态不亮', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE({ overBudget: false }) };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  const chip = () => byClass(instance.tree, 'relay-v3-chip')[0];
  const sparksOf = (node) => byClass(node, 'relay-v3-unicorn-spark')
    .filter((child) => String(child.props.className).split(' ').includes('relay-v3-unicorn-spark'));
  assert.ok(chip(), '渲染接力 chip');
  const normalClass = String(chip().props.className);
  assert.match(normalClass, /relay-v3-chip-unicorn/, '预算无上限开启 → chip 亮独角兽样式类');
  assert.equal(normalClass.includes('relay-v3-chip-unicorn-glow'), false, '未到线：不挂红光/呼吸类（未到阈值不发光）');
  assert.match(String(chip().props.style.background), /data:image\/svg\+xml/, '纹路 = 内联电路式 SVG 图案（非平行斜线）');
  assert.equal(String(chip().props.style.background).endsWith(','), false, '未到线：background 列表不得有尾逗号（否则整条声明失效、电路纹消失）');
  assert.match(String(chip().props.style.background), /repeat-x,.*repeat-x$/, '未到线：两层电路纹都在（列表合法）');
  assert.equal(String(chip().props.style.background).includes('radial-gradient'), false, '未到线：无淡红微光（背景不发光）');
  assert.equal(String(chip().props.style.background).includes('repeating-linear-gradient'), false, '旧平行斜纹已移除');
  assert.equal(String(chip().props.style.background).includes('linear-gradient(rgba(20,0,8'), false, '未到线：不加暗红底');
  assert.equal(String(chip().props.style.background).includes('rgba(20,0,8'), false, '未到线：无任何近黑红垫层');
  assert.equal(String(chip().props.style.background).includes('rgba(120,0,22'), false, '未到线：无深红外缘');
  assert.equal(chip().props.style.color, 'inherit', '未到线：文字沿用主题色（深/浅主题都可读）');
  assert.equal(sparksOf(chip()).length, 0, '未到线：无火星');
  // 已到线（overBudget）→ 才压深红底 + 亮红文字
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE({ overBudget: true }) };
  env.pollAll();
  await instance.flush();
  const overChip = chip();
  assert.match(String(overChip.props.className), /relay-v3-chip-unicorn-glow/, '已到线：才挂红光/呼吸类');
  assert.match(String(overChip.props.style.background), /linear-gradient\(rgba\(20,0,8/, '已到线：压暗红底');
  assert.match(String(overChip.props.style.background), /rgba\(20,0,8,\.92\)/, '已到线：暗红外缘层');
  assert.equal(overChip.props.style.color, '#ffe3e9', '已到线：文字亮红');
  assert.equal(sparksOf(overChip).length, 3, '已到线：三颗红色火星');
  // 关闭预算无上限（宿主面板轮询回包）→ 独角兽纹路与火星消失、接力 chip 恢复原外观
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, unlimitedBudget: false }, live: LIVE({ overBudget: false }) };
  env.pollAll();
  await instance.flush();
  const plain = chip();
  assert.equal(String(plain.props.className).includes('relay-v3-chip-unicorn'), false, '关闭态无独角兽类');
  assert.equal(sparksOf(plain).length, 0, '关闭态无火星');
  assert.equal(String(plain.props.style.background).includes('data:image/svg+xml'), false, '恢复无纹路');
  // 非 relay 会话：接力 chip 整体不渲染（v0.2.31：非 relay 不出现 chip；不再是「亮不亮纹路」的问题）
  env.server.panel.A = { relay: false, panel: { ...PANEL_DEFAULT, unlimitedBudget: true }, live: LIVE({ overBudget: false }) };
  env.pollAll();
  await instance.flush();
  assert.equal(instance.tree, null, '非 relay 会话完全不渲染接力 chip');
});

test('RelayPanel：popover「新会话注入『预算无上限』」是开关（跟随本会话显示、点击写布尔、显式值优先）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, handoffUnlimitedBudget: null, unlimitedBudget: true }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const switchNow = () => byClass(byClass(instance.tree, 'relay-v3-popover')[0], 'relay-v3-tank')
    .find((node) => textOf(node).includes('新会话注入「预算无上限」'));
  assert.ok(switchNow(), 'popover 里是水缸按钮（relay-v3-tank，与其它两个开关同款）');
  assert.match(textOf(switchNow()), /新会话注入「预算无上限」/);
  assert.equal(switchNow().props['aria-pressed'], true, 'null=跟随本会话（本会话开）→ 显示开');
  const lastPut = () => JSON.parse(String(env.calls.filter((call) => call.method === 'PUT' && call.url === '/context-relay/panel').at(-1).body));
  switchNow().props.onClick();
  await instance.flush();
  assert.equal(switchNow().props['aria-pressed'], false);
  assert.deepEqual(lastPut(), { sessionId: 'A', handoffUnlimitedBudget: false });
  switchNow().props.onClick();
  await instance.flush();
  assert.equal(switchNow().props['aria-pressed'], true);
  assert.deepEqual(lastPut(), { sessionId: 'A', handoffUnlimitedBudget: true });
  // 显式 false 优先于本会话开；null 跟随本会话关
  env.server.panel.B = { relay: true, panel: { ...PANEL_DEFAULT, handoffUnlimitedBudget: false, unlimitedBudget: true }, live: LIVE() };
  instance.render({ sessionId: 'B' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const switchB = () => byClass(byClass(instance.tree, 'relay-v3-popover')[0], 'relay-v3-tank')
    .find((node) => textOf(node).includes('新会话注入「预算无上限」'));
  assert.equal(switchB().props['aria-pressed'], false, '显式不注入优先于本会话开');
  env.server.panel.C = { relay: true, panel: { ...PANEL_DEFAULT, handoffUnlimitedBudget: null, unlimitedBudget: false }, live: LIVE() };
  instance.render({ sessionId: 'C' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const switchC = () => byClass(byClass(instance.tree, 'relay-v3-popover')[0], 'relay-v3-tank')
    .find((node) => textOf(node).includes('新会话注入「预算无上限」'));
  assert.equal(switchC().props['aria-pressed'], false, 'null=跟随本会话（本会话关）→ 显示关');
});

test('RelayPanel：三个水缸行 = 纯 CSS 多元素注水（无 canvas）；「授权下一次操作」按钮 = canvas 水面引擎唯一挂载点', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, autoCompress: false, autoHandoff: true, handoffUnlimitedBudget: true }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const tankButtons = () => byClass(instance.tree, 'relay-v3-tank')
    .filter((node) => String(node.props.className).split(' ').includes('relay-v3-tank'));
  const tanks = tankButtons();
  assert.equal(tanks.length, 3, '三个水缸按钮（autoCompress / autoHandoff / 新会话注入预算无上限）');
  assert.equal(byClass(instance.tree, 'relay-v3-check').length, 0, '去掉勾选框');
  assert.match(String(tanks[0].props.className), /relay-v3-tank-blue/, '压缩自动授权=蓝');
  assert.match(String(tanks[1].props.className), /relay-v3-tank-green/, '新会话自动授权=绿');
  assert.match(String(tanks[2].props.className), /relay-v3-tank-sakura/, '新会话注入预算无上限=樱花红');
  assert.equal(tanks[0].props['aria-pressed'], false);
  assert.equal(tanks[1].props['aria-pressed'], true);
  assert.equal(tanks[2].props['aria-pressed'], true);
  assert.equal(String(tanks[1].props.className).includes('relay-v3-tank-on'), true, '开启态带 tank-on（注满水）');
  assert.equal(String(tanks[0].props.className).includes('relay-v3-tank-on'), false, '关闭态无 tank-on（已排空）');
  // v0.2.30：每行一个 aria-hidden 装饰层，里面是多件各自运动的水元素（纯 CSS transition，无 canvas/rAF）
  const arts = tanks.map((node) => byClass(node, 'relay-v3-tank-art'));
  assert.deepEqual(arts.map((list) => list.length), [1, 1, 1], '每行一个 aria-hidden 装饰层（button > 文字 + 装饰层）');
  assert.deepEqual(arts.map((list) => String(list[0].props['aria-hidden'])), ['true', 'true', 'true'], '装饰层对辅助技术隐藏');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-canvas').length), [0, 0, 0], '水缸行不再有 canvas（引擎已移走）');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-liquid').length), [1, 1, 0], '蓝/绿行有液体主体（升起）；新会话预算行改为电路纹');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-body').length), [1, 1, 0], '液体本体 ×1（SVG mask 浪形顶部）');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-crest').length), [1, 1, 0], '水面高光浪线 ×1');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-wave').length), [1, 1, 0], '动态水面波层 ×1（浪 = 水面本身）');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-veins').length), [0, 0, 1], '新会话预算行 = chip 同款独角兽电路纹 ×1');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-spark').filter((n) => String(n.props.className).split(' ').includes('relay-v3-tank-spark')).length), [0, 0, 3], '新会话预算行 = 3 颗火星');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-swell').length), [0, 0, 0], '没有横穿的独立涌浪块');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-jet').length), [0, 0, 0], '没有上冲的水舌（也是飞行物体）');
  assert.deepEqual(tanks.map((node) => byClass(node, 'relay-v3-tank-drop').length), [5, 5, 0], '飞溅液滴 ×5（仅水面行）');
  // 点击 → 与旧开关相同的 PUT 字段；回包后注水态翻转
  const tankNow = () => tankButtons()[0];
  tankNow().props.onClick();
  await instance.flush();
  const put = JSON.parse(String(env.calls.filter((call) => call.method === 'PUT' && call.url === '/context-relay/panel').at(-1).body));
  assert.deepEqual(put, { sessionId: 'A', autoCompress: true });
  assert.equal(String(tankButtons()[0].props.className).includes('relay-v3-tank-on'), true, '回包后注满');
  // v0.2.30：v0.2.29 的 canvas 水面引擎原样移到最下面「授权下一次操作」按钮（ref 用 tankWaterRef("green", authorized)）
  const auth = byClass(instance.tree, 'relay-v3-auth').find((node) => node.type === 'button');
  assert.ok(auth, '授权按钮存在');
  const authCanvases = byClass(auth, 'relay-v3-auth-canvas');
  assert.equal(authCanvases.length, 1, '按钮内 1 个 aria-hidden canvas（水面引擎挂载点）');
  assert.equal(String(authCanvases[0].props['aria-hidden']), 'true', 'canvas 对辅助技术隐藏');
  assert.equal(typeof authCanvases[0].props.ref, 'function', 'canvas ref = tankWaterRef 闭包接线');
  assert.equal(String(auth.props.className).includes('relay-v3-tank'), false, '授权按钮不是水缸行');
  assert.equal(auth.props['aria-pressed'], false, '未授权');
  assert.equal(byClass(auth, 'relay-v3-auth-text')[0].children[0], '授权下一次操作', '按钮文字不变');
  // 点击授权 → 写入字段不变；回包后 aria-pressed/文字/绿态翻转（canvas 由 React 重新挂 ref，引擎按 on 注水/排空）
  auth.props.onClick();
  await instance.flush();
  const putAuth = JSON.parse(String(env.calls.filter((call) => call.method === 'PUT' && call.url === '/context-relay/panel').at(-1).body));
  assert.deepEqual(putAuth, { sessionId: 'A', authorizeNext: true });
  const authNow = byClass(instance.tree, 'relay-v3-auth').find((node) => node.type === 'button');
  assert.equal(authNow.props['aria-pressed'], true, '已授权');
  assert.match(String(authNow.props.className), /relay-v3-auth-on/, '已授权带 auth-on（绿色 crossfade 目标态）');
  assert.equal(byClass(authNow, 'relay-v3-auth-text')[0].children[0], '✓ 已授权下一次操作', '按钮文字翻转');
});


// ── v0.2.14：下一个接力新会话的模式切换（二态滑动开关）────────────────────────
const MODES = Object.freeze({ relay: 'relay', long: 'relay-long' });
/** popover 里的滑动开关（优先按 role=switch 找，避免命中内部 track/label 类名）。 */
const slideOf = (instance) => find(instance.tree, (node) => node.props?.role === 'switch')[0];
const slideLabels = (instance) => find(instance.tree,
  (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('relay-v3-slide-label'));
const activeSlideLabel = (instance) => slideLabels(instance)
  .find((node) => String(node.props.className).includes('relay-v3-slide-label-on'));
const lastPanelPut = (env) => JSON.parse(String(env.calls
  .filter((call) => call.method === 'PUT' && call.url === '/context-relay/panel').at(-1).body));

test('RelayPanel：下一个接力新会话是二态滑动开关（role=switch，null 跟随本会话，点击写显式 preset 且回包生效）', async () => {
  const env = createEnv();
  env.server.panel.A = {
    relay: true, modes: MODES, preset: 'relay',
    panel: { ...PANEL_DEFAULT, handoffPreset: null }, live: LIVE(),
  };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  const popover = await openPopover(instance);
  assert.ok(popover);

  // 位置：操作选项之后、autoCompress/autoHandoff 开关之前
  const kids = popover.children;
  const modeIndex = kids.findIndex((node) => typeof node?.props?.className === 'string' && node.props.className.includes('relay-v3-mode'));
  const gridIndex = kids.findIndex((node) => typeof node?.props?.className === 'string' && node.props.className.includes('relay-v3-dial-wrap'));
  const firstSwitchIndex = kids.findIndex((node) => typeof node?.props?.className === 'string' && node.props.className.startsWith('relay-v3-tank'));
  assert.ok(gridIndex >= 0 && modeIndex > gridIndex, '模式开关在一次性操作选项之后');
  assert.ok(firstSwitchIndex > modeIndex, '模式开关在自动授权开关之前');

  // 小标题 + 组件契约
  assert.match(textOf(instance.tree), /下一个接力新会话/);
  assert.ok(slideOf(instance), '渲染 role=switch 的滑动开关');
  assert.equal(slideOf(instance).props['aria-label'], '下一个接力新会话模式');
  assert.equal(slideOf(instance).props['aria-checked'], false, 'null 跟随本会话（relay）→ 左端');
  assert.match(String(slideOf(instance).props.className), /relay-v3-slide-left/);
  assert.match(String(slideOf(instance).props.title), /默认跟随本会话（当前「Relay」）；切换后固定/);
  assert.equal(slideLabels(instance).length, 2, '左右两端各一个 label');
  assert.equal(activeSlideLabel(instance).children[0], 'Relay', '左端 label 高亮');

  // 点击 → 写对侧显式 id（relay-long）；回包后右侧生效
  slideOf(instance).props.onClick();
  await instance.flush();
  assert.deepEqual(lastPanelPut(env), { sessionId: 'A', handoffPreset: 'relay-long' });
  assert.equal(slideOf(instance).props['aria-checked'], true, '回包后 aria-checked=true');
  assert.match(String(slideOf(instance).props.className), /relay-v3-slide-right/);
  assert.equal(activeSlideLabel(instance).children[0], 'Relay · 超长任务', '右端 label 高亮');

  // 再点 → 切回 relay
  slideOf(instance).props.onClick();
  await instance.flush();
  assert.deepEqual(lastPanelPut(env), { sessionId: 'A', handoffPreset: 'relay' });
  assert.equal(slideOf(instance).props['aria-checked'], false);
});

test('RelayPanel：跟随本会话 relay-long 初始在右端；显式 handoffPreset 优先于本会话 preset', async () => {
  const env = createEnv();
  env.server.panel.A = {
    relay: true, modes: MODES, preset: 'relay-long',
    panel: { ...PANEL_DEFAULT, handoffPreset: null }, live: LIVE(),
  };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(slideOf(instance).props['aria-checked'], true, 'null 跟随本会话（relay-long）→ 右端');
  assert.match(String(slideOf(instance).props.className), /relay-v3-slide-right/);
  assert.match(String(slideOf(instance).props.title), /默认跟随本会话（当前「Relay · 超长任务」）/);
  slideOf(instance).props.onClick();
  await instance.flush();
  assert.deepEqual(lastPanelPut(env), { sessionId: 'A', handoffPreset: 'relay' });
  assert.equal(slideOf(instance).props['aria-checked'], false);

  // 显式值优先：本会话 relay-long，但已固定 relay → 左端
  env.server.panel.B = {
    relay: true, modes: MODES, preset: 'relay-long',
    panel: { ...PANEL_DEFAULT, handoffPreset: 'relay' }, live: LIVE(),
  };
  instance.render({ sessionId: 'B' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(slideOf(instance).props['aria-checked'], false, '显式 handoffPreset 优先');
  assert.match(String(slideOf(instance).props.title), /已固定为「Relay」/);
});

test('RelayPanel：旧 host 无 modes 时不渲染模式开关（relay 会话仍渲染 chip/表盘）', async () => {
  const env = createEnv();
  // 旧 host：relay=true 但不返回 modes → 保持历史行为（不出现空开关；表盘按 classic 6 档渲染）
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(slideOf(instance), undefined, '旧 host 无 modes 不渲染模式开关');
  assert.equal(dialOrders(instance).length, 6, '无 modes → 按 classic 6 档渲染（长模式判定不可得）');
});

test('RelayPanel：非 relay 会话完全不渲染接力 chip / popover（v0.2.31 用户需求：非 relay 不出现 chip）', async () => {
  const env = createEnv();
  const RelayPanel = env.slots['conversation.composer.dock'];
  // relay=false（明确非 relay preset）
  env.server.panel.A = { relay: false, modes: MODES, preset: 'other-preset', panel: { ...PANEL_DEFAULT }, live: LIVE() };
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.equal(instance.tree, null, 'relay=false：整个组件不渲染（无 chip、无 popover）');
  // 旧 host 无 relay 字段（undefined）→ 同样不渲染（gating 只认 relay===true）
  env.server.panel.B = { panel: { ...PANEL_DEFAULT }, live: LIVE() };
  instance.render({ sessionId: 'B' });
  await instance.flush();
  assert.equal(instance.tree, null, '旧 host 无 relay 字段：不渲染');
  // 同实例切回 relay 会话 → chip 出现（证明是数据 gating，不是组件失效）
  env.server.panel.C = { relay: true, panel: { ...PANEL_DEFAULT }, live: LIVE() };
  instance.render({ sessionId: 'C' });
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-chip').length, 1, 'relay=true 才出现 chip');
  assert.equal(env.calls.some((call) => call.url.includes('sessionId=A')), true, '非 relay 会话仍会拉取 panel GET（只隐藏 UI）');
});

test('CSS：模式开关动效契约（弹簧位移 / 双层渐变交叉 / 标签过渡 / hover 不碰 transform / reduced-motion 禁位移）', () => {
  // 固定尺寸 + transform 位移：切换不触发 layout
  assert.match(source, /\.relay-v3-slide-track\{[^}]*height:28px[^}]*overflow:hidden/);
  // thumb 弹簧：300ms cubic-bezier(.34,1.56,.64,1)；位移只走 transform
  assert.ok(source.includes('.relay-v3-slide-thumb{position:absolute'), 'thumb 绝对定位（不参与布局）');
  assert.ok(source.includes('transition:transform 300ms cubic-bezier(.34,1.56,.64,1)'), 'thumb 300ms 弹簧位移');
  assert.ok(source.includes('.relay-v3-slide-right .relay-v3-slide-thumb{transform:translateX(100%)}'), '右端位移');
  // 蓝 / 紫青双层渐变 fill 交叉渐变 260ms
  assert.ok(source.includes('.relay-v3-slide-fill{position:absolute'), '双层 fill 叠放');
  assert.ok(source.includes('.relay-v3-slide-fill-blue{') && source.includes('rgba(47,129,247'));
  assert.ok(source.includes('.relay-v3-slide-fill-long{') && source.includes('rgba(139,92,246'), '紫青渐变');
  assert.ok(source.includes('.relay-v3-slide-fill{position:absolute') && source.includes('transition:opacity 260ms ease'));
  assert.ok(source.includes('.relay-v3-slide-left .relay-v3-slide-fill-blue{opacity:1}'));
  assert.ok(source.includes('.relay-v3-slide-right .relay-v3-slide-fill-long{opacity:1}'));
  // label 220ms 透明度/颜色过渡；且在 28px 轨道内垂直/水平居中（flex 居中，不依赖 line-height）
  assert.match(source, /\.relay-v3-slide-label\{[^}]*display:flex;align-items:center;justify-content:center/, 'label flex 居中');
  assert.ok(source.includes('transition:opacity 220ms ease,color 220ms ease'), 'label 220ms 过渡');
  assert.ok(source.includes('.relay-v3-slide-label-on{opacity:1'), 'active 端高亮类');
  // hover/active 微反馈只改 box-shadow/filter，不得覆盖 thumb 的 transform
  for (const rule of source.match(/\.relay-v3-slide:(?:hover|active)[^{]*\{[^}]*\}/g) ?? []) {
    assert.equal(rule.includes('transform'), false, 'hover/active 不得覆盖 thumb transform：' + rule);
  }
  // prefers-reduced-motion：禁用位移动画，只留颜色/透明度
  const reduced = source.slice(source.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.length > 0, '有 reduced-motion 段');
  assert.ok(reduced.includes('.relay-v3-slide-thumb{transition:box-shadow 260ms ease}'), 'reduced-motion 下 thumb 只留阴影过渡');
  assert.equal(/relay-v3-slide[^{]*\{[^}]*transform/.test(reduced), false, 'reduced-motion 下不得保留位移动画');
  assert.ok(reduced.includes('.relay-v3-slide-fill{') === false, 'fill 的颜色渐变不受 reduced-motion 影响');
});

// ── v0.2.18：一次性默认操作 = 车钟表盘（6 档指针；写入字段与旧按钮网格一致）──────
const dialOf = (instance) => find(instance.tree, (node) => typeof node?.props?.className === 'string' && node.props.className.split(' ').includes('relay-v3-dial'))[0];
const dialOrders = (instance) => find(instance.tree, (node) => typeof node?.props?.className === 'string' && node.props.className.split(' ').includes('relay-v3-order'));
const orderWithText = (instance, text) => dialOrders(instance).find((node) => JSON.stringify(node.children).includes(text));
const lastDialPut = (env) => JSON.parse(String(env.calls.filter((call) => call.method === 'PUT' && call.url === '/context-relay/panel').at(-1).body));
const needleTransform = (instance) => dialOf(instance).props && byClass(instance.tree, 'relay-v3-dial-needle')[0].props.style.transform;
// v0.2.19：指针显示角可累积到 ±360 之外（换挡走最短弧），断言时取实际数值 + 等价角两种口径。
const needleDeg = (instance) => {
  const match = /rotate\((-?[\d.]+)deg\)/.exec(String(needleTransform(instance)));
  return match === null ? NaN : Number(match[1]);
};
const wrapDeg = (deg) => ((deg % 360) + 360) % 360;

test('RelayPanel：一次性默认操作 = 冷峻哥特肋骨穹顶表盘（radiogroup + 6 档 radio + 照准仪指针 + 读出行）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: 'compress' }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const dial = dialOf(instance);
  assert.ok(dial, '渲染冷峻哥特表盘');
  assert.equal(dial.props.role, 'radiogroup');
  assert.equal(dial.props['aria-label'], '一次性默认操作（表盘档位）');
  const orders = dialOrders(instance);
  assert.equal(orders.length, 6, 'classic 6 个档位');
  const checked = orders.filter((node) => node.props['aria-checked'] === true);
  assert.equal(checked.length, 1, '单选：任一时刻只有一个档位');
  assert.match(JSON.stringify(checked[0].children), /压缩继续/, 'compress = 压缩继续（第 3 档）');
  assert.equal(needleTransform(instance), 'rotate(120deg)', '指针 120° 指向第 3 档');
  assert.match(textOf(instance.tree), /先 relay_organize 再重试 phase/, '读出行显示当前档 hint');
  // 元件齐全（v3「石肋星盘」）：多边形石墙/同心券环/放射肋/穹顶网格/尖拱山花冠/尖顶饰/飞扶壁/束柱 + 照准仪指针。
  // byClass 用子串匹配（'...-pip' 也会匹配 '...-pips' 容器）→ 计数断言一律按 class token 精确匹配。
  const exactClass = (className) => byClass(instance.tree, className).filter((node) => String(node.props.className).split(' ').includes(className));
  assert.equal(exactClass('relay-v3-dial-rib').length, 12, '12 根放射肋（2n）');
  assert.equal(exactClass('relay-v3-dial-lierne').length, 24, '穹顶网格斜肋 24 根');
  assert.equal(exactClass('relay-v3-dial-arc').length, 4, '四道结构环线（两道券环 + 内外墙线）');
  assert.equal(exactClass('relay-v3-dial-gable').length, 12, '12 座尖拱山花（多边形每条边一座）');
  assert.equal(exactClass('relay-v3-dial-finial').length, 12, '12 个山花尖顶饰');
  assert.equal(exactClass('relay-v3-dial-buttress').length, 4, '四角飞扶壁');
  assert.equal(exactClass('relay-v3-dial-sector').length, 6, '6 跨档位提亮层');
  assert.equal(exactClass('relay-v3-dial-pip').length, 6, '6 个墙墩菱形节点');
  assert.equal(exactClass('relay-v3-dial-hub').length, 1, '中心束柱平面（八角柱 + 拱心石）');
  assert.equal(exactClass('relay-v3-dial-hub-ring').length, 1, '束柱八角轮廓');
  assert.equal(exactClass('relay-v3-dial-backlight').length, 1, '穹顶冷背光（唯一光源）');
  assert.equal(exactClass('relay-v3-dial-scan').length, 1, '盘面扫描线层');
  // 指针 = 照准仪（细冷钢针 + 菱形垂尖 + 刻度 + 四叶配重），不是剑/十字。
  assert.equal(exactClass('relay-v3-dial-alidade').length, 1, '照准仪 SVG');
  assert.equal(exactClass('relay-v3-dial-alidade-fin').length, 1, '菱形垂尖');
  assert.equal(exactClass('relay-v3-dial-alidade-rule').length, 1, '细长针身');
  assert.equal(exactClass('relay-v3-dial-alidade-counterweight').length, 1, '四叶配重');
  // 旧版视觉结构彻底移除（防回潮：剑/十字/彩窗/玫瑰窗/暖金名牌/操作说明 tip）
  for (const gone of [
    'relay-v3-dial-blade', 'relay-v3-dial-guard', 'relay-v3-dial-grip', 'relay-v3-dial-glass',
    'relay-v3-dial-lancet', 'relay-v3-dial-lead-ring', 'relay-v3-dial-frame', 'relay-v3-dial-crocket',
    'relay-v3-dial-trefoil', 'relay-v3-dial-sill', 'relay-v3-dial-head-tip',
  ]) {
    assert.equal(byClass(instance.tree, gone).length, 0, '旧视觉结构已删除：' + gone);
  }
  // 几何：盘面 300×264、中心 (150,132)、6 档等距 116px / 60° 均布、标签两两不重叠（防手改坐标叠字）
  const center = { x: 150, y: 132 };
  const points = orders.map((node) => ({ x: parseFloat(node.props.style.left), y: parseFloat(node.props.style.top) }));
  for (const point of points) {
    assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - 116) < 0.5, '档位标签半径 116：' + point.x + ',' + point.y);
    assert.ok(point.x >= 40 && point.x <= 260, '标签中心横向在画布内：' + point.x);
    assert.ok(point.y >= 10 && point.y <= 258, '标签中心纵向在画布内：' + point.y);
  }
  const angles = points.map((point) => (Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI + 90 + 360) % 360).sort((a, b) => a - b);
  angles.forEach((angle, index) => assert.ok(Math.abs(angle - index * 60) < 0.5, '角度 60° 均布：' + angles.join(',')));
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      assert.ok(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 80, '档位标签不重叠');
    }
  }
});

test('RelayPanel：点档位写旧字段（defaultOperation 与 autoChoose 互斥，同档不重复写）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: null }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(needleTransform(instance), 'rotate(0deg)', '未设置 → 顶部「问我」');
  // 点「接力新会话」→ defaultOperation=handoff + 关 auto
  orderWithText(instance, '接力新会话').props.onClick();
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false });
  assert.equal(wrapDeg(needleDeg(instance)), 240, 'handoff = 第 5 档 240°');
  assert.equal(needleDeg(instance), -120, '初始角取 (-180,180] 的等价角（入场摆动也只走短弧）');
  // 点「继续」→ continue（60°）
  orderWithText(instance, '继续').props.onClick();
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'continue', autoChoose: false });
  assert.equal(needleTransform(instance), 'rotate(60deg)');
  // 同档再点不重复写
  const before = env.calls.filter((call) => call.method === 'PUT').length;
  orderWithText(instance, '继续').props.onClick();
  await instance.flush();
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, before, '同档点击不重复写');
  // 键盘 ← 回到「问我」（null）
  dialOf(instance).props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: null, autoChoose: false });
  assert.equal(needleTransform(instance), 'rotate(0deg)');
});

test('RelayPanel：自动档独占第 6 档（指针 300°）；键盘 Home/End 到端点', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, autoChoose: true }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(needleDeg(instance), -60, '自动档 = 300° 的等价角 −60°（入场摆动走短弧）');
  assert.equal(wrapDeg(needleDeg(instance)), 300, '视觉上仍是 300°（自动档）');
  const checked = dialOrders(instance).filter((node) => node.props['aria-checked'] === true);
  assert.match(JSON.stringify(checked[0].children), /自动/);
  assert.match(textOf(instance.tree), /自动（模型决定）/, '读出行保留完整档名');
  // 点「压缩继续」→ 关自动、落具体操作
  orderWithText(instance, '压缩继续').props.onClick();
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'compress', autoChoose: false });
  assert.equal(needleTransform(instance), 'rotate(120deg)');
  // End → 自动档（互斥字段一起写）
  dialOf(instance).props.onKeyDown({ key: 'End', preventDefault() {} });
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', autoChoose: true, defaultOperation: null });
  assert.equal(needleTransform(instance), 'rotate(300deg)');
  // Home → 问我：从 300° 走 +60° 到 360°（等价 0°），不绕 −300° 的整圈
  dialOf(instance).props.onKeyDown({ key: 'Home', preventDefault() {} });
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: null, autoChoose: false });
  assert.equal(needleDeg(instance), 360, '最短弧：300° → 360°（+60°）');
  assert.ok(Math.abs(needleDeg(instance) - 300) <= 180, '换挡增量 ≤ 180°');
});

test('RelayPanel：拖动指针 >5px 才拖动/松手吸附并提交；点击扇区（<5px）选指针所在档；铭牌按下不触发拖动', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: null }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  // fake React 不 attach ref，且 flush 后重渲染会换新 props：每次交互前重新取表盘节点并挂几何桩。
  const rect = { left: 0, top: 0, width: 300, height: 264 };
  const dialProps = () => {
    const dial = dialOf(instance);
    dial.props.ref.current = { getBoundingClientRect: () => rect, setPointerCapture: () => {} };
    return dial.props;
  };
  const pointer = (x, y) => ({ clientX: x, clientY: y, pointerId: 7, target: { closest: () => null }, currentTarget: dialProps().ref.current });
  // 单击扇区（<5px 不移动）= 选该扇区档位：右上 45° 落在「继续」扇区（60°）
  dialProps().onPointerDown(pointer(150 + 50, 132 - 50));
  dialProps().onPointerUp(pointer(150 + 50, 132 - 50));
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'continue', autoChoose: false });
  assert.equal(needleDeg(instance), 60, '指针按最短弧转到 60°');
  // 同一扇区再点：不重复写
  const putsAfterClick = env.calls.filter((call) => call.method === 'PUT').length;
  dialProps().onPointerDown(pointer(150 + 40, 132 - 60));
  dialProps().onPointerUp(pointer(150 + 40, 132 - 60));
  await instance.flush();
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, putsAfterClick, '同扇区点击不重复写');
  // >5px 拖动：指针跟手（不吸附）；拖动序列内不 flush，用同一份 props
  const dragProps = dialProps();
  dragProps.onPointerDown(pointer(150, 132));
  dragProps.onPointerMove(pointer(150 + 50, 132 - 50));
  await instance.flush();
  const draggedAngle = parseFloat(String(byClass(instance.tree, 'relay-v3-dial-needle')[0].props.style.transform).replace(/[^0-9.]/g, ''));
  assert.ok(Math.abs(draggedAngle - 45) < 1, '拖动时指针跟手（不吸附）：' + draggedAngle);
  // 拖到右下（150°）→ 松手吸附 index 3（压缩→新会话）
  dragProps.onPointerMove(pointer(150 + 43, 132 + 75));
  await instance.flush();
  dialProps().onPointerUp(pointer(150 + 43, 132 + 75));
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'compress-then-handoff', autoChoose: false });
  assert.equal(needleDeg(instance), 180, '松手后指针吸附 180°（第 4 档，从拖动角 105° 走最短弧）');
  // 从档位铭牌按下不启动拖动（避免点选变拖拽）
  const before = env.calls.filter((call) => call.method === 'PUT').length;
  const guardProps = dialProps();
  guardProps.onPointerDown({ clientX: 10, clientY: 10, pointerId: 8, target: { closest: () => ({}) }, currentTarget: dialProps().ref.current });
  guardProps.onPointerMove(pointer(10, 10));
  guardProps.onPointerUp(pointer(10, 10));
  await instance.flush();
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, before, '铭牌上按下不进入拖动，不写 PUT');
});

test('RelayPanel：6 个扇区整盘平分——点任意 60° 扇区选中该档，指针全程走最短弧（自动↔问我 ±60°）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: null }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  // fake React 不 attach ref：每次交互前重新取节点（flush 后重渲染会换新 props）
  const rect = { left: 0, top: 0, width: 300, height: 264 };
  const dialProps = () => {
    const dial = dialOf(instance);
    dial.props.ref.current = { getBoundingClientRect: () => rect, setPointerCapture: () => {} };
    return dial.props;
  };
  const pointer = (x, y) => ({ clientX: x, clientY: y, pointerId: 9, target: { closest: () => null }, currentTarget: dialProps().ref.current });
  // 依次点各扇区中心（半径 80）：写入档位与指针角都对，且每次增量 |Δ| ≤ 60°。
  const cases = [
    { angle: 60, put: { sessionId: 'A', defaultOperation: 'continue', autoChoose: false }, deg: 60 },
    { angle: 120, put: { sessionId: 'A', defaultOperation: 'compress', autoChoose: false }, deg: 120 },
    { angle: 180, put: { sessionId: 'A', defaultOperation: 'compress-then-handoff', autoChoose: false }, deg: 180 },
    { angle: 240, put: { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false }, deg: 240 },
    { angle: 300, put: { sessionId: 'A', autoChoose: true, defaultOperation: null }, deg: 300 },
    // 自动(300°) → 问我(0°)：走 +60° 到 360°，而不是 −300° 绕整圈
    { angle: 0, put: { sessionId: 'A', defaultOperation: null, autoChoose: false }, deg: 360 },
  ];
  let previous = 0;
  for (const item of cases) {
    const rad = ((item.angle - 90) * Math.PI) / 180;
    const x = 150 + 80 * Math.cos(rad);
    const y = 132 + 80 * Math.sin(rad);
    dialProps().onPointerDown(pointer(x, y));
    dialProps().onPointerUp(pointer(x, y));
    await instance.flush();
    assert.deepEqual(lastDialPut(env), item.put, '点扇区 ' + item.angle + '° 写入对应档位');
    assert.equal(needleDeg(instance), item.deg, '指针角 ' + item.deg + '°（等价于 ' + item.angle + '°）');
    assert.ok(Math.abs(needleDeg(instance) - previous) <= 180, '换挡增量 ≤180°：' + previous + '→' + needleDeg(instance));
    assert.ok(Math.abs(needleDeg(instance) - previous) <= 60, '相邻档位只走 60°：' + previous + '→' + needleDeg(instance));
    previous = needleDeg(instance);
  }
});

test('RelayPanel：悬停扇区高亮扇形 + 对应铭牌（不写 PUT）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: null }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const dial = dialOf(instance);
  const rect = { left: 0, top: 0, width: 300, height: 264 };
  dial.props.ref.current = { getBoundingClientRect: () => rect, setPointerCapture: () => {} };
  // 悬停到 150° 方向（第 4 档「压缩→新会话」扇区），未按下
  const rad = ((150 - 90) * Math.PI) / 180;
  dial.props.onPointerMove({ clientX: 150 + 70 * Math.cos(rad), clientY: 132 + 70 * Math.sin(rad), pointerId: 11, target: { closest: () => null }, currentTarget: dial.props.ref.current });
  await instance.flush();
  const hoveredSectors = byClass(instance.tree, 'relay-v3-dial-sector').filter((node) => node.props.className.includes('relay-v3-dial-sector-hover'));
  assert.equal(hoveredSectors.length, 1, '悬停高亮一个扇区');
  const hoveredOrders = dialOrders(instance).filter((node) => node.props.className.includes('relay-v3-order-hover'));
  assert.equal(hoveredOrders.length, 1, '对应铭牌同时高亮');
  assert.match(JSON.stringify(hoveredOrders[0].children), /压缩→新会话/, '高亮的是 150° 所在扇区');
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 0, '悬停不写 PUT');
  // 指针离开表盘：清掉悬停高亮
  dial.props.onPointerLeave();
  await instance.flush();
  assert.equal(byClass(instance.tree, 'relay-v3-dial-sector').filter((node) => node.props.className.includes('relay-v3-dial-sector-hover')).length, 0);
  assert.equal(dialOrders(instance).filter((node) => node.props.className.includes('relay-v3-order-hover')).length, 0);
});


test('RelayPanel：键盘连按不重复提交（同步意图档位，不等宿主回包）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: 'compress' }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const dial = dialOf(instance);
  // compress(第 3 档) 连按两下右方向键：→ 压缩→新会话(第 4 档) → 接力新会话(第 5 档)，不得两次都提交第 4 档
  dial.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  dial.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  await instance.flush();
  const targets = env.calls.filter((call) => call.method === 'PUT').map((call) => JSON.parse(String(call.body)).defaultOperation);
  assert.deepEqual(targets, ['compress-then-handoff', 'handoff'], '连按两下提交两个不同档位');
  assert.equal(needleTransform(instance), 'rotate(240deg)', '最终落在接力新会话（第 5 档 240°）');
});

test('RelayPanel：扇区按 30° 边界平分 / 中心轮毂死区 / 非主键单击不选档', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT, defaultOperation: null }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const rect = { left: 0, top: 0, width: 300, height: 264 };
  const dialProps = () => {
    const dial = dialOf(instance);
    dial.props.ref.current = { getBoundingClientRect: () => rect, setPointerCapture: () => {} };
    return dial.props;
  };
  const pointer = (x, y, extra) => ({ clientX: x, clientY: y, pointerId: 13, target: { closest: () => null }, currentTarget: dialProps().ref.current, ...(extra || {}) });
  const click = async (angle, radius, extra) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    const x = 150 + radius * Math.cos(rad);
    const y = 132 + radius * Math.sin(rad);
    const props = dialProps();
    props.onPointerDown(pointer(x, y, extra));
    props.onPointerUp(pointer(x, y, extra));
    await instance.flush();
  };
  const putCount = () => env.calls.filter((call) => call.method === 'PUT').length;
  // 30° 是「问我 / 继续」扇区边界：29.9° 仍属问我（当前档，不写），30.1° 进继续（写）——证明扇区按 60° 平分而不是只认中心。
  await click(29.9, 80);
  assert.equal(putCount(), 0, '29.9° 仍在「问我」扇区（当前档不重复写）');
  await click(30.1, 80);
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'continue', autoChoose: false }, '30.1° 越过边界落「继续」扇区');
  // 中心轮毂死区（半径 18px 内）：点正中心不选档、不写 PUT（否则 atan2(0,0) 会固定写「压缩继续」）
  const beforeHub = putCount();
  await click(0, 0);
  assert.equal(putCount(), beforeHub, '点中心轮毂不写 PUT');
  assert.equal(wrapDeg(needleDeg(instance)), 60, '点中心后指针仍停在「继续」档');
  // 非主键（右键 button=2）单击扇区不选档
  await click(240, 80, { button: 2 });
  assert.equal(putCount(), beforeHub, '右键单击不写 PUT');
});

// ── v0.2.31：relay-long 一次性默认操作 = 4 档（问/继续/压缩继续/接力新会话）──────────
const LONG_PRESET = 'relay-long';
/** relay-long 会话面板 fixture（panel GET 已下发 preset + modes）。 */
const longEnv = (panel) => ({
  relay: true, modes: MODES, preset: LONG_PRESET,
  panel: { ...PANEL_DEFAULT, ...(panel || {}) }, live: LIVE(),
});

test('RelayPanel：relay-long 表盘只 4 档（问我/继续/压缩继续/接力新会话），90° 均布，隐藏 压缩→新会话 与 自动', async () => {
  const env = createEnv();
  env.server.panel.A = longEnv({ defaultOperation: 'continue' });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const orders = dialOrders(instance);
  assert.equal(orders.length, 4, '长模式 4 档');
  const texts = orders.map((node) => JSON.stringify(node.children));
  for (const expected of ['问我', '继续', '压缩继续', '接力新会话']) {
    assert.ok(texts.some((text) => text.includes(expected)), '应有档位：' + expected);
  }
  assert.equal(textOf(instance.tree).includes('压缩→新会话'), false, '长模式隐藏「压缩→新会话」');
  assert.equal(textOf(instance.tree).includes('自动（模型决定）'), false, '长模式隐藏「自动（模型决定）」');
  assert.match(String(byClass(instance.tree, 'relay-v3-dial-head-title')[0].children[0]), /超长任务/, '长模式抬头标注「超长任务」');
  // 几何：4 档 90° 均布、标签半径 110（左右铭牌收进画布）、盘面仍是 300×264
  const center = { x: 150, y: 132 };
  const points = orders.map((node) => ({ x: parseFloat(node.props.style.left), y: parseFloat(node.props.style.top) }));
  for (const point of points) {
    assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - 110) < 0.5, '长模式标签半径 110：' + point.x + ',' + point.y);
    assert.ok(point.x >= 30 && point.x <= 270, '标签中心横向在画布内：' + point.x);
    assert.ok(point.y >= 10 && point.y <= 258, '标签中心纵向在画布内：' + point.y);
  }
  const angles = points.map((point) => (Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI + 90 + 360) % 360).sort((a, b) => a - b);
  angles.forEach((angle, index) => assert.ok(Math.abs(angle - index * 90) < 0.5, '4 档按 90° 均布：' + angles.join(',')));
  // 写读一致：continue = 第 2 档 → 指针 90°，读出行显示「继续」
  assert.equal(needleTransform(instance), 'rotate(90deg)', 'continue = 90°');
  const checked = orders.filter((node) => node.props['aria-checked'] === true);
  assert.equal(checked.length, 1);
  assert.match(JSON.stringify(checked[0].children), /继续/);
  assert.match(textOf(instance.tree), /不压缩不拦/, '读出行显示当前档 hint');
  // 元件：4 跨档位提亮层 / 4 个墙墩节点 / 8 根放射肋 / 8 座山花 / 8 个尖顶饰 / 四角飞扶壁（结构几何随档数自适应）
  const exact = (className) => byClass(instance.tree, className).filter((node) => String(node.props.className).split(' ').includes(className));
  assert.equal(exact('relay-v3-dial-sector').length, 4, '4 跨档位提亮层');
  assert.equal(exact('relay-v3-dial-pip').length, 4, '4 个墙墩节点');
  assert.equal(exact('relay-v3-dial-rib').length, 8, '8 根放射肋（2n）');
  assert.equal(exact('relay-v3-dial-gable').length, 8, '8 座尖拱山花（八边形）');
  assert.equal(exact('relay-v3-dial-finial').length, 8, '8 个山花尖顶饰');
  assert.equal(exact('relay-v3-dial-buttress').length, 4, '四角飞扶壁与档数无关');
  assert.equal(exact('relay-v3-dial-lierne').length, 16, '穹顶网格斜肋 16 根');
  // 接力新会话 = 团队重启语义：铭牌副标 + title + 读出行 hint
  const handoffSeat = orderWithText(instance, '接力新会话');
  assert.match(textOf(handoffSeat), /团队重启/, '铭牌标注「团队重启」');
  assert.match(String(handoffSeat.props.title), /团队重启/);
  assert.match(String(handoffSeat.props.title), /预设只决定做什么/);
  orderWithText(instance, '接力新会话').props.onClick();
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false }, '团队重启档写入 handoff');
  assert.match(textOf(instance.tree), /团队重启/, '读出行 hint 标注团队重启');
});

test('RelayPanel：relay-long 隐藏档存量值视觉按「继续」显示、不写盘（host 做语义归一）', async () => {
  const env = createEnv();
  env.server.panel.A = longEnv({ defaultOperation: 'compress-then-handoff' });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 0, '打开/轮询不得主动写盘');
  const chipText = textOf(byClass(instance.tree, 'relay-v3-chip')[0]);
  assert.match(chipText, /继续/, 'chip 下一次操作视觉按「继续」');
  assert.equal(chipText.includes('压缩→新会话'), false, 'chip 不显示隐藏档');
  assert.ok(await openPopover(instance));
  const orders = dialOrders(instance);
  assert.equal(orders.length, 4);
  const checked = orders.filter((node) => node.props['aria-checked'] === true);
  assert.equal(checked.length, 1);
  assert.match(JSON.stringify(checked[0].children), /继续/, '存量「压缩→新会话」按「继续」高亮');
  assert.equal(needleTransform(instance), 'rotate(90deg)', '指针停在「继续」档（90°）');
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 0, '隐藏档不触发任何写盘');
  // 点「压缩继续」→ 写真实字段；指针走到 180°
  orderWithText(instance, '压缩继续').props.onClick();
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'compress', autoChoose: false });
  assert.equal(needleTransform(instance), 'rotate(180deg)');
  // 存量「自动（模型决定）」→ 同样按「继续」显示、不写盘
  env.server.panel.A = longEnv({ autoChoose: true, defaultOperation: null });
  env.pollAll();
  await instance.flush();
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 1, '轮询到存量隐藏档不写盘（仍只有上面那次点击写入）');
  const checkedAuto = dialOrders(instance).filter((node) => node.props['aria-checked'] === true);
  assert.match(JSON.stringify(checkedAuto[0].children), /继续/, '存量「自动」按「继续」高亮');
  assert.equal(needleTransform(instance), 'rotate(90deg)');
});

test('RelayPanel：relay-long 键盘/点击/拖动都按 4 档换挡，指针全程走最短弧（≤90°）', async () => {
  const env = createEnv();
  env.server.panel.A = longEnv({ defaultOperation: null });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const dialProps = () => {
    const dial = dialOf(instance);
    dial.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 264 }), setPointerCapture: () => {} };
    return dial.props;
  };
  const pointer = (x, y) => ({ clientX: x, clientY: y, pointerId: 21, target: { closest: () => null }, currentTarget: dialProps().ref.current });
  const clickAngle = async (angle, radius) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    const x = 150 + radius * Math.cos(rad);
    const y = 132 + radius * Math.sin(rad);
    dialProps().onPointerDown(pointer(x, y));
    dialProps().onPointerUp(pointer(x, y));
    await instance.flush();
  };
  const putCount = () => env.calls.filter((call) => call.method === 'PUT').length;
  // 扇区点击：90°→继续，180°→压缩继续，270°→接力新会话，0°→问我；每步只走 90° 最短弧
  const cases = [
    { angle: 90, put: { sessionId: 'A', defaultOperation: 'continue', autoChoose: false }, deg: 90 },
    { angle: 180, put: { sessionId: 'A', defaultOperation: 'compress', autoChoose: false }, deg: 180 },
    { angle: 270, put: { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false }, deg: 270 },
    // 270° → 0°：走 +90° 到 360°，不绕 −270° 整圈
    { angle: 0, put: { sessionId: 'A', defaultOperation: null, autoChoose: false }, deg: 360 },
  ];
  let previous = 0;
  for (const item of cases) {
    await clickAngle(item.angle, 80);
    assert.deepEqual(lastDialPut(env), item.put, '点 ' + item.angle + '° 扇区写入对应档');
    assert.equal(needleDeg(instance), item.deg, '指针角 ' + item.deg + '°（等价 ' + item.angle + '°）');
    assert.ok(Math.abs(needleDeg(instance) - previous) <= 90, '换挡增量 ≤90°：' + previous + '→' + needleDeg(instance));
    previous = needleDeg(instance);
  }
  // 键盘：Home→问我(0)，End→接力新会话(3=270°)，ArrowLeft 从问我回绕到 3（−90°）
  dialProps().onKeyDown({ key: 'End', preventDefault() {} });
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false });
  assert.equal(wrapDeg(needleDeg(instance)), 270);
  dialProps().onKeyDown({ key: 'Home', preventDefault() {} });
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: null, autoChoose: false });
  assert.equal(needleDeg(instance), 360, 'Home 从 270° 走 +90° 到 360°（等价 0°）');
  dialProps().onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  await instance.flush();
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false }, 'ArrowLeft 回绕到第 4 档');
  assert.equal(needleDeg(instance), 270, '从 360° 走 −90° 到 270°');
  // 连按右方向键两次：继续 → 压缩继续（同步意图档位，不重复提交）
  dialProps().onKeyDown({ key: 'Home', preventDefault() {} });
  await instance.flush();
  const beforeBurst = putCount();
  dialProps().onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  dialProps().onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  await instance.flush();
  const burst = env.calls.filter((call) => call.method === 'PUT').slice(beforeBurst).map((call) => JSON.parse(String(call.body)).defaultOperation);
  assert.deepEqual(burst, ['continue', 'compress'], '长模式连按提交两个不同档位');
  // 中心轮毂死区（半径 18px 内）不选档
  const beforeHub = putCount();
  await clickAngle(0, 0);
  assert.equal(putCount(), beforeHub, '点中心轮毂不写 PUT');
  // 拖动：>5px 跟手，松手吸附最近档（拖到 270° 方向 → 接力新会话）
  const dragProps = dialProps();
  dragProps.onPointerDown(pointer(150, 132));
  dragProps.onPointerMove(pointer(150 + 50, 132 + 50));
  await instance.flush();
  dragProps.onPointerMove(pointer(150 - 60, 132));
  await instance.flush();
  dialProps().onPointerUp(pointer(150 - 60, 132));
  await instance.flush();
  assert.equal(wrapDeg(needleDeg(instance)), 270, '松手吸附到 270°（接力新会话）');
  assert.deepEqual(lastDialPut(env), { sessionId: 'A', defaultOperation: 'handoff', autoChoose: false }, '拖动松手提交档位');
});

test('RelayPanel：classic relay 会话保持 6 档（preset!==modes.long 不触发长模式精简）', async () => {
  const env = createEnv();
  env.server.panel.A = { relay: true, modes: MODES, preset: 'relay', panel: { ...PANEL_DEFAULT, autoChoose: true }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(dialOrders(instance).length, 6, 'classic 仍是 6 档');
  assert.ok(dialOrders(instance).some((node) => JSON.stringify(node.children).includes('压缩→新会话')), 'classic 保留「压缩→新会话」');
  assert.ok(dialOrders(instance).some((node) => JSON.stringify(node.children).includes('自动')), 'classic 保留「自动」');
  assert.equal(byClass(instance.tree, 'relay-v3-dial-head-title')[0].children[0], '一次性默认操作', 'classic 表盘抬头不含「超长任务」');
});

test('CSS：冷峻哥特「石肋星盘」表盘契约（多边形肋拱/山花冠/飞扶壁/照准仪/冷色线稿/无彩窗暖金/reduced-motion）', () => {
  assert.ok(source.includes('.relay-v3-dial{position:relative;width:300px;height:264px'), '固定尺寸表盘 300×264');
  assert.equal(source.includes('relay-v3-dial-head-tip'), false, '表盘上方操作说明（tip）已删除（用户要求）');
  // ① 几何：多边形（2n 边）章节堂平面 + 同心券环 + 放射肋 + 穹顶网格（结构本身就是装饰）
  assert.ok(source.includes('const dialPolygon = (count, radius) =>'), '多边形墙线/券环生成器（2n 边）');
  assert.ok(source.includes('const step = span / 2;'), '多边形每边张角 = 半档（classic 12 边 / long 8 边）');
  assert.ok(source.includes('const DIAL_ORDER = [null, "continue", "compress", "compress-then-handoff", "handoff", "auto"];'), 'classic 6 档不变');
  assert.ok(source.includes('const DIAL_ORDER_LONG = [null, "continue", "compress", "handoff"];'), 'relay-long 4 档不变');
  assert.ok(source.includes('ring1: 36, ring2: 62, wallIn: 90, wallOut: 96'), '结构半径常量（券环/墙/节点）');
  assert.ok(source.includes('const dialPinnaclePath = (angle, halfWidth, base, shoulder, tip) =>'), '尖塔/尖顶饰路径生成器');
  assert.ok(source.includes('const dialLancetPath') === false && source.includes('dialGable') === false, '不再用尖拱窗/彩窗格');
  // ② 结构线稿 = 冷灰/青灰（不是彩窗/暖金）
  assert.ok(source.includes('.relay-v3-dial-structure{fill:none;stroke:#5a6f7e'), '骨架 = 冷灰线稿');
  assert.ok(source.includes('.relay-v3-dial-rib-main{stroke:#7691a2}'), '主肋 = 较亮冷灰');
  assert.ok(source.includes('.relay-v3-dial-arc{stroke:#5b7484'), '券环 = 冷灰');
  assert.ok(source.includes('.relay-v3-dial-gable{fill:none;stroke:#7d9aab'), '尖拱山花 = 冷灰线稿');
  assert.ok(source.includes('.relay-v3-dial-finial{fill:#0b1218;stroke:#9db8c9'), '山花尖顶饰 = 暗石 + 冷灰勾边');
  assert.ok(source.includes('.relay-v3-dial-buttress{fill:none;stroke:#526a78'), '飞扶壁 = 冷灰');
  assert.ok(source.includes('.relay-v3-dial-lierne{stroke:#3f5462'), '穹顶网格斜肋 = 暗冷灰');
  assert.ok(source.includes('.relay-v3-dial-hub-shaft{fill:none;stroke:#7d99aa'), '束柱柱身刻线');
  assert.ok(source.includes('.relay-v3-dial-hub-core{fill:#0e1820;stroke:#d5eef9'), '拱心石 = 冷白勾边');
  // ③ 冷光只落在选中路径与指针上（无彩窗/无暖金/无品红）
  for (const gone of ['#c9a464', '#ff2fd0', '#4a0d12', '#2a1245', '#0d1f4a', 'GOTHIC_', 'relay-v3-dial-blade']) {
    assert.equal(source.includes(gone), false, '旧暖金/彩窗/剑指针已彻底删除：' + gone);
  }
  assert.ok(source.includes('.relay-v3-dial-ray-on{stroke:#b7f2ff'), '选中肋线 = 冷白冷光');
  assert.ok(source.includes('.relay-v3-dial-pip-on{fill:#eaf9ff'), '选中节点 = 冷白发光');
  assert.ok(source.includes('.relay-v3-dial-sector-on{fill:url(#relay-v3-dial-lit)'), '选中一跨 = 冷光提亮（不是彩色玻璃）');
  assert.ok(source.includes('linearGradient", { key: "lit", id: "relay-v3-dial-lit"'), '冷光提亮渐变（冷白/青，无彩色玻璃）');
  // ④ 指针 = 照准仪（细冷钢针 + 菱形垂尖 + 四叶配重），不是剑/十字
  assert.ok(source.includes('.relay-v3-dial-alidade-fin{fill:url(#relay-v3-needle-steel)'), '菱形垂尖 = 冷钢渐变');
  assert.ok(source.includes('.relay-v3-dial-alidade-rule{fill:url(#relay-v3-needle-steel)'), '细长针身 = 冷钢渐变');
  assert.ok(source.includes('className: "relay-v3-dial-alidade-tail"'), '四叶配重');
  assert.ok(source.includes('relay-v3-dial-needle-flow'), '冷光沿针上移（沿结构的光）');
  assert.ok(source.includes('@keyframes relay-v3-dial-flow{to{stroke-dashoffset:-24}}'), '选中肋线冷光流动（纯 paint）');
  assert.ok(source.includes('@keyframes relay-v3-dial-sweep{'), '全息扫描带');
  // ⑤ 档位铭牌 = 冷石铭刻（切角 + 冷灰边 + 菱形节点 + 衬线中文），无暖金
  assert.ok(source.includes('.relay-v3-order{position:absolute') && source.includes('clip-path:polygon(4px 0,calc(100% - 4px) 0'), '切角冷石板');
  assert.ok(source.includes('background:linear-gradient(180deg,#5d7280,#2a3742) border-box'), '冷灰 1px 边 + 暗石面');
  assert.ok(source.includes('.relay-v3-order-on{opacity:1;color:#f2fbff'), '选中 = 冷光勾边 + 冷白字');
  assert.equal(/@font-face|@import|fonts\.googleapis|fonts\.gstatic/.test(source), false, '不得加载外部字体/样式');
  assert.ok(source.includes("font-family:Georgia,'Times New Roman','Songti SC','SimSun','Noto Serif CJK SC',serif"), '中文衬线/宋体栈（system serif）');
  // ⑥ 动效契约：指针弹簧/拖动实时跟随/入场只播一次/reduced-motion（只碰 transform/opacity/filter/纯 paint）
  assert.ok(source.includes('@keyframes relay-v3-needle-in{from{transform:rotate(0deg)}to{transform:rotate(var(--dial-to))}}'), '入场从顶部摆到当前档');
  assert.ok(source.includes('transition:transform 560ms cubic-bezier(.22,1.36,.36,1)'), '指针 560ms 弹簧');
  assert.ok(source.includes('.relay-v3-dial-needle-dragging{animation:none;transition:none}'), '拖动实时跟随');
  assert.ok(source.includes('.relay-v3-dial-needle-settled{animation:none}'), '入场只播一次');
  assert.ok(source.includes('animation:relay-v3-order-in 260ms cubic-bezier(.2,.8,.2,1) backwards'), '铭牌交错入场');
  const dialStart = source.indexOf('.relay-v3-dial{');
  const reducedStart = source.indexOf('@media (prefers-reduced-motion: reduce){.relay-v3-dial{animation:none}');
  assert.ok(dialStart >= 0 && reducedStart > dialStart, '表盘 CSS 段可定位');
  const dialCss = source.slice(dialStart, reducedStart);
  for (const declaration of dialCss.match(/(?:transition|animation):[^;}]*/g) ?? []) {
    assert.equal(/left|top\b|width|height/.test(declaration), false, '过渡/动画不得触碰布局属性：' + declaration);
  }
  const reducedDial = source.slice(reducedStart);
  assert.ok(reducedDial.includes('.relay-v3-dial-needle{transition:none;animation:none}'), 'reduced-motion 关指针过渡');
  assert.ok(reducedDial.includes('.relay-v3-dial-ping{animation:none;display:none}'), 'reduced-motion 关脉冲');
  assert.ok(reducedDial.includes('.relay-v3-order{animation:none;transition:none}'), 'reduced-motion 关铭牌动画');
  assert.ok(reducedDial.includes('.relay-v3-dial-ray-on{animation:none;stroke-dasharray:none}'), 'reduced-motion 关肋线流光');
  assert.ok(reducedDial.includes('.relay-v3-dial-sweep{animation:none;display:none}'), 'reduced-motion 关扫描带');
  assert.ok(source.includes('Math.min(Math.round(vh * 0.72), 600'), '面板高度上限 600');
});

test('CSS：水缸行 = 液态填充（水位 450ms 惯性上升 + 水面波层 900ms 慢移 + 5 液滴 + 高光浪线 + reduced-motion；无横穿块/水舌）与「授权下一次操作」= canvas 水面引擎 + 接力 chip 独角兽红契约', () => {
  // 装饰层：铺满整行、被行圆角裁剪；所有水元素都在这一层里各自运动
  assert.ok(source.includes('.relay-v3-tank-art{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden;border-radius:inherit}'), 'aria-hidden 装饰层铺满整行（不拦截鼠标/不参与布局）');
  assert.ok(source.includes(".relay-v3-tank::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:2;"), '缸壁玻璃内衬高光（装饰层之上、文字之下）');
  // 三色与开启态（保留；v0.2.30 只加水体色变量，色相不变）
  for (const tone of ['blue', 'green', 'sakura']) {
    assert.ok(source.includes('.relay-v3-tank-' + tone + '{--tank-accent:'), '三色之一：' + tone);
  }
  assert.ok(source.includes('.relay-v3-tank-sakura{--tank-accent:#ff5470'), '樱花红（独角兽色系）');
  assert.ok(source.includes('.relay-v3-tank-on{color:var(--tank-text,#eaf2ff);border-color:var(--tank-accent);background:rgba(13,17,23,.72);box-shadow:0 0 14px var(--tank-glow),inset 0 0 16px var(--tank-inner)}'), '开启态=深色底 + 淡水色微光');
  assert.ok(source.includes('--tank-water:47,129,247'), '蓝水体色变量（RGB 分量，供 rgba(var(--tank-water),a) 用）');
  assert.ok(source.includes('--tank-water:45,164,78'), '绿水体色变量');
  assert.ok(source.includes('--tank-water:255,84,112'), '樱花红水体色变量');
  // 取水缸 CSS 段（反斜杠转义还原成真实 CSS 文本，便于断言 url/mask）
  const tankCss = source.slice(source.indexOf('.relay-v3-tank{'), source.indexOf('.relay-v3-chip-unicorn{')).replace(/\\"/g, '"');
  // 1) 液体主体：translateY(102%)→0，300ms ease；顶部 = SVG mask 平滑浪形
  assert.ok(tankCss.includes('.relay-v3-tank-liquid{position:absolute;left:0;right:0;bottom:0;height:100%;transform:translateY(102%);transition:transform .45s cubic-bezier(.25,1.12,.4,1)}'), '液体主体：100% 行高，从缸底下方(102%)升起，450ms + 水体惯性缓动');
  assert.ok(tankCss.includes('.relay-v3-tank-on .relay-v3-tank-liquid{transform:translateY(-26%)}'), '开启终态：水位占满整个 bar（顶部浪形移出行外被裁）');
  const bodyRule = tankCss.slice(tankCss.indexOf('.relay-v3-tank-body{'), tankCss.indexOf('.relay-v3-tank-crest{'));
  assert.ok(bodyRule.includes('-webkit-mask-image:url("data:image/svg+xml,') && bodyRule.includes('mask-image:url("data:image/svg+xml,'), '液体顶部用 SVG mask 做浪形（不是平线/直角色块）');
  assert.ok(bodyRule.includes("viewBox%3D'0%200%20320%2020'") && bodyRule.includes("preserveAspectRatio%3D'none'"), '浪形 SVG 拉伸铺满（preserveAspectRatio=none）');
  assert.ok(bodyRule.includes('M0%205%20Q40%200%2080%205%20T160%205%20T240%205%20T320%205'), '浪形=平滑二次曲线链（无锯齿瓦片）');
  assert.ok(bodyRule.includes('mask-size:100% 100%'), 'mask 拉伸到液体尺寸');
  assert.ok(bodyRule.includes('background:linear-gradient(180deg,rgba(var(--tank-water),.58)'), '水体=半透明三色渐变（深色缸底透出）');
  // 5) 水面高光浪线：与液体主体同一浪形/viewBox，随液面上升、终态停在液面
  const crestRule = tankCss.slice(tankCss.indexOf('.relay-v3-tank-crest{'), tankCss.indexOf('.relay-v3-tank-wave{'));
  assert.ok(crestRule.includes('background-image:url("data:image/svg+xml,'), '水面高光=SVG 平滑浪线');
  assert.ok(crestRule.includes("viewBox%3D'0%200%20320%2020'") && crestRule.includes('M0%205%20Q40%200%2080%205%20T160%205%20T240%205%20T320%205'), '浪线与液体顶部同一浪形（对齐水面）');
  assert.ok(crestRule.includes('background-size:100% 100%'), '浪线随液体元素一起升起');
  // 2) 动态水面波层：贴在水面上的重复波形带（浪是水面本身）；900ms 慢移 + 随水位升高浪幅收小
  const waveRule = tankCss.slice(tankCss.indexOf('.relay-v3-tank-wave{'), tankCss.indexOf('.relay-v3-tank-on .relay-v3-tank-wave{'));
  assert.ok(waveRule.includes('top:0;height:9px'), '水面波层=压在液面顶部的一条波形带（不是整行高的块）');
  assert.ok(waveRule.includes('background:" + TANK_SURF_TILE + " 0 0/96px 9px repeat-x'), '水面波=重复波形带（横向流动）');
  assert.ok(waveRule.includes('transition:background-position .9s ease-out,transform .45s ease,opacity .45s ease'), '波层 900ms 慢移 + 450ms 浪幅收小（水位越高浪越小）');
  assert.ok(source.includes('const TANK_SURF_TILE = unicornVeinUrl(') && source.includes('M0 6 Q8 1 16 6 T32 6 T48 6 T64 6'), '波层贴图=内联波形 SVG（半透明水带 + 白色浪脊）');
  // 新会话预算行：电路纹擦出 + 火星
  assert.ok(tankCss.includes('.relay-v3-tank-veins{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:0;clip-path:inset(0 100% 0 0);transition:opacity .5s ease,clip-path .6s cubic-bezier(.3,.8,.3,1)}'), '电路纹出现有动效：透明度淡入 + 从左到右擦出');
  assert.ok(tankCss.includes('.relay-v3-tank-on .relay-v3-tank-veins{opacity:1;clip-path:inset(0 0 0 0)}'), '开启态电路纹完全擦出');
  assert.ok(source.includes('className: "relay-v3-tank-veins", style: { background: UNICORN_VEINS }'), '电路纹 = 与接力 chip 同一份独角兽纹路贴图');
  assert.ok(tankCss.includes('.relay-v3-tank-on .relay-v3-tank-spark{animation:relay-v3-unicorn-spark 1.7s ease-in-out infinite;opacity:1}'), '火星=chip 同款上飘动画（开启才播）');
  assert.ok(tankCss.includes('.relay-v3-tank-on .relay-v3-tank-spark-2{animation-delay:.55s}') && tankCss.includes('.relay-v3-tank-on .relay-v3-tank-spark-3{animation-delay:1.05s}'), '三颗火星错峰 0/.55/1.05s');
  assert.ok(tankCss.includes('.relay-v3-tank-on .relay-v3-tank-wave{background-position:-192px 0;transform:translateY(0) scaleY(.55);opacity:.7}'), '灌满后波形移到终态、浪幅收小、水面落定');
  assert.equal(tankCss.includes('relay-v3-tank-swell'), false, '没有独立横穿的涌浪块（用户反馈像两个不相关的东西飞过）');
  assert.equal(tankCss.includes('relay-v3-tank-jet'), false, '没有上冲的水舌（飞行物体，已删除）');
  // 4) 飞溅液滴 ×5：小圆 2–4px，各自 dx/dy 不同方向飞出（移出缸体被裁）
  const dropRule = tankCss.slice(tankCss.indexOf('.relay-v3-tank-drop{'), tankCss.indexOf('.relay-v3-tank-drop-1{'));
  assert.ok(dropRule.includes('border-radius:50%') && dropRule.includes('transition:transform .3s ease'), '液滴=小圆 + 300ms ease');
  assert.ok(dropRule.includes('background:#fff'), '液滴=白色水花（在深色底上可见）');
  for (let n = 1; n <= 5; n += 1) assert.ok(tankCss.includes('.relay-v3-tank-drop-' + n + '{left:'), '液滴横向位置 ' + n);
  const dropMoves = ['translate(-26px,-18px)', 'translate(-10px,-26px)', 'translate(6px,-14px)', 'translate(18px,-24px)', 'translate(30px,-10px)'];
  dropMoves.forEach((move, index) => assert.ok(tankCss.includes('.relay-v3-tank-on .relay-v3-tank-drop-' + (index + 1) + '{transform:' + move + '}'), '液滴 ' + (index + 1) + ' 独立方向：' + move));
  // 全局节奏：纯 CSS、delay 0、无 keyframes；水位 450ms、波层 900ms（慢）、其余 300ms；过渡只碰 transform/颜色
  assert.equal(tankCss.includes('@keyframes'), false, '水缸行无 keyframes（纯 transition）');
  assert.equal((tankCss.match(/animation:/g) ?? []).length, 1, '水缸行只有火星一处 animation（其余纯 transition）');
  assert.ok(tankCss.includes('animation:relay-v3-unicorn-spark 1.7s ease-in-out infinite'), '唯一 animation = chip 同款火星上飘');
  assert.equal(/transition-delay:\s*[1-9]/.test(tankCss), false, '水缸过渡无 delay（全部同时开始；火星 animation-delay 错峰是 chip 同款）');
  for (const declaration of tankCss.match(/transition:[^;}]*/g) ?? []) {
    assert.equal(/left|top\b|width|height/.test(declaration), false, '水缸过渡不得触碰布局属性：' + declaration);
    assert.match(declaration, /\.(?:3|45|5|6|9)s (?:ease|ease-out|cubic-bezier)/, '水缸过渡时长在允许范围内：' + declaration);
    assert.equal(/\b\d+ms\b/.test(declaration), false, '水缸过渡没有 ms 时长：' + declaration);
  }
  assert.equal((tankCss.match(/\.9s ease-out/g) ?? []).length, 1, '唯一 900ms 慢元素 = 水面波层');
  assert.equal((tankCss.match(/\.45s /g) ?? []).length, 3, '水位 450ms + 波层浪幅/透明度 450ms（其余 300ms）');
  // DOM 侧：水缸行不再有 canvas；canvas 引擎唯一挂载点 = 「授权下一次操作」按钮
  const rowBegin = source.indexOf('function tankRow(');
  const rowEnd = source.indexOf('// v0.2.14：下一个接力新会话的模式', rowBegin);
  assert.ok(rowBegin >= 0 && rowEnd > rowBegin, 'tankRow 源码块可定位');
  const rowSrc = source.slice(rowBegin, rowEnd);
  assert.equal(rowSrc.includes('canvas'), false, '水缸行 DOM 不含 canvas');
  assert.equal(rowSrc.includes('requestAnimationFrame'), false, '水缸行不引 rAF');
  assert.ok(rowSrc.includes('"aria-hidden": "true"'), '水缸行只有 aria-hidden 装饰层');
  assert.equal(source.includes('relay-v3-tank-canvas'), false, '旧水缸 canvas 类已删除');
  assert.ok(source.includes('ref: tankWaterRef("green", authorized)'), 'canvas 水面引擎挂到「授权下一次操作」按钮');
  assert.ok(source.includes('className: "relay-v3-auth-canvas"'), '按钮内 aria-hidden canvas');
  assert.ok(source.includes('.relay-v3-auth-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:0;pointer-events:none}'), 'canvas 铺满按钮、z-index 低于文字');
  assert.ok(source.includes('.relay-v3-auth-text{position:relative;z-index:1}'), '按钮文字在 canvas 之上');
  assert.ok(source.includes('transition:background-color .3s ease,border-color .3s ease,box-shadow .3s ease,transform 120ms ease}'), '授权按钮 300ms 黄→绿 crossfade（与 canvas 注水同时）');
  // 水面引擎：自包含标记块（证据渲染工程按标记整段抽取复核），原样保留、注释指向新挂载点
  const tankBegin = source.indexOf('// ── TANK-WATER-BEGIN');
  const tankEnd = source.indexOf('// ── TANK-WATER-END');
  assert.ok(tankBegin >= 0 && tankEnd > tankBegin, '水缸引擎=自包含标记块（TANK-WATER-BEGIN/END，证据工程整段抽取）');
  const engine = source.slice(tankBegin, tankEnd);
  assert.ok(engine.includes('授权下一次操作'), '引擎标记块注释说明新挂载点');
  assert.ok(engine.includes('const TANK_WATER = (function () {'), '水缸引擎 = TANK_WATER 模块');
  assert.ok(engine.includes('canvas.getContext("2d")'), '真实 canvas 2D 绘制');
  assert.ok(engine.includes('function create(canvas, tone, on, dpr)'), 'create：按 canvas/三色/开关态建视图');
  assert.ok(engine.includes('view.speed += ((target - view.level) * 45 - view.speed * 6.9) * dt;'), '液面=欠阻尼弹簧（灌满瞬间过冲再晃回）');
  assert.ok(engine.includes('view.sloshSpeed += (-58 * view.slosh - 6.2 * view.sloshSpeed) * dt;'), '横向晃荡（水在缸里左右涌）');
  assert.ok(engine.includes('const packetA = packetOn ? 3.2 * Math.exp(-since / 0.6) * fade : 0;'), '横穿水面的涌浪');
  assert.ok(engine.includes('const surf = (x) => {'), '水面=逐列采样的不规则浪形');
  assert.ok(engine.includes('function snap(view, on)'), 'reduced-motion 直接终态用的 snap');
  assert.ok(engine.includes('matchMedia("(prefers-reduced-motion: reduce)")'), 'reduced-motion 由 matchMedia 判定');
  assert.ok(engine.includes('requestAnimationFrame'), 'rAF 循环驱动');
  assert.ok(engine.includes('TANK_WATER.isSettled(view)'), '关闭且排空即停循环（不空转）');
  assert.ok(engine.includes('stale.isConnected !== false'), 'canvas 卸载后自行释放');
  // 旧实现彻底删除（防回潮）
  assert.equal(source.includes('TANK_WAVE_TILE'), false, '旧浪线瓦片已删除');
  assert.equal(source.includes('relay-v3-tank-water'), false, '旧 CSS 水体层已删除');
  assert.equal(source.includes('relay-v3-tank-slosher'), false, '旧晃荡容器已删除');
  assert.equal(source.includes('relay-v3-tank-orb'), false, '星芒/气泡等参考装饰不存在');
  assert.equal(source.includes('relay-v3-tank-wave-front'), false, '旧浪线 keyframes 已删除');
  // chip 独角兽（不变）
  assert.ok(source.includes('.relay-v3-chip-unicorn{position:relative;overflow:hidden}'), '未到线：独角兽类只有定位/裁剪，无红光呼吸');
  assert.ok(source.includes('.relay-v3-chip-unicorn-glow{box-shadow:0 0 10px 1px rgba(255,45,78,.45),inset 0 0 10px rgba(255,45,78,.30);animation:relay-v3-unicorn-glow 2.6s ease-in-out infinite}'), '已到线：才挂红色描边光 + 呼吸');
  assert.ok(source.includes('UNICORN_VEIN_TILE') && source.includes("stroke='#ff2d4e'"), '纹路=内联红色电路 SVG（非平行斜线）');
  assert.ok(source.includes('UNICORN_VEIN_FINE'), '第二层细纹路增加电路密度');
  assert.ok(source.includes('const unicornChipOverStyle = {'), '过线态才有独立深红底样式');
  assert.ok(source.includes('@keyframes relay-v3-unicorn-glow{'), '红光呼吸关键帧');
  assert.ok(source.includes('@keyframes relay-v3-unicorn-spark{0%{opacity:0;transform:translateY(0) scale(.6)}14%{opacity:1;transform:translateY(-3px) scale(1)}70%{opacity:.85;transform:translateY(-13px) scale(.85)}100%{opacity:0;transform:translateY(-19px) scale(.5)}}'), '火星上飘消散关键帧');
  assert.ok(source.includes('.relay-v3-unicorn-spark:nth-of-type(3){left:81%;animation-delay:1.05s}'), '三颗火星错峰');
  // reduced-motion：多元素过渡全部关闭（直接终态）；引擎 snap 直接画终态
  const reducedSwitch = source.slice(source.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reducedSwitch.includes('.relay-v3-tank,.relay-v3-tank-label,.relay-v3-tank-liquid,.relay-v3-tank-wave,.relay-v3-tank-drop,.relay-v3-tank-veins{transition:none}'), 'reduced-motion 关水缸行/标签/液体/波层/液滴/电路纹过渡');
  assert.ok(reducedSwitch.includes('.relay-v3-tank-spark{animation:none;display:none}'), 'reduced-motion 隐藏火星');
  assert.ok(reducedSwitch.includes('.relay-v3-chip-unicorn-glow{animation:none}'), 'reduced-motion 关红光呼吸');
  assert.ok(reducedSwitch.includes('.relay-v3-unicorn-spark{animation:none;display:none}'), 'reduced-motion 隐藏火星');
});

// ── v0.3.3：模型推荐（relay_recommend → 面板高亮/参考；不改变预设与人类决策权）────────
const RECOMMENDED_AT = Date.UTC(2026, 10, 7, 3, 25);
/** relay 会话面板 fixture（推荐只落在 panel 上；默认不写推荐）。 */
const recommendEnv = (panel) => ({ relay: true, panel: { ...PANEL_DEFAULT, ...(panel || {}) }, live: LIVE() });
/** byClass 用子串匹配（'...-recommend' 也匹配 '...-recommend-tag'）→ 计数断言按 class token 精确匹配。 */
const exactByClass = (tree, className) => byClass(tree, className)
  .filter((node) => String(node.props.className).split(' ').includes(className));
const recommendRow = (instance) => byClass(instance.tree, 'relay-v3-recommend')
  .find((node) => String(node.props.className) === 'relay-v3-recommend');
const recommendOrders = (instance) => exactByClass(instance.tree, 'relay-v3-order')
  .filter((node) => String(node.props.className).split(' ').includes('relay-v3-order-recommend'));
const recommendTagsOf = (tree) => byClass(tree, 'relay-v3-order-recommend-tag')
  .filter((node) => String(node.props.className).split(' ').includes('relay-v3-order-recommend-tag'));
const chipTitleOf = (instance) => String(byClass(instance.tree, 'relay-v3-chip')[0].props.title);

test('RelayPanel：带模型推荐 → popover 推荐行 + 对应档位「荐」高亮 + chip title 追加（只展示不写盘）', async () => {
  const env = createEnv();
  env.server.panel.A = recommendEnv({
    defaultOperation: null,
    recommendedOperation: 'compress',
    recommendedReason: '本会话还没压缩过，先压缩再继续',
    recommendedAt: RECOMMENDED_AT,
  });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));

  // 推荐行 = tag「模型推荐」+ 操作 label + reason + HH:MM
  const row = recommendRow(instance);
  assert.ok(row, 'popover 渲染 .relay-v3-recommend 推荐行');
  const rowText = textOf(row);
  assert.match(rowText, /模型推荐/);
  assert.match(rowText, /压缩继续/, '操作 label 用面板自身的档位名');
  assert.match(rowText, /本会话还没压缩过，先压缩再继续/);
  assert.match(rowText, /\d{2}:\d{2}/, '推荐时间 = HH:MM');
  // 位置：statusText 之后、表盘之前
  const kids = byClass(instance.tree, 'relay-v3-popover')[0].children;
  const statusIndex = kids.findIndex((node) => Array.isArray(node && node.children)
    && typeof node.children[0] === 'string' && node.children[0].startsWith('上下文 '));
  const rowIndex = kids.indexOf(row);
  const dialIndex = kids.findIndex((node) => typeof node?.props?.className === 'string' && node.props.className.includes('relay-v3-dial-wrap'));
  assert.ok(statusIndex >= 0 && rowIndex > statusIndex && dialIndex > rowIndex, '推荐行在状态行之后、表盘之前');

  // 档位：同 operation 的档位加 relay-v3-order-recommend + 内部「荐」标记
  const marked = recommendOrders(instance);
  assert.equal(marked.length, 1, '只有推荐档位被标记');
  assert.match(JSON.stringify(marked[0].children), /压缩继续/);
  const tags = recommendTagsOf(marked[0]);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].children[0], '荐');
  assert.equal(tags[0].props.title, '模型推荐：压缩继续');
  // 不抢选中态：推荐档未选中；选中仍是「问我」（预设决定选中，推荐只做标记）
  const on = exactByClass(instance.tree, 'relay-v3-order')
    .filter((node) => String(node.props.className).split(' ').includes('relay-v3-order-on'));
  assert.equal(on.length, 1);
  assert.match(JSON.stringify(on[0].children), /问我/);
  // chip title 追加推荐；chip 标签仍由预设决定（未被推荐改写）
  assert.match(chipTitleOf(instance), / · 模型推荐 压缩继续/);
  assert.match(textOf(byClass(instance.tree, 'relay-v3-chip')[0]), /问我/);
  // 只展示：打开/轮询不写盘（不改预设、也不消费推荐）
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 0, '推荐不写盘');
});

test('RelayPanel：无模型推荐（旧 host 缺字段 / op=null）不渲染推荐行与高亮', async () => {
  const env = createEnv();
  // 旧 host：完全没有 recommended* 字段
  env.server.panel.A = { relay: true, panel: { ...PANEL_DEFAULT }, live: LIVE() };
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(recommendRow(instance), undefined, '无推荐不渲染推荐行');
  assert.equal(recommendOrders(instance).length, 0, '无推荐不高亮档位');
  assert.equal(recommendTagsOf(instance.tree).length, 0, '无推荐不出现「荐」标记');
  assert.equal(chipTitleOf(instance).includes('模型推荐'), false, 'chip title 不追加推荐');
  // 面板明确 recommendedOperation=null（推荐已消费/清空）→ 同样不渲染
  env.server.panel.B = recommendEnv({ recommendedOperation: null, recommendedReason: '旧理由', recommendedAt: RECOMMENDED_AT });
  instance.render({ sessionId: 'B' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(recommendRow(instance), undefined, 'op=null：行不渲染（旧理由/时间一并作废）');
  assert.equal(recommendOrders(instance).length, 0);
  assert.equal(chipTitleOf(instance).includes('模型推荐'), false);
});

test('v0.3.4 RelayPanel：长模式 compress-then-handoff 推荐整条忽略（无行/无档位/无 chip title）；classic 同值正常展示', async () => {
  const env = createEnv();
  // 长模式：推荐三字段齐全，但该档已从长模式移除 → 当无推荐（UI 不展示，也不写盘）
  env.server.panel.A = longEnv({
    defaultOperation: null,
    recommendedOperation: 'compress-then-handoff',
    recommendedReason: '两段式：先压缩，第二次新会话',
    recommendedAt: RECOMMENDED_AT,
  });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(dialOrders(instance).length, 4, '长模式 4 档（问我+三个操作档）');
  assert.equal(recommendRow(instance), undefined, '长模式不渲染 compress-then-handoff 推荐行');
  assert.equal(recommendOrders(instance).length, 0, '4 档里没有该 operation → 不点档位');
  assert.equal(recommendTagsOf(instance.tree).length, 0, '不点档位也就没有「荐」标记');
  assert.equal(chipTitleOf(instance).includes('模型推荐'), false, 'chip title 不追加推荐');
  assert.equal(env.calls.filter((call) => call.method === 'PUT').length, 0, '忽略推荐不写盘');
  // classic：同一推荐值命中「压缩→新会话」档位（四档仍合法）
  env.server.panel.B = recommendEnv({
    recommendedOperation: 'compress-then-handoff',
    recommendedReason: '两段式：先压缩，第二次新会话',
    recommendedAt: RECOMMENDED_AT,
  });
  instance.render({ sessionId: 'B' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  assert.equal(dialOrders(instance).length, 6, 'classic 6 档');
  assert.ok(recommendRow(instance), 'classic 显示推荐行');
  const marked = recommendOrders(instance);
  assert.equal(marked.length, 1);
  assert.match(JSON.stringify(marked[0].children), /压缩→新会话/);
  assert.equal(recommendTagsOf(marked[0]).length, 1);
  assert.match(chipTitleOf(instance), / · 模型推荐 压缩→新会话/);
});

test('RelayPanel：长模式「接力新会话」（团队重启档）推荐也标「荐」，不覆盖团队重启副标', async () => {
  const env = createEnv();
  env.server.panel.A = longEnv({ recommendedOperation: 'handoff', recommendedReason: '本会话已压缩过，推荐接力', recommendedAt: RECOMMENDED_AT });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const marked = recommendOrders(instance);
  assert.equal(marked.length, 1, '接力新会话档被标记');
  assert.match(JSON.stringify(marked[0].children), /团队重启/, '团队重启副标仍在');
  const tags = recommendTagsOf(marked[0]);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].children[0], '荐');
  assert.equal(tags[0].props.title, '模型推荐：接力新会话');
  assert.match(textOf(recommendRow(instance)), /接力新会话/);
});

test('RelayPanel：推荐理由超 60 字截断（title 留全文），recommendedAt 缺失显示 —', async () => {
  const env = createEnv();
  const reason = '理'.repeat(80);
  env.server.panel.A = recommendEnv({ recommendedOperation: 'handoff', recommendedReason: reason, recommendedAt: null });
  const RelayPanel = env.slots['conversation.composer.dock'];
  const instance = env.mount(RelayPanel, { sessionId: 'A' });
  await instance.flush();
  assert.ok(await openPopover(instance));
  const row = recommendRow(instance);
  assert.ok(row);
  const reasonNode = byClass(row, 'relay-v3-rec-reason')[0];
  assert.ok(reasonNode, '有理由时渲染理由节点');
  assert.equal(reasonNode.children[0].length, 60, '可见理由 ≤60 字');
  assert.equal(reasonNode.children[0], reason.slice(0, 60));
  assert.equal(reasonNode.props.title, reason, 'title 保留全文（host 已截 120）');
  assert.equal(byClass(row, 'relay-v3-rec-time')[0].children[0], '—', '无时间显示 —');
  const marked = recommendOrders(instance);
  assert.equal(marked.length, 1);
  assert.match(JSON.stringify(marked[0].children), /接力新会话/);
});

test('CSS：模型推荐契约（推荐行 + 冷青虚线「荐」高亮 + 微光 + 与选中态区分 + reduced-motion 无动画）', () => {
  assert.ok(source.includes('.relay-v3-recommend{display:flex'), '推荐行样式');
  assert.ok(source.includes('.relay-v3-rec-tag{'), '推荐行 tag');
  assert.ok(source.includes('.relay-v3-rec-op{'), '推荐行操作 label');
  assert.ok(source.includes('.relay-v3-rec-reason{'), '理由单行省略');
  assert.ok(source.includes('.relay-v3-rec-time{'), '时间列');
  assert.match(source, /\.relay-v3-order-recommend\{[^}]*border-style:dashed[^}]*rgba\(127,230,255/, '档位高亮 = 冷青虚线勾边');
  assert.match(source, /\.relay-v3-order-recommend\{[^}]*drop-shadow\(0 0 5px rgba\(127,230,255/, '档位高亮带微光');
  assert.match(source, /\.relay-v3-order-on\.relay-v3-order-recommend\{[^}]*drop-shadow\(0 0 8px rgba\(127,230,255/, '推荐+选中叠加时保留选中冷光（不抢选中态）');
  assert.ok(source.includes('.relay-v3-order-recommend-tag{') && source.includes('border:1px dashed rgba(127,230,255,.75)'), '「荐」标记 = 冷青虚线小牌');
  assert.ok(source.includes('@keyframes relay-v3-recommend-glow{'), '微光呼吸关键帧');
  assert.ok(source.includes('@media (prefers-reduced-motion: reduce){.relay-v3-rec-tag{animation:none}}'), 'reduced-motion 关推荐微光动画');
});

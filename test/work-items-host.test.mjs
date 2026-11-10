/**
 * v0.5.0 工作台账：host 只读路由 GET /context-relay/work-items + 配置透传。
 *
 * 覆盖契约 §4：relay preset gating、启用开关、cwd 缺失降级、文件缺失/损坏/正常三态、非法 sessionId、
 * 非 GET 405，以及四个 workItems 配置键原样透传到 relay-agent 行 config。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { clearPanelMemory } from '../lib/panel-store.js';

const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
const WARNED_KEY = Symbol.for('dsh-context-relay.warned');
const WORK_ITEMS_ROUTE = '/context-relay/work-items';
const WORK_ITEMS_RELATIVE = '.scratch/context-relay/work-items.json';

beforeEach(() => { clearPanelMemory(); delete globalThis[SETTINGS_KEY]; delete globalThis[WARNED_KEY]; });
afterEach(() => { clearPanelMemory(); delete globalThis[SETTINGS_KEY]; });

const tmpPath = (prefix, name = 'store.json') => join(mkdtempSync(join(tmpdir(), prefix)), name);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tempCwd = () => mkdtempSync(join(tmpdir(), 'relay-wi-cwd-'));
const sessionOf = (id, header = {}) => ({ id, header });

/** 极简 host fixture（同 test/index.test.mjs 口径：fake webServer 路由表 + fake sessions 服务）。 */
function fakeHost({ config, sessions } = {}) {
  // 测试隔离：settingsPath/panelPath 指向临时文件，避免读写开发机真实 ~/.dsh 配置。
  const isolatedConfig = { ...(config ?? {}) };
  if (isolatedConfig.settingsPath === undefined) isolatedConfig.settingsPath = tmpPath('relay-wi-settings-');
  if (isolatedConfig.panelPath === undefined) isolatedConfig.panelPath = tmpPath('relay-wi-panel-');
  const routes = new Map();
  const registrations = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    skills: { register: () => () => {} },
    agentPresets: { register: async (definition) => { registrations.push(definition); return () => {}; } },
    get: () => undefined,
    effect: (fn) => fn(),
    inject: (wanted, callback) => {
      if (!wanted.includes('webServer')) return;
      callback({
        effect: (fn) => fn(),
        // headless/服务缺失场景靠不传 sessions 覆盖。
        get: (name) => (name === 'sessions' ? sessions : undefined),
        webServer: { register: (registered) => { routes.set(registered.path, registered); return () => {}; } },
      });
    },
  };
  apply(ctx, isolatedConfig);
  return { registrations, config: isolatedConfig, getRoute: (path = WORK_ITEMS_ROUTE) => routes.get(path) };
}

/** 只读 GET 调用（不读 body，req 只需 on/resume；handler 不会 destroy）。 */
function request(route, { method = 'GET', url = WORK_ITEMS_ROUTE } = {}) {
  return new Promise((resolve) => {
    const out = { statusCode: 0, headers: {}, body: '' };
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:3080' },
      on() { return req; },
      resume() {},
      destroy() { throw new Error('work-items handler must not destroy the request stream'); },
    };
    const res = {
      set statusCode(value) { out.statusCode = value; },
      get statusCode() { return out.statusCode; },
      setHeader(key, value) { out.headers[key] = value; },
      end(value) {
        out.body = String(value);
        let json;
        try { json = JSON.parse(out.body); } catch { json = undefined; }
        resolve({ out, json });
      },
    };
    Promise.resolve(route.handler(req, res)).catch(() => {});
  });
}

const getWorkItems = (host, sessionId) => request(host.getRoute(), { url: WORK_ITEMS_ROUTE + '?sessionId=' + encodeURIComponent(sessionId) });
const relaySession = (cwd, id = 'sess-relay') => ({ get: () => sessionOf(id, { agentPreset: 'relay', cwd }) });

/** 在 <cwd>/.scratch/context-relay/work-items.json 写一份台账。 */
function writeLedger(cwd, ledger = defaultLedger(), relative) {
  const path = join(cwd, relative ?? WORK_ITEMS_RELATIVE);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger), 'utf8');
  return path;
}
function defaultLedger() {
  return {
    version: 1,
    rev: 12,
    updatedAt: '2026-11-10T13:00:00.000Z',
    updatedBy: 'sess-writer',
    items: [
      { id: 'schema', title: '定 schema', status: 'done', evidence: ['lib/agent/work-items.js:1'], updatedAt: '2026-11-10T12:00:00.000Z' },
      {
        id: 'api-export', title: '导出 API', status: 'doing', owner: 'worker-1', next: '写完 handler',
        evidence: ['lib/index.js:120'], acceptance: '单测全绿', depends: ['schema'], phase: 'build',
        updatedAt: '2026-11-10T12:30:00.000Z',
      },
    ],
  };
}

test('host: GET /context-relay/work-items 路由注册为 exact', () => {
  const host = fakeHost();
  const route = host.getRoute();
  assert.ok(route && typeof route.handler === 'function');
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, WORK_ITEMS_ROUTE);
});

test('host: work-items 非法/缺失 sessionId → 400 invalid-session-id（既有错误文案不变）', async () => {
  const host = fakeHost();
  const badIds = ['', 'x'.repeat(201), '__proto__', 'a\u0000b', 'bad id', 'session/evil'];
  for (const badId of badIds) {
    const got = await getWorkItems(host, badId);
    assert.equal(got.out.statusCode, 400, '应拒绝非法 sessionId: ' + JSON.stringify(badId));
    assert.equal(got.json.ok, false);
    assert.equal(got.json.code, 'invalid-session-id');
    assert.equal(got.json.message, 'invalid sessionId');
  }
  const missing = await request(host.getRoute());
  assert.equal(missing.out.statusCode, 400);
  assert.equal(missing.json.code, 'invalid-session-id');
});

test('host: work-items 非 relay preset / sessions 缺失 → relay:false + workItems:null（不 404）', async () => {
  const cwd = tempCwd();
  writeLedger(cwd);
  const ptc = fakeHost({ sessions: { get: () => sessionOf('sess-ptc', { agentPreset: 'ptc', cwd }) } });
  const got = await getWorkItems(ptc, 'sess-ptc');
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.ok, true);
  assert.equal(got.json.relay, false);
  assert.equal(got.json.enabled, true);
  assert.equal(got.json.workItems, null, '非 relay 会话不下发台账内容');
  // headless/极简宿主：无 sessions 服务 → 按非 relay 降级，不抛错。
  const headless = fakeHost();
  const degraded = await getWorkItems(headless, 'sess-any');
  assert.equal(degraded.out.statusCode, 200);
  assert.equal(degraded.json.relay, false);
  assert.equal(degraded.json.workItems, null);
});

test('host: work-items relay 会话无台账文件 → 200 + workItems:null + 默认相对路径', async () => {
  const cwd = tempCwd();
  const got = await getWorkItems(fakeHost({ sessions: relaySession(cwd) }), 'sess-relay');
  assert.equal(got.out.statusCode, 200);
  assert.deepEqual(got.json, {
    ok: true,
    sessionId: 'sess-relay',
    relay: true,
    enabled: true,
    path: WORK_ITEMS_RELATIVE,
    corrupt: false,
    workItems: null,
  });
});

test('host: work-items relay 会话 cwd 不可得 → 200 + workItems:null（不 500）', async () => {
  const host = fakeHost({ sessions: { get: () => sessionOf('sess-relay', { agentPreset: 'relay' }) } });
  const got = await getWorkItems(host, 'sess-relay');
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.relay, true);
  assert.equal(got.json.enabled, true);
  assert.equal(got.json.workItems, null);
});

test('host: work-items 有台账 → rev/updatedAt/counts/items + 相对路径', async () => {
  const cwd = tempCwd();
  writeLedger(cwd);
  const got = await getWorkItems(fakeHost({ sessions: relaySession(cwd) }), 'sess-relay');
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.ok, true);
  assert.equal(got.json.relay, true);
  assert.equal(got.json.enabled, true);
  assert.equal(got.json.path, WORK_ITEMS_RELATIVE);
  assert.equal(got.json.corrupt, false);
  const workItems = got.json.workItems;
  assert.ok(workItems !== null && typeof workItems === 'object');
  assert.equal(workItems.rev, 12);
  assert.equal(workItems.updatedAt, '2026-11-10T13:00:00.000Z');
  assert.ok(Array.isArray(workItems.items));
  assert.equal(workItems.items.length, 2);
  const doing = workItems.items.find((item) => item.id === 'api-export');
  const done = workItems.items.find((item) => item.id === 'schema');
  assert.equal(doing.status, 'doing');
  assert.equal(doing.title, '导出 API');
  assert.equal(doing.owner, 'worker-1');
  assert.equal(doing.next, '写完 handler');
  assert.equal(done.status, 'done');
  assert.equal(workItems.counts.total, 2);
  assert.equal(workItems.counts.open, 0);
  assert.equal(workItems.counts.doing, 1);
  assert.equal(workItems.counts.blocked, 0);
  assert.equal(workItems.counts.done, 1);
  assert.equal(typeof workItems.counts.pending, 'number');
});

test('host: work-items 损坏台账 → corrupt:true + workItems:null + 隔离备份（fail-open）', async () => {
  const cwd = tempCwd();
  const path = join(cwd, WORK_ITEMS_RELATIVE);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{ broken ledger', 'utf8');
  const got = await getWorkItems(fakeHost({ sessions: relaySession(cwd) }), 'sess-relay');
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.corrupt, true);
  assert.equal(got.json.workItems, null);
  assert.equal(got.json.path, WORK_ITEMS_RELATIVE);
  const backups = readdirSync(join(cwd, '.scratch', 'context-relay')).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1, '损坏文件必须隔离备份');
});

test('host: config workItems:false → enabled:false + workItems:null（文件存在也不读）', async () => {
  const cwd = tempCwd();
  writeLedger(cwd);
  const host = fakeHost({ config: { workItems: false }, sessions: relaySession(cwd) });
  const got = await getWorkItems(host, 'sess-relay');
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.relay, true);
  assert.equal(got.json.enabled, false);
  assert.equal(got.json.workItems, null);
});

test('host: config workItemsPath 覆盖台账路径（相对路径按会话 cwd 解析）', async () => {
  const cwd = tempCwd();
  writeLedger(cwd, defaultLedger(), 'custom/ledger.json');
  const host = fakeHost({ config: { workItemsPath: 'custom/ledger.json' }, sessions: relaySession(cwd) });
  const got = await getWorkItems(host, 'sess-relay');
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.workItems.rev, 12);
  assert.match(got.json.path, /custom[\\/]ledger\.json$/);
});

test('host: work-items 非 GET → 405（既有文案不变）', async () => {
  const host = fakeHost();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const got = await request(host.getRoute(), { method });
    assert.equal(got.out.statusCode, 405, method + ' 应 405');
    assert.equal(got.json.ok, false);
    assert.equal(got.json.message, 'method not allowed');
  }
});

test('host: 四个 workItems 配置键原样透传到 relay-agent 行 config（缺省不污染）', async () => {
  const host = fakeHost({ config: { workItems: false, workItemsGate: 'warn', workItemsPath: '/tmp/custom-ledger.json', workItemsMax: 50 } });
  await tick(); // 异步 register 落定
  assert.equal(host.registrations.length, 2);
  const agentRow = host.registrations[0].plugins.find((row) => row.id === 'compaction').config.at(-1);
  assert.equal(agentRow.id, 'relay-agent');
  assert.equal(agentRow.config.workItems, false);
  assert.equal(agentRow.config.workItemsGate, 'warn');
  assert.equal(agentRow.config.workItemsPath, '/tmp/custom-ledger.json');
  assert.equal(agentRow.config.workItemsMax, 50);
  // 缺省（未配置）不写入行 config：不污染 preset 定义。
  const plain = fakeHost();
  await tick();
  const plainRow = plain.registrations[0].plugins.find((row) => row.id === 'compaction').config.at(-1);
  for (const key of ['workItems', 'workItemsGate', 'workItemsPath', 'workItemsMax']) {
    assert.equal(Object.prototype.hasOwnProperty.call(plainRow.config, key), false, key + ' 缺省不写入');
  }
});

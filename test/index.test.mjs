import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { apply, relayPresetDefinition } from '../lib/index.js';
import { PTC_BASE_PLUGINS } from '../lib/preset-base.js';
import { RELAY_PROJECTION_KEY } from '../lib/projection.js';
import { normalizePanelState, panelDefaultsOf, resolveEffectiveThresholds, thresholdsFromPercent } from '../lib/policy.js';
import {
  LIVE_TTL_MS,
  clearPanelMemory,
  configurePanelStore,
  panelStateOf,
  publishLiveState,
  resolvePanelState,
  updatePanelState,
} from '../lib/panel-store.js';

const PTC_PATCH_FIXED = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml';
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
// v0.2.7：host apply 会把 settings 默认值（DEFAULT_SETTINGS.unlimitedBudget=true）发布成面板默认值，
// 因此路由返回的面板基线包含 unlimitedBudget:true（handoffUnlimitedBudget 缺省 null）。
const PANEL_DEFAULT = resolvePanelState({ defaults: { unlimitedBudget: true, architect: true } });

beforeEach(() => { clearPanelMemory(); delete globalThis[SETTINGS_KEY]; delete globalThis[Symbol.for('dsh-context-relay.warned')]; });
afterEach(() => { clearPanelMemory(); delete globalThis[SETTINGS_KEY]; });

/** 官方 DSH 安装根：固定路径优先，退回 `which dsh`；都找不到返回 undefined（相关测试 skip）。 */
function officialDshRoot() {
  const fixed = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
  if (existsSync(fixed)) return fixed;
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    return dirname(dirname(realpathSync(bin)));
  } catch {
    return undefined;
  }
}

function officialPtcPatchPath() {
  if (existsSync(PTC_PATCH_FIXED)) return PTC_PATCH_FIXED;
  const root = officialDshRoot();
  if (root === undefined) return undefined;
  const candidate = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'ptc.patch.yml');
  return existsSync(candidate) ? candidate : undefined;
}

/** 行级抽取官方 patch 的 (id, name, hasDisabled)；不引 YAML 依赖（该文件结构固定）。 */
function parseOfficialPatchRows(text) {
  const rows = [];
  let row;
  const push = () => {
    if (row !== undefined && row.name !== undefined) rows.push(row);
    row = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^-\s+/, '');
    const idMatch = /^id:\s*'?([^'\s]+)'?$/.exec(line);
    if (idMatch !== null) { push(); row = { id: idMatch[1] }; continue; }
    if (row === undefined) continue;
    const nameMatch = /^name:\s*'?([^'\s]+)'?$/.exec(line);
    if (nameMatch !== null && row.name === undefined) { row.name = nameMatch[1]; continue; }
    if (/^disabled:/.test(line)) row.disabled = true;
  }
  push();
  // 顶层 insert 的 preset 声明行 + 其 config.id 不是插件行。
  return rows.filter((entry) => entry.id !== 'preset-ptc' && entry.id !== 'ptc');
}

/** 展平 preset 定义的行（group 的 config 数组也是行）。 */
function flattenPresetRows(rows, out = []) {
  for (const row of rows) {
    out.push(row);
    if (Array.isArray(row.config)) flattenPresetRows(row.config, out);
  }
  return out;
}

const rowKey = (row, withDisabled) => row.id + '|' + row.name + '|' + (withDisabled ? 'disabled' : '');

/** 测试隔离用的临时路径（每次 unique，避免测到开发机真实 ~/.dsh 配置/面板状态）。 */
const tmpPath = (prefix, name = 'store.json') => join(mkdtempSync(join(tmpdir(), prefix)), name);

function fakeHost({ connection, noGet = false, agentPresets, config, sessionProjections, sessions, llm, agentDefaultModel, agents } = {}) {
  // 测试隔离：settingsPath/panelPath 默认指向临时文件，避免读写开发机真实 ~/.dsh/... 配置
  // （真实 settings.json 的默认值会经 panel-store 合并进 panel 默认值）。
  const isolatedConfig = { ...(config ?? {}) };
  if (isolatedConfig.settingsPath === undefined) isolatedConfig.settingsPath = tmpPath('relay-host-settings-');
  if (isolatedConfig.panelPath === undefined) isolatedConfig.panelPath = tmpPath('relay-host-panel-');
  const routes = new Map();
  const cleanups = [];
  const registrations = [];
  const warnings = [];
  const stats = { registerCalls: 0, disposeCalls: 0 };
  const logger = { info() {}, warn: (message) => warnings.push(String(message)) };
  const presets = agentPresets ?? {
    register: async (definition) => {
      stats.registerCalls += 1;
      registrations.push(definition);
      return () => { stats.disposeCalls += 1; };
    },
  };
  const ctx = {
    logger,
    skills: { register: () => () => {} },
    agentPresets: presets,
    get: (name) => (name === 'sessionProjections' ? sessionProjections : undefined),
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
    inject: (wanted, callback) => {
      if (wanted.includes('webServer')) {
        const injected = {
          effect: (fn) => { fn(); },
          webServer: {
            register: (registered) => { routes.set(registered.path, registered); return () => {}; },
          },
        };
        // headless / 极简 fake ctx 可能没有 get：验证放行路径时不注入。
        if (!noGet) injected.get = (name) => (name === 'connection' ? connection : name === 'sessions' ? sessions : name === 'sessionProjections' ? sessionProjections : name === 'llm' ? llm : name === 'agentDefaultModel' ? agentDefaultModel : name === 'agents' ? agents : undefined);
        callback(injected);
      }
      if (wanted.includes('sessionProjections') && sessionProjections !== undefined) {
        callback({
          effect: (fn) => {
            const dispose = fn();
            if (typeof dispose === 'function') cleanups.push(dispose);
            return dispose;
          },
          sessionProjections,
          logger,
        });
      }
    },
  };
  apply(ctx, isolatedConfig);
  return { ctx, cleanups, registrations, stats, warnings, config: isolatedConfig, getRoute: (path = '/context-relay/settings') => routes.get(path) };
}

function call(route, { method = 'GET', headers = {} } = {}) {
  const out = { statusCode: 0, headers: {}, body: '' };
  const req = { method, url: '/context-relay/settings', headers: Object.assign({ host: '127.0.0.1:3080' }, headers) };
  const res = {
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader: (k, v) => { out.headers[k] = v; },
    end: (body) => { out.body = body; },
  };
  route.handler(req, res);
  let json;
  try { json = JSON.parse(out.body); } catch { json = undefined; }
  return { out, json };
}

/** 异步路由调用（GET 带 query / PUT 带 body；自动 finish req 流）。 */
function callAsync(route, { method = 'GET', headers = {}, body = '', url = '/context-relay/settings' } = {}) {
  return new Promise((resolve) => {
    const out = { statusCode: 0, headers: {}, body: '' };
    const listeners = {};
    const req = {
      method,
      url,
      headers: Object.assign({ host: '127.0.0.1:3080' }, headers),
      on(event, fn) { listeners[event] = fn; return req; },
      resume() {},
      // 超限时不得 destroy 连接（真实 HTTP 下客户端会收不到 413 JSON）——调用即失败。
      destroy() { throw new Error('readJsonBody must not destroy the request stream'); },
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
    if (body !== '') listeners.data?.(Buffer.from(body));
    listeners.end?.();
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const jsonHeaders = { 'content-type': 'application/json' };
const putSettings = (host, body) => callAsync(host.getRoute('/context-relay/settings'), { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) });
const putPanel = (host, body) => callAsync(host.getRoute('/context-relay/panel'), { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) });
const getPanel = (host, sessionId) => callAsync(host.getRoute('/context-relay/panel'), { url: '/context-relay/panel?sessionId=' + encodeURIComponent(sessionId) });

/** 真实 http server（验证超限 body 的错误语义，不被 fake req 假绿）。 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function httpRequest({ port, path, method = 'PUT', body = '' }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ kind: 'response', status: res.statusCode, body: data }));
    });
    req.on('error', (error) => resolve({ kind: 'error', code: error.code, message: error.message }));
    req.setTimeout(5000, () => req.destroy(new Error('client-timeout')));
    req.end(body);
  });
}

test('host: connection.requestRejection 401/403 时路由直接拒绝', () => {
  for (const status of [401, 403]) {
    let seenRequest;
    const { getRoute } = fakeHost({
      connection: { requestRejection: (request) => { seenRequest = request; return status; } },
    });
    const { out } = call(getRoute(), { headers: { cookie: 'unsigned=1' } });
    assert.equal(out.statusCode, status);
    assert.match(out.headers['content-type'], /text\/plain/);
    assert.equal(out.headers['cache-control'], 'no-store');
    assert.equal(out.body, status === 401 ? 'unauthorized' : 'forbidden');
    // 契约：ConnectionTrustRequest = { headers }，直接转交原始请求头。
    assert.deepEqual(Object.keys(seenRequest), ['headers']);
    assert.equal(seenRequest.headers.cookie, 'unsigned=1');
  }
});

test('host: 认证层异常 fail-closed 503 JSON（不退化宿主 400 空 body，P3 统一错误语义）', async () => {
  const host = fakeHost({ connection: { requestRejection: () => { throw new Error('connection boom'); } } });
  const got = await callAsync(host.getRoute('/context-relay/panel'), { url: '/context-relay/panel?sessionId=sess-auth-throw' });
  assert.equal(got.out.statusCode, 503);
  assert.equal(got.out.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(got.json.ok, false);
  assert.equal(got.json.code, 'auth-unavailable');
  assert.equal(host.warnings.some((line) => /requestRejection threw/.test(line)), true);
});

test('host: handler 异常统一 500 JSON（不退化宿主 400 空 body）', async () => {
  const host = fakeHost();
  // 让 panelStateOf 的内部依赖抛错（侧栏设置发布位被投毒）→ handler 抛错 → guarded 兜底。
  globalThis[SETTINGS_KEY] = Object.defineProperty({}, 'defaultOperation', { get() { throw new Error('poisoned settings'); }, enumerable: true });
  const got = await callAsync(host.getRoute('/context-relay/panel'), { url: '/context-relay/panel?sessionId=sess-handler-fail' });
  assert.equal(got.out.statusCode, 500);
  assert.equal(got.json.ok, false);
  assert.equal(got.json.code, 'handler-failed');
  assert.match(got.json.message, /poisoned settings/);
});

test('host: 无 connection 服务时放行（headless/测试）', () => {
  // connection 服务缺省
  assert.equal(call(fakeHost().getRoute()).out.statusCode, 200);
  // 连 ctx.get 都没有（极简 fake / headless）
  assert.equal(call(fakeHost({ noGet: true }).getRoute()).out.statusCode, 200);
  // 已认证（requestRejection 返回 undefined）→ 放行
  assert.equal(call(fakeHost({ connection: { requestRejection: () => undefined } }).getRoute()).out.statusCode, 200);
});

test('preset：官方 ptc 行数据 + relay agent 行插入 compaction 隔离组', () => {
  const definition = relayPresetDefinition({ presetId: 'relay-long' });
  assert.equal(definition.id, 'relay-long');
  // v0.9.0 单一模式（D9=B）：显示名保留双名，id 仍 relay-long。
  assert.equal(definition.name, '接力模式（Relay）· 超长任务');
  assert.equal(definition.order, 5);
  assert.match(definition.description, /唯一模式/);
  const flat = flattenPresetRows(definition.plugins);
  const ids = flat.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'plugin id 不得重复: ' + ids.join(','));
  // relay agent 行必须落在 compaction 隔离组末尾（否则 preset 内拿不到 ctx.compaction）。
  const compaction = definition.plugins.find((row) => row.id === 'compaction');
  assert.ok(compaction !== undefined && Array.isArray(compaction.config));
  const agentRow = compaction.config.at(-1);
  assert.equal(agentRow.id, 'relay-agent');
  assert.equal(agentRow.config.presetId, 'relay-long');
  assert.equal(Object.prototype.hasOwnProperty.call(agentRow.config, 'thresholds'), false, 'v0.10.0：legacy thresholds 不再进 preset 行 config');
  assert.match(agentRow.name, /\/lib\/agent\.js(\?relay=\d+)?$/);
  // 缺省不传 agent 选项：不写入行 config（不污染 preset 定义）。
  assert.equal(Object.prototype.hasOwnProperty.call(agentRow.config, 'injectBrief'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(agentRow.config, 'handoffApproval'), false);
  // PTC 执行面是 relay preset 的前提（0.2.2 起官方行是 tool-executor-ptc）。
  assert.ok(flat.some((row) => row.id === 'tool-executor-ptc' && row.name === '@deepseek-ai/dsh-tool-executor-ptc'));
  // 数据资产只含官方行；relay 专属行由 relayPresetDefinition 叠加。
  assert.equal(PTC_BASE_PLUGINS.some((row) => row.id === 'relay-agent'), false);
  // 组合不得污染冻结的数据资产。
  assert.equal(flattenPresetRows(PTC_BASE_PLUGINS).some((row) => row.id === 'relay-agent'), false);
});

test('preset：ask_user_question 行叠加官方 timed 配置 + timeout:60（v0.2.11：提问只用于简单问题、超时 pending 后继续）', () => {
  const flat = flattenPresetRows(relayPresetDefinition({ presetId: 'relay' }).plugins);
  const askRow = flat.find((row) => row.id === 'tool-ask-user');
  assert.deepEqual(askRow.config, { mode: 'timed', timeout: 60 });
  // 官方行数据资产保持原样：timed 配置只叠加在组合结果上（漂移测试仍与官方 patch 行级一致）。
  assert.equal(flattenPresetRows(PTC_BASE_PLUGINS).find((row) => row.id === 'tool-ask-user').config, undefined);
});

test('preset：官方 base 缺 tool-ask-user 行时 fail loud（relay 协议依赖提问工具）', () => {
  const base = PTC_BASE_PLUGINS.filter((row) => row.id !== 'tool-ask-user');
  assert.throws(
    () => relayPresetDefinition({ presetId: 'relay', basePlugins: base }),
    /tool-ask-user row/,
  );
});

test('preset：叠加 timed 配置是合并而非覆盖（保留官方行已有 config）', () => {
  const base = PTC_BASE_PLUGINS.map((row) => (row.id === 'tool-ask-user' ? { ...row, config: { extra: true } } : row));
  const flat = flattenPresetRows(relayPresetDefinition({ presetId: 'relay', basePlugins: base }).plugins);
  assert.deepEqual(flat.find((row) => row.id === 'tool-ask-user').config, { extra: true, mode: 'timed', timeout: 60 });
});

test('preset：apply 只注册唯一模式；agent 行选项白名单透传（退役 routerMode/classic 别名已删）', async () => {
  const host = fakeHost({
    config: { presetId: 'relay', injectBrief: false, handoffApproval: 'prompt', delegationGate: 'off', unrelated: 'drop-me' },
  });
  await tick(); // 异步 register 落定
  assert.equal(host.registrations.length, 1, 'v0.10.0 只剩唯一生产模式（classic 别名已删）');
  const single = host.registrations[0];
  assert.equal(single.id, 'relay-long');
  assert.equal(single.name, '接力模式（Relay）· 超长任务');
  assert.equal(single.order, 5);
  assert.doesNotMatch(single.description, /旧会话兼容/);
  const agentRow = single.plugins.find((row) => row.id === 'compaction').config.at(-1);
  assert.equal(agentRow.id, 'relay-agent');
  assert.equal(agentRow.config.presetId, 'relay-long');
  assert.deepEqual(agentRow.config.relayPresetIds, ['relay-long'], 'agent 面白名单只有唯一模式 id');
  // 白名单透传：只带 agent 选项，不把整份 host config 漏进 preset 行。
  assert.equal(agentRow.config.injectBrief, false);
  assert.equal(agentRow.config.handoffApproval, 'prompt');
  assert.equal(agentRow.config.delegationGate, 'off', 'v0.9.0 批次3：delegationGate 白名单透传到 agent 行');
  assert.equal(Object.prototype.hasOwnProperty.call(agentRow.config, 'unrelated'), false);
  // 退役字段不再出现在行 config（thresholds/routerMode/legacyPresetCompat 均删）。
  for (const key of ['thresholds', 'routerMode', 'legacyPresetCompat']) {
    assert.equal(Object.prototype.hasOwnProperty.call(agentRow.config, key), false, '退役 key 不得进 preset 行：' + key);
  }
  // 缺省（不传 agent 选项）：行 config 只有 presetId + relayPresetIds + 测试隔离注入的 panelPath。
  const plain = fakeHost();
  await tick();
  for (const definition of plain.registrations) {
    const row = definition.plugins.find((item) => item.id === 'compaction').config.at(-1);
    assert.deepEqual(Object.keys(row.config).sort(), ['panelPath', 'presetId', 'relayPresetIds']);
    assert.equal(Object.prototype.hasOwnProperty.call(row.config, 'thresholds'), false);
  }
  // 退役 host config（thresholds/routerMode/legacyPresetCompat）只被忽略：不再 warn、不影响注册/行 config。
  const retiredConfig = fakeHost({ config: { presetId: 'relay', thresholds: {}, routerMode: false, legacyPresetCompat: false } });
  await tick();
  assert.equal(retiredConfig.registrations.length, 1);
  assert.equal(retiredConfig.warnings.some((line) => /legacy|routerMode|thresholds/i.test(line)), false, '退役配置不再有专用 warn');
  // custom presetId/longPresetId 语义：唯一 id 取 longPresetId ?? presetId+'-long'。
  const custom = fakeHost({ config: { presetId: 'myrelay', longPresetId: 'myrelay-long' } });
  await tick();
  assert.deepEqual(custom.registrations.map((definition) => definition.id), ['myrelay-long']);
  const customRow = custom.registrations[0].plugins.find((row) => row.id === 'compaction').config.at(-1);
  assert.deepEqual(customRow.config.relayPresetIds, ['myrelay-long']);
});

test('preset：delegationGate 非法值不崩（注册照常；归一为 warn 在 agent 面，strict 原样透传）', async () => {
  const host = fakeHost({ config: { delegationGate: 'banana' } });
  await tick();
  assert.equal(host.registrations.length, 1, '非法 delegationGate 不阻断 preset 注册');
  const row = host.registrations[0].plugins.find((item) => item.id === 'compaction').config.at(-1);
  assert.equal(row.config.delegationGate, 'banana', 'host 层只透传；非法值由 agent 面 normalizeDelegationConfig 归一为 warn');
  const strictHost = fakeHost({ config: { delegationGate: 'strict' } });
  await tick();
  const strictRow = strictHost.registrations[0].plugins.find((item) => item.id === 'compaction').config.at(-1);
  assert.equal(strictRow.config.delegationGate, 'strict', 'strict 原样透传（v0.10.0 C14b 起 agent 面原样生效）');
});

test('preset：行集合与官方 ptc.patch.yml 一致（找不到官方文件时 skip）', (t) => {
  const path = officialPtcPatchPath();
  if (path === undefined) {
    t.skip('未找到官方 dsh-web-app/presets/ptc.patch.yml（非本机 DSH 安装），跳过漂移对比');
    return;
  }
  const official = parseOfficialPatchRows(readFileSync(path, 'utf8'))
    .map((row) => rowKey(row, row.disabled === true))
    .sort();
  const ours = flattenPresetRows(relayPresetDefinition({ presetId: 'relay' }).plugins)
    .filter((row) => row.id !== 'relay-agent')
    .map((row) => rowKey(row, Object.prototype.hasOwnProperty.call(row, 'disabled')))
    .sort();
  assert.deepEqual(ours, official);
});

test('package.json：engines 下限与 client.inject 条目真实存在（找不到 DSH 时 skip）', (t) => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dsh.engines.dsh, '>=0.2.2-rc.2');
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'));
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'));
  const root = officialDshRoot();
  if (root === undefined) {
    t.skip('未找到官方 DSH 安装根，跳过 client.inject 存在性对比');
    return;
  }
  const missing = pkg.dsh.client.inject.filter((name) => !existsSync(join(root, 'node_modules', name, 'package.json')));
  assert.deepEqual(missing, [], 'client.inject 指向不存在的包: ' + missing.join(','));
});

test('卸载：注册已完成时 teardown 返回 Promise 并注销 preset', async () => {
  const host = fakeHost({ config: { presetId: 'relay' } });
  await tick(); // 让异步 register 落定
  assert.equal(host.stats.registerCalls, 1);
  assert.deepEqual(host.registrations.map((definition) => definition.id), ['relay-long']);
  assert.equal(host.cleanups.length, 1);
  const teardown = host.cleanups[0]();
  assert.ok(teardown instanceof Promise, 'teardown 必须返回 Promise，cordis 才会 await');
  await teardown;
  assert.equal(host.stats.disposeCalls, 1);
});

test('卸载竞态：register 未完成即 teardown，落定后 preset 只注销一次（不残留/不重复注册）', async () => {
  const stats = { registerCalls: 0, disposeCalls: 0 };
  const pending = [];
  const agentPresets = {
    register: () => {
      stats.registerCalls += 1;
      return new Promise((resolve) => { pending.push(() => resolve(() => { stats.disposeCalls += 1; })); });
    },
  };
  const host = fakeHost({ agentPresets });
  // register 尚未落定时卸载：teardown 必须等注册完成再撤销，否则旧 preset 残留、热重载会重名。
  const teardown = host.cleanups[0]();
  assert.ok(teardown instanceof Promise);
  pending[0]();
  await teardown;
  assert.equal(stats.registerCalls, 1);
  assert.equal(stats.disposeCalls, 1);
  await tick(); // 之后的微任务不得再注册/重复注销
  assert.equal(stats.registerCalls, 1);
  assert.equal(stats.disposeCalls, 1);
});

test('preset：唯一模式注册失败 → 只 warn，不阻断插件其余注册', async () => {
  const registered = [];
  const agentPresets = {
    register: async (definition) => {
      if (definition.id === 'relay-long') throw new Error('single mount failed');
      registered.push(definition.id);
      return () => {};
    },
  };
  const host = fakeHost({ agentPresets });
  await tick();
  assert.deepEqual(registered, [], '唯一模式注册失败后没有其它 preset 可注册');
  assert.equal(host.warnings.some((line) => /preset "relay-long" registration failed/.test(line)), true);
  assert.notEqual(host.getRoute('/context-relay/settings'), undefined, 'preset 失败不影响 HTTP 面');
});

/** 最小 sessionProjections 服务 fake：捕获 definition 与 disposer 调用。 */
function fakeProjections() {
  const registered = [];
  const disposed = [];
  return {
    registered,
    disposed,
    service: {
      register: (definition) => {
        registered.push(definition);
        return () => { disposed.push(definition.key); };
      },
    },
  };
}

test('host: 向官方 sessionProjections 注册 relay 投影（形状/一次/卸载注销）', async () => {
  const projections = fakeProjections();
  const host = fakeHost({ sessionProjections: projections.service });
  // 注册恰好一次，definition 形状符合官方 register 契约（key/stateVersion/stateSchema/init/apply）。
  assert.equal(projections.registered.length, 1);
  const definition = projections.registered[0];
  assert.equal(definition.key, RELAY_PROJECTION_KEY);
  assert.equal(Number.isInteger(definition.stateVersion), true);
  assert.ok(definition.stateVersion >= 0);
  assert.equal(typeof definition.stateSchema?.parse, 'function');
  assert.equal(typeof definition.init, 'function');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(host.warnings.some((line) => /sessionProjections/.test(line)), false);
  // registry 会直接调 init/apply：不抛，且不关心的事件必须返回同一 state 引用（官方 Object.is 门）。
  const state = definition.init({ id: 'session-test', cwd: '/tmp' }, 0);
  assert.equal(typeof state, 'object');
  assert.notEqual(state, null);
  assert.equal(Object.is(definition.apply(state, { seq: 0, type: 'turn/start', data: {} }), state), true);
  // 卸载：投影 disposer 随本插件 fiber 注销被调用一次。
  assert.deepEqual(projections.disposed, []);
  for (const dispose of host.cleanups) await dispose();
  assert.deepEqual(projections.disposed, [RELAY_PROJECTION_KEY]);
});

test('host: sessionProjections 缺失时安全跳过并 warn，路由/preset 不受影响', async () => {
  const host = fakeHost();
  assert.equal(host.warnings.some((line) => /sessionProjections unavailable/.test(line)), true);
  assert.notEqual(host.getRoute(), null);
  await tick();
  assert.equal(host.registrations.length, 1); // preset 注册路径照常（唯一模式）
});

const DEFAULT_SETTINGS = Object.freeze({
  threshold: 35, capacityThreshold: 55, defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true,
});

test('host: settings 路由 GET/PUT 五字段、持久化、发布 globalThis，退役/旧字段忽略', async () => {
  const settingsPath = tmpPath('relay-settings-');
  const host = fakeHost({ config: { presetId: 'relay', settingsPath } });
  const route = host.getRoute('/context-relay/settings');
  assert.ok(route && typeof route.handler === 'function');
  assert.equal(route.kind, 'exact');
  const got = await callAsync(route);
  assert.equal(got.out.statusCode, 200);
  // 2026-10-25 v2 口径（v0.10 C10 删 autoChoose）：侧栏设置 = 阈值基准 + 面板默认值，形状固定五字段。
  assert.deepEqual(got.json.settings, DEFAULT_SETTINGS);
  assert.deepEqual(got.json.thresholds, thresholdsFromPercent(DEFAULT_SETTINGS.threshold));
  assert.equal(got.json.path, settingsPath);
  assert.equal(Object.prototype.hasOwnProperty.call(got.json, 'explicit'), false, 'explicit 双口径随 legacy thresholds 一并删除');
  // apply 时把五字段一起发布到 globalThis（panel-store 据此得到按会话面板的默认值）
  assert.deepEqual(globalThis[SETTINGS_KEY], DEFAULT_SETTINGS);
  const putBody = { threshold: 60, defaultOperation: 'compress-then-handoff', autoChoose: true, autoCompress: true, autoHandoff: true, unlimitedBudget: false, architect: false };
  // 退役 autoChoose / 未知 cth 值一律丢弃/归一 null（不 400）。
  const putExpected = { threshold: 60, capacityThreshold: 55, defaultOperation: null, autoCompress: true, autoHandoff: true, unlimitedBudget: false, architect: false };
  const put = await callAsync(route, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(putBody) });
  assert.equal(put.out.statusCode, 200);
  assert.equal(put.json.persisted, true);
  assert.deepEqual(put.json.settings, putExpected);
  assert.deepEqual(put.json.thresholds, thresholdsFromPercent(60));
  // 往返：GET 回读同样五字段（文件 → 内存）
  assert.deepEqual((await callAsync(route)).json.settings, putExpected);
  // 文件五字段落盘
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), putExpected);
  // 发布到 globalThis：含全部字段（panel-store 读作默认值）
  const live = globalThis[SETTINGS_KEY];
  for (const [key, value] of Object.entries(putExpected)) assert.deepEqual(live[key], value, 'published ' + key);
  // 旧字段忽略；非法默认操作归一化 null（不 400）；autoHandoff 现在是合法默认值。
  // 2026-10-25 v2：PUT 是**部分更新合并**——未提供的字段保留当前值（旧缓存 client 只传 threshold 不会清掉默认值）。
  const legacy = await callAsync(route, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ threshold: 65, defaultOperation: 'bogus', autoPhase: true, autoContinue: true, autoApprove: true, autoHandoff: true }),
  });
  assert.equal(legacy.out.statusCode, 200);
  // body 显式给 defaultOperation（非法值归一为 null，语义=「问我」预设模式）
  assert.deepEqual(legacy.json.settings, { threshold: 65, capacityThreshold: 55, defaultOperation: null, autoCompress: true, autoHandoff: true, unlimitedBudget: false, architect: false });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), legacy.json.settings);
  assert.equal(globalThis[SETTINGS_KEY].autoPhase, undefined);
  assert.equal(globalThis[SETTINGS_KEY].autoContinue, undefined);
  // 阈值裁剪到 [20,85]；只传 threshold 时其余默认值保持（部分更新）
  const clipped = await callAsync(route, { method: 'PUT', body: JSON.stringify({ threshold: 99 }) });
  assert.equal(clipped.json.settings.threshold, 85);
  assert.equal(clipped.json.settings.autoHandoff, true);
  // 显式预设 → 生效；退役 autoChoose 即使旧客户端传也不生效、不 400。
  const modePreset = await callAsync(route, { method: 'PUT', body: JSON.stringify({ defaultOperation: 'handoff', autoChoose: false }) });
  assert.deepEqual(modePreset.json.settings, { threshold: 85, capacityThreshold: 55, defaultOperation: 'handoff', autoCompress: true, autoHandoff: true, unlimitedBudget: false, architect: false });
  const retired = await callAsync(route, { method: 'PUT', body: JSON.stringify({ autoChoose: true }) });
  assert.equal(retired.out.statusCode, 200);
  assert.deepEqual(retired.json.settings, modePreset.json.settings);
  assert.equal(Object.prototype.hasOwnProperty.call(retired.json.settings, 'autoChoose'), false);
  assert.equal((await callAsync(route, { method: 'PUT', body: JSON.stringify({ threshold: 1 }) })).json.settings.threshold, 20);
  // 非法请求：body 不是 JSON / threshold 非数字 → 400；方法不支持 → 405
  assert.equal((await callAsync(route, { method: 'PUT', body: 'not-json' })).out.statusCode, 400);
  const badType = await callAsync(route, { method: 'PUT', body: JSON.stringify({ threshold: 'nope' }) });
  assert.equal(badType.out.statusCode, 400);
  assert.equal(badType.json.code, 'invalid-settings');
  const badBudget = await callAsync(route, { method: 'PUT', body: JSON.stringify({ unlimitedBudget: 'yes' }) });
  assert.equal(badBudget.out.statusCode, 400, '非法 unlimitedBudget → 400');
  assert.equal(badBudget.json.code, 'invalid-settings');
  const badArchitect = await callAsync(route, { method: 'PUT', body: JSON.stringify({ architect: 'yes' }) });
  assert.equal(badArchitect.out.statusCode, 400, '非法 architect → 400');
  assert.equal(badArchitect.json.code, 'invalid-settings');
  // v0.11 P0-E：容量线独立配置——改它不动 band 阈值；非法值 400；裁剪 [20,95]。
  const cap = await callAsync(route, { method: 'PUT', body: JSON.stringify({ capacityThreshold: 70 }) });
  assert.equal(cap.out.statusCode, 200);
  assert.equal(cap.json.settings.capacityThreshold, 70);
  assert.equal(cap.json.settings.threshold, 20, '容量线独立：改容量线不影响 threshold');
  assert.deepEqual(cap.json.thresholds, thresholdsFromPercent(20), 'band 阈值派生不变');
  const capBad = await callAsync(route, { method: 'PUT', body: JSON.stringify({ capacityThreshold: 'nope' }) });
  assert.equal(capBad.out.statusCode, 400, '非法 capacityThreshold → 400');
  assert.equal(capBad.json.code, 'invalid-settings');
  assert.equal((await callAsync(route, { method: 'PUT', body: JSON.stringify({ capacityThreshold: 99 }) })).json.settings.capacityThreshold, 95);
  assert.equal((await callAsync(route, { method: 'POST' })).out.statusCode, 405);
});

test('host: settings 部分更新——退役 autoChoose 旧客户端 PUT 被忽略（不 400、不影响预设）', async () => {
  const host = fakeHost();
  // 旧客户端只发 autoChoose:true → 兼容接受（200）但字段被丢弃、不产生任何模式变化。
  const openAuto = await putSettings(host, { autoChoose: true });
  assert.equal(openAuto.out.statusCode, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(openAuto.json.settings, 'autoChoose'), false);
  assert.equal(openAuto.json.settings.defaultOperation, null);
  // 只给 defaultOperation → 生效。
  const preset = await putSettings(host, { defaultOperation: 'handoff' });
  assert.equal(preset.json.settings.defaultOperation, 'handoff');
  // 再只发退役字段 → 预设保持（不再有旧互斥逻辑清预设）。
  const back = await putSettings(host, { autoChoose: true });
  assert.equal(back.json.settings.defaultOperation, 'handoff');
  // 显式同时给两者 → 只认 defaultOperation（白名单字段），autoChoose 被忽略。
  const both = await putSettings(host, { defaultOperation: 'compress', autoChoose: true });
  assert.equal(both.json.settings.defaultOperation, 'compress');
  assert.equal(Object.prototype.hasOwnProperty.call(both.json.settings, 'autoChoose'), false);
});

test('host: settings.json 损坏（语法/语义）→ rename 备份 + warn + 降级默认，不阻断插件注册（B-P2-11）', async () => {
  for (const corrupt of ['{ bad json', '{"threshold":"abc"}']) {
    const settingsPath = tmpPath('relay-settings-corrupt-');
    writeFileSync(settingsPath, corrupt, 'utf8');
    const host = fakeHost({ config: { settingsPath } }); // apply 不得抛错
    await tick();
    assert.equal(host.registrations.length, 1, '损坏 settings 不得阻断 preset 注册（唯一模式）');
    assert.notEqual(host.getRoute('/context-relay/settings'), undefined);
    const backups = readdirSync(dirname(settingsPath)).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1, '损坏文件必须隔离备份');
    assert.equal(existsSync(settingsPath), false);
    assert.equal(host.warnings.some((line) => /settings\.json unreadable\/invalid/.test(line)), true);
    // 降级默认，不半覆盖原文件
    const got = await callAsync(host.getRoute('/context-relay/settings'));
    assert.deepEqual(got.json.settings, DEFAULT_SETTINGS);
  }
});

test('host: panel.json 损坏 → apply 隔离备份 + warn，路由照常可用（B-P2-11）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-panel-corrupt-'));
  const panelPath = join(dir, 'panel.json');
  writeFileSync(panelPath, '{ "sessions": { broken', 'utf8');
  const host = fakeHost({ config: { panelPath } }); // apply 不得抛错
  assert.equal(host.warnings.some((line) => /panel store unreadable/.test(line)), true);
  assert.equal(readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 1);
  assert.equal(existsSync(panelPath), false);
  // 路由照常可用（空状态）
  assert.deepEqual((await getPanel(host, 'sess-after-corrupt')).json.panel, PANEL_DEFAULT);
  // 之后的写入可以正常重建文件
  assert.equal((await putPanel(host, { sessionId: 'sess-after-corrupt', autoCompress: true })).json.persisted, true);
  assert.equal(existsSync(panelPath), true);
});

test('host: GET /context-relay/architect-models 按官方子代理白名单过滤（不截断 / 父路由兜底 / 缺服务 / 405）', async () => {
  const providers = Array.from({ length: 9 }, (_, index) => ({ id: 'provider-' + index, name: 'Provider ' + index }));
  const models = Array.from({ length: 25 }, (_, index) => ({ id: 'model-' + index, name: 'Model ' + index }));
  const resolveCalls = [];
  const llm = {
    listProviders: () => providers,
    async listModels() { return models; },
    async resolveModelInfo(_provider, modelId) {
      resolveCalls.push(modelId);
      if (modelId === 'model-0') throw new Error('capability lookup failed');
      return { reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } };
    },
  };
  const session = { id: 'sess-arch', header: { id: 'sess-arch', cwd: '/tmp' }, requestHeader: () => ({ config: { provider: 'provider-0', model: 'model-3' } }) };
  const policy = [{ provider: 'provider-0', model: 'model-0' }, { provider: 'provider-1', model: 'model-1' }];
  const projections = (policyValue, selection) => ({
    register: () => () => {},
    snapshot: () => ({ values: {} }),
    stateOf(_session, key) {
      if (key === 'subagentModelSelectionPolicy') return policyValue;
      if (key === 'modelSelection') return selection;
      return undefined;
    },
  });
  const host = fakeHost({ llm, sessions: { get: (id) => (id === 'sess-arch' ? session : undefined) }, sessionProjections: projections(policy) });
  const route = host.getRoute('/context-relay/architect-models');
  assert.ok(route, 'architect-models 路由已注册');
  const res = await callAsync(route, { url: '/context-relay/architect-models?sessionId=sess-arch' });
  assert.equal(res.out.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.restricted, true);
  assert.equal(res.json.parentOnly, false);
  assert.deepEqual(res.json.providers.map((provider) => provider.id), ['provider-0', 'provider-1'], '只保留白名单内的 provider');
  assert.equal(res.json.providers[0].models.length, 1, 'provider-0 只保留白名单模型');
  assert.equal(res.json.providers[1].models.length, 1, 'provider-1 只保留白名单模型');
  assert.deepEqual(resolveCalls.sort(), ['model-0', 'model-1'], '只对白名单模型解析元数据（不是全量 N+1）');
  assert.deepEqual(res.json.providers[0].models[0].efforts, [], 'resolveModelInfo 抛错 → 该模型降级为无推理档，不影响其他行');
  assert.deepEqual(res.json.providers[1].models[0].efforts, [{ id: 'max', name: 'Max', default: true }]);

  // 没有会话白名单记录：按官方语义只允许父会话当前路由，并标记 parentOnly。
  const parentHost = fakeHost({
    llm,
    sessions: { get: (id) => (id === 'sess-arch' ? session : undefined) },
    sessionProjections: projections(null, { pending: null, lastUsed: { provider: 'provider-0', model: 'model-3' } }),
  });
  const parent = await callAsync(parentHost.getRoute('/context-relay/architect-models'), { url: '/context-relay/architect-models?sessionId=sess-arch' });
  assert.equal(parent.json.parentOnly, true);
  assert.deepEqual(parent.json.allowedModels, [{ provider: 'provider-0', model: 'model-3' }]);
  assert.deepEqual(parent.json.providers.map((provider) => provider.id), ['provider-0']);
  assert.equal(parent.json.providers[0].models[0].id, 'model-3');

  // 缺 sessionId / 未知会话：明确 400/404，不返回全量目录。
  assert.equal((await callAsync(route, { url: '/context-relay/architect-models' })).out.statusCode, 400);
  assert.equal((await callAsync(route, { url: '/context-relay/architect-models?sessionId=sess-unknown' })).out.statusCode, 404);
  // 方法限制
  assert.equal((await callAsync(route, { method: 'POST', url: '/context-relay/architect-models?sessionId=sess-arch' })).out.statusCode, 405);
  // llm 服务缺失：明确降级，不 500
  const bare = fakeHost({ sessions: { get: (id) => (id === 'sess-arch' ? session : undefined) }, sessionProjections: projections(policy) });
  const empty = await callAsync(bare.getRoute('/context-relay/architect-models'), { url: '/context-relay/architect-models?sessionId=sess-arch' });
  assert.equal(empty.out.statusCode, 200);
  assert.equal(empty.json.unavailable, true);
  assert.equal(empty.json.restricted, true);
});

test('host: settings PUT 持久化失败 → 500 明确 code，内存/globalThis 不半提交（B-P2-10）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-settings-ro-'));
  writeFileSync(join(dir, 'blocker'), 'x', 'utf8');
  const settingsPath = join(dir, 'blocker', 'settings.json');
  const host = fakeHost({ config: { settingsPath } });
  const before = globalThis[SETTINGS_KEY];
  const put = await callAsync(host.getRoute('/context-relay/settings'), { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ threshold: 60 }) });
  assert.equal(put.out.statusCode, 500);
  assert.equal(put.json.ok, false);
  assert.equal(put.json.code, 'settings-persist-failed');
  assert.equal(put.json.persisted, false);
  // 内存未提交：GET 仍是旧值，globalThis 不变
  assert.equal((await callAsync(host.getRoute('/context-relay/settings'))).json.settings.threshold, 35);
  assert.deepEqual(globalThis[SETTINGS_KEY], before);
  assert.equal(host.warnings.some((line) => /settings\.json write failed/.test(line)), true);
});

test('host: settings 跨进程冲突（mtime CAS+warn）：其它进程改过文件时写入仍成功但 warn（B-P2-14）', async () => {
  const settingsPath = tmpPath('relay-settings-conflict-');
  writeFileSync(settingsPath, JSON.stringify({ threshold: 45 }), 'utf8');
  const host = fakeHost({ config: { settingsPath } });
  assert.equal((await callAsync(host.getRoute('/context-relay/settings'))).json.settings.threshold, 45);
  // 模拟另一进程改动 settings.json（mtime 前移，确保 CAS 能观察到变化）
  writeFileSync(settingsPath, JSON.stringify({ threshold: 46 }), 'utf8');
  const future = new Date(Date.now() + 5000);
  utimesSync(settingsPath, future, future);
  const put = await callAsync(host.getRoute('/context-relay/settings'), { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ threshold: 60 }) });
  assert.equal(put.out.statusCode, 200);
  assert.equal(put.json.settings.threshold, 60);
  assert.equal(host.warnings.some((line) => /modified by another process/.test(line)), true);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).threshold, 60);
});

test('host: legacy config.thresholds 已删（C10）——忽略且不再 warn；阈值只认 settings 口径', async () => {
  const legacy = Object.freeze({
    warnRatio: 0.45, organizeRatio: 0.5, relayRatio: 0.6,
    warnTokens: 100000, organizeTokens: 130000, relayTokens: 160000,
  });
  const dir = mkdtempSync(join(tmpdir(), 'relay-thresholds-'));
  const settingsPath = join(dir, 'settings.json');
  const host = fakeHost({ config: { thresholds: legacy, settingsPath } });
  const settings = await callAsync(host.getRoute('/context-relay/settings'));
  // 生效阈值 = 默认基准 35% 派生（legacy 配置被忽略，不再反推可见基准）。
  assert.deepEqual(settings.json.thresholds, thresholdsFromPercent(35));
  assert.equal(settings.json.settings.threshold, 35);
  assert.equal(host.warnings.some((line) => /thresholds/.test(line)), false, 'legacy thresholds 不再有专用 warn');
  const panel = await getPanel(host, 'sess-thresholds');
  assert.deepEqual(panel.json.thresholds, thresholdsFromPercent(35));
  assert.deepEqual(panel.json.settings, { threshold: 35 });
  // settings 路由保存 → 生效阈值来自 settings.threshold
  const put = await putSettings(host, { threshold: 60 });
  assert.deepEqual(put.json.thresholds, thresholdsFromPercent(60));
  assert.deepEqual((await getPanel(host, 'sess-thresholds')).json.thresholds, thresholdsFromPercent(60));
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).threshold, 60);
});

test('host: settings 来源优先级 file > config.settings > config.threshold', async () => {
  // file 存在 → 以 file 为准（config.settings/config.threshold 被覆盖）
  const settingsPath = tmpPath('relay-settings-priority-');
  writeFileSync(settingsPath, JSON.stringify({ threshold: 70 }), 'utf8');
  const fromFile = fakeHost({ config: { settingsPath, settings: { threshold: 50 }, threshold: 30 } });
  const fileSettings = await callAsync(fromFile.getRoute('/context-relay/settings'));
  assert.equal(fileSettings.json.settings.threshold, 70);
  clearPanelMemory(); delete globalThis[SETTINGS_KEY];
  // 无文件、有 config.settings → config.settings（阈值取自其中，缺省默认 35）
  const fromConfig = fakeHost({ config: { threshold: 30, settings: { autoCompress: true } } });
  const configSettings = await callAsync(fromConfig.getRoute('/context-relay/settings'));
  assert.equal(configSettings.json.settings.autoCompress, true);
  assert.equal(configSettings.json.settings.threshold, 35);
  clearPanelMemory(); delete globalThis[SETTINGS_KEY];
  // 无文件、只有 config.threshold → 生效
  const shorthand = fakeHost({ config: { threshold: 30 } });
  const shorthandSettings = await callAsync(shorthand.getRoute('/context-relay/settings'));
  assert.equal(shorthandSettings.json.settings.threshold, 30);
  assert.deepEqual(shorthandSettings.json.thresholds, thresholdsFromPercent(30));
});

test('host: 阈值/面板默认值单一解析入口（C6/M-17/D-07）——settings、panel 路由与 policy 同口径', async () => {
  const host = fakeHost();
  const settingsRoute = host.getRoute('/context-relay/settings');
  // settings 路由的 thresholds 必须就是 policy.resolveEffectiveThresholds 对同一 settings 的结果。
  const got = await callAsync(settingsRoute);
  assert.deepEqual(got.json.thresholds, resolveEffectiveThresholds({ settings: got.json.settings }));
  const put = await callAsync(settingsRoute, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ threshold: 60 }) });
  assert.deepEqual(put.json.thresholds, resolveEffectiveThresholds({ settings: put.json.settings }));
  // 面板 GET 与 settings 路由同一份生效阈值（不再各自派生）。
  const panel = await getPanel(host, 'sess-single-source');
  assert.deepEqual(panel.json.thresholds, put.json.thresholds);
  assert.deepEqual(panel.json.thresholds, thresholdsFromPercent(60));
  // host 发布的面板默认值经 policy.panelDefaultsOf 唯一映射（五字段）。
  assert.deepEqual(panelDefaultsOf(), {
    defaultOperation: null, autoCompress: false, autoHandoff: false, unlimitedBudget: true, architect: true,
  });
  // legacy config.thresholds 已删：传入也被忽略，settings/panel 仍走默认基准派生。
  const legacy = Object.freeze({ warnRatio: 0.45, organizeRatio: 0.5, relayRatio: 0.6, warnTokens: 100000, organizeTokens: 130000, relayTokens: 160000 });
  const legacyHost = fakeHost({ config: { thresholds: legacy } });
  const legacySettings = await callAsync(legacyHost.getRoute('/context-relay/settings'));
  assert.deepEqual(legacySettings.json.thresholds, resolveEffectiveThresholds({ settings: legacySettings.json.settings }));
  assert.deepEqual(legacySettings.json.thresholds, thresholdsFromPercent(35));
  assert.deepEqual((await getPanel(legacyHost, 'sess-single-source-legacy')).json.thresholds, thresholdsFromPercent(35));
});

test('host: PUT settings >8KB 返回 413 JSON（真实 http server，旧单测 fake destroy 假绿 B-P2-12）', async () => {
  const host = fakeHost();
  const route = host.getRoute('/context-relay/settings');
  const { server, port } = await listen(route.handler);
  try {
    const okBody = JSON.stringify({ threshold: 50, pad: 'x'.repeat(100) });
    const ok = await httpRequest({ port, path: '/context-relay/settings', body: okBody });
    assert.equal(ok.kind, 'response');
    assert.equal(ok.status, 200);
    const big = JSON.stringify({ threshold: 50, pad: 'x'.repeat(9000) });
    const over = await httpRequest({ port, path: '/context-relay/settings', body: big });
    assert.equal(over.kind, 'response', '超限不得 ECONNRESET（必须回 JSON 响应）');
    assert.equal(over.status, 413);
    const json = JSON.parse(over.body);
    assert.equal(json.ok, false);
    assert.equal(json.code, 'payload-too-large');
  } finally {
    server.close();
  }
});

test('host: PUT panel >8KB 返回 413 JSON（真实 http server，B-P2-12）', async () => {
  const host = fakeHost();
  const route = host.getRoute('/context-relay/panel');
  const { server, port } = await listen(route.handler);
  try {
    const small = JSON.stringify({ sessionId: 'sess-http', autoCompress: true });
    const ok = await httpRequest({ port, path: '/context-relay/panel', body: small });
    assert.equal(ok.kind, 'response');
    assert.equal(ok.status, 200);
    // 边界：8192 字节可接受，8193 字节 413
    const prefix = '{"sessionId":"sess-edge","pad":"';
    const suffix = '"}';
    const exact = prefix + 'x'.repeat(8192 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    assert.equal(Buffer.byteLength(exact), 8192);
    assert.equal((await httpRequest({ port, path: '/context-relay/panel', body: exact })).status, 200);
    const overflow = prefix + 'x'.repeat(8193 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    assert.equal(Buffer.byteLength(overflow), 8193);
    const over = await httpRequest({ port, path: '/context-relay/panel', body: overflow });
    assert.equal(over.kind, 'response');
    assert.equal(over.status, 413);
    assert.equal(JSON.parse(over.body).code, 'payload-too-large');
  } finally {
    server.close();
  }
});

test('host: GET /context-relay/panel 默认面板 + live null + 生效阈值，非法 sessionId 400', async () => {
  const host = fakeHost();
  const route = host.getRoute('/context-relay/panel');
  assert.ok(route && typeof route.handler === 'function');
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, '/context-relay/panel');
  const got = await getPanel(host, 'sess-panel-a');
  assert.equal(got.out.statusCode, 200);
  assert.deepEqual(got.json, {
    ok: true,
    sessionId: 'sess-panel-a',
    relay: false, // 无 sessions 服务 → 按非 relay（客户端隐藏 composer 小胶囊）
    preset: null, // 无 sessions 服务 → 当前 preset 不可得
    panel: PANEL_DEFAULT,
    architectDefault: null,
    live: null,
    thresholds: thresholdsFromPercent(DEFAULT_SETTINGS.threshold),
    settings: { threshold: DEFAULT_SETTINGS.threshold },
  });
  // agent 每次 pre-step 发布实时状态 → 面板可见（未发布时 live 必须为 null 而不是空对象；client 端按中性降级态渲染）
  publishLiveState('sess-panel-a', { band: 'organize', used: 400000, window: 1000000, ratio: 0.4, phase: 'build', overBudget: true });
  const live = await getPanel(host, 'sess-panel-a');
  assert.equal(live.json.live.band, 'organize');
  assert.equal(live.json.live.overBudget, true);
  assert.equal(live.json.live.phase, 'build');
  assert.equal(typeof live.json.live.updatedAt, 'number');
  // 非法 sessionId：缺 / 空 / 超长 / __proto__ / NUL / 空白 → 400（GET/PUT 同校）
  const badIds = ['', 'x'.repeat(201), '__proto__', 'a\u0000b', 'bad id', 'session/evil'];
  for (const badId of badIds) {
    const bad = await callAsync(route, { url: '/context-relay/panel?sessionId=' + encodeURIComponent(badId) });
    assert.equal(bad.out.statusCode, 400, '应拒绝非法 sessionId: ' + JSON.stringify(badId));
    assert.equal(bad.json.ok, false);
    assert.equal(typeof bad.json.message, 'string');
  }
  assert.equal((await callAsync(route, { url: '/context-relay/panel' })).out.statusCode, 400);
  // 方法不支持 → 405
  assert.equal((await callAsync(route, { method: 'POST', url: '/context-relay/panel' })).out.statusCode, 405);
});

test('host v0.2.7: GET /panel 的 relay 标记 + unlimitedBudget 生效值（settings 默认 → 会话快照）', async () => {
  const relayHost = fakeHost({
    sessions: { get: (id) => ({ id, header: { agentPreset: id === 'sess-relay-old' ? 'relay' : id === 'sess-relay' ? 'relay-long' : 'ptc' } }) },
  });
  const route = relayHost.getRoute('/context-relay/panel');
  assert.equal((await getPanel(relayHost, 'sess-relay')).json.relay, true, 'relay preset 会话 → 客户端显示 composer 小胶囊');
  assert.equal((await getPanel(relayHost, 'sess-relay-old')).json.relay, false, 'v0.10.0：旧 classic id 已删 → 不再识别为 relay');
  assert.equal((await getPanel(relayHost, 'sess-ptc')).json.relay, false, '其它 preset → 不显示');
  // GET 同时下发当前 preset（投影缺失时回退 creation header）；modes 兼容字段已删。
  assert.equal((await getPanel(relayHost, 'sess-relay')).json.preset, 'relay-long');
  assert.equal((await getPanel(relayHost, 'sess-ptc')).json.preset, 'ptc');
  assert.equal(Object.prototype.hasOwnProperty.call((await getPanel(relayHost, 'sess-relay')).json, 'modes'), false, '退役 wire 字段 modes 已删');
  // 未改过面板的会话：unlimitedBudget 跟随 settings 默认（默认 true）；handoffUnlimitedBudget 缺省 null（交接跟随）
  const fresh = await getPanel(relayHost, 'sess-relay');
  assert.equal(fresh.json.panel.unlimitedBudget, true);
  assert.equal(fresh.json.panel.handoffUnlimitedBudget, null);
  // 旧 settings.json 兼容：把默认关掉 → 未改面板的会话生效 false
  await putSettings(relayHost, { unlimitedBudget: false });
  assert.equal((await getPanel(relayHost, 'sess-relay')).json.panel.unlimitedBudget, false);
  // 人类在 composer 小胶囊写 true = 本会话整份快照，此后不再跟随 settings
  const put = await putPanel(relayHost, { sessionId: 'sess-relay', unlimitedBudget: true, handoffUnlimitedBudget: false });
  assert.equal(put.json.panel.unlimitedBudget, true);
  assert.equal(put.json.panel.handoffUnlimitedBudget, false);
  await putSettings(relayHost, { unlimitedBudget: false });
  assert.equal((await getPanel(relayHost, 'sess-relay')).json.panel.unlimitedBudget, true, '面板写入后按会话快照');
  // 三值归一：非法值 → null（跟随/继承），不 400
  const bogus = await putPanel(relayHost, { sessionId: 'sess-relay', handoffUnlimitedBudget: 'yes' });
  assert.equal(bogus.out.statusCode, 200);
  assert.equal(bogus.json.panel.handoffUnlimitedBudget, null);
  // 无 sessionProjections 服务 → 回退 creation header（上面 hosts 只有 header，判据仍成立）
  // sessions 服务缺失 → relay:false（客户端不渲染胶囊，面板其它功能不受影响）
  assert.equal((await getPanel(fakeHost(), 'sess-nosessions')).json.relay, false);
  assert.ok(route);
});

test('host v0.2.7: relay 标记以当前 preset 投影为准（header 是创建值，选择 preset 不改 header）', async () => {
  const makeSession = (id, preset) => ({ id, header: { agentPreset: preset } });
  let currentPreset;
  const sessionProjections = {
    register: () => () => {},
    snapshot: () => ({ values: {} }),
    stateOf: (_session, key) => (key === 'agentPreset' ? currentPreset : undefined),
  };
  // 主流程回归：新建会话先以默认 ptc 创建（header=ptc），再在模式选择器选 Relay（投影=relay-long）→ 必须显示胶囊
  const host = fakeHost({ sessionProjections, sessions: { get: (id) => makeSession(id, 'ptc') } });
  currentPreset = 'relay-long';
  assert.equal((await getPanel(host, 'sess-switched-in')).json.relay, true, 'header=ptc + 当前 preset 投影=relay-long → 显示');
  assert.equal((await getPanel(host, 'sess-switched-in')).json.preset, 'relay-long', 'GET preset 以投影为准（不是 creation header）');
  // 反向：header 还是 relay-long 但已经切走 → 不显示
  const host2 = fakeHost({ sessionProjections, sessions: { get: (id) => makeSession(id, 'relay-long') } });
  currentPreset = 'ptc';
  assert.equal((await getPanel(host2, 'sess-switched-away')).json.relay, false, 'header=relay-long + 当前 preset 投影=ptc → 不显示');
  // 投影服务抛错/无值 → 回退 creation header（不因投影异常把已 attach 的 relay 会话判成 false）
  const throwingProjections = {
    register: () => () => {},
    snapshot: () => ({ values: {} }),
    stateOf: () => { throw new Error('projection boom'); },
  };
  const host3 = fakeHost({ sessionProjections: throwingProjections, sessions: { get: (id) => makeSession(id, 'relay-long') } });
  assert.equal((await getPanel(host3, 'sess-projection-throw')).json.relay, true, '投影异常回退 header');
  assert.equal((await getPanel(host3, 'sess-projection-throw')).json.preset, 'relay-long', 'preset 同样回退 header');
  // 投影为 null（header 无 agentPreset）→ 回退 header（null → 非 relay）
  const nullProjections = { ...sessionProjections, stateOf: () => null };
  const host4 = fakeHost({ sessionProjections: nullProjections, sessions: { get: (id) => makeSession(id, 'relay-long') } });
  assert.equal((await getPanel(host4, 'sess-projection-null')).json.relay, true, '投影 null 回退 header');
});

test('host: live 超过 TTL 未更新 → GET 返回 live:null（不显示旧 band/「已到线」，P3 live TTL）', async () => {
  const host = fakeHost();
  publishLiveState('sess-stale-live', { band: 'relay', overBudget: true }, Date.now() - LIVE_TTL_MS - 1);
  const stale = await getPanel(host, 'sess-stale-live');
  assert.equal(stale.json.live, null);
  publishLiveState('sess-fresh-live', { band: 'relay', overBudget: true });
  assert.equal((await getPanel(host, 'sess-fresh-live')).json.live.band, 'relay');
});

test('host: live 未发布时 GET panel 从会话投影派生真实值（冷启动不需要新 step）', async () => {
  const session = { id: 'sess-derived', header: { agentPreset: 'relay' }, seq: 9 };
  const sessionProjections = {
    register: () => () => {},
    snapshot: () => ({ asOfSeq: 8, values: { contextPressure: { contextWindow: 1000000, projectedTokens: 410000 } } }),
    stateOf: (_session, key) => (key === 'relay' ? { phase: 'build', organizeCount: 1 } : undefined),
  };
  const host = fakeHost({ sessionProjections, sessions: { get: (id) => (id === 'sess-derived' ? session : undefined) } });
  const res = await getPanel(host, 'sess-derived');
  assert.equal(res.out.statusCode, 200);
  assert.deepEqual(
    { band: res.json.live.band, used: res.json.live.used, window: res.json.live.window, ratio: res.json.live.ratio, phase: res.json.live.phase, organizeCount: res.json.live.organizeCount, overBudget: res.json.live.overBudget, derived: res.json.live.derived },
    { band: 'organize', used: 410000, window: 1000000, ratio: 0.41, phase: 'build', organizeCount: 1, overBudget: true, derived: true },
  );
  assert.equal(typeof res.json.live.updatedAt, 'number');
});

test('host: 派生不可用（会话未 attach / 投影抛错）→ live:null，不 500', async () => {
  const hostA = fakeHost({ sessionProjections: { register: () => () => {}, snapshot: () => ({ values: {} }), stateOf: () => undefined }, sessions: { get: () => undefined } });
  const a = await getPanel(hostA, 'sess-detached');
  assert.equal(a.out.statusCode, 200);
  assert.equal(a.json.live, null);

  const session = { id: 'sess-derive-throw', header: {}, seq: 3 };
  const hostB = fakeHost({ sessionProjections: { register: () => () => {}, snapshot: () => { throw new Error('boom'); }, stateOf: () => { throw new Error('boom'); } }, sessions: { get: () => session } });
  const b = await getPanel(hostB, 'sess-derive-throw');
  assert.equal(b.out.statusCode, 200);
  assert.equal(b.json.live, null);

  // 会话已 attach 但 contextPressure 投影无值（无上报/无该 key）→ 不得伪报 band:'ok'，回退 null 保持中性态
  const hostC = fakeHost({ sessionProjections: { register: () => () => {}, snapshot: () => ({ values: {} }), stateOf: () => undefined }, sessions: { get: () => session } });
  const c = await getPanel(hostC, 'sess-derive-no-pressure');
  assert.equal(c.out.statusCode, 200);
  assert.equal(c.json.live, null);
});

test('host: 已发布的 live 优先于派生值', async () => {
  publishLiveState('sess-live-priority', { band: 'warn', used: 360000, window: 1000000, ratio: 0.36, overBudget: false });
  const session = { id: 'sess-live-priority', header: {}, seq: 5 };
  const host = fakeHost({
    sessionProjections: { register: () => () => {}, snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 120000 } } }), stateOf: () => ({ phase: 'ship', organizeCount: 2 }) },
    sessions: { get: () => session },
  });
  const res = await getPanel(host, 'sess-live-priority');
  assert.equal(res.json.live.band, 'warn', 'fresh 发布值优先');
  assert.equal(res.json.live.derived, undefined, '发布值不带 derived 标记');
  assert.equal(res.json.live.phase, undefined);
});

test('host: 发布值超 TTL 后回退派生值（不闪回旧 live）', async () => {
  publishLiveState('sess-stale-derived', { band: 'relay', overBudget: true }, Date.now() - LIVE_TTL_MS - 1);
  const session = { id: 'sess-stale-derived', header: { agentPreset: 'relay' }, seq: 7 };
  const host = fakeHost({
    sessionProjections: { register: () => () => {}, snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000, projectedTokens: 120000 } } }), stateOf: () => ({ phase: 'discover', organizeCount: 0 }) },
    sessions: { get: () => session },
  });
  const res = await getPanel(host, 'sess-stale-derived');
  assert.equal(res.json.live.band, 'ok', '不得闪回旧 relay 档');
  assert.equal(res.json.live.ratio, 0.12);
  assert.equal(res.json.live.phase, 'discover');
  assert.equal(res.json.live.overBudget, false);
  assert.equal(res.json.live.derived, true);
});

test('host: GET panel architectDefault follows projection, deployment, options and fails open', async () => {
  const selected = { provider: 'p', model: 'selected', reasoningEffort: 'high' };
  const session = { id: 'sess-model-default', header: { agentPreset: 'relay-long' } };
  const projectionHost = fakeHost({ sessions: { get: () => session }, sessionProjections: { register: () => () => {}, stateOf: (_session, key) => key === 'modelSelection' ? { lastUsed: selected } : undefined } });
  const projected = await getPanel(projectionHost, session.id);
  assert.equal(projected.out.statusCode, 200);
  assert.deepEqual(projected.json.architectDefault, selected);
  assert.deepEqual(projected.json.panel, PANEL_DEFAULT);
  assert.equal(projected.json.sessionId, session.id);
  const deployment = { provider: 'p', model: 'deployment' };
  const host = fakeHost({ agentDefaultModel: { currentSelection: () => deployment } });
  assert.deepEqual((await getPanel(host, session.id)).json.architectDefault, deployment);
  const explicit = { provider: 'p', model: 'override', reasoningEffort: 'max' };
  const saved = await putPanel(host, { sessionId: session.id, architectModel: explicit });
  assert.deepEqual(saved.json.panel.architectModel, explicit);
  assert.deepEqual(JSON.parse(readFileSync(host.config.panelPath, 'utf8')).sessions[session.id].architectModel, explicit);
  assert.deepEqual((await getPanel(host, session.id)).json.architectDefault, deployment);
  const restored = await putPanel(host, { sessionId: session.id, architectModel: null });
  assert.equal(restored.json.panel.architectModel, null);
  assert.deepEqual((await getPanel(host, session.id)).json.architectDefault, deployment);
  const optionsHost = fakeHost({ agents: { get: () => ({ options: deployment }) } });
  assert.deepEqual((await getPanel(optionsHost, session.id)).json.architectDefault, deployment);
  for (const config of [{}, { noGet: true }, { sessions: { get: () => { throw new Error('unavailable'); } } }]) {
    const response = await getPanel(fakeHost(config), session.id);
    assert.equal(response.out.statusCode, 200);
    assert.equal(response.json.architectDefault, null);
    assert.deepEqual(response.json.panel, PANEL_DEFAULT);
  }
});

test('host: architectDefault source exceptions retain projection/deployment fallback before null', async () => {
  const selected = { provider: 'p', model: 'pending' };
  const deployment = { provider: 'p', model: 'deployment' };
  const unavailable = () => { throw new Error('unavailable'); };
  const session = { id: 'sess-model-errors', header: { agentPreset: 'relay-long' } };
  const projection = { register: () => () => {}, stateOf: (_session, key) => key === 'modelSelection' ? { pending: selected } : undefined };
  const scenarios = [
    { services: { sessions: { get: () => session }, agents: { get: unavailable }, sessionProjections: projection, agentDefaultModel: { currentSelection: () => deployment } }, expected: selected },
    { services: { sessions: { get: unavailable }, agentDefaultModel: { currentSelection: () => deployment } }, expected: deployment },
    { services: { sessions: { get: () => session }, agents: { get: unavailable }, sessionProjections: { register: () => () => {}, stateOf: unavailable }, agentDefaultModel: { currentSelection: () => deployment } }, expected: deployment },
    { services: { sessions: { get: unavailable }, agents: { get: unavailable }, sessionProjections: { register: () => () => {}, stateOf: unavailable }, agentDefaultModel: { currentSelection: unavailable } }, expected: null },
  ];
  for (const { services, expected } of scenarios) {
    const response = await getPanel(fakeHost(services), session.id);
    assert.equal(response.out.statusCode, 200);
    assert.deepEqual(response.json.architectDefault, expected);
    assert.deepEqual(response.json.panel, PANEL_DEFAULT);
  }
});

test('host: PUT /context-relay/panel 持久化到 panel.json 并 GET 回读，非法 body 400', async () => {
  const panelPath = tmpPath('relay-panel-');
  const host = fakeHost({ config: { panelPath } });
  const put = await putPanel(host, { sessionId: 'sess-panel-b', defaultOperation: 'handoff', autoChoose: true, autoCompress: true, autoHandoff: true, handoffPreAuthorized: true, unrelated: 'drop' });
  assert.equal(put.out.statusCode, 200);
  assert.equal(put.json.persisted, true);
  // 退役/内部/未知键全部忽略（不落面板）；白名单字段照常写入。
  const expected = resolvePanelState({ defaults: { unlimitedBudget: true, architect: true }, patch: { defaultOperation: 'handoff', autoCompress: true, autoHandoff: true } });
  assert.deepEqual(put.json.panel, expected);
  // 持久化：panel.json 形如 { sessions: { <sessionId>: 面板状态 } }
  const file = JSON.parse(readFileSync(panelPath, 'utf8'));
  assert.deepEqual(file.sessions['sess-panel-b'], put.json.panel);
  // GET 回读
  assert.deepEqual((await getPanel(host, 'sess-panel-b')).json.panel, put.json.panel);
  // v0.6.4：architect（专职架构师开关）可经面板 PUT 写入并持久化
  const archOff = await putPanel(host, { sessionId: 'sess-panel-b', architect: false });
  assert.equal(archOff.json.panel.architect, false);
  assert.equal(JSON.parse(readFileSync(panelPath, 'utf8')).sessions['sess-panel-b'].architect, false);
  const archOn = await putPanel(host, { sessionId: 'sess-panel-b', architect: true });
  assert.equal(archOn.json.panel.architect, true);
  // 增量 PUT：只改传入键，其余保持（退役 autoChoose 不参与）
  const patch = await putPanel(host, { sessionId: 'sess-panel-b', defaultOperation: null, autoChoose: false });
  assert.deepEqual(patch.json.panel, { ...archOn.json.panel, defaultOperation: null });
  // 非法默认操作归 null（归一化，不 400）
  const bogus = await putPanel(host, { sessionId: 'sess-panel-c', defaultOperation: 'bogus' });
  assert.equal(bogus.json.panel.defaultOperation, null);
  // 非法请求：body 非 JSON / 缺 sessionId / 空 / 超长 / 伪 id → 400
  assert.equal((await callAsync(host.getRoute('/context-relay/panel'), { method: 'PUT', url: '/context-relay/panel', body: 'not-json' })).out.statusCode, 400);
  assert.equal((await putPanel(host, { autoCompress: true })).out.statusCode, 400);
  for (const badId of ['', 'x'.repeat(201), '__proto__', 'a\u0000b']) {
    assert.equal((await putPanel(host, { sessionId: badId })).out.statusCode, 400, 'PUT 应拒绝非法 sessionId: ' + JSON.stringify(badId));
  }
  // 宿主重启（新实例同 panelPath）：从 panel.json 载入
  clearPanelMemory();
  const reopened = fakeHost({ config: { panelPath, settingsPath: host.config.settingsPath } });
  assert.deepEqual((await getPanel(reopened, 'sess-panel-b')).json.panel, patch.json.panel);
});

test('v0.3.4 P2-1: 人类 PUT 显式 defaultOperation/autoChoose 清空模型推荐三字段；只写 autoCompress 时推荐保留', async () => {
  const host = fakeHost({ config: { panelPath: tmpPath('relay-panel-rec-') } });
  const seed = (sessionId) => updatePanelState(sessionId, {
    recommendedOperation: 'handoff',
    recommendedReason: '干净上下文更适合下一阶段',
    recommendedAt: 1762460000999,
  }, { source: 'agent' });
  const recommendOf = (panel) => [panel.recommendedOperation, panel.recommendedReason, panel.recommendedAt];

  // ① 显式给 defaultOperation（人类已决定）→ 旧推荐作废
  seed('sess-rec-put-preset');
  const preset = await putPanel(host, { sessionId: 'sess-rec-put-preset', defaultOperation: 'compress' });
  assert.equal(preset.out.statusCode, 200);
  assert.deepEqual(recommendOf(preset.json.panel), [null, '', null], 'defaultOperation 清推荐三字段');
  assert.equal(preset.json.panel.defaultOperation, 'compress');

  // ② 退役 autoChoose 不参与决策：不再清推荐（字段被忽略）
  seed('sess-rec-put-auto');
  const auto = await putPanel(host, { sessionId: 'sess-rec-put-auto', autoChoose: true });
  assert.equal(auto.out.statusCode, 200);
  assert.deepEqual(recommendOf(auto.json.panel), ['handoff', '干净上下文更适合下一阶段', 1762460000999], '退役字段不清推荐');
  assert.equal(Object.prototype.hasOwnProperty.call(auto.json.panel, 'autoChoose'), false);

  // ③ 只写 autoCompress（未做继续方式决定）→ 推荐保留
  seed('sess-rec-put-keep');
  const keep = await putPanel(host, { sessionId: 'sess-rec-put-keep', autoCompress: true });
  assert.equal(keep.out.statusCode, 200);
  assert.deepEqual(recommendOf(keep.json.panel), ['handoff', '干净上下文更适合下一阶段', 1762460000999], '非决策字段不清推荐');
  assert.equal(keep.json.panel.autoCompress, true);
});

test('host v0.10 C10: panel PUT 退役/未知键（handoffPreset/autoChoose/autoDecision）一律忽略——200 不落面板', async () => {
  const host = fakeHost();
  const initial = await getPanel(host, 'sess-hp-put');
  for (const key of ['handoffPreset', 'autoChoose', 'autoDecision']) {
    assert.equal(Object.prototype.hasOwnProperty.call(initial.json.panel, key), false, '退役字段不得出现：' + key);
  }
  // 任意旧值（合法/脏/非字符串）→ 200，不写面板、不返回 deprecated 标记（语义已整体删除）。
  for (const value of ['relay', 'relay-long', 'bad preset', '', 42, true, {}, null]) {
    const put = await putPanel(host, { sessionId: 'sess-hp-put', handoffPreset: value });
    assert.equal(put.out.statusCode, 200, '退役字段不再校验/拒绝: ' + String(value));
    assert.equal(Object.prototype.hasOwnProperty.call(put.json.panel, 'handoffPreset'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(put.json, 'deprecated'), false);
  }
  // 同批其它合法字段照常写入（退役字段被忽略）。
  const both = await putPanel(host, { sessionId: 'sess-hp-put', handoffPreset: 'relay', autoCompress: true });
  assert.equal(both.json.panel.autoCompress, true);
  assert.equal(Object.prototype.hasOwnProperty.call(both.json.panel, 'handoffPreset'), false);
  // presetId/longPresetId 可配置：唯一 id 取 longPresetId ?? presetId+'-long'；GET 只回 preset，不知道的 classic id 不再识别。
  const custom = fakeHost({ config: { presetId: 'myrelay', longPresetId: 'myrelay-long' }, sessions: { get: (id) => ({ id, header: { agentPreset: id === 'sess-custom' ? 'myrelay-long' : 'myrelay' } }) } });
  assert.equal(Object.prototype.hasOwnProperty.call((await getPanel(custom, 'sess-custom')).json, 'modes'), false, '退役 wire 字段 modes 已删');
  assert.equal((await getPanel(custom, 'sess-custom')).json.relay, true);
  assert.equal((await getPanel(custom, 'sess-custom-old')).json.relay, false, '旧 classic id 不再识别');
  assert.equal((await putPanel(custom, { sessionId: 'sess-custom', handoffPreset: 'myrelay-long' })).out.statusCode, 200);
});

test('host: PUT /context-relay/panel 写盘失败 → 200 + persisted:false + message，内存仍生效（B-P2-10）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-panel-ro-'));
  writeFileSync(join(dir, 'blocker'), 'x', 'utf8');
  const panelPath = join(dir, 'blocker', 'panel.json');
  const host = fakeHost({ config: { panelPath } });
  const put = await putPanel(host, { sessionId: 'sess-panel-fail', autoCompress: true });
  assert.equal(put.out.statusCode, 200);
  assert.equal(put.json.ok, true);
  assert.equal(put.json.persisted, false);
  assert.match(put.json.message, /not persisted/);
  // 内存仍生效（重启会丢），且明确 warn
  assert.equal((await getPanel(host, 'sess-panel-fail')).json.panel.autoCompress, true);
  assert.equal(host.warnings.some((line) => /panel\.json write failed/.test(line)), true);
});

test('host: panel PUT 退役 autoChoose 忽略——不再有旧互斥语义，白名单字段独立生效', async () => {
  const host = fakeHost();
  // 旧客户端同时发 autoChoose:true + 预设 → 只认 defaultOperation；autoChoose 被丢弃。
  const auto = await putPanel(host, { sessionId: 'sess-exclusive', autoChoose: true, defaultOperation: 'handoff' });
  assert.equal(Object.prototype.hasOwnProperty.call(auto.json.panel, 'autoChoose'), false);
  assert.equal(auto.json.panel.defaultOperation, 'handoff');
  // 显式给预设 → 生效。
  const preset = await putPanel(host, { sessionId: 'sess-exclusive', defaultOperation: 'compress' });
  assert.equal(preset.json.panel.defaultOperation, 'compress');
  // 旧客户端再发 autoChoose:true → 无副作用，预设保持。
  const back = await putPanel(host, { sessionId: 'sess-exclusive', autoChoose: true });
  assert.equal(back.json.panel.defaultOperation, 'compress');
  // 只改其它白名单字段：不影响预设模式既有值
  await putPanel(host, { sessionId: 'sess-exclusive-2', defaultOperation: 'continue' });
  const other = await putPanel(host, { sessionId: 'sess-exclusive-2', autoCompress: true });
  assert.equal(other.json.panel.defaultOperation, 'continue');
  assert.equal(other.json.panel.autoCompress, true);
});

test('host: 未改面板的会话 GET panel 返回侧栏默认；改过面板后快照不再跟随默认', async () => {
  const host = fakeHost();
  const panelPath = host.config.panelPath;
  // 侧栏保存默认值（阈值 + 默认操作 + 授权）→ 发布到 globalThis
  const saved = await putSettings(host, { threshold: 50, defaultOperation: 'handoff', autoCompress: true, autoHandoff: true });
  assert.equal(saved.out.statusCode, 200);
  // 退役 autoChoose 被忽略，defaultOperation 照常生效。
  assert.equal(saved.json.settings.defaultOperation, 'handoff');
  assert.equal(Object.prototype.hasOwnProperty.call(saved.json.settings, 'autoChoose'), false);
  const sidebarDefaults = { defaultOperation: 'handoff', autoCompress: true, autoHandoff: true, unlimitedBudget: true, architect: true };
  // 未改过面板的新会话：GET panel 读到侧栏默认值
  assert.deepEqual((await getPanel(host, 'sess-default-a')).json.panel, resolvePanelState({ defaults: sidebarDefaults }));
  assert.deepEqual((await getPanel(host, 'sess-default-a')).json.settings, { threshold: 50 }); // 面板 GET 保持 v1 形状
  // 面板切到预设模式 → 整份当前值快照写入本会话（此后不再跟随侧栏默认）
  const changed = await putPanel(host, { sessionId: 'sess-default-a', defaultOperation: 'continue' });
  assert.equal(changed.out.statusCode, 200);
  assert.deepEqual(changed.json.panel, resolvePanelState({ defaults: { autoCompress: true, autoHandoff: true, unlimitedBudget: true, architect: true }, patch: { defaultOperation: 'continue' } }));
  // 侧栏默认再变：未改面板的新会话跟随新默认；改过的会话保持自己的快照
  await putSettings(host, { threshold: 45, defaultOperation: 'compress', autoCompress: false, autoHandoff: false });
  assert.deepEqual((await getPanel(host, 'sess-default-b')).json.panel, resolvePanelState({ defaults: { defaultOperation: 'compress', unlimitedBudget: true, architect: true } }));
  assert.deepEqual((await getPanel(host, 'sess-default-a')).json.panel, changed.json.panel);
  // 人类在面板把模式写回 null（问我）后覆盖，不回落到侧栏默认 'compress'
  const consumed = await putPanel(host, { sessionId: 'sess-default-b', defaultOperation: null });
  assert.equal(consumed.json.panel.defaultOperation, null);
  assert.equal((await getPanel(host, 'sess-default-b')).json.panel.defaultOperation, null);
  // 重启（新实例同 panelPath/settingsPath）：会话快照与侧栏默认都从文件恢复
  clearPanelMemory();
  const reopened = fakeHost({ config: { panelPath, settingsPath: host.config.settingsPath } });
  assert.deepEqual((await getPanel(reopened, 'sess-default-a')).json.panel, changed.json.panel);
  assert.equal((await getPanel(reopened, 'sess-default-b')).json.panel.defaultOperation, null);
});

test('host: 面板 no-op 写入不固化侧栏默认值（B-P2-8：会话继续跟随侧栏默认）', async () => {
  const host = fakeHost();
  const panelPath = host.config.panelPath;
  await putSettings(host, { threshold: 50, autoCompress: true, autoHandoff: true, defaultOperation: 'compress' });
  // 面板写一个与侧栏默认完全相同的值 → 没有语义变化 → 不创建会话快照
  const noop = await putPanel(host, { sessionId: 'sess-noop', autoCompress: true, autoHandoff: true, defaultOperation: 'compress' });
  assert.equal(noop.out.statusCode, 200);
  assert.equal(existsSync(panelPath), false, 'no-op 面板写入不得创建 panel.json 会话快照');
  // 侧栏默认改变 → 该会话（人类没真正改过面板）跟随新默认
  await putSettings(host, { threshold: 50, defaultOperation: 'continue', autoCompress: false, autoHandoff: false });
  const followed = await getPanel(host, 'sess-noop');
  assert.equal(followed.json.panel.defaultOperation, 'continue');
  assert.equal(followed.json.panel.autoCompress, false);
});

test('host: agent 内部写（source:agent）不把侧栏默认值固化进新会话（handoff 子会话，B-P2-8）', () => {
  // 直接走 panel-store（agent.js 的写入路径）：子会话只继承显式授权字段。
  globalThis[SETTINGS_KEY] = { threshold: 40, defaultOperation: 'compress', autoCompress: false, autoHandoff: false };
  const panelPath = tmpPath('relay-panel-agent-');
  configurePanelStore({ panelPath });
  updatePanelState('sess-child-agent', { autoCompress: true, autoHandoff: true, authorizeNext: false }, { source: 'agent' });
  // 侧栏默认变化：子会话未显式继承的字段跟随默认（不再被「全新会话」固化）
  globalThis[SETTINGS_KEY] = { threshold: 40, defaultOperation: 'continue', autoCompress: false, autoHandoff: false };
  assert.equal(panelStateOf('sess-child-agent').defaultOperation, 'continue');
  assert.equal(panelStateOf('sess-child-agent').autoCompress, true);
  // 落盘记录只有显式字段（重启用同一 panelPath 时不会被默认值快照覆盖）
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(panelPath, 'utf8')).sessions['sess-child-agent']).sort(), ['authorizeNext', 'autoCompress', 'autoHandoff']);
});

test('host: panel 路由 connection.requestRejection 401/403 直接拒绝', async () => {
  for (const status of [401, 403]) {
    const host = fakeHost({ connection: { requestRejection: () => status } });
    const got = await callAsync(host.getRoute('/context-relay/panel'), { url: '/context-relay/panel?sessionId=sess-auth' });
    assert.equal(got.out.statusCode, status);
    assert.match(got.out.headers['content-type'], /text\/plain/);
    assert.equal(got.out.headers['cache-control'], 'no-store');
    assert.equal(got.out.body, status === 401 ? 'unauthorized' : 'forbidden');
  }
});

test('host v3: PUT authorizeNext 持久化回读；退役字段被忽略；显式默认操作生效', async () => {
  const host = fakeHost();
  // 白名单：authorizeNext 可写；退役 autoChoose/autoDecision 出现在 body 里也被丢弃。
  const on = await putPanel(host, { sessionId: 'sess-v3', autoChoose: true, authorizeNext: true, autoDecision: { operation: 'compress', at: 1 } });
  assert.equal(on.json.panel.authorizeNext, true);
  assert.equal(Object.prototype.hasOwnProperty.call(on.json.panel, 'autoChoose'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(on.json.panel, 'autoDecision'), false);
  // 退役字段 agent 面写入同样被丢弃（不落记录、不回显）
  updatePanelState('sess-v3', { autoDecision: { operation: 'handoff', at: 2 } });
  assert.equal(Object.prototype.hasOwnProperty.call(panelStateOf('sess-v3'), 'autoDecision'), false);
  // GET 回读 authorizeNext
  assert.equal((await getPanel(host, 'sess-v3')).json.panel.authorizeNext, true);
  // 显式给 defaultOperation（含 null）→ 生效；授权不受影响（模式不产生免审、也不清免审）
  await putPanel(host, { sessionId: 'sess-v3', defaultOperation: null });
  assert.equal(panelStateOf('sess-v3').authorizeNext, true);
  const setMode = await putPanel(host, { sessionId: 'sess-v3', defaultOperation: 'compress' });
  assert.equal(setMode.json.panel.defaultOperation, 'compress');
  assert.equal(setMode.json.panel.authorizeNext, true);
});

test('host v3: GET panel 的 live.organizeCount 可读', async () => {
  const host = fakeHost();
  publishLiveState('sess-count', { band: 'organize', phase: 'build', organizeCount: 3, overBudget: true });
  assert.equal((await getPanel(host, 'sess-count')).json.live.organizeCount, 3);
});

test('host: GET /context-relay/work-items 只读——不触发旧 workspace 台账惰性迁移写盘（C14）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'relay-wi-get-ro-'));
  const sessionId = 'sess-wi-get-ro';
  const session = { id: sessionId, header: { agentPreset: 'relay-long', cwd } };
  const legacyPath = join(cwd, '.scratch', 'context-relay', 'work-items.json');
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({
    version: 1, rev: 4, updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: sessionId,
    items: [{ id: 'legacy-1', title: '旧台账', status: 'doing', next: 'n' }],
  }));
  const host = fakeHost({
    sessions: { get: () => session },
    sessionProjections: {
      register: () => () => {},
      snapshot: () => ({ values: {} }),
      stateOf: (_session, key) => (key === 'agentPreset' ? 'relay-long' : undefined),
    },
  });
  const got = await callAsync(host.getRoute('/context-relay/work-items'), { url: '/context-relay/work-items?sessionId=' + encodeURIComponent(sessionId) });
  assert.equal(got.out.statusCode, 200);
  assert.equal(got.json.relay, true);
  const scopedPath = join(cwd, '.scratch', 'context-relay', 'work-items', sessionId + '.json');
  assert.equal(existsSync(scopedPath), false, '只读 GET 不得惰性迁移写盘');
  assert.equal(existsSync(legacyPath), true, '旧 workspace 台账原样保留');
  assert.equal(got.json.workItems, null, '只读 GET 只读当前会话级台账（不搬迁）');
});

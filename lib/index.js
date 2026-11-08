/**
 * dsh-context-relay — Host 平面入口。
 *
 * 做五件事（不注册模型工具、不注入提示词、无定时器）：
 *   1) 用 ctx.agentPresets.register 声明 relay preset（官方 ptc 行数据 + relay agent 行）；
 *   2) 用 ctx.skills.register 随包注册 human-loop / context-relay / doc-governance 技能；
 *   3) 向官方 sessionProjections 注册 relay 投影（agent 面派生状态的真源，服务缺失时跳过）；
 *   4) 暴露 HTTP 面：handoff 发布箱（GET /context-relay/api）、侧栏设置（/context-relay/settings）、
 *      按会话的 composer 面板（/context-relay/panel，读写面板状态 + agent 发布的实时压力）；
 *   5) 卸载时精确注销以上注册（返回 Promise：先等注册落定，再注销 preset）。
 *
 * 设计依据：docs/research/01-dsh-architecture.md §3.4/§3.5（注册 API 优先，不写 ~/.dsh/.agent-presets）。
 *
 * @module dsh-context-relay
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandFor, normalizeSettings, normalizeThresholds, readPressure, thresholdsFromPercent } from './policy.js';
import { listHandoffs } from './handoff-store.js';
import {
  configurePanelStore,
  isValidSessionId,
  liveStateOf,
  loadPanelStore,
  panelStateOf,
  savePanelStore,
  updatePanelState,
} from './panel-store.js';
import { PTC_BASE_PLUGINS } from './preset-base.js';
import { relayProjectionDefinition, RELAY_PROJECTION_KEY } from './projection.js';

export const name = 'dsh-context-relay';
export const inject = ['agentPresets', 'skills'];

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** relay preset 元数据（官方 ptc 行之外只加这些）。 */
const RELAY_PRESET = Object.freeze({
  name: '接力模式（Relay）',
  description: '上下文接力：PTC 呈现 + phase 协议 + 阈值哨兵 + 受控历史整理 + 结构化 handoff 开新会话。',
  order: 5,
});
/** 第二个用户可见模式：超长任务（= 原 Router P0 行为）。只在模式选择器选择时生效，默认 Relay 不受影响。 */
const LONG_RUN_PRESET = Object.freeze({
  name: '接力模式（Relay）· 超长任务',
  description: '用于预计跑很久的单会话：Lead 只调度、不执行（工具面无 bash/pwsh/write/edit），写/跑/读长文档一律派 worker，回执 ≤4KB 报告 + ≤200 字消息；产物不进 Lead 上下文。',
  order: 6,
});
const RELAY_AGENT_ROW_ID = 'relay-agent';
/**
 * relay preset 的提问工具配置（2026-11-03 用户裁决：**移除「会一直等你回答」的无限等待**）：
 * 官方 timed 模式 + timeout:60——提问工具**只用于简单问题**（是/否、二选一、低风险确认、只缺一个事实）；
 * 人 60s 内不答就返回 pending，模型继续独立工作或改用普通消息（大白话）汇报，问题仍可后答。
 * 复杂问题/需要决策/边界变化一律用普通回复消息等用户答复，不塞进提问工具（见 protocol.js「提问与用户交互纪律」）。
 * 程序内等待还受 PTC run_code 默认 120s 执行 deadline 约束，60s < 120s 留出余量。
 * 只合并到 preset 行 config，不改官方资产（lib/preset-base.js）。
 */
const RELAY_ASK_USER_CONFIG = Object.freeze({ mode: 'timed', timeout: 60 });
/** 侧栏设置（阈值基准 + 面板各选项默认值）：host 持久化 + 发布到 globalThis；panel-store 以此作按会话面板的默认值。 */
const SETTINGS_KEY = Symbol.for('dsh-context-relay.settings');
/** 失败告警限频位（同 key 30s 内只报一次）。 */
const WARN_KEY = Symbol.for('dsh-context-relay.warned');
const WARN_THROTTLE_MS = 30 * 1000;
const SETTINGS_ROUTE = '/context-relay/settings';
/** composer 面板（按会话的面板状态 + 实时压力）。 */
const PANEL_ROUTE = '/context-relay/panel';
/** PUT /context-relay/panel 只认这些键（handedOff/autoDecision 是内部字段，不接受外部写入）。 */
const PANEL_PATCH_KEYS = ['defaultOperation', 'autoChoose', 'autoCompress', 'autoHandoff', 'authorizeNext', 'unlimitedBudget', 'handoffUnlimitedBudget', 'handoffPreset'];
/** PUT 请求体上限（连接层/插件层都有上限）。 */
const MAX_BODY_BYTES = 8192;

/**
 * live 缺失时的宿主侧派生读取（2026-10-30：冷启动 chip 也要显示真实值，不等新 step）。
 * 打开会话后宿主已 attach（sessions.get 同步命中）；官方 contextPressure（wire 可见）与
 * relay 投影（host-only，stateOf 可读）都可同步读出，故不需要该会话产生新 step。
 * 只读：不写盘、不激活 agent、不 publish；任何服务缺失/会话未 attach/异常 → undefined
 * （GET 回 live:null，client 渲染中性降级 chip 并 4s 轮询自动重试）。
 * @param {object} wctx - 注入 webServer 的 host context（用 ctx.get 动态取可选服务）
 * @param {string} sessionId
 * @param {object} thresholds - 生效阈值（effectiveThresholds()）
 * @returns {object|undefined} 与 agent 发布同形的 live 状态（多 derived:true 标记）
 */
export function deriveLiveState(wctx, sessionId, thresholds) {
  try {
    const sessions = typeof wctx?.get === 'function' ? wctx.get('sessions') : undefined;
    const session = sessions?.get?.(sessionId);
    if (session === undefined || session === null) return undefined;
    const projections = typeof wctx?.get === 'function' ? wctx.get('sessionProjections') : undefined;
    if (projections === undefined || projections === null) return undefined;
    if (typeof projections.snapshot !== 'function') return undefined;
    const snapshot = projections.snapshot(session, ['contextPressure']);
    const pressure = readPressure({ projection: snapshot?.values?.contextPressure });
    // 压力不可得（无上报/投影无该键）时不构造 band:'ok' 假值——回 undefined 让 client 保持中性态。
    if (pressure.used === undefined) return undefined;
    const state = bandFor(pressure, thresholds);
    const relay = typeof projections.stateOf === 'function' ? projections.stateOf(session, RELAY_PROJECTION_KEY) : undefined;
    return {
      band: state.band,
      used: state.used,
      window: state.window,
      ratio: state.ratio,
      phase: typeof relay?.phase === 'string' ? relay.phase : undefined,
      organizeCount: Number.isInteger(relay?.organizeCount) && relay.organizeCount >= 0 ? relay.organizeCount : undefined,
      overBudget: state.band === 'organize' || state.band === 'relay',
      updatedAt: Date.now(),
      derived: true,
    };
  } catch {
    return undefined;
  }
}

function settingsFileOf(config) {
  const custom = config.settingsPath;
  if (typeof custom === 'string' && custom !== '') return custom;
  return join(homedir(), '.dsh', 'data', 'dsh-context-relay', 'settings.json');
}

/** 失败告警（同 key 30s 内只报一次，避免损坏文件/写盘失败刷日志；logger 不可用静默）。 */
function warnThrottled(logger, key, message) {
  const stamps = globalThis[WARN_KEY] instanceof Map ? globalThis[WARN_KEY] : (globalThis[WARN_KEY] = new Map());
  const now = Date.now();
  const last = stamps.get(key);
  if (last !== undefined && now - last < WARN_THROTTLE_MS) return;
  stamps.set(key, now);
  try { logger?.warn?.('[dsh-context-relay] ' + message); } catch { /* 忽略 */ }
}

/**
 * 载入 settings.json（B-P2-11 配置损坏恢复）：文件不存在 → 无文件设置；语法/语义损坏 →
 * rename 为 *.corrupt-<ts> + warn（限频），返回空（降级默认），不阻断 apply/preset 注册。
 * @returns {{ settings?: object, mtimeMs?: number }}
 */
function loadSettingsFile(path, fallback, logger) {
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings must be a JSON object');
    return { settings: normalizeSettings({ ...fallback, ...parsed }), mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    let backup = path + '.corrupt-' + Date.now();
    try { renameSync(path, backup); } catch { backup = undefined; }
    warnThrottled(logger, 'settings-load:' + path,
      'settings.json unreadable/invalid (' + String(error?.message ?? error) + '); '
      + (backup === undefined ? 'backup failed, using defaults' : 'renamed to ' + backup + ', using defaults'));
    return {};
  }
}

/**
 * 原子写 settings.json（tmp + rename）。写前若文件在本次载入/上次写盘后被其它进程改过 → warn
 * （B-P2-14：跨进程 last-writer-wins 至少可观测；不拒绝，避免人类保存被无声丢弃）。
 * 返回写入后的 mtimeMs；失败 throw（调用方回 5xx，内存不提交）。
 */
function writeSettingsFile(path, settings, { logger, lastMtimeMs } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const currentMtime = statSync(path).mtimeMs;
    if (lastMtimeMs !== undefined && currentMtime !== lastMtimeMs) {
      warnThrottled(logger, 'settings-conflict:' + path, 'settings.json was modified by another process; last writer wins');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tmp = path + '.' + process.pid + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
    throw error;
  }
  return statSync(path).mtimeMs;
}

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  return sendJson(res, status, { ok: false, code, message: String(message ?? code) });
}

/** 合法 sessionId：1-200 位字母/数字/下划线/连字符（GET/PUT 同校，拒绝 __proto__/NUL/超长/伪 id）。 */
function sessionIdOf(value) {
  return isValidSessionId(value) ? value : undefined;
}

/**
 * 读 PUT 请求体（≤8KB，JSON）。超限不 destroy 连接（真实 HTTP 客户端会拿不到响应/ECONNRESET）：
 * 返回带 statusCode=413 的错误并继续排空剩余流；JSON 语法错误返回 statusCode=400 的错误。
 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        chunks = [];
        fail(Object.assign(new Error('request body too large (limit ' + limit + ' bytes)'), { statusCode: 413, code: 'payload-too-large' }));
        // 丢弃剩余流：不销毁连接，响应还能正常写回客户端。
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => fail(error));
    req.on('end', () => {
      if (settled) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { fail(Object.assign(new Error('invalid JSON: ' + String(error?.message ?? error)), { statusCode: 400, code: 'invalid-json' })); }
    });
  });
}
/**
 * 可透传到 relay-agent 行 config 的 agent 选项（host 插件 config → preset 行 config）。
 * 只认白名单键，未设置时不写入（缺省不污染 preset 定义）；agent 面新增选项时同步加到这里。
 */
const AGENT_OPTION_KEYS = ['injectBrief', 'handoffApproval', 'inheritOnHandoff', 'settings', 'panelPath', 'routerMode', 'releaseOnCompress', 'releaseRetiredGeneration', 'teamFirstSubagents'];

function agentOptionsOf(config) {
  const options = {};
  for (const key of AGENT_OPTION_KEYS) {
    if (config[key] !== undefined) options[key] = config[key];
  }
  return options;
}

/** 极简 frontmatter 读取（只认 name/description/disable-model-invocation 三行）。 */
function readSkill(dirPath) {
  const text = readFileSync(join(dirPath, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (match !== null) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
      if (kv !== null) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return {
    name: meta.name,
    description: meta.description,
    content: (match === null ? text : text.slice(match[0].length)).trim(),
    modelInvocable: meta['disable-model-invocation'] !== 'true',
  };
}

function registerSkills(ctx) {
  const root = join(PKG_ROOT, 'skills');
  const disposers = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return disposers; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const skill = readSkill(join(root, entry.name));
      if (skill.name === undefined || skill.description === undefined) continue;
      disposers.push(ctx.skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        invocation: { modelInvocable: skill.modelInvocable, userInvocable: true },
      }));
    } catch (error) {
      ctx.logger?.warn?.('[dsh-context-relay] skill "' + entry.name + '" not registered: ' + String(error?.message ?? error));
    }
  }
  return disposers;
}

/**
 * relay preset：官方 ptc 的完整工具面（数据资产 lib/preset-base.js）+ 我们的
 * agent 行（必须放进 compaction 隔离组，才能在该 preset 内拿到 ctx.compaction）。
 */
export function relayPresetDefinition({ presetId, presetMeta = RELAY_PRESET, thresholds, agentOptions = {}, basePlugins = PTC_BASE_PLUGINS } = {}) {
  const plugins = structuredClone(basePlugins);
  const compaction = plugins.find((row) => row.id === 'compaction');
  if (compaction === undefined || !Array.isArray(compaction.config)) {
    throw new Error('context-relay: preset base is missing the compaction group');
  }
  // 提问工具：叠加官方 timed 配置 + timeout:60（只给简单问题用；超时 pending，v0.2.11）；官方行必须在 base 里。
  const askUser = plugins.find((row) => row.id === 'tool-ask-user');
  if (askUser === undefined) throw new Error('context-relay: preset base is missing the tool-ask-user row');
  askUser.config = { ...(askUser.config ?? {}), ...RELAY_ASK_USER_CONFIG };
  compaction.config.push({
    id: RELAY_AGENT_ROW_ID,
    // agent 行 URL 带一次性 query：预设在每次注册时才 import agent.js，宿主热重载 index.js 时
    // 该模块仍是旧 ESM 缓存（只有 preset 挂载会加载它）——带唯一 query 强制拿到新一代。
    name: new URL('./agent.js', import.meta.url).href + '?relay=' + Date.now(),
    config: { presetId, ...(thresholds === undefined ? {} : { thresholds }), ...agentOptions },
  });
  return { id: presetId, ...presetMeta, plugins };
}

export function apply(ctx, config = {}) {
  const presetId = config.presetId ?? 'relay';
  /** 超长任务模式（第二个 preset；id 默认 relay-long）。 */
  const longPresetId = config.longPresetId ?? presetId + '-long';
  /** 两个用户可见模式 id：PUT handoffPreset 白名单 / GET modes / agent 面交接目标白名单共用。 */
  const relayPresetIdList = [presetId, longPresetId];
  const relayPresetIds = new Set(relayPresetIdList);
  const legacyThresholds = normalizeThresholds(config.thresholds ?? {});
  // 侧栏设置（2026-10-25 v2 口径；v0.4.0：默认模式持久）：阈值基准 + 面板默认模式/三自动授权，作为未改面板会话的默认值；
  // 面板一旦由人类写入自己的记录即快照覆盖（panel-store），不再跟随侧栏默认变化。
  // explicit 语义（B-P2-16）：settings.json（file）> config.settings > config.threshold 为 settings 来源；
  // 仅当无任何 settings 来源时，legacy config.thresholds（仅比例线）生效。settingsExplicit 发布给 agent：
  // explicit=true 时 agent 用侧栏阈值，否则用 legacy thresholds。人类侧栏 PUT 成功后 explicit=true。
  const settingsDefaults = normalizeSettings(config.settings ?? { threshold: config.threshold });
  const settingsPath = settingsFileOf(config);
  const settingsConfigured = config.settings !== undefined || config.threshold !== undefined;
  const fileSettings = loadSettingsFile(settingsPath, settingsDefaults, ctx.logger);
  let settingsMtimeMs = fileSettings.mtimeMs;
  let settings = normalizeSettings({ ...settingsDefaults, ...(fileSettings.settings ?? {}) });
  let settingsExplicit = fileSettings.settings !== undefined || settingsConfigured;
  // legacy thresholds 生效时，人类可见的阈值基准必须反推自生效值（threshold = round(organizeRatio*100)），
  // 否则侧栏显示 40 而 agent 实际用 45/50/60，人类点一次「保存」就静默覆盖部署配置。
  if (!settingsExplicit && config.thresholds !== undefined) {
    settings = normalizeSettings({ ...settings, threshold: Math.round(legacyThresholds.organizeRatio * 100) });
  }
  const effectiveThresholds = () => (settingsExplicit || config.thresholds === undefined ? thresholdsFromPercent(settings.threshold) : legacyThresholds);
  const publishSettings = () => { globalThis[SETTINGS_KEY] = { ...settings, explicit: settingsExplicit }; };
  publishSettings();
  // 面板状态（按会话）：本插件进程内 Map + panel.json；agent 面（relay_phase/审批闸门）读同一份。
  configurePanelStore(config, ctx.logger);
  loadPanelStore(config);

  let skillDisposers = [];
  try { skillDisposers = registerSkills(ctx); } catch (error) {
    ctx.logger?.warn?.('[dsh-context-relay] skill registration failed: ' + String(error?.message ?? error));
  }

  const presetDisposers = [];
  let disposed = false;
  // 只有部署显式配置 legacy `config.thresholds` 时才把阈值传给 relay-agent 行；否则行 config 不带 thresholds，
  // agent 走 live settings（默认基准 35% → 30/35/45）。否则 normalizeThresholds({}) 的 legacy 默认
  // (35/40/50) 会被无条件透传，导致 fresh deploy 的 agent 分档与 HTTP/侧栏（30/35/45）不一致（v0.2.4 P1）。
  const presetThresholds = config.thresholds === undefined ? undefined : legacyThresholds;
  const registration = (async () => {
    const agentOptions = { ...agentOptionsOf(config), ...(settingsConfigured ? { settings } : {}) };
    // 两个预设：默认 Relay（工具面不裁）+ 超长任务（agent 行强制 routerMode:true → Lead 只调度）。
    // 定义构造与注册都做失败隔离：任一模式失败只 warn，不能让另一个（尤其默认 Relay）消失，
    // 也不能让 registration reject（否则卸载 Promise 会 reject）。
    // relayPresetIds 透传给 agent 面：relay_handoff 用它校验面板 handoffPreset（可选的下一个会话模式）。
    const specOptions = { ...agentOptions, relayPresetIds: relayPresetIdList };
    const specs = [
      { id: presetId, meta: RELAY_PRESET, options: specOptions },
      { id: longPresetId, meta: LONG_RUN_PRESET, options: { ...specOptions, routerMode: true } },
    ];
    for (const spec of specs) {
      try {
        const definition = relayPresetDefinition({ presetId: spec.id, presetMeta: spec.meta, thresholds: presetThresholds, agentOptions: spec.options });
        const dispose = await ctx.agentPresets.register(definition);
        if (disposed) {
          // 卸载先于注册完成（热重载/快速停用）：立刻撤销，避免旧 preset 残留或重名冲突
          // （官方 registry 重名只 throw，宿主仅 warn，新实例会静默缺少 preset）。
          try { await dispose(); } catch { /* 忽略 */ }
          continue;
        }
        presetDisposers.push(dispose);
        ctx.logger?.info?.('[dsh-context-relay] agent preset "' + spec.id + '" registered');
      } catch (error) {
        ctx.logger?.warn?.('[dsh-context-relay] preset "' + spec.id + '" registration failed: ' + String(error?.message ?? error));
      }
    }
  })();

  // 官方 sessionProjections：注册 relay 投影（phase/goal/organizeCount/哨兵档位等派生状态），
  // agent 面用 stateOf(session, RELAY_PROJECTION_KEY) 读取；服务缺失（老内核/headless）时跳过并 warn，
  // agent 面回退到日志扫描，不阻断 preset。effect 随本插件 fiber 卸载注销投影。
  if (ctx.get('sessionProjections') === undefined) {
    ctx.logger?.warn?.('[dsh-context-relay] sessionProjections unavailable; relay projection not registered (agent falls back to log scan)');
  }
  ctx.inject(['sessionProjections'], (pctx) => {
    pctx.effect(() => pctx.sessionProjections.register(relayProjectionDefinition()), 'dsh-context-relay: relay projection');
    pctx.logger?.info?.('[dsh-context-relay] relay projection "' + RELAY_PROJECTION_KEY + '" registered');
  });

  // HTTP 面（官方 webServer exact 路由，认证统一走连接层）：handoff 发布箱 / 侧栏设置 / composer 面板。
  ctx.inject(['webServer'], (wctx) => {
    const register = (path, handler, label) => wctx.effect(
      () => wctx.webServer.register({ kind: 'exact', path, handler }),
      'dsh-context-relay: ' + label,
    );
    /**
     * 连接层认证包装（401/403 已写好响应）+ 统一错误语义：
     * 认证层异常 → fail-closed 503 JSON；handler 异常 → 500 JSON（不让响应退化为宿主 400 空 body）。
     */
    const guarded = (handler) => async (req, res) => {
      try {
        const rejection = wctx.get?.('connection')?.requestRejection?.({ headers: req.headers });
        if (rejection !== undefined) {
          res.statusCode = rejection;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
      } catch (error) {
        warnThrottled(ctx.logger, 'auth:' + String(req?.url ?? ''),
          'connection.requestRejection threw (' + String(error?.message ?? error) + '); failing closed 503');
        return sendError(res, 503, 'auth-unavailable', 'authentication layer unavailable');
      }
      try {
        return await handler(req, res);
      } catch (error) {
        if (res.headersSent !== true) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
          return sendError(res, status, error?.code ?? 'handler-failed', error?.message ?? error);
        }
        try { res.end(); } catch { /* 忽略 */ }
        return undefined;
      }
    };
    /**
     * 会话当前 preset：模式选择器里 agentPresets.select 只 append agent-preset/selected、不改 creation header
     * （header 是创建时的值），所以投影 agentPreset 优先、header 兜底；sessions 服务缺失/未 attach/投影异常 → null。
     */
    const currentPresetOf = (sessionId) => {
      try {
        const session = wctx.get?.('sessions')?.get?.(sessionId);
        if (session === undefined || session === null) return null;
        let currentPreset;
        try {
          const projections = wctx.get?.('sessionProjections');
          currentPreset = typeof projections?.stateOf !== 'function' ? undefined : projections.stateOf(session, 'agentPreset');
        } catch { currentPreset = undefined; }
        if (currentPreset === undefined || currentPreset === null) currentPreset = session?.header?.agentPreset;
        return typeof currentPreset === 'string' ? currentPreset : null;
      } catch { return null; }
    };

    // M3：agent 面写入的 handoff 发布箱 → 同源只读 HTTP，供 client bundle 轮询后提示（不自动切页）。
    register('/context-relay/api', guarded((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, message: 'method not allowed' });
      return sendJson(res, 200, { ok: true, handoffs: listHandoffs() });
    }), 'handoff api');

    // 侧栏设置：阈值基准 + 面板默认值（GET 读六字段 + 生效阈值；PUT 校验/裁剪、持久化成功后再提交，
    // 免重启热生效，写盘失败明确 5xx 且内存不半提交）。
    register(SETTINGS_ROUTE, guarded(async (req, res) => {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, settings, thresholds: effectiveThresholds(), path: settingsPath, explicit: settingsExplicit });
      }
      if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, message: 'method not allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
        return sendError(res, status, error?.code ?? 'invalid-request', error?.message ?? error);
      }
      let next;
      try {
        const bodySettings = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
        // 部分更新合并：只传 {threshold} 的旧客户端不会把其余 4 个默认值重置掉。
        next = normalizeSettings({ ...settings, ...bodySettings });
        // 互斥判断以 body 为准（P3）：显式开自动 → 清预设；只显式给预设（未同时给 autoChoose）→ 关自动。
        if (bodySettings.autoChoose === true) next.defaultOperation = null;
        else if (bodySettings.defaultOperation !== undefined && bodySettings.autoChoose === undefined) next.autoChoose = false;
      } catch (error) {
        return sendError(res, 400, 'invalid-settings', error?.message ?? error);
      }
      let mtimeMs;
      try {
        // 持久化优先（B-P2-10）：落盘成功才提交内存/发布；失败明确 5xx，内存不半提交。
        mtimeMs = writeSettingsFile(settingsPath, next, { logger: ctx.logger, lastMtimeMs: settingsMtimeMs });
      } catch (error) {
        warnThrottled(ctx.logger, 'settings-save:' + settingsPath,
          'settings.json write failed (' + String(error?.code ?? error?.message ?? error) + '); in-memory settings unchanged');
        return sendJson(res, 500, { ok: false, code: 'settings-persist-failed', persisted: false, message: String(error?.message ?? error) });
      }
      settings = next;
      settingsExplicit = true;
      settingsMtimeMs = mtimeMs;
      publishSettings();
      ctx.logger?.info?.('[dsh-context-relay] settings updated threshold=' + settings.threshold);
      return sendJson(res, 200, { ok: true, persisted: true, settings, thresholds: effectiveThresholds(), path: settingsPath, explicit: true });
    }), 'settings api');

    // composer 面板（按会话）：GET 面板状态 + agent 发布的实时压力（stale live 不下发）；PUT 面板模式 / 三个自动授权。
    register(PANEL_ROUTE, guarded(async (req, res) => {
      if (req.method === 'GET') {
        const sessionId = sessionIdOf(new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId'));
        if (sessionId === undefined) return sendError(res, 400, 'invalid-session-id', 'invalid sessionId');
        const thresholds = effectiveThresholds();
        // agent 每 step 发布的 live 优先；缺失（宿主冷启动/未发布）或超 TTL 时从会话投影同步派生——
        // 打开会话后宿主已 attach，官方 contextPressure + relay 投影可读，不需要该会话产生新 step。
        const live = liveStateOf(sessionId) ?? deriveLiveState(wctx, sessionId, thresholds) ?? null;
        // v0.2.7：composer 小胶囊只在「当前 preset 是 relay」的会话显示；v0.2.14 同时下发 modes（两个模式 id）
        // 与 preset（当前模式），供客户端渲染「下一个新会话模式」滑动开关。
        const preset = currentPresetOf(sessionId);
        const relay = relayPresetIds.has(preset);
        return sendJson(res, 200, {
          ok: true,
          sessionId,
          relay,
          preset,
          modes: { relay: presetId, long: longPresetId },
          panel: panelStateOf(sessionId),
          live,
          thresholds,
          settings: { threshold: settings.threshold },
        });
      }
      if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, message: 'method not allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
        return sendError(res, status, error?.code ?? 'invalid-request', error?.message ?? error);
      }
      const sessionId = sessionIdOf(body?.sessionId);
      if (sessionId === undefined) return sendError(res, 400, 'invalid-session-id', 'invalid sessionId');
      // v0.2.14：交接目标 preset 只接受 null（回退本会话 preset）/ 本插件两个模式 id——非法值 400 且面板不变。
      const requestedHandoffPreset = body?.handoffPreset;
      if (requestedHandoffPreset !== undefined && requestedHandoffPreset !== null && !relayPresetIds.has(requestedHandoffPreset)) {
        return sendError(res, 400, 'invalid-handoff-preset', 'handoffPreset must be null or one of: ' + relayPresetIdList.join(', '));
      }
      const patch = {};
      for (const key of PANEL_PATCH_KEYS) if (body[key] !== undefined) patch[key] = body[key];
      // v0.3.3：人类显式给 defaultOperation / autoChoose（body 有该键）即已决策 → 旧模型推荐作废。
      // recommended* 不在 PANEL_PATCH_KEYS：推荐只能由 agent 面 relay_recommend 写入，人类不可直接写。
      if (Object.prototype.hasOwnProperty.call(body, 'defaultOperation') || Object.prototype.hasOwnProperty.call(body, 'autoChoose')) {
        patch.recommendedOperation = null;
        patch.recommendedReason = '';
        patch.recommendedAt = null;
      }
      // 人类在面板显式写非 null 模式 = 覆盖模型自决（侧栏默认值不走 PUT，不清）。
      if (body.defaultOperation !== undefined && body.defaultOperation !== null) patch.autoDecision = null;
      // rev5.2：autoChoose（模型自决档）与显式模式互斥——开自动清模式，显式给模式关自动。
      if (patch.autoChoose === true) patch.defaultOperation = null;
      else if (patch.defaultOperation !== undefined) patch.autoChoose = false;
      // 先只改内存，再明确持久化结果（B-P2-10：写盘失败必须上报 persisted:false，不能回 200「已保存」）。
      const panel = updatePanelState(sessionId, patch, { persist: false });
      const persisted = savePanelStore();
      if (!persisted) warnThrottled(ctx.logger, 'panel-save', 'panel.json write failed; panel state kept in memory only');
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        panel,
        persisted,
        ...(persisted ? {} : { message: 'panel state not persisted to disk (kept in memory until restart)' }),
      });
    }), 'panel api');
  });

  // 卸载：skills 同步撤销；preset 注册可能是异步的，teardown 返回 Promise，
  // cordis 会等它落定（避免「旧 dispose 未完成、新实例 register 重名」的微任务竞态）。
  ctx.effect(() => () => {
    disposed = true;
    for (const dispose of skillDisposers) { try { dispose(); } catch { /* 忽略 */ } }
    skillDisposers = [];
    return registration.then(async () => {
      while (presetDisposers.length > 0) {
        const dispose = presetDisposers.shift();
        try { await dispose(); } catch { /* 忽略 */ }
      }
    });
  }, 'dsh-context-relay: unregister');
}

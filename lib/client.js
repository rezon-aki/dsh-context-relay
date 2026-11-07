window.__ModuleLoader__.load({ id: "dsh-context-relay", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
const React = require("react");
const h = React.createElement;
// 面板用 portal 挂到 document.body：脱离 composer dock 的层叠/裁剪上下文，
// backdrop-filter 才能采样到页面真实背景（否则毛玻璃看不出来），也不会被侧栏/输入区裁掉。
let createPortal = null;
try {
  const ReactDOM = require("react-dom");
  if (ReactDOM !== null && typeof ReactDOM.createPortal === "function") createPortal = ReactDOM.createPortal;
} catch { /* 无 react-dom 的宿主回退就地渲染 */ }
const API = "/context-relay/api";
const SETTINGS_API = "/context-relay/settings";
const PANEL_API = "/context-relay/panel";
const POLL_MS = 4000;
const PAGE_LOAD = Date.now();

// 模块级提示状态：dock 组件订阅，轮询器更新（跨组件实例/重挂载存活）。
// 发布箱可保留多条（最近 8 条、最新在前）：逐条消费进队列，关闭一条再提示下一条（不互相覆盖）。
// seenIds/lastSeenAt 记 id 与 createdAt，兼容跨进程 id（<ms>-<seq>）与乱序轮询；seenIds 有界防泄漏。
const MAX_SEEN = 32;
const state = { notices: [], currentSessionId: "", seenIds: [], lastSeen: "", lastSeenAt: 0 };
const listeners = new Set();
function notify() { for (const fn of listeners) { try { fn(); } catch { /* 组件已卸载 */ } } }
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function pushNotice(notice) { state.notices.push(notice); notify(); }
function removeNotice(notice) {
  const index = state.notices.indexOf(notice);
  if (index >= 0) state.notices.splice(index, 1);
  notify();
}
// 只显示属于当前会话（发起接力的父会话）的提示；其余会话的提示留在队列里等切回去。
function visibleNotice() {
  return state.notices.find((notice) => notice.parentSessionId !== "" && notice.parentSessionId === state.currentSessionId) || null;
}
function markSeen(id, createdAt) {
  if (id !== "") {
    state.seenIds.push(id);
    if (state.seenIds.length > MAX_SEEN) state.seenIds.shift();
    state.lastSeen = id;
  }
  if (Number.isFinite(createdAt) && createdAt > state.lastSeenAt) state.lastSeenAt = createdAt;
}

const bar = { display: "flex", gap: 8, alignItems: "center", border: "1px solid var(--dsh-border, #d0d7de)", borderRadius: 8, padding: "6px 10px", marginBottom: 8, fontSize: 12, background: "var(--dsh-surface-2, rgba(127,127,127,0.08))", color: "inherit" };
const grow = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const btn = { padding: "2px 8px", borderRadius: 6, border: "1px solid var(--dsh-border, #d0d7de)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 };

function openHandoff(item) {
  const ctx = appCtx;
  if (!ctx) return;
  const go = () => { try { ctx.uiWorkspace.openSession(item.sessionId); } catch { /* 会话不可达则静默，提示仍在 */ } };
  try {
    Promise.resolve(ctx.sessions.refresh()).then(go, go);
  } catch { go(); }
}

function RelayNotice() {
  const [, force] = React.useReducer((v) => v + 1, 0);
  React.useEffect(() => subscribe(force), []);
  const notice = visibleNotice();
  // 只在「发起接力的会话」里提示：切到其他会话（含新会话）一律不显示，避免跨会话打扰。
  if (notice === null) return null;
  const canOpen = notice.sessionId !== "" && notice.sessionId !== state.currentSessionId;
  return h("div", { style: bar },
    h("span", { style: grow }, "⚡ 上下文接力：" + notice.text),
    canOpen ? h("button", { style: btn, onClick: () => openHandoff(notice) }, "打开新会话") : null,
    h("button", { style: btn, onClick: () => removeNotice(notice) }, "关闭"));
}

function DockEntry(props) {
  const id = props && props.session && props.session.sessionId;
  if (id !== undefined && id !== null) state.currentSessionId = String(id);
  return h(RelayNotice);
}

let appCtx = null;

function poll() {
  if (!appCtx || document.visibilityState === "hidden") return;
  fetch(API, { headers: { accept: "application/json" }, cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data || data.ok === false || !Array.isArray(data.handoffs) || data.handoffs.length === 0) return;
      // 发布箱多条（最新在前）→ 从旧到新逐条消费，每条只提示一次；旧提示不再被新 handoff 覆盖。
      for (let index = data.handoffs.length - 1; index >= 0; index -= 1) {
        const item = data.handoffs[index];
        if (item === null || typeof item !== "object") continue;
        const id = String(item.id || "");
        const createdAt = Number(item.createdAt) || 0;
        if (id === "" || state.seenIds.includes(id)) continue;
        // 跨进程/乱序保护：比已见更旧的 handoff（例如重启后读到旧快照）不再提示。
        if (createdAt !== 0 && createdAt < state.lastSeenAt) { markSeen(id, createdAt); continue; }
        markSeen(id, createdAt);
        // 页面加载前就存在的旧 handoff：只记已见，不抢当前会话。
        if (createdAt !== 0 && createdAt < PAGE_LOAD - 3000) continue;
        if (item.sessionId !== "" && item.sessionId === state.currentSessionId) continue;
        const title = item.title ? "「" + item.title + "」" : "";
        const goal = item.goal ? "：" + item.goal : "";
        // 只提示不自动切页（人类已明确取消自动跳转）；点「打开新会话」由用户决定。
        // 提示归属发起接力的会话（parentSessionId），切到别的会话不渲染，避免跨会话显示。
        pushNotice({ sessionId: item.sessionId, parentSessionId: item.parentSessionId || "", text: "接力完成，新会话已创建" + title + goal });
      }
    })
    .catch(() => { /* 下次轮询再试 */ });
}

// ── 侧栏设置卡片（Plugins 页 → relay 卡片）──────────────────────────────────
const card = { border: "1px solid var(--dsh-border, #d0d7de)", borderRadius: 8, padding: "10px 12px", fontSize: 13, display: "grid", gap: 8, color: "inherit" };
const row = { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" };
const dim = { color: "var(--dsh-text-secondary, #6b7280)", fontSize: 12 };
const numInput = { width: 64, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--dsh-border, #d0d7de)", background: "transparent", color: "inherit" };
// 原生下拉的选项在部分平台上用页面文字色渲染（浅色会与白底融为一体）→ 显式黑字白底。
const selectInput = { maxWidth: 210, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, #d0d7de))", background: "#ffffff", color: "#111827", fontSize: 12 };
const selectOption = { color: "#111827", background: "#ffffff" };

function toggleRow(label, checked, onChange) {
  return h("label", { style: { ...row, justifyContent: "flex-start" } },
    h("input", { type: "checkbox", checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
    h("span", { style: grow }, label));
}

// v0.2.20：popover 开关改为「水缸」按钮——去掉勾选框；开启=注水，关闭=排水。
// v0.2.30（用户裁决：「像参考一样，多元素各自运动，模拟喷涌的液体注满缸体的过程」）：
// v0.2.30 最终形态（查过场景切换/液态填充的成熟做法后改：浪 = 水面本身，不再有横穿的光斑状物体）：
// 纯 CSS transition，无 canvas/rAF/keyframes；所有元素 delay 0 同时开始：
// ① 液体主体从缸底下方升起（450ms，带一点水体惯性；顶部 = SVG mask 波浪边缘，浪就是水面）；
// ② 动态水面波层：重复波形在水面缓慢横向流动（900ms 一次到位），同时随水位升高浪幅收小/水面落定；
// ③ 水面高光浪线（白色泡沫）贴液体顶部随水面上浮，终态停在液面；
// ④ 5 颗飞溅液滴从水面弹出（短距、局部、不横穿整行）；
// ⑤ 行底/三色边框/淡光/文字色 crossfade。关闭 = 同一组过渡反向；reduced-motion 直接终态。
// 保留：整行布局/尺寸、button > 文字 + aria-hidden 装饰层、aria-pressed、写入字段、三色。
// 三色：蓝（autoCompress）/ 绿（autoHandoff）/ 樱花红（新会话注入预算无上限）。
function tankRow(label, checked, onChange, tone) {
  const on = checked === true;
  const drop = (n) => h("span", { key: "drop-" + n, className: "relay-v3-tank-drop relay-v3-tank-drop-" + n });
  const spark = (n) => h("span", { key: "spark-" + n, className: "relay-v3-tank-spark relay-v3-tank-spark-" + n });
  return h("button", {
    type: "button",
    "aria-pressed": on,
    className: "relay-v3-tank relay-v3-tank-" + tone + (on ? " relay-v3-tank-on" : ""),
    onClick: () => onChange(on !== true),
  },
    h("span", { className: "relay-v3-tank-label", style: grow }, label),
    h("span", { className: "relay-v3-tank-art", "aria-hidden": "true" },
      tone === "sakura"
        // v0.2.30：新会话预算行 = 与接力 chip 同款的独角兽电路纹 + 火星；电路纹出现时从左到右擦出（clip-path）
        ? [h("span", { key: "veins", className: "relay-v3-tank-veins", style: { background: UNICORN_VEINS } }),
            h("span", { key: "sparks", className: "relay-v3-tank-sparks" }, spark(1), spark(2), spark(3))]
        : h("span", { className: "relay-v3-tank-liquid" },
            h("span", { className: "relay-v3-tank-body" }),
            h("span", { className: "relay-v3-tank-wave" }),
            h("span", { className: "relay-v3-tank-crest" }),
            drop(1), drop(2), drop(3), drop(4), drop(5))));
}

// v0.2.14：下一个接力新会话的模式（二态滑动开关：左 Relay / 右 Relay · 超长任务）。
// 未设置（null）= 跟随本会话 preset（历史行为不变）；点击写对侧显式 preset id，handoff 成功后不消费（sticky）。
const MODE_LABELS = { relay: "Relay", "relay-long": "Relay · 超长任务" };
const modeLabel = (id) => MODE_LABELS[id] || (typeof id === "string" && id !== "" ? id : "未知");
function handoffModeSwitch(data, panel, update) {
  const modes = data && data.modes;
  // 旧 host 不返回 modes / 非 relay 会话 → 不渲染（保持历史行为，不出现空开关）。
  if (!data || data.relay !== true || !modes || typeof modes.relay !== "string" || typeof modes.long !== "string") return null;
  const preset = typeof data.preset === "string" && data.preset !== "" ? data.preset : null;
  const fixed = panel && typeof panel.handoffPreset === "string" && panel.handoffPreset !== "" ? panel.handoffPreset : null;
  // right = 右侧「Relay · 超长任务」：显式 handoffPreset 优先；null 时跟随本会话 preset。
  const right = (fixed === null ? preset : fixed) === modes.long;
  const currentText = modeLabel(fixed === null ? preset : fixed);
  const nextText = modeLabel(right ? modes.relay : modes.long);
  const title = "新会话模式：" + (fixed === null
    ? "默认跟随本会话（当前「" + currentText + "」）；切换后固定"
    : "已固定为「" + currentText + "」（默认跟随本会话，当前「" + modeLabel(preset) + "」）；切换后固定")
    + "，成功后不消费（点击切换为「" + nextText + "」）";
  const label = (text, on, side) => h("span", {
    key: side,
    className: "relay-v3-slide-label relay-v3-slide-label-" + side + (on ? " relay-v3-slide-label-on" : ""),
  }, text);
  return h("div", { className: "relay-v3-mode" },
    h("div", { className: "relay-v3-mode-title", style: dim }, "下一个接力新会话"),
    h("button", {
      type: "button",
      role: "switch",
      "aria-checked": right,
      "aria-label": "下一个接力新会话模式",
      className: "relay-v3-slide " + (right ? "relay-v3-slide-right" : "relay-v3-slide-left"),
      title,
      onClick: () => update({ handoffPreset: right ? modes.relay : modes.long }),
    },
      h("span", { className: "relay-v3-slide-track" },
        h("span", { className: "relay-v3-slide-fill relay-v3-slide-fill-blue" }),
        h("span", { className: "relay-v3-slide-fill relay-v3-slide-fill-long" }),
        h("span", { className: "relay-v3-slide-thumb" }),
        label(modeLabel(modes.relay), right !== true, "left"),
        label(modeLabel(modes.long), right === true, "right"))));
}

function RelaySettings() {
  const [settings, setSettings] = React.useState(null);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let alive = true;
    fetch(SETTINGS_API, { headers: { accept: "application/json" }, cache: "no-store" })
      .then((res) => res.json())
      .then((data) => { if (alive && data && data.ok) setSettings(data.settings); })
      .catch(() => { if (alive) setError("读取 relay 设置失败"); });
    return () => { alive = false; };
  }, []);
  const update = (patch) => setSettings((prev) => ({ ...(prev || {}), ...patch }));
  const save = () => {
    setStatus("保存中…");
    setError("");
    fetch(SETTINGS_API, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        threshold: Number(settings.threshold),
        // 互斥：autoChoose 开时 defaultOperation 必须 null（「自动（模型决定）」不在模式里再单列）。
        defaultOperation: settings.autoChoose === true ? null : (settings.defaultOperation || null),
        autoChoose: settings.autoChoose === true,
        autoCompress: settings.autoCompress === true,
        autoHandoff: settings.autoHandoff === true,
        // v0.2.7：unlimitedBudget 不再由侧栏控制（移入 composer 模型选择器右侧小胶囊，按会话）；
        // 不发送该字段 → PUT 部分更新合并会保留 settings.json 里已保存的值（作为默认值来源）。
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data && data.ok) { setSettings(data.settings); setStatus("已保存（立即生效）"); }
        else { setStatus(""); setError((data && data.message) || "保存失败"); }
      })
      .catch(() => { setStatus(""); setError("保存失败"); });
  };
  if (!settings) return h("div", { style: card }, error || "读取 relay 设置…");
  const warnPct = Math.max(0, Number(settings.threshold) - 5);
  const relayPct = Math.min(100, Number(settings.threshold) + 10);
  return h("div", { style: card },
    h("div", { style: { fontWeight: 600 } }, "接力（Relay）设置"),
    h("div", { style: dim }, "阈值基准 " + settings.threshold + "%：提醒 " + warnPct + "% / 二次提醒 " + settings.threshold + "% / 硬线 " + relayPct + "%；超预算不得开新 phase。下面的默认模式与自动授权是新会话（或还没在面板里改过的会话）的初始值；模式在本会话内持久（不消费），面板改动会按会话覆盖。"),
    h("label", { style: row },
      h("span", null, "阈值基准（%）"),
      h("input", { type: "number", min: 20, max: 85, step: 1, value: settings.threshold, style: numInput, onChange: (event) => update({ threshold: Number(event.target.value) }) })),
    h("label", { style: row },
      h("span", null, "默认模式"),
      h("select", {
        value: settings.autoChoose === true ? "auto" : (settings.defaultOperation || ""),
        style: selectInput,
        onChange: (event) => {
          const value = event.target.value;
          // 「自动（模型决定）」= autoChoose 开且无具体模式；两者互斥。
          update(value === "auto"
            ? { autoChoose: true, defaultOperation: null }
            : { autoChoose: false, defaultOperation: value || null });
        },
      }, ...OPERATION_OPTIONS.map((option) => h("option", { key: String(option.value), value: option.value || "", style: selectOption }, optionText(option, false))))),
    toggleRow("默认：压缩操作自动授权（autoCompress）", settings.autoCompress, (value) => update({ autoCompress: value })),
    toggleRow("默认：开新会话自动授权（autoHandoff）", settings.autoHandoff, (value) => update({ autoHandoff: value })),
    h("div", { style: row },
      h("span", { style: dim }, error || status || "改动保存后立即生效"),
      h("button", { style: btn, onClick: save }, "保存")));
}

// ── composer 面板（chip + 非阻塞 popover；按会话）──────────────────────────
// 收起态 chip 文案：预设 > 模型自决 > 自动 > 问我（契约 §3.1；不复用 popover 既有 label，M1）。
const CHIP_LABELS = { compress: "压缩", handoff: "新会话", continue: "继续", "compress-then-handoff": "压缩→新会话" };
const chipLabel = (operation) => (operation && CHIP_LABELS[operation]) || "问我";
// 模型自决（panel.autoDecision）只在 autoChoose 开启时有意义；host 已归一化，客户端仍守形状。
function autoDecisionOf(panel) {
  const decision = panel && panel.autoDecision;
  if (!decision || typeof decision !== "object") return null;
  if (decision.operation !== "compress" && decision.operation !== "handoff") return null;
  return { operation: decision.operation, at: Number(decision.at) };
}
// v0.4.0：chip 显示**当前模式**（不再是一次性「下一次操作」）：模式在本会话持久、接力后由新会话继承。
// 两段式模式「压缩→新会话」直接显示模式名；长模式没有该档与「自动」档（存量值视觉按「继续」归一，
// host 同样归一；v0.3.4 起长模式不再产生/执行 cth）。
function modeOf(panel, longMode) {
  if (longMode === true && panel && (panel.autoChoose === true || panel.defaultOperation === "compress-then-handoff")) {
    return { label: "继续", shimmer: false };
  }
  const preset = panel && panel.defaultOperation;
  if (preset) return { label: chipLabel(preset), shimmer: false };
  if (panel && panel.autoChoose === true) return { label: "自动", shimmer: true };
  return { label: "问我", shimmer: false };
}
// 模型决定时间：本地 HH:MM；无有效时间 → 「—」。
function decisionTimeText(at) {
  if (!Number.isFinite(at)) return "—";
  try { return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch { return "—"; }
}
// 模式选项：侧栏下拉与面板单选共用（侧栏显示短 label，面板 label + hint）。
const OPERATION_OPTIONS = [
  { value: null, label: "问我", hint: "到线时问人类，推荐" },
  { value: "compress", label: "压缩继续", hint: "先 relay_organize 再重试 phase" },
  { value: "handoff", label: "接力新会话", hint: "立即创建新会话、消耗额度；模式只决定做什么，不免审批（免审看 autoHandoff/授权下一次）" },
  { value: "continue", label: "继续", hint: "不压缩不拦" },
  { value: "compress-then-handoff", label: "压缩→新会话", hint: "第一次压缩，第二次新会话" },
  { value: "auto", label: "自动（模型决定）", hint: "模型自己判断压缩/新会话，先记录再执行" },
];
const optionText = (option, withHint) => (withHint ? option.label + "（" + option.hint + "）" : option.label);
// ── v0.3.3：模型推荐（Lead 通过 relay_recommend 提交；只做面板高亮/参考）──────────────
// 推荐不改变预设与人类决策权、不自动执行、不产生审批豁免；预设仍决定 chip 标签与执行。
const RECOMMEND_OPERATIONS = ["compress", "continue", "handoff", "compress-then-handoff"];
// host 已归一化；客户端仍守形状（旧 host 无这些字段 → null，不渲染任何推荐 UI）。
// v0.3.4：长模式已移除「压缩→新会话」——该推荐在长模式整条忽略（行/档位/chip title 都不展示，当无推荐）；
// classic 仍是合法四档（旧面板/旧 host 的存量值也只会在 classic 展示）。
function recommendationOf(panel, longMode) {
  const operation = panel && panel.recommendedOperation;
  if (!RECOMMEND_OPERATIONS.includes(operation)) return null;
  if (longMode === true && operation === "compress-then-handoff") return null;
  const reason = panel && typeof panel.recommendedReason === "string" ? panel.recommendedReason.trim() : "";
  const at = panel && Number.isFinite(panel.recommendedAt) && panel.recommendedAt > 0 ? panel.recommendedAt : null;
  return { operation, reason, at };
}
// 推荐标签用面板自身的操作 label（与表盘档位/读出行同一套名字）。
const operationLabelOf = (operation) => {
  const option = OPERATION_OPTIONS.find((item) => item.value === operation);
  return option === undefined ? String(operation) : option.label;
};
// ── v0.3.2：默认模式 = 冷峻哥特「石肋星盘」（只留结构：无彩窗/无暖金）──────
// 用户澄清：「哥特风不是让你加彩窗，是哥特的结构和冷峻感」。所以这里不画彩窗/玫瑰窗/暖金，
// 只保留哥特建筑的结构骨架，全部冷色线稿（冷灰/青灰/炭黑/冷白）：
//   平面 = 哥特「多边形章节堂/后殿」肋骨穹顶的营造图：多边形石墙 → 同心券环 → 放射肋
//   → 中心束柱（八角柱截面）；墙外 = 尖拱山花冠 + 小尖塔 + 四角飞扶壁。
//   结构本身就是装饰：尖拱（山花/窗式券）、垂直束柱、飞扶壁、肋骨、对称放射秩序。
// 档位 = 结构节点（山花冠下的墙墩）：冷光肋线沿放射肋从中心穿到墙墩节点，再连到铭牌；
// 选中时这一跨的冷光点亮、光沿肋线流动，其余保持冷灰线稿。
// 指针 = 星盘照准仪（alidade）：细冷钢针 + 菱形垂尖 + 四叶配重，不是剑/十字。
// 赛博感只落在结构上：冷光勾边、扫描线、全息色差（双色 drop-shadow）、沿肋流动的短光。
const DIAL_ORDER = [null, "continue", "compress", "compress-then-handoff", "handoff", "auto"];
const DIAL_ORDER_LONG = [null, "continue", "compress", "handoff"];
// 盘面档位用短标签（长名如「自动（模型决定）」会把圆盘挤到面板边缘）；完整名字保留在读出行与 title。
const dialSeatLabel = (option) => (option.value === "auto" ? "自动" : option.label);
// 盘面固定 300×264 画布：classic 6 档铭牌半径 116；long 4 档收窄到 110，宽铭牌不出画布。
const DIAL_SIZE = { width: 300, height: 264 };
const DIAL_CENTER = { x: 150, y: 132 };
const DIAL_DEAD_RADIUS = 18;
// 冷色结构半径（px）：多边形墙/券环/节点/山花冠/飞扶壁都落在这些半径上，改比例只改这一处。
const DIAL_RADII = {
  hub: 16, ring1: 36, ring2: 62, wallIn: 90, wallOut: 96, node: 93,
  gable: 96, gableTip: 104, finial: 108, tie: 110,
};
// 角度收发：指针显示角允许累积到 ±360 之外（视觉等价角）；换挡只取 |Δ|≤180° 的最短弧。
const dialSigned = (deg) => {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
};
const dialUnwrap = (from, deg) => {
  if (!Number.isFinite(from)) return dialSigned(deg);
  let delta = (((deg - from) % 360) + 360) % 360;
  if (delta > 180) delta -= 360;
  return from + delta;
};
const dialAngleOf = (index, count) => (index * (360 / count)) % 360;
const dialRound = (value) => Math.round(value * 10) / 10;
// 极坐标 → 画布坐标（0° = 正上方，顺时针）：结构/档位/节点全部由它生成。
const dialPolar = (angle, radius) => {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: DIAL_CENTER.x + radius * Math.cos(rad), y: DIAL_CENTER.y + radius * Math.sin(rad) };
};
const dialXY = (point) => dialRound(point.x) + " " + dialRound(point.y);
const dialLine = (angle, inner, outer) => "M" + dialXY(dialPolar(angle, inner)) + " L" + dialXY(dialPolar(angle, outer));
const dialLine2 = (a1, r1, a2, r2) => "M" + dialXY(dialPolar(a1, r1)) + " L" + dialXY(dialPolar(a2, r2));
// 多边形（2n 边：classic 12 边 / relay-long 8 边）——章节堂平面墙线；同角度不同半径 = 同心券环。
const dialPolygon = (count, radius) => {
  const vertices = [];
  const n = count * 2;
  for (let index = 0; index < n; index += 1) vertices.push(dialPolar((index * 360) / n, radius));
  return "M" + vertices.map(dialXY).join(" L") + " Z";
};
// 局部平面坐标：u = 径向朝外，v = 顺时针切向；用来画尖拱山花这类「局部直角坐标」的形状。
const dialFrame = (angle) => {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { u: { x: Math.cos(rad), y: Math.sin(rad) }, v: { x: -Math.sin(rad), y: Math.cos(rad) } };
};
const dialAt = (angle, radius, along) => {
  const frame = dialFrame(angle);
  return {
    x: DIAL_CENTER.x + frame.u.x * radius + frame.v.x * along,
    y: DIAL_CENTER.y + frame.u.y * radius + frame.v.y * along,
  };
};
const dialPinnaclePath = (angle, halfWidth, base, shoulder, tip) => {
  return "M" + dialXY(dialAt(angle, base, -halfWidth)) + " L" + dialXY(dialAt(angle, shoulder, -halfWidth * 0.5))
    + " L" + dialXY(dialAt(angle, tip, 0)) + " L" + dialXY(dialAt(angle, shoulder, halfWidth * 0.5))
    + " L" + dialXY(dialAt(angle, base, halfWidth)) + " Z";
};
// 表盘几何（按档数生成）：classic 6 档 12 边、relay-long 4 档 8 边，结构骨架完全一致。
const buildDialLayout = (order, labelRadius) => {
  const options = order.map((value) => OPERATION_OPTIONS.find((option) => option.value === value));
  const count = options.length;
  const span = 360 / count; // 每档张角（classic 60° / long 90°）
  const step = span / 2;    // 多边形每边张角的一半 = 相邻顶点角距（classic 30° / long 45°）
  const angleOf = (index) => (index * span) % 360;
  const seats = options.map((option, index) => {
    const angle = angleOf(index);
    const label = dialPolar(angle, labelRadius);
    const node = dialPolar(angle, DIAL_RADII.node);
    return {
      option, index,
      left: dialRound(label.x) + "px", top: dialRound(label.y) + "px",
      // 节点 = 墙墩上的菱形石雕凸饰（选中 = 冷白发光）
      pip: "M" + dialRound(node.x) + " " + dialRound(node.y - 4.6)
        + " L" + dialRound(node.x + 2.6) + " " + dialRound(node.y)
        + " L" + dialRound(node.x) + " " + dialRound(node.y + 4.6)
        + " L" + dialRound(node.x - 2.6) + " " + dialRound(node.y) + " Z",
      ray: dialLine(angle, DIAL_RADII.hub, DIAL_RADII.node),
      tie: dialLine(angle, DIAL_RADII.node + 1, DIAL_RADII.tie),
    };
  });
  // 一跨 = 档位区间（两侧各一顶点 + 中间顶点）的扇形填色板：hover/选中冷光提亮这一跨（挡在结构线下面）。
  const sectors = options.map((option, index) => {
    const a1 = angleOf(index) - step;
    const a2 = angleOf(index) + step;
    const points = [
      dialPolar(a1, DIAL_RADII.wallIn),
      dialPolar(angleOf(index) - 0, DIAL_RADII.wallIn + 0),
      dialPolar(a2, DIAL_RADII.wallIn),
    ];
    // 用多边形顶点：a1 / 档位角 / a2 正好都是多边形顶点
    return {
      option, index,
      d: "M" + dialXY(dialPolar(a1, DIAL_RADII.hub)) + " L" + dialXY(points[0]) + " L" + dialXY(points[1])
        + " L" + dialXY(points[2]) + " Z",
    };
  });
  // 放射肋：2n 根（每个多边形顶点一根），从束柱外环到内墙线。
  const ribs = [];
  for (let index = 0; index < count * 2; index += 1) {
    const angle = (index * span) / 2;
    const main = index % 2 === 0;
    ribs.push({ key: index, main, d: dialLine(angle, DIAL_RADII.hub, DIAL_RADII.wallIn) });
  }
  // 券环：hub 八角 → 两道同心多边形券环 → 内墙/外墙（双线 = 石墙厚度）。
  const rings = [
    { key: "ring1", d: dialPolygon(count, DIAL_RADII.ring1) },
    { key: "ring2", d: dialPolygon(count, DIAL_RADII.ring2) },
    { key: "wall-in", d: dialPolygon(count, DIAL_RADII.wallIn) },
    { key: "wall-out", d: dialPolygon(count, DIAL_RADII.wallOut) },
  ];
  // 穹顶网格（lierne）：顶点券环 → 相邻边中点的斜线，把 2n 根肋连成肋骨穹顶的网。
  const liernes = [];
  for (let index = 0; index < count * 2; index += 1) {
    const vertex = (index * span) / 2;
    liernes.push({ key: "la-" + index, d: dialLine2(vertex, DIAL_RADII.ring1, vertex + step / 2, DIAL_RADII.ring2) });
    liernes.push({ key: "lb-" + index, d: dialLine2(vertex, DIAL_RADII.ring1, vertex - step / 2, DIAL_RADII.ring2) });
  }
  // 墙身石缝（砌筑排线）：内外墙线之间的短刻线（每 7.5° 一根）。
  const wallHatch = [];
  for (let index = 0; index < 48; index += 1) wallHatch.push({ key: index, d: dialLine(index * 7.5, DIAL_RADII.wallIn, DIAL_RADII.wallOut) });
  // 尖拱山花冠：每条多边形边上一座小尖拱山花（哥特飞檐/山花），顶点相接、中点起尖。
  const gables = [];
  for (let index = 0; index < count * 2; index += 1) {
    const a1 = (index * span) / 2;
    const a2 = ((index + 1) * span) / 2;
    const mid = (a1 + a2) / 2;
    const p1 = dialPolar(a1, DIAL_RADII.gable);
    const p2 = dialPolar(a2, DIAL_RADII.gable);
    const tip = dialPolar(mid, DIAL_RADII.gableTip);
    const c1 = dialPolar(a1 + step * 0.22, DIAL_RADII.gableTip - 5);
    const c2 = dialPolar(a2 - step * 0.22, DIAL_RADII.gableTip - 5);
    gables.push({ key: index, d: "M" + dialXY(p1) + " Q" + dialXY(c1) + " " + dialXY(tip) + " Q" + dialXY(c2) + " " + dialXY(p2) });
  }
  // 山花尖顶饰：每座山花一个很小的尖塔（顶饰），把「山花冠」的轮廓钉实。
  const finials = [];
  for (let index = 0; index < count * 2; index += 1) {
    const mid = (index * span) / 2 + step / 2;
    finials.push({ key: index, d: dialPinnaclePath(mid, 2.6, DIAL_RADII.gableTip - 6, DIAL_RADII.gableTip - 1, DIAL_RADII.finial) });
  }
  // 飞扶壁：四角（45/135/225/315）各一组 —— 双线墩 + 两道飞券 + 小尖顶。
  const buttresses = [];
  for (const angle of [45, 135, 225, 315]) {
    const pier = "M" + dialXY(dialAt(angle, 100, -2.4)) + " L" + dialXY(dialAt(angle, 122, -2.4))
      + " M" + dialXY(dialAt(angle, 100, 2.4)) + " L" + dialXY(dialAt(angle, 122, 2.4));
    const flyer = "M" + dialXY(dialPolar(angle - 10, DIAL_RADII.wallOut))
      + " Q" + dialXY(dialPolar(angle - 5, 112)) + " " + dialXY(dialPolar(angle, 118))
      + " M" + dialXY(dialPolar(angle + 10, DIAL_RADII.wallOut))
      + " Q" + dialXY(dialPolar(angle + 5, 112)) + " " + dialXY(dialPolar(angle, 118));
    const finial = dialPinnaclePath(angle, 3.2, 118, 121, 126);
    buttresses.push({ key: angle, d: pier + " " + flyer + " " + finial });
  }
  // 束柱平面（中心）：八角柱截面 + 8 道柱身刻线 + 拱心石。
  const hubOctagon = [];
  for (let index = 0; index <= 8; index += 1) {
    const point = dialPolar(index * 45 + 22.5, DIAL_RADII.hub);
    hubOctagon.push((index === 0 ? "M" : " L") + dialXY(point));
  }
  hubOctagon.push(" Z");
  const hubTicks = [];
  for (let index = 0; index < 8; index += 1) hubTicks.push({ key: index, d: dialLine(index * 45 + 22.5, 7, 11) });
  return { order, options, count, span, step, angleOf, seats, sectors, ribs, rings, liernes, wallHatch, gables, finials, buttresses, hub: hubOctagon.join(""), hubTicks };
};
const DIAL_LAYOUTS = {
  classic: buildDialLayout(DIAL_ORDER, 116),
  long: buildDialLayout(DIAL_ORDER_LONG, 110),
};
const dialLayoutOf = (longMode) => (longMode === true ? DIAL_LAYOUTS.long : DIAL_LAYOUTS.classic);
// relay-long 的「接力新会话」= 团队重启语义（旧会话归档、队友与后台任务随之中断）。
const LONG_HANDOFF_HINT = "接力新会话（团队重启）：立即创建新会话并重启团队（旧会话归档、队友与后台任务随之中断）；模式只决定做什么，不免审批";
const LONG_HANDOFF_TITLE = LONG_HANDOFF_HINT + "（免审看 autoHandoff/授权下一次）";
/** 面板状态 → 表盘档位下标：classic 6 档；relay-long 4 档（隐藏档视觉按「继续」显示，不主动写盘）。 */
function dialIndexOf(panel, longMode) {
  const layout = dialLayoutOf(longMode);
  if (longMode === true) {
    // 隐藏档：自动（模型决定）→ 落「继续」（host 会做语义归一，客户端不写盘）。
    // v0.3.4：压缩→新会话已从长模式移除；存量值仍视觉落「继续」（host 按继续归一清空）。
    if (panel && panel.autoChoose === true) return 1;
    const longValue = panel && typeof panel.defaultOperation === "string" ? panel.defaultOperation : null;
    if (longValue === "compress-then-handoff") return 1;
    const longIndex = layout.order.indexOf(longValue);
    return longIndex < 0 ? 0 : longIndex;
  }
  if (panel && panel.autoChoose === true) return 5;
  const value = panel && typeof panel.defaultOperation === "string" ? panel.defaultOperation : null;
  const index = layout.order.indexOf(value);
  return index < 0 ? 0 : index;
}
// v0.2.8：交接后新会话注入 = popover 里的开关（v0.2.20 起为水缸按钮 tankRow）。
// 显式 true/false 优先；null=跟随本会话（展示本会话生效值，首次点击后固定为布尔）。
function handoffBudgetOn(panel) {
  if (panel && panel.handoffUnlimitedBudget === true) return true;
  if (panel && panel.handoffUnlimitedBudget === false) return false;
  return !panel || panel.unlimitedBudget !== false;
}

// chip 状态徽标图案：10x10 内联 SVG（stroke=currentColor，不引依赖）。压=向内压缩双箭头；接=方框向右接力箭头。
const FLAG_ICONS = {
  compress: "M5 1v2.5 M3.5 2.5 5 4 6.5 2.5 M5 9V6.5 M3.5 7.5 5 6 6.5 7.5",
  handoff: "M2 8V2h4 M6.5 5h2.5 M8 3.5 9.5 5 8 6.5",
};
function flagIcon(kind) {
  return h("svg", {
    width: 10, height: 10, viewBox: "0 0 10 10", fill: "none",
    stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
    "aria-hidden": "true", focusable: "false",
  }, h("path", { d: FLAG_ICONS[kind] }));
}

const chip = { display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, #d0d7de))", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12, lineHeight: "18px", whiteSpace: "nowrap" };
const chipOver = { ...chip, border: "1px solid var(--dsw-alias-state-error-primary, #d1242f)", background: "rgba(209,36,47,0.12)", color: "var(--dsw-alias-state-error-primary, #d1242f)" };
// v0.2.21：独角兽「精神感应框架」纹路 = 分叉电路式 SVG 图案（v0.2.20 的两层平行斜线已弃用）。
// 点亮时 chip 平时保持透明底、只透出红色电路纹与微光；只有「已到线」（overBudget）才压暗红底。
// 纹路用 encodeURIComponent 内联 data:image/svg+xml（无网络请求、随 bundle 走），tile 沿 x 重复。
const unicornVeinUrl = (svg) => "url(\"data:image/svg+xml," + encodeURIComponent(svg) + "\")";
const UNICORN_VEIN_TILE = unicornVeinUrl(
  "<svg xmlns='http://www.w3.org/2000/svg' width='132' height='24' viewBox='0 0 132 24'>"
  // 底层：同路径加宽 3px 做霓虹光晕
  + "<g fill='none' stroke='#ff2d4e' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' opacity='.18'>"
  + "<path d='M0 17H16L24 9H44L52 19H72L80 7H100L108 15H124L132 11'/>"
  + "<path d='M24 9 30 3M52 19 58 23M80 7 86 1M108 15 114 21'/>"
  + "</g>"
  // 主线：阶梯状折线 + 短分叉（精神感应框架的棱状电路）
  + "<g fill='none' stroke='#ff3b57' stroke-width='1.1' stroke-linecap='round' stroke-linejoin='round' opacity='.95'>"
  + "<path d='M0 17H16L24 9H44L52 19H72L80 7H100L108 15H124L132 11'/>"
  + "<path d='M24 9 30 3M52 19 58 23M80 7 86 1M108 15 114 21'/>"
  + "<path d='M16 17 20 21M44 9 40 4M72 19 68 23M100 7 96 2M124 15 128 20'/>"
  + "</g>"
  // 节点：菱形焊点
  + "<g fill='#ff6b82' opacity='.95'>"
  + "<rect x='22' y='7' width='4' height='4' transform='rotate(45 24 9)'/>"
  + "<rect x='50' y='17' width='4' height='4' transform='rotate(45 52 19)'/>"
  + "<rect x='78' y='5' width='4' height='4' transform='rotate(45 80 7)'/>"
  + "<rect x='106' y='13' width='4' height='4' transform='rotate(45 108 15)'/>"
  + "<rect x='128' y='9' width='3.4' height='3.4' transform='rotate(45 129.7 10.7)'/>"
  + "</g></svg>");
const UNICORN_VEIN_FINE = unicornVeinUrl(
  "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='20' viewBox='0 0 96 20'>"
  + "<g fill='none' stroke='#ff7c92' stroke-width='.8' opacity='.5'>"
  + "<path d='M0 6H20L30 16H54L64 5H82L90 12H96'/>"
  + "<path d='M30 16 38 9M64 5 58 12'/>"
  + "</g>"
  + "<g fill='#ff9aac' opacity='.85'>"
  + "<rect x='28.5' y='14.5' width='3' height='3' transform='rotate(45 30 16)'/>"
  + "<rect x='62.5' y='3.5' width='3' height='3' transform='rotate(45 64 5)'/>"
  + "</g></svg>");
const UNICORN_VEINS = UNICORN_VEIN_TILE + " 0 0/120px 24px repeat-x,"
  + UNICORN_VEIN_FINE + " 30px 6px/84px 20px repeat-x";
// v0.2.30：水面动态波层 = 重复波形带（半透明白色水体带 + 白色浪脊线），贴着水面横向缓慢流动。
const TANK_SURF_TILE = unicornVeinUrl(
  "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='10' viewBox='0 0 64 10' preserveAspectRatio='none'>"
  + "<path d='M0 6 Q8 1 16 6 T32 6 T48 6 T64 6 L64 10 L0 10 Z' fill='#ffffff' opacity='.26'/>"
  + "<path d='M0 6 Q8 1 16 6 T32 6 T48 6 T64 6' fill='none' stroke='#ffffff' stroke-width='1.1' stroke-linecap='round' opacity='.9'/>"
  + "</svg>");
// ── TANK-WATER-BEGIN（自包含水缸引擎：证据渲染工程按此标记整段抽取复核）────────
// v0.2.30：本引擎原样保留，唯一挂载点改为 popover 底部「授权下一次操作」按钮（tone=green，on=authorizeNext）；
// 三个水缸行不再使用 canvas（改纯 CSS 多元素 300ms 注水，见 tankRow）。
const TANK_WATER = (function () {
  const TAU = Math.PI * 2;
  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
  const rgba = (rgb, alpha) => "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + alpha + ")";
  // light=水面反光亮色，mid=水体本色，deep=缸底深水色，line=水面高光（与既有三色 tone 对应）
  const TONES = {
    blue: { light: [156, 216, 255], mid: [47, 129, 247], deep: [6, 30, 82], line: [240, 248, 255] },
    green: { light: [158, 245, 196], mid: [45, 164, 78], deep: [4, 38, 19], line: [240, 255, 246] },
    sakura: { light: [255, 200, 214], mid: [255, 84, 112], deep: [74, 5, 22], line: [255, 242, 246] },
  };
  function create(canvas, tone, on, dpr) {
    const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (ctx === null) return null;
    const view = {
      canvas, ctx, dpr: dpr > 0 ? dpr : 1,
      tone: TONES[tone] || TONES.blue,
      on: on === true,
      level: on === true ? 1 : 0,
      speed: 0,
      phase: [0, 1.7, 4.2],
      surge: 0,
      slosh: 0, sloshSpeed: 0,
      t: 0, sinceToggle: Infinity,
      W: 0, H: 0, nextResize: -1,
    };
    resize(view);
    return view;
  }
  function resize(view) {
    const canvas = view.canvas;
    const W = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
    const H = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
    const pw = Math.max(1, Math.round(W * view.dpr));
    const ph = Math.max(1, Math.round(H * view.dpr));
    view.W = W; view.H = H;
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
  }
  // 点开关：液面速度冲量 + 晃荡冲量 + 浪涌包络拉满（= 水猛灌/猛抽的瞬间）
  function setOn(view, on) {
    const next = on === true;
    if (next === view.on) return;
    view.on = next;
    view.surge = 1;
    view.sinceToggle = 0;
    view.sloshSpeed += next ? -15 : 13;
    view.speed += next ? 0.5 : -0.35;
  }
  // reduced-motion：直接终态（无过冲、无浪涌），由调用方画一帧。
  function snap(view, on) {
    view.on = on === true;
    view.level = view.on ? 1 : 0;
    view.speed = 0; view.slosh = 0; view.sloshSpeed = 0; view.surge = 0;
    view.sinceToggle = Infinity;
    view.phase = [0, 1.7, 4.2];
  }
  // 关闭且水已排空 → 外部可以停掉 rAF。
  function isSettled(view) { return view.on !== true && view.level < 0.004 && Math.abs(view.speed) < 0.03; }
  function step(view, dtMs) {
    const dt = clamp(dtMs / 1000, 0, 0.05);
    const target = view.on === true ? 1 : 0;
    view.t += dt;
    view.sinceToggle += dt;
    // 液面：欠阻尼弹簧（≈0.3s 涌满；过冲到 1.1 附近 = 水面鼓过缸沿，再晃回落定）
    view.speed += ((target - view.level) * 45 - view.speed * 6.9) * dt;
    view.level = clamp(view.level + view.speed * dt, -0.02, 1.1);
    // 横向晃荡：阻尼震荡（水在缸里向左/右涌）
    view.sloshSpeed += (-58 * view.slosh - 6.2 * view.sloshSpeed) * dt;
    view.slosh = clamp(view.slosh + view.sloshSpeed * dt, -3.2, 3.2);
    // 浪涌包络：刚灌入时浪幅/白沫最大，约 0.9s 衰减到常驻微澜
    view.surge *= Math.exp(-dt / 0.55);
    // 三层波相位（不同波长/速度/方向 → 水面不重复）
    view.phase[0] += 2.5 * dt;
    view.phase[1] += 3.5 * dt;
    view.phase[2] += 1.6 * dt;
  }
  function paint(view, tMs) {
    const ctx = view.ctx, W = view.W, H = view.H;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (view.level <= 0.004) return;
    const tone = view.tone;
    const t = view.t;
    const air = clamp(H * 0.15, 3.5, 5.5);
    const baseline = H - view.level * (H - air);
    const fade = clamp(view.level * 4, 0, 1);
    const surge = view.surge;
    // 常驻微澜会缓慢「呼吸」（浪幅起伏），水面不呆板
    const breathe = 1 + 0.35 * Math.sin(t * 0.78);
    const amp1 = (1.05 * breathe + 2.1 * surge) * fade;
    const amp2 = (0.5 + 1.35 * surge) * fade;
    const amp3 = (0.28 + 0.55 * surge) * fade;
    const amp4 = (0.25 + 0.5 * Math.pow(Math.sin(t * 0.42), 2) + 0.8 * surge) * fade;
    const slosh = view.slosh * fade;
    const k1 = TAU / 118, k2 = TAU / 46, k3 = TAU / 191, k4 = TAU / 265;
    // 涌浪：切换瞬间自右向左横穿水面的一道大浪，约 0.9s 衰减
    const since = view.sinceToggle;
    const packetOn = since < 1.35;
    const packetX = packetOn ? W * (1 - Math.min(1, since / 1.15)) : 0;
    const packetA = packetOn ? 3.2 * Math.exp(-since / 0.6) * fade : 0;
    const packetS = Math.max(26, W * 0.13);
    const surf = (x) => {
      let y = baseline
        + amp1 * Math.sin(x * k1 + view.phase[0] + view.phase[2] * 0.3)
        + amp2 * Math.sin(x * k2 - view.phase[1])
        + amp3 * Math.sin(x * k3 + view.phase[2])
        + amp4 * Math.sin(x * k4 + t * 0.62)
        + slosh * ((x / W) * 2 - 1);
      if (packetOn) {
        const dx = (x - packetX) / packetS;
        y -= packetA * Math.exp(-dx * dx);
      }
      // 缸壁毛细：水面在两侧玻璃处微微翘起
      const edge = Math.abs((x / W) * 2 - 1);
      y -= 1.1 * fade * Math.pow(edge, 10);
      return y;
    };
    const stepX = Math.max(1.2, W / 280);
    const bodyPath = () => {
      ctx.beginPath();
      ctx.moveTo(0, surf(0));
      for (let x = stepX; x < W; x += stepX) ctx.lineTo(x, surf(x));
      ctx.lineTo(W, surf(W));
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    };
    // 1) 水体：半透明染色（深色底透出来 = 玻璃缸里的水，而不是塑料色块）
    bodyPath();
    const body = ctx.createLinearGradient(0, baseline, 0, H);
    body.addColorStop(0, rgba(tone.mid, 0.56));
    body.addColorStop(0.16, rgba(tone.mid, 0.42));
    body.addColorStop(0.6, rgba(tone.mid, 0.32));
    body.addColorStop(0.9, rgba(tone.deep, 0.45));
    body.addColorStop(1, rgba(tone.deep, 0.54));
    ctx.fillStyle = body;
    ctx.fill();
    // 2) 水面下的折射亮带 + 两道缓慢移动的光纹（光在水里走，水才不像塑料）
    ctx.save();
    bodyPath();
    ctx.clip();
    const band = ctx.createLinearGradient(0, baseline - 1, 0, baseline + 5.5);
    band.addColorStop(0, rgba(tone.light, 0.27));
    band.addColorStop(1, rgba(tone.light, 0));
    ctx.fillStyle = band;
    ctx.fillRect(0, baseline - 6, W, 16);
    ctx.lineWidth = 1;
    for (const line of [[5.5, 0.9, 0.041, 1.1, 0.1], [10.5, 0.7, 0.067, -0.8, 0.06]]) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += stepX) {
        const y = baseline + line[0] + line[1] * Math.sin(x * line[2] + t * line[3] + line[0]);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(tone.light, line[4]);
      ctx.stroke();
    }
    ctx.restore();
    // 3) 水面亮线：沿浪形描边 + 三色光晕（水面高光；浪涌时更亮更粗 = 水花）
    ctx.beginPath();
    ctx.moveTo(0, surf(0));
    for (let x = stepX; x <= W; x += stepX) ctx.lineTo(x, surf(x));
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.shadowColor = rgba(tone.mid, 0.95);
    ctx.shadowBlur = 2.5 + 5 * surge;
    ctx.strokeStyle = rgba(tone.line, 0.64 + 0.3 * surge);
    ctx.lineWidth = 0.85 + 0.55 * surge;
    ctx.stroke();
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    // 3.5) 水面之上的淡淡反光（水把光反到空气里，水面「亮起来」）
    const lift = ctx.createLinearGradient(0, baseline - 3.2, 0, baseline + 1);
    lift.addColorStop(0, rgba(tone.light, 0));
    lift.addColorStop(1, rgba(tone.light, 0.16));
    ctx.fillStyle = lift;
    ctx.fillRect(0, baseline - 3.2, W, 4.2);
    // 4) 浪尖白沫：浪峰处更白的一层水花（灌水瞬间明显、落定后只留极淡的一线）
    const foam = clamp(0.10 + 1.5 * surge, 0, 1);
    ctx.beginPath();
    for (let x = 0; x <= W; x += stepX) {
      const y = surf(x) + 1.3;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(tone.line, 0.34 * foam);
    ctx.lineWidth = 1 + 1.5 * surge;
    ctx.stroke();
  }
  return { create, setOn, snap, isSettled, resize, frame: (view, tMs, dtMs) => {
    if (view.nextResize < 0 || tMs - view.nextResize > 400) { view.nextResize = tMs; resize(view); }
    if (dtMs > 0) step(view, dtMs);
    paint(view, tMs);
  } };
})();

// 接线：WeakMap 记录每个 canvas 的视图；开启时 rAF 循环（关闭且水排空即停；canvas 卸载后循环自行退出）。
const tankViews = new WeakMap();
function tankReduceMotion() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch { return false; }
}
function tankWaterRun(canvas, view) {
  if (view.raf !== 0) return;
  const raf = typeof window !== "undefined" ? window.requestAnimationFrame : null;
  if (typeof raf !== "function") return;
  const loop = (now) => {
    view.raf = 0;
    // 面板关闭 = canvas 脱离文档：循环在这里自行停止（无需外部清理，也不跨实例泄漏）
    if (canvas.isConnected === false) return;
    const dt = view.last === 0 ? 16.7 : Math.min(now - view.last, 64);
    view.last = now;
    TANK_WATER.frame(view, now, dt);
    if (TANK_WATER.isSettled(view)) return; // 关闭且水已排空：没有要画的了
    view.raf = raf(loop);
  };
  view.last = 0;
  view.raf = raf(loop);
}
function tankWaterSync(canvas, tone, on) {
  if (canvas === null || canvas === undefined || typeof canvas.getContext !== "function") return;
  let view = tankViews.get(canvas);
  if (view === undefined) {
    view = TANK_WATER.create(canvas, tone, on, window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
    if (view === null) return;
    view.raf = 0; view.last = 0;
    tankViews.set(canvas, view);
  }
  if (tankReduceMotion()) { TANK_WATER.snap(view, on); TANK_WATER.frame(view, 0, 0); return; }
  TANK_WATER.setOn(view, on);
  TANK_WATER.frame(view, 0, 0);
  tankWaterRun(canvas, view);
}
// canvas ref：React 每次渲染都用 (null → node) 重挂同一个回调 → 用闭包记住节点，
// 下一帧若已脱离文档（真卸载）才释放视图；仍在文档里则只同步 on 状态（不会重放注水动画）。
function tankWaterRef(tone, on) {
  let node = null;
  return (next) => {
    if (next !== null && next !== undefined) { node = next; tankWaterSync(next, tone, on); return; }
    const stale = node;
    node = null;
    if (stale === null || typeof window === "undefined") return;
    const raf = window.requestAnimationFrame;
    if (typeof raf !== "function") return;
    raf(() => {
      if (stale.isConnected !== false) return;
      const view = tankViews.get(stale);
      if (view === undefined) return;
      if (view.raf !== 0 && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(view.raf);
      tankViews.delete(stale);
    });
  };
}
// ── TANK-WATER-END ────────────────────────────────────────────────────────
// 点亮但未到线：透明底 + 电路纹，不发光（文字沿用主题色，深/浅主题都可读）。
// v0.2.30 用户反馈：「chip 的背景发光怎么什么时候都发光，不是说到阈值才发光吗」→ 红光/呼吸/火星全部收进
// unicornChipOverStyle + .relay-v3-chip-unicorn-glow，只有 overBudget（已到线）才出现；平时只剩纹路。
const unicornChipStyle = {
  border: "1px solid rgba(255,64,96,.85)",
  background: UNICORN_VEINS,
};
// 已到线才压深红底（用户反馈：平时背景太深，过线才用这个背景色）。
const unicornChipOverStyle = {
  ...unicornChipStyle,
  border: "1px solid rgba(255,64,96,.95)",
  color: "#ffe3e9",
  textShadow: "0 0 6px rgba(255,45,78,.55)",
  background: UNICORN_VEINS
    + ",radial-gradient(circle at 28% 50%, rgba(255,45,78,.42), rgba(120,0,22,.30) 55%, rgba(20,0,8,.92)),"
    + "linear-gradient(rgba(20,0,8,.90), rgba(20,0,8,.90))",
};
// 相对 chip 包裹层绝对定位（包裹层 position:relative）：bottom:100% 即 chip 正上方，
// 不依赖 window 测量（fixed 在本应用的祖先层里会被固定定位的 containing block 搞偏/裁掉）。
const POPOVER_WIDTH = 340;
// 动效全部走 CSS（单 <style>，判重键不变）：常驻动画 = chip「自动」流光、双授权呼吸灯、「授权下一次操作」按钮 canvas 水面（rAF 驱动）、
// 接力 chip 独角兽红光呼吸/火星（v0.2.30 起仅在「已到线」态）；
// chip hover/press ≤140ms、操作标签切换 180ms 淡入、dot 160ms 过渡；reduced-motion 全关。
const PANEL_CSS = [
  "@keyframes relay-panel-in{from{opacity:0;filter:blur(2px);transform:translateY(8px) scale(.98)}to{opacity:1;filter:blur(0);transform:translateY(0) scale(1)}}",
  "@keyframes relay-panel-out{to{opacity:0;filter:blur(1px);transform:translateY(4px) scale(.99)}}",
  "@keyframes relay-v3-shimmer{from{background-position:200% 50%}to{background-position:0% 50%}}",
  "@keyframes relay-v3-next-in{from{opacity:0;transform:translateY(1px)}to{opacity:1;transform:translateY(0)}}",
  // 两个自动授权都开 = 执行全免审：chip 光点变绿 + 轻呼吸灯（仅这 1 处新增常驻动画，与「自动」流光互补）。
  "@keyframes relay-v3-breathe{0%,100%{background-color:#2da44e;box-shadow:0 0 0 2px rgba(45,164,78,.26),0 0 4px rgba(45,164,78,.35)}50%{background-color:#5ee88a;box-shadow:0 0 0 6px rgba(45,164,78,.10),0 0 9px rgba(94,232,138,.55)}}",
  // 光点状态切换时 pop 一下（黄↔绿/呼吸），只在新状态挂载时触发。
  "@keyframes relay-v3-dot-pop{0%{transform:scale(.55)}60%{transform:scale(1.35)}100%{transform:scale(1)}}",
  // 首次到线：chip 红边做一次性脉冲（700ms，仅状态切换时播放）。
  "@keyframes relay-v3-chip-pulse{0%{box-shadow:0 0 0 0 rgba(209,36,47,.45)}70%{box-shadow:0 0 0 6px rgba(209,36,47,0)}100%{box-shadow:0 0 0 0 rgba(209,36,47,0)}}",
  // 百分比整数变化时数字淡入（按整数 key 重挂载，避免 4s 轮询每跳都闪）。
  "@keyframes relay-v3-pct-in{from{opacity:.35;transform:translateY(1px)}to{opacity:1;transform:translateY(0)}}",
  // v0.2.30：「授权下一次操作」按钮 = canvas 实时水面引擎（v0.2.29 TANK_WATER）的唯一挂载点：未授权空 / 授权注满绿 / 取消排空。
  // 按钮自身 300ms 颜色 crossfade（黄→绿）与 canvas 注水同时开始同时结束；canvas 铺满按钮、z-index 低于文字。
  ".relay-v3-auth{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:7px 10px;border-radius:8px;border:1px solid rgba(212,160,23,.65);background:rgba(212,160,23,.12);color:inherit;cursor:pointer;font:inherit;font-size:12px;font-weight:600;text-align:left;transition:background-color .3s ease,border-color .3s ease,box-shadow .3s ease,transform 120ms ease}",
  ".relay-v3-auth:hover{background:rgba(212,160,23,.2);box-shadow:0 0 0 3px rgba(212,160,23,.16)}",
  ".relay-v3-auth:active{transform:scale(.99)}",
  ".relay-v3-auth-on{border-color:rgba(45,164,78,.65);background:rgba(45,164,78,.14)}",
  ".relay-v3-auth-on:hover{background:rgba(45,164,78,.2);box-shadow:0 0 0 3px rgba(45,164,78,.16)}",
  ".relay-v3-auth-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:0;pointer-events:none}",
  ".relay-v3-auth-text{position:relative;z-index:1}",
  ".relay-v3-popover{animation:relay-panel-in 150ms cubic-bezier(.2,.8,.2,1);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%)}",
  // 不支持 backdrop-filter 的渲染器退回不透明主题底色（!important 压过 inline 的半透明底）。
  // 不支持 backdrop-filter（部分软件渲染/WebView）时：用「半透明 + 玻璃光泽」假装毛玻璃，而不是退回完全不透明。
  "@supports not (backdrop-filter: blur(1px)){.relay-v3-popover{background-color:rgba(127,127,127,.42)!important;background-image:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.03) 45%,rgba(255,255,255,.09))!important}}",
  ".relay-v3-popover-closing{animation:relay-panel-out 120ms ease-in forwards}",
  // 毛玻璃：支持 backdrop-filter 的浏览器用半透明底 + 内高光；不支持则退回 inline 的不透明背景。
  "@supports (background: color-mix(in srgb,red 50%,transparent)){.relay-v3-popover{background-color:color-mix(in srgb,var(--dsw-alias-bg-base,var(--dsh-surface,#fff)) 45%,transparent)!important}}",
  ".relay-v3-chip{transition:transform 140ms ease,box-shadow 140ms ease}",
  ".relay-v3-chip:hover{transform:translateY(-1px);box-shadow:0 1px 4px rgba(0,0,0,.14)}",
  ".relay-v3-chip:active{transform:translateY(0) scale(.97)}",
  ".relay-v3-next{display:inline-block;flex:0 1 auto;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;animation:relay-v3-next-in 180ms ease}",
  ".relay-v3-auto{color:inherit;background:linear-gradient(90deg,currentColor 0%,currentColor 30%,transparent 45%,currentColor 60%,currentColor 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:relay-v3-shimmer 1.6s linear infinite}",
  ".relay-v3-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:0 0 auto;transition:background-color 160ms ease,box-shadow 160ms ease}",
  ".relay-v3-dot-off{background-color:#d4a017;box-shadow:0 0 0 2px rgba(212,160,23,.30),0 0 7px 1px rgba(212,160,23,.55)}",
  ".relay-v3-dot-on{background-color:#2da44e;box-shadow:0 0 0 2px rgba(45,164,78,.32),0 0 8px 1px rgba(45,164,78,.60)}",
  ".relay-v3-dot-breathe{background-color:#2da44e;animation:relay-v3-breathe 2s ease-in-out infinite}",
  ".relay-v3-dot-pop{animation:relay-v3-dot-pop 200ms cubic-bezier(.2,.8,.2,1)}",
  ".relay-v3-dot-breathe.relay-v3-dot-pop{animation:relay-v3-dot-pop 200ms cubic-bezier(.2,.8,.2,1),relay-v3-breathe 2s ease-in-out infinite}",
  ".relay-v3-chip.over-pulse{animation:relay-v3-chip-pulse 700ms ease-out 1}",
  ".relay-v3-pct{display:inline-block;animation:relay-v3-pct-in 160ms ease}",
  // 按压 ripple：纯 ::after 光圈，按下时 60ms 放大、松开 200ms 淡出。
  ".relay-v3-ripple{position:relative;overflow:hidden}",
  ".relay-v3-ripple::after{content:\"\";position:absolute;inset:0;border-radius:inherit;background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.32),transparent 62%);opacity:0;transform:scale(.6);transition:opacity 200ms ease,transform 200ms ease;pointer-events:none}",
  ".relay-v3-ripple:active::after{opacity:1;transform:scale(1);transition-duration:60ms}",
  // chip 状态徽标：压=autoCompress（亮蓝）/ 接=autoHandoff（亮绿），内部为 10x10 内联 SVG 图案。
  ".relay-v3-badge{display:inline-flex;align-items:center;justify-content:center;height:14px;min-width:14px;padding:0 2px;border-radius:4px;border:1px solid;transition:background-color 160ms ease,border-color 160ms ease,color 160ms ease}",
  ".relay-v3-badge-off{border-color:rgba(139,148,158,.45);background:transparent;color:#8b949e}",
  ".relay-v3-badge-compress-on{border-color:rgba(47,129,247,.95);background:rgba(47,129,247,.22);color:#6cb0ff;box-shadow:0 0 9px 1px rgba(47,129,247,.65),inset 0 0 4px rgba(47,129,247,.35)}",
  ".relay-v3-badge-handoff-on{border-color:rgba(45,164,78,.95);background:rgba(45,164,78,.22);color:#6ee7a0;box-shadow:0 0 9px 1px rgba(45,164,78,.65),inset 0 0 4px rgba(45,164,78,.35)}",
  // v0.2.30：水缸行 = 液态填充（纯 CSS transition；无 canvas/rAF/keyframes）：水位 450ms 惯性升起 + 水面波层 900ms 慢流/收小，水满整行；无横穿块/水舌。
  // 蓝/绿行：液体主体升起（SVG mask 波浪边缘 = 水面）/ 水面波层慢流 / 5 颗液滴飞出 / 高光浪线随水上升；
  // 新会话预算行：chip 同款独角兽电路纹（clip-path 从左到右擦出 + 淡入）+ 3 颗火星。
  // delay 0 同时开始；水位 450ms、波层 900ms、其余 300ms；关闭 = 同一组过渡反向；reduced-motion 直接终态。
  ".relay-v3-tank{position:relative;display:flex;align-items:center;padding:6px 10px;border-radius:9px;border:1px solid rgba(139,148,158,.26);background:rgba(13,17,23,.55);color:#c9d2dc;cursor:pointer;font:inherit;font-size:12px;font-weight:600;letter-spacing:.2px;text-align:left;overflow:hidden;transition:border-color .3s ease,color .3s ease,background-color .3s ease,box-shadow .3s ease}",
  ".relay-v3-tank:hover{border-color:var(--tank-line,rgba(139,148,158,.45))}",
  ".relay-v3-tank:active{transform:scale(.995)}",
  ".relay-v3-tank::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:2;box-shadow:inset 0 1px 0 rgba(255,255,255,.13),inset 0 -1px 0 rgba(0,0,0,.3),inset 0 0 0 .5px rgba(255,255,255,.04);background:linear-gradient(180deg,rgba(255,255,255,.085),rgba(255,255,255,0) 26%,rgba(0,0,0,0) 72%,rgba(0,0,0,.14))}",
  ".relay-v3-tank-label{position:relative;z-index:3;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.6);transition:color .3s ease}",
  ".relay-v3-tank-art{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden;border-radius:inherit}",
  ".relay-v3-tank-liquid{position:absolute;left:0;right:0;bottom:0;height:100%;transform:translateY(102%);transition:transform .45s cubic-bezier(.25,1.12,.4,1)}",
  ".relay-v3-tank-body{position:absolute;inset:0;background:linear-gradient(180deg,rgba(var(--tank-water),.58),rgba(var(--tank-water),.42) 26%,rgba(var(--tank-water),.30) 62%,rgba(var(--tank-water-deep),.56));-webkit-mask-image:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20320%2020'%20preserveAspectRatio%3D'none'%3E%3Cpath%20d%3D'M0%205%20Q40%200%2080%205%20T160%205%20T240%205%20T320%205%20L320%2020%20L0%2020%20Z'%20fill%3D'%23fff'%2F%3E%3C%2Fsvg%3E\");mask-image:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20320%2020'%20preserveAspectRatio%3D'none'%3E%3Cpath%20d%3D'M0%205%20Q40%200%2080%205%20T160%205%20T240%205%20T320%205%20L320%2020%20L0%2020%20Z'%20fill%3D'%23fff'%2F%3E%3C%2Fsvg%3E\");-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}",
  ".relay-v3-tank-crest{position:absolute;inset:0;background-image:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%20320%2020'%20preserveAspectRatio%3D'none'%3E%3Cpath%20d%3D'M0%205%20Q40%200%2080%205%20T160%205%20T240%205%20T320%205'%20fill%3D'none'%20stroke%3D'%23fff'%20stroke-width%3D'1.8'%20stroke-linecap%3D'round'%2F%3E%3C%2Fsvg%3E\");background-size:100% 100%;background-repeat:no-repeat;opacity:.86;pointer-events:none}",
  // v0.2.30：动态水面波层——贴在水面上的重复波形（浪是水面本身，不是横穿物体）；900ms 慢移 + 随水位升高浪幅收小。
  ".relay-v3-tank-wave{position:absolute;left:-40%;right:-40%;top:0;height:9px;background:" + TANK_SURF_TILE + " 0 0/96px 9px repeat-x;opacity:.92;transform:translateY(2px) scaleY(1.1);transition:background-position .9s ease-out,transform .45s ease,opacity .45s ease}",
  ".relay-v3-tank-drop{position:absolute;top:0;width:3.5px;height:3.5px;border-radius:50%;background:#fff;box-shadow:0 0 4px 1px rgba(var(--tank-water-light),.85);transition:transform .3s ease}",
  ".relay-v3-tank-drop-1{left:17%;width:4px;height:4px}",
  ".relay-v3-tank-drop-2{left:33%;width:3px;height:3px}",
  ".relay-v3-tank-drop-3{left:49%;width:4px;height:4px}",
  ".relay-v3-tank-drop-4{left:66%;width:2.5px;height:2.5px}",
  ".relay-v3-tank-drop-5{left:82%;width:3px;height:3px}",
  // v0.2.30：新会话预算行 = chip 同款独角兽电路纹（出现时从左到右擦出）+ 3 颗升起的火星
  ".relay-v3-tank-veins{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:0;clip-path:inset(0 100% 0 0);transition:opacity .5s ease,clip-path .6s cubic-bezier(.3,.8,.3,1)}",
  ".relay-v3-tank-on .relay-v3-tank-veins{opacity:1;clip-path:inset(0 0 0 0)}",
  ".relay-v3-tank-sparks{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden;border-radius:inherit}",
  ".relay-v3-tank-spark{position:absolute;bottom:0;width:3px;height:3px;border-radius:50%;background:#ff6076;box-shadow:0 0 6px 2px rgba(255,45,78,.95);opacity:0}",
  ".relay-v3-tank-spark-1{left:18%}",
  ".relay-v3-tank-spark-2{left:52%}",
  ".relay-v3-tank-spark-3{left:81%}",
  ".relay-v3-tank-on .relay-v3-tank-spark{animation:relay-v3-unicorn-spark 1.7s ease-in-out infinite;opacity:1}",
  ".relay-v3-tank-on .relay-v3-tank-spark-1{animation-delay:0s}",
  ".relay-v3-tank-on .relay-v3-tank-spark-2{animation-delay:.55s}",
  ".relay-v3-tank-on .relay-v3-tank-spark-3{animation-delay:1.05s}",
  ".relay-v3-tank-on .relay-v3-tank-liquid{transform:translateY(-26%)}",
  ".relay-v3-tank-on .relay-v3-tank-wave{background-position:-192px 0;transform:translateY(0) scaleY(.55);opacity:.7}",
  ".relay-v3-tank-on .relay-v3-tank-drop-1{transform:translate(-26px,-18px)}",
  ".relay-v3-tank-on .relay-v3-tank-drop-2{transform:translate(-10px,-26px)}",
  ".relay-v3-tank-on .relay-v3-tank-drop-3{transform:translate(6px,-14px)}",
  ".relay-v3-tank-on .relay-v3-tank-drop-4{transform:translate(18px,-24px)}",
  ".relay-v3-tank-on .relay-v3-tank-drop-5{transform:translate(30px,-10px)}",
  ".relay-v3-tank-on{color:var(--tank-text,#eaf2ff);border-color:var(--tank-accent);background:rgba(13,17,23,.72);box-shadow:0 0 14px var(--tank-glow),inset 0 0 16px var(--tank-inner)}",
  ".relay-v3-tank-blue{--tank-accent:#2f81f7;--tank-glow:rgba(47,129,247,.20);--tank-inner:rgba(47,129,247,.14);--tank-line:rgba(47,129,247,.55);--tank-text:#dcebff;--tank-water:47,129,247;--tank-water-light:156,216,255;--tank-water-deep:6,30,82}",
  ".relay-v3-tank-green{--tank-accent:#2da44e;--tank-glow:rgba(45,164,78,.20);--tank-inner:rgba(45,164,78,.14);--tank-line:rgba(45,164,78,.55);--tank-text:#dcffe8;--tank-water:45,164,78;--tank-water-light:158,245,196;--tank-water-deep:4,38,19}",
  ".relay-v3-tank-sakura{--tank-accent:#ff5470;--tank-glow:rgba(255,84,112,.28);--tank-inner:rgba(255,84,112,.18);--tank-line:rgba(255,84,112,.55);--tank-text:#ffe1e7;--tank-water:255,84,112;--tank-water-light:255,200,214;--tank-water-deep:74,5,22}",
  // v0.2.21：接力 chip 独角兽纹路（inline 红色分叉电路 SVG）+ 呼吸红光 + 3 颗向上飘的火星；
  // 暗红底只在「已到线」时由 unicornChipOverStyle 提供，平时透明底只留纹路。
  // v0.2.30：未到线只留电路纹（不发光）；已到线才挂 -glow（红光 + 呼吸）与火星。
  ".relay-v3-chip-unicorn{position:relative;overflow:hidden}",
  ".relay-v3-chip-unicorn-glow{box-shadow:0 0 10px 1px rgba(255,45,78,.45),inset 0 0 10px rgba(255,45,78,.30);animation:relay-v3-unicorn-glow 2.6s ease-in-out infinite}",
  ".relay-v3-unicorn-sparks{position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:inherit}",
  ".relay-v3-unicorn-spark{position:absolute;bottom:0;width:3px;height:3px;border-radius:50%;background:#ff6076;box-shadow:0 0 6px 2px rgba(255,45,78,.95);animation:relay-v3-unicorn-spark 1.7s ease-in-out infinite}",
  ".relay-v3-unicorn-spark:nth-of-type(1){left:18%;animation-delay:0s}",
  ".relay-v3-unicorn-spark:nth-of-type(2){left:52%;animation-delay:.55s}",
  ".relay-v3-unicorn-spark:nth-of-type(3){left:81%;animation-delay:1.05s}",
  "@keyframes relay-v3-unicorn-spark{0%{opacity:0;transform:translateY(0) scale(.6)}14%{opacity:1;transform:translateY(-3px) scale(1)}70%{opacity:.85;transform:translateY(-13px) scale(.85)}100%{opacity:0;transform:translateY(-19px) scale(.5)}}",
  "@keyframes relay-v3-unicorn-glow{0%,100%{box-shadow:0 0 8px 1px rgba(255,45,78,.35),inset 0 0 8px rgba(255,45,78,.22)}50%{box-shadow:0 0 14px 2px rgba(255,45,78,.60),inset 0 0 12px rgba(255,45,78,.40)}}",
  // v0.2.14：下一个接力新会话的二态滑动开关。固定尺寸（轨道 28px + transform 位移），切换不引发布局抖动。
  // 轨道固定高度；thumb 绝对定位只动 transform；label 用 flex 等分（绝对定位元素不参与 flex，不影响布局）。
  ".relay-v3-mode{display:grid;gap:4px}",
  ".relay-v3-slide{display:flex;align-items:center;width:100%;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}",
  ".relay-v3-slide-track{position:relative;display:flex;flex:1 1 auto;height:28px;min-width:0;overflow:hidden;border-radius:999px;background:rgba(127,127,127,.14);box-shadow:inset 0 1px 2px rgba(0,0,0,.18);transition:filter 120ms ease}",
  // 双层 fill：蓝（左/跟随普通 Relay）与紫青（右/超长任务）叠在同一轨道，切换时 opacity 交叉渐变。
  ".relay-v3-slide-fill{position:absolute;inset:0;border-radius:inherit;opacity:0;pointer-events:none;transition:opacity 260ms ease}",
  ".relay-v3-slide-fill-blue{background:linear-gradient(135deg,rgba(47,129,247,.34),rgba(47,129,247,.12) 55%,rgba(47,129,247,.06))}",
  ".relay-v3-slide-fill-long{background:linear-gradient(135deg,rgba(139,92,246,.38),rgba(34,211,238,.18) 60%,rgba(34,211,238,.07))}",
  ".relay-v3-slide-left .relay-v3-slide-fill-blue{opacity:1}",
  ".relay-v3-slide-right .relay-v3-slide-fill-long{opacity:1}",
  // 弹簧位移只走 transform（300ms 回弹曲线）；hover/active 微反馈只改 box-shadow/filter，绝不覆盖 thumb 的 transform。
  ".relay-v3-slide-thumb{position:absolute;top:3px;left:3px;bottom:3px;width:calc(50% - 3px);z-index:1;border-radius:999px;background:rgba(255,255,255,.94);box-shadow:0 1px 2px rgba(0,0,0,.22),inset 0 0 0 1px rgba(255,255,255,.6);transition:transform 300ms cubic-bezier(.34,1.56,.64,1),box-shadow 260ms ease}",
  ".relay-v3-slide-right .relay-v3-slide-thumb{transform:translateX(100%)}",
  ".relay-v3-slide:hover .relay-v3-slide-thumb{box-shadow:0 2px 6px rgba(0,0,0,.26),inset 0 0 0 1px rgba(255,255,255,.72)}",
  ".relay-v3-slide:active .relay-v3-slide-track{filter:brightness(.96)}",
  ".relay-v3-slide:focus-visible{outline:2px solid #2f81f7;outline-offset:2px;border-radius:999px}",
  // 两端 label 等分轨道，active 端高亮（压在白色 thumb 上时用深色保证对比）。
  ".relay-v3-slide-label{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;flex:1 1 0;min-width:0;padding:0 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:center;font-size:11.5px;font-weight:600;color:inherit;opacity:.52;transition:opacity 220ms ease,color 220ms ease}",
  ".relay-v3-slide-label-on{opacity:1;color:#0b1220}",
  "@media (prefers-reduced-motion: reduce){.relay-v3-dot-pop{animation:none}.relay-v3-dot-breathe.relay-v3-dot-pop{animation:none}.relay-v3-chip.over-pulse{animation:none}.relay-v3-chip-unicorn-glow{animation:none}.relay-v3-pct{animation:none}.relay-v3-ripple::after{transition:none}.relay-v3-popover-closing{animation:none}.relay-v3-chip{transition:none}.relay-v3-chip:hover{transform:none;box-shadow:none}.relay-v3-chip:active{transform:none}.relay-v3-next{animation:none}.relay-v3-auto{animation:none;background:none;-webkit-text-fill-color:currentColor}.relay-v3-dot{transition:none}.relay-v3-dot-breathe{animation:none}.relay-v3-badge{transition:none}.relay-v3-auth{transition:none}.relay-v3-auth:active{transform:none}.relay-v3-popover{animation:none}.relay-v3-slide-thumb{transition:box-shadow 260ms ease}.relay-v3-tank,.relay-v3-tank-label,.relay-v3-tank-liquid,.relay-v3-tank-wave,.relay-v3-tank-drop,.relay-v3-tank-veins{transition:none}.relay-v3-tank-spark{animation:none;display:none}.relay-v3-chip-unicorn{animation:none}.relay-v3-unicorn-spark{animation:none;display:none}}",
  // v0.3.2：冷峻哥特「石肋星盘」表盘（classic 6 档 / relay-long 4 档）。
  // 结构 = 束柱/扇形肋/尖拱 tracery 环/尖拱连拱廊/石墙双环/方位刻度/尖饰冠/飞扶壁，全部冷灰线稿；
  // 冷光只用于选中路径（中心 → 节点 → 铭牌）与指针；无彩窗、无暖金。
  // 动画只碰 transform/opacity/filter 与 stroke-dashoffset（纯 paint，不触发布局）；reduced-motion 全关。
  "@keyframes relay-v3-dial-in{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}",
  "@keyframes relay-v3-order-in{from{opacity:0;transform:translate(-50%,-50%) translateY(3px) scale(.95)}to{opacity:.72;transform:translate(-50%,-50%)}}",
  "@keyframes relay-v3-needle-in{from{transform:rotate(0deg)}to{transform:rotate(var(--dial-to))}}",
  "@keyframes relay-v3-dial-ping{0%{opacity:.7;transform:scale(.45)}100%{opacity:0;transform:scale(1.5)}}",
  "@keyframes relay-v3-readout-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}",
  "@keyframes relay-v3-dial-flow{to{stroke-dashoffset:-24}}",
  "@keyframes relay-v3-dial-sweep{from{transform:translateY(-30px)}to{transform:translateY(200px)}}",
  "@keyframes relay-v3-dial-pulse{0%,100%{opacity:.55}50%{opacity:1}}",
  "@keyframes relay-v3-needle-flow{0%{opacity:0;transform:translateY(0)}14%{opacity:1}70%{opacity:.9}100%{opacity:0;transform:translateY(-58px)}}",
  ".relay-v3-dial-wrap{display:grid;gap:2px;justify-items:center;width:100%}",
  // 抬头 = 冷石横楣：只剩标题（用户要求去掉上方操作说明），两侧一道细冷灰线，居中。
  ".relay-v3-dial-head{display:flex;align-items:center;gap:10px;width:100%;padding:1px 4px 0}",
  ".relay-v3-dial-head::before,.relay-v3-dial-head::after{content:'';flex:1 1 auto;height:1px;background:linear-gradient(90deg,rgba(125,149,166,0),rgba(125,149,166,.48))}",
  ".relay-v3-dial-head::after{background:linear-gradient(90deg,rgba(125,149,166,.48),rgba(125,149,166,0))}",
  ".relay-v3-dial-head-title{font-family:Georgia,'Times New Roman','Songti SC','SimSun','Noto Serif CJK SC',serif;font-weight:600;font-size:11px;letter-spacing:.24em;color:#b6c6d2;text-shadow:0 0 8px rgba(127,230,255,.16);white-space:nowrap}",
  ".relay-v3-dial{position:relative;width:300px;height:264px;margin:0 auto;user-select:none;-webkit-user-select:none;touch-action:none;outline:none;cursor:grab;animation:relay-v3-dial-in 260ms cubic-bezier(.2,.8,.2,1)}",
  ".relay-v3-dial:active{cursor:grabbing}",
  ".relay-v3-dial:focus-within{outline:2px solid #7fe6ff;outline-offset:2px;border-radius:6px}",
  // 盘面 = 冷黑石龛（唯一光源是拱廊后的冷背光）；全息色差 = 双色 drop-shadow 只落在结构线上。
  ".relay-v3-dial-face{position:absolute;inset:-8px;pointer-events:none;background:radial-gradient(circle at 50% 50%,rgba(17,25,33,.74),rgba(11,16,21,.36) 60%,rgba(8,11,15,0) 80%)}",
  ".relay-v3-dial-gauge{position:absolute;inset:0;overflow:visible;pointer-events:none;filter:drop-shadow(1px 0 0 rgba(127,230,255,.12)) drop-shadow(-1px 0 0 rgba(255,80,120,.07))}",
  ".relay-v3-dial-backlight{opacity:.85}",
  // ① 冷灰结构骨架：放射肋 / 同心券环 / 穹顶网格 / 石墙双线 / 尖拱山花冠 / 尖顶饰 / 四角飞扶壁。
  ".relay-v3-dial-structure{fill:none;stroke:#5a6f7e;stroke-width:1;stroke-linecap:round;stroke-linejoin:round;opacity:.92;filter:drop-shadow(0 0 3px rgba(127,230,255,.14))}",
  ".relay-v3-dial-rib{stroke:#3f5462}",
  ".relay-v3-dial-rib-main{stroke:#7691a2}",
  ".relay-v3-dial-course{stroke:#2f404b;opacity:.6}",
  ".relay-v3-dial-arc{stroke:#5b7484;stroke-width:.9;opacity:.92}",
  ".relay-v3-dial-arc-hi{stroke:#9db8c9;stroke-width:1.1}" +
  ".relay-v3-dial-lierne{stroke:#3f5462;stroke-width:.8}",
  ".relay-v3-dial-course{stroke:#33444f;opacity:.75}",
  ".relay-v3-dial-gable{fill:none;stroke:#7d9aab;stroke-width:1}",
  ".relay-v3-dial-finial{fill:#0b1218;stroke:#9db8c9;stroke-width:.9}",
  ".relay-v3-dial-buttress{fill:none;stroke:#526a78;opacity:.85}",
  // ② 尖拱连拱廊：每档一格；无彩窗（fill 几乎透明），hover/选中只提亮冷光。
  ".relay-v3-dial-sector{fill:rgba(150,190,215,.025);stroke:none;transition:fill 170ms ease,filter 170ms ease}",
  ".relay-v3-dial-sector-hover{fill:rgba(168,209,230,.07);filter:drop-shadow(0 0 4px rgba(127,230,255,.18))}",
  ".relay-v3-dial-sector-on{fill:url(#relay-v3-dial-lit);stroke:#d7f4ff;filter:drop-shadow(0 0 7px rgba(127,230,255,.5))}",
  // ③ 选中肋线：中心 → 节点 → 铭牌；点亮时冷光沿臂线流动（stroke-dashoffset = 纯 paint）。
  ".relay-v3-dial-ray{fill:none;stroke:#33444f;stroke-width:1.2}",
  ".relay-v3-dial-ray-on{stroke:#b7f2ff;stroke-width:1.6;stroke-dasharray:3 9;filter:drop-shadow(0 0 5px rgba(127,230,255,.6));animation:relay-v3-dial-flow 1.6s linear infinite}",
  ".relay-v3-dial-tie{fill:none;stroke:#455d6b;stroke-width:1}",
  ".relay-v3-dial-tie-on{stroke:#8fe9ff;stroke-width:1.2;filter:drop-shadow(0 0 5px rgba(127,230,255,.5))}",
  // ④ 档位节点 = 菱形石雕凸饰；选中 = 冷白发光 + 轻脉冲。
  ".relay-v3-dial-pip{fill:#0b1218;stroke:#8fa9ba;stroke-width:1;transition:fill 170ms ease,stroke 170ms ease,filter 170ms ease}",
  ".relay-v3-dial-pip-on{fill:#eaf9ff;stroke:#d9f6ff;filter:drop-shadow(0 0 6px rgba(127,230,255,.8));animation:relay-v3-dial-pulse 2.2s ease-in-out infinite}",
  // ⑤ 中心 = 束柱平面（8 根柱 + 拱心石）+ 冷背光（束柱的柱身是暗的，只有缝里透冷光）。
  ".relay-v3-dial-hub{filter:drop-shadow(0 0 6px rgba(127,230,255,.22))}",
  ".relay-v3-dial-hub-shaft{fill:none;stroke:#7d99aa;stroke-width:1;opacity:.9}",
  ".relay-v3-dial-hub-ring{fill:none;stroke:#8fa9ba;stroke-width:1.2}",
  ".relay-v3-dial-hub-core{fill:#0e1820;stroke:#d5eef9;stroke-width:1.1}",
  ".relay-v3-dial-hub-core-dot{fill:#d9f6ff;stroke:none}",
  // ⑥ 指针 = 照准仪（alidade）：细冷钢针 + 菱形垂尖 + 四叶配重；光沿针上移。
  ".relay-v3-dial-needle{position:absolute;left:150px;top:132px;width:0;height:0;transform-origin:0 0;transition:transform 560ms cubic-bezier(.22,1.36,.36,1);animation:relay-v3-needle-in 700ms cubic-bezier(.3,.85,.3,1);pointer-events:none;z-index:3;filter:drop-shadow(0 0 5px rgba(127,230,255,.45))}",
  ".relay-v3-dial-needle-settled{animation:none}",
  ".relay-v3-dial-needle-dragging{animation:none;transition:none}",
  ".relay-v3-dial-alidade{position:absolute;left:-13px;top:-96px;width:26px;height:132px;overflow:visible}",
  ".relay-v3-dial-alidade-fin{fill:url(#relay-v3-needle-steel);stroke:#eaf9ff;stroke-width:.6}",
  ".relay-v3-dial-alidade-graduation{fill:none;stroke:#dff4ff;stroke-width:.7}",
  ".relay-v3-dial-alidade-rule{fill:url(#relay-v3-needle-steel);stroke:#dff4ff;stroke-width:.35}",
  ".relay-v3-dial-alidade-tail{fill:none;stroke:#9db8c9;stroke-width:1.1}",
  ".relay-v3-dial-alidade-pivot{fill:#0d161d;stroke:#eaf9ff;stroke-width:1}",
  ".relay-v3-dial-needle-flow{position:absolute;left:-1px;top:-88px;width:2px;height:7px;border-radius:2px;background:linear-gradient(180deg,rgba(127,230,255,0),rgba(191,244,255,.95));box-shadow:0 0 5px rgba(127,230,255,.8);opacity:0;animation:relay-v3-needle-flow 1.9s ease-in-out infinite}",
  // ⑦ 赛博只落在结构上：盘面扫描线 + 缓慢下移的全息扫描带（圆内，mix-blend screen）。
  ".relay-v3-dial-scan{position:absolute;left:54px;top:36px;width:192px;height:192px;border-radius:50%;overflow:hidden;pointer-events:none;z-index:2;mix-blend-mode:screen;opacity:.85}",
  ".relay-v3-dial-scanlines{position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(127,230,255,.06) 0 1px,rgba(0,0,0,0) 1px 3px)}",
  ".relay-v3-dial-sweep{position:absolute;left:0;right:0;height:30px;background:linear-gradient(180deg,rgba(127,230,255,0),rgba(127,230,255,.14),rgba(127,230,255,0));animation:relay-v3-dial-sweep 5.2s linear infinite}",
  ".relay-v3-dial-ping{position:absolute;left:150px;top:132px;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;border:1px solid rgba(127,230,255,.55);box-shadow:0 0 10px rgba(127,230,255,.28);opacity:0;pointer-events:none;z-index:4;animation:relay-v3-dial-ping 520ms ease-out}",
  // ⑧ 档位铭牌 = 冷石铭刻（切角石板 + 1px 冷灰边 + 菱形节点 + 衬线中文）；选中 = 冷光勾边（不点亮整块）。
  ".relay-v3-order{position:absolute;display:flex;align-items:center;gap:4px;padding:3px 7px;border:1px solid transparent;background:linear-gradient(180deg,#5d7280,#2a3742) border-box,linear-gradient(180deg,#101820,#090e13) padding-box;color:#c3d3df;cursor:pointer;font-family:Georgia,'Times New Roman','Songti SC','SimSun','Noto Serif CJK SC',serif;font-size:11px;font-weight:600;letter-spacing:.03em;white-space:nowrap;opacity:.86;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));transform:translate(-50%,-50%);clip-path:polygon(4px 0,calc(100% - 4px) 0,100% 4px,100% calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,0 calc(100% - 4px),0 4px);transition:opacity 190ms ease,filter 190ms ease,transform 190ms ease;animation:relay-v3-order-in 260ms cubic-bezier(.2,.8,.2,1) backwards;z-index:5}",
  ".relay-v3-order:hover{opacity:1;filter:drop-shadow(0 0 6px rgba(127,230,255,.35)) drop-shadow(0 2px 4px rgba(0,0,0,.6))}",
  ".relay-v3-order-hover{opacity:1;filter:drop-shadow(0 0 6px rgba(127,230,255,.35)) drop-shadow(0 2px 4px rgba(0,0,0,.6))}",
  ".relay-v3-order:active{transform:translate(-50%,-50%) scale(.97)}",
  ".relay-v3-order-on{opacity:1;color:#f2fbff;background:linear-gradient(180deg,#e2f7ff,#3d849e) border-box,linear-gradient(180deg,#0c161d,#0a1218) padding-box;filter:drop-shadow(0 0 8px rgba(127,230,255,.55)) drop-shadow(0 2px 4px rgba(0,0,0,.6));text-shadow:0 0 6px rgba(191,244,255,.55)}",
  ".relay-v3-order:focus-visible{outline:2px solid #7fe6ff;outline-offset:1px}",
  ".relay-v3-order-key{width:5px;height:5px;flex:0 0 auto;transform:rotate(45deg);border:1px solid #8fa9ba;background:#0b1218;transition:background-color 190ms ease,border-color 190ms ease,box-shadow 190ms ease}",
  ".relay-v3-order-on .relay-v3-order-key{background:#d9f6ff;border-color:#eaf9ff;box-shadow:0 0 5px rgba(127,230,255,.9)}",
  ".relay-v3-order-stack{display:flex;flex-direction:column;align-items:flex-start;gap:1px;line-height:1.05}",
  ".relay-v3-order-tag{font-family:Georgia,'Times New Roman','Songti SC','SimSun','Noto Serif CJK SC',serif;font-size:8px;font-weight:600;letter-spacing:.12em;color:#8fa9ba}",
  ".relay-v3-order-on .relay-v3-order-tag{color:#bfe8f7}",
  ".relay-v3-dial-readout{display:grid;gap:1px;justify-items:center;min-height:28px;padding:2px 8px 0;text-align:center}",
  ".relay-v3-dial-readout-main{font-family:Georgia,'Times New Roman','Songti SC','SimSun','Noto Serif CJK SC',serif;font-size:12px;font-weight:600;letter-spacing:.16em;animation:relay-v3-readout-in 200ms ease both}",
  ".relay-v3-dial-readout-hint{font-size:10.5px;line-height:1.35;color:var(--dsh-text-secondary,#8b949e);max-width:300px;animation:relay-v3-readout-in 240ms ease both}",
  "@media (prefers-reduced-motion: reduce){.relay-v3-dial{animation:none}.relay-v3-dial-needle{transition:none;animation:none}.relay-v3-dial-needle-flow{animation:none;display:none}.relay-v3-dial-ping{animation:none;display:none}.relay-v3-order{animation:none;transition:none}.relay-v3-order:active{transform:translate(-50%,-50%)}.relay-v3-order-on{transform:translate(-50%,-50%)}.relay-v3-dial-readout-main{animation:none}.relay-v3-dial-readout-hint{animation:none}.relay-v3-dial-pip{transition:none}.relay-v3-dial-sector{transition:none}.relay-v3-dial-ray-on{animation:none;stroke-dasharray:none}.relay-v3-dial-pip-on{animation:none}.relay-v3-dial-sweep{animation:none;display:none}.relay-v3-dial-scan{opacity:.5}}",
  // v0.3.3：模型推荐 = 面板高亮/参考（冷青虚线 + 微光；与选中态 relay-v3-order-on 区分，不抢选中态）。
  // 推荐只是提醒：不改变预设/人类决策权、不自动执行压缩/接力、不产生审批豁免。
  ".relay-v3-recommend{display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;border:1px dashed rgba(127,230,255,.42);background:rgba(127,230,255,.06);color:#bfe8f7;font-size:11.5px;line-height:16px;white-space:nowrap;overflow:hidden}",
  ".relay-v3-rec-tag{flex:0 0 none;padding:0 4px;border-radius:3px;background:rgba(127,230,255,.16);color:#eafaff;font-weight:600;letter-spacing:.06em;animation:relay-v3-recommend-glow 2.8s ease-in-out infinite}",
  ".relay-v3-rec-op{flex:0 0 none;color:#eafaff;font-weight:600}",
  ".relay-v3-rec-reason{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:#9fc4d4}",
  ".relay-v3-rec-time{flex:0 0 none;color:#8fa9ba;font-variant-numeric:tabular-nums}",
  "@keyframes relay-v3-recommend-glow{0%,100%{opacity:.68}50%{opacity:1}}",
  ".relay-v3-order-recommend{opacity:.94;border-style:dashed;border-color:rgba(127,230,255,.62);filter:drop-shadow(0 0 5px rgba(127,230,255,.38)) drop-shadow(0 2px 4px rgba(0,0,0,.6))}",
  ".relay-v3-order-recommend-tag{display:inline-flex;align-items:center;justify-content:center;min-width:12px;height:12px;padding:0 2px;border-radius:2px;border:1px dashed rgba(127,230,255,.75);background:rgba(127,230,255,.14);color:#d8f6ff;font-size:8px;font-weight:600;line-height:1;letter-spacing:0}",
  ".relay-v3-order-recommend:hover,.relay-v3-order-recommend.relay-v3-order-hover{opacity:1;filter:drop-shadow(0 0 7px rgba(127,230,255,.6)) drop-shadow(0 2px 4px rgba(0,0,0,.6))}",
  // 推荐档同时被选中：保留选中态的冷光强度（推荐只加虚线勾边，不降低选中态）。
  ".relay-v3-order-on.relay-v3-order-recommend{opacity:1;filter:drop-shadow(0 0 8px rgba(127,230,255,.55)) drop-shadow(0 2px 4px rgba(0,0,0,.6))}",
  "@media (prefers-reduced-motion: reduce){.relay-v3-rec-tag{animation:none}}",
].join("");
function ensurePanelCss() {
  try {
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
    const existing = document.querySelector('style[data-plugin-css="dsh-context-relay/panel-v3"]');
    if (existing !== null) {
      // 只按 key 判重会把旧 CSS 留在页面里（热重载后新动效/毛玻璃全部不生效）——内容变了就原地更新。
      if (existing.textContent !== PANEL_CSS) existing.textContent = PANEL_CSS;
      return;
    }
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-context-relay";
    style.dataset.pluginCss = "dsh-context-relay/panel-v3";
    style.textContent = PANEL_CSS;
    if (document.head !== undefined && document.head !== null && typeof document.head.appendChild === "function") document.head.appendChild(style);
  } catch { /* 无 DOM 的测试/宿主环境忽略动效样式 */ }
}
// 宽/高/水平对齐由打开时按 chip 所在 dock 行的可用宽度计算（见 click handler）：
// 侧栏打开时聊天列变窄 → 面板收窄并对齐到 chip 内侧，避免被侧栏挤掉/盖住。
const popover = { position: "fixed", zIndex: 1200, display: "grid", gap: 6, maxWidth: "calc(100vw - 32px)", overflowY: "auto", padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l1, var(--dsh-border, #d0d7de))", borderRadius: 10,
  // 毛玻璃底：低透明度中性色 + 玻璃光泽（不依赖 color-mix，保证透出背景）；有 color-mix 时由 @supports 规则换成主题色 45% 半透明。
  background: "rgba(128,128,128,0.10)",
  backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.07))",
  color: "var(--dsw-alias-label-primary, inherit)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16), var(--dsw-elevation-panel, 0 14px 34px rgba(0,0,0,0.32))", fontSize: 12, textAlign: "left", cursor: "default", transformOrigin: "bottom center" };

const popTitle = { fontWeight: 600, fontSize: 12 };
// 授权下一次操作：popover 里是显眼的黄/绿着色按钮（状态还同步显示在 chip 光点上）。

/** 实时比例：优先 agent 发布的 ratio，缺失时由 used/window 推；都没有则 null。 */
function livePct(live) {
  const ratio = Number.isFinite(live && live.ratio) ? live.ratio
    : Number.isFinite(live && live.used) && Number.isFinite(live && live.window) && live.window > 0 ? live.used / live.window
    : undefined;
  return ratio === undefined ? null : Math.round(ratio * 1000) / 10;
}

function RelayPanel(props) {
  const sessionId = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : "";
  const [data, setData] = React.useState(null);
  // v0.2.31：relay-long 模式判定 = 当前会话 preset 就是 long preset（panel GET 已下发 preset + modes）。
  // 长模式表盘只给 4 档（隐藏「压缩→新会话」与「自动（模型决定）」）；判定须先于表盘 hooks/坐标计算。
  const modes = data !== null && data.modes !== null && typeof data.modes === "object" && typeof data.modes.long === "string" ? data.modes : null;
  const longMode = modes !== null && data.preset === modes.long;
  const dialLayout = dialLayoutOf(longMode);
  const dialCount = dialLayout.count;
  const [open, setOpen] = React.useState(false);
  // 关闭时先播 120ms 淡出再卸载（closing），避免面板「啪」地消失。
  const [closing, setClosing] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [layout, setLayout] = React.useState(null);
  const rootRef = React.useRef(null);
  // portal 面板的 DOM 引用：点面板内部不能触发「点外面关闭」。
  const popRef = React.useRef(null);
  // 最新 sessionId：丢弃切会话后迟到的响应，避免旧会话数据盖掉新会话。
  const sidRef = React.useRef(sessionId);
  sidRef.current = sessionId;
  // §3.6 写入优先：PUT 成功后记录时间，旧的 GET 回包（发起早于最近一次写入）丢弃。
  const lastWriteAtRef = React.useRef(0);
  const closeTimerRef = React.useRef(null);
  const closePanel = () => {
    if (closeTimerRef.current !== null) return;
    setOpen(false);
    setClosing(true);
    closeTimerRef.current = setTimeout(() => { closeTimerRef.current = null; setClosing(false); }, 120);
  };
  const openPanel = (nextLayout) => {
    if (closeTimerRef.current !== null) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    // 每次打开面板重播一次指针入场摆动（settled 类关闭后不会再被拖动/选中重播）。
    setDialNeedleSettled(false);
    setDialHover(null);
    setClosing(false);
    setLayout(nextLayout);
    setOpen(true);
  };
  // portal + fixed 的坐标：按 chip 的视口 rect 算，水平居中并夹在视口内，底边贴 chip 上方 8px。
  const computeLayout = () => {
    const el = rootRef.current;
    const rect = el === null || typeof el.getBoundingClientRect !== "function" ? null : el.getBoundingClientRect();
    const vw = window.innerWidth || 360;
    const vh = window.innerHeight || 800;
    const width = Math.max(220, Math.min(POPOVER_WIDTH, vw - 24));
    if (rect === null) return { left: 16, bottom: 96, width, maxHeight: 600 };
    const left = Math.max(8, Math.min(Math.round(rect.left + rect.width / 2 - width / 2), vw - width - 8));
    const bottom = Math.max(8, Math.round(vh - rect.top + 8));
    // v0.2.19：车钟表盘 300×264 → 面板内容上限 560→600，仍受视口高度/胶囊上方空间夹取。
    const maxHeight = Math.max(180, Math.min(Math.round(vh * 0.72), 600, Math.round(rect.top - 16)));
    return { left, bottom, width, maxHeight };
  };
  const sameLayout = (a, b) => a !== null && b !== null && a.left === b.left && a.bottom === b.bottom && a.width === b.width && a.maxHeight === b.maxHeight;
  // 流式输出时消息区一直在滚：panel 不能被滚关闭（官方 ContextMeter 也不会）——只跟着 chip 重定位，
  // 且用 rAF 节流、layout 无变化时不 setState（避免每帧重渲染）。
  const repositionPanel = () => {
    const next = computeLayout();
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  };
  React.useEffect(() => () => { if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current); }, []);
  // B-P2-13：宿主切换会话时可能复用同一个组件实例 → 重置展开/关闭动效/layout，
  // 避免把上一个会话的 popover 状态（甚至自动重开）带到新会话。
  React.useEffect(() => {
    if (closeTimerRef.current !== null) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    setOpen(false);
    setClosing(false);
    setLayout(null);
    lastWriteAtRef.current = 0;
    // 切会话：清掉表盘乐观意图/悬停/累积指针角，避免 1.5s 兜底窗口内的旧会话意图带入新会话。
    setDialAim(null);
    setDialHover(null);
    setDialNeedle(null);
    dialBaseRef.current = null;
    dialAngleRef.current = null;
  }, [sessionId]);

  const load = React.useCallback(() => {
    if (sessionId === "" || document.visibilityState === "hidden") return;
    const startedAt = Date.now();
    fetch(PANEL_API + "?sessionId=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" }, cache: "no-store" })
      .then((res) => res.json())
      .then((next) => {
        if (!next || next.ok === false || sidRef.current !== sessionId) return;
        // 请求发出早于最近一次 PUT 成功 → 丢弃这份可能回滚刚点开关的旧快照。
        if (startedAt < lastWriteAtRef.current) return;
        setData({
          sessionId,
          panel: next.panel || null,
          live: next.live || null,
          thresholds: next.thresholds || null,
          // v0.2.14：下一个接力新会话模式开关的数据（旧 host 无这些字段 → 不渲染开关）。
          relay: next.relay === true,
          modes: next.modes ?? null,
          preset: next.preset ?? null,
        });
      })
      .catch(() => { /* 下次轮询再试 */ });
  }, [sessionId]);

  React.useEffect(() => {
    if (sessionId === "") return undefined;
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [sessionId, load]);

  // 非阻塞：点面板外或按 Escape 收起；面板本身不拦截输入区之外的交互。
  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      const insideChip = rootRef.current !== null && rootRef.current.contains(event.target);
      const insidePanel = popRef.current !== null && popRef.current.contains(event.target);
      if (!insideChip && !insidePanel) closePanel();
    };
    const onKeyDown = (event) => { if (event.key === "Escape") closePanel(); };
    const onResize = () => closePanel();
    // 滚动（含流式输出时消息区的连续滚动）只重定位，不关闭面板。
    let rafId = 0;
    const onScroll = () => {
      if (rafId !== 0) return;
      if (typeof window.requestAnimationFrame !== "function") { repositionPanel(); return; }
      rafId = window.requestAnimationFrame(() => { rafId = 0; repositionPanel(); });
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (rafId !== 0 && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(rafId);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // v0.2.18：车钟表盘的交互状态（hooks 必须在任何 early return 之前无条件调用）。
  const [dialAim, setDialAim] = React.useState(null);
  const dialRootRef = React.useRef(null);
  const dialOrderRefs = React.useRef([]);
  const dialDragRef = React.useRef(null);
  // 已意图的档位（同步 ref）：连按键盘/连续点档位时不等宿主回包，避免重复提交同一档。
  const dialBaseRef = React.useRef(null);
  // v0.2.19：指针显示角（同步 ref + state）——值可累积到 ±360 之外，换挡按最短弧更新；
  // 拖动/连按键盘时先写 ref 再渲染，避免读到上一帧的旧角度。
  const dialAngleRef = React.useRef(null);
  const [dialNeedle, setDialNeedle] = React.useState(null);
  // 悬停的 60° 扇区：点击扇区即选档，悬停时高亮该扇区与对应铭牌。
  const [dialHover, setDialHover] = React.useState(null);
  // 指针入场摆动只播一次：onAnimationEnd / 开始拖动 / 重新打开面板时用 settled 类关掉 animation，
  // 否则松手移除 dragging 类会让基础 animation 重新从 0° 播（覆盖弹簧吸附）。
  const [dialNeedleSettled, setDialNeedleSettled] = React.useState(false);
  const dialSelected = dialIndexOf(data !== null && data.sessionId === sessionId ? data.panel : undefined, longMode);
  // 宿主回包把真实档位更新后清掉乐观预览/意图；PUT 失败时 1.5s 兜底复位（不长时间骗人）。
  React.useEffect(() => {
    if (dialBaseRef.current !== null && dialSelected === dialBaseRef.current) dialBaseRef.current = null;
    if (dialAim === null || dialAim.dragging === true) return undefined;
    if (dialSelected === dialAim.index) { setDialAim(null); return undefined; }
    const timer = setTimeout(() => { dialBaseRef.current = null; setDialAim(null); }, 1500);
    return () => clearTimeout(timer);
  }, [dialAim, dialSelected]);
  // 宿主回包/外部改档后把指针角收敛到当前档的等价角（视觉不变，值域不无限膨胀）。
  React.useEffect(() => {
    if (dialAim !== null || dialAngleRef.current === null) return;
    const next = dialUnwrap(dialAngleRef.current, dialAngleOf(dialSelected, dialCount));
    if (next === dialAngleRef.current) return;
    dialAngleRef.current = next;
    setDialNeedle(next);
  }, [dialAim, dialSelected, dialCount]);
  /** 当前「已意图」档位：优先乐观意图（连按/连点不等回包），否则用宿主真实值。 */
  const dialCurrent = () => (dialBaseRef.current !== null ? dialBaseRef.current : dialSelected);

  const update = (patch) => {
    if (sessionId === "") return;
    setStatus("保存中…");
    setError("");
    fetch(PANEL_API, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sessionId, ...patch }),
    })
      .then((res) => res.json())
      .then((next) => {
        if (next && next.ok) {
          if (sidRef.current === sessionId) {
            lastWriteAtRef.current = Date.now();
            setData((prev) => ({ ...(prev || {}), panel: next.panel || null }));
            // B-P2-10：写盘失败由 host 明确上报 persisted:false（内存已生效，但重启会丢）。
            setStatus(next.persisted === false ? "已保存（仅本会话；未写入磁盘，重启后会丢失）" : "已保存（仅本会话）");
            if (next.persisted !== false) setError("");
          }
        } else { setStatus(""); setError((next && next.message) || "保存失败"); }
      })
      .catch(() => { setStatus(""); setError("保存失败"); });
  };

  // v0.2.31：panel GET 明确 relay===true 才渲染接力 chip（非 relay 会话完全不出现；与 budget 胶囊同一 gating）。
  // 数据就绪即渲染：宿主 GET 在会话已 attach 时会从官方投影派生实时值；派生仍不可得
  // （该会话未载入宿主内存/投影服务缺失）时渲染中性降级态（比例 ?、无 band/「已到线」），不再整块隐藏。
  // 串会话保护不变：只认 data.sessionId === 当前 sessionId 的快照。
  const hasData = data !== null && data.sessionId === sessionId && data.relay === true;
  if (!hasData) return null;
  const live = data.live || null;
  const liveKnown = live !== null;
  const panel = data.panel || {};
  const over = liveKnown && live.overBudget === true;
  const pct = livePct(live);
  const organizeCount = liveKnown && Number.isFinite(live.organizeCount) ? live.organizeCount : null;
  const modeBadge = modeOf(panel, longMode);
  const decision = autoDecisionOf(panel);
  // v0.3.3：模型推荐 → popover 推荐行 + 对应档位「荐」标记；不改预设/chip 显示/执行。
  // v0.3.4：长模式收到 compress-then-handoff 推荐时整条忽略（当无推荐）。
  const recommendation = recommendationOf(panel, longMode);
  // v0.2.14：下一个接力新会话模式（滑动开关）；旧 host 无 modes 或非 relay 会话 → null 不渲染。
  const handoffModeNode = handoffModeSwitch(data, panel, update);
  // v0.2.31 赛博哥特表盘：classic 6 档 / relay-long 4 档按键 + 哥特窗花 SVG + 彩窗扇区 + 金属刀片指针。
  // 指针角按最短弧累积（±360° 外等价角）；拖动实时跟随并预览最近档；松手/点扇区/点铭牌/键盘都会提交。
  const dialAimIndex = dialAim === null ? dialSelected : dialAim.index;
  // 显示角：拖动/乐观预览用 aim 的连续角；否则把状态角 unwrap 到真实档（等价角，只走最短弧）。
  const dialNeedleDeg = dialAim !== null
    ? dialAim.angle
    : dialNeedle === null ? dialSigned(dialAngleOf(dialSelected, dialCount)) : dialUnwrap(dialNeedle, dialAngleOf(dialSelected, dialCount));
  const dialDragging = dialAim !== null && dialAim.dragging === true;
  const dialHoverIndex = dialDragging ? dialAimIndex : dialHover;
  const dialActive = dialLayout.options[dialAimIndex] || dialLayout.options[0];
  // 长模式「接力新会话」= 团队重启语义（读出行与 title 标注；档位铭牌上另有「团队重启」副标）。
  const dialActiveHint = longMode === true && dialActive.value === "handoff" ? LONG_HANDOFF_HINT : dialActive.hint;
  const dialCommit = (index) => {
    const value = dialLayout.order[index];
    // 面板刚打开、入场摆动（700ms）还没播完就换档：先关掉入场动画，避免动画终点覆盖最短弧的 560ms 吸附。
    setDialNeedleSettled(true);
    // v0.2.19：从当前显示角按最短弧转到目标档（自动↔问我 300°→0° 走 +60°/−60°，不绕整圈）。
    const nextAngle = dialUnwrap(dialAngleRef.current === null ? dialNeedleDeg : dialAngleRef.current, dialAngleOf(index, dialCount));
    dialAngleRef.current = nextAngle;
    setDialNeedle(nextAngle);
    // 乐观预览：先让指针/读出行切到目标档（宿主回包后 effect 清理；失败 1.5s 兜底复位）。
    // dialBaseRef 同步记录意图，连按键盘/连续点档位都不等回包、也不会重复提交同一档。
    dialBaseRef.current = index;
    setDialAim({ angle: nextAngle, index, dragging: false });
    update(value === "auto"
      ? { autoChoose: true, defaultOperation: null }
      : { defaultOperation: value, autoChoose: false });
  };
  const dialRect = () => {
    const el = dialRootRef.current;
    if (el === null || typeof el.getBoundingClientRect !== "function") return null;
    const rect = el.getBoundingClientRect();
    return rect !== null && typeof rect === "object" && rect.width > 0 ? rect : null;
  };
  // 命中判定：按指针角度把整盘按档位数等分（classic 6×60° / long 4×90°）；返回距离中心距离用于轮毂死区。
  const dialHit = (event, rect) => {
    const scale = rect.width / DIAL_SIZE.width;
    const dx = event.clientX - (rect.left + DIAL_CENTER.x * scale);
    const dy = event.clientY - (rect.top + DIAL_CENTER.y * scale);
    return {
      angle: ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360,
      distance: Math.hypot(dx, dy) / scale,
    };
  };
  const dialPointerDown = (event) => {
    const rect = dialRect();
    if (rect === null) return;
    // 只接受主键：右键/中键不进入拖动也不选档（v0.2.19 点击即选档后必须挡住非主键）。
    if (typeof event.button === "number" && event.button !== 0) return;
    // 档位按钮自己处理点击；从按钮上按下不启动拖动（避免点选变拖拽）。
    const target = event === undefined || event === null ? null : event.target;
    if (target !== null && typeof target.closest === "function" && target.closest(".relay-v3-order") !== null) return;
    // 只记录起点：移动超过 5px 才进入拖动；没移动的按下-抬起 = 点击所在扇区选档（v0.2.19）。
    dialDragRef.current = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      started: false,
      angle: dialAngleRef.current === null ? dialNeedleDeg : dialAngleRef.current,
    };
    setDialNeedleSettled(true); // 入场动画未播完就开始拖动：直接定格，松手后不再重播
    try {
      if (dialRootRef.current !== null && typeof dialRootRef.current.setPointerCapture === "function") dialRootRef.current.setPointerCapture(event.pointerId);
    } catch { /* 无 pointer capture 的宿主退回普通事件 */ }
  };
  const dialPointerMove = (event) => {
    const rect = dialRect();
    if (rect === null) return;
    const drag = dialDragRef.current;
    const hit = dialHit(event, rect);
    if (drag === null) {
      // 悬停（未按下）：高亮指针所在扇区，提示「点扇区即选档」；轮毂死区不高亮。
      setDialHover(hit.distance < DIAL_DEAD_RADIUS ? null : Math.round(hit.angle / dialLayout.span) % dialCount);
      return;
    }
    if (drag.started !== true) {
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (dx * dx + dy * dy < 25) return;
      drag.started = true;
    }
    const angle = hit.angle;
    const nextAngle = dialUnwrap(drag.angle, angle);
    drag.angle = nextAngle;
    dialAngleRef.current = nextAngle;
    setDialHover(hit.distance < DIAL_DEAD_RADIUS ? null : Math.round(angle / dialLayout.span) % dialCount);
    setDialAim({ angle: nextAngle, index: Math.round(angle / dialLayout.span) % dialCount, dragging: true });
  };
  const dialPointerEnd = (event) => {
    const drag = dialDragRef.current;
    if (drag === null) return;
    dialDragRef.current = null;
    const rect = dialRect();
    const hit = rect === null || event === undefined || event === null ? null : dialHit(event, rect);
    // 中心轮毂死区：点/抓中心不选档（拖动仍可从中心开始，只是松手在中心不提交）。
    if (hit !== null && hit.distance < DIAL_DEAD_RADIUS) {
      setDialAim(null);
      setDialHover(null);
      return;
    }
    const index = hit === null ? dialCurrent() : Math.round(hit.angle / dialLayout.span) % dialCount;
    // 没超过 5px 的按下-抬起 = 点击扇区：扇区整盘平分，选中扇区所在档位。
    if (index === dialCurrent()) {
      const nextAngle = dialUnwrap(dialAngleRef.current === null ? dialNeedleDeg : dialAngleRef.current, dialAngleOf(index, dialCount));
      dialAngleRef.current = nextAngle;
      setDialNeedle(nextAngle);
      // 已意图但宿主尚未确认（PUT 未回 / 失败兜底窗口内）：保留意图与 1.5s 兜底定时器，
      // 否则清 aim 会清掉兜底、而 dialBaseRef 残留会让该档后续点击被静默吞掉。
      if (dialBaseRef.current !== null) {
        setDialAim({ angle: nextAngle, index, dragging: false });
        return;
      }
      setDialAim(null);
      return;
    }
    dialCommit(index);
  };
  const dialPointerCancel = () => {
    if (dialDragRef.current === null) return;
    dialDragRef.current = null;
    setDialAim(null);
  };
  const dialPointerLeave = () => {
    if (dialDragRef.current !== null) return;
    setDialHover(null);
  };
  const dialKeyDown = (event) => {
    if (event === undefined || event === null) return;
    const base = dialCurrent();
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
      : 0;
    const target = step !== 0 ? (base + step + dialCount) % dialCount
      : event.key === "Home" ? 0
      : event.key === "End" ? dialCount - 1
      : -1;
    if (target < 0) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof dialOrderRefs.current[target]?.focus === "function") dialOrderRefs.current[target].focus();
    if (target !== base) dialCommit(target);
  };
  const dialNode = h("div", { className: "relay-v3-dial-wrap" },
    h("div", { className: "relay-v3-dial-head" },
      h("span", { className: "relay-v3-dial-head-title" }, longMode === true ? "默认模式 · 超长任务" : "默认模式")),
    h("div", {
      ref: dialRootRef,
      className: "relay-v3-dial",
      role: "radiogroup",
      "aria-label": "默认模式（表盘档位）",
      onPointerDown: dialPointerDown,
      onPointerMove: dialPointerMove,
      onPointerUp: dialPointerEnd,
      onPointerCancel: dialPointerCancel,
      onPointerLeave: dialPointerLeave,
      onKeyDown: dialKeyDown,
    },
      h("div", { className: "relay-v3-dial-face", "aria-hidden": "true" }),
      h("svg", { className: "relay-v3-dial-gauge", viewBox: "0 0 " + DIAL_SIZE.width + " " + DIAL_SIZE.height, "aria-hidden": "true", focusable: "false" },
        h("defs", null,
          h("radialGradient", { key: "cold", id: "relay-v3-dial-coldglow" },
            h("stop", { offset: "0", stopColor: "#bfe8f7", stopOpacity: "0.12" }),
            h("stop", { offset: "0.62", stopColor: "#7fe6ff", stopOpacity: "0.04" }),
            h("stop", { offset: "1", stopColor: "#000000", stopOpacity: "0" })),
          h("linearGradient", { key: "lit", id: "relay-v3-dial-lit", x1: "0", y1: "1", x2: "0", y2: "0" },
            h("stop", { offset: "0", stopColor: "#cdeffc", stopOpacity: "0.05" }),
            h("stop", { offset: "0.55", stopColor: "#a9e2f7", stopOpacity: "0.12" }),
            h("stop", { offset: "1", stopColor: "#eafaff", stopOpacity: "0.22" }))),
        // ① 唯一光源 = 穹顶内部的冷背光（不是彩窗）
        h("circle", { key: "backlight", className: "relay-v3-dial-backlight", cx: DIAL_CENTER.x, cy: DIAL_CENTER.y, r: DIAL_RADII.wallIn, fill: "url(#relay-v3-dial-coldglow)" }),
        // ② 一跨 = 档位区间（冷光提亮层，压在结构线下面；平时几乎不可见）
        h("g", { key: "bays", className: "relay-v3-dial-bays" },
          ...dialLayout.sectors.map((sector) => h("path", {
            key: "bay-" + String(sector.option.value),
            className: "relay-v3-dial-sector"
              + (sector.index === dialAimIndex ? " relay-v3-dial-sector-on" : "")
              + (sector.index === dialHoverIndex ? " relay-v3-dial-sector-hover" : ""),
            d: sector.d,
          }))),
        // ③ 冷灰结构骨架：放射肋 / 券环 / 穹顶网格 / 石墙（双线）/ 墙身石缝 / 尖拱山花冠 / 尖顶饰 / 四角飞扶壁
        h("g", { key: "structure", className: "relay-v3-dial-structure" },
          ...dialLayout.rings.map((ring) => h("path", { key: ring.key, className: "relay-v3-dial-arc" + (ring.key === "wall-out" ? " relay-v3-dial-arc-hi" : ""), d: ring.d })),
          ...dialLayout.ribs.map((rib) => h("path", { key: "rib-" + rib.key, className: "relay-v3-dial-rib" + (rib.main ? " relay-v3-dial-rib-main" : ""), d: rib.d })),
          ...dialLayout.liernes.map((lierne) => h("path", { key: "lierne-" + lierne.key, className: "relay-v3-dial-lierne", d: lierne.d })),
          ...dialLayout.wallHatch.map((hatch) => h("path", { key: "hatch-" + hatch.key, className: "relay-v3-dial-course", d: hatch.d })),
          ...dialLayout.gables.map((gable) => h("path", { key: "gable-" + gable.key, className: "relay-v3-dial-gable", d: gable.d })),
          ...dialLayout.finials.map((finial) => h("path", { key: "finial-" + finial.key, className: "relay-v3-dial-finial", d: finial.d })),
          ...dialLayout.buttresses.map((buttress) => h("path", { key: "buttress-" + buttress.key, className: "relay-v3-dial-buttress", d: buttress.d })),
          // 中心 = 束柱平面（八角柱截面 + 柱身刻线 + 拱心石）
          h("g", { key: "hub", className: "relay-v3-dial-hub" },
            h("path", { key: "hub-octagon", className: "relay-v3-dial-hub-ring", d: dialLayout.hub }),
            ...dialLayout.hubTicks.map((tick) => h("path", { key: "shaft-" + tick.key, className: "relay-v3-dial-hub-shaft", d: tick.d })),
            h("circle", { key: "hub-core", className: "relay-v3-dial-hub-core", cx: DIAL_CENTER.x, cy: DIAL_CENTER.y, r: 5 }),
            h("circle", { key: "hub-dot", className: "relay-v3-dial-hub-core-dot", cx: DIAL_CENTER.x, cy: DIAL_CENTER.y, r: 1.5 }))),
        // ④ 冷光肋线：中心 → 墙墩节点（选中时点亮，光沿放射肋流动）
        h("g", { key: "rays", className: "relay-v3-dial-rays" },
          ...dialLayout.seats.map((seat) => h("path", {
            key: "ray-" + String(seat.option.value),
            className: "relay-v3-dial-ray" + (seat.index === dialAimIndex ? " relay-v3-dial-ray-on" : ""),
            d: seat.ray,
          }))),
        // ⑤ 节点 → 铭牌的拉杆（选中时勾边冷光）
        h("g", { key: "ties", className: "relay-v3-dial-ties" },
          ...dialLayout.seats.map((seat) => h("path", {
            key: "tie-" + String(seat.option.value),
            className: "relay-v3-dial-tie" + (seat.index === dialAimIndex ? " relay-v3-dial-tie-on" : ""),
            d: seat.tie,
          }))),
        // ⑥ 档位节点 = 墙墩上的菱形石雕凸饰
        h("g", { key: "pips", className: "relay-v3-dial-pips" },
          ...dialLayout.seats.map((seat) => h("path", {
            key: "pip-" + String(seat.option.value),
            className: "relay-v3-dial-pip" + (seat.index === dialAimIndex ? " relay-v3-dial-pip-on" : ""),
            d: seat.pip,
          })))),
      // ⑦ 赛博只落在结构上：盘面扫描线 + 缓慢下移的全息扫描带（只在盘面圆内）
      h("div", { className: "relay-v3-dial-scan", "aria-hidden": "true" },
        h("span", { key: "scanlines", className: "relay-v3-dial-scanlines" }),
        h("span", { key: "sweep", className: "relay-v3-dial-sweep" })),
      // ⑧ 指针 = 照准仪（alidade）：菱形垂尖 + 细冷钢针 + 两格刻度 + 四叶配重 + 中心枢轴；光沿针上移
      h("div", {
        className: "relay-v3-dial-needle" + (dialNeedleSettled ? " relay-v3-dial-needle-settled" : "") + (dialDragging ? " relay-v3-dial-needle-dragging" : ""),
        style: { transform: "rotate(" + dialNeedleDeg + "deg)", "--dial-to": dialSigned(dialNeedleDeg) + "deg" },
        "aria-hidden": "true",
        onAnimationEnd: () => setDialNeedleSettled(true),
      },
        h("svg", { key: "alidade", className: "relay-v3-dial-alidade", viewBox: "0 0 26 132", "aria-hidden": "true", focusable: "false" },
          h("defs", null,
            h("linearGradient", { key: "steel", id: "relay-v3-needle-steel", x1: "0", y1: "0", x2: "1", y2: "0" },
              h("stop", { offset: "0", stopColor: "#43545f" }),
              h("stop", { offset: "0.5", stopColor: "#d8edf7" }),
              h("stop", { offset: "1", stopColor: "#52646f" }))),
          h("path", { key: "fin", className: "relay-v3-dial-alidade-fin", d: "M13 6 L15.6 22 L13 29 L10.4 22 Z" }),
          h("path", { key: "rule", className: "relay-v3-dial-alidade-rule", d: "M12.1 29 L13.9 29 L13.5 92 L12.5 92 Z" }),
          h("path", { key: "graduation", className: "relay-v3-dial-alidade-graduation", d: "M13.7 40 L16.4 40 M13.6 45 L15.8 45" }),
          h("path", { key: "tail", className: "relay-v3-dial-alidade-tail", d: "M13 92 L13 104" }),
          h("g", { key: "counterweight", className: "relay-v3-dial-alidade-tail relay-v3-dial-alidade-counterweight" },
            h("circle", { key: "cw-up", cx: 13, cy: 104, r: 2.2 }),
            h("circle", { key: "cw-right", cx: 17.5, cy: 108, r: 2.2 }),
            h("circle", { key: "cw-down", cx: 13, cy: 112, r: 2.2 }),
            h("circle", { key: "cw-left", cx: 8.5, cy: 108, r: 2.2 })),
          h("circle", { key: "pivot", className: "relay-v3-dial-alidade-pivot", cx: 13, cy: 96, r: 4 })),
        h("span", { key: "flow", className: "relay-v3-dial-needle-flow" })),
      h("div", { key: "ping-" + dialAimIndex, className: "relay-v3-dial-ping", "aria-hidden": "true" }),
      ...dialLayout.seats.map((seat) => {
        const on = seat.index === dialAimIndex;
        // 长模式的「接力新会话」= 团队重启：冷石铭牌加副标（title/hint 也写明）。
        const teamRestart = longMode === true && seat.option.value === "handoff";
        return h("button", {
          key: String(seat.option.value),
          type: "button",
          role: "radio",
          "aria-checked": on,
          tabIndex: seat.index === dialAimIndex ? 0 : -1,
          className: "relay-v3-order" + (on ? " relay-v3-order-on" : "") + (seat.index === dialHoverIndex ? " relay-v3-order-hover" : "")
            // v0.3.3：模型推荐档位加「荐」高亮（长模式隐藏档不在 layout 里 → 不点档位，只显示推荐行）。
            + (recommendation !== null && seat.option.value === recommendation.operation ? " relay-v3-order-recommend" : ""),
          style: { left: seat.left, top: seat.top, animationDelay: seat.index * 26 + "ms" },
          title: teamRestart ? LONG_HANDOFF_TITLE : optionText(seat.option, true),
          ref: (node) => { dialOrderRefs.current[seat.index] = node; },
          onClick: () => { if (seat.index !== dialCurrent()) dialCommit(seat.index); },
        },
          h("span", { key: "key", className: "relay-v3-order-key", "aria-hidden": "true" }),
          teamRestart
            ? h("span", { className: "relay-v3-order-stack" },
                h("span", { key: "name", className: "relay-v3-order-name" }, dialSeatLabel(seat.option)),
                h("span", { key: "tag", className: "relay-v3-order-tag" }, "团队重启"))
            : dialSeatLabel(seat.option),
          recommendation !== null && seat.option.value === recommendation.operation
            ? h("span", {
              key: "recommend",
              className: "relay-v3-order-recommend-tag",
              title: "模型推荐：" + operationLabelOf(recommendation.operation),
            }, "荐")
            : null);
      })),
    h("div", { className: "relay-v3-dial-readout" },
      h("div", { key: "readout-main-" + dialAimIndex, className: "relay-v3-dial-readout-main" }, dialActive.label),
      h("div", { key: "readout-hint-" + dialAimIndex, className: "relay-v3-dial-readout-hint" }, dialActiveHint)));
  // 精简状态行：上下文比例 + 已压缩次数（缺失显示「—」）。
  const statusText = "上下文 " + (pct === null ? "?" : pct) + "% · 已压缩 " + (organizeCount === null ? "—" : organizeCount) + " 次";
  // 百分比数字单独成节点、按「整数变化」重挂载 → 160ms 淡入（不随 4s 轮询的小数抖动闪）。
  const pctKey = "pct-" + (pct === null ? "?" : Math.round(pct));
  const chipTail = over ? " · 已到线" : "";
  const authorized = panel.authorizeNext === true;
  // 两个自动授权都开 = 压缩与新会话执行都免审 → chip 光点转绿并轻呼吸，表示「已无待授权项」。
  const bothAuthorized = panel.autoCompress === true && panel.autoHandoff === true;
  // title 只给事实：band / phase / 已压缩次数 / 模型决定时间（无 reason，R4）/ 授权状态。
  const titleText = "接力面板 · " + (liveKnown
    ? "band " + String(live.band || "ok") + " · phase " + String(live.phase || "-") + " · 已压缩 " + (organizeCount === null ? "—" : organizeCount) + " 次"
    : "实时状态暂不可得（宿主载入该会话后自动刷新）")
    + (decision ? " · 模型决定 " + chipLabel(decision.operation) + " " + decisionTimeText(decision.at) : "")
    + (recommendation === null ? "" : " · 模型推荐 " + operationLabelOf(recommendation.operation))
    + " · 授权下一次：" + (authorized ? "已授权" : "未授权")
    + " · 自动压缩：" + (panel.autoCompress === true ? "开" : "关")
    + " · 自动接力：" + (panel.autoHandoff === true ? "开" : "关")
    + "（点击展开）";

  const portalHost = createPortal !== null && typeof document !== "undefined" && document.body !== undefined && document.body !== null ? document.body : null;
  const panelNode = (open || closing) && layout !== null ? h("div", {
      ref: popRef,
      className: "relay-v3-popover" + (closing ? " relay-v3-popover-closing" : ""),
      style: {
        ...popover,
        left: layout.left,
        bottom: layout.bottom,
        width: layout.width,
        maxHeight: layout.maxHeight,
        ...(closing ? { pointerEvents: "none" } : {}),
      },
      role: "dialog",
      "aria-label": "接力面板",
    },
      h("div", { style: popTitle }, "上下文接力 · 本会话"),
      h("div", { style: dim }, statusText),
      // v0.3.3：模型推荐行（statusText 之后、表盘之前）：只做高亮/参考，不改模式、不自动执行。
      recommendation === null ? null : h("div", { className: "relay-v3-recommend", title: "模型推荐（只做面板高亮/参考；最终仍按模式/人类决定，不会自动执行压缩/接力）" },
        h("span", { key: "tag", className: "relay-v3-rec-tag" }, "模型推荐"),
        h("span", { key: "op", className: "relay-v3-rec-op" }, operationLabelOf(recommendation.operation)),
        recommendation.reason === ""
          ? null
          : h("span", { key: "reason", className: "relay-v3-rec-reason", title: recommendation.reason }, recommendation.reason.slice(0, 60)),
        h("span", { key: "time", className: "relay-v3-rec-time" }, decisionTimeText(recommendation.at))),
      liveKnown ? null : h("div", { style: dim }, "实时状态暂不可得：宿主尚未载入该会话的上下文状态；载入后自动刷新（无需发送消息）。"),
      // v0.2.18/v0.4.0：默认模式 = 车钟表盘（经典 6 档 / 超长任务 4 档；模式持久不消费）。
      dialNode,
      // v0.2.14：下一个接力新会话的模式（滑动开关）放在操作选项之后、自动授权开关之前。
      handoffModeNode,
      tankRow("压缩操作自动授权（autoCompress）", panel.autoCompress, (value) => update({ autoCompress: value }), "blue"),
      tankRow("开新会话自动授权（autoHandoff）", panel.autoHandoff, (value) => update({ autoHandoff: value }), "green"),
      // v0.2.8：交接后新会话是否注入「预算无上限」；v0.2.20 与两个自动授权同款水缸按钮（樱花红），
      // null 时展示本会话当前设置（跟随），点击后写显式 true/false。
      tankRow("新会话注入「预算无上限」", handoffBudgetOn(panel), (value) => update({ handoffUnlimitedBudget: value }), "sakura"),
      // 权威口径（单一真源）：模式只决定做什么，不产生审批豁免；免审只来自三个授权。
      h("div", { style: { ...dim, lineHeight: "16px" } }, "模式在本会话持久（不消费），只决定到线时「做什么」，不产生审批豁免；免审只来自 autoCompress / autoHandoff / authorizeNext（一次性，操作成功后消费）；接力后模式由新会话继承。"),
      // 最显眼的授权按钮放最下面：自动授权之后、底部状态行之前。
      // v0.2.30：按钮内加 aria-hidden canvas（铺满按钮、z-index 低于文字）= v0.2.29 canvas 水面引擎的新挂载点：
      // 未授权（黄）= 空缸；点击授权 → 绿色水面注满（与按钮 300ms 黄→绿 crossfade 同时）；再点取消 → 排空。
      // popover 每次打开会重挂载：已授权时引擎以 on=true 建视图 → 直接呈满水终态（不重放注水，与 v0.2.29 契约一致）。
      h("button", {
        type: "button",
        "aria-pressed": authorized,
        className: "relay-v3-auth relay-v3-ripple" + (authorized ? " relay-v3-auth-on" : ""),
        title: authorized ? "已授权：下一次 relay 操作（压缩或新会话）免官方审批，操作成功后消费（点击取消）" : "未授权：下一次 relay 操作仍需官方审批（点击授权，操作成功后消费）",
        onClick: () => update({ authorizeNext: !authorized }),
      },
        h("canvas", { className: "relay-v3-auth-canvas", "aria-hidden": "true", ref: tankWaterRef("green", authorized) }),
        h("span", { className: "relay-v3-auth-text" }, authorized ? "✓ 已授权下一次操作" : "授权下一次操作")),
      error || status ? h("div", { style: dim }, error || status) : null) : null;
  // v0.2.21：本会话「预算无上限」开启（且是 relay 会话）→ 接力 chip 亮独角兽电路纹 + 红色火星；
  // 只有「已到线」才压深红底 + 红光/呼吸/火星，平时只留纹路、不发光（胶囊本身外观不动）。
  const budgetUnicorn = data.relay === true && panel.unlimitedBudget !== false;
  const chipBaseStyle = over ? chipOver : chip;
  const unicornStyle = over ? unicornChipOverStyle : unicornChipStyle;
  const chipNode = h("button", {
      type: "button",
      className: "relay-v3-chip" + (over ? " over-pulse" : "") + (budgetUnicorn ? " relay-v3-chip-unicorn" : "")
        + (budgetUnicorn && over ? " relay-v3-chip-unicorn-glow" : ""),
      style: budgetUnicorn ? { ...chipBaseStyle, ...unicornStyle } : chipBaseStyle,
      title: titleText,
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      onClick: () => {
        if (open) { closePanel(); return; }
        openPanel(computeLayout());
      },
    },
      h("span", { key: "lead" }, "接力 "),
      h("span", { key: pctKey, className: "relay-v3-pct" }, pct === null ? "?" : String(pct)),
      h("span", { key: "pct-unit" }, "% · "),
      h("span", {
        key: "dot-" + (bothAuthorized ? "breathe" : authorized ? "on" : "off"),
        className: "relay-v3-dot relay-v3-dot-pop "
          + (bothAuthorized ? "relay-v3-dot-breathe" : authorized ? "relay-v3-dot-on" : "relay-v3-dot-off"),
        title: bothAuthorized
          ? "压缩与新会话均已自动授权：执行免官方审批（绿色呼吸灯）"
          : authorized ? "授权下一次操作：已授权（下一次 relay 操作免官方审批）" : "授权下一次操作：未授权（下一次 relay 操作仍需官方审批）",
      }),
      // 操作标签紧跟光点（flex-shrink + max-width + ellipsis 兜底），两个图标殿后。
      // key 随操作标签变化 → 重挂载触发 relay-v3-next 180ms 淡入（不随 pct 轮询抖动）。
      h("span", { key: modeBadge.shimmer ? "auto" : modeBadge.label, className: "relay-v3-next" },
        modeBadge.shimmer ? h("span", { className: "relay-v3-auto" }, modeBadge.label) : modeBadge.label),
      h("span", {
        className: "relay-v3-badge " + (panel.autoCompress === true ? "relay-v3-badge-compress-on" : "relay-v3-badge-off"),
        title: "压缩自动授权：" + (panel.autoCompress === true ? "开" : "关"),
      }, flagIcon("compress")),
      h("span", {
        className: "relay-v3-badge " + (panel.autoHandoff === true ? "relay-v3-badge-handoff-on" : "relay-v3-badge-off"),
        title: "新会话自动授权：" + (panel.autoHandoff === true ? "开" : "关"),
      }, flagIcon("handoff")),
      chipTail,
      // 红色火星：三颗小火花在 chip 内向上飘散（仅预算无上限开启 + 已到线；CSS 动画驱动，reduced-motion 隐藏）。
      budgetUnicorn && over ? h("span", { className: "relay-v3-unicorn-sparks", "aria-hidden": "true" },
        h("span", { key: "spark-a", className: "relay-v3-unicorn-spark" }),
        h("span", { key: "spark-b", className: "relay-v3-unicorn-spark" }),
        h("span", { key: "spark-c", className: "relay-v3-unicorn-spark" })) : null);

  return h("div", { ref: rootRef, style: { order: 1, position: "relative" } },
    chipNode,
    // portal 到 body：面板才能采样页面真实背景做毛玻璃，也不被 dock 的层叠/裁剪影响。
    portalHost !== null && panelNode !== null ? createPortal(panelNode, portalHost) : panelNode);

}

// ── composer 工具行：模型选择器右侧「预算无上限」小胶囊（v0.2.7，按会话）────────
// 注册在 conversation.input.right（list 槽；槽锚点是 display:contents → 组件根按钮直接是
// .standardControls 的 flex item，order:1 排到模型选择器（默认 order:0）右侧）。
// 不能注册 conversation.input.activity：官方 voice-input 占用该 single 槽，二次注册会互相遮蔽。
const budgetDotOn = { width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: "#2da44e", boxShadow: "0 0 0 2px rgba(45,164,78,.30), 0 0 7px 1px rgba(45,164,78,.55)" };
const budgetDotOff = { width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: "#8b949e" };

function RelayBudgetToggle(props) {
  const sessionId = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : "";
  // on: null = 未加载/非 relay 会话（不渲染）；true/false = 本会话注入开/关。
  const [on, setOn] = React.useState(null);
  const [error, setError] = React.useState("");
  // B-P2-10：host 回 persisted:false 时内存值生效但重启会丢 → ⚠ + title 提示（下一次成功落盘后清除）。
  const [notPersisted, setNotPersisted] = React.useState(false);
  const sidRef = React.useRef(sessionId);
  sidRef.current = sessionId;
  // §3.6 写入优先：PUT 成功后记录时间，发起早于最近一次写入的旧 GET 回包丢弃（与 RelayPanel 同保护）。
  const lastWriteAtRef = React.useRef(0);
  const load = React.useCallback(() => {
    if (sessionId === "" || document.visibilityState === "hidden") return;
    const startedAt = Date.now();
    fetch(PANEL_API + "?sessionId=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" }, cache: "no-store" })
      .then((res) => res.json())
      .then((next) => {
        if (!next || next.ok === false || sidRef.current !== sessionId) return;
        // 请求发出早于最近一次 PUT 成功 → 丢弃这份可能回滚刚点开关的旧快照。
        if (startedAt < lastWriteAtRef.current) return;
        // 非 relay preset 会话不显示该胶囊（注入功能只存在于 relay preset 的 agent 平面）。
        if (next.relay !== true) { setOn(null); return; }
        setOn(!next.panel || next.panel.unlimitedBudget !== false);
        // 轮询成功说明宿主可读：清掉上一次保存失败的错误（title 不长期残留；persisted 告警单独保留）。
        setError("");
      })
      .catch(() => { /* 下次轮询再试 */ });
  }, [sessionId]);
  React.useEffect(() => {
    if (sessionId === "") { setOn(null); return undefined; }
    setOn(null);
    setError("");
    setNotPersisted(false);
    lastWriteAtRef.current = 0;
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [sessionId, load]);
  const toggle = () => {
    if (on === null || sessionId === "") return;
    const nextOn = on !== true;
    lastWriteAtRef.current = Date.now();
    setOn(nextOn);
    setError("");
    fetch(PANEL_API, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sessionId, unlimitedBudget: nextOn }),
    })
      .then((res) => res.json())
      .then((next) => {
        if (sidRef.current !== sessionId) return;
        if (next && next.ok) {
          // PUT 成功时间之后发出的 GET 才可信；显式处理 persisted:false（不谎报「已保存」）。
          lastWriteAtRef.current = Date.now();
          setOn(!next.panel || next.panel.unlimitedBudget !== false);
          setNotPersisted(next.persisted === false);
          setError("");
        } else { setOn(!nextOn); setError((next && next.message) || "保存失败"); }
      })
      .catch(() => { if (sidRef.current === sessionId) { setOn(!nextOn); setError("保存失败"); } });
  };
  if (on === null) return null;
  const warning = notPersisted ? "已保存但未写入磁盘（重启后会丢失）" : "";
  const title = (on === true ? "本会话注入「你的 token 预算无上限」：开（点击关闭）" : "本会话注入「你的 token 预算无上限」：关（点击开启）")
    + (warning === "" ? "" : "；" + warning)
    + (error === "" ? "" : "；" + error);
  return h("button", {
    type: "button",
    className: "relay-v3-chip relay-v3-ripple",
    "aria-pressed": on === true,
    "aria-label": "本会话注入「你的 token 预算无上限」",
    title,
    style: { ...chip, order: 1, ...(on === true ? {} : { color: "var(--dsw-alias-label-caption, #8b949e)" }) },
    onClick: toggle,
  },
    h("span", { style: on === true ? budgetDotOn : budgetDotOff }),
    h("span", { key: on === true ? "on" : "off", style: on === true ? undefined : { textDecoration: "line-through" } }, "预算无上限"),
    notPersisted ? h("span", { key: "warn", style: { color: "var(--dsw-alias-state-warning-primary, #9a6700)" }, title: warning }, "⚠") : null);
}

function apply(ctx) {
  appCtx = ctx;
  ensurePanelCss();
  // Plugins 页 → relay 卡片的配置表单（key = bundle 包名）。
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: "dsh-context-relay",
  }, RelaySettings));
  // composer 工具行 → 模型选择器右侧的「预算无上限」小胶囊（v0.2.7，按会话；只显示 relay preset 会话）。
  ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
    name: "conversation.input.right",
    id: "relay-budget-toggle",
    order: 10,
    inject: (sessionId) => ({ sessionId }),
  }, RelayBudgetToggle));
  // 输入框下方 dock 的接力面板（order:1 排在 ContextMeter 右侧）。先于提示条注册，
  // 让提示条保持「最后注册」的既有语义（client-notice 测试按此取组件）。
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
    name: "conversation.composer.dock",
    id: "relay-panel",
    order: 1,
    inject: (sessionId) => ({ sessionId }),
  }, RelayPanel));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "relay-notice",
    order: 15,
  }, DockEntry));
  ctx.effect(() => {
    poll();
    const timer = setInterval(poll, POLL_MS);
    const onVisible = () => poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, "dsh-context-relay: handoff poll");
}

exports.apply = apply;
exports.inject = ["slots", "sessions", "uiWorkspace"];
return module.exports; } });

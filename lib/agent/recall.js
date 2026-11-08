/**
 * dsh-context-relay — 压缩后手动召回清单（A+B）。
 *
 * 官方压缩只自动重注入三类持久上下文（runtime-context / AGENTS.md 基线 / skill 目录）；
 * 以下两类状态型内容被遮蔽后官方不会恢复（2026-11-08 实测：55 次压缩 0 次自动恢复附加指令）：
 *   1) touch 发现的附加 AGENTS.md（agent-instructions 非 baseline 消息）——再 read 该文件可触发重注入；
 *   2) 已加载 skill 的完整指令（skill-invocation 消息 / skill 工具结果）——官方语义是「保留到压缩」，
 *      需要时重新调用 skill({name}) 加载。
 * 本模块只从会话事件日志派生「已被遮蔽」的指针（路径 / skill 名），不重放全文；
 * 有界（默认每类 ≤8 条、整段 ≤900 字符）且任何异常都降级为空串（绝不阻断压缩后的 brief 注入）。
 *
 * @module dsh-context-relay/agent/recall
 */
import { contentText } from './shared.js';

export const MANUAL_RECALL_HEADER = '## 压缩后手动召回（插件生成）';
export const MANUAL_RECALL_MAX_ITEMS = 8;
export const MANUAL_RECALL_MAX_CHARS = 900;
/** 单条指针上限（路径/名字），防止一条超长路径吃掉整段预算。 */
const INSTRUCTION_PATH_MAX = 160;
const SKILL_NAME_MAX = 80;
/** 官方 skill 指令块的模型可见开头（见 @deepseek-ai/dsh-skill 的 renderSkillContent）。 */
const SKILL_CONTENT = /^<skill_content name="([^"]+)"/;

function clip(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return Array.from(text).length <= max ? text : Array.from(text).slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** 会话事件日志（快照）；无/抛错返回空数组（降级，不阻断压缩流程）。 */
function eventsOf(session) {
  try {
    if (typeof session?.snapshotEvents !== 'function') return [];
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events : [];
  } catch { return []; }
}

/** 当前 surface 可见节点 seq 集合；没有 surface（fake/旧宿主）返回 undefined＝不做可见性过滤。 */
function visibleSeqs(session) {
  try {
    const nodes = session?.surface?.nodes;
    return Array.isArray(nodes) ? new Set(nodes) : undefined;
  } catch { return undefined; }
}

function seqOf(event, index) {
  return typeof event?.seq === 'number' ? event.seq : index;
}

/**
 * 从日志派生「已被压缩遮蔽、官方不会自动恢复」的两类指针（新→旧，去重）。
 * @param {object} session DSH 会话（snapshotEvents / 可选 surface.nodes）。
 * @param {{maxItems?: number}} [options] 每类最多保留条数（默认 8）。
 * @returns {{instructions: string[], skills: string[], omitted: {instructions: number, skills: number}}}
 */
export function collectShadowedContext(session, { maxItems = MANUAL_RECALL_MAX_ITEMS } = {}) {
  const events = eventsOf(session);
  const visible = visibleSeqs(session);
  const limit = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : MANUAL_RECALL_MAX_ITEMS;
  const instructions = [];
  const skills = [];
  const seenInstructions = new Set();
  const seenSkills = new Set();
  let omittedInstructions = 0;
  let omittedSkills = 0;
  const addInstruction = (path) => {
    if (path === '' || seenInstructions.has(path)) return;
    seenInstructions.add(path);
    if (instructions.length < limit) instructions.push(path);
    else omittedInstructions += 1;
  };
  const addSkill = (name) => {
    if (name === '' || seenSkills.has(name)) return;
    seenSkills.add(name);
    if (skills.length < limit) skills.push(name);
    else omittedSkills += 1;
  };
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const seq = seqOf(event, index);
    if (visible !== undefined && visible.has(seq)) continue;
    if (event?.type === 'user/message') {
      const source = event.data?.source;
      if (source !== null && typeof source === 'object' && source.kind === 'agent-instructions' && source.baseline !== true) {
        const changes = Array.isArray(source.changes) ? source.changes : [];
        for (const change of changes) {
          if (change?.action === 'remove') continue;
          addInstruction(clip(change?.path, INSTRUCTION_PATH_MAX));
        }
      }
      if (source !== null && typeof source === 'object' && source.kind === 'skill-invocation') addSkill(clip(source.name, SKILL_NAME_MAX));
      continue;
    }
    if (event?.type === 'tool/result') {
      const match = SKILL_CONTENT.exec(contentText(event.data?.message?.content).trimStart());
      if (match !== null) addSkill(clip(match[1], SKILL_NAME_MAX));
      continue;
    }
    // PTC（run_code 转发）形态：内层工具结果是 tool/ptc-dispatch，content 直接是结果块（本机实测）。
    if (event?.type === 'tool/ptc-dispatch' && event.data?.isError !== true) {
      const match = SKILL_CONTENT.exec(contentText(event.data?.content).trimStart());
      if (match !== null) addSkill(clip(match[1], SKILL_NAME_MAX));
    }
  }
  return { instructions, skills, omitted: { instructions: omittedInstructions, skills: omittedSkills } };
}

/**
 * 渲染压缩后注入的「手动召回」段。空清单不注入空段（返回 ''）。
 * 只给指针与重新获取方式：附加指令用 read 重读（触发 dsh-agent-instructions 重注入所在 scope）；
 * skill 用 skill({name}) 重载（官方 skill 目录压缩后会自动重新发布）。
 * @param {{session: object, maxItems?: number, maxChars?: number}} options
 * @returns {string}
 */
export function buildManualRecallSection({ session, maxItems = MANUAL_RECALL_MAX_ITEMS, maxChars = MANUAL_RECALL_MAX_CHARS } = {}) {
  let collected;
  try { collected = collectShadowedContext(session, { maxItems }); } catch { return ''; }
  const { instructions, skills, omitted } = collected;
  if (instructions.length === 0 && skills.length === 0) return '';
  const lines = [
    MANUAL_RECALL_HEADER,
    '- 以下内容已被本次压缩遮蔽，DSH 不会自动重注入；需要时按指针重新获取：',
  ];
  if (instructions.length > 0) {
    const extra = omitted.instructions > 0 ? '（另有 ' + omitted.instructions + ' 条未列出）' : '';
    lines.push('- 附加工作区指令（用 read 重新读取对应文件即可触发重注入）：' + instructions.join('、') + extra);
  }
  if (skills.length > 0) {
    const extra = omitted.skills > 0 ? '（另有 ' + omitted.skills + ' 个未列出）' : '';
    lines.push('- 已加载 skill（继续遵循时重新调用 skill({name}) 加载）：' + skills.join('、') + extra);
  }
  const text = lines.join('\n');
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MANUAL_RECALL_MAX_CHARS;
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…';
}

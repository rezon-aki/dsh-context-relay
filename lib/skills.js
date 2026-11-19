/**
 * dsh-context-relay — 随包技能目录（SKILL.md → ctx.skills.register 定义）。
 *
 * 全局 vs 角色（w5 角色注入裁剪，审计 §2.6.4 / Q8=C）：
 *   host 的 SkillRegistry.register 把注册落到「调用方 ctx 的 scope 层」（dsh-skill/lib/index.js:
 *   register() 取 scopeOf(this.ctx)；agent preset 的 standing mount ctx 注册只对该 scope 可见，
 *   读时合并 global 层 + 观看 scope 链）。skills 没有 tools.restrict 那样的 deny 能力，
 *   所以角色专属技能只能「不全局注册 + 在 agent scope 注册」：
 *     - 全局：context-relay / doc-governance（非 relay 会话仍可用）；
 *     - 角色：human-loop（只有 relay Lead；子智能体不该向用户提问，见 plane/roles.js）。
 *
 * @module dsh-context-relay/skills
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 全局注册的技能（顺序即注册顺序；其余技能按 ROLES[role].skills 在 agent scope 注册）。 */
export const GLOBAL_SKILL_NAMES = Object.freeze(['context-relay', 'doc-governance']);

/**
 * 读 skills/<name>/SKILL.md → skills.register 定义；文件/前置元数据缺失返回 undefined
 * （调用方按降级处理，不阻断会话）。
 * @param {string} name 技能目录名（= 注册名）
 * @returns {{name: string, description: string, content: string, invocation: {modelInvocable: boolean, userInvocable: boolean}}|undefined}
 */
export function skillDefinitionOf(name) {
  let text;
  try { text = readFileSync(join(PKG_ROOT, 'skills', String(name), 'SKILL.md'), 'utf8'); } catch { return undefined; }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (match !== null) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
      if (kv !== null) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') return undefined;
  return {
    name: meta.name,
    description: meta.description,
    content: (match === null ? text : text.slice(match[0].length)).trim(),
    invocation: { modelInvocable: meta['disable-model-invocation'] !== 'true', userInvocable: true },
  };
}

/**
 * 验证风险分级（设计：relay-audit §2.5.2 / §2.5.3）。
 *
 * 纯函数模块：分类建议、去重键、文档哈希；不做 IO、不读时间。
 * 口径：
 *   T0 文档/琐碎  — 不改运行时行为、不改公开契约、可逆；典型：docs/**、README、注释、纯文案，diff ≤20 行。
 *   T1 局部代码  — 单模块、可逆、有测试；1–3 个源文件、≤300 行；不碰 preset/seam/状态文件格式。
 *   T2 高风险    — 工具 schema/返回契约、preset/seam、数据格式、权限/审批、迁移/删除/外部副作用、跨 5+ 文件或 >300 行。
 * 自动升级优先：任何 lib/** 代码 → ≥T1；公开面/数据/权限/不可逆 → T2；无法判定 → T2（保守）。
 * @module dsh-context-relay/risk
 */
import { createHash } from 'node:crypto';

export const RISK_TIERS = Object.freeze(['T0', 'T1', 'T2']);
const TIER_RANK = Object.freeze({ T0: 0, T1: 1, T2: 2 });

/** 文档类路径（docs/、architecture/、README、CHANGELOG 等）。 */
const DOC_PATH = /(^|\/)(docs?|architecture|research|decisions|reports?|archive)\//i;
const DOC_FILE = /(^|\/)(readme|changelog|license|agents|notice)[^/]*\.md$/i;
const CODE_PATH = /\.(js|mjs|cjs|ts|tsx|jsx|json|ya?ml|sh)$/i;
const LIB_CODE = /(^|\/)(lib|src)\//i;
const PUBLIC_SURFACE = /(^|\/)(package\.json|lib\/index\.js|lib\/agent\/tools\.js|preset|schema|settings|permissions?|approval|hook|seam)/i;

const hash16 = (text) => createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);

const isString = (value) => typeof value === 'string';

/** 是否文档类改动（T0 候选）。 */
export function isDocPath(path) {
  const value = String(path ?? '');
  if (value === '') return false;
  return DOC_PATH.test(value) || DOC_FILE.test(value) || (!CODE_PATH.test(value) && value.endsWith('.md'));
}

/** 文档/研究条目标题（T1 done-gate「文档条目 evidence 即可」用）。 */
export function isDocItem(title) {
  return /文档|README|readme|研究|调研|报告|回执|设计稿|注释|文案|docs?\//.test(String(title ?? ''));
}

/**
 * 分类建议（纯函数）。
 * @param {object} input
 * @param {string} [input.tier] 显式档位（T0/T1/T2）；给了就是 declared，但自动升级仍优先。
 * @param {string} [input.reason] T0 必填的原因（声明或派生 T0 缺 reason 均降为 T1）。
 * @param {string[]} [input.paths] 改动路径（relay/workspace 相对均可）。
 * @param {number} [input.lines] diff 行数。
 * @param {boolean} [input.publicSurface] 碰工具 schema/返回契约/preset/seam。
 * @param {boolean} [input.dataFormat] 碰数据/状态文件格式。
 * @param {boolean} [input.permissions] 碰权限/审批。
 * @param {boolean} [input.irreversible] 不可逆（删除/迁移/外部副作用）。
 * @param {boolean} [input.external] 对外发布/外部系统。
 * @param {boolean} [input.userVisible] 用户可见行为变化（至少 T2：需要用户确认设计/验收）。
 * @returns {{tier:'T0'|'T1'|'T2', source:'declared'|'derived', reasons:string[]}}
 */
export function classifyRisk(input = {}) {
  const reasons = [];
  const paths = Array.isArray(input.paths) ? input.paths.filter(isString).map((item) => item.trim()).filter((item) => item !== '') : [];
  const lines = Number.isInteger(input.lines) && input.lines >= 0 ? input.lines : undefined;
  const declared = RISK_TIERS.includes(input.tier) ? input.tier : undefined;
  let tier = declared;
  const source = declared === undefined ? 'derived' : 'declared';
  const upgrade = (next, why) => {
    if (tier === undefined || TIER_RANK[next] > TIER_RANK[tier]) {
      tier = next;
      reasons.push(why);
    }
  };
  const libCode = paths.filter((path) => LIB_CODE.test(path) && !isDocPath(path));
  if (libCode.length > 0) upgrade('T1', 'lib/** code: ' + libCode.slice(0, 3).join(', '));
  // 声明的 T0 不能覆盖非文档路径：带代码路径的 T0 至少 T1（未知路径仍按无法判定兜底）。
  const nonDocs = paths.filter((path) => !isDocPath(path));
  if (declared === 'T0' && nonDocs.length > 0) upgrade('T1', 'T0 with non-doc paths → T1: ' + nonDocs.slice(0, 3).join(', '));
  const publicPaths = paths.filter((path) => PUBLIC_SURFACE.test(path) || /preset|schema/i.test(path));
  if (publicPaths.length > 0) upgrade('T2', 'public surface: ' + publicPaths.slice(0, 3).join(', '));
  if (input.publicSurface === true) upgrade('T2', 'public surface (tool schema/return/preset/seam)');
  if (input.dataFormat === true) upgrade('T2', 'data/state format change');
  if (input.permissions === true) upgrade('T2', 'permissions/approval change');
  if (input.irreversible === true) upgrade('T2', 'irreversible change (delete/migrate/external side effect)');
  if (input.external === true) upgrade('T2', 'external-facing change');
  if (input.userVisible === true) upgrade('T2', 'user-visible behavior change');
  if (lines !== undefined && lines > 300) upgrade('T2', 'diff > 300 lines (' + lines + ')');
  else if (lines !== undefined && lines > 20) upgrade('T1', 'diff > 20 lines (' + lines + ')');
  if (tier === undefined) {
    const docsOnly = paths.length > 0 && paths.every(isDocPath);
    if (docsOnly && (lines === undefined || lines <= 20)) {
      tier = 'T0';
      reasons.push(paths.length === 0 ? 'docs-only change' : 'docs-only change (' + paths.slice(0, 3).join(', ') + ')');
    } else if (docsOnly) {
      tier = 'T1';
      reasons.push('docs change > 20 lines');
    } else {
      tier = 'T2';
      reasons.push('cannot determine → conservative T2');
    }
  }
  // P1-3b（fix-p1b）：证据校验必须在派生之后——声明档与派生档一视同仁：任何 T0
  // 都必须显式给出 paths + lines + reason；缺任一降 T1（并发其他信号仍可再升 T2）。
  // 派生 T0 曾只凭 docs 路径就过（T0 免设计门/独立审查），属门禁绕过，故收紧。
  if (tier === 'T0') {
    const missing = [];
    if (paths.length === 0) missing.push('paths');
    if (lines === undefined) missing.push('lines');
    if (typeof input.reason !== 'string' || input.reason.trim() === '') missing.push('reason');
    if (missing.length > 0) {
      tier = 'T1';
      reasons.push('T0 without actual diff evidence (' + missing.join(' + ') + ') → T1');
    }
  }
  if (tier === 'T0' && reasons.length === 0) reasons.push('docs-only change');
  return { tier, source, reasons };
}

/** 独立审查去重键：sha256(requirements || designPath || diffHash)（取 16 hex）。 */
export function reviewKeyOf({ requirement, designPath, diffHash } = {}) {
  return hash16(['review', requirement ?? '', designPath ?? '', diffHash ?? ''].join('\n'));
}

/** done-gate 去重键：itemId + ledgerRev + diffHash。 */
export function confirmKeyOf({ itemId, rev, diffHash } = {}) {
  return hash16(['confirm', itemId ?? '', rev ?? '', diffHash ?? ''].join('\n'));
}

/** doc_lint 文档哈希：path+mtime+size 列表 + governanceHash。 */
export function docsHashOf(entries = [], governanceHash = '') {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => typeof entry === 'string'
      ? entry
      : String(entry?.path ?? '') + ':' + String(entry?.mtimeMs ?? '') + ':' + String(entry?.size ?? ''))
    .sort();
  return hash16(['docs', ...rows, governanceHash].join('\n'));
}

/** 派活拦截去重键：leadSession + target + band + status + phase + taskId。 */
export function denyKeyOf({ leadSession, target, band, status, phase, taskId } = {}) {
  return hash16(['deny', leadSession ?? '', target ?? '', band ?? '', status ?? '', phase ?? '', taskId ?? ''].join('\n'));
}

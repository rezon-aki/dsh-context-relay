/**
 * dsh-context-relay — worker（子代理）短协议（v0.2.17 C）。
 *
 * 非 root 且非队友的 subagent 会话用同名 section 影子覆盖 preset 的全量 relay 协议：
 * worker 不需要 Lead 的 phase/压缩/接力/审批纪律，只保留干活与回报的行为约束（省约 5KB 常驻文本）。
 * 队友保留全协议（调度/回执纪律对 teammate 仍适用）。影子覆盖靠宿主 systemPrompt 的分层合并
 * （agent scope 覆盖 preset generation scope）；单测只能断言注入调用本身（name/order/text），
 * 真实覆盖效果需新会话验证。
 *
 * @module dsh-context-relay/agent/worker
 */

export const WORKER_PROTOCOL_TEXT = `# Worker 协议（relay 子代理）

你是 relay Lead 派出的 worker（子代理），不是 Lead：不运行 relay phase 流程，不做压缩/接力（那是 Lead 的职责）。
按任务简报完成工作并回报：结论 / 证据(file:line) / 改动 / 验证(命令+结果) / 未验证 / 风险 / 下一步；完成后发 1 条 ≤200 字消息，并写任务卡要求的报告路径。
到线（band 升到 organize/relay）只向 Lead 请示，不自行压缩/交接，不直接问人类；需要人类决策、改变需求/边界或不可逆操作时交回 Lead。
严格遵守任务卡写范围，不改范围外文件；失败不静默，如实回报。`;

# 设计说明（Design）· v0.10.0

> 范围：唯一生产模式「接力模式（Relay）· 超长任务」（内部 id `relay-long`）。
>
> 本文是仓库内的**可发布设计摘要**：只给目标、边界、关键结论与验收口径，不复制行为契约与版本历史；逐条设计点与内部审计记录不随仓库发布。实现架构与官方 seam 契约见 [ARCHITECTURE.md](ARCHITECTURE.md)，迁移与破坏性变更见 [MIGRATION.md](MIGRATION.md)，逐版本行为变更见 [CHANGELOG.md](../../CHANGELOG.md)。
>
> 版本：**v0.10.0（2026-11-16）**——完整形态交付，v0.9.0 未单独发布（内容并入）。

## 1. 定位

relay 补的是「多层智能体架构下的上下文生命周期」：让 Lead 与团队始终以任务所需的最小上下文工作，并在 phase 边界、压缩、交接之间保持连续记忆。它不重复 DSH 官方已覆盖的能力（团队任务板、子智能体树、压缩引擎、消息与审批提问、会话搜索、任务调度）。

一句话：不换模型、不删历史，改的是长会话的组织方式——什么时候压缩、什么时候换新会话、怎么交接、哪些事交给人来定。

## 2. 设计目标（按优先级）

| # | 目标 | 含义 | 验收口径（摘要） |
|---|---|---|---|
| G1 | 多层架构 + 必要最小上下文不断 | Lead → 直接队友 → worker，每层只拿完成当前任务所需的最小上下文；层间靠记录、指针、交接保持连续 | 新会话只凭「brief + 交接摘要 + 指针」即可开工；派活 brief 给必读最小集（1–3 份）而非口头复述背景 |
| G2 | 动态取得所需必要上下文 | 不预装全量历史；需要时按文件、brief、链式索引、会话事件精确召回，召回有界 | 索引→正文不超过 2 跳；单次读取有界并返回 `nextOffset`；检索只回 `path:line` 摘要；坏指针可由 lint 报出 |
| G3 | 全团队保持在上下文高效区间 | 目标区间可配置（默认基准 35%，band 30/35/45），由 Lead 在分配任务前评估与管理（含 Lead 自身） | phase 边界给出 band 与边界动作；不在 phase 中段压缩或接力（容量保全例外）；派活前看队友档位 |
| G4 | 工程方向由独立低上下文的架构师敲定 | 固定的架构师队友，模型默认与 Lead 相同、用户可覆盖；只交付工程实现文档与「待决策」项，不写代码 | 实现按文档落地；偏离文档要回问架构师；架构师上下文保持低 |
| G5 | Leader 与用户交互优化（最小注意力、最大影响） | 只给用户必要文本（白话）；P0 先报备「做什么·为什么·怎么撤」再等明确 Go；先查文档定论、不替用户拍板、问题批量一次问清 | 用户正文只有必要汇报与裁决条目（影响/风险/收益）；每 phase 非 P0 同步最多一次；P0 有明确 Go/No-go |
| G6 | Leader 的项目文档管理 | 核心设计只保留最小必要的高价值条目；低价值/过程性内容进链式记录按需取；文档有分层与索引 | 新人凭索引能定位最小必读集；超界只归档或完整落盘加指针、不丢数据；索引自动生成 |
| G7 | 工程落地优化 | 没必要的事不做；按模块完整落地、不做半成品；验收查实际落地与需求是否有缺失、偏移 | 每个功能有证据与测试；独立审查专查偏移/劣化/偷懒/缺失；不设空转闸门 |

## 3. 边界（不做清单）

- 不改 DSH 内核、不改 profile、不接管普通会话、不删除会话历史（只遮蔽或开新会话）。
- 不实现团队任务板/执行分配、消息与命名、压缩引擎、goal/ralph、审批与提问、会话搜索——交官方。
- 台账不是团队任务板：它是 Lead 自己的 phase 工作队列。
- 单一模式：只保留「接力模式（Relay）· 超长任务」（原超长任务模式），历史双模式与 classic `relay` 别名已在 v0.10.0 删除。
- 注入内容不伪装用户发言：必须标明非用户来源；受官方 API 限制，注入会以消息事件持久化，因此不承诺「不写历史」，待官方提供无历史注入 seam 后改为纯派生。
- 记忆与压缩只经官方 seam；目标版本缺所需 seam 时降级提示、不自造引擎。
- 不做 PTC 程序通道守卫（已裁决）：工具面裁剪只隐藏模型工具调用；`run_code` 内 `node:fs`/子进程直写是执行软约束，不承诺硬隔离。
- 代码是实现事实，不是设计真源；代码与本文冲突按实现偏差处理，不允许用代码反改设计。

## 4. 关键设计点

### 4.1 上下文度量与预算

- 实时度量上下文占用并分四档：ok（<30%）/ warn（30–35%）/ organize（35–45%）/ relay（≥45%）；基准线默认 35% 可配置，四档按基准线派生。
- 预算只是 phase 边界闸门：phase 中段不打断、不压缩、不接力，phase 优先。
- 容量保全是唯一例外：逼近硬窗口（默认 ≥85%）时发一次性容量保全提醒，立即收尾当前动作、写 brief/progress、准备压缩或交接；不自动压缩/接力。
- 开新 phase 前做可行性判断（`budget_plan`：proceed / split / relay），放不下就拆票，不硬挤。
- 升线提醒事件驱动、只告知事实与边界动作、不重复；指标缺失/过期按保守档处理并提示，不静默当作 ok。
- 历史 40/50 基准属旧口径，legacy `config.thresholds` 已在 v0.10.0 删除（换算见[迁移表](MIGRATION.md) MIG5）；新会话默认 35% 基准（band 30/35/45）。

### 4.2 phase 生命周期

- 固定主链 discover → decide → build → verify → ship；每 phase 有 goal 与可验收 exit_criteria（discover/decide 必填，且只在跨 phase 时校验）。
- 受控回边：verify→build（返修）与任意 phase→blocked/cancel（`exit_reason` 必填，不删历史、不替代用户门）；恢复时从退出前 phase 继续（ship→blocked/cancel 后可恢复回 ship）；回边不跳过用户门。
- **两段式用户门**：① **设计门**——首次进 build（previous ∈ {discover, decide}）必须带 `design_gate{path, user_approved:true}`（用户确认过的设计文档路径），缺失零副作用拒绝；② **实现↔设计对齐**——ship 前由新上下文模型做一次独立审查（需求↔实现：偏移/劣化/偷懒/缺失，最多 1 轮），与其他验收并行、不串行终检；结论写进 `user_gate.review`，再向用户 `report`。
- `contract_check{requirement, fidelity, attention}` 只在 **ship 必填**（交付自检），其他 phase 可选。
- 验收只做最小必要：默认 = 目标模块测试 + 单次独立 diff 审查 +（必要时）一次语法/静态检查；`user_gate.verification{tier:'minimal'|'heavy', approved_by_user?, items[]}`，重型验证无用户明确授权即拒。
- 关 phase 有台账闸门：分点必须 done 或 blocked，或显式 carry；`phase=null` 条目同样纳入；默认 warn，可配 strict。分点只在主链跨 phase 时登记（同 phase 传 items 显式拒绝）。
- 跨 phase 响应自动带预算事实与 ≤3 条相关历史经验（必须带证据）。
- ship 只能从 verify 进，必须带用户门：新上下文独立审查 + 大白话汇报，不弹审批弹窗；Lead 必须给全审查上下文（用户原话逐字、实现索引、验证证据、文档入口、已知边界）；审查超时或未完成不算通过。

### 4.3 压缩与长期记忆

- 可恢复压缩：压缩前写 phase brief（目标/退出条件/关键文件索引/已定决策/证据指针/未闭合项）；压缩只遮蔽不删除，brief 在压缩后注入。
- 链式记忆：chain 逐行记录会话 id、遮蔽 seq 区间、brief/handoff 指针；超界旋转归档，不丢指针。
- 召回纪律：优先精确指针回读，每轮 ≤3 条、命中即停；全文检索只作兜底。
- 冲突裁决顺序：最新用户裁决 > 快照 > 指针 > 旧会话；新裁决覆盖旧口径并在 brief 记录；归档指针带来源与版本，坏指针可诊断并给修复建议。
- 长期记忆不淘汰：progress / lessons / chain / ledger / 团队记录超界只归档或完整落盘加指针，不删除。

### 4.4 会话交接

- 交接 = 摘要 + 完整文件：新会话注入有界摘要，完整交接单永远完整落盘、首条消息给路径；不因超长拒绝交接。
- 交接分阶段：①预检（文档/参数齐全）失败零副作用；②写完整交接文档；③建新会话并注入摘要；④新会话确认接管后逐步停旧活（停队友/取消后台任务/迁移定时任务），每步有逆操作与恢复点；孤儿会话必须清理或复用。
- 交接前先写文档（phase brief、进度、决策、证据），文档没写完不交接。
- 交接清理与定时任务迁移走官方 seam；rc.2 schedule 形状不符时只降级 N/A + warn，不拒绝交接（不再 preflight 恒拒）。
- 面板模式是会话本地状态，不随接力继承：新会话默认「压缩继续」，接力 chip 只决定新会话装配。
- 新会话先读滚动 progress 与 brief 索引，再按需取正文，不整篇重读历史。

### 4.5 团队

- 默认 4 人小队、按需增加到部署 `maxActiveSubagents`；满额排队/报阻塞、不硬撑；优先复用现有队友，不为每个任务 spawn。
- 队友生命周期：checkpoint（写状态）→ freshen(reset)（真清空 + 新 brief）→ renew（换身份才用）；记录按 Lead 会话分区。
- 派活 brief 强制五字段：目标 / 必读 1–3 份指针（含 when/role）/ 写范围 / 验收 / 回执路径；worker 自读自取，不要求 Lead 口头复述背景。
- 回执契约：报告文件（头 3 行 task/revision/verdict）+ ≤200 字消息；Lead 只看 digest（≤600 字），验收抽样 ≤3 次/phase。
- 队友纪律：不做验收声明、不自行压缩/接力、不越权写；P0 上报 Lead；团队重启后由新 Lead 按交接单/progress/checkpoint 手动重建，不提供自动 rehydrate。
- 派活前先读队友上下文档位（只读聚合 band 指标、不读队友会话内容），判断直接派还是先管理；phase 边界给队友 triage 建议（keep / checkpoint / reset / renew），但不自动 reset。

### 4.6 工作台账

- 台账 = Lead 的 phase 工作队列（不是团队任务板）：条目只记 Lead 的管理动作（分点、派发、等待、待用户、关闭），字段含 id/title/phase/status/next/evidence/owner/officialTaskId。
- 执行状态/依赖/验收以官方任务板为准（若启用）：台账只引用 task id，不复制执行状态。
- 闸门：done 必须有 evidence；blocked 必须写原因；整表替换不得删除未完成条目；空台账 = 旧行为完全不变。
- 分点只在主链跨 phase 时登记；同 phase 传 `items` 显式拒绝且零副作用（补分点用 `relay_work_items`）。
- `phase=null` 条目视同当前 phase 纳入关闸（不能成为 strict 绕过口）；`GET /context-relay/work-items` 纯只读、无迁移写盘。
- `relay_phase` 的 `next_operation` 入参已删除（v0.10.0），下一步信息只走台账条目 `next` 字段。
- 跟会话走：交接复制到新会话；跨 phase 遗留必须提示或显式 carry。
- 上限 30 项：超限先归档 done 项（不自动删）；无 done 可归档时拒绝新增并提示先收口/关闭；归档记录可查。
- 面板只读展示台账，不与官方任务板双写。

### 4.7 文档系统（v0.8.0）

- L0 虚拟索引自动生成（最新交接/brief/进度/经验 + 深文档按 when/role 定位），不持久化、避免双写。
- 分层：L1 先读（handoff/brief/progress/lessons）、L2 按需（architecture/docs/decisions/research）、raw 原始（reports/archive）；frontmatter 契约 title/role/layer/when/owner/updated，缺省可工作。
- `relay_doc` 五个动作 index / list / read / search / lint；read 支持 section/offset、单次有界并返回 `nextOffset`；search 只回 `path:line` 摘要；lint 是 advisory 体检（缺 frontmatter / 坏指针 / 超大 / L1 超阈值）。
- 上限只 advisory：超界归档、完整落盘加指针，不丢数据；`doc_lint` 配额只 WARN 不拦。
- 交接与压缩 brief 自动带索引；检索纪律写进协议与 skill（先索引后正文、消息不贴长文、细节落 L2）。

### 4.8 人机交互

- 提问只用于非 P0 的简单问题（`ask_user_question` 叠加 timed 60s，未答返回 pending 后继续）；复杂取舍与 P0 走普通消息白话展开并显式等 Go，不受 60s pending 影响；pending 不得代替用户裁决。
- 问题批量一次问清（推荐 + 默认 + 后果）；同一问题不重复问；答案落盘；每 phase 非 P0 同步最多一次（P0 随时）。
- P0（不可逆/对外/付费/凭据/删除）先报备「做什么·为什么·怎么撤」并等明确 Go；超时 ≠ 同意。
- 汇报四段式（结论→影响→需要你做什么→证据位置），默认简短（≤600 字）；用户明确索要细节时例外（建议 ≤4000 字）；只提醒不拒绝，绝不阻断 ship/phase。
- Leader 主动发现「用户最小注意力产生最大影响」的位置：用户只读必要文本，其余细节留文档/面板按需查。

### 4.9 授权与面板

- 面板档位：继续 / 压缩继续 / 接力新会话 / 问我；单一模式新会话默认「压缩继续」。
- 授权正交：一次性预设只决定「做什么」，不产生免审；免审只来自 autoCompress / autoHandoff / authorizeNext（一次性，成功后消费）。
- 授权绑定「会话 + 操作 + 版本」：会话结束/接力/版本变更即失效，不跨会话继承；用户需重新授权。v0.10.0 起 panel `schemaVersion=3`，旧版本文件载入时一次性失效全部会话授权（模式/架构师设置保留）。
- 面板按会话快照展示与操作；模型推荐 chip 只高亮、不产生授权（推荐 ≠ 决定）。

### 4.10 架构师

- 固定架构师队友：模型默认与 Lead 相同（继承 Lead/部署默认），用户可在 composer 覆盖；不改配置即用默认，不阻塞。
- 只产工程实现文档（七段：需求对齐 / 技术路线 / 模块接口 / 数据协议 / 风险取舍 / 待决策 / 实现步骤与验收），不写代码；N/A 项说明理由，不空转。
- 按代际续用（fresh/continue）；新任务到达时清空、不自行清空；Lead 收文档→决策回人→实现派 worker，偏离回问架构师。

### 4.11 模式、装配与 Leader 职责

- 单一模式：唯一生产模式为「接力模式（Relay）· 超长任务」（id `relay-long`）；classic `relay` 别名与全部兼容路径已在 v0.10.0 删除。
- Lead 只做用户交互、决策、派活、验收抽样，不亲自改码/跑测试/写实现文档/读长日志；没有执行例外（实现、调查、文档、命令一律派 worker）。
- 委托可观测：`relay_status` 报告 Lead 执行动作占比、派活数与空闲 worker；委派闸门默认 warn 阈值 20%（超出只提醒、不拒绝），`strict` 档为预留（当前 config 层归一为 warn）；仍不在 phase 中段阻断；ship 委派统计保持 advisory（不对 report 文本做机械校验）。
- **preset 可切换**：会话创建时选择 Relay，或先建默认（ptc）会话、在首轮前或会话中切到 Relay——插件通过 `agent/created` / 启动回填 / 官方 `agent-preset/selected` / 每步惰性兜底四个入口幂等安装 Lead 平面（`relay_status.plane` 可自检），不再要求「切换需新会话」。
- 装配 = 角色表（`lib/plane/roles.js`：deny/协议段/工具组/root 种子）+ client bundle；同一插件注册/注销，卸载即净。

### 4.12 失败、并发与安全

- 官方 seam 契约层：9 个官方 seam（preset/agents/tools/systemPrompt/compaction/projections/schedule/wipe/team）启动做形状断言；不符 → 降级 N/A + warn 进 `relay_status.plane.degradations`，不静默 fail-open。
- 单写者与原子写：写盘用 temp+rename 原子替换 + 跨进程异步锁 + journal 恢复；修订冲突检测；崩溃后可恢复，不留半成品。
- 错误与操作契约：预检/校验失败零副作用；执行阶段失败可部分成功，但必须记录「操作 id、阶段、失败码、已发生效果、恢复点、归属」并给恢复动作。
- 降级与恢复：底层服务不可用/磁盘失败时降级运行并如实报，进入恢复点，不静默继续。
- 安全：路径越界与符号链接防护；跨会话读取只允许聚合档位等管理指标；文档内容只当数据、不升级为指令；凭据/密钥不进 brief、handoff 或永久归档。
- 工程质量：无构建链（手写 ESM + `node --test` + 语法检查）；协议文本预算只约束注入文本，完整文本留档在 skill/文档，不因预算丢内容。

### 4.13 官方 seam 契约（v0.10.0）

只依赖 DSH 0.2.2-rc.2 的官方 seam，启动时逐个做形状断言；服务缺失/形状不符 → 降级 N/A + warn（写入 `relay_status.plane.degradations` 与首步 notice），不静默 fail-open、不拒绝会话。

| seam | 用途（relay 侧） | 形状不符时 |
|---|---|---|
| preset | 判定 agent 是否 relay、切换回填 | 切换事件判定降级，惰性兜底 |
| agents | live agent 回填（`list/get/turnBoundaryOf`） | 启动回填跳过并记降级 |
| tools | 工具面裁剪 `restrict({deny})` 与角色工具注册 | 逐名跳过，全部失败记降级 |
| systemPrompt | 影子协议段同名覆盖 | 协议段不注入并记降级 |
| compaction | 可控压缩 / freshen 引擎 | organize/freshen 拒绝并降级 |
| sessionProjections | relay 派生状态（phase/band/organizeCount 等） | 退回日志扫描；band 可显式 unavailable |
| schedule | handoff 定时任务盘点/迁移（rc.2 Host-wide target） | 盘点 N/A + warn，不拒绝交接 |
| wipe | 队友真清空（`surface.nodes/append`） | 失败回退压缩并如实报 |
| team | 团队能力探测、队友工具注册 | 团队面降级、不注册队友工具 |

逐项形状断言与降级细节见 [ARCHITECTURE.md](ARCHITECTURE.md) §2。

## 5. 强制契约

1. **两段式用户门**：① 设计门——首次进 build 必须有用户确认过的 `design_gate`；② 实现↔设计对齐——ship 只能从 verify 进，ship 前由新上下文的模型做独立审查（需求是否已定 + 实现是否忠实，查偏移/劣化/偷懒/缺失），再向用户大白话汇报；不弹审批弹窗。重型验证须用户明确授权。
2. **人类注意力最小高影响**：只在会改变用户可见结果/边界/不可逆处打扰；问题批量一次问清；答案落盘。
3. **授权正交**：面板一次性预设只决定「做什么」，不产生审批豁免；免审只来自 autoCompress / autoHandoff / authorizeNext（一次性，成功后消费）。

## 6. 验收口径

- 设计点与实现分开审；审计基线 = 用户裁决 + 本文（目标/边界）+ 内部逐条设计点全表；报告列 P0/P1/P2 与未验证项。
- 独立审查：需求↔实现对齐，专查偏移/劣化/偷懒/缺失；单轮 ≤10 工具调用 / ≤5 分钟为 advisory，超时或未完成不算通过（可续审/换人复审）；P0/P1 修复后只看 diff 复核，P2/P3 记录不阻塞。
- 每个功能有 `file:line` 证据与测试；不设空转闸门。
- 字节/条数上限只做 advisory 引导：不硬拒绝、不截断丢数据；超界归档、分层、完整落盘加指针。
- 术语与显示名：唯一模式显示名固定为「接力模式（Relay）· 超长任务」；旧「默认模式 / 超长任务模式」双模式口径属历史。

## 7. 延伸阅读

- 实现架构与官方 seam 契约：[ARCHITECTURE.md](ARCHITECTURE.md)
- 用户文档与使用方式：[README.md](../../README.md) / [README.en.md](../../README.en.md)
- 迁移与兼容（0.8.x → v0.10.0）：[MIGRATION.md](MIGRATION.md)
- 逐版本行为变更：[CHANGELOG.md](../../CHANGELOG.md)
- 随包技能（协议 / 文档治理 / 人机协作）：[skills/](../../skills/)

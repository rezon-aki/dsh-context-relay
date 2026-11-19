---
name: context-relay
description: "接力模式（relay preset）的操作手册：phase 状态机、两段式用户门（设计门 + 实现↔设计对齐）、relay_status/relay_phase/relay_organize/relay_handoff/relay_work_items/relay_doc/doc_lint、派活与收口（relay_dispatch/relay_collect）、队友保鲜（relay_checkpoint/relay_freshen/relay_team_status/relay_renew）、专职架构师（relay_architect）、阈值、到线提醒与 composer 面板。用户切到接力模式、要求上下文整理/会话接力/phase 管理/多分支任务台账/团队保鲜时使用。"
disable-model-invocation: true
---

# Context Relay 操作手册

> **v0.11.0 更新**：① **主动管理**——新 phase/新任务起点自查；到线四档（起点主动 / warn 现在动手 / organize·relay 兜底 / capacity 55% 最坏兜底），warn 不再推荐继续。② **固定小队**——默认上限 8（含架构师）、spawn 默认关、换人=reset 全清复用、`relay_team_status manage` 做 retire/adopt，默认视图只 squad。③ **ship 受控 reopen**——ship→build/verify 必须显式 `reopen{reason,user_approved:true}`，ship→discover 标 newTask。④ **容量线独立**——`settings.capacityThreshold` 默认 55%。⑤ **宿主压缩兜底**——host 归因写最小恢复快照+一次 notice（unknown 只日志）。
>
> **v0.10.0 更新**：① **两段式用户门**——首次进 build 强制 `design_gate{path, user_approved:true}`（缺失零副作用拒绝）；`contract_check` 只在 **ship 必填**；ship 的 `user_gate.verification` 分 `minimal`/`heavy`，heavy 须用户明确授权；实现↔设计对齐由新上下文独立审查、与其他验收并行。② **单模式收口**——classic `relay` 别名与全部兼容字段/旧阈值已删除；v0.9.0 未单独发布，其批次行为并入本版。③ **preset 可切换**——首轮前/会话中切到 Relay 会自动回填 Lead 平面（`relay_status.plane` 自检），「切换需新会话」已过时。④ **notice/台账语义**——`[闭环]` 只认 write/edit/apply_patch，只读工具不清 pending；同 phase 传 items 显式拒（补分点用 `relay_work_items`）；面板 schemaVersion=3，旧授权一次性失效。⑤ **文档系统 v2 不变**——字节/条数上限只做 advisory，超界归档或完整落盘加指针。

## 何时用

用户选择「接力模式（Relay）· 超长任务」时使用：唯一生产模式，内部 id `relay-long`；classic `relay` 别名已在 v0.10.0 删除。会话可在创建时选 Relay，也可先建默认（ptc）会话、在首轮前或会话中切换——插件会自动回填 Lead 平面（`relay_status.plane` 可自检），不需要为切换重建会话。

**适用边界**：relay 的收益集中在**长程、多步信息收集、边做边收敛**的任务（检索/工具型）；单轮问答、一次性小改动、纯静态推理**不要套 relay**——phase 与纪律成本会大于收益，直接用普通会话更便宜。

**不适用/替代**：需要人类中途决策、依赖对话记忆、需要上下文预算管理的场景才用 relay。若是「重复性、可离屏、以 workspace 为长期记忆的整块劳动」，优先交给官方 Ralph（实验工具，默认关闭）或 `workflow`/`subagent`，**不要用 relay 自研自动循环**。

**授权口径（唯一真源）**：模式只决定「做什么」，不产生审批豁免；免审只来自 autoCompress / autoHandoff / authorizeNext（一次性操作成功后消费，失败不消费）。授权绑定会话+操作+版本，不跨会话继承，接力/版本变更即失效；新会话默认压缩继续，免审从零开始。只继承非授权的 architect/architectModel。

## 一轮的标准动作

1. **起手**：调 `tools.relay_status` 看 Lead 与队友的压力、当前 phase、`continue`、`budget`、`plane`（agent 平面自检：role/installed/degradations）、`delegation`（执行占比/派活计数）、`diagnostics`。结构化字段已瘦身：`{phase, lead{used,window,ratio,band}, team[], organizeCount, continue{needed,band,organizeCount,recommendation,reason}, advice, diagnostics{pressureSource,lastCompactionSeq,organizeCount}, budget{band, used, window, ratio, headroomToWarn?, headroomToOrganize?, headroomToRelay?, thresholds{warn,organize,relay}（各线 token 值）, currentPhaseCostTokens?, previousPhase?{phase, costTokens}}}` + `text`；阈值、A/B 选项与预算事实行（headroom、本 phase 已消耗、上一 phase 消耗）只在 `text`（v0.2.15：`text` 不再复制 advice 与 `continue.reason`，只保留预算事实行与 recommendation——两者仍在 JSON 字段）。`organizeCount` 只计**真实压缩成功**的次数（拒绝/失败/空压缩不计数）。
2. **声明 phase**：`tools.relay_phase({phase, goal?, exit_criteria?, design_gate?, contract_check?, budget_plan?, user_gate?, reopen?})`（**discover/decide 必填 exit_criteria**：可验收完成口径，且只在跨 phase 时校验；**首次进 build 必须带 `design_gate{path, user_approved:true}`**（用户确认过的设计文档路径），缺失零副作用拒绝；**contract_check{requirement, fidelity, attention} 只在 ship 必填**（交付自检），其他 phase 可选；**进 ship 只能从 verify 且必带 user_gate（review + report：新上下文独立审查 + 汇报）与 `verification{tier:minimal|heavy, approved_by_user?, items[]}`**，heavy 无用户授权即拒——见下「两段式用户门」）。**预算 phase 优先**：预算只是 phase 边界闸门——phase 中段不因预算打断工作、不中途压缩/接力；**warn 档（30%≤ratio<organize 线；默认基准 35%）切 phase 必填 `budget_plan{action, can_finish?, estimate_tokens?, note?}`**：`proceed`=估计放得下→放行；`split`=**拆票**（缩小本 phase 范围，goal/exit_criteria 收窄）→放行（响应带 reminder，phase 完成时再检查）；`relay`=先做一次 relay 操作（`relay_organize` force:true 或 `relay_handoff`）再重试 `relay_phase`；缺/非法 plan、`can_finish:false`+proceed、estimate 超 headroom 会被拒绝（**拒绝零副作用**）；ok 档不强制（headroom→organize >5% 窗口）；organize/relay 档沿用既有面板闸门；队友 relay 改为向 Lead 请示或拆票。**跨 phase 响应总带 `budget` 事实**（全档：band/headroomToWarn|Organize|Relay/上一 phase 实测消耗；ok 档不强制 `budget_plan` 但同样返回；warn 档另带 estimate/fits/action）——**phase 完成时看跨 phase 响应 budget 或 `relay_status.budget`** 决定边界动作。phase 固定为 discover → decide → build → verify → ship；goal/exit_criteria 会进下一次 organize 的 brief。人类选定的模式在本会话持久、不消费，严格按模式执行；autoChoose/autoDecision 等旧字段已在 v0.10.0 删除。**ship 后返修（ship→build/verify）必须显式 `reopen{reason 1-200, user_approved:true}`**（strict 零副作用拒；warn 放行+warning；off 旧行为），ship→discover 标 `newTask`。用 lessons 参数存带证据经验，超40条/8KB完整归档，不淘汰。
3. **按 phase 派活（`relay_dispatch`）/收口（`relay_collect`）**：固定小队默认上限 8（含架构师），spawn 默认关；优先复用/清空复用现有队友，没有可用队员时 adopt 或 phase 边界 handoff；满员报 squad-full，不硬撑。派活前读队友状态；派活 brief 五字段缺一不可：目标（可验收）/ 必读 1–3 份（L0/文档指针+when/role，worker按序自取）/ 写范围 / 验收（命令或对照项）/ 回执（报告路径、头3行task/revision/verdict，完成checkpoint后1条≤200字消息）。**派活一律走 `relay_dispatch`，收口一律走 `relay_collect`（短等 ≤120s，只回 digest）；见「派活与收口」节。**
4. **phase 收尾 = 按面板模式/人类选择处理继续方式（phase 优先）**：ok/warn 档可直接 `relay_phase` 切下一 phase（**warn 档必填 `budget_plan` 可行性估计，见步骤 2**；放不下就拆票或先做一次 relay 操作）；organize/relay 档**不开新 phase**（本 phase 的活照做不砍）。`relay_phase` 超预算切 phase **不走官方审批闸门**（由 composer 面板闸门处理）；严格按本会话面板模式处理，问我=先问用户；模式不免审。
   - 模式「继续」→ 放行切换并返回 `reminder`（模式保持、不消费）；
   - 模式「压缩继续」→ `relay_phase` 抛错指示：先 `tools.relay_organize({phase, brief})`，压缩成功后重试 `relay_phase`；
   - 模式「接力新会话」→ `relay_phase` 抛错指示：先 `tools.relay_handoff({..., human_approved:true})`（**rev5.5：模式只决定操作，不免审**；执行时按 `autoHandoff`/`authorizeNext` 判定，否则弹官方授权）；
   - 历史迁移（v0.10.0 已完成）：compress-then-handoff 档与 autoChoose/autoDecision/handoffPreset 字段已删除，旧 panel 值读入时归一为 null/false 后丢弃；模式只剩问我/继续/压缩继续/接力新会话。
   - 未设模式（问我）→ 一次问清压缩还是交接，推荐与默认附后；执行仍需当前会话的对应操作授权。
   - 选 A 时：写 phase brief（**压缩后仍要记住的关键事实**：目标、已定决策、证据指针、下一 phase DoD、**关键文件索引**——了解当前项目所需的重要文件：入口/核心模块/配置/契约/测试，每条 `path — 作用 — 为何必读`，≤8 条）+ 收尾**三清单**（已完成 / 未完成（原因）/ 未尝试（原因，含发现但没修的问题））+ 受控缩减。brief 在**压缩成功后**作为插件 notice 注入下一 step（宿主 config `injectBrief=false` 可关）；失败/busy/无压缩历史不注入，重试安全（失败不计数、不叠加）。organize 在**压缩前**由插件自动跑 `doc_lint` 并把结论写进 brief/evidence（v0.2.15：协议不再要求模型「压缩后必跑」）；需补查时再手动跑，UNKNOWN 要写明原因；FAIL/WARN 压进下一 phase brief 或 handoff 的 evidence。每会话默认最多压缩 1 次；人类在面板把模式选为「压缩继续」或明确要求（force）时可第 2 次（审批仍按 autoCompress/authorizeNext）。**任何压缩（首次/二次、自动/非自动）默认都走官方授权闸门**：面板 `autoCompress`（压缩自动授权）或 `authorizeNext`（授权下一次操作）开时免审。**rev5.5 正交模型：面板模式只决定「做什么」，不再自带免审**（模式「压缩继续」执行时同样可能弹一次授权）。
   - 选 B 时：先要一次明确 Go/No-go（目标是否仍正确 / P0 未决项是否裁决 / 丢弃上下文里有没有人类需要的 why）；`relay_handoff` 只在面板 `autoHandoff`=on 或「授权下一次操作」（`authorizeNext`）时跳过官方 `tools/pre-execute` 审批（rev5.5：模式不产生豁免）（否则浏览器面板确认，**fail-closed**，仅宿主 config `handoffApproval='off'` 可关）。旧会话保留为审计档。新会话**默认继承旧会话的模型路由与权限档**（返回体 `inherited`；`inheritOnHandoff=false` 关闭）——注意这等于把旧会话的 `danger-full-access`/`never` 也带过去，人工确认点就是这次审批（或面板显式授权）。
   - 人类/面板也可以选「继续」或「先不压缩也不接力」：按当前上下文继续，不自行决定。
5. **handoff 半创建**：若返回 `halfCreated:true`（会话已建但 live/followup 失败），插件会 best-effort 清理并提示重试；workspace attach 失败不阻断交付（`ok:true` + `info.code='relay-attach-failed'`，事后在会话列表手动 attach cwd）。

> **结果摘要化（v0.10.0 保留）**：`relay_phase` 成功结果带人类可读 `text`（`render` 返回 text，与 `relay_status` 同模式），固定前缀行 `phase:/exit:/context:/budget:/ledger:/team:/user_gate:/warnings:/delegation:/lessons:/next:/hint:/summary:`，总长软上限 1,600；结构化字段保留（PTC/测试仍可读），`goal`/`exit_criteria` 入参回显删除；错误/拒绝/校验顺序与零副作用不变。

## Lead 职责（只管理，不亲自执行；设计 #63/#64/#59）

- **生产纪律**：Lead 只做四类事——**用户交互、决策（裁决）、派活、验收抽样**（外加聚合回执）；**不亲自改码/跑测试/写实现文档/读长日志**，不做「顺手改一下」。
- **不设自做额度**：没有「小任务自己干」的例外；实现、调查、写文档、跑命令/测试一律由 worker（队友/子代理）承担；Lead 遇到需要执行的工作只能**派活或拆票**。
- **验收抽样有界**：≤3 次/phase 的 read/grep 核对，不是执行；执行占比看 `relay_status.delegation`，**目标 ≤20%**（warn 档只提醒、不阻断；strict 档可配、命中即拒）——超了先 `relay_dispatch` 派活再继续。
- **工具面裁剪只是辅助护栏**（relay-long 隐藏 bash/pwsh/write/edit）：纪律由本段与常驻协议承载，不靠维护「执行通道清单」；PTC 里 node:fs 等直写属**执行软约束**（插件不做通道守卫），靠自查与回执。
- 队友与子会话不受影响（worker 必须亲自写/跑）；本段不放宽/收紧队友协议。
- 适用范围：唯一生产模式「接力模式（Relay）· 超长任务」（relay-long）；classic 别名已删除（旧会话切 preset 即可回填平面）。

## 派活与收口（工具化：relay_dispatch / relay_collect）

- **派活一律用 `relay_dispatch({itemId, brief, docs, writeScope, acceptance})`**：从台账取分点 → 复用/新建 worker → 标准 brief（目标 / 必读 1–3 / 写范围 / 验收 / 回执路径+verdict）→ 台账写 doing+owner+next；缺字段直接拒绝，返回 worker/reportPath/dispatchId。
- **收口一律用 `relay_collect({itemId, waitMs?})`**（短等 ≤120s）：只读回执头 3 行（task/revision/verdict）+ digest（≤600 字），台账置 done（evidence=reportPath）或 blocked（原因），**只回 digest**；完整报告留在报告文件，验收抽样才 read（≤3 次/phase）。
- **不手工派活/不轮询**：不要用 `subagent`/`send_message` 手工派执行活（会漏 brief/台账/回执契约），不要轮询 `wait_agent`/`list_agents`（回执会自动送达）。
- **台账 owner / lead-exec**：build/verify 分点 owner 必须是 worker；Lead 自做必须在 done 的 evidence 记 `lead-exec:<原因>`（build→verify 默认 warn 校验；strict 档可配、命中即拒）。
- **执行占比目标 ≤20%**：`relay_status.delegation` 给数据（execRatio / 派活 / 收口 / 空闲队友 / advice），warn 档只提醒；超了先派活再继续。

## 两段式用户门（设计门 + 实现↔设计对齐；最小注意力最大影响，2026-11-16 补充裁决）

- **第一段：设计门（开工前，显式停）**：把设计（架构 / 改动面 / 验收口径 / 风险）交用户确认；用户确认后才允许开工。产品面：**T2 首次进 build（previous ∈ {discover, decide}）必须带 `design_gate{path, user_approved:true, ask_ref, not_doing}`**（path = 用户确认过的设计文档路径；ask_ref = 逐字用户原话 ≤300 字；not_doing = 1–10 条不做清单），缺失任一 `relay_phase` **零副作用拒绝**；结果回显 `design`（含 ask_ref 字数 / not_doing 条数）。没确认的设计不动代码。
- **第二段：实现↔设计对齐（执行中 / 验收，独立审查）**：`ship` 是唯一的验收声明——只能从 `verify` 进；Lead 会话 `relay_phase({phase:'ship', user_gate:{review, report, questions?, verification?}})`：**实现者自查有盲区**——用**新会话 / 新队友 / 新子智能体**（`subagent` fresh context；**不要用 `subagent_fork`**）做独立审查。**Lead 必须给全上下文索引**：① 用户原话需求+边界（逐字）② 实现索引（file:line）+ 验证证据（测试/命令结果）③ 设计文档/决策入口 ④ 已知边界/未验证项。**审查范围 = 只做「需求 ↔ 设计与实现」对齐**（找偏移/劣化/偷懒/缺失），**不重跑技术验证、不重读第三方源码**；**最多 1 轮**（P0/P1 修完只看 diff 复核），预算 ≤10 个工具调用/≤5 分钟；审查超时或未完成不算通过，可续审/换人复审，不得静默当通过。把审查者身份 + 发现写进 `review`；`report` 大白话汇报（需求 → 实现 + 证据 → 审查结论 → 边界/取舍/没做到）；`questions?` 每条必带 `recommendation`（**不设题数上限**）。**宿主只强制 review/report 非空、不校验内容对错**；**不弹审批弹窗**；`handoff` 不是验收。
- **验收只做最小必要（重型须授权）**：默认 = 目标模块测试 + 单次独立 diff 审查 +（必要时）一次语法/静态检查；`user_gate.verification{tier:'minimal'|'heavy', approved_by_user?, items[]}`——全量测试矩阵/真机端到端/大样本采样/多轮独立审查（>1 轮）/跨环境矩阵/性能压测/重复复跑默认不做，`tier='heavy'` 无 `approved_by_user:true` 即拒。
- **边界问题即发现即报**：discover/decide/build 遇到会改变结果/边界/代价的歧义、假设、实现与原意偏离 → 大白话汇报 + 提问（一次问清、附推荐与默认；**不限题数**）；不替用户拍板、不默默假设。用户起初未必知道最终形态，这是正常的——边发现边对齐。
- **人类注意力最小高影响**：只在会改变用户可见结果/边界/不可逆处打扰；每 phase ≤1 次非 P0 同步；问题一次批量问清（推荐+默认+后果，**不限题数**）；答案写进 phase brief/handoff（下一会话不再问）；能面板点选的不出问答；P0/不可逆随时。
- **工作时自检（ship 必填）**：模型进 ship 前必须记录 `contract_check{requirement, fidelity, attention}`（其他 phase 可选、缺失不告警）——① 需求是否已定：本阶段对应用户哪条需求、语义/边界定了没、还差的歧义是什么（定了写「已确定」）；② 实现是否忠实：本阶段有没有偏移/劣化/偷懒/缺失（无写「无」）；③ 注意力最小高影响：接下来是否需要用户注意力、凭什么是那一次（不需要写「不打扰」）。答不出就别 ship。
- **队友不做验收声明**：ship 的用户门是 Lead 的事；队友把结论/边界/未决项回执 Lead，由 Lead 汇报用户并过门；队友不跑 Lead 的 phase/验收流程、不声明 ship 完成。

### 设计深度模板（篇幅只作 advisory，不硬校验）

- **T0 文档/琐碎**：不写独立设计稿；phase goal 写一段「改什么 / 怎么验」，并给 risk.reason。
- **T1 局部代码**：设计写进 phase goal/exit_criteria，≤1 页（改动面 / 做法 / 验收 / 回滚）。
- **T2 高风险**：七段 ≤3 页——①需求对齐（用户原话）②技术路线 ③模块与接口 ④数据与协议 ⑤风险与取舍 ⑥待决策 ⑦实现步骤与验收；提案 ≤5 条（每条带推荐/默认/回滚）。
- **设计门回显**：T2 的 `design_gate` 必填 `ask_ref`（逐字用户原话 ≤300 字）和 `not_doing`（1–10 条不做清单）；缺任一零副作用拒绝。页数/提案超限只由 `doc_lint` 给 advisory WARN，不拒绝。

## composer 面板（输入框下方「接力」chip）

- **团队保鲜（v0.11）**：固定小队默认上限 8（含架构师，`squadMax` 可上调），spawn 默认关（`allowSpawn`）；派活优先 `relay_dispatch` 自动复用现有 squad 队友（协调类消息才用 `send_message`）。换人=让队友 `relay_checkpoint` → `relay_freshen({reset:true, brief})` 全清复用（同成员/0 额度）；`relay_renew` 默认不可用，只换身份/角色且 `allowSpawn=true` 时可用并受 cap。历史成员默认隐藏、不可派活：`relay_team_status({include_legacy:true})` 查看，`manage:{action:'adopt'}` 纳入，`manage:{action:'retire',scope:'legacy',keep:[...]}` 批量清理（catalog 不删名，真清空用 handoff）。队友只在 organize/relay escalation（warn 只本地提示）。**旧任务结束、旧上下文不要时：`relay_checkpoint` → `relay_freshen({reset:true, brief:"新任务…"})` → 派新任务**——reset 是**真清空**（下一次 pre-step 后模型只剩系统提示 + brief；同成员/同会话/不占成员额度/不计 freshen 次数；失败自动回退官方压缩）。`relay_renew` 只用于换身份/角色（新代占用并发额度，旧代释放后不占）。
- **渲染与档位**：唯一模式表盘为问我 / 继续 / 压缩继续 / 接力新会话；新 root 默认压缩继续，显式选择保持。无下一个新会话模式开关，handoff 恒去 relay-long；模式不跨会话继承。
- **模型推荐行（v0.3.3）**：Lead 用 `relay_recommend` 提交后，popover 状态行下多一行「模型推荐 · 操作 · 理由 · HH:MM」，表盘同操作档位加冷青虚线「荐」、chip title 追加「· 模型推荐 X」；单一模式收到「压缩→新会话」推荐整条忽略（该档已退役；无行/无高亮，v0.3.4）；推荐文案用面板档位长 label（压缩继续/接力新会话），reason 存储 ≤120、展示/提醒 ≤60；旧宿主缺字段不渲染。**推荐≠决定、不产生授权**。

- 排在 ContextMeter 右侧，显示实时 `接力 {pct}% · ● 模式`（`live.overBudget` 时追加「已到线」）。chip **显示当前模式**（`问我` / `继续` / `压缩继续` / `接力新会话`）。chip 上光点 =「授权下一次操作」（黄=未授权 / 绿=已授权一次免审 / **绿+呼吸灯=压缩与新会话都已自动授权、执行全免审**）；popover 为毛玻璃面板；光点后紧跟模式标签，再后是压/接**图标**（SVG）= autoCompress/autoHandoff 状态（灰=关、亮=开）。数据来自 `GET /context-relay/panel?sessionId=`（agent 每 step 发布实时状态，client 4s 轮询；`live=null` 时仍渲染中性降级 chip（比例显示 ?、不显示旧 band/「已到线」）。
- 点击展开非阻塞 popover：上下文比例/压缩次数 + 四档表盘（问我/继续/压缩继续/接力新会话）+ 自动授权与授权下一次。模式只决定操作，不产生免审；仅当前会话持久，不跨接力。
- **授权开关（仅当前会话+操作+版本）**：autoCompress=压缩免审批，autoHandoff=交接免审批，authorizeNext=仅下一次操作成功后消费；失败不消费。接力/授权 schema 版本变更即失效；v0.10.0 起 panel `schemaVersion=3`，旧文件第一次载入一次性清空授权。autoChoose 等旧字段已删除。
- 面板状态按会话持久化 `~/.dsh/data/dsh-context-relay/panel.json`；改动即 `PUT /context-relay/panel`，立即生效。**人类在面板改动时**保存会话快照（此后不跟随侧栏默认变化）；agent 内部状态写入（自决记录/授权消费/`handedOff`）只落会话内部字段，不固化侧栏默认值。
- 侧栏插件卡：阈值基准、四档默认模式、自动压缩/自动交接/架构师默认值；旧 autoChoose/autoDecision 字段已删除，未知旧键（如 autoPhase/autoContinue）忽略。持久化授权 schemaVersion=3，版本不匹配只清授权，保留模式/架构师等非授权字段。
- **「你的 token 预算无上限」注入（v0.2.7 起按会话）**：composer 模型选择器（模型名 · 推理等级）**右侧** chip 风格小胶囊「● 预算无上限」（绿点=开 / 灰点=关，仅 relay 会话显示）切换**本会话**；chip popover 里的**开关**（与面板其它开关同款）设置**交接后新会话**是否注入：默认展示跟随本会话当前设置，点击后固定开/关（v0.2.8 由三态胶囊改为开关）。侧栏不再有这个开关（`settings.unlimitedBudget` 仅作默认值/旧配置兼容）。v0.10.0 起 Lead 的开关值会继承给由它新建的队友/架构师/dispatch worker（spawn 时以 force 写入子会话面板），已存在的队友在下次 `relay_freshen` 复用同会话时同步到 Lead 当前值（架构师 `relay_architect` continue 复用同理）。GET /panel 的 relay 标记按**当前 preset 投影**判定（新建会话后在模式选择器选 Relay 也显示；v0.10.0 起首轮前/会话中切换与插件重载后旧会话都会被幂等回填，不需要新建会话）。

## 阈值（默认基准 35% → 30/35/45；唯一来源 = 插件 config `threshold` / `settings.threshold`[`settings.json`]；legacy `thresholds` 已删除）

- 窗口已知（status 返回 window）时**只用比例线**（默认 30/35/45：基准 35% = organize 线，warn = −5%，relay 硬线 = +10%；侧栏「插件 → relay 卡片」改基准（同卡还可设面板各选项的默认值），保存即热生效）。常驻协议**不写死**这些数字：升线时提醒 notice 会给 band 与实测比例（2026-10-24 起；2026-11-01 起只告知状态 + phase 优先指引、不给 mid-phase 动作指令；**v0.2.15 起阈值不进 notice**，看 `relay_status.budget.thresholds`）。
- 档位只决定「能不能开新 phase」：warn 不挡当前 phase 的工作，organize/relay 才禁止开新 phase；**phase 优先（2026-11-01）**：phase 中段不因预算打断工作、不中途压缩/接力；**开新 phase 前先估计本 phase 能否在阈值前完成**——warn 档切 phase 必填 `budget_plan`（`proceed` 放行 / `split` 拆票 / `relay` 先做一次 relay 操作再重试；缺/非法、放不下、estimate 超 headroom 拒绝且零副作用），ok 档不强制；**继续方式按面板模式/人类选择处理**，插件不默认执行任一动作。
- 窗口未知 / 为 0 时才退回绝对 token 兜底：100k / 130k / 160k。
- 比例优先：1M 窗口下绝对 100k 线 ≈ 9.8%，会过早触发（旧版 bug 已修）。

> 依据（历史研究结论，内部记录不随仓库发布）：40% 不是普适的窗口比例；社区经验拐点约在绝对 ~100k tokens，且退化是渐变不是悬崖。所以绝对线保留为窗口未知时的兜底，窗口已知时只按比例。

## 到线提醒

- 升线时插件自动注入一条 `source = {kind:'dsh-context-relay', form:'notice', summary}` 的提醒（**不是用户发言**；V4 准入要求 producer-owned kind，旧 `kind:'plugin'` 已退役）。
- **到线提醒（v0.11 四档）**：起点（新 phase/新任务）自查；warn=现在就该动手（压缩/清空复用/交接三选一，不再推荐继续）；organize/relay=兜底告警；capacity 55%（独立配置）=最坏兜底（不自动执行）。只在 band 上升/新起点时提醒，同档不重复；回退后再升线仍提醒；成功压缩重新武装；每次 phase 完成仍超线再提醒一次。处理点在 phase 边界（capacity 是唯一不等边界的「最坏兜底」）；开新 phase 前按 `budget_plan` 估计。v0.2.15 起正文精简：band/比例/phase 事实 + 面板摘要 + phase 优先指引（organize·relay 档各加一句；autoChoose 变体已删除），Lead ≤365 字符（v0.3.3 起含 relay_recommend 指引行，实测 355）；不再复制 advice/工具清单/召回规则。v0.10.0 起 notice 正文统一脱敏、投递成功后才记去重键、压缩后复位去重状态。
- **模型推荐（v0.3.3）**：用 `relay_recommend({operation:"continue|compress|handoff", reason:"≤60字（存储上限 120）"})(compress-then-handoff 已退役，传入会被拒且零副作用)` 把推荐写给插件（**Lead-only**）：popover 出现推荐行、同操作档位加冷青虚线「荐」高亮、chip title 追加。**只做展示/参考**——不写 `defaultOperation`、不自动执行压缩/接力、不产生审批豁免，最终仍按模式/人类；切 phase / 压缩成功 / 接力成功 / 人类在面板选定后自动清空。队友/子会话调用返回 `lead-only`（零副作用），应在回执里把建议给 Lead。
- 冷启动/热重载从「持久 notice 晚于最近成功压缩」派生 seed；resume/热重载后不会重复提醒；接续会话（handoff 新 session id）重新计数。

## 提问与用户交互（白话优先）

- **提问工具只用于简单问题**：是/否、二选一、低风险确认、只缺一个事实；问题短、选项清楚、推荐排第一，同批一次问完。relay preset 的官方 `tool-ask-user` 行 config = `{mode:'timed', timeout:60}`：人 60s 没答返回 `pending`，模型继续独立工作或改用文字汇报，问题仍可后答；**pending 不是跳过、不是同意**。
- **复杂问题不走提问工具**：需要用户决策、方案取舍、边界/代价变化、长背景 → 用普通回复消息（大白话）展开：结论与影响 → 选项（推荐+默认+后果）→ 等用户直接回复。不要把这类问题塞进提问工具里等。
- **用户汇报规范（四段式，只提醒不拒绝）**：正文（含 user_gate.report）四段固定顺序：
  结论：一句话结果/状态。
  影响：用户可见结果/边界/代价（没有写无）。
  需要你做什么：裁决/确认/无需（推荐+默认）。
  证据位置：path:line/文档路径（≤3条）。
  默认≤600字，不贴命令输出/日志/长 diff，不堆内部字段名/错误码/术语（首次出现给人话解释）。用户明确要细节时 details_requested:true，展开建议≤4000字；仅放宽提示，不是硬拒豁免。格式/长度只产warning，随relay_phase结果+一次性notice，绝不阻断ship/任何phase；review/report非空硬门不变。每phase≤1次非P0同步，已答内容写brief/handoff。
- **ship 委派统计（advisory）**：给用户的 ship 汇报带一行「派活 N 次 / Lead 自做 K 项（原因）」；数据看 `relay_status.delegation`；只作汇报素材，**不机械校验 report 文本、不阻断 ship**。
- **PTC 边界**：程序里等待仍受 `run_code` 默认 120s 执行 deadline 约束（60s 提问超时留了余量）；不要把「必须等答案」的长等待塞进提问工具。**历史**：v0.2.3 引入 timed；v0.2.9 误删；v0.2.10 恢复固定 120s；v0.2.11 一度做「无限等待」被用户否决（2026-11-03「整体移除这个会一直等你回答的功能」），最终改为「只给简单问题、超时 pending、复杂问题走文字汇报」。

## doc_lint

- **v0.2.15：通常由插件自动跑**——relay_organize 在压缩前、relay_handoff 在生成交接单时自动执行并把结论并入 brief/evidence；模型无需为「压缩后必跑」额外调用，需补充检查时再手动跑。
- `paths` 只接受 **workspace 相对路径**（绝对/`~`/`..`/符号链接越界 → WARN，且不读取工作区外文件）。
- git 检查目标 = 工作区 `AGENTS.md` + 本工作区约定的 `docs/machine.md`/`docs/workflow.md`（存在才纳入）+ `paths` 额外文档；ignored 文件报 WARN（带规则来源）而不是 PASS；探测不到 = UNKNOWN（不是 ok）。部署级额外文档可经 `options.extraDocs`（代码级）传入，host config 通道留待后续。

## 队友保鲜（唯一生产模式；真清空、记录分区、手动重建）

- **派活后别空转**：队友回执是消息自动送达——不要循环调 `wait_agent` / `list_agents` / `team_task_list` 等；只有确实被阻塞时做一次有界等待（≤120s），其余时间继续验收抽样/准备下一步（常驻协议「等待纪律」）。

- 任务边界顺序：`relay_checkpoint` →（旧上下文不要时）`relay_freshen({reset:true, brief})` 真清空 → 派新任务。`relay_checkpoint({one_line, done[], decisions[], evidence[], constraints[], next_actions[], open_questions[], failed_attempts[], pointers[]})` 写 `.scratch/context-relay/team/<leadSessionId>/<lineage>/checkpoint.md`（≤4KB 为 advisory；超限摘要+完整落盘）+ ledger/roster；不写记录，下一代/新会话接不上。
- `relay_freshen({reset:true, brief})` = **真清空**：只排队，下一次 pre-step 保留系统提示、把其余 surface 替换为 brief（模型下一请求只剩系统提示 + brief）；同成员、同会话、不占成员额度、**不计 freshen 次数**；失败自动回退官方压缩（ledger 记 fallback），不谎报。旧事件仍在日志，可 `session_event_read` 召回。
- `relay_freshen({phase?, brief?, key_docs?})`（非 reset）= 同任务内自行压缩（与 Lead `relay_organize` 同机制：brief 先写盘 → 官方 context-overflow 压缩 → 成功后注入 brief；同代最多 2 次，有损）；仍脏 → 先 `relay_checkpoint` 再请 Lead `relay_renew`。
- `relay_renew({name, reason?})` **默认不可用**（spawn 关）；只用于换身份/角色且 config `allowSpawn=true`（同 lineage 下一代；受 `squadMax`；缺 checkpoint 返回 `checkpoint-missing`）。换内容/换 phase 一律 reset 复用。
- 新 Lead 会话（团队重启后）按交接单/progress/checkpoint 手动重建成员与派活；先核对当前成员和记录，缺记录先补证据，旧目录只读回退。
- Lead 派新活前：`tools.relay_team_status({})` 默认只看 squad：fresh=可派；watch=做完当前、边界要求 checkpoint；stale/spent=**先 reset 复用**；只有换身份/角色且 `allowSpawn=true` 才 `relay_renew`。
- 记录布局：`.scratch/context-relay/team/<leadSessionId>/{roster.json,<lineage>/{profile.md,checkpoint.md,ledger.ndjson,handoffs/gen-N.md}}`；v0.3.1 及以前的 `<lineage>/…` 为 legacy（只读回退，不迁移）。链式召回 = 旧会话 `session_event_read({session_id, seq})`（同 workspace），快照权威 > 指针 > 旧会话；reset 在 chain 记 `kind:'teammate-reset'`。
- 不做成员数硬限制（DSH 的 8 是并发活槽、空闲队友自动卸载）；团队全双工 inbox/stop 为后续阶段（派活/收口已由 relay_dispatch/relay_collect 提供）。

## handoff（有界 schema）

- 顶层：`status`（phase / goal / success_criteria / done / next_actions / blocked）、`evidence`、`decisions` / `constraints` / `open_questions` / `risks` / `discarded`。
- **体积与条数仅 advisory**：摘要目标 ≤8KB；evidence 用户 ≤11 条（插件另附 doc_lint）、done ≤12、next_actions ≤8、decisions ≤10 等用于生成有界摘要，不作为拒绝交接或丢弃原文的硬门。
- **交接单 = 摘要 + 完整落盘**：超限不拒绝；完整用户证据/决策/未决项与清理清单保留在文件中，新会话只注入有界摘要与全文指针，按 `relay_doc read` 的 section/offset 续读；单行截在字节边界时将 `nextByteOffset` 作为 `byteOffset` 一起传回。长线进度超阈值归档，不丢历史。细节优先写入 L2 并用 key_docs 引用；给用户汇报只说工作结果，不复述截断机制。
- 只接受 `status.*` 与顶层 `evidence`/`decisions`/`constraints`/`open_questions`/`risks`/`discarded`；旧平铺别名（goal/assets 等）已移除（Wave2），平铺字段会被忽略。

新会话的首条消息 = 这份 handoff +「## 接手入口」（progress.md 长线状态 / chain.ndjson 召回索引 / `session_event_read` 指针；v0.2.15 合并原两段，细节见常驻协议）；新 Lead 的第一件事是用 relay_phase 声明 phase，而不是重新探索。

- **交接纪律：交接前先写好文档（2026-11-01 用户追加裁决 A：协议纪律 + 顺序保证）**：交接前先把本次工作的文档写完——phase brief 与收尾三清单（已完成 / 未完成（原因）/ 未尝试（原因））、关键决策与证据指针、滚动进度文件要交代的长线状态（`doc_lint` 由插件自动跑并写入 brief/evidence，需补查可手动跑；UNKNOWN 写明原因）。`relay_handoff` 写盘顺序保证：先写 handoff 快照文件 → 创建新会话 → 更新滚动进度文件 `progress.md` → 才把首条消息（handoff 内容 + 路径）发给新会话；工具**不因 `doc_lint` 失败拒绝交接**（doc_lint 只作证据，硬门方案已被用户否决）。

- **交接清理（2026-11-01，自动执行）**：relay_handoff 成功后插件会**中断运行中的队友/子智能体并释放驻留子级、取消旧会话树（含队友/子智能体名下）的后台任务、把定时任务迁移到新会话**；交接清单写进 handoff 首条消息，清理结果只追加到 handoff 文件与工具返回 handover 字段——**不再给新会话另发消息**（2026-11-01 用户要求，v0.2.5）。旧会话因此不残留工作（best-effort：单项失败进 errors、定时任务迁移失败保留旧行）——接力后不要再在旧会话开新活。服务未启用按 N/A 跳过；盘点/单项失败会记录在返回体 handover.cleanup.errors（不阻断接力）。

- **接力隔离**：模式和授权不跨会话继承；新会话默认压缩继续、免审从零开始，旧会话成功交接后清全部授权。只继承非授权 architect/architectModel；schema 版本变更即失效旧授权（v0.10.0 起 panel schemaVersion=3）。handoffPreset 等旧字段已删除。

## 工作台账（v0.6.0；当前 phase 的工作队列）

- **什么时候用**：长任务 / 多分支（多模块、多路调研、多队友各管一块）/ 要跨 phase、压缩或交接时。台账是**当前 phase 的队列**，插件负责把队列摆到眼前，不靠模型自觉。
- **开 phase 列分点**：`relay_phase({phase, items:["…","…"]})` 只在**主链跨 phase（开新阶段）**时登记 1–8 条（单线程小任务 `items: []`）；新条目默认 phase=当前 phase，跨 phase 用 `carry:["id"]` 显式带走（记 carriedFrom）。**同一个 phase 里再传 items 会被显式拒绝（零副作用）**——补分点用 `relay_work_items`。
- **闭环（事件驱动，不看时间）**：焦点行 `[台账·build 2/4] doing「…」next「…」` 只在**焦点文本变化**时注入（rev 变化不算；同一 step 到线/边界 notice 优先，最多一条）；**只有真正写文件的工具（write/edit/apply_patch）**成功但没落账 → 下一步提示「[闭环] 上一步改动未落账」（同一未落账签名只提示一次；只读 bash/侦察不再误报）；分点 done 后提示下一个；relay_work_items 成功即视为已落账；只读调用 `relay_work_items` 不清 pending。
- **关 phase 闸门**：本 phase 未 done 的分点应收口（done 要 evidence / blocked 写原因）或 carry；`phase=null` 条目视同本 phase 纳入闸门（不能绕过 strict）；默认 warn 提示，`workItemsPhaseGate` 可配置 strict 拒绝或 off。
- **读写**：relay_work_items()读；仅Lead整表替换（rev乐观锁）；队友/子代理不读写；派活/收口用 relay_dispatch/relay_collect（自动写 owner+next 并置 doing / 读 digest 后置 done 或 blocked）。会话级文件 `.scratch/context-relay/work-items/<session>.json`，交接复制到新会话。
- **字段规则**：执行状态/依赖/验收以官方任务板为准，台账只引用 officialTaskId，不复制；台账status只表示Lead管理动作。open可无next，doing须next，blocked须原因，done须evidence（ship严格校验）；**build/verify 分点 owner 必须写 worker；Lead 自做必须在 done 的 evidence 记 `lead-exec:<原因>`**（build→verify 默认 warn 校验，strict 档可配、命中即拒）。默认上限30，超限先归档done到同目录 `<session>-archive.ndjson`；无done可归档才拒绝新增，归档失败不写台账；archive.path/count可查，不自动删。`relay_phase` 的旧 `next_operation` 入参已删除（v0.10.0），下一步只走条目 `next`。
- **对账**：交接把未闭合项写进 next_actions（≤8）；压缩 brief 带「未闭合工作项」段；切 phase 响应带分点摘要（planned/done/opened/carried）与 `carryIgnored`（carry 里无效 id 会显式列出）。
- **删除条目**：未完成须显式drop；整表移除done与drop的done均先归档，记录reason，归档文件可读。
- **面板**：composer 状态条旁「台账 N/M」胶囊；只读，编辑走工具。
- **队友状态不轮询**：`relay_team_status` 状态没变的重复查询会被拒绝；回执自动送达；等队友 = 结束回合或推进队列下一分点。
- **phase 边界自动 triage（v0.6.1）**：跨 phase 的 `relay_phase` 响应带 `team:{members:[{name,band,action}],pending,hint}`（Lead 有队伍时）——按 band 执行：ok 复用 / warn 收口后 checkpoint / organize·relay 清空复用（freshen reset，0 额度）/ 换身份才 renew；不需要主动查 `relay_team_status`。
- **上下文不靠记忆（v0.6.3；批次4 起去重）**：焦点行同一次注入还会带 `[上下文] band=…`（只在档位/边界动作变化时出现，到线 notice 已带的不重复）、`[队友] 队友待处理 N：name(band)…`（只在新队友或档位上升时出现）与 `[闭环]` 提示——事件驱动，同一 step 最多一条 notice，重启后首次汇总一次；快照 `.scratch/context-relay/team-context/<leadSessionId>.json` 落盘，压缩/重启后仍在。**每次派活前先读状态、由 Lead 判断（Lead 的活，和 Lead 自己的上下文管理是一条线）**：Lead 手工 `send_message` 派活时，插件先读该队友档位/状态，**首次派活或档位/状态变化**时给一次判断点（deny：本条消息不发出；`relay_dispatch` 内置同样的档位检查，脏上下文默认拒绝）——到线/读不到：①先管理再派（relay_checkpoint 收口 → relay_freshen({reset:true, brief}) 清空复用，换身份才 renew，处理完重派）；②直接派（原样重发即放行 = Lead 的判断）。同档位/状态的后续派活直接放行，不再重复打断（退役代恒拦）。忙队友（running）只有到线/读不到才拦，普通协调消息不拦。队友到线/读不到时跨 phase 建议 `relay_phase({…, team_note:"一行处理结论"})` 作为兜底，缺失只warning，不拒绝；处理后快照标 handled、焦点行不再重复催。

## 专职架构师（单一模式）

- **分工**：Lead 只与用户对齐需求 + 读项目文档理解业务；**工程实现路线交给固定队友 `architect`**。
- **模型**：默认值跟随「模型」选择器的默认选择（即 Lead 当前模型；未显式选过=取模型默认值，已选过则沿用该选择）；可在 composer 模型菜单「架构师模型 / 架构师推理等级」行随时覆盖（显式覆盖需在官方子代理白名单内），选「默认（跟随模型选择）」恢复跟随；显式选择按会话持久、handoff 继承。
- **只建一次**：relay_team_status 看队伍，没有就 `relay_architect({mode:'fresh', brief, doc_pointers, write_scope})`（工具内置固定 lineage、spawn 与首批 brief）；之后固定复用，不按任务重建。
- **每次任务低上下文**：架构师只读必须上下文（需求 brief/文档指针/模块入口），交付工程实现文档（默认 `.scratch/context-relay/architecture/<task>.md`：需求对齐/技术路线/模块接口/数据协议/风险取舍/待决策/实现步骤与验收）；交付后只 `relay_checkpoint` 归档并等新任务；**不要让它交付后自行清空**——新任务到达时由 Lead 按需要决定是否 `relay_freshen({reset:true, brief:新任务})` 再派。
- **决策回人**：文档里的「待决策」由架构师报 Lead，Lead 与用户敲定后再回传；架构师不直接问用户、不自行拍板。
- **Lead 按文档派实现**（队友/子代理），只做验收抽样；实现偏离文档 → 回问架构师，不自行改路线。
- **开关**：composer「预算无上限」旁的「架构师」小胶囊（按会话、relay-long 显示）；关掉则 Lead 不外包路线设计（架构师段不注入）。

## 状态机出口与容量保全

- 任意 phase 可 `relay_phase({phase:"blocked"|"cancel", exit_reason})` 显式退出，原因必填；退出不删历史、不替代用户门、不走台账/预算闸门；恢复从退出前phase继续。verify→build返修允许，ship只能从verify进（**ship→blocked/cancel 后可恢复回 ship**，仅当本次退出确实从 ship 退出；门禁不放松）。
- 唯一中途例外为容量保全 notice（默认 55%，`settings.capacityThreshold` 独立配置）：立即收尾当前动作、停止开新活/派活，写 brief/progress/台账，再按模式与授权准备压缩或交接，不自动执行；窗口未知时容量不判定；预算档本身不构成中途打断例外。

## 禁止

- 不在 phase 中间整理历史（破坏前缀缓存、丢在途上下文）。
- 不在 phase 中段因预算打断工作、或提前压缩/接力（预算是 phase 边界闸门：本 phase 做完，开新 phase 前用 `budget_plan` 估计；2026-11-01）。
- 不试图删除历史（DSH 只能遮蔽替换或开新会话）。
- 不自行裁决 P0；不代人类回答偏好；不在人类选择前自行压缩或接力（两者都是可选项）。
- 不绕过人工确认：交接写 `human_approved:true` 后仍会走官方审批（面板 `autoHandoff` 或 `authorizeNext` 才是显式免审；模式不产生豁免）；不要用 `handoffApproval='off'` 规避本应确认的接力/压缩；不要自行打开面板自动授权。
- 不跳过设计门：首次进 build 没有用户确认过的 `design_gate` 就不开工（工具会零副作用拒绝）。
- 不把队友上下文当无限资源：队友也压在 organize 档以下，phase 结束就停止派活。
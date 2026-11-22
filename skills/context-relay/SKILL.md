---
name: context-relay
description: "接力模式（relay preset）操作手册：phase 状态机、风险档与设计门、relay_status/relay_phase/relay_organize/relay_handoff/relay_work_items/relay_doc/doc_lint、派活与收口（relay_dispatch/relay_collect）、队友保鲜（relay_checkpoint/relay_freshen/relay_team_status/relay_renew）、专职架构师（relay_architect）、阈值、到线提醒与 composer 面板。用户切到接力模式、要求上下文整理/会话接力/phase 管理/多分支任务台账/团队保鲜时使用。"
disable-model-invocation: true
---

# Context Relay 操作手册

> 硬规则唯一真源 = `lib/agent/protocol.js` 的 `REDLINE_PROTOCOL_TEXT`（10199，system 最末）+ `PHASE_PROTOCOL_TEXT`（10150）；本 SKILL 只讲用法与指针，硬门以协议为准（摘要不构成第二真源）。
> 交互口径唯一真源 = 红线段 §与用户交互（判断/三种形式/正式汇报四项）；本 SKILL 不复述模板。

## 何时用

- 用户选择「接力模式（Relay）· 超长任务」时用；一次性小改用普通会话更便宜。
- 模式只决定「做什么」，不产生审批豁免：免审只来自 autoCompress / autoHandoff / authorizeNext；**模式和授权不跨会话继承**，接力/版本变更即失效。**新 root 默认压缩继续**。

## Lead 职责（只管理，不亲自执行）

- 只做四类事：**用户交互、决策（裁决）、派活、验收抽样**（外加聚合回执）；**不亲自改码/跑测试/写实现文档/读长日志**。
- **不设自做额度**：没有「小任务自己干」例外；实现/调查/写文档/跑命令一律 worker；需要执行就**派活或拆票**。
- 验收抽样 ≤3 次/phase 的 read/grep；执行占比看 `relay_status.delegation`（委派统计），**目标 ≤20%**（warn 只提醒，strict 可配、命中即拒）。
- 工具面裁剪只是护栏；PTC 里 node:fs 直写是执行软约束，靠自查与回执。**worker 必须亲自写/跑**，本段不放宽队友协议。

## 一轮的标准动作

1. `relay_status`：看 phase/band/continue/budget/plane/delegation/diagnostics。
2. `relay_phase`：discover→decide→build→verify→ship；**discover/decide 必填 `exit_criteria`**；**T2 首次进 build 必带 `design_gate`**；**ship 只能从 verify 进**；ship 返修须显式 `reopen{reason,user_approved:true}`（T0/T1 免用户确认），新任务声明 discover。
3. **预算 phase 优先**：只当 phase 边界闸门，中段不因预算打断；**warn 档切 phase 必填 `budget_plan{action:proceed|split|relay}`**；放不下就拆票或先 relay；**容量保全** notice 出现立即收尾、停开新活、写 brief/progress/台账，再按授权压缩/交接。
4. 到线处理：`warn`=现在动手（压缩/清空复用/交接三选一）；`organize`/`relay`=兜底告警；**容量保全**=最坏兜底（`settings.capacityThreshold`，默认 55%）。
5. 收尾：写 phase brief（关键文件索引 ≤8 条）+ 三清单（已完成/未完成原因/未尝试原因）。

## 派活与收口（工具化：relay_dispatch / relay_collect）

- **`relay_dispatch({itemId, brief, docs, writeScope, acceptance})`**：取台账分点→复用/新建 worker→标准 brief→台账写 doing+owner+next；缺字段拒绝。
- **`relay_collect({itemId, waitMs?})`**（≤120s）：读回执头 3 行（task/revision/verdict）+ digest（≤600 字），台账 done（evidence=reportPath）或 blocked；回执缺证据标 `unverified`。
- **回执契约**：报告 ≤4KB；头 3 行是机器契约、**不贴用户**；落盘后只发 1 条 ≤200 字消息。
- **不手工派活/不轮询**：执行活不要手工 `subagent`/`send_message`（只读审查/探针例外，回填 report+commit）；不要轮询 `wait_agent`/`list_agents`。
- **owner / lead-exec**：build/verify 分点 owner 必须是 worker；Lead 自做在 done evidence 记 `lead-exec:<原因>`。

## 两段式用户门（设计门 + 实现↔设计对齐）

- **（A）设计门（开工前，显式停）**：T2 首次进 build 必须带 `design_gate{path,user_approved:true,ask_ref,not_doing}`（用户确认的设计文档+逐字原话 ≤300 字+1–10 条不做）；缺任一零副作用拒绝。T0/T1 设计写进 goal/exit_criteria。
- **（B）实现↔设计对齐（ship 前，独立审查）**：用新上下文做独立审查，给完整上下文索引；只查「需求↔设计与实现」对齐（偏移/劣化/偷懒/缺失），**不重跑技术验证、不重读第三方源码**；**最多 1 轮**；**审查超时或未完成不算通过**。结论写 `user_gate.review`，大白话 `report` 汇报；宿主只强制非空、不校验顺序。
- **验收只做最小必要**：默认=目标模块测试+单次 diff 审查+语法检查；`tier=heavy` 无 `approved_by_user:true` 即拒；重型验证默认不做、须用户明确授权。
- **边界问题即发现即报**；**人类注意力最小高影响**：只打扰会改变结果/边界/不可逆处；问题批量一次问清（推荐+默认+后果，**不限题数**）。
- **ship 前自检**：`contract_check{requirement, fidelity, attention}` 三项答不出就别 ship。

## 风险档与设计深度模板（篇幅只作 advisory）

- **T0 文档/琐碎**（≤20 行且仅文档；缺 paths/lines/reason 降 T1）：不写设计稿；goal 写「改什么/怎么验」；免设计门/exit_criteria/phase 收口/contract_check/budget_plan/user_gate，ship 仍须 diff 证据。
- **T1 局部代码**：设计写 goal/exit_criteria ≤1 页；免设计门/contract_check/budget_plan；ship 须 report（正式汇报）+ 一次 diff 审查。
- **T2 高风险**（公开面/数据格式/权限/不可逆/大改或无法判定）：**七段 ≤3 页**（需求/路线/接口/数据/风险/待决策/步骤与验收）；**提案 ≤5** 条（推荐/默认/回滚）；全门。
- `design_gate`：`ask_ref` 逐字原话 ≤300 字；`not_doing` 1–10 条；超篇幅/提案 >5 只 `doc_lint` advisory。

## 用户汇报（Lead 是唯一对用户说话的人）

- 交互口径唯一真源 = redline §与用户交互：先判断值不值得打扰，再挑一句话 / 裁决卡 / 正式汇报中最轻的形式。
- 正式汇报说清四件事：变化 / 影响 / 需要你做什么（含推荐与默认）/ 边界；宿主只校验非空，字数与倾倒日志只 advisory；不套模板。
- 工具返回只作内部事实，不是用户话；裁决卡与 P0 报备按 redline 硬规则执行（P0 超时≠同意）。

## composer 面板、到线与阈值

- 面板「接力」chip：模式（继续/压缩继续/接力新会话；问我=未设）本会话持久（不消费）；`autoCompress`/`autoHandoff`/`authorizeNext` 是唯一免审来源。
- 四档语义：`warn`=现在就该动手；`organize`/`relay`=兜底告警；`容量保全`=最坏兜底（`capacityThreshold` 默认 55%，不自动执行）。只在升线时提醒。
- 阈值唯一来源 = 插件 config / `settings.threshold`；`relay_status.budget` 给 headroom。

## 工作台账（phase 工作队列）

- 台账是 Lead 的项目管理队列；`relay_phase({phase, items:[...]})` 登记 1–8 个分点（单线程 `items: []`），跨 phase 用 carry；`relay_work_items` 领取写 doing+next，done+evidence，blocked 写原因；关 phase 前收口或 carry。
- **`officialTaskId`**：执行状态以**官方任务板为准**，台账只引用 id，不复制状态/依赖/验收。
- **完成确认门**：非 done→done 前必须 `lead_confirm={no_drift,no_missing,no_regression}` 三项 true；缺失整表零副作用拒绝。默认上限 30，超限归档 done。
- 台账跟会话走；交接自动复制并带未闭合项（≤8 条）。

## 队友保鲜与团队

- 固定小队默认上限 8（含架构师）、**spawn 默认允许**（受 squadMax；`allowSpawn:false` 可关）；优先复用，不够再 dispatch/renew。
- 换人=让该队友先自己 `relay_checkpoint`，再自己 `relay_freshen({reset:true,brief})` 真清空复用（同成员、不占额度；Lead 不代调）。
- **worker 开工前自评**：dispatch brief 第 0 段要求两问（needPriorContext / canFinish），需要清空时自己 `relay_freshen({reset:true, prestart:true, dispatch_id, self_assessment, brief})`；同 dispatch 只允许一次 prestart。任务过大→回执 `verdict: needs-human` + `assessment action=needs-split`，由 Lead 拆票；中途（doing）不得 reset/freshen（B）。
- `relay_team_status` 只看当前 squad；退休代只审计，旧细节 `session_event_read`；`manage` 做 retire/adopt/maintain（不擦除、不 spawn、不手改 roster）。
- `relay_renew` 只用于换身份/角色（spawn 未关）：没有 checkpoint 不换代；member-limit 不要重试。
- 到线（organize/relay）**不停工**：只记 incident（`relay_status.incidents` 可查），任务继续到完成，边界再管理；队友不能自行 `relay_organize`/`relay_handoff`、不询问用户；结论/边界/未决项回执 Lead。

## 专职架构师（固定队友 architect）

- 分工：Lead 只对齐需求、读文档理解业务；**工程实现路线设计交给 architect**；机制/协议/汇报方式的诊断与设计也先交 architect，Lead 不自行拍这类方案，结论由 Lead 与用户敲定。
- 模型：**默认值跟随「模型」选择器**；未显式选过=默认（跟随模型选择），已选过则沿用该选择；handoff 继承。
- 创建/清空：固定 lineage；新任务或要干净上下文 → `relay_architect({mode:'fresh', brief, doc_pointers, write_scope})`；连续低上下文 → `mode:'continue'`；架构师只写 checkpoint。
- 交付：默认 `.scratch/context-relay/architecture/<task>.md`；按文档派实现、只做验收抽样；「待决策」翻成裁决卡直接问用户（七字段）。

## 状态机出口与容量保全

- 任意 phase 可 `relay_phase({phase:'blocked'|'cancel', exit_reason})` 显式退出：不删历史、不代替用户门；恢复从退出前 phase 继续；允许 verify→build 返修。
- 容量保全（最坏兜底）：出现 notice 立即收尾当前动作、停止开新活/派活、写 brief/progress/台账，再按授权压缩/交接；不自动执行。

## 禁止

- 不删历史；不在 phase 中间整理历史、不因预算中途打断。
- 不跳过设计门/用户门；ship 前不省 `contract_check`；重型验证须用户授权；不在人类/面板选择前自行压缩/接力。
- **不自行裁决 P0；不代人类回答偏好；不用 `handoffApproval='off'` 规避确认；不自行打开面板自动授权。**
- 不把队友上下文当无限资源：phase 结束就停止派活。

## doc_lint

- **插件自动跑**：relay_organize 压缩前、relay_handoff 时自动执行，结论并入 brief/evidence；需补查可手动跑。
- `paths` 只接受 workspace 相对路径；探测不到 = UNKNOWN；FAIL/WARN 进 evidence，不阻断交接。
- `doc_lint` 只随 Lead 装配。

## 文档索引（docs v2）

- 持久文档带 frontmatter（role/layer/when）；先 `relay_doc index` 看 L0，再按 when 取 1–3 份；`relay_doc read/search/related` 支持 section/offset 与一跳关系。
- L0/L1/L2/raw 分层；消息里不贴长文，细节落 L2 给指针；字节/条数上限只是 advisory，超了归档/分层，不拒绝、不丢数据。

## 事件注入（插件 notice，不是用户发言）

- 到线只在升线/新起点/phase 边界注入；同一 step 最多一条；同档不重复。
- 台账焦点行只在文本变化时出现；`[闭环]` 每条未落账签名只提示一次；`[队友]` 只在档位上升时出现。
- 输出带「非用户发言」头/尾；模型不得复述，需要告诉用户时自己重写（不套模板）。

## 指针

- 常驻协议（唯一真源）：`lib/agent/protocol.js` → `REDLINE_PROTOCOL_TEXT`（10199）+ `PHASE_PROTOCOL_TEXT`（10150）；字节只做 diagnostic（不设失败门）。
- 设计/审计：`docs/design/DESIGN.md`、`docs/design/ARCHITECTURE.md`；任务文档默认 `.scratch/context-relay/architecture/<task>.md`。
- 报告：`.scratch/context-relay/reports/<taskId>.md`；进度：`.scratch/context-relay/progress.md`；链式索引：`.scratch/context-relay/chain.ndjson`。

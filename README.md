# dsh-context-relay

> 让 agent 在长任务里不走神、不走偏、越干越稳。

[English](README.en.md) · [npm](https://www.npmjs.com/package/dsh-context-relay) · [变更记录](CHANGELOG.md) · [迁移说明](docs/design/MIGRATION.md) · MIT

**DSH（DeepSeek Harness）上下文接力插件**：只有一个模式 **接力模式（Relay）· 超长任务**（内部 id `relay-long`）。v0.10.0 是「完整形态」交付：两段式用户门（设计门 + 实现↔设计对齐）、声明式 agent 平面、官方 seam 契约与降级可见、单一持久化层；旧版双模式与全部兼容路径已删除（见[迁移说明](docs/design/MIGRATION.md)）。它不换模型、不删历史，改的是长会话的组织方式：什么时候压缩、什么时候换新会话、怎么交接、哪些事该交给人来定。

## 它解决什么问题

一句话版：

1. 会话上下文始终待在高效区间，长任务不会越聊越飘；
2. 提高人机交互效率，让 agent 知道哪些问题该交给你判断；
3. 优化长任务、复杂任务的执行能力，降低偏移；
4. 配合官方智能体团队使用，获得双层架构，长任务能力再上一档。

### 1. 让会话上下文保持在高效区间

对话越长，agent 越容易遗忘、重复、过度发挥。本插件给会话设了「水位线」：

- 到线之前，agent 先把「接手这个活需要知道什么」整理成一页交接材料：目标、已定决策、证据、下一步；
- 然后压缩旧对话，把这一页放回对话里，接着干，不断片；
- 到更高的线时，把活交给一个全新会话，旧会话保留作审计；
- 压缩点放在阶段边界，不打断手上正在做的事；被一起收起来的补充说明和用过的技能，会提示「需要时重读」。

效果：长任务不必靠「一次把话说全」，而是在有限记忆里持续推进。

### 2. 提高人机交互效率：让 agent 知道哪些问题该交给你判断

判断标准很简单：会不会改变结果、边界或代价。会，才问人；不会，自己查。

- 能自己查清的事实先查清，只把真正需要你拍板的问题交上来，不拿琐事打扰你；
- 提问先说结论和影响，再给选项（推荐 + 默认 + 后果），等你一句话；
- 不可逆、对外、付费、凭据、删除这类动作，先停下来说清「做什么、为什么、怎么撤」，拿到明确同意才动；
- 同一类问题不重复问；你给过的答案会记住，并带进交接。

### 3. 优化长任务、复杂任务的执行能力，降低偏移

- 工作分五个阶段推进：摸清情况 → 定方案 → 动手 → 验收 → 交付；
- 进下一阶段有明确条件，每个阶段有完成标准，「做着做着换了目标」更难发生；
- 上下文到线只是「该不该换阶段」的闸门，不打断当前工作；
- 开工前先过设计门（设计交你确认才动手），交付前必须让一个全新上下文的审查者独立核对「需求 ↔ 实现」，防止自己夸自己。

### 4. 配合官方智能体团队，获得双层架构，长任务能力再上一档

- 唯一模式下，Lead 只负责拆活、派活、验收，具体实现交给队友，上下文压力分摊到两层；
- 队友上下文脏了可以原地擦干净重来（真清空），或者换个身份重来，工作记录仍保留；
- Lead 自己到线时交给新会话：旧会话树里还在跑的队友和后台任务会先被中断，新会话凭交接单和进度文件重建团队与工作记忆（不是原地接管旧团队）；
- 两层都能长期待在高效区间，长任务的上限被明显抬高；
- Lead 派活后不会空转等队友：队友回执会自动送达，只有真正被阻塞时才等一次，其余时间继续干活（省 token）。

## 唯一模式与升级

| 模式 | 适合 | 特点 |
|---|---|---|
| **接力模式（Relay）· 超长任务** | 特别长、特别复杂、适合分工的任务 | Lead 只调度不亲手改代码，活派给队友；队友可清空、换代，长任务更耐跑 |

唯一模式保持「人来把关」：不自动循环、不替你自动批准。

默认 4 人小队，优先复用；按需扩到部署 `maxActiveSubagents`，满额排队/报阻塞。派活 brief 五字段缺一不可：目标 / 必读 1–3 份（指针+when/role，按序自取）/ 写范围 / 验收 / 回执路径。**执行活先派活**：Lead 执行占比目标 ≤20%（`delegationGate` 默认 warn 只提醒、不硬拒；strict 档可配，命中即拒）。

**v0.10.0 是破坏性版本**：classic `relay` 别名、双模式配置、cth/autoChoose/autoDecision/handoffPreset、legacy thresholds、`next_operation` 等兼容路径全部删除；面板授权契约版本升到 3（旧授权一次性失效）。升级前先看[迁移说明](docs/design/MIGRATION.md)。

## 两段式用户门（v0.10.0）

交付前有两个必须对齐的点，不靠实现者自证：

1. **设计门（开工前，显式停）**：把设计（架构 / 改动面 / 验收口径 / 风险）交用户确认；确认后 agent 首次进入 build 必须带 `design_gate{path, user_approved:true}`（用户确认过的设计文档路径），缺失时 `relay_phase` 零副作用拒绝。
2. **实现↔设计对齐（执行中 / 验收）**：声明完成（ship）前，必须让**新上下文**模型做一次独立审查（需求 ↔ 实现：偏移 / 劣化 / 偷懒 / 缺失），审查与其他验收并行、不串行终检；结论写入 `user_gate.review`，再用大白话 `user_gate.report` 汇报（非空硬门，不弹审批弹窗）。
3. **验收只做最小必要**：默认 = 目标模块测试 + 单次独立 diff 审查 +（必要时）一次语法/静态检查；全量/真机/大样本/多轮审查/跨环境/压测等重型验证默认不做，须用户明确授权（`user_gate.verification{tier:'heavy', approved_by_user:true}`，否则拒绝）。
4. **contract_check 只在 ship 必填**（需求是否已定 / 实现是否忠实 / 注意力自检）；其他阶段可选。

## 设计文档

仓库内提供可发布的设计摘要（面向仓库读者；内部逐条设计点与审计记录不随仓库发布）：

- [架构说明（ARCHITECTURE）](docs/design/ARCHITECTURE.md)：分层与落点、9 个官方 seam 契约与降级、agent 平面 reconcile、持久化/策略/notice 分层、phase↔台账契约（v0.10.0）。
- [设计说明（DESIGN）](docs/design/DESIGN.md)：定位、七条设计目标、边界、关键设计点摘要与验收口径。
- [迁移说明（MIGRATION）](docs/design/MIGRATION.md)：0.8.x → v0.10.0 的破坏性变更、升级/回滚步骤与保留数据。

用户使用方式见本 README；逐版本行为变更见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

要求：DSH `>=0.2.2-rc.2`（只支持这一代内核）、Node.js `>=20`。已验证 DSH 0.2.2-rc.2：preset 行跟随官方 ptc patch；团队能力（体检/换代/架构师）由 subagent 树适配；台账为 Leader-only，队友不读写。

### 方式 A（推荐）：DSH Web UI 侧栏「插件」安装

全程在 Web UI 里完成，不需要命令行：

1. 打开 DSH Web UI，点左侧栏的 **「插件」**。
2. 点右上角 **「添加插件」**。旁边的箭头是「选择添加插件方式」菜单，其中「安装第三方插件」进入同一个对话框。
3. 在安装对话框的 **「插件包名」** 里填 `dsh-context-relay`；需要固定版本时在包名后加 `@版本号`。对话框也接受 Git 地址、压缩包或本地绝对路径。
4. **「安装源」** 保持默认即可：首次使用会自动在 npm 官方源与中国大陆镜像源之间探测，选先响应的那个；也可以手动选 npm 官方源 / 中国大陆镜像源 / 自定义 http(s) 地址。
5. 点 **「安装」**。Host 先读取这个包并在对话框里显示包名、简介与版本，pnpm 的命令和输出收在 **「查看安装详情」** 里。
6. 安装完成后点 **「立即启用」**；如果关掉了对话框，到「插件」页的「已安装插件」里打开 `dsh-context-relay` 组合包的开关。
7. 按页面提示 **重启/重载对应 profile**（启用 HMR 的 profile 会自动重组；否则重启 `dsh web`），然后 **刷新页面**。
8. 新建会话：模式选择器里应出现 **接力模式（Relay）· 超长任务**；选中后，输入框上方应出现状态条——两者都出现即安装成功。**也可以先建默认会话再切换**：在模式选择器里选 Relay 即可（首轮前或会话中都可以），插件会自动回填 Lead 工具面并裁剪执行工具（`relay_status.plane` 可自检）。
9. （可选）「插件」页里 `dsh-context-relay` 的配置卡片可调水位线基准与面板默认值。

**排障**

- 装完看不到模式 → 确认组合包已启用、profile 已重载、页面已刷新；**安装成功不等于模块已激活**。
- 看不到状态条 → 只有接力会话会显示；确认当前会话 preset 是 Relay（可在模式选择器切换，切换后自动生效）。
- 插件升级/重载后，既有 relay 会话会被幂等回填（不再要求重建）；如果某会话仍显示旧行为，切一次 preset 或新建会话。
- 需要升级 → 在「插件」页卸载后重新安装（本插件不是官方按需组合包，没有内置「更新」入口）。

### 方式 B：命令行

```console
dsh plugin --profile web add dsh-context-relay
```

也可以从 Git 仓库或本地目录安装：

```console
dsh plugin --profile web add github:rezon-aki/dsh-context-relay
dsh plugin --profile web add /path/to/dsh-plugins/dsh-context-relay
```

安装后同样需要重启/重载 profile、刷新页面，再新建或切换接力会话。

## 装完是什么样

- 模式选择器唯一生产项为 **接力模式（Relay）· 超长任务**（classic 别名已删除；旧会话处理见[迁移说明](docs/design/MIGRATION.md)）。
- 输入框上方多一条**状态条**（仅接力会话显示）：当前上下文用到多少、到没到线、现在是什么模式；点开就是面板。侧栏插件页/面板上会提示某个会话的授权是否需要重新开启（v0.10.0 升级后旧授权一次性失效）。
- 记录过工作项之后，状态条旁边会多一个**台账胶囊**：`台账 3/8` = 未闭合 / 总数（进行中显示琥珀点、阻塞显示红点）；点开是完整的**工作台账面板**。
- 面板里你可以：
  - 选到线时的处理方式——问我 / 继续 / 压缩继续 / 接力新会话；新 root 默认压缩继续，显式选择保持，模式和授权均不跨接力继承；
  - 给「压缩」「交接」或「只下一次操作」开自动授权（开了就不再每次弹审批）；
  - 打开「预算无上限」：agent 会收到一句「你的 token 预算无上限」，让它敢花 token（只改提示词，不改系统配额）；
  - 看模型建议的做法（只是建议，不会自动执行）。
- 到线时会收到一条状态提醒（不是你的消息）：只报状态和「先把阶段内的事做完」，不打断当前工作。
- 唯一模式包含队友管理：查看团队状态、给队友打检查点、原地清空、换代。队友状态**不轮询**：状态没变的重复查询会被直接拒绝，回执会自动送达；阶段切换时会自动给出队友 triage（谁该打检查点、谁该清空复用、谁该换代）。

### 界面截图

接力面板历史截图（当前表盘仅问我/继续/压缩继续/接力新会话）：

![接力面板](https://github.com/rezon-aki/dsh-context-relay/blob/main/docs/images/relay-panel.png?raw=true)

## 日常怎么用

1. 新建会话时选 **接力模式（Relay）· 超长任务**（或建好后在模式选择器切换），然后像平时一样提需求。
2. agent 会自己按阶段推进：该压缩时压缩、该交接时交接、该问人时问人。
3. 到线时按面板里你选的方式处理；没选过（问我）就先问你。
4. 想手动控制直接说，比如「压缩一下」「交接个新会话」「这次先问我」。
5. 到线提醒出现时不想理会也没关系，继续给指令即可——它不会擅自压缩或换会话。

## 汇报、授权与容量边界

- 对用户正文（含 user_gate.report）建议四段：结论：结果；影响：用户可见变化；需要你做什么：裁决/无需；证据位置：最多3个路径。默认≤600字；明确要细节用 details_requested:true，展开建议≤4000字。格式/长度只提醒不拒绝，warning随phase结果+一次性notice，绝不阻断ship/任何phase；非空review/report门保持。
- 不贴命令输出/日志/长 diff，不堆内部字段/错误码/术语；术语首次出现给人话解释。
- 授权绑定会话+操作+版本，不跨会话继承，接力/版本变更即失效；模式不产生免审。只继承非授权架构师设置；新会话默认压缩继续。v0.10.0 起面板授权契约版本为 3：旧 panel.json 载入时一次性失效全部会话授权（模式/架构师设置保留）。
- 任何phase可带exit_reason进入blocked/cancel出口，不删除历史、不代替用户门，恢复从退出前phase继续；verify→build可返修，ship只能从verify进（ship→blocked/cancel后可恢复回ship）。审查超时或未完成不算通过，可续审/换人复审。
- 唯一中途例外为已知窗口占比≥85%的容量保全：立即收尾当前动作，停止开新活/派活，写brief/progress/台账后按模式和授权准备压缩/交接，不自动执行。预算档本身不构成例外。

## 注入与结果体积（v0.10.0）

- **notice 规划/投递分层**：每 step 最多一条 notice（到线/边界优先，正文 ≤900 字符）；**投递成功后**才记去重键，失败下一步重试；正文统一脱敏（凭据不进入会话历史/UI）；`[闭环]` 只对真正写文件的工具（`write`/`edit`/`apply_patch`）触发——只读 bash/侦察不再误报；只读 `relay_work_items` 不会清掉未落账标记。
- **压缩复位**：官方自动压缩（`compactionSeq` 上升）后到线档位重新武装，焦点/闭环/边界去重键清空——压缩后该提醒的还会提醒。
- **队友 notice 不带 Lead 台账行**（队友工具面没有 `relay_work_items`）；指标不可用（`band=unavailable`）给一次性保守提示，不静默当 ok。
- **结果摘要化**：`relay_phase` 成功结果带人类可读 `text`（固定前缀行 `phase:/budget:/ledger:/team:/user_gate:/warnings:/lessons:/next:/hint:/summary:`），结构化字段保留；`goal`/`exit_criteria` 入参回显已删。
- **注入预算**：常驻协议 + 15 个工具 schema + 4 个角色（lead/teammate/architect/worker）装配快照都纳入预算断言，防工具面/协议文本无界回涨。

## 工作台账：当前阶段的工作队列

执行状态/依赖/验收以官方任务板为准；台账只引用 `officialTaskId`，只记 Lead 管理动作，不复制执行状态。超限先归档 done，归档为同目录 `<session>-archive.ndjson`，工具返回 archive.path/count；整表移除 done 也归档。

长任务跑着跑着容易偏：做着做着就忘了本来要做什么、做到哪了。台账把「这个阶段要做哪几件事」变成一张队列，插件会在关键时刻把队列摆到 agent 眼前——**不看时间，只看事件**：

- **开阶段先列分点**：`relay_phase({phase, items:["…","…"]})` 只在**跨 phase（开新阶段）**时登记 1–8 条分点（单线程小任务写 `items: []`）；新条目默认属于当前阶段，跨阶段要显式 carry。**同一个 phase 里再传 items 会被显式拒绝（零副作用）**——补分点请用 `relay_work_items`。
- **闭环记录**：当前分点 + 下一步以一行「[台账·build 2/4] doing「…」next「…」」注入——**焦点文本变化才注入**（rev 变化不算）；`write`/`edit`/`apply_patch` 改完却未落账，提示「[闭环] 上一步改动未落账」（同一签名只提示一次）；分点完成后提示下一个。
- **关阶段提示**：本阶段未完成的分点建议收口（done 带证据 / blocked 写原因）或显式 carry；`phase=null` 的条目同样计入关闸，不能成为 strict 绕过口；默认 `warn` 提醒后放行，`strict` 时才拒绝切阶段（单线程小任务用空 items 声明）。
- **上下文不靠记忆**：同批注入还带「[上下文] band=…」（档位/边界动作变化才出现，到线提醒已带的不重复）与「[队友] 队友待处理…」（只在新队友或档位上升时出现）——Lead 到线档位、队友谁该打检查点/清空/换代都在眼前；同一 step 最多一条 notice（到线/边界优先），重启后首次汇总一次；快照落盘，压缩/重启后仍在。
- **每次派活前先读状态由 Lead 判断**：Lead 给空闲队友发任务前（`send_message`），插件先读该队友档位/状态，**首次派活或档位/状态变化**时给一次判断点（这条消息先不发出）——到线/读不到：①先管理再派（让它 `relay_checkpoint` 收口，再 `relay_freshen({reset:true, brief})` 清空复用，同成员 0 额度，换身份才 renew，处理完重派）；②直接派（原样重发即放行，算 Lead 的判断）。同档位/状态的后续派活直接放行，不再重复打断（退役代恒拦）。忙队友只有到线/读不到才拦，普通协调消息不拦；忽略的，切阶段时会再提醒一次（warning，不拒绝）。
- **字段**：编号（短 slug）、标题、状态（待办/进行中/阻塞/已完成）、负责人、下一步、阻塞原因、证据、完成标准、依赖、所属阶段；`relay_phase` 的旧 `next_operation` 入参已在 v0.10.0 删除，下一步信息只走条目 `next`。
- **落盘**：`.scratch/context-relay/work-items/<session>.json`（会话级、Leader-only：每个根会话一份；交接时自动复制到新会话），agent 用 `relay_work_items` 维护；面板的 `GET /context-relay/work-items` 是纯只读（不会触发旧数据迁移写盘）。
- **对账**：交接时未闭合项自动变成新会话的「下一步」（最多 8 条）；压缩材料自动带「未闭合工作项」段；进「交付」阶段默认要求全部完成或阻塞。
- **面板**：输入框上方 `台账 3/8` 胶囊，点开按状态分组看全部条目；只读，编辑一律走 agent 工具。

没有台账文件时，一切行为与旧版完全相同——它是可选的。

## 专职架构师（固定队友，relay-long）

长任务里最贵的是「路线没想清就开写」。这个模式给团队配一个**固定架构师队友**（名字固定为 `architect`，只建一次、长期复用）：

- **Lead 只做两件事**：与用户对齐需求（边界/验收/取舍）、读项目文档理解业务与现状；
- **架构师把需求转成工程路线**：每次任务都以**低上下文**开始——只读必须的上下文（Lead 的需求 brief、文档指针、相关模块入口），产出工程实现文档（默认 `.scratch/context-relay/architecture/<task>.md`，含需求对齐/技术路线/模块接口/数据协议/风险取舍/待决策/实现步骤与验收）；Lead 用 `relay_architect({mode:'fresh'})` 换新上下文（旧代先 checkpoint），任务连续且上下文还低才用 `mode:'continue'`；交付后只 `checkpoint` 归档并等下一任务；
- **需要用户拍板的**：架构师写进文档「待决策」并报 Lead，由 Lead 拿去找你敲定，再把结论回给架构师——架构师不直接问你、不自行替你决定；
- **开关与模型**：composer 里「预算无上限」旁边有「架构师」小胶囊（只对「接力·超长任务」会话显示），按会话控制是否把工程路线交给架构师（默认开）。**模型在 DSH 的模型菜单里选**：点开输入框的模型选择器，「模型 / 推理等级」下面就是「架构师模型 / 架构师推理等级」两行，菜单外壳、定位与键盘/失焦行为由官方菜单负责（选完保持展开，方便接着调推理等级）。**显式覆盖受官方子代理模型白名单约束**：菜单中的显式模型只列本会话白名单内的模型；旧会话没有白名单记录时按官方语义只允许 Lead 当前模型（新会话会使用设置里的白名单）。**默认跟随 Lead 模型**：架构师模型默认取「模型」选择器的默认选择（未显式选过=模型默认值，已选过则沿用该选择），不拒绝、不阻塞；可在模型菜单「架构师模型 / 架构师推理等级」行随时覆盖（显式覆盖需在官方子代理白名单内），选「默认（跟随模型选择）」恢复跟随；选择随接力继承。

## 配置

宿主插件配置（可选，进阶项）：

| 键 | 默认 | 说明 |
|---|---|---|
| `threshold` / `settings.threshold` | 35 | 水位线基准（%）：提前 5 个点提醒，到基准线建议处理，再高 10 个点是硬线。**v0.10.0 起阈值唯一来源**；旧 `config.thresholds` 已删除。 |
| `settings` | 六个字段的默认值 | 侧栏卡片的初始默认值；你在界面上保存的值优先。 |
| `panelPath` / `settingsPath` | `~/.dsh/data/dsh-context-relay/…` | 面板和设置文件位置的覆盖。 |
| `architect` | `true` | 专职架构师开关的**默认值**（composer「架构师」小胶囊按会话覆盖；只在 relay-long 会话生效）。 |
| `workItems` | `true` | 启用工作台账（工具 + 闸门 + 面板）；`false` 完全回退旧行为（与 delegation-first 协议互斥，装载时 warn）。 |
| `workItemsGate` | `'strict'` | **交付（ship）阶段**的台账校验强度：`strict`（不合格拒绝）/ `warn`（只提示）/ `off`。交接与压缩始终把台账写进材料、文件损坏只警告（fail-open），不受本项影响。 |
| `workItemsPhaseGate` | `'warn'` | **切阶段（phase 边界）**收口提示：本阶段未完成的分点未收口且未 carry（含 `phase=null` 条目）→ `warn` 放行+提示（默认）/ `strict` 拒绝切阶段 / `off`。单线程小任务用 `items:[]` 声明放行。 |
| `delegationGate` | `'warn'` | **build→verify 委派闸门**：`warn` 只提醒不拒绝（默认）/ `strict` 命中即拒（拒绝切换、零副作用）/ `off` 关闭。检查会话累计 Lead 执行占比 >20%（样本 ≥10 次工具调用）与 build/verify 分点由 Lead 自做且无 `lead-exec:` 证据；`warn` 不阻断切换，`strict` 命中时拒绝 build→verify。 |
| `workItemsPath` | `（默认按会话）` | 台账文件位置覆盖：显式设置则所有会话共用该文件（旧 workspace 级行为）；默认按会话落在 `.scratch/context-relay/work-items/<session>.json`。 |
| `workItemsMax` | `30` | 台账条目上限（1–100）。 |
| `injectBrief` | `true` | 压缩成功后是否把那一页交接材料放回对话。 |
| `handoffApproval` | `'required'` | 压缩/交接必须走官方审批；没有审批界面的部署可以设 `'off'`（风险由部署方承担）。 |
| `inheritOnHandoff` | `true` | 交接后新会话沿用旧会话的模型和权限；`false` 则回部署默认。 |
| `longPresetId` | `'relay-long'` | 唯一模式 id（未配时由 `presetId` + `-long` 派生；`presetId` 默认 `relay`）。classic 别名与 `legacyPresetCompat` 已删除。 |

侧栏设置（人类可改，热生效）：水位线基准 + 默认模式 / 自动压缩 / 自动交接 / 架构师 / 预算无上限。

面板状态（按会话保存）：持久模式（本会话不消费，不随接力继承）、当前会话操作授权、预算无上限、模型建议等。

数据文件：`~/.dsh/data/dsh-context-relay/settings.json` 与 `panel.json`；对话内容仍由 DSH 自己存储。

## 文档分层与索引（v0.8.0）

跨会话文档不再用固定字节上限拒绝/截断，而是「索引 + 分层 + 按需取用」（对齐 DSH 官方指令文件 / 技能目录的模式）：

- **L0 索引**：`relay_doc index` 返回自动生成的文档索引（路径相对 `.scratch/context-relay/`，每条含「何时读」与大小/更新时间）；交接摘要与 phase brief 也自动带索引。索引按内容 digest 更新，不落盘、不会漂移。
- **分层**：L1 = handoff / phase brief / progress / lessons（新会话先读）；L2 = architecture / docs / decisions / research（按需）；reports/归档 = 原始指针（`relay_doc search` 取）。判断标准：新会话/新队友第一次开工必须看到吗？是 → L1，否则 → L2。
- **按需取用**：`relay_doc read` 支持按标题/行区间精读；`relay_doc search` 只回 `path:line` + 摘要；`relay_doc lint` 是 advisory 体检（缺 frontmatter / 坏指针 / 超大 / L1 超阈值）。团队派活给「必读：INDEX + 1–3 份」。
- **上限只做建议**：handoff / progress / lessons / chain / team 的字节/条数上限不再拒绝或丢数据——超了自动归档（`*-archive-*.ndjson`、`progress-archive-*.md`）或把完整内容落盘、消息里给指针；常驻注入仍保持有界。
- **写文档纪律**：持久文档加 frontmatter（`role:` 一句话 / `layer: L2` / `when:` 何时读）；写前先 `relay_doc search` 防重复；消息里不贴长文，细节落 L2。

## 技术参考：agent 工具与 HTTP 接口

共 15 个工具：7 个常驻 + `doc_lint` + 5 个 Lead 专属 + 2 个队友/架构师工具。工具面按角色裁剪：Lead 不装执行工具（bash/pwsh/write/edit 被隐藏），队友不装 Lead-only 工具，普通子代理只有最小三件套。

| 工具 | 作用 |
|---|---|
| `relay_status` | 读当前上下文占用、到线状态、阶段、剩余预算、派活/执行占比、agent 平面自检（`plane{role,installed,degradations}`）与建议。 |
| `relay_phase` | 声明或切换阶段；首次进 build 校验设计门 `design_gate`，交付阶段要求独立审查与汇报 + 验收分级；warn 档要求 `budget_plan`。 |
| `relay_organize` | 写那一页交接材料（自动附文档体检结论和关键文件索引）→ 官方压缩 → 材料注入回对话（含「压缩后需要时重读」提示）。每会话默认最多一次；人类在面板选『压缩继续』时按人类选择执行第二次（仍过审批）；无面板模式时第二次压缩需人类明确要求（`force`）。 |
| `relay_handoff` | 生成交接摘要 + 完整交接单文件（含滚动进度与工作台账），创建新接力会话并清理旧会话树；**超长不再拒绝**——摘要注入首条消息，完整内容落盘并按需取；rc.2 定时任务按 Host-wide target 迁移。 |
| `relay_work_items` | 读写 Leader 自己的工作台账：无参数 = 读；Lead 整表替换（可带 `rev` 乐观锁）；队友/子代理不可读写。 |
| `relay_recommend` | Lead 专用：把模型建议的做法写进面板（切阶段、压缩、交接、人类选择后清空）。 |
| `doc_lint` | 文档体检（配额 / 违禁措辞 / 索引 / git / relay 会话文档），输出 ≤2KB；配额与体积只做 advisory。 |
| `relay_doc` | 会话文档分层与索引：`index`（L0 索引）/ `list` / `read`（按标题/行区间精读）/ `search`（path:line 摘要）/ `lint`（advisory）。先读索引，再按需取最小上下文。 |
| `relay_dispatch` | Lead 专用：从台账取分点 → 复用/新建 worker → 发标准 5 字段 brief（目标 / 必读 1–3 / 写范围 / 验收 / 回执）→ 台账记 doing+owner+next；缺字段直接拒绝，返回 worker/reportPath/dispatchId（落盘为回执新鲜度权威）。 |
| `relay_collect` | Lead 专用：短等 ≤120s → 只读回执头 3 行（task/revision/verdict）+ digest（≤600 字）→ 校验 task 与 dispatchId → 台账置 done（evidence=报告路径）或 blocked（原因）；只回 digest，完整报告留报告文件。 |
| `relay_team_status` | Lead 专用：团队健康/档位/checkpoint/派活计数/reset 结果汇总；签名包含孙代理数量，状态未变的重复查询会被拒绝。 |
| `relay_renew` | Lead 专用：队友换代（换身份/角色才用；新代占并发额度，旧代 dispose 后释放）。 |
| `relay_architect` | Lead 专用：创建/续用固定架构师（`mode:'fresh'|'continue'`），换新上下文或接着设计。 |
| `relay_checkpoint` | 队友/架构师：写检查点（一行结论/完成/决策/证据/约束/未决/下一步，≤4KB advisory）。 |
| `relay_freshen` | 队友/架构师：同任务内减压（同代 ≤2 次、有损）；`{reset:true, brief}` 真清空并换新 brief（同成员、不占额度），成败都会以 notice 告知结果。 |

**接力模式（Relay）· 超长任务**包含团队工具：`relay_team_status`、`relay_renew`、`relay_architect`、`relay_dispatch`、`relay_collect`（Lead）与 `relay_checkpoint`、`relay_freshen`（队友）。架构师模型在输入框的模型菜单里选择（「架构师模型 / 架构师推理等级」两行；默认跟随「模型」选择器的默认选择（已选则沿用），菜单可覆盖，handoff 继承）。

HTTP（仅本机 GUI 认证后可用）：`GET/PUT /context-relay/settings`、`GET/PUT /context-relay/panel`、`GET /context-relay/architect-models?sessionId=`（按会话白名单过滤的架构师模型目录）、`GET /context-relay/work-items?sessionId=`（工作台账只读，供面板轮询；无迁移写盘副作用）。

## 安全边界与代价

- **审批**：压缩和交接默认要你点头；免审只来自面板里的自动授权（「压缩」「交接」「只下一次操作」）。面板模式本身只决定「做什么」，不产生免审。
- **官方 seam 契约与降级可见**：9 个官方 seam（preset/agents/tools/systemPrompt/compaction/projections/schedule/wipe/team）启动时做形状断言；内核形状不符时降级为 N/A + warn 并写入 `relay_status.plane.degradations`（不静默 fail-open，也不拒绝会话）。
- **PTC 程序通道是执行软约束（已知限制）**：工具面裁剪只隐藏 `bash`/`pwsh`/`write`/`edit` 这类**模型工具调用**；`run_code` 里的 `node:fs`、子进程等仍可直接写盘/读文件——插件**不做通道守卫**（已裁决），靠协议纪律、自查与回执约束，不承诺硬隔离。
- **团队与子代理**：DSH 0.2.2-rc.2 起队友本身就是 subagent 树成员，relay 不再区分「开子代理」与「用队友」，子代理创建由官方工具面负责。
- **交接会开新会话并消耗额度**：会中断旧会话树里正在跑的队友和后台任务，并迁移定时任务；旧会话标记为已交接，留作审计。
- **压缩有损**：旧对话细节只留在那一页材料里；重要结论请写进文档。
- **不自动循环**：relay 保持人来把关；重复性整块劳动请用官方 Ralph / workflow / subagent。
- **不可逆动作**：对外、付费、凭据、删除等先报备并取得明确同意，插件不会替你自动批准。

## 已知限制

- **preset 可切换（v0.10.0 起）**：插件通过 `agent/created` / 启动回填 / `agent-preset/selected` / 每步惰性兜底四个入口幂等安装 Lead 平面，「切换需新会话」已过时。若 `relay_status.plane.installed=false`，看 `degradations` 定位缺哪个 seam；仍不正常时切一次 preset 或新建会话。
- **PTC 程序通道为执行软约束**：只裁剪模型工具调用，不拦截 `run_code` 内的 `node:fs`/子进程直写（见上「安全边界与代价」）。不做通道守卫是已裁决项。
- 只在 DSH Web 环境验证；headless 等其它部署未验证。
- 压缩/交接的实际收益跟模型、任务长度有关，水位线不是对所有人都最优。
- 界面视觉细节没有自动化回归，安装后建议目检。
- 压缩的保真度和收益没做严格 A/B 对比；水位线拐点同样没有。
- 一个会话默认只压缩一次，避免摘要越压越漂；人类在面板把模式选为『压缩继续』时按人类选择执行第二次（仍过审批）；没有面板模式时第二次压缩需要人类明确要求（`force`）。
- 面板状态写盘失败时只留在内存里（重启即丢）；设置文件是持久化优先。
- 界面文案只有中文；文档以中文为准。
- 工作台账是**会话级、Leader-only**：同一个工作区的多个接力会话各有一份；队友/子代理不读写 Lead 台账，也不在 UI 展示。交接时复制到新会话（rev 保留）。面板只读，编辑走 agent 工具；条目上限默认 30，超限先归档 done；无 done 可归档才拒绝新增，归档失败不写台账。归档路径与数量可查，不自动删。
- 资源回收不承诺：内核在子会话自然结束时通常已自动释放；relay 只保留内部 activation 句柄用于换代容量，不再向用户承诺「压缩后释放内存」。
- 团队优先闸门已删除：DSH 0.2.2-rc.2 起队友就是 subagent 树成员，无法区分「开子代理」与「用队友」。
- 架构师模型默认跟随「模型」选择器的默认选择（已选则沿用；不拒绝、不阻塞）；显式选择才必须在该会话官方子代理白名单内。
- preset 行数据只跟随 0.2.2-rc.2 的官方 ptc patch；更早内核（rc.1 / 0.2.1 系列）不再支持。

## 升级与卸载

**v0.10.0 是破坏性版本**（从 0.8.x 直接升）：panel.json `schemaVersion` 升到 3，旧文件的会话授权一次性失效（自动压缩/自动交接/授权下一次需重新开启；模式与架构师设置保留）；classic `relay` 别名、`routerMode`/`legacyPresetCompat`、`config.thresholds`、cth/autoChoose/autoDecision/handoffPreset、`relay_phase` 的 `next_operation` 全部删除；协议改为两段式用户门。旧 classic 会话打开后在模式选择器切到 Relay 即可回填平面。完整清单与升级步骤见[迁移说明](docs/design/MIGRATION.md)；旧 v0.9.0 变更记录见 [CHANGELOG.md](CHANGELOG.md)（历史参考）。

卸载注销preset/skills/HTTP/工具/投影/哨兵；保留用户数据panel.json、settings.json和工作区.scratch/context-relay/**。需要清理时先备份，再用文本编辑器人工删除所需数据；插件不自动删除。

## 开发

```console
npm test        # node --test test/*.test.mjs
npm run check   # 全部入口语法检查
```

无构建步骤：host 与 client 都是手写 ESM；开发时可热注入，发布为 bundle（`cordis.patch.yml`）。

`lib/policy.js`（策略单源）、`lib/seams.js`（官方 seam 契约）、`lib/plane/`（角色表与幂等 reconcile）、`lib/storage.js`（原子写/锁）、`lib/panel-store.js`（面板状态）、`lib/agent.js` + `lib/agent/*`（preset 平面与工具）、`lib/agent/notice/`（notice 规划/投递）、`lib/index.js`（Host 平面/HTTP）、`lib/client.js`（Web UI bundle）、`lib/preset-base.js`（PTC preset 资产）、`skills/`（随包技能）。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT

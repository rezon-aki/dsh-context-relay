---
name: context-relay
description: "接力模式（relay preset）的操作手册：phase 状态机、relay_status/relay_recommend/relay_phase/relay_organize/relay_handoff/relay_work_items/doc_lint 用法、阈值、到线提醒、composer 面板与团队纪律。用户切到接力模式、要求上下文整理/会话接力/phase 管理/多分支任务台账时使用。"
disable-model-invocation: true
---

# Context Relay 操作手册

## 何时用

用户在会话模式里选择「接力模式（Relay）」，或明确要求「按 phase 管理上下文 / 到阈值就整理 / 换会话接力 / 团队按阶段接管」时。

**适用边界**：relay 的收益集中在**长程、多步信息收集、边做边收敛**的任务（检索/工具型）；单轮问答、一次性小改动、纯静态推理**不要套 relay**——phase 与纪律成本会大于收益，直接用普通会话更便宜。

**不适用/替代**：需要人类中途决策、依赖对话记忆、需要上下文预算管理的场景才用 relay。若是「重复性、可离屏、以 workspace 为长期记忆的整块劳动」，优先交给官方 Ralph（实验工具，默认关闭）或 `workflow`/`subagent`，**不要用 relay 自研自动循环**（场景与三态机见 `docs/research/05-ralph-loop.md` §2/§4）。

**授权口径（唯一真源，适用于全部工具与面板）**：面板模式（本会话持久、不消费）只决定「做什么」，不产生审批豁免；免审只来自 autoCompress / autoHandoff / authorizeNext（一次性，操作成功后消费）。

## 一轮的标准动作

1. **起手**：调 `tools.relay_status` 看 Lead 与队友的压力、当前 phase、`continue`、`budget` 与 `diagnostics`。结构化字段已瘦身：`{phase, lead{used,window,ratio,band}, team[], organizeCount, continue{needed,band,organizeCount,recommendation,reason}, advice, diagnostics{pressureSource,lastCompactionSeq,organizeCount}, budget{band, used, window, ratio, headroomToWarn?, headroomToOrganize?, headroomToRelay?, thresholds{warn,organize,relay}（各线 token 值）, currentPhaseCostTokens?, previousPhase?{phase, costTokens}}}` + `text`；阈值、A/B 选项与预算事实行（headroom、本 phase 已消耗、上一 phase 消耗）只在 `text`（v0.2.15：`text` 不再复制 advice 与 `continue.reason`，只保留预算事实行与 recommendation——两者仍在 JSON 字段）。`organizeCount` 只计**真实压缩成功**的次数（拒绝/失败/空压缩不计数）。
2. **声明 phase**：`tools.relay_phase({phase, goal?, exit_criteria?, contract_check?, budget_plan?})`（**discover/decide 必填 exit_criteria**：可验收完成口径；**每次切 phase 必填 `contract_check{requirement, fidelity, attention}`**＝两条用户契约的工作时自检（需求已定/实现忠实/注意力）；**进 ship 只能从 verify 且必带 user_gate（review + report：新上下文独立审查 + 汇报）**，见下「两条用户契约」）。**预算 phase 优先**：预算只是 phase 边界闸门——phase 中段不因预算打断工作、不中途压缩/接力；**warn 档（30%≤ratio<organize 线；默认基准 35%）切 phase 必填 `budget_plan{action, can_finish?, estimate_tokens?, note?}`**：`proceed`=估计放得下→放行；`split`=**拆票**（缩小本 phase 范围，goal/exit_criteria 收窄）→放行（响应带 reminder，phase 完成时再检查）；`relay`=先做一次 relay 操作（`relay_organize` force:true 或 `relay_handoff`）再重试 `relay_phase`；缺/非法 plan、`can_finish:false`+proceed、estimate 超 headroom 会被拒绝（**拒绝零副作用**）；ok 档不强制（headroom→organize >5% 窗口）；organize/relay 档沿用既有面板闸门；队友 relay 改为向 Lead 请示或拆票。**跨 phase 响应总带 `budget` 事实**（全档：band/headroomToWarn|Organize|Relay/上一 phase 实测消耗；ok 档不强制 `budget_plan` 但同样返回；warn 档另带 estimate/fits/action）——**phase 完成时看跨 phase 响应 budget 或 `relay_status.budget`** 决定边界动作。phase 固定为 discover → decide → build → verify → ship；goal/exit_criteria 会进下一次 organize 的 brief。面板把模式选为**「自动（模型决定）」**（=`autoChoose`=on，与显式模式互斥）就是**模型自决档**（与人类选定模式不同）：压缩/接力由你自己判断，**不要向人类确认「选哪个」**（但执行时仍会走官方授权闸门：自选压缩需 `autoCompress` 或「授权下一次操作」才免审，自选接力需 `autoHandoff` 或「授权下一次操作」——那是人类点一次授权，不是让你回头问选哪个），并在声明 phase 或做出决定后用 `next_operation:'compress'|'handoff'` 记录（chip 显示模式「自动」，已记录的具体操作在 title/popover；`next_operation:'auto'` 清除）；autoChoose=off 时记录会被忽略（返回 `next_operation_ignored:true`）。**人类选定的模式（本会话持久、不消费）则严格按模式执行、模型不另选**（人类在面板写非 null 模式时会覆盖模型决定）。顺带用 `lessons` 参数存 ≤3 条带证据的可复用经验；返回里带最多 3 条相关历史经验（v0.2.15：注入 ≤1KB，原 8 条/2KB；workspace 级 `.scratch/context-relay/lessons.md`，去重 + 40 条/8KB 上限自动淘汰）。
3. **按 phase 派活**：每个 phase 用 fresh teammate 承担同质工作；派活 brief 写清目标、退出条件、证据指针、禁区。派活前用 relay_status 看队友压力。
4. **phase 收尾 = 按面板模式/人类选择处理继续方式（phase 优先）**：ok/warn 档可直接 `relay_phase` 切下一 phase（**warn 档必填 `budget_plan` 可行性估计，见步骤 2**；放不下就拆票或先做一次 relay 操作）；organize/relay 档**不开新 phase**（本 phase 的活照做不砍）。`relay_phase` 超预算切 phase **不走官方审批闸门**（由 composer 面板闸门处理）——**两种模式语义不同**：① 人类选定模式（defaultOperation，本会话持久、不消费）= **严格按模式执行**，模型不另选；② 面板/侧栏选「自动（模型决定）」（`autoChoose`=on，与显式模式互斥）= **模型自决档**：模型自己判断压缩还是接力、不向人类确认，执行前先用 `relay_phase({phase, next_operation})` 记录判断再执行；③ 未设模式且非自动 = 问人类。
   - 模式「继续」→ 放行切换并返回 `reminder`（模式保持、不消费）；
   - 模式「压缩继续」→ `relay_phase` 抛错指示：先 `tools.relay_organize({phase, brief})`，压缩成功后重试 `relay_phase`；
   - 模式「接力新会话」→ `relay_phase` 抛错指示：先 `tools.relay_handoff({..., human_approved:true})`（**rev5.5：模式只决定操作，不免审**；执行时按 `autoHandoff`/`authorizeNext` 判定，否则弹官方授权）；
   - 模式「压缩→新会话」→ **两段式**：第一次到线 `relay_phase` 抛错指示先 `tools.relay_organize`（**模式保持**，供下一次到线走第 2 段）；已压缩过（本会话 `organizeCount>=1`）后再到线：抛错指示先 `tools.relay_handoff`（模式不产生豁免，执行仍按 `autoHandoff`/`authorizeNext` 判定；接力成功后模式不消费、新会话继承）；
   - 未设模式 → 问人类（一次问清、附推荐与默认）：A「压缩后继续同一会话」→ `relay_organize`；B「接力开新会话」→ `relay_handoff`；或让人类在面板选模式（人类选模式后严格按模式执行）。推荐以 `continue.recommendation` 为准（未压缩过推荐压缩；已压缩过推荐接力；relay 档推荐接力）。模式为「自动（模型决定）」（`autoChoose`=on，模型自决档）时**不向人类确认**：自己判断压缩还是接力，先 `relay_phase({phase, next_operation:'compress'|'handoff'})` 记录（chip 显示模式「自动」，已记录操作在 title/popover），再执行；已记录则按记录执行。执行时仍走官方授权闸门（rev5.5）：自选压缩默认会弹一次人类授权（`autoCompress` 或 `authorizeNext` 免审），自选接力按 `autoHandoff`/`authorizeNext` 判定（**模式不产生豁免**）。注意：「未设模式」指**面板与侧栏默认都没设**——未改过面板的会话读侧栏默认值。
   - 选 A 时：写 phase brief（**压缩后仍要记住的关键事实**：目标、已定决策、证据指针、下一 phase DoD、**关键文件索引**——了解当前项目所需的重要文件：入口/核心模块/配置/契约/测试，每条 `path — 作用 — 为何必读`，≤8 条）+ 收尾**三清单**（已完成 / 未完成（原因）/ 未尝试（原因，含发现但没修的问题））+ 受控缩减。brief 在**压缩成功后**作为插件 notice 注入下一 step（宿主 config `injectBrief=false` 可关）；失败/busy/无压缩历史不注入，重试安全（失败不计数、不叠加）。organize 在**压缩前**由插件自动跑 `doc_lint` 并把结论写进 brief/evidence（v0.2.15：协议不再要求模型「压缩后必跑」）；需补查时再手动跑，UNKNOWN 要写明原因；FAIL/WARN 压进下一 phase brief 或 handoff 的 evidence。每会话默认最多压缩 1 次；人类在面板把模式选为「压缩继续」或明确要求（force）时可第 2 次（审批仍按 autoCompress/authorizeNext）。**任何压缩（首次/二次、自动/非自动）默认都走官方授权闸门**：面板 `autoCompress`（压缩自动授权）或 `authorizeNext`（授权下一次操作）开时免审。**rev5.5 正交模型：面板模式只决定「做什么」，不再自带免审**（模式「压缩继续」/「压缩→新会话」第 1 段执行时同样可能弹一次授权）。
   - 选 B 时：先要一次明确 Go/No-go（目标是否仍正确 / P0 未决项是否裁决 / 丢弃上下文里有没有人类需要的 why）；`relay_handoff` 只在面板 `autoHandoff`=on 或「授权下一次操作」（`authorizeNext`）时跳过官方 `tools/pre-execute` 审批（rev5.5：模式不产生豁免）（否则浏览器面板确认，**fail-closed**，仅宿主 config `handoffApproval='off'` 可关）。旧会话保留为审计档。新会话**默认继承旧会话的模型路由与权限档**（返回体 `inherited`；`inheritOnHandoff=false` 关闭）——注意这等于把旧会话的 `danger-full-access`/`never` 也带过去，人工确认点就是这次审批（或面板显式授权）。
   - 人类/面板也可以选「继续」或「先不压缩也不接力」：按当前上下文继续，不自行决定。
5. **handoff 半创建**：若返回 `halfCreated:true`（会话已建但 live/followup 失败），插件会 best-effort 清理并提示重试；workspace attach 失败不阻断交付（`ok:true` + `info.code='relay-attach-failed'`，事后在会话列表手动 attach cwd）。

## 两条用户契约（验收用户门 / 最小注意力最大影响，2026-11-01）

- **验收用户门 = 新上下文独立审查 + 汇报（工具硬门；不靠机械）**：`ship` 是唯一的验收声明——只能从 `verify` 进；Lead 会话 `relay_phase({phase:'ship', user_gate:{review, report, questions?}})`：**实现者自查有盲区**——用**新会话 / 新队友 / 新子智能体**（`subagent` fresh context；**不要用 `subagent_fork`**）做独立审查。**Lead 必须给全上下文索引**：① 用户原话需求+边界（逐字）② 实现索引（file:line）+ 验证证据（测试/命令结果）③ 文档/设计决策入口 ④ 已知边界/未验证项。**审查范围 = 只做「需求 ↔ 实现」对齐**（找偏移/劣化/偷懒/缺失），**不重跑技术验证、不重读第三方源码**（技术验证是实施者责任，证据随附；上下文不够让 Lead 补，不自己挖）；**最多 1 轮**（P0/P1 修完只看 diff 复核，P2/P3 记录不阻塞），预算 ≤10 个工具调用/≤5 分钟。把审查者身份 + 发现写进 `review`；`report` 大白话汇报（需求 → 实现 + 证据 → 审查结论 → 边界/取舍/没做到）；`questions?` 每条必带 `recommendation`（**不设题数上限**）。**宿主只强制非空、不校验内容对错**；**不弹审批弹窗**；`handoff` 不是验收。
- **边界问题即发现即报**：discover/decide/build 遇到会改变结果/边界/代价的歧义、假设、实现与原意偏离 → 大白话汇报 + 提问（一次问清、附推荐与默认；**不限题数**）；不替用户拍板、不默默假设。用户起初未必知道最终形态，这是正常的——边发现边对齐。
- **人类注意力最小高影响**：只在会改变用户可见结果/边界/不可逆处打扰；每 phase ≤1 次非 P0 同步；问题一次批量问清（推荐+默认+后果，**不限题数**）；答案写进 phase brief/handoff（下一会话不再问）；能面板点选的不出问答；P0/不可逆随时。
- **工作时自检（每次切 phase 强制）**：`relay_phase` 切 phase 必填 `contract_check{requirement, fidelity, attention}`——① 需求是否已定：本阶段对应用户哪条需求、语义/边界定了没、还差的歧义是什么（定了写「已确定」）；② 实现是否忠实：本阶段有没有偏移/劣化/偷懒/缺失（无写「无」）；③ 注意力最小高影响：接下来是否需要用户注意力、凭什么是那一次（不需要写「不打扰」）。答不出就别切 phase；阶段中途准备问用户/宣布进展前也先过这几问。
- **队友不做验收声明**：ship 的用户门是 Lead 的事；队友把结论/边界/未决项回执 Lead，由 Lead 汇报用户并过门（**但每次切 phase 的 contract_check 三问自检对队友同样强制**——验收门是 Lead 的事，工作时自检是每个模型的事）。

## composer 面板（输入框下方「接力」chip）

- **团队保鲜（v0.3.2）**：超长任务里固定 2–4 人小队、按角色名建（worker-1…），任务优先 `send_message` 给现有队友；只在新专长/无人可用时 spawn。**有团队时默认只用队友；要开子代理（`subagent` / `subagent_fork`）必须先问用户**（团队优先契约）。**spawn 与 renew 都永久占成员额度**（部署上限，常见 8/16），满额后无法 spawn/renew——renew 报 `member-limit` 时不要重试：让队友先 `relay_checkpoint` 再 `relay_freshen`（同代 ≤2 次）继续复用，或在 phase 边界 `relay_handoff`（团队重启）后 `relay_rehydrate` 按记录重建小队；队友只在 organize/relay escalation（warn 只本地提示）。**旧任务结束、旧上下文不要时：`relay_checkpoint` → `relay_freshen({reset:true, brief:"新任务…"})` → 派新任务**——reset 是**真清空**（下一次 pre-step 后模型只剩系统提示 + brief；同成员/同会话/不占成员额度/不计 freshen 次数；失败自动回退官方压缩）。`relay_renew` 只用于换身份/角色（永久占额）。
- **渲染与档位（v0.3.1）**：接力 chip 只在 relay 会话渲染（非 relay 会话整块不出现）；模式在 popover 里是车钟表盘——classic 6 档、Relay · 超长任务只有 3 个操作档（继续 / 压缩继续 / 接力新会话；表盘另含「问我」，接力=团队重启）——v0.3.4 起移除「压缩→新会话」，且不显示「自动（模型决定）」；长模式存量档视觉按「继续」显示、由 host 按继续语义归一（cth 归一后清空），新长会话默认「继续」。
- **模型推荐行（v0.3.3）**：Lead 用 `relay_recommend` 提交后，popover 状态行下多一行「模型推荐 · 操作 · 理由 · HH:MM」，表盘同操作档位加冷青虚线「荐」、chip title 追加「· 模型推荐 X」；长模式收到「压缩→新会话」推荐整条忽略（无行/无高亮，v0.3.4）；推荐文案用面板档位长 label（压缩继续/接力新会话），reason 存储 ≤120、展示/提醒 ≤60；旧宿主缺字段不渲染。**推荐≠决定、不产生授权**。

- 排在 ContextMeter 右侧，显示实时 `接力 {pct}% · ● 模式`（`live.overBudget` 时追加「已到线」）。chip **显示当前模式**（`问我` / `继续` / `压缩继续` / `压缩→新会话` / `接力新会话` / `自动`；两段式模式直接显示模式名；「自动」带流光，模型已记录的具体操作在 title）。chip 上光点 =「授权下一次操作」（黄=未授权 / 绿=已授权一次免审 / **绿+呼吸灯=压缩与新会话都已自动授权、执行全免审**）；popover 为毛玻璃面板；光点后紧跟模式标签，再后是压/接**图标**（SVG）= autoCompress/autoHandoff 状态（灰=关、亮=开）。数据来自 `GET /context-relay/panel?sessionId=`（agent 每 step 发布实时状态，client 4s 轮询；`live=null` 时仍渲染中性降级 chip（比例显示 ?、不显示旧 band/「已到线」）。
- 点击展开非阻塞 popover（rev5 精简）：标题 + 一行紧凑状态 `上下文 X% · 已压缩 N 次`（成功压缩日志派生，取 `live.organizeCount`，缺失显示「—」；band/phase/阈值等小字说明已移除）+ **模式（六选一，互斥）**（车钟表盘）：问我（默认）/ 压缩继续 / 接力新会话（会立即创建新会话、消耗额度；**模式只决定操作，执行仍按 `autoHandoff`/`authorizeNext` 判定，可能弹一次官方授权**）/ 继续（不压缩不拦）/ **压缩→新会话**（第一次到线只压缩、第二次到线才接力）/ **自动（模型决定）**（= `autoChoose` 开，模型自己判断压缩/新会话，先 `relay_phase({next_operation})` 记录再执行）——选「自动」会清掉显式模式、选任何显式模式会关掉「自动」；模式在本会话**持久、不消费**（不会自动写回 `null`），接力成功后由新会话继承。
- **两个持久自动授权 + 模型自决选项 + 授权下一次操作（仅本会话）**：`autoCompress` = 压缩免官方审批（任何压缩：首次/二次、自动模式自选，rev5.4）；`autoHandoff` 开新会话免审批；`autoChoose`（「自动（模型决定）」）只是**操作选择权**交给模型（不是审批豁免）：模型判断下一次压缩/新会话，执行前先 `relay_phase({next_operation})` 记录、不向人类确认；**「授权下一次操作」**（`authorizeNext`）一次性免官方审批，覆盖 `relay_handoff` 与**任何** `relay_organize`（首次/二次、自动/模式选定均可；操作成功后自动失效，失败/拒绝不消费；无 TTL，随时可关；chip 上光点未授权黄/已授权绿，popover 里是显眼的黄/绿着色授权按钮，位于 popover 最下面；模式为车钟表盘、自动授权为切换按钮；popover 不含按钮以外的说明小字（只保留标题+一行状态+底部反馈），普通窗口不出现内部滚动）。**免审只来自这三个开关**（另有部署级 `handoffApproval='off'`）。
- 面板状态按会话持久化 `~/.dsh/data/dsh-context-relay/panel.json`；改动即 `PUT /context-relay/panel`，立即生效。**人类在面板改动时**保存会话快照（此后不跟随侧栏默认变化）；agent 内部状态写入（自决记录/授权消费/`handedOff`）只落会话内部字段，不固化侧栏默认值。
- 侧栏插件卡（`plugins.bundle.config`）：阈值基准 + **默认模式下拉（含「自动（模型决定）」）** + **两个默认授权** checkbox（autoCompress/autoHandoff）；`GET/PUT /context-relay/settings` 为六字段（`threshold`/`defaultOperation`/`autoChoose`/`autoCompress`/`autoHandoff`/`unlimitedBudget`），PUT 部分更新合并。默认值只作用于**新会话或还没在面板改过的会话**；旧 `autoPhase`/`autoContinue` 已删除、兼容忽略。
- **「你的 token 预算无上限」注入（v0.2.7 起按会话）**：composer 模型选择器（模型名 · 推理等级）**右侧** chip 风格小胶囊「● 预算无上限」（绿点=开 / 灰点=关，仅 relay 会话显示）切换**本会话**；chip popover 里的**开关**（与面板其它开关同款）设置**交接后新会话**是否注入：默认展示跟随本会话当前设置，点击后固定开/关（v0.2.8 由三态胶囊改为开关）。侧栏不再有这个开关（`settings.unlimitedBudget` 仅作默认值/旧配置兼容）。GET /panel 的 relay 标记按**当前 preset 投影**判定（新建会话后在模式选择器选 Relay 也显示；重载前创建的旧会话注入不生效，需新建 relay 会话验收）。

## 阈值（默认基准 35% → 30/35/45；来源优先级见插件 config / settings.json；legacy `thresholds` 仅在无 settings 来源时生效）

- 窗口已知（status 返回 window）时**只用比例线**（默认 30/35/45：基准 35% = organize 线，warn = −5%，relay 硬线 = +10%；侧栏「插件 → relay 卡片」改基准（同卡还可设面板各选项的默认值），保存即热生效）。常驻协议**不写死**这些数字：升线时提醒 notice 会给 band 与实测比例（2026-10-24 起；2026-11-01 起只告知状态 + phase 优先指引、不给 mid-phase 动作指令；**v0.2.15 起阈值不进 notice**，看 `relay_status.budget.thresholds`）。
- 档位只决定「能不能开新 phase」：warn 不挡当前 phase 的工作，organize/relay 才禁止开新 phase；**phase 优先（2026-11-01）**：phase 中段不因预算打断工作、不中途压缩/接力；**开新 phase 前先估计本 phase 能否在阈值前完成**——warn 档切 phase 必填 `budget_plan`（`proceed` 放行 / `split` 拆票 / `relay` 先做一次 relay 操作再重试；缺/非法、放不下、estimate 超 headroom 拒绝且零副作用），ok 档不强制；**继续方式按面板模式/人类选择处理**，插件不默认执行任一动作。
- 窗口未知 / 为 0 时才退回绝对 token 兜底：100k / 130k / 160k。
- 比例优先：1M 窗口下绝对 100k 线 ≈ 9.8%，会过早触发（旧版 bug 已修）。

> 依据：docs/research/02 显示「40% 是窗口比例」不是普适规律；社区经验拐点是绝对 ~100k tokens，且退化是渐变不是悬崖。所以绝对线保留为窗口未知时的兜底，窗口已知时只按比例。

## 到线提醒

- 升线时插件自动注入一条 `source = {kind:'dsh-context-relay', form:'notice', summary}` 的提醒（**不是用户发言**；V4 准入要求 producer-owned kind，旧 `kind:'plugin'` 已退役）。
- **升线提醒**：只在 band 上升时提醒（warn → organize → relay）；同档不重复；回退后再升线仍提醒；**与压缩次数无关**——成功压缩把已提醒水位重置（重新武装），压缩后再到线必提醒（压缩两次仍提醒）；每次 phase 完成仍超线再提醒一次（phase 边界 notice）。**升线 notice 只告知状态 + phase 优先指引，不在 phase 中段要求动作、不重申（2026-11-01 删除 mid-phase 动作/步数重申/重启补催），处理点在 phase 边界**（本 phase 做完；开新 phase 前按 `budget_plan` 估计）。v0.2.15 起正文精简：band/比例/phase 事实 + 面板摘要 + phase 优先指引（autoChoose=on / organize·relay 档各加一句），Lead ≤365 字符、autoChoose 变体 ≤500（v0.3.3 起；新增 relay_recommend 指引行，实测 355/490）；不再复制 advice/工具清单/召回规则。
- **模型推荐（v0.3.3）**：用 `relay_recommend({operation:"continue|compress|handoff|compress-then-handoff（classic；长模式仅前三个）", reason:"≤60字（存储上限 120）"})` 把推荐写给插件（**Lead-only**）：popover 出现推荐行、同操作档位加冷青虚线「荐」高亮、chip title 追加。**只做展示/参考**——不写 `defaultOperation`、不自动执行压缩/接力、不产生审批豁免，最终仍按模式/人类；切 phase / 压缩成功 / 接力成功 / 人类在面板选定后自动清空。队友/子会话调用返回 `lead-only`（零副作用），应在回执里把建议给 Lead。
- 冷启动/热重载从「持久 notice 晚于最近成功压缩」派生 seed；resume/热重载后不会重复提醒；接续会话（handoff 新 session id）重新计数。

## 提问与用户交互（白话优先）

- **提问工具只用于简单问题**：是/否、二选一、低风险确认、只缺一个事实；问题短、选项清楚、推荐排第一，同批一次问完。relay preset 的官方 `tool-ask-user` 行 config = `{mode:'timed', timeout:60}`：人 60s 没答返回 `pending`，模型继续独立工作或改用文字汇报，问题仍可后答；**pending 不是跳过、不是同意**。
- **复杂问题不走提问工具**：需要用户决策、方案取舍、边界/代价变化、长背景 → 用普通回复消息（大白话）展开：结论与影响 → 选项（推荐+默认+后果）→ 等用户直接回复。不要把这类问题塞进提问工具里等。
- **白话规则**：先结论与影响，再需要用户做什么，最后才证据（路径:行）；术语首次出现给一句人话解释；不拿内部字段名/错误码当解释。每 phase 最多一次非 P0 同步；一次问清、已答不再问；答案写进 brief/handoff。
- **PTC 边界**：程序里等待仍受 `run_code` 默认 120s 执行 deadline 约束（60s 提问超时留了余量）；不要把「必须等答案」的长等待塞进提问工具。**历史**：v0.2.3 引入 timed；v0.2.9 误删；v0.2.10 恢复固定 120s；v0.2.11 一度做「无限等待」被用户否决（2026-11-03「整体移除这个会一直等你回答的功能」），最终改为「只给简单问题、超时 pending、复杂问题走文字汇报」。

## doc_lint

- **v0.2.15：通常由插件自动跑**——relay_organize 在压缩前、relay_handoff 在生成交接单时自动执行并把结论并入 brief/evidence；模型无需为「压缩后必跑」额外调用，需补充检查时再手动跑。
- `paths` 只接受 **workspace 相对路径**（绝对/`~`/`..`/符号链接越界 → WARN，且不读取工作区外文件）。
- git 检查目标 = 工作区 `AGENTS.md` + 本工作区约定的 `docs/machine.md`/`docs/workflow.md`（存在才纳入）+ `paths` 额外文档；ignored 文件报 WARN（带规则来源）而不是 PASS；探测不到 = UNKNOWN（不是 ok）。部署级额外文档可经 `options.extraDocs`（代码级）传入，host config 通道留待后续。

## 队友保鲜（v0.3.0 起；v0.3.2 真清空 reset + 记录分区 + rehydrate，仅「Relay · 超长任务」模式）

- **派活后别空转**：队友回执是消息自动送达——不要循环调 `wait_agent` / `list_agents` / `team_task_list` 等；只有确实被阻塞时做一次有界等待（≤120s），其余时间继续验收抽样/准备下一步（常驻协议「等待纪律」）。

- 任务边界顺序：`relay_checkpoint` →（旧上下文不要时）`relay_freshen({reset:true, brief})` 真清空 → 派新任务。`relay_checkpoint({one_line, done[], decisions[], evidence[], constraints[], next_actions[], open_questions[], failed_attempts[], pointers[]})` 写 `.scratch/context-relay/team/<leadSessionId>/<lineage>/checkpoint.md`（≤4KB）+ ledger/roster；不写记录，下一代/新会话接不上。
- `relay_freshen({reset:true, brief})` = **真清空**：只排队，下一次 pre-step 保留系统提示、把其余 surface 替换为 brief（模型下一请求只剩系统提示 + brief）；同成员、同会话、不占成员额度、**不计 freshen 次数**；失败自动回退官方压缩（ledger 记 fallback），不谎报。旧事件仍在日志，可 `session_event_read` 召回。
- `relay_freshen({phase?, brief?, key_docs?})`（非 reset）= 同任务内自行压缩（与 Lead `relay_organize` 同机制：brief 先写盘 → 官方 context-overflow 压缩 → 成功后注入 brief；同代最多 2 次，有损）；仍脏 → 先 `relay_checkpoint` 再请 Lead `relay_renew`。
- `relay_renew({name, reason?})` **只用于换身份/角色**（同 lineage 下一代，永久占成员额度；缺 checkpoint 会先代发催办并返回 `checkpoint-missing`）；满额 `member-limit` 不要重试——reset 复用，或 phase 边界 `relay_handoff`（团队重启）。
- 新 Lead 会话（团队重启后）先 `relay_rehydrate({apply:false})` 看计划，再 `apply:true` 按 profile/checkpoint/ledger 重建（同名 active 成员复用、缺记录 skip、失败逐条报告）；新成员先核验一个事实再等派活。
- Lead 派新活前：`tools.relay_team_status({})` 看 health：fresh=可派；watch=做完当前、边界要求 checkpoint；stale/spent=**先 reset 复用**（旧任务不要时）或 `relay_renew` 换代（换身份时）。
- 记录布局：`.scratch/context-relay/team/<leadSessionId>/{roster.json,rehydrate.json,<lineage>/{profile.md,checkpoint.md,ledger.ndjson,handoffs/gen-N.md}}`；v0.3.1 及以前的 `<lineage>/…` 为 legacy（只读回退，不迁移）。链式召回 = 旧会话 `session_event_read({session_id, seq})`（同 workspace），快照权威 > 指针 > 旧会话；reset 在 chain 记 `kind:'teammate-reset'`。
- 不做成员数硬限制（DSH 的 8 是并发活槽、空闲队友自动卸载）；全双工 dispatch/inbox/stop 为后续阶段。

## handoff（有界 schema）

- 顶层：`status`（phase / goal / success_criteria / done / next_actions / blocked）、`evidence`、`decisions` / `constraints` / `open_questions` / `risks` / `discarded`。
- 硬上限：总字节 ≤8KB；evidence **用户 ≤11 条**（插件自动附 1 条 doc_lint，合计 ≤12；多给的同样触发预检拒绝）、done ≤12、next_actions ≤8（插件自动交接清单也占这 8 条）、decisions ≤10、risks ≤8、open_questions ≤5、其余数组 ≤8；单条 ≤200 字符。
- **用户内容超限 → 不交接**：`relay_handoff` 在写文件/建会话**之前**直接拒绝（`ok:false, code='handoff-truncated'`，返回 `caps` + `hint`，零副作用）——按 hint 改短后重试**同一个调用**（不会重复接力/耗额度）。`caps` 标注 `items` / `chars{used,itemLimit}` / `bytes{used,limit}` 实际用量与 `truncated`/`truncatedSections`（三因记账：`bytes` 8KB / `items:key` 条数超上限 / `chars:key` 单条超 200 字符）；细节写进**不受上限约束的已有/新文档**并用 `key_docs` 引用（**progress.md 自身 ≤8KB 会裁剪，不能当溢出容器**）；**不要在给用户的汇报里写截断说明**（2026-11-01 用户裁决：没信息量，把交接文档写好就够了）。插件自动追加的交接清单**不会挤掉用户内容**（挤不下就丢弃清单行，完整清单见工具返回 handover——handoff 文件追加段受 8KB 限制可能未追加；只有它自己抢 next_actions 槽位时才出现 cap 8 裁剪）。evidence 里会自动附 1 条 doc_lint 结论（占 1 条额度，用户最多 11 条）。
- 只接受 `status.*` 与顶层 `evidence`/`decisions`/`constraints`/`open_questions`/`risks`/`discarded`；旧平铺别名（goal/assets 等）已移除（Wave2），平铺字段会被忽略。

新会话的首条消息 = 这份 handoff +「## 接手入口」（progress.md 长线状态 / chain.ndjson 召回索引 / `session_event_read` 指针；v0.2.15 合并原两段，细节见常驻协议）；新 Lead 的第一件事是用 relay_phase 声明 phase，而不是重新探索。

- **交接纪律：交接前先写好文档（2026-11-01 用户追加裁决 A：协议纪律 + 顺序保证）**：交接前先把本次工作的文档写完——phase brief 与收尾三清单（已完成 / 未完成（原因）/ 未尝试（原因））、关键决策与证据指针、滚动进度文件要交代的长线状态（`doc_lint` 由插件自动跑并写入 brief/evidence，需补查可手动跑；UNKNOWN 写明原因）。`relay_handoff` 写盘顺序保证：先写 handoff 快照文件 → 创建新会话 → 更新滚动进度文件 `progress.md` → 才把首条消息（handoff 内容 + 路径）发给新会话；工具**不因 `doc_lint` 失败拒绝交接**（doc_lint 只作证据，硬门方案已被用户否决）。

- **交接清理（2026-11-01，自动执行）**：relay_handoff 成功后插件会**中断运行中的队友/子智能体并释放驻留子级、取消旧会话树（含队友/子智能体名下）的后台任务、把定时任务迁移到新会话**；交接清单写进 handoff 首条消息，清理结果只追加到 handoff 文件与工具返回 handover 字段——**不再给新会话另发消息**（2026-11-01 用户要求，v0.2.5）。旧会话因此不残留工作（best-effort：单项失败进 errors、定时任务迁移失败保留旧行）——接力后不要再在旧会话开新活。服务未启用按 N/A 跳过；盘点/单项失败会记录在返回体 handover.cleanup.errors（不阻断接力）。

- **面板设置随接力同步（v0.4.0：模式接力时带过去）**：新会话继承旧会话的**当前模式** `defaultOperation`（含「自动」的 `autoChoose`；即使等于侧栏默认也 force 钉住，不随后日默认漂移；目标为超长任务模式时经典「压缩→新会话」按「问我」继承）+ `autoCompress` / `autoHandoff` 两个持久自动授权；`authorizeNext` 取旧会话消费后的值（接力成功即消费为 false）；模型自决（`autoDecision`）、内部字段（`handedOff`）、交接目标 `handoffPreset` 不继承；`handoffPreAuthorized` 字段已删除（旧 panel.json 兼容丢弃）。

## 工作台账（v0.5.0；多分支任务的真源）

- **何时用**：任务出现多条并行分支（多个模块 / 多路调研 / 多个队友各管一块），且会跨 phase、跨压缩或跨交接时。单线程小任务不需要（todo_write 够用）。
- **与其它机制分工**：`todo_write` = 单步内小清单；`goal` = 会话级单目标自动续行；**工作台账** = 跨阶段 / 跨压缩 / 跨交接的分支真源（带 owner / next / evidence / acceptance / depends / phase）。
- **读写**：`relay_work_items()` 读；Lead `relay_work_items({items:[...], rev})` 整表替换（先读再写，带 rev 防并发覆盖）；队友 `relay_work_items({updates:[{id,status,next,evidence,blocked}]})` 只改自己名下条目。文件 `.scratch/context-relay/work-items.json`（workspace 级）。
- **字段规则**：open/doing 必须有 `next`；blocked 必须有 `blocked` 原因；done 强烈建议 `evidence`（ship 严格校验要求有）；`depends` 只能引用已存在 id；上限默认 30（超限拒绝：先关闭/归档 done 项，不自动删）。
- **时机**：phase 开始/结束、开分支、关分支、交接前、压缩前都要更新——交接与压缩会把未闭合项自动带进 next_actions 与 brief，不更新 = 新会话看不到。
- **闸门**：`relay_handoff` **总会**把未闭合项写进 next_actions（blocked→doing→open，按更新时间，≤8；超出在交接单列「未带走项」编号；交接不因台账拒绝，文件损坏只警告）；`relay_organize` 的 brief 自动带「未闭合工作项」段；切 phase 返回上一阶段遗留项；`relay_phase → ship` 默认要求全部 done/blocked 且 done 有 evidence（`workItemsGate:'warn'|'off'` 只降级 ship 校验）。
- **面板**：composer 状态条旁「台账 N/M」胶囊 = 未闭合/总数（doing 琥珀、blocked 红）；只读，编辑走工具。

## 禁止

- 不在 phase 中间整理历史（破坏前缀缓存、丢在途上下文）。
- 不在 phase 中段因预算打断工作、或提前压缩/接力（预算是 phase 边界闸门：本 phase 做完，开新 phase 前用 `budget_plan` 估计；2026-11-01）。
- 不试图删除历史（DSH 只能遮蔽替换或开新会话）。
- 不自行裁决 P0；不代人类回答偏好；不在人类选择前自行压缩或接力（两者都是可选项）。
- 不绕过人工确认：交接写 `human_approved:true` 后仍会走官方审批（面板 `autoHandoff` 或 `authorizeNext` 才是显式免审；模式不产生豁免）；不要用 `handoffApproval='off'` 规避本应确认的接力/压缩；不要自行打开面板自动授权。
- 不把队友上下文当无限资源：队友也压在 organize 档以下，phase 结束就停止派活。
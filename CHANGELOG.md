# Changelog

面向使用者的版本变更记录（每个版本更新了什么）。内部设计、验收、审计与研究文档不随发布提供。

## v0.6.2 (2026-11-13)

独立审查（新上下文）发现 6 个「需求↔实现」偏差，本版修复：

- 修复：**到线提醒仍按时间拼台账年龄**（`更新于 N 分钟前 / 台账已停滞`）——与「不要按时间提醒」冲突；改为只显示 phase 行，时间判定彻底删除。
- 修复：**关 phase 闸门旁路**——`relay_work_items` 整表替换可静默删除未完成条目（删掉自然过闸）。现在拒绝：done 条目可静默清理；未完成条目（open/doing/blocked）必须用 `drop:[ids]` 显式声明；未知/重复 drop 报错。删除不再是无痕操作。
- 修复：**去轮询签名漏 v0.6.1 新字段**——team_status 签名补 `phase` 与名下 doing/blocked 计数，避免 phase 切换后合法查询被 `unchanged-poll` 误拒。
- 修复：**台账缺失无引导**——跨 phase 时若还没有台账，`relay_phase` 响应带 `ledger.hint` 提示开账（事件驱动、不建文件、不注入）。
- 修复：**carry 无效 id 静默忽略**——响应新增 `ledger.carryIgnored`（不存在/已 done/别的 phase 的 id 显式列出）；闸门与 carry 一律以台账 `currentPhase` 为准（跨会话 phase 不一致时）。
- 修复：**items 非字符串静默丢弃**——`relay_phase({items:[...]})` 现在拒绝非字符串元素。
- 测试：新增静默删除/drop/carryIgnored/items 类型/空台账提示用例；全量 534 通过。

## v0.6.1 (2026-11-13)

- 新增：**phase 边界自动带队友 triage**——`relay_phase` 跨 phase 时（Lead 根会话、有队伍）自动读一遍队友上下文压力，响应返回 `team: {members:[{name,band,action}], pending, omitted, hint}`，按档给建议：ok=复用 / warn=收口后 checkpoint / organize·relay=checkpoint + `relay_freshen({reset:true, brief})` 真清空复用（0 额度）/ 换身份才 renew；读不到就提示人工判断。**不需要再主动轮询 relay_team_status**；读压力失败 fail-open，不阻断 phase 切换。
- 改进：`relay_team_status` 每行带 `phase`（Lead 当前 phase）与名下条目计数 `items:{doing,blocked}`（有台账时），报告顶层也带 `phase`——triage 与台账能对上。
- 文档/协议：工作台账段补「phase 边界响应会自动带队友 triage」。
- 测试：新增跨 phase 自动 triage（有队伍/无队伍）与 team_status phase 字段用例；全量 532 通过。

## v0.6.0 (2026-11-13)

- 新增：**工作台账 = phase 工作队列**——`relay_phase` 新增 `items`（开 phase 登记 1–8 条分点，单线程小任务 `items: []`）与 `carry`（把上一 phase 未闭合项显式带入）；台账顶层新增 `currentPhase`（phase/goal/exit_criteria/since/openedAtRev），条目新增 `carriedFrom`；新条目默认继承当前 phase。
- 新增：**关 phase 闸门**——本 phase 未 done 的分点未收口且未 carry → `relay_phase` 拒绝（默认 strict；`workItemsPhaseGate: 'strict'|'warn'|'off'` 可调）；拒绝零副作用（不切 phase、不写盘、不写 lessons）。单线程小任务用 `items: []` 显式声明放行。
- 新增：**事件驱动台账闭环（不按时间）**——队列焦点行（`[台账·build 2/4] doing「…」next「…」`）只在焦点/rev 变化时注入；变更类工具（write/edit/bash/pwsh/apply_patch）成功后没落账 → 下一步提示「[闭环] 上一步改动未落账」；`relay_work_items` 成功即清待落账；分点 done 后焦点行提示下一个。open 允许无 next（未领取），doing 仍强制 next。
- 新增：**relay_team_status 去轮询**——团队状态没变的重复查询直接拒绝（`unchanged-poll`），并给出替代：回执自动送达、phase 边界带 triage、结束回合或推进台账。**不改 Agent Teams 工具**（wait_agent / spawn_teammate / send_message / list_agents / team_task_* 零改动）。
- 改进：`relay_status` 的 workItems 摘要带 currentPhase/phaseLine/focus/未分阶段计数；text 增 phase 行与焦点行；去掉按时间的「更新于 N 分钟前 / 已停滞」提示（闭环改为事件驱动）。
- 改进：`relay_phase` 跨 phase 响应新增 `ledger` 段（phase/planned/done/pending/opened/carried/leftover/hint）与 ok 档 `context:{action:'continue'}` 记录；台账写失败 fail-open（phase 仍切换，返回 workItemsWarning）。
- 改进：压缩 brief / 交接单按 phase 展示（当前 phase 行 + 条目 phase/carriedFrom）；`relay_handoff` 复制 currentPhase 到新会话。
- 配置：新增 `workItemsPhaseGate`（默认 `'strict'`）。
- 协议：Phase 状态机写明「开 phase 带 items / 关 phase 收口或 carry / strict 拒绝」；工作台账段升级为「phase 工作队列（焦点行 / 闭环 / 关账闸门 / 不轮询）」；团队 Lead 段加「不要轮询队友」。
- 测试：新增 phase 元数据 / 关 phase 闸门 / carry / 焦点行+闭环注入 / 去轮询 / 配置归一用例；工具 schema 预算仍达标；全量 531 通过。

## v0.5.1 (2026-11-13)

- 变更：**工作台账跟会话走**——默认落盘 `.scratch/context-relay/work-items/<session>.json`（每个根会话一份；队友共用 Lead 的台账；同一工作区的多个接力会话不再互相串账/覆盖）。`relay_handoff` 把源会话台账复制到新会话（rev 保留），交接单/首条消息/返回体指向新路径；旧 workspace 级 `work-items.json` 仅作一次性迁移来源（读时会话级文件缺失且最后写者=本会话时自动复制一份）与显式 `workItemsPath` 覆盖。
- 修复：`relay_status` 的 `continue:` 行按真实开关显示「压缩免审/接力免审/授权下一次」——以前硬编码「压缩/接力仍需审批」，人类中途打开 autoCompress 后模型看不到，会误判需要批准而不敢压缩。
- 新增：**面板变更提醒**——人类在 composer「接力」chip 改模式/自动授权后，下一次 step 注入一次面板状态（与到线提醒同一步不重复；同状态不重复）。
- 新增：`relay_status` 增加 `panel:` 行（模式 + autoChoose/autoCompress/autoHandoff/authorizeNext + 已记录操作）。
- 改进：**台账新鲜度**——`relay_status` 与到线提醒的台账行带「刚更新 / 更新于 N 分钟前」，超过 30 分钟标「台账已停滞」，提醒模型在 phase 边界/交接前更新（台账本身不会自动更新）。
- 测试：新增会话级隔离/交接继承/旧台账迁移、面板授权文本、面板变更提醒、台账新鲜度用例；全量 526 通过。

## v0.5.0 (2026-11-10)

- 新增：**工作台账（work ledger）**——多分支/多线程长任务的工作项真源：`relay_work_items` 工具读写 `.scratch/context-relay/work-items.json`（workspace 级，跨阶段/压缩/交接共享）；字段 id / title / status(open|doing|blocked|done) / owner / next / blocked / evidence / acceptance / depends / phase；整表替换带 rev 乐观锁、原子写；损坏文件备份 `.corrupt-<ts>` 并 fail-open；默认上限 30 项（`workItemsMax` 1–100）。
- 新增：**界面对账面板**——输入框上方「台账 N/M」胶囊（未闭合/总数，进行中琥珀点、阻塞红点），点开完整面板（进行中 → 阻塞 → 待办 → 已完成折叠分组；显示负责人/下一步/证据/完成标准/依赖），接力面板弹层里也有入口；只读、4 秒刷新，编辑统一走 agent 工具。数据接口 `GET /context-relay/work-items?sessionId=`。
- 新增：**对账闸门**——`relay_handoff` 自动把未闭合项（阻塞 → 进行中 → 待办，按更新时间，最多 8 条）写成新会话的下一步，交接单新增「工作台账」段与「未带走项」计数，新会话首条消息带台账入口；`relay_organize` 的压缩材料自动带「未闭合工作项」段；切阶段返回上一阶段遗留项；进 `ship` 默认严格校验（全部完成或阻塞，完成项需证据）；`relay_status` 与到线提醒显示计数。
- 新增：**团队集成**——队友只能修改自己名下的工作项（`updates` 补丁，不能增删条目或改负责人）；`relay_checkpoint` 自动附自己的未闭合项；`relay_renew` 换代时负责人自动迁移到新代号。
- 新增配置：`workItems`（默认 `true`）、`workItemsGate`（**交付阶段**校验强度：`strict`/`warn`/`off`，默认 strict；交接/压缩始终 fail-open 写入，不受本项影响）、`workItemsPath`、`workItemsMax`（默认 30）。空台账 = 旧行为完全不变；`workItems:false` 或 gate off 可完全回退。
- 改进：**常驻提示词新增工作台账纪律段**（只注入 relay 的 root Lead 与 relay-long 队友，`workItems:false` 时不注入）——何时记（多分支任务 vs 单线程小任务）、更新时机（phase 起止/开关分支/交接前/压缩前）、字段规则（next/blocked/evidence/owner/depends/上限）、以及「交接/压缩会自动带未闭合项」的语义；工具描述保持精简，避免工具 schema 预算膨胀。
- 改进：**常驻协议新增「等待纪律」**（团队纪律段）：派活后不要循环调 `wait_agent` / `list_agents` / `team_task_list` 等队友回执——回执会自动作为消息送达；只有确实被阻塞时才做一次有界等待（≤120s），其余时间继续做有用工作或验收抽样，减少空转消耗。
- 测试：新增工作台账数据层 / 闸门 / host 路由 / 客户端测试；全量回归通过。
- 文档：README 增加「工作台账」说明与配置/工具/HTTP 清单；SKILL 增加「何时记台账、与 todo/goal 的分工」。

## v0.4.1 (2026-11-09)

- 新增：**压缩/换代时点资源释放**——长模式 `relay_organize` 后与 `relay_renew` 后，best-effort 释放**仍驻留**的旧子会话 / 旧代 activation；内核在子会话自然结算时已自动释放，通常无可回收（不承诺内存收益）。配置 `releaseOnCompress` / `releaseRetiredGeneration`（默认开）。
- 修复：上述释放只提交/统计仍驻留的 activation，已卸载的不再虚报为「已释放」。
- 新增：**团队优先契约**——已有智能体团队时默认只用队友；Lead 要开子代理（`subagent` / `subagent_fork`）必须先询问用户（协议文本 + `tools/pre-execute` 官方审批硬门；无审批 UI 部署 fail-open）。配置 `teamFirstSubagents`（默认 `'ask'`，`'off'` 关闭）。
- 改进：压缩 brief 提示词要求「关键文件索引」（了解当前项目所需的重要文件：`path — 作用 — 为何必读`，≤8 条），段序前移防止注入截断；压缩后注入文案新增「接手第一步读索引」；`relay_freshen` 的 `key_docs` 参数同步该口径。
- 改进：**压缩后手动召回**（`lib/agent/recall.js`）——官方压缩只自动恢复 runtime-context / AGENTS.md 基线 / skill 目录，touch 发现的附加 AGENTS.md 与已调用过的 skill 被遮蔽后注入召回指针（有界、失败降级为空）。
- 修复：手动召回只列**确实被本次压缩遮蔽**的内容——以最近一次压缩的 `shadowedEnd` 为上界（retained tail 不算遮蔽；PTC 内层 `tool/ptc-dispatch` 事件永不在 surface，避免误报），后又被可见重加载的路径/skill 跳过；措辞改为「已调用过的 skill」。
- 修复：`relay_handoff` 交接清理的 direct-drain 分支改按 `listChildren` 真实字段（`id`/`mode`，真实 API 没有 `kind`）过滤；旧代码按不存在的 `kind` 过滤导致该分支在真实内核下永远空转（`drainDescendants` 兜底）。
- 测试：新增 `release` / `team-first` / `recall` 单测；`policy` 断言同步到新 brief 段名；团队优先门覆盖 `subagent_fork`。
- 文档：README 重写为面向用户的价值说明（中文真源 + 英文同步）——开头四点：上下文保持高效区间 / 提高人机交互效率 / 长任务复杂任务降低偏移 / 配合官方智能体团队的双层架构；正文去术语，配置与工具清单下移为技术参考；新增 `docs/images/` 一张真实界面截图（接力面板）。
- 文档更正：交接后新会话不是「接手仍在运行的团队」——旧会话树的队友与后台任务会先被中断/迁移，新会话凭交接单和进度文件重建团队与工作记忆。

## v0.4.0 (2026-11-07)

- 用户原话（本轮）：「另外，面板不要是一次性的了，一开始做的就不是个下一次操作，而是模式选择，中间做歪了」；「模式和审批本来就是分开的啊，有自动授权和允许下一次两种审批方式呢」。
- 变更：composer「接力」面板从「一次性默认操作 / 下一次操作」改为**持久模式**——在本会话内一直有效、不再消费；到线时按模式执行（继续=放行；压缩继续=先压缩；接力新会话=开新会话；压缩→新会话=两段式；自动=模型决定；问我=每次问人类）。接力成功后当前模式同步给新会话（目标会话若是超长任务模式，经典的「压缩→新会话」按「问我」继承，因为长模式没有该档）。
- 变更：模式与审批相互独立——模式只决定「做什么」，不产生审批豁免；免审仍只来自两类审批：持久自动授权（`autoCompress` / `autoHandoff`）与一次性的「允许下一次」（`authorizeNext`）。
- 变更：侧栏「默认操作」改为「默认模式」（新会话初始模式）；chip 显示当前模式；表盘 / 面板 / 到线提醒 / 常驻协议 / 工具拒绝信息的文案统一为「模式」口径。
- 变更（同轮）：模型侧提示与执行完全跟随 composer 面板——面板模式存在时按模式执行（「压缩继续」即使本会话已压缩过也按人类选择执行第二次，审批仍按 autoCompress/authorizeNext；无模式时第二次压缩仍需人类明确要求 `force`），不再给出与面板矛盾的规则推荐。
- 修复：超长任务模式不再出现「压缩→新会话」档——模型可见文案（到线建议/状态文本）、`relay_recommend` schema、常驻协议、根会话残留清理都只保留继续 / 压缩继续 / 接力新会话（问我=不设模式）；经典 Relay 四档与两段式不变；两段式闸门只对经典 Relay 生效。
- 独立审查（新上下文）：P0/P1=0——首轮唯一 P1 为随包发布的 `skills/context-relay/SKILL.md` 仍写一次性语义（用掉写 null / 接力不继承），已同步为持久模式并复核消除；P3 措辞项（summary 字段名、英文旧称、测试注释）已修。
- 验证：`npm test` 443 项全绿、`npm run check` 通过、`git diff --check` 无输出。

## v0.3.7 (2026-11-07)

- 文档：把「DSH Web UI 侧栏『插件』安装」写成完整步骤（添加插件 → 插件包名/安装源 → 安装 → 立即启用 → 重启 profile → 刷新 → 新建 relay 会话），并补排障；命令行安装降为方式 B。
- 文档：去掉 README 尾部「内部设计、验收与审计文档不随发布提供」说明（中英）。
- 无代码/行为变更。

## v0.3.6 (2026-11-07)

- 文档：重写中英文 README（面向用户、清理逐版本注记与内部细节）；修正面板字段数量（13 字段）与工具清单（补上 `relay_recommend` 与超长任务的团队工具）。
- 无代码/行为变更。

## v0.3.5 (2026-11-07)

- 修复：超长任务模式下 v0.3.3 遗留的「压缩→新会话」推荐不再出现在 Lead 的到线提醒里；长模式根会话创建时自动清空该类残留推荐（经典 Relay 不变）。
- 修复：超长任务面板档位计数措辞统一为「4 项（问我 + 3 个操作档）」。
- 修复：`relay_recommend` 的理由上限文档统一为 120 字（与实现一致）。

## v0.3.4 (2026-11-07)

- 变更：超长任务模式移除「压缩→新会话」——`relay_recommend` 在长模式拒绝该操作（经典 Relay 仍保留两段式）；存量该档预设按「继续」处理并清空；客户端长模式忽略该推荐。
- 修复：推荐文案统一使用面板档位名（压缩继续 / 接力新会话）；提醒与面板展示理由截 60 字（存储仍 ≤120）；空理由不再渲染空括号。
- 修复：人类在面板显式选择操作后自动清空模型推荐。

## v0.3.3 (2026-11-07)

- 新增 `relay_recommend` 工具（Lead-only）：模型可把推荐操作写给插件。
- 面板展示：popover 新增「模型推荐」行，表盘上同操作档位加冷青虚线「荐」高亮，chip title 追加推荐；**仅展示/参考**——不写预设、不自动执行、不产生审批豁免。
- 推荐清理时机：切 phase、压缩成功、接力成功、人类在面板选定操作后。

## v0.3.2 (2026-11-07)

- 新增：队友真清空 reset——同一队友、同一会话原地擦除旧上下文（失败自动回退官方压缩）。
- 新增：队友记录按 Lead 会话分区存储；跨会话 `relay_rehydrate` 按记录重建小队。
- 说明：不占成员额度、不改变部署 `maxMembers`。

## v0.3.1 (2026-11-06)

- 新增：接力 chip 只在 relay 会话渲染；一次性默认操作改为赛博哥特风表盘——经典 Relay 6 档 / 超长任务 4 档（问我 / 继续 / 压缩继续 / 接力新会话）。
- 变更：超长任务模式隐藏「自动（模型决定）」档（存量按「继续」归一）；新长会话默认操作「继续」；「接力新会话」= 团队重启（旧会话归档、队友与后台任务随之中断）。

## v0.3.0 (2026-11-06)

- 新增：队友保鲜——工作记录 / 体检 / 归档换代 / 链式召回；超长任务模式提供团队工具（Lead：检查点与档案状态；队友：checkpoint / freshen）。
- 说明：功能仅在「接力模式（Relay）· 超长任务」启用。

## v0.2.30 (2026-11-06) — previous npm release

- 面板：水缸开关动效最终形态（液态填充 + 电路纹行）；canvas 水面引擎移到「授权下一次操作」按钮。
- 更早版本见 npm 版本历史。

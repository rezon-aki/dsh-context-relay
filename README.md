# dsh-context-relay

> DSH 上下文接力（Context Relay）：phase 协议 + 预算哨兵 + 受控压缩 + 有界 handoff 开新会话，让 Lead agent 长期停留在高效上下文区间。

[中文](https://github.com/rezon-aki/dsh-context-relay/blob/main/README.md) | [English](https://github.com/rezon-aki/dsh-context-relay/blob/main/README.en.md)

版本 0.3.5 · 要求 DSH ≥ 0.2.1-rc.2 · Node.js ≥ 20 · MIT

## 它解决什么

Lead agent 的上下文一旦变长，会开始偏离实现、重复劳动、过度实现；DSH 自带的自动压缩（默认接近窗口上限才触发、摘要式、打断前缀缓存）往往不能把注意力真正拉回高效区。

本插件提供一个 **relay 模式**（DSH 原生 agent preset，会话创建时在模式选择器里可见）：

- 用 **phase 状态机**（discover → decide → build → verify → ship）组织长任务；
- 用 **预算哨兵** 在上下文接近阈值时提醒，并把"继续方式"（压缩继续 / 接力开新会话 / 继续）的决策留在 phase 边界；
- 用 **受控压缩**（官方压缩引擎）把工作上下文缩回干净区间，同时保留结构化 brief；
- 用 **有界 handoff** 创建新的顶层会话接手，旧会话保留审计（handedOff 标记），交接清理会取消/迁移旧会话树资源，长线状态通过滚动进度文件与文档交接。
- 默认 Relay 模式把**派活与回执纪律**写进协议（推荐、非强制）：长文档/日志/大 diff、写文件、跑命令优先派队友/子智能体，回执 = 报告文件（≤4KB）+ 单条 ≤200 字消息，Lead 只聚合 digest（≤600 字），验收抽样才读细节；小任务可以自干。工具面不裁——现有会话能力不变。
- 另提供**可选模式「接力模式（Relay）· 超长任务」**（模式选择器里的第二个 Relay，2026-11-04 用户裁决）：适合预计跑很久的单会话。Lead 只调度、不执行——**root Lead 的工具面隐藏 `bash/pwsh/write/edit`**，写/跑/读长文档一律派 worker；队友/子会话不受影响（软约束，PTC 可绕过，不是安全边界），`relay_status` 报执行类调用占比与压缩债务（模式细节见下文「接力面板」与 [CHANGELOG.md](CHANGELOG.md)）。
- **超长任务模式队友焕新 v3**（v0.3.2，2026-11-07，取代 v0.3.0/v0.3.1 口径）：队友在任务/phase 边界用 `relay_checkpoint` 写专门工作记录（≤4KB 结构化交接：完成/决策/证据/约束/未决/下一步）；`relay_freshen({reset:true})` 做**真清空**——同一成员、同一会话、不占成员额度、不计 freshen 次数，经 DSH surface replace 把旧上下文对模型彻底遮蔽（保留 system prompt），失败自动回退官方压缩且不谎报成功；`relay_freshen`（官方压缩，有损）只用于任务内降载，同代最多 2 次。Lead 派活前用 `relay_team_status` 体检（fresh/watch/stale/spent）；`relay_renew` 只用于身份/角色变化（换代消耗一次成员创建额度）。记录按 Lead 会话分区在 `.scratch/context-relay/team/<lead-session-id>/`（roster/checkpoint/ledger/handoffs；旧版无分区记录只读回退），旧会话按 `session_event_read({session_id, seq})` 指针链式召回；成员额度满时不再开新队友：reset 复用，或 phase 边界 `relay_handoff` 换新 Team 后用 `relay_rehydrate` 从最新非当前分区重建团队。DSH 的 8 是同一 Team 生命周期内成员创建上限（不是并发槽位），本插件不改部署 `maxMembers`；全双工/看门狗为后续阶段。
- **模型推荐操作**（v0.3.3，2026-11-07）：到线提醒会引导模型用 `relay_recommend({operation, reason})` 把推荐写给插件（**Lead-only**：非 root 会话工具面直接隐藏，执行层再拦）；面板 popover 多一行「模型推荐」，表盘上同操作的档位加冷青虚线「荐」高亮，chip title 追加推荐。**推荐只是建议/展示**——不写面板预设、不自动执行压缩/接力、不产生审批豁免，最终仍按人类预设/决定；切 phase、压缩成功、接力成功，或人类在面板选定操作后，旧推荐自动清空。**v0.3.4 补丁**：长模式只剩继续/压缩继续/接力新会话三档——`relay_recommend` 在长模式拒绝「压缩→新会话」（classic 仍保留），存量该档预设按继续处理并清空；推荐文案统一用面板档位名（压缩继续/接力新会话），提醒与面板展示理由都截 60 字（存储仍 ≤120）。**v0.3.5 补丁**：长模式升级残留的「压缩→新会话」推荐不再进 host 到线提醒（显示时过滤 + 长模式根会话创建时清空该三字段），长模式 chip 档位计数统一写「4 项（问我 + 3 个操作档）」，`relay_recommend` 理由上限统一 120 字（schema 与实现一致，classic 行为不变）。详见 [CHANGELOG.md](CHANGELOG.md)。
- 用 **可恢复压缩 + 链式召回**（2026-11-03）：压缩/交接时把「会话 id + 被遮蔽事件 seq 区间 + brief/handoff 路径」写进 `.scratch/context-relay/chain.ndjson`，压缩后注入的 brief 带「压缩与链式召回」地址簿；需要旧内容时按 `session_event_read({session_id, seq})` 精确指针回读（不靠全文检索）。压缩触发前由官方 tool-result pruner 先无模型裁剪超长工具输出（随 relay preset 组合挂载，无需额外安装）。

## 装完是什么样

- 新建会话的模式选择器里出现 **Relay**（原有）与新增的 **Relay · 超长任务** 模式；选中后工具集里出现 `relay_status` / `relay_phase` / `relay_organize` / `relay_handoff` / `doc_lint`（超长任务模式还额外隐藏执行类工具）。
- 输入框下方出现 **接力 chip**（仅 relay 会话渲染；非 relay 会话整块不出现，v0.3.1）：显示实时上下文占用百分比、当前 band、下一次操作；点开是面板（**一次性默认操作 = 赛博哥特风车钟表盘**（v0.3.1）——classic 6 档；**Relay · 超长任务只有 3 个操作档**（继续 / 压缩继续 / 接力新会话；表盘另含「问我」= 4 个位置；**接力 = 团队重启**；v0.3.4 移除「压缩→新会话」，且不显示「自动」）——近黑石龛 + 霓虹青/品红/紫、12 瓣玫瑰窗 / 尖拱 / 符文刻度 / 彩窗扇区、锥形金属刀片 + 霓虹光刃、系统衬线排印（无外部字体）；盘面 ⌀216 正圆、扇区整盘平分可点击（classic 6×60° / 长模式 4×90°）、悬停扇区高亮、换挡走最短弧（classic 自动↔问我只走 ±60°），可点扇区/档位/拖动指针/←→ 键切换，指针弹簧回弹并高亮当前档；长模式存量档视觉按「继续」显示、不写盘（host 对「自动」按「继续」语义归一，对已移除的「压缩→新会话」按继续放行并清空；新长会话默认操作 seed=继续）；三个开关已改为**水缸按钮**（蓝 / 绿 / 樱花红，去勾选框：开启时由多件水元素各自运动、水位 450ms 带惯性升起 + 水面波层 900ms 慢流/收小（浪=水面本身）地把液体注满整行——液体主体从缸底升起（顶部 SVG mask 波浪边缘）、水面有一层缓缓流动并随水位收小的波形、5 颗液滴从水面弹出（没有横穿的独立物体或水舌；水位最终占满整行）；第三行「新会话注入预算无上限」不再注水，改为 chip 同款独角兽电路纹（从左到右擦出）+ 3 颗火星、水面高光浪线随液面上升；关闭 = 同一组过渡反向；纯 CSS transition，无 canvas/rAF/keyframes；深色玻璃缸底 + 三色淡光，见 v0.2.30；写入字段、aria-pressed 不变），v0.2.29 的 canvas 实时水面引擎移到面板最下面「授权下一次操作」按钮——未授权空缸（黄）、点击注满（绿，与按钮 300ms 黄→绿 crossfade 同时发生）、再点取消排空，以及**下一个新会话的模式滑动开关**——默认跟随本会话 preset，只影响下一次 `relay_handoff` 创建的新会话，不改当前会话的 preset/模式选择器）。本会话「预算无上限」开启时，接力 chip 亮**独角兽红精神感应电路纹 + 红色火星**（平时透明底只透纹路、**不发光**；**已到线**才压深红底 + 红光呼吸 + 火星；纯 CSS；预算无上限胶囊本身不变）。
- 模型选择器右侧出现 **「预算无上限」小胶囊**（仅 relay 会话）：按会话切换提示词注入 `你的 token 预算无上限。`。
- relay 会话里的 `ask_user_question` **只用于简单问题**（是/否、二选一、低风险确认、缺一个事实）：官方 timed 模式 + `timeout:60`，人 60 秒没答就返回 pending，模型继续独立工作或改用文字汇报，问题仍可后答；**复杂问题不走提问工具**——用普通消息（大白话）展开：结论与影响 → 选项（推荐 + 默认 + 后果）→ 等用户直接回复。**新配置需重载插件后新建 relay 会话生效。**
- 设置页的插件卡片提供默认阈值基准与面板默认值。
- 到线时收到插件 notice（不是用户消息）：只告知状态与 phase 优先指引，不打断当前 phase 的工作。

## 安装

要求：DSH `>=0.2.1-rc.2`（Web profile）、Node.js `>=20`。

发布到 npm 后：

```console
dsh plugin --profile web add dsh-context-relay
```

从 Git 仓库安装：

```console
dsh plugin --profile web add github:rezon-aki/dsh-context-relay
```

从本地目录安装（开发态）：

```console
dsh plugin --profile web add /path/to/dsh-plugins/dsh-context-relay
```

**或者从 DSH Web UI 侧栏的「插件」视图安装（不用命令行）：**

1. 打开侧栏 **「插件」** 视图 → 点 **「添加插件」**；
2. 在 **「选择添加插件方式」** 里选 **npm 包**（也支持 Git 仓库地址、本机目录路径）；
3. 在 **「插件包名」** 填入 `dsh-context-relay`（「安装源」保持默认 npm 官方源即可）；
4. 点 **「安装」** → 重启/重载对应 profile → 刷新页面。

持久装配使用包内 `cordis.patch.yml`（bundle 形式）：relay preset 由插件激活时动态注册，卸载即注销。安装/更新后重启对应 profile，再刷新 Web UI。

> 本插件不会自动安装其它插件，也不改写其它插件的文件；`dsh.engines` 声明的是本插件依赖的 DSH API 版本下限。

**使用**：刷新 Web UI → 新建会话 → 模式选择器选「Relay」（普通长任务，Lead 保留全部工具）或「Relay · 超长任务」（预计跨多 phase/数小时，Lead 只调度不执行）→ 开始对话。DSH 约束下会话一旦开始 preset 固定，中途不能切换；请新建一个 relay 会话。

## 快速开始

典型长任务流程：

1. 在 relay 会话里先 `relay_status`，确认当前 phase、上下文占用与 band。
2. 开工前 `relay_phase({phase: "discover", goal, exit_criteria})`；每个阶段切换都要带 `contract_check`（需求是否已定 / 实现是否忠实 / 是否需要占用人类注意力）。
3. 工作过程中不因为预算打断 phase；预算只是 **phase 边界闸门**。
4. 到线（organize/relay band）后，在 phase 边界按面板一次性默认操作处理：
   - **继续**：不压缩、不接力，继续当前 phase；
   - **压缩继续**：`relay_organize` 做一次受控压缩（每会话最多 1 次），压缩成功后继续；
   - **接力新会话**：`relay_handoff` 写出 ≤8KB 结构化交接单并创建新的 relay 会话；
   - **压缩→新会话**（两段式，**classic 专用**）：**第一次到线只压缩并留在本会话继续；第二次到线才开新会话**——压缩把占用压回线下后，同一到线不会先压缩再交接（`relay_handoff` 返回 `two-stage-not-due`）。已知边界：若压缩后仍停留在线以上，无信号区分同一/下一次到线，按到线口径放行（见「已知限制」）。**v0.3.4 起长模式已移除该档**：存量预设按继续处理并清空，`relay_recommend` 在长模式拒绝该操作。
5. 交付前进 `ship` 需要新上下文独立审查（`user_gate.review`）+ 大白话汇报（`user_gate.report`）。

## 安全边界与代价

- **压缩与接力都要过官方审批硬门**（`handoffApproval: 'required'`，默认）：`relay_organize` / `relay_handoff` 执行前由 DSH 弹出审批；只有 allowed-once 才放行。免审只来自面板 `autoCompress` / `autoHandoff` / `authorizeNext`（一次性）。
- **接力会创建新会话并消耗额度**，并会中断旧会话树中运行中的队友/子智能体、取消其后台任务、把定时任务迁移到新会话；旧会话保留审计（`handedOff` 标记）。交接后请勿继续在旧会话工作——插件不强制阻止（技术上仍可继续/再次交接）。
- **压缩有损**：压缩后旧对话细节只保留结构化 brief；重要结论请写进文档/handoff。
- **不自动循环**：relay 保持 human-gated；需要重复性、可离屏的整块劳动请用官方 Ralph / workflow / subagent，不要用 relay 自研自动循环。
- **P0 规则**：不可逆/对外/付费/凭据/删除动作先向人类报备并取得明确 Go；本插件不会替你自动批准这些动作。
- 数据文件：`~/.dsh/data/dsh-context-relay/settings.json`（人类设置）与 `panel.json`（按会话面板状态）；消息/会话内容仍由 DSH 自身存储。

## 配置

### 宿主插件 config（可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `threshold` / `settings.threshold` | 35 | 阈值基准（%）：organize 线 = 基准，warn = 基准−5，relay 硬线 = 基准+10（默认 warn 30 / organize 35 / relay 45）。 |
| `settings` | `{threshold:35, defaultOperation:null, autoChoose:false, autoCompress:false, autoHandoff:false, unlimitedBudget:true}` | 侧栏卡片的初始默认值；人类保存的 `settings.json` 优先。 |
| `thresholds` | 比例 0.35/0.40/0.50 | legacy 阈值（仅当没有 settings 来源时生效）。 |
| `panelPath` / `settingsPath` | `~/.dsh/data/dsh-context-relay/…` | 面板/设置持久化路径覆盖。 |
| `injectBrief` | `true` | 压缩成功后是否把 brief 注入下一 step（归因实验可关）。 |
| `handoffApproval` | `'required'` | 压缩/接力官方审批硬门；无审批 UI 的部署可设 `'off'`（残余风险由部署方自行承担）。 |
| `inheritOnHandoff` | `true` | 接力继承旧会话模型路由与权限档；`false` 回部署默认。 |
| `presetId` | `'relay'` | 默认模式 id。 |
| `longPresetId` | `'relay-long'` | 超长任务模式 id（同插件注册两个模式，各自注销）。 |

### 面板状态（按会话）

`panel.json` 中每个会话 10 个字段：`defaultOperation`、`autoChoose`、`autoCompress`、`autoHandoff`、`handedOff`、`authorizeNext`、`autoDecision`、`unlimitedBudget`、`handoffUnlimitedBudget`、`handoffPreset`（下一次接力新会话的模式：`null`=跟随本会话 preset，或 `relay` / `relay-long`；成功接力后不消费）。人类在 composer 面板写入会保存该会话快照；agent 内部状态只落显式字段，不固化默认值。

## 工具

| 工具 | 作用 |
|---|---|
| `relay_status` | 读当前上下文占用/band/phase/预算 headroom/建议；phase 开始与派活前调用。 |
| `relay_phase` | 声明/切换 phase；校验 exit_criteria、contract_check、warn 档 budget_plan；`ship` 需要 `user_gate`。 |
| `relay_organize` | 受控压缩：写 phase brief（自动附 doc_lint 结论与关键文档入口）→ 调官方压缩引擎 → 成功后注入 brief。每会话最多 1 次（`force` 需人类坚持）。 |
| `relay_handoff` | 生成 ≤8KB 有界交接单（含滚动进度文件），创建新 relay 会话并交接清理旧会话树。 |
| `doc_lint` | 四项目录/文档体检（quota / banned / index / git），输出 ≤2KB。 |

## HTTP API（宿主）

- `GET /context-relay/settings`、`PUT /context-relay/settings`：侧栏默认值（六字段，部分更新合并）。
- `GET /context-relay/panel?sessionId=`、`PUT /context-relay/panel`：按会话面板状态（含 `relay` 标记，供 composer 胶囊判断是否显示；GET 另返回 `modes{relay,long}` 与 `preset`（当前会话 preset），PUT 白名单含 `handoffPreset`——只接受 `null`/两个模式 id，非法值 400 `invalid-handoff-preset`）。
- `GET /context-relay/api`：最后一次 handoff 发布箱快照（M3 提示通道）。

这些路由默认只在本机 GUI 认证后可用（非公开 API）。

## 已知限制

- 重载插件前创建的旧会话使用旧 agent 平面；新行为（注入开关/审批/面板字段）以重载后新建的 relay 会话为准。
- 本插件只在 DSH Web profile 验证；headless/其它部署未验证。
- 压缩/接力的实际效果与模型、任务长度相关，阈值不是普适最优；按需在侧栏调整基准。
- 视觉细节（chip 间距、开关/胶囊/滑动开关位置、动效手感、窄宽度换行、popover 换行）未做自动化视觉回归，需安装后目检。
- **两段式闸门边界**：`relay_handoff` 只在「已压缩且当前未到线（band=ok/warn）」时拒绝；若压缩后仍停留 organize/relay，无到线计数区分同一/下一次到线，按到线口径放行。两段式仅单测覆盖，无真机端到端接力（会创建会话/耗额度）。
- **压缩保真/收益未做 A/B**：小样本实验测得一次压缩后事实保留约 54%、两次约 8%（高方差）；brief 注入改善结果，但严格有/无注入 A/B 未跑（`injectBrief:false` 是关闭臂）。阈值拐点同样未做 A/B。
- **面板落盘失败**：`panel.json` 写盘失败时状态只存内存（`persisted:false`），重启即丢；settings 写盘是持久化优先（500，不半提交）。
- **接力继承权限**：`inheritOnHandoff:true` 时 `danger-full-access`/`never` 会话会继承同等权限档；人类检查点是审批闸门（`autoHandoff`/`authorizeNext` 可跳过）。
- **冷启动 chip**：live 与派生都不可得时显示中性降级态（比例 `?`），两段式预设可能先显示「压缩」直到下一 step 自愈。
- **文档与 UI 语言**：文档以中文为真源；composer chip/popover/侧栏卡片/dock notice 文案仅中文。

## 开发

```console
npm test        # node --test test/*.test.mjs
npm run check   # 全部入口语法检查
```

目录：`lib/policy.js`（纯策略函数）、`lib/panel-store.js`（面板状态）、`lib/agent.js` + `lib/agent/*`（preset 平面实现）、`lib/index.js`（Host 平面/HTTP）、`lib/client.js`（Web UI bundle）、`lib/preset-base.js`（官方 ptc preset 资产）、`skills/`（随包技能）。

变更记录：[CHANGELOG.md](CHANGELOG.md)。内部设计、验收与审计文档不随发布提供。

## License

MIT

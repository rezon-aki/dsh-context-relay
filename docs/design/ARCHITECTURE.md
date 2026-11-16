# 架构说明（Architecture · v0.10.0）

> 范围：本插件在 DSH 0.2.2-rc.2 上的实现架构、官方 seam 契约与关键机制。目标与边界见 [DESIGN.md](DESIGN.md)；破坏性变更与升级步骤见 [MIGRATION.md](MIGRATION.md)；逐版本行为变更见 [CHANGELOG.md](../../CHANGELOG.md)。
>
> 本文是仓库内的**可发布架构摘要**：只写「分层 / 落点 / 契约 / 降级」，不复制行为细节与内部审计记录。代码是实现事实；架构与代码冲突按实现偏差处理，不允许用代码反改设计。

## 1. 分层总览

| 层 | 落点 | 职责 |
|---|---|---|
| Host 平面 | `lib/index.js` | preset / skill / 投影注册、HTTP 面（settings / panel / work-items / architect-models）、settings 载入、卸载编排 |
| agent 平面 | `lib/agent.js` | preset 行插件入口：常驻协议段、工具注册、审批闸门、团队面；per-agent 安装委托 plane 层 |
| 角色表（单源） | `lib/plane/roles.js` | `ROLES`：lead / teammate / architect / worker → {deny, sections, tools, seed}；`roleOfAgent` 按 subagent 深度判定 |
| 平面 reconcile | `lib/plane/ensure.js` | `ensureAgentPlane / disposePlane / disposeAllPlanes / planeStatusOf`：幂等安装、反向卸载、降级记录 |
| seam 契约层 | `lib/seams.js` | 9 个官方 seam 的形状断言；`degradation / degradationsOf` 汇总降级 |
| 单一持久化 | `lib/storage.js` | `workspaceStore / hostStore`、原子写、追加、跨进程异步锁、journal 恢复、凭据收紧 |
| 策略单源 | `lib/policy.js` | 阈值/档位、面板 enum 与默认值、phase/exit 常量、预算闸门、汇报限制、状态/交接渲染 |
| 常驻协议文本 | `lib/agent/protocol.js`、`lib/agent/worker.js` | PROTOCOL / ROUTER / TEAM_LEAD / WORK_LEDGER / ARCHITECT / TEAMMATE / WORKER 文本；单一真源 |
| notice 流水线 | `lib/agent/notice/plan.js`、`lib/agent/notice/deliver.js`（`sentinel.js` 只编排） | 事实 → 计划（纯函数）→ 投递（claim 后置、脱敏、压缩复位） |
| phase / 台账 | `lib/agent/tools.js`、`lib/agent/work-items.js` | phase 状态机、闸门、台账读写与归档 |
| 团队 / 派活 | `lib/agent/{team,team-tools,team-context,delegation,delegation-tools}.js`、`lib/team-api.js` | 队友健康 / checkpoint / freshen / renew / 架构师；dispatch / collect |
| 交接 / 记忆 | `lib/agent/{handoff,progress,chain,lessons,recall}.js` | 交接、滚动进度、链式索引、经验、召回 |
| 文档系统 | `lib/docs.js` | L0 索引、L1/L2/raw 分层、有界读、search、lint |
| Web client | `lib/client.js` | composer 面板与侧栏；常量契约 + 单轮询器 |

## 2. 官方 seam 契约（v0.10.0）

| seam | 用到的方法 / 形状 | 形状不符时 |
|---|---|---|
| preset | `composedPreset(ctx)` / `select(agent, preset)` | 切换事件判定降级，惰性兜底 |
| agents | `list()` / `get(id)` / `turnBoundaryOf(session)` | 启动回填跳过并记降级 |
| tools | `register(def)` / `restrict({deny})` | 裁剪/注册逐名跳过，全部失败记降级 |
| systemPrompt | `section({name, order, text})`，依赖同名 section 分层覆盖 | 协议段不注入并记降级 |
| compaction | `compactIfNeeded(agent, trigger, signal)`、CompactionResult（`compactionId/endSeq/shadowedSeqs/shadowedTokenCount`）、`compaction/end` 事件 | organize/freshen 拒绝并降级 |
| projections | `register(definition)` / `snapshot(session, keys)` / `stateOf(session, key)` | 回退日志扫描；band 可显式 unavailable |
| schedule | `list(request)` 分页对象 `{items,shown,total,limit,offset}` / `catalog()` / `create(request)` / `edit(request)` | handoff 盘点 N/A + warn，不拒绝交接 |
| wipe | `session.surface.nodes` / `append(type, data, {surfaceOp})` / `eventAt` / `deriveEventMessage` | reset 失败回退压缩并如实报 |
| team | `capabilitiesOf(ctx)`：kind=subagents + 核心能力清单 | 团队面降级、不注册队友工具 |

契约：探测**只读、永不抛错**；服务缺失或形状不符时降级为 N/A + warn，并写入 `relay_status.plane.degradations` 与首步 notice——**不静默 fail-open，也不因此拒绝会话**。

## 3. agent 平面与 preset 切换（M-02）

- 角色 → 工具面裁剪 / 影子协议段 / 角色专属工具 / root 默认档种子，全部由 `ROLES` 表驱动，`agent.js` 只做薄封装。
- 四个 reconcile 入口，覆盖「agent/created 只发一次」的缺口：① `agent/created`；② apply 时枚举 `agents.list()` 回填；③ 官方 `agent-preset/selected` 切换事件；④ `agent/pre-step` 惰性兜底（只补从未装过的 relay agent）。
- 幂等：同一 agent 重复 ensure 只装一次；preset 反向切换时 dispose agent-scope 注册；不可逆的合成记 degradation。
- 自检：`relay_status.plane{role, installed, degradations}`。首轮前或会话中切到 Relay 均会回填，**不再要求新建会话**。
- 作用域：preset 行插件的 ctx 不能直接 restrict（会波及同 revision 的队友）——一律在 agent 自己的 ctx 注入。

## 4. 持久化与文件布局（C5）

- 工作区记录 `.scratch/context-relay/`：`progress.md`、`chain.ndjson`、`lessons.md`、`handoff-*.md`、`work-items/<session>.json`、`team/<leadSessionId>/…`、`dispatch/<scope>/<itemId>.json`、`reports/`、`architecture/`、`docs/`。
- 宿主数据 `~/.dsh/data/dsh-context-relay/`：`panel.json`（按会话面板状态）、`settings.json`（侧栏设置）。
- 规则：temp + rename 原子替换；跨进程租约锁（退避 10→1000ms，wait ≤1000ms）；写入 journal 可恢复；写前凭据扫描。`~/.dsh` 侧只做 fsync + rename + 并发冲突 warn（不加跨进程锁）。
- 面板契约版本：`PANEL_SCHEMA_VERSION=3`。载入版本不匹配 → 会话授权（autoCompress / autoHandoff / authorizeNext）一次性失效，模式与架构师设置保留；下次自然写盘落当前版本。

## 5. 策略单源与关键常量（C6/C10）

- `resolveEffectiveThresholds({settings})` 是阈值唯一解析入口：warn = 基准 −5、organize = 基准、relay = 基准 +10；窗口已知只用比例，未知退绝对 token（100k/130k/160k）。legacy `config.thresholds` 已删，唯一来源 `settings.threshold`（默认 35）。
- 面板：`PANEL_OPERATIONS = ['compress','handoff','continue']`（null = 问我）；标签、默认值、schema 版本都只在 policy；client 逐字镜像并由常量契约测试锁住。
- `bandFor`：ok / warn / organize / relay / **unavailable**（投影与计量均缺时显式降级，不猜 ok）。
- 预算：warn 档切 phase 必填 `budget_plan`（proceed/split/relay）；容量保全线 85%。
- 汇报：`USER_REPORT_LIMITS`（默认 600 / 展开 4000 / 单行 400，只 warning 不阻断）；handoff 摘要与列表条数为 advisory。

## 6. notice 流水线（C4）

- 采集（sentinel）→ `planNotices(facts)`（纯函数，每 step 0/1 条，正文 ≤900 字符）→ `deliverPlan`（**投递成功后**才 claim 去重键；失败下一步重试）。
- 去重生命周期：到线档位、容量 used、面板签名、边界 `previous→phase`（出现序号）、闭环签名；`compactionSeq` 上升 → 压缩复位（band 重新武装 + 清 `LEDGER_GUARD` / `BOUNDARY_NOTICES`）。
- `[闭环]` 只认 `write`/`edit`/`apply_patch`；只读工具不清 pending；闭环 target 只取首行并过凭据脱敏；队友稿不带 Lead 台账行；band=unavailable 给一次性保守提示。

## 7. phase、台账与两段式用户门（C7/C9）

- 主链 `discover → decide → build → verify → ship`；`blocked`/`cancel` 出口（`exit_reason` 必填、零副作用拒绝）；允许 verify→build 返修；ship 出口可恢复（仅当本次退出确实从 ship 退出时回 ship，其余仍只能 verify→ship）。
- 两段式用户门：**设计门**——首次进 build（previous ∈ {discover, decide}）必须带 `design_gate{path, user_approved:true}`；**实现↔设计对齐**——ship 的 `user_gate{review, report}` 非空硬门 + `user_gate.verification{tier: minimal|heavy, approved_by_user?, items[]}`，heavy 无用户授权即拒。`contract_check` 只在 ship 必填；`exit_criteria` 只在 discover/decide 且仅 crossing 时校验。
- 台账：items 只在主链跨 phase 时登记（同 phase 传 items 显式拒绝，零副作用）；`phase=null` 条目纳入 strict 关闸；`GET /context-relay/work-items` 纯只读（不触发旧 workspace 台账惰性迁移写盘）；ship 严格校验 done 需 evidence；上限 30，超限先归档 done。
- 委派闸门 `delegationGate`：warn（默认，只提醒）/ strict（命中即拒，零副作用）/ off；build→verify 检查会话 Lead 执行占比与 `lead-exec:` 证据。

## 8. 团队与派活（C8）

- 深度判定：root = lead；depth=1 = teammate（架构师用 spawn 前 pending 标记或 roster 认领）；depth≥2 = worker。
- 队友保鲜：`relay_checkpoint` → `relay_freshen({reset:true, brief})`（真清空）→ 派新任务；`relay_renew` 只用于换身份。reset 成功/回退/失败都会注入结果 notice，`relay_team_status` 汇总 reset 状态；status 签名含 deeper（孙代理数量）防止误判未变。
- 派活：`relay_dispatch` 取台账分点 → 五字段 brief → worker → 台账 doing+owner+next，返回 dispatchId；`relay_collect` 短等 ≤120s、只回 digest，校验回执头 `task==itemId` 与 `revision==dispatchId`。**新鲜度权威 = 落盘的 dispatch 记录**（`.scratch/context-relay/dispatch/`），进程内缓存只是加速；reload 丢内存可观测。

## 9. 交接与 handoff（M-01）

分段执行：预检（零副作用）→ 写完整交接文档 → 建新会话并注入有界摘要 → 新会话确认接管后逐步停旧活（停队友 / 取消后台任务 / 迁移定时任务），每步有恢复点。rc.2 的 schedule seam 按 Host-wide target 语义：`list()` 取分页 `.items`，迁移用 `edit({action:'update', patch:{target}})` 保留投递史；形状不符只降级 N/A + warn，不拒绝交接。

## 10. 失败、降级与兼容

- 预检/校验失败**零副作用**；执行阶段失败可部分成功，但必须记录「操作 id、阶段、失败码、已发生效果、恢复点」，并给恢复动作。
- 底层服务缺失/形状不符 → 降级 N/A + warn，模型可见（`relay_status` / notice）；不静默继续。
- 兼容策略：只支持 DSH 0.2.2-rc.2；更早内核不支持。v0.10.0 已删除全部 v0.9.0 迁移期兼容面（classic 别名、cth/autoChoose/autoDecision/handoffPreset、legacy thresholds、routerMode、next_operation），lib/ 由 compat-grep 防回潮。
- **PTC 程序通道是执行软约束（已裁决不做通道守卫）**：工具面裁剪只隐藏模型工具调用；`run_code` 内 `node:fs` / 子进程仍可直接读写，靠协议纪律、自查与回执约束，不承诺硬隔离。

## 11. 测试与发布

- `node --test test/*.test.mjs`；`npm run check`（全部入口 `node --check`）。
- 契约测试：9 个 seam 形状测试 + `compat-grep`（退役标识防回潮）+ client 常量契约 + panel schema 契约。
- CI：`.github/workflows/ci.yml` 固定 `@deepseek-ai/dsh@0.2.2-rc.2`，`DSH_SEAM_REQUIRED=1` 把缺包 skip 变失败，跑 test + check + `npm pack --dry-run` 断言；发布 workflow 三触发路径都校验 tag == version。

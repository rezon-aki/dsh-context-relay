# 重启后真机验证 Runbook（v0.12 / v0.13-dev）

> 适用：本仓库当前 HEAD（`package.json` 仍标 0.12.0，含 v0.12 发布后的切换/确认键/注入时点修复；下文统称 v0.12 / v0.13-dev）。
> 范围：v0.12 新能力的**真实调用路径**（工具 schema → execute），以及 v0.13-dev 的 `docs.select/layout/metrics` 回滚开关、`confirmKey` 复用、handoff 注入时点。
> 可执行部分：[scripts/smoke-v012.mjs](../scripts/smoke-v012.mjs)。人工项见 §4；组合场景见 §5；盲区见 §6。

## 0. 先决条件

- Node.js >= 20（仓库 `engines`）。
- 当前 checkout 就是 DSH `web` profile 实际加载的那份代码：
  `readlink -f ~/.dsh/profiles/web/node_modules/dsh-context-relay` 应指向本仓库。
- 宿主正在运行：默认 GUI `http://127.0.0.1:3080`（不是则加 `--live-url`）。
- 不在队友/后台任务执行中重启：重启会中断会话内 agent；需要保留的工作先 `relay_checkpoint` / `relay_handoff`。

## 1. 重启步骤（用户执行；本仓库不自动重启宿主）

1. 在跑 `dsh web` 的终端按 Ctrl+C 停止宿主；等进程退出（不要对不理解的目标用 `pkill`）。
2. 重新启动：`dsh web`（或你平时使用的 profile 启动命令）。
3. 打开 / 刷新 GUI。首次刷新建议 **Ctrl+Shift+R**（避免旧 client bundle 缓存）。
4. 确认登录后侧栏能打开；插件 chip/侧栏沿用旧数据（`panel.json` / `settings.json` 不清空）。
5. 跑自动冒烟（§2），再按 §4 做人工面板/模型检查。
6. 若要验证“热重载”而不是重启，跳过 1–2，在插件管理里重载 `dsh-context-relay`（或开发侧 `dev_reload_package({packageName:"dsh-context-relay"})`），然后刷新页面；按 §5-O3 观察。

> 重启后进程内缓存会清空：`docs.inIndex` 变 `null`、risk 档回退保守 T2、reopen 计数可能先报 0、面板实时用量要等下一次 relay_* 工具调用。这些是预期，不是回归。

## 2. 自动冒烟：怎么跑、期望输出

在仓库根目录：

```console
node scripts/smoke-v012.mjs                    # dry-run：只读；不写仓库/真实台账/metrics
node scripts/smoke-v012.mjs --apply            # 追加写路径检查；全部隔离在 OS 临时目录，跑完删除
node scripts/smoke-v012.mjs --apply --keep     # 排障时保留临时目录（会打印路径）
node scripts/smoke-v012.mjs --no-live          # 跳过运行中宿主的 HTTP 路由探测
node scripts/smoke-v012.mjs --live-url http://127.0.0.1:3080
```

**期望（当前 HEAD，宿主在线）：**

| 命令 | 汇总 |
|---|---|
| `node scripts/smoke-v012.mjs` | `PASS 14 · FAIL 0 · SKIP 4`；4 个 SKIP 是写路径，提示加 `--apply` |
| `node scripts/smoke-v012.mjs --apply` | `PASS 18 · FAIL 0 · SKIP 0` |
| `node scripts/smoke-v012.mjs --no-live` | `PASS 13 · FAIL 0 · SKIP 5`（`live.routes` 跳过） |
| `node scripts/smoke-v012.mjs --apply --no-live` | `PASS 17 · FAIL 0 · SKIP 1` |

任一项 FAIL → 退出码 1。脚本可重复跑：fixture 与写路径都在 `mkdtemp` 临时目录，不写仓库、不写真实 `.scratch/context-relay`，也不依赖上次运行状态。

**判定口径（为什么不是内部函数自证）：** 脚本只 import 生产装配用的 `createRelayTools` / `createTeamTools` / `createRelayHandoffTool`，然后调用工具定义的 `execute()`；每次调用前按该工具 `parameters` 做 schema 校验（required / additionalProperties / enum / anyOf），保证参数就是模型能看到的字段。`confirmKey` 复用只通过 `relay_phase` → `relay_work_items` 的公开返回体取证，不 import `confirmKeyOf` / `writeWorkItems` 等内部实现。

### 2.1 覆盖矩阵（自动项）

| Check ID | 覆盖的能力 | 走哪条真实路径 | 期望 |
|---|---|---|---|
| `status.docs` | `relay_status.docs` 埋点块 | `relay_status` 工具 | 干净目录：`available=false`、`injects=0`、`file=...metrics/...` |
| `status.delegation` | `relay_status.delegation` 字段 | `relay_status` 工具（伪投影 4/10） | `execRatio=0.4`、`dispatchCount=2`、`collectCount=1`、`idleWorkers=null`、`basis=projection`、有 `advice` |
| `docs.A` | L0 A 层：在役/带决策/目录折叠 | `relay_doc({action:"index"})` | `level=A`；`### 在役（先读）`、`### 带决策`、`### 折叠（按目录…）`；pin 的 `architecture/design.md` 单列；raw/reports 不单列；普通 L2 进组；组行都有展开命令 |
| `docs.B` | `docs.width` → B 层 | 同上（config `docs:{width:200}`） | `level=B`；无常驻决策分组；只单列 pin（`shown=1`） |
| `docs.C` | `docs.maxGroups` → C 层 | 同上（`docs:{maxGroups:0}`） | `level=C`；一行「其余 N 份 / M 目录已折叠」+ `relay_doc list include=all`；pin 仍可见 |
| `docs.layout=flat` | 关掉 W/G 自动层级 | `docs:{layout:false,width:1,maxGroups:0}` | `level=A`（width/maxGroups 被忽略） |
| `docs.select=legacy` | 真回滚 v0.11（不是近似） | `docs:{select:"legacy"}` | `level=legacy`；`### 先读（L1）` + `### 按需（L2）`；无 v0.12 分组；历史产物尾行 |
| `docs.metrics=off` | 关掉埋点与 status.docs | `docs:{metrics:false}` | 不创建 metrics 目录/文件；`relay_status` 无 `docs` 键 |
| `phase.T2-design-gate` | T2 设计门回显硬门 | `relay_phase({phase:"build", design_gate:{path,user_approved}})` | 拒绝 `code=design gate`；四段式 `human`；不写台账 |
| `phase.ship-user-gate` | ship 用户门 | `relay_phase({phase:"ship"})`（前态 verify） | 拒绝 `code=user gate`；零副作用 |
| `phase.warn-budget-plan` | warn 档 budget_plan | `relay_phase` 跨 phase（前态 build，band=warn） | 拒绝 `code=budget plan`；零副作用 |
| `handoff.approval` | `relay_handoff` 审批门 | 工具（`human_approved:false`） | `code=human-approval-required`；不建会话、不发消息、不写新 handoff 文件 |
| `handoff.injection-timing` | 注入事件时点 | 工具 + 同形宿主服务替身（不 import 内部派生） | 验收失败：0 条注入事件、消息未塞入；验收成功：恰好 1 条 `type=inject, site=handoff`；首条消息注入时 handoff 文件与 `progress.md` 已落盘；消息含「文档索引」「完整交接单」 |
| `workitems.confirmKey` | 自动确认 + 二次复用 + 内容绑定 | `relay_phase`（T1 文档条目）→ `relay_work_items` 整表替换 | 自动确认 `auto=T1`、三项 true、8–64 hex `confirmKey`；重放 `auto+confirmKey` 成功且 rev+1；改内容或错 key 均 `done-gate` 且 rev 不变 |
| `status.docs-after-index` | docs 块真实计数 | `relay_doc index` → `relay_status`（同一 session） | `available=true`、`injects>=1`、`text` 有 `docs: 注入 1` |
| `team.tools` | team 面工具注册 + 权限 | `createTeamTools` → Lead 调 `relay_checkpoint` / `relay_freshen` | 两个工具都在 teammate 工具面、schema 有 `one_line`/`reset`；Lead 调用 `code=teammate-only`；零写入 |
| `team.checkpoint-freshen` | team 面写路径 | 队友身份调用两工具 | checkpoint 落盘且内容含一行结论；freshen `reset:true` 返回 `wipe-scheduled` 且 brief 文件存在 |
| `live.routes` | 运行中宿主已装载插件 HTTP 面 | GET 四个 `/context-relay/*` | `200` / `3xx`（登录跳转）/ `401/403`（已注册，需鉴权）都算已挂载；`404` 判 FAIL；连不上宿主 → SKIP |

> 说明：`docs.A/B/C`、`docs.select/layout/metrics` 的配置通过工具 runtime 的 `docs` 选项注入（生产由 agent options 归一化后传入，见 `lib/index.js` 的 `docs` 配置）；不是脚本内部开关。

## 3. 逐项失败排障

| 现象 | 先查 | 处理 |
|---|---|---|
| 所有检查在 `createRelayTools` 处抛错 / 找不到模块 | Node 版本、当前目录、`lib/` 是否完整 | `node --version` >=20；在仓库根跑；`npm run check` |
| `status.docs` FAIL 且 `available=true` 在干净目录 | 临时目录是否被上次残留污染 | 确认无 `--keep` 残留；重跑 |
| `docs.B/C` FAIL（层级仍是 A） | `docs.width/maxGroups` 是否真的传进 runtime；`docs-policy.js` 是否被改 | 看 `test/docs-v2.test.mjs`；确认装配传 `docs` 字段 |
| `docs.select=legacy` FAIL（仍是 A） | 是否传成 `docs:{select:false}`（也等价）但断言看错 | `level` 应为 `legacy`；旧渲染没有 A/B/C |
| `docs.metrics=off` FAIL（有 metrics 文件） | 是否有别的检查复用同一 cwd/session | 脚本每个 check 独立临时目录；确认没改脚本的 `withWorkspace` |
| `phase.*` 没拒绝反而成功 | 风险档是否被断言成 T1；投影 phase 是否对 | 显式 `risk:{tier:"T2"}` 只降不升；看 `lib/risk.js`/测试；拒绝应零副作用 |
| `handoff.injection-timing` 失败 | 注入事件 sessionId 是否与 metrics 文件一致 | 脚本扫整个 metrics 目录，不假设文件名；若 0 条，先查 `docs.metrics` 是否被关、index 是否 shown>0 |
| `workitems.confirmKey` 首次 done 就拒绝 | 台账 `currentPhase.risk.tier` 是否 T0/T1；条目是否被判文档项 | T1 文档条目需要 `title/evidence` 命中文档特征；非文档条目要显式三项 true |
| 复用成功但内容变更仍复用 | `diffHash` 是否落盘；条目内容是否真的变了 | 改 title/evidence/acceptance 任一即失效；只改 status 不构成新内容 |
| `team.*` 全部 teammate-only 或 no-service | 是否用 Lead 身份跑写检查；宿主团队服务是否启用 | 只读探测允许 Lead 拒绝；写检查用脚本内置 teammate 替身；真机看 §4-M8 |
| `live.routes` 404 | profile 是否加载本插件、是否重启 | `readlink` 指向本仓库；重启 profile；刷新页面；再看 `relay_status.plane`（真实会话内） |
| `live.routes` SKIP | 宿主没起 / 端口不同 | 用 `--live-url` 指定；或 `--no-live` 接受 SKIP |

## 4. 必须人工验证的项（本机无法自动断言）

以下项依赖真实宿主、模型调用或 UI 渲染，脚本只能间接覆盖（列出对应自动项），**重启后必须人工看一眼**：

| ID | 人工动作 | 期望 | 对应自动项 |
|---|---|---|---|
| M1 | 新建接力会话，看输入框上方 chip | 出现接力 chip：`接力 X% · <模式短标签>`（问我/继续/压缩/接力）；到线才带「· 已到线」；悬停 title 显示「接力面板 · 上下文 X% · 阶段 <中文> · 已压缩 N 次」；**不出现** `band=` / `autoCompress=` / `phase=` 等内部键 | `status.docs/delegation` 仅验证数据形状 |
| M2 | 点 chip 打开 popover | 标题「上下文接力 · 本会话」；状态行「上下文 X% · 已压缩 N 次」；表盘四档「问我 / 继续 / 压缩继续 / 接力新会话」；水缸三项「压缩免审批（本会话）」「交接免审批（本会话）」「新会话注入『预算无上限』」；底部「授权下一次操作」；台账入口行「工作台账 · 未闭合 x / 共 y」 | 无（UI） |
| M3 | 同会话让模型调用 `relay_status`，把返回的 `lead.used/window/ratio` 与 chip/popover 百分比对比 | 四舍五入一致（允许 4s 轮询/一步延迟）；`lead.band` 为 organize/relay 时 chip 才带「· 已到线」（warn 不带）；用量数字不是 `?`/`—`（载入后应自动刷新） | `status.delegation` |
| M4 | 看模型侧 `relay_status.text` | 有 `docs: 注入 n · 读 n · 命中 n（x%）· 搜 n` 行（metrics 开启时）；`delegation:` 行；无内部键泄露到 `human` | 自动项已验数据；文案需人工 |
| M5 | T2 任务首次进 build，故意不带 `ask_ref/not_doing` | 模型收到四段式拒绝（结论/影响/需要你做什么/证据），**零文件改动**；补全后放行 | `phase.T2-design-gate` |
| M6 | verify→ship，故意不带 `user_gate` | 同样四段式拒绝；补独立审查 + 汇报后放行；heavy 无用户授权仍拒 | `phase.ship-user-gate` |
| M7 | 让模型在真实会话执行 `relay_handoff`（先明确批准） | 旧会话归档；新会话**首条消息**是交接摘要（不是用户敲的），含「文档索引」「完整交接单」「接手入口」；新会话 `relay_status.workItems.phase.pins` 延续；旧队友/任务被中断 | `handoff.injection-timing`（服务替身） |
| M8 | 派一个队友，检查它的工具面 | 队友有 `relay_checkpoint`/`relay_freshen`，看不到 `relay_work_items`/`relay_handoff`/`relay_organize`/`relay_recommend`；架构师与普通 worker 看不到 `relay_status` 和 `relay_phase`；`doc_lint` 只有 Lead；`human-loop` 只在 Lead | `team.tools` 仅工具面形状 |
| M9 | 队友执行一次 checkpoint，再让 Lead 换代/重置 | checkpoint 落盘、新代能读到；reset 后旧上下文不可见、brief 为新任务说明 | `team.checkpoint-freshen` |
| M10 | 压缩后看新会话/当前会话 | 压缩后注入「阶段交接摘要」notice；docs 索引只在压缩成功后计 1 次 `site=organize-brief`；旧事件可用 `session_event_read` 回读 | 注入时点用 `handoff` 替身，organize-brief 需真实压缩 |
| M11 | 重启后不发送消息看面板 | chip 百分比先显示 `?`，popover 显示「实时状态暂不可得：宿主尚未载入该会话的上下文状态」；下一次 `relay_status`/任意 relay 工具后自动刷新；`docs.inIndex=null` 属预期 | `live.routes` 只证明路由 |
| M12 | 三个回滚开关的真实装配 | 在部署配置里分别设 `docs.select=legacy`、`docs.layout=flat`、`docs.metrics=off`，重载后看 `relay_doc index` / `relay_status` 行为与脚本预期一致；改回默认恢复 | `docs.*` 用 runtime 注入，未验宿主配置读取 |

> 面板相关 M1/M2/M3/M11 是“必须人工点击/观看”的硬项：自动化只能验数据与文案片段，渲染/布局/动效/数字对齐无法替代。

## 5. 正交组合矩阵（重启 × 交接 × 压缩 × 热重载）

| # | 场景 | 操作（人工） | 期望 | 失败排查 |
|---|---|---|---|---|
| O1 | **重启后交接** | 重启 → 打开旧 Relay Lead → 让模型 `relay_status`（确认 `plane.installed=true`）→ `relay_handoff`（批准） | 新会话首条消息含交接摘要 + docs 索引 + 完整交接单位置；`workItems`/pins 复制到新会话作用域；旧会话 `handedOff`；chain.ndjson 有新 handoff 条目；子会话 docs 注入事件 site=handoff | 若 `services-unavailable`：宿主/profile 未装好；若新会话无消息：takeover 未确认（见 handoff 返回 recovery，不要重复建会话） |
| O2 | **压缩后交接** | 当前 Lead 先 `relay_organize`（真实压缩）→ `relay_status`（`compaction.debt=true`、`organizeCount=1`）→ `relay_handoff` | organize-brief 注入事件 1 条（site=organize-brief）；交接后 child 注入事件 1 条（site=handoff）；新会话摘要带「链式召回」段；旧会话授权清空、`handedOff=true`；新会话 `unlimitedBudget` 继承 | 二次压缩被面板「压缩一次」限制；chain 失败只 warn 不阻断；metrics 两条事件分别归因 |
| O3 | **热重载后状态** | 不重启宿主，重载插件 → 刷新页面 → 旧会话调 `relay_status` | `plane.installed=true`、`role` 正确、`degradations=[]`；work-items rev/phase 不变；工具不重复注册；docs 块可读（`inIndex=null` 预期）；**risk 档回退 T2**，需重新声明 `risk`；面板 chip 在首次 relay 工具后刷新 | `plane.installed=false`：看 `degradations`（seam 缺失/preset 未挂）；工具重复：插件卸载不净，重启宿主 |
| O4 | **重启 + 压缩 + 交接连做** | 重启 → 压缩 → 交接 → 在新会话再 `relay_status` | 每次操作各自留事件/chain；新会话 `compaction.debt=false`（新上下文）；旧会话 chain 有 compaction+handoff 两条；旧会话 `docs.lastInject.site=organize-brief`，新会话 `docs.lastInject.site=handoff` | 事件串台：看 metrics 文件按 sessionId 分（旧会话 vs child）；注入计数只认成功 |
| O5 | **重启后回滚开关仍生效** | 配置 `docs.select=legacy` 后重启 → 旧会话 index | `level=legacy`、无 A/B/C；改回默认再重启恢复 A；`docs.metrics=off` 时重启后 metrics 文件不再增长 | 配置未生效：确认 agent options 的 `docs` 归一化路径；重启后进程内状态清空，但配置应持久 |

## 6. 已知盲区 / 本机无法自动验证

1. **宿主是否真的加载了新代码**：`live.routes` 只能证明插件 HTTP 面已挂载（旧版也有同样的路由）；要确认“新版逻辑”必须通过 §4 的真实模型调用 / 面板行为，或看启动日志。
2. **模型侧工具列表与角色裁剪**：自动项只验证工厂返回的工具面；真实宿主 catalog 的 scope 裁剪（teammate/architect/worker）需 §4-M8。
3. **真实新会话创建与首条消息投递**：脚本用同形服务替身验“注入时点”，真实 `sessionController.create` / inbox / followup / 审批弹窗需 §4-M7。
4. **真实压缩引擎**：`relay_organize` / 官方 `compactIfNeeded` 的实际遮蔽、brief 注入、chain 记录无法在无宿主时复现；§4-M10。
5. **面板渲染与文案**：chip、popover、水缸、动效、金额/百分比排版、窄侧栏布局、中文标签需人工看；自动脚本只断言数据/四段式文本的部分片段。
6. **运行中宿主的授权/审批**：`autoCompress/autoHandoff/authorizeNext` 与官方 approval waterfall 的交互需真实点击；脚本不触发审批。
7. **热重载后的进程内缓存**：risk 档回退 T2、reopen 计数、docs `inIndex`、容量读数的 TTL 都要看真实会话时间线。
8. **重启后并发/团队**：旧队友中断、任务迁移、容量额度、跨会话台账隔离需真机（脚本只覆盖单 teammate 写路径）。
9. **v0.13-dev 未发布**：`package.json` 仍是 0.12.0；发布前需要版本/CHANGELOG 另行处理，本 runbook 不代替发布检查。

## 7. 回滚

- 冒烟 FAIL 先保留现场：`--keep`、记录 `node scripts/smoke-v012.mjs --apply --verbose` 输出；不要直接改 `lib/` 掩盖。
- 需要回到 v0.12 已验证行为：`git checkout -- lib/`（或切回发布 tag）→ 重启/重载 → 复跑本 runbook；数据文件无迁移，回滚后 `docs.select/layout/metrics` 恢复默认即可。
- 插件不会自动删用户数据；不要为了复跑脚本清空真实 `.scratch/context-relay`。

## 8. 相关文档

- 冒烟脚本：[scripts/smoke-v012.mjs](../scripts/smoke-v012.mjs)
- 设计/门禁：[docs/design/DESIGN.md](design/DESIGN.md)、[docs/design/ARCHITECTURE.md](design/ARCHITECTURE.md)
- 升级/回退：[docs/design/MIGRATION.md](design/MIGRATION.md)
- v0.12 行为变更：[CHANGELOG.md](../CHANGELOG.md)

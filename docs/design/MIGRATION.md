# 迁移说明（v0.11.0）

> 本文覆盖 **v0.11.0** 与 **v0.10.0** 两次升级：v0.11.0 无数据格式破坏，只有默认值与行为变更（见 §0）；v0.10.0 的兼容债删除与 schemaVersion=3 见 §1 起。
>
> 设计目标与边界见 [DESIGN.md](DESIGN.md)，实现架构与 seam 契约见 [ARCHITECTURE.md](ARCHITECTURE.md)，逐版本行为变更见 [CHANGELOG.md](../../CHANGELOG.md)。

## 0. 升级到 v0.11.0（先读）

**无数据迁移。** `panel.json` / `settings.json` / `roster` / `work-items` / `retired.ndjson` 格式不变；旧 settings 缺新键时取默认。

| 项 | v0.10.0 | v0.11.0 默认 | 回退到旧行为 |
|---|---|---|---|
| 容量保全线 | 写死 85% | `settings.capacityThreshold=55`（独立、[20,95]） | `capacityThreshold:85` |
| spawn | 默认可用 | `allowSpawn=false`（spawn 关闭） | `allowSpawn:true`，需要时调大 `squadMax` |
| 小队展示 | 列出全部当前代 | 默认只 squad（上限 8，含架构师）；legacy/retired 给计数 | 无数据回退；`include_legacy/include_retired` 查看，数据未删 |
| 到线语义 | 升线只告知 | 四档：起点主动管理 / warn 现在动手 / organize·relay 兜底 / capacity 55% 最坏兜底 | 无开关；文案与推荐随新版，数据不变 |
| ship 后返修 | 直接切 build/verify | 必须 `reopen{reason,user_approved:true}` | `reopenGate:'off'` = v0.10 旧行为 |
| 新起点自查 | 无 | `contextCheck:'on'` | `contextCheck:'off'` 全静默 |
| 宿主压缩兜底 | 无 | `compactionFallback:'on'`（host 归因写快照+一次 notice） | `compactionFallback:'off'` 只日志 |

升级步骤：备份 `~/.dsh/data/dsh-context-relay/` 与工作区 `.scratch/context-relay/`（可选但推荐）→ 安装 `dsh-context-relay@0.11.0` → 重载 profile/刷新页面 → 按需在新 settings 里设置 `capacityThreshold` 与各开关 → 跑一次 `relay_status` 确认版本/平面正常。

回滚：代码回退 v0.10.0，默认值/行为回到旧口径；新写入的数据文件格式兼容，无需迁移。注意 v0.10.0 自身相对 0.8.x 的授权失效不可逆（见 §1）。

## 1. 原则（v0.10.0 基线）

- **一次删净**：v0.9.0 的兼容窗口在 v0.10.0 关闭——旧字段、旧 id、旧配置不再「读入归一」，而是删除或按新语义拒绝。升级前先完成第 3 节动作。
- **用户数据不自动删除**：`panel.json` / `settings.json` 与工作区 `.scratch/context-relay/**` 保留；插件不自动改写旧交接、报告、进度等文件。
- **授权一次性失效**：panel `schemaVersion` 2 → 3，旧会话授权不可逆失效，需用户重新授权；模式与架构师设置保留。
- **协议语义变更不迁移旧会话内容**：旧会话里模型学到的旧口径不会自动纠正；升级后用新协议，必要时 `relay_handoff` 开新会话承接。
- **只支持 DSH 0.2.2-rc.2**：更早内核（rc.1 / 0.2.1 系列）不再支持。

## 2. 破坏性变更表

| # | 对象 | 0.8.x 旧形态 | v0.10.0 现状 | 升级动作 |
|---|---|---|---|---|
| MIG1 | classic preset / 旧会话 | preset id `relay`（双模式之一，与 `relay-long` 并存） | classic 别名**已删除**，只注册 `relay-long`；旧 classic 会话打开后不挂 relay 平面 | 打开旧会话 → 模式选择器选「接力模式（Relay）· 超长任务」自动回填 Lead 平面（也可新建会话；见 MIG9） |
| MIG2 | 面板授权（panel.json） | `schemaVersion=2` 或更早；`autoCompress`/`autoHandoff`/`authorizeNext` 可能有效 | `schemaVersion=3`；**旧文件载入时一次性失效全部会话授权**（不可逆），模式/架构师/预算无上限等非授权字段保留 | 打开面板重新开启需要的自动授权；一次授权只对当前会话+操作+版本有效 |
| MIG3 | 面板隐藏档 `compress-then-handoff`（cth） | 旧面板快照/侧栏默认可能是该档 | 枚举删除；旧值读入归一为 `null`（问我） | 无数据动作；到线时按新模式选择继续方式 |
| MIG4 | `autoChoose` / `autoDecision` / `handoffPreset` | 面板开关 / 字段 / PUT 白名单 | 字段与语义全部删除，PUT 不再接受，旧值丢弃；交接目标恒为唯一模式 | 无需动作（旧值不再生效） |
| MIG5 | legacy `config.thresholds`（0.35/0.40/0.50 旧基准） | 部署显式配置的旧比例线，无界面设置时生效 | 删除；阈值唯一来源 = `settings.threshold`（默认 35），四档由基准派生 | 把旧基准换算为 `settings.threshold`（旧 organize 线 ×100），或在侧栏插件卡改基准 |
| MIG6 | `routerMode` / `legacyPresetCompat` / `presetId` 双 id | 双模式开关与两个 preset id 配置 | 删除；唯一模式 id = `longPresetId`（默认 `relay-long`，未配时由 `presetId` + `-long` 派生） | 删除旧配置键；需要自定义 id 时只配 `longPresetId` |
| MIG7 | `relay_phase` 的 `next_operation` | 旧入参（早已被忽略，仍写入面板） | schema 删除；下一步只走台账条目 `next` 字段 | 改用 `relay_work_items` 维护 `next` |
| MIG8 | 用户门 / 协议 | `contract_check` 每次切 phase 必填；无设计门；无验收分级 | **两段式用户门**：首次进 build 必须带 `design_gate{path,user_approved:true}`；`contract_check` 只在 ship 必填；ship 的 `user_gate.verification` 分 `minimal`/`heavy`，heavy 须用户明确授权；实现↔设计对齐改为与验收并行的独立审查 | 无数据动作；按新协议工作（首次实现任务先出设计稿交用户确认） |
| MIG9 | preset 切换口径 | 旧文档要求「新建会话时选模式 / 切换需新会话」，首轮前切换会静默失效（M-02） | 修复：首轮前或会话中切到 Relay 都会由声明式 reconcile 回填 Lead 平面（`relay_status.plane` 自检） | 旧会话无需重建；切一次 preset 即生效 |
| MIG10 | 台账语义 | 同 phase 传 `items` 静默丢弃；`phase:null` 条目可绕过 strict 关闸；`GET /context-relay/work-items` 可能触发惰性迁移写盘 | 同 phase 传 `items` **显式拒绝零副作用**；`phase=null` 视同当前 phase 纳入关闸；GET 纯只读；ship 出口可恢复；`next_operation` 删除 | 无数据迁移；行为收紧，按新契约用 `relay_work_items` 补分点 |
| MIG11 | handoff 定时任务盘点 | 旧 `schedule.list()` 数组 + `delete/create` 迁移（rc.2 下 preflight 恒拒） | 按 rc.2 Host-wide target：`list()` 分页 `.items`、`edit({action:'update',patch:{target}})` 保留投递史；形状不符降级 N/A + warn，不拒绝交接 | 无需动作；旧定时任务在新形状下可盘点/迁移 |
| MIG12 | 面板 / notice 行为细节 | 双 4s 轮询；`[闭环]` 由 bash 等变更类工具触发；只读 `relay_work_items` 会清 pending；notice 先记后投递、target 含命令片段 | 单轮询器并行 2 GET；`[闭环]` 只认 write/edit/apply_patch；只读工具不清 pending；**投递成功后才记**去重键；target 首行 + 脱敏；压缩后复位去重 | 无需动作（行为改善） |
| MIG13 | 工作区级台账 / 团队旧分区 | `.scratch/context-relay/work-items.json`、无 Lead 会话分区的 `team/<lineage>/` | 会话级台账仍是主路径；旧 workspace 台账读取时 best-effort 同步（GET 不再触发写），旧 team 分区只读回退——两者长期保留、不迁移 | 无需动作；旧文件保留，可人工清理 |
| MIG14 | 卸载即净 | 卸载后的持久记录 | 不变：注销 preset / skills / HTTP 路由 / 工具 / 投影 / 哨兵；**保留**用户数据与工作区记录 | 需要清理时先备份，再人工删除 |
| MIG15 | 委派闸门 `delegationGate` 的 `strict` 档 | v0.9.0 预留：`strict` 被静默归一为 `warn`，build→verify 只提醒不拒绝 | v0.10.0 启用：`strict` 原样生效——build→verify 命中（会话累计 Lead 执行占比 >20% 或 build/verify 分点由 Lead 自做且无 `lead-exec:` 证据）即 `relay_phase` 拒绝（零副作用）；默认仍 `warn`（只提醒）/ `off` 关闭 | 无数据动作；需要硬门时才配 `delegationGate: 'strict'`，默认行为不变 |

## 3. 升级步骤

1. **备份（可选但推荐）**：`~/.dsh/data/dsh-context-relay/panel.json` 与 `settings.json`；有进行中的长任务时，先让它完成或在旧版本上 `relay_handoff`。
2. **升级插件**：按 README 安装方式卸载重装新版（或 `dsh plugin --profile web add dsh-context-relay@0.10.0`），重启/重载 profile、刷新页面。
3. **重新授权**：旧 `panel.json` 首次载入即失效全部会话授权；打开面板重新选择到线处理方式、按需开启自动授权（模式与架构师设置已保留）。
4. **清理旧配置**：部署配置里如显式写了 `thresholds` / `routerMode` / `legacyPresetCompat` / classic `presetId`，删除它们；阈值改配 `settings.threshold`（或 `threshold`），自定义 preset id 只配 `longPresetId`。
5. **旧 classic 会话**：打开后在模式选择器切换到「接力模式（Relay）· 超长任务」，Lead 平面会自动回填；不想迁移旧上下文就直接新建接力会话。
6. **验证**：新建或切换一个接力会话，确认状态条出现；`relay_status.plane.installed=true` 说明平面装好（`degradations` 非空时按提示检查内核 seam）。
7. **数据保留**：旧交接/报告/进度/团队记录等不自动删除；需要清理时先备份再人工归档。

## 4. 回滚

- 代码回退到 0.8.x 后：新 panel.json 的 `schemaVersion=3` 会被旧代码当作未知版本/未知键处理——会话记录仍在，但**授权已被清空（不可逆）**，回滚后需用户重新授权；v0.10.0 期间写入的 `defaultOperation` 三档在旧版仍可识别。
- 协议/工具面按旧版代码运行；旧会话内容不受影响。数据文件不丢，回滚不需要额外迁移。

## 5. 保留（不迁移）对象

以下对象不进入迁移动作：`progress.md` / `lessons.md` / `chain.ndjson` / `handoff-*.md`、`reports/` 与 `architecture/` 文档、台账归档、archived chain/lessons 指针、scheduled tasks / jobs、architect roster 记录。它们不自动改写、不自动删除。

## 6. 卸载

卸载注销 preset / skills / HTTP 路由 / 工具 / 投影 / 哨兵；保留用户数据（`panel.json` / `settings.json`）与工作区 `.scratch/context-relay/**`。插件不自动删除数据；需要清理时先备份，再用文本编辑器人工删除。

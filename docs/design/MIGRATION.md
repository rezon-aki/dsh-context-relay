# 迁移说明（v0.9.0）

> 迁移窗口：**v0.9.0 = 归一 + 只读兜底**（旧会话、旧配置、旧数据继续可用）；**v0.10.0 = 删除兼容路径**（见迁移表末列）。
>
> 设计目标与边界见 [DESIGN.md](DESIGN.md)；逐版本行为变更见 [CHANGELOG.md](../../CHANGELOG.md)。

## 1. 原则

- **归一而非迁移**：v0.9.0 在读入时把旧形态解释为新语义（不报错、有兜底），不自动重写旧文件；需要新格式落盘的内容（如面板 `schemaVersion`）在下一次自然写盘时收口。
- **只读兜底**：旧值可读、无副作用；不再生效的字段读到后忽略或归一，不报错。
- **删除有窗口**：兼容路径在 v0.10.0 统一删除；删除后旧会话/旧配置按新语义失效属预期，升级前先完成迁移。
- **不可逆项只有授权**：授权失效后需用户重新授予；其余旧数据不删除。磁盘上的历史文件（旧交接、旧报告等）不做自动改写，需要时人工清理。

## 2. 迁移表

| # | 对象 | 旧形态（v0.8.x 及更早） | v0.9.0 归一动作 | 只读兜底 | v0.10.0 删除项 |
|---|---|---|---|---|---|
| MIG1 | classic preset / 旧会话 | preset id `relay`（双模式默认，Lead 可亲自执行） | 不再注册为生产模式；以**行为相同**的别名 id 注册（部署配置 `legacyPresetCompat` 默认开，描述标「旧会话兼容」） | 旧会话继续可打开/挂载 relay，行为不变；模式选择器多出一个标「旧会话兼容」的别名条目 | 删除 classic 别名 |
| MIG2 | 长模式 preset / 会话 | `relay-long`（routerMode=true） | 成为唯一生产模式（唯一 id `relay-long`）；显示名保留「接力模式（Relay）· 超长任务」 | 旧会话 id 不变即可继续用（零迁移） | 无 |
| MIG3 | 部署配置 `presetId` / `longPresetId` / `routerMode` | 双 id 配置 + 可选 routerMode | 单一模式唯一 id（默认 `relay-long`）；`routerMode` 读到时忽略并 warn 一次；`longPresetId` 若已配置沿用为唯一 id；`presetId` 仅作旧别名 id | 旧配置不崩、按新语义解释 | 移除 `routerMode` 读取 |
| MIG4 | 面板隐藏档 `compress-then-handoff` | 旧面板快照/侧栏默认可能为该档 | 归一为 `null` = 问我；单一模式永久移除该档 | 读到该值不崩；归一为 `null` = 问我（需人类选择继续方式）；读入时不清盘，下一次自然写盘时收口 | 从面板枚举/归一逻辑中删除该档 |
| MIG5 | 面板隐藏档 `autoChoose` / `autoDecision` | 旧长模式隐藏「自动（模型决定）」，可能出现 autoChoose=true + autoDecision | 单一模式不展示该档；迁移期归一为 `autoChoose=false`、`autoDecision=null`（退役，不保留为高级开关） | 面板读旧值不崩；autoDecision 只在 autoChoose 时生效（归一已保证） | 删除字段 |
| MIG6 | 旧授权（`autoCompress` / `autoHandoff` / `authorizeNext`） | 任意旧会话/旧版本留下的授权，且旧行为会随接力继承 | 面板 `schemaVersion` 版本化：旧文件载入时全部授权字段失效；接力不再继承授权，接力成功清旧会话授权 | 授权失效不报错；面板显示关；用户可重新开启 | 无（此后授权仅当前会话内有效） |
| MIG7 | `handoffPreset`（下一个新会话模式） | 面板二态开关 + panel.json 字段 + PUT 白名单 | 删除客户端开关；PUT 兼容接受但忽略（返回 deprecated，不 400）；handoff 目标恒为唯一模式；旧值读入后不再生效 | 旧值可读、无副作用 | 删除字段与 PUT 语义 |
| MIG8 | legacy `config.thresholds`（40/50 旧基准） | 部署显式配置的旧比例线（0.35 / 0.40 / 0.50），无界面设置来源时生效 | 继续支持（按旧线工作，反推显示基准），载入时 warn 一次「旧 thresholds 已退役，请迁移到 `settings.threshold`」；新部署默认 35% 基准不变 | 读旧配置不崩、按旧线工作 | 移除 legacy 路径（届时统一归一到 `settings.threshold`） |
| MIG9 | 旧 settings 键 | 已删除键（`autoPhase` / `autoContinue` 等）与旧侧栏 `unlimitedBudget` 默认 | 继续忽略（`normalizeSettings`），文档标注；不报错 | 读旧文件不崩 | 可删兼容忽略（保留忽略成本低，可长期保留） |
| MIG10 | workspace 级台账 `.scratch/context-relay/work-items.json` | v0.5.1 之前的旧路径 | 读取时 best-effort 同步到会话级台账；不迁移、不删除旧文件 | 旧文件保留 | 评估移除（若不再有旧会话写入） |
| MIG11 | team legacy 分区 `.scratch/context-relay/team/<lineage>/` | v0.3.1 之前的无 Lead 会话分区 | 保留只读回退；不迁移、不删除 | 旧记录只读回退 | 长期保留（成本低） |
| MIG12 | 无 `schemaVersion` 的 panel.json | 旧文件 `{ sessions: {...} }` | 载入时补 `schemaVersion: 2` 并按 MIG6 失效授权；其余字段尽量保留（未知键仍丢弃） | 损坏文件隔离为 `*.corrupt-<ts>`，保留内存旧值（fail-safe） | 无 |
| MIG13 | 旧文档（README / SKILL / 设计文档）的双模式口径 | 文档仍写双模式、推荐派活、2–4 人 | v0.9.0 同步改单模式/强制 brief/默认 4；显示名保留双名「接力模式（Relay）· 超长任务」并注明为唯一模式；历史设计文档标「已被 v0.9.0 取代」 | 历史文档保留 | 无 |
| MIG14 | 卸载即净 | 插件卸载后的持久记录 | 明确注销 preset / skills / HTTP 路由 / 工具 / 投影 / 哨兵；**保留**用户数据（panel.json / settings.json）与工作区 `.scratch/context-relay/**`（handoff、报告、架构文档、progress、lessons、chain、work-items、team） | 卸载后数据可读、可用文本编辑器清理 | 无 |

## 3. 保留（不迁移）对象

以下对象与模式退役无关，不进入迁移动作：progress / lessons / chain / handoff 文件、reports 与 architecture 文档、scheduled tasks / jobs（交接清理逻辑已覆盖）、architect roster 记录。它们不自动改写、不自动删除。

## 4. 升级、回滚与卸载

**升级步骤**

1. 升级插件后，旧会话仍可打开（classic 别名在迁移期保持同行为）。
2. 新建会话时选择唯一模式「接力模式（Relay）· 超长任务」。
3. 面板授权（自动压缩/自动交接/一次免审）在版本/会话变更后失效，按需重新开启。
4. 部署若显式配置了旧 `thresholds`，按 warn 提示迁移到 `settings.threshold`。
5. 旧数据文件不自动清理；需要时人工归档或删除。

**回滚**

代码回退后，带 `schemaVersion` 的新 panel.json 会被旧版代码丢弃未知顶层键（sessions 仍在）→ 行为回退但数据不丢。授权字段可能已被清空（不可逆），回滚后需用户重新授权。

**卸载**

卸载注销 preset / skills / HTTP 路由 / 工具 / 投影 / 哨兵；保留用户数据（panel.json / settings.json）与工作区 `.scratch/context-relay/**`。插件不自动删除数据；需要清理时先备份，再用文本编辑器人工删除。

# Changelog

面向使用者的版本变更记录（每个版本更新了什么）。内部设计草稿、验收、审计与研究记录不随发布提供（公开架构/迁移文档见 docs/design）。

## v0.12.0 (2026-11-19)

「说人话 + 按风险配门禁 + 按需取文档」：在 v0.11.1 上补齐六块短板——统一四段式用户文案与内部键隔离、验证风险分级 T0/T1/T2 与门禁矩阵、T2 设计门回显与设计深度模板、文档索引 v2（在役/决策单列 + 目录折叠 + A/B/C 分层 + 注入计量）、角色注入裁剪（human-loop 与 ask_user 只给 Lead）、AOCI 语义层（constraints/contracts/relations）。工具数与协议不变（仍 15 个工具），无数据迁移。

### 行为变更（升级前必读）

- **验证风险分级默认生效**：`relay_phase` 新增 `risk{tier,reason,paths,lines,public_surface,data_format,permissions,irreversible,external,user_visible}`；不传则按改动面自动判档（未知保守 T2，T0 缺 reason 降 T1）。T0（文档/≤20 行）免 `exit_criteria`、免设计门、免 `user_gate`（含独立审查与汇报）与契约自检；T1（局部代码）免设计门，ship 留 report + 一次 diff 审查；T2（公开面/数据格式/权限/不可逆/>300 行）全门照旧。结果返回 `risk` 与被免的门（`gateWaived`）。
- **T2 设计门必须回显**：首次进 build 的 `design_gate` 除 path/user_approved 外必须带 `ask_ref`（逐字用户原话 ≤300 字）与 `not_doing`（1–10 条不做清单），缺任一零副作用拒绝；只带旧字段的调用会被拒。doc_lint 对超 3 页、超 5 条提案、缺回显只给 advisory WARN。
- **用户可见文案四段化**：notice、失败返回与 `relay_status`/`relay_phase`/`relay_handoff` 结果统一「结论 / 影响 / 需要你做什么 / 证据」（`human`），内部键与原始值只进 `facts`/结构化字段；`band=`、`autoCompress` 等不再出现在正文；throw 拒绝同样四段（code/facts 只进 `error.code`/`error.facts`）。依赖旧前缀（如 `relay_phase refused (code)`）的脚本请改看 `error.code`。
- **文档索引默认 A 层、目录成组**：L0 只单列「在役」（pin / 最新交接与阶段 brief / 进度 / 经验）与决策文档，其余按目录成组（份数 + 1–3 个代表 + `relay_doc list prefix=<目录>`）；raw/reports/archive 永不单列。2KB 仍是 advisory 护栏，超限按 A→B→C 降级。
- **角色裁剪**：human-loop 技能只在 relay Lead 的 agent scope 注册（非 relay 会话不再提供）；worker 裁掉 `relay_status`/`relay_doc`，teammate 裁掉 `relay_doc`；`ask_user_question` 只给 Lead。
- **npm 包**：`files` 新增 `scripts/`（`scripts/docs-metrics.mjs` 随包发布）。

### 风险分级与门禁矩阵（C2）

- 新增 `lib/risk.js`（纯函数判档）：文档级或 ≤20 行 → T0；触碰 lib 代码或 >20 行 → ≥T1；公开面、数据格式、权限、不可逆、外部动作或 >300 行 → T2；信号未知按 T2 保守处理。
- 门禁按档：设计门只 T2；ship 的 user_gate T0 免、T1 要 report + 一次 diff 审查、T2 全；`contract_check` 只 T2 强制；reopen 仅 T2 要求 `user_approved`；done-gate 对 T0 全部、T1 文档条目自动确认（`lead_confirm.auto`），显式 false 仍整表拒绝。
- 去重缓存：同 `reviewKey`（requirement+designPath+diffHash）空 review 复用、换 diffHash 必须重审；doc_lint 按 `docsHash` 10 分钟缓存并支持 T0 `cheapOnly`；派活 ack 用 `denyKey`（含 phase）。

### 设计回显与设计深度（P5）

- T2 设计门在结果与 text 回显 `ask_ref` 字数与 `not_doing` 条数；缺任一、超 300 字、空数组/超 10 条均零副作用拒绝。
- 设计深度模板进常驻协议与 SKILL：T0 一段（改什么 / 怎么验 + risk.reason）、T1 ≤1 页（改动面 / 做法 / 验收 / 回滚）、T2 七段 ≤3 页、提案 ≤5 条。
- doc_lint 新增 `design-depth` 软检查（仅会话文档、非 cheapOnly）：>3 页 / 提案 >5 / 缺回显 / 缺不做 → WARN，不阻断。

### 说人话（C1）

- 新增 `lib/output.js`：四段渲染、内部键黑名单（band/headroomTo/dispatchId/revision/code:/seq/autoCompress 等）、失败/到线/阶段/交接文案生成。
- 8 类 notice（到线/容量/边界/面板/自查/不可用/恢复/平面）统一四段；`fail()` 返回式报错 ≤300 字四段；回执协议明确「头 3 行是机器契约、不贴用户」。
- 新增黑名单单测锁定可见文案；面板 chip/popover/水缸/设置文案中文化，phase 显示「阶段交接摘要」等中文标题，内部键不再进可见文案与 title。

### 文档索引 v2（P1–P3）

- 选择：单列在役（pin / 最近 3 次交接 / 2 份 brief / progress / lessons）与决策文档（decisions，或 frontmatter constraints/contracts 且显式 role/when）；其余按目录成组；`relay_doc list prefix=<目录>` 展开。
- 层级：默认 A 层；2KB 只当护栏，超限 A→B→C（折叠/分组），每份文档仍 ≤2 次调用可达。
- 计量：index/read/search 写 `.scratch/context-relay/metrics/<session>.ndjson`（≤200 行，不存正文/query），`relay_status.docs` 出摘要；`scripts/docs-metrics.mjs` 提供周报骨架（`node scripts/docs-metrics.mjs --since 7d`）。

### 角色注入裁剪（D）

- 全局技能只保留 context-relay 与 doc-governance；human-loop 仅注册到 relay Lead 的 agent scope。
- 队友/worker 工具面按角色裁剪（worker 只余 doc_lint；teammate 裁掉 `relay_doc`）；`ask_user_question` 通过 agent-scope restrict 只给 Lead，失败降级为 warning + degradation，不阻断平面安装。
- 预算快照同步（worker 工具 schema 1,920→257；teammate 12,370→11,115）。

### AOCI 语义层（B / R）

- frontmatter 新增 `constraints` / `contracts`（单行、`;`/`；` 分隔、`none` 即 0）；L0 仅在计数 >0 时给 `!n` / `An` 标记，并把 `none` 从「带决策」判定中排除。
- L0 头部固定两行 legend/health（「读法：L1 先读 / L2 按需；! 约束 · A 契约 · → 关系」与「索引 x/2.00KB · L1 n / L2 n / raw n」）；超预算先丢 health、再折叠，legend 保留。
- frontmatter 新增 `relations`（`,`/`;` 分隔、≤8、可带 supersedes/implements/evidence_for 前缀）；L0 尾部 `→n`；`relay_doc related <path>` 返回出边+入边（一跳即停）；doc_lint 对不存在/越界/自环给 advisory WARN。
- 新文档（显式 frontmatter 的 architecture/decisions）缺 `constraints` → docs WARN；research/report 与无 frontmatter 的旧文档豁免。

### 兼容与回退

- 工具数与名称不变（15）；panel/roster/work-items/文档格式不变，无数据迁移。
- 旧 T2 `design_gate` 调用需补 `ask_ref`/`not_doing`；依赖旧 notice 文案或 `relay_phase refused (...)` 前缀的脚本改看 `human` 与 `error.code`。
- L0 默认视图从「尽量单列」变为「在役/决策单列 + 目录分组」，找历史文档用 `relay_doc list prefix=` 展开。

### 验证与未验证

- 验证：全量测试 **971/971** 通过（`node --test test/*.test.mjs`）、`npm run check` exit 0、`npm pack --dry-run` 产出 `dsh-context-relay-0.12.0.tgz` 且包含 `scripts/`。
- 未验证：真机重载后的面板渲染与 notice 文案、真实会话的 organize/handoff 注入链路、roles/ask_user 的宿主 catalog 效果；风险档只在进程内继承（重启后保守回退 T2）；周报阈值与默认层尚无真实样本；T0/T1 设计深度只做 advisory 模板，无硬校验。

## v0.11.1 (2026-11-19)

文档版：README「专职架构师」段（中英）各加一张架构师模型选择截图（`docs/images/architect-model-menu.png`，GitHub 绝对 URL，保证 npm 页面也能渲染）；开头 tagline 刷新并同步英文（补上「可独立配置模型/思考强度的架构师」与「token 预算无上限」一行提示）。

无行为/代码变更、无需迁移；工具数与协议不变（工具 15）。

## v0.11.0 (2026-11-17)

「主动管理 + 小队模型 + 受控返修」：在 v0.10.0 完整形态上新增主动上下文管理（新起点自查 + warn 可执行建议 + 四档语义）、固定小队（spawn 默认关、上限 8、reset 复用、批量清理/纳入）、ship 受控 reopen、容量保全线独立化（默认 55%）与宿主自动压缩兜底。工具数仍 15，无 roster/work-items/panel 数据格式破坏。

### 行为变更（升级前必读）

- **容量保全线 85% → 默认 55%**，改为独立配置 `settings.capacityThreshold`（20–95，不参与 band 派生、不与 `threshold` 合并）；调回 85 即接近旧行为。
- **spawn 默认关闭**（`allowSpawn=false`）：换人优先让目标 `relay_checkpoint` → `relay_freshen({reset:true,brief})` 全清复用；`relay_renew` 默认拒绝，仅换身份/角色且 `allowSpawn=true`。
- **固定小队上限 8**（`squadMax`，含架构师，可上调）：默认视图只到 squad；legacy/retired 只给计数，用 `include_legacy`/`include_retired` 查看，用 `manage` 纳入（adopt）或批量清理（retire scope=legacy/names）。
- **到线语义四档化**：起点（新 phase/新任务）主动管理 / warn=现在就该动手（压缩/清空复用/交接三选一，不再推荐继续）/ organize·relay=兜底告警 / capacity 55%=最坏兜底（不自动执行）；到线文案与协议同步。
- **ship 受控 reopen**：ship→build/verify 默认必须显式 `reopen{reason,user_approved:true}`（`reopenGate` strict；warn 放行+warning；off=v0.10 旧行为）；ship→discover 标 `newTask`；同 phase 重复 ship 只告警 `ship-already-delivered`。返修后二次 ship 仍重新过 user_gate/contract_check。
- **宿主自动压缩兜底**：host 归因时写 ≤2KB 最小恢复快照 + chain 条目 + 一次 recovery notice；`compactionFallback` 默认 on，off 只日志；unknown 只 `logWarn`，不写快照。

### 默认值表

| 项 | 默认 | 说明 |
|---|---|---|
| band | warn 30 / organize 35 / relay 45 | 由 `settings.threshold=35` 派生 |
| capacity | 55% | `settings.capacityThreshold`，独立配置 |
| allowSpawn / squadMax | false / 8 | 小队模型（含架构师） |
| contextCheck / reopenGate / compactionFallback | on / strict / on | 新机制，均可关闭 |

### P0（阻断核心链路）

- **P0-A 选人健康修复**：`band=unavailable` 与 unknown 同归 `unknown` 并排除自动选人；清爽度排序（fresh<watch、ok<warn）+ `rosterKnown`/名字 tie-break；候选 band 并发读取、上限 12 + `truncated`；返回 `selection{mode,score,considered,excluded,truncated}`，失败路径同样带排除原因。
- **P0-B 小队模型**：`squadMembersOf/legacyMembersOf/squadSummaryOf/adoptMembers` 单一判据；`relay_team_status` 默认只 squad + `manage{retire/adopt}`（legacy/names、keep、dry_run、retired.ndjson 归档）；spawn 关、cap、architect 计入 cap 且 fresh 豁免；dispatch/send_message/triage/快照只 squad。
- **P0-C ship 受控 reopen**：strict/warn/off 矩阵、零副作用拒绝、非 ship 误用拒绝、二次 ship 重新过双门、`deriveReopen→relay_status.reopen`、`newTask`、`ship-already-delivered`。
- **P0-D 主动上下文管理**：新 phase / 新任务（create_goal、task_board_run、ship 后首条用户消息）起点自查；四档文案；去重/冷却 ≥3 步/合并/投递成功才 claim/压缩不重放/off 静默。
- **P0-E 容量线独立化**：`capacityThreshold` 默认 55、[20,95]、非法抛错；`capacityRatioOf` 唯一换算入口；sentinel/relay_status/文案全部动态渲染，删除写死 85%。

### P1

- **P1-A 宿主自动压缩兜底**：四态归因（relay-organize / relay-freshen / host / unknown）；host 归因写 `recovery/compaction-<sessionId>.md`（六类指针、≤2KB）+ chain `kind=compaction`；一次 recovery notice；全链路 fail-open。

### 兼容与回退

- 回退映射：`capacityThreshold=85`、`allowSpawn=true` + 调大 `squadMax`、`contextCheck:off`、`reopenGate:off`、`compactionFallback:off` ≈ v0.10 行为（默认展示仍只到 squad）。
- 无数据迁移：roster / work-items / panel 格式不变；catalog 名字不能删除，退休后不再派活/展示，真清空团队用 `relay_handoff`。
- 工具数保持 15；逐项升级/回滚见 [docs/design/MIGRATION.md](docs/design/MIGRATION.md)。

### 验证与未验证

- 验证：全量测试 **935/935** 通过（`node --test test/*.test.mjs`）、`npm run check` exit 0、`npm pack --dry-run` 产出 `dsh-context-relay-0.11.0.tgz`（51 files）。
- 真机 V1–V8 未授权未跑：34 存量清理与可见性、spawn 关与 reset 复用、主动提醒、容量 55%、reopen 真实相位、宿主压缩归因、8 人上限、reset/wipe seam。
- 已知限制：容量线调低于 relay 时容量 notice 不带排序提示（仅 `relay_status` 文本提示）；窗口未知时容量不判定；reopen 计数冷启动（投影可用）可能先报 0；catalog 不删名。

## v0.10.0 (2026-11-16)

「完整形态」交付：以 2026-11-16 全面审计的 2 P0 / 5 P1 / 14 P2 为主线，完成结构性重塑（声明式 agent 平面 / 官方 seam 契约层 / 单一持久化 / 策略单源 / notice 规划投递分层 / 两段式用户门）与**兼容债一次删净**。基线 v0.8.1；v0.9.0 未单独发布，其批次 1–4 内容并入本版（历史段保留于下方）。

### 破坏性变更（升级前必读）

- **panel.json `schemaVersion` 2 → 3**：旧面板文件载入时**一次性失效**会话授权（`autoCompress` / `autoHandoff` / `authorizeNext`），模式与架构师设置保留；用户需重新开启自动授权（不可逆，回滚不恢复）。
- **兼容路径删除**（v0.9.0 迁移期结束）：classic `relay` 别名（旧 classic 会话不再挂 relay 平面，切一次 preset 即回填）、`routerMode`、`legacyPresetCompat`、legacy `config.thresholds`（阈值唯一来源 = `settings.threshold`）、面板 `compress-then-handoff`/`autoChoose`/`autoDecision`/`handoffPreset`、`relay_phase` 入参 `next_operation`（改用台账 `next`）、`PROTOCOL_TEXT_LONG` 派生文本。`lib/` 加 compat-grep 防回潮（退役标识出现即测试红）。
- **协议两段式用户门**：首次进 build 强制 `design_gate{path,user_approved:true}`（缺失零副作用拒绝）；`contract_check` 由「每次切 phase 必填」降为 **ship 必填**；ship 新增 `user_gate.verification{tier:minimal|heavy,approved_by_user?,items[]}`，`heavy` 无用户授权即拒；实现↔设计对齐改为与验收并行的新上下文独立审查。
- **preset 切换口径变更（M-02）**：旧文档「切换需新会话」失效——首轮前/会话中切到 Relay 均会由声明式 reconcile 自动回填 Lead 平面（`agent/created` + 启动回填 + `agent-preset/selected` + 每步惰性兜底），`relay_status.plane` 可自检。
- **notice 语义变更（C4）**：`[闭环]` 只认 write/edit/apply_patch（只读 bash 不再触发）；只读 `relay_work_items` 不再清 pending；notice 投递成功后才记去重键；正文统一脱敏、闭环 target 只取首行；队友 notice 不再带 Lead 台账行；官方压缩后去重状态复位。
- **台账语义收紧（C7）**：`relay_phase` 同 phase 传 `items` 显式拒绝（零副作用，补分点用 `relay_work_items` 或下次跨 phase 带）；`phase=null` 条目纳入 strict 关闸；`GET /context-relay/work-items` 纯只读（不再触发旧 workspace 台账惰性迁移写盘）；ship→blocked/cancel 后可恢复回 ship（其余仍只能 verify→ship）。
- **委派闸门 `strict` 启用（C14b）**：`delegationGate` 的 `strict` 档不再被静默归一为 `warn`——build→verify 命中（会话累计 Lead 执行占比 >20% 或 Lead 自做 build/verify 分点无 `lead-exec:` 证据）即 `relay_phase` 拒绝（零副作用）；默认仍 `warn` 只提醒、`off` 关闭；补 strict/warn 两端到端 + 装配日志测试（用户门/phase 语义不变）。
- **工具面与文档**：`relay_status` 新增 `plane`/`delegation` 事实；SKILL/README 中英、DESIGN、MIGRATION、ARCHITECTURE 全部对齐 v0.10.0（新增 tracked `docs/design/ARCHITECTURE.md`）。

### P0（阻断核心链路）

- **M-01 handoff 定时任务 seam 迁移 rc.2**：`schedule.list()` 分页对象（`.items`）、迁移用 `edit({action:'update',patch:{target}})` 保留投递史（不再 create/delete）、形状不符降级 N/A+warn 而不再 preflight 拒绝交接；补 rc.2 形状契约测试。
- **M-02 preset 切换/热重载后既有 root Lead 平面不安装**：新增 `lib/plane/roles.js`（角色→deny/sections/tools/seed 单一真源）+ `lib/plane/ensure.js`（幂等 reconcile / 状态 / 反向卸载），四入口回填；平面状态进 `relay_status.plane{role,installed,degradations}`。

### P1

- **M-03 闭环误报**：只认真正写文件的工具（write/edit/apply_patch）；只读 work_items 不清 pending；notice target 首行 + 凭据脱敏。
- **M-04 持久化绕过原子写/锁**：新增 `lib/storage.js`（异步退避锁、原子写、journal 恢复、凭据收紧），progress / work-items / team-context / panel / settings / chain / lessons / team 收敛；M-20 `Atomics.wait` 同步睡眠删除。
- **M-05 freshen/reset 结果静默**：成功/回退/失败都注入结果 notice；`relay_team_status` 汇总 reset 结果。
- **M-06 collect 回执新鲜度**：dispatchId 落盘 `.scratch/context-relay/dispatch/`，collect 校验回执头 `task==itemId` 与 `revision==dispatchId`；reload 丢内存可观测。
- **M-07 npm 发布闸门**：release/workflow_dispatch/push tag 三触发全路径校验 tag==version 并失败退出、已发布只 skip 时告警、加 concurrency；新增 `ci.yml`（固定 dsh@0.2.2-rc.2、缺包 skip 由 CI 对 reporter「skipped」汇总断言兜底——`DSH_SEAM_REQUIRED=1` 为语义开关，测试侧未消费；test+check+`npm pack --dry-run` 断言）。

### P2（含结构性改造）

- **M-08 凭据过滤误杀**：只匹配已知凭据前缀 + 高熵值，错误带命中字段，不再误拒正常文本。
- **M-09 注入预算扩容**：15 工具逐条 desc/params + 4 角色（lead/teammate/architect/worker）**装配实测**快照断言，防注入面回涨。
- **M-10 台账静默丢失/闸门绕过**：见上方「台账语义收紧」。
- **M-11 注入去重生命周期**：notice 拆为规划（纯函数 `planNotices`）+ 投递（`deliverPlan`）；投递成功后才 claim；边界 notice 两段式确认落盘；压缩后复位。
- **M-12 队友 notice 教用被裁工具**：队友稿删除 Lead 台账行（工具面也没有 `relay_work_items`）。
- **M-13 面板 dirty 丢失**：正常载入时保留未落盘 dirty 记录并合并重试写。
- **M-14 指标缺失**：`bandFor` 显式返回 `unavailable` + 一次性保守提示，不静默当 ok。
- **M-15 CI 保真**：9 个官方 seam 契约测试 + 固定内核 CI；缺包 skip 由 CI 对 reporter「skipped」汇总断言兜底（`DSH_SEAM_REQUIRED=1` 为语义开关，测试侧未消费）。
- **M-16 文档真源**：README/README.en/SKILL/DESIGN/MIGRATION/CHANGELOG 与 v0.10.0 对齐；关键架构入 tracked `docs/design/ARCHITECTURE.md`；SKILL 删除 rc.2 不存在的 `spawn_teammate` 等旧引用；统一 preset 切换口径。
- **M-17 架构重复**：policy 单源（`resolveEffectiveThresholds` / `panelDefaultsOf` / 操作标签/常量下沉），host/agent/client 只消费；client 常量契约测试。
- **M-18 兼容债删除**：见上方「破坏性变更」。
- **M-19 PTC 通道披露**：README/README.en 的「安全边界与代价」「已知限制」补「`run_code` 内层是执行软约束，插件不做通道守卫，不承诺硬隔离」。
- **M-21 notice 持久化片段**：notice target 首行 + 凭据脱敏后才进入会话历史/UI。
- **C 子域**：handoff seam 契约测试、collect task/revision 校验、reset 结果可见、`relay_team_status` 签名补 deeper（孙代理数）、client 双 4s 轮询合并为单轮询器并行 2 GET、client 常量契约；work-items GET 只读。
- **D 子域**：策略单源/去重、9 seam 覆盖、CI 发布硬化、层级与依赖清理；只支持 DSH 0.2.2-rc.2。

- **预算开关团队继承**：Lead 的「预算无上限」值在 spawn 队友 / 架构师 / dispatch worker 时继承（spawn 前登记、`agent/created` 写子会话面板并 force 落库，隔离成子会话后不再随全局默认翻转）；已存在的队友在下次 `relay_freshen` 复用同会话时同步到 Lead 当前值（架构师 `relay_architect` continue 复用同样同步）；`relay_handoff` 的 `handoffUnlimitedBudget` 语义不变。
- **台账完成确认门（v0.10.x）**：条目从非 done 变 done 前必须由 Lead 完成确认 `lead_confirm={no_drift,no_missing,no_regression}` 三项均 true（先复核 diff / 需求 / 测试：无偏移、无缺失、无回退）。`relay_work_items` 整表写入缺失/不完整 → `done-gate` 整表拒绝（零副作用，台账/归档不变）；门在**超限预归档之前**执行——将被归档的新 done 条目同样必须带确认，不能以归档绕过，拒绝时归档文件也不变；已 done 条目不受门约束（未显式提供确认时保留盘上既有确认），但**显式传不完整/含 false 的确认同样拒绝**（不得降级/覆盖既有确认）。`relay_collect` 收口 verdict=done 回执 → 缺失/不完整返回 `confirmation-required`（条目不置 done、台账不变），三项 true 才置 done 并把 `lead_confirm` 写入条目。
- **notice 可执行性（2026-11-16 用户反馈，接 M-03）**：`[闭环]` 只在台账存在未闭合分点（open/doing/blocked）时提示——无台账文件或未闭合分点为 0 时都不提示（无处落账；pre-step 同时清掉待落账标记，防止之后建账重提陈年改动）；`phase=ship` 且当前 phase 分点全 done 时焦点行「分点全闭环 → 可以关 phase（relay_phase）」不再出现（含 `[台账·ship N/N]` 计数行消失，`relay_status.workItems.focus` 同步为空）。

### 工具面与命令现状

- 共 15 个工具：7 常驻（`relay_status` / `relay_phase` / `relay_organize` / `relay_handoff` / `relay_work_items` / `relay_recommend` / `relay_doc`）+ `doc_lint` + Lead 专属 5（`relay_team_status` / `relay_renew` / `relay_architect` / `relay_dispatch` / `relay_collect`）+ 队友/架构师 2（`relay_checkpoint` / `relay_freshen`）。
- `npm run check` 补上漏列的 `lib/agent/reset.js`、`lib/lessons.js`；npm 发布包 `files` 增补 `docs/`（README 相对链接可解析）。

### 验证与未验证

- `npm run check` exit 0；受影响面集成回归 746/746（本地；本轮改动/新增的 40 个测试文件）；全量矩阵与真机验证留发布门（需用户授权，未跑）；目标模块测试 + 单次独立 diff 审查为本次最小验收口径。
- 未验证（发布门待办）：M-02 的 preset 切换/插件热重载**真机**路径、M-01 真机小额度 handoff、M-11 依赖宿主自动压缩的压缩复位、M-20 并发锁真机效果——均按两段式门与重型验证授权表在用户授权后执行。

## v0.9.0（历史快照，未发布，内容并入 v0.10.0）

> v0.9.0 未单独发布，批次 1–4 的行为已随 v0.10.0 交付；本节保留当时的验收口径与未验证项供追溯，其中「v0.10.0 将删除」的兼容项现已全部执行。

批次4（注入削减 B 档：P1 高频注入去重 / P2 relay_phase 结果摘要化 / P3 协议文本去重）：

- **P1 注入去重**（只更少、不改注入行文本）：台账焦点行只在**焦点文本变化**时注入（rev/证据变化不算）；`[上下文]` 只在档位/边界动作变化时出现（到线 notice 已带的不重复）；`[闭环]` 同一未落账签名只提示一次；`[队友]` 只在新队友或档位上升时出现。同一 step 最多一条 notice（到线/边界优先），**重启后首次汇总一次**。派活判断点按（target, band, status）**首次/变化才打断**（同状态后续派活直接放行；退役代恒拦），phase 边界 team_note/warning 兜底不变。去重状态只放内存 Map，不新增 IO/定时器/持久化/配置键。
- **P2 `relay_phase` 结果摘要化**：成功结果新增人类可读 `text`（`output.render` 改为返回 text，与 `relay_status` 同模式），按 `phase:/budget:/ledger:/team:/user_gate:/warnings:/delegation:/lessons:/next:/hint:/summary:` 固定前缀行呈现；结构化字段保留（PTC/测试可继续读）；删除入参回显 `goal`/`exit_criteria`（外部脚本若读这两个字段会得到 undefined，值仍可从入参与台账取）。`user_gate` 仍不落 review/report 原文；错误/拒绝/校验顺序与零副作用不变。
- **P3 常驻协议去重**：同一条纪律只保留一处真源（PROTOCOL base）；ROUTER 只留执行摘要 + 指针（§Phase 状态机 / §队友保鲜），TEAM_LEAD 删与 base 重复的小队/不轮询两段，WORK_LEDGER 承载 P1 行为句并把 lead-exec/build-verify 改指针；LONG 派生删掉重复的三档插入句（classic-only 句仍保留在派生源）。root Lead 常驻注入 12,572→11,324 字符（−1,248，−9.9%）；验收用户门/P0/最小注意力最大影响/批量一次问清/授权真源等**合同条款一字不删**；预算按实测+50 重新定格（TEXT ≤6,560 / LONG ≤6,460 / ROUTER ≤2,000 / TEAM_LEAD ≤670 / LEDGER ≤1,690 / 合计 ≤11,360 且 ≥11,000）。
- 文档同步：SKILL 的台账闭环/上下文/判断点改 P1 语义并补 P2 呈现、P3 去重说明；README 中英同步；未验证项留真机抽样——P1 注入量（目标 ≤110 条/≤26,000 字符/重复率 ≤15%）、P2 真机体积（build ≤600 / ship ≤900 字符）与 PTC 是否读 render 文本、P3 新文本可读性独立审查。

批次3（delegation-first：Lead 只做用户交互/决策/派活/验收抽样）：

- `relay_status` 新增 `delegation` 度量块（execRatio / calls / dispatchCount / collectCount / idleWorkers / advice / basis）：会话累计执行占比目标 ≤20%（warn 档只提醒，strict 留给 v0.10.0），样本 <10 次工具调用仅参考；指标来源为官方 relay 投影（成功 dispatch/collect 计数）。
- 新增 Lead-only 工具 `relay_dispatch` / `relay_collect`：dispatch 取台账分点 → 复用/新建 worker → 标准 5 字段 brief（目标 / 必读 1–3 / 写范围 / 验收 / 回执路径+verdict）→ 台账写 doing+owner+next；collect 短等 ≤120s → 只读回执头 3 行 + digest（≤600 字）→ 台账 done（evidence=reportPath）/blocked，**只回 digest**；完整报告留在报告文件。
- 台账语义收紧（不改 schema）：build/verify 分点 owner 应为 worker；Lead 自做必须在 done 的 evidence 记 `lead-exec:<原因>`；不改台账字段、无需迁移旧台账。
- build→verify 委派闸门默认 `warn`（新 config 键 `delegationGate`；`off` 可关；`strict` 在 v0.9.0 归一为 warn、v0.10.0 启用）：会话累计执行占比 >20%（样本 ≥10 次调用）或 Lead 自做分点无 lead-exec 证据时只提醒、不阻断切换。
- 纪律文案统一：四份常驻协议 + SKILL + human-loop + README 中英统一「Lead 只做用户交互/决策/派活/验收抽样、不亲自执行、无小任务自干例外」；ship 汇报带一行委派统计（advisory，不机械校验 report 文本）。
- 协议瘦身：ROUTER 的 PTC 手写 dispatch/collect 代码模板替换为 `relay_dispatch` / `relay_collect` 工具纪律；不做 PTC run_code 通道守卫/关键词扫描（用户裁决；node:fs 直写如实标注为已知软约束）。
- 未验证项：PTC 内层工具结果文本作为投影成功 marker、spawn 后立即派发的时序、warn 在真实长任务中的触发频率、多 worker 并发写同一报告路径——真机抽样后再校准（不改 warn 语义）。

批次2（历史快照，最终语义以上方批次4为准）：

- v0.9.0 起为唯一模式「接力模式（Relay）· 超长任务」（id relay-long）；classic relay 仅迁移期同行为别名，v0.10.0 删除兼容。表盘仅问我/继续/压缩继续/接力新会话，删除下个会话模式开关。
- 用户汇报四段式（结论/影响/需要你做什么/证据位置），默认≤600字；details_requested 明确展开建议≤4000字。只提醒不拒绝，warning随phase结果+一次性notice，绝不阻断ship/phase；review/report非空硬门保持。不贴命令输出/日志/长diff，术语首次出现人话解释。
- 模式与授权不跨会话继承；授权绑定会话+操作+版本，接力/版本变更即失效，旧panel schema迁移清授权。新会话默认压缩继续；仅继承非授权架构师设置。
- 台账只记Lead管理动作、引用officialTaskId，执行状态/依赖/验收以官方任务板为准；默认30项，超限先归档done（同目录archive.ndjson、path/count可查），无done可归档才拒绝，归档失败不写台账。
- 小队默认4人，按需扩到部署maxActiveSubagents，满额排队/报阻塞；派活brief强制目标/必读1–3份/写范围/验收/回执五字段。
- 新增blocked/cancel出口（exit_reason必填），不删历史/不替代用户门；恢复从退出前phase继续，verify→build可返修，ship只能从verify进。审查超时或未完成不算通过，可续审/换人。
- ≥85%容量保全notice为中途收尾例外，预算档本身不构成例外；不自动压缩/交接，仍遵守模式与授权。
- 旧cth→null、autoChoose/autoDecision→false/null，handoffPreset接受但忽略；v0.10.0移除兼容路径。卸载保留用户panel/settings及工作区记录，不自动删除。

批次1（历史快照，下述“本批”仅指批次1，最终语义以上方批次4为准）：

- #56 **行为变更**：架构师模型默认跟随「模型」选择器的默认选择；本会话显式选择保持不变，菜单可随时覆盖或恢复默认；未显式选择不拒绝、不阻塞，显式覆盖仍受官方子代理白名单约束；handoff 继承选择。
- #63/#64 口径：超长任务 root Lead 只做用户交互、决策、派活、验收抽样，不亲自执行、不设自做额度；classic 协议与双模式装配本批不变。
- #52 **行为变更**：长模式新 root 会话默认档改为压缩继续（已实现）；显式模式（含 null=问我）、自动档、非 root 与 classic 不覆盖；接力新会话仍沿用旧会话档，存量快照不迁移。

## v0.8.1 (2026-11-15)

审计 B 类缺陷修复批次（本机提交，未发版）：

- handoff：交接接管确认与分阶段可恢复清理——新会话确认接管后才逐步停旧活，任一步失败保留旧会话可续，不静默遗留孤儿会话。
- 安全写盘：原子写 + 跨进程锁（临时文件、fsync、redo/CAS），拒存路径越界/符号链接/凭据；修复 lstat→realpath 竞态导致的越界写风险。
- 记忆保真：chain 超界旋转保留完整指针；lessons 淘汰条目改为原文归档（不丢内容）。
- 文档系统：扫描容错、大文件无损分页读取（新增 `relay_doc read` 的 `byteOffset`）、坏指针全量诊断；清理文档漂移（路径/索引与实现不一致）。
- 版本 0.8.1；本机全量 587 项测试与 `npm run check` 通过（未做真实宿主 E2E）。

## v0.8.0 (2026-11-15)

文档系统 v2：从「固定字节上限 + 超限拒绝/截断/丢数据」改为「索引 + 分层 + 按需取用」（对齐官方 DSH 指令文件 / 技能目录模式）。用户裁定：caps = 只留建议不强制；链式记忆与高价值文档分层保留。

- 新增 `relay_doc` 工具：`index`（L0 索引，自动生成不落盘）/ `list` / `read`（按标题、行区间精读，有界）/ `search`（只回 path:line + 摘要）/ `lint`（advisory 体检）。团队先读索引，再取 1–3 份最小上下文。
- 新增 `lib/docs.js`：会话文档扫描与分层（L1 摘要 / L2 详情 / raw 原始）、frontmatter（title/role/layer/when/owner/updated）、索引渲染与 digest、坏指针检测。
- handoff：不再因超长拒绝——注入有界摘要（默认 ≤16KB），完整交接单（全部证据/决策/未决/清理清单/台账段）完整落盘并在首条消息给路径；删除 `handoff-truncated` 拒绝路径。摘要与列表条数只做 advisory。
- progress：advisory 阈值 8KB→32KB；被裁剪/移除的条目（含状态段）完整原文进 `progress-archive-<年>.md`，主文件只留摘要与归档指针（无数据丢失）。
- lessons：超 40 条/8KB 不再淘汰，移入 `lessons-archive.ndjson`；注入仍 ≤1KB 摘要。
- chain：超 100 条/32KB 不再丢最旧，旋转到 `chain-archive-<年>.ndjson`；新增 `readChainArchive`。
- team：checkpoint 全量落盘（prompt 用有界渲染 + 指针）；ledger 超界旋转 `ledger-archive-<年>.ndjson`；renew prompt 不再硬截断内容。
- doc_lint：L0/L1 配额由 hard FAIL 降为 advisory WARN（banned 仍 FAIL）；新增 relay 会话文档检查（frontmatter / 坏指针 / 超大 / L1 超阈值）。
- 协议：新增 docs v2 分层/索引/advisory 段（PROTOCOL 约 +280 字符），交接 cap 文案改为「摘要 + 完整文件」语义；worker 回执 4KB 标注 advisory。
- 测试：新增 `test/docs.test.mjs`；handoff/progress/lessons/chain/team/work-items 相关「拒绝/截断/丢最旧」断言改为「不拒绝 / 落盘 + 指针 / 归档不丢」。
- 版本 0.8.0。

## v0.7.0 (2026-11-15)

按 2026-11-15 设计目标收敛 relay 边界。**只支持 DSH 0.2.2-rc.2+**（用户裁决：只保 rc.2）：

- 兼容：rc.2 队友 = Lead 的 depth=1 continuable 子智能体；成员列表/状态按官方 list_agents 口径（只列直接 continuable，status 读 agent.status），孙代理/one-shot/退休代不再算「队友」；退休代只审计，不派活/不发消息。
- 兼容：直接队友使用紧凑队友协议（约 2KB，替代 10.9KB 全量协议）；classic 队友保留全量协议，避免引用未注册工具；架构师使用独立 ARCHITECT_WORKER 影子协议，不再与 TEAMMATE 叠加。
- 变更：只支持 DSH 0.2.2-rc.2+——删除 rc.1 preset 行表/版本探测、`agentTeams` 旧适配分支、composer 原生下拉回退；`engines.dsh` 下限改为 `>=0.2.2-rc.2`。
- 变更：TEAM_WORKER 段并入紧凑队友协议（唯一内容补齐后删除独立段，少约 0.9KB/请求）；固定小队/复用优先写死，team_note 统一为 warning（不拒绝切 phase）。
- 新增：relay_architect（Lead-only）——按会话面板选择的模型创建/继续架构师；fresh 默认干净上下文、旧代先 checkpoint 再退役；未选择模型时拒绝并提示先问用户一次，不静默继承 Lead 模型。
- 新增：**架构师模型 / 推理等级复用 DSH 模型菜单**——挂在 composer 模型菜单「模型 / 推理等级」之后（官方 `conversation.input.model.options` 槽；与 agent-team 团队开关同一扩展点），菜单外壳、定位、键盘与失焦行为全部归官方（选完保持展开以继续调推理等级），不再自造下拉、不再兼容没有该槽的旧内核。数据源 `GET /context-relay/architect-models?sessionId=`（客户端按会话缓存 60s，失败下次菜单打开重试）；模型选择随 handoff 继承。
- 变更：**架构师模型严格按官方子代理白名单过滤**——读取会话 `subagentModelSelectionPolicy` 投影，只列允许路由；没有投影记录的旧会话按官方语义只允许 Lead 当前路由；`relay_architect` 在 spawn 前双重校验，白名单外的模型直接拒绝（不绕过官方 `assertAllowedModelSelection`）。
- 变更：工作台账回归 Leader-only（队友/子代理不读写、不在其 UI 展示）；删除队友写台账/owner 换代迁移；完整台账面板保留（用户裁决 C）。
- 删除：relay_rehydrate（handoff 已重建团队）、releaseOnCompress/releaseRetiredGeneration 与 release.js 的「托管释放」承诺；内部仅保留 activation 句柄用于换代容量。
- 删除：handoff 发布箱与 dock 提示（GET /context-relay/api / handoff-store）；新会话由官方会话列表呈现。
- 变更：关 phase 默认 warn（可配 strict/off）；team_note 队友上下文提醒降为 warning，不再拒绝切 phase；contract_check 每次切 phase 记录 warning，**ship 前必填**。
- 修复：rc.2 创建瞬间身份识别——`agent/created` 早于 subagents 的 resident 登记（manager 在 create 返回后才 resident.set），此时 `rootOf/namesOf` 必抛 UNAUTHORIZED，旧实现把每个直接队友都判成「身份未知」→ 紧凑队友协议、架构师独立协议、checkpoint/freshen 工具实际全部装不上。现在创建瞬间只读 header 事实（depth 1 = 直接队友、depth ≥2 = 普通子代理），架构师用 `relay_architect` spawn 前登记的 pending 标记认领（roster 的 sessionId 兜底 resume/重启）。
- 修复：`relay_organize` 压缩 brief 漏传 session → 默认配置下读旧 workspace 级台账，会话级「未闭合工作项」段永远为空（还可能串入别的会话）；现在按根会话 scope 读，旧 workspace 文件不参与。
- 变更：`relay_work_items` 加入非 root 裁面（v0.7.0 已把它改成 Leader-only；此前每个子代理仍白背约 1.6KB 工具 schema）。
- 改进：架构师模型目录去掉 provider 8 / model 20 的静默截断，且只对白名单命中的模型解析推理档（并行）；客户端只缓存成功且服务可用的结果，llm 瞬时不可用不会锁死 60s。
- 改进：composer 面板状态轮询合并——RelayPanel / 预算胶囊 / 架构师胶囊原本各自每 4s 打一次 `/context-relay/panel`，现在每会话只有一条共享轮询，订阅者共用同一份快照（写入优先仍由各组件自己的时间戳守卫）。
- 删除：rehydrate 死数据层（`read*FromRoot` / `listPartitions` / `planRehydrate` / `buildRehydratePrompt` 及对应测试）——v0.7.0 已删 `relay_rehydrate` 工具。
- 修复：rc.2 名字校验对齐官方规则（1–32 字符、字母开头）；`relay_renew` 在中断旧代之前先校验派生名，长 lineage 不会拆完旧代才失败。
- 测试：补齐 handoff 的 `architectModel` 继承断言、rc.2 创建瞬间架构师识别（pending/roster）、白名单路由过滤与 `relay_architect` 拒绝路径。
- 修复：send_message({agent}) 派活闸门参数、退役代发送拒绝、旧 activation dispose 后 renew 重试、普通 fork 不再被误判为子代理。
- 版本 0.7.0；全量 535 项测试通过，npm run check 通过。
## v0.6.5 (2026-11-15)

兼容 DSH 0.2.2-rc.1（当前内核）与 0.2.2-rc.2（升级目标）：

- 新增：团队能力适配层 `lib/team-api.js`——能力探测（`agentTeams.tryMembership` → rc.1 路径；否则 `subagents.rootOf/namesOf` → rc.2 路径），业务代码统一走 `roleOf/listMembers/sendToMember/interruptMember/startMember`，不再直接访问 `agentTeams`。
- 兼容：rc.2 的 `@deepseek-ai/dsh-agent-team` 只剩共享任务板（无 tryMembership/listMembers/spawnTeammate/sendMessage/interrupt），队友改由 subagent 树表达——角色按根/后代判定，成员用 `listDescendants` 映射，消息用 `sendMessage(sender,targetId,content,options)`，中断用 `interrupt(targetId,{kind:'ancestor',agent})`，换代/rehydrate 用 `startActivation({provider:'spawn-in-process'|'spawn',delivery:'parent'})`。
- 降级（显式、不抛、不断主流程）：rc.2 没有逐 id 释放（`drainChildren`）的等价能力 → 资源释放返回 unsupported 并跳过（交接仍走 `drainDescendants`）；rc.2 没有同步成员目录 → 「已有团队时开子代理需确认」软闸门不适用（rc.2 队友本身即 subagent，无法区分），闸门放行；列表/发送/新建失败一律返回 `{ok:false, code, reason}`，工具以结构化错误说明原因，rc.1 行为不变。
- 兼容：preset 官方行数据按内核版本自适应（两套数据 + 选择逻辑，版本从 `@deepseek-ai/dsh/package.json` 读取）——rc.1 使用 0.2.2-rc.1 的官方行（`tool-executor-ptc`、无 `tool-presentation`/`tool-subagent-list-agents`），rc.2 额外使用 `tool-office` 与 `tool-subagent-control.config.interrupt=false`；旧内核不再出现无法解析的行。
- 版本：0.6.5；新增 `test/team-api.test.mjs`（9 条适配层/版本选择用例），全量 554 通过。

## v0.6.4 (2026-11-15)

新增「专职架构师」固定队友（用户需求）：

- 新增：**固定队友 architect（专职架构师）**——Lead 负责与用户对齐需求、读项目文档理解业务；工程实现路线交给架构师：它每次任务以**低上下文**开始（只读必需的 brief/文档指针/模块入口），交付工程实现文档（默认 `.scratch/context-relay/architecture/<task>.md`：需求对齐/技术路线/模块接口/数据协议/风险取舍/待决策/实现步骤与验收），交付后**只 `relay_checkpoint` 归档并等下一任务**——清空发生在新任务到达时：Lead 按需要决定是否 `relay_freshen({reset:true, brief:新任务})` 再派（任务连续且上下文还低就直接接着做）；架构师不自行清空。需要用户拍板的「待决策」由架构师报 Lead，Lead 与用户敲定后再回传。
- 新增：**Lead 的「专职架构师」协议段**（仅 relay-long）：确保 architect 只在队里建一次、派活前先读它上下文（按派活流程）、按文档派实现、实现偏离文档要回问架构师而不是自行改路线。
- 新增：**composer「架构师」小胶囊**——在「预算无上限」胶囊旁边，按会话控制 Lead 是否把工程路线设计交给 architect（默认开；settings `architect` 默认值 + 面板三值 + 接力继承；只在 relay-long 会话显示）。
- 新增：**架构师队友协议段**（身份 = agentTeams 成员名 `architect`，仅 relay-long）：低上下文开始、只写架构/实现文档不改产品代码、待决策报 Lead、交付后 checkpoint+freshen。
- 测试：协议资产预算/短语、agent 段按开关与身份注入、composer 胶囊渲染与 PUT、面板/设置三值归一与接力继承；全量 545 通过。

## v0.6.3 (2026-11-13)

Lead 的上下文管理与队友上下文管理不再靠「记」，改为事件驱动地摆在眼前：

- 新增：**每次派活前先读状态，由 Lead 判断要不要管理队友上下文**（用户口径；派活和管理都是 Lead 的动作）——Lead 用 `send_message` 给队友派活时，插件用 `tools/pre-execute` 先读该队友的上下文档位/状态并**先给一个判断点**（deny：该条消息不发出）：**空闲队友每次派活都给**（到线/读不到 → 先管理再派或直接派；在线内 → 判断直接派还是先 checkpoint，原样重发即放行 = Lead 的判断）；**忙队友（running）只在到线/读不到时才给**，普通协调消息不拦。到线/读不到时把状态记进团队上下文快照，phase 边界的 `team_note` 闸门是**兜底**。不改 Agent Teams 工具（只读状态 + 拦截判断点）。
- 新增：**团队上下文快照**——队友到线（escalation）/Lead 体检（`relay_team_status`）/phase 边界 triage 的结果落盘到 `.scratch/context-relay/team-context/<leadSessionId>.json`（含每个队友的档位与「已处理」标记），压缩、重启后仍在。
- 新增：**台账焦点行带上下文状态**——同一次注入多两行：`[上下文] band=…（到线时给边界动作：继续=直接切 / 压缩继续=先 relay_organize / 接力=先 relay_handoff / 未设=先问人类）` 与 `[队友] 队友待处理 N：a(organize)…`；**只在焦点/rev、队友待处理变化时注入**（不按时间、不每步重复；重启不补催）。
- 新增：**phase 边界队友上下文闸门（兜底）**——跨 phase 时若有队友到线/读不到且尚未处理，必须用 `relay_phase({team_note:"<一行处理结论>"})` 显式处理，否则拒绝（零副作用）；处理后该队友在快照里标为已处理，焦点行不再重复催。派活时评估过、但被忽略的，仍会在这里被挡住。
- 改进：`relay_team_status` 报告新增 `pending`（到线/读不到的队友）与处理提示，成功查询同时刷新快照；队友 `relay_freshen`（含 reset）成功、`relay_renew` 换代后清掉自己/旧代在快照里的待处理行。
- 协议/文档：工作台账段写明「派活时评估队友上下文」、焦点行带 `[上下文]`/`[队友]` 与 `team_note` 兜底闸门；README 中英同步。
- 测试：新增团队上下文快照单测、派活评估（到线/在线内/非队友/去重）、焦点行上下文注入（含去重/重启不补催）、team_status 快照与 pending、team_note 闸门与读不到服务时的快照兜底；全量 540 通过。

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

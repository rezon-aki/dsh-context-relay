# dsh-context-relay

> 让 Lead agent 在长任务里长期停在高效上下文区间。

[English](README.en.md) · [npm](https://www.npmjs.com/package/dsh-context-relay) · [变更记录](CHANGELOG.md) · MIT

**DSH 上下文接力插件**：给 DeepSeek Harness 增加两个可选 agent 模式——**Relay** 与 **Relay · 超长任务**——用 phase 协议、预算哨兵、受控压缩和有界接力（handoff）管理长会话。超长任务模式另带队友保鲜（checkpoint / 真清空 / 换身份 / 跨会话重建）。

## 它解决什么

Lead agent 的上下文一旦变长，就会开始偏离实现、重复劳动、过度实现。DSH 自带的自动压缩接近窗口上限才触发、摘要式、且打断前缀缓存，往往不能把注意力真正拉回高效区。

本插件不替换内核压缩引擎，也不删除历史，而是把「何时压缩、何时接力、怎么交接」变成一套可审计的协议：

| 能力 | 一句话 |
|---|---|
| **phase 状态机** | discover → decide → build → verify → ship，按阶段组织长任务 |
| **预算哨兵** | 上下文接近阈值时提醒；处理点放在 phase 边界，不打断当前工作 |
| **受控压缩** | `relay_organize` 写结构化 brief 后调用官方压缩引擎，保留工作记忆 |
| **有界接力** | `relay_handoff` 生成 ≤8KB 交接单并创建新会话，旧会话保留审计 |
| **模型推荐** | `relay_recommend` 把推荐写给面板高亮；只展示，不自动执行 |
| **队友保鲜** | 仅超长任务：checkpoint / reset 真清空 / renew 换身份 / rehydrate 重建 |

## 安装

要求：DSH `>=0.2.1-rc.2`、Node.js `>=20`。

### 方式 A（推荐）：DSH Web UI 侧栏「插件」安装

全程在 Web UI 里完成，不需要命令行：

1. 打开 DSH Web UI，点左侧栏的 **「插件」**。
2. 点右上角 **「添加插件」**。旁边的箭头是「选择添加插件方式」菜单，其中「安装第三方插件」进入同一个对话框。
3. 在安装对话框的 **「插件包名」** 里填 `dsh-context-relay`；需要固定版本时在包名后加 `@版本号`。对话框也接受 Git 地址、压缩包或本地绝对路径。
4. **「安装源」** 保持默认即可：首次使用会自动在 npm 官方源与中国大陆镜像源之间探测，选先响应的那个；也可以手动选 npm 官方源 / 中国大陆镜像源 / 自定义 http(s) 地址。
5. 点 **「安装」**。Host 先读取这个包并在对话框里显示包名、简介与版本，pnpm 的命令和输出收在 **「查看安装详情」** 里。
6. 安装完成后点 **「立即启用」**；如果关掉了对话框，到「插件」页的「已安装插件」里打开 `dsh-context-relay` 组合包的开关。
7. 按页面提示 **重启/重载对应 profile**（启用 HMR 的 profile 会自动重组；否则重启 `dsh web`），然后 **刷新页面**。
8. 新建会话：模式选择器里应出现 **Relay** 与 **Relay · 超长任务**；选中任一模式后，输入框上方应出现**接力 chip**——两者都出现即安装成功。
9. （可选）「插件」页里 `dsh-context-relay` 的配置卡片可调阈值基准与面板默认值。

**排障**

- 装完看不到模式 → 确认组合包已启用、profile 已重载、页面已刷新；**安装成功不等于模块已激活**。
- 看不到接力 chip → 只有 relay 会话会渲染 chip；重载前创建的旧会话使用旧 agent 平面，新建会话即可。
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

安装后同样需要重启/重载 profile、刷新页面，再新建 relay 会话。

## 装完是什么样

- 模式选择器出现 **Relay**（默认，工具面不裁）与 **Relay · 超长任务**（root Lead 只调度不执行：工具面隐藏 `bash/pwsh/write/edit`，软约束而非安全边界）。
- 输入框上方出现**接力 chip**（仅 relay 会话渲染）：实时上下文占用、band、当前模式；点开是面板。
- 面板包含：**模式**表盘（经典 6 档 / 超长任务 4 档：问我 + 继续 / 压缩继续 / 接力新会话）——模式在本会话内**持久**（不消费，到线时按它执行；接力后由新会话继承）；另含三个自动授权开关（压缩 / 交接 / 授权下一次）、预算无上限开关、模型推荐行，以及「下一个新会话使用哪个 preset」滑动开关。
- **模式与审批相互独立**：模式只决定到线时做什么；压缩/接力的免审只来自持久自动授权（`autoCompress` / `autoHandoff`）或一次性的「授权下一次」（`authorizeNext`）。
- **「预算无上限」胶囊**：按会话注入一句 `你的 token 预算无上限。`（只改提示词，不改内核配额）。
- 到线时收到插件 notice（非用户消息）：只报状态与 phase 优先指引，不打断当前 phase。

## 快速开始

1. `relay_status`：看当前 phase、上下文占用、band 与预算 headroom。
2. `relay_phase({phase:"discover", goal, exit_criteria, contract_check})` 开始；每次切 phase 都带 `contract_check`（需求已定 / 实现忠实 / 是否值得占用人类注意力）。
3. 工作期间不为预算打断 phase；预算只是 **phase 边界闸门**。
4. 到线（organize / relay band）后，在 phase 边界按面板模式/人类决定处理：
   - **继续**：不压缩、不接力；
   - **压缩继续**：`relay_organize` 做一次受控压缩——每会话默认最多一次；人类在面板把模式选为『压缩继续』时按人类选择执行第二次（仍过审批），无面板模式时第二次压缩需人类明确要求（`force`）；
   - **接力新会话**：`relay_handoff` 写交接单并创建新会话，旧会话树中的队友/后台任务会被中断或迁移；
   - **压缩→新会话**（两段式，仅经典 Relay）：第一次到线只压缩，第二次到线才接力。
5. 交付前进入 `ship`：需要新上下文独立审查（`user_gate.review`）+ 大白话汇报（`user_gate.report`）。

## 配置

宿主插件 config（可选）：

| 键 | 默认 | 说明 |
|---|---|---|
| `threshold` / `settings.threshold` | 35 | 阈值基准（%）：warn = 基准−5，organize = 基准，relay 硬线 = 基准+10。 |
| `settings` | 六字段默认值 | 侧栏卡片初始默认值；人类保存的 `settings.json` 优先。 |
| `thresholds` | 0.35 / 0.40 / 0.50 | legacy 阈值，仅当没有 settings 来源时生效。 |
| `panelPath` / `settingsPath` | `~/.dsh/data/dsh-context-relay/…` | 面板/设置持久化路径覆盖。 |
| `injectBrief` | `true` | 压缩成功后是否把 brief 注入下一 step。 |
| `handoffApproval` | `'required'` | 压缩/接力官方审批硬门；无审批 UI 的部署可设 `'off'`（风险由部署方承担）。 |
| `inheritOnHandoff` | `true` | 接力继承旧会话模型路由与权限档；`false` 回部署默认。 |
| `releaseOnCompress` | `true` | 长模式压缩成功后，best-effort 释放当前 Lead 名下已 settled 子会话与已退休队友代。 |
| `releaseRetiredGeneration` | `true` | `relay_renew` 换代后 best-effort 释放旧代队友 session。 |
| `teamFirstSubagents` | `'ask'` | 团队优先契约硬门：已有团队时 Lead 开 `subagent` 需人类确认；`'off'` 只保留协议文本（依赖官方审批；`handoffApproval='off'` 时不生效）。 |
| `presetId` / `longPresetId` | `relay` / `relay-long` | 两个模式 id。 |

侧栏设置（人类可改，热生效）：阈值基准 + 默认模式 / 自动决定 / 自动压缩 / 自动交接 / 预算无上限。

面板状态（按会话，`panel.json`）：持久模式（不消费，接力后由新会话继承）、自动授权、自决记录、交接目标模式、预算无上限、模型推荐三字段等。

数据文件：`~/.dsh/data/dsh-context-relay/settings.json` 与 `panel.json`；消息/会话内容仍由 DSH 自身存储。

## 工具与 HTTP API

| 工具 | 作用 |
|---|---|
| `relay_status` | 读上下文占用 / band / phase / 预算 headroom / 建议。 |
| `relay_phase` | 声明/切换 phase；校验 exit_criteria、contract_check、warn 档 budget_plan；`ship` 需 `user_gate`。 |
| `relay_organize` | 受控压缩：写 phase brief（自动附 doc_lint 结论与关键文档入口）→ 官方压缩 → 注入 brief（含「压缩后手动召回」：被遮蔽的附加 AGENTS.md 路径与已加载 skill 名，需要时按提示重读/重载）。每会话默认最多一次；人类在面板把模式选为『压缩继续』时按人类选择执行第二次（仍过审批）；无面板模式时第二次压缩需人类明确要求（`force`）。 |
| `relay_handoff` | 生成 ≤8KB 交接单（含滚动进度文件），创建新 relay 会话并清理旧会话树。 |
| `relay_recommend` | Lead-only：把模型推荐写入面板（切 phase / 压缩 / 接力 / 人类选择后清空）。 |
| `doc_lint` | 四项目录/文档体检（quota / banned / index / git），输出 ≤2KB。 |

**Relay · 超长任务**额外提供团队工具：`relay_team_status`、`relay_renew`、`relay_rehydrate`（Lead）与 `relay_checkpoint`、`relay_freshen`（队友）。

HTTP（仅本机 GUI 认证后可用）：`GET/PUT /context-relay/settings`、`GET/PUT /context-relay/panel`、`GET /context-relay/api`（handoff 发布箱）。

## 安全边界与代价

- **审批硬门**：`relay_organize` / `relay_handoff` 默认过官方审批（fail-closed，仅 allowed-once 放行）。免审**只**来自面板 `autoCompress` / `autoHandoff` / `authorizeNext`；面板模式（持久、不消费）只决定「做什么」，不产生豁免。
- **接力会创建新会话并消耗额度**：会中断旧会话树中运行中的队友/子智能体、取消其后台任务、迁移定时任务；旧会话标记 `handedOff` 作为审计。
- **压缩有损**：旧对话细节只保留结构化 brief；重要结论请写进文档/handoff。
- **不自动循环**：relay 保持 human-gated；重复性整块劳动请用官方 Ralph / workflow / subagent。
- **P0 规则**：不可逆/对外/付费/凭据/删除动作先报备并取得明确 Go，本插件不会替你自动批准。

## 已知限制

- 重载插件前创建的旧会话使用旧 agent 平面；新行为以重载后新建的 relay 会话为准。
- 只在 DSH Web profile 验证；headless 等其它部署未验证。
- 压缩/接力的实际收益与模型、任务长度相关，阈值不是普适最优。
- 视觉细节未做自动化回归，需安装后目检。
- 压缩保真/收益未做严格 A/B；阈值拐点同样未做 A/B。
- 第二次压缩有摘要漂移风险：每会话默认最多一次；人类在面板把模式选为『压缩继续』时按人类选择执行第二次（仍过审批）；无面板模式时第二次压缩需人类明确要求（`force`）。
- 面板写盘失败时状态只存内存（重启即丢）；settings 写盘是持久化优先。
- composer chip / popover / 侧栏卡片文案仅中文；文档以中文为真源。

## 开发

```console
npm test        # node --test test/*.test.mjs
npm run check   # 全部入口语法检查
```

无构建步骤：host 与 client 都是手写 ESM；开发时可热注入，发布为 bundle（`cordis.patch.yml`）。

`lib/policy.js`（纯策略函数）、`lib/panel-store.js`（面板状态）、`lib/agent.js` + `lib/agent/*`（preset 平面）、`lib/index.js`（Host 平面/HTTP）、`lib/client.js`（Web UI bundle）、`lib/preset-base.js`（PTC preset 资产）、`skills/`（随包技能）。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT

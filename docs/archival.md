# 存量归档（Archival）

> 对象：`.scratch/context-relay/` 下的文档产物。目标是**给存量归位、不删任何内容**：旧产物按年份进 `archive/`，正文与 mtime 原样保留，台账 `manifest.ndjson` 可逐条回溯。
>
> 工具：`scripts/docs-archive.mjs`；默认 dry-run，`--apply` 才移动。规则实现见该脚本头部注释。

## 1. 不变量

- **不删除**：只 `rename`（同一文件系统内原子移动），目标已存在则跳过、绝不覆盖。
- **不改内容**：不写回、不截断、不重新编码；sha256 在移动时记录。
- **不动活文件**：`progress*`、`lessons*`、最新 handoff、`architecture/*.md` 永不入选；闭包内文件一律保留。
- 归档物仍可按原文件名、原相对子路径检索；`archive/<YYYY>/<原相对路径>`。

## 2. 阈值（--months=N）

- 默认 `--months=1`：cutoff = **N 个月前的当日 00:00（本地时区）**。以 2026-11-20 为例即 `2026-10-20 00:00`，与 p3 任务口径一致。
- 只归档 `mtime < cutoff` 的产物；`--months=2` 会把更早一批纳入计划。先 dry-run 看数字，再 `--apply`。
- **日期门槛只约束 `archive/<YYYY>/`**；`archive/dupes/` 的去重是独立规则（见 §5），只受"闭包外"约束。
- mtime 是文件系统时间，不是创作时间：拷贝/上传会刷新 mtime，因此快照目录里的旧文可能显得"新"。这也是默认阈值取 1 个月、且先 dry-run 的原因。

## 3. 引用闭包（哪些文件必须留）

扫描 `root` 下**全部** `.md` / `.json` / `.ndjson`（跳过 `archive/`；`chain*.ndjson` 台账按 JSON-lines 原文扫），抽出文本中的相对路径引用，命中者进入闭包：

- Markdown 链接、反引号路径、裸路径，如 `reports/task-1.md`、`../reports/x.md`、`.scratch/context-relay/reports/x.md`、绝对路径。
- JSON 里的 `key_docs` / `evidence` / `briefPath` 等字段（按原文扫描，不依赖 schema）。
- `progress.md`、`lessons.md`、台账、handoff 中的 `file:line`、指针。
- 解析顺序：相对来源目录 → 相对 root；`#锚点` 与 `http(s)://` 外链忽略；解析不到实体文件的引用不算闭包。
- **闭包内 = 永不移动**（宁多留、不误移）。副作用：互相引用的报告会成片保留，这是有意为之。

## 4. 产物范围

默认只归置文档产物，避免把上传/快照树当历史文档搬走：

- 根目录 `*.md`
- `reports/**/*.md`
- `reviews/**/*.md`

不归置：`team/`（会话内队友记录）、`*-upload/`、`window-r64*/`、`deploy-*`、`backup/`、`dispatch/`、`tmp/`、脚本/图片/压缩包等非文档文件；`archive/` 自身不参与。

## 5. 副本（archive/dupes/）

同 `role` + 同一行标题 + **内容 sha256 完全相同**的 handoff / phase brief / `*brief*` 才算副本（仅标题相同但内容不同不算，例如 52 份不同的 `# Phase Brief · build`）。

- 每组保留 mtime 最新的一份；其余副本只有**在闭包外**才移到 `archive/dupes/<原相对路径>`（不设时间门槛，内容与最新副本完全相同，信息零损失）。
- 闭包内的副本一律原地保留；最新一份即使过期也不进 dupes（仍可因 `mtime` 走 `archive/<YYYY>/`）。

## 6. manifest 与回溯

`archive/manifest.ndjson` 每行一条移动记录（`old`/`new` 均为相对 relay root 的 posix 路径）：

```json
{"old":"reports/x.md","new":"archive/2026/reports/x.md","bytes":1234,"sha256":"…","movedAt":"2026-11-20T12:00:00.000Z","reason":"mtime 2026-10-01, older than 1 month(s)"}
```

回溯（不依赖脚本）：

```bash
# 查某文件被移到哪
grep '"old":"reports/x.md"' .scratch/context-relay/archive/manifest.ndjson
# 原样搬回（保留内容与 mtime）
mkdir -p .scratch/context-relay/reports
mv .scratch/context-relay/archive/2026/reports/x.md .scratch/context-relay/reports/x.md
# 校验完整性
sha256sum .scratch/context-relay/reports/x.md   # 与 manifest 的 sha256 对照
```

## 7. 已知风险

- 引用是**文本启发式**：路径拼错、跨仓库引用、目录级引用（只写 `reports/`）不会进入闭包。apply 后建议 `grep -r "被移动文件名"` 复查。
- 被移动文件内部的相对链接会指向旧位置（这正是"只在闭包外移动"的原因）；如要读归档件，按 `archive/<YYYY>/` 整体浏览。
- 台账/manifest 只追加不重写；重复 apply 幂等（目标存在即跳过，不会二次记录）。

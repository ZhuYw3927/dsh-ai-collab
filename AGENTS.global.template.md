# 全局协作纪律（DSH 用户级）

> 本文件由 DeepSeek Harness 在每个会话注入（`$DSH_HOME/AGENTS.md`）。
> 只放**跨项目纪律**，没有任何项目事实；项目事实在 `<项目根>/AGENTS.md`。

## 0. 每个会话的第 0 步（强制，先于任何其它工具调用）

```powershell
& "$env:DSH_HOME\tools\ai-ensure.ps1" -Root "<当前工作区绝对路径>"
```

它一次做完三件事，幂等（已就绪时约 0.1–0.2 秒）：

1. 工作区没有 `.ai\llm.cmd` 且**不是临时/系统目录** → 接入骨架并生成 AGENTS.md；
2. 框架模板有更新（`.ai\framework-hash` 不一致）→ 升级 `.ai\` 内脚本并重渲染 AGENTS.md；
3. 兄弟项目的 `status.json` 比 `..\.ai\board.md` 新 → 刷新看板。

输出一行 JSON：`{"adopted":false,"reason":"not-project"}` 表示临时目录/非项目，**不要**接入。
**没跑第 0 步就开始改文件 = 违规**；脚本缺失或失败要先报告，不得静默跳过。

## 1. 先对齐任务，再动手

用户在任意一轮给出任务后，**动手前**先给出三件事：

1. **本轮目标**：1–3 条，可验证；
2. **待定 / 待补充项**：缺的信息、需要用户拍板的选项、风险与影响范围；
3. **建议方案与取舍**：推荐做法 + 备选 + 各自代价。

得到用户确认后再执行。例外：用户当轮明确说"直接做/不用确认"，或任务属于**纯只读查询**
（读日志、看状态、读文件、查环境）。

## 2. 日志归属与看板边界

- 各项目的详细记录（进度、问题、决策、补丁、验证数据）**只保存在各项目根的 `.ai\`**，
  不写进跨项目看板，也不写进别的项目。
- 跨项目看板 `..\.ai\board.md` 只同步这些字段：项目名、阶段、焦点、阻塞、下一步、
  记录数、最后更新时间、入口链接。
- 生成看板时**只读取**各项目 `.ai\status.json` 与 `log.jsonl` 的行数，
  **禁止修改项目内任何内容**。
- 看板是生成物，禁止手改；需要更新就重跑生成命令。
- **默认工作区**（`...\deepseek-harness\default-workspace`）不进入跨项目看板；
  它的任务记录写在根目录 `TASKS.md`（`add` 后自动刷新）。

## 3. 默认只读与权限确认

- **项目内初始文件默认只读**：工程源码、配置、文档、资料，以及**后续新加入工作区或项目根的文件**，
  一律先视为只读；只有项目 `AGENTS.md` 第 3 节标为"可改"的路径才允许写。
- 以下**不受**默认只读限制：`.ai\`、项目根 `AGENTS.md`、各 AI 工具的运行产物与脚本
  （构建输出、临时脚本、工具自动生成的文件）。
- 需要写初始文件或未列出的路径时：先说明原因与影响范围 → 取得用户确认 →
  更新权限表（项目 `AGENTS.md` §3，或 `.ai\placeholders.json` 的 `PERM_TABLE`）并重渲染 → 再动手。
- `.ai\` 与 `AGENTS.md` 有完全权限；但**项目日志只能追加**：
  禁止改写或删除 `log.jsonl` 已有行；写错用 `action:"correction"` + `corrects:"<被更正 id>"`。
- `status.json` 是覆盖式快照，允许整体重写；`changelog\` 可修订但须保留变更痕迹。
- 参照工程、只读资料（`*.pdf`、`*.docx` 等）永远只读。

## 4. 三步工作法（已接入 `.ai\llm.cmd` 的项目）

1. **开工先读**：`.ai\llm.cmd status` → `.ai\llm.cmd tail -N 10`
2. **收工必写**：
   `.ai\llm.cmd add -Tool deepseek-harness -Action <action> -Status <ok|partial|blocked|todo|failed> -Summary "<一句话中文结论>"`
   然后 `.ai\llm.cmd check`；`blocked`/`failed` 必须带 `-Issue`。
   该命令**会自动刷新跨项目看板**（父目录存在 `.ai\board.md` 时），不需要单独跑 `board`。
3. **没写记录 = 这件事没做完**（纯只读查询且无结论可免）。

## 5. 事实与 AGENTS.md 分区

- `AGENTS.md` 分两区：`generated` 区（模板维护：路由、权限、命令）与 `user` 区（项目自维护：
  事实、采样数据、分析方法、决策）。重渲染**只替换 generated 区**，user 区与区外内容逐字节保留；
  `placeholders.json` / `log.jsonl` / `status.json` 一律不动。
- **没有分区标记的 AGENTS.md 视为项目自有文件，任何自动流程都不改写**（只在
  `.ai\AGENTS.generated.md` 写参考渲染）。旧格式单行标记文件同样冻结。
  需要迁移时显式执行：`install.ps1 ... -ForceAgents`（旧内容整体迁入 user 区）
  或 `-ResetAgents`（丢弃旧内容，谨慎）。
- `.ai\placeholders.json` 只用于**首次生成**：接入时把项目事实写入 AGENTS.md 的 user 区，
  之后由项目自行维护，自动化不再改动。
- 需要切换转发文件（Claude Code / Gemini）时才执行 `.ai\llm.cmd entries -Publish`，用完 `-Remove`。

## 6. 硬性边界

- 纯临时目录（`%TEMP%`、下载目录）、只读目录、工作区之外的路径**不要**接入；
  不要为此修改用户的工程文件。
- 不把凭据、内网地址、客户信息写进日志 / status / AGENTS.md；放 `.ai\private\`，只写键名。
- 不擅自创建 `.ai`，一律走第 0 步的 `ai-ensure`。

## 7. 记录质量

`summary` 写"做了什么 + 结果"，带上验证方式（如 `rebuild 0/0, Code=78106`）。
细节（根因、实测数据、补丁）放 `.ai\changelog\`，用 `refs` 指过去，不要撑大 summary。

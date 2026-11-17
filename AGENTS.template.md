<!-- dsh-ai-collab:generated:start -->
# AGENTS.md — {{PROJECT_NAME}} 协作入口（项目根）

> 所有 AI 工具与协作者的**唯一入口**：先读本文件，再按 §2 的固定动作开工 / 收工。
> 纪律由 `.ai\llm.cmd`（封装 `llm.ps1`）强制；本文件只放**项目事实**，细节按 §6 查阅，不要往这里堆。
> 动手前先对齐本轮目标 / 待定项并取得用户确认（全局纪律 §1）；工作区内文件默认只读（§3）。
> 框架版本：v2（纪律上提、单一命令、状态快照、多工具一行转发）。

## 2. 开工 / 收工（强制，所有工具）

```powershell
# 开工：先确保接入与同步（幂等；DSH 环境）
& "$env:DSH_HOME\tools\ai-ensure.ps1" -Root "{{PROJECT_ROOT}}"

# 再读状态（10 秒上手）
& .ai\llm.cmd status
& .ai\llm.cmd tail -N 10

# 收工：每完成一件事追加一条，然后校验
& .ai\llm.cmd add -Tool <tool> -Action <action> -Status <status> -Summary "<一句话结论>"
& .ai\llm.cmd check
```

- `<tool>` 用：{{TOOL_LIST}}
- `<action>`：`task_start` `task_done` `fix` `diagnosis` `build` `commit` `doc` `review` `rollback` `correction` `maintenance` `handoff`
- `<status>`：`ok` `partial` `blocked` `todo` `failed`；`blocked`/`failed` 必须带 `-Issue`
- **没写记录 = 这件事没做完**；同一阶段内多次微调合并为一条。
- 禁止手写 `Get-Content` / `AppendAllText` 改日志，一律走 `llm.cmd`（编码与格式由脚本保证）。
- `llm.cmd` 是启动器（内部 `powershell -ExecutionPolicy Bypass -File llm.ps1`），个别目录的脚本执行策略会拦截 `.ps1`，用 `.cmd` 最稳。
- 字段与格式：`.ai\LOG_FORMAT.md`、`.ai\schema\log.schema.json`。

## 3. 目录与权限

| 路径 | 权限 | 说明 |
|---|---|---|
{{PERM_TABLE}}

> **项目内初始文件默认只读**（含后续新加入工作区/项目根的文件），只有上表标为"可改"的路径可写；
> `.ai\`、`AGENTS.md`、各 AI 工具的运行产物与脚本不受此限，但 `log.jsonl` 只能追加。
> 需要写入未列出的初始文件时：先说明原因与影响范围 → 取得用户确认 →
> 把该路径加入上表（或 `.ai\placeholders.json` 的 `PERM_TABLE`）并重渲染 → 再动手。
> 参照工程与只读资料（`*.pdf` / `*.docx`）永远只读。

<!-- IF:BUILD -->
## 4. 构建与验证

```powershell
{{BUILD_CMD}}
```

- 产物：{{OUTPUT_DIR}}
- 烧录 / 装载：{{FLASH_NOTE}}
- 改完必须全量 rebuild：**0 Error / 0 Warning**，尺寸写入日志 `-Verification`（如 `rebuild 0/0, Code=78106`）。
<!-- ENDIF -->
<!-- IFNOT:BUILD -->
## 4. 构建与验证

本工作区为**非构建型**：无编译、烧录或产物校验步骤。
<!-- ENDIF -->

## 5. 硬性约束

- {{CONSTRAINT_1}}
- {{CONSTRAINT_2}}
- {{CONSTRAINT_3}}
- 源码编码：{{ENCODING_RULE}}；批量改动走"区间替换 + 回读校验"，禁止整体重写。
<!-- IF:BUILD -->
- 版本号只改 {{VERSION_FILE}}。
<!-- ENDIF -->
- 提交版本库前**必须先有对应日志记录**；提交说明与 `summary` 可对应。
- 只读目录（参照工程）不得修改；需要回滚时从其复制。

## 6. 领域文档索引（按需查阅）

| 主题 | 位置 |
|---|---|
| 版本级变更（根因 / 验证数据 / 已知限制） | `.ai\changelog\` |
| 历史补丁（可复现每一步改动） | `.ai\changelog\patches\` |
| 日志 / 状态格式与校验 | `.ai\LOG_FORMAT.md`、`.ai\schema\log.schema.json` |
| 敏感信息规则 | `.ai\SECURITY.md` |
| 跨项目看板 | `..\.ai\board.md` |
| 工程内修改历史（对外） | 各工程 `readme.txt` |
| 任务记录清单（默认工作区） | `TASKS.md`（根目录，自动生成） |

## 7. 多工具入口（严格单文件）

**根目录只放本文件（AGENTS.md）+ `.ai\` 一个目录**，不放任何转发文件。

- DSH、Cursor 3.x、VS Code Copilot 等直接读 `AGENTS.md`，无需额外文件。
- 只认 `CLAUDE.md` / `GEMINI.md` 的工具，二选一：
  1. **用户级一次性转发**（推荐，项目内零冗余）：`~\.claude\CLAUDE.md` 写"若存在 ./AGENTS.md 则遵循"；Gemini 在 `~\.gemini\settings.json` 设 `"contextFileName": "AGENTS.md"`。
  2. **临时落地**：`& .ai\llm.cmd entries -Publish` 生成 4 个转发文件，用完 `& .ai\llm.cmd entries -Remove` 收回。
- 转发母版常驻 `.ai\entries\`；改规则只改本文件，`entries -Publish -Force` 会同步。
<!-- dsh-ai-collab:generated:end -->

<!-- dsh-ai-collab:user:start -->
## 1. 项目事实

| 项 | 值 |
|---|---|
| 项目 | {{PROJECT_NAME}}（{{PROJECT_CODE}}） |
| 根目录 | `{{PROJECT_ROOT}}` |
| 摘要 | {{PROJECT_SUMMARY}} |
| MCU / 工具链 | {{MCU}} / {{TOOLCHAIN}} |
| 版本控制 | {{VCS}} |
| 工作日志 | `.ai\log.jsonl`（UTF-8 无 BOM / LF / 只追加） |
| 当前状态 | `.ai\status.json`（覆盖式，新工具先读这个） |
| 变更记录 | `.ai\changelog\`（版本级：根因 / 验证 / 已知限制） |
| 敏感值 | `.ai\private\`（见 `.ai\SECURITY.md`） |

> **本区（含上方 §1 与以下内容）由项目自行维护**：`ai-ensure` / `install.ps1` 只保留、不改写、不删除。
> 建议在此**追加**项目专有内容：采样数据与采集过程、分析方法、硬件/协议约束、验证结论、决策记录等。

<!-- dsh-ai-collab:user:end -->

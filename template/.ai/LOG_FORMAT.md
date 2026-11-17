# `.ai/log.jsonl` 格式规范 v2

> 由 `AGENTS.md` 引用。**只追加、不改写**的 JSONL 流水日志，用于跨工具交接与问题回溯。
> 机器可校验的 schema 在 [schema/log.schema.json](schema/log.schema.json)。
> 一切读写都走 `.ai/llm.cmd`（封装 `llm.ps1`），不要手写 `Get-Content` / `AppendAllText`。

## 1. 文件约定（统一字符格式）

| 项 | 约定 |
|---|---|
| 路径 | `<项目根>/.ai/log.jsonl`（唯一日志文件，子工程不另建） |
| 编码 | **UTF-8 无 BOM**（跨工具、跨平台最稳；PowerShell 5.1 读时必须 `-Encoding UTF8`） |
| 换行 | **LF（`\n`）**，不用 CRLF；一行一个 JSON 对象 |
| 写入 | **只追加**；一行一条；禁止修改/删除历史行 |
| 单条长度 | 建议 ≤ 1200 字符，硬上限 1500（超了就把细节挪到 `changelog/`，`refs` 指过去） |
| 读取时机 | 开工：`llm.cmd status` + `llm.cmd tail -N 10` |
| 语言 | **英文键名 + 中文摘要**（键名固定，值可为中文，便于人读、机器解析） |
| 归档 | 超过 **2 MB** 或按季度归档到 `_archive/`，`log.jsonl` 只留近期记录（见 §5） |

> 为什么不用 CRLF/GBK：JSONL 是逐行解析格式，CRLF 会让部分工具把 `\r` 带进字符串；GBK 在非 Windows 工具里直接乱码。UTF-8 + LF 是解码成本最低的组合。

## 2. 必填字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识，`llm.cmd add` 自动生成，用于去重与 `corrects` 引用 |
| `ts` | string | ISO-8601 带时区，如 `2026-11-04T15:29:29+08:00` |
| `tool` | string | 生产者：`deepseek-harness` / `claude-code` / `cursor` / `codex` / `copilot` / `human` / `svn` / `keil-uv4` |
| `summary` | string | 一句话结论（做了什么 + 结果），中文，≤120 字，单行 |
| `status` | string | `ok` / `partial` / `blocked` / `todo` / `failed` |

## 3. 常用可选字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `action` | string | `task_start` `task_done` `fix` `diagnosis` `build` `commit` `doc` `review` `rollback` `correction` `maintenance` `handoff` |
| `actor` | string | `ai` / `human` / `system` |
| `files_modified` | string[] | 相对项目根的改动文件；无改动写 `[]` |
| `files_read` | string[] | 关键输入文件 |
| `issue` | string | 问题 / 根因 / 阻塞点；`blocked`、`failed` 时必填 |
| `next` | string | 下一步或待确认事项 |
| `verification` | string | 怎么验的 + 结果，如 `rebuild 0/0, Code=78106` |
| `build` | object | `{code,ro,rw,zi,warnings,result}` |
| `tests` | object[] | `[{what,result}]`，实测条目 |
| `commands` | string[] | 关键命令（构建/烧录/抓包/svn），便于复现 |
| `firmware_version` | string | 如 `V01.02.02` |
| `vcs_rev` | number/string | 修订号：`1289` 或 `r1289` |
| `refs` | string[] | 文档/补丁锚点 |
| `tags` | string[] | 自由标签 |
| `corrects` | string | 被更正记录的 `id`（旧行永不修改） |
| `agent` | string | 会话/子代理标识 |
| `migrated_from` | string | 迁移来源：`v1-a` / `v1-b` |

> 原则：**宁可少写字段，也不要写错**。不确定的就不写，或写进 `summary`。

## 4. 一条真实记录

```json
{"id":"20261104T072929123-a1b2c3","ts":"2026-11-04T15:29:29+08:00","tool":"deepseek-harness","actor":"ai","action":"fix","status":"ok","summary":"修正日志读取编码：全部命令改走 llm.ps1，消除 GBK 乱码","files_modified":[".ai/LOG_FORMAT.md"],"verification":"llm.ps1 check 通过，41 条记录 0 错误","tags":["process","encoding"]}
```

## 5. 归档规则（统一阈值）

- 触发：`log.jsonl` **超过 2 MB**，或**每季度**（1/4/7/10 月第一周）做一次例行归档。
- 动作：`llm.cmd archive` 会把旧记录移到 `_archive/log-YYYYQn.jsonl`，并把整文件备份到
  `_archive/log-YYYYQn-backup-<时间戳>.jsonl`，然后追加一条 `action:"maintenance"` 记录说明范围。
- 归档后 `log.jsonl` 只保留近期记录；历史仍可 grep，但开工默认只读 `log.jsonl`。

## 6. 校正与撤销

- 记录**不修改**。写错就追加一条 `action:"correction"` + `corrects:"<被更正的 id>"`，在 `summary` 里写清"原…，实为…"。
- 任务取消：追加 `status:"failed"` 或 `"partial"` 并写明原因，不要删除已写记录。

## 7. 何时必须写 / 何时不必写

必须写：

- 改动了任何工程文件（含只改注释/文档）；
- 完成一次可验证的阶段性工作（编译通过 / 抓包验证 / 提交）；
- 修复缺陷（写根因与修复点）；
- 做出影响后续的决策（目录结构、协议约定、外链策略）；
- **准备提交版本库之前**（先写记录，再提交）；
- 任务被阻塞或失败（`status` + `issue`）。

不必写：纯查询/阅读且无结论；同一阶段内的多次微调可合并为一条。

## 8. 敏感信息

日志、`status.json`、`AGENTS.md` 都不放密码、密钥、私有仓库凭据。
敏感值统一放 `.ai/private/`（见 [SECURITY.md](SECURITY.md)），文档里只写键名。
`llm.cmd check -Sensitive` 会扫描疑似泄漏。

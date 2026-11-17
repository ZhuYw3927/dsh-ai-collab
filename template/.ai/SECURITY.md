# 敏感信息隔离（SECURITY）

> 目标：**让日志、状态快照、AGENTS.md 可以随时分享/打包，而不会泄漏凭据**。
> 本文件是 `.ai/` 内唯一允许出现"敏感值放在哪"说明的地方；敏感值本身不写在这里。

## 1. 什么算敏感

| 类别 | 例子 | 存放位置 |
|---|---|---|
| 账号口令 | SVN/仓库/服务器密码、token、私钥、证书口令 | `.ai/private/sensitive.json` |
| 私有地址 | 内网 SVN/HTTP 地址、跳板机、数据库连接串 | `.ai/private/sensitive.json` |
| 设备身份 | 产品序列号、客户名称、项目代号（未公开） | `.ai/private/sensitive.json` |
| 个人信息 | 姓名、工号、手机号、邮箱 | `.ai/private/sensitive.json` |

以下 **不算** 敏感，可以正常写：本地绝对路径（`D:\Projects\Demo`）、COM 口（`COM4`）、
波特率、固件版本号、编译尺寸、公开的器件型号。

## 2. 目录与格式

```
.ai/private/
├── sensitive.json      ← 实际值（键值对，UTF-8 无 BOM）
└── README.md           ← 本文件的副本（可选）
```

`sensitive.json` 建议形态（键名与文档里引用的一致，值可以是字符串/数组）：

```json
{
  "svn_url": "svn://svn.example.com/repo/demo",
  "svn_user": "zhangsan",
  "svn_password": "<在此填写>",
  "customer": "某客户（未公开）",
  "device_serial_prefix": "23YSCXRD"
}
```

## 3. 引用规则（写日志/文档时）

- 只写键名，不写值：`"refs":["private:sensitive.json#svn_user"]` 或在 `summary` 里写 "凭据见 `.ai/private/`"。
- **禁止**把 `sensitive.json` 的内容复制进 `log.jsonl`、`status.json`、`AGENTS.md`、`changelog/`。
- 打包/分享前删除 `.ai/private/`；`llm.cmd check -Sensitive` 会在提交前扫一遍疑似泄漏。
- `.ai/private/` 永远不进版本库（本框架默认整个 `.ai/` 都不入库，双重保险）。

## 4. 检查

```powershell
# 扫描日志与状态快照里的疑似敏感内容
& .ai\llm.cmd check -Sensitive
```

扫描规则（正则）：`password|passwd|pwd|token|secret|apikey|api_key|BEGIN .*PRIVATE KEY|密码|口令`
以及 `scheme://user:pass@host` 形态的 URL。命中即报错，人工确认后改写为键名引用。

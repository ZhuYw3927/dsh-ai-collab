# PUBLISH — 维护者操作手册（npm 发布准备）

> 当前状态：**只做发布准备，未上传**。以下步骤需要你本人完成 npm 登录（我不接触凭据）。

## 0. 前置检查（已满足）

- `package.json` 已去掉 `private`，`license: MIT`，`files` 白名单只含运行所需文件（19 项，约 32 KB 打包 / 94 KB 解包）。
- `npm pack --dry-run` 已通过，`template/.ai/**` 正常入包。
- `npm run check`、`npm test` 均通过（6 个用例）。
- 包名 `dsh-ai-collab` 在 registry.npmjs.org 上**未被占用**（查询返回 404）。

## 1. 登录 npm（必须由你执行）

本机 `.npmrc` 指向 `registry.npmmirror.com`（只读镜像，不能发布），发布时要显式指定官方 registry：

```powershell
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org    # 应回显你的用户名
```

或在 CI 里使用 `NPM_TOKEN`（`//registry.npmjs.org/:_authToken=...`）。

## 2. 发布前再验证一次

```powershell
cd <package-dir>
npm run check
npm test
npm pack --dry-run
```

## 3. 发布

```powershell
npm publish --access public --registry https://registry.npmjs.org
```

- 首次发布建议加 `--dry-run` 先看文件清单（npm 支持 `npm publish --dry-run`）。
- 之后在 `https://registry.npmjs.org/dsh-ai-collab` 与 `npm view dsh-ai-collab version` 核对。
- 72 小时内可 `npm unpublish dsh-ai-collab@0.2.0` 撤回；超时只能发新版并 `npm deprecate`。

## 4. 版本策略

- 修复 → `npm version patch`；新增工具/配置 → `minor`；破坏 schema → `major`。
- 每次发版更新 `README.md` 与（可选）`CHANGELOG.md`，并在 `package.json` 里同步 `version`。

## 5. 可选：GitHub 仓库

```powershell
cd <package-dir>
git init
git add .
git commit -m "feat: dsh-ai-collab 0.2.0"
git branch -M main
git remote add origin https://github.com/<你>/dsh-ai-collab.git
git push -u origin main
```

建议在仓库里放 GitHub Release（附 `npm pack` 产物）与 Issue 模板。

## 6. 发布后验证（真实安装）

```powershell
# 新建一个一次性 profile 做验证，避免影响 desktop
dsh --profile aicollab-test --from-default-profile web --dump-config
dsh plugin --profile aicollab-test add dsh-ai-collab
dsh --profile aicollab-test --dump-config | Select-String ai-collab
```

确认 `ai-collab` 行出现在组合结果中，再考虑装到 `desktop`。

## 7. 回滚

| 场景 | 操作 |
|---|---|
| 插件导致启动失败 | 从 profile 的 `dsh.profile.bundles` 移除 `dsh-ai-collab`，重启 |
| 只想临时关闭 | 把 `cordis.patch.yml` 里该行的 `enabled` 设为 `false` |
| npm 版本有问题 | `npm deprecate dsh-ai-collab@0.2.0 "broken, use 0.1.1"` 并发布修复版 |

## 8. 发布前仍未完成的事

- [x] 在真实 DSH 中安装验证（§6）：desktop profile 以 bundle 方式运行 0.3.6，5 个工具注册、`ai_init` 实测通过。
- [ ] 补 `repository` / `homepage` 字段（需要先建 GitHub 仓库）。
- [x] `test/` 与 `dev-patch.yml` 不在 `files` 白名单内。
- [x] 非 Windows 平台：脚手架返回 `unsupported-platform`，只读工具可用。

## 9. 社区市场收录（dshmarket / awesome-dsh-plugin）

DSH 官方 Discover 的索引由用户自行添加；社区市场 `dshmarket` 从
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选清单读取。
收录步骤：

1. 发布 npm 包（§3）并建 GitHub 仓库；
2. 在 awesome-dsh-plugin 仓库**提一条 PR**，按其模板增加本包条目（名称、仓库、描述、安装方式）；
3. 合并后 `dshmarket` 与 `awesome-dsh-plugin.com` 通常 1 天内同步；
4. 用 `dsh plugin --profile <test> add dsh-ai-collab` 在干净 profile 复验一次；
5. 可选：自建 format-1 `index.json`（`name`/`version`/`source`/`engines`），让用户在
   **Plugins → Discover → Index sources** 里添加。

要求与注意：

- `package.json` 必须声明 `dsh.bundle.patch`（已满足）；无 build 脚本（已满足，市场默认禁 build）；
- 建议声明 `engines.dsh`（已加 `>=0.2.1`），市场据此做兼容过滤；
- 不要向 `dsh-market/dsh-market` 仓库提插件条目（README 明确说明那是市场应用，不是目录）。


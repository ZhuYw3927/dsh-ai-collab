#Requires -Version 5.1
<#
.SYNOPSIS
    全局工作区初始化：把 AI 协作层 v2 接入任意项目根（新工作区第一次接触时调用）。

.DESCRIPTION
    随包分发版：使用本包内的 install.ps1 与 template\ 骨架，不依赖作者机器路径。
    幂等：已存在 .ai\llm.cmd 时直接退出（除非 -Force）。

    产物（项目根）：
      AGENTS.md            ← 唯一暴露的文件（已存在则不覆盖，除非 -Force）
      .ai\                 ← 骨架（llm.ps1/llm.cmd/log/status/schema/entries…）
      .ai\placeholders.json← 由本脚本生成的事实来源（工程命令/约束待补全）

.EXAMPLE
    & "$env:DSH_HOME\tools\ai-init.ps1" -Root "<project-root>"

.EXAMPLE
    # 只预览将执行的动作
    & "$env:DSH_HOME\tools\ai-init.ps1" -Root <project-root> -WhatIf
#>
[CmdletBinding()]
param(
    [string]$Root = (Get-Location).Path,
    [string]$TemplateRoot = '',
    [string]$Placeholders = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$m) { Write-Host "错误: $m" -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host "• $m" -ForegroundColor Cyan }

if ([string]::IsNullOrWhiteSpace($TemplateRoot)) { $TemplateRoot = $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) { Fail "路径不存在: $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path

$installer = Join-Path $TemplateRoot 'install.ps1'
if (-not (Test-Path -LiteralPath $installer)) { Fail "找不到安装器: $installer（框架目录被移动了？改 -TemplateRoot）" }

$llmCmd = Join-Path $Root '.ai\llm.cmd'
if ((Test-Path -LiteralPath $llmCmd) -and -not $Force) {
    Step "已接入：$llmCmd"
    Write-Host '无需重复初始化（-Force 可强制重装框架文件）。'
    exit 0
}

# ---------- 1. 准备占位符（事实来源） ----------
$aiDir = Join-Path $Root '.ai'
if (-not (Test-Path -LiteralPath $aiDir)) { New-Item -ItemType Directory -Force -Path $aiDir | Out-Null }

if (-not [string]::IsNullOrWhiteSpace($Placeholders)) {
    if (-not (Test-Path -LiteralPath $Placeholders)) { Fail "占位符文件不存在: $Placeholders" }
    $phPath = (Resolve-Path -LiteralPath $Placeholders).Path
}
else {
    $phPath = Join-Path $aiDir 'placeholders.json'
    if (-not (Test-Path -LiteralPath $phPath)) {
        $name = Split-Path -Leaf $Root
        $defaults = [ordered]@{
            PROJECT_NAME    = $name
            PROJECT_CODE    = 'TODO'
            PROJECT_ROOT    = $Root
            PROJECT_SUMMARY = 'TODO：一句话说明产品形态 + 关键器件 + 输出方式'
            MCU             = 'TODO'
            TOOLCHAIN       = 'TODO（如 Keil MDK / ARMCLANG V6.22）'
            VCS             = 'TODO（如 SVN / Git）'
            TOOL_LIST       = '`deepseek-harness` / `claude-code` / `cursor` / `codex` / `copilot` / `human`'
            PERM_TABLE      = @(
                '| `<工程目录>\` | 可改 | 工作副本 |',
                '| `<只读参照目录>\` | **只读** | 参照版本，禁止修改 |',
                '| `.ai\` | 可改 | 日志 / 状态 / 变更记录；**不入库** |'
            )
            BUILD_CMD       = 'TODO：填完整构建命令'
            OUTPUT_DIR      = 'TODO：产物目录'
            FLASH_NOTE      = 'TODO：烧录地址 / 调试串口'
            CONSTRAINT_1    = 'TODO：必须保持不变的行为/配置'
            CONSTRAINT_2    = 'TODO：已知坑或限制'
            CONSTRAINT_3    = 'TODO：验证方法'
            ENCODING_RULE   = 'UTF-8（存量非 UTF-8 文件禁止整体重写）'
            VERSION_FILE    = 'TODO：版本号所在文件'
        }
        $json = $defaults | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($phPath, $json + "`n", $Utf8NoBom)
        Step "已生成占位符: $phPath（TODO 项需补全）"
    }
    else {
        Step "沿用已有占位符: $phPath"
    }
}

# ---------- 2. 调用安装器 ----------
Step "安装 AI 协作层 → $Root"
$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-ProjectRoot', $Root, '-Placeholders', $phPath)
if ($Force) { $args += '-Force' }
& powershell.exe @args
if ($LASTEXITCODE -ne 0) { Fail "安装器返回 $LASTEXITCODE" }

# ---------- 3. 收尾 ----------
Write-Host ''
Write-Host '接入完成。下一步：' -ForegroundColor Yellow
Write-Host "  1) 补全 $phPath 里的 TODO（工程命令 / 约束 / 只读目录）"
Write-Host "  2) 重新渲染：powershell -File `"$installer`" -ProjectRoot `"$Root`" -Placeholders `"$phPath`" -Force"
Write-Host "  3) 写第一条记录：& `"$Root\.ai\llm.cmd`" add -Tool human -Action task_done -Status ok -Summary `"接入 AI 协作层 v2`""

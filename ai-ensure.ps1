#Requires -Version 5.1
<#
.SYNOPSIS
    会话启动/收尾的统一入口：确保工作区已接入，并让 AGENTS.md、框架副本、跨项目看板都保持最新。

.DESCRIPTION
    幂等、快（通常 0.1~0.2s；首次接入约 5s）。按顺序：
      1) 未接入（缺 .ai\llm.cmd）且看起来是长期项目 → 调用 ai-init.ps1 接入；
      2) 框架副本过期（.ai\framework-hash 与当前模板不一致）→ install.ps1 -Force 升级 .ai\ 内文件；
      3) .ai\placeholders.json 比 AGENTS.md 新 → 重渲染 AGENTS.md；
      4) 兄弟项目 status.json 比 ..\.ai\board.md 新 → 刷新看板。

    输出一行 JSON：{"ok":true,"adopted":true,"agentsUpdated":false,"filesUpdated":true,"boardUpdated":false,...}

.EXAMPLE
    & "$env:DSH_HOME\tools\ai-ensure.ps1" -Root "<project-root>"

.EXAMPLE
    # 只接入、不刷新看板
    & "$env:DSH_HOME\tools\ai-ensure.ps1" -Root . -NoBoard
#>
[CmdletBinding()]
param(
    [string]$Root = (Get-Location).Path,
    [string]$Framework = '',
    [string]$Placeholders = '',
    [switch]$Force,
    [switch]$NoAgents,
    [switch]$NoBoard
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$sw = [Diagnostics.Stopwatch]::StartNew()

function Out-Result($obj) { ($obj | ConvertTo-Json -Compress -Depth 5) }

if ([string]::IsNullOrWhiteSpace($Framework)) { $Framework = $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) {
    Out-Result @{ ok = $false; error = "路径不存在: $Root" }
    exit 1
}
$Root = (Resolve-Path -LiteralPath $Root).Path
$ai = Join-Path $Root '.ai'
$llmCmd = Join-Path $ai 'llm.cmd'
$agents = Join-Path $Root 'AGENTS.md'
$installer = Join-Path $Framework 'install.ps1'
$init = Join-Path $PSScriptRoot 'ai-init.ps1'
$templateLlm = Join-Path $Framework 'template\.ai\llm.ps1'
$templateAgents = Join-Path $Framework 'AGENTS.template.md'
$hashMarker = Join-Path $ai 'framework-hash'

$changed = @()
$adopted = Test-Path -LiteralPath $llmCmd
$agentsUpdated = $false
$filesUpdated = $false
$boardUpdated = $false

function Test-Adoptable([string]$Path) {
    $p = $Path.TrimEnd('\')
    # 排除临时目录、系统目录、盘符根、用户主目录、AppData、DSH_HOME
    if ($p -match '(?i)\\Temp\\|\\AppData\\Local\\Temp|\\Downloads\\|\\AppData\\|\\Windows\\|\\Program Files') { return $false }
    if ($p -match '^[A-Za-z]:$') { return $false }
    if ($p -ieq $env:USERPROFILE.TrimEnd('\')) { return $false }
    if ($env:DSH_HOME -and $p -ieq $env:DSH_HOME.TrimEnd('\')) { return $false }
    return $true
}

# ---------- 1. 接入 ----------
if (-not $adopted) {
    if (-not (Test-Adoptable $Root)) {
        Out-Result @{ ok = $true; root = $Root; adopted = $false; reason = 'not-project'; ms = [int]$sw.ElapsedMilliseconds }
        exit 0
    }
    if (-not (Test-Path -LiteralPath $init)) {
        Out-Result @{ ok = $false; root = $Root; error = "缺少初始化脚本: $init" }
        exit 1
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $init -Root $Root *> $null
    if ($LASTEXITCODE -ne 0) {
        Out-Result @{ ok = $false; root = $Root; error = "ai-init 失败(exit $LASTEXITCODE)" }
        exit 1
    }
    $adopted = Test-Path -LiteralPath $llmCmd
    if ($adopted) { $changed += 'adopted' }
}
if (-not $adopted) {
    Out-Result @{ ok = $true; root = $Root; adopted = $false; reason = 'init-no-effect'; ms = [int]$sw.ElapsedMilliseconds }
    exit 0
}

# ---------- 2. 占位符 ----------
$ph = $null
if (-not [string]::IsNullOrWhiteSpace($Placeholders) -and (Test-Path -LiteralPath $Placeholders)) {
    $ph = (Resolve-Path -LiteralPath $Placeholders).Path
}
if (-not $ph) {
    $localPh = Join-Path $ai 'placeholders.json'
    $namedPh = ''
    if (Test-Path -LiteralPath $localPh) { $ph = $localPh }
    elseif ($namedPh -and (Test-Path -LiteralPath $namedPh)) {
        Copy-Item -LiteralPath $namedPh -Destination $localPh -Force
        $ph = $localPh
        $changed += 'placeholders-copied'
    }
}

# ---------- 3. 框架副本 / AGENTS 同步 ----------
$needFiles = $false
if (Test-Path -LiteralPath $templateLlm) {
    $currentHash = (Get-FileHash -LiteralPath $templateLlm -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $templateAgents) {
        $currentHash += '-' + (Get-FileHash -LiteralPath $templateAgents -Algorithm SHA256).Hash
    }
    $storedHash = ''
    if (Test-Path -LiteralPath $hashMarker) { $storedHash = (Get-Content -LiteralPath $hashMarker -Raw -Encoding UTF8).Trim() }
    if ($storedHash -ne $currentHash) { $needFiles = $true }
}
if (-not $NoAgents) {
    $needAgents = $false
    $agentsGenerated = $false
    $agentsPreserved = $false
    if (Test-Path -LiteralPath $agents) {
        $agentsText = [System.IO.File]::ReadAllText($agents, [System.Text.Encoding]::UTF8)
        $agentsGenerated = $agentsText.Contains('dsh-ai-collab:generated:start')
    }
    if (-not (Test-Path -LiteralPath $agents)) { $needAgents = $true }
    elseif ($agentsGenerated -and $ph -and (Get-Item -LiteralPath $ph).LastWriteTimeUtc -gt (Get-Item -LiteralPath $agents).LastWriteTimeUtc) { $needAgents = $true }
    # 手工/上一轮的 AGENTS.md：永不自动重渲染（install.ps1 只写参考渲染）
    if ((Test-Path -LiteralPath $agents) -and -not $agentsGenerated) { $agentsPreserved = $true; if (-not ($changed -contains 'agents-preserved')) { $changed += 'agents-preserved' } }
    if ($Force) { $needAgents = $true; $needFiles = $true }

    if (($needFiles -or $needAgents) -and $ph -and (Test-Path -LiteralPath $installer)) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ProjectRoot $Root -Placeholders $ph -Force *> $null
        if ($LASTEXITCODE -eq 0) {
            $agentsUpdated = $needAgents
            $filesUpdated = $needFiles
            if ($needFiles) { $changed += 'files' }
            if ($needAgents) { $changed += 'agents' }
            if (Test-Path -LiteralPath $templateLlm) {
                $markerValue = (Get-FileHash -LiteralPath $templateLlm -Algorithm SHA256).Hash
                if (Test-Path -LiteralPath $templateAgents) { $markerValue += '-' + (Get-FileHash -LiteralPath $templateAgents -Algorithm SHA256).Hash }
                [System.IO.File]::WriteAllText($hashMarker, $markerValue, $Utf8NoBom)
            }
        }
    }
}

# ---------- 3b. 任务清单（默认工作区自动启用；其他工作区有标记时同样刷新） ----------
$tasksMarker = Join-Path $ai 'tasks-enabled'
if (($Root -match '(?i)\\deepseek-harness\\default-workspace$') -and -not (Test-Path -LiteralPath $tasksMarker)) {
    New-Item -ItemType File -Force -Path $tasksMarker | Out-Null
    $changed += 'tasks-enabled'
}
if (Test-Path -LiteralPath $tasksMarker) {
    if (Test-Path -LiteralPath $llmCmd) {
        & $llmCmd tasks *> $null
        if ($LASTEXITCODE -eq 0) { $changed += 'tasks' }
    }
}
# ---------- 4. 看板 ----------
$parent = Split-Path -Parent $Root
$board = Join-Path $parent '.ai\board.md'
if (-not $NoBoard -and (Test-Path -LiteralPath $board) -and (Test-Path -LiteralPath $llmCmd)) {
    $boardTime = (Get-Item -LiteralPath $board).LastWriteTimeUtc
    $newer = $false
    foreach ($d in (Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue)) {
        if ($d.Name.StartsWith('.') -or $d.Name.StartsWith('_')) { continue }
        $s = Join-Path $d.FullName '.ai\status.json'
        if ((Test-Path -LiteralPath $s) -and (Get-Item -LiteralPath $s).LastWriteTimeUtc -gt $boardTime) { $newer = $true; break }
    }
    if ($Force -or $newer -or $filesUpdated -or $agentsUpdated) {
        & $llmCmd board -Root $parent *> $null
        if ($LASTEXITCODE -eq 0) { $boardUpdated = $true; $changed += 'board' }
    }
}

Out-Result @{
    ok            = $true
    root          = $Root
    adopted       = $true
    filesUpdated  = $filesUpdated
    agentsUpdated = $agentsUpdated
    agentsPreserved = $agentsPreserved
    boardUpdated  = $boardUpdated
    placeholders  = $ph
    changed       = @($changed)
    ms            = [int]$sw.ElapsedMilliseconds
}

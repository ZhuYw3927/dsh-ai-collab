#Requires -Version 5.1
<#
.SYNOPSIS
    把 v2 协作层安装到一个项目根（AGENTS.md + .ai/ + 多工具入口文件）。

.DESCRIPTION
    幂等：可重复运行。框架文件（LOG_FORMAT / SECURITY / llm.ps1 / schema）会被更新；
    项目自有文件（changelog/README.md、patches、log.jsonl、status.json）只在缺失时创建。
    AGENTS.md 已存在时默认不覆盖，需要 -Force（覆盖前请自行备份）。

.EXAMPLE
    .\install.ps1 -ProjectRoot <project-root> -Placeholders .\_projects\demo.json

.EXAMPLE
    # 只装 .ai 不生成入口文件
    .\install.ps1 -ProjectRoot <project-root> -Placeholders .\_projects\demo.json -NoEntries
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$Placeholders = '',
    [switch]$Force,
    [switch]$ForceAgents,
    [switch]$ResetAgents,
    [switch]$NoEntries
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Utf8([string]$Path) { return [System.IO.File]::ReadAllText($Path, $Utf8NoBom) }

# PS 5.1 的 ConvertTo-Json 会把中文转义成 \uXXXX；还原成真实字符，便于阅读
function ConvertFrom-JsonEscapes([string]$Text) {
    $sb = New-Object System.Text.StringBuilder
    $i = 0
    while ($i -lt $Text.Length) {
        if ($Text[$i] -eq '\' -and ($i + 5) -lt $Text.Length -and $Text[$i + 1] -eq 'u') {
            $hex = $Text.Substring($i + 2, 4)
            $code = 0
            if ([int]::TryParse($hex, [System.Globalization.NumberStyles]::HexNumber, $null, [ref]$code)) {
                [void]$sb.Append([char]$code)
                $i += 6
                continue
            }
        }
        [void]$sb.Append($Text[$i])
        $i++
    }
    return $sb.ToString()
}

function Write-Utf8([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $Utf8NoBom)
}

# 整理成 2 空格缩进、无多余空格的 JSON
function Test-Flag([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    return -not ($Value -match '^(?i)(0|false|no|off|disabled)$')
}

# 处理 <!-- IF:KEY --> ... <!-- ENDIF -->：KEY 为假值时删除整段
function Remove-ConditionalBlocks([string]$Text, $Map) {
    # 支持 <!-- IF:KEY --> 与 <!-- IFNOT:KEY -->，均以 <!-- ENDIF --> 结束
    $pattern = '(?s)<!--\s*(IF|IFNOT):([A-Z0-9_]+)\s*-->(.*?)<!--\s*ENDIF\s*-->'
    $sb = New-Object System.Text.StringBuilder
    $pos = 0
    foreach ($m in [regex]::Matches($Text, $pattern)) {
        [void]$sb.Append($Text.Substring($pos, $m.Index - $pos))
        $mode = $m.Groups[1].Value
        $key = $m.Groups[2].Value
        $value = ''
        if ($Map.ContainsKey($key)) { $value = [string]$Map[$key] }
        $flag = Test-Flag $value
        $keep = if ($mode -eq 'IF') { $flag } else { -not $flag }
        if ($keep) { [void]$sb.Append($m.Groups[3].Value) }
        $pos = $m.Index + $m.Length
    }
    if ($pos -lt $Text.Length) { [void]$sb.Append($Text.Substring($pos)) }
    $result = $sb.ToString()
    # 删除条件块后可能出现连续空行，压成最多一个空行
    return [regex]::Replace($result, '(\r?\n){3,}', "`n`n")
}

function Format-JsonPretty([string]$Text) {
    $t = $Text -replace '":\s{2,}', '": '
    $t = [regex]::Replace($t, '\[\r?\n\s*\]', '[]')
    $t = [regex]::Replace($t, '\{\r?\n\s*\}', '{}')
    $lines = New-Object System.Collections.ArrayList
    $depth = 0
    foreach ($line in $t.Split("`n")) {
        $trim = $line.Trim()
        if ($trim -eq '') { continue }
        if ($trim -match '^[\]\}]') { $depth = $depth - 1 }
        if ($depth -lt 0) { $depth = 0 }
        [void]$lines.Add(('  ' * $depth) + $trim)
        if ($trim -match '[\{\[]$') { $depth = $depth + 1 }
    }
    return ($lines -join "`n")
}

function Fail([string]$Message) { Write-Host "错误: $Message" -ForegroundColor Red; exit 1 }
function Step([string]$Message) { Write-Host "• $Message" -ForegroundColor Cyan }

if (-not (Test-Path -LiteralPath $ProjectRoot)) { Fail "项目根不存在: $ProjectRoot" }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

# ---------- 占位符 ----------
$map = @{}
if (-not [string]::IsNullOrWhiteSpace($Placeholders)) {
    if (-not (Test-Path -LiteralPath $Placeholders)) { Fail "占位符文件不存在: $Placeholders" }
    $json = (Read-Utf8 $Placeholders) | ConvertFrom-Json
    foreach ($p in $json.PSObject.Properties) {
        if ($p.Value -is [array]) { $map[$p.Name] = ($p.Value -join "`n") }
        else { $map[$p.Name] = [string]$p.Value }
    }
}
else {
    Write-Host '提示: 未提供 -Placeholders，AGENTS.md 将保留 {{...}} 占位符，需要手工补全。' -ForegroundColor Yellow
}
$map['NOW'] = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
if (-not $map.ContainsKey('PROJECT_ROOT')) { $map['PROJECT_ROOT'] = $ProjectRoot }
if (-not $map.ContainsKey('PROJECT_NAME')) { $map['PROJECT_NAME'] = (Split-Path -Leaf $ProjectRoot) }

# ---------- 1. .ai 骨架 ----------
$dstLlm = Join-Path $ProjectRoot '.ai'
$tplLlm = Join-Path $here 'template\.ai'
if (-not (Test-Path -LiteralPath $tplLlm)) { Fail "模板缺失: $tplLlm" }

New-Item -ItemType Directory -Force -Path $dstLlm | Out-Null
foreach ($sub in @('schema', 'changelog', 'changelog\patches', '_archive')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $dstLlm $sub) | Out-Null
}

# 框架自有文件：总是更新
foreach ($rel in @('LOG_FORMAT.md', 'SECURITY.md', 'llm.ps1', 'llm.cmd', 'schema\log.schema.json')) {
    $src = Join-Path $tplLlm $rel
    $dst = Join-Path $dstLlm $rel
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Step ("更新: .ai\{0}" -f $rel)
}

# 项目自有文件：只在缺失时创建
$createIfMissing = @(
    @{ Rel = 'changelog\README.md'; Src = 'changelog\README.md' },
    @{ Rel = 'changelog\patches\apply_patches.ps1'; Src = 'changelog\patches\apply_patches.ps1' },
    @{ Rel = '_archive\.keep'; Src = '_archive\.keep' }
)
foreach ($item in $createIfMissing) {
    $src = Join-Path $tplLlm $item.Src
    $dst = Join-Path $dstLlm $item.Rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    if (Test-Path -LiteralPath $dst) { Step ("保留: .ai\{0}（已存在）" -f $item.Rel); continue }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Step ("创建: .ai\{0}" -f $item.Rel)
}

# log.jsonl：只在缺失时创建空文件，绝不覆盖历史
$logPath = Join-Path $dstLlm 'log.jsonl'
if (-not (Test-Path -LiteralPath $logPath)) {
    [System.IO.File]::WriteAllText($logPath, '', $Utf8NoBom)
    Step '创建: .ai\log.jsonl（空）'
}
else {
    $count = @(Get-Content -LiteralPath $logPath -Encoding UTF8 | Where-Object { $_.Trim() }).Count
    Step ("保留: .ai\log.jsonl（已有 {0} 条）" -f $count)
}

# status.json：只在缺失时按模板渲染（先当 JSON 解析再赋值，避免路径反斜杠破坏 JSON）
$statusPath = Join-Path $dstLlm 'status.json'
if (-not (Test-Path -LiteralPath $statusPath)) {
    $st = (Read-Utf8 (Join-Path $tplLlm 'status.json')) | ConvertFrom-Json
    $st.project = [string]$map['PROJECT_NAME']
    $st.root = $ProjectRoot
    $st.updated_at = [string]$map['NOW']
    $stJson = ConvertTo-Json -InputObject $st -Depth 8
    $stJson = ConvertFrom-JsonEscapes $stJson
    $stJson = Format-JsonPretty $stJson
    Write-Utf8 $statusPath $stJson
    Step '创建: .ai\status.json'
}
else {
    Step '保留: .ai\status.json（已存在）'
}

# ---------- 2. AGENTS.md ----------
$agentsPath = Join-Path $ProjectRoot 'AGENTS.md'
$tplAgents = Read-Utf8 (Join-Path $here 'AGENTS.template.md')
foreach ($k in $map.Keys) { $tplAgents = $tplAgents.Replace('{{' + $k + '}}', $map[$k]) }
$tplAgents = Remove-ConditionalBlocks $tplAgents $map

$left = @([regex]::Matches($tplAgents, '\{\{[A-Z0-9_]+\}\}') | ForEach-Object { $_.Value } | Sort-Object -Unique)
if ($left.Count -gt 0) {
    Write-Host ("警告: 以下占位符未替换，需手工补全: " + ($left -join ', ')) -ForegroundColor Yellow
}

function Get-MarkedSpan([string]$Text, [string]$StartMarker, [string]$EndMarker) {
    $i = $Text.IndexOf($StartMarker)
    if ($i -lt 0) { return $null }
    $j = $Text.IndexOf($EndMarker, $i)
    if ($j -lt 0) { return $null }
    return [pscustomobject]@{
        Start = $i
        End   = $j + $EndMarker.Length
    }
}

$gStart = '<!-- dsh-ai-collab:generated:start -->'
$gEnd = '<!-- dsh-ai-collab:generated:end -->'
$uStart = '<!-- dsh-ai-collab:user:start -->'
$uEnd = '<!-- dsh-ai-collab:user:end -->'

$agentsExists = Test-Path -LiteralPath $agentsPath
$agentsGenerated = $false
$agentsPreserved = $false
if ($agentsExists) {
    $currentAgents = Read-Utf8 $agentsPath
    $agentsGenerated = ($currentAgents.IndexOf($gStart) -ge 0) -and ($currentAgents.IndexOf($gEnd) -ge 0)
}

if (-not $agentsExists) {
    Write-Utf8 $agentsPath $tplAgents
    Step '写入: AGENTS.md'
}
elseif ($ResetAgents) {
    Write-Utf8 $agentsPath $tplAgents
    Step '写入: AGENTS.md（-ResetAgents：丢弃旧内容，仅按模板重建）'
}
elseif ($agentsGenerated) {
    # 只替换 generated 区，user 区与其它内容原样保留
    $newSpan = Get-MarkedSpan $tplAgents $gStart $gEnd
    $oldSpan = Get-MarkedSpan $currentAgents $gStart $gEnd
    $merged = $currentAgents.Substring(0, $oldSpan.Start) +
        $tplAgents.Substring($newSpan.Start, $newSpan.End - $newSpan.Start) +
        $currentAgents.Substring($oldSpan.End)
    Write-Utf8 $agentsPath $merged
    Step '更新: AGENTS.md（仅替换自动区，项目自维护区原样保留）'
}
elseif ($ForceAgents) {
    # 旧格式/手工文件：保留全部旧内容，放进 user 区，绝不删除
    $newSpan = Get-MarkedSpan $tplAgents $gStart $gEnd
    $generated = $tplAgents.Substring($newSpan.Start, $newSpan.End - $newSpan.Start)
    $preserved = $currentAgents.TrimEnd()
    $composed = $generated + "`n`n" + $uStart + "`n" +
        "<!-- 以下为原 AGENTS.md 内容，由 -ForceAgents 原样迁入，未做删改 -->`n`n" +
        $preserved + "`n" + $uEnd + "`n"
    Write-Utf8 $agentsPath $composed
    Step '写入: AGENTS.md（-ForceAgents：自动区重建，旧内容整体迁入项目自维护区）'
}
else {
    $response = Join-Path (Join-Path $ProjectRoot '.ai') 'AGENTS.generated.md'
    Write-Utf8 $response $tplAgents
    $agentsPreserved = $true
    Step '保留: AGENTS.md（无自动区标记，视为项目自维护；未覆盖）'
    Write-Host '  参考渲染已写到 .ai\AGENTS.generated.md' -ForegroundColor Yellow
    Write-Host '  迁移到分区结构（旧内容整体保留）：install.ps1 ... -ForceAgents' -ForegroundColor Yellow
}

# ---------- 3. 多工具入口 ----------
# 用 -ExecutionPolicy Bypass 调用，避免部分目录的脚本执行策略限制
if (-not $NoEntries) {
    $llm = Join-Path $dstLlm 'llm.ps1'
    if (Test-Path -LiteralPath $llm) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $llm entries
    }
}

# ---------- 4. 收尾提示 ----------
Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host '  1) 检查 AGENTS.md 第 1/3/5 节是否为真实值（无 {{...}} 残留）'
Write-Host '  2) 初始化状态快照:  & .ai\llm.cmd status -FromLog -Phase init -Focus "接入 v2"'
Write-Host '  3) 写第一条日志:    & .ai\llm.cmd add -Tool human -Action task_done -Status ok -Summary "接入 AI 协作层 v2"'
Write-Host '  4) 校验:            & .ai\llm.cmd check -Sensitive'
Write-Host '  5) 若整目录纳入 SVN，建议（本脚本不执行）:  svn propset svn:ignore -F .\svn-ignore.txt .'
Write-Host ''
Write-Host '注意：AGENTS.md 与 .ai\ 属本地协作层，默认不入库；敏感值放 .ai\private\（见 .ai\SECURITY.md）。'

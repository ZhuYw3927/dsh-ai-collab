#Requires -Version 5.1
<#
.SYNOPSIS
    AI 协作层 v2 单一入口：status / tail / add / check / entries / archive / board / doctor。

.DESCRIPTION
    放在 <项目根>\.ai\llm.ps1。所有 AI 工具读写工作日志、状态快照、多工具入口、
    跨项目看板都只调用本脚本，不要各自手写 Get-Content / AppendAllText。

    约定（与 LOG_FORMAT.md 一致）：
      - .ai\log.jsonl      UTF-8 无 BOM、LF、一行一条，只追加
      - .ai\status.json    当前状态快照，覆盖式更新
      - .ai\schema\log.schema.json  机器可校验的字段定义
      - .ai\private\       敏感值（本脚本不读写，仅检查是否泄漏）

.EXAMPLE
    & .ai\llm.ps1 status
    & .ai\llm.ps1 tail -N 10
    & .ai\llm.ps1 add -Tool deepseek-harness -Action fix -Status ok -Summary "修正 X" -Files src\a.c
    & .ai\llm.ps1 check -Sensitive
    & .ai\llm.ps1 board -Root <project-root>
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('help', 'status', 'tail', 'add', 'check', 'entries', 'archive', 'board', 'doctor', 'tasks')]
    [string]$Command = 'help',

    # 项目根；缺省为本脚本所在的 .ai 的上一级
    [string]$Root = '',

    # tail 条数
    [int]$N = 10,

    # add 的整条记录（JSON 字符串）或 JSON 文件；给出后忽略其它字段参数
    [string]$Json = '',
    [string]$FromFile = '',

    # add 的字段
    [string]$Tool = '',
    [string]$Summary = '',
    [string]$Action = '',
    [string]$Status = 'ok',
    [string]$Actor = 'ai',
    [string[]]$Files = @(),
    [string]$Issue = '',
    [string]$Next = '',
    [string]$Verification = '',
    [string[]]$Tags = @(),
    [string[]]$Refs = @(),
    [string[]]$CmdLines = @(),
    [string]$FirmwareVersion = '',

    # status 更新字段
    [string]$Phase = '',
    [string]$Focus = '',
    [string[]]$Blockers = @(),
    [string[]]$NextSteps = @(),
    [switch]$FromLog,

    # 通用开关
    [switch]$Sensitive,
    [switch]$Quiet,
    [switch]$Force,
    [switch]$Publish,
    [switch]$Remove,
    [switch]$NoStatus,
    [switch]$NoBoard,
    [switch]$Strict,

    # archive
    [string]$Before = '',
    [double]$MaxMB = 2,

    # board
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 常量与工具

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ActionEnum = @('task_start', 'task_done', 'fix', 'diagnosis', 'build', 'commit',
    'doc', 'review', 'rollback', 'correction', 'maintenance', 'handoff')
$StatusEnum = @('ok', 'partial', 'blocked', 'todo', 'failed')
$ActorEnum = @('ai', 'human', 'system')

$SensitivePattern = 'password|passwd|pwd|token|secret|apikey|api_key|BEGIN [A-Z ]*PRIVATE KEY|密码|口令|密钥|://[^/\s:]+:[^/\s@]+@'

function Write-Info([string]$Text) {
    if (-not $Quiet) { Write-Host $Text }
}
function Write-Warn2([string]$Text) {
    Write-Host "警告: $Text" -ForegroundColor Yellow
}
function Write-Err2([string]$Text) {
    Write-Host "错误: $Text" -ForegroundColor Red
}

function Get-ProjectRoot([string]$Explicit) {
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "项目根不存在: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    # 本脚本位于 <root>\.ai\llm.ps1
    $llmDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($llmDir)) { $llmDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
    return (Split-Path -Parent $llmDir)
}

function Get-LogPath([string]$ProjectRoot) { Join-Path $ProjectRoot '.ai\log.jsonl' }
function Get-StatusPath([string]$ProjectRoot) { Join-Path $ProjectRoot '.ai\status.json' }

function Read-TextFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
}

function Get-LogLines([string]$ProjectRoot) {
    $path = Get-LogPath $ProjectRoot
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $text = Read-TextFile $path
    $text = $text.Replace("`r`n", "`n")
    $out = @()
    foreach ($line in $text.Split("`n")) {
        if ($line.Trim().Length -gt 0) { $out += $line.TrimEnd("`r") }
    }
    return $out
}

function Get-Now {
    return (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
}

function New-RecordId {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfff')
    $rnd = -join (1..6 | ForEach-Object { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) })
    return "$stamp-$rnd"
}

# PS 5.1 的 ConvertTo-Json 会把中文转义成 \uXXXX；这里还原成真实字符，保证日志可读
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

function ConvertTo-JsonText($Object) {
    $json = ConvertTo-Json -InputObject $Object -Compress -Depth 8
    return (ConvertFrom-JsonEscapes $json)
}

# 把 PS 5.1 生成的 JSON 整理成 2 空格缩进、无多余空格的形态（便于人读）
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

function Get-Prop($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            $v = $Object[$Name]
            if ($null -ne $v) { return $v }
        }
        return $Default
    }
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $v = $Object.$Name
        if ($null -ne $v) { return $v }
    }
    return $Default
}

# 把 PSCustomObject / OrderedDictionary 统一成有序字典，便于覆盖式更新
function Copy-ObjectToOrdered($Object) {
    $out = [ordered]@{}
    if ($null -eq $Object) { return $out }
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($k in $Object.Keys) { $out[$k] = $Object[$k] }
        return $out
    }
    foreach ($p in $Object.PSObject.Properties) { $out[$p.Name] = $p.Value }
    return $out
}

# 把 "a,b" / @('a','b') 统一拆成数组（llm.cmd 传参时逗号不会被 PowerShell 展开）
function Split-ListArgs([string[]]$Items) {
    $out = @()
    foreach ($item in @($Items)) {
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        foreach ($part in ($item -split ',')) {
            $p = $part.Trim()
            if ($p -ne '') { $out += $p }
        }
    }
    return $out
}

# ---------------------------------------------------------------- 校验

function Test-Record($Record, [int]$LineNo) {
    $errors = New-Object System.Collections.ArrayList

    function Add-Err([string]$m) { [void]$errors.Add($m) }

    $id = Get-Prop $Record 'id' ''
    $ts = Get-Prop $Record 'ts' ''
    $tool = Get-Prop $Record 'tool' ''
    $summary = Get-Prop $Record 'summary' ''
    $status = Get-Prop $Record 'status' ''
    $action = Get-Prop $Record 'action' ''

    if ([string]::IsNullOrWhiteSpace([string]$id)) { Add-Err '缺少必填字段 id' }
    elseif (([string]$id).Length -lt 8) { Add-Err "id 过短: $id" }

    if ([string]::IsNullOrWhiteSpace([string]$ts)) { Add-Err '缺少必填字段 ts' }
    else {
        $parsed = [datetimeoffset]::MinValue
        $ok = [datetimeoffset]::TryParse([string]$ts, [ref]$parsed)
        if (-not $ok) { Add-Err "ts 不是合法的 ISO-8601: $ts" }
        elseif ([string]$ts -notmatch '(Z|[+-]\d{2}:\d{2})$') { Add-Err "ts 缺少时区: $ts" }
    }

    if ([string]::IsNullOrWhiteSpace([string]$tool)) { Add-Err '缺少必填字段 tool' }

    if ([string]::IsNullOrWhiteSpace([string]$summary)) { Add-Err '缺少必填字段 summary' }
    elseif (([string]$summary).Length -gt 200) { Add-Err ("summary 过长 ({0} 字符 > 200)" -f ([string]$summary).Length) }

    if ([string]::IsNullOrWhiteSpace([string]$status)) { Add-Err '缺少必填字段 status' }
    elseif ($StatusEnum -notcontains [string]$status) { Add-Err "status 非法: $status（允许: $($StatusEnum -join '/')）" }

    if (-not [string]::IsNullOrWhiteSpace([string]$action) -and $ActionEnum -notcontains [string]$action) {
        Add-Err "action 非法: $action（允许: $($ActionEnum -join '/')）"
    }

    $actor = Get-Prop $Record 'actor' ''
    if (-not [string]::IsNullOrWhiteSpace([string]$actor) -and $ActorEnum -notcontains [string]$actor) {
        Add-Err "actor 非法: $actor（允许: $($ActorEnum -join '/')）"
    }

    # 注意：blocked/failed 必须带 issue 的规则只在写入时强制（见 Invoke-Add），
    # 校验历史记录时放宽，避免 v1 迁移数据无法通过。

    if ($LineNo -gt 0) {
        return @($errors | ForEach-Object { "第 $LineNo 行: $_" })
    }
    return @($errors)
}

# ---------------------------------------------------------------- status 快照

function Get-StatusObject([string]$ProjectRoot) {
    $path = Get-StatusPath $ProjectRoot
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Read-TextFile $path | ConvertFrom-Json)
}

function Save-StatusObject([string]$ProjectRoot, $Object) {
    $path = Get-StatusPath $ProjectRoot
    $pretty = ConvertTo-Json -InputObject $Object -Depth 8
    $pretty = ConvertFrom-JsonEscapes $pretty
    $pretty = Format-JsonPretty $pretty
    [System.IO.File]::WriteAllText($path, ($pretty -replace "`r`n", "`n") + "`n", $Utf8NoBom)
    return $path
}

function Update-StatusFromLog([string]$ProjectRoot, $Record) {
    if ($NoStatus) { return }
    $statusPath = Get-StatusPath $ProjectRoot
    if (-not (Test-Path -LiteralPath $statusPath)) { return }

    $out = Copy-ObjectToOrdered (Get-StatusObject $ProjectRoot)
    $out['last_log_ts'] = Get-Prop $Record 'ts' $null
    $out['last_log_id'] = Get-Prop $Record 'id' $null
    $out['updated_at'] = Get-Now
    $nextVal = [string](Get-Prop $Record 'next' '')
    if (-not [string]::IsNullOrWhiteSpace($nextVal)) {
        $out['next'] = @($nextVal)
    }
    $statusVal = [string](Get-Prop $Record 'status' '')
    if ($statusVal -in @('blocked', 'failed')) {
        $issueVal = [string](Get-Prop $Record 'issue' '')
        $existing = @()
        if ($out.Contains('blockers')) { $existing = @($out['blockers']) }
        $out['blockers'] = @(@($issueVal) + $existing | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
    }
    [void](Save-StatusObject $ProjectRoot $out)
}

# ---------------------------------------------------------------- 命令实现

function Invoke-Status([string]$ProjectRoot) {
    $cur = Get-StatusObject $ProjectRoot
    if ($null -eq $cur) {
        Write-Warn2 "没有状态快照: $(Get-StatusPath $ProjectRoot)（运行 llm.ps1 add 或手工创建）"
        return
    }

    if ($FromLog) {
        $lines = Get-LogLines $ProjectRoot
        $last = $null
        if ($lines.Count -gt 0) { $last = $lines[-1] | ConvertFrom-Json }
        $out = Copy-ObjectToOrdered $cur
        if ($null -ne $last) {
            $out['last_log_ts'] = Get-Prop $last 'ts' $null
            $out['last_log_id'] = Get-Prop $last 'id' $null
            $n = Get-Prop $last 'next' ''
            if (-not [string]::IsNullOrWhiteSpace([string]$n)) { $out['next'] = @([string]$n) }
            $s = Get-Prop $last 'summary' ''
            if (-not [string]::IsNullOrWhiteSpace([string]$s)) { $out['focus'] = [string]$s }
        }
        $out['updated_at'] = Get-Now
        $cur = $out
    }

    if (-not [string]::IsNullOrWhiteSpace($Phase) -or -not [string]::IsNullOrWhiteSpace($Focus) -or
        $Blockers.Count -gt 0 -or $NextSteps.Count -gt 0 -or $FromLog) {
        $out = Copy-ObjectToOrdered $cur
        if (-not [string]::IsNullOrWhiteSpace($Phase)) { $out['phase'] = $Phase }
        if (-not [string]::IsNullOrWhiteSpace($Focus)) { $out['focus'] = $Focus }
        $blockerList = @(Split-ListArgs $Blockers)
        $nextList = @(Split-ListArgs $NextSteps)
        if ($blockerList.Count -gt 0) { $out['blockers'] = $blockerList }
        if ($nextList.Count -gt 0) { $out['next'] = $nextList }
        $out['updated_at'] = Get-Now
        $path = Save-StatusObject $ProjectRoot $out
        Write-Info "已更新状态: $path"
        $cur = Get-StatusObject $ProjectRoot
    }

    if (-not $Quiet) {
        Write-Host ''
        Write-Host ("项目    : {0}" -f (Get-Prop $cur 'project' '?'))
        Write-Host ("阶段    : {0}" -f (Get-Prop $cur 'phase' '?'))
        Write-Host ("焦点    : {0}" -f (Get-Prop $cur 'focus' '?'))
        $b = @(Get-Prop $cur 'blockers' @())
        Write-Host ("阻塞    : {0}" -f $(if ($b.Count -eq 0) { '无' } else { $b -join '；' }))
        $n = @(Get-Prop $cur 'next' @())
        Write-Host ("下一步  : {0}" -f $(if ($n.Count -eq 0) { '无' } else { $n -join '；' }))
        Write-Host ("最后记录: {0}" -f (Get-Prop $cur 'last_log_ts' '无'))
        Write-Host ("更新时间: {0}" -f (Get-Prop $cur 'updated_at' '?'))
    }
}

function Invoke-Tail([string]$ProjectRoot) {
    $lines = Get-LogLines $ProjectRoot
    if ($lines.Count -eq 0) {
        Write-Info "（日志为空）: $(Get-LogPath $ProjectRoot)"
        return
    }
    $start = [Math]::Max(0, $lines.Count - $N)
    for ($i = $start; $i -lt $lines.Count; $i++) { Write-Output $lines[$i] }
}

function Invoke-Add {
    param(
        [string]$ProjectRoot,
        [string]$Json = '',
        [string]$FromFile = '',
        [string]$Tool = '',
        [string]$Summary = '',
        [string]$Action = '',
        [string]$Status = 'ok',
        [string]$Actor = 'ai',
        [string[]]$Files = @(),
        [string]$Issue = '',
        [string]$Next = '',
        [string]$Verification = '',
        [string[]]$Tags = @(),
        [string[]]$Refs = @(),
        [string[]]$CmdLines = @(),
        [string]$FirmwareVersion = '',
        [switch]$NoStatus,
        [switch]$NoBoard,
        [switch]$Quiet
    )
    # 命令行经 llm.cmd 传入时，"a,b" 会是一个字符串；这里统一按逗号拆开
    $Files = @(Split-ListArgs $Files)
    $Tags = @(Split-ListArgs $Tags)
    $Refs = @(Split-ListArgs $Refs)
    $CmdLines = @(Split-ListArgs $CmdLines)

    $record = $null

    if (-not [string]::IsNullOrWhiteSpace($Json)) {
        $record = $Json | ConvertFrom-Json
    }
    elseif (-not [string]::IsNullOrWhiteSpace($FromFile)) {
        if (-not (Test-Path -LiteralPath $FromFile)) { throw "记录文件不存在: $FromFile" }
        $record = (Read-TextFile $FromFile) | ConvertFrom-Json
    }
    else {
        if ([string]::IsNullOrWhiteSpace($Tool)) { throw '缺少 -Tool（生产者标识）' }
        if ([string]::IsNullOrWhiteSpace($Summary)) { throw '缺少 -Summary（一句话结论）' }

        $record = [pscustomobject]@{
            id        = New-RecordId
            ts        = Get-Now
            tool      = $Tool
            actor     = $Actor
            action    = $Action
            status    = $Status
            summary   = $Summary
        }
        if ($Files.Count -gt 0) { $record | Add-Member -NotePropertyName files_modified -NotePropertyValue @($Files) }
        if ($Tags.Count -gt 0) { $record | Add-Member -NotePropertyName tags -NotePropertyValue @($Tags) }
        if ($Refs.Count -gt 0) { $record | Add-Member -NotePropertyName refs -NotePropertyValue @($Refs) }
        if ($CmdLines.Count -gt 0) { $record | Add-Member -NotePropertyName commands -NotePropertyValue @($CmdLines) }
        if (-not [string]::IsNullOrWhiteSpace($Issue)) { $record | Add-Member -NotePropertyName issue -NotePropertyValue $Issue }
        if (-not [string]::IsNullOrWhiteSpace($Next)) { $record | Add-Member -NotePropertyName next -NotePropertyValue $Next }
        if (-not [string]::IsNullOrWhiteSpace($Verification)) { $record | Add-Member -NotePropertyName verification -NotePropertyValue $Verification }
        if (-not [string]::IsNullOrWhiteSpace($FirmwareVersion)) { $record | Add-Member -NotePropertyName firmware_version -NotePropertyValue $FirmwareVersion }
    }

    if ($null -eq $record) { throw '没有可写入的记录' }

    # 规范化成有序对象：保留调用方给出的字段，补默认值
    $ordered = [ordered]@{}
    $ordered['id'] = [string](Get-Prop $record 'id' (New-RecordId))
    $ordered['ts'] = [string](Get-Prop $record 'ts' (Get-Now))
    $ordered['tool'] = [string](Get-Prop $record 'tool' $Tool)
    $ordered['actor'] = [string](Get-Prop $record 'actor' $Actor)
    $actionVal = [string](Get-Prop $record 'action' $Action)
    if (-not [string]::IsNullOrWhiteSpace($actionVal)) { $ordered['action'] = $actionVal }
    $ordered['status'] = [string](Get-Prop $record 'status' $Status)
    $ordered['summary'] = [string](Get-Prop $record 'summary' $Summary)

    # ConvertFrom-Json 会把单元素数组拆成标量，这里按字段语义强制还原为数组
    $arrayFields = @('files_modified', 'files_read', 'tests', 'commands', 'refs', 'tags')
    foreach ($field in @('files_modified', 'files_read', 'issue', 'next', 'verification',
            'build', 'tests', 'commands', 'firmware_version', 'vcs_rev', 'refs', 'tags',
            'corrects', 'agent', 'migrated_from')) {
        $v = Get-Prop $record $field $null
        if ($arrayFields -contains $field -and $null -ne $v) { $v = @($v) }
        if ($null -ne $v -and -not ($v -is [string] -and [string]::IsNullOrWhiteSpace($v))) {
            if ($v -is [array] -and $v.Count -eq 0) { continue }
            $ordered[$field] = $v
        }
    }

    # 写入时强制：blocked/failed 必须说明阻塞原因
    if ((@('blocked', 'failed') -contains [string]$ordered['status']) -and
        [string]::IsNullOrWhiteSpace([string](Get-Prop $ordered 'issue' ''))) {
        throw ("status={0} 时必须提供 -Issue（阻塞/失败原因）" -f $ordered['status'])
    }

    $errors = Test-Record $ordered 0
    if ($errors.Count -gt 0) {
        foreach ($e in $errors) { Write-Err2 $e }
        throw '记录校验失败，未写入'
    }

    $line = ConvertTo-JsonText $ordered
    if ($line.Length -gt 1500) {
        throw ("单条记录 {0} 字符，超过 1500 上限；请精简 summary，细节放 changelog" -f $line.Length)
    }

    $logPath = Get-LogPath $ProjectRoot
    $dir = Split-Path -Parent $logPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::AppendAllText($logPath, $line + "`n", $Utf8NoBom)

    Update-StatusFromLog $ProjectRoot $ordered

    # 自动刷新跨项目看板（约定：项目父目录存在 .ai\board.md）。-NoBoard 可关闭。
    if (-not $NoBoard) {
        $parentDir = Split-Path -Parent $ProjectRoot
        $boardFile = Join-Path $parentDir '.ai\board.md'
        if (Test-Path -LiteralPath $boardFile) {
            $quietBefore = $Quiet
            $Quiet = $true
            try { Invoke-Board $parentDir } catch { }
            $Quiet = $quietBefore
        }
    }

    # 任务清单（仅在启用标记存在时生成，默认工作区用）
    $tasksMarker = Join-Path $ProjectRoot '.ai\tasks-enabled'
    if (Test-Path -LiteralPath $tasksMarker) {
        $quietBefore2 = $Quiet
        $Quiet = $true
        try { Invoke-Tasks $ProjectRoot } catch { }
        $Quiet = $quietBefore2
    }

    if (-not $Quiet) {
        Write-Info "已追加: $line"
        Write-Info ("日志: {0}（共 {1} 条）" -f $logPath, (Get-LogLines $ProjectRoot).Count)
    }
}

function Invoke-Check([string]$ProjectRoot) {
    $logPath = Get-LogPath $ProjectRoot
    if (-not (Test-Path -LiteralPath $logPath)) { throw "日志文件不存在: $logPath" }

    $errors = New-Object System.Collections.ArrayList
    $warnings = New-Object System.Collections.ArrayList

    # 编码/换行检查
    $bytes = [System.IO.File]::ReadAllBytes($logPath)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        [void]$errors.Add('log.jsonl 带 UTF-8 BOM（要求无 BOM）')
    }
    $text = Read-TextFile $logPath
    if ($text.Contains("`r`n")) { [void]$errors.Add('log.jsonl 含 CRLF（要求 LF）') }

    $lines = Get-LogLines $ProjectRoot
    $seenIds = @{}
    $prevTs = $null
    $lineNo = 0

    foreach ($line in $lines) {
        $lineNo++
        if ($line.Length -gt 1500) { [void]$errors.Add("第 $lineNo 行: 超过 1500 字符") }
        $record = $null
        try { $record = $line | ConvertFrom-Json }
        catch { [void]$errors.Add("第 $lineNo 行: 不是合法 JSON"); continue }

        foreach ($e in (Test-Record $record $lineNo)) { [void]$errors.Add($e) }

        $id = [string](Get-Prop $record 'id' '')
        if ($id -ne '') {
            if ($seenIds.ContainsKey($id)) { [void]$errors.Add("第 $lineNo 行: id 重复 ($id)") }
            else { $seenIds[$id] = $true }
        }

        $tsText = [string](Get-Prop $record 'ts' '')
        if ($tsText -ne '') {
            $parsed = [datetimeoffset]::MinValue
            if ([datetimeoffset]::TryParse($tsText, [ref]$parsed)) {
                if ($null -ne $prevTs -and $parsed -lt $prevTs) {
                    [void]$errors.Add("第 $lineNo 行: ts 倒退 ($tsText < $($prevTs.ToString('o')))")
                }
                $prevTs = $parsed
            }
        }

        if ($Sensitive -and $line -match $SensitivePattern) {
            [void]$errors.Add("第 $lineNo 行: 疑似敏感信息（password/token/凭据 URL）")
        }
    }

    # status.json 检查
    $statusPath = Get-StatusPath $ProjectRoot
    if (Test-Path -LiteralPath $statusPath) {
        try { $st = Read-TextFile $statusPath | ConvertFrom-Json }
        catch { [void]$errors.Add('status.json 不是合法 JSON'); $st = $null }
        if ($null -ne $st) {
            foreach ($need in @('project', 'root', 'phase', 'focus', 'updated_at')) {
                if ($null -eq (Get-Prop $st $need $null)) { [void]$warnings.Add("status.json 缺少字段 $need") }
            }
            if ($Sensitive -and (Read-TextFile $statusPath) -match $SensitivePattern) {
                [void]$errors.Add('status.json 疑似含敏感信息')
            }
        }
    }
    else {
        [void]$warnings.Add('缺少 .ai\status.json（运行 llm.ps1 status -FromLog 生成）')
    }

    foreach ($w in $warnings) { Write-Warn2 $w }

    if ($errors.Count -gt 0) {
        foreach ($e in $errors) { Write-Err2 $e }
        Write-Host ("校验失败: {0} 条错误 / {1} 条记录" -f $errors.Count, $lineNo) -ForegroundColor Red
        exit 1
    }

    Write-Host ("校验通过: {0} 条记录，0 错误（{1} 条警告）" -f $lineNo, $warnings.Count) -ForegroundColor Green
}

function Invoke-Entries {
    param(
        [string]$ProjectRoot,
        [switch]$Publish,
        [switch]$Remove,
        [switch]$Force
    )

    $entriesDir = Join-Path $ProjectRoot '.ai\entries'
    $marker = 'generated by .ai\llm.cmd entries'

    $targets = @(
        @{ Name = 'CLAUDE.md';               Tool = 'claude-code'; Target = 'CLAUDE.md';                      Title = 'CLAUDE.md';            Mdc = $false },
        @{ Name = 'GEMINI.md';               Tool = 'gemini-cli';  Target = 'GEMINI.md';                      Title = 'GEMINI.md';            Mdc = $false },
        @{ Name = 'copilot-instructions.md'; Tool = 'copilot';     Target = '.github\copilot-instructions.md'; Title = 'Copilot Instructions'; Mdc = $false },
        @{ Name = 'agents.mdc';              Tool = 'cursor';      Target = '.cursor\rules\agents.mdc';       Title = 'Cursor Rule';          Mdc = $true }
    )

    # -Remove：收回已发布的转发文件，恢复“根目录只有 AGENTS.md”
    if ($Remove) {
        $removed = 0
        foreach ($t in $targets) {
            $full = Join-Path $ProjectRoot $t.Target
            if (-not (Test-Path -LiteralPath $full)) { continue }
            $text = Read-TextFile $full
            if ($text -notmatch [regex]::Escape($marker)) {
                Write-Warn2 "跳过（不是本框架生成的）: $($t.Target)"
                continue
            }
            Remove-Item -LiteralPath $full -Force
            $removed++
            Write-Info "已移除: $($t.Target)"
            $dir = Split-Path -Parent $full
            while ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) {
                Remove-Item -LiteralPath $dir -Force
                $next = Split-Path -Parent $dir
                if ($next -eq $dir -or $next -eq $ProjectRoot) { break }
                $dir = $next
            }
        }
        Write-Info "已移除 $removed 个转发文件；根目录只剩 AGENTS.md + .ai\"
        return
    }

    if (-not (Test-Path -LiteralPath $entriesDir)) { New-Item -ItemType Directory -Force -Path $entriesDir | Out-Null }

    $body = @'
<!-- generated by .ai\llm.cmd entries — 母版；需要自动发现时用 .ai\llm.cmd entries -Publish -->
# {{TITLE}}

Read and follow `AGENTS.md` in this project root (`{{ROOT}}`), then record work through `.ai\llm.cmd`:

    .ai\llm.cmd status
    .ai\llm.cmd tail -N 10
    .ai\llm.cmd add -Tool {{TOOL}} -Action <action> -Status <ok|partial|blocked|todo|failed> -Summary "<一句话结论>"
    .ai\llm.cmd check

Rules that always apply: read before you act, append one record after each work item,
never rewrite `.ai\log.jsonl`, never put credentials in logs (see `.ai\SECURITY.md`).
'@

    $mdcBody = @'
---
description: 项目 AI 协作入口（转发 AGENTS.md）
alwaysApply: true
---

<!-- generated by .ai\llm.cmd entries — 母版；需要自动发现时用 .ai\llm.cmd entries -Publish -->
Read and follow `AGENTS.md` in this project root (`{{ROOT}}`).
Record work through `.ai\llm.cmd` (status / tail / add / check). Never rewrite the log; never log credentials.
'@

    foreach ($t in $targets) {
        $template = if ($t.Mdc) { $mdcBody } else { $body }
        $content = $template.Replace('{{TITLE}}', $t.Title).Replace('{{TOOL}}', $t.Tool).Replace('{{ROOT}}', $ProjectRoot)
        $dest = Join-Path $entriesDir $t.Name
        if ((Test-Path -LiteralPath $dest) -and -not $Force) { continue }
        [System.IO.File]::WriteAllText($dest, ($content -replace "`r`n", "`n") + "`n", $Utf8NoBom)
    }
    Write-Info ("母版已更新: .ai\entries\（{0} 个）" -f $targets.Count)

    if ($Publish) {
        foreach ($t in $targets) {
            $src = Join-Path $entriesDir $t.Name
            $dst = Join-Path $ProjectRoot $t.Target
            $dir = Split-Path -Parent $dst
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            Copy-Item -LiteralPath $src -Destination $dst -Force
            Write-Info "已发布: $($t.Target)"
        }
        Write-Warn2 '已发布转发文件，根目录不再是“只有 AGENTS.md”；用完执行 .ai\llm.cmd entries -Remove'
    }
    else {
        Write-Info '严格单文件模式：未向根目录发布（需要时 .ai\llm.cmd entries -Publish）'
    }
}

function Invoke-Tasks([string]$ProjectRoot) {
    # 生成人读的任务记录清单：<项目根>\TASKS.md（来源 log.jsonl，追加语义不变）
    $rows = @()
    foreach ($line in (Get-LogLines $ProjectRoot)) {
        $rec = $null
        try { $rec = $line | ConvertFrom-Json } catch { continue }
        $summary = ([string](Get-Prop $rec 'summary' '')).Replace('|', '\|')
        $rows += [pscustomobject]@{
            Ts      = [string](Get-Prop $rec 'ts' '')
            Action  = [string](Get-Prop $rec 'action' '')
            Status  = [string](Get-Prop $rec 'status' '')
            Summary = $summary
            Id      = [string](Get-Prop $rec 'id' '')
        }
    }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# 任务记录清单')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(('> 自动生成：来自 `.ai\log.jsonl`，共 {0} 条；按时间倒序。最后更新 {1}' -f $rows.Count, (Get-Now)))
    [void]$sb.AppendLine('> 只读清单：要新增任务请用 `.ai\llm.cmd add`，不要直接编辑本文件。')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| 时间 | 类型 | 状态 | 摘要 | 记录 id |')
    [void]$sb.AppendLine('|---|---|---|---|---|')
    for ($i = $rows.Count - 1; $i -ge 0; $i--) {
        $r = $rows[$i]
        [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} | `{4}` |' -f $r.Ts, $r.Action, $r.Status, $r.Summary, $r.Id))
    }
    if ($rows.Count -eq 0) { [void]$sb.AppendLine('| （暂无记录） | | | | |') }

    $out = Join-Path $ProjectRoot 'TASKS.md'
    [System.IO.File]::WriteAllText($out, $sb.ToString().Replace("`r`n", "`n"), $Utf8NoBom)
    if (-not $Quiet) { Write-Info ("已生成任务清单: {0}（{1} 条）" -f $out, $rows.Count) }
}
function Invoke-Archive([string]$ProjectRoot) {
    $logPath = Get-LogPath $ProjectRoot
    $lines = Get-LogLines $ProjectRoot
    if ($lines.Count -eq 0) { Write-Info '日志为空，无需归档'; return }

    $sizeMB = (Get-Item -LiteralPath $logPath).Length / 1MB
    $cut = 0
    $reason = ''

    if (-not [string]::IsNullOrWhiteSpace($Before)) {
        $limit = [datetimeoffset]::MinValue
        if (-not [datetimeoffset]::TryParse($Before, [ref]$limit)) { throw "无法解析 -Before: $Before" }
        $keep = @()
        foreach ($line in $lines) {
            $rec = $line | ConvertFrom-Json
            $t = [string](Get-Prop $rec 'ts' '')
            $parsed = [datetimeoffset]::MinValue
            if (([datetimeoffset]::TryParse($t, [ref]$parsed)) -and $parsed -lt $limit) { $cut++ } else { $keep += $line }
        }
        $reason = "早于 $Before"
    }
    elseif ($Force -or $sizeMB -gt $MaxMB) {
        $cut = [int][Math]::Floor($lines.Count * 0.8)
        $keep = @($lines[$cut..($lines.Count - 1)])
        $reason = ("日志 {0:N1} MB 超过阈值 {1} MB" -f $sizeMB, $MaxMB)
    }
    else {
        Write-Info ("无需归档：{0:N2} MB ≤ {1} MB（-Force 可强制，或 -Before yyyy-MM-dd）" -f $sizeMB, $MaxMB)
        return
    }

    if ($cut -le 0) { Write-Info '没有需要归档的记录'; return }

    $archived = @($lines[0..($cut - 1)])
    $quarter = 'Q' + [Math]::Ceiling((Get-Date).Month / 3)
    $archiveDir = Join-Path $ProjectRoot '.ai\_archive'
    if (-not (Test-Path -LiteralPath $archiveDir)) { New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null }
    $archiveFile = Join-Path $archiveDir ("log-{0}-{1}.jsonl" -f (Get-Date).Year, $quarter)
    $backupFile = Join-Path $archiveDir ("log-{0}-backup-{1}.jsonl" -f (Get-Date).ToString('yyyyMMdd-HHmmss'), $quarter)

    Copy-Item -LiteralPath $logPath -Destination $backupFile -Force
    foreach ($line in $archived) { [System.IO.File]::AppendAllText($archiveFile, $line + "`n", $Utf8NoBom) }

    $keepText = ''
    if ($keep.Count -gt 0) { $keepText = ($keep -join "`n") + "`n" }
    [System.IO.File]::WriteAllText($logPath, $keepText, $Utf8NoBom)

    Write-Info ("已归档 {0} 条 → {1}" -f $archived.Count, $archiveFile)
    Write-Info ("整文件备份 → {0}" -f $backupFile)

    # 维护记录（用本脚本追加，保持同一格式）
    Invoke-Add -ProjectRoot $ProjectRoot -Tool 'human' -Actor 'human' -Action 'maintenance' -Status 'ok' `
        -Summary ("归档日志：{0}，{1} 条移入 {2}，保留 {3} 条" -f $reason, $archived.Count, (Split-Path -Leaf $archiveFile), $keep.Count) `
        -Files @('.ai/log.jsonl', ('.ai/_archive/' + (Split-Path -Leaf $archiveFile))) `
        -Tags @('maintenance', 'archive')
}

function Invoke-Board([string]$ProjectRoot) {
    $scanRoot = $ProjectRoot
    if (-not [string]::IsNullOrWhiteSpace($Out)) {
        # -Out 给相对路径时相对项目根
        if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $ProjectRoot $Out }
    }
    else {
        $Out = Join-Path $scanRoot '.ai\board.md'
    }

    $rows = @()
    $unadopted = @()
    $dirs = @(Get-ChildItem -LiteralPath $scanRoot -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { -not $_.Name.StartsWith('.') -and -not $_.Name.StartsWith('_') } |
            Sort-Object Name)

    foreach ($d in $dirs) {
        $statusFile = Join-Path $d.FullName '.ai\status.json'
        if (-not (Test-Path -LiteralPath $statusFile)) { $unadopted += $d.Name; continue }
        $st = $null
        try { $st = (Read-TextFile $statusFile) | ConvertFrom-Json } catch { $unadopted += ($d.Name + '（status.json 解析失败）'); continue }

        $logCount = 0
        $logFile = Join-Path $d.FullName '.ai\log.jsonl'
        if (Test-Path -LiteralPath $logFile) {
            $logCount = @(Get-Content -LiteralPath $logFile -Encoding UTF8 | Where-Object { $_.Trim() }).Count
        }
        $blockers = @(Get-Prop $st 'blockers' @())
        $next = @(Get-Prop $st 'next' @())
        $rows += [pscustomobject]@{
            Name     = [string](Get-Prop $st 'project' $d.Name)
            Dir      = $d.Name
            Phase    = [string](Get-Prop $st 'phase' '')
            Focus    = [string](Get-Prop $st 'focus' '')
            Blockers = ($blockers -join '；')
            Next     = ($next -join '；')
            Count    = $logCount
            Updated  = [string](Get-Prop $st 'updated_at' '')
        }
    }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# 项目看板（AI 协作层 v2）')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(('> 生成：{0} ｜ 扫描：{1} ｜ 生成器：`.ai\llm.cmd board`' -f (Get-Now), $scanRoot))
    [void]$sb.AppendLine('> 本页只做汇总索引；**详细进度与问题在各项目自己的 `.ai\` 里**，点最后一列进入。')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| 项目 | 阶段 | 焦点 | 阻塞 | 下一步 | 记录 | 最后更新 | 入口 |')
    [void]$sb.AppendLine('|---|---|---|---|---|---:|---|---|')

    foreach ($r in ($rows | Sort-Object -Property @{ Expression = 'Updated'; Descending = $true })) {
        $focus = $r.Focus
        if ($focus.Length -gt 40) { $focus = $focus.Substring(0, 40) + '…' }
        $blockers = $r.Blockers
        if ($blockers.Length -gt 30) { $blockers = $blockers.Substring(0, 30) + '…' }
        $next = $r.Next
        if ($next.Length -gt 30) { $next = $next.Substring(0, 30) + '…' }
        $updated = $r.Updated -replace 'T', ' '
        if ($updated.Length -gt 16) { $updated = $updated.Substring(0, 16) }
        $focus = $focus -replace '\|', '\|'
        $blockers = $blockers -replace '\|', '\|'
        $next = $next -replace '\|', '\|'
        $link = ('[{0}](../{0}/.ai/status.json) · [log](../{0}/.ai/log.jsonl)' -f $r.Dir)
        [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} |' -f $r.Name, $r.Phase, $focus, $(if ($blockers) { $blockers } else { '—' }), $(if ($next) { $next } else { '—' }), $r.Count, $updated, $link))
    }

    if ($rows.Count -eq 0) { [void]$sb.AppendLine('| （暂无已接入项目） | | | | | | | |') }

    if ($unadopted.Count -gt 0) {
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('## 未接入 v2 的目录')
        [void]$sb.AppendLine('')
        foreach ($u in $unadopted) { [void]$sb.AppendLine("- $u") }
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('接入方式：`_AI_Framework_v2\install.ps1 -ProjectRoot <路径> -Placeholders <该项目的 json>`')
    }

    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('---')
    [void]$sb.AppendLine(('记录数统计口径：`.ai\log.jsonl` 的非空行数。看板由脚本生成，手工改动会在下次生成时被覆盖。'))

    $outDir = Split-Path -Parent $Out
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    [System.IO.File]::WriteAllText($Out, $sb.ToString().Replace("`r`n", "`n"), $Utf8NoBom)
    Write-Info ("已生成看板: {0}（{1} 个项目，{2} 个未接入）" -f $Out, $rows.Count, $unadopted.Count)
}

function Invoke-Doctor([string]$ProjectRoot) {
    $checks = @()
    $required = @(
        'AGENTS.md',
        '.ai\llm.ps1', '.ai\llm.cmd',
        '.ai\log.jsonl', '.ai\status.json',
        '.ai\LOG_FORMAT.md', '.ai\SECURITY.md',
        '.ai\schema\log.schema.json',
        '.ai\entries\CLAUDE.md', '.ai\entries\GEMINI.md',
        '.ai\entries\copilot-instructions.md', '.ai\entries\agents.mdc'
    )
    $optional = @('CLAUDE.md', 'GEMINI.md', '.github\copilot-instructions.md', '.cursor\rules\agents.mdc')

    $fail = 0
    foreach ($rel in $required) {
        $ok = Test-Path -LiteralPath (Join-Path $ProjectRoot $rel)
        if (-not $ok) { $fail++ }
        $checks += ('{0}  {1}' -f $(if ($ok) { 'OK  ' } else { 'MISS' }), $rel)
    }
    foreach ($rel in $optional) {
        $full = Join-Path $ProjectRoot $rel
        if (-not (Test-Path -LiteralPath $full)) { $checks += ('未发布  {0}' -f $rel); continue }
        $text = Read-TextFile $full
        if ($text -notmatch 'AGENTS\.md') {
            $checks += ('警告    {0}（未引用 AGENTS.md）' -f $rel)
            $fail++
        }
        else {
            $checks += ('已发布  {0}' -f $rel)
        }
    }

    foreach ($c in $checks) { Write-Host $c }
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.ai\private')) {
        Write-Info '提示: 存在 .ai\private\（敏感值），打包/分享前删除。'
    }
    if ($fail -gt 0) {
        Write-Err2 "$fail 项缺失或未指向 AGENTS.md"
        exit 1
    }
    Write-Host '结构检查通过（根目录仅 AGENTS.md + .ai\ + 工程目录）。' -ForegroundColor Green
}

# ---------------------------------------------------------------- 分发

$projectRoot = Get-ProjectRoot $Root

switch ($Command) {
    'help' {
        Write-Host @'
AI 协作层 v2 — .ai\llm.ps1

用法:
  .ai\llm.ps1 status  [-FromLog] [-Phase x] [-Focus x] [-Blockers a,b] [-NextSteps a,b]
  .ai\llm.ps1 tail    [-N 10]
  .ai\llm.ps1 add     -Tool <name> -Summary "<一句话>" [-Action <a>] [-Status <s>]
                       [-Actor ai|human|system] [-Files a,b] [-Issue x] [-Next x]
                       [-Verification x] [-Tags a,b] [-Refs a,b] [-CmdLines a,b]
                       [-FirmwareVersion x] [-Json <json>] [-FromFile <path>] [-NoStatus]
  .ai\llm.ps1 check   [-Sensitive] [-Strict]
  .ai\llm.ps1 entries [-Publish|-Remove] [-Force]     # 默认只写 .ai\entries 母版
  .ai\llm.ps1 archive [-Before yyyy-MM-dd] [-MaxMB 2] [-Force]
  .ai\llm.ps1 board   [-Root <project-root>] [-Out <path>]
  .ai\llm.ps1 doctor
  .ai\llm.ps1 tasks                      # 生成 <项目根>\TASKS.md（任务记录清单）

示例:
  & .ai\llm.ps1 add -Tool deepseek-harness -Action fix -Status ok `
      -Summary "修正 UART 波特率切换：写标志页后再复位" `
      -Files src\uart.c -Verification "rebuild 0/0, Code=78106" -Tags imu,uart

说明:
  - 日志: .ai\log.jsonl（UTF-8 无 BOM / LF / 只追加）
  - 状态: .ai\status.json（覆盖式更新，供新工具快速接手）
  - 敏感值: .ai\private\（不进日志；check -Sensitive 扫描泄漏）
'@
    }
    'status' { Invoke-Status $projectRoot }
    'tail' { Invoke-Tail $projectRoot }
    'add' {
        Invoke-Add -ProjectRoot $projectRoot -Json $Json -FromFile $FromFile `
            -Tool $Tool -Summary $Summary -Action $Action -Status $Status -Actor $Actor `
            -Files $Files -Issue $Issue -Next $Next -Verification $Verification `
            -Tags $Tags -Refs $Refs -CmdLines $CmdLines -FirmwareVersion $FirmwareVersion `
            -NoStatus:$NoStatus -NoBoard:$NoBoard -Quiet:$Quiet
    }
    'check' { Invoke-Check $projectRoot }
    'entries' { Invoke-Entries -ProjectRoot $projectRoot -Publish:$Publish -Remove:$Remove -Force:$Force }
    'archive' { Invoke-Archive $projectRoot }
    'tasks' { Invoke-Tasks $projectRoot }
    'board' {
        $scan = $projectRoot
        if ([string]::IsNullOrWhiteSpace($Root)) { $scan = Split-Path -Parent $projectRoot }
        Invoke-Board $scan
    }
    'doctor' { Invoke-Doctor $projectRoot }
}

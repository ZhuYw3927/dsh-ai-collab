param(
    [string]$Root = '<project-root>',        # 套用到新项目时改为实际项目根
    [string]$Spec = '<project-root>\.ai\changelog\patches\patch_spec.txt',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$gbk = [System.Text.Encoding]::GetEncoding(936)
$utf8Out = New-Object System.Text.UTF8Encoding($false)

# ---------- parse spec ----------
$specLines = [System.IO.File]::ReadAllLines($Spec, $utf8Out)
$patches = New-Object System.Collections.ArrayList
$i = 0
while ($i -lt $specLines.Count) {
    $line = $specLines[$i]
    if ($line.StartsWith('@@FILE ')) {
        $rel = $line.Substring(7).Trim()
        $i++
        $op = $specLines[$i]
        if ($op.StartsWith('@@OP RANGE ')) {
            $parts = $op -split '\s+'
            $start = [int]$parts[2]
            $end = [int]$parts[3]
            $i++
            $block = New-Object System.Collections.ArrayList
            while ($i -lt $specLines.Count -and $specLines[$i] -ne '@@END') {
                [void]$block.Add($specLines[$i]); $i++
            }
            $i++
            [void]$patches.Add([pscustomobject]@{ Rel = $rel; Op = 'RANGE'; Start = $start; End = $end; Lines = $block })
        }
        elseif ($op -eq '@@OP TEXT') {
            $i++
            $old = $specLines[$i].Substring(6); $i++
            $new = $specLines[$i].Substring(6); $i++
            while ($i -lt $specLines.Count -and $specLines[$i] -ne '@@END') { $i++ }
            $i++
            [void]$patches.Add([pscustomobject]@{ Rel = $rel; Op = 'TEXT'; Old = $old; New = $new })
        }
        else {
            throw "unknown op at line $i : $op"
        }
    }
    else {
        $i++
    }
}

"parsed patches = $($patches.Count)"
$backupRoot = Join-Path $Root '.tmp_backup'

# ---------- apply ----------
$fail = 0
foreach ($group in ($patches | Group-Object Rel)) {
    $rel = $group.Name
    $path = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $path)) { "MISSING FILE: $rel"; $fail++; continue }

    $bytes = [System.IO.File]::ReadAllBytes($path)
    $encName = 'utf8'
    try { $text = $utf8Strict.GetString($bytes) }
    catch { $text = $gbk.GetString($bytes); $encName = 'gbk' }

    $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = $text -split "`r`n|`n"

    # backup once
    $bk = Join-Path $backupRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $bk)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $bk) | Out-Null
        [System.IO.File]::WriteAllBytes($bk, $bytes)
    }

    # range patches first, from bottom to top
    $ranges = $group.Group | Where-Object { $_.Op -eq 'RANGE' } | Sort-Object Start -Descending
    foreach ($p in $ranges) {
        if ($p.Start -lt 1 -or $p.End -gt $lines.Count) {
            "RANGE OUT OF BOUNDS: $rel $($p.Start)-$($p.End) (lines=$($lines.Count))"; $fail++; continue
        }
        $before = $p.Start - 1
        $after = $lines.Count - $p.End
        $newLines = @()
        if ($before -gt 0) { $newLines += $lines[0..($before - 1)] }
        $newLines += $p.Lines
        if ($after -gt 0) { $newLines += $lines[($p.End)..($lines.Count - 1)] }
        $lines = $newLines
        "RANGE  ok  $rel  [$($p.Start)-$($p.End)] -> $($p.Lines.Count) line(s)"
    }

    # text patches
    foreach ($p in ($group.Group | Where-Object { $_.Op -eq 'TEXT' })) {
        $joined = $lines -join $eol
        $cnt = ([regex]::Matches($joined, [regex]::Escape($p.Old))).Count
        if ($cnt -ne 1) {
            "TEXT   FAIL $rel  (matches=$cnt)  <<$($p.Old)>>"; $fail++; continue
        }
        $joined = $joined.Replace($p.Old, $p.New)
        $lines = $joined -split "`r`n|`n"
        "TEXT   ok  $rel  <<$($p.Old)>>"
    }

    if (-not $DryRun) {
        $outText = $lines -join $eol
        if ($encName -eq 'gbk') { $outBytes = $gbk.GetBytes($outText) }
        else { $outBytes = $utf8Out.GetBytes($outText) }
        [System.IO.File]::WriteAllBytes($path, $outBytes)
        "WRITE  $rel  ($encName)"
    }
}

"---- failures = $fail ----"

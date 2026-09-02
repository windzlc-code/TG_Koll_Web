param(
    [string]$Repository = ""
)

$ErrorActionPreference = "Stop"

if (-not $Repository) {
    $Repository = (git rev-parse --show-toplevel 2>$null)
}
if (-not $Repository) {
    throw "Run this script inside a Git repository or pass -Repository."
}

$primary = (Resolve-Path -LiteralPath $Repository).Path
$originMain = (git -C $primary rev-parse --verify origin/main 2>$null)
$lines = @(git -C $primary worktree list --porcelain)
$entries = @()
$current = $null

foreach ($line in $lines) {
    if ($line -like "worktree *") {
        if ($current) { $entries += [pscustomobject]$current }
        $current = [ordered]@{
            Path = $line.Substring(9).Replace("/", "\")
            Head = ""
            Branch = ""
            Detached = $false
        }
    } elseif ($line -like "HEAD *") {
        $current.Head = $line.Substring(5)
    } elseif ($line -like "branch *") {
        $current.Branch = $line.Substring(7)
    } elseif ($line -eq "detached") {
        $current.Detached = $true
    }
}
if ($current) { $entries += [pscustomobject]$current }

$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine)
$results = foreach ($entry in $entries) {
    $exists = Test-Path -LiteralPath $entry.Path
    $resolved = if ($exists) { (Resolve-Path -LiteralPath $entry.Path).Path } else { $entry.Path }
    $status = if ($exists) { @(git -C $resolved status --porcelain=v1 2>$null) } else { @() }
    $activeProcesses = @($processes | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($resolved, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })

    $sharedLinks = @()
    if ($exists -and $resolved -ne $primary) {
        foreach ($relative in @("tool_r18\node_modules", "node_modules", "data", "uploads", "media")) {
            $candidate = Join-Path $resolved $relative
            if (-not (Test-Path -LiteralPath $candidate)) { continue }
            $item = Get-Item -LiteralPath $candidate -Force
            if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
            $target = ($item.Target -join "")
            if ($target -and $target.IndexOf($primary, [StringComparison]::OrdinalIgnoreCase) -eq 0) {
                $sharedLinks += "$relative -> $target"
            }
        }
    }

    $merged = $false
    if ($originMain -and $entry.Head) {
        git -C $primary merge-base --is-ancestor $entry.Head origin/main 2>$null
        $merged = $LASTEXITCODE -eq 0
    }

    $reasons = @()
    if ($resolved -eq $primary) { $reasons += "primary worktree" }
    if (-not $exists) { $reasons += "path missing" }
    if ($status.Count) { $reasons += "uncommitted changes" }
    if ($activeProcesses.Count) { $reasons += "referenced by running process" }
    if ($sharedLinks.Count) { $reasons += "shares protected paths with primary" }
    if ($entry.Detached -and -not $merged) { $reasons += "unmerged detached commit" }

    [pscustomobject]@{
        Path = $resolved
        Branch = $entry.Branch
        Head = $entry.Head
        Dirty = [bool]$status.Count
        MergedIntoOriginMain = $merged
        ActiveProcessCount = $activeProcesses.Count
        SharedPrimaryLinks = ($sharedLinks -join "; ")
        RemovalBlocked = [bool]$reasons.Count
        BlockReasons = ($reasons -join "; ")
    }
}

$results | Format-Table -AutoSize
Write-Host ""
Write-Host "Read-only audit complete. This script never removes worktrees."

if ($results | Where-Object { $_.Path -ne $primary -and $_.RemovalBlocked }) {
    exit 2
}

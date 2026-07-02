param(
  [switch]$Apply,
  [switch]$IncludeTypeScriptServers,
  [switch]$IncludePlaywrightBrowsers,
  [int]$MinAgeMinutes = 10
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Now = Get-Date

$ProtectedPatterns = @(
  [regex]::Escape("$ProjectRoot"),
  [regex]::Escape("D:\GitHub\貝伯盈craw\server\bootstrap.js"),
  "src[/\\]daemon\.ts",
  "scripts[/\\]start-daemon-detached\.ps1"
)

$ToolPatterns = @(
  "chrome-devtools-mcp",
  "@playwright[/\\]mcp",
  "exa-mcp-server",
  "@upstash[/\\]context7-mcp"
)

if ($IncludeTypeScriptServers) {
  $ToolPatterns += @(
    "typescript-language-server",
    "tsserver\.js",
    "typingsInstaller\.js"
  )
}

function Get-ProcessMap {
  $map = @{}
  Get-CimInstance Win32_Process | ForEach-Object {
    $map[[int]$_.ProcessId] = $_
  }
  return $map
}

function Test-MatchesAny {
  param(
    [string]$Text,
    [string[]]$Patterns
  )
  foreach ($pattern in $Patterns) {
    if ($Text -match $pattern) { return $true }
  }
  return $false
}

function Get-ProcessAgeMinutes {
  param([System.Diagnostics.Process]$Process)
  try {
    return [math]::Round(($Now - $Process.StartTime).TotalMinutes, 1)
  } catch {
    return $null
  }
}

$processMap = Get-ProcessMap
$candidates = New-Object System.Collections.Generic.List[object]

foreach ($procInfo in $processMap.Values) {
  $cmd = [string]$procInfo.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) { continue }

  $name = [string]$procInfo.Name
  $isTool = Test-MatchesAny -Text $cmd -Patterns $ToolPatterns
  if (-not $isTool) { continue }

  $isProtected = Test-MatchesAny -Text $cmd -Patterns $ProtectedPatterns
  if ($isProtected) { continue }

  $process = Get-Process -Id $procInfo.ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { continue }

  $age = Get-ProcessAgeMinutes -Process $process
  if ($null -ne $age -and $age -lt $MinAgeMinutes) { continue }

  $parent = $null
  if ($processMap.ContainsKey([int]$procInfo.ParentProcessId)) {
    $parent = $processMap[[int]$procInfo.ParentProcessId]
  }

  $candidates.Add([pscustomobject]@{
    Pid = [int]$procInfo.ProcessId
    Name = $name
    ParentPid = [int]$procInfo.ParentProcessId
    ParentName = if ($parent) { $parent.Name } else { "" }
    AgeMinutes = $age
    WS_MB = [math]::Round($process.WorkingSet64 / 1MB, 1)
    PM_MB = [math]::Round($process.PagedMemorySize64 / 1MB, 1)
    CommandLine = ($cmd -replace "\s+", " ")
  })
}

if ($IncludePlaywrightBrowsers) {
  foreach ($procInfo in $processMap.Values) {
    $cmd = [string]$procInfo.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    if ($cmd -notmatch [regex]::Escape("D:\DevCache\playwright")) { continue }
    if ($cmd -notmatch "chrome\.exe|msedge\.exe|msedgewebview2\.exe") { continue }

    $process = Get-Process -Id $procInfo.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $age = Get-ProcessAgeMinutes -Process $process
    if ($null -ne $age -and $age -lt $MinAgeMinutes) { continue }

    $parent = $null
    if ($processMap.ContainsKey([int]$procInfo.ParentProcessId)) {
      $parent = $processMap[[int]$procInfo.ParentProcessId]
    }

    if (-not ($candidates | Where-Object { $_.Pid -eq [int]$procInfo.ProcessId })) {
      $candidates.Add([pscustomobject]@{
        Pid = [int]$procInfo.ProcessId
        Name = [string]$procInfo.Name
        ParentPid = [int]$procInfo.ParentProcessId
        ParentName = if ($parent) { $parent.Name } else { "" }
        AgeMinutes = $age
        WS_MB = [math]::Round($process.WorkingSet64 / 1MB, 1)
        PM_MB = [math]::Round($process.PagedMemorySize64 / 1MB, 1)
        CommandLine = ($cmd -replace "\s+", " ")
      })
    }
  }
}

$targets = @($candidates | Sort-Object WS_MB -Descending)
$totalMb = [math]::Round((($targets | Measure-Object WS_MB -Sum).Sum), 1)

Write-Output "Automatic-script tool residue cleanup"
Write-Output "ProjectRoot: $ProjectRoot"
Write-Output "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY-RUN' })"
Write-Output "MinAgeMinutes: $MinAgeMinutes"
Write-Output "IncludeTypeScriptServers: $IncludeTypeScriptServers"
Write-Output "IncludePlaywrightBrowsers: $IncludePlaywrightBrowsers"
Write-Output "Targets: $($targets.Count), ApproxWorkingSetMB: $totalMb"
Write-Output ""

if ($targets.Count -eq 0) {
  Write-Output "No matching tool residue processes found."
  exit 0
}

$targets | Select-Object Pid,Name,ParentPid,ParentName,AgeMinutes,WS_MB,PM_MB,CommandLine | Format-Table -AutoSize -Wrap

if (-not $Apply) {
  Write-Output ""
  Write-Output "Dry-run only. Re-run with -Apply to stop these tool residue processes."
  exit 0
}

Write-Output ""
Write-Output "Stopping matching tool residue processes..."
foreach ($target in $targets) {
  try {
    Stop-Process -Id $target.Pid -Force -ErrorAction Stop
    Write-Output "stopped pid=$($target.Pid) name=$($target.Name)"
  } catch {
    Write-Output "failed pid=$($target.Pid) name=$($target.Name) error=$($_.Exception.Message)"
  }
}


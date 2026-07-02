param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $ProjectRoot
$RuntimeDir = Join-Path $ProjectRoot ".runtime\automatic-script"
$LogDir = Join-Path $RuntimeDir "logs"
$LockFile = Join-Path $RuntimeDir "telegram_bot.lock"
$HeartbeatFile = Join-Path $RuntimeDir "daemon.heartbeat.json"
$LogFile = Join-Path $LogDir "daemon.log"
$ErrorLogFile = Join-Path $LogDir "daemon.error.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$EnvFile = Join-Path $ProjectRoot ".runtime\local-bot.env"
if (Test-Path -LiteralPath $EnvFile) {
  foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $eq = $trimmed.IndexOf("=")
    if ($eq -le 0) { continue }
    $key = $trimmed.Substring(0, $eq).Trim()
    $value = $trimmed.Substring($eq + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

$UploadHostDir = Join-Path $RepoRoot "webapp_data\tool_r18_uploads"
$UploadContainerDir = $UploadHostDir.Replace("\", "/")
New-Item -ItemType Directory -Force -Path $UploadHostDir | Out-Null

if (-not $env:TOOL_R18_PROJECT_ROOT) { $env:TOOL_R18_PROJECT_ROOT = $ProjectRoot }
if (-not $env:AUTO_TWEET_PROJECT_ROOT) { $env:AUTO_TWEET_PROJECT_ROOT = $ProjectRoot }
if (-not $env:TOOL_R18_RUNTIME_DIR) { $env:TOOL_R18_RUNTIME_DIR = $RuntimeDir }
if (-not $env:AUTO_TWEET_RUNTIME_DIR) { $env:AUTO_TWEET_RUNTIME_DIR = $RuntimeDir }
if (-not $env:TOOL_R18_UPLOAD_HOST_DIR) { $env:TOOL_R18_UPLOAD_HOST_DIR = $UploadHostDir }
if (-not $env:TOOL_R18_UPLOAD_CONTAINER_DIR) { $env:TOOL_R18_UPLOAD_CONTAINER_DIR = $UploadContainerDir }
if (-not $env:TOOL_R18_PUBLIC_URL) { $env:TOOL_R18_PUBLIC_URL = "http://43.167.237.120" }

function Start-PublicUploadTunnel {
  if (-not $env:REVERSE_TUNNEL_SSH_HOST) { $env:REVERSE_TUNNEL_SSH_HOST = "43.167.237.120" }
  if (-not $env:REVERSE_TUNNEL_SSH_USER) { $env:REVERSE_TUNNEL_SSH_USER = "ubuntu" }
  if (-not $env:REVERSE_TUNNEL_REMOTE_HOST) { $env:REVERSE_TUNNEL_REMOTE_HOST = "0.0.0.0" }
  if (-not $env:REVERSE_TUNNEL_REMOTE_PORT) { $env:REVERSE_TUNNEL_REMOTE_PORT = "19198" }
  if (-not $env:REVERSE_TUNNEL_LOCAL_HOST) { $env:REVERSE_TUNNEL_LOCAL_HOST = "127.0.0.1" }
  if (-not $env:REVERSE_TUNNEL_LOCAL_PORT) { $env:REVERSE_TUNNEL_LOCAL_PORT = "8098" }
  if (-not $env:REVERSE_TUNNEL_SSH_KEY) {
    $defaultKey = Join-Path $env:USERPROFILE ".ssh\tx_key.pem"
    if (Test-Path -LiteralPath $defaultKey) { $env:REVERSE_TUNNEL_SSH_KEY = $defaultKey }
  }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "python*.exe" -and $_.CommandLine -like "*local_reverse_http_tunnel.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -ieq "ssh.exe" -and $_.CommandLine -like "*$($env:REVERSE_TUNNEL_REMOTE_PORT):$($env:REVERSE_TUNNEL_LOCAL_HOST):$($env:REVERSE_TUNNEL_LOCAL_PORT)*"
    } |
    Select-Object -First 1
  if ($existing) { return }

  $tunnelLogDir = Join-Path $RepoRoot ".runtime\public-upload-tunnel"
  New-Item -ItemType Directory -Force -Path $tunnelLogDir | Out-Null
  $tunnelOut = Join-Path $tunnelLogDir "reverse-19198.out.log"
  $tunnelErr = Join-Path $tunnelLogDir "reverse-19198.err.log"
  $sshExe = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
  if ($sshExe) {
    $sshArgs = @(
      "-N",
      "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=accept-new"
    )
    if (-not [string]::IsNullOrWhiteSpace($env:REVERSE_TUNNEL_SSH_KEY) -and (Test-Path -LiteralPath $env:REVERSE_TUNNEL_SSH_KEY)) {
      $sshArgs += @("-i", $env:REVERSE_TUNNEL_SSH_KEY)
    }
    $sshArgs += @(
      "-R", "$($env:REVERSE_TUNNEL_REMOTE_HOST):$($env:REVERSE_TUNNEL_REMOTE_PORT):$($env:REVERSE_TUNNEL_LOCAL_HOST):$($env:REVERSE_TUNNEL_LOCAL_PORT)",
      "$($env:REVERSE_TUNNEL_SSH_USER)@$($env:REVERSE_TUNNEL_SSH_HOST)"
    )
    Start-Process -FilePath $sshExe `
      -ArgumentList $sshArgs `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $tunnelOut `
      -RedirectStandardError $tunnelErr | Out-Null
    return
  }

  if ([string]::IsNullOrWhiteSpace($env:REVERSE_TUNNEL_SSH_PASSWORD)) { return }
  $tunnelScript = Join-Path $RepoRoot "scripts\local_reverse_http_tunnel.py"
  if (-not (Test-Path -LiteralPath $tunnelScript)) { return }
  $pythonExe = Join-Path $RepoRoot ".venv-codex-run\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $pythonExe)) { $pythonExe = "python" }
  Start-Process -FilePath $pythonExe `
    -ArgumentList @("scripts\local_reverse_http_tunnel.py") `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelOut `
    -RedirectStandardError $tunnelErr | Out-Null
}

Start-PublicUploadTunnel

function Stop-ExistingDaemon {
  $pids = @()
  if (Test-Path $LockFile) {
    $raw = (Get-Content $LockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($raw -match '^\d+$') { $pids += [int]$raw }
  }
  if (Test-Path $HeartbeatFile) {
    try {
      $heartbeat = Get-Content $HeartbeatFile -Raw | ConvertFrom-Json
      if ($heartbeat.pid) { $pids += [int]$heartbeat.pid }
    } catch {}
  }
  $pids = @($pids | Sort-Object -Unique)
  foreach ($pidValue in $pids) {
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
      try { Wait-Process -Id $pidValue -Timeout 5 -ErrorAction SilentlyContinue } catch {}
      try {
        Add-Content -Path $LogFile -Value "$(Get-Date -Format o) stopped existing daemon pid=$pidValue" -ErrorAction SilentlyContinue
      } catch {}
    }
  }
  if ($pids.Count -gt 0) {
    Remove-Item $HeartbeatFile -Force -ErrorAction SilentlyContinue
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
  }
}

if ($Restart) {
  Stop-ExistingDaemon
  # Stop-ExistingDaemon 已删除 heartbeat/lock，直接启动新实例
} else {
  # 非 restart 模式：检查是否已有实例在运行
  $existingPid = $null
  if (Test-Path $HeartbeatFile) {
    try {
      $heartbeat = Get-Content $HeartbeatFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
      if ($heartbeat.pid -and (Get-Process -Id ([int]$heartbeat.pid) -ErrorAction SilentlyContinue)) {
        $existingPid = [int]$heartbeat.pid
      }
    } catch {}
  }
  if ($existingPid) {
    Write-Output "daemon already running pid=$existingPid"
    exit 0
  }
}

$nodeArgs = @("--import", "tsx", "src/daemon.ts")
function Test-LocalProxyUrl {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url) -or $Url -eq "direct") { return $true }
  if ($Url -match '^https?://127\.0\.0\.1:(\d+)') {
    $port = [int]$Matches[1]
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
  }
  return $true
}
if (-not (Test-LocalProxyUrl $env:TELEGRAM_PROXY_URL)) {
  $env:TELEGRAM_PROXY_URL = ""
}
if ([string]::IsNullOrWhiteSpace($env:TELEGRAM_PROXY_URL)) {
  $systemProxy = Get-NetTCPConnection -LocalPort 7890 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $env:TELEGRAM_PROXY_URL = if ($systemProxy) { "http://127.0.0.1:7890" } else { "direct" }
}
$proc = Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLogFile -PassThru
Write-Output "started daemon pid=$($proc.Id) log=$LogFile errorLog=$ErrorLogFile"

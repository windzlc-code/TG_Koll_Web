param(
  [string]$EnvFile = "",
  [string]$BackendBaseUrl = "",
  [switch]$SkipBackendCheck
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot = Resolve-Path (Join-Path $ProjectRoot "..")

if (-not $EnvFile.Trim()) {
  $EnvFile = Join-Path $ProjectRoot ".runtime\local-bot.env"
}

$ExampleFile = Join-Path $ScriptDir "local-bot.env.example"
if (-not (Test-Path -LiteralPath $EnvFile)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $EnvFile) -Force | Out-Null
  Copy-Item -LiteralPath $ExampleFile -Destination $EnvFile
  Write-Host "Created local env file:"
  Write-Host "  $EnvFile"
  Write-Host ""
  Write-Host "Fill TELEGRAM_BOT_TOKEN in that file, then run this script again."
  exit 1
}

function Set-EnvFromFile {
  param([string]$Path)

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
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

Set-EnvFromFile -Path $EnvFile

if ($BackendBaseUrl.Trim()) {
  $env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL = $BackendBaseUrl.TrimEnd("/")
}

$RuntimeDir = Join-Path $ProjectRoot ".runtime\automatic-script"
$UploadHostDir = Join-Path $RepoRoot "webapp_data\tool_r18_uploads"
$UploadContainerDir = $UploadHostDir.Replace("\", "/")

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $UploadHostDir -Force | Out-Null

$env:TOOL_R18_PROJECT_ROOT = $ProjectRoot
$env:AUTO_TWEET_PROJECT_ROOT = $ProjectRoot
$env:TOOL_R18_RUNTIME_DIR = $RuntimeDir
$env:AUTO_TWEET_RUNTIME_DIR = $RuntimeDir
$env:TOOL_R18_UPLOAD_HOST_DIR = $UploadHostDir
$env:TOOL_R18_UPLOAD_CONTAINER_DIR = $UploadContainerDir
$env:TELEGRAM_BOT_DISABLED = "0"
if (-not $env:TELEGRAM_INSTANCE_TAG) { $env:TELEGRAM_INSTANCE_TAG = "Tool_R18_LOCAL" }
if (-not $env:TELEGRAM_WEBHOOK_PORT) { $env:TELEGRAM_WEBHOOK_PORT = "18789" }
if (-not $env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL) { $env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL = "http://127.0.0.1:8098" }
if (-not $env:TELEGRAM_PROXY_URL) {
  $systemProxy = Get-NetTCPConnection -LocalPort 7890 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $env:TELEGRAM_PROXY_URL = if ($systemProxy) { "http://127.0.0.1:7890" } else { "direct" }
}

$TokenFile = Join-Path $RuntimeDir "telegram_bot_token.txt"
if ((-not $env:TELEGRAM_BOT_TOKEN -or -not $env:TELEGRAM_BOT_TOKEN.Trim()) -and (Test-Path -LiteralPath $TokenFile)) {
  $env:TELEGRAM_BOT_TOKEN = (Get-Content -LiteralPath $TokenFile -Raw -Encoding UTF8).Trim()
}
if (-not $env:TELEGRAM_BOT_TOKEN -or -not $env:TELEGRAM_BOT_TOKEN.Trim()) {
  throw "TELEGRAM_BOT_TOKEN is empty. Edit $EnvFile first or save Bot Token in the admin runtime page."
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
  Write-Host "node_modules is missing. Run first:"
  Write-Host "  cd $ProjectRoot"
  Write-Host "  npm ci"
  exit 1
}

if (-not $SkipBackendCheck) {
  try {
    $healthUrl = $env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL.TrimEnd("/") + "/api/internal/tg/runtime_config"
    Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5 | Out-Null
  } catch {
    Write-Host "Warning: backend is not reachable at $($env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL)."
    Write-Host "The bot can start, but Tool_R18 task submission/status buttons need the backend."
    Write-Host "Start the local backend first, or pass -BackendBaseUrl to another reachable backend."
    Write-Host ""
  }
}

Write-Host "Starting local Tool_R18 bot"
Write-Host "  Project: $ProjectRoot"
Write-Host "  Runtime: $RuntimeDir"
Write-Host "  Backend: $($env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL)"
Write-Host "  Uploads: $UploadHostDir"
Write-Host ""

Push-Location $ProjectRoot
try {
  npm start
} finally {
  Pop-Location
}

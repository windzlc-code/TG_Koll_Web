$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = "Workflow Delivery Package 便攜啟動器" } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$WebappDataDir = Join-Path $Root "webapp_data"
$WebappRuntimeFile = Join-Path $WebappDataDir "runtime_config.json"
$TokenDir = Join-Path $Root "tool_r18\.runtime\automatic-script"
$TokenFile = Join-Path $TokenDir "telegram_bot_token.txt"
$BotsFile = Join-Path $TokenDir "telegram_bots.local.json"
$InfoFile = Join-Path $TokenDir "telegram_bot_info.json"
$ToolApiConfigFile = Join-Path $TokenDir "api_config.json"
$LogDir = Join-Path $Root "portable_logs"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:WebBackendBaseUrl = ""
$script:ProcessJob = [IntPtr]::Zero
$script:ManagedProcessIds = @{}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PortableJobNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
}
"@

function Resolve-FirstExistingPath {
  param([string[]]$Candidates, [string]$Label)
  foreach ($path in $Candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }
  throw "找不到 $Label。已檢查：" + ($Candidates -join "；")
}
function Get-PortablePython {
  Resolve-FirstExistingPath -Label "Python 執行檔" -Candidates @(
    (Join-Path $Root "portable_runtime\python\python.exe"),
    (Join-Path $Root "portable_runtime\python\Scripts\python.exe"),
    (Join-Path $Root ".venv-codex-run\Scripts\python.exe")
  )
}

function Get-PortableNode {
  Resolve-FirstExistingPath -Label "Node.js 執行檔" -Candidates @(
    (Join-Path $Root "portable_runtime\node\node.exe"),
    (Join-Path $Root "portable_runtime\node\bin\node.exe")
  )
}

function Get-ProcessCommandLineText {
  param([Parameter(Mandatory = $true)]$Process)
  return [string]($Process.CommandLine -replace "`r|`n", " ")
}

function Find-WebBackendProcesses {
  $escapedRoot = [Regex]::Escape($Root)
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.Name -match "^pythonw?\.exe$" -and
      (Get-ProcessCommandLineText $_) -match $escapedRoot -and
      (Get-ProcessCommandLineText $_) -match "uvicorn\s+webapp\.server:app"
    }
}

function Find-WebBackendProcess {
  Find-WebBackendProcesses | Select-Object -First 1
}

function Find-ToolR18Processes {
  $escapedRoot = [Regex]::Escape($Root)
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.Name -eq "node.exe" -and
      (Get-ProcessCommandLineText $_) -match $escapedRoot -and
      (Get-ProcessCommandLineText $_) -match "src/daemon\.ts"
    }
}

function Find-ToolR18Process {
  Find-ToolR18Processes | Select-Object -First 1
}

function Get-PortFromCommandLine {
  param([string]$CommandLine)
  if ($CommandLine -match "--port\s+(\d+)") {
    return [int]$Matches[1]
  }
  return $null
}

function Get-LogTail {
  param([string]$Path, [int]$Lines = 40)
  if (Test-Path -LiteralPath $Path) {
    return (Get-Content -LiteralPath $Path -Tail $Lines -Encoding UTF8) -join "`n"
  }
  return ""
}

function Mask-Secret {
  param([string]$Value)
  $text = String-Trim $Value
  if (-not $text) { return "尚未設定" }
  if ($text.Length -le 10) { return "***" }
  return $text.Substring(0, 4) + "***" + $text.Substring($text.Length - 4)
}

function String-Trim {
  param($Value)
  if ($null -eq $Value) { return "" }
  return [string]$Value -replace "^\s+|\s+$", ""
}

function First-NonEmpty {
  param([object[]]$Values)
  foreach ($value in $Values) {
    $text = String-Trim $value
    if ($text) { return $text }
  }
  return ""
}

function Write-Utf8NoBomFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Read-JsonObject {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{} }
  try {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if (-not (String-Trim $text)) { return [pscustomobject]@{} }
    return $text | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{}
  }
}

function Set-JsonProperty {
  param($Object, [string]$Name, $Value)
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Save-JsonObject {
  param([string]$Path, $Object, [int]$Depth = 20)
  Write-Utf8NoBomFile -Path $Path -Content ($Object | ConvertTo-Json -Depth $Depth)
}

function Initialize-ProcessJob {
  if ($script:ProcessJob -ne [IntPtr]::Zero) { return }
  $job = [PortableJobNative]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw "無法建立進程管理 Job。Windows 錯誤碼：" + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  $info = New-Object PortableJobNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $info.BasicLimitInformation.LimitFlags = 0x2000
  $length = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($length)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($info, $buffer, $false)
    $ok = [PortableJobNative]::SetInformationJobObject($job, 9, $buffer, [uint32]$length)
    if (-not $ok) { throw "無法設定進程管理 Job。Windows 錯誤碼：" + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $script:ProcessJob = $job
}

function Add-ManagedProcess {
  param([Parameter(Mandatory = $true)]$Process, [Parameter(Mandatory = $true)][string]$Label)
  Initialize-ProcessJob
  $ok = [PortableJobNative]::AssignProcessToJobObject($script:ProcessJob, $Process.Handle)
  if (-not $ok) { throw "無法把 $Label 加入啟動器進程管理。Windows 錯誤碼：" + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  $script:ManagedProcessIds[[int]$Process.Id] = $Label
}

function Test-ManagedProcess {
  param($Process)
  if (-not $Process) { return $false }
  return $script:ManagedProcessIds.ContainsKey([int]$Process.ProcessId)
}

function Test-PortFree {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(200, $false)) {
      $client.EndConnect($iar)
      return $false
    }
    return $true
  } catch {
    return $true
  } finally {
    $client.Close()
  }
}

function Get-FreePort {
  param([int]$StartPort, [int]$EndPort)
  foreach ($port in $StartPort..$EndPort) {
    if (Test-PortFree -Port $port) { return $port }
  }
  throw "找不到可用的本地連接埠，範圍：$StartPort-$EndPort。"
}

function Wait-HttpReady {
  param([string]$Url, [int]$TimeoutSeconds = 45)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) { return }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Web 後台未能在指定時間內啟動。最後錯誤：$lastError"
}

function Get-SavedBotInfoText {
  if (Test-Path -LiteralPath $InfoFile) {
    try {
      $savedInfo = Get-Content -LiteralPath $InfoFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $parts = @()
      if ($savedInfo.username) { $parts += ("@" + $savedInfo.username) }
      if ($savedInfo.first_name) { $parts += ("名稱：" + $savedInfo.first_name) }
      if ($savedInfo.id) { $parts += ("ID：" + $savedInfo.id) }
      if ($parts.Count -gt 0) { return ($parts -join "，") }
    } catch {
      return "已保存 Token，但 Bot 資訊檔無法讀取"
    }
  }
  if (Test-Path -LiteralPath $TokenFile) {
    $existing = (Get-Content -LiteralPath $TokenFile -Raw -Encoding UTF8).Trim()
    if ($existing) { return "已保存 Token" }
  }
  return "尚未設定"
}

function Get-SavedGrokInfoText {
  $cfg = Read-JsonObject -Path $WebappRuntimeFile
  $key = First-NonEmpty @($cfg.llm_api_key_gpt, $cfg.llm_api_key)
  $models = First-NonEmpty @($cfg.llm_model_priority_order, $cfg.llm_default_model_gpt, $cfg.llm_default_model)
  $baseUrl = String-Trim ($cfg.llm_base_url)
  if (-not $key) { return "尚未設定" }
  if (-not $models) { $models = "" }
  if (-not $baseUrl) { $baseUrl = "未設定" }
  return "模型：" + $models + "，Base URL：" + $baseUrl + "，Key：" + (Mask-Secret $key)
}

function Configure-TelegramBot {
  param([bool]$Force = $false)
  New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null
  New-Item -ItemType Directory -Force -Path $WebappDataDir | Out-Null

  Write-Host ""
  Write-Host "============================================================"
  Write-Host "Telegram Bot 連線設定"
  Write-Host "============================================================"
  Write-Host "請貼上 BotFather 給你的 Telegram Bot Token。"
  Write-Host "格式範例：1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  Write-Host "首次打開便攜包時必須重新輸入 Token；本工具會驗證並顯示 Bot 詳細資訊。"
  Write-Host ""

  if ((-not $Force) -and (Test-Path -LiteralPath $TokenFile)) {
    $existing = (Get-Content -LiteralPath $TokenFile -Raw -Encoding UTF8).Trim()
    if ($existing) {
      Write-Host "已偵測到已保存的 Bot Token，本次自動沿用。"
      Write-Host ("目前保存的 Bot：" + (Get-SavedBotInfoText))
      Write-Host "如需更換 Token，請回到主選單選擇「更換 Telegram Bot Token」。"
      return
    }
  }

  if ($Force) {
    Stop-ToolR18 -Quiet $true
    foreach ($path in @($TokenFile, $BotsFile, $InfoFile)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    Write-Host "已清除舊 Token 設定，請輸入新的 Telegram Bot Token。"
  }

  $token = (Read-Host "請貼上 Telegram Bot Token 後按 Enter").Trim()
  if (-not $token) { throw "未輸入 Telegram Bot Token。" }

  Write-Host ""
  Write-Host "正在驗證 Telegram Bot Token..."
  $response = Invoke-RestMethod -Uri ("https://api.telegram.org/bot{0}/getMe" -f $token) -TimeoutSec 30
  if (-not $response.ok) { throw "Telegram getMe 回傳 ok=false。" }

  Write-Utf8NoBomFile -Path $TokenFile -Content ($token + "`r`n")
  Save-JsonObject -Path $BotsFile -Object @{
    bots = @(@{
      token = $token
      name = "primary"
      defaultPublishPlatform = "threads"
      defaultWarmupPlatform = "threads"
    })
  } -Depth 8
  Save-JsonObject -Path $InfoFile -Object $response.result -Depth 8

  $runtimeConfig = Read-JsonObject -Path $WebappRuntimeFile
  Set-JsonProperty -Object $runtimeConfig -Name "telegram_bot_token" -Value $token
  Save-JsonObject -Path $WebappRuntimeFile -Object $runtimeConfig

  Write-Host ""
  Write-Host "Telegram Bot 連線成功。"
  Write-Host "------------------------------------------------------------"
  Write-Host "Bot 詳細資訊"
  Write-Host ("Bot ID：" + $response.result.id)
  Write-Host ("使用者名稱：@" + $response.result.username)
  Write-Host ("Bot 名稱：" + $response.result.first_name)
  Write-Host ("是否 Bot：" + $response.result.is_bot)
  if ($null -ne $response.result.can_join_groups) { Write-Host ("可加入群組：" + $response.result.can_join_groups) }
  if ($null -ne $response.result.can_read_all_group_messages) { Write-Host ("可讀取群組所有訊息：" + $response.result.can_read_all_group_messages) }
  if ($null -ne $response.result.supports_inline_queries) { Write-Host ("支援 Inline Query：" + $response.result.supports_inline_queries) }
  Write-Host ("Token 掩碼：" + (Mask-Secret $token))
  Write-Host "------------------------------------------------------------"
}

function Configure-GrokTextModel {
  param([bool]$Force = $false)
  New-Item -ItemType Directory -Force -Path $WebappDataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null

  $runtimeConfig = Read-JsonObject -Path $WebappRuntimeFile
  $currentKey = First-NonEmpty @($runtimeConfig.llm_api_key_gpt, $runtimeConfig.llm_api_key)
  $currentBaseUrl = String-Trim ($runtimeConfig.llm_base_url)
  $currentModels = First-NonEmpty @($runtimeConfig.llm_model_priority_order, $runtimeConfig.llm_default_model_gpt, $runtimeConfig.llm_default_model)

  Write-Host ""
  Write-Host "============================================================"
  Write-Host "Grok 文字模型 API 設定"
  Write-Host "============================================================"

  if ((-not $Force) -and $currentKey) {
    Write-Host ("已偵測到 Grok 文字模型設定：" + (Get-SavedGrokInfoText))
    Write-Host "如需更換，請回到主選單選擇「更換 Grok 文字模型 API/Key」。"
    return
  }

  $exampleBaseUrl = $currentBaseUrl
  if (-not $exampleBaseUrl) { $exampleBaseUrl = "https://llm.runninghub.ai/v1" }
  $defaultModels = $currentModels
  if (-not $defaultModels) { $defaultModels = "xai/grok-4.3" }

  if ($Force) {
    Write-Host "請輸入新的 Grok 文字模型 API 設定。"
  } else {
    Write-Host "首次使用需要設定 Grok 文字模型 API Key。"
  }
  Write-Host "首次打開便攜包時必須重新輸入 API Base URL 與 API Key。"
  Write-Host ("Grok API Base URL 範例：" + $exampleBaseUrl)
  Write-Host ("預設模型順序：" + $defaultModels)
  Write-Host ""

  $apiKey = (Read-Host "請貼上 Grok 文字模型 API Key 後按 Enter").Trim()
  if (-not $apiKey) { throw "未輸入 Grok 文字模型 API Key。" }
  $baseUrlInput = (Read-Host "請輸入 Grok API Base URL 後按 Enter").Trim()
  if (-not $baseUrlInput) { throw "未輸入 Grok API Base URL。" }
  $modelsInput = (Read-Host "請輸入 Grok 文字模型名稱/順序，直接 Enter 使用預設值").Trim()
  if (-not $modelsInput) { $modelsInput = $defaultModels }

  Set-JsonProperty -Object $runtimeConfig -Name "llm_base_url" -Value $baseUrlInput
  Set-JsonProperty -Object $runtimeConfig -Name "llm_api_key" -Value $apiKey
  Set-JsonProperty -Object $runtimeConfig -Name "llm_api_key_gpt" -Value $apiKey
  Set-JsonProperty -Object $runtimeConfig -Name "llm_api_key_gemini" -Value ""
  Set-JsonProperty -Object $runtimeConfig -Name "llm_default_model" -Value $modelsInput
  Set-JsonProperty -Object $runtimeConfig -Name "llm_default_model_gpt" -Value $modelsInput
  Set-JsonProperty -Object $runtimeConfig -Name "llm_default_model_gemini" -Value ""
  Set-JsonProperty -Object $runtimeConfig -Name "llm_model_priority_order" -Value $modelsInput
  Save-JsonObject -Path $WebappRuntimeFile -Object $runtimeConfig

  $apiConfig = Read-JsonObject -Path $ToolApiConfigFile
  Set-JsonProperty -Object $apiConfig -Name "gptKey" -Value $apiKey
  Set-JsonProperty -Object $apiConfig -Name "gptEndpoint" -Value $baseUrlInput
  Set-JsonProperty -Object $apiConfig -Name "geminiTextKey" -Value $apiKey
  Set-JsonProperty -Object $apiConfig -Name "geminiTextEndpoint" -Value $baseUrlInput
  if (-not $apiConfig.modelMappings) {
    Set-JsonProperty -Object $apiConfig -Name "modelMappings" -Value ([pscustomobject]@{})
  }
  $modelsInput.Split(",") | ForEach-Object {
    $model = $_.Trim()
    if ($model) {
      $apiConfig.modelMappings | Add-Member -NotePropertyName $model -NotePropertyValue ([pscustomobject]@{ modelId = $model; protocol = "openai" }) -Force
    }
  }
  Save-JsonObject -Path $ToolApiConfigFile -Object $apiConfig

  Write-Host ""
  Write-Host "Grok 文字模型 API 設定已保存並同步到後台。"
  Write-Host ("模型順序：" + $modelsInput)
  Write-Host ("Base URL：" + $baseUrlInput)
  Write-Host ("API Key：" + (Mask-Secret $apiKey))
}

function Start-WebBackend {
  param([bool]$OpenBrowser = $false)
  $Python = Get-PortablePython
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  New-Item -ItemType Directory -Force -Path $WebappDataDir | Out-Null

  $pythonDir = Split-Path -Parent $Python
  $env:PATH = $pythonDir + ";" + (Join-Path $pythonDir "Scripts") + ";" + $env:PATH
  $env:WORKFLOW_DESKTOP_DATA_DIR = $Root
  $env:WEBAPP_DATA_DIR = $WebappDataDir
  $env:APP_DB_PATH = Join-Path $WebappDataDir "app.db"
  $env:APP_RUNTIME_CONFIG_PATH = $WebappRuntimeFile

  $existing = Find-WebBackendProcess
  if ($existing) {
    if (Test-ManagedProcess -Process $existing) {
      $existingPort = Get-PortFromCommandLine -CommandLine (Get-ProcessCommandLineText $existing)
      if ($existingPort) {
        $url = "http://127.0.0.1:$existingPort/admin.html"
        $script:WebBackendBaseUrl = "http://127.0.0.1:$existingPort"
        Write-Host ""
        Write-Host ("Web 後台已在本啟動器中運行：" + $url)
        if ($OpenBrowser) { Start-Process $url }
        return
      }
    }
    Write-Host ""
    Write-Host "偵測到同目錄殘留的 Web 後台進程，正在清理後重新啟動。"
    Stop-WebBackend -Quiet $true
  }

  $port = Get-FreePort -StartPort 18098 -EndPort 18130
  $outLog = Join-Path $LogDir "web_backend.out.log"
  $errLog = Join-Path $LogDir "web_backend.err.log"
  $args = @("-m", "uvicorn", "webapp.server:app", "--host", "127.0.0.1", "--port", [string]$port, "--log-level", "warning")

  Write-Host ""
  Write-Host "正在啟動 Web 後台..."
  $process = Start-Process -FilePath $Python -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Add-ManagedProcess -Process $process -Label "Web 後台"
  $url = "http://127.0.0.1:$port/admin.html"
  Wait-HttpReady -Url $url -TimeoutSeconds 45
  $script:WebBackendBaseUrl = "http://127.0.0.1:$port"
  if ($OpenBrowser) { Start-Process $url }
  Write-Host ("Web 後台已啟動：" + $url)
  Write-Host ("Web 後台 PID：" + $process.Id)
}

function Open-WebBackendPage {
  Start-WebBackend -OpenBrowser $true
}

function Start-ToolR18 {
  $Node = Get-PortableNode
  $tsxPath = Join-Path $Root "tool_r18\node_modules\tsx\dist\cli.mjs"
  if (-not (Test-Path -LiteralPath $tsxPath)) { throw "找不到 Tool_R18 node_modules：$tsxPath" }

  Write-Host ""
  $existing = Find-ToolR18Process
  if ($existing) {
    if (Test-ManagedProcess -Process $existing) {
      Write-Host ("Tool_R18 Telegram Bot 已在本啟動器中運行，PID：" + $existing.ProcessId)
      return
    }
    Write-Host "偵測到同目錄殘留的 Tool_R18 Bot 進程，正在清理後重新啟動。"
    Stop-ToolR18 -Quiet $true
  }

  Write-Host "正在啟動 Tool_R18 Telegram Bot 後台..."
  $toolRoot = Join-Path $Root "tool_r18"
  $runtimeDir = Join-Path $toolRoot ".runtime\automatic-script"
  $nodeDir = Split-Path -Parent $Node
  $pythonPath = Get-PortablePython
  $pythonDir = Split-Path -Parent $pythonPath

  $env:PATH = $nodeDir + ";" + $pythonDir + ";" + (Join-Path $pythonDir "Scripts") + ";" + $env:PATH
  $env:TOOL_R18_RUNTIME_DIR = $runtimeDir
  $env:AUTO_TWEET_RUNTIME_DIR = $runtimeDir
  $env:AUTO_TWEET_API_CONFIG_PATH = $ToolApiConfigFile
  $webhookPort = Get-FreePort -StartPort 18788 -EndPort 18830
  $env:TELEGRAM_WEBHOOK_PORT = [string]$webhookPort
  $env:TELEGRAM_WEBHOOK_URL = "http://127.0.0.1:$webhookPort/telegram/webhook/auto-script-webhook-secret"
  if ($script:WebBackendBaseUrl) {
    $env:TOOL_R18_INTERNAL_WEBAPP_BASE_URL = $script:WebBackendBaseUrl
    $env:TG_INTERNAL_WEBAPP_BASE_URL = $script:WebBackendBaseUrl
  }

  $outLog = Join-Path $LogDir "tool_r18_bot.out.log"
  $errLog = Join-Path $LogDir "tool_r18_bot.err.log"
  $process = Start-Process -FilePath $Node -ArgumentList @("--import", "tsx", "src/daemon.ts") -WorkingDirectory $toolRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Add-ManagedProcess -Process $process -Label "Tool_R18 Bot"
  Start-Sleep -Seconds 8
  if ($process.HasExited) {
    $stdout = Get-LogTail -Path $outLog
    $stderr = Get-LogTail -Path $errLog
    throw "Tool_R18 Bot 啟動後已退出。PID=$($process.Id)`nstdout:`n$stdout`nstderr:`n$stderr"
  }
  Write-Host ("Tool_R18 Telegram Bot 後台已啟動，PID：" + $process.Id)
  Write-Host ("Telegram Webhook 本機連接埠：" + $webhookPort)
}

function Stop-ToolR18 {
  param([bool]$Quiet = $false)
  $existing = @(Find-ToolR18Processes)
  if ($existing.Count -gt 0) {
    foreach ($process in $existing) {
      try { Stop-Process -Id $process.ProcessId -Force } catch {}
      $script:ManagedProcessIds.Remove([int]$process.ProcessId) | Out-Null
      if (-not $Quiet) { Write-Host ("已停止 Tool_R18 Telegram Bot 後台，PID：" + $process.ProcessId) }
    }
  } elseif (-not $Quiet) {
    Write-Host "Tool_R18 Telegram Bot 後台目前沒有運行。"
  }
}

function Stop-WebBackend {
  param([bool]$Quiet = $false)
  $existing = @(Find-WebBackendProcesses)
  if ($existing.Count -gt 0) {
    foreach ($process in $existing) {
      try { Stop-Process -Id $process.ProcessId -Force } catch {}
      $script:ManagedProcessIds.Remove([int]$process.ProcessId) | Out-Null
      if (-not $Quiet) { Write-Host ("已停止 Web 後台，PID：" + $process.ProcessId) }
    }
  } elseif (-not $Quiet) {
    Write-Host "Web 後台目前沒有運行。"
  }
}

function Stop-AllServices {
  Stop-ToolR18
  Stop-WebBackend
}

function Start-AllServices {
  Configure-TelegramBot
  Configure-GrokTextModel
  Start-WebBackend -OpenBrowser $false
  Start-ToolR18
  Write-Host ""
  Write-Host "啟動完成。"
  Write-Host "Web 後台與 Bot 會跟隨此啟動器視窗運行；關閉視窗或選擇退出時會停止。"
  Write-Host "如需打開頁面，請回到主選單選擇「3. 開啟 Web 後台頁面」。"
}

function Restart-AllServices {
  Stop-AllServices
  Start-AllServices
}

function Switch-TelegramToken {
  Configure-TelegramBot -Force $true
  Start-WebBackend -OpenBrowser $false
  Start-ToolR18
  Write-Host ""
  Write-Host "Token 已更換並已重新啟動 Bot。"
}

function Switch-GrokTextModel {
  Configure-GrokTextModel -Force $true
  Stop-ToolR18
  Start-ToolR18
  Write-Host ""
  Write-Host "Grok 文字模型 API/Key 已更換，Tool_R18 Bot 已重啟並套用新設定。"
}

function Show-Status {
  $web = Find-WebBackendProcess
  $bot = Find-ToolR18Process
  Write-Host ""
  Write-Host "============================================================"
  Write-Host "目前狀態"
  Write-Host "============================================================"
  Write-Host ("Telegram Bot：" + (Get-SavedBotInfoText))
  Write-Host ("Grok 文字模型：" + (Get-SavedGrokInfoText))
  if ($web) {
    $port = Get-PortFromCommandLine -CommandLine (Get-ProcessCommandLineText $web)
    Write-Host ("Web 後台：運行中，PID " + $web.ProcessId + ($(if ($port) { "，網址 http://127.0.0.1:$port/admin.html" } else { "" })))
  } else {
    Write-Host "Web 後台：未運行"
  }
  if ($bot) {
    Write-Host ("Tool_R18 Bot：運行中，PID " + $bot.ProcessId)
  } else {
    Write-Host "Tool_R18 Bot：未運行"
  }
}

function Show-MainMenu {
  Write-Host "============================================================"
  Write-Host "Workflow Delivery Package 便攜啟動器"
  Write-Host "============================================================"
  Write-Host ("目前 Bot 設定：" + (Get-SavedBotInfoText))
  Write-Host ("目前 Grok 設定：" + (Get-SavedGrokInfoText))
  Write-Host ""
  Write-Host "後台服務會跟隨此視窗運行；關閉此視窗會停止本工具啟動的服務。"
  Write-Host ""
  Write-Host "請選擇要執行的操作："
  Write-Host "  1. 更換 Telegram Bot Token"
  Write-Host "  2. 更換 Grok 文字模型 API/Key"
  Write-Host "  3. 開啟 Web 後台頁面"
  Write-Host "  4. 查看目前狀態"
  Write-Host "  5. 重啟 Web 後台與 Telegram Bot"
  Write-Host "  6. 停止本工具後台服務"
  Write-Host "  7. 停止服務並關閉此視窗"
  Write-Host ""
  return (Read-Host "請輸入選項數字後按 Enter")
}

function Write-LauncherError {
  param([Parameter(Mandatory = $true)]$ErrorRecord)
  Write-Host ""
  Write-Host "啟動失敗："
  $message = [string]$ErrorRecord.Exception.Message
  if ($message -match "\(404\)|404|Not Found|未找到|找不到") {
    Write-Host "Telegram Bot Token 驗證失敗。請確認 Token 是否完整、正確。"
  } elseif ($message -match "timed out|timeout|逾時|超时") {
    Write-Host "連線逾時。請確認網路是否正常，並確認此電腦可以連接 Telegram/Grok API。"
  } elseif ($message -match "getaddrinfo|NameResolution|DNS") {
    Write-Host "網路解析失敗。請確認網路或 DNS 設定。"
  } else {
    Write-Host $message
  }
}

function Wait-ReturnToMenu {
  Write-Host ""
  Read-Host "按 Enter 返回主選單"
  Write-Host ""
}

try {
  Write-Host "============================================================"
  Write-Host "Workflow Delivery Package 便攜啟動器"
  Write-Host "============================================================"
  Write-Host "正在自動檢查設定並啟動 Web 後台與 Telegram Bot..."
  Write-Host "此視窗開啟期間服務保持運行；關閉視窗時會停止服務。"
  Start-AllServices
  Wait-ReturnToMenu

  while ($true) {
    $choice = Show-MainMenu
    $shouldExit = $false
    try {
      switch ($choice.Trim()) {
        "1" { Switch-TelegramToken }
        "2" { Switch-GrokTextModel }
        "3" { Open-WebBackendPage }
        "4" { Show-Status }
        "5" { Restart-AllServices }
        "6" { Stop-AllServices }
        "7" {
          Write-Host ""
          Write-Host "正在停止本工具後台服務..."
          Stop-AllServices
          Write-Host "已停止服務並關閉啟動器視窗。"
          $shouldExit = $true
        }
        default {
          Write-Host ""
          Write-Host "未識別的選項，未執行任何操作。"
        }
      }
    } catch {
      Write-LauncherError -ErrorRecord $_
    }
    if ($shouldExit) { break }
    Wait-ReturnToMenu
  }
} catch {
  try { Stop-AllServices } catch {}
  Write-LauncherError -ErrorRecord $_
  Write-Host ""
  Write-Host "此視窗會保留，方便查看錯誤訊息。"
  Read-Host "按 Enter 關閉"
  exit 1
}

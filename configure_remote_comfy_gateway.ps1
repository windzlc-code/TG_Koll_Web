# Configure and start ComfyUI gateway on the remote Windows ComfyUI computer.
# Run this in PowerShell on that computer.

$ComfyRoot = "D:\comfyui\ComfyUI_windows_portable\ComfyUI"
$ProjectRoot = "E:\Other\work\GitHub\workflow_delivery_package"
$GatewayToken = $env:COMFY_GATEWAY_TOKEN
if (!$GatewayToken) {
  $GatewayToken = Read-Host "Enter COMFY_GATEWAY_TOKEN"
}

$ComfyPort = 8188
$GatewayPort = 9000
$GatewayScript = Join-Path $ProjectRoot "tools\comfy_gateway_v2.py"

if (!(Test-Path $ComfyRoot)) {
  throw "ComfyRoot not found: $ComfyRoot"
}
if (!(Test-Path $GatewayScript)) {
  throw "Gateway script not found: $GatewayScript"
}

$Python = "python"
$PortablePython = Join-Path (Split-Path $ComfyRoot -Parent) "python_embeded\python.exe"
if (Test-Path $PortablePython) {
  $Python = $PortablePython
}

$comfyListening = Get-NetTCPConnection -LocalPort $ComfyPort -State Listen -ErrorAction SilentlyContinue
if (!$comfyListening) {
  Write-Host "Starting ComfyUI on 127.0.0.1:$ComfyPort ..."
  Start-Process -FilePath $Python `
    -ArgumentList "main.py --listen 127.0.0.1 --port $ComfyPort" `
    -WorkingDirectory $ComfyRoot `
    -WindowStyle Minimized
  Start-Sleep -Seconds 8
} else {
  Write-Host "ComfyUI already listening on $ComfyPort"
}

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*comfy_gateway_v2.py*" } |
  ForEach-Object {
    Write-Host "Stopping old gateway PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force
  }

Write-Host "Starting Comfy gateway on 0.0.0.0:$GatewayPort ..."
$env:COMFY_ROOT = $ComfyRoot
$env:COMFY_URL = "http://127.0.0.1:$ComfyPort"
$env:COMFY_GATEWAY_HOST = "0.0.0.0"
$env:COMFY_GATEWAY_PORT = "$GatewayPort"
$env:COMFY_GATEWAY_TOKEN = $GatewayToken

Start-Process -FilePath $Python `
  -ArgumentList "`"$GatewayScript`"" `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Minimized

Start-Sleep -Seconds 3

Write-Host "`nLocal checks:"
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$ComfyPort/system_stats" -TimeoutSec 10 | Select-Object StatusCode
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$GatewayPort/api/health" -Headers @{ Authorization = "Bearer $GatewayToken" } -TimeoutSec 10 | Select-Object StatusCode, Content
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$GatewayPort/api/workflows" -Headers @{ Authorization = "Bearer $GatewayToken" } -TimeoutSec 10 | Select-Object StatusCode, Content

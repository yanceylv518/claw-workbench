$ErrorActionPreference = "Stop"

$root = "D:\openclaw"
$serverScript = Join-Path $root "console-server.mjs"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$dataDir = "D:\XiaolongxiaData"
$logPath = Join-Path $dataDir "wechat-direct-bridge.log"
$port = "3100"

if (-not (Test-Path $serverScript)) {
  throw "Console server not found: $serverScript"
}

if (-not (Test-Path $nodeExe)) {
  throw "Node.exe not found: $nodeExe"
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'console-server\.mjs'
  }

if ($existing) {
  Write-Host "Console is already running: http://localhost:$port"
  $existing | Select-Object ProcessId, CreationDate, CommandLine
  exit 0
}

$command = @"
`$env:XIAOLONGXIA_DATA_DIR='$dataDir'
`$env:XIAOLONGXIA_LOG_PATH='$logPath'
`$env:XLX_CONSOLE_PORT='$port'
& '$nodeExe' '$serverScript'
"@

Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
  -WorkingDirectory $root `
  -WindowStyle Hidden

Start-Sleep -Seconds 2

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" | Out-Null
  Write-Host "Console started: http://localhost:$port"
} catch {
  throw "Console did not respond on http://localhost:$port"
}

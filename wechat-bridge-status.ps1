$configPath = "D:\openclaw\wechat-bridge.config.json"
$dataDir = $env:XIAOLONGXIA_DATA_DIR
if (-not $dataDir) {
  $dataDir = "D:\XiaolongxiaData"
}
$logPath = Join-Path $dataDir "wechat-direct-bridge.log"

if (Test-Path $configPath) {
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  Write-Host "Active mode:" $config.active_mode
}

$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'wechat-direct-bridge\.mjs'
  }

if ($processes) {
  Write-Host "Bridge process:"
  $processes | Select-Object ProcessId, CreationDate, CommandLine
} else {
  Write-Host "Bridge process: not running"
}

if (Test-Path $logPath) {
  Write-Host ""
  Write-Host "Recent log:"
  Get-Content $logPath -Tail 12
}

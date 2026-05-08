$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeScript = Join-Path $root "wechat-direct-bridge.mjs"
$bundledNode = Join-Path $root "runtime\node\node.exe"
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$dataDir = if ($env:XIAOLONGXIA_DATA_DIR) { $env:XIAOLONGXIA_DATA_DIR } else { Join-Path $root "data\runtime" }
$browserProfileDir = if ($env:XIAOLONGXIA_BROWSER_PROFILE_DIR) { $env:XIAOLONGXIA_BROWSER_PROFILE_DIR } else { Join-Path $dataDir "browser-profiles" }
$logPath = Join-Path $dataDir "wechat-direct-bridge.log"
$proxyUrl = $env:XIAOLONGXIA_PROXY_URL

if (-not (Test-Path $bridgeScript)) {
  throw "Bridge script not found: $bridgeScript"
}

if (-not (Test-Path $nodeExe)) {
  throw "Node.exe not found: $nodeExe"
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
New-Item -ItemType Directory -Path $browserProfileDir -Force | Out-Null

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'wechat-direct-bridge\.mjs'
  }

if ($existing) {
  Write-Host "Bridge is already running."
  $existing | Select-Object ProcessId, CreationDate, CommandLine
  exit 0
}

$command = @"
`$env:NO_PROXY='127.0.0.1,localhost'
`$env:XIAOLONGXIA_DATA_DIR='$dataDir'
`$env:XIAOLONGXIA_BROWSER_PROFILE_DIR='$browserProfileDir'
`$env:XIAOLONGXIA_LOG_PATH='$logPath'
`$env:OPENCLAW_HOME='$(if ($env:OPENCLAW_HOME) { $env:OPENCLAW_HOME } else { Join-Path $root "data\openclaw" })'
& '$nodeExe' '$bridgeScript'
"@

if ($proxyUrl) {
  $command = "`$env:HTTP_PROXY='$proxyUrl'`n`$env:HTTPS_PROXY='$proxyUrl'`n`$env:NODE_USE_ENV_PROXY='1'`n$command"
}

Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
  -WorkingDirectory $root `
  -WindowStyle Hidden

Start-Sleep -Seconds 3

$started = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'wechat-direct-bridge\.mjs'
  }

if (-not $started) {
  throw "Bridge did not start."
}

Write-Host "Bridge started."
$started | Select-Object ProcessId, CreationDate, CommandLine

if (Test-Path $logPath) {
  Write-Host ""
  Write-Host "Recent log:"
  Get-Content $logPath -Tail 10
}

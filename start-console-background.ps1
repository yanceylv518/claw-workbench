$ErrorActionPreference = "Stop"

$ProjectDir = "D:\openclaw"
$DataDir = "D:\XiaolongxiaData"
$LogPath = Join-Path $DataDir "console-startup.log"
$NodePath = "C:\Program Files\nodejs\node.exe"
$ConsoleScript = Join-Path $ProjectDir "console-server.mjs"
$Port = "3101"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Write-StartupLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogPath -Value "[$timestamp] $Message" -Encoding UTF8
}

try {
  $existing = netstat -ano | Select-String ":$Port\s" | Select-Object -First 1
  if ($existing) {
    Write-StartupLog "Console already appears to be listening on port $Port. Skip startup."
    exit 0
  }

  if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node executable not found: $NodePath"
  }
  if (-not (Test-Path -LiteralPath $ConsoleScript)) {
    throw "Console script not found: $ConsoleScript"
  }

  $env:XIAOLONGXIA_DATA_DIR = $DataDir
  $env:XIAOLONGXIA_LOG_PATH = Join-Path $DataDir "wechat-direct-bridge.log"
  $env:XLX_CONSOLE_PORT = $Port

  Start-Process `
    -FilePath $NodePath `
    -ArgumentList "`"$ConsoleScript`"" `
    -WorkingDirectory $ProjectDir `
    -WindowStyle Hidden

  Write-StartupLog "Started Xiaolongxia console on http://localhost:$Port/."
} catch {
  Write-StartupLog "Startup failed: $($_.Exception.Message)"
  throw
}

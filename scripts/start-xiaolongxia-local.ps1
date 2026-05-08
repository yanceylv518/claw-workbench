$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA "XiaolongxiaBackend\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Start-XiaolongxiaProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$Signature,
    [Parameter(Mandatory = $true)][int]$Port
  )

  $existing = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Signature) }

  $listening = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Add-Content -Path (Join-Path $logDir "startup.log") -Value "[$(Get-Date -Format s)] $Name already listening on $Port."
    return
  }

  if ($existing) {
    foreach ($proc in $existing) {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    Add-Content -Path (Join-Path $logDir "startup.log") -Value "[$(Get-Date -Format s)] Restarted stale $Name process."
  }

  $stdout = Join-Path $logDir "$Name.out.log"
  $stderr = Join-Path $logDir "$Name.err.log"

  Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

  Add-Content -Path (Join-Path $logDir "startup.log") -Value "[$(Get-Date -Format s)] Started $Name."
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm.exe -ErrorAction Stop
}
$npm = $npmCommand.Source

Start-XiaolongxiaProcess `
  -Name "local-api" `
  -FilePath $node `
  -ArgumentList @("apps/api/local-server.mjs") `
  -Signature "apps/api/local-server.mjs" `
  -Port 3200

Start-XiaolongxiaProcess `
  -Name "console-server" `
  -FilePath $node `
  -ArgumentList @("console-server.mjs") `
  -Signature "console-server.mjs" `
  -Port 3100

Start-XiaolongxiaProcess `
  -Name "web-dev" `
  -FilePath $npm `
  -ArgumentList @("--workspace", "apps/web", "run", "dev", "--", "--host", "127.0.0.1") `
  -Signature "vite" `
  -Port 5173

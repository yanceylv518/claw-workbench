$ErrorActionPreference = "Stop"

$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupFolder "xiaolongxia-wechat-bridge.cmd"
$bridgeStartScript = "D:\openclaw\boot-wechat-direct-bridge.ps1"

if (-not (Test-Path -LiteralPath $bridgeStartScript)) {
  throw "Boot script not found: $bridgeStartScript"
}

$content = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$bridgeStartScript"
"@

$content | Out-File -LiteralPath $launcherPath -Encoding ascii -Force

Write-Host "Startup launcher installed:"
Write-Host $launcherPath

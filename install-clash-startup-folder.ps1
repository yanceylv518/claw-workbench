$ErrorActionPreference = "Stop"

$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupFolder "clash-for-windows-autostart.cmd"
$clashExe = "C:\Users\40323\AppData\Local\Programs\Clash for Windows\Clash for Windows.exe"

if (-not (Test-Path -LiteralPath $clashExe)) {
  throw "Clash for Windows executable not found: $clashExe"
}

$content = @"
@echo off
start "" "$clashExe"
"@

$content | Out-File -LiteralPath $launcherPath -Encoding ascii -Force

Write-Host "Clash autostart launcher installed:"
Write-Host $launcherPath

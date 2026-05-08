$ErrorActionPreference = "Stop"

$taskName = "Xiaolongxia-WeChat-Bridge-Autostart"
$scriptPath = "D:\openclaw\boot-wechat-direct-bridge.ps1"
$workDir = "D:\openclaw"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path $scriptPath)) {
  throw "Autostart script not found: $scriptPath"
}

$startupAction = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $startupAction `
  -Trigger @($startupTrigger, $logonTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description "Auto-start Xiaolongxia WeChat bridge after boot or logon." `
  -Force | Out-Null

Write-Host "Autostart task installed: $taskName"
Write-Host "It will start the WeChat bridge at startup and at logon."

param(
  [string]$Time = "07:00"
)

$ErrorActionPreference = "Stop"

$taskName = "XiaolongxiaMorningWake"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$bridgeRestartScript = "D:\openclaw\restart-wechat-direct-bridge.ps1"

if (-not (Test-Path -LiteralPath $bridgeRestartScript)) {
  throw "Bridge restart script not found: $bridgeRestartScript"
}

$timeParts = $Time.Split(":")
if ($timeParts.Count -ne 2) {
  throw "Time format must be HH:mm, for example 07:00"
}

$hour = [int]$timeParts[0]
$minute = [int]$timeParts[1]
$triggerTime = Get-Date -Hour $hour -Minute $minute -Second 0

$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$bridgeRestartScript`"" `
  -WorkingDirectory "D:\openclaw"

$trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 10) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Wake the PC in the morning and restart Xiaolongxia bridge." `
  -Force | Out-Null

powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /SETACTIVE SCHEME_CURRENT | Out-Null

Write-Host "Morning wake task installed:"
Write-Host $taskName
Write-Host "Time:" $Time

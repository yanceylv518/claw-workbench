param(
  [string]$Time = "08:00"
)

$ErrorActionPreference = "Stop"

$taskName = "XiaolongxiaMorningPush"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$scriptPath = "D:\openclaw\morning-ai-brief.mjs"
$nodeExe = "C:\Program Files\nodejs\node.exe"

if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Morning brief script not found: $scriptPath"
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Node.exe not found: $nodeExe"
}

$timeParts = $Time.Split(":")
if ($timeParts.Count -ne 2) {
  throw "Time format must be HH:mm, for example 08:00"
}

$hour = [int]$timeParts[0]
$minute = [int]$timeParts[1]
$triggerTime = Get-Date -Hour $hour -Minute $minute -Second 0

$runner = @"
`$env:HTTP_PROXY='http://127.0.0.1:7890'
`$env:HTTPS_PROXY='http://127.0.0.1:7890'
`$env:NODE_USE_ENV_PROXY='1'
`$env:NO_PROXY='127.0.0.1,localhost'
`$env:XIAOLONGXIA_DATA_DIR='D:\XiaolongxiaData'
`$env:XIAOLONGXIA_MORNING_LOG_PATH='D:\XiaolongxiaData\morning-ai-brief.log'
`$runnerLogPath='D:\XiaolongxiaData\morning-ai-brief-runner.log'
New-Item -ItemType Directory -Path (Split-Path -Parent `$runnerLogPath) -Force | Out-Null
function Write-RunnerLog {
  param([string]`$Message)
  `$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath `$runnerLogPath -Encoding utf8 -Value "[`$timestamp] `$Message"
}
Write-RunnerLog "Runner starting. checkOnly=`$(`$env:XIAOLONGXIA_MORNING_CHECK_ONLY)"
try {
  Set-Location 'D:\openclaw'
  & '$nodeExe' '$scriptPath'
  `$exitCode = `$LASTEXITCODE
  Write-RunnerLog "Runner finished. exitCode=`$exitCode"
  exit `$exitCode
} catch {
  Write-RunnerLog "Runner failed. `$(`$_.Exception.Message)"
  throw
}
"@

$tempCommandPath = "D:\openclaw\run-morning-ai-brief.ps1"
$runner | Out-File -LiteralPath $tempCommandPath -Encoding utf8 -Force

$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$tempCommandPath`"" `
  -WorkingDirectory "D:\openclaw"

$trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 10) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Push 10-item morning AI brief to WeChat and Notion." `
  -Force | Out-Null

Write-Host "Morning push task installed:"
Write-Host $taskName
Write-Host "Time:" $Time

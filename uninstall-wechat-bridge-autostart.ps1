$ErrorActionPreference = "Stop"

$taskName = "Xiaolongxia-WeChat-Bridge-Autostart"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Autostart task not found."
  exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Autostart task removed: $taskName"

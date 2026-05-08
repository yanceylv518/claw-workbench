$taskName = "Xiaolongxia-WeChat-Bridge-Autostart"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if (-not $task) {
  Write-Host "Autostart: not installed"
  exit 0
}

$info = Get-ScheduledTaskInfo -TaskName $taskName

Write-Host "Autostart: installed"
Write-Host "Task name:" $taskName
Write-Host "State:" $task.State
Write-Host "Last run:" $info.LastRunTime
Write-Host "Next run:" $info.NextRunTime

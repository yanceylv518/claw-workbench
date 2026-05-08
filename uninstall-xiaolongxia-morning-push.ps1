$taskName = "XiaolongxiaMorningPush"

try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  Write-Host "Morning push task removed:" $taskName
} catch {
  Write-Host "Morning push task not found."
}

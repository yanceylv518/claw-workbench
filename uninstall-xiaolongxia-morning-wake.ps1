$taskName = "XiaolongxiaMorningWake"

try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  Write-Host "Morning wake task removed:" $taskName
} catch {
  Write-Host "Morning wake task not found."
}

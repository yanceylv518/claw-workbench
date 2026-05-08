$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'console-server\.mjs'
  }

if (-not $processes) {
  Write-Host "Console is not running."
  exit 0
}

$processes | ForEach-Object {
  try {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped console PID $($_.ProcessId)"
  } catch {
    Write-Host "Failed to stop PID $($_.ProcessId): $($_.Exception.Message)"
  }
}

$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'wechat-direct-bridge\.mjs'
  }

if (-not $processes) {
  Write-Host "Bridge is not running."
  exit 0
}

$processes | ForEach-Object {
  try {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped bridge PID $($_.ProcessId)"
  } catch {
    Write-Host "Failed to stop PID $($_.ProcessId): $($_.Exception.Message)"
  }
}

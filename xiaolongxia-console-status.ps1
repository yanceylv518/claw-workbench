$port = "3100"

$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^node(\.exe)?$' -and
    $_.CommandLine -match 'console-server\.mjs'
  }

if ($processes) {
  Write-Host "Console process:"
  $processes | Select-Object ProcessId, CreationDate, CommandLine
} else {
  Write-Host "Console process: not running"
}

try {
  Write-Host ""
  Write-Host "Console API:"
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" | ConvertTo-Json -Depth 4
} catch {
  Write-Host ""
  Write-Host "Console API: not responding on http://localhost:$port"
}

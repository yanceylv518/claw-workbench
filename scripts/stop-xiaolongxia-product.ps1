$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$escapedRoot = [regex]::Escape($root)
$patterns = @(
  "apps[/\\]api[/\\]local-server\.mjs",
  "console-server\.mjs",
  "wechat-direct-bridge\.mjs"
)

function Get-PortListenerProcessIds {
  try {
    Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -ne 0 }
  } catch {
    @()
  }
}

function Test-IsCurrentFolderProcess($proc) {
  if (-not $proc) { return $false }
  if ($proc.ExecutablePath -and $proc.ExecutablePath -match $escapedRoot) { return $true }
  if ($proc.CommandLine -and $proc.CommandLine -match $escapedRoot) { return $true }
  return $false
}

$stopped = @()
$processes = @(Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match "^node(\.exe)?$" -and
    $_.CommandLine -and
    $_.CommandLine -match $escapedRoot -and
    ($patterns | Where-Object { $_.CommandLine -match $_ })
  })

foreach ($ownerPid in Get-PortListenerProcessIds) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
  if ((Test-IsCurrentFolderProcess $proc) -and -not ($processes | Where-Object { $_.ProcessId -eq $proc.ProcessId })) {
    $processes += $proc
  }
}

foreach ($proc in $processes) {
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    $stopped += $proc.ProcessId
  } catch {
    Write-Host "Failed to stop PID $($proc.ProcessId): $($_.Exception.Message)"
  }
}

if ($stopped.Count) {
  Write-Host "Xiaolongxia stopped. PID: $($stopped -join ', ')"
} else {
  Write-Host "No Xiaolongxia process is running from this folder."
}

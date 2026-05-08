$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupFolder "clash-for-windows-autostart.cmd"

if (Test-Path -LiteralPath $launcherPath) {
  Write-Host "Clash autostart: installed"
  Write-Host $launcherPath
  Write-Host ""
  Write-Host "Content:"
  Get-Content -LiteralPath $launcherPath
} else {
  Write-Host "Clash autostart: not installed"
}

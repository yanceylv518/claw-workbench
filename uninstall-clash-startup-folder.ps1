$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupFolder "clash-for-windows-autostart.cmd"

if (Test-Path -LiteralPath $launcherPath) {
  Remove-Item -LiteralPath $launcherPath -Force
  Write-Host "Clash autostart launcher removed:"
  Write-Host $launcherPath
} else {
  Write-Host "Clash autostart launcher not found."
}

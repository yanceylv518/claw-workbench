$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupFolder "xiaolongxia-wechat-bridge.cmd"

if (Test-Path -LiteralPath $launcherPath) {
  Write-Host "Startup launcher: installed"
  Write-Host $launcherPath
  Write-Host ""
  Write-Host "Content:"
  Get-Content -LiteralPath $launcherPath
} else {
  Write-Host "Startup launcher: not installed"
}

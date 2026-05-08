$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherPath = Join-Path $startupFolder "xiaolongxia-wechat-bridge.cmd"

if (Test-Path -LiteralPath $launcherPath) {
  Remove-Item -LiteralPath $launcherPath -Force
  Write-Host "Startup launcher removed:"
  Write-Host $launcherPath
} else {
  Write-Host "Startup launcher not found."
}

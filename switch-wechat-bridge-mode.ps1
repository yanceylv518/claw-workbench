param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("gpt-account", "third-party-api")]
  [string]$Mode
)

$configPath = "D:\openclaw\wechat-bridge.config.json"

if (-not (Test-Path $configPath)) {
  throw "Config not found: $configPath"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$config.active_mode = $Mode
$config | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8

Write-Host "Switched active mode to: $Mode"
Write-Host "Restarting bridge..."

& "D:\openclaw\restart-wechat-direct-bridge.ps1"

$ErrorActionPreference = "Stop"

$startupDelaySeconds = 35

Start-Sleep -Seconds $startupDelaySeconds

& "D:\openclaw\start-wechat-direct-bridge.ps1"

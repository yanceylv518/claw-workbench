$ErrorActionPreference = "Stop"

& "D:\openclaw\stop-wechat-direct-bridge.ps1"
Start-Sleep -Seconds 1
& "D:\openclaw\start-wechat-direct-bridge.ps1"

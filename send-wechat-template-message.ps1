param(
  [Parameter(Mandatory = $true)]
  [string]$Template
)

$ErrorActionPreference = "Stop"
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:NODE_USE_ENV_PROXY='1'
$env:NO_PROXY='127.0.0.1,localhost'

Push-Location 'D:\openclaw'
try {
  & 'C:\Program Files\nodejs\node.exe' 'D:\openclaw\send-wechat-template-message.mjs' $Template
} finally {
  Pop-Location
}

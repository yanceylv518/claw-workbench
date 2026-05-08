$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:NODE_USE_ENV_PROXY='1'
$env:NO_PROXY='127.0.0.1,localhost'
$env:XIAOLONGXIA_DATA_DIR='D:\XiaolongxiaData'
$env:XIAOLONGXIA_MORNING_LOG_PATH='D:\XiaolongxiaData\morning-ai-brief.log'
$runnerLogPath='D:\XiaolongxiaData\morning-ai-brief-runner.log'
New-Item -ItemType Directory -Path (Split-Path -Parent $runnerLogPath) -Force | Out-Null
function Write-RunnerLog {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $runnerLogPath -Encoding utf8 -Value "[$timestamp] $Message"
}
Write-RunnerLog "Runner starting. checkOnly=$($env:XIAOLONGXIA_MORNING_CHECK_ONLY)"
try {
  Set-Location 'D:\openclaw'
  & 'C:\Program Files\nodejs\node.exe' 'D:\openclaw\morning-ai-brief.mjs'
  $exitCode = $LASTEXITCODE
  Write-RunnerLog "Runner finished. exitCode=$exitCode"
  exit $exitCode
} catch {
  Write-RunnerLog "Runner failed. $($_.Exception.Message)"
  throw
}

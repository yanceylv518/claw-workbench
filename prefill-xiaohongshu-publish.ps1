param(
  [string]$Package = "",
  [int]$TimeoutSeconds = 300,
  [switch]$SaveDraft
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $root "xiaohongshu-prefill-publish.py"
$pythonPath = Join-Path $root "runtime\python\python.exe"
if (!(Test-Path $pythonPath)) {
  $pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
}

if (!(Test-Path $scriptPath)) {
  Write-Error "未找到脚本：$scriptPath"
  exit 1
}

$args = @($scriptPath, "--timeout", $TimeoutSeconds)
if ($Package) {
  $args += @("--package", $Package)
}
if ($SaveDraft) {
  $args += "--save-draft"
}

& $pythonPath @args

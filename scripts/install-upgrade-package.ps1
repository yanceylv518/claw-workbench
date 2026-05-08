param(
  [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"

function Decode-Text($base64) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($base64))
}

$upgradeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$productNameZh = -join @([char]0x5C0F, [char]0x9F99, [char]0x867E, [char]0x672C, [char]0x5730, [char]0x7248)
$launcherNameZh = (-join @([char]0x542F, [char]0x52A8)) + $productNameZh + ".bat"
$upgradeLauncherNameZh = (-join @([char]0x5347, [char]0x7EA7)) + $productNameZh + ".bat"
$upgradeReadmeNameZh = (-join @([char]0x5347, [char]0x7EA7, [char]0x8BF4, [char]0x660E)) + ".md"

if (-not $TargetDir) {
  $prompt = Decode-Text "6K+36L6T5YWl5Y6f5bCP6b6Z6Jm+5a6J6KOF55uu5b2V77yM5L6L5aaCIEQ6XFhpYW9sb25neGlhIOaIliBFOlxpvpnom77c5bCP6b6Z6Jm+5pys5Zyw54mILVdpbmRvd3MtdjAuMS4w"
  $TargetDir = Read-Host $prompt
}

if (-not $TargetDir) {
  throw (Decode-Text "5pyq5o+Q5L6b5a6J6KOF55uu5b2V44CC")
}

$target = [System.IO.Path]::GetFullPath($TargetDir)
if (-not (Test-Path $target)) {
  throw ((Decode-Text "5a6J6KOF55uu5b2V5LiN5a2Y5Zyo77ya") + $target)
}

$startScript = Join-Path $target "start-xiaolongxia.ps1"
if (-not (Test-Path $startScript)) {
  throw ((Decode-Text "55uu5qCH55uu5b2V5LiN5YOP5bCP6b6Z6Jm+5a6J6KOF55uu5b2V77yM5pyq5om+5YiwIHN0YXJ0LXhpYW9sb25neGlhLnBzMTog") + $target)
}

function Stop-TargetXiaolongxia {
  $stopScript = Join-Path $target "stop-xiaolongxia.ps1"
  if (Test-Path $stopScript) {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Host
    Start-Sleep -Seconds 1
  }
}

function Copy-UpgradeItem($name) {
  $source = Join-Path $upgradeRoot $name
  if (-not (Test-Path $source)) { return }
  $destination = Join-Path $target $name
  if (Test-Path $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
  }
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

$skipNames = @(
  "data",
  "logs",
  "notion-ai-intel.config.json",
  "wechat-bridge.config.json",
  "package-lock.json",
  "start-xiaolongxia.ps1",
  $launcherNameZh,
  $upgradeReadmeNameZh,
  $upgradeLauncherNameZh,
  "install-upgrade-package.ps1"
)

Write-Host (Decode-Text "5q2j5Zyo5YGc5q2i5pen54mI5bCP6b6Z6Jm+Li4u")
Stop-TargetXiaolongxia

Write-Host (Decode-Text "5q2j5Zyo6KaG55uW56iL5bqP5paH5Lu2Li4u")
Get-ChildItem -LiteralPath $upgradeRoot -Force | ForEach-Object {
  if ($skipNames -contains $_.Name) { return }
  Copy-UpgradeItem $_.Name
}

$launcherPath = Join-Path $target $launcherNameZh
Write-Host ""
Write-Host (Decode-Text "5Y2H57qn5a6M5oiQ44CC")
Write-Host (Decode-Text "55So5oi36YWN572u44CB5Lu75Yqh44CB5Y+R5biD5YyF44CB5pel5b+X5ZKM5pys5Zyw5pWw5o2u5bey5L+d55WZ44CC")
Write-Host ""
Write-Host (Decode-Text "6K+35LiN6KaB5Zyo6KaG55uW5Y2H57qn5YyF55uu5b2V6YeM5ZCv5Yqo44CC")
Write-Host (Decode-Text "6K+36L+b5YWl5L2g5Yia5omN6L6T5YWl55qE5Y6f5a6J6KOF55uu5b2V77ya")
Write-Host "  $target"
Write-Host (Decode-Text "54S25ZCO5Y+M5Ye75ZCv5Yqo5paH5Lu277ya")
Write-Host "  $launcherPath"
Write-Host ""
Read-Host (Decode-Text "5oyJ5Zue6L2m6ZSu6YCA5Ye6")

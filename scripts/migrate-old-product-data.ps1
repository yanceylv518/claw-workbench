param(
  [string]$OldDir = ""
)

$ErrorActionPreference = "Stop"

function Text($base64) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($base64))
}

$currentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$productNameZh = -join @([char]0x5C0F, [char]0x9F99, [char]0x867E, [char]0x672C, [char]0x5730, [char]0x7248)
$launcherNameZh = (-join @([char]0x542F, [char]0x52A8)) + $productNameZh + ".bat"

if (-not $OldDir) {
  $OldDir = Read-Host (Text "6K+36L6T5YWl5pen54mI5bCP6b6Z6Jm+5a6J6KOF55uu5b2V77yM5L6L5aaCIEQ6XFhpYW9sb25neGlhIOaIliBFOlxpvpnom77c5bCP6b6Z6Jm+5pys5Zyw54mILVdpbmRvd3MtdjAuMS4w")
}

if (-not $OldDir) {
  throw (Text "5pyq5o+Q5L6b5pen54mI55uu5b2V44CC")
}

$oldRoot = [System.IO.Path]::GetFullPath($OldDir)
$newRoot = [System.IO.Path]::GetFullPath($currentRoot)

if (-not (Test-Path $oldRoot)) {
  throw ((Text "5pen54mI55uu5b2V5LiN5a2Y5Zyo77ya") + $oldRoot)
}

if ($oldRoot.TrimEnd('\') -ieq $newRoot.TrimEnd('\')) {
  throw (Text "5pen54mI55uu5b2V5LiN6IO95ZKM5b2T5YmN5paw54mI55uu5b2V55u45ZCM44CC")
}

$hasProductMarker = (Test-Path (Join-Path $oldRoot "start-xiaolongxia.ps1")) -or (Test-Path (Join-Path $oldRoot "data"))
if (-not $hasProductMarker) {
  throw ((Text "55uu5qCH55uu5b2V5LiN5YOP5bCP6b6Z6Jm+5a6J6KOF55uu5b2V77ya") + $oldRoot)
}

function Copy-FileIfExists($relativePath) {
  $source = Join-Path $oldRoot $relativePath
  if (-not (Test-Path $source)) { return $false }
  $target = Join-Path $newRoot $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
  return $true
}

function Copy-DirectoryIfExists($relativePath) {
  $source = Join-Path $oldRoot $relativePath
  if (-not (Test-Path $source)) { return $false }
  $target = Join-Path $newRoot $relativePath
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) -Recurse -Force
  }
  return $true
}

Write-Host ""
Write-Host (Text "5q2j5Zyo5LuO5pen54mI5aSN5Yi25pWw5o2u5ZKM6YWN572uLi4u")
Write-Host ((Text "5pen54mI55uu5b2V77ya") + $oldRoot)
Write-Host ((Text "5paw54mI55uu5b2V77ya") + $newRoot)
Write-Host ""

$copied = New-Object System.Collections.Generic.List[string]
foreach ($dir in @("data", "logs", ".wechat-direct-bridge")) {
  if (Copy-DirectoryIfExists $dir) { $copied.Add($dir) }
}
foreach ($file in @("notion-ai-intel.config.json", "wechat-bridge.config.json")) {
  if (Copy-FileIfExists $file) { $copied.Add($file) }
}

Write-Host ""
if ($copied.Count -gt 0) {
  Write-Host (Text "6L+H56e75a6M5oiQ77yM5bey5aSN5Yi277ya")
  $copied | ForEach-Object { Write-Host "  - $_" }
} else {
  Write-Host (Text "5pyq5om+5Yiw5Y+v6L+H56e755qE5pWw5o2u5oiW6YWN572u44CC")
}

$launcherPath = Join-Path $newRoot $launcherNameZh
Write-Host ""
Write-Host (Text "6K+35Zue5Yiw5paw54mI55uu5b2V5ZCv5Yqo5bCP6b6Z6Jm+77ya")
Write-Host "  $launcherPath"
Write-Host ""
Read-Host (Text "5oyJ5Zue6L2m6ZSu6YCA5Ye6")

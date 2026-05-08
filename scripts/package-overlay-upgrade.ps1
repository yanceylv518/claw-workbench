param(
  [string]$OutputDir = "dist\product",
  [string]$PackageName = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $root $OutputDir
$stage = Join-Path $outputRoot "claw-workbench"
$upgradeStage = Join-Path $outputRoot "claw-workbench-overlay-upgrade"
$versionConfig = Get-Content -Raw (Join-Path $root "VERSION.json") | ConvertFrom-Json
$productVersion = $versionConfig.version
$productNameZh = -join @([char]0x5C0F, [char]0x9F99, [char]0x867E, [char]0x672C, [char]0x5730, [char]0x7248)
$upgradePackageSuffixZh = -join @([char]0x8986, [char]0x76D6, [char]0x5347, [char]0x7EA7, [char]0x5305)
$upgradeLauncherNameZh = (-join @([char]0x5347, [char]0x7EA7)) + $productNameZh + ".bat"
$upgradeReadmeNameZh = (-join @([char]0x5347, [char]0x7EA7, [char]0x8BF4, [char]0x660E)) + ".md"
$launcherNameZh = (-join @([char]0x542F, [char]0x52A8)) + $productNameZh + ".bat"
if (-not $PackageName) {
  $PackageName = "$productNameZh-Windows-v$productVersion-$upgradePackageSuffixZh.zip"
}

function Write-Utf8NoBomText($target, $text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($target, $text, $encoding)
}

function Write-Utf8NoBomJson($target, $value, $depth = 6) {
  Write-Utf8NoBomText $target ($value | ConvertTo-Json -Depth $depth)
}

function Get-RelativePathForManifest($basePath, $filePath) {
  $baseUri = [System.Uri]((Resolve-Path $basePath).Path.TrimEnd('\') + '\')
  $fileUri = [System.Uri]((Resolve-Path $filePath).Path)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fileUri).ToString()).Replace('/', '\')
}

function Write-PackageManifest($targetRoot, $packageKind) {
  $version = $productVersion
  $builtAt = (Get-Date).ToUniversalTime().ToString("o")
  $excluded = @(
    "data\",
    "logs\",
    "notion-ai-intel.config.json",
    "wechat-bridge.config.json",
    "package-lock.json",
    "manifest.json",
    "version.json"
  )

  $files = Get-ChildItem -LiteralPath $targetRoot -Recurse -File |
    ForEach-Object {
      $relative = Get-RelativePathForManifest $targetRoot $_.FullName
      $skip = $false
      foreach ($pattern in $excluded) {
        if ($relative -eq $pattern -or $relative.StartsWith($pattern)) {
          $skip = $true
          break
        }
      }
      if ($skip) { return }
      [ordered]@{
        path = $relative
        size = $_.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
      }
    } |
    Sort-Object { $_.path }

  Write-Utf8NoBomJson (Join-Path $targetRoot "version.json") ([ordered]@{
    product = "claw-workbench"
    name = $productNameZh
    version = $version
    packageKind = $packageKind
    builtAt = $builtAt
  }) 5

  Write-Utf8NoBomJson (Join-Path $targetRoot "manifest.json") ([ordered]@{
    product = "claw-workbench"
    version = $version
    packageKind = $packageKind
    builtAt = $builtAt
    files = @($files)
  }) 6
}

if (-not (Test-Path $stage)) {
  throw "Full product stage not found. Run scripts\package-local-product.ps1 first: $stage"
}

if (Test-Path $upgradeStage) {
  Remove-Item -LiteralPath $upgradeStage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $upgradeStage | Out-Null

$excludeRoot = @(
  "data",
  "logs",
  "notion-ai-intel.config.json",
  "wechat-bridge.config.json",
  "package-lock.json"
)

Get-ChildItem -LiteralPath $stage -Force | ForEach-Object {
  if ($excludeRoot -contains $_.Name) { return }
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $upgradeStage $_.Name) -Recurse -Force
}

Copy-Item -LiteralPath (Join-Path $root "scripts\install-upgrade-package.ps1") -Destination (Join-Path $upgradeStage "install-upgrade-package.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "scripts\install-upgrade-package.bat") -Destination (Join-Path $upgradeStage $upgradeLauncherNameZh) -Force

$readmeBase64 = "IyDlsI/pvpnomb7mnKzlnLDniYjopobnm5bljYfnuqfljIUKCui/meS4quWMheeUqOS6juWNh+e6p+W3sue7j+WuieijheWlveeahOWwj+m+meiZvu+8jOS4jeW7uuiuruebtOaOpeWcqOacrOebruW9leWQr+WKqOWwj+m+meiZvuOAggoKIyMg5q2j56Gu5Y2H57qn5pa55byPCgoxLiDop6PljovmnKzopobnm5bljYfnuqfljIXjgIIKMi4g5Y+M5Ye74oCc5Y2H57qn5bCP6b6Z6Jm+5pys5Zyw54mILmJhdOKAneOAggozLiDmjInmj5DnpLrovpPlhaXljp/lsI/pvpnomb7lronoo4Xnm67lvZXvvIzkvovlpoLvvJpEOlxYaWFvbG9uZ3hpYSDmiJYgRTpc6b6Z6Jm+XOWwj+m+meiZvuacrOWcsOeJiC1XaW5kb3dzLXYwLjEuMOOAggo0LiDohJrmnKzkvJrlhYjlgZzmraLml6fmnI3liqHvvIzlho3opobnm5bnqIvluo/mlofku7bjgIIKNS4g5Y2H57qn5a6M5oiQ5ZCO77yM6ISa5pys5Lya5pi+56S65bqU6K+l6L+b5YWl55qE55uu5b2V44CCCjYuIOivt+WIsOWImuaJjei+k+WFpeeahOWOn+WuieijheebruW9le+8jOWPjOWHu+KAnOWQr+WKqOWwj+m+meiZvi5iYXTigJ3jgIIKCiMjIOmHjeimgeaPkOmGkgoK5LiN6KaB5Zyo4oCc6KaG55uW5Y2H57qn5YyF4oCd6Kej5Y6L55uu5b2V6YeM5ZCv5Yqo5bCP6b6Z6Jm+44CC6KaG55uW5Y2H57qn5YyF55uu5b2V5Y+q55So5LqO5omn6KGM5Y2H57qn77yM5LiN5piv5a6e6ZmF6L+Q6KGM55uu5b2V44CCCgrlpoLmnpzkvaDnnIvliLDot6/lvoTph4zljIXlkKvigJzlsI/pvpnomb7mnKzlnLDniYgtV2luZG93cy12MC4xLjAt6KaG55uW5Y2H57qn5YyF4oCd77yM6K+05piO5ZCv5Yqo5L2N572u6ZSZ5LqG44CC6K+35Zue5Yiw5Y6f5a6J6KOF55uu5b2V6L+Q6KGM44CCCgojIyDljYfnuqfml7bkvJrkv53nlZkKCi0g5qih5Z6LIEFQSSDphY3nva4KLSBOb3Rpb24g6YWN572uCi0g5b6u5L+h6YWN572uCi0g5pys5Zyw5Lu75YqhCi0g5Y+R5biD5YyFCi0g5Zu+54mH57Sg5p2QCi0g55+l6K+G5bqTCi0g5oOF5oql5bqTCi0g5pel5b+XCgojIyDljYfnuqfml7bkvJropobnm5YKCi0g5YmN56uv6aG16Z2iCi0g5ZCO56uvIEFQSQotIOW3peS9nOa1geiEmuacrAotIOmihOWhq+iEmuacrAotIE5vZGUg6L+Q6KGM5pe2Ci0gUHl0aG9uICsgUGxheXdyaWdodCDov5DooYzml7YK"
$readme = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($readmeBase64))
$encoding = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText((Join-Path $upgradeStage $upgradeReadmeNameZh), $readme, $encoding)

$guardBase64 = "6L+Z5piv6KaG55uW5Y2H57qn5YyF55uu5b2V77yM5LiN6IO95Zyo6L+Z6YeM55u05o6l5ZCv5Yqo5bCP6b6Z6Jm+44CCCgror7flhYjlj4zlh7vmnKznm67lvZXph4znmoTigJzljYfnuqflsI/pvpnomb7mnKzlnLDniYguYmF04oCd44CCCuWNh+e6p+aXtui+k+WFpeS9oOeahOWOn+WuieijheebruW9le+8jOS+i+Wmgu+8mgpEOlxYaWFvbG9uZ3hpYQrmiJYKRTpc6b6Z6Jm+XOWwj+m+meiZvuacrOWcsOeJiC1XaW5kb3dzLXYwLjEuMAoK5Y2H57qn5a6M5oiQ5ZCO77yM6K+36L+b5YWl5L2g6L6T5YWl55qE5Y6f5a6J6KOF55uu5b2V77yM5YaN5Y+M5Ye74oCc5ZCv5Yqo5bCP6b6Z6Jm+LmJhdOKAneOAggo="
$guardScriptBase64 = "JGd1YXJkQmFzZTY0ID0gIjZMK1o1cGl2NkthRzU1dVc1WTJINTdxbjVZeUY1NXV1NWIyVjc3eU01TGlONklPOTVaeW82TCtaNlllTTU1dTA1bzZsNVpDdjVZcW81YkNQNmI2WjZKbSs0NENDQ2dyb3I3ZmxoWWpsajR6bGg3dm1uS3pubTY3bHZaWHBoNHpubW9UaWdKemxqWWZudXFmbHNJL3B2cG5vbWI3bW5LemxuTERuaVlndVltRjA0b0NkNDRDQ0N1V05oK2U2cCthWHR1aStrK1dGcGVTOW9PZWFoT1dPbitXdWllaWpoZWVicnVXOWxlKzhqT1MraStXbWd1KzhtZ3BFT2x4WWFXRnZiRzl1WjNocFlRcm1pSllLUlRwYzZiNlo2Sm0rWE9Xd2orbSttZWladnVhY3JPV2NzT2VKaUMxWGFXNWtiM2R6TFhZd0xqRXVNQW9LNVkySDU3cW41YTZNNW9pUTVaQ083N3lNNksrMzZMK2I1WVdsNUwyZzZMNlQ1WVdsNTVxRTVZNmY1YTZKNktPRjU1dXU1YjJWNzd5TTVZYU41WStNNVllNzRvQ2M1WkN2NVlxbzViQ1A2YjZaNkptK0xtSmhkT0tBbmVPQWdnbz0iCiR0ZXh0ID0gW1N5c3RlbS5UZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW1N5c3RlbS5Db252ZXJ0XTo6RnJvbUJhc2U2NFN0cmluZygkZ3VhcmRCYXNlNjQpKQpXcml0ZS1Ib3N0ICIiCldyaXRlLUhvc3QgJHRleHQKV3JpdGUtSG9zdCAiIgpSZWFkLUhvc3QgIlByZXNzIEVudGVyIHRvIGV4aXQiCg=="
$guardScript = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($guardScriptBase64))
Write-Utf8NoBomText (Join-Path $upgradeStage "start-xiaolongxia.ps1") ($guardScript + "`r`n")
@(
  "@echo off",
  "setlocal",
  "cd /d %~dp0",
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0start-xiaolongxia.ps1""",
  "pause"
) | Set-Content -Path (Join-Path $upgradeStage $launcherNameZh) -Encoding ascii

Write-PackageManifest $upgradeStage "overlay-upgrade"

$archive = Join-Path $outputRoot $PackageName
if (Test-Path $archive) {
  Remove-Item -LiteralPath $archive -Force
}
Compress-Archive -Path (Join-Path $upgradeStage "*") -DestinationPath $archive -Force
Write-Host "Overlay upgrade package ready: $archive"

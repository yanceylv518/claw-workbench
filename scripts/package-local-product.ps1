param(
  [string]$NodeVersion = "24.14.1",
  [string]$PythonVersion = "3.12.10",
  [string]$OutputDir = "dist\product",
  [string]$PackageName = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $root $OutputDir
$stage = Join-Path $outputRoot "claw-workbench"
$cache = Join-Path $root ".packaging-cache"
$nodeName = "node-v$NodeVersion-win-x64"
$nodeZip = Join-Path $cache "$nodeName.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip"
$pythonName = "python-$PythonVersion-embed-amd64"
$pythonZip = Join-Path $cache "$pythonName.zip"
$pythonUrl = "https://www.python.org/ftp/python/$PythonVersion/$pythonName.zip"
$getPipPath = Join-Path $cache "get-pip.py"
$getPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$versionConfig = Get-Content -Raw (Join-Path $root "VERSION.json") | ConvertFrom-Json
$productVersion = $versionConfig.version
$productNameZh = [string]::Concat([char]0x5C0F, [char]0x9F99, [char]0x867E, [char]0x672C, [char]0x5730, [char]0x7248)
$userGuideNameZh = [string]::Concat($productNameZh, [char]0x4F7F, [char]0x7528, [char]0x8BF4, [char]0x660E, ".md")
$launcherNameZh = [string]::Concat([char]0x542F, [char]0x52A8, [char]0x5C0F, [char]0x9F99, [char]0x867E, ".bat")
$stopperNameZh = [string]::Concat([char]0x505C, [char]0x6B62, [char]0x5C0F, [char]0x9F99, [char]0x867E, ".bat")
$migrationNameZh = (-join @([char]0x8FC1, [char]0x79FB, [char]0x65E7, [char]0x6570, [char]0x636E, [char]0x5230, [char]0x5F53, [char]0x524D, [char]0x7248, [char]0x672C)) + ".bat"
if (-not $PackageName) {
  $PackageName = "$productNameZh-Windows-v$productVersion.zip"
}

function Copy-Dir($source, $target) {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force
}

function Invoke-Native($filePath, $arguments) {
  & $filePath @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $filePath $($arguments -join ' ')"
  }
}

function Write-Utf8NoBomText($target, $text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($target, $text, $encoding)
}

function Write-Utf8NoBomJson($target, $value, $depth = 6) {
  Write-Utf8NoBomText $target ($value | ConvertTo-Json -Depth $depth)
}

function Write-FirstRunGuide($targetRoot) {
  Copy-Utf8WithBom (Join-Path $root "scripts\product-first-run.zh.txt") (Join-Path $targetRoot "README-FIRST-RUN.txt")
}

function Write-UserManual($targetRoot) {
  Copy-Utf8WithBom (Join-Path $root "scripts\product-user-guide.zh.md") (Join-Path $targetRoot $userGuideNameZh)
}

function Append-MigrationGuide($targetRoot) {
  $manualPath = Join-Path $targetRoot $userGuideNameZh
  $sectionBase64 = "IyMg5o6o6I2Q5Y2H57qn5pa55byP77ya6L+B56e75Yiw5paw55uu5b2VCgrlpoLmnpzkvaDmg7Pkv53nlZnml6fniYjmnKznm67lvZXvvIzmjqjojZDkvb/nlKjov5nnp43mlrnlvI/ljYfnuqfjgIIKCjEuIOino+WOi+aWsOeahOWujOaVtOWuieijheWMheWIsOS4gOS4quaWsOebruW9le+8jOS+i+Wmgu+8mkQ6XFhpYW9sb25neGlhLW5ld+OAggoyLiDov5vlhaXmlrDnm67lvZXvvIzlj4zlh7vigJzov4Hnp7vml6fmlbDmja7liLDlvZPliY3niYjmnKwuYmF04oCd44CCCjMuIOaMieaPkOekuui+k+WFpeaXp+eJiOacrOWuieijheebruW9le+8jOS+i+Wmgu+8mkQ6XFhpYW9sb25neGlh44CCCjQuIOiEmuacrOS8muWkjeWItuaXp+eJiOacrOS4reeahCBkYXRh44CBbG9nc+OAgeW+ruS/oeeKtuaAgeOAgU5vdGlvbiDphY3nva7lkozmqKHlnovphY3nva7liLDlvZPliY3mlrDnm67lvZXjgIIKNS4g6L+B56e75a6M5oiQ5ZCO77yM5Zyo5paw55uu5b2V5Y+M5Ye74oCc5ZCv5Yqo5bCP6b6Z6Jm+LmJhdOKAneOAggo2LiDnoa7orqTmlrDniYjmnKzov5DooYzmraPluLjlkI7vvIzlho3lhrPlrprmmK/lkKbliKDpmaTml6fnm67lvZXjgIIKCui/meenjeaWueW8j+S4jeS8muimhuebluaXp+eJiOacrOeoi+W6j++8jOmAguWQiOato+W8j+S6pOS7mOWSjOWuouaIt+eOsOWcuuWNh+e6p+OAggoKIyMg5b+r6YCf5Y2H57qn5pa55byP77ya6KaG55uW5pen55uu5b2VCgrlpoLmnpzkvaDnoa7lrpropoHnm7TmjqXljYfnuqfljp/nm67lvZXvvIzlj6/ku6Xkvb/nlKjopobnm5bljYfnuqfljIXjgIIKCjEuIOino+WOi+KAnOimhuebluWNh+e6p+WMheKAneOAggoyLiDlj4zlh7vigJzljYfnuqflsI/pvpnomb7mnKzlnLDniYguYmF04oCd44CCCjMuIOi+k+WFpeWOn+WuieijheebruW9leOAggo0LiDljYfnuqflrozmiJDlkI7vvIzlm57liLDljp/lronoo4Xnm67lvZXvvIzlj4zlh7vigJzlkK/liqjlsI/pvpnomb4uYmF04oCd44CCCgrms6jmhI/vvJropobnm5bljYfnuqfljIXnm67lvZXkuI3og73nm7TmjqXov5DooYzlsI/pvpnomb7vvIzlroPlj6rnlKjkuo7ljYfnuqfml6fnm67lvZXjgIIK"
  $section = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($sectionBase64))
  $encoding = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::AppendAllText($manualPath, "`r`n$section", $encoding)
}

function Write-Launcher($targetRoot) {
  @(
    "@echo off",
    "setlocal",
    "cd /d %~dp0",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0start-xiaolongxia.ps1""",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Xiaolongxia failed to start. Please check logs\api.err.log.",
    "  pause",
    ")"
  ) | Set-Content -Path (Join-Path $targetRoot $launcherNameZh) -Encoding ascii
}

function Write-Stopper($targetRoot) {
  @(
    "@echo off",
    "setlocal",
    "cd /d %~dp0",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0stop-xiaolongxia.ps1""",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Xiaolongxia failed to stop.",
    "  pause",
    ")"
  ) | Set-Content -Path (Join-Path $targetRoot $stopperNameZh) -Encoding ascii
}

function Write-MigrationLauncher($targetRoot) {
  @(
    "@echo off",
    "setlocal",
    "cd /d %~dp0",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0migrate-old-product-data.ps1""",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Migration failed.",
    "  pause",
    ")"
  ) | Set-Content -Path (Join-Path $targetRoot $migrationNameZh) -Encoding ascii
}

function Write-ProductPackageJson($targetRoot) {
  $packageJson = [ordered]@{
    name = "claw-workbench"
    version = $productVersion
    private = $true
    type = "module"
    scripts = [ordered]@{
      start = "node apps/api/local-server.mjs"
    }
    dependencies = [ordered]@{
      "node-edge-tts" = "^1.2.10"
      "qrcode-terminal" = "^0.12.0"
      "silk-wasm" = "^3.7.1"
    }
  }
  Write-Utf8NoBomJson (Join-Path $targetRoot "package.json") $packageJson 5
}

function Write-DefaultProductConfigs($targetRoot) {
  $notionConfig = [ordered]@{
    enabled = $false
    feed_urls = @()
    fetch_limit = 12
    notion = [ordered]@{
      token = ""
      database_id = ""
      property_map = [ordered]@{}
    }
    content_publish = [ordered]@{
      token = ""
      database_id = ""
      property_map = [ordered]@{}
    }
    xiaohongshu = [ordered]@{
      enable_notion = $false
      sync_notion_during_workflow = $false
    }
    hermes = [ordered]@{
      enabled = $false
      mode = "research"
      provider = "llm"
      command = "hermes"
      wsl_distro = "Ubuntu"
      worker_url = "http://127.0.0.1:3307"
      timeout_seconds = 180
      fallback_on_error = $true
    }
    image_generation = [ordered]@{
      enabled = $false
      provider = "openai"
      api_key = ""
      base_url = ""
      model = ""
      response_format = "b64_json"
      size = "1024x1024"
      quality = "high"
      n = 1
      aspect_ratio = "1:1"
      image_size = "1024x1024"
      generate_body_images = $false
      max_generated_images = 3
    }
    assistant_api = [ordered]@{
      enabled = $false
      provider_id = ""
      api_key = ""
      base_url = ""
      model = ""
    }
    workflow = [ordered]@{
      model_timeout_seconds = 180
      skill_profile = "standard"
      skill_notes = ""
      enable_skill_fallback = $true
      skills = [ordered]@{
        deliveryGate = [ordered]@{
          enabled = $false
        }
      }
    }
  }

  $bridgeConfig = [ordered]@{
    active_mode = "third-party-api"
    modes = [ordered]@{
      "third-party-api" = [ordered]@{
        type = "provider"
        provider_id = ""
        model = ""
        label = "Third-party API"
      }
    }
    assistant = [ordered]@{
      default_city = ""
      weather_enabled = $true
    }
  }

  $openclawHome = Join-Path $targetRoot "data\openclaw"
  New-Item -ItemType Directory -Force -Path $openclawHome | Out-Null

  Write-Utf8NoBomJson (Join-Path $targetRoot "notion-ai-intel.config.json") $notionConfig 8
  Write-Utf8NoBomJson (Join-Path $targetRoot "wechat-bridge.config.json") $bridgeConfig 6
  Write-Utf8NoBomJson (Join-Path $openclawHome "openclaw.json") @{ models = @{ providers = @{} } } 5
}

function Copy-Utf8WithBom($source, $target) {
  $bytes = [System.IO.File]::ReadAllBytes($source)
  $bom = [byte[]](0xEF, 0xBB, 0xBF)
  $output = New-Object byte[] ($bom.Length + $bytes.Length)
  [Array]::Copy($bom, 0, $output, 0, $bom.Length)
  [Array]::Copy($bytes, 0, $output, $bom.Length, $bytes.Length)
  [System.IO.File]::WriteAllBytes($target, $output)
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

function Enable-EmbeddablePythonSite($pythonRoot) {
  $pth = Get-ChildItem -Path $pythonRoot -Filter "python*._pth" | Select-Object -First 1
  if (-not $pth) {
    throw "Python embeddable _pth file not found in $pythonRoot"
  }
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($line in [System.IO.File]::ReadAllLines($pth.FullName)) {
    if ($line.Trim() -eq "#import site") {
      if (-not $lines.Contains("Lib\site-packages")) {
        $lines.Add("Lib\site-packages")
      }
      $lines.Add("import site")
    } else {
      $lines.Add($line)
    }
  }
  if (-not ($lines | Where-Object { $_.Trim() -eq "import site" })) {
    if (-not $lines.Contains("Lib\site-packages")) {
      $lines.Add("Lib\site-packages")
    }
    $lines.Add("import site")
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($pth.FullName, $lines, $encoding)
}

Push-Location $root
try {
  Invoke-Native "npm" @("run", "web:build")

  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  if (-not (Test-Path $nodeZip)) {
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
  }
  if (-not (Test-Path $pythonZip)) {
    Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonZip
  }
  if (-not (Test-Path $getPipPath)) {
    Invoke-WebRequest -Uri $getPipUrl -OutFile $getPipPath
  }

  New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
  if (Test-Path $stage) {
    $resolvedStage = (Resolve-Path $stage).Path
    $resolvedOutput = (Resolve-Path $outputRoot).Path
    if (-not $resolvedStage.StartsWith($resolvedOutput)) {
      throw "Refusing to remove unexpected path: $resolvedStage"
    }
    Remove-Item -LiteralPath $stage -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "apps") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "runtime") | Out-Null

  Copy-Dir (Join-Path $root "apps\api") (Join-Path $stage "apps\api")
  Copy-Dir (Join-Path $root "apps\hermes-worker") (Join-Path $stage "apps\hermes-worker")
  Copy-Dir (Join-Path $root "apps\web\dist") (Join-Path $stage "apps\web\dist")
  Copy-Dir (Join-Path $root "packages") (Join-Path $stage "packages")

  Write-ProductPackageJson $stage
  Write-DefaultProductConfigs $stage
  Copy-Item (Join-Path $root "console-server.mjs") (Join-Path $stage "console-server.mjs") -Force
  Copy-Item (Join-Path $root "xiaohongshu-draft-workflow.mjs") (Join-Path $stage "xiaohongshu-draft-workflow.mjs") -Force
  Copy-Item (Join-Path $root "xiaohongshu-prefill-publish.py") (Join-Path $stage "xiaohongshu-prefill-publish.py") -Force
  Copy-Item (Join-Path $root "prefill-xiaohongshu-publish.ps1") (Join-Path $stage "prefill-xiaohongshu-publish.ps1") -Force
  Copy-Item (Join-Path $root "notion-ai-intel-workflow.mjs") (Join-Path $stage "notion-ai-intel-workflow.mjs") -Force
  Copy-Item (Join-Path $root "finance-news-workflow.mjs") (Join-Path $stage "finance-news-workflow.mjs") -Force
  Copy-Item (Join-Path $root "openclaw-agent-client.mjs") (Join-Path $stage "openclaw-agent-client.mjs") -Force
  Copy-Item (Join-Path $root "wechat-direct-bridge.mjs") (Join-Path $stage "wechat-direct-bridge.mjs") -Force
  Copy-Item (Join-Path $root "start-wechat-direct-bridge.ps1") (Join-Path $stage "start-wechat-direct-bridge.ps1") -Force
  Copy-Item (Join-Path $root "stop-wechat-direct-bridge.ps1") (Join-Path $stage "stop-wechat-direct-bridge.ps1") -Force
  Copy-Item (Join-Path $root "scripts\start-xiaolongxia-product.ps1") (Join-Path $stage "start-xiaolongxia.ps1") -Force
  Copy-Item (Join-Path $root "scripts\stop-xiaolongxia-product.ps1") (Join-Path $stage "stop-xiaolongxia.ps1") -Force
  Copy-Item (Join-Path $root "scripts\migrate-old-product-data.ps1") (Join-Path $stage "migrate-old-product-data.ps1") -Force
  Write-Launcher $stage
  Write-Stopper $stage
  Write-MigrationLauncher $stage
  Write-FirstRunGuide $stage
  Write-UserManual $stage
  Append-MigrationGuide $stage

  Expand-Archive -Path $nodeZip -DestinationPath (Join-Path $stage "runtime") -Force
  Move-Item -Path (Join-Path $stage "runtime\$nodeName") -Destination (Join-Path $stage "runtime\node") -Force

  $pythonRoot = Join-Path $stage "runtime\python"
  New-Item -ItemType Directory -Force -Path $pythonRoot | Out-Null
  Expand-Archive -Path $pythonZip -DestinationPath $pythonRoot -Force
  Enable-EmbeddablePythonSite $pythonRoot
  $python = Join-Path $pythonRoot "python.exe"
  Invoke-Native $python @($getPipPath, "--no-warn-script-location")
  Invoke-Native $python @("-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", "playwright==1.52.0")

  $npm = Join-Path $stage "runtime\node\npm.cmd"
  Push-Location $stage
  try {
    Invoke-Native $npm @("install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund")
  } finally {
    Pop-Location
  }

  Write-PackageManifest $stage "full"

  $archive = Join-Path $outputRoot $PackageName
  if (Test-Path $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -Force
  Write-Host "Product package ready: $archive"
} finally {
  Pop-Location
}

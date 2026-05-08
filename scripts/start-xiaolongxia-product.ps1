$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root "runtime\node\node.exe"
if (-not (Test-Path $node)) {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
}

$env:XIAOLONGXIA_LOCAL_API_PORT = if ($env:XIAOLONGXIA_LOCAL_API_PORT) { $env:XIAOLONGXIA_LOCAL_API_PORT } else { "3200" }
$env:XIAOLONGXIA_WEB_DIST = Join-Path $root "apps\web\dist"
$env:XIAOLONGXIA_DATA_DIR = Join-Path $root "data\runtime"
$env:OPENCLAW_HOME = Join-Path $root "data\openclaw"

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $env:XIAOLONGXIA_DATA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $env:OPENCLAW_HOME | Out-Null

function Write-JsonIfMissing($path, $value, $depth = 6) {
  if (Test-Path $path) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth $depth), $encoding)
}

function Initialize-ProductConfigs {
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

  Write-JsonIfMissing (Join-Path $root "notion-ai-intel.config.json") $notionConfig 8
  Write-JsonIfMissing (Join-Path $root "wechat-bridge.config.json") $bridgeConfig 6
  Write-JsonIfMissing (Join-Path $env:OPENCLAW_HOME "openclaw.json") @{ models = @{ providers = @{} } } 5
}

Initialize-ProductConfigs

$url = "http://127.0.0.1:$($env:XIAOLONGXIA_LOCAL_API_PORT)/"
$healthUrl = "http://127.0.0.1:$($env:XIAOLONGXIA_LOCAL_API_PORT)/api/local/health"
$escapedRoot = [regex]::Escape($root)
$consolePort = if ($env:XLX_CONSOLE_PORT) { $env:XLX_CONSOLE_PORT } else { "3100" }

function Get-PortListenerProcessIds {
  try {
    Get-NetTCPConnection -LocalPort ([int]$env:XIAOLONGXIA_LOCAL_API_PORT) -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -ne 0 }
  } catch {
    @()
  }
}

function Get-ProcessInfoById($processId) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
}

function Test-IsCurrentFolderProcess($proc) {
  if (-not $proc) { return $false }
  if ($proc.ExecutablePath -and $proc.ExecutablePath -match $escapedRoot) { return $true }
  if ($proc.CommandLine -and $proc.CommandLine -match $escapedRoot) { return $true }
  return $false
}

function Test-XiaolongxiaHealth {
  try {
    Invoke-WebRequest -UseBasicParsing $healthUrl -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-CurrentApiProcess {
  foreach ($ownerPid in Get-PortListenerProcessIds) {
    $proc = Get-ProcessInfoById $ownerPid
    if (Test-IsCurrentFolderProcess $proc) {
      return $proc
    }
  }
  return $null
}

function Get-CurrentConsoleProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match "^node(\.exe)?$" -and
      $_.CommandLine -and
      $_.CommandLine -match "console-server\.mjs" -and
      (Test-IsCurrentFolderProcess $_)
    } |
    Select-Object -First 1
}

function Start-ConsoleServerIfNeeded {
  if (Get-CurrentConsoleProcess) { return }
  Start-Process `
    -FilePath $node `
    -ArgumentList @("console-server.mjs") `
    -WorkingDirectory $root `
    -WindowStyle Hidden
  Start-Sleep -Milliseconds 800
}

function Stop-ExistingXiaolongxia {
  $patterns = @(
    "apps[/\\]api[/\\]local-server\.mjs",
    "console-server\.mjs",
    "wechat-direct-bridge\.mjs"
  )
  $processes = @(Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -match "^node(\.exe)?$" -and
      $_.CommandLine -and
      ($patterns | Where-Object { $_.CommandLine -match $_ })
    })

  foreach ($ownerPid in Get-PortListenerProcessIds) {
    $proc = Get-ProcessInfoById $ownerPid
    if ($proc -and -not ($processes | Where-Object { $_.ProcessId -eq $proc.ProcessId })) {
      $processes += $proc
    }
  }

  foreach ($proc in $processes) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Host "Failed to stop old PID $($proc.ProcessId): $($_.Exception.Message)"
    }
  }
}

$currentApi = Get-CurrentApiProcess
if ($currentApi -and (Test-XiaolongxiaHealth)) {
  Start-ConsoleServerIfNeeded
  if (-not $env:XIAOLONGXIA_NO_OPEN) {
    Start-Process $url
  }
  Write-Host "Xiaolongxia is already running from this folder: $url"
  exit 0
}

if (Test-XiaolongxiaHealth) {
  Write-Host "Another Xiaolongxia instance is using this port. Restarting with this folder..."
}

Stop-ExistingXiaolongxia
Start-Sleep -Milliseconds 800

Start-Process `
  -FilePath $node `
  -ArgumentList @("apps/api/local-server.mjs") `
  -WorkingDirectory $root `
  -WindowStyle Hidden

Start-ConsoleServerIfNeeded

Start-Sleep -Seconds 2
try {
  Invoke-WebRequest -UseBasicParsing $healthUrl -TimeoutSec 8 | Out-Null
  if (-not $env:XIAOLONGXIA_NO_OPEN) {
    Start-Process $url
  }
  Write-Host "Xiaolongxia started: $url"
  Write-Host "Console adapter started: http://127.0.0.1:$consolePort/"
} catch {
  Write-Host "Xiaolongxia API did not become ready. See logs in $logDir"
  throw
}

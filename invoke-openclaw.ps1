[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArgs
)

$ErrorActionPreference = 'Stop'

if (-not $env:OPENCLAW_CMD) {
  throw 'OPENCLAW_CMD is not set.'
}

& $env:OPENCLAW_CMD @CliArgs
exit $LASTEXITCODE

[CmdletBinding()]
param(
  [switch]$Rotate,
  [switch]$Ci,
  [switch]$SkipDigests
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  x node is not on PATH. Install Node 20 or later, then run this again." -ForegroundColor Red
  exit 1
}

$argv = @((Join-Path $Here 'stack.js'), 'bootstrap')
if ($Rotate) { $argv += '--rotate' }
if ($Ci) { $argv += '--ci' }

& $node.Source @argv
exit $LASTEXITCODE

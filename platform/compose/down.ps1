[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An interactive wrapper that prompts the operator at a terminal')]
[CmdletBinding()]
param(
  [switch]$DeleteData,
  [switch]$RemoveImages
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  x node is not on PATH. Install Node 20 or later, then run this again." -ForegroundColor Red
  exit 1
}

$stack = Join-Path $Here 'stack.js'
$argv = @($stack, 'down')
if ($RemoveImages) { $argv += '--images' }

if ($DeleteData) {
  & $node.Source $stack down --volumes
  Write-Host "  Type  destroy argus data  to confirm, or anything else to cancel." -ForegroundColor Yellow
  Write-Host "  > " -NoNewline
  $typed = [Console]::ReadLine()
  if ($typed -ne 'destroy argus data') {
    Write-Host "  Cancelled. Nothing was deleted." -ForegroundColor Green
    exit 0
  }
  $argv += @('--volumes', '--yes')
}

& $node.Source @argv
exit $LASTEXITCODE

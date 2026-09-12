[CmdletBinding()]
param(
  [switch]$DeleteData,
  [switch]$RemoveImages
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $known = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $known) { $env:Path = "$(Split-Path $known);$env:Path" }
  else { Write-Host "  Docker is not installed." -ForegroundColor Red; exit 1 }
}

$knownProfiles = @('cache','queues','secrets','observability','connect','compute','parity','targets')
$declaredProfiles = @()
$composeFile = Join-Path $Here 'docker-compose.yml'
if (Test-Path $composeFile) {
  foreach ($line in [IO.File]::ReadAllLines($composeFile)) {
    $m = [regex]::Match($line, '^\s*profiles:\s*\[(?<list>[^\]]*)\]\s*$')
    if ($m.Success) {
      foreach ($entry in ($m.Groups['list'].Value -split ',')) {
        $name = $entry.Trim().Trim('"').Trim("'")
        if ($name) { $declaredProfiles += $name }
      }
    }
  }
}
$profiles = @()
foreach ($name in (@($knownProfiles) + @($declaredProfiles) | Select-Object -Unique)) {
  $profiles += '--profile'
  $profiles += $name
}

function Remove-StackImages {
  Write-Host ""
  Write-Host "  Removing locally built images" -ForegroundColor Cyan
  docker image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=argus/*' |
    ForEach-Object { docker image rm $_ 2>&1 | Out-Null; Write-Host "    removed $_" }
}

if (-not $DeleteData) {
  Write-Host ""
  Write-Host "  Stopping the Argus stack. Data is kept." -ForegroundColor Cyan
  Write-Host ""
  docker compose @profiles down --remove-orphans
  $code = $LASTEXITCODE
  if ($RemoveImages) { Remove-StackImages }
  Write-Host ""
  Write-Host "  Stopped. Every volume is still here -- `docker compose up -d` resumes where this left off." -ForegroundColor Green
  Write-Host ""
  Write-Host "  To destroy the data too:  pwsh -File ./down.ps1 -DeleteData" -ForegroundColor DarkGray
  Write-Host ""
  exit $code
}

Write-Host ""
Write-Host "  DESTROY ALL STACK DATA" -ForegroundColor Red
Write-Host ""
Write-Host "  This deletes the named volumes below. There is no backup and no undo."
Write-Host ""

$volumes = @(docker volume ls --format '{{.Name}}' --filter 'name=argus_' 2>$null)
if (-not $volumes -or $volumes.Count -eq 0) {
  Write-Host "  No argus_* volumes exist. Nothing to destroy." -ForegroundColor Green
  Write-Host ""
  docker compose @profiles down --remove-orphans
  $code = $LASTEXITCODE
  if ($RemoveImages) { Remove-StackImages }
  exit $code
}

$sizes = @{}
try {
  docker system df -v --format '{{json .Volumes}}' 2>$null | ConvertFrom-Json | ForEach-Object {
    foreach ($v in $_) { $sizes[$v.Name] = $v.Size }
  }
} catch { }

foreach ($v in ($volumes | Sort-Object)) {
  $size = if ($sizes.ContainsKey($v)) { $sizes[$v] } else { '?' }
  $what = switch -Wildcard ($v) {
    '*seaweed_volume*'  { 'every object in every bucket' }
    '*seaweed_filer*'   { 'the filer metadata -- without it the objects are unreadable even if intact' }
    '*seaweed_master*'  { 'volume topology' }
    '*pg_data*'         { 'every database, table and row' }
    '*nats_data*'       { 'every stream and every un-acked message' }
    '*openbao_data*'    { 'every secret, and the raft that holds them' }
    '*openbao_seal*'    { 'the unseal key -- WITHOUT IT THE SECRETS ARE UNRECOVERABLE' }
    '*garnet_data*'     { 'the cache (safe to lose)' }
    '*guac_recordings*' { 'recorded RDP/SSH sessions -- these are audit evidence' }
    '*prometheus_data*' { 'metric history' }
    '*loki_data*'       { 'log history' }
    '*grafana_data*'    { 'dashboards and Grafana users' }
    default             { '' }
  }
  '    {0,-26} {1,10}   {2}' -f $v, $size, $what | Write-Host
}

Write-Host ""
Write-Host "  Type  destroy argus data  to confirm, or anything else to cancel." -ForegroundColor Yellow
Write-Host "  > " -NoNewline
$typed = [Console]::ReadLine()

if ($typed -ne 'destroy argus data') {
  Write-Host ""
  Write-Host "  Cancelled. Nothing was deleted." -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ""
docker compose @profiles down --volumes --remove-orphans

if ($RemoveImages) { Remove-StackImages }

Write-Host ""
Write-Host "  Destroyed. Run bootstrap.ps1 -Rotate before bringing the stack up again:" -ForegroundColor Green
Write-Host "  the old .env holds passwords for roles and buckets that no longer exist." -ForegroundColor DarkGray
Write-Host ""

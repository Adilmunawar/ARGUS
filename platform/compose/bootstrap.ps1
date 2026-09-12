[CmdletBinding()]
param(
  [switch]$Rotate,
  [switch]$SkipDigests
)

$ErrorActionPreference = 'Stop'

$Here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $Here '..\..')).Path
$EnvFile    = Join-Path $Here '.env'
$Example    = Join-Path $Here '.env.example'
$SecretsDir = Join-Path $Here 'secrets'

Set-Location $Here

$script:Warnings = @()

function Say  ([string]$m) { Write-Host "  $m" }
function Head ([string]$m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Warn ([string]$m) { $script:Warnings += $m; Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ([string]$m) { Write-Host ""; Write-Host "  x $m" -ForegroundColor Red; Write-Host ""; exit 1 }

$script:Rng = [Security.Cryptography.RandomNumberGenerator]::Create()

function New-HexSecret {
  param([int]$Bytes = 24)
  $b = New-Object byte[] $Bytes
  $script:Rng.GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

function New-Base64Secret {
  param([int]$Bytes = 32)
  $b = New-Object byte[] $Bytes
  $script:Rng.GetBytes($b)
  [Convert]::ToBase64String($b)
}

function Get-EnvValue {
  param([string]$Key)
  if (-not (Test-Path $EnvFile)) { return $null }
  $hit = Select-String -Path $EnvFile -Pattern "^$Key=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $hit) { return $null }
  return (($hit.Line -split '=', 2)[1] -split '#')[0].Trim()
}

function Write-TextNoBom {
  param([string]$Path, [string]$Text)
  $utf8 = New-Object Text.UTF8Encoding $false
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Write-FileSecret {
  param([string]$Name, [string]$Value)
  $p = Join-Path $SecretsDir $Name
  Write-TextNoBom -Path $p -Text $Value
  try {
    $acl = Get-Acl $p
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -Path $p -AclObject $acl
  } catch {
    Warn "could not restrict ACLs on secrets/$Name ($($_.Exception.Message))"
  }
}

Write-Host ""
Write-Host "  Argus stack bootstrap" -ForegroundColor Cyan
Write-Host "  $Here"

Head "1. Checking this machine"

$compose = Join-Path $Here 'docker-compose.yml'
if (-not (Test-Path $compose)) { Die "docker-compose.yml is not next to this script. Run it from platform/compose." }
if (-not (Test-Path $Example)) { Die ".env.example is missing. It is the template this script fills in." }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $known = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $known) {
    Warn "docker is not on this shell PATH but is installed. Using it directly -- open a new terminal to fix PATH."
    $env:Path = "$(Split-Path $known);$env:Path"
  } else {
    Die "Docker is not installed. Install Docker Desktop, then run this again."
  }
}
Say "docker cli      $(docker version --format '{{.Client.Version}}')"

$server = $null
try { $server = docker info --format '{{.ServerVersion}}' 2>$null } catch { }
if ($LASTEXITCODE -ne 0 -or -not $server) {
  Die "The Docker engine is not running. Start Docker Desktop, wait for the whale icon to stop animating, and run this again. On a fresh install this usually needs one reboot for WSL2 integration to come up."
}
Say "docker engine   $server"

$osType = docker info --format '{{.OSType}}'
if ($osType -ne 'linux') {
  Die "Docker is in $osType-container mode. Every image here is Linux. Switch containers from the Docker Desktop tray menu."
}

$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path $wslConfig) {
  $mem = Select-String -Path $wslConfig -Pattern '^\s*memory\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($mem) { Say "wslconfig       $($mem.Line.Trim())" }
  else { Warn "$wslConfig exists but sets no memory=. WSL2 will take half this machine RAM." }
} else {
  Warn "No $wslConfig. Create it with [wsl2] / memory=9GB / processors=6, then run 'wsl --shutdown'."
}

$subnet = '172.28.0.0/16'
if (Test-Path $EnvFile) {
  $existing = Select-String -Path $EnvFile -Pattern '^ARGUS_SUBNET=' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) { $subnet = (($existing.Line -split '=', 2)[1] -split '#')[0].Trim() }
}
$prefix = ($subnet -split '\.')[0..1] -join '.'
try {
  $clash = @(Get-NetRoute -ErrorAction SilentlyContinue |
             Where-Object { $_.DestinationPrefix -like "$prefix.*" -and $_.DestinationPrefix -ne $subnet })
  if ($clash.Count) {
    Warn "This machine already routes $prefix.x ($($clash[0].DestinationPrefix))."
    Warn "Set ARGUS_SUBNET in .env to an unused /16, or Docker will capture that traffic."
  } else {
    Say "subnet          $subnet is free"
  }
} catch {
  Warn "Could not read the routing table; check 'route print' for $prefix.x before the first up."
}

$ports = [ordered]@{
  'console'  = @('CONSOLE_PORT', 8787)
  'postgres' = @('PG_PORT', 5432)
  'garnet'   = @('GARNET_PORT', 6379)
  'nats'     = @('NATS_PORT', 4222)
  'openbao'  = @('OPENBAO_PORT', 8200)
}
foreach ($name in $ports.Keys) {
  $var = $ports[$name][0]
  $p   = $ports[$name][1]
  $override = Get-EnvValue $var
  if ($override) {
    $parsed = 0
    if ([int]::TryParse($override, [ref]$parsed) -and $parsed -gt 0 -and $parsed -lt 65536) {
      $p = $parsed
    } else {
      Warn "$var in .env is '$override', which is not a TCP port. Checking the default $p instead."
    }
  }
  $held = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($held) {
    $proc = Get-Process -Id $held.OwningProcess -ErrorAction SilentlyContinue
    $who = if ($proc) { "$($proc.ProcessName) (pid $($proc.Id))" } else { 'an unknown process' }
    Warn "port $p ($name, $var) is already held by $who. Change $var in .env."
  }
}

Head "2. Secrets"

if ((Test-Path $EnvFile) -and -not $Rotate) {
  Write-Host ""
  Write-Host "  .env already exists -- nothing was changed." -ForegroundColor Green
  Write-Host ""
  Write-Host "  That is deliberate. Regenerating secrets under a running stack does not" -ForegroundColor DarkGray
  Write-Host "  reset it; it locks you out of Grafana, breaks every Postgres role, and" -ForegroundColor DarkGray
  Write-Host "  401s every alert -- with error messages that blame something else." -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  To bring the stack up:    docker compose up -d"
  Write-Host "  To genuinely start over:  pwsh -File ./down.ps1 -DeleteData; pwsh -File ./bootstrap.ps1 -Rotate"
  Write-Host ""
  exit 0
}

if ($Rotate -and (Test-Path $EnvFile)) {
  Warn "-Rotate: overwriting the existing .env. Any stack still running on the old values will break."
}

if (-not (Test-Path $SecretsDir)) { [void](New-Item -ItemType Directory -Path $SecretsDir) }

$gitignore  = Join-Path $RepoRoot '.gitignore'
$ignoreLine = 'platform/compose/secrets/'
$ignoreText = if (Test-Path $gitignore) { [IO.File]::ReadAllText($gitignore) } else { '' }
if ($ignoreText -notmatch [regex]::Escape($ignoreLine)) {
  $add = "`n# Compose file-secrets: extensionless, so *.key and *.pem do not cover them.`n$ignoreLine`nplatform/compose/.env`nplatform/compose/images.lock`n"
  [IO.File]::AppendAllText($gitignore, $add, (New-Object Text.UTF8Encoding $false))
  Say "added $ignoreLine to .gitignore"
} else {
  Say "$ignoreLine already ignored"
}

$gen = [ordered]@{}
foreach ($k in @(
  'ARGUS_S3_ADMIN_SECRET','ARGUS_S3_CONSOLE_SECRET','ARGUS_S3_APP_SECRET',
  'ARGUS_S3_LOKI_SECRET','ARGUS_S3_GUAC_SECRET','ARGUS_S3_PARITY_SECRET',
  'ARGUS_S3_PARITY_DENY_SECRET','ARGUS_S3_PARITY_ADMIN_SECRET',
  'ARGUS_PG_APP_PASSWORD','ARGUS_PG_CONSOLE_PASSWORD','ARGUS_PG_EXPORTER_PASSWORD',
  'ARGUS_PG_GUAC_PASSWORD','ARGUS_PG_GRAFANA_PASSWORD','ARGUS_PG_PARITY_PASSWORD',
  'GARNET_CONSOLE_PASSWORD','NATS_ARGUS_PASSWORD','NATS_AGENT_PASSWORD'
)) { $gen[$k] = New-HexSecret 24 }

$gen['GUAC_JSON_SECRET_KEY'] = New-HexSecret 16
$gen['TARGET_SSH_PASSWORD']  = New-HexSecret 16
$gen['AZURITE_ACCOUNT_KEY']  = New-Base64Secret 32

$breakglassPassword = New-HexSecret 16
$saltBytes = New-Object byte[] 32
$script:Rng.GetBytes($saltBytes)
$saltHexUpper = -join ($saltBytes | ForEach-Object { $_.ToString('X2') })
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $material  = [Text.Encoding]::UTF8.GetBytes($breakglassPassword + $saltHexUpper)
  $hashBytes = $sha.ComputeHash($material)
} finally { $sha.Dispose() }
$gen['GUAC_BREAKGLASS_SALT_HEX'] = $saltHexUpper
$gen['GUAC_BREAKGLASS_HASH_HEX'] = -join ($hashBytes | ForEach-Object { $_.ToString('X2') })

$lines    = [IO.File]::ReadAllLines($Example)
$out      = New-Object 'System.Collections.Generic.List[string]'
$replaced = @{}

$memLimit = $null
foreach ($line in $lines) {
  $mm = [regex]::Match($line, '^GARNET_MEM_LIMIT=(?<v>[^\s#]+)')
  if ($mm.Success) { $memLimit = $mm.Groups['v'].Value }
}
$derived = [ordered]@{}
if (-not $memLimit) {
  Warn "GARNET_MEM_LIMIT is not in .env.example, so ARGUS_GARNET_MEM_LIMIT_BYTES could not be derived from it."
} else {
  $size = [regex]::Match($memLimit, '^(?<n>\d+)(?<u>[bkmgBKMG]?)$')
  if (-not $size.Success) {
    Warn "GARNET_MEM_LIMIT is '$memLimit', which is not a docker size. ARGUS_GARNET_MEM_LIMIT_BYTES is left as .env.example has it and may not match."
  } else {
    $scale = switch ($size.Groups['u'].Value.ToLower()) {
      'k'     { 1024 }
      'm'     { 1048576 }
      'g'     { 1073741824 }
      default { 1 }
    }
    $derived['ARGUS_GARNET_MEM_LIMIT_BYTES'] = ([int64]$size.Groups['n'].Value * [int64]$scale).ToString()
  }
}

$octets = ($subnet -split '/')[0] -split '\.'
$maskBits = 16
if ($subnet -match '/(?<bits>\d+)$') { $maskBits = [int]$Matches['bits'] }
$keptOctets = [Math]::Max(1, [Math]::Floor($maskBits / 8))
$derived['ARGUS_SUBNET_REGEX'] =
  '^' + (($octets[0..($keptOctets - 1)] | ForEach-Object { $_ }) -join '\.') + '\..*$'

foreach ($line in $lines) {
  $m = [regex]::Match($line, '^(?<key>[A-Z0-9_]+)=(?<val>[^#]*?)\s*(?<rest>#.*)?$')
  $key = if ($m.Success) { $m.Groups['key'].Value } else { '' }
  $val = $null
  if ($m.Success -and $gen.Contains($key))          { $val = $gen[$key] }
  elseif ($m.Success -and $derived.Contains($key))  { $val = $derived[$key] }
  if ($null -ne $val) {
    $rest = $m.Groups['rest'].Value
    if ($rest) {
      $pad = [Math]::Max(1, 37 - ($key.Length + 1 + $val.Length))
      $out.Add("$key=$val$(' ' * $pad)$rest")
    } else {
      $out.Add("$key=$val")
    }
    $replaced[$key] = $true
  } else {
    $out.Add($line)
  }
}

$missing = @(@($gen.Keys) + @($derived.Keys) | Where-Object { -not $replaced.ContainsKey($_) })
if ($missing.Count) {
  Die "These keys were generated but do not appear in .env.example, so nothing would consume them: $($missing -join ', ')"
}

$alertTemplate = Join-Path $Here 'services/observability/alertmanager/alertmanager.yml.tmpl'
$alertRendered = Join-Path $SecretsDir 'alertmanager.yml'
if (-not (Test-Path $alertTemplate)) {
  Die "The Alertmanager template is missing: $alertTemplate. docker-compose.yml bind-mounts ./secrets/alertmanager.yml and Alertmanager expands no environment variable of its own, so this script is the only thing that can render it. No .env and no secret were written. Restore the template, then run this again."
}
$envValues = @{}
foreach ($l in $out) {
  $em = [regex]::Match($l, '^(?<k>[A-Z0-9_]+)=(?<v>[^#]*?)\s*(#.*)?$')
  if ($em.Success) { $envValues[$em.Groups['k'].Value] = $em.Groups['v'].Value }
}
$alertKeyFor  = @{ 'SMTP_SMARTHOST' = @('SMTP_SMARTHOST', 'SMTP_HOST') }
$alertText    = [IO.File]::ReadAllText($alertTemplate)
$alertMissing = @()
$alertFilled  = @{}
foreach ($token in [regex]::Matches($alertText, '@@(?<k>[A-Z0-9_]+)@@')) {
  $placeholder = $token.Groups['k'].Value
  if ($alertFilled.ContainsKey($placeholder)) { continue }
  $keys = @(if ($alertKeyFor.ContainsKey($placeholder)) { $alertKeyFor[$placeholder] } else { $placeholder })
  $v = $null
  foreach ($key in $keys) {
    if ($envValues.ContainsKey($key) -and $envValues[$key] -ne '') { $v = $envValues[$key]; break }
  }
  if ($null -eq $v) {
    foreach ($key in $keys) {
      if ($envValues.ContainsKey($key)) { $v = $envValues[$key]; break }
    }
  }
  if ($null -eq $v) {
    if ($alertMissing -notcontains $keys[0]) { $alertMissing += $keys[0] }
    continue
  }
  $alertText = $alertText.Replace($token.Value, $v)
  $alertFilled[$placeholder] = $true
}
if ($alertMissing.Count) {
  Die "secrets/alertmanager.yml cannot be rendered: .env.example carries no $(($alertMissing | Sort-Object) -join ', '), and $alertTemplate needs every one of them. Nothing here may invent them -- Alertmanager takes an unsubstituted placeholder literally, amtool check-config still passes, the stack boots green, and the delivery leg that has to survive the console being down fails at send time. No .env and no secret were written: add those keys to .env.example, then run this again."
}
if ($alertText -match '@@' -or $alertText -match '\$\{') {
  Die "A placeholder survived rendering $alertTemplate, and Alertmanager would take it literally. No .env and no secret were written."
}

Write-TextNoBom -Path $EnvFile -Text (($out -join "`n") + "`n")
Say "wrote .env       ($($gen.Count) secrets generated, $($lines.Count) lines kept from .env.example)"
if ($derived.Contains('ARGUS_GARNET_MEM_LIMIT_BYTES')) {
  Say "garnet budget    GARNET_MEM_LIMIT=$memLimit -> ARGUS_GARNET_MEM_LIMIT_BYTES=$($derived['ARGUS_GARNET_MEM_LIMIT_BYTES'])"
}

Write-FileSecret 'pg_superuser_password'   (New-HexSecret 24)
Write-FileSecret 'pg_exporter_password'    $gen['ARGUS_PG_EXPORTER_PASSWORD']
Write-FileSecret 'grafana_admin_password'  (New-HexSecret 16)
Write-FileSecret 'console_alert_token'     (New-HexSecret 24)
Write-FileSecret 'grafana_db_password'     $gen['ARGUS_PG_GRAFANA_PASSWORD']
Say "wrote secrets/   (5 file-secrets)"

Write-FileSecret 'guac_breakglass_password' $breakglassPassword
Say "wrote secrets/guac_breakglass_password  (the Guacamole break-glass login)"

$garnetSecrets = Join-Path $SecretsDir 'garnet'
if (-not (Test-Path $garnetSecrets)) { [void](New-Item -ItemType Directory -Path $garnetSecrets) }
$consoleAcl = 'user console on >' + $gen['GARNET_CONSOLE_PASSWORD'] +
  ' ~* -@all +ping +select +info +dbsize +time +acl|whoami +config|get' +
  ' +client|info +client|list +command +command|count +command|docs +command|info +latency|histogram'
Write-TextNoBom -Path (Join-Path $garnetSecrets 'users.acl') -Text ("user default off`n" + $consoleAcl + "`n")
Say "wrote secrets/garnet/users.acl  (default OFF, console observe-only)"

Write-TextNoBom -Path $alertRendered -Text $alertText
Say "wrote secrets/alertmanager.yml  ($($alertFilled.Count) placeholders substituted from .env)"

if (-not $SkipDigests) {
  Head "3. Resolving image tags"
  Say "A tag is a mutable pointer: 'it worked yesterday' and 'it works today' are"
  Say "different images unless this file exists. Pulling the core images once."
  Write-Host ""

  $tags = @{}
  foreach ($l in [IO.File]::ReadAllLines($EnvFile)) {
    $mm = [regex]::Match($l, '^(?<k>[A-Z0-9_]*TAG)=(?<v>[^\s#]+)')
    if ($mm.Success) { $tags[$mm.Groups['k'].Value] = $mm.Groups['v'].Value }
  }
  $imageFor = [ordered]@{
    'SEAWEEDFS_TAG' = 'chrislusf/seaweedfs'
    'POSTGIS_TAG'   = 'postgis/postgis'
    'NATS_TAG'      = 'nats'
    'NATS_BOX_TAG'  = 'natsio/nats-box'
    'VALKEY_TAG'    = 'valkey/valkey'
    'ALPINE_TAG'    = 'alpine'
    'NODE_TAG'      = 'node'
  }
  $lock = New-Object 'System.Collections.Generic.List[string]'
  $lock.Add("# platform/compose/images.lock -- generated by bootstrap.ps1")
  $lock.Add("# Resolved $(Get-Date -Format 'yyyy-MM-dd'). Re-run with -Rotate to refresh.")
  $failed = 0
  foreach ($k in $imageFor.Keys) {
    if (-not $tags.ContainsKey($k)) { continue }
    $ref = "$($imageFor[$k]):$($tags[$k])"
    Write-Host "    $ref ... " -NoNewline
    docker pull -q $ref 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "FAILED" -ForegroundColor Red
      Warn "could not pull $ref -- the tag may not exist. Check it before up."
      $lock.Add("# UNRESOLVED $ref")
      $failed++
      continue
    }
    $digest = docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' $ref 2>$null
    if ($digest) { Write-Host "ok" -ForegroundColor Green; $lock.Add("$digest") }
    else { Write-Host "ok (no digest)" -ForegroundColor DarkGray; $lock.Add("# NO DIGEST $ref") }
  }
  Write-TextNoBom -Path (Join-Path $Here 'images.lock') -Text (($lock -join "`n") + "`n")
  Write-Host ""
  Say "wrote images.lock ($($lock.Count - 2) entries, $failed unresolved)"
}

Head "4. Validating the compose file"
docker compose config -q 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Die "docker compose config rejected the file. Nothing was started." }
Say "docker compose config: ok"

Write-Host ""
if ($script:Warnings.Count) {
  $s = if ($script:Warnings.Count -ne 1) { 's' } else { '' }
  Write-Host "  $($script:Warnings.Count) warning$s above -- read them; none of them stop the stack." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Ready." -ForegroundColor Green
Write-Host ""
Write-Host "    docker compose up -d                            core: storage, database, cache, queues, secrets, console"
Write-Host "    docker compose --profile observability up -d    metrics, logs, dashboards"
Write-Host "    docker compose --profile connect up -d          browser RDP/SSH"
Write-Host ""
Write-Host "  Then open  http://127.0.0.1:8787" -ForegroundColor Cyan
Write-Host "  Use the literal 127.0.0.1, not localhost: the publishes are IPv4-only and"
Write-Host "  Node and Windows both try ::1 first."
Write-Host ""
Write-Host "  Teardown:  pwsh -File ./down.ps1            (keeps your data)"
Write-Host ""

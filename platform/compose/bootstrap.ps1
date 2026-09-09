<#
.SYNOPSIS
  Prepare this machine to run the Argus stack: generate every secret, write
  .env and ./secrets/, and check the things that fail silently later.

.DESCRIPTION
  Run once:

      pwsh -File ./bootstrap.ps1          # or: powershell -File ./bootstrap.ps1
      docker compose up -d

  It REFUSES to overwrite an existing .env. Regenerating secrets underneath a
  running stack does not "reset" it -- it half-breaks it in ways that read as
  unrelated bugs:

    * Grafana writes the admin password into its database on FIRST boot and
      ignores the environment afterwards. A new value locks you out.
    * A new Postgres role password does not match the role that already exists,
      so every client gets "password authentication failed" while the server is
      perfectly healthy.
    * A new alert token 401s every alert Alertmanager delivers, and Alertmanager
      reports a delivery failure, not a credential failure.

  Use -Rotate only when you intend to tear the stack down with its volumes.

.NOTES
  Written for Windows PowerShell 5.1, which is what ships on Windows 10.
  Two 5.1 traps this script avoids deliberately:

    * [RandomNumberGenerator]::GetBytes(n) is a .NET 6+ STATIC overload and
      throws "Method invocation failed" on 5.1. Create() the instance instead.
    * Out-File / Set-Content / > default to UTF-16LE or add a BOM on 5.1.
      docker compose cannot parse either, and the error it gives names a
      random variable rather than the encoding. Everything here is written with
      [IO.File]::WriteAllText and a BOM-less UTF8Encoding.
#>
[CmdletBinding()]
param(
  # Regenerate .env and ./secrets/ even if they exist. Destructive: see above.
  [switch]$Rotate,
  # Skip resolving image tags to digests (the only step that needs a network).
  [switch]$SkipDigests
)

$ErrorActionPreference = 'Stop'

$Here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $Here '..\..')).Path
$EnvFile    = Join-Path $Here '.env'
$Example    = Join-Path $Here '.env.example'
$SecretsDir = Join-Path $Here 'secrets'

$script:Warnings = @()

function Say  ([string]$m) { Write-Host "  $m" }
function Head ([string]$m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Warn ([string]$m) { $script:Warnings += $m; Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ([string]$m) { Write-Host ""; Write-Host "  x $m" -ForegroundColor Red; Write-Host ""; exit 1 }

# --- generation -------------------------------------------------------------
#
# Every generated value is HEX. Not because hex is stronger -- it is weaker per
# character -- but because these strings are parsed by five different things
# before they reach the service that uses them: the Compose interpolator, a
# POSIX shell inside an init container, a NATS config file, a psql session, and
# a Java properties reader. A dollar sign or a hash or a quote in the wrong one
# of those is a boot failure whose message never mentions the password. 48 hex
# characters is 192 bits and cannot be mis-parsed by any of them.

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

function Write-TextNoBom {
  param([string]$Path, [string]$Text)
  $utf8 = New-Object Text.UTF8Encoding $false
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}

# A Compose file-secret is delivered to the container BYTE FOR BYTE. A trailing
# newline becomes part of the password for any consumer that does not strip it
# -- Grafana __FILE and postgres_exporter DATA_SOURCE_PASS_FILE both keep it,
# while the Postgres entrypoint happens to strip it. That inconsistency is
# exactly how "the password works for Postgres but not for the exporter"
# happens. Write no newline, ever.
function Write-FileSecret {
  param([string]$Name, [string]$Value)
  $p = Join-Path $SecretsDir $Name
  Write-TextNoBom -Path $p -Text $Value
  try {
    # Windows ACLs, not chmod. Honest limit: through a WSL2 bind mount these are
    # advisory, and anyone with local administrator reads them regardless.
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

# --- 1. preconditions -------------------------------------------------------

Head "1. Checking this machine"

$compose = Join-Path $Here 'docker-compose.yml'
if (-not (Test-Path $compose)) { Die "docker-compose.yml is not next to this script. Run it from platform/compose." }
if (-not (Test-Path $Example)) { Die ".env.example is missing. It is the template this script fills in." }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  # Docker Desktop adds this to PATH for NEW shells only. A shell opened before
  # the install has no docker on PATH and the failure looks like "not installed".
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

# WSL2 memory. The compose file header states the arithmetic: core is 4.2 GB of
# limits and core+observability+connect is 8.8 GB, which does not fit beside
# Windows on a 16 GB machine. Left at the default, WSL2 takes half of RAM and
# the stack is OOM-killed one container at a time, in an order that changes
# every boot.
$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path $wslConfig) {
  $mem = Select-String -Path $wslConfig -Pattern '^\s*memory\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($mem) { Say "wslconfig       $($mem.Line.Trim())" }
  else { Warn "$wslConfig exists but sets no memory=. WSL2 will take half this machine RAM." }
} else {
  Warn "No $wslConfig. Create it with [wsl2] / memory=9GB / processors=6, then run 'wsl --shutdown'."
}

# Subnet collision. A hardcoded 172.28/16 that a corporate VPN also routes does
# not fail loudly -- Docker wins the route and the VPN silently blackholes.
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

# Published ports. A collision is a hard bind failure at up time whose message
# names the port but not what holds it.
$ports = [ordered]@{ 'console' = 8787; 'postgres' = 5432; 'garnet' = 6379; 'nats' = 4222; 'openbao' = 8200 }
foreach ($name in $ports.Keys) {
  $p = $ports[$name]
  $held = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($held) {
    $proc = Get-Process -Id $held.OwningProcess -ErrorAction SilentlyContinue
    $who = if ($proc) { "$($proc.ProcessName) (pid $($proc.Id))" } else { 'an unknown process' }
    Warn "port $p ($name) is already held by $who. Change the matching *_PORT in .env."
  }
}

# --- 2. refuse to clobber ---------------------------------------------------

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

# ./secrets/ holds extensionless files. The repo .gitignore covers *.key, *.pem
# and .env -- none of which match a file named pg_superuser_password.
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

# The generated values, keyed by the .env.example placeholder they replace.
$gen = [ordered]@{}
foreach ($k in @(
  'ARGUS_S3_ADMIN_SECRET','ARGUS_S3_CONSOLE_SECRET','ARGUS_S3_APP_SECRET',
  'ARGUS_S3_LOKI_SECRET','ARGUS_S3_GUAC_SECRET','ARGUS_S3_PARITY_SECRET',
  'ARGUS_S3_PARITY_DENY_SECRET',
  'ARGUS_PG_APP_PASSWORD','ARGUS_PG_CONSOLE_PASSWORD','ARGUS_PG_EXPORTER_PASSWORD',
  'ARGUS_PG_GUAC_PASSWORD','ARGUS_PG_GRAFANA_PASSWORD','ARGUS_PG_PARITY_PASSWORD',
  'GARNET_CONSOLE_PASSWORD','NATS_ARGUS_PASSWORD','NATS_AGENT_PASSWORD'
)) { $gen[$k] = New-HexSecret 24 }

# Guacamole JSON_SECRET_KEY is a 128-bit AES key given as hex. Any length but 32
# hex characters is rejected at startup. Whoever holds it can mint a session as
# anyone, to anything -- the single highest-value string in the stack.
$gen['GUAC_JSON_SECRET_KEY'] = New-HexSecret 16
$gen['TARGET_SSH_PASSWORD']  = New-HexSecret 16
$gen['AZURITE_ACCOUNT_KEY']  = New-Base64Secret 32

# The break-glass account replaces guacadmin/guacadmin, whose hash is in every
# copy of the Guacamole schema on the internet. Guacamole stores
# SHA256(password_bytes + UPPERCASE_HEX(salt)) -- the salt is appended as its
# uppercase hex TEXT, not as raw bytes, which is the detail everyone gets wrong.
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

# --- 3. write .env ----------------------------------------------------------
#
# Built by rewriting .env.example line by line rather than emitting a fresh
# file, so every comment in it survives into .env. Those comments are the only
# documentation an operator has at 3am about why NATS_TAG must end in -alpine.

$lines    = [IO.File]::ReadAllLines($Example)
$out      = New-Object 'System.Collections.Generic.List[string]'
$replaced = @{}

foreach ($line in $lines) {
  $m = [regex]::Match($line, '^(?<key>[A-Z0-9_]+)=(?<val>[^#]*?)\s*(?<rest>#.*)?$')
  if ($m.Success -and $gen.Contains($m.Groups['key'].Value)) {
    $key  = $m.Groups['key'].Value
    $val  = $gen[$key]
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

$missing = @($gen.Keys | Where-Object { -not $replaced.ContainsKey($_) })
if ($missing.Count) {
  Die "These keys were generated but do not appear in .env.example, so nothing would consume them: $($missing -join ', ')"
}

Write-TextNoBom -Path $EnvFile -Text (($out -join "`n") + "`n")
Say "wrote .env       ($($gen.Count) secrets generated, $($lines.Count) lines kept from .env.example)"

# --- 4. write ./secrets/ ----------------------------------------------------

# pg_exporter_password is BOTH a file-secret (read by postgres_exporter) and an
# environment value (used by pg-init to CREATE the role). If those two diverge
# the exporter authenticates against a role whose password is something else,
# and the only symptom is a permanently-down scrape target.
Write-FileSecret 'pg_superuser_password'   (New-HexSecret 24)
Write-FileSecret 'pg_exporter_password'    $gen['ARGUS_PG_EXPORTER_PASSWORD']
Write-FileSecret 'grafana_admin_password'  (New-HexSecret 16)
Write-FileSecret 'console_alert_token'     (New-HexSecret 24)
Say "wrote secrets/   (4 file-secrets)"

# The break-glass password is the one plaintext an operator genuinely needs to
# keep. Writing it beside the others is honest about where it lives, rather than
# printing it into a scrollback buffer and pretending it is gone.
Write-FileSecret 'guac_breakglass_password' $breakglassPassword
Say "wrote secrets/guac_breakglass_password  (the Guacamole break-glass login)"

# --- 5. resolve tags to digests --------------------------------------------

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
  # Core only. The observability and connect images are pulled when their
  # profile is first started; pulling ~30 images here would make a first run
  # look like a hang.
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

# --- 6. validate ------------------------------------------------------------

Head "4. Validating the compose file"
docker compose config -q 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Die "docker compose config rejected the file. Nothing was started." }
Say "docker compose config: ok"

# --- done -------------------------------------------------------------------

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

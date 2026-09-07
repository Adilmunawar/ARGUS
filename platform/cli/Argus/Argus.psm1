# Argus — PowerShell client for the Argus Console API (signed; in the WDAC policy).
$script:BaseUrl = $env:ARGUS_URL ?? 'https://console.zaraatdost.pk/api/v1'
$script:Token   = $null

function Connect-Argus {
    [CmdletBinding()] param([string]$Authority = 'https://adfs.argus.local/adfs')
    # OIDC device-code flow against AD FS; token cached with DPAPI for the current user.
    $script:Token = Get-ArgusDeviceCodeToken -Authority $Authority -ClientId 'argus-cli' -Scope 'openid argus-console'
    Write-Host "Connected to $script:BaseUrl"
}

function Invoke-Argus {
    param([string]$Method, [string]$Path, $Body)
    if (-not $script:Token) { throw 'Run Connect-Argus first.' }
    $p = @{ Method = $Method; Uri = "$script:BaseUrl$Path"; Headers = @{ Authorization = "Bearer $script:Token" }; ContentType = 'application/json' }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    Invoke-RestMethod @p
}

function Get-ArgusOverview { Invoke-Argus GET '/overview' }
function Get-ArgusApp { param([string]$Name) if ($Name) { Invoke-Argus GET "/apps/$Name" } else { Invoke-Argus GET '/apps' } }

function Publish-ArgusApp {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Version, [ValidateSet('staging','production')][string]$Environment = 'staging')
    if ($PSCmdlet.ShouldProcess("$Name $Version → $Environment", 'Open deployment pull request')) {
        $r = Invoke-Argus POST "/apps/$Name/deploy" @{ version = $Version; environment = $Environment }
        Write-Host "Pull request: $($r.prUrl)"; $r
    }
}

function Approve-ArgusDeployment { param([Parameter(Mandatory)][int]$Id) Invoke-Argus POST "/deployments/$Id/approve" }
function Get-ArgusBackup { param([Parameter(Mandatory)][string]$Database, [int]$Last = 10) Invoke-Argus GET "/databases/$Database/backups?last=$Last" }
function New-ArgusDatabaseCredential { param([Parameter(Mandatory)][string]$Database, [string]$Ttl = '1h') Invoke-Argus POST "/databases/$Database/credentials" @{ ttl = $Ttl } }
function Grant-ArgusTierAccess { param([Parameter(Mandatory)][string]$Group, [int]$Hours = 2, [Parameter(Mandatory)][string]$Reason) Invoke-Argus POST '/identity/grants' @{ group = $Group; hours = $Hours; reason = $Reason } }
function Invoke-ArgusRunbook { param([Parameter(Mandatory)][string]$Id, [hashtable]$Param = @{}) Invoke-Argus POST "/runbooks/$Id/run" @{ params = $Param } }
function Get-ArgusAudit { param([datetime]$Since = (Get-Date).AddHours(-24)) Invoke-Argus GET "/audit?since=$($Since.ToUniversalTime().ToString('o'))" }

function Connect-Argus {
    [CmdletBinding(DefaultParameterSetName = 'Session', SupportsShouldProcess, ConfirmImpact = 'Low')]
    [OutputType([pscustomobject])]
    param(
        [Parameter()][string]$BaseUri,
        [Parameter()][string]$Origin,

        [Parameter(ParameterSetName = 'Session')]
        [pscredential]$Credential,

        [Parameter(ParameterSetName = 'Proxy', Mandatory)]
        [string]$ProxySubject,

        [Parameter(ParameterSetName = 'Proxy', Mandatory)]
        [securestring]$ProxySecret,

        [Parameter(ParameterSetName = 'Proxy')]
        [string[]]$ProxyGroup,

        [Parameter(ParameterSetName = 'Proxy')]
        [string]$ProxyDisplayName,

        [Parameter(ParameterSetName = 'Proxy')]
        [string]$ProxyIdentityHeader = 'remote-user',

        [Parameter(ParameterSetName = 'Proxy')]
        [string]$ProxySecretHeader = 'x-argus-proxy-auth',

        [Parameter(ParameterSetName = 'Proxy')]
        [string]$ProxyGroupsHeader = 'remote-groups',

        [Parameter(ParameterSetName = 'Proxy')]
        [string]$ProxyNameHeader = 'remote-name',

        [Parameter(ParameterSetName = 'Anonymous', Mandatory)]
        [switch]$NoCredential,

        [Parameter()][switch]$Force,
        [Parameter()][switch]$PassThru
    )

    try {
        $base = Resolve-ArgusBaseUri -BaseUri $BaseUri
    } catch {
        $PSCmdlet.ThrowTerminatingError((New-ArgusErrorRecord `
            -Message $_.Exception.Message `
            -ErrorId 'ArgusBadBaseUri' `
            -Category ([System.Management.Automation.ErrorCategory]::InvalidArgument) `
            -TargetObject $BaseUri))
    }

    if (-not $PSCmdlet.ShouldProcess($base.Authority, 'Establish an Argus console session')) { return }

    $originHeader = $Origin
    if (-not $originHeader) { $originHeader = $env:ARGUS_CONSOLE_ORIGIN }
    if (-not $originHeader) { $originHeader = Get-ArgusOriginHeader -BaseUri $base }

    $connection = [pscustomobject]@{
        BaseUri      = $base
        Origin       = $originHeader
        AuthMode     = 'session'
        Subject      = $null
        DisplayName  = $null
        Roles        = @()
        CookieName   = $null
        Cookie       = $null
        ProxyHeaders = @{}
        Protection   = 'memory'
        ConnectedAt  = $null
        Restored     = $false
    }

    if ($PSCmdlet.ParameterSetName -eq 'Anonymous') {
        $connection.AuthMode = 'off'
    } elseif ($PSCmdlet.ParameterSetName -eq 'Proxy') {
        $connection.AuthMode = 'proxy'
        $headers = @{}
        $headers[$ProxyIdentityHeader] = $ProxySubject
        $headers[$ProxySecretHeader] = (ConvertFrom-ArgusSecureString -SecureString $ProxySecret)
        if ($ProxyGroup) { $headers[$ProxyGroupsHeader] = ($ProxyGroup -join ',') }
        if ($ProxyDisplayName) { $headers[$ProxyNameHeader] = $ProxyDisplayName }
        $connection.ProxyHeaders = $headers
    } else {
        if (-not $Credential -and -not $Force) {
            $cached = Read-ArgusSessionCache
            if ($cached -and $cached.BaseUri.AbsoluteUri -eq $base.AbsoluteUri) {
                $connection.Origin = $cached.Origin
                $connection.CookieName = $cached.CookieName
                $connection.Cookie = $cached.Cookie
                $connection.Protection = $cached.Protection
                $connection.Restored = $true
            }
        }

        if (-not $connection.Cookie) {
            if (-not $Credential) {
                $Credential = Get-Credential -Message "Argus operator sign-in for $($base.Authority)"
            }
            if (-not $Credential) {
                $PSCmdlet.ThrowTerminatingError((New-ArgusErrorRecord `
                    -Message 'No operator credential was supplied, so there is nothing to sign in with.' `
                    -ErrorId 'ArgusNoCredential' `
                    -Category ([System.Management.Automation.ErrorCategory]::InvalidArgument) `
                    -TargetObject $base))
            }

            $session = New-ArgusWebSession -BaseUri $base
            $body = @{
                subject  = $Credential.UserName
                password = (ConvertFrom-ArgusSecureString -SecureString $Credential.Password)
            }

            try {
                Invoke-ArgusHttp -BaseUri $base -Path '/api/auth/login' -Method POST -Body $body -Origin $originHeader -Session $session | Out-Null
            } catch {
                $PSCmdlet.ThrowTerminatingError($_)
            } finally {
                $body['password'] = $null
            }

            $minted = Get-ArgusSetCookie -Session $session -BaseUri $base
            if (-not $minted) {
                $PSCmdlet.ThrowTerminatingError((New-ArgusErrorRecord `
                    -Message 'The console accepted the sign-in but set no session cookie, so nothing can authenticate the requests that follow.' `
                    -ErrorId 'ArgusNoSessionCookie' `
                    -Category ([System.Management.Automation.ErrorCategory]::ProtocolError) `
                    -TargetObject $base))
            }
            $connection.CookieName = $minted.Name
            $connection.Cookie = $minted.Value
        }
    }

    Set-ArgusConnectionState -Connection $connection -Confirm:$false

    try {
        $identity = Invoke-ArgusRequest -Path '/api/auth/session'
    } catch {
        Set-ArgusConnectionState -Connection $null -Confirm:$false
        $PSCmdlet.ThrowTerminatingError($_)
    }

    $connection.Subject = $identity.subject
    $connection.DisplayName = $identity.displayName
    if ($identity.roles) { $connection.Roles = @($identity.roles) }
    $connection.AuthMode = $identity.source
    $connection.ConnectedAt = (Get-Date).ToUniversalTime().ToString('o')

    if ($connection.Cookie) {
        $saved = Save-ArgusSessionCache -Connection $connection -Confirm:$false
        $connection.Protection = $saved.Protection
        if ($saved.Protection -eq 'memory') { Write-Warning $saved.Reason }
    }

    Set-ArgusConnectionState -Connection $connection -Confirm:$false

    if ($PassThru) { return (Get-ArgusConnection) }
}

function Get-ArgusConnection {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $connection = Get-ArgusConnectionState
    if (-not $connection) { return }

    return [pscustomobject]@{
        BaseUri           = $connection.BaseUri
        Origin            = $connection.Origin
        AuthMode          = $connection.AuthMode
        Subject           = $connection.Subject
        DisplayName       = $connection.DisplayName
        Roles             = $connection.Roles
        CacheProtection   = $connection.Protection
        ConnectedAt       = $connection.ConnectedAt
        RestoredFromCache = $connection.Restored
    }
}

function Get-ArgusSession {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/auth/session' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Disconnect-Argus {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    param([switch]$KeepCache)

    $connection = Get-ArgusConnectionState
    if (-not $connection) {
        Write-Verbose 'There is no Argus connection to end.'
        return
    }

    if ($PSCmdlet.ShouldProcess($connection.BaseUri.Authority, 'End the console session')) {
        if ($connection.Cookie) {
            try {
                Invoke-ArgusRequest -Path '/api/auth/logout' -Method POST | Out-Null
            } catch {
                Write-Warning "The console did not confirm sign-out: $($_.Exception.Message)"
            }
        }
        if (-not $KeepCache) { Remove-ArgusSessionCache -Confirm:$false | Out-Null }
        Set-ArgusConnectionState -Connection $null -Confirm:$false
    }
}

function Clear-ArgusSessionCache {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    [OutputType([pscustomobject])]
    param([switch]$PassThru)

    $path = Get-ArgusSessionCachePath
    $removed = $false
    if ($PSCmdlet.ShouldProcess($path, 'Remove the cached Argus session')) {
        $removed = Remove-ArgusSessionCache -Confirm:$false
    }
    if ($PassThru) {
        return [pscustomobject]@{ Path = $path; Removed = $removed }
    }
}

function Get-ArgusCacheState {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $path = Get-ArgusSessionCachePath
    return [pscustomobject]@{
        Path           = $path
        Exists         = (Test-Path -LiteralPath $path)
        Protection     = (Get-ArgusCacheProtectionMode)
        DpapiAvailable = (Test-ArgusProtectedData)
        Platform       = $(if (Test-ArgusWindowsPlatform) { 'Windows' } else { 'Non-Windows' })
    }
}

function Invoke-ArgusApi {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [string]$Path,

        [Parameter(ValueFromPipelineByPropertyName)]
        [ValidateSet('GET', 'HEAD', 'POST')]
        [string]$Method = 'GET',

        [Parameter(ValueFromPipelineByPropertyName)]
        [hashtable]$Query,

        [Parameter(ValueFromPipelineByPropertyName)]
        $Body,

        [int]$TimeoutSeconds = 60
    )

    process {
        if ($Method -eq 'GET' -or $Method -eq 'HEAD') {
            try { Invoke-ArgusRequest -Path $Path -Method $Method -Query $Query -TimeoutSeconds $TimeoutSeconds }
            catch { $PSCmdlet.ThrowTerminatingError($_) }
            return
        }

        if ($PSCmdlet.ShouldProcess($Path, "$Method against the Argus console")) {
            try { Invoke-ArgusRequest -Path $Path -Method $Method -Query $Query -Body $Body -TimeoutSeconds $TimeoutSeconds }
            catch { $PSCmdlet.ThrowTerminatingError($_) }
        }
    }
}

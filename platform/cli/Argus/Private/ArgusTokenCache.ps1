$script:ArgusCacheVersion = 1
$script:ArgusCacheEntropyText = 'Argus.Cli.SessionCache.v1'

function Get-ArgusCacheEntropy {
    [CmdletBinding()]
    [OutputType([byte[]])]
    param()

    return [System.Text.Encoding]::UTF8.GetBytes($script:ArgusCacheEntropyText)
}

function Test-ArgusPlaintextCacheAllowed {
    [CmdletBinding()]
    [OutputType([bool])]
    param()

    $raw = $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE
    if (-not $raw) { return $false }
    return @('1', 'true', 'yes', 'on') -contains $raw.Trim().ToLowerInvariant()
}

function Get-ArgusCacheProtectionMode {
    [CmdletBinding()]
    [OutputType([string])]
    param()

    if (Test-ArgusProtectedData) { return 'dpapi' }
    if (Test-ArgusPlaintextCacheAllowed) { return 'plaintext' }
    return 'memory'
}

function Protect-ArgusSecretText {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $plain = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $sealed = [System.Security.Cryptography.ProtectedData]::Protect(
        $plain,
        (Get-ArgusCacheEntropy),
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($sealed)
}

function Unprotect-ArgusSecretText {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    $sealed = [Convert]::FromBase64String($Value)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $sealed,
        (Get-ArgusCacheEntropy),
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($plain)
}

function Save-ArgusSessionCache {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][pscustomobject]$Connection)

    $mode = Get-ArgusCacheProtectionMode
    $path = Get-ArgusSessionCachePath

    if ($mode -eq 'memory') {
        return [pscustomobject]@{
            Protection = 'memory'
            Path       = $null
            Written    = $false
            Reason     = 'No DPAPI on this platform and ARGUS_CLI_ALLOW_PLAINTEXT_CACHE is not set, so the session is held in process memory only.'
        }
    }

    $secret = $Connection.Cookie
    if ($null -eq $secret) { $secret = '' }
    $stored = $secret
    if ($mode -eq 'dpapi') { $stored = Protect-ArgusSecretText -Value $secret }

    $record = [ordered]@{
        version    = $script:ArgusCacheVersion
        protection = $mode
        baseUri    = $Connection.BaseUri.AbsoluteUri
        origin     = $Connection.Origin
        authMode   = $Connection.AuthMode
        subject    = $Connection.Subject
        cookieName = $Connection.CookieName
        cookie     = $stored
        savedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }

    if (-not $PSCmdlet.ShouldProcess($path, 'Write the Argus session cache')) {
        return [pscustomobject]@{ Protection = $mode; Path = $path; Written = $false; Reason = 'Skipped by ShouldProcess.' }
    }

    $directory = Split-Path -Path $path -Parent
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -Path $directory -ItemType Directory -Force | Out-Null
    }

    $json = [pscustomobject]$record | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding $false))
    Set-ArgusFilePermission -Path $path -Confirm:$false

    return [pscustomobject]@{
        Protection = $mode
        Path       = $path
        Written    = $true
        Reason     = $null
    }
}

function Read-ArgusSessionCache {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $path = Get-ArgusSessionCachePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }

    try {
        $json = [System.IO.File]::ReadAllText($path)
        $record = $json | ConvertFrom-Json
    } catch {
        Write-Verbose "The Argus session cache at $path could not be read: $($_.Exception.Message)"
        return $null
    }

    if ($null -eq $record -or $record.version -ne $script:ArgusCacheVersion) { return $null }

    $cookie = $record.cookie
    if ($record.protection -eq 'dpapi') {
        if (-not (Test-ArgusProtectedData)) { return $null }
        try {
            $cookie = Unprotect-ArgusSecretText -Value $record.cookie
        } catch {
            Write-Verbose "The Argus session cache at $path is sealed to a different user or machine."
            return $null
        }
    }

    return [pscustomobject]@{
        Protection = $record.protection
        Path       = $path
        BaseUri    = [uri]$record.baseUri
        Origin     = $record.origin
        AuthMode   = $record.authMode
        Subject    = $record.subject
        CookieName = $record.cookieName
        Cookie     = $cookie
        SavedAt    = $record.savedAt
    }
}

function Remove-ArgusSessionCache {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
    [OutputType([bool])]
    param()

    $path = Get-ArgusSessionCachePath
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    if (-not $PSCmdlet.ShouldProcess($path, 'Remove the Argus session cache')) { return $false }
    Remove-Item -LiteralPath $path -Force
    return $true
}

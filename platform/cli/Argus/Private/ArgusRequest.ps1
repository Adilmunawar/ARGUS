$script:ArgusConnection = $null
$script:ArgusDefaultBaseUri = 'http://127.0.0.1:8787'
$script:ArgusClientHeader = 'x-argus-console'
$script:ArgusUserAgent = 'Argus-PowerShell'

function Resolve-ArgusBaseUri {
    [CmdletBinding()]
    [OutputType([uri])]
    param([string]$BaseUri)

    $candidate = $BaseUri
    if (-not $candidate) { $candidate = $env:ARGUS_CONSOLE_URL }
    if (-not $candidate) { $candidate = $env:ARGUS_URL }
    if (-not $candidate) { $candidate = $script:ArgusDefaultBaseUri }

    $parsed = $null
    if (-not [uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$parsed)) {
        throw "'$candidate' is not an absolute URL. Give Connect-Argus something like http://127.0.0.1:8787."
    }
    if ($parsed.Scheme -ne 'http' -and $parsed.Scheme -ne 'https') {
        throw "'$candidate' is not an http or https URL."
    }
    return $parsed
}

function Get-ArgusOriginHeader {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][uri]$BaseUri)

    return '{0}://{1}' -f $BaseUri.Scheme, $BaseUri.Authority
}

function ConvertTo-ArgusQueryString {
    [CmdletBinding()]
    [OutputType([string])]
    param([hashtable]$Query)

    if (-not $Query -or $Query.Count -eq 0) { return '' }

    $pairs = New-Object System.Collections.Generic.List[string]
    foreach ($name in ($Query.Keys | Sort-Object)) {
        $value = $Query[$name]
        if ($null -eq $value) { continue }
        if ($value -is [bool]) { $value = if ($value) { 'true' } else { 'false' } }
        $text = [string]$value
        if ($text.Length -eq 0) { continue }
        $pairs.Add(('{0}={1}' -f [uri]::EscapeDataString([string]$name), [uri]::EscapeDataString($text)))
    }

    if ($pairs.Count -eq 0) { return '' }
    return '?' + ($pairs -join '&')
}

function New-ArgusUri {
    [CmdletBinding()]
    [OutputType([uri])]
    param(
        [Parameter(Mandatory)][uri]$BaseUri,
        [Parameter(Mandatory)][string]$Path,
        [hashtable]$Query
    )

    $relative = $Path
    if (-not $relative.StartsWith('/')) { $relative = '/' + $relative }
    $origin = Get-ArgusOriginHeader -BaseUri $BaseUri
    return [uri]($origin + $relative + (ConvertTo-ArgusQueryString -Query $Query))
}

function New-ArgusWebSession {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][uri]$BaseUri,
        [string]$CookieName,
        [string]$CookieValue
    )

    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $session.UserAgent = $script:ArgusUserAgent
    if ($CookieName -and $CookieValue) {
        $cookie = New-Object System.Net.Cookie
        $cookie.Name = $CookieName
        $cookie.Value = $CookieValue
        $cookie.Path = '/'
        $cookie.Domain = $BaseUri.Host
        $cookie.HttpOnly = $true
        $cookie.Secure = ($BaseUri.Scheme -eq 'https')
        $session.Cookies.Add($cookie)
    }
    return $session
}

function Get-ArgusSetCookie {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]$Session,
        [Parameter(Mandatory)][uri]$BaseUri
    )

    $origin = [uri](Get-ArgusOriginHeader -BaseUri $BaseUri)
    $jar = $Session.Cookies.GetCookies($origin)
    foreach ($cookie in $jar) {
        if ($cookie.Name -like '*argus_sid') {
            return [pscustomobject]@{ Name = $cookie.Name; Value = $cookie.Value }
        }
    }
    return $null
}

function Get-ArgusResponseProblem {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)

    $status = 0
    $exception = $ErrorRecord.Exception
    if ($exception -and $exception.PSObject.Properties['Response'] -and $exception.Response) {
        try { $status = [int]$exception.Response.StatusCode } catch { $status = 0 }
    }

    $text = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $text = $ErrorRecord.ErrorDetails.Message
    } elseif ($exception -is [System.Net.WebException] -and $exception.Response) {
        try {
            $stream = $exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $text = $reader.ReadToEnd()
            $reader.Dispose()
        } catch {
            $text = $null
        }
    }

    $code = $null
    $message = $null
    if ($text) {
        try {
            $body = $text | ConvertFrom-Json
            if ($body.PSObject.Properties['error']) { $code = [string]$body.error }
            if ($body.PSObject.Properties['message']) { $message = [string]$body.message }
        } catch {
            $message = $text
        }
    }
    if (-not $message) { $message = $exception.Message }

    return [pscustomobject]@{
        Status  = $status
        Code    = $code
        Message = $message
    }
}

function New-ArgusErrorRecord {
    [CmdletBinding()]
    [OutputType([System.Management.Automation.ErrorRecord])]
    param(
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][string]$ErrorId,
        [System.Management.Automation.ErrorCategory]$Category = [System.Management.Automation.ErrorCategory]::InvalidOperation,
        $TargetObject,
        [Exception]$Exception
    )

    $inner = $Exception
    if (-not $inner) { $inner = New-Object System.InvalidOperationException $Message }
    return New-Object System.Management.Automation.ErrorRecord $inner, $ErrorId, $Category, $TargetObject
}

function New-ArgusHttpErrorRecord {
    [CmdletBinding()]
    [OutputType([System.Management.Automation.ErrorRecord])]
    param(
        [Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][uri]$Uri
    )

    $problem = Get-ArgusResponseProblem -ErrorRecord $ErrorRecord
    $target = '{0} {1}' -f $Method, $Uri.AbsoluteUri
    $category = [System.Management.Automation.ErrorCategory]::InvalidResult
    $id = 'ArgusHttpError'
    $message = '{0} failed with HTTP {1}: {2}' -f $target, $problem.Status, $problem.Message

    if ($problem.Status -eq 401) {
        $id = 'ArgusUnauthenticated'
        $category = [System.Management.Automation.ErrorCategory]::AuthenticationError
        $message = 'The console rejected this request as unauthenticated. The session has expired or was never established. Run Connect-Argus again. Server said: {0}' -f $problem.Message
    } elseif ($problem.Status -eq 403 -and $problem.Code -eq 'cross-site') {
        $id = 'ArgusOriginRejected'
        $category = [System.Management.Automation.ErrorCategory]::PermissionDenied
        $message = 'The console refused this request as cross-site. It compares the Origin header against its own target origin, so the value passed to Connect-Argus -Origin must match ARGUS_AUTH_PUBLIC_ORIGIN on the server, or the URL the console is reached on when that variable is unset. Server said: {0}' -f $problem.Message
    } elseif ($problem.Status -eq 405 -and $problem.Code -eq 'read-only') {
        $id = 'ArgusReadOnly'
        $category = [System.Management.Automation.ErrorCategory]::PermissionDenied
        $message = 'This console is running read-only, so it refuses every method other than GET and HEAD before a route is looked up. ARGUS_ALLOW_WRITES=1 on the server is what changes that. Server said: {0}' -f $problem.Message
    } elseif ($problem.Status -eq 404) {
        $id = 'ArgusNoSuchEndpoint'
        $category = [System.Management.Automation.ErrorCategory]::ObjectNotFound
    } elseif ($problem.Status -eq 429) {
        $id = 'ArgusThrottled'
        $category = [System.Management.Automation.ErrorCategory]::LimitsExceeded
    } elseif ($problem.Status -eq 0) {
        $id = 'ArgusUnreachable'
        $category = [System.Management.Automation.ErrorCategory]::ConnectionError
        $message = '{0} did not answer: {1}' -f $target, $problem.Message
    }

    return New-ArgusErrorRecord -Message $message -ErrorId $id -Category $category -TargetObject $target -Exception $ErrorRecord.Exception
}

function Invoke-ArgusHttp {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][uri]$BaseUri,
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('GET', 'HEAD', 'POST')][string]$Method = 'GET',
        [hashtable]$Query,
        $Body,
        [hashtable]$ExtraHeaders,
        [string]$Origin,
        $Session,
        [string]$OutFile,
        [int]$TimeoutSeconds = 60
    )

    Initialize-ArgusTls

    if (-not $Origin) { $Origin = Get-ArgusOriginHeader -BaseUri $BaseUri }
    $uri = New-ArgusUri -BaseUri $BaseUri -Path $Path -Query $Query

    $headers = @{ Origin = $Origin }
    $headers[$script:ArgusClientHeader] = '1'
    if ($ExtraHeaders) {
        foreach ($name in $ExtraHeaders.Keys) { $headers[$name] = $ExtraHeaders[$name] }
    }

    $arguments = @{
        Uri              = $uri
        Method           = $Method
        Headers          = $headers
        UserAgent        = $script:ArgusUserAgent
        UseBasicParsing  = $true
        TimeoutSec       = $TimeoutSeconds
        ErrorAction      = 'Stop'
    }
    if ($Session) { $arguments['WebSession'] = $Session }
    if ($OutFile) { $arguments['OutFile'] = $OutFile }
    if ($Method -eq 'POST') {
        $arguments['ContentType'] = 'application/json'
        if ($null -eq $Body) { $arguments['Body'] = '{}' }
        elseif ($Body -is [string]) { $arguments['Body'] = $Body }
        else { $arguments['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress) }
    }

    try {
        $response = Invoke-WebRequest @arguments
    } catch {
        throw (New-ArgusHttpErrorRecord -ErrorRecord $_ -Method $Method -Uri $uri)
    }

    return $response
}

function ConvertFrom-ArgusResponse {
    [CmdletBinding()]
    param($Response)

    if ($null -eq $Response) { return }
    if ($Response.StatusCode -eq 204) { return }

    $content = $Response.Content
    if ($null -eq $content) { return }
    if ($content -is [byte[]]) {
        if ($content.Length -eq 0) { return }
        $content = [System.Text.Encoding]::UTF8.GetString($content)
    }
    if ([string]::IsNullOrWhiteSpace([string]$content)) { return }

    return ([string]$content | ConvertFrom-Json)
}

function Get-ArgusConnectionState {
    [CmdletBinding()]
    param([switch]$Required)

    if ($script:ArgusConnection) { return $script:ArgusConnection }

    $cached = Read-ArgusSessionCache
    if ($cached) {
        $script:ArgusConnection = [pscustomobject]@{
            BaseUri      = $cached.BaseUri
            Origin       = $cached.Origin
            AuthMode     = $cached.AuthMode
            Subject      = $cached.Subject
            DisplayName  = $cached.Subject
            Roles        = @()
            CookieName   = $cached.CookieName
            Cookie       = $cached.Cookie
            ProxyHeaders = @{}
            Protection   = $cached.Protection
            ConnectedAt  = $cached.SavedAt
            Restored     = $true
        }
        return $script:ArgusConnection
    }

    if ($Required) {
        throw (New-ArgusErrorRecord `
            -Message 'There is no Argus connection in this session and no usable cached one. Run Connect-Argus first.' `
            -ErrorId 'ArgusNotConnected' `
            -Category ([System.Management.Automation.ErrorCategory]::ConnectionError) `
            -TargetObject 'Argus')
    }

    return $null
}

function Set-ArgusConnectionState {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
    param($Connection)

    if ($PSCmdlet.ShouldProcess('Argus module state', 'Set the current connection')) {
        $script:ArgusConnection = $Connection
    }
}

function Invoke-ArgusRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('GET', 'HEAD', 'POST')][string]$Method = 'GET',
        [hashtable]$Query,
        $Body,
        [string]$OutFile,
        [int]$TimeoutSeconds = 60,
        [switch]$RawResponse
    )

    $connection = Get-ArgusConnectionState -Required

    $session = New-ArgusWebSession -BaseUri $connection.BaseUri -CookieName $connection.CookieName -CookieValue $connection.Cookie

    $response = Invoke-ArgusHttp `
        -BaseUri $connection.BaseUri `
        -Path $Path `
        -Method $Method `
        -Query $Query `
        -Body $Body `
        -ExtraHeaders $connection.ProxyHeaders `
        -Origin $connection.Origin `
        -Session $session `
        -OutFile $OutFile `
        -TimeoutSeconds $TimeoutSeconds

    $rotated = Get-ArgusSetCookie -Session $session -BaseUri $connection.BaseUri
    if ($rotated -and $rotated.Value -and $rotated.Value -ne $connection.Cookie) {
        $connection.CookieName = $rotated.Name
        $connection.Cookie = $rotated.Value
        Save-ArgusSessionCache -Connection $connection -Confirm:$false | Out-Null
    }

    if ($RawResponse) { return $response }
    return (ConvertFrom-ArgusResponse -Response $response)
}

function Read-ArgusEventStream {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$Path,
        [hashtable]$Query,
        [int]$Seconds = 30,
        [int]$First = 0
    )

    Initialize-ArgusTls
    $connection = Get-ArgusConnectionState -Required
    $uri = New-ArgusUri -BaseUri $connection.BaseUri -Path $Path -Query $Query

    $budgetMs = 30000
    if ($Seconds -gt 0) { $budgetMs = ($Seconds + 15) * 1000 }
    if ($budgetMs -lt 30000) { $budgetMs = 30000 }

    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.Method = 'GET'
    $request.Accept = 'text/event-stream'
    $request.UserAgent = $script:ArgusUserAgent
    $request.KeepAlive = $true
    $request.Timeout = $budgetMs
    $request.ReadWriteTimeout = $budgetMs
    $request.Headers.Add('Origin', $connection.Origin)
    $request.Headers.Add($script:ArgusClientHeader, '1')
    foreach ($name in $connection.ProxyHeaders.Keys) {
        $request.Headers.Add([string]$name, [string]$connection.ProxyHeaders[$name])
    }
    if ($connection.CookieName -and $connection.Cookie) {
        $jar = New-Object System.Net.CookieContainer
        $cookie = New-Object System.Net.Cookie
        $cookie.Name = $connection.CookieName
        $cookie.Value = $connection.Cookie
        $cookie.Path = '/'
        $cookie.Domain = $connection.BaseUri.Host
        $jar.Add($cookie)
        $request.CookieContainer = $jar
    }

    $response = $null
    $stream = $null
    $reader = $null
    try {
        try {
            $response = $request.GetResponse()
        } catch {
            throw (New-ArgusHttpErrorRecord -ErrorRecord $_ -Method 'GET' -Uri $uri)
        }

        $stream = $response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)

        if ([string]$response.ContentType -notlike 'text/event-stream*') {
            $detail = ''
            try { $detail = $reader.ReadToEnd() } catch { $detail = '' }
            if ($detail) {
                try {
                    $body = $detail | ConvertFrom-Json
                    if ($body.PSObject.Properties['message']) { $detail = [string]$body.message }
                } catch { }
            }
            if (-not $detail) { $detail = 'It sent no explanation.' }
            throw (New-ArgusErrorRecord `
                -Message ('{0} answered with {1} instead of an event stream. {2}' -f $uri.AbsoluteUri, $response.ContentType, $detail) `
                -ErrorId 'ArgusStreamUnavailable' `
                -Category ([System.Management.Automation.ErrorCategory]::ResourceUnavailable) `
                -TargetObject $uri.AbsoluteUri)
        }

        $deadline = (Get-Date).AddSeconds($Seconds)
        $emitted = 0
        $eventName = $null
        $eventId = $null
        $data = New-Object System.Collections.Generic.List[string]

        while ($true) {
            if ((Get-Date) -gt $deadline) { break }
            if ($First -gt 0 -and $emitted -ge $First) { break }

            $line = $null
            try {
                $line = $reader.ReadLine()
            } catch {
                if ((Get-Date) -gt $deadline) { break }
                throw (New-ArgusErrorRecord `
                    -Message ('The event stream from {0} stopped before the deadline: {1}' -f $uri.AbsoluteUri, $_.Exception.Message) `
                    -ErrorId 'ArgusStreamInterrupted' `
                    -Category ([System.Management.Automation.ErrorCategory]::ConnectionError) `
                    -TargetObject $uri.AbsoluteUri `
                    -Exception $_.Exception)
            }
            if ($null -eq $line) { break }

            if ($line.Length -eq 0) {
                if ($data.Count -gt 0 -or $eventName) {
                    $text = ($data -join "`n")
                    $parsed = $text
                    if ($text) {
                        try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $text }
                    }
                    [pscustomobject]@{
                        Event    = $(if ($eventName) { $eventName } else { 'message' })
                        Id       = $eventId
                        Data     = $parsed
                        Received = (Get-Date).ToUniversalTime()
                    }
                    $emitted++
                }
                $eventName = $null
                $eventId = $null
                $data.Clear()
                continue
            }

            if ($line.StartsWith(':')) { continue }

            $colon = $line.IndexOf(':')
            if ($colon -lt 0) { continue }
            $field = $line.Substring(0, $colon)
            $value = $line.Substring($colon + 1)
            if ($value.StartsWith(' ')) { $value = $value.Substring(1) }

            if ($field -eq 'event') { $eventName = $value }
            elseif ($field -eq 'id') { $eventId = $value }
            elseif ($field -eq 'data') { $data.Add($value) }
        }
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($stream) { $stream.Dispose() }
        if ($response) { $response.Close() }
    }
}

function Get-ArgusHealth {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/health' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusCapability {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/capabilities' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusConsoleMetric {
    [CmdletBinding()]
    [OutputType([string])]
    param()

    try { $response = Invoke-ArgusRequest -Path '/metrics' -RawResponse }
    catch { $PSCmdlet.ThrowTerminatingError($_) }

    $content = $response.Content
    if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
    if ([string]::IsNullOrWhiteSpace([string]$content)) { return @() }

    return @([string]$content -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_.Length -gt 0 })
}

function Get-ArgusOverview {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/overview' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusHost {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/host' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusComponentHealth {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateSet('storage', 'postgres', 'cache', 'queues', 'secrets', 'logs', 'metrics', 'alerts', 'containers')]
        [string[]]$Component
    )

    begin {
        try { Get-ArgusConnectionState -Required | Out-Null }
        catch { $PSCmdlet.ThrowTerminatingError($_) }

        $paths = @{
            storage    = '/api/storage/health'
            postgres   = '/api/pg/health'
            cache      = '/api/cache/health'
            queues     = '/api/queues/health'
            secrets    = '/api/secrets/health'
            logs       = '/api/logs/health'
            metrics    = '/api/metrics/health'
            alerts     = '/api/alerts/health'
            containers = '/api/containers/health'
        }
        $seen = New-Object System.Collections.Generic.List[string]
    }

    process {
        $wanted = $Component
        if (-not $wanted) { $wanted = @('storage', 'postgres', 'cache', 'queues', 'secrets', 'logs', 'metrics', 'alerts', 'containers') }

        foreach ($name in $wanted) {
            if ($seen.Contains($name)) { continue }
            $seen.Add($name)

            $answer = $null
            $failure = $null
            try {
                $answer = Invoke-ArgusRequest -Path $paths[$name]
            } catch {
                $failure = $_.Exception.Message
            }

            [pscustomobject]@{
                Component = $name
                Path      = $paths[$name]
                Ok        = $(if ($failure) { $false } else { [bool]$answer.ok })
                Detail    = $(if ($failure) { $failure } else { $answer })
            }
        }
    }
}

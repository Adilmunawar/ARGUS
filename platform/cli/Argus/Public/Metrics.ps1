function Get-ArgusMetricTarget {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/metrics/targets' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusMetricRule {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/metrics/rules' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusMetricStore {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/metrics/tsdb' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusMetric {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [string]$Name
    )

    process {
        try { Invoke-ArgusRequest -Path '/api/metrics/instant' -Query @{ name = $Name } }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

function Get-ArgusMetricSeries {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [string]$Name,

        [Parameter()][timespan]$Window,
        [Parameter()][int]$Points
    )

    process {
        $parameters = @{ name = $Name }
        if ($PSBoundParameters.ContainsKey('Window')) { $parameters['window'] = [int]$Window.TotalMilliseconds }
        if ($Points) { $parameters['points'] = $Points }

        try { Invoke-ArgusRequest -Path '/api/metrics/series' -Query $parameters }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

function Get-ArgusHeartbeat {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Position = 0)][int]$Slots)

    $query = @{}
    if ($Slots) { $query['slots'] = $Slots }

    try { Invoke-ArgusRequest -Path '/api/heartbeats' -Query $query }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusUptime {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/heartbeats/uptime' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusIncident {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Position = 0)][int]$Limit)

    $query = @{}
    if ($Limit) { $query['limit'] = $Limit }

    try { Invoke-ArgusRequest -Path '/api/heartbeats/incidents' -Query $query }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusCacheServer {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/cache/server' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusCacheMemory {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/cache/memory' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusCacheClient {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/cache/clients' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusCacheKeyspace {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/cache/keyspace' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

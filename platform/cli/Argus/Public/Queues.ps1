function Get-ArgusQueueServer {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/queues/server' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusQueueAccount {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/queues/account' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusQueueStream {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([switch]$Expand)

    try { $answer = Invoke-ArgusRequest -Path '/api/queues/streams' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }

    if ($Expand -and $answer -and $answer.streams) { return $answer.streams }
    return $answer
}

function Get-ArgusQueueConsumer {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Name')]
        [string]$Stream
    )

    process {
        $query = @{}
        if ($Stream) { $query['stream'] = $Stream }

        try { Invoke-ArgusRequest -Path '/api/queues/consumers' -Query $query }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

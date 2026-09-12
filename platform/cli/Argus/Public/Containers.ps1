function Get-ArgusContainer {
    [CmdletBinding(DefaultParameterSetName = 'List')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(ParameterSetName = 'Inspect', Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [string]$Id,

        [Parameter(ParameterSetName = 'List')]
        [switch]$Expand
    )

    process {
        try {
            if ($PSCmdlet.ParameterSetName -eq 'Inspect') {
                Invoke-ArgusRequest -Path '/api/containers/inspect' -Query @{ id = $Id }
                return
            }

            $answer = Invoke-ArgusRequest -Path '/api/containers'
            if ($Expand -and $answer -and $answer.containers) { return $answer.containers }
            return $answer
        } catch {
            $PSCmdlet.ThrowTerminatingError($_)
        }
    }
}

function Get-ArgusContainerStatistic {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [string]$Id
    )

    process {
        try { Invoke-ArgusRequest -Path '/api/containers/stats' -Query @{ id = $Id } }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

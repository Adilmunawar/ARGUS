function Receive-ArgusStream {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateSet('Heartbeats', 'Logs', 'ContainerLogs', 'ContainerEvents')]
        [string]$Stream,

        [Parameter()][string]$Query,
        [Parameter()][string]$ContainerId,
        [Parameter()][int]$Tail,
        [Parameter()][string]$Since,
        [Parameter()][int]$Seconds = 30,
        [Parameter()][int]$First = 0
    )

    $paths = @{
        Heartbeats      = '/api/heartbeats/stream'
        Logs            = '/api/logs/stream'
        ContainerLogs   = '/api/containers/logs'
        ContainerEvents = '/api/containers/events'
    }

    $parameters = @{}

    if ($Stream -eq 'Logs') {
        if (-not $Query) {
            $PSCmdlet.ThrowTerminatingError((New-ArgusErrorRecord `
                -Message 'The Logs stream needs a LogQL selector, for example -Query ''{container="argus-console"}''. Get-ArgusLogLabel lists the labels this Loki knows about.' `
                -ErrorId 'ArgusMissingSelector' `
                -Category ([System.Management.Automation.ErrorCategory]::InvalidArgument) `
                -TargetObject $Stream))
        }
        $parameters['query'] = $Query
    }

    if ($Stream -eq 'ContainerLogs') {
        if (-not $ContainerId) {
            $PSCmdlet.ThrowTerminatingError((New-ArgusErrorRecord `
                -Message 'The ContainerLogs stream needs -ContainerId. Get-ArgusContainer lists what this console can see.' `
                -ErrorId 'ArgusMissingContainerId' `
                -Category ([System.Management.Automation.ErrorCategory]::InvalidArgument) `
                -TargetObject $Stream))
        }
        $parameters['id'] = $ContainerId
        if ($Tail) { $parameters['tail'] = $Tail }
        if ($Since) { $parameters['since'] = $Since }
    }

    try {
        Read-ArgusEventStream -Path $paths[$Stream] -Query $parameters -Seconds $Seconds -First $First
    } catch {
        $PSCmdlet.ThrowTerminatingError($_)
    }
}

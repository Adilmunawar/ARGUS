function Get-ArgusLogLabel {
    [CmdletBinding(DefaultParameterSetName = 'Labels')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(ParameterSetName = 'Values', Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [string]$Name
    )

    process {
        try {
            if ($PSCmdlet.ParameterSetName -eq 'Values') {
                Invoke-ArgusRequest -Path '/api/logs/label-values' -Query @{ name = $Name }
            } else {
                Invoke-ArgusRequest -Path '/api/logs/labels'
            }
        } catch {
            $PSCmdlet.ThrowTerminatingError($_)
        }
    }
}

function Get-ArgusLog {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Selector')]
        [string]$Query,

        [Parameter()][int]$Limit,
        [Parameter()][string]$Start,
        [Parameter()][string]$End,
        [Parameter()][string]$Since,

        [Parameter()]
        [ValidateSet('backward', 'forward')]
        [string]$Direction = 'backward'
    )

    process {
        $parameters = @{ query = $Query; direction = $Direction }
        if ($Limit) { $parameters['limit'] = $Limit }
        if ($Start) { $parameters['start'] = $Start }
        if ($End) { $parameters['end'] = $End }
        if ($Since) { $parameters['since'] = $Since }

        try { Invoke-ArgusRequest -Path '/api/logs/query' -Query $parameters }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

function Get-ArgusLogVolume {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Selector')]
        [string]$Query,

        [Parameter()][string]$Start,
        [Parameter()][string]$End
    )

    process {
        $parameters = @{ query = $Query }
        if ($Start) { $parameters['start'] = $Start }
        if ($End) { $parameters['end'] = $End }

        try { Invoke-ArgusRequest -Path '/api/logs/volume' -Query $parameters }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

function Get-ArgusLogPattern {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Selector')]
        [string]$Query,

        [Parameter()][string]$Start,
        [Parameter()][string]$End,
        [Parameter()][string]$Step
    )

    process {
        $parameters = @{ query = $Query }
        if ($Start) { $parameters['start'] = $Start }
        if ($End) { $parameters['end'] = $End }
        if ($Step) { $parameters['step'] = $Step }

        try { Invoke-ArgusRequest -Path '/api/logs/patterns' -Query $parameters }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

function Get-ArgusAlert {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([switch]$Expand)

    try { $answer = Invoke-ArgusRequest -Path '/api/alerts/active' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }

    if ($Expand -and $answer -and $answer.alerts) { return $answer.alerts }
    return $answer
}

function Get-ArgusAlertGroup {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/alerts/groups' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAlertSilence {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/alerts/silences' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAlertReceiver {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/alerts/receivers' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

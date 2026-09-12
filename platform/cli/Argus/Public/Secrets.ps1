function Get-ArgusSecretsSealStatus {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/secrets/seal-status' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusSecretsHighAvailability {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/secrets/ha' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusSecretsSandbox {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/secrets/sandbox' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

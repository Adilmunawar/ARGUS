function Get-ArgusAwsIdentity {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/aws/identity' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAwsInstance {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/aws/instances' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAwsBucket {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/aws/buckets' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAwsDatabase {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/aws/databases' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAwsAlarm {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/aws/alarms' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusAwsCost {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/aws/cost' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

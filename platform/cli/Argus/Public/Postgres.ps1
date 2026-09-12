function Get-ArgusPostgresServer {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/pg/server' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusPostgresDatabase {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([switch]$Expand)

    try { $answer = Invoke-ArgusRequest -Path '/api/pg/databases' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }

    if ($Expand -and $answer -and $answer.databases) { return $answer.databases }
    return $answer
}

function Get-ArgusPostgresRole {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/pg/roles' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusPostgresActivity {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/pg/activity' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusPostgresStatement {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/pg/statements' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusPostgresReplication {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/pg/replication' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusPostgresTable {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Name')]
        [string]$Database
    )

    process {
        $query = @{}
        if ($Database) { $query['database'] = $Database }

        try { Invoke-ArgusRequest -Path '/api/pg/tables' -Query $query }
        catch { $PSCmdlet.ThrowTerminatingError($_) }
    }
}

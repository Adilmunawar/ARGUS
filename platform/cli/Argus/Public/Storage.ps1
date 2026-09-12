function Get-ArgusStorageCapacity {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/storage/capacity' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusStorageBucket {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([switch]$Expand)

    try { $answer = Invoke-ArgusRequest -Path '/api/storage/buckets' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }

    if ($Expand -and $answer -and $answer.buckets) { return $answer.buckets }
    return $answer
}

function Get-ArgusStorageLock {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    try { Invoke-ArgusRequest -Path '/api/storage/lock-status' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }
}

function Get-ArgusStorageObject {
    [CmdletBinding(DefaultParameterSetName = 'List')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Name')]
        [string]$Bucket,

        [Parameter(ParameterSetName = 'List', Position = 1, ValueFromPipelineByPropertyName)]
        [string]$Prefix = '',

        [Parameter(ParameterSetName = 'List')]
        [string]$Cursor,

        [Parameter(ParameterSetName = 'List')]
        [switch]$All,

        [Parameter(ParameterSetName = 'Describe', Mandatory, ValueFromPipelineByPropertyName)]
        [string]$Key
    )

    process {
        try {
            if ($PSCmdlet.ParameterSetName -eq 'Describe') {
                Invoke-ArgusRequest -Path '/api/storage/object' -Query @{ bucket = $Bucket; key = $Key }
                return
            }

            $token = $Cursor
            do {
                $page = Invoke-ArgusRequest -Path '/api/storage/objects' -Query @{
                    bucket = $Bucket
                    prefix = $Prefix
                    cursor = $token
                }
                $page
                $token = $page.cursor
            } while ($All -and $token)
        } catch {
            $PSCmdlet.ThrowTerminatingError($_)
        }
    }
}

function Measure-ArgusStoragePrefix {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Name')]
        [string]$Bucket,

        [Parameter(Position = 1, ValueFromPipelineByPropertyName)]
        [string]$Prefix = '',

        [int]$TimeoutSeconds = 300
    )

    process {
        try {
            Invoke-ArgusRequest -Path '/api/storage/prefix-size' -Query @{ bucket = $Bucket; prefix = $Prefix } -TimeoutSeconds $TimeoutSeconds
        } catch {
            $PSCmdlet.ThrowTerminatingError($_)
        }
    }
}

function Save-ArgusStorageObject {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    [OutputType([System.IO.FileInfo])]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipelineByPropertyName)]
        [Alias('Name')]
        [string]$Bucket,

        [Parameter(Mandatory, Position = 1, ValueFromPipelineByPropertyName)]
        [string]$Key,

        [Parameter(Mandatory, Position = 2)]
        [string]$Path,

        [switch]$PassThru
    )

    process {
        $resolved = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($Path)

        if (-not $PSCmdlet.ShouldProcess($resolved, "Write $Bucket/$Key")) { return }

        try {
            Invoke-ArgusRequest -Path '/api/storage/preview' -Query @{ bucket = $Bucket; key = $Key } -OutFile $resolved -RawResponse | Out-Null
        } catch {
            $PSCmdlet.ThrowTerminatingError($_)
        }

        if ($PassThru) { return (Get-Item -LiteralPath $resolved) }
    }
}

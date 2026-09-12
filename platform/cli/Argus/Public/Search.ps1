function Get-ArgusSearchIndex {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [switch]$Expand,
        [string]$Kind
    )

    try { $answer = Invoke-ArgusRequest -Path '/api/search/index' }
    catch { $PSCmdlet.ThrowTerminatingError($_) }

    if (-not $answer) { return $answer }

    foreach ($source in @($answer.sources)) {
        if ($source -and -not $source.ok) {
            Write-Warning ('{0}: {1}' -f $source.kind, $source.message)
        }
    }

    if (-not $Expand) { return $answer }

    $items = @($answer.items)
    if ($Kind) { $items = @($items | Where-Object { $_.kind -eq $Kind }) }
    return $items
}

$ErrorActionPreference = 'Stop'

$moduleRoot = $PSScriptRoot

$privateFiles = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Private') -Filter '*.ps1' -File -ErrorAction SilentlyContinue | Sort-Object -Property Name)
$publicFiles = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Public') -Filter '*.ps1' -File -ErrorAction SilentlyContinue | Sort-Object -Property Name)

foreach ($file in ($privateFiles + $publicFiles)) {
    . $file.FullName
}

$exported = New-Object System.Collections.Generic.List[string]
$isFunction = { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }

foreach ($file in $publicFiles) {
    $tokens = $null
    $parseErrors = $null
    $tree = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw "$($file.Name) does not parse: $($parseErrors[0].Message)"
    }
    foreach ($definition in $tree.FindAll($isFunction, $false)) {
        $exported.Add($definition.Name)
    }
}

Export-ModuleMember -Function $exported

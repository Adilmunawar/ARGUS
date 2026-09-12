BeforeDiscovery {
    $moduleRoot = Split-Path -Parent $PSScriptRoot
    $manifestPath = Join-Path $moduleRoot 'Argus.psd1'
    $manifestData = Import-PowerShellDataFile -Path $manifestPath

    $sourceFiles = @(
        Get-ChildItem -Path (Join-Path $moduleRoot 'Private') -Filter '*.ps1' -File
        Get-ChildItem -Path (Join-Path $moduleRoot 'Public') -Filter '*.ps1' -File
        Get-Item -Path (Join-Path $moduleRoot 'Argus.psm1')
    )

    $exportedNames = @($manifestData.FunctionsToExport)
    $fileCases = @($sourceFiles | ForEach-Object { @{ Name = $_.Name; FullName = $_.FullName } })
    $functionCases = @($exportedNames | ForEach-Object { @{ FunctionName = $_ } })
}

BeforeAll {
    $moduleRoot = Split-Path -Parent $PSScriptRoot
    $manifestPath = Join-Path $moduleRoot 'Argus.psd1'
    $manifestData = Import-PowerShellDataFile -Path $manifestPath

    $sourceFiles = @(
        Get-ChildItem -Path (Join-Path $moduleRoot 'Private') -Filter '*.ps1' -File
        Get-ChildItem -Path (Join-Path $moduleRoot 'Public') -Filter '*.ps1' -File
        Get-Item -Path (Join-Path $moduleRoot 'Argus.psm1')
    )

    function Get-DefinedFunctionName {
        param([string[]]$Path)

        $names = New-Object System.Collections.Generic.List[string]
        $predicate = { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }
        foreach ($file in $Path) {
            $tokens = $null
            $parseErrors = $null
            $tree = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
            foreach ($definition in $tree.FindAll($predicate, $true)) { $names.Add($definition.Name) }
        }
        return $names
    }

    function Get-InvokedCommandName {
        param([string[]]$Path)

        $names = New-Object System.Collections.Generic.List[string]
        $predicate = { param($node) $node -is [System.Management.Automation.Language.CommandAst] }
        foreach ($file in $Path) {
            $tokens = $null
            $parseErrors = $null
            $tree = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
            foreach ($command in $tree.FindAll($predicate, $true)) {
                $name = $command.GetCommandName()
                if ($name -and $name -match '^[A-Za-z]+-[A-Za-z0-9]+$') { $names.Add($name) }
            }
        }
        return $names
    }

    $allFiles = @($sourceFiles | ForEach-Object { $_.FullName })
    $definedNames = Get-DefinedFunctionName -Path $allFiles
    $invokedNames = Get-InvokedCommandName -Path $allFiles

    Import-Module -Name $manifestPath -Force -ErrorAction Stop
}

AfterAll {
    Remove-Module -Name 'Argus' -Force -ErrorAction SilentlyContinue
}

Describe 'Argus manifest' {
    It 'is a valid module manifest' {
        { Test-ModuleManifest -Path $manifestPath -ErrorAction Stop } | Should -Not -Throw
    }

    It 'names a RootModule that exists' {
        $manifestData.RootModule | Should -Be 'Argus.psm1'
        Test-Path -LiteralPath (Join-Path $moduleRoot $manifestData.RootModule) | Should -BeTrue
    }

    It 'declares Windows PowerShell 5.1 as the floor' {
        $manifestData.PowerShellVersion | Should -Be '5.1'
    }

    It 'declares both editions as compatible' {
        $manifestData.CompatiblePSEditions | Should -Contain 'Desktop'
        $manifestData.CompatiblePSEditions | Should -Contain 'Core'
    }

    It 'lists functions explicitly rather than with a wildcard' {
        $manifestData.FunctionsToExport | Should -Not -Contain '*'
        @($manifestData.FunctionsToExport).Count | Should -BeGreaterThan 0
    }

    It 'exports no cmdlets, aliases or variables' {
        @($manifestData.CmdletsToExport).Count | Should -Be 0
        @($manifestData.AliasesToExport).Count | Should -Be 0
        @($manifestData.VariablesToExport).Count | Should -Be 0
    }

    It 'lists only files that are on disk' {
        $missing = @($manifestData.FileList | Where-Object { -not (Test-Path -LiteralPath (Join-Path $moduleRoot $_)) })
        $missing -join ', ' | Should -BeNullOrEmpty
    }
}

Describe 'House rules' {
    It '<Name> carries no comment' -ForEach $fileCases {
        $tokenErrors = $null
        $tokens = [System.Management.Automation.PSParser]::Tokenize(
            [System.IO.File]::ReadAllText($FullName), [ref]$tokenErrors)
        $comments = @($tokens |
            Where-Object { $_.Type -eq 'Comment' } |
            ForEach-Object { "line $($_.StartLine)" })

        $comments -join '; ' | Should -BeNullOrEmpty
    }

    It '<Name> writes nothing straight to the host' -ForEach $fileCases {
        $tokenErrors = $null
        $tokens = [System.Management.Automation.PSParser]::Tokenize(
            [System.IO.File]::ReadAllText($FullName), [ref]$tokenErrors)
        $offenders = @($tokens |
            Where-Object { $_.Type -eq 'Command' -and $_.Content -eq 'Write-Host' } |
            ForEach-Object { "line $($_.StartLine)" })

        $offenders -join '; ' | Should -BeNullOrEmpty
    }
}

Describe 'Exported surface' {
    It '<FunctionName> is defined exactly once in the module source' -ForEach $functionCases {
        @($definedNames | Where-Object { $_ -eq $FunctionName }).Count | Should -Be 1
    }

    It '<FunctionName> is available after import' -ForEach $functionCases {
        Get-Command -Name $FunctionName -Module 'Argus' -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }

    It 'exports exactly what the manifest lists' {
        $live = @(Get-Command -Module 'Argus' -CommandType Function | Select-Object -ExpandProperty Name | Sort-Object)
        $declared = @($manifestData.FunctionsToExport | Sort-Object)
        Compare-Object -ReferenceObject $declared -DifferenceObject $live | Should -BeNullOrEmpty
    }

    It 'uses only approved verbs' {
        $approved = @(Get-Verb | Select-Object -ExpandProperty Verb)
        foreach ($name in $manifestData.FunctionsToExport) {
            $approved | Should -Contain ($name -split '-')[0]
        }
    }
}

Describe 'Call sites' {
    It 'calls no Verb-Noun command that is neither defined here nor available from the shell' {
        $unresolved = New-Object System.Collections.Generic.List[string]
        foreach ($name in ($invokedNames | Sort-Object -Unique)) {
            if ($definedNames -contains $name) { continue }
            if (Get-Command -Name $name -ErrorAction SilentlyContinue) { continue }
            $unresolved.Add($name)
        }
        $unresolved -join ', ' | Should -BeNullOrEmpty
    }
}

Describe 'Windows PowerShell 5.1 compatibility' {
    It '<Name> parses on this host' -ForEach $fileCases {
        $parseErrors = $null
        $tokens = $null
        [System.Management.Automation.Language.Parser]::ParseFile($FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
        @($parseErrors).Count | Should -Be 0
    }

    It '<Name> uses no operator that Windows PowerShell 5.1 cannot parse' -ForEach $fileCases {
        $forbidden = @('??', '??=', '?.', '?[', '&&', '||', '?')
        $tokenErrors = $null
        $tokens = [System.Management.Automation.PSParser]::Tokenize(
            [System.IO.File]::ReadAllText($FullName), [ref]$tokenErrors)

        $offenders = @($tokens |
            Where-Object { $_.Type -eq 'Operator' -and $forbidden -contains $_.Content } |
            ForEach-Object { "line $($_.StartLine): $($_.Content)" })

        $offenders -join '; ' | Should -BeNullOrEmpty
    }

    It '<Name> uses no construct or parameter that arrived after 5.1' -ForEach $fileCases {
        $patterns = @{
            'using namespace'                  = '(?m)^\s*using\s+namespace\s'
            'ConvertFrom-Json -AsHashtable'    = '-AsHashtable\b'
            'Invoke-* -SkipHttpErrorCheck'     = '-SkipHttpErrorCheck\b'
            'Invoke-* -StatusCodeVariable'     = '-StatusCodeVariable\b'
            'Invoke-* -SkipCertificateCheck'   = '-SkipCertificateCheck\b'
            'ConvertFrom-SecureString -AsPlainText' = '-AsPlainText\b'
            'Get-Content -AsByteStream'        = '-AsByteStream\b'
            'Split-Path -LeafBase'             = '-LeafBase\b'
            'bare $IsWindows or $IsLinux'      = '(?m)\$Is(Windows|Linux|MacOS)\b'
            '$PSStyle'                         = '\$PSStyle\b'
            'clean block'                      = '(?m)^\s*clean\s*\{'
            'Join-String'                      = '\bJoin-String\b'
            '[IO.Path]::Join'                  = '(?i)\[(System\.)?IO\.Path\]::Join\b'
            'ternary-style Write-Output'       = '\bForEach-Object\s+-Parallel\b'
        }

        $text = [System.IO.File]::ReadAllText($FullName)
        $hits = New-Object System.Collections.Generic.List[string]
        foreach ($label in $patterns.Keys) {
            if ($text -match $patterns[$label]) { $hits.Add($label) }
        }
        $hits -join '; ' | Should -BeNullOrEmpty
    }
}

Describe 'State-changing cmdlets' {
    It 'declares SupportsShouldProcess on every cmdlet that changes state' {
        $stateChanging = @('Connect-Argus', 'Disconnect-Argus', 'Clear-ArgusSessionCache',
            'Save-ArgusStorageObject', 'Invoke-ArgusApi')
        foreach ($name in $stateChanging) {
            (Get-Command -Name $name -Module 'Argus').Parameters.ContainsKey('WhatIf') | Should -BeTrue
        }
    }

    It 'reads the estate with GET-only cmdlets that do not ask for confirmation' {
        $readOnly = @('Get-ArgusOverview', 'Get-ArgusHealth', 'Get-ArgusComponentHealth', 'Get-ArgusHost')
        foreach ($name in $readOnly) {
            (Get-Command -Name $name -Module 'Argus').Parameters.ContainsKey('WhatIf') | Should -BeFalse
        }
    }
}

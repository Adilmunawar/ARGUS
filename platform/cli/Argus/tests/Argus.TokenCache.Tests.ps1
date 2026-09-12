BeforeAll {
    $moduleRoot = Split-Path -Parent $PSScriptRoot
    Import-Module -Name (Join-Path $moduleRoot 'Argus.psd1') -Force -ErrorAction Stop

    $savedHome = $env:ARGUS_CLI_HOME
    $savedPlaintext = $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE

    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('argus-cli-tests-' + [guid]::NewGuid().ToString('n'))
    New-Item -Path $sandbox -ItemType Directory -Force | Out-Null

    $env:ARGUS_CLI_HOME = $sandbox
    $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE = '1'
}

AfterAll {
    $env:ARGUS_CLI_HOME = $savedHome
    $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE = $savedPlaintext
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
    Remove-Module -Name 'Argus' -Force -ErrorAction SilentlyContinue
}

Describe 'Session cache location' {
    It 'honours ARGUS_CLI_HOME' {
        InModuleScope 'Argus' {
            Get-ArgusSessionCachePath
        } | Should -Be (Join-Path $sandbox 'session.json')
    }

    It 'reports the protection it will actually use' {
        $state = Get-ArgusCacheState
        if ($state.DpapiAvailable) {
            $state.Protection | Should -Be 'dpapi'
            $state.Platform | Should -Be 'Windows'
        } else {
            $state.Protection | Should -Be 'plaintext'
            $state.Platform | Should -Be 'Non-Windows'
        }
    }
}

Describe 'Session cache round trip' {
    BeforeEach {
        InModuleScope 'Argus' { Remove-ArgusSessionCache -Confirm:$false | Out-Null }
    }

    It 'writes, reads back and removes a session' {
        $result = InModuleScope 'Argus' {
            $connection = [pscustomobject]@{
                BaseUri    = [uri]'https://console.example:8787/'
                Origin     = 'https://console.example:8787'
                AuthMode   = 'session'
                Subject    = 'operator.one'
                CookieName = '__Host-argus_sid'
                Cookie     = 'a-token-value-that-must-survive-the-trip'
            }

            $saved = Save-ArgusSessionCache -Connection $connection -Confirm:$false
            $read = Read-ArgusSessionCache

            [pscustomobject]@{
                Saved = $saved
                Read  = $read
            }
        }

        $result.Saved.Written | Should -BeTrue
        $result.Read | Should -Not -BeNullOrEmpty
        $result.Read.Cookie | Should -Be 'a-token-value-that-must-survive-the-trip'
        $result.Read.CookieName | Should -Be '__Host-argus_sid'
        $result.Read.Subject | Should -Be 'operator.one'
        $result.Read.Origin | Should -Be 'https://console.example:8787'
        $result.Read.BaseUri.AbsoluteUri | Should -Be 'https://console.example:8787/'
        $result.Read.Protection | Should -Be $result.Saved.Protection
    }

    It 'never leaves the token in clear text on disk when DPAPI is available' {
        $observed = InModuleScope 'Argus' {
            $connection = [pscustomobject]@{
                BaseUri    = [uri]'https://console.example:8787/'
                Origin     = 'https://console.example:8787'
                AuthMode   = 'session'
                Subject    = 'operator.one'
                CookieName = '__Host-argus_sid'
                Cookie     = 'a-token-value-that-must-survive-the-trip'
            }
            $saved = Save-ArgusSessionCache -Connection $connection -Confirm:$false
            [pscustomobject]@{
                Protection = $saved.Protection
                Text       = [System.IO.File]::ReadAllText($saved.Path)
            }
        }

        if ($observed.Protection -eq 'dpapi') {
            $observed.Text | Should -Not -Match 'a-token-value-that-must-survive-the-trip'
        } else {
            $observed.Protection | Should -Be 'plaintext'
            $observed.Text | Should -Match 'a-token-value-that-must-survive-the-trip'
        }
    }

    It 'removes the cache and then reads nothing' {
        $outcome = InModuleScope 'Argus' {
            $connection = [pscustomobject]@{
                BaseUri    = [uri]'https://console.example:8787/'
                Origin     = 'https://console.example:8787'
                AuthMode   = 'session'
                Subject    = 'operator.one'
                CookieName = 'argus_sid'
                Cookie     = 'short-lived'
            }
            Save-ArgusSessionCache -Connection $connection -Confirm:$false | Out-Null
            $removed = Remove-ArgusSessionCache -Confirm:$false
            [pscustomobject]@{ Removed = $removed; After = (Read-ArgusSessionCache) }
        }

        $outcome.Removed | Should -BeTrue
        $outcome.After | Should -BeNullOrEmpty
    }

    It 'refuses to write anything when there is no DPAPI and no explicit opt-in' {
        $outcome = InModuleScope 'Argus' {
            $previous = $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE
            $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE = ''
            try {
                $connection = [pscustomobject]@{
                    BaseUri    = [uri]'https://console.example:8787/'
                    Origin     = 'https://console.example:8787'
                    AuthMode   = 'session'
                    Subject    = 'operator.one'
                    CookieName = 'argus_sid'
                    Cookie     = 'should-not-be-written'
                }
                Save-ArgusSessionCache -Connection $connection -Confirm:$false
            } finally {
                $env:ARGUS_CLI_ALLOW_PLAINTEXT_CACHE = $previous
            }
        }

        if (Get-ArgusCacheState | Select-Object -ExpandProperty DpapiAvailable) {
            $outcome.Written | Should -BeTrue
            $outcome.Protection | Should -Be 'dpapi'
        } else {
            $outcome.Written | Should -BeFalse
            $outcome.Protection | Should -Be 'memory'
            $outcome.Reason | Should -Not -BeNullOrEmpty
        }
    }
}

$script:ArgusProtectedDataChecked = $false
$script:ArgusProtectedDataAvailable = $false

function Test-ArgusWindowsPlatform {
    [CmdletBinding()]
    [OutputType([bool])]
    param()

    if ($PSVersionTable.PSEdition -eq 'Desktop') { return $true }

    $flag = Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue
    if ($null -ne $flag) { return [bool]$flag.Value }

    return $false
}

function Test-ArgusProtectedData {
    [CmdletBinding()]
    [OutputType([bool])]
    param()

    if ($script:ArgusProtectedDataChecked) { return $script:ArgusProtectedDataAvailable }
    $script:ArgusProtectedDataChecked = $true
    $script:ArgusProtectedDataAvailable = $false

    if (-not (Test-ArgusWindowsPlatform)) { return $false }

    if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
        foreach ($assembly in @('System.Security', 'System.Security.Cryptography.ProtectedData')) {
            if ('System.Security.Cryptography.ProtectedData' -as [type]) { break }
            try { Add-Type -AssemblyName $assembly -ErrorAction Stop } catch { }
        }
    }

    if ('System.Security.Cryptography.ProtectedData' -as [type]) {
        $script:ArgusProtectedDataAvailable = $true
    }

    return $script:ArgusProtectedDataAvailable
}

function Get-ArgusHomeDirectory {
    [CmdletBinding()]
    [OutputType([string])]
    param()

    if ($env:ARGUS_CLI_HOME) { return $env:ARGUS_CLI_HOME }

    if (Test-ArgusWindowsPlatform) {
        $base = $env:LOCALAPPDATA
        if (-not $base) { $base = $env:APPDATA }
        if (-not $base) { $base = [Environment]::GetFolderPath('LocalApplicationData') }
        if (-not $base) { $base = [Environment]::GetFolderPath('UserProfile') }
        return (Join-Path (Join-Path $base 'Argus') 'cli')
    }

    $base = $env:XDG_CONFIG_HOME
    if (-not $base) {
        $profileRoot = $env:HOME
        if (-not $profileRoot) { $profileRoot = [Environment]::GetFolderPath('UserProfile') }
        $base = Join-Path $profileRoot '.config'
    }
    return (Join-Path $base 'argus')
}

function Get-ArgusSessionCachePath {
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return (Join-Path (Get-ArgusHomeDirectory) 'session.json')
}

function Set-ArgusFilePermission {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
    param([Parameter(Mandatory)][string]$Path)

    if (Test-ArgusWindowsPlatform) { return }
    $chmod = Get-Command -Name 'chmod' -CommandType Application -ErrorAction SilentlyContinue
    if (-not $chmod) { return }
    if ($PSCmdlet.ShouldProcess($Path, 'Restrict file permissions to the owner')) {
        & $chmod.Path '600' $Path 2>$null
    }
}

function Initialize-ArgusTls {
    [CmdletBinding()]
    param()

    if ($PSVersionTable.PSEdition -ne 'Desktop') { return }
    try {
        $wanted = [Net.SecurityProtocolType]::Tls12
        if (([Net.ServicePointManager]::SecurityProtocol -band $wanted) -ne $wanted) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor $wanted
        }
    } catch { }
}

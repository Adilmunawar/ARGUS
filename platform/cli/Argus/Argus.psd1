@{
    RootModule        = 'Argus.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '5f1c9a2e-3b7d-4c8a-9e21-7d0c1f6a8b44'
    Author            = 'Zaraat Dost Platform'
    Description       = 'Client for the Argus Console API. Every command opens a pull request or reads state; none has privileges of its own.'
    PowerShellVersion = '7.4'
    FunctionsToExport = @('Connect-Argus','Get-ArgusOverview','Get-ArgusApp','Publish-ArgusApp','Approve-ArgusDeployment','Get-ArgusBackup','New-ArgusDatabaseCredential','Grant-ArgusTierAccess','Invoke-ArgusRunbook','Get-ArgusAudit')
}

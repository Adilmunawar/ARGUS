@{
    RootModule           = 'Argus.psm1'
    ModuleVersion        = '0.3.0'
    GUID                 = '5f1c9a2e-3b7d-4c8a-9e21-7d0c1f6a8b44'
    Author               = 'Zaraat Dost Platform'
    CompanyName          = 'Zaraat Dost'
    Copyright            = 'Zaraat Dost Platform'
    Description          = 'PowerShell client for the Argus console API. It reads the estate the console reads; the console is read-only unless ARGUS_ALLOW_WRITES is set on the server, and this module has no privileges the signed-in operator does not.'

    PowerShellVersion    = '5.1'
    CompatiblePSEditions = @('Desktop', 'Core')

    FunctionsToExport    = @(
        'Clear-ArgusSessionCache', 'Connect-Argus', 'Disconnect-Argus',
        'Get-ArgusAlert', 'Get-ArgusAlertGroup', 'Get-ArgusAlertReceiver',
        'Get-ArgusAlertSilence', 'Get-ArgusAwsAlarm', 'Get-ArgusAwsBucket',
        'Get-ArgusAwsCost', 'Get-ArgusAwsDatabase', 'Get-ArgusAwsIdentity',
        'Get-ArgusAwsInstance', 'Get-ArgusCacheClient', 'Get-ArgusCacheKeyspace',
        'Get-ArgusCacheMemory', 'Get-ArgusCacheServer', 'Get-ArgusCacheState',
        'Get-ArgusCapability', 'Get-ArgusComponentHealth', 'Get-ArgusConnection',
        'Get-ArgusConsoleMetric', 'Get-ArgusContainer', 'Get-ArgusContainerStatistic',
        'Get-ArgusHealth', 'Get-ArgusHeartbeat', 'Get-ArgusHost',
        'Get-ArgusIncident', 'Get-ArgusLog', 'Get-ArgusLogLabel',
        'Get-ArgusLogPattern', 'Get-ArgusLogVolume', 'Get-ArgusMetric',
        'Get-ArgusMetricRule', 'Get-ArgusMetricSeries', 'Get-ArgusMetricStore',
        'Get-ArgusMetricTarget', 'Get-ArgusOverview', 'Get-ArgusPostgresActivity',
        'Get-ArgusPostgresDatabase', 'Get-ArgusPostgresReplication', 'Get-ArgusPostgresRole',
        'Get-ArgusPostgresServer', 'Get-ArgusPostgresStatement', 'Get-ArgusPostgresTable',
        'Get-ArgusQueueAccount', 'Get-ArgusQueueConsumer', 'Get-ArgusQueueServer',
        'Get-ArgusQueueStream', 'Get-ArgusSearchIndex', 'Get-ArgusSecretsHighAvailability',
        'Get-ArgusSecretsSandbox', 'Get-ArgusSecretsSealStatus', 'Get-ArgusSession',
        'Get-ArgusStorageBucket', 'Get-ArgusStorageCapacity', 'Get-ArgusStorageLock',
        'Get-ArgusStorageObject', 'Get-ArgusUptime', 'Invoke-ArgusApi',
        'Measure-ArgusStoragePrefix', 'Receive-ArgusStream', 'Save-ArgusStorageObject'
    )

    CmdletsToExport      = @()
    VariablesToExport    = @()
    AliasesToExport      = @()

    FileList             = @(
        'Argus.psd1', 'Argus.psm1',
        'README.md', 'Private/ArgusEventStream.ps1',
        'Private/ArgusPlatform.ps1', 'Private/ArgusRequest.ps1',
        'Private/ArgusSecureString.ps1', 'Private/ArgusTokenCache.ps1',
        'Public/Alerts.ps1', 'Public/Aws.ps1',
        'Public/Cache.ps1', 'Public/Connection.ps1',
        'Public/Containers.ps1', 'Public/Heartbeats.ps1',
        'Public/Logs.ps1', 'Public/Metrics.ps1',
        'Public/Platform.ps1', 'Public/Postgres.ps1',
        'Public/Queues.ps1', 'Public/Search.ps1', 'Public/Secrets.ps1',
        'Public/Storage.ps1', 'Public/Streams.ps1',
        'tests/Argus.Module.Tests.ps1', 'tests/Argus.TokenCache.Tests.ps1'
    )

    PrivateData          = @{
        PSData = @{
            Tags         = @('Argus', 'Console', 'SelfHosted', 'Windows', 'Operations')
            ProjectUri   = 'https://github.com/zaraatdost/argus'
            ReleaseNotes = 'Parity with the console route table as it now stands, including the live search index and the console own-metrics exposition, and a page cap on the only route that pages.'
        }
    }
}

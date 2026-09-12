# Argus PowerShell module

A client for the Argus console API (`platform/console/server`). Everything it can
do, the console can do: it reads the estate the dashboard reads, through the same
routes, with the same identity, and it holds no privilege of its own.

## What it authenticates against

The console has **no bearer-token, API-key or device-code flow**. Read
`platform/console/server/src/auth/` and the route table in `src/index.js` and
what actually exists is three modes, chosen by `ARGUS_AUTH` on the server:

| `ARGUS_AUTH` | How a client proves who it is | How this module does it |
| --- | --- | --- |
| `session` (default) | `POST /api/auth/login` with `{subject, password}` against an operator in `operators.json`, answered with an opaque 32-byte session cookie | `Connect-Argus -Credential (Get-Credential)` |
| `proxy` | A trusted reverse proxy asserts `remote-user`, proving itself with `x-argus-proxy-auth` from an allow-listed CIDR | `Connect-Argus -ProxySubject ... -ProxySecret ...` |
| `off` | Nothing. Local development, loopback only | `Connect-Argus -NoCredential` |

So the unit of authentication for a non-browser client is **an operator password
exchanged for a session cookie**. There is no non-interactive credential: a
scheduled task has to hold an operator password, and the session it gets back
expires on the console's idle (30 min) and absolute (8 h) timers. See
*Known gaps* below.

In `proxy` mode the four header names are server-configurable
(`ARGUS_AUTH_PROXY_IDENTITY_HEADER` and friends); `-ProxyIdentityHeader`,
`-ProxySecretHeader`, `-ProxyGroupsHeader` and `-ProxyNameHeader` override the
defaults. Note that proxy mode only works from an address inside
`ARGUS_AUTH_TRUSTED_PROXY_CIDRS`: the shared secret alone is not enough.

### The Origin header is not optional

`src/auth/origin.js` refuses any API request that carries a session cookie but
no origin signal (`no-origin-signal`), and refuses any state-changing API
request without one outright. A browser supplies `Sec-Fetch-Site`; a CLI cannot.
So **every request this module makes sends an `Origin` header**, and the console
compares it against its own target origin:

* `ARGUS_AUTH_PUBLIC_ORIGIN` on the server, if set; otherwise
* the scheme and `Host` of the request itself.

By default the module derives `Origin` from the URL you connect to, which is
correct whenever `ARGUS_AUTH_PUBLIC_ORIGIN` is unset or agrees with that URL.
When it does not agree — a console behind a reverse proxy reached directly on
its loopback port, for example — pass the console's public origin explicitly:

```powershell
Connect-Argus -BaseUri 'http://127.0.0.1:8787' -Origin 'https://console.example'
```

A mismatch comes back as `ArgusOriginRejected` with that explanation, not as a
bare 403.

Login and logout additionally require `Content-Type: application/json` and
`x-argus-console: 1`; the module sends both on every request.

## Installing

The module targets **Windows PowerShell 5.1 and PowerShell 7+**, on Windows and
elsewhere. It uses no syntax newer than 5.1 — no `??`, no `?.`, no ternary, no
`&&`/`||`, no `-AsHashtable`, no bare `$IsWindows` — and the test suite enforces
that by tokenising every file.

Copy the `Argus` folder onto the module path and import it (the separator is
`;` on Windows and `:` elsewhere, so this reads it from the platform):

```powershell
$destination = Join-Path ($env:PSModulePath -split [System.IO.Path]::PathSeparator)[0] 'Argus'
Copy-Item -Path .\platform\cli\Argus -Destination $destination -Recurse -Force
Import-Module Argus
```

Or import it in place, which is what the tests do:

```powershell
Import-Module .\platform\cli\Argus\Argus.psd1 -Force
```

## Connecting

```powershell
Connect-Argus -BaseUri 'http://127.0.0.1:8787' -PassThru
```

With no `-BaseUri` it reads `ARGUS_CONSOLE_URL`, then `ARGUS_URL`, then falls
back to `http://127.0.0.1:8787` — the console's own default bind. With no
`-Credential` it first tries the cached session for that URL, and prompts only
if there is none. `-Force` skips the cache and signs in fresh.

A cached cookie the console no longer accepts does not wedge you: when the
identity probe that follows comes back 401, `Connect-Argus` discards the cache
and signs in again with the credential it has, or asks for one. An explicit
`-Origin` (or `ARGUS_CONSOLE_ORIGIN`) always wins over the origin recorded in
the cache.

```powershell
Get-ArgusConnection      # what this session is holding, without a network call
Get-ArgusSession         # what the console says about it: subject, roles, expiry
Disconnect-Argus         # POST /api/auth/logout and drop the cache
```

## Token caching, and exactly what it does

The cached item is the session cookie. It is written to
`%LOCALAPPDATA%\Argus\cli\session.json` on Windows, or
`$XDG_CONFIG_HOME/argus/session.json` (default `~/.config/argus`) elsewhere.
`ARGUS_CLI_HOME` overrides the directory. `Get-ArgusCacheState` reports the path
and the protection in force before you connect.

* **Windows (either edition).** The cookie is sealed with DPAPI —
  `ProtectedData.Protect` at `CurrentUser` scope, with a fixed application
  entropy — and stored base64. Only the same Windows user on the same machine
  can read it back. The file records `"protection": "dpapi"`.
* **Anywhere else.** There is no DPAPI. The module **writes nothing** and holds
  the cookie in process memory for the life of the session, with a warning
  saying so. The file records nothing because there is no file.
* **Anywhere else, with `ARGUS_CLI_ALLOW_PLAINTEXT_CACHE=1`.** You have asked
  for a plaintext cache and you get one: the cookie is written in clear, the
  file records `"protection": "plaintext"`, and the module chmods it to `600`
  when `chmod` is available. This is a deliberate opt-in, not a fallback.

A DPAPI blob sealed by another user or on another machine fails to open; the
module treats that as "no cache" and asks you to sign in again rather than
reporting a corrupt file.

The console rotates the session cookie roughly hourly
(`ARGUS_AUTH_RENEW_MS`). The module notices the rotated cookie on the response
and rewrites the cache, so long-running work does not lose its session halfway.

## What it covers

Every route in the console's table has a cmdlet, and the nouns follow the
console's own sections.

```powershell
Get-ArgusHealth                        # GET /api/health
Get-ArgusCapability                    # what this deployment can do, including writesAllowed
Get-ArgusOverview                      # the estate in one call
Get-ArgusHost                          # host telemetry
Get-ArgusComponentHealth               # all nine /api/*/health probes, as one table
Get-ArgusComponentHealth -Component postgres, storage

Get-ArgusAwsIdentity, Get-ArgusAwsInstance, Get-ArgusAwsBucket
Get-ArgusAwsDatabase, Get-ArgusAwsAlarm, Get-ArgusAwsCost

Get-ArgusStorageCapacity
Get-ArgusStorageBucket -Expand
Get-ArgusStorageLock
Get-ArgusStorageObject -Bucket surveys -Prefix '2026/' -All
Get-ArgusStorageObject -Bucket surveys -Prefix '2026/' -All -MaximumPage 500
Get-ArgusStorageObject -Bucket surveys -Key '2026/plot-14.jpg'
Measure-ArgusStoragePrefix -Bucket surveys -Prefix '2026/'
Save-ArgusStorageObject -Bucket surveys -Key '2026/plot-14.jpg' -Path .\plot-14.jpg

Get-ArgusPostgresServer, Get-ArgusPostgresDatabase, Get-ArgusPostgresRole
Get-ArgusPostgresActivity, Get-ArgusPostgresStatement, Get-ArgusPostgresReplication
Get-ArgusPostgresTable -Database argus

Get-ArgusCacheServer, Get-ArgusCacheMemory, Get-ArgusCacheClient, Get-ArgusCacheKeyspace
Get-ArgusQueueServer, Get-ArgusQueueAccount, Get-ArgusQueueStream, Get-ArgusQueueConsumer
Get-ArgusSecretsSealStatus, Get-ArgusSecretsHighAvailability, Get-ArgusSecretsSandbox

Get-ArgusLogLabel
Get-ArgusLogLabel -Name container
Get-ArgusLog -Query '{container="argus-console"}' -Limit 200
Get-ArgusLogVolume -Query '{container="argus-console"}'
Get-ArgusLogPattern -Query '{container="argus-console"}'

Get-ArgusMetricTarget, Get-ArgusMetricRule, Get-ArgusMetricStore
Get-ArgusMetric -Name up
Get-ArgusMetricSeries -Name up -Window (New-TimeSpan -Hours 6) -Points 240

Get-ArgusAlert -Expand, Get-ArgusAlertGroup, Get-ArgusAlertSilence, Get-ArgusAlertReceiver
Get-ArgusContainer -Expand
Get-ArgusContainer -Id argus-console
Get-ArgusContainerStatistic -Id argus-console

Get-ArgusHeartbeat 50, Get-ArgusUptime, Get-ArgusIncident 20

Get-ArgusSearchIndex -Expand
Get-ArgusSearchIndex -Expand -Kind Bucket
Get-ArgusConsoleMetric
```

`Get-ArgusStorageObject` is the only route that pages, so `-All` is capped at
`-MaximumPage` pages (100 by default). When the cap stops a listing early it
warns with the cursor to resume from, rather than looping until the bucket ends.

`Get-ArgusSearchIndex` reads `GET /api/search/index`, the flat live index behind
the command palette: one entry per bucket, database, stream, container and
firing alert, each carrying the console route that opens it. It is capped at
2000 entries and cached for 30 seconds on the server, and a reader that is down
is reported as a named unavailable source rather than silently contributing
nothing — the cmdlet raises one warning per such source.

`Get-ArgusConsoleMetric` reads `GET /metrics`, the console's own Prometheus
exposition: request counts by route and status, a latency histogram with
event streams excluded, open stream count and uptime. It returns the text as
lines, so `Get-ArgusConsoleMetric | Select-String argus_console_requests_total`
works as it reads. `/metrics` is public, because a Prometheus scrape carries no
session, so it publishes `argus_console_build_info` only to a reader that is
signed in — the same reason `GET /api/health` withholds the version from an
anonymous caller.

`Save-ArgusStorageObject` reads `GET /api/storage/preview`, which is the only
route that returns an object's bytes — and it is a preview route, not a general
download. The server serves `.png .jpg .jpeg .gif .webp .bmp .txt .log .json
.csv .yaml .yml .pdf` only, up to 5 MB, so anything else comes back as
`ArgusUnsupportedType` (415) or `ArgusTooLarge` (413). There is no route that
streams an arbitrary object, so this module cannot pretend to be one.

Pipelines work where the shapes line up:

```powershell
Get-ArgusStorageBucket -Expand | Get-ArgusStorageObject -Prefix '2026/'
Get-ArgusPostgresDatabase -Expand | Get-ArgusPostgresTable
Get-ArgusQueueStream -Expand | Get-ArgusQueueConsumer
Get-ArgusContainer -Expand | Get-ArgusContainerStatistic
```

### Server-sent event streams

Four routes are SSE rather than JSON. `Receive-ArgusStream` reads them and emits
one object per event, stopping at `-Seconds` (default 30) or after `-First`
events. Because the read blocks on the socket, the deadline is checked between
frames; the console's `: ping` heartbeat (every 15 s) keeps that from stalling,
so the stop can overshoot `-Seconds` by up to one ping. The socket timeouts are
sized from `-Seconds` rather than fixed, because on PowerShell 7 the request
timeout covers the whole read and a fixed one would cut a long stream off.

Logs and container streams exist only when the server has Loki or the Docker
socket proxy configured; without them the route answers 200 with a JSON reason
instead of an event stream, and that arrives as an `ArgusStreamUnavailable`
error carrying the server's explanation rather than as silence.

```powershell
Receive-ArgusStream Heartbeats -Seconds 60
Receive-ArgusStream Logs -Query '{container="argus-console"}' -First 50
Receive-ArgusStream ContainerLogs -ContainerId argus-console -Tail 100
Receive-ArgusStream ContainerEvents -Seconds 120
```

### The escape hatch

`Invoke-ArgusApi` reaches any route directly, and is the only cmdlet that will
send a non-GET method. It is `ConfirmImpact = 'High'`, so a write asks first.

```powershell
Invoke-ArgusApi -Path '/api/pg/tables' -Query @{ database = 'argus' }
```

## Read-only by default

The console refuses every method other than GET and HEAD before it even looks a
route up, unless `ARGUS_ALLOW_WRITES=1` (`platform/compose/.env.example` ships
it as `0`). The current route table has no mutating route at all — the only
non-GET endpoints in the whole server are `/api/auth/login` and
`/api/auth/logout`. So:

* Every cmdlet here except `Connect-Argus`, `Disconnect-Argus` and
  `Invoke-ArgusApi` is a GET.
* `SupportsShouldProcess` is on the cmdlets that actually change something:
  `Connect-Argus` and `Disconnect-Argus` (they mint and destroy a server-side
  session), `Clear-ArgusSessionCache` and `Save-ArgusStorageObject` (they write
  or delete a local file), and `Invoke-ArgusApi` (it can send a POST).
* A 405 from a read-only console comes back as a `ArgusReadOnly` error record
  naming `ARGUS_ALLOW_WRITES`, not as an unexplained failure.

## Errors

Failures are error records, not printed text. `Write-Host` appears nowhere in
the module. The identifiers you can trap on:

| `FullyQualifiedErrorId` | Means |
| --- | --- |
| `ArgusNotConnected` | No connection and no usable cache. Run `Connect-Argus`. |
| `ArgusUnauthenticated` | 401. The session expired or was never established. |
| `ArgusOriginRejected` | 403 `cross-site`. The `Origin` does not match the console's target origin. |
| `ArgusReadOnly` | 405 `read-only`. `ARGUS_ALLOW_WRITES` is not set on the server. |
| `ArgusThrottled` | 429. Sign-in lockout or the verify queue is full; the server's message says how long to wait. |
| `ArgusNoSuchEndpoint` | 404. |
| `ArgusUnsupportedType` | 415. The object is not one of the previewable types. |
| `ArgusTooLarge` | 413. The object is over the console's 5 MB preview ceiling. |
| `ArgusUnreachable` | The console did not answer at all. |
| `ArgusNoSessionCookie` | Sign-in succeeded but set no cookie. |
| `ArgusStreamUnavailable` | A stream route answered with JSON, not events — usually the upstream is not configured. |
| `ArgusStreamInterrupted` | A stream ended before its deadline. |

A cmdlet that rethrows one of these through `ThrowTerminatingError` appends its
own name, so the value you actually match on is `ArgusUnauthenticated,Get-ArgusHealth`.
Trap on the prefix.

## Tests

[Pester 5](https://pester.dev):

```powershell
Invoke-Pester -Path .\platform\cli\Argus\tests -Output Detailed
```

They check that the manifest is valid, that every name in `FunctionsToExport` is
defined exactly once in the source and present after import, that every
`Verb-Noun` call site resolves to something that exists (the defect that made
version 0.1.0 inert was a call to `Get-ArgusDeviceCodeToken`, which was defined
nowhere), that every file tokenises without a single operator Windows PowerShell
5.1 cannot parse, that no file carries a comment token or a `Write-Host`, that
every name in `FileList` is on disk, and that the session cache round-trips
under whichever protection the host actually supports.

## Known gaps

* **There is no machine credential.** A scheduled task must hold an operator
  password and re-run `Connect-Argus` when the console's absolute timeout
  expires. `operators.json` records already carry an unused `credentials` array
  (`src/auth/operators.js`), which is the obvious place for a hashed,
  scope-limited API token — but nothing reads it and no route accepts one.
* **Streams do not resume.** `startEventStream` supports `Last-Event-ID` replay;
  `Receive-ArgusStream` does not send one yet.
* **No `-SkipCertificateCheck`.** It cannot be done identically on both editions
  without turning validation off process-wide, so a private CA has to be trusted
  in the machine store instead.

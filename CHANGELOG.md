# Changelog

All notable changes to the Argus plan and platform. Dated, with the reason, because a platform whose history nobody can explain is a platform nobody can safely change.

## [0.7.0] - 2026-09-12

CI had been red on `main` since 2026-09-09 and every pull request was blocked by it. Fixing that surfaced a wider problem: several advertised features could not work, because nine bind mounts in `docker-compose.yml` pointed at paths the repository never contained. Docker answers a missing bind source by creating an empty directory and carrying on, so those services started unconfigured or crash-looped, and nothing said so.

### Fixed
- **CI was red for two independent reasons.** The secret scan matched a code comment in `docker-compose.yml` and a PowerShell *variable name* in `bootstrap.ps1`; a grep cannot tell a credential from the word "password". It is replaced by a scanner that understands comments, variable references, function calls, property access, command lines, placeholders and entropy, and that proves itself against 43 known-good and known-bad cases before every run. Separately, `sandbox.js` asserted a screen count of 10 while the console registers 13, failing all nine environments.
- **The three test harnesses had drifted.** All carried the same stale 10-route list, so `stack`, `system` and `storage` were never exercised by any suite. Each now asserts that the set it covers equals the set the console registers, so the next screen cannot be added without the tests noticing. That widened coverage immediately found three real defects, all fixed: `storage` was registered but orphaned, reachable only by typing its URL; `Refresh` on the system screen called `A.go` to the route it was already on, which fires no `hashchange` and therefore did nothing at all; and `Refresh` on both new screens stayed mute when the API was not answering, which is indistinguishable from a frozen console.
- **Six assertions could not fail.** The preference-tamper loop wrote all six hostile blobs in one pass, each overwriting the last, so five were never exercised and the record claiming they "were survived" was passed the literal `true`. Four stress outcomes recorded "skipped" as a pass, so removing the audit sort header, the identity tabs or the whole session player would have left those suites green for ever. The interval-leak accounting decremented on every `clearInterval`, so the net could go negative and hide a leak.
- **The console server ignored two query parameters.** `/api/pg/tables?database=` passed a string where an options object was expected, so it always returned the `postgres` database's tables *while labelling them with the name that was asked for*. `/api/queues/consumers?stream=` filtered nothing.
- **A malformed timeout silently disabled every timeout.** Three modules parsed `ARGUS_UPSTREAM_TIMEOUT_MS` with a bare `Number()`, and `NaN` timeouts never fire. There is now one positive-integer reader and all five modules use it.
- The TTL cache never evicted while its keys came from user-supplied query strings; any `HeadObject` failure was cached as proof a key did not exist, which could rename correct keys; the 5 MB preview cap was a no-op when `ContentLength` was absent; `DescribeAlarms` read only its first page so `inAlarm` undercounted; decoded request paths were logged verbatim, so `%0a` forged log lines.
- **The object-storage init tool never re-applied retention** on an existing bucket and compared only the lock mode, so one day of retention against a declared 35-day COMPLIANCE lock passed every boot green, in a tool whose header promises it exits non-zero on mismatch.
- The GitOps secret guard used an inline `(?i)` flag, invalid in the ECMA-262 dialect JSON Schema specifies; it worked only because CI validates with Python. It now also constrains secret-named *keys*, not just values.
- `down.ps1` listed five of eight profiles while claiming every one, so garnet, nats and openbao were left to `--remove-orphans`, which force-removes them and bypasses the stop ordering and grace periods compose sets. `bootstrap.ps1` validated the compose file in the caller's working directory rather than its own.
- `publish.sh` sent its branch-protection payload as untyped strings, so GitHub answered 422, the error was swallowed, and it reported that protection needed a paid plan.
- **No compose profile except `parity` could start alone** — and `parity` could not start at all, because it depends on services behind other profiles and Compose resolves `depends_on` only against enabled ones.

### Added
- **Authentication on the console API.** It had none, and the Dockerfile bound `0.0.0.0`, so anyone who could reach the port got object previews, live SQL statement text, vault seal state and this host's network inventory. Sessions are server-side behind a `__Host-` cookie, origin-checked rather than CSRF-tokened, with scrypt passwords from `node:crypto`, throttling and lockout, and audit that never records a credential. `ARGUS_AUTH=off` on a non-loopback bind refuses to start.
- **Live streaming**: SSE with heartbeats and a ring buffer that replays from `Last-Event-ID`, a Loki reader turning a WebSocket tail into an event stream, Prometheus, Alertmanager and container readers, and a heartbeat store with uptime arithmetic and incident history. Every upstream is optional and answers "not configured" rather than hanging.
- **A live log screen**, a reusable heartbeat bar, a live alert inbox on the security screen, and a multiplexed `EventSource` torn down by the existing `onLeave` hook.
- **The four stacks compose mounted but never contained**: the observability configuration (Prometheus with seven rule files, Loki, Alloy, Grafana provisioning, the Alertmanager template), the Guacamole schema seed with a break-glass admin replacing the stock account, single-node Nomad, and the OpenBao policies `provision.sh` has always looked for.
- **An S3 parity harness**: 23 legs over a 32-row conformance matrix derived from SeaweedFS's own route registrations, reporting conforms / differs / absent-by-design / untestable per feature. Where there is no expectation it reports *untestable*, never silently *conform*. The reference is LocalStack pinned to 4.14.0 — the last release before the Community edition was discontinued and the image began requiring a paid token — and is optional throughout, so the suite can equally be pointed at real AWS.
- **Mailpit**, because `.env.example` had pointed `SMTP_HOST` at a service that did not exist since the observability profile was written.
- **The OpenTofu module** `vm-sql-01.tf` has always declared, so `tofu init` no longer fails on the only IaC file in the tree.
- New CI checks: every compose bind mount resolves to a committed path, every profile can start alone, every SQL and HCL file parses, every GitOps kind has a schema, and the console server's tests run at all — they never had.

### Changed
- **Code and configuration carry no comments.** 7,629 lines across 68 files. Names, structure and layout carry the meaning; prose lives in README and docs, where a reader finds it deliberately. Two checks enforce it, each with a `--fix` mode that is the same code path, so check and fix cannot disagree.
- The PowerShell CLI was dead three ways: `Connect-Argus` called a function defined nowhere in the repository, the manifest demanded 7.4 while the platform targets 5.1 and the body used `??`, and its comment promised DPAPI caching the code did not do. It is a real module now, and its Pester suite fails on any operator or construct 5.1 rejects.

### Note
- 295 property checks, 125 sandbox checks and 66 server tests pass, up from 247, 113 and 34. The server tests had never run in CI.

## [0.6.1] - 2026-09-08

An adversarial audit was run against the console by an agent that did not write it, with every finding verified by executing the page rather than reading it. It found ten defects that the 153-assertion suite had passed over, including one critical. All are fixed, and each has a regression in the new **GUARD** suite.

### Fixed
- **Critical: the type-to-confirm on destructive actions did nothing.** `ui.btn` expressed disabled with `aria-disabled` and a class but never the native property, and `confirmDestructive` guarded on that never-set property. Confirm fired with the name field empty, on all twelve callers: rollback, bucket delete, host quarantine, grant revoke, AG failover. Disabled is still `aria-disabled` rather than the native attribute, because an operator needs to read *why* a control is unavailable and a natively disabled button tells them nothing, but the guard now consults a live flag and the click handler is always attached.
- **The skip link destroyed the page.** `href="#main"` set a hash, the router read it as a route named `main`, found no screen, and painted "that screen does not exist". The first focusable element on every page was a trap for exactly the keyboard and screen-reader users it exists for. The router now ignores any hash that is not a route.
- **Runbook transcripts outlived their screen.** Timers were cleared only on a subsequent run, so navigating away left a chain appending to a detached node and flashing its result over whatever you had moved to. Screens can now register teardown through `A.onLeave`.
- **The elevation countdown mixed two clocks.** Expiry was derived from the fixed demonstration clock while the tick counted against wall time, so a two-hour grant displayed as twelve hours. An already-expired grant also installed an interval whose stale closure fired for ever; three "elevation released" messages arrived in 3.2 seconds.
- **Three deep links opened the wrong tab.** `ui.tabs` always selected the first tab, so `#/identity/grants` showed People while the title and breadcrumb said grants. Tabs now take an initial selection. The security screen had worked around the same gap by reordering its tablist, which silently moved the tabs about depending on how you arrived; it selects instead.
- **Every table announced its sort on first paint.** Thirty-one tables shouting at a screen reader on every route change, each announcement racing and dropping the one before it. Only an operator-initiated sort announces now.
- **The query editor did not enforce the read-only claim it made.** `SELECT * INTO staff_copy FROM staff` writes a table, and `SELECT pg_terminate_backend(1)` kills a session; both were accepted because both begin with SELECT. Meanwhile a row containing the word "update" in a string literal was rejected. Comments and literals are now stripped before the keyword scan, and `SELECT ... INTO` and writing routines are refused.
- **Focus was lost between chained dialogs.** A dialog opened from inside another captured `<body>` as its opener, so closing it dropped focus to the document. Openers are now a stack.
- The runbook screen claimed a second person had to approve a run, then ran after the step-up alone. The copy now says what the prototype actually does and that the gate is specified rather than built.
- Graph node kinds carrying spaces or a comma produced junk class tokens, and eleven `gnode-*` classes had no rule at all. Kinds are sanitised, and pipeline freshness now carries a stroke treatment as well as a fill, because colour alone is not a signal a colour-blind operator can read.

### Added
- The **GUARD** suite: ten regressions, one per finding.
- A check that **every class used in the markup is defined in a stylesheet**, which caught the undefined graph node kinds on its first run.

### Note
- Four categories came back genuinely clean, which is worth recording: no `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or string-built DOM anywhere, and no data path reaching `href`, `src` or `formaction`; no secret value rendered; rendering is deterministic apart from dialog ids; and button names are resource-qualified throughout.

## [0.6.0] - 2026-09-08

### Added
- **The console prototype is now a working application**, not six static screens. Ten sections from `docs/10-CONSOLE-DESIGN.md`, built as a routed single-page application that still opens from `file://` with no build step, no server and no network.
  - **Hash routing** with real links, so every resource has a URL that can be pasted into an alert or a runbook. Two levels at most, list then detail with tabs; Azure's blade stacking is the anti-pattern.
  - **A command palette** on `Ctrl`/`Cmd`+`K` over every application, host, VM, bucket, database, runbook, screen and action, with subsequence matching, arrow-key selection and `aria-activedescendant`. Plus `g`-then-letter jumps, `/` to focus the filter, and `?` for the shortcut list.
  - **Token-based property filtering** on the tables that need it, several predicates at once combined with AND. CloudTrail allows one attribute at a time, which is the most-complained-about limitation in the thing it replaces.
  - **Recorded browser RDP and SSH** in a drawer that is mounted once and survives navigation, so an operator mid-restore can check a dashboard without dropping the shell. Connecting states in order what happens: role and tier checked, elevation requested if absent, a one-time OpenBao credential the operator never sees, recording to `argus-sessions`, clipboard and file transfer gated by role, credential revoked at expiry.
  - **Just-in-time elevation** with a reason, an approver, a four-hour ceiling and a live countdown in the shell. Approving your own request is refused, and so is approving your own deployment: the four-eyes rule is enforced in the interface, not just written down.
  - **The reconciler's plan and blast radius** shown before a deployment is approved, including which services are touched, what depends on them, and how many people are signed in right now.
  - **Step-up authentication** before every sensitive action and a typed-name confirmation for anything irreversible, following the delete ladder rather than putting destructive items next to harmless ones in a menu.
- **A component library** (`js/ui.js`) that builds DOM rather than HTML strings. `el()` escapes by construction and throws if handed an `html` key, because this console renders alert rules, commit messages, log lines and file names, and one `innerHTML` on that path is a stored XSS in the highest-value target on the platform.
- **A Content-Security-Policy** on the page itself: `default-src 'none'`, `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`. The suite proves it is enforced by trying to inject an inline script and asserting the injection fails.

### Changed
- **The test suite went from 65 assertions in 10 suites to 153 in 18.** New coverage: the shell boots and every screen registers; deep links resolve; axe runs on overlays as well as screens; focus is trapped in dialogs and restored on close; the command palette works from the keyboard; every table has a caption and working `aria-sort`; the no-match state is worded differently from the empty state; WCAG 1.4.10 reflow at 200% and 400% zoom; layout sanity; a security pass that reads the source; and determinism across repeat visits.
- The prototype is now several files rather than one, so the stylesheet, the component library, the shell and each screen can be reviewed and changed independently. Classic scripts, not ES modules, because modules are blocked by CORS on `file://` and this has to open from a memory stick during a site failure.

### Fixed
- **A stylesheet rule leaked into content.** `.col` was both the shell's full-height layout column and the utility used to stack two lines inside a table cell, so `min-height: 100vh` applied to every audit row. The audit screen was 9,659px tall and the applications screen 6,676px. Found by looking at a screenshot, not by a test, which is why the **LAYOUT** suite now asserts that no table row exceeds 220px and no screen runs past 4,200px.
- **`[hidden]` was being overridden.** A class that sets `display` beats the user-agent rule for the `hidden` attribute, so the session drawer and the empty elevation bar were both on screen while marked hidden. The suite now checks that nothing marked hidden has a bounding box.
- **Icons fell back to the default SVG size.** Inline SVG with no intrinsic dimensions renders at 300×150; the search, collapse and burger icons were doing exactly that. Now constrained, and asserted.
- `connect-src 'none'` in the first draft of the CSP would have broken the real console, whose API is same-origin. It is `'self'`.
- The screen scripts loaded before `app.js`, which defines the function they register with, so nothing rendered. `app.js` now loads first and defers its own boot to `DOMContentLoaded`.

### Note
- Everything above is interface. There is still no API, no authentication, no reconciler, no Guacamole and no database, and every number on screen is invented, though the shape of the data follows `docs/02-APPLICATION-INFRASTRUCTURE-MAP.md`. `docs/09-VALIDATION-STATUS.md` is unchanged and still governs what is actually proven.

## [0.5.0] - 2026-09-08

### Changed
- **The platform is named Argus, not ZD Cloud** (ADR-0034, owner decision). ZD Cloud was the company's initials wearing a product's clothes: it tied the platform's identity to the agriculture business and made it indistinguishable from any other tool with the same letters. Argus Panoptes is the watchman who never slept, which is what a platform built on *evidence, not assurance* is trying to be.
- **The identifier prefix is the full word `argus`, never `arg`**: a deliberate three extra characters. ADR-0023 exists to say this platform does not use Flux or Argo; an `arg-` prefix on buckets and clusters would read as Argo to everyone who joins.
- Relabelled across 87 files: AD forest `zd.local` → `argus.local`; buckets `zd-*` → `argus-*`; `ZdConsole` → `ArgusConsole`; PostgreSQL schemas `zd_geo`/`zd_ml`/`zd_console_events` → `argus_*`; NATS subjects `zd.*` → `argus.*`; clusters `zd-hvc-a/b`, `zd-sf-a` and AG `zd-ag1` → `argus-*`; AD groups `ZD-Console-*`/`ZD-Tier0-Admins` → `Argus-*`; AD CS templates `ZD-Issuing-CA`/`ZD-CodeSigning` → `Argus-*`; GitOps `apiVersion: zdcloud/v1` → `argus/v1`; .NET projects `ZdCloud.*` → `Argus.*`; DSC resources `ZdCloud/*` → `Argus/*`; `C:\ZdCloud\` → `C:\Argus\`; PowerShell module `ZDCloud` → `Argus` with `*-Zd*` cmdlets → `*-Argus*`; CLI `zdc` → `argus`; repositories `zd-cloud` → `argus` and `zd-cloud-gitops` → `argus-gitops`.
- **The company is unchanged.** Zaraat Dost remains the company and `zaraatdost.pk` the domain; `console.zaraatdost.pk` and `api.zaraatdost.pk` are untouched. The console shell shows the product over the company, which is the correct relationship.

### Added
- **ADR-0034**: the naming decision, the `argus`-not-`arg` prefix rule and its reason, and the full list of what was relabelled.
- **Q13** in `08-OPEN-QUESTIONS.md`: trademark and `.pk` domain clearance for the name. An older network-monitoring tool and a commodities-pricing firm both use *Argus*; neither is in this market, but neither has been checked. This must close before the name appears anywhere outside this repository.

### Fixed
- **The `validate` workflow could never have gone green.** Both jobs failed for reasons unrelated to any content change. The console suite hardcoded the absolute paths of the sandbox it was first written in (`/home/claude/.npm-global/...`, `/opt/pw-browsers/...`), so `require()` threw before a single assertion ran, on a GitHub runner and on a developer machine alike. It now resolves `playwright` and `axe-core` normally, lets Playwright find the browser it installed, and writes screenshots under the system temp directory. A `package.json` pins both dependencies so `npm ci` works. Verified: 65/65, exit code 0.
- The credential scan matched two lines of prose that describe the credential rule itself. The pattern now excludes a backtick immediately after `password=`, so an inline code span is no longer mistaken for a value. The detection is not weakened.
- **The test count was stale in three places.** The README, `docs/11` and the prototype README still claimed 51/51 from v0.3.0, while the badge and the recorded run said 65/65. `docs/11` now lists the DENS suite and the six responsive widths it actually tests.
- **ADR-0032 was only half-applied.** It added `guac-01` as a third Linux exception in September, but master plan principle 6 still read "two exceptions" and the application-infrastructure map had no row for the host at all. Both corrected. The README's two summary tables, which disagreed with each other about the exception count, are merged into one.

### Changed, editorially
- **Em dashes replaced with ordinary punctuation throughout**, chosen per sentence rather than substituted blindly: a colon before an explanation or a list, commas around an aside, parentheses where an aside had commas of its own, a semicolon or a full stop between independent clauses. En dashes in numeric ranges became hyphens and the ellipsis character became three dots. Table cells meaning "none" now hold a hyphen.
- Removed the traces of the drafting process: a note in `PUBLISHING.md` about a token "pasted into our conversation", and the first-person consultant voice in `docs/11` and the superseded Linux plan. The superseded plan keeps its substance and its date; only the voice changed.

### Not changed, deliberately
- `docs/adr/superseded/` is left exactly as written. It records a plan that was rejected on 7 September; rewriting names inside it would falsify what was actually proposed.
- Four external names are retained: `zd-daily-db-backups` (an existing AWS bucket), `zdost.aoserv.com` (the current production host), and `adilmunawar/ZD-claude-plugin` with its `zd-deploy` / `zd-ops` / `zd-security` plugins (a separate repository, its own change).
- The console mark is still a leaf, inherited from the Mills design system. A leaf suited ZD Cloud and does not obviously suit Argus; the mark needs a decision before console stage C1 ships.

## [0.4.0] - 2026-09-08

### Added
- MIT licence, `CONTRIBUTING.md`, GitHub Actions `validate` workflow (GitOps schema, secret scan, console suite, external-URL check), and issue templates for challenging an ADR or reporting a broken assumption.
- **DENS test suite**: 12 assertions across 1366×768, 1280×800 and 1024×768 asserting that chrome and header stay under 55% of the viewport, all stat tiles clear the fold, and Overview stays under two screens. 65/65 passing.

### Changed
- **Compact density for small-screen laptops**, keyed to viewport *height* rather than width because vertical space is the real constraint on a 1366×768 machine. Below 860px tall, and again below 720px, the whole interface tightens. First card of content on a 1366×768 laptop moves from 445px to 384px; the Overview page from 1126px to 1004px. A 1440×900 screen is untouched.
- Tile grid holds four columns down to 1000px instead of 1200px: the earlier breakpoint forced a second row of tiles at 1024×768 and cost 110px of vertical space.
- README rewritten for a public audience with badges and an at-a-glance table.

## [0.3.0] - 2026-09-08

### Added
- `docs/11-CONSOLE-UX-BENCHMARK-AND-BUGS.md`: AWS Cloudscape, Google Cloud and Azure benchmarked component by component with a verdict on each; the test suite; the full bug register; the fix plan.
- `platform/console/prototype/tests/run-tests.js`, headless-Chromium suite, 9 suites and 51 assertions: axe-core WCAG 2.1 A/AA per screen, real Tab-key focus traversal, contrast from rendered colours, four viewports, touch targets, reduced motion, console errors. Exit code is the failure count so CI can gate on it.

### Changed
- Console prototype rewritten as v2: collapsible rail (Cloudscape app layout / GCP), flashbar, property-filter tokens, breadcrumbs, skip link, live region, `aria-current`, focus-managed navigation.
- **Minimum font size raised from 10px to 11px**: a deliberate, recorded deviation from the Mills design system, because this console is read under pressure.

### Fixed
- **B1/B2 (critical)**: the console was 755px wide on a 390px phone and unusable. Rail collapses at 1200px, drawer at 900px, top bar wraps at 620px; content column changed to `minmax(0,1fr)` because grid items default to `min-width:auto`.
- **B3-B13**, ten click handlers on non-focusable spans; no focus ring outside `.btn`; a Google Fonts fetch that would have failed behind the egress allow-list (ADR-0027); `.delta.up` at 3.73:1; `opacity`-based disabled state; wrapped status pills; 15px touch targets; missing table captions and scopes; no skip link, live region or title changes.
- **T1-T5**: five defects in the test harness itself, which had produced fourteen false failures. Recorded in the bug register beside the real ones.

## [0.2.0] - 2026-09-08

### Added
- `docs/10-CONSOLE-DESIGN.md`: the AWS Console studied as nine repeating patterns, each mapped to a Argus screen; nine console sections specified screen by screen; interaction rules; the Mills design system inherited with three console-only components; a six-stage build order where each stage retires a named existing tool.
- **ADR-0032**: browser RDP/SSH/VM-console via Apache Guacamole. Credential-less (OpenBao issues a one-time, session-scoped credential the operator never sees), time-boxed, fully recorded to the object-locked `argus-sessions` bucket, clipboard and file transfer gated by role.
- **ADR-0033**: the console is the primary surface; Windows Admin Center becomes bootstrap and break-glass only, retired at console stage C6. Grafana explicitly stays.
- `platform/console/prototype/index.html`: a static, clickable prototype of six screens using the Mills tokens, so the design can be argued with before any C# is written.
- `argus-sessions` bucket and `gmsa-guacamole$` added to the GitOps inventory; risk **A11** (Guacamole recording + AD auth + OpenBao credentials on Server 2025) added to the register and to the day-one lab.

### Changed
- **ADR-0003 amended in place**: three Linux exceptions, not two; `gpu-01`, `siem-01`, and now `guac-01`.
- The control-plane assumption that operators reach servers with an RDP client over the VPN is withdrawn. It meant typed credentials, standing access and no record of what happened inside a session, which contradicted the platform's own security case.

## [0.1.1] - 2026-09-08

### Added
- `docs/09-VALIDATION-STATUS.md`: confidence level for every claim in the repository, plus a ten-entry register of the assumptions most likely to be wrong.
- `docs/runbooks/boot-01-day-one.md`: a five-day lab on one spare machine that falsifies the three riskiest assumptions before hardware is ordered.

### Verified
- All 8 `platform/` YAML and JSON files parse.
- `apps/mills/app.yaml` validates against `schemas/app.schema.json`.
- The schema's inline-secret rule was negative-tested and does reject `password=` values in `env`.

### Note
- Nothing else in this repository has been executed. The plan was written without access to Windows Server or hardware.

## [0.1.0] - 2026-09-08

### Added
- Repository scaffold, documentation order, `platform/` layout, the rule that every change is an ADR + changelog line + commit.
- **ADR-0001 ... ADR-0031**: the complete decision record for the Windows-first platform (`docs/01-DECISIONS.md`, one file each under `docs/adr/`).
- **Master plan v0.1.0**: targets as numbers, fourteen capabilities mapped to Windows-native implementations, two-site topology, eight principles, seven phases with exit gates, external dependencies, staffing, three-year cost, hybrid checkpoint.
- **Application-infrastructure map**: every host, VM, Service Fabric application and business application (Mills, loan app, AGIS, ML pipelines, Zaraat Dost AI, the console) traced to identity, port, data store, bucket, secret path, backup, SLO and alert.
- **Security architecture**: threat model, hardware root of trust, tiered AD, WDAC/Authenticode, IPsec east-west, data protection, detection and paging rules, evidence pack, delivery-pipeline security.
- **Network and sites**: eleven zones, addressing, edge, RDMA storage fabric, egress proxy, Site B bandwidth, power sequencing.
- **Control plane**: GitOps repo layout, first-party reconciler design, console screens/roles/API, `Argus` PowerShell module, end-to-end change flow.
- **Phases and runbooks**, **hardware and licensing**, **open questions** (Q1-Q12).
- Platform skeletons: Mills app spec and alerts, bucket set, gMSA inventory, environment pins, app schema rejecting inline secrets, console API `Program.cs`, `Argus` module, IPsec identity rules, `sql-01` OpenTofu module, SF-node DSC.

### Changed
- **Platform base: Linux/Cozystack → Windows Server** (ADR-0002, owner decision). The 7 September Linux plan is preserved under `docs/adr/superseded/`.
- **Object storage: MinIO → SeaweedFS** (ADR-0007). MinIO community edition archived Feb 2026; commercial use without an AIStor licence is a legal exposure.
- **Cache: Redis/Valkey → Garnet** (ADR-0009). Valkey has no Windows build; Garnet is Microsoft-maintained and RESP-compatible.
- **Secrets: Vault → OpenBao** (ADR-0013). MPL-2.0, Linux Foundation, API-compatible.
- **Identity: Keycloak → Active Directory + AD FS** (ADR-0012). Keycloak would duplicate AD on Windows.
- **Scheduler: Kubernetes → Service Fabric guest executables** (ADR-0005); consequently **no container registry** (ADR-0006) and **no service mesh** (ADR-0015, IPsec instead).

### Fixed
- Commit `66a85df` was missing ten `platform/` files because the shell did not expand brace paths; added in `febbcb8` with identical content.

### Open
- ADR-0031 (return `umairv3_db` to FULL recovery) awaits the owner's ruling: see `docs/08-OPEN-QUESTIONS.md` Q7.

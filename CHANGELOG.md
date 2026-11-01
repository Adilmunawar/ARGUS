# Changelog

All notable changes to the Argus plan and platform. Dated, with the reason, because a platform whose history nobody can explain is a platform nobody can safely change.

## [Unreleased]

### Changed
- **Argus is now organisation-neutral.** It began as one company's design record, so the tree named that company, its domains, its production host, its private repositories, its staff, its databases and their sizes, and its sites. All of that is gone. The sample applications are Orders, Billing and Maps; domains are `example.com`; repositories are `example-org/*`; people in the sample dataset are fictional; regions are generic; the default timezone is UTC; the PowerShell module is credited to the author. The superseded plan written for that company is deleted rather than reworded. The repository never held customer records, dumps or datasets, in the tree or in its history.
- The renamed specs were brought up on the running stack: the bucket, identities and alert rules all resolve under the new names.

- **Licence.** The MIT licence is withdrawn for every version from this date on. The repository is now all rights reserved: it may be read on GitHub, and any other use, copy, deployment or derivative requires the author's prior written permission, asked for and granted case by case. `LICENSE`, the README, both `package.json` manifests (`UNLICENSED`), `CITATION.cff`, `CONTRIBUTING.md` and the publish script say so. Copies obtained under the MIT licence before 1 November 2026 keep that licence; this cannot be undone for them, only for what is published from now.
- Contributions are assigned to the author on submission, stated in `LICENSE` and `CONTRIBUTING.md`.

### Added
- **Private name guard**, `.github/scripts/check-identifying.js`, wired into the validate workflow. It fails the build if a blocked name appears in any tracked file. It holds salted SHA-256 hashes rather than the names, so the blocklist does not publish what it blocks.
- **Ownership enforcement.** `.github/CODEOWNERS` names the author as owner of every path. `check-ownership.py` runs in the `validate` workflow and fails the build if `LICENSE` differs from its pinned SHA-256, if the ownership text leaves the README, contributing guide or citation, if either manifest stops saying `UNLICENSED`, or if any commit since 1 November 2026 is authored by anyone else or carries a co-author trailer. The `ownership` workflow comments on, closes and locks any pull request opened from another account. Dependabot is exempt, since its pull requests are the repository's own dependency updates and are merged only by the author. The `main` branch is protected against force pushes and deletion.
- **Use and permission policy**, `USE-POLICY.md`: what is free (reading, linking, short quotes, citation, issues), the five permission tiers from study to derivative with their usual answer and conditions, what is never granted, and the five-line request to send.
- **Name and mark**, `TRADEMARK.md`: the Argus name and console mark reserved for cloud and infrastructure software, with what may and may not be done with them.
- **Enforcement kit**, `ENFORCEMENT.md`: evidence capture, which route fits which copy, the takedown forms of the major platforms, a filled copyright notice template and a direct notice template, when a lawsuit is worth it and what to do in advance (Zenodo archive, signed commits, registration), a monthly monitoring routine and an action log. All three are guarded by the ownership check.
- **Sign-in in the console.** The console API has always answered only to a signed-in operator, and the prototype had no way to become one, so served by the API it switched to live mode and then met a 401 on every read. The store now reads the auth state from `/api/capabilities`, refuses live reads and streams locally while signed out, and turns a 401 from any read into a signed-out state. The shell opens a locked sign-in dialog when that happens, posts to `/api/auth/login` with the CSRF header the API demands, re-probes on success, paints the operator pill and the audit actor from the principal the API returns, and offers sign-out from the data source dialog. "Browse sample data instead" stays available for a console opened without an operator.
- **Live suite over http**, `tests/live.js`, `npm run test:live`, wired into the validate workflow. It starts the console API with a temporary operator and a weakened scrypt, loads the prototype from it in headless Chromium, and proves the sign-in dialog, a wrong password, the right one, the operator pill, all fifteen screens over http, the four live-only screens reading the API rather than showing the sample notice, a reload keeping the session through the cookie, a 401 bringing the dialog back, sign-out clearing the cookie, the sample fallback, the audit trail on the server and that the password never reaches the server log. 45 checks. Every earlier suite ran from `file://` and never touched the API.
- **Console operator in the bootstrap.** `bootstrap.ps1` generates `CONSOLE_OPERATOR_PASSWORD`, hashes it with the console's own `hash-password.js`, writes `secrets/operators.json` and `secrets/console_operator_password`, and names the operator at the end. The compose console service now sets `ARGUS_AUTH=session`, mounts the operator file, uses plain cookies on loopback, and joins the socket proxy network so the container panels read.

- **Every screen reads a real source now, or says which one it lacks.** The nine screens that only rendered the bundled fixture (Overview, Applications, Deployments, Compute, Identity, ML, Operations, Audit, Advisor) have a live mode. Served by the API and signed in, each reads what exists in this stack and marks what does not with a "Not in this stack" callout naming the missing system, instead of showing a figure nobody measured. Sample mode, the file:// path the property suite asserts, is byte-for-byte what it was.
  - *Overview*: tiles from heartbeats, Alertmanager, the GitOps declarations, containers, the host and the API itself; the hero names a critical alert or the worst monitor down; Needs you lists active alerts, monitors down, the sandbox seal and declaration problems; Recent activity is the API's own audit trail; Service health is the heartbeat bars. Sites, traffic and the reconciler are not in this stack.
  - *Applications*: the GitOps `app.yaml` specs (owner, tier, services, instances, endpoints, ingress, probe, egress, secret reference paths without values, alert rules) with the version each environment declares, the directories that have no spec, and the containers running here. Instances, metrics, history and restart are not in this stack.
  - *Deployments*: the reconciler does not run here, so the screen says so and shows what the repository declares: every environment's versions, and whether each digest is pinned or still a placeholder.
  - *Compute*: this host from the API and Prometheus, and the containers as instances with inspect and stats per container. Hyper-V, Storage Spaces Direct, Service Fabric nodes and the GPU node are not in this stack; a fixture host name resolves to "no such host" rather than fixture figures.
  - *Identity*: the real principals, in four panels: console operators (the signed-in one marked), PostgreSQL roles, object store identities, and the service accounts `identity/gmsa.yaml` declares; the OpenBao seal with the sandbox warning. Just-in-time grants and lease counts are not in this stack.
  - *ML*: the buckets reserved for imagery and models, and the accounts declared to use them. Pipelines, models, endpoints and the GPU node are not in this stack.
  - *Operations*: the runbooks under `docs/runbooks` as a table and as rendered documents (front matter, sections, numbered steps, fenced blocks, all built as nodes, never HTML), Prometheus rule groups and Alertmanager silences as the alarms, backup buckets. Change freezes, drills and cost are not in this stack; nothing can be run because the JEA endpoint does not exist.
  - *Audit*: the API's own audit events, newest first, with the compound filter, CSV export, row detail and a hash chain computed in the page, stated plainly as proof of transit integrity rather than of the API's memory.
  - *Advisor*: the rules run over thirteen parallel reads (seal, writes, operators, object lock and filer bypass, declared locks, Postgres health and replication, containers, Prometheus targets, active alerts, host memory and disks, unpinned digests, apps without alerts, directories without specs, unconfigured readers). Every finding carries its evidence and read time; an unconfigured reader yields an info line and never a false positive; accepting a risk says it stays in the browser. The navigation badge follows the live findings.
- **Seven read endpoints behind them** (`server/src/sources.js`): `/api/gitops/apps`, `/api/gitops/environments`, `/api/gitops/service-accounts`, `/api/identity/principals`, `/api/runbooks`, `/api/runbooks/body`, `/api/audit/recent`. The audit writer keeps a bounded in-memory ring of its own events. The compose console mounts `docs/runbooks` and the SeaweedFS identities read-only. Secret references are paths only; operator records never leave the server; a runbook path cannot leave its directory. The command palette indexes declared applications and runbooks. 17 server checks cover the module.
- **The live suite loads one module per screen** from `tests/live-screens/`, each with its own checks against the API the harness started (173 checks across the nine), on top of the 45 shell checks.
- The shell gained `A.livePanel`, `A.whenProbed`, `A.sampleNotice` and `A.notInStack`, the four helpers every wired screen is built from.
- **A designer's pass over the console**, from a 25-point review of every screen at six widths. Applied: the page title no longer wears a full-width focus ring after a route change; the Overview feeds (Needs you, Recent activity) put the sentence and its link or time on one line instead of three stacked blocks; the critical alert is stated once, not four times, and the subtitle gives the time of the figures; the phone top bar keeps the search label and the avatar on one row and hides the keyboard hints that mean nothing on touch; the collapsed rail keeps the Security and Advisor counts as a dot instead of losing them; every top-bar control shares one height; the Sites card loses its card-in-card border and the hint that repeated the data-source pill; stat tiles fall into even rows of three and two on tablets and phones; the Advisor actions column reads Open and Accept risk with the identifiers moved to the accessible name; nav hover no longer looks like selection; sort arrows appear only on hover or focus; clickable rows carry a chevron; long identifiers wrap.
- **The rest of the review, each one measured against the budgets.** A single type scale of seven tokens replaces fourteen ad-hoc sizes, and the page title is now the largest type at every height instead of shrinking below the stat tiles on short screens. On a phone the top bar is one pinned row with search as a named icon button; below 340px wide or 480px tall it scrolls away, so at 400% zoom it never covers the content. Flashes float at the top right and no longer push the page down, with the same fallback to the page flow on short screens. Repeated Advisor findings share one row with each resource as a link and an Accept all; Show each finding brings back one row per finding, the counts always count findings, and a filter runs before grouping.

### Fixed
- **The console froze for a signed-out browser opening the Advisor, and for an operator whose session ended there.** Each finished evaluation refreshed the navigation badge, which started the next evaluation; signed out, every read is refused locally with no network wait, so the cycle ran on promise callbacks alone and the page never painted the sign-in dialog. A finished evaluation now only paints the badge, nothing evaluates while signed out, and the screen says no rule has been evaluated rather than reporting nothing wrong. The live suite now opens all fifteen screens signed out in a fresh browser and ends a session on the Advisor, which is why it passed before: it always signed in on Overview first. Found by signing in to the rebuilt stack from a clean browser.
- **The compose console service could not boot as written.** The image defaults to session auth with `/config/operators.json`, and nothing in compose or the bootstrap produced that file, so the container refused to start. Measured on Docker Desktop 29.8 on Windows 11, first run of the stack on this machine.
- **Prometheus could not start:** `../gitops` was bind-mounted inside the read-only `/etc/prometheus` mount, and Docker cannot create the mount point. The gitops tree is now mounted at `/gitops` and the rule paths follow.
- **node-exporter could not start on Docker Desktop:** the root bind mount asked for `rslave` propagation, which the Desktop VM does not offer. Dropped; the mount is read-only either way.
- **storage-init exited 1:** `seaweed-config` wrote `s3.json` as root with mode 0600 and the console image runs as the node user, so the identities file was unreadable and the bucket report could not name scoped buckets. The config writer now removes the old files, writes them, chmods to 0400 and chowns to the node user, with `CAP_CHOWN` granted to that one-shot and nothing else.
- **Alloy discovered no containers**, so Loki held no labels and the Logs screen could open nothing: the socket proxy refused `/networks`, which Docker service discovery needs. Network listing is now allowed on the proxy; it is still read-only and still POST-less.
- **The System screen's AWS panels lied.** The SeaweedFS console key was passed through `AWS_ACCESS_KEY_ID`, so the real AWS clients signed with it and reported "credentials expired" and "not permitted". The storage module now takes `ARGUS_S3_ACCESS_KEY_ID` and `ARGUS_S3_SECRET_ACCESS_KEY`, the AWS clients see no credentials and say so, an unrecognised key is classified as invalid rather than expired, and instance metadata probing is off in the container so a missing credential fails in milliseconds, not after the IMDS timeout.
- **Every metric tile on the System screen said "No sample in this window" forever.** The server answers `/api/metrics/series` with its own shape (a list of series with points) and the prototype only understood a raw Prometheus matrix. `A.seriesValues` now reads both, and the screen sends the window in milliseconds as the server expects rather than as the string "6h" it silently ignored.
- **Windows PowerShell prepends a UTF-8 byte order mark to anything it pipes to a native process**, so an operator record hashed through a pipeline never verified. `hash-password.js` strips the mark and a trailing carriage return.
- Static files from the console API carry `cache-control: no-cache` and `last-modified`, so a rebuilt console is never served from a stale browser cache.
- The prototype README and the repository README said fourteen screens; there are fifteen.

## [0.12.0] - 2026-10-11

What the AWS console does that this one did not. Each of these is the Argus equivalent of a service an operator reaches for there, built on the dataset and the policies the console already holds, with the same no-comment code and the same tests.

### Added
- **Advisor**, a fourteenth screen in the Govern group, the equivalent of Trusted Advisor. Thirty-odd rules evaluated against the dataset as it is right now, in five categories: security (WDAC in audit mode, TOTP at Tier 1, secrets past policy, expired waivers, unlocked buckets, stale gMSA passwords, unacknowledged critical alerts), fault tolerance (no replica, no replication, Storage Spaces repairing, backups past cadence, no restore drill in 30 days), cost (idle GPU, capacity filling, cache near its limit), performance (p95, error rate, consumer lag, dead letters) and operations (patch age, stale pipelines, runbooks never run, drift, alarms with no data). Each finding links to its resource; a risk can be accepted for a fixed time with a reason, which is audited and returns when the time passes. Findings clear the moment the data changes, which the regression proves by patching a host. The rail carries a badge of critical and high findings, and the Overview a tile.
- **Tags** on applications, virtual machines, hosts and buckets, with a tag editor that normalises keys, caps at twenty and audits the change. Applications filter by tag from the address, tables show tags as chips, and cost is allocated by the cost-centre tag the way a cost allocation tag does on a bill.
- **Instance-style Actions on a virtual machine**: connect, stop and start, restart, resize through a pull request, take a checkpoint, enable replication at Site B, edit tags. Each is confirmed where it should be, changes the machine, and is audited. Hosts gain Patch now outside the Tuesday window.
- **Alarms**, a tab on Operations, the equivalent of CloudWatch alarms over Prometheus rules: a metric, a comparison, a threshold and a duration per application, evaluated against the current values with the result previewed in the editor before saving. An alarm in ALARM reaches the inbox and pages its owner.
- **Metrics on one clock.** The application overview carries requests, p95 and error rate over one hour, six hours or a day, with one range control for all three.
- **Console home.** Every Overview tile is a link to its screen. Recently visited sits beside the reconciler, and a Service health card shows thirty days of daily checks per application, worst first.
- **Cost by tag and a six-month trend** on Capacity and cost.
- Breadcrumbs name what they point at: Compute / Virtual machines / sql-01 rather than compute / vm / sql-01, and the document title follows.

### Note
- 408 property checks, 125 sandbox checks and every stress budget pass.

## [0.11.0] - 2026-10-11

Policy, evidence and the terminal. The console now enforces the rules the design documents only described, and shows its working in a form an auditor can check.

### Added
- **Change freeze.** Declared from Operations, Maintenance, with a reason and a duration, lifted by hand with a typed confirmation or on its own at the end. While it is in force the environment pill says Freeze on every screen, the inbox leads with it, and approving anything into production turns into a signed-off exception: a written justification, a second factor, and a `freeze.override` audit row beside the approval.
- **Approval policy by tier.** A Tier 0 application needs two approvals before the reconciler moves; the same person cannot give both; the card and the detail say how many are in. Tier 1 and 2 stay at one.
- **The declaration as a unified diff.** The Plan tab renders the GitOps declaration the reconciler reads, before and after, line by line, with the changed lines marked and read out to a screen reader.
- **Silences.** An open alert can be silenced for one, four or twenty-four hours with a required reason. It leaves the open count and the inbox for that time without being acknowledged or resolved, shows as silenced with the reason on hover, lifts on its own, can be lifted early, and both are audited with Undo on the flash.
- **The recorded terminal answers.** Typing in the session drawer runs a small vocabulary per protocol: a shell on Linux, the constrained JEA cmdlets on Windows, a refusal with the attempt transcribed for anything else. Disconnecting seals the transcript into a new recording under Security, Sessions, playable from the flash's button, with an audit row naming it.
- **Environment drift.** Applications lists every application whose staging build is ahead of production, with a Promote button that opens the pull request preset to that version and environment.
- **Error budgets.** Each application has an objective by tier and an Error budget tab: budget, spent, remaining and burn rate over the window, with the deploy dialog saying when the budget is spent and the policy is fixes only.
- **A tamper-evident audit trail.** Every audit row is sealed with a SHA-256 over its contents and the seal of the row before it. Verify the chain seals unsealed rows, confirms sealed ones, and names the first row whose seal no longer matches, which is what one edited row does to every seal after it. The seal is a column and travels with the export.

### Fixed
- The stress suite's document-growth budget sampled every ten navigations while cycling four routes, so it alternated between two screens of different size and fitted a line through the zigzag; the drift card made the two differ enough to trip it. It now samples on the same route every cycle, which is the same trap docs/12 records for the FLASH and SOAK suites.

### Note
- 387 property checks, 125 sandbox checks and every stress budget pass.

## [0.10.0] - 2026-10-11

The operator's day, end to end: find out what needs you, work an incident from the alert that raised it, keep the view you built, and leave the desk without leaving the session open.

### Added
- **An inbox behind the bell.** Everything that needs a person in one list: open incidents, critical and high alerts nobody has acknowledged, deployments and grants waiting for an approver, expired waivers, secrets past their rotation policy and failed pipelines, each with a button to the item. The bell's label and dot count the same list, and the Overview's Needs you card is now the first eight rows of it, so the two can never disagree.
- **Incidents.** A new tab on Security. An alert's row offers Open incident, which takes a title, a severity, a commander and a first note, links the alert and acknowledges it. The incident's timeline holds what people write and, folded in automatically, every audit row that names the incident, its host or its alerts, so an action taken elsewhere in the console cannot go missing from the record. Mark mitigated, resolve with a typed confirmation that resolves the linked alerts with it, or reopen; each writes the timeline and the audit. Incidents appear in the palette, the inbox and Needs you.
- **Rows take the keyboard.** On any clickable or selectable table, `j`/`k` or the arrows move between rows, Home and End jump, Enter opens, and `x` or Space toggles the selection. The row focus ring already existed; it now has somewhere to go.
- **A column picker on every list screen that has one**, with the choice remembered per table in this browser. The export still carries every column, and a table refuses to hide its last one.
- **Saved views.** Save the filter and tab you built under a name; it lives in a Views menu on that screen and in the palette as a Saved view. Views are per browser and can be forgotten from the same menu.
- **Lock when idle.** A preference, on by default at fifteen minutes, that blurs the console behind a dialog that Escape, the scrim and a route change cannot dismiss; only the security key resumes it. Locking and resuming are both audited. The session itself continues underneath: an elevation keeps counting down and a rollout keeps rolling. Lock the console is also a palette action.

### Fixed
- The palette's search was case-sensitive. Typing a capital letter found nothing, because the query was matched raw against a lowercased index.

### Note
- 377 property checks, 125 sandbox checks and every stress budget pass.

## [0.9.0] - 2026-10-11

Features an operator reaches for once the basics work. Every one of them is built on the state-carrying actions of 0.8.0, tested in the ACT suite, and leaves nothing running when the screen is left.

### Added
- **A data-source indicator in the header.** Live, Stale, API down or Sample data, with the last good read and the reason in its tooltip, driven by the store rather than guessed from the screen. It opens a detail with the probe time, the last good and failed reads and the last error, with a way to the System screen or a full re-read. Below 900 pixels it yields to the search box; the System screen carries the same facts.
- **Recent items in the palette.** With nothing typed, `Ctrl`+`K` offers the last eight resources and screens you were on, then the screens and actions; typing searches everything as before. Kept per browser, validated on load like the preferences.
- **Filters in the address.** The property filter on Applications, Alerts and Audit writes its tokens into the URL, so a filtered view can be reloaded, sent as a link, or opened from a runbook. Acknowledging from a filtered list keeps the filter.
- **Bulk selection.** Tables can select rows, with a header checkbox for everything shown, keyboard and screen-reader labels per row, and the selection surviving a sort. The alerts table uses it: select, then acknowledge every open alert among the selected ones with one note. Alerts that are already acknowledged or resolved are counted and skipped, not refused.
- **Undo on the flash** for acknowledging alerts, denying a grant and promoting a model: one press puts the data back and withdraws the audit rows the action wrote. The undo button disappears with the flash, so it cannot be pressed twice.
- **CSV export on every major table**: applications, alerts, vulnerabilities, sessions, hosts, virtual machines, people, secret paths, backup stores and drills, as well as the audit. Each exports exactly the rows it shows, filtered and sorted as they are, without its action column, with a copy button.
- **A rolling upgrade you can watch.** An in-flight deployment advances one upgrade domain every few seconds on the deployment screen and on the queue, the bar and its sentence following, and finishes into Recent with its duration, the application's version updated and a `reconcile.apply` audit row from the reconciler. The clock stops when the screen is left and is proved to leave no interval behind.
- **Elevation expiry warning.** Five minutes before a grant lapses the bar turns red and warns once; an Extend button adds an hour with a second factor, capped at four hours from the grant, and records the extension.

### Changed
- Audit rows can now carry a system actor, which is how the reconciler's apply is recorded with its own address.

### Note
- 369 property checks, 125 sandbox checks and every stress budget pass.

## [0.8.0] - 2026-10-11

The console looked finished and was not usable for real work: every action ended in a flash message and changed nothing, so an operator who acknowledged an alert saw it still open, with the same badge, on the next screen. Two audits ran alongside the console work, one over the API server and one over the compose stack and its scripts, each verified by executing the code rather than reading it. Everything they found is fixed below.

### Fixed
- **Actions now carry state.** Acknowledging an alert marks it acknowledged and takes it out of the open count; approving a deployment moves it into flight with its approver recorded and a rolling-upgrade progress bar; rejecting one closes it with the reason shown on the card; approving, denying or revoking an access grant changes the grant and the person's elevation; rotating a secret resets its age and revoking its leases zeroes them; promoting a model demotes the one it replaces; setting a canary moves the bar; opening a pull request from an application creates the deployment and lands on it; running a runbook records the run. Every one of these writes an audit row, so Recent activity and the Audit screen show what was just done, by whom.
- **The navigation badges were typed into the markup.** The Deployments badge read 1 and the Security badge and bell read 4 whatever the data said. They are derived from the dataset now and repaint after every action; a count of zero hides the badge and the bell's dot and says "No open alerts".
- **Choosing a tab did not change the URL**, so a reload, the browser's back button and a shared link all forgot where you were. Deep links had worked since 0.6.1; the reverse did not. Every tabbed screen now writes the tab into the hash, with the breadcrumb and the document title following, and without a re-render.
- **The command palette opened on top of itself.** A second `Ctrl`+`K` stacked a second palette; it focuses the open one now. The palette also finds deployments, open alerts, secret paths and people, not only screens and infrastructure.
- **A collapsed rail had nameless icons.** Between 900 and 1200 pixels the stylesheet collapsed the rail but left the Collapse button, which then toggled nothing, and gave the icons no tooltip. The button hides where the viewport has already collapsed the rail, and every icon carries its label as a tooltip whenever the labels are hidden.
- **The session drawer always said "reason: restore drill"** whatever reason the operator had typed into the elevation dialog, and a PowerShell connection was rendered as a Windows desktop prompt. The banner carries the real reason, the expiry matches the grant, and JEA and VNC sessions describe themselves.
- The destructive confirm kept "Type X to enable this" as its tooltip after the name matched, and ignored Enter in the field it had asked you to type into.
- The waiver dialog named no vulnerability, so a waiver could not be attached to anything; it offers the unwaived findings, each row has its own Waive action, and the new waiver appears in the table.
- The CSV export is copied to the clipboard in one click, with the old select-all path kept for where the clipboard is refused.
- Dead stylesheet rules for a header the console no longer renders, a duplicated custom property, and two script tags indented differently from the rest.
- **Console API: a static file that stats but cannot be opened crashed the whole process**, because the read stream's error had no listener. Reproduced with a socket under the web root; the server exited. Static files are served through `stream.pipeline`, which also closes the descriptor when the browser abandons a download.
- **Console API: an upstream that closed mid-body hung the request forever.** All four hand-rolled readers resolved only on `end` and rejected only on request error; a Loki, Prometheus, SeaweedFS, NATS or OpenBao restart during a response left the promise pending, poisoned the cache key behind it, and froze that service's heartbeat at its last value until the process restarted. A premature close now rejects.
- **Console API: renewing a session logged the operator out.** Rotation deleted the old session id at once, so the parallel requests a dashboard fires with the old cookie answered 401 and cleared the cookie. The superseded id stays valid for a short grace that never exceeds the renewal window, and cannot be rotated again.
- Console API: a stream whose browser left before the close listener was attached was never torn down and counted against the stream limit for ever; `SIGTERM` with a dashboard open always exited 1 because open streams never let `server.close` finish; `HEAD` on any API route answered 404; `405` answers carried no `Allow`; the Loki tail dropped any path prefix on `ARGUS_LOKI_URL` that every other Loki call kept.
- **`bootstrap.ps1` could not complete on a fresh clone.** The Alertmanager template needs `SMTP_FROM` and `PLATFORM_EMAIL` and `.env.example` carried neither, so the script refused to write `.env` or any secret. CI never saw it because the workflow copies `.env.example` straight to `.env`.
- **SeaweedFS was given an Admin identity with an empty secret.** `seaweed-config` rendered `argus-parity-admin` with `"actions": ["Admin"]` but was never passed its secret, so the heredoc expanded it to nothing. The variable is passed now and is required.
- OpenBao's `audit "file"` stanza is not a server-configuration construct; the server ignored it and the audit volume stayed empty while the configuration claimed a trail. The stanza is gone and `provision.sh` enables the file audit device through the API, idempotently.
- The parity runner could never write its report: it runs as uid 1000 into a volume Docker creates root-owned. `parity-pg` now owns the volume to that uid before its loop, and the runner waits for it. `grafana` and `postgres-exporter` raced `pg-init` for the roles it creates and crash-looped on first start; `storage-init` never found the identities file it was told to check. `publish.sh --help` printed its own source.
- Seven shell comments inside a compose block scalar bypassed the no-comment check, which keeps block-scalar bodies verbatim on purpose.

### Added
- The **ACT** suite: twelve regressions, one for each console behaviour above.
- The theme follows the system by default. An explicit light or dark choice still sticks.
- A favicon, inline, so a served console does not log a 404 on every open.

### Note
- 359 property checks, 125 sandbox checks and 217 server tests pass.

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
- **The platform is named Argus** (ADR-0034, owner decision), replacing a working name taken from a company's initials. Argus Panoptes is the watchman who never slept, which is what a platform built on *evidence, not assurance* is trying to be.
- **The identifier prefix is the full word `argus`, never `arg`**: a deliberate three extra characters. ADR-0023 exists to say this platform does not use Flux or Argo; an `arg-` prefix on buckets and clusters would read as Argo to everyone who joins.
- Relabelled across 87 files: directory forest, buckets, databases, schemas, NATS subjects, clusters, groups, certificate templates, the GitOps `apiVersion` and project names all take the `argus` prefix.

### Added
- **ADR-0034**: the naming decision, the `argus`-not-`arg` prefix rule and its reason, and the full list of what was relabelled.
- **Q13** in `08-OPEN-QUESTIONS.md`: trademark and domain clearance for the name. An older network-monitoring tool and a commodities-pricing firm both use *Argus*; neither is in this market, but neither has been checked. This must close before the name appears anywhere outside this repository.

### Fixed
- **The `validate` workflow could never have gone green.** Both jobs failed for reasons unrelated to any content change. The console suite hardcoded the absolute paths of the sandbox it was first written in (`/home/claude/.npm-global/...`, `/opt/pw-browsers/...`), so `require()` threw before a single assertion ran, on a GitHub runner and on a developer machine alike. It now resolves `playwright` and `axe-core` normally, lets Playwright find the browser it installed, and writes screenshots under the system temp directory. A `package.json` pins both dependencies so `npm ci` works. Verified: 65/65, exit code 0.
- The credential scan matched two lines of prose that describe the credential rule itself. The pattern now excludes a backtick immediately after `password=`, so an inline code span is no longer mistaken for a value. The detection is not weakened.
- **The test count was stale in three places.** The README, `docs/11` and the prototype README still claimed 51/51 from v0.3.0, while the badge and the recorded run said 65/65. `docs/11` now lists the DENS suite and the six responsive widths it actually tests.
- **ADR-0032 was only half-applied.** It added `guac-01` as a third Linux exception in September, but master plan principle 6 still read "two exceptions" and the application-infrastructure map had no row for the host at all. Both corrected. The README's two summary tables, which disagreed with each other about the exception count, are merged into one.

### Changed, editorially
- **Em dashes replaced with ordinary punctuation throughout**, chosen per sentence rather than substituted blindly: a colon before an explanation or a list, commas around an aside, parentheses where an aside had commas of its own, a semicolon or a full stop between independent clauses. En dashes in numeric ranges became hyphens and the ellipsis character became three dots. Table cells meaning "none" now hold a hyphen.
- Removed the traces of the drafting process: a note in `PUBLISHING.md` about a token "pasted into our conversation", and the first-person consultant voice in `docs/11` and the superseded Linux plan. The superseded plan keeps its substance and its date; only the voice changed.

### Not changed, deliberately
- The console mark is still a leaf; it needs a decision before console stage C1 ships.

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
- **Minimum font size raised from 10px to 11px**: a deliberate, recorded deviation from the Orders design system, because this console is read under pressure.

### Fixed
- **B1/B2 (critical)**: the console was 755px wide on a 390px phone and unusable. Rail collapses at 1200px, drawer at 900px, top bar wraps at 620px; content column changed to `minmax(0,1fr)` because grid items default to `min-width:auto`.
- **B3-B13**, ten click handlers on non-focusable spans; no focus ring outside `.btn`; a Google Fonts fetch that would have failed behind the egress allow-list (ADR-0027); `.delta.up` at 3.73:1; `opacity`-based disabled state; wrapped status pills; 15px touch targets; missing table captions and scopes; no skip link, live region or title changes.
- **T1-T5**: five defects in the test harness itself, which had produced fourteen false failures. Recorded in the bug register beside the real ones.

## [0.2.0] - 2026-09-08

### Added
- `docs/10-CONSOLE-DESIGN.md`: the AWS Console studied as nine repeating patterns, each mapped to a Argus screen; nine console sections specified screen by screen; interaction rules; the Orders design system inherited with three console-only components; a six-stage build order where each stage retires a named existing tool.
- **ADR-0032**: browser RDP/SSH/VM-console via Apache Guacamole. Credential-less (OpenBao issues a one-time, session-scoped credential the operator never sees), time-boxed, fully recorded to the object-locked `argus-sessions` bucket, clipboard and file transfer gated by role.
- **ADR-0033**: the console is the primary surface; Windows Admin Center becomes bootstrap and break-glass only, retired at console stage C6. Grafana explicitly stays.
- `platform/console/prototype/index.html`: a static, clickable prototype of six screens using the Orders tokens, so the design can be argued with before any C# is written.
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
- `apps/orders/app.yaml` validates against `schemas/app.schema.json`.
- The schema's inline-secret rule was negative-tested and does reject `password=` values in `env`.

### Note
- Nothing else in this repository has been executed. The plan was written without access to Windows Server or hardware.

## [0.1.0] - 2026-09-08

### Added
- Repository scaffold, documentation order, `platform/` layout, the rule that every change is an ADR + changelog line + commit.
- **ADR-0001 ... ADR-0031**: the complete decision record for the Windows-first platform (`docs/01-DECISIONS.md`, one file each under `docs/adr/`).
- **Master plan v0.1.0**: targets as numbers, fourteen capabilities mapped to Windows-native implementations, two-site topology, eight principles, seven phases with exit gates, external dependencies, staffing, three-year cost, hybrid checkpoint.
- **Application-infrastructure map**: every host, VM, Service Fabric application and business application (Orders, billing app, Maps, ML pipelines, the assistant, the console) traced to identity, port, data store, bucket, secret path, backup, SLO and alert.
- **Security architecture**: threat model, hardware root of trust, tiered AD, WDAC/Authenticode, IPsec east-west, data protection, detection and paging rules, evidence pack, delivery-pipeline security.
- **Network and sites**: eleven zones, addressing, edge, RDMA storage fabric, egress proxy, Site B bandwidth, power sequencing.
- **Control plane**: GitOps repo layout, first-party reconciler design, console screens/roles/API, `Argus` PowerShell module, end-to-end change flow.
- **Phases and runbooks**, **hardware and licensing**, **open questions** (Q1-Q12).
- Platform skeletons: Orders app spec and alerts, bucket set, gMSA inventory, environment pins, app schema rejecting inline secrets, console API `Program.cs`, `Argus` module, IPsec identity rules, `sql-01` OpenTofu module, SF-node DSC.

### Changed
- **Platform base: Linux/Cozystack → Windows Server** (ADR-0002, owner decision).
- **Object storage: MinIO → SeaweedFS** (ADR-0007). MinIO community edition archived Feb 2026; commercial use without an AIStor licence is a legal exposure.
- **Cache: Redis/Valkey → Garnet** (ADR-0009). Valkey has no Windows build; Garnet is Microsoft-maintained and RESP-compatible.
- **Secrets: Vault → OpenBao** (ADR-0013). MPL-2.0, Linux Foundation, API-compatible.
- **Identity: Keycloak → Active Directory + AD FS** (ADR-0012). Keycloak would duplicate AD on Windows.
- **Scheduler: Kubernetes → Service Fabric guest executables** (ADR-0005); consequently **no container registry** (ADR-0006) and **no service mesh** (ADR-0015, IPsec instead).

### Fixed
- Commit `66a85df` was missing ten `platform/` files because the shell did not expand brace paths; added in `febbcb8` with identical content.

### Open
- ADR-0031 (return `orders_db` to FULL recovery) awaits the owner's ruling: see `docs/08-OPEN-QUESTIONS.md` Q7.

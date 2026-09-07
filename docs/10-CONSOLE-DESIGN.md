# Argus Console: design

**The web interface from which everything is controlled: deployments, servers, RDP sessions, databases, storage, secrets, identity, security, ML, cost.** One browser tab replaces the AWS Console, Remote Desktop Connection, SQL Server Management Studio for routine work, PowerShell for routine work, and the pile of RDP shortcuts on everyone's laptop.

This document is the deep design. It studies what the AWS Console actually gives you, screen by screen, maps each to a Argus equivalent, and then specifies the things AWS does *not* do that we will.

## 0. What was missing before this document

`05-CONTROL-PLANE.md` specified the console's screens but assumed operators would reach servers through Windows Admin Center and an RDP client over the VPN. That is a gap: it means a second tool, a VPN client on every laptop, credentials typed into `mstsc`, and no recording of what anyone did. **Browser-based RDP/SSH/VM-console with session recording is now a first-class console feature** (ADR-0032), and Windows Admin Center is demoted to a fallback that is retired at Phase 6 parity (ADR-0033).

---

## 1. Study: what the AWS Console actually is

Stripped of the 240 service pages, the AWS Console is nine repeating ideas. Every Argus screen is one of these, done better or deliberately differently.

| # | AWS pattern | Where you see it | What it gets right | What it gets wrong |
|---|---|---|---|---|
| 1 | **Global shell**: service search, region selector, account menu, notifications, CloudShell drawer | every page | search-first navigation; the shell never changes | region selector is a constant source of "why is my resource missing"; 240 services make search mandatory rather than helpful |
| 2 | **Console Home**: pinnable widgets, recently visited, favourites, health | landing page | personalisation; recent items are how people actually navigate | widgets are shallow; you still leave to do anything |
| 3 | **List → detail → action**: a filterable table of resources, click one, tabs on the detail, an Actions dropdown | EC2 instances, S3 buckets, RDS | the single most learnable pattern in the console | the Actions menu hides destructive items next to harmless ones |
| 4 | **Create wizard**: multi-step form ending in a review page | launch instance, create DB | review-before-create is right | the wizard's output is invisible; you cannot see the API call it will make |
| 5 | **Change preview**, CloudFormation change sets: "here is what will happen before it happens" | CloudFormation, Terraform-adjacent | the best idea in the console | opt-in and buried; most console actions have no preview at all |
| 6 | **Browser access to compute**: Session Manager shell, EC2 Instance Connect, Serial Console | EC2 | no bastion, no key files, IAM-controlled, logged to S3 | text only; there is no browser RDP for Windows |
| 7 | **Observability panes**: CloudWatch metrics, Logs Insights, X-Ray service map | everywhere, inconsistently | co-locating metrics with the resource | three query languages, three UIs, and a separate bill |
| 8 | **Audit and compliance**: CloudTrail Event History, Config timeline, Security Hub, Trusted Advisor | separate consoles | "who did what, when" is answerable | scattered across four services with four data models |
| 9 | **Cost**: Cost Explorer, Budgets, cost allocation tags | Billing console | tag-driven attribution | disconnected from the resource pages where decisions get made |

**The one structural thing AWS gets wrong that we will not copy:** the console mutates production directly. You click *Terminate* and the instance dies. There is no review, no approval, no diff, and the only record is CloudTrail after the fact. Argus's console **opens a pull request** for every write (ADR-0021). The console is a rich, opinionated editor for the GitOps repo, plus a live reader of the running system.

---

## 2. Information architecture

Nine sections, ordered by how often an operator touches them. No "services" list, because there are 22 things, not 240: everything is reachable in two clicks from the sidebar or one keystroke from the command palette.

```
Argus Console
│
├── Overview                     the morning screen
│
├── Applications                 Mills · Loan · AGIS · Console · Caddy · NATS · OpenBao · geo services
│   ├── <app> / Overview         health, version, SLO, dependencies
│   ├── <app> / Instances        which SF node, uptime, restarts
│   ├── <app> / Logs             live tail + Loki query
│   ├── <app> / Traces           OTel waterfall, slowest requests
│   ├── <app> / Config           env vars with secret references resolved to names only
│   └── <app> / Deploy history   every version, who approved, rollback
│
├── Deployments                  the PR queue: pending, in-flight, recent, failed
│
├── Compute                      hosts, VMs, Service Fabric nodes, GPU
│   ├── Hosts                    hv-01..05, S2D health, patch age, WDAC mode
│   ├── Virtual machines         list → detail → **Connect (RDP/SSH/console)**
│   ├── Service Fabric           cluster map, node types, upgrade domains
│   └── GPU                      gpu-01 utilisation, Ray cluster, who is using it
│
├── Data                         databases, storage, cache, queues
│   ├── Databases                AG state, backups, restore drills, **Query editor**
│   ├── Object storage           buckets, browser, lock status, replication lag
│   ├── Cache                    Garnet keyspace, memory, hit rate
│   └── Queues                   NATS streams, consumers, lag, dead letters
│
├── Identity & secrets
│   ├── People                   AD users, MFA status, tier, last sign-in
│   ├── Service accounts         gMSAs, what they may reach
│   ├── Access grants            time-boxed Tier elevations, request → approve → expire
│   └── Secrets                  OpenBao paths (names only), leases, rotation age, who read what
│
├── Security
│   ├── Posture                  Wazuh SCA/CIS score per host, trend
│   ├── Alerts                   Wazuh + Falco-equivalent + CrowdSec + Suricata, one inbox
│   ├── Vulnerabilities          Trivy + dotnet advisories, by app, with waivers
│   ├── Sessions                 **recorded RDP/SSH sessions, searchable, replayable**
│   └── Evidence                 the monthly pack
│
├── ML & geospatial
│   ├── Pipelines                Dagster asset graph, freshness, failures
│   ├── Models                   MLflow runs, v5.x lineage, promote to endpoint
│   ├── Endpoints                Ray Serve, latency, canary
│   └── Imagery                  Sentinel mirror coverage map, STAC search, tile preview
│
├── Operations
│   ├── Runbooks                 forms → JEA execution → transcript
│   ├── Backups & drills         calendar, last verified restore, RPO trend
│   ├── Maintenance              patch windows, planned changes, freeze periods
│   └── Capacity & cost          per-app CPU/RAM/disk/GPU, chargeback, forecast
│
└── Audit                        every action by anyone, forever, searchable, exportable
```

**Global shell** (present on every page): Argus mark → section breadcrumb → **command palette (`⌘K` / `Ctrl+K`)** → environment switch (production / staging) → alert bell → account menu with tier badge and elevation state.

The **environment switch** is the honest version of AWS's region selector: it is a two-state toggle, it is coloured (production is `cane`, staging is `brand`), and every destructive action re-states the environment in its confirm dialog.

---

## 3. Screen specifications

Every screen uses the Mills component language: `PageHeader`, `StatTile`, `SectionCard`, `TableShell`, `FilterField`, `EmptyState`, `Skeleton`, `Button`, with the same tokens (`ink`, `muted`, `pine`, `cane`, `brand`, `leaf`, `cream`, `paper`). No new component is invented unless a screen below names it.

### 3.1 Overview: the morning screen

Replaces: AWS Console Home + Personal Health Dashboard.

- **Hero band** (`cane`→`pine` gradient, Lora title): site status, "all systems normal" or the worst thing happening, in one sentence a mill officer would understand.
- **StatTile row**: applications healthy (n/n) · SLO this month · oldest backup · open alerts (by severity) · pending deployments · AWS exit progress (a percentage that reaches 100 at Phase 5).
- **Three SectionCards**: *Needs you* (PRs awaiting your approval, expiring access grants, unacknowledged alerts) · *Recent activity* (last 20 audit rows, sentence-formatted: "Zayan deployed mills 2026.09.08.1 to production") · *Site map* (a small two-column diagram of Site A / Site B with live link status and replication lag).
- **Sparklines** in chart tokens: request rate, p95, error rate, over 24 h.

### 3.2 Applications

**List**: TableShell; name · environment · version · health pill · instances · p95 · error rate · last deployed. Filter by owner, tier, health.

**Detail** tabs:

| Tab | Content |
|---|---|
| Overview | StatTiles (uptime, p95, RPS, error rate, instances); dependency graph rendered from `02-APPLICATION-INFRASTRUCTURE-MAP.md`: this app → its database, buckets, queues, secrets, external calls, each node clickable |
| Instances | per SF replica: node, PID, uptime, restarts, CPU, memory; actions *Restart* (confirm), *Drain node* |
| Logs | live tail with a pause; Loki query box with saved queries; severity filter; jump-to-trace on any log line carrying a trace id |
| Traces | OTel waterfall for slow requests; the gateway → API → SQL spans the Mills app already emits |
| Config | env vars from `app.yaml`; secret references shown as `kv/mills/jwt-signing-key → (value hidden)` with a *Who read this* link into the OpenBao audit |
| Deploy history | every version with commit SHA, PR link, who approved, duration, health outcome; one-click *Roll back to this version* → opens a PR |

**Advanced beyond AWS:** the dependency graph is generated from the same YAML the reconciler applies, so it cannot drift from reality. AWS has nothing equivalent outside X-Ray's inferred map.

### 3.3 Deployments: the PR queue

Replaces: CodePipeline + CloudFormation change sets, merged.

Three lanes: **Awaiting approval** · **In flight** · **Recent**. A card per deployment: app, version, environment, author, the CI evidence (tests passed, Trivy clean, SBOM, signature verified), and **the reconciler's plan**: the literal diff of desired vs actual, resource by resource, before anything is applied. Approve/Reject inline (Approver role, and never the same person who opened it). In-flight shows the Service Fabric upgrade domain progress bar and the live health check; a failing health policy shows the automatic rollback happening.

**Advanced beyond AWS:** a *blast-radius preview* beside the diff, "this change touches `MillsApi` (3 instances), which is depended on by `MillsWeb`, `MillsGateway` and 2 scheduled functions; 4 mill accounts are currently signed in". Derived from the dependency graph plus live sessions.

### 3.4 Compute, and the RDP problem, solved

**Hosts**: `hv-01..05`: cluster role, S2D health (capacity, repair jobs, unhealthy disks), CPU/RAM headroom, patch age, WDAC mode, uptime. Actions: *Drain*, *Patch window*, *Quarantine* (moves the host's VM NICs to VLAN 90, Security role only).

**Virtual machines**: every VM from `02-...-MAP.md`: name, host, state, vCPU/RAM, IP, replica health, checkpoint age. Detail tabs: Overview · Performance · Disks · Network · Replica · **Connect**.

**The Connect tab**, this is the feature that was missing:

| Mode | Protocol | For |
|---|---|---|
| **Desktop** | RDP through Apache Guacamole | `sql-01`, `legacy-landsurvey-01`, `adfs-01`, any Windows VM. Full desktop in the browser tab. |
| **Shell** | SSH through Guacamole | `gpu-01`, `siem-01` |
| **VM console** | VNC to the Hyper-V console | a VM that will not boot or has lost networking: the equivalent of standing at the rack |
| **PowerShell** | JEA-scoped web terminal | routine tasks without a desktop; only the cmdlets the role allows |

How a connect actually works, so there is no ambiguity:

1. Operator clicks *Connect → Desktop* on `sql-01`.
2. Console API checks role and tier. If the operator is not currently elevated, it offers *Request elevation* → an access grant with a reason, an approver, and an expiry (default 2 hours).
3. On approval, the API asks OpenBao for a **dynamic, one-time local credential** for that VM, valid for the session length. **The operator never sees a password**; Guacamole receives it directly and the operator never types one.
4. Guacamole opens the session in the browser tab, inside the console's chrome, with a red banner: *Recorded session · sql-01 · expires 15:42 · reason: "restore drill"*.
5. Every keystroke and the full screen video are recorded to `argus-sessions` (object-locked). Clipboard and file transfer are per-role: Operators get clipboard in only; Admins get both, and every file transfer is logged with a hash.
6. At expiry the session closes and the credential is revoked automatically.

**Advanced beyond AWS:** AWS has no browser RDP at all. Session Manager is text-only, and Fleet Manager's Remote Desktop is Windows-only, licence-gated and unrecorded by default. Recorded, credential-less, time-boxed RDP in the same UI as the deploy button is genuinely better than what you are leaving behind, and it removes the VPN client and the RDP shortcuts from everyone's laptop.

**Service Fabric**: cluster map; nodes as tiles, colour by health, applications as chips inside them, upgrade domains marked. Click a node → drain, restart, view its apps.

**GPU**: `gpu-01` utilisation over time, memory per process, the Ray dashboard embedded, "who is using it" (JupyterHub user or Dagster run), and a queue if two things want it.

### 3.5 Data

**Databases**: AG topology diagram (primary `sql-01` → async `sql-02`), synchronisation state and lag, backup timeline (full/diff/log as a horizontal band per day; a gap is visible instantly), last verified restore with its drill report, top queries from `sql_exporter`, connection count by application. Actions: *Request credential* (OpenBao lease, shown once, copy-to-clipboard, auto-revoked), *Trigger backup*, *Run restore drill*, *Failover* (Approver + confirm typing the database name).

**Query editor**, a browser SQL client for read-only investigation: role-scoped (Operators get `SELECT` on non-PII views; Security gets audit tables), every query logged to the audit with its text and row count, a hard row cap, a query timeout, and no `DELETE`/`UPDATE`/`DROP` grammar accepted at all for non-Admin roles. This is deliberately not a replacement for SSMS; it is the 90 % case (someone needs to check a number) without anyone RDP-ing into `sql-01`.

**Object storage**: bucket list with size, object count, lock mode and remaining days, replication lag to Site B, lifecycle rules. A **browser** for prefixes and objects with preview (images from `argus-survey-pictures`, GeoTIFF thumbnails from `argus-rasters` via TiTiler, JSON/text inline): because "find the survey photo for parcel X" should not require an S3 client. Upload/delete follow the bucket's own policy: `argus-backups` shows *Delete* disabled with the reason "object lock, 35 days".

**Cache**: Garnet memory, hit rate, keyspace by prefix, slow commands. **Queues**: NATS streams, message rate, consumer lag, dead-letter inspector with a *Replay* action.

### 3.6 Identity & secrets

**People**: AD users; name, tier, MFA method (passkey/FIDO2/TOTP), last sign-in, group membership, current elevations. A *Leaver* action that runs the offboarding runbook.

**Access grants**, the screen that makes tiered admin usable: *Request* (group, hours, reason) → approver notified on WhatsApp → approve/deny in one tap → the console adds the AD group membership **with a TTL** so it expires on its own. A live list of who is elevated right now, with a *Revoke* button, is on the Overview when non-empty. This is JIT privileged access, which AWS sells as a separate product.

**Secrets**: OpenBao paths as a tree, names only, never values. Per path: rotation age (amber past policy), active leases, last 20 reads with actor and time. Actions: *Rotate*, *Revoke all leases*. A *Request value* action exists for Admins, requires a reason, shows the value once, and pages the security channel.

### 3.7 Security

**Posture**: a heat grid; hosts × control families (CIS sections), coloured by Wazuh SCA score, trending. Click a cell for the failing checks and the runbook that fixes them.

**Alerts**: one inbox for Wazuh, Sysmon-derived rules, CrowdSec, Suricata, WDAC blocks, and OpenBao anomalies. Severity, host, rule, first/last seen, count. Actions: acknowledge with a note, quarantine the host, open the matching runbook, create an incident.

**Sessions**: every recorded RDP/SSH/console session; who, which VM, when, duration, reason, the approver, and a **video player with a keystroke timeline**. Searchable by typed command. This is the control that makes giving people RDP safe.

**Vulnerabilities**: by application and by host, with severity, fixed-in version, and waivers that carry an owner and an expiry date (an expired waiver is an alert, not a silent pass).

**Evidence**: the monthly pack; MFA coverage, WDAC state, patch age, backup drill outcomes, restore timings, open vulnerabilities, privileged grants and expiries, firewall changes from Git history; generated, signed, downloadable.

### 3.8 ML & geospatial

**Pipelines**: the Dagster asset graph rendered natively (not an iframe); `parcels → s2_periods → s1_periods → phenology → v5_train_table → v5_model → parcel_predictions`: each node coloured by freshness against its SLA, click for the last run, logs, and *Materialise*. **Models**: MLflow runs filtered to the v5 series, metrics side by side, lineage back to the exact feature-table version, *Promote to endpoint*. **Endpoints**: Ray Serve latency, request rate, canary split. **Imagery**: a map of Punjab/Sindh showing Sentinel mirror coverage by date, gaps in amber, a STAC search box, and a tile preview through TiTiler.

### 3.9 Operations

**Runbooks**: each `docs/runbooks/*.md` rendered from its front-matter; description, a form for its parameters, an approval gate if it declares one, then live output as it executes over JEA with a full transcript saved to the audit. This turns tribal knowledge into a button.

**Backups & drills**: a calendar of backups per data store, RPO trend line, drill history with pass/fail and timing, and the next scheduled drill with a countdown. A red state if any drill is overdue.

**Capacity & cost**: per-application CPU, memory, disk, GPU-hours, and object storage, priced with your actual amortised hardware and power cost, so "what does the Mills dashboard cost us per month" has a real answer. Forecast lines for when a disk or a node runs out. This is Cost Explorer for owned hardware, which no vendor ships.

### 3.10 Audit

Every action, forever: actor, role, elevation state, action, target, before/after, PR link, source IP, session id. Filterable, exportable, and linked from every other screen ("who changed this?" is a link, not a search).

---

## 4. Interaction patterns

| Pattern | Rule |
|---|---|
| **Every write is a PR** | The button says *Propose*, not *Save*, wherever it opens a PR. The response shows the PR and its diff. Two exceptions run live because they are emergencies, and both page security: *Quarantine host* and *Revoke leases*. |
| **Preview before apply** | Any change shows the reconciler's plan and the blast radius first. |
| **Destructive actions** | `danger` Button, a confirm dialog that requires typing the resource name, the environment restated, and never in the same dropdown group as a safe action. |
| **Command palette** | `⌘K`: jump to any resource, run any runbook, connect to any VM, by typing. This is how experienced operators will use the console. |
| **Deep links** | Every resource has a stable URL. Alerts, WhatsApp messages and runbooks link straight to the screen. |
| **Live by default** | Health, logs, sessions and deployments stream over SSE. No refresh button anywhere. |
| **Honest empty and error states** | The Mills voice: say what happened and what to do. Never fake success. |
| **Elevation is visible** | When elevated, the shell shows a `leaf` band with the remaining time and the reason. You always know what you are holding. |
| **Mobile** | Overview, Alerts, Deployments (approve/reject) and Runbooks work on a phone, because approvals happen at 9 p.m. from a car. RDP does not pretend to. |

## 5. Design system

Inherited wholesale from the Mills dashboard `DESIGN.md`, same tokens, same eight components, same Geist + Lora pairing, same chart palette in fixed order, same `motion-safe:` behaviour, same `/styleguide` route as the living reference. The console is a Zaraat Dost product and should look like one.

Three console-only additions, each documented in the styleguide when built:

| Addition | Why |
|---|---|
| `TerminalSurface` | a `pine` surface for Guacamole frames and the web terminal, with the recording banner, session timer, and disconnect control: the only place in the product with a dark background |
| `PlanDiff` | the reconciler's desired-vs-actual diff: additions in `brand`, removals in the danger tone, unchanged collapsed |
| `GraphCanvas` | dependency graphs and the Dagster asset graph; nodes are SectionCard-derived, edges hairline, layout left-to-right |

## 6. Build order

The console is worth building only in the order that retires an existing tool.

| Stage | Ships | Retires |
|---|---|---|
| **C1** (Phase 2) | Overview, Applications (Overview/Logs/Deploy history), Deployments | `package.ps1` / `update.ps1` and the deploy WhatsApp thread |
| **C2** (Phase 2-3) | Compute → VMs → **Connect** (Guacamole), Sessions | RDP clients, the VPN-for-RDP habit, shared local admin passwords |
| **C3** (Phase 3) | Data (Databases, Object storage, Query editor), Runbooks | ad-hoc SSMS sessions, S3 clients, tribal knowledge |
| **C4** (Phase 4) | Identity & secrets, Access grants | standing admin rights |
| **C5** (Phase 5) | Security (Posture, Alerts, Vulnerabilities, Evidence), ML, Capacity & cost | manual audit evidence, spreadsheet cost guesses |
| **C6** (Phase 6) | Hosts, Service Fabric map, Maintenance, full Audit | **Windows Admin Center** (ADR-0033) |

Until each stage lands, the tool it replaces stays. Nothing is removed before its replacement is proven.

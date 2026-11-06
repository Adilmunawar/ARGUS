# Validation status: what is proven, what is not

**Read this before trusting anything else in this repository.** Last revised 7 November 2026.

Most of Argus is a design. It was produced by research and reasoning, not by building it on Windows Server or on hardware. A smaller part is software that runs today: a console prototype, a console API, a Docker Compose stack, a PowerShell client and the CI checks around them. This page says which is which, at the confidence each part has earned, and how to check it yourself.

## Confidence levels

| Level | Meaning |
|---|---|
| **Verified** | Executed and observed, with a command or test anyone with the repository can rerun |
| **Grounded** | Read from vendor documentation, release notes or source; not executed here |
| **Reasoned** | Standard practice applied to this design; no source consulted for this exact combination |
| **Assumed** | Believed true, not checked: the highest-risk category |
| **Not built** | Specified in the documents or as files with schemas, but no working implementation exists |

## By component

"How" is the command that reproduces the result from the repository root unless it says otherwise. Dates are when the result was last observed.

### What runs today

| Component | Status | Last verified | How | Evidence |
|---|---|---|---|---|
| Console prototype, sample mode from `file://`: fifteen screens, accessibility (axe WCAG 2.1 and 2.2 A/AA), keyboard, contrast, reflow, density, layout, source security pass | Verified | 2026-11-07 | `npm test` (423 assertions) | [`run-tests.js`](../platform/console/prototype/tests/run-tests.js) |
| Console prototype across nine viewport, theme and density environments | Verified | 2026-11-07 | `npm run test:sandbox` (125 checks) | [`sandbox.js`](../platform/console/prototype/tests/sandbox.js) |
| Console prototype performance and retention budgets | Verified | 2026-11-07 | `npm run test:stress` | [`stress.js`](../platform/console/prototype/tests/stress.js) |
| Console prototype served by the API over http: sign-in, wrong password, roles, all fifteen screens live, a matrix of upstream faults, reload, expired session, sign-out, audit on the server | Verified | 2026-11-07 | `npm run test:live` (386 checks; starts the API with temporary operators, no Docker) | [`live.js`](../platform/console/prototype/tests/live.js), [`live-screens/`](../platform/console/prototype/tests/live-screens/) |
| Console API: sessions, scrypt hashes, roles (viewer, operator, security, admin), throttling and lockout, origin checks, the error envelope, streams, storage and GitOps readers | Verified | 2026-11-07 | `npm test` in `platform/console/server` (346 checks) | [`server/test/`](../platform/console/server/test/) |
| Compose stack: SeaweedFS, PostgreSQL with PostGIS, Garnet, NATS JetStream, OpenBao (sandbox seal), the console API, Prometheus, Alertmanager, Loki, Alloy, Grafana, Mailpit, the socket proxy and the exporters reach healthy | Verified | 2026-11-07 | `node platform/compose/stack.js bootstrap` then `up --wait`, which exits non-zero unless every long-running service is healthy and every one-shot exited 0. Run locally on Windows 11 with Docker Desktop, and by a compose smoke job in CI (added 2026-11-05) | [`compose.yml`](../.github/workflows/compose.yml), [`platform/compose/README.md`](../platform/compose/README.md) |
| The console reads live data from that stack on all fifteen screens, and marks what the stack lacks as "Not in this stack" | Verified | 2026-11-07 | The compose CI job runs the live suite against the composed console (378 checks); the screenshots in the README were taken from it | [`compose.yml`](../.github/workflows/compose.yml), [`docs/assets/`](assets/) |
| Object lock is enforced by the SeaweedFS S3 gateway on this build, and bypassable through the filer | Verified | 2026-11-07 | `storage-init` measures it at every boot, locally and in the compose CI job; the Object storage screen and the Advisor report it | [`init-object-storage.js`](../platform/console/tools/init-object-storage.js) |
| S3 parity harness against SeaweedFS, with LocalStack as an optional reference | Assumed | - | Built; no recorded run is committed. `docker compose --profile parity up -d` in `platform/compose` | [`services/parity/`](../platform/compose/services/parity/README.md) |
| PowerShell module `Argus` as a client of the console API | Verified, in isolation | every push | CI job *PowerShell analysis and tests*: PSScriptAnalyzer and the Pester suite. Not run against the stack | [`platform/cli/Argus/`](../platform/cli/Argus/README.md) |
| GitOps specs validate against their schemas; the inline-secret rule rejects a `password=` value | Verified | every push | CI job *Repository invariants* (`check-gitops.py`) | [`validate.yml`](../.github/workflows/validate.yml) |
| Every YAML, JSON, SQL and HCL file parses; compose bind mounts exist; no comments in code or config; no credential committed; no private name | Verified | every push | CI job *Repository invariants* and *Console prototype tests* | [`validate.yml`](../.github/workflows/validate.yml) |

CI runs the four console suites and the server tests on every push, and the compose job brings the whole stack up and runs the live suite against it on changes to the stack, the console or the GitOps tree, and nightly.

### What is designed but not built

| Component | Status | Design confidence | Where it is specified |
|---|---|---|---|
| Windows Server 2025 hosts, Hyper-V failover cluster, Storage Spaces Direct | Not built | Reasoned | ADR-0002, ADR-0004, [`02`](02-APPLICATION-INFRASTRUCTURE-MAP.md) |
| Service Fabric cluster and guest-executable packaging | Not built | Assumed (A1) | ADR-0005 |
| Active Directory, AD FS, tiered administration, gMSAs | Not built | Reasoned | ADR-0012, [`03`](03-SECURITY-ARCHITECTURE.md) |
| AD CS PKI, OpenBao in production (dynamic credentials, transit) | Not built | Reasoned | ADR-0013 |
| WDAC base policy and catalogues, GPO baselines | Not built | Assumed (A5) | ADR-0014, `platform/policies/` (placeholders) |
| IPsec domain isolation | Not built | Reasoned | ADR-0015, `platform/policies/firewall/ipsec-rules.yaml` (a specification) |
| OPNsense perimeter, Caddy and Coraza edge, egress proxy | Not built | Reasoned | ADR-0016, ADR-0017, ADR-0027, [`04`](04-NETWORK-AND-SITES.md) |
| Sysmon, WEF and Wazuh SIEM, and the Wazuh rule packs | Not built | Reasoned | ADR-0018 |
| The GitOps reconciler | Not built | Assumed (A10) | ADR-0023, [`05`](05-CONTROL-PLANE.md) §2 |
| Console write paths: approve, grant, rotate, freeze, two-person approval, silences, deploy | Not built; sample mode only. The API has no write routes besides sign-in and sign-out | Reasoned | ADR-0035, [`10`](10-CONSOLE-DESIGN.md) |
| Durable console audit (`argus_console_events`) | Not built; the API keeps an in-memory ring | Reasoned | ADR-0035 |
| Browser RDP and SSH brokered by the console | Not built; the prototype's drawer is simulated. Guacamole runs in the compose `connect` profile but the console does not use it | Assumed (A11) | ADR-0032 |
| Backups to object-locked storage at two sites, restore and DR drills | Not built | Reasoned | ADR-0020, ADR-0026 |
| ML platform on `gpu-01` and the Sentinel mirror | Not built | Assumed (A7) | ADR-0028, ADR-0029 |
| OpenTofu `shielded-vm` module, DSC resources, the CI signing pipeline | Not built | Reasoned | ADR-0024, ADR-0025, `platform/iac/` |
| Runbook bodies beyond `boot-01-day-one` | Not built | Reasoned | [`06`](06-PHASES-AND-RUNBOOKS.md) |

### Grounded facts the design depends on

| Fact | Status | Checked | Source |
|---|---|---|---|
| Licence and status of each chosen component: SeaweedFS Apache-2.0 with a Windows build; MinIO community edition archived in February 2026; OpenBao MPL-2.0; Garnet MIT and RESP-compatible; Service Fabric MIT | Grounded | 2026-09-08 | Vendor documentation and release notes, cited in each ADR |
| Hardware and licence prices in [`07`](07-HARDWARE-AND-LICENSING.md) | Assumed (A6) | 2026-09-08 | List prices; no quote |

## Assumed: the risk register

These are the things most likely to be wrong, in the order they will bite:

| # | Assumption | If wrong |
|---|---|---|
| A1 | Service Fabric standalone on Windows Server 2025 is current and supported for new clusters | ADR-0005 collapses → fall back to Nomad or a WinSW supervisor + the reconciler |
| A2 | SeaweedFS's Windows build is production-viable and its S3 surface satisfies the .NET SDK, `rclone`, Kopia and `wal-g` | ADR-0007 changes → SeaweedFS on a Linux VM (a fourth exception) or Ceph |
| A3 | `orders_db`'s stored procedures work unchanged on a restored copy in a Shielded VM | Phase 2 slips; some procs may need work |
| A4 | Shielded VMs + HGS do not interfere with SQL Server performance or Hyper-V Replica | drop shielding for `sql-01`, keep BitLocker |
| A5 | WDAC can be made to allow every third-party binary here via catalogues without breaking them | WDAC stays in audit mode longer than Phase 6 |
| A6 | Hardware prices and licence prices in `07-...` are within ±25 % for the adopting organisation's region | budget is wrong: get quotes first |
| A7 | The notebook-built feature table for the ML workload reproduces on `gpu-01` within tolerance | Phase 3 gate slips |
| A8 | A 100 Mbps site link carries the steady-state replication | Site B lags; needs more bandwidth |
| A9 | `.NET 10` / SQL Server 2022 / Windows Server 2025 version combination has no blocking incompatibility | version pin changes |
| A10 | The reconciler is ~2,000 lines of C# | it is the platform's single point of failure; budget more |
| A11 | Guacamole's RDP recording, AD auth and OpenBao-injected one-time credentials work together on Windows Server 2025 targets | ADR-0032 weakens to recorded-but-password-typed, or to WAC's RDP; test it in the day-one lab |

The [day-one lab runbook](runbooks/boot-01-day-one.md) tests A1, A2 and A11 on one spare machine before any hardware is ordered.

## What would change this document

Phase 0's exit gate is the first real test of the platform design. After it, this file is rewritten with what happened, including the assumptions that turned out wrong. Until then, the "What runs today" table is the only part of Argus that has been executed.

# Changelog

All notable changes to the Argus plan and platform. Dated, with the reason, because a platform whose history nobody can explain is a platform nobody can safely change.

## [0.5.0] — 2026-09-08

### Changed
- **The platform is named Argus, not ZD Cloud** (ADR-0034, owner decision). ZD Cloud was the company's initials wearing a product's clothes: it tied the platform's identity to the agriculture business and made it indistinguishable from any other tool with the same letters. Argus Panoptes is the watchman who never slept, which is what a platform built on *evidence, not assurance* is trying to be.
- **The identifier prefix is the full word `argus`, never `arg`** — a deliberate three extra characters. ADR-0023 exists to say this platform does not use Flux or Argo; an `arg-` prefix on buckets and clusters would read as Argo to everyone who joins.
- Relabelled across 87 files: AD forest `zd.local` → `argus.local`; buckets `zd-*` → `argus-*`; `ZdConsole` → `ArgusConsole`; PostgreSQL schemas `zd_geo`/`zd_ml`/`zd_console_events` → `argus_*`; NATS subjects `zd.*` → `argus.*`; clusters `zd-hvc-a/b`, `zd-sf-a` and AG `zd-ag1` → `argus-*`; AD groups `ZD-Console-*`/`ZD-Tier0-Admins` → `Argus-*`; AD CS templates `ZD-Issuing-CA`/`ZD-CodeSigning` → `Argus-*`; GitOps `apiVersion: zdcloud/v1` → `argus/v1`; .NET projects `ZdCloud.*` → `Argus.*`; DSC resources `ZdCloud/*` → `Argus/*`; `C:\ZdCloud\` → `C:\Argus\`; PowerShell module `ZDCloud` → `Argus` with `*-Zd*` cmdlets → `*-Argus*`; CLI `zdc` → `argus`; repositories `zd-cloud` → `argus` and `zd-cloud-gitops` → `argus-gitops`.
- **The company is unchanged.** Zaraat Dost remains the company and `zaraatdost.pk` the domain; `console.zaraatdost.pk` and `api.zaraatdost.pk` are untouched. The console shell shows the product over the company, which is the correct relationship.

### Added
- **ADR-0034** — the naming decision, the `argus`-not-`arg` prefix rule and its reason, and the full list of what was relabelled.
- **Q13** in `08-OPEN-QUESTIONS.md` — trademark and `.pk` domain clearance for the name. An older network-monitoring tool and a commodities-pricing firm both use *Argus*; neither is in this market, but neither has been checked. This must close before the name appears anywhere outside this repository.

### Not changed, deliberately
- `docs/adr/superseded/` is left exactly as written. It records a plan that was rejected on 7 September; rewriting names inside it would falsify what was actually proposed.
- Four external names are retained: `zd-daily-db-backups` (an existing AWS bucket), `zdost.aoserv.com` (the current production host), and `adilmunawar/ZD-claude-plugin` with its `zd-deploy` / `zd-ops` / `zd-security` plugins (a separate repository, its own change).
- The console mark is still a leaf, inherited from the Mills design system. A leaf suited ZD Cloud and does not obviously suit Argus; the mark needs a decision before console stage C1 ships.

## [0.4.0] — 2026-09-08

### Added
- MIT licence, `CONTRIBUTING.md`, GitHub Actions `validate` workflow (GitOps schema, secret scan, console suite, external-URL check), and issue templates for challenging an ADR or reporting a broken assumption.
- **DENS test suite** — 12 assertions across 1366×768, 1280×800 and 1024×768 asserting that chrome and header stay under 55% of the viewport, all stat tiles clear the fold, and Overview stays under two screens. 65/65 passing.

### Changed
- **Compact density for small-screen laptops**, keyed to viewport *height* rather than width because vertical space is the real constraint on a 1366×768 machine. Below 860px tall, and again below 720px, the whole interface tightens. First card of content on a 1366×768 laptop moves from 445px to 384px; the Overview page from 1126px to 1004px. A 1440×900 screen is untouched.
- Tile grid holds four columns down to 1000px instead of 1200px — the earlier breakpoint forced a second row of tiles at 1024×768 and cost 110px of vertical space.
- README rewritten for a public audience with badges and an at-a-glance table.

## [0.3.0] — 2026-09-08

### Added
- `docs/11-CONSOLE-UX-BENCHMARK-AND-BUGS.md` — AWS Cloudscape, Google Cloud and Azure benchmarked component by component with a verdict on each; the test suite; the full bug register; the fix plan.
- `platform/console/prototype/tests/run-tests.js` — headless-Chromium suite, 9 suites and 51 assertions: axe-core WCAG 2.1 A/AA per screen, real Tab-key focus traversal, contrast from rendered colours, four viewports, touch targets, reduced motion, console errors. Exit code is the failure count so CI can gate on it.

### Changed
- Console prototype rewritten as v2: collapsible rail (Cloudscape app layout / GCP), flashbar, property-filter tokens, breadcrumbs, skip link, live region, `aria-current`, focus-managed navigation.
- **Minimum font size raised from 10px to 11px** — a deliberate, recorded deviation from the Mills design system, because this console is read under pressure.

### Fixed
- **B1/B2 (critical)** — the console was 755px wide on a 390px phone and unusable. Rail collapses at 1200px, drawer at 900px, top bar wraps at 620px; content column changed to `minmax(0,1fr)` because grid items default to `min-width:auto`.
- **B3–B13** — ten click handlers on non-focusable spans; no focus ring outside `.btn`; a Google Fonts fetch that would have failed behind the egress allow-list (ADR-0027); `.delta.up` at 3.73:1; `opacity`-based disabled state; wrapped status pills; 15px touch targets; missing table captions and scopes; no skip link, live region or title changes.
- **T1–T5** — five defects in the test harness itself, which had produced fourteen false failures. Recorded in the bug register beside the real ones.

## [0.2.0] — 2026-09-08

### Added
- `docs/10-CONSOLE-DESIGN.md` — the AWS Console studied as nine repeating patterns, each mapped to a Argus screen; nine console sections specified screen by screen; interaction rules; the Mills design system inherited with three console-only components; a six-stage build order where each stage retires a named existing tool.
- **ADR-0032** — browser RDP/SSH/VM-console via Apache Guacamole. Credential-less (OpenBao issues a one-time, session-scoped credential the operator never sees), time-boxed, fully recorded to the object-locked `argus-sessions` bucket, clipboard and file transfer gated by role.
- **ADR-0033** — the console is the primary surface; Windows Admin Center becomes bootstrap and break-glass only, retired at console stage C6. Grafana explicitly stays.
- `platform/console/prototype/index.html` — a static, clickable prototype of six screens using the Mills tokens, so the design can be argued with before any C# is written.
- `argus-sessions` bucket and `gmsa-guacamole$` added to the GitOps inventory; risk **A11** (Guacamole recording + AD auth + OpenBao credentials on Server 2025) added to the register and to the day-one lab.

### Changed
- **ADR-0003 amended in place**: three Linux exceptions, not two — `gpu-01`, `siem-01`, and now `guac-01`.
- The control-plane assumption that operators reach servers with an RDP client over the VPN is withdrawn. It meant typed credentials, standing access and no record of what happened inside a session, which contradicted the platform's own security case.

## [0.1.1] — 2026-09-08

### Added
- `docs/09-VALIDATION-STATUS.md` — confidence level for every claim in the repository, plus a ten-entry register of the assumptions most likely to be wrong.
- `docs/runbooks/boot-01-day-one.md` — a five-day lab on one spare machine that falsifies the three riskiest assumptions before hardware is ordered.

### Verified
- All 8 `platform/` YAML and JSON files parse.
- `apps/mills/app.yaml` validates against `schemas/app.schema.json`.
- The schema's inline-secret rule was negative-tested and does reject `password=` values in `env`.

### Note
- Nothing else in this repository has been executed. The plan was written without access to Windows Server or hardware.

## [0.1.0] — 2026-09-08

### Added
- Repository scaffold, documentation order, `platform/` layout, the rule that every change is an ADR + changelog line + commit.
- **ADR-0001 … ADR-0031** — the complete decision record for the Windows-first platform (`docs/01-DECISIONS.md`, one file each under `docs/adr/`).
- **Master plan v0.1.0** — targets as numbers, fourteen capabilities mapped to Windows-native implementations, two-site topology, eight principles, seven phases with exit gates, external dependencies, staffing, three-year cost, hybrid checkpoint.
- **Application–infrastructure map** — every host, VM, Service Fabric application and business application (Mills, loan app, AGIS, ML pipelines, Zaraat Dost AI, the console) traced to identity, port, data store, bucket, secret path, backup, SLO and alert.
- **Security architecture** — threat model, hardware root of trust, tiered AD, WDAC/Authenticode, IPsec east–west, data protection, detection and paging rules, evidence pack, delivery-pipeline security.
- **Network and sites** — eleven zones, addressing, edge, RDMA storage fabric, egress proxy, Site B bandwidth, power sequencing.
- **Control plane** — GitOps repo layout, first-party reconciler design, console screens/roles/API, `Argus` PowerShell module, end-to-end change flow.
- **Phases and runbooks**, **hardware and licensing**, **open questions** (Q1–Q12).
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
- ADR-0031 (return `umairv3_db` to FULL recovery) awaits the owner's ruling — see `docs/08-OPEN-QUESTIONS.md` Q7.

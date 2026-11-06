# Architecture decisions

Why Argus is built the way it is. Each decision is one file under [`adr/`](adr/), and that file is the record. This page is the index and a one-paragraph summary of each; where the two disagree, the file wins and this page is wrong.

## How the record works

* Every ADR opens with a **Status** line: *Proposed*, *Accepted*, or *Superseded by ADR-nnnn*, with the **Date** it was decided and, where it applies, what it supersedes or amends.
* The substance of an accepted decision is not rewritten. A changed decision is a new ADR that supersedes the old one, and the old one says so in its Status line. An amendment that narrows or extends a decision is recorded as an **Amendment** note at the end of the amended ADR and in the Status lines of both.
* Editorial changes are allowed and are recorded in the changelog: Status lines, links, a corrected fact about the tree, neutral sample names in place of identifying ones, and an **Options** section written from alternatives the ADR's own text already argued.
* 18 of the 35 ADRs list the options weighed. The rest state the decision and its reasons; where they name a rejected alternative it is in the *Why* paragraph.
* New ADRs use the shape Status, Context, Options, Decision, Why, Consequences. [`CONTRIBUTING.md`](../CONTRIBUTING.md) says how a challenge to one is raised.

## Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](adr/ADR-0001-leave-aws-build-a-sovereign-private-cloud.md) | Leave AWS; build a sovereign private cloud | Accepted | 2026-09-08 |
| [0002](adr/ADR-0002-windows-server-is-the-platform-base.md) | Windows Server is the platform base | Accepted | 2026-09-08 |
| [0003](adr/ADR-0003-two-accepted-linux-exceptions.md) | Two accepted Linux exceptions | Accepted, amended by [ADR-0032](adr/ADR-0032-browser-rdp-ssh-via-guacamole.md) | 2026-09-08 |
| [0004](adr/ADR-0004-hyper-v-failover-clustering-storage-spaces-direct.md) | Hyper-V + Failover Clustering + Storage Spaces Direct | Accepted | 2026-09-08 |
| [0005](adr/ADR-0005-service-fabric-as-the-application-scheduler-guest-executable.md) | Service Fabric as the application scheduler; guest executables | Accepted | 2026-09-08 |
| [0006](adr/ADR-0006-no-container-registry-in-v1.md) | No container registry in v1 | Accepted | 2026-09-08 |
| [0007](adr/ADR-0007-seaweedfs-for-object-storage-minio-retired.md) | SeaweedFS for object storage; MinIO retired | Accepted | 2026-09-08 |
| [0008](adr/ADR-0008-sql-server-stays-postgresql-postgis-added.md) | SQL Server stays; PostgreSQL + PostGIS added | Accepted | 2026-09-08 |
| [0009](adr/ADR-0009-garnet-for-caching.md) | Garnet for caching | Accepted | 2026-09-08 |
| [0010](adr/ADR-0010-nats-jetstream-for-queues-and-events.md) | NATS JetStream for queues and events | Accepted | 2026-09-08 |
| [0011](adr/ADR-0011-self-hosted-azure-functions-host.md) | Self-hosted Azure Functions host | Accepted | 2026-09-08 |
| [0012](adr/ADR-0012-active-directory-ad-fs-tiered-administration.md) | Active Directory + AD FS; tiered administration | Accepted | 2026-09-08 |
| [0013](adr/ADR-0013-openbao-for-secrets-ad-cs-for-pki.md) | OpenBao for secrets; AD CS for PKI | Accepted | 2026-09-08 |
| [0014](adr/ADR-0014-wdac-authenticode-only-signed-code-runs.md) | WDAC + Authenticode: only signed code runs | Accepted | 2026-09-08 |
| [0015](adr/ADR-0015-ipsec-domain-isolation-instead-of-a-service-mesh.md) | IPsec domain isolation instead of a service mesh | Accepted | 2026-09-08 |
| [0016](adr/ADR-0016-caddy-coraza-at-the-edge-yarp-per-application.md) | Caddy + Coraza at the edge, YARP per application | Accepted | 2026-09-08 |
| [0017](adr/ADR-0017-opnsense-ha-pair-crowdsec.md) | OPNsense HA pair + CrowdSec | Accepted | 2026-09-08 |
| [0018](adr/ADR-0018-sysmon-wef-wazuh.md) | Sysmon + WEF + Wazuh | Accepted | 2026-09-08 |
| [0019](adr/ADR-0019-prometheus-grafana-loki-opentelemetry.md) | Prometheus / Grafana / Loki / OpenTelemetry | Accepted | 2026-09-08 |
| [0020](adr/ADR-0020-backups.md) | Backups | Accepted | 2026-09-08 |
| [0021](adr/ADR-0021-control-surface.md) | Control surface | Accepted | 2026-09-08 |
| [0022](adr/ADR-0022-the-console-is-net-10-next-js-on-service-fabric.md) | The console is .NET 10 + Next.js on Service Fabric | Superseded by [ADR-0035](adr/ADR-0035-the-console-as-built.md) | 2026-09-08 |
| [0023](adr/ADR-0023-first-party-gitops-reconciler.md) | First-party GitOps reconciler | Accepted | 2026-09-08 |
| [0024](adr/ADR-0024-ci-on-github-actions-self-hosted-windows-runners-forgejo-mir.md) | CI on GitHub Actions self-hosted Windows runners; Forgejo mirror | Accepted | 2026-09-08 |
| [0025](adr/ADR-0025-opentofu-dsc-v3-for-iac.md) | OpenTofu + DSC v3 for IaC | Accepted | 2026-09-08 |
| [0026](adr/ADR-0026-two-sites.md) | Two sites | Accepted | 2026-09-08 |
| [0027](adr/ADR-0027-external-services-behind-an-egress-proxy.md) | External services behind an egress proxy | Accepted | 2026-09-08 |
| [0028](adr/ADR-0028-local-sentinel-mirror-stac.md) | Local Sentinel mirror + STAC | Accepted | 2026-09-08 |
| [0029](adr/ADR-0029-ml-platform-on-one-gpu-node.md) | ML platform on one GPU node | Accepted | 2026-09-08 |
| [0030](adr/ADR-0030-mobile-app-password-scheme-frozen-ad-fs-fronts-the-web.md) | Mobile-app password scheme frozen; AD FS fronts the web | Accepted | 2026-09-08 |
| [0031](adr/ADR-0031-sql-server-back-to-full-recovery-proposed.md) | SQL Server back to FULL recovery | Proposed | 2026-09-08 |
| [0032](adr/ADR-0032-browser-rdp-ssh-via-guacamole.md) | Browser RDP/SSH/VM-console via Apache Guacamole | Accepted | 2026-09-08 |
| [0033](adr/ADR-0033-console-is-primary-wac-retired-at-parity.md) | The console is the primary surface; Windows Admin Center is retired at parity | Accepted | 2026-09-08 |
| [0034](adr/ADR-0034-the-platform-is-named-argus.md) | The platform is named Argus | Accepted | 2026-09-08 |
| [0035](adr/ADR-0035-the-console-as-built.md) | The console as built: an ES5 prototype served by a small Node API | Accepted | 2026-11-05 |

## Summaries

Each summary restates the decision paragraph of the ADR file, with the chosen option spelled out where the file refers to it by letter.

### ADR-0001: Leave AWS; build a sovereign private cloud

Full exit from AWS onto owned hardware, phased, with a hybrid (local GPUs and storage, AWS for the database) as an explicit checkpoint at the end of Phase 3 (`00-MASTER-PLAN.md` §10). Staying on AWS and a permanent hybrid were the other options. [Full record](adr/ADR-0001-leave-aws-build-a-sovereign-private-cloud.md).

### ADR-0002: Windows Server is the platform base

Windows Server, native, end to end: hypervisor, cluster, identity, database and applications, chosen by the decision owner on 8 Sep 2026 over a Linux/Kubernetes platform (Cozystack on Talos) and a Windows host with Linux VMs for the platform layer. [Full record](adr/ADR-0002-windows-server-is-the-platform-base.md).

### ADR-0003: Two accepted Linux exceptions

Exactly two Linux systems, both hardened Ubuntu 24.04 LTS, AD-joined and managed through the same GitOps repository: `gpu-01` (bare metal, NVIDIA drivers, Ray/MLflow/Dagster) and `siem-01` (a Shielded VM running the Wazuh manager and indexer). OPNsense devices count as appliances. ADR-0032 later added a third, `guac-01`; a fourth needs its own ADR. [Full record](adr/ADR-0003-two-accepted-linux-exceptions.md).

### ADR-0004: Hyper-V + Failover Clustering + Storage Spaces Direct

A 3-node hyper-converged Hyper-V cluster with Storage Spaces Direct at Site A, growing to 5; ReFS with mirror-accelerated parity; Cluster Shared Volumes; Hyper-V Replica to Site B. A separate SAN and Proxmox were the alternatives. [Full record](adr/ADR-0004-hyper-v-failover-clustering-storage-spaces-direct.md).

### ADR-0005: Service Fabric as the application scheduler; guest executables

Service Fabric standalone, 5 nodes (3 seed), with applications packaged as guest executables (`.sfpkg`), not containers. Nomad was the runner-up; Windows containers under a Linux Kubernetes control plane and per-host WinSW services were also weighed. [Full record](adr/ADR-0005-service-fabric-as-the-application-scheduler-guest-executable.md).

### ADR-0006: No container registry in v1

Application packages are signed `.sfpkg` archives stored in the `argus-artifacts` bucket (SeaweedFS, object-locked), addressed by Git commit SHA. Harbor is not deployed. [Full record](adr/ADR-0006-no-container-registry-in-v1.md).

### ADR-0007: SeaweedFS for object storage; MinIO retired

SeaweedFS at both sites, running as Windows services (WinSW), with async cross-site replication of the `argus-backups` bucket. Buckets: `argus-uploads`, `argus-rasters`, `argus-sentinel`, `argus-artifacts`, `argus-backups`, `argus-ml`. [Full record](adr/ADR-0007-seaweedfs-for-object-storage-minio-retired.md).

### ADR-0008: SQL Server stays; PostgreSQL + PostGIS added

SQL Server 2022 Standard in an Always On availability group (primary VM Site A, async secondary Site B). PostgreSQL 17 + PostGIS 3.5 (EDB Windows build) as a second engine for STAC (`pgstac`), classifier feature tables, region vector tiles and anything additive the application teams move off SQL Server over time. [Full record](adr/ADR-0008-sql-server-stays-postgresql-postgis-added.md).

### ADR-0009: Garnet for caching

**Microsoft Garnet** (MIT, .NET, RESP-compatible) as a Windows service. Any Redis client works. [Full record](adr/ADR-0009-garnet-for-caching.md).

### ADR-0010: NATS JetStream for queues and events

NATS server (Apache-2.0, Windows binary) with JetStream, 3-node cluster across the Service Fabric nodes. Subjects: `argus.ingest.*` (shapefile uploads), `argus.export.*`, `argus.ai.*`, `argus.sentinel.scene.landed`, `argus.pipeline.*`. [Full record](adr/ADR-0010-nats-jetstream-for-queues-and-events.md).

### ADR-0011: Self-hosted Azure Functions host

The **Azure Functions host runtime** (MIT), isolated-worker .NET model, deployed as a Service Fabric guest executable per function app, triggered by NATS (custom trigger) and timers. No Azure account involved. [Full record](adr/ADR-0011-self-hosted-azure-functions-host.md).

### ADR-0012: Active Directory + AD FS; tiered administration

A new forest `argus.local` (two DCs at Site A, one at Site B); **AD FS** for OIDC/SAML to the console, Grafana, Windows Admin Center, JupyterHub and the Orders web login; **Windows Hello for Business / FIDO2** for humans; **gMSA** for every service; **LAPS**; **Tier 0/1/2** admin model with Privileged Access Workstations; **JEA** endpoints for operators; NTLM disabled; LDAP signing and channel binding enforced. [Full record](adr/ADR-0012-active-directory-ad-fs-tiered-administration.md).

### ADR-0013: OpenBao for secrets; AD CS for PKI

**OpenBao** (MPL-2.0, Linux Foundation fork of Vault, Windows binary) as a 3-node Raft cluster on the Service Fabric nodes, Shamir 3-of-5 unseal held by three people, audit device to Loki. Dynamic SQL Server and PostgreSQL credentials (1 h TTL), transit engine for PII fields, KV for third-party keys. **AD Certificate Services** (two-tier: offline root, enterprise issuing CA) for machine certificates, IPsec, code signing and the internal TLS chain; external TLS via ACME (Let's Encrypt) at the edge. [Full record](adr/ADR-0013-openbao-for-secrets-ad-cs-for-pki.md).

### ADR-0014: WDAC + Authenticode: only signed code runs

**Windows Defender Application Control** in enforced mode on every server: only code signed by the Argus code-signing certificate (AD CS, key on an HSM or at minimum a TPM-bound cert on the build server) or by Microsoft runs; binaries, DLLs, drivers, PowerShell scripts. CI signs every artefact; `.sfpkg` packages are also signed and verified by the reconciler before deployment. PowerShell Constrained Language Mode everywhere but Tier 0 PAWs. [Full record](adr/ADR-0014-wdac-authenticode-only-signed-code-runs.md).

### ADR-0015: IPsec domain isolation instead of a service mesh

Windows Firewall connection-security rules via GPO: all server-to-server traffic inside the platform requires Kerberos (machine) or certificate (AD CS) authentication and AES-GCM encryption; unauthenticated inbound is dropped. Linux exceptions use strongSwan with AD CS certificates. Per-service inbound rules allow only the identities that need to connect (e.g. SQL accepts only the Orders API gMSA and the backup gMSA). [Full record](adr/ADR-0015-ipsec-domain-isolation-instead-of-a-service-mesh.md).

### ADR-0016: Caddy + Coraza at the edge, YARP per application

**Caddy** (Apache-2.0, Windows binary) as the internal edge: ACME certificates, HTTP/3, Brotli, **Coraza** WAF with the OWASP Core Rule Set, rate limiting. Behind it, each application keeps its own **YARP** gateway (the Orders application already has one). Caddy runs as a Service Fabric guest executable on two nodes with a cluster IP. [Full record](adr/ADR-0016-caddy-coraza-at-the-edge-yarp-per-application.md).

### ADR-0017: OPNsense HA pair + CrowdSec

Two OPNsense appliances per site (CARP failover): perimeter firewall, Suricata IDS/IPS, GeoIP policy, WireGuard site-to-site and admin VPN authenticated against AD via NPS (RADIUS) with MFA, traffic shaping. CrowdSec agents on Caddy and the Windows hosts feed decisions to an OPNsense bouncer. [Full record](adr/ADR-0017-opnsense-ha-pair-crowdsec.md).

### ADR-0018: Sysmon + WEF + Wazuh

Sysmon (SwiftOnSecurity/Olaf Hartong baseline) on every Windows host; Windows Event Forwarding to a collector; Wazuh agents everywhere; Wazuh manager + indexer + dashboard on `siem-01`; PowerShell script-block and module logging; Defender AV with ASR rules and Controlled Folder Access; **Microsoft Security Baselines** + CIS via GPO with Wazuh SCA scoring drift. [Full record](adr/ADR-0018-sysmon-wef-wazuh.md).

### ADR-0019: Prometheus / Grafana / Loki / OpenTelemetry

Prometheus + `windows_exporter` + `sql_exporter`; Grafana (AD FS login); Loki with Grafana Alloy agents shipping Windows Event Log and application logs; OpenTelemetry Collector receiving traces from the .NET APIs and Next.js; Alertmanager → Apprise → chat and SMS channels; Uptime Kuma at Site B watching Site A from outside. All have native Windows builds. [Full record](adr/ADR-0019-prometheus-grafana-loki-opentelemetry.md).

### ADR-0020: Backups

SQL Server: native full nightly + differential 6-hourly + **log every 15 min** (once ADR-0031 lands) to `argus-backups` with `CHECKSUM` and `RESTORE VERIFYONLY`, encrypted, object-locked 35 days at Site A, replicated to Site B and locked 90 days. PostgreSQL: pgBackRest (Windows via WSL is not allowed; use `pg_basebackup` + WAL archiving to S3 via the `wal-g` Windows build). Files (uploaded images, rasters): Kopia (Windows) content-addressed, encrypted. VMs: Hyper-V Replica to Site B (5-min RPO) + weekly Windows Server Backup of hosts. The backup gMSA has `PUT` but never `DELETE` on the buckets. **Restore drill monthly, DR drill quarterly**, reports signed and committed to `docs/runbooks/drills/`. [Full record](adr/ADR-0020-backups.md).

### ADR-0021: Control surface

Three surfaces, one truth: a **web console** for operators and site staff; a **PowerShell module (`Argus`) and thin `argus` CLI** for engineers; a **GitOps repository** (`platform/gitops/`) that is the only writer of production state. The console and CLI call the same console API; the console API writes to Git and the reconciler applies Git. Direct changes to production outside the reconciler are denied by WDAC/JEA and alerted by Wazuh. The decision owner's choice, 8 Sep 2026. [Full record](adr/ADR-0021-control-surface.md).

### ADR-0022: The console is .NET 10 + Next.js on Service Fabric

`platform/console/`: a .NET 10 minimal API (`Argus.Console.Api`) and a Next.js 16 front end, deployed as a Service Fabric application, authenticated by AD FS, authorised by AD groups mapped to console roles. Day one, before parity: Windows Admin Center for raw host management and Grafana for observability, both behind AD FS. [Full record](adr/ADR-0022-the-console-is-net-10-next-js-on-service-fabric.md).

### ADR-0023: First-party GitOps reconciler

`Argus.Reconciler`, a .NET Service Fabric stateful service: polls the GitOps repo, verifies commit signatures, diffs desired vs actual (Service Fabric apps, Hyper-V VMs via WMI, SeaweedFS buckets, OpenBao policies, GPO links via DSC), applies in dependency order, reports status to the console and Grafana. [Full record](adr/ADR-0023-first-party-gitops-reconciler.md).

### ADR-0024: CI on GitHub Actions self-hosted Windows runners; Forgejo mirror

GitHub stays the collaboration surface; self-hosted runners (Windows, WDAC-compliant, no internet except allow-listed) build, test, sign and upload `.sfpkg` to `argus-artifacts`. Forgejo (Windows binary) mirrors every repo and can run the same workflows if GitHub is unreachable. [Full record](adr/ADR-0024-ci-on-github-actions-self-hosted-windows-runners-forgejo-mir.md).

### ADR-0025: OpenTofu + DSC v3 for IaC

OpenTofu with the Hyper-V provider defines VMs; PowerShell DSC v3 configures Windows hosts and VMs (roles, features, WDAC policy, GPO membership, WinSW services); the reconciler drives both. [Full record](adr/ADR-0025-opentofu-dsc-v3-for-iac.md).

### ADR-0026: Two sites

Site A (primary, in the organisation's main region) and Site B (a second building or a colocation rack in a second region; the decision owner's choice, pending as Q1 in `08-OPEN-QUESTIONS.md`): 2 nodes, Hyper-V Replica target, SQL async secondary, SeaweedFS replica with 90-day object lock, third domain controller, Uptime Kuma, cluster witness. RTO ≤ 8 h for full Site A loss. [Full record](adr/ADR-0026-two-sites.md).

### ADR-0027: External services behind an egress proxy

Google Earth Engine, the Anthropic API and OpenRouteService remain external. All egress from the platform goes through an allow-listing proxy (Caddy forward-proxy or OPNsense) with keys held in OpenBao and injected at runtime; no host has general internet access. OpenRouteService is self-hosted with a regional OSM extract in Phase 3 (Java, runs on Windows), removing the 2,000/day quota. [Full record](adr/ADR-0027-external-services-behind-an-egress-proxy.md).

### ADR-0028: Local Sentinel mirror + STAC

Sentinel-1 GRD and Sentinel-2 L2A for the regional AOIs pulled via `eodag` from the Copernicus Data Space, converted to COGs, stored in `argus-sentinel`, indexed in `pgstac` on PostgreSQL. TiTiler (Python, Windows) serves dynamic raster tiles; Martin (Rust, Windows build) serves region vector tiles from PostGIS. [Full record](adr/ADR-0028-local-sentinel-mirror-stac.md).

### ADR-0029: ML platform on one GPU node

`gpu-01`: Ubuntu 24.04, 2 × NVIDIA L40S, Ray (head + workers on the same box), MLflow (artefacts to `argus-ml`), Dagster (asset graphs for the v5 classifier feature tables and the SegFormer/HRNet pipelines), JupyterHub with AD FS login. No Kubeflow, no KServe: inference endpoints are Ray Serve behind Caddy. [Full record](adr/ADR-0029-ml-platform-on-one-gpu-node.md).

### ADR-0030: Mobile-app password scheme frozen; AD FS fronts the web

The Orders API keeps minting its own JWTs for the mobile apps. The web login moves to AD FS (OIDC) in Phase 2; the API accepts either token type, scoped by the same per-tenant authorisation checks. When the mobile apps next release, they adopt OIDC PKCE against AD FS and the HMAC table is frozen (no new writes). [Full record](adr/ADR-0030-mobile-app-password-scheme-frozen-ad-fs-fronts-the-web.md).

### ADR-0031: SQL Server back to FULL recovery

Once ADR-0020's 15-minute log backups are running and proven for two weeks, return to FULL. This restores point-in-time recovery (RPO 15 min instead of "last full"). It needs the decision owner's acceptance because it reverses a change made outside the platform (Q7 in `08-OPEN-QUESTIONS.md`). [Full record](adr/ADR-0031-sql-server-back-to-full-recovery-proposed.md).

### ADR-0032: Browser RDP/SSH/VM-console via Apache Guacamole

Apache Guacamole on `guac-01`, embedded in the console's Connect tab: credentials come from OpenBao as one-time, session-scoped values the operator never sees, and every session is time-boxed and recorded to the object-locked `argus-sessions` bucket. This amends ADR-0003 to three Linux exceptions. [Full record](adr/ADR-0032-browser-rdp-ssh-via-guacamole.md).

### ADR-0033: The console is the primary surface; Windows Admin Center is retired at parity

Windows Admin Center is a **bootstrap and fallback tool**, not part of the target architecture. It is used from Phase 0 and retired when console stage **C6** reaches parity for daily operations (`10-CONSOLE-DESIGN.md` §6). After retirement it remains installed on `wac-01`, reachable only from a PAW, for genuine break-glass, and its use raises an alert. [Full record](adr/ADR-0033-console-is-primary-wac-retired-at-parity.md).

### ADR-0034: The platform is named Argus

The platform is named **Argus**, a name in the infrastructure register rather than one taken from a business or a place. The identifier prefix is the full word `argus`, never a three-letter abbreviation, because an `arg-` prefix would read as Argo, which ADR-0023 rejects. [Full record](adr/ADR-0034-the-platform-is-named-argus.md).

### ADR-0035: The console as built: an ES5 prototype served by a small Node API

The console is an ES5 classic-script front end served by a dependency-light, read-only Node API with session sign-in. Writes stay in sample mode until the reconciler exists, and ADR-0022's AD FS, AD-group roles and Service Fabric hosting remain the integration targets. Supersedes ADR-0022. [Full record](adr/ADR-0035-the-console-as-built.md).

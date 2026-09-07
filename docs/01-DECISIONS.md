# Architecture decisions

The complete record of **why** Argus is built the way it is. Each decision is an ADR: context, the options weighed, the choice, and what it costs. Decisions are never edited once accepted — they are superseded by a later ADR that says so. `docs/adr/` holds the same entries as individual files for linking.

Status legend: **Accepted** · Proposed · Superseded by ADR-nnnn

| ADR | Decision | Status |
|---|---|---|
| [0001](#adr-0001) | Leave AWS; build a sovereign private cloud on owned hardware | Accepted |
| [0002](#adr-0002) | Windows Server is the platform base, not Linux/Kubernetes | Accepted |
| [0003](#adr-0003) | Two accepted Linux exceptions: the GPU node and the SIEM manager | Accepted |
| [0004](#adr-0004) | Hyper-V + Failover Clustering + Storage Spaces Direct for compute and block storage | Accepted |
| [0005](#adr-0005) | Service Fabric as the application scheduler; guest executables, not containers | Accepted |
| [0006](#adr-0006) | No container registry in v1 | Accepted |
| [0007](#adr-0007) | SeaweedFS for object storage; MinIO retired | Accepted |
| [0008](#adr-0008) | SQL Server stays; PostgreSQL + PostGIS added for geospatial and ML tables | Accepted |
| [0009](#adr-0009) | Garnet for caching (not Redis, not Valkey) | Accepted |
| [0010](#adr-0010) | NATS JetStream for queues and events | Accepted |
| [0011](#adr-0011) | Self-hosted Azure Functions host for serverless jobs | Accepted |
| [0012](#adr-0012) | Active Directory + AD FS for identity; tiered administration | Accepted |
| [0013](#adr-0013) | OpenBao for secrets; AD Certificate Services for PKI | Accepted |
| [0014](#adr-0014) | WDAC + Authenticode: only signed code runs | Accepted |
| [0015](#adr-0015) | IPsec domain isolation for east–west encryption instead of a service mesh | Accepted |
| [0016](#adr-0016) | Caddy + Coraza at the edge, YARP per application | Accepted |
| [0017](#adr-0017) | OPNsense HA pair + CrowdSec as the perimeter | Accepted |
| [0018](#adr-0018) | Sysmon + Windows Event Forwarding + Wazuh as the SIEM | Accepted |
| [0019](#adr-0019) | Prometheus / Grafana / Loki / OpenTelemetry for observability | Accepted |
| [0020](#adr-0020) | Backups: SQL native to object-locked S3, Kopia for files, Hyper-V Replica for VMs, two sites | Accepted |
| [0021](#adr-0021) | Control surface: custom web console + PowerShell CLI + GitOps as the source of truth | Accepted |
| [0022](#adr-0022) | The console is a .NET 10 API + Next.js application on Service Fabric | Accepted |
| [0023](#adr-0023) | GitOps reconciler is a first-party .NET service, not Flux/Argo | Accepted |
| [0024](#adr-0024) | CI on GitHub Actions self-hosted Windows runners; Forgejo mirror for sovereignty | Accepted |
| [0025](#adr-0025) | OpenTofu (Hyper-V provider) + PowerShell DSC v3 for infrastructure as code | Accepted |
| [0026](#adr-0026) | Two sites; Site B holds object-locked backups and a warm SQL replica | Accepted |
| [0027](#adr-0027) | Earth Engine, Anthropic and OpenRouteService stay external, behind an egress proxy | Accepted |
| [0028](#adr-0028) | Local Sentinel-1/2 COG mirror with a STAC index | Accepted |
| [0029](#adr-0029) | ML platform: one Ubuntu GPU node with Ray, MLflow, Dagster; no Kubeflow | Accepted |
| [0030](#adr-0030) | Mobile-app password scheme is frozen; Keycloak is not adopted; AD FS fronts the web | Accepted |
| [0031](#adr-0031) | SQL Server recovery model returns to FULL once log backups exist | Proposed |
| [0032](adr/ADR-0032-browser-rdp-ssh-via-guacamole.md) | Browser RDP/SSH/VM-console via Apache Guacamole, credential-less and recorded | Accepted |
| [0033](adr/ADR-0033-console-is-primary-wac-retired-at-parity.md) | The console is the primary surface; Windows Admin Center retired at C6 parity | Accepted |
| [0034](adr/ADR-0034-the-platform-is-named-argus.md) | The platform is named Argus; `argus` is the identifier prefix, never `arg` | Accepted |

---

## ADR-0001 — Leave AWS; build a sovereign private cloud

**Context.** The Mills dashboard uses two AWS services: one Windows EC2 instance and one S3 bucket for backups (audit of `Mills-Restructured-by-Zayan`, 7 Sep 2026). The ML pipelines use GPU hours wherever they can be found. Data about Pakistani farmers, parcels and loans currently sits in ap-southeast-1.

**Options.** (a) Stay on AWS. (b) Hybrid: local GPUs and storage, AWS for the database. (c) Full exit onto owned hardware.

**Decision.** (c), phased, with (b) as an explicit checkpoint at the end of Phase 3 (`00-MASTER-PLAN.md` §10).

**Why.** The AWS surface is small enough that the exit is a hardware-and-operations project, not a software rewrite. The strongest arguments are capability (GPUs the team actually uses, imagery served locally in seconds instead of pulled over Pakistani bandwidth in hours) and control (data never leaves the country; no dependency on a foreign account that can be suspended). Cost is secondary but favourable over three years.

**Consequences.** The team takes on hardware, power, patching, backup drills and on-call — work AWS did invisibly. Section 9 of the master plan staffs it. If it cannot be staffed, ADR-0001 is amended to (b).

## ADR-0002 — Windows Server is the platform base

**Context.** Two candidate bases were designed: a Linux/Kubernetes platform (Cozystack on Talos) and a Windows-native one. The team's applications are .NET, the critical database is SQL Server, the legacy API is Windows-only, and the team's operational experience is Windows.

**Options.** (a) Cozystack/Talos. (b) Windows Server host with Linux VMs for the platform layer. (c) Windows Server, native, end to end.

**Decision.** (c), chosen by the owner on 8 Sep 2026.

**Why.** One operating system the team already knows, for the hypervisor, the cluster, the identity system, the database and the applications. Microsoft's security primitives (Secure Boot + TPM + System Guard, VBS/Credential Guard, WDAC, Shielded VMs, IPsec domain isolation) are hardware-rooted and shipped in the OS. Service Fabric gives an application scheduler that is native to Windows and runs Azure itself. What Windows gives up against Kubernetes — an immutable OS, fractional GPU sharing, a pre-integrated component set — was judged an acceptable trade, and the GPU gap is closed by ADR-0003.

**Consequences.** More integration work than Cozystack would have required; Datacenter licensing for unlimited VMs and Storage Spaces Direct; a smaller community around Service Fabric than around Kubernetes; no true immutable OS (mitigated by Server Core + WDAC + DSC). The Linux plan is preserved in `docs/adr/superseded/` so it can be revived without re-research.

## ADR-0003 — Two accepted Linux exceptions

**Context.** Two capabilities have no Windows-native implementation worth using: fractional/shared GPU scheduling for ML, and a SIEM manager (Wazuh's manager runs on Linux; only its agents run on Windows).

**Decision.** Exactly two Linux systems, both hardened Ubuntu 24.04 LTS, AD-joined via SSSD, managed through the same GitOps repo: **`gpu-01`** (bare metal, NVIDIA drivers, Ray/MLflow/Dagster) and **`siem-01`** (a Shielded VM on Hyper-V running the Wazuh manager and indexer). OPNsense edge devices are treated as appliances, not servers.

**Why.** Pretending the Wazuh manager can run on Windows would leave the platform without a SIEM. Running the GPU under Hyper-V DDA is possible but loses NVIDIA tooling; bare metal is faster and simpler.

**Consequences.** Two hosts need Linux patching; both are in the platform's Tier 1 and covered by the same Wazuh, backups and IPsec (strongSwan) rules. Any third Linux host requires a new ADR.

## ADR-0004 — Hyper-V + Failover Clustering + Storage Spaces Direct

**Context.** The platform needs compute for VMs (SQL Server, legacy API, SIEM) and block storage that survives a node failure.

**Options.** (a) Hyper-V cluster with S2D (hyper-converged). (b) Hyper-V with a separate SAN. (c) Proxmox.

**Decision.** (a). A 3-node hyper-converged cluster at Site A, growing to 5; ReFS with mirror-accelerated parity; Cluster Shared Volumes; Hyper-V Replica to Site B.

**Why.** Hyper-converged S2D uses the same NVMe/HDD in each node for both compute and storage; no SAN to buy or learn; live migration and automatic VM restart on node loss come with the cluster role. It is the Windows equivalent of EBS + EC2 placement.

**Consequences.** Datacenter edition on every node. S2D needs RDMA-capable NICs (25 GbE, RoCE v2) for full performance — in the BOM. A cluster witness at Site B (file-share witness) so a 2-node loss is handled predictably.

## ADR-0005 — Service Fabric as the application scheduler; guest executables

**Context.** The applications are .NET services (API, gateway, console, functions host) and Node processes (Next.js standalone). They need placement, health-gated rolling upgrades, automatic restart and horizontal scaling — what Kubernetes gives Linux.

**Options.** (a) Service Fabric standalone cluster on Windows Server. (b) HashiCorp Nomad (Windows binary; BSL licence). (c) Windows Containers on Kubernetes worker nodes with a Linux control plane. (d) WinSW/NSSM services per host with a custom supervisor (status quo, scaled).

**Decision.** (a). Service Fabric standalone, 5 nodes (3 seed), applications packaged as **guest executables** (`.sfpkg`), not containers.

**Why.** Service Fabric is MIT-licensed, Windows-native, and runs Azure's own control plane. Its upgrade model — health-checked, rolling, automatic rollback — is exactly what `update.ps1` does by hand today. Guest executables mean the existing self-contained `dotnet publish` output and the Next.js standalone tree deploy as-is: no Dockerfiles, no registry, no container runtime on Windows. Nomad was the runner-up; its BSL licence permits this use but the Windows story is thinner and it brings no stateful-service model.

**Consequences.** The team learns Service Fabric's manifests and health model. Stateful reliable services are available but not used in v1 (state stays in SQL/Postgres/NATS). If Linux containers are ever required, they run on a Linux VM under ADR-0003's amendment process.

## ADR-0006 — No container registry in v1

**Context.** With guest executables (ADR-0005) there are no images to store.

**Decision.** Application packages are signed `.sfpkg` archives stored in the `argus-artifacts` bucket (SeaweedFS, object-locked), addressed by Git commit SHA. Harbor is not deployed.

**Why.** Harbor is Linux-only and would be a third Linux exception with no v1 consumer.

**Consequences.** If containers arrive later, a registry lands on a Linux VM by ADR.

## ADR-0007 — SeaweedFS for object storage; MinIO retired

**Context.** The earlier compose prototype used MinIO. MinIO's community edition was archived in February 2026: no security patches, no prebuilt binaries, and commercial use without an AIStor licence carries legal risk. The workload is 1.16 M survey pictures (many small objects), multi-GB rasters (few large), ~3.2 TB of retained backups.

**Options.** SeaweedFS (Apache-2.0, Windows build, weekly releases, small-object optimised, erasure coding, lifecycle, object lock). Garage (AGPL, geo-distributed, no Windows build). Ceph RGW (Linux only, heavy). RustFS (young).

**Decision.** SeaweedFS at both sites, running as Windows services (WinSW), with async cross-site replication of the `argus-backups` bucket. Buckets: `argus-survey-pictures`, `argus-rasters`, `argus-sentinel`, `argus-artifacts`, `argus-backups`, `argus-ml`.

**Why.** Apache-2.0, native Windows binary, and the many-small-objects design fits the survey pictures exactly. Object-lock (WORM) on `argus-backups` and `argus-artifacts`.

**Consequences.** SeaweedFS's S3 coverage is "good", not MinIO's "excellent": test every client (the .NET S3 SDK, `rclone`, `boto3`, Kopia) in Phase 1. Garage remains an option on `siem-01` for Site B if SeaweedFS replication proves fragile over the site link.

## ADR-0008 — SQL Server stays; PostgreSQL + PostGIS added

**Context.** `umairv3_db` is live under the surveyor mobile apps, uses tuned stored procedures returning multiple result sets, SQL geometry types, and HMAC password hashes shared with the apps. It cannot be migrated as a project prerequisite. The ML pipelines and the parcel/STAC catalogue want a spatial database with an open licence.

**Decision.** SQL Server 2022 Standard in an Always On availability group (primary VM Site A, async secondary Site B). PostgreSQL 17 + PostGIS 3.5 (EDB Windows build) as a second engine for STAC (`pgstac`), classifier feature tables, parcel vector tiles and anything additive OPEN-DECISIONS moves off SQL Server over time.

**Why.** Non-negotiable constraints on one side; licence cost and geospatial tooling (Martin, TiTiler, pgstac are Postgres-native) on the other. Two engines is the honest answer.

**Consequences.** Two backup regimes (ADR-0020). The reporting replica at Site B takes the heavy read queries off the surveyor apps.

## ADR-0009 — Garnet for caching

**Context.** The Mills API holds three in-process caches (boundary, map geometry, report). Scaling to multiple instances needs an external cache. Redis relicensed in 2024; Valkey has no Windows build.

**Decision.** **Microsoft Garnet** (MIT, .NET, RESP-compatible) as a Windows service. Any Redis client works.

**Why.** Native Windows, Microsoft-maintained, faster than Redis on most benchmarks, and the same `StackExchange.Redis` client the .NET code would use anyway.

## ADR-0010 — NATS JetStream for queues and events

**Decision.** NATS server (Apache-2.0, Windows binary) with JetStream, 3-node cluster across the Service Fabric nodes. Subjects: `argus.ingest.*` (shapefile uploads), `argus.export.*`, `argus.ai.*`, `argus.sentinel.scene.landed`, `argus.pipeline.*`.

**Why.** One binary gives pub/sub, durable work queues, key-value and object store; MSMQ is legacy; Kafka is far too heavy for these volumes; RabbitMQ is fine but does not run natively as well on Windows and lacks JetStream's KV.

## ADR-0011 — Self-hosted Azure Functions host

**Context.** Scheduled and event-driven jobs (hourly precompute, 15-day feature tables, exports, harvest-drop detection) currently run as cron or inside a request.

**Decision.** The **Azure Functions host runtime** (MIT), isolated-worker .NET model, deployed as a Service Fabric guest executable per function app, triggered by NATS (custom trigger) and timers. No Azure account involved.

**Why.** Lambda-shaped programming model the .NET team already knows, runs anywhere the host runs, and Service Fabric provides the placement and restarts.

## ADR-0012 — Active Directory + AD FS; tiered administration

**Decision.** A new forest `argus.local` (two DCs at Site A, one at Site B); **AD FS** for OIDC/SAML to the console, Grafana, Windows Admin Center, JupyterHub and the Mills web login; **Windows Hello for Business / FIDO2** for humans; **gMSA** for every service; **LAPS**; **Tier 0/1/2** admin model with Privileged Access Workstations; **JEA** endpoints for operators; NTLM disabled; LDAP signing and channel binding enforced.

**Why.** Included in the Windows licence, the most mature identity system available, and the foundation every other Windows security control (Kerberos-authenticated IPsec, gMSA, Credential Guard) assumes. Keycloak was the Linux plan's choice; on Windows it would duplicate AD.

**Consequences.** The Mills mobile apps keep their HMAC login (ADR-0030); AD FS fronts only the web.

## ADR-0013 — OpenBao for secrets; AD CS for PKI

**Decision.** **OpenBao** (MPL-2.0, Linux Foundation fork of Vault, Windows binary) as a 3-node Raft cluster on the Service Fabric nodes, Shamir 3-of-5 unseal held by three people, audit device to Loki. Dynamic SQL Server and PostgreSQL credentials (1 h TTL), transit engine for PII fields, KV for third-party keys. **AD Certificate Services** (two-tier: offline root, enterprise issuing CA) for machine certificates, IPsec, code signing and the internal TLS chain; external TLS via ACME (Let's Encrypt) at the edge.

**Why.** OpenBao gives dynamic short-lived credentials — the single biggest reduction in credential-theft blast radius — and directly resolves the Mills repo's OPEN-DECISIONS D16 (secrets in git history). AD CS is the native, free PKI that every Windows control expects.

## ADR-0014 — WDAC + Authenticode: only signed code runs

**Decision.** **Windows Defender Application Control** in enforced mode on every server: only code signed by the Argus code-signing certificate (AD CS, key on an HSM or at minimum a TPM-bound cert on the build server) or by Microsoft runs — binaries, DLLs, drivers, PowerShell scripts. CI signs every artefact; `.sfpkg` packages are also signed and verified by the reconciler before deployment. PowerShell Constrained Language Mode everywhere but Tier 0 PAWs.

**Why.** Stronger than container image signing: it covers the whole machine, and it makes most malware, unsigned tooling and living-off-the-land scripts simply fail to execute.

**Consequences.** Every tool the team runs on a server must be signed or catalogued — including third-party binaries (SeaweedFS, NATS, OpenBao, Prometheus), which are catalogued with a Argus-signed catalog file per version. This is real ongoing work and is the reason `platform/policies/wdac/` exists.

## ADR-0015 — IPsec domain isolation instead of a service mesh

**Decision.** Windows Firewall connection-security rules via GPO: all server-to-server traffic inside the platform requires Kerberos (machine) or certificate (AD CS) authentication and AES-GCM encryption; unauthenticated inbound is dropped. Linux exceptions use strongSwan with AD CS certificates. Per-service inbound rules allow only the identities that need to connect (e.g. SQL accepts only the Mills API gMSA and the backup gMSA).

**Why.** This is mTLS-everywhere delivered by the OS at layer 3, with no sidecars and no application changes. Sidecar meshes do not exist for Windows anyway.

## ADR-0016 — Caddy + Coraza at the edge, YARP per application

**Decision.** **Caddy** (Apache-2.0, Windows binary) as the internal edge: ACME certificates, HTTP/3, Brotli, **Coraza** WAF with the OWASP Core Rule Set, rate limiting. Behind it, each application keeps its own **YARP** gateway (the Mills repo already has one). Caddy runs as a Service Fabric guest executable on two nodes with a cluster IP.

**Why.** The Mills gateway currently reads a certificate from the Windows store and terminates TLS itself; centralising TLS and WAF in Caddy lets every app's gateway speak plain HTTP on the isolated network and removes the cert-store dependency (`DEPLOYMENT.md` trap).

## ADR-0017 — OPNsense HA pair + CrowdSec

**Decision.** Two OPNsense appliances per site (CARP failover): perimeter firewall, Suricata IDS/IPS, GeoIP policy, WireGuard site-to-site and admin VPN authenticated against AD via NPS (RADIUS) with MFA, traffic shaping. CrowdSec agents on Caddy and the Windows hosts feed decisions to an OPNsense bouncer.

**Why.** A real perimeter with IDS, which the EC2 security group never was. Appliances are exempt from ADR-0003 because they are not general-purpose hosts.

## ADR-0018 — Sysmon + WEF + Wazuh

**Decision.** Sysmon (SwiftOnSecurity/Olaf Hartong baseline) on every Windows host; Windows Event Forwarding to a collector; Wazuh agents everywhere; Wazuh manager + indexer + dashboard on `siem-01`; PowerShell script-block and module logging; Defender AV with ASR rules and Controlled Folder Access; **Microsoft Security Baselines** + CIS via GPO with Wazuh SCA scoring drift.

**Why.** Detection with evidence: file-integrity monitoring, CIS scoring, ransomware behaviour rules, and ISO 27001 / PCI mappings that an auditor accepts.

## ADR-0019 — Prometheus / Grafana / Loki / OpenTelemetry

**Decision.** Prometheus + `windows_exporter` + `sql_exporter`; Grafana (AD FS login); Loki with Grafana Alloy agents shipping Windows Event Log and application logs; OpenTelemetry Collector receiving traces from the .NET APIs and Next.js; Alertmanager → Apprise → WhatsApp/Telegram/SMS; Uptime Kuma at Site B watching Site A from outside. All have native Windows builds.

## ADR-0020 — Backups

**Decision.** SQL Server: native full nightly + differential 6-hourly + **log every 15 min** (once ADR-0031 lands) to `argus-backups` with `CHECKSUM` and `RESTORE VERIFYONLY`, encrypted, object-locked 35 days at Site A, replicated to Site B and locked 90 days. PostgreSQL: pgBackRest (Windows via WSL is not allowed — use `pg_basebackup` + WAL archiving to S3 via the `wal-g` Windows build). Files (survey pictures, rasters): Kopia (Windows) content-addressed, encrypted. VMs: Hyper-V Replica to Site B (5-min RPO) + weekly Windows Server Backup of hosts. The backup gMSA has `PUT` but never `DELETE` on the buckets. **Restore drill monthly, DR drill quarterly**, reports signed and committed to `docs/runbooks/drills/`.

**Why.** Ransomware and destructive insiders are threat #1; immutability at a second site under different credentials is the only control that fully answers it.

## ADR-0021 — Control surface

**Decision.** Three surfaces, one truth: a **web console** for operators and mill staff; a **PowerShell module (`Argus`) and thin `argus` CLI** for engineers; a **GitOps repository** (`platform/gitops/`) that is the only writer of production state. The console and CLI call the same console API; the console API writes to Git and the reconciler applies Git. Direct changes to production outside the reconciler are denied by WDAC/JEA and alerted by Wazuh. Owner's choice, 8 Sep 2026.

## ADR-0022 — The console is .NET 10 + Next.js on Service Fabric

**Decision.** `platform/console/`: a .NET 10 minimal API (`Argus.Console.Api`) and a Next.js 16 front end, deployed as a Service Fabric application, authenticated by AD FS, authorised by AD groups mapped to console roles. Day one, before parity: Windows Admin Center for raw host management and Grafana for observability, both behind AD FS.

**Why.** The same stack that runs the Mills dashboard on the same Windows server today; the team's design system, testing habits and Claude Code plugins apply unchanged.

## ADR-0023 — First-party GitOps reconciler

**Decision.** `Argus.Reconciler`, a .NET Service Fabric stateful service: polls the GitOps repo, verifies commit signatures, diffs desired vs actual (Service Fabric apps, Hyper-V VMs via WMI, SeaweedFS buckets, OpenBao policies, GPO links via DSC), applies in dependency order, reports status to the console and Grafana.

**Why.** Flux and Argo are Kubernetes-only. The reconciler is ~2,000 lines of C# against APIs the team already knows, and it is the single most important piece of the platform: it is what makes "Git is the truth" true.

## ADR-0024 — CI on GitHub Actions self-hosted Windows runners; Forgejo mirror

**Decision.** GitHub stays the collaboration surface; self-hosted runners (Windows, WDAC-compliant, no internet except allow-listed) build, test, sign and upload `.sfpkg` to `argus-artifacts`. Forgejo (Windows binary) mirrors every repo and can run the same workflows if GitHub is unreachable.

## ADR-0025 — OpenTofu + DSC v3 for IaC

**Decision.** OpenTofu with the Hyper-V provider defines VMs; PowerShell DSC v3 configures Windows hosts and VMs (roles, features, WDAC policy, GPO membership, WinSW services); the reconciler drives both.

## ADR-0026 — Two sites

**Decision.** Site A (primary, Lahore) and Site B (a second building or a Karachi colocation rack, owner decision pending in `08-OPEN-QUESTIONS.md`): 2 nodes, Hyper-V Replica target, SQL async secondary, SeaweedFS replica with 90-day object lock, third domain controller, Uptime Kuma, cluster witness. RTO ≤ 8 h for full Site A loss.

## ADR-0027 — External services behind an egress proxy

**Decision.** Google Earth Engine, the Anthropic API and OpenRouteService remain external. All egress from the platform goes through an allow-listing proxy (Caddy forward-proxy or OPNsense) with keys held in OpenBao and injected at runtime; no host has general internet access. OpenRouteService is self-hosted with the Pakistan OSM extract in Phase 3 (Java, runs on Windows), removing the 2,000/day quota.

## ADR-0028 — Local Sentinel mirror + STAC

**Decision.** Sentinel-1 GRD and Sentinel-2 L2A for the Punjab and Sindh AOIs pulled via `eodag` from the Copernicus Data Space, converted to COGs, stored in `argus-sentinel`, indexed in `pgstac` on PostgreSQL. TiTiler (Python, Windows) serves dynamic raster tiles; Martin (Rust, Windows build) serves parcel vector tiles from PostGIS.

**Why.** The single largest performance change available: pipelines stop pulling scenes over Pakistani bandwidth on every run, and the dashboard map stops shipping megabyte GeoJSON.

## ADR-0029 — ML platform on one GPU node

**Decision.** `gpu-01`: Ubuntu 24.04, 2 × NVIDIA L40S, Ray (head + workers on the same box), MLflow (artefacts to `argus-ml`), Dagster (asset graphs for the v5 classifier feature tables and the SegFormer/HRNet pipelines), JupyterHub with AD FS login. No Kubeflow, no KServe: inference endpoints are Ray Serve behind Caddy.

**Why.** The team's pipelines are Colab notebooks and Python scripts today; Ray + Dagster is the smallest step up that gives scheduling, lineage and resumability. Fractional GPU sharing is by Ray's resource accounting, not by the OS — adequate for a two-GPU box.

## ADR-0030 — Mobile-app password scheme frozen; AD FS fronts the web

**Context.** `DECISIONS.md` in the Mills repo: passwords are HMAC-SHA512, written and read in the legacy scheme, shared with the surveyor apps; a rehash locks the apps out.

**Decision.** The Mills API keeps minting its own JWTs for the mobile apps. The web login moves to AD FS (OIDC) in Phase 2; the API accepts either token type, scoped by the same `VendorId` guards. When the mobile apps next release, they adopt OIDC PKCE against AD FS and the HMAC table is frozen (no new writes).

## ADR-0031 — SQL Server back to FULL recovery *(Proposed)*

**Context.** `umairv3_db` was moved to SIMPLE recovery outside the Mills project in Aug 2026 because the log had grown to 466 GB with no log backups. The owner's standing ruling (D14) was FULL.

**Proposal.** Once ADR-0020's 15-minute log backups are running and proven for two weeks, return to FULL. This restores point-in-time recovery (RPO 15 min instead of "last full"). Requires the owner's ruling because D14 was ruled three times.


## ADR-0032 — Browser RDP/SSH/VM-console via Apache Guacamole

Full text: [`adr/ADR-0032-browser-rdp-ssh-via-guacamole.md`](adr/ADR-0032-browser-rdp-ssh-via-guacamole.md).

**Decision.** Apache Guacamole (Apache-2.0, clientless HTML5 gateway for RDP/SSH/VNC) on `guac-01`, embedded in the console's Connect tab. Credentials come from OpenBao as one-time, session-scoped values the operator never sees; every session is time-boxed and recorded to the object-locked `argus-sessions` bucket. **Amends ADR-0003: three Linux exceptions, not two.**

## ADR-0033 — The console is primary; Windows Admin Center retired at parity

Full text: [`adr/ADR-0033-console-is-primary-wac-retired-at-parity.md`](adr/ADR-0033-console-is-primary-wac-retired-at-parity.md).

**Decision.** WAC is a bootstrap and break-glass tool, retired from daily use when console stage C6 lands. Grafana is not retired — the console embeds and links to it rather than rebuilding it.

## ADR-0034 — The platform is named Argus

Full text: [`adr/ADR-0034-the-platform-is-named-argus.md`](adr/ADR-0034-the-platform-is-named-argus.md).

**Decision.** The platform is **Argus**, not ZD Cloud — a name of its own, separate from the company that owns it. The identifier prefix is the full word `argus` everywhere, deliberately not `arg`, because ADR-0023 rejects Argo and a three-letter prefix would read as it. Zaraat Dost remains the company and `zaraatdost.pk` remains the domain.

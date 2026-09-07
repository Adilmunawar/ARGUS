# ZD Cloud: Master Implementation Plan

**A sovereign, self-hosted cloud platform for Zaraat Dost, built from the best open-source infrastructure on GitHub, replacing AWS end to end.**

Prepared 7 September 2026 for Zaraat Dost (Pvt.) Ltd.

---

## 0. Read this first

Three things frame every decision in this plan and belong before it.

**"All of AWS" is the wrong target.** AWS has ~240 services. Zaraat Dost uses, on an audit of the Mills repository and the ML pipelines, about **14 capability areas**. A platform that tries to replicate 240 services is a platform that ships in never. A platform that replicates the 14 you use, brilliantly, with room to add the next 10, ships in a quarter and is *more* robust because there is less of it to fail. This plan targets the 14, and is designed so the 15th is an afternoon of YAML rather than a project.

**"Most advanced" has to mean something measurable.** This plan is written against numbers, not adjectives:

| Property | Target |
|---|---|
| Recovery Point Objective (max data loss) | ≤ 15 min for databases, ≤ 1 h for object storage |
| Recovery Time Objective (time to restore service) | ≤ 1 h single-node failure (automatic), ≤ 8 h full-site loss |
| Availability of the public dashboards | 99.9 % monthly (≤ 44 min downtime) |
| Blast radius of any one compromised credential | one namespace, one tenant, ≤ 1 h TTL |
| Time from `git push` to production | < 10 min, with a signed, scanned, policy-checked image |
| Time to provision a new database / bucket / service | < 5 min, self-service, no ticket |

If a component in this plan does not move one of those numbers, it is not in this plan.

**The operational burden is real and must be staffed.** AWS's price includes people you never see: the ones replacing disks at 3 a.m. and patching hypervisors. Getting off AWS means hiring or training for that. Section 9 is honest about it. If that section is not acceptable, the right plan is a *hybrid* (Section 10), not a full exit.

One correction to the earlier compose file, which used MinIO. **MinIO's community edition was archived in February 2026**: no more security patches, no prebuilt binaries, and commercial use without an AIStor licence is a legal exposure. This plan uses SeaweedFS instead and treats MinIO as retired.

---

## 1. What Zaraat Dost actually needs

Derived from the Mills dashboard repo, the loan app, AGIS, the Expo mobile app, and the geospatial ML pipelines.

| # | Capability | AWS name | Today | Volume / shape |
|---|---|---|---|---|
| 1 | Run long-lived services (.NET API, Next.js, YARP) | EC2 / ECS | One Windows EC2 box | 3 processes; small |
| 2 | Run Windows workloads (SQL Server, legacy LandSurveyApp) | EC2 Windows | Same box | Must survive the migration |
| 3 | Relational DB, geometry-capable | RDS | SQL Server `umairv3_db`, live under mobile apps | Single most critical asset |
| 4 | Object storage: survey photos, GeoTIFFs, Sentinel tiles, backups | S3 | `zd-daily-db-backups` bucket + local disk | **1.16 M** survey pictures (many small objects) + multi-GB rasters (few large) + ~3.2 TB retained backups |
| 5 | Backups with off-site copy | AWS Backup / S3 | Twice-daily to S3 | SIMPLE recovery → restore-to-last-full only |
| 6 | TLS termination, routing, one public door | ALB / CloudFront / ACM | YARP + Sectigo cert in Windows store | One origin, port 8443 |
| 7 | Human identity, MFA, roles (SuperAdmin, vendor scoping) | Cognito / IAM | JWT minted by the API, HMAC passwords shared with mobile apps | Cannot rehash passwords (mobile apps share the table) |
| 8 | Secrets (JWT keys, DB creds, Anthropic/ORS/GEE keys) | Secrets Manager / KMS | `appsettings.Local.json` + env vars; old secrets in git history | D16 rotation pending |
| 9 | GPU training + batch inference (SegFormer-B5, XGBoost v5 series) | SageMaker / EC2 GPU | Wherever you can get a GPU | Periodic, bursty, large rasters |
| 10 | Scheduled + event-driven pipelines (15-day Sentinel features, precompute) | Lambda / EventBridge / Step Functions | Cron and scripts | Recurring, must not silently fail |
| 11 | Queues / async work (shapefile ingest, exports, AI briefings) | SQS / SNS | Synchronous in the API | Rate-limited heavy admin ops |
| 12 | Cache | ElastiCache | In-process (192 MB geometry cache, etc.) | Small |
| 13 | Logs, metrics, traces, alerts | CloudWatch | WinSW log files | Nothing centralised |
| 14 | CI/CD, container registry, code hosting | CodePipeline / ECR / CodeCommit | GitHub + `package.ps1` / `update.ps1` | GitHub stays; build/deploy moves in-house |

Not on this list, because it will not be replaced: **Google Earth Engine** (crop monitoring), **Anthropic API** (Zaraat Dost AI), **OpenRouteService** (routing). Section 8 covers what "sovereign" means for those.

---

## 2. Reference architecture

### 2.1 The one-line answer

**Cozystack** as the platform substrate, on **Talos Linux**, on your own servers, in **two sites**, with a curated set of operators on top.

Cozystack is a CNCF Sandbox project that turns bare-metal servers into a private cloud: managed Kubernetes clusters, virtual machines, databases, object storage, load balancers and GPU workloads, from one Kubernetes-native REST API. v1.6.0 shipped in July 2026 with Talos-based tenant workers, tenant-controlled OIDC, a SecurityGroup firewall API and hierarchical quotas. It is the closest thing on GitHub to "AWS on your metal", and, critically, every piece inside it is standard upstream (Talos, KubeVirt, FluxCD, VictoriaMetrics, LINSTOR/Blockstor, Cilium/Kube-OVN), so if the project ever stalled you would keep running the same components without it.

Why not OpenStack? It *is* the traditional "private AWS", and it is enormous: a dozen interlocking services, a specialist ops team, and a Kubernetes-on-top story you would still have to build. For a team your size it is the wrong bet.

Why not plain Proxmox + k3s? Perfectly viable, and it is the fallback (2.4). But you would be hand-integrating 25 components that Cozystack has already integrated and tested together for hosting providers. Assembly is where private clouds die.

### 2.2 Topology

```
                         INTERNET
                            │
              ┌─────────────┴─────────────┐
              │  Edge: OPNsense HA pair   │  ← firewall, IDS (Suricata), WireGuard,
              │  + CrowdSec               │    GeoIP, DDoS shaping
              └─────────────┬─────────────┘
                            │
   ┌────────────────────────┴───────────────────────────────────────────┐
   │  SITE A, Lahore (primary)                                          │
   │                                                                      │
   │   ┌──────────────── Cozystack management cluster (Talos) ─────────┐ │
   │   │  3 × control-plane/storage nodes    1-2 × GPU nodes            │ │
   │   │                                                                 │ │
   │   │  Tenant: zd-prod ─────┐  Tenant: zd-ml ──────┐  Tenant: zd-dev │ │
   │   │   • Mills API/Web/GW  │   • Ray cluster       │   • per-branch  │ │
   │   │   • Loan app          │   • JupyterHub        │     previews    │ │
   │   │   • AGIS              │   • KServe endpoints  │   • ephemeral   │ │
   │   │   • SQL Server (VM)   │   • Dagster           │     DBs         │ │
   │   │   • Legacy LandSurvey │   • MLflow            │                 │ │
   │   │     (VM, until D22)   │   • STAC + TiTiler    │                 │ │
   │   └─────────────────────────────────────────────────────────────────┘ │
   │                                                                      │
   │   Shared platform services (system tenant):                          │
   │   Keycloak · OpenBao · Harbor · Forgejo · SeaweedFS (S3) ·           │
   │   CloudNativePG · NATS · Valkey · VictoriaMetrics · Loki · Grafana · │
   │   Kyverno · Falco · Trivy · Wazuh · Velero · cert-manager · Cilium   │
   └──────────────────────────────┬───────────────────────────────────────┘
                                  │  WireGuard site-to-site (encrypted, always on)
   ┌──────────────────────────────┴───────────────────────────────────────┐
   │  SITE B: DR (different building / city)                             │
   │   1-2 nodes · Garage (S3, object-locked) · warm SQL Server replica · │
   │   Velero/pgBackRest targets · can boot zd-prod from backup in ≤ 8 h  │
   └──────────────────────────────────────────────────────────────────────┘
```

### 2.3 Layer map with chosen repositories

Every row: the AWS service it replaces, the GitHub project, why this one over the alternatives, and the licence (because 2023-2026 taught everyone that licences change).

#### Layer 0: Host OS and virtualisation

| Need | Choice | Why | Licence |
|---|---|---|---|
| Node OS | **siderolabs/talos** | Immutable, API-only Linux built for Kubernetes. No SSH, no shell, no package manager: the attack surface of a router. Secure Boot + TPM-backed disk encryption. Upgrades are atomic and rollback-able. | MPL-2.0 |
| VMs for Windows (SQL Server, legacy API) | **kubevirt/kubevirt** (bundled in Cozystack) | Windows VMs scheduled beside containers on the same cluster, same storage, same network policy, same backups. | Apache-2.0 |
| Fallback hypervisor (Option B only) | **proxmox** | If Cozystack is rejected in the pilot, Proxmox VE + Talos VMs is the conservative path. | AGPL-3.0 |

#### Layer 1: Networking and edge

| Need | Choice | Why | Licence |
|---|---|---|---|
| Edge firewall / router | **opnsense/core** | HA pair (CARP), Suricata IDS/IPS, WireGuard, GeoIP blocking, traffic shaping. Replaces the EC2 security group *and* the missing perimeter. | BSD-2 |
| Collaborative threat intel | **crowdsecurity/crowdsec** | Bans IPs seen attacking anyone in the network; feeds OPNsense. Replaces AWS WAF's reputation lists. | MIT |
| CNI, network policy, encryption | **cilium/cilium** | eBPF datapath (fastest CNI), L3-L7 NetworkPolicy, WireGuard node-to-node encryption, Hubble flow observability. Every "who talked to whom" question answerable. | Apache-2.0 |
| Load balancer IPs on bare metal | **metallb/metallb** or Cozystack's built-in | Replaces ALB/NLB at L4. | Apache-2.0 |
| Ingress / API gateway | **envoyproxy/gateway** (Gateway API) | Envoy is what AWS ALB and most service meshes are built on. HTTP/3, rate limiting, JWT validation at the edge, WAF via Coraza. | Apache-2.0 |
| WAF | **corazawaf/coraza** | OWASP CRS engine, embeds in Envoy. Replaces AWS WAF. | Apache-2.0 |
| Certificates | **cert-manager/cert-manager** + **smallstep/certificates** (internal CA) | Let's Encrypt at the edge; a private ACME CA for every internal service. Replaces ACM. Also solves the Windows-cert-store problem in the gateway. | Apache-2.0 |
| Admin / developer access | **juanfont/headscale** (self-hosted Tailscale control plane) | Identity-bound WireGuard mesh. No VPN appliance, no open ports for admin. Replaces bastion hosts + Session Manager. | BSD-3 |

#### Layer 2: Storage

| Need | Choice | Why | Licence |
|---|---|---|---|
| Block storage (EBS) | **Cozystack Blockstor / LINSTOR** (bundled) or **rook/rook** (Ceph) | Blockstor: LVM/ZFS backends, DRBD replication, LINSTOR-compatible API, open-sourced by the Cozystack team in 2026. Choose Rook-Ceph only if you go past ~6 nodes or need unified block+file+object from one system. | Apache-2.0 |
| Object storage (S3): primary | **seaweedfs/seaweedfs** | Apache-2.0, ~30 K stars, weekly releases, purpose-built for **many small objects** (your 1.16 M survey pictures are exactly its sweet spot), S3 API + lifecycle policies + erasure coding for warm data, mature Helm chart. | Apache-2.0 |
| Object storage (S3): DR site | **deuxfleurs-org/garage** | Designed for small clusters over unreliable links, built-in multi-site replication, tiny resource footprint. The ideal off-site target. | AGPL-3.0 (fine: you are not distributing it) |
| Shared POSIX filesystem (EFS) | **CephFS** via Rook, or SeaweedFS FUSE mount | For the legacy `C:\IIS_Deployments\TempLocationSurvey` path pattern until the app writes to S3 directly. | LGPL / Apache-2.0 |
| Kubernetes backup (AWS Backup) | **vmware-tanzu/velero** | Snapshots PVs + manifests to S3 (SeaweedFS → Garage). Restore a whole namespace. | Apache-2.0 |
| File-level backup engine | **kopia/kopia** (or **restic/restic**) | Deduplicated, encrypted, content-addressed. Used by Velero under the hood and directly for the survey-picture tree. | Apache-2.0 / BSD-2 |

**Object-lock everywhere backups land.** Both SeaweedFS and Garage support WORM / object-lock semantics. Backups are written by a credential that can `PUT` but never `DELETE`. Ransomware that gets the API's credentials cannot touch yesterday's backup.

#### Layer 3: Data services

| Need | Choice | Why | Licence |
|---|---|---|---|
| PostgreSQL + PostGIS (RDS) | **cloudnative-pg/cloudnative-pg** | The best Postgres operator: streaming replicas, automatic failover, pgBackRest-style WAL archiving to S3 (RPO seconds), point-in-time restore, declarative. PostGIS image included. This becomes the home for parcels, mauzas, classifier feature tables, STAC catalogue. | Apache-2.0 |
| SQL Server (RDS for SQL Server) | **SQL Server 2022 on a KubeVirt Windows VM**, Always On availability group to Site B | Non-negotiable for `umairv3_db` today (procs, geometry, HMAC passwords shared with mobile apps). Licence: Standard edition per core, or Developer for non-prod. Long-term: migrate additive tables to PostGIS as OPEN-DECISIONS rule them. | Proprietary |
| Cache (ElastiCache) | **valkey-io/valkey** | The Linux Foundation fork of Redis after the 2024 relicensing. Drop-in. Externalise the API's three in-process caches so pods become stateless and can scale horizontally. | BSD-3 |
| Queue / streaming (SQS, SNS, EventBridge) | **nats-io/nats-server** (JetStream) | One binary: pub/sub, durable queues, key-value, object store, request-reply. Far lighter than Kafka, far more capable than RabbitMQ. Shapefile ingests, exports and AI briefings become async jobs. | Apache-2.0 |
| Analytics DB (Redshift / Athena) | **ClickHouse/ClickHouse** | Column store for season-over-season harvest analytics, surveyor productivity, per-parcel time series of Sentinel indices. Sub-second over billions of rows. | Apache-2.0 |
| Lakehouse (optional, Glue/Athena) | **apache/iceberg** tables on SeaweedFS + **trinodb/trino** | Only if the ML feature tables outgrow Postgres. Defer. | Apache-2.0 |

#### Layer 4: Identity, secrets, trust

| Need | Choice | Why | Licence |
|---|---|---|---|
| Human identity, SSO, MFA (Cognito, IAM users) | **keycloak/keycloak** | CNCF, OIDC + SAML, TOTP/WebAuthn/passkeys, fine-grained roles, user federation. Every dashboard, Grafana, Harbor, Forgejo, JupyterHub logs in through it. The Mills API keeps minting its own JWTs for the mobile apps (the password-scheme constraint) but validates Keycloak tokens for the web, a bridge, not a rewrite. | Apache-2.0 |
| Secrets, encryption keys, PKI (Secrets Manager, KMS, ACM Private CA) | **openbao/openbao** | Linux Foundation, MPL-2.0 fork of Vault, API-compatible; v2.6 (Aug 2026) added per-namespace sealing. Dynamic short-lived DB credentials (no more `sa`), transit encryption for the survey pictures, auto-unseal with the TPM. Directly resolves OPEN-DECISIONS D16. | MPL-2.0 |
| Secrets → Kubernetes | **external-secrets/external-secrets** | Syncs OpenBao into Secrets; apps never see OpenBao directly. | Apache-2.0 |
| Secrets in Git (for GitOps) | **getsops/sops** + **FiloSottile/age** | Encrypted config committed safely. Never again a `sa` password in git history. | MPL-2.0 / BSD-3 |
| Workload identity (IAM roles for services) | **spiffe/spire** (phase 5, optional) | Cryptographic identity for every pod; mTLS without shared secrets. | Apache-2.0 |
| Password manager for the team | **dani-garcia/vaultwarden** | Bitwarden-compatible server. Humans stop putting keys in WhatsApp. | AGPL-3.0 |

#### Layer 5: Compute, delivery, registry

| Need | Choice | Why | Licence |
|---|---|---|---|
| Serverless functions (Lambda) | **knative/serving** + **knative/eventing** | Scale-to-zero HTTP and event-driven containers. NATS as the event source. Your 15-day Sentinel feature job becomes a function triggered by a "new scene landed" event. | Apache-2.0 |
| Batch / DAG workflows (Step Functions, Batch) | **argoproj/argo-workflows** | Kubernetes-native DAGs with retries, artifacts to S3, GPU steps. The precompute pipeline and the training runs. | Apache-2.0 |
| Container registry (ECR) | **goharbor/harbor** | CNCF graduated. Vulnerability scanning on push (Trivy), image signing, replication to Site B, proxy cache for Docker Hub / ghcr (matters on Pakistani bandwidth). | Apache-2.0 |
| Git hosting mirror + CI runners (CodeCommit / CodeBuild) | **forgejo/forgejo** + Forgejo Actions (GitHub-Actions-compatible) | GitHub remains the source of truth for the public repos; Forgejo mirrors them and runs CI **inside** the private network so builds can reach the private registry, databases and GPUs. Your existing `api-ci.yml` runs unchanged. | MIT |
| Continuous deployment (CodeDeploy) | **fluxcd/flux2** (bundled with Cozystack) or **argoproj/argo-cd** | GitOps: the cluster's state is a Git repo; a merge is a deploy; a revert is a rollback. `update.ps1`'s stop-rename-swap-healthcheck-rollback dance becomes a Kubernetes rolling update with the same health gate. | Apache-2.0 |
| Developer platform portal (optional) | **backstage/backstage** | Service catalogue + golden-path templates once you have > 10 services. Phase 6. | Apache-2.0 |

#### Layer 6: ML and geospatial platform

| Need | Choice | Why | Licence |
|---|---|---|---|
| GPU scheduling (SageMaker instances) | **NVIDIA/gpu-operator** + **Project-HAMi/HAMi** (bundled in Cozystack ≥ 1.4) | Drivers, device plugin, DCGM metrics; HAMi gives fractional GPU sharing so a JupyterHub session does not hog a whole L40S. | Apache-2.0 |
| Distributed training / inference (SageMaker Training) | **ray-project/ray** via **ray-project/kuberay** | Scales SegFormer training and tiled inference over rasters across GPUs and nodes; same code from laptop to cluster. | Apache-2.0 |
| Experiment tracking + model registry (SageMaker Experiments / Model Registry) | **mlflow/mlflow** | v5.x classifier lineage, metrics, artefacts (S3-backed), promotion stages. | Apache-2.0 |
| Model serving (SageMaker Endpoints) | **kserve/kserve** | Autoscaling inference endpoints on Knative; canary rollouts; the parcel classifier as a versioned HTTP endpoint the dashboard calls. | Apache-2.0 |
| Notebooks (SageMaker Studio) | **jupyterhub/zero-to-jupyterhub-k8s** | Keycloak login, per-user GPU quota, S3 mounted. | BSD-3 |
| Pipeline orchestration (Glue / Step Functions for data) | **dagster-io/dagster** | Asset-based: "the 15-day feature table for Kishtawar, season 2026-27" is a versioned asset with lineage, freshness SLAs and alerts when it is stale. Better fit than Airflow for data assets. | Apache-2.0 |
| Satellite catalogue (no AWS equivalent: the sovereign replacement for hitting Copernicus/Earth Engine live) | **stac-utils/stac-fastapi** + **stac-utils/pgstac** | Local STAC index over a mirrored Sentinel-1/2 archive for Punjab and Sindh. Pipelines query "scenes over this AOI in this window" locally. | MIT |
| Raster tiles (no AWS equivalent) | **developmentseed/titiler** | Dynamic COG tiling: NDVI over a mauza rendered on demand for the dashboard map. | MIT |
| Vector tiles from PostGIS | **maplibre/martin** | Parcel boundaries as MVT straight from PostGIS; the map stops shipping megabyte GeoJSON. | Apache-2.0 |
| Sentinel mirror | **CDSE `openeo`/S3 pull via `eodag`** into SeaweedFS as COGs | Pull once, serve forever. On Pakistani bandwidth this alone changes pipeline latency from hours to seconds. | Apache-2.0 |

#### Layer 7: Observability

| Need | Choice | Why | Licence |
|---|---|---|---|
| Metrics (CloudWatch Metrics) | **VictoriaMetrics/VictoriaMetrics** (bundled in Cozystack) | Prometheus-compatible, ~10× less RAM and disk. | Apache-2.0 |
| Logs (CloudWatch Logs) | **grafana/loki** | Labels not full-text index → cheap at volume. Every WinSW log file, every pod, every VM. | AGPL-3.0 |
| Traces (X-Ray) | **grafana/tempo** + **open-telemetry/opentelemetry-collector** | .NET and Next.js both ship OTel natively. See a slow dashboard request across gateway → API → SQL. | AGPL-3.0 / Apache-2.0 |
| Dashboards + alerting | **grafana/grafana** + Alertmanager → **caronc/apprise** | One login (Keycloak). Alerts to WhatsApp / Telegram / SMS: the channels your operations people actually watch. | AGPL-3.0 |
| Synthetic checks (Route 53 health checks) | **louislam/uptime-kuma** at Site B | Watches Site A from the outside. | MIT |
| Status page | **Uptime Kuma** built-in | For mill officers when something is down. | MIT |

#### Layer 8: Security controls

| Need | Choice | Why | Licence |
|---|---|---|---|
| Policy as code (SCPs, Config rules) | **kyverno/kyverno** | "No image without a signature", "no pod as root", "no service without a NetworkPolicy", "no PVC without a backup label". Enforced at admission; violations impossible, not just detected. | Apache-2.0 |
| Runtime threat detection (GuardDuty) | **falcosecurity/falco** | eBPF syscall monitoring: shell in a container, unexpected outbound connection, sensitive file read → alert in seconds. | Apache-2.0 |
| Vulnerability scanning (Inspector) | **aquasecurity/trivy** + **aquasecurity/trivy-operator** | Every image, every node, every IaC file, continuously. Harbor blocks pulls of images above the CVSS threshold. | Apache-2.0 |
| Supply chain (Signer) | **sigstore/cosign** + SBOMs (**anchore/syft**) | Every image signed in CI; Kyverno refuses unsigned images. Provenance for every binary in production. | Apache-2.0 |
| SIEM / host intrusion / compliance (Security Hub) | **wazuh/wazuh** | Agents on the Windows VMs and the edge; file-integrity monitoring; CIS benchmark checks; PCI/ISO mappings. Wazuh is where "advanced security" becomes evidence you can hand an auditor. | GPL-2.0 |
| Kubernetes hardening baseline | **aquasecurity/kube-bench** (CIS) + Talos defaults | Talos ships hardened; kube-bench proves it stays so. | Apache-2.0 |
| DDoS / abuse | CrowdSec + Envoy rate limits + OPNsense shaping | Layered. | - |

#### Layer 9: The AWS Console

| Need | Choice | Why |
|---|---|---|
| Console | **Cozystack dashboard** (schema-driven since 1.4) + **headlamp-k8s/headlamp** | Self-service: a developer creates a Postgres, a bucket, a VM, a tenant Kubernetes from a form or a YAML. |
| CLI / IaC | `kubectl` + **opentofu/opentofu** (MPL-2.0 Terraform fork) for the edge + Site B | Everything reproducible from Git. |
| AI operator | Claude Code with your **zd-deploy** plugin pointed at the GitOps repo | The team already works this way. The platform being declarative is what makes it work. |

---

## 3. Security architecture

The word "advanced" is earned here or nowhere. This is a zero-trust design; the network perimeter is the *last* line, not the first.

### 3.1 Threat model (what we defend against, in priority order)

1. **Ransomware / destructive insider** hitting the database and backups together. → Object-locked, append-only backups at a second site under different credentials (§2.3 L2). Tested restore monthly.
2. **Credential theft** (a leaked `appsettings.Local.json`, a phished operator). → No long-lived credentials exist: OpenBao issues DB credentials with 1 h TTL; Keycloak sessions are MFA-bound; Headscale access is device+identity bound; every secret is revocable in one place.
3. **Compromised container / supply chain.** → Signed images only (cosign + Kyverno), scanned continuously (Trivy), read-only root filesystems, non-root, seccomp/AppArmor via Talos, Falco watching runtime, egress NetworkPolicy default-deny (a compromised pod cannot phone home).
4. **Lateral movement.** → Cilium default-deny between namespaces; every allowed flow is declared and Hubble-logged. SQL Server VM accepts connections only from the API's identity.
5. **Perimeter attack.** → OPNsense + Suricata + CrowdSec + Coraza WAF + Envoy rate limits (the API's own per-IP limiter stays as defence in depth).
6. **Physical theft / seizure of hardware.** → Talos full-disk encryption keyed to TPM; SeaweedFS volumes encrypted at rest; a stolen drive is noise.
7. **Loss of a site** (fire, flood, power, political). → Site B, ≤ 8 h RTO, drilled quarterly.

### 3.2 Controls matrix

| Control | Mechanism | Evidence it is working |
|---|---|---|
| Identity | Keycloak OIDC everywhere, WebAuthn/passkeys mandatory for admin roles, no shared accounts | Keycloak audit log → Loki → Wazuh |
| Secrets | OpenBao dynamic secrets, transit encryption, auto-unseal via TPM, quorum unseal keys held by 3 people | OpenBao audit device → Loki; monthly secret inventory |
| Network | Cilium default-deny, WireGuard node encryption, Envoy mTLS to backends, Headscale for admin | Hubble flow logs; NetworkPolicy coverage report (Kyverno) |
| Workload | Kyverno: signed images, non-root, no privileged, resource limits, required labels | Kyverno policy report; zero `warn` in prod |
| Runtime | Falco rules tuned per workload; shell-in-container pages on-call | Falco → Alertmanager → Apprise |
| Vulnerabilities | Trivy operator; Harbor blocks CVSS ≥ 7 unless waived with expiry | Harbor scan dashboard; waiver register |
| Host | Talos (no SSH, immutable, Secure Boot, TPM disk encryption); Wazuh agents on Windows VMs; CIS via kube-bench | kube-bench weekly; Wazuh FIM alerts |
| Data at rest | LUKS on Talos, SeaweedFS encryption, SQL Server TDE, OpenBao transit for survey photos' PII fields | Key inventory in OpenBao |
| Data in transit | TLS 1.3 at edge (HTTP/3), mTLS internal, WireGuard site-to-site | ssllabs-style check in CI; Hubble |
| Backup | Velero + kopia + pgBackRest + SQL native → SeaweedFS (object-lock 35 d) → Garage Site B (object-lock 90 d). Backup credential can write, never delete. | Monthly restore drill with a signed report |
| Change | GitOps only; no `kubectl apply` from laptops in prod (Kyverno denies non-Flux writers); every change is a reviewed PR | Git history is the change log |
| Audit | Kubernetes audit log + Keycloak + OpenBao + Wazuh → Loki, 1 y retention, at Site B too | Immutable; queryable |
| Incidents | Runbooks in the GitOps repo; on-call rota; blameless post-mortems | Post-mortem register |

### 3.3 The legacy exceptions, handled honestly

- **HMAC-SHA512 passwords shared with the mobile apps** cannot be rehashed (DECISIONS.md). Keycloak fronts the *web*; the API keeps its own login for the *apps*. When the apps get their next release, they move to Keycloak's OIDC PKCE flow and the HMAC table is frozen.
- **`sa` and the old keys in git history** (D16): rotation happens in Phase 2, the day the old API stops needing them; OpenBao holds the new ones and they are never written to disk by a human again.
- **The Windows VMs** are the softest targets. Wazuh agents, no inbound except from the API's identity, no internet egress except Windows Update via a proxy, Veeam-style VM snapshots via Velero + KubeVirt.

---

## 4. Performance architecture

"Fastest and smoothest": where the milliseconds actually go, and what each choice buys.

| Bottleneck today | Change | Expected effect |
|---|---|---|
| Sentinel scenes pulled from Copernicus over Pakistani internet on every run | Local COG mirror in SeaweedFS + STAC index | Pipeline start: hours → seconds; reproducible |
| Multi-MB boundary GeoJSON per page load | Martin vector tiles from PostGIS + TiTiler for rasters + Envoy edge cache | Map first paint: 3-8 s → < 500 ms on office links |
| Three in-process caches pinned to one API instance | Valkey; API becomes stateless; 3 replicas behind Envoy | Horizontal scale; zero-downtime deploys; the hourly precompute no longer competes with requests |
| Sync shapefile ingest / exports blocking a request for minutes | NATS JetStream job queue + Argo Workflows workers | Instant 202 response; progress in the UI; retries |
| Single Windows box for everything | Dedicated NVMe for SQL Server VM, `MultipleActiveResultSets=False` preserved, read replica at Site B for reports | Report queries stop hurting the surveyor apps |
| GPU idle 90 % of the time / unavailable when needed | HAMi fractional sharing + Ray autoscaling + KServe scale-to-zero | Training when you want; inference always warm enough |
| Network | 25 GbE between storage/GPU nodes, 10 GbE elsewhere, Cilium eBPF (no iptables) | Storage-bound jobs saturate NVMe, not the NIC |
| Public edge | HTTP/3 + Brotli at Envoy; static assets cached at edge | Snappier dashboards on mobile data |

---

## 5. Hardware bill of materials

Prices are approximate USD for reference-class hardware as of mid-2026; verify with local vendors (Lahore/Karachi pricing varies ±25 %). Both tiers assume you already have rack space, cooling and a generator.

### Tier 1: Pilot / starter (Site A only, ~3 months to production)

| Qty | Item | Spec | Est. |
|---|---|---|---|
| 3 | Compute/storage nodes | 1U, AMD EPYC 9004 32-core, 256 GB ECC, 2 × 3.84 TB NVMe (OS + hot data), 4 × 20 TB SATA (SeaweedFS warm), 2 × 25 GbE, TPM 2.0, IPMI | $9-12 k each |
| 1 | GPU node | 2U, EPYC 24-core, 256 GB, 2 × NVIDIA L40S 48 GB (or RTX 6000 Ada), 4 × 3.84 TB NVMe, 2 × 25 GbE | $22-28 k |
| 1 | Switch | 48 × 10/25 GbE SFP28 + 4 × 100 GbE (e.g. Mikrotik CRS520 / used Mellanox SN2410) | $3-6 k |
| 2 | Edge firewalls | Small x86 with 4 × 10 GbE for OPNsense HA | $1.2 k each |
| 1 | UPS | 10 kVA online double-conversion + 30 min runtime, NUT-managed graceful shutdown | $5-8 k |
| - | Cabling, PDUs, rails, spares (2 NVMe, 2 HDD, 1 PSU) | | $3 k |
| | **Tier 1 total** | | **≈ $60-80 k** |

### Tier 2: Production + DR (adds to Tier 1 over 6-9 months)

| Qty | Item | Est. |
|---|---|---|
| 2 | Additional compute/storage nodes (Site A → 5, allows two failures) | $20-24 k |
| 1 | Second GPU node | $22-28 k |
| 2 | Site B nodes (compute + 6 × 20 TB, Garage + SQL replica + Velero targets) | $14-18 k |
| 1 | Site B switch, firewall, UPS | $8 k |
| 1 | Dedicated fibre / point-to-point or business ISP at each site | recurring |
| | **Tier 2 total** | **≈ $70-90 k** |

Versus AWS: an equivalent always-on footprint (a Windows EC2, an r6i for SQL, 2 × g5/g6 GPU instances 30 % utilised, 30 TB S3 + egress, backups) runs roughly $4-7 k/month in ap-southeast-1. Tier 1 pays back in ~12-18 months; the GPU nodes pay back fastest because on-demand GPU hours are the most expensive thing AWS sells you.

**Power is the design constraint in Pakistan, not compute.** Budget the UPS and generator interconnect first. Talos and Cozystack tolerate ungraceful power loss (etcd, DRBD, SeaweedFS are all crash-consistent), but SQL Server on a VM does not love it: the NUT-triggered clean shutdown of the Windows VM must be tested before go-live.

---

## 6. Implementation phases

Each phase has an exit criterion. Do not start the next until it is met. Total: **~9 months** to full exit, with AWS turned off at the end of Phase 5, not before.

### Phase 0: Pilot (weeks 1-6)

Goal: prove Cozystack on your hardware, or reject it early for Option B.

- Procure Tier 1. Rack, cable, IPMI reachable over Headscale.
- Install Cozystack via PXE (talos-bootstrap). Three nodes, no GPU yet.
- Create tenants `zd-dev`, `zd-prod`, `zd-ml`. Enable: SeaweedFS, CloudNativePG, KubeVirt, VictoriaMetrics/Grafana, Flux.
- Deploy the earlier `docker-compose.local.yml` stack **as Kubernetes manifests** in `zd-dev`: Mills API/Web/Gateway containers, SQL Server 2022 Developer on a KubeVirt Windows VM from a restored `umairv3_db` copy.
- Stand up Keycloak, OpenBao (auto-unseal via TPM), Harbor, Forgejo mirror of the GitHub repos with Actions runners inside the cluster.
- Run the first-boot checklist from `DEPLOYMENT.md` against the cluster deployment.

**Exit:** Mills dashboard fully usable in `zd-dev` against a restored DB; a `git push` to Forgejo builds, signs, scans and deploys in < 10 min; you can pull a node's power cord and the dashboard keeps serving.

**Decision gate:** if Cozystack fights you (installation, VM networking, storage), switch to Option B (§2.4) before Phase 1. Two weeks of pain is data; six is a mistake.

### Phase 1, Storage and backups (weeks 7-10), *first AWS cost disappears*

- SeaweedFS production buckets: `zd-survey-pictures`, `zd-rasters`, `zd-backups` (object-lock 35 d).
- Migrate the 1.16 M survey pictures and the raster archive into SeaweedFS with `rclone`; keep the legacy path served via a FUSE mount until the API reads S3 natively.
- Point the SQL backup job at SeaweedFS (the `backup-to-minio.sh` logic, retargeted; keep the `RESTORE VERIFYONLY` gate). Add pgBackRest for any Postgres.
- Stand up Site B minimally (one node, Garage, object-lock 90 d). SeaweedFS → Garage replication of `zd-backups`.
- **Restore drill #1:** rebuild `umairv3_db` from Garage at Site B, time it, sign the report.

**Exit:** two independent, object-locked copies of every backup at two sites; drill report on file; `zd-daily-db-backups` on S3 set to read-only.

### Phase 2: Mills dashboard cutover (weeks 11-16)

- Promote the Phase 0 deployment to `zd-prod`. Envoy Gateway with cert-manager (Let's Encrypt) on a new hostname, e.g. `mills.zaraatdost.pk`; keep `zdost.aoserv.com:8443` alive as a redirect for 90 days.
- Externalise caches to Valkey; run 3 API replicas; move the hourly precompute to an Argo CronWorkflow.
- Keycloak fronts the web login; the API validates Keycloak tokens for web sessions, keeps HMAC for mobile.
- Legacy LandSurveyApp API lifted as-is into a KubeVirt VM (D22 says it must survive). Its 5 exports and static assets keep working through the same gateway.
- **Secrets rotation (D16):** new least-privilege SQL logins issued by OpenBao, `sa` disabled, ORS/Anthropic/GEE keys moved into OpenBao, old JWT key retired with the bridge when D1 is ruled.
- Full observability: OTel in the .NET API and Next.js; Loki for every log; SLO dashboards; Alertmanager → WhatsApp.

**Exit:** all dashboard traffic served from Site A for 2 weeks with 99.9 %; the EC2 Windows box is a warm standby only.

### Phase 3: ML and geospatial platform (weeks 15-24, overlaps Phase 2)

- Add the GPU node(s); GPU operator + HAMi.
- JupyterHub, MLflow, Ray/KubeRay, KServe, Dagster in `zd-ml`.
- Sentinel-1/2 mirror for the Punjab and Sindh AOIs as COGs in SeaweedFS; STAC index in CloudNativePG (pgstac); TiTiler and Martin serving the dashboard map.
- Port the v5 classifier pipeline to a Dagster asset graph; SegFormer training as a Ray job; the parcel classifier as a KServe endpoint the dashboard calls.
- The 15-day feature-table job becomes event-driven: new scene in STAC → NATS event → Knative function → Dagster run.

**Exit:** one full season's feature table regenerated end-to-end on-prem, matching the current outputs; training run on the L40S faster than your current best.

### Phase 4: Database and mobile apps (weeks 20-30)

The riskiest phase; it touches the surveyor phones.

- SQL Server Always On: primary in Site A VM, async secondary in Site B VM.
- The mobile apps' next release points at a DNS name you control (not `54.251.99.28`) with a TLS pin; old address kept alive as a TCP forwarder until adoption is > 95 %.
- Reporting queries moved to the Site B replica.
- Begin the PostGIS migration for additive tables as OPEN-DECISIONS rule them; the `ZD_CropShapes`-style satellite tables move first.

**Exit:** no client anywhere references the AWS IP; AWS SQL box powered off for 30 days with no incident.

### Phase 5: DR and the AWS exit (weeks 28-34)

- Site B to full spec. Quarterly DR drill: fail Site A entirely, serve from Site B within 8 h, fail back.
- Decommission AWS: snapshot the EC2 (kept 90 days), delete the bucket after Garage retention proves out, close the account.

**Exit:** signed DR drill report; AWS invoice = $0.

### Phase 6: Hardening and audit (weeks 34-40)

- External penetration test (a Pakistani or regional firm; scope = the public edge + a "assumed breach" internal test).
- Wazuh CIS/ISO 27001 control mapping; write the security policy documents against the evidence Wazuh and Kyverno already produce.
- Backstage or the Cozystack dashboard as the team's single console; golden-path templates for "new service", "new database", "new model endpoint".
- SPIRE for workload identity if the pen test asks for it.

---

## 7. Migration risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `54.251.99.28` hard-coded in deployed mobile apps | High | Surveyor apps break | Phase 4 DNS + forwarder; app release first; adoption metrics before cutover |
| Cozystack is a Sandbox project with a small community | Medium | Slower support | Every component is upstream-standard; Option B exit path; pin versions; test upgrades in `zd-dev` |
| Power quality / load shedding | High | Corruption, downtime | Online UPS, NUT graceful shutdown, generator ATS; all storage crash-consistent; SQL VM shutdown tested |
| Team lacks Kubernetes depth | Medium | Slow Phase 0 | Hire one platform engineer (or contract) for Phases 0-2; the team already uses Claude Code: the GitOps repo is its natural interface |
| SQL Server licensing on-prem | Medium | Cost | Standard per-core for prod, Developer for everything else; plan the PostGIS migration |
| Off-site bandwidth for ~3 TB of backups | Medium | Site B lags | Incremental (kopia/pgBackRest) after the first seed by physical disk; Garage tolerates flaky links by design |
| Earth Engine remains external | Certain | "Sovereign" is partial | Phase 3's local Sentinel mirror + STAC makes 80 % of what GEE does for you local; keep GEE for the rest |
| Windows expertise vs Linux platform | Medium | Two skill sets | KubeVirt keeps Windows first-class; Wazuh covers both |
| Scope creep ("add another service") | High | Never ships | Phase gates with exit criteria; a new service enters through Backstage templates *after* Phase 5 |

---

## 8. What stays external, and what "sovereign" means for each

| Service | Why it stays | Sovereign posture |
|---|---|---|
| Google Earth Engine | Petabyte planetary archive + compute; no local equivalent | Local Sentinel mirror + STAC + TiTiler for everything Punjab/Sindh; GEE only for ad-hoc global queries; key in OpenBao; egress only via an allow-listed proxy |
| Anthropic API (Zaraat Dost AI) | The models are the product | Key in OpenBao; prompts and answers logged to Loki for audit; on-prem inference (vLLM on the L40S) as a fallback tier for the briefing feature if connectivity drops |
| OpenRouteService | 2,000/day quota, external | Self-host **GIScience/openrouteservice** with the Pakistan OSM extract in Phase 3: it is Apache-2.0 and the quota disappears |
| GitHub | Public presence, the team's habit | Forgejo mirror is the build system of record; GitHub outage ≠ deploy outage |

---

## 9. Team, operations, cost of ownership

What AWS was quietly doing for you, and who does it now:

| Responsibility | Effort | Owner |
|---|---|---|
| Platform engineering (Cozystack, Talos, storage, network) | 1 FTE Phases 0-2, then 0.5 | New hire or contractor, then Adil/Zayan |
| On-call for the platform | Rota of 3, one week each | Adil, Zayan, +1 |
| Security operations (Wazuh, Falco, Trivy triage, patching) | 0.25 FTE | Rotating, with Claude Code triage |
| Backup/DR drills | 1 day/month + 2 days/quarter | Platform owner |
| Hardware (disks, PSUs, vendor RMA) | Reactive | Platform owner; keep spares |
| Windows/SQL Server administration | 0.25 FTE | Existing DBA |

**Skill-building plan:** two weeks of Talos + Cozystack hands-on in Phase 0 for the whole team; the GitOps repo *is* the documentation; runbooks live beside the manifests; every incident produces a runbook update. Claude Code, with a `zd-platform` plugin holding the runbooks and cluster conventions, turns "what do I do when Falco fires X" into a five-minute conversation.

**Three-year TCO (rough):** hardware $150 k + one platform FTE $30-45 k/yr locally + power/connectivity $10 k/yr + SQL licences ≈ **$300-350 k** over 3 years, against AWS at $4-7 k/month ≈ $150-250 k *plus* the GPU hours you are currently not buying because they are too expensive. The financial case is decent but not overwhelming; **the real case is capability** (GPUs you actually use, data that never leaves the country, pipelines that run in seconds) **and control**.

---

## 10. If full exit is too much: the hybrid

Do Phases 0-3 and stop. Keep SQL Server and the surveyor apps' endpoint on AWS. You get: local GPUs, local imagery, local S3, local CI, zero-trust security, real observability, and an AWS bill that shrinks by roughly 60 %, without ever touching the phones. Phase 4 can wait a year.

---

## 11. Decisions I need from you

1. **Cozystack vs Option B**: I recommend Cozystack with a hard two-week evaluation gate. Agree?
2. **Site B location**: a second Zaraat Dost office, a partner mill's server room, or a rented rack in a Karachi datacentre? Each is fine; the choice changes the bandwidth plan.
3. **Current AWS monthly spend**: I estimated; the real number sets the payback timeline.
4. **SQL Server licence status on-prem**: do you hold Standard licences, or is this a new purchase?
5. **Who is the platform engineer**: hire, contract, or Adil/Zayan with training time carved out?
6. **Mobile app release cadence**: Phase 4 depends on shipping one release with a new DB endpoint.
7. **Appetite for the hybrid** (§10) as a checkpoint rather than an end state.

---

## Appendix A: Full repository list

| Layer | Repository |
|---|---|
| Platform | github.com/cozystack/cozystack · github.com/siderolabs/talos · github.com/kubevirt/kubevirt · github.com/fluxcd/flux2 |
| Network | github.com/opnsense/core · github.com/crowdsecurity/crowdsec · github.com/cilium/cilium · github.com/metallb/metallb · github.com/envoyproxy/gateway · github.com/corazawaf/coraza · github.com/cert-manager/cert-manager · github.com/smallstep/certificates · github.com/juanfont/headscale |
| Storage | github.com/seaweedfs/seaweedfs · github.com/deuxfleurs-org/garage (mirror of git.deuxfleurs.fr) · github.com/rook/rook · github.com/LINBIT/linstor-server · github.com/vmware-tanzu/velero · github.com/kopia/kopia · github.com/restic/restic |
| Data | github.com/cloudnative-pg/cloudnative-pg · github.com/postgis/postgis · github.com/valkey-io/valkey · github.com/nats-io/nats-server · github.com/ClickHouse/ClickHouse · github.com/apache/iceberg · github.com/trinodb/trino |
| Identity/secrets | github.com/keycloak/keycloak · github.com/openbao/openbao · github.com/external-secrets/external-secrets · github.com/getsops/sops · github.com/FiloSottile/age · github.com/spiffe/spire · github.com/dani-garcia/vaultwarden |
| Delivery | github.com/knative/serving · github.com/knative/eventing · github.com/argoproj/argo-workflows · github.com/argoproj/argo-cd · github.com/goharbor/harbor · codeberg.org/forgejo/forgejo · github.com/backstage/backstage · github.com/opentofu/opentofu |
| ML/geo | github.com/NVIDIA/gpu-operator · github.com/Project-HAMi/HAMi · github.com/ray-project/ray · github.com/ray-project/kuberay · github.com/mlflow/mlflow · github.com/kserve/kserve · github.com/jupyterhub/zero-to-jupyterhub-k8s · github.com/dagster-io/dagster · github.com/stac-utils/stac-fastapi · github.com/stac-utils/pgstac · github.com/developmentseed/titiler · github.com/maplibre/martin · github.com/GIScience/openrouteservice · github.com/CS-SI/eodag · github.com/vllm-project/vllm |
| Observability | github.com/VictoriaMetrics/VictoriaMetrics · github.com/grafana/loki · github.com/grafana/tempo · github.com/grafana/grafana · github.com/open-telemetry/opentelemetry-collector · github.com/caronc/apprise · github.com/louislam/uptime-kuma |
| Security | github.com/kyverno/kyverno · github.com/falcosecurity/falco · github.com/aquasecurity/trivy · github.com/aquasecurity/trivy-operator · github.com/aquasecurity/kube-bench · github.com/sigstore/cosign · github.com/anchore/syft · github.com/wazuh/wazuh |
| Console | github.com/headlamp-k8s/headlamp |

## Appendix B: Option B (if Cozystack is rejected in Phase 0)

Proxmox VE on each node → Talos Linux VMs for Kubernetes → Cilium → Rook-Ceph → the same operators from §2.3 installed by hand via Flux. Proxmox Backup Server replaces Velero for the Windows VMs. Roughly 3-4 extra weeks of assembly in Phase 0; identical from Phase 1 onward.

## Appendix C: What I did not put in, and why

- **Service mesh (Istio/Linkerd):** Cilium's mTLS and L7 policy cover 90 % of the value at 10 % of the complexity. Revisit if you pass 30 services.
- **Kubeflow:** Ray + MLflow + KServe + Dagster is lighter and each piece is best-of-breed; Kubeflow's value is bundling, which Cozystack's tenancy already provides.
- **Kafka/Redpanda:** NATS JetStream covers your event volumes by orders of magnitude; Kafka's operational weight is not justified.
- **OpenStack:** see §2.1.
- **LocalStack:** an emulator for developers; it never belonged in a production plan.

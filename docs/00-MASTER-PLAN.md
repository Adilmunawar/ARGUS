# Argus: Master Plan (Windows-first)

**Version 0.1.0 · 8 September 2026 · supersedes the Linux/Cozystack plan of 7 September (kept in `docs/adr/superseded/`).**

## 1. What we are building

A private cloud, owned and operated by Zaraat Dost, on Windows Server 2025 at two sites in Pakistan, that provides every capability the company currently rents from AWS and several it cannot afford to rent, most importantly GPUs and locally served satellite imagery, with a security posture rooted in hardware and evidenced continuously.

It is **not** a copy of AWS. It is the fourteen capabilities Zaraat Dost uses, built well, on one operating system the team already runs, designed so the fifteenth is a pull request.

## 2. Targets: what "robust", "advanced", "fast" mean here

| Property | Target | Measured by |
|---|---|---|
| RPO, databases | ≤ 15 min | log-backup cadence, restore drill |
| RPO, object storage | ≤ 1 h | SeaweedFS replication lag |
| RTO, single node loss | ≤ 5 min, automatic | Failover Clustering + Service Fabric |
| RTO, full Site A loss | ≤ 8 h | quarterly DR drill |
| Availability, public dashboards | 99.9 % monthly | Uptime Kuma at Site B |
| Blast radius, one leaked credential | one service, one database, ≤ 1 h | OpenBao lease TTL, IPsec per-identity rules |
| Unsigned code executing on any server | 0 | WDAC audit → enforced; Wazuh |
| `git push` → production, signed, scanned, health-gated | < 10 min | CI + reconciler timing |
| New database / bucket / service provisioned | < 5 min, self-service | console |
| Map first paint on office link | < 500 ms | Grafana RUM |
| Sentinel pipeline start | seconds, not hours | local COG mirror |

## 3. Capabilities and their implementation

| # | Capability | AWS | Argus | ADR |
|---|---|---|---|---|
| 1 | Long-lived services | EC2 / ECS | Service Fabric guest executables on the Hyper-V cluster | 0005 |
| 2 | Windows VMs | EC2 Windows | Hyper-V + Failover Clustering, Shielded VMs | 0004 |
| 3 | Relational DB | RDS | SQL Server 2022 Always On; PostgreSQL 17 + PostGIS | 0008 |
| 4 | Object storage | S3 | SeaweedFS, object lock, two sites | 0007 |
| 5 | Backup / DR | AWS Backup | SQL native + wal-g + Kopia + Hyper-V Replica → object-locked S3 at two sites | 0020, 0026 |
| 6 | Edge, TLS, WAF, routing | ALB / CloudFront / WAF / ACM | OPNsense → Caddy + Coraza → per-app YARP; AD CS + ACME | 0016, 0017 |
| 7 | Identity | Cognito / IAM | Active Directory, AD FS, WHfB/FIDO2, gMSA, tiered admin | 0012 |
| 8 | Secrets / KMS / PKI | Secrets Manager / KMS / Private CA | OpenBao + AD CS | 0013 |
| 9 | GPU training & inference | SageMaker | `gpu-01`: Ray, MLflow, Dagster, JupyterHub | 0029 |
| 10 | Scheduled / event-driven jobs | Lambda / EventBridge / Step Functions | Azure Functions host + NATS + Dagster | 0011, 0010 |
| 11 | Queues / events | SQS / SNS | NATS JetStream | 0010 |
| 12 | Cache | ElastiCache | Garnet | 0009 |
| 13 | Observability | CloudWatch / X-Ray | Prometheus, Grafana, Loki, Tempo-less OTel traces in Grafana, Alertmanager → WhatsApp | 0019 |
| 14 | CI/CD, artefacts, code | CodePipeline / ECR / CodeCommit | GitHub Actions self-hosted + Forgejo mirror; signed `.sfpkg` in S3; first-party reconciler | 0024, 0023, 0006 |
| + | Satellite catalogue & tiles | (none) | Sentinel COG mirror, pgstac, TiTiler, Martin | 0028 |
| + | Security ops | GuardDuty / Security Hub / Inspector | Sysmon + WEF + Wazuh, Defender ASR, WDAC, Falco-equivalent via Sysmon rules, kube-bench-equivalent via Wazuh SCA/CIS | 0014, 0018 |
| + | Console | AWS Console | Argus Console (.NET 10 + Next.js) + Windows Admin Center + Grafana | 0021, 0022 |

## 4. Reference topology

```
                                INTERNET
                                    │
             ┌──────────────────────┴──────────────────────┐
             │  OPNsense HA pair (CARP) · Suricata · GeoIP  │
             │  WireGuard S2S + admin VPN (NPS/RADIUS+MFA)  │
             └──────────────────────┬──────────────────────┘
                              DMZ VLAN 20
             ┌──────────────────────┴──────────────────────┐
             │  Caddy ×2 (SF guest exe, cluster IP)         │
             │  ACME · HTTP/3 · Coraza WAF · rate limits    │
             └──────────────────────┬──────────────────────┘
                 IPsec-isolated PLATFORM VLAN 30
 ┌───────────────────────────────────┴────────────────────────────────────────┐
 │  SITE A: Hyper-V + S2D cluster  hv-01 hv-02 hv-03 (→05)   RDMA 25 GbE    │
 │                                                                            │
 │  Service Fabric cluster (5 nodes = 5 Windows Server Core VMs, 1 per host)  │
 │   ├─ argus-console      (API + Next.js)      ├─ mills-api/web/gateway (×3)   │
 │   ├─ argus-reconciler   (stateful)           ├─ loan-api  · agis-web         │
 │   ├─ caddy ×2                             ├─ functions-* (Azure Fn host)  │
 │   ├─ nats ×3 · garnet ×2 · openbao ×3     ├─ titiler · martin · ors       │
 │   └─ prometheus · loki · grafana · otel                                    │
 │                                                                            │
 │  VMs (Shielded, Generation 2, TPM):                                        │
 │   dc-01 dc-02 · adfs-01 · ca-issuing-01 · sql-01 (AG primary)             │
 │   pg-01 (PostGIS) · legacy-landsurvey-01 · seaweed-master/volume ×3       │
 │   wac-01 · wef-01 · siem-01 (Ubuntu, Wazuh) · runner-01/02 (CI)            │
 │                                                                            │
 │  Bare metal: gpu-01 (Ubuntu, 2× L40S); Ray · MLflow · Dagster · Jupyter  │
 └───────────────────────────────────┬────────────────────────────────────────┘
                     WireGuard site-to-site (OPNsense ↔ OPNsense)
 ┌───────────────────────────────────┴────────────────────────────────────────┐
 │  SITE B: hv-b01 hv-b02 · dc-03 · sql-02 (AG async secondary, reporting)   │
 │  seaweed replica (object lock 90 d) · Hyper-V Replica target · witness     │
 │  uptime-kuma · OPNsense pair                                               │
 └────────────────────────────────────────────────────────────────────────────┘
```

Details: hosts and VMs in `02-APPLICATION-INFRASTRUCTURE-MAP.md`; VLANs, addressing and rules in `04-NETWORK-AND-SITES.md`; controls in `03-SECURITY-ARCHITECTURE.md`.

## 5. Principles that every change is tested against

1. **Git is the truth.** Production state is what `platform/gitops/` says. The reconciler is the only writer. Humans open pull requests.
2. **Nothing unsigned runs.** WDAC enforced; every artefact and every commit signed.
3. **No long-lived credentials.** Every service identity is a gMSA or an OpenBao lease. Every human is MFA. Nothing is shared.
4. **Every flow is declared.** IPsec + per-identity firewall rules; default deny east-west.
5. **Backups are immutable and elsewhere.** Two sites, object lock, a credential that cannot delete, drills that are reported.
6. **One OS, three exceptions.** Windows everywhere except `gpu-01`, `siem-01` and `guac-01` (ADR-0003, amended by ADR-0032); a fourth needs an ADR.
7. **Boring is a feature.** Prefer the component with the Windows service installer and ten years of releases over the one with the best benchmark.
8. **Evidence, not assurance.** Every control has a dashboard or a report that shows it is working; "we have MFA" is a Wazuh query, not a sentence.

## 6. Phases: summary

Full detail with exit gates in `06-PHASES-AND-RUNBOOKS.md`.

| Phase | Weeks | Delivers | Exit gate |
|---|---|---|---|
| 0 Foundation | 1-6 | Hardware, AD forest, Hyper-V/S2D cluster, Service Fabric, OpenBao, AD CS, WDAC in audit, Caddy, observability, WAC | Pull a node's power: nothing user-visible happens; `git push` deploys a hello-world SF app in < 10 min |
| 1 Storage & backups | 7-10 | SeaweedFS both sites, survey pictures + rasters migrated, SQL backups to object-locked S3, first restore drill | Two immutable copies of every backup at two sites; signed drill report; AWS bucket read-only |
| 2 Mills cutover | 11-16 | Mills API/web/gateway on SF, Garnet, NATS jobs, AD FS web login, legacy API on a VM, secrets rotated (D16), OTel | 99.9 % for 14 days from Site A; EC2 is a warm standby |
| 3 ML & geo | 15-24 | `gpu-01`, Ray/MLflow/Dagster/JupyterHub, Sentinel mirror + pgstac, TiTiler/Martin, self-hosted ORS, v5 classifier + SegFormer pipelines ported | One season's feature table regenerated on-prem and matching; training faster than current best |
| 4 Database & apps | 20-30 | SQL Always On to Site B, mobile apps repointed to an Argus DNS name, reporting on the replica, first PostGIS migrations | No client references the AWS IP; AWS SQL box off 30 days without incident |
| 5 DR & exit | 28-34 | Site B to full spec, quarterly DR drill, AWS account closed | Signed DR report; AWS invoice $0 |
| 6 Hardening & audit | 34-40 | WDAC enforced everywhere, external pen test, Wazuh ISO 27001 mapping, console at parity with WAC for daily tasks | Pen-test findings closed; audit evidence pack produced from the platform, not by hand |

## 7. What stays external

| Service | Why | Sovereign posture (ADR-0027) |
|---|---|---|
| Google Earth Engine | planetary archive + compute | local Sentinel mirror does the Punjab/Sindh 80 %; GEE via egress proxy for the rest |
| Anthropic API | the models | key in OpenBao; prompts/answers audited to Loki; vLLM on `gpu-01` as a degraded fallback |
| OpenRouteService | quota | self-hosted in Phase 3 |
| GitHub | collaboration | Forgejo mirror is the build system of record |

## 8. Team and operations

| Responsibility | Effort | Owner |
|---|---|---|
| Platform engineering | 1 FTE Phases 0-2, 0.5 after | new hire or contractor, then Adil / Zayan |
| On-call | rota of 3, weekly | Adil, Zayan, +1 |
| Security operations (Wazuh triage, WDAC catalogues, patch Tuesday) | 0.25 FTE | rotating; Claude Code with `zd-security` for triage |
| Backup and DR drills | 1 day/month + 2 days/quarter | platform owner |
| Windows / SQL administration | 0.25 FTE | existing DBA |
| Hardware | reactive; spares on the shelf | platform owner |

## 9. Cost, three years, rough

Hardware ≈ $150 k (both tiers, `07-HARDWARE-AND-LICENSING.md`) · Windows Server Datacenter + SQL Standard + CALs ≈ $35-55 k · one platform FTE locally ≈ $30-45 k/yr · power and connectivity ≈ $10 k/yr. **≈ $330-400 k over three years**, against an AWS estimate of $150-250 k for the *current* footprint plus GPU hours the company is not buying because they are too expensive. The financial case is reasonable; the capability and control case is the reason.

## 10. The hybrid checkpoint

After Phase 3 the company has local GPUs, local imagery, local S3, sovereign CI, hardware-rooted security and real observability, and AWS is down to one Windows box and one SQL Server. Stopping there is a legitimate end state that never touches the surveyor phones. Phase 4 is the decision point, and it is the owner's.

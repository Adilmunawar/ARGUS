# Hardware and licensing

Reference-class hardware, approximate USD, mid-2026; verify with Lahore/Karachi vendors (±25 %). Assumes rack space, cooling and a generator with ATS at Site A.

## Tier 1: Phase 0-2 (Site A + minimal Site B)

| Qty | Item | Spec | Est. |
|---|---|---|---|
| 3 | Hyper-V/S2D nodes | 1U · AMD EPYC 9004 32c · 256 GB DDR5 ECC · 2 × 3.84 TB NVMe (cache) · 4 × 20 TB SATA (capacity) · 2 × 25 GbE **RDMA (RoCE v2)** · TPM 2.0 · IPMI · dual PSU | $10-13 k each |
| 1 | GPU node `gpu-01` | 2U · EPYC 24c · 256 GB · **2 × NVIDIA L40S 48 GB** · 4 × 3.84 TB NVMe · 2 × 25 GbE · dual PSU | $24-30 k |
| 1 | HGS host | small 1U or reused workstation-class server (must be separate metal) | $2 k |
| 1 | Core switch | 48 × 25 GbE SFP28 + 4 × 100 GbE, PFC/ECN capable (e.g. Mikrotik CRS520, used Mellanox SN2410) | $3-6 k |
| 2 | OPNsense appliances | x86, 4 × 10 GbE SFP+, 16 GB | $1.2 k each |
| 1 | UPS Site A | 10 kVA online, 30 min, network card | $5-8 k |
| 2 | PAW laptops + 4 FIDO2 keys | | $3 k |
| 1 | YubiHSM 2 (CA + code-signing keys) | recommended | $0.7 k |
| - | Cabling, PDUs, rails, spares (2 NVMe, 2 HDD, 1 PSU, 1 NIC) | | $4 k |
| **Site B minimal** | | | |
| 1 | Hyper-V node `hv-b01` | as Site A but 6 × 20 TB | $12-14 k |
| 2 | OPNsense appliances | | $2.4 k |
| 1 | UPS 5 kVA | | $2.5 k |
| | **Tier 1 total** | | **≈ $85-110 k** |

## Tier 2: Phase 3-5

| Qty | Item | Est. |
|---|---|---|
| 2 | Additional Site A nodes (→ 5; survives two failures; S2D three-way mirror option) | $20-26 k |
| 1 | Second GPU node or 2 more L40S in `gpu-01` if the chassis allows | $15-28 k |
| 1 | `hv-b02` + second Site B switch | $15 k |
| - | Dedicated 100 Mbps-1 Gbps link between sites; second ISP each site | recurring |
| | **Tier 2 total** | **≈ $55-75 k** |

## Licensing (list prices; Pakistan reseller pricing and any NGO/education programmes may differ: check)

| Item | Need | Approx. |
|---|---|---|
| Windows Server 2025 **Datacenter** | S2D and unlimited VMs require Datacenter; licensed per physical core, 16-core minimum per host. 3 hosts × 32 cores (Phase 0) → 5 hosts | ~$6.2 k per 16-core pack list → ~$37 k for 96 cores; ~$62 k at 5 hosts (negotiate) |
| Windows Server CALs | one per user or device accessing Windows services (AD, file); ~40 staff | ~$50 each → $2 k |
| SQL Server 2022 **Standard**, per core | `sql-01` 16 vCPU → 8 two-core packs; `sql-02` as a passive/DR replica is free under Software Assurance, otherwise licensed | ~$3.9 k per 2-core pack → ~$31 k (+ SA for the free DR replica) |
| SQL Server Developer | all non-production, free | $0 |
| Windows Admin Center, AD, AD FS, AD CS, HGS, DSC, Hyper-V, Failover Clustering, S2D | included in Datacenter | $0 |
| Service Fabric, Azure Functions host, Garnet, YARP | MIT | $0 |
| OpenBao, SeaweedFS, NATS, Caddy, Coraza, Prometheus, Grafana, Loki, OTel, Wazuh, Sysmon, Kopia, wal-g, Forgejo, OpenTofu, Ray, MLflow, Dagster, JupyterHub, TiTiler, Martin, pgstac, ORS | open-source (Apache/MIT/MPL/GPL/AGPL-server-side) | $0 |
| NVIDIA drivers/CUDA for L40S | no vGPU licence needed for bare-metal Linux | $0 |
| OPNsense | free; optional business edition support | $0-1 k |
| GitHub Team (existing) + self-hosted runner minutes | free for self-hosted | existing |

**Licensing total ≈ $70-100 k one-off** (dominated by Windows Datacenter + SQL Standard). This is the real cost of the Windows-first decision versus the Linux plan and is recorded in ADR-0002's consequences. Options that reduce it: Windows Server Standard on the SF-node-only hosts if S2D is confined to three hosts (Standard cannot run S2D but *can* be a cluster member for compute), and negotiating Software Assurance for the free DR SQL replica.

## Three-year total (both tiers)

Hardware ≈ $140-185 k · licences ≈ $70-100 k · platform FTE ≈ $90-135 k · power/connectivity ≈ $30 k → **≈ $330-450 k**. AWS estimate for the *current* footprint ≈ $150-250 k over the same period: which buys no GPUs, no local imagery, no sovereignty. The delta is the price of capability; the owner decides whether it is worth it (`08-OPEN-QUESTIONS.md` Q3).

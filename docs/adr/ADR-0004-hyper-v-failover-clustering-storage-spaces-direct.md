# ADR-0004: Hyper-V + Failover Clustering + Storage Spaces Direct

**Context.** The platform needs compute for VMs (SQL Server, legacy API, SIEM) and block storage that survives a node failure.

**Options.** (a) Hyper-V cluster with S2D (hyper-converged). (b) Hyper-V with a separate SAN. (c) Proxmox.

**Decision.** (a). A 3-node hyper-converged cluster at Site A, growing to 5; ReFS with mirror-accelerated parity; Cluster Shared Volumes; Hyper-V Replica to Site B.

**Why.** Hyper-converged S2D uses the same NVMe/HDD in each node for both compute and storage; no SAN to buy or learn; live migration and automatic VM restart on node loss come with the cluster role. It is the Windows equivalent of EBS + EC2 placement.

**Consequences.** Datacenter edition on every node. S2D needs RDMA-capable NICs (25 GbE, RoCE v2) for full performance, in the BOM. A cluster witness at Site B (file-share witness) so a 2-node loss is handled predictably.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

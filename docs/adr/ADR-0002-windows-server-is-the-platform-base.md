# ADR-0002: Windows Server is the platform base

**Context.** Two candidate bases were designed: a Linux/Kubernetes platform (Cozystack on Talos) and a Windows-native one. The team's applications are .NET, the critical database is SQL Server, the legacy API is Windows-only, and the team's operational experience is Windows.

**Options.** (a) Cozystack/Talos. (b) Windows Server host with Linux VMs for the platform layer. (c) Windows Server, native, end to end.

**Decision.** (c), chosen by the owner on 8 Sep 2026.

**Why.** One operating system the team already knows, for the hypervisor, the cluster, the identity system, the database and the applications. Microsoft's security primitives (Secure Boot + TPM + System Guard, VBS/Credential Guard, WDAC, Shielded VMs, IPsec domain isolation) are hardware-rooted and shipped in the OS. Service Fabric gives an application scheduler that is native to Windows and runs Azure itself. What Windows gives up against Kubernetes (an immutable OS, fractional GPU sharing, a pre-integrated component set) was judged an acceptable trade, and the GPU gap is closed by ADR-0003.

**Consequences.** More integration work than Cozystack would have required; Datacenter licensing for unlimited VMs and Storage Spaces Direct; a smaller community around Service Fabric than around Kubernetes; no true immutable OS (mitigated by Server Core + WDAC + DSC). The Linux plan is preserved in `docs/adr/superseded/` so it can be revived without re-research.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

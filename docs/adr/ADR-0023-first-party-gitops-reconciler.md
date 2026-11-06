# ADR-0023: First-party GitOps reconciler

**Status:** Accepted · **Date:** 2026-09-08

**Options.** (a) Flux. (b) Argo CD. (c) A first-party reconciler.

**Decision.** `Argus.Reconciler`, a .NET Service Fabric stateful service: polls the GitOps repo, verifies commit signatures, diffs desired vs actual (Service Fabric apps, Hyper-V VMs via WMI, SeaweedFS buckets, OpenBao policies, GPO links via DSC), applies in dependency order, reports status to the console and Grafana.

**Why.** Flux and Argo are Kubernetes-only. The reconciler is ~2,000 lines of C# against APIs the team already knows, and it is the single most important piece of the platform: it is what makes "Git is the truth" true.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

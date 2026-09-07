# ADR-0025: OpenTofu + DSC v3 for IaC

**Decision.** OpenTofu with the Hyper-V provider defines VMs; PowerShell DSC v3 configures Windows hosts and VMs (roles, features, WDAC policy, GPO membership, WinSW services); the reconciler drives both.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

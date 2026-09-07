# ADR-0021: Control surface

**Decision.** Three surfaces, one truth: a **web console** for operators and mill staff; a **PowerShell module (`Argus`) and thin `argus` CLI** for engineers; a **GitOps repository** (`platform/gitops/`) that is the only writer of production state. The console and CLI call the same console API; the console API writes to Git and the reconciler applies Git. Direct changes to production outside the reconciler are denied by WDAC/JEA and alerted by Wazuh. Owner's choice, 8 Sep 2026.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

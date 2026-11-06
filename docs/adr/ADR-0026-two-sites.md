# ADR-0026: Two sites

**Status:** Accepted · **Date:** 2026-09-08

**Decision.** Site A (primary, in the organisation's main region) and Site B (a second building or a colocation rack in a second region; the decision owner's choice, pending as Q1 in `08-OPEN-QUESTIONS.md`): 2 nodes, Hyper-V Replica target, SQL async secondary, SeaweedFS replica with 90-day object lock, third domain controller, Uptime Kuma, cluster witness. RTO ≤ 8 h for full Site A loss.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

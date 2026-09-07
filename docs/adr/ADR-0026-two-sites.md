# ADR-0026: Two sites

**Decision.** Site A (primary, Lahore) and Site B (a second building or a Karachi colocation rack, owner decision pending in `08-OPEN-QUESTIONS.md`): 2 nodes, Hyper-V Replica target, SQL async secondary, SeaweedFS replica with 90-day object lock, third domain controller, Uptime Kuma, cluster witness. RTO ≤ 8 h for full Site A loss.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

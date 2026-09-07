# ADR-0031: SQL Server back to FULL recovery *(Proposed)*

**Context.** `umairv3_db` was moved to SIMPLE recovery outside the Mills project in Aug 2026 because the log had grown to 466 GB with no log backups. The owner's standing ruling (D14) was FULL.

**Proposal.** Once ADR-0020's 15-minute log backups are running and proven for two weeks, return to FULL. This restores point-in-time recovery (RPO 15 min instead of "last full"). Requires the owner's ruling because D14 was ruled three times.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

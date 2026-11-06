# ADR-0031: SQL Server back to FULL recovery

**Status:** Proposed · **Date:** 2026-09-08

**Context.** In the reference scenario `orders_db` was switched to SIMPLE recovery outside the platform because its log had grown to several hundred gigabytes with no log backups (an illustrative figure). The organisation's stated policy is FULL.

**Proposal.** Once ADR-0020's 15-minute log backups are running and proven for two weeks, return to FULL. This restores point-in-time recovery (RPO 15 min instead of "last full"). It needs the decision owner's acceptance because it reverses a change made outside the platform (Q7 in `08-OPEN-QUESTIONS.md`).

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

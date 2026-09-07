# ADR-0001: Leave AWS; build a sovereign private cloud

**Context.** The Mills dashboard uses two AWS services: one Windows EC2 instance and one S3 bucket for backups (audit of `Mills-Restructured-by-Zayan`, 7 Sep 2026). The ML pipelines use GPU hours wherever they can be found. Data about Pakistani farmers, parcels and loans currently sits in ap-southeast-1.

**Options.** (a) Stay on AWS. (b) Hybrid: local GPUs and storage, AWS for the database. (c) Full exit onto owned hardware.

**Decision.** (c), phased, with (b) as an explicit checkpoint at the end of Phase 3 (`00-MASTER-PLAN.md` §10).

**Why.** The AWS surface is small enough that the exit is a hardware-and-operations project, not a software rewrite. The strongest arguments are capability (GPUs the team actually uses, imagery served locally in seconds instead of pulled over Pakistani bandwidth in hours) and control (data never leaves the country; no dependency on a foreign account that can be suspended). Cost is secondary but favourable over three years.

**Consequences.** The team takes on hardware, power, patching, backup drills and on-call: work AWS did invisibly. Section 9 of the master plan staffs it. If it cannot be staffed, ADR-0001 is amended to (b).

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

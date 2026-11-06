# ADR-0008: SQL Server stays; PostgreSQL + PostGIS added

**Status:** Accepted · **Date:** 2026-09-08

**Context.** `orders_db` is live under the Orders mobile apps, uses tuned stored procedures returning multiple result sets, SQL geometry types, and HMAC password hashes shared with the apps. It cannot be migrated as a project prerequisite. The ML pipelines and the region/STAC catalogue want a spatial database with an open licence.

**Options.** (a) SQL Server for everything. (b) Migrate everything to PostgreSQL. (c) Keep SQL Server and add PostgreSQL + PostGIS beside it.

**Decision.** SQL Server 2022 Standard in an Always On availability group (primary VM Site A, async secondary Site B). PostgreSQL 17 + PostGIS 3.5 (EDB Windows build) as a second engine for STAC (`pgstac`), classifier feature tables, region vector tiles and anything additive the application teams move off SQL Server over time.

**Why.** Non-negotiable constraints on one side; licence cost and geospatial tooling (Martin, TiTiler, pgstac are Postgres-native) on the other. Two engines is the honest answer.

**Consequences.** Two backup regimes (ADR-0020). The reporting replica at Site B takes the heavy read queries off the primary the mobile apps write to.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

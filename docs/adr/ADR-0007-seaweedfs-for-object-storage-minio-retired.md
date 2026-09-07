# ADR-0007 — SeaweedFS for object storage; MinIO retired

**Context.** The earlier compose prototype used MinIO. MinIO's community edition was archived in February 2026: no security patches, no prebuilt binaries, and commercial use without an AIStor licence carries legal risk. The workload is 1.16 M survey pictures (many small objects), multi-GB rasters (few large), ~3.2 TB of retained backups.

**Options.** SeaweedFS (Apache-2.0, Windows build, weekly releases, small-object optimised, erasure coding, lifecycle, object lock). Garage (AGPL, geo-distributed, no Windows build). Ceph RGW (Linux only, heavy). RustFS (young).

**Decision.** SeaweedFS at both sites, running as Windows services (WinSW), with async cross-site replication of the `argus-backups` bucket. Buckets: `argus-survey-pictures`, `argus-rasters`, `argus-sentinel`, `argus-artifacts`, `argus-backups`, `argus-ml`.

**Why.** Apache-2.0, native Windows binary, and the many-small-objects design fits the survey pictures exactly. Object-lock (WORM) on `argus-backups` and `argus-artifacts`.

**Consequences.** SeaweedFS's S3 coverage is "good", not MinIO's "excellent": test every client (the .NET S3 SDK, `rclone`, `boto3`, Kopia) in Phase 1. Garage remains an option on `siem-01` for Site B if SeaweedFS replication proves fragile over the site link.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

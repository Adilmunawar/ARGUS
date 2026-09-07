# ADR-0020: Backups

**Decision.** SQL Server: native full nightly + differential 6-hourly + **log every 15 min** (once ADR-0031 lands) to `argus-backups` with `CHECKSUM` and `RESTORE VERIFYONLY`, encrypted, object-locked 35 days at Site A, replicated to Site B and locked 90 days. PostgreSQL: pgBackRest (Windows via WSL is not allowed; use `pg_basebackup` + WAL archiving to S3 via the `wal-g` Windows build). Files (survey pictures, rasters): Kopia (Windows) content-addressed, encrypted. VMs: Hyper-V Replica to Site B (5-min RPO) + weekly Windows Server Backup of hosts. The backup gMSA has `PUT` but never `DELETE` on the buckets. **Restore drill monthly, DR drill quarterly**, reports signed and committed to `docs/runbooks/drills/`.

**Why.** Ransomware and destructive insiders are threat #1; immutability at a second site under different credentials is the only control that fully answers it.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

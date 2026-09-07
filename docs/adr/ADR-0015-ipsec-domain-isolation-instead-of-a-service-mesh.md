# ADR-0015: IPsec domain isolation instead of a service mesh

**Decision.** Windows Firewall connection-security rules via GPO: all server-to-server traffic inside the platform requires Kerberos (machine) or certificate (AD CS) authentication and AES-GCM encryption; unauthenticated inbound is dropped. Linux exceptions use strongSwan with AD CS certificates. Per-service inbound rules allow only the identities that need to connect (e.g. SQL accepts only the Mills API gMSA and the backup gMSA).

**Why.** This is mTLS-everywhere delivered by the OS at layer 3, with no sidecars and no application changes. Sidecar meshes do not exist for Windows anyway.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

# ADR-0006: No container registry in v1

**Status:** Accepted · **Date:** 2026-09-08

**Context.** With guest executables (ADR-0005) there are no images to store.

**Options.** (a) Harbor as a container registry, on a Linux VM. (b) No registry: signed `.sfpkg` archives in object storage.

**Decision.** Application packages are signed `.sfpkg` archives stored in the `argus-artifacts` bucket (SeaweedFS, object-locked), addressed by Git commit SHA. Harbor is not deployed.

**Why.** Harbor is Linux-only and would be a third Linux exception with no v1 consumer.

**Consequences.** If containers arrive later, a registry lands on a Linux VM by ADR.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

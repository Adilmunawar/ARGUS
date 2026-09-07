# ADR-0024 — CI on GitHub Actions self-hosted Windows runners; Forgejo mirror

**Decision.** GitHub stays the collaboration surface; self-hosted runners (Windows, WDAC-compliant, no internet except allow-listed) build, test, sign and upload `.sfpkg` to `argus-artifacts`. Forgejo (Windows binary) mirrors every repo and can run the same workflows if GitHub is unreachable.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

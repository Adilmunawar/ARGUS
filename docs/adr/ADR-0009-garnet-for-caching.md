# ADR-0009: Garnet for caching

**Context.** The Mills API holds three in-process caches (boundary, map geometry, report). Scaling to multiple instances needs an external cache. Redis relicensed in 2024; Valkey has no Windows build.

**Decision.** **Microsoft Garnet** (MIT, .NET, RESP-compatible) as a Windows service. Any Redis client works.

**Why.** Native Windows, Microsoft-maintained, faster than Redis on most benchmarks, and the same `StackExchange.Redis` client the .NET code would use anyway.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

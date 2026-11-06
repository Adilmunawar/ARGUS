# ADR-0022: The console is .NET 10 + Next.js on Service Fabric

**Status:** Superseded by [ADR-0035](ADR-0035-the-console-as-built.md) · **Date:** 2026-09-08

**Decision.** `platform/console/`: a .NET 10 minimal API (`Argus.Console.Api`) and a Next.js 16 front end, deployed as a Service Fabric application, authenticated by AD FS, authorised by AD groups mapped to console roles. Day one, before parity: Windows Admin Center for raw host management and Grafana for observability, both behind AD FS.

**Why.** The same stack the Orders dashboard already runs on, so the team's design system and testing habits would apply unchanged.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

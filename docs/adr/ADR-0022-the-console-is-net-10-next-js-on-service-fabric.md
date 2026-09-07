# ADR-0022: The console is .NET 10 + Next.js on Service Fabric

**Decision.** `platform/console/`: a .NET 10 minimal API (`Argus.Console.Api`) and a Next.js 16 front end, deployed as a Service Fabric application, authenticated by AD FS, authorised by AD groups mapped to console roles. Day one, before parity: Windows Admin Center for raw host management and Grafana for observability, both behind AD FS.

**Why.** The same stack that runs the Mills dashboard on the same Windows server today; the team's design system, testing habits and Claude Code plugins apply unchanged.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

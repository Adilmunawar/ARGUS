# ADR-0011: Self-hosted Azure Functions host

**Context.** Scheduled and event-driven jobs (hourly precompute, 15-day feature tables, exports, harvest-drop detection) currently run as cron or inside a request.

**Decision.** The **Azure Functions host runtime** (MIT), isolated-worker .NET model, deployed as a Service Fabric guest executable per function app, triggered by NATS (custom trigger) and timers. No Azure account involved.

**Why.** Lambda-shaped programming model the .NET team already knows, runs anywhere the host runs, and Service Fabric provides the placement and restarts.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

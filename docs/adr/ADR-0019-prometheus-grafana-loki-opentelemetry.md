# ADR-0019: Prometheus / Grafana / Loki / OpenTelemetry

**Status:** Accepted · **Date:** 2026-09-08

**Decision.** Prometheus + `windows_exporter` + `sql_exporter`; Grafana (AD FS login); Loki with Grafana Alloy agents shipping Windows Event Log and application logs; OpenTelemetry Collector receiving traces from the .NET APIs and Next.js; Alertmanager → Apprise → chat and SMS channels; Uptime Kuma at Site B watching Site A from outside. All have native Windows builds.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

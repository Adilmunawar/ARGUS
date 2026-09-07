# ADR-0033: The console is the primary surface; Windows Admin Center is retired at parity

**Status:** Accepted (8 September 2026)

## Context

`05-CONTROL-PLANE.md` positioned Windows Admin Center as a permanent partner to the console for host and VM management. Two surfaces with overlapping powers means two audit trails, two authorisation models, and a route that bypasses the "every write is a pull request" rule, WAC mutates hosts directly.

## Decision

Windows Admin Center is a **bootstrap and fallback tool**, not part of the target architecture. It is used from Phase 0 and retired when console stage **C6** reaches parity for daily operations (`10-CONSOLE-DESIGN.md` §6). After retirement it remains installed on `wac-01`, reachable only from a PAW, for genuine break-glass, and its use raises an alert.

Grafana is different and is **not** retired: it stays as the deep observability tool, embedded in console panels where useful and linked out for ad-hoc querying. The console does not try to rebuild Grafana.

## Consequences

- C6 must actually deliver Hosts, Service Fabric map, Maintenance and full Audit before WAC goes; if C6 slips, WAC stays. Nothing is removed before its replacement is proven.
- Every WAC action in the interim is logged to the audit through WEF, so the record is not lost during the overlap.
- The console's Hosts screen must cover: S2D health and repair jobs, patch age and windows, live migration, drain, quarantine, and cluster witness state.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

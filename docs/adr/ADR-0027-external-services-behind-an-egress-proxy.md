# ADR-0027: External services behind an egress proxy

**Decision.** Google Earth Engine, the Anthropic API and OpenRouteService remain external. All egress from the platform goes through an allow-listing proxy (Caddy forward-proxy or OPNsense) with keys held in OpenBao and injected at runtime; no host has general internet access. OpenRouteService is self-hosted with the Pakistan OSM extract in Phase 3 (Java, runs on Windows), removing the 2,000/day quota.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

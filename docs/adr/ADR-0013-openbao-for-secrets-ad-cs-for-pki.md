# ADR-0013: OpenBao for secrets; AD CS for PKI

**Decision.** **OpenBao** (MPL-2.0, Linux Foundation fork of Vault, Windows binary) as a 3-node Raft cluster on the Service Fabric nodes, Shamir 3-of-5 unseal held by three people, audit device to Loki. Dynamic SQL Server and PostgreSQL credentials (1 h TTL), transit engine for PII fields, KV for third-party keys. **AD Certificate Services** (two-tier: offline root, enterprise issuing CA) for machine certificates, IPsec, code signing and the internal TLS chain; external TLS via ACME (Let's Encrypt) at the edge.

**Why.** OpenBao gives dynamic short-lived credentials, the single biggest reduction in credential-theft blast radius, and directly resolves the Mills repo's OPEN-DECISIONS D16 (secrets in git history). AD CS is the native, free PKI that every Windows control expects.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

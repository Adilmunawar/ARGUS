# ADR-0016: Caddy + Coraza at the edge, YARP per application

**Decision.** **Caddy** (Apache-2.0, Windows binary) as the internal edge: ACME certificates, HTTP/3, Brotli, **Coraza** WAF with the OWASP Core Rule Set, rate limiting. Behind it, each application keeps its own **YARP** gateway (the Mills repo already has one). Caddy runs as a Service Fabric guest executable on two nodes with a cluster IP.

**Why.** The Mills gateway currently reads a certificate from the Windows store and terminates TLS itself; centralising TLS and WAF in Caddy lets every app's gateway speak plain HTTP on the isolated network and removes the cert-store dependency (`DEPLOYMENT.md` trap).

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

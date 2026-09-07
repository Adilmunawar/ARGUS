# ADR-0017: OPNsense HA pair + CrowdSec

**Decision.** Two OPNsense appliances per site (CARP failover): perimeter firewall, Suricata IDS/IPS, GeoIP policy, WireGuard site-to-site and admin VPN authenticated against AD via NPS (RADIUS) with MFA, traffic shaping. CrowdSec agents on Caddy and the Windows hosts feed decisions to an OPNsense bouncer.

**Why.** A real perimeter with IDS, which the EC2 security group never was. Appliances are exempt from ADR-0003 because they are not general-purpose hosts.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

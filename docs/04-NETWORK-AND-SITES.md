# Network and sites

## 1. Zones and VLANs (Site A; Site B mirrors with `1xx` VLAN ids and `10.1xx` prefixes)

| VLAN | Name | Subnet | Routed? | Contents | Ingress allowed from |
|---|---|---|---|---|---|
| 10 | MGMT | 10.10.0.0/24 | via firewall | IPMI, switch mgmt, UPS, WAC, OPNsense UI, HGS | ADMIN VPN (PAW) only |
| 11 | TIER0 | 10.11.0.0/24 | via firewall | DCs, AD FS, CAs, HGS | PLATFORM/DATA/ML for Kerberos/LDAP/DNS/CRL only; ADMIN VPN |
| 12 | SEC | 10.12.0.0/24 | via firewall | `siem-01`, `wef-01` | all zones outbound to it (agents); ADMIN VPN |
| 20 | DMZ | 10.20.0.0/24 | yes | Caddy VIP `10.20.0.10`, Uptime Kuma (B) | Internet 443; nothing else |
| 30 | PLATFORM | 10.30.0.0/23 | via firewall | SF nodes and their apps, legacy VM, Forgejo | DMZ (Caddy → app ports); BUILD (deploy); ADMIN VPN |
| 31 | DATA | 10.31.0.0/24 | via firewall | SQL, PostgreSQL, SeaweedFS, Garnet, NATS | PLATFORM and ML by identity; BUILD never |
| 32 | BUILD | 10.32.0.0/24 | via firewall | runners | Forgejo/GitHub via proxy; `argus-artifacts` S3 endpoint |
| 40 | STORAGE | 10.40.0.0/24 | **non-routed** | S2D RDMA (RoCE v2), Live Migration, cluster heartbeat | hosts only |
| 50 | ML | 10.50.0.0/24 | via firewall | `gpu-01` | PLATFORM (Ray Serve via Caddy), DATA by identity |
| 90 | QUARANTINE | 10.90.0.0/24 | none | isolated hosts under investigation | SEC only |
| 99 | ADMIN VPN | 10.99.0.0/24 | via firewall | WireGuard admin clients (PAWs) | - |

Rules are in `platform/policies/firewall/opnsense-rules.yaml` and are applied by IaC; a rule not in Git is an alert.

## 2. Addressing and names

DNS zone `argus.local` (AD-integrated, internal) and `zaraatdost.pk` (public, at the registrar; only DMZ names). Public names: `mills.zaraatdost.pk`, `loans.zaraatdost.pk`, `agis.zaraatdost.pk`, `console.zaraatdost.pk` (VPN-only despite public DNS; Caddy checks source), `ml.zaraatdost.pk`, `status.zaraatdost.pk` (Site B). Every internal service has an `A` record and an AD CS certificate; nothing is addressed by IP in configuration.

## 3. Edge

OPNsense HA (CARP) at each site. WAN: two ISPs at Site A with failover (PTCL fibre + a second provider), one at Site B. Inbound: 443/tcp+udp only, to the Caddy VIP, with Suricata inline. Admin: WireGuard on a non-standard port, NPS/RADIUS (AD) + MFA, per-device keys, PAW-only for Tier 0 subnets. Site-to-site: WireGuard, always on, carries AD replication, Hyper-V Replica, SQL AG, SeaweedFS replication, backups; QoS gives AG and Replica priority.

## 4. Inside

25 GbE to every host; RoCE v2 with PFC/ECN on VLAN 40 for S2D; LACP pairs. Hyper-V SET switch per host with the VLANs trunked; every VM NIC carries a VLAN tag and an **extended port ACL** mirroring the firewall intent (defence in depth if the firewall is misconfigured). IPsec domain isolation (ADR-0015) means that even inside a VLAN, a host that is not domain-joined with a valid certificate cannot talk to anything.

## 5. Egress

No default route from PLATFORM, DATA, ML or BUILD. A forward proxy on the DMZ (Caddy `forward_proxy` or OPNsense's Squid) with a per-zone allow-list in Git: Copernicus, Earth Engine, Anthropic, Let's Encrypt, GitHub, NuGet/npm/PyPI mirrors (proxied through Forgejo's package registry so builds are reproducible offline), Windows Update via WSUS. Suricata alerts on any outbound connection not through the proxy.

## 6. Bandwidth plan for Site B

Initial seed of ~5 TB (backups + survey pictures) by physical disk. Steady state: SQL log backups ~2 GB/day, Kopia incrementals ~5-20 GB/day, Hyper-V Replica deltas ~10-50 GB/day, AD replication negligible. A 100 Mbps dedicated link comfortably carries this; a 1 Gbps link makes the DR fail-back fast. Both sites keep a second ISP.

## 7. Power

Online double-conversion UPS at each site, 30 minutes at full load; NUT on `wac-01` (A) and `hv-b01` (B) shuts VMs then hosts at 20 % remaining in dependency order (SF apps → SQL → storage → DCs → hosts). Generator with automatic transfer switch at Site A is assumed to exist; if it does not, it is the first item in `08-OPEN-QUESTIONS.md`.

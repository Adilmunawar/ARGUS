# Security architecture

Zero trust, rooted in hardware, evidenced continuously. The perimeter is the last line, not the first.

## 1. Threat model

Ranked by likelihood × impact for a Pakistani agri-tech company holding farmer identity, parcel and loan data.

| # | Threat | Primary control | Secondary |
|---|---|---|---|
| 1 | Ransomware or destructive insider hitting DB and backups together | Object-locked backups at Site B under a credential that cannot delete; separate backup admin forest | ReFS snapshots, VSS, Defender ASR + Controlled Folder Access, Wazuh ransomware rules |
| 2 | Credential theft (leaked config file, phished operator) | No long-lived credentials: gMSA for services, OpenBao 1 h leases, WHfB/FIDO2 for humans, Credential Guard | Tiered admin, PAW, JEA, LAPS, NTLM off |
| 3 | Malicious or vulnerable code executed on a server | WDAC enforced: only Argus- or Microsoft-signed code runs | CI signing gate, SBOM per package, Trivy/`dotnet list package --vulnerable` in CI |
| 4 | Lateral movement after a foothold | IPsec domain isolation, default-deny east-west, per-identity inbound rules | Sysmon + Wazuh detection, Hyper-V switch ACLs, VLANs |
| 5 | Perimeter attack, DDoS, credential stuffing | OPNsense + Suricata + CrowdSec + Coraza WAF + Caddy rate limits + the apps' own per-IP limiters | GeoIP policy, HTTP/3 with QUIC retry |
| 6 | Physical theft or seizure | BitLocker TPM+PIN, Shielded VMs (host admin cannot read VM disks), offline root CA in a safe | HGS attestation, chassis intrusion alerts via IPMI |
| 7 | Loss of a site | Site B, Hyper-V Replica, SQL async AG, SeaweedFS replica, ≤ 8 h RTO | quarterly drill |
| 8 | Supply chain (compromised third-party binary) | WDAC catalogues per verified version, hash-pinned downloads in IaC, Forgejo mirror of sources | Trivy filesystem scan of every third-party release before cataloguing |
| 9 | Privilege escalation via AD misconfiguration | Tier model, Protected Users, AdminSDHolder review, PingCastle/Purple Knight monthly | Wazuh SCA for AD |
| 10 | Data exfiltration | No general egress; allow-listed proxy; DLP-style Suricata rules for large outbound transfers; Loki audit of S3 access | Transit-encrypted PII fields, so a dump is useless without OpenBao |

## 2. Hardware root of trust

| Control | Where | Configuration |
|---|---|---|
| UEFI Secure Boot | every server | enforced; custom keys not needed with Windows/Ubuntu shims |
| TPM 2.0 | every server | BitLocker protector; HGS attestation; OpenBao auto-unseal is *not* TPM-bound (Shamir chosen so a stolen node cannot unseal alone) |
| System Guard / DRTM | Hyper-V hosts | enabled; measured boot reported to HGS |
| VBS + HVCI + Credential Guard | every Windows host and VM | enforced via GPO; LSASS isolated; kernel-mode code integrity |
| BitLocker | every disk incl. S2D capacity | XTS-AES-256, TPM+PIN on hosts, TPM-only on VMs (Shielded VM vTPM) |
| Shielded VMs + HGS | all VMs on the clusters | TPM-trusted attestation; VM disks unreadable from the host; console access disabled; PowerShell Direct disabled |
| Chassis intrusion, IPMI | hosts | IPMI on MGMT VLAN only, own credentials in OpenBao, alerts to Wazuh |

## 3. Identity

### 3.1 Forest and tiers

`argus.local` forest, three DCs. **Tier 0**: DCs, AD FS, CAs, HGS, OpenBao, the reconciler's write credentials. **Tier 1**: Hyper-V hosts, SF nodes, SQL, storage, SIEM. **Tier 2**: user workstations. An account is a member of exactly one tier; Tier 0 accounts log on only from **Privileged Access Workstations** (dedicated laptops, WDAC-locked, no email/browser) over the admin VPN with FIDO2.

### 3.2 Humans

| Rule | Mechanism |
|---|---|
| Passwordless for admins | Windows Hello for Business (cert trust) or FIDO2 keys; passwords disabled for Tier 0/1 accounts |
| MFA for everyone | AD FS with WHfB/FIDO2 as the primary factor; TOTP fallback only for Tier 2 |
| No standing admin | JEA endpoints for routine tasks; Tier 0 membership granted time-boxed via the console (writes an AD group membership with expiry, `Add-ADGroupMember -MemberTimeToLive`) |
| Protected accounts | all Tier 0/1 in **Protected Users** (no NTLM, no DES/RC4, no delegation, 4 h TGT) |
| Local admin | LAPS with 24 h rotation; passwords readable only through JEA with audit |
| Leavers | disabling the AD account revokes everything: VPN (NPS), console, Grafana, SQL (Kerberos), OpenBao (AD auth method), JupyterHub |

### 3.3 Services

Every service runs as a **group-managed service account** (automatic 30-day password rotation, no human ever knows it) or, on Linux, an AD computer/service account via SSSD with a keytab. Services authenticate to SQL/PostgreSQL by Kerberos *or* by an OpenBao dynamic credential with a 1 h TTL: never by a password in a file. `appsettings.Local.json` is deleted from the platform's vocabulary; configuration comes from environment variables injected by the SF package from OpenBao at start.

### 3.4 Protocol hardening (GPO)

NTLM: deny all (audit for 30 days first). LDAP: signing required, channel binding always. SMB: v1 removed, signing and encryption required. RDP: NLA + Restricted Admin, allowed only from PAWs and only to Tier 2. WinRM: HTTPS only, JEA endpoints only. Kerberos: AES only, RC4 disabled, `KrbtgtRotation` twice yearly.

## 4. Code integrity

| Control | Detail |
|---|---|
| WDAC policy | `platform/policies/wdac/argus-base.xml`: allow Microsoft-signed, allow Argus code-signing certificate chain, allow catalogues in `platform/policies/wdac/catalogs/`; deny everything else. Audit mode Phase 0-5, enforced Phase 6 with per-host enforcement as each is validated. |
| Third-party binaries | each version of SeaweedFS, NATS, OpenBao, Prometheus, Loki, Grafana, Caddy, Garnet, Forgejo, `windows_exporter`: download by pinned SHA-256 (in IaC), Trivy scan, `New-CIPolicy`-generated catalogue, catalogue signed by Argus, committed |
| Application packages | CI signs every `.exe`/`.dll` with the Argus code-signing certificate (key on the HSM/TPM of `runner-01`, cert from `ca-issuing-01`, template `Argus-CodeSigning`, 1-year validity); `.sfpkg` zipped and signed; reconciler verifies before `Register-ServiceFabricApplicationType` |
| PowerShell | Constrained Language Mode everywhere except PAWs; script-block, module and transcription logging to WEF; AMSI enabled; execution policy `AllSigned` |
| Drivers | HVCI blocks unsigned; Microsoft vulnerable-driver blocklist enabled |
| Commits | every commit to `argus` and `argus-gitops` signed (SSH or GPG); reconciler refuses unsigned or unknown-key commits |

## 5. Network

Detail in `04-NETWORK-AND-SITES.md`. The security-relevant summary:

| Layer | Control |
|---|---|
| Perimeter | OPNsense HA: default deny in; only 443/tcp+udp to the Caddy VIP; Suricata IPS with ET Pro-equivalent rules; CrowdSec bouncer; GeoIP deny for non-PK/GB/US/AE admin sources (configurable); WireGuard for S2S and admin |
| East-west | IPsec domain isolation: all traffic between platform hosts must be authenticated (Kerberos machine identity or AD CS cert) and AES-256-GCM encrypted; unauthenticated inbound dropped; per-service inbound rules list allowed *identities*, not IPs |
| Segmentation | VLANs per zone; Hyper-V extended port ACLs on every VM NIC as defence in depth; storage VLAN non-routed |
| Egress | no default route from PLATFORM/DATA/ML zones; explicit proxy with allow-list; DNS only to the DCs; DoH blocked |
| Linux exceptions | strongSwan with AD CS certificates in the same IPsec rules; `ufw` default deny |
| Management | IPMI, switches, UPS, OPNsense UI on MGMT VLAN reachable only from PAWs via VPN |

## 6. Data protection

| Data | At rest | In transit | Field level |
|---|---|---|---|
| SQL databases | BitLocker on `sql-01` disks + **TDE** (keys in AD CS-issued cert, backed up in the safe) | IPsec + TLS 1.3 (`Encrypt=True;TrustServerCertificate=False`) | CNIC, phone numbers: **Always Encrypted** columns (column master key in OpenBao transit via a custom provider), Phase 6 |
| PostgreSQL | BitLocker | IPsec + TLS | `pgcrypto` for PII in `argus_geo` |
| Object storage | SeaweedFS volume encryption + BitLocker | TLS from Caddy-fronted S3 endpoint; IPsec | applicant photos: OpenBao transit encryption before upload |
| Backups | encrypted (SQL `ENCRYPTION` clause with AD CS cert; Kopia AES-256; wal-g) | TLS | - |
| Logs | Loki chunks in `argus-logs` (object lock 400 d) | TLS | PII redaction in Alloy pipelines for known fields |
| Secrets | OpenBao Raft storage encrypted by the master key (Shamir 3-of-5) | TLS with AD CS certs | - |

## 7. Detection and response

| Source | Collector | Where analysed | Retention |
|---|---|---|---|
| Sysmon (all Windows) | WEF → `wef-01` → Alloy → Loki; Wazuh agent direct | Wazuh rules + Grafana | 400 d |
| Windows Security/System/PowerShell logs | same | same | 400 d |
| Linux auditd, journald | Wazuh agent, Alloy | same | 400 d |
| Suricata, OPNsense firewall | syslog → Loki; Wazuh | same | 400 d |
| Caddy/Coraza access + WAF | Loki; CrowdSec | Grafana; CrowdSec | 400 d |
| OpenBao audit device | Loki | Wazuh rule pack `argus-openbao` | 400 d |
| S3 access logs (SeaweedFS) | Loki | Wazuh | 400 d |
| Kubernetes-equivalent: Service Fabric events | SF EventStore → Alloy → Loki | Grafana | 400 d |
| Console actions, reconciler applies | `argus_console_events` + Loki | console audit UI | forever |

**Rules that page** (Alertmanager → WhatsApp, on-call rota): new local admin created; Tier 0 group change outside the console; WDAC block event on a production host; Sysmon event 1 with an unsigned parent on a server; LSASS access; Kerberoast pattern; backup age > 30 min; OpenBao sealed; AG not synchronising; Suricata high-severity; CrowdSec ban of an internal IP; Wazuh FIM change under `C:\Argus\` or `/etc`.

**Response:** runbooks in `docs/runbooks/` (`sec-01-suspected-compromise.md` isolates a host by moving its VM NIC to the QUARANTINE VLAN through the console; `sec-02-credential-leak.md` revokes OpenBao leases and rotates the gMSA; `sec-03-ransomware.md` freezes S3 buckets and starts restore from Site B). Blameless post-mortem within 5 working days, committed.

## 8. Compliance and evidence

Wazuh SCA scores every host against the **Microsoft Security Baseline** and **CIS Benchmark** daily; drift below 95 % pages. Wazuh's ISO 27001 / PCI DSS / NIST 800-53 mappings tag every alert. Monthly, the console generates the **evidence pack**: MFA coverage (AD FS), WDAC enforcement state, patch age (WSUS), backup drill report, restore timing, open vulnerabilities (Trivy + `dotnet list package --vulnerable`), privileged access grants and expiries, firewall rule changes (Git history). This is the pack an external auditor or a bank partner (the loan product) receives; it is produced by the platform, not written by hand.

## 9. Security in the delivery pipeline

```
developer commit (signed) ──► GitHub PR ──► required checks:
   build · tests · dotnet vulnerable-packages · Trivy fs · secret scan (gitleaks) · SBOM (syft)
   ──► merge ──► self-hosted Windows runner (WDAC, no egress):
   publish self-contained · signtool sign every binary · package .sfpkg · sign package · upload argus-artifacts (WORM)
   ──► PR to argus-gitops bumping the version (auto-generated, signed by gmsa-ci$)
   ──► human approval for prod (Tier 1 reviewer; console shows the diff)
   ──► merge ──► reconciler: verify commit signature · verify package signature · SF rolling upgrade with health policy · auto-rollback on failure
```

Nothing reaches a server that was not built from a signed commit, on a locked-down runner, signed twice, and approved by a person.

## 10. What is deliberately not here

- **A service mesh**: IPsec is the mesh.
- **A separate WAF appliance**: Coraza in Caddy is OWASP CRS; a hardware WAF is a Phase 7 question if the loan product grows.
- **A commercial EDR**: Sysmon + Wazuh + Defender ASR cover the detections; Defender for Endpoint is a licensing decision for the owner, easily added.
- **A hardware HSM**: recommended (YubiHSM 2 is ~$650 and holds the code-signing and CA keys); recorded in `08-OPEN-QUESTIONS.md`.

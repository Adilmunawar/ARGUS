# Policies: enforced, versioned

| Dir | Contains | Applied by |
|---|---|---|
| `wdac/` | `argus-base.xml` (allow Microsoft + Argus code-signing chain + catalogues; deny all), `catalogs/<tool>-<version>.cat` signed per third-party release | DSC (`CiTool`) |
| `gpo/` | Microsoft Security Baseline + CIS deltas as backups; tier-model GPOs; IPsec connection-security rules; Sysmon install; PowerShell logging; NTLM/LDAP/SMB hardening | DSC + `Import-GPO` via reconciler |
| `firewall/` | `opnsense-rules.yaml` (perimeter), `ipsec-rules.yaml` (east-west identities), `egress-allowlist.yaml` | reconciler → OPNsense API; GPO |
| `wazuh-rules/` | Argus rule packs: `argus-openbao`, `argus-wdac`, `argus-sf`, `argus-s3`, `argus-ad-tier` | Wazuh manager on `siem-01` |
| `sysmon.xml` | Olaf Hartong `sysmon-modular` baseline with Argus tuning | GPO |

A change to any file here needs two Tier 1 approvals and is a security-relevant reconcile (drift is auto-reverted and paged).

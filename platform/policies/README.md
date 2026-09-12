# Policies: enforced, versioned

Present in this tree today:

| Path | Contains | Applied by |
|---|---|---|
| `firewall/ipsec-rules.yaml` | East-west authorisation by identity (ADR-0015): default deny for unauthenticated inbound, Kerberos machine auth plus `Argus-Issuing-CA` certificates, AES256-GCM, and the per-destination `to`/`port`/`from` rule set | reconciler → Windows Firewall connection-security + inbound rules via GPO; strongSwan equivalents on Linux hosts |
| `gpo/`, `wazuh-rules/`, `wdac/catalogs/` | Placeholders only. Each holds a README and no policy artefacts yet; they are populated in the phase that owns them (see `docs/06-PHASES-AND-RUNBOOKS.md`) | - |

Planned but not yet committed, so nothing here applies them: the WDAC base policy (`wdac/argus-base.xml`) and signed per-tool catalogues, the Security Baseline/CIS GPO backups, the Sysmon configuration, the perimeter and egress firewall files (`firewall/opnsense-rules.yaml`, `firewall/egress-allowlist.yaml`), and the Argus Wazuh rule packs. Do not cite them as controls until the files exist.

`firewall/ipsec-rules.yaml` is validated in CI against `platform/gitops/schemas/IpsecRules.schema.json`; the placeholder directories contain nothing to validate.

A change to any file here needs two Tier 1 approvals and is a security-relevant reconcile (drift is auto-reverted and paged).

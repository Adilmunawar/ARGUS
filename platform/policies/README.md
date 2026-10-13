# Policies: enforced and versioned

This directory holds the security policies the reconciler enforces across the estate, versioned in Git.

## Present in this tree today

<table>
  <tr><th>Path</th><th>Contains</th><th>Applied by</th></tr>
  <tr>
    <td><code>firewall/ipsec-rules.yaml</code></td>
    <td>East west authorisation by identity (ADR 0015): default deny for unauthenticated inbound, Kerberos machine authentication plus <code>Argus-Issuing-CA</code> certificates, AES256 GCM, and the per destination <code>to</code>/<code>port</code>/<code>from</code> rule set</td>
    <td>The reconciler, as Windows Firewall connection security and inbound rules via GPO; strongSwan equivalents on Linux hosts</td>
  </tr>
  <tr>
    <td><code>gpo/</code>, <code>wazuh-rules/</code>, <code>wdac/catalogs/</code></td>
    <td>Placeholders only. Each holds a README and no policy artefacts yet; they are populated in the phase that owns them (see <a href="../../docs/06-PHASES-AND-RUNBOOKS.md">the phases and runbooks plan</a>)</td>
    <td>Nothing yet</td>
  </tr>
</table>

## Planned but not yet committed

Nothing here applies these yet: the WDAC base policy (`wdac/argus-base.xml`) and signed per tool catalogues, the Security Baseline and CIS GPO backups, the Sysmon configuration, the perimeter and egress firewall files (`firewall/opnsense-rules.yaml`, `firewall/egress-allowlist.yaml`), and the Argus Wazuh rule packs. Do not cite them as controls until the files exist.

## Validation and change control

`firewall/ipsec-rules.yaml` is validated in CI against `platform/gitops/schemas/IpsecRules.schema.json`; the placeholder directories contain nothing to validate.

A change to any file here needs two Tier 1 approvals and is a security relevant reconcile: drift is automatically reverted and paged.

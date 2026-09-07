# ADR-0018: Sysmon + WEF + Wazuh

**Decision.** Sysmon (SwiftOnSecurity/Olaf Hartong baseline) on every Windows host; Windows Event Forwarding to a collector; Wazuh agents everywhere; Wazuh manager + indexer + dashboard on `siem-01`; PowerShell script-block and module logging; Defender AV with ASR rules and Controlled Folder Access; **Microsoft Security Baselines** + CIS via GPO with Wazuh SCA scoring drift.

**Why.** Detection with evidence: file-integrity monitoring, CIS scoring, ransomware behaviour rules, and ISO 27001 / PCI mappings that an auditor accepts.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

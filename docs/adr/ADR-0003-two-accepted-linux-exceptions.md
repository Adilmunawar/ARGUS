# ADR-0003: Two accepted Linux exceptions

**Context.** Two capabilities have no Windows-native implementation worth using: fractional/shared GPU scheduling for ML, and a SIEM manager (Wazuh's manager runs on Linux; only its agents run on Windows).

**Decision.** Exactly two Linux systems, both hardened Ubuntu 24.04 LTS, AD-joined via SSSD, managed through the same GitOps repo: **`gpu-01`** (bare metal, NVIDIA drivers, Ray/MLflow/Dagster) and **`siem-01`** (a Shielded VM on Hyper-V running the Wazuh manager and indexer). OPNsense edge devices are treated as appliances, not servers.

**Why.** Pretending the Wazuh manager can run on Windows would leave the platform without a SIEM. Running the GPU under Hyper-V DDA is possible but loses NVIDIA tooling; bare metal is faster and simpler.

**Consequences.** Two hosts need Linux patching; both are in the platform's Tier 1 and covered by the same Wazuh, backups and IPsec (strongSwan) rules. Any third Linux host requires a new ADR.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

**Amended 8 September 2026 by ADR-0032:** a third exception, `guac-01` (Apache Guacamole gateway), is accepted. A fourth still requires its own ADR.

# ADR-0014, WDAC + Authenticode: only signed code runs

**Decision.** **Windows Defender Application Control** in enforced mode on every server: only code signed by the Argus code-signing certificate (AD CS, key on an HSM or at minimum a TPM-bound cert on the build server) or by Microsoft runs; binaries, DLLs, drivers, PowerShell scripts. CI signs every artefact; `.sfpkg` packages are also signed and verified by the reconciler before deployment. PowerShell Constrained Language Mode everywhere but Tier 0 PAWs.

**Why.** Stronger than container image signing: it covers the whole machine, and it makes most malware, unsigned tooling and living-off-the-land scripts simply fail to execute.

**Consequences.** Every tool the team runs on a server must be signed or catalogued, including third-party binaries (SeaweedFS, NATS, OpenBao, Prometheus), which are catalogued with a Argus-signed catalog file per version. This is real ongoing work and is the reason `platform/policies/wdac/` exists.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)

# Open questions — decisions needed from the owner

Numbered so ADRs and phase gates can reference them. Answered questions move to `01-DECISIONS.md` as ADRs.

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q1 | **Site B location** — second Zaraat Dost office, a partner mill's server room, or a Karachi colocation rack? | Phase 1 week 9 | Colocation rack in Karachi: different city, different grid, professional power/cooling, ~$300–600/month for 10U |
| Q2 | **Generator with ATS at Site A** — exists, or to be procured? | Phase 0 week 1 | Non-negotiable; 20 kVA diesel with ATS ≈ $8–12 k if absent |
| Q3 | **Current AWS monthly spend** — actual figure | ADR-0001 payback maths | — |
| Q4 | **Windows and SQL licences** — anything already held? Any Microsoft partner/NGO programme available? | Phase 0 procurement | Get reseller quotes before hardware; the licence bill may exceed the server bill |
| Q5 | **Platform engineer** — hire, contract, or Adil/Zayan with time carved out? | Phase 0 | Contract a Windows/Hyper-V/AD specialist for Phases 0–2 alongside Adil; hire if Phase 3 proves the platform |
| Q6 | **Mobile-app release** — when can a release ship with the new API/DB endpoint name and certificate pinning? Which release process (Expo EAS, store review times)? | Phase 2 cutover design, Phase 4 | Ship the endpoint change in the *next* release, before Phase 2, so cutover night is simple |
| Q7 | **ADR-0031** — return `umairv3_db` to FULL recovery once 15-minute log backups are proven? (D14 was ruled FULL three times; the server drifted to SIMPLE.) | Phase 4 | Yes |
| Q8 | **Hybrid checkpoint** — is stopping after Phase 3 an acceptable outcome if Phase 4 proves too risky for the surveyor apps? | Phase 4 go/no-go | Yes, explicitly |
| Q9 | **YubiHSM 2 for CA and code-signing keys** ($700) | Phase 0 week 3 | Yes |
| Q10 | **Defender for Endpoint** licences as a commercial EDR on top of Sysmon/Wazuh? | Phase 6 | Optional; revisit after the pen test |
| Q11 | **Retention** — 400 days for logs and 90 days for Site B backups: any regulatory requirement (SBP for the loan product?) that changes these? | Phase 1 | Ask the bank partner |
| Q12 | **Console name and domain** — `console.zaraatdost.pk`? And the public API host for the apps — `api.zaraatdost.pk`? | Phase 2 | As proposed |
| Q13 | **Argus name clearance** (ADR-0034) — trademark search and `.pk` domain availability. An older network-monitoring tool and a commodities-pricing firm both use the name; neither is in this market, but neither has been checked. | Anything public; Phase 2 | Check before the name leaves this repository |
